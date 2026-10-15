import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  linkSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFileSystem } from '@effect/platform-node'
import { Effect } from 'effect'
import { cleanPreferenceTemporaries, saveSelection } from '../src/preferences.ts'
import { acquireExclusiveLock } from '../src/runtime-coordination.ts'

const root = mkdtempSync(join(tmpdir(), 'dev-preference-cleanup-'))
const directory = join(root, 'preferences')
const run = () =>
  Effect.runPromise(cleanPreferenceTemporaries(root).pipe(Effect.provide(NodeFileSystem.layer)))
try {
  assert.equal(await run(), 0)
  mkdirSync(directory)
  const final = join(directory, `${'a'.repeat(32)}.json`)
  const temporary = `${final}.123.tmp`
  writeFileSync(final, '{"profile":"fixture"}')
  writeFileSync(temporary, '{"profile":"fixture"}')
  const malformed = join(directory, `${'b'.repeat(32)}.json.123.tmp`)
  writeFileSync(malformed, '{')
  const outside = join(root, 'outside')
  writeFileSync(outside, '{"profile":"outside"}')
  const symbolic = join(directory, `${'c'.repeat(32)}.json.123.tmp`)
  const hard = join(directory, `${'d'.repeat(32)}.json.123.tmp`)
  symlinkSync(outside, symbolic)
  linkSync(outside, hard)
  writeFileSync(join(directory, 'unknown.tmp'), '{}')
  const release = acquireExclusiveLock(join(directory, '.publication.sqlite'), 'busy')
  try {
    await assert.rejects(run())
    await assert.rejects(
      Effect.runPromise(
        saveSelection({ cwd: root, dataHome: root, profile: 'published' }).pipe(
          Effect.provide(NodeFileSystem.layer)
        )
      )
    )
    assert.ok(existsSync(temporary))
  } finally {
    release()
  }
  assert.equal(await run(), 1)
  assert.equal(existsSync(temporary), false)
  for (const path of [final, malformed, outside, symbolic, hard, join(directory, 'unknown.tmp')])
    assert.ok(existsSync(path))
  const published = await Effect.runPromise(
    saveSelection({ cwd: root, dataHome: root, profile: 'published' }).pipe(
      Effect.provide(NodeFileSystem.layer)
    )
  )
  assert.deepEqual(JSON.parse(readFileSync(published, 'utf8')), {
    profile: 'published',
    project: root,
  })
  assert.equal(await run(), 0)
  assert.ok(existsSync(published))
  console.log(
    'preference cleanup: real publisher exclusion, abandoned files, links and retry passed'
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}
