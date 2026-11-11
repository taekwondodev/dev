import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { WorkspaceError, type SweepReceipt, type WorkspaceId } from '../../src/workspace-domain.ts'
import { authorityPaths, taskArtifactsPath } from '../../src/workspace-authority-root.ts'
import { formatSweepReceipt, reservedViews, sweepExitCode } from '../../src/workspace-command.ts'
import { quitReleaseExclusion, tasksToRelease } from '../../src/quit-display.ts'
import type { StartWorkspaceWorker } from '../../src/workspace-lifecycle.ts'
import { newId } from '../../src/workspace-platform.ts'
import { classifyWriteDestination } from '../../src/workspace-paths.ts'
import { verdictName } from './workspace-completion-fixtures.ts'
import { makeClaims } from './workspace-check-support.ts'
import type { ReleaseFault } from './workspace-release-fault-preload.ts'
import {
  artifactsRowOf,
  git,
  localMain,
  openSweepFixture,
  ready,
  receiptsOf,
  rowOf,
  sweepSandbox,
  sweepWith,
  taskOf,
} from './workspace-sweep-fixture.ts'
import { openLifecycle } from './workspace-test-lifecycle.ts'

const sandbox = sweepSandbox('workspace-sweep-recovery-check')
const FAULT_PRELOAD = new URL('./workspace-release-fault-preload.ts', import.meta.url).href
const { claim, passed } = makeClaims()

