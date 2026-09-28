import { execFile, type ChildProcess } from 'node:child_process'
import { Writable } from 'node:stream'
import { promisify } from 'node:util'
import { Duration, Effect, Schedule, Schema } from 'effect'
import { errorText } from './error-text.ts'
import { ownedProcesses, type ProcessObservation } from './work-lifecycle.ts'
import { WorkspaceProcessSchema, type WorkspaceProcess } from './workspace-domain.ts'

const execFilePromise = promisify(execFile)

export const processGateScript = 'IFS= read -r _ <&3 || exit 125; exec 3<&-; exec /bin/bash -c "$1"'

export const processGate = (child: ChildProcess): Writable => {
  const [, , , descriptor] = child.stdio
  if (!(descriptor instanceof Writable)) throw new Error('Process execution gate is unavailable')
  descriptor.on('error', () => undefined)
  return descriptor
}

export type ObservedProcess = ProcessObservation & { readonly birth: string }

const readProcessTable = async (): Promise<ObservedProcess[]> => {
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

export class ProcessObservationLost extends Schema.TaggedError<ProcessObservationLost>()(
  'ProcessObservationLost',
  { message: Schema.String }
) {}

export const transientRetry = { times: 4, schedule: Schedule.spaced(Duration.millis(250)) }

export const processTable: Effect.Effect<ObservedProcess[], ProcessObservationLost> =
  Effect.tryPromise({
    try: readProcessTable,
    catch: cause =>
      new ProcessObservationLost({
        message: `The process table could not be read: ${errorText(cause)}`,
      }),
  }).pipe(Effect.retry(transientRetry))

const decodeFamily = Schema.decodeUnknownEffect(Schema.Array(WorkspaceProcessSchema))

export interface TrackedFamily {
  readonly pid: number | undefined
  readonly root: ProcessObservation | undefined
  readonly known: readonly ProcessObservation[]
  readonly reported: string | undefined
}

export const observeFamily = Effect.fnUntraced(function* <E>(
  family: TrackedFamily,
  options: {
    readonly rootExited: boolean
    readonly report: (processes: readonly WorkspaceProcess[]) => Effect.Effect<void, E>
  }
): Effect.fn.Return<TrackedFamily, ProcessObservationLost | E> {
  const table = yield* processTable
  if (rootIdentityReused(table, family.root, options.rootExited))
    return yield* new ProcessObservationLost({
      message: 'Root process identity was reused; cleanup is unknown',
    })
  const known = ownedProcesses(table, family.pid, family.known, family.root)
  const processes = yield* decodeFamily(known).pipe(
    Effect.mapError(
      () => new ProcessObservationLost({ message: 'A tracked process has no birth identity' })
    )
  )
  const signature = JSON.stringify(processes)
  if (signature !== family.reported)
    yield* options.report(processes).pipe(Effect.retry(transientRetry))
  return { ...family, known, reported: signature }
})
