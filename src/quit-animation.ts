import { stripVTControlCharacters } from 'node:util'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import type * as Scope from 'effect/Scope'
import {
  type BranchState,
  type Canvas,
  type OrbScene,
  type OrbStartScene,
  type QuitGraphics,
  type Scene,
  type SceneShape,
  type TerminalHold,
  ORB_SHAPE,
  ROWS,
  SCAN_SHAPE,
  VANISH_MS,
  deleteImage,
  drawOrb,
  drawOrbStart,
  drawRelease,
  drawSweep,
  encodeFrame,
  fadeAway,
  fitsStrip,
  makeCanvas,
  orbEnd,
  orbStartEnd,
  releaseEnd,
  settleDuration,
  stripColumns,
  toRgba,
} from './quit-scene.ts'
import type { TerminalModule } from './terminal-module.ts'

export type QuitTerminal = Pick<
  TerminalModule,
  'getCapabilities' | 'getCellDimensions' | 'allocateImageId'
>

const FRAME_MS = 16
const HOLD_MS = 250
const NOTHING: SceneShape = { dots: 0, branches: 0 }
const DEFAULT_COLUMNS = 80
const PROGRESS_ACTIVE = '\x1b]9;4;3\x07'
const PROGRESS_KEEPALIVE_FRAMES = 60
const BOTTOM_ROW = `\x1b[${ROWS - 1}B`
const RESERVE_ROWS = `${'\n'.repeat(ROWS)}\x1b[${ROWS}A`
const CLEAR_ROWS = `\x1b8${Array.from({ length: ROWS }, () => '\x1b[2K').join('\x1b[1B')}\x1b8\r`

export const loadQuitGraphics = (
  live: boolean,
  columns: number | undefined,
  hold: TerminalHold,
  terminal: QuitTerminal | undefined
): Effect.Effect<QuitGraphics | undefined> =>
  Effect.sync(() => {
    if (!live || terminal?.getCapabilities().images !== 'kitty') return undefined
    const cell = terminal.getCellDimensions()
    const cellWidth = Math.round(cell.widthPx)
    const cellHeight = Math.round(cell.heightPx)
    if (!(cellWidth > 0 && cellHeight > 0)) return undefined
    return {
      cellWidth,
      cellHeight,
      columns: columns || DEFAULT_COLUMNS,
      allocateImageId: terminal.allocateImageId,
      hold,
    }
  })

export const stripFits = (
  graphics: QuitGraphics | undefined,
  shape: SceneShape,
  labelColumns: number
): graphics is QuitGraphics => graphics !== undefined && fitsStrip(graphics, shape, labelColumns)

interface Strip {
  readonly note: (text: string) => void
  readonly frame: (
    columns: number,
    draw: (canvas: Canvas) => void,
    label: string
  ) => Effect.Effect<void>
  readonly leave: (
    columns: number,
    draw: (canvas: Canvas) => void,
    holdMs: number,
    label: string
  ) => Effect.Effect<void>
}

