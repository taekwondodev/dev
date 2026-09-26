import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  realpathSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { userInfo } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { Schema } from 'effect'
import {
  ambiguous,
  blocked,
  invalid,
  requireReview,
  unavailable,
  WorkspaceEffectSchema,
  WorkspaceError,
  WorkspaceId,
  WorkspaceProcessSchema,
  WorkspaceGrantSchema,
  type WorkspaceAuthorization,
  type WorkspaceBinding,
  type WorkspaceConversation,
  type WorkspaceExecution,
  type WorkspaceExecutionFact,
  type WorkspaceGrant,
  type WorkspaceHandoff,
  type WorkspaceOperation,
  type WorkspaceSelection,
  type WorkspaceView,
} from './workspace-domain.ts'
import {
  addDetachedWorktree,
  assertManagedCheckoutSupported,
  canonicalGitWorkspace,
  currentCommit,
  type FileIdentity,
  type GitWorkspace,
} from './workspace-git.ts'
import {
  assertDestinationUnchanged,
  canonicalPathSlot,
  isWithin,
  lstatIfExists,
  resolveWriteDestination,
} from './workspace-paths.ts'

const PROTOCOL_VERSION = 1
const SCHEMA_VERSION = 2
const BUSY_TIMEOUT_MS = 5000
const SHARED_GATE_WAIT_MS = 250
const UUID = WorkspaceId
const PhysicalSchema = Schema.Struct({
  device: Schema.NonEmptyString,
  inode: Schema.NonEmptyString,
})
const TaskSchema = Schema.Struct({
  id: UUID,
  repositoryId: UUID,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  createdAt: Schema.Finite,
})
const RepositoryCatalogSchema = Schema.Struct({
  id: UUID,
  commonPath: Schema.NonEmptyString,
  device: Schema.NonEmptyString,
  inode: Schema.NonEmptyString,
  objectFormat: Schema.NonEmptyString,
  state: Schema.Literals(['provisioning', 'ready']),
  provisionId: UUID,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
const WorkspaceSchema = Schema.Struct({
  id: UUID,
  repositoryId: UUID,
  path: Schema.NonEmptyString,
  pathKey: Schema.NonEmptyString,
  physical: PhysicalSchema,
  gitAdminPath: Schema.NonEmptyString,
  gitAdmin: PhysicalSchema,
  commonPath: Schema.NonEmptyString,
  common: PhysicalSchema,
  objectFormat: Schema.NonEmptyString,
  origin: Schema.Literals(['pre-existing', 'managed']),
  status: Schema.Literals(['provisioning', 'ready']),
  allocationOperationId: Schema.optional(UUID),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  createdAt: Schema.Finite,
})
const ReservationSchema = Schema.Struct({
  id: UUID,
  taskId: UUID,
  workspaceId: UUID,
  acquisitionId: Schema.optional(UUID),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  createdAt: Schema.Finite,
})
const ExecutionSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  taskKey: Schema.NonEmptyString,
  attemptId: Schema.NonEmptyString,
  generation: Schema.NonEmptyString,
  logs: Schema.optional(Schema.String),
})
const ExecutionFactSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('launch-intent'), execution: ExecutionSchema }),
  Schema.Struct({ kind: Schema.Literal('spawned'), process: WorkspaceProcessSchema }),
  Schema.Struct({ kind: Schema.Literal('started') }),
  Schema.Struct({
    kind: Schema.Literal('observed'),
    processes: Schema.Array(WorkspaceProcessSchema),
  }),
  Schema.Struct({ kind: Schema.Literal('quiescent'), reason: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal('launch-failed'), reason: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal('unknown'), reason: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal('operation-started') }),
  Schema.Struct({ kind: Schema.Literal('operation-completed') }),
])
const BindingSchema = Schema.Struct({
  key: Schema.NonEmptyString,
  conversation: Schema.Struct({
    sessionId: Schema.NonEmptyString,
    sessionFile: Schema.NonEmptyString,
    dataHome: Schema.NonEmptyString,
  }),
  taskId: Schema.optional(UUID),
  workspaceId: UUID,
  cwd: Schema.NonEmptyString,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  pendingOperationId: Schema.optional(UUID),
  superseded: Schema.optional(Schema.Boolean),
})
const UseSchema = Schema.Struct({
  id: UUID,
  workspaceId: UUID,
  taskId: Schema.optional(UUID),
  reservationId: Schema.optional(UUID),
  acquisitionId: Schema.optional(UUID),
  access: Schema.Literals(['read', 'write']),
  stage: Schema.Literals([
    'authorized',
    'operation-started',
    'launch-intent',
    'spawned',
    'started',
    'observed',
    'quiescent',
    'unknown',
  ]),
  effect: Schema.optional(WorkspaceEffectSchema),
  withinUseId: Schema.optional(UUID),
  operationPath: Schema.optional(Schema.NonEmptyString),
  execution: Schema.optional(ExecutionSchema),
  processes: Schema.Array(WorkspaceProcessSchema),
  reason: Schema.optional(Schema.String),
  conversationKey: Schema.NonEmptyString,
  bindingRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
})
const OperationSchema = Schema.Struct({
  id: UUID,
  kind: Schema.Literals(['allocation', 'handoff']),
  phase: Schema.Literals([
    'intent',
    'started',
    'confirmed',
    'cancelled',
    'unknown',
    'review-required',
  ]),
  repositoryId: UUID,
  workspaceId: UUID,
  taskId: UUID,
  reservationId: UUID,
  acquisitionId: Schema.optional(UUID),
  sourceRepositoryId: UUID,
  sourceWorkspaceId: UUID,
  sourcePath: Schema.NonEmptyString,
  sourceCommit: Schema.optional(Schema.String),
  targetPath: Schema.NonEmptyString,
  conversationKey: Schema.NonEmptyString,
  expectedBindingRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  reason: Schema.NonEmptyString,
  createdAt: Schema.Finite,
  result: Schema.optional(Schema.String),
})

type TaskRecord = typeof TaskSchema.Type
type RepositoryCatalogRecord = typeof RepositoryCatalogSchema.Type
type WorkspaceRecord = typeof WorkspaceSchema.Type
type ReservationRecord = typeof ReservationSchema.Type
type BindingRecord = typeof BindingSchema.Type
type UseRecord = typeof UseSchema.Type
type OperationRecord = typeof OperationSchema.Type

type SqlRow = Record<string, unknown>
type GateRelease = () => void

const PROTOCOL_SQL = `
  CREATE TABLE protocol_marker(
    id INTEGER PRIMARY KEY CHECK(id = 1),
    version INTEGER NOT NULL,
    namespace_id TEXT NOT NULL
  ) STRICT;
  PRAGMA user_version = ${SCHEMA_VERSION};
`
const CATALOG_SQL = `
  CREATE TABLE catalog_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
  CREATE TABLE repositories(
    id TEXT PRIMARY KEY,
    common_path TEXT NOT NULL UNIQUE,
    device TEXT NOT NULL,
    inode TEXT NOT NULL,
    object_format TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('provisioning', 'ready')),
    provision_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    payload TEXT NOT NULL
  ) STRICT;
  CREATE UNIQUE INDEX repositories_by_physical_identity ON repositories(device, inode);
  PRAGMA user_version = ${SCHEMA_VERSION};
`
const SHARD_SQL = `
  CREATE TABLE shard_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
  CREATE TABLE tasks(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL) STRICT;
  CREATE TABLE workspaces(
    id TEXT PRIMARY KEY,
    path_key TEXT NOT NULL UNIQUE,
    path TEXT NOT NULL,
    origin TEXT NOT NULL CHECK(origin IN ('pre-existing', 'managed')),
    status TEXT NOT NULL CHECK(status IN ('provisioning', 'ready')),
    revision INTEGER NOT NULL,
    payload TEXT NOT NULL
  ) STRICT;
  CREATE TABLE reservations(
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL UNIQUE,
    task_id TEXT NOT NULL,
    acquisition_id TEXT,
    revision INTEGER NOT NULL,
    payload TEXT NOT NULL
  ) STRICT;
  CREATE INDEX reservations_by_task ON reservations(task_id, id);
  CREATE TABLE bindings(
    conversation_key TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    task_id TEXT,
    revision INTEGER NOT NULL,
    payload TEXT NOT NULL
  ) STRICT;
  CREATE TABLE uses(
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    task_id TEXT,
    reservation_id TEXT,
    acquisition_id TEXT,
    access TEXT NOT NULL CHECK(access IN ('read', 'write')),
    stage TEXT NOT NULL,
    revision INTEGER NOT NULL,
    payload TEXT NOT NULL
  ) STRICT;
  CREATE INDEX uses_by_workspace ON uses(workspace_id, stage, id);
  CREATE TABLE operations(
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    phase TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    created_at REAL NOT NULL,
    payload TEXT NOT NULL
  ) STRICT;
  CREATE INDEX operations_open ON operations(phase, created_at) WHERE phase IN ('intent', 'started', 'unknown', 'review-required');
  PRAGMA user_version = ${SCHEMA_VERSION};
`
const GATE_SQL = `
  CREATE TABLE gate_marker(
    id INTEGER PRIMARY KEY CHECK(id = 1),
    version INTEGER NOT NULL,
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    key TEXT NOT NULL
  ) STRICT;
  PRAGMA user_version = ${SCHEMA_VERSION};
`

const workspaceId = (): string => randomUUID()
const isUuid = (value: string): boolean => Schema.is(UUID)(value)
const encode = (value: unknown): string => {
  const result = JSON.stringify(value)
  if (typeof result !== 'string') return invalid('Workspace record cannot be encoded')
  return result
}
const decodeJson = (value: unknown, label: string): unknown => {
  if (typeof value !== 'string') return requireReview(`Corrupt ${label}: payload is not text`)
  try {
    return JSON.parse(value)
  } catch {
    return requireReview(`Corrupt ${label}: payload is not valid JSON`)
  }
}
const parseRecord = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  raw: unknown,
  label: string
): S['Type'] => {
  try {
    return Schema.decodeUnknownSync(schema)(decodeJson(raw, label))
  } catch (cause) {
    if (cause instanceof WorkspaceError) throw cause
    return requireReview(`Corrupt ${label}: persisted record failed schema validation`)
  }
}
const now = (): number => Date.now()
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
const jsonEqual = (left: unknown, right: unknown): boolean => encode(left) === encode(right)
const isMissing = (cause: unknown): boolean =>
  typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT'
const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)
const sqliteCode = (cause: unknown): number | undefined =>
  typeof cause === 'object' &&
  cause !== null &&
  'errcode' in cause &&
  typeof cause.errcode === 'number'
    ? cause.errcode & 255
    : undefined

const fsyncPath = (path: string, directory = false): void => {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : 0)
  const fd = openSync(path, flags)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
const fsyncParent = (path: string): void => fsyncPath(dirname(path), true)
const effectiveUid = (): number => process.getuid?.() ?? userInfo().uid

const logAvailability = (path: string): boolean | undefined => {
  try {
    const info = lstatSync(path)
    return (
      info.isFile() &&
      !info.isSymbolicLink() &&
      info.nlink === 1 &&
      info.uid === effectiveUid() &&
      (info.mode & 0o400) !== 0 &&
      realpathSync(path) === path
    )
  } catch (cause) {
    // Expired transient logs do not erase ownership; an inspection error is
    // unknown availability, not evidence that a workspace can be reused.
    return isMissing(cause) ? false : undefined
  }
}

const privateDirectory = (path: string, create: boolean): void => {
  let info = lstatIfExists(path)
  if (info === undefined && create) {
    try {
      mkdirSync(path, { mode: 0o700 })
      fsyncParent(path)
      fsyncPath(path, true)
    } catch (cause) {
      if (
        !(typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'EEXIST')
      )
        throw cause
    }
    info = lstatIfExists(path)
  }
  if (info === undefined) return unavailable(`Workspace authority directory is missing: ${path}`)
  if (!info.isDirectory() || info.isSymbolicLink())
    return unavailable(`Unsafe workspace authority directory: ${path}`)
  if (info.uid !== effectiveUid() || (info.mode & 0o077) !== 0)
    return unavailable(
      `Workspace authority directory is not private or is not owned by this account: ${path}`
    )
}

const ensureDirectoryPath = (path: string): void => {
  const info = lstatIfExists(path)
  if (info !== undefined) {
    if (!info.isDirectory() || info.isSymbolicLink())
      unavailable(`Unsafe workspace authority parent: ${path}`)
    return
  }
  ensureDirectoryPath(dirname(path))
  try {
    mkdirSync(path, { mode: 0o700 })
    fsyncParent(path)
    fsyncPath(path, true)
  } catch (cause) {
    if (
      !(typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'EEXIST')
    )
      throw cause
  }
  const created = lstatIfExists(path)
  if (created === undefined || !created.isDirectory() || created.isSymbolicLink())
    unavailable(`Cannot create workspace authority directory: ${path}`)
}

const canonicalRoot = (requested: string): string => {
  if (!isAbsolute(requested)) invalid('Workspace authority root must be an absolute path')
  const absolute = resolve(requested)
  const requestedInfo = lstatIfExists(absolute)
  if (requestedInfo?.isSymbolicLink())
    unavailable(`Workspace authority root must not be a symbolic link: ${absolute}`)
  const parts: string[] = []
  let cursor = absolute
  while (lstatIfExists(cursor) === undefined) {
    const parent = dirname(cursor)
    if (parent === cursor) unavailable(`Cannot resolve workspace authority root: ${absolute}`)
    parts.unshift(basename(cursor))
    cursor = parent
  }
  const physicalParent = realpathSync(cursor)
  return resolve(physicalParent, ...parts)
}

// Initial support is local macOS storage. A synchronized folder or network mount can
// replay or reorder SQLite and gate files outside the authority's control. No detector
// can recognize every sync agent, so only the known cases are refused.
const SUPPORTED_FILESYSTEMS = new Set(['apfs', 'hfs'])
const SYNCHRONIZED_FOLDERS = [
  ['Library', 'Mobile Documents'],
  ['Library', 'CloudStorage'],
] as const
export const unsupportedAuthorityStorage = (input: {
  readonly path: string
  readonly home: string
  readonly mountTable: string
}): string | undefined => {
  for (const parts of SYNCHRONIZED_FOLDERS) {
    const folder = join(input.home, ...parts)
    if (isWithin(folder, input.path))
      return `Workspace authority cannot live in a synchronized folder: ${folder}`
  }
  const mount = input.mountTable
    .split('\n')
    .map(line => /^.+? on (.+) \((.+)\)$/.exec(line))
    .filter(match => match !== null)
    .map(match => ({ point: match[1] ?? '', options: (match[2] ?? '').split(', ') }))
    .filter(entry => entry.point !== '' && isWithin(entry.point, input.path))
    .toSorted((left, right) => right.point.length - left.point.length)[0]
  if (mount === undefined) return `Cannot identify the filesystem holding ${input.path}`
  const [type = 'unknown'] = mount.options
  if (!mount.options.includes('local'))
    return `Workspace authority requires local storage; ${mount.point} is a ${type} mount`
  if (!SUPPORTED_FILESYSTEMS.has(type))
    return `Workspace authority does not support ${type} storage at ${mount.point}`
  return undefined
}
const assertSupportedStorage = (root: string): void => {
  if (process.platform !== 'darwin')
    unavailable(`Workspace authority currently supports only macOS, not ${process.platform}`)
  let mountTable: string
  try {
    mountTable = execFileSync('/sbin/mount', { encoding: 'utf8' })
  } catch (cause) {
    return unavailable(`Cannot inspect the storage holding ${root}: ${errorText(cause)}`)
  }
  const reason = unsupportedAuthorityStorage({
    path: root,
    home: realpathSync(userInfo().homedir),
    mountTable,
  })
  if (reason !== undefined) unavailable(reason)
}

const privateFile = (path: string): void => {
  const info = lstatIfExists(path)
  if (info === undefined || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
    return unavailable(`Unsafe workspace authority file: ${path}`)
  if (info.uid !== effectiveUid() || (info.mode & 0o077) !== 0)
    return unavailable(
      `Workspace authority file is not private or is not owned by this account: ${path}`
    )
}

const syncNewFile = (path: string): void => {
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== effectiveUid())
      unavailable(`Unsafe newly created authority file: ${path}`)
    fchmodSync(fd, 0o600)
    fsyncSync(fd)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

const parseVersion = (text: string): readonly [number, number, number] | undefined => {
  const match = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(text)
  if (match === null) return undefined
  const value = [Number(match[1]), Number(match[2]), Number(match[3])] as const
  return value.every(Number.isSafeInteger) ? value : undefined
}
const compareVersion = (left: readonly number[], right: readonly number[]): number =>
  (left[0] ?? 0) - (right[0] ?? 0) ||
  (left[1] ?? 0) - (right[1] ?? 0) ||
  (left[2] ?? 0) - (right[2] ?? 0)
const walResetSafe = (text: string): boolean => {
  const version = parseVersion(text)
  if (version === undefined) return false
  if (version[0] > 3) return true
  if (version[0] < 3) return false
  return (
    version[1] > 51 ||
    (version[1] === 51 && version[2] >= 3) ||
    (version[1] === 50 && version[2] >= 7) ||
    (version[1] === 44 && version[2] >= 6)
  )
}
const assertSqliteSafety = (): void => {
  const node = parseVersion(process.versions.node)
  const sqlite = process.versions.sqlite
  if (
    node === undefined ||
    compareVersion(node, [22, 23, 2]) < 0 ||
    sqlite === undefined ||
    !walResetSafe(sqlite)
  )
    unavailable(
      `Unsupported Node/SQLite runtime for durable WAL authority (Node ${process.versions.node}, SQLite ${sqlite ?? 'unknown'})`
    )
}

const rows = (db: DatabaseSync, sql: string, ...params: (string | number | null)[]): SqlRow[] =>
  db.prepare(sql).all(...params) as SqlRow[]
const first = (
  db: DatabaseSync,
  sql: string,
  ...params: (string | number | null)[]
): SqlRow | undefined => db.prepare(sql).get(...params) as SqlRow | undefined
const textField = (row: SqlRow | undefined, key: string): string => {
  const value = row?.[key]
  if (typeof value !== 'string') return requireReview(`Corrupt workspace authority column: ${key}`)
  return value
}
const numberField = (row: SqlRow | undefined, key: string): number => {
  const value = row?.[key]
  if (typeof value !== 'number' || !Number.isFinite(value))
    return requireReview(`Corrupt workspace authority column: ${key}`)
  return value
}
const normalizeSql = (sql: string): string => sql.replace(/\s+/g, ' ').trim()
const schemaCatalog = (db: DatabaseSync): string =>
  JSON.stringify({
    objects: rows(
      db,
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
    ).map(row => ({
      type: row.type,
      name: row.name,
      table: row.tbl_name,
      sql: normalizeSql(String(row.sql)),
    })),
    tables: rows(db, 'PRAGMA table_list')
      .filter(row => row.name !== 'sqlite_schema' && row.name !== 'sqlite_temp_schema')
      .map(row => ({
        schema: row.schema,
        name: row.name,
        type: row.type,
        columns: row.ncol,
        withoutRowid: row.wr,
        strict: row.strict,
      }))
      .toSorted((left, right) => String(left.name).localeCompare(String(right.name))),
  })
const expectedCatalog = (ddl: string): string => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(ddl)
    return schemaCatalog(db)
  } finally {
    db.close()
  }
}
const schemaFor = (kind: 'protocol' | 'catalog' | 'shard' | 'gate'): string =>
  kind === 'protocol'
    ? PROTOCOL_SQL
    : kind === 'catalog'
      ? CATALOG_SQL
      : kind === 'shard'
        ? SHARD_SQL
        : GATE_SQL

