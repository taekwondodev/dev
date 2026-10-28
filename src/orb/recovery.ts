import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Cause, DateTime, Effect, Exit, Option } from 'effect'
import type { ChildProcessSpawner } from 'effect/process'
import { errorText } from '../error-text.ts'
import { WorkspaceId, type WorkspaceLifecycle } from '../workspace-domain.ts'
import type { KeystoneToken, Orbit } from './cloud.ts'
import { deleteOrb, deleteRecorded } from './deletion.ts'
import {
  deleteCommand,
  OrbError,
  orbFailure,
  shortId,
  type OrbRecord,
  type OrbView,
} from './domain.ts'
import { claimRecord, readRecord, recordDirectories, type OrbRecordHandle } from './registry.ts'
import { makeOrbSsh } from './ssh.ts'
import { fetchWork, hardenedGit, orbRepository } from './transfer.ts'

export interface RecoveryOptions {
  readonly dataHome: string
  readonly authUrl: string
  readonly token: KeystoneToken
  readonly orbit: Orbit
  readonly lifecycle: Pick<WorkspaceLifecycle, 'inspect' | 'writeBranch' | 'settleOrbPresence'>
  readonly print: (line: string) => void
  readonly confirm?: (prompt: string) => Effect.Effect<boolean>
}

type Recovered = 'removed' | 'kept'

const CLOCK_SKEW_MS = 60_000

const failureText = (cause: Cause.Cause<unknown>): string => errorText(Cause.squash(cause))

const orbitMillis = (text: string): number | undefined =>
  Option.getOrUndefined(
    Option.map(
      DateTime.make(/(Z|[+-]\d{2}:?\d{2})$/.test(text) ? text : `${text}Z`),
      DateTime.toEpochMillis
    )
  )

export const unregisteredOrbs = (
  views: readonly OrbView[],
  registered: ReadonlySet<string>,
  requestedAt: string
): readonly OrbView[] => {
  const since = (orbitMillis(requestedAt) ?? 0) - CLOCK_SKEW_MS
  return views.filter(view => {
    if (view.status === 'DELETING' || view.status === 'DELETED' || registered.has(view.id))
      return false
    const created = orbitMillis(view.created_at)
    return created !== undefined && created >= since
  })
}

export const recoverOrbs = Effect.fnUntraced(function* (
  options: RecoveryOptions
): Effect.fn.Return<void, never, ChildProcessSpawner.ChildProcessSpawner> {
  const { print, token } = options
  const listed = yield* Effect.exit(recordDirectories(options.dataHome))
  if (Exit.isFailure(listed)) {
    print(`orb: the orb registry could not be read: ${failureText(listed.cause)}`)
    return
  }
  const directories = listed.value
  const requested: OrbRecordHandle[] = []
  for (const directory of directories) {
    const claim = yield* Effect.exit(claimRecord(directory))
    if (Exit.isFailure(claim)) {
      print(`orb: skipped the orb record in ${directory}: ${failureText(claim.cause)}`)
      continue
    }
    if (claim.value.kind === 'owned') continue
    if (claim.value.kind === 'incomplete') {
      print(`orb: removed the incomplete orb record in ${directory}; it requested no orb`)
      continue
    }
    const { record } = claim.value
    const fields = record.current()
    print(
      `orb: recovering the orb record ${shortId(fields.id)} left by an ended session on ${fields.checkout} (${fields.phase})`
    )
    if (
      fields.keystone.authUrl !== options.authUrl ||
      fields.keystone.projectId !== token.project.id
    ) {
      print(
        `orb: the orb record ${shortId(fields.id)} belongs to project ${fields.keystone.projectName} at ${fields.keystone.authUrl}; source that project's openrc and run dev --orb to recover it.`
      )
      yield* settlePresence(options, fields)
      yield* record.release
      continue
    }
    if (fields.orbId === undefined) {
      requested.push(record)
      continue
    }
    const outcome = yield* recoverOrb(options, record, fields.orbId)
    yield* settlePresence(options, fields)
    if (outcome === 'kept') yield* record.release
  }
  if (requested.length > 0) yield* recoverRequested(options, requested)
})

const recordedOrbIds = Effect.fnUntraced(function* (dataHome: string) {
  const named = new Set<string>()
  for (const directory of yield* recordDirectories(dataHome)) {
    if (!existsSync(join(directory, 'record.json'))) continue
    const { orbId } = yield* readRecord(directory)
    if (orbId !== undefined) named.add(orbId)
  }
  return named
})

