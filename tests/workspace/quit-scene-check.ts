import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { inflateSync } from 'node:zlib'
import { Effect } from 'effect'
import { loadQuitGraphics } from '../../src/quit-animation.ts'
import { releaseIndicator, sweepIndicator, terminalStyle } from '../../src/quit-display.ts'
import {
  type BranchState,
  type QuitGraphics,
  type Scene,
  type SceneShape,
  ROWS,
  SETTLED_AT,
  VANISH_MS,
  drawRelease,
  drawSweep,
  encodeFrame,
  fadeAway,
  fitsStrip,
  makeCanvas,
  releaseEnd,
  settleDuration,
  stripColumns,
  toRgba,
} from '../../src/quit-scene.ts'
import { makeClaims } from './workspace-check-support.ts'

const { claim, passed } = makeClaims()

const graphics: QuitGraphics = {
  cellWidth: 16,
  cellHeight: 34,
  columns: 160,
  allocateImageId: (() => {
    let next = 100
    return () => (next += 1)
  })(),
}
const H = ROWS * graphics.cellHeight
const live = terminalStyle({ isTTY: true }, {})

const load = (packageRoot: string, isLive = true, ...columns: [number?]) =>
  Effect.runPromise(loadQuitGraphics(packageRoot, isLive, columns.length === 0 ? 120 : columns[0]))

const collector = () => {
  const chunks: string[] = []
  const frameTimes: number[] = []
  const stream = new Writable({
    write(chunk, _encoding, done) {
      const text = String(chunk)
      chunks.push(text)
      if (text.includes('\x1b[?2026h')) frameTimes.push(performance.now())
      done()
    },
  })
  return { stream, text: () => chunks.join(''), chunks, frameTimes }
}

const assertHoldsThenLeaves = (frameTimes: readonly number[]) => {
  const gaps = frameTimes.slice(1).map((time, index) => time - (frameTimes[index] ?? time))
  const longest = Math.max(...gaps)
  const fadeFrames = frameTimes.length - 1 - gaps.indexOf(longest)
  assert.ok(longest >= 240, `the final frame held for ${longest} ms`)
  assert.ok(fadeFrames >= 2 && fadeFrames <= 14, `${fadeFrames} frames after the hold`)
}

const pixel = (scene: Scene, t: number, x: number, y: number) => {
  const canvas = makeCanvas(
    stripColumns(graphics, { dots: scene.dots, branches: scene.branches.length }) *
      graphics.cellWidth,
    H
  )
  drawRelease(canvas, scene, t)
  const rgba = toRgba(canvas)
  const at = (Math.round(y) * canvas.width + Math.round(x)) * 4
  return { r: rgba[at] ?? 0, g: rgba[at + 1] ?? 0, b: rgba[at + 2] ?? 0, a: rgba[at + 3] ?? 0 }
}

const hues = (scene: Scene, t: number) => {
  const canvas = makeCanvas(
    stripColumns(graphics, { dots: scene.dots, branches: scene.branches.length }) *
      graphics.cellWidth,
    H
  )
  drawRelease(canvas, scene, t)
  const rgba = toRgba(canvas)
  let red = 0
  let purpleAlpha = 0
  const counts = new Map<number, number>()
  for (let i = 0; i < rgba.length; i += 4) {
    const [r, g, b, a] = [rgba[i] ?? 0, rgba[i + 1] ?? 0, rgba[i + 2] ?? 0, rgba[i + 3] ?? 0]
    if (r > 200 && g < 120 && b < 120 && a > 200) red += 1
    if (b > 200 && r > 130 && r < 200 && g < 150) {
      purpleAlpha = Math.max(purpleAlpha, a)
      counts.set(a, (counts.get(a) ?? 0) + 1)
    }
  }
  const common = [...counts].toSorted((x, y) => y[1] - x[1])[0]?.[0] ?? 0
  return { red, purpleAlpha, common }
}

const merged: BranchState = { kind: 'merged', at: SETTLED_AT }
const lineStartX = 0.35 * H
const mainY = 0.7 * H

await claim('a fully merged scene ends with the main line green', () => {
  const scene: Scene = { dots: 2, branches: [merged, merged, merged] }
  const end = releaseEnd({
    dots: 2,
    branches: [
      { kind: 'merged', at: 100 },
      { kind: 'merged', at: 900 },
      { kind: 'merged', at: 1700 },
    ],
  })
  assert.ok(end > 1700 + 420 + 60 + 520)
  const finalFrame = pixel(
    { dots: 2, branches: [100, 900, 1700].map(at => ({ kind: 'merged', at })) },
    end,
    lineStartX,
    mainY
  )
  assert.ok(
    finalFrame.g > 140 && finalFrame.r < 110 && finalFrame.a > 200,
    JSON.stringify(finalFrame)
  )
  const beforeFinale = pixel(scene, 0, lineStartX, mainY)
  assert.ok(beforeFinale.g > 140 && beforeFinale.r < 110, JSON.stringify(beforeFinale))
  const waiting = pixel(
    { dots: 2, branches: [{ kind: 'waiting' }, merged, merged] },
    0,
    lineStartX,
    mainY
  )
  assert.ok(
    Math.abs(waiting.r - waiting.b) < 40 && waiting.a > 80 && waiting.a < 200,
    JSON.stringify(waiting)
  )
  assert.equal(hues(scene, 0).red, 0)
})

