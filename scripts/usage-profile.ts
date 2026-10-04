import { join } from 'node:path'
import { Array as Arr, DateTime, Effect, FileSystem, Option, Schema } from 'effect'
import { orUnavailable, percent, renderCharts, seconds, size } from './usage-charts.ts'
import { ROLES, type TokenTotals, USAGE_SOURCES } from './usage-export.ts'
import {
  type Analysis,
  analyze,
  analyzeSession,
  type Comparison,
  compare,
  type Drilldowns,
  drilldowns,
  exportNames,
  type GroupRow,
  nearestRanks,
  type Period,
  type PeriodSummary,
  privateNames,
  summarize,
} from './usage-report.ts'
import { readSessions, type SessionRecord } from './usage-sessions.ts'
import { compactionReport, type CompactionReport, compactionSession } from './usage-compaction.ts'

export class UsageProfileError extends Schema.TaggedError<UsageProfileError>()(
  'UsageProfileError',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }
) {}

export const ALL_TIME: Period = { label: 'all', start: undefined, end: undefined }

const decodeDay = Schema.decodeUnknownOption(
  Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/))
)
const decodeInstant = Schema.decodeUnknownOption(Schema.DateTimeUtcFromString)

const day = (text: string): Effect.Effect<number | undefined, UsageProfileError> => {
  if (text === '') return Effect.undefined
  const instant = Option.flatMap(decodeDay(text), valid => decodeInstant(`${valid}T00:00:00Z`))
  return Option.isSome(instant) && DateTime.formatIsoDateUtc(instant.value) === text
    ? Effect.succeed(DateTime.toEpochMillis(instant.value))
    : Effect.fail(
        new UsageProfileError({ message: `Invalid period date "${text}": use YYYY-MM-DD` })
      )
}

export const parsePeriod = Effect.fn('parsePeriod')(function* (text: string) {
  const parts = text.split('..')
  if (parts.length !== 2)
    return yield* new UsageProfileError({
      message: `Invalid period "${text}": use START..END, either side optional, START inclusive and END exclusive`,
    })
  const [from = '', to = ''] = parts
  const start = yield* day(from)
  const end = yield* day(to)
  if (start !== undefined && end !== undefined && start >= end)
    return yield* new UsageProfileError({
      message: `Empty period "${text}": START must precede END`,
    })
  return start === undefined && end === undefined
    ? ALL_TIME
    : { label: `${from}..${to}`, start, end }
})

type Selection =
  | { readonly kind: 'report'; readonly periods: readonly [Period, ...Period[]] }
  | { readonly kind: 'export'; readonly period: Period; readonly directory: string }

interface ProfileOptions {
  readonly dataHome: string
  readonly selection: Selection
}

type PrivatePeriod = PeriodSummary & {
  readonly compaction: CompactionReport
  readonly drilldowns: Drilldowns
}

