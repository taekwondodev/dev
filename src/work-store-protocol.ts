import { Schema } from 'effect'
import { AttemptId, AttemptRecordSchema, SessionId } from './work-domain.ts'

const RpcId = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const Timestamp = Schema.Finite
const AttemptIds = Schema.Array(AttemptId)

const SessionRequestFields = {
  sessionId: SessionId,
} as const

const CreateRequestSchema = Schema.Struct({
  id: RpcId,
  op: Schema.Literal('create'),
  ...SessionRequestFields,
  now: Timestamp,
  record: AttemptRecordSchema,
})

const SaveRequestSchema = Schema.Struct({
  id: RpcId,
  op: Schema.Literal('save'),
  ...SessionRequestFields,
  now: Timestamp,
  record: AttemptRecordSchema,
})

const ListRequestSchema = Schema.Struct({
  id: RpcId,
  op: Schema.Literal('list'),
  ...SessionRequestFields,
  now: Timestamp,
})

const ReadRequestSchema = Schema.Struct({
  id: RpcId,
  op: Schema.Literal('read'),
  ...SessionRequestFields,
  now: Timestamp,
  attemptId: AttemptId,
})

const AckRequestSchema = Schema.Struct({
  id: RpcId,
  op: Schema.Literal('ack'),
  ...SessionRequestFields,
  attemptIds: AttemptIds,
})

const CloseRequestSchema = Schema.Struct({
  id: RpcId,
  op: Schema.Literal('close'),
  ...SessionRequestFields,
})

export const RpcRequestSchema = Schema.Union([
  CreateRequestSchema,
  SaveRequestSchema,
  ListRequestSchema,
  ReadRequestSchema,
  AckRequestSchema,
  CloseRequestSchema,
])

export type RpcRequest = typeof RpcRequestSchema.Type
export type RpcOperation = RpcRequest['op']
export type RpcInput = {
  [Operation in RpcOperation]: Omit<Extract<RpcRequest, { readonly op: Operation }>, 'id'>
}[RpcOperation]

export const RpcEnvelopeSchema = Schema.Struct({
  id: RpcId,
  request: RpcRequestSchema,
})

export type RpcEnvelope = typeof RpcEnvelopeSchema.Type

const RpcSuccessSchema = Schema.Struct({
  id: RpcId,
  ok: Schema.Literal(true),
  value: Schema.Unknown,
  cleanup: AttemptIds,
})

const RpcFailureSchema = Schema.Struct({
  id: RpcId,
  ok: Schema.Literal(false),
  code: Schema.NonEmptyString,
})

export const RpcResponseSchema = Schema.Union([RpcSuccessSchema, RpcFailureSchema])
export type RpcResponse = typeof RpcResponseSchema.Type
export type RpcSuccess = Extract<RpcResponse, { readonly ok: true }>

export const WorkerDataSchema = Schema.Struct({
  root: Schema.NonEmptyString,
  databasePath: Schema.NonEmptyString,
  sessionId: SessionId,
})

export type WorkerData = typeof WorkerDataSchema.Type

const ReadyMessageSchema = Schema.Struct({
  type: Schema.Literal('ready'),
  sqliteVersion: Schema.NonEmptyString,
  journalMode: Schema.Literal('wal'),
  synchronous: Schema.Literal(1),
})

const StartupErrorMessageSchema = Schema.Struct({
  type: Schema.Literal('startup-error'),
  code: Schema.NonEmptyString,
})

export const WorkerMessageSchema = Schema.Union([
  ReadyMessageSchema,
  StartupErrorMessageSchema,
  RpcResponseSchema,
])

export type WorkerMessage = typeof WorkerMessageSchema.Type
export type ReadyMessage = Extract<WorkerMessage, { readonly type: 'ready' }>

export const ListValueSchema = Schema.Struct({
  records: Schema.Array(AttemptRecordSchema),
  unavailable: Schema.Array(
    Schema.Struct({
      id: AttemptId,
      error: Schema.String,
    })
  ),
})

export type ListValue = typeof ListValueSchema.Type

export const decodeRpcEnvelope: (value: unknown) => RpcEnvelope =
  Schema.decodeUnknownSync(RpcEnvelopeSchema)

export const decodeWorkerMessage: (value: unknown) => WorkerMessage =
  Schema.decodeUnknownSync(WorkerMessageSchema)

export const decodeWorkerData: (value: unknown) => WorkerData =
  Schema.decodeUnknownSync(WorkerDataSchema)

export const decodeListValue: (value: unknown) => ListValue =
  Schema.decodeUnknownSync(ListValueSchema)
