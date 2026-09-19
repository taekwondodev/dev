import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Config, Effect, FileSystem, Predicate, Schema } from 'effect'

export class PreferencesError extends Schema.TaggedError<PreferencesError>()('PreferencesError', {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const PreferenceSchema = Schema.Struct({
  specialization: Schema.optional(Schema.String),
  project: Schema.optional(Schema.String),
})

type Preference = typeof PreferenceSchema.Type

type SelectionSource = 'general default' | 'saved preference' | 'temporary override'

export interface Selection {
  readonly identity: string
  readonly path: string
  readonly specialization: string
  readonly source: SelectionSource
}

export interface ResolveSelectionOptions {
  readonly cwd: string
  readonly dataHome: string
  readonly explicit?: string
}

export interface SaveSelectionOptions {
  readonly cwd: string
  readonly dataHome: string
  readonly specialization: string
}

export interface RuntimeLease {
  readonly path: string
  readonly release: Effect.Effect<void, PreferencesError>
}

const defaultPath = resolve(fileURLToPath(new URL('../.dev/', import.meta.url)))

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const toPreferencesError = (error: unknown, operation: string): PreferencesError =>
  error instanceof PreferencesError
    ? error
    : new PreferencesError({ message: `${operation}: ${messageOf(error)}`, cause: error })

const runGit = (cwd: string, args: readonly string[]): Effect.Effect<string, unknown> =>
  Effect.callback(resume => {
    const child = execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (error, stdout) => {
      if (error) resume(Effect.fail(error))
      else resume(Effect.succeed(stdout.toString().trim()))
    })
    return Effect.sync(() => {
      child.kill()
    })
  })

export const defaultDataHome: Effect.Effect<string, PreferencesError> = Effect.gen(function* () {
  const configured = yield* Config.String('DEV_DATA_HOME').pipe(
    Config.withDefault(defaultPath),
    Effect.mapError(error => toPreferencesError(error, 'Cannot resolve dev data home'))
  )
  return resolve(configured)
})

/**
 * Pi's authentication is account-wide, unlike dev's sessions and operational
 * state. Keep the canonical Pi directory independent from DEV_DATA_HOME.
 */
export const globalPiAgentDir = (): string => join(homedir(), '.pi', 'agent')

export const globalPiAuthPath = (): string => join(globalPiAgentDir(), 'auth.json')

export const gitRoot = (cwd: string): Effect.Effect<string | undefined> =>
  runGit(cwd, ['rev-parse', '--show-toplevel']).pipe(Effect.orElseSucceed(() => undefined))

const projectIdentity = (cwd: string): Effect.Effect<string> =>
  runGit(cwd, ['rev-parse', '--git-common-dir']).pipe(
    Effect.map(commonDir => resolve(cwd, commonDir)),
    Effect.orElseSucceed(() => resolve(cwd))
  )

const preferencePath = (dataHome: string, identity: string): string => {
  const key = createHash('sha256').update(identity).digest('hex').slice(0, 32)
  return join(dataHome, 'preferences', `${key}.json`)
}

const readPreference = (
  path: string
): Effect.Effect<Preference, PreferencesError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    if (!(yield* fs.exists(path))) return {}
    const content = yield* fs.readFileString(path)
    const value = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(content)
    if (!Predicate.isObject(value)) return {}
    return yield* Schema.decodeEffect(PreferenceSchema)(value)
  }).pipe(Effect.mapError(error => toPreferencesError(error, `Cannot read dev preference ${path}`)))

export const resolveSelection = (
  options: ResolveSelectionOptions
): Effect.Effect<Selection, PreferencesError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const identity = yield* projectIdentity(options.cwd)
    const path = preferencePath(options.dataHome, identity)
    const saved = (yield* readPreference(path)).specialization
    let source: SelectionSource = 'general default'
    if (saved !== undefined) source = 'saved preference'
    if (options.explicit !== undefined) source = 'temporary override'
    return {
      identity,
      path,
      specialization: options.explicit ?? saved ?? 'general',
      source,
    }
  }).pipe(
    Effect.mapError(error => toPreferencesError(error, 'Cannot resolve specialization selection'))
  )