await claim('a failed branch is red and blocks the finale', () => {
  const states: BranchState[] = [
    { kind: 'merged', at: 100 },
    { kind: 'merged', at: 900 },
    { kind: 'failed', at: 1700 },
  ]
  const scene: Scene = { dots: 2, branches: states }
  const t = releaseEnd(scene) + 1000
  assert.ok(hues(scene, t).red > 50)
  const line = pixel(scene, t, lineStartX, mainY)
  assert.ok(Math.abs(line.r - line.b) < 40, JSON.stringify(line))
})

await claim('waiting branches are drawn at 0.6 opacity', () => {
  const scene: Scene = { dots: 0, branches: [{ kind: 'waiting' }, { kind: 'waiting' }] }
  const alpha = hues(scene, 0).common
  assert.ok(Math.abs(alpha - 0.6 * 255) <= 4, String(alpha))
  const active: Scene = { dots: 0, branches: [{ kind: 'active', since: 0 }, { kind: 'waiting' }] }
  assert.equal(hues(active, 10).purpleAlpha, 255)
})

await claim('the sweep settles to waiting branches and green dots', () => {
  const shape = { dots: 1, branches: 2 }
  const width = stripColumns(graphics, shape) * graphics.cellWidth
  const scanning = makeCanvas(width, H)
  drawSweep(scanning, 500)
  const settled = makeCanvas(width, H)
  drawSweep(settled, 2000 + settleDuration(shape), { shape, at: 2000 })
  const rgba = toRgba(settled)
  let green = 0
  let purple = 0
  for (let i = 0; i < rgba.length; i += 4) {
    if ((rgba[i + 1] ?? 0) > 150 && (rgba[i] ?? 0) < 110 && (rgba[i + 3] ?? 0) > 200) green += 1
    if ((rgba[i + 2] ?? 0) > 200 && (rgba[i] ?? 0) > 130 && (rgba[i + 3] ?? 0) > 100) purple += 1
  }
  assert.ok(green > 100 && purple > 100, `${green} ${purple}`)
  assert.notDeepEqual(toRgba(scanning), rgba)
})

await claim('a leaving strip retracts toward the left and fades to nothing', () => {
  const shape = { dots: 2, branches: 1 }
  const width = stripColumns(graphics, shape) * graphics.cellWidth
  const coverage = (elapsed: number) => {
    const canvas = makeCanvas(width, H)
    drawSweep(canvas, 1000 + settleDuration(shape), { shape, at: 1000 })
    fadeAway(canvas, elapsed)
    const rgba = toRgba(canvas)
    let alpha = 0
    let reach = 0
    for (let i = 3; i < rgba.length; i += 4) {
      alpha += rgba[i] ?? 0
      if ((rgba[i] ?? 0) > 0) reach = Math.max(reach, ((i - 3) / 4) % width)
    }
    return { alpha, reach }
  }
  const start = coverage(0)
  const middle = coverage(VANISH_MS / 3)
  assert.ok(start.alpha > 0)
  assert.ok(middle.alpha < start.alpha / 2, `${middle.alpha} ${start.alpha}`)
  assert.ok(middle.reach < start.reach, `${middle.reach} ${start.reach}`)
  assert.deepEqual(coverage(VANISH_MS), { alpha: 0, reach: 0 })
})

