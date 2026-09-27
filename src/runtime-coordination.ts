import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  unlinkSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { Effect, Predicate, Schema, Semaphore, type Scope } from 'effect'
import { canonicalConversationFile, conversationFileSlot } from './workspace-paths.ts'

export class CoordinationError extends Schema.TaggedError<CoordinationError>()(
  'CoordinationError',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }
) {}

export interface ConversationClaim {
  readonly path: string
  readonly sessionId?: string
}

export interface RuntimeLease {
  readonly release: Effect.Effect<void, CoordinationError>
  readonly protect: (conversation: ConversationClaim) => Effect.Effect<void, CoordinationError>
  readonly navigate: <A, E, R>(
    operation: Effect.Effect<A, E, R>,
    current: () => ConversationClaim
  ) => Effect.Effect<A, E | CoordinationError, R>
}

const installationHome = fileURLToPath(new URL('../.dev/', import.meta.url))
const markerSql = 'CREATE TABLE guard (version INTEGER PRIMARY KEY CHECK (version = 1)) STRICT'
const JournalMode = Schema.Struct({ journal_mode: Schema.Literal('delete') })

const native = <A>(operation: () => A): Effect.Effect<A, CoordinationError> =>
  Effect.try({
    try: operation,
    catch: cause =>
      cause instanceof CoordinationError
        ? cause
        : new CoordinationError({
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
  })

const privateDirectory = (path: string): void => {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  if (!lstatSync(path).isDirectory())
    throw new Error(`Coordination directory must not be a symlink: ${path}`)
  chmodSync(path, 0o700)
}

const canonicalConversation = (path: string): string => {
  const absolute = resolve(path)
  // A dangling link is keyed like a missing file, so the authority refuses it with its guidance.
  if (!existsSync(absolute)) return conversationFileSlot(absolute, undefined)
  const canonical = canonicalConversationFile(absolute)
  const info = lstatSync(canonical)
  if (!info.isFile() || info.nlink !== 1)
    throw new Error(`Conversation must be a regular file without hard links: ${path}`)
  return canonical
}

const publishLockDatabase = (path: string): void => {
  if (existsSync(path)) return
  const candidate = `${path}.${randomUUID()}.tmp`
  let database: DatabaseSync | undefined
  closeSync(openSync(candidate, 'wx', 0o600))
  try {
    database = new DatabaseSync(candidate)
    database.exec(`${markerSql}; INSERT INTO guard VALUES (1)`)
    database.close()
    database = undefined
    try {
      linkSync(candidate, path)
    } catch (cause) {
      if (!(Predicate.isObject(cause) && cause.code === 'EEXIST')) throw cause
    }
  } finally {
    database?.close()
    unlinkSync(candidate)
  }
}

const lockDatabase = (path: string, shared: boolean, conflict: string): (() => void) => {
  publishLockDatabase(path)
  if (!lstatSync(path).isFile()) throw new Error(`Invalid coordination file: ${path}`)
  chmodSync(path, 0o600)
  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(path, { timeout: 0, allowExtension: false })
    database.exec('PRAGMA busy_timeout = 0')
    Schema.decodeUnknownSync(JournalMode)(database.prepare('PRAGMA journal_mode').get())
    if (
      database.prepare("SELECT sql FROM sqlite_schema WHERE name = 'guard'").get()?.sql !==
      markerSql
    )
      throw new Error(`Unknown coordination format: ${path}`)
    database.exec(shared ? 'BEGIN' : 'BEGIN EXCLUSIVE')
    if (database.prepare('SELECT version FROM guard').get()?.version !== 1)
      throw new Error(`Invalid coordination marker: ${path}`)
    const acquired = database
    let closed = false
    return () => {
      if (closed) return
      acquired.close()
      closed = true
    }
  } catch (cause) {
    database?.close()
    if (Predicate.isObject(cause) && cause.errcode === 5)
      throw new CoordinationError({ message: conflict, cause })
    throw cause
  }
}

const prepareCoordination = (): string => {
  privateDirectory(installationHome)
  const root = join(realpathSync(installationHome), 'coordination')
  privateDirectory(root)
  privateDirectory(join(root, 'conversations'))
  return root
}

const makeRuntimeLease = (dataHome: string): RuntimeLease => {
  const root = prepareCoordination()
  mkdirSync(dataHome, { recursive: true, mode: 0o700 })
  const home = realpathSync.native(dataHome)
  const releaseInstallation = lockDatabase(
    join(root, 'installation.sqlite'),
    true,
    'Dev maintenance is active; retry after it finishes.'
  )
  const claims = new Map<string, () => void>()
  const navigation = Semaphore.makeUnsafe(1)
  let closed = false
  const keys = (conversation: ConversationClaim): readonly string[] => [
    `file:${canonicalConversation(conversation.path)}`,
    ...(conversation.sessionId === undefined ? [] : [`session:${home}:${conversation.sessionId}`]),
  ]
  const releaseExcept = (retained: ReadonlySet<string>): void => {
    const failures: unknown[] = []
    for (const [key, release] of claims) {
      if (retained.has(key)) continue
      try {
        release()
        claims.delete(key)
      } catch (cause) {
        failures.push(cause)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Cannot release conversation locks')
  }
  return {
    protect: conversation =>
      native(() => {
        if (closed) throw new Error('Dev runtime ownership has closed')
        const retained = new Set(claims.keys())
        try {
          for (const key of keys(conversation)) {
            if (claims.has(key)) continue
            const name = createHash('sha256').update(key).digest('hex')
            claims.set(
              key,
              lockDatabase(
                join(root, 'conversations', `${name}.sqlite`),
                false,
                `This conversation is already open in another dev session: ${conversation.path}`
              )
            )
          }
        } catch (cause) {
          releaseExcept(retained)
          throw cause
        }
      }),
    navigate: (operation, current) =>
      navigation.withPermit(
        operation.pipe(
          Effect.ensuring(native(() => releaseExcept(new Set(keys(current())))).pipe(Effect.orDie))
        )
      ),
    release: native(() => {
      if (closed) return
      releaseExcept(new Set())
      releaseInstallation()
      closed = true
    }),
  }
}

export const acquireRuntime = (
  dataHome: string
): Effect.Effect<RuntimeLease, CoordinationError, Scope.Scope> =>
  Effect.acquireRelease(
    native(() => makeRuntimeLease(dataHome)),
    lease => lease.release.pipe(Effect.orDie)
  )

export const acquireMaintenance: Effect.Effect<void, CoordinationError, Scope.Scope> =
  Effect.acquireRelease(
    native(() => {
      const root = prepareCoordination()
      return lockDatabase(
        join(root, 'installation.sqlite'),
        false,
        'Dev sessions or another maintenance operation are active; stop them before updating or rolling back.'
      )
    }),
    release => native(release).pipe(Effect.orDie)
  ).pipe(Effect.asVoid)
