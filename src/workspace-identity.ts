import { lstatSync, realpathSync, type BigIntStats } from 'node:fs'
import { MessageChannel, receiveMessageOnPort, Worker, type MessagePort } from 'node:worker_threads'
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

const VolumeLookupReplySchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('answered'), line: Schema.String }),
  Schema.Struct({ kind: Schema.Literal('failed'), reason: Schema.String }),
])
export type VolumeLookupReply = typeof VolumeLookupReplySchema.Type
export interface VolumeHelperData {
  readonly signal: Int32Array
  readonly port: MessagePort
  readonly timeoutMs: number
}

const decodeLookupReply = Schema.decodeUnknownResult(VolumeLookupReplySchema)
const decodeVolumeAnswer = Schema.decodeUnknownResult(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({ uuids: Schema.Array(VolumeUuidSchema) }),
      Schema.Struct({ error: Schema.String }),
    ])
  )
)
const LOOKUP_TIMEOUT_MS = 5000
const HELPER_TIMEOUT_MS = 4500

interface VolumeHelper {
  readonly worker: Worker
  readonly port: MessagePort
  readonly signal: Int32Array
}
let helper: VolumeHelper | undefined

const startHelper = (): VolumeHelper => {
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  const { port1, port2 } = new MessageChannel()
  const data: VolumeHelperData = { signal, port: port2, timeoutMs: HELPER_TIMEOUT_MS }
  const worker = new Worker(new URL('./workspace-volume-helper.ts', import.meta.url), {
    workerData: data,
    transferList: [port2],
  })
  const forget = () => {
    if (helper?.worker === worker) helper = undefined
  }
  worker.on('error', forget)
  worker.on('exit', forget)
  worker.unref()
  port1.unref()
  return { worker, port: port1, signal }
}

const askHelper = (paths: readonly string[]): VolumeLookupReply => {
  try {
    helper ??= startHelper()
  } catch (cause) {
    return {
      kind: 'failed',
      reason: `The volume identity helper did not start: ${errorText(cause)}`,
    }
  }
  const current = helper
  Atomics.store(current.signal, 0, 0)
  current.port.postMessage(paths, [])
  const waited = Atomics.wait(current.signal, 0, 0, LOOKUP_TIMEOUT_MS)
  const received = receiveMessageOnPort(current.port)
  const reply = received === undefined ? undefined : decodeLookupReply(received.message)
  if (waited !== 'timed-out' && reply !== undefined && Result.isSuccess(reply)) return reply.success
  if (helper === current) helper = undefined
  void current.worker.terminate()
  return { kind: 'failed', reason: 'The volume identity helper did not answer' }
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

const volumeUuids = (paths: readonly string[]): readonly string[] => {
  const reply = askHelper(paths)
  if (reply.kind === 'failed') throw physicalError(paths.join(', '), reply.reason)
  const decoded = decodeVolumeAnswer(reply.line)
  if (Result.isFailure(decoded)) throw physicalError(paths.join(', '), decoded.failure)
  if ('error' in decoded.success) throw physicalError(paths.join(', '), decoded.success.error)
  const { uuids } = decoded.success
  if (uuids.length !== paths.length)
    unavailable(`macOS returned an incomplete volume identity for ${paths.join(', ')}`)
  return uuids.map(value => value.toUpperCase())
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
