import { Schema } from 'effect'
import type { Effect as EffectType } from 'effect/Effect'

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
export const SessionId = Schema.NonEmptyString.pipe(Schema.brand('dev/work/SessionId'))
export type SessionId = typeof SessionId.Type

export const TaskId = Schema.NonEmptyString.pipe(Schema.brand('dev/work/TaskId'))
export type TaskId = typeof TaskId.Type

export const GenerationId = Schema.NonEmptyString.pipe(Schema.brand('dev/work/GenerationId'))
export type GenerationId = typeof GenerationId.Type

export const AttemptId = Schema.String.pipe(
  Schema.check(Schema.isPattern(UUID)),
  Schema.brand('dev/work/AttemptId')
)
export type AttemptId = typeof AttemptId.Type

export const isAttemptId = (value: string): value is AttemptId => Schema.is(AttemptId)(value)
export const asAttemptId = (value: string): AttemptId => Schema.decodeSync(AttemptId)(value)
export const asSessionId = (value: string): SessionId => Schema.decodeSync(SessionId)(value)
export const asTaskId = (value: string): TaskId => Schema.decodeSync(TaskId)(value)
export const asGenerationId = (value: string): GenerationId =>
  Schema.decodeSync(GenerationId)(value)

export const WorkKindSchema = Schema.Literals(['process', 'agent'] as const)
export type WorkKind = typeof WorkKindSchema.Type

export const WorkAccessSchema = Schema.Literals(['read-only', 'write'] as const)
export type WorkAccess = typeof WorkAccessSchema.Type

export const WorkStatusSchema = Schema.Literals([
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
  'unknown',
] as const)
export type WorkStatus = typeof WorkStatusSchema.Type

