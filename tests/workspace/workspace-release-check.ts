import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import {
  WorkspaceError,
  type WorkspaceHandoff,
  type PublicationReference,
  type SweepReceipt,
  type TaskTarget,
  type WorkspaceAssessment,
  type WorkspaceId,
  type WorkspaceReleaseResult,
} from '../../src/workspace-domain.ts'
import { decideCompletion } from '../../src/workspace-completion.ts'
import { WorkspaceAuthority } from '../../src/workspace-authority.ts'
import { checkTask } from '../../src/workspace-release.ts'
import {
  integrationFacts,
  isUnavailable,
  makeGitHubReader,
  type GitHubPullRequest,
  type GitHubReader,
} from '../../src/workspace-evidence.ts'
import {
  PublicationDestinations,
  WorkspaceToolError,
  WorkspaceToolInputSchema,
  makeWorkspaceTool,
  workspaceToolParameters,
  type PublicationDestinationReader,
} from '../../src/workspace-tool.ts'
import { type JsonObject, type Tool, validateToolArguments } from '@earendil-works/pi-ai'
import type { StartWorkspaceWorker } from '../../src/workspace-lifecycle.ts'
import {
  formatReleaseResults,
  releaseExitCode,
  releasePlan,
  reservedViews,
} from '../../src/workspace-command.ts'
import { newId } from '../../src/workspace-platform.ts'
import { acquireMaintenance, acquireRuntime } from '../../src/runtime-coordination.ts'
import { authorityPaths } from '../../src/workspace-authority-root.ts'
import { acquirePathGates, releaseGates } from '../../src/workspace-gates.ts'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Clock, Effect, Exit, Scope } from 'effect'
import { makeClaims } from './workspace-check-support.ts'
import { managedFacts, verdictName } from './workspace-completion-fixtures.ts'
import type { ReleaseFault } from './workspace-release-fault-preload.ts'
import {
  openLifecycle,
  type TestAttachment,
  type TestLifecycle,
} from './workspace-test-lifecycle.ts'

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'dev-workspace-release-check-')))
const root = join(sandbox, 'authority')
const FAULT_PRELOAD = new URL('./workspace-release-fault-preload.ts', import.meta.url).href
const { claim, passed } = makeClaims()

const git = (args: readonly string[], cwd: string): string =>
  execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const initRepository = (path: string): string => {
  mkdirSync(path, { recursive: true })
  git(['init', '--quiet', '-b', 'main'], path)
  git(['config', 'user.name', 'Release Check'], path)
  git(['config', 'user.email', 'release-check@example.invalid'], path)
  writeFileSync(join(path, 'tracked.txt'), 'tracked\n')
  writeFileSync(join(path, '.gitignore'), 'build/\ncache/\n*.log\n')
  git(['add', '.'], path)
  git(['commit', '--quiet', '-m', 'fixture'], path)
  return git(['rev-parse', 'HEAD'], path)
}
let conversationCount = 0
const conversation = () => {
  conversationCount += 1
  const dataHome = join(sandbox, `data-${conversationCount}`)
  mkdirSync(dataHome, { recursive: true })
  const sessionFile = join(dataHome, 'session.jsonl')
  writeFileSync(sessionFile, '{}\n', { mode: 0o600 })
  return { sessionId: `session-${conversationCount}`, sessionFile, dataHome }
}
const expectError = async (
  promise: Promise<unknown>,
  outcome: WorkspaceError['outcome'],
  names: readonly string[] = []
): Promise<WorkspaceError> => {
  try {
    await promise
  } catch (cause) {
    assert.ok(cause instanceof WorkspaceError, `expected a WorkspaceError, got ${String(cause)}`)
    assert.equal(cause.outcome, outcome, cause.message)
    for (const name of names) assert.ok(cause.message.includes(name), cause.message)
    return cause
  }
  throw new Error(`expected a ${outcome} refusal`)
}
const ready = (result: Awaited<ReturnType<TestAttachment['authorize']>>) => {
  if (result.kind !== 'ready')
    throw new Error(`expected a ready grant, got ${JSON.stringify(result)}`)
  return result.grant
}
const requireTask = (id: WorkspaceId | undefined): WorkspaceId => {
  if (id === undefined) throw new Error('a write grant carries a task identity')
  return id
}
const only = (assessments: readonly WorkspaceAssessment[], workspaceId: string) => {
  const found = assessments.find(item => item.workspaceId === workspaceId)
  if (found === undefined) throw new Error(`no assessment for ${workspaceId}`)
  return found
}
const outcomes = (results: readonly WorkspaceReleaseResult[]) =>
  results.map(result => [result.workspaceId, result.outcome])
const resultOf = (results: readonly WorkspaceReleaseResult[], workspaceId: string) => {
  const found = results.find(item => item.workspaceId === workspaceId)
  if (found === undefined) throw new Error(`no release result for ${workspaceId}`)
  return found
}
const reply = (text: string) =>
  JSON.parse(text) as {
    readonly recorded: string
    readonly reference?: PublicationReference
  }
const localMain: TaskTarget = { kind: 'local', ref: 'refs/heads/main' }
const MERGED_AT = '2026-09-28T20:08:49Z'
const seeded = (seed: string) => (_repository: string, sha: string) => (sha === seed ? [7] : [])
const registered = (repo: string) =>
  git(['worktree', 'list', '--porcelain'], repo)
    .split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => line.slice('worktree '.length))
const PUBLISHED_URL = 'https://github.com/owner/repo/issues/37#issuecomment-5'
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
    number: 37,
    commentId: 5,
    readBack: 'text-in-body',
    url: PUBLISHED_URL,
  },
  verifiedAt: Date.now(),
})
const allocateManaged = async (lifecycle: TestLifecycle, cwd: string) => {
  const owner = await lifecycle.attach({ conversation: conversation(), cwd })
  const write = ready(await owner.authorize({ kind: 'write' }))
  const taskId = requireTask(write.taskId)
  const managed = ready(await owner.authorize({ kind: 'delegated-write' }))
  assert.equal(managed.taskId, taskId)
  await owner.close()
  return { taskId, repoWorkspaceId: write.workspaceId, managed }
}

