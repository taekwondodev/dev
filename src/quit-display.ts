import { Clock, Effect, type Scope } from 'effect'
import type {
  RetainedReason,
  SweepReceipt,
  SweepRow,
  WorkspaceId,
  WorkspaceReleaseResult,
  WorkspaceView,
} from './workspace-domain.ts'

export interface TerminalStyle {
  readonly live: boolean
  readonly color: boolean
  readonly ghostty: boolean
}

export const terminalStyle = (
  stream: { readonly isTTY?: boolean },
  env: NodeJS.ProcessEnv
): TerminalStyle => {
  const live = stream.isTTY === true && env.TERM_PROGRAM === 'ghostty'
  return {
    live,
    color: live && (env.NO_COLOR ?? '') === '',
    ghostty: live,
  }
}

type Tone = 'ok' | 'fail' | 'warn' | 'dim' | 'bold'
const TONE: Record<Tone, string> = { ok: '32', fail: '31', warn: '33', dim: '2', bold: '1' }
const paint = (style: TerminalStyle, tone: Tone, text: string): string =>
  style.color ? `\x1b[${TONE[tone]}m${text}\x1b[0m` : text

const PROGRESS_ACTIVE = '\x1b]9;4;3\x07'
const PROGRESS_FAILED = '\x1b]9;4;2;100\x07'
const PROGRESS_SUCCEEDED = '\x1b]9;4;1;100\x07'
export const progressDone = (style: TerminalStyle, failed: boolean): string => {
  if (!style.ghostty) return ''
  return failed ? PROGRESS_FAILED : PROGRESS_SUCCEEDED
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const FRAME_MS = 80
const PROGRESS_KEEPALIVE_FRAMES = 12
const CLEAR_LINE = '\r\x1b[2K'

const seconds = (elapsedMs: number): string => `${(elapsedMs / 1000).toFixed(1)}s`

const spin = Effect.fnUntraced(function* (
  style: TerminalStyle,
  out: NodeJS.WritableStream,
  started: number
): Effect.fn.Return<never> {
  for (let frame = 0; ; frame += 1) {
    const now = yield* Clock.currentTimeMillis
    const progress = style.ghostty && frame % PROGRESS_KEEPALIVE_FRAMES === 0 ? PROGRESS_ACTIVE : ''
    yield* Effect.sync(() => {
      out.write(
        `${progress}${CLEAR_LINE}${paint(style, 'warn', SPINNER[frame % SPINNER.length] ?? '')} Sweeping workspaces… ${paint(style, 'dim', seconds(now - started))}`
      )
    })
    yield* Effect.sleep(FRAME_MS)
  }
})

export const sweepIndicator = Effect.fnUntraced(function* (
  style: TerminalStyle,
  out: NodeJS.WritableStream
): Effect.fn.Return<void, never, Scope.Scope> {
  if (!style.live) {
    yield* Effect.sync(() => {
      out.write('Sweeping workspaces...\n')
    })
    return
  }
  const started = yield* Clock.currentTimeMillis
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      out.write(CLEAR_LINE)
    })
  )
  yield* Effect.forkScoped(spin(style, out, started), { uninterruptible: false })
})

type WorkspaceRow = Extract<SweepRow, { readonly kind: 'workspace' }>

const RETAINED_DISPLAY: Record<
  RetainedReason,
  { readonly release: boolean; readonly status: string }
