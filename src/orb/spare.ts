import * as Cause from 'effect/Cause'
import * as Clock from 'effect/Clock'
import * as DateTime from 'effect/DateTime'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import type * as Context from 'effect/Context'
import type * as Scope from 'effect/Scope'
import type * as ChildProcessSpawner from 'effect/process/ChildProcessSpawner'
import { errorText } from '../error-text.ts'
import type { Orbit } from './cloud.ts'
import { deleteRecorded } from './deletion.ts'
import {
  deleteCommand,
  isSpare,
  OrbError,
  shortId,
  type Assignment,
  type OrbConfig,
  type OrbRecord,
  type OrbView,
  type SpareRecord,
  type SpareShape,
} from './domain.ts'
import { orbitMillis } from './recovery.ts'
import {
  claimRecord,
  createRecord,
  readRecord,
  recordDirectories,
  type OrbRecordHandle,
} from './registry.ts'

const SPARE_HOURS = 2
export const SPARE_LIFETIME = Duration.hours(SPARE_HOURS)

const BOOTING: readonly OrbView['status'][] = ['RESERVING', 'BUILDING', 'ACTIVE']

export interface Spare {
  readonly record: OrbRecordHandle
  readonly view: OrbView
}

export interface SpareContext {
  readonly dataHome: string
  readonly keystone: OrbRecord['keystone']
  readonly orbit: Orbit
  readonly config: OrbConfig
  readonly print: (line: string) => void
}

type Services = ChildProcessSpawner.ChildProcessSpawner

const failureText = (cause: Cause.Cause<unknown>): string => errorText(Cause.squash(cause))

export const spareShape = (config: OrbConfig): SpareShape => ({
  size: config.size,
  sshAllowedCidr: config.sshAllowedCidr,
})

const sameShape = (left: SpareShape, right: SpareShape): boolean =>
  left.sshAllowedCidr === right.sshAllowedCidr &&
  left.size.vcpus === right.size.vcpus &&
  left.size.memory_mb === right.size.memory_mb &&
  left.size.disk_gb === right.size.disk_gb

export const spareProblem = (
  spare: SpareRecord,
  view: OrbView,
  now: number,
  wanted: SpareShape
): string | undefined => {
  if (!sameShape(spare.spare, wanted)) return 'it was created with another orb.json'
  if (!BOOTING.includes(view.status))
    return `orbit reports it ${view.status}${view.fault === null ? '' : ` (${view.fault})`}`
  const created = orbitMillis(view.created_at)
  if (created === undefined) return `its creation time ${view.created_at} cannot be read`
  const age = now - created
  if (age >= Duration.toMillis(SPARE_LIFETIME))
    return `it was created ${Math.floor(age / 60_000)} minutes ago, more than ${SPARE_HOURS} hours`
  return undefined
}

export const spareAge = (view: OrbView, now: number): string => {
  const created = orbitMillis(view.created_at)
  return created === undefined
    ? `at ${view.created_at}`
    : `${Math.max(0, Math.floor((now - created) / 60_000))} min ago`
}

const notFound = (cause: Cause.Cause<unknown>): boolean => {
  const error = Cause.squash(cause)
  return error instanceof OrbError && error.status === 404
}

const sameProject = (record: OrbRecord, keystone: OrbRecord['keystone']): boolean =>
  record.keystone.authUrl === keystone.authUrl && record.keystone.projectId === keystone.projectId

type Examined = { readonly kind: 'valid'; readonly spare: Spare } | { readonly kind: 'settled' }

const settled: Examined = { kind: 'settled' }

const examineSpare = Effect.fnUntraced(function* (
  context: SpareContext,
  record: OrbRecordHandle,
  fields: SpareRecord,
  orbId: string
): Effect.fn.Return<Examined> {
  const { orbit, print } = context
  const label = shortId(orbId)
  const observed = yield* Effect.exit(orbit.get(orbId))
  if (Exit.isFailure(observed)) {
    if (notFound(observed.cause)) {
      yield* Effect.ignore(record.remove)
      print(`orb: the spare orb ${label} no longer exists in orbit; its record was removed`)
    } else {
      yield* record.release
      print(
        `orb: the spare orb ${label} could not be read from orbit (${failureText(observed.cause)}); it is kept`
      )
    }
    return settled
  }
  const view = observed.value
  const problem = spareProblem(
    fields,
    view,
    yield* Clock.currentTimeMillis,
    spareShape(context.config)
  )
  if (problem === undefined) return { kind: 'valid', spare: { record, view } }
  print(`orb: deleting the spare orb ${label}: ${problem}`)
  const deleted = yield* Effect.exit(deleteRecorded(orbit, record, orbId, print))
  if (Exit.isFailure(deleted)) {
    yield* record.release
    print(
      `orb: the spare orb ${label} could not be confirmed deleted: ${failureText(deleted.cause)}\nDelete it with: ${deleteCommand(context.dataHome, orbId)}`
    )
  }
  return settled
})

const claimSpare = Effect.fnUntraced(function* (
  context: SpareContext,
  directory: string
): Effect.fn.Return<Examined> {
  const read = yield* Effect.exit(readRecord(directory))
  if (
    Exit.isFailure(read) ||
    !isSpare(read.value) ||
    read.value.orbId === undefined ||
    !sameProject(read.value, context.keystone)
  )
    return settled
  const claim = yield* Effect.exit(claimRecord(directory))
  if (Exit.isFailure(claim)) return settled
  if (claim.value.kind === 'owned') {
    context.print(
      `orb: the spare orb ${shortId(read.value.orbId)} is held by another running dev --orb`
    )
    return settled
  }
  if (claim.value.kind !== 'claimed') return settled
  const { record } = claim.value
  const fields = record.current()
  if (!isSpare(fields) || fields.orbId === undefined || !sameProject(fields, context.keystone)) {
    yield* record.release
    return settled
  }
  return yield* examineSpare(context, record, fields, fields.orbId)
})

