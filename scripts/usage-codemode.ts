import * as HashMap from 'effect/HashMap'
import * as Option from 'effect/Option'
import { requestedRange, type RequestedRange } from './usage-facts.ts'
import type { Period } from './usage-report.ts'
import { type Entry, type SessionRecord, walkBranches } from './usage-sessions.ts'

type Requested = HashMap.HashMap<string, readonly RequestedRange[]>

interface ReadRequests {
  readonly requests: number
  readonly repeated: number
  readonly unknown: number
}

const NO_READS: ReadRequests = { requests: 0, repeated: 0, unknown: 0 }

const overlaps = (one: RequestedRange, other: RequestedRange) =>
  one.start <= (other.end ?? Infinity) && other.start <= (one.end ?? Infinity)

const readRequests = (
  earlier: Requested,
  entry: Entry
): { readonly requested: Requested; readonly reads: ReadRequests } => {
  if (entry.kind !== 'result' || typeof entry.nestedCalls === 'string')
    return { requested: earlier, reads: NO_READS }
  let requested = earlier
  const reads = { requests: 0, repeated: 0, unknown: 0 }
  for (const { name, input } of entry.nestedCalls.calls) {
    if (name !== 'read') continue
    const range = input.kind === 'read' ? requestedRange(input.range) : undefined
    if (input.kind !== 'read' || input.range === 'undecodable' || range === undefined) {
      reads.unknown++
      continue
    }
    reads.requests++
    if (input.range.limit === 0) continue
    const known = Option.getOrElse(
      HashMap.get(requested, input.path),
      (): readonly RequestedRange[] => []
    )
    if (known.some(other => overlaps(range, other))) reads.repeated++
    requested = HashMap.set(requested, input.path, [...known, range])
  }
  return { requested, reads }
}

export const codemodeSession = (session: SessionRecord) => {
  const reads = new Map<Entry, ReadRequests>()
  walkBranches(
    session,
    HashMap.empty<string, readonly RequestedRange[]>(),
    (earlier, ancestor) => readRequests(earlier, ancestor).requested,
    (earlier, entry) => {
      reads.set(entry, readRequests(earlier, entry).reads)
    }
  )
  const declared = new Map<Entry, number | undefined>()
  walkBranches(
    session,
    HashMap.empty<string, number | undefined>(),
    (earlier, ancestor) =>
      ancestor.kind === 'request'
        ? ancestor.calls.reduce(
            (issued, call) =>
              HashMap.set(
                issued,
                call.id,
                call.input.kind === 'script' ? call.input.declaredLimit : undefined
              ),
            earlier
          )
        : earlier,
    (earlier, entry) => {
      if (entry.kind === 'result')
        declared.set(entry, Option.getOrUndefined(HashMap.get(earlier, entry.callId)))
    }
  )
  return session.entries.flatMap(entry =>
    !entry.copied && entry.kind === 'result' && entry.tool === 'codemode'
      ? [
          {
            at: entry.at,
            scope: session.scope,
            cut: entry.fullOutputSaved,
            declaredLimit: declared.get(entry),
            nested: entry.nestedCalls,
            reads: reads.get(entry) ?? NO_READS,
          },
        ]
      : []
  )
}

type Observation = ReturnType<typeof codemodeSession>[number]

export const codemodeReport = (observations: readonly Observation[], period: Period) => {
  const coverage = {
    results: 0,
    recorded: 0,
    missing: 0,
    malformed: 0,
    incomplete: 0,
    malformedCalls: 0,
  }
  const groups = new Map<
    string,
    { ok: number; error: number; unfinished: number; durations: number[] }
  >()
  const reads = { requests: 0, repeated: 0, unknown: 0 }
  const scripts = {
    lead: { results: 0, cut: 0, declared: 0 },
    child: { results: 0, cut: 0, declared: 0 },
  }
  const declaredLimits = new Map<number, number>()
  let operations = 0
  for (const {
    at,
    scope,
    cut: outputCut,
    declaredLimit,
    nested,
    reads: observed,
  } of observations) {
    if (
      (period.start !== undefined && at < period.start) ||
      (period.end !== undefined && at >= period.end)
    )
      continue
    coverage.results++
    scripts[scope].results++
    if (outputCut) scripts[scope].cut++
    if (declaredLimit !== undefined) {
      scripts[scope].declared++
      declaredLimits.set(declaredLimit, (declaredLimits.get(declaredLimit) ?? 0) + 1)
    }
    if (typeof nested === 'string') {
      coverage[nested]++
      continue
    }
    coverage.recorded++
    if (!nested.complete) coverage.incomplete++
    coverage.malformedCalls += nested.malformedCalls
    reads.requests += observed.requests
    reads.repeated += observed.repeated
    reads.unknown += observed.unknown
    for (const call of nested.calls) {
      operations++
      const group = groups.get(call.name) ?? { ok: 0, error: 0, unfinished: 0, durations: [] }
      group[call.status]++
      if (call.durationMs !== undefined) group.durations.push(call.durationMs)
      groups.set(call.name, group)
    }
  }
  return {
    coverage,
    operations,
    reads,
    scripts,
    declaredLimits: [...declaredLimits]
      .toSorted(([a], [b]) => a - b)
      .map(([limit, results]) => ({ limit, results })),
    byTool: [...groups]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([tool, group]) => {
        const durations = group.durations.toSorted((a, b) => a - b)
        return {
          tool,
          ok: group.ok,
          error: group.error,
          unfinished: group.unfinished,
          durations: {
            samples: group.durations.length,
            medianMs: durations[Math.ceil(durations.length / 2) - 1] ?? null,
            maxMs: durations.at(-1) ?? null,
          },
        }
      }),
  }
}

export type CodemodeReport = ReturnType<typeof codemodeReport>
