import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WorkRemote } from '../../src/work-domain.ts'
import { makeClaims, toolCall } from '../workspace/workspace-check-support.ts'
import { assertStatus, openWorkFixture, script } from '../work/work-check-support.ts'

const fixture = await openWorkFixture('orb-reader')
const { claim, passed } = makeClaims()
const record = join(fixture.root, 'orb-record')
mkdirSync(record)
writeFileSync(join(fixture.repository, 'uncommitted.txt'), 'only on the Mac\n')
const remote: WorkRemote = {
  checkout: fixture.repository,
  reader: {
    label: 'orb 0123abcd (orb.invalid)',
    user: 'ubuntu',
    host: 'orb.invalid',
    keyPath: join(record, 'key'),
    knownHostsPath: join(record, 'known_hosts'),
    controlPath: join(record, 'control'),
  },
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
    'in orb mode a delegated agent that can write is refused, and so is a delegation into another checkout',
    async () => {
      await assert.rejects(
        owner.delegate({ taskId: 'orb-writer', prompt: 'edit', access: 'write' }),
        /In orb mode delegated agents are read-only/
      )
      await assert.rejects(
        owner.delegate({ taskId: 'orb-elsewhere', prompt: 'read', cwd: other }),
        /another checkout does not exist there/
      )
      assert.deepEqual(await owner.records(), [], 'no attempt was recorded')
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
          'An unresolvable orb host proves routing to SSH; reading a real orb is proven only on DevStack',
      },
      null,
      2
    )
  )
} finally {
  await owner.close()
  await fixture.close()
}
