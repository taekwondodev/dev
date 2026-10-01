import { join, resolve } from 'node:path'
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, FileSystem, Schema } from 'effect'
import type { ChildProcessSpawner } from 'effect/unstable/process'
import { defaultDataHome, sessionDir } from '../src/preferences.ts'
import { acquireMaintenance } from '../src/runtime-coordination.ts'
import { linkPiDeclarations, resolvePiPackage } from '../src/pi-runtime.ts'
import { checkout, checkoutIsClean, git } from './checkout.ts'
import { installPi, type PiUpgradeError, verifyPi } from './pi-upgrade.ts'
import { profileUsage } from './usage-profile.ts'

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
    yield* git(['merge', '--ff-only', `${remote}/${branch}`])
    yield* Effect.sync(() => {
      process.stdout.write(`updated dev checkout from ${remote}/${branch}\n`)
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

const profile = (): Effect.Effect<void, MaintenanceError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const explicit = yield* argument('--data-home')
    const dataHome = explicit === undefined ? yield* defaultDataHome : resolve(explicit)
    const report = yield* profileUsage(dataHome, join(checkout, 'docs', 'performance'))
    yield* Effect.sync(() => {
      process.stdout.write(report)
    })
  }).pipe(Effect.mapError(error => toMaintenanceError(error, 'Profile failed')))

const fromPiUpgrade = (error: PiUpgradeError): MaintenanceError =>
  new MaintenanceError({ message: error.message, cause: error })

const versionArgument = Effect.gen(function* () {
  const [flag, version, ...rest] = process.argv.slice(3)
  if (flag === undefined) return undefined
  if (flag === '--version' && version !== undefined && rest.length === 0) return version
  return yield* new MaintenanceError({
    message: `Expected only --version X.Y.Z, got: ${process.argv.slice(3).join(' ')}`,
  })
})

const piVerify = (): MaintenanceCommand =>
  Effect.gen(function* () {
    const version = yield* versionArgument
    yield* verifyPi(version).pipe(Effect.mapError(fromPiUpgrade))
  })

const piInstall = (): MaintenanceCommand =>
  Effect.gen(function* () {
    const version = yield* versionArgument
    if (version === undefined)
      return yield* new MaintenanceError({
        message: 'Pi install requires an explicit --version and changes only global Pi.',
      })
    yield* installPi(version).pipe(Effect.mapError(fromPiUpgrade))
  })

const program = Effect.gen(function* () {
  const command = process.argv[2] ?? 'setup'
  if (command === 'setup') return yield* setup()
  if (command === 'update') return yield* update()
  if (command === 'rollback') return yield* rollback()
  if (command === 'profile') return yield* profile()
  if (command === 'pi-verify') return yield* piVerify()
  if (command === 'pi-install') return yield* piInstall()
  return yield* new MaintenanceError({
    message: `Unknown maintenance command "${command}". Use setup, update, rollback, profile, pi-verify, or pi-install.`,
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
