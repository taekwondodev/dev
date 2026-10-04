import { execFileSync } from 'node:child_process'
import { lstatSync, realpathSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { userInfo } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  invalid,
  requireReview,
  unavailable,
  WorkspaceError,
  type WorkspaceGrant,
  type WorkspaceId,
} from './workspace-domain.ts'
import {
  acquireProtocolGate,
  acquireStructureGate,
  createProtocolDatabase,
  validateProtocol,
  type GateRelease,
} from './workspace-gates.ts'
import { authorityPaths, type AuthorityPaths } from './workspace-authority-root.ts'
import type { GitWorkspace } from './workspace-git.ts'
import { canonicalPath, isWithin } from './workspace-paths.ts'
import {
  RepositoryCatalogSchema,
  getWorkspace,
  getReservationById,
  getBinding,
  validateWorkspacePath,
  type RepositoryCatalogRecord,
  type WorkspaceRecord,
  type ReservationRecord,
  type BindingRecord,
  type UseRecord,
} from './workspace-records.ts'
import {
  encode,
  parseRecord,
  assertSqliteSafety,
  rows,
  first,
  textField,
  numberField,
  createPublishedDatabase,
  databaseFile,
  openRecordDb,
  transaction,
  sqliteCode,
  type SqlRow,
} from './workspace-sqlite.ts'
import { errorText } from './error-text.ts'
import {
  newId,
  fsyncPath,
  fsyncParent,
  hasErrorCode,
  lstatIfExists,
  privateDirectory,
  ensureDirectoryPath,
} from './workspace-platform.ts'

const canonicalRoot = (requested: string): string => {
  if (!isAbsolute(requested)) invalid('Workspace authority root must be an absolute path')
  const absolute = resolve(requested)
  if (lstatIfExists(absolute)?.isSymbolicLink())
    unavailable(`Workspace authority root must not be a symbolic link: ${absolute}`)
  return canonicalPath(absolute).path
}

const SUPPORTED_FILESYSTEMS = new Set(['apfs', 'hfs'])
const SYNCHRONIZED_FOLDERS = [
  ['Library', 'Mobile Documents'],
  ['Library', 'CloudStorage'],
] as const
export const unsupportedAuthorityStorage = (input: {
  readonly path: string
  readonly home: string
  readonly mountTable: string
}): string | undefined => {
  for (const parts of SYNCHRONIZED_FOLDERS) {
    const folder = join(input.home, ...parts)
    if (isWithin(folder, input.path))
      return `Workspace authority cannot live in a synchronized folder: ${folder}`
  }
  let mount: { point: string; options: string[] } | undefined
  for (const line of input.mountTable.split('\n')) {
    const match = /^.+? on (.+) \((.+)\)$/.exec(line)
    if (match === null) continue
    const [, point = '', options = ''] = match
    if (point !== '' && point.length > (mount?.point.length ?? 0) && isWithin(point, input.path))
      mount = { point, options: options.split(', ') }
  }
  if (mount === undefined) return `Cannot identify the filesystem holding ${input.path}`
  const [type = 'unknown'] = mount.options
  if (!mount.options.includes('local'))
    return `Workspace authority requires local storage; ${mount.point} is a ${type} mount`
  if (!SUPPORTED_FILESYSTEMS.has(type))
    return `Workspace authority does not support ${type} storage at ${mount.point}`
  return undefined
}
const assertSupportedStorage = (root: string): void => {
  if (process.platform !== 'darwin')
    unavailable(`Workspace authority currently supports only macOS, not ${process.platform}`)
  let mountTable: string
  try {
    mountTable = execFileSync('/sbin/mount', { encoding: 'utf8' })
  } catch (cause) {
    return unavailable(`Cannot inspect the storage holding ${root}: ${errorText(cause)}`)
  }
  const reason = unsupportedAuthorityStorage({
    path: root,
    home: realpathSync(userInfo().homedir),
    mountTable,
  })
  if (reason !== undefined) unavailable(reason)
}

const catalogNamespace = (db: DatabaseSync): string =>
  textField(
    first(
      db,
      "SELECT value FROM catalog_meta WHERE key='namespace_id' AND (SELECT count(*) FROM catalog_meta)=1"
    ),
    'value'
  )
