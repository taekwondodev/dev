import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFileSystem } from '@effect/platform-node'
import { DateTime, Effect } from 'effect'
import { profileUsage } from '../scripts/usage-profile.ts'
import { makeClaims } from './workspace/workspace-check-support.ts'

const root = mkdtempSync(join(tmpdir(), 'dev-usage-profile-'))
const dataHome = join(root, 'data')
const output = join(root, 'performance')
const { claim, passed } = makeClaims()

const epochMillis = (instant: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(instant))
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms))
const attempt = (id: string, kind: 'agent' | 'process', parent?: string) => ({
  id,
  kind,
  status: 'running',
  owner: { sessionId: 'fixture', ...(parent === undefined ? {} : { parent }) },
})

const conversation = (day: number) => {
  const at = (second: number) => day + second * 1000
  const header = {
    type: 'session',
    version: 3,
    id: 'fixture',
    timestamp: iso(day),
    cwd: '/fixture',
  }
  const entry = (id: string, parentId: string | null, second: number, message: object) => ({
    type: 'message',
    id,
    parentId,
    timestamp: iso(at(second)),
    message,
  })
  return {
    header,
    forkHeader: (second: number) => ({
      ...header,
      id: 'fork',
      timestamp: iso(at(second)),
      parentSession: '/fixture/parent.jsonl',
    }),
    modelChange: (id: string) => ({
      type: 'model_change',
      id,
      parentId: null,
      timestamp: iso(day),
      provider: 'fixture',
      modelId: 'fixture',
    }),
    system: (id: string, parentId: string, second: number) =>
      entry(id, parentId, second, { role: 'system', content: '', timestamp: at(second) }),
    user: (id: string, parentId: string | null, second: number) =>
      entry(id, parentId, second, { role: 'user', content: 'go', timestamp: at(second) }),
    request: (
      id: string,
      parentId: string,
      second: number,
      latency: number,
      input: number,
      cacheRead: number
    ) =>
      entry(id, parentId, second, {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input, output: 10, cacheRead, cacheWrite: 0, totalTokens: input + cacheRead + 10 },
        stopReason: 'toolUse',
        timestamp: at(second - latency),
      }),
    toolResult: (
      id: string,
      parentId: string,
      second: number,
      toolName: string,
      bytes: number,
      details: object = {}
    ) =>
      entry(id, parentId, second, {
        role: 'toolResult',
        toolCallId: id,
        toolName,
        content: [{ type: 'text', text: 'x'.repeat(bytes) }],
        details,
        isError: false,
        timestamp: at(second),
      }),
  }
}

const writeSession = (directory: string, name: string, lines: readonly (object | string)[]) => {
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, `${name}.jsonl`),
    `${lines.map(line => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n')}\n`
  )
}

const lead = conversation(epochMillis('2026-09-29T10:00:00Z'))
const leadA = [
  lead.modelChange('a0'),
  lead.system('a1', 'a0', 5),
  lead.user('a2', 'a1', 5),
  lead.request('a3', 'a2', 15, 10, 100, 300),
  lead.toolResult('a4', 'a3', 16, 'read', 2048),
  lead.toolResult('a5', 'a4', 18, 'bash', 1024),
  lead.toolResult('a6', 'a5', 19, 'work', 1024, attempt('attempt-1', 'agent')),
  lead.request('a7', 'a6', 40, 20, 100, 500),
  lead.user('a8', 'a7', 100),
  lead.user('a9', 'a3', 130),
]
writeSession(join(dataHome, 'sessions'), 'lead-a', [lead.header, ...leadA])
writeSession(join(dataHome, 'sessions'), 'lead-b', [
  lead.header,
  lead.user('b1', null, 0),
  lead.request('b2', 'b1', 31, 30, 200, 0),
  lead.toolResult('b3', 'b2', 33, 'read', 4096),
  { type: 'future_entry', id: 'b4', parentId: 'b3', timestamp: lead.header.timestamp, data: {} },
  '{"type":"message","id":"b5"',
])
writeSession(join(dataHome, 'sessions'), 'lead-c', [lead.header])
const child = conversation(epochMillis('2026-09-30T10:00:00Z'))
writeSession(join(dataHome, 'child-sessions'), 'child', [
  child.header,
  child.user('c1', null, 0),
  child.request('c2', 'c1', 5, 5, 100, 100),
  child.toolResult('c3', 'c2', 6, 'grep', 512),
])

const nested = join(root, 'nested')
const coordinated = [
  lead.user('n1', null, 0),
  lead.request('n2', 'n1', 10, 10, 100, 0),
  lead.toolResult('n3', 'n2', 11, 'work', 64, attempt('coordinator', 'agent')),
  lead.toolResult('n4', 'n3', 12, 'work', 64, attempt('leaf', 'agent', 'coordinator')),
  lead.toolResult('n5', 'n4', 13, 'work', 64, attempt('coordinator', 'agent')),
  lead.toolResult('n6', 'n5', 14, 'work', 64, attempt('build', 'process')),
]
writeSession(join(nested, 'sessions'), 'coordinated', [lead.header, ...coordinated])
writeSession(join(nested, 'sessions'), 'coordinated-fork', [
  lead.forkHeader(100),
  ...coordinated,
  lead.user('f1', 'n6', 150),
  lead.request('f2', 'f1', 160, 10, 100, 0),
  lead.toolResult('f3', 'f2', 163, 'bash', 64),
])

