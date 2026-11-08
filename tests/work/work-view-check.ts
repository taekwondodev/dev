import assert from 'node:assert/strict'
import {
  asAttemptId,
  type AttemptId,
  type AttemptView,
  type ChildLive,
  decodeAttemptRecord,
  type WorkSnapshot,
} from '../../src/work-domain.ts'
import { emptyWorkView, workView } from '../../src/work-view.ts'
import { makeClaims } from '../workspace/workspace-check-support.ts'

const { claim, passed } = makeClaims()

const attemptId = (index: number) =>
  asAttemptId(`00000000-0000-0000-0000-${String(index).padStart(12, '0')}`)

interface Facts {
  readonly index: number
  readonly taskId?: string
  readonly kind?: 'agent' | 'process'
  readonly status?: AttemptView['status']
  readonly startedAt?: number
  readonly completedAt?: number
  readonly parent?: number
  readonly skill?: string
  readonly coordinator?: boolean
  readonly assistantMessages?: number
  readonly error?: string
}

const record = (facts: Facts): AttemptView =>
  decodeAttemptRecord({
    revision: 1,
    id: attemptId(facts.index),
    startedAt: facts.startedAt ?? facts.index,
    kind: facts.kind ?? 'agent',
    cwd: '/repo',
    controllerPid: 1,
    owner: {
      sessionId: 'session',
      taskId: facts.taskId ?? `task-${facts.index}`,
      attemptId: attemptId(facts.index),
      generation: 'generation',
      ...(facts.parent === undefined ? {} : { parent: attemptId(facts.parent) }),
    },
    ...(facts.kind === 'process' ? {} : { access: 'read-only' }),
    ...(facts.coordinator === true ? { coordinator: true } : {}),
    status: facts.status ?? 'running',
    ...(facts.completedAt === undefined ? {} : { completedAt: facts.completedAt }),
    ...(facts.error === undefined ? {} : { error: facts.error }),
    ...(facts.assistantMessages === undefined
      ? {}
      : {
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            total: 2,
            cost: 0,
            userMessages: 1,
            assistantMessages: facts.assistantMessages,
            toolCalls: 3,
            toolResults: 3,
          },
        }),
    ...(facts.skill === undefined
      ? {}
      : {
          resources: {
            packageVersion: '1.5.0',
            cwd: '/repo',
            access: 'read-only',
            profile: 'fixture',
            resources: [],
            invokedSkill: { name: facts.skill, path: `/skills/${facts.skill}/SKILL.md` },
            tools: [],
          },
        }),
  })

const snapshot = (records: readonly AttemptView[], agentsBlocked = false): WorkSnapshot => ({
  records,
  unavailable: [],
  agentsBlocked,
})

const view = (
  records: readonly AttemptView[],
  options: {
    readonly batchStart?: number
    readonly live?: ReadonlyMap<AttemptId, ChildLive>
    readonly agentsBlocked?: boolean
    readonly reactivationSuspended?: boolean
  } = {}
) =>
  workView({
    sessionId: 'session',
    snapshot: snapshot(records, options.agentsBlocked),
    live: options.live ?? new Map(),
    batchStart: options.batchStart ?? 0,
    reactivationSuspended: options.reactivationSuspended ?? false,
  })

const ids = (built: ReturnType<typeof view>) => built.children.map(child => child.taskId)

await claim(
  'the batch holds active children and children that finished at or after the owner input, not earlier ones',
  () => {
    const records = [
      record({ index: 1, taskId: 'old', status: 'completed', completedAt: 90 }),
      record({ index: 2, taskId: 'running', startedAt: 50 }),
      record({ index: 3, taskId: 'waiting', status: 'waiting', startedAt: 60 }),
      record({ index: 4, taskId: 'fresh', status: 'failed', startedAt: 95, completedAt: 120 }),
      record({ index: 5, taskId: 'boundary', status: 'cancelled', completedAt: 100 }),
      record({ index: 6, taskId: 'lost', status: 'unknown', startedAt: 10 }),
      record({ index: 7, taskId: 'lost-now', status: 'unknown', startedAt: 110 }),
    ]
    assert.deepEqual(ids(view(records, { batchStart: 100 })), [
      'boundary',
      'running',
      'waiting',
      'fresh',
      'lost-now',
    ])
    assert.deepEqual(ids(view(records, { batchStart: 200 })), ['running', 'waiting'])
  }
)

