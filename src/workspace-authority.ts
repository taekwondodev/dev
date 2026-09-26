import { execFileSync } from 'node:child_process'
import { lstatSync, realpathSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { userInfo } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import {
  invalid,
  requireReview,
  unavailable,
  WorkspaceError,
  type WorkspaceGrant,
} from './workspace-domain.ts'
import { acquireProtocolGate, acquireStructureGate, type GateRelease } from './workspace-gates.ts'
import type { GitWorkspace } from './workspace-git.ts'
import { hasErrorCode, isWithin, lstatIfExists, sqliteCode } from './workspace-paths.ts'
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
  PROTOCOL_SQL,
  workspaceId,
  isUuid,
  encode,
  parseRecord,
  errorText,
  fsyncPath,
  fsyncParent,
  privateDirectory,
  ensureDirectoryPath,
  privateFile,
  assertSqliteSafety,
  rows,
  first,
  textField,
  numberField,
  schemaCatalog,
  expectedCatalog,
  createPublishedDatabase,
  databaseFile,
  openRecordDb,
  transaction,
  type SqlRow,
} from './workspace-sqlite.ts'

const canonicalRoot = (requested: string): string => {
  if (!isAbsolute(requested)) invalid('Workspace authority root must be an absolute path')
  const absolute = resolve(requested)
  const requestedInfo = lstatIfExists(absolute)
  if (requestedInfo?.isSymbolicLink())
    unavailable(`Workspace authority root must not be a symbolic link: ${absolute}`)
  const parts: string[] = []
  let cursor = absolute
  while (lstatIfExists(cursor) === undefined) {
    const parent = dirname(cursor)
    if (parent === cursor) unavailable(`Cannot resolve workspace authority root: ${absolute}`)
    parts.unshift(basename(cursor))
    cursor = parent
  }
  const physicalParent = realpathSync(cursor)
  return resolve(physicalParent, ...parts)
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

const createProtocolDatabase = (path: string, namespaceId: string): void =>
  createPublishedDatabase(path, 'protocol', db => {
    db.prepare('INSERT INTO protocol_marker(id, version, namespace_id) VALUES(1, ?, ?)').run(
      PROTOCOL_VERSION,
      namespaceId
    )
  })
const createCatalogDatabase = (path: string, namespaceId: string): void => {
  createPublishedDatabase(path, 'catalog', db => {
    db.prepare('INSERT INTO catalog_meta(key, value) VALUES(?, ?)').run('namespace_id', namespaceId)
    db.prepare('INSERT INTO catalog_meta(key, value) VALUES(?, ?)').run(
      'protocol_version',
      String(PROTOCOL_VERSION)
    )
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

const validateProtocol = (path: string, namespaceId?: string): string => {
  privateFile(path)
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(path, { timeout: 0, allowExtension: false })
    db.exec('PRAGMA busy_timeout = 0; PRAGMA synchronous = FULL; PRAGMA fullfsync = ON;')
    if (textField(first(db, 'PRAGMA journal_mode'), 'journal_mode').toLowerCase() !== 'delete')
      unavailable(`Workspace protocol gate has an unsupported journal mode: ${path}`)
    if (
      numberField(first(db, 'PRAGMA user_version'), 'user_version') !== SCHEMA_VERSION ||
      schemaCatalog(db) !== expectedCatalog(PROTOCOL_SQL)
    )
      unavailable(`Workspace protocol gate has an unsupported schema: ${path}`)
    const row = first(db, 'SELECT version, namespace_id FROM protocol_marker WHERE id = 1')
    if (numberField(row, 'version') !== PROTOCOL_VERSION)
      unavailable(`Workspace protocol version mismatch at ${path}`)
    const actual = textField(row, 'namespace_id')
    if (!isUuid(actual) || (namespaceId !== undefined && namespaceId !== actual))
      requireReview(`Workspace protocol identity mismatch at ${path}`)
    return actual
  } catch (cause) {
    if (cause instanceof WorkspaceError) throw cause
    unavailable(`Cannot validate workspace protocol gate ${path}: ${errorText(cause)}`)
  } finally {
    db?.close()
  }
}

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
export const validateRepositoryRecord = (
  repository: GitWorkspace,
  row: SqlRow
): RepositoryCatalogRecord => {
  const value = parseRepositoryCatalogRow(row)
  if (
    value.commonPath !== repository.commonPath ||
    value.device !== repository.commonIdentity.device ||
    value.inode !== repository.commonIdentity.inode ||
    value.objectFormat !== repository.objectFormat
  )
    requireReview(`Git common-directory identity changed: ${repository.commonPath}`)
  return value
}

export class WorkspaceAuthority {
  readonly paths: AuthorityPaths
  readonly root: string
  private namespaceId: string | undefined
  private protocolRelease: GateRelease | undefined
  private initialized = false
  private storageChecked = false
  private closed = false
  private readonly shardIds = new Set<string>()

  constructor(root: string) {
    this.root = canonicalRoot(root)
    this.paths = makePaths(this.root)
  }

  private checkStorage(): void {
    if (this.storageChecked) return
    assertSupportedStorage(this.root)
    this.storageChecked = true
  }

  initialize(): string {
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
      const candidateId = workspaceId()
      createProtocolDatabase(this.paths.protocol, candidateId)
      const id = validateProtocol(this.paths.protocol)
      createCatalogDatabase(this.paths.catalog, id)
    } else if (!protocolExists || !catalogExists) {
      requireReview(`Workspace authority has incomplete namespace markers: ${this.root}`)
    }
    const id = validateProtocol(this.paths.protocol)
    const acquired = acquireProtocolGate(this.paths.protocol, this.root, id)
    try {
      const catalog = this.openCatalog(false)
      try {
        const actual = textField(
          first(catalog, "SELECT value FROM catalog_meta WHERE key='namespace_id'"),
          'value'
        )
        const version = textField(
          first(catalog, "SELECT value FROM catalog_meta WHERE key='protocol_version'"),
          'value'
        )
        if (actual !== id || version !== String(PROTOCOL_VERSION))
          requireReview(`Workspace catalog does not match namespace ${this.root}`)
      } finally {
        catalog.close()
      }
    } catch (cause) {
      acquired()
      throw cause
    }
    this.namespaceId = id
    this.protocolRelease = acquired
    this.initialized = true
    return id
  }

  inspectExisting(): string | undefined {
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
    const id = validateProtocol(this.paths.protocol)
    const release = acquireProtocolGate(this.paths.protocol, this.root, id)
    try {
      const db = this.openCatalog(false)
      try {
        if (
          textField(
            first(db, "SELECT value FROM catalog_meta WHERE key='namespace_id'"),
            'value'
          ) !== id ||
          textField(
            first(db, "SELECT value FROM catalog_meta WHERE key='protocol_version'"),
            'value'
          ) !== String(PROTOCOL_VERSION)
        )
          requireReview(`Workspace catalog does not match namespace ${this.root}`)
      } finally {
        db.close()
      }
    } finally {
      release()
    }
    return id
  }

  openCatalog(create: boolean): DatabaseSync {
    if (!this.initialized && create) this.initialize()
    const namespaceId =
      this.namespaceId ??
      (create
        ? requireReview('Workspace namespace is not initialized')
        : validateProtocol(this.paths.protocol))
    const db = openRecordDb(this.paths.catalog, 'catalog', create, candidate => {
      candidate
        .prepare('INSERT INTO catalog_meta(key, value) VALUES(?, ?)')
        .run('namespace_id', namespaceId)
      candidate
        .prepare('INSERT INTO catalog_meta(key, value) VALUES(?, ?)')
        .run('protocol_version', String(PROTOCOL_VERSION))
    })
    const actual = textField(
      first(db, "SELECT value FROM catalog_meta WHERE key='namespace_id'"),
      'value'
    )
    if (actual !== namespaceId) {
      db.close()
      requireReview(`Workspace catalog namespace identity changed: ${this.paths.catalog}`)
    }
    return db
  }

  shardPath(repositoryId: string): string {
    if (!isUuid(repositoryId)) invalid('Invalid repository ID')
    return join(this.paths.repos, repositoryId, 'records.sqlite')
  }

  openShard(repositoryId: string, create = false, repository?: GitWorkspace): DatabaseSync {
    if (!this.initialized && create) this.initialize()
    const path = this.shardPath(repositoryId)
    const directory = dirname(path)
    const catalog = this.openCatalog(false)
    let state: string
    let commonPath: string
    let device: string
    let inode: string
    let format: string
    try {
      const row = first(
        catalog,
        `SELECT id, common_path, device, inode, object_format, state, provision_id, revision, payload
        FROM repositories WHERE id=?`,
        repositoryId
      )
      if (row === undefined)
        unavailable(`Repository is not registered in workspace authority: ${repositoryId}`)
      const record = parseRepositoryCatalogRow(row)
      state = record.state
      commonPath = record.commonPath
      device = record.device
      inode = record.inode
      format = record.objectFormat
      if (state === 'ready' && lstatIfExists(path) === undefined)
        requireReview(`Ready repository shard is missing: ${path}`)
      if (state === 'provisioning' && !create && lstatIfExists(path) === undefined)
        requireReview(`Repository shard provisioning is incomplete: ${path}`)
      if (
        repository !== undefined &&
        (commonPath !== repository.commonPath ||
          device !== repository.commonIdentity.device ||
          inode !== repository.commonIdentity.inode ||
          format !== repository.objectFormat)
      )
        requireReview(`Repository identity changed for workspace shard ${repositoryId}`)
    } finally {
      catalog.close()
    }
    privateDirectory(directory, create && state === 'provisioning')
    const db = openRecordDb(path, 'shard', create && state === 'provisioning', candidate => {
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
    })
    this.validateShardMeta(db, repositoryId, { commonPath, device, inode, format })
    if (state === 'provisioning') this.markRepositoryReady(repositoryId)
    this.shardIds.add(repositoryId)
    return db
  }

  private validateShardMeta(
    db: DatabaseSync,
    repositoryId: string,
    expected: { commonPath: string; device: string; inode: string; format: string }
  ): void {
    const values = new Map(
      rows(db, 'SELECT key, value FROM shard_meta').map(row => [
        textField(row, 'key'),
        textField(row, 'value'),
      ])
    )
    if (
      numberField(first(db, 'PRAGMA user_version'), 'user_version') !== SCHEMA_VERSION ||
      values.get('repository_id') !== repositoryId ||
      values.get('common_path') !== expected.commonPath ||
      values.get('common_device') !== expected.device ||
      values.get('common_inode') !== expected.inode ||
      values.get('object_format') !== expected.format ||
      values.get('protocol_version') !== String(PROTOCOL_VERSION)
    )
      requireReview(`Repository shard identity or schema mismatch: ${repositoryId}`)
  }

  private markRepositoryReady(repositoryId: string): void {
    const db = this.openCatalog(false)
    try {
      transaction(db, () => {
        const row = first(
          db,
          `SELECT id, common_path, device, inode, object_format, state, provision_id, revision, payload
          FROM repositories WHERE id=?`,
          repositoryId
        )
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

  registerRepository(repository: GitWorkspace): string {
    this.initialize()
    const catalog = this.openCatalog(false)
    let registered: { readonly id: string; readonly state: string } | undefined
    let registrationConflict = false
    try {
      const byPath = first(
        catalog,
        'SELECT id, common_path, device, inode, object_format, state, provision_id, revision, payload FROM repositories WHERE common_path=?',
        repository.commonPath
      )
      const byPhysical = first(
        catalog,
        'SELECT id, common_path, device, inode, object_format, state, provision_id, revision, payload FROM repositories WHERE device=? AND inode=?',
        repository.commonIdentity.device,
        repository.commonIdentity.inode
      )
      if (byPath === undefined && byPhysical !== undefined)
        requireReview(
          `Repository common directory has an unrecognized path alias: ${repository.commonPath}`
        )
      if (byPath !== undefined) {
        if (byPhysical === undefined || textField(byPath, 'id') !== textField(byPhysical, 'id'))
          requireReview(`Repository physical identity changed: ${repository.commonPath}`)
        const record = validateRepositoryRecord(repository, byPath)
        registered = { id: record.id, state: record.state }
      } else {
        const candidateId = workspaceId()
        const provisionId = workspaceId()
        const payload = {
          id: candidateId,
          commonPath: repository.commonPath,
          device: repository.commonIdentity.device,
          inode: repository.commonIdentity.inode,
          objectFormat: repository.objectFormat,
          state: 'provisioning',
          provisionId,
          revision: 0,
        }
        transaction(catalog, () => {
          catalog
            .prepare(`INSERT INTO repositories(id, common_path, device, inode, object_format, state, provision_id, revision, payload)
            VALUES(?,?,?,?,?,'provisioning',?,0,?)`)
            .run(
              candidateId,
              repository.commonPath,
              repository.commonIdentity.device,
              repository.commonIdentity.inode,
              repository.objectFormat,
              provisionId,
              encode(payload)
            )
        })
        registered = { id: candidateId, state: 'provisioning' }
      }
    } catch (cause) {
      if (cause instanceof WorkspaceError) throw cause
      if (sqliteCode(cause) === 19) registrationConflict = true
      else unavailable(`Cannot register repository ${repository.commonPath}: ${errorText(cause)}`)
    } finally {
      catalog.close()
    }
    if (registrationConflict) {
      const retry = this.openCatalog(false)
      try {
        const byPath = first(
          retry,
          'SELECT id, common_path, device, inode, object_format, state, provision_id, revision, payload FROM repositories WHERE common_path=?',
          repository.commonPath
        )
        const byPhysical = first(
          retry,
          'SELECT id, common_path, device, inode, object_format, state, provision_id, revision, payload FROM repositories WHERE device=? AND inode=?',
          repository.commonIdentity.device,
          repository.commonIdentity.inode
        )
        if (
          byPath === undefined ||
          byPhysical === undefined ||
          textField(byPath, 'id') !== textField(byPhysical, 'id')
        )
          requireReview(
            `Repository identity conflicts with existing catalog data: ${repository.commonPath}`
          )
        const record = validateRepositoryRecord(repository, byPath)
        registered = { id: record.id, state: record.state }
      } finally {
        retry.close()
      }
    }
    if (registered === undefined)
      requireReview(
        `Repository registration produced no authoritative record: ${repository.commonPath}`
      )
    const repositoryId = registered.id
    const state = registered.state
    let structure: GateRelease | undefined
    try {
      if (state === 'provisioning')
        structure = acquireStructureGate(this.paths, repository, repositoryId)
      const currentCatalog = this.openCatalog(false)
      let currentState: string
      try {
        const current = first(
          currentCatalog,
          'SELECT state FROM repositories WHERE id=?',
          repositoryId
        )
        if (current === undefined)
          requireReview(`Repository catalog mapping disappeared: ${repositoryId}`)
        currentState = textField(current, 'state')
      } finally {
        currentCatalog.close()
      }
      if (currentState === 'ready') {
        const path = this.shardPath(repositoryId)
        if (lstatIfExists(path) === undefined)
          requireReview(`Ready repository shard is missing: ${path}`)
        const shard = this.openShard(repositoryId, false, repository)
        shard.close()
      } else if (currentState === 'provisioning') {
        privateDirectory(dirname(this.shardPath(repositoryId)), true)
        const shard = this.openShard(repositoryId, true, repository)
        shard.close()
      } else requireReview(`Invalid repository catalog state: ${repositoryId}`)
    } finally {
      structure?.()
    }
    return repositoryId
  }

  listRepositories(): readonly {
    readonly id: string
    readonly state: string
    readonly commonPath: string
  }[] {
    const db = this.openCatalog(false)
    try {
      return rows(
        db,
        `SELECT id, common_path, device, inode, object_format, state, provision_id, revision, payload
        FROM repositories ORDER BY id`
      ).map(row => {
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
  repo: string,
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
  repo: string,
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
  taskId: string
): { repo: string; reservation: ReservationRecord; workspace: WorkspaceRecord }[] => {
  const result: { repo: string; reservation: ReservationRecord; workspace: WorkspaceRecord }[] = []
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
): { repo: string; binding: BindingRecord } | undefined => {
  const matches: { repo: string; binding: BindingRecord }[] = []
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
