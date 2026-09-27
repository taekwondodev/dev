import { Effect, Schema } from 'effect'
import {
  WorkspaceId,
  type WorkspaceError,
  type WorkspaceLifecycle,
  type WorkspaceSelection,
  type WorkspaceView,
} from './workspace-domain.ts'

export type WorkspaceCommand =
  | { readonly kind: 'list' }
  | { readonly kind: 'inspect'; readonly taskId: WorkspaceId }
  | {
      readonly kind: 'resume'
      readonly taskId: WorkspaceId
      readonly workspaceId?: WorkspaceId
    }

export type ReadOnlyWorkspaceCommand = Exclude<WorkspaceCommand, { readonly kind: 'resume' }>

export interface WorkspaceCommandResult {
  readonly exitCode: 0 | 1 | 2
  readonly text: string
}

export interface WorkspaceListScope {
  readonly repositoryRoot: Effect.Effect<string | undefined>
  readonly binding?: { readonly workspaceId: string; readonly cwd: string }
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
  if (verb === 'resume') {
    const taskId = yield* exactId(args[0], 'Task')
    if (args.length === 1) return { kind: 'resume', taskId }
    if (args.length === 3 && args[1] === '--workspace')
      return { kind: 'resume', taskId, workspaceId: yield* exactId(args[2], 'Workspace') }
    return yield* usage('Usage: workspace resume <task> [--workspace <workspace>]')
  }
  return yield* usage(
    `Unknown workspace command ${JSON.stringify(verb)}. Use list, inspect <task>, or resume <task> [--workspace <workspace>].`
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
  binding: WorkspaceListScope['binding']
): string => {
  const rows = sortedViews(views)
  const header = [
    `Workspace list for repository ${repositoryRoot}:`,
    ...(binding === undefined
      ? []
      : [`Current binding: ${binding.workspaceId}`, `Effective cwd: ${binding.cwd}`]),
  ]
  if (rows.length === 0) return `${header.join('\n')}\nNo workspace records were found.`
  return [...header, ...rows.flatMap(view => viewText(view, binding?.workspaceId))].join('\n')
}

export const resumeCandidates = (
  exactTaskViews: readonly WorkspaceView[],
  taskId: WorkspaceId
): readonly ResumeCandidate[] =>
  sortedViews(exactTaskViews)
    .filter(view => view.outcome === 'preserved-for-resume')
    .map(view => ({ selection: { taskId, workspaceId: view.workspaceId }, view }))

const choicesText = (candidates: readonly ResumeCandidate[]): string =>
  candidates.map(({ view }) => `  ${view.workspaceId}  ${view.path} (${view.origin})`).join('\n')

export const chooseResumeCandidate = Effect.fnUntraced(function* (
  exactTaskViews: readonly WorkspaceView[],
  taskId: WorkspaceId,
  requestedWorkspaceId?: string
): Effect.fn.Return<ResumeCandidate, WorkspaceCommandError> {
  const candidates = resumeCandidates(exactTaskViews, taskId)
  if (requestedWorkspaceId !== undefined) {
    const selected = candidates.find(
      candidate => candidate.view.workspaceId === requestedWorkspaceId
    )
    if (selected !== undefined) return selected
    const choices = choicesText(candidates)
    return yield* new WorkspaceCommandError({
      message:
        choices.length === 0
          ? `Task ${taskId} has no workspace currently preserved for resume.\n${formatWorkspaceViews(exactTaskViews)}`
          : `Workspace ${requestedWorkspaceId} is not an exact retained workspace for task ${taskId}. Choose one of:\n${choices}`,
      exitCode: 1,
    })
  }
  if (candidates.length === 1) return candidates[0]!
  if (candidates.length > 1)
    return yield* usage(
      `Task ${taskId} has multiple retained workspaces; select one with --workspace:\n${choicesText(candidates)}`
    )
  return yield* new WorkspaceCommandError({
    message:
      exactTaskViews.length === 0
        ? noTaskRecords(taskId)
        : `Task ${taskId} has no workspace currently preserved for resume.\n${formatWorkspaceViews(exactTaskViews)}`,
    exitCode: 1,
  })
})

export const runReadOnlyWorkspaceCommand = Effect.fnUntraced(
  function* (
    lifecycle: WorkspaceLifecycle,
    command: ReadOnlyWorkspaceCommand,
    scope: WorkspaceListScope
  ): Effect.fn.Return<WorkspaceCommandResult, WorkspaceError> {
    if (command.kind === 'inspect') {
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
    const views = yield* lifecycle.inspect({ cwd: repositoryRoot })
    return { exitCode: 0, text: formatWorkspaceList(views, repositoryRoot, scope.binding) }
  },
  Effect.catch(cause =>
    Effect.succeed<WorkspaceCommandResult>({
      exitCode: 1,
      text: `Workspace inspection failed: ${cause.message}`,
    })
  )
)
