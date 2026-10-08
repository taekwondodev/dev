import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Effect, Predicate, Schema } from 'effect'
import { errorText } from '../../src/error-text.ts'
import { ChildError, type ChildServeOptions } from '../../src/pi-child.ts'
import {
  emitReply,
  makeOfflineModel,
  type ScriptedContent,
  type ScriptedStreamParts,
  type StreamSimple,
} from '../workspace/workspace-check-support.ts'

export const CHILD_MODEL = 'work-child-offline/work-child'
export const MODEL_CALLS = 'model-calls.log'
export const SCRIPT_MARKER = 'SCRIPT '
export const USAGE_MARKER = 'USAGE '
export const RAW_MARKER = 'RAW '
export const RAW_ON_CANCEL_MARKER = 'RAW-ON-CANCEL '
export const RAW_AFTER_REPLY_MARKER = 'RAW-AFTER-REPLY '
export const DROP_FIRST_ACK = 'DROP-FIRST-ACK'
export const HOLD_CANCEL = 'HOLD-CANCEL'
export const ipcLog = (dataHome: string, attemptId: string): string =>
  join(dataHome, `ipc-${attemptId}.jsonl`)
export const cancelLog = (dataHome: string, attemptId: string): string =>
  join(dataHome, `cancel-${attemptId}.log`)

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

export const directive = (text: string, marker: string): unknown => {
  const line = text.split('\n').find(candidate => candidate.startsWith(marker))
  return line === undefined ? undefined : decodeJson(line.slice(marker.length))
}

const Step = Schema.Union([
  Schema.Array(Schema.Unknown),
  Schema.Struct({
    delayMs: Schema.optional(Schema.Finite),
    content: Schema.optional(Schema.Array(Schema.Unknown)),
    error: Schema.optional(Schema.String),
  }),
])
const decodeScript = Schema.decodeUnknownSync(Schema.Array(Step))
const isContent = (step: typeof Step.Type): step is readonly unknown[] => Array.isArray(step)
const decodeUsage = Schema.decodeUnknownSync(
  Schema.Struct({ input: Schema.Finite, output: Schema.Finite })
)

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .flatMap(part =>
      Predicate.isObject(part) && part.type === 'text' && typeof part.text === 'string'
        ? [part.text]
        : []
    )
    .join('')
}
const systemTextOf = (message: unknown): string[] =>
  Predicate.isObject(message) && message.role === 'system'
    ? [
        textOf(message.content),
        ...(Predicate.isObject(message.sections)
          ? Object.values(message.sections).filter(section => typeof section === 'string')
          : []),
      ]
    : []

const scriptedStream = (calls: string, attemptId: string) => {
  let assignment: string | undefined
  let turn = 0
  return (parts: ScriptedStreamParts): StreamSimple =>
    (_model, context, options) => {
      const messages: readonly unknown[] = context.messages
      const byRole = (role: string) =>
        messages.flatMap(message =>
          Predicate.isObject(message) && message.role === role ? [textOf(message.content)] : []
        )
      const [first = '', ...later] = byRole('user')
      const system = [
        'systemPrompt' in context && typeof context.systemPrompt === 'string'
          ? context.systemPrompt
          : '',
        ...messages.flatMap(systemTextOf),
      ].join('\n')
      if (system.includes('You are a context summarization assistant.')) {
        appendFileSync(calls, `summary:${attemptId}\n`)
        return emitReply(
          parts,
          {
            content: [{ type: 'text', text: 'Scripted review summary' }],
            stopReason: 'stop',
            delayMs: 20,
          },
          options?.signal
        )
      }
      appendFileSync(calls, `${attemptId}\n`)
      assignment ??= first
      const script = directive(assignment, SCRIPT_MARKER)
      const step = (script === undefined ? [] : decodeScript(script))[turn++]
      const usage = directive(assignment, USAGE_MARKER)
      const metered: ScriptedStreamParts =
        usage === undefined
          ? parts
          : {
              ...parts,
              assistantMessage: (content, stopReason) => {
                const { input, output } = decodeUsage(usage)
                const message = parts.assistantMessage(content, stopReason)
                return {
                  ...message,
                  usage: { ...message.usage, input, output, totalTokens: input + output },
                }
              },
            }
      const timed = step !== undefined && isContent(step) ? { content: step } : step
      if (timed?.error !== undefined) {
        const stream = metered.eventStreams.createAssistantMessageEventStream()
        stream.push({
          type: 'error',
          reason: 'error',
          error: { ...metered.assistantMessage([], 'error'), errorMessage: timed.error },
        })
        stream.end()
        return stream
      }
      const echo: ScriptedContent = [
        {
          type: 'text',
          text: [
            'MODEL-SAW',
            assignment,
            `SYSTEM-SKILL-BLOCKS ${system.split('<skill name=').length - 1}`,
            'SYSTEM-INSTRUCTIONS',
            ...(system.match(/FIXTURE-INSTRUCTIONS [^\n]*/g) ?? []),
            'TOOL-RESULTS',
            ...byRole('toolResult'),
            'LATER-MESSAGES',
            ...later,
          ].join('\n'),
        },
      ]
      const content = timed?.content === undefined ? echo : (timed.content as ScriptedContent)
      const stopReason = content.some(part => part.type === 'toolCall') ? 'toolUse' : 'stop'
      return emitReply(
        metered,
        { content, stopReason, delayMs: timed?.delayMs ?? 10 },
        options?.signal
      )
    }
}

export const scriptedModelRuntime: NonNullable<ChildServeOptions['modelRuntime']> = (
  { api, packageInfo },
  request
) =>
  Effect.tryPromise({
    try: async () => {
      const { modelRuntime } = await makeOfflineModel({
        pi: api,
        importFromPi: path => import(pathToFileURL(join(packageInfo.root, path)).href),
        fixture: request.dataHome,
        id: 'work-child',
        stream: scriptedStream(join(request.dataHome, MODEL_CALLS), request.owner.attemptId),
      })
      return modelRuntime
    },
    catch: cause => new ChildError({ message: errorText(cause), cause }),
  })