const openStrip = Effect.fnUntraced(function* (
  out: NodeJS.WritableStream,
  graphics: QuitGraphics
): Effect.fn.Return<Strip, never, Scope.Scope> {
  const heightPx = ROWS * graphics.cellHeight
  let previousId: number | undefined
  let opened = false
  let finished = false
  const close = Effect.sync(() => {
    if (finished) return
    finished = true
    if (!opened) return
    out.write(`${previousId === undefined ? '' : deleteImage(previousId)}${CLEAR_ROWS}\x1b[?25h`)
    graphics.hold.end()
  })
  yield* Effect.addFinalizer(() => close)
  const frame: Strip['frame'] = (columns, draw, label) =>
    Effect.sync(() => {
      if (finished) return
      if (!opened) {
        opened = true
        graphics.hold.begin()
        out.write(`${RESERVE_ROWS}\x1b[?25l\x1b7`)
      }
      const shown =
        columns + 2 + stripVTControlCharacters(label).length <= graphics.columns ? label : ''
      const widthPx = columns * graphics.cellWidth
      const canvas = makeCanvas(widthPx, heightPx)
      draw(canvas)
      const id = graphics.allocateImageId()
      out.write(
        encodeFrame({
          rgba: toRgba(canvas),
          widthPx,
          heightPx,
          columns,
          id,
          ...(previousId === undefined ? {} : { previousId }),
          before: '\x1b8',
          after: `\x1b8${BOTTOM_ROW}\x1b[K${shown.length === 0 ? '' : `\x1b[${columns + 2}C${shown}`}\x1b8`,
        })
      )
      previousId = id
    })
  const note: Strip['note'] = text => {
    if (finished || !opened) {
      out.write(`${text}\n`)
      return
    }
    out.write(
      `${previousId === undefined ? '' : deleteImage(previousId)}${CLEAR_ROWS}${text}\n${RESERVE_ROWS}\x1b7`
    )
    previousId = undefined
  }
  const leave: Strip['leave'] = Effect.fnUntraced(function* (columns, draw, holdMs, label) {
    if (opened) {
      yield* Effect.sleep(holdMs)
      const begun = yield* Clock.currentTimeMillis
      for (;;) {
        const elapsed = Math.min((yield* Clock.currentTimeMillis) - begun, VANISH_MS)
        yield* frame(
          columns,
          canvas => {
            draw(canvas)
            fadeAway(canvas, elapsed)
          },
          label
        )
        if (elapsed >= VANISH_MS) break
        yield* Effect.sleep(FRAME_MS)
      }
    }
    yield* close
  })
  return { note, frame, leave }
})

export interface SweepStrip {
  readonly settle: (shape: SceneShape, label: string) => Effect.Effect<void>
}

export const sweepStrip = Effect.fnUntraced(function* (
  out: NodeJS.WritableStream,
  graphics: QuitGraphics,
  delayMs: number,
  progress: (elapsedMs: number) => string
): Effect.fn.Return<SweepStrip, never, Scope.Scope> {
  const started = yield* Clock.currentTimeMillis
  const strip = yield* openStrip(out, graphics)
  const scanColumns = stripColumns(graphics, SCAN_SHAPE)
  let origin: number | undefined
  const scan = yield* Effect.forkScoped(
    Effect.gen(function* () {
      yield* Effect.sleep(delayMs)
      const shown = yield* Clock.currentTimeMillis
      origin = shown
      for (let index = 0; ; index += 1) {
        const now = yield* Clock.currentTimeMillis
        yield* strip.frame(
          scanColumns,
          canvas => drawSweep(canvas, now - shown),
          progress(now - started)
        )
        if (index % PROGRESS_KEEPALIVE_FRAMES === 0)
          yield* Effect.sync(() => {
            out.write(PROGRESS_ACTIVE)
          })
        yield* Effect.sleep(FRAME_MS)
      }
    }),
    { uninterruptible: false }
  )
  const animate = Effect.fnUntraced(function* (
    columns: number,
    duration: number,
    draw: (canvas: Canvas, at: number, t: number) => void,
    label: string
  ) {
    const begun = origin ?? (yield* Clock.currentTimeMillis)
    const at = (yield* Clock.currentTimeMillis) - begun
    for (;;) {
      const t = Math.min((yield* Clock.currentTimeMillis) - begun, at + duration)
      yield* strip.frame(columns, canvas => draw(canvas, at, t), label)
      if (t >= at + duration) break
      yield* Effect.sleep(FRAME_MS)
    }
    return at
  })
  const settle = Effect.fnUntraced(function* (requested: SceneShape, label: string) {
    yield* Fiber.interrupt(scan)
    if (requested.dots + requested.branches === 0 || !fitsStrip(graphics, requested, 0)) {
      const at = origin === undefined ? 0 : (yield* Clock.currentTimeMillis) - origin
      yield* strip.leave(
        scanColumns,
        canvas => drawSweep(canvas, at, { shape: NOTHING, at }),
        0,
        label
      )
      return
    }
    const columns = Math.max(scanColumns, stripColumns(graphics, requested))
    const duration = settleDuration(requested)
    const draw = (canvas: Canvas, at: number, t: number) =>
      drawSweep(canvas, t, { shape: requested, at })
    const at = yield* animate(columns, duration, draw, label)
    yield* strip.leave(columns, canvas => draw(canvas, at, at + duration), HOLD_MS, label)
  })
  return { settle }
})

interface SceneStrip<S> {
  readonly update: (change: (scene: S, t: number) => S) => Effect.Effect<void>
  readonly note: (text: string) => void
  readonly finish: (summary: string) => Effect.Effect<void>
}

const sceneStrip = Effect.fnUntraced(function* <S>(
  out: NodeJS.WritableStream,
  graphics: QuitGraphics,
  shape: SceneShape,
  initial: S,
  draw: (canvas: Canvas, scene: S, t: number) => void,
  end: (scene: S) => number,
  label: (elapsedMs: number) => string,
  progress: boolean,
  origin?: number
): Effect.fn.Return<SceneStrip<S>, never, Scope.Scope> {
  const started = origin ?? (yield* Clock.currentTimeMillis)
  const strip = yield* openStrip(out, graphics)
  const columns = stripColumns(graphics, shape)
  let scene = initial
  let result: string | undefined
  const render = (t: number) =>
    strip.frame(columns, canvas => draw(canvas, scene, t), result ?? label(t))
  const loop = yield* Effect.forkScoped(
    Effect.gen(function* () {
      for (let index = 0; ; index += 1) {
        yield* render((yield* Clock.currentTimeMillis) - started)
        if (progress && index % PROGRESS_KEEPALIVE_FRAMES === 0)
          yield* Effect.sync(() => {
            out.write(PROGRESS_ACTIVE)
          })
        yield* Effect.sleep(FRAME_MS)
      }
    }),
    { uninterruptible: false }
  )
  const update: SceneStrip<S>['update'] = change =>
    Effect.map(Clock.currentTimeMillis, now => {
      scene = change(scene, now - started)
    })
  const finish: SceneStrip<S>['finish'] = Effect.fnUntraced(function* (summary) {
    result = summary
    for (;;) {
      const t = (yield* Clock.currentTimeMillis) - started
      if (t >= end(scene)) break
      yield* Effect.sleep(FRAME_MS)
    }
    yield* Fiber.interrupt(loop)
    const last = Math.max((yield* Clock.currentTimeMillis) - started, end(scene))
    yield* render(last)
    yield* strip.leave(columns, canvas => draw(canvas, scene, last), HOLD_MS, summary)
  })
  return { update, note: strip.note, finish }
})

export interface ReleaseStrip {
  readonly begin: (index: number) => Effect.Effect<void>
  readonly end: (index: number, merged: boolean) => Effect.Effect<void>
  readonly finish: (label: string) => Effect.Effect<void>
}

export const releaseStrip = Effect.fnUntraced(function* (
  out: NodeJS.WritableStream,
  graphics: QuitGraphics,
  initial: Scene,
  label: (elapsedMs: number) => string
): Effect.fn.Return<ReleaseStrip, never, Scope.Scope> {
  const strip = yield* sceneStrip(
    out,
    graphics,
    { dots: initial.dots, branches: initial.branches.length },
    initial,
    drawRelease,
    releaseEnd,
    label,
    false
  )
  const mark = (index: number, next: (t: number) => BranchState) =>
    strip.update((scene, t) => ({
      dots: scene.dots,
      branches: scene.branches.map((state, i) => (i === index ? next(t) : state)),
    }))
  return {
    begin: index => mark(index, since => ({ kind: 'active', since })),
    end: (index, merged) => mark(index, at => ({ kind: merged ? 'merged' : 'failed', at })),
    finish: strip.finish,
  }
})

export type OrbStrip = SceneStrip<OrbScene>

export const orbStrip = (
  out: NodeJS.WritableStream,
  graphics: QuitGraphics,
  spare: boolean,
  label: (elapsedMs: number) => string
): Effect.Effect<OrbStrip, never, Scope.Scope> =>
  sceneStrip<OrbScene>(
    out,
    graphics,
    ORB_SHAPE,
    { work: { kind: 'returning', since: 0 }, fate: { kind: 'present' }, spare },
    drawOrb,
    orbEnd,
    label,
    true
  )

export type OrbStartStrip = SceneStrip<OrbStartScene>

export const orbStartStrip = (
  out: NodeJS.WritableStream,
  graphics: QuitGraphics,
  scene: OrbStartScene,
  origin: number,
  label: (elapsedMs: number) => string
): Effect.Effect<OrbStartStrip, never, Scope.Scope> =>
  sceneStrip(out, graphics, ORB_SHAPE, scene, drawOrbStart, orbStartEnd, label, true, origin)
