import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Cause, Deferred, Effect, Exit, Fiber, Stream } from 'effect'
import { identityTokensUrl, parseToken, type Keystone, type Orbit } from '../../src/orb/cloud.ts'
import { orbFailure, type OrbError, type OrbRecord, type OrbView } from '../../src/orb/domain.ts'
import { errorText } from '../../src/error-text.ts'
import { deleteRecorded } from '../../src/orb/deletion.ts'
import { recoverOrbs, settlePresence, unregisteredOrbs } from '../../src/orb/recovery.ts'
import { claimRecord, createRecord } from '../../src/orb/registry.ts'
import {
  branchingReturn,
  openOrbSession,
  returnAtQuit,
  withReturnAdmission,
} from '../../src/orb/session.ts'
import { makeOrbSsh, masterOptions, sshOptions } from '../../src/orb/ssh.ts'
import { macHomes } from '../../src/orb/tools.ts'
import { openOrbReader } from '../../src/orb/child.ts'
import { makeChildOrbs, saveChildWork } from '../../src/orb/children.ts'
import { orbToolAccess } from '../../src/integrated-tools.ts'
import { childWorkspaceExtension, type ControllerChannel } from '../../src/work-child-workspace.ts'
import { makeNativeWrites } from '../../src/workspace-native-write.ts'
import {
  refusals,
  returnWork,
  upload,
  inspectCheckout,
  inspectWorktree,
  mirrorWorktree,
  type OrbRepository,
} from '../../src/orb/transfer.ts'
import { toolEffect } from '../../src/workspace-host.ts'
import { orbQuit } from '../../src/launcher-runtime.ts'
import { makeClaims } from '../workspace/workspace-check-support.ts'
import { openLifecycle } from '../workspace/workspace-test-lifecycle.ts'
import { writeProfileFixture } from '../profile-fixture.ts'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { ChildProcessSpawner } from 'effect/process'
import { asAttemptId, type AttemptOrb } from '../../src/work-domain.ts'
import type { PiApi } from '../../src/pi-runtime.ts'
import {
  WorkspaceError,
  type WorkspaceAttachment,
  type WorkspaceGrant,
} from '../../src/workspace-domain.ts'

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'dev-orb-check-')))
process.on('exit', () => rmSync(sandbox, { recursive: true, force: true }))
const { claim, passed } = makeClaims()

const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, NodeServices.layer))

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'check',
      GIT_AUTHOR_EMAIL: 'check@localhost',
      GIT_COMMITTER_NAME: 'check',
      GIT_COMMITTER_EMAIL: 'check@localhost',
    },
  }).trim()

const repository = (orbPath: string): OrbRepository => ({
  url: orbPath,
  protocol: 'file',
  run: script =>
    Effect.try({
      try: () => execFileSync('/bin/bash', ['-c', script], { encoding: 'utf8' }),
      catch: cause => orbFailure(String(cause), cause),
    }),
})

const tree = (root: string): Map<string, string> => {
  const files = new Map<string, string>()
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      if (name === '.git') continue
      const path = join(directory, name)
      const info = lstatSync(path)
      if (info.isDirectory()) walk(path)
      else
        files.set(
          relative(root, path),
          `${(info.mode & 0o777).toString(8)}:${readFileSync(path).toString('base64')}`
        )
    }
  }
  walk(root)
  return files
}

const newCheckout = (name: string): { mac: string; orb: string } => {
  const mac = join(sandbox, name, 'mac')
  const orb = join(sandbox, name, 'orb')
  mkdirSync(mac, { recursive: true })
  mkdirSync(orb, { recursive: true })
  git(mac, 'init', '-q', '-b', 'main')
  writeFileSync(join(mac, 'calc.py'), 'print(1 + 1)\n')
  writeFileSync(join(mac, 'notes.md'), 'first\nsecond\nthird\n')
  writeFileSync(join(mac, 'blob.bin'), Buffer.from([0, 1, 2, 255, 254, 13, 10]))
  git(mac, 'add', '-A')
  git(mac, 'commit', '-q', '-m', 'initial')
  return { mac, orb }
}

const startOrb = async (mac: string, orb: string, record: string) => {
  const checkout = await run(inspectCheckout(mac))
  await run(
    upload({
      checkout,
      orbPath: orb,
      repository: repository(orb),
      baseRef: `refs/dev/orb/${record}/base`,
    })
  )
  return checkout
}

const change = (path: string, mode = '100644') => ({ mode, blob: path, path })
const tool = (name: string, source: string, path: string) => ({
  name,
  sourceInfo: { source, path },
})

const returnFrom = (mac: string, orb: string, record: string) =>
  run(
    returnWork({
      root: mac,
      branch: 'main',
      orbPath: orb,
      repository: repository(orb),
      baseRef: `refs/dev/orb/${record}/base`,
      endRef: `refs/dev/orb/${record}/end`,
      beforeWrite: Effect.void,
    })
  )

await claim(
  'a clean return fast-forwards the branch with the orb SHAs, leaves a byte-identical tree including uncommitted, untracked, binary and executable files, and needs nothing on a second sync',
  async () => {
    const { mac, orb } = newCheckout('clean')
    writeFileSync(join(mac, 'notes.md'), 'first\nsecond\nthird\nuncommitted on the Mac\n')
    await startOrb(mac, orb, 'clean')
    assert.equal(git(orb, 'rev-parse', 'HEAD'), git(mac, 'rev-parse', 'HEAD'))
    assert.equal(
      readFileSync(join(orb, 'notes.md'), 'utf8'),
      'first\nsecond\nthird\nuncommitted on the Mac\n',
      'the upload carries uncommitted changes as uncommitted changes'
    )
    assert.match(git(orb, 'status', '--porcelain'), /M notes.md/)
    writeFileSync(join(orb, 'calc.py'), 'print(2 ** 10)\n')
    git(orb, 'add', 'calc.py')
    git(orb, 'commit', '-q', '-m', 'orb commit one')
    writeFileSync(join(orb, 'run.sh'), '#!/bin/sh\necho run\n')
    chmodSync(join(orb, 'run.sh'), 0o755)
    git(orb, 'add', 'run.sh')
    git(orb, 'commit', '-q', '-m', 'orb commit two')
    writeFileSync(join(orb, 'blob.bin'), Buffer.from([9, 0, 13, 10, 255]))
    writeFileSync(join(orb, 'untracked.txt'), 'new on the orb\n')
    const orbHead = git(orb, 'rev-parse', 'HEAD')
    const outcome = await returnFrom(mac, orb, 'clean')
    assert.deepEqual(outcome, { kind: 'returned', head: orbHead, commits: 2, files: 4 })
    assert.equal(git(mac, 'rev-parse', 'HEAD'), orbHead, 'the branch has the orb SHAs')
    assert.equal(git(mac, 'symbolic-ref', '--short', 'HEAD'), 'main')
    assert.deepEqual(tree(mac), tree(orb), 'the Mac tree is byte-identical to the orb tree')
    assert.match(git(mac, 'status', '--porcelain'), /\?\? untracked.txt/)
    assert.deepEqual(await returnFrom(mac, orb, 'clean'), { kind: 'unchanged' })
  }
)

await claim(
  'local edits that do not overlap survive the return beside the orb changes, and ignored local files stay untouched',
  async () => {
    const { mac, orb } = newCheckout('local-edits')
    writeFileSync(join(mac, '.gitignore'), 'build/\n')
    git(mac, 'add', '.gitignore')
    git(mac, 'commit', '-q', '-m', 'ignore build')
    await startOrb(mac, orb, 'edits')
    writeFileSync(join(orb, 'calc.py'), 'print(3 * 3)\n')
    git(orb, 'commit', '-q', '-am', 'orb edits calc')
    writeFileSync(join(mac, 'notes.md'), 'first\nsecond\nthird\nlocal line\n')
    writeFileSync(join(mac, 'local.txt'), 'local only\n')
    mkdirSync(join(mac, 'build'))
    writeFileSync(join(mac, 'build', 'out.o'), 'ignored')
    const outcome = await returnFrom(mac, orb, 'edits')
    assert.equal(outcome.kind, 'returned')
    assert.equal(readFileSync(join(mac, 'calc.py'), 'utf8'), 'print(3 * 3)\n')
    assert.equal(readFileSync(join(mac, 'notes.md'), 'utf8'), 'first\nsecond\nthird\nlocal line\n')
    assert.equal(readFileSync(join(mac, 'local.txt'), 'utf8'), 'local only\n')
    assert.equal(readFileSync(join(mac, 'build', 'out.o'), 'utf8'), 'ignored')
    assert.equal(git(mac, 'rev-parse', 'HEAD'), git(orb, 'rev-parse', 'HEAD'))
  }
)

const lifecycle = await openLifecycle({ root: join(sandbox, 'authority') })

const branchingFrom = (mac: string, orb: string, record: string) => {
  const attempt = branchingReturn(
    Effect.provide(
      returnWork({
        root: mac,
        branch: 'main',
        orbPath: orb,
        repository: repository(orb),
        baseRef: `refs/dev/orb/${record}/base`,
        endRef: `refs/dev/orb/${record}/end`,
        beforeWrite: Effect.void,
      }),
      NodeServices.layer
    ),
    lifecycle.effect,
    mac,
    `dev/orb-return/${record}`
  )
  return () => Effect.runPromise(attempt)
}

const checkoutState = (mac: string) => ({
  head: git(mac, 'rev-parse', 'HEAD'),
  branch: git(mac, 'symbolic-ref', 'HEAD'),
  index: git(mac, 'ls-files', '-s'),
  status: git(mac, 'status', '--porcelain', '--untracked-files=all'),
  files: tree(mac),
})

const RECORD = '0b9e2c1a-5d4f-4e6a-9c3b-7f8e1d2a3b4c'

