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
import type { WorkspaceAttachment } from '../src/workspace-domain.ts'
import {
  loadInstalledPi,
  makeClaims,
  makeOfflineModel,
  openHostRuntime,
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
const workProcess = toolCall('work-process', 'work', {
  action: 'process',
  taskId: 'tests',
  command: 'true',
})
const storedConversation = (offline: Awaited<ReturnType<typeof makeOfflineModel>>, cwd: string) => {
  const manager = pi.SessionManager.create(cwd, sessionDir)
  manager.appendMessage(offline.assistantMessage([{ type: 'text', text: 'stored' }], 'stop'))
  const file = manager.getSessionFile()
  if (file === undefined) throw new Error('Pi did not persist the stored conversation')
  return { manager, file }
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

try {
  const lead1 = scripted([
    [workProcess],
    [
      toolCall('read-after', 'read', { path: 'AGENTS.md' }),
      toolCall('write-after', 'write', { path: 'after.txt', content: 'after the rebind\n' }),
    ],
  ])
  const offline = await makeOfflineModel({
    pi,
    importFromPi,
    fixture,
    id: 'host-session',
    next: lead1.next,
  })
  const manager = pi.SessionManager.create(lead, sessionDir)
  const attachment = await lifecycle.attach({ conversation: conversationAt(manager), cwd: lead })
  const opened = await openHostRuntime({
    pi,
    packageRoot: packageInfo.root,
    lifecycle: lifecycle.effect,
    attachment: attachment.effect,
    dataHome,
    sessionDir,
    agentDir,
    manager,
    cwd: lead,
    repositoryRoot,
    offline,
  })
  const { host, runtime } = opened
  const result = toolResults(runtime)
  await runtime.session.prompt('Run the tests in the background.')
  await waitFor('the scripted turns', async () => (lead1.calls() >= 3 ? true : undefined))
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
      assert.deepEqual(
        (await lifecycle.inspect({ cwd: lead })).flatMap(view => view.pending),
        [],
        'no switch is left pending'
      )
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
      const copied = pi.SessionManager.create(outside, exported)
      copied.appendMessage(offline.assistantMessage([{ type: 'text', text: 'exported' }], 'stop'))
      const copiedFile = copied.getSessionFile()
      if (copiedFile === undefined) throw new Error('Pi did not persist the exported conversation')
      const [header = '', ...rest] = readFileSync(copiedFile, 'utf8').split('\n')
      const { cwd: _cwd, ...headerWithoutCwd } = JSON.parse(header) as { readonly cwd: string }
      const blankFirst = join(exported, 'blank-first-line.jsonl')
      writeFileSync(blankFirst, ['', header, ...rest].join('\n'))
      const noCwd = join(exported, 'no-cwd.jsonl')
      writeFileSync(noCwd, [JSON.stringify(headerWithoutCwd), ...rest].join('\n'))
      const current = runtime.session.sessionManager.getSessionId()
      const launchDirectory = process.cwd()
      for (const [file, directory] of [
        [copiedFile, launchDirectory],
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
  await opened.close()

  // Pi replaces the session while the work tool is still being admitted: its teardown waits
  // for the running tool, so the rebind reaches the host during the replacement.
  for (const [replacement, order] of [
    ['new', 'before'],
    ['resume', 'before'],
    ['resume', 'after'],
    ['import', 'after'],
  ] as const)
    await claim(
      `a /${replacement} that starts ${order} a contended work call's admission request withdraws the rebind: the next session stays usable and the old conversation can be resumed`,
      async () => {
        const steps = scripted([[workProcess]])
        const racing = await makeOfflineModel({
          pi,
          importFromPi,
          fixture,
          id: `host-session-${replacement}-${order}`,
          next: steps.next,
        })
        const other = storedConversation(racing, lead)
        const raceManager = pi.SessionManager.create(lead, sessionDir)
        const raceConversation = conversationAt(raceManager)
        const raced = await lifecycle.attach({ conversation: raceConversation, cwd: lead })
        let started: Promise<unknown> | undefined
        let runtimeRef: Pi.AgentSessionRuntime | undefined
        const replace = () =>
          replacement === 'new'
            ? runtimeRef?.newSession()
            : replacement === 'resume'
              ? runtimeRef?.switchSession(other.file)
              : runtimeRef?.importFromJsonl(other.file)
        const admitting: WorkspaceAttachment = new Proxy(raced.effect, {
          get: (target, key) =>
            key === 'authorize'
              ? (operation: Parameters<WorkspaceAttachment['authorize']>[0]) =>
                  started === undefined && operation.kind === 'write'
                    ? order === 'before'
                      ? Effect.promise(async () => {
                          started = replace()
                          await sleep(150)
                        }).pipe(Effect.andThen(target.authorize(operation)))
                      : Effect.promise(async () => {
                          const admitted = Effect.runPromise(target.authorize(operation))
                          await Promise.resolve()
                          started = replace()
                          return admitted
                        })
                    : target.authorize(operation)
              : Reflect.get(target, key, target),
        })
        const race = await openHostRuntime({
          pi,
          packageRoot: packageInfo.root,
          lifecycle: lifecycle.effect,
          attachment: admitting,
          dataHome,
          sessionDir,
          agentDir,
          manager: raceManager,
          cwd: lead,
          repositoryRoot,
          offline: racing,
        })
        runtimeRef = race.runtime
        try {
          await race.runtime.session.prompt('Run the tests in the background.')
          await waitFor('the replacement', async () => started)
          assert.deepEqual(await started, { cancelled: false })
          await waitFor(
            'the next session to leave the parked state',
            async () => (race.host.isParked() ? undefined : true),
            40,
            50
          )
          const before = steps.calls()
          await race.runtime.session.prompt('Are you there?')
          await race.runtime.session.waitForIdle()
          assert.ok(steps.calls() > before, 'a prompt in the next session reaches the model')
          assert.deepEqual(
            (await lifecycle.inspect({ cwd: lead })).flatMap(view => view.pending),
            [],
            'the withdrawn switch is not left pending'
          )
          const resumed = await lifecycle.attach({ conversation: raceConversation, cwd: lead })
          assert.equal(resolve(resumed.binding.cwd), resolve(lead))
          await resumed.close()
        } finally {
          await race.close()
        }
      }
    )
  await claim(
    'a quit that lands after the authority started a switch, before the host acted, records the switch as cancelled and leaves the conversation resumable',
    async () => {
      const steps = scripted([[workProcess]])
      const quitting = await makeOfflineModel({
        pi,
        importFromPi,
        fixture,
        id: 'host-session-quit',
        next: steps.next,
      })
      const quitManager = pi.SessionManager.create(lead, sessionDir)
      const quitConversation = conversationAt(quitManager)
      const quitter = await lifecycle.attach({ conversation: quitConversation, cwd: lead })
      let disposing: Promise<void> | undefined
      let runtimeRef: Pi.AgentSessionRuntime | undefined
      let closedOnQuit = false
      const handingOff: WorkspaceAttachment = new Proxy(quitter.effect, {
        get: (target, key) =>
          key === 'close'
            ? target.close.pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    closedOnQuit = true
                  })
                )
              )
            : key === 'handoff'
              ? (...[transition, replace]: Parameters<WorkspaceAttachment['handoff']>) =>
                  target.handoff(transition, grant =>
                    Effect.promise(async () => {
                      disposing = runtimeRef?.dispose()
                      await sleep(100)
                    }).pipe(Effect.andThen(replace(grant)))
                  )
              : Reflect.get(target, key, target),
      })
      const quit = await openHostRuntime({
        pi,
        packageRoot: packageInfo.root,
        lifecycle: lifecycle.effect,
        attachment: handingOff,
        dataHome,
        sessionDir,
        agentDir,
        manager: quitManager,
        cwd: lead,
        repositoryRoot,
        offline: quitting,
      })
      runtimeRef = quit.runtime
      await quit.runtime.session.prompt('Run the tests in the background.')
      await waitFor('the quit', async () => (disposing === undefined ? undefined : true))
      await disposing
      assert.ok(closedOnQuit, 'the quit alone closed the attachment, as Pi exits right after it')
      await quit.close()
      assert.deepEqual(
        (await lifecycle.inspect({ cwd: lead })).flatMap(view => view.pending),
        [],
        'the switch is settled, not left unknown'
      )
      const resumed = await lifecycle.attach({ conversation: quitConversation, cwd: lead })
      assert.equal(resolve(resumed.binding.cwd), resolve(lead), 'the last binding was kept')
      await resumed.close()
    }
  )
} finally {
  await squatter.close()
  await lifecycle.close()
  rmSync(fixture, { recursive: true, force: true })
}

console.log(JSON.stringify({ result: 'passed', checks: passed }, null, 2))
