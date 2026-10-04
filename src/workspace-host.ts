import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Option,
  Schema,
  type Scope,
  Stream,
} from 'effect'
import type { ChildProcessSpawner } from 'effect/process'
import { closeSync, lstatSync, existsSync, openSync, readSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { basename, resolve } from 'node:path'
import type {
  AgentSessionRuntime,
  BashOperations,
  EditOperations,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ProjectTrustContext,
  SessionManager,
  ToolCallEventResult,
  WriteOperations,
} from '@earendil-works/pi-coding-agent'
import type { ReplacedSessionContext } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.js'
import { errorText } from './error-text.ts'
import {
  formatAssessments,
  formatReleaseRun,
  formatSweepReceipt,
  needsExplicitRelease,
  noExplicitRelease,
  parseWorkspaceCommand,
  releaseConfirmation,
  runReadOnlyWorkspaceCommand,
  runRelease,
  type WorkspaceCommand,
} from './workspace-command.ts'
import {
  WorkspaceError,
  type SweepReceipt,
  type WorkspaceAttachment,
  type WorkspaceBinding,
  type BoundConversation,
  type WorkspaceConversation,
  type WorkspaceGrant,
  type WorkspaceHandoff,
} from './workspace-domain.ts'
import { makeWorkspaceTool, type PublicationDestinations } from './workspace-tool.ts'
import { WorkspaceAuthorityClient } from './workspace-lifecycle.ts'
import { RepositoryRoot } from './preferences.ts'
import { makeNativeWrites } from './workspace-native-write.ts'
import {
  canonicalConversationFile,
  classifyWriteDestination,
  decodeWriteOperand,
  isWithin,
} from './workspace-paths.ts'
import { newId, hasErrorCode } from './workspace-platform.ts'
import { makeWorkspaceShell } from './workspace-shell.ts'

export class WorkspaceHostError extends Schema.TaggedError<WorkspaceHostError>()(
  'WorkspaceHostError',
  { message: Schema.String }
) {}

export interface WorkspaceHostOptions {
  readonly attachment: WorkspaceAttachment
  readonly dataHome: string
  readonly openSessionManager: (sessionFile: string, cwdOverride?: string) => SessionManager
  readonly resolveImportPath: (input: string) => string
}

export interface RuntimeWorkspace {
  readonly attachment: WorkspaceAttachment
  readonly sessionManager: SessionManager
  readonly cwd: string
}

export interface WorkspaceHost {
  readonly extensionFactory: (api: ExtensionAPI) => void
  readonly attachment: WorkspaceAttachment
  readonly shellOperations: BashOperations
  readonly writeOperations: WriteOperations
  readonly editOperations: EditOperations
  readonly quitRequested: Deferred.Deferred<void>
  interceptQuit(enabled: boolean): void
  isParked(): boolean

  isDetached(): boolean
  requestRebind(
    handoff: WorkspaceHandoff,
    source: WorkspaceAttachment,
    context: ExtensionContext
  ): void
  prepareRuntime(input: {
    readonly sessionManager: SessionManager
    readonly cwd: string
  }): Effect.Effect<RuntimeWorkspace, WorkspaceHostError | WorkspaceError>
  commitRuntime(attachment: WorkspaceAttachment): Effect.Effect<void, WorkspaceError>
  bindRuntime(runtime: AgentSessionRuntime): void
  readonly close: Effect.Effect<void, WorkspaceError>
}

const TRANSITION_STAGES = ['requested', 'scheduled', 'handoff-sent', 'switch-started'] as const
type TransitionStage = (typeof TRANSITION_STAGES)[number]
const reached = (transition: PendingTransition | undefined, stage: TransitionStage): boolean =>
  transition !== undefined &&
  TRANSITION_STAGES.indexOf(transition.stage) >= TRANSITION_STAGES.indexOf(stage)

interface PendingTransition {
  readonly handoff: WorkspaceHandoff
  readonly origin: 'tool-call' | 'tool-resume' | 'user-bash'
  readonly surface: Surface
  readonly settled: Deferred.Deferred<void>
  readonly transitionSource: WorkspaceAttachment
  stage: TransitionStage
  capturedInput: boolean
}

interface HostToolInfo {
  readonly name: string
  readonly sourceInfo: { readonly path: string; readonly source: string }
}

interface HostToolCallEvent {
  readonly toolName: string
  readonly toolCallId: string
  readonly input: unknown
}

type Admission =
  | { readonly kind: 'admitted'; readonly grant: WorkspaceGrant; readonly warning?: string }
  | { readonly kind: 'refused'; readonly reason: string }

type WriterAdmission =
  | { readonly kind: 'admitted'; readonly grant: WorkspaceGrant }
  | { readonly kind: 'refused'; readonly refusal: ToolCallEventResult }

type ReleaseCommand = Extract<WorkspaceCommand, { readonly kind: 'release' }>

interface ConversationIdentity {
  readonly sessionId: string
  readonly sessionFile: string | undefined
}

const hostFailure = (message: string) => new WorkspaceHostError({ message })
const decodeSessionLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const decodeSessionHeader = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal('session'),
    id: Schema.String,
    cwd: Schema.optional(Schema.String),
  })
)

const SESSION_HEADER_CHUNK_BYTES = 64 * 1024
const headerCwd = (line: string): string | undefined => {
  const entry = decodeSessionLine(line)
  if (Option.isNone(entry) || !entry.value) return undefined
  const header = decodeSessionHeader(entry.value)
  return Option.isSome(header) ? (header.value.cwd ?? process.cwd()) : process.cwd()
}
const sessionFileCwd = (file: string): string => {
  const fd = openSync(file, 'r')
  try {
    const chunk = Buffer.allocUnsafe(SESSION_HEADER_CHUNK_BYTES)
    const decoder = new StringDecoder('utf8')
    let buffered = ''
    for (;;) {
      const count = readSync(fd, chunk, 0, chunk.length, null)
      const ended = count === 0
      buffered += ended ? decoder.end() : decoder.write(chunk.subarray(0, count))
      const lines = buffered.split('\n')
      buffered = ended ? '' : (lines.pop() ?? '')
      for (const line of lines) {
        const cwd = headerCwd(line)
        if (cwd !== undefined) return cwd
      }
      if (ended) return process.cwd()
    }
  } finally {
    closeSync(fd)
  }
}

const piCall = <A>(call: () => Promise<A>): Effect.Effect<A> => Effect.promise(call)
const pendingSwitchNotice =
  'A workspace switch is still in progress, so the session was not replaced; try again once it finishes.'
