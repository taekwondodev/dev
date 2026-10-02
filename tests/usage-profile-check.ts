import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFileSystem } from '@effect/platform-node'
import { DateTime, Effect } from 'effect'
import { GIT_INSPECT_OPERATIONS } from '../scripts/usage-export.ts'
import { ALL_TIME, parsePeriod, profileUsage } from '../scripts/usage-profile.ts'
import type { Period } from '../scripts/usage-report.ts'
import { makeClaims } from './workspace/workspace-check-support.ts'

const checkout = join(import.meta.dirname, '..')
const root = mkdtempSync(join(tmpdir(), 'dev-usage-profile-'))
const { claim, passed } = makeClaims()

type Json = Record<string, unknown>
type Line = Json | string

const epochMillis = (instant: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(instant))
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms))

const tokens = (
  input: number,
  output: number,
  cacheRead = 0,
  cacheWrite = 0,
  reasoning?: number
) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  ...(reasoning === undefined ? {} : { reasoning }),
  totalTokens: input + output + cacheRead + cacheWrite,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
})

interface Call {
  readonly id: string
  readonly name: string
  readonly arguments: Json
}

interface AssistantOptions {
  readonly calls?: readonly Call[]
  readonly usage?: unknown
  readonly latency?: number
  readonly model?: string
  readonly thinkingLevel?: string
  readonly stopReason?: string
}

interface ResultOptions {
  readonly text?: string
  readonly blocks?: readonly Json[]
  readonly isError?: boolean
  readonly details?: unknown
  readonly usage?: unknown
}

const conversation = (start: string) => {
  const base = epochMillis(start)
  const time = (second: number) => base + second * 1000
  const entry = (
    type: string,
    id: string,
    parentId: string | null,
    second: number,
    body: Json
  ) => ({
    type,
    id,
    parentId,
    timestamp: iso(time(second)),
    ...body,
  })
  const message = (id: string, parentId: string | null, second: number, body: Json) =>
    entry('message', id, parentId, second, { message: { timestamp: time(second), ...body } })
  return {
    header: (extra: Json = {}) => ({
      type: 'session',
      version: 3,
      id: 'fixture',
      timestamp: iso(base),
      cwd: '/fixture',
      ...extra,
    }),
    user: (id: string, parentId: string | null, second: number, content = 'go') =>
      message(id, parentId, second, { role: 'user', content }),
    system: (id: string, parentId: string | null, second: number, sections?: Json) =>
      message(id, parentId, second, {
        role: 'system',
        content: '',
        ...(sections === undefined ? {} : { sections }),
      }),
    thinking: (id: string, parentId: string, second: number, thinkingLevel: string) =>
      entry('thinking_level_change', id, parentId, second, { thinkingLevel }),
    assistant: (
      id: string,
      parentId: string | null,
      second: number,
      options: AssistantOptions = {}
    ) =>
      message(id, parentId, second, {
        role: 'assistant',
        content: [
          { type: 'text', text: 'ok' },
          ...(options.calls ?? []).map(call => ({
            type: 'toolCall',
            id: call.id,
            name: call.name,
            arguments: call.arguments,
          })),
        ],
        api: 'fixture',
        provider: 'fixture',
        model: options.model ?? 'alpha',
        ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
        usage: options.usage ?? tokens(10, 1),
        stopReason: options.stopReason ?? 'toolUse',
        timestamp: time(second - (options.latency ?? 1)),
      }),
    result: (
      id: string,
      parentId: string,
      second: number,
      call: Pick<Call, 'id' | 'name'>,
      options: ResultOptions = {}
    ) =>
      message(id, parentId, second, {
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        content: options.blocks ?? [{ type: 'text', text: options.text ?? 'ok' }],
        details: options.details ?? {},
        ...(options.usage === undefined ? {} : { usage: options.usage }),
        isError: options.isError ?? false,
      }),
    compaction: (id: string, parentId: string, second: number, extra: Json = {}) =>
      entry('compaction', id, parentId, second, {
        summary: 'summary',
        firstKeptEntryId: id,
        ...extra,
      }),
    branchSummary: (id: string, parentId: string, second: number, extra: Json = {}) =>
      entry('branch_summary', id, parentId, second, {
        fromId: parentId,
        summary: 'summary',
        ...extra,
      }),
    usage: (id: string, parentId: string, second: number, usage: unknown) =>
      entry('usage', id, parentId, second, {
        kind: 'cache_warm',
        provider: 'fixture',
        model: 'alpha',
        usage,
      }),
    contextEdit: (id: string, parentId: string, second: number, targetId: string) =>
      entry('context_edit', id, parentId, second, { targetId, replacement: null }),
    custom: (id: string, parentId: string, second: number, customType: string, content: string) =>
      entry('custom_message', id, parentId, second, { customType, content, display: true }),
  }
}

const writeSession = (home: string, directory: string, name: string, lines: readonly Line[]) => {
  mkdirSync(join(home, directory), { recursive: true })
  writeFileSync(
    join(home, directory, `${name}.jsonl`),
    `${lines.map(line => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n')}\n`
  )
}

const call = (id: string, name: string, args: Json = {}): Call => ({ id, name, arguments: args })

const cwdSection = (path: string) => ({ cwd: `<cwd>\n${path}\n</cwd>` })

const page = (lines: readonly string[], start: number, total: number) => {
  const next = start + lines.length
  return next > total
    ? lines.join('\n')
    : `${lines.join('\n')}\n\n[${total - next + 1} more lines in file. Use offset=${next} to continue.]`
}

const truncation = (by: 'lines' | 'bytes' | 'first-line', outputLines: number) => ({
  truncation: {
    content: '',
    truncated: by !== 'first-line',
    truncatedBy: by === 'first-line' ? 'bytes' : by,
    totalLines: 9,
    totalBytes: 99_999,
    outputLines,
    outputBytes: 10,
    lastLinePartial: false,
    firstLineExceedsLimit: by === 'first-line',
    maxLines: 2000,
    maxBytes: 51_200,
  },
})

const pick = (totals: Record<string, unknown>) => ({
  entries: totals.entries,
  unknown: totals.unknown,
  input: totals.input,
  output: totals.output,
  reasoning: totals.reasoning,
  cacheRead: totals.cacheRead,
  cacheWrite: totals.cacheWrite,
})

const rows = (list: { key: string; tokens: { entries: number } }[]) =>
  Object.fromEntries(list.map(row => [row.key, row.tokens.entries]))

const profile = (home: string, periods: readonly [Period, ...Period[]] = [ALL_TIME]) =>
  Effect.runPromise(
    Effect.result(profileUsage({ dataHome: home, selection: { kind: 'report', periods } })).pipe(
      Effect.provide(NodeFileSystem.layer)
    )
  )

const period = (text: string) => Effect.runPromise(parsePeriod(text))

const report = (home: string, name = 'all') =>
  JSON.parse(readFileSync(join(home, 'usage', `${name}.json`), 'utf8'))

