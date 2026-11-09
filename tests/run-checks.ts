import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

interface Job {
  readonly suite: string
  readonly label: string
  readonly argv: readonly [string, ...string[]]
}

interface Outcome extends Job {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly output: string
  readonly ms: number
}

const checkout = fileURLToPath(new URL('..', import.meta.url))
const probeRunner = 'tests/workspace/run-workspace-pty-probes.py'

const files =
  (...paths: string[]) =>
  () =>
    paths.map(path => ({ label: path, argv: [process.execPath, path] as const }))
const npmScript = (script: string) => () => [
  { label: `npm run ${script}`, argv: ['npm', 'run', '-s', script] as const },
]

const suites: Record<string, () => readonly Omit<Job, 'suite'>[]> = {
  lint: npmScript('lint'),
  'format:check': npmScript('format:check'),
  smoke: files(
    'tests/launcher-cache-check.ts',
    'tests/smoke.ts',
    'tests/upgrade-check.ts',
    'tests/upgrade-checks-check.ts'
  ),
  'cleanup:check': files(
    'tests/preference-cleanup-check.ts',
    'tests/conversation-cleanup-check.ts',
    'tests/cleanup-process-check.ts',
    'tests/usage-sessions-check.ts'
  ),
  'profile:check': files('tests/usage-profile-check.ts'),
  'workspace:check': files(
    'tests/workspace/workspace-completion-check.ts',
    'tests/workspace/quit-display-check.ts',
    'tests/workspace/quit-scene-check.ts',
    'tests/workspace/workspace-authority-check.ts',
    'tests/workspace/workspace-release-check.ts',
    'tests/workspace/workspace-sweep-check.ts',
    'tests/workspace/workspace-process-check.ts',
    'tests/workspace/workspace-host-contract-check.ts',
    'tests/workspace/workspace-host-session-check.ts',
    'tests/workspace/workspace-launcher-check.ts',
    'tests/workspace/repository-picker-check.ts'
  ),
  'workspace:tui': () =>
    execFileSync('python3', [probeRunner, '--list'], { cwd: checkout, encoding: 'utf8' })
      .split('\n')
      .filter(name => name !== '')
      .map(name => ({ label: `pty probe ${name}`, argv: ['python3', probeRunner, name] as const })),
  'work:check': files(
    'tests/compaction-check.ts',
    'tests/native-check.ts',
    'tests/process-family-check.ts',
    'tests/work/work-dispatch-check.ts',
    'tests/work/work-view-check.ts',
    'tests/work/work-model-text-check.ts',
    'tests/work/work-child-activity-check.ts',
    'tests/work/work-store-check.ts',
    'tests/work/work-skill-check.ts',
    'tests/work/work-nested-check.ts',
    'tests/work/work-cancel-check.ts',
    'tests/work/work-compaction-check.ts',
    'tests/work/work-extension-check.ts'
  ),
  'web:check': files(
    'tests/web/web-read-check.ts',
    'tests/web/web-owner-check.ts',
    'tests/web/web-host-check.ts'
  ),
  'workspace:github': files('tests/workspace/workspace-github-reader-check.ts'),
}

const externalServiceSuites = new Set(['workspace:github'])
const recurringSuites = Object.keys(suites).filter(suite => !externalServiceSuites.has(suite))

