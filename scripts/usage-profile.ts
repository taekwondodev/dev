import { join } from 'node:path'
import {
  Array as Arr,
  DateTime,
  Effect,
  FileSystem,
  Number as Num,
  Option,
  Order,
  Schema,
} from 'effect'
import {
  type Baseline,
  type CacheUsage,
  orUnavailable,
  percent,
  renderCharts,
  seconds,
  size,
  type TimeSplit,
  type ToolResults,
  type ToolSizes,
} from './usage-charts.ts'

export class UsageProfileError extends Schema.TaggedError<UsageProfileError>()(
  'UsageProfileError',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }
) {}

const except = (used: readonly string[]) =>
  Schema.String.check(Schema.makeFilter(value => !used.includes(value)))

const Usage = Schema.Struct({
  input: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
})
type Usage = typeof Usage.Type

const Timestamp = Schema.DateTimeUtcFromString

const decodeHeader = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literal('session'),
      timestamp: Timestamp,
      parentSession: Schema.optional(Schema.String),
    })
  )
)

const SessionLine = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({
      type: Schema.Literal('message'),
      timestamp: Timestamp,
      message: Schema.Union([
        Schema.Struct({
          role: Schema.Literal('assistant'),
          timestamp: Schema.Finite,
          usage: Usage,
        }),
        Schema.Struct({
          role: Schema.Literal('toolResult'),
          toolName: Schema.String,
          content: Schema.Array(
            Schema.Union([
              Schema.Struct({ type: Schema.Literal('text'), text: Schema.String }),
              Schema.Struct({ type: except(['text']) }),
            ])
          ),
          details: Schema.optional(Schema.Unknown),
        }),
        Schema.Struct({ role: except(['assistant', 'toolResult']) }),
      ]),
    }),
    Schema.Struct({ type: except(['session', 'message']), timestamp: Timestamp }),
  ])
)
const decodeLine = Schema.decodeUnknownOption(SessionLine)

const WorkAttempt = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(['agent', 'process']),
  owner: Schema.Struct({ parent: Schema.optional(Schema.String) }),
})
type WorkAttempt = typeof WorkAttempt.Type
const decodeWorkAttempt = Schema.decodeUnknownOption(WorkAttempt)

const directAttempt = (details: unknown): WorkAttempt | undefined =>
  Option.getOrUndefined(
    Option.filter(decodeWorkAttempt(details), attempt => attempt.owner.parent === undefined)
  )

interface Position {
  readonly at: number
}

interface Request extends Position {
  readonly kind: 'request'
  readonly latencyMs: number
  readonly usage: Usage
}

interface ToolResult extends Position {
  readonly kind: 'toolResult'
  readonly tool: string
  readonly bytes: number
  readonly attempt: WorkAttempt | undefined
}

interface OtherEntry extends Position {
  readonly kind: 'user' | 'system' | 'other'
}

type SessionEntry = Request | ToolResult | OtherEntry

interface SessionFile {
  readonly entries: readonly SessionEntry[]
  readonly undecodable: number
}

const toEntry = (line: typeof SessionLine.Type): SessionEntry => {
  const position = { at: DateTime.toEpochMillis(line.timestamp) }
  if (!('message' in line)) return { kind: 'other', ...position }
  const { message } = line
  if ('usage' in message)
    return {
      kind: 'request',
      ...position,
      latencyMs: position.at - message.timestamp,
      usage: message.usage,
    }
  if ('toolName' in message)
    return {
      kind: 'toolResult',
      ...position,
      tool: message.toolName,
      bytes: message.content.reduce(
        (total, block) => ('text' in block ? total + Buffer.byteLength(block.text, 'utf8') : total),
        0
      ),
      attempt: message.toolName === 'work' ? directAttempt(message.details) : undefined,
    }
  return {
    kind: message.role === 'user' || message.role === 'system' ? message.role : 'other',
    ...position,
  }
}

const decodeSessionFile = (content: string): SessionFile => {
  const [first, ...rest] = content.split('\n').filter(line => line.trim() !== '')
  if (first === undefined) return { entries: [], undecodable: 0 }
  const header = Option.getOrUndefined(decodeHeader(first))
  const forkedAt =
    header?.parentSession === undefined ? undefined : DateTime.toEpochMillis(header.timestamp)
  const lines = rest.map(line => decodeLine(line))
  return {
    entries: Arr.getSomes(lines)
      .map(toEntry)
      .filter(entry => forkedAt === undefined || entry.at >= forkedAt),
    undecodable: (header === undefined ? 1 : 0) + lines.filter(Option.isNone).length,
  }
}

const readSessionFiles = Effect.fn('readSessionFiles')(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem
  if (!(yield* fs.exists(directory))) return []
  const names = (yield* fs.readDirectory(directory)).filter(name => name.endsWith('.jsonl'))
  return yield* Effect.forEach(names.toSorted(), name =>
    fs.readFileString(join(directory, name)).pipe(Effect.map(decodeSessionFile))
  )
})

const nearestRank = (values: Arr.NonEmptyReadonlyArray<number>, percentile: number): number =>
  Arr.sort(values, Order.Number)[Math.ceil((percentile * values.length) / 100) - 1]

