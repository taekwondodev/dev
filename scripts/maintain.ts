import { join, resolve } from 'node:path'
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Array as Arr, Cause, Config, Effect, FileSystem, Layer, Option, Schema } from 'effect'
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

const commandOptions = {
  setup: { flags: ['--data-home'], usage: '--data-home PATH' },
  update: { flags: ['--remote', '--branch'], usage: '--remote NAME or --branch NAME' },
  rollback: { flags: ['--ref'], usage: '--ref REF' },
  profile: {
    flags: ['--data-home', '--period', '--export'],
    usage: '--data-home PATH, --period START..END (repeatable) or --export DIR',
  },
} as const

type OptionCommand = keyof typeof commandOptions

const parseOptions = Effect.fnUntraced(function* (command: OptionCommand, args: readonly string[]) {
  const { flags, usage } = commandOptions[command]
  const values = new Map<string, string[]>()
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index] ?? ''
    if (!flags.some(known => known === flag))
      return yield* new MaintenanceError({
        message: `Unknown ${command} option "${flag}". Use ${usage}.`,
      })
    const value = args[index + 1]
    if (value === undefined)
      return yield* new MaintenanceError({ message: `${flag} requires a value` })
    values.set(flag, [...(values.get(flag) ?? []), value])
  }
  return (flag: string): readonly string[] => values.get(flag) ?? []
})

const single = Effect.fnUntraced(function* (flag: string, values: readonly string[]) {
  if (values.length > 1)
    return yield* new MaintenanceError({ message: `${flag} may be given only once` })
  return Arr.head(values)
})

const profile = Effect.fnUntraced(
  function* (args: readonly string[]) {
    const options = yield* parseOptions('profile', args)
    const requestedDataHome = yield* single('--data-home', options('--data-home'))
    const exportTo = yield* single('--export', options('--export'))
    const dataHome = Option.isSome(requestedDataHome)
      ? resolve(requestedDataHome.value)
      : yield* defaultDataHome
    const parsed = yield* Effect.forEach(options('--period'), parsePeriod)
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

const withoutArguments = Effect.fnUntraced(function* (name: string, args: readonly string[]) {
  if (args.length > 0)
    return yield* new MaintenanceError({
      message: `${name} takes no arguments, got: ${args.join(' ')}`,
    })
})

const dispatch = Effect.fnUntraced(function* (command: string, args: readonly string[]) {
  switch (command) {
    case 'setup': {
      const options = yield* parseOptions('setup', args)
      return yield* setup(yield* single('--data-home', options('--data-home')))
    }
    case 'update': {
      const options = yield* parseOptions('update', args)
      const remote = yield* single('--remote', options('--remote'))
      return yield* update({
        remote: Option.getOrElse(remote, () => 'origin'),
        branch: yield* single('--branch', options('--branch')),
      })
    }
    case 'rollback': {
      const options = yield* parseOptions('rollback', args)
      return yield* rollback(yield* single('--ref', options('--ref')))
    }
    case 'profile':
      return yield* profile(args)
    case 'upgrade':
      yield* withoutArguments('upgrade', args)
      return yield* Effect.mapError(runUpgrade, reported)
    case 'pi-update':
      yield* withoutArguments('pi:update', args)
      return yield* Effect.mapError(updatePi, reported)
    default:
      return yield* new MaintenanceError({
        message: `Unknown maintenance command "${command}". Use setup, update, rollback, profile, upgrade, or pi-update.`,
      })
  }
})

const fail = (message: string) =>
  Effect.sync(() => {
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  })

const [command = 'setup', ...commandArguments] = process.argv.slice(2)

const program = dispatch(command, commandArguments).pipe(
  Effect.catch(error => fail(error.message)),
  Effect.catchDefect(defect => fail(Cause.pretty(Cause.die(defect)))),
  Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))
)

NodeRuntime.runMain(program)
