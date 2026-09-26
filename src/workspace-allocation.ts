import { closeSync, constants, fchmodSync, fsyncSync, openSync } from 'node:fs'
import { basename, join } from 'node:path'
import { toGrant, inDb, validateWorkspace, type WorkspaceAuthority } from './workspace-authority.ts'
import {
  assertNoLiveExecution,
  type GrantLease,
  type GateIntent,
  type HeldPathGate,
  type PendingTransition,
  type ConversationState,
} from './workspace-conversation.ts'
import {
  requireReview,
  type WorkspaceAuthorization,
  type WorkspaceExecution,
  type WorkspaceHandoff,
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
  type GitWorkspace,
} from './workspace-git.ts'
import { canonicalPathSlot, lstatIfExists } from './workspace-paths.ts'
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
  type OperationRecord,
} from './workspace-records.ts'
import {
  workspaceId,
  now,
  errorText,
  fsyncPath,
  fsyncParent,
  privateDirectory,
  transaction,
} from './workspace-sqlite.ts'

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

const holdGates = (
  authority: WorkspaceAuthority,
  state: ConversationState,
  intents: readonly GateIntent[]
): void => {
  const groups = new Map<string, GateIntent>()
  for (const intent of intents) {
    const path = canonicalPathSlot(intent.path)
    const current = groups.get(path)
    groups.set(path, { ...intent, path, writer: intent.writer || current?.writer === true })
  }
  const acquired: HeldPathGate[] = []
  try {
    for (const group of [...groups.values()].toSorted((left, right) =>
      left.path.localeCompare(right.path)
    ))
      acquired.push({
        ...group,
        gates: acquirePathGates(authority.paths, group.path, group.writer),
      })
  } catch (cause) {
    for (const held of acquired.toReversed()) releaseGates(held.gates)
    throw cause
  }
  state.extraGates.push(...acquired)
}

const orderedAllocationGates = (
  authority: WorkspaceAuthority,
  state: ConversationState,
  sourceRepo: string,
  source: WorkspaceRecord,
  destination: string,
  intents: readonly GateIntent[]
): {
  readonly source: PathGates
  readonly target: PathGates
  readonly extras: readonly HeldPathGate[]
} => {
  const groups = new Map<string, GateIntent>()
  const add = (input: GateIntent): void => {
    const path = canonicalPathSlot(input.path)
    const current = groups.get(path)
    if (
      current !== undefined &&
      (current.repositoryId !== input.repositoryId || current.workspaceId !== input.workspaceId)
    )
      requireReview(`Conflicting workspace identities share one held path gate: ${path}`)
    groups.set(path, { ...input, path, writer: input.writer || current?.writer === true })
  }
  for (const intent of intents) add(intent)
  add({
    repositoryId: sourceRepo,
    workspaceId: source.id,
    path: source.path,
    writer:
      state.writeGrant?.workspaceId === source.id ||
      intents.some(intent => intent.workspaceId === source.id && intent.writer),
  })
  const targetPath = canonicalPathSlot(destination)
  add({
    repositoryId: sourceRepo,
    workspaceId: basename(destination),
    path: targetPath,
    writer: true,
  })

  for (const group of groups.values()) {
    if (group.path === targetPath) continue
    const record = inDb(authority, group.repositoryId, db => getWorkspace(db, group.workspaceId))
    if (record === undefined || record.path !== group.path)
      requireReview(`Workspace gate no longer matches its durable checkout: ${group.path}`)
    validateWorkspace(authority, record)
  }

  const acquired = new Map<string, PathGates>()
  try {
    for (const group of [...groups.values()].toSorted((left, right) =>
      left.path.localeCompare(right.path)
    ))
      acquired.set(group.path, acquirePathGates(authority.paths, group.path, group.writer))
  } catch (cause) {
    for (const gates of [...acquired.values()].reverse()) releaseGates(gates)
    throw cause
  }
  const sourceGates = acquired.get(source.path)
  const targetGates = acquired.get(targetPath)
  if (sourceGates === undefined || targetGates === undefined)
    requireReview('Workspace allocation gates were not acquired')
  const extras = [...groups.values()]
    .filter(group => group.path !== targetPath)
    .map(group => ({ ...group, gates: acquired.get(group.path) }))
    .filter((group): group is HeldPathGate => group.gates !== undefined)
  return { source: sourceGates, target: targetGates, extras }
}

