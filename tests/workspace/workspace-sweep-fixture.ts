import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Effect from 'effect/Effect'
import * as Stream from 'effect/Stream'
import type {
  SweepReceipt,
  SweepRow,
  TaskTarget,
  WorkspaceGrant,
  WorkspaceId,
} from '../../src/workspace-domain.ts'
import { newId } from '../../src/workspace-platform.ts'
import {
  openLifecycle,
  type TestAttachment,
  type TestLifecycle,
} from './workspace-test-lifecycle.ts'

export const sweepSandbox = (name: string): string =>
  realpathSync(mkdtempSync(join(tmpdir(), `dev-${name}-`)))

export const git = (args: readonly string[], cwd: string): string =>
  execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()
export const localMain: TaskTarget = { kind: 'local', ref: 'refs/heads/main' }

export const ready = (result: Awaited<ReturnType<TestAttachment['authorize']>>): WorkspaceGrant => {
  if (result.kind !== 'ready')
    throw new Error(`expected a ready grant, got ${JSON.stringify(result)}`)
  return result.grant
}
export const taskOf = (grant: WorkspaceGrant): WorkspaceId => {
  if (grant.taskId === undefined) throw new Error('a write grant carries a task identity')
  return grant.taskId
}
type WorkspaceRow = Extract<SweepRow, { readonly kind: 'workspace' }>
type ArtifactsRow = Extract<SweepRow, { readonly kind: 'task-artifacts' }>
export const artifactsRowOf = (
  receipt: SweepReceipt,
  taskId: WorkspaceId
): ArtifactsRow | undefined =>
  receipt.rows.find(
    (entry): entry is ArtifactsRow => entry.kind === 'task-artifacts' && entry.taskId === taskId
  )
export const rowOf = (receipt: SweepReceipt, workspaceId: WorkspaceId): WorkspaceRow => {
  const row = receipt.rows.find(
    (entry): entry is WorkspaceRow =>
      entry.kind === 'workspace' && entry.workspaceId === workspaceId
  )
  if (row === undefined)
    throw new Error(`no receipt row for ${workspaceId}: ${JSON.stringify(receipt.rows)}`)
  return row
}
export const receiptsOf = async (attachment: TestAttachment) => {
  const closing = attachment.close()
  const receipts = await Effect.runPromise(Stream.runCollect(attachment.effect.sweeps))
  await closing
  return receipts
}
export const sweepWith = (
  using: TestLifecycle,
  anchor: WorkspaceId,
  delegatedCwds: readonly string[] = []
) =>
  using.sweep({
    moment: 'quit',
    anchorWorkspaceId: anchor,
    delegatedCwds,
    occupiedPaths: [],
  })

export const openSweepFixture = async (sandbox: string) => {
  const root = join(sandbox, 'authority')
  let conversationCount = 0
  const conversation = () => {
    conversationCount += 1
    const dataHome = join(sandbox, `data-${conversationCount}`)
    mkdirSync(dataHome, { recursive: true })
    const sessionFile = join(dataHome, 'session.jsonl')
    writeFileSync(sessionFile, '{}\n', { mode: 0o600 })
    return { sessionId: `sweep-${conversationCount}`, sessionFile, dataHome }
  }

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
  return {
    root,
    repo,
    lifecycle,
    conversation,
    userCheckout,
    reserve,
    deliverBranch,
    sweepAtQuit,
  }
}
