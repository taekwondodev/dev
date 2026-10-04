import { join, resolve } from 'node:path'
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Array as Arr, Effect, FileSystem, Schema } from 'effect'
import type { ChildProcessSpawner } from 'effect/unstable/process'
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

type MaintenanceCommand = Effect.Effect<
  void,
  MaintenanceError,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
>

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const toMaintenanceError = (error: unknown, operation: string): MaintenanceError =>
  error instanceof MaintenanceError
    ? error
    : new MaintenanceError({ message: `${operation}: ${messageOf(error)}`, cause: error })

const argument = (name: string): Effect.Effect<string | undefined, MaintenanceError> => {
  const index = process.argv.indexOf(name)
  const value = index === -1 ? undefined : process.argv[index + 1]
  return index !== -1 && value === undefined
    ? Effect.fail(new MaintenanceError({ message: `${name} requires a value` }))
    : Effect.succeed(value)
}

const assertPrivateDataProtected = (ref: string): MaintenanceCommand =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    if (!(yield* fs.exists(join(checkout, '.dev')))) return
    const ignore = (yield* git(['show', `${ref}:.gitignore`])).split(/\r?\n/)
    const tracked = yield* git(['ls-tree', '-r', '--name-only', ref, '--', '.dev'])
    if (!ignore.includes('/.dev/') || ignore.some(line => line.startsWith('!')) || tracked)
      return yield* new MaintenanceError({
        message:
          'Refusing checkout: private .dev data requires an explicit /.dev/ ignore rule, no negation rules, and no tracked contents. Relocate that data explicitly before using this revision.',
      })
  }).pipe(
    Effect.mapError(error => toMaintenanceError(error, 'Cannot verify private data protection'))
  )

const setup = (): MaintenanceCommand =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dataHome = (yield* argument('--data-home')) ?? (yield* defaultDataHome)
    yield* acquireMaintenance()
    const pi = yield* resolvePiPackage
    yield* linkPiDeclarations
    const home = process.env.HOME ?? process.env.USERPROFILE
    if (home === undefined)
      return yield* new MaintenanceError({
        message: 'HOME is required to inspect shared workflow skills',
      })
    const shared = process.env.DEV_SHARED_SKILLS ?? `${home}/Developer/skills`
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
    yield* Effect.sync(() => {
      process.stdout.write(`setup recorded dependencies in ${dataHome}\n`)
    })
  }).pipe(
    Effect.scoped,
    Effect.mapError(error => toMaintenanceError(error, 'Setup failed'))
  )

const update = (): MaintenanceCommand =>
  Effect.gen(function* () {
    const remote = (yield* argument('--remote')) ?? 'origin'
    const requestedBranch = yield* argument('--branch')
    yield* acquireMaintenance()
    if (!(yield* checkoutIsClean))
      return yield* new MaintenanceError({
        message:
          'Refusing update: dev checkout has local changes. Preserve them explicitly before updating.',
      })
    const branch = requestedBranch ?? (yield* git(['branch', '--show-current']))
    yield* git(['fetch', remote, branch])
    yield* assertPrivateDataProtected(`${remote}/${branch}`)
    const previous = yield* git(['rev-parse', 'HEAD'])
    yield* git(['merge', '--ff-only', `${remote}/${branch}`])
    yield* Effect.sync(() => {
      process.stdout.write(`updated dev checkout from ${remote}/${branch}\n`)
    })
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
    yield* Effect.sync(() => {
      process.stdout.write('reinstalled dependencies from the updated package-lock.json\n')
    })
  }).pipe(
    Effect.scoped,
    Effect.mapError(error => toMaintenanceError(error, 'Update failed'))
  )

