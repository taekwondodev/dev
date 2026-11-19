import { lstatSync, realpathSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { inDb, validateWorkspace, type WorkspaceAuthority } from './workspace-authority.ts'
import {
  requireReview,
  type ReleaseDecider,
  type WorkspaceHead,
  type WorkspaceId,
  type WorkspaceView,
} from './workspace-domain.ts'
import { incarnationHeld } from './workspace-gates.ts'
import { canonicalGitWorkspace, worktreeHeads } from './workspace-git.ts'
import {
  getWorkspace,
  getReservation,
  confirmedReleases,
  getUse,
  getUseRows,
  isActiveUse,
  openOperations,
  type ReleaseOperationRecord,
  type ReservationRecord,
  type UseRecord,
  type WorkspaceRecord,
} from './workspace-records.ts'
import { errorText } from './error-text.ts'
import { releaseOnceStopped, taskRelease } from './workspace-labels.ts'
import { rows, textField } from './workspace-sqlite.ts'
import { effectiveUid, hasErrorCode, lstatIfExists } from './workspace-platform.ts'

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
    return hasErrorCode(cause, 'ENOENT') ? false : undefined
  }
}

export const checkoutMissing = (workspace: WorkspaceRecord): boolean => {
  if (workspace.origin !== 'pre-existing') return false
  try {
    return lstatIfExists(workspace.path) === undefined
  } catch {
    return false
  }
}

const MISSING_REASON = 'The checkout directory no longer exists.'

