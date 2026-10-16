import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  type BigIntStats,
} from 'node:fs'
import { join } from 'node:path'
import { Effect, Schema } from 'effect'
import { WorkspaceAuthority } from './workspace-authority.ts'
import { defaultAuthorityRoot } from './workspace-authority-root.ts'
import { conversationRecord } from './workspace-attachment.ts'
import {
  type ConversationIdentity,
  conversationInUse,
  retentionFacts,
  withDisposableConversation,
} from './workspace-retention.ts'
import {
  RETAINED_CONVERSATIONS,
  expiredConversations,
  newestFirst,
} from './conversation-retention.ts'
import { WorkStore } from './work-store.ts'
import { errorText } from './error-text.ts'
import { canonicalPath } from './workspace-paths.ts'

const Header = Schema.Struct({
  type: Schema.Literal('session'),
  id: Schema.NonEmptyString,
  timestamp: Schema.NonEmptyString,
  cwd: Schema.NonEmptyString,
})
const decodeHeader = Schema.decodeUnknownSync(Schema.fromJsonString(Header))
const HEADER_BYTES = 64 * 1024

export class CleanupError extends Schema.TaggedError<
  CleanupError,
  { readonly brand: unique symbol }
>()('CleanupError', {
  message: Schema.String,
}) {}
const cleanupError = (cause: unknown) => new CleanupError({ message: errorText(cause) })

interface Candidate {
  readonly path: string
  readonly sessionId: string
  readonly modifiedAt: bigint
  readonly identity: BigIntStats
  eligible: boolean
}
const sameIdentity = (left: BigIntStats, right: BigIntStats): boolean =>
  right.isFile() &&
  right.nlink === 1n &&
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mtimeNs === right.mtimeNs

const readHeader = (fd: number): string | undefined => {
  const buffer = Buffer.alloc(HEADER_BYTES)
  const read = readSync(fd, buffer, 0, HEADER_BYTES, 0)
  const newline = buffer.indexOf('\n')
  if (newline !== -1 && newline < read) return buffer.toString('utf8', 0, newline)
  return read < HEADER_BYTES ? buffer.toString('utf8', 0, read) : undefined
}

const inventory = (directory: string): readonly Candidate[] => {
  const info = lstatSync(directory)
  if (!info.isDirectory() || info.uid !== process.getuid?.())
    throw new Error(`Cleanup requires an owned directory: ${directory}`)
  return readdirSync(directory).flatMap(name => {
    if (!name.endsWith('.jsonl')) return []
    const path = join(directory, name)
    let fd: number | undefined
    try {
      const before = lstatSync(path, { bigint: true })
      if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(info.uid)) return []
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      if (!sameIdentity(before, fstatSync(fd, { bigint: true }))) return []
      const line = readHeader(fd)
      if (line === undefined) return []
      return [
        {
          path,
          sessionId: decodeHeader(line).id,
          modifiedAt: before.mtimeNs,
          identity: before,
          eligible: false,
        },
      ]
    } catch {
      return []
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  })
}

export const cleanConversations = Effect.fnUntraced(function* (
  dataHome: string,
  authorityRoot = defaultAuthorityRoot()
) {
  const store = yield* WorkStore
  const protectedData = yield* store.maintain
  const sessions = new Set<string>(protectedData.sessionIds)
  const files = new Set(
    yield* Effect.try({
      try: () => protectedData.files.map(path => canonicalPath(path).path),
      catch: cleanupError,
    })
  )
  const authority = yield* Effect.acquireRelease(
    Effect.try({ try: () => new WorkspaceAuthority(authorityRoot), catch: cleanupError }),
    value => Effect.sync(() => value.close())
  )
  return yield* Effect.try({
    try: () => {
      const home = realpathSync(dataHome)
      if (!lstatSync(dataHome).isDirectory() || lstatSync(home).uid !== process.getuid?.())
        throw new Error('Cleanup requires an owned data home without a symlink')
      authority.initialize()
      const facts = retentionFacts(authority)
      const identify = (candidate: Candidate): ConversationIdentity | undefined => {
        if (sessions.has(candidate.sessionId) || files.has(candidate.path)) return undefined
        try {
          const identity = conversationRecord({
            sessionId: candidate.sessionId,
            sessionFile: candidate.path,
            dataHome: home,
          })
          return facts.retains(identity) ? undefined : identity
        } catch {
          return undefined
        }
      }
      let removed = 0
      for (const category of ['sessions', 'child-sessions']) {
        const directory = join(home, category)
        let candidates: readonly Candidate[]
        try {
          candidates = inventory(directory)
        } catch {
          continue
        }
        let kept = 0
        for (const candidate of candidates.toSorted(newestFirst)) {
          const identity = identify(candidate)
          if (identity === undefined) continue
          if (kept < RETAINED_CONVERSATIONS) {
            if (conversationInUse(authority, identity)) continue
            kept += 1
          }
          candidate.eligible = true
        }
        for (const candidate of expiredConversations(candidates)) {
          try {
            withDisposableConversation(
              authority,
              { sessionId: candidate.sessionId, sessionFile: candidate.path, dataHome: home },
              () => {
                if (realpathSync(directory) !== directory || !lstatSync(directory).isDirectory())
                  return
                if (!sameIdentity(candidate.identity, lstatSync(candidate.path, { bigint: true })))
                  return
                unlinkSync(candidate.path)
                removed += 1
              }
            )
          } catch {
            continue
          }
        }
      }
      return removed
    },
    catch: cleanupError,
  })
})
