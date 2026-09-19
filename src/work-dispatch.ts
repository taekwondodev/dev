import { Effect, FileSystem, Schema } from 'effect'
import { fileURLToPath } from 'node:url'
import {
  WorkDispatchError,
  DispatchProfileSchema,
  DispatchRuleSchema,
  type DispatchConfig,
  type DispatchInput,
  type DispatchProfile,
  type DispatchRule,
} from './work-domain.ts'

const DISPATCH_PATH = fileURLToPath(new URL('../config/crew-dispatch.json', import.meta.url))

const profileKeys = new Set(['harness', 'model', 'effort'])
const configKeys = new Set(['rules', 'default'])
const ruleKeys = new Set(['when', 'use', 'why'])

const ConfigSchema = Schema.Struct({
  rules: Schema.optional(Schema.Array(DispatchRuleSchema)),
  default: Schema.optional(DispatchProfileSchema),
})

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const failure = (message: string, cause?: unknown): WorkDispatchError =>
  new WorkDispatchError({ message, ...(cause === undefined ? {} : { cause }) })

const validateRawProfileKeys = (value: unknown): void => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      'Dispatch profiles must be single objects; quota candidate arrays are unsupported'
    )
  }
  const unknown = Object.keys(value).find(key => !profileKeys.has(key))
  if (unknown !== undefined) throw new Error(`Unsupported dispatch field: ${unknown}`)
}

const validateProfile = (value: DispatchProfile): DispatchProfile => {
  const keys = Object.keys(value as object)
  if (keys.some(key => !profileKeys.has(key))) {
    throw new Error(`Unsupported dispatch field: ${keys.find(key => !profileKeys.has(key))}`)
  }
  if (value.harness !== 'pi') {
    throw new Error(`Unsupported harness: ${value.harness}; only pi is available`)
  }
  if (value.model !== undefined && !value.model.trim()) {
    throw new Error('Dispatch model must be a nonempty model identifier')
  }

  return value
}

const parseConfig = (input: unknown): DispatchConfig => {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid dispatch configuration')
  }
  const raw = input as Record<string, unknown>
  const unknownConfigKey = Object.keys(raw).find(key => !configKeys.has(key))
  if (unknownConfigKey !== undefined) throw new Error('Dispatch supports only rules and default')
  if (raw.rules !== undefined) {
    if (!Array.isArray(raw.rules)) throw new Error('Dispatch rules must be an array')
    for (const rawRule of raw.rules) {
      if (rawRule === null || typeof rawRule !== 'object' || Array.isArray(rawRule))
        throw new Error('Invalid dispatch rule')
      const unknownRuleKey = Object.keys(rawRule).find(key => !ruleKeys.has(key))
      if (unknownRuleKey !== undefined) throw new Error('Invalid dispatch rule')
      validateRawProfileKeys((rawRule as Record<string, unknown>).use)
    }
  }
  if (raw.default !== undefined) validateRawProfileKeys(raw.default)
  const decoded = Schema.decodeSync(ConfigSchema)(raw)
  const rules: readonly DispatchRule[] = decoded.rules ?? []
  for (const rule of rules) {
    if (!rule.when.trim()) throw new Error('Invalid dispatch rule')
    validateProfile(rule.use)
  }
  const selected = decoded.default ?? { harness: 'pi' as const }
  validateProfile(selected)
  return { path: DISPATCH_PATH, configured: true, rules, default: selected }
}

export const readDispatch: Effect.Effect<DispatchConfig, WorkDispatchError, FileSystem.FileSystem> =
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const contents = yield* fs.readFileString(DISPATCH_PATH)
    return yield* Effect.try({
      try: () => parseConfig(JSON.parse(contents)),
      catch: cause =>
        failure(
          `Cannot read dispatch configuration at ${DISPATCH_PATH}: ${messageOf(cause)}`,
          cause
        ),
    })
  }).pipe(
    Effect.mapError(cause =>
      cause instanceof WorkDispatchError
        ? cause
        : failure(
            `Cannot read dispatch configuration at ${DISPATCH_PATH}: ${messageOf(cause)}`,
            cause
          )
    )
  )

export const resolveDispatch = (
  input: DispatchInput
): Effect.Effect<DispatchProfile, WorkDispatchError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const config = yield* readDispatch
    let selected = config.default
    if (config.rules.length > 0 && input.rule === undefined) {
      return yield* new WorkDispatchError({
        message:
          'Read work dispatch, choose a rule index or "default", then pass that selection explicitly',
      })
    }
    if (input.rule !== undefined && input.rule !== 'default') {
      if (
        !/^(0|[1-9]\d*)$/.test(input.rule) ||
        !Number.isSafeInteger(Number(input.rule)) ||
        config.rules[Number(input.rule)] === undefined
      ) {
        return yield* new WorkDispatchError({ message: 'Invalid dispatch rule index' })
      }
      selected = config.rules[Number(input.rule)].use
    }
    if (input.harness !== undefined && input.harness !== 'pi') {
      return yield* new WorkDispatchError({
        message: `Unsupported harness: ${input.harness}; only pi is available`,
      })
    }
    const harness: 'pi' = input.harness === undefined ? selected.harness : 'pi'
    const profile = yield* Schema.decodeUnknownEffect(DispatchProfileSchema)({
      harness,
      ...(selected.model === undefined ? {} : { model: selected.model }),
      ...(selected.effort === undefined ? {} : { effort: selected.effort }),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.effort === undefined ? {} : { effort: input.effort }),
    })
    return yield* Effect.try({
      try: () => validateProfile(profile),
      catch: cause => failure(messageOf(cause), cause),
    })
  }).pipe(
    Effect.mapError(cause =>
      cause instanceof WorkDispatchError ? cause : failure(messageOf(cause), cause)
    )
  )

export const quotaExhausted = (message: string | undefined): boolean =>
  /insufficient_quota|quota.{0,40}(exceed|exhaust)|usage.limit|usage_limit|credit.balance|billing.hard.limit|subscription.{0,40}(limit|exhaust)/i.test(
    message ?? ''
  )

export const dispatchConfigPath = DISPATCH_PATH
