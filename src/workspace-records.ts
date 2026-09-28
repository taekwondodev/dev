import type { DatabaseSync } from 'node:sqlite'
import { Schema } from 'effect'
import {
  blocked,
  requireReview,
  PublicationReferenceSchema,
  CommitSha,
  RelativeFilePath,
  Revision,
  RuleApprovalSchema,
  Sha256Hex,
  TaskTargetSchema,
  WorkspaceAccessSchema,
  WorkspaceBindingSchema,
  WorkspaceEffectSchema,
  WorkspaceExecutionSchema,
  WorkspaceId,
  WorkspaceOriginSchema,
  WorkspaceProcessSchema,
  type PublicationReference,
  type RuleApproval,
  type WorkspaceBinding,
  type WorkspaceOrigin,
} from './workspace-domain.ts'
import {
  canonicalGitWorkspace,
  FileIdentitySchema,
  type FileIdentity,
  type GitWorkspace,
} from './workspace-git.ts'
import { canonicalPathSlot } from './workspace-paths.ts'
import { encode, parseRecord, rows, first, textField, numberField } from './workspace-sqlite.ts'
import { errorText } from './error-text.ts'
import { newId, now, hash } from './workspace-platform.ts'

const TaskSchema = Schema.Struct({
  id: WorkspaceId,
  repositoryId: WorkspaceId,
  target: Schema.optional(TaskTargetSchema),
  revision: Revision,
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
  revision: Revision,
})
const WorkspaceSchema = Schema.Struct({
  id: WorkspaceId,
  repositoryId: WorkspaceId,
  path: Schema.NonEmptyString,
  pathKey: Schema.NonEmptyString,
  physical: FileIdentitySchema,
  gitAdminPath: Schema.NonEmptyString,
  gitAdmin: FileIdentitySchema,
  commonPath: Schema.NonEmptyString,
  common: FileIdentitySchema,
  objectFormat: Schema.NonEmptyString,
  origin: WorkspaceOriginSchema,

  status: Schema.Literals(['provisioning', 'ready', 'removed']),
  allocationOperationId: Schema.optional(WorkspaceId),
  removalOperationId: Schema.optional(WorkspaceId),
  revision: Revision,
  createdAt: Schema.Finite,
})
const ReservationSchema = Schema.Struct({
  id: WorkspaceId,
  taskId: WorkspaceId,
  workspaceId: WorkspaceId,
  acquisitionId: Schema.optional(WorkspaceId),
  revision: Revision,
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
  access: WorkspaceAccessSchema,
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
  incarnation: WorkspaceId,
  bindingRevision: Revision,
  revision: Revision,
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
})
const OperationPhase = Schema.Literals([
  'intent',
  'started',
  'confirmed',
  'cancelled',
  'unknown',
  'review-required',
])
const TransitionOperationSchema = Schema.Struct({
  id: WorkspaceId,
  kind: Schema.Literals(['allocation', 'handoff']),
  phase: OperationPhase,
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
  expectedBindingRevision: Revision,
  reason: Schema.NonEmptyString,
  createdAt: Schema.Finite,
  result: Schema.optional(Schema.String),
})
export const ManifestEntrySchema = Schema.Struct({
  path: RelativeFilePath,
  kind: Schema.Literals(['file', 'symlink']),
  device: Schema.NonEmptyString,
  inode: Schema.NonEmptyString,
  size: Schema.Int,
  mtimeNs: Schema.String,
  sha256: Schema.optional(Sha256Hex),
  coverage: Schema.Literals(['published', 'regenerable']),
  state: Schema.Literals(['pending', 'removed', 'absent', 'failed']),
  detail: Schema.optional(Schema.String),
})
export type ManifestEntry = typeof ManifestEntrySchema.Type
const ReleaseStepSchema = Schema.Struct({
  kind: Schema.Literals(['selected-files', 'git-worktree-remove', 'registration', 'records']),
  state: Schema.Literals(['pending', 'started', 'done', 'failed', 'observed']),
  detail: Schema.optional(Schema.String),
})
export type ReleaseStep = typeof ReleaseStepSchema.Type
const ReleaseOperationFields = {
  id: WorkspaceId,
  kind: Schema.Literal('release'),
  phase: OperationPhase,
  repositoryId: WorkspaceId,
  workspaceId: WorkspaceId,
  taskId: WorkspaceId,
  reservationId: WorkspaceId,
  acquisitionId: Schema.optional(WorkspaceId),
  commandId: WorkspaceId,
  targetPath: Schema.NonEmptyString,
  head: Schema.optional(CommitSha),
  stateDigest: Sha256Hex,
  policyVersion: Schema.Int,
  expectedReservationRevision: Revision,
  reason: Schema.NonEmptyString,
  createdAt: Schema.Finite,
  result: Schema.optional(Schema.String),
}
export const ReservationReleaseOperationSchema = Schema.Struct({
  ...ReleaseOperationFields,
  effect: Schema.Literal('release-reservation'),
})
export const WorktreeRemovalOperationSchema = Schema.Struct({
  ...ReleaseOperationFields,
  effect: Schema.Literal('remove-worktree'),
  gitAdminPath: Schema.NonEmptyString,
  manifest: Schema.Array(ManifestEntrySchema),
  steps: Schema.Array(ReleaseStepSchema),
  observed: Schema.optional(Schema.Literals(['removed', 'already-absent'])),
})
export const OperationSchema = Schema.Union([
  TransitionOperationSchema,
  ReservationReleaseOperationSchema,
  WorktreeRemovalOperationSchema,
])

