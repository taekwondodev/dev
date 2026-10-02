import { Array as Arr, DateTime, Number as Num, Order } from 'effect'
import {
  attributeRoles,
  type CallFact,
  effortOf,
  type Facts,
  type GitFact,
  modelOf,
  type Range,
  type ReadFact,
  type RequestedRange,
  sessionFacts,
  type UsageFact,
} from './usage-facts.ts'
import {
  type Attribution,
  type Context,
  type Distribution,
  EXPORTED_EFFORTS,
  EXPORTED_TOOLS,
  failureCount,
  type Git,
  type Lead,
  type Outcome,
  OUTCOMES,
  type OutcomeCounts,
  type Reads,
  type Role,
  ROLES,
  type Sample,
  type TokenTotals,
  type Tools,
  type TotalsByRole,
  type TotalsBySource,
  USAGE_SOURCES,
} from './usage-export.ts'
import type { SessionRecord, Tokens, Usage } from './usage-sessions.ts'

export interface Period {
  readonly label: string
  readonly start: number | undefined
  readonly end: number | undefined
}

export interface Analysis {
  readonly facts: Facts
  readonly leadFiles: number
  readonly childFiles: number
  readonly undecodableLines: number
  readonly copiedEntries: number
}

export const analyze = (sessions: readonly SessionRecord[]): Analysis => {
  const roles = attributeRoles(sessions)
  const all = sessions.map(session => sessionFacts(session, roles.get(session) ?? 'unattributed'))
  return {
    facts: {
      usage: all.flatMap(facts => facts.usage),
      calls: all.flatMap(facts => facts.calls),
      results: all.flatMap(facts => facts.results),
      sequences: all.flatMap(facts => facts.sequences),
      reads: all.flatMap(facts => facts.reads),
      git: all.flatMap(facts => facts.git),
      compactions: all.flatMap(facts => facts.compactions),
      time: all.flatMap(facts => facts.time),
      attempts: all.flatMap(facts => facts.attempts),
    },
    leadFiles: sessions.filter(session => session.scope === 'lead').length,
    childFiles: sessions.filter(session => session.scope === 'child').length,
    undecodableLines: Num.sumAll(sessions.map(session => session.undecodable)),
    copiedEntries: Num.sumAll(
      sessions.map(session => session.entries.filter(entry => entry.copied).length)
    ),
  }
}

const isoDate = (epochMillis: number): string =>
  DateTime.formatIsoDateUtc(DateTime.makeUnsafe(epochMillis))

const within =
  (period: Period) =>
  <A extends { readonly at: number }>(fact: A): boolean =>
    (period.start === undefined || fact.at >= period.start) &&
    (period.end === undefined || fact.at < period.end)

const nearestRank = (values: Arr.NonEmptyReadonlyArray<number>, percentile: number): number =>
  Arr.sort(values, Order.Number)[Math.ceil((percentile * values.length) / 100) - 1]

const distribution = (values: readonly number[]): Distribution =>
  Arr.isReadonlyArrayNonEmpty(values)
    ? {
        median: nearestRank(values, 50),
        p90: nearestRank(values, 90),
        max: Arr.max(values, Order.Number),
      }
    : null

const count = <A>(values: readonly A[], predicate: (value: A) => boolean): number =>
  values.filter(predicate).length

const isKnown = (usage: Usage): usage is Tokens => usage !== 'unknown'

const tokenTotals = (usages: readonly Usage[]): TokenTotals => {
  const known = usages.filter(isKnown)
  const sum = (field: (tokens: Tokens) => number) => Num.sumAll(known.map(field))
  const input = sum(tokens => tokens.input)
  const cacheRead = sum(tokens => tokens.cacheRead)
  const cacheWrite = sum(tokens => tokens.cacheWrite)
  const prompt = input + cacheRead + cacheWrite
  return {
    entries: known.length,
    unknown: usages.length - known.length,
    input,
    output: sum(tokens => tokens.output),
    reasoning: sum(tokens => tokens.reasoning ?? 0),
    reasoningEntries: count(known, tokens => tokens.reasoning !== undefined),
    cacheRead,
    cacheWrite,
    uncached: input + cacheWrite,
    cacheReadShare: prompt === 0 ? null : cacheRead / prompt,
  }
}

