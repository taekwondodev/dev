import { Worker } from 'node:worker_threads'
import { Schema } from 'effect'
import {
  WorkspaceError,
  type WorkspaceAttachment,
  type WorkspaceAuthorization,
  type WorkspaceBinding,
  type WorkspaceConversation,
  type WorkspaceExecutionFact,
  type WorkspaceGrant,
  type WorkspaceHandoff,
  type WorkspaceLifecycle,
  type WorkspaceOperation,
  type WorkspaceSelection,
  type WorkspaceView,
} from './workspace-domain.ts'
import {
  decodeWorkspaceWorkerMessage,
  WorkspaceRpcInputSchema,
  type WorkspaceRpcInput,
  type WorkspaceRpcOperation,
  type WorkspaceRpcResults,
  type WorkspaceWorkerMessage,
} from './workspace-protocol.ts'

const RPC_TIMEOUT_MS = 60_000
const STARTUP_TIMEOUT_MS = 12_000
const CLOSE_TIMEOUT_MS = 1_000
const MAX_PENDING_REQUESTS = 64
const MAX_ATTACHMENTS = 256
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024

type WorkerPhase = 'starting' | 'ready' | 'closing' | 'closed' | 'failed'
type HostReplace = (target: WorkspaceGrant) => Promise<'confirmed' | 'cancelled'>

interface PendingRequest {
  readonly op: WorkspaceRpcOperation
  readonly resolve: (value: unknown) => void
  readonly reject: (cause: unknown) => void
  readonly timer: ReturnType<typeof setTimeout>
}

interface HostCallback {
  readonly replace: HostReplace
  invoked: boolean
  responded: boolean
}

const unavailable = (message: string): WorkspaceError =>
  new WorkspaceError({ outcome: 'unavailable', message })
const invalid = (message: string): WorkspaceError =>
  new WorkspaceError({ outcome: 'invalid', message })
