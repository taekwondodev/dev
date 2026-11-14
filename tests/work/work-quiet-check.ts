import assert from 'node:assert/strict'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as TestClock from 'effect/testing/TestClock'
import { asAttemptId } from '../../src/work-domain.ts'
import {
  CACHE_WINDOW_MS,
  makeQuietLedger,
  cacheWarm,
  lastRequestAt,
  QUIET_AFTER_MS,
  quietPollMs,
  quietRoute,
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

await claim('the threshold is two minutes and the cache window five, as in the footer', () => {
  assert.equal(QUIET_AFTER_MS, 120_000)
  assert.equal(CACHE_WINDOW_MS, 300_000)
  assert.equal(quietPollMs(QUIET_AFTER_MS), 5000)
})

await claim(
  'the last request is the latest assistant message or usage entry on the branch; user and custom entries do not count',
  () => {
    assert.equal(lastRequestAt([]), undefined)
    assert.equal(lastRequestAt([user(0), custom(10)]), undefined)
    assert.equal(lastRequestAt([assistant(0), user(5), custom(9)]), T0)
    assert.equal(lastRequestAt([assistant(0), usage(60_000), user(70_000)]), T0 + 60_000)
  }
)

await claim(
  'the cache is warm until five minutes after the last request: 4:59 is warm, 5:00 is cold',
  () => {
    const branch = [user(-1000), assistant(0)]
    assert.equal(cacheWarm(branch, T0 + 299_000), true)
    assert.equal(cacheWarm(branch, T0 + 300_000), false)
    assert.equal(cacheWarm([user(0)], T0), false, 'no request means cold')
  }
)

await claim('a cache warming usage entry keeps the cache warm past the last answer', () => {
  const branch = [assistant(0), usage(240_000)]
  assert.equal(cacheWarm(branch, T0 + 400_000), true)
  assert.equal(cacheWarm(branch, T0 + 540_000), false)
})

await claim(
  'routing: consumed reaches only the user; a run receives it at its next boundary; a resting lead wakes only when warm and allowed; otherwise the notice is held',
  () => {
    const base = { consumed: false, streaming: false, idle: true, warm: true, canReactivate: true }
    assert.equal(quietRoute(base), 'wake')
    assert.equal(quietRoute({ ...base, consumed: true }), 'user')
    assert.equal(quietRoute({ ...base, consumed: true, streaming: true }), 'user')
    assert.equal(quietRoute({ ...base, streaming: true, idle: false, warm: false }), 'boundary')
    assert.equal(quietRoute({ ...base, warm: false }), 'hold')
    assert.equal(quietRoute({ ...base, canReactivate: false }), 'hold')
    assert.equal(quietRoute({ ...base, idle: false }), 'hold')
  }
)

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
  'a notice taken for a run is omitted when its command resumes or settles while the message is built',
  () => {
    const ledger = makeQuietLedger()
    const a = ledger.quiet(A, 'tests', 1)
    const b = ledger.quiet(B, 'build', 2)
    const taken = ledger.takeForRun()
    assert.deepEqual(taken, [
      [A, a],
      [B, b],
    ])
    assert.deepEqual(ledger.held(), [], 'taking clears the user-facing hold')
    ledger.invalidate(A)
    assert.equal(ledger.include(A, a), false, 'resumed or settled during construction')
    assert.equal(ledger.include(B, b), true)
    const again = ledger.quiet(A, 'tests', 9)
    assert.equal(again.reach, 'model', 'an omitted notice spends no allowance')
    assert.equal(ledger.quiet(B, 'build', 9).reach, 'user', 'an included notice spends it')
  }
)

await claim(
  'a notice whose construction or submission fails is held again with its allowance intact',
  () => {
    const ledger = makeQuietLedger()
    const a = ledger.quiet(A, 'tests', 1)
    const b = ledger.quiet(B, 'build', 2)
    ledger.takeForRun()
    ledger.restore(A, a)
    assert.equal(ledger.include(B, b), true)
    assert.deepEqual(ledger.held(), [[A, a]], 'the failed inspection waits for the next run')
    assert.equal(ledger.forModel(A), a)

    ledger.reserve(A, a)
    ledger.begin(A)
    assert.equal(ledger.forModel(A), undefined, 'no second delivery while a send is in flight')
    ledger.acknowledge(A, a, false)
    assert.equal(ledger.forModel(A), a, 'a refused send keeps the notice for the model')

    ledger.reserve(A, a)
    ledger.begin(A)
    ledger.invalidate(A)
    ledger.acknowledge(A, a, false)
    assert.deepEqual(ledger.held(), [], 'a notice invalidated during the send is not restored')
  }
)

await claim(
  'a silence that starts while an earlier send is unresolved stays for the model if that send is refused, and for the user if it succeeds',
  () => {
    for (const outcome of ['refused', 'delivered'] as const) {
      const ledger = makeQuietLedger()
      const first = ledger.quiet(A, 'tests', 1)
      ledger.reserve(A, first)
      ledger.begin(A)
      ledger.invalidate(A)
      const second = ledger.quiet(A, 'tests', 7)
      assert.equal(second.reach, 'model')
      assert.equal(ledger.forModel(A), undefined, 'the attempt has a send in flight')
      assert.deepEqual(ledger.takeForRun(), [], 'a run does not take it during the send')
      assert.deepEqual(ledger.held(), [[A, second]], 'a run does not drop it either')
      if (outcome === 'refused') {
        ledger.acknowledge(A, first, false)
        assert.equal(ledger.forModel(A), second)
        const taken = ledger.takeForRun()
        assert.deepEqual(taken, [[A, second]], 'only the newer notice is delivered')
        assert.equal(ledger.include(A, second), true)
      } else {
        ledger.acknowledge(A, first, true)
        assert.deepEqual(ledger.held(), [[A, { ...second, reach: 'user' }]])
        assert.equal(ledger.forModel(A), undefined)
        assert.deepEqual(ledger.takeForRun(), [])
      }
      assert.equal(ledger.quiet(A, 'tests', 20).reach, 'user', `allowance spent once (${outcome})`)
    }
  }
)

await claim(
  'a run boundary takes only the notices for the model and leaves notices for the user in place',
  () => {
    const ledger = makeQuietLedger()
    const a = ledger.quiet(A, 'tests', 1)
    ledger.takeForRun()
    assert.equal(ledger.include(A, a), true)
    const later = ledger.quiet(A, 'tests', 5)
    const b = ledger.quiet(B, 'build', 6)
    assert.deepEqual(ledger.takeForBoundary(), [[B, b]])
    assert.deepEqual(
      ledger.held(),
      [[A, later]],
      'the user-only notice stays for the program status'
    )
    ledger.invalidate(B)
    assert.equal(ledger.include(B, b), false, 'a command that printed while the boundary was built')
    assert.deepEqual(ledger.takeForBoundary(), [])
  }
)

await claim(
  'a run drops user-only notices and later silences of a consumed command reach only the user',
  () => {
    const ledger = makeQuietLedger()
    const a = ledger.quiet(A, 'tests', 1)
    ledger.takeForRun()
    assert.equal(ledger.include(A, a), true)
    const later = ledger.quiet(A, 'tests', 5)
    assert.equal(later.reach, 'user')
    assert.equal(ledger.forModel(A), undefined)
    assert.deepEqual(ledger.held(), [[A, later]])
    assert.deepEqual(ledger.takeForRun(), [])
    assert.deepEqual(ledger.held(), [])
  }
)

console.log(JSON.stringify({ result: 'passed', checks: passed }, null, 2))
