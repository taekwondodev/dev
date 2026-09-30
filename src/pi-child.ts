import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

import { NodeServices } from '@effect/platform-node'
import { Clock, Effect, FileSystem, Predicate, Schema } from 'effect'
import type * as Pi from '@earendil-works/pi-coding-agent'

import { GenerationId, SessionId, TaskId } from './work-domain.ts'
import { gitRoot, globalPiAgentDir, globalPiAuthPath } from './preferences.ts'
import { loadPi } from './pi-runtime.ts'
import { type ChildMessage, type ChildResultMessage } from './work-protocol.ts'
import { composeResources, getProfile } from './profiles.ts'
import { AbsolutePath, WorkspaceGrantSchema } from './workspace-domain.ts'
import { checkChildWorkspace, childWorkspaceExtension } from './work-child-workspace.ts'
import {
  acquireCoordinatorLink,
  coordinate,
  createCoordinatorWorkTool,
  type CoordinatorLink,
} from './work-child-coordination.ts'

export class ChildError extends Schema.TaggedError<ChildError>()('ChildError', {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const ACCESS_MODES = ['read-only', 'write'] as const
type AccessMode = (typeof ACCESS_MODES)[number]

const REVIEW_OPERATIONS = ['status', 'diff', 'staged-diff', 'log', 'show', 'files'] as const
type ReviewOperation = (typeof REVIEW_OPERATIONS)[number]

const MAX_GIT_OUTPUT = 64 * 1024
const PROGRESS_INTERVAL_MS = 1000
const SAFE_GIT_OPTIONS = [
  '--no-pager',
  '--no-optional-locks',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'diff.external=',
  '-c',
  'credential.helper=',
  '-c',
  'protocol.allow=never',
] as const

const OwnerAttemptId = Schema.NonEmptyString.pipe(Schema.brand('dev/child/AttemptId'))

export const ChildRequestEnvelope = Schema.Struct({
  dataHome: AbsolutePath,
  cwd: AbsolutePath,
  profile: Schema.NonEmptyString,
  sessionDir: AbsolutePath,
  access: Schema.Literals(ACCESS_MODES),
  workspace: WorkspaceGrantSchema,
  prompt: Schema.NonEmptyString,
  coordinate: Schema.optional(Schema.Boolean),
  owner: Schema.Struct({
    sessionId: SessionId,
    taskId: TaskId,
    attemptId: OwnerAttemptId,
    generation: GenerationId,
  }),
  model: Schema.optional(Schema.NonEmptyString),
  effort: Schema.optional(Schema.NonEmptyString),
})

export type ChildRequest = typeof ChildRequestEnvelope.Type

interface Resources {
  readonly skillPaths: readonly string[]
  readonly provenance: readonly {
    readonly source: string
    readonly path: string
    readonly precedence: number
  }[]
  readonly guidance: string
  readonly soulPath: string
}

type SessionMessage = Pi.AgentSession['messages'][number]
type AssistantMessage = Extract<SessionMessage, { role: 'assistant' }>
type SessionStats = ReturnType<Pi.AgentSession['getSessionStats']>
type ContextUsage = ReturnType<Pi.AgentSession['getContextUsage']>

interface Telemetry {
  readonly usage?: {
    readonly input: number
    readonly output: number
    readonly cacheRead: number
    readonly cacheWrite: number
    readonly total: number
    readonly cost: number
    readonly userMessages: number
    readonly assistantMessages: number
    readonly toolCalls: number
    readonly toolResults: number
  }
  readonly context?: ContextUsage
}

interface ResourceContext {
  readonly packageVersion: string
  readonly cwd: string
  readonly access: AccessMode
  readonly profile: string
  readonly resources: Resources['provenance']
  readonly invokedSkill?: { readonly name: string; readonly path: string }
  readonly tools: readonly string[]
}

type ChildEmitter = (message: ChildMessage) => Promise<void>
type LoadedPi = Effect.Success<typeof loadPi>
export interface ChildServeOptions {
  readonly modelRuntime?: (
    pi: LoadedPi,
    request: ChildRequest
  ) => Effect.Effect<Pi.ModelRuntime, ChildError>
}
interface ChildRunOptions extends ChildServeOptions {
  readonly signal?: AbortSignal
}

const SKILL_COMMAND = '/skill:'

interface InitialPrompt {
  readonly text: string
  readonly skill?: Pi.Skill
}

interface ChildState {
  request?: ChildRequest
  session?: Pi.AgentSession
  runtime?: Pi.AgentSessionRuntime
  managed: boolean
  telemetry?: Telemetry
  model?: string
  effort?: Pi.AgentSession['thinkingLevel']
  sessionFile?: string
  shutdownError?: ChildError
  abortPromise?: Promise<void>
}

interface GitCapture {
  readonly chunks: Buffer[]
  bytes: number
  truncated: boolean
}

interface GitResult {
  readonly error?: unknown
  readonly stdout: string
  readonly stderr: string
  readonly truncated: boolean
}

interface SessionOutcome {
  readonly text: string
  readonly error?: string
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)\S+/gi, '$1[redacted]')
    .replace(/\b(?:sk|key|token)-[A-Za-z0-9_-]{12,}\b/g, '[redacted]')
}

