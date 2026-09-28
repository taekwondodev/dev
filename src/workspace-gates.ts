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
import { canonicalPathSlot } from './workspace-paths.ts'
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
  sqliteBusy,
} from './workspace-sqlite.ts'
import { errorText } from './error-text.ts'
import { hash, lstatIfExists, newId, privateDirectory, privateFile } from './workspace-platform.ts'

const SHARED_GATE_WAIT_MS = 250

export type GateRelease = () => void

const lockFormatSupported = (db: DatabaseSync, ddl: string): boolean =>
  textField(first(db, 'PRAGMA journal_mode'), 'journal_mode').toLowerCase() === 'delete' &&
  numberField(first(db, 'PRAGMA user_version'), 'user_version') === SCHEMA_VERSION &&
  schemaCatalog(db) === expectedCatalog(ddl)

const openLock = (lock: {
  readonly path: string
  readonly name: 'Workspace gate' | 'Workspace protocol gate'
  readonly ddl: string
  readonly waitMs: number
  readonly readOnly?: boolean
}): DatabaseSync => {
  privateFile(lock.path)
  const db = new DatabaseSync(lock.path, {
    readOnly: lock.readOnly === true,
    timeout: 0,
    allowExtension: false,
  })
  try {
    db.exec(
      `PRAGMA busy_timeout = ${lock.waitMs}; PRAGMA synchronous = FULL; PRAGMA fullfsync = ON;`
    )
    if (!lockFormatSupported(db, lock.ddl))
      unavailable(`${lock.name} has an unsupported format: ${lock.path}`)
    return db
  } catch (cause) {
    db.close()
    throw cause
  }
}

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
  let db: DatabaseSync | undefined
  try {
    db = openLock(lock)
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
    if (sqliteBusy(cause)) blocked(lock.busy)
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
  let db: DatabaseSync | undefined
  try {
    db = openLock({ path, name: 'Workspace protocol gate', ddl: PROTOCOL_SQL, waitMs: 0 })
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

type GateKind = 'use' | 'writer' | 'structure' | 'conversation' | 'incarnation'
interface GateIdentity {
  readonly kind: GateKind
  readonly path: string
  readonly key: string
}

const verifyGateMarker = (db: DatabaseSync, path: string, identity: GateIdentity): void => {
  const marker = first(db, 'SELECT version, kind, path, key FROM gate_marker WHERE id=1')
  if (
    numberField(marker, 'version') !== PROTOCOL_VERSION ||
    textField(marker, 'kind') !== identity.kind ||
    textField(marker, 'path') !== identity.path ||
    textField(marker, 'key') !== identity.key
  )
    requireReview(
      `Workspace gate identity was replaced or does not match its canonical path: ${path}`
    )
}

const acquireGate = (path: string, identity: GateIdentity, exclusive: boolean): GateRelease => {
  privateDirectory(dirname(path), false)
  if (lstatIfExists(path) === undefined)
    createPublishedDatabase(path, 'gate', db => {
      db.prepare('INSERT INTO gate_marker(id, version, kind, path, key) VALUES(1, ?, ?, ?, ?)').run(
        PROTOCOL_VERSION,
        identity.kind,
        identity.path,
        identity.key
      )
    })
  return holdLock({
    path,
    ddl: GATE_SQL,
    name: 'Workspace gate',
    waitMs: exclusive ? 0 : SHARED_GATE_WAIT_MS,
    exclusive,
    verifyMarker: db => verifyGateMarker(db, path, identity),
    verifyHeld: db => {
      if (textField(first(db, 'SELECT kind FROM gate_marker WHERE id=1'), 'kind') !== identity.kind)
        requireReview(`Workspace gate marker changed while acquiring ${path}`)
    },
    busy: `Workspace ${identity.kind === 'use' ? 'presence' : identity.kind} gate is busy: ${identity.path}`,
    releaseFailure: `Cannot release workspace gate ${path}`,
  })
}

export interface PathGates {
  readonly use: GateRelease
  readonly writer?: GateRelease
}
export type PathGateMode = 'reader' | 'writer' | 'removal'
export const acquirePathGates = (
  paths: AuthorityPaths,
  path: string,
  mode: PathGateMode
): PathGates => {
  const canonical = canonicalPathSlot(path)
  const key = hash(canonical)
  const directory = gateDirectory(paths, 'paths', key)
  const presence = acquireGate(
    join(directory, 'use.sqlite'),
    { kind: 'use', path: canonical, key },
    mode === 'removal'
  )
  try {
    if (mode === 'reader') return { use: presence }
    return {
      use: presence,
      writer: acquireGate(
        join(directory, 'writer.sqlite'),
        { kind: 'writer', path: canonical, key },
        true
      ),
    }
  } catch (cause) {
    presence()
    throw cause
  }
}
export const acquireStructureGate = (
  paths: AuthorityPaths,
  repository: Pick<GitWorkspace, 'commonPath'>,
  repositoryId: WorkspaceId
): GateRelease => {
  const key = repositoryId
  const directory = gateDirectory(paths, 'repos', key)
  return acquireGate(
    join(directory, 'structure.sqlite'),
    { kind: 'structure', path: repository.commonPath, key },
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
const incarnationGate = (paths: AuthorityPaths, incarnation: WorkspaceId): string =>
  join(paths.gates, 'incarnations', incarnation, 'incarnation.sqlite')
const incarnationIdentity = (incarnation: WorkspaceId): GateIdentity => ({
  kind: 'incarnation',
  path: incarnation,
  key: incarnation,
})

export interface ConversationPresence {
  readonly incarnation: WorkspaceId
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
    releaseConversation = acquireGate(
      gate.path,
      { kind: 'conversation', path: identity, key: gate.key },
      true
    )
  } catch (cause) {
    if (cause instanceof WorkspaceError && cause.outcome === 'blocked')
      blocked('This conversation is open in another dev session; close it there first')
    throw cause
  }
  const incarnation = newId()
  const directory = gateDirectory(paths, 'incarnations', incarnation)
  try {
    const releaseIncarnation = acquireGate(
      incarnationGate(paths, incarnation),
      incarnationIdentity(incarnation),
      true
    )
    return {
      incarnation,
      release: () => {
        try {
          releaseIncarnation()
          try {
            rmSync(directory, { recursive: true, force: true })
          } catch {}
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

export const incarnationHeld = (paths: AuthorityPaths, incarnation: WorkspaceId): boolean => {
  const path = incarnationGate(paths, incarnation)
  const removed = () => lstatIfExists(path) === undefined
  if (removed()) return false
  let db: DatabaseSync | undefined
  try {
    db = openLock({ path, name: 'Workspace gate', ddl: GATE_SQL, waitMs: 0, readOnly: true })
    verifyGateMarker(db, path, incarnationIdentity(incarnation))
    return false
  } catch (cause) {
    if (sqliteBusy(cause)) return true
    if (removed()) return false
    if (cause instanceof WorkspaceError) throw cause
    return unavailable(`Cannot probe workspace gate ${path}: ${errorText(cause)}`)
  } finally {
    db?.close()
  }
}
export const releaseGates = (gates: PathGates): void => {
  gates.writer?.()
  gates.use()
}
