import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { join } from 'node:path'
import { Effect, Schema } from 'effect'
import {
  loadInstalledPi,
  makeClaims,
  toolCall,
  type ScriptedContent,
} from '../workspace/workspace-check-support.ts'
import {
  createCoordinatorWorkTool,
  type CoordinatorLink,
} from '../../src/work-child-coordination.ts'
import { READ_ONLY_CHILD_TOOLS } from '../../src/work-domain.ts'
import { openWorkFixture } from './work-check-support.ts'
import { openLead, type Lead, type LeadRequest } from './work-extension-support.ts'

const OUTCOME = 'dev/work-outcome'
const INSPECTION = 'dev/work-inspection'

const installed = await loadInstalledPi()
const { claim, passed } = makeClaims()
const fixture = await openWorkFixture('work-extension')
process.env.PI_CODING_AGENT_DIR = fixture.agentDir

const decodeStarted = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ id: Schema.String, pid: Schema.Int }))
)
const decodeDelivered = Schema.decodeUnknownSync(
  Schema.Struct({ attempts: Schema.Array(Schema.String) })
)
const decodeListing = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      cancellationRequested: Schema.optional(Schema.Boolean),
      records: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          status: Schema.String,
          deliveryError: Schema.optional(Schema.String),
        })
      ),
    })
  )
)

let gates = 0
const gate = () => {
  const path = join(fixture.root, `gate-${++gates}`)
  return {
    command: `while [ ! -e '${path}' ]; do sleep 0.05; done`,
    open: () => writeFileSync(path, ''),
  }
}

const text = (value: string): ScriptedContent => [{ type: 'text', text: value }]
const seen = (request: LeadRequest): string => JSON.stringify(request.context.messages.at(-1))
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const withLead = async <A>(
  options: Parameters<typeof openLead>[2],
  body: (lead: Lead) => Promise<A>
): Promise<A> => {
  const lead = await openLead(installed, fixture, options)
  try {
    const result = await body(lead)
    assert.deepEqual(lead.handlerErrors, [])
    return result
  } finally {
    await lead.close()
  }
}

const launch = async (lead: Lead, index: number, commands: readonly string[]) => {
  const run = lead.session.prompt('start background work')
  const first = await lead.request(index)
  first.reply(
    commands.map((command, position) =>
      toolCall(`launch-${index}-${position}`, 'work', {
        action: 'process',
        taskId: `task-${index}-${position}`,
        command,
      })
    )
  )
  const next = await lead.request(index + 1)
  const started = next.context.messages.slice(-commands.length).map(message => {
    const [part] = typeof message.content === 'string' ? [] : message.content
    return decodeStarted(part?.type === 'text' ? part.text : undefined)
  })
  return { run, next, started }
}

const delivered = (lead: Lead): string[] =>
  lead.customMessages(OUTCOME).flatMap(entry => decodeDelivered(entry.details).attempts)

const listing = async (lead: Lead, command = '/work') => {
  await lead.session.prompt(command)
  const shown = lead.customMessages(INSPECTION).at(-1)
  assert.ok(shown !== undefined && typeof shown.content === 'string')
  return decodeListing(shown.content)
}

const userTurn = async (lead: Lead, index: number, prompt: string): Promise<void> => {
  const run = lead.session.prompt(prompt)
  const request = await lead.request(index)
  assert.ok(
    seen(request).includes(prompt),
    `request ${index} is not the user turn: ${seen(request)}`
  )
  request.reply(text('acknowledged'))
  await run
  await lead.idle()
}

const unusedLink: CoordinatorLink = {
  request: () => Effect.die('unused'),
  pending: Effect.die('unused'),
  acknowledge: () => Effect.die('unused'),
  wake: Effect.die('unused'),
}

const assertReadOnlyCapabilities = (description: string | undefined): void => {
  assert.ok(description !== undefined)
  for (const tool of READ_ONLY_CHILD_TOOLS) assert.ok(description.includes(tool), tool)
  assert.ok(description.includes('no shell, network or gh'))
  assert.ok(description.includes('in the prompt or a workspace file'))
}

