import { NodeFileSystem } from '@effect/platform-node'
import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Queue,
  Semaphore,
  Schema,
} from 'effect'
import type * as Scope from 'effect/Scope'
import { createHash, randomUUID } from 'node:crypto'
import { execFile, fork, spawn, type ChildProcess } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Writable } from 'node:stream'
import { promisify } from 'node:util'
import {
  WorkDispatchError,
  WorkError,
  WorkRebindRequired,
  WorkPersistenceError,
  WorkProtocolError,
  WorkSetupError,
  asAttemptId,
  asGenerationId,
  asSessionId,
  asTaskId,
  type AgentStartRequest,
  type ArtifactState,
  type AttemptDescription,
  type AttemptId,
  type AttemptRecord,
  type AttemptView,
  type DispatchConfig,
  type DispatchProfile,
  type GenerationId,
  type LogPage,
  type LogRequest,
  type ProcessStartRequest,
  type SessionId,
  type StartRequest,
  type TaskId,
  type WorkAccess,
  type WorkFailure,
  type WorkDeliveryStatus,
  type WorkKind,
  type WorkOwnerService,
  type WorkSnapshot,
} from './work-domain.ts'
import {
  makeAttemptLifecycle,
  ownedProcesses,
  type AttemptLifecycle,
  type LifecycleTransition,
  type ProcessObservation,
} from './work-lifecycle.ts'
import { quotaExhausted, readDispatch, resolveDispatch } from './work-dispatch.ts'
import { compactText, isRecordUnavailable, WorkStore } from './work-store.ts'
import { executeWork, unavailableAttempt, type WorkActions } from './work-actions.ts'
import {
  ChildMessageSchema,
  CoordinatorWorkInputSchema,
  decodeWorkInput,
  isCoordinationMessage,
  parseChildMessage,
  type ControllerWorkMessage,
  type CoordinationMessage,
} from './work-protocol.ts'
import { globalPiAgentDir } from './preferences.ts'
import {
  observeFamily,
  processGate,
  processGateScript,
  processTable,
  rootIdentityReused,
  transientRetry,
} from './process-family.ts'
import {
  WorkspaceError,
  WorkspaceProcessSchema,
  type WorkspaceAttachment,
  type WorkspaceExecution,
  type WorkspaceExecutionFact,
  type WorkspaceGrant,
  type WorkspaceHandoff,
  type WorkspaceLifecycle,
  type WorkspaceOperation,
} from './workspace-domain.ts'
import { errorText } from './error-text.ts'

const execFilePromise = promisify(execFile)

type ProcessEvent =
  | { readonly type: 'message'; readonly raw: unknown }
  | { readonly type: 'exit'; readonly code: number | null; readonly signal: NodeJS.Signals | null }
  | { readonly type: 'error'; readonly message: string }
  | { readonly type: 'close'; readonly code: number | null; readonly signal: NodeJS.Signals | null }

interface Job {
  readonly lifecycle: AttemptLifecycle
  readonly kind: WorkKind
  readonly cwd: string
  readonly task: TaskScope
  readonly scopeKey: string
  readonly access: WorkAccess | undefined
  readonly coordinator: boolean
  readonly prepared: Deferred.Deferred<void>
  readonly settled: Deferred.Deferred<AttemptView>
  readonly events: Queue.Queue<ProcessEvent>
  child?: ChildProcess
  gate?: Writable
  executionReleased: boolean
  readonly workspace: WorkspaceGrant
  observedProcesses?: string
  workspaceLaunch: 'identity-unrecorded' | 'identity-recorded' | 'settled'
  readonly parent?: Job
  readonly inbox?: Queue.Queue<CoordinationRequest>
  pendingRequests: number
  readonly undelivered: Map<AttemptId, AttemptView>
  readonly leaves: Set<Job>
}

type CoordinationRequest = Exclude<CoordinationMessage, { readonly type: 'work-outcomes-ack' }>

interface TaskScope {
  readonly parent: AttemptId | undefined
  readonly taskId: TaskId
}

const admissionOf = (
  request: StartRequest,
  parent: Job | undefined,
  cwd: string | undefined,
  execution: WorkspaceExecution
): WorkspaceOperation => {
  if (request.kind === 'process') return { kind: 'write', cwd }
  if (parent !== undefined && request.access === 'read-only')
    return { kind: 'leaf-read', coordinator: parent.workspace, execution }
  return { kind: request.access === 'read-only' ? 'read' : 'delegated-write', cwd, execution }
}

const workspaceTaskKey = (parent: Job | undefined, taskId: TaskId): string =>
  parent === undefined ? taskId : `${parent.task.taskId}/${taskId}`
const scopeKey = (scope: TaskScope): string => `${scope.parent ?? 'lead'}\n${scope.taskId}`
const scopeOf = (record: AttemptRecord): TaskScope => ({
  parent: record.owner.parent,
  taskId: record.owner.taskId,
})

interface WorkOwnerOptions {
  readonly dataHome: string
  readonly cwd: string
  readonly sessionId: string
  readonly profile: string
  readonly workspace: {
    readonly lifecycle: WorkspaceLifecycle
    readonly attachment: WorkspaceAttachment
    readonly requestRebind: (handoff: WorkspaceHandoff) => void
  }
  readonly onChange?: () => void
  readonly onOutcome?: (attempt: AttemptView) => void
  readonly childEntry?: URL
}

const PI_CHILD_ENTRY = new URL('./pi-child.ts', import.meta.url)

const toFailure = (cause: unknown): WorkFailure => {
  if (
    cause instanceof WorkError ||
    cause instanceof WorkRebindRequired ||
    cause instanceof WorkDispatchError ||
    cause instanceof WorkPersistenceError ||
    cause instanceof WorkProtocolError ||
    cause instanceof WorkSetupError
  )
    return cause
  return new WorkError({ message: errorText(cause), cause })
}

const requiredString = (value: string, name: string): string => {
  if (!value.trim()) throw new Error(`${name} is required`)
  return value
}

const worktreeReminder = (record: AttemptRecord) => {
  if (!record.worktreePath) return undefined
  const blocked =
    record.completedAt === undefined ||
    record.observationError !== undefined ||
    record.cleanupError !== undefined
  return {
    path: record.worktreePath,
    cleanup: blocked ? ('blocked' as const) : ('review-required' as const),
    guidance: blocked
      ? 'Workspace use is unresolved. Preserve the worktree and inspect the durable task.'
      : 'The task reservation and files are retained independently of this attempt. Inspect or explicitly resume the workspace; never force removal.',
  }
}

const viewOf = (record: AttemptRecord): AttemptView => ({
  ...structuredClone(record),
  ...(worktreeReminder(record) === undefined ? {} : { worktree: worktreeReminder(record) }),
})

const changedArtifact = (
  before: ArtifactState | undefined,
  after: ArtifactState | undefined
): boolean | 'unknown' => {
  if (
    !before ||
    !after ||
    before.unavailable ||
    after.unavailable ||
    before.untracked ||
    after.untracked
  ) {
    return 'unknown'
  }
  return before.head !== after.head || before.trackedDigest !== after.trackedDigest
}

const signalProcesses = (
  items: readonly ProcessObservation[],
  signal: NodeJS.Signals
): Effect.Effect<void, WorkError> =>
  Effect.try({
    try: () => {
      for (const item of items.toReversed()) {
        try {
          process.kill(item.pid, signal)
        } catch (cause) {
          if (!(cause instanceof Error) || !('code' in cause) || cause.code !== 'ESRCH') throw cause
        }
      }
    },
    catch: cause => new WorkError({ message: errorText(cause), cause }),
  })

