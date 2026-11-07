import { installProfileFixture } from '../profile-fixture.ts'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeClaims } from './workspace-check-support.ts'

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'dev-workspace-picker-')))
const cancelled = process.env.LAUNCHER_PICKER === 'cancel'
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
  for (const name of ['alpha', 'beta']) {
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
    ],
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
  await claim(
    cancelled
      ? 'Esc at the repository picker exits 0 without starting a conversation'
      : 'the repository picker opens dev in the filtered choice, which then quits normally',
    () => {
      assert.equal(exit.signal, null)
      assert.equal(exit.code, 0)
      if (cancelled) assert.deepEqual(readdirSync(sessions), ['earlier.jsonl'])
    }
  )
  process.stdout.write(`\nDEV_PICKER_PROBE_PASSED ${JSON.stringify({ checks: passed })}\n`)
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}
