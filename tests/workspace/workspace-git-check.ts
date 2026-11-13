import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { canonicalGitWorkspace, resolveIdentityGit } from '../../src/workspace-git.ts'
import { makeClaims } from './workspace-check-support.ts'

const { claim, passed } = makeClaims()
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'dev-workspace-git-')))
const originalPath = process.env.PATH ?? ''
const systemGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim()

const repository = (name: string, commit: boolean): string => {
  const path = join(sandbox, name)
  mkdirSync(path)
  const git = (...args: string[]) => execFileSync(systemGit, args, { cwd: path, stdio: 'ignore' })
  git('init', '--quiet')
  if (commit)
    git(
      '-c',
      'user.name=check',
      '-c',
      'user.email=check@example.invalid',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'initial'
    )
  return path
}

const recordingGit = (path: string, log: string, record = `printf '%s\\n' "$*"`): void => {
  writeFileSync(
    path,
    `#!/bin/sh\n${record} >> ${JSON.stringify(log)}\nexec ${JSON.stringify(systemGit)} "$@"\n`
  )
  chmodSync(path, 0o755)
}
const runs = (log: string): number =>
  existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0

try {
  const committed = repository('committed', true)
  const unborn = repository('unborn', false)
  const launcherDirectory = join(sandbox, 'launcher')
  const directDirectory = join(sandbox, 'direct')
  const launcherLog = join(sandbox, 'launcher.log')
  const directLog = join(sandbox, 'direct.log')
  const finder = join(sandbox, 'finder')
  for (const directory of [launcherDirectory, directDirectory]) mkdirSync(directory)
  recordingGit(join(launcherDirectory, 'git'), launcherLog)
  recordingGit(join(directDirectory, 'git'), directLog)
  writeFileSync(
    finder,
    `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(join(directDirectory, 'git'))}\n`
  )
  chmodSync(finder, 0o755)
  const launcher = { git: join(launcherDirectory, 'git'), finder }
  const described = [canonicalGitWorkspace(committed), canonicalGitWorkspace(unborn)]
  const describe = () => [canonicalGitWorkspace(committed), canonicalGitWorkspace(unborn)]
  const settle = async (): Promise<void> => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await sleep(50)
      canonicalGitWorkspace(committed)
    }
  }

  await claim(
    'a git that PATH selects before the launcher keeps every identity read, whether its directory is absolute, relative to the checkout or the empty entry',
    async () => {
      const cases = [
        { name: 'absolute', entry: join(sandbox, 'selected'), wrapper: join(sandbox, 'selected') },
        { name: 'relative', entry: 'bin', wrapper: join(committed, 'bin') },
        { name: 'empty', entry: '', wrapper: committed },
      ]
      for (const { name, entry, wrapper } of cases) {
        const log = join(sandbox, `${name}.log`)
        mkdirSync(wrapper, { recursive: true })
        recordingGit(join(wrapper, 'git'), log)
        process.env.PATH = `${entry}:${launcherDirectory}:${originalPath}`
        try {
          resolveIdentityGit(launcher)
          await settle()
          assert.ok(runs(log) >= 10, `the ${name} entry ran every read: ${runs(log)}`)
          assert.equal(runs(directLog), 0, `the ${name} entry was not bypassed`)
        } finally {
          process.env.PATH = originalPath
          rmSync(join(wrapper, 'git'))
        }
      }
    }
  )

  await claim(
    'with the launcher first on PATH, identity reads move to the binary it resolves to, describe checkouts with and without commits identically, and return to the launcher once that binary disappears',
    async () => {
      process.env.PATH = `${launcherDirectory}:${originalPath}`
      try {
        resolveIdentityGit(launcher)
        for (let attempt = 0; attempt < 100 && runs(directLog) === 0; attempt += 1) {
          await sleep(20)
          canonicalGitWorkspace(committed)
        }
        assert.ok(runs(directLog) > 0, 'the resolved binary ran an identity read')
        const [launcherBefore, directBefore] = [runs(launcherLog), runs(directLog)]
        assert.deepEqual(describe(), described)
        assert.equal(runs(launcherLog), launcherBefore, 'the launcher ran no further identity read')
        assert.equal(runs(directLog), directBefore + 3, 'one read per commit, two for no commit')
        rmSync(join(directDirectory, 'git'))
        assert.deepEqual(describe(), described)
        assert.deepEqual(describe(), described)
        assert.equal(runs(launcherLog), launcherBefore + 6, 'the launcher took the reads back')
      } finally {
        process.env.PATH = originalPath
      }
    }
  )

  await claim(
    'the authority worker shares the compile cache dev enabled without exposing it to the commands it runs, and passes on a cache the user chose',
    async () => {
      const seen = join(sandbox, 'seen')
      mkdirSync(seen)
      const driver = `
        import { enableCompileCache } from 'node:module'
        import { randomUUID } from 'node:crypto'
        import { mkdirSync, writeFileSync } from 'node:fs'
        import { join } from 'node:path'
        enableCompileCache()
        const { openLifecycle } = await import('./tests/workspace/workspace-test-lifecycle.ts')
        const [root, repo] = process.argv.slice(1)
        const dataHome = join(root, 'data')
        mkdirSync(join(dataHome, 'sessions'), { recursive: true })
        const sessionFile = join(dataHome, 'sessions', 'session.jsonl')
        writeFileSync(sessionFile, '')
        const lifecycle = await openLifecycle({ root: join(root, 'authority') })
        const attachment = await lifecycle.attach({
          conversation: { sessionId: randomUUID(), sessionFile, dataHome },
          cwd: repo,
        })
        await attachment.close()
        await lifecycle.close()`
      const observe = (name: string, env: NodeJS.ProcessEnv): string[] => {
        const directory = join(seen, name)
        const log = join(directory, 'environment.log')
        mkdirSync(join(directory, 'bin'), { recursive: true })
        recordingGit(
          join(directory, 'bin', 'git'),
          log,
          `{ echo ran; env | grep -E '^(NODE_COMPILE_CACHE|DEV_COMPILE_CACHE_INHERITED)=' || true; }`
        )
        const result = spawnSync(
          process.execPath,
          ['--input-type=module', '--eval', driver, '--', join(directory, 'root'), committed],
          {
            cwd: fileURLToPath(new URL('../..', import.meta.url)),
            encoding: 'utf8',
            env: {
              ...process.env,
              ...env,
              TMPDIR: `${join(directory, 'tmp')}/`,
              PATH: `${join(directory, 'bin')}:${originalPath}`,
            },
            timeout: 60_000,
          }
        )
        assert.equal(result.status, 0, result.stderr)
        const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean)
        assert.ok(lines.includes('ran'), 'the worker ran Git')
        return [...new Set(lines.filter(line => line !== 'ran'))]
      }
      mkdirSync(join(seen, 'enabled', 'tmp'), { recursive: true })
      mkdirSync(join(seen, 'chosen', 'tmp'), { recursive: true })
      assert.deepEqual(observe('enabled', { NODE_COMPILE_CACHE: undefined }), [])
      const chosen = join(seen, 'chosen', 'cache')
      assert.deepEqual(observe('chosen', { NODE_COMPILE_CACHE: chosen }), [
        `NODE_COMPILE_CACHE=${chosen}`,
      ])
    }
  )

  console.log(JSON.stringify({ result: 'passed', checks: passed }, null, 2))
} finally {
  process.env.PATH = originalPath
  rmSync(sandbox, { recursive: true, force: true })
}