const isoDate = (epochMillis: number): string =>
  DateTime.formatIsoDateUtc(DateTime.makeUnsafe(epochMillis))

const requestsOf = (entries: readonly SessionEntry[]) =>
  entries.filter(entry => entry.kind === 'request')

const toolResultsOf = (entries: readonly SessionEntry[]) =>
  entries.filter(entry => entry.kind === 'toolResult')

const cacheUsage = (requests: readonly Request[]): CacheUsage => {
  const input = Num.sumAll(requests.map(request => request.usage.input))
  const cacheRead = Num.sumAll(requests.map(request => request.usage.cacheRead))
  const cacheWrite = Num.sumAll(requests.map(request => request.usage.cacheWrite))
  const prompt = input + cacheRead + cacheWrite
  return {
    requests: requests.length,
    input,
    cacheRead,
    cacheWrite,
    hitRate: prompt === 0 ? null : cacheRead / prompt,
  }
}

const byBytesThenName = Order.combine(
  Order.flip(Order.mapInput(Order.Number, (tool: ToolSizes) => tool.bytes)),
  Order.mapInput(Order.String, (tool: ToolSizes) => tool.name)
)

const toolSizes = (results: readonly ToolResult[]): ToolResults => {
  const bytes = Num.sumAll(results.map(result => result.bytes))
  const tools = Object.entries(Arr.groupBy(results, result => result.tool)).map(([name, group]) => {
    const sizes = Arr.map(group, result => result.bytes)
    const toolBytes = Num.sumAll(sizes)
    return {
      name,
      count: sizes.length,
      bytes: toolBytes,
      meanBytes: toolBytes / sizes.length,
      medianBytes: nearestRank(sizes, 50),
      p90Bytes: nearestRank(sizes, 90),
      share: bytes === 0 ? 0 : toolBytes / bytes,
    }
  })
  return {
    count: results.length,
    bytes,
    meanBytes: results.length === 0 ? null : bytes / results.length,
    tools: Arr.sort(tools, byBytesThenName),
  }
}

const distinctAttempts = (results: readonly ToolResult[], kind: WorkAttempt['kind']): number =>
  new Set(results.flatMap(({ attempt }) => (attempt?.kind === kind ? [attempt.id] : []))).size

const timeSplit = (entries: readonly SessionEntry[]): TimeSplit => {
  let previous: number | undefined
  let modelMs = 0
  let toolMs = 0
  let userMs = 0
  for (const entry of entries) {
    if (entry.kind === 'system') continue
    const gap = previous === undefined ? 0 : entry.at - previous
    if (entry.kind === 'request') modelMs += entry.latencyMs
    if (entry.kind === 'toolResult') toolMs += gap
    if (entry.kind === 'user') userMs += gap
    previous = entry.at
  }
  return { modelMs, toolMs, userMs }
}

const aggregate = (
  lead: readonly SessionFile[],
  child: readonly SessionFile[]
): Option.Option<Baseline> => {
  const measured = lead.flatMap(({ entries }) => {
    const requests = requestsOf(entries)
    return Arr.isReadonlyArrayNonEmpty(requests)
      ? [{ entries, requests, toolResults: toolResultsOf(entries) }]
      : []
  })
  if (!Arr.isReadonlyArrayNonEmpty(measured)) return Option.none()
  const leadRequests = Arr.flatMap(measured, session => session.requests)
  const childEntries = child.flatMap(({ entries }) => entries)
  const childRequests = requestsOf(childEntries)
  const latencies = Arr.map(leadRequests, request => request.latencyMs)
  const toolCalls = Arr.map(measured, session => session.toolResults.length)
  const children = measured.map(session => distinctAttempts(session.toolResults, 'agent'))
  const agentAttempts = Num.sumAll(children)
  const requestTimes = Arr.appendAll(
    Arr.map(leadRequests, request => request.at),
    childRequests.map(request => request.at)
  )
  const splits = measured.map(session => timeSplit(session.entries))
  return Option.some({
    sample: {
      leadSessions: measured.length,
      emptyLeadSessions: lead.length - measured.length,
      childSessions: child.length,
      undecodableLines: Num.sumAll([...lead, ...child].map(file => file.undecodable)),
      firstDate: isoDate(Arr.min(requestTimes, Order.Number)),
      lastDate: isoDate(Arr.max(requestTimes, Order.Number)),
    },
    cache: { lead: cacheUsage(leadRequests), child: cacheUsage(childRequests) },
    toolCallsPerSession: {
      median: nearestRank(toolCalls, 50),
      minimum: Arr.min(toolCalls, Order.Number),
      maximum: Arr.max(toolCalls, Order.Number),
    },
    children: {
      agentAttempts,
      processAttempts: Num.sumAll(
        measured.map(session => distinctAttempts(session.toolResults, 'process'))
      ),
      meanPerSession: agentAttempts / measured.length,
      sessionShare: children.filter(count => count > 0).length / measured.length,
    },
    latency: {
      requests: latencies.length,
      p50Ms: nearestRank(latencies, 50),
      p90Ms: nearestRank(latencies, 90),
    },
    timeSplit: {
      modelMs: Num.sumAll(splits.map(split => split.modelMs)),
      toolMs: Num.sumAll(splits.map(split => split.toolMs)),
      userMs: Num.sumAll(splits.map(split => split.userMs)),
    },
    toolResults: {
      lead: toolSizes(measured.flatMap(session => session.toolResults)),
      child: toolSizes(toolResultsOf(childEntries)),
    },
  })
}