const createCatalogDatabase = (path: string, namespaceId: WorkspaceId): void => {
  createPublishedDatabase(path, 'catalog', db => {
    const insert = db.prepare('INSERT INTO catalog_meta(key, value) VALUES(?, ?)')
    insert.run('namespace_id', namespaceId)
  })

  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(path, { timeout: 0, allowExtension: false })
    db.exec('PRAGMA synchronous = FULL; PRAGMA fullfsync = ON;')
    const mode = textField(first(db, 'PRAGMA journal_mode = WAL'), 'journal_mode')
    if (mode.toLowerCase() !== 'wal')
      unavailable(`Cannot enable WAL for new workspace catalog: ${path}`)
    db.exec('PRAGMA synchronous = FULL; PRAGMA fullfsync = ON;')
    db.close()
    db = undefined
    fsyncPath(path, false)
    fsyncParent(path)
    databaseFile(path)
  } catch (cause) {
    if (cause instanceof WorkspaceError) throw cause
    unavailable(`Cannot durably enable WAL for workspace catalog ${path}: ${errorText(cause)}`)
  } finally {
    db?.close()
  }
}

const REPOSITORY_ROW =
  'SELECT id, common_path, volume_uuid, inode, object_format, state, provision_id, revision, payload FROM repositories'
const repositoryRow = (db: DatabaseSync, where: string, ...params: string[]): SqlRow | undefined =>
  first(db, `${REPOSITORY_ROW} WHERE ${where}`, ...params)
const registrationRows = (
  db: DatabaseSync,
  repository: GitWorkspace
): { readonly byPath: SqlRow | undefined; readonly byPhysical: SqlRow | undefined } => ({
  byPath: repositoryRow(db, 'common_path=?', repository.commonPath),
  byPhysical: repositoryRow(
    db,
    'volume_uuid=? AND inode=?',
    repository.commonIdentity.volumeUuid,
    repository.commonIdentity.inode
  ),
})

const parseRepositoryCatalogRow = (row: SqlRow): RepositoryCatalogRecord => {
  const value = parseRecord(
    RepositoryCatalogSchema,
    row.payload,
    `repository catalog entry ${textField(row, 'id')}`
  )
  if (
    value.id !== textField(row, 'id') ||
    value.commonPath !== textField(row, 'common_path') ||
    value.volumeUuid !== textField(row, 'volume_uuid') ||
    value.inode !== textField(row, 'inode') ||
    value.objectFormat !== textField(row, 'object_format') ||
    value.state !== textField(row, 'state') ||
    value.provisionId !== textField(row, 'provision_id') ||
    value.revision !== numberField(row, 'revision')
  )
    requireReview(`Repository catalog columns disagree with payload: ${value.id}`)
  return value
}
const matchesRepository = (record: RepositoryCatalogRecord, repository: GitWorkspace): boolean =>
  record.commonPath === repository.commonPath &&
  record.volumeUuid === repository.commonIdentity.volumeUuid &&
  record.inode === repository.commonIdentity.inode &&
  record.objectFormat === repository.objectFormat
const validateRepositoryRecord = (
  repository: GitWorkspace,
  row: SqlRow
): RepositoryCatalogRecord => {
  const value = parseRepositoryCatalogRow(row)
  if (!matchesRepository(value, repository))
    requireReview(`Git common-directory identity changed: ${repository.commonPath}`)
  return value
}

interface HeldShard {
  readonly db: DatabaseSync
  readonly record: RepositoryCatalogRecord
}
interface HeldHandles {
  catalog: DatabaseSync | undefined
  readonly shards: Map<WorkspaceId, HeldShard>
}

export class WorkspaceAuthority {
  readonly paths: AuthorityPaths
  readonly root: string
  private held: HeldHandles | undefined
  private namespaceId: WorkspaceId | undefined
  private protocolRelease: GateRelease | undefined
  private initialized = false
  private storageChecked = false
  private closed = false

  constructor(root: string) {
    this.root = canonicalRoot(root)
    this.paths = authorityPaths(this.root)
  }

  private checkStorage(): void {
    if (this.storageChecked) return
    assertSupportedStorage(this.root)
    this.storageChecked = true
  }

