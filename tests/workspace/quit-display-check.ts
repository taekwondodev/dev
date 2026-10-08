import assert from 'node:assert/strict'
import {
  formatExitLine,
  formatQuitReceipt,
  formatQuitReleaseFailure,
  formatQuitReleasePlan,
  formatQuitReleaseResults,
  formatQuitSweepFailure,
  formatQuitTaskReleasePlan,
  progressDone,
  quitReleaseExclusion,
  taskReleaseExclusion,
  tasksToConfirm,
  tasksToRelease,
  terminalStyle,
} from '../../src/quit-display.ts'
import {
  WorkspaceId,
  type CompletionVerdict,
  type RetainedReason,
  type SweepOutcome,
  type SweepReceipt,
  type SweepRow,
} from '../../src/workspace-domain.ts'
import { makeClaims } from './workspace-check-support.ts'

const { claim, passed } = makeClaims()
const id = (suffix: string): WorkspaceId =>
  WorkspaceId.make(`00000000-0000-4000-8000-${suffix.padStart(12, '0')}`)
type WorkspaceRow = Extract<SweepRow, { readonly kind: 'workspace' }>
let next = 0
const row = (
  verdict: CompletionVerdict,
  outcome: SweepOutcome,
  taskId = id(String((next += 1)))
): WorkspaceRow => ({
  kind: 'workspace',
  taskId,
  workspaceId: id(`9${next}`),
  path: `/worktrees/w${next}`,
  origin: 'managed',
  verdict,
  outcome,
  reason: 'Verbose Git evidence that belongs in workspace check',
})
const finished: CompletionVerdict = {
  kind: 'finished',
  role: 'child',
  rule: 'no-residue',
  reason: 'nothing left',
}
const retained = (reason: RetainedReason): CompletionVerdict => ({
  kind: 'retained',
  role: 'child',
  retained: reason,
  reason: `retained: ${reason}`,
})
const removed = row(finished, 'removed')
const undelivered = row(retained('not-integrated'), 'retained')
const abandoned = row(retained('use-abandoned'), 'retained')
const receipt: SweepReceipt = { moment: 'quit', rows: [undelivered, removed, abandoned] }
const plain = terminalStyle({ isTTY: false }, { TERM_PROGRAM: 'ghostty' })
const ghostty = terminalStyle({ isTTY: true }, { TERM_PROGRAM: 'ghostty' })
const ghosttyNoColor = terminalStyle({ isTTY: true }, { TERM_PROGRAM: 'ghostty', NO_COLOR: '1' })

await claim(
  'mixed quit output offers undelivered work with a full command and English status, and separates abandoned use without paths or Git diagnostics',
  () => {
    assert.deepEqual(tasksToRelease(receipt), [undelivered.taskId])
    assert.equal(
      formatQuitReceipt(receipt, 12900, plain),
      [
        '✓ 1 worktree removed · 12.9s',
        '',
        `dev workspace release ${undelivered.taskId}`,
        'Status: Delivery to the integration target could not be verified.',
        '',
        'Not included in the quick release:',
        '',
        `dev workspace release ${abandoned.taskId}`,
        'Status: A previous session ended without settling its workspace use.',
      ].join('\n')
    )
  }
)

await claim(
  'quick release deduplicates tasks and excludes the entire task when any sibling is still in use or cannot be swept safely',
  () => {
    const missing = row(retained('directory-missing'), 'retained')
    const review = row(retained('release-review'), 'review-required', missing.taskId)
    const uncommitted = row(retained('no-commits'), 'retained')
    const unknownIntegration = row(retained('integration-unknown'), 'retained')
    assert.deepEqual(
      tasksToRelease({ moment: 'quit', rows: [missing, review, uncommitted, unknownIntegration] }),
      [missing.taskId, uncommitted.taskId, unknownIntegration.taskId]
    )
    for (const reason of [
      'use-live',
      'use-unknown',
      'use-abandoned',
      'excluded',
      'skipped',
    ] as const) {
      const sibling = row(retained(reason), 'retained', undelivered.taskId)
      assert.deepEqual(tasksToRelease({ moment: 'quit', rows: [undelivered, sibling] }), [])
    }
    const gated = row(finished, 'retained', undelivered.taskId)
    assert.deepEqual(tasksToRelease({ moment: 'quit', rows: [undelivered, gated] }), [])
  }
)

