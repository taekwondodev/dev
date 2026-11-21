import { realpathSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import {
  allocateDelegatedWorkspace,
  isolateContendedWriter,
  type AllocationSweep,
} from './workspace-allocation.ts'
import {
  toGrant,
  inDb,
  registerWorkspace,
  validateWorkspace,
  type WorkspaceAuthority,
} from './workspace-authority.ts'
import {
  isScoped,
  retryDeferredGateReleases,
  settleWorkspaceGates,
  type AttachmentHandle,
  type ConversationState,
  type CurrentSource,
  type GrantLease,
  type LeaseKind,
  type WorkspaceSource,
} from './workspace-conversation.ts'
import {
  blocked,
  invalid,
  isResumable,
  requireReview,
  WorkspaceError,
  sameExecution,
  sameGrant,
  type PausedAuthorization,
  type PausedTask,
  type PausedTaskDecision,
  type WorkspaceAuthorization,
  type WorkspaceExecution,
  type WorkspaceExecutionFact,
  type WorkspaceExecutionReport,
  type WorkspaceGrant,
  type WorkspaceId,
  type ScopedOperation,
  type ScopedContinuation,
  type WorkspaceOperation,
  type WriteOperation,
  type WriterAdmission,
} from './workspace-domain.ts'
import { acquirePathGates, releaseGates, type PathGates } from './workspace-gates.ts'
import {
  canonicalGitWorkspace,
  changedFileCount,
  hasNoCommits,
  type GitWorkspace,
} from './workspace-git.ts'
import { lastUsedAt, repositoryHeads, workspaceStanding } from './workspace-inspect.ts'
import {
  assertDestinationUnchanged,
  assertNonAdministrativePath,
  classifyWriteDestination,
  isWithin,
} from './workspace-paths.ts'
import {
  getTask,
  putTask,
  getWorkspace,
  getReservation,
  putReservation,
  updateReservation,
  deleteReservation,
  putOperation,
  startedRelease,
  getBinding,
  putBinding,
  getUse,
  getUseRows,
  putUse,
  saveUse,
  getActiveUseRows,
  openOperations,
  assertWithinLiveInDb,
  type WorkspaceRecord,
  type BindingRecord,
  type ReservationRecord,
  type UseRecord,
} from './workspace-records.ts'
import { transaction } from './workspace-sqlite.ts'
import { newId, now } from './workspace-platform.ts'
import { errorText } from './error-text.ts'
import { checkoutUseStage, releaseOnceStopped, missingCheckoutText } from './workspace-labels.ts'

const claimGrant = (attachment: AttachmentHandle, grant: WorkspaceGrant): void => {
  const owners = attachment.state.leaseAttachments.get(grant.useId) ?? new Set<WorkspaceId>()
  owners.add(attachment.token)
  attachment.state.leaseAttachments.set(grant.useId, owners)
}

export const currentSource = (
  authority: WorkspaceAuthority,
  state: ConversationState
): CurrentSource => {
  const binding =
    state.pending !== undefined && state.pending.phase === 'confirmed'
      ? state.pending.targetBinding
      : state.binding
  const workspace = inDb(authority, state.repositoryId, db => getWorkspace(db, binding.workspaceId))
  if (workspace === undefined) requireReview(missingCheckoutText(binding.workspaceId))
  return {
    repo: state.repositoryId,
    binding,
    workspace,
    git: validateWorkspace(authority, workspace),
  }
}

const validateWithinGrant = (
  authority: WorkspaceAuthority,
  attachment: AttachmentHandle,
  grant: WorkspaceGrant,
  observed: GitWorkspace | undefined
): { readonly lease: GrantLease; readonly workspace: WorkspaceRecord; readonly use: UseRecord } => {
  const owners = attachment.state.leaseAttachments.get(grant.useId)
  if (owners === undefined || !owners.has(attachment.token))
    requireReview('No permission for this operation in this conversation')
  const lease = validateGrant(authority, attachment.state, grant, observed)
  const result = inDb(authority, grant.repositoryId, db => {
    const { workspace, use } = fencedUse(
      db,
      grant,
      'Permission for this operation is no longer active'
    )
    if (use.effect !== undefined || use.execution !== undefined)
      invalid('This operation needs checkout access')
    if (use.access !== grant.access || use.stage === 'quiescent')
      requireReview('Permission for this operation ended')
    if (use.stage !== 'authorized') blocked(`Dev cannot confirm permission for this operation`)
    return { workspace, use }
  })
  return { lease, ...result }
}

const foreignWriters =
  (state: ConversationState, workspaceId: WorkspaceId) =>
  (db: DatabaseSync): boolean =>
    getActiveUseRows(db, workspaceId).some(
      use => use.access === 'write' && !state.leases.has(use.id)
    )

interface Takeover {
  readonly from: ReservationRecord
  readonly foreignWriters: (db: DatabaseSync) => boolean
}

const refuseWithoutCommits = (path: string, holder: WorkspaceId | undefined): never =>
  blocked(
    `Checkout ${path} has no commits to create a worktree from. Another session is writing here or dev cannot confirm it stopped. The call did not run; retry once that session's work is confirmed stopped. ${releaseOnceStopped(holder)}`
  )

const assertNoCommitArrived = (authority: WorkspaceAuthority, workspace: WorkspaceRecord): void => {
  if (!hasNoCommits(validateWorkspace(authority, workspace)))
    blocked(`Checkout ${workspace.path} got its first commit during the write check. Retry.`)
}

const assertStillPaused = (
  db: DatabaseSync,
  state: ConversationState,
  workspace: WorkspaceRecord,
  holder: ReservationRecord
): void => {
  const recorded = getReservation(db, workspace.id)
  if (
    recorded === undefined ||
    recorded.id !== holder.id ||
    recorded.revision !== holder.revision ||
    getActiveUseRows(db, workspace.id).some(use => !state.leases.has(use.id)) ||
    openOperations(db, workspace.id).some(operation => operation.phase !== 'intent')
  )
    blocked(`The paused task of ${workspace.path} changed during the write check. Retry.`)
}

const reserveForTask = (
  db: DatabaseSync,
  source: WorkspaceSource,
  claim: {
    readonly taskId: WorkspaceId
    readonly reservationId: WorkspaceId
    readonly acquisitionId: WorkspaceId
  },
  takeover: Takeover | undefined,
  refusal: string
): void => {
  const recorded = getReservation(db, source.workspace.id)
  if (recorded !== undefined && recorded.taskId === claim.taskId) {
    if (recorded.id !== claim.reservationId) requireReview('The checkout kept for the task changed')
    updateReservation(db, {
      ...recorded,
      acquisitionId: claim.acquisitionId,
      revision: recorded.revision + 1,
    })
    return
  }
  if (recorded !== undefined) {
    if (takeover === undefined || recorded.id !== takeover.from.id || takeover.foreignWriters(db))
      blocked(refusal)
    putOperation(db, {
      ...startedRelease(
        source.repo,
        recorded,
        source.workspace,
        'admission',
        'release-reservation',
        undefined
      ),
      phase: 'confirmed',
      result: `Checkout now kept for task ${claim.taskId}; files unchanged.`,
    })
    deleteReservation(db, recorded)
  }
  putReservation(db, {
    id: claim.reservationId,
    taskId: claim.taskId,
    workspaceId: source.workspace.id,
    acquisitionId: claim.acquisitionId,
    revision: 0,
    createdAt: now(),
  })
}

export interface AdmittedOperation<Authorization = WorkspaceAuthorization> {
  readonly authorization: Authorization
  readonly observed?: GitWorkspace
}

type HeldCheckoutDecision<Reply> =
  | { readonly kind: 'isolate' }
  | { readonly kind: 'join' }
  | { readonly kind: 'reply'; readonly reply: Reply }
type OnHeldCheckout<Reply> = (
  source: CurrentSource,
  holder: ReservationRecord
) => HeldCheckoutDecision<Reply>

const isolateFromHolder: OnHeldCheckout<never> = () => ({ kind: 'isolate' })

const authorizeHeld = <Reply extends PausedAuthorization>(
  authority: WorkspaceAuthority,
  attachment: AttachmentHandle,
  operation: WorkspaceOperation,
  sweep: AllocationSweep,
  onHeld: OnHeldCheckout<Reply>
): AdmittedOperation<WorkspaceAuthorization | Reply> => {
  const admitted = admit(authority, attachment, operation, sweep, onHeld)
  const { authorization } = admitted
  if (authorization.kind !== 'ready') return { authorization }
  claimGrant(attachment, authorization.grant)
  return admitted.source?.workspace.id === authorization.grant.workspaceId
    ? { authorization, observed: admitted.source.git }
    : { authorization }
}

export const authorizeOperation = (
  authority: WorkspaceAuthority,
  attachment: AttachmentHandle,
  operation: WorkspaceOperation,
  sweep: AllocationSweep
): AdmittedOperation => authorizeHeld(authority, attachment, operation, sweep, isolateFromHolder)

const resumableHolderUses = (
  authority: WorkspaceAuthority,
  state: ConversationState,
  source: CurrentSource
): readonly UseRecord[] | undefined =>
  inDb(authority, source.repo, db => {
    const others = getUseRows(db, source.workspace.id).filter(use => !state.leases.has(use.id))
    const { outcome } = workspaceStanding(authority, db, source.workspace, true, others)
    return isResumable(true, outcome) ? others : undefined
  })

const changedFilesIn = (checkout: string): number | undefined => {
  try {
    return changedFileCount(checkout)
  } catch {
    return undefined
  }
}

const describePausedTask = (
  source: CurrentSource,
  holder: ReservationRecord,
  uses: readonly UseRecord[]
): PausedTask => {
  const head = repositoryHeads(source.git.commonPath).get(source.workspace.path)
  const changedFiles = changedFilesIn(source.workspace.path)
  const usedAt = lastUsedAt(holder, uses)
  return {
    taskId: holder.taskId,
    reservationId: holder.id,
    reservationRevision: holder.revision,
    workspaceId: source.workspace.id,
    path: source.workspace.path,
    ...(head === undefined ? {} : { head }),
    ...(changedFiles === undefined ? {} : { changedFiles }),
    ...(usedAt === undefined ? {} : { lastUsedAt: usedAt }),
  }
}

const joins = (decision: PausedTaskDecision, holder: ReservationRecord): boolean =>
  decision.kind === 'join' &&
  decision.taskId === holder.taskId &&
  decision.reservationId === holder.id &&
  decision.reservationRevision === holder.revision

export const authorizeWriter = (
  authority: WorkspaceAuthority,
  attachment: AttachmentHandle,
  operation: WriteOperation,
  decision: PausedTaskDecision,
  sweep: AllocationSweep
): AdmittedOperation<WriterAdmission> =>
  authorizeHeld(authority, attachment, operation, sweep, (source, holder) => {
    const uses = resumableHolderUses(authority, attachment.state, source)
    if (uses === undefined) return { kind: 'isolate' }
    if (joins(decision, holder)) return { kind: 'join' }
    return {
      kind: 'reply',
      reply: { kind: 'paused', task: describePausedTask(source, holder, uses) },
    }
  })

export const authorizeScopedWithin = (
  authority: WorkspaceAuthority,
  attachment: AttachmentHandle,
  within: WorkspaceGrant,
  continuation: ScopedContinuation,
  observed: GitWorkspace | undefined
): WorkspaceGrant => {
  assertAdmitting(authority, attachment)
  const { grant } = authorizeScoped(authority, attachment, { ...continuation, within }, observed)
  claimGrant(attachment, grant)
  return grant
}

const assertAdmitting = (authority: WorkspaceAuthority, attachment: AttachmentHandle): void => {
  attachment.assertOpen()
  const { state } = attachment
  if (state.review !== undefined) requireReview(state.review)
  if (state.closing) blocked('This conversation is closing its checkout access')
  if (state.parked) blocked('This conversation is switching checkouts')
  retryDeferredGateReleases(authority, state)
}

type OrdinaryOperation = Exclude<
  WorkspaceOperation,
  { readonly kind: 'native-file-write' | 'orb-return' | 'opaque' | 'leaf-read' }
>

const admit = <Reply>(
  authority: WorkspaceAuthority,
  attachment: AttachmentHandle,
  operation: WorkspaceOperation,
  sweep: AllocationSweep,
  onHeld: OnHeldCheckout<Reply>
): { readonly authorization: WorkspaceAuthorization | Reply; readonly source?: CurrentSource } => {
  assertAdmitting(authority, attachment)
  if (
    operation.kind === 'native-file-write' ||
    operation.kind === 'orb-return' ||
    operation.kind === 'opaque'
  )
    return { authorization: authorizeScoped(authority, attachment, operation, undefined) }
  if (operation.kind === 'leaf-read')
    return {
      authorization: authorizeLeafRead(
        authority,
        attachment,
        operation.coordinator,
        operation.execution
      ),
    }
  if (operation.kind === 'delegated-write' && operation.coordinator !== undefined)
    assertLocalCoordinator(attachment, operation.coordinator)
  const source = currentSource(authority, attachment.state)
  return {
    authorization: admitFrom(authority, attachment, operation, source, sweep, onHeld),
    source,
  }
}

const admitFrom = <Reply>(
  authority: WorkspaceAuthority,
  attachment: AttachmentHandle,
  operation: OrdinaryOperation,
  source: CurrentSource,
  sweep: AllocationSweep,
  onHeld: OnHeldCheckout<Reply>
): WorkspaceAuthorization | Reply => {
  const { state } = attachment
  const cwd =
    operation.cwd === undefined ? source.binding.cwd : realpathSync(resolve(operation.cwd))
  if (operation.kind === 'foreign-write') {
    assertForeignWriteScope(authority, attachment, cwd, operation.caller)
    const foreign = foreignSource(authority, cwd)
    if (foreign.repo === (operation.caller?.repositoryId ?? source.repo))
      invalid(
        `The destination is in the caller's repository; write the file in its current checkout instead: ${operation.caller?.checkout ?? source.workspace.path}`
      )
    return reserveForeignWriter(authority, state, foreign, cwd)
  }
  if (!isWithin(source.workspace.path, cwd))
    return authorizeForeign(authority, state, operation, source.binding.revision, cwd, sweep)
  if (operation.kind === 'read') {
    const ready = authorizeRead(
      authority,
      state,
      source,
      source.binding.taskId,
      source.binding.revision,
      cwd
    )
    if (operation.execution === undefined) return ready
    return attributeReader(authority, state, ready.grant, operation.execution)
  }
  if (operation.kind === 'delegated-write')
    return allocateDelegatedWorkspace(
      authority,
      state,
      source,
      source.binding.taskId ?? newId(),
      operation.execution,
      operation.startCommit,
      sweep
    )
  const existing = state.writeGrant
  if (
    existing !== undefined &&
    existing.workspaceId === source.workspace.id &&
    existing.taskId === source.binding.taskId
  ) {
    const lease = validateGrant(authority, state, existing, source.git)
    return operation.execution === undefined
      ? { kind: 'ready', grant: lease.grant }
      : executionUse(authority, state, lease, operation.execution)
  }
  const reservation = inDb(authority, source.repo, db => getReservation(db, source.workspace.id))
  const writers = foreignWriters(state, source.workspace.id)
  const unborn = hasNoCommits(source.git)
  let boundTaskId = source.binding.taskId
  let joined: ReservationRecord | undefined
  if (reservation !== undefined && reservation.taskId !== boundTaskId && !unborn) {
    const held = onHeld(source, reservation)
    if (held.kind === 'reply') return held.reply
    if (held.kind === 'join') {
      joined = reservation
      boundTaskId = reservation.taskId
    }
  }
  const takeover: Takeover | undefined =
    reservation !== undefined && reservation.taskId !== boundTaskId
      ? { from: reservation, foreignWriters: writers }
      : undefined
  const ownTaskContended = boundTaskId !== undefined && takeover === undefined
  const isolate = (taskId: WorkspaceId): WorkspaceAuthorization =>
    unborn
      ? refuseWithoutCommits(source.workspace.path, reservation?.taskId)
      : isolateContendedWriter(authority, state, source, taskId, sweep)
  if (takeover !== undefined && !unborn) return isolate(boundTaskId ?? newId())
  if (inDb(authority, source.repo, writers)) {
    if (ownTaskContended)
      blocked(`Dev cannot confirm the previous writer stopped: ${source.workspace.path}`)
    return isolate(newId())
  }
  let gates: PathGates
  try {
    gates = acquirePathGates(authority.paths, source.workspace.path, 'writer')
  } catch (cause) {
    if (!(cause instanceof WorkspaceError) || cause.outcome !== 'blocked' || ownTaskContended)
      throw cause
    return isolate(newId())
  }
  try {
    if (takeover !== undefined) assertNoCommitArrived(authority, source.workspace)
    const taskId = boundTaskId ?? newId()
    const useId = newId()
    const reservationId = takeover === undefined ? (reservation?.id ?? newId()) : newId()
    const acquisitionId = newId()
    const rebound = source.binding.taskId !== taskId
    const updatedBinding = {
      ...source.binding,
      ...(rebound ? { taskId } : {}),
      revision: source.binding.revision + (rebound ? 1 : 0),
    } satisfies BindingRecord
    const use = {
      id: useId,
      workspaceId: source.workspace.id,
      taskId,
      reservationId,
      acquisitionId,
      access: 'write',
      stage: 'authorized',
      processes: [],
      incarnation: state.incarnation,
      bindingRevision: updatedBinding.revision,
      revision: 0,
      createdAt: now(),
      updatedAt: now(),
    } satisfies UseRecord
    inDb(authority, source.repo, db =>
      transaction(db, () => {
        const currentBinding = getBinding(db, state.key)
        if (
          currentBinding === undefined ||
          currentBinding.revision !== source.binding.revision ||
          currentBinding.workspaceId !== source.workspace.id
        )
          requireReview('The checkout changed before the write')
        if (joined !== undefined) assertStillPaused(db, state, source.workspace, joined)
        reserveForTask(
          db,
          source,
          { taskId, reservationId, acquisitionId },
          takeover,
          `Another task is keeping this checkout: ${source.workspace.path}`
        )
        if (getTask(db, taskId) === undefined)
          putTask(db, { id: taskId, repositoryId: source.repo, revision: 0, createdAt: now() })
        if (rebound) putBinding(db, updatedBinding)
        putUse(db, use)
      })
    )
    const grant = toGrant(authority, source.repo, source.workspace, use, cwd, 'write')
    const lease: GrantLease = {
      grant,
      repositoryId: source.repo,
      useId,
      gates,
      kind: 'ordinary',
      released: false,
    }
    state.leases.set(useId, lease)
    state.writeGrant = grant
    state.binding = updatedBinding
    if (operation.execution !== undefined)
      return executionUse(
        authority,
        state,
        validateGrant(authority, state, grant),
        operation.execution
      )
    return { kind: 'ready', grant }
  } catch (cause) {
    releaseGates(gates)
    throw cause
  }
}

const AGENT_NOT_AUTHORIZED = 'This conversation did not authorize that delegated agent'

const assertLocalCoordinator = (
  attachment: AttachmentHandle,
  coordinator: WorkspaceGrant
): void => {
  const owners = attachment.state.leaseAttachments.get(coordinator.useId)
  if (owners === undefined || !owners.has(attachment.token)) requireReview(AGENT_NOT_AUTHORIZED)
  if (coordinator.repositoryId !== attachment.state.repositoryId)
    invalid(
      'An agent sent to another checkout must write there itself; it can delegate only read-only work'
    )
}

const assertForeignWriteScope = (
  authority: WorkspaceAuthority,
  attachment: AttachmentHandle,
  cwd: string,
  caller: WorkspaceGrant | undefined
): void => {
  assertNonAdministrativePath(cwd)
  if (caller !== undefined) {
    const owners = attachment.state.leaseAttachments.get(caller.useId)
    if (owners === undefined || !owners.has(attachment.token))
      requireReview('Permission changed; retry from the current checkout')
    const lease = validateGrant(authority, attachment.state, caller)
    if (caller.access !== 'write' || isScoped(lease))
      blocked('No permission to write; ask a conversation or delegated agent with write access')
    const stage = inDb(
      authority,
      caller.repositoryId,
      db => fencedUse(db, caller, 'Dev lost track of checkout access').use.stage
    )
    if (stage !== (lease.kind === 'execution' ? 'started' : 'authorized'))
      blocked('Checkout access ended; retry from the current checkout')
  }
  if (isWithin(authority.root, cwd) && !isWithin(authority.paths.worktrees, cwd))
    invalid(`Dev private storage: ${cwd}. Select a project checkout`)
  if (
    isWithin(authority.root, cwd) &&
    (caller === undefined ||
      caller.origin !== 'managed' ||
      !isWithin(authority.paths.worktrees, caller.checkout) ||
      !isWithin(caller.checkout, cwd))
  )
    invalid(`No permission to write in ${cwd}. Ask the conversation using that checkout`)
}

const foreignSource = (authority: WorkspaceAuthority, cwd: string): WorkspaceSource => {
  let git: GitWorkspace
  try {
    git = canonicalGitWorkspace(cwd)
  } catch (cause) {
    return invalid(
      `cwd is outside this checkout and not inside another Git checkout: ${cwd} (${errorText(cause)})`
    )
  }
  const repo = authority.registerRepository(git)
  return { repo, workspace: registerWorkspace(authority, repo, git), git }
}

const reserveForeignWriter = (
  authority: WorkspaceAuthority,
  state: ConversationState,
  source: WorkspaceSource,
  cwd: string
): WorkspaceAuthorization => {
  const { repo, workspace } = source
  for (const lease of state.leases.values()) {
    if (
      !lease.released &&
      lease.kind === 'ordinary' &&
      lease.grant.access === 'write' &&
      lease.grant.workspaceId === workspace.id
    )
      return { kind: 'ready', grant: validateGrant(authority, state, lease.grant).grant }
  }
  const remedy = `delegate the change with work delegate and a cwd in that checkout, or wait for that task`
  const taskId = state.foreignTasks.get(workspace.id) ?? newId()
  const reservation = inDb(authority, repo, db => getReservation(db, workspace.id))
  const writers = foreignWriters(state, workspace.id)
  const takeover: Takeover | undefined =
    reservation !== undefined && reservation.taskId !== taskId
      ? { from: reservation, foreignWriters: writers }
      : undefined
  const unborn = hasNoCommits(source.git)
  const keptByAnotherTask = `Another task is keeping ${workspace.path}; ${remedy}`
  if (takeover !== undefined && !unborn) blocked(keptByAnotherTask)
  if (inDb(authority, repo, writers)) {
    if (unborn) refuseWithoutCommits(workspace.path, reservation?.taskId)
    blocked(`Checkout ${workspace.path} has a live writer from another conversation; ${remedy}`)
  }
  const gates = acquirePathGates(authority.paths, workspace.path, 'writer')
  try {
    if (takeover !== undefined) assertNoCommitArrived(authority, workspace)
    const reservationId = takeover === undefined ? (reservation?.id ?? newId()) : newId()
    const acquisitionId = newId()
    const use = {
      id: newId(),
      workspaceId: workspace.id,
      taskId,
      reservationId,
      acquisitionId,
      access: 'write',
      stage: 'authorized',
      processes: [],
      incarnation: state.incarnation,
      bindingRevision: state.binding.revision,
      revision: 0,
      createdAt: now(),
      updatedAt: now(),
    } satisfies UseRecord
    inDb(authority, repo, db =>
      transaction(db, () => {
        reserveForTask(
          db,
          source,
          { taskId, reservationId, acquisitionId },
          takeover,
          keptByAnotherTask
        )
        if (getTask(db, taskId) === undefined)
          putTask(db, { id: taskId, repositoryId: repo, revision: 0, createdAt: now() })
        putUse(db, use)
      })
    )
    const grant = toGrant(authority, repo, workspace, use, cwd, 'write')
    state.leases.set(use.id, {
      grant,
      repositoryId: repo,
      useId: use.id,
      gates,
      kind: 'ordinary',
      released: false,
    })
    state.foreignTasks.set(workspace.id, taskId)
    return { kind: 'ready', grant }
  } catch (cause) {
    releaseGates(gates)
    throw cause
  }
}

const authorizeForeign = (
  authority: WorkspaceAuthority,
  state: ConversationState,
  operation: Extract<WorkspaceOperation, { readonly kind: 'read' | 'write' | 'delegated-write' }>,
  bindingRevision: number,
  cwd: string,
  sweep: AllocationSweep
): WorkspaceAuthorization => {
  if (
    operation.kind === 'write' ||
    (operation.kind === 'read' && operation.execution === undefined)
  )
    invalid(
      `The working directory is outside this conversation's checkout: ${cwd}. Nothing ran. If this call named the directory, name one inside the checkout; a shell command can change directory itself. Otherwise ask the user to quit and reopen this conversation.`
    )
  if (isWithin(authority.root, cwd))
    invalid(`Cannot delegate into dev private storage: ${cwd}. Choose a checkout outside it`)
  const source = foreignSource(authority, cwd)
  const taskId = state.foreignTasks.get(source.workspace.id)
  if (operation.kind === 'read') {
    const ready = authorizeRead(authority, state, source, taskId, bindingRevision, cwd)
    return attributeReader(authority, state, ready.grant, operation.execution)
  }
  const allocated = allocateDelegatedWorkspace(
    authority,
    state,
    source,
    taskId ?? newId(),
    operation.execution,
    operation.kind === 'delegated-write' ? operation.startCommit : undefined,
    sweep
  )
  if (allocated.kind === 'ready' && allocated.grant.taskId !== undefined)
    state.foreignTasks.set(source.workspace.id, allocated.grant.taskId)
  return allocated
}

const attributeReader = (
  authority: WorkspaceAuthority,
  state: ConversationState,
  grant: WorkspaceGrant,
  execution: WorkspaceExecution | undefined
): WorkspaceAuthorization => {
  if (execution === undefined) invalid('No run ID for the delegated reader')
  const base = state.leases.get(grant.useId)
  if (base === undefined) requireReview('Read permission ended before the run')
  return executionUse(authority, state, validateGrant(authority, state, base.grant), execution)
}

const authorizeScoped = (
  authority: WorkspaceAuthority,
  attachment: AttachmentHandle,
  operation: ScopedOperation,
  observed: GitWorkspace | undefined
): Extract<WorkspaceAuthorization, { readonly kind: 'ready' }> => {
  const { state } = attachment
  const { within } = operation
  const {
    lease: withinLease,
    workspace,
    use: withinUse,
  } = validateWithinGrant(authority, attachment, within, observed)
  if (within.access !== 'write') blocked('Read-only access does not allow writes')
  const cwd = realpathSync(resolve(operation.cwd ?? within.cwd))
  if (!isWithin(workspace.path, cwd)) invalid(`Working directory is outside the checkout: ${cwd}`)
  const kind: LeaseKind =
    operation.kind === 'opaque'
      ? { kind: operation.kind, withinUseId: withinUse.id, execution: operation.execution }
      : { kind: operation.kind, withinUseId: withinUse.id }
  const destination =
    operation.kind === 'native-file-write'
      ? classifyWriteDestination(
          { checkout: workspace.path, authorityRoot: authority.root },
          cwd,
          operation.path
        )
      : undefined
  if (destination !== undefined && destination.kind !== 'workspace')
    invalid('Write permission covers only this checkout')
  const operationPath = destination?.path
  const use = {
    id: newId(),
    workspaceId: workspace.id,
    taskId: withinUse.taskId,
    ...(withinUse.reservationId === undefined ? {} : { reservationId: withinUse.reservationId }),
    ...(withinUse.acquisitionId === undefined ? {} : { acquisitionId: withinUse.acquisitionId }),
    access: 'write',
    stage: 'authorized',
    effect: operation.kind,
    withinUseId: withinUse.id,
    ...(operationPath === undefined ? {} : { operationPath }),
    ...(operation.kind === 'opaque' ? { execution: operation.execution } : {}),
    processes: [],
    incarnation: state.incarnation,
    bindingRevision: withinUse.bindingRevision,
    revision: 0,
    createdAt: now(),
    updatedAt: now(),
  } satisfies UseRecord
  inDb(authority, withinLease.repositoryId, db =>
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
        requireReview('Checkout permission changed before the operation')
      putUse(db, use)
    })
  )
  const grant = toGrant(authority, withinLease.repositoryId, workspace, use, cwd, 'write')
  state.leases.set(use.id, {
    ...kind,
    grant,
    repositoryId: withinLease.repositoryId,
    useId: use.id,
    released: false,
  })
  return { kind: 'ready', grant }
}

