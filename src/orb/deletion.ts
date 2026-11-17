import * as Clock from 'effect/Clock'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import type { Orbit } from './cloud.ts'
import { orbFailure, shortId, type OrbError } from './domain.ts'
import type { OrbRecordHandle } from './registry.ts'

const DELETE_WAIT_MS = 60_000

export const clock = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export type DeletionProgress =
  | { readonly kind: 'status'; readonly status: string; readonly spentMs: number }
  | { readonly kind: 'deleted' }

export type DeletionReport = (progress: DeletionProgress) => Effect.Effect<void>

export const printDeletion =
  (orbId: string, print: (line: string) => void): DeletionReport =>
  progress =>
    Effect.sync(() =>
      print(
        progress.kind === 'deleted'
          ? `orb ${shortId(orbId)} deleted`
          : `Deleting orb ${shortId(orbId)} (${progress.status} ${clock(progress.spentMs)})`
      )
    )

export const deleteOrb = Effect.fnUntraced(function* (
  orbit: Orbit,
  orbId: string,
  report: DeletionReport,
  stop: Effect.Effect<void> = Effect.never
): Effect.fn.Return<void, OrbError> {
  const label = shortId(orbId)
  const started = yield* Clock.currentTimeMillis
  let last = (yield* orbit.remove(orbId)).status
  yield* report({ kind: 'status', status: last, spentMs: 0 })
  const wait = Effect.gen(function* () {
    for (;;) {
      const view = yield* orbit.get(orbId)
      const spent = (yield* Clock.currentTimeMillis) - started
      if (view.status !== last) {
        last = view.status
        yield* report({ kind: 'status', status: view.status, spentMs: spent })
      }
      if (view.status === 'DELETED') return
      if (spent > DELETE_WAIT_MS)
        return yield* orbFailure(`orb ${label} still reads ${view.status} after ${clock(spent)}`)
      yield* Effect.sleep(Duration.seconds(2))
    }
  })
  yield* Effect.raceFirst(
    wait,
    Effect.andThen(stop, () =>
      Effect.fail(
        orbFailure(`the wait for DELETED was interrupted while orb ${label} read ${last}`)
      )
    )
  )
  yield* report({ kind: 'deleted' })
})

export const deleteRecorded = (
  orbit: Orbit,
  record: OrbRecordHandle,
  orbId: string,
  report: DeletionReport,
  stop?: Effect.Effect<void>
): Effect.Effect<void, OrbError> =>
  record
    .update({ phase: 'deleting' })
    .pipe(Effect.andThen(deleteOrb(orbit, orbId, report, stop)), Effect.andThen(record.remove))