const contextTokens = (usage: Usage): number | undefined =>
  isKnown(usage) ? usage.input + usage.cacheRead + usage.cacheWrite : undefined

const recordOf = <K extends string, V>(
  keys: readonly K[],
  value: (key: K) => V
): Readonly<Record<K, V>> => Object.fromEntries(keys.map(key => [key, value(key)])) as Record<K, V>

const outcomeCounts = (outcomes: readonly Outcome[]): OutcomeCounts =>
  recordOf(OUTCOMES, outcome => count(outcomes, value => value === outcome))

interface Names {
  readonly tool: (name: string) => string
  readonly effort: (level: string | undefined) => string
}

export const privateNames: Names = {
  tool: name => name,
  effort: level => level ?? 'unrecorded',
}

const allowed = (values: readonly string[]) => (value: string) =>
  values.includes(value) ? value : 'other'

export const exportNames: Names = {
  tool: allowed(EXPORTED_TOOLS),
  effort: level => (level === undefined ? 'unrecorded' : allowed(EXPORTED_EFFORTS)(level)),
}

export interface GroupRow {
  readonly key: string
  readonly tokens: TokenTotals
}

const groupRows = (usage: readonly UsageFact[], keyOf: (fact: UsageFact) => string): GroupRow[] =>
  Object.entries(Arr.groupBy(usage, keyOf))
    .map(([key, facts]) => ({ key, tokens: tokenTotals(facts.map(fact => fact.usage)) }))
    .toSorted(
      (a, b) =>
        b.tokens.entries + b.tokens.unknown - (a.tokens.entries + a.tokens.unknown) ||
        a.key.localeCompare(b.key)
    )

const totalsOf = <A extends UsageFact>(usage: readonly A[], predicate: (fact: A) => boolean) =>
  tokenTotals(usage.filter(predicate).map(fact => fact.usage))

const returnedBytes = (calls: readonly CallFact[]): number[] =>
  calls.flatMap(call => (call.outcome === 'unmatched' ? [] : [call.bytes]))

const toolsSummary = (
  calls: readonly CallFact[],
  results: Facts['results'],
  sequences: Facts['sequences'],
  names: Names
): Tools => {
  const total = Num.sumAll(returnedBytes(calls))
  const rows = Object.entries(Arr.groupBy(calls, call => names.tool(call.tool))).map(
    ([tool, group]) => {
      const sizes = returnedBytes(group)
      const bytes = Num.sumAll(sizes)
      return {
        tool,
        invocations: group.length,
        outcomes: outcomeCounts(group.map(call => call.outcome)),
        results: sizes.length,
        bytes,
        meanBytes: sizes.length === 0 ? null : bytes / sizes.length,
        medianBytes: Arr.isReadonlyArrayNonEmpty(sizes) ? nearestRank(sizes, 50) : null,
        p90Bytes: Arr.isReadonlyArrayNonEmpty(sizes) ? nearestRank(sizes, 90) : null,
        share: total === 0 ? 0 : bytes / total,
      }
    }
  )
  return {
    invocations: calls.length,
    matched: count(calls, call => call.outcome !== 'unmatched'),
    unmatchedCalls: count(calls, call => call.outcome === 'unmatched'),
    interruptedUnmatched: count(calls, call => call.outcome === 'unmatched' && call.interrupted),
    unmatchedResults: count(results, result => !result.matched),
    outcomes: outcomeCounts(calls.map(call => call.outcome)),
    candidateSequences: {
      repeatedErrors: count(sequences, sequence => sequence.kind === 'repeated-error'),
      recoveries: count(sequences, sequence => sequence.kind === 'recovery'),
    },
    byTool: rows.toSorted((a, b) => b.bytes - a.bytes || a.tool.localeCompare(b.tool)),
  }
}

type TextRead = Extract<ReadFact, { coverage: 'text' }>
type RelationKind = TextRead['relation']['kind']

