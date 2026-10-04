import { Worker, type Transferable, type WorkerOptions } from 'node:worker_threads'
import {
  type Cause,
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  FiberSet,
  Layer,
  Option,
  Queue,
  type Scope,
  Stream,
} from 'effect'
import {
  attachmentClosed,
  WorkspaceError,
  type HostReplace,
  type SweepReceipt,
  type WorkspaceAttachment,
  type WorkspaceBinding,
  type WorkspaceLifecycle,
  WORKER_REQUEST_TIMEOUT_MS,
} from './workspace-domain.ts'
import {
  decodeWorkspaceRpcReply,
  decodeWorkspaceWorkerMessage,
  type WorkspaceRpcInput,
  type WorkspaceRpcOperation,
  type WorkspaceRpcResults,
  type WorkspaceWorkerMessage,
} from './workspace-protocol.ts'
import { errorText } from './error-text.ts'
import { defaultAuthorityRoot } from './workspace-authority-root.ts'

const RPC_TIMEOUT = Duration.millis(WORKER_REQUEST_TIMEOUT_MS)
const STARTUP_TIMEOUT = Duration.seconds(12)
const CLOSE_TIMEOUT = Duration.seconds(1)
const MAX_PENDING_REQUESTS = 64
const MAX_ATTACHMENTS = 256
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024

type WorkerPhase = 'starting' | 'ready' | 'closing' | 'closed' | 'failed'

interface PendingRequest {
  readonly op: WorkspaceRpcOperation
  readonly result: Deferred.Deferred<unknown, WorkspaceError>
}

interface HostCallback {
  readonly replace: HostReplace
  invoked: boolean
  responded: boolean
}

interface RemoteAttachment extends WorkspaceAttachment {
  refreshBinding(binding: WorkspaceBinding): void
  deliverSweep(receipt: SweepReceipt): void
}

const unavailableError = (message: string): WorkspaceError =>
  new WorkspaceError({ outcome: 'unavailable', message })
const invalidError = (message: string): WorkspaceError =>
  new WorkspaceError({ outcome: 'invalid', message })