await claim(
  'a moved branch or an overlap leaves the local branch, index and files untouched and writes dev/orb-return/<record-id> with the orb commits topped by a snapshot of its uncommitted changes',
  async () => {
    const { mac, orb } = newCheckout('diverged')
    await startOrb(mac, orb, RECORD)
    writeFileSync(join(orb, 'calc.py'), 'print(4 * 4)\n')
    git(orb, 'commit', '-q', '-am', 'orb commit')
    writeFileSync(join(orb, 'notes.md'), 'first\nchanged on the orb\nthird\n')
    writeFileSync(join(orb, 'untracked.txt'), 'new on the orb\n')
    writeFileSync(join(mac, 'notes.md'), 'first\nchanged on the Mac\nthird\n')
    git(mac, 'add', 'notes.md')
    writeFileSync(join(mac, 'local.txt'), 'local only\n')
    const sync = branchingFrom(mac, orb, RECORD)
    const branch = `dev/orb-return/${RECORD}`
    const before = checkoutState(mac)
    assert.deepEqual(await sync(), { kind: 'diverged', reason: 'overlap', branch })
    assert.deepEqual(checkoutState(mac), before, 'an overlap leaves the checkout untouched')
    assert.equal(git(mac, 'rev-parse', `${branch}^1`), git(orb, 'rev-parse', 'HEAD'))
    git(orb, 'add', '-A')
    assert.equal(
      git(mac, 'rev-parse', `${branch}^{tree}`),
      git(orb, 'write-tree'),
      "the snapshot on top holds the orb's uncommitted and untracked changes"
    )
    git(orb, 'reset', '-q')

    git(mac, 'commit', '-q', '-m', 'mac moves on')
    writeFileSync(join(orb, 'untracked.txt'), 'changed again on the orb\n')
    const moved = checkoutState(mac)
    assert.deepEqual(await sync(), { kind: 'diverged', reason: 'branch-moved', branch })
    assert.deepEqual(checkoutState(mac), moved, 'a moved branch leaves the checkout untouched')
    git(orb, 'add', '-A')
    assert.equal(
      git(mac, 'rev-parse', `${branch}^{tree}`),
      git(orb, 'write-tree'),
      "dev moved the branch it left to the orb's new state"
    )
    git(orb, 'reset', '-q')
  }
)

await claim(
  'an orb that rewrote the uploaded commit is reported as such, and a branch without uncommitted orb changes ends at the orb commit itself',
  async () => {
    const { mac, orb } = newCheckout('rewritten')
    await startOrb(mac, orb, 'aaaa0000-0000-4000-8000-000000000001')
    writeFileSync(join(orb, 'calc.py'), 'print(5 * 5)\n')
    git(orb, 'commit', '-q', '-a', '--amend', '-m', 'orb amends the upload')
    const outcome = await branchingFrom(mac, orb, 'aaaa0000-0000-4000-8000-000000000001')()
    assert.equal(outcome.kind === 'diverged' ? outcome.reason : outcome.kind, 'history-rewritten')
    assert.equal(
      git(mac, 'rev-parse', 'dev/orb-return/aaaa0000-0000-4000-8000-000000000001'),
      git(orb, 'rev-parse', 'HEAD')
    )
  }
)

await claim(
  "a writing child's detached worktree uploads to a detached orb checkout, returns the orb's commits and uncommitted changes onto its detached HEAD, and mirrors into the lead's repository as a worktree carrying them",
  async () => {
    const { mac, orb } = newCheckout('child-worktree')
    const worktree = join(sandbox, 'child-worktree', 'managed')
    git(mac, 'worktree', 'add', '-q', '--detach', worktree, 'main')
    const record = 'cccc0000-0000-4000-8000-000000000001'
    const checkout = await run(inspectWorktree(worktree))
    assert.equal(checkout.branch, undefined)
    await run(
      upload({
        checkout,
        orbPath: orb,
        repository: repository(orb),
        baseRef: `refs/dev/orb/${record}/base`,
      })
    )
    assert.equal(git(orb, 'rev-parse', 'HEAD'), checkout.head)
    assert.equal(
      spawnSync('git', ['-C', orb, 'symbolic-ref', '-q', 'HEAD']).status,
      1,
      'the orb checkout is detached like the managed worktree'
    )
    assert.equal(git(orb, 'status', '--porcelain'), '')
    assert.equal(git(orb, 'for-each-ref', 'refs/dev'), '', 'the upload ref is gone')
    writeFileSync(join(orb, 'calc.py'), 'print(6 * 7)\n')
    git(orb, 'commit', '-q', '-am', 'child commit')
    writeFileSync(join(orb, 'notes.md'), 'first\nchild edit\nthird\n')
    writeFileSync(join(orb, 'fresh.txt'), 'untracked on the orb\n')
    const orbHead = git(orb, 'rev-parse', 'HEAD')
    const returned = await run(
      returnWork({
        root: worktree,
        orbPath: orb,
        repository: repository(orb),
        baseRef: `refs/dev/orb/${record}/base`,
        endRef: `refs/dev/orb/${record}/end`,
        beforeWrite: Effect.void,
      })
    )
    assert.deepEqual(returned, { kind: 'returned', head: orbHead, commits: 1, files: 3 })
    assert.equal(git(worktree, 'rev-parse', 'HEAD'), orbHead)
    assert.equal(spawnSync('git', ['-C', worktree, 'symbolic-ref', '-q', 'HEAD']).status, 1)
    assert.equal(git(mac, 'rev-parse', 'main'), checkout.head, 'the source branch did not move')
    assert.deepEqual(tree(worktree), tree(orb))

    const lead = join(sandbox, 'child-worktree', 'lead-orb')
    git(mac, 'clone', '-q', mac, lead)
    const mirrored = join(sandbox, 'child-worktree', 'lead-orb-copy', 'managed')
    mkdirSync(join(sandbox, 'child-worktree', 'lead-orb-copy'))
    const branch = { name: `dev/orb-return/${record}`, commit: orbHead }
    const mirror = () =>
      run(
        mirrorWorktree({
          worktree,
          orbPath: mirrored,
          root: lead,
          repository: repository(lead),
          branches: [branch],
        })
      )
    await mirror()
    assert.equal(git(mirrored, 'rev-parse', 'HEAD'), orbHead)
    assert.deepEqual(tree(mirrored), tree(worktree), 'the copy carries the uncommitted changes')
    assert.equal(git(mirrored, 'status', '--porcelain'), git(worktree, 'status', '--porcelain'))
    assert.equal(git(lead, 'rev-parse', branch.name), orbHead)
    assert.equal(git(lead, 'for-each-ref', 'refs/dev'), '', 'the mirror ref is gone')
    writeFileSync(join(worktree, 'notes.md'), 'first\nsecond mirror\nthird\n')
    await mirror()
    assert.deepEqual(tree(mirrored), tree(worktree), 'a second mirror replaces the copy')

    git(orb, 'commit', '-q', '-a', '--amend', '-m', 'child rewrites its commit')
    const before = git(worktree, 'rev-parse', 'HEAD')
    const diverged = await run(
      returnWork({
        root: worktree,
        orbPath: orb,
        repository: repository(orb),
        baseRef: `refs/dev/orb/${record}/base`,
        endRef: `refs/dev/orb/${record}/end`,
        beforeWrite: Effect.void,
      })
    )
    assert.equal(
      diverged.kind === 'diverged' ? diverged.reason : diverged.kind,
      'history-rewritten'
    )
    assert.equal(git(worktree, 'rev-parse', 'HEAD'), before, 'a divergence leaves HEAD')
  }
)

const childOrb = async (name: string, record: string) => {
  const { mac, orb } = newCheckout(name)
  const worktree = join(sandbox, name, 'managed')
  git(mac, 'worktree', 'add', '-q', '--detach', worktree, 'main')
  const refs = { baseRef: `refs/dev/orb/${record}/base`, endRef: `refs/dev/orb/${record}/end` }
  await run(
    upload({
      checkout: await run(inspectWorktree(worktree)),
      orbPath: orb,
      repository: repository(orb),
      baseRef: refs.baseRef,
    })
  )
  return {
    mac,
    orb,
    worktree,
    childReturn: () =>
      run(
        returnWork({
          root: worktree,
          orbPath: orb,
          repository: repository(orb),
          ...refs,
          beforeWrite: Effect.void,
        })
      ),
    save: (
      returned: Parameters<typeof saveChildWork>[0]['returned'],
      branches: Parameters<typeof saveChildWork>[0]['lifecycle'] = lifecycle.effect
    ) =>
      run(
        saveChildWork({
          worktree,
          orbPath: orb,
          record,
          baseRef: refs.baseRef,
          repository: repository(orb),
          returned,
          lifecycle: branches,
        })
      ),
  }
}

await claim(
  'after a writing child ends, the lead writes no branch for a returned child, dev/orb-return/<record-id> for a divergent return, dev/orb-recovery/<record-id> for a child that never returned, and fails when the branch cannot be written',
  async () => {
    const devBranches = (mac: string) =>
      git(mac, 'for-each-ref', '--format=%(refname)', 'refs/heads/dev')

    const normal = await childOrb('child-normal', 'dddd0000-0000-4000-8000-000000000001')
    writeFileSync(join(normal.orb, 'calc.py'), 'print(7)\n')
    git(normal.orb, 'commit', '-q', '-am', 'child commit')
    writeFileSync(join(normal.orb, 'notes.md'), 'uncommitted\n')
    assert.equal((await normal.childReturn()).kind, 'returned')
    assert.equal(await normal.save({ kind: 'returned', commits: 1, files: 2 }), undefined)
    assert.equal(devBranches(normal.mac), '', 'a returned child leaves no branch')

    const rewritten = 'dddd0000-0000-4000-8000-000000000002'
    const diverged = await childOrb('child-diverged', rewritten)
    const start = git(diverged.worktree, 'rev-parse', 'HEAD')
    writeFileSync(join(diverged.orb, 'calc.py'), 'print(8)\n')
    git(diverged.orb, 'commit', '-q', '-a', '--amend', '-m', 'child rewrites the start')
    const outcome = await diverged.childReturn()
    assert.equal(outcome.kind === 'diverged' ? outcome.reason : outcome.kind, 'history-rewritten')
    assert.deepEqual(await diverged.save({ kind: 'diverged', reason: 'history-rewritten' }), {
      name: `dev/orb-return/${rewritten}`,
      commit: git(diverged.orb, 'rev-parse', 'HEAD'),
    })
    assert.equal(git(diverged.worktree, 'rev-parse', 'HEAD'), start, 'the worktree is untouched')

    const stopped = 'dddd0000-0000-4000-8000-000000000003'
    const crashed = await childOrb('child-stopped', stopped)
    writeFileSync(join(crashed.orb, 'calc.py'), 'print(9)\n')
    git(crashed.orb, 'commit', '-q', '-am', 'child commit before the stop')
    writeFileSync(join(crashed.orb, 'wip.txt'), 'unfinished\n')
    const saved = await crashed.save(undefined)
    assert.equal(saved?.name, `dev/orb-recovery/${stopped}`)
    assert.equal(
      git(crashed.mac, 'rev-parse', `dev/orb-recovery/${stopped}^1`),
      git(crashed.orb, 'rev-parse', 'HEAD')
    )
    assert.equal(git(crashed.mac, 'show', `dev/orb-recovery/${stopped}:wip.txt`), 'unfinished')
    assert.equal(
      git(crashed.worktree, 'rev-parse', 'HEAD'),
      git(crashed.mac, 'rev-parse', 'main'),
      'the worktree is untouched'
    )

    const refused = await childOrb('child-refused', 'dddd0000-0000-4000-8000-000000000004')
    writeFileSync(join(refused.orb, 'calc.py'), 'print(10)\n')
    await assert.rejects(
      refused.save(undefined, {
        writeBranch: () =>
          Effect.fail(new WorkspaceError({ outcome: 'blocked', message: 'structure gate busy' })),
      }),
      /the work could not be written to a branch: structure gate busy/
    )
  }
)

