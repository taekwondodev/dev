import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  Array as Arr,
  Config,
  ConfigProvider,
  DateTime,
  Effect,
  FileSystem,
  Option,
  Schema,
} from 'effect'
import { FetchHttpClient, HttpClient, HttpClientResponse } from 'effect/unstable/http'
import { errorText } from '../src/error-text.ts'
import { linkPiDeclarations, resolvePiPackage } from '../src/pi-runtime.ts'
import { acquireMaintenance } from '../src/runtime-coordination.ts'
import { checkout, checkoutIsClean, git, run, streamed } from './checkout.ts'

export class PiUpgradeError extends Schema.TaggedError<PiUpgradeError>()('PiUpgradeError', {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const manifestPath = join(checkout, 'package.json')
const latestVersionUrl = 'https://pi.dev/api/latest-version'
const installerReleases = 'https://pi.dev/api/installer/releases'
const candidateHome = join(checkout, '.dev', 'pi-candidate')
const candidateRelease = join(candidateHome, 'release')
const reportPath = join(candidateHome, 'report.md')
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
const suites = [
  'lint',
  'smoke',
  'workspace:check',
  'workspace:tui',
  'workspace:github',
  'work:check',
] as const
type Suite = (typeof suites)[number]
const pullRequestBodyLimit = 65_536
const suiteTimesReserve = 64
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

const PiVersion = Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/)).pipe(
  Schema.brand('dev/PiVersion')
)
type PiVersion = typeof PiVersion.Type

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

const severities = ['critical', 'high', 'moderate', 'low', 'info'] as const
type Severity = (typeof severities)[number]

const AuditReport = Schema.fromJsonString(
  Schema.Struct({
    vulnerabilities: Schema.Record(
      Schema.String,
      Schema.Struct({ severity: Schema.Literals(severities) })
    ),
  })
)

const AuditFailure = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ error: Schema.Struct({ summary: Schema.NonEmptyString }) }),
    Schema.Struct({ message: Schema.String }),
  ])
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

