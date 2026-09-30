import { realpathSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import {
  allocateDelegatedWorkspace,
  isolateContendedWriter,
  type AllocationSweep,
} from './workspace-allocation.ts'
import { toGrant, inDb, validateWorkspace, type WorkspaceAuthority } from './workspace-authority.ts'
import {
  isScoped,
  type AttachmentHandle,
  type ConversationState,
  type CurrentSource,
  type GrantLease,
  type LeaseKind,
} from './workspace-conversation.ts'
import {
  blocked,
  invalid,
  requireReview,
  WorkspaceError,
  sameExecution,
  sameGrant,
  type WorkspaceAuthorization,
  type WorkspaceExecution,
  type WorkspaceExecutionFact,
  type WorkspaceGrant,
  type WorkspaceId,
  type ScopedOperation,
  type WorkspaceOperation,
} from './workspace-domain.ts'
import { acquirePathGates, releaseGates, type PathGates } from './workspace-gates.ts'
import { assertDestinationUnchanged, isWithin, resolveWriteDestination } from './workspace-paths.ts'
import {
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
  type WorkspaceRecord,
  type BindingRecord,
  type UseRecord,
} from './workspace-records.ts'
import { transaction } from './workspace-sqlite.ts'
import { newId, now } from './workspace-platform.ts'

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
  grant: WorkspaceGrant
): { readonly lease: GrantLease; readonly workspace: WorkspaceRecord; readonly use: UseRecord } => {
  const owners = attachment.state.leaseAttachments.get(grant.useId)
  if (owners === undefined || !owners.has(attachment.token))
    requireReview('Scoped operation grant was not issued to this attachment')
  const lease = validateGrant(authority, attachment.state, grant)
  const result = inDb(authority, grant.repositoryId, db => {
    const { workspace, use } = fencedUse(
      db,
      grant,
      'Scoped operation grant has no live workspace use'
    )
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
  operation: WorkspaceOperation,
  sweep: AllocationSweep
): WorkspaceAuthorization => {
  const result = admit(authority, attachment, operation, sweep)
  if (result.kind === 'ready') claimGrant(attachment, result.grant)
  return result
}

const admit = (
  authority: WorkspaceAuthority,
  attachment: AttachmentHandle,
  operation: WorkspaceOperation,
  sweep: AllocationSweep
): WorkspaceAuthorization => {
  attachment.assertOpen()
  const { state } = attachment
  if (state.closing || state.parked)
    blocked('Workspace admission is parked during a host transition')
  if (operation.kind === 'native-file-write' || operation.kind === 'opaque')
    return authorizeScoped(authority, attachment, operation)
  if (operation.kind === 'leaf-read')
    return authorizeLeafRead(authority, attachment, operation.coordinator, operation.execution)
  const source = currentSource(authority, state)
  const cwd =
    operation.cwd === undefined ? source.binding.cwd : realpathSync(resolve(operation.cwd))
  if (!isWithin(source.workspace.path, cwd))
    invalid(`Operation cwd is outside the selected workspace: ${cwd}`)
  if (operation.kind === 'read') {
    const ready = authorizeRead(authority, state, source, cwd)
    if (operation.execution === undefined) return ready
    const base = state.leases.get(ready.grant.useId)
    if (base === undefined) requireReview('Reader grant disappeared before execution attribution')
    return executionUse(authority, state, base, operation.execution)
  }
  if (operation.kind === 'delegated-write')
    return allocateDelegatedWorkspace(
      authority,
      state,
      source,
      source.binding.taskId ?? newId(),
      operation.execution,
      sweep
    )
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
    return isolateContendedWriter(authority, state, source, source.binding.taskId ?? newId(), sweep)
  const activeWrites = inDb(authority, source.repo, db =>
    getUseRows(db, source.workspace.id).filter(use => use.access === 'write' && isActiveUse(use))
  )
  const foreignActive = activeWrites.some(use => !state.leases.has(use.id))
  if (foreignActive) {
    if (source.binding.taskId !== undefined)
      blocked(`The selected task has an unresolved writer use: ${source.workspace.path}`)
    return isolateContendedWriter(authority, state, source, newId(), sweep)
  }
  let gates: PathGates
  try {
    gates = acquirePathGates(authority.paths, source.workspace.path, 'writer')
  } catch (cause) {
    if (
      !(cause instanceof WorkspaceError) ||
      cause.outcome !== 'blocked' ||
      source.binding.taskId !== undefined
    )
      throw cause
    return isolateContendedWriter(authority, state, source, newId(), sweep)
  }
  try {
    const taskId = source.binding.taskId ?? newId()
    const useId = newId()
    const reservationId = reservation?.id ?? newId()
    const acquisitionId = newId()
    const updatedBinding = {
      ...source.binding,
      ...(source.binding.taskId === undefined ? { taskId } : {}),
      revision: source.binding.revision + (source.binding.taskId === undefined ? 1 : 0),
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
      kind: 'ordinary',
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
  operation: ScopedOperation
): WorkspaceAuthorization => {
  const { state } = attachment
  const { within } = operation
  const {
    lease: withinLease,
    workspace,
    use: withinUse,
  } = validateWithinGrant(authority, attachment, within)
  if (within.access !== 'write')
    blocked('A read-only workspace grant cannot authorize a scoped mutation')
  const cwd = realpathSync(resolve(operation.cwd ?? within.cwd))
  if (!isWithin(workspace.path, cwd)) invalid(`Scoped operation cwd escapes its workspace: ${cwd}`)
  const kind: LeaseKind =
    operation.kind === 'native-file-write'
      ? { kind: operation.kind, withinUseId: withinUse.id }
      : { kind: operation.kind, withinUseId: withinUse.id, execution: operation.execution }
  const operationPath =
    operation.kind === 'native-file-write'
      ? resolveWriteDestination(workspace.path, cwd, operation.path)
      : undefined
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
        requireReview('Within grant changed before scoped operation admission')
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
  source: CurrentSource,
  cwd: string
): WorkspaceAuthorization & { readonly kind: 'ready' } => {
  const { repo, workspace, binding } = source
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
      lease.grant.revision === binding.revision
    )
      return ready(lease.grant)
  }
  const gates = acquirePathGates(authority.paths, workspace.path, 'reader')
  try {
    const reservation = inDb(authority, repo, db => getReservation(db, workspace.id))
    const use = {
      id: newId(),
      workspaceId: workspace.id,
      taskId: binding.taskId,
      ...(reservation === undefined ? {} : { reservationId: reservation.id }),
      access: 'read',
      stage: 'authorized',
      processes: [],
      incarnation: state.incarnation,
      bindingRevision: binding.revision,
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
  execution: WorkspaceExecution
): WorkspaceAuthorization => {
  validateGrant(authority, state, parent.grant)
  const base = inDb(authority, parent.repositoryId, db => getUse(db, parent.useId))
  if (base === undefined) requireReview('Workspace grant has no base use record')
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
  if (owners === undefined || !owners.has(attachment.token))
    requireReview('Coordinator grant was not issued to this attachment')
  const lease = validateGrant(authority, state, coordinator)
  if (lease.kind !== 'execution')
    invalid('A leaf reads only the workspace of a delegated coordinator')
  const use = inDb(authority, coordinator.repositoryId, db =>
    transaction(db, () => {
      const running = fencedUse(db, coordinator, 'Coordinator grant has no live workspace use')
      if (running.use.stage !== 'started')
        blocked(
          `The coordinator is not running in its workspace: ${running.use.id} (${running.use.stage})`
        )
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

export const validateGrant = (
  authority: WorkspaceAuthority,
  state: ConversationState,
  grant: WorkspaceGrant
): GrantLease => {
  if (grant.namespaceId !== authority.initialize())
    requireReview('Workspace grant belongs to another namespace')
  const lease = state.leases.get(grant.useId)
  if (lease === undefined || lease.released || !sameGrant(lease.grant, grant))
    requireReview('Workspace grant is stale or was not issued to this attachment')
  const scoped = isScoped(lease) ? lease : undefined
  const workspace = inDb(authority, grant.repositoryId, db => {
    const fenced = fencedUse(db, grant, 'Workspace grant has no matching durable use')
    if (
      !matchesGrant(fenced.use, grant) ||
      fenced.use.effect !== scoped?.kind ||
      fenced.use.withinUseId !== scoped?.withinUseId
    )
      requireReview('Workspace grant no longer matches its fenced use facts')
    if (!holdsCurrentAcquisition(db, grant))
      requireReview('Workspace grant is not the current reservation acquisition')
    return fenced.workspace
  })
  validateWorkspace(authority, workspace)
  return lease
}

export const validateDurableGrant = (
  authority: WorkspaceAuthority,
  grant: WorkspaceGrant
): void => {
  const namespace = authority.inspectExisting()
  if (namespace === undefined || namespace !== grant.namespaceId)
    requireReview('Workspace grant namespace is missing or differs')
  const repositories = authority.listRepositories()
  if (!repositories.some(repository => repository.id === grant.repositoryId))
    requireReview('Workspace grant repository is not registered')
  const workspace = inDb(authority, grant.repositoryId, db => {
    const fenced = fencedUse(db, grant, 'Workspace grant does not identify a durable use')
    if (!matchesGrant(fenced.use, grant))
      requireReview('Workspace grant does not match its fenced use record')
    const { stage } = fenced.use
    if (stage === 'quiescent' || stage === 'observed' || stage === 'unknown')
      requireReview(`Workspace use is no longer eligible for a child: ${stage}`)
    if (!holdsCurrentAcquisition(db, grant)) requireReview('Workspace grant acquisition is stale')
    return fenced.workspace
  })
  if (grant.checkout !== workspace.path || grant.origin !== workspace.origin)
    requireReview('Workspace grant checkout fields were altered')
  if (!isWithin(workspace.path, grant.cwd))
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
  grant: WorkspaceGrant,
  fact: WorkspaceExecutionFact
): void => {
  attachment.assertOpen()
  const { state } = attachment
  if (state.closing) blocked('Execution reporting is fenced during attachment closure')

  if (
    state.parked &&
    ['launch-intent', 'spawned', 'started', 'operation-started'].includes(fact.kind)
  )
    blocked('Starting an operation is fenced during a host transition')
  const lease = validateGrant(authority, state, grant)
  if (isScoped(lease)) {
    const owners = state.leaseAttachments.get(lease.useId)
    if (owners === undefined || !owners.has(attachment.token))
      requireReview('Scoped operation report was not issued to this attachment')
  }
  if (lease.kind === 'ordinary')
    invalid('Legacy workspace grants do not carry scoped operation authority')
  if (lease.kind === 'native-file-write') return reportScopedOperation(authority, lease, fact)
  if (fact.kind === 'operation-started' || fact.kind === 'operation-completed')
    invalid('Operation boundary facts are only valid for non-process scoped operations')
  const current = inDb(authority, lease.repositoryId, db => getUse(db, lease.useId))
  if (
    current === undefined ||
    current.execution === undefined ||
    !sameExecution(current.execution, lease.execution)
  )
    requireReview('Execution recovery row no longer matches the issued grant')
  if (current.stage === 'quiescent') requireReview('Execution has already been settled')
  const update = (value: UseRecord): void =>
    inDb(authority, lease.repositoryId, db => transaction(db, () => saveUse(db, value)))
  const updatedAt = now()
  switch (fact.kind) {
    case 'launch-intent': {
      if (!sameExecution(fact.execution, lease.execution))
        invalid('Launch intent does not match the authorized execution')
      if (current.stage !== 'authorized')
        requireReview(`Cannot record launch intent after ${current.stage}`)
      update({ ...current, stage: 'launch-intent', revision: current.revision + 1, updatedAt })
      return
    }
    case 'spawned': {
      if (current.stage !== 'launch-intent')
        requireReview(`Cannot record process identity after ${current.stage}`)
      update({
        ...current,
        stage: 'spawned',
        processes: [fact.process],
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
      update({
        ...current,
        stage: 'observed',
        processes: fact.processes,
        revision: current.revision + 1,
        updatedAt,
      })
      return
    }
    case 'unknown': {
      update({
        ...current,
        stage: 'unknown',
        reason: fact.reason,
        revision: current.revision + 1,
        updatedAt,
      })
      return
    }
    case 'launch-failed': {
      if (current.stage !== 'authorized' && current.stage !== 'launch-intent')
        requireReview(`A launch cannot be reported failed after ${current.stage}`)
      update({
        ...current,
        stage: 'quiescent',
        reason: `launch-failed: ${fact.reason}`,
        revision: current.revision + 1,
        updatedAt,
      })
      lease.released = true
      return
    }
    case 'quiescent': {
      if (current.stage !== 'observed' || current.processes.length > 0)
        requireReview(
          `Quiescence after ${current.stage} requires an observed empty process family first`
        )
      update({
        ...current,
        stage: 'quiescent',
        reason: fact.reason,
        revision: current.revision + 1,
        updatedAt,
      })
      lease.released = true
      return
    }
    default: {
      const exhaustive: never = fact
      return exhaustive
    }
  }
}

const reportScopedOperation = (
  authority: WorkspaceAuthority,
  lease: Extract<GrantLease, { readonly kind: 'native-file-write' }>,
  fact: WorkspaceExecutionFact
): void => {
  if (
    fact.kind !== 'operation-started' &&
    fact.kind !== 'operation-completed' &&
    fact.kind !== 'unknown'
  )
    invalid('Scoped native operations require operation boundary facts')
  const current = inDb(authority, lease.repositoryId, db => getUse(db, lease.useId))
  if (current === undefined || current.effect !== lease.kind)
    requireReview('Scoped operation lost its durable use record')
  const next = inDb(authority, lease.repositoryId, db =>
    transaction(db, () => {
      const latest = getUse(db, lease.useId)
      if (
        latest === undefined ||
        latest.revision !== current.revision ||
        latest.effect !== lease.kind ||
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
              ? `operation-ended-before-start:${lease.kind}`
              : `operation-completed:${lease.kind}`,
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
