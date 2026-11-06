import { deflateSync } from 'node:zlib'

export const ROWS = 2

export interface QuitGraphics {
  readonly cellWidth: number
  readonly cellHeight: number
  readonly columns: number
  readonly allocateImageId: () => number
}

export interface SceneShape {
  readonly dots: number
  readonly branches: number
}

export type BranchState =
  | { readonly kind: 'waiting' }
  | { readonly kind: 'active'; readonly since: number }
  | { readonly kind: 'merged'; readonly at: number }
  | { readonly kind: 'failed'; readonly at: number }

export interface Scene {
  readonly dots: number
  readonly branches: readonly BranchState[]
}

export interface Settled {
  readonly shape: SceneShape
  readonly at: number
}

export interface Canvas {
  readonly width: number
  readonly height: number
  readonly px: Float32Array
}

type Rgb = readonly [number, number, number]
type Point = readonly [number, number]
type Shade = (x: number, y: number) => readonly [Rgb, number]

export const SETTLED_AT = -1_000_000
export const SCAN_SHAPE: SceneShape = { dots: 2, branches: 2 }

const WAITING = 0.6
const STAGGER = 60
const SCAN_PERIOD = 1100
const SCAN_DRAW_MS = 320
export const VANISH_MS = 180
const PULSE_PERIOD = 820
const SLIDE_MS = 420
const RING_MS = 460
const FINALE_MS = 520
const FINALE_GAP = 60
const FAILED_TAIL = 360

const bezier = (x1: number, y1: number, x2: number, y2: number) => {
  const cx = (t: number): number => 3 * x1 * t * (1 - t) ** 2 + 3 * x2 * t * t * (1 - t) + t ** 3
  const cy = (t: number): number => 3 * y1 * t * (1 - t) ** 2 + 3 * y2 * t * t * (1 - t) + t ** 3
  return (x: number): number => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    let lo = 0
    let hi = 1
    let t = x
    for (let step = 0; step < 30; step += 1) {
      t = (lo + hi) / 2
      if (cx(t) < x) lo = t
      else hi = t
    }
    return cy(t)
  }
}

export const easeOut = bezier(0.23, 1, 0.32, 1)
export const easeInOut = bezier(0.77, 0, 0.175, 1)
const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))
const progress = (t: number, start: number, duration: number): number =>
  clamp01((t - start) / duration)
const mix = (a: number, b: number, k: number): number => a + (b - a) * k

export const spring = (t: number, from: number, duration: number): number => {
  if (t <= 0) return from
  if (t >= duration) return 1
  const k = t / duration
  return 1 - (1 - from) * Math.exp(-5 * k) * Math.cos(2 * Math.PI * 1.15 * k)
}

const hex = (value: string): Rgb => [
  parseInt(value.slice(1, 3), 16) / 255,
  parseInt(value.slice(3, 5), 16) / 255,
  parseInt(value.slice(5, 7), 16) / 255,
]

export const PALETTE = {
  green: hex('#3FB950'),
  purple: hex('#A371F7'),
  gray: hex('#8B949E'),
  red: hex('#F85149'),
  white: hex('#F0F6FC'),
}

export const makeCanvas = (width: number, height: number): Canvas => ({
  width,
  height,
  px: new Float32Array(width * height * 4),
})

const blend = (canvas: Canvas, x: number, y: number, rgb: Rgb, alpha: number): void => {
  if (alpha <= 0.002) return
  const i = (y * canvas.width + x) * 4
  const p = canvas.px
  const inverse = 1 - alpha
  p[i] = rgb[0] * alpha + (p[i] ?? 0) * inverse
  p[i + 1] = rgb[1] * alpha + (p[i + 1] ?? 0) * inverse
  p[i + 2] = rgb[2] * alpha + (p[i + 2] ?? 0) * inverse
  p[i + 3] = alpha + (p[i + 3] ?? 0) * inverse
}

