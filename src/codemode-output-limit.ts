import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as Effect from 'effect/Effect'
import * as Predicate from 'effect/Predicate'
import type * as Pi from '@earendil-works/pi-coding-agent'
import type * as CodemodeSource from '../node_modules/@earendil-works/pi-codemode/dist/source.js'
import { CODEMODE_TOOL, isIntegratedCodemode } from './integrated-tools.ts'
import { PiError, type PiApi, importPiModule } from './pi-runtime.ts'

export const CODEMODE_OUTPUT_TOKENS = 25_000

export type ParseCodemodeSource = typeof CodemodeSource.parseCodemodeSource

export const withOutputLimit = (parse: ParseCodemodeSource, source: string): string => {
  let parsed: CodemodeSource.ParsedCodemodeSource
  try {
    parsed = parse(source)
  } catch {
    return source
  }
  const { maxOutputTokens, timeoutMs } = parsed.options
  if (maxOutputTokens !== undefined) return source
  const options = JSON.stringify({
    ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }),
    max_output_tokens: CODEMODE_OUTPUT_TOKENS,
  })
  const line = `// @options: ${options}`
  return parsed.code === source ? `${line}\n${source}` : `${line}${parsed.code}`
}

const CUT_HEADER =
  /^Warning: truncated output \(original token count: (\d+)\)\nTotal output lines: (\d+)\n\n/
const OMISSION = /…(\d+) tokens truncated…/y
const CHARS_PER_TOKEN = 4
const LISTED_LINES = 5

export interface ReadLimits {
  readonly maxLines: number
  readonly maxBytes: number
}

const lineBreaks = (text: string): number => text.split('\n').length - 1

const SURROGATE_PAIR = /^[\uD800-\uDBFF][\uDC00-\uDFFF]$/

const splitsPair = (text: string, at: number) =>
  at > 0 && SURROGATE_PAIR.test(text.slice(at - 1, at + 1))

const keptByPi = (full: string, budget: number) => {
  const half = Math.floor(budget / 2)
  const tailStart = Math.max(0, full.length - (budget - half))
  return {
    head: splitsPair(full, half) ? half - 1 : half,
    tail: full.length - (splitsPair(full, tailStart) ? tailStart + 1 : tailStart),
    tokens: Math.ceil((full.length - budget) / CHARS_PER_TOKEN),
  }
}

const omittedSpan = (shown: string, full: string) => {
  const spans: { readonly start: number; readonly end: number }[] = []
  for (let at = shown.indexOf('…'); at !== -1; at = shown.indexOf('…', at + 1)) {
    OMISSION.lastIndex = at
    const marker = OMISSION.exec(shown)
    if (marker === null) continue
    const head = shown.slice(0, at)
    const tail = shown.slice(at + marker[0].length)
    const matchesPi = [0, 1, 2].some(extra => {
      const kept = keptByPi(full, head.length + tail.length + extra)
      return (
        kept.head === head.length && kept.tail === tail.length && kept.tokens === Number(marker[1])
      )
    })
    if (matchesPi && full.startsWith(head) && full.endsWith(tail))
      spans.push({ start: head.length, end: full.length - tail.length })
  }
  return spans.length === 1 ? spans[0] : undefined
}

const lineList = (lines: readonly number[]): string =>
  lines.length > LISTED_LINES
    ? `${lines.slice(0, LISTED_LINES).join(', ')} and ${lines.length - LISTED_LINES} more`
    : lines.join(', ')

