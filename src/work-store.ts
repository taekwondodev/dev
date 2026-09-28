import { ByteSize, Clock, Effect, FileSystem, Schema } from 'effect'
import type * as Scope from 'effect/Scope'
import { constants } from 'node:fs'
import { lstat, mkdir, open as openNative, readdir, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import {
  WorkPersistenceError,
  AttemptRecordSchema,
  isAttemptId,
  type AttemptId,
  type AttemptRecord,
  type OwnerIdentity,
  type SessionId,
} from './work-domain.ts'
import {
  decodeListValue,
  decodeWorkerMessage,
  type ReadyMessage,
  type RpcInput,
  type RpcSuccess,
} from './work-store-protocol.ts'

const LOG_FILES = { stdout: 'stdout.log', stderr: 'stderr.log', result: 'result.txt' } as const
const LOG_FILE_NAMES = new Set<string>(Object.values(LOG_FILES))
const RPC_TIMEOUT_MS = 12000
const STARTUP_TIMEOUT_MS = 12000

type LogStream = keyof typeof LOG_FILES
type AttemptRecordCreateFields = Pick<AttemptRecord, 'kind' | 'cwd' | 'controllerPid'> &
  Partial<
    Pick<
      AttemptRecord,
      | 'completedAt'
      | 'pid'
      | 'access'
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

class StorePreparationError extends Error {
  readonly code: string

  constructor(code: string) {
    super()
    this.name = 'StorePreparationError'
    this.code = code
  }
}

class WorkerRpcError extends Error {
  readonly code: string

  constructor(code: string) {
    super()
    this.name = 'WorkerRpcError'
    this.code = code
  }
}

const codeOf = (cause: unknown): string | undefined => {
  if (!(cause instanceof Error) || !('code' in cause)) return undefined
  const { code } = cause
  return typeof code === 'string' ? code : undefined
}

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
  return new WorkPersistenceError({ message: persistenceMessage(code) })
}

const safeRecord = (value: unknown): AttemptRecord => {
  let record: AttemptRecord
  try {
    record = Schema.decodeUnknownSync(AttemptRecordSchema)(value)
  } catch {
    throw new StorePreparationError('invalid-record')
  }
  if (
    record.id !== record.owner.attemptId ||
    (record.worktreePath !== undefined &&
      (!isAbsolute(record.worktreePath) ||
        record.workspaceId === undefined ||
        record.workspaceUseId === undefined)) ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 0 ||
    !Number.isFinite(record.startedAt) ||
    (record.completedAt !== undefined && !Number.isFinite(record.completedAt)) ||
    ['completed', 'failed', 'cancelled'].includes(record.status) !==
      (record.completedAt !== undefined)
  )
    throw new StorePreparationError('invalid-record')
  return record
}

const optionalLstat = async (
  path: string
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> => {
  try {
    return await lstat(path)
  } catch (cause) {
    if (codeOf(cause) === 'ENOENT') return undefined
    throw new StorePreparationError('unsafe-path')
  }
}

const ensureDirectory = async (path: string): Promise<void> => {
  let info = await optionalLstat(path)
  if (info === undefined) {
    try {
      await mkdir(path, { recursive: true, mode: 0o700 })
    } catch {
      throw new StorePreparationError('unsafe-path')
    }
    info = await optionalLstat(path)
  }
  if (info === undefined || info.isSymbolicLink() || !info.isDirectory())
    throw new StorePreparationError('unsafe-path')
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
      throw new StorePreparationError('unsafe-path')
    return { handle, mode: directory ? 0o700 : 0o600 }
  } catch (cause) {
    try {
      await handle?.close()
    } catch {
      throw new StorePreparationError('unsafe-path')
    }
    if (cause instanceof StorePreparationError) throw cause
    if (optional && codeOf(cause) === 'ENOENT') return undefined
    throw new StorePreparationError('unsafe-path')
  }
}