const createPublishedDatabase = (
  path: string,
  kind: 'protocol' | 'catalog' | 'shard' | 'gate',
  initialize: (db: DatabaseSync) => void
): void => {
  privateDirectory(dirname(path), false)
  if (lstatIfExists(path) !== undefined) return
  const candidate = join(dirname(path), `.${basename(path)}.candidate.${randomUUID()}`)
  let db: DatabaseSync | undefined
  let fd: number | undefined
  try {
    fd = openSync(
      candidate,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600
    )
    closeSync(fd)
    fd = undefined
    db = new DatabaseSync(candidate, {
      timeout: 0,
      allowExtension: false,
      enableForeignKeyConstraints: true,
    })
    db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA fullfsync = ON;')
    db.exec(schemaFor(kind))
    initialize(db)
    const check = first(db, 'PRAGMA integrity_check')
    if (textField(check, 'integrity_check') !== 'ok')
      unavailable(`New SQLite authority failed integrity check: ${path}`)
    db.close()
    db = undefined
    syncNewFile(candidate)
    try {
      linkSync(candidate, path)
    } catch (cause) {
      if (
        !(typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'EEXIST')
      )
        throw cause
    }
    unlinkSync(candidate)
    fsyncParent(path)
  } catch (cause) {
    if (cause instanceof WorkspaceError) throw cause
    unavailable(`Cannot durably publish workspace authority database ${path}: ${errorText(cause)}`)
  } finally {
    try {
      db?.close()
    } catch {
      /* preserve the original failure */
    }
    if (fd !== undefined) closeSync(fd)
    const candidateInfo = lstatIfExists(candidate)
    if (candidateInfo !== undefined && candidateInfo.isFile() && !candidateInfo.isSymbolicLink())
      unlinkSync(candidate)
  }
}

const databaseFile = (path: string): void => {
  privateFile(path)
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecar = lstatIfExists(`${path}${suffix}`)
    if (
      sidecar !== undefined &&
      (!sidecar.isFile() ||
        sidecar.isSymbolicLink() ||
        sidecar.uid !== effectiveUid() ||
        (sidecar.mode & 0o077) !== 0)
    )
      unavailable(`Unsafe SQLite sidecar: ${path}${suffix}`)
  }
}
const configureRecordDb = (db: DatabaseSync, path: string, kind: 'catalog' | 'shard'): void => {
  db.exec(
    `PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL; PRAGMA fullfsync = ON; PRAGMA wal_autocheckpoint = 1000;`
  )
  const journal = textField(first(db, 'PRAGMA journal_mode'), 'journal_mode')
  if (journal.toLowerCase() !== 'wal')
    unavailable(`Workspace ${kind} database is not in WAL mode: ${path}`)
  const synchronous = numberField(first(db, 'PRAGMA synchronous'), 'synchronous')
  const fullfsync = numberField(first(db, 'PRAGMA fullfsync'), 'fullfsync')
  if (synchronous !== 2 || fullfsync !== 1)
    unavailable(`Workspace ${kind} database has unsafe durability settings: ${path}`)
  const version = numberField(first(db, 'PRAGMA user_version'), 'user_version')
  if (version !== SCHEMA_VERSION || schemaCatalog(db) !== expectedCatalog(schemaFor(kind)))
    unavailable(`Workspace ${kind} database has an unsupported schema: ${path}`)
  if (textField(first(db, 'PRAGMA integrity_check'), 'integrity_check') !== 'ok')
    requireReview(`Workspace ${kind} database is corrupt: ${path}`)
  databaseFile(path)
}
const openRecordDb = (
  path: string,
  kind: 'catalog' | 'shard',
  create: boolean,
  initialize: (db: DatabaseSync) => void
): DatabaseSync => {
  try {
    const existed = lstatIfExists(path) !== undefined
    if (!existed) {
      if (!create) unavailable(`Workspace authority database is missing: ${path}`)
      createPublishedDatabase(path, kind, initialize)
    }
    databaseFile(path)
    const db = new DatabaseSync(path, {
      timeout: BUSY_TIMEOUT_MS,
      allowExtension: false,
      enableForeignKeyConstraints: true,
    })
    try {
      if (!existed) {
        const mode = textField(first(db, 'PRAGMA journal_mode = WAL'), 'journal_mode')
        if (mode.toLowerCase() !== 'wal')
          unavailable(`Cannot enable WAL for new workspace database: ${path}`)
      }
      configureRecordDb(db, path, kind)
      return db
    } catch (cause) {
      db.close()
      throw cause
    }
  } catch (cause) {
    if (cause instanceof WorkspaceError) throw cause
    if (
      typeof cause === 'object' &&
      cause !== null &&
      'errcode' in cause &&
      (cause.errcode === 5 || cause.errcode === 6)
    )
      blocked(`Workspace authority database is busy: ${path}`)
    unavailable(`Cannot open workspace authority database ${path}: ${errorText(cause)}`)
  }
}
const transaction = <A>(db: DatabaseSync, operation: () => A): A => {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    db.exec('COMMIT')
    return result
  } catch (cause) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* commit outcome may be uncertain; never grant on this path */
    }
    throw cause
  }
}

const createProtocolDatabase = (path: string, namespaceId: string): void =>
  createPublishedDatabase(path, 'protocol', db => {
    db.prepare('INSERT INTO protocol_marker(id, version, namespace_id) VALUES(1, ?, ?)').run(
      PROTOCOL_VERSION,
      namespaceId
    )
  })
const createCatalogDatabase = (path: string, namespaceId: string): void => {
  createPublishedDatabase(path, 'catalog', db => {
    db.prepare('INSERT INTO catalog_meta(key, value) VALUES(?, ?)').run('namespace_id', namespaceId)
    db.prepare('INSERT INTO catalog_meta(key, value) VALUES(?, ?)').run(
      'protocol_version',
      String(PROTOCOL_VERSION)
    )
  })
  // Catalog data is durably published in DELETE mode first; only then switch the
  // complete record database to WAL. Never reset an existing database here.
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(path, { timeout: 0, allowExtension: false })
    db.exec('PRAGMA synchronous = FULL; PRAGMA fullfsync = ON;')
    const mode = textField(first(db, 'PRAGMA journal_mode = WAL'), 'journal_mode')
    if (mode.toLowerCase() !== 'wal')
      unavailable(`Cannot enable WAL for new workspace catalog: ${path}`)
    db.exec('PRAGMA synchronous = FULL; PRAGMA fullfsync = ON;')
    db.close()
    db = undefined
    fsyncPath(path, false)
    fsyncParent(path)
    databaseFile(path)
  } catch (cause) {
    if (cause instanceof WorkspaceError) throw cause
    unavailable(`Cannot durably enable WAL for workspace catalog ${path}: ${errorText(cause)}`)
  } finally {
    db?.close()
  }
}
interface AuthorityPaths {
  readonly root: string
  readonly protocol: string
  readonly catalog: string
  readonly repos: string
  readonly gates: string
  readonly worktrees: string
}
const makePaths = (root: string): AuthorityPaths => ({
  root,
  protocol: join(root, 'protocol.sqlite'),
  catalog: join(root, 'catalog.sqlite'),
  repos: join(root, 'repos'),
  gates: join(root, 'gates'),
  worktrees: join(root, 'worktrees'),
})

const validateProtocol = (path: string, namespaceId?: string): string => {
  privateFile(path)
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(path, { timeout: 0, allowExtension: false })
    db.exec('PRAGMA busy_timeout = 0; PRAGMA synchronous = FULL; PRAGMA fullfsync = ON;')
    if (textField(first(db, 'PRAGMA journal_mode'), 'journal_mode').toLowerCase() !== 'delete')
      unavailable(`Workspace protocol gate has an unsupported journal mode: ${path}`)
    if (
      numberField(first(db, 'PRAGMA user_version'), 'user_version') !== SCHEMA_VERSION ||
      schemaCatalog(db) !== expectedCatalog(PROTOCOL_SQL)
    )
      unavailable(`Workspace protocol gate has an unsupported schema: ${path}`)
    const row = first(db, 'SELECT version, namespace_id FROM protocol_marker WHERE id = 1')
    if (numberField(row, 'version') !== PROTOCOL_VERSION)
      unavailable(`Workspace protocol version mismatch at ${path}`)
    const actual = textField(row, 'namespace_id')
    if (!isUuid(actual) || (namespaceId !== undefined && namespaceId !== actual))
      requireReview(`Workspace protocol identity mismatch at ${path}`)
    return actual
  } catch (cause) {
    if (cause instanceof WorkspaceError) throw cause
    unavailable(`Cannot validate workspace protocol gate ${path}: ${errorText(cause)}`)
  } finally {
    db?.close()
  }
}

const gateDirectory = (
  paths: AuthorityPaths,
  family: 'paths' | 'repos' | 'conversations',
  key: string
): string => {
  const directory = join(paths.gates, family, key)
  privateDirectory(join(paths.gates, family), true)
  privateDirectory(directory, true)
  return directory
}

const publishGate = (path: string, kind: string, identityPath: string, key: string): void => {
  createPublishedDatabase(path, 'gate', db => {
    db.prepare('INSERT INTO gate_marker(id, version, kind, path, key) VALUES(1, ?, ?, ?, ?)').run(
      PROTOCOL_VERSION,
      kind,
      identityPath,
      key
    )
  })
}

const acquireGate = (
  path: string,
  kind: string,
  identityPath: string,
  key: string,
  exclusive: boolean,
  waitMs = exclusive ? 0 : SHARED_GATE_WAIT_MS
): GateRelease => {
  privateDirectory(dirname(path), false)
  if (lstatIfExists(path) === undefined) publishGate(path, kind, identityPath, key)
  privateFile(path)
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(path, { timeout: 0, allowExtension: false })
    // A waiting acquirer only ever waits out a momentary probe, never a holder.
    db.exec(`PRAGMA busy_timeout = ${waitMs}; PRAGMA synchronous = FULL; PRAGMA fullfsync = ON;`)
    if (
      textField(first(db, 'PRAGMA journal_mode'), 'journal_mode').toLowerCase() !== 'delete' ||
      numberField(first(db, 'PRAGMA user_version'), 'user_version') !== SCHEMA_VERSION ||
      schemaCatalog(db) !== expectedCatalog(GATE_SQL)
    )
      unavailable(`Workspace gate has an unsupported format: ${path}`)
    const marker = first(db, 'SELECT version, kind, path, key FROM gate_marker WHERE id=1')
    if (
      numberField(marker, 'version') !== PROTOCOL_VERSION ||
      textField(marker, 'kind') !== kind ||
      textField(marker, 'path') !== identityPath ||
      textField(marker, 'key') !== key
    )
      requireReview(
        `Workspace gate identity was replaced or does not match its canonical path: ${path}`
      )
    db.exec(exclusive ? 'BEGIN EXCLUSIVE' : 'BEGIN')
    if (textField(first(db, 'SELECT kind FROM gate_marker WHERE id=1'), 'kind') !== kind)
      requireReview(`Workspace gate marker changed while acquiring ${path}`)
    const locked = db
    db = undefined
    let released = false
    return () => {
      if (released) return
      try {
        locked.close()
        released = true
      } catch (cause) {
        unavailable(`Cannot release workspace gate ${path}: ${errorText(cause)}`)
      }
    }
  } catch (cause) {
    db?.close()
    if (cause instanceof WorkspaceError) throw cause
    if (sqliteCode(cause) === 5 || sqliteCode(cause) === 6)
      blocked(`Workspace ${kind === 'use' ? 'presence' : kind} gate is busy: ${identityPath}`)
    unavailable(`Cannot acquire workspace gate ${path}: ${errorText(cause)}`)
  }
}

const acquireProtocolGate = (path: string, root: string, namespaceId: string): GateRelease => {
  privateFile(path)
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(path, { timeout: 0, allowExtension: false })
    db.exec('PRAGMA busy_timeout = 0; PRAGMA synchronous = FULL; PRAGMA fullfsync = ON;')
    if (
      textField(first(db, 'PRAGMA journal_mode'), 'journal_mode').toLowerCase() !== 'delete' ||
      numberField(first(db, 'PRAGMA user_version'), 'user_version') !== SCHEMA_VERSION ||
      schemaCatalog(db) !== expectedCatalog(PROTOCOL_SQL)
    )
      unavailable(`Workspace protocol gate has an unsupported format: ${path}`)
    const marker = first(db, 'SELECT version, namespace_id FROM protocol_marker WHERE id=1')
    if (
      numberField(marker, 'version') !== PROTOCOL_VERSION ||
      textField(marker, 'namespace_id') !== namespaceId
    )
      requireReview(`Workspace protocol identity changed at ${path}`)
    db.exec('BEGIN')
    if (
      textField(
        first(db, 'SELECT namespace_id FROM protocol_marker WHERE id=1'),
        'namespace_id'
      ) !== namespaceId
    )
      requireReview(`Workspace protocol marker changed while joining ${root}`)
    const locked = db
    db = undefined
    let released = false
    return () => {
      if (released) return
      try {
        locked.close()
        released = true
      } catch (cause) {
        unavailable(`Cannot release protocol gate ${root}: ${errorText(cause)}`)
      }
    }
  } catch (cause) {
    db?.close()
    if (cause instanceof WorkspaceError) throw cause
    if (sqliteCode(cause) === 5 || sqliteCode(cause) === 6)
      blocked(`Workspace protocol gate is busy: ${root}`)
    unavailable(`Cannot acquire workspace protocol gate ${path}: ${errorText(cause)}`)
  }
}

interface PathGates {
  readonly use: GateRelease
  readonly writer?: GateRelease
}
const acquirePathGates = (paths: AuthorityPaths, path: string, writer: boolean): PathGates => {
  const canonical = canonicalPathSlot(path)
  const key = hash(canonical)
  const directory = gateDirectory(paths, 'paths', key)
  const presence = acquireGate(join(directory, 'use.sqlite'), 'use', canonical, key, false)
  try {
    if (!writer) return { use: presence }
    return {
      use: presence,
      writer: acquireGate(join(directory, 'writer.sqlite'), 'writer', canonical, key, true),
    }
  } catch (cause) {
    presence()
    throw cause
  }
}
const acquireStructureGate = (
  paths: AuthorityPaths,
  repository: GitWorkspace,
  repositoryId: string
): GateRelease => {
  const key = repositoryId
  const directory = gateDirectory(paths, 'repos', key)
  return acquireGate(
    join(directory, 'structure.sqlite'),
    'structure',
    repository.commonPath,
    key,
    true
  )
}
// A live conversation holds its gate for as long as any attachment keeps its state, so a
// free gate means no dev session anywhere on this account still runs the conversation.
const conversationGate = (
  paths: AuthorityPaths,
  conversationKey: string
): { readonly key: string; readonly path: string } => {
  const key = hash(conversationKey)
  return { key, path: join(paths.gates, 'conversations', key, 'conversation.sqlite') }
}
const acquireConversationGate = (paths: AuthorityPaths, conversationKey: string): GateRelease => {
  const gate = conversationGate(paths, conversationKey)
  gateDirectory(paths, 'conversations', gate.key)
  try {
    return acquireGate(
      gate.path,
      'conversation',
      conversationKey,
      gate.key,
      true,
      SHARED_GATE_WAIT_MS
    )
  } catch (cause) {
    if (cause instanceof WorkspaceError && cause.outcome === 'blocked')
      blocked('This conversation is open in another dev session; close it there first')
    throw cause
  }
}
const conversationHeld = (paths: AuthorityPaths, conversationKey: string): boolean => {
  const gate = conversationGate(paths, conversationKey)
  if (lstatIfExists(gate.path) === undefined) return false
  try {
    acquireGate(gate.path, 'conversation', conversationKey, gate.key, true)()
    return false
  } catch (cause) {
    if (cause instanceof WorkspaceError && cause.outcome === 'blocked') return true
    throw cause
  }
}
const releaseGates = (gates: PathGates): void => {
  gates.writer?.()
  gates.use()
}
const sameIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  left.device === right.device && left.inode === right.inode

const parseRepositoryCatalogRow = (row: SqlRow): RepositoryCatalogRecord => {
  const value = parseRecord(
    RepositoryCatalogSchema,
    row.payload,
    `repository catalog entry ${textField(row, 'id')}`
  )
  if (
    value.id !== textField(row, 'id') ||
    value.commonPath !== textField(row, 'common_path') ||
    value.device !== textField(row, 'device') ||
    value.inode !== textField(row, 'inode') ||
    value.objectFormat !== textField(row, 'object_format') ||
    value.state !== textField(row, 'state') ||
    value.provisionId !== textField(row, 'provision_id') ||
    value.revision !== numberField(row, 'revision')
  )
    requireReview(`Repository catalog columns disagree with payload: ${value.id}`)
  return value
}
const validateRepositoryRecord = (
  repository: GitWorkspace,
  row: SqlRow
): RepositoryCatalogRecord => {
  const value = parseRepositoryCatalogRow(row)
  if (
    value.commonPath !== repository.commonPath ||
    value.device !== repository.commonIdentity.device ||
    value.inode !== repository.commonIdentity.inode ||
    value.objectFormat !== repository.objectFormat
  )
    requireReview(`Git common-directory identity changed: ${repository.commonPath}`)
  return value
}

class WorkspaceAuthority {
  readonly paths: AuthorityPaths
  readonly root: string
  private namespaceId: string | undefined
  private protocolRelease: GateRelease | undefined
  private initialized = false
  private storageChecked = false
  private closed = false
  private readonly shardIds = new Set<string>()

  constructor(root: string) {
    this.root = canonicalRoot(root)
    this.paths = makePaths(this.root)
  }

  private checkStorage(): void {
    if (this.storageChecked) return
    assertSupportedStorage(this.root)
    this.storageChecked = true
  }