export const withRecoveryHint = (
  text: string,
  full: string,
  path: string,
  read: ReadLimits
): string => {
  const cut = CUT_HEADER.exec(text)
  const total = lineBreaks(full) + 1
  if (
    cut === null ||
    Number(cut[1]) !== Math.ceil(full.length / CHARS_PER_TOKEN) ||
    Number(cut[2]) !== total
  )
    return text
  const [header] = cut
  const noteAt = text.lastIndexOf(`\n\n[Full output: ${path} (read with offset/limit)]`)
  if (noteAt < header.length) return text
  const span = omittedSpan(text.slice(header.length, noteAt), full)
  if (span === undefined) return text
  const endsVisibleLine =
    full[span.start] === '\n' && span.start > 0 && full[span.start - 1] !== '\n'
  const start = endsVisibleLine ? span.start + 1 : span.start
  if (start >= span.end) return text
  const first = lineBreaks(full.slice(0, start)) + 1
  const last = lineBreaks(full.slice(0, span.end - 1)) + 1
  const lineEnd = full.indexOf('\n', span.end - 1)
  const missing = full.slice(
    full.lastIndexOf('\n', start - 1) + 1,
    lineEnd === -1 ? full.length : lineEnd
  )
  const count = last - first + 1
  const size = `${read.maxBytes / 1024}KB`
  const long = missing
    .split('\n')
    .flatMap((line, index) => (Buffer.byteLength(line) > read.maxBytes ? [first + index] : []))
  const range =
    count === 1 ? `Line ${first} of ${total} is` : `Lines ${first}-${last} of ${total} are`
  const paging =
    count > read.maxLines || Buffer.byteLength(missing) > read.maxBytes
      ? ` One read returns at most ${read.maxLines} lines or ${size}, so continue from the offset it reports until you reach line ${last}.`
      : ''
  const unreadable = (lines: readonly number[]) => {
    if (lines.length === 0) return ''
    if (lines.length === 1)
      return ` Line ${lines[0]} is longer than ${size} and read cannot return it; continue from offset ${lines[0] + 1}.`
    return ` Lines ${lineList(lines)} are longer than ${size} and read cannot return them; when a read stops at one, continue from the offset just after it.`
  }
  const hint = `${range} missing or partly missing from this output. The full output is saved in ${path}; to see ${count === 1 ? 'it' : 'them'} without running the script again, read that file with offset ${first} and limit ${count}.${paging}${unreadable(long)}`
  return `${header.slice(0, -1)}${hint}\n\n${text.slice(header.length)}`
}

const savedOutputPath = (details: unknown): string | undefined =>
  Predicate.isObject(details) && typeof details.fullOutputPath === 'string'
    ? details.fullOutputPath
    : undefined

export const loadCodemodeOutputLimit = Effect.fnUntraced(function* (
  api: PiApi,
  packageRoot: string
) {
  const read = { maxLines: api.DEFAULT_MAX_LINES, maxBytes: api.DEFAULT_MAX_BYTES }
  if (!Number.isSafeInteger(read.maxLines) || !Number.isSafeInteger(read.maxBytes))
    return yield* new PiError({ message: 'Installed Pi does not provide its read limits' })
  const { parseCodemodeSource } = yield* Effect.tryPromise({
    try: () =>
      importPiModule<typeof CodemodeSource>(join(packageRoot, '../pi-codemode/dist/source.js')),
    catch: cause => new PiError({ message: 'Cannot load Pi codemode source parsing', cause }),
  })
  if (typeof parseCodemodeSource !== 'function')
    return yield* new PiError({ message: 'Installed Pi does not provide codemode source parsing' })
  const factory: Pi.ExtensionFactory = pi => {
    pi.on('tool_call', event => {
      if (event.toolName !== CODEMODE_TOOL) return undefined
      const tool = pi.getAllTools().find(candidate => candidate.name === event.toolName)
      const { code } = event.input
      if (isIntegratedCodemode(tool) && typeof code === 'string')
        event.input.code = withOutputLimit(parseCodemodeSource, code)
      return undefined
    })
    pi.on('tool_result', async event => {
      const path = event.toolName === CODEMODE_TOOL ? savedOutputPath(event.details) : undefined
      const tool = pi.getAllTools().find(candidate => candidate.name === event.toolName)
      if (path === undefined || !isIntegratedCodemode(tool)) return undefined
      let full: string
      try {
        full = await readFile(path, 'utf8')
      } catch {
        return undefined
      }
      let changed = false
      const content = event.content.map(item => {
        if (item.type !== 'text') return item
        const text = withRecoveryHint(item.text, full, path, read)
        changed ||= text !== item.text
        return { ...item, text }
      })
      if (!changed) return undefined
      return event.structuredContent === undefined
        ? { content }
        : { content, structuredContent: event.structuredContent }
    })
  }
  return factory
})