const isTextRead = (read: ReadFact): read is TextRead => read.coverage === 'text'

const readsSummary = (reads: readonly ReadFact[]): Reads => {
  const returned = reads.filter(read => read.coverage !== 'failed')
  const texts = returned.filter(isTextRead)
  const overlaps = texts.flatMap(read => (read.relation.kind === 'overlap' ? [read.relation] : []))
  const relation = (kind: RelationKind) => count(texts, read => read.relation.kind === kind)
  const absolute = returned.flatMap(read =>
    read.file?.identity.kind === 'absolute'
      ? [{ path: read.file.identity.path, session: read.session }]
      : []
  )
  const shared = Object.values(Arr.groupBy(absolute, read => read.path)).filter(
    group => new Set(group.map(read => read.session)).size > 1
  )
  return {
    calls: reads.length,
    failed: reads.length - returned.length,
    unknownCoverage: count(returned, read => read.coverage === 'unknown'),
    bytes: Num.sumAll(returned.map(read => read.bytes)),
    relations: {
      first: relation('first'),
      pagination: relation('pagination'),
      disjoint: relation('disjoint'),
      overlap: relation('overlap'),
      unknown: relation('unknown') + count(returned, read => read.coverage === 'unknown'),
    },
    overlap: {
      identical: count(overlaps, overlap => overlap.identical),
      changed: count(overlaps, overlap => !overlap.identical),
      afterCompaction: count(overlaps, overlap => overlap.afterCompaction),
      afterContextEdit: count(overlaps, overlap => overlap.afterContextEdit),
      afterOwnWrite: count(overlaps, overlap => overlap.afterOwnWrite),
      lines: Num.sumAll(overlaps.map(overlap => overlap.lines)),
      bytes: Num.sumAll(overlaps.map(overlap => overlap.bytes)),
    },
    truncation: {
      lines: count(texts, read => read.stop === 'lines'),
      bytes: count(texts, read => read.stop === 'bytes'),
      firstLine: count(texts, read => read.stop === 'first-line'),
    },
    limited: count(texts, read => read.stop === 'limit'),
    crossAgent: {
      paths: shared.length,
      reads: Num.sumAll(shared.map(group => group.length)),
    },
  }
}

const gitSummary = (git: readonly GitFact[]): Git => {
  const rows = Object.values(Arr.groupBy(git, fact => `${fact.tool}\u0000${fact.operation}`)).map(
    group => {
      const { tool, operation } = Arr.headNonEmpty(group)
      return {
        tool,
        operation,
        requests: group.length,
        repeats: count(group, fact => fact.repeat !== undefined),
        identicalResults: count(group, fact => fact.repeat === 'identical'),
        truncated: count(group, fact => fact.truncated),
      }
    }
  )
  return {
    requests: git.length,
    whole: count(git, fact => fact.whole),
    inCompound: count(git, fact => !fact.whole),
    truncated: count(git, fact => fact.truncated),
    repeats: {
      requests: count(git, fact => fact.repeat !== undefined),
      identicalResults: count(git, fact => fact.repeat === 'identical'),
      changedResults: count(git, fact => fact.repeat === 'changed'),
      unknownResults: count(git, fact => fact.repeat === 'unknown'),
    },
    byOperation: rows.toSorted(
      (a, b) =>
        b.requests - a.requests ||
        a.tool.localeCompare(b.tool) ||
        a.operation.localeCompare(b.operation)
    ),
  }
}

type RequestFact = Extract<UsageFact, { source: 'assistant' }>

const isRequest = (fact: UsageFact): fact is RequestFact => fact.source === 'assistant'

