import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { Clock, Effect, type Scope } from 'effect'
import { RETAINED } from './workspace-completion.ts'
import type {
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

const HOME = homedir()
const pathText = (style: TerminalStyle, path: string): string => {
  const shown = path === HOME || path.startsWith(`${HOME}/`) ? `~${path.slice(HOME.length)}` : path
  return style.ghostty ? `\x1b]8;;${pathToFileURL(path).href}\x1b\\${shown}\x1b]8;;\x1b\\` : shown
}

const shortId = (id: WorkspaceId): string => id.slice(0, 8)

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
type Attention = 'done' | 'release' | 'unfinished' | 'action' | 'none'

const attentionOf = (row: WorkspaceRow): Attention => {
  if (row.outcome === 'removed' || row.outcome === 'released') return 'done'
  if (row.outcome === 'review-required') return 'release'
  if (row.verdict.kind === 'finished') return 'unfinished'
  return RETAINED[row.verdict.retained].attention
}

const workspaceRows = (receipt: SweepReceipt): readonly WorkspaceRow[] =>
  receipt.rows.filter((row): row is WorkspaceRow => row.kind === 'workspace')

const unique = (ids: readonly WorkspaceId[]): readonly WorkspaceId[] => [...new Set(ids)]

export const tasksToRelease = (receipt: SweepReceipt): readonly WorkspaceId[] =>
  unique(
    workspaceRows(receipt)
      .filter(row => attentionOf(row) === 'release')
      .map(row => row.taskId)
  )

const tasksToCheck = (receipt: SweepReceipt): readonly WorkspaceId[] =>
  unique(receipt.rows.flatMap(row => (row.kind === 'task-failure' ? [row.taskId] : [])))

const LABEL_WIDTH = 12
const headline = (
  style: TerminalStyle,
  tone: Tone,
  mark: string,
  label: string,
  rest: string
): string => `${paint(style, tone, `${mark} ${label.padEnd(LABEL_WIDTH)}`)} ${rest}`

const detail = (style: TerminalStyle, text: string): string => `    ${paint(style, 'dim', text)}`

const where = (style: TerminalStyle, row: WorkspaceRow): string =>
  `${pathText(style, row.path)}  ${paint(style, 'dim', `task ${shortId(row.taskId)}`)}`

const workspaceLines = (style: TerminalStyle, row: WorkspaceRow): readonly string[] => {
  switch (attentionOf(row)) {
    case 'done': {
      const rule = row.verdict.kind === 'finished' ? `  (${row.verdict.rule})` : ''
      return [
        headline(style, 'ok', '✓', row.outcome, `${where(style, row)}${paint(style, 'dim', rule)}`),
      ]
    }
    case 'release':
      return [headline(style, 'fail', '✗', 'review', where(style, row)), detail(style, row.reason)]
    case 'unfinished':
      return [
        headline(style, 'warn', '!', row.outcome, where(style, row)),
        detail(style, row.reason),
      ]
    case 'action': {
      const next =
        row.verdict.kind === 'retained' ? RETAINED[row.verdict.retained].actions[0] : undefined
      return [
        headline(style, 'dim', '·', 'kept', where(style, row)),
        detail(style, row.reason),
        ...(next === undefined ? [] : [detail(style, `next: ${next}`)]),
      ]
    }
    case 'none':
      return []
  }
}

const quietSummary = (style: TerminalStyle, rows: readonly WorkspaceRow[]): readonly string[] => {
  const counts = new Map<string, number>()
  for (const row of rows) {
    if (attentionOf(row) !== 'none' || row.verdict.kind !== 'retained') continue
    counts.set(row.verdict.retained, (counts.get(row.verdict.retained) ?? 0) + 1)
  }
  if (counts.size === 0) return []
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0)
  const reasons = [...counts.entries()]
    .map(([reason, count]) => (count === 1 ? reason : `${reason} ×${count}`))
    .join(', ')
  return [paint(style, 'dim', `· ${total} retained (${reasons})`)]
}

