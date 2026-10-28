import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { DateTime, Effect, Schema } from 'effect'
import type { ChildProcessSpawner } from 'effect/process'
import { runCommand } from '../command.ts'
import { errorText } from '../error-text.ts'
import { acquireExclusiveLock, CoordinationError } from '../runtime-coordination.ts'
import { OrbRecordSchema, orbFailure, type OrbError, type OrbRecord } from './domain.ts'

export type RecordFields = Omit<OrbRecord, 'id' | 'phase' | 'baseRef' | 'createdAt' | 'updatedAt'>
export type RecordPatch = Partial<Omit<OrbRecord, 'id' | 'baseRef' | 'createdAt' | 'updatedAt'>>

export interface OrbRecordHandle {
  readonly id: string
  readonly directory: string
  readonly keyPath: string
  readonly knownHostsPath: string
  readonly controlPath: string
  readonly current: () => OrbRecord
  update(patch: RecordPatch): Effect.Effect<void, OrbError>
  writeKnownHosts(host: string, keys: readonly string[]): Effect.Effect<void, OrbError>
  readonly remove: Effect.Effect<void, OrbError>
  readonly release: Effect.Effect<void>
}

export interface CreatedRecord extends OrbRecordHandle {
  readonly publicKey: string
}

const RECORD_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/

const encodeRecord = Schema.encodeSync(Schema.fromJsonString(OrbRecordSchema))

export const orbsDirectory = (dataHome: string): string => join(dataHome, 'orbs')

const privateDirectory = (path: string): void => {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  if (!lstatSync(path).isDirectory()) throw new Error(`Not a directory: ${path}`)
  chmodSync(path, 0o700)
}

const writePrivate = (path: string, contents: string): void => {
  const temporary = `${path}.${randomUUID()}.tmp`
  writeFileSync(temporary, contents, { mode: 0o600, flag: 'wx' })
  renameSync(temporary, path)
}

const sync = <A>(operation: string, run: () => A): Effect.Effect<A, OrbError> =>
  Effect.try({ try: run, catch: cause => orbFailure(`${operation}: ${errorText(cause)}`, cause) })

const timestamp = Effect.map(DateTime.now, DateTime.formatIso)

const recordHandle = (
  directory: string,
  initial: OrbRecord,
  releaseLock: () => void
): OrbRecordHandle => {
  let record = initial
  let released = false
  const release = Effect.sync(() => {
    if (released) return
    released = true
    releaseLock()
  })
  return {
    id: record.id,
    directory,
    keyPath: join(directory, 'key'),
    knownHostsPath: join(directory, 'known_hosts'),
    controlPath: join(directory, 'mux'),
    current: () => record,
    update: patch =>
      Effect.gen(function* () {
        const next: OrbRecord = { ...record, ...patch, updatedAt: yield* timestamp }
        yield* sync('Cannot update the orb record', () =>
          writePrivate(join(directory, 'record.json'), encodeRecord(next))
        )
        record = next
      }),
    writeKnownHosts: (host, keys) =>
      sync('Cannot write the orb known_hosts', () =>
        writePrivate(join(directory, 'known_hosts'), keys.map(key => `${host} ${key}\n`).join(''))
      ),
    remove: sync('Cannot remove the orb record', () =>
      rmSync(directory, { recursive: true, force: true })
    ).pipe(Effect.andThen(release)),
    release,
  }
}

const takeLock = (directory: string, id: string) =>
  sync('Cannot take the orb owner lock', () =>
    acquireExclusiveLock(
      join(directory, 'owner.sqlite'),
      `Orb record ${id} is owned by another process`
    )
  )

export const createRecord = Effect.fnUntraced(function* (
  dataHome: string,
  fields: RecordFields
): Effect.fn.Return<CreatedRecord, OrbError, ChildProcessSpawner.ChildProcessSpawner> {
  const id = randomUUID()
  const directory = join(orbsDirectory(dataHome), id)
  yield* sync('Cannot create the orb registry', () => {
    privateDirectory(orbsDirectory(dataHome))
    mkdirSync(directory, { mode: 0o700 })
  })
  const releaseLock = yield* takeLock(directory, id)
  const keyPath = join(directory, 'key')
  const prepared = yield* Effect.gen(function* () {
    yield* runCommand(
      'ssh-keygen',
      ['-q', '-t', 'ed25519', '-N', '', '-C', `dev-orb-${id}`, '-f', keyPath],
      {
        timeout: '20 seconds',
      }
    ).pipe(
      Effect.mapError(cause => orbFailure(`Cannot generate the orb key: ${cause.message}`, cause))
    )
    const publicKey = yield* sync('Cannot read the orb public key', () => {
      chmodSync(keyPath, 0o600)
      return readFileSync(`${keyPath}.pub`, 'utf8').trim()
    })
    const now = yield* timestamp
    const record: OrbRecord = {
      ...fields,
      id,
      phase: 'requested',
      baseRef: `refs/dev/orb/${id}/base`,
      createdAt: now,
      updatedAt: now,
    }
    yield* sync('Cannot write the orb record', () =>
      writePrivate(join(directory, 'record.json'), encodeRecord(record))
    )
    return { publicKey, record }
  }).pipe(
    Effect.tapError(() =>
      Effect.sync(() => {
        rmSync(directory, { recursive: true, force: true })
        releaseLock()
      })
    )
  )
  return {
    ...recordHandle(directory, prepared.record, releaseLock),
    publicKey: prepared.publicKey,
  }
})

export const readRecord = (directory: string): Effect.Effect<OrbRecord, OrbError> =>
  sync(`Cannot read the orb record in ${directory}`, () =>
    readFileSync(join(directory, 'record.json'), 'utf8')
  ).pipe(
    Effect.flatMap(text =>
      Schema.decodeEffect(Schema.fromJsonString(OrbRecordSchema))(text).pipe(
        Effect.mapError(cause => orbFailure(`Invalid orb record in ${directory}: ${cause.message}`))
      )
    )
  )

export const recordDirectories = (dataHome: string): Effect.Effect<readonly string[], OrbError> =>
  sync('Cannot list the orb registry', () => {
    const root = orbsDirectory(dataHome)
    if (!existsSync(root)) return []
    return readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && RECORD_ID.test(entry.name))
      .map(entry => join(root, entry.name))
      .toSorted()
  })

export type RecordClaim =
  | { readonly kind: 'owned' }
  | { readonly kind: 'incomplete' }
  | { readonly kind: 'claimed'; readonly record: OrbRecordHandle }

export const claimRecord = Effect.fnUntraced(function* (
  directory: string
): Effect.fn.Return<RecordClaim, OrbError> {
  const id = basename(directory)
  const releaseLock = yield* takeLock(directory, id).pipe(
    Effect.catchIf(
      error => error.cause instanceof CoordinationError,
      () => Effect.void
    )
  )
  if (releaseLock === undefined) return { kind: 'owned' } as const
  if (!existsSync(join(directory, 'record.json'))) {
    yield* sync('Cannot remove an incomplete orb record', () =>
      rmSync(directory, { recursive: true, force: true })
    ).pipe(Effect.ensuring(Effect.sync(releaseLock)))
    return { kind: 'incomplete' } as const
  }
  const record = yield* readRecord(directory).pipe(Effect.tapError(() => Effect.sync(releaseLock)))
  if (record.id !== id) {
    releaseLock()
    return yield* orbFailure(`The orb record in ${directory} names another id, ${record.id}`)
  }
  return { kind: 'claimed', record: recordHandle(directory, record, releaseLock) } as const
})
