import { isAbsolute } from 'node:path'
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

export const isAttemptId: (value: string) => value is AttemptId = Schema.is(AttemptId)
export const asAttemptId: (value: string) => AttemptId = Schema.decodeSync(AttemptId)
export const asSessionId: (value: string) => SessionId = Schema.decodeSync(SessionId)
export const asTaskId: (value: string) => TaskId = Schema.decodeSync(TaskId)
export const asGenerationId: (value: string) => GenerationId = Schema.decodeSync(GenerationId)

export const WorkKindSchema = Schema.Literals(['process', 'agent'] as const)
export type WorkKind = typeof WorkKindSchema.Type

export const WorkAccessSchema = Schema.Literals(['read-only', 'write'] as const)
export type WorkAccess = typeof WorkAccessSchema.Type

export const READ_ONLY_CHILD_TOOLS = ['read', 'grep', 'find', 'ls', 'git_inspect'] as const
export const READ_ONLY_CHILD_CAPABILITIES = `A read-only child has only ${READ_ONLY_CHILD_TOOLS.join(', ')}: no shell, network or gh. Put issue, PR or other external text in the prompt or a workspace file.`

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
  model: Schema.optional(Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty())),
  effort: Schema.optional(DispatchEffortSchema),
})
export type DispatchProfile = typeof DispatchProfileSchema.Type

export const DispatchRulesSchema = Schema.Record(Schema.String, DispatchProfileSchema).check(
  Schema.makeFilter((rules: Readonly<Record<string, DispatchProfile>>) => {
    const names = Object.keys(rules)
    if (names.includes('default'))
      return 'A dispatch rule cannot be named "default"; that word selects the default profile'
    const invalid = names.find(name => !/^\S+$/.test(name))
    return invalid === undefined
      ? undefined
      : `Dispatch rule key "${invalid}" must be a nonempty skill name without whitespace`
  })
)

export const DispatchConfigSchema = Schema.Struct({
  path: Schema.String,
  configured: Schema.Literal(true),
  rules: DispatchRulesSchema,
  default: DispatchProfileSchema,
})
export type DispatchConfig = typeof DispatchConfigSchema.Type

export interface DispatchInput {
  readonly prompt: string
  readonly rule?: string
  readonly harness?: string
  readonly model?: string
  readonly effort?: string
}

export const SKILL_COMMAND = '/skill:'

export interface SkillInvocation {
  readonly name: string
  readonly assignment: string
}

export const skillInvocation = (prompt: string): SkillInvocation | undefined => {
  const invocation = prompt.trimStart()
  if (!invocation.startsWith(SKILL_COMMAND)) return undefined
  const [, name = '', assignment = ''] =
    /^(\S*)\s*([\s\S]*)$/.exec(invocation.slice(SKILL_COMMAND.length)) ?? []
  return { name, assignment }
}

export const OwnerIdentitySchema = Schema.Struct({
  sessionId: SessionId,
  taskId: TaskId,
  attemptId: AttemptId,
  generation: GenerationId,
  parent: Schema.optional(AttemptId),
})
export type OwnerIdentity = typeof OwnerIdentitySchema.Type

export const ArtifactStateSchema = Schema.Struct({
  head: Schema.optional(Schema.String),
  trackedDigest: Schema.optional(Schema.String),
  untracked: Schema.optional(Schema.Boolean),
  unavailable: Schema.optional(Schema.Literal(true)),
})
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

const InvokedSkillSchema = Schema.Struct({
  name: Schema.NonEmptyString,
  path: Schema.NonEmptyString,
})

export const ChildResourcesSchema = Schema.Struct({
  packageVersion: Schema.NonEmptyString,
  cwd: Schema.NonEmptyString,
  access: WorkAccessSchema,
  profile: Schema.NonEmptyString,
  resources: Schema.Array(
    Schema.Struct({
      path: Schema.NonEmptyString,
      source: Schema.NonEmptyString,
      precedence: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
    })
  ),
  invokedSkill: Schema.optional(InvokedSkillSchema),
  tools: Schema.Array(Schema.NonEmptyString),
})
export type ChildResources = typeof ChildResourcesSchema.Type

