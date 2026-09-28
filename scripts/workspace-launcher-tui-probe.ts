import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadInstalledPi, makeClaims } from './workspace-check-support.ts'
import { openLifecycle } from './workspace-test-lifecycle.ts'

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'dev-workspace-launcher-tui-')))
const signal = (marker: string) => process.stdout.write(`\nDEV_LAUNCHER_TUI_${marker}\n`)
const git = (args: readonly string[], cwd: string) =>
  execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()
const { claim, passed } = makeClaims()

const interruptedAfterHandover = process.env.LAUNCHER_TUI_FAULT === 'sigint-after-handover'
const failedAfterHandover = process.env.LAUNCHER_TUI_FAULT === 'shutdown-after-handover'
const containedHistory = process.env.LAUNCHER_TUI_CONTAINED_HISTORY === '1'
const removeInstallation = process.env.LAUNCHER_TUI_SELF_REMOVE === '1' || containedHistory
try {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true)
    throw new Error(
      'This probe needs a pseudo-terminal; run it through run-workspace-pty-probes.py'
    )
  const repo = join(sandbox, 'repo')
  const root = join(sandbox, 'authority')
  let dataHome = join(sandbox, 'data')
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
  if (write.kind !== 'ready') throw new Error('The fixture could not reserve the checkout')
  const { taskId } = write.grant
  if (taskId === undefined) throw new Error('The fixture reservation carries no task')
  let installation: string | undefined
  if (removeInstallation) {
    const managed = await owner.authorize({ kind: 'delegated-write' })
    if (managed.kind !== 'ready') throw new Error('The fixture could not allocate its installation')
    installation = managed.grant.checkout
    const source = fileURLToPath(new URL('../', import.meta.url))
    for (const path of ['src', 'scripts', 'profiles', 'package.json'])
      cpSync(join(source, path), join(installation, path), { recursive: true })
    symlinkSync(join(source, 'node_modules'), join(installation, 'node_modules'))
    await lifecycle.recordTarget(taskId, { kind: 'local', ref: 'refs/heads/main' })
    if (containedHistory) {
      dataHome = join(installation, '.dev')
      mkdirSync(dataHome, { mode: 0o700 })
    }
  }
  await owner.close()
  await lifecycle.close()

  let history: { path: string; text: string } | undefined
  if (failedAfterHandover || containedHistory) {
    const { pi } = await loadInstalledPi()
    const sessions = pi.SessionManager.create(repo, join(dataHome, 'sessions'))
    sessions.appendMessage({ role: 'user', content: 'retain this conversation', timestamp: 1 })
    sessions.appendMessage({
      role: 'assistant',
      content: [
        { type: 'text', text: 'history that must survive a refused release or failed shutdown' },
      ],
      api: 'openai-completions',
      provider: 'fixture',
      model: 'fixture',
      stopReason: 'stop',
      timestamp: 2,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    })
    const path = sessions.getSessionFile()
    assert.ok(path !== undefined)
    history = { path, text: readFileSync(path, 'utf8') }
  }

  const driverPath =
    installation === undefined
      ? fileURLToPath(new URL('./workspace-launcher-tui-driver.ts', import.meta.url))
      : join(installation, 'scripts', 'workspace-launcher-tui-driver.ts')
  process.stdout.write(
    `\nDEV_LAUNCHER_TUI_INPUTS ${JSON.stringify({ TASK: taskId, REPO: repo })}\n`
  )
  signal('STARTING_LAUNCHER')
  const child = spawn(
    process.execPath,
    [
      driverPath,
      '--cwd',
      repo,
      ...(containedHistory ? [] : ['--data-home', dataHome]),
      '--profile',
      'general',
      ...(history === undefined ? [] : ['--resume', history.path]),
    ],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        HOME: home,
        ...(containedHistory ? { DEV_DATA_HOME: undefined } : {}),
        PI_OFFLINE: '1',
        PI_TELEMETRY_DISABLED: '1',
        LAUNCHER_TUI_ROOT: root,
        ...(installation === undefined ? {} : { LAUNCHER_TUI_INSTALLATION: installation }),
      },
    }
  )
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    resolveExit => {
      child.once('exit', (code, exitSignal) => resolveExit({ code, signal: exitSignal }))
    }
  )
  if (containedHistory) {
    await claim(
      'a release containing the active conversation in the default installation-local data home is refused before confirmation; the TUI remains usable until quit, with intact history, reservations and no release intent',
      async () => {
        const after = await openLifecycle({ root })
        try {
          assert.equal((await after.check(taskId)).length, 2, 'both reservations remain')
          const views = await after.inspect({ taskId })
          assert.ok(views.every(view => view.outcome === 'preserved-for-resume'))
          assert.ok(
            views.every(view => view.pending.length === 0),
            'no release intent exists'
          )
        } finally {
          await after.close()
        }
        assert.equal(exit.signal, null)
        assert.equal(exit.code, 0)
        assert.ok(history !== undefined)
        assert.ok(readFileSync(history.path, 'utf8').startsWith(history.text))
        assert.ok(installation !== undefined && existsSync(installation))
        assert.equal(
          git(['worktree', 'list', '--porcelain'], repo).match(/^worktree /gm)?.length,
          2
        )
        assert.equal(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), 'launcher tui probe\n')
      }
    )
  } else if (interruptedAfterHandover || failedAfterHandover) {
    await claim(
      interruptedAfterHandover
        ? 'a SIGINT during the teardown after the guided handover, before the attempt, exits 130 and releases nothing: the reservation and the files stay'
        : 'a session disposal failure after the guided handover exits 1 without releasing the reservation or changing files, and keeps the conversation',
      async () => {
        assert.equal(exit.signal, null)
        assert.equal(exit.code, interruptedAfterHandover ? 130 : 1)
        const after = await openLifecycle({ root })
        try {
          const retained = await after.check(taskId)
          assert.equal(retained.length, 1, 'the reservation is kept')
          assert.equal(retained[0]?.workspaceId, write.grant.workspaceId)
          const views = await after.inspect({ taskId })
          assert.equal(views.length, 1)
          assert.equal(views[0]?.outcome, 'preserved-for-resume')
          assert.deepEqual(views[0]?.pending, [], 'no release intent was recorded')
        } finally {
          await after.close()
        }
        assert.equal(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), 'launcher tui probe\n')
        assert.equal(git(['status', '--porcelain'], repo), '')
        if (history !== undefined)
          assert.ok(
            readFileSync(history.path, 'utf8').startsWith(history.text),
            'the persisted conversation history remains intact'
          )
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
      'after the guided release all task reservations are gone, the pre-existing checkout keeps its files, and any disposable source installation was removed with an inspectable receipt',
      async () => {
        const after = await openLifecycle({ root })
        try {
          assert.deepEqual(await after.check(taskId), [], 'nothing of the task remains reserved')
          assert.deepEqual(
            (await after.inspect({ taskId })).map(view => view.outcome).toSorted(),
            installation === undefined ? ['released'] : ['released', 'removed']
          )
          const views = await after.inspect({ cwd: repo })
          assert.equal(views.length, 1)
          assert.equal(views[0]?.taskId, undefined, 'the checkout holds no reservation any more')
        } finally {
          await after.close()
        }
        assert.ok(existsSync(join(repo, 'AGENTS.md')))
        if (installation !== undefined) {
          assert.equal(existsSync(installation), false)
          assert.deepEqual(git(['worktree', 'list', '--porcelain'], repo).match(/^worktree /gm), [
            'worktree ',
          ])
          assert.ok(existsSync(fileURLToPath(new URL('../node_modules/effect', import.meta.url))))
        }
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
