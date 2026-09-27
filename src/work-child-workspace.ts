import { Effect, Option, Schema } from 'effect'
import type * as Pi from '@earendil-works/pi-coding-agent'
import { WorkspaceError, WorkspaceId, type WorkspaceGrant } from './workspace-domain.ts'
import type { ChildMessage } from './work-protocol.ts'
import { decodeWriteOperand, resolveWriteDestination } from './workspace-paths.ts'
import { newId } from './workspace-platform.ts'
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

type WorkspaceCheck = Extract<ChildMessage, { readonly type: 'workspace-check' }>

export interface ControllerChannel {
  readonly connected: boolean
  send?(message: WorkspaceCheck, callback: (error: Error | null) => void): boolean
  on(event: 'message', listener: (message: unknown) => void): unknown
  once(event: 'disconnect', listener: () => void): unknown
  removeListener(event: 'message', listener: (message: unknown) => void): unknown
  removeListener(event: 'disconnect', listener: () => void): unknown
}

const unavailableError = (message: string) =>
  new WorkspaceError({ outcome: 'unavailable', message })

export const validateWorkspaceWritePath = (
  grant: WorkspaceGrant,
  input: unknown
): Effect.Effect<string, WorkspaceError> =>
  Effect.try({
    try: () => resolveWriteDestination(grant.checkout, grant.cwd, decodeWriteOperand(input)),
    catch: cause =>
      cause instanceof WorkspaceError
        ? cause
        : new WorkspaceError({ outcome: 'invalid', message: errorText(cause) }),
  })

export const checkChildWorkspace = (
  grant: WorkspaceGrant,
  operation: 'read' | 'write',
  channel: ControllerChannel = process
): Effect.Effect<void, WorkspaceError> =>
  Effect.callback<void, WorkspaceError>(resume => {
    if (!channel.connected || channel.send === undefined) {
      resume(Effect.fail(unavailableError('Workspace controller IPC is unavailable')))
      return
    }
    const requestId = newId()
    const cleanup = (): void => {
      channel.removeListener('message', onMessage)
      channel.removeListener('disconnect', onDisconnect)
    }
    const settle = (result: Effect.Effect<void, WorkspaceError>): void => {
      cleanup()
      resume(result)
    }
    const onDisconnect = (): void =>
      settle(Effect.fail(unavailableError('Workspace controller disconnected')))
    const onMessage = (raw: unknown): void => {
      const reply = decodeReply(raw)
      if (
        Option.isNone(reply) ||
        reply.value.requestId !== requestId ||
        reply.value.useId !== grant.useId
      )
        return
      settle(
        reply.value.allowed
          ? Effect.void
          : Effect.fail(
              new WorkspaceError({
                outcome: 'blocked',
                message: reply.value.reason ?? 'Workspace authorization rejected',
              })
            )
      )
    }
    channel.on('message', onMessage)
    channel.once('disconnect', onDisconnect)
    try {
      channel.send({ type: 'workspace-check', requestId, useId: grant.useId, operation }, cause => {
        if (cause !== null) settle(Effect.fail(unavailableError(errorText(cause))))
      })
    } catch (cause) {
      settle(Effect.fail(unavailableError(errorText(cause))))
    }
    return Effect.sync(cleanup)
  }).pipe(
    Effect.timeoutOrElse({
      duration: '10 seconds',
      orElse: () =>
        Effect.fail(unavailableError('Workspace authorization acknowledgment unavailable')),
    })
  )

export const childWorkspaceExtension =
  (grant: WorkspaceGrant, channel: ControllerChannel = process): Pi.ExtensionFactory =>
  pi => {
    pi.on('tool_call', event =>
      Effect.runPromise(
        Effect.gen(function* () {
          const tool = pi.getAllTools().find(candidate => candidate.name === event.toolName)
          const builtin = tool?.sourceInfo.source === 'builtin'
          const reviewGit =
            grant.access === 'read' &&
            event.toolName === 'git_inspect' &&
            tool?.sourceInfo.source === 'sdk'
          const read = (builtin && readTools.has(event.toolName)) || reviewGit
          if (!read && grant.access !== 'write')
            return yield* new WorkspaceError({
              outcome: 'blocked',
              message: 'Child workspace is read-only',
            })
          if (builtin && (event.toolName === 'write' || event.toolName === 'edit'))
            yield* validateWorkspaceWritePath(grant, event.input)
          yield* checkChildWorkspace(grant, read ? 'read' : 'write', channel)
          return undefined
        }).pipe(Effect.catch(error => Effect.succeed({ block: true, reason: error.message })))
      )
    )
  }
