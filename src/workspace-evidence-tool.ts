import { execFile } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Cause, Effect, Exit, Schema } from 'effect'
import { errorText } from './error-text.ts'
import {
  GitHubRepositorySchema,
  RelativeFilePath,
  TaskTargetSchema,
  WorkspaceId,
  type PublicationReference,
  type RuleApproval,
  type WorkspaceAttachment,
  type WorkspaceLifecycle,
} from './workspace-domain.ts'
import { sensitiveName, sha256Hex } from './workspace-evidence.ts'
import { blobAt, canonicalGitWorkspace } from './workspace-git.ts'
import { newId, now } from './workspace-platform.ts'

const EvidenceInputSchema = Schema.Union([
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
  Schema.Struct({ action: Schema.Literal('approve-rule'), locator: RelativeFilePath }),
])
type EvidenceInput = typeof EvidenceInputSchema.Type
const parameters = Schema.toJsonSchemaDocument(EvidenceInputSchema, {
  onExcessProperty: 'error',
}).schema
const decodeInput = Schema.decodeUnknownEffect(EvidenceInputSchema)

export class EvidenceToolError extends Schema.TaggedError<EvidenceToolError>()(
  'EvidenceToolError',
  { message: Schema.String }
) {}
const refuse = (message: string) => new EvidenceToolError({ message })

const BodyPayload = Schema.Struct({ body: Schema.NullOr(Schema.String), html_url: Schema.String })
const decodeBody = Schema.decodeUnknownSync(BodyPayload)

export interface PublicationDestinationReader {
  body(
    repository: string,
    number: number,
    commentId: number | undefined
  ): Effect.Effect<{ readonly body: string; readonly url: string }, EvidenceToolError>
  attachment(url: string): Effect.Effect<Uint8Array, EvidenceToolError>
}

export const ghDestinationReader: PublicationDestinationReader = {
  body: (repository, number, commentId) =>
    Effect.callback<{ readonly body: string; readonly url: string }, EvidenceToolError>(resume => {
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

// GitHub normalizes line endings, so both sides compare with LF.
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

export interface EvidenceToolOptions {
  readonly lifecycle: WorkspaceLifecycle
  readonly attachment: () => WorkspaceAttachment
  readonly destinations: PublicationDestinationReader
  readonly runPromise: <A>(effect: Effect.Effect<A>) => Promise<A>
}

export const makeEvidenceTool = (options: EvidenceToolOptions): ToolDefinition => {
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

  const setTarget = Effect.fnUntraced(function* (
    input: Extract<EvidenceInput, { readonly action: 'set-target' }>
  ) {
    const { taskId } = yield* boundWorkspace(input.taskId)
    yield* options.lifecycle
      .recordTarget({ taskId, target: input.target })
      .pipe(Effect.mapError(error => refuse(`Target was not recorded: ${error.message}`)))
    return { recorded: 'target', taskId, target: input.target }
  })

  const recordPublication = Effect.fnUntraced(function* (
    input: Extract<EvidenceInput, { readonly action: 'record-publication' }>
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
      verifiedAt: now(),
    }
    yield* options.lifecycle
      .recordPublication({ reference })
      .pipe(Effect.mapError(error => refuse(`Publication was not recorded: ${error.message}`)))
    return { recorded: 'publication', reference }
  })

  const approveRule = Effect.fnUntraced(function* (
    input: Extract<EvidenceInput, { readonly action: 'approve-rule' }>,
    context: ExtensionContext
  ) {
    if (!context.hasUI)
      return yield* refuse(
        'Rule approval needs the user to confirm interactively; no UI is available, so nothing was approved.'
      )
    const { binding, view } = yield* boundWorkspace(undefined)
    if (view === undefined)
      return yield* refuse(
        `The current workspace ${binding.workspaceId} is not reserved by a task.`
      )
    const blob = yield* Effect.try({
      try: () => blobAt(view.path, 'HEAD', input.locator),
      catch: cause => refuse(`Rule file could not be read at HEAD: ${errorText(cause)}`),
    })
    if (blob === undefined)
      return yield* refuse(
        `No tracked file ${input.locator} exists at HEAD of ${view.path}; rules are versioned in the repository.`
      )
    const digest = sha256Hex(blob)
    const content = blob.toString('utf8')
    const preview = content.length > 2000 ? `${content.slice(0, 2000)}\n…` : content
    const confirmed = yield* Effect.promise(() =>
      context.ui.confirm(
        `Approve regenerable rule ${input.locator}?`,
        `Repository: ${view.repositoryId}\nRule file: ${input.locator} at HEAD ${view.path}\nsha256: ${digest}\n\nFiles matching this exact version may be deleted with an eligible managed worktree. Any later change to the file needs a new approval.\n\n${preview}`
      )
    )
    if (!confirmed) return { recorded: 'nothing', reason: 'The user did not approve the rule.' }
    const approval: RuleApproval = {
      id: newId(),
      repositoryId: view.repositoryId,
      locator: input.locator,
      digest,
      approvedBy: { kind: 'tui-confirmation', sessionId: binding.conversation.sessionId },
      approvedAt: now(),
    }
    yield* options.lifecycle
      .recordRuleApproval({ approval })
      .pipe(Effect.mapError(error => refuse(`Approval was not recorded: ${error.message}`)))
    return { recorded: 'rule-approval', approval }
  })

  return {
    name: 'workspace_evidence',
    label: 'Workspace evidence',
    description:
      'Record cleanup evidence for this conversation\'s workflow task in the workspace authority. set-target records the agreed integration target (an exact full ref under a local, remote or github authority; github may name the source repository and a pull request). record-publication verifies that an artifact you already published in a GitHub issue or pull request (complete text in the body, or an attachment with the exact bytes) reads back, then records path, byte length and sha256 with that reference; it uploads nothing. approve-rule asks the user to approve the exact HEAD version of a versioned regenerable-rule file ({"version":1,"regenerable":["dir/","file"]}); the user\'s confirmation is the approval. None of these releases or removes a workspace: the user does that with /workspace release.',
    parameters,
    async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
      const run: Effect.Effect<unknown, EvidenceToolError> = decodeInput(input, {
        onExcessProperty: 'error',
      }).pipe(
        Effect.mapError(cause => refuse(cause.message)),
        Effect.flatMap((decoded): Effect.Effect<unknown, EvidenceToolError> => {
          switch (decoded.action) {
            case 'set-target':
              return setTarget(decoded)
            case 'record-publication':
              return recordPublication(decoded)
            case 'approve-rule':
              return approveRule(decoded, ctx)
          }
        })
      )
      const outcome = await options.runPromise(Effect.exit(run))
      if (Exit.isSuccess(outcome))
        return {
          content: [{ type: 'text', text: JSON.stringify(outcome.value) }],
          details: outcome.value,
        }
      // Pi records a thrown tool error as a failed tool result.
      throw new Error(errorText(Cause.squash(outcome.cause)))
    },
  }
}
