import { join } from 'node:path'
import { DateTime, Effect, FileSystem, Option, Predicate, Schema } from 'effect'

const TokenCount = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

const TokensSchema = Schema.Struct({
  input: TokenCount,
  output: TokenCount,
  cacheRead: TokenCount,
  cacheWrite: TokenCount,
  reasoning: Schema.optional(TokenCount),
})
export type Tokens = typeof TokensSchema.Type
export type Usage = Tokens | 'unknown'

const decodeTokens = Schema.decodeUnknownOption(TokensSchema)
const usageOf = (value: unknown): Usage =>
  Option.getOrElse(decodeTokens(value), (): Usage => 'unknown')

const Timestamp = Schema.DateTimeUtcFromString
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

const decodeHeader = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal('session'),
    timestamp: Timestamp,
    parentSession: Schema.optional(Schema.String),
  })
)

const decodeEnvelope = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.String,
    id: Schema.String,
    parentId: Schema.NullOr(Schema.String),
    timestamp: Timestamp,
  })
)

const decodeRole = Schema.decodeUnknownOption(
  Schema.Struct({ message: Schema.Struct({ role: Schema.String }) })
)

const decodeAssistant = Schema.decodeUnknownOption(
  Schema.Struct({
    message: Schema.Struct({
      timestamp: Schema.Finite,
      provider: Schema.optional(Schema.String),
      model: Schema.optional(Schema.String),
      thinkingLevel: Schema.optional(Schema.String),
      stopReason: Schema.optional(Schema.String),
      usage: Schema.optional(Schema.Unknown),
      content: Schema.Array(Schema.Unknown),
    }),
  })
)

const decodeToolCall = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal('toolCall'),
    id: Schema.String,
    name: Schema.String,
    arguments: Schema.optional(Schema.Unknown),
  })
)

const decodeText = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.Literal('text'), text: Schema.String })
)

const decodeToolResult = Schema.decodeUnknownOption(
  Schema.Struct({
    message: Schema.Struct({
      toolCallId: Schema.String,
      toolName: Schema.String,
      content: Schema.Array(Schema.Unknown),
      details: Schema.optional(Schema.Unknown),
      usage: Schema.optional(Schema.Unknown),
      isError: Schema.Boolean,
    }),
  })
)

const MessageContent = Schema.Union([Schema.String, Schema.Array(Schema.Unknown)])

const decodeUser = Schema.decodeUnknownOption(
  Schema.Struct({ message: Schema.Struct({ content: MessageContent }) })
)

const SystemPrompt = Schema.Struct({
  sections: Schema.optional(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
  replace: Schema.optional(Schema.Boolean),
})

const decodeSystem = Schema.decodeUnknownOption(Schema.Struct({ message: SystemPrompt }))

const decodeCompaction = Schema.decodeUnknownOption(
  Schema.Struct({
    tokensBefore: Schema.optional(Schema.Finite),
    usage: Schema.optional(Schema.Unknown),
    systemMessage: Schema.optional(SystemPrompt),
  })
)

const decodeSummary = Schema.decodeUnknownOption(
  Schema.Struct({ usage: Schema.optional(Schema.Unknown) })
)

const decodeStandaloneUsage = Schema.decodeUnknownOption(
  Schema.Struct({
    usage: Schema.Unknown,
    provider: Schema.optional(Schema.String),
    model: Schema.optional(Schema.String),
  })
)

const decodeThinkingLevel = Schema.decodeUnknownOption(
  Schema.Struct({ thinkingLevel: Schema.String })
)

const decodeContextEdit = Schema.decodeUnknownOption(Schema.Struct({ targetId: Schema.String }))

const decodeCustomMessage = Schema.decodeUnknownOption(
  Schema.Struct({ customType: Schema.String, content: Schema.optional(MessageContent) })
)

const OptionalText = Schema.optional(Schema.NullOr(Schema.String))
const OptionalNumber = Schema.optional(Schema.NullOr(Schema.Finite))

const LineNumber = Schema.optional(
  Schema.NullOr(Schema.Union([Schema.Finite, Schema.FiniteFromString]))
)
const decodeLineRange = Schema.decodeUnknownOption(
  Schema.Struct({ offset: LineNumber, limit: LineNumber })
)
const decodePathInput = Schema.decodeUnknownOption(Schema.Struct({ path: Schema.String }))
const decodeShellInput = Schema.decodeUnknownOption(Schema.Struct({ command: Schema.String }))
const decodeGitInspectInput = Schema.decodeUnknownOption(
  Schema.Struct({
    operation: Schema.String,
    path: OptionalText,
    ref: OptionalText,
    limit: OptionalNumber,
  })
)

const AttemptRecord = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(['agent', 'process']),
  owner: Schema.Struct({ parent: Schema.optional(Schema.String) }),
  coordinator: Schema.optional(Schema.Boolean),
  sessionFile: Schema.optional(Schema.String),
})
export type AttemptRecord = typeof AttemptRecord.Type

