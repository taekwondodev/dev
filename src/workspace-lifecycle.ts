import { Worker, type Transferable, type WorkerOptions } from 'node:worker_threads'
import type * as Cause from 'effect/Cause'
import * as Clock from 'effect/Clock'
import * as Deferred from 'effect/Deferred'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as FiberSet from 'effect/FiberSet'
import * as Option from 'effect/Option'
import * as Queue from 'effect/Queue'
import type * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
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
import { withCompileCache } from './compile-cache.ts'
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

const startWorkerThread: StartWorkspaceWorker = (url, options) => new Worker(url, options)

export const makeWorkspaceLifecycle = Effect.fnUntraced(function* (options?: {
  readonly root?: string
  readonly startWorker?: StartWorkspaceWorker
}): Effect.fn.Return<WorkspaceLifecycle, never, Scope.Scope> {
  const startWorker = options?.startWorker ?? startWorkerThread
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
      startWorker(new URL('./workspace-worker.ts', import.meta.url), {
        workerData: options?.root === undefined ? {} : { root: options.root },
        env: withCompileCache(process.env),
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
    post(message, 'Dev lost the result of the checkout switch')
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
      fail(unavailableError('Dev workspace response exceeded the size limit'))
      return
    }
    let message: WorkspaceWorkerMessage
    try {
      message = decodeWorkspaceWorkerMessage(raw)
    } catch {
      fail(unavailableError('Dev received an invalid workspace response'))
      return
    }
    if ('type' in message) {
      switch (message.type) {
        case 'ready':
          if (phase !== 'starting') {
            fail(unavailableError('Dev received an unexpected startup response'))
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
            fail(unavailableError('Dev received too many checkout updates'))
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
          fail(unavailableError(`Unexpected workspace response: ${String(exhaustive)}`))
          return
        }
      }
    }
    const request = pending.get(message.id)
    if (request === undefined) {
      fail(unavailableError('Dev could not match the workspace response to a request'))
      return
    }
    if (message.ok && message.op !== request.op) {
      fail(unavailableError('Workspace response did not match the request'))
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
      fail(unavailableError('Dev workspace service stopped unexpectedly'))
    else if (pending.size > 0) {
      const cause = unavailableError('Dev workspace service stopped before confirming the request')
      for (const request of pending.values()) Deferred.doneUnsafe(request.result, Exit.fail(cause))
      pending.clear()
    }
    phase = 'closed'
    Deferred.doneUnsafe(exited, Exit.void)
  }

  worker.on('message', onMessage)
  worker.on('error', cause =>
    fail(unavailableError(`Dev workspace service failed: ${errorText(cause)}`))
  )
  worker.on('exit', onExit)
  yield* Effect.sleep(STARTUP_TIMEOUT).pipe(
    Effect.andThen(
      Effect.sync(() => {
        if (phase === 'starting') fail(unavailableError('Dev workspace service did not start'))
      })
    ),
    Effect.forkScoped
  )

  const nextId = (): Effect.Effect<number, WorkspaceError> =>
    Effect.suspend(() => {
      nextRequestId += 1
      if (Number.isSafeInteger(nextRequestId)) return Effect.succeed(nextRequestId)
      const cause = unavailableError('Dev cannot accept more checkout requests in this session')
      fail(cause)
      return Effect.fail(cause)
    })

  const send = Effect.fnUntraced(function* <K extends WorkspaceRpcOperation>(
    input: WorkspaceRpcInput & { readonly op: K },
    hostReplace: HostReplace | undefined,
    duringClose: boolean
  ): Effect.fn.Return<WorkspaceRpcResults[K], WorkspaceError> {
    if (!(phase === 'ready' || (duringClose && phase === 'closing')))
      return yield* unavailableError('Dev workspace service is unavailable')
    if (pending.size >= MAX_PENDING_REQUESTS)
      return yield* unavailableError('Too many workspace requests')
    if (hostReplace !== undefined && input.op !== 'handoff')
      return yield* invalidError('This request cannot switch checkouts')
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
      return yield* invalidError('Workspace request exceeded its size limit')
    }
    const result = yield* Deferred.make<unknown, WorkspaceError>()

    pending.set(id, { op: request.op, result })
    post(envelope, 'Dev could not send the workspace request')
    const value = yield* Deferred.await(result).pipe(
      Effect.timeoutOrElse({
        duration: RPC_TIMEOUT,
        orElse: () => {
          const cause = unavailableError('Dev did not get confirmation of the workspace request')
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
    const cause = unavailableError('Dev received an invalid workspace response')
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
    const delegated = new Set<string>()
    const open = <A>(effect: Effect.Effect<A, WorkspaceError>) =>
      Effect.suspend(() => (done ? Effect.fail(closedAttachment) : effect))
    return {
      get binding() {
        return current
      },
      get delegatedCwds() {
        return [...delegated]
      },
      refreshBinding(next) {
        if (!done) current = next
      },
      deliverSweep(receipt) {
        if (!done) Queue.offerUnsafe(receipts, receipt)
      },
      sweeps: Stream.fromQueue(receipts),
      authorize: operation =>
        open(
          Effect.suspend(() => {
            if (
              (operation.kind === 'delegated-write' || operation.kind === 'foreign-write') &&
              operation.cwd !== undefined
            )
              delegated.add(operation.cwd)
            return request({ op: 'authorize', attachmentId, operation })
          })
        ),
      authorizeWriter: (operation, paused) =>
        open(request({ op: 'authorize-writer', attachmentId, operation, paused })),
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

  return {
    root: options?.root ?? defaultAuthorityRoot(),
    attach: Effect.fnUntraced(function* (input) {
      const opened = yield* request({ op: 'attach', ...input })
      if (attachments.size >= MAX_ATTACHMENTS || attachments.has(opened.attachmentId)) {
        const cause = unavailableError('Dev could not verify checkout access')
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
    release: input => request({ op: 'release', taskId: input.taskId }),
    releasePreExisting: input =>
      request({
        op: 'release-pre-existing',
        repositoryId: input.repositoryId,
        workspaceIds: input.workspaceIds,
      }),
    sweep: input => request({ op: 'sweep', request: input }),
    recordTarget: input =>
      request({ op: 'record-target', taskId: input.taskId, target: input.target }).pipe(
        Effect.asVoid
      ),
    recordPublication: input =>
      request({ op: 'record-publication', reference: input.reference }).pipe(Effect.asVoid),
  }
})
