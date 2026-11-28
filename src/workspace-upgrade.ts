import { mkdirSync, realpathSync, rmSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { inDb, type WorkspaceAuthority } from './workspace-authority.ts'
import { blocked, requireReview, WorkspaceError, type WorkspaceId } from './workspace-domain.ts'
import {
  acquirePathGates,
  acquireStructureGate,
  conversationIdentity,
  conversationPresent,
  type GateRelease,
  type PathGates,
  releaseGates,
} from './workspace-gates.ts'
import {
  canonicalGitWorkspace,
  gitResult,
  symbolicBranch,
  type GitWorkspace,
} from './workspace-git.ts'
import {
  getBindingRows,
  getReservation,
  getUseRows,
  getWorkspaceByPath,
  isActiveUse,
  matchesGitWorkspace,
  openOperations,
  saveWorkspace,
} from './workspace-records.ts'
import { hash, lstatIfExists } from './workspace-platform.ts'
import { canonicalPathSlot } from './workspace-paths.ts'
import { transaction } from './workspace-sqlite.ts'

export const upgradeBranch = /^chore\/upgrade-\d{4}-\d{2}-\d{2}(?:-\d+)?$/

const git = (checkout: string, args: readonly string[]): string => {
  const result = gitResult(checkout, args)
  if (result.status !== 0)
    blocked(`Upgrade cleanup Git ${args.join(' ')} failed: ${result.stderr.trim()}`)
  return result.stdout.trimEnd()
}

const removeCandidate = (candidate: string): string => {
  const info = lstatIfExists(candidate)
  if (info === undefined) return ''
  if (info.isSymbolicLink()) requireReview(`Prepared Pi path is a symbolic link: ${candidate}`)
  rmSync(candidate, { recursive: true, force: true })
  return 'Removed the Pi release prepared by npm run pi:update.\n'
}

const occupied = (authority: WorkspaceAuthority, db: DatabaseSync, id: WorkspaceId): boolean =>
  getUseRows(db, id).some(isActiveUse) ||
  openOperations(db, id).length > 0 ||
  getBindingRows(db, id).some(
    binding =>
      binding.superseded !== true &&
      conversationPresent(authority.paths, conversationIdentity(binding.conversation))
  )

export interface UpgradeWorktreeClaim {
  readonly installation: string
  readonly source: GitWorkspace
  readonly repo: WorkspaceId
  readonly path: string
  readonly structure: () => GateRelease
  readonly release: GateRelease
}

const whenBusy = <A>(acquire: () => A, message: string): A => {
  try {
    return acquire()
  } catch (cause) {
    if (cause instanceof WorkspaceError && cause.outcome === 'blocked') blocked(message)
    throw cause
  }
}

export const claimUpgradeWorktree = (
  authority: WorkspaceAuthority,
  installation: string
): UpgradeWorktreeClaim => {
  const root = realpathSync(installation)
  const path = join(root, '.dev', 'upgrade', 'worktree')
  mkdirSync(join(root, '.dev', 'upgrade'), { recursive: true, mode: 0o700 })
  if (canonicalPathSlot(path) !== path)
    requireReview(`Upgrade worktree path is not canonical: ${path}`)
  const source = canonicalGitWorkspace(root)
  const repo = authority.registerRepository(source)
  const gates: PathGates = whenBusy(
    () => acquirePathGates(authority.paths, path, 'removal'),
    `The upgrade worktree ${path} is in use by a dev session, npm run pi:update or npm run update. Quit that session or let the command finish, then retry.`
  )
  try {
    inDb(authority, repo, db => {
      const record = getWorkspaceByPath(db, path)
      if (record !== undefined && occupied(authority, db, record.id))
        blocked(
          `The upgrade worktree ${path} is kept by an open dev session, a pending operation or work an ended session left unsettled. Run dev --cwd ${root} workspace list to see which and its next step, then retry.`
        )
    })
  } catch (cause) {
    releaseGates(gates)
    throw cause
  }
  return {
    installation: root,
    source,
    repo,
    path,
    structure: () =>
      whenBusy(
        () => acquireStructureGate(authority.paths, source, repo),
        `Another dev operation is creating or removing a worktree of ${source.commonPath}. Retry in a moment.`
      ),
    release: () => releaseGates(gates),
  }
}

export const cleanupUpgradeWorkspace = (
  authority: WorkspaceAuthority,
  claim: UpgradeWorktreeClaim,
  piCandidate: string
): string => {
  const { source } = claim
  if (
    source.path !== claim.installation ||
    source.gitAdminPath !== source.commonPath ||
    symbolicBranch(source.path) !== 'refs/heads/main'
  )
    return 'Upgrade cleanup skipped: run npm run update from the main installation checkout on main.\n'
  return removeUpgradeWorktree(authority, claim) + removeCandidate(piCandidate)
}

const removeUpgradeWorktree = (
  authority: WorkspaceAuthority,
  { source, repo, path, structure: acquireStructure }: UpgradeWorktreeClaim
): string => {
  const structure = acquireStructure()
  try {
    const workspace = inDb(authority, repo, db => {
      const record = getWorkspaceByPath(db, path)
      if (record === undefined) return undefined
      if (record.origin !== 'pre-existing' || record.status !== 'ready')
        requireReview(`Upgrade checkout is not ready or not pre-existing: ${path}`)
      if (getReservation(db, record.id) !== undefined || occupied(authority, db, record.id))
        blocked(
          `Upgrade checkout is still kept for a task, in use or has a pending operation: ${path}`
        )
      return record
    })
    const entry = git(source.path, ['worktree', 'list', '--porcelain', '-z'])
      .split('\0\0')
      .map(value => value.split('\0'))
      .find(fields =>
        fields.some(field => {
          if (!field.startsWith('worktree ')) return false
          const listed = field.slice('worktree '.length)
          if (listed === path) return true
          try {
            return realpathSync(listed) === path
          } catch {
            return false
          }
        })
      )
    const branch = entry
      ?.find(field => field.startsWith('branch refs/heads/'))
      ?.slice('branch refs/heads/'.length)
    if (branch !== undefined && !upgradeBranch.test(branch))
      requireReview(`Upgrade worktree has an unexpected branch: ${branch}`)
    if (lstatIfExists(path) !== undefined) {
      const actual = canonicalGitWorkspace(path)
      if (
        actual.path !== path ||
        actual.commonPath !== source.commonPath ||
        (workspace !== undefined && !matchesGitWorkspace(workspace, actual))
      )
        requireReview(`Upgrade worktree identity changed: ${path}`)
      if (entry === undefined) requireReview(`Upgrade worktree is not registered with Git: ${path}`)
    } else if (
      entry === undefined &&
      workspace !== undefined &&
      lstatIfExists(workspace.gitAdminPath) !== undefined
    ) {
      requireReview(`Upgrade Git administration still exists at ${workspace.gitAdminPath}`)
    }
    if (entry !== undefined) git(source.path, ['worktree', 'remove', '--force', '--', path])
    if (lstatIfExists(path) !== undefined)
      requireReview(`Upgrade worktree remains after removal: ${path}`)
    if (workspace !== undefined)
      inDb(authority, repo, db =>
        transaction(db, () =>
          saveWorkspace(db, {
            ...workspace,
            status: 'removed',
            pathKey: hash(workspace.id),
            revision: workspace.revision + 1,
          })
        )
      )
    if (branch !== undefined) git(source.path, ['branch', '--delete', '--force', '--', branch])
    return entry === undefined && workspace === undefined
      ? ''
      : `Removed upgrade worktree${branch === undefined ? '' : ` and local branch ${branch}`}; checkout inventory reconciled.\n`
  } finally {
    structure()
  }
}