const fill = (
  canvas: Canvas,
  box: readonly [number, number, number, number],
  sdf: (x: number, y: number) => number,
  shade: Shade
): void => {
  const x0 = Math.max(0, Math.floor(box[0]))
  const y0 = Math.max(0, Math.floor(box[1]))
  const x1 = Math.min(canvas.width - 1, Math.ceil(box[2]))
  const y1 = Math.min(canvas.height - 1, Math.ceil(box[3]))
  for (let y = y0; y <= y1; y += 1)
    for (let x = x0; x <= x1; x += 1) {
      const px = x + 0.5
      const py = y + 0.5
      const cover = clamp01(0.5 - sdf(px, py))
      if (cover <= 0) continue
      const [rgb, alpha] = shade(px, py)
      blend(canvas, x, y, rgb, alpha * cover)
    }
}

const solid =
  (rgb: Rgb, alpha: number): Shade =>
  () => [rgb, alpha]

const circle = (
  canvas: Canvas,
  cx: number,
  cy: number,
  radius: number,
  rgb: Rgb,
  alpha: number
): void =>
  fill(
    canvas,
    [cx - radius - 1, cy - radius - 1, cx + radius + 1, cy + radius + 1],
    (x, y) => Math.hypot(x - cx, y - cy) - radius,
    solid(rgb, alpha)
  )

const ring = (
  canvas: Canvas,
  cx: number,
  cy: number,
  radius: number,
  width: number,
  rgb: Rgb,
  alpha: number
): void =>
  fill(
    canvas,
    [cx - radius - width, cy - radius - width, cx + radius + width, cy + radius + width],
    (x, y) => Math.abs(Math.hypot(x - cx, y - cy) - radius) - width / 2,
    solid(rgb, alpha)
  )

const segmentDistance = (
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number => {
  const dx = bx - ax
  const dy = by - ay
  const length2 = dx * dx + dy * dy || 1
  const t = clamp01(((px - ax) * dx + (py - ay) * dy) / length2)
  return Math.hypot(px - ax - t * dx, py - ay - t * dy)
}

const polyline = (
  canvas: Canvas,
  points: readonly Point[],
  width: number,
  rgb: Rgb,
  alpha: number
): void => {
  const coverage = new Map<number, number>()
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1] as Point
    const b = points[i] as Point
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0]) - width))
    const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1]) - width))
    const x1 = Math.min(canvas.width - 1, Math.ceil(Math.max(a[0], b[0]) + width))
    const y1 = Math.min(canvas.height - 1, Math.ceil(Math.max(a[1], b[1]) + width))
    for (let y = y0; y <= y1; y += 1)
      for (let x = x0; x <= x1; x += 1) {
        const distance = segmentDistance(x + 0.5, y + 0.5, a[0], a[1], b[0], b[1]) - width / 2
        const cover = clamp01(0.5 - distance)
        if (cover <= 0) continue
        const index = y * canvas.width + x
        coverage.set(index, Math.max(coverage.get(index) ?? 0, cover))
      }
  }
  for (const [index, cover] of coverage)
    blend(canvas, index % canvas.width, Math.floor(index / canvas.width), rgb, alpha * cover)
}

const subPath = (points: readonly Point[], from: number, to: number): readonly Point[] => {
  if (to - from < 0.0001) return []
  const lengths = [0]
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1] as Point
    const b = points[i] as Point
    lengths.push((lengths[i - 1] ?? 0) + Math.hypot(b[0] - a[0], b[1] - a[1]))
  }
  const total = lengths[lengths.length - 1] ?? 1
  const at = (fraction: number): Point => {
    const target = fraction * total
    let i = 1
    while (i < points.length - 1 && (lengths[i] ?? 0) < target) i += 1
    const a = points[i - 1] as Point
    const b = points[i] as Point
    const before = lengths[i - 1] ?? 0
    const k = (target - before) / ((lengths[i] ?? 0) - before || 1)
    return [mix(a[0], b[0], k), mix(a[1], b[1], k)]
  }
  const out: Point[] = [at(from)]
  for (let i = 1; i < points.length - 1; i += 1) {
    const fraction = (lengths[i] ?? 0) / total
    if (fraction > from && fraction < to) out.push(points[i] as Point)
  }
  out.push(at(to))
  return out
}

