import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Array as Arr, ConfigProvider, DateTime, Effect, FileSystem, Option, Schema } from 'effect'
import { errorText } from '../src/error-text.ts'
import { linkPiDeclarations, resolvePiPackage } from '../src/pi-runtime.ts'
import { acquireMaintenance } from '../src/runtime-coordination.ts'
import { checkout, checkoutIsClean, git, run, streamed } from './checkout.ts'

export class PiUpgradeError extends Schema.TaggedError<PiUpgradeError>()('PiUpgradeError', {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const manifestPath = join(checkout, 'package.json')
const piPackage = '@earendil-works/pi-coding-agent'
const candidatePrefix = join(checkout, '.dev', 'pi-candidate')
const candidateExecutable = join(candidatePrefix, 'bin', 'pi')
const reportPath = join(candidatePrefix, 'report.md')
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
const suitesSectionReserve = 640
const piSources = 'https://github.com/earendil-works/pi/blob/main/packages/coding-agent/'
const failureTailLines = 80

const integrationSurfaces = [
  {
    name: 'SDK exports',
    pattern:
      /\bSDK\b|createAgentSession|\bAgentSession|InteractiveMode|ModelRuntime|ProjectTrust|defineTool|ToolDefinition/,
  },
  {
    name: 'session manager and path resolution',
    pattern:
      /session ?manager|findMostRecentSession|resolvePath|path resolution|switchSession|newSession|importFromJsonl|\bfork/i,
  },
  {
    name: 'session format',
    pattern: /session (?:file|format|header|entr)|\bJSONL\b|parentSession/i,
  },
  {
    name: 'extensions and tool effects',
    pattern:
      /\bextensions?\b|\btool_(?:call|result)\b|\bterminate\b|\buser_bash\b|`(?:bash|edit|write)`|register(?:Tool|Command)|send(?:Custom)?Message|getCommand/i,
  },
  { name: 'skills', pattern: /\bskills?\b|expandPromptTemplates|prompt templates?/i },
  { name: 'RPC', pattern: /\bRPC\b|RpcClient/ },
  { name: 'compaction', pattern: /\bcompact(?:ion|ed|ing|s)?\b/i },
  { name: 'settings', pattern: /\bsettings?\b|SettingsManager/i },
  { name: 'resource loader', pattern: /resource ?loader|AGENTS\.md|SYSTEM\.md|system prompt/i },
] as const

const PiVersion = Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/)).pipe(
  Schema.brand('dev/PiVersion')
)
type PiVersion = typeof PiVersion.Type

const PackageManifest = Schema.fromJsonString(
  Schema.Struct({ config: Schema.Struct({ pi: PiVersion }) })
)

const SurfaceProbe = Schema.fromJsonString(
  Schema.Struct({
    exports: Schema.Array(Schema.String),
    tools: Schema.Record(Schema.String, Schema.String),
  })
)

