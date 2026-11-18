import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
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
  AttemptFactsSchema,
  AttemptOutcomeSchema,
  INTEGRATED_CHILD_TOOLS,
  READ_ONLY_CHILD_TOOLS,
  WorkResultSchema,
  type WorkResult,
} from '../../src/work-domain.ts'
import { workResultText } from '../../src/work-model-text.ts'
import { emptyWorkView, type WorkView } from '../../src/work-view.ts'
import { leadingLongSleep, waitOnlyCommand } from '../../src/work-wait-guard.ts'
import { openWorkFixture, script } from './work-check-support.ts'
import { holdsFor } from '../wait.ts'
import {
  CHILD_EFFORT,
  CHILD_MODEL,
  RAW_AFTER_READY_MARKER,
  USAGE_MARKER,
} from './work-child-model.ts'
import { openLead, type Lead, type LeadRequest } from './work-extension-support.ts'

const OUTCOME = 'dev/work-outcome'
const INSPECTION = 'dev/work-inspection'
const QUIET = 'dev/work-quiet'

const installed = await loadInstalledPi()
const { claim, passed } = makeClaims()
const fixture = await openWorkFixture('work-extension')
process.env.PI_CODING_AGENT_DIR = fixture.agentDir

const ModelAttemptSchema = Schema.Struct({
  id: Schema.String,
  taskId: Schema.String,
  kind: Schema.Literals(['process', 'agent']),
  status: Schema.String,
  parent: Schema.optionalKey(Schema.String),
  coordinator: Schema.optionalKey(Schema.Literal(true)),
  exitCode: Schema.optionalKey(Schema.Int),
  error: Schema.optionalKey(Schema.String),
  worktree: Schema.optionalKey(Schema.Struct({ path: Schema.String, cleanup: Schema.String })),
})
const strict = { onExcessProperty: 'error' } as const
const decodeModelAttempt = Schema.decodeUnknownSync(
  Schema.fromJsonString(ModelAttemptSchema),
  strict
)
const decodeStructured = Schema.decodeUnknownSync(WorkResultSchema, strict)
const decodeDelivered = Schema.decodeUnknownSync(
  Schema.Struct({ attempts: Schema.Array(Schema.String) })
)
const decodeOutcomeDetails = Schema.decodeUnknownSync(
  Schema.Struct({
    attempts: Schema.Array(Schema.String),
    children: Schema.Array(AttemptFactsSchema),
    outcomes: Schema.Array(AttemptOutcomeSchema),
  }),
  strict
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
    path,
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
const modelEntries = (content: string): unknown =>
  JSON.parse(content.slice(content.indexOf('\n') + 1))
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
    .map(result => decodeModelAttempt(result))
  return { run, next, started, from: lead.views.length }
}

const delivered = (lead: Lead): string[] =>
  lead.customMessages(OUTCOME).flatMap(entry => decodeDelivered(entry.details).attempts)

