import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Effect, Result } from 'effect'
import { hardenedGit, orbRepository } from '../../src/orb/transfer.ts'
import { makeOrbSsh } from '../../src/orb/ssh.ts'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'dev-orb-reachability-')))
const originalPath = process.env.PATH
try {
  const bin = join(root, 'bin')
  const checkout = join(root, 'checkout')
  const fail = join(root, 'unreachable')
  mkdirSync(bin)
  mkdirSync(checkout)
  writeFileSync(
    join(bin, 'ssh'),
    `#!/bin/bash\n[ ! -f '${fail}' ] || exit 255\nfor arg; do command=$arg; done\nexec /bin/bash -c "$command"\n`,
    { mode: 0o755 }
  )
  process.env.PATH = `${bin}:${originalPath ?? ''}`
  execFileSync('git', ['init', '-q', checkout])
  execFileSync('git', [
    '-C',
    checkout,
    '-c',
    'user.name=check',
    '-c',
    'user.email=check@localhost',
    'commit',
    '--allow-empty',
    '-qm',
    'fixture',
  ])
  let reachable = true
  const ssh = makeOrbSsh(
    {
      user: 'ubuntu',
      host: 'orb.invalid',
      keyPath: join(root, 'key'),
      knownHostsPath: join(root, 'known_hosts'),
      controlPath: join(root, 'mux'),
    },
    value => {
      reachable = value
    }
  )
  const repository = orbRepository(ssh, checkout)
  await Effect.runPromise(
    Effect.gen(function* () {
      const git = yield* hardenedGit(checkout, repository.protocol, repository.gitSshCommand)
      const fetch = (url = repository.url) =>
        repository.transfer(git.run(['fetch', '-q', '--no-write-fetch-head', url, 'HEAD']))
      writeFileSync(fail, '')
      assert.ok(Result.isFailure(yield* Effect.result(fetch())))
      assert.equal(reachable, false, 'a Git SSH transport failure marks the orb unreachable')
      rmSync(fail)
      yield* fetch()
      assert.equal(reachable, true, 'a successful Git SSH transfer restores reachability')
      const rejected = yield* Effect.result(fetch(`${ssh.destination}:${root}/missing`))
      assert.ok(Result.isFailure(rejected))
      assert.match(rejected.failure.message, /does not appear to be a git repository/)
      assert.equal(reachable, true, 'a remote Git error is not a transport failure')
      const timedOut = yield* Effect.result(
        ssh.run('exec /bin/sleep 10', { timeout: '100 millis' })
      )
      assert.ok(Result.isFailure(timedOut))
      assert.equal(reachable, false, 'an SSH timeout marks the orb unreachable')
      yield* ssh.checked('true')
      assert.equal(reachable, true)
      rmSync(join(bin, 'ssh'))
      process.env.PATH = bin
      yield* Effect.callback<void>(resume => {
        const child = ssh.spawnPlain('true')
        child.once('close', () => resume(Effect.void))
      })
      assert.equal(reachable, false, 'a missing SSH executable stays unreachable after close')
    }).pipe(Effect.provide(NodeServices.layer))
  )
  console.log('PASS Git transfers report SSH failure and recovery, not remote Git errors')
} finally {
  process.env.PATH = originalPath
  rmSync(root, { recursive: true, force: true })
}