interface Report {
  readonly selection: readonly string[]
  readonly sources: {
    readonly leadFiles: number
    readonly childFiles: number
    readonly undecodableLines: number
    readonly copiedEntries: number
  }
  readonly periods: readonly PrivatePeriod[]
  readonly comparison: Comparison | null
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

const exportFiles = Effect.fn('exportFiles')(function* (
  analysis: Analysis,
  period: Period,
  directory: string
) {
  const summary = summarize(analysis.facts, period, exportNames)
  const content = json({
    period: { start: summary.period.start, end: summary.period.end },
    undecodableLinesInDataHome: analysis.undecodableLines,
    sample: summary.sample,
    usage: summary.usage,
    attribution: summary.attribution,
    tools: summary.tools,
    reads: summary.reads,
    git: summary.git,
    context: summary.context,
    lead: summary.lead,
  })
  const charts = yield* renderCharts(content).pipe(
    Effect.mapError(
      cause => new UsageProfileError({ message: `Invalid usage export: ${cause.message}`, cause })
    )
  )
  return [
    [join(directory, 'usage-baseline.json'), content],
    [join(directory, 'usage.svg'), charts.usage],
    [join(directory, 'tools.svg'), charts.tools],
  ] as const
})

const measured = (session: SessionRecord) => ({
  analysis: analyzeSession(session),
  compaction: compactionSession(session),
})

export const profileUsage = Effect.fn('profileUsage')(function* ({
  dataHome,
  selection,
}: ProfileOptions) {
  const periods: readonly [Period, ...Period[]] =
    selection.kind === 'report' ? selection.periods : [selection.period]
  const sessions = [
    ...(yield* readSessions(dataHome, 'sessions', 'lead', measured)),
    ...(yield* readSessions(dataHome, 'child-sessions', 'child', measured)),
  ]
  const analysis = analyze(sessions.map(session => session.analysis))
  const compactions = sessions.map(session => session.compaction)
  const reported = periods.map(period => ({
    ...summarize(analysis.facts, period, privateNames),
    compaction: compactionReport(compactions, period),
    drilldowns: drilldowns(analysis.facts, period),
  }))
  const labels = periods.map(period => period.label)
  if (
    reported.every(
      summary =>
        summary.sample === null &&
        (selection.kind === 'export' ||
          (summary.compaction.observations === 0 && summary.compaction.malformed === 0))
    )
  )
    return yield* new UsageProfileError({
      message: `Nothing measurable in ${dataHome} for ${labels.join(', ')} (${sessions.length} session files, ${analysis.undecodableLines} undecodable lines); existing reports were not changed`,
    })
  const report: Report = {
    selection: labels,
    sources: {
      leadFiles: analysis.leadFiles,
      childFiles: analysis.childFiles,
      undecodableLines: analysis.undecodableLines,
      copiedEntries: analysis.copiedEntries,
    },
    periods: reported,
    comparison: compare(reported),
  }
  const reports = join(dataHome, 'usage')
  const privateReport = join(reports, `${labels.join('+')}.json`)
  const exported =
    selection.kind === 'export'
      ? yield* exportFiles(analysis, selection.period, selection.directory)
      : []
  const fs = yield* FileSystem.FileSystem
  yield* fs.makeDirectory(reports, { recursive: true, mode: 0o700 })
  if (yield* fs.exists(privateReport)) yield* fs.chmod(privateReport, 0o600)
  yield* fs.writeFileString(privateReport, json(report), { mode: 0o600 })
  if (selection.kind === 'export') yield* fs.makeDirectory(selection.directory, { recursive: true })
  yield* Effect.forEach(exported, ([path, content]) => fs.writeFileString(path, content), {
    discard: true,
  })
  return formatReport(report, [privateReport, ...exported.map(([path]) => path)])
})

const tokens = (value: number): string => Math.round(value).toLocaleString('en-US')

const duration = (ms: number): string => {
  if (Math.abs(ms) < 60_000) return seconds(ms)
  if (Math.abs(ms) < 3_600_000) return `${(ms / 60_000).toFixed(1)} min`
  return `${(ms / 3_600_000).toFixed(1)} h`
}

const table = (headers: readonly string[], rows: readonly (readonly string[])[]): string[] => {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map(row => row[column]?.length ?? 0))
  )
  const line = (cells: readonly string[]) =>
    `  ${cells
      .map((cell, column) =>
        column === 0 ? cell.padEnd(widths[column] ?? 0) : cell.padStart(widths[column] ?? 0)
      )
      .join('  ')}`
  return [line(headers), ...rows.map(line)]
}

const tokenCells = (totals: TokenTotals, label: string): string[] => [
  label,
  String(totals.entries),
  String(totals.unknown),
  tokens(totals.input),
  tokens(totals.output),
  totals.reasoningEntries === 0 ? 'n/a' : tokens(totals.reasoning),
  tokens(totals.cacheRead),
  tokens(totals.cacheWrite),
  tokens(totals.uncached),
  orUnavailable(totals.cacheReadShare, percent),
]

const TOKEN_HEADERS = [
  'entries',
  'unknown',
  'input',
  'output',
  'reasoning',
  'cache read',
  'cache write',
  'uncached',
  'cache-read share',
]

const groupLines = (title: string, rows: readonly GroupRow[]): string[] =>
  rows.length === 0
    ? []
    : table(
        [title, ...TOKEN_HEADERS],
        rows.map(row => tokenCells(row.tokens, row.key))
      )