const recoverOrb = Effect.fnUntraced(function* (
  options: RecoveryOptions,
  record: OrbRecordHandle,
  orbId: string
): Effect.fn.Return<Recovered, never, ChildProcessSpawner.ChildProcessSpawner> {
  const { orbit, print } = options
  const fields = record.current()
  const label = shortId(orbId)
  const command = deleteCommand(options.token.orbitUrl, orbId)
  const read = yield* Effect.exit(orbit.get(orbId))
  if (Exit.isFailure(read)) {
    const error = Cause.squash(read.cause)
    if (error instanceof OrbError && error.status === 404)
      return yield* removeRecord(
        record,
        print,
        `orb ${label} no longer exists in orbit; its record was removed`
      )
    print(
      `orb: orb ${label} could not be read from orbit (${errorText(error)}); it and its record are kept for the next dev --orb.`
    )
    return 'kept'
  }
  const view = read.value
  if (view.status === 'DELETING' || view.status === 'DELETED')
    return yield* removeRecord(
      record,
      print,
      `orb ${label} is ${view.status}; its record was removed`
    )
  const holdsWork = fields.phase === 'active' || fields.phase === 'returning'
  if (holdsWork) {
    if (view.status !== 'ACTIVE') {
      print(
        `orb: orb ${label} is ${view.status}${view.fault === null ? '' : ` (${view.fault})`}, so its work cannot be returned; the orb is kept and the next dev --orb tries again.\nDelete it with: ${command}`
      )
      return 'kept'
    }
    const returned = yield* Effect.exit(returnToBranch(options, record, view))
    if (Exit.isFailure(returned)) {
      print(
        `orb: the work of orb ${label} could not be returned: ${failureText(returned.cause)}\nThe orb is kept and the next dev --orb tries again. Delete it with: ${command}`
      )
      return 'kept'
    }
    print(
      returned.value === undefined
        ? `orb: orb ${label} has no work that ${fields.checkout} lacks`
        : `orb: the work of orb ${label} is on the branch ${returned.value} of ${fields.checkout}; merge it with: git merge ${returned.value}`
    )
  } else print(`orb: orb ${label} holds no work (phase ${fields.phase}); deleting it`)
  const deleted = yield* Effect.exit(deleteRecorded(orbit, record, orbId, print))
  if (Exit.isSuccess(deleted)) return 'removed'
  print(
    `orb: orb ${label} could not be confirmed deleted: ${failureText(deleted.cause)}\nThe next dev --orb checks it again. Delete it with: ${command}`
  )
  return 'kept'
})

const removeRecord = (
  record: OrbRecordHandle,
  print: (line: string) => void,
  done: string
): Effect.Effect<Recovered> =>
  Effect.exit(record.remove).pipe(
    Effect.map(removed => {
      if (Exit.isSuccess(removed)) {
        print(`orb: ${done}`)
        return 'removed'
      }
      print(`orb: ${failureText(removed.cause)}`)
      return 'kept'
    })
  )

const returnToBranch = Effect.fnUntraced(function* (
  options: RecoveryOptions,
  record: OrbRecordHandle,
  view: OrbView
): Effect.fn.Return<string | undefined, OrbError, ChildProcessSpawner.ChildProcessSpawner> {
  const fields = record.current()
  if (!existsSync(fields.checkout))
    return yield* orbFailure(`the checkout ${fields.checkout} no longer exists`)
  if (view.ssh_host === null || view.ssh_user === null)
    return yield* orbFailure('orbit reports no SSH address or user for the orb')
  if (!existsSync(record.knownHostsPath))
    return yield* orbFailure(`the record has no known_hosts for the orb (${record.knownHostsPath})`)
  rmSync(record.controlPath, { force: true })
  const ssh = makeOrbSsh({
    user: view.ssh_user,
    host: view.ssh_host,
    keyPath: record.keyPath,
    knownHostsPath: record.knownHostsPath,
    controlPath: record.controlPath,
  })
  const repository = orbRepository(ssh, fields.orbPath)
  const git = yield* hardenedGit(fields.checkout, repository.protocol, repository.gitSshCommand)
  const base = yield* git.run(['rev-parse', '--verify', '-q', `${fields.baseRef}^{commit}`], {
    exitCodes: [0, 1],
  })
  if (base.exitCode !== 0)
    return yield* orbFailure(
      `${fields.checkout} lacks ${fields.baseRef}, the upload this orb started from`
    )
  yield* ssh.checked('true', { timeout: '30 seconds' })
  const fetched = yield* fetchWork(git, {
    orbPath: fields.orbPath,
    repository,
    baseRef: fields.baseRef,
    endRef: `refs/dev/orb/${fields.id}/end`,
  })
  if (fetched.kind === 'unchanged') return undefined
  const written = yield* options.lifecycle
    .writeBranch({
      cwd: fields.checkout,
      name: `dev/orb-recovery/${fields.id}`,
      commit: fetched.work,
    })
    .pipe(
      Effect.mapError(error =>
        orbFailure(`the work could not be written to a branch: ${error.message}`, error)
      )
    )
  return written.name
})

