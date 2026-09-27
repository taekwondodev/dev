// The TUI probes reach none of these session flows.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import type * as Pi from '@earendil-works/pi-coding-agent'
import { Effect } from 'effect'
import {
  WorkspaceError,
  type WorkspaceAttachment,
  type WorkspaceAuthorization,
} from '../src/workspace-domain.ts'
import {
  loadInstalledPi,
  makeClaims,
  makeOfflineModel,
  openHostRuntime,
  replay,
  toolCall,
  waitFor,
  type ScriptedContent,
} from './workspace-check-support.ts'
import { openLifecycle } from './workspace-test-lifecycle.ts'

const { pi, packageInfo, importFromPi } = await loadInstalledPi()
const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'dev-workspace-host-session-')))
const lead = join(fixture, 'lead')
const sessionDir = join(fixture, 'sessions-link')
const agentDir = join(fixture, 'agent')
const dataHome = join(fixture, 'data')
for (const path of [
  lead,
  join(fixture, 'sessions'),
  agentDir,
  join(fixture, 'home', '.agents', 'skills'),
])
  mkdirSync(path, { recursive: true })
symlinkSync(join(fixture, 'sessions'), sessionDir)
mkdirSync(dataHome, { mode: 0o700 })
process.env.HOME = join(fixture, 'home')
process.env.PI_CODING_AGENT_DIR = agentDir
process.env.PI_OFFLINE = '1'
process.env.PI_TELEMETRY_DISABLED = '1'
const git = (args: readonly string[], cwd = lead) =>
  execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()
git(['init', '--quiet', '-b', 'main'])
git(['config', 'user.email', 'host-session@example.invalid'])
git(['config', 'user.name', 'host session check'])
writeFileSync(join(lead, 'AGENTS.md'), 'host session check\n')
git(['add', 'AGENTS.md'])
git(['commit', '--quiet', '-m', 'host session fixture'])
const leadCommit = git(['rev-parse', 'HEAD'])
const repositoryRoot = (cwd: string) =>
  Effect.sync(() => {
    try {
      return git(['rev-parse', '--show-toplevel'], cwd)
    } catch {
      return undefined
    }
  })

const scripted = (steps: readonly ScriptedContent[]) => {
  let calls = 0
  return {
    calls: () => calls,
    next: (): ScriptedContent => steps[calls++] ?? [{ type: 'text', text: 'done' }],
  }
}
type OfflineModel = Awaited<ReturnType<typeof makeOfflineModel>>
const offlineScript = async (id: string, steps: readonly ScriptedContent[]) => {
  const script = scripted(steps)
  const offline = await makeOfflineModel({
    pi,
    importFromPi,
    fixture,
    id,
    stream: replay(script.next),
  })
  return { script, offline }
}
const workProcess = toolCall('work-process', 'work', {
  action: 'process',
  taskId: 'tests',
  command: 'true',
})
const storedConversation = (offline: OfflineModel, cwd: string, directory = sessionDir) => {
  const manager = pi.SessionManager.create(cwd, directory)
  manager.appendMessage(offline.assistantMessage([{ type: 'text', text: 'stored' }], 'stop'))
  const file = manager.getSessionFile()
  if (file === undefined) throw new Error('Pi did not persist the stored conversation')
  return { manager, file }
}
// Pi writes a fork's parent path into its header, so a fork copied from another machine names a
// parent that does not exist here.
const orphanFork = (file: string) => {
  const [header = '', ...rest] = readFileSync(file, 'utf8').split('\n')
  const parentSession = join(fixture, 'elsewhere', 'sessions', 'parent.jsonl')
  writeFileSync(
    file,
    [JSON.stringify({ ...JSON.parse(header), parentSession }), ...rest].join('\n')
  )
}
const toolResults = (runtime: Pi.AgentSessionRuntime) => (toolCallId: string) => {
  const found = runtime.session.sessionManager
    .getEntries()
    .flatMap(entry =>
      entry.type === 'message' && entry.message.role === 'toolResult' ? [entry.message] : []
    )
    .find(message => message.toolCallId === toolCallId)
  return {
    isError: found?.isError,
    text: (found?.content ?? [])
      .flatMap(part => (part.type === 'text' ? [part.text] : []))
      .join('\n'),
  }
}

