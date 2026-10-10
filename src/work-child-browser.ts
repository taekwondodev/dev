import { randomUUID } from 'node:crypto'
import { Effect, Option, Schema } from 'effect'
import { errorText } from './error-text.ts'
import { BrowserOwnerError } from './web-browser-owner.ts'
import { awaitReply, type ReplyChannel } from './work-child-ipc.ts'
import type { ChildMessage } from './work-protocol.ts'

const Reply = Schema.Struct({
  type: Schema.Literal('browser-ready'),
  requestId: Schema.NonEmptyString,
  ok: Schema.Boolean,
  reason: Schema.optional(Schema.String),
})
const decodeReply = Schema.decodeUnknownOption(Reply)

type BrowserEnsure = Extract<ChildMessage, { readonly type: 'browser-ensure' }>

export interface BrowserChannel extends ReplyChannel {
  readonly connected: boolean
  send?(message: BrowserEnsure, callback: (error: Error | null) => void): boolean
}

const unavailable = (message: string) => new BrowserOwnerError({ reason: 'bootstrap', message })

export const requestBrowserOwner = (
  channel: BrowserChannel = process
): Effect.Effect<void, BrowserOwnerError> =>
  Effect.callback<void, BrowserOwnerError>(resume => {
    if (!channel.connected || channel.send === undefined) {
      resume(Effect.fail(unavailable('The work controller IPC channel is unavailable')))
      return
    }
    const requestId = randomUUID()
    const settle = (result: Effect.Effect<void, BrowserOwnerError>): void => {
      cleanup()
      resume(result)
    }
    const cleanup = awaitReply(channel, requestId, {
      disconnected: () => settle(Effect.fail(unavailable('The work controller disconnected'))),
      reply: raw => {
        const reply = decodeReply(raw)
        if (Option.isNone(reply) || reply.value.requestId !== requestId) return
        settle(
          reply.value.ok
            ? Effect.void
            : Effect.fail(
                unavailable(reply.value.reason ?? 'The lead refused to start a browser owner')
              )
        )
      },
    })
    try {
      channel.send({ type: 'browser-ensure', requestId }, cause => {
        if (cause !== null) settle(Effect.fail(unavailable(errorText(cause))))
      })
    } catch (cause) {
      settle(Effect.fail(unavailable(errorText(cause))))
    }
    return Effect.sync(cleanup)
  }).pipe(
    Effect.timeoutOrElse({
      duration: '20 seconds',
      orElse: () =>
        Effect.fail(unavailable('The work controller did not answer the browser owner request')),
    })
  )
