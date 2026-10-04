import { Array as Arr } from 'effect'
import {
  BACKGROUND_COMPACTION_USAGE,
  type CompactionObservation,
  type DiscardReason,
} from '../src/compaction-observation.ts'
import { type Period, within } from './usage-report.ts'
import type { Entry, SessionRecord, Tokens, Usage } from './usage-sessions.ts'

type Recorded = Extract<Entry, { kind: 'observation' | 'standalone' | 'compaction' }>
type CompactionEntry =
  | Recorded
  | (Pick<Entry, 'id' | 'at' | 'copied'> & {
      readonly kind: Exclude<Entry['kind'], Recorded['kind']>
    })

interface CompactionSession {
  readonly ref: string
  readonly scope: SessionRecord['scope']
  readonly entries: readonly CompactionEntry[]
}

export const compactionSession = (session: SessionRecord): CompactionSession => ({
  ref: session.ref,
  scope: session.scope,
  entries: session.entries.map((entry): CompactionEntry => {
    switch (entry.kind) {
      case 'observation':
      case 'standalone':
      case 'compaction':
        return entry
      default:
        return { kind: entry.kind, id: entry.id, at: entry.at, copied: entry.copied }
    }
  }),
})

type Observation = Extract<Entry, { kind: 'observation' }> & { readonly position: number }
type BackgroundUsage = Extract<Entry, { kind: 'standalone' }>
const ACTIVITY: ReadonlySet<Entry['kind']> = new Set([
  'user',
  'request',
  'result',
  'standalone',
  'compaction',
  'branch-summary',
  'observation',
  'observation-invalid',
])
const isActivity = (entry: CompactionEntry) => ACTIVITY.has(entry.kind)
const totals = (entries: readonly BackgroundUsage[]) => ({
  entries: entries.length,
  unknown: entries.filter(entry => entry.usage === 'unknown').length,
  tokens: entries.reduce(
    (total: Tokens, { usage }: { readonly usage: Usage }) =>
      usage === 'unknown'
        ? total
        : {
            input: total.input + usage.input,
            output: total.output + usage.output,
            cacheRead: total.cacheRead + usage.cacheRead,
            cacheWrite: total.cacheWrite + usage.cacheWrite,
          },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  ),
})
interface NativeCounts {
  starts: number
  completed: number
  aborted: number
  failed: number
  incomplete: number
  crossPeriod: number
  durations: number[]
}
const nativeCounts = (): NativeCounts => ({
  starts: 0,
  completed: 0,
  aborted: 0,
  failed: 0,
  incomplete: 0,
  crossPeriod: 0,
  durations: [],
})
type NativeReason = Extract<CompactionObservation, { kind: 'native-started' }>['reason']