const { claim, passed } = makeClaims()
const lifecycle = await openLifecycle({ root: join(fixture, 'authority') })
const squatterFile = join(dataHome, 'squatter.jsonl')
writeFileSync(squatterFile, '{}\n', { mode: 0o600 })
const squatter = await lifecycle.attach({
  conversation: { sessionId: 'host-session-squatter', sessionFile: squatterFile, dataHome },
  cwd: lead,
})
assert.equal((await squatter.authorize({ kind: 'write' })).kind, 'ready')
const conversationAt = (manager: Pi.SessionManager) => {
  const sessionFile = manager.getSessionFile()
  if (sessionFile === undefined) throw new Error('Pi did not name the session file')
  return { sessionId: manager.getSessionId(), sessionFile, dataHome }
}
const openLeadHost = (input: {
  readonly attachment: WorkspaceAttachment
  readonly manager: Pi.SessionManager
  readonly offline: OfflineModel
}) =>
  openHostRuntime({
    pi,
    packageRoot: packageInfo.root,
    lifecycle: lifecycle.effect,
    dataHome,
    sessionDir,
    agentDir,
    cwd: lead,
    repositoryRoot,
    ...input,
  })
const overriding = (
  attachment: WorkspaceAttachment,
  overrides: Partial<WorkspaceAttachment>
): WorkspaceAttachment =>
  new Proxy(attachment, {
    get: (target, key) =>
      Object.hasOwn(overrides, key)
        ? overrides[key as keyof WorkspaceAttachment]
        : Reflect.get(target, key, target),
  })
const pendingAtLead = async () =>
  (await lifecycle.inspect({ cwd: lead })).flatMap(view => view.pending)

