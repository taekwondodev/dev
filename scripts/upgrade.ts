import { basename, join, relative } from 'node:path'
import { Array as Arr, DateTime, Effect, FileSystem, Option, Predicate, Schema } from 'effect'
import { errorText } from '../src/error-text.ts'
import { resolvePiPackage } from '../src/pi-runtime.ts'
import { acquireMaintenance } from '../src/runtime-coordination.ts'
import { git, npmInstallFlags, run, streamed, upgradeHome } from './checkout.ts'
import { type AuditSummary, auditAt, auditRow } from './npm-audit.ts'
import {
  candidateRelease,
  comparePi,
  refuseSelectedRelease,
  latestVersion,
  type PiComparison,
  piRows,
  piSections,
  PiUpgradeError,
  PiVersion,
} from './pi-upgrade.ts'
import { cell, collapsed, counted, fence, lastLines, listed, withoutFinalPeriod } from './report.ts'

export class UpgradeError extends Schema.TaggedError<UpgradeError>()('UpgradeError', {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const worktree = join(upgradeHome, 'worktree')
const reportPath = join(upgradeHome, 'report.md')
const bodyPath = join(upgradeHome, 'pull-request.md')
const branchPrefix = 'chore/upgrade-'
const upgradeBranch = /^chore\/upgrade-\d{4}-\d{2}-\d{2}(?:-\d+)?$/
const manifestFiles = ['package.json', 'package-lock.json']
const suites = [
  'lint',
  'format:check',
  'smoke',
  'profile:check',
  'workspace:check',
  'workspace:tui',
  'workspace:github',
  'work:check',
] as const
type Step = 'install' | (typeof suites)[number]
const pullRequestBodyLimit = 65_536
const nodeMajor = Number(process.versions.node.split('.')[0])
const candidateFromWorktree = `DEV_PI_RELEASE="$PWD/${relative(worktree, candidateRelease)}" `

const Versions = Schema.Record(Schema.String, Schema.String)
type Versions = typeof Versions.Type

const Manifest = Schema.Struct({
  dependencies: Schema.optional(Versions),
  devDependencies: Schema.optional(Versions),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  engines: Schema.optional(Versions),
  config: Schema.Struct({ pi: PiVersion }),
})
type Manifest = typeof Manifest.Type

const ManifestDocument = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

const PublishedVersions = Schema.fromJsonString(
  Schema.Union([
    Schema.String,
    Schema.NonEmptyArray(Schema.String),
    Schema.Struct({ error: Schema.Struct({ code: Schema.String, summary: Schema.String }) }),
  ])
)

const PullRequests = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      number: Schema.Int,
      headRefName: Schema.String,
      isCrossRepository: Schema.Boolean,
      url: Schema.String,
    })
  )
)
type PullRequest = (typeof PullRequests.Type)[number]

const Lockfile = Schema.fromJsonString(
  Schema.Struct({
    packages: Schema.Record(
      Schema.String,
      Schema.Struct({ hasInstallScript: Schema.optional(Schema.Boolean) })
    ),
  })
)

interface ManifestFile {
  readonly document: Record<string, unknown>
  readonly manifest: Manifest
}

interface Change {
  readonly name: string
  readonly from: string | undefined
  readonly to: string | undefined
}

interface StepResult {
  readonly step: Step
  readonly command: string
  readonly passed: boolean
  readonly ms: number
  readonly output: string
}

interface Verification {
  readonly install: StepResult
  readonly suites: readonly StepResult[]
  readonly pi: Option.Option<PiComparison>
  readonly audit: Option.Option<AuditSummary>
  readonly installScripts: Option.Option<readonly string[]>
}

interface Upgrade {
  readonly branch: Option.Option<{ readonly name: string; readonly detached: boolean }>
  readonly verified: { readonly commit: string; readonly upgraded: boolean }
  readonly pins: { readonly from: PiVersion; readonly to: PiVersion }
  readonly changes: readonly Change[]
  readonly engine: Change | undefined
  readonly verification: Verification
}

interface Detail {
  readonly docs: boolean
  readonly tail: number
}

