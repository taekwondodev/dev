import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  type BigIntStats,
} from 'node:fs'
import { join } from 'node:path'
import { Effect, Schema } from 'effect'
import { WorkspaceAuthority } from './workspace-authority.ts'
import { defaultAuthorityRoot } from './workspace-authority-root.ts'
import { withDisposableConversation } from './workspace-retention.ts'
import { expiredConversations } from './conversation-retention.ts'
import { WorkStore } from './work-store.ts'
import { errorText } from './error-text.ts'
import { canonicalPath } from './workspace-paths.ts'

const Header = Schema.Struct({
  type: Schema.Literal('session'),
  id: Schema.NonEmptyString,
  timestamp: Schema.NonEmptyString,
  cwd: Schema.NonEmptyString,
})
const Entry = Schema.Struct({
  type: Schema.Literals([
    'message',
    'thinking_level_change',
    'model_change',
    'usage',
    'compaction',
    'branch_summary',
    'custom',
    'label',
    'session_info',
    'custom_message',
    'context_edit',
  ]),
  id: Schema.NonEmptyString,
  parentId: Schema.NullOr(Schema.String),
  timestamp: Schema.NonEmptyString,
})
const decodeHeader = Schema.decodeUnknownSync(Schema.fromJsonString(Header))
const decodeEntry = Schema.decodeUnknownSync(Schema.fromJsonString(Entry))

export class CleanupError extends Schema.TaggedError<CleanupError>()('CleanupError', {
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
const sameFile = (left: BigIntStats, right: BigIntStats): boolean =>
  right.isFile() &&
  right.nlink === 1n &&
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs &&
  left.size === right.size

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
      if (!sameFile(before, fstatSync(fd, { bigint: true }))) return []
      const lines = readFileSync(fd, 'utf8')
        .split('\n')
        .filter(line => line.trim() !== '')
      const header = decodeHeader(lines[0])
      for (const line of lines.slice(1)) decodeEntry(line)
      if (!sameFile(before, fstatSync(fd, { bigint: true }))) return []
      return [
        {
          path,
          sessionId: header.id,
          modifiedAt: before.mtimeNs,
          identity: before,
          eligible: true,
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
      let removed = 0
      for (const category of ['sessions', 'child-sessions']) {
        const directory = join(home, category)
        let candidates: readonly Candidate[]
        try {
          candidates = inventory(directory)
        } catch {
          continue
        }
        for (const candidate of candidates) {
          candidate.eligible = false
          if (sessions.has(candidate.sessionId) || files.has(candidate.path)) continue
          try {
            candidate.eligible =
              withDisposableConversation(
                authority,
                {
                  sessionId: candidate.sessionId,
                  sessionFile: candidate.path,
                  dataHome: home,
                },
                () => true
              ) === true
          } catch {
            continue
          }
        }
        for (const candidate of expiredConversations(candidates)) {
          try {
            withDisposableConversation(
              authority,
              {
                sessionId: candidate.sessionId,
                sessionFile: candidate.path,
                dataHome: home,
              },
              () => {
                if (realpathSync(directory) !== directory || !lstatSync(directory).isDirectory())
                  return
                if (!sameFile(candidate.identity, lstatSync(candidate.path, { bigint: true })))
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
