import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { Effect, Stream } from 'effect'
import {
  WorkspaceError,
  type PublicationReference,
  type SweepReceipt,
  type SweepRow,
  type TaskTarget,
  type WorkspaceExecution,
  type WorkspaceGrant,
  type WorkspaceId,
} from '../../src/workspace-domain.ts'
import { WorkspaceAuthority } from '../../src/workspace-authority.ts'
import { attemptedRows, formatSweepReceipt, sweepExitCode } from '../../src/workspace-command.ts'
import { makeGitHubReader, type GitHubReader } from '../../src/workspace-evidence.ts'
import {
  checkTask,
  sweepDeadline,
  sweepRepositoryAtQuit,
  type EvidenceReaders,
} from '../../src/workspace-release.ts'
import type { StartWorkspaceWorker } from '../../src/workspace-lifecycle.ts'
import { newId } from '../../src/workspace-platform.ts'
import { makeNativeWrites } from '../../src/workspace-native-write.ts'
import { classifyWriteDestination } from '../../src/workspace-paths.ts'
import { observeFamily, processTable } from '../../src/process-family.ts'
import { verdictName } from './workspace-completion-fixtures.ts'
import { makeClaims } from './workspace-check-support.ts'
import type { ReleaseFault } from './workspace-release-fault-preload.ts'
import {
  openLifecycle,
  type TestAttachment,
  type TestLifecycle,
} from './workspace-test-lifecycle.ts'

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'dev-workspace-sweep-check-')))
const root = join(sandbox, 'authority')
const FAULT_PRELOAD = new URL('./workspace-release-fault-preload.ts', import.meta.url).href
const GATE_CLOSE_FAULT_PRELOAD = new URL('./workspace-gate-close-fault-preload.ts', import.meta.url)
  .href
const { claim, passed } = makeClaims()

const git = (args: readonly string[], cwd: string): string =>
  execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const localMain: TaskTarget = { kind: 'local', ref: 'refs/heads/main' }

let conversationCount = 0
const conversation = () => {
  conversationCount += 1
  const dataHome = join(sandbox, `data-${conversationCount}`)
  mkdirSync(dataHome, { recursive: true })
  const sessionFile = join(dataHome, 'session.jsonl')
  writeFileSync(sessionFile, '{}\n', { mode: 0o600 })
  return { sessionId: `sweep-${conversationCount}`, sessionFile, dataHome }
}
const ready = (result: Awaited<ReturnType<TestAttachment['authorize']>>): WorkspaceGrant => {
  if (result.kind !== 'ready')
    throw new Error(`expected a ready grant, got ${JSON.stringify(result)}`)
  return result.grant
}
const taskOf = (grant: WorkspaceGrant): WorkspaceId => {
  if (grant.taskId === undefined) throw new Error('a write grant carries a task identity')
  return grant.taskId
}
type WorkspaceRow = Extract<SweepRow, { readonly kind: 'workspace' }>
const rowOf = (receipt: SweepReceipt, workspaceId: WorkspaceId): WorkspaceRow => {
  const row = receipt.rows.find(
    (entry): entry is WorkspaceRow =>
      entry.kind === 'workspace' && entry.workspaceId === workspaceId
  )
  if (row === undefined)
    throw new Error(`no receipt row for ${workspaceId}: ${JSON.stringify(receipt.rows)}`)
  return row
}
const receiptsOf = async (attachment: TestAttachment) => {
  const closing = attachment.close()
  const receipts = await Effect.runPromise(Stream.runCollect(attachment.effect.sweeps))
  await closing
  return receipts
}
const sweepWith = (using: TestLifecycle, anchor: WorkspaceId) =>
  using.sweep({ anchorWorkspaceId: anchor, occupiedPaths: [] })
const publication = (
  taskId: WorkspaceId,
  workspaceId: WorkspaceId,
  relativePath: string,
  bytes: Uint8Array
): PublicationReference => ({
  id: newId(),
  taskId,
  workspaceId,
  relativePath,
  byteLength: bytes.byteLength,
  sha256: sha256(bytes),
  destination: {
    repository: 'owner/repo',
    number: 44,
    readBack: 'text-in-body',
    url: 'https://github.com/owner/repo/issues/44',
  },
  verifiedAt: Date.now(),
})