export const allocateWorkspace = (
  authority: WorkspaceAuthority,
  state: ConversationState,
  sourceRepo: string,
  sourceWorkspace: WorkspaceRecord,
  sourceGit: GitWorkspace,
  taskId: string,
  delegated: boolean,
  execution?: WorkspaceExecution
): WorkspaceAuthorization => {
  const previousWriteGrant = state.writeGrant
  if (!delegated)
    assertNoLiveExecution(
      authority,
      state,
      { workspaceId: sourceWorkspace.id },
      'moved to a separate worktree'
    )
  const workspaceIdValue = workspaceId()
  const allocationId = workspaceId()
  const reservationId = workspaceId()
  const acquisitionId = workspaceId()
  const destinationParent = join(authority.paths.worktrees, sourceRepo)
  privateDirectory(authority.paths.worktrees, true)
  privateDirectory(destinationParent, true)
  const destination = join(destinationParent, workspaceIdValue)
  if (lstatIfExists(destination) !== undefined)
    requireReview(`Managed worktree destination already exists: ${destination}`)
  const targetSlot = canonicalPathSlot(destination)
  if (targetSlot !== destination)
    requireReview(`Managed worktree destination is not canonical: ${destination}`)

  // Taken before the local path gates are released: it never waits, so a contended
  // structure gate fails here with the conversation's admission intact.
  const structure = acquireStructureGate(authority.paths, sourceGit, sourceRepo)
  state.parked = true
  let gateIntents: GateIntent[] = []
  let pathGates:
    | {
        readonly source: PathGates
        readonly target: PathGates
        readonly extras: readonly HeldPathGate[]
      }
    | undefined
  let operation: OperationRecord | undefined
  try {
    gateIntents = releaseLocalGates(state)
    pathGates = orderedAllocationGates(
      authority,
      state,
      sourceRepo,
      sourceWorkspace,
      destination,
      gateIntents
    )
    state.extraGates.push(...pathGates.extras)
    const commit = currentCommit(sourceGit)
    operation = {
      id: allocationId,
      kind: 'allocation',
      phase: 'intent',
      repositoryId: sourceRepo,
      workspaceId: workspaceIdValue,
      taskId,
      reservationId,
      acquisitionId,
      sourceRepositoryId: sourceRepo,
      sourceWorkspaceId: sourceWorkspace.id,
      sourcePath: sourceWorkspace.path,
      sourceCommit: commit,
      targetPath: destination,
      conversationKey: state.key,
      expectedBindingRevision: state.binding.revision,
      reason: delegated ? 'delegated-writer' : 'checkout-contention',
      createdAt: now(),
    } satisfies OperationRecord
    inDb(authority, sourceRepo, db =>
      transaction(db, () => {
        const binding = getBinding(db, state.key)
        if (
          binding === undefined ||
          binding.revision !== state.binding.revision ||
          binding.workspaceId !== sourceWorkspace.id
        )
          requireReview('Conversation binding changed before worktree allocation')
        const task = getTask(db, taskId)
        if (task === undefined)
          putTask(db, { id: taskId, repositoryId: sourceRepo, revision: 0, createdAt: now() })
        putOperation(db, operation as OperationRecord)
      })
    )
    assertManagedCheckoutSupported(sourceGit, commit)
    operation = { ...operation, phase: 'started' }
    inDb(authority, sourceRepo, db =>
      transaction(db, () => saveOperation(db, operation as OperationRecord))
    )

    const createdGit = addDetachedWorktree(sourceGit, destination, commit)
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
      actual.commonPath !== sourceGit.commonPath ||
      !sameIdentity(actual.commonIdentity, sourceGit.commonIdentity)
    )
      requireReview(`Git did not publish the exact requested detached worktree: ${destination}`)
    const workspace = makeWorkspaceRecord(
      sourceRepo,
      actual,
      'managed',
      workspaceIdValue,
      allocationId
    )
    const reservation: ReservationRecord = {
      id: reservationId,
      taskId,
      workspaceId: workspaceIdValue,
      acquisitionId,
      revision: 0,
      createdAt: now(),
    }
    const use = {
      id: workspaceId(),
      workspaceId: workspaceIdValue,
      taskId,
      reservationId,
      acquisitionId,
      access: 'write',
      stage: 'authorized',
      ...(delegated && execution !== undefined ? { execution } : {}),
      processes: [],
      incarnation: state.incarnation,
      bindingRevision: state.binding.revision + (delegated ? 0 : 1),
      revision: 0,
      createdAt: now(),
      updatedAt: now(),
    } satisfies UseRecord
    const completed: OperationRecord = {
      ...operation,
      phase: 'confirmed',
      result: `Observed detached worktree at ${destination}`,
    }
    let targetBinding: BindingRecord | undefined
    let handoff: WorkspaceHandoff | undefined
    let handoffOperation: OperationRecord | undefined
    if (!delegated) {
      const handoffId = workspaceId()
      targetBinding = {
        ...state.binding,
        taskId,
        workspaceId: workspaceIdValue,
        cwd: destination,
        revision: state.binding.revision + 1,
        pendingOperationId: handoffId,
      }
      handoffOperation = {
        id: handoffId,
        kind: 'handoff',
        phase: 'intent',
        repositoryId: sourceRepo,
        workspaceId: workspaceIdValue,
        taskId,
        reservationId,
        acquisitionId,
        sourceRepositoryId: sourceRepo,
        sourceWorkspaceId: sourceWorkspace.id,
        sourcePath: sourceWorkspace.path,
        sourceCommit: commit,
        targetPath: destination,
        conversationKey: state.key,
        expectedBindingRevision: state.binding.revision,
        reason: 'isolate-contended-writer',
        createdAt: now(),
      }
      const grant = toGrant(authority, sourceRepo, workspace, use, destination, 'write')
      handoff = {
        operationId: handoffId,
        from: toBinding(state.binding),
        target: grant,
        reason:
          'Another task owns or is using the requested checkout. The new detached worktree starts at the exact current commit; uncommitted and ignored files were not copied.',
      }
      const targetLease: GrantLease = {
        grant,
        repositoryId: sourceRepo,
        useId: use.id,
        gates: pathGates.target,
        borrowed: false,
        isExecution: false,
        released: false,
      }
      state.leases.set(use.id, targetLease)
      state.writeGrant = grant
      inDb(authority, sourceRepo, db =>
        transaction(db, () => {
          putWorkspace(db, workspace)
          putReservation(db, reservation)
          putUse(db, use)
          saveOperation(db, completed)
          putOperation(db, handoffOperation as OperationRecord)
          const current = getBinding(db, state.key)
          if (current === undefined || current.revision !== state.binding.revision)
            requireReview('Conversation binding changed before handoff publication')
          putBinding(db, { ...current, pendingOperationId: handoffOperation?.id })
        })
      )
      const transition: PendingTransition = {
        handoff,
        sourceRepositoryId: sourceRepo,
        targetRepositoryId: sourceRepo,
        targetBinding,
        targetLease,
        previousWriteGrant,
        phase: 'intent',
      }
      state.pending = transition
      state.parked = true
      return { kind: 'rebind', handoff }
    }
    const grant = toGrant(authority, sourceRepo, workspace, use, destination, 'write')
    const lease: GrantLease = {
      grant,
      repositoryId: sourceRepo,
      useId: use.id,
      gates: pathGates.target,
      borrowed: false,
      isExecution: execution !== undefined,
      ...(execution === undefined ? {} : { execution }),
      released: false,
    }
    state.leases.set(use.id, lease)
    inDb(authority, sourceRepo, db =>
      transaction(db, () => {
        putWorkspace(db, workspace)
        putReservation(db, reservation)
        putUse(db, use)
        saveOperation(db, completed)
      })
    )
    state.parked = false
    return { kind: 'ready', grant }
  } catch (cause) {
    if (pathGates !== undefined) releaseGates(pathGates.target)
    if (operation?.phase === 'started') {
      const unresolved: OperationRecord = {
        ...operation,
        phase: 'review-required',
        result: `Allocation outcome requires observation: ${errorText(cause)}`,
      }
      try {
        inDb(authority, sourceRepo, db => transaction(db, () => saveOperation(db, unresolved)))
      } catch {
        /* retain the durable started intent */
      }
      state.parked = true
      throw cause
    }
    // No Git effect started, so the conversation keeps its binding and admission.
    if (operation !== undefined) {
      const stopped: OperationRecord = {
        ...operation,
        phase: 'cancelled',
        result: `Allocation stopped before any Git effect: ${errorText(cause)}`,
      }
      try {
        inDb(authority, sourceRepo, db => transaction(db, () => saveOperation(db, stopped)))
      } catch {
        /* an intent that was never recorded needs no result */
      }
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
    } catch {
      /* a failed release blocks later structural acquisition at the SQLite gate */
    }
  }
}
