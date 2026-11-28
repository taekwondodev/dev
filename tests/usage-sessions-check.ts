import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import { readSessions } from '../scripts/usage-sessions.ts'

const root = mkdtempSync(join(tmpdir(), 'dev-usage-sessions-'))
const directory = join(root, 'sessions')
mkdirSync(directory)
const first = join(directory, 'a.jsonl')
const disappearing = join(directory, 'b.jsonl')
try {
  writeFileSync(first, '{malformed}\n')
  writeFileSync(disappearing, '{malformed}\n')
  let unlinked = false
  const racingFs = Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, fs => ({
      ...fs,
      readDirectory: (path, options) =>
        Effect.tap(fs.readDirectory(path, options), () =>
          Effect.sync(() => {
            if (!unlinked && path === directory) {
              unlinked = true
              unlinkSync(disappearing)
            }
          })
        ),
    }))
  ).pipe(Layer.provide(NodeFileSystem.layer))
  const result = await Effect.runPromise(
    readSessions(root, 'sessions', 'lead', session => ({
      name: session.name,
      undecodable: session.undecodable,
    })).pipe(Effect.provide(racingFs))
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
    'usage session reading: files removed by cleanup are skipped, malformed coverage and other I/O errors preserved'
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}
