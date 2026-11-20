import { execFile } from 'node:child_process'
import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent'
import * as Cause from 'effect/Cause'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import type * as JsonSchema from 'effect/JsonSchema'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import { commandRunner, type RunCommand } from './command.ts'
import { errorText } from './error-text.ts'
import { resumeCandidates, checkoutInspectionFailedText } from './workspace-command.ts'
import { authorityPaths, taskArtifactsPath } from './workspace-authority-root.ts'
import {
  AbsolutePath,
  GitHubRepositorySchema,
  RelativeFilePath,
  TaskTargetSchema,
  WorkspaceId,
  type PublicationReference,
  type PublicationRoot,
  type WorkspaceAttachment,
  type WorkspaceHandoff,
  type WorkspaceLifecycle,
  type WorkspaceView,
} from './workspace-domain.ts'
import { sensitiveName, sha256Hex } from './workspace-evidence.ts'
import { SWITCH_REQUESTED, switchNotRequested, type SwitchRequest } from './workspace-model-text.ts'
import { isWithin } from './workspace-paths.ts'
import { GIT_TIMEOUT_MS, gitArguments, gitEnvironment } from './workspace-git.ts'
import { newId } from './workspace-platform.ts'

const isRelativeFile = Schema.is(RelativeFilePath)
const isAbsolutePath = Schema.is(AbsolutePath)

const InputFields = {
  taskId: WorkspaceId,
  workspaceId: WorkspaceId,
  target: TaskTargetSchema,
  path: Schema.String.check(
    Schema.makeFilter(value =>
      isRelativeFile(value) || isAbsolutePath(value)
        ? undefined
        : 'must be a normalized relative path inside the checkout or an absolute path'
    )
  ),
  destination: Schema.Struct({
    repository: GitHubRepositorySchema,
    number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    commentId: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  }),
}

export const WorkspaceToolInputSchema = Schema.Union([
  Schema.Struct({
    action: Schema.Literal('resume'),
    taskId: InputFields.taskId,
    workspaceId: Schema.optional(InputFields.workspaceId),
  }),
  Schema.Struct({
    action: Schema.Literal('set-target'),
    taskId: Schema.optional(InputFields.taskId),
    target: InputFields.target,
  }),
  Schema.Struct({
    action: Schema.Literal('record-publication'),
    taskId: Schema.optional(InputFields.taskId),
    path: InputFields.path,
    destination: InputFields.destination,
  }),
  Schema.Struct({ action: Schema.Literal('artifacts') }),
])
type WorkspaceToolInput = typeof WorkspaceToolInputSchema.Type

const ToolParametersSchema = Schema.Struct({
  action: Schema.Literals(['resume', 'set-target', 'record-publication', 'artifacts']),
  taskId: Schema.optionalKey(InputFields.taskId),
  workspaceId: Schema.optionalKey(InputFields.workspaceId),
  target: Schema.optionalKey(InputFields.target),
  path: Schema.optionalKey(InputFields.path),
  destination: Schema.optionalKey(InputFields.destination),
})

const fieldDescriptions: { readonly [Field in keyof typeof InputFields]: string } = {
  taskId:
    "Saved task ID. Required for resume; set-target and record-publication default to this conversation's task.",
  workspaceId: 'resume only: checkout ID, required if several are paused.',
  target:
    'set-target only, required: a destination of kind local, remote or github with a full ref like refs/heads/main, not a bare branch. github also accepts a source repository and PR number.',
  path: 'record-publication only, required: published file, relative to the checkout or absolute inside the folder returned by artifacts.',
  destination:
    'record-publication only, required: GitHub issue or PR containing the file; set commentId for a comment.',
}

const describeFields = (schema: JsonSchema.JsonSchema): JsonSchema.JsonSchema => {
  const properties = Schema.decodeUnknownSync(
    Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown))
  )(schema.properties)
  return {
    ...schema,
    properties: Object.fromEntries(
      Object.entries(properties).map(([field, property]) => [
        field,
        Object.hasOwn(fieldDescriptions, field)
          ? { description: fieldDescriptions[field as keyof typeof fieldDescriptions], ...property }
          : property,
      ])
    ),
  }
}

export const workspaceToolParameters = describeFields(
  Schema.toJsonSchemaDocument(ToolParametersSchema, { onExcessProperty: 'error' }).schema
)
const decodeInput = Schema.decodeUnknownEffect(WorkspaceToolInputSchema)

export class WorkspaceToolError extends Schema.TaggedError<
  WorkspaceToolError,
  { readonly brand: unique symbol }
