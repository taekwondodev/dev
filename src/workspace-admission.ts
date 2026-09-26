import { realpathSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { isAbsolute, resolve } from 'node:path'
import { Schema } from 'effect'
import { allocateWorkspace } from './workspace-allocation.ts'
import { toGrant, inDb, validateWorkspace, type WorkspaceAuthority } from './workspace-authority.ts'
import type { GrantLease, ConversationState, AttachmentHandle } from './workspace-conversation.ts'
import {
  blocked,
  invalid,
  requireReview,
  WorkspaceEffectSchema,
  WorkspaceError,
  WorkspaceProcessSchema,
  WorkspaceGrantSchema,
  type WorkspaceAuthorization,
  type WorkspaceExecution,
  type WorkspaceExecutionFact,
  type WorkspaceGrant,
  type WorkspaceOperation,
} from './workspace-domain.ts'
import { acquirePathGates, releaseGates, type PathGates } from './workspace-gates.ts'
import type { GitWorkspace } from './workspace-git.ts'
import { assertDestinationUnchanged, isWithin, resolveWriteDestination } from './workspace-paths.ts'
import {
  BindingSchema,
  UseSchema,
  getTask,
  putTask,
  getWorkspace,
  getReservation,
  putReservation,
  updateReservation,
  getBinding,
  putBinding,
  getUse,
  putUse,
  saveUse,
  getUseRows,
  assertWithinLiveInDb,
  isActiveUse,
  validExecution,
  validExecutionFact,
  type WorkspaceRecord,
  type BindingRecord,
  type UseRecord,
} from './workspace-records.ts'
import { workspaceId, now, jsonEqual, transaction, decodeOrFail } from './workspace-sqlite.ts'

export const claimGrant = (attachment: AttachmentHandle, grant: WorkspaceGrant): void => {
  const owners = attachment.state.leaseAttachments.get(grant.useId) ?? new Set<string>()
  owners.add(attachment.token)
  attachment.state.leaseAttachments.set(grant.useId, owners)
}

export const currentSource = (
  authority: WorkspaceAuthority,
  state: ConversationState
): {
  repo: string
  binding: BindingRecord
  workspace: WorkspaceRecord
  git: GitWorkspace
} => {
  const binding =
    state.pending !== undefined && state.pending.phase === 'confirmed'
      ? state.pending.targetBinding
      : state.binding
  const workspace = inDb(authority, state.repositoryId, db => getWorkspace(db, binding.workspaceId))
  if (workspace === undefined) requireReview(`Bound workspace is missing: ${binding.workspaceId}`)
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
  input: WorkspaceGrant
): { readonly lease: GrantLease; readonly workspace: WorkspaceRecord; readonly use: UseRecord } => {
  const grant = decodeOrFail(WorkspaceGrantSchema, input, 'within workspace grant', 'invalid')
  const owners = attachment.state.leaseAttachments.get(grant.useId)
  if (owners === undefined || !owners.has(attachment.token))
    requireReview('Scoped operation grant was not issued to this attachment')
  const lease = validateGrant(authority, attachment.state, grant)
  const result = inDb(authority, grant.repositoryId, db => {
    const workspace = getWorkspace(db, grant.workspaceId)
    const use = getUse(db, grant.useId)
    if (workspace === undefined || use === undefined)
      requireReview('Scoped operation grant has no live workspace use')
    if (use.effect !== undefined || use.execution !== undefined)
      invalid('A scoped operation must be admitted within an ordinary workspace grant')
    if (use.access !== grant.access || use.stage === 'quiescent')
      requireReview('Scoped operation grant is no longer active')
    if (use.stage !== 'authorized')
      blocked(`Scoped operation grant is unresolved: ${use.id} (${use.stage})`)
    return { workspace, use }
  })
  validateWorkspace(authority, result.workspace)
  return { lease, ...result }
}

export const authorizeOperation = (
  authority: WorkspaceAuthority,
  attachment: AttachmentHandle,
  operation: WorkspaceOperation
): WorkspaceAuthorization => {
  attachment.assertOpen()
  const state = attachment.state
  if (state.closing || state.parked)
    blocked('Workspace admission is parked during a host transition')
  if (operation.access !== 'read' && operation.access !== 'write')
    invalid('Operation access must be read or write')
  if (operation.cwd !== undefined && !isAbsolute(operation.cwd))
    invalid('Operation cwd must be absolute')
  if (operation.delegated === true && operation.access !== 'write')
    invalid('Delegated workspace admission requires write access')
  if (operation.effect !== undefined && !Schema.is(WorkspaceEffectSchema)(operation.effect))
    invalid('Workspace operation effect is invalid')
  if (operation.effect === undefined) {
    if (operation.within !== undefined || operation.path !== undefined)
      invalid('Scoped operation fields require an explicit effect classification')
  } else {
    if (operation.within === undefined)
      invalid('Scoped operation requires an attachment-owned within grant')
    if (operation.delegated === true)
      invalid('Scoped operation cannot also request a delegated allocation')
    if (operation.execution !== undefined) validExecution(operation.execution)
    return authorizeScoped(authority, attachment, operation)
  }
  const source = currentSource(authority, state)
  const cwd =
    operation.cwd === undefined ? source.binding.cwd : realpathSync(resolve(operation.cwd))
  if (!isWithin(source.workspace.path, cwd))
    invalid(`Operation cwd is outside the selected workspace: ${cwd}`)
  if (operation.execution !== undefined) validExecution(operation.execution)
  if (operation.access === 'read') {
    const ready = authorizeRead(
      authority,
      state,
      source.repo,
      source.workspace,
      source.binding,
      cwd
    )
    if (operation.execution === undefined) return ready
    const base = state.leases.get(ready.grant.useId)
    if (base === undefined) requireReview('Reader grant disappeared before execution attribution')
    return executionUse(authority, state, base, operation.execution)
  }
  if (operation.delegated === true) {
    const taskId = source.binding.taskId ?? workspaceId()
    return allocateWorkspace(
      authority,
      state,
      source.repo,
      source.workspace,
      source.git,
      taskId,
      true,
      operation.execution
    )
  }
  const existing = state.writeGrant
  if (
    existing !== undefined &&
    existing.workspaceId === source.workspace.id &&
    existing.taskId === source.binding.taskId
  ) {
    const lease = validateGrant(authority, state, existing)
    return operation.execution === undefined
      ? { kind: 'ready', grant: lease.grant }
      : executionUse(authority, state, lease, operation.execution)
  }
  const reservation = inDb(authority, source.repo, db => getReservation(db, source.workspace.id))
  if (reservation !== undefined && reservation.taskId !== source.binding.taskId)
    return allocateWorkspace(
      authority,
      state,
      source.repo,
      source.workspace,
      source.git,
      source.binding.taskId ?? workspaceId(),
      false,
      operation.execution
    )
  const activeWrites = inDb(authority, source.repo, db =>
    getUseRows(db, source.workspace.id).filter(use => use.access === 'write' && isActiveUse(use))
  )
  const foreignActive = activeWrites.some(use => !state.leases.has(use.id))
  if (foreignActive) {
    if (source.binding.taskId !== undefined)
      blocked(`The selected task has an unresolved writer use: ${source.workspace.path}`)
    return allocateWorkspace(
      authority,
      state,
      source.repo,
      source.workspace,
      source.git,
      workspaceId(),
      false,
      operation.execution
    )
  }
  let gates: PathGates
  try {
    gates = acquirePathGates(authority.paths, source.workspace.path, true)
  } catch (cause) {
    if (
      !(cause instanceof WorkspaceError) ||
      cause.outcome !== 'blocked' ||
      source.binding.taskId !== undefined
    )
      throw cause
    return allocateWorkspace(
      authority,
      state,
      source.repo,
      source.workspace,
      source.git,
      workspaceId(),
      false,
      operation.execution
    )
  }
  try {
    const taskId = source.binding.taskId ?? workspaceId()
    const useId = workspaceId()
    const reservationId = reservation?.id ?? workspaceId()
    const acquisitionId = workspaceId()
    const updatedBinding = decodeOrFail(
      BindingSchema,
      {
        ...source.binding,
        ...(source.binding.taskId === undefined ? { taskId } : {}),
        revision: source.binding.revision + (source.binding.taskId === undefined ? 1 : 0),
      },
      'write binding'
    )
    const use: UseRecord = decodeOrFail(
      UseSchema,
      {
        id: useId,
        workspaceId: source.workspace.id,
        taskId,
        reservationId,
        acquisitionId,
        access: 'write',
        stage: 'authorized',
        processes: [],
        conversationKey: state.key,
        bindingRevision: updatedBinding.revision,
        revision: 0,
        createdAt: now(),
        updatedAt: now(),
      },
      'write use'
    )
    inDb(authority, source.repo, db =>
      transaction(db, () => {
        const currentBinding = getBinding(db, state.key)
        if (
          currentBinding === undefined ||
          currentBinding.revision !== source.binding.revision ||
          currentBinding.workspaceId !== source.workspace.id
        )
          requireReview('Conversation binding changed during write admission')
        const currentReservation = getReservation(db, source.workspace.id)
        if (currentReservation !== undefined && currentReservation.taskId !== taskId)
          blocked(`Checkout is reserved by another task: ${source.workspace.path}`)
        if (currentReservation === undefined) {
          putReservation(db, {
            id: reservationId,
            taskId,
            workspaceId: source.workspace.id,
            acquisitionId,
            revision: 0,
            createdAt: now(),
          })
        } else {
          if (currentReservation.id !== reservationId)
            requireReview('Workspace reservation identity changed')
          updateReservation(db, {
            ...currentReservation,
            acquisitionId,
            revision: currentReservation.revision + 1,
          })
        }
        if (getTask(db, taskId) === undefined)
          putTask(db, { id: taskId, repositoryId: source.repo, revision: 0, createdAt: now() })
        if (
          updatedBinding.revision !== source.binding.revision ||
          updatedBinding.taskId !== source.binding.taskId
        )
          putBinding(db, updatedBinding)
        putUse(db, use)
      })
    )
    const grant = toGrant(authority, source.repo, source.workspace, use, cwd, 'write')
    const lease: GrantLease = {
      grant,
      repositoryId: source.repo,
      useId,
      gates,
      borrowed: false,
      isExecution: false,
      released: false,
    }
    state.leases.set(useId, lease)
    state.writeGrant = grant
    state.binding = updatedBinding
    if (operation.execution !== undefined)
      return executionUse(authority, state, lease, operation.execution)
    return { kind: 'ready', grant }
  } catch (cause) {
    releaseGates(gates)
    throw cause
  }
}

const authorizeScoped = (
  authority: WorkspaceAuthority,
  attachment: AttachmentHandle,
  operation: WorkspaceOperation
): WorkspaceAuthorization => {
  const { state } = attachment
  const { effect, within } = operation
  if (effect === undefined || within === undefined)
    invalid('Scoped operation requires an explicit effect and within grant')
  const {
    lease: withinLease,
    workspace,
    use: withinUse,
  } = validateWithinGrant(authority, attachment, within)
  if (operation.access === 'write' && within.access !== 'write')
    blocked('A read-only workspace grant cannot authorize a scoped mutation')
  if (effect === 'native-file-write' && operation.access !== 'write')
    invalid('Native file writes require write access')
  if (effect === 'opaque' && operation.access !== 'write')
    invalid('Opaque operations require write access')
  if (effect === 'native-file-write' && operation.path === undefined)
    invalid('Native file writes require an exact destination path')
  if (effect !== 'native-file-write' && operation.path !== undefined)
    invalid('Only native file writes accept a path operand')
  if (effect === 'opaque' && operation.execution === undefined)
    invalid('Opaque operations require process execution identity')
  if (effect !== 'opaque' && operation.execution !== undefined)
    invalid('Native operations cannot carry process execution identity')
  const cwd = realpathSync(resolve(operation.cwd ?? within.cwd))
  if (!isWithin(workspace.path, cwd)) invalid(`Scoped operation cwd escapes its workspace: ${cwd}`)
  const operationPath =
    effect === 'native-file-write'
      ? resolveWriteDestination(workspace.path, cwd, operation.path as string)
      : undefined
  const execution =
    operation.execution === undefined ? undefined : validExecution(operation.execution)
  const use: UseRecord = decodeOrFail(
    UseSchema,
    {
      id: workspaceId(),
      workspaceId: workspace.id,
      taskId: withinUse.taskId,
      ...(withinUse.reservationId === undefined ? {} : { reservationId: withinUse.reservationId }),
      ...(withinUse.acquisitionId === undefined ? {} : { acquisitionId: withinUse.acquisitionId }),
      access: operation.access,
      stage: 'authorized',
      effect,
      withinUseId: withinUse.id,
      ...(operationPath === undefined ? {} : { operationPath }),
      ...(execution === undefined ? {} : { execution }),
      processes: [],
      conversationKey: state.key,
      bindingRevision: withinUse.bindingRevision,
      revision: 0,
      createdAt: now(),
      updatedAt: now(),
    },
    'scoped workspace use'
  )
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
        requireReview('Within grant changed before scoped operation admission')
      putUse(db, use)
    })
  )
  const grant = toGrant(authority, withinLease.repositoryId, workspace, use, cwd, operation.access)
  state.leases.set(use.id, {
    grant,
    repositoryId: withinLease.repositoryId,
    useId: use.id,
    effect,
    withinUseId: withinUse.id,
    borrowed: true,
    isExecution: execution !== undefined,
    ...(execution === undefined ? {} : { execution }),
    released: false,
  })
  return { kind: 'ready', grant }
}