const inspectLayout = async (root: string, databasePath: string): Promise<void> => {
  const rootInfo = await optionalLstat(root)
  if (rootInfo === undefined || rootInfo.isSymbolicLink() || !rootInfo.isDirectory())
    throw new StorePreparationError('unsafe-path')
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    throw new StorePreparationError('unsafe-path')
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new StorePreparationError('unsafe-path')
    if (!entry.isDirectory() || !isAttemptId(entry.name))
      throw new StorePreparationError('unsupported-format')
    const directory = join(root, entry.name)
    let children
    try {
      children = await readdir(directory, { withFileTypes: true })
    } catch {
      throw new StorePreparationError('unsafe-path')
    }
    for (const child of children) {
      if (child.isSymbolicLink()) throw new StorePreparationError('unsafe-path')
      if (!child.isFile() || !LOG_FILE_NAMES.has(child.name))
        throw new StorePreparationError('unsupported-format')
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
      throw new StorePreparationError('unsafe-path')
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
  if (existing !== undefined) throw new StorePreparationError('owner-conflict')
  try {
    await mkdir(path, { mode: 0o700 })
    const managed = await openManagedPath(path, true)
    if (managed === undefined) throw new StorePreparationError('unsafe-path')
    try {
      await managed.handle.chmod(managed.mode)
    } finally {
      await managed.handle.close()
    }
  } catch {
    throw new StorePreparationError('unsafe-path')
  }
}

const removeDirectory = async (root: string, id: AttemptId): Promise<void> => {
  const path = join(root, id)
  const info = await optionalLstat(path)
  if (info === undefined) return
  if (info.isSymbolicLink() || !info.isDirectory()) throw new StorePreparationError('unsafe-path')
  try {
    await rm(path, { recursive: true, force: true })
  } catch {
    throw new StorePreparationError('unsafe-path')
  }
  if ((await optionalLstat(path)) !== undefined) throw new StorePreparationError('unsafe-path')
}

interface PendingRequest {
  readonly resolve: (response: RpcSuccess) => void
  readonly reject: (cause: unknown) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly signal?: AbortSignal
  readonly abort?: () => void
}

class WorkerClient {
  private readonly worker: Worker
  private readonly sessionId: SessionId
  private readonly pending = new Map<number, PendingRequest>()
  private readonly exitPromise: Promise<void>
  private resolveExit: (() => void) | undefined
  private readonly readyPromise: Promise<WorkerClient>
  private resolveReady: ((client: WorkerClient) => void) | undefined
  private rejectReady: ((cause: unknown) => void) | undefined
  private phase: 'starting' | 'ready' | 'closing' | 'closed' | 'failed' = 'starting'
  private nextId = 0
  private readyTimer: ReturnType<typeof setTimeout>

  private constructor(worker: Worker, sessionId: SessionId) {
    this.worker = worker
    this.sessionId = sessionId
    this.exitPromise = new Promise(resolveExitPromise => {
      this.resolveExit = resolveExitPromise
    })
    this.readyPromise = new Promise((resolveReadyPromise, rejectReadyPromise) => {
      this.resolveReady = resolveReadyPromise
      this.rejectReady = rejectReadyPromise
    })
    this.readyTimer = setTimeout(
      () => this.fail(new WorkerRpcError('worker-unavailable')),
      STARTUP_TIMEOUT_MS
    )
    worker.on('message', (raw: unknown) => this.message(raw))
    worker.on('error', () => this.fail(new WorkerRpcError('worker-unavailable')))
    worker.on('exit', () => this.exited())
  }

  static open(root: string, databasePath: string, sessionId: SessionId): Promise<WorkerClient> {
    const client = new WorkerClient(
      new Worker(new URL('./work-store-worker.ts', import.meta.url), {
        workerData: { root, databasePath, sessionId },
      }),
      sessionId
    )
    return client.readyPromise.catch(async cause => {
      await client.exitPromise
      throw cause
    })
  }

  request(input: RpcInput, signal: AbortSignal): Promise<RpcSuccess> {
    if (this.phase !== 'ready') return Promise.reject(new WorkerRpcError('worker-closed'))
    const id = ++this.nextId
    const request = { ...input, id }
    return new Promise((resolvePromise, rejectPromise) => {
      if (signal.aborted) {
        rejectPromise(new WorkerRpcError('worker-interrupted'))
        return
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort)
        this.pending.delete(id)
        rejectPromise(new WorkerRpcError('worker-unavailable'))
      }, RPC_TIMEOUT_MS)
      const abort = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        this.pending.delete(id)
        rejectPromise(new WorkerRpcError('worker-interrupted'))
      }
      this.pending.set(id, {
        resolve: resolvePromise,
        reject: rejectPromise,
        timer,
        signal,
        abort,
      })
      signal.addEventListener('abort', abort, { once: true })
      try {
        this.worker.postMessage({ id, request }, [])
      } catch {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        this.pending.delete(id)
        rejectPromise(new WorkerRpcError('worker-unavailable'))
      }
    })
  }

  async close(): Promise<void> {
    if (this.phase === 'closed') return
    if (this.phase === 'failed') {
      await this.exitPromise
      return
    }
    if (this.phase === 'starting') {
      await this.readyPromise.catch(() => undefined)
    }
    if (this.phase === 'ready') {
      try {
        await this.request({ op: 'close', sessionId: this.sessionId }, new AbortController().signal)
      } catch {
        this.phase = 'closing'
      }
    }
    this.phase = 'closing'
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.exitPromise,
        new Promise<void>(resolvePromise => {
          timer = setTimeout(resolvePromise, 1000)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    if (this.phase === 'closing') {
      await this.worker.terminate()
      this.phase = 'closed'
    }
  }

  private message(raw: unknown): void {
    let message: ReturnType<typeof decodeWorkerMessage>
    try {
      message = decodeWorkerMessage(raw)
    } catch {
      this.fail(new WorkerRpcError('worker-protocol'))
      return
    }
    if ('type' in message) {
      if (message.type === 'ready') this.ready(message)
      else this.fail(new WorkerRpcError(message.code))
      return
    }
    const pending = this.pending.get(message.id)
    if (pending === undefined) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (pending.signal !== undefined && pending.abort !== undefined)
      pending.signal.removeEventListener('abort', pending.abort)
    if (message.ok) pending.resolve(message)
    else pending.reject(new WorkerRpcError(message.code))
  }

  private ready(_message: ReadyMessage): void {
    if (this.phase !== 'starting') return
    clearTimeout(this.readyTimer)
    this.phase = 'ready'
    this.resolveReady?.(this)
    this.resolveReady = undefined
    this.rejectReady = undefined
  }

  private fail(cause: unknown): void {
    if (this.phase === 'closed' || this.phase === 'failed') return
    const wasStarting = this.phase === 'starting'
    this.phase = 'failed'
    clearTimeout(this.readyTimer)
    if (wasStarting) this.rejectReady?.(cause)
    this.rejectReady = undefined
    this.resolveReady = undefined
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      if (pending.signal !== undefined && pending.abort !== undefined)
        pending.signal.removeEventListener('abort', pending.abort)
      pending.reject(cause)
    }
    this.pending.clear()
    void this.worker.terminate()
  }

  private exited(): void {
    if (this.phase !== 'closing' && this.phase !== 'closed')
      this.fail(new WorkerRpcError('worker-unavailable'))
    this.phase = 'closed'
    clearTimeout(this.readyTimer)
    this.resolveExit?.()
    this.resolveExit = undefined
  }
}

