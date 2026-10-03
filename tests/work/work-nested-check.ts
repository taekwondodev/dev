import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Effect, Schema } from 'effect'
import { executeWork, type summary } from '../../src/work-actions.ts'
import { asAttemptId, type AttemptView } from '../../src/work-domain.ts'
import { ControllerWorkMessageSchema, trackOutcomeAttempts } from '../../src/work-protocol.ts'
import { WorkspaceError, type WorkspaceAttachment } from '../../src/workspace-domain.ts'
import {
  loadInstalledPi,
  makeClaims,
  toolCall,
  waitFor,
} from '../workspace/workspace-check-support.ts'
import { openWorkFixture, script, settled } from './work-check-support.ts'
import {
  CHILD_MODEL,
  DROP_FIRST_ACK,
  ipcLog,
  RAW_AFTER_REPLY_MARKER,
  RAW_MARKER,
  RAW_ON_CANCEL_MARKER,
  USAGE_MARKER,
} from './work-child-model.ts'

const SLOW_ADMISSION_MS = 7000
const count = (text: string, part: string): number => text.split(part).length - 1
const GATE_WARNING = 'Workspace gate release deferred: injected'
const say = (text: string) => [{ type: 'text', text }]
const slow = (delayMs: number) => ({ delayMs, content: say('slow reply') })
type ToolInput = Parameters<typeof toolCall>[2]
const work = (id: string, input: ToolInput) => toolCall(id, 'work', input)
const delegation = (taskId: string, prompt: string, extra: ToolInput = {}): ToolInput => ({
  action: 'delegate',
  taskId,
  prompt,
  rule: 'default',
  model: CHILD_MODEL,
  ...extra,
})
const phase = (title: string, ...steps: readonly unknown[]): string =>
  `${title}\n${script([...steps, say('waiting for the leaves')])}`
const raw = (marker: string, messages: readonly unknown[]): string =>
  `${marker}${JSON.stringify(messages)}`
const decodeReply = Schema.decodeUnknownSync(Schema.fromJsonString(ControllerWorkMessageSchema))
const replies = (dataHome: string, id: string) => {
  const file = ipcLog(dataHome, id)
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => decodeReply(line))
    : []
}
const refusal = (dataHome: string, id: string, requestId: string): string => {
  const [reply] = replies(dataHome, id).flatMap(candidate =>
    candidate.type === 'work-reply' && candidate.requestId === requestId ? [candidate] : []
  )
  assert.ok(reply !== undefined && !reply.ok, JSON.stringify(reply))
  return reply.error
}
const running = (record: AttemptView): boolean => record.status === 'running'
const completedAt = (record: AttemptView): number => record.completedAt ?? Number.NaN

const { claim, passed } = makeClaims(180_000)