const authorizeRead = (
  authority: WorkspaceAuthority,
  state: ConversationState,
  repo: string,
  workspace: WorkspaceRecord,
  binding: BindingRecord,
  cwd: string
): WorkspaceAuthorization & { readonly kind: 'ready' } => {
  for (const lease of state.leases.values()) {
    if (
      !lease.released &&
      !lease.isExecution &&
      lease.grant.access === 'read' &&
      lease.grant.workspaceId === workspace.id &&
      lease.grant.revision === binding.revision
    )
      return {
        kind: 'ready',
        grant: lease.grant,
        ...(writerWarning(authority, state, repo, workspace.id) === undefined
          ? {}
          : { warning: writerWarning(authority, state, repo, workspace.id) }),
      }
  }
  const gates = acquirePathGates(authority.paths, workspace.path, false)
  try {
    const reservation = inDb(authority, repo, db => getReservation(db, workspace.id))
    const use = decodeOrFail(
      UseSchema,
      {
        id: workspaceId(),
        workspaceId: workspace.id,
        taskId: binding.taskId,
        ...(reservation === undefined ? {} : { reservationId: reservation.id }),
        access: 'read',
        stage: 'authorized',
        processes: [],
        conversationKey: state.key,
        bindingRevision: binding.revision,
        revision: 0,
        createdAt: now(),
        updatedAt: now(),
      },
      'reader use'
    )
    inDb(authority, repo, db => transaction(db, () => putUse(db, use)))
    const grant = toGrant(authority, repo, workspace, use, cwd, 'read')
    const lease: GrantLease = {
      grant,
      repositoryId: repo,
      useId: use.id,
      gates,
      borrowed: false,
      isExecution: false,
      released: false,
    }
    state.leases.set(use.id, lease)
    const warning = writerWarning(authority, state, repo, workspace.id)
    return { kind: 'ready', grant, ...(warning === undefined ? {} : { warning }) }
  } catch (cause) {
    releaseGates(gates)
    throw cause
  }
}