await claim(
  'kitty frames are chunked, placed without cursor movement and replace the previous',
  () => {
    const rgba = randomBytes(40_000)
    const text = encodeFrame({
      rgba,
      widthPx: 100,
      heightPx: 100,
      columns: 7,
      id: 55,
      previousId: 54,
      before: '<before>',
      after: '<after>',
    })
    assert.ok(text.startsWith('\x1b[?2026h<before>'))
    assert.ok(text.endsWith('<after>\x1b[?2026l'))
    const sequences = text
      .split('\x1b_G')
      .slice(1)
      .filter(part => !part.startsWith('a=d'))
      .map(part => {
        const body = part.slice(0, part.indexOf('\x1b\\'))
        return [body, body.slice(0, body.indexOf(';')), body.slice(body.indexOf(';') + 1)] as const
      })
    assert.ok(sequences.length > 2)
    sequences.forEach(([, keys, data], index) => {
      assert.ok(data.length <= 4096)
      assert.ok(keys.endsWith(index === sequences.length - 1 ? 'm=0' : 'm=1'), keys)
      if (index > 0) assert.equal(keys, keys.slice(keys.indexOf('m=')))
    })
    assert.deepEqual(
      inflateSync(Buffer.from(sequences.map(([, , data]) => data).join(''), 'base64')),
      rgba
    )
    const first = sequences[0]?.[1] ?? ''
    for (const key of [
      'a=T',
      'f=32',
      'o=z',
      's=100',
      'v=100',
      'i=55',
      'p=1',
      'c=7',
      'r=2',
      'C=1',
      'q=2',
    ])
      assert.ok(first.split(',').includes(key), `${key} in ${first}`)
    const remove = '\x1b_Ga=d,d=I,i=54,q=2\x1b\\'
    const lastChunk = sequences.at(-1)?.[0] ?? ''
    assert.ok(text.indexOf(remove) >= text.indexOf(lastChunk) + lastChunk.length + 2)
    assert.ok(text.indexOf(remove) < text.indexOf('<after>'))
    assert.ok(
      !encodeFrame({
        rgba,
        widthPx: 100,
        heightPx: 100,
        columns: 7,
        id: 1,
        before: '',
        after: '',
      }).includes('a=d')
    )
  }
)

await claim('graphics need a live terminal, kitty support and room for the strip', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dev-quit-scene-'))
  try {
    const stub = (images: string | null, cell: string) => {
      const piRoot = join(root, `${String(images)}-${cell}`, 'pi-coding-agent')
      const tui = join(piRoot, '../pi-tui/dist')
      mkdirSync(tui, { recursive: true })
      writeFileSync(
        join(tui, 'terminal-image.js'),
        `export const getCapabilities = () => ({ images: ${JSON.stringify(images)} })\nexport const getCellDimensions = () => (${cell})\nexport const allocateImageId = () => 7\n`
      )
      return piRoot
    }
    const kitty = stub('kitty', '{ widthPx: 9, heightPx: 18 }')
    assert.deepEqual(
      { ...(await load(kitty)), allocateImageId: undefined },
      { cellWidth: 9, cellHeight: 18, columns: 120, allocateImageId: undefined }
    )
    assert.equal(await load(kitty, false), undefined)
    assert.equal((await load(kitty, true, undefined))?.columns, 80)
    assert.equal((await load(kitty, true, 0))?.columns, 80)
    assert.equal(await load(stub('iterm2', '{ widthPx: 9, heightPx: 18 }')), undefined)
    assert.equal(await load(stub(null, '{ widthPx: 9, heightPx: 18 }')), undefined)
    assert.equal(await load(stub('kitty', '{ widthPx: 0, heightPx: 18 }')), undefined)
    assert.equal(await load(join(root, 'missing', 'pi-coding-agent')), undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  assert.ok(fitsStrip(graphics, { dots: 1, branches: 1 }, 32))
  assert.ok(!fitsStrip({ ...graphics, columns: 40 }, { dots: 1, branches: 1 }, 32))
})

const sweepOutput = (
  style: ReturnType<typeof terminalStyle>,
  withGraphics: QuitGraphics | undefined,
  settle: SceneShape | undefined,
  sweepMs = 400
) => {
  const out = collector()
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const indicator = yield* sweepIndicator(style, out.stream, withGraphics)
        yield* Effect.sleep(sweepMs)
        yield* indicator.sweepDone
        if (settle !== undefined) yield* indicator.settle(settle)
      })
    )
  ).then(() => out)
}

const runSweep = (...args: Parameters<typeof sweepOutput>) =>
  sweepOutput(...args).then(out => out.text())

const imageIds = (text: string, command: string) =>
  text
    .split(`\x1b_G${command}`)
    .slice(1)
    .map(part =>
      part
        .slice(0, part.indexOf('\x1b'))
        .split(',')
        .find(key => key.startsWith('i='))
    )
const placedIds = (text: string) => imageIds(text, 'a=T,')
const deletedIds = (text: string) => imageIds(text, 'a=d,')
const empty: SceneShape = { dots: 0, branches: 0 }
const assertNothingLeft = (text: string) => {
  const placed = placedIds(text)
  assert.ok(placed.length > 0)
  assert.deepEqual(deletedIds(text).toSorted(), placed.toSorted())
  assert.ok(
    text.endsWith(`\x1b_Ga=d,d=I,${placed.at(-1)},q=2\x1b\\\x1b8\x1b[K\r\x1b[?25h`),
    JSON.stringify(text.slice(-60))
  )
  assert.ok(!text.includes(`\x1b[${ROWS}B`))
  assert.equal(text.split('\x1b[?25h').length - 1, 1)
}
const found: SceneShape = { dots: 1, branches: 1 }

