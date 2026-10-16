import { installProfileFixture } from '../profile-fixture.ts'
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
import { basename, join, relative, resolve } from 'node:path'
import { mock } from 'node:test'
import { pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import type * as Pi from '@earendil-works/pi-coding-agent'
import { Effect } from 'effect'
import {
  WorkspaceError,
  type WorkspaceAttachment,
  type WorkspaceAuthorization,
  type WorkspaceLifecycle,
} from '../../src/workspace-domain.ts'
import {
  loadInstalledPi,
  IN_MEMORY_POLL,
  makeClaims,
  makeOfflineModel,
  openHostRuntime,
  replay,
  toolCall,
  waitFor,
  type ScriptedContent,
  type WaitTiming,
  within,
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
installProfileFixture(join(fixture, 'profiles'))
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
const rewriteHeader = (
  file: string,
  edit: (header: Record<string, unknown>) => Record<string, unknown>,
  target = file
) => {
  const [header = '', ...rest] = readFileSync(file, 'utf8').split('\n')
  writeFileSync(target, [JSON.stringify(edit(JSON.parse(header))), ...rest].join('\n'))
}

const orphanFork = (file: string) =>
  rewriteHeader(file, header => ({
    ...header,
    parentSession: join(fixture, 'elsewhere', 'sessions', 'parent.jsonl'),
  }))
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

const handoffText = (entry: Pi.SessionEntry): string | undefined => {
  if (entry.type === 'custom_message' && entry.customType === 'dev/workspace-handoff')
    return String(entry.content)
  if (
    entry.type === 'message' &&
    entry.message.role === 'custom' &&
    entry.message.customType === 'dev/workspace-handoff'
  )
    return String(entry.message.content)
  return undefined
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
  readonly lifecycle?: WorkspaceLifecycle
  readonly dataHome?: string
  readonly cwd?: string
}) =>
  openHostRuntime({
    coordination: { installationPath: fixture, namespacePath: join(fixture, 'authority') },
    pi,
    packageRoot: packageInfo.root,
    sessionDir,
    agentDir,
    cwd: input.cwd ?? lead,
    repositoryRoot,
    attachment: input.attachment,
    manager: input.manager,
    offline: input.offline,
    lifecycle: input.lifecycle ?? lifecycle.effect,
    dataHome: input.dataHome ?? dataHome,
  })
const overriding = <T extends object>(target: T, overrides: Partial<T>): T =>
  new Proxy(target, {
    get: (source, key) =>
      Object.hasOwn(overrides, key) ? overrides[key as keyof T] : Reflect.get(source, key, source),
  })
const attachLeadConversation = async () => {
  const manager = pi.SessionManager.create(lead, sessionDir)
  const conversation = conversationAt(manager)
  const attached = await lifecycle.attach({ conversation, cwd: lead })
  return { manager, conversation, attached }
}
const unparked = (
  host: { readonly isParked: () => boolean },
  what: string,
  timing: WaitTiming = { attempts: 40, intervalMs: 50 }
) => waitFor(what, () => (host.isParked() ? undefined : true), timing)
const pendingAtLead = async () =>
  (await lifecycle.inspect({ cwd: lead })).flatMap(view => view.pending)

try {
  await claim(
    'native external write/edit preserves checkout contention without allocating or rebinding a workspace',
    async () => {
      mkdirSync(join(fixture, 'configuration'))
      symlinkSync(join(fixture, 'configuration'), join(fixture, 'configuration-alias'))
      const paths = [
        join(fixture, 'external-tmp', 'git-repro.py'),
        join(fixture, 'configuration-alias', '.pi', 'agent', 'extensions', 'calm', 'index.ts'),
      ]
      const { offline, script } = await offlineScript('external-native', [
        paths.map((path, i) => toolCall(`external-write-${i}`, 'write', { path, content: 'one' })),
        paths.map((path, i) =>
          toolCall(`external-edit-${i}`, 'edit', { path, oldText: 'one', newText: 'two' })
        ),
      ])
      const { manager, attached } = await attachLeadConversation()
      const before = await lifecycle.inspect({ cwd: lead })
      const opened = await openLeadHost({ attachment: attached.effect, manager, offline })
      try {
        await opened.runtime.session.prompt('Write and edit both external fixture files.')
        await opened.runtime.session.waitForIdle()
        for (const [i, path] of paths.entries()) {
          for (const operation of ['write', 'edit']) {
            const result = toolResults(opened.runtime)(`external-${operation}-${i}`)
            assert.equal(result.isError, false, result.text)
          }
          assert.equal(readFileSync(path, 'utf8'), 'two')
        }
        assert.equal(script.calls(), 3)
        assert.equal(opened.runtime.cwd, lead)
        assert.equal(opened.host.isParked(), false)
        assert.deepEqual(await lifecycle.inspect({ cwd: lead }), before)
        assert.deepEqual(await pendingAtLead(), [])
        await Effect.runPromise(opened.host.close)
        const latePath = join(fixture, 'after-quit.txt')
        const late = await opened.runtime.session.extensionRunner.emitToolCall({
          type: 'tool_call',
          toolName: 'write',
          toolCallId: 'after-quit',
          input: { path: latePath, content: 'forbidden' },
        })
        assert.equal(late?.block, true)
        await assert.rejects(
          opened.host.writeOperations.writeFile(latePath, 'forbidden'),
          /no admitted destination/
        )
        assert.ok(!existsSync(latePath))
      } finally {
        await opened.close()
      }
    }
  )
  await claim(
    'native write/edit into a sibling or nested repository, including inside the lead managed workspace, reserves that checkout and writes in place without another worktree or rebind',
    async () => {
      for (const placement of ['sibling', 'nested', 'managed-nested']) {
        const { manager, attached } = await attachLeadConversation()
        if (placement === 'managed-nested') {
          const decision = await attached.authorize({ kind: 'write' })
          assert.equal(decision.kind, 'rebind')
          if (decision.kind !== 'rebind') throw new Error('Expected managed isolation')
          await attached.handoff(decision.handoff, async () => 'confirmed')
        }
        const { cwd } = attached.binding
        const other = join(placement === 'sibling' ? fixture : cwd, `${placement}-repo`)
        mkdirSync(other)
        git(['init', '--quiet', '-b', 'main'], other)
        git(['config', 'user.email', 'host-session@example.invalid'], other)
        git(['config', 'user.name', 'host session check'], other)
        writeFileSync(join(other, 'README.md'), 'other repository\n')
        git(['add', 'README.md'], other)
        git(['commit', '--quiet', '-m', 'other fixture'], other)
        const target = join(other, 'notes', 'lead.txt')
        const { offline, script } = await offlineScript('foreign-native', [
          [toolCall('foreign-write', 'write', { path: target, content: 'one' })],
          [toolCall('foreign-edit', 'edit', { path: target, oldText: 'one', newText: 'two' })],
        ])
        if (placement === 'managed-nested')
          manager.appendMessage(
            offline.assistantMessage([{ type: 'text', text: 'isolated' }], 'stop')
          )
        const before = await lifecycle.inspect({ cwd })
        const opened = await openLeadHost({ attachment: attached.effect, manager, offline, cwd })
        try {
          await opened.runtime.session.prompt('Write and edit the file in the other repository.')
          await opened.runtime.session.waitForIdle()
          for (const id of ['foreign-write', 'foreign-edit']) {
            const result = toolResults(opened.runtime)(id)
            assert.equal(result.isError, false, result.text)
          }
          assert.equal(readFileSync(target, 'utf8'), 'two')
          assert.equal(script.calls(), 3)
          assert.equal(opened.runtime.cwd, cwd)
          assert.equal(opened.host.isParked(), false)
          assert.deepEqual(attached.binding.cwd, cwd)
          assert.deepEqual(await lifecycle.inspect({ cwd }), before)
          const views = await lifecycle.inspect({ cwd: other })
          assert.ok(
            views.every(view => view.origin === 'pre-existing'),
            `no worktree was allocated: ${JSON.stringify(views)}`
          )
          assert.ok(
            views.some(
              view =>
                view.path === other && view.reservationId !== undefined && view.taskId !== undefined
            ),
            JSON.stringify(views)
          )
          assert.deepEqual(attached.effect.delegatedCwds, [other])
        } finally {
          await opened.close()
        }
      }
    }
  )
  await claim(
    'a rebind inside a mixed tool batch ends the run: the admitted sibling read is cancelled unexecuted, Pi spends no request in the old context, and the handoff tells the model which call was refused and which were cancelled',
    async () => {
      const { offline: mixed, script } = await offlineScript('mixed-batch', [
        [
          toolCall('mixed-read', 'read', { path: 'AGENTS.md' }),
          toolCall('mixed-bash', 'bash', { command: 'touch mixed-batch.txt' }),
        ],
        [toolCall('mixed-after', 'write', { path: 'mixed-after.txt', content: 'after\n' })],
      ])
      const { manager, attached } = await attachLeadConversation()
      const opened = await openLeadHost({ attachment: attached.effect, manager, offline: mixed })
      try {
        await opened.runtime.session.prompt('Read the guide and touch a file.')
        await waitFor(
          'the scripted turns',
          () => (script.calls() >= 3 ? true : undefined),
          IN_MEMORY_POLL
        )
        await opened.runtime.session.waitForIdle()
        const result = toolResults(opened.runtime)
        assert.equal(script.calls(), 3, 'no model request was spent in the old context')
        assert.equal(result('mixed-bash').isError, true)
        assert.match(
          result('mixed-bash').text,
          /requires a host rebind: .*The operation was not executed/,
          'the refused call keeps its reason'
        )
        assert.deepEqual(result('mixed-read'), { isError: true, text: 'Operation aborted' })
        assert.ok(!existsSync(join(lead, 'mixed-batch.txt')), 'the held checkout was not touched')
        assert.notEqual(
          resolve(opened.runtime.cwd),
          resolve(lead),
          'the lead left the held checkout'
        )
        assert.equal(result('mixed-after').isError, false, result('mixed-after').text)
        assert.equal(readFileSync(join(opened.runtime.cwd, 'mixed-after.txt'), 'utf8'), 'after\n')
        const entries = opened.runtime.session.sessionManager.getEntries()
        const handoffs = entries.flatMap(entry => {
          const text = handoffText(entry)
          return text === undefined ? [] : [text]
        })
        assert.equal(handoffs.length, 1)
        assert.match(
          handoffs[0] ?? '',
          /^Workspace admission changed after .*\. Dev ended that turn\. Current workspace: .*\. The call that required the rebind was not executed and was not replayed: re-evaluate the user's request in this workspace before deciding whether to perform it\. Other calls of that batch reporting "Operation aborted" or "No result provided" were cancelled before running and may be issued again if still needed\.$/
        )
        const endedTurns = entries.flatMap(entry =>
          entry.type === 'message' &&
          entry.message.role === 'assistant' &&
          entry.message.stopReason !== 'toolUse' &&
          entry.message.stopReason !== 'stop'
            ? [entry.message]
            : []
        )
        assert.equal(
          endedTurns.length,
          1,
          'the ended run persisted one assistant turn, as an Escape would'
        )
        assert.match(endedTurns[0]?.errorMessage ?? '', /aborted/i)
        assert.equal(opened.host.isParked(), false, 'the host completed the switch')
        assert.deepEqual(await pendingAtLead(), [])
      } finally {
        await opened.close()
      }
    }
  )
  const { script: lead1, offline } = await offlineScript('host-session', [
    [workProcess],
    [
      toolCall('read-after', 'read', { path: 'AGENTS.md' }),
      toolCall('write-after', 'write', { path: 'after.txt', content: 'after the rebind\n' }),
    ],
  ])
  const { manager, attached } = await attachLeadConversation()
  const opened = await openLeadHost({ attachment: attached.effect, manager, offline })
  const { host, runtime } = opened
  const result = toolResults(runtime)
  await runtime.session.prompt('Run the tests in the background.')
  await waitFor('the scripted turns', () => (lead1.calls() >= 3 ? true : undefined), IN_MEMORY_POLL)
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
      const blankFirst = join(exported, 'blank-first-line.jsonl')
      writeFileSync(blankFirst, `\n${readFileSync(copied.file, 'utf8')}`)
      const noCwd = join(exported, 'no-cwd.jsonl')
      rewriteHeader(copied.file, ({ cwd: _cwd, ...header }) => header, noCwd)
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
      await unparked(host, 'the host to leave the parked state')
    }
  )
  await opened.close()
  await claim(
    'dev starts on a conversation whose header names a parent that does not exist here',
    async () => {
      const stored = storedConversation(offline, lead)
      orphanFork(stored.file)
      const reopened = pi.SessionManager.open(stored.file, sessionDir)
      const orphan = await lifecycle.attach({ conversation: conversationAt(reopened), cwd: lead })
      const started = await openLeadHost({
        attachment: orphan.effect,
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

  const stored = storedConversation(offline, lead)
  const respelledFile = join(fixture, 'SESSIONS', basename(stored.file).toUpperCase())
  if (existsSync(respelledFile))
    await claim(
      'on a volume that ignores case, dev opened on another spelling of a conversation file and data home attaches it once, and /resume of either spelling reports it already active',
      async () => {
        const respelledHome = join(fixture, 'DATA')
        const respelledManager = pi.SessionManager.open(respelledFile, sessionDir)
        const respelled = await lifecycle.attach({
          conversation: {
            sessionId: respelledManager.getSessionId(),
            sessionFile: respelledFile,
            dataHome: respelledHome,
          },
          cwd: lead,
        })
        let attaches = 0
        const counting = overriding(lifecycle.effect, {
          attach: input => {
            attaches += 1
            return lifecycle.effect.attach(input)
          },
        })
        const spelled = await openLeadHost({
          attachment: respelled.effect,
          manager: respelledManager,
          offline,
          lifecycle: counting,
          dataHome: respelledHome,
        })
        try {
          assert.equal(attaches, 0, 'the runtime kept the attachment dev opened')
          for (const spelling of [stored.file, respelledFile])
            assert.deepEqual(
              await spelled.runtime.switchSession(spelling),
              { cancelled: true },
              spelling
            )
          assert.equal(attaches, 0, 'neither spelling attached the conversation again')
          assert.equal(
            spelled.runtime.session.sessionManager.getSessionId(),
            respelledManager.getSessionId()
          )
        } finally {
          await spelled.close()
        }
      }
    )

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
        const {
          manager: raceManager,
          conversation: raceConversation,
          attached: raced,
        } = await attachLeadConversation()
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
          await waitFor(
            'the replacement to start',
            () => (started === undefined ? undefined : true),
            IN_MEMORY_POLL
          )
          const replacing = started
          assert.ok(replacing)
          assert.deepEqual(await within(replacing, 20000, 'the replacement'), { cancelled: false })
          await unparked(race.host, 'the next session to leave the parked state')
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

  await claim(
    'a /new from a conversation holding a clean checkout releases that reservation at the replacement, so the next conversation keeps the checkout on its first write; a checkout modified before the next /new stays reserved and that conversation is isolated as before',
    async () => {
      const fresh = join(fixture, 'fresh')
      mkdirSync(join(fresh, 'scratch'), { recursive: true })
      git(['init', '--quiet', '-b', 'main'], fresh)
      git(['config', 'user.email', 'host-session@example.invalid'], fresh)
      git(['config', 'user.name', 'host session check'], fresh)
      writeFileSync(join(fresh, 'AGENTS.md'), 'fresh checkout\n')
      writeFileSync(join(fresh, '.gitignore'), 'scratch/\n')
      git(['add', 'AGENTS.md', '.gitignore'], fresh)
      git(['commit', '--quiet', '-m', 'fresh fixture'], fresh)
      const scratchWrite = (id: string) =>
        toolCall(id, 'write', { path: join(fresh, 'scratch', `${id}.txt`), content: id })
      const { offline: freshModel, script: freshScript } = await offlineScript(
        'host-session-new-clean',
        [
          [scratchWrite('first-write')],
          [{ type: 'text', text: 'done' }],
          [scratchWrite('next-write')],
          [{ type: 'text', text: 'done' }],
          [scratchWrite('modified-write')],
          [{ type: 'text', text: 'done' }],
        ]
      )
      const freshManager = pi.SessionManager.create(fresh, sessionDir)
      const freshAttached = await lifecycle.attach({
        conversation: conversationAt(freshManager),
        cwd: fresh,
      })
      const freshHost = await openLeadHost({
        attachment: freshAttached.effect,
        manager: freshManager,
        offline: freshModel,
        cwd: fresh,
      })
      const checkoutView = async () =>
        (await lifecycle.inspect({ cwd: fresh })).find(
          view => resolve(view.path) === resolve(fresh)
        )
      const output = mock.method(process.stderr, 'write')
      const receipts = () =>
        output.mock.calls
          .map(call => String(call.arguments[0]))
          .join('')
          .split('Workspace sweep at the conversation replacement')
          .slice(1)
      const sessionId = () => freshHost.runtime.session.sessionManager.getSessionId()
      const replace = async (what: string) => {
        const previous = sessionId()
        assert.deepEqual(await within(freshHost.runtime.newSession(), 20000, what), {
          cancelled: false,
        })
        await unparked(freshHost.host, `${what} to leave the parked state`)
        assert.notEqual(sessionId(), previous, `${what} started a new conversation`)
      }
      try {
        await freshHost.runtime.session.prompt('Write a scratch file.')
        await freshHost.runtime.session.waitForIdle()
        const first = toolResults(freshHost.runtime)('first-write')
        assert.equal(first.isError, false, first.text)
        const firstTask = (await checkoutView())?.taskId
        assert.ok(firstTask !== undefined, 'the first conversation reserves the checkout')

        await replace('the first /new')
        assert.equal(receipts().length, 1, 'the replacement shows one receipt before the next turn')
        assert.ok(receipts()[0]?.includes(freshAttached.binding.workspaceId))
        assert.match(receipts()[0] ?? '', /released \(automatic\)/)
        assert.match(receipts()[0] ?? '', /finished \(clean-checkout\)/)
        await freshHost.runtime.session.prompt('Write another scratch file.')
        await freshHost.runtime.session.waitForIdle()
        const next = toolResults(freshHost.runtime)('next-write')
        assert.equal(next.isError, false, next.text)
        assert.equal(
          resolve(freshHost.host.attachment.binding.cwd),
          resolve(fresh),
          'the next conversation keeps the checkout'
        )
        assert.equal(freshHost.host.attachment.binding.conversation.sessionId, sessionId())
        const nextTask = (await checkoutView())?.taskId
        assert.ok(
          nextTask !== undefined && nextTask !== firstTask,
          'the next conversation reserves the released checkout under its own task'
        )
        assert.equal(freshScript.calls(), 4, 'each prompt reached the model once per turn')

        writeFileSync(join(fresh, 'AGENTS.md'), 'modified before the next /new\n')
        await replace('the second /new')
        assert.equal(receipts().length, 2, 'the second replacement shows one more receipt')
        assert.ok(receipts()[1]?.includes(freshAttached.binding.workspaceId))
        assert.match(receipts()[1] ?? '', /retained \(checkout-modified\)/)
        await freshHost.runtime.session.prompt('Write one more scratch file.')
        await freshHost.runtime.session.waitForIdle()
        assert.equal(toolResults(freshHost.runtime)('modified-write').isError, true)
        await unparked(freshHost.host, 'the rebind to finish', { attempts: 80, intervalMs: 100 })
        assert.notEqual(
          resolve(freshHost.host.attachment.binding.cwd),
          resolve(fresh),
          'the modified checkout stays with its task and the newest conversation is isolated'
        )
        assert.equal(
          (await checkoutView())?.taskId,
          nextTask,
          'the modified checkout keeps its reservation'
        )
        assert.equal(
          readFileSync(join(fresh, 'AGENTS.md'), 'utf8'),
          'modified before the next /new\n'
        )
        assert.equal(receipts().length, 2, 'later turns do not replay replacement receipts')
      } finally {
        output.mock.restore()
        await freshHost.close()
      }
    }
  )

  await claim(
    'a /new whose leaving attachment fails to close reports the failure and starts the next conversation, keeping the reservation and isolating its first write',
    async () => {
      const held = join(fixture, 'held')
      mkdirSync(join(held, 'scratch'), { recursive: true })
      git(['init', '--quiet', '-b', 'main'], held)
      git(['config', 'user.email', 'host-session@example.invalid'], held)
      git(['config', 'user.name', 'host session check'], held)
      writeFileSync(join(held, 'AGENTS.md'), 'held checkout\n')
      writeFileSync(join(held, '.gitignore'), 'scratch/\n')
      git(['add', 'AGENTS.md', '.gitignore'], held)
      git(['commit', '--quiet', '-m', 'held fixture'], held)
      const scratchWrite = (id: string) =>
        toolCall(id, 'write', { path: join(held, 'scratch', `${id}.txt`), content: id })
      const { offline: heldModel } = await offlineScript('host-session-new-close-failure', [
        [scratchWrite('held-first')],
        [{ type: 'text', text: 'done' }],
        [scratchWrite('held-next')],
        [{ type: 'text', text: 'done' }],
      ])
      const heldManager = pi.SessionManager.create(held, sessionDir)
      const heldAttached = await lifecycle.attach({
        conversation: conversationAt(heldManager),
        cwd: held,
      })
      const heldHost = await openLeadHost({
        attachment: overriding(heldAttached.effect, {
          close: Effect.fail(
            new WorkspaceError({ outcome: 'blocked', message: 'close refused by the probe' })
          ),
        }),
        manager: heldManager,
        offline: heldModel,
        cwd: held,
      })
      const checkoutTask = async () =>
        (await lifecycle.inspect({ cwd: held })).find(view => resolve(view.path) === resolve(held))
          ?.taskId
      const output = mock.method(process.stderr, 'write')
      try {
        await heldHost.runtime.session.prompt('Write a scratch file.')
        await heldHost.runtime.session.waitForIdle()
        const first = toolResults(heldHost.runtime)('held-first')
        assert.equal(first.isError, false, first.text)
        const firstTask = await checkoutTask()
        assert.ok(firstTask !== undefined)
        const previous = heldHost.runtime.session.sessionManager.getSessionId()
        assert.deepEqual(await within(heldHost.runtime.newSession(), 20000, 'the /new'), {
          cancelled: false,
        })
        await unparked(heldHost.host, 'the next conversation to leave the parked state')
        assert.notEqual(heldHost.runtime.session.sessionManager.getSessionId(), previous)
        assert.equal(await checkoutTask(), firstTask, 'the reservation is untouched')
        const receipt = output.mock.calls.map(call => String(call.arguments[0])).join('')
        assert.match(receipt, /Workspace sweep at the conversation replacement/)
        assert.match(receipt, /close refused by the probe/)
        assert.match(receipt, /nothing was swept or released/)
        await heldHost.runtime.session.prompt('Write another scratch file.')
        await heldHost.runtime.session.waitForIdle()
        assert.equal(toolResults(heldHost.runtime)('held-next').isError, true)
        await unparked(heldHost.host, 'the rebind to finish', { attempts: 80, intervalMs: 100 })
        assert.notEqual(resolve(heldHost.host.attachment.binding.cwd), resolve(held))
        assert.equal(
          await checkoutTask(),
          firstTask,
          'the reservation still belongs to the first task'
        )
      } finally {
        output.mock.restore()
        await heldHost.close()
        await heldAttached.close()
      }
    }
  )

  const quitDuringHandoff = async (
    id: string,
    handoff: (
      quitter: WorkspaceAttachment,
      quitNow: Effect.Effect<void>
    ) => WorkspaceAttachment['handoff']
  ) => {
    const { offline: quitModel } = await offlineScript(id, [[workProcess]])
    const {
      manager: quitManager,
      conversation: quitConversation,
      attached: quitter,
    } = await attachLeadConversation()
    let disposing: Promise<void> | undefined
    let runtimeRef: Pi.AgentSessionRuntime | undefined
    let closedOnQuit = false
    const quitNow = Effect.promise(async () => {
      disposing = runtimeRef?.dispose()
      await sleep(100)
    })
    const quitting = await openLeadHost({
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
      offline: quitModel,
    })
    runtimeRef = quitting.runtime
    await quitting.runtime.session.prompt('Run the tests in the background.')
    await waitFor(
      'the quit to start',
      () => (disposing === undefined ? undefined : true),
      IN_MEMORY_POLL
    )
    const disposed = disposing
    assert.ok(disposed)
    await within(disposed, 20000, 'the quit')
    assert.ok(closedOnQuit, 'the quit alone closed the attachment')
    await quitting.close()
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
        (quitter, quitNow) => (transition, replace) =>
          quitter.handoff(transition, grant => quitNow.pipe(Effect.andThen(replace(grant))))
      )
  )
  await claim(
    'a quit during the authority handoff call that the authority refuses before calling the host back still closes the attachment and leaves the conversation resumable',
    () =>
      quitDuringHandoff(
        'host-session-quit-refused',
        (quitter, quitNow) => transition =>
          quitNow.pipe(
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
      const { manager: reloadManager, attached: reloader } = await attachLeadConversation()
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
        await waitFor('the reload', () => (reloaded ? true : undefined), IN_MEMORY_POLL)
        await unparked(reload.host, 'the switch to finish', { attempts: 80, intervalMs: 100 })
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
