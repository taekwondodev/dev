import { realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, isAbsolute, resolve } from 'node:path'
import { Option, Schema } from 'effect'
import { WorkspaceError } from './workspace-domain.ts'
import { FileIdentitySchema, observePhysicalIdentities } from './workspace-identity.ts'
import { hasErrorCode, regularFileDigest } from './workspace-platform.ts'
import { errorText } from './error-text.ts'

const GitWorkspaceSchema = Schema.Struct({
  path: Schema.NonEmptyString,
  identity: FileIdentitySchema,
  identityDevice: Schema.NonEmptyString,
  commonPath: Schema.NonEmptyString,
  commonIdentity: FileIdentitySchema,
  commonDevice: Schema.NonEmptyString,
  gitAdminPath: Schema.NonEmptyString,
  gitAdminIdentity: FileIdentitySchema,
  gitAdminDevice: Schema.NonEmptyString,
  objectFormat: Schema.NonEmptyString,
  head: Schema.String,
})
export type GitWorkspace = typeof GitWorkspaceSchema.Type
const decodeGitWorkspace = Schema.decodeUnknownOption(GitWorkspaceSchema)

const gitBlocked = (message: string): WorkspaceError =>
  new WorkspaceError({ outcome: 'blocked', message })

export interface GitResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

export const gitResult = (cwd: string, args: readonly string[], input?: string): GitResult => {
  const result = spawnSync(
    'git',
    [
      '--no-pager',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'submodule.recurse=false',
      '-c',
      'core.untrackedCache=false',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      input,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30_000,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
        ),
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
        GIT_NO_LAZY_FETCH: '1',
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_GRAFT_FILE: '/dev/null',
      },
    }
  )
  if (result.error !== undefined) throw gitBlocked(`Cannot run Git: ${result.error.message}`)
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

const git = (cwd: string, args: readonly string[], input?: string): string => {
  const result = gitResult(cwd, args, input)
  if (result.status !== 0)
    throw gitBlocked(
      `Git ${args[0] ?? 'command'} failed${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`
    )
  return result.stdout.replace(/\n$/, '')
}

export const canonicalGitWorkspace = (cwd: string): GitWorkspace => {
  if (!isAbsolute(cwd)) throw gitBlocked(`Workspace cwd must be absolute: ${cwd}`)
  let checkout: string
  try {
    checkout = realpathSync(git(cwd, ['rev-parse', '--show-toplevel']))
  } catch (cause) {
    if (cause instanceof WorkspaceError) throw cause
    throw gitBlocked(`Cannot resolve Git checkout at ${cwd}`)
  }
  const common = realpathSync(
    git(checkout, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  )
  const adminValue = git(checkout, ['rev-parse', '--path-format=absolute', '--git-dir'])
  const admin = realpathSync(isAbsolute(adminValue) ? adminValue : resolve(checkout, adminValue))
  const objectFormat = git(checkout, ['rev-parse', '--show-object-format'])
  let head: string
  try {
    head = git(checkout, ['rev-parse', '--verify', 'HEAD^{commit}'])
  } catch {
    head = ''
  }
  const [physical, commonPhysical, adminPhysical] = observePhysicalIdentities([
    checkout,
    common,
    admin,
  ])
  if (physical === undefined || commonPhysical === undefined || adminPhysical === undefined)
    throw gitBlocked(`Filesystem identity observation was incomplete for ${checkout}`)
  const workspace = decodeGitWorkspace({
    path: checkout,
    identity: physical.identity,
    identityDevice: physical.device,
    commonPath: common,
    commonIdentity: commonPhysical.identity,
    commonDevice: commonPhysical.device,
    gitAdminPath: admin,
    gitAdminIdentity: adminPhysical.identity,
    gitAdminDevice: adminPhysical.device,
    objectFormat,
    head,
  })
  if (Option.isNone(workspace)) throw gitBlocked(`Git described an invalid checkout at ${checkout}`)
  return workspace.value
}

export const currentCommit = (workspace: GitWorkspace): string => {
  if (workspace.head.length === 0)
    throw gitBlocked(`Checkout has no current commit: ${workspace.path}`)
  return workspace.head
}

export const assertManagedCheckoutSupported = (source: GitWorkspace, commit: string): void => {
  const trackedPaths = git(source.path, ['ls-tree', '-r', '--name-only', '-z', commit])
  const attributes = git(
    source.path,
    ['check-attr', `--source=${commit}`, '--stdin', '-z', 'filter'],
    trackedPaths
  ).split('\0')
  attributes.pop()
  if (
    attributes.some(
      (value, index) => index % 3 === 2 && value !== 'unspecified' && value !== 'unset'
    )
  )
    throw gitBlocked(
      'Managed allocation is unavailable for filtered files; checkout filter effects are not controlled'
    )
}

const failureText = (result: Pick<GitResult, 'stderr' | 'status'>): string =>
  result.stderr.trim() || `exit ${result.status ?? 'signal'}`

const operands = (...values: readonly string[]): readonly string[] => ['--', ...values]

export interface TrackedChange {
  readonly path: string
  readonly kind: 'changed' | 'renamed' | 'conflict'
}
export const indexSnapshot = (
  checkout: string
): { readonly paths: readonly string[]; readonly digest: string | undefined } => {
  const indexPath = git(checkout, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])
  let digest: string | undefined
  try {
    digest = regularFileDigest(indexPath)
  } catch (cause) {
    if (!hasErrorCode(cause, 'ENOENT'))
      throw gitBlocked(`Cannot read Git index: ${errorText(cause)}`)
  }
  const entries = git(checkout, ['ls-files', '--stage', '-z'])
    .split('\0')
    .filter(entry => entry.length > 0)
  const paths = new Set<string>()
  for (const entry of entries) {
    const separator = entry.indexOf('\t')
    if (separator === -1) throw gitBlocked('Git returned an invalid index entry')
    const path = entry.slice(separator + 1)
    paths.add(entry.startsWith('160000 ') ? `${path}/` : path)
  }
  return { paths: [...paths], digest }
}

