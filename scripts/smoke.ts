import { execFile } from 'node:child_process'
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, FileSystem, Schema } from 'effect'

export class SmokeError extends Schema.TaggedError<SmokeError>()('SmokeError', {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const run = (
  command: string,
  args: readonly string[],
  cwd: string
): Effect.Effect<string, SmokeError> =>
  Effect.callback(resume => {
    const child = execFile(
      command,
      [...args],
      { cwd, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error)
          resume(
            Effect.fail(
              new SmokeError({
                message: `${error.message}\n${stderr.toString()}${stdout.toString()}`,
                cause: error,
              })
            )
          )
        else resume(Effect.succeed(stdout.toString()))
      }
    )
    return Effect.sync(() => {
      child.kill()
    })
  })

const checkout = process.cwd()

const program = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dataHome = yield* fs.makeTempDirectoryScoped({ prefix: 'dev-smoke-' })
    const output = yield* run(
      process.execPath,
      ['src/launcher.ts', '--diagnostics', '--data-home', dataHome],
      checkout
    )
    if (!output.includes('pi: 0.87.1') || !output.includes('selection: general'))
      return yield* new SmokeError({ message: `Unexpected diagnostics:\n${output}` })
    yield* Effect.sync(() => {
      console.log(output.trim())
    })
  })
).pipe(
  Effect.catch(error =>
    Effect.sync(() => {
      process.stderr.write(`${messageOf(error)}\n`)
      process.exitCode = 1
    })
  ),
  Effect.provide(NodeServices.layer)
)

NodeRuntime.runMain(program, { disableErrorReporting: true })