const durationsPath = `${checkout}node_modules/.cache/dev-checks/durations.json`
const readDurations = (): Record<string, number> => {
  try {
    return JSON.parse(readFileSync(durationsPath, 'utf8')) as Record<string, number>
  } catch {
    return {}
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const ramDiskPrefix = 'dev-checks-'
const ramDiskName = new RegExp(`^${ramDiskPrefix}(\\d+)$`)
const ramDiskSectors = 4 * 1024 * 1024
const diskutil = (...args: string[]): string =>
  execFileSync('diskutil', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const ejectRamDisk = (mountPoint: string): void => {
  try {
    diskutil('eject', 'force', mountPoint)
  } catch (cause) {
    process.stderr.write(`Cannot eject the check RAM disk ${mountPoint}: ${String(cause)}\n`)
  }
}
const mountRamDisk = (): string | undefined => {
  if (process.platform !== 'darwin') return undefined
  const name = `${ramDiskPrefix}${process.pid}`
  try {
    for (const volume of readdirSync('/Volumes')) {
      const owner = ramDiskName.exec(volume)?.[1]
      if (owner !== undefined && !alive(Number(owner))) ejectRamDisk(join('/Volumes', volume))
    }
    const device = diskutil('image', 'attach', '--noMount', `ram://${ramDiskSectors}`)
      .trim()
      .split(/\s+/)[0]!
    try {
      diskutil('erasevolume', 'APFS', name, device)
    } catch (cause) {
      diskutil('eject', device)
      throw cause
    }
    return join('/Volumes', name)
  } catch (cause) {
    process.stderr.write(
      `RAM disk unavailable, checks use the default temporary directory: ${String(cause)}\n`
    )
    return undefined
  }
}

const running = new Set<ChildProcess>()
const run = (job: Job, env: NodeJS.ProcessEnv): Promise<Outcome> =>
  new Promise((resolveRun, rejectRun) => {
    const startedAt = performance.now()
    const chunks: Buffer[] = []
    const [file, ...args] = job.argv
    const child = spawn(file, args, { cwd: checkout, env, stdio: ['ignore', 'pipe', 'pipe'] })
    running.add(child)
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.on('error', rejectRun)
    child.on('close', (code, signal) => {
      running.delete(child)
      resolveRun({
        ...job,
        code,
        signal,
        output: Buffer.concat(chunks).toString('utf8'),
        ms: performance.now() - startedAt,
      })
    })
  })

const selected = process.argv.slice(2)
const unknown = selected.filter(suite => !(suite in suites))
if (unknown.length > 0)
  throw new Error(
    `unknown suite(s) ${unknown.join(', ')}; choose from ${Object.keys(suites).join(', ')}`
  )

execFileSync(process.execPath, ['scripts/resolve-pi.ts'], { cwd: checkout, stdio: 'inherit' })
const durations = readDurations()
const jobs = (selected.length === 0 ? recurringSuites : selected).flatMap(suite =>
  suites[suite]!().map(({ label, argv }) => ({ suite, label, argv }))
)
const unmeasured = Number.MAX_SAFE_INTEGER
const longestFirst = jobs
  .toSorted(
    (left, right) => (durations[right.label] ?? unmeasured) - (durations[left.label] ?? unmeasured)
  )
  .values()
const ramDisk = mountRamDisk()
const stopOnSignal = (exitCode: number) => () => {
  for (const child of running) child.kill('SIGTERM')
  if (ramDisk !== undefined) ejectRamDisk(ramDisk)
  process.exit(exitCode)
}
process.once('SIGINT', stopOnSignal(130))
process.once('SIGTERM', stopOnSignal(143))
const env = ramDisk === undefined ? process.env : { ...process.env, TMPDIR: `${ramDisk}/` }
const outcomes: Outcome[] = []
const worker = async () => {
  for (const job of longestFirst) outcomes.push(await run(job, env))
}
try {
  await Promise.all(Array.from({ length: Math.min(availableParallelism(), jobs.length) }, worker))
} finally {
  if (ramDisk !== undefined) ejectRamDisk(ramDisk)
}

mkdirSync(dirname(durationsPath), { recursive: true })
const durationsDraft = `${durationsPath}.${process.pid}`
writeFileSync(
  durationsDraft,
  JSON.stringify({
    ...durations,
    ...Object.fromEntries(outcomes.map(outcome => [outcome.label, outcome.ms])),
  })
)
renameSync(durationsDraft, durationsPath)
const ordered = outcomes.toSorted(
  (left, right) =>
    jobs.findIndex(job => job.label === left.label) -
    jobs.findIndex(job => job.label === right.label)
)
for (const outcome of ordered) process.stdout.write(outcome.output)
for (const outcome of ordered) {
  const status =
    outcome.code === 0 ? 'passed' : `failed (${outcome.signal ?? `exit ${String(outcome.code)}`})`
  process.stdout.write(
    `${outcome.suite} ${outcome.label}: ${status} [${Math.round(outcome.ms)} ms]\n`
  )
}
process.exitCode = ordered.every(outcome => outcome.code === 0) ? 0 : 1