const usageLines = (summary: PeriodSummary): string[] => [
  'Usage tokens: cumulative consumption, not context occupancy; reasoning is part of output; unknown usage is not zero',
  ...table(
    ['source', ...TOKEN_HEADERS],
    [
      ...USAGE_SOURCES.map(source => tokenCells(summary.usage.bySource[source], source)),
      tokenCells(summary.usage.total, 'total'),
      tokenCells(summary.usage.requests.first, 'first requests'),
      tokenCells(summary.usage.requests.later, 'later requests'),
    ]
  ),
  ...groupLines(
    'role',
    ROLES.map(role => ({ key: role, tokens: summary.usage.byRole[role] })).filter(
      row => row.tokens.entries + row.tokens.unknown > 0
    )
  ),
  ...groupLines(
    'effort',
    summary.usage.byEffort.map(row => ({ key: row.effort, tokens: row.tokens }))
  ),
  ...groupLines('model', summary.groups.model),
  ...groupLines('skill', summary.groups.skill),
  `Attribution: model unrecorded on ${summary.attribution.modelUnrecorded} and effort on ${summary.attribution.effortUnrecorded} of ${summary.attribution.entries} usage entries; ${summary.attribution.unattributedChildSessions} of ${summary.attribution.childSessions} child sessions without a recorded role`,
]

const toolLines = (summary: PeriodSummary): string[] => {
  const { tools } = summary
  return [
    `Tool calls: ${tools.invocations} invocations, ${tools.matched} with a result, ${tools.unmatchedCalls} without (${tools.interruptedUnmatched} in interrupted responses), ${tools.unmatchedResults} results without a call. A result without error does not establish task correctness.`,
    ...table(
      [
        'tool',
        'calls',
        'returned',
        'invocation',
        'execution',
        'blocked',
        'cancelled',
        'unclassified',
        'unmatched',
        'mean',
        'p90',
        'share',
      ],
      tools.byTool.map(row => [
        row.tool,
        String(row.invocations),
        String(row.outcomes.returned),
        String(row.outcomes.invocation),
        String(row.outcomes.execution),
        String(row.outcomes.blocked),
        String(row.outcomes.cancelled),
        String(row.outcomes.unclassified),
        String(row.outcomes.unmatched),
        orUnavailable(row.meanBytes, size),
        orUnavailable(row.p90Bytes, size),
        percent(row.share),
      ])
    ),
    `Candidate sequences, same tool on one branch, relation not established: ${tools.candidateSequences.repeatedErrors} repeated errors, ${tools.candidateSequences.recoveries} recoveries`,
  ]
}

const readLines = (summary: PeriodSummary & { readonly drilldowns: Drilldowns }): string[] => {
  const { reads } = summary
  const { relations, overlap, truncation } = reads
  return [
    `Reads: ${reads.calls} with a result (${reads.failed} failed, ${reads.unknownCoverage} with unknown coverage), ${size(reads.bytes)} returned text; bytes are not billed tokens or proven waste`,
    `  first ${relations.first}, pagination ${relations.pagination}, disjoint ${relations.disjoint}, overlap ${relations.overlap}, unknown ${relations.unknown}`,
    `  overlaps: ${overlap.identical} identical and ${overlap.changed} changed text over ${overlap.lines} lines (${size(overlap.bytes)}); ${overlap.afterCompaction} after compaction, ${overlap.afterContextEdit} after a context edit, ${overlap.afterOwnWrite} after an own write`,
    `  truncated by lines ${truncation.lines}, by bytes ${truncation.bytes}, first line too long ${truncation.firstLine}; stopped by limit ${reads.limited}; ${reads.crossAgent.paths} paths read by several agents (${reads.crossAgent.reads} reads)`,
    ...(summary.drilldowns.reads.length === 0
      ? []
      : table(
          [
            'repeated path',
            'session',
            'reads',
            'overlaps',
            'identical',
            'bytes',
            'returned lines',
            'first call',
          ],
          summary.drilldowns.reads.map(row => [
            row.path,
            row.session,
            String(row.reads),
            String(row.overlaps),
            String(row.identical),
            size(row.bytes),
            row.calls
              .map(call =>
                call.returned === null ? '?' : `${call.returned.start}-${call.returned.end}`
              )
              .join(' '),
            row.calls[0]?.ref ?? '',
          ])
        )),
  ]
}

const gitLines = (summary: PeriodSummary): string[] => {
  const { git } = summary
  if (git.requests === 0) return ['Git: no requests']
  return [
    `Git: ${git.requests} requests (${git.whole} alone in their call, ${git.inCompound} inside a compound shell command, whose output is not attributable to one request), ${git.truncated} with truncated call output; ${git.repeats.requests} repeated requests with ${git.repeats.identicalResults} identical, ${git.repeats.changedResults} changed and ${git.repeats.unknownResults} unknown results`,
    ...table(
      ['tool', 'operation', 'requests', 'repeats', 'identical', 'truncated'],
      git.byOperation.map(row => [
        row.tool,
        row.operation,
        String(row.requests),
        String(row.repeats),
        String(row.identicalResults),
        String(row.truncated),
      ])
    ),
  ]
}