try {
  await claim('the lead and coordinator work tools state what a read-only child can reach', () =>
    withLead({}, async lead => {
      assertReadOnlyCapabilities(
        lead.session.getAllTools().find(tool => tool.name === 'work')?.description
      )
      assertReadOnlyCapabilities(createCoordinatorWorkTool(unusedLink).description)
    })
  )

  await claim(
    'outcomes arrive when the current run settles and an eligible batch continues a successful lead run without another user message',
    () =>
      withLead({}, async lead => {
        const { run, next, started } = await launch(lead, 0, ['true'])
        const [attempt] = started
        assert.ok(attempt)
        await lead.status('the process completed', value => value.includes('completed'))
        assert.ok(lead.activities.length >= 2)
        for (const activity of lead.activities)
          assert.deepEqual(activity, { sessionId: lead.manager.getSessionId(), active: false })
        assert.deepEqual(delivered(lead), [])
        next.reply(text('launched'))
        const continued = await lead.request(2)
        assert.ok(seen(continued).includes(attempt.id) && seen(continued).includes('completed'))
        assert.deepEqual(delivered(lead), [attempt.id])
        continued.reply(text('outcome read'))
        await run
        await lead.idle()
        await userTurn(lead, 3, 'unrelated question')
        assert.deepEqual(delivered(lead), [attempt.id])
        assert.equal(lead.requests.length, 4)
      })
  )

  await claim(
    'a late outcome arrives at idle and continues the lead without another user message',
    () =>
      withLead({}, async lead => {
        const held = gate()
        const { run, next, started } = await launch(lead, 0, [held.command])
        const [attempt] = started
        assert.ok(attempt)
        next.reply(text('launched'))
        await run
        await lead.idle()
        assert.deepEqual(delivered(lead), [])
        held.open()
        const continued = await lead.request(2)
        assert.ok(seen(continued).includes(attempt.id) && seen(continued).includes('completed'))
        continued.reply(text('outcome read'))
        await lead.idle()
        await userTurn(lead, 3, 'unrelated question')
        assert.deepEqual(delivered(lead), [attempt.id])
        assert.equal(lead.requests.length, 4)
      })
  )

  await claim('outcomes that complete together at idle each arrive once', () =>
    withLead({}, async lead => {
      const held = gate()
      const { run, next, started } = await launch(lead, 0, [
        held.command,
        held.command,
        held.command,
      ])
      next.reply(text('launched'))
      await run
      await lead.idle()
      held.open()
      const expected = started.map(attempt => attempt.id).toSorted()
      const allArrived = () => delivered(lead).length >= expected.length && lead.session.isIdle
      for (let index = 2; ; index += 1) {
        const request = await lead.wait(
          'a continuation or every outcome delivered',
          () => lead.requests[index] ?? (allArrived() ? null : undefined)
        )
        if (request === null) break
        request.reply(text('outcome read'))
      }
      await userTurn(lead, lead.requests.length, 'unrelated question')
      assert.deepEqual(delivered(lead).toSorted(), expected)
    })
  )

  await claim(
    'failed delivery remains visible in /work and its retry starts no model call',
    async () => {
      let failures = 1
      await withLead(
        {
          send: deliver => (message, options) => {
            if (failures === 0) return deliver(message, options)
            failures -= 1
            return Promise.reject(new Error('conversation transport down'))
          },
        },
        async lead => {
          const held = gate()
          const { run, next, started } = await launch(lead, 0, [held.command])
          const [attempt] = started
          assert.ok(attempt)
          next.reply(text('launched'))
          await run
          await lead.idle()
          held.open()
          await lead.wait('the delivery failure to be reported', () => lead.notices[0])
          assert.deepEqual(lead.notices, [
            { message: 'Background work: conversation transport down', level: 'error' },
          ])
          const shown = await lead.wait('the failure to be recorded on the attempt', async () =>
            (await listing(lead)).records.find(record => record.deliveryError !== undefined)
          )
          assert.equal(shown.id, attempt.id)
          assert.equal(shown.deliveryError, 'conversation transport down')
          await userTurn(lead, 2, 'what happened')
          assert.deepEqual(delivered(lead), [attempt.id])
          await userTurn(lead, 3, 'unrelated question')
          assert.deepEqual(delivered(lead), [attempt.id])
          assert.equal(lead.requests.length, 4)
          assert.equal(lead.notices.length, 1)
        }
      )
    }
  )

  await claim(
    'a send that throws is recorded as a failed delivery, and a notification that throws while reporting it does not stop idle delivery: a later outcome still arrives at idle',
    async () => {
      let sendFailures = 1
      let notifyFailures = 1
      let notifyAttempts = 0
      await withLead(
        {
          send: deliver => (message, options) => {
            if (sendFailures === 0) return deliver(message, options)
            sendFailures -= 1
            throw new Error('conversation transport down')
          },
          notify: () => {
            notifyAttempts += 1
            if (notifyFailures === 0) return
            notifyFailures -= 1
            throw new Error('stale extension context')
          },
        },
        async lead => {
          const first = gate()
          const second = gate()
          const { run, next, started } = await launch(lead, 0, [first.command, second.command])
          const [failed, later] = started
          assert.ok(failed)
          assert.ok(later)
          next.reply(text('launched'))
          await run
          await lead.idle()
          first.open()
          await lead.wait('the delivery failure report to be attempted', () =>
            notifyAttempts > 0 ? true : undefined
          )
          const shown = await lead.wait('the failure to be recorded on the attempt', async () =>
            (await listing(lead)).records.find(record => record.deliveryError !== undefined)
          )
          assert.equal(shown.id, failed.id)
          assert.equal(shown.deliveryError, 'conversation transport down')
          second.open()
          await lead.wait('the later outcome to arrive at idle', () =>
            delivered(lead).includes(later.id) ? true : undefined
          )
        }
      )
    }
  )

  await claim(
    'subscription exhaustion blocks new agents and automatic continuation, and another user message does not clear it',
    () =>
      withLead({}, async lead => {
        const held = gate()
        const { run, next, started } = await launch(lead, 0, [held.command])
        const [attempt] = started
        assert.ok(attempt)
        next.fail('insufficient_quota: You exceeded your current quota')
        await run
        await lead.idle()
        const again = lead.session.prompt('try again')
        const retried = await lead.request(2)
        retried.reply([
          toolCall('blocked-agent', 'work', {
            action: 'delegate',
            taskId: 'blocked',
            prompt: 'never starts',
            access: 'read-only',
          }),
        ])
        const refused = await lead.request(3)
        assert.ok(seen(refused).includes('Subscription exhausted'), seen(refused))
        held.open()
        await lead.status('the process completed', value => value.includes('completed'))
        refused.reply(text('finished'))
        await again
        await lead.idle()
        assert.deepEqual(delivered(lead), [attempt.id])
        await userTurn(lead, 4, 'unrelated question')
        assert.deepEqual(delivered(lead), [attempt.id])
        assert.equal(lead.requests.length, 5)
        assert.deepEqual(
          (await listing(lead)).records.map(record => record.status),
          ['completed']
        )
      })
  )

  await claim(
    'a final lead failure suspends automatic reactivation until the next user message',
    () =>
      withLead({}, async lead => {
        const first = gate()
        const second = gate()
        const { run, next, started } = await launch(lead, 0, [first.command, second.command])
        const [suspended, resumed] = started
        assert.ok(suspended && resumed)
        next.fail('upstream connection reset')
        await run
        await lead.idle()
        first.open()
        await lead.wait('the outcome to arrive without a model call', () =>
          delivered(lead).includes(suspended.id) ? true : undefined
        )
        assert.equal(lead.requests.length, 2)
        await userTurn(lead, 2, 'carry on')
        second.open()
        const continued = await lead.request(3)
        assert.ok(seen(continued).includes(resumed.id), seen(continued))
        continued.reply(text('outcome read'))
        await lead.idle()
        assert.deepEqual(delivered(lead), [suspended.id, resumed.id])
      })
  )

  await claim('compaction and context edits do not erase delivery acknowledgment', () =>
    withLead({}, async lead => {
      const { run, next, started } = await launch(lead, 0, ['true'])
      const [attempt] = started
      assert.ok(attempt)
      await lead.status('the process completed', value => value.includes('completed'))
      next.reply(text('launched'))
      const continued = await lead.request(2)
      const [outcome] = lead.customMessages(OUTCOME)
      assert.ok(outcome)
      lead.manager.appendContextEdit(outcome.id, { content: 'outcome elided by a context edit' })
      continued.reply([toolCall('list', 'work', { action: 'list' })])
      const listed = await lead.request(3)
      const kept = lead.manager.getBranch().at(-2)
      assert.ok(kept)
      lead.manager.appendCompaction('summary replacing the delivered outcome', kept.id, 1000)
      listed.reply(text('outcome read'))
      await run
      await lead.idle()
      await userTurn(lead, 4, 'unrelated question')
      assert.deepEqual(delivered(lead), [attempt.id])
      assert.deepEqual((await listing(lead)).records, [{ id: attempt.id, status: 'completed' }])
      assert.equal(lead.requests.length, 5)
    })
  )

  await claim('the status line shows states and follows each change to the final state', () =>
    withLead({}, async lead => {
      const held = gate()
      const { run, next } = await launch(lead, 0, [held.command, 'true'])
      await lead.status('one attempt still running', value =>
        isDeepStrictEqual(value.split(' · ').toSorted(), ['1 completed', '1 running'])
      )
      held.open()
      await lead.status('every attempt completed', value => value === '2 completed')
      next.reply(text('launched'))
      ;(await lead.request(2)).reply(text('outcome read'))
      await run
      await lead.idle()
      await userTurn(lead, 3, 'unrelated question')
      assert.equal(lead.statuses.at(-1), '2 completed')
      assert.ok(lead.statuses.includes('1 running') || lead.statuses.includes('2 running'))
    })
  )

  await claim(
    '/work stop <id> cancels one attempt and /work stop cancels all owned attempts while the lead is idle',
    () =>
      withLead({}, async lead => {
        const held = gate()
        const { run, next, started } = await launch(lead, 0, [held.command, held.command])
        const [one, other] = started
        assert.ok(one && other)
        next.reply(text('launched'))
        await run
        await lead.idle()
        await lead.session.prompt(`/work stop ${one.id}`)
        const reported = await lead.request(2)
        assert.ok(seen(reported).includes(one.id) && seen(reported).includes('cancelled'))
        reported.reply(text('outcome read'))
        await lead.idle()
        assert.deepEqual(
          (await listing(lead)).records.map(record => [record.id, record.status]).toSorted(),
          [
            [one.id, 'cancelled'],
            [other.id, 'running'],
          ].toSorted()
        )
        assert.equal(alive(one.pid), false)
        assert.equal(alive(other.pid), true)
        const stopped = await listing(lead, '/work stop')
        assert.equal(stopped.cancellationRequested, true)
        assert.deepEqual(
          stopped.records.map(record => record.status),
          ['cancelled', 'cancelled']
        )
        assert.equal(alive(other.pid), false)
        assert.equal(lead.session.isIdle, true)
      })
  )

  await claim('Esc during a lead run stops owned work', () =>
    withLead({}, async lead => {
      const held = gate()
      const { run, next, started } = await launch(lead, 0, [held.command])
      const [attempt] = started
      assert.ok(attempt)
      assert.equal(lead.session.isStreaming, true)
      lead.typeTerminal('\u001b')
      await lead.status('the attempt cancelled', value => value === '1 cancelled')
      assert.equal(alive(attempt.pid), false)
      next.reply(text('launched'))
      await run
      await lead.idle()
      assert.deepEqual(lead.notices, [])
    })
  )

  await claim('ending the session stops owned work', async () => {
    const lead = await openLead(installed, fixture)
    const held = gate()
    const { run, next, started } = await launch(lead, 0, [held.command])
    const [attempt] = started
    assert.ok(attempt)
    next.reply(text('launched'))
    await run
    await lead.idle()
    assert.equal(alive(attempt.pid), true)
    await lead.close()
    assert.equal(alive(attempt.pid), false)
    assert.deepEqual(lead.handlerErrors, [])
  })
} finally {
  await fixture.close()
}

console.log(
  JSON.stringify(
    {
      result: 'passed',
      checks: passed,
      limitation:
        'Offline scripted lead in a real Pi session; background work is local commands only, no child agent or live model',
    },
    null,
    2
  )
)
