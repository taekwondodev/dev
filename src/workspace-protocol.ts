import { Schema } from 'effect'
import {
  WorkspaceEffectSchema,
  WorkspaceGrantSchema,
  WorkspaceId,
  WorkspaceProcessSchema,
  type WorkspaceAuthorization,
  type WorkspaceBinding,
  type WorkspaceHandoff,
  type WorkspaceView,
} from './workspace-domain.ts'

const RpcId = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const AttachmentId = RpcId
const CallbackId = RpcId

const ConversationSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  sessionFile: Schema.NonEmptyString,
  dataHome: Schema.NonEmptyString,
})
const SelectionSchema = Schema.Struct({
  taskId: WorkspaceId,
  workspaceId: Schema.optional(WorkspaceId),
})
const ExecutionSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  taskKey: Schema.NonEmptyString,
  attemptId: Schema.NonEmptyString,
  generation: Schema.NonEmptyString,
  logs: Schema.optional(Schema.String),
})
const BindingSchema = Schema.Struct({
  conversation: ConversationSchema,
  taskId: Schema.optional(WorkspaceId),
  workspaceId: WorkspaceId,
  cwd: Schema.NonEmptyString,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
const HandoffSchema = Schema.Struct({
  operationId: WorkspaceId,
  from: BindingSchema,
  target: WorkspaceGrantSchema,
  reason: Schema.NonEmptyString,
})
const OperationSchema = Schema.Struct({
  access: Schema.Literals(['read', 'write']),
  effect: Schema.optional(WorkspaceEffectSchema),
  within: Schema.optional(WorkspaceGrantSchema),
  path: Schema.optional(Schema.NonEmptyString),
  cwd: Schema.optional(Schema.NonEmptyString),
  delegated: Schema.optional(Schema.Boolean),
  execution: Schema.optional(ExecutionSchema),
})
const ExecutionFactSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('launch-intent'), execution: ExecutionSchema }),
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
const UseViewSchema = Schema.Struct({
  id: WorkspaceId,
  access: Schema.Literals(['read', 'write']),
  stage: Schema.NonEmptyString,
  effect: Schema.optional(WorkspaceEffectSchema),
  path: Schema.optional(Schema.NonEmptyString),
  reason: Schema.optional(Schema.String),
  execution: Schema.optional(ExecutionSchema),
  logsAvailable: Schema.optional(Schema.Boolean),
})
const ViewSchema = Schema.Struct({
  repositoryId: WorkspaceId,
  taskId: Schema.optional(WorkspaceId),
  taskLabel: Schema.optional(Schema.String),
  workspaceId: WorkspaceId,
  path: Schema.NonEmptyString,
  origin: Schema.Literals(['pre-existing', 'managed']),
  reservationId: Schema.optional(WorkspaceId),
  outcome: Schema.Literals(['active', 'preserved-for-resume', 'blocked', 'review-required']),
  reason: Schema.NonEmptyString,
  nextAction: Schema.NonEmptyString,
  uses: Schema.Array(UseViewSchema),
  pending: Schema.Array(
    Schema.Struct({ id: WorkspaceId, kind: Schema.NonEmptyString, stage: Schema.NonEmptyString })
  ),
})
const AuthorizationSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('ready'),
    grant: WorkspaceGrantSchema,
    warning: Schema.optional(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal('rebind'), handoff: HandoffSchema }),
])

const AttachRequestSchema = Schema.Struct({
  op: Schema.Literal('attach'),
  conversation: ConversationSchema,
  cwd: Schema.NonEmptyString,
  selection: Schema.optional(SelectionSchema),
})
const AuthorizeRequestSchema = Schema.Struct({
  op: Schema.Literal('authorize'),
  attachmentId: AttachmentId,
  operation: OperationSchema,
})
const SelectRequestSchema = Schema.Struct({
  op: Schema.Literal('select'),
  attachmentId: AttachmentId,
  selection: SelectionSchema,
})
const ReportRequestSchema = Schema.Struct({
  op: Schema.Literal('report-execution'),
  attachmentId: AttachmentId,
  grant: WorkspaceGrantSchema,
  fact: ExecutionFactSchema,
})
const HandoffRequestSchema = Schema.Struct({
  op: Schema.Literal('handoff'),
  attachmentId: AttachmentId,
  transition: HandoffSchema,
  callbackId: CallbackId,
})
const CloseAttachmentRequestSchema = Schema.Struct({
  op: Schema.Literal('close-attachment'),
  attachmentId: AttachmentId,
})
const InspectRequestSchema = Schema.Struct({
  op: Schema.Literal('inspect'),
  cwd: Schema.optional(Schema.NonEmptyString),
  taskId: Schema.optional(WorkspaceId),
})
const ValidateRequestSchema = Schema.Struct({
  op: Schema.Literal('validate'),
  grant: WorkspaceGrantSchema,
})
const CloseRequestSchema = Schema.Struct({ op: Schema.Literal('close') })

export const WorkspaceRpcInputSchema = Schema.Union([
  AttachRequestSchema,
  AuthorizeRequestSchema,
  SelectRequestSchema,
  ReportRequestSchema,
  HandoffRequestSchema,
  CloseAttachmentRequestSchema,
  InspectRequestSchema,
  ValidateRequestSchema,
  CloseRequestSchema,
])