const writerWarning = (
  authority: WorkspaceAuthority,
  state: ConversationState,
  repo: string,
  workspaceIdValue: string
): string | undefined => {
  if (
    inDb(authority, repo, db =>
      getUseRows(db, workspaceIdValue).some(
        use => use.access === 'write' && isActiveUse(use) && !state.leases.has(use.id)
      )
    )
  )
    return 'A writer owns this live checkout; files may change while you read. No stable snapshot is provided.'
  return undefined
}

const executionUse = (
  authority: WorkspaceAuthority,
  state: ConversationState,
  parent: GrantLease,
  input: WorkspaceExecution
): WorkspaceAuthorization => {
  validateGrant(authority, state, parent.grant)
  const execution = validExecution(input)
  const base = inDb(authority, parent.repositoryId, db => getUse(db, parent.useId))
  if (base === undefined) requireReview('Workspace grant has no base use record')
  const use: UseRecord = decodeOrFail(
    UseSchema,
    {
      ...base,
      id: workspaceId(),
      execution,
      stage: 'authorized',
      processes: [],
      revision: 0,
      createdAt: now(),
      updatedAt: now(),
      reason: undefined,
    },
    'execution recovery use'
  )
  inDb(authority, parent.repositoryId, db => transaction(db, () => putUse(db, use)))
  const grant = decodeOrFail(
    WorkspaceGrantSchema,
    { ...parent.grant, useId: use.id },
    'execution grant'
  )
  const lease: GrantLease = {
    grant,
    repositoryId: parent.repositoryId,
    useId: use.id,
    borrowed: true,
    isExecution: true,
    execution,
    released: false,
  }
  state.leases.set(use.id, lease)
  return { kind: 'ready', grant }
}

