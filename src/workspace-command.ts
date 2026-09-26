import { Effect, Schema } from 'effect'
import {
  WorkspaceId,
  type WorkspaceLifecycle,
  type WorkspaceSelection,
  type WorkspaceView,
} from './workspace-domain.ts'

export type WorkspaceCommand =
  | { readonly kind: 'list' }
  | { readonly kind: 'inspect'; readonly taskId: string }
  | {
      readonly kind: 'resume'
      readonly taskId: string
      readonly workspaceId?: string
    }

export interface WorkspaceCommandResult {
  readonly exitCode: 0 | 1 | 2 | 130
  readonly stdout?: string
  readonly stderr?: string
}

export interface ResumeCandidate {
  readonly selection: WorkspaceSelection
  readonly view: WorkspaceView
}

export class WorkspaceCommandError extends Schema.TaggedError<WorkspaceCommandError>()(
  'WorkspaceCommandError',
  { message: Schema.String, exitCode: Schema.Literals([1, 2, 130]) }
) {}

const usage = (message: string): WorkspaceCommandError =>
  new WorkspaceCommandError({ message, exitCode: 2 })

const isWorkspaceId = Schema.is(WorkspaceId)
const exactId = (value: string | undefined, name: string): string => {
  if (value === undefined || !isWorkspaceId(value))
    throw usage(
      `${name} must be an exact ID as listed by dev workspace, got ${JSON.stringify(value ?? '')}`
    )
  return value
}

const noTaskRecords = (taskId: string): string =>
  `No workspace records exist for exact task ${taskId}.`

export const parseWorkspaceCommand = (tokens: readonly string[]): WorkspaceCommand => {
  if (tokens.length === 0) return { kind: 'list' }
  const [verb, ...args] = tokens
  if (verb === 'list') {
    if (args.length !== 0) throw usage('Usage: workspace [list]')
    return { kind: 'list' }
  }
  if (verb === 'inspect') {
    if (args.length !== 1) throw usage('Usage: workspace inspect <task>')
    return { kind: 'inspect', taskId: exactId(args[0], 'Task') }
  }
  if (verb === 'resume') {
    const taskId = exactId(args[0], 'Task')
    if (args.length === 1) return { kind: 'resume', taskId }
    if (args.length === 3 && args[1] === '--workspace')
      return { kind: 'resume', taskId, workspaceId: exactId(args[2], 'Workspace') }
    throw usage('Usage: workspace resume <task> [--workspace <workspace>]')
  }
  throw usage(
    `Unknown workspace command ${JSON.stringify(verb)}. Use list, inspect <task>, or resume <task> [--workspace <workspace>].`
  )
}

const sortedViews = (views: readonly WorkspaceView[]): WorkspaceView[] =>
  views.toSorted(
    (left, right) =>
      left.repositoryId.localeCompare(right.repositoryId) ||
      left.workspaceId.localeCompare(right.workspaceId)
  )

const taskIdentity = (view: WorkspaceView): string =>
  view.taskLabel === undefined || view.taskLabel === view.taskId
    ? `task ${view.taskId ?? '(unassigned)'}`
    : `task ${view.taskLabel} [${view.taskId}]`

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
  `${taskIdentity(view)} — workspace ${view.workspaceId}${view.workspaceId === currentWorkspaceId ? ' [current binding]' : ''}`,
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

export const formatWorkspaceViews = (
  views: readonly WorkspaceView[],
  options: { readonly currentWorkspaceId?: string; readonly effectiveCwd?: string } = {}
): string => {
  const rows = sortedViews(views)
  if (rows.length === 0) return 'No workspace records were found for this selection.'
  const header =
    options.currentWorkspaceId === undefined
      ? []
      : [
          `Current binding: ${options.currentWorkspaceId}`,
          `Effective cwd: ${options.effectiveCwd ?? '(unavailable)'}`,
        ]
  return [...header, ...rows.flatMap(view => viewText(view, options.currentWorkspaceId))].join('\n')
}

