import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Effect, Schema } from 'effect'
import type * as Pi from '@earendil-works/pi-coding-agent'
import { createBackgroundCompaction } from '../src/background-compaction.ts'
import { COMPACTION_OBSERVATION, CompactionObservation } from '../src/compaction-observation.ts'

import {
  loadInstalledPi,
  deferred,
  makeClaims,
  makeOfflineModel,
  waitFor,
  type ScriptedStreamParts,
  type StreamSimple,
} from './workspace/workspace-check-support.ts'

const decodeObservation = Schema.decodeUnknownSync(CompactionObservation)
const { pi, packageInfo, importFromPi } = await loadInstalledPi()
const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'dev-compaction-')))
const agentDir = join(fixture, 'agent')
mkdirSync(agentDir)
process.env.PI_CODING_AGENT_DIR = agentDir
process.env.PI_OFFLINE = '1'
process.env.PI_TELEMETRY_DISABLED = '1'
const { claim, passed } = makeClaims()
type Message = ReturnType<ScriptedStreamParts['assistantMessage']>
type RequestContext = Parameters<StreamSimple>[1]
type RequestOptions = Parameters<StreamSimple>[2]
interface HeldRequest {
  readonly context: RequestContext
  readonly options: RequestOptions
  finish(input?: number, output?: number, text?: string, error?: string, cost?: number): void
}
const usage = (message: Message, input: number, output = 0): Message => ({
  ...message,
  usage: { ...message.usage, input, output, totalTokens: input + output },
})
const textOf = (context: RequestContext) => JSON.stringify(context)
const isSummary = (context: RequestContext) =>
  textOf(context).includes('You are a context summarization assistant.')
const messageText = (
  content: Extract<Pi.AgentSession['messages'][number], { role: 'user' }>['content']
) =>
  typeof content === 'string'
    ? content
    : content.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('')
const recent = 'RECENT-MUST-STAY '.repeat(40)
let sequence = 0