const fixture = await openWorkFixture('work-nested')
try {
  await claim(
    'incremental outcome receipts follow the active raw Pi branch after append, navigation and reset',
    async () => {
      const { pi } = await loadInstalledPi()
      const session = pi.SessionManager.inMemory(fixture.repository)
      const first = asAttemptId('00000000-0000-0000-0000-000000000001')
      const second = asAttemptId('00000000-0000-0000-0000-000000000002')
      const root = session.appendMessage({ role: 'user', content: 'assignment', timestamp: 0 })
      const firstReceipt = session.appendCustomMessageEntry('dev/work-outcome', 'first', true, {
        attempts: [first],
      })
      let reads = 0
      const receipts = trackOutcomeAttempts({
        getLeafEntry: () => session.getLeafEntry(),
        getEntry: id => {
          reads += 1
          return session.getEntry(id)
        },
      })
      assert.deepEqual([...receipts()], [first])
      reads = 0
      assert.deepEqual([...receipts()], [first])
      assert.equal(reads, 0, 'an unchanged branch must not be traversed again')
      session.appendMessage({ role: 'user', content: 'next turn', timestamp: 1 })
      const secondReceipt = session.appendCustomMessageEntry('dev/work-outcome', 'second', true, {
        attempts: [second],
      })
      assert.deepEqual([...receipts()].toSorted(), [first, second])
      assert.ok(reads <= 2, 'appending two entries must not traverse their existing history')
      session.appendCompaction('receipts summarized', secondReceipt, 1000)
      session.appendContextEdit(secondReceipt, null)
      assert.equal(
        session.buildSessionProjection().messages.some(message => message.role === 'custom'),
        false
      )
      assert.deepEqual(
        [...receipts()].toSorted(),
        [first, second],
        'context replacement must not erase raw-branch delivery receipts'
      )
      session.branch(firstReceipt)
      assert.deepEqual([...receipts()], [first])
      session.branch(root)
      session.appendCustomMessageEntry('dev/work-outcome', 'alternate', true, {
        attempts: [second],
      })
      assert.deepEqual([...receipts()], [second])
      session.branch(secondReceipt)
      assert.deepEqual([...receipts()].toSorted(), [first, second])
      session.resetLeaf()
      assert.deepEqual([...receipts()], [])
    }
  )

  const owner = fixture.openOwner('general')
  try {
    await claim(
      'writing children edit external files but cannot write another checkout; read-only children cannot change external files',
      async () => {
        const paths = [
          join(fixture.root, 'external-tmp', 'repro.py'),
          join(fixture.home, '.config', 'fixture', 'settings.txt'),
        ]
        const writer = await owner.run({
          taskId: 'external-native-writer',
          access: 'write',
          prompt: phase(
            'external native writes',
            paths.map((path, i) => toolCall(`write-${i}`, 'write', { path, content: 'one' })),
            paths.map((path, i) =>
              toolCall(`edit-${i}`, 'edit', { path, oldText: 'one', newText: 'two' })
            ),
            [
              toolCall('foreign', 'write', {
                path: join(fixture.repository, 'foreign.txt'),
                content: 'forbidden',
              }),
            ]
          ),
        })
        assert.equal(writer.view.status, 'completed', writer.view.error)
        for (const path of paths) {
          assert.ok(existsSync(path), writer.text)
          assert.equal(readFileSync(path, 'utf8'), 'two')
        }
        assert.ok(!existsSync(join(fixture.repository, 'foreign.txt')))
        const reader = await owner.run({
          taskId: 'external-native-reader',
          access: 'read-only',
          prompt: phase(
            'attempt external writes',
            [toolCall('readonly-write', 'write', { path: paths[0], content: 'forbidden' })],
            [
              toolCall('readonly-edit', 'edit', {
                path: paths[1],
                oldText: 'two',
                newText: 'forbidden',
              }),
            ]
          ),
        })
        assert.equal(reader.view.status, 'completed', reader.view.error)
        assert.equal(reader.view.resources?.tools.includes('write'), false)
        assert.equal(reader.view.resources?.tools.includes('edit'), false)
        for (const path of paths) assert.equal(readFileSync(path, 'utf8'), 'two')
      }
    )
    await claim(
      'a delayed leaf outcome resumes only its coordinator, no coordinator result arrives while its leaf is live, and only coordinator outcomes reach the lead',
      async () => {
        const held = await owner.delegate({
          taskId: 'held',
          coordinate: true,
          prompt: phase('Held phase', [
            work('d', delegation('slow-leaf', `Slow leaf\n${script([slow(6000)])}`)),
          ]),
        })
        const free = await owner.delegate({
          taskId: 'free',
          coordinate: true,
          prompt: phase('Free phase', [work('d', delegation('quick-leaf', 'Quick leaf'))]),
        })
        const freeView = await owner.outcome(free.id)
        const heldView = await owner.outcome(held.id)
        const quickLeaf = await owner.leaf(free.id, 'quick-leaf', settled)
        const slowLeaf = await owner.leaf(held.id, 'slow-leaf', settled)
        assert.deepEqual(
          [freeView.status, heldView.status, quickLeaf.status, slowLeaf.status],
          ['completed', 'completed', 'completed', 'completed']
        )
        const freeText = await owner.result(free.id)
        const heldText = await owner.result(held.id)
        assert.equal(count(freeText, 'Leaf outcomes.'), 1)
        assert.equal(count(heldText, 'Leaf outcomes.'), 1)
        const [, freeLater = ''] = freeText.split('LATER-MESSAGES')
        const [, heldLater = ''] = heldText.split('LATER-MESSAGES')
        assert.ok(freeLater.includes(quickLeaf.id) && !freeLater.includes(slowLeaf.id))
        assert.ok(heldLater.includes(slowLeaf.id) && !heldLater.includes(quickLeaf.id))
        assert.ok(
          completedAt(freeView) < completedAt(slowLeaf),
          'the free coordinator waited for another branch'
        )
        assert.ok(
          completedAt(heldView) >= completedAt(slowLeaf),
          'the held coordinator reported before its leaf settled'
        )
        const delivered = owner.delivered()
        assert.ok(delivered.includes(free.id) && delivered.includes(held.id))
        assert.ok(!delivered.includes(quickLeaf.id) && !delivered.includes(slowLeaf.id))
      }
    )

    await claim('a repeated leaf outcome delivery adds no second message', async () => {
      const { view, text } = await owner.run({
        taskId: 'repeated',
        coordinate: true,
        prompt: phase(`Repeated phase ${DROP_FIRST_ACK}`, [
          work('d', delegation('once', 'Leaf once')),
        ]),
      })
      assert.equal(view.status, 'completed', view.error)
      assert.equal(count(text, 'Leaf outcomes.'), 1)
      const offered = replies(fixture.dataHome, view.id).filter(
        reply => reply.type === 'work-pending' && reply.outcomes.length > 0
      )
      assert.ok(offered.length >= 2, 'the unacknowledged outcome was not offered again')
    })

    await claim(
      'an unauthorized child and a leaf have no work tool, and their requests start nothing',
      async () => {
        const smuggle = (requestId: string, taskId: string) =>
          raw(RAW_MARKER, [
            { type: 'work-request', requestId, input: delegation(taskId, 'smuggled leaf') },
          ])
        const plain = await owner.run({
          taskId: 'unauthorized',
          prompt: `Unauthorized child\n${smuggle('plain', 'smuggled-by-child')}\n${script([slow(1500)])}`,
        })
        assert.equal(plain.view.status, 'completed', plain.view.error)
        assert.ok(!plain.view.resources?.tools.includes('work'))
        const coordinator = await owner.run({
          taskId: 'with-leaf',
          coordinate: true,
          prompt: phase('Phase with a leaf', [
            work(
              'd',
              delegation(
                'inner',
                `Inner leaf\n${smuggle('leaf', 'smuggled-by-leaf')}\n${script([slow(1500)])}`
              )
            ),
          ]),
        })
        assert.equal(coordinator.view.status, 'completed', coordinator.view.error)
        assert.ok(coordinator.view.resources?.tools.includes('work'))
        const inner = await owner.leaf(coordinator.view.id, 'inner', settled)
        assert.equal(inner.status, 'completed', inner.error)
        assert.ok(!inner.resources?.tools.includes('work'))
        assert.match(refusal(fixture.dataHome, plain.view.id, 'plain'), /not a running coordinator/)
        assert.match(refusal(fixture.dataHome, inner.id, 'leaf'), /not a running coordinator/)
        const tasks: readonly string[] = (await owner.records()).map(record => record.owner.taskId)
        assert.ok(!tasks.includes('smuggled-by-child') && !tasks.includes('smuggled-by-leaf'))
      }
    )

    const bystander = await owner.delegate({
      taskId: 'bystander',
      prompt: `Bystander\n${script([slow(60_000)])}`,
    })
    await owner.attempt('the bystander to run', record => record.id === bystander.id, running)

    await claim(
      'a read-only coordinator cannot start a writer, no coordinator starts a process, and inspect or cancel outside its own leaves is refused without effect',
      async () => {
        const marker = join(fixture.root, 'process-ran')
        const { view, text } = await owner.run({
          taskId: 'bounded',
          coordinate: true,
          prompt: `Bounded phase\n${raw(RAW_MARKER, [
            {
              type: 'work-request',
              requestId: 'raw-process',
              input: { action: 'process', taskId: 'raw-process', command: `touch ${marker}` },
            },
          ])}\n${script([
            [
              work('w', delegation('writer', 'Writer leaf', { access: 'write' })),
              work('c', { action: 'cancel', id: bystander.id }),
              work('i', { action: 'inspect', id: bystander.id }),
              work('n', delegation('nested', 'Nested coordinator', { coordinate: true })),
            ],
          ])}`,
        })
        assert.equal(view.status, 'completed', view.error)
        assert.equal(count(text, 'A read-only coordinator can start only read-only leaves'), 1)
        assert.equal(count(text, 'Attempt is not a leaf of this coordinator'), 1)
        assert.equal(
          count(text, 'Result is unavailable in this session (unknown or expired attempt)'),
          1
        )
        refusal(fixture.dataHome, view.id, 'raw-process')
        assert.ok(!existsSync(marker), 'a coordinator started a process')
        const records = await owner.records()
        assert.deepEqual(
          records.filter(record => record.owner.parent === view.id),
          [],
          'a refused request started a leaf'
        )
        assert.equal(records.find(record => record.id === bystander.id)?.status, 'running')
      }
    )

    await claim(
      'a request carrying a forged attempt identity and generation is rejected and stops its sender without effect',
      async () => {
        const started = await owner.delegate({
          taskId: 'forger',
          coordinate: true,
          prompt: `Forger\n${raw(RAW_MARKER, [
            {
              type: 'work-request',
              requestId: 'forged',
              owner: { attemptId: bystander.id, generation: 'forged-generation' },
              input: { action: 'cancel', id: bystander.id },
            },
          ])}\n${script([slow(60_000)])}`,
        })
        const forger = await owner.attempt(
          'the forger to settle',
          record => record.id === started.id,
          settled
        )
        assert.equal(forger.status, 'failed')
        assert.match(forger.protocolError ?? '', /Unexpected child message field/)
        const records = await owner.records()
        assert.equal(records.find(record => record.id === bystander.id)?.status, 'running')
      }
    )

    await claim(
      'a request from a coordinator whose cancellation was requested starts nothing',
      async () => {
        const started = await owner.delegate({
          taskId: 'stale',
          coordinate: true,
          prompt: `Stale coordinator\n${raw(RAW_ON_CANCEL_MARKER, [
            {
              type: 'work-request',
              requestId: 'late',
              input: delegation('late-leaf', 'Late leaf'),
            },
          ])}\n${script([slow(60_000)])}`,
        })
        await owner.attempt(
          'the stale coordinator to be ready',
          record => record.id === started.id,
          record => running(record) && record.model !== undefined
        )
        const cancelled = await owner.call(actions => actions.cancel(started.id))
        assert.equal(cancelled.status, 'cancelled')
        assert.match(refusal(fixture.dataHome, started.id, 'late'), /not a running coordinator/)
        const tasks: readonly string[] = (await owner.records()).map(record => record.owner.taskId)
        assert.ok(!tasks.includes('late-leaf'), 'a stale request started a leaf')
      }
    )

    await claim(
      'a coordinator that reports a result while its request is still pending is rejected, and the request starts nothing',
      async () => {
        const started = await owner.delegate({
          taskId: 'hasty',
          coordinate: true,
          prompt: `Hasty coordinator\n${raw(RAW_MARKER, [
            { type: 'work-request', requestId: 'leaf', input: delegation('unborn', 'Unborn leaf') },
            { type: 'result', text: 'hasty result' },
          ])}\n${script([slow(60_000)])}`,
        })
        const hasty = await owner.attempt(
          'the hasty coordinator to settle',
          record => record.id === started.id,
          settled
        )
        assert.equal(hasty.status, 'failed')
        assert.match(hasty.protocolError ?? '', /request\(s\) or leaf outcome\(s\) were unresolved/)
        assert.equal(count(await owner.result(started.id), 'hasty result'), 0)
        const records = await owner.records()
        assert.deepEqual(
          records.filter(record => record.owner.parent === started.id && !settled(record)),
          []
        )
      }
    )

    await claim(
      'a coordinator that reports a result while its leaf is live is rejected, and its leaf is stopped',
      async () => {
        const started = await owner.delegate({
          taskId: 'premature',
          coordinate: true,
          prompt: `Premature coordinator\n${raw(RAW_MARKER, [
            {
              type: 'work-request',
              requestId: 'leaf',
              input: delegation('outliving', `Outliving leaf\n${script([slow(60_000)])}`),
            },
          ])}\n${raw(RAW_AFTER_REPLY_MARKER, [
            { type: 'result', text: 'premature result' },
          ])}\n${script([slow(60_000)])}`,
        })
        const premature = await owner.attempt(
          'the premature coordinator to settle',
          record => record.id === started.id,
          settled
        )
        assert.equal(premature.status, 'failed')
        assert.match(
          premature.protocolError ?? '',
          /request\(s\) or leaf outcome\(s\) were unresolved/
        )
        const outliving = await owner.leaf(started.id, 'outliving', settled)
        assert.equal(outliving.status, 'cancelled')
        assert.equal(count(await owner.result(started.id), 'premature result'), 0)
      }
    )

    await claim(
      'a coordinator whose delegating turn ends without text still receives its leaf outcome',
      async () => {
        const { view, text } = await owner.run({
          taskId: 'silent',
          coordinate: true,
          prompt: `Silent phase\n${script([[work('d', delegation('heard', 'Heard leaf'))], []])}`,
        })
        assert.equal(view.status, 'completed', view.error)
        assert.equal(count(text, 'Leaf outcomes.'), 1)
        assert.equal((await owner.leaf(view.id, 'heard', settled)).status, 'completed')
      }
    )

    await claim(
      'cancelling a coordinator also stops a leaf that already reported its result',
      async () => {
        const started = await owner.delegate({
          taskId: 'lingering',
          coordinate: true,
          prompt: phase('Lingering phase', [
            work(
              'd',
              delegation(
                'lingerer',
                `Lingering leaf\n${raw(RAW_MARKER, [{ type: 'result', text: 'early result' }])}\n${script([slow(60_000)])}`
              )
            ),
          ]),
        })
        const lingerer = await owner.leaf(started.id, 'lingerer', running)
        await waitFor('the lingering leaf to report its result', async () =>
          (await owner.result(lingerer.id)).includes('early result') ? true : undefined
        )
        const cancelled = await owner.call(actions => actions.cancel(started.id))
        assert.equal(cancelled.status, 'cancelled')
        const stopped = await owner.attempt(
          'the lingering leaf to settle',
          record => record.id === lingerer.id,
          settled
        )
        assert.equal(stopped.status, 'cancelled')
      }
    )

    await claim(
      'cancelling a coordinator stops its leaves and spares another branch, and the late leaf outcome revives nothing',
      async () => {
        const doomed = await owner.delegate({
          taskId: 'doomed',
          coordinate: true,
          prompt: phase('Doomed phase', [
            work('d', delegation('doomed-leaf', `Doomed leaf\n${script([slow(60_000)])}`)),
          ]),
        })
        const spared = await owner.delegate({
          taskId: 'spared',
          coordinate: true,
          prompt: phase('Spared phase', [
            work('d', delegation('spared-leaf', `Spared leaf\n${script([slow(4000)])}`)),
          ]),
        })
        const doomedLeaf = await owner.leaf(doomed.id, 'doomed-leaf', running)
        await owner.leaf(spared.id, 'spared-leaf', running)
        const cancelled = await owner.call(actions => actions.cancel(doomed.id))
        assert.equal(cancelled.status, 'cancelled')
        const stopped = await owner.attempt(
          'the doomed leaf to settle',
          record => record.id === doomedLeaf.id,
          settled
        )
        assert.equal(stopped.status, 'cancelled')
        const sparedView = await owner.outcome(spared.id)
        assert.equal(sparedView.status, 'completed', sparedView.error)
        assert.equal((await owner.leaf(spared.id, 'spared-leaf', settled)).status, 'completed')
        const after = (await owner.records()).find(record => record.id === doomed.id)
        assert.deepEqual(
          [after?.status, after?.revision, after?.completedAt],
          ['cancelled', cancelled.revision, cancelled.completedAt]
        )
        assert.ok(!owner.delivered().includes(doomedLeaf.id), 'a leaf outcome reached the lead')
      }
    )

    await claim(
      'a read-only leaf of a writing coordinator reads its modified and untracked files under a read use recorded on that worktree, a writer leaf gets its own worktree, and usage is reported once per attempt',
      async () => {
        const { view, text } = await owner.run({
          taskId: 'writing',
          access: 'write',
          coordinate: true,
          prompt: `Writing phase\n${USAGE_MARKER}{"input":10,"output":1}\n${script([
            [
              toolCall('w1', 'write', {
                path: 'tracked.txt',
                content: 'MODIFIED-BY-COORDINATOR\n',
              }),
              toolCall('w2', 'write', { path: 'fresh.txt', content: 'UNTRACKED-BY-COORDINATOR\n' }),
            ],
            [
              work(
                'r',
                delegation(
                  'reviewer',
                  `Reviewer\n${USAGE_MARKER}{"input":5,"output":3}\n${script([
                    [
                      toolCall('t', 'read', { path: 'tracked.txt' }),
                      toolCall('f', 'read', { path: 'fresh.txt' }),
                      toolCall('s', 'git_inspect', { operation: 'status' }),
                    ],
                  ])}`
                )
              ),
              work(
                'w',
                delegation(
                  'rewriter',
                  `Rewriter\n${script([[toolCall('t', 'read', { path: 'tracked.txt' })]])}`,
                  { access: 'write' }
                )
              ),
            ],
            say('waiting for the leaves'),
          ])}`,
        })
        assert.equal(view.status, 'completed', view.error)
        assert.equal(count(text, 'Leaf outcomes.') >= 1, true)
        const worktree = view.worktree?.path
        assert.ok(worktree !== undefined && worktree !== fixture.repository)
        const reviewer = await owner.leaf(view.id, 'reviewer', settled)
        const rewriter = await owner.leaf(view.id, 'rewriter', settled)
        assert.equal(reviewer.status, 'completed', reviewer.error)
        assert.equal(rewriter.status, 'completed', rewriter.error)
        assert.equal(reviewer.cwd, worktree)
        const review = await owner.result(reviewer.id)
        assert.equal(count(review, 'MODIFIED-BY-COORDINATOR'), 1)
        assert.equal(count(review, 'UNTRACKED-BY-COORDINATOR'), 1)
        assert.match(review, / M tracked\.txt/)
        assert.match(review, /\?\? fresh\.txt/)
        assert.equal(readFileSync(join(fixture.repository, 'tracked.txt'), 'utf8'), 'committed\n')
        assert.ok(!existsSync(join(fixture.repository, 'fresh.txt')))
        const uses = (await fixture.lifecycle.inspect({ cwd: fixture.repository }))
          .filter(workspace => workspace.workspaceId === view.workspaceId)
          .flatMap(workspace => workspace.uses)
        assert.ok(
          uses.some(use => use.access === 'read' && use.execution?.attemptId === reviewer.id),
          JSON.stringify(uses)
        )
        assert.deepEqual(
          uses.filter(use => use.stage !== 'quiescent'),
          [],
          'a use outlived the finished coordinator and its leaves on the worktree'
        )
        const ownWorktree = rewriter.worktree?.path
        assert.ok(ownWorktree !== undefined && ownWorktree !== worktree)
        assert.notEqual(ownWorktree, fixture.repository)
        const rewrite = await owner.result(rewriter.id)
        assert.equal(count(rewrite, 'committed'), 1)
        assert.equal(count(rewrite, 'MODIFIED-BY-COORDINATOR'), 0)

        const listed = (await owner.call(actions => executeWork(actions, { action: 'list' }))) as {
          readonly records: readonly ReturnType<typeof summary>[]
        }
        const row = (id: string) => listed.records.find(record => record.id === id)
        const total = (id: string) => {
          const usage = row(id)?.usage
          return typeof usage === 'object' ? usage.total : usage
        }
        const calls = fixture.modelCalls()
        const requests = (id: string) => calls.filter(attempt => attempt === id).length
        assert.equal(row(view.id)?.coordinator, true)
        assert.equal(row(reviewer.id)?.parent, view.id)
        assert.ok(row(reviewer.id)?.tools?.includes('git_inspect'))
        assert.equal(requests(reviewer.id), 2)
        assert.equal(total(reviewer.id), 16)
        assert.ok(requests(view.id) >= 4)
        assert.equal(total(view.id), 11 * requests(view.id))
        assert.equal(row(rewriter.id)?.usage, 'unavailable')
      }
    )

    await claim(
      'the authority admits a leaf read only on the workspace of a coordinator that is running under this attachment',
      async () => {
        const execution = {
          sessionId: 'leaf-read-check',
          taskKey: 'forged/leaf',
          attemptId: 'forged-leaf',
          generation: 'forged',
        }
        const writer = await fixture.attachment.authorize({ kind: 'write' })
        assert.equal(writer.kind, 'ready')
        if (writer.kind !== 'ready') return
        await assert.rejects(
          fixture.attachment.authorize({ kind: 'leaf-read', coordinator: writer.grant, execution }),
          /A leaf reads only the workspace of a delegated coordinator/
        )
        const idle = await fixture.attachment.authorize({
          kind: 'read',
          execution: { ...execution, taskKey: 'idle', attemptId: 'idle' },
        })
        assert.equal(idle.kind, 'ready')
        if (idle.kind !== 'ready') return
        await assert.rejects(
          fixture.attachment.authorize({ kind: 'leaf-read', coordinator: idle.grant, execution }),
          /The coordinator is not running in its workspace/
        )
        await assert.rejects(
          fixture.attachment.authorize({
            kind: 'leaf-read',
            coordinator: { ...idle.grant, useId: writer.grant.useId },
            execution,
          }),
          /stale or was not issued/
        )
        await fixture.attachment.reportExecution(idle.grant, {
          kind: 'launch-failed',
          reason: 'leaf read check',
        })
      }
    )

    await claim(
      "the lead's stop ends every attempt, leaves included, and a request sent after it is refused for its stale generation",
      async () => {
        const tree = await owner.delegate({
          taskId: 'stopped',
          coordinate: true,
          prompt: phase(
            `Stopped phase\n${raw(RAW_ON_CANCEL_MARKER, [
              {
                type: 'work-request',
                requestId: 'after-stop',
                input: delegation('after-stop-leaf', 'Leaf after the stop'),
              },
            ])}`,
            [work('d', delegation('stopped-leaf', `Stopped leaf\n${script([slow(60_000)])}`))]
          ),
        })
        const leaf = await owner.leaf(tree.id, 'stopped-leaf', running)
        await owner.call(actions => actions.interrupt('explicit stop'))
        const records = await owner.records()
        assert.match(refusal(fixture.dataHome, tree.id, 'after-stop'), /no longer current/)
        assert.ok(
          !records.some(record => record.owner.taskId === 'after-stop-leaf'),
          'a request after the generation changed started a leaf'
        )
        for (const id of [tree.id, leaf.id, bystander.id])
          assert.equal(records.find(record => record.id === id)?.status, 'cancelled', id)
        assert.deepEqual(
          records.filter(record => !settled(record)),
          []
        )
      }
    )
  } finally {
    await owner.close()
  }
} finally {
  await fixture.close()
}