export const assertUnfilteredIndex = (checkout: string, paths: readonly string[]): void => {
  const attributes = git(
    checkout,
    ['check-attr', '--stdin', '-z', 'filter'],
    paths.map(path => `${path}\0`).join('')
  ).split('\0')
  if (
    attributes.some(
      (value, index) => index % 3 === 2 && value !== 'unspecified' && value !== 'unset'
    )
  )
    throw gitBlocked('Tracked files use checkout filters; their read effects are not controlled')
}

export const trackedChanges = (checkout: string): readonly TrackedChange[] => {
  const output = git(checkout, [
    'status',
    '--porcelain=v2',
    '-z',
    '--untracked-files=no',
    '--ignore-submodules=none',
  ])
  const fields = output.split('\0')
  const changes: TrackedChange[] = []
  for (let index = 0; index < fields.length; index += 1) {
    const line = fields[index] ?? ''
    if (line.length === 0) continue
    const [kind] = line
    if (kind === '1') changes.push({ path: line.split(' ').slice(8).join(' '), kind: 'changed' })
    else if (kind === '2') {
      changes.push({ path: line.split(' ').slice(9).join(' '), kind: 'renamed' })
      index += 1
    } else if (kind === 'u')
      changes.push({ path: line.split(' ').slice(10).join(' '), kind: 'conflict' })
    else if (kind !== '#') throw gitBlocked(`Unrecognized Git status entry: ${line}`)
  }
  return changes
}

const nulSeparated = (output: string): readonly string[] =>
  output.split('\0').filter(entry => entry.length > 0)

export const untrackedPaths = (
  checkout: string
): { readonly untracked: readonly string[]; readonly ignored: readonly string[] } => ({
  untracked: nulSeparated(git(checkout, ['ls-files', '--others', '--exclude-standard', '-z'])),
  ignored: nulSeparated(
    git(checkout, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])
  ),
})

export const symbolicBranch = (checkout: string): string | undefined => {
  const result = gitResult(checkout, ['symbolic-ref', '--quiet', 'HEAD'])
  if (result.status === 0) return result.stdout.trim()
  if (result.status === 1) return undefined
  throw gitBlocked(`Cannot read the symbolic HEAD: ${failureText(result)}`)
}

export const remoteUrl = (checkout: string, remote: string): string | undefined => {
  const result = gitResult(checkout, ['config', '--get', `remote.${remote}.url`])
  if (result.status === 0) return result.stdout.trim()
  if (result.status === 1) return undefined
  throw gitBlocked(`Cannot read remote ${remote}: ${failureText(result)}`)
}

export const remoteNames = (checkout: string): readonly string[] =>
  git(checkout, ['remote']).split('\n').filter(Boolean)

export const remotePushUrls = (checkout: string, remote: string): readonly string[] =>
  git(checkout, ['remote', 'get-url', '--push', '--all', '--', remote]).split('\n').filter(Boolean)