const unresolvedSwitchNotice =
  'An earlier workspace switch is unresolved and needs explicit recovery, which dev does not offer yet, so the session was not replaced; quit dev to leave it.'
const fromPi = <A>(operation: () => Promise<A>): Effect.Effect<A, WorkspaceHostError> =>
  Effect.tryPromise({
    try: operation,
    catch: cause => hostFailure(errorText(cause)),
  })

const isWithdrawn = (error: unknown): boolean =>
  error instanceof WorkspaceError && error.outcome === 'blocked'

const conversationFile = (file: string): string => {
  try {
    return canonicalConversationFile(file)
  } catch {
    return resolve(file)
  }
}

const sessionKey = (file: string, id: string): string => `${conversationFile(file)}\0${id}`

const identityOf = (
  manager: Pick<SessionManager, 'getSessionId' | 'getSessionFile'>
): ConversationIdentity => ({
  sessionId: manager.getSessionId(),
  sessionFile: manager.getSessionFile(),
})

const isBoundTo = (bound: BoundConversation, identity: ConversationIdentity): boolean =>
  bound.sessionId === identity.sessionId &&
  identity.sessionFile !== undefined &&
  conversationFile(identity.sessionFile) === bound.sessionFile

export const sameConversation = (a: ConversationIdentity, b: ConversationIdentity): boolean =>
  a.sessionId === b.sessionId &&
  a.sessionFile !== undefined &&
  b.sessionFile !== undefined &&
  conversationFile(a.sessionFile) === conversationFile(b.sessionFile)

export const noUiTrustContext = (cwd: string): ProjectTrustContext => ({
  cwd,
  mode: 'tui',
  hasUI: false,
  ui: {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    notify: () => undefined,
  },
})

type Surface = Pick<ExtensionContext, 'mode' | 'hasUI' | 'ui'>
const surfaceOf = (context: ExtensionContext): Surface => ({
  mode: context.mode,
  hasUI: context.hasUI,
  ui: context.ui,
})

const trustContextFor = (context: Surface | undefined, cwd: string): ProjectTrustContext =>
  context
    ? { cwd, mode: context.mode, hasUI: context.hasUI, ui: context.ui }
    : noUiTrustContext(cwd)

const notify = (
  context: Pick<ExtensionContext, 'hasUI' | 'ui'> | undefined,
  message: string,
  level: 'info' | 'warning' | 'error' = 'info'
): void => {
  if (context?.hasUI) context.ui.notify(message, level)
  else process.stderr.write(`${message}\n`)
}

const display = (api: ExtensionAPI, context: ExtensionContext, message: string): void => {
  if (context.hasUI) {
    api.sendMessage(
      { customType: 'dev/workspace', content: message, display: true },
      { triggerTurn: false }
    )
  } else {
    process.stderr.write(`${message}\n`)
  }
}

const switchNotices = (
  { origin, handoff }: PendingTransition,
  binding: WorkspaceBinding
): { readonly user: string; readonly model: string; readonly unqueued: string } => {
  const current = `Current workspace: ${handoff.target.workspaceId} at ${handoff.target.cwd}.`
  return origin === 'tool-resume'
    ? {
        user: `Workspace is now ${binding.workspaceId} at ${binding.cwd}.`,
        model: `This conversation resumed onto a retained workspace through the workspace tool: ${handoff.reason}. ${current} Continue the conversation in this new context.`,
        unqueued: 'Submit a new prompt.',
      }
    : {
        user: `Workspace is now ${binding.workspaceId} at ${binding.cwd}. The blocked operation was not replayed.`,
        model: `Workspace admission changed after ${handoff.reason}. The prior operation was blocked and was not replayed. ${current} Re-evaluate the user's request using this new context; do not repeat the blocked tool payload.`,
        unqueued: 'The blocked request was not replayed; submit a new prompt.',
      }
}

export const keptConversationGuidance = (
  sessionFile: string,
  scope: 'workspace' | 'import' = 'workspace'
): string => {
  let fileState: string
  try {
    const stat = lstatSync(sessionFile)
    fileState =
      stat.isFile() && !stat.isSymbolicLink()
        ? `The existing conversation file and its saved history were not modified: ${sessionFile}`
        : `The session path is not a regular conversation file; its filesystem entry was not modified: ${sessionFile}`
  } catch (cause) {
    fileState = hasErrorCode(cause, 'ENOENT')
      ? `No conversation file currently exists at: ${sessionFile}`
      : `The conversation file state could not be verified; dev did not modify it: ${sessionFile}`
  }
  const nextAction =
    scope === 'workspace'
      ? 'Resolve the reported refusal before retrying this conversation. A new conversation does not bypass repository identity checks.'
      : 'Resolve the session import refusal before retrying; dev did not modify the source file.'
  return `${fileState}\n${nextAction}`
}

type ToolEffect = 'read' | 'native-write' | 'workspace-shell' | 'work-owner' | 'workspace-tool'

function toolEffect(tool: HostToolInfo | undefined): ToolEffect | undefined {
  if (!tool) return undefined
  const { source, path } = tool.sourceInfo
  if (source === 'builtin' && ['read', 'grep', 'find', 'ls'].includes(tool.name)) return 'read'
  if (source === 'sdk' && path === '<sdk:bash>') return 'workspace-shell'
  if (source === 'sdk' && (path === '<sdk:write>' || path === '<sdk:edit>')) return 'native-write'
  if (source === 'inline' && path === '<inline:dev:work>' && tool.name === 'work')
    return 'work-owner'
  if (source === 'inline' && path === '<inline:dev:workspace-host>' && tool.name === 'workspace')
    return 'workspace-tool'
  return undefined
}

function getToolInfo(api: ExtensionAPI, toolName: string): HostToolInfo | undefined {
  return api
    .getAllTools()
    .filter(tool => tool.name === toolName)
    .at(-1)
}

const workspaceConversation = (
  manager: SessionManager,
  dataHome: string
): Effect.Effect<WorkspaceConversation, WorkspaceHostError> =>
  Effect.suspend(() => {
    const sessionFile = manager.getSessionFile()
    if (!sessionFile)
      return Effect.fail(
        hostFailure('Workspace-bound conversations require a persisted Pi session file')
      )
    return Effect.succeed({ sessionId: manager.getSessionId(), sessionFile, dataHome })
  })

const withdraw = (source: WorkspaceAttachment, handoff: WorkspaceHandoff) =>
  source
    .handoff(handoff, () => Effect.succeed('cancelled' as const))
    .pipe(Effect.catchIf(isWithdrawn, () => Effect.void))
