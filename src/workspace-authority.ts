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
import type { GitWorkspace } from './workspace-git.ts'
import {
  canonicalPath,
  hasErrorCode,
  isWithin,
  lstatIfExists,
  sqliteCode,
} from './workspace-paths.ts'
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
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  newId,
  encode,
  parseRecord,
  errorText,
  fsyncPath,
  fsyncParent,
  privateDirectory,
  ensureDirectoryPath,
  assertSqliteSafety,
  rows,
  first,
  textField,
  numberField,
  createPublishedDatabase,
  databaseFile,
  openRecordDb,
  transaction,
  type SqlRow,
} from './workspace-sqlite.ts'

const canonicalRoot = (requested: string): string => {
  if (!isAbsolute(requested)) invalid('Workspace authority root must be an absolute path')
  const absolute = resolve(requested)
  if (lstatIfExists(absolute)?.isSymbolicLink())
    unavailable(`Workspace authority root must not be a symbolic link: ${absolute}`)
  return canonicalPath(absolute).path
}

// Initial support is local macOS storage. A synchronized folder or network mount can
// replay or reorder SQLite and gate files outside the authority's control. No detector
// can recognize every sync agent, so only the known cases are refused.
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
  const mount = input.mountTable
    .split('\n')
    .map(line => /^.+? on (.+) \((.+)\)$/.exec(line))
    .filter(match => match !== null)
    .map(match => ({ point: match[1] ?? '', options: (match[2] ?? '').split(', ') }))
    .filter(entry => entry.point !== '' && isWithin(entry.point, input.path))
    .toSorted((left, right) => right.point.length - left.point.length)[0]
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

const catalogMeta = (db: DatabaseSync, key: 'namespace_id' | 'protocol_version'): string =>
  textField(first(db, 'SELECT value FROM catalog_meta WHERE key=?', key), 'value')
