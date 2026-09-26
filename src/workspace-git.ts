import { realpathSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, isAbsolute, resolve } from 'node:path'
import { WorkspaceError } from './workspace-domain.ts'

export interface FileIdentity {
  readonly device: string
  readonly inode: string
}

export interface GitWorkspace {
  readonly path: string
  readonly identity: FileIdentity
  readonly commonPath: string
  readonly commonIdentity: FileIdentity
  readonly gitAdminPath: string
  readonly gitAdminIdentity: FileIdentity
  readonly objectFormat: string
  readonly head: string
}

// Git refusals and failures leave dev's own state unchanged, so the authority reports them
// as blocked rather than as a separate error model.
const gitBlocked = (message: string): WorkspaceError =>
  new WorkspaceError({ outcome: 'blocked', message })

const git = (cwd: string, args: readonly string[], input?: string): string => {
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
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      input,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
      timeout: 30_000,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
        ),
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
        GIT_NO_LAZY_FETCH: '1',
      },
    }
  )
  if (result.error !== undefined) throw gitBlocked(`Cannot run Git: ${result.error.message}`)

  if (result.status !== 0)
    throw gitBlocked(
      `Git ${args[0] ?? 'command'} failed${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`
    )
  return result.stdout.replace(/\n$/, '')
}

const physicalIdentity = (path: string): FileIdentity => {
  const info = statSync(path)
  if (!info.isDirectory()) throw gitBlocked(`Git identity is not a directory: ${path}`)
  return { device: String(info.dev), inode: String(info.ino) }
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
  return {
    path: checkout,
    identity: physicalIdentity(checkout),
    commonPath: common,
    commonIdentity: physicalIdentity(common),
    gitAdminPath: admin,
    gitAdminIdentity: physicalIdentity(admin),
    objectFormat,
    head,
  }
}

export const currentCommit = (workspace: GitWorkspace): string => {
  if (workspace.head.length === 0)
    throw gitBlocked(`Checkout has no current commit: ${workspace.path}`)
  return workspace.head
}

// Runs only read-only Git commands, so a refusal leaves no Git effect behind.
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

// The caller has already run assertManagedCheckoutSupported for this commit.
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
    created.commonIdentity.device !== source.commonIdentity.device ||
    created.commonIdentity.inode !== source.commonIdentity.inode ||
    created.objectFormat !== source.objectFormat ||
    created.head !== commit
  )
    throw gitBlocked(`Created worktree does not match the recorded allocation: ${destination}`)
  return created
}

export const allocateDetachedWorktree = (
  source: GitWorkspace,
  destination: string,
  commit: string
): GitWorkspace => {
  assertManagedCheckoutSupported(source, commit)
  return addDetachedWorktree(source, destination, commit)
}
