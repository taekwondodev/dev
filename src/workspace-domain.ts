import { Schema } from 'effect'

export const WorkspaceId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/)
)

export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()('WorkspaceError', {
  outcome: Schema.Literals(['blocked', 'review-required', 'invalid', 'unavailable', 'ambiguous']),
  message: Schema.String,
}) {}

export interface WorkspaceConversation {
  readonly sessionId: string
  readonly sessionFile: string
  readonly dataHome: string
}

export interface WorkspaceSelection {
  readonly taskId: string
  readonly workspaceId?: string
}

export interface WorkspaceExecution {
  readonly sessionId: string
  readonly taskKey: string
  readonly attemptId: string
  readonly generation: string
  readonly logs?: string
}

export const WorkspaceProcessSchema = Schema.Struct({
  pid: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  parent: Schema.Int,
  group: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  birth: Schema.NonEmptyString,
})
export type WorkspaceProcess = typeof WorkspaceProcessSchema.Type

export const WorkspaceEffectSchema = Schema.Literals(['native-read', 'native-file-write', 'opaque'])
export type WorkspaceEffect = typeof WorkspaceEffectSchema.Type

export const WorkspaceGrantSchema = Schema.Struct({
  namespaceId: WorkspaceId,
  repositoryId: WorkspaceId,
  workspaceId: WorkspaceId,
  useId: WorkspaceId,
  acquisitionId: Schema.optional(WorkspaceId),
  reservationId: Schema.optional(WorkspaceId),
  taskId: Schema.optional(WorkspaceId),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  cwd: Schema.NonEmptyString,
  checkout: Schema.NonEmptyString,
  access: Schema.Literals(['read', 'write']),
  origin: Schema.Literals(['pre-existing', 'managed']),
  // The destination the authority validated for a native file write. The executor opens
  // its own operand, so operands that could resolve elsewhere are refused.
  path: Schema.optional(Schema.NonEmptyString),
})
export type WorkspaceGrant = typeof WorkspaceGrantSchema.Type

export interface WorkspaceBinding {
  readonly conversation: WorkspaceConversation
  readonly taskId?: string
  readonly workspaceId: string
  readonly cwd: string
  readonly revision: number
}

// The host consumes this once, after settling the entire old tool batch.
// A persisted operation alone never authorizes replay of the host transition.
export interface WorkspaceHandoff {
  readonly operationId: string
  readonly from: WorkspaceBinding
  readonly target: WorkspaceGrant
  readonly reason: string
}

export type WorkspaceAuthorization =
  | { readonly kind: 'ready'; readonly grant: WorkspaceGrant; readonly warning?: string }
  | { readonly kind: 'rebind'; readonly handoff: WorkspaceHandoff }

export interface WorkspaceOperation {
  readonly access: 'read' | 'write'
  readonly effect?: WorkspaceEffect
  readonly within?: WorkspaceGrant
  readonly path?: string
  readonly cwd?: string
  readonly delegated?: boolean
  readonly execution?: WorkspaceExecution
}

export type WorkspaceExecutionFact =
  | { readonly kind: 'launch-intent'; readonly execution: WorkspaceExecution }
  | { readonly kind: 'spawned'; readonly process: WorkspaceProcess }
  | { readonly kind: 'started' }
  | { readonly kind: 'observed'; readonly processes: readonly WorkspaceProcess[] }
  | { readonly kind: 'quiescent'; readonly reason: string }
  | { readonly kind: 'launch-failed'; readonly reason: string }
  | { readonly kind: 'unknown'; readonly reason: string }
  | { readonly kind: 'operation-started' }
  | { readonly kind: 'operation-completed' }

export interface WorkspaceView {
  readonly repositoryId: string
  readonly taskId?: string
  readonly taskLabel?: string
  readonly workspaceId: string
  readonly path: string
  readonly origin: 'pre-existing' | 'managed'
  readonly reservationId?: string
  readonly outcome: 'active' | 'preserved-for-resume' | 'blocked' | 'review-required'
  readonly reason: string
  readonly nextAction: string
  readonly uses: readonly {
    readonly id: string
    readonly access: 'read' | 'write'
    readonly stage: string
    readonly effect?: WorkspaceEffect
    readonly path?: string
    readonly reason?: string
    readonly execution?: WorkspaceExecution
    readonly logsAvailable?: boolean
  }[]
  readonly pending: readonly {
    readonly id: string
    readonly kind: string
    readonly stage: string
  }[]
}

export interface WorkspaceAttachment {
  readonly binding: WorkspaceBinding
  authorize(operation: WorkspaceOperation): Promise<WorkspaceAuthorization>
  select(selection: WorkspaceSelection): Promise<WorkspaceHandoff>
  reportExecution(grant: WorkspaceGrant, fact: WorkspaceExecutionFact): Promise<void>
  // Runs outside Pi callbacks. The lifecycle owns intent/start/result publication;
  // the callback owns quiescence, runtime replacement and observed host outcome.
  handoff(
    transition: WorkspaceHandoff,
    replace: (target: WorkspaceGrant) => Promise<'confirmed' | 'cancelled'>
  ): Promise<void>
  close(): Promise<void>
}

export interface WorkspaceLifecycle {
  // Only a caller that already holds the conversation's claim may withdraw its switch.
  attach(input: {
    readonly conversation: WorkspaceConversation
    readonly cwd: string
    readonly selection?: WorkspaceSelection
    readonly withdrawUnstartedSwitch?: boolean
  }): Promise<WorkspaceAttachment>
  inspect(input: {
    readonly cwd?: string
    readonly taskId?: string
  }): Promise<readonly WorkspaceView[]>
  // A child verifies the parent's fenced use; it must not acquire a competing writer.
  validate(grant: WorkspaceGrant): Promise<void>
  close(): Promise<void>
}
