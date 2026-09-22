import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, FileSystem, Schema } from 'effect'
import { defaultDataHome, sessionDir } from '../src/preferences.ts'
import { acquireMaintenance } from '../src/runtime-coordination.ts'
import { linkPiDeclarations, resolvePiPackage } from '../src/pi-runtime.ts'

export class MaintenanceError extends Schema.TaggedError<MaintenanceError>()('MaintenanceError', {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const checkout = fileURLToPath(new URL('..', import.meta.url))

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const toMaintenanceError = (error: unknown, operation: string): MaintenanceError =>
  error instanceof MaintenanceError
    ? error
    : new MaintenanceError({ message: `${operation}: ${messageOf(error)}`, cause: error })

const run = (
  command: string,
  args: readonly string[],
  cwd: string = checkout
): Effect.Effect<string, MaintenanceError> =>
  Effect.callback(resume => {
    const child = execFile(command, [...args], { cwd, encoding: 'utf8' }, (error, stdout) => {
      if (error)
        resume(
          Effect.fail(
            new MaintenanceError({
              message: `Command ${command} failed: ${error.message}`,
              cause: error,
            })
          )
        )
      else resume(Effect.succeed(stdout.toString().trim()))
    })
    return Effect.sync(() => {
      child.kill()
    })
  })

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const assertPrivateDataProtected = (
  ref: string
): Effect.Effect<void, MaintenanceError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    if (!(yield* fs.exists(join(checkout, '.dev')))) return
    const ignore = (yield* run('git', ['show', `${ref}:.gitignore`])).split(/\r?\n/)
    const tracked = yield* run('git', ['ls-tree', '-r', '--name-only', ref, '--', '.dev'])
    if (!ignore.includes('/.dev/') || ignore.some(line => line.startsWith('!')) || tracked)
      return yield* new MaintenanceError({
        message:
          'Refusing checkout: private .dev data requires an explicit /.dev/ ignore rule, no negation rules, and no tracked contents. Relocate that data explicitly before using this revision.',
      })
  }).pipe(
    Effect.mapError(error => toMaintenanceError(error, 'Cannot verify private data protection'))
  )

const setup = (): Effect.Effect<void, MaintenanceError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dataHome = argument('--data-home') ?? (yield* defaultDataHome)
    yield* acquireMaintenance
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
        revision: yield* run('git', ['-C', shared, 'rev-parse', 'HEAD']),
        dirty: (yield* run('git', ['-C', shared, 'status', '--porcelain'])) !== '',
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

const update = (): Effect.Effect<void, MaintenanceError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    yield* acquireMaintenance
    if ((yield* run('git', ['status', '--porcelain'])) !== '')
      return yield* new MaintenanceError({
        message:
          'Refusing update: dev checkout has local changes. Preserve them explicitly before updating.',
      })
    const remote = argument('--remote') ?? 'origin'
    const branch = argument('--branch') ?? (yield* run('git', ['branch', '--show-current']))
    yield* run('git', ['fetch', remote, branch])
    yield* assertPrivateDataProtected(`${remote}/${branch}`)
    yield* run('git', ['merge', '--ff-only', `${remote}/${branch}`])
    yield* Effect.sync(() => {
      process.stdout.write(`updated dev checkout from ${remote}/${branch}\n`)
    })
  }).pipe(
    Effect.scoped,
    Effect.mapError(error => toMaintenanceError(error, 'Update failed'))
  )

const rollback = (): Effect.Effect<void, MaintenanceError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    yield* acquireMaintenance
    const ref = argument('--ref')
    if (ref === undefined)
      return yield* new MaintenanceError({
        message: 'Rollback requires an explicit --ref and changes only the dev checkout.',
      })
    const revision = yield* run('git', [
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${ref}^{commit}`,
    ])
    yield* assertPrivateDataProtected(revision)
    if ((yield* run('git', ['status', '--porcelain'])) !== '')
      return yield* new MaintenanceError({
        message:
          'Refusing rollback: dev checkout has local changes. Preserve them explicitly before rolling back.',
      })
    yield* run('git', ['checkout', '--detach', revision])
    yield* Effect.sync(() => {
      process.stdout.write(
        `rolled dev checkout back to ${ref}; external Pi, workflow, credentials and sessions were not changed\n`
      )
    })
  }).pipe(
    Effect.scoped,
    Effect.mapError(error => toMaintenanceError(error, 'Rollback failed'))
  )

const program = Effect.gen(function* () {
  const command = process.argv[2] ?? 'setup'
  if (command === 'setup') return yield* setup()
  if (command === 'update') return yield* update()
  if (command === 'rollback') return yield* rollback()
  return yield* new MaintenanceError({
    message: `Unknown maintenance command "${command}". Use setup, update, or rollback.`,
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
