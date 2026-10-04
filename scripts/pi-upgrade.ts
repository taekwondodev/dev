import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Array as Arr, Config, ConfigProvider, Effect, FileSystem, Option, Schema } from 'effect'
import { FetchHttpClient, HttpClient, HttpClientResponse } from 'effect/unstable/http'
import { errorText } from '../src/error-text.ts'
import { resolvePiPackage } from '../src/pi-runtime.ts'
import { acquireMaintenance } from '../src/runtime-coordination.ts'
import { checkout, run, streamed, upgradeHome } from './checkout.ts'
import { type AuditSummary, auditAt, auditRow } from './npm-audit.ts'
import { cell, collapsed, counted, fence, lastLines, listed } from './report.ts'

export class PiUpgradeError extends Schema.TaggedError<PiUpgradeError>()('PiUpgradeError', {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const manifestPath = join(checkout, 'package.json')
const latestVersionUrl = 'https://pi.dev/api/latest-version'
const installerReleases = 'https://pi.dev/api/installer/releases'
export const candidateRelease = join(upgradeHome, 'pi')
const managedNpmCi = [
  'ci',
  '--ignore-scripts',
  '--min-release-age=0',
  '--omit=dev',
  '--include=optional',
  '--no-fund',
  '--no-audit',
  '--loglevel=error',
  '--progress=false',
] as const
const piSources = 'https://github.com/earendil-works/pi/blob/main/packages/coding-agent/'
const failureTailLines = 80

const piSdkApi =
  /createAgentSession|\bAgentSession|InteractiveMode|ModelRuntime|ProjectTrust|defineTool|ToolDefinition/
const sdkWord =
  /(?<!(?:Anthropic|OpenAI|AWS|Azure|Google|GenAI|Gemini|Vercel AI|Cloudflare|Mistral|Bedrock) )\bSDK\b/
const providerContext = /\bproviders?\b|SDK-backed/i

const matching = (pattern: RegExp) => (prose: string) => pattern.test(prose)

const integrationSurfaces = [
  {
    label: 'SDK',
    matches: (prose: string) =>
      piSdkApi.test(prose) || (sdkWord.test(prose) && !providerContext.test(prose)),
  },
  {
    label: 'sessions',
    matches: matching(
      /session ?manager|findMostRecentSession|resolvePath|path resolution|switchSession|newSession|importFromJsonl|\bfork/i
    ),
  },
  {
    label: 'session format',
    matches: matching(/session (?:file|format|header|entr)|\bJSONL\b|parentSession/i),
  },
  {
    label: 'extensions',
    matches: matching(
      /\bextensions?\b|\btool_(?:call|result)\b|\bterminate\b|\buser_bash\b|`(?:bash|edit|write)`|register(?:Tool|Command)|send(?:Custom)?Message|getCommand/i
    ),
  },
  { label: 'skills', matches: matching(/\bskills?\b|expandPromptTemplates|prompt templates?/i) },
  { label: 'RPC', matches: matching(/\bRPC\b|RpcClient/) },
  { label: 'compaction', matches: matching(/\bcompact(?:ion|ed|ing|s)?\b/i) },
  { label: 'settings', matches: matching(/\bsettings?\b|SettingsManager/i) },
  {
    label: 'resource loader',
    matches: matching(/resource ?loader|AGENTS\.md|SYSTEM\.md|system prompt/i),
  },
] as const

type SurfaceLabel = (typeof integrationSurfaces)[number]['label']

const unusedSurfaces = /\bMCP\b|codemode|\btool[ _]search\b/i

const repeatedSection = /^### New Features\s*$/

export const PiVersion = Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/)).pipe(
  Schema.brand('dev/PiVersion')
)
export type PiVersion = typeof PiVersion.Type

const PackageManifest = Schema.fromJsonString(
  Schema.Struct({ config: Schema.Struct({ pi: PiVersion }) })
)

const LatestRelease = Schema.fromJsonString(Schema.Struct({ version: Schema.String }))

