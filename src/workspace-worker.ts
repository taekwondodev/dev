import { resolve as resolvePath } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import { Option } from 'effect'
import {
  authorizeOperation,
  reportExecutionFact,
  validateDurableGrant,
} from './workspace-admission.ts'
import type { AllocationSweep } from './workspace-allocation.ts'
import { inDb, type WorkspaceAuthority } from './workspace-authority.ts'
import { defaultAuthorityRoot } from './workspace-authority-root.ts'
import { conversationWorkspaces } from './workspace-conversation.ts'
import {
  attachmentClosed,
  invalid,
  WorkspaceError,
  type SweepReceipt,
  type WorkspaceId,
} from './workspace-domain.ts'
import { WorkspaceEngine, type EngineAttachment } from './workspace-engine.ts'
import { inspectWorkspaces } from './workspace-inspect.ts'
import {
  decodeWorkspaceWorkerData,
  decodeWorkspaceParentMessage,
  decodeWorkspaceRpcInput,
  type WorkspaceRpcInput,
  type WorkspaceRpcOperation,
  type WorkspaceRpcResults,
  type WorkspaceWorkerMessage,
} from './workspace-protocol.ts'
import { performHandoff, selectWorkspace } from './workspace-transitions.ts'
import { makeGitHubReader, PROVIDER_BUDGET_MS } from './workspace-evidence.ts'
import { recordPublication, recordTarget } from './workspace-evidence-records.ts'
import {
  checkTask,
  releaseWorkspace,
  sweepDeadline,
  sweepRepository,
  type EvidenceReaders,
} from './workspace-release.ts'
import { getWorkspace } from './workspace-records.ts'
import { errorText } from './error-text.ts'
import { newId, now } from './workspace-platform.ts'

const MAX_ATTACHMENTS = 256
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024
const port = parentPort

interface CallbackWaiter {
  readonly resolve: (outcome: 'confirmed' | 'cancelled') => void
  readonly reject: (cause: unknown) => void
}

const outcomeOf = (cause: unknown): WorkspaceError['outcome'] =>
  cause instanceof WorkspaceError ? cause.outcome : 'unavailable'
const send = (message: WorkspaceWorkerMessage): void => {
  if (port === null) throw new Error('Workspace worker has no parent port')
  const encoded = JSON.stringify(message)
  if (Buffer.byteLength(encoded, 'utf8') > MAX_MESSAGE_BYTES)
    throw new WorkspaceError({
      outcome: 'unavailable',
      message: 'Workspace authority worker message exceeded its size limit',
    })
  port.postMessage(message)
}
const failResponse = (id: number, cause: unknown): void => {
  send({ id, ok: false, outcome: outcomeOf(cause), message: errorText(cause) })
}

const startEngine = (): WorkspaceEngine | undefined => {
  try {
    let data
    try {
      data = decodeWorkspaceWorkerData(workerData)
    } catch {
      throw new WorkspaceError({
        outcome: 'invalid',
        message: 'Workspace worker configuration is invalid',
      })
    }
    const started = new WorkspaceEngine(data.root ?? defaultAuthorityRoot())
    send({ type: 'ready' })
    return started
  } catch (cause) {
    send({ type: 'startup-failure', outcome: outcomeOf(cause), message: errorText(cause) })
    port?.close()
    return undefined
  }
}

const engine = startEngine()

const readersUntil = (deadline: number): EvidenceReaders => ({
  github: makeGitHubReader(undefined, Math.max(0, deadline - now())),
})

const repositoryOf = (authority: WorkspaceAuthority, workspaceId: WorkspaceId): WorkspaceId => {
  for (const repository of authority.listRepositories())
    if (inDb(authority, repository.id, db => getWorkspace(db, workspaceId) !== undefined))
      return repository.id
  return invalid(`Workspace ${workspaceId} is unknown to the workspace authority`)
}