await claim(
  'a second divergence moves the branch only while it points where dev left it; a commit on it or a checkout of it makes dev write a suffixed branch',
  async () => {
    const record = 'bbbb0000-0000-4000-8000-000000000002'
    const branch = `dev/orb-return/${record}`
    const { mac, orb } = newCheckout('second')
    await startOrb(mac, orb, record)
    writeFileSync(join(orb, 'calc.py'), 'print(6 * 6)\n')
    git(orb, 'commit', '-q', '-am', 'orb one')
    writeFileSync(join(mac, 'notes.md'), 'mac\n')
    git(mac, 'commit', '-q', '-am', 'mac moves on')
    const sync = branchingFrom(mac, orb, record)
    assert.equal((await sync()).kind, 'diverged')
    writeFileSync(join(orb, 'calc.py'), 'print(7 * 7)\n')
    git(orb, 'commit', '-q', '-am', 'orb two')
    assert.deepEqual(await sync(), { kind: 'diverged', reason: 'branch-moved', branch })
    assert.equal(git(mac, 'rev-parse', branch), git(orb, 'rev-parse', 'HEAD'))

    const userCommit = git(
      mac,
      'commit-tree',
      '-p',
      branch,
      '-m',
      'user on the branch',
      `${branch}^{tree}`
    )
    git(mac, 'update-ref', `refs/heads/${branch}`, userCommit)
    writeFileSync(join(orb, 'calc.py'), 'print(8 * 8)\n')
    git(orb, 'commit', '-q', '-am', 'orb three')
    assert.deepEqual(await sync(), {
      kind: 'diverged',
      reason: 'branch-moved',
      branch: `${branch}-2`,
    })
    assert.equal(git(mac, 'rev-parse', branch), userCommit, "the user's commit stays")
    assert.equal(git(mac, 'rev-parse', `${branch}-2`), git(orb, 'rev-parse', 'HEAD'))

    const worktree = join(sandbox, 'second', 'worktree')
    git(mac, 'worktree', 'add', '-q', worktree, `${branch}-2`)
    writeFileSync(join(orb, 'calc.py'), 'print(9 * 9)\n')
    git(orb, 'commit', '-q', '-am', 'orb four')
    const checkedOut = git(mac, 'rev-parse', `${branch}-2`)
    assert.deepEqual(await sync(), {
      kind: 'diverged',
      reason: 'branch-moved',
      branch: `${branch}-3`,
    })
    assert.equal(
      git(mac, 'rev-parse', `${branch}-2`),
      checkedOut,
      'a checked-out branch never moves'
    )
  }
)

const writeBranch = (request: Parameters<typeof lifecycle.effect.writeBranch>[0]) =>
  Effect.runPromise(lifecycle.effect.writeBranch(request))

await claim(
  'the authority writes only dev/orb-return/ and dev/orb-recovery/ branches, moves only that branch or its suffixes, takes only full commit ids, and rewriting the same commit creates no duplicate',
  async () => {
    const { mac } = newCheckout('branch-rules')
    const head = git(mac, 'rev-parse', 'HEAD')
    const name = 'dev/orb-return/dddd0000-0000-4000-8000-000000000004'
    await assert.rejects(writeBranch({ cwd: mac, name: 'main', commit: head }), /Not a dev-owned/)
    await assert.rejects(
      writeBranch({ cwd: mac, name: 'dev/orb-recovery/dddd0000', commit: head }),
      /Not a dev-owned/
    )
    await assert.rejects(
      writeBranch({ cwd: mac, name, commit: head, replacing: { name: 'main', commit: head } }),
      /is not dev\/orb-return/
    )
    for (const replaced of [`${name}-0`, `${name}-02`, `${name}-1`, `${name}-101`, `${name}x`])
      await assert.rejects(
        writeBranch({ cwd: mac, name, commit: head, replacing: { name: replaced, commit: head } }),
        /is not dev\/orb-return/,
        replaced
      )
    await assert.rejects(
      writeBranch({
        cwd: mac,
        name,
        commit: head,
        replacing: { name: 'dev/orb-return/eeee0000-0000-4000-8000-000000000005', commit: head },
      }),
      /is not dev\/orb-return/,
      "another record's branch"
    )
    await assert.rejects(
      writeBranch({ cwd: mac, name: `${name}-2`, commit: head }),
      /Not a dev-owned/,
      'a suffix is not a request name'
    )
    await assert.rejects(writeBranch({ cwd: mac, name, commit: 'HEAD' }), /Not a full commit id/)
    await assert.rejects(
      writeBranch({ cwd: mac, name, commit: head, replacing: { name, commit: 'main' } }),
      /Not a full commit id/
    )
    assert.equal(git(mac, 'rev-parse', 'main'), head, 'main never moved')
    assert.deepEqual(await writeBranch({ cwd: mac, name, commit: head }), { name })
    assert.deepEqual(await writeBranch({ cwd: mac, name, commit: head }), { name })
    assert.equal(git(mac, 'branch', '--list', `${name}*`).split('\n').length, 1)
    const recovery = 'dev/orb-recovery/dddd0000-0000-4000-8000-000000000004'
    await assert.rejects(
      writeBranch({ cwd: mac, name: recovery, commit: head, replacing: { name, commit: head } }),
      /is not dev\/orb-recovery/,
      'a recovery never moves a return branch'
    )
    assert.deepEqual(await writeBranch({ cwd: mac, name: recovery, commit: head }), {
      name: recovery,
    })
    assert.equal(git(mac, 'rev-parse', recovery), head)
  }
)

await claim(
  'a later return that is no longer divergent completes normally and leaves the return branch alone',
  async () => {
    const record = 'cccc0000-0000-4000-8000-000000000003'
    const { mac, orb } = newCheckout('cleared')
    await startOrb(mac, orb, record)
    writeFileSync(join(orb, 'notes.md'), 'first\nchanged on the orb\nthird\n')
    writeFileSync(join(mac, 'notes.md'), 'first\nchanged on the Mac\nthird\n')
    const sync = branchingFrom(mac, orb, record)
    assert.equal((await sync()).kind, 'diverged')
    const left = git(mac, 'rev-parse', `dev/orb-return/${record}`)
    git(mac, 'checkout', '-q', '--', 'notes.md')
    const outcome = await sync()
    assert.equal(outcome.kind, 'returned')
    assert.equal(readFileSync(join(mac, 'notes.md'), 'utf8'), 'first\nchanged on the orb\nthird\n')
    assert.equal(git(mac, 'rev-parse', `dev/orb-return/${record}`), left)
    assert.deepEqual(await sync(), { kind: 'unchanged' })
  }
)

const quitScenario = async (input: {
  readonly failures: number
  readonly answers?: readonly boolean[]
  readonly interrupted?: boolean
}) => {
  let attempts = 0
  let asked = 0
  const attempt = Effect.suspend(() => {
    attempts += 1
    return attempts <= input.failures
      ? Effect.fail(orbFailure('orb unreachable'))
      : Effect.succeed('returned')
  })
  const { answers } = input
  const outcome = await Effect.runPromise(
    returnAtQuit(
      attempt,
      {
        proceed: () => input.interrupted !== true,
        interrupted: Effect.never,
        ...(answers === undefined
          ? {}
          : { askRetry: Effect.sync(() => answers[asked++] ?? false) }),
      },
      () => undefined
    )
  )
  return { kind: outcome.kind, attempts, asked }
}

await claim(
  'a failed quit-time return asks Retry or Quit only with an interactive terminal; declining, Ctrl-C at the prompt (a false answer) or an interrupt during the return keeps the orb',
  async () => {
    assert.deepEqual(await quitScenario({ failures: 1 }), { kind: 'kept', attempts: 1, asked: 0 })
    assert.deepEqual(await quitScenario({ failures: 2, answers: [true, true] }), {
      kind: 'returned',
      attempts: 3,
      asked: 2,
    })
    assert.deepEqual(await quitScenario({ failures: 1, answers: [false] }), {
      kind: 'kept',
      attempts: 1,
      asked: 1,
    })
    assert.deepEqual(await quitScenario({ failures: 1, answers: [true], interrupted: true }), {
      kind: 'kept',
      attempts: 1,
      asked: 0,
    })
    assert.deepEqual(await quitScenario({ failures: 0, answers: [] }), {
      kind: 'returned',
      attempts: 1,
      asked: 0,
    })
  }
)

const offered = (stdin: boolean | undefined, stdout: boolean | undefined) =>
  orbQuit(
    { proceed: () => true, interrupted: Effect.never },
    { stdin: { isTTY: stdin }, stdout: { isTTY: stdout } }
  ).askRetry !== undefined

await claim(
  'the quit-time return offers Retry only when both stdin and stdout are terminals, only y retries, and a signal while the prompt waits quits',
  async () => {
    const answers: Record<string, 'confirmed' | 'declined' | 'interrupted'> = {
      y: 'confirmed',
      n: 'declined',
      ctrlC: 'interrupted',
    }
    assert.equal(offered(true, true), true)
    assert.equal(offered(true, false), false)
    assert.equal(offered(false, true), false)
    assert.equal(offered(undefined, undefined), false)
    for (const [answer, retries] of [
      ['y', true],
      ['n', false],
      ['ctrlC', false],
    ] as const) {
      const quit = orbQuit(
        { proceed: () => true, interrupted: Effect.never },
        { stdin: { isTTY: true }, stdout: { isTTY: true } },
        () => Effect.succeed(answers[answer] ?? 'declined')
      )
      assert.equal(await Effect.runPromise(quit.askRetry ?? Effect.void), retries)
    }
    const terminated = orbQuit(
      { proceed: () => false, interrupted: Effect.void },
      { stdin: { isTTY: true }, stdout: { isTTY: true } },
      () => Effect.never
    )
    assert.equal(
      await Effect.runPromise(terminated.askRetry ?? Effect.void),
      false,
      'a signal while the prompt waits quits and keeps the orb'
    )
  }
)

await claim(
  'the applier refuses .git paths, symlinks leaving the checkout, writes through symlinked directories, hard links and modes other than 0644 and 0755',
  async () => {
    const root = join(sandbox, 'applier')
    mkdirSync(join(root, 'inside'), { recursive: true })
    writeFileSync(join(root, 'linked.txt'), 'one')
    linkSync(join(root, 'linked.txt'), join(sandbox, 'elsewhere.txt'))
    symlinkSync(sandbox, join(root, 'escape'))
    const targets: Record<string, string> = {
      'out-link': '../../etc',
      'in-link': 'inside/file',
      'git-link': 'sub/../.Git/hooks',
    }
    const refused = refusals(
      root,
      [
        change('.git/config'),
        change('sub/.GIT/hooks/post-checkout'),
        change('module', '160000'),
        change('out-link', '120000'),
        change('in-link', '120000'),
        change('git-link', '120000'),
        change('escape/file.txt'),
        change('linked.txt'),
        change('inside/ok.txt'),
        change('run.sh', '100755'),
        change('gone.txt', '000000'),
      ],
      item => targets[item.path] ?? ''
    )
    assert.deepEqual(
      refused.map(reason => reason.split(':')[0]),
      [
        '.git/config',
        'sub/.GIT/hooks/post-checkout',
        'module',
        'out-link',
        'git-link',
        'escape/file.txt',
        'linked.txt',
      ]
    )
  }
)