const authorizeRead = (
  authority: WorkspaceAuthority,
  state: ConversationState,
  source: WorkspaceSource,
  taskId: WorkspaceId | undefined,
  bindingRevision: number,
  cwd: string
): WorkspaceAuthorization & { readonly kind: 'ready' } => {
  const { repo, workspace } = source
  const ready = (grant: WorkspaceGrant): WorkspaceAuthorization & { readonly kind: 'ready' } => {
    const warning = writerWarning(authority, state, repo, workspace.id)
    return { kind: 'ready', grant, ...(warning === undefined ? {} : { warning }) }
  }
  for (const lease of state.leases.values()) {
    if (
      !lease.released &&
      lease.kind === 'ordinary' &&
      lease.grant.access === 'read' &&
      lease.grant.workspaceId === workspace.id &&
      lease.grant.revision === bindingRevision
    )
      return ready(lease.grant)
  }
  const gates = acquirePathGates(authority.paths, workspace.path, 'reader')
  try {
    const reservation = inDb(authority, repo, db => getReservation(db, workspace.id))
    const use = {
      id: newId(),
      workspaceId: workspace.id,
      taskId,
      ...(reservation === undefined ? {} : { reservationId: reservation.id }),
      access: 'read',
      stage: 'authorized',
      processes: [],
      incarnation: state.incarnation,
      bindingRevision,
      revision: 0,
      createdAt: now(),
      updatedAt: now(),
    } satisfies UseRecord
    inDb(authority, repo, db => transaction(db, () => putUse(db, use)))
    const grant = toGrant(authority, repo, workspace, use, cwd, 'read')
    const lease: GrantLease = {
      grant,
      repositoryId: repo,
      useId: use.id,
      gates,
      kind: 'ordinary',
      released: false,
    }
    state.leases.set(use.id, lease)
    return ready(grant)
  } catch (cause) {
    releaseGates(gates)
    throw cause
  }
}

