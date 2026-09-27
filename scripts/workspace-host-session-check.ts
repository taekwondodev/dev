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
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type * as Pi from '@earendil-works/pi-coding-agent'
import { NodeServices } from '@effect/platform-node'
import { Effect, Exit, Scope } from 'effect'
import { makeRuntimeFactory } from '../src/launcher.ts'
import { getProfile } from '../src/profiles.ts'
import { acquireRuntime } from '../src/runtime-coordination.ts'
import { createSessionGuard } from '../src/session-guard.ts'
import { makeWorkspaceHost } from '../src/workspace-host.ts'
import { loadInstalledPi, makeClaims } from './workspace-check-support.ts'
import { openLifecycle } from './workspace-test-lifecycle.ts'

interface AssistantEventStream {
  push(event: unknown): void
  end(): void
}
interface EventStreamModule {
  createAssistantMessageEventStream(): AssistantEventStream
}
type SessionModel = NonNullable<
  Parameters<(typeof Pi)['createAgentSessionFromServices']>[0]['model']
>

const { pi, packageInfo, importFromPi } = await loadInstalledPi()
const eventStreamModule = await importFromPi<EventStreamModule>(
  'node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js'
)
const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'dev-workspace-host-session-')))
const lead = join(fixture, 'lead')
const sessionDir = join(fixture, 'sessions')
const agentDir = join(fixture, 'agent')
const dataHome = join(fixture, 'data')
for (const path of [lead, sessionDir, agentDir, join(fixture, 'home', '.agents', 'skills')])
  mkdirSync(path, { recursive: true })
mkdirSync(dataHome, { mode: 0o700 })
process.env.HOME = join(fixture, 'home')
process.env.PI_CODING_AGENT_DIR = agentDir
process.env.PI_OFFLINE = '1'
process.env.PI_TELEMETRY_DISABLED = '1'
const git = (args: readonly string[], cwd = lead) =>
  execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()
git(['init', '--quiet', '-b', 'main'])
git(['config', 'user.email', 'work-rebind@example.invalid'])
git(['config', 'user.name', 'work rebind check'])
writeFileSync(join(lead, 'AGENTS.md'), 'work rebind check\n')
git(['add', 'AGENTS.md'])
git(['commit', '--quiet', '-m', 'work rebind fixture'])
const leadCommit = git(['rev-parse', 'HEAD'])

const offlineModel: SessionModel = {
  id: 'work-rebind',
  name: 'Offline work rebind check',
  api: 'openai-completions',
  provider: 'work-rebind-offline',
  baseUrl: 'http://127.0.0.1:9/v1',
  reasoning: false,
  input: ['text'],
  contextWindow: 200000,
  maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}
const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({
  type: 'toolCall',
  id,
  name,
  arguments: args,
})
const script: readonly (readonly unknown[])[] = [
  [toolCall('work-process', 'work', { action: 'process', taskId: 'tests', command: 'true' })],
  [toolCall('stale-read', 'read', { path: 'AGENTS.md' })],
  [
    toolCall('read-after', 'read', { path: 'AGENTS.md' }),
    toolCall('write-after', 'write', { path: 'after.txt', content: 'after the rebind\n' }),
  ],
  [{ type: 'text', text: 'done' }],
]
let providerCall = 0
const modelRuntime = await pi.ModelRuntime.create({
  authPath: join(fixture, 'never-auth.json'),
  modelsPath: join(fixture, 'never-models.json'),
  allowModelNetwork: false,
  refreshOnCreate: false,
})
modelRuntime.registerProvider(offlineModel.provider, {
  name: offlineModel.name,
  api: offlineModel.api,
  baseUrl: offlineModel.baseUrl,
  apiKey: 'offline',
  authHeader: false,
  models: [{ ...offlineModel }],
  streamSimple: (() => {
    const content = script[Math.min(providerCall, script.length - 1)] ?? []
    providerCall += 1
    const stream = eventStreamModule.createAssistantMessageEventStream()
    const stopReason = content.some(
      part => typeof part === 'object' && part !== null && 'id' in part
    )
      ? 'toolUse'
      : 'stop'
    const message = {
      role: 'assistant',
      content,
      api: offlineModel.api,
      provider: offlineModel.provider,
      model: offlineModel.id,
      stopReason,
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    }
    setTimeout(() => {
      stream.push({ type: 'done', reason: stopReason, message })
      stream.end()
    }, 10)
    return stream
  }) as never,
})