const rollback = (): MaintenanceCommand =>
  Effect.gen(function* () {
    const ref = yield* argument('--ref')
    yield* acquireMaintenance()
    if (ref === undefined)
      return yield* new MaintenanceError({
        message: 'Rollback requires an explicit --ref and changes only the dev checkout.',
      })
    const revision = yield* git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])
    yield* assertPrivateDataProtected(revision)
    if (!(yield* checkoutIsClean))
      return yield* new MaintenanceError({
        message:
          'Refusing rollback: dev checkout has local changes. Preserve them explicitly before rolling back.',
      })
    yield* git(['checkout', '--detach', revision])
    yield* Effect.sync(() => {
      process.stdout.write(
        `rolled dev checkout back to ${ref}; external Pi, workflow, credentials and sessions were not changed\n`
      )
    })
  }).pipe(
    Effect.scoped,
    Effect.mapError(error => toMaintenanceError(error, 'Rollback failed'))
  )

const profileOptions = Effect.gen(function* () {
  const args = process.argv.slice(3)
  const single = new Map<string, string>()
  const periods: string[] = []
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index] ?? ''
    const value = args[index + 1]
    if (value === undefined)
      return yield* new MaintenanceError({ message: `${flag} requires a value` })
    if (flag === '--period') periods.push(value)
    else if (flag !== '--data-home' && flag !== '--export')
      return yield* new MaintenanceError({
        message: `Unknown profile option "${flag}". Use --data-home PATH, --period START..END (repeatable) or --export DIR.`,
      })
    else if (single.has(flag))
      return yield* new MaintenanceError({ message: `${flag} may be given only once` })
    else single.set(flag, value)
  }
  return { dataHome: single.get('--data-home'), exportTo: single.get('--export'), periods }
})

const profile = (): Effect.Effect<void, MaintenanceError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const options = yield* profileOptions
    const dataHome =
      options.dataHome === undefined ? yield* defaultDataHome : resolve(options.dataHome)
    const parsed = yield* Effect.forEach(options.periods, parsePeriod)
    const periods = Arr.isReadonlyArrayNonEmpty(parsed) ? parsed : Arr.of(ALL_TIME)
    const [period, ...more] = periods
    if (options.exportTo !== undefined && more.length > 0)
      return yield* new MaintenanceError({
        message: 'An export takes exactly one period; nothing was written',
      })
    const report = yield* profileUsage({
      dataHome,
      selection:
        options.exportTo === undefined
          ? { kind: 'report', periods }
          : { kind: 'export', period, directory: resolve(options.exportTo) },
    })
    yield* Effect.sync(() => {
      process.stdout.write(report)
    })
  }).pipe(Effect.mapError(error => toMaintenanceError(error, 'Profile failed')))

const withoutArguments = (
  name: string,
  operation: Effect.Effect<
    void,
    { readonly message: string },
    FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
  >
): MaintenanceCommand =>
  Effect.gen(function* () {
    if (process.argv.length > 3)
      return yield* new MaintenanceError({
        message: `${name} takes no arguments, got: ${process.argv.slice(3).join(' ')}`,
      })
    yield* operation.pipe(
      Effect.mapError(error => new MaintenanceError({ message: error.message, cause: error }))
    )
  })

const program = Effect.gen(function* () {
  const command = process.argv[2] ?? 'setup'
  if (command === 'setup') return yield* setup()
  if (command === 'update') return yield* update()
  if (command === 'rollback') return yield* rollback()
  if (command === 'profile') return yield* profile()
  if (command === 'upgrade') return yield* withoutArguments('upgrade', runUpgrade())
  if (command === 'pi-update') return yield* withoutArguments('pi:update', updatePi())
  return yield* new MaintenanceError({
    message: `Unknown maintenance command "${command}". Use setup, update, rollback, profile, upgrade, or pi-update.`,
  })
}).pipe(
  Effect.catch(error =>
    Effect.sync(() => {
      process.stderr.write(`${error.message}\n`)
      process.exitCode = 1
    })
  ),
  Effect.provide(NodeServices.layer)
)

NodeRuntime.runMain(program, { disableErrorReporting: true })