const writerWarning = (
  authority: WorkspaceAuthority,
  state: ConversationState,
  repo: WorkspaceId,
  workspaceIdValue: WorkspaceId
): string | undefined => {
  if (
    inDb(authority, repo, db =>
      getActiveUseRows(db, workspaceIdValue).some(
        use => use.access === 'write' && !state.leases.has(use.id)
      )
    )
  )
    return 'Another session can write here. Files may change while you read.'
  return undefined
}

const executionUse = (
  authority: WorkspaceAuthority,
  state: ConversationState,
  parent: GrantLease,
  execution: WorkspaceExecution
): WorkspaceAuthorization => {
  const base = inDb(authority, parent.repositoryId, db => getUse(db, parent.useId))
  if (base === undefined) requireReview('Dev could not confirm checkout access')
  const use = {
    ...base,
    id: newId(),
    execution,
    stage: 'authorized',
    processes: [],
    revision: 0,
    createdAt: now(),
    updatedAt: now(),
    reason: undefined,
  } satisfies UseRecord
  inDb(authority, parent.repositoryId, db => transaction(db, () => putUse(db, use)))
  const grant = { ...parent.grant, useId: use.id } satisfies WorkspaceGrant
  const lease: GrantLease = {
    grant,
    repositoryId: parent.repositoryId,
    useId: use.id,
    kind: 'execution',
    execution,
    released: false,
  }
  state.leases.set(use.id, lease)
  return { kind: 'ready', grant }
}

