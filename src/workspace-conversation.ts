import { inDb, type WorkspaceAuthority } from './workspace-authority.ts'
import {
  blocked,
  requireReview,
  type WorkspaceConversation,
  type WorkspaceExecution,
  type WorkspaceGrant,
  type WorkspaceHandoff,
  type WorkspaceId,
} from './workspace-domain.ts'
import type { PathGates } from './workspace-gates.ts'
import {
  activeDependentUses,
  getUse,
  saveUse,
  type BindingRecord,
  type UseRecord,
} from './workspace-records.ts'
import { now, transaction } from './workspace-sqlite.ts'

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
  readonly conversation: WorkspaceConversation
  binding: BindingRecord
  repositoryId: WorkspaceId
  readonly leases: Map<string, GrantLease>
  readonly leaseAttachments: Map<string, Set<string>>
  readonly extraGates: HeldPathGate[]
  refs: number
  parked: boolean
  closing: boolean
  pending?: PendingTransition
  writeGrant?: WorkspaceGrant
  readonly incarnation: string
  readonly releaseConversation: () => void
}

export interface AttachmentHandle {
  readonly state: ConversationState
  readonly token: string
  assertOpen(): void
}

export const outgoingUses = (
  authority: WorkspaceAuthority,
  state: ConversationState,
  sourceWorkspaceId: string,
  excludeUseId?: string
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

// Dependents first: a use is created after its `within` parent, so reverse insertion order
// settles descendants before the parent whose gates they write under. A parent whose
// dependent is still live is left `unknown` instead of claimed quiescent.
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

// A process of this conversation still running in the workspace it would leave cannot
// report its cessation once the move releases its leases, so the move waits for it.
export const assertNoLiveExecution = (
  authority: WorkspaceAuthority,
  state: ConversationState,
  source: { readonly workspaceId: string },
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