// The caller passes only the views of exactly this task.
export const formatWorkspaceInspect = (
  exactTaskViews: readonly WorkspaceView[],
  taskId: string
): string =>
  exactTaskViews.length === 0
    ? noTaskRecords(taskId)
    : `Workspace records for exact task ${taskId}: ${formatWorkspaceViews(exactTaskViews)}`

export const formatWorkspaceList = (
  views: readonly WorkspaceView[],
  repositoryRoot: string,
  options: { readonly currentWorkspaceId?: string; readonly effectiveCwd?: string } = {}
): string => {
  const rows = sortedViews(views)
  const header = [`Workspace list for repository ${repositoryRoot}:`]
  if (options.currentWorkspaceId !== undefined) {
    header.push(
      `Current binding: ${options.currentWorkspaceId}`,
      `Effective cwd: ${options.effectiveCwd ?? '(unavailable)'}`
    )
  }
  if (rows.length === 0) return `${header.join('\n')}\nNo workspace records were found.`
  return [...header, ...rows.flatMap(view => viewText(view, options.currentWorkspaceId))].join('\n')
}

export const resumeCandidates = (
  exactTaskViews: readonly WorkspaceView[],
  taskId: string
): readonly ResumeCandidate[] =>
  sortedViews(exactTaskViews)
    .filter(view => view.outcome === 'preserved-for-resume')
    .map(view => ({ selection: { taskId, workspaceId: view.workspaceId }, view }))

const choicesText = (candidates: readonly ResumeCandidate[]): string =>
  candidates.map(({ view }) => `  ${view.workspaceId}  ${view.path} (${view.origin})`).join('\n')

export const chooseResumeCandidate = (
  exactTaskViews: readonly WorkspaceView[],
  taskId: string,
  requestedWorkspaceId?: string
): ResumeCandidate => {
  const candidates = resumeCandidates(exactTaskViews, taskId)
  if (requestedWorkspaceId !== undefined) {
    const selected = candidates.find(
      candidate => candidate.view.workspaceId === requestedWorkspaceId
    )
    if (selected !== undefined) return selected
    const choices = choicesText(candidates)
    throw new WorkspaceCommandError({
      message:
        choices.length === 0
          ? `Task ${taskId} has no workspace currently preserved for resume.\n${formatWorkspaceViews(exactTaskViews)}`
          : `Workspace ${requestedWorkspaceId} is not an exact retained workspace for task ${taskId}. Choose one of:\n${choices}`,
      exitCode: 1,
    })
  }
  if (candidates.length === 1) return candidates[0]!
  if (candidates.length > 1)
    throw usage(
      `Task ${taskId} has multiple retained workspaces; select one with --workspace:\n${choicesText(candidates)}`
    )
  throw new WorkspaceCommandError({
    message:
      exactTaskViews.length === 0
        ? noTaskRecords(taskId)
        : `Task ${taskId} has no workspace currently preserved for resume.\n${formatWorkspaceViews(exactTaskViews)}`,
    exitCode: 1,
  })
}

export const runReadOnlyWorkspaceCommand = (
  lifecycle: WorkspaceLifecycle,
  command: Exclude<WorkspaceCommand, { readonly kind: 'resume' }>,
  options: {
    readonly cwd?: string
    readonly currentWorkspaceId?: string
    readonly effectiveCwd?: string
  } = {}
): Effect.Effect<WorkspaceCommandResult> =>
  Effect.gen(function* () {
    if (command.kind === 'list') {
      if (options.cwd === undefined)
        return {
          exitCode: 2,
          stderr: 'Workspace list requires a Git repository context; pass --cwd PATH.',
        } as const
      const views = yield* lifecycle.inspect({ cwd: options.cwd })
      return { exitCode: 0, stdout: formatWorkspaceList(views, options.cwd, options) } as const
    }
    const views = yield* lifecycle.inspect({ taskId: command.taskId })
    return { exitCode: 0, stdout: formatWorkspaceInspect(views, command.taskId) } as const
  }).pipe(
    Effect.catch(cause =>
      Effect.succeed({
        exitCode: 1,
        stderr: `Workspace inspection failed: ${cause.message}`,
      } as const)
    )
  )
