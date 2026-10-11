import { Effect, FileSystem, Schema } from 'effect'
import { fileURLToPath } from 'node:url'
import {
  WorkDispatchError,
  DispatchProfileSchema,
  DispatchRulesSchema,
  type DispatchConfig,
  type DispatchInput,
  type DispatchProfile,
} from './work-domain.ts'
import { errorText } from './error-text.ts'

const DISPATCH_PATH = fileURLToPath(new URL('../config/crew-dispatch.json', import.meta.url))

const ConfigSchema = Schema.fromJsonString(
  Schema.Struct({ rules: DispatchRulesSchema, default: DispatchProfileSchema })
)
const decodeConfig = Schema.decodeUnknownEffect(ConfigSchema)
const decodeProfile = Schema.decodeUnknownEffect(DispatchProfileSchema)

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
      failure(`Cannot read dispatch configuration at ${DISPATCH_PATH}: ${errorText(cause)}`, cause)
    )
  )

const select = (config: DispatchConfig, input: DispatchInput): DispatchProfile =>
  input.skill !== undefined && Object.hasOwn(config.rules, input.skill)
    ? config.rules[input.skill]
    : config.default

export const resolveDispatch = Effect.fnUntraced(function* (
  input: DispatchInput
): Effect.fn.Return<DispatchProfile, WorkDispatchError, FileSystem.FileSystem> {
  const config = yield* readDispatch
  const selected = select(config, input)
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