const open = async (
  options: {
    readonly tokens?: number
    readonly enabled?: boolean
    readonly retry?: {
      enabled: boolean
      maxRetries: number
      baseDelayMs: number
      maxAgentDelayMs: number
    }
    readonly keepRecentTokens?: number
    readonly extensions?: readonly Pi.ExtensionFactory[]
    readonly before?: Pi.ExtensionFactory
    readonly files?: boolean
    readonly modelBudgets?: { readonly reserveTokens: number; readonly keepRecentTokens: number }
  } = {}
) => {
  const summaries: HeldRequest[] = []
  const ordinary: HeldRequest[] = []
  let holdOrdinary = false
  let tokens = options.tokens ?? 81921
  const offline = await makeOfflineModel({
    pi,
    importFromPi,
    fixture,
    id: `compaction-${++sequence}`,
    stream: parts => (_model, context, requestOptions) => {
      const stream = parts.eventStreams.createAssistantMessageEventStream()
      const request: HeldRequest = {
        context,
        options: requestOptions,
        finish(input = 10, output = 2, text = 'NATIVE-SUMMARY', error, cost = 0) {
          const metered = usage(
            parts.assistantMessage([{ type: 'text', text }], error ? 'error' : 'stop'),
            input,
            output
          )
          const message = {
            ...metered,
            usage: { ...metered.usage, cost: { ...metered.usage.cost, total: cost } },
          }
          if (error)
            stream.push({
              type: 'error',
              reason: 'error',
              error: { ...message, errorMessage: error },
            })
          else stream.push({ type: 'done', reason: 'stop', message })
          stream.end()
        },
      }
      if (isSummary(context)) summaries.push(request)
      else {
        ordinary.push(request)
        if (!holdOrdinary) request.finish(tokens, 0, `ordinary-${ordinary.length}`)
      }
      return stream
    },
  })
  offline.model.contextWindow = 131072
  const manager = pi.SessionManager.inMemory(fixture)
  const oldId = manager.appendMessage({
    role: 'user',
    content: 'OLD-PREFIX '.repeat(300),
    timestamp: 1,
  })
  manager.appendMessage(
    usage(offline.assistantMessage([{ type: 'text', text: 'old answer' }], 'stop'), 1)
  )
  if (options.files) {
    manager.appendMessage(
      offline.assistantMessage(
        [{ type: 'toolCall', id: 'old-read', name: 'read', arguments: { path: 'tracked.ts' } }],
        'toolUse'
      )
    )
    manager.appendMessage({
      role: 'toolResult',
      toolCallId: 'old-read',
      toolName: 'read',
      content: [{ type: 'text', text: 'file content' }],
      isError: false,
      timestamp: 2,
    })
  }
  const settingsManager = pi.SettingsManager.inMemory({
    compaction: {
      enabled: options.enabled ?? true,
      reserveTokens: 16384,
      keepRecentTokens: options.keepRecentTokens ?? 64,
      ...(options.modelBudgets
        ? {
            modelOverrides: {
              [`${offline.model.provider}/${offline.model.id}`]: options.modelBudgets,
            },
          }
        : {}),
    },
    retry: { enabled: false, maxRetries: 0, ...options.retry, provider: { maxRetries: 0 } },
    cacheWarming: 'off',
  })
  const background = await Effect.runPromise(createBackgroundCompaction(pi, packageInfo.root))
  const reasons: string[] = []
  const services = await pi.createAgentSessionServices({
    cwd: fixture,
    agentDir,
    modelRuntime: offline.modelRuntime,
    settingsManager,
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [
        ...(options.before ? [options.before] : []),
        background.factory,
        api => {
          api.on('session_before_compact', event => {
            reasons.push(event.reason)
          })
        },
        ...(options.extensions ?? []),
      ],
    },
  })
  const { session } = await pi.createAgentSessionFromServices({
    services,
    sessionManager: manager,
    model: offline.model,
    tools: [],
  })
  background.bindSession(session)
  await session.bindExtensions({ mode: 'json' })
  const runtime = new pi.AgentSessionRuntime(session, services, async () => {
    throw new Error('This native-session fixture does not replace sessions')
  })
  const summary = (index = 0) =>
    waitFor('summary request', () => summaries[index], { intervalMs: 5 })
  const compactions = () => manager.getEntries().filter(entry => entry.type === 'compaction')
  const applied = () => waitFor('applied compaction', () => compactions().at(-1), { intervalMs: 5 })
  const start = () => session.prompt(recent)
  return {
    ...offline,
    session,
    runtime,
    manager,
    settingsManager,
    summaries,
    ordinary,
    reasons,
    oldId,
    summary,
    compactions,
    observations: () =>
      manager
        .getEntries()
        .flatMap(entry =>
          entry.type === 'custom' && entry.customType === COMPACTION_OBSERVATION
            ? [decodeObservation(entry.data)]
            : []
        ),
    applied,
    start,
    hold: () => {
      holdOrdinary = true
    },
    tokens: (value: number) => {
      tokens = value
    },
    async close() {
      await runtime.dispose()
    },
  }
}

