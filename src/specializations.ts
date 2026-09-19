import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect, FileSystem, Schema } from 'effect'

export class SpecializationError extends Schema.TaggedError<SpecializationError>()(
  'SpecializationError',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }
) {}

export interface RequiredResource {
  readonly label: string
  readonly path: string
}

export interface Specialization {
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
  readonly specialization: Specialization
}

const homeDirectory = Effect.sync(() => process.env.HOME ?? process.env.USERPROFILE).pipe(
  Effect.filterOrFail(
    (home): home is string => home !== undefined,
    () => new SpecializationError({ message: 'HOME is required to locate shared workflow skills' })
  )
)

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const generalSoul = join(projectRoot, 'specializations/general/SOUL.md')
const appleSkillsRoot = join(projectRoot, 'specializations/apple/skills')
const appleSoul = join(projectRoot, 'specializations/apple/SOUL.md')
const appleSkillNames: readonly string[] = [
  'swiftui-pro',
  'swift-concurrency-pro',
  'swift-testing-pro',
  'swiftdata-pro',
]

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const toSpecializationError = (error: unknown, operation: string): SpecializationError =>
  error instanceof SpecializationError
    ? error
    : new SpecializationError({ message: `${operation}: ${messageOf(error)}`, cause: error })

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

export function specializationNames(): readonly string[] {
  return ['general', 'apple']
}

export const getSpecialization = (
  name: string
): Effect.Effect<Specialization, SpecializationError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const values = yield* definitions
    let specialization: (typeof values)[keyof typeof values] | undefined
    if (name === 'general') specialization = values.general
    else if (name === 'apple') specialization = values.apple
    if (specialization === undefined)
      return yield* new SpecializationError({
        message: `Unknown specialization "${name}". Choose one of: ${specializationNames().join(', ')}.`,
      })
    const missing = yield* Effect.forEach(specialization.required, resource =>
      fs.exists(resource.path).pipe(Effect.map(exists => (exists ? undefined : resource)))
    ).pipe(
      Effect.map(resources =>
        resources.filter((resource): resource is RequiredResource => resource !== undefined)
      )
    )
    if (missing.length > 0)
      return yield* new SpecializationError({
        message: `Specialization "${name}" is unavailable; missing ${missing.map(({ label, path }) => `${label} at ${path}`).join(', ')}. Use --specialization general or restore the resource.`,
      })
    const guidance = yield* fs.readFileString(specialization.soulPath)
    return { ...specialization, guidance }
  }).pipe(
    Effect.mapError(error => toSpecializationError(error, `Cannot load specialization "${name}"`))
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

export const composeResources = (
  options: ComposeResourcesOptions
): Effect.Effect<ComposedResources, SpecializationError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const projectCandidates = projectSkillPathCandidates(options.cwd, options.gitRoot)
    const projectPaths = yield* existingPaths(fs, projectCandidates)
    const candidates = [...projectPaths, ...options.specialization.skillPaths]
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
      source: index < projectPaths.length ? 'project' : options.specialization.name,
      precedence: index,
    }))
    return {
      skillPaths: paths,
      provenance,
      guidance: options.specialization.guidance,
      soulPath: options.specialization.soulPath,
    }
  }).pipe(
    Effect.mapError(error =>
      toSpecializationError(error, 'Cannot compose specialization resources')
    )
  )

export function resourceSummary(resources: ComposedResources): string {
  return resources.provenance.map(({ source, path }) => `${source}: ${path}`).join('\n')
}
