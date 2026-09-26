import { execFile, type ChildProcess } from 'node:child_process'
import { Writable } from 'node:stream'
import { promisify } from 'node:util'
import type { ProcessObservation } from './work-lifecycle.ts'

const execFilePromise = promisify(execFile)

// The shell blocks on descriptor 3 until its parent has durably recorded the process
// identity, so no user code runs before the launch barrier.
export const processGateScript = 'IFS= read -r _ <&3 || exit 125; exec 3<&-; exec /bin/bash -c "$1"'

export const processGate = (child: ChildProcess): Writable => {
  const [, , , descriptor] = child.stdio
  if (!(descriptor instanceof Writable)) throw new Error('Process execution gate is unavailable')
  descriptor.on('error', () => undefined)
  return descriptor
}

export type ObservedProcess = ProcessObservation & { readonly birth: string }

export const readProcessTable = async (): Promise<ObservedProcess[]> => {
  // The start time is the birth identity, so it must not follow the system time zone.
  const { stdout } = await execFilePromise('ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart='], {
    env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
    maxBuffer: 4 * 1024 * 1024,
    timeout: 2000,
  })
  return stdout.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/)
    return !match || match[4].startsWith('Z')
      ? []
      : [
          {
            pid: Number(match[1]),
            parent: Number(match[2]),
            group: Number(match[3]),
            birth: match[5],
          },
        ]
  })
}

export const rootIdentityReused = (
  table: readonly ProcessObservation[],
  root: ProcessObservation | undefined,
  exited: boolean
): boolean =>
  root !== undefined &&
  table.some(
    item => item.pid === root.pid && (root.birth === undefined ? exited : item.birth !== root.birth)
  )
