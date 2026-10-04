import { Effect, Predicate, Schema } from 'effect'
import { relative, isAbsolute } from 'node:path'
import type { SessionEntry, SessionManager } from '@earendil-works/pi-coding-agent'
import { WorkspaceId } from './workspace-domain.ts'
import {
  AttemptId,
  ContextUsageSchema,
  ChildResourcesSchema,
  type ChildResources,
  UsageSchema,
  WorkAccessSchema,
  WorkError,
  WorkProtocolError,
} from './work-domain.ts'
import { errorText } from './error-text.ts'

const NonEmptyText = Schema.NonEmptyString

const readyKeys = [
  'type',
  'model',
  'effort',
  'sessionFile',
  'resources',
  'context',
  'usage',
] as const
const progressKeys = readyKeys
const resultKeys = [...readyKeys, 'text', 'error', 'quotaExhausted'] as const

const noUnexpectedKeys = (keys: readonly string[]) =>
  Schema.makeFilter((value: unknown) => {
    if (!Predicate.isObject(value) || Array.isArray(value)) return 'Invalid child message'
    return Object.keys(value).every(key => keys.includes(key))
      ? undefined
      : 'Unexpected child message field'
  })

const strictMessage = <Fields extends Schema.Struct.Fields>(
  fields: Fields,
  keys: readonly string[]
) =>
  Schema.StructWithRest(Schema.Struct(fields), [Schema.Record(Schema.String, Schema.Unknown)]).pipe(
    Schema.check(noUnexpectedKeys(keys))
  )

const ReadyMessageSchema = strictMessage(
  {
    type: Schema.Literal('ready'),
    model: NonEmptyText,
    effort: NonEmptyText,
    sessionFile: NonEmptyText,
    resources: ChildResourcesSchema,
    context: Schema.optional(ContextUsageSchema),
    usage: Schema.optional(UsageSchema),
  },
  readyKeys
)

const ProgressMessageSchema = strictMessage(
  {
    type: Schema.Literal('progress'),
    model: Schema.optional(NonEmptyText),
    effort: Schema.optional(NonEmptyText),
    sessionFile: Schema.optional(NonEmptyText),
    resources: Schema.optional(ChildResourcesSchema),
    context: Schema.optional(ContextUsageSchema),
    usage: Schema.optional(UsageSchema),
  },
  progressKeys
)

const ResultMessageSchema = strictMessage(
  {
    type: Schema.Literal('result'),
    model: Schema.optional(NonEmptyText),
    effort: Schema.optional(NonEmptyText),
    sessionFile: Schema.optional(NonEmptyText),
    resources: Schema.optional(ChildResourcesSchema),
    context: Schema.optional(ContextUsageSchema),
    usage: Schema.optional(UsageSchema),
    text: Schema.String,
    error: Schema.optional(NonEmptyText),
    quotaExhausted: Schema.optional(Schema.Boolean),
  },
  resultKeys
).pipe(
  Schema.check(
    Schema.makeFilter((value: unknown) => {
      if (!Predicate.isObject(value) || typeof value.text !== 'string')
        return 'Invalid child result text'
      return value.text.trim() || value.error !== undefined
        ? undefined
        : 'Child result needs text or an explicit failure'
    })
  )
)

const sharedWorkInput = {
  taskId: Schema.optionalKey(Schema.String),
  prompt: Schema.optionalKey(Schema.String),
  id: Schema.optionalKey(Schema.String),
  access: Schema.optionalKey(WorkAccessSchema),
  harness: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  effort: Schema.optionalKey(Schema.String),
  rule: Schema.optionalKey(Schema.String),
  stream: Schema.optionalKey(Schema.Literals(['stdout', 'stderr', 'result'])),
  offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
}

export const LeadWorkInputSchema = Schema.Struct({
  action: Schema.Literals(['process', 'delegate', 'dispatch', 'list', 'inspect', 'cancel']),
  command: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  coordinate: Schema.optionalKey(Schema.Boolean),
  ...sharedWorkInput,
})

export const CoordinatorWorkInputSchema = Schema.Struct({
  action: Schema.Literals(['delegate', 'dispatch', 'list', 'inspect', 'cancel']),
  ...sharedWorkInput,
})

export type WorkInput = typeof LeadWorkInputSchema.Type

export const decodeWorkInput =
  <Input extends WorkInput>(schema: Schema.Codec<Input, unknown>) =>
  (input: unknown): Effect.Effect<Input, WorkError> =>
    Schema.decodeUnknownEffect(schema)(input, { onExcessProperty: 'error' }).pipe(
      Effect.mapError(cause => new WorkError({ message: cause.message, cause }))
    )

const RequestId = Schema.NonEmptyString