  private joinNamespace(): { readonly id: WorkspaceId; readonly release: GateRelease } {
    const id = validateProtocol(this.paths.protocol)
    const release = acquireProtocolGate(this.paths.protocol, this.root, id)
    try {
      const catalog = this.openCatalog()
      try {
        if (catalogNamespace(catalog) !== id)
          requireReview(`Workspace catalog does not match namespace ${this.root}`)
      } finally {
        catalog.close()
      }
    } catch (cause) {
      release()
      throw cause
    }
    return { id, release }
  }

  initialize(): WorkspaceId {
    if (this.closed) unavailable('Workspace lifecycle is closed')
    if (this.initialized)
      return this.namespaceId ?? requireReview('Workspace namespace identity is missing')
    this.checkStorage()
    assertSqliteSafety()
    const rootInfo = lstatIfExists(this.root)
    if (rootInfo === undefined) {
      ensureDirectoryPath(dirname(this.root))
      privateDirectory(this.root, true)
    } else privateDirectory(this.root, false)
    const protocolExists = lstatIfExists(this.paths.protocol) !== undefined
    const catalogExists = lstatIfExists(this.paths.catalog) !== undefined
    privateDirectory(this.paths.repos, true)
    privateDirectory(this.paths.gates, true)
    privateDirectory(this.paths.worktrees, true)
    if (!protocolExists && !catalogExists) {
      const children = [this.paths.repos, this.paths.gates, this.paths.worktrees]
      const hasEvidence = children.some(directory => {
        try {
          return lstatSync(directory).isDirectory() && entriesIfExists(directory).length > 0
        } catch {
          return true
        }
      })
      if (hasEvidence)
        requireReview(`Workspace authority has data but no namespace markers: ${this.root}`)
      createProtocolDatabase(this.paths.protocol, newId())
      createCatalogDatabase(this.paths.catalog, validateProtocol(this.paths.protocol))
    } else if (!protocolExists || !catalogExists) {
      requireReview(`Workspace authority has incomplete namespace markers: ${this.root}`)
    }
    const { id, release } = this.joinNamespace()
    this.namespaceId = id
    this.protocolRelease = release
    this.initialized = true
    return id
  }

  inspectExisting(): WorkspaceId | undefined {
    if (this.closed) unavailable('Workspace lifecycle is closed')
    this.checkStorage()
    const rootInfo = lstatIfExists(this.root)
    if (rootInfo === undefined) return undefined
    privateDirectory(this.root, false)
    const protocol = lstatIfExists(this.paths.protocol)
    const catalog = lstatIfExists(this.paths.catalog)
    if (protocol === undefined && catalog === undefined) {
      const entries = entriesIfExists(this.root)
      if (entries.length === 0) return undefined
      requireReview(`Workspace authority has files but no valid namespace markers: ${this.root}`)
    }
    if (protocol === undefined || catalog === undefined)
      requireReview(`Workspace authority is incomplete: ${this.root}`)
    const { id, release } = this.joinNamespace()
    release()
    return id
  }

  withHandles<A>(work: () => A): A {
    return this.holding(work)
  }

  private holding<A>(work: (held: HeldHandles) => A): A {
    if (this.held !== undefined) return work(this.held)
    const held: HeldHandles = { catalog: undefined, shards: new Map() }
    this.held = held
    try {
      return work(held)
    } finally {
      this.held = undefined
      for (const shard of held.shards.values()) shard.db.close()
      held.catalog?.close()
    }
  }

  private inCatalog<A>(work: (db: DatabaseSync) => A): A {
    return this.holding(held => {
      held.catalog ??= this.openCatalog()
      if (!held.catalog.isTransaction) return work(held.catalog)
      const db = this.openCatalog()
      try {
        return work(db)
      } finally {
        db.close()
      }
    })
  }

  inShard<A>(
    repositoryId: WorkspaceId,
    work: (db: DatabaseSync) => A,
    create = false,
    repository?: GitWorkspace
  ): A {
    return this.holding(held => {
      const shared = held.shards.get(repositoryId)
      if (shared !== undefined && !shared.db.isTransaction) {
        if (repository !== undefined && !matchesRepository(shared.record, repository))
          requireReview(`Repository identity changed for workspace shard ${repositoryId}`)
        return work(shared.db)
      }
      const opened = this.openShardRecord(repositoryId, create, repository)
      if (shared === undefined) {
        held.shards.set(repositoryId, opened)
        return work(opened.db)
      }
      try {
        return work(opened.db)
      } finally {
        opened.db.close()
      }
    })
  }

