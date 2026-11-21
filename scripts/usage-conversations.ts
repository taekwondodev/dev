import { posix } from 'node:path'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import { withoutControls } from '../src/display-text.ts'
import { redactSecrets } from '../src/error-text.ts'
import { size } from './usage-charts.ts'
import { GIT_TRUNCATED } from './usage-facts.ts'
import { UsageProfileError } from './usage-profile.ts'
import {
  type AttemptRecord,
  type Entry,
  readSession,
  readSessions,
  type SessionRecord,
  sessionNames,
  type ToolCall,
} from './usage-sessions.ts'

type ResultEntry = Extract<Entry, { kind: 'result' }>

const DIRECTORIES = [
  { directory: 'sessions', scope: 'lead' },
  { directory: 'child-sessions', scope: 'child' },
] as const

const KIND: Record<SessionRecord['scope'], string> = { lead: 'main', child: 'delegated' }

const TEXT_LIMIT = 200
const REQUEST_LIMIT = 80
const SUMMARY_LIMIT = 100

export const conversationRef = (name: string): string =>
  posix
    .basename(name)
    .replace(/\.jsonl$/, '')
    .slice(-12)

const shown = (text: string): string => withoutControls(redactSecrets(text))

const oneLine = (text: string, limit: number): string => {
  const characters = [...shown(text.replaceAll(/\s+/g, ' ').trim())]
  return characters.length > limit ? `${characters.slice(0, limit).join('')}…` : characters.join('')
}

const isoOf = (at: number) => DateTime.formatIso(DateTime.makeUnsafe(at))
const minuteOf = (at: number | undefined) =>
  at === undefined ? 'unknown start    ' : `${isoOf(at).slice(0, 16).replace('T', ' ')}Z`

const requestText = (skill: string | undefined, text: string, limit: number): string =>
  [skill === undefined ? undefined : `[skill ${shown(skill)}]`, oneLine(text, limit)]
    .filter(part => part !== undefined && part !== '')
    .join(' ')

interface ConversationRow {
  readonly name: string
  readonly scope: SessionRecord['scope']
  readonly started: number | undefined
  readonly cwd: string | undefined
  readonly firstRequest: string
  readonly userMessages: number
  readonly toolCalls: number
}

const rowOf = (session: SessionRecord): ConversationRow => {
  const users = session.entries.filter(entry => entry.kind === 'user')
  const [first] = users
  return {
    name: session.name,
    scope: session.scope,
    started: session.started ?? session.entries[0]?.at,
    cwd: session.cwd === undefined ? undefined : shown(session.cwd),
    firstRequest: first === undefined ? '' : requestText(first.skill, first.text, REQUEST_LIMIT),
    userMessages: users.length,
    toolCalls: session.entries.reduce(
      (total, entry) => (entry.kind === 'request' ? total + entry.calls.length : total),
      0
    ),
  }
}

const newestFirst = (a: ConversationRow, b: ConversationRow) =>
  (b.started ?? -Infinity) - (a.started ?? -Infinity) || b.name.localeCompare(a.name)

const rowLine = (row: ConversationRow): string =>
  [
    minuteOf(row.started),
    KIND[row.scope].padEnd(9),
    shown(conversationRef(row.name)),
    row.cwd ?? '(project not recorded)',
    `${row.userMessages} user, ${row.toolCalls} tool calls`,
    row.firstRequest === '' ? '(no request)' : row.firstRequest,
  ].join('  ')

const listText = (rows: readonly ConversationRow[]): string[] =>
  rows.toSorted(newestFirst).map(rowLine)

export const listConversations = Effect.fn('listConversations')(function* (dataHome: string) {
  const rows = (yield* Effect.forEach(
    DIRECTORIES,
    ({ directory, scope }) => readSessions(dataHome, directory, scope, rowOf),
    { concurrency: 1 }
  )).flat()
  if (rows.length === 0)
    return `No saved conversations in ${DIRECTORIES.map(({ directory }) => shown(posix.join(dataHome, directory))).join(' or ')}.\n`
  return `${[
    `${rows.length} saved conversations in ${shown(dataHome)}, newest first: start (UTC), main or delegated, reference, project, counts, first request. Pass a reference to --timeline.`,
    ...listText(rows),
  ].join('\n')}\n`
})

