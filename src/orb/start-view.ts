import * as Cause from 'effect/Cause'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Scope from 'effect/Scope'
import {
  loadQuitGraphics,
  orbStartStrip,
  stripFits,
  type OrbStartStrip,
  type QuitTerminal,
} from '../quit-animation.ts'
import {
  LABEL_COLUMNS,
  commandStatus,
  paint,
  progressCleared,
  progressDone,
  seconds,
  spinner,
  type Spinner,
  type TerminalStyle,
} from '../quit-display.ts'
import {
  ORB_SHAPE,
  type OrbArrival,
  type OrbStartScene,
  type QuitGraphics,
  type TerminalHold,
} from '../quit-scene.ts'
import { clock, printDeletion, type DeletionProgress } from './deletion.ts'
import { deleteCommand, shortId, type OrbSize, type OrbStatus } from './domain.ts'

export interface OrbStartTerminal {
  readonly style: TerminalStyle
  readonly out: NodeJS.WritableStream
  readonly columns: number | undefined
  readonly module: QuitTerminal | undefined
}

export type OrbStartStage =
  | { readonly kind: 'authenticating'; readonly user: string; readonly url: string }
  | { readonly kind: 'requesting'; readonly size: OrbSize; readonly url: string }
  | {
      readonly kind: 'taking-spare'
      readonly orbId: string
      readonly status: OrbStatus
      readonly age: string
    }
  | { readonly kind: 'status'; readonly orbId: string; readonly status: OrbStatus }
  | { readonly kind: 'connecting'; readonly destination: string }
  | { readonly kind: 'unshared'; readonly reason: string }
  | {
      readonly kind: 'uploading'
      readonly branch: string
      readonly head: string
      readonly root: string
    }
  | { readonly kind: 'ready'; readonly orbId: string }
  | { readonly kind: 'discarding'; readonly orbId: string; readonly interrupted: boolean }
  | { readonly kind: 'deletion'; readonly orbId: string; readonly progress: DeletionProgress }
  | { readonly kind: 'undeleted'; readonly orbId: string; readonly reason: string }