const SurfaceProbe = Schema.fromJsonString(
  Schema.Struct({
    exports: Schema.Array(Schema.String),
    tools: Schema.Record(Schema.String, Schema.String),
  })
)

const surfaceProbe = `
const [entry, cwd] = process.argv.slice(1)
const api = await import(entry)
const tools = {}
for (const name of Object.keys(api).filter(name => /^create\\w+ToolDefinition$/.test(name))) {
  const definition = api[name](cwd)
  tools[definition.name] = JSON.stringify(definition, (key, value) => typeof value === 'function' ? undefined : value)
}
process.stdout.write(JSON.stringify({ exports: Object.keys(api).sort(), tools }))
`

type PiInstallation = Effect.Success<typeof resolvePiPackage>

interface PiPins {
  readonly pin: PiVersion
  readonly candidate: PiVersion
}

interface LineToRead {
  readonly surfaces: readonly SurfaceLabel[]
  readonly text: string
}

type Changelog =
  | { readonly kind: 'same release' }
  | { readonly kind: 'not compared' }
  | {
      readonly kind: 'range'
      readonly lines: readonly LineToRead[]
      readonly leftOut: readonly LineToRead[]
    }

interface Delta {
  readonly added: readonly string[]
  readonly removed: readonly string[]
  readonly changed: readonly string[]
}

interface Surfaces {
  readonly exports: Delta
  readonly declarations: Delta
  readonly tools: Delta
}

interface DocChange {
  readonly page: string
  readonly change: string
}

export interface PiComparison {
  readonly pins: PiPins
  readonly drifted: boolean
  readonly summary: string
  readonly changelog: Changelog
  readonly surfaces: Surfaces
  readonly pages: readonly string[]
  readonly docs: readonly DocChange[]
  readonly audit: AuditSummary
}

const withoutReferences = (line: string): string =>
  line.replace(/\s*\((?:\[[^\]]+\]\([^)]+\)(?:,\s*|\s+by\s+)?)+\)(\.?)$/, '$1')

const linkedForPullRequest = (line: string): string =>
  line
    .split(/(`+[^`]*`+)/)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part
            .replace(/\]\((?![a-z]+:|#)/g, `](${piSources}`)
            .replace(/(^|[^\w/])@([A-Za-z\d][\w-]*)/g, '$1`@$2`')
    )
    .join('')

const withoutLinkTargets = (line: string): string => line.replace(/\]\([^)]*\)/g, ']')

const readChangelog = (sections: readonly string[]): Changelog => {
  const lines: LineToRead[] = []
  const leftOut: LineToRead[] = []
  let bullets = 0
  let content = 0
  let inFence = false
  let skipped = false
  for (const line of sections.join('').split(/\r?\n/)) {
    if (line.trimStart().startsWith('```')) inFence = !inFence
    if (inFence) continue
    if (line.startsWith('### ')) skipped = repeatedSection.test(line)
    if (line.trim() !== '' && !line.startsWith('#')) content += 1
    const bullet = /^\s*[-*] (.*)$/.exec(line)
    if (bullet === null) continue
    bullets += 1
    const prose = withoutLinkTargets(line)
    const surfaces = integrationSurfaces
      .filter(surface => surface.matches(prose))
      .map(surface => surface.label)
    if (skipped || surfaces.length === 0) continue
    const read = { surfaces, text: linkedForPullRequest(withoutReferences(bullet[1])) }
    if (unusedSurfaces.test(prose)) leftOut.push(read)
    else lines.push(read)
  }
  return content > 0 && bullets === 0 ? { kind: 'not compared' } : { kind: 'range', lines, leftOut }
}

const differenceCount = (delta: Delta): number =>
  delta.added.length + delta.removed.length + delta.changed.length

const deltaParts = (delta: Delta) =>
  (
    [
      ['added', delta.added],
      ['removed', delta.removed],
      ['changed', delta.changed],
    ] as const
  ).filter(([, names]) => names.length > 0)

const describeDelta = (delta: Delta): string =>
  deltaParts(delta)
    .map(([kind, names]) => `${names.length} ${kind} (${listed(names)})`)
    .join(', ')