const profile = (home: string, into = output) =>
  Effect.runPromise(
    Effect.result(profileUsage(home, into)).pipe(Effect.provide(NodeFileSystem.layer))
  )

const snapshot = () =>
  Object.fromEntries(
    readdirSync(output)
      .toSorted()
      .map(name => [name, readFileSync(join(output, name), 'utf8')])
  )

try {
  await claim(
    'the fixture sessions produce the specified baseline, the charts carry the tile values, a rerun is byte-identical and an empty data home fails without writing, gaps follow file order; a fork counts only its new entries and only direct children count',
    async () => {
      assert.equal((await profile(dataHome))._tag, 'Success')
      const first = snapshot()
      assert.deepEqual(Object.keys(first), ['tools.svg', 'usage-baseline.json', 'usage.svg'])
      const baseline = JSON.parse(first['usage-baseline.json'] ?? '')
      assert.deepEqual(baseline.sample, {
        leadSessions: 2,
        emptyLeadSessions: 1,
        childSessions: 1,
        undecodableLines: 1,
        firstDate: '2026-09-29',
        lastDate: '2026-09-30',
      })
      assert.equal(baseline.cache.lead.hitRate, 800 / 1200)
      assert.equal(baseline.cache.child.hitRate, 0.5)
      assert.deepEqual(baseline.toolCallsPerSession, { median: 1, minimum: 1, maximum: 3 })
      assert.deepEqual(baseline.children, {
        agentAttempts: 1,
        processAttempts: 0,
        meanPerSession: 0.5,
        sessionShare: 0.5,
      })
      assert.deepEqual(baseline.latency, { requests: 3, p50Ms: 20_000, p90Ms: 30_000 })
      assert.deepEqual(baseline.timeSplit, { modelMs: 60_000, toolMs: 6000, userMs: 95_000 })
      assert.equal(baseline.toolResults.lead.meanBytes, 2048)
      assert.deepEqual(baseline.toolResults.lead.tools, [
        {
          name: 'read',
          count: 2,
          bytes: 6144,
          meanBytes: 3072,
          medianBytes: 2048,
          p90Bytes: 4096,
          share: 0.75,
        },
        {
          name: 'bash',
          count: 1,
          bytes: 1024,
          meanBytes: 1024,
          medianBytes: 1024,
          p90Bytes: 1024,
          share: 0.125,
        },
        {
          name: 'work',
          count: 1,
          bytes: 1024,
          meanBytes: 1024,
          medianBytes: 1024,
          p90Bytes: 1024,
          share: 0.125,
        },
      ])
      assert.deepEqual(
        baseline.toolResults.child.tools.map((tool: { name: string }) => tool.name),
        ['grep']
      )
      for (const value of ['66.7%', '>1<', '0.50', '20.0 s', '2.0 KiB', '2026-09-29 to 2026-09-30'])
        assert.ok(first['usage.svg']?.includes(value), `usage.svg lacks ${value}`)
      for (const value of ['>read<', '75.0%', '>bash<', '>work<', '12.5%'])
        assert.ok(first['tools.svg']?.includes(value), `tools.svg lacks ${value}`)

      assert.equal((await profile(dataHome))._tag, 'Success')
      assert.deepEqual(snapshot(), first)

      const empty = join(root, 'empty')
      mkdirSync(empty)
      const refused = await profile(empty)
      assert.equal(refused._tag, 'Failure')
      assert.match(
        String(refused._tag === 'Failure' && refused.failure.message),
        /nothing was written/
      )
      assert.deepEqual(snapshot(), first)

      const nestedOutput = join(root, 'nested-performance')
      assert.equal((await profile(nested, nestedOutput))._tag, 'Success')
      const forked = JSON.parse(readFileSync(join(nestedOutput, 'usage-baseline.json'), 'utf8'))
      assert.equal(forked.sample.leadSessions, 2)
      assert.equal(forked.latency.requests, 2)
      assert.deepEqual(forked.toolCallsPerSession, { median: 1, minimum: 1, maximum: 4 })
      assert.deepEqual(forked.timeSplit, { modelMs: 20_000, toolMs: 7000, userMs: 0 })
      assert.deepEqual(forked.children, {
        agentAttempts: 1,
        processAttempts: 1,
        meanPerSession: 0.5,
        sessionShare: 0.5,
      })
    }
  )
  console.log(JSON.stringify({ result: 'passed', checks: passed }, null, 2))
} finally {
  rmSync(root, { recursive: true, force: true })
}