  initialize(): string {
    if (this.closed) unavailable('Workspace lifecycle is closed')
    if (this.initialized)
      return this.namespaceId ?? requireReview('Workspace namespace identity is missing')
    this.checkStorage()
    assertSqliteSafety()
    const rootInfo = lstatIfExists(this.root)
    if (rootInfo === undefined) {
      ensureDirectoryPath(dirname(this.root))
      privateDirectory(this.root, true)
    } else privateDirectory(this.root, false)
    const protocolExists = lstatIfExists(this.paths.protocol) !== undefined
    const catalogExists = lstatIfExists(this.paths.catalog) !== undefined
    privateDirectory(this.paths.repos, true)
    privateDirectory(this.paths.gates, true)
    privateDirectory(this.paths.worktrees, true)
    if (!protocolExists && !catalogExists) {
      const children = [this.paths.repos, this.paths.gates, this.paths.worktrees]
      const hasEvidence = children.some(directory => {
        try {
          return lstatSync(directory).isDirectory() && requireEntries(directory).length > 0
        } catch {
          return true
        }
      })
      if (hasEvidence)
        requireReview(`Workspace authority has data but no namespace markers: ${this.root}`)
      const candidateId = workspaceId()
      createProtocolDatabase(this.paths.protocol, candidateId)
      const id = validateProtocol(this.paths.protocol)
      createCatalogDatabase(this.paths.catalog, id)
    } else if (!protocolExists || !catalogExists) {
      requireReview(`Workspace authority has incomplete namespace markers: ${this.root}`)
    }
    const id = validateProtocol(this.paths.protocol)
    const acquired = acquireProtocolGate(this.paths.protocol, this.root, id)
    try {
      const catalog = this.openCatalog(false)
      try {
        const actual = textField(
          first(catalog, "SELECT value FROM catalog_meta WHERE key='namespace_id'"),
          'value'
        )
        const version = textField(
          first(catalog, "SELECT value FROM catalog_meta WHERE key='protocol_version'"),
          'value'
        )
        if (actual !== id || version !== String(PROTOCOL_VERSION))
          requireReview(`Workspace catalog does not match namespace ${this.root}`)
      } finally {
        catalog.close()
      }
    } catch (cause) {
      acquired()
      throw cause
    }
    this.namespaceId = id
    this.protocolRelease = acquired
    this.initialized = true
    return id
  }

  inspectExisting(): string | undefined {
    if (this.closed) unavailable('Workspace lifecycle is closed')
    this.checkStorage()
    const rootInfo = lstatIfExists(this.root)
    if (rootInfo === undefined) return undefined
    privateDirectory(this.root, false)
    const protocol = lstatIfExists(this.paths.protocol)
    const catalog = lstatIfExists(this.paths.catalog)
    if (protocol === undefined && catalog === undefined) {
      const entries = requireEntries(this.root)
      if (entries.length === 0) return undefined
      requireReview(`Workspace authority has files but no valid namespace markers: ${this.root}`)
    }
    if (protocol === undefined || catalog === undefined)
      requireReview(`Workspace authority is incomplete: ${this.root}`)
    const id = validateProtocol(this.paths.protocol)
    const release = acquireProtocolGate(this.paths.protocol, this.root, id)
    try {
      const db = this.openCatalog(false)
      try {
        if (
          textField(
            first(db, "SELECT value FROM catalog_meta WHERE key='namespace_id'"),
            'value'
          ) !== id ||
          textField(
            first(db, "SELECT value FROM catalog_meta WHERE key='protocol_version'"),
            'value'
          ) !== String(PROTOCOL_VERSION)
        )
          requireReview(`Workspace catalog does not match namespace ${this.root}`)
      } finally {
        db.close()
      }
    } finally {
      release()
    }
    return id
  }

  openCatalog(create: boolean): DatabaseSync {
    if (!this.initialized && create) this.initialize()
    const namespaceId =
      this.namespaceId ??
      (create
        ? requireReview('Workspace namespace is not initialized')
        : validateProtocol(this.paths.protocol))
    const db = openRecordDb(this.paths.catalog, 'catalog', create, candidate => {
      candidate
        .prepare('INSERT INTO catalog_meta(key, value) VALUES(?, ?)')
        .run('namespace_id', namespaceId)
      candidate
        .prepare('INSERT INTO catalog_meta(key, value) VALUES(?, ?)')
        .run('protocol_version', String(PROTOCOL_VERSION))
    })
    const actual = textField(
      first(db, "SELECT value FROM catalog_meta WHERE key='namespace_id'"),
      'value'
    )
    if (actual !== namespaceId) {
      db.close()
      requireReview(`Workspace catalog namespace identity changed: ${this.paths.catalog}`)
    }
    return db
  }

  shardPath(repositoryId: string): string {
    if (!isUuid(repositoryId)) invalid('Invalid repository ID')
    return join(this.paths.repos, repositoryId, 'records.sqlite')
  }

  openShard(repositoryId: string, create = false, repository?: GitWorkspace): DatabaseSync {
    if (!this.initialized && create) this.initialize()
    const path = this.shardPath(repositoryId)
    const directory = dirname(path)
    const catalog = this.openCatalog(false)
    let state: string
    let commonPath: string
    let device: string
    let inode: string
    let format: string
    try {
      const row = first(
        catalog,
        `SELECT id, common_path, device, inode, object_format, state, provision_id, revision, payload
        FROM repositories WHERE id=?`,
        repositoryId
      )
      if (row === undefined)
        unavailable(`Repository is not registered in workspace authority: ${repositoryId}`)
      const record = parseRepositoryCatalogRow(row)
      state = record.state
      commonPath = record.commonPath
      device = record.device
      inode = record.inode
      format = record.objectFormat
      if (state === 'ready' && lstatIfExists(path) === undefined)
        requireReview(`Ready repository shard is missing: ${path}`)
      if (state === 'provisioning' && !create && lstatIfExists(path) === undefined)
        requireReview(`Repository shard provisioning is incomplete: ${path}`)
      if (
        repository !== undefined &&
        (commonPath !== repository.commonPath ||
          device !== repository.commonIdentity.device ||
          inode !== repository.commonIdentity.inode ||
          format !== repository.objectFormat)
      )
        requireReview(`Repository identity changed for workspace shard ${repositoryId}`)
    } finally {
      catalog.close()
    }
    privateDirectory(directory, create && state === 'provisioning')
    const db = openRecordDb(path, 'shard', create && state === 'provisioning', candidate => {
      if (repository === undefined)
        requireReview(
          `Cannot initialize repository shard without its Git identity: ${repositoryId}`
        )
      const values: readonly [string, string][] = [
        ['repository_id', repositoryId],
        ['common_path', repository.commonPath],
        ['common_device', repository.commonIdentity.device],
        ['common_inode', repository.commonIdentity.inode],
        ['object_format', repository.objectFormat],
        ['protocol_version', String(PROTOCOL_VERSION)],
      ]
      const insert = candidate.prepare('INSERT INTO shard_meta(key, value) VALUES(?, ?)')
      for (const [key, value] of values) insert.run(key, value)
    })
    this.validateShardMeta(db, repositoryId, { commonPath, device, inode, format })
    if (state === 'provisioning') this.markRepositoryReady(repositoryId)
    this.shardIds.add(repositoryId)
    return db
  }

  private validateShardMeta(
    db: DatabaseSync,
    repositoryId: string,
    expected: { commonPath: string; device: string; inode: string; format: string }
  ): void {
    const values = new Map(
      rows(db, 'SELECT key, value FROM shard_meta').map(row => [
        textField(row, 'key'),
        textField(row, 'value'),
      ])
    )
    if (
      numberField(first(db, 'PRAGMA user_version'), 'user_version') !== SCHEMA_VERSION ||
      values.get('repository_id') !== repositoryId ||
      values.get('common_path') !== expected.commonPath ||
      values.get('common_device') !== expected.device ||
      values.get('common_inode') !== expected.inode ||
      values.get('object_format') !== expected.format ||
      values.get('protocol_version') !== String(PROTOCOL_VERSION)
    )
      requireReview(`Repository shard identity or schema mismatch: ${repositoryId}`)
  }

  private markRepositoryReady(repositoryId: string): void {
    const db = this.openCatalog(false)
    try {
      transaction(db, () => {
        const row = first(
          db,
          `SELECT id, common_path, device, inode, object_format, state, provision_id, revision, payload
          FROM repositories WHERE id=?`,
          repositoryId
        )
        if (row === undefined)
          requireReview(`Repository catalog mapping disappeared: ${repositoryId}`)
        const current = parseRepositoryCatalogRow(row)
        if (current.state === 'ready') return
        const ready: RepositoryCatalogRecord = {
          ...current,
          state: 'ready',
          revision: current.revision + 1,
        }
        db.prepare(`UPDATE repositories SET state=?, revision=?, payload=?
          WHERE id=? AND state='provisioning' AND revision=?`).run(
          ready.state,
          ready.revision,
          encode(ready),
          repositoryId,
          current.revision
        )
        if (numberField(first(db, 'SELECT changes() AS count'), 'count') !== 1)
          requireReview(`Cannot publish ready repository shard: ${repositoryId}`)
      })
    } finally {
      db.close()
    }
  }

  registerRepository(repository: GitWorkspace): string {
    this.initialize()
    const catalog = this.openCatalog(false)
    let registered: { readonly id: string; readonly state: string } | undefined
    let registrationConflict = false
    try {
      const byPath = first(
        catalog,
        'SELECT id, common_path, device, inode, object_format, state, provision_id, revision, payload FROM repositories WHERE common_path=?',
        repository.commonPath
      )
      const byPhysical = first(
        catalog,
        'SELECT id, common_path, device, inode, object_format, state, provision_id, revision, payload FROM repositories WHERE device=? AND inode=?',
        repository.commonIdentity.device,
        repository.commonIdentity.inode
      )
      if (byPath === undefined && byPhysical !== undefined)
        requireReview(
          `Repository common directory has an unrecognized path alias: ${repository.commonPath}`
        )
      if (byPath !== undefined) {
        if (byPhysical === undefined || textField(byPath, 'id') !== textField(byPhysical, 'id'))
          requireReview(`Repository physical identity changed: ${repository.commonPath}`)
        const record = validateRepositoryRecord(repository, byPath)
        registered = { id: record.id, state: record.state }
      } else {
        const candidateId = workspaceId()
        const provisionId = workspaceId()
        const payload = {
          id: candidateId,
          commonPath: repository.commonPath,
          device: repository.commonIdentity.device,
          inode: repository.commonIdentity.inode,
          objectFormat: repository.objectFormat,
          state: 'provisioning',
          provisionId,
          revision: 0,
        }
        transaction(catalog, () => {
          catalog
            .prepare(`INSERT INTO repositories(id, common_path, device, inode, object_format, state, provision_id, revision, payload)
            VALUES(?,?,?,?,?,'provisioning',?,0,?)`)
            .run(
              candidateId,
              repository.commonPath,
              repository.commonIdentity.device,
              repository.commonIdentity.inode,
              repository.objectFormat,
              provisionId,
              encode(payload)
            )
        })
        registered = { id: candidateId, state: 'provisioning' }
      }
    } catch (cause) {
      if (cause instanceof WorkspaceError) throw cause
      if (sqliteCode(cause) === 19) registrationConflict = true
      else unavailable(`Cannot register repository ${repository.commonPath}: ${errorText(cause)}`)
    } finally {
      catalog.close()
    }
    if (registrationConflict) {
      const retry = this.openCatalog(false)
      try {
        const byPath = first(
          retry,
          'SELECT id, common_path, device, inode, object_format, state, provision_id, revision, payload FROM repositories WHERE common_path=?',
          repository.commonPath
        )
        const byPhysical = first(
          retry,
          'SELECT id, common_path, device, inode, object_format, state, provision_id, revision, payload FROM repositories WHERE device=? AND inode=?',
          repository.commonIdentity.device,
          repository.commonIdentity.inode
        )
        if (
          byPath === undefined ||
          byPhysical === undefined ||
          textField(byPath, 'id') !== textField(byPhysical, 'id')
        )
          requireReview(
            `Repository identity conflicts with existing catalog data: ${repository.commonPath}`
          )
        const record = validateRepositoryRecord(repository, byPath)
        registered = { id: record.id, state: record.state }
      } finally {
        retry.close()
      }
    }
    if (registered === undefined)
      requireReview(
        `Repository registration produced no authoritative record: ${repository.commonPath}`
      )
    const repositoryId = registered.id
    const state = registered.state
    let structure: GateRelease | undefined
    try {
      if (state === 'provisioning')
        structure = acquireStructureGate(this.paths, repository, repositoryId)
      const currentCatalog = this.openCatalog(false)
      let currentState: string
      try {
        const current = first(
          currentCatalog,
          'SELECT state FROM repositories WHERE id=?',
          repositoryId
        )
        if (current === undefined)
          requireReview(`Repository catalog mapping disappeared: ${repositoryId}`)
        currentState = textField(current, 'state')
      } finally {
        currentCatalog.close()
      }
      if (currentState === 'ready') {
        const path = this.shardPath(repositoryId)
        if (lstatIfExists(path) === undefined)
          requireReview(`Ready repository shard is missing: ${path}`)
        const shard = this.openShard(repositoryId, false, repository)
        shard.close()
      } else if (currentState === 'provisioning') {
        privateDirectory(dirname(this.shardPath(repositoryId)), true)
        const shard = this.openShard(repositoryId, true, repository)
        shard.close()
      } else requireReview(`Invalid repository catalog state: ${repositoryId}`)
    } finally {
      structure?.()
    }
    return repositoryId
  }

  listRepositories(): readonly {
    readonly id: string
    readonly state: string
    readonly commonPath: string
  }[] {
    const db = this.openCatalog(false)
    try {
      return rows(
        db,
        `SELECT id, common_path, device, inode, object_format, state, provision_id, revision, payload
        FROM repositories ORDER BY id`
      ).map(row => {
        const record = parseRepositoryCatalogRow(row)
        if (record.state !== 'ready')
          requireReview(`Repository shard provisioning is unresolved: ${record.id}`)
        return { id: record.id, state: record.state, commonPath: record.commonPath }
      })
    } finally {
      db.close()
    }
  }

  private commit(): void {
    if (this.closed) return
    let cause: unknown
    try {
      this.protocolRelease?.()
    } catch (error) {
      cause = error
    }
    this.protocolRelease = undefined
    this.closed = true
    if (cause !== undefined) throw cause
  }

  close(): void {
    this.commit()
  }
}

const requireEntries = (directory: string): string[] => {
  try {
    return readdirSync(directory)
  } catch (cause) {
    if (isMissing(cause)) return []
    throw cause
  }
}

const decodeOrFail = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: unknown,
  label: string,
  outcome: 'invalid' | 'review-required' = 'review-required'
): S['Type'] => {
  try {
    return Schema.decodeUnknownSync(schema)(input)
  } catch {
    return outcome === 'invalid' ? invalid(`Invalid ${label}`) : requireReview(`Invalid ${label}`)
  }
}

