import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeServices } from '@effect/platform-node'
import { Effect, Schema } from 'effect'
import { runUpgradeChecks } from '../scripts/upgrade-checks.ts'

const cwd = mkdtempSync(join(tmpdir(), 'dev-upgrade-checks-'))
const names = [
  'types:pi',
  'lint',
  'format:check',
  'smoke',
  'profile:check',
  'workspace:check',
  'workspace:tui',
  'workspace:github',
  'work:check',
  'web:check',
]
try {
  writeFileSync(
    join(cwd, 'package.json'),
    JSON.stringify({
      scripts: Object.fromEntries(names.map(name => [name, 'node check.cjs'])),
    })
  )
  writeFileSync(
    join(cwd, 'check.cjs'),
    String.raw`
const { appendFileSync, existsSync, writeFileSync } = require('node:fs')
const name = process.env.npm_lifecycle_event
if (name === 'types:pi') {
  if (process.env.FAIL_PREPARATION === 'yes') process.exit(1)
  writeFileSync('prepared', process.env.DEV_PI_RELEASE)
} else if (!existsSync('prepared')) {
  throw new Error('suite started before preparation')
}
appendFileSync('events', JSON.stringify({ name, start: true }) + '\n')
console.log('fixture:stdout:' + name)
console.error('fixture:stderr:' + name)
const end = () => {
  appendFileSync('events', JSON.stringify({ name, start: false }) + '\n')
  process.exit(name === 'lint' ? 1 : 0)
}
if (['lint', 'format:check', 'smoke'].includes(name)) {
  writeFileSync(name, '')
  const deadline = Date.now() + 10000
  const timer = setInterval(() => {
    if (['lint', 'format:check', 'smoke'].every(name => existsSync(name))) {
      clearInterval(timer)
      setTimeout(end, 100)
    } else if (Date.now() > deadline) {
      throw new Error('suites did not overlap')
    }
  }, 10)
} else end()
`
  )
  const run = (env: Record<string, string>) =>
    Effect.runPromise(runUpgradeChecks(cwd, env).pipe(Effect.provide(NodeServices.layer)))
  const results = await run({ DEV_PI_RELEASE: '/fixture/pi' })
  assert.deepEqual(
    results.map(result => result.step),
    names
  )
  assert.deepEqual(
    results.filter(result => !result.passed).map(result => result.step),
    ['lint']
  )
  assert.equal(readFileSync(join(cwd, 'prepared'), 'utf8'), '/fixture/pi')
  let active = 0
  let peak = 0
  for (const line of readFileSync(join(cwd, 'events'), 'utf8').trim().split('\n')) {
    const event = Schema.decodeSync(
      Schema.fromJsonString(Schema.Struct({ start: Schema.Boolean }))
    )(line)
    active += event.start ? 1 : -1
    peak = Math.max(peak, active)
  }
  assert.equal(peak, 3)
  assert.equal(active, 0)
  for (const result of results) {
    assert.deepEqual(
      result.output
        .split(/\r?\n/)
        .filter(line => line.startsWith('fixture:'))
        .toSorted(),
      [`fixture:stderr:${result.step}`, `fixture:stdout:${result.step}`]
    )
  }
  const events = readFileSync(join(cwd, 'events'), 'utf8')
  const failed = await run({ FAIL_PREPARATION: 'yes' })
  assert.deepEqual(
    failed.map(result => [result.step, result.passed]),
    [['types:pi', false]]
  )
  assert.equal(readFileSync(join(cwd, 'events'), 'utf8'), events)
  console.log(
    'upgrade checks: serial preparation, three concurrent suites, ordered failures and per-suite stdout/stderr capture passed'
  )
} finally {
  rmSync(cwd, { recursive: true, force: true })
}