export interface WorkStore {
  readonly create: (
    id: AttemptId,
    fields: AttemptRecordCreateFields & {
      readonly owner: Omit<OwnerIdentity, 'attemptId'> & { readonly attemptId?: never }
    }
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
  ) => Effect.Effect<
    {
      readonly available: boolean
      readonly path: string
      readonly reason?: string
      readonly offset?: number
      readonly nextOffset?: number
      readonly size?: number
      readonly truncated?: boolean
      readonly text?: string
    },
    WorkPersistenceError
  >
}

class WorkStoreImpl implements WorkStore {
  private readonly root: string
  private readonly sessionId: SessionId
  private readonly authorized = new Set<AttemptId>()
  private readonly fs: FileSystem.FileSystem
  private readonly worker: WorkerClient

  constructor(fs: FileSystem.FileSystem, root: string, sessionId: SessionId, worker: WorkerClient) {
    this.fs = fs
    this.root = root
    this.sessionId = sessionId
    this.worker = worker
  }

  create(
    id: AttemptId,
    fields: AttemptRecordCreateFields & {
      readonly owner: Omit<OwnerIdentity, 'attemptId'> & { readonly attemptId?: never }
    }
  ): Effect.Effect<AttemptRecord, WorkPersistenceError> {
    let snapshot: typeof fields
    try {
      snapshot = structuredClone(fields)
    } catch {
      return Effect.fail(persistenceError(new StorePreparationError('invalid-record')))
    }
    return Effect.gen({ self: this }, function* () {
      if (snapshot.owner.sessionId !== this.sessionId)
        return yield* persistenceError(new WorkerRpcError('session-mismatch'))
      const startedAt = yield* Clock.currentTimeMillis
      const record = yield* Effect.try({
        try: () =>
          safeRecord({
            ...snapshot,
            owner: { ...snapshot.owner, attemptId: id },
            version: 1,
            revision: 0,
            id,
            startedAt,
            status: 'waiting',
          }),
        catch: cause => persistenceError(cause),
      })
      yield* Effect.tryPromise({
        try: () => makeRecordDirectory(this.root, id),
        catch: cause => persistenceError(cause),
      })
      const result = yield* Effect.exit(
        this.call({ op: 'create', sessionId: this.sessionId, now: startedAt, record })
      )
      if (result._tag === 'Failure') return yield* Effect.failCause(result.cause)
      this.authorized.add(id)
      return record
    })
  }

