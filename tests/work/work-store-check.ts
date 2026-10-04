import assert from 'node:assert/strict'
import { NodeFileSystem } from '@effect/platform-node'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Clock, Effect, Layer } from 'effect'
import { asAttemptId, asGenerationId, asSessionId, asTaskId } from '../../src/work-domain.ts'
import { WorkStore } from '../../src/work-store.ts'
import { makeClaims } from '../workspace/workspace-check-support.ts'

const root = mkdtempSync(join(tmpdir(), 'dev-work-store-'))
const { claim, passed } = makeClaims()
try {
  await claim(
    'current attempt records round-trip; unknown fields are refused on write and read without rewriting stored payloads',
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const sessionId = asSessionId('schema-check')
          const store = yield* WorkStore
          const record = yield* store.create(asAttemptId('00000000-0000-0000-0000-000000000001'), {
            kind: 'process',
            cwd: root,
            controllerPid: process.pid,
            owner: {
              sessionId,
              taskId: asTaskId('schema-check'),
              generation: asGenerationId('schema-check'),
            },
          })
          assert.deepEqual(yield* store.read(record.id), record)
          for (const extra of [
            { unexpected: true },
            { owner: { ...record.owner, unexpected: true } },
            { artifactAtStart: { unavailable: true as const, unexpected: true } },
          ]) {
            const candidate = { ...record, revision: record.revision + 1, ...extra }
            const result = yield* Effect.result(store.save(candidate))
            assert.equal(result._tag, 'Failure')
            assert.deepEqual(yield* store.read(record.id), record)
          }
          const db = yield* Effect.acquireRelease(
            Effect.sync(() => new DatabaseSync(join(root, 'work', 'attempts.sqlite'))),
            connection => Effect.sync(() => connection.close())
          )
          const payload = JSON.stringify({
            ...record,
            owner: { ...record.owner, unexpected: true },
          })
          yield* Effect.sync(() => {
            db.prepare('UPDATE attempts SET payload=? WHERE id=?').run(payload, record.id)
          })
          assert.equal((yield* Effect.result(store.read(record.id)))._tag, 'Failure')
          const listed = yield* store.list
          assert.deepEqual(listed.records, [])
          assert.deepEqual(
            listed.unavailable.map(item => item.id),
            [record.id]
          )
          assert.ok(listed.unavailable[0]?.error)
          assert.equal(
            db.prepare('SELECT payload FROM attempts WHERE id=?').get(record.id)?.payload,
            payload
          )
        }).pipe(
          Effect.scoped,
          Effect.provide(
            WorkStore.layer(root, asSessionId('schema-check')).pipe(
              Layer.provide(NodeFileSystem.layer)
            )
          )
        )
      )
  )
  await claim(
    'completed attempts expire seven days after completion and beyond the newest 64; active and unresolved attempts remain and expired logs are removed',
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const home = join(root, 'retention')
          const sessionId = asSessionId('retention-check')
          const store = yield* WorkStore
          const now = yield* Clock.currentTimeMillis
          const minute = 60 * 1000
          const day = 24 * 60 * minute
          const start = (serial: number) =>
            store.create(
              asAttemptId(`00000000-0000-0000-0000-${String(serial).padStart(12, '0')}`),
              {
                kind: 'process',
                cwd: home,
                controllerPid: process.pid,
                owner: {
                  sessionId,
                  taskId: asTaskId(`retention-${serial}`),
                  generation: asGenerationId('retention-check'),
                },
              }
            )
          const completeAt = Effect.fnUntraced(function* (serial: number, completedAt: number) {
            const record = yield* start(serial)
            yield* store.save({ ...record, revision: 1, status: 'completed', completedAt })
            return record.id
          })
          const logDirectory = (id: string) => join(home, 'work', 'attempts', id)
          const listedIds = Effect.map(store.list, listed =>
            listed.records.map(record => record.id).toSorted()
          )

          const active = (yield* start(1)).id
          const unresolved = yield* start(2)
          yield* store.save({
            ...unresolved,
            revision: 1,
            status: 'unknown',
            completedAt: undefined,
          })
          const expired = yield* completeAt(3, now - 8 * day)
          const sixDaysOld = yield* completeAt(4, now - 6 * day)
          assert.deepEqual(yield* listedIds, [active, unresolved.id, sixDaysOld])
          assert.equal((yield* Effect.result(store.read(expired)))._tag, 'Failure')
          assert.equal(existsSync(logDirectory(expired)), false)
          assert.equal(existsSync(logDirectory(sixDaysOld)), true)

          const newest: string[] = []
          for (let index = 0; index < 64; index += 1)
            newest.push(yield* completeAt(100 + index, now - (index + 1) * minute))
          assert.deepEqual(yield* listedIds, [active, unresolved.id, ...newest].toSorted())
          assert.equal((yield* Effect.result(store.read(sixDaysOld)))._tag, 'Failure')
          assert.equal(existsSync(logDirectory(sixDaysOld)), false)
          assert.equal(existsSync(logDirectory(active)), true)
        }).pipe(
          Effect.scoped,
          Effect.provide(
            WorkStore.layer(join(root, 'retention'), asSessionId('retention-check')).pipe(
              Layer.provide(NodeFileSystem.layer)
            )
          )
        )
      )
  )
  await claim('a corrupt database is refused and left as found, not rebuilt', () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const home = join(root, 'corrupt')
        const databasePath = join(home, 'work', 'attempts.sqlite')
        const garbage = Buffer.from('not a database '.repeat(512))
        mkdirSync(dirname(databasePath), { recursive: true })
        writeFileSync(databasePath, garbage)
        const refusal = yield* Effect.flip(
          Layer.build(WorkStore.layer(home, asSessionId('corrupt-check')))
        )
        assert.equal(refusal.message, 'Work store database is corrupt')
        assert.deepEqual(readFileSync(databasePath), garbage)
      }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
    )
  )
  console.log(JSON.stringify({ result: 'passed', checks: passed }, null, 2))
} finally {
  rmSync(root, { recursive: true, force: true })
}