export const validateGrant = (
  authority: WorkspaceAuthority,
  state: ConversationState,
  input: WorkspaceGrant
): GrantLease => {
  const grant = decodeOrFail(WorkspaceGrantSchema, input, 'workspace grant', 'invalid')
  if (grant.namespaceId !== authority.initialize())
    requireReview('Workspace grant belongs to another namespace')
  const lease = state.leases.get(grant.useId)
  if (lease === undefined || lease.released || !jsonEqual(lease.grant, grant))
    requireReview('Workspace grant is stale or was not issued to this attachment')
  const workspace = inDb(authority, grant.repositoryId, db => {
    const record = getWorkspace(db, grant.workspaceId)
    const use = getUse(db, grant.useId)
    if (record === undefined || use === undefined)
      requireReview('Workspace grant has no matching durable use')
    if (
      use.workspaceId !== grant.workspaceId ||
      use.bindingRevision !== grant.revision ||
      use.acquisitionId !== grant.acquisitionId ||
      use.reservationId !== grant.reservationId ||
      use.taskId !== grant.taskId ||
      use.access !== grant.access ||
      use.effect !== lease.effect ||
      use.withinUseId !== lease.withinUseId ||
      use.operationPath !== grant.path
    )
      requireReview('Workspace grant no longer matches its fenced use facts')
    if (grant.access === 'write') {
      const reservation = getReservation(db, grant.workspaceId)
      if (
        reservation === undefined ||
        reservation.id !== grant.reservationId ||
        reservation.taskId !== grant.taskId ||
        reservation.acquisitionId !== grant.acquisitionId
      )
        requireReview('Workspace grant is not the current reservation acquisition')
    }
    return record
  })
  validateWorkspace(authority, workspace)
  return lease
}