const responseByteLength = (value: unknown): number => {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8')
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

class WorkspaceWorkerClient {
  private readonly worker: Worker
  private readonly pending = new Map<number, PendingRequest>()
  private readonly attachments = new Map<number, RemoteWorkspaceAttachment>()
  private readonly callbacks = new Map<number, HostCallback>()
  private readonly exitPromise: Promise<void>
  private readonly readyPromise: Promise<void>
  private resolveExit: (() => void) | undefined
  private resolveReady: (() => void) | undefined
  private rejectReady: ((cause: unknown) => void) | undefined
  private phase: WorkerPhase = 'starting'
  private nextRequestId = 0
  private nextCallbackId = 0
  private startupTimer: ReturnType<typeof setTimeout>
  private closePromise: Promise<void> | undefined

  constructor(root: string | undefined) {
    this.worker = new Worker(new URL('./workspace-worker.ts', import.meta.url), {
      workerData: root === undefined ? {} : { root },
      execArgv: process.execArgv.filter(argument => !argument.startsWith('--input-type')),
    })
    this.exitPromise = new Promise(resolve => {
      this.resolveExit = resolve
    })
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    void this.readyPromise.catch(() => undefined)
    this.startupTimer = setTimeout(
      () => this.fail(unavailable('Workspace authority worker did not become ready')),
      STARTUP_TIMEOUT_MS
    )
    this.worker.on('message', (raw: unknown) => this.onMessage(raw))
    this.worker.on('error', cause =>
      this.fail(
        unavailable(
          cause instanceof Error && cause.message.length > 0
            ? `Workspace authority worker failed: ${cause.message}`
            : 'Workspace authority worker failed'
        )
      )
    )
    this.worker.on('exit', () => this.onExit())
  }

  async request<K extends WorkspaceRpcOperation>(
    input: Extract<WorkspaceRpcInput, { readonly op: K }>,
    hostReplace?: HostReplace
  ): Promise<WorkspaceRpcResults[K]> {
    await this.readyPromise
    return this.sendRequest(input, hostReplace, false)
  }

  createCallbackId(): number {
    this.nextCallbackId += 1
    if (!Number.isSafeInteger(this.nextCallbackId)) {
      this.fail(unavailable('Workspace callback sequence exceeded its limit'))
      throw unavailable('Workspace callback sequence exceeded its limit')
    }
    return this.nextCallbackId
  }

  registerAttachment(id: number, attachment: RemoteWorkspaceAttachment): void {
    if (this.attachments.size >= MAX_ATTACHMENTS || this.attachments.has(id)) {
      this.fail(unavailable('Workspace worker returned an invalid attachment identity'))
      throw unavailable('Workspace worker returned an invalid attachment identity')
    }
    this.attachments.set(id, attachment)
  }

  forgetAttachment(id: number): void {
    this.attachments.delete(id)
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise
    this.closePromise = this.closeWorker()
    return this.closePromise
  }

  private async sendRequest<K extends WorkspaceRpcOperation>(
    input: Extract<WorkspaceRpcInput, { readonly op: K }>,
    hostReplace: HostReplace | undefined,
    duringClose: boolean
  ): Promise<WorkspaceRpcResults[K]> {
    const allowed = this.phase === 'ready' || (duringClose && this.phase === 'closing')
    if (!allowed) throw unavailable('Workspace authority worker is not available')
    if (this.pending.size >= MAX_PENDING_REQUESTS)
      throw unavailable('Workspace authority worker request limit reached')
    if (hostReplace !== undefined && input.op !== 'handoff')
      throw invalid('Host callback supplied for a non-handoff operation')

    let request: WorkspaceRpcInput
    try {
      request = Schema.decodeUnknownSync(WorkspaceRpcInputSchema)(input)
    } catch {
      throw invalid('Workspace worker request is invalid')
    }
    const id = this.nextId()
    const callbackId = request.op === 'handoff' ? request.callbackId : undefined
    if (hostReplace !== undefined && callbackId !== undefined) {
      if (this.callbacks.has(callbackId)) throw invalid('Workspace callback ID is already in use')
      this.callbacks.set(callbackId, { replace: hostReplace, invoked: false, responded: false })
    }
    const envelope = { id, request }
    if (responseByteLength(envelope) > MAX_MESSAGE_BYTES) {
      if (callbackId !== undefined) this.callbacks.delete(callbackId)
      throw invalid('Workspace worker request exceeded its size limit')
    }

    return new Promise<WorkspaceRpcResults[K]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(unavailable('Workspace worker acknowledgment was lost or timed out'))
      }, RPC_TIMEOUT_MS)
      this.pending.set(id, {
        op: request.op,
        resolve: value => resolve(value as WorkspaceRpcResults[K]),
        reject,
        timer,
      })
      try {
        // oxlint-disable-next-line unicorn(require-post-message-target-origin)
        this.worker.postMessage(envelope, [])
      } catch {
        this.fail(unavailable('Workspace authority worker could not receive a request'))
      }
    }).finally(() => {
      if (callbackId !== undefined) this.callbacks.delete(callbackId)
    })
  }

  private nextId(): number {
    this.nextRequestId += 1
    if (!Number.isSafeInteger(this.nextRequestId)) {
      this.fail(unavailable('Workspace RPC sequence exceeded its limit'))
      throw unavailable('Workspace RPC sequence exceeded its limit')
    }
    return this.nextRequestId
  }

  private onMessage(raw: unknown): void {
    if (responseByteLength(raw) > MAX_MESSAGE_BYTES) {
      this.fail(unavailable('Workspace authority worker message exceeded its size limit'))
      return
    }
    let message: WorkspaceWorkerMessage
    try {
      message = decodeWorkspaceWorkerMessage(raw)
    } catch {
      this.fail(unavailable('Workspace authority worker protocol failed'))
      return
    }
    if ('type' in message) {
      switch (message.type) {
        case 'ready':
          if (this.phase !== 'starting') {
            this.fail(unavailable('Workspace authority worker sent an unexpected ready message'))
            return
          }
          clearTimeout(this.startupTimer)
          this.phase = 'ready'
          this.resolveReady?.()
          this.resolveReady = undefined
          this.rejectReady = undefined
          return
        case 'startup-failure':
          this.fail(new WorkspaceError({ outcome: message.outcome, message: message.message }))
          return
        case 'bindings':
          if (message.updates.length > MAX_ATTACHMENTS) {
            this.fail(unavailable('Workspace worker sent too many binding updates'))
            return
          }
          for (const update of message.updates)
            this.attachments.get(update.attachmentId)?.refreshBinding(update.binding)
          return
        case 'host-callback':
          this.runHostCallback(message)
          return
        default: {
          const exhaustive: never = message
          this.fail(unavailable(`Unexpected worker message: ${String(exhaustive)}`))
          return
        }
      }
    }

    const pending = this.pending.get(message.id)
    if (pending === undefined) {
      this.fail(unavailable('Workspace worker returned an uncorrelated acknowledgment'))
      return
    }
    if (message.ok && message.op !== pending.op) {
      this.fail(unavailable('Workspace worker acknowledgment did not match its request'))
      return
    }
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (!message.ok) {
      pending.reject(new WorkspaceError({ outcome: message.outcome, message: message.message }))
      return
    }
    pending.resolve(message.value)
  }

  private runHostCallback(
    message: Extract<WorkspaceWorkerMessage, { readonly type: 'host-callback' }>
  ): void {
    const callback = this.callbacks.get(message.id)
    if (callback === undefined || callback.invoked || callback.responded) {
      this.sendCallbackResult(message.id, undefined)
      return
    }
    callback.invoked = true
    void Promise.resolve()
      .then(() => callback.replace(message.transition.target))
      .then(
        outcome => this.sendCallbackResult(message.id, outcome),
        () => this.sendCallbackResult(message.id, undefined)
      )
  }

  private sendCallbackResult(id: number, outcome: 'confirmed' | 'cancelled' | undefined): void {
    const callback = this.callbacks.get(id)
    if (callback !== undefined) {
      if (callback.responded) return
      callback.responded = true
    }
    if (this.phase !== 'ready' && this.phase !== 'closing') return
    const message = {
      type: 'callback-result' as const,
      id,
      ok: outcome !== undefined,
      ...(outcome === undefined ? {} : { outcome }),
    }
    if (responseByteLength(message) > MAX_MESSAGE_BYTES) {
      this.fail(unavailable('Workspace callback response exceeded its size limit'))
      return
    }
    try {
      // oxlint-disable-next-line unicorn(require-post-message-target-origin)
      this.worker.postMessage(message, [])
    } catch {
      this.fail(unavailable('Workspace worker could not receive its callback result'))
    }
  }

  private interruptHostCallbacks(): void {
    for (const [id, callback] of this.callbacks) {
      if (callback.invoked && !callback.responded) this.sendCallbackResult(id, undefined)
    }
  }

  private async closeWorker(): Promise<void> {
    if (this.phase === 'starting') await this.readyPromise.catch(() => undefined)
    if (this.phase === 'failed' || this.phase === 'closed') {
      await this.exitPromise
      return
    }
    if (this.phase !== 'ready') {
      await this.exitPromise
      return
    }
    this.phase = 'closing'
    this.interruptHostCallbacks()
    try {
      await this.sendRequest({ op: 'close' }, undefined, true)
      await this.waitForExit()
    } catch (cause) {
      await this.terminate()
      throw cause
    }
  }

  private async waitForExit(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.exitPromise,
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, CLOSE_TIMEOUT_MS)
        }),
      ])
      if (this.phase === 'closing') await this.terminate()
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private async terminate(): Promise<void> {
    if (this.phase !== 'closed') {
      try {
        await this.worker.terminate()
      } catch {
        /* worker exit is the cleanup boundary */
      }
    }
    this.phase = 'closed'
    await this.exitPromise
  }

  private fail(cause: unknown): void {
    if (this.phase === 'failed' || this.phase === 'closed') return
    const wasStarting = this.phase === 'starting'
    this.phase = 'failed'
    clearTimeout(this.startupTimer)
    if (wasStarting) this.rejectReady?.(cause)
    this.resolveReady = undefined
    this.rejectReady = undefined
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(cause)
    }
    this.pending.clear()
    this.callbacks.clear()
    void this.worker.terminate()
  }

  private onExit(): void {
    if (this.phase !== 'closing' && this.phase !== 'closed' && this.phase !== 'failed')
      this.fail(unavailable('Workspace authority worker exited unexpectedly'))
    else if (this.pending.size > 0) {
      const cause = unavailable('Workspace worker exited before acknowledging its request')
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(cause)
      }
      this.pending.clear()
    }
    this.phase = 'closed'
    clearTimeout(this.startupTimer)
    this.resolveExit?.()
    this.resolveExit = undefined
  }
}