const closedAttachment = attachmentClosed()
const byteLength = (value: unknown): number => {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8')
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

export interface WorkspaceWorkerPort {
  postMessage(value: unknown, transferList: readonly Transferable[]): void
  on(event: 'message' | 'error' | 'exit', listener: (value: unknown) => void): unknown
  terminate(): Promise<unknown>
}
export type StartWorkspaceWorker = (url: URL, options: WorkerOptions) => WorkspaceWorkerPort

const replyDecoder = <K extends WorkspaceRpcOperation>(op: K) => decodeWorkspaceRpcReply[op]

export class WorkspaceWorkerSpawner extends Context.Service<
  WorkspaceWorkerSpawner,
  { readonly start: StartWorkspaceWorker }
>()('dev/workspace-lifecycle/WorkspaceWorkerSpawner') {
  static readonly layer = Layer.succeed(
    WorkspaceWorkerSpawner,
    WorkspaceWorkerSpawner.of({ start: (url, options) => new Worker(url, options) })
  )
}

interface AuthorityClientOptions {
  readonly root?: string
}

export class WorkspaceAuthorityClient extends Context.Service<
  WorkspaceAuthorityClient,
  WorkspaceLifecycle
>()('dev/workspace-lifecycle/WorkspaceAuthorityClient') {
  static readonly layerNoDeps = (
    options?: AuthorityClientOptions
  ): Layer.Layer<WorkspaceAuthorityClient, never, WorkspaceWorkerSpawner> =>
    Layer.effect(WorkspaceAuthorityClient, makeAuthorityClient(options))

  static readonly layer = (
    options?: AuthorityClientOptions
  ): Layer.Layer<WorkspaceAuthorityClient> =>
    WorkspaceAuthorityClient.layerNoDeps(options).pipe(Layer.provide(WorkspaceWorkerSpawner.layer))
}

const makeAuthorityClient = Effect.fnUntraced(function* (
  options?: AuthorityClientOptions
): Effect.fn.Return<WorkspaceLifecycle, never, Scope.Scope | WorkspaceWorkerSpawner> {
  const spawner = yield* WorkspaceWorkerSpawner
  const pending = new Map<number, PendingRequest>()
  const attachments = new Map<number, RemoteAttachment>()
  const callbacks = new Map<number, HostCallback>()
  const ready = yield* Deferred.make<void, WorkspaceError>()
  const exited = yield* Deferred.make<void>()
  const hostCallbacks = yield* FiberSet.make<void>()
  const runCallback = yield* FiberSet.runtime(hostCallbacks)()
  let phase: WorkerPhase = 'starting'
  let nextRequestId = 0
  let nextCallbackId = 0

  const worker = yield* Effect.acquireRelease(
    Effect.sync(() =>
      spawner.start(new URL('./workspace-worker.ts', import.meta.url), {
        workerData: options?.root === undefined ? {} : { root: options.root },
        execArgv: process.execArgv.filter(argument => !argument.startsWith('--input-type')),
      })
    ),
    started => Effect.promise(() => started.terminate().catch(() => undefined))
  )

  const fail = (cause: WorkspaceError): void => {
    if (phase === 'failed' || phase === 'closed') return
    const wasStarting = phase === 'starting'
    phase = 'failed'
    if (wasStarting) Deferred.doneUnsafe(ready, Exit.fail(cause))
    for (const request of pending.values()) Deferred.doneUnsafe(request.result, Exit.fail(cause))
    pending.clear()
    callbacks.clear()
    void worker.terminate()
  }

  const sendToWorker = worker.postMessage.bind(worker)
  const post = (message: unknown, failure: string): void => {
    try {
      sendToWorker(message, [])
    } catch {
      fail(unavailableError(failure))
    }
  }

  const sendCallbackResult = (id: number, outcome: 'confirmed' | 'cancelled' | undefined) => {
    const callback = callbacks.get(id)
    if (callback !== undefined) {
      if (callback.responded) return
      callback.responded = true
    }
    if (phase !== 'ready' && phase !== 'closing') return
    const message = {
      type: 'callback-result' as const,
      id,
      ok: outcome !== undefined,
      ...(outcome === undefined ? {} : { outcome }),
    }
    if (byteLength(message) > MAX_MESSAGE_BYTES) {
      fail(unavailableError('Workspace callback response exceeded its size limit'))
      return
    }
    post(message, 'Workspace worker could not receive its callback result')
  }

  const runHostCallback = (
    message: Extract<WorkspaceWorkerMessage, { readonly type: 'host-callback' }>
  ): void => {
    const callback = callbacks.get(message.id)
    if (callback === undefined || callback.invoked || callback.responded) {
      sendCallbackResult(message.id, undefined)
      return
    }
    callback.invoked = true
    runCallback(
      Effect.suspend(() => callback.replace(message.transition.target)).pipe(
        Effect.exit,
        Effect.map(outcome => {
          sendCallbackResult(message.id, Exit.isSuccess(outcome) ? outcome.value : undefined)
        })
      )
    )
  }

  const onMessage = (raw: unknown): void => {
    if (byteLength(raw) > MAX_MESSAGE_BYTES) {
      fail(unavailableError('Workspace authority worker message exceeded its size limit'))
      return
    }
    let message: WorkspaceWorkerMessage
    try {
      message = decodeWorkspaceWorkerMessage(raw)
    } catch {
      fail(unavailableError('Workspace authority worker protocol failed'))
      return
    }
    if ('type' in message) {
      switch (message.type) {
        case 'ready':
          if (phase !== 'starting') {
            fail(unavailableError('Workspace authority worker sent an unexpected ready message'))
            return
          }
          phase = 'ready'
          Deferred.doneUnsafe(ready, Exit.void)
          return
        case 'startup-failure':
          fail(new WorkspaceError({ outcome: message.outcome, message: message.message }))
          return
        case 'bindings':
          if (message.updates.length > MAX_ATTACHMENTS) {
            fail(unavailableError('Workspace worker sent too many binding updates'))
            return
          }
          for (const update of message.updates)
            attachments.get(update.attachmentId)?.refreshBinding(update.binding)
          return
        case 'host-callback':
          runHostCallback(message)
          return
        case 'sweep-receipt':
          attachments.get(message.attachmentId)?.deliverSweep(message.receipt)
          return
        default: {
          const exhaustive: never = message
          fail(unavailableError(`Unexpected worker message: ${String(exhaustive)}`))
          return
        }
      }
    }
    const request = pending.get(message.id)
    if (request === undefined) {
      fail(unavailableError('Workspace worker returned an uncorrelated acknowledgment'))
      return
    }
    if (message.ok && message.op !== request.op) {
      fail(unavailableError('Workspace worker acknowledgment did not match its request'))
      return
    }
    pending.delete(message.id)
    Deferred.doneUnsafe(
      request.result,
      message.ok
        ? Exit.succeed(message.value)
        : Exit.fail(new WorkspaceError({ outcome: message.outcome, message: message.message }))
    )
  }

  const onExit = (): void => {
    if (phase !== 'closing' && phase !== 'closed' && phase !== 'failed')
      fail(unavailableError('Workspace authority worker exited unexpectedly'))
    else if (pending.size > 0) {
      const cause = unavailableError('Workspace worker exited before acknowledging its request')
      for (const request of pending.values()) Deferred.doneUnsafe(request.result, Exit.fail(cause))
      pending.clear()
    }
    phase = 'closed'
    Deferred.doneUnsafe(exited, Exit.void)
  }

  worker.on('message', onMessage)
  worker.on('error', cause =>
    fail(unavailableError(`Workspace authority worker failed: ${errorText(cause)}`))
  )
  worker.on('exit', onExit)
  yield* Effect.sleep(STARTUP_TIMEOUT).pipe(
    Effect.andThen(
      Effect.sync(() => {
        if (phase === 'starting')
          fail(unavailableError('Workspace authority worker did not become ready'))
      })
    ),
    Effect.forkScoped
  )

  const nextId = (): Effect.Effect<number, WorkspaceError> =>
    Effect.suspend(() => {
      nextRequestId += 1
      if (Number.isSafeInteger(nextRequestId)) return Effect.succeed(nextRequestId)
      const cause = unavailableError('Workspace RPC sequence exceeded its limit')
      fail(cause)
      return Effect.fail(cause)
    })

  const send = Effect.fnUntraced(function* <K extends WorkspaceRpcOperation>(
    input: WorkspaceRpcInput & { readonly op: K },
    hostReplace: HostReplace | undefined,
    duringClose: boolean
  ): Effect.fn.Return<WorkspaceRpcResults[K], WorkspaceError> {
    if (!(phase === 'ready' || (duringClose && phase === 'closing')))
      return yield* unavailableError('Workspace authority worker is not available')
    if (pending.size >= MAX_PENDING_REQUESTS)
      return yield* unavailableError('Workspace authority worker request limit reached')
    if (hostReplace !== undefined && input.op !== 'handoff')
      return yield* invalidError('Host callback supplied for a non-handoff operation')
    const request: WorkspaceRpcInput = input
    const id = yield* nextId()
    const callbackId = request.op === 'handoff' ? request.callbackId : undefined
    if (hostReplace !== undefined && callbackId !== undefined) {
      if (callbacks.has(callbackId))
        return yield* invalidError('Workspace callback ID is already in use')
      callbacks.set(callbackId, { replace: hostReplace, invoked: false, responded: false })
    }
    const sentAt = yield* Clock.currentTimeMillis
    const envelope = { id, sentAt, request }
    if (byteLength(envelope) > MAX_MESSAGE_BYTES) {
      if (callbackId !== undefined) callbacks.delete(callbackId)
      return yield* invalidError('Workspace worker request exceeded its size limit')
    }
    const result = yield* Deferred.make<unknown, WorkspaceError>()

    pending.set(id, { op: request.op, result })
    post(envelope, 'Workspace authority worker could not receive a request')
    const value = yield* Deferred.await(result).pipe(
      Effect.timeoutOrElse({
        duration: RPC_TIMEOUT,
        orElse: () => {
          const cause = unavailableError('Workspace worker acknowledgment was lost or timed out')
          fail(cause)
          return Effect.fail(cause)
        },
      }),
      Effect.ensuring(
        Effect.sync(() => {
          if (callbackId !== undefined) callbacks.delete(callbackId)
        })
      )
    )
    const reply = replyDecoder<K>(input.op)(value)
    if (Option.isSome(reply)) return reply.value
    const cause = unavailableError('Workspace authority worker protocol failed')
    fail(cause)
    return yield* cause
  })

  const request = <K extends WorkspaceRpcOperation>(
    input: WorkspaceRpcInput & { readonly op: K },
    hostReplace?: HostReplace
  ): Effect.Effect<WorkspaceRpcResults[K], WorkspaceError> =>
    Deferred.await(ready).pipe(Effect.andThen(send<K>(input, hostReplace, false)))

  const makeAttachment = (
    attachmentId: number,
    binding: WorkspaceBinding,
    receipts: Queue.Queue<SweepReceipt, Cause.Done>
  ): RemoteAttachment => {
    let current = binding
    let done = false
    const open = <A>(effect: Effect.Effect<A, WorkspaceError>) =>
      Effect.suspend(() => (done ? Effect.fail(closedAttachment) : effect))
    return {
      get binding() {
        return current
      },
      refreshBinding(next) {
        if (!done) current = next
      },
      deliverSweep(receipt) {
        if (!done) Queue.offerUnsafe(receipts, receipt)
      },
      sweeps: Stream.fromQueue(receipts),
      authorize: operation => open(request({ op: 'authorize', attachmentId, operation })),
      select: selection => open(request({ op: 'select', attachmentId, selection })),
      reportExecution: (grant, fact) =>
        open(request({ op: 'report-execution', attachmentId, grant, fact })),
      handoff: (transition, replace) =>
        open(
          Effect.suspend(() => {
            nextCallbackId += 1
            if (!Number.isSafeInteger(nextCallbackId)) {
              const cause = unavailableError('Workspace callback sequence exceeded its limit')
              fail(cause)
              return Effect.fail(cause)
            }
            return request(
              { op: 'handoff', attachmentId, transition, callbackId: nextCallbackId },
              replace
            )
          })
        ).pipe(Effect.asVoid),
      close: Effect.suspend(() => {
        if (done) return Effect.void
        done = true
        Queue.endUnsafe(receipts)
        attachments.delete(attachmentId)
        return request({ op: 'close-attachment', attachmentId }).pipe(Effect.asVoid)
      }),
    }
  }

  const terminate = Effect.promise(() => worker.terminate().catch(() => undefined)).pipe(
    Effect.andThen(
      Effect.sync(() => {
        phase = 'closed'
      })
    ),
    Effect.andThen(Deferred.await(exited))
  )

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      if (phase === 'starting') yield* Effect.ignore(Deferred.await(ready))
      if (phase !== 'ready') return yield* Deferred.await(exited)
      phase = 'closing'
      for (const [id, callback] of callbacks)
        if (callback.invoked && !callback.responded) sendCallbackResult(id, undefined)
      const closed = yield* Effect.exit(send({ op: 'close' }, undefined, true))
      if (Exit.isFailure(closed)) return yield* terminate
      yield* Deferred.await(exited).pipe(
        Effect.timeoutOrElse({ duration: CLOSE_TIMEOUT, orElse: () => Effect.void })
      )
      if (phase === 'closing') yield* terminate
    })
  )

  return WorkspaceAuthorityClient.of({
    root: options?.root ?? defaultAuthorityRoot(),
    attach: Effect.fnUntraced(function* (input) {
      const opened = yield* request({ op: 'attach', ...input })
      if (attachments.size >= MAX_ATTACHMENTS || attachments.has(opened.attachmentId)) {
        const cause = unavailableError('Workspace worker returned an invalid attachment identity')
        fail(cause)
        return yield* cause
      }
      const receipts = yield* Queue.make<SweepReceipt, Cause.Done>()
      const attachment = makeAttachment(opened.attachmentId, opened.binding, receipts)
      attachments.set(opened.attachmentId, attachment)
      return attachment satisfies WorkspaceAttachment
    }),
    inspect: input => request({ op: 'inspect', ...input }),
    validate: grant => request({ op: 'validate', grant }).pipe(Effect.asVoid),
    check: input =>
      request({
        op: 'check',
        taskId: input.taskId,
        ...(input.ownConversation === undefined ? {} : { ownConversation: input.ownConversation }),
      }),
    release: input => request({ op: 'release', request: input }),
    sweep: input => request({ op: 'sweep', request: input }),
    recordTarget: input =>
      request({ op: 'record-target', taskId: input.taskId, target: input.target }).pipe(
        Effect.asVoid
      ),
    recordPublication: input =>
      request({ op: 'record-publication', reference: input.reference }).pipe(Effect.asVoid),
  })
})
