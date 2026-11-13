import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import * as Effect from 'effect/Effect'
import * as Stream from 'effect/Stream'
import {
  WorkspaceError,
  type SweepReceipt,
  type WorkspaceExecution,
  type WorkspaceId,
} from '../../src/workspace-domain.ts'
import { WorkspaceAuthority } from '../../src/workspace-authority.ts'
import { formatSweepReceipt, sweepExitCode } from '../../src/workspace-command.ts'
import { makeGitHubReader, type GitHubReader } from '../../src/workspace-evidence.ts'
import {
  checkTask,
  sweepDeadline,
  sweepRepositoryAtClose,
  type EvidenceReaders,
} from '../../src/workspace-release.ts'
import { newId } from '../../src/workspace-platform.ts'
import { makeNativeWrites } from '../../src/workspace-native-write.ts'
import { classifyWriteDestination } from '../../src/workspace-paths.ts'
import { observeFamily, processTable } from '../../src/process-family.ts'
import { verdictName } from './workspace-completion-fixtures.ts'
import { makeClaims } from './workspace-check-support.ts'
import {
  git,
  localMain,
  openSweepFixture,
  ready,
  rowOf,
  sweepSandbox,
  sweepWith,
  taskOf,
} from './workspace-sweep-fixture.ts'
import { openLifecycle } from './workspace-test-lifecycle.ts'

const sandbox = sweepSandbox('workspace-sweep-check')
const GATE_CLOSE_FAULT_PRELOAD = new URL('./workspace-gate-close-fault-preload.ts', import.meta.url)
  .href
const { claim, passed } = makeClaims()