export interface OrbStartView {
  readonly show: (stage: OrbStartStage) => Effect.Effect<void>
  readonly print: (line: string) => void
  readonly pause: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

type Outcome =
  | { readonly kind: 'pending' }
  | { readonly kind: 'ready'; readonly orbId: string }
  | { readonly kind: 'failed' | 'cancelled' }

type Deletion =
  | { readonly kind: 'none' }
  | { readonly kind: 'deleted'; readonly orbId: string }
  | { readonly kind: 'undeleted'; readonly orbId: string; readonly reason: string }

export interface OrbStartResult {
  readonly outcome: Outcome
  readonly spare: boolean
  readonly placement: string | undefined
  readonly deletion: Deletion
}

const plainText = (stage: OrbStartStage): string | undefined => {
  switch (stage.kind) {
    case 'authenticating':
      return `authenticating as ${stage.user} with Keystone at ${stage.url}`
    case 'requesting':
      return `requesting an orb (${stage.size.vcpus} vCPU, ${stage.size.memory_mb} MB, ${stage.size.disk_gb} GB) from ${stage.url}`
    case 'taking-spare':
      return `taking the spare orb ${shortId(stage.orbId)} (${stage.status}, created ${stage.age})`
    case 'status':
      return `orb ${shortId(stage.orbId)} ${stage.status}`
    case 'connecting':
      return `connecting to ${stage.destination} over SSH`
    case 'unshared':
      return `continuing without a shared SSH connection: ${stage.reason}`
    case 'uploading':
      return `uploading ${stage.branch} at ${stage.head.slice(0, 7)} with its uncommitted changes to ${stage.root}`
    case 'ready':
      return `orb ${shortId(stage.orbId)} is ready`
    default:
      return undefined
  }
}

export const unconfirmedText = (dataHome: string, orbId: string, reason: string): string =>
  `Orb ${orbId} could not be confirmed deleted: ${reason}\nIts record stays, and the next dev --orb deletes the orb and removes it.\nDelete it now with: ${deleteCommand(dataHome, orbId)}`

const outcomeSummary = (result: OrbStartResult, style: TerminalStyle): string => {
  const { outcome } = result
  switch (outcome.kind) {
    case 'ready':
      return paint(
        style,
        'ok',
        `✓ ${result.spare ? 'spare ' : ''}orb ${shortId(outcome.orbId)} ready${result.placement === undefined ? '' : ` · ${result.placement}`}`
      )
    case 'cancelled':
      return 'Orb start cancelled'
    case 'failed':
    case 'pending':
      return paint(style, 'fail', '✗ The orb did not start')
  }
}

const deletionSummary = (deletion: Deletion, style: TerminalStyle): readonly string[] => {
  switch (deletion.kind) {
    case 'none':
      return []
    case 'deleted':
      return [paint(style, 'ok', `✓ orb ${shortId(deletion.orbId)} deleted`)]
    case 'undeleted':
      return [paint(style, 'fail', `✗ orb ${shortId(deletion.orbId)} not confirmed deleted`)]
  }
}

export const formatOrbStartSummary = (
  result: OrbStartResult,
  elapsedMs: number,
  style: TerminalStyle
): string =>
  [outcomeSummary(result, style), ...deletionSummary(result.deletion, style)].join(' · ') +
  paint(style, 'dim', ` · ${seconds(elapsedMs)}`)

export const formatOrbStartReceipt = (
  result: OrbStartResult,
  elapsedMs: number,
  style: TerminalStyle,
  dataHome: string
): readonly string[] => [
  formatOrbStartSummary(result, elapsedMs, style),
  ...(result.deletion.kind === 'undeleted'
    ? [
        commandStatus(
          style,
          deleteCommand(dataHome, result.deletion.orbId),
          `${result.deletion.reason}. Its record stays, and the next dev --orb deletes the orb.`
        ),
      ]
    : []),
]

const NO_HOLD: TerminalHold = { begin: () => {}, end: () => {} }
const CLEAR_LINE = '\r\x1b[2K'

type Display =
  | { readonly kind: 'plain' }
  | { readonly kind: 'spinner'; readonly terminal: OrbStartTerminal }
  | {
      readonly kind: 'strip'
      readonly terminal: OrbStartTerminal
      readonly graphics: QuitGraphics
    }

type Progress =
  | { readonly kind: 'idle' }
  | { readonly kind: 'spinner'; readonly scope: Scope.Closeable; readonly spinner: Spinner }
  | { readonly kind: 'strip'; readonly scope: Scope.Closeable; readonly strip: OrbStartStrip }

const chooseDisplay = Effect.fnUntraced(function* (
  terminal: OrbStartTerminal | undefined
): Effect.fn.Return<Display> {
  if (terminal === undefined || !terminal.style.live) return { kind: 'plain' }
  const graphics = yield* loadQuitGraphics(true, terminal.columns, NO_HOLD, terminal.module)
  return stripFits(graphics, ORB_SHAPE, LABEL_COLUMNS)
    ? { kind: 'strip', terminal, graphics }
    : { kind: 'spinner', terminal }
})

const arrive = (arrival: OrbArrival, status: OrbStatus, t: number): OrbArrival => {
  switch (status) {
    case 'RESERVING':
      return arrival.kind === 'awaited' ? { kind: 'reserved', at: t } : arrival
    case 'BUILDING':
      return arrival.kind === 'awaited' || arrival.kind === 'reserved'
        ? { kind: 'building', since: t }
        : arrival
    case 'ACTIVE':
      return arrival.kind === 'active' ? arrival : { kind: 'active', at: t }
    default:
      return arrival
  }
}

export const openOrbStartView = Effect.fnUntraced(function* (
  terminal: OrbStartTerminal | undefined,
  print: (line: string) => void,
  dataHome: string
): Effect.fn.Return<OrbStartView, never, Scope.Scope> {
  const display = yield* chooseDisplay(terminal)
  const style: TerminalStyle =
    display.kind === 'plain' ? { live: false, color: false } : display.terminal.style
  const started = yield* Clock.currentTimeMillis
  const sinceStart = Effect.map(Clock.currentTimeMillis, now => now - started)
  let scene: OrbStartScene = {
    arrival: { kind: 'awaited' },
    upload: undefined,
    launch: { kind: 'pending' },
    fate: { kind: 'present' },
  }
  let result: OrbStartResult = {
    outcome: { kind: 'pending' },
    spare: false,
    placement: undefined,
    deletion: { kind: 'none' },
  }
  let stem = 'Contacting orbit…'
  let destination: string | undefined
  let progress: Progress = { kind: 'idle' }
  let shown = false
  let closed = false

  const label = (elapsedMs: number): string => paint(style, 'dim', `${stem} ${seconds(elapsedMs)}`)

  const note = (text: string): void => {
    if (closed || display.kind === 'plain') {
      print(text)
      return
    }
    switch (progress.kind) {
      case 'idle':
        display.terminal.out.write(`${text}\n`)
        return
      case 'spinner':
        display.terminal.out.write(`${CLEAR_LINE}${text}\n`)
        return
      case 'strip':
        progress.strip.note(text)
    }
  }

  const begin = Effect.gen(function* () {
    if (closed || progress.kind !== 'idle' || display.kind === 'plain') return
    const scope = yield* Scope.make()
    if (display.kind === 'spinner') {
      const running = yield* Scope.provide(scope)(
        spinner(style, display.terminal.out, now => label(now - started))
      )
      progress = { kind: 'spinner', scope, spinner: running }
      return
    }
    const strip = yield* Scope.provide(scope)(
      orbStartStrip(display.terminal.out, display.graphics, scene, started, label)
    )
    progress = { kind: 'strip', scope, strip }
  })

  const stop = (summary: string | undefined): Effect.Effect<void> =>
    Effect.suspend(() => {
      const current = progress
      progress = { kind: 'idle' }
      switch (current.kind) {
        case 'idle':
          return Effect.void
        case 'spinner':
          return current.spinner.stop.pipe(Effect.andThen(Scope.close(current.scope, Exit.void)))
        case 'strip':
          return (summary === undefined ? Effect.void : current.strip.finish(summary)).pipe(
            Effect.ensuring(Scope.close(current.scope, Exit.void))
          )
      }
    })

  const change = (next: (current: OrbStartScene, t: number) => OrbStartScene) =>
    Effect.gen(function* () {
      const t = yield* sinceStart
      scene = next(scene, t)
      if (progress.kind === 'strip') yield* progress.strip.update(() => scene)
    })

  const conclude = (outcome: 'failed' | 'cancelled') =>
    change((current, at) =>
      current.launch.kind === 'pending' ? { ...current, launch: { kind: outcome, at } } : current
    ).pipe(
      Effect.andThen(
        Effect.sync(() => {
          if (result.outcome.kind === 'pending') result = { ...result, outcome: { kind: outcome } }
        })
      )
    )

  yield* Effect.addFinalizer(exit =>
    Effect.gen(function* () {
      if (closed) return
      if (Exit.isFailure(exit))
        yield* conclude(Cause.hasInterruptsOnly(exit.cause) ? 'cancelled' : 'failed')
      if (display.kind === 'plain' || !shown) {
        closed = true
        return
      }
      const ms = yield* sinceStart
      yield* stop(formatOrbStartSummary(result, ms, style))
      closed = true
      const failed = result.outcome.kind === 'failed' || result.deletion.kind === 'undeleted'
      display.terminal.out.write(failed ? progressDone(style, true) : progressCleared(style))
      for (const line of formatOrbStartReceipt(result, ms, style, dataHome))
        display.terminal.out.write(`${line}\n`)
    })
  )

  const live = (stage: OrbStartStage): Effect.Effect<void> =>
    Effect.gen(function* () {
      shown = true
      switch (stage.kind) {
        case 'authenticating':
          stem = 'Authenticating with Keystone…'
          break
        case 'requesting':
          stem = 'Requesting an orb…'
          break
        case 'taking-spare':
          result = { ...result, spare: true }
          stem = `Taking spare orb ${shortId(stage.orbId)} · ${stage.status}`
          yield* change((current, t) => ({
            ...current,
            arrival: arrive(current.arrival, stage.status, t),
          }))
          break
        case 'status':
          stem = `${result.spare ? 'Spare orb' : 'Orb'} ${shortId(stage.orbId)} · ${stage.status}`
          yield* change((current, t) => ({
            ...current,
            arrival: arrive(current.arrival, stage.status, t),
          }))
          break
        case 'connecting':
          ;({ destination } = stage)
          stem = `Connecting to ${stage.destination}…`
          break
        case 'unshared':
          note(paint(style, 'dim', plainText(stage) ?? ''))
          break
        case 'uploading':
          stem = `Uploading ${stage.branch} at ${stage.head.slice(0, 7)}…`
          result = {
            ...result,
            placement: `${stage.branch} at ${stage.head.slice(0, 7)}${destination === undefined ? '' : ` on ${destination}`}`,
          }
          yield* change((current, t) => ({ ...current, upload: t }))
          break
        case 'ready':
          result = { ...result, outcome: { kind: 'ready', orbId: stage.orbId } }
          yield* change((current, at) => ({ ...current, launch: { kind: 'ready', at } }))
          break
        case 'discarding':
          stem = `Deleting orb ${shortId(stage.orbId)}…`
          yield* conclude(stage.interrupted ? 'cancelled' : 'failed')
          break
        case 'deletion': {
          const { progress: deletion } = stage
          if (deletion.kind === 'deleted') {
            result = { ...result, deletion: { kind: 'deleted', orbId: stage.orbId } }
            yield* change((current, at) => ({ ...current, fate: { kind: 'deleted', at } }))
            break
          }
          stem = `Deleting orb ${shortId(stage.orbId)} · ${deletion.status}`
          yield* change((current, since) =>
            current.fate.kind === 'deleting'
              ? current
              : { ...current, fate: { kind: 'deleting', since } }
          )
          break
        }
        case 'undeleted':
          result = {
            ...result,
            deletion: { kind: 'undeleted', orbId: stage.orbId, reason: stage.reason },
          }
          yield* change((current, at) => ({ ...current, fate: { kind: 'undeleted', at } }))
      }
      yield* begin
    })

  const plain = (stage: OrbStartStage): Effect.Effect<void> =>
    Effect.gen(function* () {
      switch (stage.kind) {
        case 'discarding':
          print(
            `Deleting orb ${shortId(stage.orbId)} after ${stage.interrupted ? 'the interrupted start' : 'the failed start'}…`
          )
          return
        case 'deletion':
          return yield* printDeletion(stage.orbId, print)(stage.progress)
        case 'undeleted':
          print(unconfirmedText(dataHome, stage.orbId, stage.reason))
          return
        default: {
          const time = clock(yield* sinceStart)
          print(`orb: ${plainText(stage) ?? ''} (${time})`)
        }
      }
    })

  const show = (stage: OrbStartStage): Effect.Effect<void> =>
    display.kind === 'plain' || closed ? plain(stage) : live(stage)

  const pause = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.suspend(() =>
      progress.kind === 'idle'
        ? effect
        : Effect.andThen(stop(undefined), effect).pipe(Effect.ensuring(begin))
    )

  return { show, print: note, pause }
})