function toChildError(error: unknown): ChildError {
  return error instanceof ChildError
    ? error
    : new ChildError({ message: errorMessage(error), cause: error })
}

function fail(message: string): never {
  throw new ChildError({ message })
}

const validateRequest = Effect.fn('validateRequest')(function* (raw: unknown) {
  const request = yield* Schema.decodeUnknownEffect(ChildRequestEnvelope)(raw).pipe(
    Effect.mapError(
      cause =>
        new ChildError({
          message:
            Predicate.isObject(raw) && !Array.isArray(raw)
              ? 'request is invalid'
              : 'request must be an object',
          cause,
        })
    )
  )
  const fs = yield* FileSystem.FileSystem
  const cwdExists = yield* fs.exists(request.cwd).pipe(Effect.mapError(toChildError))
  if (
    request.workspace.cwd !== request.cwd ||
    request.workspace.access !== (request.access === 'write' ? 'write' : 'read')
  )
    return yield* new ChildError({ message: 'Child request does not match its workspace grant' })
  yield* checkChildWorkspace(request.workspace, 'read').pipe(Effect.mapError(toChildError))
  if (!cwdExists)
    return yield* new ChildError({
      message: `request.cwd must be an existing directory: ${request.cwd}`,
    })
  const cwdInfo = yield* fs.stat(request.cwd).pipe(Effect.mapError(toChildError))
  if (cwdInfo.type !== 'Directory')
    return yield* new ChildError({
      message: `request.cwd must be an existing directory: ${request.cwd}`,
    })
  yield* fs
    .makeDirectory(request.dataHome, { recursive: true, mode: 0o700 })
    .pipe(Effect.mapError(toChildError))
  yield* fs
    .makeDirectory(request.sessionDir, { recursive: true, mode: 0o700 })
    .pipe(Effect.mapError(toChildError))
  return request
})

function modelReference(model: { readonly provider: string; readonly id: string }): string {
  return `${model.provider}/${model.id}`
}

function resolveExplicitModel(modelReferenceText: string, modelRuntime: Pi.ModelRuntime) {
  const available = [...modelRuntime.getModels()]
  if (
    !modelReferenceText.includes('/') ||
    modelReferenceText.startsWith('/') ||
    modelReferenceText.endsWith('/')
  )
    fail(`Invalid model "${modelReferenceText}". Use the exact provider/model-id form.`)
  const matches = available.filter(model => modelReference(model) === modelReferenceText)
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) fail(`Model "${modelReferenceText}" is ambiguous across supported models`)
  fail(`Unsupported model "${modelReferenceText}". Use an exact supported provider/model-id.`)
}

const resolveInitialPrompt = Effect.fn('resolveInitialPrompt')(function* (
  session: Pi.AgentSession,
  prompt: string
): Effect.fn.Return<InitialPrompt, ChildError, FileSystem.FileSystem> {
  const invocation = prompt.trimStart()
  if (!invocation.startsWith(SKILL_COMMAND)) return { text: prompt }
  const [, name = '', assignment = ''] = /^\/skill:(\S*)\s*([\s\S]*)$/.exec(invocation) ?? []
  if (name === '')
    return yield* new ChildError({ message: 'A skill invocation needs a skill name' })
  const skill = session.resourceLoader.getSkills().skills.find(candidate => candidate.name === name)
  if (skill === undefined)
    return yield* new ChildError({
      message: `Skill "${name}" is not in this child's catalog; no model request was made`,
    })
  const fs = yield* FileSystem.FileSystem
  yield* fs.access(skill.filePath, { readable: true }).pipe(
    Effect.mapError(
      cause =>
        new ChildError({
          message: `Skill "${name}" is unreadable at ${skill.filePath}; no model request was made`,
          cause,
        })
    )
  )
  if (session.extensionRunner.getCommand(`skill:${name}`) !== undefined)
    return yield* new ChildError({
      message: `An extension command named "skill:${name}" would run instead of the skill; no model request was made`,
    })
  const text = assignment.trim()
  return {
    text: text === '' ? `${SKILL_COMMAND}${name}` : `${SKILL_COMMAND}${name} ${text}`,
    skill,
  }
})

