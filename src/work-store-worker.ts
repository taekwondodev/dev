import {
  closeSync,
  constants,
  fchmodSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  unlinkSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { dirname, isAbsolute, join } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import { setTimeout as delay } from 'node:timers/promises'
import { Schema } from 'effect'
import {
  AttemptRecordSchema,
  OwnerIdentitySchema,
  asAttemptId,
  isAttemptId,
  type AttemptId,
  type AttemptRecord,
} from './work-domain.ts'
import {
  decodeRpcEnvelope,
  decodeWorkerData,
  type ListValue,
  type RpcRequest,
  type RpcSuccess,
  type WorkerData,
} from './work-store-protocol.ts'

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const RETENTION_COUNT = 64
const DATABASE_VERSION = 1
const BUSY_TIMEOUT_MS = 5000
const LOG_FILES = new Set(['stdout.log', 'stderr.log', 'result.txt'])
const CANONICAL_SCHEMA = `
  CREATE TABLE attempts(
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    generation TEXT NOT NULL,
    owner_attempt_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('process', 'agent')),
    controller_pid INTEGER NOT NULL,
    started_at REAL NOT NULL,
    completed_at REAL,
    revision INTEGER NOT NULL,
    payload TEXT NOT NULL,
    retention_blocked INTEGER NOT NULL DEFAULT 0 CHECK(retention_blocked IN (0, 1))
  ) STRICT;
  CREATE INDEX attempts_by_session ON attempts(session_id, started_at DESC, id ASC);
  CREATE INDEX attempts_completed ON attempts(completed_at DESC, id ASC)
    WHERE completed_at IS NOT NULL AND retention_blocked = 0;
  CREATE TRIGGER attempts_reconsider_retention
    AFTER UPDATE OF id, session_id, task_id, generation, owner_attempt_id, kind,
      controller_pid, started_at, completed_at, revision, payload ON attempts
    WHEN OLD.retention_blocked = 1
    BEGIN
      UPDATE attempts SET retention_blocked = 0 WHERE id = NEW.id;
    END;
  CREATE TABLE cleanup(id TEXT PRIMARY KEY) STRICT;
  PRAGMA user_version = 1;
`

class StoreFault extends Error {
  readonly code: string

  constructor(code: string) {
    super()
    this.name = 'StoreFault'
    this.code = code
  }
}

type SqlRow = Record<string, unknown>

interface AttemptRow {
  readonly id: string
  readonly sessionId: string
  readonly taskId: string
  readonly generation: string
  readonly ownerAttemptId: string
  readonly kind: string
  readonly controllerPid: number
  readonly startedAt: number
  readonly completedAt: number | null
  readonly revision: number
  readonly payload: string
}

const fail = (code: string): never => {
  throw new StoreFault(code)
}

const errorCode = (cause: unknown): string =>
  cause instanceof StoreFault ? cause.code : 'database-unavailable'

const looksCorrupt = (cause: unknown): boolean =>
  cause instanceof Error &&
  /not a database|malformed|file is encrypted|database disk image/i.test(cause.message)

const parseVersion = (value: string): readonly [number, number, number] | undefined => {
  const match = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(value)
  if (match === null) return undefined
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  return Number.isSafeInteger(major) && Number.isSafeInteger(minor) && Number.isSafeInteger(patch)
    ? [major, minor, patch]
    : undefined
}

const compareVersion = (
  left: readonly [number, number, number],
  right: readonly [number, number, number]
): number => left[0] - right[0] || left[1] - right[1] || left[2] - right[2]

const walResetSafe = (value: string): boolean => {
  const version = parseVersion(value)
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

const nodeVersionIsSupported = (): boolean => {
  const version = parseVersion(process.versions.node)
  return version !== undefined && compareVersion(version, [22, 23, 2]) >= 0
}

const stringField = (row: SqlRow, key: string): string => {
  const value = row[key]
  return typeof value === 'string' ? value : fail('corrupt-database')
}

const numberField = (row: SqlRow, key: string): number => {
  const value = row[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fail('corrupt-database')
}

const nullableNumberField = (row: SqlRow, key: string): number | null => {
  const value = row[key]
  if (value === null) return null
  return typeof value === 'number' && Number.isFinite(value) ? value : fail('corrupt-database')
}

const attemptRow = (row: SqlRow): AttemptRow => {
  const id = stringField(row, 'id')
  const sessionId = stringField(row, 'session_id')
  const taskId = stringField(row, 'task_id')
  const generation = stringField(row, 'generation')
  const ownerAttemptId = stringField(row, 'owner_attempt_id')
  const kind = stringField(row, 'kind')
  const controllerPid = numberField(row, 'controller_pid')
  const startedAt = numberField(row, 'started_at')
  const completedAt = nullableNumberField(row, 'completed_at')
  const revision = numberField(row, 'revision')
  const payload = stringField(row, 'payload')
  if (
    !Number.isSafeInteger(controllerPid) ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    !Number.isFinite(startedAt) ||
    (completedAt !== null && !Number.isFinite(completedAt))
  )
    fail('corrupt-database')
  if (
    !Schema.is(OwnerIdentitySchema)(
      independentOwnerOf({
        id,
        sessionId,
        taskId,
        generation,
        ownerAttemptId,
        kind,
        controllerPid,
        startedAt,
        completedAt,
        revision,
        payload,
      })
    )
  )
    fail('corrupt-database')
  return {
    id,
    sessionId,
    taskId,
    generation,
    ownerAttemptId,
    kind,
    controllerPid,
    startedAt,
    completedAt,
    revision,
    payload,
  }
}

const attemptRows = (rows: readonly SqlRow[]): AttemptRow[] => rows.map(attemptRow)

const validRecord = (record: AttemptRecord): AttemptRecord => {
  if (
    record.id !== record.owner.attemptId ||
    (record.worktreePath !== undefined &&
      (record.kind !== 'agent' || record.access !== 'write' || !isAbsolute(record.worktreePath))) ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 0 ||
    !Number.isFinite(record.startedAt) ||
    (record.completedAt !== undefined && !Number.isFinite(record.completedAt)) ||
    ['completed', 'failed', 'cancelled'].includes(record.status) !==
      (record.completedAt !== undefined)
  )
    fail('invalid-record')
  return record
}

const payloadOf = (record: AttemptRecord): string => {
  try {
    const payload = JSON.stringify(record)
    return typeof payload === 'string' ? payload : fail('invalid-record')
  } catch {
    return fail('invalid-record')
  }
}

const independentOwnerOf = (row: AttemptRow): unknown => ({
  sessionId: row.sessionId,
  taskId: row.taskId,
  attemptId: row.ownerAttemptId,
  generation: row.generation,
})

const safelyAttributable = (row: AttemptRow, sessionId: WorkerData['sessionId']): boolean =>
  row.sessionId === sessionId &&
  isAttemptId(row.id) &&
  row.ownerAttemptId === row.id &&
  Schema.is(OwnerIdentitySchema)(independentOwnerOf(row))

const sameNullable = (left: number | undefined, right: number | null): boolean =>
  (left ?? null) === right

const agreement = (record: AttemptRecord, row: AttemptRow): boolean =>
  record.id === row.id &&
  record.owner.sessionId === row.sessionId &&
  record.owner.taskId === row.taskId &&
  record.owner.generation === row.generation &&
  record.owner.attemptId === row.ownerAttemptId &&
  record.kind === row.kind &&
  record.controllerPid === row.controllerPid &&
  record.startedAt === row.startedAt &&
  sameNullable(record.completedAt, row.completedAt) &&
  record.revision === row.revision

const decodePayload = (row: AttemptRow): AttemptRecord => {
  let value: unknown
  try {
    value = JSON.parse(row.payload)
  } catch {
    fail('corrupt-record')
  }
  let record: AttemptRecord
  try {
    record = Schema.decodeUnknownSync(AttemptRecordSchema)(value)
  } catch {
    return fail('corrupt-record')
  }
  try {
    validRecord(record)
  } catch {
    return fail('corrupt-record')
  }
  if (!agreement(record, row)) fail('owner-conflict')
  return record
}

const metadataOf = (record: AttemptRecord) => ({
  id: record.id,
  sessionId: record.owner.sessionId,
  taskId: record.owner.taskId,
  generation: record.owner.generation,
  ownerAttemptId: record.owner.attemptId,
  kind: record.kind,
  controllerPid: record.controllerPid,
  startedAt: record.startedAt,
  completedAt: record.completedAt ?? null,
  revision: record.revision,
  payload: payloadOf(record),
})

const changed = (value: number | bigint): boolean => Number(value) === 1

const requireSession = (request: RpcRequest, sessionId: WorkerData['sessionId']): void => {
  if (request.sessionId !== sessionId) fail('session-mismatch')
}

const requireOwnedRecord = (
  record: AttemptRecord,
  sessionId: WorkerData['sessionId']
): AttemptRecord => {
  validRecord(record)
  if (record.owner.sessionId !== sessionId) fail('record-unavailable')
  return record
}

const isMissingPath = (cause: unknown): boolean =>
  cause instanceof Error && 'code' in cause && cause.code === 'ENOENT'

const assertRegularOrMissing = (path: string): boolean => {
  try {
    const info = lstatSync(path)
    if (info.isSymbolicLink() || !info.isFile()) fail('unsafe-path')
    return true
  } catch (cause) {
    if (isMissingPath(cause)) return false
    return fail('unsafe-path')
  }
}

const assertManagedLayout = (root: string, databasePath: string): boolean => {
  try {
    const rootInfo = lstatSync(root)
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) fail('unsafe-path')
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.isDirectory() || !isAttemptId(entry.name))
        fail(entry.name === 'record.json' ? 'legacy-format' : 'unsupported-format')
      const directory = join(root, entry.name)
      for (const child of readdirSync(directory, { withFileTypes: true })) {
        if (child.isSymbolicLink()) fail('unsafe-path')
        if (child.name === 'record.json') fail('legacy-format')
        if (!child.isFile() || !LOG_FILES.has(child.name)) fail('unsupported-format')
      }
    }
  } catch (cause) {
    if (cause instanceof StoreFault) throw cause
    fail('unsafe-path')
  }
  const databaseExists = assertRegularOrMissing(databasePath)
  const sidecars = [
    assertRegularOrMissing(`${databasePath}-wal`),
    assertRegularOrMissing(`${databasePath}-shm`),
    assertRegularOrMissing(`${databasePath}-journal`),
  ]
  if (!databaseExists && sidecars.some(Boolean)) fail('unsafe-path')
  return databaseExists
}

