import * as NodeWorker from '@effect/platform-node/NodeWorker'
import {
  ByteSize,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Schema,
} from 'effect'
import type * as Scope from 'effect/Scope'
import { Worker as EffectWorker } from 'effect/workers'
import { constants } from 'node:fs'
import { lstat, mkdir, open as openNative, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import {
  WorkPersistenceError,
  decodeAttemptRecord,
  isAttemptId,
  type AttemptId,
  type AttemptRecord,
  type OwnerIdentity,
  type SessionId,
} from './work-domain.ts'
import {
  decodeListValue,
  decodeWorkerMessage,
  type RpcEnvelope,
  type RpcInput,
  type RpcSuccess,
} from './work-store-protocol.ts'

const LOG_FILES = { stdout: 'stdout.log', stderr: 'stderr.log', result: 'result.txt' } as const
const LOG_FILE_NAMES = new Set<string>(Object.values(LOG_FILES))
const RPC_TIMEOUT_MS = 12000
const STARTUP_TIMEOUT_MS = 12000
const EXIT_TIMEOUT_MS = 1000

type LogStream = keyof typeof LOG_FILES
type AttemptRecordCreateFields = Pick<AttemptRecord, 'kind' | 'cwd' | 'controllerPid'> &
  Partial<
    Pick<
      AttemptRecord,
      | 'completedAt'
      | 'pid'
      | 'access'
      | 'coordinator'
      | 'selection'
      | 'worktreePath'
      | 'workflowTaskId'
      | 'workspaceId'
      | 'workspaceUseId'
      | 'workspaceAcquisitionId'
      | 'artifactAtStart'
      | 'artifactAtCompletion'
      | 'changedDuringRun'
      | 'exitCode'
      | 'signal'
      | 'cancelRequestedAt'
      | 'cancelReason'
      | 'error'
      | 'observationError'
      | 'persistenceError'
      | 'cleanupError'
      | 'gateReleaseWarning'
      | 'deliveryError'
      | 'protocolError'
      | 'processObservation'
      | 'recovery'
      | 'model'
      | 'effort'
      | 'sessionFile'
      | 'resources'
      | 'context'
      | 'usage'
    >
  >

export const compactText = (text: string, limit = 6000): string =>
  text.length <= limit ? text : `${text.slice(0, limit)}\n[truncated; full output is retained]`

class StorePreparationError extends Schema.TaggedError<StorePreparationError>()(
  'StorePreparationError',
  { code: Schema.String }
) {}

class WorkerRpcError extends Schema.TaggedError<WorkerRpcError>()('WorkerRpcError', {
  code: Schema.String,
}) {}

const rpcError = (code: string): WorkerRpcError => new WorkerRpcError({ code })

const codeOf = (cause: unknown): string | undefined => {
  if (!(cause instanceof Error) || !('code' in cause)) return undefined
  const { code } = cause
  return typeof code === 'string' ? code : undefined
}

export const isRecordUnavailable = (error: WorkPersistenceError): boolean =>
  error.code === 'record-unavailable'

const persistenceMessage = (code: string): string => {
  if (code === 'unsupported-format') return 'Work store format is unsupported'
  if (code === 'corrupt-database') return 'Work store database is corrupt'
  if (code === 'unsafe-path') return 'Work store path is unsafe'
  if (code === 'unsafe-sqlite') return 'Installed SQLite runtime is unsafe for WAL storage'
  if (code === 'revision-conflict') return 'Work record revision conflict'
  if (code === 'owner-conflict') return 'Work record ownership conflict'
  if (code === 'record-unavailable') return 'Work record is unavailable'
  if (code === 'invalid-record') return 'Work record is invalid'
  if (code === 'session-mismatch') return 'Work store session mismatch'
  if (code === 'worker-closed') return 'Work store worker is closed'
  if (code === 'worker-protocol') return 'Work store worker protocol failed'
  return 'Work store operation failed'
}

const persistenceError = (cause: unknown): WorkPersistenceError => {
  const code =
    cause instanceof StorePreparationError || cause instanceof WorkerRpcError
      ? cause.code
      : (codeOf(cause) ?? 'persistence-failed')
  return new WorkPersistenceError({ code, message: persistenceMessage(code) })
}

const safeRecord = (value: unknown): AttemptRecord => {
  try {
    return decodeAttemptRecord(value)
  } catch {
    throw new StorePreparationError({ code: 'invalid-record' })
  }
}

const optionalLstat = async (
  path: string
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> => {
  try {
    return await lstat(path)
  } catch (cause) {
    if (codeOf(cause) === 'ENOENT') return undefined
    throw new StorePreparationError({ code: 'unsafe-path' })
  }
}

const ensureDirectory = async (path: string): Promise<void> => {
  let info = await optionalLstat(path)
  if (info === undefined) {
    try {
      await mkdir(path, { recursive: true, mode: 0o700 })
    } catch {
      throw new StorePreparationError({ code: 'unsafe-path' })
    }
    info = await optionalLstat(path)
  }
  if (info === undefined || info.isSymbolicLink() || !info.isDirectory())
    throw new StorePreparationError({ code: 'unsafe-path' })
}

const openManagedPath = async (
  path: string,
  directory: boolean,
  optional = false
): Promise<
  { readonly handle: Awaited<ReturnType<typeof openNative>>; readonly mode: number } | undefined
> => {
  let handle: Awaited<ReturnType<typeof openNative>> | undefined
  try {
    const flags =
      constants.O_RDONLY | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : 0)
    handle = await openNative(path, flags)
    const info = await handle.stat()
    if ((directory && !info.isDirectory()) || (!directory && !info.isFile()))
      throw new StorePreparationError({ code: 'unsafe-path' })
    return { handle, mode: directory ? 0o700 : 0o600 }
  } catch (cause) {
    try {
      await handle?.close()
    } catch {
      throw new StorePreparationError({ code: 'unsafe-path' })
    }
    if (cause instanceof StorePreparationError) throw cause
    if (optional && codeOf(cause) === 'ENOENT') return undefined
    throw new StorePreparationError({ code: 'unsafe-path' })
  }
}

const inspectLayout = async (root: string, databasePath: string): Promise<void> => {
  const rootInfo = await optionalLstat(root)
  if (rootInfo === undefined || rootInfo.isSymbolicLink() || !rootInfo.isDirectory())
    throw new StorePreparationError({ code: 'unsafe-path' })
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    throw new StorePreparationError({ code: 'unsafe-path' })
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new StorePreparationError({ code: 'unsafe-path' })
    if (!entry.isDirectory() || !isAttemptId(entry.name))
      throw new StorePreparationError({ code: 'unsupported-format' })
    const directory = join(root, entry.name)
    let children
    try {
      children = await readdir(directory, { withFileTypes: true })
    } catch {
      throw new StorePreparationError({ code: 'unsafe-path' })
    }
    for (const child of children) {
      if (child.isSymbolicLink()) throw new StorePreparationError({ code: 'unsafe-path' })
      if (!child.isFile() || !LOG_FILE_NAMES.has(child.name))
        throw new StorePreparationError({ code: 'unsupported-format' })
    }
  }
  for (const path of [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
    `${databasePath}-journal`,
  ]) {
    const info = await optionalLstat(path)
    if (info !== undefined && (info.isSymbolicLink() || !info.isFile()))
      throw new StorePreparationError({ code: 'unsafe-path' })
  }
}