function childBrief(request: ChildRequest, resources: Resources): string {
  const inspection =
    request.coordinate === true
      ? 'read, grep, find, ls, the safe git_inspect tool and the work tool'
      : 'read, grep, find, ls, and the safe git_inspect tool'
  const access =
    request.access === 'read-only'
      ? `Review access is read-only. Use ${inspection} only.`
      : 'Work access is enabled for this child. Make only changes required by the assignment.'
  const delegation =
    request.coordinate === true
      ? 'The lead authorized you to coordinate this assignment: the work tool starts leaf children, whose outcomes reach you after your turn ends. Do not treat noninteractive UI absence as approval.'
      : 'Do not delegate work, start a background fleet, or treat noninteractive UI absence as approval.'
  return [
    'You are an independent Pi child process for one delegated attempt.',
    access,
    delegation,
    `Profile resources: ${resources.provenance.map(item => `${item.source}: ${item.path}`).join('; ')}`,
  ].join('\n')
}

function truncateGitOutput(text: string, rawTruncated = false): string {
  const bytes = Buffer.from(text, 'utf8')
  if (!rawTruncated && bytes.length <= MAX_GIT_OUTPUT) return text
  return `${bytes.subarray(0, MAX_GIT_OUTPUT).toString('utf8')}\n\n[git output truncated at ${MAX_GIT_OUTPUT} bytes]`
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_NO_LAZY_FETCH: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  }
}

function captureGitChunk(capture: GitCapture, chunk: Buffer | string): void {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
  const remaining = MAX_GIT_OUTPUT - capture.bytes
  if (remaining <= 0) {
    capture.truncated = true
    return
  }
  const kept = bytes.subarray(0, remaining)
  capture.chunks.push(Buffer.from(kept))
  capture.bytes += kept.length
  if (kept.length < bytes.length) capture.truncated = true
}

function capturedGitText(capture: GitCapture): string {
  return Buffer.concat(capture.chunks).toString('utf8')
}

