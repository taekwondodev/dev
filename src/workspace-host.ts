import { Effect, Exit, Scope } from 'effect'
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
import { decodeWriteOperand } from './workspace-paths.ts'
import { makeNativeWrites } from './workspace-native-write.ts'
import { makeWorkspaceShell } from './workspace-shell.ts'
import type { BashOperations } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js'
import type { EditOperations } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit.js'
import type { WriteOperations } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/write.js'
import {
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
  type HostReplace,
  type WorkspaceAttachment,
  type WorkspaceConversation,
  type WorkspaceGrant,
  type WorkspaceHandoff,
  type WorkspaceLifecycle,
  type WorkspaceView,
} from './workspace-domain.ts'

// Transitional bridge while this host still runs on Promises.
const run = <A>(effect: Effect.Effect<A, WorkspaceError>): Promise<A> => Effect.runPromise(effect)
const replaceWith =
  (replace: (target: WorkspaceGrant) => Promise<'confirmed' | 'cancelled'>): HostReplace =>
  target =>
    Effect.promise(() => replace(target))

export interface WorkspaceHostOptions {
  readonly lifecycle: WorkspaceLifecycle
  readonly attachment: WorkspaceAttachment
  readonly dataHome: string
  readonly openSessionManager: (sessionFile: string, cwdOverride?: string) => SessionManager
  readonly repositoryRoot: (cwd: string) => Promise<string | undefined>
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
  close(): Promise<void>
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

// The authority answers `blocked` to a switch it refused before the host acted, having
// already withdrawn it and kept the last confirmed binding.
const tolerateWithdrawn = (error: unknown): void => {
  if (!(error instanceof WorkspaceError && error.outcome === 'blocked')) throw error
}

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

function workspaceConversation(manager: SessionManager, dataHome: string): WorkspaceConversation {
  const sessionFile = manager.getSessionFile()
  if (!sessionFile)
    throw new Error('Workspace-bound conversations require a persisted Pi session file')
  return { sessionId: manager.getSessionId(), sessionFile, dataHome }
}

export function createWorkspaceHost(options: WorkspaceHostOptions): WorkspaceHost {
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
    | { readonly sessionFile: string; readonly sessionId: string; readonly minimumEntries: number }
    | undefined
  const stagedAttachments = new Map<string, WorkspaceAttachment>()
  const preparedAttachments = new Set<WorkspaceAttachment>()
  const closedAttachments = new WeakSet<WorkspaceAttachment>()
  const preservedInput: string[] = []
  const readerWarnings = new Map<string, string>()
  let writerWarned = false
  const nativeWrites = makeNativeWrites(message => notify(currentContext, message, 'error'))

  const shellScope = Scope.makeUnsafe()
  const shell = Effect.runSync(
    Scope.provide(shellScope)(
      makeWorkspaceShell(cwd =>
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
    )
  )

  const closeAttachmentOnce = async (attachment: WorkspaceAttachment): Promise<void> => {
    if (closedAttachments.has(attachment)) return
    closedAttachments.add(attachment)
    await run(attachment.close)
  }

  const notify = (
    context: ExtensionContext | undefined,
    message: string,
    level: 'info' | 'warning' | 'error' = 'info'
  ) => {
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

  const contextForCwd = (context: ExtensionContext | undefined, cwd: string): ProjectTrustContext =>
    context ? projectTrustContextFromExtension(context, cwd) : noUiProjectTrustContext(cwd)

  const currentSessionIdentity = (): { readonly file: string; readonly id: string } => {
    const manager = runtime?.session.sessionManager ?? activeManager
    const sessionFile = manager?.getSessionFile()
    if (!manager || !sessionFile) throw new Error('Active Pi runtime has no persisted session file')
    return { file: sessionFile, id: manager.getSessionId() }
  }

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

  const scheduleHandoff = (transition: PendingTransition): void => {
    if (transition.scheduled) return
    transition.scheduled = true
    setImmediate(() => {
      void performPendingHandoff(transition)
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

  const assertSessionIdle = async (): Promise<void> => {
    if (!runtime) throw new Error('No active Pi runtime is available for workspace handoff')
    const session = runtime.session
    await session.waitForIdle()
    if (!session.isIdle || session.pendingMessageCount !== 0 || session.isBashRunning) {
      throw new Error('Pi did not reach an idle, settled boundary; workspace host remains parked')
    }
  }

  const performPendingHandoff = async (transition: PendingTransition): Promise<void> => {
    if (pending !== transition || transition.switchStarted) return
    let handoffCalled = false
    try {
      capturePendingInput(transition.context)
      await assertSessionIdle()
      await Effect.runPromise(shell.stop)
      const identity = currentSessionIdentity()
      const minimumEntries = runtime?.session.sessionManager.getEntries().length ?? 0
      pendingReopen = {
        sessionFile: identity.file,
        sessionId: identity.id,
        minimumEntries,
      }
      let callbackResult: 'confirmed' | 'cancelled' | undefined
      handoffCalled = true
      await run(
        transition.transitionSource.handoff(
          transition.handoff,
          replaceWith(async target => {
            transition.switchStarted = true
            const currentRuntime = runtime
            if (!currentRuntime)
              throw new Error('Pi runtime disappeared before workspace replacement')
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
            let result: { readonly cancelled: boolean }
            invokingHandoffSwitch = true
            try {
              result = await currentRuntime.switchSession(identity.file, {
                cwdOverride: target.cwd,
                projectTrustContextFactory: cwd => ({ ...trustSnapshot, cwd }),
                withSession,
              })
            } finally {
              invokingHandoffSwitch = false
            }
            if (result.cancelled) {
              callbackResult = 'cancelled'
              return 'cancelled'
            }
            const current = activeAttachment.binding
            if (
              current.conversation.sessionId !== identity.id ||
              resolve(current.conversation.sessionFile) !== resolve(identity.file) ||
              current.workspaceId !== target.workspaceId ||
              resolve(current.cwd) !== resolve(target.cwd) ||
              resolve(currentRuntime.cwd) !== resolve(target.cwd)
            ) {
              throw new Error(
                'Pi replacement completed without the authority-selected workspace binding'
              )
            }
            callbackResult = 'confirmed'
            return 'confirmed'
          })
        )
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
      if (callbackResult !== 'confirmed') {
        throw new Error('Workspace authority returned without a confirmed replacement result')
      }
      if (transition.transitionSource !== activeAttachment) {
        await closeAttachmentOnce(transition.transitionSource)
      }
      pending = undefined
      parked = false
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
    } catch (error) {
      if (!transition.switchStarted) {
        // The host never acted, so the authority can keep the last confirmed binding.
        try {
          if (handoffCalled) tolerateWithdrawn(error)
          else
            await run(
              transition.transitionSource.handoff(transition.handoff, () =>
                Effect.succeed('cancelled' as const)
              )
            ).catch(tolerateWithdrawn)
          pendingReopen = undefined
          pending = undefined
          parked = false
          restoreInput(transition.context)
          notify(
            transition.context,
            `Workspace switch was not performed; the current workspace is kept. ${formatError(error)}`,
            'warning'
          )
          return
        } catch (cancelError) {
          process.stderr.write(
            `Workspace handoff could not be withdrawn; this session remains parked. ${formatError(cancelError)}\n`
          )
          return
        }
      }
      process.stderr.write(
        `Workspace handoff is unresolved; this session remains parked. ${formatError(error)}\n`
      )
    }
  }

  const authorization = async (
    context: ExtensionContext,
    access: 'read' | 'write',
    cwd: string,
    delegated = false,
    origin: 'tool-call' | 'user-bash' = 'tool-call'
  ): Promise<
    | { readonly grant: WorkspaceGrant; readonly warning?: string; readonly blocked?: undefined }
    | { readonly grant?: undefined; readonly blocked: string }
  > => {
    if (parked)
      return { blocked: 'Workspace host is parked during a transition; no operation started.' }
    try {
      const result = await run(
        activeAttachment.authorize({
          access,
          cwd,
          ...(delegated ? { delegated: true } : {}),
        })
      )
      if (result.kind === 'rebind') {
        requestHandoff(result.handoff, origin, context, origin === 'user-bash')
        return {
          blocked: `Workspace admission requires a host rebind: ${result.handoff.reason}. The operation was not executed.`,
        }
      }
      return { grant: result.grant, ...(result.warning ? { warning: result.warning } : {}) }
    } catch (error) {
      return { blocked: `Workspace admission failed closed: ${formatError(error)}` }
    }
  }

  const validateNativeGrant = (
    grant: WorkspaceGrant,
    context: ExtensionContext,
    access: WorkspaceGrant['access']
  ): string | undefined => {
    const binding = activeAttachment.binding
    if (grant.access !== access) {
      return `Workspace authority returned ${grant.access} access for a ${access} operation; the Pi tool was not executed.`
    }
    if (grant.workspaceId !== binding.workspaceId || resolve(grant.cwd) !== resolve(context.cwd)) {
      return `Workspace authority returned ${grant.workspaceId} at ${grant.cwd}, but Pi is still bound to ${binding.workspaceId} at ${context.cwd}; the native tool was not executed.`
    }
    return undefined
  }

  const admitWriter = async (
    context: ExtensionContext
  ): Promise<{ readonly grant: WorkspaceGrant } | { readonly refusal: ToolCallEventResult }> => {
    const admitted = await authorization(context, 'write', context.cwd)
    if (!admitted.grant)
      return { refusal: { block: true, terminate: true, reason: admitted.blocked } }
    const mismatch = validateNativeGrant(admitted.grant, context, 'write')
    if (mismatch) {
      parked = true
      return { refusal: { block: true, terminate: true, reason: mismatch } }
    }
    return { grant: admitted.grant }
  }

  const admitRead = async (
    toolCallId: string,
    context: ExtensionContext
  ): Promise<ToolCallEventResult | undefined> => {
    const admitted = await authorization(context, 'read', context.cwd)
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

  const admitNativeWrite = async (
    event: HostToolCallEvent,
    context: ExtensionContext
  ): Promise<ToolCallEventResult | undefined> => {
    const writer = await admitWriter(context)
    if ('refusal' in writer) return writer.refusal
    try {
      const path = decodeWriteOperand(event.input)
      const operation = await run(
        activeAttachment.authorize({
          access: 'write',
          effect: 'native-file-write',
          within: writer.grant,
          path,
          cwd: context.cwd,
        })
      )
      if (operation.kind !== 'ready')
        throw new Error('the workspace changed before the native write was admitted')
      try {
        await Effect.runPromise(
          nativeWrites.admit({
            toolCallId: event.toolCallId,
            attachment: activeAttachment,
            grant: operation.grant,
          })
        )
      } catch (error) {
        await run(
          activeAttachment.reportExecution(operation.grant, { kind: 'operation-completed' })
        ).catch((settleError: unknown) =>
          notify(
            context,
            `Refused native ${event.toolName} could not be settled: ${formatError(settleError)}`,
            'error'
          )
        )
        throw error
      }
    } catch (error) {
      return {
        block: true,
        reason: `Native ${event.toolName} was not executed: ${formatError(error)}`,
      }
    }
    return undefined
  }

  const safeToolCall = async (
    api: ExtensionAPI,
    event: HostToolCallEvent,
    context: ExtensionContext
  ): Promise<ToolCallEventResult | undefined> => {
    if (parked)
      return {
        block: true,
        terminate: true,
        reason: 'Workspace host is parked; stale tools are blocked.',
      }
    const effect = toolEffect(getToolInfo(api, event.toolName))
    switch (effect) {
      case undefined:
        return {
          block: true,
          reason: `Tool ${event.toolName} has no verified workspace effect in dev, so it was not executed. A supported extension must have its project effects reviewed and recorded first (ADR 0005).`,
        }
      case 'work-owner':
        return undefined
      case 'read':
        return admitRead(event.toolCallId, context)
      case 'workspace-shell': {
        const writer = await admitWriter(context)
        return 'refusal' in writer ? writer.refusal : undefined
      }
      case 'native-write':
        return admitNativeWrite(event, context)
      default: {
        const exhaustive: never = effect
        return exhaustive
      }
    }
  }

  const attachForManager = async (
    manager: SessionManager,
    cwd: string,
    existing?: WorkspaceAttachment
  ): Promise<{
    readonly attachment: WorkspaceAttachment
    readonly manager: SessionManager
    readonly cwd: string
  }> => {
    const conversation = workspaceConversation(manager, options.dataHome)
    const attachment = existing ?? (await run(options.lifecycle.attach({ conversation, cwd })))
    if (attachment !== activeAttachment) preparedAttachments.add(attachment)
    const effectiveCwd = attachment.binding.cwd
    if (
      resolve(effectiveCwd) !== resolve(cwd) ||
      resolve(manager.getCwd()) !== resolve(effectiveCwd)
    ) {
      manager = options.openSessionManager(conversation.sessionFile, effectiveCwd)
    }
    if (
      manager.getSessionId() !== conversation.sessionId ||
      resolve(manager.getSessionFile() ?? '') !== resolve(conversation.sessionFile)
    ) {
      throw new Error('Reopened Pi SessionManager changed conversation identity')
    }
    return { attachment, manager, cwd: effectiveCwd }
  }

  const host: WorkspaceHost = {
    get attachment() {
      return activeAttachment
    },
    shellOperations: shell.operations,
    writeOperations: nativeWrites.writeOperations,
    editOperations: nativeWrites.editOperations,
    isParked: () => parked,
    async prepareRuntime(input) {
      runtimePreparationSerial += 1
      const file = input.sessionManager.getSessionFile()
      if (!file) throw new Error('Workspace-bound runtime requires a persisted Pi session file')
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
        ) {
          throw new Error(
            'Same-file workspace rebind did not reopen the settled outgoing Pi session'
          )
        }
      }
      const staged = stagedAttachments.get(key)
      const canReuse =
        !reopen &&
        !staged &&
        activeConversation.sessionId === id &&
        resolve(activeConversation.sessionFile) === resolve(file)
      const resolved = await attachForManager(
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
    },
    async commitRuntime(attachment) {
      const previous = activeAttachment
      const nextIdentity = attachment.binding.conversation
      preparedAttachments.delete(attachment)
      const sameConversation =
        activeConversation.sessionId === nextIdentity.sessionId &&
        resolve(activeConversation.sessionFile) === resolve(nextIdentity.sessionFile)
      activeAttachment = attachment
      activeConversation = nextIdentity
      activeManager = runtime?.session.sessionManager
      if (previous !== attachment && !sameConversation) await closeAttachmentOnce(previous)
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
    },
    bindRuntime(nextRuntime) {
      runtime = nextRuntime
      activeManager = nextRuntime.session.sessionManager
      const rawSwitch = nextRuntime.switchSession.bind(nextRuntime)
      nextRuntime.switchSession = async (sessionFile, switchOptions) => {
        if (invokingHandoffSwitch) return rawSwitch(sessionFile, switchOptions)
        if (parked || pending) return { cancelled: true }
        const previousSerial = runtimePreparationSerial
        let staged: WorkspaceAttachment | undefined
        let stagedKey: string | undefined
        let targetFile: string | undefined
        let targetId: string | undefined
        let replacementStarted = false
        try {
          const targetManager = options.openSessionManager(sessionFile)
          const capturedTrustContext = currentContext
            ? projectTrustContextFromExtension(currentContext, targetManager.getCwd())
            : undefined
          const file = targetManager.getSessionFile()
          if (!file) return rawSwitch(sessionFile, switchOptions)
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
          const sameSessionFile = resolve(activeConversation.sessionFile) === resolve(file)
          if (sameSessionFile) {
            pendingReopen = {
              sessionFile: file,
              sessionId: id,
              minimumEntries: targetManager.getEntries().length,
            }
          }
          const prepared = await run(
            options.lifecycle.attach({
              conversation: workspaceConversation(targetManager, options.dataHome),
              cwd: targetManager.getCwd(),
            })
          )
          staged = prepared
          stagedAttachments.set(stagedKey, prepared)
          parked = true
          replacementStarted = true
          const result = await rawSwitch(sessionFile, {
            ...switchOptions,
            cwdOverride: prepared.binding.cwd,
            projectTrustContextFactory:
              switchOptions?.projectTrustContextFactory ??
              (cwd =>
                capturedTrustContext
                  ? { ...capturedTrustContext, cwd }
                  : noUiProjectTrustContext(cwd)),
          })
          if (result.cancelled) {
            if (runtimePreparationSerial === previousSerial && staged) {
              stagedAttachments.delete(stagedKey)
              await closeAttachmentOnce(staged)
              parked = false
              if (
                pendingReopen?.sessionId === id &&
                resolve(pendingReopen.sessionFile) === resolve(file)
              )
                pendingReopen = undefined
            } else {
              parked = true
            }
          } else if (!pending) {
            parked = false
            if (
              pendingReopen?.sessionId === id &&
              resolve(pendingReopen.sessionFile) === resolve(file)
            )
              pendingReopen = undefined
          }
          return result
        } catch (error) {
          if (replacementStarted) {
            // Once Pi's replacement has been invoked, an exception does not
            // prove whether outgoing shutdown or target runtime construction
            // happened. Preserve both sides and require explicit recovery.
            parked = true
          } else if (runtimePreparationSerial === previousSerial && staged && stagedKey) {
            stagedAttachments.delete(stagedKey)
            await closeAttachmentOnce(staged)
            parked = false
            if (
              targetId !== undefined &&
              targetFile !== undefined &&
              pendingReopen?.sessionId === targetId &&
              resolve(pendingReopen.sessionFile) === resolve(targetFile)
            )
              pendingReopen = undefined
          } else if (runtimePreparationSerial === previousSerial) {
            parked = false
            if (
              targetId !== undefined &&
              targetFile !== undefined &&
              pendingReopen?.sessionId === targetId &&
              resolve(pendingReopen.sessionFile) === resolve(targetFile)
            )
              pendingReopen = undefined
          } else {
            parked = true
          }
          throw error
        }
      }
    },
    setWorkControls(controls) {
      workControls = controls
    },
    async close() {
      if (closed) return
      closed = true
      if (pending?.switchStarted) return
      await Effect.runPromise(nativeWrites.settle)
      await Effect.runPromise(shell.stop)
      await Effect.runPromise(Scope.close(shellScope, Exit.void))
      for (const attachment of stagedAttachments.values()) await closeAttachmentOnce(attachment)
      stagedAttachments.clear()
      for (const attachment of preparedAttachments) await closeAttachmentOnce(attachment)
      preparedAttachments.clear()
      await closeAttachmentOnce(activeAttachment)
    },
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

      api.on('tool_call', (event, context) => safeToolCall(api, event, context))

      api.on('tool_execution_end', async event => {
        await Effect.runPromise(nativeWrites.finish(event.toolCallId))
        readerWarnings.delete(event.toolCallId)
      })

      api.on('tool_result', event => {
        const warning = readerWarnings.get(event.toolCallId)
        if (warning === undefined) return
        readerWarnings.delete(event.toolCallId)
        return { content: [...event.content, { type: 'text', text: `[dev workspace] ${warning}` }] }
      })

      api.on('user_bash', async (event, context) => {
        const admitted = await authorization(context, 'write', event.cwd, false, 'user-bash')
        if (admitted.grant) return { operations: shell.operations }
        return {
          result: {
            output:
              admitted.blocked ?? 'Shell was not executed: workspace admission failed closed.',
            exitCode: 1,
            cancelled: false,
            truncated: false,
          },
        }
      })

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

      api.on('session_shutdown', async event => {
        await Effect.runPromise(nativeWrites.settle)
        if (event.reason !== 'reload') await Effect.runPromise(shell.stop)
        if (event.reason !== 'quit' || pending?.switchStarted) return
        if (pending && !pending.switchStarted) {
          try {
            await run(
              pending.transitionSource.handoff(pending.handoff, () =>
                Effect.succeed('cancelled' as const)
              )
            ).catch(tolerateWithdrawn)
            pending = undefined
            parked = false
          } catch (error) {
            parked = true
            notify(
              currentContext,
              `Pending workspace handoff could not be cancelled safely. ${formatError(error)}`,
              'error'
            )
            return
          }
        }
        await closeAttachmentOnce(activeAttachment)
      })

      api.registerCommand('workspace', {
        description: 'List, inspect, or resume an exact workspace task',
        handler: async (args, context) => {
          try {
            const command = parseWorkspaceCommand(args.trim() ? args.trim().split(/\s+/) : [])
            if (command.kind === 'resume') {
              await resumeInTui(command, context)
              return
            }
            const repositoryRoot =
              command.kind === 'list' ? await options.repositoryRoot(context.cwd) : undefined
            if (command.kind === 'list' && repositoryRoot === undefined) {
              display(
                api,
                context,
                'Workspace list requires a Git repository; switch to a Git checkout before listing.'
              )
              return
            }
            const views = await run(
              options.lifecycle.inspect(
                command.kind === 'inspect' ? { taskId: command.taskId } : { cwd: repositoryRoot! }
              )
            )
            const text =
              command.kind === 'inspect'
                ? formatWorkspaceInspect(views, command.taskId)
                : formatWorkspaceList(views, repositoryRoot!, {
                    currentWorkspaceId: activeAttachment.binding.workspaceId,
                    effectiveCwd: context.cwd,
                  })
            display(api, context, text)
          } catch (error) {
            const message =
              error instanceof WorkspaceCommandError
                ? error.message
                : `Workspace command failed: ${formatError(error)}`
            display(api, context, message)
          }
        },
      })
    },
  }

  async function resumeInTui(
    command: Extract<ReturnType<typeof parseWorkspaceCommand>, { kind: 'resume' }>,
    context: ExtensionCommandContext
  ): Promise<void> {
    if (parked || pending) {
      notify(
        context,
        'Workspace host is already parked or an earlier transition is unresolved; no second switch was started.',
        'error'
      )
      return
    }
    let views: readonly WorkspaceView[]
    try {
      views = await run(options.lifecycle.inspect({ taskId: command.taskId }))
    } catch (error) {
      notify(context, `Workspace inspection failed: ${formatError(error)}`, 'error')
      return
    }
    const candidates = resumeCandidates(views, command.taskId)
    let candidate: ResumeCandidate | undefined
    if (command.workspaceId) {
      try {
        candidate = chooseResumeCandidate(views, command.taskId, command.workspaceId)
      } catch (error) {
        notify(context, error instanceof Error ? error.message : String(error), 'error')
        return
      }
    } else if (candidates.length === 1) {
      candidate = candidates[0]
    } else if (candidates.length > 1) {
      const selected = await context.ui.select(
        `Choose the exact retained workspace for task ${command.taskId}`,
        candidates.map(
          entry => `${entry.view.workspaceId} — ${entry.view.path} (${entry.view.origin})`
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
      try {
        chooseResumeCandidate(views, command.taskId)
      } catch (error) {
        notify(context, error instanceof Error ? error.message : String(error), 'error')
        return
      }
      return
    }

    if (!candidate) return
    const current = activeAttachment.binding
    if (candidate.view.workspaceId === current.workspaceId && current.taskId === command.taskId) {
      notify(
        context,
        `Task ${command.taskId} is already bound to workspace ${candidate.view.workspaceId}.`,
        'info'
      )
      return
    }

    const activeWork = (await workControls?.running()) ?? []
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
      const confirmed = await context.ui.confirm(
        "Switch workspace and stop this conversation's session-owned work?",
        `The old Pi session must shut down before rebinding. Its session-owned work will be closed; reservations and uncertain workspace observations remain recorded. This does not cancel by aborting the agent turn, and no tool payload will be replayed.\n\n${details}`
      )
      if (!confirmed) return
      try {
        await workControls?.stopAll('workspace switch confirmed')
        await Effect.runPromise(shell.stop)
      } catch (error) {
        notify(
          context,
          `Session-owned work could not be stopped, so no switch was started: ${formatError(error)}`,
          'error'
        )
        return
      }
    }

    const selection = candidate.selection
    let handoff: WorkspaceHandoff
    try {
      handoff = await run(activeAttachment.select(selection))
    } catch (error) {
      notify(context, `Workspace selection was rejected: ${formatError(error)}`, 'error')
      return
    }
    parked = true
    const transition: PendingTransition = {
      handoff,
      origin: 'command',
      context,
      transitionSource: activeAttachment,
      scheduled: true,
      switchStarted: false,
      capturedInput: false,
    }
    pending = transition
    capturePendingInput(context)
    await performPendingHandoff(transition)
  }

  return host
}