const { claim, passed } = makeClaims()
const lifecycle = await openLifecycle({ root: join(fixture, 'authority') })
const squatterFile = join(dataHome, 'squatter.jsonl')
writeFileSync(squatterFile, '{}\n', { mode: 0o600 })
const squatter = await lifecycle.attach({
  conversation: { sessionId: 'work-rebind-squatter', sessionFile: squatterFile, dataHome },
  cwd: lead,
})
assert.equal((await squatter.authorize({ kind: 'write' })).kind, 'ready')

const manager = pi.SessionManager.create(lead, sessionDir)
const sessionFile = manager.getSessionFile()
if (sessionFile === undefined) throw new Error('Pi did not name the session file')
const attachment = await lifecycle.attach({
  conversation: { sessionId: manager.getSessionId(), sessionFile, dataHome },
  cwd: lead,
})
const hostScope = Scope.makeUnsafe()
try {
  const host = await Effect.runPromise(
    Scope.provide(hostScope)(
      makeWorkspaceHost({
        lifecycle: lifecycle.effect,
        attachment: attachment.effect,
        dataHome,
        openSessionManager: (file, cwd) => pi.SessionManager.open(file, sessionDir, cwd),
        repositoryRoot: cwd => Effect.succeed(git(['rev-parse', '--show-toplevel'], cwd)),
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
        lifecycle: lifecycle.effect,
        modelRuntime: Effect.succeed(modelRuntime),
        model: offlineModel,
      })
    }).pipe(Effect.provide(NodeServices.layer))
  )
  const runtime = await pi.createAgentSessionRuntime(runtimeFactory, {
    cwd: lead,
    agentDir,
    sessionManager: manager,
  })
  host.bindRuntime(runtime)
  guard.bind(runtime)
  const result = (toolCallId: string) =>
    runtime.session.sessionManager
      .getEntries()
      .flatMap(entry =>
        entry.type === 'message' && entry.message.role === 'toolResult' ? [entry.message] : []
      )
      .find(message => message.toolCallId === toolCallId)
  const text = (toolCallId: string) =>
    (result(toolCallId)?.content ?? [])
      .flatMap(part => (part.type === 'text' ? [part.text] : []))
      .join('\n')

  await runtime.session.prompt('Run the tests in the background.')
  for (let attempt = 0; attempt < 120 && providerCall < script.length; attempt += 1)
    await sleep(250)
  await runtime.session.waitForIdle()

  await claim(
    'a work process refused in a checkout another task holds hands its rebind to the host, which moves the lead to an exact-commit managed worktree instead of leaving it parked',
    async () => {
      assert.equal(result('work-process')?.isError, true)
      assert.match(
        text('work-process'),
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
    'the one request Pi still makes in the old context is fenced, and after the rebind the lead reads and writes in the managed worktree',
    () => {
      assert.equal(result('stale-read')?.isError, true)
      assert.equal(text('stale-read'), 'Workspace host is parked; stale tools are blocked.')
      assert.equal(result('read-after')?.isError, false, text('read-after'))
      assert.equal(result('write-after')?.isError, false, text('write-after'))
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
    'importing a stored conversation that another dev session keeps live is cancelled before Pi tears the current session down',
    async () => {
      const heldManager = pi.SessionManager.create(lead, sessionDir)
      heldManager.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'held conversation' }],
        api: offlineModel.api,
        provider: offlineModel.provider,
        model: offlineModel.id,
        stopReason: 'stop',
        timestamp: Date.now(),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      })
      const heldFile = heldManager.getSessionFile()
      if (heldFile === undefined) throw new Error('Pi did not persist the held conversation')
      const holder = await openLifecycle({ root: join(fixture, 'authority') })
      const held = await holder.attach({
        conversation: { sessionId: heldManager.getSessionId(), sessionFile: heldFile, dataHome },
        cwd: lead,
      })
      try {
        const current = runtime.session.sessionManager.getSessionId()
        assert.deepEqual(await runtime.importFromJsonl(heldFile), { cancelled: true })
        assert.equal(runtime.session.sessionManager.getSessionId(), current)
        assert.equal(host.isParked(), false, 'a refused import leaves the host usable')
      } finally {
        await held.close()
        await holder.close()
      }
    }
  )
  await runtime.dispose()
} finally {
  await Effect.runPromise(Scope.close(hostScope, Exit.void))
  await squatter.close()
  await lifecycle.close()
  rmSync(fixture, { recursive: true, force: true })
}

console.log(JSON.stringify({ result: 'passed', checks: passed }, null, 2))
