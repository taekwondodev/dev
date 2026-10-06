import { type Option, Schema } from 'effect'
import {
  AbsolutePath,
  PublicationReferenceSchema,
  SweepReceiptSchema,
  SweepRequestSchema,
  TaskTargetSchema,
  WorkspaceAssessmentSchema,
  WorkspaceAuthorizationSchema,
  WorkspaceBindingSchema,
  WorkspaceConversationSchema,
  WorkspaceError,
  WorkspaceExecutionFactSchema,
  WorkspaceExecutionReportSchema,
  WorkspaceGrantSchema,
  WorkspaceHandoffSchema,
  WorkspaceId,
  WorkspaceOperationSchema,
  WorkspaceReleaseResultSchema,
  WorkspaceSelectionSchema,
  WorkspaceViewSchema,
} from './workspace-domain.ts'

const RpcId = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const AttachmentId = RpcId
const CallbackId = RpcId
const Outcome = WorkspaceError.fields.outcome

const AttachRequestSchema = Schema.Struct({
  op: Schema.Literal('attach'),
  conversation: WorkspaceConversationSchema,
  cwd: AbsolutePath,
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
  cwd: Schema.optional(AbsolutePath),
  taskId: Schema.optional(WorkspaceId),
})
const ValidateRequestSchema = Schema.Struct({
  op: Schema.Literal('validate'),
  grant: WorkspaceGrantSchema,
})
const CloseRequestSchema = Schema.Struct({ op: Schema.Literal('close') })
const CheckRequestSchema = Schema.Struct({
  op: Schema.Literal('check'),
  taskId: WorkspaceId,
  ownConversation: Schema.optional(WorkspaceConversationSchema),
})
const ReleaseRequestRpcSchema = Schema.Struct({
  op: Schema.Literal('release'),
  taskId: WorkspaceId,
})
const SweepRpcRequestSchema = Schema.Struct({
  op: Schema.Literal('sweep'),
  request: SweepRequestSchema,
})
const RecordTargetRequestSchema = Schema.Struct({
  op: Schema.Literal('record-target'),
  taskId: WorkspaceId,
  target: TaskTargetSchema,
})
const RecordPublicationRequestSchema = Schema.Struct({
  op: Schema.Literal('record-publication'),
  reference: PublicationReferenceSchema,
})

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
  CheckRequestSchema,
  ReleaseRequestRpcSchema,
  SweepRpcRequestSchema,
  RecordTargetRequestSchema,
  RecordPublicationRequestSchema,
])

export type WorkspaceRpcInput = typeof WorkspaceRpcInputSchema.Type
export type WorkspaceRpcOperation = WorkspaceRpcInput['op']

const RpcReplySchemas = {
  attach: Schema.Struct({ attachmentId: AttachmentId, binding: WorkspaceBindingSchema }),
  authorize: WorkspaceAuthorizationSchema,
  select: WorkspaceHandoffSchema,
  'report-execution': WorkspaceExecutionReportSchema,
  handoff: Schema.Null,
  'close-attachment': Schema.Null,
  inspect: Schema.Array(WorkspaceViewSchema),
  validate: Schema.Null,
  close: Schema.Null,
  check: Schema.Array(WorkspaceAssessmentSchema),
  release: Schema.Array(WorkspaceReleaseResultSchema),
  sweep: SweepReceiptSchema,
  'record-target': Schema.Null,
  'record-publication': Schema.Null,
} as const satisfies Record<WorkspaceRpcOperation, Schema.Top>

export type WorkspaceRpcResults = {
  readonly [K in WorkspaceRpcOperation]: (typeof RpcReplySchemas)[K]['Type']
}
export const decodeWorkspaceRpcReply: {
  readonly [K in WorkspaceRpcOperation]: (value: unknown) => Option.Option<WorkspaceRpcResults[K]>
} = {
  attach: Schema.decodeUnknownOption(RpcReplySchemas.attach),
  authorize: Schema.decodeUnknownOption(RpcReplySchemas.authorize),
  select: Schema.decodeUnknownOption(RpcReplySchemas.select),
  'report-execution': Schema.decodeUnknownOption(RpcReplySchemas['report-execution']),
  handoff: Schema.decodeUnknownOption(RpcReplySchemas.handoff),
  'close-attachment': Schema.decodeUnknownOption(RpcReplySchemas['close-attachment']),
  inspect: Schema.decodeUnknownOption(RpcReplySchemas.inspect),
  validate: Schema.decodeUnknownOption(RpcReplySchemas.validate),
  close: Schema.decodeUnknownOption(RpcReplySchemas.close),
  check: Schema.decodeUnknownOption(RpcReplySchemas.check),
  release: Schema.decodeUnknownOption(RpcReplySchemas.release),
  sweep: Schema.decodeUnknownOption(RpcReplySchemas.sweep),
  'record-target': Schema.decodeUnknownOption(RpcReplySchemas['record-target']),
  'record-publication': Schema.decodeUnknownOption(RpcReplySchemas['record-publication']),
}

const EnvelopeSchema = Schema.Struct({ id: RpcId, sentAt: Schema.Finite, request: Schema.Unknown })
const SuccessSchema = Schema.Struct({
  id: RpcId,
  ok: Schema.Literal(true),
  op: Schema.Literals([
    'attach',
    'authorize',
    'select',
    'report-execution',
    'handoff',
    'close-attachment',
    'inspect',
    'validate',
    'close',
    'check',
    'release',
    'sweep',
    'record-target',
    'record-publication',
  ]),
  value: Schema.Unknown,
})
const FailureSchema = Schema.Struct({
  id: RpcId,
  ok: Schema.Literal(false),
  outcome: Outcome,
  message: Schema.NonEmptyString,
})
const WorkspaceRpcResponseSchema = Schema.Union([SuccessSchema, FailureSchema])

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
const SweepReceiptMessageSchema = Schema.Struct({
  type: Schema.Literal('sweep-receipt'),
  attachmentId: AttachmentId,
  receipt: SweepReceiptSchema,
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
  SweepReceiptMessageSchema,
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
