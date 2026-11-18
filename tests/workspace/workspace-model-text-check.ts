import assert from 'node:assert/strict'
import type { WorkspaceReport } from '../../src/workspace-command.ts'
import type {
  SweepReceipt,
  WorkspaceAssessment,
  WorkspaceView,
} from '../../src/workspace-domain.ts'
import { reportText, sweepText } from '../../src/workspace-model-text.ts'
import { makeClaims } from './workspace-check-support.ts'
import { fixtureId } from './workspace-host-fixture-shapes.ts'

const { claim, passed } = makeClaims()

const TASK = fixtureId(1)
const WORKSPACE = fixtureId(2)
const OTHER = fixtureId(3)
const PATH = '/Users/owner/Library/Application Support/dev/worktrees/repo/workspace'

const view = (fields: Partial<WorkspaceView> = {}): WorkspaceView => ({
  repositoryId: fixtureId(9),
  taskId: TASK,
  workspaceId: WORKSPACE,
  path: PATH,
  origin: 'managed',
  reservationId: fixtureId(10),
  outcome: 'active',
  reason: 'A live dev session uses it.',
  nextAction: 'Continue in that session.',
  uses: [],
  pending: [],
  ...fields,
})

const removed = {
  kind: 'workspace',
  taskId: TASK,
  workspaceId: WORKSPACE,
  path: PATH,
  origin: 'managed',
  verdict: {
    kind: 'finished',
    role: 'agent',
    rule: 'agent-delivered',
    reason: 'delivered',
  },
  outcome: 'removed',
  reason: 'The managed worktree was verified removed.',
} as const satisfies SweepReceipt['rows'][number]

const retained = {
  kind: 'workspace',
  taskId: TASK,
  workspaceId: OTHER,
  path: '/repo',
  origin: 'pre-existing',
  verdict: {
    kind: 'retained',
    role: 'pre-existing',
    retained: 'checkout-modified',
    reason: 'The checkout has 1 untracked file(s).',
  },
  outcome: 'retained',
  reason: 'The checkout has 1 untracked file(s).',
} as const satisfies SweepReceipt['rows'][number]

const parse = (text: string): unknown => JSON.parse(text)

await claim(
  'a sweep whose rows are only retained, skipped or deferred gives the model nothing',
  () => {
    assert.equal(
      sweepText({
        moment: 'allocation',
        rows: [
          retained,
          { ...retained, outcome: 'skipped' },
          { kind: 'task-deferred', taskId: TASK, reason: 'busy' },
        ],
      }),
      undefined
    )
  }
)

await claim(
  'a sweep that changes something lists only those rows, with a reason only where review is required',
  () => {
    const text = sweepText({
      moment: 'replacement',
      rows: [
        removed,
        retained,
        {
          ...removed,
          workspaceId: OTHER,
          outcome: 'review-required',
          reason: 'Git refused.',
        },
        {
          kind: 'task-artifacts',
          taskId: TASK,
          path: '/authority/artifacts/task',
          outcome: 'removed',
          reason: 'removed',
        },
        { kind: 'sweep-failure', reason: 'Dev storage is unavailable.' },
      ],
    })
    const prefix = 'Automatic cleanup when switching conversations: '
    assert.ok(text !== undefined && text.startsWith(prefix), String(text))
    assert.deepEqual(parse(text.slice(prefix.length)), [
      { taskId: TASK, workspaceId: WORKSPACE, path: PATH, result: 'removed' },
      {
        taskId: TASK,
        workspaceId: OTHER,
        path: PATH,
        result: 'review-required',
        reason: 'Git refused.',
      },
      {
        taskId: TASK,
        artifacts: '/authority/artifacts/task',
        result: 'removed',
      },
      { result: 'review-required', reason: 'Dev storage is unavailable.' },
    ])
  }
)