const decodeAttempt = Schema.decodeUnknownOption(AttemptRecord)
const decodeAttemptList = Schema.decodeUnknownOption(
  Schema.Struct({ records: Schema.Array(Schema.Unknown) })
)
const decodeItems = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.Unknown)))

const TruncationSchema = Schema.Struct({
  truncated: Schema.Boolean,
  truncatedBy: Schema.NullOr(Schema.Literals(['lines', 'bytes'])),
  outputLines: Schema.Finite,
  firstLineExceedsLimit: Schema.Boolean,
})
export type TruncationDetails = typeof TruncationSchema.Type
const decodeTruncation = Schema.decodeUnknownOption(TruncationSchema)

type ToolInput =
  | {
      readonly kind: 'read'
      readonly path: string
      readonly range:
        | { readonly offset: number | undefined; readonly limit: number | undefined }
        | 'undecodable'
    }
  | { readonly kind: 'file-write'; readonly path: string }
  | { readonly kind: 'shell'; readonly command: string }
  | {
      readonly kind: 'git-inspect'
      readonly operation: string
      readonly path: string | undefined
      readonly ref: string | undefined
      readonly limit: number | undefined
    }
  | { readonly kind: 'other' }

export interface ToolCall {
  readonly id: string
  readonly name: string
  readonly input: ToolInput
}

export type Block = { readonly type: 'text'; readonly text: string } | { readonly type: 'other' }

type CwdRecord =
  | { readonly kind: 'unstated' }
  | { readonly kind: 'none' }
  | { readonly kind: 'path'; readonly path: string }

type Payload =
  | {
      readonly kind: 'request'
      readonly usage: Usage
      readonly model: string | undefined
      readonly effort: string | undefined
      readonly stopReason: string | undefined
      readonly latencyMs: number
      readonly calls: readonly ToolCall[]
    }
  | {
      readonly kind: 'result'
      readonly callId: string
      readonly tool: string
      readonly isError: boolean
      readonly blocks: readonly Block[]
      readonly truncation: TruncationDetails | 'malformed' | undefined
      readonly attempt: AttemptRecord | undefined
      readonly listedAttempts: readonly AttemptRecord[]
      readonly usage: Usage | undefined
    }
  | { readonly kind: 'user'; readonly skill: string | undefined }
  | { readonly kind: 'system'; readonly cwd: CwdRecord }
  | {
      readonly kind: 'compaction'
      readonly tokensBefore: number | undefined
      readonly usage: Usage
      readonly cwd: CwdRecord
    }
  | { readonly kind: 'branch-summary'; readonly usage: Usage }
  | { readonly kind: 'standalone'; readonly usage: Usage; readonly model: string | undefined }
  | { readonly kind: 'thinking-level'; readonly level: string }
  | { readonly kind: 'context-edit'; readonly target: string }
  | { readonly kind: 'handoff' }
  | { readonly kind: 'outcome'; readonly attempts: readonly AttemptRecord[] }
  | { readonly kind: 'other' }

export type Entry = Payload & {
  readonly id: string
  readonly parentId: string | null
  readonly at: number
  readonly copied: boolean
}

export interface SessionRecord {
  readonly ref: string
  readonly name: string
  readonly scope: 'lead' | 'child'
  readonly entries: readonly Entry[]
  readonly byId: ReadonlyMap<string, Entry>
  readonly undecodable: number
}

const modelName = (provider: string | undefined, model: string | undefined) => {
  if (model === undefined || provider === undefined) return model
  return `${provider}/${model}`
}

const SKILL_BLOCK = /^<skill name="([^"]+)" location="/
const CWD_SECTION = /^<cwd>\n([\s\S]*)\n<\/cwd>$/
const UNSTATED: CwdRecord = { kind: 'unstated' }
const NONE: CwdRecord = { kind: 'none' }
const OTHER_INPUT: ToolInput = { kind: 'other' }

const firstText = (content: typeof MessageContent.Type): string | undefined =>
  typeof content === 'string'
    ? content
    : Option.getOrUndefined(Option.map(decodeText(content[0]), block => block.text))

const sectionCwd = (section: string | null | undefined, missing: CwdRecord): CwdRecord => {
  if (section === undefined) return missing
  if (section === null) return NONE
  return { kind: 'path', path: CWD_SECTION.exec(section)?.[1] ?? section }
}

