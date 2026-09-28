import { NodeRuntime } from '@effect/platform-node'
import { Effect } from 'effect'
import { launch } from '../src/launcher.ts'
import type { WorkspaceLifecycle } from '../src/workspace-domain.ts'
import { makeWorkspaceLifecycle } from '../src/workspace-lifecycle.ts'
import { loadInstalledPi } from './workspace-check-support.ts'

const root = process.env.LAUNCHER_TUI_ROOT
if (root === undefined || root.length === 0)
  throw new Error('the launcher TUI probe requires a temporary authority root')

const deliverSigint = Effect.callback<void>(resume => {
  const delivered = (): void => resume(Effect.void)
  process.once('SIGINT', delivered)
  process.kill(process.pid, 'SIGINT')
  return Effect.sync(() => process.removeListener('SIGINT', delivered))
})

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

if (process.env.LAUNCHER_TUI_FAULT === 'shutdown-after-handover') {
  const {
    pi: { AgentSession },
  } = await loadInstalledPi()
  const { dispose } = AgentSession.prototype
  AgentSession.prototype.dispose = function (this: InstanceType<typeof AgentSession>) {
    dispose.call(this)
    throw new Error('injected session disposal failure')
  }
}

NodeRuntime.runMain(
  launch(process.argv.slice(2), {
    workspaceLifecycle:
      process.env.LAUNCHER_TUI_FAULT === 'sigint-after-handover'
        ? interruptedAfterHandover
        : makeWorkspaceLifecycle({ root }),
  }),
  { disableErrorReporting: true }
)
