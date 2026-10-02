import { Schema } from 'effect'

export const COMPACTION_OBSERVATION = 'dev:compaction-observation'
export const BACKGROUND_COMPACTION_USAGE = 'background_compaction'
const UUID = Schema.String.check(Schema.isPattern(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/))
export const CompactionRunId = UUID.pipe(Schema.brand('dev/compaction/RunId'))
export const PreparationId = UUID.pipe(Schema.brand('dev/compaction/PreparationId'))
export const NativeSpanId = UUID.pipe(Schema.brand('dev/compaction/NativeSpanId'))
const Milliseconds = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
export const DiscardReason = Schema.Literals([
  'escape',
  'abort',
  'navigation',
  'reload',
  'shutdown',
  'stale-context',
  'superseded',
  'boundary-rejected',
  'failure',
])
const Outcome = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('applied'),
    entryId: Schema.NonEmptyString,
    placement: Schema.Literals(['idle', 'boundary']),
  }),
  Schema.Struct({ kind: Schema.Literal('discarded'), reason: DiscardReason }),
])
const run = { runId: CompactionRunId }
export const CompactionObservation = Schema.Union([
  Schema.Struct({ ...run, kind: Schema.Literal('attached') }),
  Schema.Struct({ ...run, kind: Schema.Literal('background-started'), id: PreparationId }),
  Schema.Struct({
    ...run,
    kind: Schema.Literal('background-ready'),
    id: PreparationId,
    preparationMs: Milliseconds,
    activeRunOverlapMs: Milliseconds,
  }),
  Schema.Struct({
    ...run,
    kind: Schema.Literal('background-ended'),
    id: PreparationId,
    outcome: Outcome,
    elapsedMs: Milliseconds,
    activeRunOverlapMs: Milliseconds,
  }),
  Schema.Struct({
    ...run,
    kind: Schema.Literal('native-started'),
    id: NativeSpanId,
    reason: Schema.Literals(['manual', 'threshold', 'overflow']),
  }),
  Schema.Struct({
    ...run,
    kind: Schema.Literal('native-ended'),
    id: NativeSpanId,
    outcome: Schema.Literals(['completed', 'aborted', 'failed']),
    elapsedMs: Milliseconds,
  }),
  Schema.Struct({ ...run, kind: Schema.Literal('detached') }),
])
export type CompactionObservation = typeof CompactionObservation.Type
export type DiscardReason = typeof DiscardReason.Type
export const decodeCompactionObservation = Schema.decodeUnknownOption(CompactionObservation, {
  onExcessProperty: 'error',
})
export const decodePreparationId = Schema.decodeUnknownOption(PreparationId)
