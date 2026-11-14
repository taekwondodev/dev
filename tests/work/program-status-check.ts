import assert from 'node:assert/strict'
import { setImmediate as nextMacrotask } from 'node:timers/promises'
import type { ProgramStatus } from '../../node_modules/@earendil-works/pi-tui/dist/index.js'
import { makeLeadProgramStatus, type RestingState } from '../../src/program-status.ts'
import { makeClaims } from '../workspace/workspace-check-support.ts'

const { claim, passed } = makeClaims()

const recorder = () => {
  const reports: ProgramStatus[] = []
  return {
    reports,
    terminal: {
      setProgramStatus(status: ProgramStatus): void {
        reports.push(status)
      },
    },
  }
}

const openResting = (resting: () => RestingState) => {
  const { reports, terminal } = recorder()
  const rule = makeLeadProgramStatus()
  rule.observe(resting)
  return { reports, terminal: rule.attach(terminal), rule }
}

const open = (willReactivate: () => boolean) =>
  openResting(() => (willReactivate() ? { state: 'working' } : { state: 'done' }))

const DONE: ProgramStatus = { state: 'done', app: 'pi', message: 'session name' }

await claim(
  'done reads working, with the same name and message, while work will reactivate',
  () => {
    const { reports, terminal } = open(() => true)
    terminal.setProgramStatus(DONE)
    assert.deepEqual(reports, [{ state: 'working', app: 'pi', message: 'session name' }])
  }
)

await claim(
  'the withheld done is reported once when a notification finds no reactivation',
  async () => {
    let answer = true
    const { reports, terminal, rule } = open(() => answer)
    terminal.setProgramStatus(DONE)
    rule.changed()
    await nextMacrotask()
    assert.equal(reports.length, 1, 'a notification that changes nothing reports nothing')
    answer = false
    rule.changed()
    rule.changed()
    assert.equal(reports.length, 1, 'a notification is not evaluated inside its own dispatch')
    await nextMacrotask()
    rule.changed()
    await nextMacrotask()
    assert.deepEqual(reports, [{ ...DONE, state: 'working' }, DONE])
  }
)

await claim('done passes unchanged when nothing will reactivate the lead', () => {
  const { reports, terminal } = open(() => false)
  terminal.setProgramStatus(DONE)
  assert.deepEqual(reports, [DONE])
})

await claim('a reactivation that begins after done turns the report to working', async () => {
  let answer = false
  const { reports, terminal, rule } = open(() => answer)
  terminal.setProgramStatus(DONE)
  answer = true
  rule.changed()
  await nextMacrotask()
  assert.deepEqual(reports, [DONE, { ...DONE, state: 'working' }])
})

await claim('idle, working, blocked and error pass unchanged whatever the lead rest', async () => {
  const others: ProgramStatus[] = [
    { state: 'idle', app: 'pi' },
    { state: 'working', app: 'pi', message: 'session name' },
    { state: 'blocked', app: 'pi', kind: 'question', message: 'Pick one' },
    { state: 'error', app: 'pi', message: 'provider failed' },
  ]
  const rests: RestingState[] = [
    { state: 'working' },
    { state: 'done' },
    { state: 'blocked', message: 'Quiet command: tests' },
  ]
  for (const rest of rests) {
    const { reports, terminal, rule } = openResting(() => rest)
    for (const status of others) {
      terminal.setProgramStatus(status)
      rule.changed()
      await nextMacrotask()
    }
    assert.deepEqual(reports, others, rest.state)
  }
})

await claim(
  'done reads blocked with the quiet message while a quiet notice waits for the user',
  () => {
    const { reports, terminal } = openResting(() => ({
      state: 'blocked',
      message: 'Quiet command: tests',
    }))
    terminal.setProgramStatus(DONE)
    assert.deepEqual(reports, [{ state: 'blocked', app: 'pi', message: 'Quiet command: tests' }])
  }
)

await claim('a blocked report follows its message and clears to working, then done', async () => {
  let resting: RestingState = { state: 'blocked', message: 'Quiet command: tests' }
  const { reports, terminal, rule } = openResting(() => resting)
  terminal.setProgramStatus(DONE)
  resting = { state: 'blocked', message: 'Quiet commands: tests, build' }
  rule.changed()
  await nextMacrotask()
  resting = { state: 'working' }
  rule.changed()
  await nextMacrotask()
  resting = { state: 'done' }
  rule.changed()
  await nextMacrotask()
  assert.deepEqual(reports, [
    { ...DONE, state: 'blocked', message: 'Quiet command: tests' },
    { ...DONE, state: 'blocked', message: 'Quiet commands: tests, build' },
    { ...DONE, state: 'working' },
    DONE,
  ])
})

console.log(JSON.stringify({ result: 'passed', checks: passed }, null, 2))
