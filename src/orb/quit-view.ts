import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Scope from 'effect/Scope'
import {
  loadQuitGraphics,
  orbStrip,
  stripFits,
  type OrbStrip,
  type QuitTerminal,
} from '../quit-animation.ts'
import {
  LABEL_COLUMNS,
  commandStatus,
  count,
  paint,
  seconds,
  spinner,
  type Spinner,
  type TerminalStyle,
} from '../quit-display.ts'
import { ORB_SHAPE, type OrbScene, type QuitGraphics, type TerminalHold } from '../quit-scene.ts'
import type { DeletionProgress } from './deletion.ts'
import type { SettledReturn } from './session.ts'
import type { SpareLeft } from './spare.ts'
import type { Divergence } from './transfer.ts'

export interface OrbQuitTerminal {
  readonly style: TerminalStyle
  readonly out: NodeJS.WritableStream
  readonly columns: number | undefined
  readonly hold: TerminalHold
  readonly module: QuitTerminal | undefined
}

export interface OrbClosing {
  readonly label: string
  readonly branch: string
  readonly location: string
  readonly recoveryBranch: string
  readonly deleteCommand: string
  readonly spare: SpareLeft | undefined
}

export type OrbQuitStage =
  | { readonly kind: 'returning' }
  | { readonly kind: 'return-failed'; readonly reason: string }
  | { readonly kind: 'returned'; readonly outcome: SettledReturn }
  | { readonly kind: 'kept'; readonly reason: string }
  | { readonly kind: 'deletion'; readonly progress: DeletionProgress }
  | { readonly kind: 'undeleted'; readonly reason: string }

export interface OrbQuitView {
  readonly show: (stage: OrbQuitStage) => Effect.Effect<void>
}

export type OrbWorkResult =
  | { readonly kind: 'returned'; readonly outcome: SettledReturn }
  | { readonly kind: 'kept'; readonly reason: string; readonly shown: boolean }

export type OrbDeletionResult =
  | { readonly kind: 'deleted' }
  | { readonly kind: 'undeleted'; readonly reason: string }

export interface OrbQuitResult {
  readonly work?: OrbWorkResult
  readonly deletion?: OrbDeletionResult
}

export const divergenceText = (reason: Divergence, branch: string): string => {
  switch (reason) {
    case 'branch-moved':
      return `${branch} moved on the Mac, so the orb's commits cannot fast-forward it.`
    case 'history-rewritten':
      return `The orb rewrote the commit it was given (an amend or a rebase), so its commits cannot fast-forward ${branch}.`
    case 'branch-switched':
      return `The checkout is no longer on ${branch}.`
    case 'overlap':
      return "Local edits overlap the orb's changes."
  }
}

const returnedWork = (commits: number, files: number): string =>
  [
    ...(commits === 0 ? [] : [count(commits, 'commit')]),
    ...(files === 0 ? [] : [count(files, 'changed file')]),
  ].join(' and ') || 'Work'

const workSummary = (closing: OrbClosing, work: OrbWorkResult, style: TerminalStyle): string => {
  if (work.kind === 'kept') return paint(style, 'fail', `✗ orb ${closing.label} kept`)
  const { outcome } = work
  switch (outcome.kind) {
    case 'returned':
      return paint(
        style,
        'ok',
        `✓ ${returnedWork(outcome.commits, outcome.files)} returned to ${closing.branch} at ${outcome.head.slice(0, 7)}`
      )
    case 'unchanged':
      return 'Nothing to return'
    case 'diverged':
      return paint(style, 'warn', `Work kept on ${outcome.branch}`)
  }
}

const deletionSummary = (
  closing: OrbClosing,
  deletion: OrbDeletionResult,
  style: TerminalStyle
): string =>
  deletion.kind === 'deleted'
    ? paint(style, 'ok', `✓ orb ${closing.label} deleted`)
    : paint(style, 'fail', `✗ orb ${closing.label} not confirmed deleted`)