export const branchPushRef = (checkout: string, branch: string): string | undefined => {
  const result = gitResult(checkout, [
    'rev-parse',
    '--verify',
    '--symbolic-full-name',
    '--end-of-options',
    `${branch}@{push}`,
  ])
  return result.status === 0 ? result.stdout.trim() : undefined
}

export type RemoteHead = { readonly ref: string } | 'missing' | { readonly error: string }
export const remoteHead = (checkout: string, remote: string): RemoteHead => {
  const result = gitResult(checkout, [
    'ls-remote',
    '--symref',
    '--exit-code',
    ...operands(remote, 'HEAD'),
  ])
  if (result.status === 2) return 'missing'
  if (result.status !== 0) return { error: failureText(result) }
  const ref = /^ref: (refs\/heads\/\S+)\tHEAD$/m.exec(result.stdout)?.[1]
  return ref === undefined ? 'missing' : { ref }
}

export const isShallowRepository = (checkout: string): boolean =>
  git(checkout, ['rev-parse', '--is-shallow-repository']) === 'true'

export const resolveLocalRef = (checkout: string, ref: string): string | undefined => {
  const result = gitResult(checkout, [
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    `${ref}^{commit}`,
  ])
  if (result.status === 0) return result.stdout.trim()
  if (result.status === 1) return undefined
  throw gitBlocked(`Cannot resolve ${ref}: ${failureText(result)}`)
}
export const hasCommit = (checkout: string, sha: string): boolean =>
  gitResult(checkout, ['cat-file', '-e', ...operands(`${sha}^{commit}`)]).status === 0

export type Ancestry = 'ancestor' | 'not-ancestor' | { readonly error: string }
export const ancestry = (checkout: string, ancestor: string, descendant: string): Ancestry => {
  const result = gitResult(checkout, [
    'merge-base',
    '--is-ancestor',
    ...operands(ancestor, descendant),
  ])
  if (result.status === 0) return 'ancestor'
  if (result.status === 1) return 'not-ancestor'
  return { error: failureText(result) }
}

export type RemoteTip = { readonly sha: string } | 'missing' | { readonly error: string }
export const remoteTip = (checkout: string, remote: string, ref: string): RemoteTip => {
  const result = gitResult(checkout, ['ls-remote', '--exit-code', ...operands(remote, ref)])
  if (result.status === 2) return 'missing'
  if (result.status !== 0) return { error: failureText(result) }
  const line = result.stdout.split('\n').find(entry => entry.endsWith(`\t${ref}`))
  const sha = line?.split('\t')[0]
  return sha === undefined || sha.length === 0 ? 'missing' : { sha }
}

export const worktreeLockReason = (repositoryPath: string, path: string): string | undefined => {
  const fields = git(repositoryPath, ['worktree', 'list', '--porcelain', '-z']).split('\0')
  let selected = false
  for (const field of fields) {
    if (field.startsWith('worktree ')) {
      selected = field.slice('worktree '.length) === path
      continue
    }
    if (selected && field.startsWith('locked')) return field.slice('locked'.length).trim()
  }
  return undefined
}

export const registeredWorktrees = (repositoryPath: string): readonly string[] =>
  git(repositoryPath, ['worktree', 'list', '--porcelain', '-z'])
    .split('\0')
    .filter(line => line.startsWith('worktree '))
    .map(line => line.slice('worktree '.length))

export const removeWorktree = (repositoryPath: string, path: string): GitResult =>
  gitResult(repositoryPath, ['worktree', 'remove', '--force', '--', path])

export const addDetachedWorktree = (
  source: GitWorkspace,
  destination: string,
  commit: string
): GitWorkspace => {
  if (!isAbsolute(destination) || basename(destination).length === 0)
    throw gitBlocked('Managed worktree destination must be an absolute path')
  git(source.path, ['worktree', 'add', '--detach', destination, commit])
  const created = canonicalGitWorkspace(destination)
  if (
    created.path !== resolve(destination) ||
    created.commonPath !== source.commonPath ||
    created.commonDevice !== source.commonDevice ||
    created.commonIdentity.volumeUuid !== source.commonIdentity.volumeUuid ||
    created.commonIdentity.inode !== source.commonIdentity.inode ||
    created.objectFormat !== source.objectFormat ||
    created.head !== commit
  )
    throw gitBlocked(`Created worktree does not match the recorded allocation: ${destination}`)
  return created
}