const uncertain = await openWorkFixture('work-nested-unknown')
try {
  const lost = new Set<string>()
  const warned = new Set<string>()
  const losing = (base: WorkspaceAttachment): WorkspaceAttachment => ({
    get binding() {
      return base.binding
    },
    select: selection => base.select(selection),
    handoff: (transition, replace) => base.handoff(transition, replace),
    sweeps: base.sweeps,
    close: base.close,
    authorize: operation => {
      const admitted = base.authorize(operation).pipe(
        Effect.tap(authorization =>
          Effect.sync(() => {
            if (
              operation.kind === 'leaf-read' &&
              operation.execution.taskKey.endsWith('/lost-leaf') &&
              authorization.kind === 'ready'
            )
              lost.add(authorization.grant.useId)
            if (
              operation.kind === 'read' &&
              operation.execution?.taskKey === 'gate-warning' &&
              authorization.kind === 'ready'
            )
              warned.add(authorization.grant.useId)
          })
        )
      )
      return operation.kind === 'leaf-read' &&
        operation.execution.taskKey.endsWith('/slow-admission')
        ? Effect.delay(admitted, SLOW_ADMISSION_MS)
        : admitted
    },
    reportExecution: (grant, fact) =>
      lost.has(grant.useId) && (fact.kind === 'observed' || fact.kind === 'quiescent')
        ? Effect.fail(new WorkspaceError({ outcome: 'unavailable', message: 'observation lost' }))
        : base
            .reportExecution(grant, fact)
            .pipe(
              Effect.map(report =>
                warned.has(grant.useId) && fact.kind === 'quiescent'
                  ? { warning: GATE_WARNING }
                  : report
              )
            ),
  })
  const owner = uncertain.openOwner('general', losing)
  try {
    await claim(
      'cancelling a coordinator while its request is still being admitted ends it cancelled with a quiescent use, and the request starts nothing',
      async () => {
        const started = await owner.delegate({
          taskId: 'interrupted',
          coordinate: true,
          prompt: phase('Interrupted phase', [
            work('d', delegation('slow-admission', 'Leaf behind a slow admission')),
          ]),
        })
        await waitFor('the coordinator to send its request', () =>
          uncertain.modelCalls().includes(started.id) ? true : undefined
        )
        await sleep(1000)
        const cancelled = await owner.call(actions => actions.cancel(started.id))
        assert.equal(cancelled.status, 'cancelled', cancelled.cleanupError)
        const use = (await uncertain.lifecycle.inspect({ cwd: uncertain.repository }))
          .flatMap(workspace => workspace.uses)
          .find(candidate => candidate.execution?.attemptId === started.id)
        assert.equal(use?.stage, 'quiescent', JSON.stringify(use))
        await sleep(SLOW_ADMISSION_MS)
        const records = await owner.records()
        assert.deepEqual(
          records.filter(record => record.owner.parent === started.id),
          [],
          'the interrupted request started a leaf'
        )
      }
    )

    await claim(
      'a gate release deferred after settlement is recorded on the attempt and leaves its status unchanged',
      async () => {
        const { view } = await owner.run({ taskId: 'gate-warning', prompt: 'Gate warning child' })
        assert.equal(view.status, 'completed', view.error)
        const record = (await owner.records()).find(candidate => candidate.id === view.id)
        assert.equal(record?.gateReleaseWarning, GATE_WARNING)
        const listed = await owner.call(actions => executeWork(actions, { action: 'list' }))
        assert.match(JSON.stringify(listed), /Workspace gate release deferred: injected/)
      }
    )

    await claim(
      'a leaf whose termination is not observed stays unknown and reaches its coordinator as unknown',
      async () => {
        const { view, text } = await owner.run({
          taskId: 'uncertain',
          coordinate: true,
          prompt: phase('Uncertain phase', [work('d', delegation('lost-leaf', 'Lost leaf'))]),
        })
        const leaf = await owner.leaf(view.id, 'lost-leaf', settled)
        assert.equal(leaf.status, 'unknown')
        assert.equal(view.status, 'completed', view.error)
        assert.equal(count(text, '"status":"unknown"'), 1)
      }
    )
  } finally {
    await owner.close()
  }
} finally {
  await uncertain.close()
}

