import { Cause, Effect, Exit, Schema, type Scope } from 'effect'
import { resolve } from 'node:path'
import type { AgentSessionRuntime } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session-runtime.js'
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ProjectTrustContext,
  ReplacedSessionContext,
  ToolCallEventResult,
} from '../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.js'
import type { SessionManager } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js'
import type { BashOperations } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js'
import type { EditOperations } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit.js'
import type { WriteOperations } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/write.js'
import {
  attemptCommand,
  chooseResumeCandidate,
  formatWorkspaceInspect,
  formatWorkspaceList,
  parseWorkspaceCommand,
  resumeCandidates,
  WorkspaceCommandError,
  type ResumeCandidate,
} from './workspace-command.ts'
import {
  WorkspaceError,
  type WorkspaceAttachment,
  type WorkspaceConversation,
  type WorkspaceGrant,
  type WorkspaceHandoff,
  type WorkspaceLifecycle,
} from './workspace-domain.ts'
import { makeNativeWrites } from './workspace-native-write.ts'
import { decodeWriteOperand } from './workspace-paths.ts'
import { makeWorkspaceShell } from './workspace-shell.ts'

export class WorkspaceHostError extends Schema.TaggedError<WorkspaceHostError>()(
  'WorkspaceHostError',
  { message: Schema.String }
) {}

export interface WorkspaceHostOptions {
  readonly lifecycle: WorkspaceLifecycle
  readonly attachment: WorkspaceAttachment
  readonly dataHome: string
  readonly openSessionManager: (sessionFile: string, cwdOverride?: string) => SessionManager
  readonly repositoryRoot: (cwd: string) => Effect.Effect<string | undefined>
}

export interface RuntimeWorkspace {
  readonly attachment: WorkspaceAttachment
  readonly sessionManager: SessionManager
  readonly cwd: string
}

export interface WorkspaceWorkStatus {
  readonly taskId: string
  readonly attemptId: string
  readonly kind: 'process' | 'agent'
  readonly status: string
  readonly cwd: string
}

export interface WorkspaceWorkControls {
  readonly running: () => Promise<readonly WorkspaceWorkStatus[]>
  readonly stopAll: (reason: string) => Promise<void>
}

// Pi calls the host through extension handlers, its runtime factory and `switchSession`,
// all Promise-based; those entry points run the Effect programs below.
export interface WorkspaceHost {
  readonly extensionFactory: (api: ExtensionAPI) => void
  readonly attachment: WorkspaceAttachment
  readonly shellOperations: BashOperations
  readonly writeOperations: WriteOperations
  readonly editOperations: EditOperations
  isParked(): boolean
  prepareRuntime(input: {
    readonly sessionManager: SessionManager
    readonly cwd: string
  }): Promise<RuntimeWorkspace>
  commitRuntime(attachment: WorkspaceAttachment): Promise<void>
  bindRuntime(runtime: AgentSessionRuntime): void
  setWorkControls(controls: WorkspaceWorkControls): void
  readonly close: Effect.Effect<void, WorkspaceError>
}

