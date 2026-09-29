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

const interruptedAfterQuit = process.env.LAUNCHER_TUI_FAULT === 'sigint-after-quit'
const interruptedDuringSweep = process.env.LAUNCHER_TUI_FAULT === 'sigint-during-sweep'
const failedAfterQuit = process.env.LAUNCHER_TUI_FAULT === 'shutdown-after-quit'
const failedInteractive = process.env.LAUNCHER_TUI_FAULT === 'interactive-failure'
const containedHistory = process.env.LAUNCHER_TUI_CONTAINED_HISTORY === '1'
const removeInstallation = process.env.LAUNCHER_TUI_SELF_REMOVE === '1' || containedHistory
const keptClaim = (): string => {
  if (interruptedAfterQuit)
    return 'a SIGINT during the teardown after /quit, before the sweep, exits 130 and releases nothing: both reservations, the worktree and the files stay'
  if (failedInteractive)
    return 'a failure of Pi interactive mode, with no /quit, disposes the runtime without parking it and exits 1 without sweeping: both reservations, the worktree and the files stay, and the conversation is kept'
  return 'a session disposal failure after /quit exits 1 without sweeping: both reservations, the worktree and the files stay, and the conversation is kept'
}
const sweptClaim = (): string => {
  if (removeInstallation)
    return 'quitting the TUI launched from a finished worktree releases its own installation claims first, then the sweep removes that worktree with the installation, releases the clean checkout and exits 0'
  if (interruptedDuringSweep)
    return 'a SIGINT to dev once the quit sweep has started lets the sweep run on: the finished worktree is removed, the clean checkout released, and dev exits 130 after the receipt'
  return 'quitting the TUI disposes the runtime, then the sweep removes the finished worktree, releases the clean checkout, prints the receipt and exits 0'
}
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
  const managed = await owner.authorize({ kind: 'delegated-write' })
  if (managed.kind !== 'ready') throw new Error('The fixture could not allocate a worktree')
  const worktree = managed.grant.checkout
  await lifecycle.recordTarget(taskId, { kind: 'local', ref: 'refs/heads/main' })
  if (removeInstallation) {
    const source = fileURLToPath(new URL('../', import.meta.url))
    for (const path of ['src', 'scripts', 'profiles', 'package.json'])
      cpSync(join(source, path), join(worktree, path), { recursive: true })
    symlinkSync(join(source, 'node_modules'), join(worktree, 'node_modules'))
    git(['switch', '--quiet', '-c', 'delivered-installation'], worktree)
    writeFileSync(join(worktree, 'delivered.txt'), 'delivered\n')
    git(['add', 'delivered.txt'], worktree)
    git(['commit', '--quiet', '-m', 'delivered'], worktree)
    git(['merge', '--quiet', '--ff-only', 'delivered-installation'], repo)
    if (containedHistory) {
      dataHome = join(worktree, '.dev')
      mkdirSync(dataHome, { mode: 0o700 })
    }
  }
  await owner.close()
  await lifecycle.close()

  let history: { path: string; text: string } | undefined
  if (failedAfterQuit || failedInteractive || containedHistory) {
    const { pi } = await loadInstalledPi()
    const sessions = pi.SessionManager.create(repo, join(dataHome, 'sessions'))
    sessions.appendMessage({ role: 'user', content: 'retain this conversation', timestamp: 1 })
    sessions.appendMessage({
      role: 'assistant',
      content: [
        { type: 'text', text: 'history that must survive the quit sweep or a failed shutdown' },
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

  const driverPath = removeInstallation
    ? join(worktree, 'scripts', 'workspace-launcher-tui-driver.ts')
    : fileURLToPath(new URL('./workspace-launcher-tui-driver.ts', import.meta.url))
  process.stdout.write(
    `\nDEV_LAUNCHER_TUI_INPUTS ${JSON.stringify({ TASK: taskId, REPO: repo, WORKTREE: worktree })}\n`
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
        ...(removeInstallation ? { LAUNCHER_TUI_INSTALLATION: worktree } : {}),
      },
    }
  )
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    resolveExit => {
      child.once('exit', (code, exitSignal) => resolveExit({ code, signal: exitSignal }))
    }
  )
  const after = await openLifecycle({ root })
  try {
    const reserved = (await after.check(taskId)).map(assessment => assessment.workspaceId)
    const outcomes = (await after.inspect({ taskId })).map(view => view.outcome).toSorted()
    const listed = git(['worktree', 'list', '--porcelain'], repo).match(/^worktree /gm)?.length
    if (interruptedAfterQuit || failedAfterQuit || failedInteractive)
      await claim(keptClaim(), () => {
        assert.equal(exit.signal, null)
        assert.equal(exit.code, interruptedAfterQuit ? 130 : 1)
        assert.deepEqual(
          reserved.toSorted(),
          [write.grant.workspaceId, managed.grant.workspaceId].toSorted()
        )
        assert.deepEqual(outcomes, ['preserved-for-resume', 'preserved-for-resume'])
        assert.ok(existsSync(worktree))
        assert.equal(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), 'launcher tui probe\n')
        if (history !== undefined)
          assert.ok(
            readFileSync(history.path, 'utf8').startsWith(history.text),
            'the persisted conversation history remains intact'
          )
      })
    else if (containedHistory)
      await claim(
        'a finished worktree holding the quitting conversation is kept by the sweep, which exits 1 naming it, while the clean checkout is released and the history stays intact',
        () => {
          assert.equal(exit.signal, null)
          assert.equal(exit.code, 1)
          assert.deepEqual(reserved, [managed.grant.workspaceId])
          assert.deepEqual(outcomes, ['preserved-for-resume', 'released'])
          assert.ok(existsSync(worktree))
          assert.equal(listed, 2)
          assert.ok(history !== undefined)
          assert.ok(readFileSync(history.path, 'utf8').startsWith(history.text))
        }
      )
    else
      await claim(sweptClaim(), () => {
        assert.equal(exit.signal, null)
        assert.equal(exit.code, interruptedDuringSweep ? 130 : 0)
        assert.deepEqual(reserved, [], 'nothing of the task remains reserved')
        assert.deepEqual(outcomes, ['released', 'removed'])
        assert.equal(existsSync(worktree), false)
        assert.equal(listed, 1)
        assert.ok(existsSync(join(repo, 'AGENTS.md')))
        assert.ok(existsSync(fileURLToPath(new URL('../node_modules/effect', import.meta.url))))
      })
  } finally {
    await after.close()
  }
  process.stdout.write(
    `\nDEV_LAUNCHER_TUI_PROBE_PASSED ${JSON.stringify({ checks: passed, fixture: sandbox, exitCode: exit.code })}\n`
  )
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}
