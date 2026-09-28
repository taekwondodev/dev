import { lstatSync, realpathSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { inDb, validateWorkspace, type WorkspaceAuthority } from './workspace-authority.ts'
import { requireReview, type WorkspaceId, type WorkspaceView } from './workspace-domain.ts'
import { incarnationHeld } from './workspace-gates.ts'
import { canonicalGitWorkspace } from './workspace-git.ts'
import {
  getWorkspace,
  getReservation,
  confirmedReleases,
  getUse,
  getUseRows,
  isActiveUse,
  openOperations,
  releaseOperations,
  type ReleaseOperationRecord,
  type WorktreeRemovalRecord,
  type UseRecord,
  type WorkspaceRecord,
} from './workspace-records.ts'
import { errorText } from './error-text.ts'
import { rows, textField } from './workspace-sqlite.ts'
import { effectiveUid, hasErrorCode } from './workspace-platform.ts'

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
  readonly abandoned: () => readonly string[]
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
  const abandoned = input.abandoned()
  if (abandoned.length > 0)
    return {
      outcome: 'blocked',
      reason:
        operation ??
        `Uses ${abandoned.join(', ')} were left unsettled by dev sessions that have ended; processes they started may still run.`,
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

// An owner settles its uses before it releases its incarnation, so a use read before the probe
// found the gate free counts as abandoned only if it is still active afterwards.
const stillActive = (db: DatabaseSync, useId: WorkspaceId): boolean => {
  const current = getUse(db, useId)
  return current !== undefined && isActiveUse(current)
}
export const abandonedUseIds = (
  authority: WorkspaceAuthority,
  db: DatabaseSync,
  uses: readonly UseRecord[]
): readonly WorkspaceId[] =>
  uses
    .filter(
      use =>
        isActiveUse(use) &&
        !incarnationHeld(authority.paths, use.incarnation) &&
        stillActive(db, use.id)
    )
    .map(use => use.id)

const LISTED_PATHS = 5
export const sampledPaths = (paths: readonly string[]): string =>
  `${paths.slice(0, LISTED_PATHS).join(', ')}${paths.length > LISTED_PATHS ? ', …' : ''}`

// A deletion step left `started` stopped before recording its deletions; once a later release
// has observed and closed the attempt, the selected files found missing are named as observed.
const unfinishedDeletion = (operation: WorktreeRemovalRecord): string => {
  if (operation.phase !== 'cancelled' && operation.phase !== 'confirmed')
    return 'stopped during its deletion step, so selected files it did not record as deleted may be gone too'
  const absent = operation.manifest
    .filter(entry => entry.state === 'absent')
    .map(entry => entry.path)
  return absent.length === 0
    ? 'stopped during its deletion step; no selected file was missing afterwards'
    : `stopped during its deletion step, after which ${absent.length} selected file(s) were observed absent: ${sampledPaths(absent)}`
}

export const deletionHistory = (
  db: DatabaseSync,
  workspaceId: WorkspaceId,
  excludedCommand?: WorkspaceId
): readonly string[] =>
  releaseOperations(db, workspaceId).flatMap(operation => {
    if (operation.effect !== 'remove-worktree' || operation.commandId === excludedCommand) return []
    const deleted = operation.manifest
      .filter(entry => entry.state === 'removed')
      .map(entry => entry.path)
    const unfinished = operation.steps.some(
      step => step.kind === 'selected-files' && step.state === 'started'
    )
    const parts: string[] = []
    if (deleted.length > 0)
      parts.push(`deleted ${deleted.length} selected file(s): ${sampledPaths(deleted)}`)
    if (unfinished) parts.push(unfinishedDeletion(operation))
    return parts.length === 0 ? [] : [`Release attempt ${operation.id} ${parts.join(' and ')}.`]
  })

const receiptView = (
  repositoryId: WorkspaceId,
  workspace: WorkspaceRecord,
  release: ReleaseOperationRecord
): WorkspaceView => {
  const removed = workspace.status === 'removed'
  let outcome: WorkspaceView['outcome'] = 'released'
  if (release.effect === 'remove-worktree')
    outcome = release.observed === 'already-absent' ? 'already-absent' : 'removed'
  return {
    repositoryId,
    taskId: release.taskId,
    reservationId: release.reservationId,
    workspaceId: workspace.id,
    path: workspace.path,
    origin: workspace.origin,
    outcome,
    reason:
      release.result ?? (removed ? 'Removed by a confirmed release.' : 'Reservation released.'),
    nextAction: removed
      ? 'Do not resume a conversation into this path; start from an existing checkout with dev --cwd PATH.'
      : 'The checkout is unreserved; select or create a task before writing there.',
    uses: [],
    pending: [],
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
        // A removed workspace is a receipt, shown only for its exact task below.
        if (workspace.status === 'removed') continue
        const uses = getUseRows(db, id)
        const pending = openOperations(db, id).map(value => {
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
        const unknown = uses.some(use => use.stage === 'unknown')
        const live = uses.some(use => isActiveUse(use))
        const { outcome, reason, nextAction } = assessWorkspace({
          identityReason,
          pending: pending[0],
          unresolved,
          unknown,
          live,
          abandoned: () => abandonedUseIds(authority, db, uses),
          reserved: reservation !== undefined,
        })
        views.push({
          repositoryId: repository.id,
          ...(reservation === undefined
            ? {}
            : { taskId: reservation.taskId, reservationId: reservation.id }),
          workspaceId: workspace.id,
          path: workspace.path,
          origin: workspace.origin,
          outcome,
          reason: [reason, ...deletionHistory(db, workspace.id)].join(' '),
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
      if (input.taskId !== undefined)
        for (const operation of confirmedReleases(db, input.taskId)) {
          if (views.some(view => view.workspaceId === operation.workspaceId)) continue
          const workspace = getWorkspace(db, operation.workspaceId)
          if (workspace === undefined) continue
          views.push(receiptView(repository.id, workspace, operation))
        }
      const orphanOperations = openOperations(db).filter(
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