const failure = (what: string) => (cause: unknown) =>
  new UpgradeError({ message: `${what}: ${errorText(cause)}`, cause })

const say = (text: string) =>
  Effect.sync(() => {
    process.stdout.write(text)
  })

const today = Effect.gen(function* () {
  return DateTime.formatIsoDate(DateTime.setZone(yield* DateTime.now, DateTime.zoneMakeLocal()))
})

const inWorktree = (args: readonly string[]) => git(['-C', worktree, ...args])

const lines = (text: string): readonly string[] => text.split('\n').filter(line => line !== '')

const parseManifest = Effect.fnUntraced(function* (text: string, source: string) {
  const unreadable = failure(`Cannot read package.json at ${source}`)
  const document = yield* Schema.decodeEffect(ManifestDocument)(text).pipe(
    Effect.mapError(unreadable)
  )
  const manifest = yield* Schema.decodeUnknownEffect(Manifest)(document).pipe(
    Effect.mapError(unreadable)
  )
  return { document, manifest } satisfies ManifestFile
})

const manifestAt = Effect.fnUntraced(function* (revision: string) {
  return yield* parseManifest(yield* git(['show', `${revision}:package.json`]), revision)
})

const versionSpec = /^([~^]?)((\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?)$/

const prereleaseOrder = (left: string | undefined, right: string | undefined): number => {
  if (left === right) return 0
  if (left === undefined) return 1
  if (right === undefined) return -1
  const a = left.split('.')
  const b = right.split('.')
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const [x, y] = [a[index], b[index]]
    if (x === y) continue
    const [xn, yn] = [/^\d+$/.test(x), /^\d+$/.test(y)]
    if (xn && yn) return Number(x) - Number(y)
    if (xn !== yn) return xn ? -1 : 1
    return x < y ? -1 : 1
  }
  return a.length - b.length
}

const newer = (candidate: string, current: string): boolean => {
  const a = versionSpec.exec(candidate)
  const b = versionSpec.exec(current)
  if (a === null || b === null) return false
  for (const index of [3, 4, 5]) {
    const order = Number(a[index]) - Number(b[index])
    if (order !== 0) return order > 0
  }
  return prereleaseOrder(a[6], b[6]) > 0
}

const isBreaking = ({ from, to }: Change): boolean => {
  if (from === undefined || to === undefined) return true
  const before = versionSpec.exec(from)
  const after = versionSpec.exec(to)
  if (before === null || after === null || before[6] !== undefined) return true
  return before[3] !== after[3] || (before[3] === '0' && before[4] !== after[4])
}

const publishedVersion = Effect.fnUntraced(function* (name: string, range: string) {
  const { stdout } = yield* run('npm', ['view', `${name}@${range}`, 'version', '--json'], {
    exitCodes: [0, 1],
  })
  const published = yield* Schema.decodeEffect(PublishedVersions)(stdout).pipe(
    Effect.mapError(failure(`Cannot read the ${name} releases matching ${range}`))
  )
  if (typeof published === 'string') return Option.some(published)
  if (!('error' in published)) return Option.some(Arr.lastNonEmpty(published))
  if (published.error.code === 'E404') return Option.none<string>()
  return yield* new UpgradeError({
    message: `Cannot read the ${name} releases matching ${range}: ${published.error.summary}`,
  })
})

const target = Effect.fnUntraced(function* (name: string, spec: string) {
  const parsed = versionSpec.exec(spec)
  if (parsed === null) return spec
  const range = name === '@types/node' ? String(nodeMajor) : 'latest'
  const published = yield* publishedVersion(name, range)
  return Option.isSome(published) && newer(published.value, parsed[2])
    ? `${parsed[1]}${published.value}`
    : spec
})

const upgradedVersions = Effect.fnUntraced(function* (versions: Versions | undefined) {
  if (versions === undefined) return undefined
  const entries = yield* Effect.forEach(
    Object.entries(versions),
    ([name, spec]) => target(name, spec).pipe(Effect.map(to => [name, to] as const)),
    { concurrency: 8 }
  )
  return Object.fromEntries(entries)
})