const preparePersistence = async (
  dataHome: string
): Promise<{
  readonly home: string
  readonly root: string
  readonly databasePath: string
  readonly work: string
}> => {
  const home = resolve(dataHome)
  const work = join(home, 'work')
  const root = join(work, 'attempts')
  const databasePath = join(home, 'work', 'attempts.sqlite')
  await ensureDirectory(home)
  await ensureDirectory(work)
  await ensureDirectory(root)
  await inspectLayout(root, databasePath)
  return { home, root, databasePath, work }
}

const repairPersistenceModes = async (paths: {
  readonly home: string
  readonly root: string
  readonly databasePath: string
  readonly work: string
}): Promise<void> => {
  await inspectLayout(paths.root, paths.databasePath)
  const managed: {
    readonly handle: Awaited<ReturnType<typeof openNative>>
    readonly mode: number
  }[] = []
  const add = async (path: string, directory: boolean, optional = false): Promise<void> => {
    const managedPath = await openManagedPath(path, directory, optional)
    if (managedPath !== undefined) managed.push(managedPath)
  }
  try {
    await add(paths.home, true)
    await add(paths.work, true)
    await add(paths.root, true)
    const entries = await readdir(paths.root, { withFileTypes: true })
    for (const entry of entries) {
      const directory = join(paths.root, entry.name)
      await add(directory, true)
      const children = await readdir(directory, { withFileTypes: true })
      for (const child of children) await add(join(directory, child.name), false)
    }
    await add(paths.databasePath, false, true)
    for (const sidecar of [
      `${paths.databasePath}-wal`,
      `${paths.databasePath}-shm`,
      `${paths.databasePath}-journal`,
    ])
      await add(sidecar, false, true)
    await inspectLayout(paths.root, paths.databasePath)
    for (const item of managed) await item.handle.chmod(item.mode)
  } finally {
    for (const item of managed) {
      try {
        await item.handle.close()
      } catch {
        continue
      }
    }
  }
}

