import { Effect, Option, Schema } from 'effect'
import {
  WorkspaceId,
  type CompletionVerdict,
  type SweepReceipt,
  type SweepRow,
  type WorkspaceAssessment,
  type WorkspaceConversation,
  type WorkspaceError,
  type WorkspaceLifecycle,
  type WorkspaceReleaseResult,
  type WorkspaceSelection,
  type WorkspaceView,
} from './workspace-domain.ts'

export type WorkspaceCommand =
  | { readonly kind: 'list' }
  | { readonly kind: 'inspect'; readonly taskId: WorkspaceId }
  | { readonly kind: 'check'; readonly taskId: WorkspaceId }
  | { readonly kind: 'release'; readonly taskId: WorkspaceId }

type ReadOnlyWorkspaceCommand = Exclude<WorkspaceCommand, { readonly kind: 'release' }>

export interface WorkspaceCommandResult {
  readonly exitCode: 0 | 1 | 2
  readonly text: string
}

interface WorkspaceListScope<R = never> {
  readonly repositoryRoot: Effect.Effect<string | undefined, never, R>
  readonly current?: {
    readonly workspaceId: WorkspaceId
    readonly effectiveCwd: string
    readonly conversation?: WorkspaceConversation
  }
}

export interface ResumeCandidate {
  readonly selection: WorkspaceSelection
  readonly view: WorkspaceView
}

export class WorkspaceCommandError extends Schema.TaggedError<WorkspaceCommandError>()(
  'WorkspaceCommandError',
  { message: Schema.String, exitCode: Schema.Literals([1, 2]) }
) {}

const usage = (message: string): WorkspaceCommandError =>
  new WorkspaceCommandError({ message, exitCode: 2 })

const decodeId = Schema.decodeUnknownOption(WorkspaceId)
const exactId = Effect.fnUntraced(function* (
  value: string | undefined,
  name: string
): Effect.fn.Return<WorkspaceId, WorkspaceCommandError> {
  const decoded = decodeId(value)
  if (Option.isNone(decoded))
    return yield* usage(
      `${name} must be an exact ID as listed by dev workspace, got ${JSON.stringify(value ?? '')}`
    )
  return decoded.value
})

const noTaskRecords = (taskId: string): string =>
  `No workspace records exist for exact task ${taskId}.`

export const parseWorkspaceCommand = Effect.fnUntraced(function* (
  tokens: readonly string[]
): Effect.fn.Return<WorkspaceCommand, WorkspaceCommandError> {
  if (tokens.length === 0) return { kind: 'list' }
  const [verb, ...args] = tokens
  if (verb === 'list') {
    if (args.length !== 0) return yield* usage('Usage: workspace [list]')
    return { kind: 'list' }
  }
  if (verb === 'inspect') {
    if (args.length !== 1) return yield* usage('Usage: workspace inspect <task>')
    return { kind: 'inspect', taskId: yield* exactId(args[0], 'Task') }
  }
  if (verb === 'check') {
    if (args.length !== 1) return yield* usage('Usage: workspace check <task>')
    return { kind: 'check', taskId: yield* exactId(args[0], 'Task') }
  }
  if (verb === 'release') {
    if (args.length !== 1)
      return yield* usage(
        'Usage: workspace release <task> (interactive confirmation; no unattended mode exists)'
      )
    return { kind: 'release', taskId: yield* exactId(args[0], 'Task') }
  }
  return yield* usage(
    `Unknown workspace command ${JSON.stringify(verb)}. Use list, inspect <task>, check <task> or release <task>.`
  )
})

const sortedViews = (views: readonly WorkspaceView[]): WorkspaceView[] =>
  views.toSorted(
    (left, right) =>
      left.repositoryId.localeCompare(right.repositoryId) ||
      left.workspaceId.localeCompare(right.workspaceId)
  )

const usesText = (view: WorkspaceView): string[] => {
  if (view.uses.length === 0) return ['  uses: none recorded']
  return view.uses.map(({ execution, id, access, stage, logsAvailable }) => {
    const attempt = execution === undefined ? '' : `; attempt ${execution.attemptId}`
    let logs = '; log availability not recorded'
    if (logsAvailable === true) {
      logs = `; logs available${execution?.logs === undefined ? '' : ` at ${execution.logs}`}`
    } else if (logsAvailable === false) {
      logs = '; logs unavailable (expired or removed)'
    } else if (execution?.logs !== undefined) {
      logs = `; log availability unknown (reference ${execution.logs})`
    }
    return `  use ${id}: ${access}, ${stage}${attempt}${logs}`
  })
}