  private openCatalog(): DatabaseSync {
    const namespaceId = this.namespaceId ?? validateProtocol(this.paths.protocol)
    const db = openRecordDb(this.paths.catalog, 'catalog')
    try {
      if (catalogNamespace(db) !== namespaceId)
        requireReview(`Workspace catalog namespace identity changed: ${this.paths.catalog}`)
      return db
    } catch (cause) {
      db.close()
      throw cause
    }
  }

  private readRepository(repositoryId: WorkspaceId): RepositoryCatalogRecord | undefined {
    return this.inCatalog(catalog => {
      const row = repositoryRow(catalog, 'id=?', repositoryId)
      return row === undefined ? undefined : parseRepositoryCatalogRow(row)
    })
  }

  shardPath(repositoryId: WorkspaceId): string {
    return join(this.paths.repos, repositoryId, 'records.sqlite')
  }

  openShard(repositoryId: WorkspaceId, create = false, repository?: GitWorkspace): DatabaseSync {
    return this.openShardRecord(repositoryId, create, repository).db
  }

  private openShardRecord(
    repositoryId: WorkspaceId,
    create: boolean,
    repository: GitWorkspace | undefined
  ): HeldShard {
    if (!this.initialized && create) this.initialize()
    const path = this.shardPath(repositoryId)
    const record = this.readRepository(repositoryId)
    if (record === undefined)
      return unavailable(`Repository is not registered in workspace authority: ${repositoryId}`)
    const published = lstatIfExists(path) !== undefined
    if (record.state === 'ready' && !published)
      requireReview(`Ready repository shard is missing: ${path}`)
    if (record.state === 'provisioning' && !create && !published)
      requireReview(`Repository shard provisioning is incomplete: ${path}`)
    if (repository !== undefined && !matchesRepository(record, repository))
      requireReview(`Repository identity changed for workspace shard ${repositoryId}`)
    const provision = create && record.state === 'provisioning'
    privateDirectory(dirname(path), provision)
    const db = openRecordDb(
      path,
      'shard',
      provision
        ? candidate => {
            if (repository === undefined)
              requireReview(
                `Cannot initialize repository shard without its Git identity: ${repositoryId}`
              )
            const values: readonly [string, string][] = [
              ['repository_id', repositoryId],
              ['common_path', repository.commonPath],
              ['common_volume_uuid', repository.commonIdentity.volumeUuid],
              ['common_inode', repository.commonIdentity.inode],
              ['object_format', repository.objectFormat],
            ]
            const insert = candidate.prepare('INSERT INTO shard_meta(key, value) VALUES(?, ?)')
            for (const [key, value] of values) insert.run(key, value)
          }
        : undefined
    )
    try {
      this.validateShardMeta(db, record)
      if (record.state === 'provisioning') this.markRepositoryReady(repositoryId)
      return { db, record }
    } catch (cause) {
      db.close()
      throw cause
    }
  }

  private validateShardMeta(db: DatabaseSync, expected: RepositoryCatalogRecord): void {
    const values = new Map(
      rows(db, 'SELECT key, value FROM shard_meta').map(row => [
        textField(row, 'key'),
        textField(row, 'value'),
      ])
    )
    if (
      values.size !== 5 ||
      values.get('repository_id') !== expected.id ||
      values.get('common_path') !== expected.commonPath ||
      values.get('common_volume_uuid') !== expected.volumeUuid ||
      values.get('common_inode') !== expected.inode ||
      values.get('object_format') !== expected.objectFormat
    )
      requireReview(`Repository shard identity or schema mismatch: ${expected.id}`)
  }

