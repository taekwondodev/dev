import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Schema from 'effect/Schema'
import { errorText } from './error-text.ts'

export class ProfileError extends Schema.TaggedError<
  ProfileError,
  { readonly brand: unique symbol }
>()('ProfileError', {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface Profile {
  readonly name: string
  readonly skillPaths: readonly string[]
  readonly soulPath: string
  readonly guidance: string
}

export interface ProfileCatalog {
  readonly manifestPath: string
  readonly defaultProfile: string
  readonly names: readonly string[]
  readonly load: (name: string) => Effect.Effect<Profile, ProfileError, FileSystem.FileSystem>
}

export interface ResourceProvenance {
  readonly path: string
  readonly source: string
  readonly precedence: number
}

export interface ComposedResources {
  readonly skillPaths: readonly string[]
  readonly provenance: readonly ResourceProvenance[]
  readonly guidance: string
  readonly soulPath: string
}

export interface ComposeResourcesOptions {
  readonly cwd: string
  readonly gitRoot: string | undefined
  readonly profile: Profile
}

export const MANIFEST_FILE = 'manifest.json'

const installationRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

const DEFAULT_MANIFEST = join(installationRoot, 'config', 'default-profiles.json')

export const PROFILE_GUIDE = `${join(installationRoot, 'docs', 'launcher.md')}, section "Profiles and resources"`

const toProfileError = (error: unknown, operation: string): ProfileError =>
  error instanceof ProfileError
    ? error
    : new ProfileError({ message: `${operation}: ${errorText(error)}`, cause: error })

const homeDirectory = Effect.sync(() => process.env.HOME ?? process.env.USERPROFILE).pipe(
  Effect.filterOrFail(
    (home): home is string => home !== undefined,
    () => new ProfileError({ message: 'HOME is required to locate shared workflow skills' })
  )
)

export const profilesRoot: Effect.Effect<string, ProfileError> = Config.String('DEV_PROFILES').pipe(
  Config.withDefault(join(installationRoot, 'profiles')),
  Effect.map(path => resolve(path)),
  Effect.mapError(error => toProfileError(error, 'Cannot resolve the profiles directory'))
)

export const manifestPaths: Effect.Effect<
  { readonly personal: string; readonly fallback: string },
  ProfileError
> = Effect.map(profilesRoot, root => ({
  personal: join(root, MANIFEST_FILE),
  fallback: DEFAULT_MANIFEST,
}))

const ProfileLocalPath = Schema.NonEmptyString.check(
  Schema.makeFilter((path: string) =>
    isAbsolute(path) || path.split(/[\\/]/).includes('..')
      ? `"${path}" must be a relative path inside the profiles directory`
      : undefined
  )
)

const ProfileDefinition = Schema.Struct({
  soul: ProfileLocalPath,
  skills: Schema.optional(Schema.Array(ProfileLocalPath)),
})

const Manifest = Schema.fromJsonString(
  Schema.Struct({
    default: Schema.NonEmptyString,
    profiles: Schema.Record(Schema.NonEmptyString, ProfileDefinition),
  }).check(
    Schema.makeFilter(manifest =>
      Object.hasOwn(manifest.profiles, manifest.default)
        ? undefined
        : `default profile "${manifest.default}" is not one of the defined profiles: ${Object.keys(manifest.profiles).join(', ')}`
    )
  )
)

const decodeManifest = Schema.decodeEffect(Manifest)

type ManifestProfiles = typeof Manifest.Type.profiles

const definitionOf = (
  profiles: ManifestProfiles,
  name: string
): ManifestProfiles[string] | undefined =>
  Object.hasOwn(profiles, name) ? profiles[name] : undefined

export const selectPersonalFile = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  paths: { readonly personal: string; readonly fallback: string },
  name: string
) {
  const { personal, fallback } = paths
  const link = yield* fs.readLink(personal).pipe(Effect.orElseSucceed(() => undefined))
  const present = yield* fs.exists(personal).pipe(
    Effect.catchIf(
      error => link !== undefined && error.reason._tag === 'BadResource',
      () => Effect.succeed(false)
    )
  )
  if (present) return personal
  if (link !== undefined)
    return yield* new ProfileError({
      message: `The ${name} ${personal} is a symbolic link to ${link}, which does not exist. Restore the link target or replace the link with the ${name}.`,
    })
  return fallback
})

const selectManifest = Effect.fnUntraced(
  function* (fs: FileSystem.FileSystem, root: string) {
    const path = yield* selectPersonalFile(
      fs,
      { personal: join(root, MANIFEST_FILE), fallback: DEFAULT_MANIFEST },
      'profile manifest'
    )
    return { path, root: path === DEFAULT_MANIFEST ? dirname(DEFAULT_MANIFEST) : root }
  },
  Effect.mapError(error => toProfileError(error, 'Cannot read the profile manifests'))
)

