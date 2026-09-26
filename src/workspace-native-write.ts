import { constants } from 'node:fs'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { Duration, Effect, Schema } from 'effect'
import type { EditOperations } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit.js'
import type { WriteOperations } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/write.js'
import type { WorkspaceAttachment, WorkspaceError, WorkspaceGrant } from './workspace-domain.ts'
import { canonicalPath, isWithin } from './workspace-paths.ts'

export class NativeWriteRefused extends Schema.TaggedError<NativeWriteRefused>()(
  'NativeWriteRefused',
  { message: Schema.String }
) {}

interface NativeWrite {
  readonly toolCallId: string
  readonly attachment: WorkspaceAttachment
  readonly grant: WorkspaceGrant
  readonly destination: string
  readonly identity: string
  started?: Effect.Effect<void, WorkspaceError>
}

export interface NativeWrites {
  readonly writeOperations: WriteOperations
  readonly editOperations: EditOperations
  admit(input: {
    readonly toolCallId: string
    readonly attachment: WorkspaceAttachment
    readonly grant: WorkspaceGrant
  }): Effect.Effect<void, NativeWriteRefused>
  finish(toolCallId: string): Effect.Effect<void>
  readonly settle: Effect.Effect<void>
}

const SETTLE_WAIT_MS = 2000
const SETTLE_POLL = Duration.millis(25)

// macOS volumes ignore case and normalization by default. Folding through upper case also
// catches expansions that lowercasing misses, such as ß and ss; any spelling this fold
// still separates is admitted as a distinct destination.
const destinationIdentity = (path: string): string =>
  path.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC')

// Only the destination's final component is opened without following links; the
// authority re-resolves its ancestors at the start boundary just before.
const NO_FOLLOW_WRITE =
  constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW

// Start and completion are reported where ADR 0005 places them: from inside the write, and
// by this module at shutdown, after which Pi no longer reports a call's end.
export const makeNativeWrites = (onError: (message: string) => void): NativeWrites => {
  const writes = new Map<string, NativeWrite>()
  let inProgress = 0
  let closing = false

  const complete = (write: NativeWrite): Effect.Effect<void> =>
    Effect.suspend(() => {
      writes.delete(write.toolCallId)
      return write.attachment
        .reportExecution(write.grant, { kind: 'operation-completed' })
        .pipe(
          Effect.catch(error =>
            Effect.sync(() =>
              onError(
                `Native file write ${write.toolCallId} could not be settled: ${error.message}`
              )
            )
          )
        )
    })

  // Pi calls these operations with Promises. A filesystem failure reaches Pi's tool as the
  // original Node error, so it is carried as a defect rather than translated.
  const operate = <A>(
    path: string,
    role: 'destination' | 'parent',
    operation: () => Promise<A>
  ): Promise<A> => {
    inProgress += 1
    return Effect.runPromise(
      Effect.gen(function* () {
        if (closing)
          return yield* new NativeWriteRefused({
            message: 'The session is closing; the file operation was not run',
          })
        const actual = canonicalPath(path).path
        const matched = [...writes.values()].filter(write =>
          role === 'destination'
            ? write.destination === actual
            : write.destination !== actual && isWithin(actual, write.destination)
        )
        if (matched.length === 0)
          return yield* new NativeWriteRefused({
            message: `Native file operation on ${path} matches no admitted destination`,
          })
        for (const write of matched) {
          write.started ??= yield* Effect.cached(
            write.attachment.reportExecution(write.grant, { kind: 'operation-started' })
          )
          yield* write.started
        }
        return yield* Effect.promise(operation)
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            inProgress -= 1
          })
        )
      )
    )
  }

  const writeFileOperation = (path: string, content: string) =>
    operate(path, 'destination', () =>
      writeFile(path, content, { encoding: 'utf-8', flag: NO_FOLLOW_WRITE })
    )

  return {
    writeOperations: {
      mkdir: dir =>
        operate(dir, 'parent', async () => {
          await mkdir(dir, { recursive: true })
        }),
      writeFile: writeFileOperation,
    },
    editOperations: {
      access: path =>
        operate(path, 'destination', () => access(path, constants.R_OK | constants.W_OK)),
      readFile: path => operate(path, 'destination', () => readFile(path)),
      writeFile: writeFileOperation,
    },
    admit: input =>
      Effect.suspend(() => {
        if (closing)
          return Effect.fail(new NativeWriteRefused({ message: 'The session is closing' }))
        const destination = input.grant.path
        if (destination === undefined)
          return Effect.fail(
            new NativeWriteRefused({ message: 'A native write grant has no destination' })
          )
        const identity = destinationIdentity(destination)
        if ([...writes.values()].some(write => write.identity === identity))
          return Effect.fail(
            new NativeWriteRefused({
              message: `Another native write to ${destination} is still in flight`,
            })
          )
        writes.set(input.toolCallId, { ...input, destination, identity })
        return Effect.void
      }),
    finish: toolCallId =>
      Effect.suspend(() => {
        const write = writes.get(toolCallId)
        return write === undefined ? Effect.void : complete(write)
      }),
    settle: Effect.gen(function* () {
      closing = true
      const deadline = Date.now() + SETTLE_WAIT_MS
      while (inProgress > 0 && Date.now() < deadline) yield* Effect.sleep(SETTLE_POLL)
      if (inProgress === 0)
        yield* Effect.forEach([...writes.values()], complete, {
          concurrency: 'unbounded',
          discard: true,
        })
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          closing = false
        })
      )
    ),
  }
}
