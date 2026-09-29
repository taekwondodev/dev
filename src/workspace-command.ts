import { Cause, Effect, Exit, Schema } from 'effect'
import { errorText } from './error-text.ts'
import {
  WorkspaceId,
  type CompletionVerdict,
  type ReleaseSubject,
  type SweepReceipt,
  type SweepRow,
  type WorkspaceAssessment,
  type WorkspaceConversation,
  WorkspaceError,
  type WorkspaceLifecycle,
  type WorkspaceReleaseResult,
  type WorkspaceSelection,
  type WorkspaceView,
} from './workspace-domain.ts'
import { newId } from './workspace-platform.ts'

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

interface WorkspaceListScope {
  readonly repositoryRoot: Effect.Effect<string | undefined>
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
  if (decoded._tag === 'None')
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

const consequenceOf = (assessment: WorkspaceAssessment): string => {
  switch (assessment.subject.effect) {
    case 'release-reservation':
      return 'release would end the task reservation only; every file and commit stays'
    case 'remove-worktree':
      return assessment.outcome === 'removable'
        ? 'release would delete this managed worktree, its uncommitted edits, untracked/ignored contents and Git registration; undelivered or unselected contents will be lost'
        : 'release would reconcile the registration and reservation of the absent directory'
    case 'none':
      return 'release would change nothing here; the blockers above stay'
  }
}

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
  `  eligibility: ${assessment.outcome}`,
  ...assessment.reasons.map(reason => `  - ${reason}`),
  ...(assessment.evidence === undefined ? [] : [`  evidence: ${assessment.evidence.verdict}`]),
  ...(assessment.inventory === undefined
    ? []
    : [
        `  inventory: ${assessment.inventory.trackedChanges} tracked change(s), ${assessment.inventory.files} untracked or ignored file(s); ${assessment.inventory.published} matched publication(s), ${assessment.inventory.disposable} disposable untracked file(s), ${assessment.inventory.blocking} blocking entry(s)`,
      ]),
  ...assessment.residual.map(item => `  residual: ${item}`),
  `  consequence: ${consequenceOf(assessment)}`,
  ...assessment.nextActions.map(action => `  next: ${action}`),
]

export const formatAssessments = (
  taskId: WorkspaceId,
  assessments: readonly WorkspaceAssessment[]
): string => {
  if (assessments.length === 0) return noTaskRecords(taskId)
  return [
    `Release eligibility for exact task ${taskId} (a check grants nothing; the sweep at quit or before a worktree allocation rechecks everything):`,
    ...sortedAssessments(assessments).flatMap(assessmentText),
  ].join('\n')
}

export const needsExplicitRelease = (assessments: readonly WorkspaceAssessment[]): boolean =>
  assessments.some(assessment => assessment.outcome === 'review-required')

export const noExplicitRelease = (taskId: WorkspaceId): string =>
  `No workspace of task ${taskId} is review-required, so there is nothing for an explicit release. Finished workspaces are released automatically when dev quits or before it allocates a worktree; the others stay retained with the reason above.`

const confirmationLines = (assessment: WorkspaceAssessment): string[] => {
  const lines = [
    `- ${assessment.workspaceId} (${assessment.origin}) at ${assessment.path}`,
    `  now: ${assessment.outcome}${assessment.reasons.length > 0 ? `; ${assessment.reasons[0]}` : ''}`,
  ]
  if (assessment.evidence !== undefined)
    lines.push(
      `  evidence: ${assessment.evidence.verdict}${assessment.evidence.reasons.length > 0 ? `; ${assessment.evidence.reasons[0]}` : ''}`
    )
  lines.push(`  ${consequenceOf(assessment)}`)
  return lines
}

export const releaseConfirmation = (
  taskId: WorkspaceId,
  assessments: readonly WorkspaceAssessment[]
): { readonly title: string; readonly message: string } => {
  const lines = [
    `Task ${taskId}: one release attempt for exactly the ${assessments.length} workspace(s) below. Each is rechecked and evaluated independently; a workspace added or rebound after this confirmation is not included.`,
    '',
    ...sortedAssessments(assessments).flatMap(confirmationLines),
    '',
    'Eligible dev-created worktrees may be deleted; pre-existing checkout files are never touched. No automatic retry follows a blocked workspace.',
  ]
  return { title: `Release task ${taskId}?`, message: lines.join('\n') }
}

export const TERMINAL_RELEASE_OUTCOMES: ReadonlySet<WorkspaceReleaseResult['outcome']> = new Set([
  'released',
  'removed',
  'already-absent',
])

export interface ReleaseRun {
  readonly commandId: WorkspaceId
  readonly results: readonly WorkspaceReleaseResult[]
}

const withoutEffects = (
  assessment: WorkspaceAssessment,
  outcome: 'blocked' | 'review-required',
  reason: string,
  nextAction: string
): WorkspaceReleaseResult => ({
  repositoryId: assessment.repositoryId,
  workspaceId: assessment.workspaceId,
  path: assessment.path,
  origin: assessment.origin,
  outcome,
  reason,
  nextAction,
  effects: [],
  retained: [],
})

const failedAttempt = (
  taskId: WorkspaceId,
  assessment: WorkspaceAssessment,
  cause: unknown
): WorkspaceReleaseResult =>
  cause instanceof WorkspaceError && cause.outcome === 'invalid'
    ? withoutEffects(
        assessment,
        'blocked',
        `The authority refused this attempt before any effect: ${errorText(cause)}`,
        'Run check and a fresh release.'
      )
    : withoutEffects(
        assessment,
        'review-required',
        `The outcome of this attempt was not received (${errorText(cause)}); its effect may already have happened.`,
        `Inspect task ${taskId} to see what happened before any fresh release.`
      )