const patchCwd = (prompt: typeof SystemPrompt.Type): CwdRecord =>
  sectionCwd(prompt.sections?.cwd, prompt.replace === true ? NONE : UNSTATED)

const checkpointCwd = (prompt: typeof SystemPrompt.Type): CwdRecord =>
  sectionCwd(prompt.sections?.cwd, NONE)

const inputOf = (name: string, args: unknown): ToolInput => {
  switch (name) {
    case 'read':
      return Option.match(decodePathInput(args), {
        onNone: () => OTHER_INPUT,
        onSome: ({ path }) => ({
          kind: 'read',
          path,
          range: Option.match(decodeLineRange(args), {
            onNone: () => 'undecodable' as const,
            onSome: ({ offset, limit }) => ({
              offset: offset ?? undefined,
              limit: limit ?? undefined,
            }),
          }),
        }),
      })
    case 'edit':
    case 'write':
      return Option.match(decodePathInput(args), {
        onNone: () => OTHER_INPUT,
        onSome: input => ({ kind: 'file-write', path: input.path }),
      })
    case 'bash':
      return Option.match(decodeShellInput(args), {
        onNone: () => OTHER_INPUT,
        onSome: input => ({ kind: 'shell', command: input.command }),
      })
    case 'git_inspect':
      return Option.match(decodeGitInspectInput(args), {
        onNone: () => OTHER_INPUT,
        onSome: input => ({
          kind: 'git-inspect',
          operation: input.operation,
          path: input.path ?? undefined,
          ref: input.ref ?? undefined,
          limit: input.limit ?? undefined,
        }),
      })
    default:
      return OTHER_INPUT
  }
}

const attemptsIn = (values: readonly unknown[]): AttemptRecord[] =>
  values.flatMap(value => Option.toArray(decodeAttempt(value)))

const listedAttempts = (details: unknown): AttemptRecord[] =>
  Option.match(decodeAttemptList(details), {
    onNone: () => [],
    onSome: list => attemptsIn(list.records),
  })

const truncationOf = (details: unknown): TruncationDetails | 'malformed' | undefined =>
  Predicate.hasProperty(details, 'truncation')
    ? Option.getOrElse(decodeTruncation(details.truncation), () => 'malformed' as const)
    : undefined

const outcomeAttempts = (content: typeof MessageContent.Type | undefined): AttemptRecord[] => {
  const text = content === undefined ? undefined : firstText(content)
  if (text === undefined) return []
  return Option.match(decodeItems(text.slice(text.lastIndexOf('\n') + 1)), {
    onNone: () => [],
    onSome: attemptsIn,
  })
}

const resultPayload = (value: unknown): Payload | undefined =>
  Option.getOrUndefined(
    Option.map(decodeToolResult(value), ({ message }): Payload => {
      const work = message.toolName === 'work'
      return {
        kind: 'result',
        callId: message.toolCallId,
        tool: message.toolName,
        isError: message.isError,
        blocks: message.content.map(block =>
          Option.match(decodeText(block), {
            onNone: (): Block => ({ type: 'other' }),
            onSome: ({ text }): Block => ({ type: 'text', text }),
          })
        ),
        truncation: truncationOf(message.details),
        attempt: work ? Option.getOrUndefined(decodeAttempt(message.details)) : undefined,
        listedAttempts: work ? listedAttempts(message.details) : [],
        usage: message.usage === undefined ? undefined : usageOf(message.usage),
      }
    })
  )

const messagePayload = (value: unknown, at: number): Payload | undefined => {
  const role = Option.getOrUndefined(decodeRole(value))?.message.role
  switch (role) {
    case 'assistant':
      return Option.getOrUndefined(
        Option.map(
          decodeAssistant(value),
          ({ message }): Payload => ({
            kind: 'request',
            usage: usageOf(message.usage),
            model: modelName(message.provider, message.model),
            effort: message.thinkingLevel,
            stopReason: message.stopReason,
            latencyMs: at - message.timestamp,
            calls: message.content.flatMap(block =>
              Option.match(decodeToolCall(block), {
                onNone: () => [],
                onSome: call => [
                  { id: call.id, name: call.name, input: inputOf(call.name, call.arguments) },
                ],
              })
            ),
          })
        )
      )
    case 'toolResult':
      return resultPayload(value)
    case 'user':
      return Option.getOrUndefined(
        Option.map(
          decodeUser(value),
          ({ message }): Payload => ({
            kind: 'user',
            skill: SKILL_BLOCK.exec(firstText(message.content) ?? '')?.[1],
          })
        )
      )
    case 'system':
      return Option.getOrUndefined(
        Option.map(
          decodeSystem(value),
          ({ message }): Payload => ({ kind: 'system', cwd: patchCwd(message) })
        )
      )
    case undefined:
      return undefined
    default:
      return { kind: 'other' }
  }
}