export const validateDurableGrant = (
  authority: WorkspaceAuthority,
  input: WorkspaceGrant
): void => {
  const grant = decodeOrFail(WorkspaceGrantSchema, input, 'workspace grant', 'invalid')
  const namespace = authority.inspectExisting()
  if (namespace === undefined || namespace !== grant.namespaceId)
    requireReview('Workspace grant namespace is missing or differs')
  const repositories = authority.listRepositories()
  if (!repositories.some(repository => repository.id === grant.repositoryId))
    requireReview('Workspace grant repository is not registered')
  const workspace = inDb(authority, grant.repositoryId, db => {
    const record = getWorkspace(db, grant.workspaceId)
    const use = getUse(db, grant.useId)
    if (record === undefined || use === undefined)
      requireReview('Workspace grant does not identify a durable use')
    if (
      use.workspaceId !== grant.workspaceId ||
      use.bindingRevision !== grant.revision ||
      use.acquisitionId !== grant.acquisitionId ||
      use.reservationId !== grant.reservationId ||
      use.taskId !== grant.taskId ||
      use.access !== grant.access ||
      use.operationPath !== grant.path
    )
      requireReview('Workspace grant does not match its fenced use record')
    if (use.stage === 'quiescent' || use.stage === 'observed' || use.stage === 'unknown')
      requireReview(`Workspace use is no longer eligible for a child: ${use.stage}`)
    if (grant.access === 'write') {
      const reservation = getReservation(db, grant.workspaceId)
      if (
        reservation === undefined ||
        reservation.id !== grant.reservationId ||
        reservation.taskId !== grant.taskId ||
        reservation.acquisitionId !== grant.acquisitionId
      )
        requireReview('Workspace grant acquisition is stale')
    }
    return record
  })
  if (grant.checkout !== workspace.path || grant.origin !== workspace.origin)
    requireReview('Workspace grant checkout fields were altered')
  if (!isAbsolute(grant.cwd) || !isWithin(workspace.path, grant.cwd))
    requireReview('Workspace grant cwd escapes its checkout')
  let actualCwd: string
  try {
    actualCwd = realpathSync(grant.cwd)
  } catch {
    return requireReview(`Workspace grant cwd is unavailable: ${grant.cwd}`)
  }
  if (actualCwd !== grant.cwd || !isWithin(workspace.path, actualCwd))
    requireReview('Workspace grant cwd is not the canonical checkout path')
  validateWorkspace(authority, workspace)
}

