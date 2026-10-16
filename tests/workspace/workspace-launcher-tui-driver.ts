import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import { Effect } from 'effect'
import { launch } from '../../src/launcher-runtime.ts'
import type { WorkspaceLifecycle } from '../../src/workspace-domain.ts'
import { makeWorkspaceLifecycle } from '../../src/workspace-lifecycle.ts'
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

const interruptedAfterQuit = Effect.gen(function* () {
  const real = yield* makeWorkspaceLifecycle({ root })
  let signalled = false
  const signalOnce = Effect.suspend(() => {
    if (signalled) return Effect.void
    signalled = true
    return deliverSigint
  })
  const lifecycle: WorkspaceLifecycle = {
    ...real,
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

const interruptedDuringSweep = Effect.gen(function* () {
  const real = yield* makeWorkspaceLifecycle({ root })
  const lifecycle: WorkspaceLifecycle = {
    ...real,
    sweep: input => deliverSigint.pipe(Effect.andThen(real.sweep(input))),
  }
  return lifecycle
})

const lifecycleFor = (fault: string | undefined) => {
  switch (fault) {
    case 'sigint-after-quit':
      return interruptedAfterQuit
    case 'sigint-during-sweep':
      return interruptedDuringSweep
    default:
      return makeWorkspaceLifecycle({ root })
  }
}

const cleanupMarkers = process.env.LAUNCHER_TUI_CLEANUP_MARKERS
if (cleanupMarkers !== undefined) {
  const { spawn } = childProcess
  childProcess.spawn = new Proxy(spawn, {
    apply(target, _receiver, args: Parameters<typeof spawn>) {
      const child = target(...args)
      if (args[1]?.[0]?.endsWith('/cleanup-runtime.ts')) {
        const request = JSON.parse(args[1][1] ?? '') as { trigger: string }
        assert.ok(child.pid)
        writeFileSync(join(cleanupMarkers, `${request.trigger}.json`), JSON.stringify(child.pid))
        if (process.env.LAUNCHER_TUI_CLEANUP === '1') assert.ok(child.kill('SIGSTOP'))
      }
      return child
    },
  })
  syncBuiltinESMExports()
  if (process.env.LAUNCHER_TUI_CLEANUP === '1') {
    const {
      pi: { InteractiveMode },
    } = await loadInstalledPi()
    const { run } = InteractiveMode.prototype
    InteractiveMode.prototype.run = async function (this: InstanceType<typeof InteractiveMode>) {
      writeFileSync(join(cleanupMarkers, 'interactive-ready'), '')
      await run.call(this)
    }
  }
}

if (process.env.LAUNCHER_TUI_FAULT === 'interactive-failure') {
  const {
    pi: { InteractiveMode },
  } = await loadInstalledPi()
  const { run } = InteractiveMode.prototype
  InteractiveMode.prototype.run = async function (this: InstanceType<typeof InteractiveMode>) {
    run.call(this).catch(() => undefined)
    await sleep(1500)
    this.stop()
    throw new Error('injected interactive mode failure')
  }
}

if (process.env.LAUNCHER_TUI_FAULT === 'shutdown-after-quit') {
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
    coordination: {
      installationPath: process.env.LAUNCHER_TUI_INSTALLATION ?? dirname(root),
      namespacePath: root,
    },
    workspaceLifecycle: lifecycleFor(process.env.LAUNCHER_TUI_FAULT),
  }),
  { disableErrorReporting: true }
)
