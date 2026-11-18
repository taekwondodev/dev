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
import * as Effect from 'effect/Effect'
import {
  WorkspaceError,
  type WorkspaceAttachment,
  type WorkspaceAuthorization,
  type WorkspaceId,
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
  readonly ui?: Partial<Pi.ExtensionUIContext>
  readonly extensions?: readonly { readonly name: string; readonly factory: Pi.ExtensionFactory }[]
  readonly reopening?: (sessionFile: string) => void
  readonly onParkingChange?: () => void
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
    ...(input.ui === undefined ? {} : { ui: input.ui }),
    ...(input.extensions === undefined
      ? {}
      : { extensions: dev => [...dev, ...(input.extensions ?? [])] }),
    ...(input.reopening === undefined ? {} : { reopening: input.reopening }),
    ...(input.onParkingChange === undefined ? {} : { onParkingChange: input.onParkingChange }),
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

const CONTINUE_HERE = 'Continue that task here'
const RESUME_LIST = 'Resume paused work in:'
const pausedCheckout = async (name: string) => {
  const checkout = join(fixture, name)
  mkdirSync(checkout)
  git(['init', '--quiet', '-b', 'main'], checkout)
  git(['config', 'user.email', 'host-session@example.invalid'], checkout)
  git(['config', 'user.name', 'host session check'], checkout)
  writeFileSync(join(checkout, 'AGENTS.md'), `${name}\n`)
  git(['add', 'AGENTS.md'], checkout)
  git(['commit', '--quiet', '-m', 'paused fixture'], checkout)
  const commit = git(['rev-parse', 'HEAD'], checkout)
  git(['switch', '--quiet', '-c', `feat/${name}`], checkout)
  writeFileSync(join(checkout, 'draft.txt'), 'uncommitted work\n')
  const seed = await lifecycle.attach({
    conversation: conversationAt(pi.SessionManager.create(checkout, sessionDir)),
    cwd: checkout,
  })
  const admitted = await seed.authorize({ kind: 'write' })
  if (admitted.kind !== 'ready' || admitted.grant.taskId === undefined)
    throw new Error('the fixture requires a task that wrote the checkout')
  await seed.close()
  const manager = pi.SessionManager.create(checkout, sessionDir)
  const attached = await lifecycle.attach({ conversation: conversationAt(manager), cwd: checkout })
  return { checkout, commit, taskId: admitted.grant.taskId, manager, attached }
}
type Answer = (title: string, options: readonly string[]) => string | undefined
const interactive = (answer: Answer) => {
  const asked: { readonly title: string; readonly options: readonly string[] }[] = []
  const notices: string[] = []
  const ui: Partial<Pi.ExtensionUIContext> = {
    select: async (title, options) => {
      asked.push({ title, options })
      return answer(title, options)
    },
    notify: message => {
      notices.push(message)
    },
  }
  return { asked, notices, ui }
}
const shown = (runtime: Pi.AgentSessionRuntime): string[] =>
  runtime.session.sessionManager
    .getEntries()
    .flatMap(entry =>
      entry.type === 'custom_message' && entry.customType === 'dev/workspace'
        ? [String(entry.content)]
        : []
    )
const lifecycleEntries = (manager: Pi.SessionManager): unknown[] =>
  manager
    .getEntries()
    .flatMap(entry =>
      entry.type === 'custom' && entry.customType === 'test/lifecycle' ? [entry.data] : []
    )
const handoffTexts = (runtime: Pi.AgentSessionRuntime): string[] =>
  runtime.session.sessionManager.getEntries().flatMap(entry => {
    const text = handoffText(entry)
    return text === undefined ? [] : [text]
  })

try {
  await claim(
    'native external write/edit preserves checkout contention without allocating a workspace or a handoff',
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
          /No write permission for/
        )
        assert.ok(!existsSync(latePath))
      } finally {
        await opened.close()
      }
    }
  )
  await claim(
    'native write/edit into a sibling or nested repository, including inside the lead managed workspace, reserves that checkout and writes in place without another worktree or handoff',
    async () => {
      for (const placement of ['sibling', 'nested', 'managed-nested']) {
        const { manager, attached } = await attachLeadConversation()
        if (placement === 'managed-nested') {
          const decision = await attached.authorize({ kind: 'write' })
          assert.equal(decision.kind, 'handoff')
          if (decision.kind !== 'handoff') throw new Error('Expected managed isolation')
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
    'a native artifact write requires writer admission: a bound task with another writer is refused without touching the file, and retry succeeds once that writer closes',
    async () => {
      const checkout = join(fixture, 'artifact-checkout')
      git(['worktree', 'add', '--quiet', '--detach', checkout, 'HEAD'])
      const seedManager = pi.SessionManager.create(checkout, sessionDir)
      const seed = await lifecycle.attach({
        conversation: conversationAt(seedManager),
        cwd: checkout,
      })
      const grant = await seed.authorize({ kind: 'write' })
      assert.equal(grant.kind, 'ready')
      if (grant.kind !== 'ready' || grant.grant.taskId === undefined)
        throw new Error('the fixture requires an admitted task')
      const { taskId } = grant.grant
      const selection = { taskId, workspaceId: grant.grant.workspaceId }
      await seed.close()
      const manager = pi.SessionManager.create(checkout, sessionDir)
      const attached = await lifecycle.attach({
        conversation: conversationAt(manager),
        cwd: checkout,
        selection,
      })
      const holderManager = pi.SessionManager.create(checkout, sessionDir)
      const holder = await lifecycle.attach({
        conversation: conversationAt(holderManager),
        cwd: checkout,
        selection,
      })
      const path = join(fixture, 'authority', 'artifacts', taskId, 'handoff.md')
      const steps: ScriptedContent[] = [
        [toolCall('artifact-blocked', 'write', { path, content: 'blocked bytes' })],
      ]
      const { offline, script } = await offlineScript('artifact-native', steps)
      const opened = await openLeadHost({
        attachment: attached.effect,
        manager,
        offline,
        cwd: checkout,
      })
      try {
        assert.equal((await holder.authorize({ kind: 'write' })).kind, 'ready')
        await opened.runtime.session.prompt('Write the task handoff.')
        await opened.runtime.session.waitForIdle()
        const blocked = toolResults(opened.runtime)('artifact-blocked')
        assert.equal(blocked.isError, true, blocked.text)
        assert.match(blocked.text, /cannot confirm the previous writer stopped/)
        assert.equal(existsSync(path), false, 'refused admission must not write artifact bytes')
        assert.equal(opened.runtime.cwd, checkout)
        await holder.close()
        steps[script.calls()] = [
          toolCall('artifact-retry', 'write', { path, content: 'admitted bytes' }),
        ]
        await opened.runtime.session.prompt(
          'Retry the task handoff now that its writer has closed.'
        )
        await opened.runtime.session.waitForIdle()
        const retried = toolResults(opened.runtime)('artifact-retry')
        assert.equal(retried.isError, false, retried.text)
        assert.equal(readFileSync(path, 'utf8'), 'admitted bytes')
        assert.equal(attached.binding.taskId, taskId)
        assert.equal(opened.runtime.cwd, checkout)
      } finally {
        await holder.close()
        await opened.close()
      }
    }
  )
  await claim(
    'a handoff inside a mixed tool batch ends the run: the admitted sibling read is cancelled unexecuted, Pi spends no request in the old context, and the handoff message tells the model which call was refused and which were cancelled',
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
          /Switching checkouts; the call did not run/,
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
          /^Dev switched checkouts and ended that turn\. .*\. Current checkout: .*\. The blocked call did not run\. Check this checkout before deciding whether to retry\. Other calls of that batch reporting "Operation aborted" or "No result provided" were cancelled before running and may be issued again if still needed\.$/
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
  await claim(
    'with a UI, the first write in a checkout a paused task holds asks once before isolating: continuing runs that call in the same session and checkout for that task, and one message after the results of its batch tells the user and the next model request of the join and of the changed file left by earlier work',
    async () => {
      const paused = await pausedCheckout('ask-continue')
      const script = scripted([
        [
          toolCall('ask-write', 'write', { path: 'asked.txt', content: 'continued\n' }),
          toolCall('ask-bash', 'bash', { command: 'cat draft.txt > seen.txt' }),
        ],
      ])
      const requests: string[] = []
      const model = await makeOfflineModel({
        pi,
        importFromPi,
        fixture,
        id: 'ask-continue',
        stream: parts => {
          const reply = replay(script.next)(parts)
          return (requested, context, options) => {
            requests.push(JSON.stringify(context.messages))
            return reply(requested, context, options)
          }
        },
      })
      const dialog = interactive((_title, options) => options[0])
      const opened = await openLeadHost({
        attachment: paused.attached.effect,
        manager: paused.manager,
        offline: model,
        cwd: paused.checkout,
        ui: dialog.ui,
      })
      try {
        const sessionId = opened.runtime.session.sessionManager.getSessionId()
        await opened.runtime.session.prompt('Write the file and read the draft.')
        await opened.runtime.session.waitForIdle()
        const result = toolResults(opened.runtime)
        assert.equal(result('ask-write').isError, false, result('ask-write').text)
        assert.equal(result('ask-bash').isError, false, result('ask-bash').text)
        assert.equal(readFileSync(join(paused.checkout, 'asked.txt'), 'utf8'), 'continued\n')
        assert.equal(
          readFileSync(join(paused.checkout, 'seen.txt'), 'utf8'),
          'uncommitted work\n',
          'the uncommitted files stayed with the conversation'
        )
        assert.equal(dialog.asked.length, 1, JSON.stringify(dialog.asked))
        assert.match(
          dialog.asked[0]?.title ?? '',
          /^This checkout holds a paused task on feat\/ask-continue \(1 changed file, last used 1m ago\)\. Continue it, or work separately\?$/
        )
        assert.equal(dialog.asked[0]?.options[0], CONTINUE_HERE)
        assert.equal(dialog.asked[0]?.options.length, 2)
        const note = `This conversation now continues task ${paused.taskId} in ${paused.checkout} on feat/ask-continue. The user chose to continue it here. 1 changed file remains from earlier work. Earlier messages are not here.`
        assert.deepEqual(shown(opened.runtime), [note])
        assert.deepEqual(dialog.notices, [], 'the message is the only announcement')
        assert.ok(!requests[0]?.includes(note), 'the request that asked did not know of the join')
        const second = requests[1] ?? ''
        const noteAt = second.indexOf(note)
        assert.equal(second.split(note).length - 1, 1, 'the next request holds the join once')
        for (const call of ['ask-write', 'ask-bash']) {
          const resultAt = second.lastIndexOf(`"toolCallId":"${call}"`)
          assert.ok(resultAt !== -1 && resultAt < noteAt, `the join follows the result of ${call}`)
        }
        assert.ok(!result('ask-write').text.includes(paused.taskId), result('ask-write').text)
        assert.equal(opened.runtime.cwd, paused.checkout)
        assert.equal(opened.runtime.session.sessionManager.getSessionId(), sessionId)
        assert.equal(opened.host.attachment.binding.taskId, paused.taskId)
        assert.equal(opened.host.isParked(), false)
        assert.equal(script.calls(), 2, 'the turn went on after the admitted batch')
        assert.deepEqual(handoffTexts(opened.runtime), [], 'joining records no handoff')
        assert.deepEqual(
          (await lifecycle.inspect({ cwd: paused.checkout })).map(view => view.origin),
          ['pre-existing'],
          'no worktree was allocated'
        )
      } finally {
        await opened.close()
      }
    }
  )
  await claim(
    'a second writer admitted while the question is open waits for the answer: a ! command asks nothing more, runs for the continued task, and the join is announced once',
    async () => {
      const paused = await pausedCheckout('ask-overlap')
      const { offline: model } = await offlineScript('ask-overlap', [
        [toolCall('overlap-write', 'write', { path: 'asked.txt', content: 'continued\n' })],
      ])
      const asked: string[] = []
      let answer: (() => void) | undefined
      const opened = await openLeadHost({
        attachment: paused.attached.effect,
        manager: paused.manager,
        offline: model,
        cwd: paused.checkout,
        ui: {
          select: (title, options) => {
            asked.push(title)
            if (asked.length > 1) return Promise.resolve(options[0])
            return new Promise(resolveChoice => {
              answer = () => resolveChoice(options[0])
            })
          },
          notify: () => undefined,
        },
      })
      try {
        const turn = opened.runtime.session.prompt('Write the file.')
        await waitFor(
          'the question of the tool call',
          () => (asked.length === 1 ? true : undefined),
          IN_MEMORY_POLL
        )
        const command = opened.runtime.session.extensionRunner.emitUserBash({
          type: 'user_bash',
          command: 'true',
          excludeFromContext: false,
          cwd: paused.checkout,
        })
        await sleep(250)
        answer?.()
        const admitted = await command
        if (admitted?.operations === undefined)
          throw new Error(`the ! command was refused: ${admitted?.result?.output}`)
        const ran = await admitted.operations.exec('true', paused.checkout, {
          onData: () => undefined,
        })
        assert.equal(ran.exitCode, 0)
        await turn
        await opened.runtime.session.waitForIdle()
        assert.equal(asked.length, 1, 'one answer admitted both writers')
        assert.equal(opened.host.attachment.binding.taskId, paused.taskId)
        assert.equal(readFileSync(join(paused.checkout, 'asked.txt'), 'utf8'), 'continued\n')
        assert.deepEqual(shown(opened.runtime), [
          `This conversation now continues task ${paused.taskId} in ${paused.checkout} on feat/ask-overlap. The user chose to continue it here. 1 changed file remains from earlier work. Earlier messages are not here.`,
        ])
      } finally {
        await opened.close()
      }
    }
  )
  await claim(
    'working separately ends the turn and moves the lead to an exact-commit worktree as an unasked isolation does; /workspace resume <task-id> is refused while a shell of the conversation is live, then moves it back onto the paused checkout without starting a model turn and records its handoff for the next one, whose write lands there unasked',
    async () => {
      const paused = await pausedCheckout('ask-separate')
      const { offline: model, script } = await offlineScript('ask-separate', [
        [toolCall('separate-write', 'write', { path: 'asked.txt', content: 'held\n' })],
        [
          toolCall('separate-shell', 'bash', {
            command: 'sleep 600 >/dev/null 2>&1 & echo $! > shell.pid',
          }),
        ],
        [{ type: 'text', text: 'isolated' }],
        [toolCall('back-write', 'write', { path: 'back.txt', content: 'back\n' })],
      ])
      const dialog = interactive((_title, options) => options[1])
      const opened = await openLeadHost({
        attachment: paused.attached.effect,
        manager: paused.manager,
        offline: model,
        cwd: paused.checkout,
        ui: dialog.ui,
      })
      let shellPid: number | undefined
      try {
        await opened.runtime.session.prompt('Write the file.')
        await waitFor(
          'the turns after the isolation',
          () => (script.calls() >= 3 ? true : undefined),
          IN_MEMORY_POLL
        )
        await opened.runtime.session.waitForIdle()
        const result = toolResults(opened.runtime)
        assert.equal(dialog.asked.length, 1, JSON.stringify(dialog.asked))
        assert.equal(result('separate-write').isError, true)
        assert.match(
          result('separate-write').text,
          /Switching checkouts; the call did not run.*Another task uses or needs/
        )
        assert.ok(!existsSync(join(paused.checkout, 'asked.txt')), 'the paused checkout was kept')
        const isolated = opened.runtime.cwd
        assert.notEqual(resolve(isolated), resolve(paused.checkout))
        assert.equal(git(['rev-parse', 'HEAD'], isolated), paused.commit)
        assert.ok(!existsSync(join(isolated, 'draft.txt')), 'uncommitted files were not copied')
        assert.notEqual(opened.host.attachment.binding.taskId, paused.taskId)
        assert.equal(handoffTexts(opened.runtime).length, 1)
        assert.equal(result('separate-shell').isError, false, result('separate-shell').text)
        shellPid = Number(readFileSync(join(isolated, 'shell.pid'), 'utf8'))

        await opened.runtime.session.prompt(`/workspace resume ${paused.taskId}`)
        assert.match(
          shown(opened.runtime).at(-1) ?? '',
          /^The conversation was not switched: Cannot be switched while a bash command may still be running here\. Wait for it, or ask the user to stop it; work cancel stops only background runs\./
        )
        assert.equal(opened.runtime.cwd, isolated)
        assert.equal(opened.host.isParked(), false)

        process.kill(shellPid)
        shellPid = undefined
        await waitFor(
          'the resume once the shell is gone',
          async () => {
            await opened.runtime.session.prompt(`/workspace resume ${paused.taskId}`)
            await unparked(opened.host, 'the resume to settle')
            return resolve(opened.runtime.cwd) === resolve(paused.checkout) ? true : undefined
          },
          { attempts: 40, intervalMs: 250 }
        )
        assert.equal(opened.host.attachment.binding.taskId, paused.taskId)
        assert.equal(script.calls(), 3, 'the user-initiated switch started no model turn')
        assert.equal(dialog.asked.length, 1, 'an exact task id selects without a list')
        assert.match(
          handoffTexts(opened.runtime).at(-1) ?? '',
          /^The user chose \/workspace resume\. Using the selected checkout and its files\. Nothing is copied\. Current checkout: .*\.$/
        )

        await opened.runtime.session.prompt('Write the file now.')
        await opened.runtime.session.waitForIdle()
        const back = toolResults(opened.runtime)('back-write')
        assert.equal(back.isError, false, back.text)
        assert.equal(readFileSync(join(paused.checkout, 'back.txt'), 'utf8'), 'back\n')
        assert.equal(dialog.asked.length, 1, 'the resumed task writes its checkout unasked')
      } finally {
        if (shellPid !== undefined) process.kill(shellPid)
        await opened.close()
      }
    }
  )
  await claim(
    'dismissing the question blocks the call, ends the turn before the rest of its batch is asked or run and without another model request, and leaves every record unchanged; the next write asks again',
    async () => {
      const paused = await pausedCheckout('ask-dismiss')
      const { offline: model, script } = await offlineScript('ask-dismiss', [
        [
          toolCall('dismissed-write', 'write', { path: 'asked.txt', content: 'never\n' }),
          toolCall('dismissed-bash', 'bash', { command: 'touch bash.txt' }),
        ],
        [toolCall('asked-again', 'write', { path: 'asked.txt', content: 'second answer\n' })],
      ])
      const answers: (0 | undefined)[] = [undefined, 0]
      const dialog = interactive((_title, options) => {
        const index = answers.shift()
        return index === undefined ? undefined : options[index]
      })
      const before = await lifecycle.inspect({ cwd: paused.checkout })
      const opened = await openLeadHost({
        attachment: paused.attached.effect,
        manager: paused.manager,
        offline: model,
        cwd: paused.checkout,
        ui: dialog.ui,
      })
      try {
        await opened.runtime.session.prompt('Write the file and touch another.')
        await opened.runtime.session.waitForIdle()
        const result = toolResults(opened.runtime)
        assert.equal(dialog.asked.length, 1, 'the batch asked once')
        assert.equal(result('dismissed-write').isError, true)
        assert.equal(
          result('dismissed-write').text,
          'The question about the paused task in this checkout was dismissed, so the operation was not executed and nothing changed. The next write asks again.'
        )
        assert.notEqual(result('dismissed-bash').isError, false, 'the sibling call did not run')
        assert.equal(script.calls(), 1, 'the dismissal ended the turn')
        assert.ok(!existsSync(join(paused.checkout, 'asked.txt')))
        assert.ok(!existsSync(join(paused.checkout, 'bash.txt')))
        assert.equal(opened.runtime.cwd, paused.checkout)
        assert.equal(opened.host.isParked(), false)
        assert.equal(opened.host.attachment.binding.taskId, undefined)
        assert.deepEqual(await lifecycle.inspect({ cwd: paused.checkout }), before)
        assert.deepEqual(handoffTexts(opened.runtime), [])

        await opened.runtime.session.prompt('Write the file after all.')
        await opened.runtime.session.waitForIdle()
        assert.equal(dialog.asked.length, 2, 'the next write asked again')
        const second = toolResults(opened.runtime)('asked-again')
        assert.equal(second.isError, false, second.text)
        assert.equal(readFileSync(join(paused.checkout, 'asked.txt'), 'utf8'), 'second answer\n')
        assert.equal(opened.host.attachment.binding.taskId, paused.taskId)
      } finally {
        await opened.close()
      }
    }
  )
  await claim(
    'without a UI nothing is asked: the first write in a checkout a paused task holds isolates as before',
    async () => {
      const paused = await pausedCheckout('ask-headless')
      const { offline: model, script } = await offlineScript('ask-headless', [
        [toolCall('headless-write', 'write', { path: 'asked.txt', content: 'isolated\n' })],
      ])
      const opened = await openLeadHost({
        attachment: paused.attached.effect,
        manager: paused.manager,
        offline: model,
        cwd: paused.checkout,
      })
      try {
        await opened.runtime.session.prompt('Write the file.')
        await waitFor(
          'the turn after the isolation',
          () => (script.calls() >= 2 ? true : undefined),
          IN_MEMORY_POLL
        )
        await opened.runtime.session.waitForIdle()
        const refused = toolResults(opened.runtime)('headless-write')
        assert.equal(refused.isError, true)
        assert.match(
          refused.text,
          /Switching checkouts; the call did not run.*Another task uses or needs/
        )
        assert.notEqual(resolve(opened.runtime.cwd), resolve(paused.checkout))
        assert.ok(!existsSync(join(paused.checkout, 'asked.txt')))
      } finally {
        await opened.close()
      }
    }
  )
  await claim(
    '/workspace resume lists the paused work of the repository with its branch; dismissing the list changes nothing, and a choice moves the conversation onto it without a model turn',
    async () => {
      const paused = await pausedCheckout('ask-list')
      const { offline: model, script } = await offlineScript('ask-list', [])
      const answers: (0 | undefined)[] = [undefined, 0]
      const dialog = interactive((_title, options) => {
        const index = answers.shift()
        return index === undefined ? undefined : options[index]
      })
      const opened = await openLeadHost({
        attachment: paused.attached.effect,
        manager: paused.manager,
        offline: model,
        cwd: paused.checkout,
        ui: dialog.ui,
      })
      try {
        await opened.runtime.session.prompt('/workspace resume')
        assert.equal(dialog.asked.length, 1)
        assert.equal(dialog.asked[0]?.title, RESUME_LIST)
        assert.deepEqual(dialog.asked[0]?.options, [
          `feat/ask-list · 1m ago · ${paused.checkout} · task ${paused.taskId}`,
        ])
        assert.equal(opened.host.isParked(), false)
        assert.equal(opened.host.attachment.binding.taskId, undefined)
        assert.deepEqual(shown(opened.runtime), [], 'a dismissed list says nothing')

        await opened.runtime.session.prompt('/workspace resume')
        await waitFor(
          'the switch onto the chosen workspace',
          () => (opened.host.attachment.binding.taskId === paused.taskId ? true : undefined),
          IN_MEMORY_POLL
        )
        await unparked(opened.host, 'the resume to settle')
        assert.equal(opened.runtime.cwd, paused.checkout)
        assert.equal(script.calls(), 0, 'no model turn started')
        assert.equal(handoffTexts(opened.runtime).length, 1)

        await opened.runtime.session.prompt(`/workspace resume ${paused.taskId}`)
        assert.equal(
          shown(opened.runtime).at(-1),
          `This conversation already works for task ${paused.taskId} in ${paused.checkout}.`
        )
        await opened.runtime.session.prompt('/workspace resume not-a-task')
        assert.match(shown(opened.runtime).at(-1) ?? '', /^Task must be an exact ID/)
      } finally {
        await opened.close()
      }
    }
  )
  await claim(
    'a /workspace resume cancelled before Pi replaces a conversation that has no message yet leaves that conversation as it was: no session file is written, its first prompt is saved and answered in the same conversation, and a later resume still switches',
    async () => {
      const paused = await pausedCheckout('ask-cancel')
      const { offline: model, script } = await offlineScript('ask-cancel', [
        [{ type: 'text', text: 'answered in place' }],
      ])
      let cancelNext = true
      const dialog = interactive(() => undefined)
      const opened = await openLeadHost({
        attachment: paused.attached.effect,
        manager: paused.manager,
        offline: model,
        cwd: paused.checkout,
        ui: dialog.ui,
        extensions: [
          {
            name: 'test:cancel-switch',
            factory: api => {
              api.on('session_before_switch', () => {
                if (!cancelNext) return undefined
                cancelNext = false
                return { cancel: true }
              })
            },
          },
        ],
      })
      try {
        const { sessionFile, sessionId } = conversationAt(paused.manager)
        assert.ok(!existsSync(sessionFile), 'Pi has not written the conversation yet')
        await opened.runtime.session.prompt(`/workspace resume ${paused.taskId}`)
        await waitFor(
          'the cancelled switch to be reported',
          () =>
            dialog.notices.includes('Checkout switch cancelled. Still using the previous checkout.')
              ? true
              : undefined,
          IN_MEMORY_POLL
        )
        assert.equal(opened.host.isParked(), false)
        assert.equal(opened.host.attachment.binding.taskId, undefined)
        assert.equal(opened.runtime.cwd, paused.checkout)
        assert.ok(!existsSync(sessionFile), 'a cancelled switch wrote no session file')

        await opened.runtime.session.prompt('Answer in place.')
        await opened.runtime.session.waitForIdle()
        assert.equal(script.calls(), 1, 'the prompt reached the model')
        assert.equal(opened.runtime.session.sessionManager.getSessionId(), sessionId)
        const saved = readFileSync(sessionFile, 'utf8')
        assert.ok(saved.includes('Answer in place.') && saved.includes('answered in place'), saved)
        assert.equal(JSON.parse(saved.split('\n')[0] ?? '{}').id, sessionId)

        await opened.runtime.session.prompt(`/workspace resume ${paused.taskId}`)
        await waitFor(
          'the switch once nothing cancels it',
          () => (opened.host.attachment.binding.taskId === paused.taskId ? true : undefined),
          IN_MEMORY_POLL
        )
        await unparked(opened.host, 'the resume to settle')
        assert.equal(opened.runtime.session.sessionManager.getSessionId(), sessionId)
      } finally {
        await opened.close()
      }
    }
  )
  await claim(
    'a conversation with no message yet keeps, across /workspace resume, the entries extensions append while Pi replaces the session: the replacement and a fresh reopen of its file both hold them',
    async () => {
      const paused = await pausedCheckout('ask-entries')
      const { offline: model } = await offlineScript('ask-entries', [])
      const dialog = interactive(() => undefined)
      const opened = await openLeadHost({
        attachment: paused.attached.effect,
        manager: paused.manager,
        offline: model,
        cwd: paused.checkout,
        ui: dialog.ui,
        extensions: [
          {
            name: 'test:lifecycle-entries',
            factory: api => {
              api.on('session_before_switch', () => {
                api.appendEntry('test/lifecycle', { at: 'before-switch' })
              })
              api.on('session_shutdown', event => {
                if (event.reason !== 'quit') api.appendEntry('test/lifecycle', { at: 'shutdown' })
              })
            },
          },
        ],
      })
      try {
        const { sessionFile, sessionId } = conversationAt(paused.manager)
        await opened.runtime.session.prompt(`/workspace resume ${paused.taskId}`)
        await waitFor(
          'the switch onto the paused task',
          () => (opened.host.attachment.binding.taskId === paused.taskId ? true : undefined),
          IN_MEMORY_POLL
        )
        await unparked(opened.host, 'the resume to settle')
        const expected = [{ at: 'before-switch' }, { at: 'shutdown' }]
        assert.equal(opened.runtime.session.sessionManager.getSessionId(), sessionId)
        assert.deepEqual(lifecycleEntries(opened.runtime.session.sessionManager), expected)
        const reopened = pi.SessionManager.open(sessionFile, sessionDir)
        assert.equal(reopened.getSessionId(), sessionId)
        assert.deepEqual(lifecycleEntries(reopened), expected)
      } finally {
        await opened.close()
      }
    }
  )
  await claim(
    'a conversation with no message yet whose file cannot be reopened during /workspace resume fails the switch: the file written for it is removed again, and the session stays parked with the handoff reported unresolved',
    async () => {
      const paused = await pausedCheckout('ask-unwritable')
      const { offline: model } = await offlineScript('ask-unwritable', [])
      const dialog = interactive(() => undefined)
      const { sessionFile } = conversationAt(paused.manager)
      let written = false
      const opened = await openLeadHost({
        attachment: paused.attached.effect,
        manager: paused.manager,
        offline: model,
        cwd: paused.checkout,
        ui: dialog.ui,
        reopening: file => {
          if (resolve(file) !== resolve(sessionFile)) return
          written = existsSync(sessionFile)
          throw new Error('reopen refused by the probe')
        },
      })
      const output = mock.method(process.stderr, 'write')
      const reported = () => output.mock.calls.map(call => String(call.arguments[0])).join('')
      try {
        await opened.runtime.session.prompt(`/workspace resume ${paused.taskId}`)
        await waitFor(
          'the failed switch to be reported',
          () =>
            reported().includes(
              'Dev cannot confirm the switch finished. Checkout access is blocked.'
            )
              ? true
              : undefined,
          IN_MEMORY_POLL
        )
        assert.ok(written, 'the file existed when Pi was asked to reopen it')
        assert.ok(!existsSync(sessionFile), 'the file written for the switch was removed')
        assert.equal(opened.host.isParked(), true)
      } finally {
        output.mock.restore()
        await opened.close()
      }
    }
  )
  await claim(
    '/workspace resume <task-id> for a task retaining several workspaces lists them most recently used first, whatever their identifiers',
    async () => {
      const paused = await pausedCheckout('ask-order')
      const resumeIn = async (workspaceId: WorkspaceId) => {
        await sleep(5)
        const toucher = await lifecycle.attach({
          conversation: conversationAt(pi.SessionManager.create(paused.checkout, sessionDir)),
          cwd: paused.checkout,
          selection: { taskId: paused.taskId, workspaceId },
        })
        assert.equal((await toucher.authorize({ kind: 'write' })).kind, 'ready')
        await toucher.close()
      }
      const checkoutWorkspace = paused.attached.binding.workspaceId
      const owner = await lifecycle.attach({
        conversation: conversationAt(pi.SessionManager.create(paused.checkout, sessionDir)),
        cwd: paused.checkout,
        selection: { taskId: paused.taskId, workspaceId: checkoutWorkspace },
      })
      const child = await owner.authorize({ kind: 'delegated-write' })
      await owner.close()
      if (child.kind !== 'ready') throw new Error('the fixture requires a second workspace')
      assert.equal(child.grant.taskId, paused.taskId)
      const { offline: model } = await offlineScript('ask-order', [])
      const dialog = interactive(() => undefined)
      const opened = await openLeadHost({
        attachment: paused.attached.effect,
        manager: paused.manager,
        offline: model,
        cwd: paused.checkout,
        ui: dialog.ui,
      })
      try {
        const offeredPaths = async () => {
          await opened.runtime.session.prompt(`/workspace resume ${paused.taskId}`)
          return (dialog.asked.at(-1)?.options ?? []).map(option =>
            option.includes(` · ${child.grant.checkout} · `) ? 'worktree' : 'checkout'
          )
        }
        await resumeIn(checkoutWorkspace)
        assert.deepEqual(await offeredPaths(), ['checkout', 'worktree'])
        await resumeIn(child.grant.workspaceId)
        assert.deepEqual(await offeredPaths(), ['worktree', 'checkout'])
        assert.equal(dialog.asked.length, 2)
        assert.ok(dialog.asked.every(question => question.title === RESUME_LIST))
      } finally {
        await opened.close()
      }
    }
  )
  const { script: lead1, offline } = await offlineScript('host-session', [
    [workProcess],
    [
      toolCall('read-after', 'read', { path: 'AGENTS.md' }),
      toolCall('write-after', 'write', { path: 'after.txt', content: 'after the handoff\n' }),
    ],
  ])
  const { manager, attached } = await attachLeadConversation()
  const parking: boolean[] = []
  const opened = await openLeadHost({
    attachment: attached.effect,
    manager,
    offline,
    onParkingChange: () => parking.push(opened.host.isParked()),
  })
  const { host, runtime } = opened
  const result = toolResults(runtime)
  await runtime.session.prompt('Run the tests in the background.')
  await waitFor('the scripted turns', () => (lead1.calls() >= 3 ? true : undefined), IN_MEMORY_POLL)
  await runtime.session.waitForIdle()

  await claim(
    'a work process refused in a checkout another task holds hands its handoff to the host, which moves the lead to an exact-commit managed worktree instead of leaving it parked',
    async () => {
      assert.equal(result('work-process').isError, true)
      assert.match(
        result('work-process').text,
        /^Dev must switch checkouts first: Another task uses or needs the requested checkout/
      )
      assert.notEqual(resolve(runtime.cwd), resolve(lead), 'the lead left the held checkout')
      assert.equal(git(['rev-parse', 'HEAD'], runtime.cwd), leadCommit)
      assert.equal(host.isParked(), false, 'the host completed the switch')
      assert.deepEqual(await pendingAtLead(), [], 'no switch is left pending')
    }
  )
  await claim('the host notifies each time it parks and each time it stops being parked', () => {
    assert.equal(parking[0], true, 'parking for the switch was not notified')
    assert.equal(parking.at(-1), false, 'the completed switch was not notified')
    assert.ok(
      parking.every((state, index) => index === 0 || state !== parking[index - 1]),
      `a notification without a change: ${JSON.stringify(parking)}`
    )
  })
  await claim(
    'the refused work call ends the batch as an error, so Pi makes no request in the old context: the next one reads and writes in the managed worktree',
    () => {
      assert.equal(lead1.calls(), 3, 'no model request was spent in the old context')
      assert.equal(result('read-after').isError, false, result('read-after').text)
      assert.equal(result('write-after').isError, false, result('write-after').text)
      assert.equal(readFileSync(join(runtime.cwd, 'after.txt'), 'utf8'), 'after the handoff\n')
      assert.ok(!existsSync(join(lead, 'after.txt')), 'the held checkout was not written')
    }
  )
  await claim(
    'a fork after the handoff continues in the managed worktree the conversation moved to, not the checkout its copied header names',
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
      `a /${replacement} that starts ${order} a contended work call's admission request withdraws the handoff${withdrawalDelayMs > 0 ? ' even when the withdrawal outlasts the replacement' : ''}: the next session stays usable and the old conversation can be resumed`,
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
          .split('Automatic cleanup when switching conversations')
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
        await unparked(freshHost.host, 'the handoff to finish', { attempts: 80, intervalMs: 100 })
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
        assert.match(receipt, /Automatic cleanup when switching conversations/)
        assert.match(receipt, /close refused by the probe/)
        assert.match(receipt, /Automatic cleanup did not run/)
        await heldHost.runtime.session.prompt('Write another scratch file.')
        await heldHost.runtime.session.waitForIdle()
        assert.equal(toolResults(heldHost.runtime)('held-next').isError, true)
        await unparked(heldHost.host, 'the handoff to finish', { attempts: 80, intervalMs: 100 })
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