await claim(
  'a list is minified JSON without repository, reservation or use identities and without empty fields',
  () => {
    const report: WorkspaceReport = {
      kind: 'list',
      repositoryRoot: '/repo',
      current: { workspaceId: WORKSPACE, effectiveCwd: PATH },
      views: [
        view({
          uses: [
            {
              id: fixtureId(11),
              access: 'write',
              stage: 'launch-intent',
              execution: {
                sessionId: 'session',
                taskKey: 'tests',
                attemptId: 'attempt-1',
                generation: 'generation',
                logs: '/logs/attempt-1',
              },
              logsAvailable: true,
            },
          ],
          pending: [{ id: fixtureId(12), kind: 'handoff', stage: 'intent' }],
        }),
        (({ taskId: _taskId, ...unassigned }) => unassigned)(
          view({ workspaceId: OTHER, path: '/repo', origin: 'pre-existing' })
        ),
      ],
    }
    const text = reportText(report)
    assert.equal(text, JSON.stringify(parse(text)), 'minified')
    assert.deepEqual(parse(text), {
      repository: '/repo',
      current: { workspaceId: WORKSPACE, cwd: PATH },
      checkouts: [
        {
          taskId: TASK,
          workspaceId: WORKSPACE,
          path: PATH,
          origin: 'managed',
          result: 'active',
          reason: 'A live dev session uses it.',
          next: 'Continue in that session.',
          uses: [{ access: 'write', stage: 'launch-planned', run: 'attempt-1' }],
          pending: ['switch (planned)'],
        },
        {
          workspaceId: OTHER,
          path: '/repo',
          origin: 'pre-existing',
          result: 'active',
          reason: 'A live dev session uses it.',
          next: 'Continue in that session.',
        },
      ],
    })
  }
)

await claim(
  'a view gives the model its head as the branch name, or as the detached commit with its subject when it has one, and never its last use time',
  () => {
    const commit = '0123456789abcdef0123456789abcdef01234567'
    const text = reportText({
      kind: 'inspect',
      taskId: TASK,
      views: [
        view({ head: { kind: 'branch', name: 'feat/resume' }, lastUsedAt: 1_700_000_000_000 }),
        view({ workspaceId: OTHER, head: { kind: 'detached', commit }, lastUsedAt: 1 }),
        view({
          workspaceId: OTHER,
          head: { kind: 'detached', commit, subject: 'Resume the parser' },
        }),
      ],
    })
    assert.ok(!text.includes('lastUsedAt') && !text.includes('1700000000000'), text)
    const { checkouts } = parse(text) as { checkouts: { head?: string }[] }
    assert.deepEqual(
      checkouts.map(checkout => checkout.head),
      ['feat/resume', 'detached 0123456789ab', 'detached 0123456789ab (Resume the parser)']
    )
  }
)

await claim('a check states that it changes nothing and gives each verdict as one string', () => {
  const assessment: WorkspaceAssessment = {
    repositoryId: fixtureId(9),
    taskId: TASK,
    workspaceId: WORKSPACE,
    reservationId: fixtureId(10),
    path: PATH,
    origin: 'managed',
    reasons: ['This conversation holds 1 use(s) here; they end when it quits.'],
    nextActions: [],
    residual: [],
    target: {
      source: 'origin-github',
      description: 'owner/repo refs/heads/main',
    },
    completion: {
      kind: 'finished',
      role: 'agent',
      rule: 'nothing-left',
      reason: 'Nothing remains.',
    },
  }
  const text = reportText({
    kind: 'check',
    taskId: TASK,
    assessments: [assessment],
  })
  const [guidance, json] = text.split('\n')
  assert.equal(guidance, 'Read-only check. Dev checks again before cleanup.')
  assert.deepEqual(parse(json!), {
    taskId: TASK,
    checkouts: [
      {
        workspaceId: WORKSPACE,
        path: PATH,
        origin: 'managed',
        role: 'agent',
        verdict: 'finished (nothing-left)',
        reason: 'Nothing remains.',
        target: 'owner/repo refs/heads/main',
        reasons: ['This conversation holds 1 use(s) here; they end when it quits.'],
      },
    ],
  })
})

await claim('an inspect or check without records is still a report, with no checkouts', () => {
  assert.deepEqual(parse(reportText({ kind: 'inspect', taskId: TASK, views: [] })), {
    taskId: TASK,
    checkouts: [],
  })
  const check = reportText({ kind: 'check', taskId: TASK, assessments: [] })
  assert.deepEqual(parse(check.slice(check.indexOf('\n') + 1)), { taskId: TASK, checkouts: [] })
})

console.log(JSON.stringify({ result: 'passed', checks: passed }, null, 2))
