import { inDb, type WorkspaceAuthority } from './workspace-authority.ts'
import {
  blocked,
  requireReview,
  type WorkspaceConversation,
  type WorkspaceExecution,
  type WorkspaceGrant,
  type WorkspaceHandoff,
  type WorkspaceOperation,
} from './workspace-domain.ts'
import type { PathGates } from './workspace-gates.ts'
import { getUse, type BindingRecord, type UseRecord } from './workspace-records.ts'

export interface GrantLease {
  readonly grant: WorkspaceGrant
  readonly repositoryId: string
  readonly useId: string
  readonly effect?: WorkspaceOperation['effect']
  readonly withinUseId?: string
  gates?: PathGates
  readonly borrowed: boolean
  readonly isExecution: boolean
  readonly execution?: WorkspaceExecution
  released: boolean
}
export interface GateIntent {
  readonly repositoryId: string
  readonly workspaceId: string
  readonly path: string
  readonly writer: boolean
}
export interface HeldPathGate extends GateIntent {
  readonly gates: PathGates
}
export interface PendingTransition {
  readonly handoff: WorkspaceHandoff
  readonly sourceRepositoryId: string
  readonly targetRepositoryId: string
  readonly targetBinding: BindingRecord
  readonly targetLease: GrantLease
  readonly previousWriteGrant: WorkspaceGrant | undefined
  phase: 'intent' | 'started' | 'confirmed' | 'cancelled' | 'unknown'
}
export interface ConversationState {
  readonly key: string
  readonly conversation: WorkspaceConversation
  binding: BindingRecord
  repositoryId: string
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