const createSchema = (db: DatabaseSync): void => {
  db.exec(CANONICAL_SCHEMA)
}

const normalizeSql = (sql: string): string => sql.replace(/\s+/g, ' ').trim()

const schemaCatalog = (db: DatabaseSync): string => {
  const objects = db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
    )
    .all()
    .map(row => ({
      type: stringField(row, 'type'),
      name: stringField(row, 'name'),
      table: stringField(row, 'tbl_name'),
      sql: normalizeSql(stringField(row, 'sql')),
    }))
  const tables = db
    .prepare('PRAGMA table_list')
    .all()
    .filter(row => {
      const name = stringField(row, 'name')
      return name !== 'sqlite_schema' && name !== 'sqlite_temp_schema'
    })
    .map(row => ({
      schema: stringField(row, 'schema'),
      name: stringField(row, 'name'),
      type: stringField(row, 'type'),
      columns: numberField(row, 'ncol'),
      withoutRowid: numberField(row, 'wr'),
      strict: numberField(row, 'strict'),
    }))
    .toSorted((left, right) => left.name.localeCompare(right.name))
  return JSON.stringify({ objects, tables })
}

const canonicalCatalog = (): string => {
  const reference = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true })
  try {
    createSchema(reference)
    return schemaCatalog(reference)
  } finally {
    reference.close()
  }
}

