import { Clock, Duration, Effect } from 'effect'
import type { Orbit } from './cloud.ts'
import { orbFailure, shortId, type OrbError } from './domain.ts'
import type { OrbRecordHandle } from './registry.ts'

const DELETE_WAIT_MS = 60_000

export const clock = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export const deleteOrb = Effect.fnUntraced(function* (
  orbit: Orbit,
  orbId: string,
  print: (line: string) => void,
  stop: Effect.Effect<void> = Effect.never
): Effect.fn.Return<void, OrbError> {
  const label = shortId(orbId)
  const started = yield* Clock.currentTimeMillis
  let last = (yield* orbit.remove(orbId)).status
  print(`Deleting orb ${label} (${last} 0:00)`)
  const wait = Effect.gen(function* () {
    for (;;) {
      const view = yield* orbit.get(orbId)
      const spent = (yield* Clock.currentTimeMillis) - started
      if (view.status !== last) {
        last = view.status
        print(`Deleting orb ${label} (${view.status} ${clock(spent)})`)
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
  print(`orb ${label} deleted`)
})

export const deleteRecorded = (
  orbit: Orbit,
  record: OrbRecordHandle,
  orbId: string,
  print: (line: string) => void,
  stop?: Effect.Effect<void>
): Effect.Effect<void, OrbError> =>
  record
    .update({ phase: 'deleting' })
    .pipe(Effect.andThen(deleteOrb(orbit, orbId, print, stop)), Effect.andThen(record.remove))
