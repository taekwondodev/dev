import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { launch } from '../../src/launcher-runtime.ts'
import type { WorkspaceAuthorization, WorkspaceGrant } from '../../src/workspace-domain.ts'
import { makeWorkspaceLifecycle } from '../../src/workspace-lifecycle.ts'
import { newId } from '../../src/workspace-platform.ts'
import { makeClaims } from './workspace-check-support.ts'
import { openLifecycle } from './workspace-test-lifecycle.ts'

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'dev-workspace-release-pty-')))
const signal = (marker: string) => process.stdout.write(`\nDEV_RELEASE_${marker}\n`)
const git = (args: readonly string[], cwd: string) =>
  execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()
const { claim, passed } = makeClaims()
const ready = (result: WorkspaceAuthorization): WorkspaceGrant => {
  if (result.kind !== 'ready') throw new Error('The fixture could not reserve or allocate')
  return result.grant
}
try {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true)
    throw new Error(
      'This probe needs a pseudo-terminal; run it through run-workspace-pty-probes.py'
    )
  const repo = join(sandbox, 'repo')
  const root = join(sandbox, 'authority')
  const dataHome = join(sandbox, 'data')
  mkdirSync(repo)
  mkdirSync(dataHome)
  git(['init', '--quiet', '-b', 'main'], repo)
  git(['config', 'user.name', 'Release PTY Probe'], repo)
  git(['config', 'user.email', 'release-pty@example.invalid'], repo)
  writeFileSync(join(repo, 'tracked.txt'), 'tracked\n')
  git(['add', 'tracked.txt'], repo)
  git(['commit', '--quiet', '-m', 'fixture'], repo)

  const lifecycle = await openLifecycle({ root })
  const conversationAt = (name: string) => {
    const sessionFile = join(dataHome, `${name}.jsonl`)
    writeFileSync(sessionFile, '{}\n', { mode: 0o600 })
    return { sessionId: `release-pty-${name}`, sessionFile, dataHome }
  }
  const unfinishedCheckout = join(sandbox, 'unfinished')
  git(['worktree', 'add', '--quiet', '-b', 'unfinished', unfinishedCheckout, 'main'], repo)
  const unfinishedOwner = await lifecycle.attach({
    conversation: conversationAt('unfinished'),
    cwd: unfinishedCheckout,
  })
  const unfinishedTask = ready(await unfinishedOwner.authorize({ kind: 'write' })).taskId
  const unfinished = ready(await unfinishedOwner.authorize({ kind: 'delegated-write' }))
  await unfinishedOwner.close()
  if (unfinishedTask === undefined) throw new Error('The unfinished fixture carries no task')
  await lifecycle.recordTarget(unfinishedTask, { kind: 'local', ref: 'refs/heads/main' })
  writeFileSync(join(unfinished.checkout, 'tracked.txt'), 'undelivered edit\n')

  const owner = await lifecycle.attach({ conversation: conversationAt('owner'), cwd: repo })
  const { taskId } = ready(await owner.authorize({ kind: 'write' }))
  const worktrees = [
    ready(await owner.authorize({ kind: 'delegated-write' })).checkout,
    ready(await owner.authorize({ kind: 'delegated-write' })).checkout,
  ]
  await owner.close()
  if (taskId === undefined) throw new Error('The fixture worktree carries no task')
  for (const worktree of worktrees) rmSync(worktree, { recursive: true, force: true })
  await lifecycle.close()

  const run = async (args: readonly string[]): Promise<number> => {
    process.exitCode = 0
    await Effect.runPromise(launch(args, { workspaceLifecycle: makeWorkspaceLifecycle({ root }) }))
    const code = typeof process.exitCode === 'number' ? process.exitCode : 0
    process.exitCode = 0
    return code
  }

  process.stdout.write(`\nDEV_RELEASE_INPUTS ${JSON.stringify({ TASK: taskId })}\n`)
  const reservations = async (task: string): Promise<number> => {
    const still = await openLifecycle({ root })
    try {
      return (await still.check(task as typeof taskId)).length
    } finally {
      await still.close()
    }
  }

  await claim(
    'dev workspace release of a task without reservations exits 1 before any confirmation',
    async () => {
      assert.equal(await run(['--cwd', repo, 'workspace', 'release', newId()]), 1)
      assert.equal(await reservations(unfinishedTask), 2)
      assert.equal(await reservations(taskId), 3)
    },
    60_000
  )
  signal('READY_FOR_CANCEL')
  await claim(
    'answering the terminal confirmation with anything but y exits 130 and changes nothing',
    async () => {
      assert.equal(await run(['--cwd', repo, 'workspace', 'release', taskId]), 130)
      assert.equal(await reservations(taskId), 3, 'every reservation remains')
    },
    60_000
  )

  for (const key of ['Ctrl-C', 'Ctrl-Z', 'Ctrl-D on an empty line'])
    await claim(
      `${key} at the terminal confirmation cancels at once without suspending: exit 130 and every reservation remains`,
      async () => {
        assert.equal(await run(['--cwd', repo, 'workspace', 'release', taskId]), 130)
        assert.equal(await reservations(taskId), 3, 'every reservation remains')
      },
      60_000
    )
  signal('READY_FOR_UNFINISHED')
  await claim(
    'answering y removes an unfinished managed worktree with its undelivered edit and ends the reservation of its pre-existing checkout, which keeps its files; the command exits 0',
    async () => {
      assert.equal(await run(['--cwd', repo, 'workspace', 'release', unfinishedTask]), 0)
      assert.ok(!existsSync(unfinished.checkout), 'the unfinished worktree is gone')
      assert.ok(existsSync(join(unfinishedCheckout, 'tracked.txt')), 'the checkout keeps its files')
      assert.equal(await reservations(unfinishedTask), 0)
    },
    60_000
  )
  signal('READY_FOR_CONFIRM')
  await claim(
    'answering y releases the pre-existing checkout, which keeps its files, resolves the absent managed worktrees, and exits 0 with the receipt on the terminal',
    async () => {
      assert.equal(await run(['--cwd', repo, 'workspace', 'release', taskId]), 0)
      assert.ok(existsSync(join(repo, 'tracked.txt')), 'the pre-existing checkout keeps its files')
      assert.deepEqual(
        git(['worktree', 'list', '--porcelain'], repo)
          .split('\n')
          .filter(line => line.startsWith('worktree ')),
        [`worktree ${repo}`, `worktree ${unfinishedCheckout}`]
      )
      const after = await openLifecycle({ root })
      try {
        assert.deepEqual(await after.check(taskId), [], 'nothing of the task remains reserved')
        assert.deepEqual((await after.inspect({ taskId })).map(view => view.outcome).toSorted(), [
          'released',
          'removed',
          'removed',
        ])
      } finally {
        await after.close()
      }
    },
    60_000
  )
  process.stdout.write(
    `\nDEV_RELEASE_PTY_PROBE_PASSED ${JSON.stringify({ checks: passed, fixture: sandbox })}\n`
  )
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}
