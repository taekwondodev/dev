import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Effect, Schema } from 'effect'
import { COMPACTION_OBSERVATION, CompactionObservation } from '../../src/compaction-observation.ts'
import type * as Pi from '@earendil-works/pi-coding-agent'
import { openWorkFixture } from '../work/work-check-support.ts'
import {
  loadInstalledPi,
  makeOfflineModel,
  openHostRuntime,
  waitFor,
} from './workspace-check-support.ts'

const { pi, packageInfo, importFromPi } = await loadInstalledPi()
const fixture = await openWorkFixture('compaction-pty')
const sessionDir = join(fixture.root, 'sessions')
mkdirSync(sessionDir)
process.env.PI_CODING_AGENT_DIR = fixture.agentDir
writeFileSync(
  join(fixture.agentDir, 'settings.json'),
  JSON.stringify({
    compaction: { reserveTokens: 16384, keepRecentTokens: 64 },
    cacheWarming: 'off',
    quietStartup: true,
    doubleEscapeAction: 'none',
  })
)
const held: { readonly signal?: AbortSignal; finish(): void }[] = []
let ordinaryRequests = 0
let holdOrdinary = false
let escapes = 0
const offline = await makeOfflineModel({
  pi,
  importFromPi,
  fixture: fixture.root,
  id: 'compaction-pty',
  stream: parts => (_model, context, options) => {
    const stream = parts.eventStreams.createAssistantMessageEventStream()
    if (JSON.stringify(context).includes('You are a context summarization assistant.')) {
      held.push({
        signal: options?.signal,
        finish() {
          const message = parts.assistantMessage([{ type: 'text', text: 'LATE-SUMMARY' }], 'stop')
          stream.push({
            type: 'done',
            reason: 'stop',
            message: {
              ...message,
              usage: { ...message.usage, input: 3, output: 1, totalTokens: 4 },
            },
          })
          stream.end()
        },
      })
    } else {
      ordinaryRequests += 1
      if (holdOrdinary)
        options?.signal?.addEventListener(
          'abort',
          () => {
            stream.push({
              type: 'error',
              reason: 'aborted',
              error: parts.assistantMessage([], 'aborted'),
            })
            stream.end()
          },
          { once: true }
        )
      else {
        const message = parts.assistantMessage(
          [{ type: 'text', text: 'Ordinary review response' }],
          'stop'
        )
        stream.push({
          type: 'done',
          reason: 'stop',
          message: { ...message, usage: { ...message.usage, input: 81921, totalTokens: 81921 } },
        })
        stream.end()
      }
    }
    return stream
  },
})
offline.model.contextWindow = 131072
const seed = (manager: Pi.SessionManager) => {
  manager.appendMessage({
    role: 'user',
    content: 'Older review findings. '.repeat(100),
    timestamp: 1,
  })
  const message = offline.assistantMessage([{ type: 'text', text: 'old response' }], 'stop')
  manager.appendMessage({ ...message, usage: { ...message.usage, input: 1, totalTokens: 1 } })
}
const manager = pi.SessionManager.create(fixture.repository, sessionDir)
seed(manager)
const sessionFile = manager.getSessionFile()
assert.ok(sessionFile)
const attachment = await fixture.lifecycle.attach({
  cwd: fixture.repository,
  conversation: { sessionId: manager.getSessionId(), sessionFile, dataHome: fixture.dataHome },
})
const opened = await openHostRuntime({
  coordination: { installationPath: fixture.root, namespacePath: join(fixture.root, 'authority') },
  pi,
  packageRoot: packageInfo.root,
  lifecycle: fixture.lifecycle.effect,
  attachment: attachment.effect,
  dataHome: fixture.dataHome,
  sessionDir,
  agentDir: fixture.agentDir,
  manager,
  cwd: fixture.repository,
  repositoryRoot: () => Effect.succeed(fixture.repository),
  offline,
  extensions: dev => [
    ...dev,
    {
      name: 'probe:escape-observer',
      factory: api => {
        api.on('session_start', (_event, context) => {
          context.ui.onTerminalInput(data => {
            if (data === '\u001b') escapes += 1
          })
        })
      },
    },
  ],
})
const { runtime } = opened
const recent = 'RECENT review findings remain verbatim. '.repeat(20)
const mode = new pi.InteractiveMode(runtime, { initialMessage: recent, startupDiagnostics: [] })
let runFailure: unknown
void mode.run().catch((cause: unknown) => {
  runFailure = cause
})
const summary = (index: number) =>
  waitFor('held preparation', () => held[index], { intervalMs: 10 })
const noCompaction = (sessions: Pi.SessionManager) =>
  assert.equal(
    sessions.getEntries().some(entry => entry.type === 'compaction'),
    false
  )
