import { installProfileFixture } from '../profile-fixture.ts'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { awaitCleanupExits, makeClaims } from './workspace-check-support.ts'
import { clockAdvanced } from '../wait.ts'
import { openLifecycle } from './workspace-test-lifecycle.ts'

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'dev-workspace-picker-')))
const cleanupMarkers = join(sandbox, 'cleanup-markers')
mkdirSync(cleanupMarkers)
const claims = {
  pick: 'the repository picker opens dev in the filtered choice, which then quits normally',
  cancel: 'Esc at the repository picker exits 0 without starting a conversation',
  init: 'the initialization prompt ignores typing, creates a repository in the directory and opens dev there, which then quits normally',
  'init-cancel':
    'Esc at the initialization prompt exits 0 without creating a repository or starting a conversation',
  'init-home':
    'the home directory with no repository inside is never offered initialization and exits 1',
  task: 'dev --task lists the paused work of the repository most recently used first with each head, opens a new conversation in the filtered choice and binds it to that task: its first write lands there unasked, and dev then quits normally',
  ask: 'a new conversation in a checkout a paused task holds is asked at its first write, and continuing runs that write there for the paused task without a worktree',
  resume:
    '/workspace resume lists the paused work, moves a conversation that has no message yet onto the choice without a model turn, and its next write lands there unasked',
}
const scenario = (process.env.LAUNCHER_PICKER ?? 'pick') as keyof typeof claims
const empty = scenario.startsWith('init')
const started = scenario === 'pick' || scenario === 'init'
const resumes = scenario === 'task' || scenario === 'ask' || scenario === 'resume'
const git = (args: readonly string[], cwd: string) =>
  execFileSync('git', [...args], { cwd, encoding: 'utf8' })
const { claim, passed } = makeClaims()

try {
  const area = join(sandbox, 'area')
  const root = join(sandbox, 'authority')
  const dataHome = join(sandbox, 'data')
  const home = join(sandbox, 'home')
  const sessions = join(dataHome, 'sessions')
  for (const path of [area, sessions, join(home, '.agents', 'skills')])
    mkdirSync(path, { recursive: true })
  mkdirSync(root, { mode: 0o700 })
  const profiles = installProfileFixture(join(sandbox, 'profiles'))
  for (const name of empty ? [] : ['alpha', 'beta']) {
    const repo = join(area, name)
    mkdirSync(repo)
    git(['init', '--quiet', '-b', 'main'], repo)
    git(['config', 'user.name', 'Picker Probe'], repo)
    git(['config', 'user.email', 'picker@example.invalid'], repo)
    writeFileSync(join(repo, 'AGENTS.md'), `${name}\n`)
    git(['add', 'AGENTS.md'], repo)
    git(['commit', '--quiet', '-m', 'fixture'], repo)
  }
  mkdirSync(join(area, 'notes'))
  writeFileSync(
    join(sessions, 'earlier.jsonl'),
    `${JSON.stringify({ type: 'session', version: 3, id: 'earlier', timestamp: '2026-01-01T00:00:00Z', cwd: join(area, 'beta') })}\n`,
    { mode: 0o600 }
  )
  const alpha = join(area, 'alpha')
  const pausedWork = async () => {
    const lifecycle = await openLifecycle({ root })
    try {
      const conversation = (name: string) => ({
        sessionId: `picker-${name}`,
        sessionFile: join(sandbox, `${name}.jsonl`),
        dataHome,
      })
      if (scenario !== 'task') {
        git(['switch', '--quiet', '-c', 'feat/paused'], alpha)
        writeFileSync(join(alpha, 'draft.txt'), 'uncommitted work\n')
      }
      const earlier = await lifecycle.attach({ conversation: conversation('earlier'), cwd: alpha })
      const checkout = await earlier.authorize({ kind: 'write' })
      await earlier.close()
      if (checkout.kind !== 'ready' || checkout.grant.taskId === undefined)
        throw new Error('The fixture could not reserve paused work')
      if (scenario !== 'task') return { taskId: checkout.grant.taskId }
      await clockAdvanced()
      const later = await lifecycle.attach({ conversation: conversation('later'), cwd: alpha })
      const worktree = await later.authorize({ kind: 'delegated-write' })
      await later.close()
      if (worktree.kind !== 'ready') throw new Error('The fixture could not allocate paused work')
      return { taskId: checkout.grant.taskId, worktree: worktree.grant.checkout }
    } finally {
      await lifecycle.close()
    }
  }
  const paused = resumes ? await pausedWork() : undefined
  process.stdout.write(
    `\nDEV_PICKER_INPUTS ${JSON.stringify({
      AREA: area,
      ALPHA: alpha,
      COMMIT: resumes ? git(['rev-parse', 'HEAD'], alpha).trim().slice(0, 12) : '',
    })}\n`
  )

  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('./workspace-launcher-tui-driver.ts', import.meta.url)),
      '--cwd',
      resumes ? alpha : area,
      ...(scenario === 'task' ? ['--task'] : []),
      '--data-home',
      dataHome,
      '--profile',
      profiles.defaultProfile,
    ],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        HOME: scenario === 'init-home' ? area : home,
        PI_OFFLINE: '1',
        PI_TELEMETRY_DISABLED: '1',
        LAUNCHER_TUI_ROOT: root,
        LAUNCHER_TUI_CLEANUP_MARKERS: cleanupMarkers,
      },
    }
  )
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    resolveExit => {
      child.once('exit', (code, exitSignal) => resolveExit({ code, signal: exitSignal }))
    }
  )
  await claim(claims[scenario], async () => {
    assert.equal(exit.signal, null)
    assert.equal(exit.code, scenario === 'init-home' ? 1 : 0)
    if (paused !== undefined) {
      assert.equal(readFileSync(join(alpha, 'bound.txt'), 'utf8'), 'dev-task-written')
      if (paused.worktree !== undefined)
        assert.ok(
          !existsSync(join(paused.worktree, 'bound.txt')),
          'the other paused work is untouched'
        )
      const lifecycle = await openLifecycle({ root })
      try {
        const views = await lifecycle.inspect({ cwd: alpha })
        assert.deepEqual(
          views.map(view => view.path),
          [alpha],
          'the conversation was not isolated into another worktree'
        )
        const writers = views
          .find(view => view.path === alpha)
          ?.uses.filter(use => use.access === 'write')
        assert.equal(views.find(view => view.path === alpha)?.taskId, paused.taskId)
        assert.ok((writers?.length ?? 0) > 1, 'the new conversation wrote for the paused task')
      } finally {
        await lifecycle.close()
      }
    }
    if (!started && !resumes) assert.deepEqual(readdirSync(sessions), ['earlier.jsonl'])
    if (empty) assert.equal(existsSync(join(area, '.git')), started)
    if (empty && started) assert.equal(git(['rev-parse', '--show-toplevel'], area).trim(), area)
  })
  process.stdout.write(`\nDEV_PICKER_PROBE_PASSED ${JSON.stringify({ checks: passed })}\n`)
} finally {
  await awaitCleanupExits(cleanupMarkers)
  rmSync(sandbox, { recursive: true, force: true })
}
