import { appendFileSync } from 'node:fs'
import { Effect, Option, Predicate, Schema } from 'effect'
import { ChildRequestEnvelope, serveChild } from '../../src/pi-child.ts'
import { WebNetworkError } from '../../src/web-network.ts'
import { ControllerWorkMessageSchema } from '../../src/work-protocol.ts'
import {
  cancelLog,
  directive,
  DROP_FIRST_ACK,
  HOLD_CANCEL,
  ipcLog,
  RAW_AFTER_REPLY_MARKER,
  RAW_MARKER,
  RAW_ON_CANCEL_MARKER,
  scriptedModelRuntime,
} from './work-child-model.ts'

const REPLY_GRACE_MS = 3000
const HOLD_CANCEL_MS = 1500

const decodeStart = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.Literal('start'), request: ChildRequestEnvelope })
)
const decodeCancel = Schema.decodeUnknownOption(Schema.Struct({ type: Schema.Literal('cancel') }))
const decodeReply = Schema.decodeUnknownOption(ControllerWorkMessageSchema)

const assignment = {
  prompt: '',
  log: '',
  cancels: '',
  dropAck: false,
  holdCancel: false,
  awaited: 0,
  closing: false,
  replied: false,
}

const channelSend = process.send?.bind(process)
const channelDisconnect = process.disconnect?.bind(process)

const sendRaw = (messages: unknown): number => {
  if (!Array.isArray(messages)) return 0
  for (const message of messages) channelSend?.(message)
  return messages.filter(message => Predicate.isObject(message) && message.type === 'work-request')
    .length
}

if (channelSend !== undefined)
  process.send = ((message: unknown, ...rest: readonly unknown[]): boolean => {
    if (assignment.dropAck && Predicate.isObject(message) && message.type === 'work-outcomes-ack') {
      assignment.dropAck = false
      const callback = rest.findLast(item => typeof item === 'function')
      if (typeof callback === 'function') callback(null)
      return true
    }
    return Reflect.apply(channelSend, process, [message, ...rest])
  }) as NonNullable<typeof process.send>

if (channelDisconnect !== undefined)
  process.disconnect = (): void => {
    if (assignment.awaited === 0) {
      channelDisconnect()
      return
    }
    assignment.closing = true
    setTimeout(() => {
      if (process.connected) channelDisconnect()
    }, REPLY_GRACE_MS).unref()
  }

process.on('message', (raw: unknown) => {
  const start = decodeStart(raw)
  if (Option.isSome(start)) {
    const { request } = start.value
    assignment.prompt = request.prompt
    assignment.log = ipcLog(request.dataHome, request.owner.attemptId)
    assignment.cancels = cancelLog(request.dataHome, request.owner.attemptId)
    assignment.dropAck = request.prompt.includes(DROP_FIRST_ACK)
    assignment.holdCancel = request.prompt.includes(HOLD_CANCEL)
    sendRaw(directive(request.prompt, RAW_MARKER))
    return
  }
  if (Option.isSome(decodeCancel(raw))) {
    if (assignment.cancels !== '') appendFileSync(assignment.cancels, 'cancel\n')
    assignment.awaited += sendRaw(directive(assignment.prompt, RAW_ON_CANCEL_MARKER))
    return
  }
  const reply = decodeReply(raw)
  if (Option.isNone(reply) || reply.value.type === 'work-wake' || assignment.log === '') return
  appendFileSync(assignment.log, `${JSON.stringify(reply.value)}\n`)
  if (!assignment.replied && reply.value.type === 'work-reply') {
    assignment.replied = true
    sendRaw(directive(assignment.prompt, RAW_AFTER_REPLY_MARKER))
  }
  if (assignment.awaited === 0) return
  assignment.awaited -= 1
  if (assignment.closing && assignment.awaited === 0 && process.connected) channelDisconnect?.()
})

const listen = process.on.bind(process)
process.on = ((event: string, listener: (...args: unknown[]) => void) =>
  listen(event, (...args: unknown[]) => {
    const cancelling =
      event === 'SIGTERM' || (event === 'message' && Option.isSome(decodeCancel(args[0])))
    if (assignment.holdCancel && cancelling) setTimeout(() => listener(...args), HOLD_CANCEL_MS)
    else listener(...args)
  })) as typeof process.on
serveChild({
  modelRuntime: scriptedModelRuntime,
  resolveAddress: host =>
    host.endsWith('.fixture.invalid')
      ? Effect.succeed('127.0.0.1')
      : Effect.fail(
          new WebNetworkError({
            reason: 'destination',
            message: `${host} refused by the child fixture resolver`,
          })
        ),
})
process.on = listen
