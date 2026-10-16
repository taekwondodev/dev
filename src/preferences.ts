import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  lstatSync,
  readdirSync,
  readFileSync,
  unlinkSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Config, Context, Effect, FileSystem, Layer, Schema } from 'effect'
import { errorText } from './error-text.ts'
import { acquireExclusiveLock } from './runtime-coordination.ts'

export class PreferencesError extends Schema.TaggedError<
  PreferencesError,
  { readonly brand: unique symbol }
>()('PreferencesError', {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const PreferenceSchema = Schema.Struct({
  profile: Schema.optional(Schema.String),
  project: Schema.optional(Schema.String),
})

const decodePreference = Schema.decodeEffect(Schema.fromJsonString(PreferenceSchema))

type SelectionSource = 'configured default' | 'saved preference' | 'temporary override'

export interface Selection {
  readonly identity: string
  readonly path: string
  readonly profile: string
  readonly source: SelectionSource
}

export interface ResolveSelectionOptions {
  readonly cwd: string
  readonly dataHome: string
  readonly defaultProfile: string
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

export class RepositoryRoot extends Context.Service<
  RepositoryRoot,
  { readonly resolve: (cwd: string) => Effect.Effect<string | undefined> }
>()('dev/preferences/RepositoryRoot') {
  static readonly layer = Layer.succeed(RepositoryRoot, RepositoryRoot.of({ resolve: gitRoot }))
}

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
    let source: SelectionSource = 'configured default'
    if (saved !== undefined) source = 'saved preference'
    if (options.explicit !== undefined) source = 'temporary override'
    return {
      identity,
      path,
      profile: options.explicit ?? saved ?? options.defaultProfile,
      source,
    }
  },
  Effect.mapError(error => toPreferencesError(error, 'Cannot resolve profile selection'))
)

const withPreferencePublication = <A, E, R>(
  directory: string,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E | PreferencesError, R> =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        if (!lstatSync(directory).isDirectory())
          throw new Error(`Preference directory must not be a symlink: ${directory}`)
        return acquireExclusiveLock(
          join(directory, '.publication.sqlite'),
          'Preference publication is in progress'
        )
      },
      catch: cause => toPreferencesError(cause, 'Cannot acquire preference publication'),
    }),
    () => effect,
    release => Effect.sync(release)
  )

export const cleanPreferenceTemporaries = Effect.fnUntraced(function* (dataHome: string) {
  const fs = yield* FileSystem.FileSystem
  const directory = join(dataHome, 'preferences')
  if (!(yield* fs.exists(directory))) return 0
  return yield* withPreferencePublication(
    directory,
    Effect.try({
      try: () => {
        let removed = 0
        for (const name of readdirSync(directory)) {
          if (!/^[a-f0-9]{32}\.json\.[1-9][0-9]*\.tmp$/.test(name)) continue
          const path = join(directory, name)
          const info = lstatSync(path)
          if (!info.isFile() || info.nlink !== 1) continue
          const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
          try {
            const opened = fstatSync(descriptor)
            if (
              !opened.isFile() ||
              opened.nlink !== 1 ||
              opened.ino !== info.ino ||
              opened.dev !== info.dev
            )
              continue
            const decoded = Schema.decodeOption(Schema.fromJsonString(PreferenceSchema))(
              readFileSync(descriptor, 'utf8')
            )
            if (decoded._tag === 'None') continue
          } finally {
            closeSync(descriptor)
          }
          const current = lstatSync(path)
          if (
            !current.isFile() ||
            current.nlink !== 1 ||
            current.ino !== info.ino ||
            current.dev !== info.dev ||
            current.mtimeMs !== info.mtimeMs
          )
            continue
          unlinkSync(path)
          removed += 1
        }
        return removed
      },
      catch: cause => toPreferencesError(cause, 'Cannot clean preference temporaries'),
    })
  )
})

export const saveSelection: (
  options: SaveSelectionOptions
) => Effect.Effect<string, PreferencesError, FileSystem.FileSystem> = Effect.fnUntraced(
  function* (options) {
    const fs = yield* FileSystem.FileSystem
    const identity = yield* projectIdentity(options.cwd)
    const path = preferencePath(options.dataHome, identity)
    yield* fs.makeDirectory(dirname(path), { recursive: true, mode: 0o700 })
    yield* withPreferencePublication(
      dirname(path),
      Effect.gen(function* () {
        const temporary = `${path}.${process.pid}.tmp`
        yield* fs.writeFileString(
          temporary,
          `${JSON.stringify({ profile: options.profile, project: identity }, null, 2)}\n`,
          { mode: 0o600 }
        )
        yield* fs.rename(temporary, path)
      })
    )
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
