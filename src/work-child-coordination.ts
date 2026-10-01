import { randomUUID } from 'node:crypto'
import { Cause, Effect, Option, Queue, Schema } from 'effect'
import type * as Pi from '@earendil-works/pi-coding-agent'
import { WorkError, type AttemptId } from './work-domain.ts'
import {
  ControllerWorkMessageSchema,
  CoordinatorWorkInputSchema,
  trackOutcomeAttempts,
  outcomeMessage,
  type ControllerWorkMessage,
  type CoordinationMessage,
} from './work-protocol.ts'
import { errorText } from './error-text.ts'

type Reply = Extract<ControllerWorkMessage, { readonly requestId: string }>
type Pending = Extract<ControllerWorkMessage, { readonly type: 'work-pending' }>
type Request =
  | { readonly type: 'work-request'; readonly input: unknown }
  | { readonly type: 'work-idle' }

const LEAF_OUTCOME_GUIDANCE =
  'Leaf outcomes. These are producer observations, not verification; reconcile them before you report your own result.'
const COORDINATOR_TOOL_DESCRIPTION =
  'Coordinate leaf children for this assignment. delegate starts a separate Pi child from a focused self-contained prompt; start the prompt with /skill:name to load one skill. Dispatch resolves from that /skill: prefix when a rule is configured for it, otherwise the default; pass rule only to override with a configured skill name or "default"; pass model or effort only when the user asked for that model or effort, otherwise let dispatch resolve. A read-only leaf reads your workspace as it is, uncommitted files included; a writer leaf gets its own managed worktree without your changes. Leaves cannot delegate. Outcomes arrive as a message after your turn ends: end the turn instead of polling. list, inspect and cancel cover only your own leaves; cancel with no id stops all of them. Your result is reported only after every leaf has settled and its outcome has reached you. Outcomes are producer observations, not verification.'

const decodeControllerMessage = Schema.decodeUnknownOption(ControllerWorkMessageSchema)
const parameters = Schema.toJsonSchemaDocument(CoordinatorWorkInputSchema, {
  onExcessProperty: 'error',
}).schema

const unavailable = (message: string) => new WorkError({ message })

const post = (message: CoordinationMessage, done: (failure?: WorkError) => void): void => {
  if (!process.connected || process.send === undefined) {
    done(unavailable('Work controller IPC is unavailable'))
    return
  }
  try {
    process.send(message, (cause: Error | null) =>
      done(cause === null ? undefined : unavailable(errorText(cause)))
    )
  } catch (cause) {
    done(unavailable(errorText(cause)))
  }
}

const exchange = (
  request: Request,
  duration: `${number} seconds`
): Effect.Effect<Reply, WorkError> =>
  Effect.callback<Reply, WorkError>(resume => {
    const requestId = randomUUID()
    const cleanup = (): void => {
      process.removeListener('message', onMessage)
      process.removeListener('disconnect', onDisconnect)
    }
    const settle = (result: Effect.Effect<Reply, WorkError>): void => {
      cleanup()
      resume(result)
    }
    const onDisconnect = (): void =>
      settle(Effect.fail(unavailable('Work controller disconnected')))
    const onMessage = (raw: unknown): void => {
      const reply = decodeControllerMessage(raw)
      if (
        Option.isSome(reply) &&
        reply.value.type !== 'work-wake' &&
        reply.value.requestId === requestId
      )
        settle(Effect.succeed(reply.value))
    }
    process.on('message', onMessage)
    process.on('disconnect', onDisconnect)
    post({ ...request, requestId }, failure => {
      if (failure !== undefined) settle(Effect.fail(failure))
    })
    return Effect.sync(cleanup)
  }).pipe(
    Effect.timeoutOrElse({
      duration,
      orElse: () => Effect.fail(unavailable('Work controller did not answer')),
    })
  )

