import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Clock, Effect, Schema, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { runCommand } from '../src/command.ts'
import { errorText } from '../src/error-text.ts'

export class CommandError extends Schema.TaggedError<CommandError>()('CommandError', {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export const checkout = fileURLToPath(new URL('..', import.meta.url))

export const upgradeHome = join(checkout, '.dev', 'upgrade')

export const npmInstallFlags = [
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
  '--loglevel=error',
  '--progress=false',
] as const

const keptOutputLength = 64 * 1024

const commandSummary = (file: string, args: readonly string[]): string =>
  [file, ...args.slice(0, 2)].join(' ')

const cannotRun = (file: string, args: readonly string[]) => (cause: unknown) =>
  new CommandError({
    message: `Cannot run ${commandSummary(file, args)}: ${errorText(cause)}`,
    cause,
  })

export const run = (
  file: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly exitCodes?: readonly number[] } = {}
) =>
  runCommand(file, args, { cwd: options.cwd ?? checkout, exitCodes: options.exitCodes }).pipe(
    Effect.map(result => ({ ...result, stdout: result.stdout.trimEnd() })),
    Effect.mapError(failure =>
      failure.reason === 'exit'
        ? new CommandError({
            message: `${commandSummary(file, args)} exited with ${failure.exitCode}: ${(failure.stderr || failure.stdout).trim()}`,
          })
        : cannotRun(file, args)(failure.cause)
    )
  )

export const git = (args: readonly string[]) =>
  run('git', args).pipe(Effect.map(result => result.stdout))

export const streamed = Effect.fnUntraced(function* (
  file: string,
  args: readonly string[],
  env: Record<string, string> = {},
  cwd = checkout
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const started = yield* Clock.currentTimeMillis
  yield* Effect.sync(() => {
    process.stderr.write(`\n$ ${[file, ...args].join(' ')}\n`)
  })
  const [output, exitCode] = yield* spawner
    .spawn(ChildProcess.make(file, args, { cwd, env, extendEnv: true, stdin: 'ignore' }))
    .pipe(
      Effect.flatMap(handle =>
        Effect.all([
          handle.all.pipe(
            Stream.tap(chunk =>
              Effect.sync(() => {
                process.stderr.write(chunk)
              })
            ),
            Stream.decodeText(),
            Stream.runFold(
              () => '',
              (kept: string, chunk: string) => (kept + chunk).slice(-keptOutputLength)
            )
          ),
          handle.exitCode,
        ])
      ),
      Effect.scoped,
      Effect.mapError(cannotRun(file, args))
    )
  return { passed: exitCode === 0, ms: (yield* Clock.currentTimeMillis) - started, output }
})

export const checkoutIsClean = git(['status', '--porcelain']).pipe(
  Effect.map(status => status === '')
)