export const formatOrbQuitSummary = (
  closing: OrbClosing,
  result: OrbQuitResult,
  elapsedMs: number,
  style: TerminalStyle
): string =>
  [
    ...(result.work === undefined ? [] : [workSummary(closing, result.work, style)]),
    ...(result.deletion === undefined ? [] : [deletionSummary(closing, result.deletion, style)]),
  ].join(' · ') + paint(style, 'dim', ` · ${seconds(elapsedMs)}`)

const workDetails = (
  closing: OrbClosing,
  work: OrbWorkResult | undefined,
  style: TerminalStyle
): readonly string[] => {
  if (work === undefined) return []
  if (work.kind === 'kept')
    return [
      ...(work.shown ? [] : [paint(style, 'dim', `The return failed: ${work.reason}`)]),
      commandStatus(
        style,
        'dev --orb',
        `Returns the work still on the orb at ${closing.location} to ${closing.recoveryBranch}, then deletes the orb.`
      ),
      commandStatus(style, closing.deleteCommand, 'Discards its work and deletes the orb.'),
    ]
  if (work.outcome.kind !== 'diverged') return []
  return [
    commandStatus(
      style,
      `git merge ${work.outcome.branch}`,
      `${divergenceText(work.outcome.reason, closing.branch)} The checkout, its branch and its index are untouched.`
    ),
  ]
}

const spareDetails = (spare: SpareLeft | undefined, style: TerminalStyle): readonly string[] => {
  if (spare === undefined) return []
  if (spare.kind === 'refused')
    return [paint(style, 'dim', `No spare orb was left for the next dev --orb: ${spare.reason}`)]
  return [
    commandStatus(
      style,
      spare.deleteCommand,
      `Spare orb ${spare.orbId} stays ready for the next dev --orb until ${spare.until}.`
    ),
  ]
}

export const formatOrbQuitReceipt = (
  closing: OrbClosing,
  result: OrbQuitResult,
  elapsedMs: number,
  style: TerminalStyle
): readonly string[] => [
  formatOrbQuitSummary(closing, result, elapsedMs, style),
  ...workDetails(closing, result.work, style),
  ...(result.deletion?.kind === 'undeleted'
    ? [
        commandStatus(
          style,
          closing.deleteCommand,
          `${result.deletion.reason}. Its record stays, and the next dev --orb deletes the orb.`
        ),
      ]
    : []),
  ...spareDetails(closing.spare, style),
]

const PLAIN: TerminalStyle = { live: false, color: false }

type Display =
  | { readonly kind: 'plain' }
  | { readonly kind: 'spinner'; readonly terminal: OrbQuitTerminal }
  | {
      readonly kind: 'strip'
      readonly terminal: OrbQuitTerminal
      readonly graphics: QuitGraphics
    }

type Progress =
  | { readonly kind: 'idle' }
  | { readonly kind: 'spinner'; readonly scope: Scope.Closeable; readonly spinner: Spinner }
  | {
      readonly kind: 'strip'
      readonly scope: Scope.Closeable
      readonly strip: OrbStrip
    }

const chooseDisplay = Effect.fnUntraced(function* (
  terminal: OrbQuitTerminal | undefined
): Effect.fn.Return<Display> {
  if (terminal === undefined || !terminal.style.live) return { kind: 'plain' }
  const graphics = yield* loadQuitGraphics(true, terminal.columns, terminal.hold, terminal.module)
  return stripFits(graphics, ORB_SHAPE, LABEL_COLUMNS)
    ? { kind: 'strip', terminal, graphics }
    : { kind: 'spinner', terminal }
})