const getTask = (db: DatabaseSync, id: string): TaskRecord | undefined => {
  const row = first(db, 'SELECT id, revision, payload FROM tasks WHERE id=?', id)
  if (row === undefined) return undefined
  const value = parseRecord(TaskSchema, row.payload, `task ${id}`)
  if (value.id !== textField(row, 'id') || value.revision !== numberField(row, 'revision'))
    requireReview(`Task columns disagree with payload: ${id}`)
  return value
}
const putTask = (db: DatabaseSync, value: TaskRecord): void => {
  const checked = decodeOrFail(TaskSchema, value, 'task record')
  db.prepare('INSERT INTO tasks(id, revision, payload) VALUES(?,?,?)').run(
    checked.id,
    checked.revision,
    encode(checked)
  )
}
const getWorkspace = (db: DatabaseSync, id: string): WorkspaceRecord | undefined => {
  const row = first(
    db,
    'SELECT id, path_key, path, origin, status, revision, payload FROM workspaces WHERE id=?',
    id
  )
  if (row === undefined) return undefined
  const value = parseRecord(WorkspaceSchema, row.payload, `workspace ${id}`)
  if (
    value.id !== textField(row, 'id') ||
    value.path !== textField(row, 'path') ||
    value.pathKey !== textField(row, 'path_key') ||
    value.origin !== textField(row, 'origin') ||
    value.status !== textField(row, 'status') ||
    value.revision !== numberField(row, 'revision')
  )
    requireReview(`Workspace columns disagree with payload: ${id}`)
  return value
}
const getWorkspaceByPath = (db: DatabaseSync, path: string): WorkspaceRecord | undefined => {
  const row = first(db, 'SELECT id FROM workspaces WHERE path_key=?', hash(canonicalPathSlot(path)))
  return row === undefined ? undefined : getWorkspace(db, textField(row, 'id'))
}
const putWorkspace = (db: DatabaseSync, value: WorkspaceRecord): void => {
  const checked = decodeOrFail(WorkspaceSchema, value, 'workspace record')
  db.prepare(
    'INSERT INTO workspaces(id,path_key,path,origin,status,revision,payload) VALUES(?,?,?,?,?,?,?)'
  ).run(
    checked.id,
    checked.pathKey,
    checked.path,
    checked.origin,
    checked.status,
    checked.revision,
    encode(checked)
  )
}
const getReservation = (
  db: DatabaseSync,
  workspaceIdValue: string
): ReservationRecord | undefined => {
  const row = first(
    db,
    'SELECT id,workspace_id,task_id,acquisition_id,revision,payload FROM reservations WHERE workspace_id=?',
    workspaceIdValue
  )
  if (row === undefined) return undefined
  const value = parseRecord(ReservationSchema, row.payload, `reservation ${textField(row, 'id')}`)
  if (
    value.id !== textField(row, 'id') ||
    value.workspaceId !== textField(row, 'workspace_id') ||
    value.taskId !== textField(row, 'task_id') ||
    (value.acquisitionId ?? null) !== (row.acquisition_id ?? null) ||
    value.revision !== numberField(row, 'revision')
  )
    requireReview(`Reservation columns disagree with payload: ${value.id}`)
  return value
}
const getReservationById = (db: DatabaseSync, id: string): ReservationRecord | undefined => {
  const row = first(db, 'SELECT workspace_id FROM reservations WHERE id=?', id)
  return row === undefined ? undefined : getReservation(db, textField(row, 'workspace_id'))
}
const putReservation = (db: DatabaseSync, value: ReservationRecord): void => {
  const checked = decodeOrFail(ReservationSchema, value, 'reservation record')
  db.prepare(
    'INSERT INTO reservations(id,workspace_id,task_id,acquisition_id,revision,payload) VALUES(?,?,?,?,?,?)'
  ).run(
    checked.id,
    checked.workspaceId,
    checked.taskId,
    checked.acquisitionId ?? null,
    checked.revision,
    encode(checked)
  )
}
const updateReservation = (db: DatabaseSync, value: ReservationRecord): void => {
  const checked = decodeOrFail(ReservationSchema, value, 'reservation record')
  db.prepare(
    'UPDATE reservations SET task_id=?,acquisition_id=?,revision=?,payload=? WHERE id=? AND workspace_id=?'
  ).run(
    checked.taskId,
    checked.acquisitionId ?? null,
    checked.revision,
    encode(checked),
    checked.id,
    checked.workspaceId
  )
  if (numberField(first(db, 'SELECT changes() AS count'), 'count') !== 1)
    requireReview(`Reservation disappeared: ${checked.id}`)
}
const getBinding = (db: DatabaseSync, key: string): BindingRecord | undefined => {
  const row = first(
    db,
    'SELECT conversation_key,workspace_id,task_id,revision,payload FROM bindings WHERE conversation_key=?',
    key
  )
  if (row === undefined) return undefined
  const value = parseRecord(BindingSchema, row.payload, `binding ${key}`)
  if (
    value.key !== textField(row, 'conversation_key') ||
    value.workspaceId !== textField(row, 'workspace_id') ||
    (value.taskId ?? null) !== (row.task_id ?? null) ||
    value.revision !== numberField(row, 'revision')
  )
    requireReview(`Binding columns disagree with payload: ${key}`)
  return value
}
const putBinding = (db: DatabaseSync, value: BindingRecord): void => {
  const checked = decodeOrFail(BindingSchema, value, 'conversation binding')
  db.prepare(`INSERT INTO bindings(conversation_key,workspace_id,task_id,revision,payload) VALUES(?,?,?,?,?)
    ON CONFLICT(conversation_key) DO UPDATE SET workspace_id=excluded.workspace_id,task_id=excluded.task_id,revision=excluded.revision,payload=excluded.payload`).run(
    checked.key,
    checked.workspaceId,
    checked.taskId ?? null,
    checked.revision,
    encode(checked)
  )
}
const getUse = (db: DatabaseSync, id: string): UseRecord | undefined => {
  const row = first(
    db,
    'SELECT id,workspace_id,task_id,reservation_id,acquisition_id,access,stage,revision,payload FROM uses WHERE id=?',
    id
  )
  if (row === undefined) return undefined
  const value = parseRecord(UseSchema, row.payload, `workspace use ${id}`)
  if (
    value.id !== textField(row, 'id') ||
    value.workspaceId !== textField(row, 'workspace_id') ||
    (value.taskId ?? null) !== (row.task_id ?? null) ||
    (value.reservationId ?? null) !== (row.reservation_id ?? null) ||
    (value.acquisitionId ?? null) !== (row.acquisition_id ?? null) ||
    value.access !== textField(row, 'access') ||
    value.stage !== textField(row, 'stage') ||
    value.revision !== numberField(row, 'revision')
  )
    requireReview(`Workspace use columns disagree with payload: ${id}`)
  return value
}
const putUse = (db: DatabaseSync, value: UseRecord): void => {
  const checked = decodeOrFail(UseSchema, value, 'workspace use')
  db.prepare(
    'INSERT INTO uses(id,workspace_id,task_id,reservation_id,acquisition_id,access,stage,revision,payload) VALUES(?,?,?,?,?,?,?,?,?)'
  ).run(
    checked.id,
    checked.workspaceId,
    checked.taskId ?? null,
    checked.reservationId ?? null,
    checked.acquisitionId ?? null,
    checked.access,
    checked.stage,
    checked.revision,
    encode(checked)
  )
}
const saveUse = (db: DatabaseSync, value: UseRecord): void => {
  const checked = decodeOrFail(UseSchema, value, 'workspace use')
  // Every settling route writes through here, so no route can miss these rules.
  // `unknown` records lost evidence that no later observation or host report can
  // restore; resolving it is an explicit recovery decision.
  const stored = getUse(db, checked.id)
  if (stored?.stage === 'unknown' && checked.stage !== 'unknown')
    requireReview(`Workspace use ${checked.id} is unknown; only explicit recovery can resolve it`)
  if (checked.stage === 'quiescent')
    assertNoActiveDependentUseInDb(db, checked.id, `Cannot settle workspace use ${checked.id}`)
  db.prepare(
    'UPDATE uses SET workspace_id=?,task_id=?,reservation_id=?,acquisition_id=?,access=?,stage=?,revision=?,payload=? WHERE id=?'
  ).run(
    checked.workspaceId,
    checked.taskId ?? null,
    checked.reservationId ?? null,
    checked.acquisitionId ?? null,
    checked.access,
    checked.stage,
    checked.revision,
    encode(checked),
    checked.id
  )
  if (numberField(first(db, 'SELECT changes() AS count'), 'count') !== 1)
    requireReview(`Workspace use disappeared: ${checked.id}`)
}
const getOperation = (db: DatabaseSync, id: string): OperationRecord | undefined => {
  const row = first(
    db,
    'SELECT id,kind,phase,workspace_id,task_id,revision,payload FROM operations WHERE id=?',
    id
  )
  if (row === undefined) return undefined
  const value = parseRecord(OperationSchema, row.payload, `operation ${id}`)
  if (
    value.id !== textField(row, 'id') ||
    value.kind !== textField(row, 'kind') ||
    value.phase !== textField(row, 'phase') ||
    value.workspaceId !== textField(row, 'workspace_id') ||
    value.taskId !== textField(row, 'task_id') ||
    value.expectedBindingRevision !== numberField(row, 'revision')
  )
    requireReview(`Operation columns disagree with payload: ${id}`)
  return value
}
const putOperation = (db: DatabaseSync, value: OperationRecord): void => {
  const checked = decodeOrFail(OperationSchema, value, 'workspace operation')
  db.prepare(
    'INSERT INTO operations(id,kind,phase,workspace_id,task_id,revision,created_at,payload) VALUES(?,?,?,?,?,?,?,?)'
  ).run(
    checked.id,
    checked.kind,
    checked.phase,
    checked.workspaceId,
    checked.taskId,
    checked.expectedBindingRevision,
    checked.createdAt,
    encode(checked)
  )
}
const saveOperation = (db: DatabaseSync, value: OperationRecord): void => {
  const checked = decodeOrFail(OperationSchema, value, 'workspace operation')
  db.prepare(
    'UPDATE operations SET kind=?,phase=?,workspace_id=?,task_id=?,revision=?,created_at=?,payload=? WHERE id=?'
  ).run(
    checked.kind,
    checked.phase,
    checked.workspaceId,
    checked.taskId,
    checked.expectedBindingRevision,
    checked.createdAt,
    encode(checked),
    checked.id
  )
  if (numberField(first(db, 'SELECT changes() AS count'), 'count') !== 1)
    requireReview(`Workspace operation disappeared: ${checked.id}`)
}
const getUseRows = (db: DatabaseSync, workspaceIdValue: string): UseRecord[] =>
  rows(db, 'SELECT id FROM uses WHERE workspace_id=? ORDER BY id', workspaceIdValue)
    .map(row => getUse(db, textField(row, 'id')))
    .filter((value): value is UseRecord => value !== undefined)
const getAllUseRows = (db: DatabaseSync): UseRecord[] =>
  rows(db, 'SELECT id FROM uses ORDER BY id')
    .map(row => getUse(db, textField(row, 'id')))
    .filter((value): value is UseRecord => value !== undefined)
// Scoped uses are admitted within an ordinary grant, whose gates they write under, so
// that grant cannot settle while one of them is live.
const activeDependentUses = (db: DatabaseSync, useIdValue: string): UseRecord[] =>
  getAllUseRows(db).filter(row => row.withinUseId === useIdValue && isActiveUse(row))
const assertNoActiveDependentUseInDb = (
  db: DatabaseSync,
  useIdValue: string,
  action: string
): void => {
  const dependents = activeDependentUses(db, useIdValue)
  if (dependents.length > 0)
    blocked(
      `${action} while dependent scoped operations remain live: ${dependents
        .map(use => `${use.id} (${use.effect ?? 'ordinary'}/${use.stage})`)
        .join(', ')}`
    )
}
const assertWithinLiveInDb = (db: DatabaseSync, use: UseRecord): void => {
  if (use.withinUseId === undefined) return
  const parent = getUse(db, use.withinUseId)
  if (parent === undefined)
    requireReview(`Scoped operation lost its within grant: ${use.withinUseId}`)
  if (parent.stage !== 'authorized')
    blocked(`Scoped operation cannot start under a ${parent.stage} within grant: ${parent.id}`)
}

const assessWorkspace = (input: {
  readonly identityReason: string | undefined
  readonly pending: { readonly id: string; readonly stage: string } | undefined
  readonly unresolved: boolean
  readonly unknown: boolean
  readonly live: boolean
  readonly abandoned: readonly string[]
  readonly reserved: boolean
}): Pick<WorkspaceView, 'outcome' | 'reason' | 'nextAction'> => {
  const operation =
    input.pending === undefined
      ? undefined
      : `Operation ${input.pending.id} is ${input.pending.stage}; inspection does not replay it.`
  if (input.identityReason !== undefined || input.unresolved)
    return {
      outcome: 'review-required',
      reason: input.identityReason ?? operation ?? 'An operation outcome is unresolved.',
      nextAction: 'Inspect the exact identity/operation; do not retry effects automatically.',
    }
  if (input.unknown)
    return {
      outcome: 'blocked',
      reason: operation ?? 'A persisted workspace use is unresolved.',
      nextAction: 'Wait for a directly observed safe boundary or require explicit recovery.',
    }
  if (input.abandoned.length > 0)
    return {
      outcome: 'blocked',
      reason:
        operation ??
        `Uses ${input.abandoned.join(', ')} were left unsettled by conversations no dev session holds; processes they started may still run.`,
      nextAction:
        'Do not reuse it for writing; explicit recovery of abandoned uses is not available yet.',
    }
  if (input.live)
    return {
      outcome: 'active',
      reason: operation ?? 'A persisted workspace use is still active.',
      nextAction: 'Do not take this workspace from its current user.',
    }
  if (input.reserved)
    return {
      outcome: 'preserved-for-resume',
      reason: operation ?? 'Task reservation is retained for explicit resume.',
      nextAction: 'Resume only by exact task/workspace selection.',
    }
  return {
    outcome: 'preserved-for-resume',
    reason: operation ?? 'Registered checkout; no exclusive task reservation is held.',
    nextAction: 'Select or create a task before requesting write access.',
  }
}

const makeWorkspaceRecord = (
  repositoryId: string,
  git: GitWorkspace,
  origin: 'pre-existing' | 'managed',
  id = workspaceId(),
  allocationOperationId?: string
): WorkspaceRecord =>
  decodeOrFail(
    WorkspaceSchema,
    {
      id,
      repositoryId,
      path: git.path,
      pathKey: hash(git.path),
      physical: git.identity,
      gitAdminPath: git.gitAdminPath,
      gitAdmin: git.gitAdminIdentity,
      commonPath: git.commonPath,
      common: git.commonIdentity,
      objectFormat: git.objectFormat,
      origin,
      status: 'ready',
      ...(allocationOperationId === undefined ? {} : { allocationOperationId }),
      revision: 0,
      createdAt: now(),
    },
    'Git workspace identity'
  )
const validateWorkspacePath = (record: WorkspaceRecord): GitWorkspace => {
  if (record.status !== 'ready')
    return requireReview(`Workspace allocation is unresolved: ${record.path}`)
  let actual: GitWorkspace
  try {
    actual = canonicalGitWorkspace(record.path)
  } catch (cause) {
    return requireReview(`Cannot verify workspace ${record.path}: ${errorText(cause)}`)
  }
  if (
    actual.path !== record.path ||
    !sameIdentity(actual.identity, record.physical) ||
    actual.gitAdminPath !== record.gitAdminPath ||
    !sameIdentity(actual.gitAdminIdentity, record.gitAdmin) ||
    actual.commonPath !== record.commonPath ||
    !sameIdentity(actual.commonIdentity, record.common) ||
    actual.objectFormat !== record.objectFormat
  )
    return requireReview(`Workspace path or Git identity was replaced: ${record.path}`)
  return actual
}
const conversationRecord = (
  input: WorkspaceConversation
): { readonly conversation: WorkspaceConversation; readonly key: string } => {
  if (!input.sessionId || !input.sessionFile || !input.dataHome)
    invalid('Conversation identity is incomplete')
  const sessionPath = resolve(input.sessionFile)
  const sessionInfo = lstatIfExists(sessionPath)
  let sessionFile: string
  if (sessionInfo !== undefined) {
    if (!sessionInfo.isFile() || sessionInfo.isSymbolicLink() || sessionInfo.nlink !== 1)
      requireReview(`Conversation file is not a regular, uniquely linked file: ${sessionPath}`)
    sessionFile = realpathSync(sessionPath)
  } else sessionFile = resolve(realpathSync(dirname(sessionPath)), basename(sessionPath))
  const dataHome = realpathSync(resolve(input.dataHome))
  if (!statSync(dataHome).isDirectory())
    invalid(`Conversation data home is not a directory: ${dataHome}`)
  const conversation = { sessionId: input.sessionId, sessionFile, dataHome }
  return { conversation, key: hash(JSON.stringify(conversation)) }
}

const toBinding = (record: BindingRecord): WorkspaceBinding => ({
  conversation: record.conversation,
  ...(record.taskId === undefined ? {} : { taskId: record.taskId }),
  workspaceId: record.workspaceId,
  cwd: record.cwd,
  revision: record.revision,
})
const toGrant = (
  authority: WorkspaceAuthority,
  repo: string,
  workspace: WorkspaceRecord,
  use: UseRecord,
  cwd: string,
  access: 'read' | 'write'
): WorkspaceGrant =>
  decodeOrFail(
    WorkspaceGrantSchema,
    {
      namespaceId: authority.initialize(),
      repositoryId: repo,
      workspaceId: workspace.id,
      useId: use.id,
      ...(use.acquisitionId === undefined ? {} : { acquisitionId: use.acquisitionId }),
      ...(use.reservationId === undefined ? {} : { reservationId: use.reservationId }),
      ...(use.taskId === undefined ? {} : { taskId: use.taskId }),
      revision: use.bindingRevision,
      cwd,
      checkout: workspace.path,
      access,
      origin: workspace.origin,
      ...(use.operationPath === undefined ? {} : { path: use.operationPath }),
    },
    'workspace grant'
  )
const inDb = <A>(
  authority: WorkspaceAuthority,
  repo: string,
  callback: (db: DatabaseSync) => A,
  create = false,
  git?: GitWorkspace
): A => {
  const db = authority.openShard(repo, create, git)
  try {
    return callback(db)
  } finally {
    db.close()
  }
}
const taskWorkspaces = (
  authority: WorkspaceAuthority,
  taskId: string
): { repo: string; reservation: ReservationRecord; workspace: WorkspaceRecord }[] => {
  const result: { repo: string; reservation: ReservationRecord; workspace: WorkspaceRecord }[] = []
  for (const repository of authority.listRepositories()) {
    inDb(authority, repository.id, db => {
      for (const row of rows(
        db,
        'SELECT id FROM reservations WHERE task_id=? ORDER BY id',
        taskId
      )) {
        const reservation = getReservationById(db, textField(row, 'id'))
        if (reservation === undefined || reservation.taskId !== taskId)
          requireReview(`Task reservation is inconsistent: ${taskId}`)
        const workspace = getWorkspace(db, reservation.workspaceId)
        if (workspace === undefined)
          requireReview(`Reserved workspace is missing: ${reservation.workspaceId}`)
        result.push({ repo: repository.id, reservation, workspace })
      }
    })
  }
  return result
}
const findBinding = (
  authority: WorkspaceAuthority,
  key: string
): { repo: string; binding: BindingRecord } | undefined => {
  const matches: { repo: string; binding: BindingRecord }[] = []
  for (const repository of authority.listRepositories()) {
    inDb(authority, repository.id, db => {
      const binding = getBinding(db, key)
      if (binding !== undefined && binding.superseded !== true)
        matches.push({ repo: repository.id, binding })
    })
  }
  if (matches.length > 1)
    requireReview(`Conversation has multiple authoritative workspace bindings: ${key}`)
  return matches[0]
}
const isActiveUse = (use: UseRecord): boolean => use.stage !== 'quiescent'
const validExecution = (input: WorkspaceExecution): WorkspaceExecution =>
  decodeOrFail(ExecutionSchema, input, 'workspace execution identity', 'invalid')
const validExecutionFact = (input: unknown): WorkspaceExecutionFact =>
  decodeOrFail(ExecutionFactSchema, input, 'execution fact', 'invalid')

interface GrantLease {
  readonly grant: WorkspaceGrant
  readonly repositoryId: string
  readonly useId: string
  readonly effect?: WorkspaceOperation['effect']
  readonly withinUseId?: string
  gates?: PathGates
  readonly borrowed: boolean
  readonly isExecution: boolean
  readonly execution?: WorkspaceExecution
  released: boolean
}
interface GateIntent {
  readonly repositoryId: string
  readonly workspaceId: string
  readonly path: string
  readonly writer: boolean
}
interface HeldPathGate extends GateIntent {
  readonly gates: PathGates
}
interface PendingTransition {
  readonly handoff: WorkspaceHandoff
  readonly sourceRepositoryId: string
  readonly targetRepositoryId: string
  readonly targetBinding: BindingRecord
  readonly targetLease: GrantLease
  readonly previousWriteGrant: WorkspaceGrant | undefined
  phase: 'intent' | 'started' | 'confirmed' | 'cancelled' | 'unknown'
}
interface ConversationState {
  readonly key: string
  readonly conversation: WorkspaceConversation
  binding: BindingRecord
  repositoryId: string
  readonly leases: Map<string, GrantLease>
  readonly leaseAttachments: Map<string, Set<string>>
  readonly extraGates: HeldPathGate[]
  refs: number
  parked: boolean
  closing: boolean
  pending?: PendingTransition
  writeGrant?: WorkspaceGrant
  readonly releaseConversation: () => void
}

// The worker's side of an attachment; clients reach it through the lifecycle's RPC.
export type EngineAttachment = WorkspaceAttachmentImpl

class WorkspaceAttachmentImpl {
  private readonly engine: WorkspaceEngine
  readonly state: ConversationState
  readonly token = workspaceId()
  readonly targetOperationId?: string
  private done = false

  constructor(engine: WorkspaceEngine, state: ConversationState, targetOperationId?: string) {
    this.engine = engine
    this.state = state
    this.targetOperationId = targetOperationId
    state.refs += 1
  }

  get binding(): WorkspaceBinding {
    const pending = this.state.pending
    return toBinding(
      pending !== undefined && this.targetOperationId === pending.handoff.operationId
        ? pending.targetBinding
        : this.state.binding
    )
  }
  authorize(operation: WorkspaceOperation): Promise<WorkspaceAuthorization> {
    return this.engine.authorize(this, operation)
  }
  select(selection: WorkspaceSelection): Promise<WorkspaceHandoff> {
    return this.engine.select(this, selection)
  }
  reportExecution(grant: WorkspaceGrant, fact: WorkspaceExecutionFact): Promise<void> {
    return this.engine.reportExecution(this, grant, fact)
  }
  handoff(
    transition: WorkspaceHandoff,
    replace: (target: WorkspaceGrant) => Promise<'confirmed' | 'cancelled'>
  ): Promise<void> {
    return this.engine.handoff(this, transition, replace)
  }
  close(): Promise<void> {
    if (this.done) return Promise.resolve()
    this.done = true
    return this.engine.closeAttachment(this)
  }
  assertOpen(): void {
    if (this.done) blocked('Workspace attachment is closed')
  }
}

export class WorkspaceEngine {
  private readonly authority: WorkspaceAuthority
  private readonly states = new Map<string, ConversationState>()
  private lifecycleClosed = false

  constructor(root: string) {
    this.authority = new WorkspaceAuthority(root)
  }