await claim(
  'a return carrying a refused entry writes nothing: the branch, index and files keep their state',
  async () => {
    const { mac, orb } = newCheckout('refused')
    await startOrb(mac, orb, 'refused')
    symlinkSync('/etc/passwd', join(orb, 'passwd'))
    writeFileSync(join(orb, 'calc.py'), 'print(0)\n')
    git(orb, 'add', '-A')
    git(orb, 'commit', '-q', '-m', 'escaping link')
    const head = git(mac, 'rev-parse', 'HEAD')
    await assert.rejects(returnFrom(mac, orb, 'refused'), /a symlink leaving the checkout/)
    assert.equal(git(mac, 'rev-parse', 'HEAD'), head)
    assert.equal(readFileSync(join(mac, 'calc.py'), 'utf8'), 'print(1 + 1)\n')
    assert.ok(!existsSync(join(mac, 'passwd')))
  }
)

await claim(
  "the transfer's Git runs no hook, clean or smudge filter or merge driver configured on the Mac, even with a returned .gitattributes naming them",
  async () => {
    const { mac, orb } = newCheckout('inert')
    const marker = join(sandbox, 'inert-marker')
    const touch = `sh -c 'echo $0 >> ${marker}; cat'`
    git(mac, 'config', 'filter.marker.clean', touch)
    git(mac, 'config', 'filter.marker.smudge', touch)
    git(mac, 'config', 'filter.marker.required', 'true')
    git(mac, 'config', 'merge.marker.driver', `sh -c 'echo merge >> ${marker}; exit 1'`)
    writeFileSync(join(mac, '.git', 'info', 'attributes'), '*.md filter=marker merge=marker\n')
    for (const hook of ['reference-transaction', 'post-checkout', 'pre-push', 'post-merge']) {
      writeFileSync(join(mac, '.git', 'hooks', hook), `#!/bin/sh\necho ${hook} >> ${marker}\n`)
      chmodSync(join(mac, '.git', 'hooks', hook), 0o755)
    }
    writeFileSync(join(mac, 'notes.md'), 'first\nsecond\nthird\nlocal\n')
    await startOrb(mac, orb, 'inert')
    writeFileSync(join(orb, '.gitattributes'), '* filter=marker merge=marker\n')
    writeFileSync(join(orb, 'notes.md'), 'orb\nfirst\nsecond\nthird\nlocal\n')
    git(orb, 'add', '-A')
    git(orb, 'commit', '-q', '-m', 'orb attributes')
    writeFileSync(join(mac, 'notes.md'), 'first\nsecond\nthird\nlocal\nmore local\n')
    const outcome = await returnFrom(mac, orb, 'inert')
    assert.equal(
      outcome.kind,
      'returned',
      `${JSON.stringify(outcome)} ${existsSync(marker) ? readFileSync(marker, 'utf8') : 'no marker'}`
    )
    assert.equal(
      readFileSync(join(mac, 'notes.md'), 'utf8'),
      'orb\nfirst\nsecond\nthird\nlocal\nmore local\n',
      'the default three-way merge combined both edits'
    )
    assert.ok(!existsSync(marker), existsSync(marker) ? readFileSync(marker, 'utf8') : '')
  }
)

await claim(
  "Keystone's token is read from X-Subject-Token and orbit's URL is the public endpoint of catalog type orbit in the configured region",
  async () => {
    assert.equal(
      identityTokensUrl('http://192.0.2.1/identity/'),
      'http://192.0.2.1/identity/v3/auth/tokens'
    )
    assert.equal(
      identityTokensUrl('http://192.0.2.1:5000/v3'),
      'http://192.0.2.1:5000/v3/auth/tokens'
    )
    const body = JSON.stringify({
      token: {
        expires_at: '2026-10-27T22:00:00.000000Z',
        project: { id: 'p1', name: 'demo' },
        catalog: [
          {
            type: 'compute',
            endpoints: [{ interface: 'public', region: 'RegionOne', url: 'http://n' }],
          },
          {
            type: 'orbit',
            endpoints: [
              { interface: 'internal', region: 'RegionOne', url: 'http://internal/orbit' },
              { interface: 'public', region: 'RegionTwo', url: 'http://two/orbit' },
              { interface: 'public', region: 'RegionOne', url: 'http://one/orbit/' },
            ],
          },
        ],
      },
    })
    const token = await run(
      parseToken({ status: 201, headers: { 'x-subject-token': 'gAAAA-token' }, body }, 'RegionOne')
    )
    assert.equal(token.id, 'gAAAA-token')
    assert.equal(token.orbitUrl, 'http://one/orbit')
    assert.equal(token.expiresAt, Date.parse('2026-10-27T22:00:00Z'))
    await assert.rejects(
      run(parseToken({ status: 201, headers: {}, body }, 'RegionOne')),
      /X-Subject-Token/
    )
    await assert.rejects(
      run(parseToken({ status: 401, headers: {}, body: '{}' }, undefined)),
      /refused the token request \(401\)/
    )
  }
)

await claim(
  'the host classifies dev:orb tools as orb-remote and keeps refusing same-named tools from any other source',
  () => {
    for (const name of ['bash', 'read', 'write', 'edit', 'grep', 'find', 'ls'])
      assert.equal(toolEffect(tool(name, 'inline', '<inline:dev:orb>')), 'orb-remote', name)
    assert.equal(toolEffect(tool('read', 'inline', '<inline:dev:other>')), undefined)
    assert.equal(toolEffect(tool('bash', 'inline', '<inline:dev:orbit>')), undefined)
    assert.equal(toolEffect(tool('bash', 'npm', '<inline:dev:orb>')), undefined)
    assert.equal(toolEffect(tool('curl', 'inline', '<inline:dev:orb>')), undefined)
    assert.equal(toolEffect(tool('bash', 'sdk', '<sdk:bash>')), 'workspace-shell')
    assert.equal(toolEffect(tool('read', 'builtin', '<builtin:read>')), 'read')
  }
)

await claim(
  'the host and child gates share one orb predicate: read, grep, find and ls are reads, bash, write and edit are writes, and nothing else from dev:orb or another source is an orb tool',
  () => {
    const orb = (name: string) => tool(name, 'inline', '<inline:dev:orb>')
    for (const name of ['read', 'grep', 'find', 'ls'])
      assert.equal(orbToolAccess(orb(name)), 'read')
    for (const name of ['bash', 'write', 'edit']) assert.equal(orbToolAccess(orb(name)), 'write')
    assert.equal(orbToolAccess(orb('workspace')), undefined)
    assert.equal(orbToolAccess(tool('read', 'builtin', '<builtin:read>')), undefined)
    assert.equal(orbToolAccess(tool('bash', 'sdk', '<sdk:bash>')), undefined)
    assert.equal(orbToolAccess(undefined), undefined)
  }
)

await claim(
  'a read-only child gate admits dev:orb readers as reads through its controller and refuses dev:orb writers and same-named readers from any other source without asking it',
  async () => {
    const asked: string[] = []
    const channel = Object.assign(new EventEmitter(), {
      connected: true,
      send(
        message: Parameters<NonNullable<ControllerChannel['send']>>[0],
        callback: (error: Error | null) => void
      ): boolean {
        asked.push(message.operation)
        setImmediate(() => {
          channel.emit('message', {
            type: 'workspace-checked',
            requestId: message.requestId,
            useId: message.useId,
            allowed: true,
          })
          callback(null)
        })
        return true
      },
    })
    const checkout = join(sandbox, 'gate-checkout')
    const grant = {
      useId: randomUUID(),
      cwd: checkout,
      checkout,
      access: 'read',
    } as unknown as WorkspaceGrant
    const tools = [
      tool('read', 'inline', '<inline:dev:orb>'),
      tool('grep', 'inline', '<inline:dev:orb>'),
      tool('bash', 'inline', '<inline:dev:orb>'),
      tool('find', 'inline', '<inline:dev:orbit>'),
      tool('ls', 'npm', '<inline:dev:orb>'),
    ]
    const handlers = new Map<string, (event: unknown) => unknown>()
    await childWorkspaceExtension(
      grant,
      join(sandbox, 'gate-authority'),
      makeNativeWrites({ runPromise: Effect.runPromise, onError: () => undefined }),
      channel
    )({
      on: (event: string, handler: (event: unknown) => unknown) => handlers.set(event, handler),
      getAllTools: () => tools,
    } as unknown as ExtensionAPI)
    const call = async (toolName: string) =>
      handlers.get('tool_call')?.({
        type: 'tool_call',
        toolCallId: toolName,
        toolName,
        input: { path: 'calc.py' },
      })
    assert.equal(await call('read'), undefined)
    assert.equal(await call('grep'), undefined)
    assert.deepEqual(asked, ['read', 'read'])
    for (const name of ['bash', 'find', 'ls'])
      assert.deepEqual(
        await call(name),
        { block: true, reason: 'Child workspace is read-only' },
        name
      )
    assert.deepEqual(asked, ['read', 'read'], 'refused tools never reach the controller')
  }
)

