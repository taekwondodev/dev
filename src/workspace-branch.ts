import type { WorkspaceAuthority } from './workspace-authority.ts'
import { blocked, invalid, type DevBranchRequest } from './workspace-domain.ts'
import { acquireStructureGate } from './workspace-gates.ts'
import { canonicalGitWorkspace, gitResult, hasCommit } from './workspace-git.ts'

const DEV_BRANCH = /^dev\/orb-(return|recovery)\/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/
const SUFFIX_LIMIT = 100

const refOf = (name: string): string => `refs/heads/${name}`

const failure = (result: { readonly stderr: string; readonly status: number | null }): string =>
  result.stderr.trim() || `exit ${result.status ?? 'signal'}`

const tipOf = (checkout: string, name: string): string | undefined => {
  const result = gitResult(checkout, ['rev-parse', '--verify', '--quiet', refOf(name)])
  if (result.status === 0) return result.stdout.trim()
  if (result.status === 1) return undefined
  return blocked(`Cannot read ${refOf(name)}: ${failure(result)}`)
}

const checkedOutBranches = (checkout: string): ReadonlySet<string> => {
  const result = gitResult(checkout, ['worktree', 'list', '--porcelain', '-z'])
  if (result.status !== 0) blocked(`Cannot list worktrees: ${failure(result)}`)
  return new Set(
    result.stdout
      .split('\0')
      .filter(line => line.startsWith('branch '))
      .map(line => line.slice('branch '.length))
  )
}

const updateRef = (checkout: string, name: string, commit: string, expected: string): void => {
  const result = gitResult(checkout, ['update-ref', '--no-deref', refOf(name), commit, expected])
  if (result.status !== 0) blocked(`Cannot write ${refOf(name)}: ${failure(result)}`)
}

export const writeDevBranch = (
  authority: WorkspaceAuthority,
  request: DevBranchRequest
): { readonly name: string } => {
  if (!DEV_BRANCH.test(request.name)) invalid(`Not a dev-owned branch name: ${request.name}`)
  const { replacing } = request
  if (
    replacing !== undefined &&
    replacing.name !== request.name &&
    !(
      replacing.name.startsWith(`${request.name}-`) &&
      /^([2-9]|[1-9][0-9]|100)$/.test(replacing.name.slice(request.name.length + 1))
    )
  )
    invalid(`${replacing.name} is not ${request.name} or one of its suffixes`)
  for (const commit of [request.commit, ...(replacing === undefined ? [] : [replacing.commit])])
    if (!COMMIT.test(commit)) invalid(`Not a full commit id: ${commit}`)
  const repository = canonicalGitWorkspace(request.cwd)
  const checkout = repository.path
  if (!hasCommit(checkout, request.commit))
    invalid(`Commit ${request.commit} is not in the repository at ${checkout}`)
  const repositoryId = authority.registerRepository(repository)
  const release = acquireStructureGate(authority.paths, repository, repositoryId)
  try {
    const checkedOut = checkedOutBranches(checkout)
    if (replacing !== undefined && !checkedOut.has(refOf(replacing.name))) {
      const tip = tipOf(checkout, replacing.name)
      if (tip === request.commit) return { name: replacing.name }
      if (tip === replacing.commit) {
        updateRef(checkout, replacing.name, request.commit, replacing.commit)
        return { name: replacing.name }
      }
    }
    for (let suffix = 1; suffix <= SUFFIX_LIMIT; suffix += 1) {
      const name = suffix === 1 ? request.name : `${request.name}-${suffix}`
      if (checkedOut.has(refOf(name))) continue
      const tip = tipOf(checkout, name)
      if (tip === request.commit) return { name }
      if (tip !== undefined) continue
      updateRef(checkout, name, request.commit, '')
      return { name }
    }
    return blocked(`${request.name} and its first ${SUFFIX_LIMIT - 1} suffixes already exist`)
  } finally {
    release()
  }
}