export interface CoordinatorLink {
  readonly request: (input: unknown) => Effect.Effect<unknown, WorkError>
  readonly pending: Effect.Effect<Pending, WorkError>
  readonly acknowledge: (attempts: readonly AttemptId[]) => Effect.Effect<void, WorkError>
  readonly wake: Effect.Effect<void, WorkError>
}

export const acquireCoordinatorLink = Effect.fnUntraced(function* (
  signal: AbortSignal | undefined
) {
  const wakes = yield* Queue.sliding<void, WorkError>(1)
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const end = (message: string) => (): void => {
        Queue.failCauseUnsafe(wakes, Cause.fail(unavailable(message)))
      }
      const onMessage = (raw: unknown): void => {
        const message = decodeControllerMessage(raw)
        if (Option.isSome(message) && message.value.type === 'work-wake')
          Queue.offerUnsafe(wakes, undefined)
      }
      const onDisconnect = end('Work controller disconnected')
      const onAbort = end('Child run cancelled')
      process.on('message', onMessage)
      process.on('disconnect', onDisconnect)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
      return (): void => {
        process.removeListener('message', onMessage)
        process.removeListener('disconnect', onDisconnect)
        signal?.removeEventListener('abort', onAbort)
      }
    }),
    remove => Effect.sync(remove)
  )
  const link: CoordinatorLink = {
    request: input =>
      exchange({ type: 'work-request', input }, '180 seconds').pipe(
        Effect.flatMap(reply => {
          if (reply.type !== 'work-reply')
            return Effect.fail(unavailable('Work controller sent an unexpected reply'))
          return reply.ok ? Effect.succeed(reply.result) : Effect.fail(unavailable(reply.error))
        })
      ),
    pending: exchange({ type: 'work-idle' }, '60 seconds').pipe(
      Effect.filterOrFail(
        (reply): reply is Pending => reply.type === 'work-pending',
        () => unavailable('Work controller sent an unexpected reply')
      )
    ),
    acknowledge: attempts =>
      Effect.callback<void, WorkError>(resume => {
        post({ type: 'work-outcomes-ack', attempts }, failure =>
          resume(failure === undefined ? Effect.void : Effect.fail(failure))
        )
      }),
    wake: Queue.take(wakes),
  }
  return link
})

export const createCoordinatorWorkTool = (link: CoordinatorLink): Pi.ToolDefinition => ({
  name: 'work',
  label: 'Leaf work',
  description: COORDINATOR_TOOL_DESCRIPTION,
  promptSnippet: 'Delegate leaf children and inspect their outcomes',
  parameters,
  execute: (_toolCallId, input, signal) =>
    Effect.runPromise(
      link.request(input).pipe(
        Effect.map(result => ({
          content: [{ type: 'text' as const, text: JSON.stringify(result ?? {}) }],
          details: undefined,
        }))
      ),
      { signal }
    ),
})

export const coordinate = Effect.fn('coordinate')(function* (
  session: Pi.AgentSession,
  link: CoordinatorLink,
  stopped: () => boolean
) {
  const receipts = trackOutcomeAttempts(session.sessionManager)
  while (!stopped()) {
    const pending = yield* link.pending
    const delivered = receipts()
    const fresh = pending.outcomes.filter(outcome => !delivered.has(outcome.id))
    if (fresh.length > 0)
      yield* Effect.tryPromise({
        try: async () => {
          await session.sendCustomMessage(outcomeMessage(fresh, LEAF_OUTCOME_GUIDANCE), {
            triggerTurn: true,
          })
          await session.waitForIdle()
        },
        catch: cause => unavailable(errorText(cause)),
      })
    if (pending.outcomes.length > 0) {
      const received = receipts()
      const acknowledged = pending.outcomes
        .map(outcome => outcome.id)
        .filter(id => received.has(id))
      if (acknowledged.length < pending.outcomes.length)
        return yield* unavailable('A leaf outcome did not reach the coordinator conversation')
      yield* link.acknowledge(acknowledged)
    } else if (pending.live === 0) return
    else yield* link.wake
  }
})