>()('WorkspaceToolError', { message: Schema.String }) {}
const refuse = (message: string) => new WorkspaceToolError({ message })

const BodyPayload = Schema.Struct({ body: Schema.NullOr(Schema.String), html_url: Schema.String })
const decodeBody = Schema.decodeUnknownResult(Schema.fromJsonString(BodyPayload))

export interface PublicationDestinationReader {
  body(
    repository: string,
    number: number,
    commentId: number | undefined
  ): Effect.Effect<{ readonly body: string; readonly url: string }, WorkspaceToolError>
  attachment(url: string): Effect.Effect<Uint8Array, WorkspaceToolError>
}

const readDestinationBody = (
  run: RunCommand,
  repository: string,
  number: number,
  commentId: number | undefined
) =>
  Effect.suspend(() =>
    run(
      'gh',
      [
        'api',
        commentId === undefined
          ? `repos/${repository}/issues/${number}`
          : `repos/${repository}/issues/comments/${commentId}`,
      ],
      {
        timeout: 30_000,
        maxOutputLength: 16 * 1024 * 1024,
        env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
      }
    )
  ).pipe(
    Effect.mapError(error =>
      refuse(`Could not read the issue, PR or comment: ${errorText(error)}`)
    ),
    Effect.flatMap(({ stdout }) => {
      const payload = decodeBody(stdout)
      return Result.isSuccess(payload)
        ? Effect.succeed({ body: payload.success.body ?? '', url: payload.success.html_url })
        : Effect.fail(refuse(`Unexpected GitHub response: ${errorText(payload.failure)}`))
    })
  )

