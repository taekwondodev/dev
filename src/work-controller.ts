import { NodeFileSystem } from '@effect/platform-node'
import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Queue,
  Semaphore,
  Schema,
} from 'effect'
import type * as Scope from 'effect/Scope'
import { createHash, randomUUID } from 'node:crypto'
import { execFile, fork, spawn, type ChildProcess } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Writable } from 'node:stream'
import { promisify } from 'node:util'
import {
  WorkDispatchError,
  WorkError,
  WorkPersistenceError,
  WorkProtocolError,
  WorkSetupError,
  AttemptId as AttemptIdSchema,
  SessionId as SessionIdSchema,
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
import { parseChildMessage } from './work-protocol.ts'
import { globalPiAgentDir } from './preferences.ts'

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
  lease?: string
  leaseRoot?: string
}

export interface WorkOwnerOptions {
  readonly dataHome: string
  readonly cwd: string
  readonly sessionId: string
  readonly specialization: string
  readonly onChange?: () => void
  readonly onOutcome?: (attempt: AttemptView) => void
}

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const toFailure = (cause: unknown): WorkFailure => {
  if (
    cause instanceof WorkError ||
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

const WriterLeaseSchema = Schema.Struct({
  id: AttemptIdSchema,
  controllerPid: Schema.Int,
  cwd: Schema.String,
  sessionId: SessionIdSchema,
})
type WriterLease = typeof WriterLeaseSchema.Type

const writerLeaseMatches = (actual: WriterLease, expected: WriterLease): boolean =>
  actual.id === expected.id &&
  actual.controllerPid === expected.controllerPid &&
  actual.cwd === expected.cwd &&
  actual.sessionId === expected.sessionId

const parseWriterLease = (value: string): WriterLease | undefined => {
  try {
    return Schema.decodeUnknownSync(WriterLeaseSchema)(JSON.parse(value))
  } catch {
    return undefined
  }
}

const releaseWriterLease = (
  fs: FileSystem.FileSystem,
  path: string,
  expected: WriterLease | undefined
): Effect.Effect<string | undefined, never> =>
  Effect.gen(function* () {
    if (expected === undefined)
      return `Writer lease retained: ${path}; expected owner is unavailable, inspect current worktree use`
    const exists = yield* Effect.result(fs.exists(path))
    if (exists._tag === 'Failure')
      return `Writer lease retained: ${path}; existence could not be verified: ${errorMessage(exists.failure)}`
    if (!exists.success)
      return `Writer lease missing before release: ${path}; inspect current worktree use`
    const info = yield* Effect.result(fs.stat(path))
    if (info._tag === 'Failure')
      return `Writer lease retained: ${path}; owner could not be verified: ${errorMessage(info.failure)}`
    if (info.success.type !== 'File')
      return `Writer lease retained: ${path}; expected a regular lease file, inspect current worktree use`
    const contents = yield* Effect.result(fs.readFileString(path))
    if (contents._tag === 'Failure')
      return `Writer lease retained: ${path}; owner could not be read: ${errorMessage(contents.failure)}`
    const actual = parseWriterLease(contents.success)
    if (actual === undefined || !writerLeaseMatches(actual, expected))
      return `Writer lease replaced or malformed: ${path}; inspect current worktree use`
    const confirmedContents = yield* Effect.result(fs.readFileString(path))
    if (confirmedContents._tag === 'Failure')
      return `Writer lease retained: ${path}; owner could not be reverified: ${errorMessage(confirmedContents.failure)}`
    const confirmed = parseWriterLease(confirmedContents.success)
    if (confirmed === undefined || !writerLeaseMatches(confirmed, expected))
      return `Writer lease replaced during release: ${path}; inspect current worktree use`
    const removed = yield* Effect.result(fs.remove(path))
    if (removed._tag === 'Failure')
      return `Writer lease retained: ${path}: ${errorMessage(removed.failure)}`
    return undefined
  })

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
      ? 'Termination or reservation release is not confirmed. Do not remove this worktree.'
      : 'Verify and integrate or preserve changes, check current worktree use, then seek authorization for removal. Dev does not delete worktrees; never force removal.',
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

const processTable = Effect.tryPromise({
  try: async () => {
    const { stdout } = await execFilePromise('ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart='], {
      maxBuffer: 4 * 1024 * 1024,
      timeout: 2000,
    })
    return stdout.split('\n').flatMap(line => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/)
      return !match || match[4].startsWith('Z')
        ? []
        : [
            {
              pid: Number(match[1]),
              parent: Number(match[2]),
              group: Number(match[3]),
              birth: match[5],
            },
          ]
    })
  },
  catch: cause => new WorkError({ message: errorMessage(cause), cause }),
})

