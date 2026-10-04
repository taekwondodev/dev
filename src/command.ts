import { Duration, Effect, Result, Schema, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'

export class CommandFailure extends Schema.TaggedError<CommandFailure>()('CommandFailure', {
  reason: Schema.Literals(['spawn', 'exit', 'signal', 'timeout', 'output']),
  message: Schema.String,
  stdout: Schema.String,
  stderr: Schema.String,
  exitCode: Schema.optional(Schema.Int),
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface CommandOptions {
  readonly cwd?: string
  readonly env?: Record<string, string | undefined>
  readonly timeout?: Duration.Input
  readonly maxOutputLength?: number
  readonly exitCodes?: readonly number[]
}

export interface CommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

const causeText = (cause: { readonly message: string; readonly cause?: unknown }): string =>
  cause.cause instanceof Error ? cause.cause.message : cause.message

export type RunCommand = (
  file: string,
  args: readonly string[],
  options?: CommandOptions
) => Effect.Effect<CommandResult, CommandFailure>

const runWith = Effect.fnUntraced(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner['Service'],
  file: string,
  args: readonly string[],
  options: CommandOptions = {}
): Effect.fn.Return<CommandResult, CommandFailure> {
  const output = { stdout: '', stderr: '' }
  const failed = (
    reason: CommandFailure['reason'],
    message: string,
    extra: { readonly exitCode?: number; readonly cause?: unknown } = {}
  ) => new CommandFailure({ reason, message, ...output, ...extra })
  const commandFailed = () => `Command failed: ${[file, ...args].join(' ')}\n${output.stderr}`
  const collect = <E>(name: 'stdout' | 'stderr', stream: Stream.Stream<Uint8Array, E>) =>
    Stream.runForEach(Stream.decodeText(stream), chunk => {
      output[name] += chunk
      return options.maxOutputLength !== undefined && output[name].length > options.maxOutputLength
        ? Effect.fail(failed('output', `${name} maxBuffer length exceeded`))
        : Effect.void
    })
  const running = spawner
    .spawn(
      ChildProcess.make(file, args, {
        cwd: options.cwd,
        env: options.env,
        stdin: 'ignore',
        detached: false,
        forceKillAfter: Duration.seconds(2),
      })
    )
    .pipe(
      Effect.flatMap(handle =>
        Effect.all(
          [
            collect('stdout', handle.stdout),
            collect('stderr', handle.stderr),
            Effect.result(handle.exitCode),
          ],
          { concurrency: 'unbounded' }
        )
      ),
      Effect.scoped,
      Effect.catchTag('PlatformError', cause =>
        Effect.fail(failed('spawn', causeText(cause), { cause }))
      )
    )
  const [, , exit] = yield* options.timeout === undefined
    ? running
    : Effect.timeoutOrElse(running, {
        duration: options.timeout,
        orElse: () => Effect.fail(failed('timeout', commandFailed())),
      })
  if (Result.isFailure(exit))
    return yield* failed('signal', commandFailed(), { cause: exit.failure })
  const exitCode: number = exit.success
  if (!(options.exitCodes ?? [0]).includes(exitCode))
    return yield* failed('exit', commandFailed(), { exitCode })
  return { ...output, exitCode }
})

export const commandRunner: Effect.Effect<
  RunCommand,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  return (file, args, options) => runWith(spawner, file, args, options)
})

export const runCommand = (
  file: string,
  args: readonly string[],
  options?: CommandOptions
): Effect.Effect<CommandResult, CommandFailure, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.flatMap(commandRunner, run => run(file, args, options))