const viewText = (view: WorkspaceView, currentWorkspaceId?: string): string[] => [
  `task ${view.taskId ?? '(unassigned)'} — workspace ${view.workspaceId}${view.workspaceId === currentWorkspaceId ? ' [current binding]' : ''}`,
  `  repository: ${view.repositoryId}`,
  `  path: ${view.path}`,
  `  origin: ${view.origin}`,
  `  reservation: ${view.reservationId ?? 'none reported'}`,
  `  outcome: ${view.outcome}`,
  `  reason: ${view.reason}`,
  `  next: ${view.nextAction}`,
  ...usesText(view),
  ...(view.pending.length === 0
    ? ['  pending operations: none recorded']
    : [
        '  pending operations:',
        ...view.pending.map(item => `    ${item.id}: ${item.kind} (${item.stage})`),
      ]),
]

const formatWorkspaceViews = (views: readonly WorkspaceView[]): string => {
  const rows = sortedViews(views)
  if (rows.length === 0) return 'No workspace records were found for this selection.'
  return rows.flatMap(view => viewText(view)).join('\n')
}

const formatWorkspaceList = (
  views: readonly WorkspaceView[],
  repositoryRoot: string,
  current: WorkspaceListScope['current']
): string => {
  const rows = sortedViews(views)
  const header = [
    `Workspace list for repository ${repositoryRoot}:`,
    ...(current === undefined
      ? []
      : [`Current binding: ${current.workspaceId}`, `Effective cwd: ${current.effectiveCwd}`]),
  ]
  if (rows.length === 0) return `${header.join('\n')}\nNo workspace records were found.`
  return [...header, ...rows.flatMap(view => viewText(view, current?.workspaceId))].join('\n')
}

export const resumeCandidates = (
  exactTaskViews: readonly WorkspaceView[],
  taskId: WorkspaceId
): readonly ResumeCandidate[] =>
  sortedViews(exactTaskViews)
    .filter(view => view.outcome === 'preserved-for-resume')
    .map(view => ({ selection: { taskId, workspaceId: view.workspaceId }, view }))

const sortedAssessments = (assessments: readonly WorkspaceAssessment[]) =>
  assessments.toSorted(
    (left, right) =>
      left.repositoryId.localeCompare(right.repositoryId) ||
      left.workspaceId.localeCompare(right.workspaceId)
  )

const ROLE_TEXT: Record<CompletionVerdict['role'], string> = {
  'pre-existing': 'pre-existing checkout',
  branch: 'branch worktree',
  child: 'delegated child worktree',
  detached: 'detached worktree',
}
const verdictText = (verdict: CompletionVerdict): string =>
  verdict.kind === 'finished'
    ? `finished (${verdict.rule}): ${verdict.reason}`
    : `retained (${verdict.retained}): ${verdict.reason}`

const assessmentText = (assessment: WorkspaceAssessment): string[] => [
  `workspace ${assessment.workspaceId} (${assessment.origin}) at ${assessment.path}`,
  `  repository: ${assessment.repositoryId}; reservation: ${assessment.reservationId}`,
  `  role: ${ROLE_TEXT[assessment.completion.role]}`,
  `  target: ${assessment.target.source}; ${assessment.target.description}`,
  `  sweep verdict: ${verdictText(assessment.completion)}`,
  ...assessment.reasons.map(reason => `  - ${reason}`),
  ...(assessment.evidence === undefined ? [] : [`  evidence: ${assessment.evidence.verdict}`]),
  ...(assessment.inventory === undefined
    ? []
    : [
        `  inventory: ${assessment.inventory.trackedChanges} tracked change(s), ${assessment.inventory.files} untracked or ignored file(s); ${assessment.inventory.published} matched publication(s), ${assessment.inventory.disposable} disposable untracked file(s), ${assessment.inventory.blocking} blocking entry(s)`,
      ]),
  ...assessment.residual.map(item => `  residual: ${item}`),
  ...assessment.nextActions.map(action => `  next: ${action}`),
]

export const formatAssessments = (
  taskId: WorkspaceId,
  assessments: readonly WorkspaceAssessment[]
): string => {
  if (assessments.length === 0) return noTaskRecords(taskId)
  return [
    `Sweep assessment for exact task ${taskId} (a check changes nothing; the sweep at quit or before a worktree allocation rechecks everything):`,
    ...sortedAssessments(assessments).flatMap(assessmentText),
  ].join('\n')
}

export const reservedViews = (views: readonly WorkspaceView[]): readonly WorkspaceView[] =>
  sortedViews(views).filter(
    view =>
      view.reservationId !== undefined && view.outcome !== 'released' && view.outcome !== 'removed'
  )

export const releasePlan = (taskId: WorkspaceId, views: readonly WorkspaceView[]): string =>
  [
    `dev workspace release clears every workspace of task ${taskId}, whatever the sweep verdict:`,
    ...views.map(
      view =>
        `- ${view.workspaceId} (${view.origin}) at ${view.path}: ${
          view.origin === 'managed'
            ? 'the worktree and everything in it are deleted'
            : 'only the reservation ends; files and commits stay'
        }`
    ),
  ].join('\n')