await claim(
  "a read-only child's remote git_inspect runs over the pinned SSH options, with Git's isolation variables and every argument quoted for the orb's shell",
  () => {
    const repo = join(sandbox, "it's a repo")
    mkdirSync(repo)
    git(repo, 'init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'a $(touch pwned).txt'), 'x\n')
    const reader = openOrbReader({
      pi: {} as PiApi,
      reader: {
        label: 'orb test (192.0.2.7)',
        user: 'ubuntu',
        host: '192.0.2.7',
        keyPath: '/k',
        knownHostsPath: '/kh',
        controlPath: '/mux',
      },
      cwd: repo,
      checkout: repo,
      skillPaths: [],
      artifacts: [],
    })
    const command = reader.git(['--no-pager', '-C', repo, 'status', '--short'], {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    })
    assert.equal(command.file, 'ssh')
    assert.deepEqual(
      command.args.slice(0, -2),
      sshOptions({
        user: 'ubuntu',
        host: '192.0.2.7',
        keyPath: '/k',
        knownHostsPath: '/kh',
        controlPath: '/mux',
      })
    )
    assert.equal(command.args.at(-2), 'ubuntu@192.0.2.7')
    assert.equal(command.env.SSH_AUTH_SOCK, undefined)
    const script = command.args.at(-1) ?? ''
    assert.match(script, /^'env' 'GIT_CONFIG_GLOBAL=\/dev\/null' 'GIT_TERMINAL_PROMPT=0' 'git' /)
    const output = execFileSync('/bin/bash', ['-c', script], { cwd: sandbox, encoding: 'utf8' })
    assert.equal(output, '?? "a $(touch pwned).txt"\n')
    assert.ok(!existsSync(join(sandbox, 'pwned')) && !existsSync(join(repo, 'pwned')))
  }
)

await claim(
  "only Pi's spill files, skill files outside the checkout and the task artifact directory stay on the Mac; writes stay there only for the artifact directory",
  () => {
    const checkout = join(sandbox, 'homes-checkout')
    const skills = join(sandbox, 'homes-skills')
    const artifacts = join(sandbox, 'homes-artifacts')
    const homes = macHomes({
      checkout,
      skillPaths: [skills, join(checkout, '.agents', 'skills')],
      artifacts: () => [artifacts],
    })
    const temporary = tmpdir()
    assert.ok(homes.read(join(temporary, 'pi-bash-0123456789abcdef.log')))
    assert.ok(homes.read(join(realpathSync(temporary), 'pi-codemode-0123456789abcdef.txt')))
    assert.ok(!homes.read(join(temporary, 'notes.txt')), 'a plain temporary file goes to the orb')
    assert.ok(!homes.read(join(temporary, 'nested', 'pi-bash-0123456789abcdef.log')))
    assert.ok(homes.read(join(skills, 'tool', 'SKILL.md')))
    assert.ok(!homes.read(join(checkout, '.agents', 'skills', 'local', 'SKILL.md')))
    assert.ok(!homes.read(join(checkout, 'calc.py')))
    assert.ok(homes.read(join(artifacts, 'report.md')) && homes.write(join(artifacts, 'report.md')))
    assert.ok(!homes.write(join(skills, 'tool', 'SKILL.md')))
    assert.ok(!homes.write(join(temporary, 'pi-bash-0123456789abcdef.log')))
  }
)

await claim(
  'every SSH invocation pins host keys and forwards nothing; only the control master is a master',
  () => {
    const target = {
      user: 'ubuntu',
      host: '192.0.2.7',
      keyPath: '/k',
      knownHostsPath: '/kh',
      controlPath: '/mux',
    }
    for (const options of [sshOptions(target), masterOptions(target)]) {
      const settings = options.join(' ')
      for (const required of [
        '-F /dev/null',
        'StrictHostKeyChecking=yes',
        'UserKnownHostsFile=/kh',
        'GlobalKnownHostsFile=/dev/null',
        'IdentityAgent=none',
        'ForwardAgent=no',
        'ClearAllForwardings=yes',
      ])
        assert.ok(settings.includes(required), `${required} in ${settings}`)
    }
    assert.ok(sshOptions(target).includes('ControlMaster=no'))
    assert.ok(!sshOptions(target).includes('ControlMaster=yes'))
    assert.ok(masterOptions(target).includes('ControlMaster=yes'))
    assert.ok(!masterOptions(target).includes('ControlMaster=no'))
  }
)

await claim(
  'every admitted return reports its completion, also when the start report or the return itself fails, so no orb-return use stays open',
  async () => {
    const within = { useId: 'presence' } as unknown as WorkspaceGrant
    const scenario = async (startFails: boolean, writeFails: boolean) => {
      const facts: string[] = []
      const attachment = {
        authorize: () =>
          Effect.succeed({
            kind: 'ready',
            grant: { useId: 'return' } as unknown as WorkspaceGrant,
          }),
        reportExecution: (_grant: WorkspaceGrant, fact: { readonly kind: string }) =>
          Effect.suspend(() => {
            facts.push(fact.kind)
            return startFails && fact.kind === 'operation-started'
              ? Effect.fail(orbFailure('report refused'))
              : Effect.succeed({})
          }),
      } as unknown as WorkspaceAttachment
      const write = Effect.suspend(() => {
        facts.push('write')
        return writeFails ? Effect.fail(orbFailure('git failed')) : Effect.succeed('done')
      })
      const outcome = await Effect.runPromiseExit(
        withReturnAdmission(attachment, within, '/checkout', write, () => undefined)
      )
      return { facts, ok: outcome._tag === 'Success' }
    }
    assert.deepEqual(await scenario(false, false), {
      facts: ['operation-started', 'write', 'operation-completed'],
      ok: true,
    })
    assert.deepEqual(await scenario(true, false), {
      facts: ['operation-started', 'operation-completed'],
      ok: false,
    })
    assert.deepEqual(await scenario(false, true), {
      facts: ['operation-started', 'write', 'operation-completed'],
      ok: false,
    })
  }
)

await claim(
  'the orb record exists in phase requested, with its private key, before the orbit request is sent',
  async () => {
    const { mac } = newCheckout('record')
    const dataHome = join(sandbox, 'record-data')
    mkdirSync(dataHome, { mode: 0o700 })
    const grant = { useId: 'presence-use' } as unknown as WorkspaceGrant
    const attachment = {
      binding: { taskId: undefined },
      authorize: () => Effect.succeed({ kind: 'ready', grant }),
      sweeps: Stream.empty,
    } as unknown as WorkspaceAttachment
    let observed: unknown
    const keystone: Keystone = {
      authUrl: 'http://192.0.2.1/identity',
      token: Effect.succeed({
        id: 'token',
        expiresAt: undefined,
        orbitUrl: 'http://192.0.2.1/orbit',
        project: { id: 'p1', name: 'demo' },
      }),
      invalidate: Effect.void,
    }
    const unused = Effect.die('the check sends only the creation request')
    const orbit: Orbit = {
      url: Effect.succeed('http://192.0.2.1/orbit'),
      create: () =>
        Effect.suspend(() => {
          const [id] = readdirSync(join(dataHome, 'orbs'))
          const directory = join(dataHome, 'orbs', id ?? '')
          const record = JSON.parse(readFileSync(join(directory, 'record.json'), 'utf8'))
          observed = {
            phase: record.phase,
            orbId: record.orbId,
            presence: record.presenceUseId,
            key: lstatSync(join(directory, 'key')).mode & 0o777,
            pub: readFileSync(join(directory, 'key.pub'), 'utf8').startsWith('ssh-ed25519 '),
          }
          return Effect.fail(orbFailure('the check stops before orbit'))
        }),
      get: () => unused,
      remove: () => unused,
      list: unused,
    }
    const lines: string[] = []
    const env: NodeJS.ProcessEnv = {
      OS_AUTH_URL: 'http://192.0.2.1/identity',
      OS_USERNAME: 'demo',
      OS_PASSWORD: 'secret',
      OS_PROJECT_NAME: 'demo',
      OS_CACERT: '',
      KEEP: 'kept',
    }
    await assert.rejects(
      run(
        openOrbSession(
          {
            pi: {} as PiApi,
            dataHome,
            env,
            print: line => lines.push(line),
            cloud: () => ({ keystone, orbit }),
          },
          {
            attachment,
            lifecycle: lifecycle.effect,
            cwd: mac,
            skillPaths: [],
            conversation: join(dataHome, 'session.jsonl'),
          }
        )
      ),
      /the check stops before orbit/
    )
    assert.deepEqual(observed, {
      phase: 'requested',
      orbId: undefined,
      presence: 'presence-use',
      key: 0o600,
      pub: true,
    })
    assert.deepEqual(
      readdirSync(join(dataHome, 'orbs')),
      [],
      'a launch that created no orb leaves no record'
    )
    assert.deepEqual(env, { KEEP: 'kept' }, 'the OS_* variables are removed after reading them')
  }
)

const KEYSTONE = {
  authUrl: 'http://192.0.2.1/identity',
  projectId: 'p1',
  projectName: 'demo',
} as const

const recordFields = (checkout: string, presenceUseId?: string) => ({
  keystone: KEYSTONE,
  checkout,
  branch: 'main',
  orbPath: checkout,
  ...(presenceUseId === undefined ? {} : { presenceUseId }),
  conversation: join(checkout, 'session.jsonl'),
})

const exited = (child: ChildProcess): Promise<NodeJS.Signals | null> =>
  new Promise(resolveExit => child.once('exit', (_code, signal) => resolveExit(signal)))

await claim(
  "a record lock held by a live dev --orb process blocks recovery, and the lock of an owner that died is taken with the record's fields intact",
  async () => {
    const dataHome = join(sandbox, 'lock-data')
    mkdirSync(dataHome, { mode: 0o700 })
    const checkout = join(sandbox, 'lock-checkout')
    const owner = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
          import * as NodeServices from '@effect/platform-node/NodeServices'
          import { Effect } from 'effect'
          import { createRecord } from ${JSON.stringify(new URL('../../src/orb/registry.ts', import.meta.url).href)}
          const record = await Effect.runPromise(Effect.provide(createRecord(${JSON.stringify(dataHome)}, ${JSON.stringify(recordFields(checkout, 'presence-use'))}), NodeServices.layer))
          process.stdout.write(record.directory + '\\n')
          setInterval(() => {}, 1000)
        `,
      ],
      { cwd: new URL('../..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'inherit'] }
    )
    const directory = await new Promise<string>((resolveLine, rejectLine) => {
      let text = ''
      owner.stdout.on('data', (chunk: Buffer) => {
        text += chunk.toString('utf8')
        if (text.includes('\n')) resolveLine(text.trim())
      })
      owner.once('exit', code => rejectLine(new Error(`the owner exited with ${code}`)))
    })
    try {
      assert.deepEqual(await run(claimRecord(directory)), { kind: 'owned' })
      assert.deepEqual(
        await run(claimRecord(directory)),
        { kind: 'owned' },
        'a refused claim leaves the lock to its owner'
      )
    } finally {
      owner.kill('SIGKILL')
    }
    assert.equal(await exited(owner), 'SIGKILL')
    const claimed = await run(claimRecord(directory))
    assert.equal(claimed.kind, 'claimed')
    if (claimed.kind !== 'claimed') return
    assert.equal(claimed.record.current().presenceUseId, 'presence-use')
    assert.equal(claimed.record.current().phase, 'requested')
    assert.deepEqual(
      await run(claimRecord(directory)),
      { kind: 'owned' },
      'the recovering process is now the only writer of the record'
    )
    await run(claimed.record.release)
    assert.equal((await run(claimRecord(directory))).kind, 'claimed')
  }
)

await claim(
  "recovery settles a crashed dev --orb session's presence so the next writer keeps the same checkout, keeps it when the session was returning, and touches no live or already settled use",
  async () => {
    const root = join(sandbox, 'settle-authority')
    const settling = await openLifecycle({ root })
    let conversations = 0
    const conversation = () => {
      conversations += 1
      const dataHome = join(sandbox, `settle-data-${conversations}`)
      mkdirSync(dataHome, { recursive: true })
      const sessionFile = join(dataHome, 'session.jsonl')
      writeFileSync(sessionFile, '{}\n', { mode: 0o600 })
      return { sessionId: `settle-${conversations}`, sessionFile, dataHome }
    }
    const crashWriter = (
      session: ReturnType<typeof conversation>,
      checkout: string
    ): { readonly writer: WorkspaceGrant; readonly reader: WorkspaceGrant } => {
      const crashed = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
            import { openLifecycle } from ${JSON.stringify(new URL('../workspace/workspace-test-lifecycle.ts', import.meta.url).href)}
            const lifecycle = await openLifecycle({ root: ${JSON.stringify(root)} })
            const attachment = await lifecycle.attach({ conversation: ${JSON.stringify(session)}, cwd: ${JSON.stringify(checkout)} })
            const writer = await attachment.authorize({ kind: 'write', cwd: ${JSON.stringify(checkout)} })
            const reader = await attachment.authorize({ kind: 'read', cwd: ${JSON.stringify(checkout)} })
            process.stdout.write(JSON.stringify({ writer: writer.grant, reader: reader.grant }))
            process.kill(process.pid, 'SIGKILL')
          `,
        ],
        { cwd: new URL('../..', import.meta.url).pathname, encoding: 'utf8' }
      )
      assert.equal(crashed.signal, 'SIGKILL', crashed.stderr)
      return JSON.parse(crashed.stdout) as { writer: WorkspaceGrant; reader: WorkspaceGrant }
    }
    const { mac } = newCheckout('settle')
    const { writer: dead, reader } = crashWriter(conversation(), mac)
    const lines: string[] = []
    const settle = (phase: OrbRecord['phase'], checkout: string, useId: string) =>
      run(
        settlePresence(
          { lifecycle: settling.effect, print: line => lines.push(line) },
          {
            ...recordFields(checkout, useId),
            id: RECORD,
            phase,
            baseRef: `refs/dev/orb/${RECORD}/base`,
            createdAt: '2026-10-28T10:00:00.000Z',
            updatedAt: '2026-10-28T10:00:00.000Z',
          }
        )
      )
    const [blocked] = await settling.inspect({ cwd: mac })
    assert.equal(blocked?.outcome, 'blocked')
    assert.equal(blocked.reservationId, dead.reservationId, 'the dead task still reserves it')

    const { mac: other } = newCheckout('settle-other')
    assert.equal(
      (await run(settling.effect.settleOrbPresence({ cwd: other, useId: dead.useId }))).outcome,
      'absent',
      "another checkout's settlement cannot reach this use"
    )
    await assert.rejects(
      run(settling.effect.settleOrbPresence({ cwd: mac, useId: reader.useId })),
      /not the writer presence/,
      'only the writer presence of a session is settled'
    )

    await settle('returning', mac, dead.useId)
    assert.match(lines.join('\n'), new RegExp(`dev workspace release ${dead.taskId}`))
    const [kept] = await settling.inspect({ cwd: mac })
    assert.deepEqual(
      kept?.uses.map(use => use.id).toSorted(),
      [dead.useId, reader.useId].toSorted(),
      'a returning session keeps its uses'
    )

    lines.length = 0
    await settle('active', mac, dead.useId)
    assert.match(lines.join('\n'), /reservation .* was released; files and commits are unchanged/)
    const [settled] = await settling.inspect({ cwd: mac })
    assert.deepEqual(settled?.uses, [])
    assert.equal(settled.reservationId, undefined)
    const [receipt] = await settling.inspect({ taskId: dead.taskId })
    assert.equal(receipt?.outcome, 'released')
    assert.match(receipt.reason, /^By the orb recovery at dev --orb startup: /)
    const next = await settling.attach({ conversation: conversation(), cwd: mac })
    const written = await next.authorize({ kind: 'write', cwd: mac })
    assert.equal(written.kind, 'ready', 'the next writer is not isolated')
    if (written.kind === 'ready') assert.equal(written.grant.checkout, mac)

    lines.length = 0
    await settle('active', mac, dead.useId)
    assert.deepEqual(lines, [], 'settling again changes nothing')
    if (written.kind === 'ready') {
      await assert.rejects(
        run(settling.effect.settleOrbPresence({ cwd: mac, useId: written.grant.useId })),
        /still running/,
        "a live session's presence is never settled"
      )
      await next.close()
      const [closed] = await settling.inspect({ cwd: mac })
      assert.equal(closed?.reservationId, written.grant.reservationId)
      assert.deepEqual(
        await run(settling.effect.settleOrbPresence({ cwd: mac, useId: written.grant.useId })),
        {
          outcome: 'absent',
          reason: `Use ${written.grant.useId} is settled or no longer recorded; nothing changed.`,
        },
        'a session that quit settled its own presence'
      )
      const [after] = await settling.inspect({ cwd: mac })
      assert.equal(
        after?.reservationId,
        written.grant.reservationId,
        'the reservation its quit kept stays'
      )
    }

    const { mac: resumed } = newCheckout('settle-resumed')
    const session = conversation()
    const earlier = await settling.attach({ conversation: session, cwd: resumed })
    const before = await earlier.authorize({ kind: 'write', cwd: resumed })
    assert.equal(before.kind, 'ready')
    await earlier.close()
    const { writer: continued } = crashWriter(session, resumed)
    assert.equal(continued.taskId, before.grant.taskId, 'the continued conversation keeps its task')
    lines.length = 0
    await settle('active', resumed, continued.useId)
    assert.doesNotMatch(lines.join('\n'), /was released/)
    const [retained] = await settling.inspect({ cwd: resumed })
    assert.deepEqual(
      retained?.uses.map(use => [use.id, use.stage]),
      [[before.grant.useId, 'quiescent']],
      "the crashed session's uses are gone and the earlier session's settled use keeps the task's claim"
    )
    assert.equal(
      retained.reservationId,
      before.grant.reservationId,
      'a reservation the task held before the crashed session stays'
    )
    await settling.close()
  }
)

