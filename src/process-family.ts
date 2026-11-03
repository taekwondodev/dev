import type { ChildProcess } from 'node:child_process'
import { Writable } from 'node:stream'
import { Duration, Effect, Schedule, Schema } from 'effect'
import { errorText } from './error-text.ts'
import { native } from './native.ts'
import { ownedProcesses, type ProcessObservation } from './work-lifecycle.ts'
import { WorkspaceProcessSchema, type WorkspaceProcess } from './workspace-domain.ts'

export const processGateScript = 'IFS= read -r _ <&3 || exit 125; exec 3<&-; exec /bin/bash -c "$1"'

export const processGate = (child: ChildProcess): Writable => {
  const [, , , descriptor] = child.stdio
  if (!(descriptor instanceof Writable)) throw new Error('Process execution gate is unavailable')
  descriptor.on('error', () => undefined)
  return descriptor
}

export type ObservedProcess = ProcessObservation & { readonly birth: string }

export const rootIdentityReused = (
  table: readonly ProcessObservation[],
  root: ProcessObservation | undefined,
  exited: boolean
): boolean =>
  root !== undefined &&
  table.some(
    item => item.pid === root.pid && (root.birth === undefined ? exited : item.birth !== root.birth)
  )

export class ProcessObservationLost extends Schema.TaggedError<
  ProcessObservationLost,
  { readonly brand: unique symbol }
>()('ProcessObservationLost', { message: Schema.String }) {}

export const transientRetry = { times: 4, schedule: Schedule.spaced(Duration.millis(250)) }

const PROCESS_COLUMNS = 5

export const processTable: Effect.Effect<ObservedProcess[], ProcessObservationLost> = Effect.try({
  try: () => {
    const rows = native().processTable()
    const table: ObservedProcess[] = []
    for (let index = 0; index + PROCESS_COLUMNS <= rows.length; index += PROCESS_COLUMNS) {
      const [pid = 0, parent = 0, group = 0, seconds = 0, microseconds = 0] = rows.subarray(
        index,
        index + PROCESS_COLUMNS
      )
      table.push({
        pid,
        parent,
        group,
        birth: `${seconds}.${String(microseconds).padStart(6, '0')}`,
      })
    }
    return table
  },
  catch: cause =>
    new ProcessObservationLost({
      message: `The process table could not be read: ${errorText(cause)}`,
    }),
})

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