const raisedEngines = (engines: Versions | undefined): Versions | undefined => {
  const minimum = /^>=\s*(\d+)(?:\.\d+){0,2}$/.exec(engines?.node ?? '')
  return minimum === null || Number(minimum[1]) >= nodeMajor
    ? engines
    : { ...engines, node: `>=${nodeMajor}.0.0` }
}

const overrideTarget = Effect.fnUntraced(function* (
  name: string,
  value: unknown,
  pinned: Versions
) {
  if (!Predicate.isString(value)) return value
  const parsed = versionSpec.exec(value)
  if (parsed === null) return value
  const dependency = pinned[name]
  return dependency === undefined
    ? yield* target(name, value)
    : `${parsed[1]}${dependency.replace(/^[~^]/, '')}`
})

const upgradedManifest = Effect.fnUntraced(function* (
  { document, manifest }: ManifestFile,
  pi: PiVersion
) {
  const [dependencies, devDependencies] = yield* Effect.all([
    upgradedVersions(manifest.dependencies),
    upgradedVersions(manifest.devDependencies),
  ])
  const pinned: Versions = { ...dependencies, ...devDependencies }
  const overrides =
    manifest.overrides === undefined
      ? undefined
      : Object.fromEntries(
          yield* Effect.forEach(Object.entries(manifest.overrides), ([name, value]) =>
            overrideTarget(name, value, pinned).pipe(Effect.map(to => [name, to] as const))
          )
        )
  const upgraded: Record<string, unknown> = { ...document }
  if (dependencies !== undefined) upgraded.dependencies = dependencies
  if (devDependencies !== undefined) upgraded.devDependencies = devDependencies
  if (overrides !== undefined) upgraded.overrides = overrides
  const engines = raisedEngines(manifest.engines)
  if (engines !== undefined) upgraded.engines = engines
  upgraded.config = { ...(Predicate.isObject(document.config) ? document.config : {}), pi }
  return `${JSON.stringify(upgraded, null, 2)}\n`
})

const changedVersions = (base: Versions = {}, head: Versions = {}): readonly Change[] =>
  [...new Set([...Object.keys(base), ...Object.keys(head)])]
    .toSorted()
    .flatMap(name =>
      base[name] === head[name] ? [] : [{ name, from: base[name], to: head[name] }]
    )

const dependencyChanges = (base: Manifest, head: Manifest): readonly Change[] => [
  ...changedVersions(base.dependencies, head.dependencies),
  ...changedVersions(base.devDependencies, head.devDependencies),
]

const engineChange = (base: Manifest, head: Manifest): Change | undefined =>
  base.engines?.node === head.engines?.node
    ? undefined
    : { name: 'engines.node', from: base.engines?.node, to: head.engines?.node }

const openUpgrades = run('gh', [
  'pr',
  'list',
  '--state',
  'open',
  '--base',
  'main',
  '--limit',
  '100',
  '--json',
  'number,headRefName,isCrossRepository,url',
]).pipe(
  Effect.flatMap(({ stdout }) => Schema.decodeEffect(PullRequests)(stdout)),
  Effect.map(pullRequests =>
    pullRequests.filter(pr => !pr.isCrossRepository && upgradeBranch.test(pr.headRefName))
  ),
  Effect.mapError(failure('Cannot list open upgrade pull requests'))
)

const worktreePaths = Effect.fnUntraced(function* (flags: readonly string[]) {
  return lines(yield* inWorktree(['status', '--porcelain', '--untracked-files=all', ...flags])).map(
    line => line.slice(3)
  )
})

const MergedPullRequests = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ headRefOid: Schema.String, isCrossRepository: Schema.Boolean }))
)

const hasMergedPullRequest = Effect.fnUntraced(function* (branch: string, head: string) {
  if (branch === '') return false
  const { stdout } = yield* run('gh', [
    'pr',
    'list',
    '--state',
    'merged',
    '--head',
    branch,
    '--json',
    'headRefOid,isCrossRepository',
  ])
  const merged = yield* Schema.decodeEffect(MergedPullRequests)(stdout).pipe(
    Effect.mapError(failure(`Cannot read the merged pull requests of ${branch}`))
  )
  for (const pullRequest of merged.filter(pr => !pr.isCrossRepository)) {
    const { exitCode } = yield* run(
      'git',
      ['merge-base', '--is-ancestor', head, pullRequest.headRefOid],
      { exitCodes: [0, 1, 128] }
    )
    if (exitCode === 0) return true
  }
  return false
})

