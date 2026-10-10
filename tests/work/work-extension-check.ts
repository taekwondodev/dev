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
import {
  AttemptOutcomeSchema,
  INTEGRATED_CHILD_TOOLS,
  READ_ONLY_CHILD_TOOLS,
  WorkResultSchema,
  type WorkResult,
} from '../../src/work-domain.ts'
import { waitOnlyCommand } from '../../src/work-wait-guard.ts'
import { openWorkFixture } from './work-check-support.ts'
import { openLead, type Lead, type LeadRequest } from './work-extension-support.ts'

const OUTCOME = 'dev/work-outcome'
const INSPECTION = 'dev/work-inspection'

const installed = await loadInstalledPi()
const { claim, passed } = makeClaims()
const fixture = await openWorkFixture('work-extension')
process.env.PI_CODING_AGENT_DIR = fixture.agentDir

const decodeResult = Schema.decodeUnknownSync(Schema.fromJsonString(WorkResultSchema), {
  onExcessProperty: 'error',
})
const decodeStructured = Schema.decodeUnknownSync(WorkResultSchema, {
  onExcessProperty: 'error',
})
const decodeOutcomes = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(AttemptOutcomeSchema)),
  { onExcessProperty: 'error' }
)
const decodeDelivered = Schema.decodeUnknownSync(
  Schema.Struct({ attempts: Schema.Array(Schema.String) })
)
const decodeParameters = Schema.decodeUnknownSync(
  Schema.Struct({
    properties: Schema.Record(
      Schema.String,
      Schema.Struct({ description: Schema.optionalKey(Schema.String) })
    ),
  })
)
const decodeRecordPid = Schema.decodeUnknownSync(Schema.Struct({ pid: Schema.Int }))

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
const toolResults = (request: LeadRequest): string[] =>
  request.context.messages.flatMap(message => {
    if (message.role !== 'toolResult' || typeof message.content === 'string') return []
    return [message.content.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('\n')]
  })
const outcomeItems = (content: string) => decodeOutcomes(content.slice(content.indexOf('\n') + 1))
const byKind = (items: readonly WorkResult[]) =>
  items.toSorted((left, right) => left.kind.localeCompare(right.kind))
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
  const started = toolResults(next)
    .slice(-commands.length)
    .map(result => {
      const { kind, attempt } = decodeResult(result)
      assert.equal(kind, 'attempt')
      assert.ok(attempt !== undefined)
      return attempt
    })
  return { run, next, started }
}

const delivered = (lead: Lead): string[] =>
  lead.customMessages(OUTCOME).flatMap(entry => decodeDelivered(entry.details).attempts)

const displayed = async (lead: Lead, command: string) => {
  await lead.session.prompt(command)
  const message = lead.customMessages(INSPECTION).at(-1)
  assert.ok(message !== undefined && typeof message.content === 'string')
  return decodeResult(message.content)
}

const listing = async (lead: Lead, command = '/work') => {
  const { kind, snapshot } = await displayed(lead, command)
  assert.equal(kind, 'snapshot')
  assert.ok(snapshot !== undefined)
  return snapshot
}

const pidOf = async (lead: Lead, id: string): Promise<number> => {
  const { kind, inspection } = await displayed(lead, `/work inspect ${id}`)
  assert.equal(kind, 'inspection')
  assert.ok(inspection !== undefined)
  return decodeRecordPid(inspection.record).pid
}