const orbView = (id: string, created: string, status: OrbView['status'] = 'ACTIVE'): OrbView => ({
  id,
  status,
  image: 'ubuntu-24.04-arm64-dev',
  ssh_host: null,
  ssh_user: null,
  ssh_host_keys: null,
  fault: null,
  created_at: created,
})

await claim(
  'unregistered orbs are those of the project created since the earliest unanswered request, read as UTC, allowing one minute of clock skew, and named by no record; an unreadable creation time excludes an orb',
  () => {
    const found = unregisteredOrbs(
      [
        orbView('after', '2026-10-28T10:00:30'),
        orbView('skew', '2026-10-28T09:59:30'),
        orbView('before', '2026-10-28T09:58:00'),
        orbView('local-hour', '2026-10-28T09:30:00'),
        orbView('registered', '2026-10-28T10:01:00'),
        orbView('deleting', '2026-10-28T10:01:00', 'DELETING'),
        orbView('deleted', '2026-10-28T10:01:00', 'DELETED'),
        orbView('error', '2026-10-28T10:02:00+00:00', 'ERROR'),
        orbView('undated', 'soon'),
      ],
      new Set(['registered']),
      '2026-10-28T10:00:00.000Z'
    )
    assert.deepEqual(
      found.map(orb => orb.id),
      ['after', 'skew', 'error']
    )
  }
)

const startScenario = async (
  name: string,
  orbit: Orbit,
  control: {
    readonly drive?: (fiber: Fiber.Fiber<unknown, unknown>) => Effect.Effect<void>
    readonly secondInterrupt?: Effect.Effect<void>
  } = {}
) => {
  const { mac } = newCheckout(`start-${name}`)
  const dataHome = join(sandbox, `start-${name}-data`)
  mkdirSync(dataHome, { mode: 0o700 })
  const attachment = {
    binding: { taskId: undefined },
    authorize: () =>
      Effect.succeed({
        kind: 'ready',
        grant: { useId: 'presence-use' } as unknown as WorkspaceGrant,
      }),
    sweeps: Stream.empty,
  } as unknown as WorkspaceAttachment
  const keystone: Keystone = {
    authUrl: 'http://192.0.2.1/identity',
    token: Effect.succeed({
      id: 'token',
      expiresAt: undefined,
      orbitUrl: 'http://192.0.2.1/orbit',
      project: { id: 'p1', name: 'demo' },
    }),
    invalidate: Effect.void,
  }
  const lines: string[] = []
  const opening = openOrbSession(
    {
      pi: {} as PiApi,
      dataHome,
      env: {
        OS_AUTH_URL: 'http://192.0.2.1/identity',
        OS_USERNAME: 'demo',
        OS_PASSWORD: 'secret',
        OS_PROJECT_NAME: 'demo',
      },
      print: line => lines.push(line),
      cloud: () => ({ keystone, orbit }),
      ...(control.secondInterrupt === undefined
        ? {}
        : { secondInterrupt: control.secondInterrupt }),
    },
    {
      attachment,
      lifecycle: lifecycle.effect,
      cwd: mac,
      skillPaths: [],
      conversation: join(dataHome, 'session.jsonl'),
    }
  ).pipe(Effect.provide(NodeServices.layer))
  const { drive } = control
  const exit = await Effect.runPromise(
    drive === undefined
      ? Effect.exit(opening)
      : Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(opening)
          yield* drive(fiber)
          return yield* Fiber.await(fiber)
        })
  )
  return {
    exit,
    error: Exit.isFailure(exit) ? errorText(Cause.squash(exit.cause)) : undefined,
    interrupted: Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause),
    records: readdirSync(join(dataHome, 'orbs')).map(id => join(dataHome, 'orbs', id)),
    text: lines.join('\n'),
  }
}

const fakeOrbit = (input: {
  readonly create: Effect.Effect<OrbView, OrbError>
  readonly states?: readonly OrbView['status'][]
  readonly afterDelete?: OrbView['status']
  readonly list?: readonly OrbView[]
}) => {
  const removed: string[] = []
  const states = [...(input.states ?? [])]
  const polled = Deferred.makeUnsafe<void>()
  const deleteSent = Deferred.makeUnsafe<void>()
  const orbit: Orbit = {
    url: Effect.succeed('http://192.0.2.1/orbit'),
    create: () => input.create,
    get: id =>
      Effect.sync(() => {
        const status = removed.includes(id)
          ? (input.afterDelete ?? 'DELETED')
          : (states.shift() ?? 'BUILDING')
        if (status === 'BUILDING') Deferred.doneUnsafe(polled, Effect.void)
        return {
          ...orbView(id, '2026-10-28T10:00:00', status),
          fault: status === 'ERROR' ? 'No valid host was found' : null,
        }
      }),
    remove: id =>
      Effect.sync(() => {
        removed.push(id)
        Deferred.doneUnsafe(deleteSent, Effect.void)
        return orbView(id, '2026-10-28T10:00:00', 'DELETING')
      }),
    list: Effect.succeed(input.list ?? []),
  }
  return {
    orbit,
    removed,
    building: Deferred.await(polled),
    deleteSent: Deferred.await(deleteSent),
  }
}

