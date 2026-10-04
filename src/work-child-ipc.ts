import { Predicate } from 'effect'

export interface ReplyChannel {
  on(event: 'message', listener: (message: unknown) => void): unknown
  once(event: 'disconnect', listener: () => void): unknown
  removeListener(event: 'message', listener: (message: unknown) => void): unknown
  removeListener(event: 'disconnect', listener: () => void): unknown
}

interface Waiter {
  readonly reply: (message: unknown) => void
  readonly disconnected: () => void
}

interface Dispatcher {
  readonly waiting: Map<string, Waiter>
  readonly detach: () => void
}

const dispatchers = new WeakMap<ReplyChannel, Dispatcher>()

const attach = (channel: ReplyChannel): Dispatcher => {
  const waiting = new Map<string, Waiter>()
  const onMessage = (message: unknown): void => {
    if (Predicate.isObject(message) && typeof message.requestId === 'string')
      waiting.get(message.requestId)?.reply(message)
  }
  const onDisconnect = (): void => {
    for (const waiter of waiting.values()) waiter.disconnected()
  }
  channel.on('message', onMessage)
  channel.once('disconnect', onDisconnect)
  const dispatcher = {
    waiting,
    detach: (): void => {
      channel.removeListener('message', onMessage)
      channel.removeListener('disconnect', onDisconnect)
      dispatchers.delete(channel)
    },
  }
  dispatchers.set(channel, dispatcher)
  return dispatcher
}

export const awaitReply = (
  channel: ReplyChannel,
  requestId: string,
  waiter: Waiter
): (() => void) => {
  const dispatcher = dispatchers.get(channel) ?? attach(channel)
  dispatcher.waiting.set(requestId, waiter)
  return () => {
    if (dispatcher.waiting.get(requestId) !== waiter) return
    dispatcher.waiting.delete(requestId)
    if (dispatcher.waiting.size === 0) dispatcher.detach()
  }
}
