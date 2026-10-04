import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Config, Effect, FileSystem, Schema } from 'effect'
import { errorText } from './error-text.ts'

export class PreferencesError extends Schema.TaggedError<PreferencesError>()('PreferencesError', {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const PreferenceSchema = Schema.Struct({
  profile: Schema.optional(Schema.String),
  project: Schema.optional(Schema.String),
})

const decodePreference = Schema.decodeEffect(Schema.fromJsonString(PreferenceSchema))

type SelectionSource = 'general default' | 'saved preference' | 'temporary override'

export interface Selection {
  readonly identity: string
  readonly path: string
  readonly profile: string
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
  readonly profile: string
}

const defaultPath = resolve(fileURLToPath(new URL('../.dev/', import.meta.url)))

const toPreferencesError = (error: unknown, operation: string): PreferencesError =>
  error instanceof PreferencesError
    ? error
    : new PreferencesError({ message: `${operation}: ${errorText(error)}`, cause: error })

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

const readPreference = Effect.fnUntraced(
  function* (path: string) {
    const fs = yield* FileSystem.FileSystem
    if (!(yield* fs.exists(path))) return {}
    return yield* decodePreference(yield* fs.readFileString(path))
  },
  (effect, path) =>
    Effect.mapError(effect, error =>
      toPreferencesError(error, `Cannot read dev preference ${path}`)
    )
)

export const resolveSelection: (
  options: ResolveSelectionOptions
) => Effect.Effect<Selection, PreferencesError, FileSystem.FileSystem> = Effect.fnUntraced(
  function* (options) {
    const identity = yield* projectIdentity(options.cwd)
    const path = preferencePath(options.dataHome, identity)
    const saved = (yield* readPreference(path)).profile
    let source: SelectionSource = 'general default'
    if (saved !== undefined) source = 'saved preference'
    if (options.explicit !== undefined) source = 'temporary override'
    return {
      identity,
      path,
      profile: options.explicit ?? saved ?? 'general',
      source,
    }
  },
  Effect.mapError(error => toPreferencesError(error, 'Cannot resolve profile selection'))
)

export const saveSelection: (
  options: SaveSelectionOptions
) => Effect.Effect<string, PreferencesError, FileSystem.FileSystem> = Effect.fnUntraced(
  function* (options) {
    const fs = yield* FileSystem.FileSystem
    const identity = yield* projectIdentity(options.cwd)
    const path = preferencePath(options.dataHome, identity)
    yield* fs.makeDirectory(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${process.pid}.tmp`
    yield* fs.writeFileString(
      temporary,
      `${JSON.stringify({ profile: options.profile, project: identity }, null, 2)}\n`,
      { mode: 0o600 }
    )
    yield* fs.rename(temporary, path)
    return path
  },
  Effect.mapError(error => toPreferencesError(error, 'Cannot save profile selection'))
)

export const sessionDir: (
  dataHome: string
) => Effect.Effect<string, PreferencesError, FileSystem.FileSystem> = Effect.fnUntraced(
  function* (dataHome) {
    const path = join(dataHome, 'sessions')
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(path, { recursive: true, mode: 0o700 })
    return path
  },
  Effect.mapError(error => toPreferencesError(error, 'Cannot prepare session directory'))
)