const authorizeLeafRead = (
  authority: WorkspaceAuthority,
  attachment: AttachmentHandle,
  coordinator: WorkspaceGrant,
  execution: WorkspaceExecution
): WorkspaceAuthorization => {
  const { state } = attachment
  const owners = state.leaseAttachments.get(coordinator.useId)
  if (owners === undefined || !owners.has(attachment.token)) requireReview(AGENT_NOT_AUTHORIZED)
  const lease = validateGrant(authority, state, coordinator)
  if (lease.kind !== 'execution')
    invalid('A delegated reader uses the checkout of the agent that started it')
  const use = inDb(authority, coordinator.repositoryId, db =>
    transaction(db, () => {
      const running = fencedUse(db, coordinator, 'Delegating agent no longer has checkout access')
      if (running.use.stage !== 'started')
        blocked(`The delegating agent is not running in this checkout`)
      const reservation = getReservation(db, running.workspace.id)
      const leaf = {
        id: newId(),
        workspaceId: running.workspace.id,
        taskId: running.use.taskId,
        ...(reservation === undefined ? {} : { reservationId: reservation.id }),
        access: 'read',
        stage: 'authorized',
        execution,
        processes: [],
        incarnation: state.incarnation,
        bindingRevision: running.use.bindingRevision,
        revision: 0,
        createdAt: now(),
        updatedAt: now(),
      } satisfies UseRecord
      putUse(db, leaf)
      return { leaf, workspace: running.workspace }
    })
  )
  const grant = toGrant(
    authority,
    coordinator.repositoryId,
    use.workspace,
    use.leaf,
    coordinator.cwd,
    'read'
  )
  state.leases.set(use.leaf.id, {
    kind: 'execution',
    execution,
    grant,
    repositoryId: coordinator.repositoryId,
    useId: use.leaf.id,
    released: false,
  })
  return { kind: 'ready', grant }
}

