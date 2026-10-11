import { Option, Schema } from 'effect'
import type { Period } from './usage-report.ts'
import type { SessionRecord } from './usage-sessions.ts'

const decodeEnvelope = Schema.decodeUnknownOption(
  Schema.Struct({
    calls: Schema.Array(Schema.Unknown),
    complete: Schema.Boolean,
  })
)
const Call = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  status: Schema.Literals(['ok', 'error', 'unfinished']),
  durationMs: Schema.optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
})
const decodeCall = Schema.decodeUnknownOption(Call)

type Nested =
  | 'missing'
  | 'malformed'
  | {
      readonly complete: boolean
      readonly malformedCalls: number
      readonly calls: readonly (typeof Call.Type)[]
    }

export const decodeNestedCalls = (value: unknown): Nested => {
  if (value === undefined) return 'missing'
  const envelope = decodeEnvelope(value)
  if (Option.isNone(envelope)) return 'malformed'
  const calls = envelope.value.calls.flatMap(call => Option.toArray(decodeCall(call)))
  return {
    complete: envelope.value.complete,
    malformedCalls: envelope.value.calls.length - calls.length,
    calls,
  }
}

export const codemodeSession = (session: SessionRecord) =>
  session.entries.flatMap(entry =>
    !entry.copied && entry.kind === 'result' && entry.tool === 'codemode'
      ? [{ at: entry.at, nested: entry.nestedCalls }]
      : []
  )

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
  let operations = 0
  for (const { at, nested } of observations) {
    if (
      (period.start !== undefined && at < period.start) ||
      (period.end !== undefined && at >= period.end)
    )
      continue
    coverage.results++
    if (typeof nested === 'string') {
      coverage[nested]++
      continue
    }
    coverage.recorded++
    if (!nested.complete) coverage.incomplete++
    coverage.malformedCalls += nested.malformedCalls
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