export const releaseExitCode = (results: readonly WorkspaceReleaseResult[]): 0 | 1 =>
  results.length > 0 && results.every(result => result.outcome !== 'failed') ? 0 : 1

export const formatReleaseResults = (
  taskId: WorkspaceId,
  results: readonly WorkspaceReleaseResult[]
): string =>
  [
    `Release of task ${taskId}:`,
    ...results.flatMap(result => [
      `workspace ${result.workspaceId} (${result.origin}) at ${result.path}: ${result.outcome}`,
      `  ${result.reason}`,
    ]),
  ].join('\n')

type WorkspaceRow = Extract<SweepRow, { readonly kind: 'workspace' }>

const sweepRowText = (row: SweepRow): string[] => {
  switch (row.kind) {
    case 'sweep-failure':
      return [`repository: review-required`, `  ${row.reason}`]
    case 'task-failure':
      return [`task ${row.taskId}: review-required`, `  ${row.reason}`]
    case 'task-deferred':
      return [`task ${row.taskId}: deferred`, `  ${row.reason}`]
    case 'workspace': {
      const attempted = row.verdict.kind === 'finished'
      return [
        `workspace ${row.workspaceId} (${row.origin}) at ${row.path}, task ${row.taskId}: ${row.outcome}${attempted ? ' (automatic)' : ''}`,
        `  verdict: ${verdictText(row.verdict)}`,
        ...(attempted ? [`  ${row.reason}`] : []),
        ...(row.operationId === undefined ? [] : [`  operation: ${row.operationId}`]),
      ]
    }
  }
}

const attemptedRows = (receipt: SweepReceipt): readonly WorkspaceRow[] =>
  receipt.rows.filter(
    (row): row is WorkspaceRow => row.kind === 'workspace' && row.verdict.kind === 'finished'
  )

const TERMINAL_SWEEP_OUTCOMES: ReadonlySet<WorkspaceRow['outcome']> = new Set([
  'removed',
  'released',
])
export const sweepExitCode = (receipt: SweepReceipt): 0 | 1 =>
  attemptedRows(receipt).every(row => TERMINAL_SWEEP_OUTCOMES.has(row.outcome)) ? 0 : 1

export const formatSweepReceipt = (receipt: SweepReceipt): string => {
  const moment = receipt.moment === 'quit' ? 'at quit' : 'before a worktree allocation'
  if (receipt.rows.length === 0) return `Workspace sweep ${moment}: no reserved workspace.`
  const attempted = attemptedRows(receipt)
  const terminal = attempted.filter(row => TERMINAL_SWEEP_OUTCOMES.has(row.outcome)).length
  const deferred = receipt.rows.filter(row => row.kind === 'task-deferred').length
  return [
    `Workspace sweep ${moment} (automatic; decided by observable completion):`,
    ...receipt.rows.flatMap(sweepRowText),
    `Summary: ${terminal}/${attempted.length} finished workspace(s) reached a terminal outcome; ${receipt.rows.length - attempted.length - deferred} retained or skipped${deferred === 0 ? '' : `; ${deferred} task(s) deferred to the next sweep`}.`,
  ].join('\n')
}

export const runReadOnlyWorkspaceCommand = Effect.fnUntraced(
  function* <R, RootR>(
    openLifecycle: Effect.Effect<WorkspaceLifecycle, never, R>,
    command: ReadOnlyWorkspaceCommand,
    scope: WorkspaceListScope<RootR>
  ): Effect.fn.Return<WorkspaceCommandResult, WorkspaceError, R | RootR> {
    if (command.kind === 'check') {
      const lifecycle = yield* openLifecycle
      const assessments = yield* lifecycle.check({
        taskId: command.taskId,
        ...(scope.current?.conversation === undefined
          ? {}
          : { ownConversation: scope.current.conversation }),
      })

      return { exitCode: 0, text: formatAssessments(command.taskId, assessments) }
    }
    if (command.kind === 'inspect') {
      const lifecycle = yield* openLifecycle
      const views = yield* lifecycle.inspect({ taskId: command.taskId })
      return {
        exitCode: 0,
        text:
          views.length === 0
            ? noTaskRecords(command.taskId)
            : `Workspace records for exact task ${command.taskId}: ${formatWorkspaceViews(views)}`,
      }
    }
    const repositoryRoot = yield* scope.repositoryRoot
    if (repositoryRoot === undefined)
      return {
        exitCode: 2,
        text: 'Workspace list requires a Git repository; run dev from a Git checkout or pass --cwd PATH.',
      }
    const lifecycle = yield* openLifecycle
    const views = yield* lifecycle.inspect({ cwd: repositoryRoot })
    return { exitCode: 0, text: formatWorkspaceList(views, repositoryRoot, scope.current) }
  },
  Effect.catch(cause =>
    Effect.succeed<WorkspaceCommandResult>({
      exitCode: 1,
      text: `Workspace inspection failed: ${cause.message}`,
    })
  )
)
