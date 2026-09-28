// The TUI probe injects none of these failures.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { WorkError } from '../src/work-domain.ts'
import {
  WorkspaceError,
  type WorkspaceAttachment,
  type WorkspaceLifecycle,
  type WorkspaceSelection,
} from '../src/workspace-domain.ts'
import { loadInstalledPi, makeClaims, openHostRuntime } from './workspace-check-support.ts'
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
  check: () => Effect.fail(refused),
  release: () => Effect.fail(refused),
  recordTarget: () => Effect.fail(refused),
  recordPublication: () => Effect.fail(refused),
  recordRuleApproval: () => Effect.fail(refused),
}

let opened: Awaited<ReturnType<typeof openHostRuntime>> | undefined
try {
  opened = await openHostRuntime({
    pi,
    packageRoot: packageInfo.root,
    lifecycle,
    attachment,
    dataHome,
    sessionDir,
    agentDir,
    manager,
    cwd: current.path,
    repositoryRoot: cwd => Effect.succeed(cwd),
  })
  const { host, runtime } = opened
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
      'Unknown workspace command "switch". Use list, inspect <task>, check <task>, release <task>, or resume <task> [--workspace <workspace>].',
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
} finally {
  await opened?.close()
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