const makeRecordDirectory = async (root: string, id: AttemptId): Promise<void> => {
  const path = join(root, id)
  const existing = await optionalLstat(path)
  if (existing !== undefined) throw new StorePreparationError({ code: 'owner-conflict' })
  try {
    await mkdir(path, { mode: 0o700 })
    const managed = await openManagedPath(path, true)
    if (managed === undefined) throw new StorePreparationError({ code: 'unsafe-path' })
    try {
      await managed.handle.chmod(managed.mode)
    } finally {
      await managed.handle.close()
    }
  } catch {
    throw new StorePreparationError({ code: 'unsafe-path' })
  }
}

const removeDirectory = async (root: string, id: AttemptId): Promise<void> => {
  const path = join(root, id)
  const info = await optionalLstat(path)
  if (info === undefined) return
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new StorePreparationError({ code: 'unsafe-path' })
  try {
    await rm(path, { recursive: true, force: true })
  } catch {
    throw new StorePreparationError({ code: 'unsafe-path' })
  }
  if ((await optionalLstat(path)) !== undefined)
    throw new StorePreparationError({ code: 'unsafe-path' })
}

type WorkerPhase = 'starting' | 'ready' | 'closing' | 'closed' | 'failed'

interface StoreWorker {
  readonly request: (input: RpcInput) => Effect.Effect<RpcSuccess, WorkerRpcError>
}

