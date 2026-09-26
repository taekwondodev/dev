import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fsyncSync, mkdirSync, openSync } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname } from 'node:path'
import { unavailable, WorkspaceId } from './workspace-domain.ts'
import { hasErrorCode, lstatIfExists } from './workspace-paths.ts'

export const newId = (): WorkspaceId => WorkspaceId.make(randomUUID())
export const now = (): number => Date.now()
export const hash = (text: string): string => createHash('sha256').update(text).digest('hex')

export const fsyncPath = (path: string, directory = false): void => {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : 0)
  const fd = openSync(path, flags)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
export const fsyncParent = (path: string): void => fsyncPath(dirname(path), true)
export const effectiveUid = (): number => process.getuid?.() ?? userInfo().uid

export const privateDirectory = (path: string, create: boolean): void => {
  let info = lstatIfExists(path)
  if (info === undefined && create) {
    try {
      mkdirSync(path, { mode: 0o700 })
      fsyncParent(path)
      fsyncPath(path, true)
    } catch (cause) {
      if (!hasErrorCode(cause, 'EEXIST')) throw cause
    }
    info = lstatIfExists(path)
  }
  if (info === undefined) return unavailable(`Workspace authority directory is missing: ${path}`)
  if (!info.isDirectory() || info.isSymbolicLink())
    return unavailable(`Unsafe workspace authority directory: ${path}`)
  if (info.uid !== effectiveUid() || (info.mode & 0o077) !== 0)
    return unavailable(
      `Workspace authority directory is not private or is not owned by this account: ${path}`
    )
}

export const ensureDirectoryPath = (path: string): void => {
  const info = lstatIfExists(path)
  if (info !== undefined) {
    if (!info.isDirectory() || info.isSymbolicLink())
      unavailable(`Unsafe workspace authority parent: ${path}`)
    return
  }
  ensureDirectoryPath(dirname(path))
  try {
    mkdirSync(path, { mode: 0o700 })
    fsyncParent(path)
    fsyncPath(path, true)
  } catch (cause) {
    if (!hasErrorCode(cause, 'EEXIST')) throw cause
  }
  const created = lstatIfExists(path)
  if (created === undefined || !created.isDirectory() || created.isSymbolicLink())
    unavailable(`Cannot create workspace authority directory: ${path}`)
}

export const privateFile = (path: string): void => {
  const info = lstatIfExists(path)
  if (info === undefined || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
    return unavailable(`Unsafe workspace authority file: ${path}`)
  if (info.uid !== effectiveUid() || (info.mode & 0o077) !== 0)
    return unavailable(
      `Workspace authority file is not private or is not owned by this account: ${path}`
    )
}
