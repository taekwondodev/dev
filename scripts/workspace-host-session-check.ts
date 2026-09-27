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
import type * as Pi from '@earendil-works/pi-coding-agent'
import { Effect } from 'effect'
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
git(['config', 'user.email', 'host-session@example.invalid'])
git(['config', 'user.name', 'host session check'])
writeFileSync(join(lead, 'AGENTS.md'), 'host session check\n')
git(['add', 'AGENTS.md'])
git(['commit', '--quiet', '-m', 'host session fixture'])
const leadCommit = git(['rev-parse', 'HEAD'])
const repositoryRoot = (cwd: string) => Effect.succeed(git(['rev-parse', '--show-toplevel'], cwd))

// Each runtime replays its own steps and then answers with text.
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
    'importing a stored conversation that another dev session keeps live is cancelled before Pi tears the current session down',
    async () => {
      const held = storedConversation(offline, lead)
      const holder = await openLifecycle({ root: join(fixture, 'authority') })
      const holding = await holder.attach({ conversation: conversationAt(held.manager), cwd: lead })
      try {
        const current = runtime.session.sessionManager.getSessionId()
        assert.deepEqual(await runtime.importFromJsonl(held.file), { cancelled: true })
        assert.equal(runtime.session.sessionManager.getSessionId(), current)
        assert.equal(host.isParked(), false, 'a refused import leaves the host usable')
      } finally {
        await holding.close()
        await holder.close()
      }
    }
  )
  await opened.close()
} finally {
  await squatter.close()
  await lifecycle.close()
  rmSync(fixture, { recursive: true, force: true })
}

console.log(JSON.stringify({ result: 'passed', checks: passed }, null, 2))