export const compactionReport = (sessions: readonly CompactionSession[], period: Period) => {
  const inPeriod = within(period)
  const fullPeriod = (items: readonly { readonly at: number }[]) => items.every(inPeriod)
  let selectedSessions = 0
  let instrumentedSessions = 0
  let partiallyObservedSessions = 0
  let observationsCount = 0
  let openRuns = 0
  let starts = 0
  let readiness = 0
  let appliedIdle = 0
  let appliedBoundary = 0
  let discards = 0
  let failures = 0
  let incomplete = 0
  let crossPeriod = 0
  let malformed = 0
  let sessionsWithoutStarts = 0
  let unattributedApplications = 0
  let unattributedUsage = 0
  let preparationsWithoutUsage = 0
  const reasons: Partial<Record<DiscardReason, number>> = {}
  let separatelyRecordedApplications = 0
  const preparationMs: number[] = []
  const readyWaitMs: number[] = []
  const overlapMs: number[] = []
  const elapsedMs: number[] = []
  const native: Record<NativeReason, ReturnType<typeof nativeCounts>> = {
    manual: nativeCounts(),
    threshold: nativeCounts(),
    overflow: nativeCounts(),
  }
  const observedUsage: BackgroundUsage[] = []
  const drilldowns: {
    session: string
    scope: SessionRecord['scope']
    preparation: string
    outcome: string
    reason: string | null
    complete: boolean
    crossPeriod: boolean
    outcomeInPeriod: boolean
    usageEntries: number
    unknownUsage: number
    usageOutsidePeriod: number
    usageCoverage: 'observed' | 'unobserved'
    tokens: Tokens
    refs: string[]
  }[] = []

  for (const session of sessions) {
    const measured = session.entries.filter(entry => !entry.copied)
    if (!measured.some(entry => isActivity(entry) && inPeriod(entry))) continue
    selectedSessions++
    const positions = new Map(session.entries.map((entry, index) => [entry.id, index]))
    const observations: Observation[] = []
    const activeRuns = new Set<string>()
    let covered = false
    const uncoveredEntries = new Set<string>()
    for (const [position, entry] of session.entries.entries()) {
      if (entry.copied) continue
      if (entry.kind === 'observation') {
        observations.push({ ...entry, position })
        if (entry.value.kind === 'attached') activeRuns.add(entry.value.runId)
        if (inPeriod(entry)) {
          observationsCount++
          if (activeRuns.has(entry.value.runId)) covered = true
          else uncoveredEntries.add(entry.id)
        }
        if (entry.value.kind === 'detached') activeRuns.delete(entry.value.runId)
      } else if (isActivity(entry) && inPeriod(entry)) {
        if (entry.kind === 'observation-invalid') malformed++
        if (activeRuns.size > 0) covered = true
        else uncoveredEntries.add(entry.id)
      }
    }
    openRuns += activeRuns.size
    const attached = (runId: string, position: number) => {
      const markers = observations.filter(
        item => item.value.runId === runId && item.value.kind === 'attached'
      )
      return (
        markers.length === 1 &&
        markers[0] !== undefined &&
        markers[0].position < position &&
        !observations.some(
          item =>
            item.value.runId === runId && item.value.kind === 'detached' && item.position < position
        )
      )
    }
    const usages = measured.filter(
      (entry): entry is BackgroundUsage =>
        entry.kind === 'standalone' && entry.usageKind === BACKGROUND_COMPACTION_USAGE
    )
    observedUsage.push(...usages.filter(inPeriod))
    const backgrounds = observations.flatMap(item =>
      item.value.kind === 'background-started' ||
      item.value.kind === 'background-ready' ||
      item.value.kind === 'background-ended'
        ? [{ ...item, value: item.value }]
        : []
    )
    const groups = Arr.groupBy(backgrounds, (item): string => item.value.id)
    const attributedUsage = new Set<string>()
    let sessionStarts = 0
    for (const [id, chain] of Object.entries(groups)) {
      const usage = usages.filter(item => item.usageNote === id)
      if (!chain.some(inPeriod) && !usage.some(inPeriod)) continue
      const beginnings = chain.flatMap(item =>
        item.value.kind === 'background-started' ? [{ ...item, value: item.value }] : []
      )
      const readies = chain.flatMap(item =>
        item.value.kind === 'background-ready' ? [{ ...item, value: item.value }] : []
      )
      const endings = chain.flatMap(item =>
        item.value.kind === 'background-ended' ? [{ ...item, value: item.value }] : []
      )
      const [began] = beginnings
      const [ready] = readies
      const [ended] = endings
      const oneRun = new Set(chain.map(item => item.value.runId)).size === 1
      const unique = oneRun && beginnings.length <= 1 && readies.length <= 1 && endings.length <= 1
      const knownEnd = unique && ended !== undefined
      const validStart =
        began !== undefined &&
        beginnings.length === 1 &&
        oneRun &&
        attached(began.value.runId, began.position)
      const validReady =
        validStart &&
        ready !== undefined &&
        readies.length === 1 &&
        ready.position > began.position &&
        ready.value.activeRunOverlapMs <= ready.value.preparationMs
      const validEnd =
        validStart &&
        ended !== undefined &&
        endings.length === 1 &&
        ended.position > began.position &&
        ended.value.activeRunOverlapMs <= ended.value.elapsedMs &&
        (ready === undefined ||
          (validReady &&
            ready.position < ended.position &&
            ready.value.preparationMs <= ended.value.elapsedMs &&
            ready.value.activeRunOverlapMs === ended.value.activeRunOverlapMs))
      if (began && beginnings.length === 1 && inPeriod(began)) {
        starts++
        sessionStarts++
      }
      if (ready && readies.length === 1 && inPeriod(ready)) readiness++
      const crosses = !fullPeriod(chain)
      if (crosses) crossPeriod++
      const claimed = ended?.value.outcome
      const commitPosition =
        claimed?.kind === 'applied' ? positions.get(claimed.entryId) : undefined
      const commit = commitPosition === undefined ? undefined : session.entries[commitPosition]
      const validCommit =
        knownEnd &&
        commit?.kind === 'compaction' &&
        !commit.copied &&
        commitPosition !== undefined &&
        commitPosition < ended.position &&
        (began === undefined || commitPosition > began.position) &&
        (ready === undefined || commitPosition > ready.position)
      const complete = validEnd && (claimed?.kind !== 'applied' || (validReady && validCommit))
      if (!complete) incomplete++
      if (unique)
        for (const entry of usage) {
          attributedUsage.add(entry.id)
          if (uncoveredEntries.delete(entry.id)) covered = true
        }
      if (usage.length === 0) preparationsWithoutUsage++
      if (validReady && fullPeriod([began, ready])) {
        preparationMs.push(ready.value.preparationMs)
        overlapMs.push(ready.value.activeRunOverlapMs)
      }
      if (validEnd && fullPeriod([began, ended])) {
        elapsedMs.push(ended.value.elapsedMs)
        if (ready === undefined) overlapMs.push(ended.value.activeRunOverlapMs)
      }
      let outcome = 'incomplete'
      const reason = claimed?.kind === 'discarded' ? claimed.reason : null
      if (knownEnd && claimed?.kind === 'discarded') {
        outcome = reason === 'failure' ? 'failed' : 'discarded'
        if (ended && inPeriod(ended)) {
          reasons[claimed.reason] = (reasons[claimed.reason] ?? 0) + 1
          if (reason === 'failure') failures++
          else discards++
        }
      } else if (claimed?.kind === 'applied') {
        outcome = 'unattributed-application'
        if (validCommit) {
          outcome = claimed.placement
          if (inPeriod(commit) && commit.usage === 'unknown' && usage.length > 0)
            separatelyRecordedApplications++
          if (inPeriod(ended)) {
            if (claimed.placement === 'idle') appliedIdle++
            else appliedBoundary++
          }
          if (validEnd && validReady && fullPeriod([ready, ended, commit]))
            readyWaitMs.push(ended.value.elapsedMs - ready.value.preparationMs)
        } else if (ended && inPeriod(ended)) unattributedApplications++
      }
      const selectedUsage = usage.filter(inPeriod)
      const total = totals(selectedUsage)
      drilldowns.push({
        session: session.ref,
        scope: session.scope,
        preparation: id,
        outcome,
        reason,
        complete,
        crossPeriod: crosses,
        outcomeInPeriod: ended !== undefined && inPeriod(ended),
        usageEntries: total.entries,
        unknownUsage: total.unknown,
        tokens: total.tokens,
        usageOutsidePeriod: usage.length - selectedUsage.length,
        usageCoverage: usage.length === 0 ? 'unobserved' : 'observed',
        refs: [
          ...chain.map(item => `${session.ref}#${item.id}`),
          ...usage.map(item => `${session.ref}#${item.id}`),
        ],
      })
    }
    unattributedUsage += usages.filter(
      item => inPeriod(item) && !attributedUsage.has(item.id)
    ).length
    if (covered) instrumentedSessions++
    if (covered && uncoveredEntries.size > 0) partiallyObservedSessions++
    if (covered && uncoveredEntries.size === 0 && sessionStarts === 0) sessionsWithoutStarts++

    const nativeEvents = observations.flatMap(item =>
      item.value.kind === 'native-started' || item.value.kind === 'native-ended'
        ? [{ ...item, value: item.value }]
        : []
    )
    for (const chain of Object.values(Arr.groupBy(nativeEvents, (item): string => item.value.id))) {
      if (!chain.some(inPeriod)) continue
      const beginnings = chain.flatMap(item =>
        item.value.kind === 'native-started' ? [{ ...item, value: item.value }] : []
      )
      const endings = chain.flatMap(item =>
        item.value.kind === 'native-ended' ? [{ ...item, value: item.value }] : []
      )
      const [began] = beginnings
      const [ended] = endings
      const counts = began === undefined ? undefined : native[began.value.reason]
      if (counts && began && beginnings.length === 1 && inPeriod(began)) counts.starts++
      const crosses = !fullPeriod(chain)
      if (crosses) {
        crossPeriod++
        if (counts) counts.crossPeriod++
      }
      if (
        began === undefined ||
        ended === undefined ||
        beginnings.length !== 1 ||
        endings.length !== 1 ||
        began.position >= ended.position ||
        began.value.runId !== ended.value.runId ||
        !attached(began.value.runId, began.position)
      ) {
        incomplete++
        if (counts) counts.incomplete++
        continue
      }
      const counted = native[began.value.reason]
      if (inPeriod(ended)) counted[ended.value.outcome]++
      if (!crosses) counted.durations.push(ended.value.elapsedMs)
    }
  }
  let coverage: 'available' | 'partial' | 'unavailable' = 'unavailable'
  if (
    instrumentedSessions === selectedSessions &&
    selectedSessions > 0 &&
    partiallyObservedSessions === 0
  )
    coverage = 'available'
  else if (instrumentedSessions > 0 || observationsCount > 0 || malformed > 0) coverage = 'partial'
  const count = (value: number) => (coverage === 'unavailable' ? null : value)
  return {
    coverage,
    selectedSessions,
    instrumentedSessions,
    partiallyObservedSessions,
    unobservedSessions: selectedSessions - instrumentedSessions,
    openRuns,
    observations: observationsCount,
    starts: count(starts),
    readiness: count(readiness),
    appliedIdle: count(appliedIdle),
    appliedBoundary: count(appliedBoundary),
    discards: count(discards),
    failures: count(failures),
    discardReasons: reasons,
    preparationMs,
    readyWaitMs,
    overlapMs,
    elapsedMs,
    native,
    observedUsage: totals(observedUsage),
    unattributedUsage,
    preparationsWithoutUsage,
    unattributedApplications,
    separatelyRecordedApplications,
    incomplete,
    crossPeriod,
    malformed,
    sessionsWithoutStarts,
    drilldowns,
  }
}
export type CompactionReport = ReturnType<typeof compactionReport>