const validateExistingSchema = (db: DatabaseSync): void => {
  const userVersionRow = db.prepare('PRAGMA user_version').get()
  const userVersion = numberField(userVersionRow ?? {}, 'user_version')
  const objectCount = numberField(
    db
      .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
      .get() ?? {},
    'count'
  )
  if (userVersion === 0 && objectCount === 0) fail('unsupported-format')
  if (userVersion !== DATABASE_VERSION) fail('unsupported-format')
  if (schemaCatalog(db) !== canonicalCatalog()) fail('unsupported-format')
}

const integrityIsGood = (db: DatabaseSync): boolean => {
  const row = db.prepare('PRAGMA integrity_check').get()
  return row !== undefined && row.integrity_check === 'ok'
}

const fieldText = (row: SqlRow | undefined, key: string): string =>
  row === undefined ? fail('corrupt-database') : stringField(row, key)

const hasCode = (cause: unknown, code: string): boolean =>
  cause instanceof Error && 'code' in cause && cause.code === code

const chmodRegularFile = (path: string): void => {
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    fchmodSync(descriptor, 0o600)
  } catch (cause) {
    if (!hasCode(cause, 'ENOENT')) fail('unsafe-path')
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor)
      } catch {
        fail('unsafe-path')
      }
    }
  }
}