export const openOrbQuitView = Effect.fnUntraced(function* (
  terminal: OrbQuitTerminal | undefined,
  print: (line: string) => void,
  closing: OrbClosing
): Effect.fn.Return<OrbQuitView, never, Scope.Scope> {
  const display = yield* chooseDisplay(terminal)
  const style = display.kind === 'plain' ? PLAIN : display.terminal.style
  const lines = (texts: readonly string[]): Effect.Effect<void> =>
    Effect.sync(() => {
      for (const text of texts) {
        if (display.kind === 'plain') print(text)
        else display.terminal.out.write(`${text}\n`)
      }
    })
  const started = yield* Clock.currentTimeMillis
  let result: OrbQuitResult = {}
  let returning = started
  let deleting: { readonly since: number; status: string } | undefined
  let progress: Progress = { kind: 'idle' }

  const label = (now: number): string =>
    paint(
      style,
      'dim',
      deleting === undefined
        ? `Returning work from orb ${closing.label}… ${seconds(now - returning)}`
        : `Deleting orb ${closing.label} · ${deleting.status} ${seconds(now - deleting.since)}`
    )
  const scene = (change: (current: OrbScene, t: number) => OrbScene): Effect.Effect<void> =>
    progress.kind === 'strip' ? progress.strip.update(change) : Effect.void

  const begin = Effect.gen(function* () {
    if (progress.kind !== 'idle' || display.kind === 'plain') return
    const scope = yield* Scope.make()
    if (display.kind === 'spinner') {
      const shown = yield* Scope.provide(scope)(spinner(style, display.terminal.out, label))
      progress = { kind: 'spinner', scope, spinner: shown }
      return
    }
    const opened = yield* Clock.currentTimeMillis
    const strip = yield* Scope.provide(scope)(
      orbStrip(display.terminal.out, display.graphics, closing.spare?.kind === 'ready', elapsed =>
        label(opened + elapsed)
      )
    )
    progress = { kind: 'strip', scope, strip }
  })

  const settle = (summary: string): Effect.Effect<void> =>
    Effect.suspend(() => {
      const current = progress
      progress = { kind: 'idle' }
      switch (current.kind) {
        case 'idle':
          return Effect.void
        case 'spinner':
          return current.spinner.stop.pipe(Effect.andThen(Scope.close(current.scope, Exit.void)))
        case 'strip':
          return current.strip
            .finish(summary)
            .pipe(Effect.ensuring(Scope.close(current.scope, Exit.void)))
      }
    })

  const elapsed = Effect.map(Clock.currentTimeMillis, now => now - started)

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const ms = yield* elapsed
      yield* settle(formatOrbQuitSummary(closing, result, ms, style))
      yield* lines(formatOrbQuitReceipt(closing, result, ms, style))
    })
  )

  const show = (stage: OrbQuitStage): Effect.Effect<void> =>
    Effect.gen(function* () {
      switch (stage.kind) {
        case 'returning':
          returning = yield* Clock.currentTimeMillis
          deleting = undefined
          if (display.kind === 'plain')
            yield* lines([`Returning work from orb ${closing.label}...`])
          yield* begin
          return
        case 'return-failed': {
          const failure = paint(style, 'fail', `✗ The return failed: ${stage.reason}`)
          yield* scene((current, at) => ({ ...current, work: { kind: 'failed', at } }))
          yield* settle(failure)
          yield* lines([failure])
          result = { ...result, work: { kind: 'kept', reason: stage.reason, shown: true } }
          return
        }
        case 'kept': {
          const shown = result.work?.kind === 'kept' && result.work.reason === stage.reason
          result = { ...result, work: { kind: 'kept', reason: stage.reason, shown } }
          yield* scene((current, at) => ({ ...current, work: { kind: 'failed', at } }))
          return
        }
        case 'returned': {
          const { outcome } = stage
          result = { ...result, work: { kind: 'returned', outcome } }
          yield* scene((current, at) => ({ ...current, work: { kind: outcome.kind, at } }))
          return
        }
        case 'deletion': {
          const now = yield* Clock.currentTimeMillis
          if (stage.progress.kind === 'deleted') {
            result = { ...result, deletion: { kind: 'deleted' } }
            yield* scene((current, at) => ({ ...current, fate: { kind: 'deleted', at } }))
            return
          }
          if (deleting === undefined) {
            deleting = { since: now, status: stage.progress.status }
            if (display.kind === 'plain') yield* lines([`Deleting orb ${closing.label}...`])
            yield* begin
            yield* scene((current, since) => ({ ...current, fate: { kind: 'deleting', since } }))
            return
          }
          deleting.status = stage.progress.status
          return
        }
        case 'undeleted':
          result = { ...result, deletion: { kind: 'undeleted', reason: stage.reason } }
          yield* scene((current, at) => ({ ...current, fate: { kind: 'undeleted', at } }))
      }
    })

  return { show }
})