  private reject(cause: unknown): Promise<never> {
    try {
      this.translate(cause)
    } catch (translated) {
      return Promise.reject(translated)
    }
    return Promise.reject(new Error('Unreachable workspace error translation'))
  }
  private guard<A>(work: () => A | Promise<A>): Promise<A> {
    try {
      this.ensureOpen()
      return Promise.resolve(work()).catch(cause => this.translate(cause))
    } catch (cause) {
      return this.reject(cause)
    }
  }
  private translate(cause: unknown): never {
    if (cause instanceof WorkspaceError) throw cause
    unavailable(`Workspace authority operation failed: ${errorText(cause)}`)
  }
  private ensureOpen(): void {
    if (this.lifecycleClosed) blocked('Workspace lifecycle is closed')
  }
  private claimGrant(attachment: WorkspaceAttachmentImpl, grant: WorkspaceGrant): void {
    const owners = attachment.state.leaseAttachments.get(grant.useId) ?? new Set<string>()
    owners.add(attachment.token)
    attachment.state.leaseAttachments.set(grant.useId, owners)
  }

  attach(input: {
    conversation: WorkspaceConversation
    cwd: string
    selection?: WorkspaceSelection
  }): Promise<EngineAttachment> {
    return this.guard(() => this.attachUnsafe(input))
  }
  private attachUnsafe(input: {
    conversation: WorkspaceConversation
    cwd: string
    selection?: WorkspaceSelection
  }): EngineAttachment {
    this.authority.initialize()
    if (!isAbsolute(input.cwd)) invalid('Workspace cwd must be absolute')
    const normalized = conversationRecord(input.conversation)
    const live = this.states.get(normalized.key)
    if (live !== undefined) {
      const pending = live.pending
      if (pending !== undefined) {
        const selected = input.selection
        const selectionMatches =
          selected === undefined ||
          (selected.taskId === pending.handoff.target.taskId &&
            selected.workspaceId === pending.handoff.target.workspaceId)
        if (selectionMatches && canonicalPathSlot(input.cwd) === pending.handoff.target.checkout)
          return new WorkspaceAttachmentImpl(this, live, pending.handoff.operationId)
        requireReview('A pending live workspace handoff can only reopen its exact destination')
      }
      if (input.selection !== undefined) {
        const selection = this.resolveSelection(input.selection)
        if (
          selection.repo === live.repositoryId &&
          selection.workspace.id === live.binding.workspaceId &&
          selection.reservation.taskId === live.binding.taskId
        )
          return new WorkspaceAttachmentImpl(this, live)
        requireReview('A live attachment cannot be moved without its host handoff')
      }
      return new WorkspaceAttachmentImpl(this, live)
    }

    const releaseConversation = acquireConversationGate(this.authority.paths, normalized.key)
    try {
      let previous = findBinding(this.authority, normalized.key)
      const pendingOperationId = previous?.binding.pendingOperationId
      // Holding the conversation gate proves no host anywhere still performs its switch.
      if (previous !== undefined && pendingOperationId !== undefined) {
        if (!this.retireUnstartedTransition(pendingOperationId))
          requireReview(
            `The last workspace switch of this conversation (${pendingOperationId}) may have reached the host, so it cannot be resumed until explicit recovery exists; its history is unchanged`
          )
        const { repo } = previous
        const kept = inDb(this.authority, repo, db =>
          transaction(db, () => {
            const current = getBinding(db, normalized.key)
            if (current === undefined || current.pendingOperationId !== pendingOperationId)
              requireReview('Conversation binding changed while its unstarted switch was withdrawn')
            const withdrawn = { ...current, pendingOperationId: undefined }
            putBinding(db, withdrawn)
            return withdrawn
          })
        )
        previous = { repo, binding: kept }
      }
      let repoId: string
      let binding: BindingRecord
      if (input.selection !== undefined) {
        const selected = this.resolveSelection(input.selection)
        this.validateWorkspace(selected.workspace)
        this.ensureNoUnresolvedUse(selected.repo, selected.workspace.id)
        const probe = acquirePathGates(this.authority.paths, selected.workspace.path, true)
        releaseGates(probe)
        binding = decodeOrFail(
          BindingSchema,
          {
            key: normalized.key,
            conversation: normalized.conversation,
            taskId: selected.reservation.taskId,
            workspaceId: selected.workspace.id,
            cwd: selected.workspace.path,
            revision: (previous?.binding.revision ?? -1) + 1,
          },
          'explicit task binding'
        )
        if (previous === undefined) {
          inDb(this.authority, selected.repo, db => transaction(db, () => putBinding(db, binding)))
        } else if (previous.repo === selected.repo) {
          inDb(this.authority, selected.repo, db =>
            transaction(db, () => {
              const current = getBinding(db, normalized.key)
              if (current === undefined || current.revision !== previous.binding.revision)
                requireReview('Conversation binding changed during explicit recovery')
              putBinding(db, binding)
            })
          )
        } else {
          inDb(this.authority, previous.repo, db =>
            transaction(db, () => {
              const current = getBinding(db, normalized.key)
              if (current === undefined || current.revision !== previous.binding.revision)
                requireReview('Conversation binding changed during explicit recovery')
              putBinding(db, { ...current, superseded: true, pendingOperationId: undefined })
            })
          )
          inDb(this.authority, selected.repo, db => transaction(db, () => putBinding(db, binding)))
        }
        repoId = selected.repo
      } else if (previous !== undefined) {
        repoId = previous.repo
        binding = previous.binding
        const workspace = inDb(this.authority, repoId, db => getWorkspace(db, binding.workspaceId))
        if (workspace === undefined)
          requireReview(`Confirmed conversation workspace is missing: ${binding.workspaceId}`)
        if (lstatIfExists(workspace.path) === undefined)
          requireReview(
            `The workspace bound to this conversation no longer exists and is not recreated: ${workspace.path}`
          )
        this.validateWorkspace(workspace)
      } else {
        const git = canonicalGitWorkspace(input.cwd)
        repoId = this.authority.registerRepository(git)
        const workspace = this.registerWorkspace(repoId, git, 'pre-existing')
        const actualCwd = realpathSync(resolve(input.cwd))
        if (!isWithin(workspace.path, actualCwd))
          invalid(`Conversation cwd is outside its Git checkout: ${input.cwd}`)
        binding = decodeOrFail(
          BindingSchema,
          {
            key: normalized.key,
            conversation: normalized.conversation,
            workspaceId: workspace.id,
            cwd: actualCwd,
            revision: 0,
          },
          'new conversation binding'
        )
        inDb(this.authority, repoId, db => transaction(db, () => putBinding(db, binding)))
      }
      const state: ConversationState = {
        key: normalized.key,
        conversation: normalized.conversation,
        binding,
        repositoryId: repoId,
        leases: new Map(),
        leaseAttachments: new Map(),
        extraGates: [],
        refs: 0,
        parked: false,
        closing: false,
        releaseConversation,
      }
      this.states.set(normalized.key, state)
      return new WorkspaceAttachmentImpl(this, state)
    } catch (cause) {
      releaseConversation()
      throw cause
    }
  }

  // A transition that never reached the host changed nothing, so it is withdrawn and the
  // last confirmed binding stands. One that started may have switched the host.
  private retireUnstartedTransition(operationId: string): boolean {
    let withdrawn = false
    for (const repository of this.authority.listRepositories()) {
      inDb(this.authority, repository.id, db =>
        transaction(db, () => {
          const operation = getOperation(db, operationId)
          if (operation?.phase === 'cancelled') withdrawn = true
          if (operation === undefined || operation.phase !== 'intent') return
          withdrawn = true
          for (const use of getUseRows(db, operation.workspaceId))
            if (
              use.acquisitionId === operation.acquisitionId &&
              use.execution === undefined &&
              use.effect === undefined &&
              use.stage === 'authorized'
            )
              saveUse(db, {
                ...use,
                stage: 'quiescent',
                reason: 'superseded-by-explicit-recovery-before-host-transition',
                revision: use.revision + 1,
                updatedAt: now(),
              })
          saveOperation(db, {
            ...operation,
            phase: 'cancelled',
            result: 'Superseded by an explicit recovery selection before the host acted.',
          })
        })
      )
    }
    return withdrawn
  }

  private resolveSelection(selection: WorkspaceSelection): {
    repo: string
    reservation: ReservationRecord
    workspace: WorkspaceRecord
  } {
    if (!isUuid(selection.taskId)) invalid('Task ID must be an exact UUID')
    if (selection.workspaceId !== undefined && !isUuid(selection.workspaceId))
      invalid('Workspace ID must be an exact UUID')
    const matches = taskWorkspaces(this.authority, selection.taskId)
    const selected =
      selection.workspaceId === undefined
        ? matches
        : matches.filter(item => item.workspace.id === selection.workspaceId)
    if (selected.length === 0) invalid(`No retained workspace matches task ${selection.taskId}`)
    if (selected.length > 1)
      ambiguous(`Task ${selection.taskId} has multiple workspaces; provide an exact workspace ID`)
    const result = selected[0]
    if (result === undefined) return invalid('Selected workspace is unavailable')
    return result
  }

  private validateWorkspace(workspace: WorkspaceRecord): GitWorkspace {
    const actual = validateWorkspacePath(workspace)
    if (workspace.origin === 'managed') {
      const base = resolve(this.authority.paths.worktrees, workspace.repositoryId)
      if (!isWithin(base, workspace.path) || workspace.path === base)
        requireReview(`Managed workspace escaped its allocation root: ${workspace.path}`)
    }
    return actual
  }

  private registerWorkspace(
    repo: string,
    git: GitWorkspace,
    origin: 'pre-existing' | 'managed'
  ): WorkspaceRecord {
    return inDb(
      this.authority,
      repo,
      db =>
        transaction(db, () => {
          const existing = getWorkspaceByPath(db, git.path)
          if (existing !== undefined) {
            this.assertWorkspaceMatches(existing, git)
            if (existing.status !== 'ready')
              requireReview(`Workspace allocation is unresolved: ${existing.path}`)
            return existing
          }
          const record = makeWorkspaceRecord(repo, git, origin)
          putWorkspace(db, record)
          return record
        }),
      true,
      git
    )
  }
  private assertWorkspaceMatches(record: WorkspaceRecord, git: GitWorkspace): void {
    if (
      record.path !== git.path ||
      !sameIdentity(record.physical, git.identity) ||
      record.gitAdminPath !== git.gitAdminPath ||
      !sameIdentity(record.gitAdmin, git.gitAdminIdentity) ||
      record.commonPath !== git.commonPath ||
      !sameIdentity(record.common, git.commonIdentity) ||
      record.objectFormat !== git.objectFormat
    )
      requireReview(`Workspace path slot was replaced: ${record.path}`)
  }

  private currentSource(state: ConversationState): {
    repo: string
    binding: BindingRecord
    workspace: WorkspaceRecord
    git: GitWorkspace
  } {
    const binding =
      state.pending !== undefined && state.pending.phase === 'confirmed'
        ? state.pending.targetBinding
        : state.binding
    const workspace = inDb(this.authority, state.repositoryId, db =>
      getWorkspace(db, binding.workspaceId)
    )
    if (workspace === undefined) requireReview(`Bound workspace is missing: ${binding.workspaceId}`)
    return { repo: state.repositoryId, binding, workspace, git: this.validateWorkspace(workspace) }
  }

  private ensureNoUnresolvedUse(repo: string, workspaceIdValue: string): void {
    const active = inDb(this.authority, repo, db =>
      getUseRows(db, workspaceIdValue).filter(isActiveUse)
    )
    if (active.length > 0)
      blocked(`Workspace has unresolved live-use facts and cannot be resumed: ${workspaceIdValue}`)
  }
  private validateWithinGrant(
    attachment: WorkspaceAttachmentImpl,
    input: WorkspaceGrant
  ): { readonly lease: GrantLease; readonly workspace: WorkspaceRecord; readonly use: UseRecord } {
    const grant = decodeOrFail(WorkspaceGrantSchema, input, 'within workspace grant', 'invalid')
    const owners = attachment.state.leaseAttachments.get(grant.useId)
    if (owners === undefined || !owners.has(attachment.token))
      requireReview('Scoped operation grant was not issued to this attachment')
    const lease = this.validateGrant(attachment.state, grant)
    const result = inDb(this.authority, grant.repositoryId, db => {
      const workspace = getWorkspace(db, grant.workspaceId)
      const use = getUse(db, grant.useId)
      if (workspace === undefined || use === undefined)
        requireReview('Scoped operation grant has no live workspace use')
      if (use.effect !== undefined || use.execution !== undefined)
        invalid('A scoped operation must be admitted within an ordinary workspace grant')
      if (use.access !== grant.access || use.stage === 'quiescent')
        requireReview('Scoped operation grant is no longer active')
      if (use.stage !== 'authorized')
        blocked(`Scoped operation grant is unresolved: ${use.id} (${use.stage})`)
      return { workspace, use }
    })
    this.validateWorkspace(result.workspace)
    return { lease, ...result }
  }

  authorize(
    attachment: WorkspaceAttachmentImpl,
    operation: WorkspaceOperation
  ): Promise<WorkspaceAuthorization> {
    return this.guard(() => {
      const result = this.authorizeUnsafe(attachment, operation)
      if (result.kind === 'ready') this.claimGrant(attachment, result.grant)
      return result
    })
  }
  private authorizeUnsafe(
    attachment: WorkspaceAttachmentImpl,
    operation: WorkspaceOperation
  ): WorkspaceAuthorization {
    attachment.assertOpen()
    const state = attachment.state
    if (state.closing || state.parked)
      blocked('Workspace admission is parked during a host transition')
    if (operation.access !== 'read' && operation.access !== 'write')
      invalid('Operation access must be read or write')
    if (operation.cwd !== undefined && !isAbsolute(operation.cwd))
      invalid('Operation cwd must be absolute')
    if (operation.delegated === true && operation.access !== 'write')
      invalid('Delegated workspace admission requires write access')
    if (operation.effect !== undefined && !Schema.is(WorkspaceEffectSchema)(operation.effect))
      invalid('Workspace operation effect is invalid')
    if (operation.effect === undefined) {
      if (operation.within !== undefined || operation.path !== undefined)
        invalid('Scoped operation fields require an explicit effect classification')
    } else {
      if (operation.within === undefined)
        invalid('Scoped operation requires an attachment-owned within grant')
      if (operation.delegated === true)
        invalid('Scoped operation cannot also request a delegated allocation')
      if (operation.execution !== undefined) validExecution(operation.execution)
      return this.authorizeScoped(attachment, operation)
    }
    const source = this.currentSource(state)
    const cwd =
      operation.cwd === undefined ? source.binding.cwd : realpathSync(resolve(operation.cwd))
    if (!isWithin(source.workspace.path, cwd))
      invalid(`Operation cwd is outside the selected workspace: ${cwd}`)
    if (operation.execution !== undefined) validExecution(operation.execution)
    if (operation.access === 'read') {
      const ready = this.authorizeRead(state, source.repo, source.workspace, source.binding, cwd)
      if (operation.execution === undefined) return ready
      const base = state.leases.get(ready.grant.useId)
      if (base === undefined) requireReview('Reader grant disappeared before execution attribution')
      return this.executionUse(state, base, operation.execution)
    }
    if (operation.delegated === true) {
      const taskId = source.binding.taskId ?? workspaceId()
      return this.allocateWorkspace(
        state,
        source.repo,
        source.workspace,
        source.git,
        taskId,
        true,
        operation.execution
      )
    }
    const existing = state.writeGrant
    if (
      existing !== undefined &&
      existing.workspaceId === source.workspace.id &&
      existing.taskId === source.binding.taskId
    ) {
      const lease = this.validateGrant(state, existing)
      return operation.execution === undefined
        ? { kind: 'ready', grant: lease.grant }
        : this.executionUse(state, lease, operation.execution)
    }
    const reservation = inDb(this.authority, source.repo, db =>
      getReservation(db, source.workspace.id)
    )
    if (reservation !== undefined && reservation.taskId !== source.binding.taskId)
      return this.allocateWorkspace(
        state,
        source.repo,
        source.workspace,
        source.git,
        source.binding.taskId ?? workspaceId(),
        false,
        operation.execution
      )
    const activeWrites = inDb(this.authority, source.repo, db =>
      getUseRows(db, source.workspace.id).filter(use => use.access === 'write' && isActiveUse(use))
    )
    const foreignActive = activeWrites.some(use => !state.leases.has(use.id))
    if (foreignActive) {
      if (source.binding.taskId !== undefined)
        blocked(`The selected task has an unresolved writer use: ${source.workspace.path}`)
      return this.allocateWorkspace(
        state,
        source.repo,
        source.workspace,
        source.git,
        workspaceId(),
        false,
        operation.execution
      )
    }
    let gates: PathGates
    try {
      gates = acquirePathGates(this.authority.paths, source.workspace.path, true)
    } catch (cause) {
      if (
        !(cause instanceof WorkspaceError) ||
        cause.outcome !== 'blocked' ||
        source.binding.taskId !== undefined
      )
        throw cause
      return this.allocateWorkspace(
        state,
        source.repo,
        source.workspace,
        source.git,
        workspaceId(),
        false,
        operation.execution
      )
    }
    try {
      const taskId = source.binding.taskId ?? workspaceId()
      const useId = workspaceId()
      const reservationId = reservation?.id ?? workspaceId()
      const acquisitionId = workspaceId()
      const updatedBinding = decodeOrFail(
        BindingSchema,
        {
          ...source.binding,
          ...(source.binding.taskId === undefined ? { taskId } : {}),
          revision: source.binding.revision + (source.binding.taskId === undefined ? 1 : 0),
        },
        'write binding'
      )
      const use: UseRecord = decodeOrFail(
        UseSchema,
        {
          id: useId,
          workspaceId: source.workspace.id,
          taskId,
          reservationId,
          acquisitionId,
          access: 'write',
          stage: 'authorized',
          processes: [],
          conversationKey: state.key,
          bindingRevision: updatedBinding.revision,
          revision: 0,
          createdAt: now(),
          updatedAt: now(),
        },
        'write use'
      )
      inDb(this.authority, source.repo, db =>
        transaction(db, () => {
          const currentBinding = getBinding(db, state.key)
          if (
            currentBinding === undefined ||
            currentBinding.revision !== source.binding.revision ||
            currentBinding.workspaceId !== source.workspace.id
          )
            requireReview('Conversation binding changed during write admission')
          const currentReservation = getReservation(db, source.workspace.id)
          if (currentReservation !== undefined && currentReservation.taskId !== taskId)
            blocked(`Checkout is reserved by another task: ${source.workspace.path}`)
          if (currentReservation === undefined) {
            putReservation(db, {
              id: reservationId,
              taskId,
              workspaceId: source.workspace.id,
              acquisitionId,
              revision: 0,
              createdAt: now(),
            })
          } else {
            if (currentReservation.id !== reservationId)
              requireReview('Workspace reservation identity changed')
            updateReservation(db, {
              ...currentReservation,
              acquisitionId,
              revision: currentReservation.revision + 1,
            })
          }
          if (getTask(db, taskId) === undefined)
            putTask(db, { id: taskId, repositoryId: source.repo, revision: 0, createdAt: now() })
          if (
            updatedBinding.revision !== source.binding.revision ||
            updatedBinding.taskId !== source.binding.taskId
          )
            putBinding(db, updatedBinding)
          putUse(db, use)
        })
      )
      const grant = toGrant(this.authority, source.repo, source.workspace, use, cwd, 'write')
      const lease: GrantLease = {
        grant,
        repositoryId: source.repo,
        useId,
        gates,
        borrowed: false,
        isExecution: false,
        released: false,
      }
      state.leases.set(useId, lease)
      state.writeGrant = grant
      state.binding = updatedBinding
      if (operation.execution !== undefined)
        return this.executionUse(state, lease, operation.execution)
      return { kind: 'ready', grant }
    } catch (cause) {
      releaseGates(gates)
      throw cause
    }
  }