if (port !== null && engine !== undefined) {
  let nextAttachmentId = 0
  const attachments = new Map<number, EngineAttachment>()
  const callbacks = new Map<number, CallbackWaiter>()
  const activeRequests = new Map<number, Promise<void>>()
  let closing = false

  const requireAttachment = (id: number): EngineAttachment => {
    const attachment = attachments.get(id)
    if (attachment === undefined) throw attachmentClosed()
    return attachment
  }

  const hostReplace = (
    callbackId: number,
    attachmentId: number,
    transition: Extract<WorkspaceRpcInput, { readonly op: 'handoff' }>['transition']
  ): Promise<'confirmed' | 'cancelled'> =>
    new Promise((resolve, reject) => {
      if (callbacks.has(callbackId)) {
        reject(new WorkspaceError({ outcome: 'invalid', message: 'Duplicate host callback ID' }))
        return
      }
      callbacks.set(callbackId, { resolve, reject })
      try {
        send({ type: 'host-callback', id: callbackId, attachmentId, transition })
      } catch (cause) {
        callbacks.delete(callbackId)
        reject(cause)
      }
    })

  const refreshBindings = (): void => {
    const updates = [...attachments].map(([attachmentId, attachment]) => ({
      attachmentId,
      binding: attachment.binding,
    }))
    send({ type: 'bindings', updates })
  }

  const execute = async (
    request: WorkspaceRpcInput,
    sentAt: number
  ): Promise<WorkspaceRpcResults[WorkspaceRpcOperation]> => {
    switch (request.op) {
      case 'attach': {
        if (attachments.size >= MAX_ATTACHMENTS)
          throw new WorkspaceError({
            outcome: 'blocked',
            message: 'Workspace lifecycle has reached its attachment limit',
          })
        const attachment = await engine.attach(request)
        const attachmentId = ++nextAttachmentId
        attachments.set(attachmentId, attachment)
        return { attachmentId, binding: attachment.binding }
      }
      case 'authorize': {
        const attachment = requireAttachment(request.attachmentId)
        const sweep: AllocationSweep = (authority, repositoryId, state) => {
          const deadline = sweepDeadline('allocation', sentAt)
          let receipt: SweepReceipt
          try {
            receipt = sweepRepository(
              authority,
              {
                repositoryId,
                moment: 'allocation',
                deadline,
                occupiedPaths: [resolvePath(process.cwd())],
                excluded: conversationWorkspaces(state),
              },
              readersUntil(deadline)
            )
          } catch (cause) {
            receipt = {
              commandId: newId(),
              moment: 'allocation',
              rows: [
                {
                  kind: 'sweep-failure',
                  reason: `The sweep before this allocation failed; nothing was released: ${errorText(cause)}`,
                },
              ],
            }
          }
          if (receipt.rows.length > 0)
            send({ type: 'sweep-receipt', attachmentId: request.attachmentId, receipt })
        }
        return await engine.run(authority =>
          authorizeOperation(authority, attachment, request.operation, sweep)
        )
      }
      case 'select': {
        const attachment = requireAttachment(request.attachmentId)
        return await engine.run(authority =>
          selectWorkspace(authority, attachment, request.selection)
        )
      }
      case 'report-execution': {
        const attachment = requireAttachment(request.attachmentId)
        return await engine.run(authority =>
          reportExecutionFact(authority, attachment, request.grant, request.fact)
        )
      }
      case 'handoff': {
        const attachment = requireAttachment(request.attachmentId)
        await engine.run(authority =>
          performHandoff(authority, attachment, request.transition, target =>
            hostReplace(request.callbackId, request.attachmentId, {
              ...request.transition,
              target,
            })
          )
        )
        return null
      }
      case 'close-attachment': {
        const attachment = attachments.get(request.attachmentId)
        if (attachment === undefined) return null
        attachments.delete(request.attachmentId)
        await engine.closeAttachment(attachment)
        return null
      }
      case 'inspect':
        return await engine.run(authority => inspectWorkspaces(authority, request))
      case 'validate':
        await engine.run(authority => validateDurableGrant(authority, request.grant))
        return null
      case 'check':
        return await engine.run(authority =>
          checkTask(
            authority,
            request.taskId,
            readersUntil(sentAt + PROVIDER_BUDGET_MS),
            engine.ownConversation(request.ownConversation)
          )
        )
      case 'release':
        if (request.request.decider.kind !== 'user')
          throw new WorkspaceError({
            outcome: 'invalid',
            message: 'Only the sweep makes automatic release attempts',
          })
        return await engine.run(authority =>
          releaseWorkspace(authority, request.request, readersUntil(sentAt + PROVIDER_BUDGET_MS))
        )
      case 'sweep': {
        const deadline = sweepDeadline('quit', sentAt)
        return await engine.run(authority =>
          sweepRepository(
            authority,
            {
              repositoryId: repositoryOf(authority, request.request.anchorWorkspaceId),
              moment: 'quit',
              deadline,
              occupiedPaths: request.request.occupiedPaths,
            },
            readersUntil(deadline)
          )
        )
      }
      case 'record-target':
        await engine.run(authority => recordTarget(authority, request.taskId, request.target))
        return null
      case 'record-publication':
        await engine.run(authority => recordPublication(authority, request.reference))
        return null
      case 'close': {
        if (closing) return null
        closing = true
        for (const waiter of callbacks.values())
          waiter.reject(
            new WorkspaceError({
              outcome: 'unavailable',
              message: 'Workspace lifecycle closed during host handoff',
            })
          )
        callbacks.clear()
        const inFlight = [...activeRequests.entries()]
          .filter(([activeId]) => activeId !== currentCloseId)
          .map(([, promise]) => promise)
        await Promise.allSettled(inFlight)
        await engine.close()
        attachments.clear()
        return null
      }
      default: {
        const exhaustive: never = request
        throw new WorkspaceError({
          outcome: 'invalid',
          message: `Unsupported workspace RPC: ${exhaustive}`,
        })
      }
    }
  }

  let currentCloseId = -1
  const handleRpc = async (
    id: number,
    request: WorkspaceRpcInput,
    sentAt: number
  ): Promise<void> => {
    let executionSucceeded = false
    try {
      if (closing && request.op !== 'close')
        throw new WorkspaceError({ outcome: 'unavailable', message: 'Workspace worker is closing' })
      if (request.op === 'close') currentCloseId = id
      const value = await execute(request, sentAt)
      executionSucceeded = true
      if (request.op !== 'close') refreshBindings()
      send({ id, ok: true, op: request.op, value } as WorkspaceWorkerMessage)
      if (request.op === 'close') port.close()
    } catch (cause) {
      if (executionSucceeded) {
        port.close()
        return
      }
      try {
        failResponse(id, cause)
      } catch {
        port.close()
      }
    } finally {
      if (request.op === 'close') currentCloseId = -1
    }
  }

  port.on('message', (raw: unknown) => {
    try {
      const message = decodeWorkspaceParentMessage(raw)
      if ('type' in message) {
        const waiter = callbacks.get(message.id)
        if (waiter === undefined) return
        callbacks.delete(message.id)
        if (message.ok && message.outcome !== undefined) waiter.resolve(message.outcome)
        else
          waiter.reject(
            new WorkspaceError({
              outcome: 'unavailable',
              message: 'Workspace host handoff callback failed',
            })
          )
        return
      }
      if (activeRequests.has(message.id)) {
        failResponse(
          message.id,
          new WorkspaceError({ outcome: 'invalid', message: 'Duplicate workspace RPC ID' })
        )
        return
      }
      const request = decodeWorkspaceRpcInput(message.request)
      if (Option.isNone(request)) {
        failResponse(
          message.id,
          new WorkspaceError({ outcome: 'invalid', message: 'Workspace worker request is invalid' })
        )
        return
      }
      const operation = handleRpc(message.id, request.value, message.sentAt)
      activeRequests.set(message.id, operation)
      void operation.finally(() => activeRequests.delete(message.id))
    } catch {
      try {
        send({
          type: 'startup-failure',
          outcome: 'unavailable',
          message: 'Workspace worker received an invalid protocol message',
        })
      } finally {
        port.close()
      }
    }
  })
}