  save(record: AttemptRecord): Effect.Effect<void, WorkPersistenceError> {
    let snapshot: AttemptRecord
    try {
      snapshot = safeRecord(structuredClone(record))
    } catch (cause) {
      return Effect.fail(persistenceError(cause))
    }
    return Clock.currentTimeMillis.pipe(
      Effect.flatMap(now =>
        this.call({ op: 'save', sessionId: this.sessionId, now, record: snapshot }).pipe(
          Effect.asVoid
        )
      )
    )
  }

  read(id: AttemptId): Effect.Effect<AttemptRecord, WorkPersistenceError> {
    if (!isAttemptId(id))
      return Effect.fail(persistenceError(new WorkerRpcError('record-unavailable')))
    return Clock.currentTimeMillis.pipe(
      Effect.flatMap(now =>
        this.call({ op: 'read', sessionId: this.sessionId, now, attemptId: id }).pipe(
          Effect.flatMap(value =>
            Effect.try({
              try: () => {
                const record = safeRecord(value)
                this.authorized.add(record.id)
                return record
              },
              catch: cause => persistenceError(cause),
            })
          )
        )
      )
    )
  }

  get list(): WorkStore['list'] {
    return Clock.currentTimeMillis.pipe(
      Effect.flatMap(now =>
        this.call({ op: 'list', sessionId: this.sessionId, now }).pipe(
          Effect.flatMap(value =>
            Effect.try({
              try: () => {
                const listed = decodeListValue(value)
                for (const record of listed.records) this.authorized.add(record.id)
                return listed
              },
              catch: cause => persistenceError(cause),
            })
          )
        )
      )
    )
  }

  plannedLogPath(id: AttemptId, stream: LogStream): string {
    if (!isAttemptId(id) || !Object.hasOwn(LOG_FILES, stream))
      throw new Error('Choose a valid attempt and log stream')
    return join(this.root, id, LOG_FILES[stream])
  }

  logPath(id: AttemptId, stream: LogStream): string {
    if (!this.authorized.has(id)) throw new Error('Choose a valid attempt and log stream')
    return this.plannedLogPath(id, stream)
  }

  saveResult(id: AttemptId, text: string): Effect.Effect<void, WorkPersistenceError> {
    return Effect.gen({ self: this }, function* () {
      yield* this.read(id)
      const path = this.logPath(id, 'result')
      yield* this.writeLog(id, path, text)
      const checked = yield* Effect.exit(this.read(id))
      if (checked._tag === 'Failure') {
        yield* this.removeLog(path).pipe(Effect.ignore)
        return yield* Effect.failCause(checked.cause)
      }
    })
  }