const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`)

const missingAdvice = (origin: WorkspaceRecord['origin'], taskId: string | undefined): string => {
  const onPurpose = 'Restore it at this path. If it was deleted on purpose:'
  if (origin === 'managed')
    return taskId === undefined
      ? 'Restore it at this path, or check what removed it. Do not retry automatically.'
      : `${onPurpose} ${releaseOnceStopped(taskId)}`
  const forget = `${releaseOnceStopped(undefined)} That also forgets this checkout once no running session, pending operation or open conversation refers to it.`
  return taskId === undefined
    ? `${onPurpose} ${forget}`
    : `${onPurpose} ${releaseOnceStopped(taskId)} Then: ${forget}`
}

export const assessWorkspace = (input: {
  readonly identityReason: string | undefined
  readonly missing: boolean
  readonly pending: { readonly id: string; readonly stage: string } | undefined
  readonly unresolved: boolean
  readonly unknown: readonly string[]
  readonly live: boolean
  readonly abandoned: () => readonly string[]
  readonly reserved: boolean
  readonly origin: WorkspaceRecord['origin']
  readonly taskId?: string
}): Pick<WorkspaceView, 'outcome' | 'reason' | 'nextAction'> => {
  const operation =
    input.pending === undefined
      ? undefined
      : `Earlier operation ${input.pending.id}: ${input.pending.stage}; checking does not redo it.`
  const taskId = input.reserved ? (input.taskId ?? '<taskId>') : undefined
  const abandoned = input.abandoned()
  const blockers = [
    ...(input.unknown.length > 0
      ? [`Dev could not confirm operations ${input.unknown.join(', ')} stopped.`]
      : []),
    ...(abandoned.length > 0
      ? [`Operations ${abandoned.join(', ')} of ended sessions may still be running.`]
      : []),
  ]
  const withBlockers = (reason: string): string => [reason, ...blockers].join(' ')
  if (input.missing && input.pending === undefined)
    return {
      outcome: 'review-required',
      reason: withBlockers(MISSING_REASON),
      nextAction: missingAdvice(input.origin, taskId),
    }
  if (input.identityReason !== undefined || input.unresolved)
    return {
      outcome: 'review-required',
      reason: withBlockers(
        [input.identityReason, operation]
          .filter(part => part !== undefined)
          .map(sentence)
          .join(' ') || 'An earlier operation may not have finished.'
      ),
      nextAction: 'Check what changed. Do not retry automatically.',
    }
  if (blockers.length > 0)
    return {
      outcome: 'blocked',
      reason: [...(operation === undefined ? [] : [operation]), ...blockers].join(' '),
      nextAction: `Do not write here or retry those operations. ${releaseOnceStopped(taskId)}`,
    }
  if (input.live)
    return {
      outcome: 'active',
      reason: operation ?? 'A session or process is using this checkout.',
      nextAction: 'Wait until it is no longer in use.',
    }
  if (input.reserved)
    return {
      outcome: 'paused',
      reason: operation ?? 'Checkout kept for this task.',
      nextAction: 'Select the task and checkout to resume.',
    }
  return {
    outcome: 'idle',
    reason: operation ?? 'No task holds this checkout.',
    nextAction: 'Select or create a task before requesting write access.',
  }
}

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

const DECIDER_TEXT: Record<ReleaseDecider, string> = {
  user: 'By dev workspace release',
  quit: 'By cleanup at quit',
  replacement: 'By cleanup when changing conversations',
  allocation: 'By cleanup before creating a worktree',
  admission: 'By allowing a write before the first commit',
}

const receiptView = (
  repositoryId: WorkspaceId,
  workspace: WorkspaceRecord,
  release: ReleaseOperationRecord
): WorkspaceView => {
  const removed = workspace.status === 'removed'
  return {
    repositoryId,
    taskId: release.taskId,
    reservationId: release.reservationId,
    workspaceId: workspace.id,
    path: workspace.path,
    origin: workspace.origin,
    outcome: release.effect === 'remove-worktree' ? 'removed' : 'released',
    reason: `${DECIDER_TEXT[release.decider]}: ${release.result ?? (removed ? 'Removed.' : 'Checkout freed for other work.')}`,
    nextAction: removed
      ? 'Do not resume a conversation into this path; start from an existing checkout with dev --cwd PATH.'
      : 'Select or create a task before writing here.',
    uses: [],
    pending: [],
  }
}

type PendingOperation = WorkspaceView['pending'][number]

export interface WorkspaceStanding extends Pick<
  WorkspaceView,
  'outcome' | 'reason' | 'nextAction'
> {
  readonly missing: boolean
  readonly pending: readonly PendingOperation[]
}

export const workspaceStanding = (
  authority: WorkspaceAuthority,
  db: DatabaseSync,
  workspace: WorkspaceRecord,
  reserved: boolean,
  uses: readonly UseRecord[],
  taskId?: string
): WorkspaceStanding => {
  const pending = openOperations(db, workspace.id).map(value => ({
    id: value.id,
    kind: value.kind,
    stage: value.phase,
  }))
  const missing = checkoutMissing(workspace)
  let identityReason: string | undefined = missing ? MISSING_REASON : undefined
  if (!missing)
    try {
      validateWorkspace(authority, workspace)
    } catch (cause) {
      identityReason = errorText(cause)
    }
  return {
    ...assessWorkspace({
      identityReason,
      missing,
      pending: pending[0],
      unresolved: pending.some(operation => operation.stage !== 'intent'),
      unknown: uses.filter(use => use.stage === 'unknown').map(use => use.id),
      live: uses.some(use => isActiveUse(use)),
      abandoned: () => abandonedUseIds(authority, db, uses),
      reserved,
      origin: workspace.origin,
      ...(taskId === undefined ? {} : { taskId }),
    }),
    missing,
    pending,
  }
}

export const lastUsedAt = (
  reservation: ReservationRecord | undefined,
  uses: readonly UseRecord[]
): number | undefined => {
  const times = [
    ...(reservation === undefined ? [] : [reservation.createdAt]),
    ...uses.map(use => use.updatedAt),
  ]
  return times.length === 0 ? undefined : Math.max(...times)
}

export const repositoryHeads = (commonPath: string): ReadonlyMap<string, WorkspaceHead> => {
  try {
    return worktreeHeads(commonPath)
  } catch {
    return new Map()
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
    let heads: ReadonlyMap<string, WorkspaceHead> | undefined
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
        if (workspace === undefined) requireReview(`Checkout record disappeared: ${id}`)
        present.add(id)
        const reservation = getReservation(db, id)
        if (input.taskId !== undefined && reservation?.taskId !== input.taskId) continue

        if (workspace.status === 'removed') continue
        const uses = getUseRows(db, id)
        const { outcome, reason, nextAction, missing, pending } = workspaceStanding(
          authority,
          db,
          workspace,
          reservation !== undefined,
          uses,
          reservation?.taskId
        )
        for (const operation of pending) visibleOperationIds.add(operation.id)
        heads ??= repositoryHeads(repository.commonPath)
        const head = heads.get(workspace.path)
        const usedAt = lastUsedAt(reservation, uses)
        views.push({
          repositoryId: repository.id,
          ...(reservation === undefined
            ? {}
            : { taskId: reservation.taskId, reservationId: reservation.id }),
          workspaceId: workspace.id,
          path: workspace.path,
          origin: workspace.origin,
          outcome,
          reason,
          nextAction,
          ...(missing ? { directoryMissing: true } : {}),
          ...(head === undefined ? {} : { head }),
          ...(usedAt === undefined ? {} : { lastUsedAt: usedAt }),
          uses: uses.map(use => ({
            id: use.id,
            access: use.access,
            stage: use.stage,
            effect: use.effect,
            path: use.operationPath,
            reason: use.reason,
            execution: use.execution,
            logsAvailable:
              use.execution?.logs === undefined ? undefined : logAvailability(use.execution.logs),
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
          reason: `No usable checkout after operation ${operation.id} (${operation.phase}).`,
          nextAction:
            operation.kind === 'allocation'
              ? `Do not retry or use it. Once nothing still works in any of the task's checkouts, the user may run ${taskRelease(operation.taskId)}, including what Git created of this one.`
              : 'Check what Git changed. Do not retry or use the checkout; the user must resolve it.',
          uses: [],
          pending: [{ id: operation.id, kind: operation.kind, stage: operation.phase }],
          reservationId: operation.reservationId,
        })
      }
    })
  }
  return views
}
