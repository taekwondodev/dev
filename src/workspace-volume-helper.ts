import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { MessagePort, workerData } from 'node:worker_threads'
import type { VolumeHelperData, VolumeLookupReply } from './workspace-identity.ts'

const VOLUME_UUID_SCRIPT = String.raw`ObjC.import("Foundation"); function lookup(path) { var value = Ref(); if (!$.NSURL.fileURLWithPath(path).getResourceValueForKeyError(value, $.NSURLVolumeUUIDStringKey, null)) throw Error("Foundation reported no volume identity for " + path); var uuid = ObjC.unwrap(value[0]); if (typeof uuid !== "string") throw Error("Foundation returned no volume identity for " + path); return uuid; } function run() { var input = $.NSFileHandle.fileHandleWithStandardInput; var output = $.NSFileHandle.fileHandleWithStandardOutput; var pending = ""; for (;;) { var data = input.availableData; if (Number(data.length) === 0) return; pending += $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js; for (var end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) { var line = pending.slice(0, end); pending = pending.slice(end + 1); var reply; try { reply = { uuids: JSON.parse(line).map(lookup) }; } catch (failure) { reply = { error: String(failure && failure.message || failure) }; } output.writeData($(JSON.stringify(reply) + "\n").dataUsingEncoding($.NSUTF8StringEncoding)); } } }`

const asciiJson = (value: unknown): string =>
  JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    unit => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`
  )

interface Pending {
  readonly reply: (value: VolumeLookupReply) => void
  readonly timer: NodeJS.Timeout
}

interface Lookup {
  readonly child: ChildProcessWithoutNullStreams
  pending: Pending | undefined
}

const isHelperData = (value: unknown): value is VolumeHelperData =>
  typeof value === 'object' &&
  value !== null &&
  'signal' in value &&
  value.signal instanceof Int32Array &&
  'port' in value &&
  value.port instanceof MessagePort &&
  'timeoutMs' in value &&
  typeof value.timeoutMs === 'number'

if (!isHelperData(workerData)) throw new Error('The volume identity helper received no channel')
const { signal, port, timeoutMs } = workerData

let current: Lookup | undefined

const settle = (lookup: Lookup, value: VolumeLookupReply): void => {
  const { pending } = lookup
  if (pending === undefined) return
  lookup.pending = undefined
  clearTimeout(pending.timer)
  pending.reply(value)
}

const discard = (lookup: Lookup, reason: string): void => {
  if (current === lookup) current = undefined
  lookup.child.kill('SIGKILL')
  settle(lookup, { kind: 'failed', reason })
}

const startLookup = (): Lookup => {
  const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', VOLUME_UUID_SCRIPT], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const lookup: Lookup = { child, pending: undefined }
  let output = ''
  let diagnostics = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk
    for (let end = output.indexOf('\n'); end >= 0; end = output.indexOf('\n')) {
      const line = output.slice(0, end)
      output = output.slice(end + 1)
      settle(lookup, { kind: 'answered', line })
    }
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    diagnostics = `${diagnostics}${chunk}`.slice(-1024)
  })
  child.stdin.on('error', cause => discard(lookup, `osascript stopped reading: ${cause.message}`))
  child.on('error', cause => discard(lookup, `osascript failed: ${cause.message}`))
  child.on('exit', (code, exitSignal) =>
    discard(
      lookup,
      `osascript exited (${exitSignal ?? code ?? 'unknown'})${diagnostics.trim() ? `: ${diagnostics.trim()}` : ''}`
    )
  )
  return lookup
}

const reply = (value: VolumeLookupReply): void => {
  port.postMessage(value)
  Atomics.store(signal, 0, 1)
  Atomics.notify(signal, 0)
}

port.on('message', (paths: unknown) => {
  current ??= startLookup()
  const lookup = current
  lookup.pending = {
    reply,
    timer: setTimeout(
      () => discard(lookup, `osascript gave no volume identity within ${timeoutMs} ms`),
      timeoutMs
    ),
  }
  lookup.child.stdin.write(`${asciiJson(paths)}\n`)
})