const processGateScript = 'IFS= read -r _ <&3 || exit 125; exec 3<&-; exec /bin/bash -c "$1"'

const processGate = (child: ChildProcess): Writable => {
  const [, , , descriptor] = child.stdio
  if (!(descriptor instanceof Writable)) throw new Error('Process execution gate is unavailable')
  descriptor.on('error', () => undefined)
  return descriptor
}

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

const rootIdentityReused = (
  table: readonly ProcessObservation[],
  root: ProcessObservation | undefined,
  exited: boolean
): boolean =>
  root !== undefined &&
  table.some(
    item => item.pid === root.pid && (root.birth === undefined ? exited : item.birth !== root.birth)
  )

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

export class WorkOwner extends Context.Service<WorkOwner, WorkOwnerService>()(
  'dev/work/WorkOwner'
) {}

class WorkOwnerImpl implements WorkOwnerService {
  private readonly active = new Map<AttemptId, Job>()
  private readonly latest = new Map<TaskId, AttemptId>()
  private readonly reservations = new Set<TaskId>()
  private readonly state = {
    generation: asGenerationId(randomUUID()),
    closed: false,
    exhausted: false,
  }
  private readonly admission = Semaphore.makeUnsafe(1)
  private readonly sessionId: SessionId
  private readonly cwd: string
  private readonly dataHome: string
  private readonly specialization: string
  private readonly onChange: () => void
  private readonly onOutcome: (attempt: AttemptView) => void
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
    this.specialization = options.specialization
    this.onChange = options.onChange ?? (() => undefined)
    this.onOutcome = options.onOutcome ?? (() => undefined)
  }

  get snapshot(): Effect.Effect<WorkSnapshot, WorkFailure> {
    // oxlint-disable-next-line typescript/no-this-alias
    const self = this
    return Effect.gen(function* () {
      const listed = yield* self.store.list
      const records = listed.records
        .filter(record => record.owner.sessionId === self.sessionId)
        .map(record => {
          const job = self.active.get(record.id)
          if (job) return viewOf(job.lifecycle.snapshot())
          if (record.completedAt !== undefined) return viewOf(record)
          return viewOf({
            ...record,
            status: 'unknown',
            processObservation: 'PID unavailable; launch and exit outcome unknown',
            recovery: 'Retained facts only; no restart authorized',
          })
        })
      return { records, unavailable: listed.unavailable, agentsBlocked: self.state.exhausted }
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
    return this.start({ kind: 'process', ...request }).pipe(Effect.mapError(toFailure))
  }

  startAgent(request: AgentStartRequest): Effect.Effect<AttemptView, WorkFailure> {
    // oxlint-disable-next-line typescript/no-this-alias
    const self = this
    return Effect.gen(function* () {
      if (request.access !== 'read-only' && request.access !== 'write') {
        return yield* new WorkError({ message: 'Delegate access must be read-only or write' })
      }
      if (typeof request.prompt !== 'string' || !request.prompt.trim()) {
        return yield* new WorkError({ message: 'prompt is required' })
      }
      if (
        request.skills !== undefined &&
        (!Array.isArray(request.skills) ||
          request.skills.some(skill => typeof skill !== 'string' || !skill.trim()))
      ) {
        return yield* new WorkError({ message: 'skills must contain skill names' })
      }
      const selection = yield* resolveDispatch(request).pipe(
        Effect.provideService(FileSystem.FileSystem, self.fs),
        Effect.mapError(toFailure)
      )
      return yield* self.start({ kind: 'agent', ...request, selection })
    }).pipe(Effect.mapError(toFailure))
  }

  cancel(id: AttemptId, reason = 'cancelled'): Effect.Effect<AttemptView, WorkFailure> {
    // oxlint-disable-next-line typescript/no-this-alias
    const self = this
    return Effect.uninterruptible(
      Effect.gen(function* () {
        const job = self.active.get(id)
        if (!job)
          return yield* new WorkError({
            message: 'Attempt is not owned by this live session; inspect retained facts instead',
          })
        yield* Deferred.await(job.prepared)
        if (job.lifecycle.isTerminal()) return yield* Deferred.await(job.settled)
        return yield* self.cancelJob(job, reason)
      })
    ).pipe(Effect.mapError(toFailure))
  }

  inspect(id: AttemptId): Effect.Effect<AttemptDescription, WorkFailure> {
    // oxlint-disable-next-line typescript/no-this-alias
    const self = this
    return Effect.gen(function* () {
      const record = yield* self.recordFor(id)
      const current = yield* artifactState(record.cwd)
      const staleArtifact = changedArtifact(record.artifactAtCompletion, current)
      const streams: readonly LogRequest['stream'][] =
        record.kind === 'agent' ? ['result', 'stderr'] : ['stdout', 'stderr']
      const logs = yield* Effect.forEach(streams, stream =>
        self.store.readLog(id, stream, undefined, 6000).pipe(
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
    // oxlint-disable-next-line typescript/no-this-alias
    const self = this
    return Effect.gen(function* () {
      const job = self.active.get(id)
      if (job !== undefined) {
        yield* self.commit(job, () =>
          job.lifecycle.transition.deliveryError(job.lifecycle.token, message)
        )
        self.onChange()
        return
      }
      const record = yield* self.recordFor(id)
      if (record.revision >= Number.MAX_SAFE_INTEGER)
        return yield* new WorkError({ message: 'Attempt revision exhausted' })
      yield* self.store.save({
        ...record,
        deliveryError: message,
        revision: record.revision + 1,
      })
      self.onChange()
    }).pipe(Effect.mapError(toFailure))
  }

  interrupt(reason = 'interrupted'): Effect.Effect<void, WorkFailure> {
    // oxlint-disable-next-line typescript/no-this-alias
    const self = this
    return Effect.gen(function* () {
      const previous = yield* self.admission.withPermit(
        Effect.sync(() => {
          self.state.generation = asGenerationId(randomUUID())
          return [...self.active.keys()]
        })
      )
      yield* self.cancelMany(previous, reason)
    }).pipe(Effect.mapError(toFailure))
  }

  exhaust(except?: AttemptId): Effect.Effect<void, WorkFailure> {
    // oxlint-disable-next-line typescript/no-this-alias
    const self = this
    return Effect.gen(function* () {
      yield* self.admission.withPermit(
        Effect.sync(() => {
          self.state.exhausted = true
        })
      )
      yield* self.cancelMany(
        [...self.active.values()]
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
    // oxlint-disable-next-line typescript/no-this-alias
    const self = this
    return Effect.gen(function* () {
      yield* self.admission.withPermit(
        Effect.sync(() => {
          self.state.closed = true
          self.state.generation = asGenerationId(randomUUID())
        })
      )
      yield* self.cancelMany([...self.active.keys()], reason)
    }).pipe(Effect.mapError(toFailure))
  }

  private cancelMany(ids: readonly AttemptId[], reason: string): Effect.Effect<void, WorkFailure> {
    // oxlint-disable-next-line typescript/no-this-alias
    const self = this
    return Effect.gen(function* () {
      const outcomes = yield* Effect.forEach(ids, id => Effect.result(self.cancel(id, reason)), {
        concurrency: 'unbounded',
      })
      const failure = outcomes.find(outcome => outcome._tag === 'Failure')
      if (failure?._tag === 'Failure') return yield* failure.failure
    })
  }

  private start(
    request: StartRequest & { readonly selection?: DispatchProfile }
  ): Effect.Effect<AttemptView, WorkFailure> {
    // oxlint-disable-next-line typescript/no-this-alias
    const self = this
    return Effect.gen(function* () {
      const reservation = yield* self.reserve(request.taskId, request.kind)
      const result = yield* Effect.gen(function* () {
        const cwd = yield* self.resolveCwd(request.cwd)
        const artifactAtStart = yield* artifactState(cwd)
        yield* self.assertPrepared(
          reservation.sessionId,
          reservation.generation,
          reservation.taskId,
          request.kind
        )
        const record = yield* self.store.create({
          kind: request.kind,
          cwd,
          controllerPid: process.pid,
          owner: {
            sessionId: reservation.sessionId,
            taskId: reservation.taskId,
            generation: reservation.generation,
          },
          ...(request.kind === 'agent'
            ? { access: request.access, selection: request.selection }
            : {}),
          artifactAtStart,
        })
        yield* self.assertPrepared(
          reservation.sessionId,
          reservation.generation,
          reservation.taskId,
          request.kind
        )
        const settled = yield* Deferred.make<AttemptView>()
        const prepared = yield* Deferred.make<void>()
        const events = yield* Queue.unbounded<ProcessEvent>()
        const job: Job = {
          lifecycle: makeAttemptLifecycle(record),
          prepared,
          settled,
          events,
          executionReleased: false,
        }
        yield* self.admission.withPermit(
          Effect.try({
            try: () => {
              self.assertPreparedUnsafe(
                reservation.sessionId,
                reservation.generation,
                reservation.taskId,
                request.kind
              )
              self.active.set(record.id, job)
              self.latest.set(reservation.taskId, record.id)
            },
            catch: cause => new WorkError({ message: errorMessage(cause), cause }),
          })
        )
        yield* self
          .launch(job, request, cwd, reservation.generation)
          .pipe(Effect.ensuring(Deferred.succeed(prepared, undefined)))
        return viewOf(job.lifecycle.snapshot())
      }).pipe(Effect.ensuring(Effect.sync(() => self.reservations.delete(reservation.taskId))))
      return result
    }).pipe(Effect.uninterruptible, Effect.mapError(toFailure))
  }

  private reserve(
    taskId: string,
    kind: WorkKind
  ): Effect.Effect<
    { readonly generation: GenerationId; readonly sessionId: SessionId; readonly taskId: TaskId },
    WorkFailure
  > {
    // oxlint-disable-next-line typescript/no-this-alias
    const self = this
    return self.admission.withPermit(
      Effect.try({
        try: () => {
          if (process.platform === 'win32')
            throw new Error(
              'Background work currently requires POSIX process observation and signals'
            )
          if (self.state.closed) throw new Error('This work owner has shut down')
          if (kind === 'agent' && self.state.exhausted)
            throw new Error('Subscription exhausted; no new agents may start in this session')
          const typed = asTaskId(requiredString(taskId, 'taskId'))
          if (
            self.reservations.has(typed) ||
            [...self.active.values()].some(job => job.lifecycle.snapshot().owner.taskId === typed)
          ) {
            throw new Error('This task already has an active attempt')
          }
          self.reservations.add(typed)
          return { generation: self.state.generation, sessionId: self.sessionId, taskId: typed }
        },
        catch: cause => new WorkError({ message: errorMessage(cause), cause }),
      })
    )
  }

  private assertPrepared(
    sessionId: SessionId,
    generation: GenerationId,
    taskId: TaskId,
    kind: WorkKind,
    except?: AttemptId
  ): Effect.Effect<void, WorkFailure> {
    // oxlint-disable-next-line typescript/no-this-alias
    const self = this
    return self.admission.withPermit(
      Effect.try({
        try: () => self.assertPreparedUnsafe(sessionId, generation, taskId, kind, except),
        catch: cause => new WorkError({ message: errorMessage(cause), cause }),
      })
    )
  }

  private assertPreparedUnsafe(
    sessionId: SessionId,
    generation: GenerationId,
    taskId: TaskId,
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
    if (
      [...this.active.values()].some(
        job =>
          job.lifecycle.snapshot().id !== except && job.lifecycle.snapshot().owner.taskId === taskId
      )
    ) {
      throw new Error('This task already has an active attempt')
    }
  }

  private withPreparedPermit<A>(
    sessionId: SessionId,
    generation: GenerationId,
    taskId: TaskId,
    kind: WorkKind,
    except: AttemptId,
    effect: Effect.Effect<A, WorkFailure>
  ): Effect.Effect<A, WorkFailure> {
    // oxlint-disable-next-line typescript/no-this-alias
    const self = this
    return self.admission.withPermit(
      Effect.gen(function* () {
        yield* Effect.try({
          try: () => self.assertPreparedUnsafe(sessionId, generation, taskId, kind, except),
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
    // oxlint-disable-next-line typescript/no-this-alias
    const self = this
    return Effect.gen(function* () {
      const outcome = yield* Effect.try({
        try: transition,
        catch: cause => new WorkError({ message: errorMessage(cause), cause }),
      })
      if (outcome.changed) {
        yield* self.store.save(outcome.snapshot)
        if (outcome.resultText !== undefined)
          yield* self.store.saveResult(outcome.snapshot.id, outcome.resultText)
      }
      return outcome
    })
  }

  private commit(
    job: Job,
    transition: () => LifecycleTransition
  ): Effect.Effect<LifecycleTransition, WorkFailure> {
    // oxlint-disable-next-line typescript/no-this-alias
    const self = this
    return self.admission.withPermit(self.commitUnlocked(job, transition))
  }

  private commitCurrent(
    job: Job,
    token: AttemptLifecycle['token'],
    transition: () => LifecycleTransition
  ): Effect.Effect<LifecycleTransition | undefined, WorkFailure> {
    // oxlint-disable-next-line typescript/no-this-alias
    const self = this
    return self.admission.withPermit(
      Effect.gen(function* () {
        if (
          self.state.closed ||
          self.state.generation !== token.generation ||
          !job.lifecycle.isActive() ||
          job.lifecycle.hasResult()
        )
          return undefined
        return yield* self.commitUnlocked(job, transition)
      })
    )
  }

  private notePersistenceFailure(job: Job, cause: unknown): Effect.Effect<void, never> {
    // oxlint-disable-next-line typescript/no-this-alias
    const self = this
    return self.admission.withPermit(
      Effect.sync(() => {
        job.lifecycle.transition.persistenceError(job.lifecycle.token, errorMessage(cause))
      })
    )
  }

  private commitBestEffort(
    job: Job,
    transition: () => LifecycleTransition
  ): Effect.Effect<LifecycleTransition, WorkFailure> {
    // oxlint-disable-next-line typescript/no-this-alias
    const self = this
    return Effect.gen(function* () {
      const result = yield* Effect.result(self.commit(job, transition))
      if (result._tag === 'Success') return result.success
      if (!(result.failure instanceof WorkPersistenceError)) return yield* result.failure
      yield* self.notePersistenceFailure(job, result.failure)
      return {
        accepted: true,
        changed: true,
        snapshot: job.lifecycle.snapshot(),
        state: job.lifecycle.state(),
      }
    })
  }

  private settle(job: Job): Effect.Effect<void, never> {
    return Deferred.succeed(job.settled, viewOf(job.lifecycle.snapshot())).pipe(Effect.ignore)
  }

  private commitCurrentBestEffort(
    job: Job,
    token: AttemptLifecycle['token'],
    transition: () => LifecycleTransition
  ): Effect.Effect<LifecycleTransition | undefined, WorkFailure> {
    // oxlint-disable-next-line typescript/no-this-alias
    const self = this
    return Effect.gen(function* () {
      const result = yield* Effect.result(self.commitCurrent(job, token, transition))
      if (result._tag === 'Success') return result.success
      if (!(result.failure instanceof WorkPersistenceError)) return yield* result.failure
      yield* self.notePersistenceFailure(job, result.failure)
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
    // oxlint-disable-next-line typescript/no-this-alias
    const self = this
    let stdout: number | undefined
    let stderr: number | undefined
    let acquiredLease: { readonly path: string; readonly root: string } | undefined
    const { token } = job.lifecycle
    const launchCore = Effect.gen(function* () {
      const record = job.lifecycle.snapshot()
      if (request.kind === 'agent' && request.access === 'write') {
        yield* self.assertPrepared(
          token.sessionId,
          generation,
          record.owner.taskId,
          request.kind,
          record.id
        )
        const lease = yield* self.writerLease(cwd, record.id)
        acquiredLease = lease
        yield* self.withPreparedPermit(
          token.sessionId,
          generation,
          record.owner.taskId,
          request.kind,
          record.id,
          Effect.gen(function* () {
            job.lease = lease.path
            job.leaseRoot = lease.root
            const outcome = job.lifecycle.transition.setLease(token, lease.root)
            if (outcome.changed) yield* self.store.save(outcome.snapshot)
          })
        )
      }
      yield* self.withPreparedPermit(
        token.sessionId,
        generation,
        record.owner.taskId,
        request.kind,
        record.id,
        Effect.try({
          try: () => {
            stdout = openSync(self.store.logPath(record.id, 'stdout'), 'wx', 0o600)
            stderr = openSync(self.store.logPath(record.id, 'stderr'), 'wx', 0o600)
          },
          catch: cause => new WorkError({ message: errorMessage(cause), cause }),
        })
      )
      const child = yield* self.withPreparedPermit(
        token.sessionId,
        generation,
        record.owner.taskId,
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
                DEV_DATA_HOME: self.dataHome,
                PI_CODING_AGENT_DIR: globalPiAgentDir(),
              },
            }
            const spawned =
              request.kind === 'agent'
                ? fork(new URL('./pi-child.ts', import.meta.url), [], {
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
      yield* self.commit(job, () => job.lifecycle.transition.spawn(token, childPid))
      yield* self.admission.withPermit(
        Effect.gen(function* () {
          yield* Effect.try({
            try: () =>
              self.assertPreparedUnsafe(
                token.sessionId,
                generation,
                record.owner.taskId,
                request.kind,
                record.id
              ),
            catch: cause => new WorkError({ message: errorMessage(cause), cause }),
          })
          const initialTable = yield* processTable
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
          yield* self.commitUnlocked(job, () => job.lifecycle.transition.processes(token, known))
          if (job.gate !== undefined) {
            const { gate } = job
            yield* Effect.try({
              try: () => gate.end('\n'),
              catch: cause => new WorkError({ message: errorMessage(cause), cause }),
            })
            job.gate = undefined
          }
          job.executionReleased = true
        })
      )
      if (request.kind === 'agent')
        yield* self.withPreparedPermit(
          token.sessionId,
          generation,
          record.owner.taskId,
          request.kind,
          record.id,
          Effect.gen(function* () {
            yield* sendIpc(child, {
              type: 'start',
              request: {
                dataHome: self.dataHome,
                cwd,
                specialization: self.specialization,
                sessionDir: join(self.dataHome, 'child-sessions'),
                access: request.access,
                prompt: request.prompt,
                skills: request.skills,
                owner: record.owner,
                model: request.selection?.model,
                effort: request.selection?.effort,
              },
            })
            job.executionReleased = true
          })
        )
      yield* self.withPreparedPermit(
        token.sessionId,
        generation,
        record.owner.taskId,
        request.kind,
        record.id,
        Effect.gen(function* () {
          yield* self.store.save(job.lifecycle.snapshot())
          yield* Effect.forkIn(self.scope)(self.waitForOwnedExit(job))
        })
      )
      self.onChange()
    }).pipe(
      Effect.catch(error => self.failLaunch(job, error, acquiredLease)),
      Effect.ensuring(
        Effect.sync(() => {
          if (stdout !== undefined) closeSync(stdout)
          if (stderr !== undefined) closeSync(stderr)
        })
      )
    )
    return launchCore
  }

  private failLaunch(
    job: Job,
    cause: unknown,
    lease: { readonly path: string; readonly root: string } | undefined
  ): Effect.Effect<never, WorkFailure> {
    // oxlint-disable-next-line typescript/no-this-alias
    const self = this
    return Effect.gen(function* () {
      const { token } = job.lifecycle
      if (!job.executionReleased) {
        const { gate } = job
        job.gate = undefined
        yield* Effect.sync(() => abortChild(job.child, gate))
      }
      if (job.lease === undefined && lease !== undefined) {
        job.lease = lease.path
        job.leaseRoot = lease.root
        yield* self.commitBestEffort(job, () =>
          job.lifecycle.transition.setLease(token, lease.root)
        )
      }
      yield* self.commitBestEffort(job, () =>
        job.lifecycle.transition.processError(token, errorMessage(cause))
      )
      if (job.lifecycle.isActive()) {
        if (job.child === undefined || job.child.pid === undefined) {
          yield* self.commitBestEffort(job, () => job.lifecycle.transition.exit(token, null, null))
          yield* self.finish(job).pipe(Effect.catch(error => self.failObservation(job, error)))
        } else {
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* Effect.forkScoped(self.waitForOwnedExit(job))
              yield* self.cancelJob(job, 'launch failed')
            })
          ).pipe(Effect.catch(error => self.failObservation(job, error)))
        }
      }
      return yield* new WorkError({ message: errorMessage(cause), cause })
    })
  }

  private childMessage(job: Job, raw: unknown): Effect.Effect<void, WorkFailure> {
    // oxlint-disable-next-line typescript/no-this-alias
    const self = this
    const { token } = job.lifecycle
    return Effect.gen(function* () {
      if (
        !job.lifecycle.isActive() ||
        job.lifecycle.hasResult() ||
        token.generation !== self.state.generation
      )
        return
      const record = job.lifecycle.snapshot()
      const message = yield* parseChildMessage(raw, {
        cwd: record.cwd,
        sessionDir: join(self.dataHome, 'child-sessions'),
      }).pipe(Effect.mapError(toFailure))
      if (message.type === 'ready' || message.type === 'progress') {
        const outcome = yield* self.commitCurrentBestEffort(job, token, () =>
          job.lifecycle.transition.progress(token, {
            ...(message.model === undefined ? {} : { model: message.model }),
            ...(message.effort === undefined ? {} : { effort: message.effort }),
            ...(message.sessionFile === undefined ? {} : { sessionFile: message.sessionFile }),
            ...(message.resources === undefined ? {} : { resources: message.resources }),
            ...(message.context === undefined ? {} : { context: message.context }),
            ...(message.usage === undefined ? {} : { usage: message.usage }),
          })
        )
        if (outcome !== undefined) self.onChange()
      } else {
        const outcome = yield* self.commitCurrentBestEffort(job, token, () =>
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
        if (outcome.accepted && (outcome.quotaExhausted || quotaExhausted(message.error)))
          yield* self.exhaust(record.id)
        self.onChange()
      }
    }).pipe(
      Effect.catch(error =>
        Effect.gen(function* () {
          const message = errorMessage(error)
          const outcome = yield* self.commitCurrentBestEffort(job, token, () =>
            error instanceof WorkProtocolError
              ? job.lifecycle.transition.rejectedMessage(token, message)
              : job.lifecycle.transition.persistenceError(token, message)
          )
          if (outcome !== undefined) yield* self.cancelJob(job, 'invalid child message')
        })
      )
    )
  }

  private waitForOwnedExit(job: Job): Effect.Effect<void, WorkFailure> {
    // oxlint-disable-next-line typescript/no-this-alias
    const self = this
    const { token } = job.lifecycle
    return Effect.whileLoop({
      while: () => job.lifecycle.isActive(),
      body: () =>
        Effect.gen(function* () {
          if (!job.lifecycle.hasExited()) {
            const event = yield* Queue.take(job.events)
            if (event.type === 'message') yield* self.childMessage(job, event.raw)
            else if (event.type === 'error')
              yield* self.commitBestEffort(job, () =>
                job.lifecycle.transition.processError(token, event.message)
              )
            else if (event.type === 'exit')
              yield* self.commitBestEffort(job, () =>
                job.lifecycle.transition.exit(token, event.code, event.signal)
              )
            else if (event.type === 'close' || job.lifecycle.pid() === undefined)
              yield* self.commitBestEffort(job, () =>
                job.lifecycle.transition.exit(token, null, null)
              )
            return
          }
          const pending = yield* Queue.poll(job.events)
          if (pending._tag === 'Some') {
            const event = pending.value
            if (event.type === 'message') yield* self.childMessage(job, event.raw)
            else if (event.type === 'error')
              yield* self.commitBestEffort(job, () =>
                job.lifecycle.transition.processError(token, event.message)
              )
            return
          }
          const table = yield* processTable
          const root = job.lifecycle.rootProcess()
          if (rootIdentityReused(table, root, hasProcessExitEvidence(job))) {
            yield* self.failObservation(
              job,
              new Error('Root process identity was reused; cleanup is unknown')
            )
            return
          }
          const known = ownedProcesses(
            table,
            job.lifecycle.pid(),
            job.lifecycle.knownProcesses(),
            root
          )
          yield* self.commitBestEffort(job, () => job.lifecycle.transition.processes(token, known))
          if (known.length === 0) {
            yield* self.finish(job)
            return
          }
          yield* self.commitBestEffort(job, () => job.lifecycle.transition.waiting(token))
          self.onChange()
          yield* Effect.sleep(Duration.millis(500))
        }),
      step: () => undefined,
    }).pipe(
      Effect.asVoid,
      Effect.catch(error => self.failObservation(job, error))
    )
  }

  private failObservation(job: Job, cause: unknown): Effect.Effect<void, never> {
    // oxlint-disable-next-line typescript/no-this-alias
    const self = this
    const { token } = job.lifecycle
    return Effect.gen(function* () {
      if (job.lifecycle.isTerminal()) {
        if (cause instanceof WorkPersistenceError) yield* self.notePersistenceFailure(job, cause)
        yield* Queue.shutdown(job.events).pipe(Effect.ignore)
        yield* self.settle(job)
        self.onChange()
        return
      }
      if (job.lifecycle.isUnknown()) {
        yield* self.settle(job)
        return
      }
      const outcome = yield* Effect.result(
        self.commit(job, () =>
          job.lifecycle.transition.unknown(
            token,
            `Process observation unavailable: ${errorMessage(cause)}`
          )
        )
      )
      if (outcome._tag === 'Failure') yield* self.notePersistenceFailure(job, outcome.failure)
      yield* self.settle(job)
      self.onChange()
    })
  }

  private finish(job: Job): Effect.Effect<void, WorkFailure> {
    // oxlint-disable-next-line typescript/no-this-alias
    const self = this
    const { token } = job.lifecycle
    return Effect.gen(function* () {
      if (!job.lifecycle.isActive()) return
      const record = job.lifecycle.snapshot()
      let cleanupError: string | undefined
      const { lease } = job
      if (lease !== undefined) {
        const expectedRoot = job.leaseRoot ?? record.worktreePath
        const expectedOwner =
          expectedRoot === undefined
            ? undefined
            : {
                id: record.id,
                controllerPid: record.controllerPid,
                cwd: expectedRoot,
                sessionId: self.sessionId,
              }
        const releaseError = yield* releaseWriterLease(self.fs, lease, expectedOwner)
        if (releaseError !== undefined) cleanupError = releaseError
      }
      const completedAt = yield* Clock.currentTimeMillis
      const artifactAtCompletion = yield* artifactState(record.cwd)
      const changedDuringRun = changedArtifact(record.artifactAtStart, artifactAtCompletion)
      const saved = yield* Effect.result(
        self.commit(job, () =>
          job.lifecycle.transition.complete(token, {
            artifactAtCompletion,
            changedDuringRun,
            completedAt,
            ...(cleanupError === undefined ? {} : { cleanupError }),
          })
        )
      )
      if (saved._tag === 'Failure') {
        yield* self.failObservation(job, saved.failure)
        return
      }
      if (!saved.success.accepted || !saved.success.changed) {
        yield* self.settle(job)
        return
      }
      yield* Queue.shutdown(job.events).pipe(Effect.ignore)
      self.active.delete(saved.success.snapshot.id)
      const completed = viewOf(job.lifecycle.snapshot())
      yield* self.settle(job)
      self.onChange()
      if (self.canDeliverUnsafe(completed)) self.onOutcome(completed)
    })
  }

  private canDeliverUnsafe(attempt: AttemptView): boolean {
    return (
      !this.state.closed &&
      attempt.owner.sessionId === this.sessionId &&
      attempt.completedAt !== undefined &&
      attempt.owner.generation === this.state.generation &&
      this.latest.get(attempt.owner.taskId) === attempt.id
    )
  }

  private cancelJob(job: Job, reason: string): Effect.Effect<AttemptView, WorkFailure> {
    // oxlint-disable-next-line typescript/no-this-alias
    const self = this
    const { token } = job.lifecycle
    return Effect.gen(function* () {
      const requestedAt = yield* Clock.currentTimeMillis
      yield* self.commitBestEffort(job, () =>
        job.lifecycle.transition.cancel(token, requestedAt, reason)
      )
      if (!job.lifecycle.isActive()) return yield* Deferred.await(job.settled)
      if (job.child === undefined) {
        yield* self.failObservation(job, new Error('Cancellation raced with launch setup'))
        return yield* Deferred.await(job.settled)
      }
      if (job.child.connected) {
        const ipc = yield* Effect.result(sendIpc(job.child, { type: 'cancel' }))
        if (ipc._tag === 'Failure')
          yield* self.commitBestEffort(job, () =>
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
          yield* self.commitBestEffort(job, () => job.lifecycle.transition.processes(token, known))
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
        yield* self.commitBestEffort(job, () =>
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
            yield* self.commitBestEffort(job, () =>
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
            yield* self.commitBestEffort(job, () =>
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
            yield* self.commitBestEffort(job, () =>
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
            const finished = yield* Effect.result(self.finish(job))
            if (finished._tag === 'Failure') yield* self.failObservation(job, finished.failure)
          }
        } else {
          known = []
          observationError = `${observationError ?? 'Cancellation requested'} process table unavailable during final cleanup: ${errorMessage(finalTable.failure)}`
        }
      }
      if (job.lifecycle.isActive())
        yield* self.failObservation(
          job,
          new Error(observationError ?? 'Cancellation requested but termination is not confirmed')
        )
      return yield* Deferred.await(job.settled)
    })
  }

  private writerLease(
    cwd: string,
    id: AttemptId
  ): Effect.Effect<{ readonly path: string; readonly root: string }, WorkFailure> {
    // oxlint-disable-next-line typescript/no-this-alias
    const self = this
    return Effect.gen(function* () {
      const [root, common, primary, gitDir, leadRoot] = yield* Effect.all([
        git(cwd, ['rev-parse', '--show-toplevel']),
        git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
        git(self.cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
        git(cwd, ['rev-parse', '--absolute-git-dir']),
        git(self.cwd, ['rev-parse', '--show-toplevel']),
      ])
      const worktreeRoot = yield* self.fs.realPath(root)
      const primaryRoot = yield* self.fs.realPath(leadRoot)
      const commonRoot = yield* self.fs.realPath(common)
      const primaryCommon = yield* self.fs.realPath(primary)
      const absoluteGitDir = yield* self.fs.realPath(gitDir)
      if (
        worktreeRoot === primaryRoot ||
        commonRoot !== primaryCommon ||
        absoluteGitDir === commonRoot
      ) {
        return yield* new WorkError({
          message:
            'A writer needs a separate linked worktree of the lead repository, never its primary checkout',
        })
      }
      const directory = join(self.dataHome, 'work', 'writers')
      yield* self.fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
      yield* self.fs.chmod(directory, 0o700)
      const path = join(
        directory,
        `${createHash('sha256').update(worktreeRoot).digest('hex')}.lock`
      )
      yield* self.fs.writeFileString(
        path,
        JSON.stringify({ id, controllerPid: process.pid, cwd: root, sessionId: self.sessionId }),
        { flag: 'wx', mode: 0o600 }
      )
      return { path, root: worktreeRoot }
    }).pipe(Effect.mapError(cause => new WorkError({ message: errorMessage(cause), cause })))
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