export const reportExecutionFact = (
  authority: WorkspaceAuthority,
  attachment: AttachmentHandle,
  input: WorkspaceGrant,
  fact: WorkspaceExecutionFact
): void => {
  attachment.assertOpen()
  const state = attachment.state
  if (state.closing) blocked('Execution reporting is fenced during attachment closure')
  const checkedFact = validExecutionFact(fact)
  // A transition waits for running work to end, so facts that end it stay reportable.
  if (
    state.parked &&
    ['launch-intent', 'spawned', 'started', 'operation-started'].includes(checkedFact.kind)
  )
    blocked('Starting an operation is fenced during a host transition')
  const lease = validateGrant(authority, state, input)
  if (lease.effect !== undefined) {
    const owners = state.leaseAttachments.get(lease.useId)
    if (owners === undefined || !owners.has(attachment.token))
      requireReview('Scoped operation report was not issued to this attachment')
  }
  if (!lease.isExecution) return reportScopedOperation(authority, lease, checkedFact)
  if (lease.execution === undefined)
    invalid('Execution facts require a fresh execution-scoped grant')
  if (checkedFact.kind === 'operation-started' || checkedFact.kind === 'operation-completed')
    invalid('Operation boundary facts are only valid for non-process scoped operations')
  const current = inDb(authority, lease.repositoryId, db => getUse(db, lease.useId))
  if (
    current === undefined ||
    current.execution === undefined ||
    !jsonEqual(current.execution, lease.execution)
  )
    requireReview('Execution recovery row no longer matches the issued grant')
  if (current.stage === 'quiescent') requireReview('Execution has already been settled')
  const update = (value: UseRecord, guard?: (db: DatabaseSync) => void): void =>
    inDb(authority, lease.repositoryId, db =>
      transaction(db, () => {
        guard?.(db)
        saveUse(db, value)
      })
    )
  const updatedAt = now()
  switch (checkedFact.kind) {
    case 'launch-intent': {
      if (!jsonEqual(validExecution(checkedFact.execution), lease.execution))
        invalid('Launch intent does not match the authorized execution')
      if (current.stage !== 'authorized')
        requireReview(`Cannot record launch intent after ${current.stage}`)
      update({ ...current, stage: 'launch-intent', revision: current.revision + 1, updatedAt })
      return
    }
    case 'spawned': {
      if (current.stage !== 'launch-intent')
        requireReview(`Cannot record process identity after ${current.stage}`)
      const process = decodeOrFail(
        WorkspaceProcessSchema,
        checkedFact.process,
        'spawned process identity',
        'invalid'
      )
      update({
        ...current,
        stage: 'spawned',
        processes: [process],
        revision: current.revision + 1,
        updatedAt,
      })
      return
    }
    case 'started': {
      if (current.stage !== 'spawned')
        requireReview(
          `Cannot release user code after ${current.stage}; process identity must be recorded first`
        )
      update({ ...current, stage: 'started', revision: current.revision + 1, updatedAt })
      return
    }
    case 'observed': {
      if (!['spawned', 'started', 'observed'].includes(current.stage))
        requireReview(`Cannot record a process observation after ${current.stage}`)
      const processes = decodeOrFail(
        Schema.Array(WorkspaceProcessSchema),
        checkedFact.processes,
        'observed process set',
        'invalid'
      )
      update({
        ...current,
        stage: 'observed',
        processes,
        revision: current.revision + 1,
        updatedAt,
      })
      return
    }
    case 'unknown': {
      update({
        ...current,
        stage: 'unknown',
        reason: checkedFact.reason,
        revision: current.revision + 1,
        updatedAt,
      })
      return
    }
    case 'launch-failed': {
      // Only before a process identity is recorded can the adapter know that no user
      // code was released; afterwards the family must be observed gone instead.
      if (current.stage !== 'authorized' && current.stage !== 'launch-intent')
        requireReview(`A launch cannot be reported failed after ${current.stage}`)
      update({
        ...current,
        stage: 'quiescent',
        reason: `launch-failed: ${checkedFact.reason}`,
        revision: current.revision + 1,
        updatedAt,
      })
      lease.released = true
      return
    }
    case 'quiescent': {
      // A process that detaches into a new session escapes this observation; ADR 0005
      // accepts that residual risk.
      if (current.stage !== 'observed' || current.processes.length > 0)
        requireReview(
          `Quiescence after ${current.stage} requires an observed empty process family first`
        )
      update({
        ...current,
        stage: 'quiescent',
        reason: checkedFact.reason,
        revision: current.revision + 1,
        updatedAt,
      })
      lease.released = true
      return
    }
    default: {
      const exhaustive: never = checkedFact
      return exhaustive
    }
  }
}