export const makeWorkspaceHost = Effect.fnUntraced(function* (
  options: WorkspaceHostOptions
): Effect.fn.Return<
  WorkspaceHost,
  never,
  | Scope.Scope
  | WorkspaceAuthorityClient
  | RepositoryRoot
  | PublicationDestinations
  | ChildProcessSpawner.ChildProcessSpawner
> {
  const authority = yield* WorkspaceAuthorityClient
  const repositoryRoot = yield* RepositoryRoot
  let activeAttachment = options.attachment
  let activeConversation = activeAttachment.binding.conversation
  let activeManager: SessionManager | undefined
  let runtime: AgentSessionRuntime | undefined
  let currentContext: ExtensionContext | undefined
  let currentApi: ExtensionAPI | undefined

  let parked: false | 'switch' = false
  let closed = false
  let pending: PendingTransition | undefined
  let invokingHandoffSwitch = false
  let replacing = false
  let quitting = false
  const withdrawals = new Map<WorkspaceAttachment, Fiber.Fiber<void>>()
  let quitInterception: 'off' | 'armed' | 'handed-over' = 'off'
  const quitRequested = Deferred.makeUnsafe<void>()
  let runtimePreparationSerial = 0
  let pendingReopen:
    | {
        readonly sessionFile: string
        readonly sessionId: string
        readonly minimumEntries: number
      }
    | undefined
  const stagedAttachments = new Map<string, WorkspaceAttachment>()
  const preparedAttachments = new Set<WorkspaceAttachment>()
  const closedAttachments = new WeakSet<WorkspaceAttachment>()
  const detachedAttachments = new WeakSet<WorkspaceAttachment>()
  const preservedInput: string[] = []
  const readerWarnings = new Map<string, string>()
  let writerWarned = false

  const runPromise = Effect.runPromiseWith(yield* Effect.context<PublicationDestinations>())
  const nativeWrites = makeNativeWrites({
    runPromise,
    onError: message => notify(currentContext, message, 'error'),
  })
  const shell = yield* makeWorkspaceShell(cwd =>
    Effect.suspend(() => {
      const attachment = activeAttachment
      return attachment.authorize({ kind: 'write', cwd }).pipe(
        Effect.flatMap(result =>
          result.kind === 'ready'
            ? Effect.succeed({ attachment, grant: result.grant })
            : Effect.fail(
                new WorkspaceError({
                  outcome: 'blocked',
                  message:
                    'Workspace admission requires a host rebind; the command was not executed.',
                })
              )
        )
      )
    })
  )

  const background = yield* FiberSet.make<void>()
  const runInBackground = yield* FiberSet.runtime(background)()

  const runDeferred = (effect: Effect.Effect<void>) =>
    runInBackground(Effect.yieldNow.pipe(Effect.andThen(effect)))

  const importOutsideCheckout = Effect.fnUntraced(function* (
    source: string,
    cwdOverride: string | undefined
  ): Effect.fn.Return<string | undefined> {
    const cwd =
      cwdOverride ??
      (yield* Effect.try({ try: () => sessionFileCwd(source), catch: () => undefined }).pipe(
        Effect.orElseSucceed(() => undefined)
      ))
    if (cwd === undefined) return undefined
    const resolved = options.resolveImportPath(cwd)
    if (!(yield* Effect.sync(() => existsSync(resolved)))) return undefined
    if ((yield* repositoryRoot.resolve(resolved)) !== undefined) return undefined
    return `The session was not imported: its working directory is not inside a Git checkout: ${resolved}\n${keptConversationGuidance(source, 'import')}`
  })

  const showSweep = (receipt: SweepReceipt): void => {
    const text = formatSweepReceipt(receipt)
    if (currentApi === undefined || !currentContext?.hasUI) {
      process.stderr.write(`${text}\n`)
      return
    }
    try {
      currentApi.sendMessage(
        { customType: 'dev/workspace', content: text, display: true },
        { triggerTurn: false }
      )
    } catch {
      process.stderr.write(`${text}\n`)
    }
  }
  const followedSweeps = new WeakSet<WorkspaceAttachment>()
  const followSweeps = (attachment: WorkspaceAttachment): void => {
    if (followedSweeps.has(attachment)) return
    followedSweeps.add(attachment)
    runInBackground(
      Stream.runForEach(attachment.sweeps, receipt => Effect.sync(() => showSweep(receipt)))
    )
  }
  followSweeps(options.attachment)

  const closeAttachmentOnce = (attachment: WorkspaceAttachment) =>
    Effect.suspend(() => {
      if (closedAttachments.has(attachment)) return Effect.void
      closedAttachments.add(attachment)
      const withdrawal = withdrawals.get(attachment)
      withdrawals.delete(attachment)
      return (withdrawal === undefined ? Effect.void : Fiber.await(withdrawal)).pipe(
        Effect.andThen(attachment.close),
        Effect.tap(() =>
          Effect.sync(() => {
            detachedAttachments.add(attachment)
          })
        )
      )
    })

  const currentSessionIdentity = Effect.suspend(() => {
    const manager = runtime?.session.sessionManager ?? activeManager
    const sessionFile = manager?.getSessionFile()
    if (!manager || !sessionFile)
      return Effect.fail(hostFailure('Active Pi runtime has no persisted session file'))
    return Effect.succeed({ sessionId: manager.getSessionId(), sessionFile })
  })

  const capturePendingInput = (context: Surface): void => {
    if (pending?.capturedInput) return
    const session = runtime?.session
    if (session) {
      const queued = session.clearQueue()
      preservedInput.push(...queued.steering, ...queued.followUp)
    }
    if (context.hasUI) {
      const draft = context.ui.getEditorText()
      if (draft.length > 0) preservedInput.push(draft)
      context.ui.setEditorText('')
    }
    if (pending) pending.capturedInput = true
  }

  const restoreInput = (context: Surface | undefined): void => {
    if (!preservedInput.length || !context?.hasUI) return
    context.ui.setEditorText(preservedInput.splice(0).join('\n\n'))
  }

  const assertSessionIdle = Effect.gen(function* () {
    if (!runtime)
      return yield* hostFailure('No active Pi runtime is available for workspace handoff')
    const { session } = runtime
    yield* fromPi(() => session.waitForIdle())
    if (!session.isIdle || session.pendingMessageCount !== 0 || session.isBashRunning)
      return yield* hostFailure(
        'Pi did not reach an idle, settled boundary; workspace host remains parked'
      )
  })

  const replaceSession = Effect.fnUntraced(function* (
    transition: PendingTransition,
    identity: { readonly sessionId: string; readonly sessionFile: string },
    target: WorkspaceGrant,
    settle: (outcome: 'confirmed' | 'cancelled') => void
  ): Effect.fn.Return<'confirmed' | 'cancelled', WorkspaceHostError> {
    if (quitting) {
      settle('cancelled')
      return 'cancelled'
    }
    transition.stage = 'switch-started'
    const currentRuntime = runtime
    if (!currentRuntime)
      return yield* hostFailure('Pi runtime disappeared before workspace replacement')
    const trustSnapshot = trustContextFor(transition.surface, transition.handoff.target.cwd)
    const withSession = async (fresh: ReplacedSessionContext): Promise<void> => {
      restoreInput(fresh)
      const { binding } = activeAttachment
      if (
        !isBoundTo(binding.conversation, identityOf(fresh.sessionManager)) ||
        binding.workspaceId !== transition.handoff.target.workspaceId ||
        resolve(binding.cwd) !== resolve(fresh.cwd)
      ) {
        throw new Error(
          'Pi replacement context does not carry the authority-selected workspace attachment'
        )
      }
    }
    invokingHandoffSwitch = true
    const result = yield* fromPi(() =>
      currentRuntime.switchSession(identity.sessionFile, {
        cwdOverride: target.cwd,
        projectTrustContextFactory: cwd => ({ ...trustSnapshot, cwd }),
        withSession,
      })
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          invokingHandoffSwitch = false
        })
      )
    )
    if (result.cancelled) {
      settle('cancelled')
      return 'cancelled' as const
    }
    const current = activeAttachment.binding
    if (
      !isBoundTo(current.conversation, identity) ||
      current.workspaceId !== target.workspaceId ||
      resolve(current.cwd) !== resolve(target.cwd) ||
      resolve(currentRuntime.cwd) !== resolve(target.cwd)
    )
      return yield* hostFailure(
        'Pi replacement completed without the authority-selected workspace binding'
      )
    settle('confirmed')
    return 'confirmed' as const
  })

  const queueReevaluation = (transition: PendingTransition): void => {
    const api = currentApi
    if (!api) {
      process.stderr.write(
        'Workspace switch completed, but no active Pi extension API is available for fresh re-evaluation; submit a new prompt.\n'
      )
      return
    }
    const notices = switchNotices(transition, activeAttachment.binding)
    try {
      api.sendMessage(
        { customType: 'dev/workspace', content: notices.user, display: true },
        { triggerTurn: false }
      )
      api.sendMessage(
        { customType: 'dev/workspace-handoff', content: notices.model, display: true },
        { triggerTurn: true, deliverAs: 'followUp' }
      )
    } catch (error) {
      process.stderr.write(
        `Workspace switch completed, but fresh re-evaluation was not queued: ${errorText(error)}. ${notices.unqueued}\n`
      )
    }
  }

  const withdrawOrReport = (source: WorkspaceAttachment, handoff: WorkspaceHandoff) =>
    withdraw(source, handoff).pipe(
      Effect.catch(error =>
        Effect.sync(() =>
          notify(
            currentContext,
            `Workspace handoff could not be withdrawn; the conversation stays parked in the authority. ${error.message}`,
            'error'
          )
        )
      )
    )

  const runHostHandoff = Effect.fnUntraced(function* (transition: PendingTransition) {
    if (transition.transitionSource !== activeAttachment) {
      pending = undefined
      parked = false
      return yield* withdrawOrReport(transition.transitionSource, transition.handoff)
    }
    const performed = yield* Effect.exit(
      Effect.gen(function* () {
        capturePendingInput(transition.surface)
        yield* assertSessionIdle
        yield* shell.stop
        if (pending !== transition || quitting) return
        const identity = yield* currentSessionIdentity
        pendingReopen = {
          ...identity,
          minimumEntries: runtime?.session.sessionManager.getEntries().length ?? 0,
        }
        let callbackResult: 'confirmed' | 'cancelled' | undefined
        transition.stage = 'handoff-sent'
        yield* transition.transitionSource.handoff(transition.handoff, target =>
          replaceSession(transition, identity, target, outcome => {
            callbackResult = outcome
          })
        )
        pendingReopen = undefined
        if (callbackResult === 'cancelled') {
          pending = undefined
          parked = false
          if (quitting) return
          restoreInput(transition.surface)
          notify(
            transition.surface,
            'Workspace switch was cancelled; the current binding was preserved.',
            'info'
          )
          return
        }
        if (callbackResult !== 'confirmed')
          return yield* hostFailure(
            'Workspace authority returned without a confirmed replacement result'
          )
        if (transition.transitionSource !== activeAttachment)
          yield* closeAttachmentOnce(transition.transitionSource)
        pending = undefined
        parked = false
        queueReevaluation(transition)
      })
    )
    if (Exit.isSuccess(performed)) return
    const error = Cause.squash(performed.cause)
    if (reached(transition, 'switch-started')) {
      process.stderr.write(
        `Workspace handoff is unresolved; this session remains parked. ${errorText(error)}\n`
      )
      return
    }

    const alreadyWithdrawn = isWithdrawn(error) ? Effect.void : Effect.fail(error)
    const withdrawn = yield* Effect.exit(
      reached(transition, 'handoff-sent')
        ? alreadyWithdrawn
        : withdraw(transition.transitionSource, transition.handoff)
    )
    if (Exit.isFailure(withdrawn)) {
      process.stderr.write(
        `Workspace handoff could not be withdrawn; this session remains parked. ${errorText(Cause.squash(withdrawn.cause))}\n`
      )
      return
    }
    pendingReopen = undefined
    pending = undefined
    parked = false
    restoreInput(transition.surface)
    notify(
      transition.surface,
      `Workspace switch was not performed; the current workspace is kept. ${errorText(error)}`,
      'warning'
    )
  })

  const performPendingHandoff = Effect.fnUntraced(function* (transition: PendingTransition) {
    if (pending !== transition || reached(transition, 'switch-started')) return
    yield* runHostHandoff(transition).pipe(
      Effect.ensuring(Deferred.succeed(transition.settled, undefined))
    )
  })

  const scheduleHandoff = (transition: PendingTransition): void => {
    if (reached(transition, 'scheduled')) return
    transition.stage = 'scheduled'
    runDeferred(performPendingHandoff(transition))
  }

  const makeTransition = (
    handoff: WorkspaceHandoff,
    origin: PendingTransition['origin'],
    context: ExtensionContext,
    stage: PendingTransition['stage']
  ): PendingTransition => ({
    handoff,
    origin,
    surface: surfaceOf(context),
    settled: Deferred.makeUnsafe<void>(),
    transitionSource: activeAttachment,
    stage,
    capturedInput: false,
  })

  const requestHandoff = (
    handoff: WorkspaceHandoff,
    origin: PendingTransition['origin'],
    context: ExtensionContext,
    immediate: boolean,
    source: WorkspaceAttachment = activeAttachment
  ): void => {
    if (pending || parked || replacing || source !== activeAttachment) {
      withdrawals.set(source, runDeferred(withdrawOrReport(source, handoff)))
      return
    }
    parked = 'switch'
    const transition = makeTransition(handoff, origin, context, 'requested')
    pending = transition
    if (immediate) scheduleHandoff(transition)
  }

  const authorization = Effect.fnUntraced(
    function* (
      context: ExtensionContext,
      access: WorkspaceGrant['access'],
      cwd: string,
      origin: 'tool-call' | 'user-bash' = 'tool-call'
    ): Effect.fn.Return<Admission, WorkspaceError> {
      if (parked)
        return {
          kind: 'refused',
          reason: 'Workspace host is parked during a transition; no operation started.',
        }
      const result = yield* activeAttachment.authorize({ kind: access, cwd })
      if (result.kind === 'rebind') {
        requestHandoff(result.handoff, origin, context, origin === 'user-bash')
        return {
          kind: 'refused',
          reason: `Workspace admission requires a host rebind: ${result.handoff.reason}. The operation was not executed.`,
        }
      }
      return {
        kind: 'admitted',
        grant: result.grant,
        ...(result.warning ? { warning: result.warning } : {}),
      }
    },
    Effect.catchCause(cause =>
      Effect.succeed<Admission>({
        kind: 'refused',
        reason: `Workspace admission failed closed: ${errorText(Cause.squash(cause))}`,
      })
    )
  )

  const validateNativeGrant = (
    grant: WorkspaceGrant,
    context: ExtensionContext,
    access: WorkspaceGrant['access']
  ): string | undefined => {
    const { binding } = activeAttachment
    if (grant.access !== access) {
      return `Workspace authority returned ${grant.access} access for a ${access} operation; the Pi tool was not executed.`
    }
    if (grant.workspaceId !== binding.workspaceId || resolve(grant.cwd) !== resolve(context.cwd)) {
      return `Workspace authority returned ${grant.workspaceId} at ${grant.cwd}, but Pi is still bound to ${binding.workspaceId} at ${context.cwd}; the native tool was not executed.`
    }
    return undefined
  }

  const admitWriter = (context: ExtensionContext) =>
    Effect.map(authorization(context, 'write', context.cwd), (admitted): WriterAdmission => {
      if (admitted.kind === 'refused')
        return {
          kind: 'refused',
          refusal: { block: true, terminate: true, reason: admitted.reason },
        }
      const mismatch = validateNativeGrant(admitted.grant, context, 'write')
      if (mismatch) {
        parked = 'switch'
        return { kind: 'refused', refusal: { block: true, terminate: true, reason: mismatch } }
      }
      return { kind: 'admitted', grant: admitted.grant }
    })

  const admitRead = (toolCallId: string, context: ExtensionContext) =>
    Effect.map(
      authorization(context, 'read', context.cwd),
      (admitted): ToolCallEventResult | undefined => {
        if (admitted.kind === 'refused')
          return { block: true, terminate: true, reason: admitted.reason }
        const mismatch = validateNativeGrant(admitted.grant, context, 'read')
        if (mismatch) {
          parked = 'switch'
          return { block: true, terminate: true, reason: mismatch }
        }
        if (admitted.warning === undefined) writerWarned = false
        else {
          readerWarnings.set(toolCallId, admitted.warning)
          if (!writerWarned) notify(context, admitted.warning, 'warning')
          writerWarned = true
        }
        return undefined
      }
    )

  const admitNativeWrite = Effect.fnUntraced(
    function* (event: HostToolCallEvent, context: ExtensionContext) {
      const attachment = activeAttachment
      const { binding } = attachment
      const checkout = yield* repositoryRoot.resolve(binding.cwd)
      if (checkout === undefined) return yield* hostFailure('Cannot identify the current checkout')
      const scope = { checkout, authorityRoot: authority.root }
      const path = yield* Effect.try({
        try: () => decodeWriteOperand(event.input),
        catch: cause => hostFailure(errorText(cause)),
      })
      const destination = yield* Effect.try({
        try: () => classifyWriteDestination(scope, context.cwd, path),
        catch: cause => hostFailure(errorText(cause)),
      })
      const validate = Effect.suspend(() =>
        !closed &&
        !quitting &&
        !replacing &&
        !parked &&
        !detachedAttachments.has(attachment) &&
        activeAttachment === attachment &&
        attachment.binding.revision === binding.revision &&
        resolve(context.cwd) === resolve(binding.cwd)
          ? Effect.void
          : Effect.fail(
              new WorkspaceError({
                outcome: 'blocked',
                message: 'Native write belongs to a stale or parked workspace host',
              })
            )
      )
      yield* validate
      if (destination.kind === 'external') {
        yield* nativeWrites.admit({
          toolCallId: event.toolCallId,
          scope,
          destination,
          lifecycle: { kind: 'local', validate },
        })
        return undefined
      }
      const writer = yield* admitWriter(context)
      if (writer.kind === 'refused') return writer.refusal
      const operation = yield* attachment.authorize({
        kind: 'native-file-write',
        within: writer.grant,
        path,
        cwd: context.cwd,
      })
      if (operation.kind !== 'ready')
        return yield* hostFailure('the workspace changed before the native write was admitted')
      yield* nativeWrites
        .admit({
          toolCallId: event.toolCallId,
          scope,
          destination,
          lifecycle: { kind: 'workspace', attachment, grant: operation.grant },
        })
        .pipe(
          Effect.tapError(() =>
            attachment
              .reportExecution(operation.grant, { kind: 'operation-completed' })
              .pipe(
                Effect.catch(settleError =>
                  Effect.sync(() =>
                    notify(
                      context,
                      `Refused native ${event.toolName} could not be settled: ${settleError.message}`,
                      'error'
                    )
                  )
                )
              )
          )
        )
      return undefined
    },
    (effect, event) =>
      Effect.catchCause(effect, cause =>
        Effect.succeed<ToolCallEventResult | undefined>({
          block: true,
          reason: `Native ${event.toolName} was not executed: ${errorText(Cause.squash(cause))}`,
        })
      )
  )

  const safeToolCall = (
    api: ExtensionAPI,
    event: HostToolCallEvent,
    context: ExtensionContext
  ): Effect.Effect<ToolCallEventResult | void> => {
    if (parked)
      return Effect.succeed({
        block: true,
        terminate: true,
        reason: 'Workspace host is parked; stale tools are blocked.',
      })
    const effect = toolEffect(getToolInfo(api, event.toolName))
    switch (effect) {
      case undefined:
        return Effect.succeed({
          block: true,
          reason: `Tool ${event.toolName} has no verified workspace effect in dev, so it was not executed. A supported extension must have its project effects reviewed and recorded first (ADR 0005).`,
        })
      case 'work-owner':
        return Effect.void
      case 'read':
      case 'workspace-tool':
        return admitRead(event.toolCallId, context)
      case 'workspace-shell':
        return Effect.map(admitWriter(context), writer =>
          writer.kind === 'refused' ? writer.refusal : undefined
        )
      case 'native-write':
        return admitNativeWrite(event, context)
      default: {
        const exhaustive: never = effect
        return exhaustive
      }
    }
  }

  const attachForManager = Effect.fnUntraced(function* (
    manager: SessionManager,
    cwd: string,
    existing?: WorkspaceAttachment
  ) {
    const conversation = yield* workspaceConversation(manager, options.dataHome)
    const attachment = existing ?? (yield* authority.attach({ conversation, cwd }))
    if (attachment !== activeAttachment) preparedAttachments.add(attachment)
    followSweeps(attachment)
    const effectiveCwd = attachment.binding.cwd
    let reopened = manager
    if (
      resolve(effectiveCwd) !== resolve(cwd) ||
      resolve(manager.getCwd()) !== resolve(effectiveCwd)
    )
      reopened = options.openSessionManager(conversation.sessionFile, effectiveCwd)
    if (!sameConversation(identityOf(reopened), conversation))
      return yield* hostFailure('Reopened Pi SessionManager changed conversation identity')
    return { attachment, manager: reopened, cwd: effectiveCwd }
  })

  const prepareRuntime = Effect.fnUntraced(function* (input: {
    readonly sessionManager: SessionManager
    readonly cwd: string
  }): Effect.fn.Return<RuntimeWorkspace, WorkspaceHostError | WorkspaceError> {
    runtimePreparationSerial += 1
    const identity = identityOf(input.sessionManager)
    const file = identity.sessionFile
    if (!file)
      return yield* hostFailure('Workspace-bound runtime requires a persisted Pi session file')
    let manager = input.sessionManager
    const key = sessionKey(file, identity.sessionId)
    const parent = manager.getHeader()?.parentSession
    const forkOfActive =
      parent !== undefined && conversationFile(parent) === activeConversation.sessionFile
    const reopenTarget = pendingReopen
    const reopen = reopenTarget !== undefined && sameConversation(reopenTarget, identity)
    if (reopen) {
      manager = options.openSessionManager(file, input.cwd)
      if (
        !sameConversation(identityOf(manager), identity) ||
        manager.getEntries().length < reopenTarget.minimumEntries
      )
        return yield* hostFailure(
          'Same-file workspace rebind did not reopen the settled outgoing Pi session'
        )
    }
    const staged = stagedAttachments.get(key)
    const canReuse = !reopen && !staged && isBoundTo(activeConversation, identity)

    const resolved = yield* attachForManager(
      manager,
      forkOfActive ? activeAttachment.binding.cwd : input.cwd,
      staged ?? (canReuse ? activeAttachment : undefined)
    )
    if (staged) stagedAttachments.delete(key)
    if (!canReuse && activeConversation.sessionId !== identity.sessionId) parked ||= 'switch'
    return {
      attachment: resolved.attachment,
      sessionManager: resolved.manager,
      cwd: resolved.cwd,
    }
  })

  const commitRuntime = Effect.fnUntraced(function* (attachment: WorkspaceAttachment) {
    const previous = activeAttachment
    const nextIdentity = attachment.binding.conversation
    preparedAttachments.delete(attachment)
    const continuing =
      activeConversation.sessionId === nextIdentity.sessionId &&
      activeConversation.sessionFile === nextIdentity.sessionFile
    activeAttachment = attachment
    activeConversation = nextIdentity
    activeManager = runtime?.session.sessionManager
    if (previous !== attachment && !continuing) yield* closeAttachmentOnce(previous)
    if (!pending && parked === 'switch') {
      const expectedId = nextIdentity.sessionId
      runDeferred(
        Effect.sync(() => {
          if (
            !pending &&
            parked === 'switch' &&
            activeConversation.sessionId === expectedId &&
            runtime?.session.sessionManager.getSessionId() === expectedId
          )
            parked = false
        })
      )
    }
  })

  const refusedWhileSwitching = Effect.sync(() => {
    if (pending === undefined) return false
    notify(
      currentContext,
      reached(pending, 'switch-started') ? unresolvedSwitchNotice : pendingSwitchNotice,
      'warning'
    )
    return true
  })
  const interceptQuit = Effect.fnUntraced(function* (rawDispose: () => Promise<void>) {
    yield* Effect.yieldNow
    if (quitInterception !== 'armed') return yield* piCall(rawDispose)
    quitInterception = 'handed-over'
    yield* Deferred.succeed(quitRequested, undefined)
    return yield* Effect.never
  })

  const guardedReplacement = Effect.fnUntraced(function* <A, E>(
    cancelled: A,
    replace: Effect.Effect<A, E>
  ): Effect.fn.Return<A, E> {
    if (yield* refusedWhileSwitching) return cancelled
    replacing = true
    return yield* Effect.ensuring(
      replace,
      Effect.sync(() => {
        replacing = false
      })
    )
  })
  const importConversation = Effect.fnUntraced(function* (
    rawSwitch: AgentSessionRuntime['switchSession'],
    rawImport: AgentSessionRuntime['importFromJsonl'],
    inputPath: string,
    cwdOverride: string | undefined
  ) {
    const source = options.resolveImportPath(inputPath)
    const sessionDir = runtime?.session.sessionManager.getSessionDir()

    const stored =
      sessionDir !== undefined &&
      resolve(sessionDir, basename(source)) === source &&
      (yield* Effect.sync(() => existsSync(source)))
    if (stored) return yield* switchSession(rawSwitch, source, undefined)
    return yield* guardedReplacement(
      { cancelled: true },
      Effect.gen(function* () {
        const refusal = yield* importOutsideCheckout(source, cwdOverride)
        if (refusal === undefined) return yield* piCall(() => rawImport(inputPath, cwdOverride))
        notify(currentContext, refusal, 'warning')
        return { cancelled: true }
      })
    )
  })

  const switchSession = Effect.fnUntraced(function* (
    rawSwitch: AgentSessionRuntime['switchSession'],
    sessionFile: string,
    switchOptions: Parameters<AgentSessionRuntime['switchSession']>[1]
  ) {
    if (invokingHandoffSwitch) return yield* fromPi(() => rawSwitch(sessionFile, switchOptions))
    if (yield* refusedWhileSwitching) return { cancelled: true }
    replacing = true
    const previousSerial = runtimePreparationSerial
    let staged: WorkspaceAttachment | undefined
    let stagedKey: string | undefined
    let target: ConversationIdentity | undefined
    let replacementStarted = false
    const clearReopen = () => {
      if (
        target !== undefined &&
        pendingReopen !== undefined &&
        sameConversation(pendingReopen, target)
      )
        pendingReopen = undefined
    }
    return yield* Effect.gen(function* () {
      const targetManager = options.openSessionManager(sessionFile)
      const trustSnapshot = trustContextFor(currentContext, targetManager.getCwd())
      const file = targetManager.getSessionFile()
      if (!file) return yield* fromPi(() => rawSwitch(sessionFile, switchOptions))
      const id = targetManager.getSessionId()
      target = { sessionId: id, sessionFile: file }
      stagedKey = sessionKey(file, id)
      if (isBoundTo(activeConversation, target)) {
        notify(
          currentContext,
          'This Pi conversation is already active; its workspace binding is unchanged.'
        )
        return { cancelled: true }
      }
      if (activeConversation.sessionFile === conversationFile(file))
        pendingReopen = {
          sessionFile: file,
          sessionId: id,
          minimumEntries: targetManager.getEntries().length,
        }

      const attached = yield* Effect.exit(
        workspaceConversation(targetManager, options.dataHome).pipe(
          Effect.flatMap(conversation =>
            authority.attach({ conversation, cwd: targetManager.getCwd() })
          )
        )
      )
      if (Exit.isFailure(attached)) {
        clearReopen()
        notify(
          currentContext,
          `The session was not switched: ${errorText(Cause.squash(attached.cause))}\n${keptConversationGuidance(file)}`,
          'warning'
        )
        return { cancelled: true }
      }
      const prepared = attached.value
      staged = prepared
      stagedAttachments.set(stagedKey, prepared)
      parked = 'switch'
      replacementStarted = true
      const result = yield* fromPi(() =>
        rawSwitch(sessionFile, {
          ...switchOptions,
          cwdOverride: prepared.binding.cwd,
          projectTrustContextFactory:
            switchOptions?.projectTrustContextFactory ?? (cwd => ({ ...trustSnapshot, cwd })),
        })
      )
      if (result.cancelled) {
        if (runtimePreparationSerial === previousSerial && staged) {
          stagedAttachments.delete(stagedKey)
          yield* closeAttachmentOnce(staged)
          parked = false
          clearReopen()
        } else {
          parked = 'switch'
        }
      } else if (!pending) {
        parked = false
        clearReopen()
      }
      return result
    }).pipe(
      Effect.tapError(() =>
        Effect.gen(function* () {
          if (replacementStarted) {
            parked = 'switch'
          } else if (runtimePreparationSerial === previousSerial && staged && stagedKey) {
            stagedAttachments.delete(stagedKey)
            yield* Effect.ignore(closeAttachmentOnce(staged))
            parked = false
            clearReopen()
          } else if (runtimePreparationSerial === previousSerial) {
            parked = false
            clearReopen()
          } else {
            parked = 'switch'
          }
        })
      ),
      Effect.ensuring(
        Effect.sync(() => {
          replacing = false
        })
      )
    )
  })

  const close = Effect.gen(function* () {
    if (closed) return
    closed = true
    if (reached(pending, 'switch-started')) return
    yield* nativeWrites.settle
    yield* shell.stop
    for (const attachment of stagedAttachments.values()) yield* closeAttachmentOnce(attachment)
    stagedAttachments.clear()
    for (const attachment of preparedAttachments) yield* closeAttachmentOnce(attachment)
    preparedAttachments.clear()
    yield* closeAttachmentOnce(activeAttachment)
  })

  const sessionShutdown = Effect.fnUntraced(function* (reason: string) {
    if (reason === 'quit') quitting = true
    yield* nativeWrites.settle
    if (reason !== 'reload') yield* shell.stop
    if (reason !== 'quit') return
    if (reached(pending, 'switch-started')) return

    const inFlight = pending
    if (inFlight !== undefined && reached(inFlight, 'handoff-sent')) {
      yield* Deferred.await(inFlight.settled)
      if (pending === inFlight) return
    }
    if (pending) {
      const withdrawn = yield* Effect.exit(withdraw(pending.transitionSource, pending.handoff))
      if (Exit.isFailure(withdrawn)) {
        parked = 'switch'
        notify(
          currentContext,
          `Pending workspace handoff could not be cancelled safely. ${errorText(Cause.squash(withdrawn.cause))}`,
          'error'
        )
        return
      }
      pending = undefined
      parked = false
    }
    yield* closeAttachmentOnce(activeAttachment)
  })

  const releaseInTui = Effect.fnUntraced(function* (
    api: ExtensionAPI,
    command: ReleaseCommand,
    context: ExtensionCommandContext
  ) {
    if (parked || pending) {
      notify(
        context,
        'Workspace host is parked or a transition is unresolved; no release was started.',
        'error'
      )
      return
    }
    const { binding } = activeAttachment
    if (binding.taskId === command.taskId) {
      display(
        api,
        context,
        `Task ${command.taskId} belongs to this conversation. Quitting dev (/quit) ends its uses and then sweeps the repository: finished workspaces are released automatically and the others stay retained with their reason. Use /workspace check ${command.taskId} to see what the sweep will do.`
      )
      return
    }
    if (!context.hasUI) {
      notify(
        context,
        'Workspace release needs an interactive confirmation; none is available here, so nothing was released.',
        'error'
      )
      return
    }
    const checked = yield* Effect.exit(
      authority.check({
        taskId: command.taskId,
        ownConversation: binding.conversation,
      })
    )
    if (Exit.isFailure(checked)) {
      notify(
        context,
        `Workspace assessment failed; nothing was released: ${errorText(Cause.squash(checked.cause))}`,
        'error'
      )
      return
    }
    const assessments = checked.value
    const containing = assessments.find(
      assessment =>
        assessment.origin === 'managed' &&
        (isWithin(assessment.path, binding.conversation.sessionFile) ||
          assessment.workspaceId === binding.workspaceId)
    )
    if (containing !== undefined) {
      notify(
        context,
        `This conversation is inside or bound to managed worktree ${containing.workspaceId} of task ${command.taskId}; quitting sweeps it once it is finished. No release was started; work and the TUI stay active.`,
        'error'
      )
      return
    }
    display(api, context, formatAssessments(command.taskId, assessments))
    if (assessments.length === 0) return
    if (!needsExplicitRelease(assessments)) {
      display(api, context, noExplicitRelease(command.taskId))
      return
    }
    const confirmation = releaseConfirmation(command.taskId, assessments)
    const confirmed = yield* Effect.promise(() =>
      context.ui.confirm(confirmation.title, confirmation.message)
    )
    if (!confirmed) {
      notify(context, 'Release cancelled before confirmation; nothing was changed.', 'info')
      return
    }
    const run = yield* runRelease(authority, {
      taskId: command.taskId,
      confirmed: assessments,
      occupiedPaths: [resolve(process.cwd()), resolve(context.cwd)],
      commandId: newId(),
    })
    display(api, context, formatReleaseRun(command.taskId, run))
  })

  const workspaceCommand = Effect.fnUntraced(
    function* (api: ExtensionAPI, args: string, context: ExtensionCommandContext) {
      const command = yield* parseWorkspaceCommand(args.trim() ? args.trim().split(/\s+/) : [])
      if (command.kind === 'release') return yield* releaseInTui(api, command, context)
      const result = yield* runReadOnlyWorkspaceCommand(Effect.succeed(authority), command, {
        repositoryRoot: repositoryRoot.resolve(context.cwd),
        current: {
          workspaceId: activeAttachment.binding.workspaceId,
          effectiveCwd: context.cwd,
          conversation: activeAttachment.binding.conversation,
        },
      })
      display(api, context, result.text)
    },
    (effect, api, _args, context) =>
      effect.pipe(
        Effect.catchTag('WorkspaceCommandError', error =>
          Effect.sync(() => display(api, context, error.message))
        )
      )
  )

  return {
    get attachment() {
      return activeAttachment
    },
    shellOperations: shell.operations,
    writeOperations: nativeWrites.writeOperations,
    editOperations: nativeWrites.editOperations,
    quitRequested,
    interceptQuit(enabled) {
      if (quitInterception !== 'handed-over') quitInterception = enabled ? 'armed' : 'off'
    },
    isParked: () => parked !== false,
    isDetached: () => detachedAttachments.has(activeAttachment),
    requestRebind: (handoff, source, context) =>
      requestHandoff(handoff, 'tool-call', context, false, source),
    prepareRuntime,
    commitRuntime,
    bindRuntime(nextRuntime) {
      runtime = nextRuntime
      activeManager = nextRuntime.session.sessionManager
      const rawSwitch = nextRuntime.switchSession.bind(nextRuntime)
      nextRuntime.switchSession = (sessionFile, switchOptions) =>
        runPromise(switchSession(rawSwitch, sessionFile, switchOptions))
      const rawDispose = nextRuntime.dispose.bind(nextRuntime)
      nextRuntime.dispose = () => {
        quitting = true
        return quitInterception === 'armed' ? runPromise(interceptQuit(rawDispose)) : rawDispose()
      }
      const rawNew = nextRuntime.newSession.bind(nextRuntime)
      nextRuntime.newSession = newOptions =>
        runPromise(
          guardedReplacement(
            { cancelled: true },
            piCall(() => rawNew(newOptions))
          )
        )
      const rawFork = nextRuntime.fork.bind(nextRuntime)
      nextRuntime.fork = (entryId, forkOptions) =>
        runPromise(
          guardedReplacement(
            { cancelled: true },
            piCall(() => rawFork(entryId, forkOptions))
          )
        )
      const rawImport = nextRuntime.importFromJsonl.bind(nextRuntime)
      nextRuntime.importFromJsonl = (inputPath, cwdOverride) =>
        runPromise(importConversation(rawSwitch, rawImport, inputPath, cwdOverride))
    },
    close,
    extensionFactory(api) {
      currentApi = api
      api.on('session_start', (_event, context) => {
        currentContext = context
        if (
          activeAttachment.binding.conversation.sessionId === context.sessionManager.getSessionId()
        ) {
          activeManager = context.sessionManager as SessionManager
        }
      })

      api.on('tool_call', (event, context) => runPromise(safeToolCall(api, event, context)))

      api.on('tool_execution_end', event =>
        runPromise(
          nativeWrites.finish(event.toolCallId).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                readerWarnings.delete(event.toolCallId)
              })
            )
          )
        )
      )

      api.on('tool_result', event => {
        const warning = readerWarnings.get(event.toolCallId)
        if (warning === undefined) return
        readerWarnings.delete(event.toolCallId)
        return {
          content: [...event.content, { type: 'text', text: `[dev workspace] ${warning}` }],
        }
      })

      api.on('user_bash', (event, context) =>
        runPromise(
          Effect.map(authorization(context, 'write', event.cwd, 'user-bash'), admitted =>
            admitted.kind === 'admitted'
              ? { operations: shell.operations }
              : {
                  result: {
                    output: admitted.reason,
                    exitCode: 1,
                    cancelled: false,
                    truncated: false,
                  },
                }
          )
        )
      )

      api.on('turn_end', (_event, context) => {
        if (!pending || pending.origin === 'user-bash') return
        capturePendingInput(context)
        scheduleHandoff(pending)
      })

      api.on('agent_before_settle', event => {
        if (!parked) return
        return { entries: event.entries, continue: false }
      })

      api.on('input', (event, _context) => {
        if (!parked || event.source === 'extension') return
        const command = event.text.trim()
        if (
          command === '/workspace' ||
          command === '/workspace list' ||
          command.startsWith('/workspace inspect ') ||
          command.startsWith('/workspace check ')
        )
          return
        if (command === '/quit' || command === '/exit') return
        preservedInput.push(event.text)
        return { action: 'handled' }
      })

      api.on('session_shutdown', event => runPromise(sessionShutdown(event.reason)))

      api.registerCommand('workspace', {
        description: 'List, inspect, check, release, or resume an exact workspace task',
        handler: (args, context) => runPromise(workspaceCommand(api, args, context)),
      })
      api.registerTool(
        makeWorkspaceTool({
          lifecycle: authority,
          attachment: () => activeAttachment,
          runPromise,
          requestResume: (handoff, context) =>
            requestHandoff(handoff, 'tool-resume', context, false),
        })
      )
    },
  }
})
