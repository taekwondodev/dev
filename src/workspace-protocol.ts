import { Schema } from 'effect'
import {
  WorkspaceAuthorizationSchema,
  WorkspaceBindingSchema,
  WorkspaceConversationSchema,
  WorkspaceError,
  WorkspaceExecutionFactSchema,
  WorkspaceGrantSchema,
  WorkspaceHandoffSchema,
  WorkspaceId,
  WorkspaceOperationSchema,
  WorkspaceSelectionSchema,
  WorkspaceViewSchema,
  type WorkspaceAuthorization,
  type WorkspaceBinding,
  type WorkspaceHandoff,
  type WorkspaceView,
} from './workspace-domain.ts'

const RpcId = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const AttachmentId = RpcId
const CallbackId = RpcId
const Outcome = WorkspaceError.fields.outcome

const AttachRequestSchema = Schema.Struct({
  op: Schema.Literal('attach'),
  conversation: WorkspaceConversationSchema,
  cwd: Schema.NonEmptyString,
  selection: Schema.optional(WorkspaceSelectionSchema),
})
const AuthorizeRequestSchema = Schema.Struct({
  op: Schema.Literal('authorize'),
  attachmentId: AttachmentId,
  operation: WorkspaceOperationSchema,
})
const SelectRequestSchema = Schema.Struct({
  op: Schema.Literal('select'),
  attachmentId: AttachmentId,
  selection: WorkspaceSelectionSchema,
})
const ReportRequestSchema = Schema.Struct({
  op: Schema.Literal('report-execution'),
  attachmentId: AttachmentId,
  grant: WorkspaceGrantSchema,
  fact: WorkspaceExecutionFactSchema,
})
const HandoffRequestSchema = Schema.Struct({
  op: Schema.Literal('handoff'),
  attachmentId: AttachmentId,
  transition: WorkspaceHandoffSchema,
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

const WorkspaceRpcInputSchema = Schema.Union([
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

const EnvelopeSchema = Schema.Struct({ id: RpcId, request: Schema.Unknown })
const SuccessSchema = Schema.Union([
  Schema.Struct({
    id: RpcId,
    ok: Schema.Literal(true),
    op: Schema.Literal('attach'),
    value: Schema.Struct({ attachmentId: AttachmentId, binding: WorkspaceBindingSchema }),
  }),
  Schema.Struct({
    id: RpcId,
    ok: Schema.Literal(true),
    op: Schema.Literal('authorize'),
    value: WorkspaceAuthorizationSchema,
  }),
  Schema.Struct({
    id: RpcId,
    ok: Schema.Literal(true),
    op: Schema.Literal('select'),
    value: WorkspaceHandoffSchema,
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
    value: Schema.Array(WorkspaceViewSchema),
  }),
])
const FailureSchema = Schema.Struct({
  id: RpcId,
  ok: Schema.Literal(false),
  outcome: Outcome,
  message: Schema.NonEmptyString,
})
export const WorkspaceRpcResponseSchema = Schema.Union([SuccessSchema, FailureSchema])

const BindingUpdateSchema = Schema.Struct({
  attachmentId: AttachmentId,
  binding: WorkspaceBindingSchema,
})
const ReadyMessageSchema = Schema.Struct({ type: Schema.Literal('ready') })
const StartupFailureSchema = Schema.Struct({
  type: Schema.Literal('startup-failure'),
  outcome: Outcome,
  message: Schema.NonEmptyString,
})
const HostCallbackSchema = Schema.Struct({
  type: Schema.Literal('host-callback'),
  id: CallbackId,
  attachmentId: AttachmentId,
  transition: WorkspaceHandoffSchema,
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

const WorkspaceParentMessageSchema = Schema.Union([EnvelopeSchema, CallbackResultSchema])
export const WorkspaceWorkerMessageSchema = Schema.Union([
  ReadyMessageSchema,
  StartupFailureSchema,
  HostCallbackSchema,
  BindingsMessageSchema,
  WorkspaceRpcResponseSchema,
])
const WorkspaceWorkerDataSchema = Schema.Struct({
  root: Schema.optional(Schema.NonEmptyString),
})

export type WorkspaceWorkerMessage = typeof WorkspaceWorkerMessageSchema.Type
type WorkspaceParentMessage = typeof WorkspaceParentMessageSchema.Type
type WorkspaceWorkerData = typeof WorkspaceWorkerDataSchema.Type

export const decodeWorkspaceParentMessage = (value: unknown): WorkspaceParentMessage =>
  Schema.decodeUnknownSync(WorkspaceParentMessageSchema)(value)
export const decodeWorkspaceRpcInput = Schema.decodeUnknownOption(WorkspaceRpcInputSchema)
export const decodeWorkspaceWorkerMessage = (value: unknown): WorkspaceWorkerMessage =>
  Schema.decodeUnknownSync(WorkspaceWorkerMessageSchema)(value)
export const decodeWorkspaceWorkerData = (value: unknown): WorkspaceWorkerData =>
  Schema.decodeUnknownSync(WorkspaceWorkerDataSchema)(value)