await claim(
  'a task used by a live session is neither shown nor asked about; a task with only unsettled uses is asked alone, while guarded or unassessed tasks keep only their command',
  () => {
    const live = row(retained('use-live'), 'retained')
    const liveSibling = row(retained('not-integrated'), 'retained', live.taskId)
    const gated = row(finished, 'retained')
    const withLive: SweepReceipt = {
      moment: 'quit',
      rows: [...receipt.rows, live, liveSibling, gated],
    }
    assert.deepEqual(tasksToRelease(withLive), [undelivered.taskId])
    assert.deepEqual(tasksToConfirm(withLive), [abandoned.taskId])
    const unsettledUnassessed: SweepReceipt = {
      moment: 'quit',
      rows: [abandoned, { kind: 'task-failure', taskId: abandoned.taskId, reason: 'threw' }],
    }
    assert.deepEqual(tasksToConfirm(unsettledUnassessed), [])
    const text = formatQuitReceipt(withLive, 12900, plain)
    assert.ok(!text.includes(live.taskId), text)
    assert.ok(text.includes(`dev workspace release ${gated.taskId}`), text)
    assert.equal(
      formatQuitReceipt({ moment: 'quit', rows: [live] }, 100, plain),
      'No workspaces removed · 0.1s'
    )
  }
)

await claim(
  'unassessed tasks get a full check command and are not silently offered for release',
  () => {
    const text = formatQuitReceipt(
      {
        moment: 'quit',
        rows: [
          { kind: 'task-failure', taskId: id('70'), reason: 'assessment threw' },
          { kind: 'task-deferred', taskId: id('71'), reason: 'budget' },
        ],
      },
      40000,
      plain
    )
    assert.ok(
      text.includes(`dev workspace check ${id('70')}\nStatus: The workspace assessment failed.`),
      text
    )
    assert.ok(
      text.includes(
        `dev workspace check ${id('71')}\nStatus: The sweep ran out of time before assessing this task.`
      ),
      text
    )
  }
)

await claim('empty sweep and non-Ghostty terminals stay plain and concise', () => {
  assert.equal(
    formatQuitReceipt({ moment: 'quit', rows: [] }, 120, plain),
    'No reserved workspaces · 0.1s'
  )
  const style = terminalStyle({ isTTY: true }, { TERM_PROGRAM: 'other' })
  assert.deepEqual(style, { live: false, color: false, ghostty: false })
  assert.equal(formatQuitReceipt(receipt, 12900, style), formatQuitReceipt(receipt, 12900, plain))
  assert.equal(formatExitLine(style, 0, 'done'), 'Exit 0: done.')
})

await claim(
  'Ghostty colors success green, commands yellow and status dim without path links; NO_COLOR preserves the same plain content',
  () => {
    const text = formatQuitReceipt(receipt, 12900, ghostty)
    assert.ok(text.includes('\x1b[32m✓ 1 worktree removed\x1b[0m'), text)
    assert.ok(text.includes(`\x1b[33mdev workspace release ${undelivered.taskId}\x1b[0m`), text)
    assert.ok(text.includes('\x1b[2mStatus:'), text)
    assert.equal(
      formatQuitReceipt(receipt, 12900, ghosttyNoColor),
      formatQuitReceipt(receipt, 12900, plain)
    )
    assert.equal(progressDone(ghostty, true), '\x1b]9;4;2;100\x07')
    assert.equal(progressDone(ghostty, false), '\x1b]9;4;1;100\x07')
    assert.equal(progressDone(plain, true), '')
  }
)