const readAttachment = (url: string) =>
  Effect.tryPromise({
    try: async signal => {
      const response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`)
      return new Uint8Array(await response.arrayBuffer())
    },
    catch: cause => refuse(`Could not download ${url}: ${errorText(cause)}`),
  })

const readHead = (cwd: string): Effect.Effect<string, WorkspaceToolError> =>
  Effect.callback<string, WorkspaceToolError>((resume, signal) => {
    execFile(
      'git',
      gitArguments(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']),
      { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, env: gitEnvironment(), signal },
      (error, stdout) => {
        if (error === null) resume(Effect.succeed(stdout.trim()))
        else if (error.code === 1) resume(Effect.succeed(''))
        else resume(Effect.fail(refuse(`Could not read checkout HEAD: ${errorText(error)}`)))
      }
    )
  })

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

const viewText = (view: WorkspaceView): string =>
  `${view.workspaceId} at ${view.path} is ${view.outcome}: ${view.reason} ${view.nextAction}`

const utf8Text = (bytes: Uint8Array): string | undefined => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

export class PublicationDestinations extends Context.Service<
  PublicationDestinations,
  PublicationDestinationReader
>()('dev/workspace-tool/PublicationDestinations') {
  static readonly layer = Layer.effect(
    PublicationDestinations,
    Effect.map(commandRunner, run =>
      PublicationDestinations.of({
        body: (repository, number, commentId) =>
          readDestinationBody(run, repository, number, commentId),
        attachment: readAttachment,
      })
    )
  )
}

export interface WorkspaceToolOptions {
  readonly lifecycle: WorkspaceLifecycle
  readonly attachment: () => WorkspaceAttachment
  readonly runPromise: <A>(effect: Effect.Effect<A, never, PublicationDestinations>) => Promise<A>
  readonly requestResume: (
    handoff: WorkspaceHandoff,
    source: WorkspaceAttachment,
    context: ExtensionContext
  ) => SwitchRequest
  readonly declinedSwitch: (
    source: WorkspaceAttachment
  ) => Exclude<SwitchRequest, 'requested'> | undefined
}

interface ToolReply {
  readonly value: object
  readonly model: object
  readonly terminate: boolean
}

export const WORKSPACE_TOOL_DESCRIPTION =
  "Manage this conversation's checkout and task. artifacts returns a folder outside Git for PR text, reports, logs or notes. Dev first checks permission to write, and deletes the folder when the last checkout kept for the task is freed or removed. resume asks dev to switch to a paused checkout at turn end; dev reports where this conversation works once the switch completes. set-target sets the destination branch instead of inferring it from origin. record-publication verifies a file already posted to a GitHub issue or PR (complete text or an exact uploaded file), and saves the proof. Nothing is uploaded or released. Dev checks for automatic cleanup at quit or before creating a worktree."

const selectedArtifactUnreadableText = (path: string, cause: unknown): string =>
  `Selected artifact is unreadable: ${path} (${errorText(cause)})`

export const makeWorkspaceTool = (options: WorkspaceToolOptions): ToolDefinition => {
  const boundWorkspace = Effect.fnUntraced(function* (requestedTaskId: WorkspaceId | undefined) {
    const { binding } = options.attachment()
    const taskId = requestedTaskId ?? binding.taskId
    if (taskId === undefined)
      return yield* refuse(
        'This conversation gets a task when dev first allows a write. Pass taskId to select another task.'
      )
    const views = yield* options.lifecycle
      .inspect({ taskId })
      .pipe(Effect.mapError(error => refuse(checkoutInspectionFailedText(error.message))))
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
      .pipe(Effect.mapError(error => refuse(checkoutInspectionFailedText(error.message))))
    const declined = options.declinedSwitch(attachment)
    if (declined !== undefined) return yield* refuse(switchNotRequested(declined))
    const candidates = resumeCandidates(views, input.taskId)
    const candidate =
      input.workspaceId === undefined
        ? candidates.find(() => candidates.length === 1)
        : candidates.find(entry => entry.view.workspaceId === input.workspaceId)
    if (candidate === undefined) {
      const resumable = candidates.map(entry => viewText(entry.view)).join(' | ')
      if (candidates.length === 0)
        return yield* refuse(
          `Task ${input.taskId} has no checkout you can resume: ${views.map(viewText).join(' | ') || 'no saved checkouts'}`
        )
      if (input.workspaceId === undefined)
        return yield* refuse(
          `Task ${input.taskId} has several paused checkouts; pass one workspaceId: ${resumable}`
        )
      const selected = views.filter(view => view.workspaceId === input.workspaceId).map(viewText)
      return yield* refuse(
        `Checkout ${input.workspaceId} is not resumable for task ${input.taskId}: ${selected.join(' | ') || 'checkout not found'}. Resumable: ${resumable}`
      )
    }
    const { binding } = attachment
    if (candidate.view.workspaceId === binding.workspaceId && binding.taskId === input.taskId) {
      const value = {
        resumed: 'already-here',
        taskId: input.taskId,
        workspaceId: binding.workspaceId,
      }
      return { value, model: value, terminate: false }
    }
    const handoff = yield* attachment
      .select(candidate.selection)
      .pipe(Effect.mapError(error => refuse(`Could not switch checkouts: ${error.message}`)))
    const request = options.requestResume(handoff, attachment, context)
    if (request !== 'requested') return yield* refuse(switchNotRequested(request))
    const value = {
      resumed: 'requested',
      taskId: input.taskId,
      workspaceId: candidate.view.workspaceId,
      path: candidate.view.path,
    }
    return {
      value,
      model: {
        ...value,
        note: `${SWITCH_REQUESTED} No other calls run meanwhile.`,
      },
      terminate: true,
    }
  })

  const artifacts = Effect.fnUntraced(function* (context: ExtensionContext) {
    const attachment = options.attachment()
    const admitted = yield* attachment
      .authorize({ kind: 'write', cwd: attachment.binding.cwd })
      .pipe(Effect.mapError(error => refuse(`No permission to write: ${error.message}`)))
    if (admitted.kind === 'handoff') {
      const request = options.requestResume(admitted.handoff, attachment, context)
      if (request !== 'requested')
        return yield* refuse(
          `No directory was created: ${admitted.handoff.reason}. ${switchNotRequested(request)}`
        )
      const value = { artifacts: 'switch-requested', reason: admitted.handoff.reason }
      return {
        value,
        model: {
          ...value,
          note: `No directory was created. ${SWITCH_REQUESTED} Once it does, call artifacts again there if the folder is still needed.`,
        },
        terminate: true,
      }
    }
    const { taskId } = admitted.grant
    if (taskId === undefined) return yield* refuse('Dev could not find a task for this write')
    const path = taskArtifactsPath(authorityPaths(options.lifecycle.root), taskId)
    yield* Effect.try({
      try: () => mkdirSync(path, { recursive: true, mode: 0o700 }),
      catch: cause => refuse(`Could not create the task folder: ${errorText(cause)}`),
    })
    return {
      value: { artifacts: 'ready', taskId, path },
      model: { artifacts: 'ready', path },
      terminate: false,
    }
  })

  const setTarget = Effect.fnUntraced(function* (
    input: Extract<WorkspaceToolInput, { readonly action: 'set-target' }>
  ) {
    const { taskId } = yield* boundWorkspace(input.taskId)
    yield* options.lifecycle
      .recordTarget({ taskId, target: input.target })
      .pipe(
        Effect.mapError(error => refuse(`Could not save the destination branch: ${error.message}`))
      )
    const value = { recorded: 'target', taskId, target: input.target }
    return { value, model: value, terminate: false }
  })

  const recordPublication = Effect.fnUntraced(function* (
    input: Extract<WorkspaceToolInput, { readonly action: 'record-publication' }>
  ) {
    const { taskId, binding, view } = yield* boundWorkspace(input.taskId)
    if (view === undefined)
      return yield* refuse(
        `Checkout ${binding.workspaceId} is not held for task ${taskId}. Use a checkout of that task.`
      )
    let root: PublicationRoot = 'workspace'
    let relativePath = input.path
    let absolute = join(view.path, input.path)
    if (isAbsolute(input.path)) {
      const artifactsDirectory = taskArtifactsPath(authorityPaths(options.lifecycle.root), taskId)
      absolute = resolve(input.path)
      if (absolute === artifactsDirectory || !isWithin(artifactsDirectory, absolute))
        return yield* refuse(
          `An absolute path must name a file inside the task folder ${artifactsDirectory}: ${input.path}`
        )
      const canonical = yield* Effect.try({
        try: () => realpathSync.native(absolute),
        catch: cause => refuse(selectedArtifactUnreadableText(input.path, cause)),
      })
      if (canonical !== absolute)
        return yield* refuse(
          `Selected artifact must be reached without links inside the task folder: ${input.path}`
        )
      root = 'artifacts'
      relativePath = relative(artifactsDirectory, absolute)
    }
    const info = yield* Effect.try({
      try: () => lstatSync(absolute),
      catch: cause => refuse(selectedArtifactUnreadableText(input.path, cause)),
    })
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      return yield* refuse(`Selected artifact must be a regular file without links: ${input.path}`)
    if (sensitiveName(relativePath))
      return yield* refuse(
        `File name looks sensitive; dev won't mark it safe to delete: ${input.path}`
      )
    const bytes = yield* Effect.tryPromise({
      try: signal => readFile(absolute, { signal }),
      catch: cause => refuse(`Selected artifact could not be read: ${errorText(cause)}`),
    })
    const digest = sha256Hex(bytes)
    const destinations = yield* PublicationDestinations
    const destination = yield* destinations.body(
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
        const fetched = yield* Effect.option(destinations.attachment(url))
        if (Option.isSome(fetched) && sha256Hex(fetched.value) === digest) {
          readBack = 'attachment-sha256'
          break
        }
      }
    }
    if (readBack === undefined)
      return yield* refuse(
        `${destination.url} lacks the complete text or exact uploaded file for ${input.path} (${bytes.byteLength} bytes, SHA-256 ${digest.slice(0, 12)}). Publish the file there first; dev uploads nothing.`
      )
    const head = yield* readHead(view.path)
    const reference: PublicationReference = {
      id: newId(),
      taskId,
      workspaceId: binding.workspaceId,
      ...(head.length === 0 ? {} : { commit: head }),
      root,
      relativePath,
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
      .pipe(Effect.mapError(error => refuse(`Could not save publication proof: ${error.message}`)))
    return {
      value: { recorded: 'publication', reference },
      model: {
        recorded: 'publication',
        root: root === 'workspace' ? 'checkout' : root,
        path: relativePath,
        byteLength: bytes.byteLength,
        readBack,
        url: destination.url,
      },
      terminate: false,
    }
  })

  return {
    name: 'workspace',
    label: 'Workspace',
    description: WORKSPACE_TOOL_DESCRIPTION,
    parameters: workspaceToolParameters,
    async execute(_toolCallId, input, _signal, _onUpdate, context) {
      const run: Effect.Effect<ToolReply, WorkspaceToolError, PublicationDestinations> =
        decodeInput(input, {
          onExcessProperty: 'error',
        }).pipe(
          Effect.mapError(cause => refuse(cause.message)),
          Effect.flatMap(
            (decoded): Effect.Effect<ToolReply, WorkspaceToolError, PublicationDestinations> => {
              switch (decoded.action) {
                case 'resume':
                  return resume(decoded, context)
                case 'set-target':
                  return setTarget(decoded)
                case 'record-publication':
                  return recordPublication(decoded)
                case 'artifacts':
                  return artifacts(context)
              }
            }
          )
        )
      const outcome = await options.runPromise(Effect.exit(run))
      if (Exit.isSuccess(outcome))
        return {
          content: [{ type: 'text', text: JSON.stringify(outcome.value.model) }],
          details: outcome.value.value,
          ...(outcome.value.terminate ? { terminate: true } : {}),
        }

      throw new Error(errorText(Cause.squash(outcome.cause)))
    },
  }
}