const customMessagePayload = (value: unknown): Payload | undefined =>
  Option.getOrUndefined(
    Option.map(decodeCustomMessage(value), (entry): Payload => {
      if (entry.customType === 'dev/workspace-handoff') return { kind: 'handoff' }
      if (entry.customType === 'dev/work-outcome')
        return { kind: 'outcome', attempts: outcomeAttempts(entry.content) }
      return { kind: 'other' }
    })
  )

const payloadOf = (type: string, value: unknown, at: number): Payload | undefined => {
  switch (type) {
    case 'message':
      return messagePayload(value, at)
    case 'compaction':
      return Option.getOrUndefined(
        Option.map(decodeCompaction(value), entry => ({
          kind: 'compaction',
          tokensBefore: entry.tokensBefore,
          usage: usageOf(entry.usage),
          cwd: entry.systemMessage === undefined ? UNSTATED : checkpointCwd(entry.systemMessage),
        }))
      )
    case 'branch_summary':
      return Option.getOrUndefined(
        Option.map(decodeSummary(value), entry => ({
          kind: 'branch-summary',
          usage: usageOf(entry.usage),
        }))
      )
    case 'usage':
      return Option.getOrUndefined(
        Option.map(decodeStandaloneUsage(value), entry => ({
          kind: 'standalone',
          usage: usageOf(entry.usage),
          model: modelName(entry.provider, entry.model),
        }))
      )
    case 'thinking_level_change':
      return Option.getOrUndefined(
        Option.map(decodeThinkingLevel(value), entry => ({
          kind: 'thinking-level',
          level: entry.thinkingLevel,
        }))
      )
    case 'context_edit':
      return Option.getOrUndefined(
        Option.map(decodeContextEdit(value), entry => ({
          kind: 'context-edit',
          target: entry.targetId,
        }))
      )
    case 'custom_message':
      return customMessagePayload(value)
    default:
      return { kind: 'other' }
  }
}

const decodeSession = (
  ref: string,
  name: string,
  scope: SessionRecord['scope'],
  content: string
): SessionRecord => {
  const [first, ...rest] = content.split('\n').filter(line => line.trim() !== '')
  const header = Option.getOrUndefined(Option.flatMap(decodeJson(first ?? ''), decodeHeader))
  const forkedAt =
    header?.parentSession === undefined ? undefined : DateTime.toEpochMillis(header.timestamp)
  let undecodable = first === undefined || header !== undefined ? 0 : 1
  const entries: Entry[] = []
  for (const line of rest) {
    const value = decodeJson(line)
    const envelope = Option.getOrUndefined(Option.flatMap(value, decodeEnvelope))
    if (envelope === undefined) {
      undecodable += 1
      continue
    }
    const at = DateTime.toEpochMillis(envelope.timestamp)
    const payload = payloadOf(envelope.type, Option.getOrUndefined(value), at)
    if (payload === undefined) undecodable += 1
    entries.push({
      ...(payload ?? { kind: 'other' }),
      id: envelope.id,
      parentId: envelope.parentId,
      at,
      copied: forkedAt !== undefined && at < forkedAt,
    })
  }
  return {
    ref,
    name,
    scope,
    entries,
    byId: new Map(entries.map(entry => [entry.id, entry])),
    undecodable,
  }
}

export function* ancestors(session: SessionRecord, entry: Entry): Generator<Entry> {
  const visited = new Set([entry.id])
  let parent = entry.parentId === null ? undefined : session.byId.get(entry.parentId)
  while (parent !== undefined && !visited.has(parent.id)) {
    visited.add(parent.id)
    yield parent
    parent = parent.parentId === null ? undefined : session.byId.get(parent.parentId)
  }
}

export const readSessions = Effect.fn('readSessions')(function* (
  dataHome: string,
  directory: string,
  scope: SessionRecord['scope']
) {
  const fs = yield* FileSystem.FileSystem
  const path = join(dataHome, directory)
  if (!(yield* fs.exists(path))) return []
  const names = (yield* fs.readDirectory(path)).filter(name => name.endsWith('.jsonl')).toSorted()
  return yield* Effect.forEach(names, name =>
    fs
      .readFileString(join(path, name))
      .pipe(Effect.map(content => decodeSession(`${directory}/${name}`, name, scope, content)))
  )
})
