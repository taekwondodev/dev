import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { Schema } from 'effect'
import type { AuthorityPaths } from './workspace-authority-root.ts'
import {
  blocked,
  requireReview,
  unavailable,
  WorkspaceError,
  WorkspaceId,
} from './workspace-domain.ts'
import type { GitWorkspace } from './workspace-git.ts'
import { canonicalPathSlot, lstatIfExists, sqliteCode } from './workspace-paths.ts'
import {
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  PROTOCOL_SQL,
  GATE_SQL,
  first,
  textField,
  numberField,
  schemaCatalog,
  expectedCatalog,
  createPublishedDatabase,
} from './workspace-sqlite.ts'
import { errorText } from './error-text.ts'
import { hash, privateDirectory, privateFile } from './workspace-platform.ts'

const SHARED_GATE_WAIT_MS = 250

export type GateRelease = () => void

const openLockDatabase = (path: string, waitMs: number): DatabaseSync => {
  const db = new DatabaseSync(path, { timeout: 0, allowExtension: false })
  // A waiting acquirer only ever waits out a momentary probe, never a holder.
  db.exec(`PRAGMA busy_timeout = ${waitMs}; PRAGMA synchronous = FULL; PRAGMA fullfsync = ON;`)
  return db
}
const lockFormatSupported = (db: DatabaseSync, ddl: string): boolean =>
  textField(first(db, 'PRAGMA journal_mode'), 'journal_mode').toLowerCase() === 'delete' &&
  numberField(first(db, 'PRAGMA user_version'), 'user_version') === SCHEMA_VERSION &&
  schemaCatalog(db) === expectedCatalog(ddl)

// The open transaction is the lock, so closing the database is the release.
const holdLock = (lock: {
  readonly path: string
  readonly ddl: string
  readonly name: 'Workspace gate' | 'Workspace protocol gate'
  readonly waitMs: number
  readonly exclusive: boolean
  readonly verifyMarker: (db: DatabaseSync) => void
  readonly verifyHeld: (db: DatabaseSync) => void
  readonly busy: string
  readonly releaseFailure: string
}): GateRelease => {
  privateFile(lock.path)
  let db: DatabaseSync | undefined
  try {
    db = openLockDatabase(lock.path, lock.waitMs)
    if (!lockFormatSupported(db, lock.ddl))
      unavailable(`${lock.name} has an unsupported format: ${lock.path}`)
    lock.verifyMarker(db)
    db.exec(lock.exclusive ? 'BEGIN EXCLUSIVE' : 'BEGIN')
    lock.verifyHeld(db)
    const locked = db
    db = undefined
    let released = false
    return () => {
      if (released) return
      try {
        locked.close()
        released = true
      } catch (cause) {
        unavailable(`${lock.releaseFailure}: ${errorText(cause)}`)
      }
    }
  } catch (cause) {
    db?.close()
    if (cause instanceof WorkspaceError) throw cause
    if (sqliteCode(cause) === 5 || sqliteCode(cause) === 6) blocked(lock.busy)
    unavailable(`Cannot acquire ${lock.name.toLowerCase()} ${lock.path}: ${errorText(cause)}`)
  }
}

export const createProtocolDatabase = (path: string, namespaceId: WorkspaceId): void =>
  createPublishedDatabase(path, 'protocol', db => {
    db.prepare('INSERT INTO protocol_marker(id, version, namespace_id) VALUES(1, ?, ?)').run(
      PROTOCOL_VERSION,
      namespaceId
    )
  })

export const validateProtocol = (path: string): WorkspaceId => {
  privateFile(path)
  let db: DatabaseSync | undefined
  try {
    db = openLockDatabase(path, 0)
    if (!lockFormatSupported(db, PROTOCOL_SQL))
      unavailable(`Workspace protocol gate has an unsupported format: ${path}`)
    const row = first(db, 'SELECT version, namespace_id FROM protocol_marker WHERE id = 1')
    if (numberField(row, 'version') !== PROTOCOL_VERSION)
      unavailable(`Workspace protocol version mismatch at ${path}`)
    const actual = textField(row, 'namespace_id')
    if (!Schema.is(WorkspaceId)(actual))
      return requireReview(`Workspace protocol identity mismatch at ${path}`)
    return actual
  } catch (cause) {
    if (cause instanceof WorkspaceError) throw cause
    unavailable(`Cannot validate workspace protocol gate ${path}: ${errorText(cause)}`)
  } finally {
    db?.close()
  }
}

export const acquireProtocolGate = (
  path: string,
  root: string,
  namespaceId: WorkspaceId
): GateRelease =>
  holdLock({
    path,
    ddl: PROTOCOL_SQL,
    name: 'Workspace protocol gate',
    waitMs: 0,
    exclusive: false,
    verifyMarker: db => {
      const marker = first(db, 'SELECT version, namespace_id FROM protocol_marker WHERE id=1')
      if (
        numberField(marker, 'version') !== PROTOCOL_VERSION ||
        textField(marker, 'namespace_id') !== namespaceId
      )
        requireReview(`Workspace protocol identity changed at ${path}`)
    },
    verifyHeld: db => {
      const marker = first(db, 'SELECT namespace_id FROM protocol_marker WHERE id=1')
      if (textField(marker, 'namespace_id') !== namespaceId)
        requireReview(`Workspace protocol marker changed while joining ${root}`)
    },
    busy: `Workspace protocol gate is busy: ${root}`,
    releaseFailure: `Cannot release protocol gate ${root}`,
  })