const removeCandidate = (path: string): void => {
  try {
    const info = lstatSync(path)
    if (info.isSymbolicLink() || !info.isFile()) fail('unsafe-path')
    unlinkSync(path)
  } catch (cause) {
    if (!hasCode(cause, 'ENOENT')) {
      if (cause instanceof StoreFault) throw cause
      fail('database-unavailable')
    }
  }
}

const publishCandidate = (data: WorkerData): void => {
  const candidate = join(dirname(data.databasePath), `.attempts.sqlite.candidate.${randomUUID()}`)
  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(candidate, { enableForeignKeyConstraints: true })
    createSchema(database)
    if (!integrityIsGood(database)) fail('corrupt-database')
    database.close()
    database = undefined
    chmodRegularFile(candidate)
    try {
      linkSync(candidate, data.databasePath)
    } catch (cause) {
      if (!hasCode(cause, 'EEXIST')) throw cause
    }
  } catch (cause) {
    if (cause instanceof StoreFault) throw cause
    if (looksCorrupt(cause)) fail('corrupt-database')
    fail('database-unavailable')
  } finally {
    try {
      database?.close()
    } finally {
      removeCandidate(candidate)
    }
  }
}

const enableWal = async (db: DatabaseSync): Promise<void> => {
  const deadline = performance.now() + BUSY_TIMEOUT_MS
  for (;;) {
    try {
      const mode = fieldText(db.prepare('PRAGMA journal_mode = WAL').get(), 'journal_mode')
      if (mode !== 'wal') fail('unsafe-sqlite')
      return
    } catch (cause) {
      // Concurrent journal-mode upgrades can bypass SQLite's busy handler.
      if (
        !(cause instanceof Error) ||
        !('errcode' in cause) ||
        cause.errcode !== 5 ||
        performance.now() >= deadline
      )
        throw cause
      await delay(10)
    }
  }
}