interface Upgrade {
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

type AuditSummary =
  | {
      readonly kind: 'report'
      readonly bySeverity: readonly {
        readonly severity: Severity
        readonly packages: readonly string[]
      }[]
    }
  | { readonly kind: 'unavailable'; readonly reason: string }

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

interface SuiteResult {
  readonly suite: Suite
  readonly passed: boolean
  readonly ms: number
  readonly output: string
}

interface SuiteRun {
  readonly results: readonly SuiteResult[]
  readonly failed: SuiteResult | undefined
}

interface Comparison {
  readonly upgrade: Upgrade
  readonly newRelease: boolean
  readonly drifted: boolean
  readonly summary: string
  readonly changelog: Changelog
  readonly surfaces: Surfaces
  readonly pages: readonly string[]
  readonly docs: readonly DocChange[]
  readonly audit: AuditSummary
}

const lastLines = (output: string, count: number): string =>
  output.trimEnd().split('\n').slice(-count).join('\n')

const fence = (language: string, body: string): string => {
  const longest = Math.max(0, ...Array.from(body.matchAll(/`+/g), match => match[0].length))
  const marks = '`'.repeat(Math.max(3, longest + 1))
  return `${marks}${language}\n${body.trimEnd()}\n${marks}`
}

const counted = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

const withoutFinalPeriod = (text: string): string => text.trim().replace(/\.+$/, '')

const listed = (names: readonly string[]): string => names.map(name => `\`${name}\``).join(', ')

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
  upgrade,
  drifted,
}: Comparison): {
  readonly headline: string
  readonly row: string
  readonly lines: readonly LineToRead[]
  readonly leftOut: readonly LineToRead[]
} => {
  switch (changelog.kind) {
    case 'same release':
      return { headline: 'nothing to read', row: 'none, same release', lines: [], leftOut: [] }
    case 'not compared':
      return {
        headline: 'changelog not compared',
        row: "not compared: read Pi's changelog in full",
        lines: [],
        leftOut: [],
      }
    case 'range': {
      const { lines, leftOut } = changelog
      const since = drifted ? ` since the pinned ${upgrade.pin}` : ''
      const leftOutSuffix =
        leftOut.length === 0 ? '' : `; ${leftOut.length} more ${leftOutNote(leftOut.length)}`
      return {
        headline:
          lines.length === 0
            ? 'nothing to read'
            : `${counted(lines.length, 'changelog line')} to read`,
        row: `${lines.length === 0 ? 'none' : counted(lines.length, 'line')}${since}${leftOutSuffix}`,
        lines,
        leftOut,
      }
    }
  }
}

const renderLines = (lines: readonly LineToRead[]): string =>
  lines.map(line => `- [${line.surfaces.join(', ')}] ${line.text}`).join('\n')

const auditRow = (audit: AuditSummary): string => {
  if (audit.kind === 'unavailable') return `unavailable: ${audit.reason}`
  if (audit.bySeverity.length === 0) return 'no known vulnerabilities'
  return audit.bySeverity
    .map(({ severity, packages }) => `${packages.length} ${severity}: ${packages.join(', ')}`)
    .join('; ')
}

const suitesRow = ({ results, failed }: SuiteRun): string => {
  const passed = results.filter(result => result.passed).length
  return failed === undefined
    ? `${passed}/${suites.length} green`
    : `red at \`${failed.suite}\` after ${passed}/${suites.length} passed`
}

const cell = (text: string): string => text.replaceAll('|', String.raw`\|`)

const collapsed = (summary: string, body: string): string =>
  `<details>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`

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

const renderSuiteTimes = ({ results }: SuiteRun): string =>
  collapsed(
    'Suites and times',
    [
      '| Suite | Result | Time |',
      '| --- | --- | --- |',
      ...suites.map(suite => {
        const ran = results.find(result => result.suite === suite)
        if (ran === undefined) return `| \`${suite}\` | not run | |`
        return `| \`${suite}\` | ${ran.passed ? 'passed' : 'failed'} | ${Math.round(ran.ms / 1000)} s |`
      }),
    ].join('\n')
  )

const renderReport = (comparison: Comparison, suiteRun: SuiteRun, date: string): string => {
  const { upgrade } = comparison
  const reading = changelogReading(comparison)
  const headline =
    suiteRun.failed === undefined
      ? `suites green, ${reading.headline}`
      : `suites red at ${suiteRun.failed.suite}`
  return `${[
    `## Pi ${upgrade.candidate}: ${headline}`,
    comparison.summary,
    [
      '| Check | Result |',
      '| --- | --- |',
      `| Suites | ${cell(suitesRow(suiteRun))} |`,
      `| APIs dev uses | ${cell(apisDevUses(comparison.surfaces))} |`,
      `| Changelog to read | ${cell(reading.row)} |`,
      `| Audit | ${cell(auditRow(comparison.audit))} |`,
    ].join('\n'),
    ...(suiteRun.failed === undefined
      ? []
      : [
          `### \`${suiteRun.failed.suite}\` failed\n\n${fence('text', lastLines(suiteRun.failed.output, failureTailLines))}`,
        ]),
    ...(reading.lines.length > 0 ? [`### Changelog to read\n\n${renderLines(reading.lines)}`] : []),
    ...(reading.leftOut.length > 0
      ? [
          collapsed(
            `Left out: ${counted(reading.leftOut.length, 'line')} that ${leftOutNote(reading.leftOut.length)}`,
            renderLines(reading.leftOut)
          ),
        ]
      : []),
    renderDocs(comparison.pages, comparison.docs),
    renderDeclarations(comparison.surfaces.declarations),
    renderSuiteTimes(suiteRun),
    ...(suiteRun.failed === undefined && comparison.newRelease
      ? [
          `After merging: \`npm run pi:update -- --version ${upgrade.candidate}\`, then \`npm run profile\` after one live session.`,
        ]
      : []),
    `Verified on ${date} with Node ${process.version}.`,
  ].join('\n\n')}\n`
}

const failure = (what: string) => (cause: unknown) =>
  new PiUpgradeError({ message: `${what}: ${errorText(cause)}`, cause })

const warnOnFailure =
  (hint: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<void, never, R> =>
    effect.pipe(
      Effect.asVoid,
      Effect.catch(error =>
        Effect.sync(() => {
          process.stderr.write(`${hint}: ${errorText(error)}\n`)
        })
      )
    )

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

const latestVersion = download(latestVersionUrl).pipe(
  Effect.flatMap(Schema.decodeEffect(LatestRelease)),
  Effect.mapError(failure(`Cannot read the latest Pi release from ${latestVersionUrl}`)),
  Effect.flatMap(({ version }) => decodeVersion(version))
)

const assertClean = Effect.gen(function* () {
  if (!(yield* checkoutIsClean))
    return yield* new PiUpgradeError({
      message:
        'Refusing Pi verification: dev checkout has local changes. Preserve them explicitly before verifying.',
    })
})

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
  upgrade: Upgrade,
  newRelease: boolean,
  candidate: PiInstallation
) {
  if (!newRelease) return { kind: 'same release' } satisfies Changelog
  const fs = yield* FileSystem.FileSystem
  const sections = (yield* fs.readFileString(join(candidate.root, 'CHANGELOG.md'))).split(
    /^(?=## )/m
  )
  const start = sections.findIndex(section => section.startsWith(`## [${upgrade.candidate}]`))
  const end = sections.findIndex(section => section.startsWith(`## [${upgrade.pin}]`))
  return start === -1 || end === -1 || start > end
    ? ({ kind: 'not compared' } satisfies Changelog)
    : readChangelog(sections.slice(start, end))
})