const gateDirectory = (
  paths: AuthorityPaths,
  family: 'paths' | 'repos' | 'conversations' | 'incarnations',
  key: string
): string => {
  const directory = join(paths.gates, family, key)
  privateDirectory(join(paths.gates, family), true)
  privateDirectory(directory, true)
  return directory
}

const acquireGate = (
  path: string,
  kind: string,
  identityPath: string,
  key: string,
  exclusive: boolean
): GateRelease => {
  privateDirectory(dirname(path), false)
  if (lstatIfExists(path) === undefined)
    createPublishedDatabase(path, 'gate', db => {
      db.prepare('INSERT INTO gate_marker(id, version, kind, path, key) VALUES(1, ?, ?, ?, ?)').run(
        PROTOCOL_VERSION,
        kind,
        identityPath,
        key
      )
    })
  return holdLock({
    path,
    ddl: GATE_SQL,
    name: 'Workspace gate',
    waitMs: exclusive ? 0 : SHARED_GATE_WAIT_MS,
    exclusive,
    verifyMarker: db => {
      const marker = first(db, 'SELECT version, kind, path, key FROM gate_marker WHERE id=1')
      if (
        numberField(marker, 'version') !== PROTOCOL_VERSION ||
        textField(marker, 'kind') !== kind ||
        textField(marker, 'path') !== identityPath ||
        textField(marker, 'key') !== key
      )
        requireReview(
          `Workspace gate identity was replaced or does not match its canonical path: ${path}`
        )
    },
    verifyHeld: db => {
      if (textField(first(db, 'SELECT kind FROM gate_marker WHERE id=1'), 'kind') !== kind)
        requireReview(`Workspace gate marker changed while acquiring ${path}`)
    },
    busy: `Workspace ${kind === 'use' ? 'presence' : kind} gate is busy: ${identityPath}`,
    releaseFailure: `Cannot release workspace gate ${path}`,
  })
}

export interface PathGates {
  readonly use: GateRelease
  readonly writer?: GateRelease
}
export const acquirePathGates = (
  paths: AuthorityPaths,
  path: string,
  writer: boolean
): PathGates => {
  const canonical = canonicalPathSlot(path)
  const key = hash(canonical)
  const directory = gateDirectory(paths, 'paths', key)
  const presence = acquireGate(join(directory, 'use.sqlite'), 'use', canonical, key, false)
  try {
    if (!writer) return { use: presence }
    return {
      use: presence,
      writer: acquireGate(join(directory, 'writer.sqlite'), 'writer', canonical, key, true),
    }
  } catch (cause) {
    presence()
    throw cause
  }
}
export const acquireStructureGate = (
  paths: AuthorityPaths,
  repository: GitWorkspace,
  repositoryId: WorkspaceId
): GateRelease => {
  const key = repositoryId
  const directory = gateDirectory(paths, 'repos', key)
  return acquireGate(
    join(directory, 'structure.sqlite'),
    'structure',
    repository.commonPath,
    key,
    true
  )
}
const conversationGate = (
  paths: AuthorityPaths,
  identity: string
): { readonly key: string; readonly path: string } => {
  const key = hash(identity)
  return { key, path: join(paths.gates, 'conversations', key, 'conversation.sqlite') }
}
const incarnationGate = (paths: AuthorityPaths, incarnation: string): string =>
  join(paths.gates, 'incarnations', incarnation, 'incarnation.sqlite')

export interface ConversationPresence {
  readonly incarnation: string
  readonly release: GateRelease
}

export const acquireConversationPresence = (
  paths: AuthorityPaths,
  identity: string
): ConversationPresence => {
  const gate = conversationGate(paths, identity)
  gateDirectory(paths, 'conversations', gate.key)
  let releaseConversation: GateRelease
  try {
    releaseConversation = acquireGate(gate.path, 'conversation', identity, gate.key, true)
  } catch (cause) {
    if (cause instanceof WorkspaceError && cause.outcome === 'blocked')
      blocked('This conversation is open in another dev session; close it there first')
    throw cause
  }
  const incarnation = randomUUID()
  const directory = gateDirectory(paths, 'incarnations', incarnation)
  try {
    const releaseIncarnation = acquireGate(
      incarnationGate(paths, incarnation),
      'incarnation',
      incarnation,
      incarnation,
      true
    )
    return {
      incarnation,
      release: () => {
        try {
          releaseIncarnation()
          // An incarnation token is never reused, so its gate can go once released.
          rmSync(directory, { recursive: true, force: true })
        } finally {
          releaseConversation()
        }
      },
    }
  } catch (cause) {
    releaseConversation()
    throw cause
  }
}

export const incarnationHeld = (paths: AuthorityPaths, incarnation: string): boolean => {
  const path = incarnationGate(paths, incarnation)
  if (lstatIfExists(path) === undefined) return false
  try {
    acquireGate(path, 'incarnation', incarnation, incarnation, true)()
    return false
  } catch (cause) {
    if (cause instanceof WorkspaceError && cause.outcome === 'blocked') return true
    throw cause
  }
}
export const releaseGates = (gates: PathGates): void => {
  gates.writer?.()
  gates.use()
}
