import * as Cause from 'effect/Cause'
import * as Clock from 'effect/Clock'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as FiberSet from 'effect/FiberSet'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import type * as Scope from 'effect/Scope'
import * as Semaphore from 'effect/Semaphore'
import * as Stream from 'effect/Stream'
import type * as ChildProcessSpawner from 'effect/process/ChildProcessSpawner'
import {
  closeSync,
  lstatSync,
  existsSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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
import { verbCompletions } from './command-completions.ts'
import { errorText } from './error-text.ts'
import {
  exactId,
  WorkspaceCommandError,
  formatSweepReceipt,
  isReleaseCommand,
  joinedTaskNote,
  joinedTaskNotice,
  notResumableText,
  parseWorkspaceCommand,
  pausedTaskQuestion,
  resumableRowText,
  resumableWorkspaces,
  releaseRedirect,
  runReadOnlyWorkspaceCommand,
  type ResumeCandidate,
  type WorkspaceCommandResult,
  type WorkspaceReport,
} from './workspace-command.ts'
import {
  HANDOFF_MESSAGE,
  blockedAccess,
  blockedByMismatch,
  type BlockedConversation,
  joinDetails,
  type JoinDetails,
  notDoneWhileBlocked,
  RECEIPT_ENTRY,
  REFUSAL_ENTRY,
  reportText,
  sweepText,
  WORKSPACE_MESSAGE,
  type RefusalDetails,
  type SweepDetails,
  type SwitchDetails,
  SWITCH_REQUESTED,
  switchNotRequested,
  type SwitchRequest,
} from './workspace-model-text.ts'
import {
  scopedGrantOf,
  WorkspaceError,
  type WorkspaceId,
  type PausedTask,
  type ScopedContinuation,
  type ScopedOutcome,
  type SweepReceipt,
  type WorkspaceAttachment,
  type WorkspaceBinding,
  type BoundConversation,
  type WorkspaceConversation,
  type WorkspaceGrant,
  type WorkspaceAuthorization,
  type WorkspaceHandoff,
  type WorkspaceLifecycle,
  type WriteOperation,
} from './workspace-domain.ts'
import { makeWorkspaceTool, type PublicationDestinations } from './workspace-tool.ts'
import { RepositoryRoot } from './preferences.ts'
import { makeNativeWrites } from './workspace-native-write.ts'
import {
  canonicalConversationFile,
  classifyWriteDestination,
  decodeWriteOperand,
  isWithin,
} from './workspace-paths.ts'
import { hasErrorCode } from './workspace-platform.ts'
import { makeWorkspaceShell } from './workspace-shell.ts'
import { isIntegratedCodemode, isIntegratedReader } from './integrated-tools.ts'

export class WorkspaceHostError extends Schema.TaggedError<
  WorkspaceHostError,
  { readonly brand: unique symbol }
>()('WorkspaceHostError', { message: Schema.String }) {}

export interface WorkspaceHostOptions {
  readonly lifecycle: WorkspaceLifecycle
  readonly attachment: WorkspaceAttachment
  readonly dataHome: string
  readonly openSessionManager: (sessionFile: string, cwdOverride?: string) => SessionManager
  readonly resolveImportPath: (input: string) => string
  readonly onParkingChange?: () => void
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
  isParked(): boolean
  blockedAccess(didNotRun: string): string

  isDetached(): boolean
  requestHandoff(
    handoff: WorkspaceHandoff,
    source: WorkspaceAttachment,
    context: ExtensionContext
  ): SwitchRequest
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

type TransitionOrigin = 'tool-call' | 'tool-resume' | 'user-bash' | 'user-resume'
const startsWithoutTurn = (origin: TransitionOrigin): boolean =>
  origin === 'user-bash' || origin === 'user-resume'

interface PendingTransition {
  readonly handoff: WorkspaceHandoff
  readonly origin: TransitionOrigin
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

interface RefusedAdmission {
  readonly kind: 'refused'
  readonly reason: string
  readonly endsTurn: boolean
}
type Admission =
  | {
      readonly kind: 'admitted'
      readonly attachment: WorkspaceAttachment
      readonly grant: WorkspaceGrant
      readonly warning?: string
      readonly scoped?: ScopedOutcome
    }
  | RefusedAdmission

type Hold = 'mismatch' | 'unresolved'

interface Replacement {
  blocking: boolean
}

type ChangeOutcome = 'confirmed' | 'cancelled' | 'unconfirmed'

const changeOutcome = (changed: boolean, unchanged: boolean): ChangeOutcome => {
  if (changed) return 'confirmed'
  return unchanged ? 'cancelled' : 'unconfirmed'
}

const dismissedQuestionRefusal: RefusedAdmission = {
  kind: 'refused',
  endsTurn: true,
  reason:
    'The question about the paused task in this checkout was dismissed, so the operation was not executed and nothing changed. The next write asks again.',
}

const settleRefusedWrite = (
  attachment: WorkspaceAttachment,
  grant: WorkspaceGrant,
  context: ExtensionContext,
  toolName: string
): Effect.Effect<void> =>
  attachment.reportExecution(grant, { kind: 'operation-completed' }).pipe(
    Effect.asVoid,
    Effect.catch(settleError =>
      Effect.sync(() =>
        notify(
          context,
          `Dev could not close the refused ${toolName} call: ${settleError.message}`,
          'error'
        )
      )
    )
  )

const endRun = (context: ExtensionContext, purpose: string): void => {
  try {
    context.abort()
  } catch (error) {
    notify(
      context,
      `The turn could not be ended for ${purpose}, so Pi may spend one more request: ${errorText(error)}`,
      'warning'
    )
  }
}

const refusalOf = (refused: RefusedAdmission): ToolCallEventResult => ({
  block: true,
  ...(refused.endsTurn ? { terminate: true } : {}),
  reason: refused.reason,
})

type WriterAdmission =
  | {
      readonly kind: 'admitted'
      readonly attachment: WorkspaceAttachment
      readonly grant: WorkspaceGrant
      readonly scoped: WorkspaceGrant | WorkspaceError | undefined
    }
  | { readonly kind: 'refused'; readonly refusal: ToolCallEventResult }

interface ConversationIdentity {
  readonly sessionId: string
  readonly sessionFile: string | undefined
}

const hostFailure = (message: string) => new WorkspaceHostError({ message })
const WRITE_ADMISSION_CHANGED = 'the checkout changed before the write'
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
const NO_SESSION_FILE = 'Dev needs a saved Pi session file for this conversation'
const SESSION_NOT_REPLACED = 'the session was not replaced'
const CONVERSATION_NOT_SWITCHED = 'the conversation was not switched'
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

const display = (
  api: ExtensionAPI,
  context: ExtensionContext,
  {
    text,
    report,
    join,
  }: Pick<WorkspaceCommandResult, 'text' | 'report'> & { readonly join?: JoinDetails }
): void => {
  if (context.hasUI) {
    const details: WorkspaceReport | JoinDetails | undefined = report ?? join
    api.sendMessage(
      {
        customType: WORKSPACE_MESSAGE,
        content: report === undefined ? text : reportText(report),
        display: true,
        ...(details === undefined ? {} : { details }),
      },
      { triggerTurn: false }
    )
  } else {
    process.stderr.write(`${text}\n`)
  }
}

const cancelledSiblingsNotice =
  'Other calls of that batch reporting "Operation aborted" or "No result provided" were cancelled before running and may be issued again if still needed.'

const SUBMIT_NEW_PROMPT = 'Submit a new prompt.'

const switchNotices = (
  { origin, handoff }: PendingTransition,
  binding: WorkspaceBinding
): { readonly details: SwitchDetails; readonly model: string; readonly unqueued: string } => {
  const current = `Current checkout: ${handoff.target.cwd}.`
  const details: SwitchDetails = {
    kind: 'switch',
    resumed: origin === 'tool-resume' || origin === 'user-resume',
    workspaceId: binding.workspaceId,
    cwd: binding.cwd,
    reason: handoff.reason,
  }
  if (origin === 'user-resume')
    return {
      details,
      model: `The user chose /workspace resume. ${handoff.reason}. ${current}`,
      unqueued: SUBMIT_NEW_PROMPT,
    }
  return origin === 'tool-resume'
    ? {
        details,
        model: `Dev switched checkouts and ended the requesting turn. ${handoff.reason}. ${current} ${cancelledSiblingsNotice}`,
        unqueued: SUBMIT_NEW_PROMPT,
      }
    : {
        details,
        model: `Dev switched checkouts and ended that turn. ${handoff.reason}. ${current} The blocked call did not run. Check this checkout before deciding whether to retry. ${cancelledSiblingsNotice}`,
        unqueued: 'The blocked request was not replayed; submit a new prompt.',
      }
}

const alreadyWorksFor = (taskId: WorkspaceId, binding: WorkspaceBinding): string =>
  `This conversation already works for task ${taskId} in ${binding.cwd}.`

const handoffTurnEndNotice = (handoff: WorkspaceHandoff): string =>
  `Ending the turn to switch checkouts: ${handoff.reason}.`

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

type ToolEffect =
  | 'read'
  | 'native-write'
  | 'workspace-shell'
  | 'work-owner'
  | 'workspace-tool'
  | 'web-read'
  | 'codemode'

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
  if (isIntegratedReader(tool)) return 'web-read'
  if (isIntegratedCodemode(tool)) return 'codemode'
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
    if (!sessionFile) return Effect.fail(hostFailure(NO_SESSION_FILE))
    return Effect.succeed({ sessionId: manager.getSessionId(), sessionFile, dataHome })
  })

const replacementSweepFailure = (reason: string): SweepReceipt => ({
  moment: 'replacement',
  rows: [{ kind: 'sweep-failure', reason }],
})

const withdraw = (source: WorkspaceAttachment, handoff: WorkspaceHandoff) =>
  source
    .handoff(handoff, () => Effect.succeed('cancelled' as const))
    .pipe(Effect.catchIf(isWithdrawn, () => Effect.void))
type UnwrittenConversation = Pick<SessionManager, 'getHeader' | 'getEntries' | 'getSessionId'>

const writeUnwrittenConversation = (
  outgoing: UnwrittenConversation,
  sessionFile: string,
  reopen: (sessionFile: string) => Pick<SessionManager, 'getSessionId'>
): void => {
  if (existsSync(sessionFile)) return
  const header = outgoing.getHeader()
  if (header === null) throw new Error('Pi holds no session header for the conversation')
  const lines = [header, ...outgoing.getEntries()].map(entry => `${JSON.stringify(entry)}\n`)
  const fd = openSync(sessionFile, 'wx')
  try {
    try {
      writeFileSync(fd, lines.join(''))
    } finally {
      closeSync(fd)
    }
    if (reopen(sessionFile).getSessionId() !== outgoing.getSessionId())
      throw new Error('Pi did not reopen the written file as the same conversation')
  } catch (cause) {
    rmSync(sessionFile, { force: true })
    throw cause
  }
}

export const makeWorkspaceHost = Effect.fnUntraced(function* (
  options: WorkspaceHostOptions
): Effect.fn.Return<
  WorkspaceHost,
  never,
  Scope.Scope | RepositoryRoot | PublicationDestinations | ChildProcessSpawner.ChildProcessSpawner
> {
  const authority = options.lifecycle
  const repositoryRoot = yield* RepositoryRoot
  let activeAttachment = options.attachment
  let activeConversation = activeAttachment.binding.conversation
  let activeManager: SessionManager | undefined
  let runtime: AgentSessionRuntime | undefined
  let currentContext: ExtensionContext | undefined
  let startedSessionId: string | undefined
  let currentApi: ExtensionAPI | undefined

  let closed = false
  let quitting = false
  let pending: PendingTransition | undefined
  let replacement: Replacement | undefined
  let hold: Hold | undefined
  const isBlocked = (): boolean =>
    hold !== undefined || pending !== undefined || replacement?.blocking === true
  const updateAccess = (change: () => void): void => {
    const was = isBlocked()
    change()
    if (isBlocked() !== was) options.onParkingChange?.()
  }
  const holdAccess = (cause: Hold): void =>
    updateAccess(() => {
      hold ??= cause
    })
  const settleHandoff = (transition: PendingTransition, outcome: ChangeOutcome): void =>
    updateAccess(() => {
      if (pending !== transition) return
      if (outcome === 'unconfirmed') hold = 'unresolved'
      else pending = undefined
    })
  const beginReplacement = (): Replacement => {
    const started: Replacement = { blocking: false }
    replacement = started
    return started
  }
  const blockForReplacement = (owner: Replacement): void =>
    updateAccess(() => {
      owner.blocking = true
    })
  const settleReplacement = (owner: Replacement, outcome: ChangeOutcome): void =>
    updateAccess(() => {
      if (replacement !== owner) return
      replacement = undefined
      if (outcome === 'confirmed') hold = undefined
      else if (outcome === 'unconfirmed') hold = 'unresolved'
    })
  const blockCause = (
    source: WorkspaceAttachment
  ): Exclude<BlockedConversation, 'busy'> | undefined => {
    if (closed || quitting) return 'closing'
    if (hold !== undefined) return hold
    if (source !== activeAttachment) return 'changed'
    if (pending !== undefined) return 'switch'
    return replacement === undefined ? undefined : 'replacing'
  }
  const blockedNow = (didNotRun: string, source = activeAttachment): string =>
    blockedAccess(blockCause(source) ?? 'switch', didNotRun)
  const parkedRefusal = (
    origin: 'tool-call' | 'user-bash',
    source = activeAttachment
  ): RefusedAdmission => ({
    kind: 'refused',
    endsTurn: true,
    reason:
      origin === 'user-bash'
        ? notDoneWhileBlocked(blockCause(source) ?? 'switch', 'the command did not run')
        : blockedNow('the call did not run', source),
  })
  let armedRunEnd: PendingTransition | undefined
  let armedReviewEnd: RefusalDetails | undefined
  let armedDismissalEnd = false
  const pausedQuestion = yield* Semaphore.make(1)
  let invokingHandoffSwitch = false
  const withdrawals = new Map<WorkspaceAttachment, Fiber.Fiber<void>>()
  let runtimePreparationSerial = 0
  let pendingReopen:
    | {
        readonly sessionFile: string
        readonly sessionId: string
        readonly minimumEntries: number
        readonly unwritten?: SessionManager
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
  const shell = yield* makeWorkspaceShell((cwd, executionOf) =>
    Effect.suspend(() => {
      const attachment = activeAttachment
      const execution = executionOf(attachment)
      return attachment
        .authorize({ kind: 'write', cwd, scoped: { kind: 'opaque', execution, cwd } })
        .pipe(
          Effect.flatMap(result =>
            result.kind === 'ready'
              ? Effect.succeed({ attachment, execution, scoped: result.scoped })
              : Effect.fail(
                  new WorkspaceError({
                    outcome: 'blocked',
                    message: 'Dev must switch checkouts first; the command did not run.',
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
    if (currentApi === undefined || !currentContext?.hasUI) {
      process.stderr.write(`${formatSweepReceipt(receipt)}\n`)
      return
    }
    const details: SweepDetails = { kind: 'sweep', receipt }
    const content = sweepText(receipt)
    try {
      if (content === undefined) currentApi.appendEntry(RECEIPT_ENTRY, details)
      else
        currentApi.sendMessage(
          { customType: WORKSPACE_MESSAGE, content, display: true, details },
          { triggerTurn: false }
        )
    } catch {
      process.stderr.write(`${formatSweepReceipt(receipt)}\n`)
    }
  }
  const showRefusal = (refusal: RefusalDetails): void => {
    const plain = `Dev could not verify checkout access: ${refusal.reason}. ${refusal.endedTurn ? 'The turn ended' : 'The command did not run'}; ${refusal.next}`
    if (currentApi === undefined || !currentContext?.hasUI) {
      process.stderr.write(`${plain}\n`)
      return
    }
    try {
      currentApi.appendEntry(REFUSAL_ENTRY, refusal)
    } catch {
      process.stderr.write(`${plain}\n`)
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

  let replacementReceipt: SweepReceipt | undefined
  const showReplacementReceipt = (sessionId: string): void => {
    const receipt = replacementReceipt
    if (receipt === undefined || activeConversation.sessionId !== sessionId) return
    replacementReceipt = undefined
    if (receipt.rows.length > 0) showSweep(receipt)
  }

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
    if (!runtime) return yield* hostFailure('Dev could not switch checkouts: no active Pi session')
    const { session } = runtime
    yield* fromPi(() => session.waitForIdle())
    if (!session.isIdle || session.pendingMessageCount !== 0 || session.isBashRunning)
      return yield* hostFailure('Pi is not idle. Checkout access is still blocked')
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
      return yield* hostFailure('Pi runtime disappeared before checkout replacement')
    const trustSnapshot = trustContextFor(transition.surface, transition.handoff.target.cwd)
    const withSession = async (fresh: ReplacedSessionContext): Promise<void> => {
      restoreInput(fresh)
      const { binding } = activeAttachment
      if (
        !isBoundTo(binding.conversation, identityOf(fresh.sessionManager)) ||
        binding.workspaceId !== transition.handoff.target.workspaceId ||
        resolve(binding.cwd) !== resolve(fresh.cwd)
      ) {
        throw new Error('Pi did not open the selected checkout')
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
      return yield* hostFailure('Pi did not switch to the selected checkout')
    settle('confirmed')
    return 'confirmed' as const
  })

  const queueReevaluation = (transition: PendingTransition): void => {
    const api = currentApi
    if (!api) {
      process.stderr.write(
        'Checkout switch completed, but no active Pi extension API is available for fresh re-evaluation; submit a new prompt.\n'
      )
      return
    }
    const notices = switchNotices(transition, activeAttachment.binding)
    try {
      api.sendMessage(
        {
          customType: HANDOFF_MESSAGE,
          content: notices.model,
          display: true,
          details: notices.details,
        },
        transition.origin === 'user-resume'
          ? { triggerTurn: false }
          : { triggerTurn: true, deliverAs: 'followUp' }
      )
    } catch (error) {
      process.stderr.write(
        `Checkout switch completed, but fresh re-evaluation was not queued: ${errorText(error)}. ${notices.unqueued}\n`
      )
    }
  }

  const withdrawOrReport = (source: WorkspaceAttachment, handoff: WorkspaceHandoff) =>
    withdraw(source, handoff).pipe(
      Effect.catch(error =>
        Effect.sync(() =>
          notify(
            currentContext,
            `Dev could not cancel the switch. Checkout access is blocked. ${error.message}`,
            'error'
          )
        )
      )
    )

  const runHostHandoff = Effect.fnUntraced(function* (transition: PendingTransition) {
    if (transition.transitionSource !== activeAttachment) {
      settleHandoff(transition, 'cancelled')
      return yield* withdrawOrReport(transition.transitionSource, transition.handoff)
    }
    const performed = yield* Effect.exit(
      Effect.gen(function* () {
        capturePendingInput(transition.surface)
        yield* assertSessionIdle
        yield* shell.stop
        if (pending !== transition || quitting) return
        const identity = yield* currentSessionIdentity
        const outgoing = runtime?.session.sessionManager
        pendingReopen = {
          ...identity,
          minimumEntries: outgoing?.getEntries().length ?? 0,
          ...(outgoing === undefined || existsSync(identity.sessionFile)
            ? {}
            : { unwritten: outgoing }),
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
          settleHandoff(transition, 'cancelled')
          if (quitting) return
          restoreInput(transition.surface)
          notify(
            transition.surface,
            'Checkout switch cancelled. Still using the previous checkout.',
            'info'
          )
          return
        }
        if (callbackResult !== 'confirmed')
          return yield* hostFailure('Dev did not confirm the checkout switch')
        if (transition.transitionSource !== activeAttachment)
          yield* closeAttachmentOnce(transition.transitionSource)
        settleHandoff(transition, 'confirmed')
        queueReevaluation(transition)
      })
    )
    if (Exit.isSuccess(performed)) return
    const error = Cause.squash(performed.cause)
    if (reached(transition, 'switch-started')) {
      settleHandoff(transition, 'unconfirmed')
      process.stderr.write(
        `Dev cannot confirm the switch finished. Checkout access is blocked. ${errorText(error)}\n`
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
      settleHandoff(transition, 'unconfirmed')
      process.stderr.write(
        `Dev could not cancel the switch. Checkout access is blocked. ${errorText(Cause.squash(withdrawn.cause))}\n`
      )
      return
    }
    pendingReopen = undefined
    settleHandoff(transition, 'cancelled')
    restoreInput(transition.surface)
    notify(
      transition.surface,
      `Checkout switch was not performed; the current checkout is kept. ${errorText(error)}`,
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

  const declinedSwitch = (
    source: WorkspaceAttachment
  ): Exclude<SwitchRequest, 'requested'> | undefined => {
    const cause = blockCause(source)
    return cause === 'switch' || cause === 'replacing' ? 'busy' : cause
  }

  const requestHandoff = (
    handoff: WorkspaceHandoff,
    origin: PendingTransition['origin'],
    context: ExtensionContext,
    immediate: boolean,
    source: WorkspaceAttachment
  ): SwitchRequest => {
    const declined = declinedSwitch(source)
    if (declined !== undefined) {
      withdrawals.set(source, runDeferred(withdrawOrReport(source, handoff)))
      return declined
    }
    const transition = makeTransition(handoff, origin, context, 'requested')
    updateAccess(() => {
      pending = transition
    })
    if (immediate) scheduleHandoff(transition)
    else armedRunEnd = transition
    return 'requested'
  }

  const endRunForHandoff = (context: ExtensionContext): void => {
    const transition = armedRunEnd
    if (transition === undefined) return
    armedRunEnd = undefined
    if (pending !== transition) return
    notify(context, handoffTurnEndNotice(transition.handoff))
    endRun(context, 'switching checkouts')
  }

  const showJoin = (context: ExtensionContext, task: PausedTask): void => {
    const api = currentApi
    if (api !== undefined)
      try {
        display(api, context, { text: joinedTaskNote(task), join: joinDetails(task) })
        return
      } catch {}
    notify(context, joinedTaskNotice(task))
  }

  const endRunForDismissal = (context: ExtensionContext): void => {
    if (!armedDismissalEnd) return
    armedDismissalEnd = false
    endRun(context, 'the dismissed checkout question')
  }

  const endRunForReview = (context: ExtensionContext): void => {
    const refusal = armedReviewEnd
    if (refusal === undefined) return
    armedReviewEnd = undefined
    showRefusal(refusal)
    endRun(context, 'the checkout review')
  }

  const answerPausedTask = Effect.fnUntraced(function* (
    attachment: WorkspaceAttachment,
    operation: WriteOperation,
    context: ExtensionContext,
    origin: 'tool-call' | 'user-bash'
  ): Effect.fn.Return<WorkspaceAuthorization | RefusedAdmission, WorkspaceError> {
    let admitted = yield* attachment.authorizeWriter(operation, { kind: 'ask' })
    while (admitted.kind === 'paused') {
      const { task } = admitted
      const question = pausedTaskQuestion(task, yield* Clock.currentTimeMillis)
      const choice = yield* piCall(() =>
        context.ui.select(question.title, [question.continueHere, question.separately])
      )
      if (isBlocked() || blockCause(attachment) !== undefined)
        return parkedRefusal(origin, attachment)
      if (choice === question.separately) return yield* attachment.authorize(operation)
      if (choice !== question.continueHere) {
        armedDismissalEnd = origin === 'tool-call'
        return dismissedQuestionRefusal
      }
      admitted = yield* attachment.authorizeWriter(operation, {
        kind: 'join',
        taskId: task.taskId,
        reservationId: task.reservationId,
        reservationRevision: task.reservationRevision,
      })
      if (admitted.kind === 'ready' && admitted.grant.taskId === task.taskId)
        showJoin(context, task)
    }
    return admitted
  })

  const authorizeWriter = Effect.fnUntraced(function* (
    attachment: WorkspaceAttachment,
    operation: WriteOperation,
    context: ExtensionContext,
    origin: 'tool-call' | 'user-bash'
  ): Effect.fn.Return<WorkspaceAuthorization | RefusedAdmission, WorkspaceError> {
    if (!context.hasUI) return yield* attachment.authorize(operation)
    const admitted = yield* attachment.authorizeWriter(operation, { kind: 'ask' })
    if (admitted.kind !== 'paused') return admitted
    return yield* pausedQuestion.withPermit(
      answerPausedTask(attachment, operation, context, origin)
    )
  })

  const authorization = Effect.fnUntraced(
    function* (
      context: ExtensionContext,
      access: WorkspaceGrant['access'],
      cwd: string,
      origin: 'tool-call' | 'user-bash',
      scoped: ScopedContinuation | undefined
    ): Effect.fn.Return<Admission, WorkspaceError> {
      if (isBlocked()) return parkedRefusal(origin)
      const attachment = activeAttachment
      const result =
        access === 'read' && scoped === undefined
          ? yield* attachment.authorize({ kind: 'read', cwd })
          : yield* authorizeWriter(
              attachment,
              { kind: 'write', cwd, ...(scoped === undefined ? {} : { scoped }) },
              context,
              origin
            )
      if (result.kind === 'refused') return result
      if (result.kind === 'handoff') {
        const request = requestHandoff(
          result.handoff,
          origin,
          context,
          origin === 'user-bash',
          attachment
        )
        return {
          kind: 'refused',
          endsTurn: true,
          reason: `The call did not run: ${result.handoff.reason}. ${
            request === 'requested' ? SWITCH_REQUESTED : switchNotRequested(request)
          }`,
        }
      }
      return {
        kind: 'admitted',
        attachment,
        grant: result.grant,
        ...(result.warning ? { warning: result.warning } : {}),
        ...(result.scoped === undefined ? {} : { scoped: result.scoped }),
      }
    },
    (effect, context, _access, _cwd, origin) =>
      Effect.catchCause(effect, cause =>
        Effect.sync((): Admission => {
          const error = Cause.squash(cause)
          const reason = `The call did not run: ${errorText(error)}`
          const endsTurn = error instanceof WorkspaceError && error.outcome === 'review-required'
          if (endsTurn) {
            const refusal: RefusalDetails = {
              kind: 'refusal',
              reason: errorText(error),
              endedTurn: origin === 'tool-call',
              next: '/workspace shows the state and its next action.',
            }
            if (refusal.endedTurn) armedReviewEnd = refusal
            else showRefusal(refusal)
          }
          return { kind: 'refused', endsTurn, reason }
        })
      )
  )

  const validateNativeGrant = (
    grant: WorkspaceGrant,
    context: ExtensionContext,
    access: WorkspaceGrant['access']
  ): string | undefined => {
    const { binding } = activeAttachment
    if (grant.access !== access)
      return blockedByMismatch(`This call needs ${access} access but got ${grant.access}`)
    if (resolve(grant.cwd) !== resolve(context.cwd))
      return blockedByMismatch(`Permission was for ${grant.cwd}, not ${context.cwd}`)
    if (grant.workspaceId !== binding.workspaceId)
      return blockedByMismatch(
        `Permission was for checkout ${grant.workspaceId}, not ${binding.workspaceId}`
      )
    return undefined
  }

  const admitWriter = Effect.fnUntraced(function* (
    context: ExtensionContext,
    within?: { readonly toolName: string; readonly operation: ScopedContinuation }
  ): Effect.fn.Return<WriterAdmission> {
    const admitted = yield* authorization(
      context,
      'write',
      context.cwd,
      'tool-call',
      within?.operation
    )
    if (admitted.kind === 'refused') return { kind: 'refused', refusal: refusalOf(admitted) }
    const scoped = scopedGrantOf(admitted.scoped)
    const mismatch = validateNativeGrant(admitted.grant, context, 'write')
    if (mismatch) {
      holdAccess('mismatch')
      if (within !== undefined && scoped !== undefined && !(scoped instanceof WorkspaceError))
        yield* settleRefusedWrite(admitted.attachment, scoped, context, within.toolName)
      return { kind: 'refused', refusal: { block: true, terminate: true, reason: mismatch } }
    }
    return { kind: 'admitted', attachment: admitted.attachment, grant: admitted.grant, scoped }
  })

  const admitRead = (toolCallId: string, context: ExtensionContext) =>
    Effect.map(
      authorization(context, 'read', context.cwd, 'tool-call', undefined),
      (admitted): ToolCallEventResult | undefined => {
        if (admitted.kind === 'refused') return refusalOf(admitted)
        const mismatch = validateNativeGrant(admitted.grant, context, 'read')
        if (mismatch) {
          holdAccess('mismatch')
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
      const scope = {
        checkout,
        authorityRoot: authority.root,
        ...(binding.taskId === undefined ? {} : { taskId: binding.taskId }),
      }
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
        replacement === undefined &&
        !isBlocked() &&
        !detachedAttachments.has(attachment) &&
        activeAttachment === attachment &&
        attachment.binding.revision === binding.revision &&
        resolve(context.cwd) === resolve(binding.cwd)
          ? Effect.void
          : Effect.fail(
              new WorkspaceError({
                outcome: 'blocked',
                message: 'This conversation changed checkouts or is switching',
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
      let operationGrant: WorkspaceGrant
      let writeScope = scope
      let admitted = destination
      if (destination.kind === 'foreign') {
        let caller: WorkspaceGrant | undefined
        if (isWithin(authority.root, destination.checkout)) {
          const writer = yield* admitWriter(context)
          if (writer.kind === 'refused') return writer.refusal
          caller = writer.grant
        }
        const foreign = yield* attachment.authorize({
          kind: 'foreign-write',
          cwd: destination.checkout,
          ...(caller === undefined ? {} : { caller }),
        })
        if (foreign.kind !== 'ready')
          return yield* hostFailure('no permission to write in the other checkout')
        writeScope = { checkout: foreign.grant.checkout, authorityRoot: authority.root }
        const scopedCwd = foreign.grant.checkout
        admitted = yield* Effect.try({
          try: () => classifyWriteDestination(writeScope, scopedCwd, destination.operand),
          catch: cause => hostFailure(errorText(cause)),
        })
        const operation = yield* attachment.authorize({
          kind: 'native-file-write',
          within: foreign.grant,
          path: destination.operand,
          cwd: scopedCwd,
        })
        if (operation.kind !== 'ready') return yield* hostFailure(WRITE_ADMISSION_CHANGED)
        operationGrant = operation.grant
      } else if (destination.kind === 'artifact') {
        const writer = yield* admitWriter(context)
        if (writer.kind === 'refused') return writer.refusal
        if (writer.grant.taskId !== scope.taskId)
          return yield* hostFailure('the task changed before writing the file')
        yield* nativeWrites.admit({
          toolCallId: event.toolCallId,
          scope,
          destination,
          lifecycle: { kind: 'local', validate },
        })
        return undefined
      } else {
        const writer = yield* admitWriter(context, {
          toolName: event.toolName,
          operation: { kind: 'native-file-write', path, cwd: context.cwd },
        })
        if (writer.kind === 'refused') return writer.refusal
        const { scoped } = writer
        if (scoped instanceof WorkspaceError) return yield* scoped
        if (scoped === undefined) return yield* hostFailure(WRITE_ADMISSION_CHANGED)
        if (writer.attachment !== attachment) {
          yield* settleRefusedWrite(writer.attachment, scoped, context, event.toolName)
          return yield* hostFailure(WRITE_ADMISSION_CHANGED)
        }
        operationGrant = scoped
      }
      yield* nativeWrites
        .admit({
          toolCallId: event.toolCallId,
          scope: writeScope,
          destination: admitted,
          lifecycle: { kind: 'workspace', attachment, grant: operationGrant },
        })
        .pipe(
          Effect.tapError(() =>
            settleRefusedWrite(attachment, operationGrant, context, event.toolName)
          )
        )
      return undefined
    },
    (effect, event) =>
      Effect.catchCause(effect, cause =>
        Effect.succeed<ToolCallEventResult | undefined>({
          block: true,
          reason: `${event.toolName} did not run: ${errorText(Cause.squash(cause))}`,
        })
      )
  )

  const safeToolCall = (
    api: ExtensionAPI,
    event: HostToolCallEvent,
    context: ExtensionContext
  ): Effect.Effect<ToolCallEventResult | void> => {
    if (isBlocked())
      return Effect.succeed({
        block: true,
        terminate: true,
        reason: blockedNow('the tool did not run'),
      })
    const effect = toolEffect(getToolInfo(api, event.toolName))
    switch (effect) {
      case undefined:
        return Effect.succeed({
          block: true,
          reason: `${event.toolName} did not run. Dev has not verified what this tool can do to project files.`,
        })
      case 'work-owner':
      case 'web-read':
      case 'codemode':
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
    if (!file) return yield* hostFailure(NO_SESSION_FILE)
    let manager = input.sessionManager
    const key = sessionKey(file, identity.sessionId)
    const parent = manager.getHeader()?.parentSession
    const forkOfActive =
      parent !== undefined && conversationFile(parent) === activeConversation.sessionFile
    const reopenTarget = pendingReopen
    const unwritten =
      reopenTarget !== undefined &&
      conversationFile(reopenTarget.sessionFile) === conversationFile(file)
        ? reopenTarget.unwritten
        : undefined
    const reopen =
      reopenTarget !== undefined &&
      (unwritten !== undefined || sameConversation(reopenTarget, identity))
    if (reopen) {
      if (unwritten !== undefined)
        yield* Effect.try({
          try: () => writeUnwrittenConversation(unwritten, file, options.openSessionManager),
          catch: cause =>
            hostFailure(
              `This conversation has no message yet, and its file could not be written for the switch: ${errorText(cause)}`
            ),
        })
      manager = options.openSessionManager(file, input.cwd)
      if (
        !sameConversation(identityOf(manager), reopenTarget) ||
        manager.getEntries().length < reopenTarget.minimumEntries
      )
        return yield* hostFailure('The switch did not reopen the same Pi conversation')
    }
    const staged = stagedAttachments.get(key)
    const canReuse = !reopen && !staged && isBoundTo(activeConversation, identity)
    if (!reopen && !staged && !canReuse && !forkOfActive) yield* sweepLeavingWorkspaces(file)

    const resolved = yield* attachForManager(
      manager,
      forkOfActive ? activeAttachment.binding.cwd : input.cwd,
      staged ?? (canReuse ? activeAttachment : undefined)
    )
    if (staged) stagedAttachments.delete(key)
    if (
      replacement !== undefined &&
      !canReuse &&
      activeConversation.sessionId !== identity.sessionId
    )
      blockForReplacement(replacement)
    return {
      attachment: resolved.attachment,
      sessionManager: resolved.manager,
      cwd: resolved.cwd,
    }
  })

  const sweepLeavingWorkspaces = Effect.fnUntraced(function* (arrivingSessionFile: string) {
    const leaving = activeAttachment
    const { binding, delegatedCwds } = leaving
    const closing = yield* Effect.exit(closeAttachmentOnce(leaving))
    if (Exit.isFailure(closing)) {
      replacementReceipt = replacementSweepFailure(
        `Could not close the previous conversation's checkout access. Automatic cleanup did not run: ${errorText(Cause.squash(closing.cause))}`
      )
      return
    }
    replacementReceipt = yield* authority
      .sweep({
        moment: 'replacement',
        anchorWorkspaceId: binding.workspaceId,
        delegatedCwds,
        occupiedPaths: [process.cwd(), binding.conversation.sessionFile, arrivingSessionFile],
      })
      .pipe(
        Effect.catch(error =>
          Effect.succeed(
            replacementSweepFailure(
              `Automatic cleanup failed; nothing was released: ${error.message}`
            )
          )
        )
      )
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
    if (startedSessionId === undefined || startedSessionId === nextIdentity.sessionId)
      showReplacementReceipt(nextIdentity.sessionId)
    const owner = replacement
    if (owner !== undefined && !continuing) {
      const expectedId = nextIdentity.sessionId
      runDeferred(
        Effect.sync(() => {
          if (
            activeConversation.sessionId === expectedId &&
            runtime?.session.sessionManager.getSessionId() === expectedId
          )
            settleReplacement(owner, 'confirmed')
        })
      )
    }
  })

  const refusedWhileSwitching = Effect.sync(() => {
    if (hold !== 'unresolved' && pending === undefined) return false
    notify(
      currentContext,
      notDoneWhileBlocked(hold === 'unresolved' ? 'unresolved' : 'switch', SESSION_NOT_REPLACED),
      'warning'
    )
    return true
  })
  const guardedReplacement = Effect.fnUntraced(function* <
    A extends { readonly cancelled: boolean },
    E,
  >(replace: Effect.Effect<A, E>): Effect.fn.Return<A | { readonly cancelled: true }, E> {
    if (yield* refusedWhileSwitching) return { cancelled: true }
    const owner = beginReplacement()
    return yield* Effect.onExit(replace, exit =>
      Effect.sync(() =>
        settleReplacement(
          owner,
          changeOutcome(Exit.isSuccess(exit) && !exit.value.cancelled, !owner.blocking)
        )
      )
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
    const owner = beginReplacement()
    const previousSerial = runtimePreparationSerial
    const nothingPrepared = () => runtimePreparationSerial === previousSerial
    let staged: { readonly key: string; readonly attachment: WorkspaceAttachment } | undefined
    let target: ConversationIdentity | undefined
    let switchStarted = false
    const clearReopen = () => {
      if (
        target !== undefined &&
        pendingReopen !== undefined &&
        sameConversation(pendingReopen, target)
      )
        pendingReopen = undefined
    }
    const unstage = Effect.suspend(() => {
      if (staged === undefined) return Effect.void
      stagedAttachments.delete(staged.key)
      return closeAttachmentOnce(staged.attachment)
    })
    return yield* Effect.gen(function* () {
      const targetManager = options.openSessionManager(sessionFile)
      const trustSnapshot = trustContextFor(currentContext, targetManager.getCwd())
      const file = targetManager.getSessionFile()
      if (!file) return yield* fromPi(() => rawSwitch(sessionFile, switchOptions))
      const id = targetManager.getSessionId()
      target = { sessionId: id, sessionFile: file }
      if (isBoundTo(activeConversation, target)) {
        notify(currentContext, 'This conversation is already active and kept its checkout.')
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
      staged = { key: sessionKey(file, id), attachment: prepared }
      stagedAttachments.set(staged.key, prepared)
      blockForReplacement(owner)
      switchStarted = true
      return yield* fromPi(() =>
        rawSwitch(sessionFile, {
          ...switchOptions,
          cwdOverride: prepared.binding.cwd,
          projectTrustContextFactory:
            switchOptions?.projectTrustContextFactory ?? (cwd => ({ ...trustSnapshot, cwd })),
        })
      )
    }).pipe(
      Effect.onExit(exit =>
        Effect.gen(function* () {
          const changed = Exit.isSuccess(exit) && !exit.value.cancelled
          const unchanged =
            !changed && nothingPrepared() && (Exit.isSuccess(exit) || !switchStarted)
          if (unchanged) yield* Effect.ignore(unstage)
          if (changed || unchanged) clearReopen()
          settleReplacement(owner, changeOutcome(changed, unchanged))
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
    else if (reason !== 'reload' && replacement !== undefined) blockForReplacement(replacement)
    yield* nativeWrites.settle
    if (reason !== 'reload') yield* shell.stop
    if (reason !== 'quit') return
    if (reached(pending, 'switch-started')) return

    const inFlight = pending
    if (inFlight !== undefined && reached(inFlight, 'handoff-sent')) {
      yield* Deferred.await(inFlight.settled)
      if (pending === inFlight) return
    }
    const waiting = pending
    if (waiting) {
      const withdrawn = yield* Effect.exit(withdraw(waiting.transitionSource, waiting.handoff))
      if (Exit.isFailure(withdrawn)) {
        settleHandoff(waiting, 'unconfirmed')
        notify(
          currentContext,
          `Dev could not safely cancel the checkout switch. ${errorText(Cause.squash(withdrawn.cause))}`,
          'error'
        )
        return
      }
      settleHandoff(waiting, 'cancelled')
    }
    yield* closeAttachmentOnce(activeAttachment)
  })

  const resumeChoice = Effect.fnUntraced(function* (
    taskId: WorkspaceId | undefined,
    binding: WorkspaceBinding,
    context: ExtensionCommandContext
  ): Effect.fn.Return<ResumeCandidate | string | undefined, WorkspaceError> {
    let candidates: readonly ResumeCandidate[]
    if (taskId === undefined) {
      if (!context.hasUI)
        return 'The list of paused work needs an interactive session; name the task instead: /workspace resume <task-id>.'
      const root = yield* repositoryRoot.resolve(context.cwd)
      if (root === undefined) return '/workspace resume requires a Git repository.'
      const views = yield* authority.inspect({ cwd: root })
      candidates = resumableWorkspaces(views)
      if (candidates.length === 0) return notResumableText({ repositoryRoot: root }, views)
    } else {
      const views = yield* authority.inspect({ taskId })
      candidates = resumableWorkspaces(views)
      const [only] = candidates
      if (only === undefined)
        return binding.taskId === taskId
          ? alreadyWorksFor(taskId, binding)
          : notResumableText({ taskId }, views)
      if (candidates.length === 1) return only
      if (!context.hasUI)
        return `Task ${taskId} retains several checkouts; choosing one needs an interactive session.`
    }
    const now = yield* Clock.currentTimeMillis
    const rows = candidates.map(candidate => resumableRowText(candidate, now))
    const choice = yield* piCall(() => context.ui.select('Resume paused work in:', rows))
    return choice === undefined ? undefined : candidates[rows.indexOf(choice)]
  })

  const resumeRefusal = (
    context: ExtensionCommandContext,
    source: WorkspaceAttachment
  ): string | undefined => {
    const cause = blockCause(source)
    if (cause !== undefined) return notDoneWhileBlocked(cause, CONVERSATION_NOT_SWITCHED)
    if (!context.isIdle())
      return 'A turn is still running, so the conversation was not switched; run /workspace resume again once it ends.'
    return undefined
  }

  const resumeCommand = Effect.fnUntraced(function* (
    api: ExtensionAPI,
    args: readonly string[],
    context: ExtensionCommandContext
  ): Effect.fn.Return<void, WorkspaceCommandError> {
    const say = (text: string): void => display(api, context, { text })
    if (args.length > 1)
      return yield* new WorkspaceCommandError({
        message: 'Usage: /workspace resume [task-id]',
        exitCode: 2,
      })
    const taskId = args[0] === undefined ? undefined : yield* exactId(args[0], 'Task')
    const attachment = activeAttachment
    const busy = resumeRefusal(context, attachment)
    if (busy !== undefined) return say(busy)
    const requested = yield* Effect.gen(function* () {
      const chosen = yield* resumeChoice(taskId, attachment.binding, context)
      if (chosen === undefined) return undefined
      const late = resumeRefusal(context, attachment)
      if (late !== undefined) return late
      if (typeof chosen === 'string') return chosen
      const { binding } = attachment
      if (
        chosen.view.workspaceId === binding.workspaceId &&
        chosen.selection.taskId === binding.taskId
      )
        return alreadyWorksFor(chosen.selection.taskId, binding)
      const request = requestHandoff(
        yield* attachment.select(chosen.selection),
        'user-resume',
        context,
        true,
        attachment
      )
      return request === 'requested'
        ? undefined
        : notDoneWhileBlocked(request, CONVERSATION_NOT_SWITCHED)
    }).pipe(
      Effect.catch(error => Effect.succeed(`The conversation was not switched: ${error.message}`))
    )
    if (requested !== undefined) say(requested)
  })

  const workspaceCommand = Effect.fnUntraced(
    function* (api: ExtensionAPI, args: string, context: ExtensionCommandContext) {
      const tokens = args.trim() ? args.trim().split(/\s+/) : []
      if (tokens[0] === 'resume') return yield* resumeCommand(api, tokens.slice(1), context)
      const command = yield* parseWorkspaceCommand(tokens)
      if (isReleaseCommand(command)) {
        display(api, context, {
          text: releaseRedirect(command),
        })
        return
      }
      const result = yield* runReadOnlyWorkspaceCommand(Effect.succeed(authority), command, {
        repositoryRoot: repositoryRoot.resolve(context.cwd),
        current: {
          workspaceId: activeAttachment.binding.workspaceId,
          ...(activeAttachment.binding.taskId === undefined
            ? {}
            : { taskId: activeAttachment.binding.taskId }),
          effectiveCwd: context.cwd,
          conversation: activeAttachment.binding.conversation,
        },
      })
      display(api, context, result)
    },
    (effect, api, _args, context) =>
      effect.pipe(
        Effect.catchTag('WorkspaceCommandError', error =>
          Effect.sync(() => display(api, context, { text: error.message }))
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
    isParked: isBlocked,
    blockedAccess: didNotRun => blockedNow(didNotRun),
    isDetached: () => detachedAttachments.has(activeAttachment),
    requestHandoff: (handoff, source, context) =>
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
        return rawDispose()
      }
      const rawNew = nextRuntime.newSession.bind(nextRuntime)
      nextRuntime.newSession = newOptions =>
        runPromise(guardedReplacement(piCall(() => rawNew(newOptions))))
      const rawFork = nextRuntime.fork.bind(nextRuntime)
      nextRuntime.fork = (entryId, forkOptions) =>
        runPromise(guardedReplacement(piCall(() => rawFork(entryId, forkOptions))))
      const rawImport = nextRuntime.importFromJsonl.bind(nextRuntime)
      nextRuntime.importFromJsonl = (inputPath, cwdOverride) =>
        runPromise(importConversation(rawSwitch, rawImport, inputPath, cwdOverride))
    },
    close,
    extensionFactory(api) {
      currentApi = api
      api.on('session_start', (_event, context) => {
        currentContext = context
        startedSessionId = context.sessionManager.getSessionId()
        if (activeAttachment.binding.conversation.sessionId === startedSessionId) {
          activeManager = context.sessionManager as SessionManager
          showReplacementReceipt(startedSessionId)
        }
      })

      api.on('tool_call', (event, context) => runPromise(safeToolCall(api, event, context)))

      api.on('tool_execution_end', (event, context) =>
        runPromise(
          nativeWrites.finish(event.toolCallId).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                readerWarnings.delete(event.toolCallId)
                endRunForHandoff(context)
                endRunForReview(context)
                endRunForDismissal(context)
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
          ...(event.structuredContent === undefined
            ? {}
            : { structuredContent: event.structuredContent }),
        }
      })

      api.on('user_bash', (event, context) =>
        runPromise(
          Effect.map(authorization(context, 'write', event.cwd, 'user-bash', undefined), admitted =>
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
        if (!pending || startsWithoutTurn(pending.origin)) return
        capturePendingInput(context)
        scheduleHandoff(pending)
      })

      api.on('agent_before_settle', event => {
        if (!isBlocked()) return
        return { entries: event.entries, continue: false }
      })

      api.on('input', (event, _context) => {
        if (!isBlocked() || event.source === 'extension') return
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

      api.on('session_shutdown', event =>
        runPromise(
          sessionShutdown(event.reason).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                currentContext = undefined
              })
            )
          )
        )
      )

      api.registerCommand('workspace', {
        description: 'Show checkouts, or resume, inspect or check a task',
        getArgumentCompletions: verbCompletions([
          {
            verb: 'list',
            description: "This repository's tasks and where this conversation works (default)",
          },
          {
            verb: 'resume',
            arguments: '[task-id]',
            description: 'Continue paused work here: its files and task, not its old chat',
          },
          {
            verb: 'inspect',
            arguments: '<task-id>',
            description: "A task's checkouts and next safe action",
          },
          {
            verb: 'check',
            arguments: '<task-id>',
            description: 'Whether a task is finished: destination branch, blockers and evidence',
          },
          {
            verb: 'release',
            arguments: '<task-id>',
            description: "Show the terminal command that discards a task's checkouts",
          },
        ]),
        handler: (args, context) => runPromise(workspaceCommand(api, args, context)),
      })
      api.registerTool(
        makeWorkspaceTool({
          lifecycle: authority,
          attachment: () => activeAttachment,
          runPromise,
          requestResume: (handoff, source, context) =>
            requestHandoff(handoff, 'tool-resume', context, false, source),
          declinedSwitch,
        })
      )
    },
  }
})