export const ChildMessageSchema = Schema.Union([
  ReadyMessageSchema,
  ProgressMessageSchema,
  ResultMessageSchema,
  Schema.Struct({
    type: Schema.Literal('workspace-check'),
    requestId: WorkspaceId,
    useId: WorkspaceId,
    operation: Schema.Literals(['read', 'write']),
  }),
  strictMessage(
    { type: Schema.Literal('work-request'), requestId: RequestId, input: Schema.Unknown },
    ['type', 'requestId', 'input']
  ),
  strictMessage({ type: Schema.Literal('work-idle'), requestId: RequestId }, ['type', 'requestId']),
  strictMessage({ type: Schema.Literal('work-outcomes-ack'), attempts: Schema.Array(AttemptId) }, [
    'type',
    'attempts',
  ]),
])

export type ChildMessage = typeof ChildMessageSchema.Type
export type CoordinationMessage = Extract<
  ChildMessage,
  { readonly type: 'work-request' | 'work-idle' | 'work-outcomes-ack' }
>
export const isCoordinationMessage = (message: ChildMessage): message is CoordinationMessage =>
  message.type === 'work-request' ||
  message.type === 'work-idle' ||
  message.type === 'work-outcomes-ack'

const LeafOutcomeSchema = Schema.StructWithRest(Schema.Struct({ id: AttemptId }), [
  Schema.Record(Schema.String, Schema.Unknown),
])

export const ControllerWorkMessageSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('work-reply'),
    requestId: RequestId,
    ok: Schema.Literal(true),
    result: Schema.Unknown,
  }),
  Schema.Struct({
    type: Schema.Literal('work-reply'),
    requestId: RequestId,
    ok: Schema.Literal(false),
    error: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal('work-pending'),
    requestId: RequestId,
    live: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    outcomes: Schema.Array(LeafOutcomeSchema),
  }),
  Schema.Struct({ type: Schema.Literal('work-wake') }),
])
export type ControllerWorkMessage = typeof ControllerWorkMessageSchema.Type

const OUTCOME_MESSAGE = 'dev/work-outcome'

const decodeDeliveryDetails = Schema.decodeUnknownResult(
  Schema.Struct({ attempts: Schema.Array(AttemptId) })
)

export const outcomeMessage = (items: readonly { readonly id: AttemptId }[], guidance: string) => ({
  customType: OUTCOME_MESSAGE,
  display: true,
  content: `${guidance}\n${JSON.stringify(items)}`,
  details: { attempts: items.map(record => record.id) },
})

export const outcomeAttempts = (
  entries: readonly {
    readonly type: string
    readonly customType?: string
    readonly details?: unknown
  }[]
): Set<AttemptId> => {
  const ids = new Set<AttemptId>()
  for (const entry of entries) {
    if (entry.type !== 'custom_message' || entry.customType !== OUTCOME_MESSAGE) continue
    const details = decodeDeliveryDetails(entry.details)
    if (details._tag === 'Success') for (const id of details.success.attempts) ids.add(id)
  }
  return ids
}

export const trackOutcomeAttempts = (
  session: Pick<SessionManager, 'getLeafEntry' | 'getEntry'>
): (() => ReadonlySet<AttemptId>) => {
  let previous: SessionEntry | undefined
  const received = new Set<AttemptId>()
  return () => {
    const leaf = session.getLeafEntry()
    if (leaf === previous) return received
    const appended: SessionEntry[] = []
    let entry = leaf
    while (entry !== undefined && entry !== previous) {
      appended.push(entry)
      entry = entry.parentId === null ? undefined : session.getEntry(entry.parentId)
    }
    if (entry !== previous) received.clear()
    for (const id of outcomeAttempts(appended)) received.add(id)
    previous = leaf
    return received
  }
}

export type ChildResultMessage = Extract<ChildMessage, { readonly type: 'result' }>

const validateSessionFile = (value: string, sessionDir: string): string => {
  const path = relative(sessionDir, value)
  if (!isAbsolute(value) || !path || path.startsWith('..') || isAbsolute(path)) {
    throw new Error('Child session file is outside its conversation directory')
  }
  return value
}

const validateResources = (value: ChildResources, cwd: string): ChildResources => {
  if (value.cwd !== cwd) throw new Error('Invalid child resource scope')
  return value
}

const validateMessageContext = (
  message: ChildMessage,
  options: { readonly cwd: string; readonly sessionDir: string }
): ChildMessage => {
  if (message.type === 'workspace-check' || isCoordinationMessage(message)) return message
  if (message.sessionFile !== undefined)
    validateSessionFile(message.sessionFile, options.sessionDir)
  if (message.resources !== undefined) validateResources(message.resources, options.cwd)
  return message
}

const toProtocolError = (cause: unknown): WorkProtocolError =>
  cause instanceof WorkProtocolError
    ? cause
    : new WorkProtocolError({
        message: errorText(cause),
        cause,
      })

export const parseChildMessage = (
  value: unknown,
  options: { readonly cwd: string; readonly sessionDir: string }
): Effect.Effect<ChildMessage, WorkProtocolError> =>
  Schema.decodeUnknownEffect(ChildMessageSchema)(value).pipe(
    Effect.flatMap(message =>
      Effect.try({
        try: () => validateMessageContext(message, options),
        catch: toProtocolError,
      })
    ),
    Effect.mapError(toProtocolError)
  )