const initializeDatabase = async (
  data: WorkerData
): Promise<{
  readonly sqliteVersion: string
  readonly database: DatabaseSync
}> => {
  if (!nodeVersionIsSupported()) fail('unsafe-sqlite')
  const sqliteVersion = process.versions.sqlite
  if (sqliteVersion === undefined) return fail('unsafe-sqlite')
  if (!walResetSafe(sqliteVersion)) return fail('unsafe-sqlite')
  const databaseExists = assertManagedLayout(data.root, data.databasePath)
  if (!databaseExists) publishCandidate(data)
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(data.databasePath, { enableForeignKeyConstraints: true })
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`)
    if (!integrityIsGood(db)) fail('corrupt-database')
    validateExistingSchema(db)
    await enableWal(db)
    db.exec('PRAGMA synchronous = NORMAL; PRAGMA fullfsync = ON; PRAGMA wal_autocheckpoint = 1000;')
    if (fieldText(db.prepare('PRAGMA journal_mode').get(), 'journal_mode') !== 'wal')
      fail('unsafe-sqlite')
    const synchronous = numberField(db.prepare('PRAGMA synchronous').get() ?? {}, 'synchronous')
    if (synchronous !== 1) fail('unsafe-sqlite')
    if (!integrityIsGood(db)) fail('corrupt-database')
    chmodRegularFile(data.databasePath)
    for (const sidecar of [
      `${data.databasePath}-wal`,
      `${data.databasePath}-shm`,
      `${data.databasePath}-journal`,
    ])
      chmodRegularFile(sidecar)
    return { sqliteVersion, database: db }
  } catch (cause) {
    try {
      db?.close()
    } catch {
      return fail('database-unavailable')
    }
    if (cause instanceof StoreFault) throw cause
    if (looksCorrupt(cause)) return fail('corrupt-database')
    return fail('database-unavailable')
  }
}

let dbConnection: DatabaseSync | undefined

const connection = (): DatabaseSync => dbConnection ?? fail('worker-closed')

const selectById = (id: AttemptId): AttemptRow | undefined => {
  const row = connection().prepare('SELECT * FROM attempts WHERE id = ?').get(id)
  return row === undefined ? undefined : attemptRow(row)
}

const transaction = <A>(body: () => A): A => {
  connection().exec('BEGIN IMMEDIATE')
  try {
    const value = body()
    connection().exec('COMMIT')
    return value
  } catch (cause) {
    try {
      connection().exec('ROLLBACK')
    } catch {
      throw new StoreFault('database-unavailable')
    }
    throw cause
  }
}

const prune = (now: number): void => {
  const stats = connection()
    .prepare(
      'SELECT COUNT(*) AS count, MIN(completed_at) AS oldest FROM attempts WHERE completed_at IS NOT NULL AND retention_blocked = 0'
    )
    .get()
  const count = numberField(stats ?? {}, 'count')
  const oldestValue = stats?.oldest
  const oldest = oldestValue === null ? null : numberField(stats ?? {}, 'oldest')
  const cutoff = now - RETENTION_MS
  if (count <= RETENTION_COUNT && (oldest === null || oldest >= cutoff)) return
  const candidates = attemptRows(
    connection()
      .prepare(
        'SELECT * FROM attempts WHERE completed_at IS NOT NULL AND retention_blocked = 0 ORDER BY completed_at DESC, id ASC'
      )
      .all()
  )
  const valid: { readonly row: AttemptRow; readonly record: AttemptRecord }[] = []
  for (const row of candidates) {
    try {
      valid.push({ row, record: decodePayload(row) })
    } catch {
      // Preserve corrupt records without rescanning them on every operation.
      // A repair of any persisted fact re-enters the partial index atomically.
      connection().prepare('UPDATE attempts SET retention_blocked = 1 WHERE id = ?').run(row.id)
      continue
    }
  }
  for (const [index, item] of valid.entries()) {
    const { row } = item
    const { completedAt, id } = row
    if (completedAt === null) continue
    if (index >= RETENTION_COUNT || completedAt < cutoff) {
      const deleted = connection()
        .prepare('DELETE FROM attempts WHERE id = ? AND completed_at = ?')
        .run(id, completedAt)
      if (changed(deleted.changes))
        connection().prepare('INSERT OR IGNORE INTO cleanup(id) VALUES (?)').run(id)
    }
  }
}

const cleanupIds = (): AttemptId[] =>
  connection()
    .prepare('SELECT id FROM cleanup ORDER BY id ASC')
    .all()
    .flatMap(row => {
      const { id } = row
      return typeof id === 'string' && isAttemptId(id)
        ? [asAttemptId(id)]
        : fail('corrupt-database')
    })

const list = (request: Extract<RpcRequest, { readonly op: 'list' }>): ListValue =>
  transaction(() => {
    prune(request.now)
    const records: AttemptRecord[] = []
    const unavailable: { id: AttemptId; error: string }[] = []
    const rows = attemptRows(
      connection()
        .prepare('SELECT * FROM attempts WHERE session_id = ? ORDER BY started_at DESC, id ASC')
        .all(request.sessionId)
    )
    for (const row of rows) {
      try {
        records.push(decodePayload(row))
      } catch (cause) {
        if (!(cause instanceof StoreFault) || cause.code !== 'corrupt-record') throw cause
        if (!safelyAttributable(row, request.sessionId)) fail('corrupt-database')
        unavailable.push({ id: asAttemptId(row.id), error: 'Record payload is unavailable' })
      }
    }
    return { records, unavailable }
  })

const read = (request: Extract<RpcRequest, { readonly op: 'read' }>): AttemptRecord =>
  transaction(() => {
    prune(request.now)
    const row = selectById(request.attemptId)
    if (row === undefined || row.sessionId !== request.sessionId) return fail('record-unavailable')
    const ownedRow = row
    try {
      return decodePayload(ownedRow)
    } catch {
      return fail('record-unavailable')
    }
  })

const create = (request: Extract<RpcRequest, { readonly op: 'create' }>): null =>
  transaction(() => {
    const record = requireOwnedRecord(request.record, request.sessionId)
    if (record.revision !== 0) fail('revision-conflict')
    const metadata = metadataOf(record)
    const inserted = connection()
      .prepare(
        `INSERT INTO attempts(
          id, session_id, task_id, generation, owner_attempt_id, kind,
          controller_pid, started_at, completed_at, revision, payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        metadata.id,
        metadata.sessionId,
        metadata.taskId,
        metadata.generation,
        metadata.ownerAttemptId,
        metadata.kind,
        metadata.controllerPid,
        metadata.startedAt,
        metadata.completedAt,
        metadata.revision,
        metadata.payload
      )
    if (!changed(inserted.changes)) fail('owner-conflict')
    prune(request.now)
    return null
  })

