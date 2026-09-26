import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { inDb, validateWorkspace, type WorkspaceAuthority } from './workspace-authority.ts'
import { invalid, requireReview, type WorkspaceId, type WorkspaceView } from './workspace-domain.ts'
import { incarnationHeld } from './workspace-gates.ts'
import { canonicalGitWorkspace } from './workspace-git.ts'
import {
  getWorkspace,
  getReservation,
  getOperation,
  getUseRows,
  isActiveUse,
  type OperationRecord,
} from './workspace-records.ts'
import { errorText, effectiveUid, rows, textField } from './workspace-sqlite.ts'
import { hasErrorCode } from './workspace-paths.ts'

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
    return hasErrorCode(cause, 'ENOENT') ? false : undefined
  }
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
        `Uses ${input.abandoned.join(', ')} were left unsettled by dev sessions that have ended; processes they started may still run.`,
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

export const inspectWorkspaces = (
  authority: WorkspaceAuthority,
  input: { readonly cwd?: string; readonly taskId?: WorkspaceId }
): readonly WorkspaceView[] => {
  const namespace = authority.inspectExisting()
  if (namespace === undefined) return []
  let repositoryFilter: WorkspaceId | undefined
  if (input.cwd !== undefined) {
    if (!isAbsolute(input.cwd)) invalid('Inspection cwd must be absolute')
    repositoryFilter = authority.findRepository(canonicalGitWorkspace(input.cwd))
    if (repositoryFilter === undefined) return []
  }
  const repositories =
    repositoryFilter === undefined
      ? authority.listRepositories()
      : authority.listRepositories().filter(repository => repository.id === repositoryFilter)
  const views: WorkspaceView[] = []
  const visibleOperationIds = new Set<string>()
  for (const repository of repositories) {
    inDb(authority, repository.id, db => {
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
          validateWorkspace(authority, workspace)
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
                    use => isActiveUse(use) && !incarnationHeld(authority.paths, use.incarnation)
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
}