const contextSummary = (
  usage: readonly UsageFact[],
  compactions: Facts['compactions']
): Context => {
  const requests = usage.filter(isRequest)
  const sessions = Object.values(Arr.groupBy(requests, fact => fact.session)).flatMap(group => {
    const sizes = group.flatMap(fact => {
      const size = contextTokens(fact.usage)
      return size === undefined ? [] : [size]
    })
    const initial = group.find(fact => fact.first)
    return Arr.isReadonlyArrayNonEmpty(sizes)
      ? [
          {
            peak: Arr.max(sizes, Order.Number),
            initial: initial === undefined ? undefined : contextTokens(initial.usage),
          },
        ]
      : []
  })
  const started = sessions.flatMap(session =>
    session.initial === undefined ? [] : [{ initial: session.initial, peak: session.peak }]
  )
  const recorded = compactions.flatMap(fact =>
    fact.tokensBefore === undefined ? [] : [fact.tokensBefore]
  )
  const after = requests.filter(fact => fact.afterCompaction)
  return {
    sessions: started.length,
    initialTokens: distribution(started.map(session => session.initial)),
    peakTokens: distribution(sessions.map(session => session.peak)),
    growthTokens: distribution(started.map(session => session.peak - session.initial)),
    compactions: compactions.length,
    tokensBefore: {
      recorded: recorded.length,
      total: Num.sumAll(recorded),
      median: Arr.isReadonlyArrayNonEmpty(recorded) ? nearestRank(recorded, 50) : null,
    },
    synthesis: totalsOf(
      usage,
      fact => fact.source === 'compaction' || fact.source === 'branch-summary'
    ),
    afterCompaction: {
      requests: after.length,
      withoutCacheRead: count(after, fact => isKnown(fact.usage) && fact.usage.cacheRead === 0),
    },
  }
}

const leadSummary = (facts: Facts, period: Period, names: Names): Lead => {
  const inPeriod = within(period)
  const requests = facts.usage.filter(
    (fact): fact is RequestFact => isRequest(fact) && fact.role === 'lead' && inPeriod(fact)
  )
  if (!Arr.isReadonlyArrayNonEmpty(requests)) return null
  const sessions = Arr.dedupe(Arr.map(requests, fact => fact.session))
  const measured = new Set(sessions)
  const inSessions = <A extends { readonly session: string; readonly at: number }>(
    values: readonly A[]
  ) => values.filter(value => measured.has(value.session) && inPeriod(value))
  const calls = inSessions(facts.calls)
  const attempts = inSessions(facts.attempts)
  const toolCalls = Arr.map(sessions, session => count(calls, call => call.session === session))
  const distinct = (session: string, kind: 'agent' | 'process') =>
    new Set(
      attempts.flatMap(fact =>
        fact.session === session && fact.kind === kind ? [fact.attempt] : []
      )
    ).size
  const children = sessions.map(session => distinct(session, 'agent'))
  const agentAttempts = Num.sumAll(children)
  const latencies = Arr.map(requests, fact => fact.latencyMs)
  const time = inSessions(facts.time)
  const spent = (category: 'model' | 'tool' | 'user') =>
    Num.sumAll(time.filter(fact => fact.category === category).map(fact => fact.ms))
  const results = returnedBytes(calls)
  const bytes = Num.sumAll(results)
  const byTool = Object.entries(
    Arr.groupBy(
      calls.filter(call => call.outcome !== 'unmatched'),
      call => names.tool(call.tool)
    )
  )
    .map(([tool, group]) => {
      const toolBytes = Num.sumAll(returnedBytes(group))
      return {
        tool,
        results: group.length,
        bytes: toolBytes,
        share: bytes === 0 ? 0 : toolBytes / bytes,
      }
    })
    .toSorted((a, b) => b.bytes - a.bytes || a.tool.localeCompare(b.tool))
  return {
    sessions: sessions.length,
    toolCallsPerSession: {
      median: nearestRank(toolCalls, 50),
      minimum: Arr.min(toolCalls, Order.Number),
      maximum: Arr.max(toolCalls, Order.Number),
    },
    toolResults: {
      results: results.length,
      bytes,
      meanBytes: results.length === 0 ? null : bytes / results.length,
      byTool,
    },
    children: {
      agentAttempts,
      processAttempts: Num.sumAll(sessions.map(session => distinct(session, 'process'))),
      meanPerSession: agentAttempts / sessions.length,
      sessionShare: count(children, value => value > 0) / sessions.length,
    },
    latency: {
      requests: latencies.length,
      p50Ms: nearestRank(latencies, 50),
      p90Ms: nearestRank(latencies, 90),
    },
    timeSplit: { modelMs: spent('model'), toolMs: spent('tool'), userMs: spent('user') },
  }
}