const pointAt = (points: readonly Point[], fraction: number): Point => {
  const path = subPath(points, 0, Math.max(fraction, 0.0001))
  return path[path.length - 1] ?? (points[0] as Point)
}

const cubic = (p0: Point, p1: Point, p2: Point, p3: Point, steps = 28): readonly Point[] =>
  Array.from({ length: steps + 1 }, (_, i): Point => {
    const t = i / steps
    const u = 1 - t
    const axis = (k: 0 | 1): number =>
      u ** 3 * p0[k] + 3 * u * u * t * p1[k] + 3 * u * t * t * p2[k] + t ** 3 * p3[k]
    return [axis(0), axis(1)]
  })

interface Layout {
  readonly left: number
  readonly mainY: number
  readonly dots: readonly number[]
  readonly branches: readonly (readonly Point[])[]
  readonly lineEnd: number
  readonly width: number
}

const layout = (H: number, shape: SceneShape): Layout => {
  const left = 0.3 * H
  const mainY = 0.7 * H
  const nodeY = 0.22 * H
  const dots = Array.from({ length: shape.dots }, (_, j) => left + 0.3 * H + j * 0.5 * H)
  const lastDot = dots[dots.length - 1]
  const branchStart = lastDot === undefined ? left + 0.15 * H : lastDot + 0.45 * H
  const branches = Array.from({ length: shape.branches }, (_, i) => {
    const nx = branchStart + i * 1.3 * H
    return cubic([nx, nodeY], [nx + 0.42 * H, nodeY], [nx + 0.5 * H, mainY], [nx + 0.86 * H, mainY])
  })
  const lastBranch = branches[branches.length - 1]
  const lastX = lastBranch
    ? (lastBranch[lastBranch.length - 1] as Point)[0]
    : (lastDot ?? left + 0.4 * H)
  const lineEnd = lastX + 0.9 * H
  return { left, mainY, dots, branches, lineEnd, width: lineEnd + 0.2 * H }
}

export const stripColumns = (graphics: QuitGraphics, shape: SceneShape): number =>
  Math.ceil(layout(ROWS * graphics.cellHeight, shape).width / graphics.cellWidth)

export const fitsStrip = (
  graphics: QuitGraphics,
  shape: SceneShape,
  labelColumns: number
): boolean => stripColumns(graphics, shape) + 2 + labelColumns <= graphics.columns

const mainLine = (
  canvas: Canvas,
  L: Layout,
  to: number,
  end: number,
  rgb: Rgb,
  alpha: number
): void => {
  const H = canvas.height
  const w = 0.07 * H
  if (to <= L.left) return
  fill(
    canvas,
    [L.left - w, L.mainY - w, to + w, L.mainY + w],
    (x, y) => Math.max(Math.abs(y - L.mainY) - w / 2, L.left - x, x - to),
    x => [rgb, alpha * clamp01((end - x) / (0.6 * H))]
  )
}

const dotAt = (canvas: Canvas, L: Layout, j: number, scale: number): void => {
  if (scale <= 0) return
  circle(
    canvas,
    L.dots[j] ?? 0,
    L.mainY,
    0.13 * canvas.height * scale,
    PALETTE.green,
    clamp01(scale * 1.4)
  )
}

const shake = (since: number, amplitude: number): number =>
  since < FAILED_TAIL ? Math.sin(since / 18) * amplitude * (1 - since / FAILED_TAIL) : 0

export const settleDuration = (shape: SceneShape): number =>
  STAGGER * (shape.dots + shape.branches) + 420

const scanReach = (scan: Layout, t: number): number =>
  mix(scan.left, scan.lineEnd, easeOut(progress(t, 0, SCAN_DRAW_MS)))