interface PendingTransition {
  readonly handoff: WorkspaceHandoff
  readonly origin: 'tool-call' | 'user-bash' | 'command'
  readonly context: ExtensionContext
  readonly transitionSource: WorkspaceAttachment
  scheduled: boolean
  switchStarted: boolean
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
  | { readonly grant: WorkspaceGrant; readonly warning?: string; readonly blocked?: undefined }
  | { readonly grant?: undefined; readonly blocked: string }

const hostFailure = (message: string) => new WorkspaceHostError({ message })
const fromPi = <A>(operation: () => Promise<A>): Effect.Effect<A, WorkspaceHostError> =>
  Effect.tryPromise({
    try: operation,
    catch: cause => hostFailure(cause instanceof Error ? cause.message : String(cause)),
  })

// The authority answers `blocked` to a switch it refused before the host acted, having
// already withdrawn it and kept the last confirmed binding.
const isWithdrawn = (error: unknown): boolean =>
  error instanceof WorkspaceError && error.outcome === 'blocked'

const sessionKey = (file: string, id: string): string => `${resolve(file)}\0${id}`
const formatError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export function projectTrustContextFromExtension(
  context: ExtensionContext,
  cwd: string
): ProjectTrustContext {
  return { cwd, mode: context.mode, hasUI: context.hasUI, ui: context.ui }
}

const noUiProjectTrustContext = (cwd: string): ProjectTrustContext => ({
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

// A tool is classified by what its implementation does, recorded here after review under
// the executable-extension policy in ADR 0005, never by its name alone.
type ToolEffect = 'read' | 'native-write' | 'workspace-shell' | 'work-owner'

function toolEffect(tool: HostToolInfo | undefined): ToolEffect | undefined {
  if (!tool) return undefined
  const { source, path } = tool.sourceInfo
  if (source === 'builtin' && ['read', 'grep', 'find', 'ls'].includes(tool.name)) return 'read'
  if (source === 'sdk' && path === '<sdk:bash>') return 'workspace-shell'
  if (source === 'sdk' && (path === '<sdk:write>' || path === '<sdk:edit>')) return 'native-write'
  if (source === 'inline' && path === '<inline:dev:work>' && tool.name === 'work')
    return 'work-owner'
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

export const makeWorkspaceHost = (
  options: WorkspaceHostOptions
): Effect.Effect<WorkspaceHost, never, Scope.Scope> =>
  Effect.gen(function* () {
    let activeAttachment = options.attachment
    let activeConversation = activeAttachment.binding.conversation
    let activeManager: SessionManager | undefined
    let runtime: AgentSessionRuntime | undefined
    let currentContext: ExtensionContext | undefined
    let currentApi: ExtensionAPI | undefined
    let parked = false
    let closed = false
    let pending: PendingTransition | undefined
    let invokingHandoffSwitch = false
    let workControls: WorkspaceWorkControls | undefined
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
    const preservedInput: string[] = []
    const readerWarnings = new Map<string, string>()
    let writerWarned = false

    const notify = (
      context: ExtensionContext | undefined,
      message: string,
      level: 'info' | 'warning' | 'error' = 'info'
    ) => {
      if (context?.hasUI) context.ui.notify(message, level)
      else process.stderr.write(`${message}\n`)
    }

    const nativeWrites = makeNativeWrites(message => notify(currentContext, message, 'error'))
    const shell = yield* makeWorkspaceShell(cwd =>
      Effect.suspend(() => {
        const attachment = activeAttachment
        return attachment.authorize({ access: 'write', cwd }).pipe(
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
    const services = yield* Effect.context<never>()
    const runPromise = Effect.runPromiseWith(services)
    const runFork = Effect.runForkWith(services)

    const closeAttachmentOnce = (attachment: WorkspaceAttachment) =>
      Effect.suspend(() => {
        if (closedAttachments.has(attachment)) return Effect.void
        closedAttachments.add(attachment)
        return attachment.close
      })

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

    const contextForCwd = (
      context: ExtensionContext | undefined,
      cwd: string
    ): ProjectTrustContext =>
      context ? projectTrustContextFromExtension(context, cwd) : noUiProjectTrustContext(cwd)

    const currentSessionIdentity = Effect.suspend(() => {
      const manager = runtime?.session.sessionManager ?? activeManager
      const sessionFile = manager?.getSessionFile()
      if (!manager || !sessionFile)
        return Effect.fail(hostFailure('Active Pi runtime has no persisted session file'))
      return Effect.succeed({ file: sessionFile, id: manager.getSessionId() })
    })

    const capturePendingInput = (context: ExtensionContext): void => {
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

    const restoreInput = (context: ExtensionContext | undefined): void => {
      if (!preservedInput.length || !context?.hasUI) return
      context.ui.setEditorText(preservedInput.splice(0).join('\n\n'))
    }

    const noReplayMessage = (handoff: WorkspaceHandoff): string =>
      `Workspace admission changed after ${handoff.reason}. The prior operation was blocked and was not replayed. Current workspace: ${handoff.target.workspaceId} at ${handoff.target.cwd}. Re-evaluate the user's request using this new context; do not repeat the blocked tool payload.`

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

    // Runs the switch the authority granted: the host shuts the outgoing session down and
    // reopens it at the target inside the authority's callback, which records the outcome.
    const replaceSession = (
      transition: PendingTransition,
      identity: { readonly file: string; readonly id: string },
      target: WorkspaceGrant,
      settle: (outcome: 'confirmed' | 'cancelled') => void
    ): Effect.Effect<'confirmed' | 'cancelled', WorkspaceHostError> =>
      Effect.gen(function* () {
        transition.switchStarted = true
        const currentRuntime = runtime
        if (!currentRuntime)
          return yield* hostFailure('Pi runtime disappeared before workspace replacement')
        const trustSnapshot = contextForCwd(transition.context, transition.handoff.target.cwd)
        const withSession = async (fresh: ReplacedSessionContext): Promise<void> => {
          restoreInput(fresh)
          const binding = activeAttachment.binding
          if (
            binding.conversation.sessionId !== fresh.sessionManager.getSessionId() ||
            resolve(binding.conversation.sessionFile) !==
              resolve(fresh.sessionManager.getSessionFile() ?? '') ||
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
          currentRuntime.switchSession(identity.file, {
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
          current.conversation.sessionId !== identity.id ||
          resolve(current.conversation.sessionFile) !== resolve(identity.file) ||
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
      try {
        const binding = activeAttachment.binding
        api.sendMessage(
          {
            customType: 'dev/workspace',
            content: `Workspace is now ${binding.workspaceId} at ${binding.cwd}. The blocked operation was not replayed.`,
            display: true,
          },
          { triggerTurn: false }
        )
        api.sendMessage(
          {
            customType: 'dev/workspace-handoff',
            content: noReplayMessage(transition.handoff),
            display: true,
          },
          { triggerTurn: true, deliverAs: 'followUp' }
        )
      } catch (error) {
        process.stderr.write(
          `Workspace switch completed, but fresh re-evaluation was not queued: ${formatError(error)}. The blocked request was not replayed; submit a new prompt.\n`
        )
      }
    }

    const performPendingHandoff = (transition: PendingTransition): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (pending !== transition || transition.switchStarted) return
        let handoffCalled = false
        const performed = yield* Effect.exit(
          Effect.gen(function* () {
            capturePendingInput(transition.context)
            yield* assertSessionIdle
            yield* shell.stop
            const identity = yield* currentSessionIdentity
            pendingReopen = {
              sessionFile: identity.file,
              sessionId: identity.id,
              minimumEntries: runtime?.session.sessionManager.getEntries().length ?? 0,
            }
            let callbackResult: 'confirmed' | 'cancelled' | undefined
            handoffCalled = true
            yield* transition.transitionSource.handoff(transition.handoff, target =>
              replaceSession(transition, identity, target, outcome => {
                callbackResult = outcome
              })
            )
            pendingReopen = undefined
            if (callbackResult === 'cancelled') {
              pending = undefined
              parked = false
              restoreInput(transition.context)
              notify(
                transition.context,
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
        if (transition.switchStarted) {
          process.stderr.write(
            `Workspace handoff is unresolved; this session remains parked. ${formatError(error)}\n`
          )
          return
        }
        // The host never acted, so the authority can keep the last confirmed binding.
        const withdrawn = yield* Effect.exit(
          handoffCalled
            ? isWithdrawn(error)
              ? Effect.void
              : Effect.fail(error)
            : transition.transitionSource
                .handoff(transition.handoff, () => Effect.succeed('cancelled' as const))
                .pipe(
                  Effect.catchIf(isWithdrawn, () => Effect.void),
                  Effect.asVoid
                )
        )
        if (Exit.isFailure(withdrawn)) {
          process.stderr.write(
            `Workspace handoff could not be withdrawn; this session remains parked. ${formatError(Cause.squash(withdrawn.cause))}\n`
          )
          return
        }
        pendingReopen = undefined
        pending = undefined
        parked = false
        restoreInput(transition.context)
        notify(
          transition.context,
          `Workspace switch was not performed; the current workspace is kept. ${formatError(error)}`,
          'warning'
        )
      })

    const scheduleHandoff = (transition: PendingTransition): void => {
      if (transition.scheduled) return
      transition.scheduled = true
      setImmediate(() => {
        runFork(performPendingHandoff(transition))
      })
    }

    const requestHandoff = (
      handoff: WorkspaceHandoff,
      origin: PendingTransition['origin'],
      context: ExtensionContext,
      immediate: boolean
    ): void => {
      if (pending) return
      parked = true
      const transition: PendingTransition = {
        handoff,
        origin,
        context,
        transitionSource: activeAttachment,
        scheduled: false,
        switchStarted: false,
        capturedInput: false,
      }
      pending = transition
      if (immediate) scheduleHandoff(transition)
    }

    const authorization = (
      context: ExtensionContext,
      access: 'read' | 'write',
      cwd: string,
      delegated = false,
      origin: 'tool-call' | 'user-bash' = 'tool-call'
    ): Effect.Effect<Admission> =>
      Effect.gen(function* () {
        if (parked)
          return { blocked: 'Workspace host is parked during a transition; no operation started.' }
        const result = yield* activeAttachment.authorize({
          access,
          cwd,
          ...(delegated ? { delegated: true } : {}),
        })
        if (result.kind === 'rebind') {
          requestHandoff(result.handoff, origin, context, origin === 'user-bash')
          return {
            blocked: `Workspace admission requires a host rebind: ${result.handoff.reason}. The operation was not executed.`,
          }
        }
        return { grant: result.grant, ...(result.warning ? { warning: result.warning } : {}) }
      }).pipe(
        Effect.catchCause(cause =>
          Effect.succeed({
            blocked: `Workspace admission failed closed: ${formatError(Cause.squash(cause))}`,
          })
        )
      )

    const validateNativeGrant = (
      grant: WorkspaceGrant,
      context: ExtensionContext,
      access: WorkspaceGrant['access']
    ): string | undefined => {
      const binding = activeAttachment.binding
      if (grant.access !== access) {
        return `Workspace authority returned ${grant.access} access for a ${access} operation; the Pi tool was not executed.`
      }
      if (
        grant.workspaceId !== binding.workspaceId ||
        resolve(grant.cwd) !== resolve(context.cwd)
      ) {
        return `Workspace authority returned ${grant.workspaceId} at ${grant.cwd}, but Pi is still bound to ${binding.workspaceId} at ${context.cwd}; the native tool was not executed.`
      }
      return undefined
    }

    const admitWriter = (context: ExtensionContext) =>
      Effect.map(
        authorization(context, 'write', context.cwd),
        (
          admitted
        ): { readonly grant: WorkspaceGrant } | { readonly refusal: ToolCallEventResult } => {
          if (!admitted.grant)
            return { refusal: { block: true, terminate: true, reason: admitted.blocked } }
          const mismatch = validateNativeGrant(admitted.grant, context, 'write')
          if (mismatch) {
            parked = true
            return { refusal: { block: true, terminate: true, reason: mismatch } }
          }
          return { grant: admitted.grant }
        }
      )

    const admitRead = (toolCallId: string, context: ExtensionContext) =>
      Effect.map(
        authorization(context, 'read', context.cwd),
        (admitted): ToolCallEventResult | undefined => {
          if (!admitted.grant) return { block: true, terminate: true, reason: admitted.blocked }
          const mismatch = validateNativeGrant(admitted.grant, context, 'read')
          if (mismatch) {
            parked = true
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

    const admitNativeWrite = (
      event: HostToolCallEvent,
      context: ExtensionContext
    ): Effect.Effect<ToolCallEventResult | undefined> =>
      Effect.gen(function* () {
        const writer = yield* admitWriter(context)
        if ('refusal' in writer) return writer.refusal
        const attachment = activeAttachment
        return yield* Effect.gen(function* () {
          const path = yield* Effect.try({
            try: () => decodeWriteOperand(event.input),
            catch: cause => hostFailure(formatError(cause)),
          })
          const operation = yield* attachment.authorize({
            access: 'write',
            effect: 'native-file-write',
            within: writer.grant,
            path,
            cwd: context.cwd,
          })
          if (operation.kind !== 'ready')
            return yield* hostFailure('the workspace changed before the native write was admitted')
          yield* nativeWrites
            .admit({ toolCallId: event.toolCallId, attachment, grant: operation.grant })
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
        }).pipe(
          Effect.catchCause(cause =>
            Effect.succeed<ToolCallEventResult>({
              block: true,
              reason: `Native ${event.toolName} was not executed: ${formatError(Cause.squash(cause))}`,
            })
          )
        )
      })

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
          return admitRead(event.toolCallId, context)
        case 'workspace-shell':
          return Effect.map(admitWriter(context), writer =>
            'refusal' in writer ? writer.refusal : undefined
          )
        case 'native-write':
          return admitNativeWrite(event, context)
        default: {
          const exhaustive: never = effect
          return exhaustive
        }
      }
    }

    const attachForManager = (
      manager: SessionManager,
      cwd: string,
      existing?: WorkspaceAttachment
    ) =>
      Effect.gen(function* () {
        const conversation = yield* workspaceConversation(manager, options.dataHome)
        const attachment = existing ?? (yield* options.lifecycle.attach({ conversation, cwd }))
        if (attachment !== activeAttachment) preparedAttachments.add(attachment)
        const effectiveCwd = attachment.binding.cwd
        let reopened = manager
        if (
          resolve(effectiveCwd) !== resolve(cwd) ||
          resolve(manager.getCwd()) !== resolve(effectiveCwd)
        )
          reopened = options.openSessionManager(conversation.sessionFile, effectiveCwd)
        if (
          reopened.getSessionId() !== conversation.sessionId ||
          resolve(reopened.getSessionFile() ?? '') !== resolve(conversation.sessionFile)
        )
          return yield* hostFailure('Reopened Pi SessionManager changed conversation identity')
        return { attachment, manager: reopened, cwd: effectiveCwd }
      })

    const prepareRuntime = (input: {
      readonly sessionManager: SessionManager
      readonly cwd: string
    }) =>
      Effect.gen(function* () {
        runtimePreparationSerial += 1
        const file = input.sessionManager.getSessionFile()
        if (!file)
          return yield* hostFailure('Workspace-bound runtime requires a persisted Pi session file')
        let manager = input.sessionManager
        const id = manager.getSessionId()
        const key = sessionKey(file, id)
        const reopenTarget = pendingReopen
        const reopen =
          reopenTarget !== undefined &&
          resolve(reopenTarget.sessionFile) === resolve(file) &&
          reopenTarget.sessionId === id
        if (reopen) {
          manager = options.openSessionManager(file, input.cwd)
          if (
            manager.getSessionId() !== id ||
            resolve(manager.getSessionFile() ?? '') !== resolve(file) ||
            manager.getEntries().length < reopenTarget.minimumEntries
          )
            return yield* hostFailure(
              'Same-file workspace rebind did not reopen the settled outgoing Pi session'
            )
        }
        const staged = stagedAttachments.get(key)
        const canReuse =
          !reopen &&
          !staged &&
          activeConversation.sessionId === id &&
          resolve(activeConversation.sessionFile) === resolve(file)
        const resolved = yield* attachForManager(
          manager,
          input.cwd,
          staged ?? (canReuse ? activeAttachment : undefined)
        )
        if (staged) stagedAttachments.delete(key)
        if (!canReuse && activeConversation.sessionId !== id) parked = true
        return {
          attachment: resolved.attachment,
          sessionManager: resolved.manager,
          cwd: resolved.cwd,
        }
      })

    const commitRuntime = (attachment: WorkspaceAttachment) =>
      Effect.gen(function* () {
        const previous = activeAttachment
        const nextIdentity = attachment.binding.conversation
        preparedAttachments.delete(attachment)
        const sameConversation =
          activeConversation.sessionId === nextIdentity.sessionId &&
          resolve(activeConversation.sessionFile) === resolve(nextIdentity.sessionFile)
        activeAttachment = attachment
        activeConversation = nextIdentity
        activeManager = runtime?.session.sessionManager
        if (previous !== attachment && !sameConversation) yield* closeAttachmentOnce(previous)
        if (!pending && parked) {
          const expectedId = nextIdentity.sessionId
          setImmediate(() => {
            if (
              !pending &&
              activeConversation.sessionId === expectedId &&
              runtime?.session.sessionManager.getSessionId() === expectedId
            )
              parked = false
          })
        }
      })

    // Wraps Pi's own session switching (`/resume`, `/new`, `/fork`), so the target
    // conversation is attached to the authority before Pi replaces the runtime.
    const switchSession = (
      rawSwitch: AgentSessionRuntime['switchSession'],
      sessionFile: string,
      switchOptions: Parameters<AgentSessionRuntime['switchSession']>[1]
    ) =>
      Effect.gen(function* () {
        if (invokingHandoffSwitch) return yield* fromPi(() => rawSwitch(sessionFile, switchOptions))
        if (parked || pending) return { cancelled: true }
        const previousSerial = runtimePreparationSerial
        let staged: WorkspaceAttachment | undefined
        let stagedKey: string | undefined
        let targetFile: string | undefined
        let targetId: string | undefined
        let replacementStarted = false
        const clearReopen = () => {
          if (
            targetId !== undefined &&
            targetFile !== undefined &&
            pendingReopen?.sessionId === targetId &&
            resolve(pendingReopen.sessionFile) === resolve(targetFile)
          )
            pendingReopen = undefined
        }
        return yield* Effect.gen(function* () {
          const targetManager = options.openSessionManager(sessionFile)
          const capturedTrustContext = currentContext
            ? projectTrustContextFromExtension(currentContext, targetManager.getCwd())
            : undefined
          const file = targetManager.getSessionFile()
          if (!file) return yield* fromPi(() => rawSwitch(sessionFile, switchOptions))
          const id = targetManager.getSessionId()
          targetFile = file
          targetId = id
          stagedKey = sessionKey(file, id)
          const sameConversation =
            activeConversation.sessionId === id &&
            resolve(activeConversation.sessionFile) === resolve(file)
          if (sameConversation) {
            notify(
              currentContext,
              'This Pi conversation is already active; its workspace binding is unchanged.'
            )
            return { cancelled: true }
          }
          if (resolve(activeConversation.sessionFile) === resolve(file))
            pendingReopen = {
              sessionFile: file,
              sessionId: id,
              minimumEntries: targetManager.getEntries().length,
            }
          // Nothing has changed before Pi's own switch, so a refusal here is reported and the
          // switch cancelled; Pi treats a rejected switch as fatal and exits.
          const attached = yield* Effect.exit(
            workspaceConversation(targetManager, options.dataHome).pipe(
              Effect.flatMap(conversation =>
                options.lifecycle.attach({ conversation, cwd: targetManager.getCwd() })
              )
            )
          )
          if (Exit.isFailure(attached)) {
            clearReopen()
            notify(
              currentContext,
              `The session was not switched: ${formatError(Cause.squash(attached.cause))}`,
              'warning'
            )
            return { cancelled: true }
          }
          const prepared = attached.value
          staged = prepared
          stagedAttachments.set(stagedKey, prepared)
          parked = true
          replacementStarted = true
          const result = yield* fromPi(() =>
            rawSwitch(sessionFile, {
              ...switchOptions,
              cwdOverride: prepared.binding.cwd,
              projectTrustContextFactory:
                switchOptions?.projectTrustContextFactory ??
                (cwd =>
                  capturedTrustContext
                    ? { ...capturedTrustContext, cwd }
                    : noUiProjectTrustContext(cwd)),
            })
          )
          if (result.cancelled) {
            if (runtimePreparationSerial === previousSerial && staged) {
              stagedAttachments.delete(stagedKey)
              yield* closeAttachmentOnce(staged)
              parked = false
              clearReopen()
            } else {
              parked = true
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
                // Once Pi's replacement has been invoked, an exception does not prove
                // whether outgoing shutdown or target runtime construction happened.
                // Preserve both sides and require explicit recovery.
                parked = true
              } else if (runtimePreparationSerial === previousSerial && staged && stagedKey) {
                stagedAttachments.delete(stagedKey)
                yield* Effect.ignore(closeAttachmentOnce(staged))
                parked = false
                clearReopen()
              } else if (runtimePreparationSerial === previousSerial) {
                parked = false
                clearReopen()
              } else {
                parked = true
              }
            })
          )
        )
      })

    const close = Effect.gen(function* () {
      if (closed) return
      closed = true
      if (pending?.switchStarted) return
      yield* nativeWrites.settle
      yield* shell.stop
      for (const attachment of stagedAttachments.values()) yield* closeAttachmentOnce(attachment)
      stagedAttachments.clear()
      for (const attachment of preparedAttachments) yield* closeAttachmentOnce(attachment)
      preparedAttachments.clear()
      yield* closeAttachmentOnce(activeAttachment)
    })

    const sessionShutdown = (reason: string) =>
      Effect.gen(function* () {
        yield* nativeWrites.settle
        if (reason !== 'reload') yield* shell.stop
        if (reason !== 'quit' || pending?.switchStarted) return
        if (pending && !pending.switchStarted) {
          const withdrawn = yield* Effect.exit(
            pending.transitionSource
              .handoff(pending.handoff, () => Effect.succeed('cancelled' as const))
              .pipe(Effect.catchIf(isWithdrawn, () => Effect.void))
          )
          if (Exit.isFailure(withdrawn)) {
            parked = true
            notify(
              currentContext,
              `Pending workspace handoff could not be cancelled safely. ${formatError(Cause.squash(withdrawn.cause))}`,
              'error'
            )
            return
          }
          pending = undefined
          parked = false
        }
        yield* closeAttachmentOnce(activeAttachment)
      })

    const resumeInTui = (
      command: Extract<ReturnType<typeof parseWorkspaceCommand>, { kind: 'resume' }>,
      context: ExtensionCommandContext
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (parked || pending) {
          notify(
            context,
            'Workspace host is already parked or an earlier transition is unresolved; no second switch was started.',
            'error'
          )
          return
        }
        const inspected = yield* Effect.exit(options.lifecycle.inspect({ taskId: command.taskId }))
        if (Exit.isFailure(inspected)) {
          notify(
            context,
            `Workspace inspection failed: ${formatError(Cause.squash(inspected.cause))}`,
            'error'
          )
          return
        }
        const views = inspected.value
        const candidates = resumeCandidates(views, command.taskId)
        let candidate: ResumeCandidate | undefined
        if (command.workspaceId) {
          const { workspaceId } = command
          const chosen = yield* Effect.exit(
            attemptCommand(() => chooseResumeCandidate(views, command.taskId, workspaceId))
          )
          if (Exit.isFailure(chosen)) {
            notify(context, formatError(Cause.squash(chosen.cause)), 'error')
            return
          }
          candidate = chosen.value
        } else if (candidates.length === 1) {
          candidate = candidates[0]
        } else if (candidates.length > 1) {
          const selected = yield* Effect.promise(() =>
            context.ui.select(
              `Choose the exact retained workspace for task ${command.taskId}`,
              candidates.map(
                entry => `${entry.view.workspaceId} — ${entry.view.path} (${entry.view.origin})`
              )
            )
          )
          if (!selected) return
          const workspaceId = selected.slice(0, selected.indexOf(' — '))
          candidate = candidates.find(entry => entry.view.workspaceId === workspaceId)
          if (!candidate) {
            notify(
              context,
              'Workspace selection did not match an exact candidate; no switch was started.',
              'error'
            )
            return
          }
        } else {
          const chosen = yield* Effect.exit(
            attemptCommand(() => chooseResumeCandidate(views, command.taskId))
          )
          if (Exit.isFailure(chosen))
            notify(context, formatError(Cause.squash(chosen.cause)), 'error')
          return
        }

        const current = activeAttachment.binding
        if (
          candidate.view.workspaceId === current.workspaceId &&
          current.taskId === command.taskId
        ) {
          notify(
            context,
            `Task ${command.taskId} is already bound to workspace ${candidate.view.workspaceId}.`,
            'info'
          )
          return
        }

        const controls = workControls
        const activeWork =
          controls === undefined ? [] : yield* Effect.promise(() => controls.running())
        const liveShells = shell.live()
        if (activeWork.length > 0 || liveShells > 0) {
          const details = [
            ...activeWork.map(
              work =>
                `- ${work.kind} task=${work.taskId} attempt=${work.attemptId} status=${work.status} cwd=${work.cwd}`
            ),
            ...(liveShells > 0
              ? [`- ${liveShells} shell process group(s) started by this conversation`]
              : []),
          ].join('\n')
          const confirmed = yield* Effect.promise(() =>
            context.ui.confirm(
              "Switch workspace and stop this conversation's session-owned work?",
              `The old Pi session must shut down before rebinding. Its session-owned work will be closed; reservations and uncertain workspace observations remain recorded. This does not cancel by aborting the agent turn, and no tool payload will be replayed.\n\n${details}`
            )
          )
          if (!confirmed) return
          const stopped = yield* Effect.exit(
            Effect.gen(function* () {
              if (controls !== undefined)
                yield* fromPi(() => controls.stopAll('workspace switch confirmed'))
              yield* shell.stop
            })
          )
          if (Exit.isFailure(stopped)) {
            notify(
              context,
              `Session-owned work could not be stopped, so no switch was started: ${formatError(Cause.squash(stopped.cause))}`,
              'error'
            )
            return
          }
        }

        const selected = yield* Effect.exit(activeAttachment.select(candidate.selection))
        if (Exit.isFailure(selected)) {
          notify(
            context,
            `Workspace selection was rejected: ${formatError(Cause.squash(selected.cause))}`,
            'error'
          )
          return
        }
        parked = true
        const transition: PendingTransition = {
          handoff: selected.value,
          origin: 'command',
          context,
          transitionSource: activeAttachment,
          scheduled: true,
          switchStarted: false,
          capturedInput: false,
        }
        pending = transition
        capturePendingInput(context)
        yield* performPendingHandoff(transition)
      })

    const workspaceCommand = (api: ExtensionAPI, args: string, context: ExtensionCommandContext) =>
      Effect.gen(function* () {
        const command = yield* attemptCommand(() =>
          parseWorkspaceCommand(args.trim() ? args.trim().split(/\s+/) : [])
        )
        if (command.kind === 'resume') return yield* resumeInTui(command, context)
        const repositoryRoot =
          command.kind === 'list' ? yield* options.repositoryRoot(context.cwd) : undefined
        if (command.kind === 'list' && repositoryRoot === undefined) {
          display(
            api,
            context,
            'Workspace list requires a Git repository; switch to a Git checkout before listing.'
          )
          return
        }
        const views = yield* options.lifecycle.inspect(
          command.kind === 'inspect' ? { taskId: command.taskId } : { cwd: repositoryRoot! }
        )
        display(
          api,
          context,
          command.kind === 'inspect'
            ? formatWorkspaceInspect(views, command.taskId)
            : formatWorkspaceList(views, repositoryRoot!, {
                currentWorkspaceId: activeAttachment.binding.workspaceId,
                effectiveCwd: context.cwd,
              })
        )
      }).pipe(
        Effect.catch(error =>
          Effect.sync(() =>
            display(
              api,
              context,
              error instanceof WorkspaceCommandError
                ? error.message
                : `Workspace command failed: ${formatError(error)}`
            )
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
      isParked: () => parked,
      prepareRuntime: input => runPromise(prepareRuntime(input)),
      commitRuntime: attachment => runPromise(commitRuntime(attachment)),
      bindRuntime(nextRuntime) {
        runtime = nextRuntime
        activeManager = nextRuntime.session.sessionManager
        const rawSwitch = nextRuntime.switchSession.bind(nextRuntime)
        nextRuntime.switchSession = (sessionFile, switchOptions) =>
          runPromise(switchSession(rawSwitch, sessionFile, switchOptions))
      },
      setWorkControls(controls) {
        workControls = controls
      },
      close,
      extensionFactory(api) {
        currentApi = api
        api.on('session_start', (_event, context) => {
          currentContext = context
          if (
            activeAttachment.binding.conversation.sessionId ===
            context.sessionManager.getSessionId()
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
            Effect.map(authorization(context, 'write', event.cwd, false, 'user-bash'), admitted =>
              admitted.grant
                ? { operations: shell.operations }
                : {
                    result: {
                      output: admitted.blocked,
                      exitCode: 1,
                      cancelled: false,
                      truncated: false,
                    },
                  }
            )
          )
        )

        api.on('turn_end', (_event, context) => {
          if (!pending || pending.origin !== 'tool-call') return
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
            command.startsWith('/workspace inspect ')
          )
            return
          if (command === '/quit' || command === '/exit') return
          preservedInput.push(event.text)
          return { action: 'handled' }
        })

        api.on('session_shutdown', event => runPromise(sessionShutdown(event.reason)))

        api.registerCommand('workspace', {
          description: 'List, inspect, or resume an exact workspace task',
          handler: (args, context) => runPromise(workspaceCommand(api, args, context)),
        })
      },
    }
  })