export const runRelease = Effect.fnUntraced(function* (
  lifecycle: WorkspaceLifecycle,
  input: {
    readonly taskId: WorkspaceId
    readonly confirmed: readonly WorkspaceAssessment[]
    readonly occupiedPaths: readonly string[]
    readonly commandId?: WorkspaceId
    readonly proceed?: () => boolean
  }
): Effect.fn.Return<ReleaseRun> {
  const commandId = input.commandId ?? newId()
  const decided: readonly ReleaseSubject[] = input.confirmed.map(assessment => assessment.subject)
  const results: WorkspaceReleaseResult[] = []
  let stopped = false
  for (const assessment of sortedAssessments(input.confirmed)) {
    if (stopped) {
      results.push(
        withoutEffects(
          assessment,
          'blocked',
          'The release stopped at an earlier workspace, so this one was not attempted; nothing was changed here.',
          `Inspect task ${input.taskId}, then run a fresh release.`
        )
      )
      continue
    }
    if (input.proceed !== undefined && !input.proceed()) {
      results.push(
        withoutEffects(
          assessment,
          'blocked',
          'The command was cancelled before this workspace was attempted; nothing was changed here.',
          'Run a fresh release when ready.'
        )
      )
      continue
    }
    const attempt = yield* Effect.exit(
      lifecycle.release({
        taskId: input.taskId,
        commandId,
        decided,
        decider: { kind: 'user' },
        workspaceId: assessment.workspaceId,
        occupiedPaths: input.occupiedPaths,
      })
    )
    if (Exit.isSuccess(attempt)) {
      results.push(attempt.value)
      continue
    }
    stopped = true
    results.push(failedAttempt(input.taskId, assessment, Cause.squash(attempt.cause)))
  }
  return { commandId, results }
})

export const releaseExitCode = (run: ReleaseRun): 0 | 1 =>
  run.results.length > 0 &&
  run.results.every(result => TERMINAL_RELEASE_OUTCOMES.has(result.outcome))
    ? 0
    : 1

const incompleteLabel = (results: readonly WorkspaceReleaseResult[]): string => {
  if (results.every(result => result.outcome === 'blocked' && result.effects.length === 0))
    return 'nothing was changed'
  if (
    results.some(
      result =>
        TERMINAL_RELEASE_OUTCOMES.has(result.outcome) ||
        result.outcome === 'partial' ||
        result.effects.length > 0
    )
  )
    return 'partial'
  return 'review required'
}

export const formatReleaseRun = (taskId: WorkspaceId, run: ReleaseRun): string => {
  const lines = [`Release of task ${taskId} confirmed by the user, command ${run.commandId}:`]
  for (const result of run.results) {
    lines.push(
      `workspace ${result.workspaceId} (${result.origin}) at ${result.path}: ${result.outcome}`,
      `  ${result.reason}`,
      ...result.effects.map(effect => `  effect: ${effect}`),
      ...result.retained.map(item => `  retained: ${item}`),
      ...(result.operationId === undefined ? [] : [`  operation: ${result.operationId}`]),
      `  next: ${result.nextAction}`
    )
  }
  const terminal = run.results.filter(result =>
    TERMINAL_RELEASE_OUTCOMES.has(result.outcome)
  ).length
  lines.push(
    releaseExitCode(run) === 0
      ? `Summary: every confirmed workspace reached a terminal outcome (${terminal}/${run.results.length}).`
      : `Summary: ${incompleteLabel(run.results)}. ${terminal}/${run.results.length} workspace(s) reached a terminal outcome; each workspace above says what happened and what to do next. A repeated release is a fresh command with fresh checks.`
  )
  return lines.join('\n')
}

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

export const attemptedRows = (receipt: SweepReceipt): readonly WorkspaceRow[] =>
  receipt.rows.filter(
    (row): row is WorkspaceRow => row.kind === 'workspace' && row.verdict.kind === 'finished'
  )

const TERMINAL_SWEEP_OUTCOMES: ReadonlySet<WorkspaceRow['outcome']> = new Set([
  'removed',
  'released',
  'already-absent',
])
export const sweepExitCode = (receipt: SweepReceipt): 0 | 1 =>
  attemptedRows(receipt).every(row => TERMINAL_SWEEP_OUTCOMES.has(row.outcome)) ? 0 : 1

export const formatSweepReceipt = (receipt: SweepReceipt): string => {
  const moment = receipt.moment === 'quit' ? 'at quit' : 'before a worktree allocation'
  if (receipt.rows.length === 0)
    return `Workspace sweep ${moment}, command ${receipt.commandId}: no reserved workspace.`
  const attempted = attemptedRows(receipt)
  const terminal = attempted.filter(row => TERMINAL_SWEEP_OUTCOMES.has(row.outcome)).length
  const deferred = receipt.rows.filter(row => row.kind === 'task-deferred').length
  return [
    `Workspace sweep ${moment}, command ${receipt.commandId} (automatic; decided by observable completion):`,
    ...receipt.rows.flatMap(sweepRowText),
    `Summary: ${terminal}/${attempted.length} finished workspace(s) reached a terminal outcome; ${receipt.rows.length - attempted.length - deferred} retained or skipped${deferred === 0 ? '' : `; ${deferred} task(s) deferred to the next sweep`}.`,
  ].join('\n')
}

export const runReadOnlyWorkspaceCommand = Effect.fnUntraced(
  function* <R>(
    openLifecycle: Effect.Effect<WorkspaceLifecycle, never, R>,
    command: ReadOnlyWorkspaceCommand,
    scope: WorkspaceListScope
  ): Effect.fn.Return<WorkspaceCommandResult, WorkspaceError, R> {
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