try {
  const { root, repo, lifecycle, conversation, userCheckout, reserve, deliverBranch, sweepAtQuit } =
    await openSweepFixture(sandbox)

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
  const finishedWorktree = async (name: string) => {
    const checkout = userCheckout(name)
    const owner = await reserve(checkout)
    const managed = ready(await owner.owner.authorize({ kind: 'delegated-write' }))
    await owner.owner.close()
    await lifecycle.recordTarget(owner.taskId, localMain)
    deliverBranch(managed.checkout)
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
    'a sweep interrupted after recording its removal, or right after Git removed the worktree, leaves the release unfinished: later sweeps retain it as release-review and dev workspace release finishes it',
    async () => {
      for (const fault of ['before-git-remove', 'after-git-remove'] as const) {
        const interrupted = await finishedWorktree(fault)
        await crashSweep(fault, interrupted.managed.checkout, interrupted.owner.write.workspaceId)
        const view = (await lifecycle.inspect({ taskId: interrupted.owner.taskId })).find(
          item => item.workspaceId === interrupted.managed.workspaceId
        )
        assert.deepEqual(
          view?.pending.map(item => [item.kind, item.stage]),
          [['release', 'started']]
        )
        const later = await sweepAtQuit(interrupted.owner.write.workspaceId)
        const row = rowOf(later, interrupted.managed.workspaceId)
        assert.deepEqual(
          [row.outcome, verdictName(row.verdict)],
          ['review-required', 'retained:release-review'],
          row.reason
        )
        const released = await lifecycle.release(interrupted.owner.taskId)
        const removal = released.find(
          item => item.kind === 'workspace' && item.workspaceId === interrupted.managed.workspaceId
        )
        assert.equal(removal?.outcome, 'removed', JSON.stringify(removal))
        assert.equal(existsSync(interrupted.managed.checkout), false)
      }
    }
  )

  await claim(
    'a worktree directory deleted outside dev is retained as directory-missing by check and sweep; release removes its Git registration and reservation, records removal, and leaves nothing for the next sweep',
    async () => {
      const goneCheckout = userCheckout('gone')
      const goneOwner = await reserve(goneCheckout)
      const gone = ready(await goneOwner.owner.authorize({ kind: 'delegated-write' }))
      await goneOwner.owner.close()
      await lifecycle.recordTarget(goneOwner.taskId, localMain)
      const adminPath = git(['rev-parse', '--path-format=absolute', '--git-dir'], gone.checkout)
      rmSync(gone.checkout, { recursive: true, force: true })
      const assessment = (await lifecycle.check(goneOwner.taskId)).find(
        view => view.workspaceId === gone.workspaceId
      )
      assert.ok(assessment !== undefined)
      assert.equal(verdictName(assessment.completion), 'retained:directory-missing')
      const kept = await sweepAtQuit(goneOwner.write.workspaceId)
      const missing = rowOf(kept, gone.workspaceId)
      assert.deepEqual(
        [missing.outcome, verdictName(missing.verdict)],
        ['retained', 'retained:directory-missing']
      )
      const released = await lifecycle.release(goneOwner.taskId)
      assert.equal(
        released.find(item => item.kind === 'workspace' && item.workspaceId === gone.workspaceId)
          ?.outcome,
        'removed'
      )
      assert.ok(!existsSync(adminPath), 'the targeted registration is gone')
      assert.ok(!git(['worktree', 'list', '--porcelain'], repo).includes(gone.checkout))
      assert.equal(
        (await lifecycle.inspect({ taskId: goneOwner.taskId })).find(
          view => view.workspaceId === gone.workspaceId
        )?.outcome,
        'removed'
      )
      const rerun = await sweepAtQuit(goneOwner.write.workspaceId)
      assert.ok(
        !rerun.rows.some(
          entry => entry.kind === 'workspace' && entry.workspaceId === gone.workspaceId
        ),
        JSON.stringify(rerun.rows)
      )
    }
  )

  const allocate = async (name: string) => {
    const owner = await reserve(userCheckout(name))
    writeFileSync(join(owner.write.checkout, 'pending.txt'), 'keep the pre-existing checkout\n')
    const managed = ready(await owner.owner.authorize({ kind: 'delegated-write' }))
    await owner.owner.close()
    await lifecycle.recordTarget(owner.taskId, localMain)
    return { owner, managed }
  }
  await claim(
    'a sweep that uses its time budget stops before the next task: it defers every remaining task with a receipt row and touches none of it, and the next sweep attempts the deferred task',
    async () => {
      const first = await allocate('budget-a')
      const pending = join(first.managed.checkout, 'pending.txt')
      writeFileSync(pending, 'unfinished until the second worktree exists\n')
      const second = await allocate('budget-b')
      rmSync(pending)
      deliverBranch(first.managed.checkout)
      git(['merge', '--quiet', '--ff-only', 'main'], second.managed.checkout)
      deliverBranch(second.managed.checkout)
      const firstInSweep = first.owner.taskId < second.owner.taskId ? first : second
      const paths = authorityPaths(root)
      const orphanTask = newId()
      const orphan = taskArtifactsPath(paths, orphanTask)
      mkdirSync(orphan, { recursive: true })
      const late = await openLifecycle({
        root,
        startWorker: faultyWorker('clock-after-git-remove', firstInSweep.managed.checkout),
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
      assert.ok(existsSync(orphan), 'an expired budget leaves orphan artifacts for a later sweep')

      const next = await sweepAtQuit(kept.owner.write.workspaceId)
      const cleanDelivered = rowOf(next, kept.managed.workspaceId)
      assert.deepEqual(
        [cleanDelivered.outcome, verdictName(cleanDelivered.verdict)],
        ['removed', 'branch-in-target'],
        'a clean branch whose commits reached the target is removed as delivered'
      )
      assert.equal(existsSync(kept.managed.checkout), false)
      assert.equal(artifactsRowOf(next, orphanTask)?.outcome, 'removed')
      assert.equal(existsSync(orphan), false, 'a later closing sweep removes the orphan')
    }
  )

  await claim(
    'a sweep budget runs from when the host sent the request: of two allocations sent together, the one queued behind a sweep that used the budget defers every task instead of sweeping again, and both allocations succeed',
    async () => {
      const finishedOne = await finishedWorktree('queued-finished')
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
    'a removal that does not complete makes the sweep exit 1, later sweeps retain it as release-review, and dev workspace release finishes it',
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
      assert.equal(stopped.outcome, 'review-required', stopped.reason)
      assert.equal(sweepExitCode(partial), 1)

      const later = await sweepAtQuit(owner.write.workspaceId)
      const skipped = rowOf(later, managed.workspaceId)
      assert.deepEqual(
        [skipped.outcome, verdictName(skipped.verdict), skipped.operationId],
        ['review-required', 'retained:release-review', undefined]
      )
      assert.equal(sweepExitCode(later), 0, 'a retained workspace is not an attempt')

      const settled = await lifecycle.release(owner.taskId)
      const removal = settled.find(
        item => item.kind === 'workspace' && item.workspaceId === managed.workspaceId
      )
      assert.equal(removal?.outcome, 'removed', JSON.stringify(removal))
      assert.ok(!git(['worktree', 'list', '--porcelain'], repo).includes(managed.checkout))
    }
  )

  await claim(
    'task artifact directories are classified only for the bound task, survive while reserved, and orphan directories are removed at a closing sweep while links and foreign entries are left for review',
    async () => {
      const owner = await reserve(userCheckout('artifacts'))
      const paths = authorityPaths(root)
      const artifacts = taskArtifactsPath(paths, owner.taskId)
      const scoped = {
        checkout: owner.write.checkout,
        authorityRoot: root,
        taskId: owner.taskId,
      }
      const classify = (writeScope: typeof scoped | Omit<typeof scoped, 'taskId'>, path: string) =>
        classifyWriteDestination(writeScope, owner.write.cwd, path)
      assert.equal(classify(scoped, join(artifacts, 'pr-body.md')).kind, 'artifact')
      assert.equal(classify(scoped, join(artifacts, 'logs', 'audit.log')).kind, 'artifact')
      assert.equal(
        classify(scoped, join(owner.write.checkout, 'tracked.txt')).kind,
        'workspace',
        'checkout writes keep their classification'
      )
      const { taskId: _omitted, ...withoutTask } = scoped
      for (const [writeScope, path, reason] of [
        [withoutTask, join(artifacts, 'pr-body.md'), 'a scope without a task'],
        [scoped, join(taskArtifactsPath(paths, newId()), 'pr-body.md'), "another task's directory"],
        [scoped, artifacts, 'the directory itself'],
        [scoped, join(paths.artifacts, 'notes.md'), 'the artifacts root'],
        [scoped, join(root, 'catalog.sqlite'), 'authority metadata'],
      ] as const) {
        assert.throws(
          () => classify(writeScope, path),
          (cause: unknown) =>
            cause instanceof WorkspaceError && cause.message.includes('dev authority metadata'),
          `${reason} is refused`
        )
      }

      mkdirSync(artifacts, { recursive: true })
      writeFileSync(join(artifacts, 'pr-body.md'), 'body\n')
      const live = await sweepAtQuit(owner.write.workspaceId)
      assert.equal(rowOf(live, owner.write.workspaceId).outcome, 'retained')
      assert.ok(
        !live.rows.some(row => row.kind === 'task-artifacts' && row.taskId === owner.taskId),
        'a reserved task keeps its artifacts unreported'
      )
      assert.ok(existsSync(join(artifacts, 'pr-body.md')))
      const sibling = ready(await owner.owner.authorize({ kind: 'delegated-write' }))
      assert.equal(sibling.taskId, owner.taskId)
      await owner.owner.close()
      const attached = await lifecycle.attach({
        conversation: conversation(),
        cwd: sibling.checkout,
        selection: { taskId: owner.taskId, workspaceId: sibling.workspaceId },
      })
      const firstReservationEnds = await sweepAtQuit(owner.write.workspaceId)
      assert.equal(rowOf(firstReservationEnds, owner.write.workspaceId).outcome, 'released')
      assert.equal(rowOf(firstReservationEnds, sibling.workspaceId).outcome, 'retained')
      assert.ok(existsSync(artifacts), 'a remaining reservation retains task artifacts')
      assert.equal(artifactsRowOf(firstReservationEnds, owner.taskId), undefined)
      await attached.close()
      const released = await sweepAtQuit(sibling.workspaceId)
      assert.deepEqual(
        [
          rowOf(released, sibling.workspaceId).outcome,
          verdictName(rowOf(released, sibling.workspaceId).verdict),
        ],
        ['removed', 'no-residue']
      )
      const artifactsRow = artifactsRowOf(released, owner.taskId)
      assert.equal(artifactsRow?.outcome, 'removed', JSON.stringify(released.rows))
      assert.equal(existsSync(artifacts), false, 'the directory left with the reservation')
      assert.equal(sweepExitCode(released), 0)
      assert.ok(formatSweepReceipt(released).includes(`task artifacts at ${artifacts}`))

      const orphanTask = newId()
      const orphan = taskArtifactsPath(paths, orphanTask)
      mkdirSync(orphan, { recursive: true })
      writeFileSync(join(orphan, 'junk.txt'), 'junk\n')
      writeFileSync(join(paths.artifacts, 'notes.txt'), 'not a task\n')
      const linkedTask = newId()
      const elsewhere = join(sandbox, 'linked-artifacts')
      mkdirSync(elsewhere)
      writeFileSync(join(elsewhere, 'keep.txt'), 'keep\n')
      symlinkSync(elsewhere, taskArtifactsPath(paths, linkedTask))
      assert.ok(existsSync(orphan), 'the orphan waits for a later closing sweep')
      const orphans = await sweepAtQuit(owner.write.workspaceId)
      const orphanRow = artifactsRowOf(orphans, orphanTask)
      assert.equal(orphanRow?.outcome, 'removed', JSON.stringify(orphans.rows))
      assert.equal(existsSync(orphan), false)
      const linkedRow = artifactsRowOf(orphans, linkedTask)
      assert.equal(linkedRow?.outcome, 'review-required', JSON.stringify(orphans.rows))
      assert.ok(existsSync(join(elsewhere, 'keep.txt')), 'a link target is never deleted')
      assert.ok(existsSync(join(paths.artifacts, 'notes.txt')), 'a foreign entry stays untouched')
      assert.equal(sweepExitCode(orphans), 1, 'an entry left for review is not a terminal outcome')
      rmSync(taskArtifactsPath(paths, linkedTask))
      const settled = await sweepAtQuit(owner.write.workspaceId)
      assert.ok(
        !settled.rows.some(row => row.kind === 'task-artifacts'),
        JSON.stringify(settled.rows)
      )
      assert.equal(sweepExitCode(settled), 0)
    }
  )

  const pendingAllocations = async () =>
    (await lifecycle.inspect({ cwd: repo })).filter(view =>
      view.pending.some(operation => operation.kind === 'allocation')
    )
  const crashedAllocation = async (name: string) => {
    const checkout = userCheckout(name)
    const owner = await reserve(checkout)
    await owner.owner.close()
    const faulty = await openLifecycle({
      root,
      startWorker: faultyWorker('after-git-add', checkout),
    })
    const contender = await faulty.attach({ conversation: conversation(), cwd: checkout })
    await assert.rejects(
      contender.authorize({ kind: 'write' }),
      (cause: unknown) => cause instanceof WorkspaceError && cause.outcome === 'unavailable'
    )
    await faulty.close()
    const [view, ...others] = await pendingAllocations()
    assert.ok(view !== undefined && others.length === 0)
    const { taskId } = view
    assert.ok(taskId !== undefined)
    return { owner, unfinished: { ...view, taskId } }
  }

  await claim(
    'a worktree allocation interrupted right after Git created the worktree is listed by the sweep at quit as an unresolved transition its task can release, and dev workspace release clears it: the worktree and its Git registration are removed, the pending operation closes and the next sweep lists nothing of it',
    async () => {
      const { owner, unfinished } = await crashedAllocation('allocation-crash')
      assert.ok(existsSync(unfinished.path), 'Git created the worktree before the crash')
      assert.ok(git(['worktree', 'list', '--porcelain'], repo).includes(unfinished.path))
      assert.equal(
        unfinished.nextAction,
        `dev workspace release ${unfinished.taskId} clears it and removes what Git created of the worktree.`
      )

      const quit = await sweepAtQuit(owner.write.workspaceId)
      const row = rowOf(quit, unfinished.workspaceId)
      assert.deepEqual(
        [row.taskId, row.outcome, verdictName(row.verdict), row.path],
        [unfinished.taskId, 'retained', 'retained:transition-unresolved', unfinished.path]
      )
      assert.ok(
        tasksToRelease(quit).includes(unfinished.taskId),
        'the quit prompt offers the task for release'
      )
      assert.equal(
        quitReleaseExclusion(
          quit,
          reservedViews(await lifecycle.inspect({ taskId: unfinished.taskId }))
        ),
        undefined,
        'the confirmation does not exclude the task'
      )
      assert.equal(sweepExitCode(quit), 0)
      assert.ok(existsSync(unfinished.path), 'the sweep itself removes nothing of it')

      const released = await lifecycle.release(unfinished.taskId)
      assert.deepEqual(
        released.map(result => [
          result.kind,
          result.kind === 'workspace' ? result.workspaceId : undefined,
          result.outcome,
        ]),
        [['workspace', unfinished.workspaceId, 'removed']],
        JSON.stringify(released)
      )
      assert.equal(existsSync(unfinished.path), false)
      assert.ok(!git(['worktree', 'list', '--porcelain'], repo).includes(unfinished.path))
      assert.deepEqual(await pendingAllocations(), [])
      const later = await sweepAtQuit(owner.write.workspaceId)
      assert.ok(
        !later.rows.some(
          entry => entry.kind === 'workspace' && entry.workspaceId === unfinished.workspaceId
        ),
        JSON.stringify(later.rows)
      )
    }
  )

  await claim(
    'releasing an unfinished allocation removes nothing when another task has since taken its target as a checkout: the operation closes and that task keeps its files and reservation',
    async () => {
      const { unfinished } = await crashedAllocation('allocation-adopted')
      const adopter = await lifecycle.attach({ conversation: conversation(), cwd: unfinished.path })
      const adopted = ready(await adopter.authorize({ kind: 'write' }))
      writeFileSync(join(unfinished.path, 'adopted.txt'), 'work of another task\n')
      await adopter.close()

      const released = await lifecycle.release(unfinished.taskId)
      assert.deepEqual(
        released.map(result => result.outcome),
        ['released'],
        JSON.stringify(released)
      )
      assert.ok(existsSync(join(unfinished.path, 'adopted.txt')), 'the other task keeps its files')
      assert.deepEqual(await pendingAllocations(), [])
      assert.ok(
        (await lifecycle.inspect({ taskId: adopted.taskId })).some(
          view => view.workspaceId === adopted.workspaceId && view.path === unfinished.path
        ),
        'the other task keeps its reservation'
      )
      await lifecycle.release(taskOf(adopted))
    }
  )

  await claim(
    "releasing an unfinished allocation follows Git's own link to its admin directory: an unrelated entry that merely carries the worktree's name stays, on the release and on a repeated one",
    async () => {
      const { unfinished } = await crashedAllocation('allocation-renamed-admin')
      const admins = join(repo, '.git', 'worktrees')
      const name = basename(unfinished.path)
      const admin = join(admins, `${name}1`)
      renameSync(join(admins, name), admin)
      writeFileSync(join(unfinished.path, '.git'), `gitdir: ${admin}\n`)
      const unrelated = join(admins, name)
      mkdirSync(unrelated)
      writeFileSync(join(unrelated, 'keep'), 'not this allocation\n')
      assert.ok(git(['worktree', 'list', '--porcelain'], repo).includes(unfinished.path))

      const released = await lifecycle.release(unfinished.taskId)
      assert.deepEqual(
        released.map(result => result.outcome),
        ['removed'],
        JSON.stringify(released)
      )
      assert.equal(existsSync(unfinished.path), false)
      assert.equal(existsSync(admin), false)
      assert.ok(existsSync(join(unrelated, 'keep')), 'the unrelated admin entry stays')
      assert.deepEqual(await pendingAllocations(), [])
      assert.deepEqual(await lifecycle.release(unfinished.taskId), [])
      assert.ok(existsSync(join(unrelated, 'keep')), 'a repeated release leaves it too')
      rmSync(unrelated, { recursive: true })
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
