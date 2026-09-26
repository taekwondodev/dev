import { randomUUID } from 'node:crypto'
import { Schema } from 'effect'
import type * as Pi from '@earendil-works/pi-coding-agent'
import { WorkspaceId, type WorkspaceGrant } from './workspace-domain.ts'
import { decodeWriteOperand, resolveWriteDestination } from './workspace-paths.ts'
import { errorText } from './error-text.ts'

const Reply = Schema.Struct({
  type: Schema.Literal('workspace-checked'),
  requestId: WorkspaceId,
  useId: WorkspaceId,
  allowed: Schema.Boolean,
  reason: Schema.optional(Schema.String),
})
const decodeReply = Schema.decodeUnknownOption(Reply)
const readTools = new Set(['read', 'grep', 'find', 'ls'])

export const validateWorkspaceWritePath = async (
  grant: WorkspaceGrant,
  input: unknown
): Promise<string> => resolveWriteDestination(grant.checkout, grant.cwd, decodeWriteOperand(input))

export const checkChildWorkspace = (
  grant: WorkspaceGrant,
  operation: 'read' | 'write'
): Promise<void> =>
  new Promise((accept, reject) => {
    if (!process.connected || process.send === undefined) {
      reject(new Error('Workspace controller IPC is unavailable'))
      return
    }
    const requestId = randomUUID()
    const cleanup = (): void => {
      clearTimeout(timeout)
      process.removeListener('message', onMessage)
      process.removeListener('disconnect', onDisconnect)
    }
    const fail = (cause: Error): void => {
      cleanup()
      reject(cause)
    }
    const onDisconnect = (): void => fail(new Error('Workspace controller disconnected'))
    const onMessage = (raw: unknown): void => {
      const reply = decodeReply(raw)
      if (
        reply._tag !== 'Some' ||
        reply.value.requestId !== requestId ||
        reply.value.useId !== grant.useId
      )
        return
      cleanup()
      if (reply.value.allowed) accept()
      else reject(new Error(reply.value.reason ?? 'Workspace authorization rejected'))
    }
    const timeout = setTimeout(
      () => fail(new Error('Workspace authorization acknowledgment unavailable')),
      10000
    )
    process.on('message', onMessage)
    process.once('disconnect', onDisconnect)
    try {
      process.send({ type: 'workspace-check', requestId, useId: grant.useId, operation }, cause => {
        if (cause !== null) fail(cause)
      })
    } catch (cause) {
      fail(cause instanceof Error ? cause : new Error(String(cause)))
    }
  })

export const childWorkspaceExtension =
  (grant: WorkspaceGrant): Pi.ExtensionFactory =>
  pi => {
    pi.on('tool_call', async event => {
      try {
        const tool = pi.getAllTools().find(candidate => candidate.name === event.toolName)
        const builtin = tool?.sourceInfo.source === 'builtin'
        const reviewGit =
          grant.access === 'read' &&
          event.toolName === 'git_inspect' &&
          tool?.sourceInfo.source === 'sdk'
        const read = (builtin && readTools.has(event.toolName)) || reviewGit
        if (!read && grant.access !== 'write') throw new Error('Child workspace is read-only')
        const fileWrite = builtin && (event.toolName === 'write' || event.toolName === 'edit')
        if (fileWrite) await validateWorkspaceWritePath(grant, event.input)
        await checkChildWorkspace(grant, read ? 'read' : 'write')
      } catch (cause) {
        return { block: true, reason: errorText(cause) }
      }
    })
  }