const fencedUse = (
  db: DatabaseSync,
  grant: WorkspaceGrant,
  missing: string
): { readonly workspace: WorkspaceRecord; readonly use: UseRecord } => {
  const workspace = getWorkspace(db, grant.workspaceId)
  const use = getUse(db, grant.useId)
  if (workspace === undefined || use === undefined) requireReview(missing)
  return { workspace, use }
}
const matchesGrant = (use: UseRecord, grant: WorkspaceGrant): boolean =>
  use.workspaceId === grant.workspaceId &&
  use.bindingRevision === grant.revision &&
  use.acquisitionId === grant.acquisitionId &&
  use.reservationId === grant.reservationId &&
  use.taskId === grant.taskId &&
  use.access === grant.access &&
  use.operationPath === grant.path
const holdsCurrentAcquisition = (db: DatabaseSync, grant: WorkspaceGrant): boolean => {
  if (grant.access !== 'write') return true
  const reservation = getReservation(db, grant.workspaceId)
  return (
    reservation !== undefined &&
    reservation.id === grant.reservationId &&
    reservation.taskId === grant.taskId &&
    reservation.acquisitionId === grant.acquisitionId
  )
}

const grantRecords = (
  authority: WorkspaceAuthority,
  state: ConversationState,
  grant: WorkspaceGrant
): { readonly lease: GrantLease; readonly workspace: WorkspaceRecord } => {
  if (grant.namespaceId !== authority.initialize())
    requireReview('Permission came from different dev storage')
  const lease = state.leases.get(grant.useId)
  if (lease === undefined || lease.released || !sameGrant(lease.grant, grant))
    requireReview('No current permission in this conversation')
  const scoped = isScoped(lease) ? lease : undefined
  const workspace = inDb(authority, grant.repositoryId, db => {
    const fenced = fencedUse(db, grant, 'Dev lost the record of this checkout permission')
    if (
      !matchesGrant(fenced.use, grant) ||
      fenced.use.effect !== scoped?.kind ||
      fenced.use.withinUseId !== scoped?.withinUseId
    )
      requireReview('Permission no longer matches checkout use')
    if (!holdsCurrentAcquisition(db, grant))
      requireReview('This run no longer has permission to write')
    return fenced.workspace
  })
  return { lease, workspace }
}