const apisDevUses = (surfaces: Surfaces): string => {
  const apis = [
    ['SDK exports', surfaces.exports],
    ['native tools', surfaces.tools],
  ] as const
  if (apis.every(([, delta]) => differenceCount(delta) === 0))
    return `unchanged: ${apis.map(([label]) => label).join(', ')}`
  return apis
    .map(([label, delta]) =>
      differenceCount(delta) === 0 ? `${label} unchanged` : `${label}: ${describeDelta(delta)}`
    )
    .join('; ')
}

const leftOutNote = (count: number): string =>
  `${count === 1 ? 'mentions' : 'mention'} MCP, codemode or tool search`

const changelogReading = ({
  changelog,
  pins,
  drifted,
}: PiComparison): {
  readonly row: string
  readonly lines: readonly LineToRead[]
  readonly leftOut: readonly LineToRead[]
} => {
  switch (changelog.kind) {
    case 'same release':
      return { row: 'none, same release', lines: [], leftOut: [] }
    case 'not compared':
      return {
        row: "not compared: read Pi's changelog in full",
        lines: [],
        leftOut: [],
      }
    case 'range': {
      const { lines, leftOut } = changelog
      const since = drifted ? ` since the pinned ${pins.pin}` : ''
      const leftOutSuffix =
        leftOut.length === 0 ? '' : `; ${leftOut.length} more ${leftOutNote(leftOut.length)}`
      return {
        row: `${lines.length === 0 ? 'none' : counted(lines.length, 'line')}${since}${leftOutSuffix}`,
        lines,
        leftOut,
      }
    }
  }
}

const renderLines = (lines: readonly LineToRead[]): string =>
  lines.map(line => `- [${line.surfaces.join(', ')}] ${line.text}`).join('\n')

const renderDocs = (pages: readonly string[], changes: readonly DocChange[]): string => {
  const unchanged = pages.filter(page => !changes.some(change => change.page === page))
  return collapsed(
    `Changed docs: ${changes.length === 0 ? 'none' : counted(changes.length, 'page')}`,
    [
      ...changes.map(change => `#### ${change.page}\n\n${change.change}`),
      ...(unchanged.length > 0 ? [`Unchanged: ${listed(unchanged)}.`] : []),
    ].join('\n\n')
  )
}

const renderDeclarations = (declarations: Delta): string => {
  const count = differenceCount(declarations)
  return collapsed(
    `Changed declaration files: ${count === 0 ? 'none' : count}`,
    count === 0
      ? 'No declaration file differs.'
      : deltaParts(declarations)
          .map(
            ([kind, names]) =>
              `${kind[0].toUpperCase()}${kind.slice(1)}:\n\n${names.map(name => `- \`${name}\``).join('\n')}`
          )
          .join('\n\n')
  )
}

export const piRows = (comparison: PiComparison): readonly string[] => [
  `| Pi APIs dev uses | ${cell(apisDevUses(comparison.surfaces))} |`,
  `| Pi changelog to read | ${cell(changelogReading(comparison).row)} |`,
  `| Pi audit | ${cell(auditRow(comparison.audit))} |`,
]

export const piSections = (
  comparison: PiComparison,
  { docs }: { readonly docs: boolean }
): readonly string[] => {
  const reading = changelogReading(comparison)
  return [
    ...(reading.lines.length > 0
      ? [`### Pi changelog to read\n\n${renderLines(reading.lines)}`]
      : []),
    ...(reading.leftOut.length > 0
      ? [
          collapsed(
            `Left out: ${counted(reading.leftOut.length, 'line')} that ${leftOutNote(reading.leftOut.length)}`,
            renderLines(reading.leftOut)
          ),
        ]
      : []),
    docs
      ? renderDocs(comparison.pages, comparison.docs)
      : `Changed Pi docs: ${comparison.docs.length === 0 ? 'none' : `${counted(comparison.docs.length, 'page')}, diffs in the saved report`}.`,
    renderDeclarations(comparison.surfaces.declarations),
  ]
}