export const DispatchEffortSchema = Schema.Literals([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const)

export const DispatchProfileSchema = Schema.Struct({
  harness: Schema.Literal('pi'),
  model: Schema.optional(Schema.String),
  effort: Schema.optional(DispatchEffortSchema),
})
export type DispatchProfile = typeof DispatchProfileSchema.Type

export const DispatchRuleSchema = Schema.Struct({
  when: Schema.String,
  use: DispatchProfileSchema,
  why: Schema.optional(Schema.String),
})
export type DispatchRule = typeof DispatchRuleSchema.Type

export const DispatchConfigSchema = Schema.Struct({
  path: Schema.String,
  configured: Schema.Literal(true),
  rules: Schema.Array(DispatchRuleSchema),
  default: DispatchProfileSchema,
})
export type DispatchConfig = typeof DispatchConfigSchema.Type

export interface DispatchInput {
  readonly rule?: string
  readonly harness?: string
  readonly model?: string
  readonly effort?: string
}

export const OwnerIdentitySchema = Schema.Struct({
  sessionId: SessionId,
  taskId: TaskId,
  attemptId: AttemptId,
  generation: GenerationId,
})
export type OwnerIdentity = typeof OwnerIdentitySchema.Type

export const ArtifactStateSchema = Schema.StructWithRest(
  Schema.Struct({
    head: Schema.optional(Schema.String),
    trackedDigest: Schema.optional(Schema.String),
    untracked: Schema.optional(Schema.Boolean),
    unavailable: Schema.optional(Schema.Literal(true)),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)]
)
export type ArtifactState = typeof ArtifactStateSchema.Type

export interface WorktreeReminder {
  readonly path: string
  readonly cleanup: 'blocked' | 'review-required'
  readonly guidance: string
}

export const UsageSchema = Schema.Struct({
  input: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  output: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  cacheRead: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  cacheWrite: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  total: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  cost: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  userMessages: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  assistantMessages: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  toolCalls: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  toolResults: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type Usage = typeof UsageSchema.Type

export const ContextUsageSchema = Schema.Struct({
  tokens: Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  contextWindow: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  percent: Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
})
export type ContextUsage = typeof ContextUsageSchema.Type

export const ChildResourcesSchema = Schema.Struct({
  packageVersion: Schema.NonEmptyString,
  cwd: Schema.NonEmptyString,
  access: WorkAccessSchema,
  specialization: Schema.NonEmptyString,
  resources: Schema.Array(
    Schema.Struct({
      path: Schema.NonEmptyString,
      source: Schema.NonEmptyString,
      precedence: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
    })
  ),
  skills: Schema.Array(Schema.Struct({ name: Schema.NonEmptyString, path: Schema.NonEmptyString })),
  tools: Schema.Array(Schema.NonEmptyString),
})
export type ChildResources = typeof ChildResourcesSchema.Type

const SignalSchema = Schema.NullOr(Schema.String)
const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const retainedFields = <Fields extends Schema.Struct.Fields>(schema: Schema.Struct<Fields>) =>
  Schema.StructWithRest(schema, [Schema.Record(Schema.String, Schema.Unknown)])
const RetainedResourcesSchema = retainedFields(
  Schema.Struct({
    ...ChildResourcesSchema.fields,
    resources: Schema.Array(retainedFields(ChildResourcesSchema.fields.resources.value)),
    skills: Schema.Array(retainedFields(ChildResourcesSchema.fields.skills.value)),
  })
)
const NoCompletionTime = Schema.optional(Schema.Never)
const AttemptRecordFactFields = {
  version: Schema.Literal(1),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  id: AttemptId,
  startedAt: Schema.Finite,
  kind: WorkKindSchema,
  cwd: Schema.String,
  controllerPid: Schema.Int,
  pid: Schema.optional(PositiveInt),
  owner: retainedFields(OwnerIdentitySchema),
  access: Schema.optional(WorkAccessSchema),
  selection: Schema.optional(retainedFields(DispatchProfileSchema)),
  worktreePath: Schema.optional(Schema.String),
  artifactAtStart: Schema.optional(ArtifactStateSchema),
  artifactAtCompletion: Schema.optional(ArtifactStateSchema),
  changedDuringRun: Schema.optional(Schema.Union([Schema.Boolean, Schema.Literal('unknown')])),
  exitCode: Schema.optional(Schema.NullOr(Schema.Int)),
  signal: Schema.optional(SignalSchema),
  cancelRequestedAt: Schema.optional(Schema.Finite),
  cancelReason: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  observationError: Schema.optional(Schema.String),
  persistenceError: Schema.optional(Schema.String),
  cleanupError: Schema.optional(Schema.String),
  deliveryError: Schema.optional(Schema.String),
  protocolError: Schema.optional(Schema.String),
  processObservation: Schema.optional(Schema.String),
  recovery: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  effort: Schema.optional(Schema.String),
  sessionFile: Schema.optional(Schema.String),
  resources: Schema.optional(RetainedResourcesSchema),
  context: Schema.optional(retainedFields(ContextUsageSchema)),
  usage: Schema.optional(retainedFields(UsageSchema)),
} as const

const retainedAttemptRecord = <
  const Status extends Schema.Schema<string>,
  const Completion extends Schema.Schema<number | undefined>,
>(
  status: Status,
  completedAt: Completion
) =>
  Schema.StructWithRest(Schema.Struct({ ...AttemptRecordFactFields, status, completedAt }), [
    Schema.Record(Schema.String, Schema.Unknown),
  ])

export const AttemptRecordSchema = Schema.Union([
  retainedAttemptRecord(Schema.Literal('running'), NoCompletionTime),
  retainedAttemptRecord(Schema.Literal('waiting'), NoCompletionTime),
  retainedAttemptRecord(Schema.Literal('completed'), Schema.Finite),
  retainedAttemptRecord(Schema.Literal('failed'), Schema.Finite),
  retainedAttemptRecord(Schema.Literal('cancelled'), Schema.Finite),
  retainedAttemptRecord(Schema.Literal('unknown'), NoCompletionTime),
]).pipe(Schema.toTaggedUnion('status'))

type Mutable<T> = T extends object ? { -readonly [K in keyof T]: T[K] } : T
export type AttemptRecord = Mutable<typeof AttemptRecordSchema.Type>

export interface ActiveAttemptState {
  readonly _tag: 'active'
  readonly status: Extract<WorkStatus, 'running' | 'waiting'>
}

export interface TerminalAttemptState {
  readonly _tag: 'terminal'
  readonly status: Extract<WorkStatus, 'completed' | 'failed' | 'cancelled'>
  readonly completedAt: number
}

export interface UnknownAttemptState {
  readonly _tag: 'unknown'
  readonly status: 'unknown'
}

export type AttemptState = ActiveAttemptState | TerminalAttemptState | UnknownAttemptState

export interface AttemptLifecycleToken {
  readonly sessionId: SessionId
  readonly attemptId: AttemptId
  readonly generation: GenerationId
}

export const activeAttemptState = (status: ActiveAttemptState['status']): ActiveAttemptState => ({
  _tag: 'active',
  status,
})
export const terminalAttemptState = (
  status: TerminalAttemptState['status'],
  completedAt: number
): TerminalAttemptState => ({ _tag: 'terminal', status, completedAt })
export const unknownAttemptState: UnknownAttemptState = { _tag: 'unknown', status: 'unknown' }

export type AttemptView = Readonly<AttemptRecord> & { readonly worktree?: WorktreeReminder }

export interface WorkSnapshot {
  readonly records: readonly AttemptView[]
  readonly unavailable: readonly { readonly id: string; readonly error: string }[]
  readonly agentsBlocked: boolean
}

export interface LogRequest {
  readonly id: AttemptId
  readonly stream: 'stdout' | 'stderr' | 'result'
  readonly offset?: number
  readonly limit?: number
}

export interface LogPage {
  readonly available: boolean
  readonly path: string
  readonly reason?: string
  readonly offset?: number
  readonly nextOffset?: number
  readonly size?: number
  readonly truncated?: boolean
  readonly text?: string
}

export type AttemptDescription = AttemptView & {
  readonly staleArtifact: boolean | 'unknown'
  readonly evidence: string
  readonly logs: readonly (LogPage & { readonly stream: LogRequest['stream'] })[]
}

export interface ProcessStartRequest {
  readonly taskId: string
  readonly command: string
  readonly cwd?: string
}

export interface AgentStartRequest {
  readonly taskId: string
  readonly prompt: string
  readonly access: WorkAccess
  readonly cwd?: string
  readonly skills?: readonly string[]
  readonly rule?: string
  readonly harness?: string
  readonly model?: string
  readonly effort?: string
}

export type StartRequest =
  | ({ readonly kind: 'process' } & ProcessStartRequest)
  | ({ readonly kind: 'agent' } & AgentStartRequest)

export class WorkError extends Schema.TaggedError<WorkError>()('WorkError', {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class WorkSetupError extends Schema.TaggedError<WorkSetupError>()('WorkSetupError', {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class WorkPersistenceError extends Schema.TaggedError<WorkPersistenceError>()(
  'WorkPersistenceError',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }
) {}

export class WorkProtocolError extends Schema.TaggedError<WorkProtocolError>()(
  'WorkProtocolError',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }
) {}

export class WorkDispatchError extends Schema.TaggedError<WorkDispatchError>()(
  'WorkDispatchError',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }
) {}

export type WorkFailure =
  | WorkError
  | WorkSetupError
  | WorkPersistenceError
  | WorkProtocolError
  | WorkDispatchError

export interface WorkOwnerService {
  readonly snapshot: EffectType<WorkSnapshot, WorkFailure>
  readonly startProcess: (request: ProcessStartRequest) => EffectType<AttemptView, WorkFailure>
  readonly startAgent: (request: AgentStartRequest) => EffectType<AttemptView, WorkFailure>
  readonly cancel: (id: AttemptId, reason?: string) => EffectType<AttemptView, WorkFailure>
  readonly inspect: (id: AttemptId) => EffectType<AttemptDescription, WorkFailure>
  readonly readLog: (request: LogRequest) => EffectType<LogPage, WorkFailure>
  readonly canDeliver: (attempt: AttemptView) => EffectType<boolean, WorkFailure>
  readonly recordDeliveryFailure: (id: AttemptId, message: string) => EffectType<void, WorkFailure>
  readonly dispatch: EffectType<DispatchConfig, WorkFailure>
  readonly interrupt: (reason?: string) => EffectType<void, WorkFailure>
  readonly exhaust: (except?: AttemptId) => EffectType<void, WorkFailure>
  readonly close: (reason?: string) => EffectType<void, WorkFailure>
}