try {
  const repo = join(sandbox, 'repo')
  mkdirSync(repo)
  git(['init', '--quiet', '-b', 'main'], repo)
  git(['config', 'user.name', 'Sweep Check'], repo)
  git(['config', 'user.email', 'sweep-check@example.invalid'], repo)
  writeFileSync(join(repo, 'tracked.txt'), 'tracked\n')
  writeFileSync(join(repo, '.gitignore'), 'build/\n')
  git(['add', '.'], repo)
  git(['commit', '--quiet', '-m', 'fixture'], repo)
  const lifecycle = await openLifecycle({ root })

  const userCheckout = (name: string): string => {
    const path = join(sandbox, name)
    git(['worktree', 'add', '--quiet', '-b', name, path, 'main'], repo)
    return path
  }
  const reserve = async (cwd: string) => {
    const owner = await lifecycle.attach({ conversation: conversation(), cwd })
    const write = ready(await owner.authorize({ kind: 'write' }))
    return { owner, write, taskId: taskOf(write) }
  }
  const deliverBranch = (checkout: string): string => {
    const name = `delivered-${newId()}`
    git(['switch', '--quiet', '-c', name], checkout)
    writeFileSync(join(checkout, `${name}.txt`), `${name}\n`)
    git(['add', `${name}.txt`], checkout)
    git(['commit', '--quiet', '-m', name], checkout)
    git(['merge', '--quiet', '--ff-only', name], repo)
    return git(['rev-parse', 'HEAD'], checkout)
  }
  const sweepAtQuit = (anchor: WorkspaceId) => sweepWith(lifecycle, anchor)
  const reservedTasks = async (): Promise<readonly (WorkspaceId | undefined)[]> =>
    (await lifecycle.inspect({ cwd: repo })).map(view => view.taskId)

  await claim(
    'quiescent and failed-launch child workspaces are swept while their lead stays open, including gates regrouped by another allocation',
    async () => {
      const owner = await reserve(userCheckout('quiescent-children'))
      const sweeper = await openLifecycle({ root })
      const allocate = async () => {
        const execution: WorkspaceExecution = {
          sessionId: 'quiescent-children',
          taskKey: newId(),
          attemptId: newId(),
          generation: '1',
        }
        const grant = ready(await owner.owner.authorize({ kind: 'delegated-write', execution }))
        return { grant, execution }
      }
      try {
        const children = [await allocate(), await allocate()]
        for (const { grant, execution } of children) {
          await owner.owner.reportExecution(grant, { kind: 'launch-intent', execution })
          const child = spawn('/bin/sh', ['-c', 'read line'], {
            cwd: grant.checkout,
            detached: true,
            stdio: ['pipe', 'ignore', 'ignore'],
          })
          const exited = once(child, 'exit')
          await once(child, 'spawn')
          const identity = (await Effect.runPromise(processTable)).find(
            entry => entry.pid === child.pid
          )
          try {
            assert.ok(identity !== undefined)
            await owner.owner.reportExecution(grant, { kind: 'spawned', process: identity })
            await owner.owner.reportExecution(grant, { kind: 'started' })
          } finally {
            child.stdin.end('finish\n')
            await exited
          }
          const family = await Effect.runPromise(
            observeFamily(
              { pid: child.pid, root: identity, known: [identity], reported: undefined },
              {
                rootExited: true,
                report: processes =>
                  owner.owner.effect.reportExecution(grant, { kind: 'observed', processes }),
              }
            )
          )
          assert.deepEqual(family.known, [])
          await owner.owner.reportExecution(grant, {
            kind: 'quiescent',
            reason: 'The child process family was observed gone',
          })
          await assert.rejects(
            owner.owner.reportExecution(grant, {
              kind: 'quiescent',
              reason: 'A duplicate report must still be refused',
            })
          )
        }
        const views = await sweeper.inspect({ taskId: owner.taskId })
        for (const { grant } of children) {
          const view = views.find(item => item.workspaceId === grant.workspaceId)
          assert.equal(view?.uses.find(use => use.id === grant.useId)?.stage, 'quiescent')
          assert.ok(existsSync(grant.checkout), 'settlement does not remove the worktree')
          assert.ok(view?.taskId === owner.taskId, 'settlement preserves the reservation')
        }
        const receipt = await sweepWith(sweeper, owner.write.workspaceId)
        for (const { grant } of children) {
          const row = rowOf(receipt, grant.workspaceId)
          assert.deepEqual([row.outcome, verdictName(row.verdict)], ['removed', 'no-residue'])
          assert.equal(existsSync(grant.checkout), false)
          assert.ok(!git(['worktree', 'list', '--porcelain'], repo).includes(grant.checkout))
        }
        assert.equal(sweepExitCode(receipt), 0)
        assert.equal(rowOf(receipt, owner.write.workspaceId).outcome, 'retained')
        assert.equal(
          ready(await owner.owner.authorize({ kind: 'write' })).workspaceId,
          owner.write.workspaceId
        )
        const failed = await allocate()
        await owner.owner.reportExecution(failed.grant, {
          kind: 'launch-failed',
          reason: 'The child was not spawned',
        })
        const failedReceipt = await sweepWith(sweeper, owner.write.workspaceId)
        const failedRow = rowOf(failedReceipt, failed.grant.workspaceId)
        assert.deepEqual(
          [failedRow.outcome, verdictName(failedRow.verdict)],
          ['removed', 'no-residue']
        )
        assert.equal(sweepExitCode(failedReceipt), 0)
        assert.equal(existsSync(failed.grant.checkout), false)
        assert.ok(!git(['worktree', 'list', '--porcelain'], repo).includes(failed.grant.checkout))
      } finally {
        await owner.owner.close()
        await sweeper.close()
      }
    }
  )

  await claim(
    'a gate close failing after settlement keeps the settlement, warns its reporter and retries at the next admission',
    async () => {
      const arm = join(sandbox, 'gate-close-fault')
      const faulty = await openLifecycle({
        root,
        startWorker: (url, options) =>
          new Worker(url, {
            ...options,
            execArgv: [...(options.execArgv ?? []), '--import', GATE_CLOSE_FAULT_PRELOAD],
            env: {
              ...process.env,
              DEV_GATE_CLOSE_FAULT_ARM: arm,
              DEV_GATE_CLOSE_FAULT_GATES: join(root, 'gates'),
            },
          }),
      })
      const owner = await faulty.attach({
        conversation: conversation(),
        cwd: userCheckout('deferred-gate-release'),
      })
      const sweeper = await openLifecycle({ root })
      try {
        const anchor = ready(await owner.authorize({ kind: 'write' }))
        const child = ready(
          await owner.authorize({
            kind: 'delegated-write',
            execution: {
              sessionId: 'deferred-gate-release',
              taskKey: newId(),
              attemptId: newId(),
              generation: '1',
            },
          })
        )
        writeFileSync(arm, '')
        const report = await owner.reportExecution(child, {
          kind: 'launch-failed',
          reason: 'The child was not spawned',
        })
        assert.equal(existsSync(arm), false, 'the injected close failure fired')
        assert.match(report.warning ?? '', /gate release deferred.*injected gate close failure/)
        const views = await sweeper.inspect({ taskId: taskOf(child) })
        const use = views
          .find(view => view.workspaceId === child.workspaceId)
          ?.uses.find(item => item.id === child.useId)
        assert.equal(use?.stage, 'quiescent', 'the settlement is durable despite the warning')

        const held = await sweepWith(sweeper, anchor.workspaceId)
        assert.match(rowOf(held, child.workspaceId).reason, /still uses this workspace/)
        assert.ok(existsSync(child.checkout), 'a held gate still protects the worktree')

        assert.equal(
          ready(await owner.authorize({ kind: 'write' })).workspaceId,
          anchor.workspaceId
        )
        const swept = await sweepWith(sweeper, anchor.workspaceId)
        const row = rowOf(swept, child.workspaceId)
        assert.deepEqual([row.outcome, verdictName(row.verdict)], ['removed', 'no-residue'])
        assert.equal(existsSync(child.checkout), false)
        await assert.rejects(
          owner.reportExecution(child, { kind: 'launch-failed', reason: 'duplicate' }),
          (cause: unknown) => cause instanceof WorkspaceError && cause.outcome === 'review-required'
        )
      } finally {
        await owner.close()
        await faulty.close()
        await sweeper.close()
      }
    }
  )

  const finishedOwner = await reserve(repo)
  const finished = ready(await finishedOwner.owner.authorize({ kind: 'delegated-write' }))
  const external = join(sandbox, 'external-config.txt')
  const writes = makeNativeWrites({
    runPromise: Effect.runPromise,
    onError: message => {
      throw new Error(message)
    },
  })
  const scope = { checkout: finished.checkout, authorityRoot: root }
  await Effect.runPromise(
    writes.admit({
      toolCallId: 'external-config',
      scope,
      destination: classifyWriteDestination(scope, finished.cwd, external),
      lifecycle: { kind: 'local', validate: Effect.void },
    })
  )
  await writes.writeOperations.writeFile(external, 'two')
  await Effect.runPromise(writes.settle)
  await finishedOwner.owner.close()
  await lifecycle.recordTarget(finishedOwner.taskId, localMain)
  writeFileSync(join(finished.checkout, 'tracked.txt'), 'dirty intermediate edit\n')

  const liveCheckout = userCheckout('live')
  const liveOwner = await reserve(liveCheckout)
  const liveChild = ready(
    await liveOwner.owner.authorize({
      kind: 'delegated-write',
      execution: {
        sessionId: 'sweep-live',
        taskKey: 'live-child',
        attemptId: newId(),
        generation: '1',
      },
    })
  )

  const unmergedCheckout = userCheckout('unmerged')
  const unmergedOwner = await reserve(unmergedCheckout)
  const unmerged = ready(await unmergedOwner.owner.authorize({ kind: 'delegated-write' }))
  await unmergedOwner.owner.close()
  await lifecycle.recordTarget(unmergedOwner.taskId, localMain)
  git(['switch', '--quiet', '-c', 'unmerged-work'], unmerged.checkout)
  writeFileSync(join(unmerged.checkout, 'feature.txt'), 'feature\n')
  git(['add', 'feature.txt'], unmerged.checkout)
  git(['commit', '--quiet', '-m', 'unmerged'], unmerged.checkout)

  const dirtyCheckout = userCheckout('dirty')
  const dirtyOwner = await reserve(dirtyCheckout)
  await dirtyOwner.owner.close()
  writeFileSync(join(dirtyCheckout, 'tracked.txt'), 'uncommitted user edit\n')
  deliverBranch(finished.checkout)
  writeFileSync(join(finished.checkout, 'notes.txt'), 'forgotten untracked report\n')
  mkdirSync(join(finished.checkout, 'build'))
  writeFileSync(join(finished.checkout, 'build', 'cache.bin'), 'ignored dependency\n')

  await claim(
    'a sweep at quit removes a finished worktree with its dirty, untracked and ignored residue, releases the clean pre-existing reservation, and retains a child whose attempt use is live, a branch worktree with unmerged commits and a dirty pre-existing checkout, each with its reason',
    async () => {
      const receipt = await sweepAtQuit(finishedOwner.write.workspaceId)
      assert.equal(receipt.moment, 'quit')
      const removed = rowOf(receipt, finished.workspaceId)
      assert.deepEqual(
        [removed.outcome, verdictName(removed.verdict)],
        ['removed', 'branch-in-target']
      )
      assert.ok(removed.operationId !== undefined)
      assert.equal(existsSync(finished.checkout), false, 'the worktree and its residue are gone')
      assert.equal(
        readFileSync(external, 'utf8'),
        'two',
        'external native writes never become cleanup-owned'
      )

      const main = rowOf(receipt, finishedOwner.write.workspaceId)
      assert.deepEqual([main.outcome, verdictName(main.verdict)], ['released', 'clean-checkout'])
      assert.equal(readFileSync(join(repo, 'tracked.txt'), 'utf8'), 'tracked\n')

      const live = rowOf(receipt, liveChild.workspaceId)
      assert.deepEqual([live.outcome, verdictName(live.verdict)], ['retained', 'retained:use-live'])
      assert.ok(existsSync(liveChild.checkout))
      assert.deepEqual(
        [
          rowOf(receipt, liveOwner.write.workspaceId).outcome,
          verdictName(rowOf(receipt, liveOwner.write.workspaceId).verdict),
        ],
        ['retained', 'retained:use-live']
      )

      const kept = rowOf(receipt, unmerged.workspaceId)
      assert.deepEqual(
        [kept.outcome, verdictName(kept.verdict)],
        ['retained', 'retained:not-integrated']
      )
      assert.ok(existsSync(join(unmerged.checkout, 'feature.txt')))
      assert.deepEqual(
        [rowOf(receipt, unmergedOwner.write.workspaceId).outcome],
        ['released'],
        'the clean checkout it came from is released'
      )

      const dirty = rowOf(receipt, dirtyOwner.write.workspaceId)
      assert.deepEqual(
        [dirty.outcome, verdictName(dirty.verdict)],
        ['retained', 'retained:checkout-modified']
      )
      assert.equal(
        readFileSync(join(dirtyCheckout, 'tracked.txt'), 'utf8'),
        'uncommitted user edit\n'
      )
      assert.ok(
        (await reservedTasks()).includes(dirtyOwner.taskId),
        'the dirty checkout stays reserved'
      )

      assert.equal(
        sweepExitCode(receipt),
        0,
        'every attempted workspace reached a terminal outcome'
      )
      const receipts = await lifecycle.inspect({
        taskId: finishedOwner.taskId,
      })
      const receiptView = receipts.find(view => view.workspaceId === finished.workspaceId)
      assert.equal(receiptView?.outcome, 'removed')
      assert.ok(receiptView?.reason.startsWith('Automatic at quit'), receiptView?.reason)
    }
  )
  await liveOwner.owner.close()

  await claim(
    'a detached worktree at its base with only Git-ignored files is automatically removed at quit',
    async () => {
      const checkout = userCheckout('ignored-detached')
      const owner = await reserve(checkout)
      const contender = await lifecycle.attach({ conversation: conversation(), cwd: checkout })
      const decision = await contender.authorize({ kind: 'write' })
      assert.equal(decision.kind, 'rebind')
      if (decision.kind !== 'rebind') throw new Error('Contended writer was not isolated')
      const detached = decision.handoff.target
      await contender.handoff(decision.handoff, async () => 'confirmed')
      mkdirSync(join(detached.checkout, 'build'))
      writeFileSync(join(detached.checkout, 'build', 'cache.bin'), 'ignored dependency\n')
      await contender.close()
      await owner.owner.close()
      assert.equal(git(['status', '--porcelain'], detached.checkout), '')
      assert.equal(git(['status', '--porcelain', '--ignored'], detached.checkout), '!! build/')
      const view = (await lifecycle.check(taskOf(detached))).find(
        item => item.workspaceId === detached.workspaceId
      )
      assert.equal(view?.completion.role, 'detached')
      assert.equal(view?.inventory?.files, 1, 'ignored files still undergo inventory checks')
      const removed = rowOf(await sweepAtQuit(detached.workspaceId), detached.workspaceId)
      assert.deepEqual([removed.outcome, verdictName(removed.verdict)], ['removed', 'no-residue'])
      assert.equal(existsSync(detached.checkout), false)
      assert.ok(!git(['worktree', 'list', '--porcelain'], repo).includes(detached.checkout))
    }
  )

  await claim(
    "a recorded target naming the worktree's own branch is ignored: a dirty branch worktree with unmerged commits is retained, not removed as in its target, and check says why",
    async () => {
      const selfOwner = await reserve(userCheckout('self-named-source'))
      const self = ready(await selfOwner.owner.authorize({ kind: 'delegated-write' }))
      await selfOwner.owner.close()
      git(['switch', '--quiet', '-c', 'self-named'], self.checkout)
      writeFileSync(join(self.checkout, 'work.txt'), 'undelivered work\n')
      git(['add', 'work.txt'], self.checkout)
      git(['commit', '--quiet', '-m', 'undelivered'], self.checkout)
      writeFileSync(join(self.checkout, 'tracked.txt'), 'uncommitted edit\n')
      await lifecycle.recordTarget(selfOwner.taskId, {
        kind: 'local',
        ref: 'refs/heads/self-named',
      })
      const view = (await lifecycle.check(selfOwner.taskId)).find(
        item => item.workspaceId === self.workspaceId
      )
      assert.ok(view !== undefined)
      assert.ok(
        view.target.description.includes("names this worktree's own branch"),
        view.target.description
      )
      assert.notEqual(view.target.source, 'override')
      const receipt = await sweepAtQuit(selfOwner.write.workspaceId)
      const row = rowOf(receipt, self.workspaceId)
      assert.deepEqual(
        [row.outcome, verdictName(row.verdict)],
        ['retained', 'retained:integration-unknown']
      )
      git(['update-ref', 'refs/remotes/origin/self-named', 'HEAD'], self.checkout)
      await lifecycle.recordTarget(selfOwner.taskId, {
        kind: 'local',
        ref: 'refs/remotes/origin/self-named',
      })
      const tracking = rowOf(await sweepAtQuit(selfOwner.write.workspaceId), self.workspaceId)
      assert.deepEqual(
        [tracking.outcome, verdictName(tracking.verdict)],
        ['retained', 'retained:integration-unknown'],
        'its remote-tracking ref is its own branch too'
      )
      assert.equal(readFileSync(join(self.checkout, 'tracked.txt'), 'utf8'), 'uncommitted edit\n')
    }
  )

  await claim(
    'the target is derived only when an integration proof is needed: an in-use worktree and a clean one at its base ask the provider nothing, while undelivered residue asks for the origin default branch',
    async () => {
      const lazyRepo = join(sandbox, 'lazy-repo')
      mkdirSync(lazyRepo)
      git(['init', '--quiet', '-b', 'main'], lazyRepo)
      git(['config', 'user.name', 'Sweep Check'], lazyRepo)
      git(['config', 'user.email', 'sweep-check@example.invalid'], lazyRepo)
      writeFileSync(join(lazyRepo, 'tracked.txt'), 'tracked\n')
      git(['add', '.'], lazyRepo)
      git(['commit', '--quiet', '-m', 'fixture'], lazyRepo)
      git(['remote', 'add', 'origin', 'git@github.com:owner/lazy.git'], lazyRepo)
      const owner = await lifecycle.attach({ conversation: conversation(), cwd: lazyRepo })
      const write = ready(await owner.authorize({ kind: 'write' }))
      const lazy = ready(await owner.authorize({ kind: 'delegated-write' }))
      const calls: string[] = []
      const offline = (call: string) => {
        calls.push(call)
        return { unavailable: 'offline' }
      }
      const counting: GitHubReader = {
        defaultBranch: repository => {
          calls.push(`defaultBranch ${repository}`)
          return 'main'
        },
        refTip: () => offline('refTip'),
        pullRequest: () => offline('pullRequest'),
        pullRequestCommits: () => offline('pullRequestCommits'),
        mergedPullRequestsForCommit: () => offline('mergedPullRequestsForCommit'),
        compare: () => offline('compare'),
      }
      const authority = new WorkspaceAuthority(root)
      const targetOf = () =>
        checkTask(authority, taskOf(write), { github: counting }).find(
          item => item.workspaceId === lazy.workspaceId
        )?.target.source
      try {
        assert.equal(targetOf(), 'not-assessed', 'a worktree in use is not assessed')
        await owner.close()
        assert.equal(targetOf(), 'not-needed', 'a clean worktree at its base needs no target')
        assert.equal(
          calls.length,
          0,
          `neither state asked the provider anything: ${calls.join(', ')}`
        )
        writeFileSync(join(lazy.checkout, 'tracked.txt'), 'undelivered edit\n')
        assert.equal(targetOf(), 'origin-github')
        assert.ok(calls.includes('defaultBranch owner/lazy'), JSON.stringify(calls))
      } finally {
        authority.close()
      }
    }
  )

  await claim(
    'a child with a GitHub target retains integration-unknown when a sibling directory cannot be read, rather than treating an incomplete PR search as not-integrated',
    async () => {
      const owner = await reserve(userCheckout('unknown-sibling'))
      const child = ready(await owner.owner.authorize({ kind: 'delegated-write' }))
      writeFileSync(join(child.checkout, 'pending.txt'), 'unfinished child\n')
      const sibling = ready(await owner.owner.authorize({ kind: 'delegated-write' }))
      await owner.owner.close()
      await lifecycle.recordTarget(owner.taskId, {
        kind: 'github',
        repository: 'owner/project',
        ref: 'refs/heads/main',
      })
      const tip = git(['rev-parse', 'main'], repo)
      const reader: GitHubReader = {
        defaultBranch: () => 'main',
        refTip: () => tip,
        pullRequest: () => 'missing',
        pullRequestCommits: () => [],
        mergedPullRequestsForCommit: () => [],
        compare: () => ({ unavailable: 'unexpected comparison of local history' }),
      }
      const authority = new WorkspaceAuthority(root)
      const assessment = () => {
        const view = checkTask(authority, owner.taskId, { github: reader }).find(
          item => item.workspaceId === child.workspaceId
        )
        assert.ok(view !== undefined)
        return view
      }
      try {
        const before = assessment().completion
        assert.ok(before.kind === 'retained')
        assert.equal(before.retained, 'not-integrated')
        rmSync(sibling.checkout, { recursive: true, force: true })
        const view = assessment()
        assert.equal(view.outcome, 'review-required')
        assert.ok(view.completion.kind === 'retained')
        assert.equal(view.completion.retained, 'integration-unknown')
        assert.ok(view.completion.reason.includes(sibling.workspaceId), view.completion.reason)
        assert.ok(existsSync(child.checkout), 'the uncertain child stays on disk')
      } finally {
        authority.close()
      }
    }
  )

  await claim(
    "quit prefetch starts every task's recorded pull request read while the first task still awaits its evidence, and gated release retains a workspace changed while the provider is pending",
    async () => {
      const asyncRepo = join(sandbox, 'async-overlap-repo')
      mkdirSync(asyncRepo)
      git(['init', '--quiet', '-b', 'main'], asyncRepo)
      git(['config', 'user.name', 'Sweep Check'], asyncRepo)
      git(['config', 'user.email', 'sweep-check@example.invalid'], asyncRepo)
      writeFileSync(join(asyncRepo, 'tracked.txt'), 'base\n')
      git(['add', '.'], asyncRepo)
      git(['commit', '--quiet', '-m', 'base'], asyncRepo)
      const owner = await reserve(asyncRepo)
      const child = ready(await owner.owner.authorize({ kind: 'delegated-write' }))
      const deliveryBranch = `async-delivery-${newId()}`
      git(['switch', '--quiet', '-c', deliveryBranch], child.checkout)
      writeFileSync(join(child.checkout, 'feature.txt'), 'delivered\n')
      git(['add', 'feature.txt'], child.checkout)
      git(['commit', '--quiet', '-m', 'delivered'], child.checkout)
      const head = git(['rev-parse', 'HEAD'], child.checkout)
      await owner.owner.close()
      git(['merge', '--quiet', '--ff-only', deliveryBranch], asyncRepo)
      await lifecycle.recordTarget(owner.taskId, {
        kind: 'github',
        repository: 'owner/async-overlap',
        ref: 'refs/heads/main',
        pullRequest: 7,
      })
      const otherCheckout = join(sandbox, 'async-overlap-other')
      git(['worktree', 'add', '--quiet', '-b', 'async-other', otherCheckout, 'main'], asyncRepo)
      const other = await reserve(otherCheckout)
      await other.owner.close()
      await lifecycle.recordTarget(other.taskId, {
        kind: 'github',
        repository: 'owner/async-overlap',
        ref: 'refs/heads/main',
        pullRequest: 8,
      })

      const started: number[] = []
      let graphqlCalls = 0
      let synchronousGraphqlCalls = 0
      let resolveResponse:
        | ((response: { readonly status: 'ok'; readonly text: string }) => void)
        | undefined
      const response = new Promise<{ readonly status: 'ok'; readonly text: string }>(resolve => {
        resolveResponse = resolve
      })
      const readers: EvidenceReaders = {
        github: makeGitHubReader(
          () => {
            throw new Error('the batched GraphQL evidence should satisfy this assessment')
          },
          30_000,
          undefined,
          () => {
            synchronousGraphqlCalls += 1
            throw new Error('the async evidence must populate the shared reader cache')
          },
          async (repository, ref, number, timeoutMs) => {
            assert.deepEqual([repository, ref], ['owner/async-overlap', 'refs/heads/main'])
            assert.ok(timeoutMs > 0 && timeoutMs <= 30_000, `invalid timeout ${timeoutMs}`)
            started.push(number)
            if (number !== 7) return { status: 'not-found', text: '' }
            graphqlCalls += 1
            return response
          }
        ),
      }
      const requestedAt = Date.now()
      const deadline = sweepDeadline('quit', requestedAt)
      const authority = new WorkspaceAuthority(root)
      try {
        const pendingSweep = sweepRepositoryAtQuit(
          authority,
          {
            repositoryId: owner.write.repositoryId,
            moment: 'quit',
            deadline,
            occupiedPaths: [],
          },
          readers
        )
        assert.deepEqual(
          started.toSorted(),
          [7, 8],
          'every task with a recorded pull request starts its read while the first task still awaits its evidence'
        )
        if (resolveResponse === undefined) throw new Error('async GraphQL request did not start')
        const sweepAssessedEveryTaskUpToThePendingRead = new Promise(resolve => {
          setImmediate(resolve)
        })
        await sweepAssessedEveryTaskUpToThePendingRead
        writeFileSync(join(child.checkout, 'tracked.txt'), 'changed during provider wait\n')
        resolveResponse({
          status: 'ok',
          text: JSON.stringify({
            data: {
              repository: {
                ref: { target: { oid: head } },
                pullRequest: {
                  mergedAt: new Date(Date.now() + 60_000).toISOString(),
                  baseRefName: 'main',
                  baseRepository: { nameWithOwner: 'owner/async-overlap' },
                  headRefOid: head,
                  headRepository: { nameWithOwner: 'owner/async-overlap' },
                  mergeCommit: { oid: head },
                  commits: {
                    totalCount: 1,
                    nodes: [{ commit: { oid: head } }],
                    pageInfo: { hasNextPage: false },
                  },
                },
              },
            },
          }),
        })
        const receipt = await pendingSweep
        const row = rowOf(receipt, child.workspaceId)
        assert.equal(verdictName(row.verdict), 'branch-merged', row.reason)
        assert.equal(row.outcome, 'retained', row.reason)
        assert.match(row.reason, /changed after the sweep assessed it/i)
        assert.equal(
          readFileSync(join(child.checkout, 'tracked.txt'), 'utf8'),
          'changed during provider wait\n'
        )
        assert.ok(existsSync(child.checkout), 'fresh gated assessment prevents removal')
        assert.equal(graphqlCalls, 1, 'gated re-assessment reuses the request-scoped evidence')
        assert.equal(synchronousGraphqlCalls, 0)
      } finally {
        authority.close()
      }
    }
  )

  await claim(
    'an explicit release through the authority refuses an automatic decider; only the sweep attempts automatically',
    async () => {
      const [assessment] = await lifecycle.check(dirtyOwner.taskId)
      assert.ok(assessment !== undefined)
      await assert.rejects(
        lifecycle.release({
          taskId: dirtyOwner.taskId,
          commandId: newId(),
          decided: [assessment.subject],
          decider: { kind: 'completion', policyVersion: 2, moment: 'quit' },
          workspaceId: assessment.workspaceId,
          occupiedPaths: [],
        }),
        (cause: unknown) => cause instanceof WorkspaceError && cause.outcome === 'invalid'
      )
      assert.equal(
        readFileSync(join(dirtyCheckout, 'tracked.txt'), 'utf8'),
        'uncommitted user edit\n'
      )
    }
  )

  await claim(
    'a finished worktree bound to another open dev conversation is retained as a live use naming that conversation, the bound conversation sees it as its own, and once that conversation closes the next sweep removes it',
    async () => {
      const boundCheckout = userCheckout('bound')
      const boundOwner = await reserve(boundCheckout)
      const bound = ready(await boundOwner.owner.authorize({ kind: 'delegated-write' }))
      await boundOwner.owner.close()
      const reader = conversation()
      const attached = await lifecycle.attach({
        conversation: reader,
        cwd: repo,
        selection: {
          taskId: boundOwner.taskId,
          workspaceId: bound.workspaceId,
        },
      })
      const held = await sweepAtQuit(boundOwner.write.workspaceId)
      const kept = rowOf(held, bound.workspaceId)
      assert.deepEqual([kept.outcome, verdictName(kept.verdict)], ['retained', 'retained:use-live'])
      assert.ok(kept.reason.includes('open dev conversation'), kept.reason)
      assert.ok(existsSync(bound.checkout))
      const view = (await lifecycle.check(boundOwner.taskId)).find(
        item => item.workspaceId === bound.workspaceId
      )
      assert.ok(
        view?.reasons.some(reason => reason.includes(reader.sessionId)),
        'the check names the open conversation'
      )

      const own = await Effect.runPromise(
        lifecycle.effect.check({
          taskId: boundOwner.taskId,
          ownConversation: reader,
        })
      )
      const ownView = own.find(item => item.workspaceId === bound.workspaceId)
      assert.ok(ownView?.completion.kind === 'finished', JSON.stringify(ownView?.completion))
      assert.equal(ownView.completion.rule, 'no-residue')
      assert.ok(
        ownView.reasons.some(reason => reason.startsWith('This conversation is bound here')),
        JSON.stringify(ownView.reasons)
      )

      await attached.close()
      const swept = await sweepAtQuit(boundOwner.write.workspaceId)
      const removed = rowOf(swept, bound.workspaceId)
      assert.deepEqual([removed.outcome, verdictName(removed.verdict)], ['removed', 'no-residue'])
      assert.equal(existsSync(bound.checkout), false)
    }
  )

  await claim(
    "before a managed allocation the sweep skips clean pre-existing checkouts and the caller's own workspace, removes another finished worktree, and delivers one receipt to the allocating attachment",
    async () => {
      const exclusionCheckout = userCheckout('exclusion')
      const exclusionOwner = await reserve(exclusionCheckout)
      const own = ready(await exclusionOwner.owner.authorize({ kind: 'delegated-write' }))
      await exclusionOwner.owner.close()
      writeFileSync(
        join(own.checkout, 'tracked.txt'),
        'kept unfinished until the caller binds it\n'
      )
      const otherCheckout = userCheckout('other')
      const otherOwner = await reserve(otherCheckout)
      const other = ready(await otherOwner.owner.authorize({ kind: 'delegated-write' }))
      await otherOwner.owner.close()

      const caller = await lifecycle.attach({
        conversation: conversation(),
        cwd: repo,
        selection: {
          taskId: exclusionOwner.taskId,
          workspaceId: own.workspaceId,
        },
      })
      const allocated = ready(await caller.authorize({ kind: 'delegated-write' }))
      const closing = caller.close()
      const receipts = await Effect.runPromise(Stream.runCollect(caller.effect.sweeps))
      await closing
      assert.equal(receipts.length, 1, 'one receipt reached the allocating attachment')
      const [receipt] = receipts
      assert.ok(receipt !== undefined)
      assert.equal(receipt.moment, 'allocation')
      const skipped = rowOf(receipt, own.workspaceId)
      assert.deepEqual(
        [skipped.outcome, verdictName(skipped.verdict)],
        ['skipped', 'retained:excluded']
      )
      assert.ok(existsSync(own.checkout))
      const clean = rowOf(receipt, exclusionOwner.write.workspaceId)
      assert.deepEqual([clean.outcome, verdictName(clean.verdict)], ['skipped', 'retained:skipped'])
      assert.ok((await reservedTasks()).includes(exclusionOwner.taskId))
      const removed = rowOf(receipt, other.workspaceId)
      assert.deepEqual([removed.outcome, verdictName(removed.verdict)], ['removed', 'no-residue'])
      assert.equal(existsSync(other.checkout), false)
      const attempted = attemptedRows(receipt).map(row => row.workspaceId)
      assert.ok(attempted.includes(other.workspaceId), JSON.stringify(receipt.rows))
      assert.ok(
        !attempted.includes(own.workspaceId) &&
          !attempted.includes(exclusionOwner.write.workspaceId),
        "neither the caller's workspace nor a clean pre-existing checkout was attempted"
      )
      assert.ok(existsSync(allocated.checkout), 'the allocation itself succeeded')
      git(['checkout', '--quiet', '--', 'tracked.txt'], own.checkout)

      const quit = await sweepAtQuit(own.workspaceId)
      assert.deepEqual(
        [own.workspaceId, allocated.workspaceId, exclusionOwner.write.workspaceId].map(
          workspaceId => rowOf(quit, workspaceId).outcome
        ),
        ['removed', 'removed', 'released'],
        'once the caller has quit, its workspaces are finished and swept'
      )
    }
  )

  const faultyWorker =
    (fault: ReleaseFault, checkout: string): StartWorkspaceWorker =>
    (url, options) =>
      new Worker(url, {
        ...options,
        execArgv: [...(options.execArgv ?? []), '--import', FAULT_PRELOAD],
        env: {
          ...process.env,
          DEV_RELEASE_FAULT: fault,
          DEV_RELEASE_FAULT_CHECKOUT: checkout,
        },
      })
  const finishedWithReports = async (name: string, reports: readonly string[]) => {
    const checkout = userCheckout(name)
    const owner = await reserve(checkout)
    const managed = ready(await owner.owner.authorize({ kind: 'delegated-write' }))
    await owner.owner.close()
    await lifecycle.recordTarget(owner.taskId, localMain)
    deliverBranch(managed.checkout)
    for (const report of reports) {
      writeFileSync(join(managed.checkout, report), `${report}\n`)
      await lifecycle.recordPublication(
        publication(
          owner.taskId,
          managed.workspaceId,
          report,
          readFileSync(join(managed.checkout, report))
        )
      )
    }
    return { owner, managed }
  }
  const crashSweep = async (fault: ReleaseFault, checkout: string, anchor: WorkspaceId) => {
    const faulty = await openLifecycle({
      root,
      startWorker: faultyWorker(fault, checkout),
    })
    await assert.rejects(
      sweepWith(faulty, anchor),
      (cause: unknown) => cause instanceof WorkspaceError && cause.outcome === 'unavailable'
    )
    await faulty.close()
  }

  await claim(
    'a sweep interrupted after its release intent, or between two selected-file deletions, is observed and closed by the next sweep, which attempts the worktree afresh and removes it',
    async () => {
      const intent = await finishedWithReports('intent', ['report.txt'])
      await crashSweep(
        'after-release-intent',
        intent.managed.checkout,
        intent.owner.write.workspaceId
      )
      const view = (await lifecycle.inspect({ taskId: intent.owner.taskId })).find(
        item => item.workspaceId === intent.managed.workspaceId
      )
      assert.deepEqual(
        view?.pending.map(item => [item.kind, item.stage]),
        [['release', 'intent']]
      )
      const afterIntent = await sweepAtQuit(intent.owner.write.workspaceId)
      assert.equal(rowOf(afterIntent, intent.managed.workspaceId).outcome, 'removed')
      assert.equal(existsSync(intent.managed.checkout), false)

      const during = await finishedWithReports('during', ['first.txt', 'second.txt'])
      await crashSweep(
        'during-selected-files',
        during.managed.checkout,
        during.owner.write.workspaceId
      )
      assert.deepEqual(
        ['first.txt', 'second.txt'].map(name => existsSync(join(during.managed.checkout, name))),
        [false, true],
        'the crash came after the first deletion'
      )
      const afterDeletion = await sweepAtQuit(during.owner.write.workspaceId)
      const row = rowOf(afterDeletion, during.managed.workspaceId)
      assert.equal(row.outcome, 'removed', row.reason)
      assert.ok(
        row.reason.includes('observed absent') && row.reason.includes('first.txt'),
        row.reason
      )
      assert.equal(existsSync(during.managed.checkout), false)
      const history = (await lifecycle.inspect({ taskId: during.owner.taskId })).find(
        item => item.workspaceId === during.managed.workspaceId
      )
      assert.deepEqual(history?.pending ?? [], [], 'the interrupted release is closed')
    }
  )

  await claim(
    'a worktree directory deleted outside dev is retained as directory-missing, while a crash right after the removal by dev is observed by the next sweep as already-absent, and a rerun finds nothing more to attempt',
    async () => {
      const goneCheckout = userCheckout('gone')
      const goneOwner = await reserve(goneCheckout)
      const gone = ready(await goneOwner.owner.authorize({ kind: 'delegated-write' }))
      await goneOwner.owner.close()
      rmSync(gone.checkout, { recursive: true, force: true })
      const kept = await sweepAtQuit(goneOwner.write.workspaceId)
      const missing = rowOf(kept, gone.workspaceId)
      assert.deepEqual(
        [missing.outcome, verdictName(missing.verdict)],
        ['retained', 'retained:directory-missing']
      )
      const crashed = await finishedWithReports('crashed', [])
      await crashSweep(
        'after-git-remove',
        crashed.managed.checkout,
        crashed.owner.write.workspaceId
      )
      assert.equal(existsSync(crashed.managed.checkout), false, 'dev removed it before crashing')
      const observed = await sweepAtQuit(crashed.owner.write.workspaceId)
      const row = rowOf(observed, crashed.managed.workspaceId)
      assert.deepEqual(
        [row.outcome, verdictName(row.verdict)],
        ['already-absent', 'no-residue'],
        row.reason
      )
      const rerun = await sweepAtQuit(crashed.owner.write.workspaceId)
      assert.ok(
        !rerun.rows.some(
          entry =>
            entry.kind === 'workspace' &&
            [crashed.managed.workspaceId, crashed.owner.write.workspaceId].includes(
              entry.workspaceId
            )
        ),
        JSON.stringify(rerun.rows)
      )
      assert.deepEqual(attemptedRows(rerun), [], 'nothing finished was left to attempt')
    }
  )

  await claim(
    'a crash after a removal Git left half done, the directory deleted and its admin directory kept, is still settled by the next sweep as the absence dev caused, not retained as a missing directory',
    async () => {
      const half = await finishedWithReports('half-removed', [])
      const admins = join(repo, '.git', 'worktrees')
      const { mode } = statSync(admins)
      chmodSync(admins, 0o500)
      try {
        await crashSweep('after-git-remove', half.managed.checkout, half.owner.write.workspaceId)
      } finally {
        chmodSync(admins, mode)
      }
      assert.equal(existsSync(half.managed.checkout), false, 'Git deleted the directory')
      const view = (await lifecycle.inspect({ taskId: half.owner.taskId })).find(
        item => item.workspaceId === half.managed.workspaceId
      )
      assert.deepEqual(
        view?.pending.map(item => [item.kind, item.stage]),
        [['release', 'started']],
        'the removal is left started, not recorded for review'
      )
      const settled = await sweepAtQuit(half.owner.write.workspaceId)
      const row = rowOf(settled, half.managed.workspaceId)
      assert.deepEqual(
        [row.outcome, verdictName(row.verdict)],
        ['already-absent', 'no-residue'],
        row.reason
      )
    }
  )

  await claim(
    'a sweep that uses its time budget stops before the next task: it defers every remaining task with a receipt row and touches none of it, and the next sweep attempts the deferred task',
    async () => {
      const allocate = async (name: string) => {
        const owner = await reserve(userCheckout(name))
        writeFileSync(join(owner.write.checkout, 'pending.txt'), 'keep the pre-existing checkout\n')
        const managed = ready(await owner.owner.authorize({ kind: 'delegated-write' }))
        await owner.owner.close()
        await lifecycle.recordTarget(owner.taskId, localMain)
        return { owner, managed }
      }
      const first = await allocate('budget-a')
      const pending = join(first.managed.checkout, 'pending.txt')
      writeFileSync(pending, 'unfinished until the second worktree exists\n')
      const second = await allocate('budget-b')
      rmSync(pending)
      deliverBranch(first.managed.checkout)
      git(['merge', '--quiet', '--ff-only', 'main'], second.managed.checkout)
      deliverBranch(second.managed.checkout)
      const late = await openLifecycle({
        root,
        startWorker: faultyWorker('clock-after-git-remove', first.managed.checkout),
      })
      let receipt: SweepReceipt
      try {
        receipt = await sweepWith(late, first.owner.write.workspaceId)
      } finally {
        await late.close()
      }
      const pairs = [first, second]
      const removed = pairs.filter(pair =>
        receipt.rows.some(
          row =>
            row.kind === 'workspace' &&
            row.workspaceId === pair.managed.workspaceId &&
            row.outcome === 'removed'
        )
      )
      assert.equal(removed.length, 1, JSON.stringify(receipt.rows))
      const [kept] = pairs.filter(pair => !removed.includes(pair))
      assert.ok(kept !== undefined)
      const deferred = receipt.rows.filter(row => row.kind === 'task-deferred')
      assert.ok(
        deferred.some(row => row.taskId === kept.owner.taskId),
        JSON.stringify(receipt.rows)
      )
      assert.ok(!deferred.some(row => row.taskId === removed[0]?.owner.taskId))
      assert.ok(
        !receipt.rows.some(row => row.kind === 'workspace' && row.taskId === kept.owner.taskId),
        'nothing of a deferred task is assessed'
      )
      assert.ok(existsSync(kept.managed.checkout))
      assert.ok(formatSweepReceipt(receipt).includes('deferred to the next sweep'))
      assert.equal(sweepExitCode(receipt), 0, 'a deferred task is not a failed attempt')

      const next = await sweepAtQuit(kept.owner.write.workspaceId)
      const cleanDelivered = rowOf(next, kept.managed.workspaceId)
      assert.deepEqual(
        [cleanDelivered.outcome, verdictName(cleanDelivered.verdict)],
        ['removed', 'branch-in-target'],
        'a clean branch whose commits reached the target is removed as delivered'
      )
      assert.equal(existsSync(kept.managed.checkout), false)
    }
  )

  await claim(
    'a sweep budget runs from when the host sent the request: of two allocations sent together, the one queued behind a sweep that used the budget defers every task instead of sweeping again, and both allocations succeed',
    async () => {
      const finishedOne = await finishedWithReports('queued-finished', [])
      const late = await openLifecycle({
        root,
        startWorker: faultyWorker('clock-after-git-remove', finishedOne.managed.checkout),
      })
      try {
        const writer = async (name: string) => {
          const attachment = await late.attach({
            conversation: conversation(),
            cwd: userCheckout(name),
          })
          ready(await attachment.authorize({ kind: 'write' }))
          return attachment
        }
        const first = await writer('queued-a')
        const second = await writer('queued-b')
        const allocated = await Promise.all([
          first.authorize({ kind: 'delegated-write' }),
          second.authorize({ kind: 'delegated-write' }),
        ])
        for (const result of allocated) ready(result)
        const receipts = [...(await receiptsOf(first)), ...(await receiptsOf(second))]
        assert.equal(receipts.length, 2, JSON.stringify(receipts))
        const sweeping = receipts.filter(receipt =>
          receipt.rows.some(row => row.kind === 'workspace' && row.outcome === 'removed')
        )
        const deferred = receipts.filter(
          receipt =>
            receipt.rows.length > 0 && receipt.rows.every(row => row.kind === 'task-deferred')
        )
        assert.equal(sweeping.length, 1, JSON.stringify(receipts))
        assert.equal(deferred.length, 1, JSON.stringify(receipts))
        assert.equal(existsSync(finishedOne.managed.checkout), false)
      } finally {
        await late.close()
      }
    }
  )

  await claim(
    'a removal the engine records as needing review makes the sweep exit 1, is then skipped and reported by later sweeps, and only an explicit release observes and settles it',
    async () => {
      const checkout = userCheckout('partial')
      const owner = await reserve(checkout)
      const managed = ready(await owner.owner.authorize({ kind: 'delegated-write' }))
      await owner.owner.close()
      const admins = join(repo, '.git', 'worktrees')
      const { mode } = statSync(admins)
      chmodSync(admins, 0o500)
      let partial: SweepReceipt
      try {
        partial = await sweepAtQuit(owner.write.workspaceId)
      } finally {
        chmodSync(admins, mode)
      }
      const stopped = rowOf(partial, managed.workspaceId)
      assert.equal(stopped.outcome, 'partial', stopped.reason)
      assert.equal(sweepExitCode(partial), 1)

      const later = await sweepAtQuit(owner.write.workspaceId)
      const skipped = rowOf(later, managed.workspaceId)
      assert.deepEqual(
        [skipped.outcome, verdictName(skipped.verdict), skipped.operationId],
        ['review-required', 'retained:release-review', undefined]
      )
      assert.equal(sweepExitCode(later), 0, 'a retained workspace is not an attempt')

      const assessments = await lifecycle.check(owner.taskId)
      const settled = await lifecycle.release({
        taskId: owner.taskId,
        commandId: newId(),
        decided: assessments.map(item => item.subject),
        decider: { kind: 'user' },
        workspaceId: managed.workspaceId,
        occupiedPaths: [],
      })
      assert.equal(settled.outcome, 'already-absent', settled.reason)
      git(['worktree', 'prune'], repo)
    }
  )

  await lifecycle.close()
  process.stdout.write(
    `${JSON.stringify(
      {
        result: 'passed',
        checks: passed,
        authorityRoot: root,
        limits: [
          'Integration is proven against a local target; pull request discovery for children is covered by the fake-reader claims of the release check.',
          'Worker crashes are process-local thread exits, not power loss.',
        ],
      },
      null,
      2
    )}\n`
  )
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}
