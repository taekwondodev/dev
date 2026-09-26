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
  type WorkspaceGrant,
  type WorkspaceHandoff,
  type WorkspaceSelection,
} from './workspace-domain.ts'
import { acquirePathGates, releaseGates } from './workspace-gates.ts'
import {
  BindingSchema,
  UseSchema,
  OperationSchema,
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
  getUseRows,
  activeDependentUses,
  toBinding,
  isActiveUse,
  type WorkspaceRecord,
  type ReservationRecord,
  type BindingRecord,
  type UseRecord,
  type OperationRecord,
} from './workspace-records.ts'
import {
  workspaceId,
  isUuid,
  now,
  jsonEqual,
  errorText,
  transaction,
  decodeOrFail,
} from './workspace-sqlite.ts'

export const resolveSelection = (
  authority: WorkspaceAuthority,
  selection: WorkspaceSelection
): {
  repo: string
  reservation: ReservationRecord
  workspace: WorkspaceRecord
} => {
  if (!isUuid(selection.taskId)) invalid('Task ID must be an exact UUID')
  if (selection.workspaceId !== undefined && !isUuid(selection.workspaceId))
    invalid('Workspace ID must be an exact UUID')
  const matches = taskWorkspaces(authority, selection.taskId)
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

export const selectWorkspace = (
  authority: WorkspaceAuthority,
  attachment: AttachmentHandle,
  selection: WorkspaceSelection
): WorkspaceHandoff => {
  attachment.assertOpen()
  const state = attachment.state
  if (state.parked || state.pending !== undefined)
    blocked('A workspace transition is already pending')
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
        operationId: workspaceId(),
        from: toBinding(state.binding),
        target: current,
        reason: 'The selected task is already bound to this workspace.',
      }
  }
  const targetUses = inDb(authority, target.repo, db => getUseRows(db, target.workspace.id))
  if (
    targetUses.some(use => use.access === 'write' && isActiveUse(use) && !state.leases.has(use.id))
  )
    blocked(`Selected workspace has an active or unresolved writer: ${target.workspace.path}`)
  const gates = acquirePathGates(authority.paths, target.workspace.path, true)
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
      incarnation: state.incarnation,
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
    inDb(authority, target.repo, db =>
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
      inDb(authority, source.repo, db =>
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
}

export const performHandoff = async (
  authority: WorkspaceAuthority,
  attachment: AttachmentHandle,
  transition: WorkspaceHandoff,
  replace: (target: WorkspaceGrant) => Promise<'confirmed' | 'cancelled'>
): Promise<void> => {
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
    validateGrant(authority, state, pending.handoff.target)
    assertNoLiveExecution(authority, state, pending.handoff.from, 'switched')
    operation = inDb(authority, pending.targetRepositoryId, db =>
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
    cancelTransition(
      authority,
      state,
      pending,
      `Refused before the host acted: ${errorText(cause)}`
    )
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
    markTransitionUnknown(
      authority,
      state,
      pending,
      `Host transition outcome is uncertain: ${errorText(cause)}`
    )
    return requireReview(`Workspace handoff requires explicit recovery: ${transition.operationId}`)
  }
  if (outcome === 'cancelled')
    cancelTransition(
      authority,
      state,
      pending,
      'Host reported that the last confirmed binding was preserved.'
    )
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
  } catch {
    /* preserve the already-durable started intent and pending binding */
  }
}

const cancelTransition = (
  authority: WorkspaceAuthority,
  state: ConversationState,
  pending: PendingTransition,
  result: string
): void => {
  const operationId = pending.handoff.operationId
  const targetUse = inDb(authority, pending.targetRepositoryId, db =>
    getUse(db, pending.targetLease.useId)
  )
  if (targetUse === undefined) requireReview('Cancelled handoff lost its target use record')
  if (targetUse.stage !== 'authorized')
    requireReview('Cancelled handoff target was used before host confirmation')
  inDb(authority, pending.targetRepositoryId, db =>
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
    inDb(authority, pending.sourceRepositoryId, db =>
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

const finishConfirmed = (
  authority: WorkspaceAuthority,
  state: ConversationState,
  pending: PendingTransition,
  operation: OperationRecord
): void => {
  const sourceWorkspaceId = pending.handoff.from.workspaceId
  const oldUses = outgoingUses(authority, state, sourceWorkspaceId, pending.targetLease.useId)
  // Dependents first: a use is always created after its `within` parent, so reverse
  // insertion order settles descendants before the parent whose gates they rely on.
  // A dependent left unknown keeps its parent unknown instead of failing here, after
  // the host has already switched.
  for (const { lease, use } of oldUses.toReversed()) {
    if (use.stage === 'quiescent' || use.stage === 'unknown') continue
    inDb(authority, lease.repositoryId, db =>
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
    inDb(authority, pending.targetRepositoryId, db =>
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
    inDb(authority, pending.targetRepositoryId, db =>
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
    inDb(authority, pending.sourceRepositoryId, db =>
      transaction(db, () => {
        const binding = getBinding(db, state.key)
        if (binding === undefined || binding.pendingOperationId !== operation.id)
          requireReview('Cross-repository source binding changed')
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