  private markRepositoryReady(repositoryId: WorkspaceId): void {
    this.inCatalog(db => {
      transaction(db, () => {
        const row = repositoryRow(db, 'id=?', repositoryId)
        if (row === undefined)
          requireReview(`Repository catalog mapping disappeared: ${repositoryId}`)
        const current = parseRepositoryCatalogRow(row)
        if (current.state === 'ready') return
        const ready: RepositoryCatalogRecord = {
          ...current,
          state: 'ready',
          revision: current.revision + 1,
        }
        db.prepare(`UPDATE repositories SET state=?, revision=?, payload=?
          WHERE id=? AND state='provisioning' AND revision=?`).run(
          ready.state,
          ready.revision,
          encode(ready),
          repositoryId,
          current.revision
        )
        if (numberField(first(db, 'SELECT changes() AS count'), 'count') !== 1)
          requireReview(`Cannot publish ready repository shard: ${repositoryId}`)
      })
    })
  }

  registerRepository(repository: GitWorkspace): WorkspaceId {
    this.initialize()
    const catalog = this.openCatalog()
    let registered: RepositoryCatalogRecord | undefined
    let registrationConflict = false
    try {
      const { byPath, byPhysical } = registrationRows(catalog, repository)
      if (byPath === undefined && byPhysical !== undefined)
        requireReview(
          `Repository common directory has an unrecognized path alias: ${repository.commonPath}`
        )
      if (byPath === undefined) {
        const provisioning: RepositoryCatalogRecord = {
          id: newId(),
          commonPath: repository.commonPath,
          volumeUuid: repository.commonIdentity.volumeUuid,
          inode: repository.commonIdentity.inode,
          objectFormat: repository.objectFormat,
          state: 'provisioning',
          provisionId: newId(),
          revision: 0,
        }
        transaction(catalog, () => {
          catalog
            .prepare(`INSERT INTO repositories(id, common_path, volume_uuid, inode, object_format, state, provision_id, revision, payload)
            VALUES(?,?,?,?,?,'provisioning',?,0,?)`)
            .run(
              provisioning.id,
              provisioning.commonPath,
              provisioning.volumeUuid,
              provisioning.inode,
              provisioning.objectFormat,
              provisioning.provisionId,
              encode(provisioning)
            )
        })
        registered = provisioning
      } else {
        if (byPhysical === undefined || textField(byPath, 'id') !== textField(byPhysical, 'id'))
          requireReview(`Repository physical identity changed: ${repository.commonPath}`)
        registered = validateRepositoryRecord(repository, byPath)
      }
    } catch (cause) {
      if (cause instanceof WorkspaceError) throw cause
      if (sqliteCode(cause) === 19) registrationConflict = true
      else unavailable(`Cannot register repository ${repository.commonPath}: ${errorText(cause)}`)
    } finally {
      catalog.close()
    }
    if (registrationConflict) {
      const retry = this.openCatalog()
      try {
        const { byPath, byPhysical } = registrationRows(retry, repository)
        if (
          byPath === undefined ||
          byPhysical === undefined ||
          textField(byPath, 'id') !== textField(byPhysical, 'id')
        )
          requireReview(
            `Repository identity conflicts with existing catalog data: ${repository.commonPath}`
          )
        registered = validateRepositoryRecord(repository, byPath)
      } finally {
        retry.close()
      }
    }
    if (registered === undefined)
      requireReview(
        `Repository registration produced no authoritative record: ${repository.commonPath}`
      )
    const repositoryId = registered.id
    let structure: GateRelease | undefined
    try {
      if (registered.state === 'provisioning')
        structure = acquireStructureGate(this.paths, repository, repositoryId)
      const current = this.readRepository(repositoryId)
      if (current === undefined)
        requireReview(`Repository catalog mapping disappeared: ${repositoryId}`)
      if (current.state === 'ready') {
        const path = this.shardPath(repositoryId)
        if (lstatIfExists(path) === undefined)
          requireReview(`Ready repository shard is missing: ${path}`)
        this.openShard(repositoryId, false, repository).close()
      } else {
        privateDirectory(dirname(this.shardPath(repositoryId)), true)
        this.openShard(repositoryId, true, repository).close()
      }
    } finally {
      structure?.()
    }
    return repositoryId
  }

  findRepository(repository: GitWorkspace): WorkspaceId | undefined {
    return this.inCatalog(catalog => {
      const row = repositoryRow(catalog, 'common_path=?', repository.commonPath)
      return row === undefined ? undefined : validateRepositoryRecord(repository, row).id
    })
  }

