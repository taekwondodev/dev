import { lstatSync, realpathSync, type Stats, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Option, Schema } from 'effect'
import { blocked, invalid, requireReview } from './workspace-domain.ts'
import { lstatIfExists } from './workspace-platform.ts'
import { errorText } from './error-text.ts'
import { authorityPaths, taskArtifactsPath } from './workspace-authority-root.ts'
import { gitResult } from './workspace-git.ts'

export const isWithin = (root: string, path: string): boolean => {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

const slotThrough =
  (realpath: (path: string) => string) =>
  (absolute: string, info: Stats | undefined): string =>
    info === undefined
      ? resolve(realpath(dirname(absolute)), basename(absolute))
      : realpath(absolute)
const canonicalSlot = slotThrough(realpathSync)

export const conversationFileSlot = slotThrough(realpathSync.native)

export const canonicalConversationFile = (file: string): string => {
  const absolute = resolve(file)
  return conversationFileSlot(absolute, lstatIfExists(absolute))
}

export const canonicalPathSlot = (path: string): string => {
  const absolute = resolve(path)
  const info = lstatIfExists(absolute)
  if (info !== undefined && (info.isSymbolicLink() || !info.isDirectory()))
    requireReview(`Workspace path is not a physical directory: ${absolute}`)
  return canonicalSlot(absolute, info)
}

export const canonicalPath = (
  absolute: string
): { readonly path: string; readonly ancestor: string; readonly missing: readonly string[] } => {
  let ancestor = absolute
  const missing: string[] = []
  while (lstatIfExists(ancestor) === undefined) {
    const parent = dirname(ancestor)
    if (parent === ancestor) invalid(`Cannot establish write-path identity: ${absolute}`)
    missing.unshift(basename(ancestor))
    ancestor = parent
  }
  const canonicalAncestor = realpathSync.native(ancestor)
  return { path: resolve(canonicalAncestor, ...missing), ancestor: canonicalAncestor, missing }
}

const assertLiteralOperand = (requested: string): void => {
  if (requested.length === 0 || requested.includes('\0')) invalid('Invalid write path')
  if (requested.split(sep).includes('..'))
    invalid(`Write path must not traverse parent directories: ${requested}`)
  if (
    requested.startsWith('@') ||
    requested === '~' ||
    requested.startsWith('~/') ||
    requested.startsWith('file://') ||
    /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/.test(requested)
  )
    invalid(`Write path must be a literal path, not Pi shorthand: ${requested}`)
}

export interface WriteScope {
  readonly checkout: string
  readonly authorityRoot: string
  readonly taskId?: string
}

export type WriteDestination =
  | {
      readonly kind: 'workspace' | 'external' | 'artifact'
      readonly operand: string
      readonly path: string
    }
  | {
      readonly kind: 'foreign'
      readonly operand: string
      readonly path: string
      readonly checkout: string
    }

const gitCommonIdentity = (checkout: string): { readonly dev: number; readonly ino: number } => {
  const git = gitResult(checkout, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (git.status !== 0) invalid(`Cannot inspect Git repository identity: ${checkout}`)
  const info = statSync(realpathSync.native(git.stdout.trim()))
  return { dev: info.dev, ino: info.ino }
}

const sameRepository = (checkout: string, other: string): boolean => {
  const bound = gitCommonIdentity(checkout)
  const foreign = gitCommonIdentity(other)
  return bound.dev === foreign.dev && bound.ino === foreign.ino
}

const refuseSameRepository = (checkout: string, foreignRoot: string, path: string): never => {
  if (isWithin(checkout, foreignRoot))
    return invalid(`Write destination is under an unrecognized .git entry: ${foreignRoot}`)
  const relativePath = relative(foreignRoot, path)
  const equivalent = join(checkout, relativePath)
  const existing = lstatIfExists(equivalent)
  return existing !== undefined && existing.isFile()
    ? invalid(
        `Write destination is in another worktree of this repository; write the same file in the current workspace instead: ${equivalent}`
      )
    : invalid(
        `Write destination is in another worktree of this repository, and ${relativePath} does not exist in the current workspace; to create it there, write ${equivalent}`
      )
}

export const assertNonAdministrativePath = (path: string): void => {
  const parts = path.split(sep).map(part => part.toLowerCase())
  if (parts.includes('.git'))
    invalid('Write destination targets Git administrative paths; select a project file instead')
  if (parts.some((part, index) => part === '.dev' && parts[index + 1] === 'coordination'))
    invalid('Write destination targets dev coordination metadata; select a project file instead')
}

export const classifyWriteDestination = (
  scope: WriteScope,
  cwd: string,
  requested: string
): WriteDestination => {
  assertLiteralOperand(requested)
  const absolute = resolve(cwd, requested)
  assertNonAdministrativePath(absolute)
  const { path, ancestor, missing } = canonicalPath(absolute)
  assertNonAdministrativePath(path)
  if (missing.length > 0 && !statSync(ancestor).isDirectory())
    invalid(`Write path parent is not a directory: ${ancestor}`)
  if (missing.length === 0) {
    const info = lstatSync(absolute)
    if (!info.isFile() || info.nlink !== 1)
      invalid('Write destination must be a regular file without hard links')
  }
  const checkout = realpathSync.native(scope.checkout)
  const workspace = isWithin(checkout, path)
  const authority = authorityPaths(canonicalPath(resolve(scope.authorityRoot)).path)
  const artifacts =
    scope.taskId === undefined ? undefined : taskArtifactsPath(authority, scope.taskId)
  const artifact = artifacts !== undefined && path !== artifacts && isWithin(artifacts, path)
  if (
    isWithin(authority.root, path) &&
    !artifact &&
    !(workspace && isWithin(authority.worktrees, checkout))
  ) {
    if (isWithin(authority.worktrees, path))
      invalid(
        'The destination belongs to another managed workspace; ask its owning conversation to make the change'
      )
    invalid('Write destination targets dev authority metadata; select a project file instead')
  }
  const device = workspace ? lstatSync(checkout).dev : undefined
  for (
    let directory = missing.length > 0 ? ancestor : dirname(path);
    ;
    directory = dirname(directory)
  ) {
    if (device !== undefined && lstatSync(directory).dev !== device)
      invalid(`Write destination crosses an unsupported mount boundary: ${absolute}`)
    if (
      lstatIfExists(join(directory, 'HEAD')) !== undefined &&
      (['objects', 'refs'].every(part => lstatIfExists(join(directory, part)) !== undefined) ||
        lstatIfExists(join(directory, 'commondir')) !== undefined)
    ) {
      const git = gitResult(directory, ['rev-parse', '--is-inside-git-dir'])
      if (git.status !== 0) invalid(`Cannot inspect Git administrative identity: ${directory}`)
      if (git.stdout.trim() === 'true')
        invalid('Write destination targets Git administrative paths; select a project file instead')
    }
    if (directory === checkout) break
    if (lstatIfExists(join(directory, '.git')) !== undefined) {
      if (sameRepository(checkout, directory)) refuseSameRepository(checkout, directory, path)
      return { kind: 'foreign', operand: absolute, path, checkout: directory }
    }
    if (dirname(directory) === directory) break
  }
  let kind: WriteDestination['kind'] = 'external'
  if (artifact) kind = 'artifact'
  else if (workspace) kind = 'workspace'
  return { kind, operand: absolute, path }
}

export const assertDestinationUnchanged = (scope: WriteScope, recorded: WriteDestination): void => {
  let actual: WriteDestination
  try {
    actual = classifyWriteDestination(scope, scope.checkout, recorded.operand)
  } catch (cause) {
    return blocked(`Write destination changed after authorization: ${errorText(cause)}`)
  }
  if (
    actual.path !== recorded.path ||
    actual.kind !== recorded.kind ||
    (actual.kind === 'foreign' &&
      recorded.kind === 'foreign' &&
      actual.checkout !== recorded.checkout)
  )
    blocked(`Write destination now resolves elsewhere: ${recorded.path} -> ${actual.path}`)
}

const WriteOperand = Schema.Struct({ path: Schema.NonEmptyString })
const decodeOperand = Schema.decodeUnknownOption(WriteOperand)
export const decodeWriteOperand = (input: unknown): string => {
  const decoded = decodeOperand(input)
  if (Option.isNone(decoded)) return invalid('A file write needs a non-empty path')
  return decoded.value.path
}