const reportScopedOperation = (
  authority: WorkspaceAuthority,
  lease: GrantLease,
  fact: WorkspaceExecutionFact
): void => {
  if (lease.effect === undefined)
    invalid('Legacy workspace grants do not carry scoped operation authority')
  if (
    fact.kind !== 'operation-started' &&
    fact.kind !== 'operation-completed' &&
    fact.kind !== 'unknown'
  )
    invalid('Scoped native operations require operation boundary facts')
  const current = inDb(authority, lease.repositoryId, db => getUse(db, lease.useId))
  if (current === undefined || current.effect !== lease.effect)
    requireReview('Scoped operation lost its durable use record')
  const next = inDb(authority, lease.repositoryId, db =>
    transaction(db, () => {
      const latest = getUse(db, lease.useId)
      if (
        latest === undefined ||
        latest.revision !== current.revision ||
        latest.effect !== lease.effect ||
        latest.withinUseId !== lease.withinUseId
      )
        requireReview('Scoped operation report is stale')
      if (fact.kind === 'operation-started') {
        if (latest.stage !== 'authorized')
          requireReview(`Cannot start scoped operation after ${latest.stage}`)
        assertWithinLiveInDb(db, latest)
        if (latest.operationPath !== undefined) {
          const workspace = getWorkspace(db, latest.workspaceId)
          if (workspace === undefined)
            requireReview(`Scoped operation lost its workspace: ${latest.workspaceId}`)
          assertDestinationUnchanged(workspace.path, latest.operationPath)
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
          requireReview(`Cannot complete scoped operation after ${latest.stage}`)
        const completed: UseRecord = {
          ...latest,
          stage: 'quiescent',
          reason:
            latest.stage === 'authorized'
              ? `operation-ended-before-start:${lease.effect}`
              : `operation-completed:${lease.effect}`,
          revision: latest.revision + 1,
          updatedAt: now(),
        }
        saveUse(db, completed)
        return completed
      }
      if (latest.stage !== 'authorized' && latest.stage !== 'operation-started')
        requireReview(`Cannot mark scoped operation unknown after ${latest.stage}`)
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
