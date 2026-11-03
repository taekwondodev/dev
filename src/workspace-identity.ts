import { lstatSync, realpathSync, type BigIntStats } from 'node:fs'
import { Schema } from 'effect'
import { unavailable, requireReview, WorkspaceError } from './workspace-domain.ts'
import { errorText } from './error-text.ts'
import { native } from './native.ts'

export const VolumeUuidSchema = Schema.String.check(Schema.isUUID())
export const InodeSchema = Schema.String.check(Schema.isPattern(/^(?:0|[1-9][0-9]*)$/))
export const FileIdentitySchema = Schema.Struct({
  volumeUuid: VolumeUuidSchema,
  inode: InodeSchema,
})
export type FileIdentity = typeof FileIdentitySchema.Type

export interface PhysicalObservation {
  readonly identity: FileIdentity
  readonly device: string
}

const physicalError = (path: string, cause: unknown): WorkspaceError =>
  new WorkspaceError({
    outcome: 'unavailable',
    message: `Cannot observe persistent filesystem identity for ${path}: ${errorText(cause)}`,
  })

const directoryStat = (path: string): BigIntStats => {
  let stat: BigIntStats
  try {
    stat = lstatSync(path, { bigint: true })
  } catch (cause) {
    throw physicalError(path, cause)
  }
  if (!stat.isDirectory() || stat.isSymbolicLink())
    requireReview(`Filesystem identity path is not a real directory: ${path}`)
  return stat
}

const resolvedPath = (path: string): string => {
  try {
    return realpathSync(path)
  } catch (cause) {
    throw physicalError(path, cause)
  }
}

interface NativeObservation {
  readonly device: string
  readonly inode: string
  readonly volumeUuid: string
}

const nativeObservation = (path: string): NativeObservation => {
  try {
    const [device, inode, volumeUuid] = native().observeDirectory(path)
    return { device, inode, volumeUuid }
  } catch (cause) {
    throw physicalError(path, cause)
  }
}

export const observePhysicalIdentities = (
  paths: readonly string[]
): readonly PhysicalObservation[] =>
  paths.map(path => {
    const before = directoryStat(path)
    if (resolvedPath(path) !== path)
      requireReview(`Filesystem identity path is no longer canonical: ${path}`)
    const observed = nativeObservation(path)
    const after = directoryStat(path)
    if (
      String(before.dev) !== observed.device ||
      String(before.ino) !== observed.inode ||
      String(after.dev) !== observed.device ||
      String(after.ino) !== observed.inode ||
      resolvedPath(path) !== path
    )
      requireReview(`Filesystem object changed during identity observation: ${path}`)
    const identity = Schema.decodeSync(FileIdentitySchema)({
      volumeUuid: observed.volumeUuid,
      inode: observed.inode,
    })
    return { identity, device: observed.device }
  })

export const observeDevice = (path: string): string => {
  const stat = directoryStat(path)
  if (resolvedPath(path) !== path)
    requireReview(`Filesystem identity path is no longer canonical: ${path}`)
  return String(stat.dev)
}

export const observePhysicalIdentity = (path: string): PhysicalObservation => {
  const [observation] = observePhysicalIdentities([path])
  if (observation === undefined)
    return unavailable(`Filesystem identity observation is empty: ${path}`)
  return observation
}