type TaskRecord = typeof TaskSchema.Type
export type RepositoryCatalogRecord = typeof RepositoryCatalogSchema.Type
export type WorkspaceRecord = typeof WorkspaceSchema.Type
export type ReservationRecord = typeof ReservationSchema.Type
export type BindingRecord = typeof BindingSchema.Type
export type UseRecord = typeof UseSchema.Type
export type OperationRecord = typeof OperationSchema.Type
export type TransitionOperationRecord = typeof TransitionOperationSchema.Type
export type ReservationReleaseRecord = typeof ReservationReleaseOperationSchema.Type
export type WorktreeRemovalRecord = typeof WorktreeRemovalOperationSchema.Type
export type ReleaseOperationRecord = ReservationReleaseRecord | WorktreeRemovalRecord

export const operationRevision = (operation: OperationRecord): number =>
  operation.kind === 'release'
    ? operation.expectedReservationRevision
    : operation.expectedBindingRevision
const OPEN_PHASES = "('intent','started','unknown','review-required')"

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
export const putTask = (db: DatabaseSync, value: TaskRecord): void => {
  db.prepare('INSERT INTO tasks(id, revision, payload) VALUES(?,?,?)').run(
    value.id,
    value.revision,
    encode(value)
  )
}
export const saveTask = (db: DatabaseSync, value: TaskRecord): void => {
  db.prepare('UPDATE tasks SET revision=?, payload=? WHERE id=? AND revision=?').run(
    value.revision,
    encode(value),
    value.id,
    value.revision - 1
  )
  if (numberField(first(db, 'SELECT changes() AS count'), 'count') !== 1)
    requireReview(`Task record changed concurrently: ${value.id}`)
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
  db.prepare(
    'INSERT INTO workspaces(id,path_key,path,origin,status,revision,payload) VALUES(?,?,?,?,?,?,?)'
  ).run(
    value.id,
    value.pathKey,
    value.path,
    value.origin,
    value.status,
    value.revision,
    encode(value)
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
  db.prepare(
    'INSERT INTO reservations(id,workspace_id,task_id,acquisition_id,revision,payload) VALUES(?,?,?,?,?,?)'
  ).run(
    value.id,
    value.workspaceId,
    value.taskId,
    value.acquisitionId ?? null,
    value.revision,
    encode(value)
  )
}

export const deleteReservation = (db: DatabaseSync, value: ReservationRecord): void => {
  db.prepare('DELETE FROM reservations WHERE id=? AND workspace_id=? AND revision=?').run(
    value.id,
    value.workspaceId,
    value.revision
  )
  if (numberField(first(db, 'SELECT changes() AS count'), 'count') !== 1)
    requireReview(`Reservation changed before its release was recorded: ${value.id}`)
}
export const saveWorkspace = (db: DatabaseSync, value: WorkspaceRecord): void => {
  db.prepare(
    'UPDATE workspaces SET path_key=?,path=?,origin=?,status=?,revision=?,payload=? WHERE id=? AND revision=?'
  ).run(
    value.pathKey,
    value.path,
    value.origin,
    value.status,
    value.revision,
    encode(value),
    value.id,
    value.revision - 1
  )
  if (numberField(first(db, 'SELECT changes() AS count'), 'count') !== 1)
    requireReview(`Workspace record changed concurrently: ${value.id}`)
}
export const updateReservation = (db: DatabaseSync, value: ReservationRecord): void => {
  db.prepare(
    'UPDATE reservations SET task_id=?,acquisition_id=?,revision=?,payload=? WHERE id=? AND workspace_id=?'
  ).run(
    value.taskId,
    value.acquisitionId ?? null,
    value.revision,
    encode(value),
    value.id,
    value.workspaceId
  )
  if (numberField(first(db, 'SELECT changes() AS count'), 'count') !== 1)
    requireReview(`Reservation disappeared: ${value.id}`)
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
  db.prepare(`INSERT INTO bindings(conversation_key,workspace_id,task_id,revision,payload) VALUES(?,?,?,?,?)
    ON CONFLICT(conversation_key) DO UPDATE SET workspace_id=excluded.workspace_id,task_id=excluded.task_id,revision=excluded.revision,payload=excluded.payload`).run(
    value.key,
    value.workspaceId,
    value.taskId ?? null,
    value.revision,
    encode(value)
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
  db.prepare(
    'INSERT INTO uses(id,workspace_id,task_id,reservation_id,acquisition_id,access,stage,revision,payload) VALUES(?,?,?,?,?,?,?,?,?)'
  ).run(
    value.id,
    value.workspaceId,
    value.taskId ?? null,
    value.reservationId ?? null,
    value.acquisitionId ?? null,
    value.access,
    value.stage,
    value.revision,
    encode(value)
  )
}
export const saveUse = (db: DatabaseSync, value: UseRecord): void => {
  const stored = getUse(db, value.id)
  if (stored?.stage === 'unknown' && value.stage !== 'unknown')
    requireReview(`Workspace use ${value.id} is unknown; only explicit recovery can resolve it`)
  if (value.stage === 'quiescent')
    assertNoActiveDependentUseInDb(db, value.id, `Cannot settle workspace use ${value.id}`)
  db.prepare(
    'UPDATE uses SET workspace_id=?,task_id=?,reservation_id=?,acquisition_id=?,access=?,stage=?,revision=?,payload=? WHERE id=?'
  ).run(
    value.workspaceId,
    value.taskId ?? null,
    value.reservationId ?? null,
    value.acquisitionId ?? null,
    value.access,
    value.stage,
    value.revision,
    encode(value),
    value.id
  )
  if (numberField(first(db, 'SELECT changes() AS count'), 'count') !== 1)
    requireReview(`Workspace use disappeared: ${value.id}`)
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
    operationRevision(value) !== numberField(row, 'revision')
  )
    requireReview(`Operation columns disagree with payload: ${id}`)
  return value
}
export const putOperation = (db: DatabaseSync, value: OperationRecord): void => {
  db.prepare(
    'INSERT INTO operations(id,kind,phase,workspace_id,task_id,revision,created_at,payload) VALUES(?,?,?,?,?,?,?,?)'
  ).run(
    value.id,
    value.kind,
    value.phase,
    value.workspaceId,
    value.taskId,
    operationRevision(value),
    value.createdAt,
    encode(value)
  )
}
export const saveOperation = (db: DatabaseSync, value: OperationRecord): void => {
  db.prepare(
    'UPDATE operations SET kind=?,phase=?,workspace_id=?,task_id=?,revision=?,created_at=?,payload=? WHERE id=?'
  ).run(
    value.kind,
    value.phase,
    value.workspaceId,
    value.taskId,
    operationRevision(value),
    value.createdAt,
    encode(value),
    value.id
  )
  if (numberField(first(db, 'SELECT changes() AS count'), 'count') !== 1)
    requireReview(`Workspace operation disappeared: ${value.id}`)
}
const operationsWhere = (
  db: DatabaseSync,
  condition: string,
  ...params: string[]
): OperationRecord[] =>
  rows(db, `SELECT id FROM operations WHERE ${condition} ORDER BY created_at,id`, ...params)
    .map(row => getOperation(db, textField(row, 'id')))
    .filter((value): value is OperationRecord => value !== undefined)
const isRelease = (operation: OperationRecord): operation is ReleaseOperationRecord =>
  operation.kind === 'release'

export const isUnresolvedRelease = (
  operation: OperationRecord
): operation is ReleaseOperationRecord =>
  isRelease(operation) &&
  (operation.phase === 'started' ||
    operation.phase === 'unknown' ||
    operation.phase === 'review-required')
export const openOperations = (db: DatabaseSync, workspaceIdValue?: string): OperationRecord[] =>
  workspaceIdValue === undefined
    ? operationsWhere(db, `phase IN ${OPEN_PHASES}`)
    : operationsWhere(db, `workspace_id=? AND phase IN ${OPEN_PHASES}`, workspaceIdValue)
export const assertNoUnresolvedRelease = (db: DatabaseSync, workspaceIdValue: string): void => {
  const unresolved = unresolvedReleases(db, workspaceIdValue)
  if (unresolved.length > 0)
    requireReview(
      `Release ${unresolved.map(operation => `${operation.id} (${operation.phase})`).join(', ')} left this workspace unresolved; observe its effects before using it: ${workspaceIdValue}`
    )
}
export const unresolvedReleases = (
  db: DatabaseSync,
  workspaceIdValue: string
): ReleaseOperationRecord[] => openOperations(db, workspaceIdValue).filter(isUnresolvedRelease)
const unstartedReleases = (db: DatabaseSync, workspaceIdValue: string): ReleaseOperationRecord[] =>
  openOperations(db, workspaceIdValue)
    .filter(isRelease)
    .filter(operation => operation.phase === 'intent')
export const releaseOperations = (
  db: DatabaseSync,
  workspaceIdValue: string
): ReleaseOperationRecord[] =>
  operationsWhere(db, "workspace_id=? AND kind='release'", workspaceIdValue).filter(isRelease)
export const confirmedReleases = (db: DatabaseSync, taskId: string): ReleaseOperationRecord[] =>
  operationsWhere(db, "task_id=? AND kind='release' AND phase='confirmed'", taskId).filter(
    isRelease
  )
export const cancelUnstartedReleases = (
  db: DatabaseSync,
  workspaceIdValue: string,
  result: string
): void => {
  for (const operation of unstartedReleases(db, workspaceIdValue))
    saveOperation(db, { ...operation, phase: 'cancelled', result })
}

export const getPublications = (db: DatabaseSync, taskId: string): PublicationReference[] =>
  rows(
    db,
    'SELECT id, payload FROM publications WHERE task_id=? ORDER BY relative_path, id',
    taskId
  ).map(row => {
    const value = parseRecord(
      PublicationReferenceSchema,
      row.payload,
      `publication ${textField(row, 'id')}`
    )
    if (value.id !== textField(row, 'id') || value.taskId !== taskId)
      requireReview(`Publication columns disagree with payload: ${value.id}`)
    return value
  })
export const putPublication = (db: DatabaseSync, value: PublicationReference): void => {
  db.prepare(`INSERT INTO publications(id,task_id,relative_path,sha256,payload) VALUES(?,?,?,?,?)
    ON CONFLICT(task_id,relative_path,sha256) DO UPDATE SET id=excluded.id, payload=excluded.payload`).run(
    value.id,
    value.taskId,
    value.relativePath,
    value.sha256,
    encode(value)
  )
}
export const getRuleApprovals = (db: DatabaseSync, repositoryId: string): RuleApproval[] =>
  rows(
    db,
    'SELECT id, payload FROM rule_approvals WHERE repository_id=? ORDER BY locator, id',
    repositoryId
  ).map(row => {
    const value = parseRecord(
      RuleApprovalSchema,
      row.payload,
      `rule approval ${textField(row, 'id')}`
    )
    if (value.id !== textField(row, 'id') || value.repositoryId !== repositoryId)
      requireReview(`Rule approval columns disagree with payload: ${value.id}`)
    return value
  })
export const putRuleApproval = (db: DatabaseSync, value: RuleApproval): void => {
  db.prepare(`INSERT INTO rule_approvals(id,repository_id,locator,digest,payload) VALUES(?,?,?,?,?)
    ON CONFLICT(repository_id,locator,digest) DO NOTHING`).run(
    value.id,
    value.repositoryId,
    value.locator,
    value.digest,
    encode(value)
  )
}
export const getUseRows = (db: DatabaseSync, workspaceIdValue: string): UseRecord[] =>
  rows(db, 'SELECT id FROM uses WHERE workspace_id=? ORDER BY id', workspaceIdValue)
    .map(row => getUse(db, textField(row, 'id')))
    .filter((value): value is UseRecord => value !== undefined)
const getAllUseRows = (db: DatabaseSync): UseRecord[] =>
  rows(db, 'SELECT id FROM uses ORDER BY id')
    .map(row => getUse(db, textField(row, 'id')))
    .filter((value): value is UseRecord => value !== undefined)

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
  origin: WorkspaceOrigin,
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
  if (record.status === 'removed')
    return requireReview(
      `Workspace was removed by release ${record.removalOperationId ?? '(unrecorded)'} and is not recreated: ${record.path}`
    )
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
