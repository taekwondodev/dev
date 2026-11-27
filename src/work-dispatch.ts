import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Schema from 'effect/Schema'
import { join } from 'node:path'
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
import { profilesRoot, selectPersonalFile } from './profiles.ts'

const DISPATCH_FILE = 'crew-dispatch.json'

const DEFAULT_DISPATCH = fileURLToPath(
  new URL('../config/default-crew-dispatch.json', import.meta.url)
)

export const DISPATCH_GUIDE = fileURLToPath(new URL('../config/README.md', import.meta.url))

export const dispatchPaths = Effect.map(profilesRoot, root => ({
  personal: join(root, DISPATCH_FILE),
  fallback: DEFAULT_DISPATCH,
}))

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
    const path = yield* dispatchPaths.pipe(
      Effect.flatMap(paths => selectPersonalFile(fs, paths, 'model settings file')),
      Effect.mapError(cause => failure(`Cannot locate model settings: ${errorText(cause)}`, cause))
    )
    return yield* fs.readFileString(path).pipe(
      Effect.flatMap(contents => decodeConfig(contents, { onExcessProperty: 'error' })),
      Effect.map(config => ({
        path,
        configured: true as const,
        rules: config.rules,
        default: config.default,
      })),
      Effect.mapError(cause =>
        failure(`Cannot read model settings at ${path}: ${errorText(cause)}`, cause)
      )
    )
  })

const select = (config: DispatchConfig, input: DispatchInput): DispatchProfile =>
  input.skill !== undefined && Object.hasOwn(config.rules, input.skill)
    ? config.rules[input.skill]
    : config.default

export const resolveDispatch = Effect.fnUntraced(function* (
  input: DispatchInput
): Effect.fn.Return<DispatchProfile, WorkDispatchError, FileSystem.FileSystem> {
  const config = yield* readDispatch
  const selected = select(config, input)
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
