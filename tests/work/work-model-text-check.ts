import assert from 'node:assert/strict'
import * as Effect from 'effect/Effect'
import { createCoordinatorWorkTool } from '../../src/work-child-coordination.ts'
import {
  asAttemptId,
  type AttemptOutcome,
  type AttemptSummary,
  type LogView,
  type WorkResult,
} from '../../src/work-domain.ts'
import { outcomeText, outputPreview, workResultText } from '../../src/work-model-text.ts'
import { makeClaims } from '../workspace/workspace-check-support.ts'

const { claim, passed } = makeClaims()

const ID = asAttemptId('00000000-0000-0000-0000-000000000001')
const PARENT = asAttemptId('00000000-0000-0000-0000-000000000002')
const WORKTREE = '/Users/owner/Library/Application Support/dev/worktrees/task/workspace'

const summary = (fields: Partial<AttemptSummary> = {}): AttemptSummary => ({
  id: ID,
  taskId: 'review',
  workflowTaskId: 'workflow-task',
  workspaceId: 'workspace',
  cwd: '/repo',
  kind: 'agent',
  status: 'running',
  access: 'read-only',
  model: 'anthropic/claude-opus-5-5',
  invokedSkill: 'code-review',
  context: { tokens: 1000, contextWindow: 200_000, percent: 0.5 },
  usage: { total: 1000, cost: 0.01 },
  requested: { model: 'anthropic/claude-opus-5-5', effort: 'high' },
  ...fields,
})

const log = (fields: Partial<LogView> & Pick<LogView, 'stream'>): LogView => ({
  available: true,
  text: '',
  truncated: false,
  nextOffset: null,
  ...fields,
})

const outcome = (fields: Partial<AttemptOutcome> = {}): AttemptOutcome => ({
  ...summary({ status: 'completed', exitCode: 0, completedAt: 10 }),
  staleArtifact: false,
  logs: [],
  ...fields,
})

const parse = (text: string): unknown => JSON.parse(text)
const entries = (text: string): unknown => parse(text.slice(text.indexOf('\n') + 1))

await claim(
  'launch and cancel results are the flat attempt object without envelope, identities, telemetry or requested selection',
  () => {
    const text = workResultText({ kind: 'attempt', attempt: summary() })
    assert.equal(text, JSON.stringify(parse(text)), 'minified')
    assert.deepEqual(parse(text), { id: ID, taskId: 'review', kind: 'agent', status: 'running' })
    for (const hidden of ['cwd', 'workflowTaskId', 'workspaceId', 'requested', 'usage', 'model'])
      assert.ok(!text.includes(hidden), hidden)
  }
)

const exit = (exitCode: number | null | undefined) =>
  parse(
    workResultText({
      kind: 'attempt',
      attempt: summary({
        kind: 'process',
        status: 'completed',
        ...(exitCode === undefined ? {} : { exitCode }),
      }),
    })
  )

await claim(
  'exit codes are kept when numeric, including zero, and dropped when null or missing',
  () => {
    assert.deepEqual(exit(0), {
      id: ID,
      taskId: 'review',
      kind: 'process',
      status: 'completed',
      exitCode: 0,
    })
    assert.equal((exit(2) as { exitCode?: number }).exitCode, 2)
    assert.equal('exitCode' in (exit(null) as object), false)
    assert.equal('exitCode' in (exit(undefined) as object), false)
  }
)

await claim(
  'every status, parentage, a true coordinator, every warning and a worktree reminder survive',
  () => {
    for (const status of [
      'running',
      'waiting',
      'completed',
      'failed',
      'cancelled',
      'unknown',
    ] as const)
      assert.equal(
        (
          parse(workResultText({ kind: 'attempt', attempt: summary({ status }) })) as {
            status: string
          }
        ).status,
        status
      )
    const warned = summary({
      status: 'failed',
      parent: PARENT,
      coordinator: true,
      error: 'provider failed',
      deliveryError: 'delivery failed',
      cleanupError: 'cleanup failed',
      gateReleaseWarning: 'gate deferred',
      processObservation: 'PID unavailable',
      recovery: 'Retained facts only',
      worktree: { path: WORKTREE, cleanup: 'review-required' },
    })
    assert.deepEqual(parse(workResultText({ kind: 'attempt', attempt: warned })), {
      id: ID,
      taskId: 'review',
      kind: 'agent',
      status: 'failed',
      parent: PARENT,
      coordinator: true,
      error: 'provider failed',
      deliveryError: 'delivery failed',
      cleanupError: 'cleanup failed',
      gateReleaseWarning: 'gate deferred',
      processObservation: 'PID unavailable',
      recovery: 'Retained facts only',
      worktree: { path: WORKTREE, cleanup: 'review-required' },
    })
    assert.equal(
      'coordinator' in
        (parse(
          workResultText({ kind: 'attempt', attempt: summary({ coordinator: false }) })
        ) as object),
      false
    )
  }
)