await claim('children are ordered by start time, then id, whatever the snapshot order', () => {
  const records = [
    record({ index: 3, startedAt: 20 }),
    record({ index: 2, startedAt: 10 }),
    record({ index: 1, startedAt: 20 }),
  ]
  assert.deepEqual(ids(view(records)), ['task-2', 'task-1', 'task-3'])
  assert.deepEqual(view(records), view(records.toReversed()))
})

await claim(
  'every parent in the view is itself in the view: a finished coordinator stays with its running leaf, and a missing parent is dropped',
  () => {
    const coordinator = record({
      index: 1,
      taskId: 'plan',
      coordinator: true,
      status: 'completed',
      completedAt: 5,
    })
    const leaf = record({ index: 2, taskId: 'leaf', parent: 1, startedAt: 6 })
    const orphan = record({ index: 3, taskId: 'orphan', parent: 9, startedAt: 7 })
    const built = view([coordinator, leaf, orphan], { batchStart: 100 })
    assert.deepEqual(
      built.children.map(child => [child.taskId, child.parent]),
      [
        ['plan', undefined],
        ['leaf', coordinator.id],
        ['orphan', undefined],
      ]
    )
    const present = new Set(built.children.map(child => child.id))
    for (const child of built.children)
      assert.ok(child.parent === undefined || present.has(child.parent))
    assert.equal(built.children[0]?.coordinator, true)
    assert.equal(built.children[1]?.coordinator, false)
  }
)

await claim(
  'turns come from live state while running and from the recorded assistant messages once settled; activity only while running',
  () => {
    const running = record({ index: 1, assistantMessages: 2, skill: 'arena' })
    const waiting = record({ index: 2, status: 'waiting', assistantMessages: 4 })
    const done = record({ index: 3, status: 'completed', completedAt: 9, assistantMessages: 7 })
    const fresh = record({ index: 4 })
    const tool: ChildLive = { turns: 5, activity: { kind: 'tool', name: 'read', target: 'a.md' } }
    const built = view([running, waiting, done, fresh], {
      live: new Map([
        [running.id, tool],
        [waiting.id, { turns: 6, activity: { kind: 'thinking' } }],
      ]),
    })
    assert.deepEqual(
      built.children.map(child => [child.taskId, child.turns, child.activity]),
      [
        ['task-1', 5, tool.activity],
        ['task-2', 6, undefined],
        ['task-3', 7, undefined],
        ['task-4', 0, undefined],
      ]
    )
    assert.equal(built.children[0]?.skill, 'arena')
  }
)

await claim('a failed child carries its terminal error', () => {
  const failed = record({
    index: 1,
    status: 'failed',
    completedAt: 3,
    error: 'Subscription quota exhausted',
  })
  assert.equal(view([failed]).children[0]?.error, 'Subscription quota exhausted')
})

await claim(
  'local commands are counted while active and never listed; blocks are reported as facts',
  () => {
    const built = view(
      [
        record({ index: 1, kind: 'process' }),
        record({ index: 2, kind: 'process', status: 'waiting' }),
        record({ index: 3, kind: 'process', status: 'completed', completedAt: 9 }),
        record({ index: 4 }),
      ],
      { agentsBlocked: true, reactivationSuspended: true }
    )
    assert.deepEqual(ids(built), ['task-4'])
    assert.deepEqual(built.commands, { running: 2 })
    assert.deepEqual(built.blocks, { agentsBlocked: true, reactivationSuspended: true })
  }
)

await claim('the empty view has no children, no commands and no blocks', () => {
  assert.deepEqual(emptyWorkView('session'), view([]))
  assert.deepEqual(emptyWorkView('session'), {
    sessionId: 'session',
    children: [],
    commands: { running: 0 },
    blocks: { agentsBlocked: false, reactivationSuspended: false },
  })
})

console.log(JSON.stringify({ result: 'passed', checks: passed }, null, 2))