interface SavedFile {
  readonly directory: (typeof DIRECTORIES)[number]['directory']
  readonly scope: SessionRecord['scope']
  readonly name: string
}

const resolveFile = Effect.fn('resolveFile')(function* (dataHome: string, reference: string) {
  const part = posix.basename(reference.trim())
  const files: SavedFile[] = (yield* Effect.forEach(
    DIRECTORIES,
    ({ directory, scope }) =>
      sessionNames(dataHome, directory).pipe(
        Effect.map(names => names.map(name => ({ directory, scope, name })))
      ),
    { concurrency: 1 }
  )).flat()
  const matches = part === '' ? [] : files.filter(file => file.name.includes(part))
  const [match, ...others] = matches
  if (match === undefined)
    return yield* new UsageProfileError({
      message: `No saved conversation in ${shown(dataHome)} matches "${shown(reference)}". Run npm run profile -- --conversations to list them.`,
    })
  if (others.length === 0) return match
  const rows = (yield* Effect.forEach(
    matches,
    file => readSession(dataHome, file.directory, file.scope, file.name),
    { concurrency: 1 }
  )).flatMap(session => (session === undefined ? [] : [rowOf(session)]))
  return yield* new UsageProfileError({
    message: [
      `"${shown(reference)}" matches ${matches.length} saved conversations; nothing was printed. Pass one of these references:`,
      ...listText(rows),
    ].join('\n'),
  })
})