export const saveSelection = (
  options: SaveSelectionOptions
): Effect.Effect<string, PreferencesError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const identity = yield* projectIdentity(options.cwd)
    const path = preferencePath(options.dataHome, identity)
    yield* fs.makeDirectory(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${process.pid}.tmp`
    yield* fs.writeFileString(
      temporary,
      `${JSON.stringify({ specialization: options.specialization, project: identity }, null, 2)}\n`,
      { mode: 0o600 }
    )
    yield* fs.rename(temporary, path)
    return path
  }).pipe(
    Effect.mapError(error => toPreferencesError(error, 'Cannot save specialization selection'))
  )

export const sessionDir = (
  dataHome: string
): Effect.Effect<string, PreferencesError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const path = join(dataHome, 'sessions')
    yield* FileSystem.FileSystem.pipe(
      Effect.flatMap(fs => fs.makeDirectory(path, { recursive: true, mode: 0o700 }))
    )
    return path
  }).pipe(Effect.mapError(error => toPreferencesError(error, 'Cannot prepare session directory')))

const runtimeLockPath = (dataHome: string): string => join(dataHome, 'runtime.lock')

const staleProcessError = (error: unknown): boolean =>
  Predicate.isObject(error) &&
  Predicate.isString(error.code) &&
  (error.code === 'ESRCH' || error.code === 'ENOENT')

class ProcessProbeError extends Schema.TaggedError<ProcessProbeError>()('ProcessProbeError', {
  message: Schema.String,
  code: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {}

const toProcessProbeError = (error: unknown): ProcessProbeError => {
  const code = Predicate.isObject(error) && Predicate.isString(error.code) ? error.code : undefined
  return new ProcessProbeError({ message: messageOf(error), code, cause: error })
}

const RuntimeLockSchema = Schema.Struct({ pid: Schema.Finite })

type RuntimeLock = typeof RuntimeLockSchema.Type

class RuntimeLockJsonError extends Schema.TaggedError<RuntimeLockJsonError>()(
  'RuntimeLockJsonError',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }
) {}

const readRuntimeLock = (
  fs: FileSystem.FileSystem,
  path: string
): Effect.Effect<RuntimeLock | undefined, PreferencesError> =>
  Effect.gen(function* () {
    const content = yield* fs.readFileString(path)
    const parsed = yield* Effect.try({
      try: (): unknown => JSON.parse(content),
      catch: error => new RuntimeLockJsonError({ message: messageOf(error), cause: error }),
    }).pipe(
      Effect.catchTag('RuntimeLockJsonError', error =>
        error.cause instanceof SyntaxError
          ? fs.remove(path, { force: true }).pipe(
              Effect.as(undefined),
              Effect.mapError(cause =>
                toPreferencesError(cause, `Cannot remove malformed runtime lock ${path}`)
              )
            )
          : Effect.fail(toPreferencesError(error, `Invalid runtime lock ${path}`))
      )
    )
    if (parsed === undefined) return undefined
    if (!Predicate.isObject(parsed))
      return yield* new PreferencesError({ message: `Invalid runtime lock at ${path}` })
    return yield* Schema.decodeUnknownEffect(RuntimeLockSchema)(parsed)
  }).pipe(
    Effect.mapError(error => toPreferencesError(error, `Cannot inspect runtime lock ${path}`))
  )

export const assertNoActiveRuntime = (
  dataHome: string
): Effect.Effect<void, PreferencesError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = runtimeLockPath(dataHome)
    if (!(yield* fs.exists(path))) return
    const lock = yield* readRuntimeLock(fs, path)
    if (lock === undefined) return
    if (!Number.isSafeInteger(lock.pid) || lock.pid < 1)
      return yield* new PreferencesError({ message: `Invalid runtime lock at ${path}` })
    const result = yield* Effect.result(
      Effect.try({
        try: () => {
          process.kill(lock.pid, 0)
        },
        catch: toProcessProbeError,
      })
    )
    if (result._tag === 'Success')
      return yield* new PreferencesError({
        message: `A dev session is active for ${dataHome}; stop it before updating or rolling back.`,
      })
    if (staleProcessError(result.failure)) {
      yield* fs.remove(path, { force: true })
      return
    }
    return yield* new PreferencesError({
      message: `A dev session is active for ${dataHome}; stop it before updating or rolling back.`,
    })
  }).pipe(Effect.mapError(error => toPreferencesError(error, 'Cannot check active dev runtime')))

export const acquireRuntime = (
  dataHome: string
): Effect.Effect<RuntimeLease, PreferencesError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(dataHome, { recursive: true, mode: 0o700 })
    yield* assertNoActiveRuntime(dataHome)
    const path = runtimeLockPath(dataHome)
    yield* fs.writeFileString(path, `${JSON.stringify({ pid: process.pid })}\n`, {
      flag: 'wx',
      mode: 0o600,
    })
    return {
      path,
      release: fs
        .remove(path, { force: true })
        .pipe(
          Effect.mapError(error => toPreferencesError(error, `Cannot release runtime lock ${path}`))
        ),
    }
  }).pipe(Effect.mapError(error => toPreferencesError(error, 'Cannot acquire dev runtime')))