await claim('without graphics the sweep output is the text spinner as before', async () => {
  const plain = await runSweep(terminalStyle({ isTTY: false }, {}), graphics, found)
  assert.equal(plain, 'Sweeping workspaces...\n')
  for (const unavailable of [undefined, { ...graphics, columns: 40 }]) {
    const text = await runSweep(live, unavailable, found)
    assert.ok(!text.includes('\x1b_G'), text)
    assert.ok(
      text.startsWith('\x1b]9;4;3\x07\r\x1b[2K\x1b[33m⠋\x1b[0m Sweeping workspaces… \x1b[2m0.'),
      text
    )
    assert.ok(text.endsWith('\r\x1b[2K'), JSON.stringify(text))
    assert.equal(text.split('\r\x1b[2K').length - 1 > 1, true)
  }
})

await claim('the graphical sweep animates in place and always restores the terminal', async () => {
  const text = await runSweep(live, graphics, found)
  assert.ok(text.startsWith(`\n\n\x1b[${ROWS}A\x1b[?25l\x1b7`), JSON.stringify(text.slice(0, 40)))
  assert.ok(text.includes('\x1b_Ga=T,f=32,o=z'))
  assert.ok(text.includes('\x1b[2mSweeping workspaces… 0.'))
  assertNothingLeft(text)
  const frames = text.split('\x1b[?2026h').length - 1
  assert.ok(frames >= 5, String(frames))
  assertNothingLeft(await runSweep(live, graphics, undefined))
})

await claim('a sweep summary holds its final frame for 250 ms, then fades out', async () => {
  assertHoldsThenLeaves((await sweepOutput(live, graphics, found)).frameTimes)
})

await claim('a sweep finishing within the indicator delay shows no progress', async () => {
  for (const available of [graphics, undefined]) {
    assert.equal(await runSweep(live, available, empty, 20), '')
    assert.equal(await runSweep(live, available, undefined, 20), '')
  }
  const summary = await runSweep(live, graphics, found, 20)
  assert.ok(
    summary.startsWith(`\n\n\x1b[${ROWS}A\x1b[?25l\x1b7`),
    JSON.stringify(summary.slice(0, 40))
  )
  assert.ok(!summary.includes('Sweeping workspaces'))
  assertNothingLeft(summary)
})

await claim('a slow sweep with nothing to show deletes its strip and keeps no rows', async () => {
  for (const shape of [empty, { dots: 40, branches: 40 }]) {
    const text = await runSweep(live, graphics, shape)
    assert.ok(text.includes('\x1b[2mSweeping workspaces… 0.'))
    assert.ok(placedIds(text).length >= 5)
    assertNothingLeft(text)
  }
})

await claim('release strips report progress, then leave nothing behind', async () => {
  const initial: Scene = { dots: 1, branches: [{ kind: 'waiting' }, { kind: 'waiting' }] }
  const run = async (
    style: ReturnType<typeof terminalStyle>,
    available: QuitGraphics | undefined,
    succeeds = true,
    finished = true
  ) => {
    const out = collector()
    const strip = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const active = yield* releaseIndicator(style, out.stream, available, initial, 1)
          if (active === undefined) return false
          yield* active.begin(0)
          yield* Effect.sleep(80)
          yield* active.end(0, succeeds)
          if (finished) yield* active.finish
          return true
        })
      )
    )
    return { strip, text: out.text(), frameTimes: out.frameTimes }
  }
  const shown = await run(live, graphics)
  assert.ok(shown.strip)
  assert.ok(shown.text.includes('\x1b[2mReleasing 1 task… 0.'))
  assert.ok(shown.text.includes('\x1b_Ga=T'))
  assertNothingLeft(shown.text)
  assert.equal(shown.text.split('\x1b[?25l').length - 1, 1)
  assertHoldsThenLeaves(shown.frameTimes)
  const failed = await run(live, graphics, false)
  assertNothingLeft(failed.text)
  assertHoldsThenLeaves(failed.frameTimes)
  assertNothingLeft((await run(live, graphics, true, false)).text)
  for (const [style, available] of [
    [terminalStyle({ isTTY: false }, {}), graphics],
    [live, undefined],
    [live, { ...graphics, columns: 40 }],
  ] as const) {
    const hidden = await run(style, available)
    assert.equal(hidden.strip, false)
    assert.equal(hidden.text, '')
  }
})

process.stdout.write(`${JSON.stringify({ result: 'passed', checks: passed }, null, 2)}\n`)
