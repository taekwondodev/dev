import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { inDb, type WorkspaceAuthority } from './workspace-authority.ts'
import { blocked, requireReview } from './workspace-domain.ts'
import {
  acquirePathGates,
  acquireStructureGate,
  conversationIdentity,
  conversationPresent,
  releaseGates,
  type PathGates,
} from './workspace-gates.ts'
import { canonicalGitWorkspace, gitResult, symbolicBranch } from './workspace-git.ts'
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

export const cleanupUpgradeWorkspace = (
  authority: WorkspaceAuthority,
  installation: string
): string => {
  const source = canonicalGitWorkspace(installation)
  if (
    source.path !== realpathSync(installation) ||
    source.gitAdminPath !== source.commonPath ||
    symbolicBranch(source.path) !== 'refs/heads/main'
  )
    return 'Upgrade cleanup skipped: run npm run update from the main installation checkout on main.\n'
  const path = join(source.path, '.dev', 'upgrade', 'worktree')
  if (lstatIfExists(join(source.path, '.dev', 'upgrade')) === undefined) return ''
  if (canonicalPathSlot(path) !== path)
    requireReview(`Upgrade worktree path is not canonical: ${path}`)
  const repo = authority.registerRepository(source)
  const structure = acquireStructureGate(authority.paths, source, repo)
  let gates: PathGates | undefined
  try {
    gates = acquirePathGates(authority.paths, path, 'removal')
    const workspace = inDb(authority, repo, db => {
      const record = getWorkspaceByPath(db, path)
      if (record === undefined) return undefined
      if (record.origin !== 'pre-existing' || record.status !== 'ready')
        requireReview(`Upgrade checkout is not a ready pre-existing workspace: ${path}`)
      if (
        getReservation(db, record.id) !== undefined ||
        getUseRows(db, record.id).some(isActiveUse) ||
        openOperations(db, record.id).length > 0 ||
        getBindingRows(db, record.id).some(
          binding =>
            binding.superseded !== true &&
            conversationPresent(authority.paths, conversationIdentity(binding.conversation))
        )
      )
        blocked(`Upgrade workspace still has a reservation, use or pending operation: ${path}`)
      return record
    })
    const entry = git(source.path, ['worktree', 'list', '--porcelain', '-z'])
      .split('\0\0')
      .map(value => value.split('\0'))
      .find(fields => fields.includes(`worktree ${path}`))
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
      : `Removed upgrade worktree${branch === undefined ? '' : ` and local branch ${branch}`}; workspace inventory reconciled.\n`
  } finally {
    if (gates !== undefined) releaseGates(gates)
    structure()
  }
}
