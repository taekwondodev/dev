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
import { join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { Effect, Predicate, Schema, Semaphore, type Scope } from 'effect'
import { canonicalConversationFile, conversationFileSlot, isWithin } from './workspace-paths.ts'
import { WorkspaceAuthority } from './workspace-authority.ts'
import { defaultAuthorityRoot } from './workspace-authority-root.ts'
import { acquirePathGates, type GateRelease } from './workspace-gates.ts'
import { WorkspaceId } from './workspace-domain.ts'
import { getWorkspace } from './workspace-records.ts'

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

const installationPath = fileURLToPath(new URL('../', import.meta.url))

export interface CoordinationOptions {
  readonly installationPath?: string
  readonly namespacePath?: string
}

const sourcePresence = (options: CoordinationOptions): GateRelease => {
  const source = realpathSync(options.installationPath ?? installationPath)
  const authority = new WorkspaceAuthority(options.namespacePath ?? defaultAuthorityRoot())
  const { paths } = authority
  if (!isWithin(paths.worktrees, source)) {
    authority.close()
    return () => {}
  }
  const [repository, workspace] = relative(paths.worktrees, source).split(sep)
  if (!Schema.is(WorkspaceId)(repository) || !Schema.is(WorkspaceId)(workspace))
    throw new CoordinationError({
      message: 'Installation is not inside an identifiable managed workspace',
    })
  const root = join(paths.worktrees, repository, workspace)
  const before = lstatSync(root, { bigint: true })
  let release: GateRelease | undefined
  try {
    if (authority.inspectExisting() === undefined)
      throw new CoordinationError({ message: 'Managed installation authority is unavailable' })
    release = acquirePathGates(authority.paths, root, 'reader').use
    const after = lstatSync(root, { bigint: true })
    if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino)
      throw new CoordinationError({ message: 'Installation workspace changed during startup' })
    const db = authority.openShard(repository)
    try {
      const recorded = getWorkspace(db, workspace)
      if (
        recorded === undefined ||
        recorded.status !== 'ready' ||
        recorded.origin !== 'managed' ||
        recorded.path !== root ||
        recorded.physical.device !== String(after.dev) ||
        recorded.physical.inode !== String(after.ino)
      )
        throw new CoordinationError({
          message: 'Installation workspace no longer matches its authority record',
        })
    } finally {
      db.close()
    }
    const held = release
    return () => {
      held()
      authority.close()
    }
  } catch (cause) {
    release?.()
    authority.close()
    throw cause
  }
}
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

const lockDatabase = (
  path: string,
  shared: boolean,
  conflict: string,
  create = true
): (() => void) => {
  if (create) publishLockDatabase(path)
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

export const holdExistingInstallationForRemoval = (checkout: string): GateRelease => {
  let directory = checkout
  for (const part of ['.dev', 'coordination']) {
    directory = join(directory, part)
    try {
      const info = lstatSync(directory)
      if (!info.isDirectory())
        throw new CoordinationError({ message: `Invalid coordination directory: ${directory}` })
    } catch (cause) {
      if (Predicate.isObject(cause) && cause.code === 'ENOENT') return () => {}
      throw cause
    }
  }
  return lockDatabase(
    join(directory, 'installation.sqlite'),
    false,
    `Target installation is still in use: ${checkout}`,
    false
  )
}

const prepareCoordination = (options: CoordinationOptions): string => {
  const home = join(options.installationPath ?? installationPath, '.dev')
  privateDirectory(home)
  const root = join(realpathSync(home), 'coordination')
  privateDirectory(root)
  privateDirectory(join(root, 'conversations'))
  return root
}

const makeRuntimeLease = (dataHome: string, options: CoordinationOptions): RuntimeLease => {
  const releaseSource = sourcePresence(options)
  let root: string
  let home: string
  let releaseInstallation: GateRelease
  try {
    root = prepareCoordination(options)
    mkdirSync(dataHome, { recursive: true, mode: 0o700 })
    home = realpathSync.native(dataHome)
    releaseInstallation = lockDatabase(
      join(root, 'installation.sqlite'),
      true,
      'Dev maintenance is active; retry after it finishes.'
    )
  } catch (cause) {
    releaseSource()
    throw cause
  }
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
      releaseSource()
      closed = true
    }),
  }
}

export const acquireRuntime = (
  dataHome: string,
  options: CoordinationOptions = {}
): Effect.Effect<RuntimeLease, CoordinationError, Scope.Scope> =>
  Effect.acquireRelease(
    native(() => makeRuntimeLease(dataHome, options)),
    lease => lease.release.pipe(Effect.orDie)
  )

export const acquireMaintenance = (
  options: CoordinationOptions = {}
): Effect.Effect<void, CoordinationError, Scope.Scope> =>
  Effect.acquireRelease(
    native(() => {
      const releaseSource = sourcePresence(options)
      try {
        const root = prepareCoordination(options)
        const releaseDatabase = lockDatabase(
          join(root, 'installation.sqlite'),
          false,
          'Dev sessions or another maintenance operation are active; stop them before updating or rolling back.'
        )
        return () => {
          releaseDatabase()
          releaseSource()
        }
      } catch (cause) {
        releaseSource()
        throw cause
      }
    }),
    release => native(release).pipe(Effect.orDie)
  ).pipe(Effect.asVoid)