export interface PeriodSummary {
  readonly period: {
    readonly label: string
    readonly start: string | null
    readonly end: string | null
  }
  readonly sample: Sample | null
  readonly usage: {
    readonly total: TokenTotals
    readonly bySource: typeof TotalsBySource.Type
    readonly requests: { readonly first: TokenTotals; readonly later: TokenTotals }
    readonly byRole: typeof TotalsByRole.Type
    readonly byEffort: readonly { readonly effort: string; readonly tokens: TokenTotals }[]
  }
  readonly groups: {
    readonly model: readonly GroupRow[]
    readonly skill: readonly GroupRow[]
  }
  readonly attribution: Attribution
  readonly tools: Tools
  readonly reads: Reads
  readonly git: Git
  readonly context: Context
  readonly lead: Lead
}

export const summarize = (facts: Facts, period: Period, names: Names): PeriodSummary => {
  const inPeriod = within(period)
  const usage = facts.usage.filter(inPeriod)
  const calls = facts.calls.filter(inPeriod)
  const results = facts.results.filter(inPeriod)
  const located = [...usage, ...calls, ...results]
  const sessionsOf = (role: (role: Role) => boolean) =>
    new Set(located.flatMap(fact => (role(fact.role) ? [fact.session] : [])))
  const childSessions = sessionsOf(role => role !== 'lead')
  const times = located.map(fact => fact.at)
  const requests = usage.filter(isRequest)
  return {
    period: {
      label: period.label,
      start: period.start === undefined ? null : isoDate(period.start),
      end: period.end === undefined ? null : isoDate(period.end),
    },
    sample: Arr.isReadonlyArrayNonEmpty(times)
      ? {
          leadSessions: sessionsOf(role => role === 'lead').size,
          childSessions: childSessions.size,
          requests: requests.length,
          toolCalls: calls.length,
          firstDate: isoDate(Arr.min(times, Order.Number)),
          lastDate: isoDate(Arr.max(times, Order.Number)),
        }
      : null,
    usage: {
      total: tokenTotals(usage.map(fact => fact.usage)),
      bySource: recordOf(USAGE_SOURCES, source => totalsOf(usage, fact => fact.source === source)),
      requests: {
        first: totalsOf(requests, fact => fact.first),
        later: totalsOf(requests, fact => !fact.first),
      },
      byRole: recordOf(ROLES, role => totalsOf(usage, fact => fact.role === role)),
      byEffort: groupRows(usage, fact => names.effort(effortOf(fact))).map(row => ({
        effort: row.key,
        tokens: row.tokens,
      })),
    },
    groups: {
      model: groupRows(usage, fact => modelOf(fact) ?? 'unrecorded'),
      skill: groupRows(usage, fact => fact.skill ?? 'none'),
    },
    attribution: {
      entries: usage.length,
      modelUnrecorded: count(usage, fact => modelOf(fact) === undefined),
      effortUnrecorded: count(usage, fact => effortOf(fact) === undefined),
      childSessions: childSessions.size,
      unattributedChildSessions: sessionsOf(role => role === 'unattributed').size,
    },
    tools: toolsSummary(calls, results, facts.sequences.filter(inPeriod), names),
    reads: readsSummary(facts.reads.filter(inPeriod)),
    git: gitSummary(facts.git.filter(inPeriod)),
    context: contextSummary(usage, facts.compactions.filter(inPeriod)),
    lead: leadSummary(facts, period, names),
  }
}

const DRILLDOWN_ROWS = 10

interface Refs {
  readonly total: number
  readonly refs: readonly string[]
}

const capped = (refs: readonly string[]): Refs => ({
  total: refs.length,
  refs: refs.slice(0, DRILLDOWN_ROWS),
})

interface ReadCall {
  readonly ref: string
  readonly requested: RequestedRange | null
  readonly returned: Range | null
  readonly relation: string
  readonly earlier: string | null
}

