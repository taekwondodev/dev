import { Effect } from 'effect'
import { streamed } from './checkout.ts'

export const suites = [
  'types:pi',
  'lint',
  'format:check',
  'smoke',
  'profile:check',
  'workspace:check',
  'workspace:tui',
  'workspace:github',
  'work:check',
  'web:check',
  'orb:check',
] as const

export interface StepResult {
  readonly step: 'install' | (typeof suites)[number]
  readonly command: string
  readonly passed: boolean
  readonly ms: number
  readonly output: string
}

export const runUpgradeChecks = Effect.fnUntraced(function* (
  cwd: string,
  env: Record<string, string>
) {
  const run = (suite: (typeof suites)[number]) =>
    streamed('npm', ['run', suite], env, cwd, suite).pipe(
      Effect.map((result): StepResult => ({ step: suite, command: `npm run ${suite}`, ...result }))
    )
  const [preparation, ...checks] = suites
  const prepared = yield* run(preparation)
  if (!prepared.passed) return [prepared]
  const ran = yield* Effect.forEach(checks, run, { concurrency: 3 })
  return [prepared, ...ran]
})