await claim(
  'preflight excludes unassessed or active siblings; the confirmation counts the whole task and explains consequences without paths',
  () => {
    const view = {
      repositoryId: id('1000'),
      taskId: undelivered.taskId,
      workspaceId: undelivered.workspaceId,
      path: '/worktrees/one',
      origin: 'managed' as const,
      reservationId: id('1002'),
      outcome: 'preserved-for-resume' as const,
      reason: 'kept',
      nextAction: 'resume',
      uses: [],
      pending: [],
    }
    assert.equal(quitReleaseExclusion(receipt, [view]), undefined)
    assert.equal(
      quitReleaseExclusion(receipt, [view, { ...view, workspaceId: id('2001') }]),
      'The task has workspaces that this sweep did not assess.'
    )
    assert.equal(
      quitReleaseExclusion(receipt, [
        { ...view, uses: [{ id: id('2002'), access: 'read', stage: 'unknown' }] },
      ]),
      'The task has an active or unresolved workspace use.'
    )
    assert.equal(
      quitReleaseExclusion(receipt, []),
      'The task no longer has any workspace reservations.'
    )
    const unsettled = {
      ...view,
      taskId: abandoned.taskId,
      workspaceId: abandoned.workspaceId,
      uses: [{ id: id('2003'), access: 'write' as const, stage: 'active' }],
    }
    assert.equal(taskReleaseExclusion(receipt, [unsettled]), undefined)
    assert.equal(
      taskReleaseExclusion(receipt, [unsettled, { ...unsettled, workspaceId: id('2004') }]),
      'The task has workspaces that this sweep did not assess.'
    )
    assert.equal(
      formatQuitTaskReleasePlan(receipt, { taskId: abandoned.taskId, views: [unsettled] }, plain),
      [
        '',
        `Release task ${abandoned.taskId} (1 managed worktree)?`,
        'Status: A previous session ended without settling its workspace use.',
        'This deletes the managed worktrees, including uncommitted changes and undelivered commits.',
      ].join('\n')
    )
    const plans = [
      {
        taskId: undelivered.taskId,
        views: [
          view,
          {
            ...view,
            repositoryId: id('2000'),
            workspaceId: id('2001'),
            path: '/other-repository/worktree',
          },
          { ...view, workspaceId: id('1003'), path: '/repo', origin: 'pre-existing' as const },
        ],
      },
    ]
    const text = formatQuitReleasePlan(plans, plain)
    assert.ok(text.includes('Release 1 task (2 managed worktrees, 1 checkout reservation)?'), text)
    assert.ok(text.includes('including uncommitted changes and undelivered commits'), text)
    assert.ok(
      text.includes(
        'Pre-existing checkouts keep their files and commits; only their reservations end.'
      ),
      text
    )
    assert.ok(!text.includes('/worktrees/one') && !text.includes('/repo'), text)
    const colored = formatQuitReleasePlan(plans, ghostty)
    assert.ok(colored.includes('\x1b[31m'), colored)
  }
)

await claim(
  'release results count success without paths and leave full task commands for failures',
  () => {
    const result = {
      repositoryId: id('1000'),
      workspaceId: id('1001'),
      path: '/worktrees/one',
      origin: 'managed' as const,
      outcome: 'removed' as const,
      reason: 'removed',
    }
    assert.equal(
      formatQuitReleaseResults(undelivered.taskId, [result], plain),
      '✓ 1 worktree removed'
    )
    const failed = formatQuitReleaseResults(
      undelivered.taskId,
      [
        {
          ...result,
          outcome: 'failed',
          reason: 'Worktree /worktrees/one is locked. Verbose operational detail.',
        },
      ],
      plain
    )
    assert.ok(
      failed.includes(
        `dev workspace release ${undelivered.taskId}\nStatus: The release failed; its recorded outcome needs review.`
      ),
      failed
    )
    assert.ok(!failed.includes(result.path), failed)
    assert.equal(
      formatQuitReleaseFailure(undelivered.taskId, 'unreported', plain),
      `dev workspace release ${undelivered.taskId}\nStatus: The release did not report back; its outcome is unknown.`
    )
    assert.equal(
      formatQuitSweepFailure(plain),
      'dev workspace list\nStatus: The sweep did not report back; its outcome is unknown.'
    )
    const sweepFailure = formatQuitReceipt(
      { moment: 'quit', rows: [{ kind: 'sweep-failure', reason: 'Error at /private/path' }] },
      1,
      plain
    )
    assert.ok(!sweepFailure.includes('/private/path'), sweepFailure)
  }
)

process.stdout.write(`${JSON.stringify({ result: 'passed', checks: passed }, null, 2)}\n`)
