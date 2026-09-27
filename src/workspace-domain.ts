import { isAbsolute } from 'node:path'
import { type Effect, Schema } from 'effect'

export const WorkspaceId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/)
).pipe(Schema.brand('WorkspaceId'))
export type WorkspaceId = typeof WorkspaceId.Type

export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()('WorkspaceError', {
  outcome: Schema.Literals([
    'blocked',
    'review-required',
    'invalid',
    'unavailable',
    'ambiguous',
    'closed',
  ]),
  message: Schema.String,
}) {}

export const attachmentClosed = (): WorkspaceError =>
  new WorkspaceError({ outcome: 'closed', message: 'Workspace attachment is closed' })

export function fail(outcome: WorkspaceError['outcome'], message: string): never {
  throw new WorkspaceError({ outcome, message })
}
export function invalid(message: string): never {
  return fail('invalid', message)
}
export function unavailable(message: string): never {
  return fail('unavailable', message)
}
export function blocked(message: string): never {
  return fail('blocked', message)
}
export function requireReview(message: string): never {
  return fail('review-required', message)
}
export function ambiguous(message: string): never {
  return fail('ambiguous', message)
}

export const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const AbsolutePath = Schema.NonEmptyString.check(
  Schema.makeFilter(value =>
    isAbsolute(value) && !value.includes('\0') ? undefined : 'must be an absolute path'
  )
)

export const WorkspaceConversationSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  sessionFile: Schema.NonEmptyString,
  dataHome: Schema.NonEmptyString,
})
export type WorkspaceConversation = typeof WorkspaceConversationSchema.Type
// Pi may name one conversation file through a symbolic link or before it is written, so a Pi path
// matches a bound conversation only once canonicalized.
export const CanonicalSessionFile = Schema.NonEmptyString.pipe(Schema.brand('CanonicalSessionFile'))
const BoundConversationSchema = Schema.Struct({
  ...WorkspaceConversationSchema.fields,
  sessionFile: CanonicalSessionFile,
})
export type BoundConversation = typeof BoundConversationSchema.Type

export const WorkspaceSelectionSchema = Schema.Struct({
  taskId: WorkspaceId,
  workspaceId: Schema.optional(WorkspaceId),
})
export type WorkspaceSelection = typeof WorkspaceSelectionSchema.Type

export const WorkspaceExecutionSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  taskKey: Schema.NonEmptyString,
  attemptId: Schema.NonEmptyString,
  generation: Schema.NonEmptyString,
  logs: Schema.optional(Schema.String),
})
export type WorkspaceExecution = typeof WorkspaceExecutionSchema.Type
export const sameExecution = Schema.toEquivalence(WorkspaceExecutionSchema)

export const WorkspaceProcessSchema = Schema.Struct({
  pid: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  parent: Schema.Int,
  group: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  birth: Schema.NonEmptyString,
})
export type WorkspaceProcess = typeof WorkspaceProcessSchema.Type

export const WorkspaceEffectSchema = Schema.Literals(['native-file-write', 'opaque'])
export type WorkspaceEffect = typeof WorkspaceEffectSchema.Type

export const WorkspaceAccessSchema = Schema.Literals(['read', 'write'])
export const WorkspaceOriginSchema = Schema.Literals(['pre-existing', 'managed'])
export type WorkspaceOrigin = typeof WorkspaceOriginSchema.Type

export const WorkspaceGrantSchema = Schema.Struct({
  namespaceId: WorkspaceId,
  repositoryId: WorkspaceId,
  workspaceId: WorkspaceId,
  useId: WorkspaceId,
  acquisitionId: Schema.optional(WorkspaceId),
  reservationId: Schema.optional(WorkspaceId),
  taskId: Schema.optional(WorkspaceId),
  revision: Revision,
  cwd: AbsolutePath,
  checkout: AbsolutePath,
  access: WorkspaceAccessSchema,
  origin: WorkspaceOriginSchema,
  // The destination the authority validated for a native file write. The executor opens
  // its own operand, so operands that could resolve elsewhere are refused.
  path: Schema.optional(Schema.NonEmptyString),
})
export type WorkspaceGrant = typeof WorkspaceGrantSchema.Type
export const sameGrant = Schema.toEquivalence(WorkspaceGrantSchema)

export const WorkspaceBindingSchema = Schema.Struct({
  conversation: BoundConversationSchema,
  taskId: Schema.optional(WorkspaceId),
  workspaceId: WorkspaceId,
  cwd: AbsolutePath,
  revision: Revision,
})
export type WorkspaceBinding = typeof WorkspaceBindingSchema.Type
export const sameBinding = Schema.toEquivalence(WorkspaceBindingSchema)

// The host consumes this once, after settling the entire old tool batch.
// A persisted operation alone never authorizes replay of the host transition.
export const WorkspaceHandoffSchema = Schema.Struct({
  operationId: WorkspaceId,
  from: WorkspaceBindingSchema,
  target: WorkspaceGrantSchema,
  reason: Schema.NonEmptyString,
})
export type WorkspaceHandoff = typeof WorkspaceHandoffSchema.Type

export const WorkspaceAuthorizationSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('ready'),
    grant: WorkspaceGrantSchema,
    warning: Schema.optional(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal('rebind'), handoff: WorkspaceHandoffSchema }),
])
export type WorkspaceAuthorization = typeof WorkspaceAuthorizationSchema.Type

export const WorkspaceOperationSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals(['read', 'write', 'delegated-write']),
    cwd: Schema.optional(AbsolutePath),
    execution: Schema.optional(WorkspaceExecutionSchema),
  }),
  Schema.Struct({
    kind: Schema.Literal('native-file-write'),
    within: WorkspaceGrantSchema,
    path: Schema.NonEmptyString,
    cwd: Schema.optional(AbsolutePath),
  }),
  Schema.Struct({
    kind: Schema.Literal('opaque'),
    within: WorkspaceGrantSchema,
    execution: WorkspaceExecutionSchema,
    cwd: Schema.optional(AbsolutePath),
  }),
])
export type WorkspaceOperation = typeof WorkspaceOperationSchema.Type
export type ScopedOperation = Extract<WorkspaceOperation, { readonly within: WorkspaceGrant }>

export const WorkspaceExecutionFactSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('launch-intent'), execution: WorkspaceExecutionSchema }),
  Schema.Struct({ kind: Schema.Literal('spawned'), process: WorkspaceProcessSchema }),
  Schema.Struct({ kind: Schema.Literal('started') }),
  Schema.Struct({
    kind: Schema.Literal('observed'),
    processes: Schema.Array(WorkspaceProcessSchema),
  }),
  Schema.Struct({ kind: Schema.Literal('quiescent'), reason: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal('launch-failed'), reason: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal('unknown'), reason: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal('operation-started') }),
  Schema.Struct({ kind: Schema.Literal('operation-completed') }),
])
export type WorkspaceExecutionFact = typeof WorkspaceExecutionFactSchema.Type

export const WorkspaceViewSchema = Schema.Struct({
  repositoryId: WorkspaceId,
  taskId: Schema.optional(WorkspaceId),
  workspaceId: WorkspaceId,
  path: Schema.NonEmptyString,
  origin: WorkspaceOriginSchema,
  reservationId: Schema.optional(WorkspaceId),
  outcome: Schema.Literals(['active', 'preserved-for-resume', 'blocked', 'review-required']),
  reason: Schema.NonEmptyString,
  nextAction: Schema.NonEmptyString,
  uses: Schema.Array(
    Schema.Struct({
      id: WorkspaceId,
      access: WorkspaceAccessSchema,
      stage: Schema.NonEmptyString,
      effect: Schema.optional(WorkspaceEffectSchema),
      path: Schema.optional(Schema.NonEmptyString),
      reason: Schema.optional(Schema.String),
      execution: Schema.optional(WorkspaceExecutionSchema),
      logsAvailable: Schema.optional(Schema.Boolean),
    })
  ),
  pending: Schema.Array(
    Schema.Struct({ id: WorkspaceId, kind: Schema.NonEmptyString, stage: Schema.NonEmptyString })
  ),
})
export type WorkspaceView = typeof WorkspaceViewSchema.Type

export type HostReplace = (
  target: WorkspaceGrant
) => Effect.Effect<'confirmed' | 'cancelled', unknown>

export interface WorkspaceAttachment {
  readonly binding: WorkspaceBinding
  authorize(operation: WorkspaceOperation): Effect.Effect<WorkspaceAuthorization, WorkspaceError>
  select(selection: WorkspaceSelection): Effect.Effect<WorkspaceHandoff, WorkspaceError>
  reportExecution(
    grant: WorkspaceGrant,
    fact: WorkspaceExecutionFact
  ): Effect.Effect<void, WorkspaceError>
  // Runs outside Pi callbacks. The lifecycle owns intent/start/result publication;
  // the callback owns quiescence, runtime replacement and observed host outcome.
  handoff(transition: WorkspaceHandoff, replace: HostReplace): Effect.Effect<void, WorkspaceError>
  readonly close: Effect.Effect<void, WorkspaceError>
}

export interface WorkspaceLifecycle {
  attach(input: {
    readonly conversation: WorkspaceConversation
    readonly cwd: string
    readonly selection?: WorkspaceSelection
  }): Effect.Effect<WorkspaceAttachment, WorkspaceError>
  // With a taskId, only the views of exactly that task, across every repository.
  inspect(input: {
    readonly cwd?: string
    readonly taskId?: WorkspaceId
  }): Effect.Effect<readonly WorkspaceView[], WorkspaceError>
  // A child verifies the parent's fenced use; it must not acquire a competing writer.
  validate(grant: WorkspaceGrant): Effect.Effect<void, WorkspaceError>
}
