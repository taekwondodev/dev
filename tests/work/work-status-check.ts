import assert from 'node:assert/strict'
import { type AttemptView, decodeAttemptRecord, type WorkSnapshot } from '../../src/work-domain.ts'
import { activeWorkChildren, workStatusText } from '../../src/work-status.ts'
import { makeClaims } from '../workspace/workspace-check-support.ts'

const { claim, passed } = makeClaims()

const attemptId = (index: number) => `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`
const usage = (total: number) => ({
  input: total,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total,
  cost: 0,
  userMessages: 1,
  assistantMessages: 1,
  toolCalls: 0,
  toolResults: 0,
})

interface ChildFacts {
  readonly index: number
  readonly taskId: string
  readonly status?: 'running' | 'waiting' | 'completed'
  readonly skill?: string
  readonly access?: 'read-only' | 'write'
  readonly coordinator?: boolean
  readonly parent?: number
  readonly model?: string
  readonly percent?: number
  readonly tokens?: number
}

const child = (facts: ChildFacts): AttemptView =>
  decodeAttemptRecord({
    revision: 1,
    id: attemptId(facts.index),
    startedAt: 1,
    kind: 'agent',
    cwd: '/repo',
    controllerPid: 1,
    owner: {
      sessionId: 'session',
      taskId: facts.taskId,
      attemptId: attemptId(facts.index),
      generation: 'generation',
      ...(facts.parent === undefined ? {} : { parent: attemptId(facts.parent) }),
    },
    access: facts.access ?? 'read-only',
    ...(facts.coordinator === true ? { coordinator: true } : {}),
    status: facts.status ?? 'running',
    ...(facts.status === 'completed' ? { completedAt: 2 } : {}),
    ...(facts.model === undefined ? {} : { model: facts.model }),
    ...(facts.percent === undefined
      ? {}
      : { context: { tokens: 1, contextWindow: 100, percent: facts.percent } }),
    ...(facts.tokens === undefined ? {} : { usage: usage(facts.tokens) }),
    ...(facts.skill === undefined
      ? {}
      : {
          resources: {
            packageVersion: '1.0.4',
            cwd: '/repo',
            access: facts.access ?? 'read-only',
            profile: 'fixture',
            resources: [],
            invokedSkill: { name: facts.skill, path: `/skills/${facts.skill}/SKILL.md` },
            tools: [],
          },
        }),
  })

const snapshot = (records: readonly AttemptView[], agentsBlocked = false): WorkSnapshot => ({
  records,
  unavailable: [],
  agentsBlocked,
})

await claim(
  'child activity includes running and waiting leaves but not commands or settled children',
  () => {
    const running = child({ index: 1, taskId: 'running' })
    const waiting = child({ index: 2, taskId: 'waiting', status: 'waiting', parent: 1 })
    const completed = child({ index: 3, taskId: 'done', status: 'completed' })
    const command = decodeAttemptRecord({
      revision: 1,
      id: attemptId(4),
      startedAt: 1,
      kind: 'process',
      cwd: '/repo',
      controllerPid: 1,
      owner: {
        sessionId: 'session',
        taskId: 'command',
        attemptId: attemptId(4),
        generation: 'generation',
      },
      status: 'running',
    })
    assert.deepEqual(activeWorkChildren(snapshot([running, waiting, completed, command])), [
      running,
      waiting,
    ])
    assert.deepEqual(activeWorkChildren(snapshot([completed, command])), [])
    assert.deepEqual(activeWorkChildren(snapshot([])), [])
  }
)

await claim('an active child is titled by the skill it invoked', () => {
  const text = workStatusText(
    snapshot([
      child({
        index: 1,
        taskId: 'look-around',
        skill: 'arena',
        model: 'anthropic/claude-opus-5-5',
        percent: 12.3,
        tokens: 48_210,
      }),
    ]),
    false
  )
  assert.equal(text, '1 running │ arena opus-5-5 12% │ 48k tok')
})

await claim('a child without a skill is titled by its role', () => {
  const text = workStatusText(
    snapshot([
      child({ index: 1, taskId: 'a', model: 'openai/gpt-6-luna', percent: 8 }),
      child({ index: 2, taskId: 'b', access: 'write', model: 'openai/gpt-6-luna', percent: 40 }),
      child({ index: 3, taskId: 'c', coordinator: true, access: 'write' }),
    ]),
    false
  )
  assert.equal(
    text,
    '3 running │ reader gpt-6-luna 8% · writer gpt-6-luna 40% · coordinator model pending ctx ? │ tok unavailable'
  )
})

await claim('children of the same type are told apart by their task', () => {
  const text = workStatusText(
    snapshot([
      child({ index: 1, taskId: 'fix-footer', skill: 'arena', model: 'p/m', percent: 1 }),
      child({ index: 2, taskId: 'docs', skill: 'arena', model: 'p/m', percent: 2 }),
      child({ index: 3, taskId: 'other', skill: 'code-review', model: 'p/m', percent: 3 }),
    ]),
    false
  )
  assert.equal(
    text,
    '3 running │ arena (fix-footer) m 1% · arena (docs) m 2% · code-review m 3% │ tok unavailable'
  )
})

await claim('a leaf is titled after its coordinator type, even once the parent settled', () => {
  const coordinator = child({ index: 1, taskId: 'plan', skill: 'arena', coordinator: true })
  const leaf = child({ index: 2, taskId: 'r', skill: 'code-review', parent: 1, model: 'p/m' })
  const orphan = child({ index: 3, taskId: 'x', parent: 9, model: 'p/m' })
  assert.equal(
    workStatusText(snapshot([coordinator, leaf, orphan]), false),
    '3 running │ arena model pending ctx ? · arena>code-review m ctx ? · coordinator>reader m ctx ? │ tok unavailable'
  )
})

await claim('settled children count in states and usage but are not listed', () => {
  const text = workStatusText(
    snapshot([
      child({ index: 1, taskId: 'a', status: 'completed', skill: 'arena', tokens: 2_000_000 }),
      child({
        index: 2,
        taskId: 'b',
        status: 'waiting',
        skill: 'grilling',
        model: 'p/m',
        percent: 50,
      }),
      child({ index: 3, taskId: 'c', status: 'completed' }),
    ]),
    false
  )
  assert.equal(text, '2 completed · 1 waiting │ grilling m 50% │ 2.0M tok (2 unavailable)')
})

await claim('blocked agents and suspended reactivation remain visible', () => {
  assert.equal(
    workStatusText(snapshot([], true), true),
    'subscription exhausted; agents blocked │ lead failed; automatic reactivation suspended'
  )
  assert.equal(workStatusText(snapshot([]), false), undefined)
})

console.log(JSON.stringify({ result: 'passed', checks: passed }, null, 2))