export const validateGrant = (
  authority: WorkspaceAuthority,
  state: ConversationState,
  grant: WorkspaceGrant,
  observed?: GitWorkspace
): GrantLease => {
  const { lease, workspace } = grantRecords(authority, state, grant)
  validateWorkspace(authority, workspace, observed)
  return lease
}

const confirmsCheckout = (fact: WorkspaceExecutionFact): boolean => {
  switch (fact.kind) {
    case 'started':
    case 'operation-started':
    case 'quiescent':
    case 'launch-failed':
    case 'operation-completed':
      return true
    case 'launch-intent':
    case 'spawned':
    case 'observed':
    case 'unknown':
      return false
  }
}

export const validateDurableGrant = (
  authority: WorkspaceAuthority,
  grant: WorkspaceGrant
): void => {
  const namespace = authority.inspectExisting()
  if (namespace === undefined || namespace !== grant.namespaceId)
    requireReview('Permission does not match dev storage')
  const repositories = authority.listRepositories()
  if (!repositories.some(repository => repository.id === grant.repositoryId))
    requireReview('Dev has no record of this repository')
  const workspace = inDb(authority, grant.repositoryId, db => {
    const fenced = fencedUse(db, grant, 'No saved record of this checkout permission')
    if (!matchesGrant(fenced.use, grant)) requireReview('Permission does not match checkout use')
    const { stage } = fenced.use
    if (stage === 'quiescent' || stage === 'observed' || stage === 'unknown')
      requireReview(`The delegated agent no longer has checkout access`)
    if (!holdsCurrentAcquisition(db, grant))
      requireReview('The run no longer has permission to write')
    return fenced.workspace
  })
  if (grant.checkout !== workspace.path || grant.origin !== workspace.origin)
    requireReview('The checkout permission was altered')
  if (!isWithin(workspace.path, grant.cwd))
    requireReview('Working directory is outside the permitted checkout')
  let actualCwd: string
  try {
    actualCwd = realpathSync(grant.cwd)
  } catch {
    return requireReview(`Permitted working directory unavailable: ${grant.cwd}`)
  }
  if (actualCwd !== grant.cwd || !isWithin(workspace.path, actualCwd))
    requireReview('Working directory does not match the permitted path')
  validateWorkspace(authority, workspace)
}