try {
  const repo = join(sandbox, 'repo')
  const mainCommit = initRepository(repo)
  const lifecycle = await openLifecycle({ root })
  let checkouts = 0
  const userCheckout = (repository: string = repo): string => {
    checkouts += 1
    const path = join(sandbox, `checkout-${checkouts}`)
    git(['worktree', 'add', '--quiet', '-b', `checkout-${checkouts}`, path, 'main'], repository)
    return path
  }
  const deliverBranch = (checkout: string, into: string = repo): string => {
    const name = `delivered-${newId()}`
    git(['switch', '--quiet', '-c', name], checkout)
    writeFileSync(join(checkout, `${name}.txt`), `${name}\n`)
    git(['add', `${name}.txt`], checkout)
    git(['commit', '--quiet', '-m', name], checkout)
    git(['merge', '--quiet', '--ff-only', name], into)
    return git(['rev-parse', 'HEAD'], checkout)
  }

  const holder = await lifecycle.attach({ conversation: conversation(), cwd: repo })
  const held = ready(await holder.authorize({ kind: 'write' }))
  const taskA = requireTask(held.taskId)
  writeFileSync(join(repo, 'tracked.txt'), 'edited while reserved\n')
  writeFileSync(join(repo, 'notes.log'), 'ignored residual\n')
  await claim(
    'check of a task whose pre-existing checkout is in live use retains it as a live use naming that use, without attaching or acquiring anything',
    async () => {
      const usesBefore = (await lifecycle.inspect({ cwd: repo })).flatMap(view => view.uses).length
      const [assessment] = await lifecycle.check(taskA)
      assert.ok(assessment !== undefined)
      assert.equal(assessment.origin, 'pre-existing')
      assert.equal(verdictName(assessment.completion), 'retained:use-live')
      assert.ok(
        assessment.reasons.some(reason => reason.includes(held.useId)),
        assessment.reasons.join(' | ')
      )
      const usesAfter = (await lifecycle.inspect({ cwd: repo })).flatMap(view => view.uses).length
      assert.equal(usesAfter, usesBefore, 'a check records no use')
    }
  )
  await holder.close()
  await claim(
    'dev workspace release of a pre-existing checkout ends only its reservation and use records whatever its residue: files, commits and the ignored residual stay, the receipt stays inspectable by task, and a repeated release finds nothing',
    async () => {
      const [assessment] = await lifecycle.check(taskA)
      assert.ok(assessment !== undefined)
      assert.equal(verdictName(assessment.completion), 'retained:checkout-modified')
      assert.ok(
        assessment.residual.some(item => item.includes('tracked.txt')),
        assessment.residual.join(';')
      )
      assert.equal(assessment.evidence, undefined, 'no integration or publication proof is read')
      const settledBefore = (await lifecycle.inspect({ cwd: repo })).flatMap(view => view.uses)
      assert.ok(settledBefore.length > 0, 'the ended holder left settled use records')
      const results = await lifecycle.release(taskA)
      assert.deepEqual(outcomes(results), [[held.workspaceId, 'released']])
      assert.equal(releaseExitCode(results), 0)
      assert.equal(readFileSync(join(repo, 'tracked.txt'), 'utf8'), 'edited while reserved\n')
      assert.equal(readFileSync(join(repo, 'notes.log'), 'utf8'), 'ignored residual\n')
      assert.equal(git(['rev-parse', 'HEAD'], repo), mainCommit)
      const views = await lifecycle.inspect({ cwd: repo })
      assert.equal(views.length, 1)
      assert.equal(views[0]?.taskId, undefined, 'the checkout holds no reservation any more')
      assert.deepEqual(views[0]?.uses, [], "the released reservation's uses are deleted")
      assert.deepEqual(
        (await lifecycle.inspect({ taskId: taskA })).map(view => view.outcome),
        ['released'],
        'the receipt stays inspectable by exact task'
      )
      assert.deepEqual(await lifecycle.check(taskA), [])
      const again = await lifecycle.release(taskA)
      assert.deepEqual(again, [])
      assert.equal(releaseExitCode(again), 1)
    }
  )
  rmSync(join(repo, 'notes.log'))
  git(['checkout', '--quiet', '--', 'tracked.txt'], repo)

  const first = await allocateManaged(lifecycle, repo)
  const taskB = first.taskId
  const m1 = first.managed
  await claim(
    'a dirty delegated child without a recorded or derivable target is retained as integration-unknown with the missing target named',
    async () => {
      writeFileSync(join(m1.checkout, 'tracked.txt'), 'dirty child\n')
      const assessments = await lifecycle.check(taskB)
      const managed = only(assessments, m1.workspaceId)
      assert.deepEqual(
        [verdictName(managed.completion), managed.completion.role, managed.target.source],
        ['retained:integration-unknown', 'child', 'none']
      )
      assert.ok(
        managed.reasons.some(reason => reason.includes('no origin remote')),
        managed.reasons.join(' | ')
      )
      assert.equal(only(assessments, first.repoWorkspaceId).origin, 'pre-existing')
      git(['checkout', '--quiet', '--', 'tracked.txt'], m1.checkout)
    }
  )
  await claim(
    'installation coordination refuses concurrent exclusive cleanup ownership and keeps one stable lock inode',
    async () => {
      const home = join(sandbox, 'installation')
      mkdirSync(home)
      const options = { installationPath: home, namespacePath: root }
      const scope = Scope.makeUnsafe()
      let identity: number
      try {
        await Effect.runPromise(Scope.provide(scope)(acquireMaintenance(options)))
        identity = statSync(join(home, '.dev', 'coordination', 'installation.sqlite')).ino
        await assert.rejects(
          Effect.runPromise(Effect.scoped(acquireMaintenance(options))),
          /active/
        )
      } finally {
        await Effect.runPromise(Scope.close(scope, Exit.void))
      }
      await Effect.runPromise(Effect.scoped(acquireMaintenance(options)))
      assert.equal(
        statSync(join(home, '.dev', 'coordination', 'installation.sqlite')).ino,
        identity
      )
    }
  )
  await lifecycle.recordTarget(taskB, localMain)
  await claim(
    'a clean managed worktree at its base is finished as no-residue with the recorded target shown as an override, and a check removes nothing and leaves no live use',
    async () => {
      const managed = only(await lifecycle.check(taskB), m1.workspaceId)
      assert.equal(managed.evidence?.verdict, 'valid')
      assert.equal(verdictName(managed.completion), 'no-residue')
      assert.equal(managed.target.source, 'override')
      assert.ok(existsSync(m1.checkout), 'the check removed nothing')
      const uses = (await lifecycle.inspect({ taskId: taskB })).flatMap(view => view.uses)
      assert.ok(
        uses.every(use => use.stage === 'quiescent'),
        'a check leaves no live use'
      )
    }
  )
  await claim(
    'dev workspace release reports a Git-locked worktree as failed and keeps it while releasing the pre-existing checkout of the task; the unfinished release then holds the worktree back from resume and from the sweep',
    async () => {
      git(['worktree', 'lock', '--reason', 'fixture lock', '--', m1.checkout], repo)
      let results: readonly WorkspaceReleaseResult[]
      try {
        results = await lifecycle.release(taskB)
      } finally {
        git(['worktree', 'unlock', '--', m1.checkout], repo)
      }
      const locked = resultOf(results, m1.workspaceId)
      assert.equal(locked.outcome, 'failed', locked.reason)
      assert.ok(locked.reason.includes('locked'), locked.reason)
      assert.equal(resultOf(results, first.repoWorkspaceId).outcome, 'released')
      assert.equal(releaseExitCode(results), 1)
      const receipt = formatReleaseResults(taskB, results)
      assert.ok(receipt.includes(`${m1.checkout}: failed`), receipt)
      assert.ok(existsSync(join(m1.checkout, 'tracked.txt')), 'the locked worktree stays')
      const remaining = await lifecycle.check(taskB)
      assert.deepEqual(
        remaining.map(item => [item.workspaceId, verdictName(item.completion)]),
        [[m1.workspaceId, 'retained:release-review']]
      )
      await expectError(
        lifecycle.attach({
          conversation: conversation(),
          cwd: repo,
          selection: { taskId: taskB, workspaceId: m1.workspaceId },
        }),
        'review-required',
        [m1.workspaceId]
      )
    }
  )
  await claim(
    'dev workspace release deletes a managed worktree whatever its verdict, with its uncommitted and untracked contents, Git registration and reservation; the plan names what goes, the receipt stays inspectable by task, the repository list forgets it, a repeated release finds nothing and resume into it is refused',
    async () => {
      writeFileSync(join(m1.checkout, 'tracked.txt'), 'undelivered edit\n')
      writeFileSync(join(m1.checkout, 'scratch.txt'), 'untracked scratch\n')
      const plan = releasePlan(taskB, reservedViews(await lifecycle.inspect({ taskId: taskB })))
      assert.ok(plan.includes(m1.checkout), plan)
      assert.ok(plan.includes('the worktree and everything in it are deleted'), plan)
      const adminPath = git(['rev-parse', '--path-format=absolute', '--git-dir'], m1.checkout)
      const results = await lifecycle.release(taskB)
      assert.deepEqual(outcomes(results), [[m1.workspaceId, 'removed']])
      assert.ok(!existsSync(m1.checkout), 'the worktree directory is gone')
      assert.ok(!existsSync(adminPath), 'the Git registration is gone')
      assert.ok(!registered(repo).includes(m1.checkout))
      assert.equal(readFileSync(join(repo, 'tracked.txt'), 'utf8'), 'tracked\n')
      const receipts = await lifecycle.inspect({ taskId: taskB })
      assert.deepEqual(
        receipts.map(view => [view.workspaceId, view.outcome]).toSorted(),
        [
          [m1.workspaceId, 'removed'],
          [first.repoWorkspaceId, 'released'],
        ].toSorted()
      )
      assert.ok(
        !(await lifecycle.inspect({ cwd: repo })).some(view => view.workspaceId === m1.workspaceId),
        'the receipt does not clutter the repository list'
      )
      assert.deepEqual(await lifecycle.release(taskB), [])
      await expectError(
        lifecycle.attach({
          conversation: conversation(),
          cwd: repo,
          selection: { taskId: taskB, workspaceId: m1.workspaceId },
        }),
        'invalid',
        [taskB]
      )
    }
  )

  await claim(
    'an unreadable Git worktree list never authorizes deletion or confirms removal: a locked worktree, its files and registration stay until Git can be read and the lock is removed',
    async () => {
      const allocated = await allocateManaged(lifecycle, userCheckout())
      const { checkout, workspaceId } = allocated.managed
      const configPath = join(repo, '.git', 'config')
      const config = readFileSync(configPath)
      git(['worktree', 'lock', '--reason', 'keep while Git is unreadable', checkout], repo)
      let results: readonly WorkspaceReleaseResult[]
      try {
        writeFileSync(configPath, '[invalid\n')
        results = await lifecycle.release(allocated.taskId)
      } finally {
        writeFileSync(configPath, config)
      }
      assert.equal(resultOf(results, workspaceId).outcome, 'failed')
      assert.equal(readFileSync(join(checkout, 'tracked.txt'), 'utf8'), 'tracked\n')
      assert.ok(registered(repo).includes(checkout), 'the worktree is still registered')
      assert.ok(
        git(['worktree', 'list', '--porcelain'], repo).includes(
          'locked keep while Git is unreadable'
        ),
        'the Git lock survives the failed observation'
      )
      assert.equal(
        (await lifecycle.inspect({ taskId: allocated.taskId })).find(
          view => view.workspaceId === workspaceId
        )?.outcome,
        'review-required'
      )
      const locked = await lifecycle.release(allocated.taskId)
      assert.equal(resultOf(locked, workspaceId).outcome, 'failed')
      git(['worktree', 'unlock', checkout], repo)
      const released = await lifecycle.release(allocated.taskId)
      assert.equal(resultOf(released, workspaceId).outcome, 'removed')
      assert.ok(!existsSync(checkout))
    }
  )

  const third = await allocateManaged(lifecycle, repo)
  const taskC = third.taskId
  const m3 = third.managed
  await lifecycle.recordTarget(taskC, localMain)
  const deliveredC = deliverBranch(m3.checkout)
  const assessmentOf = async (workspaceId: WorkspaceId, taskId: WorkspaceId) =>
    only(await lifecycle.check(taskId), workspaceId)
  await claim(
    'on a branch whose commits are in the target, dirty tracked residue and unselected reports leave it finished, but an unintegrated local commit retains it as not integrated',
    async () => {
      writeFileSync(join(m3.checkout, 'tracked.txt'), 'dirty\n')
      let managed = await assessmentOf(m3.workspaceId, taskC)
      assert.equal(verdictName(managed.completion), 'branch-in-target', managed.reasons.join(' | '))
      assert.equal(managed.evidence?.verdict, 'valid')
      assert.equal(managed.inventory?.trackedChanges, 1)
      git(['checkout', '--quiet', '--', 'tracked.txt'], m3.checkout)

      writeFileSync(join(m3.checkout, 'feature.txt'), 'feature\n')
      git(['add', 'feature.txt'], m3.checkout)
      git(['commit', '--quiet', '-m', 'unintegrated'], m3.checkout)
      const unintegrated = git(['rev-parse', 'HEAD'], m3.checkout)
      managed = await assessmentOf(m3.workspaceId, taskC)
      assert.equal(verdictName(managed.completion), 'retained:not-integrated')
      writeFileSync(join(m3.checkout, 'tracked.txt'), 'residue beside the unintegrated commit\n')
      managed = await assessmentOf(m3.workspaceId, taskC)
      assert.equal(managed.evidence?.verdict, 'valid')
      assert.equal(verdictName(managed.completion), 'retained:not-integrated')
      assert.ok(
        managed.reasons.some(
          reason =>
            reason.includes(unintegrated.slice(0, 12)) && reason.includes(deliveredC.slice(0, 12))
        ),
        managed.reasons.join(' | ')
      )
      git(['reset', '--quiet', '--hard', deliveredC], m3.checkout)

      writeFileSync(join(m3.checkout, 'report.txt'), 'evidence report\n')
      managed = await assessmentOf(m3.workspaceId, taskC)
      assert.equal(verdictName(managed.completion), 'branch-in-target', managed.reasons.join(' '))
      assert.ok((managed.inventory?.disposable ?? 0) >= 1)
    }
  )
  await claim(
    'a recorded publication whose bytes match the local file covers it without any download; changed local bytes make the evidence invalid until the current bytes are published',
    async () => {
      await lifecycle.recordPublication(
        publication(
          taskC,
          m3.workspaceId,
          'report.txt',
          readFileSync(join(m3.checkout, 'report.txt'))
        )
      )
      let managed = await assessmentOf(m3.workspaceId, taskC)
      assert.equal(managed.evidence?.verdict, 'valid', managed.reasons.join(' '))
      assert.equal(managed.inventory?.published, 1)
      writeFileSync(join(m3.checkout, 'report.txt'), 'evidence report, amended\n')
      managed = await assessmentOf(m3.workspaceId, taskC)
      assert.equal(managed.evidence?.verdict, 'invalid')
      assert.ok(
        managed.reasons.some(
          reason => reason.includes(PUBLISHED_URL) && reason.includes('report.txt')
        ),
        managed.reasons.join(' | ')
      )
      rmSync(join(m3.checkout, 'report.txt'))
      symlinkSync(join(sandbox, 'unpublished-target'), join(m3.checkout, 'report.txt'))
      managed = await assessmentOf(m3.workspaceId, taskC)
      assert.equal(
        managed.evidence?.verdict,
        'invalid',
        'a recorded report replaced by a link is not disposable residue'
      )
      rmSync(join(m3.checkout, 'report.txt'))
      writeFileSync(join(m3.checkout, 'report.txt'), 'evidence report\n')
      const trackedReport = readFileSync(join(m3.checkout, '.gitignore'))
      await lifecycle.recordPublication(
        publication(taskC, m3.workspaceId, '.gitignore', trackedReport)
      )
      writeFileSync(join(m3.checkout, '.gitignore'), `${trackedReport.toString()}changed\n`)
      managed = await assessmentOf(m3.workspaceId, taskC)
      assert.equal(
        managed.evidence?.verdict,
        'invalid',
        'a changed tracked publication is not disposable residue'
      )
      writeFileSync(join(m3.checkout, '.gitignore'), trackedReport)
    }
  )
  await claim(
    'unselected ignored and sensitive-looking files are disposable, while nested repositories make the evidence invalid',
    async () => {
      mkdirSync(join(m3.checkout, 'build', 'sub'), { recursive: true })
      writeFileSync(join(m3.checkout, 'build', 'a.o'), 'object a')
      writeFileSync(join(m3.checkout, 'build', 'sub', 'b.o'), 'object b')
      writeFileSync(join(m3.checkout, 'build', 'credentials-provider.js'), 'local dependency')
      let managed = await assessmentOf(m3.workspaceId, taskC)
      assert.equal(managed.evidence?.verdict, 'valid', managed.reasons.join(' '))
      assert.equal(managed.inventory?.disposable, 3)

      writeFileSync(join(sandbox, 'outside.txt'), 'outside the worktree\n')
      symlinkSync(join(sandbox, 'outside.txt'), join(m3.checkout, 'build', 'link'))
      managed = await assessmentOf(m3.workspaceId, taskC)
      assert.equal(managed.evidence?.verdict, 'valid', managed.reasons.join(' '))
      assert.equal(managed.inventory?.disposable, 4)

      mkdirSync(join(m3.checkout, 'vendor'))
      git(['init', '--quiet'], join(m3.checkout, 'vendor'))
      writeFileSync(join(m3.checkout, 'vendor', 'v.txt'), 'v')
      managed = await assessmentOf(m3.workspaceId, taskC)
      assert.equal(managed.evidence?.verdict, 'invalid')
      const nested = managed.reasons.join(' | ')
      assert.ok(nested.includes('vendor/') && !nested.includes('vendor/v.txt'), nested)
      rmSync(join(m3.checkout, 'vendor'), { recursive: true, force: true })
    }
  )
  await claim(
    'tracked submodules and replaced tracked ancestors leave the residue unreadable without reading or changing external content',
    async () => {
      git(['update-index', '--add', '--cacheinfo', `160000,${mainCommit},module`], m3.checkout)
      let managed = await assessmentOf(m3.workspaceId, taskC)
      assert.equal(verdictName(managed.completion), 'retained:residue-unreadable')
      assert.ok(
        managed.reasons.some(reason => reason.includes('module')),
        managed.reasons.join(' ')
      )
      git(['reset', '--quiet', 'HEAD', '--', 'module'], m3.checkout)
      mkdirSync(join(m3.checkout, 'tracked-parent'))
      writeFileSync(join(m3.checkout, 'tracked-parent', 'file.txt'), 'tracked fixture\n')
      git(['add', 'tracked-parent/file.txt'], m3.checkout)
      rmSync(join(m3.checkout, 'tracked-parent'), { recursive: true })
      const outside = join(sandbox, 'tracked-outside')
      mkdirSync(outside)
      writeFileSync(join(outside, 'file.txt'), 'external sentinel\n')
      symlinkSync(outside, join(m3.checkout, 'tracked-parent'))
      managed = await assessmentOf(m3.workspaceId, taskC)
      assert.equal(verdictName(managed.completion), 'retained:residue-unreadable')
      assert.ok(
        managed.reasons.some(reason => reason.includes('tracked-parent')),
        managed.reasons.join(' ')
      )
      assert.equal(readFileSync(join(outside, 'file.txt'), 'utf8'), 'external sentinel\n')
      rmSync(join(m3.checkout, 'tracked-parent'))
      git(['reset', '--quiet', 'HEAD', '--', 'tracked-parent/file.txt'], m3.checkout)
    }
  )
  await claim(
    'Git state inspection does not execute configured diff or textconv commands and refuses checkout filters',
    async () => {
      const sentinel = join(sandbox, 'git-command-executed')
      const command = `touch "${sentinel}"`
      const attributes = join(m3.checkout, '.gitattributes')
      git(['config', 'diff.tripwire.command', command], m3.checkout)
      git(['config', 'diff.tripwire.textconv', command], m3.checkout)
      writeFileSync(attributes, 'tracked.txt diff=tripwire\n')
      writeFileSync(join(m3.checkout, 'tracked.txt'), 'changed for diff\n')
      let managed = await assessmentOf(m3.workspaceId, taskC)
      assert.equal(verdictName(managed.completion), 'branch-in-target', managed.reasons.join(' '))
      assert.ok(!existsSync(sentinel))
      git(['config', 'filter.tripwire.clean', command], m3.checkout)
      writeFileSync(attributes, 'tracked.txt filter=tripwire\n')
      managed = await assessmentOf(m3.workspaceId, taskC)
      assert.equal(verdictName(managed.completion), 'retained:residue-unreadable')
      assert.ok(
        managed.reasons.some(reason => reason.includes('filter')),
        managed.reasons.join(' ')
      )
      assert.ok(!existsSync(sentinel))
      rmSync(attributes)
      git(['config', '--unset', 'diff.tripwire.command'], m3.checkout)
      git(['config', '--unset', 'diff.tripwire.textconv'], m3.checkout)
      git(['config', '--unset', 'filter.tripwire.clean'], m3.checkout)
      git(['checkout', '--quiet', '--', 'tracked.txt'], m3.checkout)
    }
  )
  await claim(
    'a live reader in the managed worktree retains it as a live use until the reader closes',
    async () => {
      const reader = await lifecycle.attach({
        conversation: conversation(),
        cwd: repo,
        selection: { taskId: taskC, workspaceId: m3.workspaceId },
      })
      ready(await reader.authorize({ kind: 'read' }))
      assert.equal(
        verdictName((await assessmentOf(m3.workspaceId, taskC)).completion),
        'retained:use-live'
      )
      await reader.close()
      assert.equal(
        verdictName((await assessmentOf(m3.workspaceId, taskC)).completion),
        'branch-in-target'
      )
    }
  )
  await claim(
    'dev workspace release removes a finished worktree with its published report, staged and dirty tracked residue and untracked files, leaving an external symlink target unchanged',
    async () => {
      writeFileSync(join(m3.checkout, 'tracked.txt'), 'reconciled intermediate content\n')
      git(['add', 'tracked.txt'], m3.checkout)
      writeFileSync(join(m3.checkout, 'tracked.txt'), 'uncommitted intermediate residue\n')
      const results = await lifecycle.release(taskC)
      assert.deepEqual(
        outcomes(results).toSorted(),
        [
          [m3.workspaceId, 'removed'],
          [third.repoWorkspaceId, 'released'],
        ].toSorted()
      )
      assert.equal(readFileSync(join(sandbox, 'outside.txt'), 'utf8'), 'outside the worktree\n')
      assert.ok(!existsSync(m3.checkout))
      assert.ok(!registered(repo).includes(m3.checkout))
    }
  )

  await claim(
    'recording the same publication twice keeps one fact whose columns and payload agree, and an option-shaped remote name is refused at the authority boundary before any Git call',
    async () => {
      const allocated = await allocateManaged(lifecycle, userCheckout())
      await lifecycle.recordTarget(allocated.taskId, localMain)
      const { checkout } = allocated.managed
      deliverBranch(checkout)
      writeFileSync(join(checkout, 'twice.txt'), 'published twice\n')
      const bytes = readFileSync(join(checkout, 'twice.txt'))
      await lifecycle.recordPublication(
        publication(allocated.taskId, allocated.managed.workspaceId, 'twice.txt', bytes)
      )
      await lifecycle.recordPublication(
        publication(allocated.taskId, allocated.managed.workspaceId, 'twice.txt', bytes)
      )
      const managed = only(await lifecycle.check(allocated.taskId), allocated.managed.workspaceId)
      assert.equal(verdictName(managed.completion), 'branch-in-target', managed.reasons.join(' '))
      assert.equal(managed.inventory?.published, 1)
      await expectError(
        lifecycle.recordTarget(allocated.taskId, {
          kind: 'remote',
          remote: '--upload-pack=sh -c "echo INJECTED >&2; exit 1"',
          ref: 'refs/heads/main',
        } as TaskTarget),
        'invalid'
      )
      assert.equal(
        verdictName(
          only(await lifecycle.check(allocated.taskId), allocated.managed.workspaceId).completion
        ),
        'branch-in-target'
      )
      const results = await lifecycle.release(allocated.taskId)
      assert.equal(resultOf(results, allocated.managed.workspaceId).outcome, 'removed')
    }
  )

  const faultyWorker =
    (fault: ReleaseFault, checkout: string): StartWorkspaceWorker =>
    (url, options) =>
      new Worker(url, {
        ...options,
        execArgv: [...(options.execArgv ?? []), '--import', FAULT_PRELOAD],
        env: { ...process.env, DEV_RELEASE_FAULT: fault, DEV_RELEASE_FAULT_CHECKOUT: checkout },
      })
  const crashed = async (fault: ReleaseFault) => {
    const allocated = await allocateManaged(lifecycle, userCheckout())
    await lifecycle.recordTarget(allocated.taskId, localMain)
    writeFileSync(join(allocated.managed.checkout, 'tracked.txt'), 'undelivered edit\n')
    const faulty = await openLifecycle({
      root,
      startWorker: faultyWorker(fault, allocated.managed.checkout),
    })
    await expectError(faulty.release(allocated.taskId), 'unavailable')
    await faulty.close()
    return allocated
  }
  const viewOf = async (taskId: WorkspaceId, workspaceId: WorkspaceId) =>
    (await lifecycle.inspect({ taskId })).find(item => item.workspaceId === workspaceId)
  await claim(
    'a crash after the removal was recorded as started but before Git ran deletes nothing and leaves the release unfinished for inspect, check and resume; the next dev workspace release removes the worktree and closes the attempt',
    async () => {
      const { taskId, managed } = await crashed('before-git-remove')
      assert.equal(
        readFileSync(join(managed.checkout, 'tracked.txt'), 'utf8'),
        'undelivered edit\n',
        'nothing was deleted'
      )
      const view = await viewOf(taskId, managed.workspaceId)
      assert.equal(view?.outcome, 'review-required')
      assert.deepEqual(
        view?.pending.map(item => [item.kind, item.stage]),
        [['release', 'started']]
      )
      assert.equal(
        verdictName(only(await lifecycle.check(taskId), managed.workspaceId).completion),
        'retained:release-review'
      )
      await expectError(
        lifecycle.attach({
          conversation: conversation(),
          cwd: repo,
          selection: { taskId, workspaceId: managed.workspaceId },
        }),
        'review-required',
        [managed.workspaceId]
      )
      const results = await lifecycle.release(taskId)
      assert.equal(resultOf(results, managed.workspaceId).outcome, 'removed')
      assert.ok(!existsSync(managed.checkout))
      const receipts = (await lifecycle.inspect({ taskId })).filter(
        item => item.workspaceId === managed.workspaceId
      )
      assert.deepEqual(
        receipts.map(item => [item.outcome, item.pending.length]),
        [['removed', 0]],
        'the interrupted attempt is closed'
      )
    }
  )
  await claim(
    'a crash after Git removed the worktree but before the outcome was recorded leaves the release unfinished, and the next dev workspace release records the removal',
    async () => {
      const { taskId, managed } = await crashed('after-git-remove')
      assert.ok(!existsSync(managed.checkout), 'Git removed the directory')
      assert.ok(!registered(repo).includes(managed.checkout))
      const view = await viewOf(taskId, managed.workspaceId)
      assert.equal(view?.outcome, 'review-required')
      assert.deepEqual(
        view?.pending.map(item => [item.kind, item.stage]),
        [['release', 'started']]
      )
      const results = await lifecycle.release(taskId)
      assert.equal(resultOf(results, managed.workspaceId).outcome, 'removed')
      assert.deepEqual(await lifecycle.check(taskId), [])
      assert.equal((await viewOf(taskId, managed.workspaceId))?.outcome, 'removed')
    }
  )
  await claim(
    'retrying a removal interrupted after Git deleted the worktree preserves its recorded HEAD for the remaining child’s sibling PR search',
    async () => {
      const siblingRepo = join(sandbox, 'recovered-sibling-repo')
      const base = initRepository(siblingRepo)
      const owner = await lifecycle.attach({ conversation: conversation(), cwd: siblingRepo })
      ready(await owner.authorize({ kind: 'write' }))
      const child = ready(await owner.authorize({ kind: 'delegated-write' }))
      const taskId = requireTask(child.taskId)
      writeFileSync(join(child.checkout, 'pending.txt'), 'unfinished child\n')
      const sibling = ready(await owner.authorize({ kind: 'delegated-write' }))
      writeFileSync(join(sibling.checkout, 'feature.txt'), 'delivered sibling\n')
      git(['add', 'feature.txt'], sibling.checkout)
      git(['commit', '--quiet', '-m', 'sibling feature'], sibling.checkout)
      const head = git(['rev-parse', 'HEAD'], sibling.checkout)
      await owner.close()
      await lifecycle.recordTarget(taskId, {
        kind: 'github',
        repository: 'owner/recovered-sibling',
        ref: 'refs/heads/main',
      })
      const searched: string[] = []
      const reader: GitHubReader = {
        defaultBranch: () => 'main',
        refTip: () => base,
        pullRequest: () => 'missing',
        pullRequestCommits: () => [],
        mergedPullRequestsForCommit: (_repository, sha) => {
          searched.push(sha)
          return []
        },
        compare: () => ({ unavailable: 'unexpected comparison of local history' }),
      }
      const authority = new WorkspaceAuthority(root)
      git(['worktree', 'lock', child.checkout], siblingRepo)
      try {
        checkTask(authority, taskId, { github: reader })
        assert.ok(searched.includes(head), 'the live sibling supplies its own HEAD')
        const faulty = await openLifecycle({
          root,
          startWorker: faultyWorker('after-git-remove', sibling.checkout),
        })
        try {
          await expectError(faulty.release(taskId), 'unavailable')
        } finally {
          await faulty.close()
        }
        assert.ok(!existsSync(sibling.checkout), 'Git removed the sibling before the crash')
        const results = await lifecycle.release(taskId)
        assert.equal(resultOf(results, sibling.workspaceId).outcome, 'removed')
        assert.equal(resultOf(results, child.workspaceId).outcome, 'failed')
        searched.length = 0
        checkTask(authority, taskId, { github: reader })
        assert.ok(
          searched.includes(head),
          'the confirmed removal still supplies the sibling HEAD to the PR search'
        )
      } finally {
        authority.close()
        git(['worktree', 'unlock', child.checkout], siblingRepo)
        await lifecycle.release(taskId)
      }
    }
  )

  await claim(
    'when Git deletes the worktree directory but cannot remove its admin directory, release reports what remains as failed; the next release removes exactly that registration without pruning another one',
    async () => {
      const allocated = await allocateManaged(lifecycle, userCheckout())
      await lifecycle.recordTarget(allocated.taskId, localMain)
      const { checkout, workspaceId } = allocated.managed
      const adminPath = git(['rev-parse', '--path-format=absolute', '--git-dir'], checkout)
      const admins = join(repo, '.git', 'worktrees')
      const { mode } = statSync(admins)
      chmodSync(admins, 0o500)
      let results: readonly WorkspaceReleaseResult[]
      try {
        results = await lifecycle.release(allocated.taskId)
      } finally {
        chmodSync(admins, mode)
      }
      const stopped = resultOf(results, workspaceId)
      assert.equal(stopped.outcome, 'failed', stopped.reason)
      assert.ok(stopped.reason.includes(adminPath), stopped.reason)
      assert.ok(!existsSync(checkout))
      assert.equal(
        verdictName(only(await lifecycle.check(allocated.taskId), workspaceId).completion),
        'retained:release-review'
      )
      const foreign = join(sandbox, `foreign-${workspaceId}`)
      git(['worktree', 'add', '--quiet', '--detach', foreign, 'HEAD'], repo)
      const foreignAdmin = git(['rev-parse', '--path-format=absolute', '--git-dir'], foreign)
      rmSync(foreign, { recursive: true, force: true })
      const settled = await lifecycle.release(allocated.taskId)
      assert.equal(resultOf(settled, workspaceId).outcome, 'removed')
      assert.ok(!existsSync(adminPath))
      assert.ok(existsSync(foreignAdmin), 'the foreign prunable registration was not pruned')
      git(['worktree', 'prune'], repo)
    }
  )
  await claim(
    'when Git cannot delete the worktree directory itself, release reports it as failed, and once the cause is fixed the next release deletes what remains of the dev-owned directory',
    async () => {
      const allocated = await allocateManaged(lifecycle, userCheckout())
      await lifecycle.recordTarget(allocated.taskId, localMain)
      const { checkout, workspaceId } = allocated.managed
      const parent = dirname(checkout)
      const { mode } = statSync(parent)
      chmodSync(parent, 0o500)
      let results: readonly WorkspaceReleaseResult[]
      try {
        results = await lifecycle.release(allocated.taskId)
      } finally {
        chmodSync(parent, mode)
      }
      assert.equal(resultOf(results, workspaceId).outcome, 'failed')
      assert.ok(existsSync(checkout), 'the directory itself remains')
      const settled = await lifecycle.release(allocated.taskId)
      assert.equal(resultOf(settled, workspaceId).outcome, 'removed')
      assert.ok(!existsSync(checkout))
      assert.ok(!registered(repo).includes(checkout))
    }
  )
  await claim(
    'a managed worktree the user moved with git worktree move is retained as directory-missing and forgotten by release, which never touches the moved worktree or its registration',
    async () => {
      const allocated = await allocateManaged(lifecycle, userCheckout())
      await lifecycle.recordTarget(allocated.taskId, localMain)
      const { checkout, workspaceId } = allocated.managed
      const adminPath = git(['rev-parse', '--path-format=absolute', '--git-dir'], checkout)
      const head = git(['rev-parse', 'HEAD'], checkout)
      const moved = join(sandbox, `moved-${workspaceId}`)
      git(['worktree', 'move', checkout, moved], repo)
      assert.equal(
        verdictName(only(await lifecycle.check(allocated.taskId), workspaceId).completion),
        'retained:directory-missing'
      )
      const results = await lifecycle.release(allocated.taskId)
      assert.equal(resultOf(results, workspaceId).outcome, 'removed')
      assert.ok(existsSync(adminPath), 'the moved worktree keeps its admin directory')
      assert.ok(registered(repo).includes(moved), 'the moved worktree is still registered')
      assert.equal(git(['rev-parse', 'HEAD'], moved), head, 'the moved worktree is intact')
      git(['worktree', 'remove', '--force', moved], repo)
    }
  )

  await claim(
    'release never deletes through a symbolic link: with the managed root of a repository replaced by a link, a worktree Git no longer lists keeps its contents and release fails; restored, the next release removes it',
    async () => {
      const linkRepo = join(sandbox, 'link-repo')
      initRepository(linkRepo)
      const allocated = await allocateManaged(lifecycle, userCheckout(linkRepo))
      const { checkout, workspaceId } = allocated.managed
      writeFileSync(join(checkout, 'sentinel.txt'), 'reached through a link\n')
      rmSync(git(['rev-parse', '--path-format=absolute', '--git-dir'], checkout), {
        recursive: true,
        force: true,
      })
      assert.ok(!registered(linkRepo).includes(checkout), 'Git no longer lists the worktree')
      const managedRoot = dirname(checkout)
      const relocated = join(sandbox, 'relocated-managed-root')
      renameSync(managedRoot, relocated)
      symlinkSync(relocated, managedRoot)
      let results: readonly WorkspaceReleaseResult[]
      try {
        results = await lifecycle.release(allocated.taskId)
      } finally {
        rmSync(managedRoot)
        renameSync(relocated, managedRoot)
      }
      const refused = resultOf(results, workspaceId)
      assert.equal(refused.outcome, 'failed', refused.reason)
      assert.ok(refused.reason.includes('symbolic link'), refused.reason)
      assert.equal(
        readFileSync(join(managedRoot, basename(checkout), 'sentinel.txt'), 'utf8'),
        'reached through a link\n'
      )
      const settled = await lifecycle.release(allocated.taskId)
      assert.equal(resultOf(settled, workspaceId).outcome, 'removed')
      assert.ok(!existsSync(checkout))
    }
  )

  const installRepo = join(sandbox, 'install-repo')
  initRepository(installRepo)
  const sweepRow = async (anchor: WorkspaceId, workspaceId: WorkspaceId) => {
    const receipt: SweepReceipt = await lifecycle.sweep({
      anchorWorkspaceId: anchor,
      delegatedCwds: [],
      occupiedPaths: [],
    })
    const row = receipt.rows.find(
      item => item.kind === 'workspace' && item.workspaceId === workspaceId
    )
    if (row?.kind !== 'workspace')
      throw new Error(`no sweep row for ${workspaceId}: ${JSON.stringify(receipt)}`)
    return { row, receipt }
  }
  await claim(
    'the sweep retains a finished worktree whose installation coordination is a symlink as unverifiable and deletes nothing, while dev workspace release removes it without touching the link target',
    async () => {
      for (const relative of ['.dev', '.dev/coordination']) {
        const source = await allocateManaged(lifecycle, userCheckout(installRepo))
        await lifecycle.recordTarget(source.taskId, localMain)
        deliverBranch(source.managed.checkout, installRepo)
        const outside = mkdtempSync(join(sandbox, 'linked-coordination-'))
        writeFileSync(join(outside, 'sentinel'), 'outside coordination stays untouched')
        const link = join(source.managed.checkout, relative)
        mkdirSync(dirname(link), { recursive: true })
        symlinkSync(outside, link)
        const { row } = await sweepRow(source.managed.workspaceId, source.managed.workspaceId)
        assert.equal(row.verdict.kind, 'finished', row.reason)
        assert.equal(row.outcome, 'retained', row.reason)
        assert.match(row.reason, /Target installation coordination/)
        assert.ok(existsSync(link), 'the sweep deleted nothing')
        const results = await lifecycle.release(source.taskId)
        assert.equal(resultOf(results, source.managed.workspaceId).outcome, 'removed')
        assert.equal(
          readFileSync(join(outside, 'sentinel'), 'utf8'),
          'outside coordination stays untouched'
        )
      }
    }
  )
  await claim(
    'the sweep keeps a managed installation protected independently of cwd while an unrelated finished worktree is removed, startup cannot split the removal gate or recreate a removed installation, and dev workspace release still removes it',
    async () => {
      const source = await allocateManaged(lifecycle, userCheckout(installRepo))
      await lifecycle.recordTarget(source.taskId, localMain)
      deliverBranch(source.managed.checkout, installRepo)
      const options = { installationPath: source.managed.checkout, namespacePath: root }
      const dataHome = join(sandbox, 'source-session-outside-checkout')
      const scope = Scope.makeUnsafe()
      const database = join(source.managed.checkout, '.dev', 'coordination', 'installation.sqlite')
      const sourceRow = async () =>
        (await sweepRow(source.managed.workspaceId, source.managed.workspaceId)).row
      try {
        await Effect.runPromise(Scope.provide(scope)(acquireRuntime(dataHome, options)))
        const identity = statSync(database).ino
        const unrelated = await allocateManaged(lifecycle, userCheckout(installRepo))
        await lifecycle.recordTarget(unrelated.taskId, localMain)
        const swept = await sweepRow(source.managed.workspaceId, source.managed.workspaceId)
        assert.equal(swept.row.outcome, 'retained', swept.row.reason)
        assert.equal(statSync(database).ino, identity)
        const removed = swept.receipt.rows.find(
          item => item.kind === 'workspace' && item.workspaceId === unrelated.managed.workspaceId
        )
        assert.equal(removed?.kind === 'workspace' && removed.outcome, 'removed')
        assert.ok(existsSync(source.managed.checkout))
        await assert.rejects(
          Effect.runPromise(Effect.scoped(acquireMaintenance(options))),
          /active/
        )
      } finally {
        await Effect.runPromise(Scope.close(scope, Exit.void))
      }
      const removal = acquirePathGates(authorityPaths(root), source.managed.checkout, 'removal')
      try {
        const before = statSync(database).ino
        await assert.rejects(Effect.runPromise(Effect.scoped(acquireRuntime(dataHome, options))))
        await assert.rejects(Effect.runPromise(Effect.scoped(acquireMaintenance(options))))
        assert.equal(statSync(database).ino, before)
      } finally {
        releaseGates(removal)
      }
      const unexpectedScope = Scope.makeUnsafe()
      try {
        await Effect.runPromise(
          Scope.provide(unexpectedScope)(
            acquireRuntime(dataHome, {
              ...options,
              namespacePath: join(sandbox, 'other-namespace'),
            })
          )
        )
        const blocked = await sourceRow()
        assert.equal(blocked.outcome, 'retained', blocked.reason)
        assert.match(blocked.reason, /Target installation coordination/)
        assert.ok(existsSync(database))
      } finally {
        await Effect.runPromise(Scope.close(unexpectedScope, Exit.void))
      }
      const maintenance = Scope.makeUnsafe()
      try {
        await Effect.runPromise(Scope.provide(maintenance)(acquireMaintenance(options)))
        const blocked = await sourceRow()
        assert.equal(blocked.outcome, 'retained', blocked.reason)
      } finally {
        await Effect.runPromise(Scope.close(maintenance, Exit.void))
      }
      const saved = join(sandbox, 'saved-installation.sqlite')
      renameSync(database, saved)
      try {
        const blocked = await sourceRow()
        assert.equal(blocked.outcome, 'retained', blocked.reason)
        assert.equal(
          existsSync(database),
          false,
          'cleanup must not recreate an uncertain installation lock'
        )
      } finally {
        renameSync(saved, database)
      }
      const results = await lifecycle.release(source.taskId)
      assert.equal(resultOf(results, source.managed.workspaceId).outcome, 'removed')
      await assert.rejects(Effect.runPromise(Effect.scoped(acquireRuntime(dataHome, options))))
      await assert.rejects(Effect.runPromise(Effect.scoped(acquireMaintenance(options))))
      assert.equal(existsSync(source.managed.checkout), false)
      mkdirSync(source.managed.checkout)
      await assert.rejects(
        Effect.runPromise(Effect.scoped(acquireRuntime(dataHome, options))),
        /authority record/
      )
      assert.equal(existsSync(join(source.managed.checkout, '.dev')), false)
      rmSync(source.managed.checkout, { recursive: true })
      assert.ok(
        existsSync(dataHome),
        'the installation source lease did not authorize deleting external runtime data'
      )
    }
  )

  const github = join(sandbox, 'github-repo')
  const githubMain = initRepository(github)
  git(['checkout', '--quiet', '-b', 'feature'], github)
  writeFileSync(join(github, 'feature.txt'), 'feature\n')
  git(['add', 'feature.txt'], github)
  git(['commit', '--quiet', '-m', 'feature'], github)
  const feature = git(['rev-parse', 'HEAD'], github)
  git(['checkout', '--quiet', 'main'], github)
  git(['merge', '--quiet', '--squash', feature], github)
  git(['commit', '--quiet', '-m', 'squash'], github)

  git(['branch', '--quiet', '-D', 'feature'], github)
  const squash = git(['rev-parse', 'HEAD'], github)
  const worktree = join(sandbox, 'github-wt')
  git(['worktree', 'add', '--quiet', '--detach', worktree, feature], github)
  git(['checkout', '--quiet', '-b', 'source-extension', feature], github)
  writeFileSync(join(github, 'extension.txt'), 'extension\n')
  git(['add', 'extension.txt'], github)
  git(['commit', '--quiet', '-m', 'source extension'], github)
  const extendedSource = git(['rev-parse', 'HEAD'], github)
  git(['checkout', '--quiet', 'main'], github)
  const unknownSha = 'f'.repeat(40)
  const pull = (overrides: Partial<GitHubPullRequest> = {}): GitHubPullRequest => ({
    merged: true,
    mergedAt: MERGED_AT,
    mergeCommit: squash,
    headSha: feature,
    headRepository: 'owner/repo',
    baseRepository: 'owner/repo',
    baseRef: 'main',
    commits: 1,
    ...overrides,
  })
  const reader = (
    overrides: Partial<GitHubReader> = {},
    pullOverrides: Partial<GitHubPullRequest> = {}
  ): GitHubReader => ({
    defaultBranch: () => 'main',
    refTip: () => squash,
    pullRequest: () => pull(pullOverrides),
    pullRequestCommits: () => [feature],
    mergedPullRequestsForCommit: (_repository, sha) => (sha === feature ? [7] : []),
    compare: (_repository, base, head) =>
      base === squash && head === squash ? 'identical' : 'diverged',
    ...overrides,
  })
  const target: TaskTarget = { kind: 'github', repository: 'owner/repo', ref: 'refs/heads/main' }
  const prove = (provider: GitHubReader, source = feature, targetOverride: TaskTarget = target) => {
    const verdict = decideCompletion(
      managedFacts({
        allocation: 'checkout-contention',
        branch: 'refs/heads/feature',
        residue: { tracked: 1, untracked: 0, ignored: 0 },
        ownCommits: true,
        integration: integrationFacts(provider, worktree, {
          target: targetOverride,
          head: source,
          base: undefined,
          allocatedAt: undefined,
          siblings: { heads: [], unknown: [] },
        }),
      })
    )
    return { outcome: verdictName(verdict), reason: verdict.reason }
  }
  await claim(
    'GitHub calls of one request share a time budget and ask an identical read once: each call gets what is left, a spent budget answers unavailable without calling, and integration is then unknown instead of outlasting the worker request',
    () => {
      let now = 0
      const timeouts: number[] = []
      const slow = makeGitHubReader(
        (_endpoint, timeoutMs) => {
          timeouts.push(timeoutMs)
          now += 20_000
          throw new Error('gh api timed out')
        },
        30_000,
        () => now
      )
      for (const ref of ['refs/heads/a', 'refs/heads/b', 'refs/heads/c'])
        assert.ok(isUnavailable(slow.refTip('owner/repo', ref)))
      assert.deepEqual(timeouts, [30_000, 10_000], 'the third read was never asked')
      let asked = 0
      const counted = makeGitHubReader(
        () => {
          asked += 1
          return { status: 'ok', text: JSON.stringify({ object: { sha: feature } }) }
        },
        30_000,
        () => 0
      )
      assert.equal(counted.refTip('owner/repo', 'refs/heads/main'), feature)
      assert.equal(counted.refTip('owner/repo', 'refs/heads/main'), feature)
      assert.equal(asked, 1, 'the identical read was asked once')
      const given: number[] = []
      makeGitHubReader((_endpoint, timeoutMs) => {
        given.push(timeoutMs)
        return { status: 'ok', text: JSON.stringify({ object: { sha: feature } }) }
      }).refTip('owner/repo', 'refs/heads/main')
      assert.ok(
        given.length === 1 && given.every(timeout => Number.isInteger(timeout) && timeout >= 1),
        `the default clock gives each call a whole, nonzero timeout: ${given.join(', ')}`
      )
      const spent = makeGitHubReader(() => {
        throw new Error('a spent budget makes no call')
      }, 0)
      assert.equal(prove(spent).outcome, 'retained:integration-unknown')
    }
  )
  await claim(
    'a squash-merged pull request proves integration only with the exact source-at-merge binding, including after a cached async prefetch; wrong bindings are rejected and unavailable or expired evidence remains unknown',
    async () => {
      assert.equal(prove(reader()).outcome, 'branch-merged', prove(reader()).reason)
      assert.equal(
        prove(
          reader(
            { pullRequestCommits: () => [feature, extendedSource] },
            { headSha: extendedSource, commits: 2 }
          ),
          feature
        ).outcome,
        'branch-merged',
        'an earlier local source commit is covered when proven an ancestor of the bound merged source'
      )
      const bound = prove(reader()).reason
      assert.ok(bound.includes('owner/repo#7') && bound.includes(feature.slice(0, 12)), bound)
      assert.equal(prove(reader({}, { baseRef: 'release' })).outcome, 'retained:not-integrated')
      assert.equal(
        prove(reader({}, { headRepository: 'fork/repo' })).outcome,
        'retained:not-integrated'
      )
      assert.ok(prove(reader({}, { headRepository: 'fork/repo' })).reason.includes('fork/repo'))
      assert.equal(
        prove(reader({ pullRequestCommits: () => [githubMain] }, { headSha: githubMain })).outcome,
        'retained:not-integrated',
        'a pull request whose merged head is another commit does not cover this worktree'
      )
      assert.equal(
        prove(reader({ pullRequestCommits: () => [feature, githubMain] })).outcome,
        'retained:integration-unknown',
        'provider facts that disagree on the merged head bind nothing'
      )
      assert.equal(
        prove(reader({}, { headRepository: undefined })).outcome,
        'retained:integration-unknown',
        'a deleted source repository leaves the merged source unresolved'
      )
      assert.equal(
        prove(reader({}, { mergeCommit: unknownSha })).outcome,
        'retained:not-integrated'
      )
      assert.equal(prove(reader({}, { merged: false })).outcome, 'retained:not-integrated')
      assert.equal(
        prove(reader({ mergedPullRequestsForCommit: () => [] })).outcome,
        'retained:not-integrated'
      )
      assert.equal(
        prove(reader({ pullRequest: () => ({ unavailable: 'rate limited' }) })).outcome,
        'retained:integration-unknown'
      )
      assert.equal(
        prove(reader({ refTip: () => ({ unavailable: 'offline' }) })).outcome,
        'retained:integration-unknown'
      )
      assert.equal(prove(reader({}, { commits: 251 })).outcome, 'retained:integration-unknown')
      assert.equal(
        prove(reader({ mergedPullRequestsForCommit: () => ({ unavailable: 'offline' }) })).outcome,
        'retained:integration-unknown'
      )
      const explicit: TaskTarget = { ...target, pullRequest: 7 }
      assert.equal(
        prove(reader({ mergedPullRequestsForCommit: () => [] }), feature, explicit).outcome,
        'branch-merged'
      )
      let discoveryCalls = 0
      const explicitProof = integrationFacts(
        reader({
          mergedPullRequestsForCommit: () => {
            discoveryCalls += 1
            return []
          },
        }),
        worktree,
        {
          target: explicit,
          completionRole: 'branch',
          head: feature,
          base: githubMain,
          allocatedAt: Date.parse(MERGED_AT) - 60_000,
          siblings: { heads: [], unknown: [] },
        }
      )
      assert.equal(explicitProof.pullRequests[0]?.containsHead.kind, 'yes')
      assert.equal(explicitProof.pullRequests[0]?.descendsFromBase.kind, 'yes')
      assert.equal(discoveryCalls, 0, 'a sufficient recorded PR proof skips commit-to-PR discovery')
      const childProof = integrationFacts(
        reader({
          mergedPullRequestsForCommit: () => {
            discoveryCalls += 1
            return { unavailable: 'HTTP 422: child commit never pushed' }
          },
        }),
        worktree,
        {
          target: explicit,
          completionRole: 'child',
          head: extendedSource,
          base: githubMain,
          allocatedAt: Date.parse(MERGED_AT) - 60_000,
          siblings: { heads: [], unknown: [] },
        }
      )
      assert.equal(childProof.pullRequests[0]?.containsHead.kind, 'no')
      assert.equal(childProof.pullRequests[0]?.descendsFromBase.kind, 'yes')
      assert.equal(discoveryCalls, 0, 'a recorded child delivery PR skips unpushed HEAD discovery')
      let graphqlCalls = 0
      const batchedReader = makeGitHubReader(
        () => {
          throw new Error('the batched proof should not issue REST calls')
        },
        30_000,
        () => 0,
        () => {
          graphqlCalls += 1
          return {
            status: 'ok',
            text: JSON.stringify({
              data: {
                repository: {
                  ref: { target: { oid: squash } },
                  pullRequest: {
                    mergedAt: MERGED_AT,
                    baseRefName: 'main',
                    baseRepository: { nameWithOwner: 'owner/repo' },
                    headRefOid: feature,
                    headRepository: { nameWithOwner: 'owner/repo' },
                    mergeCommit: { oid: squash },
                    commits: {
                      totalCount: 1,
                      nodes: [{ commit: { oid: feature } }],
                      pageInfo: { hasNextPage: false },
                    },
                  },
                },
              },
            }),
          }
        }
      )
      const batchedProof = integrationFacts(batchedReader, worktree, {
        target: explicit,
        completionRole: 'branch',
        head: feature,
        base: githubMain,
        allocatedAt: Date.parse(MERGED_AT) - 60_000,
        siblings: { heads: [], unknown: [] },
      })
      assert.equal(batchedProof.tip, squash)
      assert.equal(batchedProof.pullRequests[0]?.containsHead.kind, 'yes')
      assert.equal(batchedProof.pullRequests[0]?.descendsFromBase.kind, 'yes')
      assert.equal(
        graphqlCalls,
        1,
        'the target tip and sufficient PR evidence use one provider call'
      )
      let asyncGraphqlCalls = 0
      let synchronousGraphqlCalls = 0
      let resolveResponse:
        | ((response: { readonly status: 'ok'; readonly text: string }) => void)
        | undefined
      const asyncResponse = new Promise<{ readonly status: 'ok'; readonly text: string }>(
        resolve => {
          resolveResponse = resolve
        }
      )
      const asyncReader = makeGitHubReader(
        () => {
          throw new Error('the prefetched GraphQL result must supply integration evidence')
        },
        30_000,
        () => 0,
        () => {
          synchronousGraphqlCalls += 1
          throw new Error('the sync provider must not be called')
        },
        async (repository, ref, number, timeoutMs) => {
          assert.deepEqual(
            [repository, ref, number, timeoutMs],
            ['owner/repo', 'refs/heads/main', 7, 30_000]
          )
          asyncGraphqlCalls += 1
          return asyncResponse
        }
      )
      if (asyncReader.prefetchPullRequestEvidence === undefined)
        throw new Error('async evidence prefetch is missing')
      const firstPrefetch = asyncReader.prefetchPullRequestEvidence(
        'owner/repo',
        'refs/heads/main',
        7
      )
      const secondPrefetch = asyncReader.prefetchPullRequestEvidence(
        'owner/repo',
        'refs/heads/main',
        7
      )
      assert.equal(asyncGraphqlCalls, 1, 'concurrent prefetches share one request')
      if (resolveResponse === undefined) throw new Error('async GraphQL request did not start')
      resolveResponse({
        status: 'ok',
        text: JSON.stringify({
          data: {
            repository: {
              ref: { target: { oid: squash } },
              pullRequest: {
                mergedAt: MERGED_AT,
                baseRefName: 'main',
                baseRepository: { nameWithOwner: 'owner/repo' },
                headRefOid: feature,
                headRepository: { nameWithOwner: 'owner/repo' },
                mergeCommit: { oid: squash },
                commits: {
                  totalCount: 1,
                  nodes: [{ commit: { oid: feature } }],
                  pageInfo: { hasNextPage: false },
                },
              },
            },
          },
        }),
      })
      const prefetched = await Promise.all([firstPrefetch, secondPrefetch])
      assert.deepEqual(prefetched[0], prefetched[1])
      const asyncProof = integrationFacts(asyncReader, worktree, {
        target: explicit,
        completionRole: 'branch',
        head: feature,
        base: githubMain,
        allocatedAt: Date.parse(MERGED_AT) - 60_000,
        siblings: { heads: [], unknown: [] },
      })
      assert.equal(asyncProof.tip, squash)
      assert.equal(asyncProof.pullRequests[0]?.containsHead.kind, 'yes')
      assert.equal(asyncGraphqlCalls, 1)
      assert.equal(synchronousGraphqlCalls, 0, 'sync assessment consumes the prefetched cache')

      let expiredAt = 0
      const expiredReader = makeGitHubReader(
        () => {
          throw new Error('expired async evidence should not issue REST reads')
        },
        30_000,
        () => expiredAt,
        () => {
          throw new Error('expired async evidence should not retry GraphQL synchronously')
        },
        async () => {
          expiredAt = 30_001
          return { status: 'ok', text: '{}' }
        }
      )
      const expired = await expiredReader.prefetchPullRequestEvidence?.(
        'owner/repo',
        'refs/heads/main',
        7
      )
      assert.ok(expired !== undefined && isUnavailable(expired), 'late evidence is unavailable')

      let aborted = false
      const hangingReader = makeGitHubReader(
        () => {
          throw new Error('a hanging prefetch must not fall back to REST')
        },
        5,
        () => 0,
        () => {
          throw new Error('a hanging prefetch must not retry synchronously')
        },
        async (_repository, _ref, _number, _timeoutMs, signal) =>
          new Promise<{ readonly status: 'ok'; readonly text: string }>(() => {
            signal.addEventListener('abort', () => {
              aborted = true
            })
          })
      )
      const timedOut = await hangingReader.prefetchPullRequestEvidence?.(
        'owner/repo',
        'refs/heads/main',
        7
      )
      assert.ok(timedOut !== undefined && isUnavailable(timedOut))
      assert.equal(aborted, true, 'the request is cancelled at its budget')

      let unavailableRestCalls = 0
      const unavailableReader = makeGitHubReader(
        () => {
          unavailableRestCalls += 1
          throw new Error('offline')
        },
        30_000,
        () => 0,
        () => {
          throw new Error('offline')
        }
      )
      const unavailableIntegration = integrationFacts(unavailableReader, worktree, {
        target: explicit,
        completionRole: 'branch',
        head: feature,
        base: githubMain,
        allocatedAt: Date.parse(MERGED_AT) - 60_000,
        siblings: { heads: [], unknown: [] },
      })
      const unavailableVerdict = decideCompletion(
        managedFacts({
          allocation: 'checkout-contention',
          branch: 'refs/heads/feature',
          residue: { tracked: 1, untracked: 0, ignored: 0 },
          ownCommits: true,
          integration: unavailableIntegration,
        })
      )
      assert.equal(verdictName(unavailableVerdict), 'retained:integration-unknown')
      assert.equal(
        unavailableRestCalls,
        1,
        'failed GraphQL evidence falls back to REST within budget'
      )
      const restEndpoints = (
        headRepository: string | null,
        commitList: readonly string[]
      ): { readonly calls: string[]; readonly call: Parameters<typeof makeGitHubReader>[0] } => {
        const calls: string[] = []
        const responses = new Map<string, unknown>([
          ['repos/owner/repo/git/ref/heads/main', { object: { sha: squash } }],
          [
            'repos/owner/repo/pulls/7',
            {
              merged: true,
              merged_at: MERGED_AT,
              merge_commit_sha: squash,
              head: {
                sha: feature,
                repo: headRepository === null ? null : { full_name: headRepository },
              },
              base: { ref: 'main', repo: { full_name: 'owner/repo' } },
              commits: commitList.length,
            },
          ],
          ['repos/owner/repo/pulls/7/commits?per_page=250', commitList.map(sha => ({ sha }))],
        ])
        return {
          calls,
          call: endpoint => {
            calls.push(endpoint)
            const response = responses.get(endpoint)
            if (endpoint.includes('/pulls?')) return { status: 'ok', text: '[]' }
            if (response === undefined) throw new Error(`unexpected REST read ${endpoint}`)
            return { status: 'ok', text: JSON.stringify(response) }
          },
        }
      }
      const graphqlPull = (
        overrides: {
          readonly headRepository?: { readonly nameWithOwner: string } | null
          readonly commits?: unknown
        } = {}
      ) => ({
        mergedAt: MERGED_AT,
        baseRefName: 'main',
        baseRepository: { nameWithOwner: 'owner/repo' },
        headRefOid: feature,
        headRepository: { nameWithOwner: 'owner/repo' },
        mergeCommit: { oid: squash },
        commits: {
          totalCount: 1,
          nodes: [{ commit: { oid: feature } }],
          pageInfo: { hasNextPage: false },
        },
        ...overrides,
      })
      const explicitBranchFacts = (provider: GitHubReader) =>
        integrationFacts(provider, worktree, {
          target: explicit,
          completionRole: 'branch',
          head: feature,
          base: githubMain,
          allocatedAt: Date.parse(MERGED_AT) - 60_000,
          siblings: { heads: [], unknown: [] },
        })

      const erroredRest = restEndpoints('owner/repo', [feature])
      const erroredProof = explicitBranchFacts(
        makeGitHubReader(
          erroredRest.call,
          30_000,
          () => 0,
          () => ({
            status: 'ok',
            text: JSON.stringify({
              data: { repository: { ref: { target: { oid: squash } }, pullRequest: null } },
              errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a PullRequest' }],
            }),
          })
        )
      )
      assert.equal(erroredProof.pullRequests[0]?.containsHead.kind, 'yes')
      assert.deepEqual(
        erroredRest.calls,
        [
          'repos/owner/repo/git/ref/heads/main',
          'repos/owner/repo/pulls/7',
          'repos/owner/repo/pulls/7/commits?per_page=250',
        ],
        'a GraphQL errors payload returned with HTTP 200 is discarded and REST supplies the proof'
      )

      const deletedForkRest = restEndpoints(null, [feature])
      const deletedForkIntegration = explicitBranchFacts(
        makeGitHubReader(
          deletedForkRest.call,
          30_000,
          () => 0,
          () => ({
            status: 'ok',
            text: JSON.stringify({
              data: {
                repository: {
                  ref: { target: { oid: squash } },
                  pullRequest: graphqlPull({ headRepository: null }),
                },
              },
            }),
          })
        )
      )
      const deletedForkVerdict = decideCompletion(
        managedFacts({
          allocation: 'checkout-contention',
          branch: 'refs/heads/feature',
          residue: { tracked: 1, untracked: 0, ignored: 0 },
          ownCommits: true,
          integration: deletedForkIntegration,
        })
      )
      assert.equal(
        verdictName(deletedForkVerdict),
        'retained:integration-unknown',
        'a pull request whose source repository was deleted cannot be bound'
      )

      const longHistory = [
        ...Array.from({ length: 100 }, (_, index) => (index + 1).toString(16).padStart(40, '0')),
        feature,
      ]
      const longRest = restEndpoints('owner/repo', longHistory)
      const longProof = explicitBranchFacts(
        makeGitHubReader(
          longRest.call,
          30_000,
          () => 0,
          () => ({
            status: 'ok',
            text: JSON.stringify({
              data: {
                repository: {
                  ref: { target: { oid: squash } },
                  pullRequest: graphqlPull({
                    commits: {
                      totalCount: longHistory.length,
                      nodes: longHistory.slice(0, 100).map(oid => ({ commit: { oid } })),
                      pageInfo: { hasNextPage: true },
                    },
                  }),
                },
              },
            }),
          })
        )
      )
      assert.equal(longProof.pullRequests[0]?.containsHead.kind, 'yes')
      assert.deepEqual(
        longRest.calls,
        ['repos/owner/repo/pulls/7/commits?per_page=250'],
        'an incomplete GraphQL commit page keeps the batched tip and pull request and reads only the commit list through REST'
      )
    }
  )
  await claim(
    'a delegated child is delivered by a pull request merged after its allocation whose source strictly descends from its base, found through a task-owned sibling HEAD it contains, its base or the recorded pull request, even if no merged source or target keeps its own commits; any refuted delivery condition leaves it not integrated, while unreadable sibling history leaves it unknown',
    () => {
      const allocatedAt = Date.parse(MERGED_AT) - 60_000
      const childVerdict = (
        provider: GitHubReader,
        input: {
          base: string
          siblings: string[]
          siblingsUnknown?: string[]
          head?: string
          allocatedAt?: number
        },
        targetOverride: TaskTarget = target
      ) =>
        decideCompletion(
          managedFacts({
            residue: { tracked: 2, untracked: 0, ignored: 0 },
            ownCommits: input.head !== undefined && input.head !== input.base,
            integration: integrationFacts(provider, worktree, {
              target: targetOverride,
              head: input.head ?? input.base,
              base: input.base,
              allocatedAt: input.allocatedAt ?? allocatedAt,
              siblings: { heads: input.siblings, unknown: input.siblingsUnknown ?? [] },
            }),
          })
        )
      const sibling = childVerdict(reader({ mergedPullRequestsForCommit: seeded(feature) }), {
        base: githubMain,
        siblings: [feature],
      })
      assert.equal(verdictName(sibling), 'child-delivered', sibling.reason)
      assert.ok(
        sibling.reason.includes('owner/repo#7') && sibling.reason.includes('sibling'),
        sibling.reason
      )
      const base = childVerdict(reader({ mergedPullRequestsForCommit: seeded(githubMain) }), {
        base: githubMain,
        siblings: [],
      })
      assert.equal(verdictName(base), 'child-delivered', base.reason)
      assert.ok(base.reason.includes('base seed'), base.reason)
      const recorded = childVerdict(
        reader({ mergedPullRequestsForCommit: () => [] }),
        { base: githubMain, siblings: [] },
        { ...target, pullRequest: 7 }
      )
      assert.equal(verdictName(recorded), 'child-delivered', recorded.reason)
      const patched = childVerdict(reader({ mergedPullRequestsForCommit: seeded(githubMain) }), {
        base: githubMain,
        head: extendedSource,
        siblings: [],
      })
      assert.equal(verdictName(patched), 'child-delivered', patched.reason)
      const cases = [
        [
          'no seed finds a merged pull request',
          childVerdict(reader({ mergedPullRequestsForCommit: () => [] }), {
            base: githubMain,
            siblings: [],
          }),
        ],
        [
          'the pull request does not descend from the base',
          childVerdict(reader({ mergedPullRequestsForCommit: seeded(feature) }), {
            base: extendedSource,
            siblings: [feature],
          }),
        ],
        [
          'the merged source is the base itself',
          childVerdict(reader({ mergedPullRequestsForCommit: seeded(feature) }), {
            base: feature,
            siblings: [],
          }),
        ],
        [
          'the pull request was merged before the allocation',
          childVerdict(reader({ mergedPullRequestsForCommit: seeded(githubMain) }), {
            base: githubMain,
            siblings: [],
            allocatedAt: Date.parse(MERGED_AT) + 60_000,
          }),
        ],
        [
          'only a sibling commit the merged source does not contain found it',
          childVerdict(reader({ mergedPullRequestsForCommit: seeded(extendedSource) }), {
            base: githubMain,
            siblings: [extendedSource],
          }),
        ],
      ] as const
      for (const [label, verdict] of cases)
        assert.equal(verdictName(verdict), 'retained:not-integrated', `${label}: ${verdict.reason}`)
      const unknownCases = [
        [
          'only a sibling found it and its merged head is not in the local object store',
          childVerdict(
            reader(
              {
                mergedPullRequestsForCommit: seeded(feature),
                pullRequestCommits: () => [feature, unknownSha],
              },
              { headSha: unknownSha, commits: 2 }
            ),
            { base: githubMain, siblings: [feature] }
          ),
        ],
        [
          'a sibling workspace could not be read, so its pull requests were not searched',
          childVerdict(reader({ mergedPullRequestsForCommit: () => [] }), {
            base: githubMain,
            siblings: [],
            siblingsUnknown: ['The HEAD of sibling workspace w could not be read'],
          }),
        ],
      ] as const
      for (const [label, verdict] of unknownCases)
        assert.equal(
          verdictName(verdict),
          'retained:integration-unknown',
          `${label}: ${verdict.reason}`
        )
    }
  )
  await claim(
    'replacement refs and grafts cannot make unrelated commits part of the actual merged source or agreed target history',
    () => {
      const unrelated = git(
        [
          'commit-tree',
          git(['rev-parse', `${extendedSource}^{tree}`], github),
          '-m',
          'unrelated source',
        ],
        github
      )
      const grafts = join(github, '.git', 'info', 'grafts')
      const explicit: TaskTarget = { ...target, pullRequest: 7 }
      git(['checkout', '--quiet', '--detach', unrelated], worktree)
      try {
        assert.equal(prove(reader(), unrelated, explicit).outcome, 'retained:not-integrated')
        for (const changed of [feature, squash]) {
          git(['replace', '--graft', changed, unrelated], github)
          assert.equal(
            prove(reader(), unrelated, explicit).outcome,
            'retained:not-integrated',
            'replacement history is not delivery'
          )
          git(['update-ref', '-d', `refs/replace/${changed}`], github)
          writeFileSync(grafts, `${changed} ${unrelated}\n`)
          assert.equal(
            prove(reader(), unrelated, explicit).outcome,
            'retained:not-integrated',
            'grafted history is not delivery'
          )
          rmSync(grafts)
        }
      } finally {
        for (const changed of [feature, squash])
          git(['update-ref', '-d', `refs/replace/${changed}`], github)
        rmSync(grafts, { force: true })
        git(['checkout', '--quiet', '--detach', feature], worktree)
      }
    }
  )
  await claim(
    'a target tip that is not present locally is decided by the provider comparison of exact commits without fetching; a diverged comparison without a pull request is invalid',
    () => {
      const remote = reader({
        refTip: () => unknownSha,
        compare: (_repository, base, head) =>
          head === unknownSha && base === feature ? 'ahead' : 'diverged',
      })
      assert.equal(
        prove(remote).outcome,
        'branch-in-target',
        "the pull request's merge result is not reachable from this tip, so only the comparison proves it"
      )
      const diverged = reader({
        refTip: () => unknownSha,
        compare: () => 'diverged',
        mergedPullRequestsForCommit: () => [],
      })
      assert.equal(prove(diverged).outcome, 'retained:not-integrated')
      assert.equal(git(['rev-parse', 'HEAD'], worktree), feature, 'no ref was fetched or moved')
    }
  )
  await claim(
    'local ancestry decides a local or remote target: a source reachable from the tip is valid, a missing ref or an unreadable remote is unknown, and a negative result in shallow history is unknown rather than proof',
    () => {
      const noGitHub = reader({ refTip: () => ({ unavailable: 'must not be consulted' }) })
      assert.equal(prove(noGitHub, feature, localMain).outcome, 'retained:not-integrated')
      assert.equal(prove(noGitHub, githubMain, localMain).outcome, 'branch-in-target')
      assert.equal(
        prove(noGitHub, feature, { kind: 'local', ref: 'refs/heads/nope' }).outcome,
        'retained:integration-unknown'
      )
      git(['remote', 'add', 'origin', github], worktree)
      const remote: TaskTarget = { kind: 'remote', remote: 'origin', ref: 'refs/heads/main' }
      assert.equal(prove(noGitHub, githubMain, remote).outcome, 'branch-in-target')
      assert.equal(
        prove(noGitHub, feature, {
          kind: 'remote',
          remote: 'nowhere',
          ref: 'refs/heads/main',
        }).outcome,
        'retained:integration-unknown'
      )
      const shallow = join(sandbox, 'shallow')
      execFileSync('git', ['clone', '--quiet', '--depth', '1', `file://${github}`, shallow])
      git(['config', 'user.name', 'Release Check'], shallow)
      git(['config', 'user.email', 'release-check@example.invalid'], shallow)
      writeFileSync(join(shallow, 'more.txt'), 'more\n')
      git(['add', 'more.txt'], shallow)
      git(['commit', '--quiet', '-m', 'more'], shallow)
      const more = git(['rev-parse', 'HEAD'], shallow)
      const proof = decideCompletion(
        managedFacts({
          allocation: 'checkout-contention',
          branch: 'refs/heads/main',
          residue: { tracked: 1, untracked: 0, ignored: 0 },
          ownCommits: true,
          integration: integrationFacts(noGitHub, shallow, {
            target: { kind: 'local', ref: 'refs/remotes/origin/main' },
            head: more,
            base: undefined,
            allocatedAt: undefined,
            siblings: { heads: [], unknown: [] },
          }),
        })
      )
      assert.equal(proof.kind === 'retained' && proof.retained, 'integration-unknown')
      assert.ok(proof.reason.includes('refs/remotes/origin/main'), proof.reason)
    }
  )

  await claim(
    'the workspace tool publishes one described object schema that admits every action and every field of its input shape, so MCP clients requiring an object schema accept it',
    () => {
      const parameters = workspaceToolParameters
      assert.equal(parameters.type, 'object')
      for (const keyword of ['anyOf', 'oneOf', 'allOf'])
        assert.ok(!Object.hasOwn(parameters, keyword), `no top-level ${keyword}`)
      assert.deepEqual(parameters.required, ['action'])
      const properties = parameters.properties as Record<string, Record<string, unknown>>
      const variants = WorkspaceToolInputSchema.members.map(member => ({
        action: member.fields.action.literal,
        fields: Object.keys(member.fields).filter(field => field !== 'action'),
      }))
      assert.deepEqual(
        properties.action?.enum,
        variants.map(variant => variant.action)
      )
      assert.deepEqual(
        Object.keys(properties).toSorted(),
        [...new Set(['action', ...variants.flatMap(variant => variant.fields)])].toSorted()
      )
      for (const variant of variants)
        for (const field of variant.fields)
          assert.ok(
            String(properties[field]?.description).includes(variant.action),
            `${field} says it is used by ${variant.action}`
          )
      const tool = { name: 'workspace', description: '', parameters } as unknown as Tool
      const validate = (input: JsonObject) =>
        validateToolArguments(tool, {
          type: 'toolCall',
          id: 'v',
          name: 'workspace',
          arguments: input,
        })
      const accepted: JsonObject[] = [
        { action: 'resume', taskId: 'task', workspaceId: 'workspace' },
        { action: 'set-target', target: { kind: 'local', ref: 'refs/heads/main' } },
        {
          action: 'record-publication',
          path: 'report.txt',
          destination: { repository: 'owner/repo', number: 1, commentId: 2 },
        },
      ]
      for (const input of accepted) assert.deepEqual(validate(input), input)
      assert.throws(() => validate({ action: 'resume', taskId: 'task', unknown: true }))
    }
  )

  await claim(
    'the workspace tool records a target override, records a publication only after the destination body or an attachment reads back the exact bytes, and resumes onto a retained workspace through the authority selection',
    async () => {
      const allocator = await lifecycle.attach({
        conversation: conversation(),
        cwd: userCheckout(),
      })
      const child = ready(await allocator.authorize({ kind: 'delegated-write' }))
      await allocator.close()
      const allocated = { taskId: requireTask(child.taskId), managed: child }
      const { checkout } = allocated.managed
      deliverBranch(checkout)
      writeFileSync(join(checkout, 'report.txt'), 'published report\n')
      writeFileSync(join(checkout, 'shot.bin'), Buffer.from([1, 2, 3, 4]))
      writeFileSync(join(checkout, 'id_rsa'), 'private key fixture')
      writeFileSync(join(checkout, 'credentials-provider.js'), 'credential fixture')
      const bodies = new Map<string, string>()
      const destinations: PublicationDestinationReader = {
        body: (repository, number, commentId) =>
          Effect.suspend(() => {
            const key = `${repository}#${number}/${commentId ?? 'body'}`
            const body = bodies.get(key)
            return body === undefined
              ? Effect.fail(new WorkspaceToolError({ message: `no destination ${key}` }))
              : Effect.succeed({
                  body,
                  url: `https://github.com/${repository}/issues/${number}#${commentId ?? ''}`,
                })
          }),
        attachment: url =>
          url.endsWith('shot')
            ? Effect.succeed(new Uint8Array([1, 2, 3, 4]))
            : Effect.fail(new WorkspaceToolError({ message: `no attachment ${url}` })),
      }
      const bound = await lifecycle.attach({
        conversation: conversation(),
        cwd: repo,
        selection: { taskId: allocated.taskId, workspaceId: allocated.managed.workspaceId },
      })
      const context = () =>
        ({ cwd: checkout, hasUI: true }) as unknown as Parameters<ToolDefinition['execute']>[4]
      const liveClock = Effect.runSync(Clock.Clock)
      const clock: Clock.Clock = {
        currentTimeMillis: Effect.succeed(1234),
        currentTimeMillisUnsafe: () => 1234,
        currentTimeNanos: liveClock.currentTimeNanos,
        currentTimeNanosUnsafe: () => liveClock.currentTimeNanosUnsafe(),
        monotonicTimeNanos: liveClock.monotonicTimeNanos,
        monotonicTimeNanosUnsafe: () => liveClock.monotonicTimeNanosUnsafe(),
        sleep: duration => liveClock.sleep(duration),
      }
      const tool = makeWorkspaceTool({
        lifecycle: lifecycle.effect,
        attachment: () => bound.effect,
        runPromise: effect =>
          Effect.runPromise(
            effect.pipe(
              Effect.provideService(PublicationDestinations, destinations),
              Effect.provideService(Clock.Clock, clock)
            )
          ),
        requestResume: () => {
          throw new Error('this claim resumes nothing')
        },
      })
      const call = async (input: unknown) => {
        try {
          const result = await tool.execute('call', input as never, undefined, undefined, context())
          const text = result.content.map(part => (part.type === 'text' ? part.text : '')).join('')
          return { ok: true, text }
        } catch (cause) {
          return { ok: false, text: cause instanceof Error ? cause.message : String(cause) }
        }
      }
      for (const input of [
        { action: 'resume' },
        { action: 'resume', taskId: allocated.taskId, path: 'report.txt' },
        { action: 'set-target' },
        { action: 'record-publication', path: 'report.txt' },
      ]) {
        const refused = await call(input)
        assert.ok(!refused.ok, `the action's own input shape refuses ${JSON.stringify(input)}`)
      }
      const targeted = await call({ action: 'set-target', target: localMain })
      assert.ok(targeted.ok, targeted.text)
      const missing = await call({
        action: 'record-publication',
        path: 'report.txt',
        destination: { repository: 'owner/repo', number: 37, commentId: 9 },
      })
      assert.ok(!missing.ok)
      assert.ok(missing.text.includes('owner/repo#37/9'), missing.text)
      bodies.set('owner/repo#37/9', 'Summary only, not the report.')
      const unverified = await call({
        action: 'record-publication',
        path: 'report.txt',
        destination: { repository: 'owner/repo', number: 37, commentId: 9 },
      })
      assert.ok(!unverified.ok)
      assert.ok(
        unverified.text.includes('report.txt') &&
          unverified.text.includes(sha256('published report\n').slice(0, 12)),
        unverified.text
      )
      bodies.set(
        'owner/repo#37/9',
        'Report:\n```\npublished report\n```\n![shot](https://github.com/user-attachments/assets/shot)'
      )
      const recorded = await call({
        action: 'record-publication',
        path: 'report.txt',
        destination: { repository: 'owner/repo', number: 37, commentId: 9 },
      })
      assert.ok(recorded.ok, recorded.text)
      assert.equal(reply(recorded.text).reference?.destination.readBack, 'text-in-body')
      assert.equal(
        reply(recorded.text).reference?.verifiedAt,
        1234,
        'publication uses the runtime Clock'
      )
      const attached = await call({
        action: 'record-publication',
        path: 'shot.bin',
        destination: { repository: 'owner/repo', number: 37, commentId: 9 },
      })
      assert.ok(attached.ok, attached.text)
      assert.equal(reply(attached.text).reference?.destination.readBack, 'attachment-sha256')
      const sensitive = await call({
        action: 'record-publication',
        path: 'id_rsa',
        destination: { repository: 'owner/repo', number: 37, commentId: 9 },
      })
      assert.ok(!sensitive.ok)
      assert.ok(sensitive.text.includes('sensitive name'), sensitive.text)
      const selectedSecret = await call({
        action: 'record-publication',
        path: 'credentials-provider.js',
        destination: { repository: 'owner/repo', number: 37, commentId: 9 },
      })
      assert.ok(!selectedSecret.ok)
      await bound.close()
      const managed = only(await lifecycle.check(allocated.taskId), allocated.managed.workspaceId)
      assert.equal(managed.completion.kind, 'finished', managed.reasons.join(' '))
      assert.equal(managed.evidence?.verdict, 'valid', managed.reasons.join(' '))
      assert.equal(managed.inventory?.published, 2)
      assert.equal(managed.inventory?.disposable, 2)

      const elsewhere = await lifecycle.attach({ conversation: conversation(), cwd: repo })
      const requested: WorkspaceHandoff[] = []
      const resumeTool = makeWorkspaceTool({
        lifecycle: lifecycle.effect,
        attachment: () => elsewhere.effect,
        runPromise: effect =>
          Effect.runPromise(Effect.provideService(effect, PublicationDestinations, destinations)),
        requestResume: handoff => {
          requested.push(handoff)
        },
      })
      const resumed = await resumeTool.execute(
        'resume',
        { action: 'resume', taskId: allocated.taskId } as never,
        undefined,
        undefined,
        context()
      )
      assert.equal(resumed.terminate, true, 'a requested resume ends the tool batch')
      assert.deepEqual(
        requested.map(handoff => [handoff.target.workspaceId, handoff.target.taskId]),
        [[allocated.managed.workspaceId, allocated.taskId]],
        'the authority selected the retained workspace and handed the switch to the host'
      )
      await elsewhere.handoff(requested[0]!, async () => 'cancelled')
      await elsewhere.close()
    }
  )

  await claim(
    'a running conversation that left a pre-existing checkout whose reservation was then released can return to that checkout and leave it again: its pruned settled use is not a lost use',
    async () => {
      const roundTripRepo = join(sandbox, 'round-trip-repo')
      initRepository(roundTripRepo)
      const traveller = await lifecycle.attach({ conversation: conversation(), cwd: roundTripRepo })
      const origin = ready(await traveller.authorize({ kind: 'write' }))
      const originTask = requireTask(origin.taskId)
      const allocator = await lifecycle.attach({ conversation: conversation(), cwd: roundTripRepo })
      const managed = ready(await allocator.authorize({ kind: 'delegated-write' }))
      await allocator.close()
      const managedSelection = {
        taskId: requireTask(managed.taskId),
        workspaceId: managed.workspaceId,
      }
      await traveller.handoff(await traveller.select(managedSelection), async () => 'confirmed')
      assert.equal(traveller.binding.workspaceId, managed.workspaceId)

      assert.equal(
        only(await lifecycle.check(originTask), origin.workspaceId).origin,
        'pre-existing'
      )
      const released = await lifecycle.release(originTask)
      assert.deepEqual(outcomes(released), [[origin.workspaceId, 'released']])
      assert.ok(
        (await lifecycle.inspect({ cwd: roundTripRepo }))
          .flatMap(view => view.uses)
          .every(use => use.id !== origin.useId),
        'the release pruned the settled use the conversation still remembers'
      )

      const reserver = await lifecycle.attach({ conversation: conversation(), cwd: roundTripRepo })
      const reserved = ready(await reserver.authorize({ kind: 'write' }))
      assert.equal(reserved.workspaceId, origin.workspaceId)
      await reserver.close()
      await traveller.handoff(
        await traveller.select({
          taskId: requireTask(reserved.taskId),
          workspaceId: reserved.workspaceId,
        }),
        async () => 'confirmed'
      )
      assert.equal(traveller.binding.workspaceId, origin.workspaceId)

      await traveller.handoff(await traveller.select(managedSelection), async () => 'confirmed')
      assert.equal(traveller.binding.workspaceId, managed.workspaceId)
      ready(await traveller.authorize({ kind: 'write' }))
      await traveller.close()
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
          'GitHub facts come from a fake reader with the shapes the gh-backed reader normalizes; a real read-back of a public merged pull request was observed once by hand, not here.',
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