> = {
  'identity-unverifiable': {
    release: true,
    status: 'The workspace identity could not be verified.',
  },
  'transition-unresolved': { release: true, status: 'A workspace transition has not finished.' },
  'release-review': { release: true, status: 'An earlier removal did not finish.' },
  excluded: {
    release: false,
    status: 'The workspace belongs to the conversation allocating a worktree.',
  },
  'use-unknown': { release: false, status: 'A workspace use is unresolved.' },
  'use-abandoned': {
    release: false,
    status: 'A previous session ended without settling its workspace use.',
  },
  'use-live': { release: false, status: 'A session or process is still using the workspace.' },
  'directory-missing': {
    release: true,
    status: 'The worktree directory is missing, but its reservation remains.',
  },
  'residue-unreadable': { release: true, status: 'The workspace contents could not be read.' },
  'checkout-modified': { release: true, status: 'The checkout has uncommitted changes.' },
  skipped: { release: false, status: 'The workspace was excluded from this sweep.' },
  'no-commits': { release: true, status: 'The workspace has no commits proving delivery.' },
  'integration-unknown': {
    release: true,
    status: 'Integration could not be assessed with the available evidence.',
  },
  'not-integrated': {
    release: true,
    status: 'Delivery to the integration target could not be verified.',
  },
}

const isDone = (row: { readonly outcome: string }): boolean =>
  row.outcome === 'removed' || row.outcome === 'released'

const workspaceRows = (receipt: SweepReceipt): readonly WorkspaceRow[] =>
  receipt.rows.filter((row): row is WorkspaceRow => row.kind === 'workspace')

const canOfferRelease = (row: WorkspaceRow): boolean =>
  row.outcome === 'review-required' ||
  (row.verdict.kind === 'retained' && RETAINED_DISPLAY[row.verdict.retained].release)

export const tasksToRelease = (receipt: SweepReceipt): readonly WorkspaceId[] => {
  const remaining = workspaceRows(receipt).filter(row => !isDone(row))
  const excluded = new Set(remaining.filter(row => !canOfferRelease(row)).map(row => row.taskId))
  for (const row of receipt.rows) {
    if (row.kind === 'task-failure' || row.kind === 'task-deferred') excluded.add(row.taskId)
  }
  return [...new Set(remaining.filter(row => !excluded.has(row.taskId)).map(row => row.taskId))]
}

const statusOf = (row: WorkspaceRow): string => {
  if (row.verdict.kind === 'retained') return RETAINED_DISPLAY[row.verdict.retained].status
  return row.outcome === 'review-required'
    ? 'An earlier removal did not finish.'
    : 'A cleanup guard blocked removal after completion was verified.'
}

const commandStatus = (style: TerminalStyle, command: string, status: string): string =>
  `${paint(style, 'warn', command)}\n${paint(style, 'dim', `Status: ${status}`)}`

const count = (value: number, noun: string): string => `${value} ${noun}${value === 1 ? '' : 's'}`

const successes = (rows: readonly { readonly outcome: string }[], style: TerminalStyle): string => {
  const removed = rows.filter(row => row.outcome === 'removed').length
  const released = rows.filter(row => row.outcome === 'released').length
  return [
    ...(removed === 0 ? [] : [paint(style, 'ok', `✓ ${count(removed, 'worktree')} removed`)]),
    ...(released === 0 ? [] : [paint(style, 'ok', `✓ ${count(released, 'reservation')} released`)]),
  ].join(' · ')
}

export const formatQuitReceipt = (
  receipt: SweepReceipt,
  elapsedMs: number,
  style: TerminalStyle,
  excluded: ReadonlyMap<WorkspaceId, string> = new Map()
): string => {
  const rows = workspaceRows(receipt)
  const offered = new Set(tasksToRelease(receipt).filter(taskId => !excluded.has(taskId)))
  const remaining = rows.filter(row => !isDone(row))
  const blocks = (selected: readonly WorkspaceRow[]): readonly string[] =>
    selected.map(row =>
      commandStatus(
        style,
        `dev workspace release ${row.taskId}`,
        excluded.get(row.taskId) ?? statusOf(row)
      )
    )
  const unavailable = remaining.filter(row => !offered.has(row.taskId))
  const unassessed = receipt.rows.flatMap(row => {
    switch (row.kind) {
      case 'task-failure':
        return [
          commandStatus(
            style,
            `dev workspace check ${row.taskId}`,
            'The workspace assessment failed.'
          ),
        ]
      case 'task-deferred':
        return [
          commandStatus(
            style,
            `dev workspace check ${row.taskId}`,
            'The sweep ran out of time before assessing this task.'
          ),
        ]
      case 'sweep-failure':
        return [
          commandStatus(
            style,
            'dev workspace list',
            'The sweep failed before every task could be assessed.'
          ),
        ]
      case 'workspace':
        return []
    }
  })
  const summary =
    successes(rows, style) ||
    (receipt.rows.length === 0 ? 'No reserved workspaces' : 'No workspaces removed')
  return [
    `${summary}${paint(style, 'dim', ` · ${seconds(elapsedMs)}`)}`,
    ...blocks(remaining.filter(row => offered.has(row.taskId))),
    ...(unavailable.length === 0
      ? []
      : [paint(style, 'bold', 'Not included in the quick release:'), ...blocks(unavailable)]),
    ...unassessed,
  ].join('\n\n')
}