const withWarnings = (
  report: WorkspaceExecutionReport,
  warnings: readonly string[]
): WorkspaceExecutionReport => {
  const all = [...warnings, ...(report.warning === undefined ? [] : [report.warning])]
  return all.length === 0 ? report : { ...report, warning: all.join('\n') }
}

export const reportExecutionFact = (
  authority: WorkspaceAuthority,
  attachment: AttachmentHandle,
  grant: WorkspaceGrant,
  fact: WorkspaceExecutionFact
): WorkspaceExecutionReport => {
  attachment.assertOpen()
  if (attachment.state.closing) blocked('Dev cannot record execution while closing checkout access')
  const retried = retryDeferredGateReleases(authority, attachment.state)
  return withWarnings(recordExecutionFact(authority, attachment, grant, fact), retried)
}

const settled = (warning: string | undefined): WorkspaceExecutionReport =>
  warning === undefined ? {} : { warning }

const recordExecutionFact = (
  authority: WorkspaceAuthority,
  attachment: AttachmentHandle,
  grant: WorkspaceGrant,
  fact: WorkspaceExecutionFact
): WorkspaceExecutionReport => {
  const { state } = attachment

  if (
    state.parked &&
    ['launch-intent', 'spawned', 'started', 'operation-started'].includes(fact.kind)
  )
    blocked('No operation can start while switching checkouts')
  const { lease, workspace } = grantRecords(authority, state, grant)
  if (confirmsCheckout(fact)) validateWorkspace(authority, workspace)
  if (isScoped(lease)) {
    const owners = state.leaseAttachments.get(lease.useId)
    if (owners === undefined || !owners.has(attachment.token))
      requireReview('This conversation did not start that operation')
  }
  if (lease.kind === 'ordinary') invalid('No permission for this operation')
  if (lease.kind === 'native-file-write' || lease.kind === 'orb-return') {
    reportScopedOperation(authority, lease, fact)
    return {}
  }
  if (fact.kind === 'operation-started' || fact.kind === 'operation-completed')
    invalid('This start or stop report cannot describe a process')
  const current = inDb(authority, lease.repositoryId, db => getUse(db, lease.useId))
  if (
    current === undefined ||
    current.execution === undefined ||
    !sameExecution(current.execution, lease.execution)
  )
    requireReview('Execution no longer matches the permission dev issued')
  if (current.stage === 'quiescent') requireReview('Execution already ended')
  const update = (value: UseRecord): void =>
    inDb(authority, lease.repositoryId, db => transaction(db, () => saveUse(db, value)))
  const updatedAt = now()
  switch (fact.kind) {
    case 'launch-intent': {
      if (!sameExecution(fact.execution, lease.execution))
        invalid('Launch does not match the permitted operation')
      if (current.stage !== 'authorized')
        requireReview(`Cannot record a planned launch after ${checkoutUseStage(current.stage)}`)
      update({ ...current, stage: 'launch-intent', revision: current.revision + 1, updatedAt })
      return {}
    }
    case 'spawned': {
      if (current.stage !== 'launch-intent')
        requireReview(`Cannot record process identity after ${checkoutUseStage(current.stage)}`)
      update({
        ...current,
        stage: 'spawned',
        processes: [fact.process],
        revision: current.revision + 1,
        updatedAt,
      })
      return {}
    }
    case 'started': {
      if (current.stage !== 'spawned')
        requireReview(`Dev must verify the process before letting code run`)
      update({ ...current, stage: 'started', revision: current.revision + 1, updatedAt })
      return {}
    }
    case 'observed': {
      if (!['spawned', 'started', 'observed'].includes(current.stage))
        requireReview(
          `Cannot record a process observation after ${checkoutUseStage(current.stage)}`
        )
      update({
        ...current,
        stage: 'observed',
        processes: fact.processes,
        revision: current.revision + 1,
        updatedAt,
      })
      return {}
    }
    case 'unknown': {
      update({
        ...current,
        stage: 'unknown',
        reason: fact.reason,
        revision: current.revision + 1,
        updatedAt,
      })
      return {}
    }
    case 'launch-failed': {
      if (current.stage !== 'authorized' && current.stage !== 'launch-intent')
        requireReview(`A launch cannot be reported failed after ${checkoutUseStage(current.stage)}`)
      update({
        ...current,
        stage: 'quiescent',
        reason: `launch-failed: ${fact.reason}`,
        revision: current.revision + 1,
        updatedAt,
      })
      lease.released = true
      return settled(settleWorkspaceGates(authority, state, grant))
    }
    case 'quiescent': {
      if (current.stage !== 'observed' || current.processes.length > 0)
        requireReview(`Dev must confirm the process and its descendants stopped`)
      update({
        ...current,
        stage: 'quiescent',
        reason: fact.reason,
        revision: current.revision + 1,
        updatedAt,
      })
      lease.released = true
      return settled(settleWorkspaceGates(authority, state, grant))
    }
    default: {
      const exhaustive: never = fact
      return exhaustive
    }
  }
}