const releaseWorktree = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  if (!(yield* fs.exists(worktree))) return yield* git(['worktree', 'prune'])
  const refuse = (reason: string) =>
    new UpgradeError({ message: `Refusing to replace ${worktree}: ${reason}.` })
  if ((yield* inWorktree(['rev-parse', '--show-toplevel'])) !== (yield* fs.realPath(worktree)))
    return yield* refuse('it is not a Git worktree; remove the directory first')
  const leftovers = (yield* worktreePaths(['--ignored'])).filter(
    path => !path.startsWith('node_modules/') && basename(path) !== '.DS_Store'
  )
  const branch = yield* inWorktree(['branch', '--show-current'])
  const unmerged = yield* inWorktree(['rev-list', 'HEAD', '--not', 'origin/main'])
  const ownAttempt = unmerged === '' && leftovers.every(path => manifestFiles.includes(path))
  if (!ownAttempt && leftovers.length > 0)
    return yield* refuse(
      `it has uncommitted or ignored files (${listed(leftovers)}); commit and push them, or remove them`
    )
  if (
    (yield* inWorktree(['rev-list', 'HEAD', '--not', '--remotes'])) !== '' &&
    !(yield* hasMergedPullRequest(branch, yield* inWorktree(['rev-parse', 'HEAD'])))
  )
    return yield* refuse(
      `it has commits that are not on origin; push them with git -C ${worktree} push origin HEAD:${branch === '' ? '<branch>' : branch}`
    )
  yield* git(['worktree', 'remove', '--force', worktree])
  yield* git(['worktree', 'prune'])
  if (ownAttempt && branch.startsWith(branchPrefix))
    yield* git(['branch', '--delete', '--force', branch])
})

const freeBranch = Effect.fnUntraced(function* (date: string) {
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const branch = `${branchPrefix}${date}${attempt === 1 ? '' : `-${attempt}`}`
    const local = yield* git(['branch', '--list', branch])
    const remote = yield* git(['ls-remote', '--heads', 'origin', branch])
    if (local === '' && remote === '') return branch
  }
  return yield* new UpgradeError({ message: `No free ${branchPrefix}${date} branch name` })
})

const install = Effect.fnUntraced(function* (refresh: boolean) {
  const commands = refresh ? [['install'], ['update']] : [['ci']]
  let output = ''
  let ms = 0
  for (const command of commands) {
    const args = [...command, ...npmInstallFlags]
    const result = yield* streamed('npm', args, {}, worktree)
    output += result.output
    ms += result.ms
    if (!result.passed)
      return {
        step: 'install',
        command: `npm ${command[0]} --ignore-scripts`,
        passed: false,
        ms,
        output,
      } satisfies StepResult
  }
  return {
    step: 'install',
    command: refresh ? 'npm install --ignore-scripts' : 'npm ci --ignore-scripts',
    passed: true,
    ms,
    output,
  } satisfies StepResult
})

const installScripts = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const lockfile = yield* Schema.decodeEffect(Lockfile)(
    yield* fs.readFileString(join(worktree, 'package-lock.json'))
  )
  return Object.entries(lockfile.packages)
    .filter(([, entry]) => entry.hasInstallScript === true)
    .map(([path]) => path.replace(/^.*node_modules\//, ''))
}).pipe(Effect.mapError(failure('Cannot read the upgraded package-lock.json')))