try {
  const { root, repo, lifecycle, conversation, userCheckout, reserve, deliverBranch, sweepAtQuit } =
    await openSweepFixture(sandbox)
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
          await owner.owner.reportExecution(grant, {
            kind: 'launch-intent',
            execution,
          })
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
            await owner.owner.reportExecution(grant, {
              kind: 'spawned',
              process: identity,
            })
            await owner.owner.reportExecution(grant, { kind: 'started' })
          } finally {
            child.stdin.end('finish\n')
            await exited
          }
          const family = await Effect.runPromise(
            observeFamily(
              {
                pid: child.pid,
                root: identity,
                known: [identity],
                reported: undefined,
              },
              {
                rootExited: true,
                report: processes =>
                  owner.owner.effect.reportExecution(grant, {
                    kind: 'observed',
                    processes,
                  }),
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
          assert.equal(
            existsSync(dirname(grant.checkout)),
            false,
            'the emptied repository directory is gone'
          )
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
          owner.reportExecution(child, {
            kind: 'launch-failed',
            reason: 'duplicate',
          }),
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

  const advancedCheckout = userCheckout('advanced')
  const advancedOwner = await reserve(advancedCheckout)
  const advanced = ready(await advancedOwner.owner.authorize({ kind: 'delegated-write' }))
  await advancedOwner.owner.close()
  await lifecycle.recordTarget(advancedOwner.taskId, localMain)
  writeFileSync(join(advanced.checkout, 'tracked.txt'), 'uncommitted child edit\n')

  const dirtyCheckout = userCheckout('dirty')
  const dirtyOwner = await reserve(dirtyCheckout)
  await dirtyOwner.owner.close()
  writeFileSync(join(dirtyCheckout, 'tracked.txt'), 'uncommitted user edit\n')
  deliverBranch(finished.checkout)
  git(['checkout', '--quiet', '--', 'tracked.txt'], finished.checkout)
  git(['switch', '--quiet', '-c', 'started-from-target', 'main'], advanced.checkout)
  writeFileSync(join(advanced.checkout, 'native.c'), 'uncommitted new source\n')
  mkdirSync(join(finished.checkout, 'build'))
  writeFileSync(join(finished.checkout, 'build', 'cache.bin'), 'ignored dependency\n')

  await claim(
    'a sweep at quit removes a delivered worktree with its ignored residue, releases the clean pre-existing reservation, and retains a child whose attempt use is live, a branch worktree with unmerged commits, a branch started from a later target commit with uncommitted edits and a dirty pre-existing checkout, each with its reason',
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

      const edited = rowOf(receipt, advanced.workspaceId)
      assert.equal(edited.outcome, 'retained', edited.reason)
      assert.equal(
        readFileSync(join(advanced.checkout, 'tracked.txt'), 'utf8'),
        'uncommitted child edit\n'
      )
      assert.ok(existsSync(join(advanced.checkout, 'native.c')))
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
      assert.ok(receiptView?.reason.startsWith('By the sweep at quit'), receiptView?.reason)
    }
  )
  await liveOwner.owner.close()

  await claim(
    'quit sweeps the repositories of the checkouts the conversation delegated into, including one whose delegation was refused: a delivered foreign worktree is removed and an undelivered one is retained with its reason, while the anchor repository alone never lists them',
    async () => {
      const foreignRepo = join(sandbox, 'foreign-repo')
      mkdirSync(foreignRepo)
      git(['init', '--quiet', '-b', 'main'], foreignRepo)
      git(['config', 'user.name', 'Sweep Check'], foreignRepo)
      git(['config', 'user.email', 'sweep-check@example.invalid'], foreignRepo)
      writeFileSync(join(foreignRepo, 'tracked.txt'), 'foreign\n')
      git(['add', '.'], foreignRepo)
      git(['commit', '--quiet', '-m', 'foreign fixture'], foreignRepo)
      const owner = await reserve(userCheckout('foreign-delegator'))
      const delivered = ready(
        await owner.owner.authorize({
          kind: 'delegated-write',
          cwd: foreignRepo,
        })
      )
      const undelivered = ready(
        await owner.owner.authorize({
          kind: 'delegated-write',
          cwd: foreignRepo,
        })
      )
      assert.notEqual(delivered.repositoryId, owner.write.repositoryId)
      assert.equal(undelivered.taskId, delivered.taskId)
      const unborn = join(sandbox, 'unborn-repo')
      mkdirSync(unborn)
      git(['init', '--quiet', '-b', 'main'], unborn)
      await assert.rejects(owner.owner.authorize({ kind: 'delegated-write', cwd: unborn }), {
        message: `Checkout ${unborn} has no commits yet, so no worktree can start from it. Make a first commit there, then retry.`,
      })
      assert.deepEqual(
        owner.owner.effect.delegatedCwds,
        [foreignRepo, unborn],
        'every delegation directory is retained for quit, refused ones included'
      )
      const foreignTask = taskOf(delivered)
      await owner.owner.close()
      await lifecycle.recordTarget(foreignTask, localMain)
      const branch = `foreign-delivery-${newId()}`
      git(['switch', '--quiet', '-c', branch], delivered.checkout)
      writeFileSync(join(delivered.checkout, 'delivered.txt'), 'delivered\n')
      git(['add', 'delivered.txt'], delivered.checkout)
      git(['commit', '--quiet', '-m', 'delivered'], delivered.checkout)
      git(['merge', '--quiet', '--ff-only', branch], foreignRepo)
      git(['switch', '--quiet', '-c', 'foreign-unmerged'], undelivered.checkout)
      writeFileSync(join(undelivered.checkout, 'pending.txt'), 'pending\n')
      git(['add', 'pending.txt'], undelivered.checkout)
      git(['commit', '--quiet', '-m', 'pending'], undelivered.checkout)

      const anchorOnly = await sweepAtQuit(owner.write.workspaceId)
      assert.ok(
        !anchorOnly.rows.some(row => row.kind === 'workspace' && row.taskId === foreignTask),
        JSON.stringify(anchorOnly.rows)
      )
      assert.ok(existsSync(delivered.checkout))

      const receipt = await sweepWith(lifecycle, owner.write.workspaceId, [
        ...owner.owner.effect.delegatedCwds,
        join(sandbox, 'never-a-checkout'),
      ])
      assert.deepEqual(
        receipt.rows.filter(row => row.kind === 'sweep-failure' || row.kind === 'task-failure'),
        [],
        'a refused or unresolvable delegation directory does not fail the sweep'
      )
      const removed = rowOf(receipt, delivered.workspaceId)
      assert.deepEqual(
        [removed.outcome, verdictName(removed.verdict)],
        ['removed', 'branch-in-target']
      )
      assert.equal(existsSync(delivered.checkout), false)
      assert.ok(!git(['worktree', 'list', '--porcelain'], foreignRepo).includes(delivered.checkout))
      const kept = rowOf(receipt, undelivered.workspaceId)
      assert.deepEqual(
        [kept.outcome, verdictName(kept.verdict)],
        ['retained', 'retained:not-integrated']
      )
      assert.ok(existsSync(join(undelivered.checkout, 'pending.txt')))
      assert.equal(readFileSync(join(foreignRepo, 'tracked.txt'), 'utf8'), 'foreign\n')
      assert.equal(
        (await lifecycle.inspect({ cwd: foreignRepo })).find(
          view => view.workspaceId === undelivered.workspaceId
        )?.taskId,
        foreignTask,
        'the foreign task is listed in its own repository'
      )
    }
  )

  await claim(
    'a quit-mode sweep releases a clean foreign native-write reservation and preserves the pre-existing checkout files',
    async () => {
      const written = join(sandbox, 'foreign-written-repo')
      mkdirSync(written)
      git(['init', '--quiet', '-b', 'main'], written)
      git(['config', 'user.name', 'Sweep Check'], written)
      git(['config', 'user.email', 'sweep-check@example.invalid'], written)
      writeFileSync(join(written, 'tracked.txt'), 'written\n')
      git(['add', '.'], written)
      git(['commit', '--quiet', '-m', 'written fixture'], written)
      const owner = await reserve(userCheckout('foreign-writer'))
      const grant = ready(await owner.owner.authorize({ kind: 'foreign-write', cwd: written }))
      assert.equal(grant.checkout, written)
      assert.deepEqual(owner.owner.effect.delegatedCwds, [written])
      await owner.owner.close()
      const receipt = await sweepWith(
        lifecycle,
        owner.write.workspaceId,
        owner.owner.effect.delegatedCwds
      )
      const row = rowOf(receipt, grant.workspaceId)
      assert.deepEqual([row.outcome, verdictName(row.verdict)], ['released', 'clean-checkout'])
      assert.equal(readFileSync(join(written, 'tracked.txt'), 'utf8'), 'written\n')
      assert.equal(
        (await lifecycle.inspect({ cwd: written })).find(view => view.path === written)
          ?.reservationId,
        undefined,
        'the reservation ended'
      )
    }
  )

  await claim(
    'a repository whose records cannot be read at quit yields a sweep-failure row naming it instead of losing the receipt: the anchor repository still reports its tasks, nothing is touched, and the next sweep finishes both',
    async () => {
      const foreignRepo = join(sandbox, 'foreign-repo')
      const owner = await reserve(userCheckout('foreign-failure'))
      const child = ready(
        await owner.owner.authorize({
          kind: 'delegated-write',
          cwd: foreignRepo,
        })
      )
      await owner.owner.close()
      const shardDirectory = join(root, 'repos', child.repositoryId)
      chmodSync(shardDirectory, 0o000)
      let receipt: SweepReceipt
      try {
        receipt = await sweepWith(lifecycle, owner.write.workspaceId, [foreignRepo])
      } finally {
        chmodSync(shardDirectory, 0o700)
      }
      assert.ok(
        receipt.rows.some(row => row.kind === 'task-failure' && row.taskId === owner.taskId),
        `the anchor repository's receipt survived: ${JSON.stringify(receipt.rows)}`
      )
      const failure = receipt.rows.find(row => row.kind === 'sweep-failure')
      assert.ok(failure !== undefined, JSON.stringify(receipt.rows))
      assert.ok(failure.reason.includes(join(foreignRepo, '.git')), failure.reason)
      assert.ok(
        !receipt.rows.some(row => row.kind === 'workspace' && row.workspaceId === child.workspaceId)
      )
      assert.ok(existsSync(child.checkout), 'the unassessed worktree is untouched')
      const recovery = await sweepWith(lifecycle, owner.write.workspaceId, [foreignRepo])
      assert.equal(rowOf(recovery, owner.write.workspaceId).outcome, 'released')
      const recovered = rowOf(recovery, child.workspaceId)
      assert.deepEqual(
        [recovered.outcome, verdictName(recovered.verdict)],
        ['removed', 'no-residue']
      )
      assert.equal(existsSync(child.checkout), false)
    }
  )

  await claim(
    'a detached worktree at its base with only Git-ignored files is automatically removed at quit',
    async () => {
      const checkout = userCheckout('ignored-detached')
      const owner = await reserve(checkout)
      const contender = await lifecycle.attach({
        conversation: conversation(),
        cwd: checkout,
      })
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
      const owner = await lifecycle.attach({
        conversation: conversation(),
        cwd: lazyRepo,
      })
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
        pullRequestLastCommit: () => offline('pullRequestLastCommit'),
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
        pullRequestLastCommit: () => undefined,
        mergedPullRequestsForCommit: () => [],
        compare: () => ({
          unavailable: 'unexpected comparison of local history',
        }),
      }
      const authority = new WorkspaceAuthority(root)
      const assessment = () => {
        const view = checkTask(authority, owner.taskId, {
          github: reader,
        }).find(item => item.workspaceId === child.workspaceId)
        assert.ok(view !== undefined)
        return view
      }
      try {
        const before = assessment().completion
        assert.ok(before.kind === 'retained')
        assert.equal(before.retained, 'not-integrated')
        rmSync(sibling.checkout, { recursive: true, force: true })
        const view = assessment()
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
    "quit prefetch starts every task's recorded pull request read while the first task still awaits its evidence, and gated release removes both the delivered branch and a patch-integrated child on that request-scoped evidence",
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
      const patched = ready(await owner.owner.authorize({ kind: 'delegated-write' }))
      writeFileSync(join(patched.checkout, 'feature.txt'), 'delivered\n')
      git(['add', 'feature.txt'], patched.checkout)
      git(['commit', '--quiet', '-m', 'child delivered by patch'], patched.checkout)
      const patchedHead = git(['rev-parse', 'HEAD'], patched.checkout)
      assert.notEqual(patchedHead, head)
      assert.ok(!git(['rev-list', head], asyncRepo).split('\n').includes(patchedHead))
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
      const response = new Promise<{
        readonly status: 'ok'
        readonly text: string
      }>(resolve => {
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
        const pendingSweep = sweepRepositoryAtClose(
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
                  },
                },
              },
            },
          }),
        })
        const receipt = await pendingSweep
        const row = rowOf(receipt, child.workspaceId)
        assert.equal(verdictName(row.verdict), 'branch-merged', row.reason)
        assert.equal(row.outcome, 'removed', row.reason)
        assert.ok(!existsSync(child.checkout), 'the gated release removed the delivered worktree')
        const patchedRow = rowOf(receipt, patched.workspaceId)
        assert.equal(verdictName(patchedRow.verdict), 'child-delivered', patchedRow.reason)
        assert.equal(patchedRow.outcome, 'removed', patchedRow.reason)
        assert.ok(!existsSync(patched.checkout), 'gated release discarded the original child work')
        assert.ok(!git(['worktree', 'list', '--porcelain'], asyncRepo).includes(patched.checkout))
        assert.equal(graphqlCalls, 1, 'gated re-assessment reuses the request-scoped evidence')
        assert.equal(synchronousGraphqlCalls, 0)
      } finally {
        authority.close()
      }
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

  await claim(
    'a sweep at a conversation replacement releases the clean pre-existing reservation and removes its finished worktree, retains a modified checkout and a live child with their reasons, and records the replacement as the decider',
    async () => {
      const activeOwner = await reserve(userCheckout('replacement-live'))
      const activeChild = ready(
        await activeOwner.owner.authorize({
          kind: 'delegated-write',
          execution: {
            sessionId: 'replacement-live',
            taskKey: 'live-child',
            attemptId: newId(),
            generation: '1',
          },
        })
      )
      const cleanCheckout = userCheckout('replacement-clean')
      const cleanOwner = await reserve(cleanCheckout)
      const finishedChild = ready(await cleanOwner.owner.authorize({ kind: 'delegated-write' }))
      await cleanOwner.owner.close()
      const modifiedCheckout = userCheckout('replacement-modified')
      const modifiedOwner = await reserve(modifiedCheckout)
      await modifiedOwner.owner.close()
      writeFileSync(join(modifiedCheckout, 'tracked.txt'), 'edited before the replacement\n')

      const receipt = await lifecycle.sweep({
        moment: 'replacement',
        anchorWorkspaceId: cleanOwner.write.workspaceId,
        delegatedCwds: [],
        occupiedPaths: [],
      })
      assert.equal(receipt.moment, 'replacement')
      const released = rowOf(receipt, cleanOwner.write.workspaceId)
      assert.deepEqual(
        [released.outcome, verdictName(released.verdict)],
        ['released', 'clean-checkout']
      )
      assert.ok(
        !(await reservedTasks()).includes(cleanOwner.taskId),
        'the clean checkout is free for the next conversation'
      )
      assert.equal(readFileSync(join(cleanCheckout, 'tracked.txt'), 'utf8'), 'tracked\n')
      const removed = rowOf(receipt, finishedChild.workspaceId)
      assert.deepEqual([removed.outcome, verdictName(removed.verdict)], ['removed', 'no-residue'])
      assert.equal(existsSync(finishedChild.checkout), false)
      const modified = rowOf(receipt, modifiedOwner.write.workspaceId)
      assert.deepEqual(
        [modified.outcome, verdictName(modified.verdict)],
        ['retained', 'retained:checkout-modified']
      )
      assert.ok((await reservedTasks()).includes(modifiedOwner.taskId))
      const active = rowOf(receipt, activeChild.workspaceId)
      assert.deepEqual(
        [active.outcome, verdictName(active.verdict)],
        ['retained', 'retained:use-live']
      )
      assert.ok(existsSync(activeChild.checkout), 'the live child worktree is untouched')
      assert.ok((await reservedTasks()).includes(activeOwner.taskId))
      assert.ok(
        formatSweepReceipt(receipt).startsWith('Workspace sweep at the conversation replacement'),
        formatSweepReceipt(receipt)
      )
      const view = (await lifecycle.inspect({ taskId: cleanOwner.taskId })).find(
        entry => entry.workspaceId === finishedChild.workspaceId
      )
      assert.equal(view?.outcome, 'removed')
      assert.ok(view?.reason.startsWith('By the sweep at a conversation replacement'), view?.reason)
      await activeOwner.owner.close()
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
        ],
      },
      null,
      2
    )}\n`
  )
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}
