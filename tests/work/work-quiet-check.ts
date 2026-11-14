import assert from 'node:assert/strict'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as TestClock from 'effect/testing/TestClock'
import { asAttemptId } from '../../src/work-domain.ts'
import {
  cacheWarm,
  makeQuietLedger,
  QUIET_AFTER_MS,
  wakesForQuiet,
  watchQuiet,
} from '../../src/work-quiet.ts'
import { makeClaims } from '../workspace/workspace-check-support.ts'

const { claim, passed } = makeClaims()

const T0 = Date.parse('2026-11-14T12:00:00.000Z')
const at = (ms: number) => new Date(T0 + ms).toISOString()
const assistant = (ms: number) => ({
  type: 'message',
  timestamp: at(ms),
  message: { role: 'assistant' },
})
const user = (ms: number) => ({ type: 'message', timestamp: at(ms), message: { role: 'user' } })
const usage = (ms: number) => ({ type: 'usage', timestamp: at(ms) })
const custom = (ms: number) => ({ type: 'custom_message', timestamp: at(ms) })

await claim(
  'the cache is warm until five minutes after the last assistant message or usage entry: 4:59 is warm, 5:00 is cold',
  () => {
    const branch = [user(-1000), assistant(0)]
    assert.equal(cacheWarm(branch, T0 + 299_000), true)
    assert.equal(cacheWarm(branch, T0 + 300_000), false)
    assert.equal(cacheWarm([], T0), false, 'no request means cold')
    assert.equal(
      cacheWarm([user(0), custom(10)], T0 + 20),
      false,
      'user and custom entries are not requests'
    )
    assert.equal(
      cacheWarm([assistant(0), user(250_000), custom(260_000)], T0 + 300_000),
      false,
      'a later user or custom entry does not refresh the cache'
    )
    const warmed = [assistant(0), usage(240_000)]
    assert.equal(cacheWarm(warmed, T0 + 400_000), true, 'a cache warming usage entry is a request')
    assert.equal(cacheWarm(warmed, T0 + 540_000), false)
  }
)

await claim('a resting lead wakes only when idle, warm and allowed to continue', () => {
  const base = { streaming: false, idle: true, warm: true, canReactivate: true }
  assert.equal(wakesForQuiet(base), true)
  assert.equal(wakesForQuiet({ ...base, streaming: true }), false)
  assert.equal(wakesForQuiet({ ...base, idle: false }), false)
  assert.equal(wakesForQuiet({ ...base, warm: false }), false)
  assert.equal(wakesForQuiet({ ...base, canReactivate: false }), false)
})

const advance = (seconds: number) => TestClock.adjust(`${seconds} seconds`)

const watched = Effect.gen(function* () {
  let size = 0
  let active = true
  const events: string[] = []
  const fiber = yield* Effect.forkChild(
    watchQuiet({
      size: Effect.sync(() => size),
      active: () => active,
      quietAfterMs: QUIET_AFTER_MS,
      onQuiet: since => events.push(`quiet since ${since / 1000}s`),
      onResumed: () => events.push('resumed'),
    })
  )
  yield* Effect.yieldNow
  yield* advance(115)
  const beforeThreshold = [...events]
  yield* advance(5)
  const atThreshold = [...events]
  yield* advance(300)
  const stillQuiet = [...events]
  size = 10
  yield* advance(5)
  const resumed = [...events]
  yield* advance(115)
  const beforeSecond = [...events]
  yield* advance(5)
  const second = [...events]
  size = 20
  yield* advance(60)
  size = 30
  yield* advance(60)
  size = 40
  yield* advance(60)
  const busy = [...events]
  active = false
  yield* advance(5)
  yield* Fiber.join(fiber)
  return { beforeThreshold, atThreshold, stillQuiet, resumed, beforeSecond, second, busy }
}).pipe(Effect.provide(TestClock.layer()))

await claim(
  'detection on the test clock: nothing before two minutes, one event at the threshold, output resets the episode, a later silence raises a new one, and steady output never does',
  async () => {
    const seen = await Effect.runPromise(watched)
    assert.deepEqual(seen.beforeThreshold, [])
    assert.deepEqual(seen.atThreshold, ['quiet since 0s'])
    assert.deepEqual(seen.stillQuiet, seen.atThreshold, 'one event per silence')
    assert.deepEqual(seen.resumed, ['quiet since 0s', 'resumed'])
    assert.deepEqual(seen.beforeSecond, seen.resumed)
    assert.deepEqual(seen.second, ['quiet since 0s', 'resumed', 'quiet since 425s'])
    assert.deepEqual(seen.busy, [...seen.second, 'resumed'])
  }
)

const A = asAttemptId('00000000-0000-0000-0000-000000000001')
const B = asAttemptId('00000000-0000-0000-0000-000000000002')

await claim(
  'a notice invalidated while its message is built is omitted, for a run start and for a boundary, and spends no allowance',
  () => {
    const ledger = makeQuietLedger()
    const a = ledger.quiet(A, 'tests', 1)
    const b = ledger.quiet(B, 'build', 2)
    assert.deepEqual(ledger.takeForRun(), [
      [A, a],
      [B, b],
    ])
    ledger.invalidate(A)
    assert.equal(ledger.include(A, a), false)
    assert.equal(ledger.include(B, b), true)
    const again = ledger.quiet(A, 'tests', 9)
    assert.equal(again.reach, 'model', 'an omitted notice spends no allowance')
    assert.deepEqual(ledger.takeForBoundary(), [[A, again]])
    ledger.invalidate(A)
    assert.equal(ledger.include(A, again), false)
    assert.equal(ledger.quiet(A, 'tests', 20).reach, 'model')
  }
)

await claim(
  'a notice whose inspection fails is held again; an attempt with a send in flight is neither offered nor taken by a run',
  () => {
    const ledger = makeQuietLedger()
    const a = ledger.quiet(A, 'tests', 1)
    ledger.takeForRun()
    ledger.restore(A, a)
    assert.deepEqual(ledger.held(), [[A, a]])
    assert.equal(ledger.forModel(A), a)

    ledger.reserve(A, a)
    ledger.begin(A)
    ledger.invalidate(A)
    const newer = ledger.quiet(A, 'tests', 7)
    assert.equal(ledger.forModel(A), undefined)
    assert.deepEqual(ledger.takeForRun(), [])
    assert.deepEqual(ledger.held(), [[A, newer]], 'the run keeps it for after the send')
  }
)

await claim(
  'a run start drops notices meant only for the user while a boundary leaves them for the program status',
  () => {
    const ledger = makeQuietLedger()
    const a = ledger.quiet(A, 'tests', 1)
    ledger.takeForRun()
    assert.equal(ledger.include(A, a), true)
    const later = ledger.quiet(A, 'tests', 5)
    assert.equal(later.reach, 'user')
    const b = ledger.quiet(B, 'build', 6)
    assert.deepEqual(ledger.takeForBoundary(), [[B, b]])
    assert.deepEqual(ledger.held(), [[A, later]])
    assert.deepEqual(ledger.takeForRun(), [])
    assert.deepEqual(ledger.held(), [])
  }
)

console.log(JSON.stringify({ result: 'passed', checks: passed }, null, 2))