const verify = Effect.fnUntraced(function* (base: Manifest, head: Manifest, refresh: boolean) {
  const active = yield* resolvePiPackage
  const pi =
    head.config.pi === active.version
      ? Option.none<PiComparison>()
      : Option.some(yield* comparePi(base.config.pi, head.config.pi))
  const installed = yield* install(refresh)
  const env: Record<string, string> = Option.isSome(pi) ? { DEV_PI_RELEASE: candidateRelease } : {}
  if (!installed.passed)
    return {
      install: installed,
      suites: [],
      pi,
      audit: Option.none(),
      installScripts: Option.none(),
    } satisfies Verification
  const ran = yield* Effect.forEach(suites, suite =>
    streamed('npm', ['run', suite], env, worktree).pipe(
      Effect.map((result): StepResult => ({ step: suite, command: `npm run ${suite}`, ...result }))
    )
  )
  return {
    install: installed,
    suites: ran,
    pi,
    audit: Option.some(yield* auditAt(worktree, 'all')),
    installScripts: Option.some(yield* installScripts),
  } satisfies Verification
})

const failures = ({ install: installed, suites: ran }: Verification): readonly StepResult[] =>
  [installed, ...ran].filter(result => !result.passed)

const isGreen = (upgrade: Upgrade): boolean => failures(upgrade.verification).length === 0

const dependencyCount = (count: number): string =>
  `${count} ${count === 1 ? 'dependency' : 'dependencies'}`

const pullRequestTitle = (upgrade: Upgrade): string => {
  const subjects = [
    ...(upgrade.pins.from === upgrade.pins.to ? [] : [`Pi ${upgrade.pins.to}`]),
    ...(upgrade.changes.length === 0 ? [] : [dependencyCount(upgrade.changes.length)]),
  ]
  return `chore: upgrade ${subjects.length === 0 ? 'the Node minimum' : subjects.join(' and ')}`
}

const markedTitle = (upgrade: Upgrade): string =>
  isGreen(upgrade) ? pullRequestTitle(upgrade) : `[red] ${pullRequestTitle(upgrade)}`

const rerun = (upgrade: Upgrade, result: StepResult): string =>
  result.step !== 'install' && Option.isSome(upgrade.verification.pi)
    ? `${candidateFromWorktree}${result.command}`
    : result.command

const checksRow = (verification: Verification): string => {
  if (!verification.install.passed) return 'install failed; suites not run'
  const failed = failures(verification)
  return failed.length === 0
    ? `${verification.suites.length}/${suites.length} green`
    : `red: ${listed(failed.map(result => result.step))}`
}

const dependenciesRow = (changes: readonly Change[]): string => {
  if (changes.length === 0) return 'unchanged'
  const breaking = changes.filter(isBreaking).length
  return `${changes.length} changed${breaking === 0 ? '' : `, ${breaking} breaking`}`
}

const installScriptsRow = (scripts: Option.Option<readonly string[]>): string =>
  Option.match(scripts, {
    onNone: () => 'not checked: install failed',
    onSome: names => (names.length === 0 ? 'none' : `not run: ${listed(names)}`),
  })

const auditCell = (audit: Option.Option<AuditSummary>): string =>
  Option.match(audit, { onNone: () => 'not checked: install failed', onSome: auditRow })

const howToFix = (upgrade: Upgrade): string =>
  Option.match(upgrade.branch, {
    onNone: () =>
      'Fix on a branch from `main` and merge it, then run `npm run upgrade` again to verify the pinned Pi.',
    onSome: ({ name, detached }) =>
      `Fix on \`${name}\`, for example in the installation's \`.dev/upgrade/worktree\`, push${detached ? ` with \`git push origin HEAD:${name}\`` : ''}, then run \`npm run upgrade\` again: it re-verifies this pull request and replaces this report.`,
  })

const beforeMerging = (upgrade: Upgrade, tail: number): readonly string[] => {
  const failed = failures(upgrade.verification)
  const scripts = Option.getOrElse(upgrade.verification.installScripts, () => [])
  if (failed.length === 0 && scripts.length === 0) return []
  return [
    `### Before merging\n\n${howToFix(upgrade)}`,
    ...failed.map(result =>
      [
        `#### \`${result.step}\` failed`,
        `Rerun in the worktree: \`${rerun(upgrade, result)}\``,
        ...(tail > 0 ? [fence('text', lastLines(result.output, tail))] : []),
      ].join('\n\n')
    ),
    ...(scripts.length === 0
      ? []
      : [
          `#### Install scripts not run\n\nThe upgrade installs with \`--ignore-scripts\`. Check that these packages work without their install scripts: ${listed(scripts)}.`,
        ]),
  ]
}