const reportScopedOperation = (
  authority: WorkspaceAuthority,
  lease: Extract<GrantLease, { readonly kind: 'native-file-write' | 'orb-return' }>,
  fact: WorkspaceExecutionFact
): void => {
  if (
    fact.kind !== 'operation-started' &&
    fact.kind !== 'operation-completed' &&
    fact.kind !== 'unknown'
  )
    invalid('Dev needs a start or stop report for this file operation')
  const current = inDb(authority, lease.repositoryId, db => getUse(db, lease.useId))
  if (current === undefined || current.effect !== lease.kind)
    requireReview('Dev lost the record of this operation')
  const next = inDb(authority, lease.repositoryId, db =>
    transaction(db, () => {
      const latest = getUse(db, lease.useId)
      if (
        latest === undefined ||
        latest.revision !== current.revision ||
        latest.effect !== lease.kind ||
        latest.withinUseId !== lease.withinUseId
      )
        requireReview('Operation report is stale')
      if (fact.kind === 'operation-started') {
        if (latest.stage !== 'authorized')
          requireReview(`Cannot start operation after ${checkoutUseStage(latest.stage)}`)
        assertWithinLiveInDb(db, latest)
        if (latest.operationPath !== undefined) {
          const workspace = getWorkspace(db, latest.workspaceId)
          if (workspace === undefined)
            requireReview(`The checkout for the operation disappeared: ${latest.workspaceId}`)
          assertDestinationUnchanged(
            { checkout: workspace.path, authorityRoot: authority.root },
            { kind: 'workspace', operand: latest.operationPath, path: latest.operationPath }
          )
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
          requireReview(`Cannot record completion after ${checkoutUseStage(latest.stage)}`)
        const completed: UseRecord = {
          ...latest,
          stage: 'quiescent',
          reason:
            latest.stage === 'authorized'
              ? `operation-ended-before-start:${lease.kind}`
              : `operation-completed:${lease.kind}`,
          revision: latest.revision + 1,
          updatedAt: now(),
        }
        saveUse(db, completed)
        return completed
      }
      if (latest.stage !== 'authorized' && latest.stage !== 'operation-started')
        requireReview(`Cannot mark execution unconfirmed after ${checkoutUseStage(latest.stage)}`)
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