const runGit = Effect.fnUntraced(function* (
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal
) {
  return yield* Effect.callback<GitResult>(resume => {
    const stdoutCapture: GitCapture = { chunks: [], bytes: 0, truncated: false }
    const stderrCapture: GitCapture = { chunks: [], bytes: 0, truncated: false }
    let spawnError: unknown
    let child: ReturnType<typeof spawn> | undefined
    let settled = false

    const finish = (result: GitResult) => {
      if (settled) return
      settled = true
      resume(Effect.succeed(result))
    }

    try {
      child = spawn('git', [...SAFE_GIT_OPTIONS, '-C', cwd, ...args], {
        env: gitEnvironment(),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      finish({ error, stdout: '', stderr: '', truncated: false })
      return
    }

    const abort = () => {
      child?.kill()
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    child.stdout?.on('data', (chunk: Buffer | string) => {
      process.stdout.write(chunk)
      captureGitChunk(stdoutCapture, chunk)
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      process.stderr.write(chunk)
      captureGitChunk(stderrCapture, chunk)
    })
    child.once('error', error => {
      spawnError = error
    })
    child.once('close', (code, signalName) => {
      signal?.removeEventListener('abort', abort)
      const error =
        spawnError ??
        (code === 0
          ? undefined
          : new Error(
              signalName ? `Git terminated by ${signalName}` : `Git exited with status ${code}`
            ))
      finish({
        error,
        stdout: capturedGitText(stdoutCapture),
        stderr: capturedGitText(stderrCapture),
        truncated: stdoutCapture.truncated || stderrCapture.truncated,
      })
    })

    return Effect.sync(() => {
      signal?.removeEventListener('abort', abort)
      if (!settled) child?.kill()
    })
  })
})

function validateRelativePath(path: unknown): string | undefined {
  if (path === undefined) return undefined
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0') || isAbsolute(path))
    fail('git_inspect path must be a non-empty relative path')
  if (path.split(/[\\/]/).includes('..')) fail('git_inspect path may not contain parent traversal')
  return path
}

function validateGitRef(ref: unknown): string {
  if (
    typeof ref !== 'string' ||
    ref.length === 0 ||
    ref.startsWith('-') ||
    ref.includes('\0') ||
    /[\s\\]/.test(ref) ||
    !/^[A-Za-z0-9][A-Za-z0-9._/@~^:-]*$/.test(ref)
  )
    fail('git_inspect ref is not a safe Git reference')
  return ref
}

function reviewOperation(value: unknown): ReviewOperation {
  if (typeof value !== 'string') fail('git_inspect operation is not allowed')
  const operation = REVIEW_OPERATIONS.find(candidate => candidate === value)
  if (operation === undefined) fail('git_inspect operation is not allowed')
  return operation
}

function gitArguments(params: unknown): readonly string[] {
  if (!Predicate.isObject(params) || Array.isArray(params))
    fail('git_inspect parameters must be an object')
  const operation = reviewOperation(params.operation)
  const path = validateRelativePath(params.path)
  switch (operation) {
    case 'status':
      return ['status', '--short', '--branch']
    case 'diff':
      return [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        ...(params.ref === undefined ? [] : [validateGitRef(params.ref)]),
        '--',
        ...(path ? [path] : []),
      ]
    case 'staged-diff':
      return ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--', ...(path ? [path] : [])]
    case 'log': {
      const limit = params.limit === undefined ? 20 : params.limit
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 50)
        fail('git_inspect limit must be an integer from 1 to 50')
      return ['log', '--oneline', '--decorate', `--max-count=${limit}`]
    }
    case 'show':
      return ['show', '--no-ext-diff', '--no-textconv', '--oneline', validateGitRef(params.ref)]
    case 'files':
      return ['ls-files', '--', ...(path ? [path] : [])]
  }
}

function toolResult(text: string): Pi.AgentToolResult<undefined> {
  return {
    content: [{ type: 'text', text }],
    details: undefined,
  }
}

function createReviewGitTool(cwd: string): Pi.ToolDefinition {
  const parameters = {
    type: 'object',
    additionalProperties: false,
    properties: {
      operation: {
        type: 'string',
        enum: [...REVIEW_OPERATIONS],
        description: 'Read-only Git operation to perform',
      },
      path: {
        type: 'string',
        description: 'Optional repository-relative path without parent traversal',
      },
      ref: {
        type: 'string',
        description: 'Git ref for show or optional diff base, such as HEAD or a commit hash',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        description: 'Maximum number of log entries',
      },
    },
    required: ['operation'],
  }
  return {
    name: 'git_inspect',
    label: 'git_inspect',
    description:
      "Inspect Git status, diffs, history, refs, or tracked files without changing the repository. Full raw output is retained in this attempt's stdout/stderr logs.",
    promptSnippet: 'Inspect Git state without mutation',
    parameters,
    async execute(_toolCallId, params, signal) {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const args = yield* Effect.try({ try: () => gitArguments(params), catch: toChildError })
          const gitResult = yield* runGit(cwd, args, signal).pipe(Effect.mapError(toChildError))
          const output =
            [
              gitResult.stdout,
              gitResult.stderr,
              gitResult.error ? errorMessage(gitResult.error) : undefined,
            ]
              .filter(Boolean)
              .join('\n')
              .trim() || '(no Git output)'
          if (gitResult.error !== undefined)
            return yield* new ChildError({
              message: truncateGitOutput(output, gitResult.truncated),
            })
          return toolResult(truncateGitOutput(output, gitResult.truncated))
        })
      )
      return result
    },
  }
}

function usageTotal(usage: AssistantMessage['usage'] | undefined): number {
  if (!usage) return 0
  return [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].reduce(
    (total, value) => total + (Number.isFinite(value) ? value : 0),
    0
  )
}

function hasAssistantUsage(session: Pi.AgentSession, stats: SessionStats): boolean {
  return (
    Number.isFinite(stats.tokens.total) &&
    stats.tokens.total > 0 &&
    session.messages.some(
      (message): message is AssistantMessage =>
        message.role === 'assistant' && usageTotal(message.usage) > 0
    )
  )
}

