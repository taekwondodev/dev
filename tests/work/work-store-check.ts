import assert from 'node:assert/strict'
import { NodeFileSystem } from '@effect/platform-node'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Effect } from 'effect'
import { asAttemptId, asGenerationId, asSessionId, asTaskId } from '../../src/work-domain.ts'
import { makeWorkStore } from '../../src/work-store.ts'
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
          const store = yield* makeWorkStore(root, sessionId)
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
        }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
      )
  )
  console.log(JSON.stringify({ result: 'passed', checks: passed }, null, 2))
} finally {
  rmSync(root, { recursive: true, force: true })
}