export interface Drilldowns {
  readonly reads: readonly {
    readonly session: string
    readonly path: string
    readonly reads: number
    readonly overlaps: number
    readonly identical: number
    readonly changed: number
    readonly bytes: number
    readonly overlapBytes: number
    readonly truncated: number
    readonly calls: readonly ReadCall[]
  }[]
  readonly readCoverage: { readonly unknown: Refs; readonly failed: Refs }
  readonly git: readonly {
    readonly session: string
    readonly tool: string
    readonly operation: string
    readonly key: string
    readonly requests: number
    readonly identicalResults: number
    readonly truncated: number
    readonly refs: readonly string[]
  }[]
  readonly candidateSequences: readonly {
    readonly kind: string
    readonly tool: string
    readonly earlier: string
    readonly later: string
  }[]
  readonly outcomes: Record<Exclude<Outcome, 'returned'>, Refs>
  readonly unmatchedResults: Refs
}

const readCall = (read: ReadFact): ReadCall =>
  isTextRead(read)
    ? {
        ref: read.ref,
        requested: read.requested,
        returned: read.returned,
        relation: read.relation.kind,
        earlier: read.relation.kind === 'overlap' ? read.relation.earlier : null,
      }
    : {
        ref: read.ref,
        requested: read.requested ?? null,
        returned: null,
        relation: read.coverage,
        earlier: null,
      }

export const drilldowns = (facts: Facts, period: Period): Drilldowns => {
  const inPeriod = within(period)
  const reads = facts.reads.filter(inPeriod)
  const identified = reads.flatMap(read =>
    read.coverage === 'failed' || read.file === undefined ? [] : [{ read, file: read.file }]
  )
  const readRows = Object.values(
    Arr.groupBy(identified, ({ read, file }) => `${read.session}\u0000${file.key}`)
  )
    .filter(group => group.length > 1)
    .map(group => {
      const { read: first, file } = Arr.headNonEmpty(group)
      const members = group.map(({ read }) => read)
      const overlaps = members
        .filter(isTextRead)
        .flatMap(read => (read.relation.kind === 'overlap' ? [read.relation] : []))
      return {
        session: first.session,
        path: file.path,
        reads: members.length,
        overlaps: overlaps.length,
        identical: count(overlaps, overlap => overlap.identical),
        changed: count(overlaps, overlap => !overlap.identical),
        bytes: Num.sumAll(members.map(read => read.bytes)),
        overlapBytes: Num.sumAll(overlaps.map(overlap => overlap.bytes)),
        truncated: count(
          members,
          read => isTextRead(read) && read.stop !== 'complete' && read.stop !== 'limit'
        ),
        calls: members.slice(0, DRILLDOWN_ROWS).map(readCall),
      }
    })
    .toSorted(
      (a, b) =>
        b.overlaps - a.overlaps ||
        b.reads - a.reads ||
        b.bytes - a.bytes ||
        a.session.localeCompare(b.session) ||
        a.path.localeCompare(b.path)
    )
    .slice(0, DRILLDOWN_ROWS)
  const gitRows = Object.values(
    Arr.groupBy(facts.git.filter(inPeriod), fact => `${fact.session}\u0000${fact.key}`)
  )
    .filter(group => group.length > 1)
    .map(group => {
      const { session, tool, operation, key } = Arr.headNonEmpty(group)
      return {
        session,
        tool,
        operation,
        key,
        requests: group.length,
        identicalResults: count(group, fact => fact.repeat === 'identical'),
        truncated: count(group, fact => fact.truncated),
        refs: group.map(fact => fact.ref).slice(0, DRILLDOWN_ROWS),
      }
    })
    .toSorted(
      (a, b) =>
        b.requests - a.requests || a.session.localeCompare(b.session) || a.key.localeCompare(b.key)
    )
    .slice(0, DRILLDOWN_ROWS)
  const calls = facts.calls.filter(inPeriod)
  const refsOf = (outcome: Outcome) =>
    capped(calls.filter(call => call.outcome === outcome).map(call => call.ref))
  const coverageRefs = (coverage: 'unknown' | 'failed') =>
    capped(reads.filter(read => read.coverage === coverage).map(read => read.ref))
  return {
    reads: readRows,
    readCoverage: { unknown: coverageRefs('unknown'), failed: coverageRefs('failed') },
    git: gitRows,
    candidateSequences: facts.sequences
      .filter(inPeriod)
      .slice(0, DRILLDOWN_ROWS * 2)
      .map(sequence => ({
        kind: sequence.kind,
        tool: sequence.tool,
        earlier: sequence.earlier,
        later: sequence.ref,
      })),
    outcomes: {
      invocation: refsOf('invocation'),
      execution: refsOf('execution'),
      blocked: refsOf('blocked'),
      cancelled: refsOf('cancelled'),
      unclassified: refsOf('unclassified'),
      unmatched: refsOf('unmatched'),
    },
    unmatchedResults: capped(
      facts.results.filter(fact => inPeriod(fact) && !fact.matched).map(fact => fact.ref)
    ),
  }
}