  private authorizeScoped(
    attachment: WorkspaceAttachmentImpl,
    operation: WorkspaceOperation
  ): WorkspaceAuthorization {
    const { state } = attachment
    const { effect, within } = operation
    if (effect === undefined || within === undefined)
      invalid('Scoped operation requires an explicit effect and within grant')
    const {
      lease: withinLease,
      workspace,
      use: withinUse,
    } = this.validateWithinGrant(attachment, within)
    if (operation.access === 'write' && within.access !== 'write')
      blocked('A read-only workspace grant cannot authorize a scoped mutation')
    if (effect === 'native-file-write' && operation.access !== 'write')
      invalid('Native file writes require write access')
    if (effect === 'opaque' && operation.access !== 'write')
      invalid('Opaque operations require write access')
    if (effect === 'native-file-write' && operation.path === undefined)
      invalid('Native file writes require an exact destination path')
    if (effect !== 'native-file-write' && operation.path !== undefined)
      invalid('Only native file writes accept a path operand')
    if (effect === 'opaque' && operation.execution === undefined)
      invalid('Opaque operations require process execution identity')
    if (effect !== 'opaque' && operation.execution !== undefined)
      invalid('Native operations cannot carry process execution identity')
    const cwd = realpathSync(resolve(operation.cwd ?? within.cwd))
    if (!isWithin(workspace.path, cwd))
      invalid(`Scoped operation cwd escapes its workspace: ${cwd}`)
    const operationPath =
      effect === 'native-file-write'
        ? resolveWriteDestination(workspace.path, cwd, operation.path as string)
        : undefined
    const execution =
      operation.execution === undefined ? undefined : validExecution(operation.execution)
    const use: UseRecord = decodeOrFail(
      UseSchema,
      {
        id: workspaceId(),
        workspaceId: workspace.id,
        taskId: withinUse.taskId,
        ...(withinUse.reservationId === undefined
          ? {}
          : { reservationId: withinUse.reservationId }),
        ...(withinUse.acquisitionId === undefined
          ? {}
          : { acquisitionId: withinUse.acquisitionId }),
        access: operation.access,
        stage: 'authorized',
        effect,
        withinUseId: withinUse.id,
        ...(operationPath === undefined ? {} : { operationPath }),
        ...(execution === undefined ? {} : { execution }),
        processes: [],
        conversationKey: state.key,
        bindingRevision: withinUse.bindingRevision,
        revision: 0,
        createdAt: now(),
        updatedAt: now(),
      },
      'scoped workspace use'
    )
    inDb(this.authority, withinLease.repositoryId, db =>
      transaction(db, () => {
        const currentWithin = getUse(db, withinUse.id)
        if (
          currentWithin === undefined ||
          currentWithin.workspaceId !== workspace.id ||
          currentWithin.bindingRevision !== withinUse.bindingRevision ||
          currentWithin.acquisitionId !== withinUse.acquisitionId ||
          currentWithin.reservationId !== withinUse.reservationId ||
          currentWithin.taskId !== withinUse.taskId ||
          currentWithin.access !== within.access ||
          currentWithin.stage !== 'authorized'
        )
          requireReview('Within grant changed before scoped operation admission')
        putUse(db, use)
      })
    )
    const grant = toGrant(
      this.authority,
      withinLease.repositoryId,
      workspace,
      use,
      cwd,
      operation.access
    )
    state.leases.set(use.id, {
      grant,
      repositoryId: withinLease.repositoryId,
      useId: use.id,
      effect,
      withinUseId: withinUse.id,
      borrowed: true,
      isExecution: execution !== undefined,
      ...(execution === undefined ? {} : { execution }),
      released: false,
    })
    return { kind: 'ready', grant }
  }

  private authorizeRead(
    state: ConversationState,
    repo: string,
    workspace: WorkspaceRecord,
    binding: BindingRecord,
    cwd: string
  ): WorkspaceAuthorization & { readonly kind: 'ready' } {
    for (const lease of state.leases.values()) {
      if (
        !lease.released &&
        !lease.isExecution &&
        lease.grant.access === 'read' &&
        lease.grant.workspaceId === workspace.id &&
        lease.grant.revision === binding.revision
      )
        return {
          kind: 'ready',
          grant: lease.grant,
          ...(this.writerWarning(state, repo, workspace.id) === undefined
            ? {}
            : { warning: this.writerWarning(state, repo, workspace.id) }),
        }
    }
    const gates = acquirePathGates(this.authority.paths, workspace.path, false)
    try {
      const reservation = inDb(this.authority, repo, db => getReservation(db, workspace.id))
      const use = decodeOrFail(
        UseSchema,
        {
          id: workspaceId(),
          workspaceId: workspace.id,
          taskId: binding.taskId,
          ...(reservation === undefined ? {} : { reservationId: reservation.id }),
          access: 'read',
          stage: 'authorized',
          processes: [],
          conversationKey: state.key,
          bindingRevision: binding.revision,
          revision: 0,
          createdAt: now(),
          updatedAt: now(),
        },
        'reader use'
      )
      inDb(this.authority, repo, db => transaction(db, () => putUse(db, use)))
      const grant = toGrant(this.authority, repo, workspace, use, cwd, 'read')
      const lease: GrantLease = {
        grant,
        repositoryId: repo,
        useId: use.id,
        gates,
        borrowed: false,
        isExecution: false,
        released: false,
      }
      state.leases.set(use.id, lease)
      const warning = this.writerWarning(state, repo, workspace.id)
      return { kind: 'ready', grant, ...(warning === undefined ? {} : { warning }) }
    } catch (cause) {
      releaseGates(gates)
      throw cause
    }
  }

  private writerWarning(
    state: ConversationState,
    repo: string,
    workspaceIdValue: string
  ): string | undefined {
    if (
      inDb(this.authority, repo, db =>
        getUseRows(db, workspaceIdValue).some(
          use => use.access === 'write' && isActiveUse(use) && !state.leases.has(use.id)
        )
      )
    )
      return 'A writer owns this live checkout; files may change while you read. No stable snapshot is provided.'
    return undefined
  }

  private executionUse(
    state: ConversationState,
    parent: GrantLease,
    input: WorkspaceExecution
  ): WorkspaceAuthorization {
    this.validateGrant(state, parent.grant)
    const execution = validExecution(input)
    const base = inDb(this.authority, parent.repositoryId, db => getUse(db, parent.useId))
    if (base === undefined) requireReview('Workspace grant has no base use record')
    const use: UseRecord = decodeOrFail(
      UseSchema,
      {
        ...base,
        id: workspaceId(),
        execution,
        stage: 'authorized',
        processes: [],
        revision: 0,
        createdAt: now(),
        updatedAt: now(),
        reason: undefined,
      },
      'execution recovery use'
    )
    inDb(this.authority, parent.repositoryId, db => transaction(db, () => putUse(db, use)))
    const grant = decodeOrFail(
      WorkspaceGrantSchema,
      { ...parent.grant, useId: use.id },
      'execution grant'
    )
    const lease: GrantLease = {
      grant,
      repositoryId: parent.repositoryId,
      useId: use.id,
      borrowed: true,
      isExecution: true,
      execution,
      released: false,
    }
    state.leases.set(use.id, lease)
    return { kind: 'ready', grant }
  }

  private releaseLocalGates(state: ConversationState): GateIntent[] {
    const intents: GateIntent[] = []
    for (const lease of state.leases.values()) {
      if (lease.gates === undefined) continue
      intents.push({
        repositoryId: lease.repositoryId,
        workspaceId: lease.grant.workspaceId,
        path: lease.grant.checkout,
        writer: lease.gates.writer !== undefined,
      })
      releaseGates(lease.gates)
      lease.gates = undefined
    }
    for (const held of state.extraGates.splice(0)) {
      intents.push({
        repositoryId: held.repositoryId,
        workspaceId: held.workspaceId,
        path: held.path,
        writer: held.gates.writer !== undefined,
      })
      releaseGates(held.gates)
    }
    return intents
  }

  private holdGates(state: ConversationState, intents: readonly GateIntent[]): void {
    const groups = new Map<string, GateIntent>()
    for (const intent of intents) {
      const path = canonicalPathSlot(intent.path)
      const current = groups.get(path)
      groups.set(path, { ...intent, path, writer: intent.writer || current?.writer === true })
    }
    const acquired: HeldPathGate[] = []
    try {
      for (const group of [...groups.values()].toSorted((left, right) =>
        left.path.localeCompare(right.path)
      ))
        acquired.push({
          ...group,
          gates: acquirePathGates(this.authority.paths, group.path, group.writer),
        })
    } catch (cause) {
      for (const held of acquired.toReversed()) releaseGates(held.gates)
      throw cause
    }
    state.extraGates.push(...acquired)
  }

  private orderedAllocationGates(
    state: ConversationState,
    sourceRepo: string,
    source: WorkspaceRecord,
    destination: string,
    intents: readonly GateIntent[]
  ): {
    readonly source: PathGates
    readonly target: PathGates
    readonly extras: readonly HeldPathGate[]
  } {
    const groups = new Map<string, GateIntent>()
    const add = (input: GateIntent): void => {
      const path = canonicalPathSlot(input.path)
      const current = groups.get(path)
      if (
        current !== undefined &&
        (current.repositoryId !== input.repositoryId || current.workspaceId !== input.workspaceId)
      )
        requireReview(`Conflicting workspace identities share one held path gate: ${path}`)
      groups.set(path, { ...input, path, writer: input.writer || current?.writer === true })
    }
    for (const intent of intents) add(intent)
    add({
      repositoryId: sourceRepo,
      workspaceId: source.id,
      path: source.path,
      writer:
        state.writeGrant?.workspaceId === source.id ||
        intents.some(intent => intent.workspaceId === source.id && intent.writer),
    })
    const targetPath = canonicalPathSlot(destination)
    add({
      repositoryId: sourceRepo,
      workspaceId: basename(destination),
      path: targetPath,
      writer: true,
    })

    for (const group of groups.values()) {
      if (group.path === targetPath) continue
      const record = inDb(this.authority, group.repositoryId, db =>
        getWorkspace(db, group.workspaceId)
      )
      if (record === undefined || record.path !== group.path)
        requireReview(`Workspace gate no longer matches its durable checkout: ${group.path}`)
      this.validateWorkspace(record)
    }

    const acquired = new Map<string, PathGates>()
    try {
      for (const group of [...groups.values()].toSorted((left, right) =>
        left.path.localeCompare(right.path)
      ))
        acquired.set(group.path, acquirePathGates(this.authority.paths, group.path, group.writer))
    } catch (cause) {
      for (const gates of [...acquired.values()].reverse()) releaseGates(gates)
      throw cause
    }
    const sourceGates = acquired.get(source.path)
    const targetGates = acquired.get(targetPath)
    if (sourceGates === undefined || targetGates === undefined)
      requireReview('Workspace allocation gates were not acquired')
    const extras = [...groups.values()]
      .filter(group => group.path !== targetPath)
      .map(group => ({ ...group, gates: acquired.get(group.path) }))
      .filter((group): group is HeldPathGate => group.gates !== undefined)
    return { source: sourceGates, target: targetGates, extras }
  }

  private allocateWorkspace(
    state: ConversationState,
    sourceRepo: string,
    sourceWorkspace: WorkspaceRecord,
    sourceGit: GitWorkspace,
    taskId: string,
    delegated: boolean,
    execution?: WorkspaceExecution
  ): WorkspaceAuthorization {
    if (!isUuid(taskId)) invalid('Workspace task identity is invalid')
    const previousWriteGrant = state.writeGrant
    if (!delegated)
      this.assertNoLiveExecution(
        state,
        { workspaceId: sourceWorkspace.id },
        'moved to a separate worktree'
      )
    const workspaceIdValue = workspaceId()
    const allocationId = workspaceId()
    const reservationId = workspaceId()
    const acquisitionId = workspaceId()
    const destinationParent = join(this.authority.paths.worktrees, sourceRepo)
    privateDirectory(this.authority.paths.worktrees, true)
    privateDirectory(destinationParent, true)
    const destination = join(destinationParent, workspaceIdValue)
    if (lstatIfExists(destination) !== undefined)
      requireReview(`Managed worktree destination already exists: ${destination}`)
    const targetSlot = canonicalPathSlot(destination)
    if (targetSlot !== destination)
      requireReview(`Managed worktree destination is not canonical: ${destination}`)

    // Taken before the local path gates are released: it never waits, so a contended
    // structure gate fails here with the conversation's admission intact.
    const structure = acquireStructureGate(this.authority.paths, sourceGit, sourceRepo)
    state.parked = true
    let gateIntents: GateIntent[] = []
    let pathGates:
      | {
          readonly source: PathGates
          readonly target: PathGates
          readonly extras: readonly HeldPathGate[]
        }
      | undefined
    let operation: OperationRecord | undefined
    try {
      gateIntents = this.releaseLocalGates(state)
      pathGates = this.orderedAllocationGates(
        state,
        sourceRepo,
        sourceWorkspace,
        destination,
        gateIntents
      )
      state.extraGates.push(...pathGates.extras)
      const commit = currentCommit(sourceGit)
      operation = decodeOrFail(
        OperationSchema,
        {
          id: allocationId,
          kind: 'allocation',
          phase: 'intent',
          repositoryId: sourceRepo,
          workspaceId: workspaceIdValue,
          taskId,
          reservationId,
          acquisitionId,
          sourceRepositoryId: sourceRepo,
          sourceWorkspaceId: sourceWorkspace.id,
          sourcePath: sourceWorkspace.path,
          sourceCommit: commit,
          targetPath: destination,
          conversationKey: state.key,
          expectedBindingRevision: state.binding.revision,
          reason: delegated ? 'delegated-writer' : 'checkout-contention',
          createdAt: now(),
        },
        'allocation intent'
      )
      inDb(this.authority, sourceRepo, db =>
        transaction(db, () => {
          const binding = getBinding(db, state.key)
          if (
            binding === undefined ||
            binding.revision !== state.binding.revision ||
            binding.workspaceId !== sourceWorkspace.id
          )
            requireReview('Conversation binding changed before worktree allocation')
          const task = getTask(db, taskId)
          if (task === undefined)
            putTask(db, { id: taskId, repositoryId: sourceRepo, revision: 0, createdAt: now() })
          putOperation(db, operation as OperationRecord)
        })
      )
      assertManagedCheckoutSupported(sourceGit, commit)
      operation = { ...operation, phase: 'started' }
      inDb(this.authority, sourceRepo, db =>
        transaction(db, () => saveOperation(db, operation as OperationRecord))
      )

      const createdGit = addDetachedWorktree(sourceGit, destination, commit)
      const rootFd = openSync(
        createdGit.path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      )
      try {
        fchmodSync(rootFd, 0o700)
        fsyncSync(rootFd)
      } finally {
        closeSync(rootFd)
      }
      fsyncParent(createdGit.path)
      fsyncPath(createdGit.gitAdminPath, true)
      fsyncParent(createdGit.gitAdminPath)
      const actual = canonicalGitWorkspace(destination)
      if (
        actual.head !== commit ||
        actual.commonPath !== sourceGit.commonPath ||
        !sameIdentity(actual.commonIdentity, sourceGit.commonIdentity)
      )
        requireReview(`Git did not publish the exact requested detached worktree: ${destination}`)
      const workspace = makeWorkspaceRecord(
        sourceRepo,
        actual,
        'managed',
        workspaceIdValue,
        allocationId
      )
      const reservation: ReservationRecord = {
        id: reservationId,
        taskId,
        workspaceId: workspaceIdValue,
        acquisitionId,
        revision: 0,
        createdAt: now(),
      }
      const use: UseRecord = decodeOrFail(
        UseSchema,
        {
          id: workspaceId(),
          workspaceId: workspaceIdValue,
          taskId,
          reservationId,
          acquisitionId,
          access: 'write',
          stage: 'authorized',
          ...(delegated && execution !== undefined ? { execution: validExecution(execution) } : {}),
          processes: [],
          conversationKey: state.key,
          bindingRevision: state.binding.revision + (delegated ? 0 : 1),
          revision: 0,
          createdAt: now(),
          updatedAt: now(),
        },
        'allocated writer use'
      )
      const completed: OperationRecord = {
        ...operation,
        phase: 'confirmed',
        result: `Observed detached worktree at ${destination}`,
      }
      let targetBinding: BindingRecord | undefined
      let handoff: WorkspaceHandoff | undefined
      let handoffOperation: OperationRecord | undefined
      if (!delegated) {
        targetBinding = decodeOrFail(
          BindingSchema,
          {
            ...state.binding,
            taskId,
            workspaceId: workspaceIdValue,
            cwd: destination,
            revision: state.binding.revision + 1,
            pendingOperationId: undefined,
          },
          'allocated workspace binding'
        )
        const handoffId = workspaceId()
        handoffOperation = decodeOrFail(
          OperationSchema,
          {
            id: handoffId,
            kind: 'handoff',
            phase: 'intent',
            repositoryId: sourceRepo,
            workspaceId: workspaceIdValue,
            taskId,
            reservationId,
            acquisitionId,
            sourceRepositoryId: sourceRepo,
            sourceWorkspaceId: sourceWorkspace.id,
            sourcePath: sourceWorkspace.path,
            sourceCommit: commit,
            targetPath: destination,
            conversationKey: state.key,
            expectedBindingRevision: state.binding.revision,
            reason: 'isolate-contended-writer',
            createdAt: now(),
          },
          'allocation handoff'
        )
        targetBinding = { ...targetBinding, pendingOperationId: handoffId }
        const grant = toGrant(this.authority, sourceRepo, workspace, use, destination, 'write')
        handoff = {
          operationId: handoffId,
          from: toBinding(state.binding),
          target: grant,
          reason:
            'Another task owns or is using the requested checkout. The new detached worktree starts at the exact current commit; uncommitted and ignored files were not copied.',
        }
        const targetLease: GrantLease = {
          grant,
          repositoryId: sourceRepo,
          useId: use.id,
          gates: pathGates.target,
          borrowed: false,
          isExecution: false,
          released: false,
        }
        state.leases.set(use.id, targetLease)
        state.writeGrant = grant
        inDb(this.authority, sourceRepo, db =>
          transaction(db, () => {
            putWorkspace(db, workspace)
            putReservation(db, reservation)
            putUse(db, use)
            saveOperation(db, completed)
            putOperation(db, handoffOperation as OperationRecord)
            const current = getBinding(db, state.key)
            if (current === undefined || current.revision !== state.binding.revision)
              requireReview('Conversation binding changed before handoff publication')
            putBinding(db, { ...current, pendingOperationId: handoffOperation?.id })
          })
        )
        const transition: PendingTransition = {
          handoff,
          sourceRepositoryId: sourceRepo,
          targetRepositoryId: sourceRepo,
          targetBinding,
          targetLease,
          previousWriteGrant,
          phase: 'intent',
        }
        state.pending = transition
        state.parked = true
        return { kind: 'rebind', handoff }
      }
      const grant = toGrant(this.authority, sourceRepo, workspace, use, destination, 'write')
      const lease: GrantLease = {
        grant,
        repositoryId: sourceRepo,
        useId: use.id,
        gates: pathGates.target,
        borrowed: false,
        isExecution: execution !== undefined,
        ...(execution === undefined ? {} : { execution: validExecution(execution) }),
        released: false,
      }
      state.leases.set(use.id, lease)
      inDb(this.authority, sourceRepo, db =>
        transaction(db, () => {
          putWorkspace(db, workspace)
          putReservation(db, reservation)
          putUse(db, use)
          saveOperation(db, completed)
        })
      )
      state.parked = false
      return { kind: 'ready', grant }
    } catch (cause) {
      if (pathGates !== undefined) releaseGates(pathGates.target)
      if (operation?.phase === 'started') {
        const unresolved: OperationRecord = {
          ...operation,
          phase: 'review-required',
          result: `Allocation outcome requires observation: ${errorText(cause)}`,
        }
        try {
          inDb(this.authority, sourceRepo, db =>
            transaction(db, () => saveOperation(db, unresolved))
          )
        } catch {
          /* retain the durable started intent */
        }
        state.parked = true
        throw cause
      }
      // No Git effect started, so the conversation keeps its binding and admission.
      if (operation !== undefined) {
        const stopped: OperationRecord = {
          ...operation,
          phase: 'cancelled',
          result: `Allocation stopped before any Git effect: ${errorText(cause)}`,
        }
        try {
          inDb(this.authority, sourceRepo, db => transaction(db, () => saveOperation(db, stopped)))
        } catch {
          /* an intent that was never recorded needs no result */
        }
      }
      try {
        if (pathGates === undefined) this.holdGates(state, gateIntents)
        state.parked = false
      } catch {
        state.parked = true
      }
      throw cause
    } finally {
      try {
        structure()
      } catch {
        /* a failed release blocks later structural acquisition at the SQLite gate */
      }
    }
  }