const createdOrb = (status: OrbView['status'] = 'RESERVING') =>
  Effect.succeed(orbView('orb-started', '2026-10-28T10:00:00', status))

await claim(
  "a refused creation ends the launch naming orbit's answer and leaves no record; a 409 also lists the project's active orbs and the delete command",
  async () => {
    for (const status of [401, 403, 502, 503]) {
      const { orbit, removed } = fakeOrbit({
        create: Effect.fail(
          orbFailure(
            `orbit answered POST /v1/orbs with ${status}: refused ${status}`,
            undefined,
            status
          )
        ),
      })
      const started = await startScenario(`refused-${status}`, orbit)
      assert.match(started.error ?? '', new RegExp(`with ${status}: refused ${status}`))
      assert.deepEqual(started.records, [], `${status} leaves no record`)
      assert.deepEqual(removed, [], 'no orb was created, so none is deleted')
    }
    const { orbit } = fakeOrbit({
      create: Effect.fail(
        orbFailure('orbit answered POST /v1/orbs with 409: no free lease', undefined, 409)
      ),
      list: [
        orbView('orb-lead-0000', '2026-10-28T09:00:00', 'ACTIVE'),
        orbView('orb-child-000', '2026-10-28T09:10:00', 'BUILDING'),
        orbView('orb-leaving-0', '2026-10-28T09:20:00', 'DELETING'),
      ],
    })
    const full = await startScenario('refused-409', orbit)
    const message = full.error ?? ''
    assert.match(
      message,
      /no capacity for another orb: orbit answered POST \/v1\/orbs with 409: no free lease/
    )
    assert.match(
      message,
      /Project demo has 2 active orb\(s\):\n  orb-lead-0000 ACTIVE since .*\n  orb-child-000 BUILDING since /
    )
    assert.doesNotMatch(message, /orb-leaving-0/, 'an orb being deleted is not active')
    assert.ok(message.includes('curl -X DELETE'), message)
    assert.ok(message.includes('http://192.0.2.1/orbit/v1/orbs/<orb-id>'), message)
    assert.deepEqual(full.records, [])
  }
)

await claim(
  "an orb that reaches ERROR is deleted, orbit's fault is named, and its record is removed once orbit reports DELETED",
  async () => {
    const { orbit, removed } = fakeOrbit({ create: createdOrb(), states: ['ERROR'] })
    const started = await startScenario('error', orbit)
    assert.match(started.error ?? '', /orb orb-star reached ERROR: No valid host was found/)
    assert.deepEqual(removed, ['orb-started'])
    assert.match(started.text, /Deleting orb orb-star after the failed start/)
    assert.match(started.text, /orb orb-star deleted/)
    assert.deepEqual(started.records, [])
  }
)

await claim(
  'an interrupt while the creation request is in flight waits for its answer, then deletes the orb it created and removes the record once orbit reports DELETED',
  async () => {
    const requested = Deferred.makeUnsafe<void>()
    const answer = Deferred.makeUnsafe<void>()
    const { orbit, removed } = fakeOrbit({
      create: Deferred.succeed(requested, undefined).pipe(
        Effect.andThen(Deferred.await(answer)),
        Effect.andThen(createdOrb())
      ),
    })
    const started = await startScenario('interrupt-request', orbit, {
      drive: fiber =>
        Effect.gen(function* () {
          yield* Deferred.await(requested)
          fiber.interruptUnsafe()
          yield* Deferred.succeed(answer, undefined)
        }),
    })
    assert.equal(started.interrupted, true, started.error ?? 'not interrupted')
    assert.deepEqual(removed, ['orb-started'], 'the orb the request created is deleted')
    assert.match(started.text, /Deleting orb orb-star after the interrupted start/)
    assert.deepEqual(started.records, [])
  }
)

await claim(
  'an interrupt during BUILDING deletes the orb; a second interrupt stops waiting for DELETED and keeps the record, unlocked, for the next recovery',
  async () => {
    const building = fakeOrbit({ create: createdOrb('BUILDING'), states: ['BUILDING'] })
    const cancelled = await startScenario('interrupt-building', building.orbit, {
      drive: fiber => Effect.andThen(building.building, Effect.forkChild(Fiber.interrupt(fiber))),
    })
    assert.equal(cancelled.interrupted, true, cancelled.error ?? 'not interrupted')
    assert.deepEqual(building.removed, ['orb-started'])
    assert.deepEqual(cancelled.records, [])

    const second = Deferred.makeUnsafe<void>()
    const stuck = fakeOrbit({
      create: createdOrb('BUILDING'),
      states: ['BUILDING'],
      afterDelete: 'DELETING',
    })
    const kept = await startScenario('interrupt-twice', stuck.orbit, {
      secondInterrupt: Deferred.await(second),
      drive: fiber =>
        Effect.gen(function* () {
          yield* stuck.building
          yield* Effect.forkChild(Fiber.interrupt(fiber))
          yield* stuck.deleteSent
          yield* Deferred.succeed(second, undefined)
        }),
    })
    assert.equal(kept.interrupted, true, kept.error ?? 'not interrupted')
    assert.deepEqual(stuck.removed, ['orb-started'], 'DELETE was sent before the wait stopped')
    assert.equal(kept.records.length, 1, 'the record stays for the recovery sweep')
    const [directory = ''] = kept.records
    const record = JSON.parse(readFileSync(join(directory, 'record.json'), 'utf8'))
    assert.deepEqual([record.phase, record.orbId], ['deleting', 'orb-started'])
    assert.match(kept.text, /the wait for DELETED was interrupted while orb orb-star read DELETING/)
    assert.match(kept.text, /next dev --orb deletes the orb/)
    assert.ok(kept.text.includes('http://192.0.2.1/orbit/v1/orbs/orb-started'))
    const claimed = await run(claimRecord(directory))
    assert.equal(claimed.kind, 'claimed', 'the interrupted session released the record lock')
    if (claimed.kind === 'claimed') await run(claimed.record.release)
  }
)

await claim(
  'at quit, an interrupt stops only the wait for DELETED: the DELETE was sent and the record stays in phase deleting',
  async () => {
    const dataHome = join(sandbox, 'quit-stop-data')
    mkdirSync(dataHome, { mode: 0o700 })
    const record = await run(createRecord(dataHome, recordFields(join(sandbox, 'quit-stop'))))
    await run(record.update({ phase: 'active', orbId: 'orb-quitting' }))
    const stuck = fakeOrbit({ create: createdOrb(), afterDelete: 'DELETING' })
    const lines: string[] = []
    const stopped = await run(
      Effect.exit(
        deleteRecorded(
          stuck.orbit,
          record,
          'orb-quitting',
          line => lines.push(line),
          stuck.deleteSent
        )
      )
    )
    assert.equal(Exit.isFailure(stopped), true)
    if (Exit.isFailure(stopped))
      assert.match(
        errorText(Cause.squash(stopped.cause)),
        /the wait for DELETED was interrupted while orb orb-quit read DELETING/
      )
    assert.deepEqual(stuck.removed, ['orb-quitting'])
    assert.deepEqual(lines, ['Deleting orb orb-quit (DELETING 0:00)'])
    assert.equal(record.current().phase, 'deleting', 'the next recovery deletes the orb')
    assert.ok(existsSync(join(record.directory, 'record.json')))
    await run(record.release)
  }
)

const TOKEN = {
  id: 'token',
  expiresAt: undefined,
  orbitUrl: 'http://192.0.2.1/orbit',
  project: { id: KEYSTONE.projectId, name: KEYSTONE.projectName },
}

await claim(
  "a writing child's orb refused with 409 fails provisioning with the project's active orb count and leaves no record; one that reaches ERROR is deleted, its fault named and its record removed, and neither is handed to the controller",
  async () => {
    const { mac } = newCheckout('child-provision')
    const worktree = join(sandbox, 'child-provision', 'managed')
    git(mac, 'worktree', 'add', '-q', '--detach', worktree, 'main')
    const dataHome = join(sandbox, 'child-provision-data')
    mkdirSync(dataHome, { mode: 0o700 })
    const services = await run(Effect.context<ChildProcessSpawner.ChildProcessSpawner>())
    const provision = async (orbit: Orbit) => {
      const reports: AttemptOrb[] = []
      let adopted = false
      const children = makeChildOrbs(
        {
          dataHome,
          keystone: KEYSTONE,
          token: TOKEN,
          orbit,
          config: {
            path: join(dataHome, 'orb.json'),
            size: { vcpus: 2, memory_mb: 2048, disk_gb: 10 },
            image: 'ubuntu-24.04-arm64-dev',
            sshAllowedCidr: '192.0.2.0/24',
          },
          conversation: join(dataHome, 'session.jsonl'),
          lead: {
            ssh: makeOrbSsh({
              user: 'ubuntu',
              host: 'lead.invalid',
              keyPath: join(dataHome, 'key'),
              knownHostsPath: join(dataHome, 'known_hosts'),
              controlPath: join(dataHome, 'mux'),
            }),
            root: mac,
            label: "the lead's orb",
            record: 'lead-record',
          },
          lifecycle: lifecycle.effect,
        },
        services
      )
      const exit = await Effect.runPromiseExit(
        children.provision({
          attempt: asAttemptId(randomUUID()),
          worktree,
          report: orb => Effect.sync(() => reports.push(orb)),
          adopt: () => {
            adopted = true
          },
        })
      )
      return {
        error: Exit.isFailure(exit) ? errorText(Cause.squash(exit.cause)) : undefined,
        reports,
        adopted,
        records: readdirSync(join(dataHome, 'orbs')),
      }
    }

    const full = await provision(
      fakeOrbit({
        create: Effect.fail(
          orbFailure('orbit answered POST /v1/orbs with 409: no free lease', undefined, 409)
        ),
        list: [
          orbView('orb-lead-0000', '2026-10-28T09:00:00', 'ACTIVE'),
          orbView('orb-child-000', '2026-10-28T09:10:00', 'BUILDING'),
          orbView('orb-leaving-0', '2026-10-28T09:20:00', 'DELETING'),
        ],
      }).orbit
    )
    assert.equal(
      full.error,
      'orbit capacity exhausted: 2 active orbs in the project; wait for a child to finish'
    )
    assert.deepEqual(
      full.reports.map(report => report.status),
      ['requested']
    )
    assert.deepEqual(full.records, [], 'a refused creation leaves no record')
    assert.equal(full.adopted, false)

    const failing = fakeOrbit({ create: createdOrb(), states: ['ERROR'] })
    const failed = await provision(failing.orbit)
    assert.match(
      failed.error ?? '',
      /orb orb-star reached ERROR: No valid host was found Orb orb-star was deleted\./
    )
    assert.deepEqual(failing.removed, ['orb-started'])
    assert.deepEqual(failed.reports.at(-1), {
      record: failed.reports[0]?.record,
      id: 'orb-started',
      status: 'DELETED',
      report: 'Orb orb-star was deleted.',
    })
    assert.deepEqual(failed.records, [], 'the record is removed once orbit reports DELETED')
    assert.equal(failed.adopted, false)
  }
)