const signalOwnedProcesses = (
  processes: readonly ProcessObservation[],
  signal: NodeJS.Signals
): Effect.Effect<string | void, WorkError> =>
  signalProcesses(processes, signal).pipe(
    Effect.catch(error => Effect.succeed(`Process signal failed: ${errorText(error)}`))
  )

const signalOwnedGroup = (job: Job, signal: NodeJS.Signals): Effect.Effect<void, WorkError> =>
  Effect.try({
    try: () => {
      const root = job.lifecycle.rootProcess()
      if (
        root === undefined ||
        root.birth === undefined ||
        root.group < 1 ||
        hasProcessExitEvidence(job)
      )
        return
      try {
        process.kill(-root.group, signal)
      } catch (cause) {
        if (!(cause instanceof Error) || !('code' in cause) || cause.code !== 'ESRCH') throw cause
      }
    },
    catch: cause => new WorkError({ message: errorText(cause), cause }),
  })

const git = (cwd: string, args: readonly string[]): Effect.Effect<string, WorkError> =>
  Effect.tryPromise({
    try: () =>
      execFilePromise(
        'git',
        [
          '--no-pager',
          '-c',
          'core.fsmonitor=false',
          '-c',
          'core.untrackedCache=false',
          '-c',
          'core.hooksPath=/dev/null',
          '-C',
          cwd,
          ...args,
        ],
        {
          encoding: 'utf8',
          maxBuffer: 8 * 1024 * 1024,
          timeout: 15000,
          env: {
            ...process.env,
            GIT_OPTIONAL_LOCKS: '0',
            GIT_TERMINAL_PROMPT: '0',
            GIT_NO_LAZY_FETCH: '1',
          },
        }
      ).then(({ stdout }) => stdout.trim()),
    catch: cause => new WorkError({ message: errorText(cause), cause }),
  })

const artifactState = (cwd: string): Effect.Effect<ArtifactState, never> =>
  Effect.all(
    {
      head: git(cwd, ['rev-parse', 'HEAD']),
      diff: git(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--']),
      status: git(cwd, ['status', '--porcelain=v1', '--untracked-files=normal']),
    },
    { concurrency: 'unbounded' }
  ).pipe(
    Effect.map(({ head, diff, status }) => ({
      head,
      trackedDigest: createHash('sha256').update(diff).digest('hex'),
      untracked: status.split('\n').some(line => line.startsWith('??')),
    })),
    Effect.orElseSucceed(() => ({ unavailable: true as const }))
  )

const openLog = (path: () => string): Effect.Effect<number, WorkError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      try: () => openSync(path(), 'wx', 0o600),
      catch: cause => new WorkError({ message: errorText(cause), cause }),
    }),
    descriptor => Effect.sync(() => closeSync(descriptor))
  )

const abortChild = (child: ChildProcess | undefined, gate: Writable | undefined): void => {
  try {
    gate?.destroy()
  } catch {}
  if (child === undefined) return
  if (child.pid === undefined) return
  try {
    child.kill('SIGKILL')
  } catch {}
}

const hasProcessExitEvidence = (job: Job): boolean =>
  job.lifecycle.hasExited() ||
  (job.child !== undefined && (job.child.exitCode !== null || job.child.signalCode !== null))

const sendIpc = (child: ChildProcess, message: object): Effect.Effect<void, WorkError> =>
  Effect.callback(resume => {
    if (!child.connected)
      return resume(Effect.fail(new WorkError({ message: 'Child IPC is closed' })))
    child.send(message, cause =>
      resume(cause ? Effect.fail(new WorkError({ message: cause.message, cause })) : Effect.void)
    )
    return Effect.void
  })

const decodeChildMessage = Schema.decodeUnknownOption(ChildMessageSchema)

const refuseStaleRequest = (job: Job, raw: unknown): Effect.Effect<void> => {
  const request = decodeChildMessage(raw)
  const { child } = job
  if (child === undefined || Option.isNone(request) || request.value.type !== 'work-request')
    return Effect.void
  const refusal: ControllerWorkMessage = {
    type: 'work-reply',
    requestId: request.value.requestId,
    ok: false,
    error: 'This attempt is no longer current; the request was not executed',
  }
  return Effect.ignore(sendIpc(child, refusal))
}

export class WorkOwner extends Context.Service<WorkOwner, WorkOwnerService>()(
  'dev/work/WorkOwner'
) {
  static readonly layer = (options: WorkOwnerOptions): Layer.Layer<WorkOwner, WorkSetupError> =>
    Layer.effect(
      WorkOwner,
      Effect.acquireRelease(makeWorkOwner(options), owner =>
        owner.close('session scope closed').pipe(Effect.orDie)
      )
    ).pipe(
      Layer.provide(
        Layer.unwrap(
          Effect.sync(() =>
            WorkStore.layer(
              options.dataHome,
              asSessionId(requiredString(options.sessionId, 'Session identity'))
            )
          )
        ).pipe(
          Layer.catch(cause =>
            Layer.effect(
              WorkStore,
              Effect.fail(new WorkSetupError({ message: errorText(cause), cause }))
            )
          )
        )
      ),
      Layer.provide(NodeFileSystem.layer)
    )
}