try {
  const { script: lead1, offline } = await offlineScript('host-session', [
    [workProcess],
    [
      toolCall('read-after', 'read', { path: 'AGENTS.md' }),
      toolCall('write-after', 'write', { path: 'after.txt', content: 'after the rebind\n' }),
    ],
  ])
  const manager = pi.SessionManager.create(lead, sessionDir)
  const attachment = await lifecycle.attach({ conversation: conversationAt(manager), cwd: lead })
  const opened = await openLeadHost({ attachment: attachment.effect, manager, offline })
  const { host, runtime } = opened
  const result = toolResults(runtime)
  await runtime.session.prompt('Run the tests in the background.')
  await waitFor('the scripted turns', () => (lead1.calls() >= 3 ? true : undefined))
  await runtime.session.waitForIdle()

  await claim(
    'a work process refused in a checkout another task holds hands its rebind to the host, which moves the lead to an exact-commit managed worktree instead of leaving it parked',
    async () => {
      assert.equal(result('work-process').isError, true)
      assert.match(
        result('work-process').text,
        /^Workspace handoff required before starting work: Another task owns or is using the requested checkout/
      )
      assert.notEqual(resolve(runtime.cwd), resolve(lead), 'the lead left the held checkout')
      assert.equal(git(['rev-parse', 'HEAD'], runtime.cwd), leadCommit)
      assert.equal(host.isParked(), false, 'the host completed the switch')
      assert.deepEqual(await pendingAtLead(), [], 'no switch is left pending')
    }
  )
  await claim(
    'the refused work call ends the batch as an error, so Pi makes no request in the old context: the next one reads and writes in the managed worktree',
    () => {
      assert.equal(lead1.calls(), 3, 'no model request was spent in the old context')
      assert.equal(result('read-after').isError, false, result('read-after').text)
      assert.equal(result('write-after').isError, false, result('write-after').text)
      assert.equal(readFileSync(join(runtime.cwd, 'after.txt'), 'utf8'), 'after the rebind\n')
      assert.ok(!existsSync(join(lead, 'after.txt')), 'the held checkout was not written')
    }
  )
  await claim(
    'a fork after the rebind continues in the managed worktree the conversation moved to, not the checkout its copied header names',
    async () => {
      const managedCwd = runtime.cwd
      const parentId = runtime.session.sessionManager.getSessionId()
      const leaf = runtime.session.sessionManager.getLeafId()
      if (leaf === null) throw new Error('The rebound conversation has no leaf to fork')
      assert.equal((await runtime.fork(leaf, { position: 'at' })).cancelled, false)
      assert.notEqual(runtime.session.sessionManager.getSessionId(), parentId)
      assert.equal(resolve(runtime.cwd), resolve(managedCwd))
      assert.equal(resolve(host.attachment.binding.cwd), resolve(managedCwd))
    }
  )
  await claim(
    'importing a stored conversation that another dev session keeps live, named by path, ~/ path or file URL, is cancelled before Pi tears the current session down',
    async () => {
      const held = storedConversation(offline, lead)
      const holder = await openLifecycle({ root: join(fixture, 'authority') })
      const holding = await holder.attach({ conversation: conversationAt(held.manager), cwd: lead })
      try {
        const current = runtime.session.sessionManager.getSessionId()
        for (const named of [
          held.file,
          `~/${relative(homedir(), held.file)}`,
          pathToFileURL(held.file).href,
        ])
          assert.deepEqual(await runtime.importFromJsonl(named), { cancelled: true }, named)
        assert.equal(runtime.session.sessionManager.getSessionId(), current)
        assert.equal(host.isParked(), false, 'a refused import leaves the host usable')
      } finally {
        await holding.close()
        await holder.close()
      }
    }
  )
  await claim(
    'importing a copied conversation whose working directory, read as Pi reads it, is not inside a Git checkout is cancelled before Pi tears the current session down',
    async () => {
      const outside = join(fixture, 'outside-git')
      const exported = join(fixture, 'exported')
      mkdirSync(outside)
      mkdirSync(exported)
      const copied = storedConversation(offline, outside, exported)
      const [header = '', ...rest] = readFileSync(copied.file, 'utf8').split('\n')
      const { cwd: _cwd, ...headerWithoutCwd } = JSON.parse(header) as { readonly cwd: string }
      const blankFirst = join(exported, 'blank-first-line.jsonl')
      writeFileSync(blankFirst, ['', header, ...rest].join('\n'))
      const noCwd = join(exported, 'no-cwd.jsonl')
      writeFileSync(noCwd, [JSON.stringify(headerWithoutCwd), ...rest].join('\n'))
      const current = runtime.session.sessionManager.getSessionId()
      const launchDirectory = process.cwd()
      for (const [file, directory] of [
        [copied.file, launchDirectory],
        [blankFirst, launchDirectory],
        [noCwd, outside],
      ] as const) {
        const bytes = readFileSync(file)
        process.chdir(directory)
        try {
          assert.deepEqual(await runtime.importFromJsonl(file), { cancelled: true }, file)
        } finally {
          process.chdir(launchDirectory)
        }
        assert.deepEqual(readFileSync(file), bytes, `${file} is unchanged`)
      }
      assert.equal(runtime.session.sessionManager.getSessionId(), current)
      assert.equal(host.isParked(), false)
    }
  )
  await claim(
    'importing a path in the session directory that does not exist, or a dangling link there, is left to Pi, which reports it and keeps the current session; resuming the dangling link is cancelled',
    async () => {
      const current = runtime.session.sessionManager.getSessionId()
      const missing = join(sessionDir, 'typo-does-not-exist.jsonl')
      const dangling = join(sessionDir, 'dangling.jsonl')
      symlinkSync(join(fixture, 'nowhere.jsonl'), dangling)
      for (const named of [missing, dangling])
        await assert.rejects(
          runtime.importFromJsonl(named),
          { name: 'SessionImportFileNotFoundError' },
          named
        )
      assert.deepEqual(await runtime.switchSession(dangling), { cancelled: true })
      assert.equal(runtime.session.sessionManager.getSessionId(), current)
      assert.ok(!existsSync(missing), 'no conversation was created at the missing path')
      assert.equal(host.isParked(), false)
    }
  )
  await claim(
    'a conversation whose header names a parent that does not exist here, such as a fork copied from another machine, can be resumed and imported as a copy',
    async () => {
      const stored = storedConversation(offline, lead)
      orphanFork(stored.file)
      assert.deepEqual(await runtime.switchSession(stored.file), { cancelled: false })
      assert.equal(host.attachment.binding.conversation.sessionId, stored.manager.getSessionId())
      const exported = join(fixture, 'exported-fork')
      mkdirSync(exported)
      const copied = storedConversation(offline, lead, exported)
      orphanFork(copied.file)
      assert.deepEqual(await runtime.importFromJsonl(copied.file), { cancelled: false })
      assert.equal(host.attachment.binding.conversation.sessionId, copied.manager.getSessionId())
      assert.equal(runtime.session.sessionManager.getSessionId(), copied.manager.getSessionId())
      await waitFor(
        'the host to leave the parked state',
        () => (host.isParked() ? undefined : true),
        { attempts: 40, intervalMs: 50 }
      )
    }
  )
  await opened.close()
  await claim(
    'dev starts on a conversation whose header names a parent that does not exist here',
    async () => {
      const stored = storedConversation(offline, lead)
      orphanFork(stored.file)
      const reopened = pi.SessionManager.open(stored.file, sessionDir)
      const attached = await lifecycle.attach({ conversation: conversationAt(reopened), cwd: lead })
      const started = await openLeadHost({
        attachment: attached.effect,
        manager: reopened,
        offline,
      })
      try {
        assert.equal(started.runtime.session.sessionManager.getSessionId(), reopened.getSessionId())
        assert.equal(started.host.isParked(), false)
      } finally {
        await started.close()
      }
    }
  )

  // Pi replaces the session while the work tool is still being admitted: its teardown waits
  // for the running tool, so the rebind reaches the host during the replacement.
  for (const [replacement, order, withdrawalDelayMs] of [
    ['new', 'before', 0],
    ['resume', 'before', 0],
    ['resume', 'after', 0],
    ['import', 'after', 0],
    ['new', 'before', 1500],
  ] as const)
    await claim(
      `a /${replacement} that starts ${order} a contended work call's admission request withdraws the rebind${withdrawalDelayMs > 0 ? ' even when the withdrawal outlasts the replacement' : ''}: the next session stays usable and the old conversation can be resumed`,
      async () => {
        const { script: steps, offline: racing } = await offlineScript(
          `host-session-${replacement}-${order}-${withdrawalDelayMs}`,
          [[workProcess]]
        )
        const other = storedConversation(racing, lead)
        const raceManager = pi.SessionManager.create(lead, sessionDir)
        const raceConversation = conversationAt(raceManager)
        const raced = await lifecycle.attach({ conversation: raceConversation, cwd: lead })
        let started: Promise<unknown> | undefined
        let runtimeRef: Pi.AgentSessionRuntime | undefined
        const replacements = {
          new: () => runtimeRef?.newSession(),
          resume: () => runtimeRef?.switchSession(other.file),
          import: () => runtimeRef?.importFromJsonl(other.file),
        }
        const racingAdmission = {
          before: (authorizing: Effect.Effect<WorkspaceAuthorization, WorkspaceError>) =>
            Effect.promise(async () => {
              started = replacements[replacement]()
              await sleep(150)
            }).pipe(Effect.andThen(authorizing)),
          after: (authorizing: Effect.Effect<WorkspaceAuthorization, WorkspaceError>) =>
            Effect.promise(async () => {
              const admitted = Effect.runPromise(authorizing)
              await Promise.resolve()
              started = replacements[replacement]()
              return admitted
            }),
        }
        const authorize: WorkspaceAttachment['authorize'] = operation =>
          started === undefined && operation.kind === 'write'
            ? racingAdmission[order](raced.effect.authorize(operation))
            : raced.effect.authorize(operation)
        // The rebind is only ever withdrawn here, so a slow handoff is a slow withdrawal.
        const slowWithdrawal: WorkspaceAttachment['handoff'] = (transition, replace) =>
          Effect.sleep(withdrawalDelayMs).pipe(
            Effect.andThen(raced.effect.handoff(transition, replace))
          )
        const race = await openLeadHost({
          attachment: overriding(
            raced.effect,
            withdrawalDelayMs > 0 ? { authorize, handoff: slowWithdrawal } : { authorize }
          ),
          manager: raceManager,
          offline: racing,
        })
        runtimeRef = race.runtime
        try {
          await race.runtime.session.prompt('Run the tests in the background.')
          await waitFor('the replacement', () => started)
          assert.deepEqual(await started, { cancelled: false })
          await waitFor(
            'the next session to leave the parked state',
            () => (race.host.isParked() ? undefined : true),
            { attempts: 40, intervalMs: 50 }
          )
          const before = steps.calls()
          await race.runtime.session.prompt('Are you there?')
          await race.runtime.session.waitForIdle()
          assert.ok(steps.calls() > before, 'a prompt in the next session reaches the model')
          assert.deepEqual(await pendingAtLead(), [], 'the withdrawn switch is not left pending')
          const resumed = await lifecycle.attach({ conversation: raceConversation, cwd: lead })
          assert.equal(resolve(resumed.binding.cwd), resolve(lead))
          await resumed.close()
        } finally {
          await race.close()
        }
      }
    )

  // Pi exits right after the quit, so the quit itself must close the attachment.
  const quitDuringHandoff = async (
    id: string,
    handoff: (
      quitter: WorkspaceAttachment,
      quit: Effect.Effect<void>
    ) => WorkspaceAttachment['handoff']
  ) => {
    const { offline: quitting } = await offlineScript(id, [[workProcess]])
    const quitManager = pi.SessionManager.create(lead, sessionDir)
    const quitConversation = conversationAt(quitManager)
    const quitter = await lifecycle.attach({ conversation: quitConversation, cwd: lead })
    let disposing: Promise<void> | undefined
    let runtimeRef: Pi.AgentSessionRuntime | undefined
    let closedOnQuit = false
    const quitNow = Effect.promise(async () => {
      disposing = runtimeRef?.dispose()
      await sleep(100)
    })
    const quit = await openLeadHost({
      attachment: overriding(quitter.effect, {
        close: quitter.effect.close.pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              closedOnQuit = true
            })
          )
        ),
        handoff: handoff(quitter.effect, quitNow),
      }),
      manager: quitManager,
      offline: quitting,
    })
    runtimeRef = quit.runtime
    await quit.runtime.session.prompt('Run the tests in the background.')
    await waitFor('the quit', () => (disposing === undefined ? undefined : true))
    await disposing
    assert.ok(closedOnQuit, 'the quit alone closed the attachment')
    await quit.close()
    assert.deepEqual(await pendingAtLead(), [], 'the switch is settled, not left unknown')
    const resumed = await lifecycle.attach({ conversation: quitConversation, cwd: lead })
    assert.equal(resolve(resumed.binding.cwd), resolve(lead), 'the last binding was kept')
    await resumed.close()
  }
  await claim(
    'a quit that lands after the authority started a switch, before the host acted, records the switch as cancelled and leaves the conversation resumable',
    () =>
      quitDuringHandoff(
        'host-session-quit',
        (quitter, quit) => (transition, replace) =>
          quitter.handoff(transition, grant => quit.pipe(Effect.andThen(replace(grant))))
      )
  )
  await claim(
    'a quit during the authority handoff call that the authority refuses before calling the host back still closes the attachment and leaves the conversation resumable',
    () =>
      quitDuringHandoff(
        'host-session-quit-refused',
        (quitter, quit) => transition =>
          quit.pipe(
            // The authority withdraws a switch it refuses, then reports it blocked.
            Effect.andThen(quitter.handoff(transition, () => Effect.succeed('cancelled' as const))),
            Effect.andThen(
              Effect.fail(
                new WorkspaceError({
                  outcome: 'blocked',
                  message: 'Workspace transition refused before the host acted',
                })
              )
            )
          )
      )
  )
  await claim(
    'a /reload that lands after the authority started a switch, before the host acted, does not leave the switch unknown: it completes in the reloaded session',
    async () => {
      const { offline: reloading } = await offlineScript('host-session-reload', [[workProcess]])
      const reloadManager = pi.SessionManager.create(lead, sessionDir)
      const reloader = await lifecycle.attach({
        conversation: conversationAt(reloadManager),
        cwd: lead,
      })
      let runtimeRef: Pi.AgentSessionRuntime | undefined
      let reloaded = false
      const reload = await openLeadHost({
        attachment: overriding(reloader.effect, {
          handoff: (transition, replace) =>
            reloader.effect.handoff(transition, grant =>
              Effect.promise(async () => {
                await runtimeRef?.session.reload()
                reloaded = true
              }).pipe(Effect.andThen(replace(grant)))
            ),
        }),
        manager: reloadManager,
        offline: reloading,
      })
      runtimeRef = reload.runtime
      try {
        await reload.runtime.session.prompt('Run the tests in the background.')
        await waitFor('the reload', () => (reloaded ? true : undefined))
        await waitFor('the switch to finish', () => (reload.host.isParked() ? undefined : true), {
          attempts: 80,
          intervalMs: 100,
        })
        assert.notEqual(resolve(reload.runtime.cwd), resolve(lead), 'the switch completed')
        assert.deepEqual(await pendingAtLead(), [], 'the switch is not left unknown')
      } finally {
        await reload.close()
      }
    }
  )
} finally {
  await squatter.close()
  await lifecycle.close()
  rmSync(fixture, { recursive: true, force: true })
}

console.log(JSON.stringify({ result: 'passed', checks: passed }, null, 2))
