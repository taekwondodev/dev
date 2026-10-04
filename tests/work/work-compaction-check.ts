import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Effect, Schema } from 'effect'
import { NodeFileSystem } from '@effect/platform-node'
import { ALL_TIME, profileUsage } from '../../scripts/usage-profile.ts'
import { COMPACTION_OBSERVATION, CompactionObservation } from '../../src/compaction-observation.ts'
import { loadInstalledPi, makeClaims, toolCall } from '../workspace/workspace-check-support.ts'
import { assertStatus, openWorkFixture, script, settled } from './work-check-support.ts'
import { CHILD_MODEL, USAGE_MARKER } from './work-child-model.ts'

const { pi } = await loadInstalledPi()
const { claim, passed } = makeClaims()
const fixture = await openWorkFixture('work-compaction')
writeFileSync(join(fixture.repository, 'tracked.txt'), 'Reviewable file content. '.repeat(100))
fixture.git(['add', 'tracked.txt'])
fixture.git(['commit', '--quiet', '-m', 'long review fixture'])
const settings = join(fixture.agentDir, 'settings.json')
writeFileSync(
  settings,
  JSON.stringify({
    compaction: { reserveTokens: 16384, keepRecentTokens: 64 },
    cacheWarming: 'off',
  })
)
const marker = join(fixture.root, 'ordinary-extension-loaded')
const extension = `import { appendFileSync } from 'node:fs'\nexport default function () { appendFileSync(${JSON.stringify(marker)}, 'loaded\\n') }\n`
writeFileSync(join(fixture.agentDir, 'extensions', 'ordinary.ts'), extension)
const projectExtensions = join(fixture.repository, '.pi', 'extensions')
mkdirSync(projectExtensions, { recursive: true })
const projectMarker = join(fixture.root, 'project-extension-loaded')
writeFileSync(
  join(projectExtensions, 'ordinary.ts'),
  extension.replace(JSON.stringify(marker), JSON.stringify(projectMarker))
)
const review = (title: string) =>
  [
    title,
    'Preserve the review findings and finish with REVIEW-COMPLETE.',
    'Earlier review detail. '.repeat(100),
    `${USAGE_MARKER}${JSON.stringify({ input: 151000, output: 0 })}`,
    script([
      [toolCall('read-1', 'read', { path: 'tracked.txt' })],
      { delayMs: 500, content: [toolCall('read-2', 'read', { path: 'tracked.txt' })] },
      [{ type: 'text', text: 'REVIEW-COMPLETE' }],
    ]),
  ].join('\n')
