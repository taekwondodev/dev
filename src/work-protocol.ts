import { Effect, Predicate, Schema } from 'effect'
import { relative, isAbsolute } from 'node:path'
import { WorkspaceId } from './workspace-domain.ts'
import {
  ContextUsageSchema,
  ChildResourcesSchema,
  type ChildResources,
  UsageSchema,
  WorkProtocolError,
} from './work-domain.ts'

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
])

export type ChildMessage = typeof ChildMessageSchema.Type
export type ChildReadyMessage = Extract<ChildMessage, { readonly type: 'ready' }>
export type ChildProgressMessage = Extract<ChildMessage, { readonly type: 'progress' }>
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
  if (message.type === 'workspace-check') return message
  if (message.sessionFile !== undefined)
    validateSessionFile(message.sessionFile, options.sessionDir)
  if (message.resources !== undefined) validateResources(message.resources, options.cwd)
  return message
}

const toProtocolError = (cause: unknown): WorkProtocolError =>
  cause instanceof WorkProtocolError
    ? cause
    : new WorkProtocolError({
        message: cause instanceof Error ? cause.message : String(cause),
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