try {
  await claim(
    'advance eligibility is strict and respects disabled compaction and a missing cut',
    async () => {
      for (const options of [
        { tokens: 81920 },
        { enabled: false },
        { keepRecentTokens: 1000000 },
      ]) {
        const rig = await open(options)
        try {
          await rig.start()
          await sleep(20)
          assert.equal(rig.summaries.length, 0)
          assert.equal(rig.compactions().length, 0)
          assert.equal(rig.observations().filter(event => event.kind === 'attached').length, 1)
          assert.equal(
            rig.observations().filter(event => event.kind === 'background-started').length,
            0
          )
        } finally {
          await rig.close()
        }
      }
    }
  )

  await claim(
    'idle completion applies without another request, preserves the recent and concurrent suffix and raw history, and counts usage once',
    async () => {
      const rig = await open()
      try {
        await rig.start()
        const request = await rig.summary()
        assert.equal(rig.session.isIdle, true)
        const recentEntry = rig.manager
          .getBranch()
          .find(
            entry =>
              entry.type === 'message' &&
              entry.message.role === 'user' &&
              messageText(entry.message.content) === recent
          )
        assert.ok(recentEntry)
        const concurrent = {
          role: 'user' as const,
          content: 'ARRIVED-DURING-PREPARATION',
          timestamp: 2,
        }
        rig.manager.appendMessage(concurrent)
        rig.session.refreshContext()
        const before = rig.session.getSessionStats().tokens.total
        request.finish()
        const compacted = await rig.applied()
        assert.equal(compacted.firstKeptEntryId, recentEntry.id)
        const observations = rig.observations()
        const started = observations.find(event => event.kind === 'background-started')
        const ready = observations.find(event => event.kind === 'background-ready')
        const ended = observations.filter(event => event.kind === 'background-ended')
        assert.ok(started && ready)
        assert.equal(ended.length, 1)
        assert.deepEqual(ended[0]?.outcome, {
          kind: 'applied',
          placement: 'idle',
          entryId: compacted.id,
        })
        assert.equal(ready.id, started.id)
        assert.equal(ended[0]?.id, started.id)
        assert.ok(ready.preparationMs >= ready.activeRunOverlapMs)
        assert.equal(ended[0]?.activeRunOverlapMs, ready.activeRunOverlapMs)
        assert.ok(!textOf(request.context).includes(COMPACTION_OBSERVATION))
        assert.ok(!JSON.stringify(rig.session.messages).includes(started.id))
        assert.equal(
          rig.manager.getEntries().find(entry => entry.type === 'usage')?.note,
          started.id
        )
        assert.equal(
          rig.manager
            .getEntries()
            .filter(entry => entry.type === 'usage')
            .reduce((sum, entry) => sum + entry.usage.totalTokens, 0),
          12
        )
        assert.equal(rig.session.getSessionStats().tokens.total - before, 12)
        assert.deepEqual(
          rig.session.messages
            .filter(message => message.role === 'user')
            .map(message => messageText(message.content)),
          [recent, concurrent.content]
        )
        assert.deepEqual(rig.manager.getEntry(rig.oldId)?.type, 'message')
        assert.equal(rig.ordinary.length, 1)
        assert.equal(rig.summaries.length, 1)
        assert.equal(rig.session.isIdle, true)
        await sleep(20)
        assert.equal(rig.session.getSessionStats().tokens.total - before, 12)
      } finally {
        await rig.close()
      }
    }
  )

  await claim(
    'a ready result waits during streaming, applies at the first turn boundary and recomputes tokensBefore',
    async () => {
      const boundaries: string[] = []
      const rig = await open({
        before: api => {
          api.on('turn_end', event => ({
            entries: [
              ...event.entries,
              { type: 'custom', customType: 'other-boundary', data: { preserved: true } },
            ],
          }))
        },
        extensions: [
          api => {
            api.on('turn_end', event => {
              if (event.entries.some(entry => entry.type === 'compaction'))
                boundaries.push('turn_end')
            })
            api.on('agent_before_settle', event => {
              if (event.entries.some(entry => entry.type === 'compaction'))
                boundaries.push('settle')
            })
          },
        ],
      })
      try {
        await rig.start()
        const request = await rig.summary()
        rig.hold()
        const prompt = rig.session.prompt('CONCURRENT-TURN')
        const active = await waitFor('streaming request', () => rig.ordinary[1], { intervalMs: 5 })
        request.finish()
        await sleep(20)
        assert.equal(rig.compactions().length, 0)
        active.finish(81930, 0, 'concurrent-result')
        await prompt
        const compacted = await rig.applied()
        assert.equal(compacted.tokensBefore, 81930)
        assert.deepEqual(boundaries, ['turn_end'])
        const outcome = rig.observations().find(event => event.kind === 'background-ended')
        assert.deepEqual(outcome?.outcome, {
          kind: 'applied',
          placement: 'boundary',
          entryId: compacted.id,
        })
        const ready = rig.observations().find(event => event.kind === 'background-ready')
        assert.ok(ready && outcome && outcome.elapsedMs >= ready.preparationMs)
        assert.ok(ready.activeRunOverlapMs > 0)
        assert.equal(outcome.activeRunOverlapMs, ready.activeRunOverlapMs)
        assert.equal(
          rig.manager
            .getEntries()
            .filter(entry => entry.type === 'custom' && entry.customType === 'other-boundary')
            .length,
          2
        )
        assert.equal(rig.ordinary.length, 2)
        assert.equal(rig.summaries.length, 1)
        assert.ok(
          rig.session.messages.some(
            message =>
              message.role === 'assistant' &&
              JSON.stringify(message.content).includes('concurrent-result')
          )
        )
        const next = rig.session.prompt('Use the compacted context')
        const final = await waitFor('post-compaction request', () => rig.ordinary[2], {
          intervalMs: 5,
        })
        assert.ok(textOf(final.context).includes('concurrent-result'))
        assert.ok(textOf(final.context).includes('NATIVE-SUMMARY'))
        assert.ok(!textOf(final.context).includes('OLD-PREFIX'))
        final.finish(100, 0)
        await next
        assert.equal(rig.ordinary.length, 3)
        assert.equal(rig.compactions().length, 1)
      } finally {
        await rig.close()
      }
    }
  )

  await claim(
    'abort discards running and ready results without late application or restart, retaining observed discarded usage',
    async () => {
      for (const ready of [false, true]) {
        const rig = await open()
        try {
          await rig.start()
          const request = await rig.summary()
          let prompt: Promise<void> | undefined
          let active: HeldRequest | undefined
          if (ready) {
            rig.hold()
            prompt = rig.session.prompt('still-working')
            active = await waitFor('held ordinary turn', () => rig.ordinary[1], { intervalMs: 5 })
            request.finish(3, 1)
            await sleep(20)
          }
          const before = rig.session.getSessionStats().tokens.total
          const abort = rig.session.abort()
          active?.finish(0, 0, 'late ordinary')
          await abort
          await prompt
          if (!ready) request.finish(3, 1)
          await sleep(30)
          assert.equal(rig.compactions().length, 0)
          assert.equal(rig.summaries.length, 1)
          const discarded = rig.manager.getEntries().filter(entry => entry.type === 'usage')
          assert.equal(
            discarded.reduce((sum, entry) => sum + entry.usage.totalTokens, 0),
            4
          )
          if (!ready) assert.equal(rig.session.getSessionStats().tokens.total - before, 4)
          const outcomes = rig.observations().filter(event => event.kind === 'background-ended')
          assert.equal(outcomes.length, 1)
          assert.deepEqual(outcomes[0]?.outcome, { kind: 'discarded', reason: 'abort' })
          assert.equal(discarded[0]?.note, outcomes[0]?.id)
        } finally {
          await rig.close()
        }
      }
    }
  )

  await claim(
    'branch changes, prefix edits and newer compactions invalidate in-flight summaries without resurrecting old context',
    async () => {
      for (const change of ['branch', 'edit', 'compaction'] as const) {
        const rig = await open()
        try {
          await rig.start()
          const request = await rig.summary()
          if (change === 'branch') rig.manager.branch(rig.oldId)
          else if (change === 'edit') rig.manager.appendContextEdit(rig.oldId, null)
          else {
            const kept = rig.manager.getLeafId()
            assert.ok(kept)
            rig.manager.appendCompaction('NEWER', kept, 81921)
          }
          rig.session.refreshContext()
          request.finish(3, 1, 'STALE-SUMMARY')
          await sleep(30)
          assert.equal(
            rig.compactions().some(entry => entry.summary.includes('STALE-SUMMARY')),
            false
          )
          assert.equal(rig.summaries.length, 1)
          if (change === 'edit')
            assert.equal(JSON.stringify(rig.session.messages).includes('OLD-PREFIX'), false)
          if (change === 'compaction')
            assert.ok(
              rig.session.messages.some(
                message => message.role === 'compactionSummary' && message.summary === 'NEWER'
              )
            )
          assert.equal(
            rig.manager
              .getEntries()
              .filter(entry => entry.type === 'usage')
              .reduce((sum, entry) => sum + entry.usage.totalTokens, 0),
            4
          )
        } finally {
          await rig.close()
        }
      }
    }
  )

  await claim(
    'native threshold takes precedence and manual compaction retains custom instructions',
    async () => {
      for (const manual of [false, true]) {
        const rig = await open({ tokens: manual ? 81921 : 114689 })
        try {
          const started = rig.start()
          if (manual) await started
          const pending = manual ? await rig.summary() : undefined
          const operation = manual ? rig.session.compact('PRESERVE-THIS-INSTRUCTION') : started
          const native = await rig.summary(manual ? 1 : 0)
          assert.deepEqual(rig.reasons, [manual ? 'manual' : 'threshold'])
          assert.deepEqual(
            rig
              .observations()
              .filter(event => event.kind === 'native-started')
              .map(event => event.reason),
            [manual ? 'manual' : 'threshold']
          )
          if (manual) {
            assert.ok(textOf(native.context).includes('PRESERVE-THIS-INSTRUCTION'))
            assert.equal(pending?.options?.signal?.aborted, true)
          }
          native.finish(10, 2, 'NATIVE-FALLBACK')
          await operation
          const span = rig.observations().find(event => event.kind === 'native-ended')
          assert.equal(span?.outcome, 'completed')
          assert.ok(span && span.elapsedMs >= 0)
          pending?.finish(3, 1, 'SUPERSEDED')
          await sleep(20)
          assert.equal(
            rig.compactions().filter(entry => entry.summary.includes('NATIVE-FALLBACK')).length,
            1
          )
          assert.equal(
            rig.compactions().some(entry => entry.summary.includes('SUPERSEDED')),
            false
          )
        } finally {
          await rig.close()
        }
      }
    }
  )

  await claim(
    'native overflow recovery supersedes preparation, keeps its omission edits and retries the ordinary request',
    async () => {
      const rig = await open()
      try {
        await rig.start()
        const background = await rig.summary()
        rig.hold()
        const prompt = rig.session.prompt('overflow attempt')
        const failing = await waitFor('ordinary overflow request', () => rig.ordinary[1], {
          intervalMs: 5,
        })
        failing.finish(0, 0, '', 'maximum context length is 131072 tokens')
        const native = await rig.summary(1)
        assert.deepEqual(rig.reasons, ['overflow'])
        assert.equal(background.options?.signal?.aborted, true)
        native.finish(10, 2, 'OVERFLOW-RECOVERY')
        const retry = await waitFor('native recovery retry', () => rig.ordinary[2], {
          intervalMs: 5,
        })
        retry.finish(100, 0, 'recovered')
        await prompt
        background.finish(3, 1, 'OBSOLETE')
        await sleep(20)
        assert.ok(rig.manager.getEntries().some(entry => entry.type === 'context_edit'))
        assert.equal(rig.compactions().length, 1)
        assert.ok(rig.compactions()[0]?.summary.includes('OVERFLOW-RECOVERY'))
        assert.equal(rig.ordinary.length, 3)
        assert.equal(
          rig.observations().find(event => event.kind === 'native-started')?.reason,
          'overflow'
        )
        assert.equal(
          rig.observations().find(event => event.kind === 'native-ended')?.outcome,
          'completed'
        )
      } finally {
        await rig.close()
      }
    }
  )

  await claim(
    'resolved native retry policy applies to preparation and observed retry usage totals 16 exactly once',
    async () => {
      const rig = await open({
        retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 1 },
      })
      try {
        await rig.start()
        const failed = await rig.summary()
        failed.finish(3, 1, '', 'terminated')
        const retry = await rig.summary(1)
        retry.finish(10, 2)
        await rig.applied()
        assert.equal(rig.summaries.length, 2)
        assert.equal(rig.compactions().length, 1)
        const started = rig.observations().filter(event => event.kind === 'background-started')
        assert.equal(started.length, 1)
        assert.equal(
          rig.observations().filter(event => event.kind === 'background-ended').length,
          1
        )
        const observedUsage = rig.manager.getEntries().filter(entry => entry.type === 'usage')
        assert.equal(observedUsage.length, 2)
        assert.deepEqual(
          observedUsage.map(entry => entry.note),
          [started[0]?.id, started[0]?.id]
        )
        assert.equal(
          rig.manager
            .getEntries()
            .filter(entry => entry.type === 'usage')
            .reduce((sum, entry) => sum + entry.usage.totalTokens, 0),
          16
        )
      } finally {
        await rig.close()
      }
    }
  )

  await claim(
    'background failure leaves ordinary work and native manual recovery usable',
    async () => {
      const rig = await open()
      try {
        await rig.start()
        const background = await rig.summary()
        background.finish(0, 0, '', 'summary provider unavailable')
        await sleep(20)
        assert.equal(rig.compactions().length, 0)
        assert.ok(JSON.stringify(rig.session.messages).includes('OLD-PREFIX'))
        assert.deepEqual(
          rig.observations().find(event => event.kind === 'background-ended')?.outcome,
          { kind: 'discarded', reason: 'failure' }
        )
        assert.ok(!JSON.stringify(rig.observations()).includes('summary provider unavailable'))
        rig.tokens(100)
        await rig.session.prompt('ordinary after failed summary')
        const operation = rig.session.compact()
        const native = await rig.summary(1)
        native.finish()
        await operation
        assert.equal(rig.compactions().length, 1)
        assert.equal(rig.ordinary.length, 2)
      } finally {
        await rig.close()
      }
    }
  )

  await claim(
    'a preceding boundary context edit invalidates a ready result while preserving the other extension draft',
    async () => {
      let edit = false
      const rig = await open({
        before: api => {
          api.on('turn_end', (event, context) => {
            if (!edit) return
            const target = context.sessionManager
              .getBranch()
              .find(entry => entry.type === 'message' && entry.message.role === 'user')
            assert.ok(target)
            return {
              entries: [
                ...event.entries,
                { type: 'context_edit', targetId: target.id, replacement: null },
              ],
            }
          })
        },
      })
      try {
        await rig.start()
        const summary = await rig.summary()
        rig.hold()
        const prompt = rig.session.prompt('concurrent turn with an edit')
        const active = await waitFor('ordinary turn before edit', () => rig.ordinary[1], {
          intervalMs: 5,
        })
        summary.finish(3, 1)
        await sleep(20)
        edit = true
        active.finish(100, 0, 'finished')
        await prompt
        assert.equal(rig.compactions().length, 0)
        assert.ok(
          rig.manager
            .getEntries()
            .some(entry => entry.type === 'context_edit' && entry.targetId === rig.oldId)
        )
        assert.equal(JSON.stringify(rig.session.messages).includes('OLD-PREFIX'), false)
      } finally {
        await rig.close()
      }
    }
  )

  await claim(
    'effective per-model budgets determine eligibility and the retained cut',
    async () => {
      const rig = await open({
        tokens: 82304,
        keepRecentTokens: 1000000,
        modelBudgets: { reserveTokens: 16000, keepRecentTokens: 64 },
      })
      try {
        await rig.start()
        assert.equal(rig.summaries.length, 0)
        rig.tokens(82305)
        await rig.session.prompt(recent)
        assert.equal(rig.session.model?.contextWindow, 131072)
        assert.equal(
          rig.settingsManager.getCompactionSettings(rig.session.model).keepRecentTokens,
          64
        )
        const request = await rig.summary()
        request.finish()
        await rig.applied()
        assert.equal(rig.compactions().length, 1)
      } finally {
        await rig.close()
      }
    }
  )

  await claim(
    'background then native compaction preserve cumulative file lists across extension-origin summaries',
    async () => {
      const rig = await open({ files: true })
      try {
        await rig.start()
        const background = await rig.summary()
        assert.ok(textOf(background.context).includes('tracked.ts'))
        background.finish()
        const first = await rig.applied()
        assert.deepEqual(first.details, { readFiles: ['tracked.ts'], modifiedFiles: [] })
        rig.manager.appendMessage({ role: 'user', content: recent, timestamp: Date.now() })
        rig.session.refreshContext()
        const native = rig.session.compact()
        const request = await rig.summary(1)
        request.finish()
        await native
        assert.deepEqual(rig.compactions().at(-1)?.details, {
          readFiles: ['tracked.ts'],
          modifiedFiles: [],
        })
        assert.ok(rig.compactions().at(-1)?.summary.includes('tracked.ts'))
      } finally {
        await rig.close()
      }
    }
  )

  await claim(
    'abort while another boundary handler waits cannot commit an already proposed summary',
    async () => {
      const offered = deferred<void>()
      const release = deferred<void>()
      const rig = await open({
        extensions: [
          api => {
            api.on('turn_end', async event => {
              if (!event.entries.some(entry => entry.type === 'compaction')) return
              offered.resolve()
              await release.promise
            })
          },
        ],
      })
      try {
        await rig.start()
        const summary = await rig.summary()
        rig.hold()
        const prompt = rig.session.prompt('work until the boundary')
        const active = await waitFor('ordinary held response', () => rig.ordinary[1], {
          intervalMs: 5,
        })
        summary.finish()
        await sleep(20)
        active.finish(81930, 0, 'boundary reached')
        await offered.promise
        assert.equal(
          rig.observations().filter(event => event.kind === 'background-ended').length,
          0
        )
        const abort = rig.session.abort()
        release.resolve()
        await abort
        await prompt
        assert.equal(rig.compactions().length, 0)
        const outcomes = rig.observations().filter(event => event.kind === 'background-ended')
        assert.equal(outcomes.length, 1)
        assert.deepEqual(outcomes[0]?.outcome, { kind: 'discarded', reason: 'abort' })
      } finally {
        release.resolve()
        await rig.close()
      }
    }
  )

  await claim(
    'shutdown fences preparation before an earlier extension can wait during teardown',
    async () => {
      const entered = deferred<void>()
      const release = deferred<void>()
      const rig = await open({
        before: api => {
          api.on('session_shutdown', async () => {
            entered.resolve()
            await release.promise
          })
        },
      })
      try {
        await rig.start()
        const pending = await rig.summary()
        const shutdown = rig.runtime.dispose()
        await entered.promise
        assert.equal(pending.options?.signal?.aborted, true)
        pending.finish()
        await sleep(20)
        assert.equal(rig.compactions().length, 0)
        release.resolve()
        await shutdown
        assert.deepEqual(
          rig.observations().find(event => event.kind === 'background-ended')?.outcome,
          { kind: 'discarded', reason: 'shutdown' }
        )
        assert.equal(rig.observations().filter(event => event.kind === 'detached').length, 1)
      } finally {
        release.resolve()
        await rig.close()
      }
    }
  )

  await claim(
    'a boundary draft removed by another handler is recorded as rejected, never applied',
    async () => {
      const rig = await open({
        extensions: [
          api => {
            api.on('turn_end', event => ({
              entries: event.entries.filter(entry => entry.type !== 'compaction'),
            }))
          },
        ],
      })
      try {
        await rig.start()
        const summary = await rig.summary()
        rig.hold()
        const prompt = rig.session.prompt('finish without the proposed summary')
        const active = await waitFor('ordinary turn for rejected draft', () => rig.ordinary[1], {
          intervalMs: 5,
        })
        summary.finish()
        await waitFor(
          'ready observation',
          () => rig.observations().find(event => event.kind === 'background-ready'),
          { intervalMs: 5 }
        )
        active.finish(100, 0)
        await prompt
        assert.equal(rig.compactions().length, 0)
        const outcomes = rig.observations().filter(event => event.kind === 'background-ended')
        assert.equal(outcomes.length, 1)
        assert.deepEqual(outcomes[0]?.outcome, { kind: 'discarded', reason: 'boundary-rejected' })
      } finally {
        await rig.close()
      }
    }
  )

  await claim(
    'failed diagnostic persistence does not prevent preparation, usage accounting or application',
    async () => {
      const rig = await open()
      try {
        const append = rig.manager.appendCustomEntry.bind(rig.manager)
        rig.manager.appendCustomEntry = (type, data) => {
          if (type === COMPACTION_OBSERVATION) throw new Error('PRIVATE-DIAGNOSTIC-WRITE-FAILURE')
          return append(type, data)
        }
        await rig.start()
        const summary = await rig.summary()
        summary.finish()
        await rig.applied()
        assert.equal(rig.compactions().length, 1)
        assert.equal(rig.summaries.length, 1)
        assert.equal(rig.ordinary.length, 1)
        assert.equal(rig.observations().length, 1)
        assert.equal(
          rig.manager
            .getEntries()
            .filter(entry => entry.type === 'usage')
            .reduce((sum, entry) => sum + entry.usage.totalTokens, 0),
          12
        )
        assert.ok(
          !JSON.stringify(rig.manager.getEntries()).includes('PRIVATE-DIAGNOSTIC-WRITE-FAILURE')
        )
      } finally {
        await rig.close()
      }
    }
  )

  await claim(
    'an observed cost is retained even when the provider supplies no positive token counts',
    async () => {
      const rig = await open()
      try {
        await rig.start()
        const summary = await rig.summary()
        const before = rig.session.getSessionStats().cost
        summary.finish(0, 0, 'SUMMARY-WITH-KNOWN-COST', undefined, 0.01)
        await rig.applied()
        assert.equal(rig.manager.getEntries().filter(entry => entry.type === 'usage').length, 1)
        assert.equal(rig.session.getSessionStats().cost - before, 0.01)
      } finally {
        await rig.close()
      }
    }
  )

  await claim(
    'native failed and aborted spans preserve outcomes without raw error text',
    async () => {
      for (const aborted of [false, true]) {
        const rig = await open({ tokens: 100 })
        try {
          await rig.start()
          const operation = assert.rejects(rig.session.compact())
          const summary = await rig.summary()
          if (aborted) rig.session.abortCompaction()
          summary.finish(0, 0, '', 'PRIVATE-NATIVE-FAILURE')
          await operation
          const starts = rig.observations().filter(event => event.kind === 'native-started')
          const ends = rig.observations().filter(event => event.kind === 'native-ended')
          assert.equal(starts.length, 1)
          assert.equal(ends.length, 1)
          assert.equal(ends[0]?.id, starts[0]?.id)
          assert.equal(ends[0]?.outcome, aborted ? 'aborted' : 'failed')
          assert.ok(!JSON.stringify(rig.observations()).includes('PRIVATE-NATIVE-FAILURE'))
        } finally {
          await rig.close()
        }
      }
    }
  )

  console.log(JSON.stringify({ checks: passed.length, claims: passed }))
} finally {
  rmSync(fixture, { recursive: true, force: true })
}
