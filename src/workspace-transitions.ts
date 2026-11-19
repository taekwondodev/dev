import { currentSource, validateGrant } from './workspace-admission.ts'
import {
  toGrant,
  inDb,
  taskWorkspaces,
  validateWorkspace,
  type WorkspaceAuthority,
} from './workspace-authority.ts'
import {
  outgoingUses,
  assertNoLiveExecution,
  settleDependentsFirst,
  type GrantLease,
  type PendingTransition,
  type ConversationState,
  type AttachmentHandle,
} from './workspace-conversation.ts'
import {
  ambiguous,
  blocked,
  invalid,
  requireReview,
  sameBinding,
  sameGrant,
  type WorkspaceGrant,
  type WorkspaceHandoff,
  type WorkspaceId,
  type WorkspaceSelection,
} from './workspace-domain.ts'
import { acquirePathGates, releaseGates } from './workspace-gates.ts'
import {
  assertNoUnresolvedRelease,
  getReservation,
  updateReservation,
  getBinding,
  putBinding,
  getUse,
  putUse,
  saveUse,
  getOperation,
  putOperation,
  saveOperation,
  getActiveUseRows,
  toBinding,
  type WorkspaceRecord,
  type ReservationRecord,
  type BindingRecord,
  type UseRecord,
  type TransitionOperationRecord,
} from './workspace-records.ts'
import { errorText } from './error-text.ts'
import { transaction } from './workspace-sqlite.ts'
import { newId, now } from './workspace-platform.ts'

export const resolveSelection = (
  authority: WorkspaceAuthority,
  selection: WorkspaceSelection
): {
  repo: WorkspaceId
  reservation: ReservationRecord
  workspace: WorkspaceRecord
} => {
  const matches = taskWorkspaces(authority, selection.taskId)
  const selected =
    selection.workspaceId === undefined
      ? matches
      : matches.filter(item => item.workspace.id === selection.workspaceId)
  if (selected.length === 0) invalid(`No saved checkout matches task ${selection.taskId}`)
  if (selected.length > 1)
    ambiguous(`Task ${selection.taskId} has multiple checkouts; provide an exact checkout ID`)
  const [result] = selected
  if (result === undefined) return invalid('Selected checkout is unavailable')
  return result
}

const CURRENT_CHECKOUT_CHANGED_BEFORE_SWITCHING = 'The current checkout changed before switching'