await claim(
  'list and cancel-all keep records and paging, and show unavailable, blocked and cancellation only when present',
  () => {
    const quiet: WorkResult = {
      kind: 'snapshot',
      snapshot: {
        records: [summary()],
        unavailable: [],
        agentsBlocked: false,
        total: 1,
        nextOffset: null,
      },
    }
    assert.deepEqual(parse(workResultText(quiet)), {
      records: [{ id: ID, taskId: 'review', kind: 'agent', status: 'running' }],
      nextOffset: null,
    })
    const loud: WorkResult = {
      kind: 'snapshot',
      snapshot: {
        records: [],
        unavailable: [{ id: 'broken', error: 'corrupt record' }],
        agentsBlocked: true,
        total: 21,
        nextOffset: 20,
        cancellationRequested: true,
      },
    }
    assert.deepEqual(parse(workResultText(loud)), {
      records: [],
      nextOffset: 20,
      unavailable: [{ id: 'broken', error: 'corrupt record' }],
      agentsBlocked: true,
      cancellationRequested: true,
    })
  }
)

await claim(
  'plain inspect shows metadata and readable streams only, with no answer, log text or record',
  () => {
    const inspection: WorkResult = {
      kind: 'inspection',
      inspection: {
        ...outcome({
          staleArtifact: 'unknown',
          worktree: { path: WORKTREE, cleanup: 'blocked' },
          cwd: WORKTREE,
          logs: [
            log({ stream: 'result', text: 'SECRET-ANSWER' }),
            log({ stream: 'stderr', available: false, reason: 'Log unavailable or expired' }),
          ],
        }),
        record: { pid: 42, prompt: 'not for the model' },
      },
    }
    const text = workResultText(inspection)
    assert.deepEqual(parse(text), {
      id: ID,
      taskId: 'review',
      kind: 'agent',
      status: 'completed',
      exitCode: 0,
      worktree: { path: WORKTREE, cleanup: 'blocked' },
      staleArtifact: 'unknown',
      workflowTaskId: 'workflow-task',
      workspaceId: 'workspace',
      access: 'read-only',
      invokedSkill: 'code-review',
      streams: ['result'],
      unavailable: ['stderr'],
    })
    assert.ok(!text.includes('SECRET-ANSWER') && !text.includes('not for the model'))
    const elsewhere = workResultText({
      kind: 'inspection',
      inspection: { ...outcome({ cwd: '/repo' }), record: {} },
    })
    assert.equal((parse(elsewhere) as { cwd?: string }).cwd, '/repo')
  }
)

await claim(
  'a stream page is its verbatim text and next offset, truncation only when true, and an error when unavailable',
  () => {
    const text = 'line one\n  "quoted" ünïcode 🙂\n'
    assert.deepEqual(
      parse(workResultText({ kind: 'log', log: log({ stream: 'result', text, nextOffset: 40 }) })),
      { text, nextOffset: 40 }
    )
    assert.deepEqual(
      parse(
        workResultText({
          kind: 'log',
          log: log({ stream: 'stdout', text: 'partial', truncated: true, nextOffset: 7 }),
        })
      ),
      { text: 'partial', nextOffset: 7, truncated: true }
    )
    assert.deepEqual(parse(workResultText({ kind: 'log', log: log({ stream: 'stderr' }) })), {
      text: '',
      nextOffset: null,
    })
    assert.deepEqual(
      parse(
        workResultText({
          kind: 'log',
          log: { stream: 'stdout', available: false, reason: 'Log unavailable or expired' },
        })
      ),
      { error: 'Log unavailable or expired' }
    )
  }
)

