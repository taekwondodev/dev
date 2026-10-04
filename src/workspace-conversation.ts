import { inDb, type WorkspaceAuthority } from './workspace-authority.ts'
import {
  blocked,
  requireReview,
  type BoundConversation,
  type WorkspaceExecution,
  type WorkspaceGrant,
  type WorkspaceHandoff,
  type WorkspaceId,
} from './workspace-domain.ts'
import { releaseGates, type PathGates } from './workspace-gates.ts'
import type { GitWorkspace } from './workspace-git.ts'
import {
  activeDependentUses,
  getUse,
  isActiveUse,
  saveUse,
  type BindingRecord,
  type UseRecord,
  type WorkspaceRecord,
} from './workspace-records.ts'
import { transaction } from './workspace-sqlite.ts'
import { now } from './workspace-platform.ts'
import { errorText } from './error-text.ts'

export type LeaseKind =
  | { readonly kind: 'ordinary' }
  | { readonly kind: 'execution'; readonly execution: WorkspaceExecution }
  | { readonly kind: 'native-file-write'; readonly withinUseId: WorkspaceId }
  | {
      readonly kind: 'opaque'
      readonly withinUseId: WorkspaceId
      readonly execution: WorkspaceExecution
    }
export type GrantLease = LeaseKind & {
  readonly grant: WorkspaceGrant
  readonly repositoryId: WorkspaceId
  readonly useId: WorkspaceId
  gates?: PathGates
  released: boolean
}
export type ScopedLease = Extract<GrantLease, { readonly withinUseId: WorkspaceId }>
export const isScoped = (lease: GrantLease): lease is ScopedLease =>
  lease.kind === 'native-file-write' || lease.kind === 'opaque'
export interface CurrentSource {
  readonly repo: WorkspaceId
  readonly binding: BindingRecord
  readonly workspace: WorkspaceRecord
  readonly git: GitWorkspace
}
export interface GateIntent {
  readonly repositoryId: WorkspaceId
  readonly workspaceId: WorkspaceId
  readonly path: string
  readonly writer: boolean
}
export type GateWorkspace = Pick<WorkspaceGrant, 'repositoryId' | 'workspaceId'>
export interface HeldPathGate extends GateIntent {
  readonly gates: PathGates
}
export interface PendingTransition {
  readonly handoff: WorkspaceHandoff
  readonly sourceRepositoryId: WorkspaceId
  readonly targetRepositoryId: WorkspaceId
  readonly targetBinding: BindingRecord
  readonly targetLease: GrantLease
  readonly previousWriteGrant: WorkspaceGrant | undefined
  phase: 'intent' | 'started' | 'confirmed' | 'cancelled' | 'unknown'
}
export interface ConversationState {
  readonly key: string
  readonly conversation: BoundConversation
  binding: BindingRecord
  repositoryId: WorkspaceId
  readonly leases: Map<WorkspaceId, GrantLease>
  readonly leaseAttachments: Map<WorkspaceId, Set<WorkspaceId>>
  readonly extraGates: HeldPathGate[]
  readonly deferredGateReleases: Map<string, GateWorkspace>
  refs: number
  parked: boolean
  closing: boolean
  pending?: PendingTransition
  writeGrant?: WorkspaceGrant
  readonly incarnation: WorkspaceId
  readonly releaseConversation: () => void
}

export interface AttachmentHandle {
  readonly state: ConversationState
  readonly token: WorkspaceId
  assertOpen(): void
}

export const conversationWorkspaces = (state: ConversationState): ReadonlySet<WorkspaceId> =>
  new Set([
    state.binding.workspaceId,
    ...(state.pending === undefined ? [] : [state.pending.targetBinding.workspaceId]),
    ...[...state.leases.values()].map(lease => lease.grant.workspaceId),
    ...state.extraGates.map(held => held.workspaceId),
  ])

const assertPrunedLeaseSettled = (lease: GrantLease): void => {
  if (!lease.released && (lease.kind === 'execution' || lease.kind === 'opaque'))
    requireReview(`Workspace use disappeared while its execution was live: ${lease.useId}`)
}

const forgetPrunedLease = (state: ConversationState, lease: GrantLease): void => {
  lease.released = true
  state.leases.delete(lease.useId)
  state.leaseAttachments.delete(lease.useId)
}