const failure = (what: string) => (cause: unknown) =>
  new PiUpgradeError({ message: `${what}: ${errorText(cause)}`, cause })

export const readPiPin = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const manifest = yield* Schema.decodeEffect(PackageManifest)(
    yield* fs.readFileString(manifestPath)
  )
  return manifest.config.pi
}).pipe(Effect.mapError(failure('Cannot read the Pi pin at config.pi in package.json')))

const decodeVersion = (version: string) =>
  Schema.decodeEffect(PiVersion)(version).pipe(
    Effect.mapError(
      cause =>
        new PiUpgradeError({
          message: `Pi version "${version}" is not an exact major.minor.patch version`,
          cause,
        })
    )
  )

const download = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(response => response.text),
    Effect.provide(FetchHttpClient.layer),
    Effect.mapError(failure(`Cannot download ${url}`))
  )

export const latestVersion = download(latestVersionUrl).pipe(
  Effect.flatMap(Schema.decodeEffect(LatestRelease)),
  Effect.mapError(failure(`Cannot read the latest Pi release from ${latestVersionUrl}`)),
  Effect.flatMap(({ version }) => decodeVersion(version))
)

const diffNoIndex = Effect.fnUntraced(function* (
  from: string,
  to: string,
  flags: readonly string[]
) {
  const { stdout, stderr, exitCode } = yield* run(
    'git',
    ['diff', '--no-index', ...flags, from, to],
    { exitCodes: [0, 1] }
  )
  if (exitCode === 1 && stdout === '')
    return yield* new PiUpgradeError({
      message: `git diff --no-index ${from} ${to} failed: ${stderr.trim()}`,
    })
  return stdout
})

const changedPaths = Effect.fnUntraced(function* (from: string, to: string) {
  const stdout = yield* diffNoIndex(from, to, ['--name-status', '--no-renames', '-z'])
  const fields = stdout.split('\0').filter(field => field !== '')
  return Array.from({ length: fields.length / 2 }, (_, index) => {
    const status = fields[index * 2]
    const path = fields[index * 2 + 1]
    return { status, path: path.slice((status === 'A' ? to : from).length + 1) }
  })
})

const nameDelta = (baseline: readonly string[], candidate: readonly string[]): Delta => ({
  added: candidate.filter(name => !baseline.includes(name)),
  removed: baseline.filter(name => !candidate.includes(name)),
  changed: [],
})

const probeSurfaces = Effect.fnUntraced(function* (entry: string) {
  const { stdout } = yield* run(process.execPath, [
    '--input-type=module',
    '--eval',
    surfaceProbe,
    pathToFileURL(entry).href,
    checkout,
  ])
  return yield* Schema.decodeEffect(SurfaceProbe)(stdout).pipe(
    Effect.mapError(failure(`Cannot read the Pi surfaces of ${entry}`))
  )
})

const compareSurfaces = Effect.fnUntraced(function* (
  baseline: PiInstallation,
  candidate: PiInstallation
) {
  const [before, after, dist] = yield* Effect.all(
    [
      probeSurfaces(baseline.entry),
      probeSurfaces(candidate.entry),
      changedPaths(join(baseline.root, 'dist'), join(candidate.root, 'dist')),
    ],
    { concurrency: 'unbounded' }
  )
  const declarations = (keep: (status: string) => boolean) =>
    dist
      .filter(change => change.path.endsWith('.d.ts') && keep(change.status))
      .map(change => `dist/${change.path}`)
  return {
    exports: nameDelta(before.exports, after.exports),
    declarations: {
      added: declarations(status => status === 'A'),
      removed: declarations(status => status === 'D'),
      changed: declarations(status => status !== 'A' && status !== 'D'),
    },
    tools: {
      ...nameDelta(Object.keys(before.tools), Object.keys(after.tools)),
      changed: Object.keys(after.tools).filter(
        name => name in before.tools && before.tools[name] !== after.tools[name]
      ),
    },
  } satisfies Surfaces
})