export const drawSweep = (canvas: Canvas, t: number, settled?: Settled): void => {
  const H = canvas.height
  const scan = layout(H, SCAN_SHAPE)
  const drawn = scanReach(scan, t)
  if (settled === undefined) {
    mainLine(canvas, scan, drawn, scan.lineEnd, PALETTE.gray, 0.55)
    const f = (t % SCAN_PERIOD) / SCAN_PERIOD
    const x = mix(scan.left, scan.lineEnd - 0.4 * H, f)
    const a = Math.sin(Math.PI * f)
    circle(canvas, x, scan.mainY, 0.14 * H, PALETTE.white, 0.16 * a)
    circle(canvas, x, scan.mainY, 0.06 * H, PALETTE.white, 0.95 * a)
    return
  }
  const L = layout(H, settled.shape)
  const s = t - settled.at
  const extend = easeOut(progress(s, 0, 340))
  const end = mix(scan.lineEnd, L.lineEnd, extend)
  const startedAt = scanReach(scan, settled.at)
  mainLine(canvas, L, mix(startedAt, end, extend), end, PALETTE.gray, 0.55)
  L.dots.forEach((_, j) => {
    const local = s - j * STAGGER
    dotAt(canvas, L, j, local < 0 ? 0 : spring(local, 0.6, 380))
  })
  L.branches.forEach((path, i) => {
    const local = s - (settled.shape.dots + i) * STAGGER
    if (local < 0) return
    const grown = easeOut(progress(local, 0, 340))
    polyline(canvas, subPath(path, 1 - grown, 1), 0.065 * H, PALETTE.purple, WAITING)
    const head = path[0] as Point
    if (grown > 0.8)
      circle(
        canvas,
        head[0],
        head[1],
        0.15 * H * spring(local - 270, 0.7, 380),
        PALETTE.purple,
        WAITING
      )
  })
}

export const fadeAway = (canvas: Canvas, elapsed: number): void => {
  const k = easeOut(progress(elapsed, 0, VANISH_MS))
  const cutoff = canvas.width * (1 - 0.7 * k)
  const edge = 0.3 * canvas.height
  const p = canvas.px
  for (let y = 0; y < canvas.height; y += 1)
    for (let x = 0; x < canvas.width; x += 1) {
      const keep = clamp01((cutoff - x) / edge) * (1 - k)
      const i = (y * canvas.width + x) * 4
      for (let c = 0; c < 4; c += 1) p[i + c] = (p[i + c] ?? 0) * keep
    }
}

const settledTimes = (scene: Scene): readonly number[] =>
  scene.branches.flatMap(branch =>
    branch.kind === 'merged' || branch.kind === 'failed' ? [branch.at] : []
  )

const finaleStart = (scene: Scene): number | undefined =>
  scene.branches.length > 0 && scene.branches.every(branch => branch.kind === 'merged')
    ? Math.max(...settledTimes(scene)) + SLIDE_MS + FINALE_GAP
    : undefined

export const releaseEnd = (scene: Scene): number => {
  const finale = finaleStart(scene)
  if (finale !== undefined) return finale + FINALE_MS + FINALE_GAP
  return Math.max(
    0,
    ...scene.branches.map(branch => {
      if (branch.kind === 'merged') return branch.at + SLIDE_MS + RING_MS
      if (branch.kind === 'failed') return branch.at + FAILED_TAIL
      return 0
    })
  )
}

