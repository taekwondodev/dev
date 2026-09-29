import { NodeRuntime } from '@effect/platform-node'
import { Effect } from 'effect'
import { launch } from '../../src/launcher.ts'
import type { WorkspaceLifecycle } from '../../src/workspace-domain.ts'
import { makeWorkspaceLifecycle } from '../../src/workspace-lifecycle.ts'

const root = process.env.RELEASE_INTERRUPT_ROOT
if (root === undefined || root.length === 0)
  throw new Error('the release interrupt driver requires a temporary authority root')

const deliverSigint = Effect.callback<void>(resume => {
  const delivered = (): void => resume(Effect.void)
  process.once('SIGINT', delivered)
  process.kill(process.pid, 'SIGINT')
  return Effect.sync(() => process.removeListener('SIGINT', delivered))
})

const interrupting = Effect.gen(function* () {
  const real = yield* makeWorkspaceLifecycle({ root })
  let signalled = false
  const lifecycle: WorkspaceLifecycle = {
    ...real,
    release: input => {
      if (signalled) return real.release(input)
      signalled = true
      return deliverSigint.pipe(Effect.andThen(real.release(input)))
    },
  }
  return lifecycle
})

NodeRuntime.runMain(launch(process.argv.slice(2), { workspaceLifecycle: interrupting }), {
  disableErrorReporting: true,
})