await claim(
  "recovery removes the records of orbs orbit no longer has or is deleting, deletes an orb that holds no work, and keeps an orb whose work it cannot return, one it cannot read and another project's",
  async () => {
    const dataHome = join(sandbox, 'recover-states')
    mkdirSync(dataHome, { mode: 0o700 })
    const checkout = join(sandbox, 'recover-states-checkout')
    const gone = join(sandbox, 'recover-states-missing')
    const recorded = async (
      orbId: string,
      phase: OrbRecord['phase'],
      fields: Parameters<typeof createRecord>[1] = recordFields(checkout)
    ) => {
      const record = await run(createRecord(dataHome, fields))
      await run(record.update({ phase, orbId }))
      await run(record.writeKnownHosts('192.0.2.9', ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA']))
      await run(record.release)
      return record.id
    }
    const ids = {
      gone: await recorded('orb-gone', 'active'),
      deleting: await recorded('orb-deleting', 'active'),
      error: await recorded('orb-error', 'active'),
      unreadable: await recorded('orb-unreadable', 'active'),
      created: await recorded('orb-created', 'created'),
      moved: await recorded('orb-moved', 'active', recordFields(gone)),
      baseless: await recorded(
        'orb-baseless',
        'active',
        recordFields(newCheckout('recover-baseless').mac)
      ),
      foreign: await recorded('orb-foreign', 'active', {
        ...recordFields(checkout),
        keystone: { ...KEYSTONE, projectId: 'another-project', projectName: 'another' },
      }),
    }
    const statuses = new Map<string, OrbView['status']>([
      ['orb-deleting', 'DELETING'],
      ['orb-error', 'ERROR'],
      ['orb-created', 'ACTIVE'],
      ['orb-moved', 'ACTIVE'],
      ['orb-baseless', 'ACTIVE'],
    ])
    const read: string[] = []
    const removed: string[] = []
    const orbit: Orbit = {
      url: Effect.succeed(TOKEN.orbitUrl),
      create: () => Effect.die('recovery creates no orb'),
      get: id =>
        Effect.suspend(() => {
          read.push(id)
          if (id === 'orb-unreadable')
            return Effect.fail(orbFailure('orbit is down', undefined, 503))
          const status = statuses.get(id)
          return status === undefined
            ? Effect.fail(orbFailure('not found', undefined, 404))
            : Effect.succeed({
                ...orbView(id, '2026-10-28T10:00:00', status),
                ssh_host: '192.0.2.9',
                ssh_user: 'ubuntu',
                fault: 'boom',
              })
        }),
      remove: id =>
        Effect.sync(() => {
          removed.push(id)
          statuses.set(id, 'DELETED')
          return orbView(id, '2026-10-28T10:00:00', 'DELETING')
        }),
      list: Effect.die('no record is waiting for an orb id'),
    }
    const lines: string[] = []
    await run(
      recoverOrbs({
        dataHome,
        authUrl: KEYSTONE.authUrl,
        token: TOKEN,
        orbit,
        lifecycle: lifecycle.effect,
        print: line => lines.push(line),
      })
    )
    const remaining = new Set(readdirSync(join(dataHome, 'orbs')))
    assert.deepEqual(
      Object.fromEntries(Object.entries(ids).map(([name, id]) => [name, remaining.has(id)])),
      {
        gone: false,
        deleting: false,
        error: true,
        unreadable: true,
        created: false,
        moved: true,
        baseless: true,
        foreign: true,
      }
    )
    assert.deepEqual(removed, ['orb-created'], 'only the orb without work is deleted')
    assert.ok(!read.includes('orb-foreign'), "another project's orb is not read")
    const text = lines.join('\n')
    assert.match(text, /orb orb-erro is ERROR \(boom\), so its work cannot be returned/)
    assert.match(text, /the checkout .*recover-states-missing no longer exists/)
    assert.match(text, /lacks refs\/dev\/orb\/[0-9a-f-]+\/base, the upload this orb started from/)
    assert.match(text, /belongs to project another/)
    assert.ok(
      text.includes(`${TOKEN.orbitUrl}/v1/orbs/orb-error`),
      'a kept orb comes with its delete command'
    )
  }
)

const requestedScenario = async (name: string, confirm?: boolean, corrupt = false) => {
  const dataHome = join(sandbox, `requested-${name}`)
  mkdirSync(dataHome, { mode: 0o700 })
  if (corrupt) {
    const damaged = join(dataHome, 'orbs', '5c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f')
    mkdirSync(damaged, { recursive: true, mode: 0o700 })
    writeFileSync(join(damaged, 'record.json'), '{', { mode: 0o600 })
  }
  const checkout = join(sandbox, `requested-${name}-checkout`)
  const dead = await run(createRecord(dataHome, recordFields(checkout)))
  await run(dead.release)
  const live = await run(createRecord(dataHome, recordFields(checkout)))
  await run(live.update({ phase: 'created', orbId: 'orb-registered' }))
  const requesting = await run(createRecord(dataHome, recordFields(checkout)))
  const recent = new Date(Date.now() + 5_000).toISOString().slice(0, 19)
  const old = new Date(Date.now() - 3_600_000).toISOString().slice(0, 19)
  const views: OrbView[] = [
    orbView('orb-unregistered', recent),
    orbView('orb-old', old),
    orbView('orb-undated', 'yesterday'),
    orbView('orb-registered', recent),
    orbView('orb-late', recent),
  ]
  const removed: string[] = []
  const unused = Effect.die('recovery reads only the list and deletes')
  const orbit: Orbit = {
    url: Effect.succeed('http://192.0.2.1/orbit'),
    create: () => unused,
    get: id =>
      Effect.succeed({ ...views.find(view => view.id === id), status: 'DELETED' } as OrbView),
    remove: id =>
      Effect.sync(() => {
        removed.push(id)
        return { ...views.find(view => view.id === id), status: 'DELETING' } as OrbView
      }),
    list: Effect.succeed(views),
  }
  const prompts: string[] = []
  const lines: string[] = []
  await run(
    recoverOrbs({
      dataHome,
      authUrl: KEYSTONE.authUrl,
      token: TOKEN,
      orbit,
      lifecycle: lifecycle.effect,
      print: line => lines.push(line),
      ...(confirm === undefined
        ? {}
        : {
            confirm: prompt =>
              Effect.gen(function* () {
                prompts.push(prompt)
                yield* Effect.orDie(requesting.update({ phase: 'created', orbId: 'orb-late' }))
                return confirm
              }),
          }),
    })
  )
  const remaining = readdirSync(join(dataHome, 'orbs')).toSorted()
  await run(live.release)
  await run(requesting.release)
  const text = lines.join('\n')
  return {
    removed,
    prompts: prompts.length,
    deadKept: remaining.includes(dead.id),
    liveKept: remaining.includes(live.id) && remaining.includes(requesting.id),
    listed:
      text.includes('orb-unregistered') &&
      !text.includes('orb-old') &&
      !text.includes('orb-undated'),
  }
}

await claim(
  'orbs a session that ended while requesting may have created are deleted only after y at an interactive terminal, except one a running session recorded meanwhile, and never while a record cannot be read; otherwise they and the record are kept',
  async () => {
    assert.deepEqual(await requestedScenario('no-terminal'), {
      removed: [],
      prompts: 0,
      deadKept: true,
      liveKept: true,
      listed: true,
    })
    assert.deepEqual(await requestedScenario('declined', false), {
      removed: [],
      prompts: 1,
      deadKept: true,
      liveKept: true,
      listed: true,
    })
    assert.deepEqual(await requestedScenario('confirmed', true), {
      removed: ['orb-unregistered'],
      prompts: 1,
      deadKept: false,
      liveKept: true,
      listed: true,
    })
    assert.deepEqual(await requestedScenario('corrupt', true, true), {
      removed: [],
      prompts: 0,
      deadKept: true,
      liveKept: true,
      listed: false,
    })
  }
)

await claim('plain dev loads no orb module and reads no OS_* variable', async () => {
  const repo = join(sandbox, 'plain-repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'initial')
  const home = join(sandbox, 'plain-home')
  mkdirSync(join(home, '.agents', 'skills'), { recursive: true })
  const report = join(sandbox, 'plain-report.txt')
  writeFileSync(report, '')
  const profiles = writeProfileFixture(join(sandbox, 'plain-profiles'))
  const authority = join(sandbox, 'plain-authority')
  const driver = `
      import { NodeRuntime } from '@effect/platform-node'
      import { launch } from ${JSON.stringify(new URL('../../src/launcher-runtime.ts', import.meta.url).href)}
      import { makeWorkspaceLifecycle } from ${JSON.stringify(new URL('../../src/workspace-lifecycle.ts', import.meta.url).href)}
      const root = ${JSON.stringify(authority)}
      NodeRuntime.runMain(launch(process.argv.slice(1), {
        workspaceLifecycle: makeWorkspaceLifecycle({ root }),
        coordination: { installationPath: ${JSON.stringify(sandbox)}, namespacePath: root },
      }), { disableErrorReporting: true })
    `
  const outcome = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    resolveRun => {
      execFile(
        process.execPath,
        [
          '--import',
          new URL('./plain-dev-preload.ts', import.meta.url).href,
          '--input-type=module',
          '-e',
          driver,
          '--',
          '--probe-runtime',
          '--cwd',
          repo,
          '--data-home',
          join(sandbox, 'plain-data'),
        ],
        {
          cwd: new URL('../..', import.meta.url).pathname,
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(([name]) => !name.startsWith('OS_'))
            ),
            HOME: home,
            PI_OFFLINE: '1',
            DEV_PROFILES: profiles.root,
            ORB_PLAIN_REPORT: report,
          },
          timeout: 60_000,
        },
        (error, stdout, stderr) =>
          resolveRun({ code: error === null ? 0 : (error.code as number | null), stdout, stderr })
      )
    }
  )
  assert.equal(outcome.code, 0, outcome.stderr)
  assert.match(outcome.stdout, /^runtime probe: ok$/m)
  const recorded = readFileSync(report, 'utf8')
  assert.match(recorded, /^hooks installed$/m, 'the preload observed the launch')
  assert.doesNotMatch(recorded, /^module /m, recorded)
  assert.doesNotMatch(recorded, /^env /m, recorded)
})

await lifecycle.close()

process.stdout.write(
  `orb check: ${passed.length} claims passed\n${passed.map(text => `- ${text}`).join('\n')}\n`
)