const entries = (file: string | undefined) => {
  assert.ok(file, 'the real child must retain a session file')
  return pi.SessionManager.open(file).getEntries()
}
const observedRun = (file: string | undefined) => {
  const stored = entries(file)
  const observations = stored.flatMap(entry =>
    entry.type === 'custom' && entry.customType === COMPACTION_OBSERVATION
      ? [Schema.decodeUnknownSync(CompactionObservation)(entry.data)]
      : []
  )
  const attached = observations.filter(event => event.kind === 'attached')
  assert.equal(attached.length, 1)
  assert.equal(observations.filter(event => event.kind === 'detached').length, 1)
  const applied = observations.filter(
    event => event.kind === 'background-ended' && event.outcome.kind === 'applied'
  )
  assert.ok(applied.length > 0)
  for (const event of applied) {
    assert.equal(event.runId, attached[0]?.runId)
    assert.ok(event.kind === 'background-ended' && event.outcome.kind === 'applied')
    const { entryId } = event.outcome
    assert.ok(stored.some(entry => entry.type === 'compaction' && entry.id === entryId))
    assert.ok(
      observations.some(start => start.kind === 'background-started' && start.id === event.id)
    )
    assert.ok(
      observations.some(ready => ready.kind === 'background-ready' && ready.id === event.id)
    )
  }
  assert.ok(file)
  assert.equal(
    JSON.stringify(pi.SessionManager.open(file).buildSessionProjection().messages).includes(
      COMPACTION_OBSERVATION
    ),
    false
  )
  return attached[0]?.runId
}
const owner = fixture.openOwner()
try {
  await claim(
    'read-only and writable children independently compact through actual composition without enabling ordinary extensions for read-only children',
    async () => {
      const readonly = await owner.run({
        taskId: 'readonly-compaction',
        prompt: review('Read-only long review'),
      })
      assertStatus(readonly.view, 'completed')
      assert.equal(readonly.text, 'REVIEW-COMPLETE')
      assert.ok(entries(readonly.view.sessionFile).some(entry => entry.type === 'compaction'))
      assert.equal(existsSync(marker), false)
      assert.equal(existsSync(projectMarker), false)
      assert.deepEqual(
        readonly.view.resources?.tools.filter(name => ['write', 'edit', 'bash'].includes(name)),
        []
      )
      assert.ok((readonly.view.usage?.total ?? 0) >= 453000)
      const writer = await owner.run({
        taskId: 'writer-compaction',
        access: 'write',
        prompt: review('Writable long review'),
      })
      assertStatus(writer.view, 'completed')
      assert.equal(writer.text, 'REVIEW-COMPLETE')
      assert.ok(entries(writer.view.sessionFile).some(entry => entry.type === 'compaction'))
      assert.ok(
        existsSync(marker),
        'the control writer actually loaded the ordinary global extension'
      )
      assert.ok(writer.view.resources?.tools.includes('write'))
      assert.notEqual(writer.view.sessionFile, readonly.view.sessionFile)
      assert.notEqual(observedRun(writer.view.sessionFile), observedRun(readonly.view.sessionFile))
    }
  )

  await claim(
    'a coordinator and its read-only leaf compact independently and still deliver one leaf outcome to the coordinator',
    async () => {
      const childPrompt = review('Leaf long review')
      const prompt = [
        'Coordinate this review. '.repeat(100),
        `${USAGE_MARKER}${JSON.stringify({ input: 151000, output: 0 })}`,
        script([
          [
            toolCall('delegate-review', 'work', {
              action: 'delegate',
              taskId: 'compacting-leaf',
              prompt: childPrompt,
              model: CHILD_MODEL,
              access: 'read-only',
            }),
          ],
          { delayMs: 500, content: [toolCall('review-read', 'read', { path: 'tracked.txt' })] },
          [{ type: 'text', text: 'waiting for review' }],
        ]),
      ].join('\n')
      const result = await owner.run({ taskId: 'compacting-coordinator', coordinate: true, prompt })
      assertStatus(result.view, 'completed')
      const leaf = await owner.leaf(result.view.id, 'compacting-leaf', settled)
      assertStatus(leaf, 'completed')
      assert.ok(entries(result.view.sessionFile).some(entry => entry.type === 'compaction'))
      assert.ok(entries(leaf.sessionFile).some(entry => entry.type === 'compaction'))
      assert.notEqual(observedRun(result.view.sessionFile), observedRun(leaf.sessionFile))
      const outcomes = entries(result.view.sessionFile).filter(
        entry => entry.type === 'custom_message' && entry.customType === 'dev/work-outcome'
      )
      assert.equal(outcomes.length, 1)
      assert.equal(result.text.split('Leaf outcomes.').length - 1, 1)
      assert.ok(
        leaf.resources?.tools.every(name => !['write', 'edit', 'bash', 'work'].includes(name))
      )
      assert.ok(owner.delivered().includes(result.view.id))
      assert.ok(!owner.delivered().includes(leaf.id))
    }
  )

  await claim(
    'the private profiler reads actual child observations and reports their committed applications without invented summary usage',
    async () => {
      const output = await Effect.runPromise(
        profileUsage({
          dataHome: fixture.dataHome,
          selection: { kind: 'report', periods: [ALL_TIME] },
        }).pipe(Effect.provide(NodeFileSystem.layer))
      )
      const profile = Schema.decodeUnknownSync(
        Schema.Struct({
          periods: Schema.Array(
            Schema.Struct({
              compaction: Schema.Struct({
                coverage: Schema.Literal('available'),
                appliedIdle: Schema.Finite,
                appliedBoundary: Schema.Finite,
                incomplete: Schema.Literal(0),
                preparationsWithoutUsage: Schema.Finite,
                observedUsage: Schema.Struct({ entries: Schema.Literal(0) }),
              }),
            })
          ),
        })
      )(JSON.parse(readFileSync(join(fixture.dataHome, 'usage', 'all.json'), 'utf8')))
      const [period] = profile.periods
      assert.ok(period)
      assert.ok(period.compaction.appliedIdle + period.compaction.appliedBoundary >= 4)
      assert.ok(period.compaction.preparationsWithoutUsage >= 4)
      assert.ok(output.includes('Private compaction observations: available'))
      assert.ok(output.includes('preparations without recorded usage'))
    }
  )

  await claim(
    'actual-child telemetry retains native totals when compaction removes the last projected assistant',
    async () => {
      writeFileSync(
        join(fixture.agentDir, 'extensions', 'replace-context.ts'),
        `export default function (pi) {
      pi.on('agent_before_settle', event => ({ entries: [...event.entries, {
        type: 'compaction', summary: 'retained summary only', firstKeptEntryId: null, tokensBefore: 4,
        usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
      }] }))
    }`
      )
      const result = await owner.run({
        taskId: 'compacted-usage',
        access: 'write',
        prompt: `Usage check\n${USAGE_MARKER}{"input":3,"output":1}\n${script([[{ type: 'text', text: 'finished' }]])}`,
      })
      assert.equal(result.view.usage?.total, 16)
      assert.equal(result.view.usage?.assistantMessages, 1)
      const file = result.view.sessionFile
      assert.ok(file)
      const manager = pi.SessionManager.open(file)
      assert.equal(
        manager.buildSessionProjection().messages.some(message => message.role === 'assistant'),
        false
      )
      assert.ok(readFileSync(file, 'utf8').includes('finished'))
    }
  )
  console.log(JSON.stringify({ checks: passed.length, claims: passed }))
} finally {
  await owner.close()
  await fixture.close()
}