export const drawRelease = (canvas: Canvas, scene: Scene, t: number): void => {
  const H = canvas.height
  const L = layout(H, { dots: scene.dots, branches: scene.branches.length })
  mainLine(canvas, L, L.lineEnd, L.lineEnd, PALETTE.gray, 0.55)
  const finale = finaleStart(scene)
  if (finale !== undefined && t >= finale) {
    const f = easeInOut(progress(t, finale, FINALE_MS))
    mainLine(canvas, L, mix(L.left, L.lineEnd, f), L.lineEnd, PALETTE.green, 0.9)
  }
  L.dots.forEach((_, j) => dotAt(canvas, L, j, 1))
  L.branches.forEach((path, i) => {
    const state = scene.branches[i] ?? { kind: 'waiting' }
    const head = path[0] as Point
    const merge = path[path.length - 1] as Point
    if (state.kind !== 'merged') {
      const active = state.kind === 'active'
      const failed = state.kind === 'failed'
      const color = failed ? PALETTE.red : PALETTE.purple
      const alpha = active || failed ? 1 : WAITING
      const dx = failed ? shake(t - state.at, 0.07 * H) : 0
      polyline(
        canvas,
        path.map((point): Point => [point[0] + dx, point[1]]),
        0.065 * H,
        color,
        alpha
      )
      circle(canvas, head[0] + dx, head[1], 0.15 * H, color, alpha)
      if (active) {
        const [px, py] = pointAt(path, Math.max(0, (t - state.since) % PULSE_PERIOD) / PULSE_PERIOD)
        circle(canvas, px, py, 0.13 * H, PALETTE.white, 0.18)
        circle(canvas, px, py, 0.065 * H, PALETTE.white, 0.95)
      }
      return
    }
    const since = t - state.at
    const k = easeInOut(progress(since, 0, SLIDE_MS))
    if (k < 1) {
      polyline(canvas, subPath(path, k, 1), 0.065 * H, PALETTE.purple, 1)
      const [px, py] = pointAt(path, k)
      circle(canvas, px, py, mix(0.15, 0.12, k) * H, PALETTE.purple, 1)
    }
    const landed = since - SLIDE_MS
    if (landed >= 0) {
      const r = easeOut(progress(landed, 0, RING_MS))
      if (r < 1)
        ring(
          canvas,
          merge[0],
          merge[1],
          mix(0.12, 0.3, r) * H,
          0.045 * H,
          PALETTE.green,
          0.85 * (1 - r)
        )
      circle(canvas, merge[0], merge[1], 0.13 * H * spring(landed, 0.7, SLIDE_MS), PALETTE.green, 1)
    }
  })
}

export const toRgba = (canvas: Canvas): Buffer => {
  const out = Buffer.alloc(canvas.width * canvas.height * 4)
  for (let i = 0; i < canvas.width * canvas.height; i += 1) {
    const alpha = canvas.px[i * 4 + 3] ?? 0
    out[i * 4 + 3] = Math.round(alpha * 255)
    if (alpha > 0)
      for (let k = 0; k < 3; k += 1)
        out[i * 4 + k] = Math.round(clamp01((canvas.px[i * 4 + k] ?? 0) / alpha) * 255)
  }
  return out
}

const SYNC_BEGIN = '\x1b[?2026h'
const SYNC_END = '\x1b[?2026l'
const CHUNK = 4096

export interface KittyFrame {
  readonly rgba: Buffer
  readonly widthPx: number
  readonly heightPx: number
  readonly columns: number
  readonly id: number
  readonly previousId?: number
  readonly before: string
  readonly after: string
}

export const deleteImage = (id: number): string => `\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`

export const encodeFrame = (frame: KittyFrame): string => {
  const data = deflateSync(frame.rgba, { level: 1 }).toString('base64')
  let chunks = ''
  for (let i = 0; i < data.length; i += CHUNK) {
    const more = i + CHUNK < data.length ? 1 : 0
    const head =
      i === 0
        ? `a=T,f=32,o=z,s=${frame.widthPx},v=${frame.heightPx},i=${frame.id},p=1,c=${frame.columns},r=${ROWS},C=1,q=2,m=${more}`
        : `m=${more}`
    chunks += `\x1b_G${head};${data.slice(i, i + CHUNK)}\x1b\\`
  }
  const removal = frame.previousId === undefined ? '' : deleteImage(frame.previousId)
  return `${SYNC_BEGIN}${frame.before}${chunks}${removal}${frame.after}${SYNC_END}`
}