export type WorkspaceRpcInput = typeof WorkspaceRpcInputSchema.Type
export type WorkspaceRpcOperation = WorkspaceRpcInput['op']
export interface WorkspaceRpcEnvelope {
  readonly id: number
  readonly request: WorkspaceRpcInput
}

export interface WorkspaceRpcResults {
  readonly attach: { readonly attachmentId: number; readonly binding: WorkspaceBinding }
  readonly authorize: WorkspaceAuthorization
  readonly select: WorkspaceHandoff
  readonly 'report-execution': null
  readonly handoff: null
  readonly 'close-attachment': null
  readonly inspect: readonly WorkspaceView[]
  readonly validate: null
  readonly close: null
}

export type WorkspaceRpcResult = WorkspaceRpcResults[WorkspaceRpcOperation]

const EnvelopeSchema = Schema.Struct({ id: RpcId, request: WorkspaceRpcInputSchema })
const SuccessSchema = Schema.Union([
  Schema.Struct({
    id: RpcId,
    ok: Schema.Literal(true),
    op: Schema.Literal('attach'),
    value: Schema.Struct({ attachmentId: AttachmentId, binding: BindingSchema }),
  }),
  Schema.Struct({
    id: RpcId,
    ok: Schema.Literal(true),
    op: Schema.Literal('authorize'),
    value: AuthorizationSchema,
  }),
  Schema.Struct({
    id: RpcId,
    ok: Schema.Literal(true),
    op: Schema.Literal('select'),
    value: HandoffSchema,
  }),
  ...(['report-execution', 'handoff', 'close-attachment', 'validate', 'close'] as const).map(op =>
    Schema.Struct({
      id: RpcId,
      ok: Schema.Literal(true),
      op: Schema.Literal(op),
      value: Schema.Null,
    })
  ),
  Schema.Struct({
    id: RpcId,
    ok: Schema.Literal(true),
    op: Schema.Literal('inspect'),
    value: Schema.Array(ViewSchema),
  }),
])
const FailureSchema = Schema.Struct({
  id: RpcId,
  ok: Schema.Literal(false),
  outcome: Schema.Literals(['blocked', 'review-required', 'invalid', 'unavailable', 'ambiguous']),
  message: Schema.NonEmptyString,
})
export const WorkspaceRpcResponseSchema = Schema.Union([SuccessSchema, FailureSchema])

const BindingUpdateSchema = Schema.Struct({ attachmentId: AttachmentId, binding: BindingSchema })
const ReadyMessageSchema = Schema.Struct({ type: Schema.Literal('ready') })
const StartupFailureSchema = Schema.Struct({
  type: Schema.Literal('startup-failure'),
  outcome: Schema.Literals(['blocked', 'review-required', 'invalid', 'unavailable', 'ambiguous']),
  message: Schema.NonEmptyString,
})
const HostCallbackSchema = Schema.Struct({
  type: Schema.Literal('host-callback'),
  id: CallbackId,
  attachmentId: AttachmentId,
  transition: HandoffSchema,
})
const BindingsMessageSchema = Schema.Struct({
  type: Schema.Literal('bindings'),
  updates: Schema.Array(BindingUpdateSchema),
})
const CallbackResultSchema = Schema.Struct({
  type: Schema.Literal('callback-result'),
  id: CallbackId,
  ok: Schema.Boolean,
  outcome: Schema.optional(Schema.Literals(['confirmed', 'cancelled'])),
})

export const WorkspaceParentMessageSchema = Schema.Union([EnvelopeSchema, CallbackResultSchema])
export const WorkspaceWorkerMessageSchema = Schema.Union([
  ReadyMessageSchema,
  StartupFailureSchema,
  HostCallbackSchema,
  BindingsMessageSchema,
  WorkspaceRpcResponseSchema,
])
export const WorkspaceWorkerDataSchema = Schema.Struct({
  root: Schema.optional(Schema.NonEmptyString),
})

export type WorkspaceWorkerMessage = typeof WorkspaceWorkerMessageSchema.Type
export type WorkspaceRpcSuccess = Extract<
  typeof WorkspaceRpcResponseSchema.Type,
  { readonly ok: true }
>
export type WorkspaceRpcFailure = Extract<
  typeof WorkspaceRpcResponseSchema.Type,
  { readonly ok: false }
>
export type WorkspaceHostCallback = typeof HostCallbackSchema.Type
export type WorkspaceBindingUpdate = typeof BindingUpdateSchema.Type
export type WorkspaceParentMessage = typeof WorkspaceParentMessageSchema.Type
export type WorkspaceWorkerData = typeof WorkspaceWorkerDataSchema.Type

export const decodeWorkspaceParentMessage = (value: unknown): WorkspaceParentMessage =>
  Schema.decodeUnknownSync(WorkspaceParentMessageSchema)(value)
export const decodeWorkspaceWorkerMessage = (value: unknown): WorkspaceWorkerMessage =>
  Schema.decodeUnknownSync(WorkspaceWorkerMessageSchema)(value)
export const decodeWorkspaceWorkerData = (value: unknown): WorkspaceWorkerData =>
  Schema.decodeUnknownSync(WorkspaceWorkerDataSchema)(value)