export const selectWorkspace = (
  authority: WorkspaceAuthority,
  attachment: AttachmentHandle,
  selection: WorkspaceSelection
): WorkspaceHandoff => {
  attachment.assertOpen()
  const { state } = attachment
  if (state.parked || state.pending !== undefined) blocked('A checkout switch is already pending')
  assertNoLiveExecution(authority, state, state.binding, 'switched')
  const target = resolveSelection(authority, selection)
  validateWorkspace(authority, target.workspace)
  const source = currentSource(authority, state)
  if (
    source.repo === target.repo &&
    source.workspace.id === target.workspace.id &&
    source.binding.taskId === target.reservation.taskId
  ) {
    const current = state.writeGrant
    if (current !== undefined)
      return {
        operationId: newId(),
        from: toBinding(state.binding),
        target: current,
        reason: 'This conversation already uses the selected checkout.',
      }
  }
  const targetUses = inDb(authority, target.repo, db => getActiveUseRows(db, target.workspace.id))
  if (targetUses.some(use => use.access === 'write' && !state.leases.has(use.id)))
    blocked(`Another writer may still be active: ${target.workspace.path}`)
  inDb(authority, target.repo, db => assertNoUnresolvedRelease(db, target.workspace.id))
  const gates = acquirePathGates(authority.paths, target.workspace.path, 'writer')
  const operationId = newId()
  const acquisitionId = newId()
  const use = {
    id: newId(),
    workspaceId: target.workspace.id,
    taskId: target.reservation.taskId,
    reservationId: target.reservation.id,
    acquisitionId,
    access: 'write',
    stage: 'authorized',
    processes: [],
    incarnation: state.incarnation,
    bindingRevision: state.binding.revision + 1,
    revision: 0,
    createdAt: now(),
    updatedAt: now(),
  } satisfies UseRecord
  const targetBinding = {
    key: state.key,
    conversation: state.conversation,
    taskId: target.reservation.taskId,
    workspaceId: target.workspace.id,
    cwd: target.workspace.path,
    revision: state.binding.revision + 1,
  } satisfies BindingRecord
  const operation = {
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
  } satisfies TransitionOperationRecord
  const grant = toGrant(
    authority,
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
    reason: 'Using the selected checkout and its files. Nothing is copied',
  }
  const targetLease: GrantLease = {
    grant,
    repositoryId: target.repo,
    useId: use.id,
    gates,
    kind: 'ordinary',
    released: false,
  }
  try {
    inDb(authority, target.repo, db =>
      transaction(db, () => {
        const reservation = getReservation(db, target.workspace.id)
        if (
          reservation === undefined ||
          reservation.id !== target.reservation.id ||
          reservation.taskId !== target.reservation.taskId
        )
          requireReview('The selected checkout or task changed before switching')
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
            requireReview(CURRENT_CHECKOUT_CHANGED_BEFORE_SWITCHING)
          putBinding(db, { ...current, pendingOperationId: operationId })
        }
      })
    )
    if (source.repo !== target.repo)
      inDb(authority, source.repo, db =>
        transaction(db, () => {
          const current = getBinding(db, state.key)
          if (current === undefined || current.revision !== state.binding.revision)
            requireReview(CURRENT_CHECKOUT_CHANGED_BEFORE_SWITCHING)
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
}

export const performHandoff = async (
  authority: WorkspaceAuthority,
  attachment: AttachmentHandle,
  transition: WorkspaceHandoff,
  replace: (target: WorkspaceGrant) => Promise<'confirmed' | 'cancelled'>
): Promise<void> => {
  attachment.assertOpen()
  const { state } = attachment
  const { pending } = state
  if (
    pending === undefined ||
    pending.handoff.operationId !== transition.operationId ||
    !sameGrant(pending.handoff.target, transition.target) ||
    !sameBinding(pending.handoff.from, transition.from)
  )
    requireReview('This checkout switch is no longer current')
  if (pending.phase !== 'intent')
    requireReview(`Dev cannot cancel switch ${transition.operationId}; it may already have started`)
  let operation: TransitionOperationRecord
  try {
    validateGrant(authority, state, pending.handoff.target)
    assertNoLiveExecution(authority, state, pending.handoff.from, 'switched')
    operation = inDb(authority, pending.targetRepositoryId, db =>
      transaction(db, () => {
        const current = getOperation(db, transition.operationId)
        if (current === undefined || current.kind !== 'handoff' || current.phase !== 'intent')
          requireReview(`Dev has no saved switch plan: ${transition.operationId}`)
        const started = { ...current, phase: 'started' as const }
        saveOperation(db, started)
        return started
      })
    )
  } catch (cause) {
    cancelTransition(
      authority,
      state,
      pending,
      `Checkout switch did not start: ${errorText(cause)}`
    )
    return blocked(`Dev did not switch checkouts: ${errorText(cause)}`)
  }
  pending.phase = 'started'
  let outcome: 'confirmed' | 'cancelled'
  try {
    outcome = await replace(pending.handoff.target)
  } catch (cause) {
    markTransitionUnknown(
      authority,
      state,
      pending,
      `Checkout switch may not have finished: ${errorText(cause)}`
    )
    return requireReview(`Dev cannot confirm the checkout switched: ${transition.operationId}`)
  }
  if (outcome === 'cancelled')
    cancelTransition(authority, state, pending, 'The conversation kept its previous checkout.')
  else finishConfirmed(authority, state, pending, operation)
}

const markTransitionUnknown = (
  authority: WorkspaceAuthority,
  state: ConversationState,
  pending: PendingTransition,
  reason: string
): void => {
  pending.phase = 'unknown'
  state.parked = true
  try {
    inDb(authority, pending.targetRepositoryId, db =>
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
  } catch {}
}

const cancelTransition = (
  authority: WorkspaceAuthority,
  state: ConversationState,
  pending: PendingTransition,
  result: string
): void => {
  const { operationId } = pending.handoff
  const targetUse = inDb(authority, pending.targetRepositoryId, db =>
    getUse(db, pending.targetLease.useId)
  )
  if (targetUse === undefined) requireReview('Dev lost track of access to the selected checkout')
  if (targetUse.stage !== 'authorized')
    requireReview('The new checkout was used before dev confirmed the switch')
  inDb(authority, pending.targetRepositoryId, db =>
    transaction(db, () => {
      const current = getOperation(db, operationId)
      if (
        current === undefined ||
        current.kind === 'release' ||
        (current.phase !== 'intent' && current.phase !== 'started')
      )
        requireReview('The switch result does not match the requested checkout')
      const cancelled: TransitionOperationRecord = { ...current, phase: 'cancelled', result }
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
          requireReview('The selected checkout changed while cancelling the switch')
        putBinding(db, { ...binding, pendingOperationId: undefined })
      }
    })
  )
  if (pending.sourceRepositoryId !== pending.targetRepositoryId) {
    inDb(authority, pending.sourceRepositoryId, db =>
      transaction(db, () => {
        const binding = getBinding(db, state.key)
        if (binding === undefined || binding.pendingOperationId !== operationId)
          requireReview('The original checkout changed while cancelling the switch')
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

const finishConfirmed = (
  authority: WorkspaceAuthority,
  state: ConversationState,
  pending: PendingTransition,
  operation: TransitionOperationRecord
): void => {
  const sourceWorkspaceId = pending.handoff.from.workspaceId
  const oldUses = outgoingUses(authority, state, sourceWorkspaceId, pending.targetLease.useId)

  settleDependentsFirst(
    authority,
    oldUses,
    use =>
      use.execution === undefined
        ? { stage: 'quiescent', reason: 'host-tool-batch-settled' }
        : { stage: 'unknown', reason: 'host-switched-while-a-process-was-live' },
    'host-transition-left-dependent-uses-unresolved'
  )
  const oldLeases = oldUses.map(({ lease }) => lease)
  const confirmedBinding: BindingRecord = {
    ...pending.targetBinding,
    pendingOperationId: undefined,
    superseded: undefined,
  }
  const confirmedOperation: TransitionOperationRecord = {
    ...operation,
    phase: 'confirmed',
    result: 'The conversation opened the selected checkout.',
  }
  if (pending.sourceRepositoryId === pending.targetRepositoryId) {
    inDb(authority, pending.targetRepositoryId, db =>
      transaction(db, () => {
        const binding = getBinding(db, state.key)
        if (
          binding === undefined ||
          binding.pendingOperationId !== operation.id ||
          binding.revision !== operation.expectedBindingRevision
        )
          requireReview('The checkout changed before dev saved the switch')
        putBinding(db, confirmedBinding)
        saveOperation(db, confirmedOperation)
      })
    )
  } else {
    inDb(authority, pending.targetRepositoryId, db =>
      transaction(db, () => {
        const current = getOperation(db, operation.id)
        if (current === undefined || current.phase !== 'started')
          requireReview('The planned switch to another repository changed')
        saveOperation(db, {
          ...current,
          result: 'The new checkout opened, but dev has not saved the switch yet.',
        })
        const previous = getBinding(db, state.key)
        if (previous !== undefined)
          putBinding(db, { ...previous, superseded: true, pendingOperationId: undefined })
      })
    )
    inDb(authority, pending.sourceRepositoryId, db =>
      transaction(db, () => {
        const binding = getBinding(db, state.key)
        if (binding === undefined || binding.pendingOperationId !== operation.id)
          requireReview('The original checkout changed during the switch')
        putBinding(db, { ...binding, superseded: true, pendingOperationId: undefined })
      })
    )
    inDb(authority, pending.targetRepositoryId, db =>
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
