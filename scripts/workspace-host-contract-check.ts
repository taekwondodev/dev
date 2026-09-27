// The TUI probe injects none of these failures.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeServices } from '@effect/platform-node'
import { Effect, Exit, Scope } from 'effect'
import { makeRuntimeFactory } from '../src/launcher.ts'
import { getProfile } from '../src/profiles.ts'
import { acquireRuntime } from '../src/runtime-coordination.ts'
import { createSessionGuard } from '../src/session-guard.ts'
import { WorkError } from '../src/work-domain.ts'
import {
  WorkspaceError,
  type WorkspaceAttachment,
  type WorkspaceLifecycle,
  type WorkspaceSelection,
} from '../src/workspace-domain.ts'
import { makeWorkspaceHost } from '../src/workspace-host.ts'
import { loadInstalledPi, makeClaims } from './workspace-check-support.ts'
import {
  fixtureId,
  makeFixtureBinding,
  makeFixtureView,
  type FixtureDescriptor,
} from './workspace-host-fixture-shapes.ts'

const { pi, packageInfo } = await loadInstalledPi()
const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'dev-workspace-host-contract-')))
const sessionDir = join(fixture, 'sessions')
const agentDir = join(fixture, 'agent')
const dataHome = join(fixture, 'data')
const descriptor = (origin: FixtureDescriptor['origin']): FixtureDescriptor => ({
  repoId: fixtureId(41),
  taskId: fixtureId(1),
  workspaceId: fixtureId(origin === 'managed' ? 12 : 11),
  path: join(fixture, 'projects', origin),
  origin,
  label: 'contract-check',
})
const current = descriptor('pre-existing')
const target = descriptor('managed')
for (const path of [sessionDir, agentDir, current.path, join(fixture, 'home', '.agents', 'skills')])
  mkdirSync(path, { recursive: true })
mkdirSync(dataHome, { mode: 0o700 })
process.env.HOME = join(fixture, 'home')
process.env.PI_CODING_AGENT_DIR = agentDir
process.env.PI_OFFLINE = '1'
process.env.PI_TELEMETRY_DISABLED = '1'

const { claim, passed } = makeClaims()
const manager = pi.SessionManager.create(current.path, sessionDir)
const sessionFile = manager.getSessionFile()
if (sessionFile === undefined) throw new Error('Pi did not name the session file')
const conversation = { sessionId: manager.getSessionId(), sessionFile, dataHome }
const selections: WorkspaceSelection[] = []
const refused = new WorkspaceError({ outcome: 'blocked', message: 'not used by this check' })
const attachment: WorkspaceAttachment = {
  binding: makeFixtureBinding({ conversation, descriptor: current }),
  authorize: () => Effect.fail(refused),
  select: selection => {
    selections.push(selection)
    return Effect.fail(refused)
  },
  reportExecution: () => Effect.void,
  handoff: () => Effect.void,
  close: Effect.void,
}
const retained = makeFixtureView({
  descriptor: target,
  outcome: 'preserved-for-resume',
  reservationId: fixtureId(112),
})
const lifecycle: WorkspaceLifecycle = {
  attach: () => Effect.fail(refused),
  inspect: () => Effect.succeed([retained]),
  validate: () => Effect.void,
}

const hostScope = Scope.makeUnsafe()
try {
  const host = await Effect.runPromise(
    Scope.provide(hostScope)(
      makeWorkspaceHost({
        lifecycle,
        attachment,
        dataHome,
        openSessionManager: (file, cwd) => pi.SessionManager.open(file, sessionDir, cwd),
        repositoryRoot: cwd => Effect.succeed(cwd),
      })
    )
  )
  const guard = createSessionGuard(
    await Effect.runPromise(Scope.provide(hostScope)(acquireRuntime(dataHome)))
  )
  const runtimeFactory = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* makeRuntimeFactory({
        api: pi,
        packageRoot: packageInfo.root,
        dataHome,
        profile: yield* getProfile('general'),
        guard,
        workspaceHost: host,
        lifecycle,
      })
    }).pipe(Effect.provide(NodeServices.layer))
  )
  const runtime = await pi.createAgentSessionRuntime(runtimeFactory, {
    cwd: current.path,
    agentDir,
    sessionManager: manager,
  })
  host.bindRuntime(runtime)
  guard.bind(runtime)
  const notices: { readonly message: string; readonly level: string | undefined }[] = []
  const handlerErrors: string[] = []
  await runtime.session.bindExtensions({
    uiContext: {
      ...runtime.session.extensionRunner.getUIContext(),
      notify: (message, level) => {
        notices.push({ message, level })
      },
      confirm: async () => true,
    },
    onError: error => {
      handlerErrors.push(error.error)
    },
  })
  const displayed = () =>
    runtime.session.sessionManager
      .getEntries()
      .flatMap(entry =>
        entry.type === 'custom_message' && entry.customType === 'dev/workspace'
          ? [entry.content]
          : []
      )
  const resume = `/workspace resume ${target.taskId} --workspace ${target.workspaceId}`

  await claim(
    'a /workspace resume whose session-owned work cannot be listed is reported as a notice',
    async () => {
      host.setWorkControls({
        running: Effect.fail(new WorkError({ message: 'fixture listing failed' })),
        stopAll: () => Effect.void,
      })
      await runtime.session.prompt(resume)
      assert.deepEqual(notices.splice(0), [
        {
          message:
            'Session-owned work could not be listed, so no switch was started: fixture listing failed',
          level: 'error',
        },
      ])
    }
  )
  await claim(
    'a confirmed /workspace resume whose session-owned work cannot be stopped is reported as a notice',
    async () => {
      host.setWorkControls({
        running: Effect.succeed([
          {
            taskId: 'fixture-work',
            attemptId: 'fixture-attempt',
            kind: 'process',
            status: 'running',
            cwd: current.path,
          },
        ]),
        stopAll: () => Effect.fail(new WorkError({ message: 'fixture stop failed' })),
      })
      await runtime.session.prompt(resume)
      assert.deepEqual(notices.splice(0), [
        {
          message:
            'Session-owned work could not be stopped, so no switch was started: fixture stop failed',
          level: 'error',
        },
      ])
    }
  )
  await claim('a malformed /workspace command is shown with its usage', async () => {
    await runtime.session.prompt('/workspace switch')
    assert.deepEqual(displayed(), [
      'Unknown workspace command "switch". Use list, inspect <task>, or resume <task> [--workspace <workspace>].',
    ])
  })
  await claim(
    "none of these commands selected a workspace, parked the host or rejected Pi's handler",
    () => {
      assert.deepEqual(selections, [])
      assert.equal(host.isParked(), false)
      assert.deepEqual(handlerErrors, [])
    }
  )
  await runtime.dispose()
} finally {
  await Effect.runPromise(Scope.close(hostScope, Exit.void))
  rmSync(fixture, { recursive: true, force: true })
}

console.log(
  JSON.stringify(
    {
      result: 'passed',
      checks: passed,
      limitation:
        'Command-failure notices through a headless Pi session with a stub lifecycle. The TUI probes drive the successful switches, and every stub value is decoded as it is made.',
    },
    null,
    2
  )
)