const CODEMODE_CUT = /^Warning: truncated output \(original token count: /m

const wasCut = (result: ResultEntry): boolean => {
  const { truncation } = result
  if (result.cutByTool) return true
  if (
    truncation !== undefined &&
    truncation !== 'malformed' &&
    (truncation.truncated || truncation.firstLineExceedsLimit)
  )
    return true
  if (result.tool !== 'codemode' && result.tool !== 'git_inspect') return false
  const text = result.blocks.map(block => (block.type === 'text' ? block.text : '')).join('\n')
  return result.tool === 'codemode' ? CODEMODE_CUT.test(text) : GIT_TRUNCATED.test(text)
}

const internalCalls = (result: ResultEntry | undefined): string => {
  const nested = result?.nestedCalls
  if (nested === undefined || nested === 'missing') return 'internal calls not recorded'
  if (nested === 'malformed') return 'internal calls unreadable'
  const byTool = new Map<string, { calls: number; error: number; unfinished: number }>()
  for (const call of nested.calls) {
    const counts = byTool.get(call.name) ?? { calls: 0, error: 0, unfinished: 0 }
    counts.calls += 1
    if (call.status !== 'ok') counts[call.status] += 1
    byTool.set(call.name, counts)
  }
  const counted = [...byTool].map(([tool, { calls, error, unfinished }]) => {
    const failures = [
      error === 0 ? '' : `${error} error`,
      unfinished === 0 ? '' : `${unfinished} unfinished`,
    ].filter(part => part !== '')
    return `${shown(tool)} ${calls}${failures.length === 0 ? '' : ` (${failures.join(', ')})`}`
  })
  const unreadable = nested.malformedCalls === 0 ? [] : [`${nested.malformedCalls} unreadable`]
  const incomplete = nested.complete ? [] : ['list incomplete']
  const parts = [...counted, ...unreadable, ...incomplete]
  return parts.length === 0 ? 'no internal calls' : parts.join(', ')
}

const delegatedConversations = (session: SessionRecord): ReadonlyMap<string, string> => {
  const attempts = session.entries.flatMap((entry): readonly AttemptRecord[] => {
    if (entry.kind === 'outcome') return entry.attempts
    if (entry.kind === 'result' && entry.attempt !== undefined) return [entry.attempt]
    return []
  })
  return new Map(
    attempts.flatMap(attempt =>
      attempt.sessionFile === undefined
        ? []
        : [[attempt.id, shown(conversationRef(attempt.sessionFile))]]
    )
  )
}

const toolLine = (
  call: ToolCall,
  result: ResultEntry | undefined,
  delegated: ReadonlyMap<string, string>
): string => {
  const outcome =
    result === undefined
      ? 'no result'
      : `${result.isError ? 'error' : 'returned'} ${size(result.bytes)}${wasCut(result) ? ', cut' : ''}`
  const child = result?.attempt === undefined ? undefined : delegated.get(result.attempt.id)
  const detail = [
    call.name === 'codemode' ? internalCalls(result) : oneLine(call.argumentSummary, SUMMARY_LIMIT),
    child === undefined ? '' : `→ conversation ${child}`,
  ]
    .filter(part => part !== '')
    .join(' ')
  return `${shown(call.name)} ${outcome}${detail === '' ? '' : `: ${detail}`}`
}

const STOPPED = new Set(['aborted', 'error'])

const entryLines = (
  entry: Entry,
  results: ReadonlyMap<string, ResultEntry>,
  delegated: ReadonlyMap<string, string>
): string[] => {
  switch (entry.kind) {
    case 'user':
      return [`user: ${requestText(entry.skill, entry.text, TEXT_LIMIT)}`]
    case 'request': {
      if (entry.calls.length > 0)
        return entry.calls.map(call => toolLine(call, results.get(call.id), delegated))
      const stopped =
        entry.stopReason !== undefined && STOPPED.has(entry.stopReason)
          ? ` (${entry.stopReason})`
          : ''
      const text = oneLine(entry.text, TEXT_LIMIT)
      return text === '' ? [] : [`answer${stopped}: ${text}`]
    }
    case 'compaction':
      return [
        `compaction${entry.tokensBefore === undefined ? '' : `, ${Math.round(entry.tokensBefore).toLocaleString('en-US')} tokens before`}`,
      ]
    default:
      return []
  }
}

const timelineText = (session: SessionRecord, file: string): string => {
  const results = new Map<string, ResultEntry>()
  for (const entry of session.entries)
    if (entry.kind === 'result' && !results.has(entry.callId)) results.set(entry.callId, entry)
  const delegated = delegatedConversations(session)
  const row = rowOf(session)
  let day: string | undefined
  const lines = session.entries.flatMap(entry =>
    entryLines(entry, results, delegated).map(line => {
      const iso = isoOf(entry.at)
      const time = iso.slice(11, 19)
      const stamp = iso.slice(0, 10) === day ? time : `${iso.slice(0, 10)} ${time}`
      day = iso.slice(0, 10)
      return `${stamp} ${line}`
    })
  )
  return `${[
    `Conversation ${shown(conversationRef(session.name))} (${KIND[session.scope]}), started ${minuteOf(row.started)} in ${row.cwd ?? '(project not recorded)'}`,
    `File: ${shown(file)}`,
    `${row.userMessages} user messages and ${row.toolCalls} tool calls${session.undecodable === 0 ? '' : `; ${session.undecodable} unreadable lines skipped`}. Times are UTC; text is cut to ${TEXT_LIMIT} characters; tool results show only how they ended and their size, never their content; control characters print as ?.`,
    ...lines,
  ].join('\n')}\n`
}

export const conversationTimeline = Effect.fn('conversationTimeline')(function* (
  dataHome: string,
  reference: string
) {
  const file = yield* resolveFile(dataHome, reference)
  const session = yield* readSession(dataHome, file.directory, file.scope, file.name)
  if (session === undefined)
    return yield* new UsageProfileError({
      message: `Saved conversation ${file.directory}/${shown(file.name)} disappeared before it could be read; automatic cleanup may have removed it.`,
    })
  return timelineText(session, posix.join(dataHome, file.directory, file.name))
})