  listRepositories(): readonly {
    readonly id: WorkspaceId
    readonly state: string
    readonly commonPath: string
  }[] {
    return this.inCatalog(db =>
      rows(db, `${REPOSITORY_ROW} ORDER BY id`).map(row => {
        const record = parseRepositoryCatalogRow(row)
        if (record.state !== 'ready')
          requireReview(`Repository shard provisioning is unresolved: ${record.id}`)
        return { id: record.id, state: record.state, commonPath: record.commonPath }
      })
    )
  }

  close(): void {
    if (this.closed) return
    const releaseProtocol = this.protocolRelease
    this.protocolRelease = undefined
    this.closed = true
    releaseProtocol?.()
  }
}

const entriesIfExists = (directory: string): string[] => {
  try {
    return readdirSync(directory)
  } catch (cause) {
    if (hasErrorCode(cause, 'ENOENT')) return []
    throw cause
  }
}

export const toGrant = (
  authority: WorkspaceAuthority,
  repo: WorkspaceId,
  workspace: WorkspaceRecord,
  use: UseRecord,
  cwd: string,
  access: WorkspaceGrant['access']
): WorkspaceGrant => ({
  namespaceId: authority.initialize(),
  repositoryId: repo,
  workspaceId: workspace.id,
  useId: use.id,
  ...(use.acquisitionId === undefined ? {} : { acquisitionId: use.acquisitionId }),
  ...(use.reservationId === undefined ? {} : { reservationId: use.reservationId }),
  ...(use.taskId === undefined ? {} : { taskId: use.taskId }),
  revision: use.bindingRevision,
  cwd,
  checkout: workspace.path,
  access,
  origin: workspace.origin,
  ...(use.operationPath === undefined ? {} : { path: use.operationPath }),
})
export const inDb = <A>(
  authority: WorkspaceAuthority,
  repo: WorkspaceId,
  callback: (db: DatabaseSync) => A,
  create = false,
  git?: GitWorkspace
): A => authority.inShard(repo, callback, create, git)
export const taskWorkspaces = (
  authority: WorkspaceAuthority,
  taskId: WorkspaceId
): { repo: WorkspaceId; reservation: ReservationRecord; workspace: WorkspaceRecord }[] => {
  const result: {
    repo: WorkspaceId
    reservation: ReservationRecord
    workspace: WorkspaceRecord
  }[] = []
  for (const repository of authority.listRepositories()) {
    inDb(authority, repository.id, db => {
      for (const row of rows(
        db,
        'SELECT id FROM reservations WHERE task_id=? ORDER BY id',
        taskId
      )) {
        const reservation = getReservationById(db, textField(row, 'id'))
        if (reservation === undefined || reservation.taskId !== taskId)
          requireReview(`Task reservation is inconsistent: ${taskId}`)
        const workspace = getWorkspace(db, reservation.workspaceId)
        if (workspace === undefined)
          requireReview(`Reserved workspace is missing: ${reservation.workspaceId}`)
        result.push({ repo: repository.id, reservation, workspace })
      }
    })
  }
  return result
}
export const findBinding = (
  authority: WorkspaceAuthority,
  key: string
): { repo: WorkspaceId; binding: BindingRecord } | undefined => {
  const matches: { repo: WorkspaceId; binding: BindingRecord }[] = []
  for (const repository of authority.listRepositories()) {
    inDb(authority, repository.id, db => {
      const binding = getBinding(db, key)
      if (binding !== undefined && binding.superseded !== true)
        matches.push({ repo: repository.id, binding })
    })
  }
  if (matches.length > 1)
    requireReview(`Conversation has multiple authoritative workspace bindings: ${key}`)
  return matches[0]
}

export const validateWorkspace = (
  authority: WorkspaceAuthority,
  workspace: WorkspaceRecord
): GitWorkspace => {
  const actual = validateWorkspacePath(workspace)
  if (workspace.origin === 'managed') {
    const base = resolve(authority.paths.worktrees, workspace.repositoryId)
    if (!isWithin(base, workspace.path) || workspace.path === base)
      requireReview(`Managed workspace escaped its allocation root: ${workspace.path}`)
  }
  return actual
}