const renderChanges = (upgrade: Upgrade): string => {
  const rows = [...upgrade.changes, ...(upgrade.engine === undefined ? [] : [upgrade.engine])]
  if (rows.length === 0) return '### Dependencies\n\nUnchanged.'
  return [
    '### Dependencies',
    [
      '| Package | From | To | Breaking |',
      '| --- | --- | --- | --- |',
      ...rows.map(
        change =>
          `| \`${change.name}\` | ${change.from ?? 'added'} | ${change.to ?? 'removed'} | ${isBreaking(change) ? 'yes' : ''} |`
      ),
    ].join('\n'),
  ].join('\n\n')
}

const renderTimes = (verification: Verification): string =>
  collapsed(
    'Checks and times',
    [
      '| Check | Result | Time |',
      '| --- | --- | --- |',
      ...(['install', ...suites] as const).map(step => {
        const result = [verification.install, ...verification.suites].find(ran => ran.step === step)
        if (result === undefined) return `| \`${step}\` | not run | |`
        return `| \`${step}\` | ${result.passed ? 'passed' : 'failed'} | ${Math.round(result.ms / 1000)} s |`
      }),
    ].join('\n')
  )

const afterMerging = (upgrade: Upgrade): string =>
  Option.isSome(upgrade.verification.pi)
    ? 'After merging: `npm run update`, then `npm run pi:update`, then `npm run profile` after one live session.'
    : 'After merging: `npm run update`.'

const renderSummary = (upgrade: Upgrade): readonly string[] => {
  const { verification } = upgrade
  const failed = failures(verification)
  const pi = Option.getOrUndefined(verification.pi)
  return [
    `## Upgrade ${failed.length === 0 ? 'green' : `red: ${counted(failed.length, 'check')} failing`}`,
    [
      upgrade.pins.from === upgrade.pins.to
        ? `Pi ${upgrade.pins.to}, unchanged.`
        : `Pi ${upgrade.pins.from} to ${upgrade.pins.to}.`,
      ...(pi === undefined ? [] : [pi.summary]),
    ].join(' '),
    [
      '| Check | Result |',
      '| --- | --- |',
      `| Checks | ${cell(checksRow(verification))} |`,
      `| Dependencies | ${cell(dependenciesRow(upgrade.changes))} |`,
      `| Install scripts | ${cell(installScriptsRow(verification.installScripts))} |`,
      `| Audit | ${cell(auditCell(verification.audit))} |`,
      ...(pi === undefined ? [] : piRows(pi)),
    ].join('\n'),
  ]
}

const verifiedLine = (upgrade: Upgrade, date: string): string =>
  `Verified ${upgrade.verified.upgraded ? 'the upgrade of main at ' : ''}${upgrade.verified.commit.slice(0, 12)} on ${date} with Node ${process.version}.`

const renderReport = (upgrade: Upgrade, detail: Detail, date: string): string => {
  const pi = Option.getOrUndefined(upgrade.verification.pi)
  return `${[
    ...renderSummary(upgrade),
    ...beforeMerging(upgrade, detail.tail),
    renderChanges(upgrade),
    ...(pi === undefined ? [] : piSections(pi, { docs: detail.docs })),
    renderTimes(upgrade.verification),
    afterMerging(upgrade),
    verifiedLine(upgrade, date),
  ].join('\n\n')}\n`
}

const fittedBody = (upgrade: Upgrade, date: string): string => {
  const details: readonly Detail[] = [
    { docs: true, tail: 60 },
    { docs: false, tail: 60 },
    { docs: false, tail: 20 },
    { docs: false, tail: 5 },
  ]
  for (const detail of details) {
    const body = renderReport(upgrade, detail, date)
    if (body.length <= pullRequestBodyLimit) return body
  }
  return `${[
    ...renderSummary(upgrade),
    `${howToFix(upgrade)}\n\nThe full report exceeds the pull request body limit. It is saved in \`.dev/upgrade/report.md\` of the installation that ran \`npm run upgrade\`.`,
    afterMerging(upgrade),
    verifiedLine(upgrade, date),
  ].join('\n\n')}\n`
}

const writeReports = Effect.fnUntraced(function* (upgrade: Upgrade, date: string) {
  const fs = yield* FileSystem.FileSystem
  const report = renderReport(upgrade, { docs: true, tail: 80 }, date)
  yield* fs.writeFileString(reportPath, report)
  yield* fs.writeFileString(bodyPath, fittedBody(upgrade, date))
  yield* say(report)
})

const shellWord = (argument: string): string =>
  /^[\w./:@=-]+$/.test(argument) ? argument : `'${argument.replaceAll("'", String.raw`'\''`)}'`

