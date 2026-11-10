import { Effect, FileSystem, Option, Schema } from 'effect'
import { errorText } from '../src/error-text.ts'
import { CommandError, streamed } from './checkout.ts'

export const CheckOutcome = Schema.Struct({
  suite: Schema.String,
  command: Schema.String,
  passed: Schema.Boolean,
  ms: Schema.Finite,
  output: Schema.String,
})
export type CheckOutcome = typeof CheckOutcome.Type

const CheckReport = Schema.fromJsonString(Schema.Array(CheckOutcome))

export interface CheckRun {
  readonly ms: number
  readonly output: string
  readonly outcomes: Option.Option<readonly CheckOutcome[]>
}

export const checkRunner = 'node tests/run-checks.ts --all'

export const runUpgradeChecks = Effect.fnUntraced(function* (
  cwd: string,
  env: Record<string, string>,
  reportPath: string
) {
  const fs = yield* FileSystem.FileSystem
  const unreadable = (cause: unknown) =>
    new CommandError({
      message: `Cannot read the check report ${reportPath}: ${errorText(cause)}`,
      cause,
    })
  yield* fs.remove(reportPath, { force: true }).pipe(Effect.mapError(unreadable))
  const { ms, output } = yield* streamed(
    process.execPath,
    ['tests/run-checks.ts', '--all', `--report=${reportPath}`],
    env,
    cwd
  )
  const outcomes = (yield* fs.exists(reportPath).pipe(Effect.mapError(unreadable)))
    ? Option.some(
        yield* fs
          .readFileString(reportPath)
          .pipe(Effect.flatMap(Schema.decodeEffect(CheckReport)), Effect.mapError(unreadable))
      )
    : Option.none()
  return { ms, output, outcomes } satisfies CheckRun
})
