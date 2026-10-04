import { join, resolve } from 'node:path'
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import {
  Array as Arr,
  Cause,
  Config,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schema,
  Stdio,
} from 'effect'
import { CliConfig, type CliError, Command, Flag, GlobalFlag } from 'effect/cli'
import { FetchHttpClient } from 'effect/http'
import { errorText } from '../src/error-text.ts'
import { defaultDataHome, sessionDir } from '../src/preferences.ts'
import { acquireMaintenance } from '../src/runtime-coordination.ts'
import { linkPiDeclarations, resolvePiPackage } from '../src/pi-runtime.ts'
import { checkout, checkoutIsClean, git, npmInstallFlags, run, streamed } from './checkout.ts'
import { updatePi } from './pi-upgrade.ts'
import { lastLines } from './report.ts'
import { runUpgrade } from './upgrade.ts'
import { ALL_TIME, parsePeriod, profileUsage } from './usage-profile.ts'

export class MaintenanceError extends Schema.TaggedError<MaintenanceError>()('MaintenanceError', {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const failed = (operation: string, cause: unknown): MaintenanceError =>
  new MaintenanceError({ message: `${operation}: ${errorText(cause)}`, cause })

const reported = (error: { readonly message: string }): MaintenanceError =>
  new MaintenanceError({ message: error.message, cause: error })

const say = (text: string) =>
  Effect.sync(() => {
    process.stdout.write(text)
  })

const assertPrivateDataProtected = Effect.fnUntraced(
  function* (ref: string) {
    const fs = yield* FileSystem.FileSystem
    if (!(yield* fs.exists(join(checkout, '.dev')))) return
    const ignore = (yield* git(['show', `${ref}:.gitignore`])).split(/\r?\n/)
    const tracked = yield* git(['ls-tree', '-r', '--name-only', ref, '--', '.dev'])
    if (!ignore.includes('/.dev/') || ignore.some(line => line.startsWith('!')) || tracked)
      return yield* new MaintenanceError({
        message:
          'Refusing checkout: private .dev data requires an explicit /.dev/ ignore rule, no negation rules, and no tracked contents. Relocate that data explicitly before using this revision.',
      })
  },
  Effect.mapError(error =>
    error._tag === 'MaintenanceError'
      ? error
      : failed('Cannot verify private data protection', error)
  )
)

const setup = Effect.fnUntraced(
  function* (requestedDataHome: Option.Option<string>) {
    const fs = yield* FileSystem.FileSystem
    const dataHome = Option.isSome(requestedDataHome)
      ? requestedDataHome.value
      : yield* defaultDataHome
    yield* acquireMaintenance()
    const pi = yield* resolvePiPackage
    yield* linkPiDeclarations
    const home = yield* Config.option(
      Config.String('HOME').pipe(Config.orElse(() => Config.String('USERPROFILE')))
    )
    if (Option.isNone(home))
      return yield* new MaintenanceError({
        message: 'HOME is required to inspect shared workflow skills',
      })
    const shared = yield* Config.String('DEV_SHARED_SKILLS').pipe(
      Config.withDefault(`${home.value}/Developer/skills`)
    )
    yield* fs.makeDirectory(dataHome, { recursive: true, mode: 0o700 })
    yield* sessionDir(dataHome)
    const observation = {
      node: process.version,
      pi: { version: pi.version, root: pi.root },
      sharedWorkflow: {
        path: shared,
        revision: yield* git(['-C', shared, 'rev-parse', 'HEAD']),
        dirty: (yield* git(['-C', shared, 'status', '--porcelain'])) !== '',
      },
    }
    yield* fs.writeFileString(
      join(dataHome, 'dependency-observation.json'),
      `${JSON.stringify(observation, null, 2)}\n`,
      { mode: 0o600 }
    )
    yield* say(`setup recorded dependencies in ${dataHome}\n`)
  },
  Effect.scoped,
  Effect.mapError(error =>
    error._tag === 'MaintenanceError' ? error : failed('Setup failed', error)
  )
)

const update = Effect.fnUntraced(
  function* (options: { readonly remote: string; readonly branch: Option.Option<string> }) {
    const { remote } = options
    yield* acquireMaintenance()
    if (!(yield* checkoutIsClean))
      return yield* new MaintenanceError({
        message:
          'Refusing update: dev checkout has local changes. Preserve them explicitly before updating.',
      })
    const branch = Option.isSome(options.branch)
      ? options.branch.value
      : yield* git(['branch', '--show-current'])
    yield* git(['fetch', remote, branch])
    yield* assertPrivateDataProtected(`${remote}/${branch}`)
    const previous = yield* git(['rev-parse', 'HEAD'])
    yield* git(['merge', '--ff-only', `${remote}/${branch}`])
    yield* say(`updated dev checkout from ${remote}/${branch}\n`)
    const lockfile = yield* run(
      'git',
      ['diff', '--quiet', previous, 'HEAD', '--', 'package-lock.json'],
      {
        exitCodes: [0, 1],
      }
    )
    if (lockfile.exitCode === 0) return
    const install = yield* streamed('npm', ['ci', ...npmInstallFlags])
    if (!install.passed)
      return yield* new MaintenanceError({
        message: `Updated the checkout, but npm ci failed; rerun npm ci --ignore-scripts && npm run types:pi:\n${lastLines(install.output, 40)}`,
      })
    yield* linkPiDeclarations
    yield* say('reinstalled dependencies from the updated package-lock.json\n')
  },
  Effect.scoped,
  Effect.mapError(error =>
    error._tag === 'MaintenanceError' ? error : failed('Update failed', error)
  )
)

const rollback = Effect.fnUntraced(
  function* (ref: Option.Option<string>) {
    yield* acquireMaintenance()
    if (Option.isNone(ref))
      return yield* new MaintenanceError({
        message: 'Rollback requires an explicit --ref and changes only the dev checkout.',
      })
    const revision = yield* git([
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${ref.value}^{commit}`,
    ])
    yield* assertPrivateDataProtected(revision)
    if (!(yield* checkoutIsClean))
      return yield* new MaintenanceError({
        message:
          'Refusing rollback: dev checkout has local changes. Preserve them explicitly before rolling back.',
      })
    yield* git(['checkout', '--detach', revision])
    yield* say(
      `rolled dev checkout back to ${ref.value}; external Pi, workflow, credentials and sessions were not changed\n`
    )
  },
  Effect.scoped,
  Effect.mapError(error =>
    error._tag === 'MaintenanceError' ? error : failed('Rollback failed', error)
  )
)

const onlyOnce = Effect.fnUntraced(function* (flag: string, values: readonly string[]) {
  if (values.length > 1)
    return yield* new MaintenanceError({ message: `--${flag} may be given only once` })
  return Arr.head(values)
})

const profile = Effect.fnUntraced(
  function* (options: {
    readonly dataHome: readonly string[]
    readonly exportTo: readonly string[]
    readonly periods: readonly string[]
  }) {
    const requestedDataHome = yield* onlyOnce('data-home', options.dataHome)
    const exportTo = yield* onlyOnce('export', options.exportTo)
    const dataHome = Option.isSome(requestedDataHome)
      ? resolve(requestedDataHome.value)
      : yield* defaultDataHome
    const parsed = yield* Effect.forEach(options.periods, parsePeriod)
    const periods = Arr.isReadonlyArrayNonEmpty(parsed) ? parsed : Arr.of(ALL_TIME)
    const [period, ...more] = periods
    if (Option.isSome(exportTo) && more.length > 0)
      return yield* new MaintenanceError({
        message: 'An export takes exactly one period; nothing was written',
      })
    const report = yield* profileUsage({
      dataHome,
      selection: Option.isSome(exportTo)
        ? { kind: 'export', period, directory: resolve(exportTo.value) }
        : { kind: 'report', periods },
    })
    yield* say(report)
  },
  Effect.mapError(error =>
    error._tag === 'MaintenanceError' ? error : failed('Profile failed', error)
  )
)

const dataHomeFlag = Flag.String('data-home').pipe(
  Flag.withMetavar('PATH'),
  Flag.withDescription('Private data home; defaults to DEV_DATA_HOME or the checkout .dev')
)

const noDataHome = Option.none<string>()

const commandOptions = {
  setup: '--data-home PATH',
  update: '--remote NAME or --branch NAME',
  rollback: '--ref REF',
  profile: '--data-home PATH, --period START..END (repeatable) or --export DIR',
} as const

const takesNoArguments = { upgrade: 'upgrade', 'pi-update': 'pi:update' } as const

const maintain = Command.make('maintain', {}, () => setup(noDataHome)).pipe(
  Command.withDescription('Maintain the dev installation; without a command, runs setup'),
  Command.withSubcommands([
    Command.make('setup', { dataHome: Flag.optional(dataHomeFlag) }, ({ dataHome }) =>
      setup(dataHome)
    ).pipe(Command.withDescription('Record the dependencies dev runs on')),
    Command.make(
      'update',
      {
        remote: Flag.String('remote').pipe(Flag.withMetavar('NAME'), Flag.withDefault('origin')),
        branch: Flag.String('branch').pipe(Flag.withMetavar('NAME'), Flag.optional),
      },
      update
    ).pipe(Command.withDescription('Fast-forward the dev checkout')),
    Command.make(
      'rollback',
      { ref: Flag.String('ref').pipe(Flag.withMetavar('REF'), Flag.optional) },
      ({ ref }) => rollback(ref)
    ).pipe(Command.withDescription('Detach the dev checkout at an explicit revision')),
    Command.make(
      'profile',
      {
        dataHome: dataHomeFlag.pipe(Flag.atLeast(0)),
        periods: Flag.String('period').pipe(
          Flag.withMetavar('START..END'),
          Flag.withDescription('UTC dates, START inclusive and END exclusive; repeatable'),
          Flag.atLeast(0)
        ),
        exportTo: Flag.String('export').pipe(
          Flag.withMetavar('DIR'),
          Flag.withDescription('Write publishable aggregates for one period'),
          Flag.atLeast(0)
        ),
      },
      profile
    ).pipe(Command.withDescription('Report recorded usage')),
    Command.make('upgrade', {}, () => Effect.mapError(runUpgrade, reported)).pipe(
      Command.withDescription('Upgrade Pi and dependencies in a verified pull request')
    ),
    Command.make('pi-update', {}, () => Effect.mapError(updatePi, reported)).pipe(
      Command.withDescription('Activate the verified Pi pinned in package.json')
    ),
  ])
)

const unknownCommand = (command: string): string =>
  `Unknown maintenance command "${command}". Use setup, update, rollback, profile, upgrade, or pi-update.`

const unknownOption = (command: string | undefined, option: string): string => {
  if (command === undefined || !(command in commandOptions)) return unknownCommand(option)
  return `Unknown ${command} option "${option}". Use ${commandOptions[command as keyof typeof commandOptions]}.`
}

const usageError = (
  path: readonly string[],
  args: readonly string[],
  error: CliError.NonShowHelpErrors
): string => {
  const [, command] = path
  if (command !== undefined && command in takesNoArguments)
    return `${takesNoArguments[command as keyof typeof takesNoArguments]} takes no arguments, got: ${args.slice(1).join(' ')}`
  switch (error._tag) {
    case 'UnknownSubcommand':
      return unknownCommand(error.subcommand)
    case 'UnrecognizedOption':
      return unknownOption((error.command ?? path)[1], error.option)
    case 'UnexpectedArgument':
      return unknownOption(command, error.arguments[0] ?? '')
    case 'InvalidValue':
      return error.kind === 'flag' && error.value === ''
        ? `--${error.option} requires a value`
        : error.message
    default:
      return error.message
  }
}

const runMaintain = Command.runWith(maintain, { version: '', renderErrors: false })

const fail = (message: string) =>
  Effect.sync(() => {
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  })

const program = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const args = yield* stdio.args
  yield* runMaintain(args).pipe(
    Effect.catchTag('ShowHelp', help =>
      Arr.match(help.errors, {
        onEmpty: () => Effect.void,
        onNonEmpty: ([first]) =>
          Effect.fail(new MaintenanceError({ message: usageError(help.commandPath, args, first) })),
      })
    )
  )
}).pipe(
  Effect.catch(error => fail(error.message)),
  Effect.catchDefect(defect => fail(Cause.pretty(Cause.die(defect)))),
  Effect.provide(
    Layer.mergeAll(
      NodeServices.layer,
      FetchHttpClient.layer,
      CliConfig.layer({ builtIns: [GlobalFlag.Help] })
    )
  )
)

NodeRuntime.runMain(program)