export const loadCatalog: Effect.Effect<ProfileCatalog, ProfileError, FileSystem.FileSystem> =
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const sharedSkills = resolve(yield* homeDirectory, '.agents/skills')
    const { path, root } = yield* selectManifest(fs, yield* profilesRoot)
    const manifest = yield* fs.readFileString(path).pipe(
      Effect.mapError(error => toProfileError(error, `Cannot read the profile manifest ${path}`)),
      Effect.flatMap(text =>
        decodeManifest(text).pipe(
          Effect.mapError(error => toProfileError(error, `Invalid profile manifest ${path}`))
        )
      )
    )
    const names = Object.keys(manifest.profiles)
    const load = Effect.fnUntraced(
      function* (name: string) {
        const definition = definitionOf(manifest.profiles, name)
        if (definition === undefined)
          return yield* new ProfileError({
            message: `Unknown profile "${name}". Choose one of: ${names.join(', ')} (defined in ${path}).`,
          })
        const soulPath = join(root, definition.soul)
        if (!(yield* fs.exists(soulPath)))
          return yield* new ProfileError({
            message: `Profile "${name}" is unavailable: its SOUL ${soulPath} is missing. Restore the file or change its entry in ${path}.`,
          })
        const guidance = yield* fs
          .readFileString(soulPath)
          .pipe(
            Effect.mapError(error =>
              toProfileError(error, `Cannot read SOUL of profile "${name}" at ${soulPath}`)
            )
          )
        return {
          name,
          skillPaths: [...(definition.skills ?? []).map(skill => join(root, skill)), sharedSkills],
          soulPath,
          guidance,
        } satisfies Profile
      },
      (effect, name) =>
        Effect.mapError(effect, error => toProfileError(error, `Cannot load profile "${name}"`))
    )
    return { manifestPath: path, defaultProfile: manifest.default, names, load }
  })

const projectSkillPathCandidates = (
  cwd: string,
  gitRoot: string | undefined
): readonly string[] => {
  const paths: string[] = []
  let current = resolve(cwd)
  const stop = gitRoot === undefined ? undefined : resolve(gitRoot)
  while (true) {
    for (const folder of ['.pi/skills', '.agents/skills']) paths.push(join(current, folder))
    if (stop !== undefined && current === stop) break
    const parent = resolve(current, '..')
    if (parent === current) break
    current = parent
  }
  return paths
}

const existingPaths = (
  fs: FileSystem.FileSystem,
  paths: readonly string[]
): Effect.Effect<readonly string[], unknown> =>
  Effect.forEach(
    paths,
    path => fs.exists(path).pipe(Effect.map(exists => (exists ? path : undefined))),
    { concurrency: 'unbounded' }
  ).pipe(Effect.map(values => values.filter((path): path is string => path !== undefined)))

export const CANNOT_COMPOSE_PROFILE_RESOURCES = 'Cannot compose profile resources'

export const composeResources: (
  options: ComposeResourcesOptions
) => Effect.Effect<ComposedResources, ProfileError, FileSystem.FileSystem> = Effect.fnUntraced(
  function* (options) {
    const fs = yield* FileSystem.FileSystem
    const projectCandidates = projectSkillPathCandidates(options.cwd, options.gitRoot)
    const projectPaths = yield* existingPaths(fs, projectCandidates)
    const candidates = [...projectPaths, ...options.profile.skillPaths]
    const canonical = yield* Effect.forEach(
      candidates,
      path =>
        fs.realPath(path).pipe(
          Effect.map(resolved => ({ path, resolved })),
          Effect.orElseSucceed(() => ({ path, resolved: undefined }))
        ),
      { concurrency: 'unbounded' }
    )
    const seen = new Set<string>()
    const paths = canonical.flatMap(({ path, resolved }) => {
      if (resolved === undefined) return [path]
      if (seen.has(resolved)) return []
      seen.add(resolved)
      return [path]
    })
    const provenance = paths.map((path, index) => ({
      path,
      source: index < projectPaths.length ? 'project' : options.profile.name,
      precedence: index,
    }))
    return {
      skillPaths: paths,
      provenance,
      guidance: options.profile.guidance,
      soulPath: options.profile.soulPath,
    }
  },
  Effect.mapError(error => toProfileError(error, CANNOT_COMPOSE_PROFILE_RESOURCES))
)

export function resourceSummary(resources: ComposedResources): string {
  return resources.provenance.map(({ source, path }) => `${source}: ${path}`).join('\n')
}
