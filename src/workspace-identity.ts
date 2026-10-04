import { execFileSync } from 'node:child_process'
import { lstatSync, realpathSync, type BigIntStats } from 'node:fs'
import { Result, Schema } from 'effect'
import { unavailable, requireReview, WorkspaceError } from './workspace-domain.ts'
import { errorText } from './error-text.ts'

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

const decodeVolumeUuids = Schema.decodeUnknownResult(
  Schema.fromJsonString(Schema.Array(VolumeUuidSchema))
)
const VOLUME_UUID_SCRIPT =
  'ObjC.import("Foundation"); function run(paths) { return JSON.stringify(paths.map(function(path) { var value = Ref(); var error = Ref(); if (!$.NSURL.fileURLWithPath(path).getResourceValueForKeyError(value, $.NSURLVolumeUUIDStringKey, error)) throw Error(ObjC.unwrap(error[0].localizedDescription)); return ObjC.unwrap(value[0]); })); }'

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

const volumeUuids = (paths: readonly string[]): readonly string[] => {
  let output: string
  try {
    output = execFileSync(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', VOLUME_UUID_SCRIPT, ...paths],
      {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )
  } catch (cause) {
    throw physicalError(paths.join(', '), cause)
  }
  const decoded = decodeVolumeUuids(output)
  if (Result.isFailure(decoded)) throw physicalError(paths.join(', '), decoded.failure)
  if (decoded.success.length !== paths.length)
    unavailable(`macOS returned an incomplete volume identity for ${paths.join(', ')}`)
  return decoded.success.map(value => value.toUpperCase())
}

export const observePhysicalIdentities = (
  paths: readonly string[]
): readonly PhysicalObservation[] => {
  if (paths.length === 0) return []
  const before = paths.map(path => directoryStat(path))
  const volumePathByDevice = new Map<string, string>()
  for (let index = 0; index < paths.length; index += 1) {
    const path = paths[index]
    const stat = before[index]
    if (path === undefined || stat === undefined) continue
    if (resolvedPath(path) !== path)
      requireReview(`Filesystem identity path is no longer canonical: ${path}`)
    const device = String(stat.dev)
    if (!volumePathByDevice.has(device)) volumePathByDevice.set(device, path)
  }
  const uniqueDevices = [...volumePathByDevice.keys()]
  const uuids = volumeUuids(uniqueDevices.map(device => volumePathByDevice.get(device) ?? ''))
  const uuidByDevice = new Map(
    uniqueDevices.map((device, index) => {
      const uuid = uuids.at(index)
      if (uuid === undefined)
        return unavailable(`macOS returned no volume identity for device ${device}`)
      return [device, uuid] as const
    })
  )
  const after = paths.map(path => directoryStat(path))
  return paths.map((path, index) => {
    const initial = before[index]
    const current = after[index]
    if (initial === undefined || current === undefined)
      return unavailable(`Filesystem identity observation is incomplete: ${path}`)
    if (
      String(initial.dev) !== String(current.dev) ||
      String(initial.ino) !== String(current.ino) ||
      resolvedPath(path) !== path
    )
      requireReview(`Filesystem object changed during identity observation: ${path}`)
    const volumeUuid = uuidByDevice.get(String(current.dev))
    if (volumeUuid === undefined)
      return unavailable(`macOS returned no volume identity for ${path}`)
    const identity = Schema.decodeSync(FileIdentitySchema)({
      volumeUuid,
      inode: String(current.ino),
    })
    return { identity, device: String(current.dev) }
  })
}

export const observePhysicalIdentity = (path: string): PhysicalObservation => {
  const [observation] = observePhysicalIdentities([path])
  if (observation === undefined)
    return unavailable(`Filesystem identity observation is empty: ${path}`)
  return observation
}