const toolsHome = join(root, 'tools')
{
  const lead = conversation('2026-09-29T10:00:00Z')
  const read = call('c-read', 'read', { path: '/repo/a.ts' })
  const aborted = call('c-aborted', 'bash', { command: 'sleep 9' })
  const exit = call('c-exit', 'bash', { command: 'npm test' })
  const unknown = call('c-unknown', 'nope', {})
  const invalid = call('c-invalid', 'read', { path: 7 })
  const blocked = call('c-blocked', 'edit', { path: '/repo/a.ts' })
  const devBlocked = call('c-dev-blocked', 'write', { path: '/repo/b.ts' })
  const odd = call('c-odd', 'work', { action: 'list' })
  const scoped = call('c-scoped', 'work', { action: 'inspect' })
  const lost = call('c-lost', 'grep', { pattern: 'x' })
  const retry = call('c-retry', 'bash', { command: 'npm test' })
  const again = call('c-again', 'nope', {})
  const cut = call('c-cut', 'read', { path: '/repo/a.ts' })
  const failing = call('c-failing', 'bash', { command: 'npm test' })
  const passing = call('c-passing', 'bash', { command: 'true' })
  const missing = call('c-missing', 'bash', { command: 'cat x' })
  const firstRetry = call('c-x1', 'bash', { command: 'npm test' })
  const sibling = call('c-x2', 'bash', { command: 'npm run lint' })
  const third = call('c-x3', 'bash', { command: 'npm run build' })
  writeSession(toolsHome, 'sessions', 'tools', [
    lead.header(),
    lead.user('u1', null, 0),
    lead.assistant('a1', 'u1', 10, {
      calls: [read, aborted, exit, unknown, invalid, blocked, devBlocked, odd, scoped, lost],
    }),
    lead.result('r-read', 'a1', 11, read, { text: 'a' }),
    lead.result('r-aborted', 'r-read', 12, aborted, {
      text: 'partial\n\nCommand aborted',
      isError: true,
    }),
    lead.result('r-exit', 'r-aborted', 12, exit, {
      text: 'FAIL one test\n\nCommand exited with code 1',
      isError: true,
    }),
    lead.result('r-unknown', 'r-exit', 12, unknown, { text: 'Tool nope not found', isError: true }),
    lead.result('r-invalid', 'r-unknown', 12, invalid, {
      text: 'Validation failed for tool "read":\n  - path: Expected string',
      isError: true,
    }),
    lead.result('r-blocked', 'r-invalid', 12, blocked, {
      text: 'Tool execution was blocked',
      isError: true,
    }),
    lead.result('r-dev-blocked', 'r-blocked', 12, devBlocked, {
      text: 'Child workspace is read-only',
      isError: true,
    }),
    lead.result('r-odd', 'r-dev-blocked', 12, odd, { text: 'Something unexpected', isError: true }),
    lead.result('r-scoped', 'r-odd', 12, scoped, {
      text: 'Found 2 occurrences of the attempt in the store',
      isError: true,
    }),
    lead.result('r-ghost', 'r-scoped', 13, call('c-ghost', 'ls'), { text: 'orphan' }),
    lead.assistant('a2', 'r-ghost', 20, { calls: [retry, again] }),
    lead.result('r-retry', 'a2', 21, retry, { text: 'ok' }),
    lead.result('r-again', 'r-retry', 21, again, { text: 'Tool nope not found', isError: true }),
    lead.assistant('a3', 'r-again', 30, { calls: [cut], stopReason: 'aborted' }),
    lead.assistant('a4', 'a3', 40, { calls: [failing, passing, missing] }),
    lead.result('r-failing', 'a4', 41, failing, {
      text: 'FAIL\n\nCommand exited with code 1',
      isError: true,
    }),
    lead.result('r-passing', 'r-failing', 41, passing, { text: 'ok' }),
    lead.result('r-missing', 'r-passing', 41, missing, {
      text: "ENOENT: no such file or directory, open 'x'\n\nCommand exited with code 2",
      isError: true,
    }),
    lead.assistant('a5', 'r-missing', 50, { calls: [firstRetry, sibling, third] }),
    lead.result('r-x1', 'a5', 51, firstRetry, { text: 'ok' }),
    lead.result('r-x2', 'r-x1', 51, sibling, {
      text: 'Validation failed for tool "read": lint output\n\nCommand exited with code 1',
      isError: true,
    }),
    lead.result('r-x3', 'r-x2', 51, third, { text: 'ok' }),
  ])
}

