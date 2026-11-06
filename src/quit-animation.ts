import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Clock, Effect, Fiber, type Scope } from 'effect'
import type * as TerminalImage from '../node_modules/@earendil-works/pi-tui/dist/terminal-image.js'
import {
  type BranchState,
  type Canvas,
  type QuitGraphics,
  type Scene,
  type SceneShape,
  ROWS,
  SCAN_SHAPE,
  VANISH_MS,
  deleteImage,
  drawRelease,
  drawSweep,
  drawVanish,
  encodeFrame,
  fitsStrip,
  makeCanvas,
  releaseEnd,
  settleDuration,
  stripColumns,
  toRgba,
} from './quit-scene.ts'

const FRAME_MS = 16
const DEFAULT_COLUMNS = 80
const PROGRESS_ACTIVE = '\x1b]9;4;3\x07'
const PROGRESS_KEEPALIVE_FRAMES = 60

export const loadQuitGraphics = (
  packageRoot: string,
  live: boolean,
  columns: number | undefined
): Effect.Effect<QuitGraphics | undefined> => {
  if (!live) return Effect.undefined
  return Effect.tryPromise(
    (): Promise<typeof TerminalImage> =>
      import(pathToFileURL(join(packageRoot, '../pi-tui/dist/terminal-image.js')).href)
  ).pipe(
    Effect.map((images): QuitGraphics | undefined => {
      if (images.getCapabilities().images !== 'kitty') return undefined
      const cell = images.getCellDimensions()
      const cellWidth = Math.round(cell.widthPx)
      const cellHeight = Math.round(cell.heightPx)
      if (!(cellWidth > 0 && cellHeight > 0)) return undefined
      return {
        cellWidth,
        cellHeight,
        columns: columns || DEFAULT_COLUMNS,
        allocateImageId: images.allocateImageId,
      }
    }),
    Effect.orElseSucceed(() => undefined)
  )
}

export const stripFits = (
  graphics: QuitGraphics | undefined,
  shape: SceneShape,
  labelColumns: number
): graphics is QuitGraphics => graphics !== undefined && fitsStrip(graphics, shape, labelColumns)

interface Strip {
  readonly frame: (
    columns: number,
    draw: (canvas: Canvas) => void,
    label: string
  ) => Effect.Effect<void>
  readonly opened: () => boolean
  readonly finish: Effect.Effect<void>
  readonly vanish: Effect.Effect<void>
}

const openStrip = Effect.fnUntraced(function* (
  out: NodeJS.WritableStream,
  graphics: QuitGraphics
): Effect.fn.Return<Strip, never, Scope.Scope> {
  const heightPx = ROWS * graphics.cellHeight
  let previousId: number | undefined
  let opened = false
  let finished = false
  const close = (restore: string) =>
    Effect.sync(() => {
      if (finished) return
      finished = true
      if (opened) out.write(restore)
    })
  const finish = close(`\x1b8\x1b[K\x1b[${ROWS}B\r\x1b[?25h`)
  yield* Effect.addFinalizer(() => finish)
  const frame: Strip['frame'] = (columns, draw, label) =>
    Effect.sync(() => {
      if (finished) return
      if (!opened) {
        opened = true
        out.write(`${'\n'.repeat(ROWS)}\x1b[${ROWS}A\x1b[?25l\x1b7`)
      }
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
          after: `\x1b8\x1b[K${label.length === 0 ? '' : `\x1b[${columns + 2}C${label}`}\x1b8`,
        })
      )
      previousId = id
    })
  const vanish = Effect.suspend(() =>
    close(`${previousId === undefined ? '' : deleteImage(previousId)}\x1b8\x1b[K\r\x1b[?25h`)
  )
  return { frame, opened: () => opened, finish, vanish }
})

export interface SweepStrip {
  readonly settle: (shape: SceneShape) => Effect.Effect<void>
}

export const sweepStrip = Effect.fnUntraced(function* (
  out: NodeJS.WritableStream,
  graphics: QuitGraphics,
  delayMs: number,
  label: (elapsedMs: number) => string
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
          label(now - started)
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
    draw: (canvas: Canvas, at: number, t: number) => void
  ) {
    const begun = origin ?? (yield* Clock.currentTimeMillis)
    const at = (yield* Clock.currentTimeMillis) - begun
    for (;;) {
      const t = Math.min((yield* Clock.currentTimeMillis) - begun, at + duration)
      yield* strip.frame(columns, canvas => draw(canvas, at, t), '')
      if (t >= at + duration) break
      yield* Effect.sleep(FRAME_MS)
    }
  })
  const settle = Effect.fnUntraced(function* (requested: SceneShape) {
    yield* Fiber.interrupt(scan)
    if (requested.dots + requested.branches === 0 || !fitsStrip(graphics, requested, 0)) {
      if (strip.opened()) yield* animate(scanColumns, VANISH_MS, drawVanish)
      yield* strip.vanish
      return
    }
    yield* animate(
      Math.max(scanColumns, stripColumns(graphics, requested)),
      settleDuration(requested),
      (canvas, at, t) => drawSweep(canvas, t, { shape: requested, at })
    )
    yield* strip.finish
  })
  return { settle }
})

export interface ReleaseStrip {
  readonly begin: (index: number) => Effect.Effect<void>
  readonly end: (index: number, merged: boolean) => Effect.Effect<void>
  readonly finish: Effect.Effect<void>
}

export const releaseStrip = Effect.fnUntraced(function* (
  out: NodeJS.WritableStream,
  graphics: QuitGraphics,
  initial: Scene,
  label: (elapsedMs: number) => string
): Effect.fn.Return<ReleaseStrip, never, Scope.Scope> {
  const started = yield* Clock.currentTimeMillis
  const strip = yield* openStrip(out, graphics)
  const columns = stripColumns(graphics, { dots: initial.dots, branches: initial.branches.length })
  const states: BranchState[] = [...initial.branches]
  let releasing = true
  const sceneNow = (): Scene => ({ dots: initial.dots, branches: states })
  const render = (t: number) =>
    strip.frame(columns, canvas => drawRelease(canvas, sceneNow(), t), releasing ? label(t) : '')
  const loop = yield* Effect.forkScoped(
    Effect.gen(function* () {
      for (;;) {
        yield* render((yield* Clock.currentTimeMillis) - started)
        yield* Effect.sleep(FRAME_MS)
      }
    }),
    { uninterruptible: false }
  )
  const mark = (index: number, next: (t: number) => BranchState) =>
    Effect.gen(function* () {
      const t = (yield* Clock.currentTimeMillis) - started
      yield* Effect.sync(() => {
        states[index] = next(t)
      })
    })
  const begin: ReleaseStrip['begin'] = index => mark(index, since => ({ kind: 'active', since }))
  const end: ReleaseStrip['end'] = (index, merged) =>
    mark(index, at => ({ kind: merged ? 'merged' : 'failed', at }))
  const finish = Effect.gen(function* () {
    releasing = false
    for (;;) {
      const t = (yield* Clock.currentTimeMillis) - started
      if (t >= releaseEnd(sceneNow())) break
      yield* Effect.sleep(FRAME_MS)
    }
    yield* Fiber.interrupt(loop)
    yield* render(Math.max((yield* Clock.currentTimeMillis) - started, releaseEnd(sceneNow())))
    yield* strip.finish
  })
  return { begin, end, finish }
})