const releaseQuiescentWorkspaceGates = (
  authority: WorkspaceAuthority,
  state: ConversationState,
  workspace: GateWorkspace
): readonly unknown[] => {
  const matches = (repositoryId: WorkspaceId, workspaceId: WorkspaceId): boolean =>
    repositoryId === workspace.repositoryId && workspaceId === workspace.workspaceId
  const { pending } = state
  if (
    matches(state.repositoryId, state.binding.workspaceId) ||
    (pending !== undefined &&
      (matches(pending.sourceRepositoryId, pending.handoff.from.workspaceId) ||
        matches(pending.targetRepositoryId, pending.targetBinding.workspaceId)))
  )
    return []
  const leases = [...state.leases.values()].filter(lease =>
    matches(lease.repositoryId, lease.grant.workspaceId)
  )
  const pruned: GrantLease[] = []
  const quiescent = inDb(authority, workspace.repositoryId, db =>
    leases.every(lease => {
      const use = getUse(db, lease.useId)
      if (use === undefined) {
        assertPrunedLeaseSettled(lease)
        pruned.push(lease)
        return true
      }
      if (use.workspaceId !== workspace.workspaceId || use.incarnation !== state.incarnation)
        requireReview(`Workspace gate lost its owning use: ${lease.useId}`)
      return !isActiveUse(use)
    })
  )
  if (!quiescent) return []
  const failures: unknown[] = []
  const released = (gates: PathGates): boolean => {
    try {
      releaseGates(gates)
      return true
    } catch (cause) {
      failures.push(cause)
      return false
    }
  }
  for (const lease of leases) {
    if (lease.gates !== undefined && released(lease.gates)) lease.gates = undefined
  }
  for (const lease of pruned) {
    if (lease.gates === undefined) forgetPrunedLease(state, lease)
  }
  for (let index = state.extraGates.length - 1; index >= 0; index--) {
    const held = state.extraGates[index]
    if (held !== undefined && matches(held.repositoryId, held.workspaceId) && released(held.gates))
      state.extraGates.splice(index, 1)
  }
  return failures
}

const gateWorkspaceKey = (workspace: GateWorkspace): string =>
  `${workspace.repositoryId}/${workspace.workspaceId}`

export const settleWorkspaceGates = (
  authority: WorkspaceAuthority,
  state: ConversationState,
  workspace: GateWorkspace
): string | undefined => {
  const key = gateWorkspaceKey(workspace)
  state.deferredGateReleases.delete(key)
  const failures = releaseQuiescentWorkspaceGates(authority, state, workspace)
  if (failures.length === 0) return undefined
  state.deferredGateReleases.set(key, {
    repositoryId: workspace.repositoryId,
    workspaceId: workspace.workspaceId,
  })
  return `Workspace gate release deferred; the lead retries it at its next workspace admission or execution report and releases it at close: ${failures.map(errorText).join('; ')}`
}

export const retryDeferredGateReleases = (
  authority: WorkspaceAuthority,
  state: ConversationState
): string[] =>
  [...state.deferredGateReleases.values()].flatMap(workspace => {
    const warning = settleWorkspaceGates(authority, state, workspace)
    return warning === undefined ? [] : [warning]
  })

const dropPrunedLeases = (
  authority: WorkspaceAuthority,
  state: ConversationState,
  workspaceId: WorkspaceId,
  excludeUseId?: WorkspaceId
): void => {
  for (const lease of state.leases.values()) {
    if (lease.grant.workspaceId !== workspaceId || lease.useId === excludeUseId) continue
    if (inDb(authority, lease.repositoryId, db => getUse(db, lease.useId)) !== undefined) continue
    assertPrunedLeaseSettled(lease)
    if (lease.gates !== undefined) {
      releaseGates(lease.gates)
      lease.gates = undefined
    }
    forgetPrunedLease(state, lease)
  }
}

export const outgoingUses = (
  authority: WorkspaceAuthority,
  state: ConversationState,
  sourceWorkspaceId: WorkspaceId,
  excludeUseId?: WorkspaceId
): { readonly lease: GrantLease; readonly use: UseRecord }[] => {
  dropPrunedLeases(authority, state, sourceWorkspaceId, excludeUseId)
  return [...state.leases.values()]
    .filter(lease => lease.grant.workspaceId === sourceWorkspaceId && lease.useId !== excludeUseId)
    .flatMap(lease => {
      const use = inDb(authority, lease.repositoryId, db => getUse(db, lease.useId))
      return use === undefined ? [] : [{ lease, use }]
    })
}

export type UseSettlement = Pick<UseRecord, 'stage' | 'reason'>

export const settleDependentsFirst = (
  authority: WorkspaceAuthority,
  entries: readonly { readonly lease: GrantLease; readonly use: UseRecord }[],
  settlementOf: (use: UseRecord) => UseSettlement,
  dependentsReason: string,
  onFailure: (cause: unknown) => void = cause => {
    throw cause
  }
): void => {
  for (const { lease, use } of entries.toReversed()) {
    if (use.stage === 'quiescent' || use.stage === 'unknown') continue
    const settlement = settlementOf(use)
    try {
      inDb(authority, lease.repositoryId, db =>
        transaction(db, () => {
          const dependents = settlement.stage === 'quiescent' ? activeDependentUses(db, use.id) : []
          const settled: UseSettlement =
            dependents.length === 0
              ? settlement
              : {
                  stage: 'unknown',
                  reason: `${dependentsReason}: ${dependents.map(dependent => dependent.id).join(', ')}`,
                }
          saveUse(db, { ...use, ...settled, revision: use.revision + 1, updatedAt: now() })
        })
      )
    } catch (cause) {
      onFailure(cause)
    }
  }
}

export const assertNoLiveExecution = (
  authority: WorkspaceAuthority,
  state: ConversationState,
  source: { readonly workspaceId: WorkspaceId },
  action: string
): void => {
  const live = outgoingUses(authority, state, source.workspaceId).find(
    ({ use }) => use.execution !== undefined && use.stage !== 'quiescent' && use.stage !== 'unknown'
  )
  if (live !== undefined)
    blocked(
      `This conversation still runs ${live.use.execution?.taskKey ?? 'a process'} (${live.use.stage}) in its workspace, so it cannot be ${action} yet. Wait for it to finish or stop it with /work stop.`
    )
}
