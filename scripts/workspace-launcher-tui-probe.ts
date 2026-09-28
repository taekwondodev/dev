// The real launcher, opening the real Pi TUI on the pseudo-terminal the Python driver provides,
// released from inside that TUI: `/workspace release <task>` is typed and its confirmation
// answered. The launcher runs as a child that inherits the pseudo-terminal, so this probe can
// verify the authority afterwards.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeClaims } from './workspace-check-support.ts'
import { openLifecycle } from './workspace-test-lifecycle.ts'

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'dev-workspace-launcher-tui-')))
const signal = (marker: string) => process.stdout.write(`\nDEV_LAUNCHER_TUI_${marker}\n`)
const git = (args: readonly string[], cwd: string) =>
  execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()
const { claim, passed } = makeClaims()
// Set by the driver table for the variant whose handover teardown receives a SIGINT.
const interruptedAfterHandover = process.env.LAUNCHER_TUI_FAULT === 'sigint-after-handover'
try {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true)
    throw new Error(
      'This probe needs a pseudo-terminal; run it through run-workspace-pty-probes.py'
    )
  const repo = join(sandbox, 'repo')
  const root = join(sandbox, 'authority')
  const dataHome = join(sandbox, 'data')
  const home = join(sandbox, 'home')
  mkdirSync(repo)
  mkdirSync(dataHome)
  mkdirSync(join(home, '.agents', 'skills'), { recursive: true })
  git(['init', '--quiet', '-b', 'main'], repo)
  git(['config', 'user.name', 'Launcher TUI Probe'], repo)
  git(['config', 'user.email', 'launcher-tui@example.invalid'], repo)
  writeFileSync(join(repo, 'AGENTS.md'), 'launcher tui probe\n')
  git(['add', 'AGENTS.md'], repo)
  git(['commit', '--quiet', '-m', 'fixture'], repo)

  // The task reserves the pre-existing checkout the TUI will open, so the TUI's own workspace is
  // in the release scope and the guided path applies.
  const lifecycle = await openLifecycle({ root })
  const ownerHome = join(sandbox, 'owner')
  mkdirSync(ownerHome)
  const ownerFile = join(ownerHome, 'owner.jsonl')
  writeFileSync(ownerFile, '{}\n', { mode: 0o600 })
  const owner = await lifecycle.attach({
    conversation: { sessionId: 'launcher-tui-owner', sessionFile: ownerFile, dataHome: ownerHome },
    cwd: repo,
  })
  const write = await owner.authorize({ kind: 'write' })
  await owner.close()
  if (write.kind !== 'ready') throw new Error('The fixture could not reserve the checkout')
  const { taskId } = write.grant
  if (taskId === undefined) throw new Error('The fixture reservation carries no task')
  await lifecycle.close()

  const driverPath = new URL('./workspace-launcher-tui-driver.ts', import.meta.url).pathname
  process.stdout.write(
    `\nDEV_LAUNCHER_TUI_INPUTS ${JSON.stringify({ TASK: taskId, REPO: repo })}\n`
  )
  signal('STARTING_LAUNCHER')
  const child = spawn(
    process.execPath,
    [driverPath, '--cwd', repo, '--data-home', dataHome, '--profile', 'general'],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        HOME: home,
        PI_OFFLINE: '1',
        PI_TELEMETRY_DISABLED: '1',
        LAUNCHER_TUI_ROOT: root,
      },
    }
  )
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    resolveExit => {
      child.once('exit', (code, exitSignal) => resolveExit({ code, signal: exitSignal }))
    }
  )
  if (interruptedAfterHandover) {
    await claim(
      'a SIGINT during the teardown after the guided handover, before the attempt, exits 130 and releases nothing: the reservation and the files stay',
      async () => {
        assert.equal(exit.signal, null)
        assert.equal(exit.code, 130)
        const after = await openLifecycle({ root })
        try {
          assert.equal((await after.check(taskId)).length, 1, 'the reservation is kept')
        } finally {
          await after.close()
        }
        assert.ok(existsSync(join(repo, 'AGENTS.md')))
      }
    )
  } else {
    await claim(
      'the launcher-driven TUI, released from inside itself, stops the TUI, disposes the runtime and exits 0 through its own guided path',
      () => {
        assert.equal(exit.signal, null)
        assert.equal(exit.code, 0)
      }
    )
    await claim(
      'after the guided release the reservation is gone, the checkout keeps its files, and the receipt is inspectable by task',
      async () => {
        const after = await openLifecycle({ root })
        try {
          assert.deepEqual(await after.check(taskId), [], 'nothing of the task remains reserved')
          assert.deepEqual(
            (await after.inspect({ taskId })).map(view => view.outcome),
            ['released']
          )
          const views = await after.inspect({ cwd: repo })
          assert.equal(views.length, 1)
          assert.equal(views[0]?.taskId, undefined, 'the checkout holds no reservation any more')
        } finally {
          await after.close()
        }
        assert.ok(existsSync(join(repo, 'AGENTS.md')))
        assert.equal(git(['status', '--porcelain'], repo), '')
      }
    )
  }
  process.stdout.write(
    `\nDEV_LAUNCHER_TUI_PROBE_PASSED ${JSON.stringify({ checks: passed, fixture: sandbox, exitCode: exit.code })}\n`
  )
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}
