import { installProfileFixture } from '../profile-fixture.ts'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout } from 'node:timers/promises'
import { NodeServices } from '@effect/platform-node'
import { Clock, Effect, Layer } from 'effect'
import { WorkStore } from '../../src/work-store.ts'
import { AttemptId, GenerationId, SessionId, TaskId } from '../../src/work-domain.ts'
import { loadInstalledPi, makeClaims } from './workspace-check-support.ts'
import { openLifecycle } from './workspace-test-lifecycle.ts'
import { WorkspaceId } from '../../src/workspace-domain.ts'

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'dev-workspace-launcher-tui-')))
const signal = (marker: string) => process.stdout.write(`\nDEV_LAUNCHER_TUI_${marker}\n`)
const git = (args: readonly string[], cwd: string) =>
  execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()
const { claim, passed } = makeClaims()
const stoppedCleaners = new Set<number>()
const cleanupMarkers = join(sandbox, 'cleanup-markers')
mkdirSync(cleanupMarkers)
let launcher: ReturnType<typeof spawn> | undefined
const waitFor = async (ready: () => boolean, message: string) => {
  const deadline = Date.now() + 20000
  while (!ready() && Date.now() < deadline) await setTimeout(25)
  assert.ok(ready(), message)
}

const interruptedAfterQuit = process.env.LAUNCHER_TUI_FAULT === 'sigint-after-quit'
const interruptedDuringSweep = process.env.LAUNCHER_TUI_FAULT === 'sigint-during-sweep'
const failedAfterQuit = process.env.LAUNCHER_TUI_FAULT === 'shutdown-after-quit'
const failedInteractive = process.env.LAUNCHER_TUI_FAULT === 'interactive-failure'
const containedHistory = process.env.LAUNCHER_TUI_CONTAINED_HISTORY === '1'
const removeInstallation = process.env.LAUNCHER_TUI_SELF_REMOVE === '1' || containedHistory
const missingWorktree = process.env.LAUNCHER_TUI_MISSING_WORKTREE
const undeliveredWorktree = process.env.LAUNCHER_TUI_UNDELIVERED_WORKTREE === '1'
const abandonedUse = process.env.LAUNCHER_TUI_ABANDONED_USE === '1'
const keptClaim = (): string => {
  if (interruptedAfterQuit)
    return 'a SIGINT during the teardown after /quit, before the sweep, exits 130 and releases nothing: both reservations, the worktree and the files stay'
  if (failedInteractive)
    return 'a failure of Pi interactive mode, with no /quit, disposes the runtime without parking it and exits 1 without sweeping: both reservations, the worktree and the files stay, and the conversation is kept'
  return 'a session disposal failure after /quit exits 1 without sweeping: both reservations, the worktree and the files stay, and the conversation is kept'
}
const sweptClaim = (): string => {
  if (undeliveredWorktree)
    return 'quit offers a worktree with unintegrated commits and dirty edits; one y removes it, while the clean checkout is released automatically'
  if (abandonedUse)
    return 'a worktree left by a killed session is asked about on its own at quit; y removes it, while the finished worktree and the clean checkout are swept and dev exits 0'
  if (missingWorktree === 'release')
    return 'a worktree whose directory vanished is offered for release at quit; one y releases its task, the clean checkout is released by the sweep and dev exits 0'
  if (removeInstallation)
    return 'quitting the TUI launched from a finished worktree releases its own installation claims first, then the sweep removes that worktree with the installation, releases the clean checkout and exits 0'
  if (interruptedDuringSweep)
    return 'a SIGINT to dev once the quit sweep has started lets the sweep run on: the finished worktree is removed, the clean checkout released, and dev exits 130 after the receipt'
  return 'quitting the TUI disposes the runtime, then the sweep removes the finished worktree, releases the clean checkout, prints the receipt and exits 0'
}
const crashWithDelegatedWrite = (
  root: string,
  repo: string,
  home: string
): { readonly taskId: WorkspaceId; readonly checkout: string } => {
  const sessionFile = join(home, 'crashed.jsonl')
  writeFileSync(sessionFile, '{}\n', { mode: 0o600 })
  const lifecycleUrl = new URL('./workspace-test-lifecycle.ts', import.meta.url).href
  const conversation = { sessionId: 'launcher-tui-crashed', sessionFile, dataHome: home }
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
        import { openLifecycle } from ${JSON.stringify(lifecycleUrl)}
        const lifecycle = await openLifecycle({ root: ${JSON.stringify(root)} })
        const attachment = await lifecycle.attach({ conversation: ${JSON.stringify(conversation)}, cwd: ${JSON.stringify(repo)} })
        const write = await attachment.authorize({ kind: 'delegated-write' })
        if (write.kind !== 'ready') throw new Error(JSON.stringify(write))
        process.stdout.write(JSON.stringify({ taskId: write.grant.taskId, checkout: write.grant.checkout }))
        process.kill(process.pid, 'SIGKILL')
      `,
    ],
    { encoding: 'utf8' }
  )
  assert.equal(child.signal, 'SIGKILL', child.stderr)
  const { taskId, checkout } = JSON.parse(child.stdout) as { taskId: string; checkout: string }
  return { taskId: WorkspaceId.make(taskId), checkout }
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
  const profiles = installProfileFixture(join(sandbox, 'profiles'))
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
    const source = fileURLToPath(new URL('../../', import.meta.url))
    for (const path of ['src', 'tests', 'package.json'])
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
  if (undeliveredWorktree) {
    writeFileSync(join(worktree, 'undelivered.txt'), 'not integrated\n')
    git(['add', 'undelivered.txt'], worktree)
    git(['commit', '--quiet', '-m', 'undelivered'], worktree)
    writeFileSync(join(worktree, 'dirty.txt'), 'uncommitted\n')
  }
  await owner.close()
  if (undeliveredWorktree) {
    const assessment = (await lifecycle.check(taskId)).find(
      view => view.workspaceId === managed.grant.workspaceId
    )
    assert.equal(assessment?.completion.kind, 'retained')
    if (assessment?.completion.kind === 'retained')
      assert.equal(assessment.completion.retained, 'not-integrated')
  }
  await lifecycle.close()
  if (missingWorktree !== undefined) rmSync(worktree, { recursive: true, force: true })
  const crashed = abandonedUse ? crashWithDelegatedWrite(root, repo, ownerHome) : undefined

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

  const startupExpired = join(dataHome, 'sessions', 'cleanup-000.jsonl')
  const exitExpired = join(dataHome, 'sessions', 'cleanup-exit.jsonl')
  let expiredLog: string | undefined
  if (process.env.LAUNCHER_TUI_CLEANUP === '1') {
    mkdirSync(join(dataHome, 'sessions'), { recursive: true })
    for (let index = 0; index < 101; index++) {
      const id = `cleanup-${String(index).padStart(3, '0')}`
      const path = join(dataHome, 'sessions', `${id}.jsonl`)
      writeFileSync(
        path,
        `${JSON.stringify({ type: 'session', id, timestamp: '2026-01-01T00:00:00Z', cwd: repo })}\n`
      )
      utimesSync(path, 1000 + index, 1000 + index)
    }
    expiredLog = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkStore
        const clock = yield* Clock.Clock
        const past = (yield* Clock.currentTimeMillis) - 8 * 24 * 60 * 60 * 1000
        return yield* Effect.gen(function* () {
          const record = yield* store.create(
            AttemptId.make('00000000-0000-0000-0000-000000000001'),
            {
              kind: 'process',
              cwd: repo,
              controllerPid: process.pid,
              owner: {
                sessionId: SessionId.make('cleanup-maintenance'),
                taskId: TaskId.make('cleanup-maintenance'),
                generation: GenerationId.make('cleanup-maintenance'),
              },
            }
          )
          yield* store.save({ ...record, revision: 1, status: 'completed', completedAt: past })
          return store.logPath(record.id, 'stdout')
        }).pipe(
          Effect.provideService(Clock.Clock, {
            currentTimeMillis: Effect.succeed(past),
            currentTimeMillisUnsafe: () => past,
            currentTimeNanos: clock.currentTimeNanos,
            currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
            monotonicTimeNanos: clock.monotonicTimeNanos,
            monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
            sleep: duration => clock.sleep(duration),
          })
        )
      }).pipe(
        Effect.scoped,
        Effect.provide(
          WorkStore.layer(dataHome, SessionId.make('cleanup-maintenance')).pipe(
            Layer.provide(NodeServices.layer)
          )
        )
      )
    )
    writeFileSync(expiredLog, 'expired output\n')
  }

  const driverPath = removeInstallation
    ? join(worktree, 'tests', 'workspace', 'workspace-launcher-tui-driver.ts')
    : fileURLToPath(new URL('./workspace-launcher-tui-driver.ts', import.meta.url))
  process.stdout.write(
    `\nDEV_LAUNCHER_TUI_INPUTS ${JSON.stringify({ TASK: taskId, REPO: repo, WORKTREE: worktree, CRASHED_TASK: crashed?.taskId ?? '' })}\n`
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
      profiles.defaultProfile,
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
        LAUNCHER_TUI_CLEANUP_MARKERS: cleanupMarkers,
        ...(removeInstallation ? { LAUNCHER_TUI_INSTALLATION: worktree } : {}),
      },
    }
  )
  launcher = child
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    resolveExit => {
      child.once('exit', (code, exitSignal) => resolveExit({ code, signal: exitSignal }))
    }
  )
  let exitCleaner: number | undefined
  if (expiredLog !== undefined) {
    await waitFor(
      () => existsSync(join(cleanupMarkers, 'startup.json')),
      'launcher did not request startup cleanup'
    )
    const pid = JSON.parse(readFileSync(join(cleanupMarkers, 'startup.json'), 'utf8')) as number
    stoppedCleaners.add(pid)
    await waitFor(
      () => existsSync(join(cleanupMarkers, 'interactive-ready')),
      'launcher startup waited for the stopped cleanup process'
    )
    process.kill(pid, 0)
    assert.ok(existsSync(startupExpired))
    assert.ok(existsSync(expiredLog))
    process.kill(pid, 'SIGCONT')
    stoppedCleaners.delete(pid)
    await waitFor(
      () => !existsSync(startupExpired) && !existsSync(expiredLog),
      'startup cleanup did not delete expired history and owner-authorized attempt logs'
    )
    writeFileSync(
      exitExpired,
      `${JSON.stringify({ type: 'session', id: 'cleanup-exit', timestamp: '2026-01-01T00:00:00Z', cwd: repo })}\n`
    )
    utimesSync(exitExpired, 1, 1)
    signal('CLEANUP_READY_FOR_QUIT')
    await waitFor(
      () => existsSync(join(cleanupMarkers, 'graceful-exit.json')),
      'launcher did not request graceful-exit cleanup'
    )
    exitCleaner = JSON.parse(
      readFileSync(join(cleanupMarkers, 'graceful-exit.json'), 'utf8')
    ) as number
    stoppedCleaners.add(exitCleaner)
    await waitFor(
      () => child.exitCode !== null || child.signalCode !== null,
      'launcher exit waited for the stopped cleanup process'
    )
  }
  const exit = await exited
  if (exitCleaner !== undefined) {
    process.kill(exitCleaner, 0)
    assert.ok(existsSync(exitExpired), 'cleanup was still unfinished when the launcher exited')
    process.kill(exitCleaner, 'SIGCONT')
    stoppedCleaners.delete(exitCleaner)
    await waitFor(
      () => !existsSync(exitExpired),
      'graceful-exit cleanup did not survive the launcher'
    )
    await claim(
      'real launcher startup and graceful exit do not wait for cleanup, which maintains attempt logs and survives exit',
      () => {
        assert.equal(exit.signal, null)
        assert.equal(exit.code, 0)
      }
    )
  }
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
    else if (missingWorktree === 'decline' || missingWorktree === 'interrupt')
      await claim(
        missingWorktree === 'decline'
          ? 'declining the release offered at quit for a vanished worktree keeps its reservation, exits with the sweep code 0 and leaves the release command printed'
          : 'Ctrl-C at the release offered at quit releases nothing and exits 130',
        () => {
          assert.equal(exit.signal, null)
          assert.equal(exit.code, missingWorktree === 'decline' ? 0 : 130)
          assert.deepEqual(reserved, [managed.grant.workspaceId])
          assert.deepEqual(outcomes, ['released', 'review-required'])
        }
      )
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
      await claim(sweptClaim(), async () => {
        assert.equal(exit.signal, null)
        assert.equal(exit.code, interruptedDuringSweep ? 130 : 0)
        assert.deepEqual(reserved, [], 'nothing of the task remains reserved')
        assert.deepEqual(outcomes, ['released', 'removed'])
        assert.equal(existsSync(worktree), false)
        if (crashed !== undefined) {
          assert.deepEqual(await after.check(crashed.taskId), [])
          assert.equal(existsSync(crashed.checkout), false)
        }
        assert.equal(listed, 1)
        assert.ok(existsSync(join(repo, 'AGENTS.md')))
        assert.ok(existsSync(fileURLToPath(new URL('../../node_modules/effect', import.meta.url))))
      })
  } finally {
    await after.close()
  }
  process.stdout.write(
    `\nDEV_LAUNCHER_TUI_PROBE_PASSED ${JSON.stringify({ checks: passed, fixture: sandbox, exitCode: exit.code })}\n`
  )
} finally {
  for (const pid of stoppedCleaners) process.kill(pid, 'SIGKILL')
  const running = launcher
  if (running?.exitCode === null && running.signalCode === null) {
    const exited = new Promise<void>(resolveExit => running.once('exit', () => resolveExit()))
    running.kill('SIGKILL')
    await exited
  }
  for (const name of readdirSync(cleanupMarkers).filter(file => file.endsWith('.json'))) {
    const pid = JSON.parse(readFileSync(join(cleanupMarkers, name), 'utf8')) as number
    await waitFor(() => {
      try {
        process.kill(pid, 0)
        return false
      } catch (error) {
        assert.match(String(error), /ESRCH/)
        return true
      }
    }, `cleanup process ${pid} did not exit before fixture removal`)
  }
  rmSync(sandbox, { recursive: true, force: true })
}