interface UsageRow {
  readonly dimension: 'role' | 'model' | 'effort' | 'skill'
  readonly key: string
  readonly periods: readonly ({
    readonly entries: number
    readonly uncached: number
    readonly output: number
    readonly cacheReadShare: number | null
  } | null)[]
}

interface ToolComparisonRow {
  readonly tool: string
  readonly periods: readonly ({
    readonly invocations: number
    readonly failures: number
    readonly bytes: number
  } | null)[]
}

export interface Comparison {
  readonly baseline: string
  readonly usage: readonly UsageRow[]
  readonly tools: readonly ToolComparisonRow[]
  readonly limitations: readonly string[]
}

const keysOf = <A>(lists: readonly (readonly A[])[], key: (value: A) => string): string[] =>
  [...new Set(lists.flatMap(list => list.map(key)))].toSorted()

export const compare = (summaries: readonly PeriodSummary[]): Comparison | null => {
  const [baseline] = summaries
  if (baseline === undefined || summaries.length < 2) return null
  const usageDimension = (
    dimension: UsageRow['dimension'],
    rowsOf: (summary: PeriodSummary) => readonly GroupRow[]
  ): UsageRow[] =>
    keysOf(summaries.map(rowsOf), row => row.key).map(key => ({
      dimension,
      key,
      periods: summaries.map(summary => {
        const tokens = rowsOf(summary).find(row => row.key === key)?.tokens
        return tokens === undefined || tokens.entries + tokens.unknown === 0
          ? null
          : {
              entries: tokens.entries + tokens.unknown,
              uncached: tokens.uncached,
              output: tokens.output,
              cacheReadShare: tokens.cacheReadShare,
            }
      }),
    }))
  const usage = [
    ...usageDimension('role', summary =>
      ROLES.map(role => ({ key: role, tokens: summary.usage.byRole[role] }))
    ),
    ...usageDimension('model', summary => summary.groups.model),
    ...usageDimension('effort', summary =>
      summary.usage.byEffort.map(row => ({ key: row.effort, tokens: row.tokens }))
    ),
    ...usageDimension('skill', summary => summary.groups.skill),
  ]
  const tools = keysOf(
    summaries.map(summary => summary.tools.byTool),
    row => row.tool
  ).map(tool => ({
    tool,
    periods: summaries.map(summary => {
      const row = summary.tools.byTool.find(candidate => candidate.tool === tool)
      return row === undefined
        ? null
        : { invocations: row.invocations, failures: failureCount(row.outcomes), bytes: row.bytes }
    }),
  }))
  const rows = [...usage, ...tools]
  const partial = count(rows, row => row.periods.includes(null))
  return {
    baseline: baseline.period.label,
    usage,
    tools,
    limitations: [
      ...summaries.flatMap(summary =>
        summary.sample === null ? [`${summary.period.label} has no measurable entries`] : []
      ),
      ...(partial === 0
        ? []
        : [
            `${partial} of ${rows.length} rows have no data in at least one period; their changes are not comparable`,
          ]),
    ],
  }
}
