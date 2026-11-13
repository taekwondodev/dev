import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Schema from 'effect/Schema'
import { readPiPin } from '../scripts/pi-pin.ts'
import { errorText } from '../src/error-text.ts'
import { writeProfileFixture } from './profile-fixture.ts'

class SmokeError extends Schema.TaggedError<SmokeError, { readonly brand: unique symbol }>()(
  'SmokeError',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }
) {}

const run = (
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): Effect.Effect<string, SmokeError> =>
  Effect.callback(resume => {
    const child = execFile(
      command,
      [...args],
      { cwd, encoding: 'utf8', env },
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
    const profiles = writeProfileFixture(join(dataHome, 'profiles'))
    const output = yield* run(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
        import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
        import { launch } from ${JSON.stringify(pathToFileURL(join(checkout, 'src/launcher-runtime.ts')).href)}
        import { makeWorkspaceLifecycle } from ${JSON.stringify(pathToFileURL(join(checkout, 'src/workspace-lifecycle.ts')).href)}
        const root = ${JSON.stringify(join(dataHome, 'authority'))}
        NodeRuntime.runMain(launch(['--diagnostics', '--data-home', ${JSON.stringify(dataHome)}], {
          workspaceLifecycle: makeWorkspaceLifecycle({ root }),
          coordination: { installationPath: ${JSON.stringify(dataHome)}, namespacePath: root },
        }), { disableErrorReporting: true })
      `,
      ],
      checkout,
      { ...process.env, DEV_PROFILES: profiles.root }
    )
    const pin = yield* readPiPin
    if (
      !output.includes(`pi: ${pin} (`) ||
      !output.includes(`selection: ${profiles.defaultProfile} (configured default)`) ||
      !output.includes(`SOUL.md: ${profiles.soulPath(profiles.defaultProfile)}`)
    )
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