const makeWorkOwner = Effect.fnUntraced(function* (options: WorkOwnerOptions) {
  const fs = yield* FileSystem.FileSystem
  const scope = yield* Effect.scope
  const store = yield* WorkStore
  const active = new Map<AttemptId, Job>()
  const latest = new Map<string, AttemptId>()
  const reservations = new Set<string>()
  const quotaReporters = new Set<AttemptId>()
  const state = {
    generation: asGenerationId(randomUUID()),
    closed: false,
    exhausted: false,
  }
  const admissionLock = Semaphore.makeUnsafe(1)
  const ownerSessionId = asSessionId(requiredString(options.sessionId, 'Session identity'))
  const ownerCwd = resolve(options.cwd)
  const dataHome = resolve(options.dataHome)
  const { profile, workspace } = options
  const onChange = options.onChange ?? (() => undefined)
  const onOutcome = options.onOutcome ?? (() => undefined)
  const childEntry = options.childEntry ?? PI_CHILD_ENTRY

  const snapshot: Effect.Effect<WorkSnapshot, WorkFailure> = Effect.gen(function* () {
    const listed = yield* store.list
    const records = listed.records
      .filter(record => record.owner.sessionId === ownerSessionId)
      .map(record => {
        const job = active.get(record.id)
        if (job) return viewOf(job.lifecycle.snapshot())
        if (record.completedAt !== undefined) return viewOf(record)
        return viewOf({
          ...record,
          status: 'unknown',
          processObservation: 'PID unavailable; launch and exit outcome unknown',
          recovery: 'Retained facts only; no restart authorized',
        })
      })
    return { records, unavailable: listed.unavailable, agentsBlocked: state.exhausted }
  }).pipe(Effect.mapError(toFailure))

  const dispatch: Effect.Effect<DispatchConfig, WorkFailure> = readDispatch.pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.mapError(toFailure)
  )

  const startProcess = (request: ProcessStartRequest): Effect.Effect<AttemptView, WorkFailure> => {
    if (!request.command.trim())
      return Effect.fail(new WorkError({ message: 'command is required' }))
    return start({ kind: 'process', ...request }, undefined).pipe(Effect.mapError(toFailure))
  }

  const startAgent = (request: AgentStartRequest): Effect.Effect<AttemptView, WorkFailure> =>
    delegate(request, undefined)

  const delegate = Effect.fnUntraced(function* (
    request: AgentStartRequest,
    parent: Job | undefined
  ): Effect.fn.Return<AttemptView, WorkFailure> {
    if (!request.prompt.trim()) return yield* new WorkError({ message: 'prompt is required' })
    if (parent !== undefined) {
      if (request.coordinate === true || request.cwd !== undefined)
        return yield* new WorkError({
          message: "A leaf runs in its coordinator's workspace and cannot coordinate",
        })
      if (parent.access !== 'write' && request.access === 'write')
        return yield* new WorkError({
          message: 'A read-only coordinator can start only read-only leaves',
        })
    }
    const selection = yield* resolveDispatch(request).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.mapError(toFailure)
    )
    return yield* start({ kind: 'agent', ...request, selection }, parent)
  }, Effect.mapError(toFailure))

  const cancel = Effect.fnUntraced(
    function* (id: AttemptId, reason = 'cancelled'): Effect.fn.Return<AttemptView, WorkFailure> {
      const job = active.get(id)
      if (!job)
        return yield* new WorkError({
          message: 'Attempt is not owned by this live session; inspect retained facts instead',
        })
      yield* Deferred.await(job.prepared)
      if (job.lifecycle.isTerminal()) return yield* Deferred.await(job.settled)
      return yield* cancelJob(job, reason)
    },
    Effect.uninterruptible,
    Effect.mapError(toFailure)
  )

  const inspect = Effect.fnUntraced(function* (
    id: AttemptId
  ): Effect.fn.Return<AttemptDescription, WorkFailure> {
    const record = yield* recordFor(id)
    const current = yield* artifactState(record.cwd)
    const staleArtifact = changedArtifact(record.artifactAtCompletion, current)
    const streams: readonly LogRequest['stream'][] =
      record.kind === 'agent' ? ['result', 'stderr'] : ['stdout', 'stderr']
    const logs = yield* Effect.forEach(streams, stream =>
      store.readLog(id, stream, undefined, 6000).pipe(
        Effect.map(log => ({
          ...log,
          stream,
          text: log.text === undefined ? undefined : compactText(log.text),
        }))
      )
    )
    return {
      ...viewOf(record),
      staleArtifact,
      evidence:
        'Process outcome, not artifact verification. Reconcile changed or unknown artifacts before accepting the result.',
      logs,
    }
  }, Effect.mapError(toFailure))

  const readLog = (request: LogRequest): Effect.Effect<LogPage, WorkFailure> =>
    recordFor(request.id).pipe(
      Effect.flatMap(() =>
        store.readLog(request.id, request.stream, request.offset, request.limit)
      ),
      Effect.mapError(toFailure)
    )

  const deliveryStatus = (
    attempts: readonly AttemptView[]
  ): Effect.Effect<WorkDeliveryStatus, WorkFailure> =>
    Effect.sync(() => ({
      eligible: attempts.filter(attempt => canDeliverUnsafe(attempt)).map(attempt => attempt.id),
      agentsBlocked: state.exhausted,
    }))

  const recordDeliveryFailure = Effect.fnUntraced(function* (
    id: AttemptId,
    message: string
  ): Effect.fn.Return<void, WorkFailure> {
    const job = active.get(id)
    if (job !== undefined) {
      yield* commit(job, () => job.lifecycle.transition.deliveryError(job.lifecycle.token, message))
      onChange()
      return
    }
    const record = yield* recordFor(id)
    if (record.revision >= Number.MAX_SAFE_INTEGER)
      return yield* new WorkError({ message: 'Attempt revision exhausted' })
    yield* store.save({
      ...record,
      deliveryError: message,
      revision: record.revision + 1,
    })
    onChange()
  }, Effect.mapError(toFailure))

  const interrupt = Effect.fnUntraced(function* (
    reason = 'interrupted'
  ): Effect.fn.Return<void, WorkFailure> {
    const previous = yield* admissionLock.withPermit(
      Effect.sync(() => {
        state.generation = asGenerationId(randomUUID())
        return [...active.keys()]
      })
    )
    yield* cancelMany(previous, reason)
  }, Effect.mapError(toFailure))

  const exhaust: WorkOwnerService['exhaust'] = Effect.fnUntraced(function* (
    except?: AttemptId
  ): Effect.fn.Return<void, WorkFailure> {
    yield* admissionLock.withPermit(
      Effect.sync(() => {
        state.exhausted = true
        if (except !== undefined) quotaReporters.add(except)
      })
    )
    yield* cancelMany(
      [...active.values()]
        .filter(job => job.kind === 'agent' && job.lifecycle.token.attemptId !== except)
        .map(job => job.lifecycle.token.attemptId),
      'subscription exhausted'
    )
  }, Effect.mapError(toFailure))

  const close = Effect.fnUntraced(function* (
    reason = 'session ended'
  ): Effect.fn.Return<void, WorkFailure> {
    yield* admissionLock.withPermit(
      Effect.sync(() => {
        state.closed = true
        state.generation = asGenerationId(randomUUID())
      })
    )
    yield* cancelMany([...active.keys()], reason)
  }, Effect.mapError(toFailure))

  const cancelMany = Effect.fnUntraced(function* (
    ids: readonly AttemptId[],
    reason: string
  ): Effect.fn.Return<void, WorkFailure> {
    const outcomes = yield* Effect.forEach(ids, id => Effect.result(cancel(id, reason)), {
      concurrency: 'unbounded',
    })
    const failure = outcomes.find(outcome => outcome._tag === 'Failure')
    if (failure?._tag === 'Failure') return yield* failure.failure
  })

  const start = Effect.fnUntraced(
    function* (
      request: StartRequest & { readonly selection?: DispatchProfile },
      parent: Job | undefined
    ): Effect.fn.Return<AttemptView, WorkFailure> {
      const reservation = yield* reserve(request.taskId, request.kind, parent)
      let grant: WorkspaceGrant | undefined
      let installed = false
      const result = yield* Effect.gen(function* () {
        const requestedCwd = parent === undefined ? yield* resolveCwd(request.cwd) : undefined
        const id = asAttemptId(randomUUID())
        const execution = {
          sessionId: reservation.sessionId,
          taskKey: workspaceTaskKey(parent, reservation.task.taskId),
          attemptId: id,
          generation: reservation.generation,
          logs: store.plannedLogPath(id, 'stdout'),
        }
        const admission = yield* Effect.gen(function* () {
          const allocated = yield* workspace.attachment.authorize(
            admissionOf(request, parent, requestedCwd, execution)
          )
          if (allocated.kind !== 'ready' || request.kind !== 'process') return allocated
          return yield* workspace.attachment.authorize({
            kind: 'opaque',
            within: allocated.grant,
            execution,
          })
        }).pipe(Effect.mapError(toFailure))
        if (admission.kind === 'rebind') {
          workspace.requestRebind(admission.handoff)
          return yield* new WorkRebindRequired({
            message: `Workspace handoff required before starting work: ${admission.handoff.reason}. No command was executed; obtain a fresh host tool decision.`,
          })
        }
        const { grant: selected } = admission
        grant = selected
        const { cwd } = selected
        const artifactAtStart = yield* artifactState(cwd)
        yield* assertPrepared(
          reservation.sessionId,
          reservation.generation,
          reservation.task,
          request.kind
        )
        const record = yield* store.create(id, {
          kind: request.kind,
          cwd,
          controllerPid: process.pid,
          workflowTaskId: grant.taskId,
          workspaceId: grant.workspaceId,
          workspaceUseId: grant.useId,
          workspaceAcquisitionId: grant.acquisitionId,
          ...(grant.origin === 'managed' ? { worktreePath: grant.checkout } : {}),
          owner: {
            sessionId: reservation.sessionId,
            taskId: reservation.task.taskId,
            generation: reservation.generation,
            ...(parent === undefined ? {} : { parent: parent.lifecycle.token.attemptId }),
          },
          ...(request.kind === 'agent'
            ? {
                access: request.access,
                selection: request.selection,
                ...(request.coordinate === true ? { coordinator: true } : {}),
              }
            : {}),
          artifactAtStart,
        })
        yield* assertPrepared(
          reservation.sessionId,
          reservation.generation,
          reservation.task,
          request.kind
        )
        const settled = yield* Deferred.make<AttemptView>()
        const prepared = yield* Deferred.make<void>()
        const events = yield* Queue.unbounded<ProcessEvent>()
        const inbox =
          record.coordinator === true ? yield* Queue.unbounded<CoordinationRequest>() : undefined
        const job: Job = {
          lifecycle: makeAttemptLifecycle(record),
          kind: request.kind,
          cwd,
          task: reservation.task,
          scopeKey: scopeKey(reservation.task),
          access: record.access,
          coordinator: record.coordinator === true,
          prepared,
          settled,
          events,
          executionReleased: false,
          workspace: grant,
          workspaceLaunch: 'identity-unrecorded',
          ...(parent === undefined ? {} : { parent }),
          ...(inbox === undefined ? {} : { inbox }),
          pendingRequests: 0,
          undelivered: new Map(),
          leaves: new Set(),
        }
        yield* admissionLock.withPermit(
          Effect.try({
            try: () => {
              assertPreparedUnsafe(
                reservation.sessionId,
                reservation.generation,
                reservation.task,
                request.kind
              )
              active.set(record.id, job)
              parent?.leaves.add(job)
              installed = true
              latest.set(scopeKey(reservation.task), record.id)
            },
            catch: cause => new WorkError({ message: errorText(cause), cause }),
          })
        )
        yield* launch(job, request, cwd, reservation.generation).pipe(
          Effect.ensuring(Deferred.succeed(prepared, undefined))
        )
        return viewOf(job.lifecycle.snapshot())
      }).pipe(
        Effect.tapError(() => {
          const selected = grant
          return !installed && selected !== undefined
            ? workspace.attachment
                .reportExecution(selected, {
                  kind: 'launch-failed',
                  reason: 'Admission ended before any process was spawned',
                })
                .pipe(Effect.mapError(toFailure))
            : Effect.void
        }),
        Effect.ensuring(Effect.sync(() => reservations.delete(scopeKey(reservation.task))))
      )
      return result
    },
    Effect.uninterruptible,
    Effect.mapError(toFailure)
  )

  const reserve = (
    taskId: string,
    kind: WorkKind,
    parent: Job | undefined
  ): Effect.Effect<
    { readonly generation: GenerationId; readonly sessionId: SessionId; readonly task: TaskScope },
    WorkFailure
  > =>
    admissionLock.withPermit(
      Effect.try({
        try: () => {
          if (process.platform === 'win32')
            throw new Error(
              'Background work currently requires POSIX process observation and signals'
            )
          if (state.closed) throw new Error('This work owner has shut down')
          if (kind === 'agent' && state.exhausted)
            throw new Error('Subscription exhausted; no new agents may start in this session')
          const task: TaskScope = {
            parent: parent?.lifecycle.token.attemptId,
            taskId: asTaskId(requiredString(taskId, 'taskId')),
          }
          if (parent !== undefined) assertCoordinatingUnsafe(parent)
          if (reservations.has(scopeKey(task)) || hasActiveTaskUnsafe(task))
            throw new Error('This task already has an active attempt')
          reservations.add(scopeKey(task))
          return { generation: state.generation, sessionId: ownerSessionId, task }
        },
        catch: cause => new WorkError({ message: errorText(cause), cause }),
      })
    )

  const assertPrepared = (
    sessionId: SessionId,
    generation: GenerationId,
    task: TaskScope,
    kind: WorkKind,
    except?: AttemptId
  ): Effect.Effect<void, WorkFailure> =>
    admissionLock.withPermit(
      Effect.try({
        try: () => assertPreparedUnsafe(sessionId, generation, task, kind, except),
        catch: cause => new WorkError({ message: errorText(cause), cause }),
      })
    )

  const hasActiveTaskUnsafe = (task: TaskScope, except?: AttemptId): boolean => {
    const key = scopeKey(task)
    for (const job of active.values())
      if (job.lifecycle.token.attemptId !== except && job.scopeKey === key) return true
    return false
  }

  const isCoordinatingUnsafe = (job: Job): boolean => {
    const { token } = job.lifecycle
    return (
      job.coordinator &&
      !state.closed &&
      active.get(token.attemptId) === job &&
      job.lifecycle.isActive() &&
      !job.lifecycle.hasExited() &&
      !job.lifecycle.hasResult() &&
      !job.lifecycle.cancelRequested() &&
      token.generation === state.generation
    )
  }

  const assertCoordinatingUnsafe = (job: Job): void => {
    if (!isCoordinatingUnsafe(job))
      throw new Error('This attempt is not a running coordinator authorized by the lead')
  }

  const routeLeaf = (job: Job): void => {
    const { parent } = job
    if (parent === undefined || !parent.leaves.delete(job)) return
    if (!isCoordinatingUnsafe(parent)) return
    const view = viewOf(job.lifecycle.snapshot())
    parent.undelivered.set(view.id, view)
    const wake: ControllerWorkMessage = { type: 'work-wake' }
    try {
      if (parent.child?.connected) parent.child.send(wake, () => undefined)
    } catch {}
  }

  const cancelLeaves = (job: Job, reason: string): Effect.Effect<void, never> =>
    Effect.suspend(() =>
      cancelMany(
        [...job.leaves]
          .map(leaf => leaf.lifecycle.token.attemptId)
          .filter(id => !quotaReporters.has(id)),
        reason
      )
    ).pipe(Effect.ignore)

  const scoped = (job: Job): WorkActions => {
    const coordinator = job.lifecycle.token.attemptId
    const refused = new WorkError({ message: 'Attempt is not a leaf of this coordinator' })
    const owned = <A>(id: AttemptId, use: Effect.Effect<A, WorkFailure>, refusal = refused) =>
      recordFor(id).pipe(
        Effect.mapError(() => refusal),
        Effect.flatMap(record => (record.owner.parent === coordinator ? use : Effect.fail(refusal)))
      )
    return {
      snapshot: snapshot.pipe(
        Effect.map(current => ({
          ...current,
          unavailable: [],
          records: current.records.filter(record => record.owner.parent === coordinator),
        }))
      ),
      dispatch,
      startAgent: request => delegate(request, job),
      cancel: id => owned(id, cancel(id, 'cancelled by its coordinator')),
      inspect: id => owned(id, inspect(id), unavailableAttempt()),
      readLog: request => owned(request.id, readLog(request), unavailableAttempt()),
      interrupt: reason => cancelLeaves(job, reason ?? 'cancelled by its coordinator'),
    }
  }

  const serveCoordinator = (
    job: Job,
    inbox: Queue.Queue<CoordinationRequest>
  ): Effect.Effect<void> =>
    Queue.take(inbox).pipe(
      Effect.flatMap(message =>
        coordinatorRequest(job, message).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              job.pendingRequests -= 1
            })
          )
        )
      ),
      Effect.forever,
      Effect.ignore
    )

  const coordinatorRequest = Effect.fnUntraced(function* (
    job: Job,
    message: CoordinationRequest
  ): Effect.fn.Return<void> {
    const { child } = job
    if (child === undefined) return
    const { requestId } = message
    const reply = (answer: ControllerWorkMessage): Effect.Effect<void> =>
      Effect.ignore(sendIpc(child, answer))
    if (message.type === 'work-idle') {
      const live = job.leaves.size
      const outcomes = yield* Effect.forEach(
        [...job.undelivered.values()],
        view => inspect(view.id).pipe(Effect.orElseSucceed(() => view)),
        { concurrency: 'unbounded' }
      )
      return yield* reply({ type: 'work-pending', requestId, live, outcomes })
    }
    const result = yield* Effect.result(
      Effect.gen(function* () {
        yield* Effect.try({ try: () => assertCoordinatingUnsafe(job), catch: toFailure })
        const input = yield* decodeWorkInput(CoordinatorWorkInputSchema)(message.input)
        return yield* executeWork(scoped(job), input)
      })
    )
    yield* reply(
      result._tag === 'Success'
        ? { type: 'work-reply', requestId, ok: true, result: result.success ?? {} }
        : { type: 'work-reply', requestId, ok: false, error: errorText(result.failure) }
    )
  })

  const assertPreparedUnsafe = (
    sessionId: SessionId,
    generation: GenerationId,
    task: TaskScope,
    kind: WorkKind,
    except?: AttemptId
  ): void => {
    if (
      sessionId !== ownerSessionId ||
      generation !== state.generation ||
      state.closed ||
      (kind === 'agent' && state.exhausted)
    ) {
      throw new Error('Work owner invalidated before launch')
    }
    if (hasActiveTaskUnsafe(task, except))
      throw new Error('This task already has an active attempt')
    if (task.parent !== undefined) {
      const parent = active.get(task.parent)
      if (parent === undefined) throw new Error('The coordinator of this leaf is gone')
      assertCoordinatingUnsafe(parent)
    }
  }

  const withPreparedPermit = <A, R = never>(
    sessionId: SessionId,
    generation: GenerationId,
    task: TaskScope,
    kind: WorkKind,
    except: AttemptId,
    effect: Effect.Effect<A, WorkFailure, R>
  ): Effect.Effect<A, WorkFailure, R> =>
    admissionLock.withPermit(
      Effect.gen(function* () {
        yield* Effect.try({
          try: () => assertPreparedUnsafe(sessionId, generation, task, kind, except),
          catch: cause => new WorkError({ message: errorText(cause), cause }),
        })
        return yield* effect
      })
    )

  const commitUnlocked = Effect.fnUntraced(function* (
    job: Job,
    transition: () => LifecycleTransition
  ): Effect.fn.Return<LifecycleTransition, WorkFailure> {
    const outcome = yield* Effect.try({
      try: transition,
      catch: cause => new WorkError({ message: errorText(cause), cause }),
    })
    if (outcome.changed) {
      yield* store.save(outcome.snapshot)
      if (outcome.resultText !== undefined)
        yield* store.saveResult(outcome.snapshot.id, outcome.resultText)
    }
    return outcome
  })

  const commit = (
    job: Job,
    transition: () => LifecycleTransition
  ): Effect.Effect<LifecycleTransition, WorkFailure> =>
    admissionLock.withPermit(commitUnlocked(job, transition))

  const commitCurrent = Effect.fnUntraced(
    function* (
      job: Job,
      token: AttemptLifecycle['token'],
      transition: () => LifecycleTransition
    ): Effect.fn.Return<LifecycleTransition | undefined, WorkFailure> {
      if (
        state.closed ||
        state.generation !== token.generation ||
        !job.lifecycle.isActive() ||
        job.lifecycle.hasResult()
      )
        return undefined
      return yield* commitUnlocked(job, transition)
    },
    effect => admissionLock.withPermit(effect)
  )

  const notePersistenceFailure = (job: Job, cause: unknown): Effect.Effect<void, never> =>
    admissionLock.withPermit(
      Effect.sync(() => {
        job.lifecycle.transition.persistenceError(job.lifecycle.token, errorText(cause))
      })
    )

  const commitBestEffort = Effect.fnUntraced(function* (
    job: Job,
    transition: () => LifecycleTransition
  ): Effect.fn.Return<LifecycleTransition, WorkFailure> {
    const result = yield* Effect.result(commit(job, transition))
    if (result._tag === 'Success') return result.success
    if (!(result.failure instanceof WorkPersistenceError)) return yield* result.failure
    yield* notePersistenceFailure(job, result.failure)
    return {
      accepted: true,
      changed: true,
      snapshot: job.lifecycle.snapshot(),
      state: job.lifecycle.state(),
    }
  })

  const settle = (job: Job): Effect.Effect<void, never> =>
    Effect.suspend(() => {
      routeLeaf(job)
      return Deferred.succeed(job.settled, viewOf(job.lifecycle.snapshot()))
    }).pipe(
      Effect.andThen(job.inbox === undefined ? Effect.void : Queue.shutdown(job.inbox)),
      Effect.ignore
    )

  const commitCurrentBestEffort = Effect.fnUntraced(function* (
    job: Job,
    token: AttemptLifecycle['token'],
    transition: () => LifecycleTransition
  ): Effect.fn.Return<LifecycleTransition | undefined, WorkFailure> {
    const result = yield* Effect.result(commitCurrent(job, token, transition))
    if (result._tag === 'Success') return result.success
    if (!(result.failure instanceof WorkPersistenceError)) return yield* result.failure
    yield* notePersistenceFailure(job, result.failure)
    return {
      accepted: true,
      changed: true,
      snapshot: job.lifecycle.snapshot(),
      state: job.lifecycle.state(),
    }
  })

  const resolveCwd = (cwd: string | undefined): Effect.Effect<string, WorkFailure> =>
    fs
      .realPath(resolve(ownerCwd, cwd ?? ownerCwd))
      .pipe(Effect.mapError(cause => new WorkError({ message: errorText(cause), cause })))

  const launch = Effect.fnUntraced(
    function* (
      job: Job,
      request: StartRequest & { readonly selection?: DispatchProfile },
      cwd: string,
      generation: GenerationId
    ): Effect.fn.Return<void, WorkFailure, Scope.Scope> {
      const { token } = job.lifecycle
      const record = job.lifecycle.snapshot()
      yield* reportWorkspace(job, {
        kind: 'launch-intent',
        execution: {
          sessionId: record.owner.sessionId,
          taskKey: workspaceTaskKey(job.parent, record.owner.taskId),
          attemptId: record.id,
          generation: record.owner.generation,
          logs: store.logPath(record.id, 'stdout'),
        },
      })
      const [stdout, stderr] = yield* withPreparedPermit(
        token.sessionId,
        generation,
        scopeOf(record),
        request.kind,
        record.id,
        Effect.all([
          openLog(() => store.logPath(record.id, 'stdout')),
          openLog(() => store.logPath(record.id, 'stderr')),
        ])
      )
      const child = yield* withPreparedPermit(
        token.sessionId,
        generation,
        scopeOf(record),
        request.kind,
        record.id,
        Effect.try({
          try: () => {
            const spawnOptions = {
              cwd,
              detached: true,
              env: {
                ...process.env,
                DEV_DATA_HOME: dataHome,
                PI_CODING_AGENT_DIR: globalPiAgentDir(),
              },
            }
            const spawned =
              request.kind === 'agent'
                ? fork(childEntry, [], {
                    ...spawnOptions,
                    execArgv: [],
                    stdio: ['ignore', stdout, stderr, 'ipc'],
                  })
                : spawn(
                    '/bin/bash',
                    ['-c', processGateScript, 'dev-work-process', request.command],
                    {
                      ...spawnOptions,
                      stdio: ['ignore', stdout, stderr, 'pipe'],
                    }
                  )
            job.child = spawned
            if (request.kind === 'process') job.gate = processGate(spawned)
            spawned.once('exit', (code, signal) => {
              Queue.offerUnsafe(job.events, { type: 'exit', code, signal })
            })
            spawned.once('error', cause => {
              Queue.offerUnsafe(job.events, { type: 'error', message: cause.message })
            })
            spawned.once('close', (code, signal) => {
              Queue.offerUnsafe(job.events, { type: 'close', code, signal })
            })
            if (request.kind === 'agent') {
              spawned.on('message', raw => {
                Queue.offerUnsafe(job.events, { type: 'message', raw })
              })
            }
            return spawned
          },
          catch: cause => new WorkError({ message: errorText(cause), cause }),
        })
      )
      const { pid: childPid } = child
      if (childPid === undefined) {
        const event = yield* Queue.take(job.events)
        let message: string
        if (event.type === 'error') {
          const { message: reported } = event
          message = reported
        } else if (event.type === 'close')
          message = `Child closed before PID was available: ${event.code ?? 'unknown'}`
        else message = 'Child exited before PID was available'
        return yield* new WorkError({ message })
      }
      yield* commit(job, () => job.lifecycle.transition.spawn(token, childPid))
      yield* admissionLock.withPermit(
        Effect.gen(function* () {
          yield* Effect.try({
            try: () =>
              assertPreparedUnsafe(
                token.sessionId,
                generation,
                scopeOf(record),
                request.kind,
                record.id
              ),
            catch: cause => new WorkError({ message: errorText(cause), cause }),
          })
          const initialTable = yield* processTable.pipe(Effect.mapError(toFailure))
          const root = initialTable.find(item => item.pid === childPid)
          const known = ownedProcesses(initialTable, childPid, [])
          if (
            root === undefined ||
            root.birth === undefined ||
            !known.some(item => item.pid === root.pid && item.birth === root.birth)
          )
            return yield* new WorkError({
              message: 'Child root identity could not be captured before execution release',
            })
          yield* commitUnlocked(job, () => job.lifecycle.transition.processes(token, known))
          const processIdentity = yield* Schema.decodeEffect(WorkspaceProcessSchema)(root).pipe(
            Effect.mapError(toFailure)
          )
          yield* reportWorkspace(job, { kind: 'spawned', process: processIdentity })
          job.workspaceLaunch = 'identity-recorded'
          yield* reportWorkspace(job, { kind: 'started' })
          if (job.gate !== undefined) {
            const { gate } = job
            job.executionReleased = true
            yield* Effect.try({
              try: () => gate.end('\n'),
              catch: cause => new WorkError({ message: errorText(cause), cause }),
            })
            job.gate = undefined
          }
        })
      )
      if (request.kind === 'agent')
        yield* withPreparedPermit(
          token.sessionId,
          generation,
          scopeOf(record),
          request.kind,
          record.id,
          Effect.gen(function* () {
            job.executionReleased = true
            yield* sendIpc(child, {
              type: 'start',
              request: {
                dataHome,
                cwd,
                profile,
                sessionDir: join(dataHome, 'child-sessions'),
                access: request.access,
                prompt: request.prompt,
                ...(record.coordinator === true ? { coordinate: true } : {}),
                owner: record.owner,
                workspace: job.workspace,
                authorityRoot: workspace.lifecycle.root,
                model: request.selection?.model,
                effort: request.selection?.effort,
              },
            })
          })
        )
      yield* withPreparedPermit(
        token.sessionId,
        generation,
        scopeOf(record),
        request.kind,
        record.id,
        Effect.gen(function* () {
          yield* store.save(job.lifecycle.snapshot())
          yield* Effect.forkIn(scope)(waitForOwnedExit(job))
          if (job.inbox !== undefined) yield* Effect.forkIn(scope)(serveCoordinator(job, job.inbox))
        })
      )
      onChange()
    },
    (effect, job) => Effect.catch(effect, error => failLaunch(job, error)),
    Effect.scoped
  )

  const failLaunch = Effect.fnUntraced(function* (
    job: Job,
    cause: unknown
  ): Effect.fn.Return<never, WorkFailure> {
    const { token } = job.lifecycle
    if (!job.executionReleased) {
      const { gate } = job
      job.gate = undefined
      yield* Effect.sync(() => abortChild(job.child, gate))
      yield* Effect.ignore(
        settleUnrecordedLaunch(
          job,
          `The launch failed before user code was released: ${errorText(cause)}`
        )
      )
    }

    yield* commitBestEffort(job, () =>
      job.lifecycle.transition.processError(token, errorText(cause))
    )
    if (job.lifecycle.isActive()) {
      if (job.child === undefined || job.child.pid === undefined) {
        yield* commitBestEffort(job, () => job.lifecycle.transition.exit(token, null, null))
        yield* finish(job).pipe(Effect.catch(error => failObservation(job, error)))
      } else {
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.forkScoped(waitForOwnedExit(job))
            yield* cancelJob(job, 'launch failed')
          })
        ).pipe(Effect.catch(error => failObservation(job, error)))
      }
    }
    return yield* new WorkError({ message: errorText(cause), cause })
  })

  const childMessage = Effect.fnUntraced(
    function* (job: Job, raw: unknown): Effect.fn.Return<void, WorkFailure> {
      const { token } = job.lifecycle
      if (
        !job.lifecycle.isActive() ||
        job.lifecycle.hasResult() ||
        token.generation !== state.generation
      )
        return yield* refuseStaleRequest(job, raw)
      const message = yield* parseChildMessage(raw, {
        cwd: job.cwd,
        sessionDir: join(dataHome, 'child-sessions'),
      }).pipe(Effect.mapError(toFailure))
      if (message.type === 'workspace-check') {
        const { child } = job
        if (child === undefined)
          return yield* new WorkError({ message: 'Child workspace owner is unavailable' })
        const checked = yield* Effect.result(
          Effect.gen(function* () {
            if (
              message.useId !== job.workspace.useId ||
              (message.operation !== 'read' && job.workspace.access !== 'write')
            )
              return yield* new WorkError({
                message: 'Child workspace grant does not match the requested operation',
              })
            yield* workspace.lifecycle.validate(job.workspace).pipe(Effect.mapError(toFailure))
            yield* Effect.try({
              try: () =>
                assertPreparedUnsafe(
                  token.sessionId,
                  token.generation,
                  job.task,
                  job.kind,
                  token.attemptId
                ),
              catch: toFailure,
            })
          })
        )
        yield* sendIpc(child, {
          type: 'workspace-checked',
          requestId: message.requestId,
          useId: job.workspace.useId,
          allowed: checked._tag === 'Success',
          ...(checked._tag === 'Failure' ? { reason: errorText(checked.failure) } : {}),
        })
        return
      }
      if (isCoordinationMessage(message)) {
        if (message.type === 'work-outcomes-ack')
          for (const id of message.attempts) job.undelivered.delete(id)
        else if (job.inbox === undefined) yield* coordinatorRequest(job, message)
        else {
          job.pendingRequests += 1
          Queue.offerUnsafe(job.inbox, message)
        }
        return
      }
      if (message.type === 'ready' || message.type === 'progress') {
        const outcome = yield* commitCurrentBestEffort(job, token, () =>
          job.lifecycle.transition.progress(token, {
            ...(message.model === undefined ? {} : { model: message.model }),
            ...(message.effort === undefined ? {} : { effort: message.effort }),
            ...(message.sessionFile === undefined ? {} : { sessionFile: message.sessionFile }),
            ...(message.resources === undefined ? {} : { resources: message.resources }),
            ...(message.context === undefined ? {} : { context: message.context }),
            ...(message.usage === undefined ? {} : { usage: message.usage }),
          })
        )
        if (outcome !== undefined) onChange()
      } else {
        const unresolved = job.pendingRequests + job.leaves.size + job.undelivered.size
        if (message.error === undefined && unresolved > 0)
          return yield* new WorkProtocolError({
            message: `A coordinator reported its result while ${unresolved} request(s) or leaf outcome(s) were unresolved`,
          })
        const outcome = yield* commitCurrentBestEffort(job, token, () =>
          job.lifecycle.transition.result(token, {
            ...(message.model === undefined ? {} : { model: message.model }),
            ...(message.effort === undefined ? {} : { effort: message.effort }),
            ...(message.sessionFile === undefined ? {} : { sessionFile: message.sessionFile }),
            ...(message.resources === undefined ? {} : { resources: message.resources }),
            ...(message.context === undefined ? {} : { context: message.context }),
            ...(message.usage === undefined ? {} : { usage: message.usage }),
            text: message.text,
            ...(message.error === undefined ? {} : { error: message.error }),
            ...(message.quotaExhausted === undefined
              ? {}
              : { quotaExhausted: message.quotaExhausted }),
          })
        )
        if (outcome === undefined) return
        if (message.error !== undefined)
          yield* Effect.forkIn(scope)(cancelLeaves(job, 'coordinator reported a failure'))
        if (outcome.accepted && (outcome.quotaExhausted || quotaExhausted(message.error)))
          yield* exhaust(token.attemptId)
        onChange()
      }
    },
    (effect, job) =>
      Effect.catch(effect, error =>
        Effect.gen(function* () {
          const { token } = job.lifecycle
          const message = errorText(error)
          const outcome = yield* commitCurrentBestEffort(job, token, () =>
            error instanceof WorkProtocolError
              ? job.lifecycle.transition.rejectedMessage(token, message)
              : job.lifecycle.transition.persistenceError(token, message)
          )
          if (outcome !== undefined)
            yield* Effect.forkIn(scope)(Effect.ignore(cancelJob(job, 'invalid child message')))
        })
      )
  )

  const waitForOwnedExit = (job: Job): Effect.Effect<void, WorkFailure> => {
    const { token } = job.lifecycle
    return Effect.whileLoop({
      while: () => job.lifecycle.isActive(),
      body: () =>
        Effect.gen(function* () {
          if (!job.lifecycle.hasExited()) {
            const event = yield* Queue.take(job.events)
            if (event.type === 'message') yield* childMessage(job, event.raw)
            else if (event.type === 'error')
              yield* commitBestEffort(job, () =>
                job.lifecycle.transition.processError(token, event.message)
              )
            else if (event.type === 'exit')
              yield* commitBestEffort(job, () =>
                job.lifecycle.transition.exit(token, event.code, event.signal)
              )
            else if (event.type === 'close' || job.lifecycle.pid() === undefined)
              yield* commitBestEffort(job, () => job.lifecycle.transition.exit(token, null, null))
            if (job.lifecycle.hasExited())
              yield* Effect.forkIn(scope)(cancelLeaves(job, 'coordinator exited'))
            return
          }
          const pending = yield* Queue.poll(job.events)
          if (pending._tag === 'Some') {
            const event = pending.value
            if (event.type === 'message') yield* childMessage(job, event.raw)
            else if (event.type === 'error')
              yield* commitBestEffort(job, () =>
                job.lifecycle.transition.processError(token, event.message)
              )
            return
          }
          yield* settleUnrecordedLaunch(
            job,
            'The launch failed before user code was released'
          ).pipe(Effect.retry(transientRetry))
          const family = yield* observeFamily(
            {
              pid: job.lifecycle.pid(),
              root: job.lifecycle.rootProcess(),
              known: job.lifecycle.knownProcesses(),
              reported: job.observedProcesses,
            },
            {
              rootExited: hasProcessExitEvidence(job),
              report: processes => reportWorkspace(job, { kind: 'observed', processes }),
            }
          )
          job.observedProcesses = family.reported
          const { known } = family
          const observed = yield* commitBestEffort(job, () =>
            job.lifecycle.transition.processes(token, known)
          )
          if (known.length === 0) {
            yield* finish(job)
            return
          }
          const waiting = yield* commitBestEffort(job, () =>
            job.lifecycle.transition.waiting(token)
          )
          if (observed.changed || waiting.changed) onChange()
          yield* Effect.sleep(Duration.millis(500))
        }),
      step: () => undefined,
    }).pipe(
      Effect.asVoid,
      Effect.catch(error => failObservation(job, error))
    )
  }

  const settleUnrecordedLaunch = (job: Job, reason: string): Effect.Effect<void, WorkFailure> => {
    if (job.workspaceLaunch !== 'identity-unrecorded') return Effect.void
    return reportWorkspace(job, { kind: 'launch-failed', reason }).pipe(
      Effect.map(() => {
        job.workspaceLaunch = 'settled'
      }),
      Effect.catchIf(
        failure =>
          failure.cause instanceof WorkspaceError && failure.cause.outcome === 'review-required',
        () =>
          Effect.sync(() => {
            job.workspaceLaunch = 'identity-recorded'
          })
      )
    )
  }

  const failObservation = Effect.fnUntraced(function* (
    job: Job,
    cause: unknown
  ): Effect.fn.Return<void, never> {
    const { token } = job.lifecycle
    yield* reportWorkspace(job, { kind: 'unknown', reason: errorText(cause) }).pipe(
      Effect.catch(error =>
        Effect.sync(() => {
          process.stderr.write(`Workspace uncertainty could not be recorded: ${errorText(error)}\n`)
        })
      )
    )
    if (job.lifecycle.isTerminal()) {
      if (cause instanceof WorkPersistenceError) yield* notePersistenceFailure(job, cause)
      yield* Queue.shutdown(job.events).pipe(Effect.ignore)
      yield* settle(job)
      onChange()
      return
    }
    if (job.lifecycle.isUnknown()) {
      yield* settle(job)
      return
    }
    const outcome = yield* Effect.result(
      commit(job, () =>
        job.lifecycle.transition.unknown(
          token,
          `Process observation unavailable: ${errorText(cause)}`
        )
      )
    )
    if (outcome._tag === 'Failure') yield* notePersistenceFailure(job, outcome.failure)
    yield* settle(job)
    onChange()
  })

  const finish = Effect.fnUntraced(function* (job: Job): Effect.fn.Return<void, WorkFailure> {
    const { token } = job.lifecycle
    if (!job.lifecycle.isActive()) return
    const record = job.lifecycle.snapshot()
    let cleanupError: string | undefined
    const observation = yield* Effect.result(
      reportWorkspace(
        job,
        job.workspaceLaunch === 'identity-recorded'
          ? {
              kind: 'quiescent',
              reason: 'The owned process group and every tracked descendant were observed gone',
            }
          : { kind: 'launch-failed', reason: 'No process identity was recorded before failure' }
      ).pipe(Effect.retry(transientRetry))
    )
    if (observation._tag === 'Failure') cleanupError = errorText(observation.failure)

    const completedAt = yield* Clock.currentTimeMillis
    const artifactAtCompletion = yield* artifactState(record.cwd)
    const changedDuringRun = changedArtifact(record.artifactAtStart, artifactAtCompletion)
    const saved = yield* Effect.result(
      commit(job, () =>
        job.lifecycle.transition.complete(token, {
          artifactAtCompletion,
          changedDuringRun,
          completedAt,
          ...(cleanupError === undefined ? {} : { cleanupError }),
        })
      )
    )
    if (saved._tag === 'Failure') {
      yield* failObservation(job, saved.failure)
      return
    }
    if (!saved.success.accepted || !saved.success.changed) {
      yield* settle(job)
      return
    }
    yield* Queue.shutdown(job.events).pipe(Effect.ignore)
    routeLeaf(job)
    active.delete(saved.success.snapshot.id)
    const completed = viewOf(job.lifecycle.snapshot())
    yield* settle(job)
    onChange()
    if (job.parent === undefined && canDeliverUnsafe(completed)) onOutcome(completed)
  })

  const canDeliverUnsafe = (attempt: AttemptView): boolean =>
    !state.closed &&
    attempt.owner.sessionId === ownerSessionId &&
    attempt.completedAt !== undefined &&
    attempt.owner.generation === state.generation &&
    latest.get(scopeKey(scopeOf(attempt))) === attempt.id

  const cancelJob = (job: Job, reason: string): Effect.Effect<AttemptView, WorkFailure> =>
    Effect.all([terminate(job, reason), cancelLeaves(job, `coordinator stopped: ${reason}`)], {
      concurrency: 'unbounded',
    }).pipe(Effect.map(([view]) => view))

  const terminate = Effect.fnUntraced(function* (
    job: Job,
    reason: string
  ): Effect.fn.Return<AttemptView, WorkFailure> {
    const { token } = job.lifecycle
    const requestedAt = yield* Clock.currentTimeMillis
    const requested = yield* commitBestEffort(job, () =>
      job.lifecycle.transition.cancel(token, requestedAt, reason)
    )
    if (!requested.accepted || !job.lifecycle.isActive()) return yield* Deferred.await(job.settled)
    if (job.child === undefined) {
      yield* failObservation(job, new Error('Cancellation raced with launch setup'))
      return yield* Deferred.await(job.settled)
    }
    if (job.child.connected) {
      const ipc = yield* Effect.result(sendIpc(job.child, { type: 'cancel' }))
      if (ipc._tag === 'Failure')
        yield* commitBestEffort(job, () =>
          job.lifecycle.transition.protocolError(
            token,
            `Cancellation IPC failed: ${errorText(ipc.failure)}`
          )
        )
    }

    let known: readonly ProcessObservation[] = []
    let identityReused = false
    let observationError: string | undefined
    const initialTable = yield* Effect.result(processTable)
    if (initialTable._tag === 'Success') {
      const root = job.lifecycle.rootProcess()
      identityReused = rootIdentityReused(initialTable.success, root, hasProcessExitEvidence(job))
      if (identityReused) {
        known = []
        observationError = 'Root process identity was reused; cleanup is unknown'
      } else {
        known = ownedProcesses(
          initialTable.success,
          job.lifecycle.pid(),
          job.lifecycle.knownProcesses(),
          root
        )
        yield* commitBestEffort(job, () => job.lifecycle.transition.processes(token, known))
      }
    } else {
      known = []
      observationError = `Cancellation process table unavailable: ${errorText(initialTable.failure)}`
      const group = yield* Effect.result(signalOwnedGroup(job, 'SIGTERM'))
      if (group._tag === 'Failure')
        observationError = `${observationError}; process-group signal failed: ${errorText(group.failure)}`
    }

    const term = yield* Effect.result(signalOwnedProcesses(known, 'SIGTERM'))
    if (term._tag === 'Failure')
      observationError = `${observationError ?? 'Cancellation'} signal failed: ${errorText(term.failure)}`
    else if (term.success !== undefined) {
      const message = term.success
      observationError = `${observationError ?? 'Cancellation'}; ${message}`
      yield* commitBestEffort(job, () => job.lifecycle.transition.cleanupError(token, message))
    }

    if (job.lifecycle.isActive())
      yield* Deferred.await(job.settled).pipe(Effect.timeoutOption('2 seconds'))

    if (job.lifecycle.isActive()) {
      const remainingTable = yield* Effect.result(processTable)
      if (remainingTable._tag === 'Success') {
        const root = job.lifecycle.rootProcess()
        if (rootIdentityReused(remainingTable.success, root, hasProcessExitEvidence(job))) {
          identityReused = true
          known = []
          observationError = `${observationError ?? 'Cancellation'} root process identity was reused; cleanup is unknown`
        } else {
          known = ownedProcesses(
            remainingTable.success,
            job.lifecycle.pid(),
            job.lifecycle.knownProcesses(),
            root
          )
          yield* commitBestEffort(job, () => job.lifecycle.transition.processes(token, known))
        }
      } else {
        known = []
        observationError = `${observationError ?? 'Cancellation'} process table unavailable after SIGTERM: ${errorText(remainingTable.failure)}`
      }
      if (remainingTable._tag === 'Failure') {
        const group = yield* Effect.result(signalOwnedGroup(job, 'SIGKILL'))
        if (group._tag === 'Failure')
          observationError = `${observationError ?? 'Cancellation'} process-group SIGKILL failed: ${errorText(group.failure)}`
      }
      if (known.length > 0 || remainingTable._tag === 'Failure') {
        const kill = yield* Effect.result(signalOwnedProcesses(known, 'SIGKILL'))
        if (kill._tag === 'Failure')
          observationError = `${observationError ?? 'Cancellation'} SIGKILL failed: ${errorText(kill.failure)}`
        else if (kill.success !== undefined) {
          const message = kill.success
          observationError = `${observationError ?? 'Cancellation'}; ${message}`
          yield* commitBestEffort(job, () => job.lifecycle.transition.cleanupError(token, message))
        }
        if (job.lifecycle.isActive())
          yield* Deferred.await(job.settled).pipe(Effect.timeoutOption('2 seconds'))
      }
    }

    if (job.lifecycle.isActive()) {
      const finalTable = yield* Effect.result(processTable)
      if (finalTable._tag === 'Success') {
        const root = job.lifecycle.rootProcess()
        if (rootIdentityReused(finalTable.success, root, hasProcessExitEvidence(job))) {
          identityReused = true
          known = []
          observationError = `${observationError ?? 'Cancellation'} root process identity was reused; cleanup is unknown`
        } else {
          known = ownedProcesses(
            finalTable.success,
            job.lifecycle.pid(),
            job.lifecycle.knownProcesses(),
            root
          )
          yield* commitBestEffort(job, () => job.lifecycle.transition.processes(token, known))
        }
        if (known.length > 0) {
          observationError = `${observationError ?? 'Cancellation requested'} but owned processes remain`
        } else if (identityReused) {
          observationError =
            observationError ?? 'Cancellation root process identity was reused; cleanup is unknown'
        } else if (
          job.lifecycle.rootProcess() === undefined ||
          job.lifecycle.rootProcess()?.birth === undefined
        ) {
          observationError = `${observationError ?? 'Cancellation'} process identity unavailable; termination is not confirmed`
        } else {
          const finished = yield* Effect.result(finish(job))
          if (finished._tag === 'Failure') yield* failObservation(job, finished.failure)
        }
      } else {
        known = []
        observationError = `${observationError ?? 'Cancellation requested'} process table unavailable during final cleanup: ${errorText(finalTable.failure)}`
      }
    }
    if (job.lifecycle.isActive())
      yield* failObservation(
        job,
        new Error(observationError ?? 'Cancellation requested but termination is not confirmed')
      )
    return yield* Deferred.await(job.settled)
  })

  const reportWorkspace = (
    job: Job,
    fact: WorkspaceExecutionFact
  ): Effect.Effect<void, WorkFailure> => {
    if (job.workspaceLaunch === 'settled') return Effect.void
    return workspace.attachment.reportExecution(job.workspace, fact).pipe(
      Effect.mapError(toFailure),
      Effect.flatMap(({ warning }) =>
        warning === undefined
          ? Effect.void
          : commitBestEffort(job, () =>
              job.lifecycle.transition.gateReleaseWarning(job.lifecycle.token, warning)
            ).pipe(Effect.asVoid)
      )
    )
  }

  const recordFor = (id: AttemptId): Effect.Effect<AttemptRecord, WorkFailure> => {
    const job = active.get(id)
    if (job) return Effect.succeed(job.lifecycle.snapshot())
    return store.read(id).pipe(
      Effect.catchIf(isRecordUnavailable, () => Effect.fail(unavailableAttempt())),
      Effect.filterOrFail(record => record.owner.sessionId === ownerSessionId, unavailableAttempt),
      Effect.mapError(toFailure)
    )
  }

  return WorkOwner.of({
    snapshot,
    dispatch,
    startProcess,
    startAgent,
    cancel,
    inspect,
    readLog,
    deliveryStatus,
    recordDeliveryFailure,
    interrupt,
    exhaust,
    close,
  })
})