const ghCommand = (args: readonly string[]): string => ['gh', ...args].map(shellWord).join(' ')

const outcome = (upgrade: Upgrade): string =>
  isGreen(upgrade)
    ? 'green'
    : `red; fix it on ${Option.match(upgrade.branch, { onNone: () => 'its branch', onSome: ({ name }) => name })}, for example in ${worktree}, push and run npm run upgrade again`

const openPullRequest = Effect.fnUntraced(function* (upgrade: Upgrade, branch: string) {
  const others = (yield* worktreePaths([])).filter(path => !manifestFiles.includes(path))
  if (others.length > 0)
    return yield* new UpgradeError({
      message: `Not publishing: the checks changed ${listed(others)} in ${worktree}. The report is in ${reportPath}.`,
    })
  const create = [
    'pr',
    'create',
    '--base',
    'main',
    '--head',
    branch,
    '--title',
    markedTitle(upgrade),
    '--body-file',
    bodyPath,
  ]
  yield* inWorktree(['commit', '--message', pullRequestTitle(upgrade), '--', ...manifestFiles])
  yield* inWorktree(['push', '--set-upstream', 'origin', branch]).pipe(
    Effect.mapError(
      error =>
        new UpgradeError({
          message: `Committed ${branch} in ${worktree}, but could not push it: ${withoutFinalPeriod(error.message)}. Push it with git -C ${worktree} push --set-upstream origin ${branch}, then open its pull request with ${ghCommand(create)}.`,
          cause: error,
        })
    )
  )
  const { stdout } = yield* run('gh', create).pipe(
    Effect.mapError(
      error =>
        new UpgradeError({
          message: `Pushed ${branch}, but no pull request was opened: ${withoutFinalPeriod(error.message)}. Open it with ${ghCommand(create)}.`,
          cause: error,
        })
    )
  )
  yield* say(`Opened ${stdout.trim()} from ${branch}: ${outcome(upgrade)}.\n`)
})

const fresh = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const date = yield* today
  const baseCommit = yield* git(['rev-parse', 'origin/main'])
  const base = yield* manifestAt(baseCommit)
  const pi = yield* latestVersion
  const upgradedText = yield* upgradedManifest(base, pi)
  const head = yield* parseManifest(upgradedText, 'the upgraded manifest')
  const changes = dependencyChanges(base.manifest, head.manifest)
  const engine = engineChange(base.manifest, head.manifest)
  const changed = changes.length > 0 || engine !== undefined || base.manifest.config.pi !== pi
  const active = yield* resolvePiPackage
  if (!changed && active.version === pi)
    return yield* say(
      `Nothing to upgrade: main pins the latest Pi ${pi}, which is active, and every dependency is at its target.\n`
    )
  yield* releaseWorktree
  const branch = changed ? Option.some(yield* freeBranch(date)) : Option.none<string>()
  yield* git([
    'worktree',
    'add',
    ...Option.match(branch, {
      onNone: () => ['--detach'],
      onSome: name => ['--no-track', '-b', name],
    }),
    worktree,
    baseCommit,
  ])
  if (changed) yield* fs.writeFileString(join(worktree, 'package.json'), upgradedText)
  const upgrade: Upgrade = {
    branch: Option.map(branch, name => ({ name, detached: false })),
    verified: { commit: baseCommit, upgraded: true },
    pins: { from: base.manifest.config.pi, to: pi },
    changes,
    engine,
    verification: yield* verify(base.manifest, head.manifest, changed),
  }
  yield* writeReports(upgrade, date)
  if (Option.isSome(branch)) return yield* openPullRequest(upgrade, branch.value)
  if (!isGreen(upgrade))
    return yield* new UpgradeError({
      message: `main pins Pi ${pi}, but it failed checks against that release; see ${reportPath}.`,
    })
  yield* say(
    `main pins Pi ${pi} and it passed every check. Activate it with npm run update, then npm run pi:update.\n`
  )
})

