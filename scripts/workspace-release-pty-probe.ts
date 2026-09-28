// Drives the real terminal `dev workspace release <task>` in the pseudo-terminal the Python
// driver provides: the confirmation is answered by keys, first cancelling, then confirming a run
// that a child under the launcher entry point interrupts with SIGINT, then confirming a fresh run.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { launch } from '../src/launcher.ts'
import { makeWorkspaceLifecycle } from '../src/workspace-lifecycle.ts'
import { makeClaims } from './workspace-check-support.ts'
import { openLifecycle } from './workspace-test-lifecycle.ts'

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'dev-workspace-release-pty-')))
const signal = (marker: string) => process.stdout.write(`\nDEV_RELEASE_${marker}\n`)
const git = (args: readonly string[], cwd: string) =>
  execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()
const { claim, passed } = makeClaims()
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
  const sessionFile = join(dataHome, 'owner.jsonl')
  writeFileSync(sessionFile, '{}\n', { mode: 0o600 })
  const owner = await lifecycle.attach({
    conversation: { sessionId: 'release-pty-owner', sessionFile, dataHome },
    cwd: repo,
  })
  const write = await owner.authorize({ kind: 'write' })
  const managed = await owner.authorize({ kind: 'delegated-write' })
  await owner.close()
  if (write.kind !== 'ready' || managed.kind !== 'ready')
    throw new Error('The fixture could not allocate a managed worktree')
  const { taskId, checkout: worktree } = managed.grant
  if (taskId === undefined) throw new Error('The fixture worktree carries no task')
  await lifecycle.recordTarget(taskId, { kind: 'local', ref: 'refs/heads/main' })
  await lifecycle.close()

  const run = async (args: readonly string[]): Promise<number> => {
    process.exitCode = 0
    await Effect.runPromise(launch(args, { workspaceLifecycle: makeWorkspaceLifecycle({ root }) }))
    const code = typeof process.exitCode === 'number' ? process.exitCode : 0
    process.exitCode = 0
    return code
  }
  // A signal must meet the launcher's real signal wiring, which only its runMain entry point
  // installs, so that run is a child process sharing this pseudo-terminal.
  const runInterrupted = async (args: readonly string[]): Promise<number | null> => {
    const child = spawn(
      process.execPath,
      [new URL('./workspace-release-interrupt-driver.ts', import.meta.url).pathname, ...args],
      { stdio: 'inherit', env: { ...process.env, RELEASE_INTERRUPT_ROOT: root } }
    )
    return new Promise(resolveExit => {
      child.once('exit', code => resolveExit(code))
    })
  }
  process.stdout.write(`\nDEV_RELEASE_INPUTS ${JSON.stringify({ TASK: taskId })}\n`)

  await claim(
    'dev workspace check <task> in a terminal exits 0 with the assessment of both workspaces',
    async () => {
      assert.equal(await run(['--cwd', repo, 'workspace', 'check', taskId]), 0)
    }
  )
  signal('READY_FOR_CANCEL')
  await claim(
    'answering the terminal confirmation with anything but y exits 130 and changes nothing',
    async () => {
      assert.equal(await run(['--cwd', repo, 'workspace', 'release', taskId]), 130)
      assert.ok(existsSync(worktree), 'the managed worktree remains')
      const still = await openLifecycle({ root })
      try {
        assert.equal((await still.check(taskId)).length, 2, 'both reservations remain')
      } finally {
        await still.close()
      }
    },
    60_000
  )
  // The driver presses each key at the next confirmation prompt, in this order.
  for (const key of ['Ctrl-C', 'Ctrl-Z', 'Ctrl-D on an empty line'])
    await claim(
      `${key} at the terminal confirmation cancels at once without suspending: exit 130 and both reservations remain`,
      async () => {
        assert.equal(await run(['--cwd', repo, 'workspace', 'release', taskId]), 130)
        const still = await openLifecycle({ root })
        try {
          assert.equal((await still.check(taskId)).length, 2, 'both reservations remain')
        } finally {
          await still.close()
        }
      },
      60_000
    )
  signal('READY_FOR_INTERRUPT')
  await claim(
    'under the launcher entry point, a SIGINT during the first confirmed attempt lets that attempt finish with its recorded outcome, withdraws the second workspace unattempted with its reservation kept, and exits 130 after the receipt',
    async () => {
      assert.equal(await runInterrupted(['--cwd', repo, 'workspace', 'release', taskId]), 130)
      const after = await openLifecycle({ root })
      try {
        assert.equal((await after.check(taskId)).length, 1, 'one reservation remains')
        assert.deepEqual(
          (await after.inspect({ taskId }))
            .map(view => view.outcome)
            .filter(outcome => outcome !== 'preserved-for-resume'),
          [existsSync(worktree) ? 'released' : 'removed'],
          'exactly the first workspace has a receipt'
        )
      } finally {
        await after.close()
      }
    },
    60_000
  )
  signal('READY_FOR_CONFIRM')
  await claim(
    'answering y to a fresh release attempts the remaining workspace: in the end the pre-existing checkout keeps its files, the managed worktree is removed, and the command exits 0 with the receipt on the terminal',
    async () => {
      assert.equal(await run(['--cwd', repo, 'workspace', 'release', taskId]), 0)
      assert.ok(!existsSync(worktree), 'the managed worktree is gone')
      assert.ok(existsSync(join(repo, 'tracked.txt')), 'the pre-existing checkout keeps its files')
      assert.deepEqual(
        git(['worktree', 'list', '--porcelain'], repo)
          .split('\n')
          .filter(line => line.startsWith('worktree ')),
        [`worktree ${repo}`]
      )
      const after = await openLifecycle({ root })
      try {
        assert.deepEqual(await after.check(taskId), [], 'nothing of the task remains reserved')
        assert.deepEqual((await after.inspect({ taskId })).map(view => view.outcome).toSorted(), [
          'released',
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
