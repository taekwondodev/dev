import { execFile } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Cause, Clock, Effect, Exit, Schema } from 'effect'
import { errorText } from './error-text.ts'
import { resumeCandidates } from './workspace-command.ts'
import {
  GitHubRepositorySchema,
  RelativeFilePath,
  TaskTargetSchema,
  WorkspaceId,
  type PublicationReference,
  type WorkspaceAttachment,
  type WorkspaceHandoff,
  type WorkspaceLifecycle,
} from './workspace-domain.ts'
import { sensitiveName, sha256Hex } from './workspace-evidence.ts'
import { canonicalGitWorkspace } from './workspace-git.ts'
import { newId } from './workspace-platform.ts'

const WorkspaceToolInputSchema = Schema.Union([
  Schema.Struct({
    action: Schema.Literal('resume'),
    taskId: WorkspaceId,
    workspaceId: Schema.optional(WorkspaceId),
  }),
  Schema.Struct({
    action: Schema.Literal('set-target'),
    taskId: Schema.optional(WorkspaceId),
    target: TaskTargetSchema,
  }),
  Schema.Struct({
    action: Schema.Literal('record-publication'),
    taskId: Schema.optional(WorkspaceId),
    path: RelativeFilePath,
    destination: Schema.Struct({
      repository: GitHubRepositorySchema,
      number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
      commentId: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
    }),
  }),
])
type WorkspaceToolInput = typeof WorkspaceToolInputSchema.Type
const parameters = Schema.toJsonSchemaDocument(WorkspaceToolInputSchema, {
  onExcessProperty: 'error',
}).schema
const decodeInput = Schema.decodeUnknownEffect(WorkspaceToolInputSchema)

export class WorkspaceToolError extends Schema.TaggedError<WorkspaceToolError>()(
  'WorkspaceToolError',
  { message: Schema.String }
) {}
const refuse = (message: string) => new WorkspaceToolError({ message })

const BodyPayload = Schema.Struct({ body: Schema.NullOr(Schema.String), html_url: Schema.String })
const decodeBody = Schema.decodeUnknownSync(BodyPayload)

export interface PublicationDestinationReader {
  body(
    repository: string,
    number: number,
    commentId: number | undefined
  ): Effect.Effect<{ readonly body: string; readonly url: string }, WorkspaceToolError>
  attachment(url: string): Effect.Effect<Uint8Array, WorkspaceToolError>
}

export const ghDestinationReader: PublicationDestinationReader = {
  body: (repository, number, commentId) =>
    Effect.callback<{ readonly body: string; readonly url: string }, WorkspaceToolError>(resume => {
      const endpoint =
        commentId === undefined
          ? `repos/${repository}/issues/${number}`
          : `repos/${repository}/issues/comments/${commentId}`
      execFile(
        'gh',
        ['api', endpoint],
        {
          encoding: 'utf8',
          timeout: 30_000,
          maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
        },
        (error, stdout) => {
          if (error !== null) {
            resume(
              Effect.fail(
                refuse(`Publication destination could not be read back: ${errorText(error)}`)
              )
            )
            return
          }
          try {
            const payload = decodeBody(JSON.parse(stdout))
            resume(Effect.succeed({ body: payload.body ?? '', url: payload.html_url }))
          } catch (cause) {
            resume(
              Effect.fail(
                refuse(`Publication destination answered an unexpected shape: ${errorText(cause)}`)
              )
            )
          }
        }
      )
    }),
  attachment: url =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(url, {
          redirect: 'follow',
          signal: AbortSignal.timeout(30_000),
        })
        if (!response.ok) throw new Error(`attachment ${url} answered ${response.status}`)
        return new Uint8Array(await response.arrayBuffer())
      },
      catch: cause => refuse(`Attachment ${url} could not be read back: ${errorText(cause)}`),
    }),
}

const ATTACHMENT_URL =
  /https:\/\/(?:github\.com\/(?:user-attachments\/assets|[^\s/]+\/[^\s/]+\/assets)\/[^\s)"'<>]+|user-images\.githubusercontent\.com\/[^\s)"'<>]+|private-user-images\.githubusercontent\.com\/[^\s)"'<>]+)/g

