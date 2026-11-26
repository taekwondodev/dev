import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
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

export const PROFILE_GUIDE = `${join(installationRoot, 'docs', 'launcher.md')}, section "Profiles and resources"`

const starterRoot = join(installationRoot, 'templates', 'profiles')

const defaultProfilesRoot = join(installationRoot, 'profiles')

const STARTER_FILES = [join('general', 'SOUL.md'), MANIFEST_FILE] as const

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
  Config.withDefault(defaultProfilesRoot),
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

export const loadCatalog: Effect.Effect<ProfileCatalog, ProfileError, FileSystem.FileSystem> =
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = yield* profilesRoot
    const path = join(root, MANIFEST_FILE)
    const sharedSkills = resolve(yield* homeDirectory, '.agents/skills')
    const exists = yield* fs
      .exists(path)
      .pipe(Effect.mapError(error => toProfileError(error, `Cannot read ${path}`)))
    if (!exists) {
      const link = yield* linkTarget(fs, path)
      const override = yield* Config.option(Config.String('DEV_PROFILES')).pipe(
        Effect.mapError(error => toProfileError(error, 'Cannot read DEV_PROFILES'))
      )
      return yield* new ProfileError({
        message:
          link === undefined
            ? `No profile manifest at ${path}. Run \`${Option.isSome(override) ? `DEV_PROFILES=${shellQuoted(root)} ` : ''}npm run setup\` in ${installationRoot} to create a starter profile, or write the manifest yourself (format: ${PROFILE_GUIDE}).`
            : `The profile manifest ${path} is a symbolic link to ${link}, which does not exist. Restore the link target or replace the link with the manifest.`,
      })
    }
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

const linkTarget = (fs: FileSystem.FileSystem, path: string) =>
  fs.readLink(path).pipe(Effect.orElseSucceed(() => undefined))

const occupied = (fs: FileSystem.FileSystem, path: string) =>
  Effect.flatMap(linkTarget(fs, path), target =>
    target === undefined ? fs.exists(path) : Effect.succeed(true)
  )

const shellQuoted = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

const publishOnce = (fs: FileSystem.FileSystem, target: string, content: string) => {
  const staged = `${target}.${process.pid}-${randomUUID()}.partial`
  return fs.writeFileString(staged, content, { flag: 'wx' }).pipe(
    Effect.andThen(fs.link(staged, target)),
    Effect.as(true),
    Effect.catchIf(
      error => error.reason._tag === 'AlreadyExists',
      () => Effect.succeed(false)
    ),
    Effect.ensuring(fs.remove(staged, { force: true }).pipe(Effect.ignore))
  )
}

export const createStarterProfile: Effect.Effect<
  readonly string[],
  ProfileError,
  FileSystem.FileSystem
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = yield* profilesRoot
  const manifest = join(root, MANIFEST_FILE)
  if (yield* occupied(fs, manifest)) return []
  const created: string[] = []
  for (const file of STARTER_FILES) {
    const target = join(root, file)
    const content = yield* fs.readFileString(join(starterRoot, file))
    if (yield* occupied(fs, target)) continue
    yield* fs.makeDirectory(dirname(target), { recursive: true })
    if (yield* publishOnce(fs, target, content)) created.push(target)
  }
  return created
}).pipe(Effect.mapError(error => toProfileError(error, 'Cannot create the starter profile')))

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