function telemetry(session: Pi.AgentSession): Telemetry {
  const stats = session.getSessionStats()
  const contextUsage = session.getContextUsage()
  if (!hasAssistantUsage(session, stats)) return contextUsage ? { context: contextUsage } : {}
  return {
    usage: {
      ...stats.tokens,
      cost: stats.cost,
      userMessages: stats.userMessages,
      assistantMessages: stats.assistantMessages,
      toolCalls: stats.toolCalls,
      toolResults: stats.toolResults,
    },
    ...(contextUsage ? { context: contextUsage } : {}),
  }
}

function finalAssistantOutcome(session: Pi.AgentSession): SessionOutcome {
  const assistant = session.messages
    .toReversed()
    .find((message): message is AssistantMessage => message.role === 'assistant')
  if (!assistant)
    return {
      text: '',
      error:
        'Native Pi run produced no assistant response; inspect the canonical session for preserved tool results.',
    }
  if (assistant.stopReason === 'error')
    return {
      text: '',
      error: errorMessage(assistant.errorMessage ?? 'Native Pi provider returned an error.'),
    }
  if (assistant.stopReason === 'aborted') return { text: '', error: 'Native Pi run aborted.' }
  const text = assistant.content
    .filter(content => content.type === 'text')
    .map(content => content.text)
    .join('')
    .trim()
  if (!text)
    return {
      text: '',
      error:
        'Native Pi run produced no non-empty assistant response; inspect the canonical session for preserved tool results.',
    }
  return { text }
}

function turnFailed(session: Pi.AgentSession): boolean {
  const assistant = session.messages.findLast(
    (message): message is AssistantMessage => message.role === 'assistant'
  )
  return (
    assistant === undefined ||
    assistant.stopReason === 'error' ||
    assistant.stopReason === 'aborted'
  )
}

function makeContext(
  request: ChildRequest,
  packageInfo: { readonly version: string },
  resources: Resources,
  invokedSkill: Pi.Skill | undefined,
  session: Pi.AgentSession
): ResourceContext {
  return {
    packageVersion: packageInfo.version,
    cwd: request.cwd,
    access: request.access,
    profile: request.profile,
    resources: resources.provenance,
    ...(invokedSkill === undefined
      ? {}
      : { invokedSkill: { name: invokedSkill.name, path: invokedSkill.filePath } }),
    tools: session.getActiveToolNames(),
  }
}

function serialEmitter(
  emit: ChildEmitter
): (message: ChildMessage) => Effect.Effect<void, ChildError> {
  let pending = Promise.resolve()
  return message =>
    Effect.tryPromise({
      try: () => {
        const next = pending.then(() => emit(message))
        pending = next.catch(() => {})
        return next
      },
      catch: toChildError,
    }).pipe(Effect.asVoid)
}

function abortSession(state: ChildState): Effect.Effect<void, ChildError> {
  const { session } = state
  if (!session) return Effect.void
  return Effect.tryPromise({
    try: () => {
      state.abortPromise ??= session.abort()
      return state.abortPromise
    },
    catch: toChildError,
  }).pipe(Effect.asVoid)
}

function releaseSession(
  state: ChildState,
  resource: { readonly runtime: Pi.AgentSessionRuntime },
  signal: AbortSignal | undefined
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    if (signal?.aborted) yield* abortSession(state).pipe(Effect.ignore)
    yield* Effect.tryPromise({
      try: () => resource.runtime.dispose(),
      catch: toChildError,
    }).pipe(
      Effect.catch(error =>
        Effect.sync(() => {
          state.shutdownError ??= error
        })
      )
    )
  })
}

function disposeUnmanaged(state: ChildState): Effect.Effect<void, never> {
  if (state.managed) return Effect.void
  const { runtime, session } = state
  if (runtime !== undefined)
    return Effect.tryPromise({
      try: () => runtime.dispose(),
      catch: toChildError,
    }).pipe(
      Effect.catch(error =>
        Effect.sync(() => {
          state.shutdownError ??= error
        })
      ),
      Effect.asVoid
    )
  return Effect.sync(() => {
    try {
      session?.dispose()
    } catch (error) {
      state.shutdownError ??= toChildError(error)
    }
  })
}