const distributionText = (label: string, value: PeriodSummary['context']['initialTokens']) =>
  value === null
    ? `${label} n/a`
    : `${label} median ${tokens(value.median)}, p90 ${tokens(value.p90)}, max ${tokens(value.max)}`

const contextLines = ({ context, compaction }: PrivatePeriod): string[] => [
  `Context per request (input, cache read and cache write tokens of one request): ${context.sessions} sessions started; ${distributionText('initial', context.initialTokens)}; ${distributionText('peak', context.peakTokens)}; ${distributionText('growth', context.growthTokens)}`,
  `  ${context.compactions} compactions, tokens before recorded on ${context.tokensBefore.recorded} (median ${orUnavailable(context.tokensBefore.median, tokens)}); inline synthesis ${tokens(context.synthesis.uncached + context.synthesis.cacheRead + context.synthesis.output)} tokens over ${context.synthesis.entries} entries, ${context.synthesis.unknown} without usable inline usage (${compaction.separatelyRecordedApplications} background applications carry separate usage below, not another missing charge); ${context.afterCompaction.requests} requests after a compaction, ${context.afterCompaction.withoutCacheRead} without cache read (an association, not proof of invalidation)`,
]

const leadLines = ({ lead }: PeriodSummary): string[] => {
  if (lead === null) return ['Lead: no lead request in this period']
  const { toolCallsPerSession: calls, children, latency, timeSplit: split } = lead
  const measuredMs = split.modelMs + split.toolMs + split.userMs
  const part = (label: string, ms: number) =>
    `${label} ${duration(ms)}${measuredMs > 0 ? ` (${percent(ms / measuredMs)})` : ''}`
  return [
    `Lead: ${lead.sessions} sessions; tool calls per session median ${calls.median}, minimum ${calls.minimum}, maximum ${calls.maximum}; children per session mean ${children.meanPerSession.toFixed(2)}, in ${percent(children.sessionShare)} of sessions (${children.agentAttempts} agent attempts), ${children.processAttempts} process attempts`,
    `  model latency p50 ${seconds(latency.p50Ms)}, p90 ${seconds(latency.p90Ms)} over ${latency.requests} requests; time ${[part('model', split.modelMs), part('tools', split.toolMs), part('waiting for you', split.userMs)].join(', ')}`,
  ]
}

const timings = (values: readonly number[]): string => {
  if (!Arr.isReadonlyArrayNonEmpty(values)) return 'n/a'
  const rank = nearestRanks(values)
  return `${values.length} samples, median ${rank(50).toFixed(1)} ms, max ${rank(100).toFixed(1)} ms`
}