export const takeSpare = Effect.fnUntraced(function* (
  context: SpareContext,
  assignment: Assignment
): Effect.fn.Return<Spare | undefined> {
  const directories = yield* Effect.exit(recordDirectories(context.dataHome))
  if (Exit.isFailure(directories)) return undefined
  let taken: Spare | undefined
  for (const directory of directories.value) {
    const examined = yield* claimSpare(context, directory)
    if (examined.kind !== 'valid') continue
    const { record, view } = examined.spare
    if (taken !== undefined) {
      yield* record.release
      continue
    }
    const assigned = yield* Effect.exit(record.assign(assignment))
    if (Exit.isFailure(assigned)) {
      yield* record.release
      context.print(
        `orb: the spare orb ${shortId(view.id)} could not be taken: ${failureText(assigned.cause)}`
      )
      continue
    }
    taken = examined.spare
  }
  return taken
})

const holdsSpare = Effect.fnUntraced(function* (context: SpareContext) {
  for (const directory of yield* recordDirectories(context.dataHome)) {
    const read = yield* Effect.exit(readRecord(directory))
    if (Exit.isSuccess(read) && isSpare(read.value) && sameProject(read.value, context.keystone))
      return true
  }
  return false
})

type Requested =
  | { readonly kind: 'requested'; readonly spare: Spare }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'present' }

const requestSpare = Effect.fnUntraced(function* (
  context: SpareContext
): Effect.fn.Return<Requested, never, Services> {
  const present = yield* Effect.exit(holdsSpare(context))
  if (Exit.isFailure(present) || present.value) return { kind: 'present' }
  const shape = spareShape(context.config)
  const created = yield* Effect.exit(
    createRecord(context.dataHome, { keystone: context.keystone, spare: shape })
  )
  if (Exit.isFailure(created)) return { kind: 'refused', reason: failureText(created.cause) }
  const record = created.value
  const view = yield* Effect.exit(
    context.orbit
      .create({
        size: shape.size,
        publicKey: record.publicKey,
        sshAllowedCidr: shape.sshAllowedCidr,
      })
      .pipe(
        Effect.flatMap(answer =>
          Effect.exit(record.update({ phase: 'created', orbId: answer.id })).pipe(
            Effect.map(recorded => ({ answer, recorded }))
          )
        ),
        Effect.uninterruptible
      )
  )
  if (Exit.isSuccess(view)) {
    const { answer, recorded } = view.value
    if (Exit.isSuccess(recorded)) return { kind: 'requested', spare: { record, view: answer } }
    yield* record.release
    return {
      kind: 'refused',
      reason: `orbit created orb ${answer.id}, but its record could not name it (${failureText(recorded.cause)}); the next dev --orb offers to delete it. Delete it now with: ${deleteCommand(context.dataHome, answer.id)}`,
    }
  }
  yield* Effect.ignore(record.remove)
  const error = Cause.squash(view.cause)
  return {
    kind: 'refused',
    reason:
      error instanceof OrbError && error.status === 409
        ? 'orbit had no capacity for it'
        : errorText(error),
  }
})

const expiry = (view: OrbView, record: OrbRecordHandle): string => {
  const created = orbitMillis(view.created_at) ?? orbitMillis(record.current().createdAt) ?? 0
  return DateTime.formatLocal(DateTime.makeUnsafe(created + Duration.toMillis(SPARE_LIFETIME)), {
    hour: '2-digit',
    minute: '2-digit',
  })
}

export interface SpareSlot {
  readonly request: Effect.Effect<void>
  readonly take: Effect.Effect<Spare | undefined>
  readonly leave: Effect.Effect<string | undefined>
}

type SlotState =
  | { readonly kind: 'empty' }
  | { readonly kind: 'requesting'; readonly fiber: Fiber.Fiber<Requested> }

export const makeSpareSlot = (
  context: SpareContext,
  scope: Scope.Scope,
  services: Context.Context<Services>
): SpareSlot => {
  let state: SlotState = { kind: 'empty' }
  const claim = Effect.suspend(() => {
    const current = state
    state = { kind: 'empty' }
    return current.kind === 'requesting' ? Fiber.join(current.fiber) : Effect.succeed(undefined)
  })
  return {
    request: Effect.suspend(() => {
      if (state.kind !== 'empty') return Effect.void
      return Effect.forkIn(scope)(requestSpare(context).pipe(Effect.provideContext(services))).pipe(
        Effect.map(fiber => {
          state = { kind: 'requesting', fiber }
        })
      )
    }),
    take: Effect.map(claim, requested =>
      requested?.kind === 'requested' ? requested.spare : undefined
    ),
    leave: Effect.flatMap(claim, requested => {
      switch (requested?.kind) {
        case 'requested': {
          const { record, view } = requested.spare
          return Effect.as(
            record.release,
            `Spare orb ${view.id} stays ready for the next dev --orb until ${expiry(view, record)}.\nDelete it with: ${deleteCommand(context.dataHome, view.id)}`
          )
        }
        case 'refused':
          return Effect.succeed(`No spare orb was left for the next dev --orb: ${requested.reason}`)
        default:
          return Effect.succeed(undefined)
      }
    }),
  }
}
