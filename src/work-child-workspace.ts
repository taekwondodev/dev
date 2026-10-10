import { Effect, Option, Schema } from 'effect'
import type * as Pi from '@earendil-works/pi-coding-agent'
import { WorkspaceError, WorkspaceId, type WorkspaceGrant } from './workspace-domain.ts'
import type { ChildMessage } from './work-protocol.ts'
import { classifyWriteDestination, decodeWriteOperand } from './workspace-paths.ts'
import type { NativeWrites } from './workspace-native-write.ts'
import { newId } from './workspace-platform.ts'
import { errorText } from './error-text.ts'
import { awaitReply, type ReplyChannel } from './work-child-ipc.ts'
import { isIntegratedCodemode, isIntegratedReader } from './integrated-tools.ts'

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

export interface ControllerChannel extends ReplyChannel {
  readonly connected: boolean
  send?(message: WorkspaceCheck, callback: (error: Error | null) => void): boolean
}

const unavailableError = (message: string) =>
  new WorkspaceError({ outcome: 'unavailable', message })

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
    const settle = (result: Effect.Effect<void, WorkspaceError>): void => {
      cleanup()
      resume(result)
    }
    const cleanup = awaitReply(channel, requestId, {
      disconnected: () =>
        settle(Effect.fail(unavailableError('Workspace controller disconnected'))),
      reply: raw => {
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
      },
    })
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
  (
    grant: WorkspaceGrant,
    authorityRoot: string,
    nativeWrites: NativeWrites,
    channel: ControllerChannel = process
  ): Pi.ExtensionFactory =>
  pi => {
    const scope = { checkout: grant.checkout, authorityRoot }
    pi.on('tool_result', event => Effect.runPromise(nativeWrites.finish(event.toolCallId)))
    pi.on('session_shutdown', () => Effect.runPromise(nativeWrites.settle))
    pi.on('tool_call', event =>
      Effect.runPromise(
        Effect.gen(function* () {
          const tool = pi.getAllTools().find(candidate => candidate.name === event.toolName)
          const builtin = tool?.sourceInfo.source === 'builtin'
          const nativeWrite =
            (event.toolName === 'write' || event.toolName === 'edit') &&
            (builtin ||
              (tool?.sourceInfo.source === 'sdk' &&
                tool.sourceInfo.path === `<sdk:${event.toolName}>`))
          const reviewGit =
            grant.access === 'read' &&
            event.toolName === 'git_inspect' &&
            tool?.sourceInfo.source === 'sdk'
          const coordination = event.toolName === 'work' && tool?.sourceInfo.source === 'sdk'
          if (isIntegratedReader(tool) || isIntegratedCodemode(tool)) return undefined
          const read = (builtin && readTools.has(event.toolName)) || reviewGit || coordination
          if (!read && grant.access !== 'write')
            return yield* new WorkspaceError({
              outcome: 'blocked',
              message: 'Child workspace is read-only',
            })
          yield* checkChildWorkspace(grant, read ? 'read' : 'write', channel)
          if (nativeWrite) {
            const destination = yield* Effect.try({
              try: () =>
                classifyWriteDestination(scope, grant.cwd, decodeWriteOperand(event.input)),
              catch: cause => new WorkspaceError({ outcome: 'invalid', message: errorText(cause) }),
            })
            yield* nativeWrites.admit({
              toolCallId: event.toolCallId,
              scope,
              destination,
              lifecycle: { kind: 'local', validate: checkChildWorkspace(grant, 'write', channel) },
            })
          }
          return undefined
        }).pipe(Effect.catch(error => Effect.succeed({ block: true, reason: error.message })))
      )
    )
  }