  private validateGrant(state: ConversationState, input: WorkspaceGrant): GrantLease {
    const grant = decodeOrFail(WorkspaceGrantSchema, input, 'workspace grant', 'invalid')
    if (grant.namespaceId !== this.authority.initialize())
      requireReview('Workspace grant belongs to another namespace')
    const lease = state.leases.get(grant.useId)
    if (lease === undefined || lease.released || !jsonEqual(lease.grant, grant))
      requireReview('Workspace grant is stale or was not issued to this attachment')
    const workspace = inDb(this.authority, grant.repositoryId, db => {
      const record = getWorkspace(db, grant.workspaceId)
      const use = getUse(db, grant.useId)
      if (record === undefined || use === undefined)
        requireReview('Workspace grant has no matching durable use')
      if (
        use.workspaceId !== grant.workspaceId ||
        use.bindingRevision !== grant.revision ||
        use.acquisitionId !== grant.acquisitionId ||
        use.reservationId !== grant.reservationId ||
        use.taskId !== grant.taskId ||
        use.access !== grant.access ||
        use.effect !== lease.effect ||
        use.withinUseId !== lease.withinUseId ||
        use.operationPath !== grant.path
      )
        requireReview('Workspace grant no longer matches its fenced use facts')
      if (grant.access === 'write') {
        const reservation = getReservation(db, grant.workspaceId)
        if (
          reservation === undefined ||
          reservation.id !== grant.reservationId ||
          reservation.taskId !== grant.taskId ||
          reservation.acquisitionId !== grant.acquisitionId
        )
          requireReview('Workspace grant is not the current reservation acquisition')
      }
      return record
    })
    this.validateWorkspace(workspace)
    return lease
  }

  validate(input: WorkspaceGrant): Promise<void> {
    return this.guard(() => {
      const grant = decodeOrFail(WorkspaceGrantSchema, input, 'workspace grant', 'invalid')
      const namespace = this.authority.inspectExisting()
      if (namespace === undefined || namespace !== grant.namespaceId)
        requireReview('Workspace grant namespace is missing or differs')
      const repositories = this.authority.listRepositories()
      if (!repositories.some(repository => repository.id === grant.repositoryId))
        requireReview('Workspace grant repository is not registered')
      const workspace = inDb(this.authority, grant.repositoryId, db => {
        const record = getWorkspace(db, grant.workspaceId)
        const use = getUse(db, grant.useId)
        if (record === undefined || use === undefined)
          requireReview('Workspace grant does not identify a durable use')
        if (
          use.workspaceId !== grant.workspaceId ||
          use.bindingRevision !== grant.revision ||
          use.acquisitionId !== grant.acquisitionId ||
          use.reservationId !== grant.reservationId ||
          use.taskId !== grant.taskId ||
          use.access !== grant.access ||
          use.operationPath !== grant.path
        )
          requireReview('Workspace grant does not match its fenced use record')
        if (use.stage === 'quiescent' || use.stage === 'observed' || use.stage === 'unknown')
          requireReview(`Workspace use is no longer eligible for a child: ${use.stage}`)
        if (grant.access === 'write') {
          const reservation = getReservation(db, grant.workspaceId)
          if (
            reservation === undefined ||
            reservation.id !== grant.reservationId ||
            reservation.taskId !== grant.taskId ||
            reservation.acquisitionId !== grant.acquisitionId
          )
            requireReview('Workspace grant acquisition is stale')
        }
        return record
      })
      if (grant.checkout !== workspace.path || grant.origin !== workspace.origin)
        requireReview('Workspace grant checkout fields were altered')
      if (!isAbsolute(grant.cwd) || !isWithin(workspace.path, grant.cwd))
        requireReview('Workspace grant cwd escapes its checkout')
      let actualCwd: string
      try {
        actualCwd = realpathSync(grant.cwd)
      } catch {
        return requireReview(`Workspace grant cwd is unavailable: ${grant.cwd}`)
      }
      if (actualCwd !== grant.cwd || !isWithin(workspace.path, actualCwd))
        requireReview('Workspace grant cwd is not the canonical checkout path')
      this.validateWorkspace(workspace)
    })
  }

  reportExecution(
    attachment: WorkspaceAttachmentImpl,
    input: WorkspaceGrant,
    fact: WorkspaceExecutionFact
  ): Promise<void> {
    return this.guard(() => {
      attachment.assertOpen()
      const state = attachment.state
      if (state.closing) blocked('Execution reporting is fenced during attachment closure')
      const checkedFact = validExecutionFact(fact)
      // A transition waits for running work to end, so facts that end it stay reportable.
      if (
        state.parked &&
        ['launch-intent', 'spawned', 'started', 'operation-started'].includes(checkedFact.kind)
      )
        blocked('Starting an operation is fenced during a host transition')
      const lease = this.validateGrant(state, input)
      if (lease.effect !== undefined) {
        const owners = state.leaseAttachments.get(lease.useId)
        if (owners === undefined || !owners.has(attachment.token))
          requireReview('Scoped operation report was not issued to this attachment')
      }
      if (!lease.isExecution) return this.reportScopedOperation(lease, checkedFact)
      if (lease.execution === undefined)
        invalid('Execution facts require a fresh execution-scoped grant')
      if (checkedFact.kind === 'operation-started' || checkedFact.kind === 'operation-completed')
        invalid('Operation boundary facts are only valid for non-process scoped operations')
      const current = inDb(this.authority, lease.repositoryId, db => getUse(db, lease.useId))
      if (
        current === undefined ||
        current.execution === undefined ||
        !jsonEqual(current.execution, lease.execution)
      )
        requireReview('Execution recovery row no longer matches the issued grant')
      if (current.stage === 'quiescent') requireReview('Execution has already been settled')
      const update = (value: UseRecord, guard?: (db: DatabaseSync) => void): void =>
        inDb(this.authority, lease.repositoryId, db =>
          transaction(db, () => {
            guard?.(db)
            saveUse(db, value)
          })
        )
      const updatedAt = now()
      switch (checkedFact.kind) {
        case 'launch-intent': {
          if (!jsonEqual(validExecution(checkedFact.execution), lease.execution))
            invalid('Launch intent does not match the authorized execution')
          if (current.stage !== 'authorized')
            requireReview(`Cannot record launch intent after ${current.stage}`)
          update({ ...current, stage: 'launch-intent', revision: current.revision + 1, updatedAt })
          return
        }
        case 'spawned': {
          if (current.stage !== 'launch-intent')
            requireReview(`Cannot record process identity after ${current.stage}`)
          const process = decodeOrFail(
            WorkspaceProcessSchema,
            checkedFact.process,
            'spawned process identity',
            'invalid'
          )
          update({
            ...current,
            stage: 'spawned',
            processes: [process],
            revision: current.revision + 1,
            updatedAt,
          })
          return
        }
        case 'started': {
          if (current.stage !== 'spawned')
            requireReview(
              `Cannot release user code after ${current.stage}; process identity must be recorded first`
            )
          update({ ...current, stage: 'started', revision: current.revision + 1, updatedAt })
          return
        }
        case 'observed': {
          if (!['spawned', 'started', 'observed'].includes(current.stage))
            requireReview(`Cannot record a process observation after ${current.stage}`)
          const processes = decodeOrFail(
            Schema.Array(WorkspaceProcessSchema),
            checkedFact.processes,
            'observed process set',
            'invalid'
          )
          update({
            ...current,
            stage: 'observed',
            processes,
            revision: current.revision + 1,
            updatedAt,
          })
          return
        }
        case 'unknown': {
          update({
            ...current,
            stage: 'unknown',
            reason: checkedFact.reason,
            revision: current.revision + 1,
            updatedAt,
          })
          return
        }
        case 'launch-failed': {
          // Only before a process identity is recorded can the adapter know that no user
          // code was released; afterwards the family must be observed gone instead.
          if (current.stage !== 'authorized' && current.stage !== 'launch-intent')
            requireReview(`A launch cannot be reported failed after ${current.stage}`)
          update({
            ...current,
            stage: 'quiescent',
            reason: `launch-failed: ${checkedFact.reason}`,
            revision: current.revision + 1,
            updatedAt,
          })
          lease.released = true
          return
        }
        case 'quiescent': {
          // A process that detaches into a new session escapes this observation; ADR 0005
          // accepts that residual risk.
          if (current.stage !== 'observed' || current.processes.length > 0)
            requireReview(
              `Quiescence after ${current.stage} requires an observed empty process family first`
            )
          update({
            ...current,
            stage: 'quiescent',
            reason: checkedFact.reason,
            revision: current.revision + 1,
            updatedAt,
          })
          lease.released = true
          return
        }
        default: {
          const exhaustive: never = checkedFact
          return exhaustive
        }
      }
    })
  }

  private reportScopedOperation(lease: GrantLease, fact: WorkspaceExecutionFact): void {
    if (lease.effect === undefined)
      invalid('Legacy workspace grants do not carry scoped operation authority')
    if (
      fact.kind !== 'operation-started' &&
      fact.kind !== 'operation-completed' &&
      fact.kind !== 'unknown'
    )
      invalid('Scoped native operations require operation boundary facts')
    const current = inDb(this.authority, lease.repositoryId, db => getUse(db, lease.useId))
    if (current === undefined || current.effect !== lease.effect)
      requireReview('Scoped operation lost its durable use record')
    const next = inDb(this.authority, lease.repositoryId, db =>
      transaction(db, () => {
        const latest = getUse(db, lease.useId)
        if (
          latest === undefined ||
          latest.revision !== current.revision ||
          latest.effect !== lease.effect ||
          latest.withinUseId !== lease.withinUseId
        )
          requireReview('Scoped operation report is stale')
        if (fact.kind === 'operation-started') {
          if (latest.stage !== 'authorized')
            requireReview(`Cannot start scoped operation after ${latest.stage}`)
          assertWithinLiveInDb(db, latest)
          if (latest.operationPath !== undefined) {
            const workspace = getWorkspace(db, latest.workspaceId)
            if (workspace === undefined)
              requireReview(`Scoped operation lost its workspace: ${latest.workspaceId}`)
            assertDestinationUnchanged(workspace.path, latest.operationPath)
          }
          const started: UseRecord = {
            ...latest,
            stage: 'operation-started',
            revision: latest.revision + 1,
            updatedAt: now(),
          }
          saveUse(db, started)
          return started
        }
        if (fact.kind === 'operation-completed') {
          if (latest.stage !== 'operation-started' && latest.stage !== 'authorized')
            requireReview(`Cannot complete scoped operation after ${latest.stage}`)
          const completed: UseRecord = {
            ...latest,
            stage: 'quiescent',
            reason:
              latest.stage === 'authorized'
                ? `operation-ended-before-start:${lease.effect}`
                : `operation-completed:${lease.effect}`,
            revision: latest.revision + 1,
            updatedAt: now(),
          }
          saveUse(db, completed)
          return completed
        }
        if (latest.stage !== 'authorized' && latest.stage !== 'operation-started')
          requireReview(`Cannot mark scoped operation unknown after ${latest.stage}`)
        const unknown: UseRecord = {
          ...latest,
          stage: 'unknown',
          reason: fact.reason,
          revision: latest.revision + 1,
          updatedAt: now(),
        }
        saveUse(db, unknown)
        return unknown
      })
    )
    if (next.stage === 'quiescent' || next.stage === 'unknown') lease.released = true
  }

  select(
    attachment: WorkspaceAttachmentImpl,
    selection: WorkspaceSelection
  ): Promise<WorkspaceHandoff> {
    return this.guard(() => {
      attachment.assertOpen()
      const state = attachment.state
      if (state.parked || state.pending !== undefined)
        blocked('A workspace transition is already pending')
      this.assertNoLiveExecution(state, state.binding, 'switched')
      const target = this.resolveSelection(selection)
      this.validateWorkspace(target.workspace)
      const source = this.currentSource(state)
      if (
        source.repo === target.repo &&
        source.workspace.id === target.workspace.id &&
        source.binding.taskId === target.reservation.taskId
      ) {
        const current = state.writeGrant
        if (current !== undefined)
          return {
            operationId: workspaceId(),
            from: toBinding(state.binding),
            target: current,
            reason: 'The selected task is already bound to this workspace.',
          }
      }
      const targetUses = inDb(this.authority, target.repo, db =>
        getUseRows(db, target.workspace.id)
      )
      if (
        targetUses.some(
          use => use.access === 'write' && isActiveUse(use) && !state.leases.has(use.id)
        )
      )
        blocked(`Selected workspace has an active or unresolved writer: ${target.workspace.path}`)
      const gates = acquirePathGates(this.authority.paths, target.workspace.path, true)
      const operationId = workspaceId()
      const acquisitionId = workspaceId()
      const use: UseRecord = decodeOrFail(
        UseSchema,
        {
          id: workspaceId(),
          workspaceId: target.workspace.id,
          taskId: target.reservation.taskId,
          reservationId: target.reservation.id,
          acquisitionId,
          access: 'write',
          stage: 'authorized',
          processes: [],
          conversationKey: state.key,
          bindingRevision: state.binding.revision + 1,
          revision: 0,
          createdAt: now(),
          updatedAt: now(),
        },
        'resume use'
      )
      const targetBinding: BindingRecord = decodeOrFail(
        BindingSchema,
        {
          key: state.key,
          conversation: state.conversation,
          taskId: target.reservation.taskId,
          workspaceId: target.workspace.id,
          cwd: target.workspace.path,
          revision: state.binding.revision + 1,
        },
        'resume binding'
      )
      const operation: OperationRecord = decodeOrFail(
        OperationSchema,
        {
          id: operationId,
          kind: 'handoff',
          phase: 'intent',
          repositoryId: target.repo,
          workspaceId: target.workspace.id,
          taskId: target.reservation.taskId,
          reservationId: target.reservation.id,
          acquisitionId,
          sourceRepositoryId: source.repo,
          sourceWorkspaceId: source.workspace.id,
          sourcePath: source.workspace.path,
          targetPath: target.workspace.path,
          conversationKey: state.key,
          expectedBindingRevision: state.binding.revision,
          reason: 'explicit-task-resume',
          createdAt: now(),
        },
        'resume handoff intent'
      )
      const grant = toGrant(
        this.authority,
        target.repo,
        target.workspace,
        use,
        target.workspace.path,
        'write'
      )
      const handoff: WorkspaceHandoff = {
        operationId,
        from: toBinding(state.binding),
        target: grant,
        reason:
          'Explicit task selection. The existing workspace and its contents will be used; no files are transferred.',
      }
      const targetLease: GrantLease = {
        grant,
        repositoryId: target.repo,
        useId: use.id,
        gates,
        borrowed: false,
        isExecution: false,
        released: false,
      }
      try {
        inDb(this.authority, target.repo, db =>
          transaction(db, () => {
            const reservation = getReservation(db, target.workspace.id)
            if (
              reservation === undefined ||
              reservation.id !== target.reservation.id ||
              reservation.taskId !== target.reservation.taskId
            )
              requireReview('Selected reservation changed before resume')
            updateReservation(db, {
              ...reservation,
              acquisitionId,
              revision: reservation.revision + 1,
            })
            putUse(db, use)
            putOperation(db, operation)
            if (source.repo === target.repo) {
              const current = getBinding(db, state.key)
              if (current === undefined || current.revision !== state.binding.revision)
                requireReview('Conversation binding changed before resume')
              putBinding(db, { ...current, pendingOperationId: operationId })
            }
          })
        )
        if (source.repo !== target.repo)
          inDb(this.authority, source.repo, db =>
            transaction(db, () => {
              const current = getBinding(db, state.key)
              if (current === undefined || current.revision !== state.binding.revision)
                requireReview('Conversation binding changed before resume')
              putBinding(db, { ...current, pendingOperationId: operationId })
            })
          )
      } catch (cause) {
        releaseGates(gates)
        throw cause
      }
      state.pending = {
        handoff,
        sourceRepositoryId: source.repo,
        targetRepositoryId: target.repo,
        targetBinding,
        targetLease,
        previousWriteGrant: state.writeGrant,
        phase: 'intent',
      }
      state.parked = true
      state.leases.set(use.id, targetLease)
      state.writeGrant = grant
      return handoff
    })
  }