const readsHome = join(root, 'reads')
{
  const lead = conversation('2026-09-29T10:00:00Z')
  const path = '/repo/a.ts'
  const file = Array.from({ length: 10 }, (_, index) => `l${index + 1}`)
  const range = (start: number, count: number) =>
    page(file.slice(start - 1, start - 1 + count), start, 10)
  const read = (id: string, offset: number, limit: number) =>
    call(id, 'read', { path, offset, limit })
  const bash = (id: string, command: string) => call(id, 'bash', { command })
  const r1 = read('r1', 1, 3)
  const g1 = bash('g1', 'git status --short')
  const r2 = read('r2', 4, 3)
  const r3 = read('r3', 2, 2)
  const g2 = bash('g2', 'git status --short')
  const g3 = bash('g3', 'git diff')
  const r4 = read('r4', 1, 3)
  const g4 = bash('g4', 'git diff')
  const g5 = call('g5', 'git_inspect', { operation: 'status', path: null })
  const g6 = bash('g6', 'cd /repo && git log -3')
  const r5 = read('r5', 3, 1)
  const w1 = call('w1', 'edit', { path })
  const r6 = read('r6', 5, 1)
  const r7 = read('r7', 2, 2)
  const g7 = bash('g7', 'git status --short')
  const r8 = call('r8', 'read', { path: '/repo/img.png', offset: null, limit: null })
  const r9 = call('r9', 'read', { path: '/repo/big.txt' })
  const r10 = call('r10', 'read', { path: '/repo/missing.ts' })
  const r11 = call('r11', 'read', { path: 'b.ts' })
  const r12 = call('r12', 'read', { path: 'b.ts' })
  writeSession(readsHome, 'sessions', 'lead', [
    lead.header(),
    lead.user('u1', null, 0),
    lead.assistant('a1', 'u1', 10, { calls: [r1, g1] }),
    lead.result('res-r1', 'a1', 11, r1, { text: range(1, 3) }),
    lead.result('res-g1', 'res-r1', 11, g1, { text: ' M a.ts' }),
    lead.assistant('a2', 'res-g1', 20, { calls: [r2, r3, g2, g3] }),
    lead.result('res-r2', 'a2', 21, r2, { text: range(4, 3) }),
    lead.result('res-r3', 'res-r2', 21, r3, { text: range(2, 2) }),
    lead.result('res-g2', 'res-r3', 21, g2, { text: ' M a.ts' }),
    lead.result('res-g3', 'res-g2', 21, g3, { text: 'diff one' }),
    lead.compaction('cmp', 'res-g3', 30, { tokensBefore: 1000 }),
    lead.assistant('a3', 'cmp', 40, { calls: [r4, g4, g5, g6] }),
    lead.result('res-r4', 'a3', 41, r4, {
      text: page(['l1', 'CHANGED', 'l3'], 1, 10),
    }),
    lead.result('res-g4', 'res-r4', 41, g4, { text: 'diff two' }),
    lead.result('res-g5', 'res-g4', 41, g5, {
      text: 'x\n\n[git output truncated at 65536 bytes]',
    }),
    lead.result('res-g6', 'res-g5', 41, g6, { text: 'log', details: truncation('lines', 1) }),
    lead.contextEdit('ce', 'res-g6', 45, 'res-r4'),
    lead.assistant('a4', 'ce', 50, { calls: [r5] }),
    lead.result('res-r5', 'a4', 51, r5, { text: range(3, 1) }),
    lead.assistant('a5', 'res-r5', 55, { calls: [w1, r6] }),
    lead.result('res-w1', 'a5', 56, w1, { text: 'Successfully replaced text' }),
    lead.result('res-r6', 'res-w1', 56, r6, { text: range(5, 1) }),
    lead.assistant('a6', 'u1', 60, { calls: [r7, g7] }),
    lead.result('res-r7', 'a6', 61, r7, { text: range(2, 2) }),
    lead.result('res-g7', 'res-r7', 61, g7, { text: ' M a.ts' }),
    lead.assistant('a7', 'res-g7', 70, { calls: [r8, r9, r10] }),
    lead.result('res-r8', 'a7', 71, r8, {
      blocks: [
        { type: 'text', text: 'Read image file [image/png]' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      ],
    }),
    lead.result('res-r9', 'res-r8', 71, r9, {
      text: 'b1\nb2\n\n[Showing lines 1-2 of 9 (50.0KB limit). Use offset=3 to continue.]',
      details: truncation('bytes', 2),
    }),
    lead.result('res-r10', 'res-r9', 71, r10, {
      text: "ENOENT: no such file or directory, access '/repo/missing.ts'",
      isError: true,
    }),
    lead.assistant('a8', 'res-r10', 80, { calls: [r11] }),
    lead.result('res-r11', 'a8', 81, r11, { text: 'b1\nb2' }),
    lead.custom('h', 'res-r11', 82, 'dev/workspace-handoff', 'switched'),
    lead.assistant('a9', 'h', 90, { calls: [r12] }),
    lead.result('res-r12', 'a9', 91, r12, { text: 'b1\nb2' }),
  ])
  const child = conversation('2026-09-29T11:00:00Z')
  const review = read('cr', 1, 3)
  writeSession(readsHome, 'child-sessions', 'reviewer', [
    child.header(),
    child.user('u1', null, 0),
    child.assistant('a1', 'u1', 10, { calls: [review] }),
    child.result('res', 'a1', 11, review, { text: range(1, 3) }),
  ])
}

const usageHome = join(root, 'usage')
{
  const lead = conversation('2026-09-29T10:00:00Z')
  const work = call('t1', 'work', { action: 'list' })
  const shared = [
    lead.user('u1', null, 0),
    lead.assistant('a1', 'u1', 10, {
      calls: [work],
      usage: tokens(100, 20, 0, 400, 5),
      thinkingLevel: 'high',
    }),
    lead.result('res-t1', 'a1', 11, work, { usage: tokens(7, 3) }),
    lead.assistant('a2', 'res-t1', 20, { usage: tokens(50, 10, 400, 0) }),
  ]
  writeSession(usageHome, 'sessions', 'origin', [
    lead.header(),
    ...shared,
    lead.usage('st', 'a2', 21, tokens(0, 0, 1000, 0)),
    lead.compaction('cmp', 'st', 30, { tokensBefore: 5000, usage: tokens(300, 60) }),
    lead.compaction('cmp2', 'cmp', 31),
    lead.branchSummary('bs', 'u1', 40, { usage: tokens(40, 8) }),
    lead.branchSummary('bs2', 'bs', 41),
    lead.assistant('a3', 'bs2', 50, { usage: { input: 'broken' } }),
    lead.assistant('a4', 'u1', 60, { usage: tokens(9, 1), stopReason: 'aborted' }),
  ])
  const fork = conversation('2026-09-29T12:00:00Z')
  writeSession(usageHome, 'sessions', 'fork', [
    fork.header({ id: 'fork', parentSession: '/fixture/origin.jsonl' }),
    ...shared,
    fork.user('u2', 'a2', 10),
    fork.assistant('a5', 'u2', 20, { usage: tokens(20, 2, 100, 0) }),
    '{"type":"message","id":"broken"',
  ])
}

const gitIdentityHome = join(root, 'git-identity')
for (const [name, first, second] of [
  ['quoted-space', 'git log --grep="a  b"', 'git log --grep="a b"'],
  ['environment', 'GIT_DIR=/repo-one/.git git status', 'GIT_DIR=/repo-two/.git git status'],
  ['directory', 'cd "/repo  one" && git status', 'cd "/repo one" && git status'],
  ['escaped-space', String.raw`git log --grep=a\ `, 'git log --grep=a\\\t'],
]) {
  const lead = conversation('2026-09-29T10:00:00Z')
  const lines: Line[] = [lead.header()]
  for (const [index, command] of [first, second, first].entries()) {
    const git = call(`g${index}`, 'bash', { command })
    lines.push(
      lead.assistant(`a${index}`, index === 0 ? null : `r${index - 1}`, index * 2 + 1, {
        calls: [git],
      }),
      lead.result(`r${index}`, `a${index}`, index * 2 + 2, git, { text: 'same output' })
    )
  }
  writeSession(gitIdentityHome, 'sessions', name, lines)
}

const periodsHome = join(root, 'periods')
{
  const lead = conversation('2026-09-29T23:59:00Z')
  const delegate = call('d1', 'work', { action: 'delegate' })
  const attempts = [
    {
      id: 'coord',
      kind: 'agent',
      owner: { sessionId: 'fixture' },
      coordinator: true,
      sessionFile: '/data/child-sessions/coord.jsonl',
    },
    {
      id: 'leaf',
      kind: 'agent',
      owner: { sessionId: 'fixture', parent: 'coord' },
      sessionFile: '/data/child-sessions/leaf.jsonl',
    },
  ]
  writeSession(periodsHome, 'sessions', 'lead', [
    lead.header(),
    lead.user(
      'u1',
      null,
      0,
      '<skill name="dev-cycle" location="/skills/dev-cycle/SKILL.md">\nbody\n</skill>'
    ),
    lead.assistant('a1', 'u1', 30, {
      calls: [delegate],
      thinkingLevel: 'high',
      usage: tokens(10, 1),
    }),
    lead.result('res-d1', 'a1', 40, delegate, {
      details: { id: 'coord', kind: 'agent', owner: { sessionId: 'fixture' }, coordinator: true },
    }),
    lead.custom('oc', 'res-d1', 60, 'dev/work-outcome', `Outcomes\n${JSON.stringify(attempts)}`),
    lead.assistant('a2', 'oc', 60, { model: 'beta', usage: tokens(20, 2) }),
    lead.user('u2', 'a2', 60 + 12 * 3600, 'continue'),
    lead.assistant('a3', 'u2', 60 + 12 * 3600 + 10, {
      model: 'beta',
      thinkingLevel: 'low',
      usage: tokens(30, 3),
    }),
    lead.assistant('a4', 'a3', 60 + 24 * 3600, { model: 'beta', usage: tokens(40, 4) }),
  ])
  const coordinator = conversation('2026-09-30T06:00:00Z')
  writeSession(periodsHome, 'child-sessions', 'coord', [
    coordinator.header(),
    coordinator.user(
      'u1',
      null,
      0,
      '<skill name="review" location="/skills/review/SKILL.md">\nbody\n</skill>'
    ),
    coordinator.assistant('a1', 'u1', 10, {
      model: 'gamma',
      thinkingLevel: 'medium',
      usage: tokens(5, 1),
    }),
  ])
  const leaf = conversation('2026-09-30T07:00:00Z')
  writeSession(periodsHome, 'child-sessions', 'leaf', [
    leaf.header(),
    leaf.user('u1', null, 0),
    leaf.thinking('t1', 'u1', 5, 'minimal'),
    leaf.assistant('a1', 't1', 10, { model: 'gamma', usage: tokens(6, 1) }),
  ])
  const orphan = conversation('2026-10-02T09:00:00Z')
  writeSession(periodsHome, 'child-sessions', 'orphan', [
    orphan.header(),
    orphan.user('u1', null, 0),
    orphan.assistant('a1', 'u1', 10, {
      model: 'gamma',
      thinkingLevel: 'medium',
      usage: tokens(7, 1),
    }),
  ])
}

const SENTINELS = {
  prompt: 'SENTINEL-PROMPT-7f3a',
  content: 'SENTINEL-CONTENT-91c2',
  path: 'SENTINEL-PATH-5d0e',
  command: 'SENTINEL-COMMAND-2b8f',
  error: 'SENTINEL-ERROR-c41d',
  skill: 'sentinel-skill-e6a9',
  model: 'sentinel-model-0b57',
  tool: 'sentinel_tool_a1f4',
}
const entryHome = join(root, 'entry')
{
  const lead = conversation('2026-09-29T10:00:00Z')
  const path = `/repo/${SENTINELS.path}/a.ts`
  const first = call('e1', 'read', { path, offset: 1, limit: 2 })
  const again = call('e2', 'read', { path, offset: 1, limit: 2 })
  const git = call('e3', 'bash', { command: `git log --grep ${SENTINELS.command}` })
  const custom = call('e4', SENTINELS.tool, { value: SENTINELS.command })
  const failing = call('e5', 'bash', { command: `npm test ${SENTINELS.command}` })
  const body = page([`one ${SENTINELS.content}`, 'two'], 1, 4)
  writeSession(entryHome, 'sessions', 'lead', [
    lead.header(),
    lead.user(
      'u1',
      null,
      0,
      `<skill name="${SENTINELS.skill}" location="/skills/x/SKILL.md">\n${SENTINELS.prompt}\n</skill>`
    ),
    lead.assistant('a1', 'u1', 10, {
      calls: [first, git],
      latency: 2,
      model: SENTINELS.model,
      usage: tokens(100, 10, 0, 300),
    }),
    lead.result('res-e1', 'a1', 11, first, { text: body }),
    lead.result('res-e3', 'res-e1', 11, git, { text: `commit ${SENTINELS.content}` }),
    lead.assistant('a2', 'res-e3', 20, {
      calls: [again, custom, failing],
      latency: 4,
      model: SENTINELS.model,
      usage: tokens(100, 10, 400, 0),
    }),
    lead.result('res-e2', 'a2', 21, again, { text: body }),
    lead.result('res-e4', 'res-e2', 21, custom, { text: SENTINELS.content }),
    lead.result('res-e5', 'res-e4', 21, failing, {
      text: `${SENTINELS.error}\n\nCommand exited with code 1`,
      isError: true,
    }),
  ])
  const child = conversation('2026-09-30T10:00:00Z')
  writeSession(entryHome, 'child-sessions', 'child', [
    child.header(),
    child.user('u1', null, 0, SENTINELS.prompt),
    child.assistant('a1', 'u1', 5, { model: SENTINELS.model, usage: tokens(50, 5, 50, 0) }),
  ])
}

const stat = (log: string) => `stat\n\n[Showing lines 1-1 of 9. Full output: ${log}]`

const edgesHome = join(root, 'edges')
{
  const lead = conversation('2026-09-29T10:00:00Z')
  const file = Array.from({ length: 10 }, (_, index) => `x${index + 1}`)
  const slice = (start: number, count: number) =>
    page(file.slice(start - 1, start - 1 + count), start, 10)
  const read = (id: string, args: Json) => call(id, 'read', args)
  const bash = (id: string, command: string) => call(id, 'bash', { command })
  const p1 = read('p1', { path: 'src/x.ts', offset: 1, limit: 3 })
  const p2 = read('p2', { path: 'src/x.ts', offset: 4, limit: 3 })
  const p3 = read('p3', { path: '/work/a/src/x.ts', offset: 1, limit: 6 })
  const t1 = read('t1', { path: '/work/a/notice.txt' })
  const t2 = read('t2', { path: '/work/a/pic.png' })
  const t3 = read('t3', { path: '/work/a/wide.txt' })
  const t4 = read('t4', { path: '/work/a/wide.txt' })
  const p4 = read('p4', { path: 'src/x.ts', offset: 1, limit: 3 })
  const g1 = bash('g1', 'echo "git status is clean"')
  const g2 = bash('g2', 'cd /work/b && git status --short')
  const g3 = bash('g3', "cat <<'EOF'\ngit is now quiet\nEOF")
  const g4 = call('g4', 'git_inspect', { operation: 'SECRET-OPERATION words' })
  const g5 = bash('g5', 'cd /work/c && git status --short')
  const g6 = bash('g6', 'git commit -m "first; second"')
  const g8 = bash('g8', 'cd /work/b && git status --short')
  const g7 = bash('g7', 'cd /work/c && git status --short')
  const g9 = bash('g9', 'git diff --stat')
  const g10 = bash('g10', 'git diff --stat')
  const g11 = bash('g11', 'cat > s.sh <<\\EOF\ngit push --force\nEOF')
  const g12 = bash('g12', 'git branch # then && git reset --hard')
  const g13 = bash('g13', 'echo $(git rev-parse HEAD)')
  const g14 = bash('g14', 'if git diff --quiet; then echo same; fi')
  const g15 = bash('g15', 'git --git-dir .git --work-tree zzworktree status')
  const g16 = bash('g16', 'git frobnicate')
  const y1 = read('y1', { path: 'src/y.ts' })
  const y2 = read('y2', { path: '/work/c/src/y.ts' })
  const g17 = bash('g17', 'git diff $(git merge-base HEAD main)')
  const g18 = bash('g18', 'git diff')
  const g19 = bash('g19', '(cd /work/x && git status); git status')
  const g20 = bash('g20', "cat <<'END-OF-MSG' > f\ngit push origin main\nEND-OF-MSG\ngit status")
  const g21 = bash('g21', 'cat <<EOF\r\nbody\r\nEOF\r\ngit log\r')
  const g22 = bash('g22', 'cd /work/c && \\\ngit show HEAD')
  const g23 = bash('g23', 'cd $(mktemp -d) && git status')
  const g24 = bash('g24', 'cd $(git rev-parse --show-toplevel) && git status')
  const z1 = read('z1', { path: '/work/c/z.ts', offset: '1', limit: '2' })
  const z2 = read('z2', { path: '/work/c/z.ts', offset: 3, limit: 1 })
  const zs = ['z1', 'z2', 'z3', 'z4', 'z5']
  const wide =
    "[Line 1 is 60.0KB, exceeds 50.0KB limit. Use bash: sed -n '1p' /work/a/wide.txt | head -c 51200]"
  writeSession(edgesHome, 'sessions', 'edges', [
    lead.header(),
    lead.system('s0', null, 0, cwdSection('/work/a')),
    lead.user('u1', 's0', 1),
    lead.assistant('a1', 'u1', 10, { calls: [p1, p2] }),
    lead.result('res-p1', 'a1', 11, p1, { text: slice(1, 3) }),
    lead.result('res-p2', 'res-p1', 11, p2, { text: slice(4, 3) }),
    lead.assistant('a2', 'res-p2', 20, { calls: [p3, t1, t2, t3, t4] }),
    lead.result('res-p3', 'a2', 21, p3, { text: slice(1, 6) }),
    lead.result('res-t1', 'res-p3', 21, t1, {
      text: 'n1\nn2\n\n[Showing lines 1-2 of 9 (50.0KB limit). Use offset=3 to continue.]',
    }),
    lead.result('res-t2', 'res-t1', 21, t2, {
      text: 'Read image file [image/png]\nThe image could not be processed',
    }),
    lead.result('res-t3', 'res-t2', 21, t3, { text: wide, details: truncation('first-line', 0) }),
    lead.result('res-t4', 'res-t3', 21, t4, { text: wide, details: truncation('first-line', 0) }),
    lead.system('s1', 'res-t4', 30, cwdSection('/work/b')),
    lead.assistant('a3', 's1', 31, { calls: [p4, g1, g2, g3, g4] }),
    lead.result('res-p4', 'a3', 32, p4, { text: slice(1, 3) }),
    lead.result('res-g1', 'res-p4', 32, g1, { text: 'git status is clean' }),
    lead.result('res-g2', 'res-g1', 32, g2, { text: ' M a' }),
    lead.result('res-g3', 'res-g2', 32, g3, { text: 'git is now quiet' }),
    lead.result('res-g4', 'res-g3', 32, g4, {
      text: 'git_inspect operation must be one of status, diff, staged-diff, log, show, files',
      isError: true,
    }),
    lead.assistant('a4', 'res-g4', 40, { calls: [g5, g6, g8] }),
    lead.result('res-g5', 'a4', 41, g5, { text: ' M c' }),
    lead.result('res-g6', 'res-g5', 41, g6, { text: '[main 1234] first' }),
    lead.result('res-g8', 'res-g6', 41, g8, { text: ' M a' }),
    lead.custom('h', 'res-g8', 42, 'dev/workspace-handoff', 'switched'),
    lead.assistant('a5', 'h', 50, { calls: [g7] }),
    lead.result('res-g7', 'a5', 51, g7, { text: ' M c' }),
    lead.assistant('a6', 'res-g7', 52, { calls: [g9] }),
    lead.result('res-g9', 'a6', 53, g9, {
      text: stat('/tmp/pi-bash-a.log'),
      details: truncation('lines', 1),
    }),
    lead.assistant('a7', 'res-g9', 54, { calls: [g10, g11, g12, g13, g14, g15, g16] }),
    lead.result('res-g10', 'a7', 55, g10, {
      text: stat('/tmp/pi-bash-b.log'),
      details: truncation('lines', 1),
    }),
    lead.result('res-g11', 'res-g10', 55, g11, { text: '' }),
    lead.result('res-g12', 'res-g11', 55, g12, { text: '* main' }),
    lead.result('res-g13', 'res-g12', 55, g13, { text: 'abc' }),
    lead.result('res-g14', 'res-g13', 55, g14, { text: 'same' }),
    lead.result('res-g15', 'res-g14', 55, g15, { text: 'clean' }),
    lead.result('res-g16', 'res-g15', 55, g16, {
      text: "git: 'frobnicate' is not a git command",
      isError: true,
    }),
    lead.compaction('cmp', 'res-g16', 56, {
      systemMessage: { role: 'system', content: '', sections: cwdSection('/work/c'), timestamp: 0 },
    }),
    lead.system('s2', 'cmp', 57, { skills: '<skills>\nnone\n</skills>' }),
    lead.user('u2', 's2', 58),
    lead.assistant('a8', 'u2', 60, {
      calls: [y1],
      usage: { input: -50, output: 1, cacheRead: 20, cacheWrite: 0 },
    }),
    lead.result('res-y1', 'a8', 61, y1, { text: 'y1\ny2' }),
    lead.assistant('a9', 'res-y1', 62, { calls: [y2] }),
    lead.result('res-y2', 'a9', 63, y2, { text: 'y1\ny2' }),
    lead.assistant('a10', 'res-y2', 70, { calls: [g17, g18, g19, g20, g21, g22, g23, g24] }),
    lead.result('res-g17', 'a10', 71, g17, { text: 'diff' }),
    lead.result('res-g18', 'res-g17', 71, g18, { text: 'diff' }),
    lead.result('res-g19', 'res-g18', 71, g19, { text: 'status' }),
    lead.result('res-g20', 'res-g19', 71, g20, { text: 'status' }),
    lead.result('res-g21', 'res-g20', 71, g21, { text: 'log' }),
    lead.result('res-g22', 'res-g21', 71, g22, { text: 'show' }),
    lead.result('res-g23', 'res-g22', 71, g23, { text: 'status' }),
    lead.result('res-g24', 'res-g23', 71, g24, { text: 'status' }),
    lead.assistant('a11', 'res-g24', 80, { calls: [z1, z2] }),
    lead.result('res-z1', 'a11', 81, z1, { text: page(zs.slice(0, 2), 1, 5) }),
    lead.result('res-z2', 'res-z1', 81, z2, { text: page(zs.slice(2, 3), 3, 5) }),
    lead.result('k1', 'k2', 60, call('none-1', 'ls')),
    lead.result('k2', 'k1', 61, call('none-2', 'ls')),
  ])
}

const DEV_TEXTS = [
  [
    'src/workspace-host.ts',
    ["'Workspace host is parked; stale tools are blocked.'"],
    'read',
    'blocked',
  ],
  [
    'src/workspace-host.ts',
    ["'Workspace host is parked during a transition; no operation started.'"],
    'read',
    'blocked',
  ],
  [
    'src/workspace-host.ts',
    ['`Workspace admission requires a host rebind: ', '. The operation was not executed.`'],
    'bash',
    'blocked',
  ],
  ['src/workspace-host.ts', ['`Workspace admission failed closed: ', '`'], 'edit', 'blocked'],
  ['src/workspace-host.ts', ['`Native ', ' was not executed: ', '`'], 'write', 'blocked'],
  [
    'src/workspace-host.ts',
    [
      '`Tool ',
      ' has no verified workspace effect in dev, so it was not executed. A supported extension must have its project effects reviewed and recorded first (ADR 0005).`',
    ],
    'extension_tool',
    'blocked',
  ],
  [
    'src/workspace-host.ts',
    [
      '`Workspace authority returned ',
      ' access for a ',
      ' operation; the Pi tool was not executed.`',
    ],
    'read',
    'blocked',
  ],
  [
    'src/workspace-host.ts',
    [
      '`Workspace authority returned ',
      ' at ',
      ', but Pi is still bound to ',
      ' at ',
      '; the native tool was not executed.`',
    ],
    'grep',
    'blocked',
  ],
  ['src/work-child-workspace.ts', ["'Child workspace is read-only'"], 'bash', 'blocked'],
  [
    'src/workspace-host.ts',
    ["'Workspace admission requires a host rebind; the command was not executed.'"],
    'bash',
    'blocked',
  ],
  ['src/workspace-shell.ts', ["'the shell did not start'"], 'bash', 'execution'],
  [
    'src/workspace-shell.ts',
    ["'The shell exited before its identity was available'"],
    'bash',
    'execution',
  ],
  ['src/workspace-shell.ts', ["'the shell identity could not be captured'"], 'bash', 'execution'],
  [
    'src/work-controller.ts',
    [
      '`Workspace handoff required before starting work: ',
      '. No command was executed; obtain a fresh host tool decision.`',
    ],
    'work',
    'blocked',
  ],
  ['src/work-controller.ts', ['`', ' is required`'], 'work', 'invocation'],
  ['src/work-controller.ts', ["'prompt is required'"], 'work', 'invocation'],
  [
    'src/workspace-shell.ts',
    ["'Workspace admission changed before the shell started; the command was not executed.'"],
    'bash',
    'blocked',
  ],
  [
    'src/workspace-shell.ts',
    ["'The workspace shell is stopping; the command was not executed.'"],
    'bash',
    'blocked',
  ],
  ['src/workspace-shell.ts', ["'the host is stopping its shells'"], 'bash', 'blocked'],
] as const

const DEV_ANCHORS = [
  ['src/work-protocol.ts', ["const OUTCOME_MESSAGE = 'dev/work-outcome'"]],
  ['src/work-protocol.ts', ['content: `', String.raw`\n`, '`']],
  ['src/workspace-host.ts', ["customType: 'dev/workspace-handoff'"]],
  ['src/workspace-host.ts', ['text: `[dev workspace] ', '`']],
  ['src/pi-child.ts', [String.raw`\n\n[git output truncated at `, ' bytes]']],
  [
    'src/pi-child.ts',
    [
      `const REVIEW_OPERATIONS = [${GIT_INSPECT_OPERATIONS.map(operation => `'${operation}'`).join(', ')}] as const`,
    ],
  ],
] as const

const escapeRegExp = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
const templateOf = (fragments: readonly string[]) =>
  new RegExp(fragments.map(escapeRegExp).join(String.raw`\$\{[^}]*\}`))

const devHome = join(root, 'dev-texts')
{
  const lead = conversation('2026-09-29T10:00:00Z')
  const calls = DEV_TEXTS.map(([, , tool], index) => call(`d${index}`, tool))
  writeSession(devHome, 'sessions', 'dev', [
    lead.header(),
    lead.user('u1', null, 0),
    lead.assistant('a1', 'u1', 10, { calls }),
    ...DEV_TEXTS.map(([, fragments], index) =>
      lead.result(
        `res-d${index}`,
        index === 0 ? 'a1' : `res-d${index - 1}`,
        11,
        calls[index] ?? call('?', '?'),
        { text: fragments.join('value').slice(1, -1), isError: true }
      )
    ),
  ])
}

const digestTree = (directory: string): Record<string, string> =>
  Object.fromEntries(
    readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => {
        const path = join(entry.parentPath, entry.name)
        return [path, createHash('sha256').update(readFileSync(path)).digest('hex')]
      })
      .toSorted(([a], [b]) => (a ?? '').localeCompare(b ?? ''))
  )

