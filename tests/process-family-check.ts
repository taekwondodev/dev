import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { NodeServices } from '@effect/platform-node'
import { Duration, Effect, Exit } from 'effect'
import { processObserver, SNAPSHOT_FRESHNESS } from '../src/process-family.ts'
import { makeClaims } from './workspace/workspace-check-support.ts'

const fixture = mkdtempSync(join(tmpdir(), 'dev-process-family-'))
const counter = join(fixture, 'spawns')
const table = join(fixture, 'table')
const failing = join(fixture, 'failing')
const slow = join(fixture, 'slow')
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
  `#!/bin/sh\nprintf x >> '${counter}'\n[ -e '${failing}' ] && exit 1\ncontent=$(cat '${table}')\n[ -e '${slow}' ] && { : > '${started}'; sleep 0.15; }\nprintf '%s\\n' "$content"\n`
)
chmodSync(join(fixture, 'ps'), 0o755)
process.env.PATH = `${fixture}:${process.env.PATH ?? ''}`

const spawns = (): number => readFileSync(counter, 'utf8').length
const observer = await Effect.runPromise(processObserver.pipe(Effect.provide(NodeServices.layer)))
const windowMs = Duration.toMillis(SNAPSHOT_FRESHNESS)
const { claim, passed } = makeClaims()

try {
  await claim('five concurrent shared reads spawn one ps and see the same table', async () => {
    const tables = await Effect.runPromise(
      Effect.all(
        Array.from({ length: 5 }, () => observer.processTable),
        { concurrency: 'unbounded' }
      )
    )
    assert.equal(spawns(), 1)
    for (const read of tables) assert.deepEqual(read, tables[0])
    assert.deepEqual(
      tables[0].map(item => item.pid),
      [101, 202]
    )
  })

  await claim('a shared read within the freshness window spawns nothing', async () => {
    await Effect.runPromise(observer.processTable)
    assert.equal(spawns(), 1)
  })

  await claim('a shared read after the window spawns again', async () => {
    await sleep(windowMs + 100)
    await Effect.runPromise(observer.processTable)
    assert.equal(spawns(), 2)
  })

  await claim(
    'a fresh read always spawns, and the next shared read serves its table without spawning',
    async () => {
      const fresh = await Effect.runPromise(observer.freshProcessTable)
      assert.equal(spawns(), 3)
      const next = await Effect.runPromise(observer.processTable)
      assert.equal(spawns(), 3)
      assert.deepEqual(next, fresh)
    }
  )

  await claim(
    'a failed read is not reused: the next read spawns ps again and succeeds',
    async () => {
      await sleep(windowMs + 100)
      writeFileSync(failing, '')
      const before = spawns()
      const failed = await Effect.runPromiseExit(observer.processTable)
      assert.ok(Exit.isFailure(failed))
      assert.ok(spawns() > before)
      rmSync(failing)
      const after = spawns()
      const read = await Effect.runPromise(observer.processTable)
      assert.equal(spawns(), after + 1)
      assert.equal(read.length, 2)
    }
  )

  await claim(
    'a failed fresh read expires the snapshot: the next shared read spawns again',
    async () => {
      await Effect.runPromise(observer.processTable)
      writeFileSync(failing, '')
      const failed = await Effect.runPromiseExit(observer.freshProcessTable)
      assert.ok(Exit.isFailure(failed))
      rmSync(failing)
      const before = spawns()
      await Effect.runPromise(observer.processTable)
      assert.equal(spawns(), before + 1)
    }
  )

  await claim(
    'a shared read in flight when a fresh read happens cannot publish its older table afterwards',
    async () => {
      await sleep(windowMs + 100)
      writeFileSync(slow, '')
      const older = Effect.runPromise(observer.processTable)
      while (!existsSync(started)) await sleep(5)
      rmSync(slow)
      writeFileSync(table, '  101     1   101 S    Fri Oct 17 12:00:00 2026\n')
      const fresh = await Effect.runPromise(observer.freshProcessTable)
      assert.equal(fresh.length, 1)
      assert.equal((await older).length, 2)
      const before = spawns()
      const next = await Effect.runPromise(observer.processTable)
      assert.equal(spawns(), before)
      assert.deepEqual(next, fresh)
      assert.notDeepEqual(next, await older)
    }
  )

  console.log(JSON.stringify({ result: 'passed', checks: passed }, null, 2))
} finally {
  rmSync(fixture, { recursive: true, force: true })
}
