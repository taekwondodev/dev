import { randomUUID } from 'node:crypto'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Queue from 'effect/Queue'
import * as Schema from 'effect/Schema'
import type * as Pi from '@earendil-works/pi-coding-agent'
import {
  WorkError,
  WorkResultSchema,
  workResultOutputSchema,
  type AttemptId,
} from './work-domain.ts'
import {
  ControllerWorkMessageSchema,
  CoordinatorWorkInputSchema,
  trackOutcomeAttempts,
  outcomeMessage,
  type ControllerWorkMessage,
  type CoordinationMessage,
} from './work-protocol.ts'
import { errorText } from './error-text.ts'
import { workResultText } from './work-model-text.ts'
import { awaitReply } from './work-child-ipc.ts'
import { waitOnlyCommand, waitRefusal } from './work-wait-guard.ts'

type Reply = Extract<ControllerWorkMessage, { readonly requestId: string }>
type Pending = Extract<ControllerWorkMessage, { readonly type: 'work-pending' }>
type Request =
  | { readonly type: 'work-request'; readonly input: unknown }
  | { readonly type: 'work-idle' }

export const LEAF_OUTCOME_GUIDANCE =
  'Delegated results: verify against files or test output before reporting your own result.'
export const COORDINATOR_TOOL_DESCRIPTION =
  'Start agents for subtasks with delegate. They cannot delegate further. Read-only agents see your checkout, including local changes; writers get separate worktrees without your edits. list, inspect and cancel cover only runs you started; omit id to stop them all. Do independent work or end your turn; results arrive after it ends. Do not sleep, loop or poll for them. Report only after all runs finish and you receive and verify their results.'

const decodeControllerMessage = Schema.decodeUnknownOption(ControllerWorkMessageSchema)
const decodeResult = Schema.decodeUnknownEffect(WorkResultSchema)
const parameters = Schema.toJsonSchemaDocument(CoordinatorWorkInputSchema, {
  onExcessProperty: 'error',
}).schema

const unavailable = (message: string) => new WorkError({ message })

const post = (message: CoordinationMessage, done: (failure?: WorkError) => void): void => {
  if (!process.connected || process.send === undefined) {
    done(unavailable('Cannot reach dev'))
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
    const settle = (result: Effect.Effect<Reply, WorkError>): void => {
      cleanup()
      resume(result)
    }
    const cleanup = awaitReply(process, requestId, {
      disconnected: () => settle(Effect.fail(unavailable('Lost connection to dev'))),
      reply: raw => {
        const reply = decodeControllerMessage(raw)
        if (
          Option.isSome(reply) &&
          reply.value.type !== 'work-wake' &&
          reply.value.type !== 'browser-ready' &&
          reply.value.requestId === requestId
        )
          settle(Effect.succeed(reply.value))
      },
    })
    post({ ...request, requestId }, failure => {
      if (failure !== undefined) settle(Effect.fail(failure))
    })
    return Effect.sync(cleanup)
  }).pipe(
    Effect.timeoutOrElse({
      duration,
      orElse: () => Effect.fail(unavailable('Dev did not reply')),
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
  const end = (message: string) => (): void => {
    Queue.failCauseUnsafe(wakes, Cause.fail(unavailable(message)))
  }
  const onMessage = (raw: unknown): void => {
    const message = decodeControllerMessage(raw)
    if (Option.isSome(message) && message.value.type === 'work-wake')
      Queue.offerUnsafe(wakes, undefined)
  }
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const onDisconnect = end('Lost connection to dev')
      const onAbort = end('Run cancelled')
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
            return Effect.fail(unavailable('Unexpected reply from dev'))
          return reply.ok ? Effect.succeed(reply.result) : Effect.fail(unavailable(reply.error))
        })
      ),
    pending: exchange({ type: 'work-idle' }, '60 seconds').pipe(
      Effect.filterOrFail(
        (reply): reply is Pending => reply.type === 'work-pending',
        () => unavailable('Unexpected reply from dev')
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
  label: 'Delegated work',
  description: COORDINATOR_TOOL_DESCRIPTION,
  promptSnippet: 'Delegate subtasks and inspect results',
  parameters,
  outputSchema: workResultOutputSchema,
  execute: (_toolCallId, input, signal) =>
    Effect.runPromise(
      link.request(input).pipe(
        Effect.flatMap(raw =>
          decodeResult(raw, { onExcessProperty: 'error' }).pipe(
            Effect.mapError(cause =>
              unavailable(`Invalid work result from dev: ${errorText(cause)}`)
            )
          )
        ),
        Effect.map(result => ({
          content: [{ type: 'text' as const, text: workResultText(result) }],
          details: result,
          structuredContent: result,
        }))
      ),
      { signal }
    ),
})

export const coordinatorWaitGuard =
  (link: CoordinatorLink): Pi.ExtensionFactory =>
  pi => {
    pi.on('tool_call', async event => {
      const command = 'command' in event.input ? event.input.command : undefined
      if (event.toolName !== 'bash' || typeof command !== 'string' || !waitOnlyCommand(command))
        return undefined
      const pending = await Effect.runPromise(Effect.option(link.pending))
      if (pending._tag === 'None') return undefined
      const { live, outcomes } = pending.value
      if (live === 0 && outcomes.length === 0) return undefined
      return {
        block: true,
        reason: waitRefusal(`${live} running, ${outcomes.length} results pending`),
      }
    })
  }

export const coordinate = Effect.fn('coordinate')(function* (
  session: Pi.AgentSession,
  link: CoordinatorLink,
  stopped: () => boolean
) {
  const receipts = trackOutcomeAttempts(session.sessionManager)
  while (!stopped()) {
    const pending = yield* link.pending
    const delivered = receipts()
    const fresh = pending.outcomes.filter(entry => !delivered.has(entry.facts.id))
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
        .map(entry => entry.facts.id)
        .filter(id => received.has(id))
      if (acknowledged.length < pending.outcomes.length)
        return yield* unavailable('Dev could not deliver a delegated result')
      yield* link.acknowledge(acknowledged)
    } else if (pending.live === 0) return
    else yield* link.wake
  }
})