const maintain = (...args: string[]) =>
  spawnSync(process.execPath, ['scripts/maintain.ts', 'profile', ...args], {
    cwd: checkout,
    encoding: 'utf8',
  })

const repositoryState = () => ({
  status: execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: checkout,
    encoding: 'utf8',
  }),
  performance: digestTree(join(checkout, 'docs', 'performance')),
})

try {
  await claim(
    'native call and result IDs pair through ancestry; invocation errors, execution failures, blocked, cancelled, unclassified and unmatched calls stay distinct, a failing command stays an execution failure whatever its output says, a failure pairs only with the first call of the same tool in a later response and never with a call of its own response, the pair is only a candidate, and a returned result is never a quality claim',
    async () => {
      const outcome = await profile(toolsHome)
      assert.equal(outcome._tag, 'Success')
      assert.match(
        String(outcome._tag === 'Success' && outcome.success),
        /does not establish task correctness/
      )
      const [summary] = report(toolsHome).periods
      assert.deepEqual(
        {
          invocations: summary.tools.invocations,
          matched: summary.tools.matched,
          unmatchedCalls: summary.tools.unmatchedCalls,
          interruptedUnmatched: summary.tools.interruptedUnmatched,
          unmatchedResults: summary.tools.unmatchedResults,
          outcomes: summary.tools.outcomes,
          candidateSequences: summary.tools.candidateSequences,
        },
        {
          invocations: 19,
          matched: 17,
          unmatchedCalls: 2,
          interruptedUnmatched: 1,
          unmatchedResults: 1,
          outcomes: {
            returned: 5,
            invocation: 3,
            execution: 4,
            blocked: 2,
            cancelled: 1,
            unclassified: 2,
            unmatched: 2,
          },
          candidateSequences: { repeatedErrors: 1, recoveries: 2 },
        }
      )
      const byTool = Object.fromEntries(
        summary.tools.byTool.map((row: { tool: string; outcomes: object }) => [
          row.tool,
          row.outcomes,
        ])
      )
      assert.deepEqual(byTool.read, {
        returned: 1,
        invocation: 1,
        execution: 0,
        blocked: 0,
        cancelled: 0,
        unclassified: 0,
        unmatched: 1,
      })
      assert.deepEqual(byTool.bash, {
        returned: 4,
        invocation: 0,
        execution: 4,
        blocked: 0,
        cancelled: 1,
        unclassified: 0,
        unmatched: 0,
      })
      const { outcomes, candidateSequences, unmatchedResults } = summary.drilldowns
      assert.deepEqual(outcomes.execution.refs, [
        'sessions/tools.jsonl#r-exit',
        'sessions/tools.jsonl#r-failing',
        'sessions/tools.jsonl#r-missing',
        'sessions/tools.jsonl#r-x2',
      ])
      assert.deepEqual(outcomes.invocation.refs, [
        'sessions/tools.jsonl#r-unknown',
        'sessions/tools.jsonl#r-invalid',
        'sessions/tools.jsonl#r-again',
      ])
      assert.deepEqual(outcomes.unmatched.refs, [
        'sessions/tools.jsonl#a1',
        'sessions/tools.jsonl#a3',
      ])
      assert.deepEqual(unmatchedResults.refs, ['sessions/tools.jsonl#r-ghost'])
      assert.deepEqual(candidateSequences, [
        {
          kind: 'recovery',
          tool: 'bash',
          earlier: 'sessions/tools.jsonl#r-exit',
          later: 'sessions/tools.jsonl#r-retry',
        },
        {
          kind: 'repeated-error',
          tool: 'nope',
          earlier: 'sessions/tools.jsonl#r-unknown',
          later: 'sessions/tools.jsonl#r-again',
        },
        {
          kind: 'recovery',
          tool: 'bash',
          earlier: 'sessions/tools.jsonl#r-missing',
          later: 'sessions/tools.jsonl#r-x1',
        },
      ])
    }
  )

  await claim(
    'identical overlapping reads are candidates while disjoint pages are pagination; changed text is not identical; compaction, context edits and own writes are marked; sibling branches, workspace switches and independent agents are not conflated; unknown coverage, failures and truncation stay visible; Git repeats, compound segments and truncation are recognized',
    async () => {
      assert.equal((await profile(readsHome))._tag, 'Success')
      const [summary] = report(readsHome).periods
      assert.deepEqual(summary.reads.relations, {
        first: 6,
        pagination: 1,
        disjoint: 0,
        overlap: 4,
        unknown: 1,
      })
      assert.deepEqual(summary.reads.overlap, {
        identical: 3,
        changed: 1,
        afterCompaction: 2,
        afterContextEdit: 1,
        afterOwnWrite: 1,
        lines: 7,
        bytes: 22,
      })
      assert.equal(summary.reads.calls, 13)
      assert.equal(summary.reads.failed, 1)
      assert.equal(summary.reads.unknownCoverage, 1)
      assert.deepEqual(summary.reads.truncation, { lines: 0, bytes: 1, firstLine: 0 })
      assert.equal(summary.reads.limited, 8)
      assert.deepEqual(summary.reads.crossAgent, { paths: 1, reads: 8 })
      const [top] = summary.drilldowns.reads
      assert.equal(top.path, '/repo/a.ts')
      assert.equal(top.session, 'sessions/lead.jsonl')
      assert.deepEqual([top.reads, top.overlaps, top.identical, top.changed], [7, 4, 3, 1])
      assert.deepEqual(top.calls.slice(0, 4), [
        {
          ref: 'sessions/lead.jsonl#res-r1',
          requested: { start: 1, end: 3 },
          returned: { start: 1, end: 3 },
          relation: 'first',
          earlier: null,
        },
        {
          ref: 'sessions/lead.jsonl#res-r2',
          requested: { start: 4, end: 6 },
          returned: { start: 4, end: 6 },
          relation: 'pagination',
          earlier: null,
        },
        {
          ref: 'sessions/lead.jsonl#res-r3',
          requested: { start: 2, end: 3 },
          returned: { start: 2, end: 3 },
          relation: 'overlap',
          earlier: 'sessions/lead.jsonl#res-r1',
        },
        {
          ref: 'sessions/lead.jsonl#res-r4',
          requested: { start: 1, end: 3 },
          returned: { start: 1, end: 3 },
          relation: 'overlap',
          earlier: 'sessions/lead.jsonl#res-r3',
        },
      ])
      assert.deepEqual(summary.drilldowns.readCoverage, {
        unknown: { total: 1, refs: ['sessions/lead.jsonl#res-r8'] },
        failed: { total: 1, refs: ['sessions/lead.jsonl#res-r10'] },
      })

      const { git } = summary
      assert.deepEqual(
        {
          requests: git.requests,
          whole: git.whole,
          inCompound: git.inCompound,
          truncated: git.truncated,
          repeats: git.repeats,
        },
        {
          requests: 7,
          whole: 6,
          inCompound: 1,
          truncated: 2,
          repeats: { requests: 2, identicalResults: 1, changedResults: 1, unknownResults: 0 },
        }
      )
      assert.deepEqual(git.byOperation, [
        {
          tool: 'bash',
          operation: 'status',
          requests: 3,
          repeats: 1,
          identicalResults: 1,
          truncated: 0,
        },
        {
          tool: 'bash',
          operation: 'diff',
          requests: 2,
          repeats: 1,
          identicalResults: 0,
          truncated: 0,
        },
        {
          tool: 'bash',
          operation: 'log',
          requests: 1,
          repeats: 0,
          identicalResults: 0,
          truncated: 1,
        },
        {
          tool: 'git_inspect',
          operation: 'status',
          requests: 1,
          repeats: 0,
          identicalResults: 0,
          truncated: 1,
        },
      ])
      assert.deepEqual(
        summary.drilldowns.git.map((row: { operation: string; requests: number }) => [
          row.operation,
          row.requests,
        ]),
        [
          ['status', 3],
          ['diff', 2],
        ]
      )
      assert.equal((await profile(gitIdentityHome))._tag, 'Success')
      const [identity] = report(gitIdentityHome).periods
      assert.equal(identity.git.requests, 12)
      assert.deepEqual(identity.git.repeats, {
        requests: 4,
        identicalResults: 3,
        changedResults: 0,
        unknownResults: 1,
      })
      assert.deepEqual(
        identity.drilldowns.git
          .map((group: { session: string; refs: string[] }) => [group.session, group.refs])
          .toSorted(([left]: [string, string[]], [right]: [string, string[]]) =>
            left.localeCompare(right)
          ),
        ['directory', 'environment', 'escaped-space', 'quoted-space'].map(name => [
          `sessions/${name}.jsonl`,
          [`sessions/${name}.jsonl#r0`, `sessions/${name}.jsonl#r2`],
        ])
      )
    }
  )

  await claim(
    'assistant, tool, standalone, compaction and branch-summary usage count once each; reasoning stays inside output; copied fork history is excluded while abandoned branches count; unknown usage is reported apart from zero',
    async () => {
      assert.equal((await profile(usageHome))._tag, 'Success')
      const { sources, periods } = report(usageHome)
      assert.deepEqual(sources, {
        leadFiles: 2,
        childFiles: 0,
        undecodableLines: 1,
        copiedEntries: 4,
      })
      const [{ usage, context, lead }] = periods
      assert.deepEqual(pick(usage.bySource.assistant), {
        entries: 4,
        unknown: 1,
        input: 179,
        output: 33,
        reasoning: 5,
        cacheRead: 500,
        cacheWrite: 400,
      })
      assert.deepEqual(pick(usage.bySource.tool), {
        entries: 1,
        unknown: 0,
        input: 7,
        output: 3,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
      })
      assert.deepEqual(pick(usage.bySource.standalone), {
        entries: 1,
        unknown: 0,
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 1000,
        cacheWrite: 0,
      })
      assert.deepEqual(
        [usage.bySource.compaction.entries, usage.bySource.compaction.unknown],
        [1, 1]
      )
      assert.deepEqual(
        [usage.bySource['branch-summary'].entries, usage.bySource['branch-summary'].unknown],
        [1, 1]
      )
      assert.deepEqual(pick(usage.total), {
        entries: 8,
        unknown: 3,
        input: 526,
        output: 104,
        reasoning: 5,
        cacheRead: 1500,
        cacheWrite: 400,
      })
      assert.equal(usage.total.uncached, 926)
      assert.equal(usage.total.cacheReadShare, 1500 / 2426)
      assert.deepEqual(pick(usage.requests.first), {
        entries: 2,
        unknown: 0,
        input: 120,
        output: 22,
        reasoning: 5,
        cacheRead: 100,
        cacheWrite: 400,
      })
      assert.deepEqual([usage.requests.later.entries, usage.requests.later.unknown], [2, 1])
      assert.deepEqual(context.tokensBefore, { recorded: 1, total: 5000, median: 5000 })
      assert.deepEqual(
        [context.compactions, context.synthesis.entries, context.synthesis.unknown],
        [2, 2, 2]
      )
      assert.deepEqual(context.afterCompaction, { requests: 0, withoutCacheRead: 0 })
      assert.deepEqual(context.initialTokens, { median: 120, p90: 500, max: 500 })
      assert.equal(lead.sessions, 2)
      assert.equal(lead.latency.requests, 5)
      assert.deepEqual(lead.timeSplit, { modelMs: 5000, toolMs: 1000, userMs: 0 })
    }
  )

  await claim(
    'periods include their start and exclude their end; first and later requests, role, model, effort (from the response or the branch thinking level) and skill groups and missing attribution follow the recorded entries; a child-only selection is measurable; an empty period becomes a stated comparison limitation',
    async () => {
      const selection = await Promise.all(
        ['2026-09-30..2026-10-01', '..2026-09-30', '2026-10-02..', '2026-09-01..2026-09-02'].map(
          period
        )
      )
      const outcome = await profile(periodsHome, selection as [Period, ...Period[]])
      assert.equal(outcome._tag, 'Success')
      const { periods, comparison } = report(
        periodsHome,
        '2026-09-30..2026-10-01+..2026-09-30+2026-10-02..+2026-09-01..2026-09-02'
      )
      const [day, before, childOnly, empty] = periods
      assert.deepEqual(day.sample, {
        leadSessions: 1,
        childSessions: 2,
        requests: 4,
        toolCalls: 0,
        firstDate: '2026-09-30',
        lastDate: '2026-09-30',
      })
      assert.deepEqual([day.usage.requests.first.entries, day.usage.requests.first.input], [2, 11])
      assert.deepEqual([day.usage.requests.later.entries, day.usage.requests.later.input], [2, 50])
      assert.deepEqual(
        Object.fromEntries(
          Object.entries(day.usage.byRole as Record<string, { entries: number }>).map(
            ([role, totals]) => [role, totals.entries]
          )
        ),
        { lead: 2, coordinator: 1, leaf: 1, child: 0, unattributed: 0 }
      )
      assert.deepEqual(rows(day.groups.model), { 'fixture/beta': 2, 'fixture/gamma': 2 })
      assert.deepEqual(
        Object.fromEntries(
          day.usage.byEffort.map((row: { effort: string; tokens: { entries: number } }) => [
            row.effort,
            row.tokens.entries,
          ])
        ),
        { unrecorded: 1, low: 1, medium: 1, minimal: 1 }
      )
      assert.deepEqual(rows(day.groups.skill), { 'dev-cycle': 2, review: 1, none: 1 })
      assert.deepEqual(day.attribution, {
        entries: 4,
        modelUnrecorded: 0,
        effortUnrecorded: 1,
        childSessions: 2,
        unattributedChildSessions: 0,
      })
      assert.equal(day.lead.sessions, 1)
      assert.deepEqual(
        [before.sample.requests, before.sample.toolCalls, before.usage.requests.first.entries],
        [1, 1, 1]
      )
      assert.equal(before.lead.children.agentAttempts, 1)
      assert.deepEqual(childOnly.sample, {
        leadSessions: 0,
        childSessions: 1,
        requests: 1,
        toolCalls: 0,
        firstDate: '2026-10-02',
        lastDate: '2026-10-02',
      })
      assert.equal(childOnly.lead, null)
      assert.equal(childOnly.usage.byRole.unattributed.entries, 1)
      assert.equal(childOnly.attribution.unattributedChildSessions, 1)
      assert.equal(empty.sample, null)
      assert.equal(comparison.baseline, '2026-09-30..2026-10-01')
      assert.ok(comparison.limitations.includes('2026-09-01..2026-09-02 has no measurable entries'))
      assert.ok(
        comparison.limitations.some((limitation: string) =>
          limitation.endsWith(
            'rows have no data in at least one period; their changes are not comparable'
          )
        )
      )
      const coordinator = comparison.usage.find(
        (row: { dimension: string; key: string }) =>
          row.dimension === 'role' && row.key === 'coordinator'
      )
      assert.deepEqual(coordinator.periods.slice(1), [null, null, null])

      for (const tool of ['read', 'bash', 'unmatched']) {
        const home = join(root, `result-period-${tool}`)
        const child = conversation('2026-09-29T23:59:00Z')
        const pending = call('pending', tool, { path: '/repo/a.ts', command: 'true' })
        writeSession(home, 'child-sessions', 'child', [
          child.header(),
          child.assistant('a', null, 59, { calls: tool === 'unmatched' ? [] : [pending] }),
          child.result('result', 'a', 60, pending, { text: 'a' }),
          child.result('outside', 'result', 60 + 24 * 3600, call('outside', 'ls')),
        ])
        const selected = maintain('--data-home', home, '--period', '2026-09-30..2026-10-01')
        assert.equal(selected.status, 0, selected.stderr)
        const [resultOnly] = report(home, '2026-09-30..2026-10-01').periods
        assert.deepEqual(resultOnly.sample, {
          leadSessions: 0,
          childSessions: 1,
          requests: 0,
          toolCalls: 0,
          firstDate: '2026-09-30',
          lastDate: '2026-09-30',
        })
        assert.equal(resultOnly.attribution.unattributedChildSessions, 1)
        assert.equal(resultOnly.usage.total.entries, 0)
        assert.equal(resultOnly.usage.total.unknown, 0)
        assert.equal(resultOnly.tools.unmatchedResults, tool === 'unmatched' ? 1 : 0)
        assert.deepEqual(
          resultOnly.drilldowns.unmatchedResults.refs,
          tool === 'unmatched' ? ['child-sessions/child.jsonl#result'] : []
        )
        assert.equal(resultOnly.reads.calls, tool === 'read' ? 1 : 0)
      }
    }
  )

  await claim(
    'the maintenance entrypoint writes only a stable private report under the data home, keeps it on an empty selection, never touches transcripts or the repository, and exports only allowlisted aggregates that the chart renderer accepts',
    async () => {
      const before = repositoryState()
      const sessions = digestTree(join(entryHome, 'sessions'))
      const children = digestTree(join(entryHome, 'child-sessions'))

      const first = maintain('--data-home', entryHome)
      assert.equal(first.status, 0, first.stderr)
      assert.match(first.stdout, /Wrote .*\/usage\/all\.json\n$/)
      assert.deepEqual(readdirSync(join(entryHome, 'usage')), ['all.json'])
      assert.equal(statSync(join(entryHome, 'usage', 'all.json')).mode & 0o777, 0o600)
      const written = readFileSync(join(entryHome, 'usage', 'all.json'), 'utf8')
      for (const name of ['prompt', 'content', 'command', 'error'] as const) {
        assert.ok(!written.includes(SENTINELS[name]), `private report contains the ${name}`)
        assert.ok(!first.stdout.includes(SENTINELS[name]), `terminal report contains the ${name}`)
      }
      assert.ok(written.includes(SENTINELS.path), 'private drilldowns keep the file reference')

      chmodSync(join(entryHome, 'usage', 'all.json'), 0o644)
      const rerun = maintain('--data-home', entryHome)
      assert.equal(rerun.status, 0, rerun.stderr)
      assert.equal(statSync(join(entryHome, 'usage', 'all.json')).mode & 0o777, 0o600)
      assert.equal(readFileSync(join(entryHome, 'usage', 'all.json'), 'utf8'), written)

      chmodSync(join(entryHome, 'usage', 'all.json'), 0o644)
      const empty = maintain('--data-home', entryHome, '--period', '2020-01-01..2020-01-02')
      assert.equal(empty.status, 1)
      assert.match(empty.stderr, /Nothing measurable .* existing reports were not changed/)
      assert.equal(statSync(join(entryHome, 'usage', 'all.json')).mode & 0o777, 0o644)
      assert.deepEqual(readdirSync(join(entryHome, 'usage')), ['all.json'])
      assert.equal(readFileSync(join(entryHome, 'usage', 'all.json'), 'utf8'), written)

      for (const [refused, reason] of [
        [
          maintain('--data-home', entryHome, '--period', '2026-09-30..2026-09-29'),
          /Empty period "2026-09-30\.\.2026-09-29"/,
        ],
        [
          maintain('--data-home', entryHome, '--since', '2026-09-30'),
          /Unknown profile option "--since"/,
        ],
        [
          maintain(
            '--data-home',
            entryHome,
            '--period',
            '..2026-09-30',
            '--period',
            '2026-09-30..',
            '--export',
            join(root, 'refused')
          ),
          /An export takes exactly one period; nothing was written/,
        ],
      ] as const) {
        assert.equal(refused.status, 1, refused.stdout)
        assert.match(refused.stderr, reason)
      }
      assert.throws(() => readdirSync(join(root, 'refused')))

      const exportDirectory = join(root, 'export')
      const exported = maintain('--data-home', entryHome, '--export', exportDirectory)
      assert.equal(exported.status, 0, exported.stderr)
      assert.deepEqual(readdirSync(exportDirectory).toSorted(), [
        'tools.svg',
        'usage-baseline.json',
        'usage.svg',
      ])
      const files = Object.fromEntries(
        readdirSync(exportDirectory).map(name => [
          name,
          readFileSync(join(exportDirectory, name), 'utf8'),
        ])
      )
      for (const [file, content] of Object.entries(files))
        for (const [name, sentinel] of Object.entries(SENTINELS))
          assert.ok(
            !content.toLowerCase().includes(sentinel.toLowerCase()),
            `${file} contains the ${name}`
          )
      assert.ok(!(files['usage-baseline.json'] ?? '').includes('sessions/'))
      const aggregate = JSON.parse(files['usage-baseline.json'] ?? '')
      assert.deepEqual(
        aggregate.tools.byTool.map((row: { tool: string }) => row.tool),
        ['read', 'bash', 'other']
      )
      assert.deepEqual(
        aggregate.lead.toolResults.byTool.map((row: { tool: string }) => row.tool),
        ['read', 'bash', 'other']
      )
      assert.deepEqual(aggregate.usage.byEffort, [
        { effort: 'unrecorded', tokens: aggregate.usage.total },
      ])
      for (const value of [
        '44.4%',
        'Tool calls success',
        '>80.0%<',
        '20.0% with error',
        '0.00',
        '2.0 s',
        'mean per lead result',
        '1 lead and 1 child sessions, 2026-09-29 to 2026-09-30',
      ])
        assert.ok(files['usage.svg']?.includes(value), `usage.svg lacks ${value}`)
      for (const value of [
        'Share of tool result bytes, lead sessions',
        '5 results from 1 lead sessions',
        '>read<',
        '>other<',
        '>bash<',
      ])
        assert.ok(files['tools.svg']?.includes(value), `tools.svg lacks ${value}`)

      for (const [home, args, noError, withError] of [
        [toolsHome, [], '29.4%', '70.6%'],
        [periodsHome, ['--period', '2026-10-02..'], 'n/a', 'n/a'],
      ] as const) {
        const result = maintain('--data-home', home, ...args, '--export', exportDirectory)
        assert.equal(result.status, 0, result.stderr)
        const chart = readFileSync(join(exportDirectory, 'usage.svg'), 'utf8')
        assert.match(
          chart,
          new RegExp(
            String.raw`>Tool calls success</text>\s*<text[^>]*>${escapeRegExp(noError)}</text>`
          )
        )
        assert.ok(chart.includes(`>${withError} with error<`))
        assert.ok(!chart.includes('Tool calls: all sessions;'))
        assert.ok(!chart.includes('median per lead session'))
      }
      assert.deepEqual(digestTree(join(entryHome, 'sessions')), sessions)
      assert.deepEqual(digestTree(join(entryHome, 'child-sessions')), children)
      assert.deepEqual(repositoryState(), before)
    }
  )
  await claim(
    "a relative read resolves against the cwd Pi recorded in a prompt or compaction checkpoint, kept across patches that do not restate it and separated by a cwd change; a reread spanning several earlier pages overlaps all of them; a truncation notice without Pi's details and an unprocessed image have unknown coverage and a first line too long to return has an unknown relation; git counts at command position outside quotes, heredocs and comments, inside substitutions and conditions and past option values, a cd or workspace switch separates repeats, truncated results never compare, unknown operations are never copied, negative usage is unknown, and a parent cycle cannot hang the walk",
    async () => {
      assert.equal((await profile(edgesHome))._tag, 'Success')
      const written = readFileSync(join(edgesHome, 'usage', 'all.json'), 'utf8')
      for (const copied of ['SECRET-OPERATION', 'zzworktree', 'frobnicate', 'push'])
        assert.ok(!written.includes(copied), `private report contains ${copied}`)
      const [summary] = JSON.parse(written).periods
      assert.deepEqual(
        [summary.usage.bySource.assistant.entries, summary.usage.bySource.assistant.unknown],
        [10, 1]
      )
      assert.deepEqual(
        {
          calls: summary.reads.calls,
          unknownCoverage: summary.reads.unknownCoverage,
          relations: summary.reads.relations,
          overlap: summary.reads.overlap,
          truncation: summary.reads.truncation,
          limited: summary.reads.limited,
        },
        {
          calls: 12,
          unknownCoverage: 2,
          relations: { first: 4, pagination: 2, disjoint: 0, overlap: 2, unknown: 4 },
          overlap: {
            identical: 2,
            changed: 0,
            afterCompaction: 0,
            afterContextEdit: 0,
            afterOwnWrite: 0,
            lines: 8,
            bytes: 22,
          },
          truncation: { lines: 0, bytes: 0, firstLine: 2 },
          limited: 6,
        }
      )
      const row = (path: string) =>
        summary.drilldowns.reads.find((candidate: { path: string }) => candidate.path === path)
      const [pages, checkpoint, wide, numeric] = [
        row('src/x.ts'),
        row('src/y.ts'),
        row('/work/a/wide.txt'),
        row('/work/c/z.ts'),
      ]
      assert.deepEqual(
        numeric.calls.map((read: { requested: object; relation: string }) => [
          read.requested,
          read.relation,
        ]),
        [
          [{ start: 1, end: 2 }, 'first'],
          [{ start: 3, end: 3 }, 'pagination'],
        ]
      )
      assert.equal(pages.path, 'src/x.ts')
      assert.equal(checkpoint.path, 'src/y.ts')
      assert.deepEqual(
        checkpoint.calls.map((read: { relation: string }) => read.relation),
        ['first', 'overlap']
      )
      assert.deepEqual(
        pages.calls.map((read: { relation: string; earlier: string | null }) => [
          read.relation,
          read.earlier,
        ]),
        [
          ['first', null],
          ['pagination', null],
          ['overlap', 'sessions/edges.jsonl#res-p2'],
        ]
      )
      assert.equal(wide.path, '/work/a/wide.txt')
      assert.deepEqual(
        wide.calls.map((read: { relation: string; returned: object }) => [
          read.relation,
          read.returned,
        ]),
        [
          ['unknown', { start: 1, end: 0 }],
          ['unknown', { start: 1, end: 0 }],
        ]
      )
      assert.deepEqual(summary.drilldowns.readCoverage.unknown.refs, [
        'sessions/edges.jsonl#res-t1',
        'sessions/edges.jsonl#res-t2',
      ])
      assert.deepEqual(
        {
          requests: summary.git.requests,
          whole: summary.git.whole,
          inCompound: summary.git.inCompound,
          repeats: summary.git.repeats,
          byOperation: summary.git.byOperation,
        },
        {
          requests: 24,
          whole: 8,
          inCompound: 16,
          repeats: { requests: 3, identicalResults: 0, changedResults: 0, unknownResults: 3 },
          byOperation: [
            {
              tool: 'bash',
              operation: 'status',
              requests: 10,
              repeats: 2,
              identicalResults: 0,
              truncated: 0,
            },
            {
              tool: 'bash',
              operation: 'diff',
              requests: 5,
              repeats: 1,
              identicalResults: 0,
              truncated: 2,
            },
            {
              tool: 'bash',
              operation: 'rev-parse',
              requests: 2,
              repeats: 0,
              identicalResults: 0,
              truncated: 0,
            },
            ...['branch', 'commit', 'log', 'merge-base', 'other', 'show'].map(operation => ({
              tool: 'bash',
              operation,
              requests: 1,
              repeats: 0,
              identicalResults: 0,
              truncated: 0,
            })),
            {
              tool: 'git_inspect',
              operation: 'invalid',
              requests: 1,
              repeats: 0,
              identicalResults: 0,
              truncated: 0,
            },
          ],
        }
      )
      assert.ok(
        summary.drilldowns.git.some(
          (group: { refs: readonly string[] }) =>
            group.refs.join(',') === 'sessions/edges.jsonl#res-g19,sessions/edges.jsonl#res-g20'
        ),
        'the plain git status after a subshell cd repeats only the later plain git status'
      )
      assert.equal(summary.tools.unmatchedResults, 2)
    }
  )

  await claim(
    "dev's refusal, validation and notice texts still read as the profiler expects in their src/ owners, and each refusal classifies as its outcome",
    async () => {
      for (const [file, fragments] of [...DEV_TEXTS, ...DEV_ANCHORS])
        assert.match(readFileSync(join(checkout, file), 'utf8'), templateOf(fragments), file)
      assert.equal((await profile(devHome))._tag, 'Success')
      const [summary] = report(devHome).periods
      const expected = (outcome: string) => DEV_TEXTS.filter(text => text[3] === outcome).length
      assert.deepEqual(summary.tools.outcomes, {
        returned: 0,
        invocation: expected('invocation'),
        execution: expected('execution'),
        blocked: expected('blocked'),
        cancelled: 0,
        unclassified: 0,
        unmatched: 0,
      })
    }
  )

  console.log(JSON.stringify({ result: 'passed', checks: passed }, null, 2))
} finally {
  rmSync(root, { recursive: true, force: true })
}
