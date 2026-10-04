import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, FileSystem, Schema } from 'effect'
import { readPiPin } from '../scripts/pi-pin.ts'
import { errorText } from '../src/error-text.ts'

export class SmokeError extends Schema.TaggedError<SmokeError>()('SmokeError', {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

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
      [
        '--input-type=module',
        '--eval',
        `
        import { NodeRuntime } from '@effect/platform-node'
        import { launch } from ${JSON.stringify(pathToFileURL(join(checkout, 'src/launcher.ts')).href)}
        import { makeWorkspaceLifecycle } from ${JSON.stringify(pathToFileURL(join(checkout, 'src/workspace-lifecycle.ts')).href)}
        const root = ${JSON.stringify(join(dataHome, 'authority'))}
        NodeRuntime.runMain(launch(['--diagnostics', '--data-home', ${JSON.stringify(dataHome)}], {
          workspaceLifecycle: makeWorkspaceLifecycle({ root }),
          coordination: { installationPath: ${JSON.stringify(dataHome)}, namespacePath: root },
        }), { disableErrorReporting: true })
      `,
      ],
      checkout
    )
    const pin = yield* readPiPin
    if (!output.includes(`pi: ${pin} (`) || !output.includes('selection: general'))
      return yield* new SmokeError({ message: `Unexpected diagnostics:\n${output}` })
    yield* Effect.sync(() => {
      console.log(output.trim())
    })
  })
).pipe(
  Effect.catch(error =>
    Effect.sync(() => {
      process.stderr.write(`${errorText(error)}\n`)
      process.exitCode = 1
    })
  ),
  Effect.provide(NodeServices.layer)
)

NodeRuntime.runMain(program, { disableErrorReporting: true })
