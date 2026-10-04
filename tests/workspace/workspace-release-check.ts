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
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import {
  WorkspaceError,
  type WorkspaceHandoff,
  type PublicationReference,
  type ReleaseRequest,
  type TaskTarget,
  type WorkspaceAssessment,
  type WorkspaceId,
  type WorkspaceLifecycle,
} from '../../src/workspace-domain.ts'
import { decideCompletion } from '../../src/workspace-completion.ts'
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
  makeWorkspaceTool,
  type PublicationDestinationReader,
} from '../../src/workspace-tool.ts'
import type { StartWorkspaceWorker } from '../../src/workspace-lifecycle.ts'
import {
  formatReleaseRun,
  releaseConfirmation,
  releaseExitCode,
  runRelease,
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
  faultInjector,
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

const namesAttempt = (attempt: string | undefined, ...facts: readonly string[]) => {
  assert.ok(attempt !== undefined, 'the earlier attempt is identified')
  return (text: string | undefined): boolean =>
    text !== undefined && [attempt, ...facts].every(fact => text.includes(fact))
}
const releaseOne = (
  lifecycle: TestLifecycle,
  assessments: readonly WorkspaceAssessment[],
  workspaceId: WorkspaceId,
  extra: Partial<ReleaseRequest> = {}
) =>
  lifecycle.release({
    taskId: only(assessments, workspaceId).taskId,
    commandId: newId(),
    decided: assessments.map(item => item.subject),
    decider: { kind: 'user' },
    workspaceId,
    occupiedPaths: [],
    ...extra,
  })
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
const allocateManaged = async (
  lifecycle: TestLifecycle,
  repo: string,
  existing?: { readonly taskId: WorkspaceId; readonly workspaceId: WorkspaceId }
) => {
  const owner = await lifecycle.attach({
    conversation: conversation(),
    cwd: repo,
    ...(existing === undefined ? {} : { selection: existing }),
  })
  const write = existing === undefined ? ready(await owner.authorize({ kind: 'write' })) : undefined
  const taskId = existing?.taskId ?? requireTask(write?.taskId)
  const managed = ready(await owner.authorize({ kind: 'delegated-write' }))
  assert.equal(managed.taskId, taskId)
  await owner.close()
  return {
    taskId,
    repoWorkspaceId: existing?.workspaceId ?? requireTask(write?.workspaceId),
    managed,
  }
}

const freeCheckout = async (
  lifecycle: TestLifecycle,
  taskId: WorkspaceId,
  workspaceId: WorkspaceId
) => {
  const assessments = await lifecycle.check(taskId)
  const result = await releaseOne(lifecycle, assessments, workspaceId)
  assert.equal(result.outcome, 'released', result.reason)
}

try {
  const repo = join(sandbox, 'repo')
  const mainCommit = initRepository(repo)
  const lifecycle = await openLifecycle({ root })
  const deliverBranch = (checkout: string): string => {
    const name = `delivered-${newId()}`
    git(['switch', '--quiet', '-c', name], checkout)
    writeFileSync(join(checkout, `${name}.txt`), `${name}\n`)
    git(['add', `${name}.txt`], checkout)
    git(['commit', '--quiet', '-m', name], checkout)
    git(['merge', '--quiet', '--ff-only', name], repo)
    return git(['rev-parse', 'HEAD'], checkout)
  }

  const holder = await lifecycle.attach({ conversation: conversation(), cwd: repo })
  const held = ready(await holder.authorize({ kind: 'write' }))
  const taskA = requireTask(held.taskId)
  writeFileSync(join(repo, 'tracked.txt'), 'edited while reserved\n')
  writeFileSync(join(repo, 'notes.log'), 'ignored residual\n')
  await claim(
    'check of a task whose pre-existing checkout is in live use reports it active with the live use, without attaching or acquiring anything',
    async () => {
      const usesBefore = (await lifecycle.inspect({ cwd: repo })).flatMap(view => view.uses).length
      const [assessment] = await lifecycle.check(taskA)
      assert.equal(assessment?.outcome, 'active')
      assert.equal(assessment?.origin, 'pre-existing')
      assert.equal(assessment?.subject.effect, 'none')
      assert.ok(
        assessment?.reasons.some(reason => reason.includes(held.useId)),
        assessment?.reasons.join(' | ')
      )
      const usesAfter = (await lifecycle.inspect({ cwd: repo })).flatMap(view => view.uses).length
      assert.equal(usesAfter, usesBefore, 'a check records no use')
      const blocked = await releaseOne(lifecycle, await lifecycle.check(taskA), held.workspaceId)
      assert.equal(blocked.outcome, 'blocked', blocked.reason)
      assert.deepEqual(blocked.effects, [])
    }
  )
  await holder.close()
  await claim(
    'once its use ended, the pre-existing checkout is releasable with its residual changes reported, and release ends only the reservation and deletes its settled use records: files, commits and the ignored residual are untouched',
    async () => {
      const [assessment] = await lifecycle.check(taskA)
      assert.equal(assessment?.outcome, 'releasable')
      assert.equal(assessment?.subject.effect, 'release-reservation')
      assert.ok(
        assessment?.residual.some(item => item.includes('tracked.txt')),
        assessment?.residual.join(';')
      )
      assert.equal(
        assessment?.evidence,
        undefined,
        'no integration or publication proof is required'
      )
      const settledBefore = (await lifecycle.inspect({ cwd: repo })).flatMap(view => view.uses)
      assert.ok(settledBefore.length > 0, 'the ended holder left settled use records')
      assert.deepEqual([...new Set(settledBefore.map(use => use.stage))], ['quiescent'])
      const result = await releaseOne(lifecycle, [assessment!], held.workspaceId)
      assert.equal(result.outcome, 'released', result.reason)
      assert.ok(result.operationId !== undefined)
      assert.equal(readFileSync(join(repo, 'tracked.txt'), 'utf8'), 'edited while reserved\n')
      assert.equal(readFileSync(join(repo, 'notes.log'), 'utf8'), 'ignored residual\n')
      assert.equal(git(['rev-parse', 'HEAD'], repo), mainCommit)
      const views = await lifecycle.inspect({ cwd: repo })
      assert.equal(views.length, 1)
      assert.equal(views[0]?.taskId, undefined, 'the checkout holds no reservation any more')
      assert.deepEqual(views[0]?.uses, [], "the released reservation's settled uses are deleted")
      const receipts = await lifecycle.inspect({ taskId: taskA })
      assert.deepEqual(
        receipts.map(view => view.outcome),
        ['released'],
        'the receipt stays inspectable by exact task'
      )
      assert.deepEqual(
        await lifecycle.check(taskA),
        [],
        'a released task has nothing left to check'
      )
      const again = await lifecycle.release({
        taskId: taskA,
        commandId: newId(),
        decided: [assessment!.subject],
        decider: { kind: 'user' },
        workspaceId: held.workspaceId,
        occupiedPaths: [],
      })
      assert.equal(again.outcome, 'blocked')
      assert.ok(
        again.reason.includes(taskA) && again.reason.includes(held.workspaceId),
        again.reason
      )
    }
  )
  rmSync(join(repo, 'notes.log'))
  git(['checkout', '--quiet', '--', 'tracked.txt'], repo)

  const first = await allocateManaged(lifecycle, repo)
  const taskB = first.taskId
  const m1 = first.managed
  await claim(
    'a dirty delegated child without a recorded or derivable target is review-required with the missing target named, and a release bound to that assessment removes nothing',
    async () => {
      writeFileSync(join(m1.checkout, 'tracked.txt'), 'dirty child\n')
      const assessments = await lifecycle.check(taskB)
      const managed = only(assessments, m1.workspaceId)
      assert.equal(managed.outcome, 'review-required')
      assert.deepEqual(
        [managed.completion.kind, managed.completion.role, managed.target.source],
        ['retained', 'child', 'none']
      )
      assert.ok(
        managed.reasons.some(reason => reason.includes('no origin remote')),
        managed.reasons.join(' | ')
      )
      assert.equal(managed.subject.effect, 'none')
      assert.equal(only(assessments, first.repoWorkspaceId).outcome, 'releasable')
      const result = await releaseOne(lifecycle, assessments, m1.workspaceId)
      assert.equal(result.outcome, 'review-required', result.reason)
      assert.ok(existsSync(m1.checkout))
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
    'a clean managed worktree at its base is removable at this check only as no-residue, the recorded target shown as an override, and a check still creates no use',
    async () => {
      const managed = only(await lifecycle.check(taskB), m1.workspaceId)
      assert.equal(managed.outcome, 'removable')
      assert.equal(managed.evidence?.verdict, 'valid')
      assert.deepEqual(
        [
          managed.completion.kind,
          managed.completion.kind === 'finished' && managed.completion.rule,
        ],
        ['finished', 'no-residue']
      )
      assert.equal(managed.target.source, 'override')
      assert.equal(managed.subject.effect, 'remove-worktree')
      assert.equal(managed.subject.head, mainCommit)
      assert.ok(existsSync(m1.checkout), 'the check removed nothing')
      const uses = (await lifecycle.inspect({ taskId: taskB })).flatMap(view => view.uses)
      assert.ok(
        uses.every(use => use.stage === 'quiescent'),
        'a check leaves no live use'
      )
    }
  )
  await claim(
    'confirmation binds index flags and actual tracked bytes even when Git masks changes and file size and mtime stay the same',
    async () => {
      const path = join(m1.checkout, 'tracked.txt')
      const original = readFileSync(path)
      for (const [set, unset] of [
        ['--assume-unchanged', '--no-assume-unchanged'],
        ['--skip-worktree', '--no-skip-worktree'],
      ] as const) {
        const beforeFlags = await lifecycle.check(taskB)
        git(['update-index', set, 'tracked.txt'], m1.checkout)
        const staleIndex = await releaseOne(lifecycle, beforeFlags, m1.workspaceId)
        assert.equal(staleIndex.outcome, 'blocked', staleIndex.reason)
        assert.deepEqual(staleIndex.effects, [])
        utimesSync(path, 10, 10)
        const beforeContents = await lifecycle.check(taskB)
        writeFileSync(path, Buffer.alloc(original.length, 120))
        utimesSync(path, 10, 10)
        assert.equal(git(['status', '--porcelain'], m1.checkout), '')
        const staleContents = await releaseOne(lifecycle, beforeContents, m1.workspaceId)
        assert.equal(staleContents.outcome, 'blocked', staleContents.reason)
        assert.deepEqual(staleContents.effects, [])
        assert.deepEqual(readFileSync(path), Buffer.alloc(original.length, 120))
        writeFileSync(path, original)
        git(['update-index', unset, 'tracked.txt'], m1.checkout)
      }
    }
  )
  await claim(
    'an explicitly Git-locked worktree is refused before any cleanup effect',
    async () => {
      const assessments = await lifecycle.check(taskB)
      git(['worktree', 'lock', '--reason', 'fixture lock', '--', m1.checkout], repo)
      try {
        const result = await releaseOne(lifecycle, assessments, m1.workspaceId)
        assert.equal(result.outcome, 'blocked', result.reason)
        assert.ok(result.reason.includes('locked'), result.reason)
        assert.deepEqual(result.effects, [])
        assert.ok(existsSync(m1.checkout))
      } finally {
        git(['worktree', 'unlock', '--', m1.checkout], repo)
      }
    }
  )
  await claim(
    'a release whose confirmed assessment no longer matches the worktree is blocked before any effect',
    async () => {
      git(['switch', '--quiet', '-c', 'stale-confirmation'], m1.checkout)
      const commit = (name: string) => {
        writeFileSync(join(m1.checkout, name), `${name}\n`)
        git(['add', name], m1.checkout)
        git(['commit', '--quiet', '-m', name], m1.checkout)
        git(['merge', '--quiet', '--ff-only', 'stale-confirmation'], repo)
      }
      commit('first.txt')
      const assessments = await lifecycle.check(taskB)
      commit('second.txt')
      assert.equal(
        only(await lifecycle.check(taskB), m1.workspaceId).outcome,
        'removable',
        'only the stale confirmation stands between this release and a removal'
      )
      const result = await releaseOne(lifecycle, assessments, m1.workspaceId)
      assert.equal(result.outcome, 'blocked', result.reason)
      assert.ok(result.reason.includes('HEAD'), result.reason)
      assert.deepEqual(result.effects, [])
      assert.ok(existsSync(join(m1.checkout, 'second.txt')))
      git(['checkout', '--quiet', '--detach', mainCommit], m1.checkout)
      git(['branch', '--quiet', '-D', 'stale-confirmation'], repo)
    }
  )
  await claim(
    'a workspace added to the task after confirmation refuses the whole attempt as a scope change; nothing is released',
    async () => {
      writeFileSync(
        join(m1.checkout, 'tracked.txt'),
        'unfinished, so the allocation sweep keeps it\n'
      )
      const assessments = await lifecycle.check(taskB)
      const second = await allocateManaged(lifecycle, repo, {
        taskId: taskB,
        workspaceId: first.repoWorkspaceId,
      })
      assert.ok(existsSync(m1.checkout), 'the sweep before the allocation retained the dirty child')
      await expectError(releaseOne(lifecycle, assessments, m1.workspaceId), 'invalid', [
        taskB,
        second.managed.workspaceId,
      ])
      assert.ok(existsSync(m1.checkout))
      assert.ok(existsSync(second.managed.checkout))
      git(['checkout', '--quiet', '--', 'tracked.txt'], m1.checkout)
    }
  )
  const commandB = newId()
  await claim(
    'a confirmed removal deletes the managed worktree, its Git registration and its reservation, records a receipt inspectable by task, refuses a replay of the same command, and refuses to resume into the removed workspace',
    async () => {
      const assessments = await lifecycle.check(taskB)
      assert.equal(assessments.length, 3)
      const adminPath = git(['rev-parse', '--path-format=absolute', '--git-dir'], m1.checkout)
      const result = await releaseOne(lifecycle, assessments, m1.workspaceId, {
        commandId: commandB,
      })
      assert.equal(result.outcome, 'removed', result.reason)
      assert.ok(!existsSync(m1.checkout), 'the worktree directory is gone')
      assert.ok(!existsSync(adminPath), 'the Git registration is gone')
      assert.ok(!registered(repo).includes(m1.checkout))
      assert.ok(existsSync(join(repo, 'tracked.txt')), 'the main checkout is untouched')
      const receipts = await lifecycle.inspect({ taskId: taskB })
      const receipt = receipts.find(view => view.workspaceId === m1.workspaceId)
      assert.equal(receipt?.outcome, 'removed')
      assert.ok(
        !(await lifecycle.inspect({ cwd: repo })).some(view => view.workspaceId === m1.workspaceId),
        'the receipt does not clutter the repository list'
      )
      await expectError(
        lifecycle.release({
          taskId: taskB,
          commandId: commandB,
          decided: assessments.map(item => item.subject),
          decider: { kind: 'user' },
          workspaceId: m1.workspaceId,
          occupiedPaths: [],
        }),
        'invalid',
        [commandB, m1.workspaceId]
      )
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
    'the confirmation discloses per workspace that the managed worktree would be deleted and the pre-existing checkout keeps every file; the workspaces then release independently under a fresh command: the pre-existing checkout keeps its files and the second managed worktree is removed',
    async () => {
      const assessments = await lifecycle.check(taskB)
      assert.equal(assessments.length, 2)
      const consequence = { managed: 'delete this managed worktree', 'pre-existing': 'every file' }
      for (const assessment of assessments) {
        const disclosed = releaseConfirmation(taskB, [assessment]).message
        assert.ok(disclosed.includes(assessment.path), disclosed)
        assert.ok(disclosed.includes(consequence[assessment.origin]), disclosed)
        assert.ok(disclosed.includes('pre-existing checkout files are never touched'), disclosed)
      }
      const outcomes = new Map<string, string>()
      for (const assessment of assessments) {
        const result = await releaseOne(lifecycle, assessments, assessment.workspaceId, {
          commandId: commandB,
        })
        outcomes.set(assessment.origin, result.outcome)
      }
      assert.deepEqual([...outcomes.entries()].toSorted(), [
        ['managed', 'removed'],
        ['pre-existing', 'released'],
      ])
      assert.equal(readFileSync(join(repo, 'tracked.txt'), 'utf8'), 'tracked\n')
      assert.deepEqual(registered(repo), [repo])
      assert.deepEqual(await lifecycle.check(taskB), [])
    }
  )

  const third = await allocateManaged(lifecycle, repo)
  const taskC = third.taskId
  const m3 = third.managed
  await lifecycle.recordTarget(taskC, localMain)
  await freeCheckout(lifecycle, taskC, third.repoWorkspaceId)
  const deliveredC = deliverBranch(m3.checkout)
  const outcomeOf = async (workspaceId: WorkspaceId, taskId: WorkspaceId) =>
    only(await lifecycle.check(taskId), workspaceId)
  await claim(
    'on a branch whose commits are in the target, dirty tracked residue and unselected reports are disposable, but an unintegrated local commit blocks removal',
    async () => {
      writeFileSync(join(m3.checkout, 'tracked.txt'), 'dirty\n')
      let managed = await outcomeOf(m3.workspaceId, taskC)
      assert.equal(managed.outcome, 'removable', managed.reasons.join(' | '))
      assert.equal(managed.inventory?.trackedChanges, 1)
      const before = await lifecycle.check(taskC)
      writeFileSync(join(m3.checkout, 'tracked.txt'), 'other\n')
      const stale = await releaseOne(lifecycle, before, m3.workspaceId)
      assert.equal(stale.outcome, 'blocked', stale.reason)
      assert.deepEqual(stale.effects, [])
      git(['add', 'tracked.txt'], m3.checkout)
      const stagedBefore = await lifecycle.check(taskC)
      writeFileSync(join(m3.checkout, 'tracked.txt'), 'again\n')
      git(['add', 'tracked.txt'], m3.checkout)
      const staleIndex = await releaseOne(lifecycle, stagedBefore, m3.workspaceId)
      assert.equal(staleIndex.outcome, 'blocked', staleIndex.reason)
      assert.deepEqual(staleIndex.effects, [])
      git(['reset', '--quiet', 'HEAD', '--', 'tracked.txt'], m3.checkout)
      git(['checkout', '--quiet', '--', 'tracked.txt'], m3.checkout)

      writeFileSync(join(m3.checkout, 'feature.txt'), 'feature\n')
      git(['add', 'feature.txt'], m3.checkout)
      git(['commit', '--quiet', '-m', 'unintegrated'], m3.checkout)
      const unintegrated = git(['rev-parse', 'HEAD'], m3.checkout)
      managed = await outcomeOf(m3.workspaceId, taskC)
      assert.equal(managed.outcome, 'blocked', 'a clean branch with an unmerged commit is retained')
      writeFileSync(join(m3.checkout, 'tracked.txt'), 'residue beside the unintegrated commit\n')
      managed = await outcomeOf(m3.workspaceId, taskC)
      assert.equal(managed.outcome, 'blocked')
      assert.equal(managed.evidence?.verdict, 'valid')
      assert.deepEqual(
        [
          managed.completion.kind,
          managed.completion.kind === 'retained' && managed.completion.retained,
        ],
        ['retained', 'not-integrated']
      )
      assert.ok(
        managed.reasons.some(
          reason =>
            reason.includes(unintegrated.slice(0, 12)) && reason.includes(deliveredC.slice(0, 12))
        ),
        managed.reasons.join(' | ')
      )
      git(['reset', '--quiet', '--hard', deliveredC], m3.checkout)

      writeFileSync(join(m3.checkout, 'report.txt'), 'evidence report\n')
      managed = await outcomeOf(m3.workspaceId, taskC)
      assert.equal(managed.outcome, 'removable', managed.reasons.join(' '))
      assert.ok((managed.inventory?.disposable ?? 0) >= 1)
    }
  )
  await claim(
    'a recorded publication whose bytes match the local file covers it without any download; changed local bytes block until the current bytes are published',
    async () => {
      await lifecycle.recordPublication(
        publication(
          taskC,
          m3.workspaceId,
          'report.txt',
          readFileSync(join(m3.checkout, 'report.txt'))
        )
      )
      let managed = await outcomeOf(m3.workspaceId, taskC)
      assert.equal(managed.outcome, 'removable', managed.reasons.join(' '))
      assert.equal(managed.inventory?.published, 1)
      writeFileSync(join(m3.checkout, 'report.txt'), 'evidence report, amended\n')
      managed = await outcomeOf(m3.workspaceId, taskC)
      assert.equal(managed.outcome, 'blocked')
      assert.ok(
        managed.reasons.some(
          reason => reason.includes(PUBLISHED_URL) && reason.includes('report.txt')
        ),
        managed.reasons.join(' | ')
      )
      rmSync(join(m3.checkout, 'report.txt'))
      symlinkSync(join(sandbox, 'unpublished-target'), join(m3.checkout, 'report.txt'))
      managed = await outcomeOf(m3.workspaceId, taskC)
      assert.equal(
        managed.outcome,
        'blocked',
        'a recorded report replaced by a link is not disposable residue'
      )
      rmSync(join(m3.checkout, 'report.txt'))
      writeFileSync(join(m3.checkout, 'report.txt'), 'evidence report\n')
      const trackedReport = readFileSync(join(m3.checkout, '.gitignore'))
      await lifecycle.recordPublication(
        publication(taskC, m3.workspaceId, '.gitignore', trackedReport)
      )
      writeFileSync(join(m3.checkout, '.gitignore'), `${trackedReport.toString()}changed\n`)
      managed = await outcomeOf(m3.workspaceId, taskC)
      assert.equal(
        managed.outcome,
        'blocked',
        'a changed tracked publication is not disposable residue'
      )
      writeFileSync(join(m3.checkout, '.gitignore'), trackedReport)
    }
  )
  await claim(
    'unselected ignored and sensitive-looking files are disposable, while nested repositories remain blocking inventory entries',
    async () => {
      mkdirSync(join(m3.checkout, 'build', 'sub'), { recursive: true })
      writeFileSync(join(m3.checkout, 'build', 'a.o'), 'object a')
      writeFileSync(join(m3.checkout, 'build', 'sub', 'b.o'), 'object b')
      writeFileSync(join(m3.checkout, 'build', 'credentials-provider.js'), 'local dependency')
      let managed = await outcomeOf(m3.workspaceId, taskC)
      assert.equal(managed.outcome, 'removable', managed.reasons.join(' '))
      assert.equal(managed.inventory?.disposable, 3)

      writeFileSync(join(sandbox, 'outside.txt'), 'outside the worktree\n')
      symlinkSync(join(sandbox, 'outside.txt'), join(m3.checkout, 'build', 'link'))
      managed = await outcomeOf(m3.workspaceId, taskC)
      assert.equal(managed.outcome, 'removable', managed.reasons.join(' '))
      assert.equal(managed.inventory?.disposable, 4)

      mkdirSync(join(m3.checkout, 'vendor'))
      git(['init', '--quiet'], join(m3.checkout, 'vendor'))
      writeFileSync(join(m3.checkout, 'vendor', 'v.txt'), 'v')
      managed = await outcomeOf(m3.workspaceId, taskC)
      assert.equal(managed.outcome, 'blocked')
      const nested = managed.reasons.join(' | ')
      assert.ok(nested.includes('vendor/') && !nested.includes('vendor/v.txt'), nested)
      rmSync(join(m3.checkout, 'vendor'), { recursive: true, force: true })
    }
  )
  await claim(
    'tracked submodules and replaced tracked ancestors block disposal without reading or changing external content',
    async () => {
      git(['update-index', '--add', '--cacheinfo', `160000,${mainCommit},module`], m3.checkout)
      let managed = await outcomeOf(m3.workspaceId, taskC)
      assert.equal(managed.outcome, 'review-required')
      assert.equal(managed.subject.effect, 'none')
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
      managed = await outcomeOf(m3.workspaceId, taskC)
      assert.equal(managed.outcome, 'review-required')
      assert.equal(managed.subject.effect, 'none')
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
      let managed = await outcomeOf(m3.workspaceId, taskC)
      assert.equal(managed.outcome, 'removable', managed.reasons.join(' '))
      assert.ok(!existsSync(sentinel))
      git(['config', 'filter.tripwire.clean', command], m3.checkout)
      writeFileSync(attributes, 'tracked.txt filter=tripwire\n')
      managed = await outcomeOf(m3.workspaceId, taskC)
      assert.equal(managed.outcome, 'review-required')
      assert.equal(managed.subject.effect, 'none')
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
    'a live reader in the managed worktree makes it active and blocks its removal; a launcher or shell directory inside it blocks removal too',
    async () => {
      const reader = await lifecycle.attach({
        conversation: conversation(),
        cwd: repo,
        selection: { taskId: taskC, workspaceId: m3.workspaceId },
      })
      ready(await reader.authorize({ kind: 'read' }))
      const assessments = await lifecycle.check(taskC)
      const managed = only(assessments, m3.workspaceId)
      assert.equal(managed.outcome, 'active')
      const blocked = await releaseOne(lifecycle, assessments, m3.workspaceId)
      assert.equal(blocked.outcome, 'blocked', blocked.reason)
      assert.ok(existsSync(m3.checkout))
      await reader.close()
      const freed = await lifecycle.check(taskC)
      assert.equal(only(freed, m3.workspaceId).outcome, 'removable')
      const occupied = await releaseOne(lifecycle, freed, m3.workspaceId, {
        occupiedPaths: [join(m3.checkout, 'build')],
      })
      assert.equal(occupied.outcome, 'blocked')
      assert.ok(occupied.reason.includes(join(m3.checkout, 'build')), occupied.reason)
      assert.ok(existsSync(m3.checkout))
    }
  )
  await claim(
    'removal deletes the published report, leaves an external symlink target unchanged, and lets Git discard dirty tracked and untracked residue',
    async () => {
      writeFileSync(join(m3.checkout, 'tracked.txt'), 'reconciled intermediate content\n')
      git(['add', 'tracked.txt'], m3.checkout)
      writeFileSync(join(m3.checkout, 'tracked.txt'), 'uncommitted intermediate residue\n')
      const assessments = await lifecycle.check(taskC)
      const result = await releaseOne(lifecycle, assessments, m3.workspaceId)
      assert.equal(result.outcome, 'removed', result.reason)
      assert.ok(result.effects.includes('deleted report.txt'), result.effects.join(';'))
      assert.ok(!result.effects.some(effect => effect.includes('outside.txt')))
      assert.equal(readFileSync(join(sandbox, 'outside.txt'), 'utf8'), 'outside the worktree\n')
      assert.ok(!existsSync(m3.checkout))
      assert.ok(!registered(repo).includes(m3.checkout))
    }
  )

  await claim(
    'recording the same publication twice keeps one fact whose columns and payload agree, and an option-shaped remote name is refused at the authority boundary before any Git call',
    async () => {
      const allocated = await allocateManaged(lifecycle, repo)
      await lifecycle.recordTarget(allocated.taskId, localMain)
      await freeCheckout(lifecycle, allocated.taskId, allocated.repoWorkspaceId)
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
      assert.equal(managed.outcome, 'removable', managed.reasons.join(' '))
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
        only(await lifecycle.check(allocated.taskId), allocated.managed.workspaceId).outcome,
        'removable'
      )
      const result = await releaseOne(
        lifecycle,
        await lifecycle.check(allocated.taskId),
        allocated.managed.workspaceId
      )
      assert.equal(result.outcome, 'removed', result.reason)
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
  const crashed = async (
    fault: ReleaseFault,
    prepare: (checkout: string, taskId: WorkspaceId, workspaceId: WorkspaceId) => Promise<void>
  ) => {
    const allocated = await allocateManaged(lifecycle, repo)
    await lifecycle.recordTarget(allocated.taskId, localMain)
    await freeCheckout(lifecycle, allocated.taskId, allocated.repoWorkspaceId)
    deliverBranch(allocated.managed.checkout)
    await prepare(allocated.managed.checkout, allocated.taskId, allocated.managed.workspaceId)
    const assessments = await lifecycle.check(allocated.taskId)
    assert.equal(only(assessments, allocated.managed.workspaceId).outcome, 'removable')
    const faulty = await openLifecycle({
      root,
      startWorker: faultyWorker(fault, allocated.managed.checkout),
    })
    await expectError(releaseOne(faulty, assessments, allocated.managed.workspaceId), 'unavailable')
    await faulty.close()
    return { ...allocated, assessments }
  }
  const publishReport = async (checkout: string, taskId: WorkspaceId, workspaceId: WorkspaceId) => {
    writeFileSync(join(checkout, 'report.txt'), 'crash fixture\n')
    await lifecycle.recordPublication(
      publication(taskId, workspaceId, 'report.txt', readFileSync(join(checkout, 'report.txt')))
    )
  }
  const viewOf = async (taskId: WorkspaceId, workspaceId: WorkspaceId) =>
    (await lifecycle.inspect({ taskId })).find(item => item.workspaceId === workspaceId)
  await claim(
    'a crash after the release intent leaves an unstarted intent that is only reported; the next explicit resume of the workspace withdraws it and a fresh check is unaffected',
    async () => {
      const { taskId, managed } = await crashed('after-release-intent', publishReport)
      const view = (await lifecycle.inspect({ taskId })).find(
        item => item.workspaceId === managed.workspaceId
      )
      assert.deepEqual(
        view?.pending.map(item => [item.kind, item.stage]),
        [['release', 'intent']]
      )
      assert.equal(view?.outcome, 'preserved-for-resume')
      const intent = view?.pending[0]?.id
      assert.ok(intent !== undefined, 'the unstarted intent is pending')
      assert.ok(existsSync(join(managed.checkout, 'report.txt')), 'nothing was deleted')
      const assessed = only(await lifecycle.check(taskId), managed.workspaceId)
      assert.equal(assessed.outcome, 'removable')
      assert.ok(
        assessed.reasons.some(reason => reason.includes(intent)),
        assessed.reasons.join(' | ')
      )
      const resumed = await lifecycle.attach({
        conversation: conversation(),
        cwd: repo,
        selection: { taskId, workspaceId: managed.workspaceId },
      })
      await resumed.close()
      const after = (await lifecycle.inspect({ taskId })).find(
        item => item.workspaceId === managed.workspaceId
      )
      assert.deepEqual(after?.pending, [], 'the resume withdrew the unstarted intent')
    }
  )
  await claim(
    'a crash after the selected files were deleted but before Git removed the worktree leaves a started release that inspection and check report for review with the actual partial effect; resume is refused, and the next explicit release observes and closes it, then re-evaluates the current state and removes the clean worktree, its result naming the earlier deletion',
    async () => {
      const { taskId, managed } = await crashed('after-selected-files', publishReport)
      assert.ok(!existsSync(join(managed.checkout, 'report.txt')), 'the selected file was deleted')
      assert.ok(existsSync(managed.checkout), 'the worktree directory remains')
      const view = await viewOf(taskId, managed.workspaceId)
      assert.equal(view?.outcome, 'review-required')
      assert.deepEqual(
        view?.pending.map(item => [item.kind, item.stage]),
        [['release', 'started']]
      )
      const attempt = view?.pending[0]?.id
      assert.ok(attempt !== undefined, 'the interrupted attempt is pending')
      const reportsDeletion = namesAttempt(attempt, 'deleted', 'report.txt')
      assert.ok(reportsDeletion(view?.reason), view?.reason)
      const assessed = only(await lifecycle.check(taskId), managed.workspaceId)
      assert.equal(assessed.outcome, 'review-required')
      assert.equal(
        assessed.subject.effect,
        'remove-worktree',
        'the current state still bounds the effect'
      )
      assert.ok(assessed.reasons.some(reportsDeletion), assessed.reasons.join(' | '))
      await expectError(
        lifecycle.attach({
          conversation: conversation(),
          cwd: repo,
          selection: { taskId, workspaceId: managed.workspaceId },
        }),
        'review-required',
        [attempt, managed.workspaceId]
      )
      const result = await releaseOne(lifecycle, await lifecycle.check(taskId), managed.workspaceId)
      assert.equal(result.outcome, 'removed', result.reason)
      assert.ok(reportsDeletion(result.reason), result.reason)
      assert.ok(result.effects.includes(`removed worktree directory ${managed.checkout}`))
      assert.ok(!result.effects.some(reportsDeletion), 'the earlier deletion is not this effect')
      assert.ok(!existsSync(managed.checkout))
      const receipts = (await lifecycle.inspect({ taskId })).filter(
        item => item.workspaceId === managed.workspaceId
      )
      assert.deepEqual(
        receipts.map(item => item.outcome),
        ['removed']
      )
      assert.deepEqual(
        receipts.flatMap(item => item.pending),
        [],
        'the interrupted release is closed'
      )
    }
  )
  await claim(
    'a crash between two selected-file deletions leaves a started release whose manifest lags what was deleted: inspect and check report it for review as stopped during its deletion step, and the next explicit release observes the missing file, names it as observed absent, closes the attempt and removes the worktree',
    async () => {
      const { taskId, managed } = await crashed(
        'during-selected-files',
        async (checkout, task, workspace) => {
          for (const name of ['first.txt', 'second.txt']) {
            writeFileSync(join(checkout, name), `${name}\n`)
            await lifecycle.recordPublication(
              publication(task, workspace, name, readFileSync(join(checkout, name)))
            )
          }
        }
      )
      assert.deepEqual(
        ['first.txt', 'second.txt'].map(name => existsSync(join(managed.checkout, name))),
        [false, true],
        'the crash came after the first deletion'
      )
      const view = await viewOf(taskId, managed.workspaceId)
      assert.equal(view?.outcome, 'review-required')
      assert.deepEqual(
        view?.pending.map(item => [item.kind, item.stage]),
        [['release', 'started']]
      )
      const attempt = view?.pending[0]?.id
      const reportsUnfinished = namesAttempt(attempt, 'deletion step')
      assert.ok(reportsUnfinished(view?.reason), view?.reason)
      const current = await lifecycle.check(taskId)
      assert.equal(only(current, managed.workspaceId).outcome, 'review-required')
      assert.ok(only(current, managed.workspaceId).reasons.some(reportsUnfinished))
      const result = await releaseOne(lifecycle, current, managed.workspaceId)
      assert.equal(result.outcome, 'removed', result.reason)
      assert.ok(namesAttempt(attempt, 'observed absent', 'first.txt')(result.reason), result.reason)
      assert.ok(result.effects.includes('deleted second.txt'))
      assert.ok(!existsSync(managed.checkout))
    }
  )
  await claim(
    'a release bound to the assessment made before an interrupted removal is blocked when a file appeared afterwards, even though the interrupted attempt is observed and closed; the new file remains, and the closed attempt stays reported by the blocked result, check, inspect and the release that finally removes the worktree',
    async () => {
      const { taskId, managed } = await crashed('after-selected-files', publishReport)
      const reportsDeletion = namesAttempt(
        (await viewOf(taskId, managed.workspaceId))?.pending[0]?.id,
        'deleted',
        'report.txt'
      )
      const before = await lifecycle.check(taskId)
      assert.equal(only(before, managed.workspaceId).outcome, 'review-required')
      writeFileSync(join(managed.checkout, 'extra.txt'), 'appeared after the confirmation\n')
      await lifecycle.recordPublication(
        publication(
          taskId,
          managed.workspaceId,
          'extra.txt',
          readFileSync(join(managed.checkout, 'extra.txt'))
        )
      )
      const result = await releaseOne(lifecycle, before, managed.workspaceId)
      assert.equal(result.outcome, 'blocked', result.reason)
      assert.ok(reportsDeletion(result.reason), result.reason)
      assert.deepEqual(result.effects, [], 'this command changed nothing')
      assert.ok(
        existsSync(join(managed.checkout, 'extra.txt')),
        'the file that appeared later remains'
      )
      assert.ok(existsSync(managed.checkout))
      const view = await viewOf(taskId, managed.workspaceId)
      assert.deepEqual(view?.pending, [], 'the interrupted attempt is closed')
      assert.ok(reportsDeletion(view?.reason), view?.reason)
      const current = await lifecycle.check(taskId)
      assert.ok(only(current, managed.workspaceId).reasons.some(reportsDeletion))
      const fresh = await releaseOne(lifecycle, current, managed.workspaceId)
      assert.equal(fresh.outcome, 'removed', fresh.reason)
      assert.ok(reportsDeletion(fresh.reason), fresh.reason)
      assert.ok(fresh.effects.includes('deleted extra.txt'))
    }
  )
  await claim(
    'a crash after Git removed the worktree but before the outcome was recorded is reported for review with the observed absence; no startup or inspection reconciles it, and the next explicit release observes the completed removal as already-absent and resolves the reservation',
    async () => {
      const { taskId, managed } = await crashed('after-git-remove', async () => undefined)
      assert.ok(!existsSync(managed.checkout), 'Git removed the directory')
      assert.ok(!registered(repo).includes(managed.checkout))
      const view = (await lifecycle.inspect({ taskId })).find(
        item => item.workspaceId === managed.workspaceId
      )
      assert.equal(view?.outcome, 'review-required')
      assert.deepEqual(
        view?.pending.map(item => [item.kind, item.stage]),
        [['release', 'started']]
      )
      const result = await releaseOne(lifecycle, await lifecycle.check(taskId), managed.workspaceId)
      assert.equal(result.outcome, 'already-absent', result.reason)
      assert.deepEqual(await lifecycle.check(taskId), [])
      const receipt = (await lifecycle.inspect({ taskId })).find(
        item => item.workspaceId === managed.workspaceId
      )
      assert.equal(receipt?.outcome, 'already-absent')
    }
  )

  const releaseRemaining = async (taskId: WorkspaceId) => {
    for (const { workspaceId } of await lifecycle.check(taskId))
      await releaseOne(lifecycle, await lifecycle.check(taskId), workspaceId)
    assert.deepEqual(await lifecycle.check(taskId), [])
  }
  await claim(
    'a release whose reply is lost after the worker committed the first workspace reports it as review-required with its outcome unknown and stops: the next workspace is reported as not attempted and keeps its reservation, the committed effect is real, and the summary says review is required rather than partial',
    async () => {
      const allocated = await allocateManaged(lifecycle, repo)
      await lifecycle.recordTarget(allocated.taskId, localMain)
      const assessments = await lifecycle.check(allocated.taskId)
      assert.equal(assessments.length, 2)
      const lostAck = faultInjector()
      const faulty = await openLifecycle({ root, startWorker: lostAck.startWorker })
      lostAck.dropNextAcknowledgment('release')
      const run = await Effect.runPromise(
        runRelease(faulty.effect, {
          taskId: allocated.taskId,
          confirmed: assessments,
          occupiedPaths: [],
        })
      )
      await faulty.close()
      assert.deepEqual(lostAck.dropped, ['release'])
      const [attempted, stopped] = run.results
      assert.ok(
        attempted !== undefined && stopped !== undefined,
        'every confirmed workspace is reported'
      )
      assert.deepEqual(
        [attempted.outcome, stopped.outcome, stopped.effects],
        ['review-required', 'blocked', []]
      )
      assert.equal(releaseExitCode(run), 1)
      const receipt = formatReleaseRun(allocated.taskId, run)
      assert.ok(receipt.includes(attempted.path) && receipt.includes(stopped.path), receipt)
      assert.ok(receipt.includes('Summary: review required'), receipt)
      assert.deepEqual(
        (await lifecycle.check(allocated.taskId)).map(assessment => assessment.workspaceId),
        [stopped.workspaceId],
        'only the unattempted workspace is still reserved'
      )
      assert.ok(
        ['released', 'removed'].includes(
          (await viewOf(allocated.taskId, attempted.workspaceId))?.outcome ?? ''
        ),
        'the committed effect is visible to inspect'
      )
      await releaseRemaining(allocated.taskId)
    }
  )
  await claim(
    'a workspace added to the task between two attempts of one command refuses the later attempt before any effect, while the receipt keeps the earlier completed attempt and summarises the command as partial rather than claiming nothing was released',
    async () => {
      const allocated = await allocateManaged(lifecycle, repo)
      await lifecycle.recordTarget(allocated.taskId, localMain)
      const assessments = await lifecycle.check(allocated.taskId)
      assert.equal(assessments.length, 2)
      let intruded = false
      const intruding: WorkspaceLifecycle = {
        ...lifecycle.effect,
        release: input =>
          lifecycle.effect.release(input).pipe(
            Effect.tap(() =>
              Effect.promise(async () => {
                if (intruded) return
                intruded = true
                const other = assessments.find(item => item.workspaceId !== input.workspaceId)
                if (other === undefined) throw new Error('the task has a refused workspace')
                await allocateManaged(lifecycle, other.path, {
                  taskId: allocated.taskId,
                  workspaceId: other.workspaceId,
                })
              })
            )
          ),
      }
      const run = await Effect.runPromise(
        runRelease(intruding, {
          taskId: allocated.taskId,
          confirmed: assessments,
          occupiedPaths: [],
        })
      )
      const [completed, refused] = run.results
      assert.ok(
        completed !== undefined && refused !== undefined,
        'every confirmed workspace is reported'
      )
      assert.ok(['released', 'removed'].includes(completed.outcome), completed.reason)
      assert.deepEqual([refused.outcome, refused.effects], ['blocked', []])
      const receipt = formatReleaseRun(allocated.taskId, run)
      assert.ok(receipt.includes('Summary: partial'), receipt)
      assert.ok(!receipt.includes('Nothing was released'), receipt)
      await releaseRemaining(allocated.taskId)
    }
  )
  await claim(
    'a removal Git stops after deleting the worktree directory and emptying its admin directory lists both effects and the command as partial, never as nothing changed; check then names the exact admin directory left behind, and a fresh release removes exactly that empty directory, without a prune, and settles as already-absent',
    async () => {
      const allocated = await allocateManaged(lifecycle, repo)
      await lifecycle.recordTarget(allocated.taskId, localMain)
      await freeCheckout(lifecycle, allocated.taskId, allocated.repoWorkspaceId)
      const assessments = await lifecycle.check(allocated.taskId)
      assert.equal(only(assessments, allocated.managed.workspaceId).outcome, 'removable')
      const adminPath = git(
        ['rev-parse', '--path-format=absolute', '--git-dir'],
        allocated.managed.checkout
      )
      const admins = join(repo, '.git', 'worktrees')
      const { mode } = statSync(admins)
      chmodSync(admins, 0o500)
      const run = await Effect.runPromise(
        runRelease(lifecycle.effect, {
          taskId: allocated.taskId,
          confirmed: assessments,
          occupiedPaths: [],
        })
      ).finally(() => chmodSync(admins, mode))
      const [stopped] = run.results
      assert.equal(stopped?.outcome, 'partial', stopped?.reason)
      assert.ok(
        stopped.effects.includes(`removed worktree directory ${allocated.managed.checkout}`),
        stopped.effects.join('; ')
      )
      assert.ok(!existsSync(allocated.managed.checkout))
      const receipt = formatReleaseRun(allocated.taskId, run)
      assert.ok(receipt.includes('Summary: partial'), receipt)
      assert.ok(
        stopped.effects.some(
          effect => effect.includes('unregistered') && effect.includes(adminPath)
        ),
        stopped.effects.join('; ')
      )
      const residue = only(await lifecycle.check(allocated.taskId), allocated.managed.workspaceId)
      assert.ok(
        residue.reasons.some(reason => reason.includes(adminPath)),
        residue.reasons.join(' | ')
      )

      const foreign = join(sandbox, `foreign-${allocated.managed.workspaceId}`)
      git(['worktree', 'add', '--quiet', '--detach', foreign, 'HEAD'], repo)
      const foreignAdmin = git(['rev-parse', '--path-format=absolute', '--git-dir'], foreign)
      rmSync(foreign, { recursive: true, force: true })
      const settled = await releaseOne(
        lifecycle,
        await lifecycle.check(allocated.taskId),
        allocated.managed.workspaceId
      )
      assert.equal(settled.outcome, 'already-absent', settled.reason)
      assert.ok(
        settled.effects.includes(`removed the empty admin directory ${adminPath}`),
        settled.effects.join('; ')
      )
      assert.ok(!existsSync(adminPath))
      assert.ok(existsSync(foreignAdmin), 'the foreign prunable registration was not pruned')
      git(['worktree', 'prune'], repo)
      assert.deepEqual(await lifecycle.check(allocated.taskId), [])
    }
  )
  await claim(
    'a managed worktree the user moved with git worktree move is never offered for removal: check and release keep its admin directory and name the moved worktree, which stays registered; moved back, it is removed normally',
    async () => {
      const allocated = await allocateManaged(lifecycle, repo)
      await lifecycle.recordTarget(allocated.taskId, localMain)
      await freeCheckout(lifecycle, allocated.taskId, allocated.repoWorkspaceId)
      const { checkout, workspaceId } = allocated.managed
      const adminPath = git(['rev-parse', '--path-format=absolute', '--git-dir'], checkout)
      const moved = join(sandbox, `moved-${workspaceId}`)
      git(['worktree', 'move', checkout, moved], repo)
      const kept = only(await lifecycle.check(allocated.taskId), workspaceId)
      assert.deepEqual([kept.outcome, kept.subject.effect], ['review-required', 'none'])
      assert.ok(
        kept.reasons.some(reason => reason.includes(moved)),
        kept.reasons.join(' | ')
      )
      assert.ok(
        !kept.nextActions.some(action => action.includes('remove it')),
        kept.nextActions.join(' | ')
      )
      const refused = await releaseOne(
        lifecycle,
        await lifecycle.check(allocated.taskId),
        workspaceId
      )
      assert.equal(refused.outcome, 'review-required', refused.reason)
      assert.ok(existsSync(adminPath), 'the moved worktree keeps its admin directory')
      assert.ok(registered(repo).includes(moved), 'the moved worktree is still registered')
      git(['worktree', 'move', moved, checkout], repo)
      const back = await releaseOne(lifecycle, await lifecycle.check(allocated.taskId), workspaceId)
      assert.equal(back.outcome, 'removed', back.reason)
    }
  )
  await claim(
    'a removal Git stops inside the worktree directory after dropping its registration names that unregistered directory for the user to remove, since dev never deletes one; once it is gone the next release settles as already-absent',
    async () => {
      const allocated = await allocateManaged(lifecycle, repo)
      await lifecycle.recordTarget(allocated.taskId, localMain)
      await freeCheckout(lifecycle, allocated.taskId, allocated.repoWorkspaceId)
      const assessments = await lifecycle.check(allocated.taskId)
      const { checkout, workspaceId } = allocated.managed
      const parent = dirname(checkout)
      const { mode } = statSync(parent)
      chmodSync(parent, 0o500)
      const run = await Effect.runPromise(
        runRelease(lifecycle.effect, {
          taskId: allocated.taskId,
          confirmed: assessments,
          occupiedPaths: [],
        })
      ).finally(() => chmodSync(parent, mode))
      const [stopped] = run.results
      assert.equal(stopped?.outcome, 'partial', stopped?.reason)
      assert.ok(existsSync(checkout), 'the directory itself remains')
      assert.ok(!registered(repo).includes(checkout), 'Git no longer lists it')
      assert.ok(stopped.nextAction.includes(checkout), stopped.nextAction)
      rmSync(checkout, { recursive: true, force: true })
      const settled = await releaseOne(
        lifecycle,
        await lifecycle.check(allocated.taskId),
        workspaceId
      )
      assert.equal(settled.outcome, 'already-absent', settled.reason)
    }
  )
  await claim(
    'a managed worktree whose directory is already gone is reported for review with the observed absence; its release reconciles the registration and reservation as already-absent without deleting anything',
    async () => {
      const allocated = await allocateManaged(lifecycle, repo)
      await lifecycle.recordTarget(allocated.taskId, localMain)
      await freeCheckout(lifecycle, allocated.taskId, allocated.repoWorkspaceId)
      const adminPath = git(
        ['rev-parse', '--path-format=absolute', '--git-dir'],
        allocated.managed.checkout
      )
      rmSync(allocated.managed.checkout, { recursive: true, force: true })
      const assessments = await lifecycle.check(allocated.taskId)
      const managed = only(assessments, allocated.managed.workspaceId)
      assert.equal(managed.outcome, 'review-required')
      assert.equal(managed.subject.effect, 'remove-worktree')
      assert.equal(managed.subject.head, undefined, 'no HEAD is read from an absent directory')
      const result = await releaseOne(lifecycle, assessments, allocated.managed.workspaceId)
      assert.equal(result.outcome, 'already-absent', result.reason)
      assert.ok(!existsSync(adminPath), 'the targeted registration is gone')
      assert.ok(!registered(repo).includes(allocated.managed.checkout))
      const receipt = (await lifecycle.inspect({ taskId: allocated.taskId })).find(
        view => view.workspaceId === allocated.managed.workspaceId
      )
      assert.equal(receipt?.outcome, 'already-absent')
    }
  )
  await claim(
    'symlinked installation coordination is unverifiable and blocks before deleting a selected report or any worktree content',
    async () => {
      for (const relative of ['.dev', '.dev/coordination']) {
        const source = await allocateManaged(lifecycle, repo)
        await lifecycle.recordTarget(source.taskId, localMain)
        await freeCheckout(lifecycle, source.taskId, source.repoWorkspaceId)
        deliverBranch(source.managed.checkout)
        const outside = mkdtempSync(join(sandbox, 'linked-coordination-'))
        writeFileSync(join(outside, 'sentinel'), 'outside coordination stays untouched')
        const link = join(source.managed.checkout, relative)
        mkdirSync(dirname(link), { recursive: true })
        symlinkSync(outside, link)
        const report = join(source.managed.checkout, 'selected.log')
        writeFileSync(report, 'selected report')
        await lifecycle.recordPublication(
          publication(
            source.taskId,
            source.managed.workspaceId,
            'selected.log',
            readFileSync(report)
          )
        )
        const result = await releaseOne(
          lifecycle,
          await lifecycle.check(source.taskId),
          source.managed.workspaceId
        )
        assert.equal(result.outcome, 'blocked', result.reason)
        assert.match(result.reason, /Target installation coordination/)
        assert.deepEqual(result.effects, [])
        assert.equal(readFileSync(report, 'utf8'), 'selected report')
        assert.equal(
          readFileSync(join(outside, 'sentinel'), 'utf8'),
          'outside coordination stays untouched'
        )
      }
    }
  )
  await claim(
    'a managed installation stays protected independently of cwd, an unrelated installation does not block disposal, and startup cannot split the removal gate or recreate a removed installation',
    async () => {
      const source = await allocateManaged(lifecycle, repo)
      await lifecycle.recordTarget(source.taskId, localMain)
      await freeCheckout(lifecycle, source.taskId, source.repoWorkspaceId)
      deliverBranch(source.managed.checkout)
      const options = { installationPath: source.managed.checkout, namespacePath: root }
      const dataHome = join(sandbox, 'source-session-outside-checkout')
      const scope = Scope.makeUnsafe()
      const database = join(source.managed.checkout, '.dev', 'coordination', 'installation.sqlite')
      try {
        await Effect.runPromise(Scope.provide(scope)(acquireRuntime(dataHome, options)))
        const identity = statSync(database).ino
        const blocked = await releaseOne(
          lifecycle,
          await lifecycle.check(source.taskId),
          source.managed.workspaceId
        )
        assert.equal(blocked.outcome, 'blocked', blocked.reason)
        assert.deepEqual(blocked.effects, [])
        assert.equal(statSync(database).ino, identity)
        const unrelated = await allocateManaged(lifecycle, repo)
        await lifecycle.recordTarget(unrelated.taskId, localMain)
        await freeCheckout(lifecycle, unrelated.taskId, unrelated.repoWorkspaceId)
        const removed = await releaseOne(
          lifecycle,
          await lifecycle.check(unrelated.taskId),
          unrelated.managed.workspaceId
        )
        assert.equal(removed.outcome, 'removed', removed.reason)
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
        const blocked = await releaseOne(
          lifecycle,
          await lifecycle.check(source.taskId),
          source.managed.workspaceId
        )
        assert.equal(blocked.outcome, 'blocked', blocked.reason)
        assert.match(blocked.reason, /Target installation coordination/)
        assert.deepEqual(blocked.effects, [])
        assert.ok(existsSync(database))
      } finally {
        await Effect.runPromise(Scope.close(unexpectedScope, Exit.void))
      }
      const maintenance = Scope.makeUnsafe()
      try {
        await Effect.runPromise(Scope.provide(maintenance)(acquireMaintenance(options)))
        const blocked = await releaseOne(
          lifecycle,
          await lifecycle.check(source.taskId),
          source.managed.workspaceId
        )
        assert.equal(blocked.outcome, 'blocked', blocked.reason)
        assert.deepEqual(blocked.effects, [])
      } finally {
        await Effect.runPromise(Scope.close(maintenance, Exit.void))
      }
      const saved = join(sandbox, 'saved-installation.sqlite')
      renameSync(database, saved)
      try {
        const blocked = await releaseOne(
          lifecycle,
          await lifecycle.check(source.taskId),
          source.managed.workspaceId
        )
        assert.equal(blocked.outcome, 'blocked', blocked.reason)
        assert.deepEqual(blocked.effects, [])
        assert.equal(
          existsSync(database),
          false,
          'cleanup must not recreate an uncertain installation lock'
        )
      } finally {
        renameSync(saved, database)
      }
      const removed = await releaseOne(
        lifecycle,
        await lifecycle.check(source.taskId),
        source.managed.workspaceId
      )
      assert.equal(removed.outcome, 'removed', removed.reason)
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
    'a delegated child is delivered by a pull request merged after its allocation whose source strictly descends from its base, found through a task-owned sibling HEAD it contains, its base or the recorded pull request; any refuted condition, or own commits no merged source or target keeps, leaves it not integrated, while unreadable sibling history leaves it unknown',
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
        [
          "the child's own commits are in no merged pull request or target",
          childVerdict(reader({ mergedPullRequestsForCommit: seeded(githubMain) }), {
            base: githubMain,
            head: extendedSource,
            siblings: [],
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
    'the workspace tool records a target override, records a publication only after the destination body or an attachment reads back the exact bytes, and resumes onto a retained workspace through the authority selection',
    async () => {
      const allocated = await allocateManaged(lifecycle, repo)
      await freeCheckout(lifecycle, allocated.taskId, allocated.repoWorkspaceId)
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
      assert.equal(managed.outcome, 'removable', managed.reasons.join(' '))
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

      const assessments = await lifecycle.check(originTask)
      const assessment = only(assessments, origin.workspaceId)
      assert.equal(assessment.outcome, 'releasable', assessment.reasons.join(' | '))
      assert.equal(assessment.subject.effect, 'release-reservation')
      const released = await releaseOne(lifecycle, assessments, origin.workspaceId)
      assert.equal(released.outcome, 'released', released.reason)
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