const oneLine = (text: string): string => withoutFinalPeriod(text.replace(/\s*\n\s*/g, ' '))

const auditCandidate = (candidate: PiInstallation) =>
  run('npm', ['audit', '--json', '--omit=dev'], { cwd: candidate.release, exitCodes: [0, 1] }).pipe(
    Effect.flatMap(({ stdout }) =>
      Schema.decodeEffect(AuditReport)(stdout).pipe(
        Effect.map(
          (report): AuditSummary => ({
            kind: 'report',
            bySeverity: severities.flatMap(severity => {
              const packages = Object.entries(report.vulnerabilities)
                .filter(([, vulnerability]) => vulnerability.severity === severity)
                .map(([name]) => name)
              return packages.length > 0 ? [{ severity, packages }] : []
            }),
          })
        ),
        Effect.catch(decodeError =>
          Schema.decodeEffect(AuditFailure)(stdout).pipe(
            Effect.map(npmError =>
              'error' in npmError ? npmError.error.summary : npmError.message
            ),
            Effect.orElseSucceed(() => errorText(decodeError)),
            Effect.map((reason): AuditSummary => ({ kind: 'unavailable', reason: oneLine(reason) }))
          )
        )
      )
    ),
    Effect.catch(error =>
      Effect.succeed<AuditSummary>({ kind: 'unavailable', reason: oneLine(errorText(error)) })
    )
  )

const resolveCandidate = resolvePiPackage.pipe(
  Effect.provideService(
    ConfigProvider.ConfigProvider,
    ConfigProvider.fromEnv({ env: { DEV_PI_RELEASE: candidateRelease } })
  )
)