const readOutcomes = async (lead: Lead, from: number, expected: number): Promise<void> => {
  const settled = () => delivered(lead).length >= expected && lead.session.isIdle
  for (let index = from; ; index += 1) {
    const request = await lead.wait(
      'a continuation or every outcome delivered',
      () => lead.requests[index] ?? (settled() ? null : undefined)
    )
    if (request === null) break
    request.reply(text('outcome read'))
  }
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

const assertWorkGuidance = (
  tool: { readonly description?: string; readonly parameters?: unknown } | undefined,
  limit: number
): void => {
  assert.ok(tool?.description !== undefined)
  const access = decodeParameters(tool.parameters).properties.access?.description ?? ''
  for (const name of [...READ_ONLY_CHILD_TOOLS, ...INTEGRATED_CHILD_TOOLS])
    assert.ok(access.includes(name), name)
  assert.ok(access.includes('no shell, no edits and no gh'))
  assert.ok(access.includes('in the prompt or a workspace file'))
  assert.ok(tool.description.includes('otherwise end your turn and let outcomes resume you'))
  assert.ok(
    tool.description.includes(
      'Do not use sleep, wait loops, or repeated list/inspect calls just to await completion.'
    )
  )
  assert.ok(tool.description.length <= limit, `${tool.description.length} > ${limit}`)
}

try {
  await claim(
    'the lead and coordinator work tools state access limits in the access parameter and non-polling wait guidance in a bounded description',
    () =>
      withLead({}, async lead => {
        const tool = lead.session.getAllTools().find(candidate => candidate.name === 'work')
        assertWorkGuidance(tool, 1500)
        assertWorkGuidance(createCoordinatorWorkTool(unusedLink), 800)
      })
  )

  await claim(
    'every work action returns a structured summary that decodes strictly, equals its text content, and keeps process and workspace facts for inspect',
    async () => {
      const structured: unknown[] = []
      await withLead(
        {
          onToolResult: event => {
            if (event.toolName === 'work') structured.push(event.structuredContent)
          },
        },
        async lead => {
          const held = gate()
          const { run, next, started } = await launch(lead, 0, [held.command, 'true'])
          const [slow, quick] = started
          assert.ok(slow && quick)
          await lead.status('the quick attempt completed', value => value.includes('completed'))
          next.reply([
            toolCall('dispatch', 'work', { action: 'dispatch' }),
            toolCall('list', 'work', { action: 'list' }),
            toolCall('inspect', 'work', { action: 'inspect', id: quick.id }),
            toolCall('page', 'work', {
              action: 'inspect',
              id: quick.id,
              stream: 'stdout',
              offset: 0,
            }),
            toolCall('cancel', 'work', { action: 'cancel', id: slow.id }),
          ])
          const after = await lead.request(2)
          const results = toolResults(after)
            .slice(-5)
            .map(result => decodeResult(result))
          assert.deepEqual(
            results.map(result => result.kind),
            ['dispatch', 'snapshot', 'inspection', 'log', 'attempt']
          )
          const [dispatch, snapshot, inspection, page, cancelled] = results
          assert.equal(dispatch?.dispatch?.configured, true)
          assert.throws(() => decodeStructured({ kind: 'dispatch', dispatch: {} }))
          assert.throws(() =>
            decodeStructured({
              kind: 'dispatch',
              dispatch: { ...dispatch?.dispatch, default: { harness: 'pi', model: 42 } },
            })
          )
          assert.deepEqual(
            snapshot?.snapshot?.records.map(record => record.id).toSorted(),
            [slow.id, quick.id].toSorted()
          )
          assert.equal(inspection?.inspection?.status, 'completed')
          assert.equal(inspection?.inspection?.exitCode, 0)
          assert.equal(typeof decodeRecordPid(inspection?.inspection?.record).pid, 'number')
          assert.equal(inspection?.inspection?.staleArtifact, false)
          assert.deepEqual(
            inspection?.inspection?.logs.map(log => log.stream),
            ['stdout', 'stderr']
          )
          assert.deepEqual(page?.log, {
            stream: 'stdout',
            available: true,
            nextOffset: 0,
            truncated: false,
            text: '',
          })
          assert.equal(cancelled?.attempt?.id, slow.id)
          assert.equal(cancelled?.attempt?.status, 'cancelled')
          assert.deepEqual(
            byKind(structured.slice(-5).map(value => decodeStructured(value))),
            byKind(results)
          )
          after.reply(text('inspected'))
          await readOutcomes(lead, 3, 2)
          await run
          await lead.idle()
          assert.deepEqual(delivered(lead).toSorted(), [slow.id, quick.id].toSorted())
        }
      )
    }
  )

  await claim(
    'a codemode script launches two attempts and receives typed summaries, the work declaration says what scripts receive, and describeTool returns the typed result',
    () =>
      withLead({ tools: ['work', 'codemode'], codemode: true }, async lead => {
        const run = lead.session.prompt('launch from a script')
        const first = await lead.request(0)
        const code = `
const results = await Promise.allSettled([
  tools.work({ action: 'process', taskId: 'script-a', command: 'true' }),
  tools.work({ action: 'process', taskId: 'script-b', command: 'true' }),
])
const declaration = String(await describeTool('work'))
return JSON.stringify({
  typed: declaration.includes('Promise<{') && declaration.includes('kind: "attempt" | "snapshot"'),
  typedDispatch: declaration.includes('dispatch?: { configured: true; default: {') && declaration.includes('rules: { [key: string]: {'),
  launched: results.map(result => result.status === 'fulfilled'
    ? { kind: result.value.kind, id: result.value.attempt?.id, status: result.value.attempt?.status, shape: typeof result.value }
    : { error: String(result.reason) }),
})
`
        first.reply([toolCall('script', 'codemode', { code })])
        const after = await lead.request(1)
        const [scripted] = toolResults(after).slice(-1)
        assert.ok(scripted?.includes('Script completed'), scripted ?? 'no script result')
        const output = /\{"typed".*\}\]\}/s.exec(scripted ?? '')?.[0]
        assert.ok(output !== undefined, scripted ?? 'no script result')
        const { typed, typedDispatch, launched } = Schema.decodeSync(
          Schema.fromJsonString(
            Schema.Struct({
              typed: Schema.Boolean,
              typedDispatch: Schema.Boolean,
              launched: Schema.Array(
                Schema.Struct({
                  kind: Schema.String,
                  id: Schema.String,
                  status: Schema.String,
                  shape: Schema.String,
                })
              ),
            })
          )
        )(output)
        assert.equal(typed, true, 'describeTool shows the typed result')
        assert.equal(typedDispatch, true, 'describeTool shows the dispatch configuration fields')
        assert.equal(launched.length, 2)
        for (const item of launched) {
          assert.equal(item.kind, 'attempt')
          assert.equal(item.shape, 'object')
          assert.ok(['running', 'waiting', 'completed'].includes(item.status), item.status)
        }
        const declared = after.context.messages
          .flatMap(message => (message.role === 'system' ? (message.toolsAdded ?? []) : []))
          .findLast(tool => tool.name === 'work')
        assert.ok(
          declared?.description.includes(
            'Codemode: `tools.work(args)` resolves to `{ kind, attempt?, snapshot?, dispatch?, inspection?, log? }`'
          ),
          declared?.description ?? 'no work tool in the model request'
        )
        after.reply(text('launched from a script'))
        await readOutcomes(lead, 2, 2)
        await run
        await lead.idle()
        assert.deepEqual(delivered(lead).toSorted(), launched.map(item => item.id).toSorted())
      })
  )

  await claim(
    'a shell command that only waits is refused while owned work runs and allowed otherwise',
    () =>
      withLead({ tools: ['work', 'bash'] }, async lead => {
        for (const command of ['sleep 240; echo ok', 'sleep 5', 'sleep 1 && sleep 2\n'])
          assert.ok(waitOnlyCommand(command), command)
        for (const command of ['sleep 1; ls', 'echo ok', 'sleep', 'while true; do sleep 1; done'])
          assert.ok(!waitOnlyCommand(command), command)
        const held = gate()
        const { run, next } = await launch(lead, 0, [held.command])
        const started = Date.now()
        next.reply([toolCall('wait', 'bash', { command: 'sleep 240; echo ok' })])
        const refused = await lead.request(2)
        assert.ok(Date.now() - started < 30_000)
        assert.ok(seen(refused).includes('task-0-0 running'), seen(refused))
        assert.ok(seen(refused).includes('end your turn now'), seen(refused))
        refused.reply([toolCall('mixed', 'bash', { command: 'sleep 0; echo waiting' })])
        const mixed = await lead.request(3)
        assert.ok(seen(mixed).includes('Refused'), seen(mixed))
        mixed.reply([toolCall('work', 'bash', { command: 'sleep 0; ls -d .' })])
        const allowed = await lead.request(4)
        assert.ok(!seen(allowed).includes('Refused'), seen(allowed))
        allowed.reply(text('waiting for outcomes'))
        await run
        await lead.idle()
        held.open()
        const continued = await lead.request(5)
        assert.ok(seen(continued).includes('completed'), seen(continued))
        continued.reply([toolCall('idle', 'bash', { command: 'sleep 0; echo idle-ok' })])
        const idle = await lead.request(6)
        assert.ok(seen(idle).includes('idle-ok'), seen(idle))
        idle.reply(text('done'))
        await lead.idle()
      })
  )

  await claim('a codemode script cannot wait through nested bash while owned work runs', () =>
    withLead({ tools: ['work', 'bash', 'codemode'], codemode: true }, async lead => {
      const held = gate()
      const { run, next } = await launch(lead, 0, [held.command])
      const started = Date.now()
      const code = "return await tools.bash({ command: 'sleep 240; echo ok' })"
      next.reply([toolCall('script', 'codemode', { code })])
      const refused = await lead.request(2)
      assert.ok(Date.now() - started < 30_000)
      assert.ok(seen(refused).includes('Script failed'), seen(refused))
      assert.ok(seen(refused).includes('task-0-0 running'), seen(refused))
      refused.reply(text('waiting for outcomes'))
      await run
      await lead.idle()
      held.open()
      const continued = await lead.request(3)
      continued.reply(text('done'))
      await lead.idle()
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
        const [outcome] = lead.customMessages(OUTCOME)
        assert.ok(outcome !== undefined && typeof outcome.content === 'string')
        const [item] = outcomeItems(outcome.content)
        assert.ok(item !== undefined)
        assert.equal(item.id, attempt.id)
        assert.equal(item.status, 'completed')
        assert.equal(item.exitCode, 0)
        assert.equal(item.staleArtifact, false)
        assert.deepEqual(
          item.logs.map(log => [log.stream, log.available, log.text]),
          [
            ['stdout', true, ''],
            ['stderr', true, ''],
          ]
        )
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
      assert.deepEqual(
        (await listing(lead)).records.map(record => [record.id, record.status]),
        [[attempt.id, 'completed']]
      )
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
        const [onePid, otherPid] = [await pidOf(lead, one.id), await pidOf(lead, other.id)]
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
        assert.equal(alive(onePid), false)
        assert.equal(alive(otherPid), true)
        const stopped = await listing(lead, '/work stop')
        assert.equal(stopped.cancellationRequested, true)
        assert.deepEqual(
          stopped.records.map(record => record.status),
          ['cancelled', 'cancelled']
        )
        assert.equal(alive(otherPid), false)
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
      next.reply(text('launched'))
      await run
      await lead.idle()
      assert.equal(alive(await pidOf(lead, attempt.id)), false)
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
    const pid = await pidOf(lead, attempt.id)
    assert.equal(alive(pid), true)
    await lead.close()
    assert.equal(alive(pid), false)
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
