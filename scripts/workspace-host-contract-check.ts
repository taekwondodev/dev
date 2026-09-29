import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Cause, Effect, Queue, Stream } from 'effect'
import {
  WorkspaceError,
  type SweepReceipt,
  type WorkspaceAttachment,
  type WorkspaceLifecycle,
  type WorkspaceSelection,
} from '../src/workspace-domain.ts'
import {
  loadInstalledPi,
  makeClaims,
  makeOfflineModel,
  openHostRuntime,
  replay,
  toolCall,
  type ScriptedContent,
} from './workspace-check-support.ts'
import {
  fixtureId,
  makeFixtureAssessment,
  makeFixtureBinding,
  makeFixtureReceipt,
  type FixtureDescriptor,
} from './workspace-host-fixture-shapes.ts'

const { pi, packageInfo, importFromPi } = await loadInstalledPi()
const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'dev-workspace-host-contract-')))
const sessionDir = join(fixture, 'sessions')
const agentDir = join(fixture, 'agent')
const dataHome = join(fixture, 'data')
const descriptor = (
  origin: FixtureDescriptor['origin'],
  task: number,
  workspace: number
): FixtureDescriptor => ({
  repoId: fixtureId(41),
  taskId: fixtureId(task),
  workspaceId: fixtureId(workspace),
  path: join(fixture, 'projects', `${origin}-${workspace}`),
  origin,
  label: 'contract-check',
})
const current = descriptor('pre-existing', 1, 11)
const other = descriptor('managed', 2, 12)
const swept = descriptor('managed', 3, 13)
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
const checked: string[] = []
const released: string[] = []
const refused = new WorkspaceError({ outcome: 'blocked', message: 'not used by this check' })
const receipt: SweepReceipt = makeFixtureReceipt({
  commandId: fixtureId(900),
  moment: 'allocation',
  rows: [
    {
      descriptor: swept,
      outcome: 'removed',
      verdict: {
        kind: 'finished',
        role: 'child',
        rule: 'child-delivered',
        reason: 'fixture pull request descends from the base',
      },
      reason:
        'The managed worktree, its Git registration and its reservation were verified removed.',
    },
  ],
})
const receipts = await Effect.runPromise(Queue.make<SweepReceipt, Cause.Done>())
const attachment: WorkspaceAttachment = {
  binding: makeFixtureBinding({ conversation, descriptor: current }),
  authorize: operation => {
    if (operation.kind === 'write') Queue.offerUnsafe(receipts, receipt)
    return Effect.fail(refused)
  },
  select: selection => {
    selections.push(selection)
    return Effect.fail(refused)
  },
  reportExecution: () => Effect.void,
  handoff: () => Effect.void,
  sweeps: Stream.fromQueue(receipts),
  close: Effect.void,
}
const lifecycle: WorkspaceLifecycle = {
  attach: () => Effect.fail(refused),
  inspect: () => Effect.succeed([]),
  validate: () => Effect.void,
  check: input => {
    checked.push(input.taskId)
    return Effect.succeed([
      makeFixtureAssessment({
        descriptor: other,
        outcome: 'removable',
        completion: {
          kind: 'finished',
          role: 'branch',
          rule: 'branch-in-target',
          reason: 'fixture HEAD is an ancestor of the target tip',
        },
        reservationId: fixtureId(112),
      }),
    ])
  },
  release: input => {
    released.push(input.workspaceId)
    return Effect.fail(refused)
  },
  sweep: () => Effect.fail(refused),
  recordTarget: () => Effect.fail(refused),
  recordPublication: () => Effect.fail(refused),
}
const steps: readonly ScriptedContent[] = [
  [toolCall('work-allocation', 'work', { action: 'process', taskId: 'tests', command: 'true' })],
]
let calls = 0
const offline = await makeOfflineModel({
  pi,
  importFromPi,
  fixture,
  id: 'host-contract',
  stream: replay(() => steps[calls++] ?? [{ type: 'text', text: 'done' }]),
})

let opened: Awaited<ReturnType<typeof openHostRuntime>> | undefined
try {
  opened = await openHostRuntime({
    coordination: { installationPath: fixture, namespacePath: join(fixture, 'authority') },
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
    offline,
  })
  const { host, runtime } = opened
  const notices: { readonly message: string; readonly level: string | undefined }[] = []
  const confirmations: string[] = []
  const handlerErrors: string[] = []
  await runtime.session.bindExtensions({
    uiContext: {
      ...runtime.session.extensionRunner.getUIContext(),
      notify: (message, level) => {
        notices.push({ message, level })
      },
      confirm: async title => {
        confirmations.push(title)
        return true
      },
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
          ? [String(entry.content)]
          : []
      )

  await claim('a malformed /workspace command is shown with its usage', async () => {
    await runtime.session.prompt('/workspace switch')
    assert.deepEqual(displayed(), [
      'Unknown workspace command "switch". Use list, inspect <task>, check <task> or release <task>.',
    ])
  })
  await claim(
    "/workspace release of this conversation's own task answers that quitting sweeps it and assesses nothing",
    async () => {
      await runtime.session.prompt(`/workspace release ${current.taskId}`)
      const answer = displayed().at(-1) ?? ''
      assert.ok(answer.includes('/quit') && answer.includes('sweeps'), answer)
      assert.deepEqual(checked, [])
      assert.deepEqual(confirmations, [])
    }
  )
  await claim(
    '/workspace release of a task with nothing review-required shows its verdicts and asks for no confirmation',
    async () => {
      await runtime.session.prompt(`/workspace release ${other.taskId}`)
      const [eligibility, answer] = displayed().slice(-2)
      assert.ok(
        eligibility?.includes('sweep verdict: finished (branch-in-target)') &&
          eligibility.includes('role: branch worktree') &&
          eligibility.includes('target: override'),
        eligibility
      )
      assert.ok(answer?.includes('nothing for an explicit release'), answer)
      assert.deepEqual(checked, [other.taskId])
      assert.deepEqual(confirmations, [])
      assert.deepEqual(released, [])
    }
  )
  await claim(
    'a sweep receipt the authority delivers while a work tool admission allocates is shown once in the conversation',
    async () => {
      const before = displayed().length
      await runtime.session.prompt('start the fixture work')
      const shown = displayed().slice(before)
      assert.equal(shown.length, 1, JSON.stringify(shown))
      assert.ok(
        shown[0]?.includes('before a worktree allocation') &&
          shown[0].includes(swept.workspaceId) &&
          shown[0].includes('removed (automatic)'),
        shown[0]
      )
    }
  )
  await claim(
    "none of these commands selected a workspace, parked the host or rejected Pi's handler",
    () => {
      assert.deepEqual(selections, [])
      assert.equal(host.isParked(), false)
      assert.deepEqual(handlerErrors, [])
      assert.deepEqual(notices, [])
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
        'Command answers and receipt delivery through a headless Pi session with a stub lifecycle; the stub attachment delivers the receipt as the worker does during an allocating admission. The sweep check exercises real allocations.',
    },
    null,
    2
  )
)