const createCatalogDatabase = (path: string, namespaceId: WorkspaceId): void => {
  createPublishedDatabase(path, 'catalog', db => {
    const insert = db.prepare('INSERT INTO catalog_meta(key, value) VALUES(?, ?)')
    insert.run('namespace_id', namespaceId)
    insert.run('protocol_version', String(PROTOCOL_VERSION))
  })
  // Catalog data is durably published in DELETE mode first; only then switch the
  // complete record database to WAL. Never reset an existing database here.
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
export interface AuthorityPaths {
  readonly root: string
  readonly protocol: string
  readonly catalog: string
  readonly repos: string
  readonly gates: string
  readonly worktrees: string
}
const makePaths = (root: string): AuthorityPaths => ({
  root,
  protocol: join(root, 'protocol.sqlite'),
  catalog: join(root, 'catalog.sqlite'),
  repos: join(root, 'repos'),
  gates: join(root, 'gates'),
  worktrees: join(root, 'worktrees'),
})

const REPOSITORY_ROW =
  'SELECT id, common_path, device, inode, object_format, state, provision_id, revision, payload FROM repositories'
const repositoryRow = (db: DatabaseSync, where: string, ...params: string[]): SqlRow | undefined =>
  first(db, `${REPOSITORY_ROW} WHERE ${where}`, ...params)
const registrationRows = (
  db: DatabaseSync,
  repository: GitWorkspace
): { readonly byPath: SqlRow | undefined; readonly byPhysical: SqlRow | undefined } => ({
  byPath: repositoryRow(db, 'common_path=?', repository.commonPath),
  byPhysical: repositoryRow(
    db,
    'device=? AND inode=?',
    repository.commonIdentity.device,
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
    value.device !== textField(row, 'device') ||
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
  record.device === repository.commonIdentity.device &&
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

export class WorkspaceAuthority {
  readonly paths: AuthorityPaths
  readonly root: string
  private namespaceId: WorkspaceId | undefined
  private protocolRelease: GateRelease | undefined
  private initialized = false
  private storageChecked = false
  private closed = false

  constructor(root: string) {
    this.root = canonicalRoot(root)
    this.paths = makePaths(this.root)
  }

  private checkStorage(): void {
    if (this.storageChecked) return
    assertSupportedStorage(this.root)
    this.storageChecked = true
  }

  // Returns the protocol gate held while the catalog was matched to the namespace.
  private joinNamespace(): { readonly id: WorkspaceId; readonly release: GateRelease } {
    const id = validateProtocol(this.paths.protocol)
    const release = acquireProtocolGate(this.paths.protocol, this.root, id)
    try {
      const catalog = this.openCatalog()
      try {
        if (
          catalogMeta(catalog, 'namespace_id') !== id ||
          catalogMeta(catalog, 'protocol_version') !== String(PROTOCOL_VERSION)
        )
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
          return lstatSync(directory).isDirectory() && requireEntries(directory).length > 0
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
      const entries = requireEntries(this.root)
      if (entries.length === 0) return undefined
      requireReview(`Workspace authority has files but no valid namespace markers: ${this.root}`)
    }
    if (protocol === undefined || catalog === undefined)
      requireReview(`Workspace authority is incomplete: ${this.root}`)
    const { id, release } = this.joinNamespace()
    release()
    return id
  }

  private openCatalog(): DatabaseSync {
    const namespaceId = this.namespaceId ?? validateProtocol(this.paths.protocol)
    const db = openRecordDb(this.paths.catalog, 'catalog')
    if (catalogMeta(db, 'namespace_id') !== namespaceId) {
      db.close()
      requireReview(`Workspace catalog namespace identity changed: ${this.paths.catalog}`)
    }
    return db
  }

  private readRepository(repositoryId: WorkspaceId): RepositoryCatalogRecord | undefined {
    const catalog = this.openCatalog()
    try {
      const row = repositoryRow(catalog, 'id=?', repositoryId)
      return row === undefined ? undefined : parseRepositoryCatalogRow(row)
    } finally {
      catalog.close()
    }
  }

  shardPath(repositoryId: WorkspaceId): string {
    return join(this.paths.repos, repositoryId, 'records.sqlite')
  }

  openShard(repositoryId: WorkspaceId, create = false, repository?: GitWorkspace): DatabaseSync {
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
              ['common_device', repository.commonIdentity.device],
              ['common_inode', repository.commonIdentity.inode],
              ['object_format', repository.objectFormat],
              ['protocol_version', String(PROTOCOL_VERSION)],
            ]
            const insert = candidate.prepare('INSERT INTO shard_meta(key, value) VALUES(?, ?)')
            for (const [key, value] of values) insert.run(key, value)
          }
        : undefined
    )
    this.validateShardMeta(db, record)
    if (record.state === 'provisioning') this.markRepositoryReady(repositoryId)
    return db
  }

  private validateShardMeta(db: DatabaseSync, expected: RepositoryCatalogRecord): void {
    const values = new Map(
      rows(db, 'SELECT key, value FROM shard_meta').map(row => [
        textField(row, 'key'),
        textField(row, 'value'),
      ])
    )
    if (
      numberField(first(db, 'PRAGMA user_version'), 'user_version') !== SCHEMA_VERSION ||
      values.get('repository_id') !== expected.id ||
      values.get('common_path') !== expected.commonPath ||
      values.get('common_device') !== expected.device ||
      values.get('common_inode') !== expected.inode ||
      values.get('object_format') !== expected.objectFormat ||
      values.get('protocol_version') !== String(PROTOCOL_VERSION)
    )
      requireReview(`Repository shard identity or schema mismatch: ${expected.id}`)
  }

  private markRepositoryReady(repositoryId: WorkspaceId): void {
    const db = this.openCatalog()
    try {
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
    } finally {
      db.close()
    }
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
      if (byPath !== undefined) {
        if (byPhysical === undefined || textField(byPath, 'id') !== textField(byPhysical, 'id'))
          requireReview(`Repository physical identity changed: ${repository.commonPath}`)
        registered = validateRepositoryRecord(repository, byPath)
      } else {
        const provisioning: RepositoryCatalogRecord = {
          id: newId(),
          commonPath: repository.commonPath,
          device: repository.commonIdentity.device,
          inode: repository.commonIdentity.inode,
          objectFormat: repository.objectFormat,
          state: 'provisioning',
          provisionId: newId(),
          revision: 0,
        }
        transaction(catalog, () => {
          catalog
            .prepare(`INSERT INTO repositories(id, common_path, device, inode, object_format, state, provision_id, revision, payload)
            VALUES(?,?,?,?,?,'provisioning',?,0,?)`)
            .run(
              provisioning.id,
              provisioning.commonPath,
              provisioning.device,
              provisioning.inode,
              provisioning.objectFormat,
              provisioning.provisionId,
              encode(provisioning)
            )
        })
        registered = provisioning
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
    const catalog = this.openCatalog()
    try {
      const row = repositoryRow(catalog, 'common_path=?', repository.commonPath)
      return row === undefined ? undefined : validateRepositoryRecord(repository, row).id
    } finally {
      catalog.close()
    }
  }

  listRepositories(): readonly {
    readonly id: WorkspaceId
    readonly state: string
    readonly commonPath: string
  }[] {
    const db = this.openCatalog()
    try {
      return rows(db, `${REPOSITORY_ROW} ORDER BY id`).map(row => {
        const record = parseRepositoryCatalogRow(row)
        if (record.state !== 'ready')
          requireReview(`Repository shard provisioning is unresolved: ${record.id}`)
        return { id: record.id, state: record.state, commonPath: record.commonPath }
      })
    } finally {
      db.close()
    }
  }

  private commit(): void {
    if (this.closed) return
    let cause: unknown
    try {
      this.protocolRelease?.()
    } catch (error) {
      cause = error
    }
    this.protocolRelease = undefined
    this.closed = true
    if (cause !== undefined) throw cause
  }

  close(): void {
    this.commit()
  }
}

const requireEntries = (directory: string): string[] => {
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
  access: 'read' | 'write'
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
): A => {
  const db = authority.openShard(repo, create, git)
  try {
    return callback(db)
  } finally {
    db.close()
  }
}
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
