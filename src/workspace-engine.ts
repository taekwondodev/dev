import { attachConversation, settleClosingState } from './workspace-attachment.ts'
import { WorkspaceAuthority } from './workspace-authority.ts'
import type { AttachmentHandle, ConversationState } from './workspace-conversation.ts'
import {
  blocked,
  WorkspaceError,
  type WorkspaceBinding,
  type WorkspaceConversation,
  type WorkspaceSelection,
} from './workspace-domain.ts'
import { toBinding } from './workspace-records.ts'
import { errorText } from './workspace-sqlite.ts'
import { newId } from './workspace-platform.ts'

// The worker's side of a client attachment; clients reach it through the lifecycle's RPC.
export class EngineAttachment implements AttachmentHandle {
  readonly state: ConversationState
  readonly token = newId()
  private readonly targetOperationId: string | undefined
  closed = false

  constructor(state: ConversationState, targetOperationId: string | undefined) {
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
  assertOpen(): void {
    if (this.closed) blocked('Workspace attachment is closed')
  }
}

const asWorkspaceError = (cause: unknown): WorkspaceError =>
  cause instanceof WorkspaceError
    ? cause
    : new WorkspaceError({
        outcome: 'unavailable',
        message: `Workspace authority operation failed: ${errorText(cause)}`,
      })

// Every failure leaves the engine as a WorkspaceError, the only error the RPC carries.
const attempt = <A>(work: () => A | Promise<A>): Promise<A> => {
  try {
    return Promise.resolve(work()).catch((cause: unknown) => {
      throw asWorkspaceError(cause)
    })
  } catch (cause) {
    return Promise.reject(asWorkspaceError(cause))
  }
}

export class WorkspaceEngine {
  private readonly authority: WorkspaceAuthority
  private readonly states = new Map<string, ConversationState>()
  private closed = false

  constructor(root: string) {
    this.authority = new WorkspaceAuthority(root)
  }

  run<A>(work: (authority: WorkspaceAuthority) => A | Promise<A>): Promise<A> {
    return attempt(() => {
      if (this.closed) blocked('Workspace lifecycle is closed')
      return work(this.authority)
    })
  }

  attach(input: {
    readonly conversation: WorkspaceConversation
    readonly cwd: string
    readonly selection?: WorkspaceSelection
  }): Promise<EngineAttachment> {
    return this.run(authority => {
      const attached = attachConversation(authority, this.states, input)
      return new EngineAttachment(attached.state, attached.targetOperationId)
    })
  }

  closeAttachment(attachment: EngineAttachment): Promise<void> {
    return attempt(() => {
      if (attachment.closed) return
      attachment.closed = true
      const { state } = attachment
      state.refs = Math.max(0, state.refs - 1)
      if (state.refs > 0) return
      settleClosingState(this.authority, state)
      if (state.pending !== undefined) return
      this.states.delete(state.key)
      state.releaseConversation()
    })
  }

  close(): Promise<void> {
    return attempt(() => {
      if (this.closed) return
      for (const state of this.states.values()) {
        settleClosingState(this.authority, state)
        state.releaseConversation()
      }
      this.closed = true
      this.authority.close()
    })
  }
}