export const settlePresence = Effect.fnUntraced(function* (
  options: Pick<RecoveryOptions, 'lifecycle' | 'print'>,
  record: OrbRecord
): Effect.fn.Return<void> {
  const useId = record.presenceUseId
  if (useId === undefined) return
  const { print } = options
  if (record.phase === 'returning') {
    const views = yield* Effect.option(options.lifecycle.inspect({ cwd: record.checkout }))
    const view = Option.getOrUndefined(views)?.find(candidate =>
      candidate.uses.some(use => use.id === useId)
    )
    if (Option.isSome(views) && view === undefined) return
    const release =
      view?.taskId !== undefined && view.reservationId !== undefined
        ? `dev workspace release ${view.taskId}`
        : 'dev workspace release pre-existing'
    print(
      `orb: the session of orb record ${shortId(record.id)} ended while returning work into ${record.checkout}, which may be half-written, so its workspace use stays. Check the checkout, then clear the use with: ${release}`
    )
    return
  }
  const settled = yield* Effect.exit(
    options.lifecycle.settleOrbPresence({ cwd: record.checkout, useId: WorkspaceId.make(useId) })
  )
  if (Exit.isFailure(settled))
    print(
      `orb: the workspace use the ended session left on ${record.checkout} stays: ${failureText(settled.cause)}`
    )
  else if (settled.value.outcome === 'settled')
    print(`orb: ${record.checkout}: ${settled.value.reason}`)
})

const recoverRequested = Effect.fnUntraced(function* (
  options: RecoveryOptions,
  records: readonly OrbRecordHandle[]
): Effect.fn.Return<void> {
  const { orbit, print } = options
  const keep = Effect.forEach(records, record => record.release, { discard: true })
  for (const record of records) yield* settlePresence(options, record.current())
  const unnamed = (text: string) =>
    Effect.sync(() =>
      print(
        `orb: an orb record could not be read (${text}), so dev cannot tell which orbs the records name; no orb was deleted and ${records.length} record(s) of sessions that ended while requesting an orb are kept for the next dev --orb.`
      )
    ).pipe(Effect.andThen(keep))
  const registered = yield* Effect.exit(recordedOrbIds(options.dataHome))
  if (Exit.isFailure(registered)) return yield* unnamed(failureText(registered.cause))
  const listed = yield* Effect.exit(orbit.list)
  if (Exit.isFailure(listed)) {
    print(
      `orb: the project's orbs could not be listed (${failureText(listed.cause)}); ${records.length} record(s) of sessions that ended while requesting an orb are kept for the next dev --orb.`
    )
    return yield* keep
  }
  const since = records
    .map(record => record.current().createdAt)
    .toSorted()
    .at(0)
  const candidates = unregisteredOrbs(listed.value, registered.value, since ?? '')
  const removeAll = Effect.forEach(records, record => Effect.ignore(record.remove), {
    discard: true,
  })
  if (candidates.length === 0) {
    print(
      `orb: ${records.length} session(s) ended while requesting an orb, and the project has no orb created since then that dev does not know; their record(s) were removed`
    )
    return yield* removeAll
  }
  print(
    `orb: ${records.length} session(s) ended while requesting an orb. orbit cannot tell which orb answered such a request, so these orbs of project ${options.token.project.name}, created since then and absent from every orb record, may be theirs, or another dev data home's or client's:\n${candidates
      .map(view => `  ${view.id} ${view.status} created ${view.created_at}`)
      .join('\n')}`
  )
  if (options.confirm === undefined) {
    print(
      `orb: without an interactive terminal, dev deletes none of them; the next dev --orb in a terminal asks again. Delete one with: ${deleteCommand(options.token.orbitUrl, '<orb-id>')}`
    )
    return yield* keep
  }
  if (
    !(yield* options.confirm(
      `Type y to delete these ${candidates.length} orb(s), anything else to keep them: `
    ))
  ) {
    print('orb: the orbs were kept; the next dev --orb asks again.')
    return yield* keep
  }
  const named = yield* Effect.exit(recordedOrbIds(options.dataHome))
  if (Exit.isFailure(named)) return yield* unnamed(failureText(named.cause))
  let failed = false
  for (const view of candidates) {
    if (named.value.has(view.id)) {
      print(`orb: orb ${shortId(view.id)} was kept: a running dev --orb recorded it meanwhile`)
      continue
    }
    const deleted = yield* Effect.exit(deleteOrb(orbit, view.id, print))
    if (Exit.isFailure(deleted)) {
      failed = true
      print(
        `orb: orb ${shortId(view.id)} could not be confirmed deleted: ${failureText(deleted.cause)}\nDelete it with: ${deleteCommand(options.token.orbitUrl, view.id)}`
      )
    }
  }
  return yield* failed ? keep : removeAll
})
