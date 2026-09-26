import { constants } from 'node:fs'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { Effect } from 'effect'
import type { EditOperations } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit.js'
import type { WriteOperations } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/write.js'
import type { WorkspaceAttachment, WorkspaceGrant } from './workspace-domain.ts'
import { canonicalPath, isWithin } from './workspace-paths.ts'

interface NativeWrite {
  readonly toolCallId: string
  readonly attachment: WorkspaceAttachment
  readonly grant: WorkspaceGrant
  readonly destination: string
  readonly identity: string
  started?: Promise<void>
}

export interface NativeWrites {
  readonly writeOperations: WriteOperations
  readonly editOperations: EditOperations
  admit(input: {
    readonly toolCallId: string
    readonly attachment: WorkspaceAttachment
    readonly grant: WorkspaceGrant
  }): void
  finish(toolCallId: string): Promise<void>
  settle(): Promise<void>
}

const SETTLE_WAIT_MS = 2000

// macOS volumes ignore case and normalization by default. Folding through upper case also
// catches expansions that lowercasing misses, such as ß and ss; any spelling this fold
// still separates is admitted as a distinct destination.
const destinationIdentity = (path: string): string =>
  path.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC')

// Only the destination's final component is opened without following links; the
// authority re-resolves its ancestors at the start boundary just before.
const NO_FOLLOW_WRITE =
  constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW

// Pi runs a call only after every hook of its batch, and sibling calls may run in
// between, so the start boundary is reported from inside the write, next to its open.
// After the session shuts down Pi no longer reports a call's end, so shutdown refuses
// further operations and settles every admitted write itself.
export const createNativeWrites = (onError: (message: string) => void): NativeWrites => {
  const writes = new Map<string, NativeWrite>()
  let inProgress = 0
  let closing = false

  const complete = async (write: NativeWrite): Promise<void> => {
    writes.delete(write.toolCallId)
    try {
      await Effect.runPromise(
        write.attachment.reportExecution(write.grant, { kind: 'operation-completed' })
      )
    } catch (error) {
      onError(
        `Native file write ${write.toolCallId} could not be settled: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  const operate = async <A>(
    path: string,
    role: 'destination' | 'parent',
    operation: () => Promise<A>
  ): Promise<A> => {
    inProgress += 1
    try {
      if (closing) throw new Error('The session is closing; the file operation was not run')
      const actual = canonicalPath(path).path
      const matched = [...writes.values()].filter(write =>
        role === 'destination'
          ? write.destination === actual
          : write.destination !== actual && isWithin(actual, write.destination)
      )
      if (matched.length === 0)
        throw new Error(`Native file operation on ${path} matches no admitted destination`)
      for (const write of matched) {
        write.started ??= Effect.runPromise(
          write.attachment.reportExecution(write.grant, { kind: 'operation-started' })
        )
        await write.started
      }
      return await operation()
    } finally {
      inProgress -= 1
    }
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
    admit(input) {
      if (closing) throw new Error('The session is closing')
      const destination = input.grant.path
      if (destination === undefined) throw new Error('A native write grant has no destination')
      const identity = destinationIdentity(destination)
      if ([...writes.values()].some(write => write.identity === identity))
        throw new Error(`Another native write to ${destination} is still in flight`)
      writes.set(input.toolCallId, { ...input, destination, identity })
    },
    async finish(toolCallId) {
      const write = writes.get(toolCallId)
      if (write !== undefined) await complete(write)
    },
    async settle() {
      closing = true
      try {
        const deadline = Date.now() + SETTLE_WAIT_MS
        while (inProgress > 0 && Date.now() < deadline) await sleep(25)
        if (inProgress === 0) await Promise.all([...writes.values()].map(complete))
      } finally {
        closing = false
      }
    },
  }
}
