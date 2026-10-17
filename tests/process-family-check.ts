import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { NodeServices } from '@effect/platform-node'
import { Clock, Effect, Exit } from 'effect'
import { processObserver } from '../src/process-family.ts'
import { makeClaims } from './workspace/workspace-check-support.ts'

const fixture = mkdtempSync(join(tmpdir(), 'dev-process-family-'))
const counter = join(fixture, 'spawns')
const table = join(fixture, 'table')
const failing = join(fixture, 'failing')
const slow = join(fixture, 'slow')
const blocked = join(fixture, 'blocked')
const started = join(fixture, 'started')
writeFileSync(counter, '')
writeFileSync(
  table,
  [
    '  101     1   101 S    Fri Oct 17 12:00:00 2026',
    '  202   101   101 S    Fri Oct 17 12:00:01 2026',
    '',
  ].join('\n')
)
writeFileSync(
  join(fixture, 'ps'),
  `#!/bin/sh\nprintf x >> '${counter}'\n[ -e '${failing}' ] && exit 1\ncontent=$(cat '${table}')\n[ -e '${slow}' ] && { : > '${started}'; while [ -e '${blocked}' ]; do sleep 0.01; done; }\nprintf '%s\\n' "$content"\n`
)
chmodSync(join(fixture, 'ps'), 0o755)
const originalPath = process.env.PATH
process.env.PATH = `${fixture}:${originalPath ?? ''}`

const spawns = (): number => readFileSync(counter, 'utf8').length
const observers = await Effect.runPromise(
  Effect.all(Array.from({ length: 5 }, () => processObserver)).pipe(
    Effect.provide(NodeServices.layer)
  )
)
const [observer] = observers
const liveClock = await Effect.runPromise(Clock.Clock)
let now = 0
const snapshotClock: Clock.Clock = {
  currentTimeMillisUnsafe: () => now,
  currentTimeMillis: Effect.sync(() => now),
  currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
  currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => liveClock.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: liveClock.monotonicTimeNanos,
  sleep: duration => liveClock.sleep(duration),
}
const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provideService(Clock.Clock, snapshotClock)))
const { claim, passed } = makeClaims()

try {
  await claim(
    'five distinct observers sharing a spawner coalesce concurrent reads into one ps',
    async () => {
      const tables = await run(
        Effect.forEach(observers, item => item.processTable, { concurrency: 'unbounded' })
      )
      assert.equal(spawns(), 1)
      for (const read of tables) assert.deepEqual(read, tables[0])
      assert.deepEqual(
        tables[0].map(item => item.pid),
        [101, 202]
      )
    }
  )

  await claim('a shared snapshot is still reusable at 199 ms', async () => {
    now += 199
    await run(observer.processTable)
    assert.equal(spawns(), 1)
  })

  await claim('a shared snapshot expires at 200 ms', async () => {
    now += 1
    await run(observer.processTable)
    assert.equal(spawns(), 2)
  })

  await claim(
    'a fresh read always spawns, and the next shared read serves its table without spawning',
    async () => {
      writeFileSync(table, '  303     1   303 S    Fri Oct 17 12:00:02 2026\n')
      const fresh = await run(observer.freshProcessTable)
      assert.equal(spawns(), 3)
      assert.deepEqual(
        fresh.map(item => item.pid),
        [303]
      )
      const next = await run(observer.processTable)
      assert.equal(spawns(), 3)
      assert.deepEqual(
        next.map(item => item.pid),
        [303]
      )
    }
  )

  await claim(
    'a failed read is not reused: the next read spawns ps again and succeeds',
    async () => {
      now += 200
      writeFileSync(failing, '')
      const before = spawns()
      const failed = await run(Effect.exit(observer.processTable))
      assert.ok(Exit.isFailure(failed))
      assert.ok(spawns() > before)
      rmSync(failing)
      const after = spawns()
      const read = await run(observer.processTable)
      assert.equal(spawns(), after + 1)
      assert.deepEqual(
        read.map(item => item.pid),
        [303]
      )
    }
  )

  await claim(
    'a failed fresh read invalidates a snapshot that has not aged: the next shared read spawns again',
    async () => {
      await run(observer.processTable)
      writeFileSync(failing, '')
      const failed = await run(Effect.exit(observer.freshProcessTable))
      assert.ok(Exit.isFailure(failed))
      rmSync(failing)
      writeFileSync(table, '  404     1   404 S    Fri Oct 17 12:00:03 2026\n')
      const before = spawns()
      const next = await run(observer.processTable)
      assert.equal(spawns(), before + 1)
      assert.deepEqual(
        next.map(item => item.pid),
        [404]
      )
    }
  )

  await claim(
    'a shared read in flight when a fresh read happens cannot publish its older table afterwards',
    async () => {
      now += 200
      writeFileSync(slow, '')
      writeFileSync(blocked, '')
      const older = run(observer.processTable)
      while (!existsSync(started)) await sleep(5)
      writeFileSync(table, '  505     1   505 S    Fri Oct 17 12:00:04 2026\n')
      rmSync(slow)
      const fresh = await run(observer.freshProcessTable)
      assert.deepEqual(
        fresh.map(item => item.pid),
        [505]
      )
      rmSync(blocked)
      assert.deepEqual(
        (await older).map(item => item.pid),
        [404]
      )
      const before = spawns()
      const next = await run(observer.processTable)
      assert.equal(spawns(), before)
      assert.deepEqual(
        next.map(item => item.pid),
        [505]
      )
    }
  )

  console.log(JSON.stringify({ result: 'passed', checks: passed }, null, 2))
} finally {
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  rmSync(fixture, { recursive: true, force: true })
}
