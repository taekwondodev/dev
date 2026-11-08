import assert from 'node:assert/strict'
import { Effect, Result } from 'effect'
import type * as Pi from '@earendil-works/pi-coding-agent'
import {
  type ActivityClock,
  type ActivityState,
  initialActivity,
  liveLevel,
  makeActivitySender,
  reduceActivity,
  toolTarget,
} from '../../src/work-child-activity.ts'
import type { ChildLive } from '../../src/work-domain.ts'
import { parseChildMessage } from '../../src/work-protocol.ts'
import { makeClaims } from '../workspace/workspace-check-support.ts'

const { claim, passed } = makeClaims()

const assistant = { role: 'assistant' }
const event = (value: { readonly type: string } & Record<string, unknown>) =>
  value as unknown as Pi.AgentSessionEvent
const update = (type: string) =>
  event({ type: 'message_update', message: assistant, assistantMessageEvent: { type } })
const toolStart = (id: string, toolName: string, args: unknown) =>
  event({ type: 'tool_execution_start', toolCallId: id, toolName, args })
const toolEnd = (id: string, toolName: string) =>
  event({ type: 'tool_execution_end', toolCallId: id, toolName, result: {}, isError: false })
const turnEnd = event({ type: 'turn_end', message: assistant, toolResults: [] })
const messageEnd = event({ type: 'message_end', message: assistant })

const fold = (events: readonly Pi.AgentSessionEvent[], from: ActivityState = initialActivity) =>
  events.reduce(reduceActivity, from)

const sent = (events: readonly Pi.AgentSessionEvent[]): ChildLive[] => {
  const levels: ChildLive[] = []
  let state = initialActivity
  for (const item of events) {
    const next = reduceActivity(state, item)
    if (next === state) continue
    state = next
    const level = liveLevel(next)
    if (JSON.stringify(levels.at(-1)) !== JSON.stringify(level)) levels.push(level)
  }
  return levels
}

await claim(
  'a turn folds into thinking, writing, a running tool and a counted turn, and chunk bursts change nothing',
  () => {
    const thinking = fold([update('start'), update('thinking_start')])
    assert.deepEqual(liveLevel(thinking), { turns: 0, activity: { kind: 'thinking' } })
    const burst = Array.from({ length: 500 }, (_, index) =>
      update(index % 2 === 0 ? 'thinking_delta' : 'text_delta')
    )
    assert.equal(fold(burst, thinking), thinking, 'deltas return the same state')
    assert.deepEqual(
      sent([
        update('thinking_start'),
        ...burst,
        update('thinking_end'),
        update('text_start'),
        ...burst,
        update('toolcall_start'),
        update('toolcall_delta'),
        messageEnd,
        toolStart('t1', 'read', { path: 'src/work-view.ts' }),
        toolEnd('t1', 'read'),
        turnEnd,
      ]),
      [
        { turns: 0, activity: { kind: 'thinking' } },
        { turns: 0, activity: { kind: 'writing' } },
        { turns: 0 },
        { turns: 0, activity: { kind: 'tool', name: 'read', target: 'src/work-view.ts' } },
        { turns: 0 },
        { turns: 1 },
      ]
    )
  }
)

await claim(
  'a nested tool shows over its parent and the parent returns when it ends; agent end clears tools',
  () => {
    const outer = fold([toolStart('c', 'codemode', { code: 'await tools.read(...)' })])
    const inner = fold([toolStart('r', 'read', { path: 'a.md' })], outer)
    assert.deepEqual(liveLevel(inner).activity, { kind: 'tool', name: 'read', target: 'a.md' })
    assert.deepEqual(liveLevel(fold([toolEnd('r', 'read')], inner)).activity, {
      kind: 'tool',
      name: 'codemode',
    })
    assert.deepEqual(liveLevel(fold([event({ type: 'agent_end', messages: [] })], inner)), {
      turns: 0,
    })
  }
)

await claim(
  'a provider retry shows its redacted message until the retry ends or the model streams again',
  () => {
    const retrying = fold([
      event({
        type: 'auto_retry_start',
        attempt: 1,
        maxAttempts: 3,
        delayMs: 1000,
        errorMessage: 'overloaded; api_key=abc123secret',
      }),
    ])
    assert.deepEqual(liveLevel(retrying).activity, {
      kind: 'retrying',
      message: 'overloaded; api_key=[redacted]',
    })
    assert.deepEqual(
      liveLevel(fold([event({ type: 'auto_retry_end', success: true, attempt: 1 })], retrying)),
      { turns: 0 }
    )
    assert.deepEqual(liveLevel(fold([update('text_start')], retrying)).activity, {
      kind: 'writing',
    })
  }
)

