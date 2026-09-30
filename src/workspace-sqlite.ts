import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  linkSync,
  openSync,
  unlinkSync,
} from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { basename, dirname, join } from 'node:path'
import { Predicate, Schema } from 'effect'
import { blocked, invalid, requireReview, unavailable, WorkspaceError } from './workspace-domain.ts'
import {
  effectiveUid,
  fsyncParent,
  hasErrorCode,
  lstatIfExists,
  privateDirectory,
  privateFile,
} from './workspace-platform.ts'
import { errorText } from './error-text.ts'

export const sqliteCode = (cause: unknown): number | undefined =>
  Predicate.hasProperty(cause, 'errcode') && Predicate.isNumber(cause.errcode)
    ? cause.errcode & 255
    : undefined
export const sqliteBusy = (cause: unknown): boolean => {
  const code = sqliteCode(cause)
  return code === 5 || code === 6
}

const BUSY_TIMEOUT_MS = 5000

export type SqlRow = Record<string, unknown>

export const PROTOCOL_SQL = `
  CREATE TABLE protocol_marker(
    id INTEGER PRIMARY KEY CHECK(id = 1),
    namespace_id TEXT NOT NULL
  ) STRICT;
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
`
const SHARD_SQL = `
  CREATE TABLE shard_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
  CREATE TABLE tasks(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL) STRICT;
  CREATE TABLE workspaces(
    id TEXT PRIMARY KEY,
    path_key TEXT NOT NULL UNIQUE,
    path TEXT NOT NULL,
    origin TEXT NOT NULL CHECK(origin IN ('pre-existing', 'managed')),
    status TEXT NOT NULL CHECK(status IN ('provisioning', 'ready', 'removed')),
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
  CREATE TABLE publications(
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    payload TEXT NOT NULL,
    UNIQUE(task_id, relative_path, sha256)
  ) STRICT;
`
export const GATE_SQL = `
  CREATE TABLE gate_marker(
    id INTEGER PRIMARY KEY CHECK(id = 1),
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    key TEXT NOT NULL
  ) STRICT;
`

export const encode = (value: unknown): string => {
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
export const parseRecord = <S extends Schema.ConstraintDecoder<unknown>>(
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
export const assertSqliteSafety = (): void => {
  const node = parseVersion(process.versions.node)
  const { sqlite } = process.versions
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

export const rows = (
  db: DatabaseSync,
  sql: string,
  ...params: (string | number | null)[]
): SqlRow[] => db.prepare(sql).all(...params) as SqlRow[]
export const first = (
  db: DatabaseSync,
  sql: string,
  ...params: (string | number | null)[]
): SqlRow | undefined => db.prepare(sql).get(...params) as SqlRow | undefined
export const textField = (row: SqlRow | undefined, key: string): string => {
  const value = row?.[key]
  if (typeof value !== 'string') return requireReview(`Corrupt workspace authority column: ${key}`)
  return value
}
export const numberField = (row: SqlRow | undefined, key: string): number => {
  const value = row?.[key]
  if (typeof value !== 'number' || !Number.isFinite(value))
    return requireReview(`Corrupt workspace authority column: ${key}`)
  return value
}
const normalizeSql = (sql: string): string => sql.replace(/\s+/g, ' ').trim()
export const schemaCatalog = (db: DatabaseSync): string =>
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
export const expectedCatalog = (ddl: string): string => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(ddl)
    return schemaCatalog(db)
  } finally {
    db.close()
  }
}
const schemas = {
  protocol: PROTOCOL_SQL,
  catalog: CATALOG_SQL,
  shard: SHARD_SQL,
  gate: GATE_SQL,
} as const

const schemaFor = (kind: keyof typeof schemas): string => schemas[kind]

export const createPublishedDatabase = (
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
      if (!hasErrorCode(cause, 'EEXIST')) throw cause
    }
    unlinkSync(candidate)
    fsyncParent(path)
  } catch (cause) {
    if (cause instanceof WorkspaceError) throw cause
    unavailable(`Cannot durably publish workspace authority database ${path}: ${errorText(cause)}`)
  } finally {
    try {
      db?.close()
    } catch {}
    if (fd !== undefined) closeSync(fd)
    const candidateInfo = lstatIfExists(candidate)
    if (candidateInfo !== undefined && candidateInfo.isFile() && !candidateInfo.isSymbolicLink())
      unlinkSync(candidate)
  }
}

export const databaseFile = (path: string): void => {
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
  if (schemaCatalog(db) !== expectedCatalog(schemaFor(kind)))
    unavailable(
      `Workspace ${kind} database has an unsupported schema: ${path}. dev never migrates it; quit every dev session and follow Discard the workspace authority in dev's docs/DEVELOPMENT.md.`
    )
  if (textField(first(db, 'PRAGMA integrity_check'), 'integrity_check') !== 'ok')
    requireReview(`Workspace ${kind} database is corrupt: ${path}`)
  databaseFile(path)
}
export const openRecordDb = (
  path: string,
  kind: 'catalog' | 'shard',
  initialize?: (db: DatabaseSync) => void
): DatabaseSync => {
  try {
    const existed = lstatIfExists(path) !== undefined
    if (!existed) {
      if (initialize === undefined) unavailable(`Workspace authority database is missing: ${path}`)
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
    if (sqliteBusy(cause)) blocked(`Workspace authority database is busy: ${path}`)
    unavailable(`Cannot open workspace authority database ${path}: ${errorText(cause)}`)
  }
}
export const transaction = <A>(db: DatabaseSync, operation: () => A): A => {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    db.exec('COMMIT')
    return result
  } catch (cause) {
    try {
      db.exec('ROLLBACK')
    } catch {}
    throw cause
  }
}