function registerAbortSignal(
  state: ChildState,
  session: Pi.AgentSession,
  signal: AbortSignal | undefined
): Effect.Effect<void | (() => void), never> {
  if (!signal) return Effect.void
  return Effect.sync(() => {
    const onAbort = () => {
      try {
        state.abortPromise ??= session.abort()
        void state.abortPromise.catch(() => {})
      } catch {}
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    return () => signal.removeEventListener('abort', onAbort)
  })
}

const acquireSession = Effect.fn('acquireSession')(function* (
  state: ChildState,
  request: ChildRequest,
  options: ChildServeOptions,
  link: CoordinatorLink | undefined
) {
  if (request.access === 'read-only')
    yield* Effect.sync(() => {
      process.env.PI_OFFLINE = '1'
    })
  const loaded = yield* loadPi.pipe(Effect.mapError(toChildError))
  const profile = yield* getProfile(request.profile).pipe(Effect.mapError(toChildError))
  const projectGitRoot = yield* gitRoot(request.cwd).pipe(Effect.mapError(toChildError))
  const resources = yield* composeResources({
    cwd: request.cwd,
    gitRoot: projectGitRoot,
    profile,
  }).pipe(Effect.mapError(toChildError))
  const projectTrusted = yield* Effect.try({
    try: () =>
      request.access === 'write' &&
      (!loaded.api.hasTrustRequiringProjectResources(request.cwd) ||
        new loaded.api.ProjectTrustStore(request.dataHome).get(request.cwd) === true),
    catch: toChildError,
  })
  const settingsManager = yield* Effect.try({
    try: () =>
      loaded.api.SettingsManager.create(request.cwd, globalPiAgentDir(), {
        projectTrusted,
      }),
    catch: toChildError,
  })
  yield* Effect.try({
    try: () =>
      settingsManager.applyOverrides({
        retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
      }),
    catch: toChildError,
  })
  const modelRuntime = yield* options.modelRuntime === undefined
    ? Effect.tryPromise({
        try: () => loaded.api.ModelRuntime.create({ authPath: globalPiAuthPath() }),
        catch: toChildError,
      })
    : options.modelRuntime(loaded, request)
  const services = yield* Effect.tryPromise({
    try: () =>
      loaded.api.createAgentSessionServices({
        cwd: request.cwd,
        agentDir: globalPiAgentDir(),
        modelRuntime,
        settingsManager,
        resourceLoaderOptions: {
          additionalSkillPaths: [...resources.skillPaths],
          appendSystemPrompt: [resources.guidance, childBrief(request, resources)].filter(Boolean),
          noExtensions: request.access === 'read-only',
          extensionFactories: [
            { name: 'dev:child-workspace', factory: childWorkspaceExtension(request.workspace) },
          ],
        },
      }),
    catch: toChildError,
  })
  const startupErrors = services.diagnostics.filter(diagnostic => diagnostic.type === 'error')
  if (startupErrors.length > 0)
    return yield* new ChildError({
      message: startupErrors.map(diagnostic => diagnostic.message).join('; '),
    })
  const requestedModel = request.model
  const explicitModel =
    requestedModel === undefined
      ? undefined
      : yield* Effect.try({
          try: () => resolveExplicitModel(requestedModel, services.modelRuntime),
          catch: toChildError,
        })
  const sessionManager = yield* Effect.try({
    try: () => loaded.api.SessionManager.create(request.cwd, request.sessionDir),
    catch: toChildError,
  })
  const customTools = [
    ...(request.access === 'read-only' ? [createReviewGitTool(request.cwd)] : []),
    ...(link === undefined ? [] : [createCoordinatorWorkTool(link)]),
  ]
  const tools =
    request.access === 'read-only'
      ? ['read', 'grep', 'find', 'ls', 'git_inspect', ...(link === undefined ? [] : ['work'])]
      : undefined
  const created = yield* Effect.tryPromise({
    try: () =>
      loaded.api.createAgentSessionFromServices({
        services,
        sessionManager,
        model: explicitModel,
        tools,
        customTools: customTools.length === 0 ? undefined : customTools,
      }),
    catch: toChildError,
  })
  const { session } = created
  state.session = session
  const { sessionFile } = session
  if (!sessionFile)
    return yield* new ChildError({ message: 'Pi did not create a session file for the child run' })
  state.sessionFile = sessionFile
  yield* Effect.tryPromise({
    try: () => session.bindExtensions({ mode: 'json' }),
    catch: toChildError,
  })
  const runtime = yield* Effect.try({
    try: () =>
      new loaded.api.AgentSessionRuntime(session, services, async () => {
        throw new Error('Session replacement is not available in a Pi child process')
      }),
    catch: toChildError,
  })
  state.runtime = runtime
  const { model } = session
  if (!model)
    return yield* new ChildError({ message: 'Pi did not select a model for the child run' })
  const modelText = modelReference(model)
  state.model = modelText
  const initialEffort = session.thinkingLevel
  state.effort = initialEffort
  if (request.effort !== undefined) {
    const effort = session.getAvailableThinkingLevels().find(level => level === request.effort)
    if (effort === undefined)
      return yield* new ChildError({
        message: `Unsupported effort "${request.effort}" for ${modelText}`,
      })
    session.setThinkingLevel(effort)
    state.effort = session.thinkingLevel
  }
  const initialPrompt = yield* resolveInitialPrompt(session, request.prompt)
  const resourceContext = makeContext(
    request,
    loaded.packageInfo,
    resources,
    initialPrompt.skill,
    session
  )
  return {
    session,
    runtime,
    initialPrompt,
    resourceContext,
    modelText,
    initialEffort,
    sessionFile,
  }
})

function skillExpanded(session: Pi.AgentSession, skill: Pi.Skill): boolean {
  const first = session.messages.find(message => message.role === 'user')
  if (first === undefined) return false
  const text =
    typeof first.content === 'string'
      ? first.content
      : first.content.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('')
  return text.startsWith(`<skill name="${skill.name}"`)
}

function runSession(
  state: ChildState,
  request: ChildRequest,
  send: (message: ChildMessage) => Effect.Effect<void, ChildError>,
  options: ChildRunOptions
) {
  const { signal } = options
  return Effect.gen(function* () {
    const context = yield* Effect.context()
    const link = request.coordinate === true ? yield* acquireCoordinatorLink(signal) : undefined
    const resource = yield* Effect.acquireRelease(
      acquireSession(state, request, options, link),
      acquired => releaseSession(state, acquired, signal)
    )
    state.managed = true
    yield* Effect.acquireRelease(registerAbortSignal(state, resource.session, signal), cleanup =>
      Effect.sync(() => cleanup?.())
    )
    if (signal?.aborted)
      return yield* new ChildError({ message: 'Child run cancelled before ready' })
    yield* send({
      type: 'ready',
      model: resource.modelText,
      effort: resource.session.thinkingLevel,
      sessionFile: resource.sessionFile,
      resources: resource.resourceContext,
    })
    const lastProgress = { value: 0 }
    const emitProgress = Effect.fnUntraced(function* (force: boolean) {
      const now = force ? 0 : yield* Clock.currentTimeMillis
      if (!force && now - lastProgress.value < PROGRESS_INTERVAL_MS) return
      if (!force) lastProgress.value = now
      const current = telemetry(resource.session)
      state.telemetry = current
      yield* send({ type: 'progress', usage: current.usage, context: current.context })
    })
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        resource.session.subscribe(event => {
          if (event.type !== 'turn_end') return
          void Effect.runPromiseWith(context)(emitProgress(false)).catch(() => {})
        })
      ),
      cleanup => Effect.sync(cleanup)
    )
    if (signal?.aborted)
      return yield* new ChildError({ message: 'Child run cancelled before prompt' })
    const { initialPrompt } = resource
    yield* Effect.tryPromise({
      try: () =>
        resource.session.prompt(initialPrompt.text, {
          expandPromptTemplates: initialPrompt.skill !== undefined,
          source: 'rpc',
        }),
      catch: toChildError,
    })
    if (signal?.aborted) return yield* new ChildError({ message: 'Child run cancelled' })
    if (initialPrompt.skill !== undefined && !skillExpanded(resource.session, initialPrompt.skill))
      return yield* new ChildError({
        message: `Pi did not expand the invocation of skill "${initialPrompt.skill.name}"`,
      })
    if (link !== undefined)
      yield* coordinate(
        resource.session,
        link,
        () => signal?.aborted === true || turnFailed(resource.session)
      ).pipe(Effect.mapError(toChildError))
    if (signal?.aborted) return yield* new ChildError({ message: 'Child run cancelled' })
    const outcome = finalAssistantOutcome(resource.session)
    const current = telemetry(resource.session)
    state.telemetry = current
    yield* send({ type: 'progress', usage: current.usage, context: current.context })
    return outcome
  }).pipe(
    Effect.tapError(() =>
      Effect.sync(() => {
        if (state.session) state.telemetry = telemetry(state.session)
      })
    ),
    Effect.scoped,
    Effect.ensuring(disposeUnmanaged(state))
  )
}

