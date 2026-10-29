import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Deferred, Effect } from 'effect'
import { orbFailure } from '../../src/orb/domain.ts'
import type { ChildOrb, ChildOrbs, OrbReader, WorkRemote } from '../../src/work-domain.ts'
import { makeClaims, toolCall } from '../workspace/workspace-check-support.ts'
import { assertStatus, openWorkFixture, script } from '../work/work-check-support.ts'

const fixture = await openWorkFixture('orb-reader')
const { claim, passed } = makeClaims()
const record = join(fixture.root, 'orb-record')
mkdirSync(record)
writeFileSync(join(fixture.repository, 'uncommitted.txt'), 'only on the Mac\n')
const reader: OrbReader = {
  label: 'orb 0123abcd (orb.invalid)',
  user: 'ubuntu',
  host: 'orb.invalid',
  keyPath: join(record, 'key'),
  knownHostsPath: join(record, 'known_hosts'),
  controlPath: join(record, 'control'),
}
const leadCommit = fixture.git(['commit-tree', '-p', 'HEAD', '-m', 'on the orb', 'HEAD^{tree}'])
type Ended = Parameters<ChildOrb['end']>[0]
const children = {
  unreachable: false,
  capacity: false,
  provisioning: Effect.void,
  pinned: [] as string[],
  ended: [] as Ended[],
}
const childOrbs: ChildOrbs = {
  fork: attempt =>
    children.unreachable
      ? Effect.fail(orbFailure('the commit of the lead orb could not be read: ssh failed'))
      : Effect.sync(() => {
          const ref = `refs/dev/orb/lead/fork/${attempt}`
          fixture.git(['update-ref', ref, leadCommit])
          children.pinned.push(ref)
          return {
            ref,
            commit: leadCommit,
            unpin: Effect.sync(() => fixture.git(['update-ref', '-d', ref])),
          }
        }),
  provision: ({ report, adopt }) =>
    Effect.gen(function* () {
      yield* report({ record: 'child-record', status: 'requested' })
      yield* report({ record: 'child-record', id: 'child-orb', status: 'BUILDING' })
      yield* children.provisioning
      if (children.capacity)
        return yield* orbFailure(
          'orbit capacity exhausted: 2 active orbs in the project; wait for a child to finish'
        )
      const orb: ChildOrb = {
        handle: { ...reader, label: 'orb 4567cdef (orb.invalid)', record: 'child-record' },
        end: input =>
          Effect.sync(() => {
            children.ended.push(input)
            return { status: 'DELETED', report: 'Orb 4567cdef was deleted.' }
          }),
      }
      adopt(orb)
      return orb
    }),
}
const remote: WorkRemote = {
  checkout: fixture.repository,
  reader,
  children: childOrbs,
  shellCommand: command => command,
  wrap: (file, args, cwd) => ({
    file: '/bin/bash',
    args: ['-c', 'cd "$1" && shift && exec "$@"', 'orb-wrap', cwd, file, ...args],
  }),
}
const other = join(fixture.root, 'other')
mkdirSync(other)
execFileSync('git', ['init', '--quiet', other])
const owner = fixture.openOwner(undefined, undefined, remote)
try {
  await claim(
    "in orb mode a delegation into another checkout is refused, and so is a writing child while the lead's orb cannot be read",
    async () => {
      await assert.rejects(
        owner.delegate({ taskId: 'orb-elsewhere', prompt: 'read', cwd: other }),
        /another checkout does not exist there/
      )
      children.unreachable = true
      await assert.rejects(
        owner.delegate({ taskId: 'orb-unreachable', prompt: 'edit', access: 'write' }),
        /starts from the lead orb's committed HEAD, and the commit of the lead orb could not be read/
      )
      children.unreachable = false
      assert.deepEqual(await owner.records(), [], 'no attempt was recorded')
    }
  )

  await claim(
    "a writing child shows provisioning with orbit's phase until its orb is ready, starts from the commit pinned from the lead's orb, runs bash, write and edit from dev:orb on that orb, and the lead ends the orb with the child's failed return",
    async () => {
      const gate = Deferred.makeUnsafe<void>()
      children.provisioning = Deferred.await(gate)
      const started = await owner.delegate({
        taskId: 'orb-writer',
        access: 'write',
        prompt: `Edit on the orb\n${script([
          [toolCall('orb-write', 'write', { path: 'child.txt', content: 'from the child\n' })],
          [toolCall('orb-bash', 'bash', { command: 'echo ran > bash.txt' })],
        ])}`,
      })
      const provisioning = await owner.attempt(
        'the writing child provisioning its orb',
        attempt => attempt.id === started.id,
        attempt => attempt.status === 'provisioning' && attempt.orb?.status === 'BUILDING'
      )
      assert.equal(provisioning.orb?.id, 'child-orb')
      const worktree = provisioning.worktreePath
      assert.ok(worktree !== undefined)
      assert.equal(fixture.git(['rev-parse', 'HEAD'], worktree), leadCommit)
      assert.notEqual(fixture.git(['rev-parse', 'HEAD']), leadCommit)
      assert.equal(fixture.git(['for-each-ref', 'refs/dev/orb']), '', 'the fork ref is unpinned')
      Effect.runSync(Deferred.succeed(gate, undefined))
      const view = await owner.outcome(started.id)
      const text = await owner.result(started.id)
      assertStatus(view, 'failed')
      assert.match(view.error ?? '', /The return from the orb failed: ssh ubuntu@orb\.invalid/)
      const tools = view.resources?.tools ?? []
      for (const name of ['bash', 'read', 'write', 'edit'])
        assert.ok(tools.includes(name), `${name} in ${tools.join(',')}`)
      const results = text.slice(text.indexOf('TOOL-RESULTS'))
      assert.match(results, /ssh ubuntu@orb\.invalid/, 'write and bash reached SSH')
      assert.ok(!existsSync(join(worktree, 'child.txt')), 'write did not touch the Mac worktree')
      assert.ok(!existsSync(join(worktree, 'bash.txt')), 'bash did not run on the Mac')
      assert.equal(children.ended.length, 1)
      assert.deepEqual(children.ended[0]?.into, undefined, "the result goes to the lead's orb")
      assert.equal(children.ended[0]?.returned?.kind, 'failed')
      assert.deepEqual(view.orb, {
        record: 'child-record',
        id: 'child-orb',
        status: 'DELETED',
        report: 'Orb 4567cdef was deleted.',
      })
    }
  )

  await claim(
    "a writing child whose orb cannot be provisioned fails with orbit's refusal without starting, and the next writing child is unaffected",
    async () => {
      children.capacity = true
      const { view } = await owner.run({
        taskId: 'orb-capacity',
        access: 'write',
        prompt: `Never runs\n${script([[toolCall('never', 'bash', { command: 'true' })]])}`,
      })
      assertStatus(view, 'failed')
      assert.match(
        view.error ?? '',
        /orbit capacity exhausted: 2 active orbs in the project; wait for a child to finish/
      )
      assert.equal(view.model, undefined, 'the child never started a session')
      assert.equal(children.ended.length, 1, 'no orb was ended for the refused child')
      children.capacity = false
      const next = await owner.run({ taskId: 'orb-next', access: 'write', prompt: 'Done.' })
      assert.equal(next.view.orb?.status, 'DELETED')
    }
  )

  await claim(
    "a read-only child in orb mode runs read, grep, find, ls and git_inspect over SSH against the lead's orb, with no shell or edit tool, and never reads the Mac checkout",
    async () => {
      const { view, text } = await owner.run({
        taskId: 'orb-reader',
        prompt: `Read the orb\n${script([
          [toolCall('orb-read', 'read', { path: 'uncommitted.txt' })],
          [toolCall('orb-ls', 'ls', { path: '.' })],
          [toolCall('orb-git', 'git_inspect', { operation: 'status' })],
        ])}`,
      })
      assertStatus(view, 'completed')
      const tools = view.resources?.tools ?? []
      for (const name of ['read', 'grep', 'find', 'ls', 'git_inspect'])
        assert.ok(tools.includes(name), `${name} in ${tools.join(',')}`)
      for (const name of ['bash', 'write', 'edit'])
        assert.ok(!tools.includes(name), `${name} in ${tools.join(',')}`)
      const results = text.slice(text.indexOf('TOOL-RESULTS'))
      assert.match(results, /ssh ubuntu@orb\.invalid failed/, 'read and ls reached SSH')
      assert.match(
        results,
        /Git exited with status 255/,
        'git_inspect ended with the SSH failure code'
      )
      assert.doesNotMatch(results, /only on the Mac|Child workspace is read-only/, results)
    }
  )

  console.log(
    JSON.stringify(
      {
        result: 'passed',
        checks: passed,
        limitation:
          "An unresolvable orb host proves routing to SSH, and a stand-in for the lead's child orbs proves the controller's provisioning, start and end; reading, writing and returning on a real orb is proven only on DevStack",
      },
      null,
      2
    )
  )
} finally {
  await owner.close()
  await fixture.close()
}
