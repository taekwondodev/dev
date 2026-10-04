import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect, FileSystem, Schema } from 'effect'
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

const homeDirectory = Effect.sync(() => process.env.HOME ?? process.env.USERPROFILE).pipe(
  Effect.filterOrFail(
    (home): home is string => home !== undefined,
    () => new ProfileError({ message: 'HOME is required to locate shared workflow skills' })
  )
)

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const generalSoul = join(projectRoot, 'profiles/general/SOUL.md')
const appleSkillsRoot = join(projectRoot, 'profiles/apple/skills')
const appleSoul = join(projectRoot, 'profiles/apple/SOUL.md')
const appleSkillNames: readonly string[] = [
  'swiftui-pro',
  'swift-concurrency-pro',
  'swift-testing-pro',
  'swiftdata-pro',
]

const toProfileError = (error: unknown, operation: string): ProfileError =>
  error instanceof ProfileError
    ? error
    : new ProfileError({ message: `${operation}: ${errorText(error)}`, cause: error })

const definitions = homeDirectory.pipe(
  Effect.map(home => {
    const sharedSkills = resolve(home, '.agents/skills')
    const appleSkills = appleSkillNames.map(name => join(appleSkillsRoot, name))
    return {
      general: {
        name: 'general',
        required: [
          { label: 'shared workflow skills', path: sharedSkills },
          { label: 'general SOUL.md', path: generalSoul },
        ],
        skillPaths: [sharedSkills],
        soulPath: generalSoul,
      },
      apple: {
        name: 'apple',
        required: [
          { label: 'shared workflow skills', path: sharedSkills },
          { label: 'Apple SOUL.md', path: appleSoul },
          ...appleSkills.map((path, index) => ({
            label: `Apple skill ${appleSkillNames[index]}`,
            path,
          })),
        ],
        skillPaths: [...appleSkills, sharedSkills],
        soulPath: appleSoul,
      },
    }
  })
)

export function profileNames(): readonly string[] {
  return ['general', 'apple']
}

export const getProfile: (
  name: string
) => Effect.Effect<Profile, ProfileError, FileSystem.FileSystem> = Effect.fnUntraced(
  function* (name) {
    const fs = yield* FileSystem.FileSystem
    const values = yield* definitions
    let profile: (typeof values)[keyof typeof values] | undefined
    if (name === 'general') profile = values.general
    else if (name === 'apple') profile = values.apple
    if (profile === undefined)
      return yield* new ProfileError({
        message: `Unknown profile "${name}". Choose one of: ${profileNames().join(', ')}.`,
      })
    const missing = yield* Effect.forEach(profile.required, resource =>
      fs.exists(resource.path).pipe(Effect.map(exists => (exists ? undefined : resource)))
    ).pipe(
      Effect.map(resources =>
        resources.filter((resource): resource is RequiredResource => resource !== undefined)
      )
    )
    if (missing.length > 0)
      return yield* new ProfileError({
        message: `Profile "${name}" is unavailable; missing ${missing.map(({ label, path }) => `${label} at ${path}`).join(', ')}. Use --profile general or restore the resource.`,
      })
    const guidance = yield* fs.readFileString(profile.soulPath)
    return { ...profile, guidance }
  },
  (effect, name) =>
    Effect.mapError(effect, error => toProfileError(error, `Cannot load profile "${name}"`))
)

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
