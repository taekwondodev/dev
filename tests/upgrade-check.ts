import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
const update = () => {
  const result = spawnSync(
    process.execPath,
    ['--import', join(sandbox, 'preload.mjs'), 'scripts/maintain.ts', 'update'],
    {
      cwd: checkout,
      encoding: 'utf8',
      env: { ...process.env, DEV_PI_RELEASE: undefined },
    }
  )
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

try {
  mkdirSync(checkout)
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
  writeFileSync(join(worktree, 'tracked.txt'), 'residual edits\n')
  writeFileSync(join(worktree, 'untracked.txt'), 'residue\n')
  mkdirSync(join(worktree, 'node_modules'))
  writeFileSync(join(worktree, 'node_modules', 'generated'), 'generated\n')
  const candidate = join(checkout, '.dev', 'upgrade', 'pi')
  mkdirSync(candidate)
  writeFileSync(join(candidate, 'keep'), 'Pi candidate\n')
  const unrelated = join(sandbox, 'unrelated')
  git(['worktree', 'add', '--quiet', '-b', 'chore/upgrade-2026-10-14', unrelated])
  const repository = authority.registerRepository(canonicalGitWorkspace(checkout))
  registerWorkspace(authority, repository, canonicalGitWorkspace(worktree))
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
  git(['worktree', 'lock', worktree])
  assert.throws(update, /locked/)
  assert.ok(existsSync(worktree))
  assert.ok(inspectWorkspaces(authority, { cwd: checkout }).some(view => view.path === worktree))
  git(['worktree', 'unlock', worktree])
  assert.match(update(), /Removed upgrade worktree and local branch chore\/upgrade-2026-10-15/)
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
  update()

  git(['worktree', 'add', '--quiet', '-b', branch, worktree])
  registerWorkspace(authority, repository, canonicalGitWorkspace(worktree))
  const resuming = await openLifecycle({ root })
  try {
    await assert.rejects(resuming.attach({ cwd: worktree, conversation }), /was removed/)
  } finally {
    await resuming.close()
  }
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
  update()
  assert.equal(existsSync(worktree), false)
  console.log(
    'upgrade cleanup: main/no-change update, squash, residue, exact scope, missing checkout, repeat and path reuse passed'
  )
} finally {
  authority.close()
  rmSync(sandbox, { recursive: true, force: true })
}