const openStoreWorker = Effect.fnUntraced(function* (
  root: string,
  databasePath: string,
  sessionId: SessionId
): Effect.fn.Return<StoreWorker, WorkerRpcError, Scope.Scope> {
  const pending = new Map<number, Deferred.Deferred<RpcSuccess, WorkerRpcError>>()
  const ready = yield* Deferred.make<void, WorkerRpcError>()
  let phase: WorkerPhase = 'starting'
  let nextId = 0
  let thread: Worker | undefined

  const currentPhase = (): WorkerPhase => phase

  const fail = (cause: WorkerRpcError): void => {
    if (phase === 'closed' || phase === 'failed') return
    const wasStarting = phase === 'starting'
    phase = 'failed'
    if (wasStarting) Deferred.doneUnsafe(ready, Exit.fail(cause))
    for (const result of pending.values()) Deferred.doneUnsafe(result, Exit.fail(cause))
    pending.clear()
    void thread?.terminate()
  }

  const receive = (raw: unknown): Effect.Effect<void> =>
    Effect.sync(() => {
      const decoded = decodeWorkerMessage(raw)
      if (Option.isNone(decoded)) return fail(rpcError('worker-protocol'))
      const message = decoded.value
      if ('type' in message) {
        if (message.type === 'startup-error') return fail(rpcError(message.code))
        if (phase !== 'starting') return
        phase = 'ready'
        Deferred.doneUnsafe(ready, Exit.void)
        return
      }
      const result = pending.get(message.id)
      if (result === undefined) return
      pending.delete(message.id)
      Deferred.doneUnsafe(
        result,
        message.ok ? Exit.succeed(message) : Exit.fail(rpcError(message.code))
      )
    })

  const worker = yield* Effect.gen(function* () {
    const platform = yield* EffectWorker.WorkerPlatform
    return yield* platform.spawn<unknown, RpcEnvelope>(0)
  }).pipe(
    Effect.provide(
      NodeWorker.layer(() => {
        thread = new Worker(new URL('./work-store-worker.ts', import.meta.url), {
          workerData: { root, databasePath, sessionId },
        })
        return thread
      })
    ),
    Effect.mapError(() => rpcError('worker-unavailable'))
  )

  const running = yield* worker.run(receive).pipe(
    Effect.onExit(() =>
      Effect.sync(() => {
        if (phase !== 'closing' && phase !== 'closed') fail(rpcError('worker-unavailable'))
        phase = 'closed'
      })
    ),
    Effect.forkScoped
  )

  yield* Deferred.await(ready).pipe(
    Effect.timeoutOrElse({
      duration: STARTUP_TIMEOUT_MS,
      orElse: () => {
        const cause = rpcError('worker-unavailable')
        fail(cause)
        return Effect.fail(cause)
      },
    }),
    Effect.tapError(() => Fiber.await(running))
  )

  const request = (input: RpcInput): Effect.Effect<RpcSuccess, WorkerRpcError> =>
    Effect.suspend(() => {
      if (phase !== 'ready') return Effect.fail(rpcError('worker-closed'))
      nextId += 1
      const id = nextId
      const result = Deferred.makeUnsafe<RpcSuccess, WorkerRpcError>()
      pending.set(id, result)
      return worker.send({ id, request: { ...input, id } }).pipe(
        Effect.mapError(() => rpcError('worker-unavailable')),
        Effect.andThen(Deferred.await(result)),
        Effect.timeoutOrElse({
          duration: RPC_TIMEOUT_MS,
          orElse: () => Effect.fail(rpcError('worker-unavailable')),
        }),
        Effect.ensuring(Effect.sync(() => pending.delete(id)))
      )
    })

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      if (phase === 'closed') return
      if (phase === 'failed') {
        yield* Fiber.await(running)
        return
      }
      yield* Effect.ignore(request({ op: 'close', sessionId }))
      phase = 'closing'
      yield* Fiber.await(running).pipe(Effect.timeoutOption(EXIT_TIMEOUT_MS))
      if (currentPhase() !== 'closing') return
      yield* Effect.promise(async () => thread?.terminate())
      phase = 'closed'
    })
  )

  return { request }
})

type AttemptRecordCreate = AttemptRecordCreateFields & {
  readonly owner: Omit<OwnerIdentity, 'attemptId'> & { readonly attemptId?: never }
}

interface LogRead {
  readonly available: boolean
  readonly path: string
  readonly reason?: string
  readonly offset?: number
  readonly nextOffset?: number
  readonly size?: number
  readonly truncated?: boolean
  readonly text?: string
}

export class WorkStore extends Context.Service<
  WorkStore,
  {
    readonly create: (
      id: AttemptId,
      fields: AttemptRecordCreate
    ) => Effect.Effect<AttemptRecord, WorkPersistenceError>
    readonly save: (record: AttemptRecord) => Effect.Effect<void, WorkPersistenceError>
    readonly read: (id: AttemptId) => Effect.Effect<AttemptRecord, WorkPersistenceError>
    readonly list: Effect.Effect<
      {
        readonly records: readonly AttemptRecord[]
        readonly unavailable: readonly { readonly id: string; readonly error: string }[]
      },
      WorkPersistenceError
    >
    readonly plannedLogPath: (id: AttemptId, stream: LogStream) => string
    readonly logPath: (id: AttemptId, stream: LogStream) => string
    readonly saveResult: (id: AttemptId, text: string) => Effect.Effect<void, WorkPersistenceError>
    readonly readLog: (
      id: AttemptId,
      stream: LogStream,
      offset?: number,
      limit?: number
    ) => Effect.Effect<LogRead, WorkPersistenceError>
  }
