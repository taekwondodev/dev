import { installProfileFixture } from '../profile-fixture.ts'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { awaitCleanupExits, makeClaims } from './workspace-check-support.ts'

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'dev-workspace-empty-quit-')))
const cleanupMarkers = join(sandbox, 'cleanup-markers')
mkdirSync(cleanupMarkers)
const git = (args: readonly string[], cwd: string) =>
  execFileSync('git', [...args], { cwd, encoding: 'utf8' })
const { claim, passed } = makeClaims()

try {
  const repo = join(sandbox, 'repo')
  const root = join(sandbox, 'authority')
  const dataHome = join(sandbox, 'data')
  const home = join(sandbox, 'home')
  for (const path of [repo, dataHome, join(home, '.agents', 'skills')])
    mkdirSync(path, { recursive: true })
  mkdirSync(root, { mode: 0o700 })
  const profiles = installProfileFixture(join(sandbox, 'profiles'))
  git(['init', '--quiet', '-b', 'main'], repo)
  git(['config', 'user.name', 'Empty Quit Probe'], repo)
  git(['config', 'user.email', 'empty-quit@example.invalid'], repo)
  writeFileSync(join(repo, 'AGENTS.md'), 'empty quit probe\n')
  git(['add', 'AGENTS.md'], repo)
  git(['commit', '--quiet', '-m', 'fixture'], repo)

  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('./workspace-launcher-tui-driver.ts', import.meta.url)),
      '--cwd',
      repo,
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
        LAUNCHER_TUI_CLEANUP_MARKERS: cleanupMarkers,
      },
    }
  )
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    resolveExit => {
      child.once('exit', (code, exitSignal) => resolveExit({ code, signal: exitSignal }))
    }
  )
  await claim('quitting with nothing reserved sweeps nothing and exits 0', () => {
    assert.equal(exit.signal, null)
    assert.equal(exit.code, 0)
  })
  process.stdout.write(`\nDEV_EMPTY_QUIT_PROBE_PASSED ${JSON.stringify({ checks: passed })}\n`)
} finally {
  await awaitCleanupExits(cleanupMarkers)
  rmSync(sandbox, { recursive: true, force: true })
}