class RemoteWorkspaceAttachment implements WorkspaceAttachment {
  private readonly client: WorkspaceWorkerClient
  private readonly attachmentId: number
  private currentBinding: WorkspaceBinding
  private done = false

  constructor(client: WorkspaceWorkerClient, attachmentId: number, binding: WorkspaceBinding) {
    this.client = client
    this.attachmentId = attachmentId
    this.currentBinding = binding
  }

  get binding(): WorkspaceBinding {
    return this.currentBinding
  }

  refreshBinding(binding: WorkspaceBinding): void {
    if (!this.done) this.currentBinding = binding
  }

  authorize(operation: WorkspaceOperation): Promise<WorkspaceAuthorization> {
    if (this.done)
      return Promise.reject(
        new WorkspaceError({ outcome: 'blocked', message: 'Workspace attachment is closed' })
      )
    return this.client.request({ op: 'authorize', attachmentId: this.attachmentId, operation })
  }

  select(selection: WorkspaceSelection): Promise<WorkspaceHandoff> {
    if (this.done)
      return Promise.reject(
        new WorkspaceError({ outcome: 'blocked', message: 'Workspace attachment is closed' })
      )
    return this.client.request({ op: 'select', attachmentId: this.attachmentId, selection })
  }

  reportExecution(grant: WorkspaceGrant, fact: WorkspaceExecutionFact): Promise<void> {
    if (this.done)
      return Promise.reject(
        new WorkspaceError({ outcome: 'blocked', message: 'Workspace attachment is closed' })
      )
    return this.client
      .request({ op: 'report-execution', attachmentId: this.attachmentId, grant, fact })
      .then(() => undefined)
  }

