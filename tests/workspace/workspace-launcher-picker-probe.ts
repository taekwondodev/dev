import { installProfileFixture } from '../profile-fixture.ts'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { awaitCleanupExits, makeClaims } from './workspace-check-support.ts'

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
  'init-orb':
    'dev --orb in a directory with no repository inside is never offered initialization and exits 1',
}
const scenario = (process.env.LAUNCHER_PICKER ?? 'pick') as keyof typeof claims
const empty = scenario.startsWith('init')
const started = scenario === 'pick' || scenario === 'init'
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
  process.stdout.write(
    `\nDEV_PICKER_INPUTS ${JSON.stringify({ AREA: area, ALPHA: join(area, 'alpha') })}\n`
  )

  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('./workspace-launcher-tui-driver.ts', import.meta.url)),
      '--cwd',
      area,
      '--data-home',
      dataHome,
      '--profile',
      profiles.defaultProfile,
      ...(scenario === 'init-orb' ? ['--orb'] : []),
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
  await claim(claims[scenario], () => {
    assert.equal(exit.signal, null)
    assert.equal(exit.code, scenario === 'init-home' || scenario === 'init-orb' ? 1 : 0)
    if (!started) assert.deepEqual(readdirSync(sessions), ['earlier.jsonl'])
    if (empty) assert.equal(existsSync(join(area, '.git')), started)
    if (empty && started) assert.equal(git(['rev-parse', '--show-toplevel'], area).trim(), area)
  })
  process.stdout.write(`\nDEV_PICKER_PROBE_PASSED ${JSON.stringify({ checks: passed })}\n`)
} finally {
  await awaitCleanupExits(cleanupMarkers)
  rmSync(sandbox, { recursive: true, force: true })
}
