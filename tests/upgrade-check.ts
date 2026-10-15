import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Schema } from 'effect'
import { WorkspaceAuthority, registerWorkspace } from '../src/workspace-authority.ts'
import { canonicalGitWorkspace } from '../src/workspace-git.ts'
import { inspectWorkspaces } from '../src/workspace-inspect.ts'
import { openLifecycle } from './workspace/workspace-test-lifecycle.ts'

const source = fileURLToPath(new URL('../', import.meta.url))
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'dev-upgrade-check-')))
const checkout = join(sandbox, 'dev')
const home = join(sandbox, 'home')
const root = join(home, 'Library', 'Application Support', 'dev', 'workspace-authority')
const authority = new WorkspaceAuthority(root)
const worktree = join(checkout, '.dev', 'upgrade', 'worktree')
const branch = 'chore/upgrade-2026-10-15'
const git = (args: readonly string[], cwd = checkout): string => {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}
const update = (command = 'update', args: readonly string[] = []) => {
  const result = spawnSync('npm', ['run', command, '--', ...args], {
    cwd: checkout,
    encoding: 'utf8',
    env: {
      ...process.env,
      DEV_PI_RELEASE: undefined,
      NODE_OPTIONS: `--import=${join(sandbox, 'preload.mjs')}`,
      PATH: `${join(sandbox, 'pi', 'bin')}:${process.env.PATH}`,
    },
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

try {
  const manifest = Schema.decodeSync(
    Schema.fromJsonString(Schema.Struct({ scripts: Schema.Record(Schema.String, Schema.String) }))
  )(readFileSync(join(source, 'package.json'), 'utf8'))
  const installation = join(sandbox, 'pi', 'install')
  const piPackage = join(
    installation,
    'releases',
    '1.0.0',
    'node_modules',
    '@earendil-works',
    'pi-coding-agent'
  )
  mkdirSync(piPackage, { recursive: true })
  mkdirSync(join(sandbox, 'pi', 'bin'))
  writeFileSync(join(sandbox, 'pi', 'bin', 'pi'), '#!/bin/sh\nexit 97\n', { mode: 0o755 })
  writeFileSync(
    join(installation, 'managed-install.json'),
    JSON.stringify({ kind: 'pi-managed-install', schemaVersion: 1, layout: 'releases-v1' })
  )
  writeFileSync(join(installation, 'current-version'), '1.0.0\n')
  writeFileSync(
    join(piPackage, 'package.json'),
    JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.0.0', main: 'index.js' })
  )
  mkdirSync(checkout)
  writeFileSync(
    join(checkout, 'package.json'),
    JSON.stringify({ type: 'module', scripts: manifest.scripts, config: { pi: '1.0.0' } })
  )
  git(['init', '--quiet', '-b', 'main'])
  git(['config', 'user.name', 'Upgrade Check'])
  git(['config', 'user.email', 'upgrade@example.invalid'])
  writeFileSync(join(checkout, '.gitignore'), '/.dev/\n/node_modules\n/src/\n/scripts/\n')
  writeFileSync(join(checkout, 'tracked.txt'), 'initial\n')
  git(['add', '.'])
  git(['commit', '--quiet', '-m', 'installation'])
  const initial = git(['rev-parse', 'HEAD'])
  git(['clone', '--quiet', '--bare', checkout, join(sandbox, 'origin.git')])
  git(['remote', 'add', 'origin', join(sandbox, 'origin.git')])
  cpSync(join(source, 'src'), join(checkout, 'src'), { recursive: true })
  cpSync(join(source, 'scripts'), join(checkout, 'scripts'), { recursive: true })
  symlinkSync(join(source, 'node_modules'), join(checkout, 'node_modules'))
  writeFileSync(
    join(sandbox, 'preload.mjs'),
    `
import { registerHooks } from 'node:module'
registerHooks({
  load(url, context, next) {
    const loaded = next(url, context)
    if (!url.endsWith('/workspace-authority-root.ts')) return loaded
    const source = String(loaded.source)
    if (!source.includes('userInfo().homedir')) throw new Error('Cannot isolate the fixture authority')
    return { ...loaded, source: source.replace('userInfo().homedir', ${JSON.stringify(JSON.stringify(home))}) }
  }
})
`
  )
  git(['worktree', 'add', '--quiet', '-b', branch, worktree])
  writeFileSync(join(worktree, 'tracked.txt'), 'upgrade\n')
  git(['commit', '--quiet', '-am', 'upgrade'], worktree)
  git(['merge', '--squash', branch])
  git(['commit', '--quiet', '-m', 'squashed upgrade'])
  git(['push', '--quiet', 'origin', 'main'])
  git(['reset', '--quiet', '--hard', initial])
  mkdirSync(join(worktree, 'node_modules'))
  writeFileSync(join(worktree, 'node_modules', 'generated'), 'generated\n')
  const candidate = join(checkout, '.dev', 'upgrade', 'pi')
  mkdirSync(candidate)
  writeFileSync(join(candidate, 'keep'), 'Pi candidate\n')
  const unrelated = join(sandbox, 'unrelated')
  git(['worktree', 'add', '--quiet', '-b', 'chore/upgrade-2026-10-14', unrelated])
  const repository = authority.registerRepository(canonicalGitWorkspace(checkout))
  const dataHome = join(sandbox, 'session')
  mkdirSync(dataHome)
  const sessionFile = join(dataHome, 'session.jsonl')
  writeFileSync(sessionFile, '{}\n')
  const conversation = { sessionId: 'upgrade-reader', sessionFile, dataHome }
  const reader = await openLifecycle({ root })
  try {
    const attachment = await reader.attach({ cwd: worktree, conversation })
    await attachment.authorize({ kind: 'read' })
    await attachment.close()
  } finally {
    await reader.close()
  }

  git(['switch', '--quiet', '-c', 'other'])
  git(['push', '--quiet', 'origin', 'other'])
  update()
  assert.ok(existsSync(worktree))
  git(['switch', '--quiet', 'main'])
  update()
  assert.notEqual(git(['rev-parse', 'HEAD']), initial)
  assert.equal(existsSync(worktree), false, 'successful main update removes the upgrade worktree')
  assert.equal(git(['branch', '--list', branch]), '')
  assert.equal(
    inspectWorkspaces(authority, { cwd: checkout }).some(view => view.path === worktree),
    false
  )
  assert.ok(existsSync(join(candidate, 'keep')))
  assert.ok(existsSync(unrelated))
  assert.notEqual(git(['branch', '--list', 'chore/upgrade-2026-10-14']), '')
  assert.match(
    update('upgrade', ['--remote', 'origin', '--branch', 'main']),
    /Pi 1\.0\.0 is already active\./
  )
  assert.throws(() => update('pi:update', ['x']), /pi:update takes no arguments, got: x/)

  git(['worktree', 'add', '--quiet', '-b', branch, worktree])
  registerWorkspace(authority, repository, canonicalGitWorkspace(worktree))
  const resuming = await openLifecycle({ root })
  try {
    await assert.rejects(resuming.attach({ cwd: worktree, conversation }), /was removed/)
  } finally {
    await resuming.close()
  }
  git(['worktree', 'lock', worktree])
  assert.throws(update, /locked/)
  assert.ok(existsSync(worktree))
  assert.ok(inspectWorkspaces(authority, { cwd: checkout }).some(view => view.path === worktree))
  git(['worktree', 'unlock', worktree])
  git(['worktree', 'remove', worktree])
  update()
  assert.equal(
    inspectWorkspaces(authority, { cwd: checkout }).some(view => view.path === worktree),
    false
  )
  assert.notEqual(
    git(['branch', '--list', branch]),
    '',
    'an absent worktree does not authorize guessing a branch'
  )
  git(['worktree', 'add', '--quiet', worktree, branch])
  registerWorkspace(authority, repository, canonicalGitWorkspace(worktree))
  writeFileSync(
    join(checkout, 'package.json'),
    JSON.stringify({ type: 'module', scripts: manifest.scripts, config: { pi: '2.0.0' } })
  )
  assert.throws(update, /checkout has local changes/)
  git(['commit', '--quiet', '-am', 'new Pi pin'])
  git(['push', '--quiet', 'origin', 'main'])
  const updated = git(['rev-parse', 'HEAD'])
  git(['reset', '--quiet', '--hard', `${updated}^`])
  assert.throws(update, /no verified candidate for Pi 2\.0\.0.*npm run pi:update/)
  assert.equal(git(['rev-parse', 'HEAD']), updated, 'activation reads the pin after updating dev')
  assert.equal(readFileSync(join(installation, 'current-version'), 'utf8'), '1.0.0\n')
  console.log(
    'upgrade cleanup and maintenance: update alias, Pi preparation rename, current Pi no-op, post-update activation refusal, main cleanup, squash, scope, lock, repeat and path reuse passed'
  )
} finally {
  authority.close()
  rmSync(sandbox, { recursive: true, force: true })
}