const exhausted = await openWorkFixture('work-nested-quota')
try {
  const owner = exhausted.openOwner('general')
  try {
    await claim(
      'quota exhaustion reported by a leaf stops its coordinator and blocks new agents in the session',
      async () => {
        const tree = await owner.delegate({
          taskId: 'metered',
          coordinate: true,
          prompt: phase('Metered phase', [
            work(
              'd',
              delegation('broke', `Broke leaf\n${script([{ error: 'insufficient_quota' }])}`)
            ),
          ]),
        })
        const broke = await owner.leaf(tree.id, 'broke', settled)
        assert.equal(broke.status, 'failed')
        assert.match(broke.error ?? '', /insufficient_quota/)
        const coordinator = await owner.attempt(
          'the metered coordinator to settle',
          record => record.id === tree.id,
          settled
        )
        assert.equal(coordinator.status, 'cancelled')
        await assert.rejects(
          owner.delegate({ taskId: 'after-quota', prompt: 'After quota' }),
          /Subscription exhausted/
        )
      }
    )
  } finally {
    await owner.close()
  }
} finally {
  await exhausted.close()
}

console.log(
  JSON.stringify(
    {
      result: 'passed',
      checks: passed,
      limitation:
        'Offline scripted model in real child processes; no live credentials or model, no power-loss test',
    },
    null,
    2
  )
)
