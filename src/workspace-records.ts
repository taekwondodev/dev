import type { DatabaseSync } from 'node:sqlite'
import { Schema } from 'effect'
import {
  blocked,
  requireReview,
  WorkspaceBindingSchema,
  WorkspaceEffectSchema,
  WorkspaceExecutionSchema,
  WorkspaceId,
  WorkspaceProcessSchema,
  type WorkspaceBinding,
} from './workspace-domain.ts'
import { canonicalGitWorkspace, type FileIdentity, type GitWorkspace } from './workspace-git.ts'
import { canonicalPathSlot } from './workspace-paths.ts'
import {
  newId,
  encode,
  parseRecord,
  now,
  hash,
  errorText,
  rows,
  first,
  textField,
  numberField,
  decodeOrFail,
} from './workspace-sqlite.ts'

const PhysicalSchema = Schema.Struct({
  device: Schema.NonEmptyString,
  inode: Schema.NonEmptyString,
})
const TaskSchema = Schema.Struct({
  id: WorkspaceId,
  repositoryId: WorkspaceId,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  createdAt: Schema.Finite,
})
export const RepositoryCatalogSchema = Schema.Struct({
  id: WorkspaceId,
  commonPath: Schema.NonEmptyString,
  device: Schema.NonEmptyString,
  inode: Schema.NonEmptyString,
  objectFormat: Schema.NonEmptyString,
  state: Schema.Literals(['provisioning', 'ready']),
  provisionId: WorkspaceId,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
const WorkspaceSchema = Schema.Struct({
  id: WorkspaceId,
  repositoryId: WorkspaceId,
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
  allocationOperationId: Schema.optional(WorkspaceId),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  createdAt: Schema.Finite,
})
const ReservationSchema = Schema.Struct({
  id: WorkspaceId,
  taskId: WorkspaceId,
  workspaceId: WorkspaceId,
  acquisitionId: Schema.optional(WorkspaceId),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  createdAt: Schema.Finite,
})
export const BindingSchema = Schema.Struct({
  key: Schema.NonEmptyString,
  ...WorkspaceBindingSchema.fields,
  pendingOperationId: Schema.optional(WorkspaceId),
  superseded: Schema.optional(Schema.Boolean),
})
export const UseSchema = Schema.Struct({
  id: WorkspaceId,
  workspaceId: WorkspaceId,
  taskId: Schema.optional(WorkspaceId),
  reservationId: Schema.optional(WorkspaceId),
  acquisitionId: Schema.optional(WorkspaceId),
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
  withinUseId: Schema.optional(WorkspaceId),
  operationPath: Schema.optional(Schema.NonEmptyString),
  execution: Schema.optional(WorkspaceExecutionSchema),
  processes: Schema.Array(WorkspaceProcessSchema),
  reason: Schema.optional(Schema.String),
  incarnation: Schema.NonEmptyString,
  bindingRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
})
export const OperationSchema = Schema.Struct({
  id: WorkspaceId,
  kind: Schema.Literals(['allocation', 'handoff']),
  phase: Schema.Literals([
    'intent',
    'started',
    'confirmed',
    'cancelled',
    'unknown',
    'review-required',
  ]),
  repositoryId: WorkspaceId,
  workspaceId: WorkspaceId,
  taskId: WorkspaceId,
  reservationId: WorkspaceId,
  acquisitionId: Schema.optional(WorkspaceId),
  sourceRepositoryId: WorkspaceId,
  sourceWorkspaceId: WorkspaceId,
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
export type RepositoryCatalogRecord = typeof RepositoryCatalogSchema.Type
export type WorkspaceRecord = typeof WorkspaceSchema.Type
export type ReservationRecord = typeof ReservationSchema.Type
export type BindingRecord = typeof BindingSchema.Type
export type UseRecord = typeof UseSchema.Type
export type OperationRecord = typeof OperationSchema.Type

export const sameIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  left.device === right.device && left.inode === right.inode

export const getTask = (db: DatabaseSync, id: string): TaskRecord | undefined => {
  const row = first(db, 'SELECT id, revision, payload FROM tasks WHERE id=?', id)
  if (row === undefined) return undefined
  const value = parseRecord(TaskSchema, row.payload, `task ${id}`)
  if (value.id !== textField(row, 'id') || value.revision !== numberField(row, 'revision'))
    requireReview(`Task columns disagree with payload: ${id}`)
  return value
}
// Writers validate because records carry Git and filesystem values that no boundary decoded.
export const putTask = (db: DatabaseSync, value: TaskRecord): void => {
  const checked = decodeOrFail(TaskSchema, value, 'task record')
  db.prepare('INSERT INTO tasks(id, revision, payload) VALUES(?,?,?)').run(
    checked.id,
    checked.revision,
    encode(checked)
  )
}
export const getWorkspace = (db: DatabaseSync, id: string): WorkspaceRecord | undefined => {
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
export const getWorkspaceByPath = (db: DatabaseSync, path: string): WorkspaceRecord | undefined => {
  const row = first(db, 'SELECT id FROM workspaces WHERE path_key=?', hash(canonicalPathSlot(path)))
  return row === undefined ? undefined : getWorkspace(db, textField(row, 'id'))
}
export const putWorkspace = (db: DatabaseSync, value: WorkspaceRecord): void => {
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
export const getReservation = (
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
export const getReservationById = (db: DatabaseSync, id: string): ReservationRecord | undefined => {
  const row = first(db, 'SELECT workspace_id FROM reservations WHERE id=?', id)
  return row === undefined ? undefined : getReservation(db, textField(row, 'workspace_id'))
}
export const putReservation = (db: DatabaseSync, value: ReservationRecord): void => {
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
export const updateReservation = (db: DatabaseSync, value: ReservationRecord): void => {
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
export const getBinding = (db: DatabaseSync, key: string): BindingRecord | undefined => {
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
export const putBinding = (db: DatabaseSync, value: BindingRecord): void => {
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
export const getUse = (db: DatabaseSync, id: string): UseRecord | undefined => {
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
export const putUse = (db: DatabaseSync, value: UseRecord): void => {
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
export const saveUse = (db: DatabaseSync, value: UseRecord): void => {
  const checked = decodeOrFail(UseSchema, value, 'workspace use')
  // Every settling route writes through here, so the absorbing `unknown` and dependent
  // rules of ADR 0005 cannot be bypassed by a new route.
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
export const getOperation = (db: DatabaseSync, id: string): OperationRecord | undefined => {
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
export const putOperation = (db: DatabaseSync, value: OperationRecord): void => {
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
export const saveOperation = (db: DatabaseSync, value: OperationRecord): void => {
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
export const getUseRows = (db: DatabaseSync, workspaceIdValue: string): UseRecord[] =>
  rows(db, 'SELECT id FROM uses WHERE workspace_id=? ORDER BY id', workspaceIdValue)
    .map(row => getUse(db, textField(row, 'id')))
    .filter((value): value is UseRecord => value !== undefined)
const getAllUseRows = (db: DatabaseSync): UseRecord[] =>
  rows(db, 'SELECT id FROM uses ORDER BY id')
    .map(row => getUse(db, textField(row, 'id')))
    .filter((value): value is UseRecord => value !== undefined)
// Scoped uses are admitted within an ordinary grant, whose gates they write under, so
// that grant cannot settle while one of them is live.
export const activeDependentUses = (db: DatabaseSync, useIdValue: string): UseRecord[] =>
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
export const assertWithinLiveInDb = (db: DatabaseSync, use: UseRecord): void => {
  if (use.withinUseId === undefined) return
  const parent = getUse(db, use.withinUseId)
  if (parent === undefined)
    requireReview(`Scoped operation lost its within grant: ${use.withinUseId}`)
  if (parent.stage !== 'authorized')
    blocked(`Scoped operation cannot start under a ${parent.stage} within grant: ${parent.id}`)
}

export const makeWorkspaceRecord = (
  repositoryId: WorkspaceId,
  git: GitWorkspace,
  origin: 'pre-existing' | 'managed',
  id = newId(),
  allocationOperationId?: WorkspaceId
): WorkspaceRecord => ({
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
})
export const matchesGitWorkspace = (record: WorkspaceRecord, git: GitWorkspace): boolean =>
  record.path === git.path &&
  sameIdentity(record.physical, git.identity) &&
  record.gitAdminPath === git.gitAdminPath &&
  sameIdentity(record.gitAdmin, git.gitAdminIdentity) &&
  record.commonPath === git.commonPath &&
  sameIdentity(record.common, git.commonIdentity) &&
  record.objectFormat === git.objectFormat
export const validateWorkspacePath = (record: WorkspaceRecord): GitWorkspace => {
  if (record.status !== 'ready')
    return requireReview(`Workspace allocation is unresolved: ${record.path}`)
  let actual: GitWorkspace
  try {
    actual = canonicalGitWorkspace(record.path)
  } catch (cause) {
    return requireReview(`Cannot verify workspace ${record.path}: ${errorText(cause)}`)
  }
  if (!matchesGitWorkspace(record, actual))
    return requireReview(`Workspace path or Git identity was replaced: ${record.path}`)
  return actual
}

export const toBinding = (record: BindingRecord): WorkspaceBinding => ({
  conversation: record.conversation,
  ...(record.taskId === undefined ? {} : { taskId: record.taskId }),
  workspaceId: record.workspaceId,
  cwd: record.cwd,
  revision: record.revision,
})

export const isActiveUse = (use: UseRecord): boolean => use.stage !== 'quiescent'