export const quitReleaseExclusion = (
  receipt: SweepReceipt,
  views: readonly WorkspaceView[]
): string | undefined => {
  const assessed = new Set(workspaceRows(receipt).map(row => row.workspaceId))
  if (views.some(view => !assessed.has(view.workspaceId)))
    return 'The task has workspaces that this sweep did not assess.'
  if (views.some(view => view.uses.some(use => use.stage !== 'quiescent')))
    return 'The task has an active or unresolved workspace use.'
  if (views.length === 0) return 'The task no longer has any workspace reservations.'
  return undefined
}

export interface TaskReleasePlan {
  readonly taskId: WorkspaceId
  readonly views: readonly WorkspaceView[]
}

export const formatQuitReleasePlan = (
  plans: readonly TaskReleasePlan[],
  style: TerminalStyle
): string => {
  const views = plans.flatMap(plan => plan.views)
  const managed = views.filter(view => view.origin === 'managed').length
  const existing = views.length - managed
  const scope = [
    ...(managed === 0 ? [] : [count(managed, 'managed worktree')]),
    ...(existing === 0 ? [] : [count(existing, 'checkout reservation')]),
  ].join(', ')
  return [
    '',
    paint(style, 'bold', `Release ${count(plans.length, 'task')} (${scope})?`),
    ...(managed === 0
      ? []
      : [
          paint(
            style,
            'fail',
            'This deletes all their managed worktrees, including uncommitted changes and undelivered commits.'
          ),
        ]),
    ...(existing === 0
      ? []
      : ['Pre-existing checkouts keep their files and commits; only their reservations end.']),
  ].join('\n')
}

export const formatQuitReleasePrompt = (style: TerminalStyle): string =>
  paint(style, 'warn', '[y = release, Enter = keep] ')

export const formatQuitSweepFailure = (style: TerminalStyle): string =>
  commandStatus(
    style,
    'dev workspace list',
    'The sweep did not report back; its outcome is unknown.'
  )

export const formatQuitReleaseFailure = (
  taskId: WorkspaceId,
  outcome: 'failed' | 'unreported',
  style: TerminalStyle
): string =>
  commandStatus(
    style,
    `dev workspace release ${taskId}`,
    outcome === 'failed'
      ? 'The release failed; its recorded outcome needs review.'
      : 'The release did not report back; its outcome is unknown.'
  )

export const formatQuitReleaseResults = (
  taskId: WorkspaceId,
  results: readonly WorkspaceReleaseResult[],
  style: TerminalStyle
): string =>
  [
    successes(results, style),
    ...results
      .filter(result => result.outcome === 'failed')
      .map(() => formatQuitReleaseFailure(taskId, 'failed', style)),
  ]
    .filter(text => text.length > 0)
    .join('\n\n')

export const formatExitLine = (style: TerminalStyle, code: number, text: string): string =>
  paint(style, code === 0 ? 'ok' : 'fail', `Exit ${code}: ${text}.`)