await claim(
  'targets come from an allowlist: paths, patterns, git operations and credential-free URLs, never bash or codemode text, with secrets and opaque URL path segments redacted, capped at 120 characters',
  () => {
    assert.equal(toolTarget('read', { path: 'docs/work.md', offset: 1 }), 'docs/work.md')
    assert.equal(toolTarget('ls', { path: 'src' }), 'src')
    assert.equal(toolTarget('edit', { path: 'a.ts', edits: [{ oldText: 'k' }] }), 'a.ts')
    assert.equal(toolTarget('write', { path: 'b.ts', content: 'TOKEN=1' }), 'b.ts')
    assert.equal(toolTarget('grep', { pattern: 'workView', path: 'src' }), 'workView')
    assert.equal(toolTarget('find', { pattern: '*.ts' }), '*.ts')
    assert.equal(
      toolTarget('git_inspect', { operation: 'diff', path: 'src/a.ts' }),
      'diff src/a.ts'
    )
    assert.equal(toolTarget('git_inspect', { operation: 'status' }), 'status')
    assert.equal(
      toolTarget('read_url', {
        url: 'https://user:pass@docs.example/guide?token=secret#part',
      }),
      'https://docs.example/guide'
    )
    assert.equal(
      toolTarget('read_url', {
        url: 'https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage',
      }),
      'https://api.telegram.org/[redacted]/sendMessage'
    )
    assert.equal(
      toolTarget('read_url', {
        url: 'https://hooks.slack.com/services/T0123/B0456/abcDEF123456ghiJKL789xyz',
      }),
      'https://hooks.slack.com/services/T0123/B0456/[redacted]'
    )
    assert.equal(
      toolTarget('read_url', { url: 'https://docs.example/getting-started-with-effect' }),
      'https://docs.example/getting-started-with-effect'
    )
    assert.equal(toolTarget('grep', { pattern: 'api_key=abc123' }), 'api_key=[redacted]')
    assert.equal(
      toolTarget('read', { path: 'keys/sk-abcdefghijklmnop.txt' }),
      'keys/[redacted].txt'
    )
    assert.equal(toolTarget('read_url', { url: 'not a url' }), undefined)
    assert.equal(toolTarget('bash', { command: 'curl -H "Authorization: secret"' }), undefined)
    assert.equal(toolTarget('codemode', { code: 'const token = "secret"' }), undefined)
    assert.equal(toolTarget('work', { action: 'delegate', prompt: 'private' }), undefined)
    assert.equal(toolTarget('read', { path: 42 }), undefined)
    assert.equal(toolTarget('read', undefined), undefined)
    const long = toolTarget('read', { path: `${'🙂'.repeat(70)}\nnext` })
    assert.ok(long !== undefined && long.length <= 120 && !long.includes('�'))
    assert.equal(toolTarget('read', { path: 'a\nb\tc' }), 'a b c')
    const level = liveLevel(fold([toolStart('b', 'bash', { command: 'echo secret' })]))
    assert.deepEqual(level.activity, { kind: 'tool', name: 'bash' })
  }
)

await claim(
  'the sender sends changes only, on the leading edge, at most once per interval, with the latest level winning',
  () => {
    let now = 0
    let pending: (() => void) | undefined
    const delays: number[] = []
    const clock: ActivityClock = {
      now: () => now,
      schedule: (run, delayMs) => {
        delays.push(delayMs)
        pending = run
        return () => {
          pending = undefined
        }
      },
    }
    const out: ChildLive[] = []
    const sender = makeActivitySender(level => out.push(level), clock)
    const thinking: ChildLive = { turns: 0, activity: { kind: 'thinking' } }
    sender.offer(thinking)
    assert.deepEqual(out, [thinking], 'leading edge')
    sender.offer(thinking)
    now = 50
    sender.offer({ turns: 0, activity: { kind: 'writing' } })
    sender.offer({ turns: 0 })
    sender.offer({ turns: 1 })
    assert.equal(out.length, 1, 'held within the interval')
    now = 200
    pending?.()
    assert.deepEqual(out, [thinking, { turns: 1 }], 'latest wins')
    now = 260
    sender.offer({ turns: 1, activity: { kind: 'writing' } })
    sender.offer({ turns: 1 })
    now = 400
    pending?.()
    assert.equal(out.length, 2, 'a change undone within the interval sends nothing')
    now = 1000
    sender.offer({ turns: 2 })
    assert.deepEqual(out.at(-1), { turns: 2 })
    sender.stop()
    now = 2000
    sender.offer({ turns: 3 })
    assert.equal(out.length, 3, 'nothing after stop')
    assert.deepEqual(delays, [150, 140])
  }
)

const parse = (value: unknown) =>
  Effect.runSync(Effect.result(parseChildMessage(value, { cwd: '/repo', sessionDir: '/s' })))

await claim(
  'the activity message is accepted, extra keys are rejected, and progress still rejects live keys',
  () => {
    const accepted = parse({
      type: 'activity',
      turns: 2,
      activity: { kind: 'tool', name: 'read', target: 'a.md' },
    })
    assert.ok(Result.isSuccess(accepted))
    assert.ok(Result.isSuccess(parse({ type: 'activity', turns: 0 })))
    for (const rejected of [
      { type: 'activity', turns: 1, usage: {} },
      { type: 'activity', turns: -1 },
      {
        type: 'activity',
        turns: 1,
        activity: { kind: 'tool', name: 'read', target: 'x'.repeat(121) },
      },
      { type: 'activity', turns: 1, activity: { kind: 'sleeping' } },
      { type: 'progress', turns: 1 },
      { type: 'progress', activity: { kind: 'thinking' } },
    ])
      assert.ok(Result.isFailure(parse(rejected)), JSON.stringify(rejected))
  }
)

console.log(JSON.stringify({ result: 'passed', checks: passed }, null, 2))