const installCandidate = Effect.fnUntraced(function* (version: PiVersion) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.remove(candidateHome, { recursive: true, force: true })
  yield* fs.makeDirectory(candidateRelease, { recursive: true, mode: 0o700 })
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

const pinCandidate = Effect.fnUntraced(function* (upgrade: Upgrade) {
  const fs = yield* FileSystem.FileSystem
  const original = yield* fs.readFileString(manifestPath)
  const entry = `"pi": "${upgrade.pin}"`
  if (original.split(entry).length !== 2)
    return yield* new PiUpgradeError({
      message: `package.json must contain ${entry} exactly once to bump the Pi pin`,
    })
  const restore = Effect.gen(function* () {
    const { exitCode } = yield* run('git', ['diff', '--quiet', '--', 'package.json'], {
      exitCodes: [0, 1],
    })
    if (exitCode === 1) yield* fs.writeFileString(manifestPath, original)
  })
  yield* Effect.acquireRelease(
    fs.writeFileString(manifestPath, original.replace(entry, `"pi": "${upgrade.candidate}"`)),
    () => restore.pipe(warnOnFailure('Cannot restore the Pi pin; run git restore package.json'))
  )
})

const runSuites = Effect.gen(function* () {
  const results: SuiteResult[] = []
  for (const suite of suites) {
    const result = yield* streamed('npm', ['run', suite], { DEV_PI_RELEASE: candidateRelease })
    results.push({ suite, ...result })
    if (!result.passed) break
  }
  return { results, failed: results.find(result => !result.passed) } satisfies SuiteRun
}).pipe(
  Effect.ensuring(
    linkPiDeclarations.pipe(
      warnOnFailure(
        'Cannot link the Pi declarations back to the installed Pi; run npm run types:pi'
      )
    )
  )
)

const publicationBranch = (upgrade: Upgrade): string => `chore/pi-${upgrade.candidate}`

const pullRequestTitle = (upgrade: Upgrade): string => `chore(pi): pin Pi ${upgrade.candidate}`

const pullRequestArguments = (upgrade: Upgrade): readonly string[] => [
  'pr',
  'create',
  '--base',
  'main',
  '--head',
  publicationBranch(upgrade),
  '--title',
  pullRequestTitle(upgrade),
  '--body-file',
  reportPath,
]

const shellWord = (argument: string): string =>
  /^[\w./:@-]+$/.test(argument) ? argument : `"${argument}"`

const openPullRequestCommand = (upgrade: Upgrade): string =>
  ['gh', ...pullRequestArguments(upgrade)].map(shellWord).join(' ')

const publicationRefusal = Effect.fnUntraced(function* (upgrade: Upgrade, reportLength: number) {
  if (reportLength > pullRequestBodyLimit)
    return Option.some(
      `the report exceeds the ${pullRequestBodyLimit}-character pull request body; verify an intermediate release first`
    )
  const branch = yield* git(['branch', '--show-current'])
  if (branch !== 'main')
    return Option.some(`the checkout is on ${branch === '' ? 'a detached HEAD' : branch}, not main`)
  yield* git(['fetch', '--quiet', 'origin', 'main'])
  if ((yield* git(['rev-parse', 'HEAD'])) !== (yield* git(['rev-parse', 'origin/main'])))
    return Option.some('main is not at origin/main; run npm run update first')
  const head = publicationBranch(upgrade)
  const local = (yield* git(['branch', '--list', head])) !== ''
  if ((yield* git(['ls-remote', '--heads', 'origin', head])) !== '')
    return Option.some(
      `branch ${head} already exists on origin; open its pull request with ${openPullRequestCommand(upgrade)}, or delete it with git push origin --delete ${head}${local ? ` and git branch -D ${head}` : ''}`
    )
  if (local)
    return Option.some(`branch ${head} already exists; delete it with git branch -D ${head}`)
  return Option.none<string>()
})

const announcePublication = Effect.fnUntraced(function* (upgrade: Upgrade, reportLength: number) {
  const notice = yield* publicationRefusal(upgrade, reportLength).pipe(
    Effect.map(
      Option.map(
        reason => `This run verifies Pi ${upgrade.candidate} but will not publish it: ${reason}.`
      )
    ),
    Effect.catch(error =>
      Effect.succeedSome(
        `This run verifies Pi ${upgrade.candidate}; publication could not be checked before the suites and is checked again after them: ${withoutFinalPeriod(error.message)}.`
      )
    )
  )
  if (Option.isSome(notice))
    yield* Effect.sync(() => {
      process.stderr.write(`${notice.value}\n`)
    })
})

const publish = Effect.fnUntraced(function* (upgrade: Upgrade, summary: string, report: string) {
  const version = upgrade.candidate
  const refuse = (reason: string) =>
    new PiUpgradeError({ message: `Not publishing Pi ${version}: ${reason}.` })
  const refusal = yield* publicationRefusal(upgrade, report.length)
  if (Option.isSome(refusal)) return yield* refuse(refusal.value)
  if ((yield* git(['status', '--porcelain'])) !== ' M package.json')
    return yield* refuse('the suites changed files other than the Pi pin')
  const head = publicationBranch(upgrade)
  const subject = pullRequestTitle(upgrade)
  yield* git(['switch', '--create', head])
  yield* Effect.gen(function* () {
    yield* git(['commit', '--message', subject, '--message', summary, '--', 'package.json'])
    yield* git(['push', '--set-upstream', 'origin', head])
  }).pipe(
    Effect.ensuring(
      git(['switch', 'main']).pipe(warnOnFailure('Cannot switch the checkout back to main'))
    ),
    Effect.onError(() =>
      git(['branch', '--delete', '--force', head]).pipe(
        warnOnFailure(`Cannot delete the unpublished branch ${head}`)
      )
    )
  )
  const pullRequest = yield* run('gh', pullRequestArguments(upgrade)).pipe(
    Effect.mapError(
      error =>
        new PiUpgradeError({
          message: `Pushed ${head}, but no pull request was opened: ${withoutFinalPeriod(error.message)}. Open it with ${openPullRequestCommand(upgrade)}.`,
          cause: error,
        })
    )
  )
  yield* Effect.sync(() => {
    process.stdout.write(`Opened ${pullRequest.stdout.trim()} from ${head}.\n`)
  })
})

export const verifyPi = Effect.fn('verifyPi')(
  function* (requested: string | undefined) {
    yield* acquireMaintenance()
    yield* assertClean
    const upgrade: Upgrade = {
      pin: yield* readPiPin,
      candidate: requested === undefined ? yield* latestVersion : yield* decodeVersion(requested),
    }
    const baseline = yield* resolvePiPackage
    const newRelease = upgrade.pin !== upgrade.candidate
    const drifted = baseline.version !== upgrade.pin
    const candidate = yield* installCandidate(upgrade.candidate)
    const pages = yield* contractPages
    const [changelog, surfaces, docs, audit] = yield* Effect.all(
      [
        changelogSections(upgrade, newRelease, candidate),
        compareSurfaces(baseline, candidate),
        compareDocs(pages, baseline, candidate),
        auditCandidate(candidate),
      ],
      { concurrency: 'unbounded' }
    )
    const summary = `Candidate ${upgrade.candidate} from the pi.dev installer lockfile; baseline ${baseline.version}, the Pi dev runs today.${drifted ? ` The checkout pins ${upgrade.pin}, not the baseline.` : ''}`
    const comparison: Comparison = {
      upgrade,
      newRelease,
      drifted,
      summary,
      changelog,
      surfaces,
      pages,
      docs,
      audit,
    }
    if (newRelease) {
      const draft = renderReport(comparison, { results: [], failed: undefined }, 'YYYY-MM-DD')
      yield* announcePublication(upgrade, draft.length + suiteTimesReserve)
      yield* pinCandidate(upgrade)
    }
    const suiteRun = yield* runSuites
    const date = DateTime.formatIsoDate(
      DateTime.setZone(yield* DateTime.now, DateTime.zoneMakeLocal())
    )
    const report = renderReport(comparison, suiteRun, date)
    yield* Effect.sync(() => {
      process.stdout.write(report)
    })
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(reportPath, report)
    if (suiteRun.failed !== undefined)
      return yield* new PiUpgradeError({
        message: `Pi ${upgrade.candidate} failed ${suiteRun.failed.suite}; nothing was bumped or published. The candidate stays in ${candidateRelease}.`,
      })
    if (newRelease)
      return yield* publish(upgrade, summary, report).pipe(
        Effect.mapError(error =>
          error instanceof PiUpgradeError
            ? error
            : new PiUpgradeError({
                message: `Pi ${upgrade.candidate} is green, but publishing failed: ${withoutFinalPeriod(error.message)}.`,
                cause: error,
              })
        )
      )
    yield* Effect.sync(() => {
      process.stdout.write(
        `Nothing to publish: the checkout already pins Pi ${upgrade.candidate}.\n`
      )
    })
  },
  Effect.scoped,
  Effect.mapError(error =>
    error instanceof PiUpgradeError ? error : failure('Pi verification failed')(error)
  )
)

const lockfile = Effect.fnUntraced(function* (release: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString(join(release, 'package-lock.json'))
})

const updateUnderGate = Effect.fnUntraced(function* (version: PiVersion) {
  yield* acquireMaintenance()
  const pin = yield* readPiPin
  if (pin !== version)
    return yield* new PiUpgradeError({
      message: `Refusing update: the checkout pins Pi ${pin}, not ${version}. Merge its verification pull request and update the checkout first.`,
    })
  if (Option.isSome(yield* Config.option(Config.String('DEV_PI_RELEASE'))))
    return yield* new PiUpgradeError({
      message: 'Refusing update: DEV_PI_RELEASE selects another Pi release. Unset it first.',
    })
  const verified = yield* Effect.option(resolveCandidate)
  if (Option.isNone(verified) || verified.value.version !== version)
    return yield* new PiUpgradeError({
      message: `Refusing update: no verified candidate for Pi ${version} in ${candidateRelease}. Run npm run pi:verify -- --version ${version} first.`,
    })
  const latest = yield* latestVersion
  if (latest !== version)
    return yield* new PiUpgradeError({
      message: `Refusing update: pi update would install Pi ${latest}, not the verified ${version}. Run npm run pi:verify -- --version ${latest} first.`,
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
}, Effect.scoped)

export const updatePi = Effect.fn('updatePi')(
  function* (requested: string) {
    const version = yield* decodeVersion(requested)
    yield* updateUnderGate(version)
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
