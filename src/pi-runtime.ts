import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Config, Effect, FileSystem, Schema } from 'effect'
import type * as Pi from '@earendil-works/pi-coding-agent'
import type * as PiSessions from '../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js'
import type * as PiPaths from '../node_modules/@earendil-works/pi-coding-agent/dist/utils/paths.js'

export type PiApi = typeof Pi

export class PiError extends Schema.TaggedError<PiError>()('PiError', {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const Manifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  main: Schema.optional(Schema.String),
  types: Schema.optional(Schema.String),
})

export const resolvePiPackage = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const requested = yield* Config.String('DEV_PI_EXECUTABLE').pipe(Config.withDefault('pi'))
  const executable = yield* Effect.callback<string, PiError>(resume => {
    const child = execFile('which', [requested], { encoding: 'utf8' }, (cause, stdout) => {
      resume(
        cause
          ? Effect.fail(
              new PiError({
                message: `Cannot resolve the global Pi executable "${requested}". Set DEV_PI_EXECUTABLE to its installed executable: ${cause.message}`,
                cause,
              })
            )
          : Effect.succeed(stdout.trim())
      )
    })
    return Effect.sync(() => {
      child.kill()
    })
  })
  let current = dirname(yield* fs.realPath(executable))
  while (current !== dirname(current)) {
    const manifest = join(current, 'package.json')
    if (yield* fs.exists(manifest)) {
      const packageJson = yield* Schema.decodeEffect(Schema.fromJsonString(Manifest))(
        yield* fs.readFileString(manifest)
      )
      if (packageJson.name === '@earendil-works/pi-coding-agent' && packageJson.main) {
        return {
          root: current,
          version: packageJson.version,
          packageJson,
          entry: join(current, packageJson.main),
        }
      }
    }
    current = dirname(current)
  }
  return yield* new PiError({
    message:
      'The resolved Pi executable is not backed by @earendil-works/pi-coding-agent. No private Pi copy was selected.',
  })
}).pipe(
  Effect.mapError(cause =>
    cause instanceof PiError ? cause : new PiError({ message: cause.message, cause })
  )
)

export const loadPi = Effect.gen(function* () {
  const packageInfo = yield* resolvePiPackage
  const api: PiApi = yield* Effect.tryPromise({
    try: () => import(pathToFileURL(packageInfo.entry).href),
    catch: cause => new PiError({ message: `Cannot load Pi from ${packageInfo.entry}`, cause }),
  })
  for (const name of [
    'createAgentSessionServices',
    'createAgentSessionFromServices',
    'createAgentSessionRuntime',
    'SessionManager',
    'InteractiveMode',
    'loadSkills',
  ] as const) {
    if (typeof api[name] !== 'function')
      return yield* new PiError({ message: `Installed Pi does not provide ${name}` })
  }
  return { api, packageInfo }
})

export const findRecentSession = Effect.fnUntraced(function* (
  packageRoot: string,
  cwd: string,
  sessionsPath: string
) {
  const sessions: typeof PiSessions = yield* Effect.tryPromise({
    try: () => import(pathToFileURL(join(packageRoot, 'dist/core/session-manager.js')).href),
    catch: cause => new PiError({ message: 'Cannot load Pi recent-session discovery', cause }),
  })
  if (typeof sessions.findMostRecentSession !== 'function')
    return yield* new PiError({
      message: 'Installed Pi does not provide read-only recent-session discovery',
    })
  return yield* Effect.try({
    try: () => sessions.findMostRecentSession(sessionsPath, cwd) ?? undefined,
    catch: cause => new PiError({ message: 'Cannot find recent Pi session', cause }),
  })
})

// ADR 0005: /import is classified with Pi's own path resolution.
export const loadPiPathResolver = Effect.fnUntraced(function* (packageRoot: string) {
  const paths: typeof PiPaths = yield* Effect.tryPromise({
    try: () => import(pathToFileURL(join(packageRoot, 'dist/utils/paths.js')).href),
    catch: cause => new PiError({ message: 'Cannot load Pi path resolution', cause }),
  })
  if (typeof paths.resolvePath !== 'function')
    return yield* new PiError({ message: 'Installed Pi does not provide its path resolution' })
  return (input: string): string => paths.resolvePath(input)
})

export const linkPiDeclarations = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const { root, packageJson } = yield* resolvePiPackage
  if (!packageJson.types || !(yield* fs.exists(join(root, packageJson.types)))) {
    return yield* new PiError({
      message: `Installed Pi declarations are unavailable at ${root}; reinstall the global Pi package before checking dev.`,
    })
  }
  const link = fileURLToPath(
    new URL('../node_modules/@earendil-works/pi-coding-agent', import.meta.url)
  )
  yield* fs.makeDirectory(dirname(link), { recursive: true })
  const existing = yield* fs.readLink(link).pipe(Effect.result)
  if (existing._tag === 'Success') {
    if (existing.success === root) return
    yield* fs.remove(link)
  } else if (existing.failure.reason._tag !== 'NotFound') {
    return yield* new PiError({
      message: `Refusing to replace a non-generated Pi declaration path: ${link}`,
      cause: existing.failure,
    })
  }
  yield* fs.symlink(root, link)
})