const displayed = async (lead: Lead, command: string) => {
  await lead.session.prompt(command)
  const message = lead.customMessages(INSPECTION).at(-1)
  assert.ok(message !== undefined)
  const result = decodeStructured(message.details)
  assert.equal(message.content, workResultText(result))
  return result
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

const QUIET_AFTER_MS = 1200
const sentQuiet = (lead: Lead) => lead.customMessages(QUIET)
const quietIn = (request: LeadRequest): boolean =>
  JSON.stringify(request.context.messages).includes('Quiet commands: still running')
const quietView = (lead: Lead, quiet: boolean, from = 0) =>
  lead.view(
    quiet ? 'a quiet command' : 'no quiet command',
    view => view.commands.quiet.length > 0 === quiet,
    from
  )
const noRequestBeyond = (lead: Lead, count: number): Promise<void> =>
  holdsFor(
    `no request beyond ${count}`,
    QUIET_AFTER_MS * 2,
    () => lead.requests.length === count,
    50
  )

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
  const { properties } = decodeParameters(tool.parameters)
  assert.ok(properties.skill?.description?.includes('dispatch rule'), 'skill parameter')
  assert.equal(properties.rule, undefined, 'rule parameter')
  assert.ok(!(properties.prompt?.description ?? '').includes('/skill:'), 'prompt description')
  const access = properties.access?.description ?? ''
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
  await claim('a corrupt store shows a safe reset command without extension errors', async () => {
    const dataHome = join(fixture.root, "corrupt data's $home")
    const workRoot = join(dataHome, 'work')
    mkdirSync(workRoot, { recursive: true })
    const database = join(workRoot, 'attempts.sqlite')
    const garbage = Buffer.from('not a database '.repeat(512))
    writeFileSync(database, garbage)
    const lead = await openLead(installed, { ...fixture, dataHome })
    try {
      assert.deepEqual(lead.handlerErrors, [])
      assert.equal(lead.notices.length, 1)
      const [notice] = lead.notices
      assert.equal(notice?.level, 'error')
      const message = notice?.message ?? ''
      assert.match(message, /^Work store database is corrupt\. Work is unavailable\./)
      assert.match(message, /Stop all dev sessions and maintenance operations/)
      assert.match(message, /Restart dev/)
      assert.match(message, /deletes stored work attempts and their logs and results/)
      assert.doesNotMatch(message, /\n\s+at |file:\/\//)
      const command = message
        .split('\n')
        .find(line => line.startsWith('2. Run: '))
        ?.slice(8)
      assert.ok(command)
      const argumentsReadBack = execFileSync('bash', [
        '-c',
        `rm() { printf '%s\\0' "$@"; }; ${command}`,
      ])
        .toString()
        .split('\0')
        .slice(0, -1)
      assert.deepEqual(argumentsReadBack, [
        '-rf',
        '--',
        database,
        `${database}-wal`,
        `${database}-shm`,
        `${database}-journal`,
        join(workRoot, 'attempts'),
      ])
      const run = lead.session.prompt('list background work')
      const request = await lead.request(0)
      request.reply([toolCall('unavailable-work', 'work', { action: 'list' })])
      const next = await lead.request(1)
      assert.ok(toolResults(next).some(result => result.includes(message)))
      next.reply(text('work unavailable'))
      await run
      assert.deepEqual(lead.handlerErrors, [])
      assert.deepEqual(readFileSync(database), garbage)
    } finally {
      await lead.close()
    }
    assert.deepEqual(lead.handlerErrors, [])
  })
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
    'a delegation carrying the removed rule field is refused as an unknown property before any attempt starts',
    () =>
      withLead({}, async lead => {
        const run = lead.session.prompt('delegate with a legacy field')
        const first = await lead.request(0)
        first.reply([
          toolCall('legacy', 'work', {
            action: 'delegate',
            taskId: 'legacy',
            prompt: 'Review nothing',
            rule: 'default',
          }),
        ])
        const after = await lead.request(1)
        const [refused] = toolResults(after).slice(-1)
        assert.match(refused ?? '', /- rule: unknown field/)
        after.reply(text('refused'))
        await run
        assert.deepEqual((await listing(lead)).records, [])
      })
  )

  await claim(
    'every work action returns a structured result that decodes strictly and keeps process and workspace facts, while the model reads its compact projection',
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
          const { run, next, started, from } = await launch(lead, 0, [held.command, 'true'])
          const [slow, quick] = started
          assert.ok(slow && quick)
          await lead.view('the quick attempt completed', view => view.commands.running === 1, from)
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
          const texts = toolResults(after).slice(-5)
          const results = byKind(structured.slice(-5).map(value => decodeStructured(value)))
          assert.deepEqual(
            results.map(result => result.kind),
            ['attempt', 'dispatch', 'inspection', 'log', 'snapshot']
          )
          assert.deepEqual(texts.toSorted(), results.map(workResultText).toSorted())
          const [cancelled, dispatch, inspection, page, snapshot] = results
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
            nextOffset: null,
            truncated: false,
            text: '',
          })
          assert.equal(cancelled?.attempt?.id, slow.id)
          assert.equal(cancelled?.attempt?.status, 'cancelled')
          const [shownCancel, shownDispatch, shownInspection, shownPage, shownList] = [
            cancelled,
            dispatch,
            inspection,
            page,
            snapshot,
          ].map(result => JSON.parse(result === undefined ? '{}' : workResultText(result)))
          assert.deepEqual(Object.keys(shownDispatch), ['default', 'rules'])
          assert.deepEqual(shownPage, { text: '', nextOffset: null })
          assert.equal(shownCancel.id, slow.id)
          assert.equal(shownCancel.status, 'cancelled')
          assert.deepEqual(Object.keys(shownList), ['records', 'nextOffset'])
          for (const record of shownList.records) decodeModelAttempt(JSON.stringify(record))
          assert.equal(shownInspection.workflowTaskId, inspection?.inspection?.workflowTaskId)
          assert.equal(shownInspection.cwd, inspection?.inspection?.cwd)
          for (const hidden of ['record', 'logs', 'completedAt', 'usage'])
            assert.equal(hidden in shownInspection, false, hidden)
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
        assert.ok(declared !== undefined, 'no work tool in the model request')
        for (const fragment of [
          'Codemode: `tools.work(args)` resolves to `{ kind,',
          'attempt?',
          'snapshot?',
          'dispatch?',
          'inspection?',
          'log?',
        ])
          assert.ok(declared.description.includes(fragment), declared.description)
        after.reply(text('launched from a script'))
        await readOutcomes(lead, 2, 2)
        await run
        await lead.idle()
        assert.deepEqual(delivered(lead).toSorted(), launched.map(item => item.id).toSorted())
      })
  )

  await claim(
    'a shell command that only waits is refused while owned work runs and allowed otherwise, and a leading long sleep is refused even while idle',
    () =>
      withLead({ tools: ['work', 'bash'] }, async lead => {
        for (const command of ['sleep 240; echo ok', 'sleep 5', 'sleep 1 && sleep 2\n'])
          assert.ok(waitOnlyCommand(command), command)
        for (const command of ['sleep 1; ls', 'echo ok', 'sleep', 'while true; do sleep 1; done'])
          assert.ok(!waitOnlyCommand(command), command)
        for (const command of [
          'sleep 240; /tmp/ds.sh',
          'sleep 30',
          'sleep 1m && ls',
          'sleep 20 15; ls',
        ])
          assert.ok(leadingLongSleep(command), command)
        for (const command of [
          'sleep 29; curl https://example.test',
          'ls; sleep 240',
          'for i in 1 2; do sleep 30; done',
          'node app & pid=$!; sleep 8; kill $pid',
          'sleep x; ls',
        ])
          assert.ok(!leadingLongSleep(command), command)
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
        continued.reply([toolCall('long', 'bash', { command: 'sleep 240; ls' })])
        const long = await lead.request(6)
        assert.ok(seen(long).includes('Refused'), seen(long))
        assert.ok(seen(long).includes('work process'), seen(long))
        assert.ok(seen(long).includes('until <check>; do sleep 30; done'), seen(long))
        assert.ok(!seen(long).includes('task-0-0'), seen(long))
        long.reply([toolCall('idle', 'bash', { command: 'sleep 0; echo idle-ok' })])
        const idle = await lead.request(7)
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
      continued.reply([
        toolCall('long', 'codemode', {
          code: "return await tools.bash({ command: 'sleep 240; ls' })",
        }),
      ])
      const long = await lead.request(4)
      assert.ok(seen(long).includes('Script failed'), seen(long))
      assert.ok(seen(long).includes('work process'), seen(long))
      long.reply(text('done'))
      await lead.idle()
    })
  )

  await claim(
    'outcomes arrive when the current run settles and an eligible batch continues a successful lead run without another user message',
    () =>
      withLead({}, async lead => {
        const { run, next, started, from } = await launch(lead, 0, ['true'])
        const [attempt] = started
        assert.ok(attempt)
        await lead.view('the process completed', view => view.commands.running === 0, from)
        for (const view of lead.views) {
          assert.equal(view.sessionId, lead.manager.getSessionId())
          assert.deepEqual(view.children, [])
        }
        assert.deepEqual(delivered(lead), [])
        next.reply(text('launched'))
        const continued = await lead.request(2)
        assert.ok(seen(continued).includes(attempt.id) && seen(continued).includes('completed'))
        assert.deepEqual(delivered(lead), [attempt.id])
        const [outcome] = lead.customMessages(OUTCOME)
        assert.ok(outcome !== undefined && typeof outcome.content === 'string')
        const details = decodeOutcomeDetails(outcome.details)
        const [item] = details.outcomes
        assert.ok(item !== undefined)
        assert.deepEqual(details.attempts, [attempt.id])
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
        const [facts] = details.children
        assert.equal(facts?.kind, 'process')
        assert.equal(typeof facts?.startedAt, 'number')
        assert.equal(typeof facts?.completedAt, 'number')
        assert.ok(
          outcome.content.startsWith('Work outcomes: producer observations, not verification.')
        )
        assert.deepEqual(modelEntries(outcome.content), [
          { id: attempt.id, taskId: 'task-0-0', kind: 'process', status: 'completed', exitCode: 0 },
        ])
        continued.reply(text('outcome read'))
        await run
        await lead.idle()
        await userTurn(lead, 3, 'unrelated question')
        assert.deepEqual(delivered(lead), [attempt.id])
        assert.equal(lead.requests.length, 4)
      })
  )

  await claim(
    'the live view shows a delegated child from launch through coalesced activity to settlement and keeps it until the next owner message, while requested selection stays out of model text',
    async () => {
      const launched: unknown[] = []
      await withLead(
        {
          children: true,
          onToolResult: event => {
            if (event.toolName === 'work') launched.push(event.structuredContent)
          },
        },
        async lead => {
          const burst = Array.from({ length: 30 }, (_, index) => ({
            type: 'activity',
            turns: index + 1,
            activity: { kind: 'tool', name: 'read', target: `file-${index}.md` },
          }))
          const run = lead.session.prompt('delegate a look around')
          const first = await lead.request(0)
          first.reply([
            toolCall('look', 'work', {
              action: 'delegate',
              taskId: 'look-around',
              prompt: [
                'Look around',
                `${RAW_AFTER_READY_MARKER}${JSON.stringify(burst)}`,
                `${USAGE_MARKER}${JSON.stringify({ input: 10, output: 5 })}`,
                script([{ delayMs: 1500, content: [{ type: 'text', text: 'LOOKED' }] }]),
              ].join('\n'),
              model: CHILD_MODEL,
              effort: CHILD_EFFORT,
            }),
          ])
          const next = await lead.request(1)
          const [shown] = toolResults(next).slice(-1)
          const attempt = decodeModelAttempt(shown)
          assert.equal(attempt.status, 'running')
          assert.ok(!(shown ?? '').includes('requested') && !(shown ?? '').includes(CHILD_MODEL))
          const [result] = launched.map(value => decodeStructured(value))
          assert.equal(result?.attempt?.requested?.model, CHILD_MODEL)
          const child = (view: WorkView) => view.children.find(item => item.id === attempt.id)
          const active = await lead.view(
            'the last activity level',
            view => child(view)?.turns === 30
          )
          assert.deepEqual(child(active)?.activity, {
            kind: 'tool',
            name: 'read',
            target: 'file-29.md',
          })
          assert.equal(child(active)?.taskId, 'look-around')
          assert.equal(child(active)?.model, CHILD_MODEL)
          assert.equal(child(active)?.coordinator, false)
          assert.equal(child(active)?.access, 'read-only')
          const ticks = lead.views.filter(view => (child(view)?.turns ?? 0) > 0).length
          assert.ok(ticks <= 5, `${ticks} views for a burst of 30 activity messages`)
          next.reply(text('launched'))
          await run
          await lead.idle()
          const continued = await lead.request(2)
          assert.ok(seen(continued).includes('LOOKED'), seen(continued))
          continued.reply(text('outcome read'))
          await lead.idle()
          const settledView = await lead.view(
            'the child settled',
            view => child(view)?.status === 'completed'
          )
          const done = child(settledView)
          assert.equal(done?.activity, undefined)
          assert.equal(typeof done?.completedAt, 'number')
          const [outcome] = lead.customMessages(OUTCOME)
          assert.ok(outcome !== undefined && typeof outcome.content === 'string')
          const [facts] = decodeOutcomeDetails(outcome.details).children
          assert.equal(facts?.turns, 1)
          assert.equal(done?.turns, 1)
          assert.equal(typeof facts?.toolUses, 'number')
          assert.equal(typeof facts?.effort, 'string')
          assert.equal(facts?.completedAt, done?.completedAt)
          assert.deepEqual(modelEntries(outcome.content), [
            {
              id: attempt.id,
              taskId: 'look-around',
              kind: 'agent',
              status: 'completed',
              exitCode: 0,
              result: 'LOOKED',
            },
          ])
          assert.ok(child(lead.views.at(-1) ?? emptyWorkView('')) !== undefined)
          await userTurn(lead, 3, 'unrelated question')
          await lead.view('the batch closed', view => view.children.length === 0)
        }
      )
    }
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

  await claim(
    'a completed turn that leaves a command running will be reactivated until the turn its outcome starts, and no longer once that turn settles',
    async () => {
      const samples: { readonly resting: boolean; readonly answer: boolean }[] = []
      let sampled: Lead | undefined
      const takeSample = (): void => {
        if (sampled !== undefined)
          samples.push({
            resting: sampled.session.isIdle,
            answer: sampled.work.willReactivate(),
          })
      }
      await withLead(
        {
          onReactivationChange: () => {
            takeSample()
            setImmediate(takeSample)
          },
        },
        async lead => {
          sampled = lead
          assert.equal(lead.work.willReactivate(), false)
          const held = gate()
          const { run, next } = await launch(lead, 0, [held.command])
          next.reply(text('launched'))
          await run
          await lead.idle()
          assert.equal(lead.work.willReactivate(), true)
          const opened = samples.length
          held.open()
          const continued = await lead.request(2)
          const untilContinuation = samples.slice(opened)
          assert.ok(untilContinuation.length > 0, 'the outcome notified no listener')
          assert.deepEqual(
            untilContinuation.filter(sample => sample.resting && !sample.answer),
            []
          )
          continued.reply(text('outcome read'))
          await lead.idle()
          assert.equal(lead.work.willReactivate(), false)
          sampled = undefined
        }
      )
    }
  )

  await claim(
    'a silent command wakes a resting lead on a warm cache once, with its runtime, quiet time and latest output',
    () =>
      withLead({ quietAfterMs: QUIET_AFTER_MS }, async lead => {
        const held = gate()
        const { run, next, started } = await launch(lead, 0, [
          `echo before-silence; ${held.command}`,
        ])
        const [attempt] = started
        assert.ok(attempt)
        next.reply(text('launched'))
        await run
        await lead.idle()
        const woken = await lead.request(2)
        assert.ok(quietIn(woken), seen(woken))
        const [notice] = sentQuiet(lead)
        assert.ok(notice !== undefined)
        const [entry] = modelEntries(String(notice.content)) as {
          id: string
          taskId: string
          stdout?: string
          quietSeconds: number
          runningSeconds: number
        }[]
        assert.ok(entry !== undefined)
        assert.equal(entry.id, attempt.id)
        assert.equal(entry.taskId, 'task-0-0')
        assert.ok(entry.stdout?.includes('before-silence'))
        assert.ok(entry.runningSeconds >= entry.quietSeconds)
        const [facts] = (
          notice.details as {
            quiet: {
              id: string
              taskId: string
              kind: string
              status: string
              since: number
              quietSeconds: number
              runningSeconds: number
              logs: { stream: string; text?: string }[]
            }[]
          }
        ).quiet
        assert.ok(facts !== undefined)
        assert.deepEqual(
          { id: facts.id, taskId: facts.taskId, kind: facts.kind, status: facts.status },
          { id: attempt.id, taskId: 'task-0-0', kind: 'process', status: 'running' }
        )
        assert.equal(facts.quietSeconds, entry.quietSeconds)
        assert.equal(facts.runningSeconds, entry.runningSeconds)
        assert.ok(Number.isFinite(facts.since) && facts.since <= Date.now())
        assert.ok(
          facts.logs.find(page => page.stream === 'stdout')?.text?.includes('before-silence')
        )
        woken.reply(text('keep waiting'))
        await lead.idle()
        assert.deepEqual(lead.work.restingState(), { state: 'working' })
        await noRequestBeyond(lead, 3)
        held.open()
        await readOutcomes(lead, 3, 1)
        assert.equal(sentQuiet(lead).length, 1)
        assert.deepEqual(delivered(lead), [attempt.id])
      })
  )

  await claim('a command that goes quiet during a run reaches that run at its next step', () =>
    withLead({ quietAfterMs: QUIET_AFTER_MS }, async lead => {
      const held = gate()
      const { run, next, from } = await launch(lead, 0, [held.command])
      let settled = false
      void run.then(() => {
        settled = true
      })
      await quietView(lead, true, from)
      next.reply(text('still working'))
      const continued = await lead.request(2)
      assert.ok(quietIn(continued), seen(continued))
      assert.equal(settled, false, 'the notice continued the same run')
      continued.reply(text('keep waiting'))
      await run
      await lead.idle()
      await noRequestBeyond(lead, 3)
      held.open()
      await readOutcomes(lead, 3, 1)
      assert.equal(sentQuiet(lead).length, 1)
    })
  )

  await claim(
    'a notice waiting for the next step is dropped when its command prints again before it',
    () =>
      withLead({ quietAfterMs: QUIET_AFTER_MS }, async lead => {
        const first = gate()
        const second = gate()
        const ticking = `while [ ! -e '${second.path}' ]; do echo tick; sleep 0.2; done`
        const { run, next, from } = await launch(lead, 0, [`${first.command}; ${ticking}`])
        await quietView(lead, true, from)
        const resumedFrom = lead.views.length
        first.open()
        await quietView(lead, false, resumedFrom)
        next.reply(text('still working'))
        await run
        await lead.idle()
        await noRequestBeyond(lead, 2)
        second.open()
        await readOutcomes(lead, 2, 1)
        assert.deepEqual(sentQuiet(lead), [])
        assert.ok(!lead.requests.some(quietIn))
      })
  )

  await claim(
    'on a cold cache a quiet command starts no model request, reports blocked over working, and joins the next user turn',
    () =>
      withLead(
        { quietAfterMs: QUIET_AFTER_MS, now: () => Date.now() + 10 * 60 * 1000 },
        async lead => {
          const held = gate()
          const { run, next, from } = await launch(lead, 0, [held.command])
          next.reply(text('launched'))
          await run
          await lead.idle()
          await quietView(lead, true, from)
          await noRequestBeyond(lead, 2)
          assert.equal(lead.work.willReactivate(), true)
          assert.deepEqual(lead.work.restingState(), {
            state: 'blocked',
            message: 'Quiet command: task-0-0',
          })
          const turn = lead.session.prompt('what is happening?')
          const request = await lead.request(2)
          const messages = JSON.stringify(request.context.messages)
          assert.ok(messages.includes('what is happening?'))
          assert.ok(quietIn(request), messages)
          request.reply(text('a command is quiet'))
          await turn
          await lead.idle()
          assert.deepEqual(lead.work.restingState(), { state: 'working' })
          held.open()
          await readOutcomes(lead, 3, 1)
          assert.equal(sentQuiet(lead).length, 1)
        }
      )
  )

  await claim(
    'a later silence of a command that already reached the model is reported only to the user',
    () =>
      withLead({ quietAfterMs: QUIET_AFTER_MS }, async lead => {
        const first = gate()
        const second = gate()
        const { run, next, from } = await launch(lead, 0, [
          `${first.command}; echo resumed; ${second.command}`,
        ])
        next.reply(text('launched'))
        await run
        await lead.idle()
        const woken = await lead.request(2)
        assert.ok(quietIn(woken))
        woken.reply(text('keep waiting'))
        await lead.idle()
        const resumedFrom = lead.views.length
        first.open()
        await quietView(lead, false, resumedFrom)
        assert.deepEqual(lead.work.restingState(), { state: 'working' })
        await quietView(lead, true, lead.views.length)
        await noRequestBeyond(lead, 3)
        assert.deepEqual(lead.work.restingState(), {
          state: 'blocked',
          message: 'Quiet command: task-0-0',
        })
        assert.ok(from < resumedFrom)
        second.open()
        await readOutcomes(lead, 3, 1)
        assert.equal(sentQuiet(lead).length, 1)
        assert.deepEqual(lead.work.restingState(), { state: 'done' })
      })
  )

  await claim(
    'a refused quiet notice is held for the next run without spending the command allowance',
    async () => {
      let refusals = 1
      await withLead(
        {
          quietAfterMs: QUIET_AFTER_MS,
          send: deliver => (message, options) => {
            if (message.customType !== QUIET || refusals === 0) return deliver(message, options)
            refusals -= 1
            return Promise.reject(new Error('conversation transport down'))
          },
        },
        async lead => {
          const held = gate()
          const { run, next } = await launch(lead, 0, [held.command])
          next.reply(text('launched'))
          await run
          await lead.idle()
          await lead.wait('the refused notice to be reported', () => lead.notices[0])
          assert.deepEqual(lead.notices, [
            { message: 'Background work: conversation transport down', level: 'error' },
          ])
          assert.deepEqual(lead.work.restingState(), {
            state: 'blocked',
            message: 'Quiet command: task-0-0',
          })
          assert.equal(lead.requests.length, 2)
          const turn = lead.session.prompt('anything new?')
          const request = await lead.request(2)
          assert.ok(quietIn(request))
          request.reply(text('a command is quiet'))
          await turn
          await lead.idle()
          assert.equal(sentQuiet(lead).length, 1)
          held.open()
          await readOutcomes(lead, 3, 1)
        }
      )
    }
  )

  await claim(
    'when a delayed send is refused after the command resumed and fell silent again, only the newer notice reaches the next run',
    async () => {
      let refuse: ((cause: Error) => void) | undefined
      await withLead(
        {
          quietAfterMs: QUIET_AFTER_MS,
          send: deliver => (message, options) => {
            if (message.customType !== QUIET || refuse !== undefined)
              return deliver(message, options)
            return new Promise<void>((_resolve, reject) => {
              refuse = reject
            })
          },
        },
        async lead => {
          const first = gate()
          const second = gate()
          const { run, next } = await launch(lead, 0, [
            `${first.command}; echo resumed; ${second.command}`,
          ])
          next.reply(text('launched'))
          await run
          await lead.idle()
          const pendingSend = await lead.wait('the first notice to be sent', () => refuse)
          const resumedFrom = lead.views.length
          first.open()
          await quietView(lead, false, resumedFrom)
          await quietView(lead, true, lead.views.length)
          pendingSend(new Error('conversation transport down'))
          await lead.wait('the refused send to be reported', () => lead.notices[0])
          assert.equal(lead.requests.length, 2)
          assert.equal(lead.work.restingState().state, 'blocked')
          const turn = lead.session.prompt('anything new?')
          const request = await lead.request(2)
          assert.ok(quietIn(request))
          request.reply(text('a command is quiet'))
          await turn
          await lead.idle()
          const [notice] = sentQuiet(lead)
          assert.equal(sentQuiet(lead).length, 1)
          const [entry] = modelEntries(String(notice?.content)) as { stdout?: string }[]
          assert.ok(entry?.stdout?.includes('resumed'), 'the newer silence was delivered')
          second.open()
          await readOutcomes(lead, 3, 1)
        }
      )
    }
  )

  await claim(
    'a wake that fails after its notice reached the model still spends the command allowance',
    () =>
      withLead({ quietAfterMs: QUIET_AFTER_MS }, async lead => {
        const first = gate()
        const second = gate()
        const { run, next } = await launch(lead, 0, [
          `${first.command}; echo resumed; ${second.command}`,
        ])
        next.reply(text('launched'))
        await run
        await lead.idle()
        const woken = await lead.request(2)
        assert.ok(quietIn(woken))
        let armed = true
        const unsubscribe = lead.session.subscribe(event => {
          if (event.type !== 'agent_settled' || !armed) return
          armed = false
          throw new Error('settlement listener failed')
        })
        try {
          const resumedFrom = lead.views.length
          first.open()
          await quietView(lead, false, resumedFrom)
          await quietView(lead, true, lead.views.length)
          woken.reply(text('keep waiting'))
          await lead.wait('the late rejection to be reported', () => lead.notices[0])
        } finally {
          unsubscribe()
        }
        await lead.idle()
        assert.deepEqual(lead.work.restingState(), {
          state: 'blocked',
          message: 'Quiet command: task-0-0',
        })
        await userTurn(lead, 3, 'anything new?')
        assert.equal(sentQuiet(lead).length, 1, 'the newer silence stayed with the user')
        second.open()
        await readOutcomes(lead, 4, 1)
      })
  )

  await claim(
    'a held notice is discarded when its command settles first, and its outcome carries no quiet notice',
    () =>
      withLead(
        { quietAfterMs: QUIET_AFTER_MS, now: () => Date.now() + 10 * 60 * 1000 },
        async lead => {
          const held = gate()
          const { run, next, started, from } = await launch(lead, 0, [held.command])
          const [attempt] = started
          assert.ok(attempt)
          next.reply(text('launched'))
          await run
          await lead.idle()
          await quietView(lead, true, from)
          assert.equal(lead.work.restingState().state, 'blocked')
          held.open()
          await readOutcomes(lead, 2, 1)
          assert.deepEqual(delivered(lead), [attempt.id])
          assert.deepEqual(sentQuiet(lead), [])
          assert.ok(!lead.requests.some(quietIn))
          assert.deepEqual(lead.work.restingState(), { state: 'done' })
        }
      )
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
    'subscription exhaustion blocks new agents until a lead run started after it completes, which then continues with pending outcomes and restores retries',
    () =>
      withLead({}, async lead => {
        const settings = lead.session.settingsManager
        settings.applyOverrides({ retry: { enabled: true } })
        const held = gate()
        const { run, next, started } = await launch(lead, 0, [held.command])
        const [attempt] = started
        assert.ok(attempt)
        next.fail('Claude quota exceeded: rate limit (five_hour), resets 22:00:00')
        await run
        await lead.idle()
        assert.equal(settings.getRetryEnabled(), false)
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
        await lead.view('agents blocked', view => view.blocks.agentsBlocked)
        const opened = lead.views.length
        held.open()
        await lead.view('the process completed', view => view.commands.running === 0, opened)
        refused.reply(text('finished'))
        const continued = await lead.request(4)
        assert.ok(seen(continued).includes(attempt.id), seen(continued))
        continued.reply(text('outcome read'))
        await again
        await lead.idle()
        assert.equal(settings.getRetryEnabled(), true)
        assert.deepEqual(delivered(lead), [attempt.id])
      })
  )

  await claim('choosing another lead model lifts the exhaustion block and restores retries', () =>
    withLead({}, async lead => {
      const settings = lead.session.settingsManager
      settings.applyOverrides({ retry: { enabled: true } })
      const run = lead.session.prompt('start')
      const first = await lead.request(0)
      first.fail('Claude quota exceeded: rate limit (five_hour), resets 22:00:00')
      await run
      await lead.idle()
      await lead.view('agents blocked', view => view.blocks.agentsBlocked)
      assert.equal(settings.getRetryEnabled(), false)
      const { model } = lead.session
      assert.ok(model !== undefined)
      const from = lead.views.length
      await lead.session.setModel({ ...model, id: `${model.id}-other` })
      await lead.view('agents unblocked', view => !view.blocks.agentsBlocked, from)
      assert.equal(settings.getRetryEnabled(), true)
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
        assert.equal(lead.work.willReactivate(), false)
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
      const { run, next, started, from } = await launch(lead, 0, ['true'])
      const [attempt] = started
      assert.ok(attempt)
      await lead.view('the process completed', view => view.commands.running === 0, from)
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

  await claim(
    'the live view counts running local commands without rows and follows each change to the final state',
    () =>
      withLead({}, async lead => {
        const held = gate()
        const { run, next, from } = await launch(lead, 0, [held.command, 'true'])
        await lead.view('one command still running', view => view.commands.running === 1, from)
        const opened = lead.views.length
        held.open()
        await lead.view('every command completed', view => view.commands.running === 0, opened)
        next.reply(text('launched'))
        ;(await lead.request(2)).reply(text('outcome read'))
        await run
        await lead.idle()
        await userTurn(lead, 3, 'unrelated question')
        assert.deepEqual(lead.views.at(-1), emptyWorkView(lead.manager.getSessionId()))
        assert.ok(lead.views.every(view => view.children.length === 0))
        assert.ok(lead.views.length < 40, `${lead.views.length} views`)
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
      const typed = lead.views.length
      lead.typeTerminal('\u001b')
      await lead.view('the attempt cancelled', view => view.commands.running === 0, typed)
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
    const sessionId = lead.manager.getSessionId()
    await lead.close()
    assert.equal(alive(pid), false)
    assert.deepEqual(lead.views.at(-1), emptyWorkView(sessionId))
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
        'Offline scripted lead in a real Pi session; background work is local commands and one scripted child, no live model',
    },
    null,
    2
  )
)
