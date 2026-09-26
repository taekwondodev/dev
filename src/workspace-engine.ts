import {
  claimGrant,
  authorizeOperation,
  validateDurableGrant,
  reportExecutionFact,
} from './workspace-admission.ts'
import { attachConversation, settleClosingState } from './workspace-attachment.ts'
import { WorkspaceAuthority } from './workspace-authority.ts'
import type { ConversationState } from './workspace-conversation.ts'
import {
  blocked,
  unavailable,
  WorkspaceError,
  type WorkspaceAuthorization,
  type WorkspaceBinding,
  type WorkspaceConversation,
  type WorkspaceExecutionFact,
  type WorkspaceGrant,
  type WorkspaceHandoff,
  type WorkspaceOperation,
  type WorkspaceSelection,
  type WorkspaceView,
} from './workspace-domain.ts'
import { inspectWorkspaces } from './workspace-inspect.ts'
import { toBinding } from './workspace-records.ts'
import { workspaceId, errorText } from './workspace-sqlite.ts'
import { selectWorkspace, performHandoff } from './workspace-transitions.ts'

// The worker's side of an attachment; clients reach it through the lifecycle's RPC.
export type EngineAttachment = WorkspaceAttachmentImpl

class WorkspaceAttachmentImpl {
  private readonly engine: WorkspaceEngine
  readonly state: ConversationState
  readonly token = workspaceId()
  readonly targetOperationId?: string
  private done = false

  constructor(engine: WorkspaceEngine, state: ConversationState, targetOperationId?: string) {
    this.engine = engine
    this.state = state
    this.targetOperationId = targetOperationId
    state.refs += 1
  }

  get binding(): WorkspaceBinding {
    const pending = this.state.pending
    return toBinding(
      pending !== undefined && this.targetOperationId === pending.handoff.operationId
        ? pending.targetBinding
        : this.state.binding
    )
  }
  authorize(operation: WorkspaceOperation): Promise<WorkspaceAuthorization> {
    return this.engine.authorize(this, operation)
  }
  select(selection: WorkspaceSelection): Promise<WorkspaceHandoff> {
    return this.engine.select(this, selection)
  }
  reportExecution(grant: WorkspaceGrant, fact: WorkspaceExecutionFact): Promise<void> {
    return this.engine.reportExecution(this, grant, fact)
  }
  handoff(
    transition: WorkspaceHandoff,
    replace: (target: WorkspaceGrant) => Promise<'confirmed' | 'cancelled'>
  ): Promise<void> {
    return this.engine.handoff(this, transition, replace)
  }
  close(): Promise<void> {
    if (this.done) return Promise.resolve()
    this.done = true
    return this.engine.closeAttachment(this)
  }
  assertOpen(): void {
    if (this.done) blocked('Workspace attachment is closed')
  }
}

export class WorkspaceEngine {
  private readonly authority: WorkspaceAuthority
  private readonly states = new Map<string, ConversationState>()
  private lifecycleClosed = false

  constructor(root: string) {
    this.authority = new WorkspaceAuthority(root)
  }

  private reject(cause: unknown): Promise<never> {
    try {
      this.translate(cause)
    } catch (translated) {
      return Promise.reject(translated)
    }
    return Promise.reject(new Error('Unreachable workspace error translation'))
  }
  private guard<A>(work: () => A | Promise<A>): Promise<A> {
    try {
      this.ensureOpen()
      return Promise.resolve(work()).catch(cause => this.translate(cause))
    } catch (cause) {
      return this.reject(cause)
    }
  }
  private translate(cause: unknown): never {
    if (cause instanceof WorkspaceError) throw cause
    unavailable(`Workspace authority operation failed: ${errorText(cause)}`)
  }
  private ensureOpen(): void {
    if (this.lifecycleClosed) blocked('Workspace lifecycle is closed')
  }

  attach(input: {
    conversation: WorkspaceConversation
    cwd: string
    selection?: WorkspaceSelection
  }): Promise<EngineAttachment> {
    return this.guard(() => {
      const attached = attachConversation(this.authority, this.states, input)
      return new WorkspaceAttachmentImpl(this, attached.state, attached.targetOperationId)
    })
  }

  authorize(
    attachment: WorkspaceAttachmentImpl,
    operation: WorkspaceOperation
  ): Promise<WorkspaceAuthorization> {
    return this.guard(() => {
      const result = authorizeOperation(this.authority, attachment, operation)
      if (result.kind === 'ready') claimGrant(attachment, result.grant)
      return result
    })
  }

  validate(input: WorkspaceGrant): Promise<void> {
    return this.guard(() => validateDurableGrant(this.authority, input))
  }

  reportExecution(
    attachment: WorkspaceAttachmentImpl,
    input: WorkspaceGrant,
    fact: WorkspaceExecutionFact
  ): Promise<void> {
    return this.guard(() => reportExecutionFact(this.authority, attachment, input, fact))
  }

  select(
    attachment: WorkspaceAttachmentImpl,
    selection: WorkspaceSelection
  ): Promise<WorkspaceHandoff> {
    return this.guard(() => selectWorkspace(this.authority, attachment, selection))
  }

  handoff(
    attachment: WorkspaceAttachmentImpl,
    transition: WorkspaceHandoff,
    replace: (target: WorkspaceGrant) => Promise<'confirmed' | 'cancelled'>
  ): Promise<void> {
    return this.guard(() => performHandoff(this.authority, attachment, transition, replace))
  }

  inspect(input: { cwd?: string; taskId?: string }): Promise<readonly WorkspaceView[]> {
    return this.guard(() => inspectWorkspaces(this.authority, input))
  }

  closeAttachment(attachment: WorkspaceAttachmentImpl): Promise<void> {
    try {
      const state = attachment.state
      state.refs = Math.max(0, state.refs - 1)
      if (state.refs > 0) return Promise.resolve()
      settleClosingState(this.authority, state, state.pending)
      if (state.pending === undefined) {
        this.states.delete(state.key)
        state.releaseConversation()
      } else state.closing = false
      return Promise.resolve()
    } catch (cause) {
      return this.reject(cause)
    }
  }

  close(): Promise<void> {
    if (this.lifecycleClosed) return Promise.resolve()
    try {
      for (const state of this.states.values()) {
        settleClosingState(this.authority, state, state.pending)
        state.releaseConversation()
      }
      this.lifecycleClosed = true
      this.authority.close()
      return Promise.resolve()
    } catch (cause) {
      return this.reject(cause)
    }
  }
}