const containsWholeLines = (body: string, text: string): boolean => {
  const normalizedBody = body.replaceAll('\r\n', '\n')
  const normalizedText = text.replaceAll('\r\n', '\n').replace(/\n$/, '')
  if (normalizedText.trim().length === 0) return false
  let from = 0
  for (;;) {
    const at = normalizedBody.indexOf(normalizedText, from)
    if (at === -1) return false
    const before = at === 0 || normalizedBody[at - 1] === '\n'
    const end = at + normalizedText.length
    const after = end === normalizedBody.length || normalizedBody[end] === '\n'
    if (before && after) return true
    from = at + 1
  }
}

const utf8Text = (bytes: Uint8Array): string | undefined => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

export interface WorkspaceToolOptions {
  readonly lifecycle: WorkspaceLifecycle
  readonly attachment: () => WorkspaceAttachment
  readonly destinations: PublicationDestinationReader
  readonly runPromise: <A>(effect: Effect.Effect<A>) => Promise<A>
  readonly requestResume: (handoff: WorkspaceHandoff, context: ExtensionContext) => void
}

interface ToolReply {
  readonly value: unknown
  readonly terminate: boolean
}

export const makeWorkspaceTool = (options: WorkspaceToolOptions): ToolDefinition => {
  const boundWorkspace = Effect.fnUntraced(function* (requestedTaskId: WorkspaceId | undefined) {
    const { binding } = options.attachment()
    const taskId = requestedTaskId ?? binding.taskId
    if (taskId === undefined)
      return yield* refuse(
        'This conversation has no task yet: a task exists once a write was admitted for it. Pass taskId explicitly for another task.'
      )
    const views = yield* options.lifecycle
      .inspect({ taskId })
      .pipe(Effect.mapError(error => refuse(`Workspace inspection failed: ${error.message}`)))
    const view = views.find(item => item.workspaceId === binding.workspaceId)
    return { taskId, binding, view, views }
  })

  const resume = Effect.fnUntraced(function* (
    input: Extract<WorkspaceToolInput, { readonly action: 'resume' }>,
    context: ExtensionContext
  ) {
    const attachment = options.attachment()
    const views = yield* options.lifecycle
      .inspect({ taskId: input.taskId })
      .pipe(Effect.mapError(error => refuse(`Workspace inspection failed: ${error.message}`)))
    const candidates = resumeCandidates(views, input.taskId)
    const candidate =
      input.workspaceId === undefined
        ? candidates.find(() => candidates.length === 1)
        : candidates.find(entry => entry.view.workspaceId === input.workspaceId)
    if (candidate === undefined)
      return yield* refuse(
        candidates.length === 0 || input.workspaceId !== undefined
          ? `Task ${input.taskId} has no matching workspace preserved for resume: ${views.map(view => `${view.workspaceId} is ${view.outcome}`).join('; ') || 'no workspace records exist'}.`
          : `Task ${input.taskId} has several retained workspaces; pass workspaceId, one of: ${candidates.map(entry => `${entry.view.workspaceId} at ${entry.view.path}`).join('; ')}.`
      )
    const { binding } = attachment
    if (candidate.view.workspaceId === binding.workspaceId && binding.taskId === input.taskId)
      return {
        value: { resumed: 'already-bound', taskId: input.taskId, workspaceId: binding.workspaceId },
        terminate: false,
      }
    const handoff = yield* attachment
      .select(candidate.selection)
      .pipe(Effect.mapError(error => refuse(`Workspace selection was refused: ${error.message}`)))
    options.requestResume(handoff, context)
    return {
      value: {
        resumed: 'requested',
        taskId: input.taskId,
        workspaceId: candidate.view.workspaceId,
        path: candidate.view.path,
        note: 'The conversation switches to this workspace when the current turn ends; no other tool runs before then.',
      },
      terminate: true,
    }
  })

  const setTarget = Effect.fnUntraced(function* (
    input: Extract<WorkspaceToolInput, { readonly action: 'set-target' }>
  ) {
    const { taskId } = yield* boundWorkspace(input.taskId)
    yield* options.lifecycle
      .recordTarget({ taskId, target: input.target })
      .pipe(Effect.mapError(error => refuse(`Target was not recorded: ${error.message}`)))
    return { value: { recorded: 'target', taskId, target: input.target }, terminate: false }
  })

  const recordPublication = Effect.fnUntraced(function* (
    input: Extract<WorkspaceToolInput, { readonly action: 'record-publication' }>
  ) {
    const { taskId, binding, view } = yield* boundWorkspace(input.taskId)
    if (view === undefined)
      return yield* refuse(
        `The current workspace ${binding.workspaceId} holds no reservation of task ${taskId}; a publication is recorded from a workspace of its task.`
      )
    const absolute = join(view.path, input.path)
    const info = yield* Effect.try({
      try: () => lstatSync(absolute),
      catch: cause =>
        refuse(`Selected artifact is unreadable: ${input.path} (${errorText(cause)})`),
    })
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      return yield* refuse(`Selected artifact must be a regular file without links: ${input.path}`)
    if (sensitiveName(input.path))
      return yield* refuse(
        `Selected artifact has a sensitive name and is never certified for disposal: ${input.path}`
      )
    const bytes = yield* Effect.try({
      try: () => readFileSync(absolute),
      catch: cause => refuse(`Selected artifact could not be read: ${errorText(cause)}`),
    })
    const digest = sha256Hex(bytes)
    const destination = yield* options.destinations.body(
      input.destination.repository,
      input.destination.number,
      input.destination.commentId
    )
    const text = utf8Text(bytes)
    let readBack: PublicationReference['destination']['readBack'] | undefined
    if (text !== undefined && containsWholeLines(destination.body, text)) readBack = 'text-in-body'
    else {
      const urls = [...new Set(destination.body.match(ATTACHMENT_URL) ?? [])]
      for (const url of urls) {
        const fetched = yield* Effect.option(options.destinations.attachment(url))
        if (fetched._tag === 'Some' && sha256Hex(fetched.value) === digest) {
          readBack = 'attachment-sha256'
          break
        }
      }
    }
    if (readBack === undefined)
      return yield* refuse(
        `Publication of ${input.path} was not verified: ${destination.url} neither contains the file's complete text nor an attachment with its exact bytes (${bytes.byteLength} bytes, sha256 ${digest.slice(0, 12)}). Publish the actual artifact there first; dev uploads nothing.`
      )
    const head = yield* Effect.try({
      try: () => canonicalGitWorkspace(view.path).head,
      catch: cause => refuse(`Workspace revision could not be read: ${errorText(cause)}`),
    })
    const reference: PublicationReference = {
      id: newId(),
      taskId,
      workspaceId: binding.workspaceId,
      ...(head.length === 0 ? {} : { commit: head }),
      relativePath: input.path,
      byteLength: bytes.byteLength,
      sha256: digest,
      destination: {
        repository: input.destination.repository,
        number: input.destination.number,
        ...(input.destination.commentId === undefined
          ? {}
          : { commentId: input.destination.commentId }),
        readBack,
        url: destination.url,
      },
      verifiedAt: yield* Clock.currentTimeMillis,
    }
    yield* options.lifecycle
      .recordPublication({ reference })
      .pipe(Effect.mapError(error => refuse(`Publication was not recorded: ${error.message}`)))
    return { value: { recorded: 'publication', reference }, terminate: false }
  })

  return {
    name: 'workspace',
    label: 'Workspace',
    description:
      "Operate this conversation's workspace task in the workspace authority. resume switches the conversation onto a workspace retained for a task (exact taskId, and workspaceId when the task retains several); the switch happens when the current turn ends. set-target records an override of the integration target, which is otherwise derived from the origin remote (an exact full ref under a local, remote or github authority; github may name the source repository and a pull request). record-publication verifies that an artifact you already published in a GitHub issue or pull request (complete text in the body, or an attachment with the exact bytes) reads back, then records path, byte length and sha256 with that reference; it uploads nothing. Nothing here releases or removes a workspace: dev sweeps finished workspaces itself when it quits or allocates a worktree.",
    parameters,
    async execute(_toolCallId, input, _signal, _onUpdate, context) {
      const run: Effect.Effect<ToolReply, WorkspaceToolError> = decodeInput(input, {
        onExcessProperty: 'error',
      }).pipe(
        Effect.mapError(cause => refuse(cause.message)),
        Effect.flatMap((decoded): Effect.Effect<ToolReply, WorkspaceToolError> => {
          switch (decoded.action) {
            case 'resume':
              return resume(decoded, context)
            case 'set-target':
              return setTarget(decoded)
            case 'record-publication':
              return recordPublication(decoded)
          }
        })
      )
      const outcome = await options.runPromise(Effect.exit(run))
      if (Exit.isSuccess(outcome))
        return {
          content: [{ type: 'text', text: JSON.stringify(outcome.value.value) }],
          details: outcome.value.value,
          ...(outcome.value.terminate ? { terminate: true } : {}),
        }

      throw new Error(errorText(Cause.squash(outcome.cause)))
    },
  }
}
