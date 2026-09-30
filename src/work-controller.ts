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
import { compactText, makeWorkStore, type WorkStore } from './work-store.ts'
import { executeWork, type WorkActions } from './work-actions.ts'
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

const execFilePromise = promisify(execFile)

type ProcessEvent =
  | { readonly type: 'message'; readonly raw: unknown }
  | { readonly type: 'exit'; readonly code: number | null; readonly signal: NodeJS.Signals | null }
  | { readonly type: 'error'; readonly message: string }
  | { readonly type: 'close'; readonly code: number | null; readonly signal: NodeJS.Signals | null }

interface Job {
  readonly lifecycle: AttemptLifecycle
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
  parent === undefined ? taskId : `${parent.lifecycle.snapshot().owner.taskId}/${taskId}`
const scopeKey = (scope: TaskScope): string => `${scope.parent ?? 'lead'}\n${scope.taskId}`
const scopeOf = (record: AttemptRecord): TaskScope => ({
  parent: record.owner.parent,
  taskId: record.owner.taskId,
})

export interface WorkOwnerOptions {
  readonly dataHome: string
  readonly cwd: string
  readonly sessionId: string
  readonly profile: string
  readonly workspace?: {
    readonly lifecycle: WorkspaceLifecycle
    readonly attachment: WorkspaceAttachment
    readonly requestRebind: (handoff: WorkspaceHandoff) => void
  }
  readonly onChange?: () => void
  readonly onOutcome?: (attempt: AttemptView) => void
  readonly childEntry?: URL
}

const PI_CHILD_ENTRY = new URL('./pi-child.ts', import.meta.url)

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

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
  return new WorkError({ message: errorMessage(cause), cause })
}

const requiredString = (value: string | undefined, name: string): string => {
  if (value === undefined || !value.trim()) throw new Error(`${name} is required`)
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
    catch: cause => new WorkError({ message: errorMessage(cause), cause }),
  })

const signalOwnedProcesses = (
  processes: readonly ProcessObservation[],
  signal: NodeJS.Signals
): Effect.Effect<string | void, WorkError> =>
  signalProcesses(processes, signal).pipe(
    Effect.catch(error => Effect.succeed(`Process signal failed: ${errorMessage(error)}`))
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
    catch: cause => new WorkError({ message: errorMessage(cause), cause }),
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
    catch: cause => new WorkError({ message: errorMessage(cause), cause }),
  })