const SignalSchema = Schema.NullOr(Schema.String)
const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const NoCompletionTime = Schema.optional(Schema.Never)
const AttemptRecordFactFields = {
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  id: AttemptId,
  startedAt: Schema.Finite,
  kind: WorkKindSchema,
  cwd: Schema.String,
  controllerPid: Schema.Int,
  pid: Schema.optional(PositiveInt),
  owner: OwnerIdentitySchema,
  access: Schema.optional(WorkAccessSchema),
  coordinator: Schema.optional(Schema.Boolean),
  selection: Schema.optional(DispatchProfileSchema),
  worktreePath: Schema.optional(Schema.String),
  workflowTaskId: Schema.optional(Schema.String),
  workspaceId: Schema.optional(Schema.String),
  workspaceUseId: Schema.optional(Schema.String),
  workspaceAcquisitionId: Schema.optional(Schema.String),
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
  gateReleaseWarning: Schema.optional(Schema.String),
  deliveryError: Schema.optional(Schema.String),
  protocolError: Schema.optional(Schema.String),
  processObservation: Schema.optional(Schema.String),
  recovery: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  effort: Schema.optional(Schema.String),
  sessionFile: Schema.optional(Schema.String),
  resources: Schema.optional(ChildResourcesSchema),
  context: Schema.optional(ContextUsageSchema),
  usage: Schema.optional(UsageSchema),
} as const

const attemptRecordInvariants = Schema.makeFilter(
  (record: {
    readonly id: AttemptId
    readonly owner: OwnerIdentity
    readonly worktreePath?: string | undefined
    readonly workspaceId?: string | undefined
    readonly workspaceUseId?: string | undefined
  }) => {
    if (record.id !== record.owner.attemptId)
      return 'Attempt record identity disagrees with its owner'
    if (record.worktreePath === undefined) return undefined
    if (!isAbsolute(record.worktreePath)) return 'Attempt worktree path must be absolute'
    return record.workspaceId === undefined || record.workspaceUseId === undefined
      ? 'Attempt worktree requires its workspace and workspace use'
      : undefined
  }
)

const attemptRecord = <
  const Status extends Schema.Schema<string>,
  const Completion extends Schema.Schema<number | undefined>,
>(
  status: Status,
  completedAt: Completion
) => Schema.Struct({ ...AttemptRecordFactFields, status, completedAt })

export const AttemptRecordSchema = Schema.Union([
  attemptRecord(Schema.Literal('running'), NoCompletionTime),
  attemptRecord(Schema.Literal('waiting'), NoCompletionTime),
  attemptRecord(Schema.Literal('completed'), Schema.Finite),
  attemptRecord(Schema.Literal('failed'), Schema.Finite),
  attemptRecord(Schema.Literal('cancelled'), Schema.Finite),
  attemptRecord(Schema.Literal('unknown'), NoCompletionTime),
])
  .check(attemptRecordInvariants)
  .pipe(Schema.toTaggedUnion('status'))

type Mutable<T> = T extends object ? { -readonly [K in keyof T]: T[K] } : T
export type AttemptRecord = Mutable<typeof AttemptRecordSchema.Type>

export const decodeAttemptRecord: (value: unknown) => AttemptRecord = Schema.decodeUnknownSync(
  AttemptRecordSchema,
  { onExcessProperty: 'error' }
)

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

export interface WorkDeliveryStatus {
  readonly eligible: readonly AttemptId[]
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
  readonly coordinate?: boolean
  readonly cwd?: string
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
    code: Schema.String,
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

export class WorkRebindRequired extends Schema.TaggedError<WorkRebindRequired>()(
  'WorkRebindRequired',
  { message: Schema.String }
) {}

export type WorkFailure =
  | WorkError
  | WorkRebindRequired
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
  readonly deliveryStatus: (
    attempts: readonly AttemptView[]
  ) => EffectType<WorkDeliveryStatus, WorkFailure>
  readonly recordDeliveryFailure: (id: AttemptId, message: string) => EffectType<void, WorkFailure>
  readonly dispatch: EffectType<DispatchConfig, WorkFailure>
  readonly interrupt: (reason?: string) => EffectType<void, WorkFailure>
  readonly exhaust: (except?: AttemptId) => EffectType<void, WorkFailure>
  readonly close: (reason?: string) => EffectType<void, WorkFailure>
}