  readLog(
    id: AttemptId,
    stream: LogStream = 'stdout',
    offset?: number,
    limit = 12000
  ): Effect.Effect<
    {
      readonly available: boolean
      readonly path: string
      readonly reason?: string
      readonly offset?: number
      readonly nextOffset?: number
      readonly size?: number
      readonly truncated?: boolean
      readonly text?: string
    },
    WorkPersistenceError
  > {
    return Effect.gen({ self: this }, function* () {
      if (
        (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 64000
      )
        return yield* persistenceError(new WorkerRpcError('invalid-record'))
      yield* this.read(id)
      const path = this.logPath(id, stream)
      const directory = yield* this.lstat(join(this.root, id))
      if (directory === undefined || directory.isSymbolicLink() || !directory.isDirectory())
        return yield* persistenceError(new WorkerRpcError('unsafe-path'))
      const info = yield* this.lstat(path)
      if (info === undefined)
        return { available: false, path, reason: 'Log unavailable or expired' }
      if (info.isSymbolicLink() || !info.isFile())
        return yield* persistenceError(new WorkerRpcError('unsafe-path'))
      yield* this.fs.chmod(path, 0o600)
      const file = yield* this.fs.open(path, { flag: 'r' })
      const size = Number(ByteSize.toBigInt((yield* file.stat).size))
      if (!Number.isSafeInteger(size))
        return yield* persistenceError(new WorkerRpcError('invalid-record'))
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
    }).pipe(
      Effect.scoped,
      Effect.mapError(cause =>
        cause instanceof WorkPersistenceError
          ? cause
          : persistenceError(new WorkerRpcError('persistence-failed'))
      )
    )
  }

  private call(input: RpcInput): Effect.Effect<unknown, WorkPersistenceError> {
    return Effect.tryPromise({
      try: signal => this.worker.request(input, signal),
      catch: cause => persistenceError(cause),
    }).pipe(
      Effect.flatMap(response => this.postCommitCleanup(response).pipe(Effect.as(response.value)))
    )
  }

  private postCommitCleanup(response: RpcSuccess): Effect.Effect<void, WorkPersistenceError> {
    if (response.cleanup.length === 0) return Effect.void
    return Effect.gen({ self: this }, function* () {
      const acknowledged: AttemptId[] = []
      for (const id of response.cleanup) {
        yield* this.removeRecordDirectory(id)
        this.authorized.delete(id)
        acknowledged.push(id)
      }
      yield* Effect.tryPromise({
        try: signal =>
          this.worker.request(
            {
              op: 'ack',
              sessionId: this.sessionId,
              attemptIds: acknowledged,
            },
            signal
          ),
        catch: cause => persistenceError(cause),
      })
    })
  }

  private removeRecordDirectory(id: AttemptId): Effect.Effect<void, WorkPersistenceError> {
    return Effect.tryPromise({
      try: () => removeDirectory(this.root, id),
      catch: cause => persistenceError(cause),
    })
  }

  private lstat(
    path: string
  ): Effect.Effect<Awaited<ReturnType<typeof lstat>> | undefined, WorkPersistenceError> {
    return Effect.tryPromise({
      try: () => optionalLstat(path),
      catch: cause => persistenceError(cause),
    })
  }

  private writeLog(
    id: AttemptId,
    path: string,
    text: string
  ): Effect.Effect<void, WorkPersistenceError> {
    return Effect.gen({ self: this }, function* () {
      const directory = yield* this.lstat(join(this.root, id))
      if (directory === undefined || directory.isSymbolicLink() || !directory.isDirectory())
        return yield* persistenceError(new WorkerRpcError('unsafe-path'))
      const existing = yield* this.lstat(path)
      if (existing !== undefined && (existing.isSymbolicLink() || !existing.isFile()))
        return yield* persistenceError(new WorkerRpcError('unsafe-path'))
      yield* this.fs.writeFileString(path, text, { flag: 'w', mode: 0o600 })
      yield* this.fs.chmod(path, 0o600)
    }).pipe(
      Effect.mapError(cause =>
        cause instanceof WorkPersistenceError
          ? cause
          : persistenceError(new WorkerRpcError('persistence-failed'))
      )
    )
  }

  private removeLog(path: string): Effect.Effect<void, WorkPersistenceError> {
    return this.fs.remove(path, { force: true }).pipe(
      Effect.asVoid,
      Effect.mapError(() => persistenceError(new WorkerRpcError('unsafe-path')))
    )
  }
}

export const makeWorkStore = (
  dataHome: string,
  sessionId: SessionId
): Effect.Effect<WorkStore, WorkPersistenceError, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const paths = yield* Effect.tryPromise({
      try: () => preparePersistence(dataHome),
      catch: cause => persistenceError(cause),
    })
    const worker = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => WorkerClient.open(paths.root, paths.databasePath, sessionId),
        catch: cause => persistenceError(cause),
      }),
      client => Effect.promise(() => client.close())
    )
    yield* Effect.tryPromise({
      try: () => repairPersistenceModes(paths),
      catch: cause => persistenceError(cause),
    })
    return new WorkStoreImpl(fs, paths.root, sessionId, worker)
  })
