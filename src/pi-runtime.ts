import { execFile } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Config, Effect, FileSystem, Option, Schema } from 'effect'
import type * as Pi from '@earendil-works/pi-coding-agent'
import type * as PiSessions from '../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js'
import type * as PiPaths from '../node_modules/@earendil-works/pi-coding-agent/dist/utils/paths.js'
import { errorText } from './error-text.ts'

export type PiApi = typeof Pi

export class PiError extends Schema.TaggedError<PiError>()('PiError', {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const piFailure = (what: string) => (cause: unknown) =>
  new PiError({ message: `${what}: ${errorText(cause)}`, cause })

export const piInstaller = 'curl -fsSL https://pi.dev/install.sh | sh'

const Manifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  main: Schema.optional(Schema.String),
  types: Schema.optional(Schema.String),
})

const ManagedInstallMarker = Schema.fromJsonString(
  Schema.Struct({
    kind: Schema.Literal('pi-managed-install'),
    schemaVersion: Schema.Literal(1),
    layout: Schema.Literal('releases-v1'),
  })
)

const ReleaseVersion = Schema.String.check(
  Schema.isPattern(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)
)

const whichPi = Effect.callback<string, PiError>(resume => {
  const child = execFile('which', ['pi'], { encoding: 'utf8' }, (cause, stdout) => {
    resume(
      cause
        ? Effect.fail(
            new PiError({ message: `No pi on PATH. Install Pi with: ${piInstaller}`, cause })
          )
        : Effect.succeed(stdout.trim())
    )
  })
  return Effect.sync(() => {
    child.kill()
  })
})

const activeRelease = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const launcher = yield* fs.realPath(yield* whichPi)
  const install = join(dirname(dirname(launcher)), 'install')
  const notManaged = new PiError({
    message: `The pi on PATH (${launcher}) is not a managed installation from the pi.dev installer. Install Pi with: ${piInstaller}`,
  })
  if (basename(dirname(launcher)) !== 'bin') return yield* notManaged
  yield* fs.readFileString(join(install, 'managed-install.json')).pipe(
    Effect.flatMap(Schema.decodeEffect(ManagedInstallMarker)),
    Effect.mapError(() => notManaged)
  )
  const version = yield* fs.readFileString(join(install, 'current-version')).pipe(
    Effect.flatMap(text => Schema.decodeEffect(ReleaseVersion)(text.trim())),
    Effect.mapError(piFailure(`Cannot read the active Pi release in ${install}`))
  )
  return { install, release: join(install, 'releases', version), version }
})

export const resolvePiPackage = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const requested = yield* Config.option(Config.String('DEV_PI_RELEASE'))
  const selected = Option.isSome(requested)
    ? { install: undefined, release: resolve(requested.value), version: undefined }
    : yield* activeRelease
  const root = join(selected.release, 'node_modules', '@earendil-works', 'pi-coding-agent')
  const packageJson = yield* fs
    .readFileString(join(root, 'package.json'))
    .pipe(
      Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Manifest))),
      Effect.mapError(piFailure(`Cannot read the Pi release at ${selected.release}`))
    )
  if (packageJson.name !== '@earendil-works/pi-coding-agent' || !packageJson.main)
    return yield* new PiError({
      message: `The Pi release at ${selected.release} does not contain @earendil-works/pi-coding-agent.`,
    })
  if (selected.version !== undefined && packageJson.version !== selected.version)
    return yield* new PiError({
      message: `The active Pi release ${selected.version} contains Pi ${packageJson.version}. Repair it with: ${piInstaller}`,
    })
  return {
    install: selected.install,
    release: selected.release,
    root,
    version: packageJson.version,
    packageJson,
    entry: join(root, packageJson.main),
  }
}).pipe(
  Effect.mapError(cause =>
    cause instanceof PiError ? cause : piFailure('Cannot resolve the installed Pi release')(cause)
  )
)

export const loadPi = Effect.gen(function* () {
  const packageInfo = yield* resolvePiPackage
  const api: PiApi = yield* Effect.tryPromise({
    try: () => import(pathToFileURL(packageInfo.entry).href),
    catch: piFailure(`Cannot load Pi from ${packageInfo.entry}`),
  })
  for (const name of [
    'createAgentSessionServices',
    'createAgentSessionFromServices',
    'createAgentSessionRuntime',
    'SessionManager',
    'InteractiveMode',
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
    catch: piFailure('Cannot load Pi recent-session discovery'),
  })
  if (typeof sessions.findMostRecentSession !== 'function')
    return yield* new PiError({
      message: 'Installed Pi does not provide read-only recent-session discovery',
    })
  return yield* Effect.try({
    try: () => sessions.findMostRecentSession(sessionsPath, cwd) ?? undefined,
    catch: piFailure('Cannot find recent Pi session'),
  })
})

export const loadPiPathResolver = Effect.fnUntraced(function* (packageRoot: string) {
  const paths: typeof PiPaths = yield* Effect.tryPromise({
    try: () => import(pathToFileURL(join(packageRoot, 'dist/utils/paths.js')).href),
    catch: piFailure('Cannot load Pi path resolution'),
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
      message: `Installed Pi declarations are unavailable at ${root}; repair Pi with ${piInstaller} before checking dev.`,
    })
  }
  const scope = dirname(root)
  const link = fileURLToPath(new URL('../node_modules/@earendil-works', import.meta.url))
  const existing = yield* fs.readLink(link).pipe(Effect.result)
  if (existing._tag === 'Success') {
    if (existing.success === scope) return
    yield* fs.remove(link)
  } else if (existing.failure.reason._tag !== 'NotFound') {
    return yield* new PiError({
      message: `Refusing to replace a non-generated Pi declaration path: ${link}`,
      cause: existing.failure,
    })
  }
  yield* fs.symlink(scope, link)
})
