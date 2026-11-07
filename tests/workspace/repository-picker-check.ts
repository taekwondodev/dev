import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeServices } from '@effect/platform-node'
import { Effect } from 'effect'
import { displayPath, findRepositories } from '../../src/repository-picker.ts'
import { makeClaims } from './workspace-check-support.ts'

const { claim, passed } = makeClaims()
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'dev-repository-picker-')))
const find = (directory: string, sessions: string) =>
  Effect.runPromise(findRepositories(directory, sessions).pipe(Effect.provide(NodeServices.layer)))

const repository = (path: string, head: string) => {
  mkdirSync(join(path, '.git'), { recursive: true })
  writeFileSync(join(path, '.git', 'HEAD'), `${head}\n`)
}
const session = (sessions: string, name: string, header: string, ageMs: number) => {
  const path = join(sessions, `${name}.jsonl`)
  writeFileSync(path, `${header}\n{"type":"message"}\n`)
  const at = (Date.now() - ageMs) / 1000
  utimesSync(path, at, at)
}
const header = (cwd: string) => JSON.stringify({ type: 'session', version: 3, id: 'x', cwd })
const near = (value: number | undefined, ageMs: number) =>
  value !== undefined && Math.abs(Date.now() - ageMs - value) < 5_000

try {
  const area = join(sandbox, 'area')
  const sessions = join(sandbox, 'sessions')
  mkdirSync(sessions, { recursive: true })
  repository(join(area, 'zeta'), 'ref: refs/heads/main')
  repository(join(area, 'alpha'), 'ref: refs/heads/feature/picker')
  repository(join(area, 'beta'), 'ref: refs/heads/main')
  repository(join(area, 'gamma'), 'ref: refs/heads/main')
  repository(join(area, 'detached'), '0123456789abcdef0123456789abcdef01234567')
  repository(join(area, '.hidden'), 'ref: refs/heads/main')
  mkdirSync(join(area, 'linked'))
  writeFileSync(join(area, 'linked', '.git'), 'gitdir: /elsewhere/.git/worktrees/linked\n')
  mkdirSync(join(area, 'plain'))
  repository(join(area, 'title\u001b]0;owned\u0007'), 'ref: refs/heads/main')
  repository(join(area, 'osc'), 'ref: refs/heads/main\u001b]52;c;cHduZWQ=\u0007')
  writeFileSync(join(area, 'notes.txt'), 'not a directory\n')
  session(sessions, 'beta-old', header(join(area, 'beta')), 4 * 86_400_000)
  session(sessions, 'beta-new', header(join(area, 'beta')), 2 * 86_400_000)
  session(sessions, 'gamma-app', header(join(area, 'gamma', 'app')), 3_600_000)
  session(sessions, 'gammaish', header(join(area, 'gammaish')), 60_000)
  session(sessions, 'not-session', JSON.stringify({ type: 'custom', cwd: join(area, 'zeta') }), 0)
  session(sessions, 'broken', '{ not json', 0)
  writeFileSync(join(sessions, 'zeta.txt'), header(join(area, 'zeta')))

  await claim(
    'repositories are the visible directories holding .git, newest dev conversation first, then by name',
    async () => {
      const found = await find(area, sessions)
      assert.deepEqual(
        found.map(entry => entry.name),
        ['gamma', 'beta', 'alpha', 'detached', 'linked', 'osc', 'zeta']
      )
      assert.deepEqual(
        found.map(entry => entry.path),
        found.map(entry => join(area, entry.name))
      )
    }
  )

  await claim(
    'a repository is last used by its newest conversation started in it or below it, and never by a sibling sharing its prefix',
    async () => {
      const used = new Map((await find(area, sessions)).map(entry => [entry.name, entry.lastUsed]))
      assert.ok(near(used.get('beta'), 2 * 86_400_000), String(used.get('beta')))
      assert.ok(near(used.get('gamma'), 3_600_000), String(used.get('gamma')))
      assert.equal(used.get('zeta'), undefined, 'neither a non-session header nor a .txt counts')
      assert.equal(used.get('alpha'), undefined)
    }
  )

  await claim(
    'the branch comes from HEAD, and is absent when .git is not a directory',
    async () => {
      const branches = new Map(
        (await find(area, sessions)).map(entry => [entry.name, entry.branch])
      )
      assert.equal(branches.get('alpha'), 'feature/picker')
      assert.equal(branches.get('detached'), 'detached')
      assert.equal(branches.get('linked'), undefined)
    }
  )

  await claim(
    'names and branches carrying control characters never reach the terminal: such a directory is skipped and such a branch is not shown',
    async () => {
      const found = await find(area, sessions)
      assert.ok(found.every(entry => !entry.name.includes('\u001b')))
      assert.equal(found.find(entry => entry.name === 'osc')?.branch, undefined)
    }
  )

  await claim('missing directories yield no repositories instead of failing', async () => {
    assert.deepEqual(
      (await find(area, join(sandbox, 'no-sessions'))).map(entry => entry.lastUsed),
      [undefined, undefined, undefined, undefined, undefined, undefined, undefined]
    )
    assert.deepEqual(await find(join(sandbox, 'missing'), sessions), [])
    assert.deepEqual(await find(join(area, 'plain'), sessions), [])
  })

  await claim(
    'paths are shown with a tilde under home and with control characters replaced',
    () => {
      assert.equal(displayPath(join(homedir(), 'Developer')), '~/Developer')
      assert.equal(displayPath(homedir()), '~')
      assert.equal(displayPath(`${homedir()}-other`), `${homedir()}-other`)
      assert.equal(displayPath('/opt/area'), '/opt/area')
      assert.equal(displayPath('/opt/a\u001b]0;x\u0007b'), '/opt/a?]0;x?b')
    }
  )
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify({ result: 'passed', checks: passed }, null, 2)}\n`)
