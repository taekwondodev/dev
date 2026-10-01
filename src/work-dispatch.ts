import { Effect, FileSystem, Schema } from 'effect'
import { fileURLToPath } from 'node:url'
import {
  WorkDispatchError,
  DispatchProfileSchema,
  DispatchRulesSchema,
  skillInvocation,
  type DispatchConfig,
  type DispatchInput,
  type DispatchProfile,
} from './work-domain.ts'

const DISPATCH_PATH = fileURLToPath(new URL('../config/crew-dispatch.json', import.meta.url))

const ConfigSchema = Schema.fromJsonString(
  Schema.Struct({ rules: DispatchRulesSchema, default: DispatchProfileSchema })
)
const decodeConfig = Schema.decodeUnknownEffect(ConfigSchema)
const decodeProfile = Schema.decodeUnknownEffect(DispatchProfileSchema)

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const failure = (message: string, cause?: unknown): WorkDispatchError =>
  new WorkDispatchError({ message, ...(cause === undefined ? {} : { cause }) })

export const readDispatch: Effect.Effect<DispatchConfig, WorkDispatchError, FileSystem.FileSystem> =
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const contents = yield* fs.readFileString(DISPATCH_PATH)
    const config = yield* decodeConfig(contents, { onExcessProperty: 'error' })
    return {
      path: DISPATCH_PATH,
      configured: true as const,
      rules: config.rules,
      default: config.default,
    }
  }).pipe(
    Effect.mapError(cause =>
      failure(`Cannot read dispatch configuration at ${DISPATCH_PATH}: ${messageOf(cause)}`, cause)
    )
  )

const select = (
  config: DispatchConfig,
  input: DispatchInput
): Effect.Effect<DispatchProfile, WorkDispatchError> => {
  if (input.rule === undefined) {
    const name = skillInvocation(input.prompt)?.name
    return Effect.succeed(
      name !== undefined && Object.hasOwn(config.rules, name) ? config.rules[name] : config.default
    )
  }
  if (input.rule === 'default') return Effect.succeed(config.default)
  return Object.hasOwn(config.rules, input.rule)
    ? Effect.succeed(config.rules[input.rule])
    : Effect.fail(
        failure(`Unknown dispatch rule "${input.rule}"; pass a configured skill name or "default"`)
      )
}

export const resolveDispatch = Effect.fnUntraced(function* (
  input: DispatchInput
): Effect.fn.Return<DispatchProfile, WorkDispatchError, FileSystem.FileSystem> {
  const config = yield* readDispatch
  const selected = yield* select(config, input)
  if (input.harness !== undefined && input.harness !== 'pi') {
    return yield* failure(`Unsupported harness: ${input.harness}; only pi is available`)
  }
  return yield* decodeProfile({
    harness: 'pi',
    ...(selected.model === undefined ? {} : { model: selected.model }),
    ...(selected.effort === undefined ? {} : { effort: selected.effort }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.effort === undefined ? {} : { effort: input.effort }),
  }).pipe(Effect.mapError(cause => failure(cause.message, cause)))
})

export const quotaExhausted = (message: string | undefined): boolean =>
  /insufficient_quota|quota.{0,40}(exceed|exhaust)|usage.limit|usage_limit|credit.balance|billing.hard.limit|subscription.{0,40}(limit|exhaust)/i.test(
    message ?? ''
  )
