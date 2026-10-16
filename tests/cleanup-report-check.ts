import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { NodeFileSystem } from '@effect/platform-node'
import { readSessions } from '../scripts/usage-sessions.ts'

const root = mkdtempSync(join(tmpdir(), 'dev-cleanup-report-'))
const directory = join(root, 'sessions')
mkdirSync(directory)
const first = join(directory, 'a.jsonl')
const disappearing = join(directory, 'b.jsonl')
try {
  writeFileSync(first, '{malformed}\n')
  writeFileSync(disappearing, '{malformed}\n')
  const result = await Effect.runPromise(
    readSessions(root, 'sessions', 'lead', session => {
      if (session.name === 'a.jsonl') unlinkSync(disappearing)
      return { name: session.name, undecodable: session.undecodable }
    }).pipe(Effect.provide(NodeFileSystem.layer))
  )
  assert.deepEqual(result, [{ name: 'a.jsonl', undecodable: 1 }])
  mkdirSync(disappearing)
  await assert.rejects(
    Effect.runPromise(
      readSessions(root, 'sessions', 'lead', session => session.name).pipe(
        Effect.provide(NodeFileSystem.layer)
      )
    )
  )
  console.log(
    'cleanup reporting: disappearing files skipped, malformed coverage and other I/O errors preserved'
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}