const reverify = Effect.fnUntraced(function* (pullRequest: PullRequest) {
  const fs = yield* FileSystem.FileSystem
  const date = yield* today
  const branch = pullRequest.headRefName
  const remote = `origin/${branch}`
  yield* git(['fetch', '--quiet', 'origin', branch])
  if (
    (yield* git(['branch', '--list', branch])) !== '' &&
    (yield* git(['rev-list', branch, '--not', remote])) !== ''
  )
    return yield* new UpgradeError({
      message: `Refusing to re-verify ${pullRequest.url}: the local branch ${branch} has commits that are not on ${remote}. Push them first.`,
    })
  yield* releaseWorktree
  const checkedOut = lines(yield* git(['worktree', 'list', '--porcelain'])).includes(
    `branch refs/heads/${branch}`
  )
  yield* git(['worktree', 'add', ...(checkedOut ? ['--detach'] : ['-B', branch]), worktree, remote])
  const commit = yield* inWorktree(['rev-parse', 'HEAD'])
  const base = yield* manifestAt(yield* git(['merge-base', 'origin/main', remote]))
  const head = yield* parseManifest(
    yield* fs.readFileString(join(worktree, 'package.json')),
    remote
  )
  const upgrade: Upgrade = {
    branch: Option.some({ name: branch, detached: checkedOut }),
    verified: { commit, upgraded: false },
    pins: { from: base.manifest.config.pi, to: head.manifest.config.pi },
    changes: dependencyChanges(base.manifest, head.manifest),
    engine: engineChange(base.manifest, head.manifest),
    verification: yield* verify(base.manifest, head.manifest, false),
  }
  yield* writeReports(upgrade, date)
  const edit = [
    'pr',
    'edit',
    String(pullRequest.number),
    '--title',
    markedTitle(upgrade),
    '--body-file',
    bodyPath,
  ]
  if ((yield* worktreePaths([])).length > 0)
    return yield* new UpgradeError({
      message: `Not updating ${pullRequest.url}: the checks changed files in ${worktree}. The report is in ${reportPath}.`,
    })
  const [current] = (yield* git(['ls-remote', 'origin', `refs/heads/${branch}`])).split('\t')
  if (current !== commit)
    return yield* new UpgradeError({
      message: `Not updating ${pullRequest.url}: ${branch} moved or was deleted on origin during verification; run npm run upgrade again to verify its current head.`,
    })
  yield* run('gh', edit).pipe(
    Effect.mapError(
      error =>
        new UpgradeError({
          message: `Verified ${branch}, but could not update ${pullRequest.url}: ${withoutFinalPeriod(error.message)}. Update it with ${ghCommand(edit)}.`,
          cause: error,
        })
    )
  )
  yield* say(`Re-verified ${pullRequest.url}: ${outcome(upgrade)}.\n`)
})

export const runUpgrade = Effect.fn('runUpgrade')(
  function* () {
    yield* refuseSelectedRelease('upgrade')
    yield* acquireMaintenance()
    yield* git(['fetch', '--quiet', 'origin', 'main'])
    const open = yield* openUpgrades
    if (open.length > 1)
      return yield* new UpgradeError({
        message: `Refusing upgrade: ${counted(open.length, 'upgrade pull request')} are open (${open.map(pr => pr.url).join(', ')}). Close all but one.`,
      })
    const [pullRequest] = open
    return yield* pullRequest === undefined ? fresh : reverify(pullRequest)
  },
  Effect.scoped,
  Effect.mapError(error => {
    if (error instanceof UpgradeError) return error
    if (error instanceof PiUpgradeError)
      return new UpgradeError({ message: error.message, cause: error })
    return failure('Upgrade failed')(error)
  })
)
