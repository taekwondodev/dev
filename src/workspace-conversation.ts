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
import type { PathGates } from './workspace-gates.ts'
import type { GitWorkspace } from './workspace-git.ts'
import {
  activeDependentUses,
  getUse,
  saveUse,
  type BindingRecord,
  type UseRecord,
  type WorkspaceRecord,
} from './workspace-records.ts'
import { transaction } from './workspace-sqlite.ts'
import { now } from './workspace-platform.ts'

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

export const outgoingUses = (
  authority: WorkspaceAuthority,
  state: ConversationState,
  sourceWorkspaceId: WorkspaceId,
  excludeUseId?: WorkspaceId
): { readonly lease: GrantLease; readonly use: UseRecord }[] => {
  return [...state.leases.values()]
    .filter(lease => lease.grant.workspaceId === sourceWorkspaceId && lease.useId !== excludeUseId)
    .map(lease => {
      const use = inDb(authority, lease.repositoryId, db => getUse(db, lease.useId))
      if (use === undefined)
        requireReview(`Old workspace use disappeared during handoff: ${lease.useId}`)
      return { lease, use }
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