const save = (request: Extract<RpcRequest, { readonly op: 'save' }>): null =>
  transaction(() => {
    const record = requireOwnedRecord(request.record, request.sessionId)
    const payload = payloadOf(record)
    const row = selectById(record.id)
    if (row === undefined || row.sessionId !== request.sessionId) return fail('record-unavailable')
    const existingRow = row
    if (
      existingRow.id !== record.id ||
      existingRow.ownerAttemptId !== record.owner.attemptId ||
      existingRow.taskId !== record.owner.taskId ||
      existingRow.generation !== record.owner.generation ||
      existingRow.sessionId !== record.owner.sessionId ||
      existingRow.kind !== record.kind ||
      existingRow.controllerPid !== record.controllerPid ||
      existingRow.startedAt !== record.startedAt
    )
      fail('owner-conflict')
    if (record.revision === existingRow.revision) {
      if (payload === existingRow.payload) return null
      fail('revision-conflict')
    }
    // Failed persistence can leave several newer facts in the single owner.
    // Accept its newer snapshot, never an older or conflicting same revision.
    if (record.revision < existingRow.revision) fail('revision-conflict')
    const metadata = metadataOf(record)
    const updated = connection()
      .prepare(
        `UPDATE attempts SET
          session_id = ?, task_id = ?, generation = ?, owner_attempt_id = ?, kind = ?,
          controller_pid = ?, started_at = ?, completed_at = ?, revision = ?, payload = ?
        WHERE id = ? AND session_id = ? AND revision = ?`
      )
      .run(
        metadata.sessionId,
        metadata.taskId,
        metadata.generation,
        metadata.ownerAttemptId,
        metadata.kind,
        metadata.controllerPid,
        metadata.startedAt,
        metadata.completedAt,
        metadata.revision,
        metadata.payload,
        metadata.id,
        existingRow.sessionId,
        existingRow.revision
      )
    if (!changed(updated.changes)) fail('revision-conflict')
    prune(request.now)
    return null
  })

const acknowledge = (request: Extract<RpcRequest, { readonly op: 'ack' }>): null =>
  transaction(() => {
    const statement = connection().prepare(
      'DELETE FROM cleanup WHERE id = ? AND NOT EXISTS (SELECT 1 FROM attempts WHERE id = ?)'
    )
    for (const id of request.attemptIds) statement.run(id, id)
    return null
  })

let worker: { readonly data: WorkerData; readonly sqliteVersion: string } | undefined

const execute = (request: RpcRequest): unknown => {
  const state = worker
  if (state === undefined) return fail('worker-closed')
  requireSession(request, state.data.sessionId)
  if (request.op === 'create') return create(request)
  if (request.op === 'save') return save(request)
  if (request.op === 'list') return list(request)
  if (request.op === 'read') return read(request)
  if (request.op === 'ack') return acknowledge(request)
  if (request.op === 'close') {
    connection().close()
    return null
  }
  return fail('invalid-request')
}

const port = parentPort

const sendFailure = (id: number, code: string): void => {
  port?.postMessage({ id, ok: false, code })
}

try {
  if (port === null) throw new Error('Store worker has no parent port')
  const data = decodeWorkerData(workerData)
  const initialized = await initializeDatabase(data)
  worker = { data, sqliteVersion: initialized.sqliteVersion }
  // Connection-local pragmas must remain on the connection doing the work.
  dbConnection = initialized.database
  port.postMessage({
    type: 'ready',
    sqliteVersion: initialized.sqliteVersion,
    journalMode: fieldText(connection().prepare('PRAGMA journal_mode').get(), 'journal_mode'),
    synchronous: numberField(connection().prepare('PRAGMA synchronous').get() ?? {}, 'synchronous'),
  })
  port.on('message', (raw: unknown) => {
    let requestId = 0
    try {
      const envelope = decodeRpcEnvelope(raw)
      requestId = envelope.id
      const value = execute(envelope.request)
      const response: RpcSuccess = {
        id: envelope.id,
        ok: true,
        value,
        cleanup:
          envelope.request.op === 'ack' || envelope.request.op === 'close' ? [] : cleanupIds(),
      }
      port.postMessage(response)
      if (envelope.request.op === 'close') port.close()
    } catch (cause) {
      sendFailure(requestId, errorCode(cause))
    }
  })
} catch (cause) {
  port?.postMessage({ type: 'startup-error', code: errorCode(cause) })
  try {
    dbConnection?.close()
  } catch {
    process.exitCode = 1
  }
  port?.close()
}
