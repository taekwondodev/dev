import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { type CheckOutcome, runUpgradeChecks } from '../scripts/upgrade-checks.ts'

const cwd = mkdtempSync(join(tmpdir(), 'dev-upgrade-checks-'))
const reportPath = join(cwd, 'checks.json')
const reported: readonly CheckOutcome[] = [
  { suite: 'lint', command: 'npm run -s lint', passed: false, ms: 20, output: 'lint failed\n' },
  { suite: 'smoke', command: 'node tests/smoke.ts', passed: true, ms: 10, output: 'smoke\n' },
]
try {
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ type: 'module' }))
  mkdirSync(join(cwd, 'tests'))
  writeFileSync(
    join(cwd, 'tests', 'run-checks.ts'),
    String.raw`
import { writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
writeFileSync('invocation.json', JSON.stringify({ args, release: process.env.DEV_PI_RELEASE }))
console.log('fixture:stdout')
console.error('fixture:stderr')
const report = process.env.FIXTURE_REPORT
if (report !== undefined) writeFileSync(args.at(-1).slice('--report='.length), report)
process.exit(1)
`
  )
  const run = (env: Record<string, string>) =>
    Effect.runPromise(
      runUpgradeChecks(cwd, env, reportPath).pipe(Effect.provide(NodeServices.layer))
    )
  const ran = await run({ DEV_PI_RELEASE: '/fixture/pi', FIXTURE_REPORT: JSON.stringify(reported) })
  assert.deepEqual(ran.outcomes, Option.some(reported))
  assert.deepEqual(JSON.parse(readFileSync(join(cwd, 'invocation.json'), 'utf8')), {
    args: ['--all', `--report=${reportPath}`],
    release: '/fixture/pi',
  })
  const unprepared = await run({})
  assert.deepEqual(unprepared.outcomes, Option.none(), 'an earlier report is not read again')
  assert.equal(existsSync(reportPath), false)
  assert.match(unprepared.output, /fixture:stdout/)
  assert.match(unprepared.output, /fixture:stderr/)
  await assert.rejects(
    run({ FIXTURE_REPORT: '[{"suite":"lint"}]' }),
    /Cannot read the check report/
  )
  console.log(
    'upgrade checks: one runner invocation for every suite, candidate environment, per-check outcomes, missing and malformed reports passed'
  )
} finally {
  rmSync(cwd, { recursive: true, force: true })
}