await claim('dispatch shows model and effort per rule, without path, flag or harness', () => {
  const text = workResultText({
    kind: 'dispatch',
    dispatch: {
      path: '/repo/config/crew-dispatch.json',
      configured: true,
      default: { harness: 'pi', model: 'anthropic/claude-sonnet-5-5' },
      rules: { 'code-review': { harness: 'pi', model: 'openai/gpt-6', effort: 'high' } },
    },
  })
  assert.deepEqual(parse(text), {
    default: { model: 'anthropic/claude-sonnet-5-5' },
    rules: { 'code-review': { model: 'openai/gpt-6', effort: 'high' } },
  })
})

await claim(
  'an outcome carries a whole answer that fits the read, otherwise only a pointer to offset 0',
  () => {
    const answer = '```json\n{"format":"evidence/1","status":"complete"}\n```\nDone.'
    const whole = outcomeText(
      [outcome({ logs: [log({ stream: 'result', text: answer }), log({ stream: 'stderr' })] })],
      'Guidance.'
    )
    assert.ok(whole.startsWith('Guidance.\n'))
    assert.deepEqual(entries(whole), [
      {
        id: ID,
        taskId: 'review',
        kind: 'agent',
        status: 'completed',
        exitCode: 0,
        result: answer,
      },
    ])
    const truncated = outcomeText(
      [
        outcome({
          staleArtifact: true,
          logs: [log({ stream: 'result', text: 'tail of a long answer', truncated: true })],
        }),
      ],
      'Guidance.'
    )
    assert.deepEqual(entries(truncated), [
      {
        id: ID,
        taskId: 'review',
        kind: 'agent',
        status: 'completed',
        exitCode: 0,
        staleArtifact: true,
        result: 'truncated: read from offset 0',
      },
    ])
    assert.ok(!truncated.includes('tail of a long answer'))
  }
)

await claim(
  'command output keeps its last 512 characters, marked when cut, and empty or unavailable streams are not text',
  () => {
    const emoji = '🙂'.repeat(600)
    const preview = outputPreview(emoji, false)
    assert.ok(preview.startsWith('…'))
    const [mark, ...points] = preview
    assert.equal(mark, '…')
    assert.equal(points.length, 512)
    assert.ok(points.every(point => point === '🙂'))
    assert.equal(outputPreview('short', false), 'short')
    assert.equal(outputPreview('short', true), '…short')
    const long = `${'x'.repeat(600)}END`
    const text = outcomeText(
      [
        outcome({
          kind: 'process',
          exitCode: 1,
          logs: [
            log({ stream: 'stdout', text: long }),
            log({ stream: 'stderr', available: false, reason: 'Log unavailable or expired' }),
          ],
        }),
        outcome({ kind: 'process', logs: [log({ stream: 'stdout' }), log({ stream: 'stderr' })] }),
      ],
      'Guidance.'
    )
    const [cut, quiet] = entries(text) as { stdout?: string; unavailable?: string[] }[]
    assert.equal(cut?.stdout, `…${long.slice(-512)}`)
    assert.deepEqual(cut?.unavailable, ['stderr'])
    assert.equal(quiet !== undefined && 'stdout' in quiet, false)
    assert.equal(quiet !== undefined && 'stderr' in quiet, false)
  }
)

await claim(
  'the coordinator work tool sends the same model text as the projection, with the full result in details',
  async () => {
    const result: WorkResult = { kind: 'attempt', attempt: summary() }
    const tool = createCoordinatorWorkTool({
      request: () => Effect.succeed(result),
      pending: Effect.die('unused'),
      acknowledge: () => Effect.die('unused'),
      wake: Effect.die('unused'),
    })
    const executed = await tool.execute(
      'call',
      { action: 'list' },
      undefined,
      undefined,
      undefined as never
    )
    assert.deepEqual(executed.content, [{ type: 'text', text: workResultText(result) }])
    assert.deepEqual(executed.details, result)
  }
)

console.log(JSON.stringify({ result: 'passed', checks: passed }, null, 2))