let closed = false
try {
  const idle = await summary(0)
  await runtime.session.waitForIdle()
  assert.equal(runtime.session.isIdle, true)
  process.stdout.write('\nDEV_COMPACTION_IDLE_ESCAPE\n')
  await waitFor('real idle Escape', () => (escapes >= 1 ? true : undefined), { intervalMs: 10 })
  assert.equal(idle.signal?.aborted, true)
  idle.finish()
  await sleep(80)
  noCompaction(manager)
  assert.equal(held.length, 1)
  assert.equal(ordinaryRequests, 1)

  await runtime.session.prompt(recent)
  const ready = await summary(1)
  holdOrdinary = true
  const active = runtime.session.prompt('Continue while the summary is ready.')
  await waitFor('active streamed response', () => (ordinaryRequests === 3 ? true : undefined), {
    intervalMs: 10,
  })
  const readyIndex = held.length
  ready.finish()
  await sleep(50)
  if (held.length > readyIndex) {
    const split = held[readyIndex]
    assert.ok(split)
    assert.equal(
      split.signal,
      ready.signal,
      'the second request belongs to the same split-turn preparation'
    )
    split.finish()
    await sleep(50)
  }
  const readyRequests = held.length
  noCompaction(manager)
  process.stdout.write('\nDEV_COMPACTION_READY_ESCAPE\n')
  await waitFor('real streaming Escape', () => (escapes >= 2 ? true : undefined), {
    intervalMs: 10,
  })
  await active
  await runtime.session.waitForIdle()
  await sleep(80)
  noCompaction(manager)
  assert.equal(held.length, readyRequests)
  assert.equal(ordinaryRequests, 3)

  holdOrdinary = false
  const reloadIndex = held.length
  await runtime.session.prompt(recent)
  const reloading = await summary(reloadIndex)
  await runtime.session.reload()
  assert.equal(reloading.signal?.aborted, true)
  reloading.finish()
  await sleep(80)
  noCompaction(manager)
  assert.equal(held.length, reloadIndex + 1)

  const replacementIndex = held.length
  await runtime.session.prompt(recent)
  const replacing = await summary(replacementIndex)
  await runtime.newSession()
  assert.equal(replacing.signal?.aborted, true)
  replacing.finish()
  await sleep(80)
  noCompaction(manager)
  noCompaction(runtime.session.sessionManager)
  assert.equal(held.length, replacementIndex + 1)

  const shutdownIndex = held.length
  seed(runtime.session.sessionManager)
  runtime.session.refreshContext()
  await runtime.session.prompt(recent)
  const shuttingDown = await summary(shutdownIndex)
  const finalManager = runtime.session.sessionManager
  mode.stop('transcript')
  await opened.close()
  closed = true
  assert.equal(shuttingDown.signal?.aborted, true)
  shuttingDown.finish()
  await sleep(80)
  noCompaction(finalManager)
  assert.equal(held.length, shutdownIndex + 1)
  assert.equal(ordinaryRequests, 6)
  assert.equal(runFailure, undefined)
  const stored = [...manager.getEntries(), ...finalManager.getEntries()]
  const observations = stored.flatMap(entry =>
    entry.type === 'custom' && entry.customType === COMPACTION_OBSERVATION
      ? [Schema.decodeUnknownSync(CompactionObservation)(entry.data)]
      : []
  )
  const starts = observations.filter(event => event.kind === 'background-started')
  const ends = observations.filter(event => event.kind === 'background-ended')
  assert.equal(starts.length, 5)
  assert.equal(ends.length, 5)
  assert.deepEqual(
    ends.map(event => event.outcome),
    [
      { kind: 'discarded', reason: 'escape' },
      { kind: 'discarded', reason: 'escape' },
      { kind: 'discarded', reason: 'reload' },
      { kind: 'discarded', reason: 'abort' },
      { kind: 'discarded', reason: 'shutdown' },
    ]
  )
  assert.equal(observations.filter(event => event.kind === 'attached').length, 2)
  assert.equal(observations.filter(event => event.kind === 'detached').length, 2)
  const usage = stored.filter(entry => entry.type === 'usage')
  assert.equal(usage.length, held.length)
  assert.equal(
    usage.reduce((sum, entry) => sum + entry.usage.totalTokens, 0),
    held.length * 4
  )
  assert.ok(usage.every(entry => starts.some(start => start.id === entry.note)))
  process.stdout.write(
    `\nDEV_COMPACTION_PTY_PASSED ${JSON.stringify({ idleEscape: true, readyStreamingEscape: true, reload: true, replacement: true, shutdown: true, preparations: starts.length, profiledDiscards: ends.length, observedSummaryTokens: held.length * 4, summaryRequests: held.length, ordinaryRequests })}\n`
  )
} finally {
  if (!closed) {
    mode.stop('transcript')
    await opened.close()
  }
  await fixture.close()
}