const AuditReport = Schema.fromJsonString(
  Schema.Struct({
    metadata: Schema.Struct({ vulnerabilities: Schema.Record(Schema.String, Schema.Finite) }),
    vulnerabilities: Schema.Record(Schema.String, Schema.Struct({ severity: Schema.String })),
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

interface Upgrade {
  readonly pin: PiVersion
  readonly candidate: PiVersion
}

type Changelog =
  | { readonly kind: 'same release' }
  | { readonly kind: 'unplaced' }
  | { readonly kind: 'range'; readonly sections: readonly string[] }

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

const lastLines = (output: string, count: number): string =>
  output.trimEnd().split('\n').slice(-count).join('\n')

const fence = (language: string, body: string): string => {
  const longest = Math.max(0, ...Array.from(body.matchAll(/`+/g), match => match[0].length))
  const marks = '`'.repeat(Math.max(3, longest + 1))
  return `${marks}${language}\n${body.trimEnd()}\n${marks}`
}

const counted = (count: number, noun: string): string =>
  `${count === 0 ? 'no' : count} ${noun}${count === 1 ? '' : 's'}`

const listed = (names: readonly string[]): string => names.map(name => `\`${name}\``).join(', ')

const demoteHeading = (line: string): string => `#${line}`

interface MarkedLine {
  readonly text: string
  readonly highlighted: boolean
}

const markLine = (line: string): MarkedLine => {
  if (line.startsWith('#')) return { text: demoteHeading(line), highlighted: false }
  const matched = integrationSurfaces.filter(surface => surface.pattern.test(line))
  if (matched.length === 0) return { text: line, highlighted: false }
  const [, bullet = '', rest = ''] = /^(\s*[-*] )?(.*)$/.exec(line) ?? []
  return {
    text: `${bullet}**[${matched.map(surface => surface.name).join(', ')}]** ${rest}`,
    highlighted: true,
  }
}

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

const markChangelog = (lines: readonly string[]) => {
  const marked: MarkedLine[] = []
  let inFence = false
  for (const line of lines) {
    const fenceMark = line.trimStart().startsWith('```')
    if (fenceMark) inFence = !inFence
    marked.push(
      fenceMark || inFence
        ? { text: line, highlighted: false }
        : markLine(linkedForPullRequest(line))
    )
  }
  return marked
}

const renderChangelog = (changelog: Changelog, upgrade: Upgrade, baseline: string): string => {
  switch (changelog.kind) {
    case 'same release':
      return '## Changelog: no highlighted lines\n\nNo release between the baseline and the candidate.'
    case 'unplaced':
      return `## Changelog: not compared\n\nThe candidate changelog has no sections from ${upgrade.candidate} down to ${baseline}; read it in full before deciding.`
    case 'range': {
      const lines = markChangelog(changelog.sections.join('').trimEnd().split('\n'))
      return `## Changelog: ${counted(lines.filter(line => line.highlighted).length, 'highlighted line')}\n\n${lines.map(line => line.text).join('\n')}`
    }
  }
}

const differenceCount = (delta: Delta): number =>
  delta.added.length + delta.removed.length + delta.changed.length

const renderDelta = (label: string, delta: Delta): string => {
  const parts = (
    [
      ['added', delta.added],
      ['removed', delta.removed],
      ['changed', delta.changed],
    ] as const
  )
    .filter(([, names]) => names.length > 0)
    .map(([kind, names]) => `${names.length} ${kind} (${listed(names)})`)
  return `- ${label}: ${parts.length === 0 ? 'no difference' : parts.join('; ')}`
}

const renderSurfaces = (surfaces: Surfaces): string =>
  [
    `## Surfaces: ${counted(differenceCount(surfaces.exports) + differenceCount(surfaces.declarations) + differenceCount(surfaces.tools), 'difference')}`,
    [
      renderDelta('SDK exports', surfaces.exports),
      renderDelta('Declaration files', surfaces.declarations),
      renderDelta('Native tools', surfaces.tools),
    ].join('\n'),
  ].join('\n\n')

const renderDocs = (pages: readonly string[], changes: readonly DocChange[]): string => {
  const unchanged = pages.filter(page => !changes.some(change => change.page === page))
  return [
    `## Docs: ${counted(changes.length, 'contract page')} changed`,
    ...changes.map(change => `### ${change.page}\n\n${change.change}`),
    ...(unchanged.length > 0 ? [`Unchanged: ${listed(unchanged)}.`] : []),
  ].join('\n\n')
}

const severities = ['critical', 'high', 'moderate', 'low', 'info'] as const

const renderAudit = (report: typeof AuditReport.Type): string => {
  const counts = severities.flatMap(severity => {
    const count = report.metadata.vulnerabilities[severity] ?? 0
    return count > 0 ? [`${count} ${severity}`] : []
  })
  const packages = Object.entries(report.vulnerabilities).map(
    ([name, vulnerability]) => `- \`${name}\`: ${vulnerability.severity}`
  )
  return [
    `## Audit: ${counts.length === 0 ? 'no known vulnerabilities' : counts.join(', ')}`,
    ...(packages.length > 0 ? [packages.join('\n')] : []),
  ].join('\n\n')
}

const renderSuites = (results: readonly SuiteResult[]): string => {
  const failed = results.find(result => !result.passed)
  const rows = suites.map(suite => {
    const ran = results.find(result => result.suite === suite)
    if (ran === undefined) return `| \`${suite}\` | not run | |`
    return `| \`${suite}\` | ${ran.passed ? 'passed' : 'failed'} | ${Math.round(ran.ms / 1000)} s |`
  })
  return [
    `## Suites: ${failed === undefined ? 'green' : `red at \`${failed.suite}\``}`,
    ['| Suite | Result | Time |', '| --- | --- | --- |', ...rows].join('\n'),
    ...(failed === undefined
      ? []
      : [
          `End of the \`${failed.suite}\` output:\n\n${fence('text', lastLines(failed.output, failureTailLines))}`,
        ]),
    'Session format: the usage profile did not run on the candidate, because the work checks delete their fixture sessions when they close. Run `npm run profile` after one live session on the candidate.',
  ].join('\n\n')
}

const renderReport = (comparison: string, results: readonly SuiteResult[], date: string): string =>
  `${[comparison, renderSuites(results), `Verified on ${date} with Node ${process.version}.`].join('\n\n')}\n`

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

const latestVersion = run('npm', ['view', piPackage, 'version']).pipe(
  Effect.flatMap(({ stdout }) => decodeVersion(stdout.trim()))
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
  baseline: PiInstallation,
  candidate: PiInstallation
) {
  if (baseline.version === candidate.version) return { kind: 'same release' } satisfies Changelog
  const fs = yield* FileSystem.FileSystem
  const sections = (yield* fs.readFileString(join(candidate.root, 'CHANGELOG.md'))).split(
    /^(?=## )/m
  )
  const start = sections.findIndex(section => section.startsWith(`## [${candidate.version}]`))
  const end = sections.findIndex(section => section.startsWith(`## [${baseline.version}]`))
  return start === -1 || end === -1 || start > end
    ? ({ kind: 'unplaced' } satisfies Changelog)
    : ({ kind: 'range', sections: sections.slice(start, end) } satisfies Changelog)
})

const auditCandidate = (candidate: PiInstallation) =>
  run('npm', ['audit', '--json'], { cwd: candidate.root, exitCodes: [0, 1] }).pipe(
    Effect.flatMap(({ stdout }) => Schema.decodeEffect(AuditReport)(stdout)),
    Effect.map(renderAudit),
    Effect.catch(error => Effect.succeed(`## Audit: unavailable\n\n${errorText(error)}`))
  )

const resolveCandidate = resolvePiPackage.pipe(
  Effect.provideService(
    ConfigProvider.ConfigProvider,
    ConfigProvider.fromEnv({ env: { DEV_PI_EXECUTABLE: candidateExecutable } })
  )
)

const installCandidate = Effect.fnUntraced(function* (version: PiVersion) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.remove(candidatePrefix, { recursive: true, force: true })
  yield* fs.makeDirectory(candidatePrefix, { recursive: true, mode: 0o700 })
  const install = yield* streamed('npm', [
    'install',
    '--global',
    '--prefix',
    candidatePrefix,
    `${piPackage}@${version}`,
  ])
  if (!install.passed)
    return yield* new PiUpgradeError({
      message: `Cannot install Pi ${version} into ${candidatePrefix}:\n${lastLines(install.output, failureTailLines)}`,
    })
  return yield* resolveCandidate
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
    const result = yield* streamed('npm', ['run', suite], {
      DEV_PI_EXECUTABLE: candidateExecutable,
    })
    results.push({ suite, ...result })
    if (!result.passed) break
  }
  return results
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

const withoutFinalPeriod = (text: string): string => text.trim().replace(/\.+$/, '')

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
    const candidate = yield* installCandidate(upgrade.candidate)
    const pages = yield* contractPages
    const [changelog, surfaces, docs, audit] = yield* Effect.all(
      [
        changelogSections(baseline, candidate),
        compareSurfaces(baseline, candidate),
        compareDocs(pages, baseline, candidate),
        auditCandidate(candidate),
      ],
      { concurrency: 'unbounded' }
    )
    const summary = `Candidate ${upgrade.candidate} from the npm registry; baseline ${baseline.version}, the Pi dev runs today.${baseline.version === upgrade.pin ? '' : ` The checkout pins ${upgrade.pin}, not the baseline.`}`
    const comparison = [
      `## Pi ${upgrade.candidate}\n\n${summary}`,
      renderChangelog(changelog, upgrade, baseline.version),
      renderSurfaces(surfaces),
      renderDocs(pages, docs),
      audit,
    ].join('\n\n')
    const newRelease = upgrade.pin !== upgrade.candidate
    if (newRelease) {
      yield* announcePublication(upgrade, comparison.length + suitesSectionReserve)
      yield* pinCandidate(upgrade)
    }
    const results = yield* runSuites
    const date = DateTime.formatIsoDate(
      DateTime.setZone(yield* DateTime.now, DateTime.zoneMakeLocal())
    )
    const report = renderReport(comparison, results, date)
    yield* Effect.sync(() => {
      process.stdout.write(report)
    })
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(reportPath, report)
    const failed = results.find(result => !result.passed)
    if (failed !== undefined)
      return yield* new PiUpgradeError({
        message: `Pi ${upgrade.candidate} failed ${failed.suite}; nothing was bumped or published. The candidate stays in ${candidatePrefix}.`,
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

const installUnderGate = Effect.fnUntraced(function* (version: PiVersion) {
  yield* acquireMaintenance()
  const pin = yield* readPiPin
  if (pin !== version)
    return yield* new PiUpgradeError({
      message: `Refusing install: the checkout pins Pi ${pin}, not ${version}. Merge its verification pull request and update the checkout first.`,
    })
  const verified = yield* Effect.option(resolveCandidate)
  if (Option.isNone(verified) || verified.value.version !== version)
    return yield* new PiUpgradeError({
      message: `Refusing install: no verified candidate for Pi ${version} in ${candidatePrefix}. Run npm run pi:verify -- --version ${version} first.`,
    })
  const previous = yield* Effect.option(resolvePiPackage)
  if (Option.isSome(previous) && previous.value.root === verified.value.root)
    return yield* new PiUpgradeError({
      message: `Refusing install: dev resolves Pi from the verified candidate itself, so the global install could not be compared with it. Unset DEV_PI_EXECUTABLE first.`,
    })
  const restoreHint = Option.match(
    Option.filter(
      Option.map(previous, installation => installation.version),
      release => release !== version
    ),
    {
      onNone: () => '',
      onSome: release =>
        `\nReinstall ${release} with npm install --global ${piPackage}@${release}.`,
    }
  )
  const install = yield* streamed('npm', ['install', '--global', `${piPackage}@${version}`])
  if (!install.passed)
    return yield* new PiUpgradeError({
      message: `Global install of Pi ${version} failed:\n${lastLines(install.output, failureTailLines)}`,
    })
  const installed = yield* resolvePiPackage
  const differences = yield* changedPaths(verified.value.root, installed.root)
  if (differences.length > 0)
    return yield* new PiUpgradeError({
      message: `Global Pi ${version} is installed, but the Pi dev resolves at ${installed.root} differs from the verified candidate in ${differences.length} paths:\n${differences
        .slice(0, 20)
        .map(change => `${change.status} ${change.path}`)
        .join('\n')}${restoreHint}`,
    })
  const smoke = yield* streamed('npm', ['run', 'smoke'])
  if (!smoke.passed)
    return yield* new PiUpgradeError({
      message: `Global Pi ${version} matches the verified candidate, but smoke failed:\n${lastLines(smoke.output, failureTailLines)}${restoreHint}`,
    })
  const fs = yield* FileSystem.FileSystem
  yield* fs.remove(candidatePrefix, { recursive: true })
}, Effect.scoped)

export const installPi = Effect.fn('installPi')(
  function* (requested: string) {
    const version = yield* decodeVersion(requested)
    yield* installUnderGate(version)
    const diagnostics = yield* run('dev', ['--diagnostics']).pipe(
      Effect.mapError(
        error =>
          new PiUpgradeError({
            message: `Installed Pi ${version} globally, byte for byte the verified candidate, but dev --diagnostics failed: ${error.message}`,
            cause: error,
          })
      )
    )
    yield* Effect.sync(() => {
      process.stdout.write(
        `${diagnostics.stdout}\nInstalled Pi ${version} globally, byte for byte the verified candidate.\n`
      )
    })
  },
  Effect.mapError(error =>
    error instanceof PiUpgradeError ? error : failure('Pi install failed')(error)
  )
)
