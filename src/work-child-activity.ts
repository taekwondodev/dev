import * as Predicate from 'effect/Predicate'
import type * as Pi from '@earendil-works/pi-coding-agent'
import { ACTIVITY_TEXT_LIMIT, type ChildActivity, type ChildLive } from './work-domain.ts'
import { redactSecrets } from './error-text.ts'

export const ACTIVITY_INTERVAL_MS = 200

interface RunningTool {
  readonly id: string
  readonly activity: ChildActivity
}

export interface ActivityState {
  readonly turns: number
  readonly tools: readonly RunningTool[]
  readonly stream?: 'thinking' | 'writing'
  readonly retrying?: string
}

export const initialActivity: ActivityState = { turns: 0, tools: [] }

const PATH_TOOLS = new Set(['read', 'ls', 'edit', 'write'])
const PATTERN_TOOLS = new Set(['grep', 'find'])
const OPAQUE_SEGMENT_LENGTH = 20

const isOpaqueSegment = (segment: string): boolean =>
  segment.length >= OPAQUE_SEGMENT_LENGTH && /\d/.test(segment) && /[A-Za-z]/.test(segment)

export const activityText = (text: string): string => {
  let kept = ''
  for (const point of text.replaceAll(/\p{Cc}+/gu, ' ')) {
    if (kept.length + point.length > ACTIVITY_TEXT_LIMIT) break
    kept += point
  }
  return kept
}

const field = (args: unknown, name: string): string | undefined => {
  if (!Predicate.isObject(args) || !Predicate.hasProperty(args, name)) return undefined
  const value = args[name]
  return typeof value === 'string' && value !== '' ? value : undefined
}

const publicUrl = (value: string | undefined): string | undefined => {
  if (value === undefined || !URL.canParse(value)) return undefined
  const url = new URL(value)
  const path = url.pathname
    .split('/')
    .map(segment => (isOpaqueSegment(segment) ? '[redacted]' : segment))
    .join('/')
  return `${url.protocol}//${url.host}${path}`
}

export const toolTarget = (name: string, args: unknown): string | undefined => {
  let target: string | undefined
  if (PATH_TOOLS.has(name)) target = field(args, 'path')
  else if (PATTERN_TOOLS.has(name)) target = field(args, 'pattern')
  else if (name === 'git_inspect') {
    const operation = field(args, 'operation')
    const path = field(args, 'path')
    target = operation === undefined ? undefined : [operation, path].filter(Boolean).join(' ')
  } else if (name === 'read_url') target = publicUrl(field(args, 'url'))
  return target === undefined ? undefined : activityText(redactSecrets(target))
}

const toolActivity = (name: string, args: unknown): ChildActivity => {
  const target = toolTarget(name, args)
  return {
    kind: 'tool',
    name: activityText(name),
    ...(target === undefined ? {} : { target }),
  }
}

const streamOf = (
  event: Extract<Pi.AgentSessionEvent, { type: 'message_update' }>
): ActivityState['stream'] => {
  switch (event.assistantMessageEvent.type) {
    case 'thinking_start':
      return 'thinking'
    case 'text_start':
    case 'toolcall_start':
      return 'writing'
    default:
      return undefined
  }
}

const withoutStream = ({ turns, tools }: ActivityState): ActivityState => ({ turns, tools })

export const reduceActivity = (
  state: ActivityState,
  event: Pi.AgentSessionEvent
): ActivityState => {
  switch (event.type) {
    case 'message_update': {
      const stream = streamOf(event)
      if (event.message.role !== 'assistant' || stream === undefined) return state
      return stream === state.stream && state.retrying === undefined
        ? state
        : { turns: state.turns, tools: state.tools, stream }
    }
    case 'message_end':
      return event.message.role === 'assistant' && state.stream !== undefined
        ? withoutStream(state)
        : state
    case 'tool_execution_start':
      return {
        turns: state.turns,
        tools: [
          ...state.tools,
          { id: event.toolCallId, activity: toolActivity(event.toolName, event.args) },
        ],
        ...(state.stream === undefined ? {} : { stream: state.stream }),
      }
    case 'tool_execution_end':
      return state.tools.some(tool => tool.id === event.toolCallId)
        ? { ...state, tools: state.tools.filter(tool => tool.id !== event.toolCallId) }
        : state
    case 'turn_end':
      return { turns: state.turns + 1, tools: state.tools }
    case 'auto_retry_start':
      return {
        turns: state.turns,
        tools: [],
        retrying: activityText(redactSecrets(event.errorMessage)),
      }
    case 'auto_retry_end':
      return state.retrying === undefined ? state : withoutStream(state)
    case 'agent_end':
      return { turns: state.turns, tools: [] }
    default:
      return state
  }
}

export const liveLevel = (state: ActivityState): ChildLive => {
  const tool = state.tools.at(-1)?.activity
  let activity: ChildActivity | undefined = tool
  if (activity === undefined && state.retrying !== undefined)
    activity = { kind: 'retrying', message: state.retrying }
  else if (activity === undefined && state.stream !== undefined) activity = { kind: state.stream }
  return activity === undefined ? { turns: state.turns } : { turns: state.turns, activity }
}

const sameLevel = (left: ChildLive | undefined, right: ChildLive): boolean =>
  left !== undefined && JSON.stringify(left) === JSON.stringify(right)

export interface ActivityClock {
  readonly now: () => number
  readonly schedule: (run: () => void, delayMs: number) => () => void
}

const systemClock: ActivityClock = {
  now: () => Date.now(),
  schedule: (run, delayMs) => {
    const timer = setTimeout(run, delayMs)
    timer.unref()
    return () => clearTimeout(timer)
  },
}

export interface ActivitySender {
  readonly offer: (level: ChildLive) => void
  readonly stop: () => void
}

export const makeActivitySender = (
  send: (level: ChildLive) => void,
  clock: ActivityClock = systemClock,
  intervalMs = ACTIVITY_INTERVAL_MS
): ActivitySender => {
  let sent: ChildLive | undefined
  let sentAt = Number.NEGATIVE_INFINITY
  let latest: ChildLive | undefined
  let cancel: (() => void) | undefined
  let stopped = false
  const flush = (): void => {
    cancel = undefined
    if (stopped || latest === undefined || sameLevel(sent, latest)) return
    sent = latest
    sentAt = clock.now()
    send(latest)
  }
  return {
    offer: level => {
      if (stopped) return
      latest = level
      if (cancel !== undefined) return
      if (sameLevel(sent, level)) return
      const wait = sentAt + intervalMs - clock.now()
      if (wait <= 0) flush()
      else cancel = clock.schedule(flush, wait)
    },
    stop: () => {
      stopped = true
      cancel?.()
      cancel = undefined
    },
  }
}