const contractPages = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const development = yield* fs.readFileString(join(checkout, 'docs', 'DEVELOPMENT.md'))
  const pages = [
    ...new Set(
      Array.from(development.matchAll(/\]\(([^)\s#]+)/g), match => match[1])
        .filter(url => url.startsWith(piSources) && url.endsWith('.md'))
        .map(url => url.slice(piSources.length))
    ),
  ]
  if (pages.length === 0)
    return yield* new PiUpgradeError({
      message: 'docs/DEVELOPMENT.md links no Pi contract page to compare',
    })
  return pages
})

const compareDocs = Effect.fnUntraced(function* (
  pages: readonly string[],
  baseline: PiInstallation,
  candidate: PiInstallation
) {
  const fs = yield* FileSystem.FileSystem
  const changes = yield* Effect.forEach(pages, page =>
    Effect.gen(function* () {
      const before = join(baseline.root, page)
      const after = join(candidate.root, page)
      const inBaseline = yield* fs.exists(before)
      const inCandidate = yield* fs.exists(after)
      if (!inBaseline && !inCandidate) return Option.some({ page, change: 'Missing from both.' })
      if (!inCandidate) return Option.some({ page, change: 'Removed from the candidate.' })
      if (!inBaseline) return Option.some({ page, change: 'Added in the candidate.' })
      const stdout = yield* diffNoIndex(before, after, ['--no-color'])
      if (stdout === '') return Option.none<DocChange>()
      const hunks = stdout.indexOf('\n@@')
      return Option.some({
        page,
        change: hunks === -1 ? 'Changed outside its text.' : fence('diff', stdout.slice(hunks + 1)),
      })
    })
  )
  return Arr.getSomes(changes)
})

const changelogSections = Effect.fnUntraced(function* (
  pins: PiPins,
  newRelease: boolean,
  candidate: PiInstallation
) {
  if (!newRelease) return { kind: 'same release' } satisfies Changelog
  const fs = yield* FileSystem.FileSystem
  const sections = (yield* fs.readFileString(join(candidate.root, 'CHANGELOG.md'))).split(
    /^(?=## )/m
  )
  const start = sections.findIndex(section => section.startsWith(`## [${pins.candidate}]`))
  const end = sections.findIndex(section => section.startsWith(`## [${pins.pin}]`))
  return start === -1 || end === -1 || start > end
    ? ({ kind: 'not compared' } satisfies Changelog)
    : readChangelog(sections.slice(start, end))
})

const resolveCandidate = resolvePiPackage.pipe(
  Effect.provideService(
    ConfigProvider.ConfigProvider,
    ConfigProvider.fromEnv({ env: { DEV_PI_RELEASE: candidateRelease } })
  )
)

const installCandidate = Effect.fnUntraced(function* (version: PiVersion) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.makeDirectory(upgradeHome, { recursive: true, mode: 0o700 })
  yield* fs.remove(candidateRelease, { recursive: true, force: true })
  yield* fs.makeDirectory(candidateRelease, { mode: 0o700 })
  yield* Effect.forEach(
    ['package.json', 'package-lock.json'],
    file =>
      download(`${installerReleases}/${version}/${file}`).pipe(
        Effect.flatMap(content => fs.writeFileString(join(candidateRelease, file), content))
      ),
    { concurrency: 'unbounded' }
  )
  const install = yield* streamed('npm', managedNpmCi, {}, candidateRelease)
  if (!install.passed)
    return yield* new PiUpgradeError({
      message: `Cannot build the managed Pi ${version} release in ${candidateRelease}:\n${lastLines(install.output, failureTailLines)}`,
    })
  const candidate = yield* resolveCandidate
  if (candidate.version !== version)
    return yield* new PiUpgradeError({
      message: `The managed Pi ${version} release in ${candidateRelease} contains Pi ${candidate.version}.`,
    })
  return candidate
})

export const comparePi = Effect.fnUntraced(function* (pin: PiVersion, version: PiVersion) {
  const pins: PiPins = { pin, candidate: version }
  const baseline = yield* resolvePiPackage
  const newRelease = pins.pin !== pins.candidate
  const drifted = baseline.version !== pins.pin
  const candidate = yield* installCandidate(pins.candidate)
  const pages = yield* contractPages
  const [changelog, surfaces, docs, audit] = yield* Effect.all(
    [
      changelogSections(pins, newRelease, candidate),
      compareSurfaces(baseline, candidate),
      compareDocs(pages, baseline, candidate),
      auditAt(candidate.release, 'production'),
    ],
    { concurrency: 'unbounded' }
  )
  return {
    pins,
    drifted,
    summary: `Pi ${pins.candidate} from the pi.dev installer lockfile; baseline ${baseline.version}, the Pi dev runs today.${drifted ? ` The base pins ${pins.pin}, not the baseline.` : ''}`,
    changelog,
    surfaces,
    pages,
    docs,
    audit,
  } satisfies PiComparison
})

const lockfile = Effect.fnUntraced(function* (release: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString(join(release, 'package-lock.json'))
})

export const refuseSelectedRelease = Effect.fnUntraced(function* (command: string) {
  if (Option.isSome(yield* Config.option(Config.String('DEV_PI_RELEASE'))))
    return yield* new PiUpgradeError({
      message: `Refusing ${command}: DEV_PI_RELEASE selects another Pi release. Unset it first.`,
    })
})

const updateUnderGate = Effect.fnUntraced(function* () {
  yield* acquireMaintenance()
  const version = yield* readPiPin
  yield* refuseSelectedRelease('update')
  const verified = yield* Effect.option(resolveCandidate)
  if (Option.isNone(verified) || verified.value.version !== version)
    return yield* new PiUpgradeError({
      message: `Refusing update: no verified candidate for Pi ${version} in ${candidateRelease}. Merge an upgrade pull request that verified it, or run npm run upgrade.`,
    })
  const latest = yield* latestVersion
  if (latest !== version)
    return yield* new PiUpgradeError({
      message: `Refusing update: pi update would install Pi ${latest}, not the pinned ${version}. Run npm run upgrade and merge its pull request first.`,
    })
  const previous = yield* resolvePiPackage
  const update = yield* streamed('pi', ['update'])
  if (!update.passed)
    return yield* new PiUpgradeError({
      message: `pi update failed; Pi ${previous.version} stays active:\n${lastLines(update.output, failureTailLines)}`,
    })
  const installed = yield* resolvePiPackage
  const failed = (reason: string) =>
    new PiUpgradeError({
      message:
        installed.install === undefined || previous.version === installed.version
          ? reason
          : `${reason}\nPi ${previous.version} is still installed; reactivate it with: echo ${previous.version} > ${join(installed.install, 'current-version')}`,
    })
  if (installed.version !== version)
    return yield* failed(
      `pi update activated Pi ${installed.version}, not the verified ${version}.`
    )
  if ((yield* lockfile(installed.release)) !== (yield* lockfile(verified.value.release)))
    return yield* failed(
      `pi update activated Pi ${version} from a lockfile that differs from the verified candidate's.`
    )
  const smoke = yield* streamed('npm', ['run', 'smoke'])
  if (!smoke.passed)
    return yield* failed(
      `Pi ${version} is the verified candidate, but smoke failed:\n${lastLines(smoke.output, failureTailLines)}`
    )
  const fs = yield* FileSystem.FileSystem
  yield* fs.remove(candidateRelease, { recursive: true })
  return version
}, Effect.scoped)

export const updatePi = Effect.fn('updatePi')(
  function* () {
    const version = yield* updateUnderGate()
    const diagnostics = yield* run('dev', ['--diagnostics']).pipe(
      Effect.mapError(
        error =>
          new PiUpgradeError({
            message: `Updated Pi to the verified ${version}, but dev --diagnostics failed: ${error.message}`,
            cause: error,
          })
      )
    )
    yield* Effect.sync(() => {
      process.stdout.write(`${diagnostics.stdout}\nUpdated Pi to the verified ${version}.\n`)
    })
  },
  Effect.mapError(error =>
    error instanceof PiUpgradeError ? error : failure('Pi update failed')(error)
  )
)
