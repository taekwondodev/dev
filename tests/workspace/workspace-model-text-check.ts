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
    role: 'child',
    rule: 'child-delivered',
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
        { kind: 'sweep-failure', reason: 'The authority is unavailable.' },
      ],
    })
    const prefix = 'Workspace sweep at the conversation replacement: '
    assert.ok(text !== undefined && text.startsWith(prefix), String(text))
    assert.deepEqual(parse(text.slice(prefix.length)), [
      { taskId: TASK, workspaceId: WORKSPACE, path: PATH, outcome: 'removed' },
      {
        taskId: TASK,
        workspaceId: OTHER,
        path: PATH,
        outcome: 'review-required',
        reason: 'Git refused.',
      },
      {
        taskId: TASK,
        artifacts: '/authority/artifacts/task',
        outcome: 'removed',
      },
      { outcome: 'review-required', reason: 'The authority is unavailable.' },
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
              stage: 'live',
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
          pending: [{ id: fixtureId(12), kind: 'remove', stage: 'intent' }],
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
      workspaces: [
        {
          taskId: TASK,
          workspaceId: WORKSPACE,
          path: PATH,
          origin: 'managed',
          outcome: 'active',
          reason: 'A live dev session uses it.',
          next: 'Continue in that session.',
          uses: [{ access: 'write', stage: 'live', attempt: 'attempt-1' }],
          pending: ['remove (intent)'],
        },
        {
          workspaceId: OTHER,
          path: '/repo',
          origin: 'pre-existing',
          outcome: 'active',
          reason: 'A live dev session uses it.',
          next: 'Continue in that session.',
        },
      ],
    })
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
      role: 'child',
      rule: 'no-residue',
      reason: 'Nothing remains.',
    },
  }
  const text = reportText({
    kind: 'check',
    taskId: TASK,
    assessments: [assessment],
  })
  const [guidance, json] = text.split('\n')
  assert.equal(guidance, 'A check changes nothing; the next sweep rechecks everything.')
  assert.deepEqual(parse(json!), {
    taskId: TASK,
    workspaces: [
      {
        workspaceId: WORKSPACE,
        path: PATH,
        origin: 'managed',
        role: 'child',
        verdict: 'finished (no-residue)',
        reason: 'Nothing remains.',
        target: 'owner/repo refs/heads/main',
        reasons: ['This conversation holds 1 use(s) here; they end when it quits.'],
      },
    ],
  })
})

await claim('an inspect or check without records is still a report, with no workspaces', () => {
  assert.deepEqual(parse(reportText({ kind: 'inspect', taskId: TASK, views: [] })), {
    taskId: TASK,
    workspaces: [],
  })
  const check = reportText({ kind: 'check', taskId: TASK, assessments: [] })
  assert.deepEqual(parse(check.slice(check.indexOf('\n') + 1)), { taskId: TASK, workspaces: [] })
})

console.log(JSON.stringify({ result: 'passed', checks: passed }, null, 2))