function childResult(state: ChildState, text: string, error?: string): ChildResultMessage {
  return {
    type: 'result',
    text,
    ...(error === undefined ? {} : { error }),
    ...state.telemetry,
    ...(state.model === undefined ? {} : { model: state.model }),
    ...(state.effort === undefined ? {} : { effort: state.effort }),
    ...(state.sessionFile === undefined ? {} : { sessionFile: state.sessionFile }),
  }
}

export const runPiChild = Effect.fn('runPiChild')(function* (
  rawRequest: unknown,
  emit: ChildEmitter,
  options: ChildRunOptions = {}
) {
  const send = serialEmitter(emit)
  const state: ChildState = { managed: false }
  const attempt = yield* Effect.result(
    Effect.gen(function* () {
      const request = yield* validateRequest(rawRequest)
      state.request = request
      return yield* Effect.result(runSession(state, request, send, options))
    })
  )

  let result: ChildResultMessage
  let exitCode = 1
  if (attempt._tag === 'Failure') {
    const cancelled = options.signal?.aborted === true
    result = childResult(
      state,
      '',
      cancelled ? 'Child run cancelled' : errorMessage(attempt.failure)
    )
  } else if (attempt.success._tag === 'Failure') {
    const cancelled = options.signal?.aborted === true
    result = childResult(
      state,
      '',
      cancelled ? 'Child run cancelled' : errorMessage(attempt.success.failure)
    )
  } else {
    const outcome = attempt.success.success
    if (outcome.error !== undefined) {
      result = childResult(state, outcome.text, outcome.error)
      exitCode = 1
    } else if (state.shutdownError) {
      result = childResult(
        state,
        '',
        `Pi child shutdown failed: ${errorMessage(state.shutdownError)}`
      )
    } else {
      result = childResult(state, outcome.text)
      exitCode = 0
    }
  }
  yield* send(result)
  return exitCode
})

