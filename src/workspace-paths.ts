import { lstatSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Schema } from 'effect'
import { blocked, invalid, requireReview } from './workspace-domain.ts'
import { lstatIfExists } from './workspace-platform.ts'
import { errorText } from './error-text.ts'

export const isWithin = (root: string, path: string): boolean => {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

// The authority records a conversation by this file, Pi by the path it was given, which may
// pass through a symbolic link or name a file not yet written.
export const canonicalSessionFile = (file: string): string => {
  const absolute = resolve(file)
  return lstatIfExists(absolute) === undefined
    ? resolve(realpathSync(dirname(absolute)), basename(absolute))
    : realpathSync(absolute)
}

// A checkout's stable path slot: a missing final component keeps its spelling under the
// canonical parent, so a removed checkout keeps the slot it had.
export const canonicalPathSlot = (path: string): string => {
  const absolute = resolve(path)
  const info = lstatIfExists(absolute)
  if (info !== undefined) {
    if (info.isSymbolicLink() || !info.isDirectory())
      requireReview(`Workspace path is not a physical directory: ${absolute}`)
    return realpathSync(absolute)
  }
  return resolve(realpathSync(dirname(absolute)), basename(absolute))
}

// The existing prefix is resolved through the filesystem, which follows links and, on a
// case-insensitive volume, restores the stored case; the missing suffix keeps its spelling.
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

// `resolve` removes `..` lexically, before any link is resolved, while the tool hands the
// operand to the kernel, which resolves links first; Pi also expands its own shorthand.
// Either way the operand would name one file here and another to the executor.
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

const writeDestination = (checkout: string, absolute: string): string => {
  const { path, ancestor, missing } = canonicalPath(absolute)
  if (missing.length > 0 && !statSync(ancestor).isDirectory())
    invalid(`Write path parent is not a directory: ${ancestor}`)
  if (!isWithin(checkout, path) || path === checkout)
    invalid(`Write path escapes its workspace: ${absolute}`)
  if (
    relative(checkout, path)
      .split(sep)
      .some(part => part.toLowerCase() === '.git')
  )
    invalid('Writes cannot target Git administrative paths')
  const device = lstatSync(checkout).dev
  for (
    let directory = missing.length > 0 ? ancestor : dirname(path);
    directory !== checkout && dirname(directory) !== directory;
    directory = dirname(directory)
  ) {
    if (lstatSync(directory).dev !== device)
      invalid(`Write destination crosses an unsupported mount boundary: ${absolute}`)
    if (lstatIfExists(join(directory, '.git')) !== undefined)
      invalid('Write destination belongs to a nested repository; select it explicitly')
  }
  if (missing.length === 0) {
    const info = lstatSync(absolute)
    if (!info.isFile() || info.nlink !== 1)
      invalid('Write destination must be a regular file without hard links')
  }
  return path
}

// ADR 0005, scoped workspace operations.
export const resolveWriteDestination = (
  checkout: string,
  cwd: string,
  requested: string
): string => {
  assertLiteralOperand(requested)
  return writeDestination(checkout, resolve(cwd, requested))
}

// Rerun at the start boundary; the remaining open(2) window is the residual ADR 0005 accepts.
export const assertDestinationUnchanged = (checkout: string, recorded: string): void => {
  let actual: string
  try {
    actual = writeDestination(checkout, recorded)
  } catch (cause) {
    return blocked(`Write destination changed after authorization: ${errorText(cause)}`)
  }
  if (actual !== recorded)
    blocked(`Write destination now resolves elsewhere: ${recorded} -> ${actual}`)
}

const WriteOperand = Schema.Struct({ path: Schema.NonEmptyString })
const decodeOperand = Schema.decodeUnknownOption(WriteOperand)
export const decodeWriteOperand = (input: unknown): string => {
  const decoded = decodeOperand(input)
  if (decoded._tag === 'None') return invalid('A file write needs a non-empty path')
  return decoded.value.path
}
