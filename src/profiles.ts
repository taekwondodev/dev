import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Config, Effect, FileSystem, Schema } from 'effect'
import { errorText } from './error-text.ts'

export class ProfileError extends Schema.TaggedError<ProfileError>()('ProfileError', {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface RequiredResource {
  readonly label: string
  readonly path: string
}

export interface Profile {
  readonly name: string
  readonly required: readonly RequiredResource[]
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

const MANIFEST_EXAMPLE =
  '{ "default": "general", "profiles": { "general": { "soul": "general/SOUL.md", "skills": [] } } }'

const installationRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

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

export const manifestPath: Effect.Effect<string, ProfileError> = Effect.map(profilesRoot, root =>
  join(root, MANIFEST_FILE)
)

const ProfileLocalPath = Schema.NonEmptyString.check(
  Schema.makeFilter((path: string) =>
    isAbsolute(path) || path.split(/[\\/]/).includes('..')
      ? `"${path}" must be a relative path inside the profiles directory`
      : undefined
  )
)

const ProfileDefinition = Schema.Struct({
  soul: ProfileLocalPath,
  skills: Schema.Array(ProfileLocalPath),
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

const missingResources = (
  fs: FileSystem.FileSystem,
  required: readonly RequiredResource[]
): Effect.Effect<readonly RequiredResource[], unknown> =>
  Effect.forEach(required, resource =>
    fs.exists(resource.path).pipe(Effect.map(exists => (exists ? undefined : resource)))
  ).pipe(
    Effect.map(resources =>
      resources.filter((resource): resource is RequiredResource => resource !== undefined)
    )
  )

export const loadCatalog: Effect.Effect<ProfileCatalog, ProfileError, FileSystem.FileSystem> =
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = yield* profilesRoot
    const path = join(root, MANIFEST_FILE)
    const sharedSkills = resolve(yield* homeDirectory, '.agents/skills')
    const exists = yield* fs
      .exists(path)
      .pipe(Effect.mapError(error => toProfileError(error, `Cannot read ${path}`)))
    if (!exists)
      return yield* new ProfileError({
        message: `No profile manifest at ${path}. Create it with your profiles, for example: ${MANIFEST_EXAMPLE}`,
      })
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
        const skills = definition.skills.map(skill => ({
          label: `skill ${skill}`,
          path: join(root, skill),
        }))
        const required: readonly RequiredResource[] = [
          { label: 'shared workflow skills', path: sharedSkills },
          { label: `SOUL of profile "${name}"`, path: soulPath },
          ...skills,
        ]
        const missing = yield* missingResources(fs, required)
        if (missing.length > 0)
          return yield* new ProfileError({
            message: `Profile "${name}" is unavailable; missing ${missing.map(({ label, path: resource }) => `${label} at ${resource}`).join(', ')}. Restore the resource or change its entry in ${path}.`,
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
          required,
          skillPaths: [...skills.map(({ path: skill }) => skill), sharedSkills],
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
  Effect.forEach(paths, path =>
    fs.exists(path).pipe(Effect.map(exists => (exists ? path : undefined)))
  ).pipe(Effect.map(values => values.filter((path): path is string => path !== undefined)))

export const composeResources: (
  options: ComposeResourcesOptions
) => Effect.Effect<ComposedResources, ProfileError, FileSystem.FileSystem> = Effect.fnUntraced(
  function* (options) {
    const fs = yield* FileSystem.FileSystem
    const projectCandidates = projectSkillPathCandidates(options.cwd, options.gitRoot)
    const projectPaths = yield* existingPaths(fs, projectCandidates)
    const candidates = [...projectPaths, ...options.profile.skillPaths]
    const canonical = yield* Effect.forEach(candidates, path =>
      fs.realPath(path).pipe(Effect.map(resolved => ({ path, resolved })))
    )
    const seen = new Set<string>()
    const paths = canonical.flatMap(({ path, resolved }) => {
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
  Effect.mapError(error => toProfileError(error, 'Cannot compose profile resources'))
)

export function resourceSummary(resources: ComposedResources): string {
  return resources.provenance.map(({ source, path }) => `${source}: ${path}`).join('\n')
}
