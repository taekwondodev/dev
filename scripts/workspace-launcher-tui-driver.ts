// The launcher as the TUI probe runs it: the real `launch`, with its authority injected on the
// temporary root the probe names, so the fixed per-account authority is never opened. With
// LAUNCHER_TUI_FAULT=sigint-after-handover, the first attachment close after the release
// command's check, that is the guided handover's teardown before the attempt, first delivers a
// real SIGINT.
import { NodeRuntime } from '@effect/platform-node'
import { Effect } from 'effect'
import { launch } from '../src/launcher.ts'
import type { WorkspaceLifecycle } from '../src/workspace-domain.ts'
import { makeWorkspaceLifecycle } from '../src/workspace-lifecycle.ts'

const root = process.env.LAUNCHER_TUI_ROOT
if (root === undefined || root.length === 0)
  throw new Error('the launcher TUI probe requires a temporary authority root')

const deliverSigint = Effect.callback<void>(resume => {
  const delivered = (): void => resume(Effect.void)
  process.once('SIGINT', delivered)
  process.kill(process.pid, 'SIGINT')
  return Effect.sync(() => process.removeListener('SIGINT', delivered))
})

// The first attachment close after the release command's check delivers the SIGINT first.
const interruptedAfterHandover = Effect.gen(function* () {
  const real = yield* makeWorkspaceLifecycle({ root })
  let checked = false
  let signalled = false
  const signalOnce = Effect.suspend(() => {
    if (!checked || signalled) return Effect.void
    signalled = true
    return deliverSigint
  })
  const lifecycle: WorkspaceLifecycle = {
    ...real,
    check: input => {
      checked = true
      return real.check(input)
    },
    attach: input =>
      real.attach(input).pipe(
        Effect.map(
          attachment =>
            new Proxy(attachment, {
              get: (target, key) =>
                key === 'close'
                  ? signalOnce.pipe(Effect.andThen(target.close))
                  : Reflect.get(target, key),
            })
        )
      ),
  }
  return lifecycle
})

NodeRuntime.runMain(
  launch(process.argv.slice(2), {
    workspaceLifecycle:
      process.env.LAUNCHER_TUI_FAULT === 'sigint-after-handover'
        ? interruptedAfterHandover
        : makeWorkspaceLifecycle({ root }),
  }),
  { disableErrorReporting: true }
)
