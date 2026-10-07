import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  formatExitLine,
  formatQuitReceipt,
  formatQuitReleasePlan,
  progressDone,
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
const worktree = (name: string): string =>
  join(homedir(), 'Library', 'Application Support', 'dev', 'worktrees', name)

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
  path: worktree(`w${next}`),
  origin: 'managed',
  verdict,
  outcome,
  reason: `reason of ${outcome}`,
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
const unfinishedRemoval = row(finished, 'review-required')
const gated = row(finished, 'retained')
const missing = row(retained('directory-missing'), 'retained')
const reviewSibling = row(retained('release-review'), 'review-required', missing.taskId)
const notIntegrated = row(retained('not-integrated'), 'retained')
const live = row(retained('use-live'), 'retained')
const modified = row(retained('checkout-modified'), 'retained')
const failedTask = id('77')
const receipt: SweepReceipt = {
  moment: 'quit',
  rows: [
    notIntegrated,
    removed,
    unfinishedRemoval,
    gated,
    missing,
    reviewSibling,
    live,
    modified,
    { kind: 'task-failure', taskId: failedTask, reason: 'assessment threw' },
    { kind: 'task-deferred', taskId: id('78'), reason: 'budget' },
  ],
}

const plain = terminalStyle({ isTTY: false }, { TERM_PROGRAM: 'ghostty' })
const ghostty = terminalStyle({ isTTY: true }, { TERM_PROGRAM: 'ghostty' })
const ghosttyNoColor = terminalStyle({ isTTY: true }, { TERM_PROGRAM: 'ghostty', NO_COLOR: '1' })

await claim(
  'only workspaces that nothing but a release clears ask for one, once per task: an unfinished removal, a missing directory and an earlier unfinished release',
  () => {
    assert.deepEqual(tasksToRelease(receipt), [unfinishedRemoval.taskId, missing.taskId])
  }
)

await claim(
  'the plain receipt carries no escape sequence and gives full release and check commands, hints for undelivered work and a count of the quiet rest',
  () => {
    const text = formatQuitReceipt(receipt, 3412, plain)
    assert.ok(!text.includes('\x1b'), text)
    assert.ok(text.includes(`dev workspace release ${unfinishedRemoval.taskId}`), text)
    assert.ok(text.includes(`dev workspace release ${missing.taskId}`), text)
    assert.equal(text.split(`dev workspace release ${missing.taskId}\n`).length, 2, text)
    assert.ok(text.includes(`dev workspace check ${failedTask}`), text)
    assert.ok(!text.includes(`dev workspace release ${notIntegrated.taskId}`), text)
    assert.ok(text.includes('next: Deliver the work'), text)
    assert.ok(text.indexOf('✓ removed') < text.indexOf('· kept'), text)
    assert.ok(text.lastIndexOf('✗ review') < text.indexOf('· kept'), text)
    assert.ok(
      text.includes('reason of retained'),
      'a finished workspace the sweep could not remove says why'
    )
    assert.ok(text.includes('· 2 retained (use-live, checkout-modified)'), text)
    assert.ok(text.includes('· 1 task(s) deferred to the next sweep'), text)
    assert.ok(text.includes('1/3 finished workspace(s) reached a terminal outcome · 3.4s'), text)
    assert.ok(!text.includes(live.path.replace(homedir(), '~')), 'a live workspace is only counted')
    assert.ok(text.includes(removed.path.replace(homedir(), '~')), text)
  }
)

await claim('an empty sweep says so with its elapsed time', () => {
  assert.equal(
    formatQuitReceipt({ moment: 'quit', rows: [] }, 120, plain),
    'Workspace sweep at quit\nno reserved workspace · 0.1s'
  )
})

await claim(
  'in Ghostty paths link to their directory and the tab progress ends as error or success; NO_COLOR drops colors, not links',
  () => {
    const text = formatQuitReceipt(receipt, 1000, ghostty)
    assert.ok(text.includes(`\x1b]8;;${pathToFileURL(removed.path).href}\x1b\\`), text)
    assert.ok(text.includes('\x1b[31m'), text)
    const uncolored = formatQuitReceipt(receipt, 1000, ghosttyNoColor)
    assert.ok(!uncolored.includes('\x1b['), uncolored)
    assert.ok(uncolored.includes('\x1b]8;;'), uncolored)
    assert.equal(progressDone(ghostty, true), '\x1b]9;4;2;100\x07')
    assert.equal(progressDone(ghostty, false), '\x1b]9;4;1;100\x07')
    assert.equal(progressDone(plain, true), '')
  }
)

await claim(
  'outside Ghostty, even a TTY gets plain text with no redraw, color or OSC sequence',
  () => {
    const style = terminalStyle({ isTTY: true }, { TERM_PROGRAM: 'other' })
    assert.deepEqual(style, { live: false, color: false, ghostty: false })
    assert.deepEqual(terminalStyle({ isTTY: true }, {}), style)
    assert.ok(!formatQuitReceipt(receipt, 1000, style).includes('\x1b'))
    assert.equal(progressDone(style, false), '')
    assert.equal(formatExitLine(style, 0, 'done'), 'Exit 0: done.')
  }
)

await claim(
  'the release plan at quit names every reserved workspace of each task with its consequence',
  () => {
    const text = formatQuitReleasePlan(
      [
        {
          taskId: missing.taskId,
          views: [
            {
              repositoryId: id('1000'),
              taskId: missing.taskId,
              workspaceId: id('1001'),
              path: worktree('gone'),
              origin: 'managed',
              reservationId: id('1002'),
              outcome: 'blocked',
              reason: 'gone',
              nextAction: 'release',
              uses: [],
              pending: [],
            },
            {
              repositoryId: id('1000'),
              taskId: missing.taskId,
              workspaceId: id('1003'),
              path: '/repo',
              origin: 'pre-existing',
              reservationId: id('1004'),
              outcome: 'preserved-for-resume',
              reason: 'kept',
              nextAction: 'resume',
              uses: [],
              pending: [],
            },
          ],
        },
      ],
      plain
    )
    assert.ok(text.startsWith('1 task(s) need a release'), text)
    assert.ok(text.includes('the worktree and everything in it are deleted'), text)
    assert.ok(text.includes('/repo  only the reservation ends; files and commits stay'), text)
  }
)

process.stdout.write(`${JSON.stringify({ result: 'passed', checks: passed }, null, 2)}\n`)