  handoff(
    attachment: WorkspaceAttachmentImpl,
    transition: WorkspaceHandoff,
    replace: (target: WorkspaceGrant) => Promise<'confirmed' | 'cancelled'>
  ): Promise<void> {
    return this.guard(async () => {
      attachment.assertOpen()
      const state = attachment.state
      const pending = state.pending
      if (
        pending === undefined ||
        pending.handoff.operationId !== transition.operationId ||
        !jsonEqual(pending.handoff.target, transition.target) ||
        !jsonEqual(pending.handoff.from, transition.from)
      )
        requireReview('Workspace handoff token is stale or belongs to another transition')
      let operation: OperationRecord
      try {
        this.validateGrant(state, pending.handoff.target)
        this.assertNoLiveExecution(state, pending.handoff.from, 'switched')
        operation = inDb(this.authority, pending.targetRepositoryId, db =>
          transaction(db, () => {
            const current = getOperation(db, transition.operationId)
            if (current === undefined || current.kind !== 'handoff' || current.phase !== 'intent')
              requireReview(`Workspace handoff intent is unavailable: ${transition.operationId}`)
            const started = { ...current, phase: 'started' as const }
            saveOperation(db, started)
            return started
          })
        )
      } catch (cause) {
        this.cancelTransition(state, pending, `Refused before the host acted: ${errorText(cause)}`)
        return blocked(
          `Workspace transition refused before the host acted; the current binding is kept: ${errorText(cause)}`
        )
      }
      pending.phase = 'started'
      let outcome: 'confirmed' | 'cancelled'
      try {
        // Runtime teardown/replacement is host-owned and never runs inside a DB transaction.
        outcome = await replace(pending.handoff.target)
      } catch (cause) {
        this.markTransitionUnknown(
          state,
          pending,
          `Host transition outcome is uncertain: ${errorText(cause)}`
        )
        return requireReview(
          `Workspace handoff requires explicit recovery: ${transition.operationId}`
        )
      }
      if (outcome === 'cancelled')
        this.cancelTransition(
          state,
          pending,
          'Host reported that the last confirmed binding was preserved.'
        )
      else this.finishConfirmed(state, pending, operation)
    })
  }

  private markTransitionUnknown(
    state: ConversationState,
    pending: PendingTransition,
    reason: string
  ): void {
    pending.phase = 'unknown'
    state.parked = true
    try {
      inDb(this.authority, pending.targetRepositoryId, db =>
        transaction(db, () => {
          const operation = getOperation(db, pending.handoff.operationId)
          if (
            operation !== undefined &&
            operation.phase !== 'confirmed' &&
            operation.phase !== 'cancelled'
          )
            saveOperation(db, { ...operation, phase: 'unknown', result: reason })
          const use = getUse(db, pending.targetLease.useId)
          if (use !== undefined && use.stage !== 'quiescent')
            saveUse(db, {
              ...use,
              stage: 'unknown',
              reason,
              revision: use.revision + 1,
              updatedAt: now(),
            })
        })
      )
    } catch {
      /* preserve the already-durable started intent and pending binding */
    }
  }

  private cancelTransition(
    state: ConversationState,
    pending: PendingTransition,
    result: string
  ): void {
    const operationId = pending.handoff.operationId
    const targetUse = inDb(this.authority, pending.targetRepositoryId, db =>
      getUse(db, pending.targetLease.useId)
    )
    if (targetUse === undefined) requireReview('Cancelled handoff lost its target use record')
    if (targetUse.stage !== 'authorized')
      requireReview('Cancelled handoff target was used before host confirmation')
    inDb(this.authority, pending.targetRepositoryId, db =>
      transaction(db, () => {
        const current = getOperation(db, operationId)
        if (current === undefined || (current.phase !== 'intent' && current.phase !== 'started'))
          requireReview('Handoff result no longer matches its intent')
        const cancelled: OperationRecord = { ...current, phase: 'cancelled', result }
        saveUse(db, {
          ...targetUse,
          stage: 'quiescent',
          reason: 'host-cancelled-before-use',
          revision: targetUse.revision + 1,
          updatedAt: now(),
        })
        saveOperation(db, cancelled)
        if (pending.sourceRepositoryId === pending.targetRepositoryId) {
          const binding = getBinding(db, state.key)
          if (binding === undefined || binding.pendingOperationId !== operationId)
            requireReview('Cancelled handoff binding changed')
          putBinding(db, { ...binding, pendingOperationId: undefined })
        }
      })
    )
    if (pending.sourceRepositoryId !== pending.targetRepositoryId) {
      inDb(this.authority, pending.sourceRepositoryId, db =>
        transaction(db, () => {
          const binding = getBinding(db, state.key)
          if (binding === undefined || binding.pendingOperationId !== operationId)
            requireReview('Cancelled handoff source binding changed')
          putBinding(db, { ...binding, pendingOperationId: undefined })
        })
      )
    }
    pending.targetLease.released = true
    if (pending.targetLease.gates !== undefined) {
      releaseGates(pending.targetLease.gates)
      pending.targetLease.gates = undefined
    }
    state.writeGrant = pending.previousWriteGrant
    state.pending = undefined
    state.parked = false
  }

  private outgoingUses(
    state: ConversationState,
    sourceWorkspaceId: string,
    excludeUseId?: string
  ): { readonly lease: GrantLease; readonly use: UseRecord }[] {
    return [...state.leases.values()]
      .filter(
        lease => lease.grant.workspaceId === sourceWorkspaceId && lease.useId !== excludeUseId
      )
      .map(lease => {
        const use = inDb(this.authority, lease.repositoryId, db => getUse(db, lease.useId))
        if (use === undefined)
          requireReview(`Old workspace use disappeared during handoff: ${lease.useId}`)
        return { lease, use }
      })
  }

  // A process of this conversation still running in the workspace it would leave cannot
  // report its cessation once the move releases its leases, so the move waits for it.
  private assertNoLiveExecution(
    state: ConversationState,
    source: { readonly workspaceId: string },
    action: string
  ): void {
    const live = this.outgoingUses(state, source.workspaceId).find(
      ({ use }) =>
        use.execution !== undefined && use.stage !== 'quiescent' && use.stage !== 'unknown'
    )
    if (live !== undefined)
      blocked(
        `This conversation still runs ${live.use.execution?.taskKey ?? 'a process'} (${live.use.stage}) in its workspace, so it cannot be ${action} yet. Wait for it to finish or stop it with /work stop.`
      )
  }

  private finishConfirmed(
    state: ConversationState,
    pending: PendingTransition,
    operation: OperationRecord
  ): void {
    const sourceWorkspaceId = pending.handoff.from.workspaceId
    const oldUses = this.outgoingUses(state, sourceWorkspaceId, pending.targetLease.useId)
    // Dependents first: a use is always created after its `within` parent, so reverse
    // insertion order settles descendants before the parent whose gates they rely on.
    // A dependent left unknown keeps its parent unknown instead of failing here, after
    // the host has already switched.
    for (const { lease, use } of oldUses.toReversed()) {
      if (use.stage === 'quiescent' || use.stage === 'unknown') continue
      inDb(this.authority, lease.repositoryId, db =>
        transaction(db, () => {
          const dependents = activeDependentUses(db, use.id)
          let settlement: Pick<UseRecord, 'stage' | 'reason'> = {
            stage: 'quiescent',
            reason: 'host-tool-batch-settled',
          }
          if (use.execution !== undefined)
            settlement = { stage: 'unknown', reason: 'host-switched-while-a-process-was-live' }
          else if (dependents.length > 0)
            settlement = {
              stage: 'unknown',
              reason: `host-transition-left-dependent-uses-unresolved: ${dependents
                .map(dependent => dependent.id)
                .join(', ')}`,
            }
          saveUse(db, { ...use, ...settlement, revision: use.revision + 1, updatedAt: now() })
        })
      )
    }
    const oldLeases = oldUses.map(({ lease }) => lease)
    const confirmedBinding: BindingRecord = {
      ...pending.targetBinding,
      pendingOperationId: undefined,
      superseded: undefined,
    }
    const confirmedOperation: OperationRecord = {
      ...operation,
      phase: 'confirmed',
      result: 'Host callback confirmed the target binding.',
    }
    if (pending.sourceRepositoryId === pending.targetRepositoryId) {
      inDb(this.authority, pending.targetRepositoryId, db =>
        transaction(db, () => {
          const binding = getBinding(db, state.key)
          if (
            binding === undefined ||
            binding.pendingOperationId !== operation.id ||
            binding.revision !== operation.expectedBindingRevision
          )
            requireReview('Conversation binding changed before confirmed handoff publication')
          putBinding(db, confirmedBinding)
          saveOperation(db, confirmedOperation)
        })
      )
    } else {
      // Cross-shard publication is deliberately recoverable rather than pretending to be atomic.
      inDb(this.authority, pending.targetRepositoryId, db =>
        transaction(db, () => {
          const current = getOperation(db, operation.id)
          if (current === undefined || current.phase !== 'started')
            requireReview('Cross-repository handoff intent changed')
          saveOperation(db, {
            ...current,
            result: 'Host confirmed; binding publication is pending across repository shards.',
          })
          const previous = getBinding(db, state.key)
          if (previous !== undefined)
            putBinding(db, { ...previous, superseded: true, pendingOperationId: undefined })
        })
      )
      inDb(this.authority, pending.sourceRepositoryId, db =>
        transaction(db, () => {
          const binding = getBinding(db, state.key)
          if (binding === undefined || binding.pendingOperationId !== operation.id)
            requireReview('Cross-repository source binding changed')
          putBinding(db, { ...binding, superseded: true, pendingOperationId: undefined })
        })
      )
      inDb(this.authority, pending.targetRepositoryId, db =>
        transaction(db, () => {
          putBinding(db, confirmedBinding)
          saveOperation(db, confirmedOperation)
        })
      )
    }
    for (const lease of oldLeases) {
      lease.released = true
      if (lease.gates !== undefined) {
        releaseGates(lease.gates)
        lease.gates = undefined
      }
    }
    for (let index = state.extraGates.length - 1; index >= 0; index--) {
      const held = state.extraGates[index]
      if (
        held?.workspaceId === sourceWorkspaceId &&
        held.repositoryId === pending.sourceRepositoryId
      ) {
        releaseGates(held.gates)
        state.extraGates.splice(index, 1)
      }
    }
    state.binding = confirmedBinding
    state.repositoryId = pending.targetRepositoryId
    state.pending = undefined
    state.parked = false
    state.writeGrant = pending.targetLease.grant
  }

  inspect(input: { cwd?: string; taskId?: string }): Promise<readonly WorkspaceView[]> {
    return this.guard(() => {
      if (input.taskId !== undefined && !isUuid(input.taskId))
        invalid('Task ID must be an exact UUID')
      const namespace = this.authority.inspectExisting()
      if (namespace === undefined) return []
      let repositoryFilter: string | undefined
      if (input.cwd !== undefined) {
        if (!isAbsolute(input.cwd)) invalid('Inspection cwd must be absolute')
        const git = canonicalGitWorkspace(input.cwd)
        const catalog = this.authority.openCatalog(false)
        try {
          const row = first(
            catalog,
            `SELECT id, common_path, device, inode, object_format, state, provision_id, revision, payload
            FROM repositories WHERE common_path=?`,
            git.commonPath
          )
          if (row === undefined) return []
          repositoryFilter = validateRepositoryRecord(git, row).id
        } finally {
          catalog.close()
        }
      }
      const repositories =
        repositoryFilter === undefined
          ? this.authority.listRepositories()
          : this.authority
              .listRepositories()
              .filter(repository => repository.id === repositoryFilter)
      const views: WorkspaceView[] = []
      const visibleOperationIds = new Set<string>()
      for (const repository of repositories) {
        inDb(this.authority, repository.id, db => {
          const workspaceRows =
            input.taskId === undefined
              ? rows(db, 'SELECT id FROM workspaces ORDER BY path')
              : rows(
                  db,
                  `SELECT DISTINCT workspaces.id FROM workspaces
                LEFT JOIN reservations ON reservations.workspace_id=workspaces.id
                LEFT JOIN tasks ON tasks.id=reservations.task_id
                WHERE reservations.task_id=? OR tasks.id=? ORDER BY workspaces.path`,
                  input.taskId,
                  input.taskId
                )
          const present = new Set<string>()
          for (const row of workspaceRows) {
            const id = textField(row, 'id')
            const workspace = getWorkspace(db, id)
            if (workspace === undefined) requireReview(`Workspace inventory row disappeared: ${id}`)
            present.add(id)
            const reservation = getReservation(db, id)
            if (input.taskId !== undefined && reservation?.taskId !== input.taskId) continue
            const uses = getUseRows(db, id)
            const operationRows = rows(
              db,
              `SELECT id FROM operations
              WHERE workspace_id=? AND phase IN ('intent','started','unknown','review-required') ORDER BY created_at,id`,
              id
            )
            const pending = operationRows
              .map(item => getOperation(db, textField(item, 'id')))
              .filter((value): value is OperationRecord => value !== undefined)
              .map(value => {
                visibleOperationIds.add(value.id)
                return { id: value.id, kind: value.kind, stage: value.phase }
              })
            let identityReason: string | undefined
            try {
              this.validateWorkspace(workspace)
            } catch (cause) {
              identityReason = errorText(cause)
            }
            const unresolved = pending.some(operation => operation.stage !== 'intent')
            const unknown = uses.some(use => use.stage === 'unknown' || use.stage === 'observed')
            const live = uses.some(use => isActiveUse(use))
            const { outcome, reason, nextAction } = assessWorkspace({
              identityReason,
              pending: pending[0],
              unresolved,
              unknown,
              live,
              abandoned:
                identityReason === undefined
                  ? uses
                      .filter(
                        use =>
                          isActiveUse(use) &&
                          !conversationHeld(this.authority.paths, use.conversationKey)
                      )
                      .map(use => use.id)
                  : [],
              reserved: reservation !== undefined,
            })
            views.push({
              repositoryId: repository.id,
              ...(reservation === undefined
                ? {}
                : { taskId: reservation.taskId, reservationId: reservation.id }),
              ...(reservation === undefined ? {} : { taskLabel: reservation.taskId }),
              workspaceId: workspace.id,
              path: workspace.path,
              origin: workspace.origin,
              outcome,
              reason,
              nextAction,
              uses: uses.map(use => ({
                id: use.id,
                access: use.access,
                stage: use.stage,
                ...(use.effect === undefined ? {} : { effect: use.effect }),
                ...(use.operationPath === undefined ? {} : { path: use.operationPath }),
                ...(use.reason === undefined ? {} : { reason: use.reason }),
                ...(use.execution === undefined ? {} : { execution: use.execution }),
                ...(use.execution?.logs === undefined
                  ? {}
                  : { logsAvailable: logAvailability(use.execution.logs) }),
              })),
              pending,
            })
          }
          const orphanOperations = rows(
            db,
            `SELECT id FROM operations
            WHERE phase IN ('intent','started','unknown','review-required') ORDER BY created_at,id`
          )
            .map(row => getOperation(db, textField(row, 'id')))
            .filter((value): value is OperationRecord => value !== undefined)
            .filter(
              operation =>
                !present.has(operation.workspaceId) &&
                !visibleOperationIds.has(operation.id) &&
                (input.taskId === undefined || operation.taskId === input.taskId)
            )
          for (const operation of orphanOperations) {
            visibleOperationIds.add(operation.id)
            views.push({
              repositoryId: repository.id,
              taskId: operation.taskId,
              workspaceId: operation.workspaceId,
              path: operation.targetPath,
              origin: 'managed',
              outcome: 'review-required',
              reason: `Pending ${operation.kind} operation ${operation.id} has no ready workspace record (${operation.phase}).`,
              nextAction:
                'Observe the exact Git effect and require explicit recovery; do not replay or adopt it.',
              uses: [],
              pending: [{ id: operation.id, kind: operation.kind, stage: operation.phase }],
              reservationId: operation.reservationId,
            })
          }
        })
      }
      return views
    })
  }

  closeAttachment(attachment: WorkspaceAttachmentImpl): Promise<void> {
    try {
      const state = attachment.state
      state.refs = Math.max(0, state.refs - 1)
      if (state.refs > 0) return Promise.resolve()
      this.settleClosingState(state, state.pending)
      if (state.pending === undefined) {
        this.states.delete(state.key)
        state.releaseConversation()
      } else state.closing = false
      return Promise.resolve()
    } catch (cause) {
      return this.reject(cause)
    }
  }

  private settleClosingState(
    state: ConversationState,
    pending: PendingTransition | undefined
  ): void {
    state.closing = true
    // Dependents first: a use is created after its `within` parent, so reverse insertion
    // order settles descendants before the parent whose gates they write under.
    for (const lease of [...state.leases.values()].toReversed()) {
      const preserveTarget = pending !== undefined && lease.useId === pending.targetLease.useId
      let use: UseRecord | undefined
      try {
        use = inDb(this.authority, lease.repositoryId, db => getUse(db, lease.useId))
      } catch {
        use = undefined
      }
      if (
        use !== undefined &&
        use.stage !== 'quiescent' &&
        use.stage !== 'unknown' &&
        !preserveTarget
      ) {
        let stage: UseRecord['stage'] = 'unknown'
        let reason = 'attachment-closed-without-authoritative-operation-cessation'
        if (use.stage === 'authorized') {
          stage = 'quiescent'
          reason = 'attachment-closed-before-operation-boundary'
        }
        // Close must not fail, so it cannot refuse the way a reported settlement does.
        // Instead it declines to claim quiescence it has not established: an unsettled
        // dependent leaves the parent `unknown`, which keeps its workspace blocked.
        if (stage === 'quiescent') {
          let dependents: UseRecord[] = []
          try {
            dependents = inDb(this.authority, lease.repositoryId, db =>
              activeDependentUses(db, use.id)
            )
          } catch {
            dependents = []
          }
          if (dependents.length > 0) {
            stage = 'unknown'
            reason = `attachment-closed-while-dependent-scoped-operations-were-live: ${dependents
              .map(dependent => dependent.id)
              .join(', ')}`
          }
        }
        try {
          inDb(this.authority, lease.repositoryId, db =>
            transaction(db, () =>
              saveUse(db, {
                ...use,
                stage,
                reason,
                revision: use.revision + 1,
                updatedAt: now(),
              })
            )
          )
        } catch {
          /* the durable earlier claim remains blocking */
        }
      }
      if (lease.gates !== undefined) {
        try {
          releaseGates(lease.gates)
        } finally {
          lease.gates = undefined
        }
      }
      if (!preserveTarget) lease.released = true
    }
    for (const held of state.extraGates.splice(0)) {
      try {
        releaseGates(held.gates)
      } catch {
        /* retain persisted use rows */
      }
    }
    state.closing = false
  }

  close(): Promise<void> {
    if (this.lifecycleClosed) return Promise.resolve()
    try {
      for (const state of this.states.values()) {
        this.settleClosingState(state, state.pending)
        state.releaseConversation()
      }
      this.lifecycleClosed = true
      this.authority.close()
      return Promise.resolve()
    } catch (cause) {
      return this.reject(cause)
    }
  }
}