const tokens = (value: number): string => value.toLocaleString('en-US')

const duration = (ms: number): string => {
  if (Math.abs(ms) < 60_000) return seconds(ms)
  if (Math.abs(ms) < 3_600_000) return `${(ms / 60_000).toFixed(1)} min`
  return `${(ms / 3_600_000).toFixed(1)} h`
}

const cacheLine = (name: string, cache: CacheUsage): string =>
  `  ${name.padEnd(6)}${orUnavailable(cache.hitRate, percent).padStart(7)}` +
  `  over ${cache.requests} requests: ${tokens(cache.input)} input, ${tokens(cache.cacheRead)} cache read, ${tokens(cache.cacheWrite)} cache write tokens`

const toolTable = (name: string, results: ToolResults): string => {
  const heading = `Tool results, ${name}: ${results.count} results, ${size(results.bytes)}, mean ${orUnavailable(results.meanBytes, size)}`
  if (results.tools.length === 0) return heading
  const width = Math.max(4, ...results.tools.map(tool => tool.name.length))
  const row = (cells: readonly string[]) =>
    `  ${cells[0]?.padEnd(width)}${cells
      .slice(1)
      .map(cell => cell.padStart(10))
      .join('')}`
  return [
    heading,
    row(['tool', 'count', 'mean', 'median', 'p90', 'share']),
    ...results.tools.map(tool =>
      row([
        tool.name,
        String(tool.count),
        size(tool.meanBytes),
        size(tool.medianBytes),
        size(tool.p90Bytes),
        percent(tool.share),
      ])
    ),
  ].join('\n')
}

const formatReport = (baseline: Baseline, written: readonly string[]): string => {
  const { sample, toolCallsPerSession, children, latency, timeSplit: split } = baseline
  const measuredMs = split.modelMs + split.toolMs + split.userMs
  const part = (label: string, ms: number) =>
    `${label} ${duration(ms)}${measuredMs > 0 ? ` (${percent(ms / measuredMs)})` : ''}`
  return `${[
    `Sample: ${sample.leadSessions} lead sessions (${sample.emptyLeadSessions} empty excluded), ${sample.childSessions} child sessions, ${sample.firstDate} to ${sample.lastDate}; ${sample.undecodableLines} undecodable lines skipped`,
    '',
    'Cache hit rate',
    cacheLine('lead', baseline.cache.lead),
    cacheLine('child', baseline.cache.child),
    `Tool calls per lead session: median ${toolCallsPerSession.median}, minimum ${toolCallsPerSession.minimum}, maximum ${toolCallsPerSession.maximum}`,
    `Children per lead session: mean ${children.meanPerSession.toFixed(2)}, in ${percent(children.sessionShare)} of sessions (${children.agentAttempts} agent attempts); ${children.processAttempts} process attempts`,
    `Model latency: p50 ${seconds(latency.p50Ms)}, p90 ${seconds(latency.p90Ms)} over ${latency.requests} lead requests`,
    `Lead session time: ${[part('model', split.modelMs), part('tools', split.toolMs), part('waiting for you', split.userMs)].join(', ')}`,
    '',
    toolTable('lead', baseline.toolResults.lead),
    '',
    toolTable('child', baseline.toolResults.child),
    '',
    `Wrote ${written.join(', ')}`,
  ].join('\n')}\n`
}

export const profileUsage = Effect.fn('profileUsage')(function* (dataHome: string, output: string) {
  const leadDirectory = join(dataHome, 'sessions')
  const lead = yield* readSessionFiles(leadDirectory)
  const baseline = aggregate(lead, yield* readSessionFiles(join(dataHome, 'child-sessions')))
  if (Option.isNone(baseline))
    return yield* new UsageProfileError({
      message: `No measurable lead session in ${leadDirectory} (${lead.length} files, ${Num.sumAll(lead.map(file => file.undecodable))} undecodable lines); nothing was written`,
    })
  const json = `${JSON.stringify(baseline.value, null, 2)}\n`
  const charts = yield* renderCharts(json).pipe(
    Effect.mapError(
      cause => new UsageProfileError({ message: `Invalid usage baseline: ${cause.message}`, cause })
    )
  )
  const files = [
    ['usage-baseline.json', json],
    ['usage.svg', charts.usage],
    ['tools.svg', charts.tools],
  ] as const
  const fs = yield* FileSystem.FileSystem
  yield* fs.makeDirectory(output, { recursive: true })
  yield* Effect.forEach(
    files,
    ([name, content]) => fs.writeFileString(join(output, name), content),
    { discard: true }
  )
  return formatReport(
    baseline.value,
    files.map(([name]) => join(output, name))
  )
})