const compactionLines = ({ compaction }: PrivatePeriod): string[] => {
  const usage = compaction.observedUsage
  const consumed =
    usage.tokens.input + usage.tokens.output + usage.tokens.cacheRead + usage.tokens.cacheWrite
  const accounting = `  observed background usage: ${tokens(consumed)} tokens in ${usage.entries} records (${usage.unknown} unknown), ${compaction.unattributedUsage} unattributed; ${compaction.preparationsWithoutUsage} preparations without recorded usage. Already in native totals, not another charge or complete provider billing.`
  if (compaction.coverage === 'unavailable')
    return [
      'Private compaction observations: unavailable; no instrumentation in the selected data.',
      accounting,
      '  Insufficient compaction observations for a usefulness assessment.',
    ]
  const nativeCompleted = Object.values(compaction.native).reduce(
    (sum, value) => sum + value.completed,
    0
  )
  const applications = (compaction.appliedIdle ?? 0) + (compaction.appliedBoundary ?? 0)
  return [
    `Private compaction observations: ${compaction.coverage}; ${compaction.instrumentedSessions}/${compaction.selectedSessions} sessions instrumented, ${compaction.partiallyObservedSessions} only partly covered, ${compaction.openRuns} runs without detachment.`,
    `  observed ${compaction.starts} starts, ${compaction.readiness} ready, ${compaction.appliedIdle} idle and ${compaction.appliedBoundary} boundary applications, ${compaction.discards} discards, ${compaction.failures} failures; ${compaction.incomplete} incomplete, ${compaction.crossPeriod} cross-period, ${compaction.malformed} malformed, ${compaction.unattributedApplications} unverified application claims; ${compaction.sessionsWithoutStarts} instrumented sessions without starts`,
    `  discard reasons: ${
      Object.entries(compaction.discardReasons)
        .map(([reason, count]) => `${reason} ${count}`)
        .join(', ') || 'none observed'
    }`,
    `  preparation ${timings(compaction.preparationMs)}; ready wait ${timings(compaction.readyWaitMs)}; start-to-outcome ${timings(compaction.elapsedMs)}; preparation/ordinary-run overlap ${timings(compaction.overlapMs)} (not saved time or useful work)`,
    ...Object.entries(compaction.native).map(
      ([reason, value]) =>
        `  native ${reason}: ${value.starts} starts, ${value.completed} completed, ${value.aborted} aborted, ${value.failed} failed, ${value.incomplete} incomplete, ${value.crossPeriod} cross-period; event spans ${timings(value.durations)} (not full perceived delay)`
    ),
    accounting,
    applications + nativeCompleted === 0
      ? '  Insufficient compaction observations for a usefulness assessment.'
      : '  Observational sample only: usefulness and information loss need user assessment; no causal speedup or quality equivalence is established.',
    ...(compaction.drilldowns.length === 0
      ? []
      : [
          `  Preparations: first ${Math.min(12, compaction.drilldowns.length)} of ${compaction.drilldowns.length}; complete drilldowns are in the private JSON report.`,
          ...table(
            ['session', 'preparation', 'outcome', 'reason', 'coverage', 'usage records', 'entries'],
            compaction.drilldowns
              .slice(0, 12)
              .map(row => [
                row.session,
                row.preparation,
                row.outcome,
                row.reason ?? '-',
                `${row.complete ? 'complete' : 'incomplete'}${row.crossPeriod ? ', cross-period' : ''}${row.outcomeInPeriod ? '' : ', outcome outside period/unrecorded'}`,
                `${row.usageEntries} (${row.unknownUsage} unknown, ${row.usageOutsidePeriod} outside period; ${row.usageCoverage})`,
                row.refs.join(' '),
              ])
          ),
        ]),
  ]
}

const periodLines = (summary: PrivatePeriod): string[] => {
  const { sample } = summary
  if (sample === null)
    return [
      `Period ${summary.period.label}: no requests or tool outcomes`,
      ...compactionLines(summary),
    ]
  return [
    `Period ${summary.period.label}: ${sample.leadSessions} lead and ${sample.childSessions} child sessions, ${sample.firstDate} to ${sample.lastDate}; ${sample.requests} requests, ${sample.toolCalls} tool calls`,
    ...usageLines(summary),
    '',
    ...toolLines(summary),
    '',
    ...readLines(summary),
    '',
    ...gitLines(summary),
    '',
    ...contextLines(summary),
    ...compactionLines(summary),
    ...leadLines(summary),
  ]
}

const cell = <A>(value: A | null, format: (value: A) => string) =>
  value === null ? '-' : format(value)

const comparisonLines = (comparison: Comparison | null, labels: readonly string[]): string[] => {
  if (comparison === null) return []
  return [
    `Comparison, inclusive start and exclusive end, against ${comparison.baseline}`,
    ...table(
      ['dimension', 'key', ...labels.map(label => `${label} entries/uncached/share`)],
      comparison.usage.map(row => [
        row.dimension,
        row.key,
        ...row.periods.map(value =>
          cell(
            value,
            present =>
              `${present.entries}/${tokens(present.uncached)}/${orUnavailable(present.cacheReadShare, percent)}`
          )
        ),
      ])
    ),
    ...table(
      ['tool', ...labels.map(label => `${label} calls/failures/bytes`)],
      comparison.tools.map(row => [
        row.tool,
        ...row.periods.map(value =>
          cell(
            value,
            present => `${present.invocations}/${present.failures}/${size(present.bytes)}`
          )
        ),
      ])
    ),
    ...comparison.limitations.map(limitation => `Limitation: ${limitation}`),
  ]
}

const formatReport = (report: Report, written: readonly string[]): string =>
  `${[
    `Data home: ${report.sources.leadFiles} lead and ${report.sources.childFiles} child session files; ${report.sources.undecodableLines} undecodable lines skipped; ${report.sources.copiedEntries} copied fork entries excluded`,
    '',
    ...report.periods.flatMap(summary => [...periodLines(summary), '']),
    ...comparisonLines(report.comparison, report.selection),
    `Wrote ${written.join(', ')}`,
  ].join('\n')}\n`
