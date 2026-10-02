import { closeSync, constants, fchmodSync, fsyncSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { toGrant, inDb, validateWorkspace, type WorkspaceAuthority } from './workspace-authority.ts'
import {
  assertNoLiveExecution,
  type ConversationState,
  type CurrentSource,
  type GateIntent,
  type GrantLease,
  type HeldPathGate,
  type LeaseKind,
} from './workspace-conversation.ts'
import {
  requireReview,
  type WorkspaceAuthorization,
  type WorkspaceExecution,
  type WorkspaceHandoff,
  type AllocationReason,
  type WorkspaceId,
} from './workspace-domain.ts'
import {
  acquirePathGates,
  acquireStructureGate,
  releaseGates,
  type PathGates,
} from './workspace-gates.ts'
import {
  addDetachedWorktree,
  assertManagedCheckoutSupported,
  canonicalGitWorkspace,
  currentCommit,
} from './workspace-git.ts'
import { canonicalPathSlot } from './workspace-paths.ts'
import {
  sameIdentity,
  getTask,
  putTask,
  getWorkspace,
  putWorkspace,
  putReservation,
  getBinding,
  putBinding,
  putUse,
  putOperation,
  saveOperation,
  makeWorkspaceRecord,
  toBinding,
  type WorkspaceRecord,
  type ReservationRecord,
  type BindingRecord,
  type UseRecord,
  type TransitionOperationRecord,
} from './workspace-records.ts'
import { errorText } from './error-text.ts'
import { transaction } from './workspace-sqlite.ts'
import {
  newId,
  now,
  fsyncPath,
  fsyncParent,
  lstatIfExists,
  privateDirectory,
} from './workspace-platform.ts'

const releaseLocalGates = (state: ConversationState): GateIntent[] => {
  const intents: GateIntent[] = []
  for (const lease of state.leases.values()) {
    if (lease.gates === undefined) continue
    intents.push({
      repositoryId: lease.repositoryId,
      workspaceId: lease.grant.workspaceId,
      path: lease.grant.checkout,
      writer: lease.gates.writer !== undefined,
    })
    releaseGates(lease.gates)
    lease.gates = undefined
  }
  for (const held of state.extraGates.splice(0)) {
    intents.push({
      repositoryId: held.repositoryId,
      workspaceId: held.workspaceId,
      path: held.path,
      writer: held.gates.writer !== undefined,
    })
    releaseGates(held.gates)
  }
  return intents
}

const groupBySlot = (intents: readonly GateIntent[]): GateIntent[] => {
  const groups = new Map<string, GateIntent>()
  for (const intent of intents) {
    const path = canonicalPathSlot(intent.path)
    const current = groups.get(path)
    if (
      current !== undefined &&
      (current.repositoryId !== intent.repositoryId || current.workspaceId !== intent.workspaceId)
    )
      requireReview(`Conflicting workspace identities share one held path gate: ${path}`)
    groups.set(path, { ...intent, path, writer: intent.writer || current?.writer === true })
  }
  return [...groups.values()].toSorted((left, right) => left.path.localeCompare(right.path))
}

const acquireInOrder = (
  authority: WorkspaceAuthority,
  groups: readonly GateIntent[]
): HeldPathGate[] => {
  const acquired: HeldPathGate[] = []
  try {
    for (const group of groups)
      acquired.push({
        ...group,
        gates: acquirePathGates(authority.paths, group.path, group.writer ? 'writer' : 'reader'),
      })
  } catch (cause) {
    for (const held of acquired.toReversed()) releaseGates(held.gates)
    throw cause
  }
  return acquired
}

const holdGates = (
  authority: WorkspaceAuthority,
  state: ConversationState,
  intents: readonly GateIntent[]
): void => {
  state.extraGates.push(...acquireInOrder(authority, groupBySlot(intents)))
}

const orderedAllocationGates = (
  authority: WorkspaceAuthority,
  state: ConversationState,
  sourceRepo: WorkspaceId,
  source: WorkspaceRecord,
  target: { readonly id: WorkspaceId; readonly path: string },
  intents: readonly GateIntent[]
): {
  readonly source: PathGates
  readonly target: PathGates
  readonly extras: readonly HeldPathGate[]
} => {
  const targetPath = canonicalPathSlot(target.path)
  const groups = groupBySlot([
    ...intents,
    {
      repositoryId: sourceRepo,
      workspaceId: source.id,
      path: source.path,
      writer:
        state.writeGrant?.workspaceId === source.id ||
        intents.some(intent => intent.workspaceId === source.id && intent.writer),
    },
    { repositoryId: sourceRepo, workspaceId: target.id, path: targetPath, writer: true },
  ])
  for (const group of groups) {
    if (group.path === targetPath) continue
    const record = inDb(authority, group.repositoryId, db => getWorkspace(db, group.workspaceId))
    if (record === undefined || record.path !== group.path)
      requireReview(`Workspace gate no longer matches its durable checkout: ${group.path}`)
    validateWorkspace(authority, record)
  }
  const acquired = acquireInOrder(authority, groups)
  const sourceGates = acquired.find(held => held.path === source.path)?.gates
  const targetGates = acquired.find(held => held.path === targetPath)?.gates
  if (sourceGates === undefined || targetGates === undefined)
    requireReview('Workspace allocation gates were not acquired')
  return {
    source: sourceGates,
    target: targetGates,
    extras: acquired.filter(held => held.path !== targetPath),
  }
}

interface Allocation {
  readonly source: CurrentSource
  readonly taskId: WorkspaceId
  readonly workspace: WorkspaceRecord
  readonly reservation: ReservationRecord
  readonly intent: TransitionOperationRecord
  readonly confirmed: TransitionOperationRecord
  readonly gates: PathGates
}

const allocatedUse = (
  state: ConversationState,
  allocation: Allocation,
  bindingRevision: number,
  execution: WorkspaceExecution | undefined
): UseRecord => ({
  id: newId(),
  workspaceId: allocation.workspace.id,
  taskId: allocation.taskId,
  reservationId: allocation.reservation.id,
  acquisitionId: allocation.intent.acquisitionId,
  access: 'write',
  stage: 'authorized',
  ...(execution === undefined ? {} : { execution }),
  processes: [],
  incarnation: state.incarnation,
  bindingRevision,
  revision: 0,
  createdAt: now(),
  updatedAt: now(),
})

export type AllocationSweep = (
  authority: WorkspaceAuthority,
  repositoryId: WorkspaceId,
  state: ConversationState
) => void

const allocateWorktree = (
  authority: WorkspaceAuthority,
  state: ConversationState,
  source: CurrentSource,
  taskId: WorkspaceId,
  reason: AllocationReason,
  sweep: AllocationSweep,
  admitWriter: (allocation: Allocation) => WorkspaceAuthorization
): WorkspaceAuthorization => {
  sweep(authority, source.repo, state)
  const workspaceIdValue = newId()
  const allocationId = newId()
  const reservationId = newId()
  const acquisitionId = newId()
  const destinationParent = join(authority.paths.worktrees, source.repo)
  privateDirectory(authority.paths.worktrees, true)
  privateDirectory(destinationParent, true)
  const destination = join(destinationParent, workspaceIdValue)
  if (lstatIfExists(destination) !== undefined)
    requireReview(`Managed worktree destination already exists: ${destination}`)
  const targetSlot = canonicalPathSlot(destination)
  if (targetSlot !== destination)
    requireReview(`Managed worktree destination is not canonical: ${destination}`)

  const structure = acquireStructureGate(authority.paths, source.git, source.repo)
  state.parked = true
  let gateIntents: GateIntent[] = []
  let pathGates:
    | {
        readonly source: PathGates
        readonly target: PathGates
        readonly extras: readonly HeldPathGate[]
      }
    | undefined
  let operation: TransitionOperationRecord | undefined
  try {
    gateIntents = releaseLocalGates(state)
    pathGates = orderedAllocationGates(
      authority,
      state,
      source.repo,
      source.workspace,
      { id: workspaceIdValue, path: destination },
      gateIntents
    )
    state.extraGates.push(...pathGates.extras)
    const commit = currentCommit(source.git)
    const intent = {
      id: allocationId,
      kind: 'allocation',
      phase: 'intent',
      repositoryId: source.repo,
      workspaceId: workspaceIdValue,
      taskId,
      reservationId,
      acquisitionId,
      sourceRepositoryId: source.repo,
      sourceWorkspaceId: source.workspace.id,
      sourcePath: source.workspace.path,
      sourceCommit: commit,
      targetPath: destination,
      conversationKey: state.key,
      expectedBindingRevision: state.binding.revision,
      reason,
      createdAt: now(),
    } satisfies TransitionOperationRecord
    operation = intent
    inDb(authority, source.repo, db =>
      transaction(db, () => {
        const binding = getBinding(db, state.key)
        if (
          binding === undefined ||
          binding.revision !== state.binding.revision ||
          binding.workspaceId !== source.workspace.id
        )
          requireReview('Conversation binding changed before worktree allocation')
        const task = getTask(db, taskId)
        if (task === undefined)
          putTask(db, { id: taskId, repositoryId: source.repo, revision: 0, createdAt: now() })
        putOperation(db, intent)
      })
    )
    assertManagedCheckoutSupported(source.git, commit)
    const started: TransitionOperationRecord = { ...intent, phase: 'started' }
    operation = started
    inDb(authority, source.repo, db => transaction(db, () => saveOperation(db, started)))

    const createdGit = addDetachedWorktree(source.git, destination, commit)
    const rootFd = openSync(
      createdGit.path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    )
    try {
      fchmodSync(rootFd, 0o700)
      fsyncSync(rootFd)
    } finally {
      closeSync(rootFd)
    }
    fsyncParent(createdGit.path)
    fsyncPath(createdGit.gitAdminPath, true)
    fsyncParent(createdGit.gitAdminPath)
    const actual = canonicalGitWorkspace(destination)
    if (
      actual.head !== commit ||
      actual.commonPath !== source.git.commonPath ||
      actual.commonDevice !== source.git.commonDevice ||
      !sameIdentity(actual.commonIdentity, source.git.commonIdentity)
    )
      requireReview(`Git did not publish the exact requested detached worktree: ${destination}`)
    return admitWriter({
      source,
      taskId,
      workspace: makeWorkspaceRecord(
        source.repo,
        actual,
        'managed',
        workspaceIdValue,
        allocationId
      ),
      reservation: {
        id: reservationId,
        taskId,
        workspaceId: workspaceIdValue,
        acquisitionId,
        revision: 0,
        createdAt: now(),
      },
      intent,
      confirmed: {
        ...started,
        phase: 'confirmed',
        result: `Observed detached worktree at ${destination}`,
      },
      gates: pathGates.target,
    })
  } catch (cause) {
    if (pathGates !== undefined) releaseGates(pathGates.target)
    if (operation?.phase === 'started') {
      const unresolved: TransitionOperationRecord = {
        ...operation,
        phase: 'review-required',
        result: `Allocation outcome requires observation: ${errorText(cause)}`,
      }
      try {
        inDb(authority, source.repo, db => transaction(db, () => saveOperation(db, unresolved)))
      } catch {}
      state.parked = true
      throw cause
    }

    if (operation !== undefined) {
      const stopped: TransitionOperationRecord = {
        ...operation,
        phase: 'cancelled',
        result: `Allocation stopped before any Git effect: ${errorText(cause)}`,
      }
      try {
        inDb(authority, source.repo, db => transaction(db, () => saveOperation(db, stopped)))
      } catch {}
    }
    try {
      if (pathGates === undefined) holdGates(authority, state, gateIntents)
      state.parked = false
    } catch {
      state.parked = true
    }
    throw cause
  } finally {
    try {
      structure()
    } catch {}
  }
}

export const allocateDelegatedWorkspace = (
  authority: WorkspaceAuthority,
  state: ConversationState,
  source: CurrentSource,
  taskId: WorkspaceId,
  execution: WorkspaceExecution | undefined,
  sweep: AllocationSweep
): WorkspaceAuthorization =>
  allocateWorktree(authority, state, source, taskId, 'delegated-writer', sweep, allocation => {
    const use = allocatedUse(state, allocation, state.binding.revision, execution)
    const grant = toGrant(
      authority,
      source.repo,
      allocation.workspace,
      use,
      allocation.intent.targetPath,
      'write'
    )
    const kind: LeaseKind =
      execution === undefined ? { kind: 'ordinary' } : { kind: 'execution', execution }
    state.leases.set(use.id, {
      ...kind,
      grant,
      repositoryId: source.repo,
      useId: use.id,
      gates: allocation.gates,
      released: false,
    })
    inDb(authority, source.repo, db =>
      transaction(db, () => {
        putWorkspace(db, allocation.workspace)
        putReservation(db, allocation.reservation)
        putUse(db, use)
        saveOperation(db, allocation.confirmed)
      })
    )
    state.parked = false
    return { kind: 'ready', grant }
  })

export const isolateContendedWriter = (
  authority: WorkspaceAuthority,
  state: ConversationState,
  source: CurrentSource,
  taskId: WorkspaceId,
  sweep: AllocationSweep
): WorkspaceAuthorization => {
  const previousWriteGrant = state.writeGrant
  assertNoLiveExecution(
    authority,
    state,
    { workspaceId: source.workspace.id },
    'moved to a separate worktree'
  )
  return allocateWorktree(
    authority,
    state,
    source,
    taskId,
    'checkout-contention',
    sweep,
    allocation => {
      const destination = allocation.intent.targetPath
      const handoffOperation: TransitionOperationRecord = {
        ...allocation.intent,
        id: newId(),
        kind: 'handoff',
        reason: 'isolate-contended-writer',
        createdAt: now(),
      }
      const targetBinding: BindingRecord = {
        ...state.binding,
        taskId,
        workspaceId: allocation.workspace.id,
        cwd: destination,
        revision: state.binding.revision + 1,
        pendingOperationId: handoffOperation.id,
      }
      const use = allocatedUse(state, allocation, targetBinding.revision, undefined)
      const grant = toGrant(authority, source.repo, allocation.workspace, use, destination, 'write')
      const handoff: WorkspaceHandoff = {
        operationId: handoffOperation.id,
        from: toBinding(state.binding),
        target: grant,
        reason:
          'Another task owns or is using the requested checkout. The new detached worktree starts at the exact current commit; uncommitted and ignored files were not copied',
      }
      const targetLease: GrantLease = {
        grant,
        repositoryId: source.repo,
        useId: use.id,
        gates: allocation.gates,
        kind: 'ordinary',
        released: false,
      }
      state.leases.set(use.id, targetLease)
      state.writeGrant = grant
      inDb(authority, source.repo, db =>
        transaction(db, () => {
          putWorkspace(db, allocation.workspace)
          putReservation(db, allocation.reservation)
          putUse(db, use)
          saveOperation(db, allocation.confirmed)
          putOperation(db, handoffOperation)
          const current = getBinding(db, state.key)
          if (current === undefined || current.revision !== state.binding.revision)
            requireReview('Conversation binding changed before handoff publication')
          putBinding(db, { ...current, pendingOperationId: handoffOperation.id })
        })
      )
      state.pending = {
        handoff,
        sourceRepositoryId: source.repo,
        targetRepositoryId: source.repo,
        targetBinding,
        targetLease,
        previousWriteGrant,
        phase: 'intent',
      }
      state.parked = true
      return { kind: 'rebind', handoff }
    }
  )
}