function sendIpc(message: ChildMessage): Promise<void> {
  return new Promise(resolve => {
    if (typeof process.send !== 'function' || !process.connected) {
      resolve()
      return
    }
    try {
      process.send(message, () => resolve())
    } catch {
      resolve()
    }
  })
}

const IpcMessage = Schema.Union([
  Schema.Struct({ type: Schema.Literal('cancel') }),
  Schema.Struct({ type: Schema.Literal('start'), request: Schema.optional(Schema.Unknown) }),
])
type IpcMessage = typeof IpcMessage.Type

function decodeIpcMessage(message: unknown): IpcMessage | undefined {
  try {
    return Schema.decodeUnknownSync(IpcMessage)(message)
  } catch {
    return undefined
  }
}

export function serveChild(options: ChildServeOptions = {}): void {
  if (typeof process.send !== 'function') {
    console.error('src/pi-child.ts must be launched with child_process.fork and IPC')
    process.exitCode = 2
    return
  }
  let controller: AbortController | undefined
  let started = false
  let closing = false
  let pendingAbort = false
  const abort = () => {
    pendingAbort = true
    controller?.abort()
  }
  process.on('SIGTERM', abort)
  process.on('SIGINT', abort)
  process.on('disconnect', abort)
  process.on('message', (rawMessage: unknown) => {
    const message = decodeIpcMessage(rawMessage)
    if (!message) return
    if (message.type === 'cancel') {
      abort()
      return
    }
    if (started || closing) return
    started = true
    controller = new AbortController()
    if (pendingAbort) controller.abort()
    const program = runPiChild(message.request, sendIpc, {
      ...options,
      signal: controller.signal,
    }).pipe(Effect.provide(NodeServices.layer))
    void Effect.runPromise(program)
      .catch(error => {
        console.error(errorMessage(error))
        return 1
      })
      .then(exitCode => {
        closing = true
        if (process.connected) process.disconnect()
        process.exitCode = exitCode ?? 1
      })
  })
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
  } catch {
    return false
  }
}

if (isMainModule()) serveChild()
