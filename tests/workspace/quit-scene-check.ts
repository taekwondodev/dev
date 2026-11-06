import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { Effect } from 'effect'
import { loadQuitGraphics } from '../../src/quit-animation.ts'
import { releaseIndicator, sweepIndicator, terminalStyle } from '../../src/quit-display.ts'
import {
  type BranchState,
  type QuitGraphics,
  type Scene,
  ROWS,
  SETTLED_AT,
  SYNC_BEGIN,
  SYNC_END,
  drawRelease,
  drawSweep,
  encodeFrame,
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
  const stream = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(String(chunk))
      done()
    },
  })
  return { stream, text: () => chunks.join(''), chunks }
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
    assert.ok(text.startsWith(`${SYNC_BEGIN}<before>`))
    assert.ok(text.endsWith(`<after>${SYNC_END}`))
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
      `r=${ROWS}`,
      'C=1',
      'q=2',
    ])
      assert.ok(first.split(',').includes(key), `${key} in ${first}`)
    const remove = '\x1b_Ga=d,d=I,i=54,q=2\x1b\\'
    assert.ok(text.indexOf(remove) > text.lastIndexOf('\x1b_G', text.indexOf(remove) - 1))
    assert.ok(text.indexOf(remove) > text.indexOf('<before>'))
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

const runSweep = (
  style: ReturnType<typeof terminalStyle>,
  withGraphics: QuitGraphics | undefined,
  settle: boolean
) => {
  const out = collector()
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const indicator = yield* sweepIndicator(style, out.stream, withGraphics)
        yield* Effect.sleep(120)
        yield* indicator.sweepDone
        if (settle) yield* indicator.settle({ dots: 1, branches: 1 })
      })
    )
  ).then(() => out.text())
}

await claim('without graphics the sweep output is the text spinner as before', async () => {
  const plain = await runSweep(terminalStyle({ isTTY: false }, {}), graphics, true)
  assert.equal(plain, 'Sweeping workspaces...\n')
  for (const unavailable of [undefined, { ...graphics, columns: 40 }]) {
    const text = await runSweep(live, unavailable, true)
    assert.ok(!text.includes('\x1b_G'), text)
    assert.ok(
      text.startsWith(
        '\x1b]9;4;3\x07\r\x1b[2K\x1b[33m⠋\x1b[0m Sweeping workspaces… \x1b[2m0.0s\x1b[0m'
      ),
      text
    )
    assert.ok(text.endsWith('\r\x1b[2K'), JSON.stringify(text))
    assert.equal(text.split('\r\x1b[2K').length - 1 > 1, true)
  }
})

await claim('the graphical sweep animates in place and always restores the terminal', async () => {
  const text = await runSweep(live, graphics, true)
  assert.ok(text.startsWith(`\n\n\x1b[${ROWS}A\x1b[?25l\x1b7`), JSON.stringify(text.slice(0, 40)))
  assert.ok(text.includes('\x1b_Ga=T,f=32,o=z'))
  assert.ok(text.includes('\x1b[2mSweeping workspaces… 0.'))
  assert.ok(text.endsWith(`\x1b8\x1b[K\x1b[${ROWS}B\r\x1b[?25h`), JSON.stringify(text.slice(-40)))
  assert.equal(text.split('\x1b[?25h').length - 1, 1)
  assert.ok(text.includes('\x1b_Ga=d,d=I,i='))
  const frames = text.split(SYNC_BEGIN).length - 1
  assert.ok(frames >= 5, String(frames))
  const unsettled = await runSweep(live, graphics, false)
  assert.ok(unsettled.endsWith(`\x1b8\x1b[K\x1b[${ROWS}B\r\x1b[?25h`))
})

await claim('the release animation follows the scene and ends below the strip', async () => {
  const initial: Scene = { dots: 1, branches: [{ kind: 'waiting' }, { kind: 'waiting' }] }
  const run = async (
    style: ReturnType<typeof terminalStyle>,
    available: QuitGraphics | undefined
  ) => {
    const out = collector()
    const strip = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const active = yield* releaseIndicator(style, out.stream, available, initial, 1)
          if (active === undefined) return false
          yield* active.begin(0)
          yield* Effect.sleep(80)
          yield* active.end(0, true)
          yield* active.finish
          return true
        })
      )
    )
    return { strip, text: out.text() }
  }
  const shown = await run(live, graphics)
  assert.ok(shown.strip)
  assert.ok(shown.text.includes('\x1b[2mReleasing 1 task… 0.'))
  assert.ok(shown.text.includes('\x1b_Ga=T'))
  assert.ok(shown.text.endsWith(`\x1b8\x1b[K\x1b[${ROWS}B\r\x1b[?25h`))
  assert.equal(shown.text.split('\x1b[?25l').length - 1, 1)
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
