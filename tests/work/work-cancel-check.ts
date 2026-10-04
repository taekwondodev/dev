import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { Effect } from 'effect'
import { makeClaims, waitFor } from '../workspace/workspace-check-support.ts'
import { assertStatus, openWorkFixture, script, settled } from './work-check-support.ts'
import { cancelLog, HOLD_CANCEL } from './work-child-model.ts'

const { claim, passed } = makeClaims()
const fixture = await openWorkFixture('work-cancel')
try {
  const owner = fixture.openOwner('general')
  try {
    await claim(
      'concurrent cancellations of one attempt send its child one cancel message and settle it as cancelled',
      async () => {
        const started = await owner.delegate({
          taskId: 'repeated-cancel',
          prompt: `Repeated cancel\n${HOLD_CANCEL}\n${script([{ delayMs: 60_000, content: [{ type: 'text', text: 'slow reply' }] }])}`,
        })
        await waitFor('the child to request its model', () =>
          fixture.modelCalls().includes(started.id) ? true : undefined
        )
        const views = await owner.call(actions =>
          Effect.all([actions.cancel(started.id), actions.cancel(started.id)], {
            concurrency: 'unbounded',
          })
        )
        assert.deepEqual(
          views.map(view => view.status),
          ['cancelled', 'cancelled']
        )
        const record = await owner.attempt(
          'the cancelled child to settle',
          candidate => candidate.id === started.id,
          settled
        )
        assertStatus(record, 'cancelled')
        assert.equal(record.protocolError, undefined)
        const file = cancelLog(fixture.dataHome, started.id)
        const signals = existsSync(file)
          ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length
          : 0
        assert.equal(signals, 1)
      }
    )
  } finally {
    await owner.close()
  }
} finally {
  await fixture.close()
}

console.log(
  JSON.stringify(
    {
      result: 'passed',
      checks: passed,
      limitation: 'Offline scripted model in a real child process; no live credentials or model',
    },
    null,
    2
  )
)