  handoff(transition: WorkspaceHandoff, replace: HostReplace): Promise<void> {
    if (this.done)
      return Promise.reject(
        new WorkspaceError({ outcome: 'blocked', message: 'Workspace attachment is closed' })
      )
    const callbackId = this.client.createCallbackId()
    return this.client
      .request({ op: 'handoff', attachmentId: this.attachmentId, transition, callbackId }, replace)
      .then(() => undefined)
  }

  close(): Promise<void> {
    if (this.done) return Promise.resolve()
    this.done = true
    this.client.forgetAttachment(this.attachmentId)
    return this.client
      .request({ op: 'close-attachment', attachmentId: this.attachmentId })
      .then(() => undefined)
  }
}

class WorkspaceLifecycleClient implements WorkspaceLifecycle {
  private readonly client: WorkspaceWorkerClient

  constructor(root: string | undefined) {
    this.client = new WorkspaceWorkerClient(root)
  }

  async attach(input: {
    readonly conversation: WorkspaceConversation
    readonly cwd: string
    readonly selection?: WorkspaceSelection
    readonly withdrawUnstartedSwitch?: boolean
  }): Promise<WorkspaceAttachment> {
    const opened = await this.client.request({ op: 'attach', ...input })
    const attachment = new RemoteWorkspaceAttachment(
      this.client,
      opened.attachmentId,
      opened.binding
    )
    this.client.registerAttachment(opened.attachmentId, attachment)
    return attachment
  }

  inspect(input: {
    readonly cwd?: string
    readonly taskId?: string
  }): Promise<readonly WorkspaceView[]> {
    return this.client.request({ op: 'inspect', ...input })
  }

  validate(grant: WorkspaceGrant): Promise<void> {
    return this.client.request({ op: 'validate', grant }).then(() => undefined)
  }

  close(): Promise<void> {
    return this.client.close()
  }
}

export const makeWorkspaceLifecycle = (options?: { readonly root?: string }): WorkspaceLifecycle =>
  new WorkspaceLifecycleClient(options?.root)