const commandBlock = (
  style: TerminalStyle,
  title: string,
  command: string,
  taskIds: readonly WorkspaceId[]
): readonly string[] =>
  taskIds.length === 0
    ? []
    : [
        paint(style, 'bold', title),
        ...taskIds.map(taskId => `  ${paint(style, 'warn', `${command} ${taskId}`)}`),
      ]

const TERMINAL_OUTCOMES: ReadonlySet<WorkspaceRow['outcome']> = new Set(['removed', 'released'])

export const formatQuitReceipt = (
  receipt: SweepReceipt,
  elapsedMs: number,
  style: TerminalStyle
): string => {
  const rows = workspaceRows(receipt)
  const attempted = rows.filter(row => row.verdict.kind === 'finished')
  const terminal = attempted.filter(row => TERMINAL_OUTCOMES.has(row.outcome)).length
  const deferred = receipt.rows.filter(row => row.kind === 'task-deferred').length
  const actions = receipt.rows.filter(
    row => row.kind !== 'workspace' || attentionOf(row) !== 'action'
  )
  const kept = rows.filter(row => attentionOf(row) === 'action')
  const lines = [...actions, ...kept].flatMap((row): readonly string[] => {
    switch (row.kind) {
      case 'workspace':
        return workspaceLines(style, row)
      case 'task-failure':
        return [
          headline(style, 'fail', '✗', 'not assessed', paint(style, 'dim', `task ${row.taskId}`)),
          detail(style, row.reason),
        ]
      case 'task-deferred':
        return []
      case 'sweep-failure':
        return [headline(style, 'fail', '✗', 'sweep failed', ''), detail(style, row.reason)]
    }
  })
  const summary =
    receipt.rows.length === 0
      ? 'no reserved workspace'
      : `${terminal}/${attempted.length} finished workspace(s) reached a terminal outcome`
  return [
    paint(style, 'bold', 'Workspace sweep at quit'),
    ...lines,
    ...quietSummary(style, rows),
    ...(deferred === 0
      ? []
      : [paint(style, 'dim', `· ${deferred} task(s) deferred to the next sweep (time budget)`)]),
    paint(style, 'dim', `${summary} · ${seconds(elapsedMs)}`),
    ...commandBlock(style, 'Release required:', 'dev workspace release', tasksToRelease(receipt)),
    ...commandBlock(
      style,
      'Assessment failed, check:',
      'dev workspace check',
      tasksToCheck(receipt)
    ),
  ].join('\n')
}

export interface TaskReleasePlan {
  readonly taskId: WorkspaceId
  readonly views: readonly WorkspaceView[]
}

export const formatQuitReleasePlan = (
  plans: readonly TaskReleasePlan[],
  style: TerminalStyle
): string =>
  [
    paint(
      style,
      'bold',
      `${plans.length} task(s) need a release; it clears every workspace of each task:`
    ),
    ...plans.flatMap(({ taskId, views }) =>
      views.map(
        view =>
          `  ${paint(style, 'dim', `task ${shortId(taskId)}`)}  ${pathText(style, view.path)}  ${
            view.origin === 'managed'
              ? paint(style, 'fail', 'the worktree and everything in it are deleted')
              : paint(style, 'dim', 'only the reservation ends; files and commits stay')
          }`
      )
    ),
  ].join('\n')

export const formatQuitReleaseResults = (
  taskId: WorkspaceId,
  results: readonly WorkspaceReleaseResult[],
  style: TerminalStyle
): string =>
  results
    .flatMap(result => {
      const rest = `${pathText(style, result.path)}  ${paint(style, 'dim', `task ${shortId(taskId)}`)}`
      return result.outcome === 'failed'
        ? [headline(style, 'fail', '✗', 'failed', rest), detail(style, result.reason)]
        : [headline(style, 'ok', '✓', result.outcome, rest)]
    })
    .join('\n')

export const formatExitLine = (style: TerminalStyle, code: number, text: string): string =>
  paint(style, code === 0 ? 'ok' : 'fail', `Exit ${code}: ${text}.`)