>()('dev/work/WorkStore') {
  static readonly layer = (
    dataHome: string,
    sessionId: SessionId
  ): Layer.Layer<WorkStore, WorkPersistenceError, FileSystem.FileSystem> =>
    Layer.effect(
      WorkStore,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const paths = yield* Effect.tryPromise({
          try: () => preparePersistence(dataHome),
          catch: cause => persistenceError(cause),
        })
        const worker = yield* openStoreWorker(paths.root, paths.databasePath, sessionId).pipe(
          Effect.mapError(persistenceError)
        )
        yield* Effect.tryPromise({
          try: () => repairPersistenceModes(paths),
          catch: cause => persistenceError(cause),
        })
        const { root } = paths
        const authorized = new Set<AttemptId>()

        const removeRecordDirectory = (id: AttemptId): Effect.Effect<void, WorkPersistenceError> =>
          Effect.tryPromise({
            try: () => removeDirectory(root, id),
            catch: cause => persistenceError(cause),
          })

        const postCommitCleanup = Effect.fnUntraced(function* (
          response: RpcSuccess
        ): Effect.fn.Return<void, WorkPersistenceError> {
          if (response.cleanup.length === 0) return
          const acknowledged: AttemptId[] = []
          for (const id of response.cleanup) {
            yield* removeRecordDirectory(id)
            authorized.delete(id)
            acknowledged.push(id)
          }
          yield* worker
            .request({ op: 'ack', sessionId, attemptIds: acknowledged })
            .pipe(Effect.mapError(persistenceError))
        })

        const call = (input: RpcInput): Effect.Effect<unknown, WorkPersistenceError> =>
          worker.request(input).pipe(
            Effect.mapError(persistenceError),
            Effect.flatMap(response => postCommitCleanup(response).pipe(Effect.as(response.value)))
          )

        const lstatPath = (
          path: string
        ): Effect.Effect<Awaited<ReturnType<typeof lstat>> | undefined, WorkPersistenceError> =>
          Effect.tryPromise({
            try: () => optionalLstat(path),
            catch: cause => persistenceError(cause),
          })

        const writeLog = Effect.fnUntraced(
          function* (id: AttemptId, path: string, text: string) {
            const directory = yield* lstatPath(join(root, id))
            if (directory === undefined || directory.isSymbolicLink() || !directory.isDirectory())
              return yield* persistenceError(new WorkerRpcError({ code: 'unsafe-path' }))
            const existing = yield* lstatPath(path)
            if (existing !== undefined && (existing.isSymbolicLink() || !existing.isFile()))
              return yield* persistenceError(new WorkerRpcError({ code: 'unsafe-path' }))
            yield* fs.writeFileString(path, text, { flag: 'w', mode: 0o600 })
            yield* fs.chmod(path, 0o600)
          },
          Effect.mapError(cause =>
            cause instanceof WorkPersistenceError
              ? cause
              : persistenceError(new WorkerRpcError({ code: 'persistence-failed' }))
          )
        )

        const removeLog = (path: string): Effect.Effect<void, WorkPersistenceError> =>
          fs.remove(path, { force: true }).pipe(
            Effect.asVoid,
            Effect.mapError(() => persistenceError(new WorkerRpcError({ code: 'unsafe-path' })))
          )

        const create = (
          id: AttemptId,
          fields: AttemptRecordCreate
        ): Effect.Effect<AttemptRecord, WorkPersistenceError> => {
          let snapshot: typeof fields
          try {
            snapshot = structuredClone(fields)
          } catch {
            return Effect.fail(
              persistenceError(new StorePreparationError({ code: 'invalid-record' }))
            )
          }
          return Effect.gen(function* () {
            if (snapshot.owner.sessionId !== sessionId)
              return yield* persistenceError(new WorkerRpcError({ code: 'session-mismatch' }))
            const startedAt = yield* Clock.currentTimeMillis
            const record = yield* Effect.try({
              try: () =>
                safeRecord({
                  ...snapshot,
                  owner: { ...snapshot.owner, attemptId: id },
                  revision: 0,
                  id,
                  startedAt,
                  status: 'waiting',
                }),
              catch: cause => persistenceError(cause),
            })
            yield* Effect.tryPromise({
              try: () => makeRecordDirectory(root, id),
              catch: cause => persistenceError(cause),
            })
            yield* call({ op: 'create', sessionId, now: startedAt, record })
            authorized.add(id)
            return record
          })
        }

        const save = (record: AttemptRecord): Effect.Effect<void, WorkPersistenceError> => {
          let snapshot: AttemptRecord
          try {
            snapshot = safeRecord(record)
          } catch (cause) {
            return Effect.fail(persistenceError(cause))
          }
          return Clock.currentTimeMillis.pipe(
            Effect.flatMap(now =>
              call({ op: 'save', sessionId, now, record: snapshot }).pipe(Effect.asVoid)
            )
          )
        }

        const read = (id: AttemptId): Effect.Effect<AttemptRecord, WorkPersistenceError> => {
          if (!isAttemptId(id))
            return Effect.fail(persistenceError(new WorkerRpcError({ code: 'record-unavailable' })))
          return Clock.currentTimeMillis.pipe(
            Effect.flatMap(now =>
              call({ op: 'read', sessionId, now, attemptId: id }).pipe(
                Effect.flatMap(value =>
                  Effect.try({
                    try: () => {
                      const record = safeRecord(value)
                      authorized.add(record.id)
                      return record
                    },
                    catch: cause => persistenceError(cause),
                  })
                )
              )
            )
          )
        }

        const list = Clock.currentTimeMillis.pipe(
          Effect.flatMap(now =>
            call({ op: 'list', sessionId, now }).pipe(
              Effect.flatMap(value =>
                Effect.try({
                  try: () => {
                    const listed = decodeListValue(value)
                    for (const record of listed.records) authorized.add(record.id)
                    return listed
                  },
                  catch: cause => persistenceError(cause),
                })
              )
            )
          )
        )

        const plannedLogPath = (id: AttemptId, stream: LogStream): string => {
          if (!isAttemptId(id) || !Object.hasOwn(LOG_FILES, stream))
            throw new Error('Choose a valid attempt and log stream')
          return join(root, id, LOG_FILES[stream])
        }

        const logPath = (id: AttemptId, stream: LogStream): string => {
          if (!authorized.has(id)) throw new Error('Choose a valid attempt and log stream')
          return plannedLogPath(id, stream)
        }

        const saveResult = Effect.fnUntraced(function* (
          id: AttemptId,
          text: string
        ): Effect.fn.Return<void, WorkPersistenceError> {
          yield* read(id)
          const path = logPath(id, 'result')
          yield* writeLog(id, path, text)
          const checked = yield* Effect.exit(read(id))
          if (Exit.isFailure(checked)) {
            yield* removeLog(path).pipe(Effect.ignore)
            return yield* Effect.failCause(checked.cause)
          }
        })

        const readLog = Effect.fnUntraced(
          function* (id: AttemptId, stream: LogStream = 'stdout', offset?: number, limit = 12000) {
            if (
              (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) ||
              !Number.isSafeInteger(limit) ||
              limit < 1 ||
              limit > 64000
            )
              return yield* persistenceError(new WorkerRpcError({ code: 'invalid-record' }))
            yield* read(id)
            const path = logPath(id, stream)
            const directory = yield* lstatPath(join(root, id))
            if (directory === undefined || directory.isSymbolicLink() || !directory.isDirectory())
              return yield* persistenceError(new WorkerRpcError({ code: 'unsafe-path' }))
            const info = yield* lstatPath(path)
            if (info === undefined)
              return { available: false, path, reason: 'Log unavailable or expired' }
            if (info.isSymbolicLink() || !info.isFile())
              return yield* persistenceError(new WorkerRpcError({ code: 'unsafe-path' }))
            yield* fs.chmod(path, 0o600)
            const file = yield* fs.open(path, { flag: 'r' })
            const size = Number(ByteSize.toBigInt((yield* file.stat).size))
            if (!Number.isSafeInteger(size))
              return yield* persistenceError(new WorkerRpcError({ code: 'invalid-record' }))
            const start = offset ?? Math.max(0, size - limit)
            yield* file.seek(BigInt(start), 'start')
            const buffer = new Uint8Array(Math.min(limit, Math.max(0, size - start)))
            const bytes = yield* file.read(buffer)
            const chunk = buffer.subarray(0, bytes)
            return {
              available: true,
              path,
              offset: start,
              nextOffset: start + chunk.byteLength,
              size,
              truncated: start > 0 || start + chunk.byteLength < size,
              text: Buffer.from(chunk).toString('utf8'),
            }
          },
          Effect.scoped,
          Effect.mapError(cause =>
            cause instanceof WorkPersistenceError
              ? cause
              : persistenceError(new WorkerRpcError({ code: 'persistence-failed' }))
          )
        )

        return WorkStore.of({
          create,
          save,
          read,
          list,
          plannedLogPath,
          logPath,
          saveResult,
          readLog,
        })
      }).pipe(Effect.uninterruptible)
    )
}
