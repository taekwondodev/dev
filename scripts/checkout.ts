import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Clock, Effect, Schema, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'
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

const text = <E>(stream: Stream.Stream<Uint8Array, E>) => Stream.mkString(Stream.decodeText(stream))

export const run = Effect.fnUntraced(function* (
  file: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly exitCodes?: readonly number[] } = {}
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const [stdout, stderr, exitCode] = yield* spawner
    .spawn(
      ChildProcess.make(file, args, {
        cwd: options.cwd ?? checkout,
        stdin: 'ignore',
        detached: false,
      })
    )
    .pipe(
      Effect.flatMap(handle =>
        Effect.all([text(handle.stdout), text(handle.stderr), handle.exitCode], {
          concurrency: 'unbounded',
        })
      ),
      Effect.scoped,
      Effect.mapError(cannotRun(file, args))
    )
  if (!(options.exitCodes ?? [0]).includes(exitCode))
    return yield* new CommandError({
      message: `${commandSummary(file, args)} exited with ${exitCode}: ${(stderr || stdout).trim()}`,
    })
  return { stdout: stdout.trimEnd(), stderr, exitCode }
})

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
