import { spawn } from 'node:child_process'

interface Outcome {
  readonly file: string
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly output: string
  readonly ms: number
}

const run = (file: string): Promise<Outcome> =>
  new Promise((resolveRun, rejectRun) => {
    const startedAt = performance.now()
    const chunks: Buffer[] = []
    const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.on('error', rejectRun)
    child.on('close', (code, signal) =>
      resolveRun({
        file,
        code,
        signal,
        output: Buffer.concat(chunks).toString('utf8'),
        ms: performance.now() - startedAt,
      })
    )
  })

const files = process.argv.slice(2)
if (files.length === 0) throw new Error('usage: node tests/run-checks.ts <check.ts>...')
const outcomes = await Promise.all(files.map(run))
const failed = outcomes.filter(outcome => outcome.code !== 0)
for (const outcome of outcomes) process.stdout.write(outcome.output)
for (const outcome of outcomes) {
  const status =
    outcome.code === 0 ? 'passed' : `failed (${outcome.signal ?? `exit ${String(outcome.code)}`})`
  process.stdout.write(`${outcome.file}: ${status} [${Math.round(outcome.ms)} ms]\n`)
}
process.exitCode = failed.length === 0 ? 0 : 1