const artifactState = (cwd: string): Effect.Effect<ArtifactState, never> =>
  Effect.all({
    head: git(cwd, ['rev-parse', 'HEAD']),
    diff: git(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--']),
    status: git(cwd, ['status', '--porcelain=v1', '--untracked-files=normal']),
  }).pipe(
    Effect.map(({ head, diff, status }) => ({
      head,
      trackedDigest: createHash('sha256').update(diff).digest('hex'),
      untracked: status.split('\n').some(line => line.startsWith('??')),
    })),
    Effect.orElseSucceed(() => ({ unavailable: true as const }))
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
) {}

class WorkOwnerImpl implements WorkOwnerService {
  private readonly active = new Map<AttemptId, Job>()
  private readonly latest = new Map<string, AttemptId>()
  private readonly reservations = new Set<string>()
  private readonly quotaReporters = new Set<AttemptId>()
  private readonly state = {
    generation: asGenerationId(randomUUID()),
    closed: false,
    exhausted: false,
  }
  private readonly admission = Semaphore.makeUnsafe(1)
  private readonly sessionId: SessionId
  private readonly cwd: string
  private readonly dataHome: string
  private readonly profile: string
  private readonly workspace: WorkOwnerOptions['workspace']
  private readonly onChange: () => void
  private readonly onOutcome: (attempt: AttemptView) => void
  private readonly childEntry: URL
  private readonly store: WorkStore

  private readonly fs: FileSystem.FileSystem
  private readonly scope: Scope.Scope

  constructor(
    store: WorkStore,
    fs: FileSystem.FileSystem,
    scope: Scope.Scope,
    options: WorkOwnerOptions
  ) {
    this.store = store
    this.fs = fs
    this.scope = scope
    this.sessionId = asSessionId(requiredString(options.sessionId, 'Session identity'))
    this.cwd = resolve(options.cwd)
    this.dataHome = resolve(options.dataHome)
    this.profile = options.profile
    this.workspace = options.workspace
    this.onChange = options.onChange ?? (() => undefined)
    this.onOutcome = options.onOutcome ?? (() => undefined)
    this.childEntry = options.childEntry ?? PI_CHILD_ENTRY
  }

  get snapshot(): Effect.Effect<WorkSnapshot, WorkFailure> {
    return Effect.gen({ self: this }, function* () {
      const listed = yield* this.store.list
      const records = listed.records
        .filter(record => record.owner.sessionId === this.sessionId)
        .map(record => {
          const job = this.active.get(record.id)
          if (job) return viewOf(job.lifecycle.snapshot())
          if (record.completedAt !== undefined) return viewOf(record)
          return viewOf({
            ...record,
            status: 'unknown',
            processObservation: 'PID unavailable; launch and exit outcome unknown',
            recovery: 'Retained facts only; no restart authorized',
          })
        })
      return { records, unavailable: listed.unavailable, agentsBlocked: this.state.exhausted }
    }).pipe(Effect.mapError(toFailure))
  }

  get dispatch(): Effect.Effect<DispatchConfig, WorkFailure> {
    return readDispatch.pipe(
      Effect.provideService(FileSystem.FileSystem, this.fs),
      Effect.mapError(toFailure)
    )
  }

  startProcess(request: ProcessStartRequest): Effect.Effect<AttemptView, WorkFailure> {
    if (typeof request.command !== 'string' || !request.command.trim()) {
      return Effect.fail(new WorkError({ message: 'command is required' }))
    }
    return this.start({ kind: 'process', ...request }, undefined).pipe(Effect.mapError(toFailure))
  }

  startAgent(request: AgentStartRequest): Effect.Effect<AttemptView, WorkFailure> {
    return this.delegate(request, undefined)
  }

  private delegate(
    request: AgentStartRequest,
    parent: Job | undefined
  ): Effect.Effect<AttemptView, WorkFailure> {
    return Effect.gen({ self: this }, function* () {
      if (request.access !== 'read-only' && request.access !== 'write') {
        return yield* new WorkError({ message: 'Delegate access must be read-only or write' })
      }
      if (typeof request.prompt !== 'string' || !request.prompt.trim()) {
        return yield* new WorkError({ message: 'prompt is required' })
      }
      if (parent !== undefined) {
        if (request.coordinate === true || request.cwd !== undefined)
          return yield* new WorkError({
            message: "A leaf runs in its coordinator's workspace and cannot coordinate",
          })
        if (parent.lifecycle.snapshot().access !== 'write' && request.access === 'write')
          return yield* new WorkError({
            message: 'A read-only coordinator can start only read-only leaves',
          })
      }
      const selection = yield* resolveDispatch(request).pipe(
        Effect.provideService(FileSystem.FileSystem, this.fs),
        Effect.mapError(toFailure)
      )
      return yield* this.start({ kind: 'agent', ...request, selection }, parent)
    }).pipe(Effect.mapError(toFailure))
  }

  cancel(id: AttemptId, reason = 'cancelled'): Effect.Effect<AttemptView, WorkFailure> {
    return Effect.uninterruptible(
      Effect.gen({ self: this }, function* () {
        const job = this.active.get(id)
        if (!job)
          return yield* new WorkError({
            message: 'Attempt is not owned by this live session; inspect retained facts instead',
          })
        yield* Deferred.await(job.prepared)
        if (job.lifecycle.isTerminal()) return yield* Deferred.await(job.settled)
        return yield* this.cancelJob(job, reason)
      })
    ).pipe(Effect.mapError(toFailure))
  }

  inspect(id: AttemptId): Effect.Effect<AttemptDescription, WorkFailure> {
    return Effect.gen({ self: this }, function* () {
      const record = yield* this.recordFor(id)
      const current = yield* artifactState(record.cwd)
      const staleArtifact = changedArtifact(record.artifactAtCompletion, current)
      const streams: readonly LogRequest['stream'][] =
        record.kind === 'agent' ? ['result', 'stderr'] : ['stdout', 'stderr']
      const logs = yield* Effect.forEach(streams, stream =>
        this.store.readLog(id, stream, undefined, 6000).pipe(
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
    }).pipe(Effect.mapError(toFailure))
  }

  readLog(request: LogRequest): Effect.Effect<LogPage, WorkFailure> {
    return this.recordFor(request.id).pipe(
      Effect.flatMap(() =>
        this.store.readLog(request.id, request.stream, request.offset, request.limit)
      ),
      Effect.mapError(toFailure)
    )
  }

  deliveryStatus(attempts: readonly AttemptView[]): Effect.Effect<WorkDeliveryStatus, WorkFailure> {
    return Effect.sync(() => ({
      eligible: attempts
        .filter(attempt => this.canDeliverUnsafe(attempt))
        .map(attempt => attempt.id),
      agentsBlocked: this.state.exhausted,
    }))
  }

  recordDeliveryFailure(id: AttemptId, message: string): Effect.Effect<void, WorkFailure> {
    return Effect.gen({ self: this }, function* () {
      const job = this.active.get(id)
      if (job !== undefined) {
        yield* this.commit(job, () =>
          job.lifecycle.transition.deliveryError(job.lifecycle.token, message)
        )
        this.onChange()
        return
      }
      const record = yield* this.recordFor(id)
      if (record.revision >= Number.MAX_SAFE_INTEGER)
        return yield* new WorkError({ message: 'Attempt revision exhausted' })
      yield* this.store.save({
        ...record,
        deliveryError: message,
        revision: record.revision + 1,
      })
      this.onChange()
    }).pipe(Effect.mapError(toFailure))
  }

  interrupt(reason = 'interrupted'): Effect.Effect<void, WorkFailure> {
    return Effect.gen({ self: this }, function* () {
      const previous = yield* this.admission.withPermit(
        Effect.sync(() => {
          this.state.generation = asGenerationId(randomUUID())
          return [...this.active.keys()]
        })
      )
      yield* this.cancelMany(previous, reason)
    }).pipe(Effect.mapError(toFailure))
  }

  exhaust(except?: AttemptId): Effect.Effect<void, WorkFailure> {
    return Effect.gen({ self: this }, function* () {
      yield* this.admission.withPermit(
        Effect.sync(() => {
          this.state.exhausted = true
          if (except !== undefined) this.quotaReporters.add(except)
        })
      )
      yield* this.cancelMany(
        [...this.active.values()]
          .filter(job => {
            const record = job.lifecycle.snapshot()
            return record.kind === 'agent' && record.id !== except
          })
          .map(job => job.lifecycle.snapshot().id),
        'subscription exhausted'
      )
    }).pipe(Effect.mapError(toFailure))
  }

  close(reason = 'session ended'): Effect.Effect<void, WorkFailure> {
    return Effect.gen({ self: this }, function* () {
      yield* this.admission.withPermit(
        Effect.sync(() => {
          this.state.closed = true
          this.state.generation = asGenerationId(randomUUID())
        })
      )
      yield* this.cancelMany([...this.active.keys()], reason)
    }).pipe(Effect.mapError(toFailure))
  }

  private cancelMany(ids: readonly AttemptId[], reason: string): Effect.Effect<void, WorkFailure> {
    return Effect.gen({ self: this }, function* () {
      const outcomes = yield* Effect.forEach(ids, id => Effect.result(this.cancel(id, reason)), {
        concurrency: 'unbounded',
      })
      const failure = outcomes.find(outcome => outcome._tag === 'Failure')
      if (failure?._tag === 'Failure') return yield* failure.failure
    })
  }

  private start(
    request: StartRequest & { readonly selection?: DispatchProfile },
    parent: Job | undefined
  ): Effect.Effect<AttemptView, WorkFailure> {
    return Effect.gen({ self: this }, function* () {
      const reservation = yield* this.reserve(request.taskId, request.kind, parent)
      let grant: WorkspaceGrant | undefined
      let installed = false
      const result = yield* Effect.gen({ self: this }, function* () {
        const requestedCwd = parent === undefined ? yield* this.resolveCwd(request.cwd) : undefined
        const id = asAttemptId(randomUUID())
        const { workspace } = this
        if (workspace === undefined)
          return yield* new WorkError({
            message: 'Workspace authority is unavailable; no work was started',
          })
        const execution = {
          sessionId: reservation.sessionId,
          taskKey: workspaceTaskKey(parent, reservation.task.taskId),
          attemptId: id,
          generation: reservation.generation,
          logs: this.store.plannedLogPath(id, 'stdout'),
        }
        const admission = yield* Effect.gen({ self: this }, function* () {
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
        yield* this.assertPrepared(
          reservation.sessionId,
          reservation.generation,
          reservation.task,
          request.kind
        )
        const record = yield* this.store.create(id, {
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
        yield* this.assertPrepared(
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
        yield* this.admission.withPermit(
          Effect.try({
            try: () => {
              this.assertPreparedUnsafe(
                reservation.sessionId,
                reservation.generation,
                reservation.task,
                request.kind
              )
              this.active.set(record.id, job)
              parent?.leaves.add(job)
              installed = true
              this.latest.set(scopeKey(reservation.task), record.id)
            },
            catch: cause => new WorkError({ message: errorMessage(cause), cause }),
          })
        )
        yield* this.launch(job, request, cwd, reservation.generation).pipe(
          Effect.ensuring(Deferred.succeed(prepared, undefined))
        )
        return viewOf(job.lifecycle.snapshot())
      }).pipe(
        Effect.tapError(() => {
          const selected = grant
          const { workspace } = this
          return !installed && selected !== undefined && workspace !== undefined
            ? workspace.attachment
                .reportExecution(selected, {
                  kind: 'launch-failed',
                  reason: 'Admission ended before any process was spawned',
                })
                .pipe(Effect.mapError(toFailure))
            : Effect.void
        }),
        Effect.ensuring(Effect.sync(() => this.reservations.delete(scopeKey(reservation.task))))
      )
      return result
    }).pipe(Effect.uninterruptible, Effect.mapError(toFailure))
  }

  private reserve(
    taskId: string,
    kind: WorkKind,
    parent: Job | undefined
  ): Effect.Effect<
    { readonly generation: GenerationId; readonly sessionId: SessionId; readonly task: TaskScope },
    WorkFailure
  > {
    return this.admission.withPermit(
      Effect.try({
        try: () => {
          if (process.platform === 'win32')
            throw new Error(
              'Background work currently requires POSIX process observation and signals'
            )
          if (this.state.closed) throw new Error('This work owner has shut down')
          if (kind === 'agent' && this.state.exhausted)
            throw new Error('Subscription exhausted; no new agents may start in this session')
          const task: TaskScope = {
            parent: parent?.lifecycle.token.attemptId,
            taskId: asTaskId(requiredString(taskId, 'taskId')),
          }
          if (parent !== undefined) this.assertCoordinatingUnsafe(parent)
          if (this.reservations.has(scopeKey(task)) || this.hasActiveTaskUnsafe(task))
            throw new Error('This task already has an active attempt')
          this.reservations.add(scopeKey(task))
          return { generation: this.state.generation, sessionId: this.sessionId, task }
        },
        catch: cause => new WorkError({ message: errorMessage(cause), cause }),
      })
    )
  }

  private assertPrepared(
    sessionId: SessionId,
    generation: GenerationId,
    task: TaskScope,
    kind: WorkKind,
    except?: AttemptId
  ): Effect.Effect<void, WorkFailure> {
    return this.admission.withPermit(
      Effect.try({
        try: () => this.assertPreparedUnsafe(sessionId, generation, task, kind, except),
        catch: cause => new WorkError({ message: errorMessage(cause), cause }),
      })
    )
  }

  private hasActiveTaskUnsafe(task: TaskScope, except?: AttemptId): boolean {
    return [...this.active.values()].some(job => {
      const record = job.lifecycle.snapshot()
      return record.id !== except && scopeKey(scopeOf(record)) === scopeKey(task)
    })
  }

  private isCoordinatingUnsafe(job: Job): boolean {
    const record = job.lifecycle.snapshot()
    return (
      record.coordinator === true &&
      !this.state.closed &&
      this.active.get(record.id) === job &&
      job.lifecycle.isActive() &&
      !job.lifecycle.hasExited() &&
      !job.lifecycle.hasResult() &&
      record.cancelRequestedAt === undefined &&
      record.owner.generation === this.state.generation
    )
  }

  private assertCoordinatingUnsafe(job: Job): void {
    if (!this.isCoordinatingUnsafe(job))
      throw new Error('This attempt is not a running coordinator authorized by the lead')
  }

  private routeLeaf(job: Job): void {
    const { parent } = job
    if (parent === undefined || !parent.leaves.delete(job)) return
    if (!this.isCoordinatingUnsafe(parent)) return
    const view = viewOf(job.lifecycle.snapshot())
    parent.undelivered.set(view.id, view)
    const wake: ControllerWorkMessage = { type: 'work-wake' }
    try {
      if (parent.child?.connected) parent.child.send(wake, () => undefined)
    } catch {}
  }

  private cancelLeaves(job: Job, reason: string): Effect.Effect<void, never> {
    return Effect.suspend(() =>
      this.cancelMany(
        [...job.leaves]
          .map(leaf => leaf.lifecycle.token.attemptId)
          .filter(id => !this.quotaReporters.has(id)),
        reason
      )
    ).pipe(Effect.ignore)
  }

  private scoped(job: Job): WorkActions {
    const coordinator = job.lifecycle.token.attemptId
    const refused = new WorkError({ message: 'Attempt is not a leaf of this coordinator' })
    const owned = <A>(id: AttemptId, use: Effect.Effect<A, WorkFailure>) =>
      this.recordFor(id).pipe(
        Effect.mapError(() => refused),
        Effect.flatMap(record => (record.owner.parent === coordinator ? use : Effect.fail(refused)))
      )
    return {
      snapshot: this.snapshot.pipe(
        Effect.map(snapshot => ({
          ...snapshot,
          unavailable: [],
          records: snapshot.records.filter(record => record.owner.parent === coordinator),
        }))
      ),
      dispatch: this.dispatch,
      startAgent: request => this.delegate(request, job),
      cancel: id => owned(id, this.cancel(id, 'cancelled by its coordinator')),
      inspect: id => owned(id, this.inspect(id)),
      readLog: request => owned(request.id, this.readLog(request)),
      interrupt: reason => this.cancelLeaves(job, reason ?? 'cancelled by its coordinator'),
    }
  }

  private serveCoordinator(job: Job, inbox: Queue.Queue<CoordinationRequest>): Effect.Effect<void> {
    return Queue.take(inbox).pipe(
      Effect.flatMap(message =>
        this.coordinatorRequest(job, message).pipe(
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
  }

  private coordinatorRequest(job: Job, message: CoordinationRequest): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const { child } = job
      if (child === undefined) return
      const { requestId } = message
      const reply = (answer: ControllerWorkMessage): Effect.Effect<void> =>
        Effect.ignore(sendIpc(child, answer))
      if (message.type === 'work-idle') {
        const live = job.leaves.size
        const outcomes = yield* Effect.forEach([...job.undelivered.values()], view =>
          this.inspect(view.id).pipe(Effect.orElseSucceed(() => view))
        )
        return yield* reply({ type: 'work-pending', requestId, live, outcomes })
      }
      const result = yield* Effect.result(
        Effect.gen({ self: this }, function* () {
          yield* Effect.try({ try: () => this.assertCoordinatingUnsafe(job), catch: toFailure })
          const input = yield* decodeWorkInput(CoordinatorWorkInputSchema)(message.input)
          return yield* executeWork(this.scoped(job), input)
        })
      )
      yield* reply(
        result._tag === 'Success'
          ? { type: 'work-reply', requestId, ok: true, result: result.success ?? {} }
          : { type: 'work-reply', requestId, ok: false, error: errorMessage(result.failure) }
      )
    })
  }

  private assertPreparedUnsafe(
    sessionId: SessionId,
    generation: GenerationId,
    task: TaskScope,
    kind: WorkKind,
    except?: AttemptId
  ): void {
    if (
      sessionId !== this.sessionId ||
      generation !== this.state.generation ||
      this.state.closed ||
      (kind === 'agent' && this.state.exhausted)
    ) {
      throw new Error('Work owner invalidated before launch')
    }
    if (this.hasActiveTaskUnsafe(task, except))
      throw new Error('This task already has an active attempt')
    if (task.parent !== undefined) {
      const parent = this.active.get(task.parent)
      if (parent === undefined) throw new Error('The coordinator of this leaf is gone')
      this.assertCoordinatingUnsafe(parent)
    }
  }

  private withPreparedPermit<A>(
    sessionId: SessionId,
    generation: GenerationId,
    task: TaskScope,
    kind: WorkKind,
    except: AttemptId,
    effect: Effect.Effect<A, WorkFailure>
  ): Effect.Effect<A, WorkFailure> {
    return this.admission.withPermit(
      Effect.gen({ self: this }, function* () {
        yield* Effect.try({
          try: () => this.assertPreparedUnsafe(sessionId, generation, task, kind, except),
          catch: cause => new WorkError({ message: errorMessage(cause), cause }),
        })
        return yield* effect
      })
    )
  }

  private commitUnlocked(
    job: Job,
    transition: () => LifecycleTransition
  ): Effect.Effect<LifecycleTransition, WorkFailure> {
    return Effect.gen({ self: this }, function* () {
      const outcome = yield* Effect.try({
        try: transition,
        catch: cause => new WorkError({ message: errorMessage(cause), cause }),
      })
      if (outcome.changed) {
        yield* this.store.save(outcome.snapshot)
        if (outcome.resultText !== undefined)
          yield* this.store.saveResult(outcome.snapshot.id, outcome.resultText)
      }
      return outcome
    })
  }

  private commit(
    job: Job,
    transition: () => LifecycleTransition
  ): Effect.Effect<LifecycleTransition, WorkFailure> {
    return this.admission.withPermit(this.commitUnlocked(job, transition))
  }

  private commitCurrent(
    job: Job,
    token: AttemptLifecycle['token'],
    transition: () => LifecycleTransition
  ): Effect.Effect<LifecycleTransition | undefined, WorkFailure> {
    return this.admission.withPermit(
      Effect.gen({ self: this }, function* () {
        if (
          this.state.closed ||
          this.state.generation !== token.generation ||
          !job.lifecycle.isActive() ||
          job.lifecycle.hasResult()
        )
          return undefined
        return yield* this.commitUnlocked(job, transition)
      })
    )
  }

  private notePersistenceFailure(job: Job, cause: unknown): Effect.Effect<void, never> {
    return this.admission.withPermit(
      Effect.sync(() => {
        job.lifecycle.transition.persistenceError(job.lifecycle.token, errorMessage(cause))
      })
    )
  }

  private commitBestEffort(
    job: Job,
    transition: () => LifecycleTransition
  ): Effect.Effect<LifecycleTransition, WorkFailure> {
    return Effect.gen({ self: this }, function* () {
      const result = yield* Effect.result(this.commit(job, transition))
      if (result._tag === 'Success') return result.success
      if (!(result.failure instanceof WorkPersistenceError)) return yield* result.failure
      yield* this.notePersistenceFailure(job, result.failure)
      return {
        accepted: true,
        changed: true,
        snapshot: job.lifecycle.snapshot(),
        state: job.lifecycle.state(),
      }
    })
  }

  private settle(job: Job): Effect.Effect<void, never> {
    return Effect.suspend(() => {
      this.routeLeaf(job)
      return Deferred.succeed(job.settled, viewOf(job.lifecycle.snapshot()))
    }).pipe(
      Effect.andThen(job.inbox === undefined ? Effect.void : Queue.shutdown(job.inbox)),
      Effect.ignore
    )
  }

  private commitCurrentBestEffort(
    job: Job,
    token: AttemptLifecycle['token'],
    transition: () => LifecycleTransition
  ): Effect.Effect<LifecycleTransition | undefined, WorkFailure> {
    return Effect.gen({ self: this }, function* () {
      const result = yield* Effect.result(this.commitCurrent(job, token, transition))
      if (result._tag === 'Success') return result.success
      if (!(result.failure instanceof WorkPersistenceError)) return yield* result.failure
      yield* this.notePersistenceFailure(job, result.failure)
      return {
        accepted: true,
        changed: true,
        snapshot: job.lifecycle.snapshot(),
        state: job.lifecycle.state(),
      }
    })
  }

  private resolveCwd(cwd: string | undefined): Effect.Effect<string, WorkFailure> {
    const { fs } = this
    return fs
      .realPath(resolve(this.cwd, cwd ?? this.cwd))
      .pipe(Effect.mapError(cause => new WorkError({ message: errorMessage(cause), cause })))
  }

  private launch(
    job: Job,
    request: StartRequest & { readonly selection?: DispatchProfile },
    cwd: string,
    generation: GenerationId
  ): Effect.Effect<void, WorkFailure> {
    let stdout: number | undefined
    let stderr: number | undefined
    const { token } = job.lifecycle
    const launchCore = Effect.gen({ self: this }, function* () {
      const record = job.lifecycle.snapshot()
      yield* this.reportWorkspace(job, {
        kind: 'launch-intent',
        execution: {
          sessionId: record.owner.sessionId,
          taskKey: workspaceTaskKey(job.parent, record.owner.taskId),
          attemptId: record.id,
          generation: record.owner.generation,
          logs: this.store.logPath(record.id, 'stdout'),
        },
      })
      yield* this.withPreparedPermit(
        token.sessionId,
        generation,
        scopeOf(record),
        request.kind,
        record.id,
        Effect.try({
          try: () => {
            stdout = openSync(this.store.logPath(record.id, 'stdout'), 'wx', 0o600)
            stderr = openSync(this.store.logPath(record.id, 'stderr'), 'wx', 0o600)
          },
          catch: cause => new WorkError({ message: errorMessage(cause), cause }),
        })
      )
      const child = yield* this.withPreparedPermit(
        token.sessionId,
        generation,
        scopeOf(record),
        request.kind,
        record.id,
        Effect.try({
          try: () => {
            if (stdout === undefined || stderr === undefined)
              throw new Error('Work log descriptors are unavailable')
            const options = {
              cwd,
              detached: true,
              env: {
                ...process.env,
                DEV_DATA_HOME: this.dataHome,
                PI_CODING_AGENT_DIR: globalPiAgentDir(),
              },
            }
            const spawned =
              request.kind === 'agent'
                ? fork(this.childEntry, [], {
                    ...options,
                    execArgv: [],
                    stdio: ['ignore', stdout, stderr, 'ipc'],
                  })
                : spawn(
                    '/bin/bash',
                    ['-c', processGateScript, 'dev-work-process', request.command],
                    {
                      ...options,
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
          catch: cause => new WorkError({ message: errorMessage(cause), cause }),
        })
      )
      const { pid: childPid } = child
      if (childPid === undefined) {
        const event = yield* Queue.take(job.events)
        let message: string
        if (event.type === 'error') {
          const { message: errorText } = event
          message = errorText
        } else if (event.type === 'close')
          message = `Child closed before PID was available: ${event.code ?? 'unknown'}`
        else message = 'Child exited before PID was available'
        return yield* new WorkError({ message })
      }
      yield* this.commit(job, () => job.lifecycle.transition.spawn(token, childPid))
      yield* this.admission.withPermit(
        Effect.gen({ self: this }, function* () {
          yield* Effect.try({
            try: () =>
              this.assertPreparedUnsafe(
                token.sessionId,
                generation,
                scopeOf(record),
                request.kind,
                record.id
              ),
            catch: cause => new WorkError({ message: errorMessage(cause), cause }),
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
          yield* this.commitUnlocked(job, () => job.lifecycle.transition.processes(token, known))
          const processIdentity = yield* Schema.decodeEffect(WorkspaceProcessSchema)(root).pipe(
            Effect.mapError(toFailure)
          )
          yield* this.reportWorkspace(job, { kind: 'spawned', process: processIdentity })
          job.workspaceLaunch = 'identity-recorded'
          yield* this.reportWorkspace(job, { kind: 'started' })
          if (job.gate !== undefined) {
            const { gate } = job
            job.executionReleased = true
            yield* Effect.try({
              try: () => gate.end('\n'),
              catch: cause => new WorkError({ message: errorMessage(cause), cause }),
            })
            job.gate = undefined
          }
        })
      )
      if (request.kind === 'agent')
        yield* this.withPreparedPermit(
          token.sessionId,
          generation,
          scopeOf(record),
          request.kind,
          record.id,
          Effect.gen({ self: this }, function* () {
            job.executionReleased = true
            yield* sendIpc(child, {
              type: 'start',
              request: {
                dataHome: this.dataHome,
                cwd,
                profile: this.profile,
                sessionDir: join(this.dataHome, 'child-sessions'),
                access: request.access,
                prompt: request.prompt,
                ...(record.coordinator === true ? { coordinate: true } : {}),
                owner: record.owner,
                workspace: job.workspace,
                model: request.selection?.model,
                effort: request.selection?.effort,
              },
            })
          })
        )
      yield* this.withPreparedPermit(
        token.sessionId,
        generation,
        scopeOf(record),
        request.kind,
        record.id,
        Effect.gen({ self: this }, function* () {
          yield* this.store.save(job.lifecycle.snapshot())
          yield* Effect.forkIn(this.scope)(this.waitForOwnedExit(job))
          if (job.inbox !== undefined)
            yield* Effect.forkIn(this.scope)(this.serveCoordinator(job, job.inbox))
        })
      )
      this.onChange()
    }).pipe(
      Effect.catch(error => this.failLaunch(job, error)),
      Effect.ensuring(
        Effect.sync(() => {
          if (stdout !== undefined) closeSync(stdout)
          if (stderr !== undefined) closeSync(stderr)
        })
      )
    )
    return launchCore
  }

  private failLaunch(job: Job, cause: unknown): Effect.Effect<never, WorkFailure> {
    return Effect.gen({ self: this }, function* () {
      const { token } = job.lifecycle
      if (!job.executionReleased) {
        const { gate } = job
        job.gate = undefined
        yield* Effect.sync(() => abortChild(job.child, gate))
        yield* Effect.ignore(
          this.settleUnrecordedLaunch(
            job,
            `The launch failed before user code was released: ${errorMessage(cause)}`
          )
        )
      }

      yield* this.commitBestEffort(job, () =>
        job.lifecycle.transition.processError(token, errorMessage(cause))
      )
      if (job.lifecycle.isActive()) {
        if (job.child === undefined || job.child.pid === undefined) {
          yield* this.commitBestEffort(job, () => job.lifecycle.transition.exit(token, null, null))
          yield* this.finish(job).pipe(Effect.catch(error => this.failObservation(job, error)))
        } else {
          yield* Effect.scoped(
            Effect.gen({ self: this }, function* () {
              yield* Effect.forkScoped(this.waitForOwnedExit(job))
              yield* this.cancelJob(job, 'launch failed')
            })
          ).pipe(Effect.catch(error => this.failObservation(job, error)))
        }
      }
      return yield* new WorkError({ message: errorMessage(cause), cause })
    })
  }

  private childMessage(job: Job, raw: unknown): Effect.Effect<void, WorkFailure> {
    const { token } = job.lifecycle
    return Effect.gen({ self: this }, function* () {
      if (
        !job.lifecycle.isActive() ||
        job.lifecycle.hasResult() ||
        token.generation !== this.state.generation
      )
        return yield* refuseStaleRequest(job, raw)
      const record = job.lifecycle.snapshot()
      const message = yield* parseChildMessage(raw, {
        cwd: record.cwd,
        sessionDir: join(this.dataHome, 'child-sessions'),
      }).pipe(Effect.mapError(toFailure))
      if (message.type === 'workspace-check') {
        const { workspace } = this
        const { child } = job
        if (workspace === undefined || child === undefined)
          return yield* new WorkError({ message: 'Child workspace owner is unavailable' })
        const checked = yield* Effect.result(
          Effect.gen({ self: this }, function* () {
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
                this.assertPreparedUnsafe(
                  token.sessionId,
                  token.generation,
                  scopeOf(record),
                  record.kind,
                  record.id
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
          ...(checked._tag === 'Failure' ? { reason: errorMessage(checked.failure) } : {}),
        })
        return
      }
      if (isCoordinationMessage(message)) {
        if (message.type === 'work-outcomes-ack')
          for (const id of message.attempts) job.undelivered.delete(id)
        else if (job.inbox === undefined) yield* this.coordinatorRequest(job, message)
        else {
          job.pendingRequests += 1
          Queue.offerUnsafe(job.inbox, message)
        }
        return
      }
      if (message.type === 'ready' || message.type === 'progress') {
        const outcome = yield* this.commitCurrentBestEffort(job, token, () =>
          job.lifecycle.transition.progress(token, {
            ...(message.model === undefined ? {} : { model: message.model }),
            ...(message.effort === undefined ? {} : { effort: message.effort }),
            ...(message.sessionFile === undefined ? {} : { sessionFile: message.sessionFile }),
            ...(message.resources === undefined ? {} : { resources: message.resources }),
            ...(message.context === undefined ? {} : { context: message.context }),
            ...(message.usage === undefined ? {} : { usage: message.usage }),
          })
        )
        if (outcome !== undefined) this.onChange()
      } else {
        const unresolved = job.pendingRequests + job.leaves.size + job.undelivered.size
        if (message.error === undefined && unresolved > 0)
          return yield* new WorkProtocolError({
            message: `A coordinator reported its result while ${unresolved} request(s) or leaf outcome(s) were unresolved`,
          })
        const outcome = yield* this.commitCurrentBestEffort(job, token, () =>
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
          yield* Effect.forkIn(this.scope)(this.cancelLeaves(job, 'coordinator reported a failure'))
        if (outcome.accepted && (outcome.quotaExhausted || quotaExhausted(message.error)))
          yield* this.exhaust(record.id)
        this.onChange()
      }
    }).pipe(
      Effect.catch(error =>
        Effect.gen({ self: this }, function* () {
          const message = errorMessage(error)
          const outcome = yield* this.commitCurrentBestEffort(job, token, () =>
            error instanceof WorkProtocolError
              ? job.lifecycle.transition.rejectedMessage(token, message)
              : job.lifecycle.transition.persistenceError(token, message)
          )
          if (outcome !== undefined)
            yield* Effect.forkIn(this.scope)(
              Effect.ignore(this.cancelJob(job, 'invalid child message'))
            )
        })
      )
    )
  }

  private waitForOwnedExit(job: Job): Effect.Effect<void, WorkFailure> {
    const { token } = job.lifecycle
    return Effect.whileLoop({
      while: () => job.lifecycle.isActive(),
      body: () =>
        Effect.gen({ self: this }, function* () {
          if (!job.lifecycle.hasExited()) {
            const event = yield* Queue.take(job.events)
            if (event.type === 'message') yield* this.childMessage(job, event.raw)
            else if (event.type === 'error')
              yield* this.commitBestEffort(job, () =>
                job.lifecycle.transition.processError(token, event.message)
              )
            else if (event.type === 'exit')
              yield* this.commitBestEffort(job, () =>
                job.lifecycle.transition.exit(token, event.code, event.signal)
              )
            else if (event.type === 'close' || job.lifecycle.pid() === undefined)
              yield* this.commitBestEffort(job, () =>
                job.lifecycle.transition.exit(token, null, null)
              )
            if (job.lifecycle.hasExited())
              yield* Effect.forkIn(this.scope)(this.cancelLeaves(job, 'coordinator exited'))
            return
          }
          const pending = yield* Queue.poll(job.events)
          if (pending._tag === 'Some') {
            const event = pending.value
            if (event.type === 'message') yield* this.childMessage(job, event.raw)
            else if (event.type === 'error')
              yield* this.commitBestEffort(job, () =>
                job.lifecycle.transition.processError(token, event.message)
              )
            return
          }
          yield* this.settleUnrecordedLaunch(
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
              report: processes => this.reportWorkspace(job, { kind: 'observed', processes }),
            }
          )
          job.observedProcesses = family.reported
          const { known } = family
          yield* this.commitBestEffort(job, () => job.lifecycle.transition.processes(token, known))
          if (known.length === 0) {
            yield* this.finish(job)
            return
          }
          yield* this.commitBestEffort(job, () => job.lifecycle.transition.waiting(token))
          this.onChange()
          yield* Effect.sleep(Duration.millis(500))
        }),
      step: () => undefined,
    }).pipe(
      Effect.asVoid,
      Effect.catch(error => this.failObservation(job, error))
    )
  }

  private settleUnrecordedLaunch(job: Job, reason: string): Effect.Effect<void, WorkFailure> {
    if (job.workspaceLaunch !== 'identity-unrecorded') return Effect.void
    return this.reportWorkspace(job, { kind: 'launch-failed', reason }).pipe(
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

  private failObservation(job: Job, cause: unknown): Effect.Effect<void, never> {
    const { token } = job.lifecycle
    return Effect.gen({ self: this }, function* () {
      yield* this.reportWorkspace(job, { kind: 'unknown', reason: errorMessage(cause) }).pipe(
        Effect.catch(error =>
          Effect.sync(() => {
            process.stderr.write(
              `Workspace uncertainty could not be recorded: ${errorMessage(error)}\n`
            )
          })
        )
      )
      if (job.lifecycle.isTerminal()) {
        if (cause instanceof WorkPersistenceError) yield* this.notePersistenceFailure(job, cause)
        yield* Queue.shutdown(job.events).pipe(Effect.ignore)
        yield* this.settle(job)
        this.onChange()
        return
      }
      if (job.lifecycle.isUnknown()) {
        yield* this.settle(job)
        return
      }
      const outcome = yield* Effect.result(
        this.commit(job, () =>
          job.lifecycle.transition.unknown(
            token,
            `Process observation unavailable: ${errorMessage(cause)}`
          )
        )
      )
      if (outcome._tag === 'Failure') yield* this.notePersistenceFailure(job, outcome.failure)
      yield* this.settle(job)
      this.onChange()
    })
  }

  private finish(job: Job): Effect.Effect<void, WorkFailure> {
    const { token } = job.lifecycle
    return Effect.gen({ self: this }, function* () {
      if (!job.lifecycle.isActive()) return
      const record = job.lifecycle.snapshot()
      let cleanupError: string | undefined
      const observation = yield* Effect.result(
        this.reportWorkspace(
          job,
          job.workspaceLaunch === 'identity-recorded'
            ? {
                kind: 'quiescent',
                reason: 'The owned process group and every tracked descendant were observed gone',
              }
            : { kind: 'launch-failed', reason: 'No process identity was recorded before failure' }
        ).pipe(Effect.retry(transientRetry))
      )
      if (observation._tag === 'Failure') cleanupError = errorMessage(observation.failure)

      const completedAt = yield* Clock.currentTimeMillis
      const artifactAtCompletion = yield* artifactState(record.cwd)
      const changedDuringRun = changedArtifact(record.artifactAtStart, artifactAtCompletion)
      const saved = yield* Effect.result(
        this.commit(job, () =>
          job.lifecycle.transition.complete(token, {
            artifactAtCompletion,
            changedDuringRun,
            completedAt,
            ...(cleanupError === undefined ? {} : { cleanupError }),
          })
        )
      )
      if (saved._tag === 'Failure') {
        yield* this.failObservation(job, saved.failure)
        return
      }
      if (!saved.success.accepted || !saved.success.changed) {
        yield* this.settle(job)
        return
      }
      yield* Queue.shutdown(job.events).pipe(Effect.ignore)
      this.routeLeaf(job)
      this.active.delete(saved.success.snapshot.id)
      const completed = viewOf(job.lifecycle.snapshot())
      yield* this.settle(job)
      this.onChange()
      if (job.parent === undefined && this.canDeliverUnsafe(completed)) this.onOutcome(completed)
    })
  }

  private canDeliverUnsafe(attempt: AttemptView): boolean {
    return (
      !this.state.closed &&
      attempt.owner.sessionId === this.sessionId &&
      attempt.completedAt !== undefined &&
      attempt.owner.generation === this.state.generation &&
      this.latest.get(scopeKey(scopeOf(attempt))) === attempt.id
    )
  }

  private cancelJob(job: Job, reason: string): Effect.Effect<AttemptView, WorkFailure> {
    return Effect.all(
      [this.terminate(job, reason), this.cancelLeaves(job, `coordinator stopped: ${reason}`)],
      { concurrency: 'unbounded' }
    ).pipe(Effect.map(([view]) => view))
  }

  private terminate(job: Job, reason: string): Effect.Effect<AttemptView, WorkFailure> {
    const { token } = job.lifecycle
    return Effect.gen({ self: this }, function* () {
      const requestedAt = yield* Clock.currentTimeMillis
      yield* this.commitBestEffort(job, () =>
        job.lifecycle.transition.cancel(token, requestedAt, reason)
      )
      if (!job.lifecycle.isActive()) return yield* Deferred.await(job.settled)
      if (job.child === undefined) {
        yield* this.failObservation(job, new Error('Cancellation raced with launch setup'))
        return yield* Deferred.await(job.settled)
      }
      if (job.child.connected) {
        const ipc = yield* Effect.result(sendIpc(job.child, { type: 'cancel' }))
        if (ipc._tag === 'Failure')
          yield* this.commitBestEffort(job, () =>
            job.lifecycle.transition.protocolError(
              token,
              `Cancellation IPC failed: ${errorMessage(ipc.failure)}`
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
          yield* this.commitBestEffort(job, () => job.lifecycle.transition.processes(token, known))
        }
      } else {
        known = []
        observationError = `Cancellation process table unavailable: ${errorMessage(initialTable.failure)}`
        const group = yield* Effect.result(signalOwnedGroup(job, 'SIGTERM'))
        if (group._tag === 'Failure')
          observationError = `${observationError}; process-group signal failed: ${errorMessage(group.failure)}`
      }

      const term = yield* Effect.result(signalOwnedProcesses(known, 'SIGTERM'))
      if (term._tag === 'Failure')
        observationError = `${observationError ?? 'Cancellation'} signal failed: ${errorMessage(term.failure)}`
      else if (term.success !== undefined) {
        const message = term.success
        observationError = `${observationError ?? 'Cancellation'}; ${message}`
        yield* this.commitBestEffort(job, () =>
          job.lifecycle.transition.cleanupError(token, message)
        )
      }

      for (let step = 0; step < 20 && job.lifecycle.isActive(); step += 1)
        yield* Effect.sleep(Duration.millis(100))

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
            yield* this.commitBestEffort(job, () =>
              job.lifecycle.transition.processes(token, known)
            )
          }
        } else {
          known = []
          observationError = `${observationError ?? 'Cancellation'} process table unavailable after SIGTERM: ${errorMessage(remainingTable.failure)}`
        }
        if (remainingTable._tag === 'Failure') {
          const group = yield* Effect.result(signalOwnedGroup(job, 'SIGKILL'))
          if (group._tag === 'Failure')
            observationError = `${observationError ?? 'Cancellation'} process-group SIGKILL failed: ${errorMessage(group.failure)}`
        }
        if (known.length > 0 || remainingTable._tag === 'Failure') {
          const kill = yield* Effect.result(signalOwnedProcesses(known, 'SIGKILL'))
          if (kill._tag === 'Failure')
            observationError = `${observationError ?? 'Cancellation'} SIGKILL failed: ${errorMessage(kill.failure)}`
          else if (kill.success !== undefined) {
            const message = kill.success
            observationError = `${observationError ?? 'Cancellation'}; ${message}`
            yield* this.commitBestEffort(job, () =>
              job.lifecycle.transition.cleanupError(token, message)
            )
          }
          for (let step = 0; step < 20 && job.lifecycle.isActive(); step += 1)
            yield* Effect.sleep(Duration.millis(100))
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
            yield* this.commitBestEffort(job, () =>
              job.lifecycle.transition.processes(token, known)
            )
          }
          if (known.length > 0) {
            observationError = `${observationError ?? 'Cancellation requested'} but owned processes remain`
          } else if (identityReused) {
            observationError =
              observationError ??
              'Cancellation root process identity was reused; cleanup is unknown'
          } else if (
            job.lifecycle.rootProcess() === undefined ||
            job.lifecycle.rootProcess()?.birth === undefined
          ) {
            observationError = `${observationError ?? 'Cancellation'} process identity unavailable; termination is not confirmed`
          } else {
            const finished = yield* Effect.result(this.finish(job))
            if (finished._tag === 'Failure') yield* this.failObservation(job, finished.failure)
          }
        } else {
          known = []
          observationError = `${observationError ?? 'Cancellation requested'} process table unavailable during final cleanup: ${errorMessage(finalTable.failure)}`
        }
      }
      if (job.lifecycle.isActive())
        yield* this.failObservation(
          job,
          new Error(observationError ?? 'Cancellation requested but termination is not confirmed')
        )
      return yield* Deferred.await(job.settled)
    })
  }

  private reportWorkspace(
    job: Job,
    fact: WorkspaceExecutionFact
  ): Effect.Effect<void, WorkFailure> {
    const { workspace } = this
    if (workspace === undefined)
      return Effect.fail(new WorkError({ message: 'Workspace authority is unavailable' }))
    if (job.workspaceLaunch === 'settled') return Effect.void
    return workspace.attachment
      .reportExecution(job.workspace, fact)
      .pipe(Effect.mapError(toFailure))
  }

  private recordFor(id: AttemptId): Effect.Effect<AttemptRecord, WorkFailure> {
    const job = this.active.get(id)
    if (job) return Effect.succeed(job.lifecycle.snapshot())
    return this.store.read(id).pipe(
      Effect.filterOrFail(
        record => record.owner.sessionId === this.sessionId,
        () =>
          new WorkError({
            message: 'Result is unavailable in this session (unknown or expired attempt)',
          })
      ),
      Effect.mapError(toFailure)
    )
  }
}

export const makeWorkOwnerLayer = (
  options: WorkOwnerOptions
): Layer.Layer<WorkOwner, WorkSetupError> =>
  Layer.effect(
    WorkOwner,
    Effect.acquireRelease(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const scope = yield* Effect.scope
        const sessionId = asSessionId(requiredString(options.sessionId, 'Session identity'))
        const store = yield* makeWorkStore(options.dataHome, sessionId)
        return new WorkOwnerImpl(store, fs, scope, options)
      }).pipe(
        Effect.mapError(cause => new WorkSetupError({ message: errorMessage(cause), cause }))
      ),
      owner => owner.close('session scope closed').pipe(Effect.orDie)
    )
  ).pipe(Layer.provide(NodeFileSystem.layer))

export const ownerEffect = <A>(
  f: (owner: WorkOwnerService) => Effect.Effect<A, WorkFailure>
): Effect.Effect<A, WorkFailure, WorkOwner> => Effect.flatMap(WorkOwner, f)
