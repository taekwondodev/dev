import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { Writable } from 'node:stream'
import { stripVTControlCharacters } from 'node:util'
import { inflateSync } from 'node:zlib'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import type { QuitTerminal } from '../../src/quit-animation.ts'
import { terminalStyle, type TerminalStyle } from '../../src/quit-display.ts'
import {
  ORB_SHAPE,
  ROWS,
  drawOrbStart,
  encodeClip,
  makeCanvas,
  orbStartEnd,
  orbStartPeriod,
  stripColumns,
  toRgba,
  type OrbStartScene,
  type QuitGraphics,
} from '../../src/quit-scene.ts'
import {
  openOrbStartView,
  type OrbStartStage,
  type OrbStartView,
} from '../../src/orb/start-view.ts'
import { loadStartupTerminalModule } from '../../src/terminal-module.ts'
import { kittyCommandsSent, makeClaims } from '../workspace/workspace-check-support.ts'
import { observed } from '../wait.ts'

const { claim, passed } = makeClaims()

const CELL = { widthPx: 16, heightPx: 34 }
const graphics: QuitGraphics = {
  cellWidth: CELL.widthPx,
  cellHeight: CELL.heightPx,
  columns: 160,
  allocateImageId: () => 1,
  hold: { begin: () => {}, end: () => {} },
}
const H = ROWS * CELL.heightPx
const head = { x: 0.45 * H, y: 0.22 * H }
const merge = { x: 1.31 * H, y: 0.7 * H }

const pixel = (scene: OrbStartScene, t: number, x: number, y: number) => {
  const canvas = makeCanvas(stripColumns(graphics, ORB_SHAPE) * CELL.widthPx, H)
  drawOrbStart(canvas, scene, t)
  const rgba = toRgba(canvas)
  const at = (Math.round(y) * canvas.width + Math.round(x)) * 4
  return { r: rgba[at] ?? 0, g: rgba[at + 1] ?? 0, b: rgba[at + 2] ?? 0, a: rgba[at + 3] ?? 0 }
}

type Pixel = ReturnType<typeof pixel>
const isBlue = (p: Pixel) => p.a > 200 && p.b > 230 && p.r < 120 && p.g > 140 && p.g < 190
const isRed = (p: Pixel) => p.a > 200 && p.r > 220 && p.g < 110 && p.b < 110
const isWhite = (p: Pixel) => p.a > 200 && p.r > 230 && p.g > 230 && p.b > 230

const awaiting: OrbStartScene = {
  arrival: { kind: 'awaited' },
  upload: undefined,
  launch: { kind: 'pending' },
  fate: { kind: 'present' },
}
const at = (scene: Partial<OrbStartScene>): OrbStartScene => ({ ...awaiting, ...scene })

const TILT = (-18 * Math.PI) / 180
const satellite = (t: number) => {
  const theta = (2 * Math.PI * t) / 2000
  const x = -0.3 * H * Math.cos(theta)
  const y = 0.09 * H * Math.sin(theta)
  return {
    x: head.x + x * Math.cos(TILT) - y * Math.sin(TILT),
    y: head.y + x * Math.sin(TILT) + y * Math.cos(TILT),
  }
}

const onBranch = (u: number) => {
  const v = 1 - u
  const axis = (p0: number, p1: number, p2: number, p3: number) =>
    v ** 3 * p0 + 3 * v * v * u * p1 + 3 * v * u * u * p2 + u ** 3 * p3
  return {
    x: axis(head.x, head.x + 0.42 * H, head.x + 0.5 * H, merge.x),
    y: axis(head.y, head.y, merge.y, merge.y),
  }
}

await claim(
  'while orbit has not assigned an orb a white satellite circles an empty orbit where the orb will be',
  () => {
    const t = 1000
    const where = satellite(t)
    assert.ok(isWhite(pixel(awaiting, t, where.x, where.y)), JSON.stringify(where))
    assert.equal(pixel(awaiting, t, head.x, head.y).a, 0, 'no orb yet')
    const later = satellite(t + 500)
    assert.ok(isWhite(pixel(awaiting, t + 500, later.x, later.y)), 'the satellite keeps moving')
  }
)

await claim(
  'a reserved orb is a hollow blue ring, a building orb fills while it breathes, an active orb is a solid blue node',
  () => {
    const reserved = at({ arrival: { kind: 'reserved', at: 0 } })
    assert.ok(isBlue(pixel(reserved, 2000, head.x + 0.13 * H, head.y)), 'the ring')
    assert.ok(pixel(reserved, 2000, head.x, head.y).a < 40, 'hollow')
    const building = at({ arrival: { kind: 'building', since: 0 } })
    const faint = pixel(building, 0, head.x, head.y).a
    const full = pixel(building, 550, head.x, head.y).a
    assert.ok(faint > 20 && faint < 80 && full > 120 && full < 200, `${faint} then ${full}`)
    const active = at({ arrival: { kind: 'active', at: 0 } })
    assert.ok(isBlue(pixel(active, 2000, head.x, head.y)))
  }
)

await claim(
  'the upload docks the orbit and grows the branch from the line up to the orb, and a ready orb ends as the quit begins: a blue node on its blue branch',
  () => {
    const uploading = at({ arrival: { kind: 'active', at: 0 }, upload: 1000 })
    const near = onBranch(0.2)
    const far = onBranch(0.85)
    assert.ok(isBlue(pixel(uploading, 1030, far.x, far.y)), 'it grows from the line')
    assert.equal(pixel(uploading, 1030, near.x, near.y).a, 0, 'not yet at the orb')
    const ready = at({
      arrival: { kind: 'active', at: 0 },
      upload: 1000,
      launch: { kind: 'ready', at: 2000 },
    })
    const end = orbStartEnd(ready)
    assert.ok(end > 2000 && end <= 2000 + 200, String(end))
    assert.ok(isBlue(pixel(ready, end, head.x, head.y)))
    assert.ok(isBlue(pixel(ready, end, near.x, near.y)))
    assert.ok(isBlue(pixel(ready, end, far.x, far.y)))
    for (const t of [end, end + 700]) {
      const where = satellite(1000)
      assert.ok(!isWhite(pixel(ready, t, where.x, where.y)), 'the orbit is gone')
    }
  }
)

const rgbaAt = (scene: OrbStartScene, t: number): Buffer => {
  const canvas = makeCanvas(stripColumns(graphics, ORB_SHAPE) * CELL.widthPx, H)
  drawOrbStart(canvas, scene, t)
  return toRgba(canvas)
}

await claim(
  'once a phase has settled it repeats exactly: with the orbit every two seconds, a breathing orb twice in that, the upload on its own beat, and a finished start stands still',
  () => {
    const steady: readonly (readonly [OrbStartScene, number])[] = [
      [awaiting, 2000],
      [at({ arrival: { kind: 'reserved', at: 100 } }), 2000],
      [at({ arrival: { kind: 'building', since: 100 } }), 2000],
      [at({ arrival: { kind: 'active', at: 100 } }), 2000],
      [at({ arrival: { kind: 'active', at: 100 }, upload: 900 }), 820],
      [
        at({
          arrival: { kind: 'building', since: 100 },
          launch: { kind: 'cancelled', at: 900 },
          fate: { kind: 'deleting', since: 950 },
        }),
        1000,
      ],
      [
        at({
          arrival: { kind: 'active', at: 100 },
          launch: { kind: 'failed', at: 900 },
          fate: { kind: 'undeleted', at: 1500 },
        }),
        0,
      ],
    ]
    for (const [scene, period] of steady) {
      assert.equal(orbStartPeriod(scene), period, JSON.stringify(scene))
      const settled = orbStartEnd(scene) + 400
      for (const offset of [0, 137, 611]) {
        const again = settled + offset + (period === 0 ? 700 : period)
        assert.ok(
          rgbaAt(scene, settled + offset).equals(rgbaAt(scene, again)),
          `${JSON.stringify(scene)} at +${offset}`
        )
      }
    }
    const moving = rgbaAt(awaiting, 1000)
    assert.ok(!moving.equals(rgbaAt(awaiting, 1500)), 'the settled orbit still moves')
  }
)

const kittyCommands = (text: string): (readonly [string, string])[] =>
  text
    .split('\x1b_G')
    .slice(1)
    .map(part => {
      const body = part.slice(0, part.indexOf('\x1b\\'))
      const separator = body.indexOf(';')
      return separator === -1 ? [body, ''] : [body.slice(0, separator), body.slice(separator + 1)]
    })
const controlKeys = (control: string): Record<string, string> =>
  Object.fromEntries(control.split(',').map(pair => pair.split('=') as [string, string]))

const playClip = (text: string, widthPx: number): Buffer[] => {
  const frames: Buffer[] = []
  let open: { readonly keys: Record<string, string>; data: string } | undefined
  for (const [control, data] of kittyCommands(text)) {
    const keys = controlKeys(control)
    if (keys.a === 'd') continue
    open = open === undefined ? { keys, data } : { keys: open.keys, data: open.data + data }
    if (keys.m === '1') continue
    const pixels = inflateSync(Buffer.from(open.data, 'base64'))
    if (open.keys.a === 'T') frames.push(pixels)
    else {
      assert.equal(open.keys.a, 'f')
      assert.equal(open.keys.X, '1', 'the changed pixels replace the old ones')
      const frame = Buffer.from(frames[Number(open.keys.c) - 1] as Buffer)
      const [x, y, width, height] = ['x', 'y', 's', 'v'].map(key => Number(open?.keys[key]))
      for (let row = 0; row < (height as number); row += 1)
        pixels.copy(
          frame,
          (((y as number) + row) * widthPx + (x as number)) * 4,
          row * (width as number) * 4,
          (row + 1) * (width as number) * 4
        )
      frames.push(frame)
    }
    open = undefined
  }
  return frames
}

await claim(
  'a settled phase goes to the terminal once, as animation frames that carry only what changed, and the terminal rebuilds every frame from them',
  () => {
    const widthPx = stripColumns(graphics, ORB_SHAPE) * CELL.widthPx
    const frames = Array.from({ length: 24 }, (_, index) =>
      rgbaAt(at({ arrival: { kind: 'building', since: 0 } }), 3000 + (index * 2000) / 24)
    )
    const text = encodeClip({
      frames,
      widthPx,
      heightPx: H,
      columns: stripColumns(graphics, ORB_SHAPE),
      id: 7,
      previousId: 6,
      before: '',
      after: '',
    })
    const rebuilt = playClip(text, widthPx)
    assert.equal(rebuilt.length, frames.length)
    for (const [index, frame] of frames.entries())
      assert.ok(frame.equals(rebuilt[index] as Buffer), `frame ${index + 1}`)
    const changed = kittyCommands(text)
      .map(([control]) => controlKeys(control))
      .filter(keys => keys.a === 'f' && keys.c !== undefined)
    assert.equal(changed.length, frames.length - 1)
    for (const keys of changed)
      assert.ok(Number(keys.s) * Number(keys.v) < (widthPx * H) / 4, JSON.stringify(keys))
    assert.ok(text.includes('\x1b_Ga=d,d=I,i=6,'), 'the image it replaces is removed')
  }
)

await claim('a failed start turns the orb red, and a deleted orb leaves nothing', () => {
  const failed = at({
    arrival: { kind: 'building', since: 0 },
    launch: { kind: 'failed', at: 500 },
  })
  assert.ok(isRed(pixel(failed, orbStartEnd(failed), head.x + 0.13 * H, head.y)))
  const failedUpload = at({
    arrival: { kind: 'active', at: 0 },
    upload: 100,
    launch: { kind: 'failed', at: 500 },
  })
  const middle = onBranch(0.5)
  assert.ok(isRed(pixel(failedUpload, orbStartEnd(failedUpload), middle.x, middle.y)))
  const deleted = at({
    arrival: { kind: 'active', at: 0 },
    launch: { kind: 'cancelled', at: 500 },
    fate: { kind: 'deleted', at: 900 },
  })
  assert.equal(pixel(deleted, orbStartEnd(deleted), head.x, head.y).a, 0)
  assert.ok(!isRed(pixel(deleted, 600, head.x, head.y)), 'a cancelled start is not a failure')
})

const collector = (log: string[] = []) => {
  const stream = new Writable({
    write(chunk, _encoding, done) {
      log.push(String(chunk))
      done()
    },
  })
  return { stream, text: () => log.join('') }
}

const kitty: QuitTerminal = {
  getCapabilities: () => ({ images: 'kitty', trueColor: true, hyperlinks: true }),
  getCellDimensions: () => ({ ...CELL }),
  allocateImageId: (() => {
    let next = 200
    return () => (next += 1)
  })(),
}
const live = terminalStyle({ isTTY: true }, {})

const viewRun = async <A>(
  body: (view: OrbStartView, log: string[]) => Effect.Effect<A, string>,
  terminal?: { readonly style: TerminalStyle; readonly module: QuitTerminal | undefined }
) => {
  const printed: string[] = []
  const log: string[] = []
  const out = collector(log)
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.flatMap(
        openOrbStartView(
          terminal === undefined
            ? undefined
            : { style: terminal.style, out: out.stream, columns: 160, module: terminal.module },
          line => printed.push(line),
          '/data'
        ),
        view => body(view, log)
      )
    )
  )
  return { exit, printed, text: out.text(), log }
}

type Step = OrbStartStage | number | string

const play = (view: OrbStartView, steps: readonly Step[]) =>
  Effect.forEach(
    steps,
    (step, index) => {
      if (typeof step === 'number') return Effect.void
      const shown = typeof step === 'string' ? Effect.sync(() => view.print(step)) : view.show(step)
      const pause = steps[index - 1]
      return typeof pause === 'number' ? shown.pipe(Effect.delay(pause)) : shown
    },
    { discard: true, concurrency: 1 }
  )

const ORB = 'abcd1234-full-id'
const happy: readonly Step[] = [
  { kind: 'authenticating', user: 'demo', url: 'http://keystone' },
  30,
  'orb: removed the incomplete orb record in /data/orbs/r0; it requested no orb',
  {
    kind: 'requesting',
    size: { vcpus: 2, memory_mb: 2048, disk_gb: 10 },
    url: 'http://orbit',
  },
  30,
  { kind: 'status', orbId: ORB, status: 'RESERVING' },
  40,
  { kind: 'status', orbId: ORB, status: 'BUILDING' },
  100,
  { kind: 'status', orbId: ORB, status: 'ACTIVE' },
  { kind: 'connecting', destination: 'ubuntu@192.0.2.7' },
  { kind: 'uploading', branch: 'main', head: '1a2b3c4d5e', root: '/repo' },
  40,
  { kind: 'ready', orbId: ORB },
]

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
const RESTORED = '\x1b[?25h'

await claim(
  'without a terminal the start prints one line per phase with the elapsed time, and the lines of a deleted start, as before',
  async () => {
    const { printed } = await viewRun(view =>
      play(view, [
        ...happy.slice(0, 6),
        { kind: 'discarding', orbId: ORB, interrupted: false },
        {
          kind: 'deletion',
          orbId: ORB,
          progress: { kind: 'status', status: 'DELETING', spentMs: 0 },
        },
        { kind: 'deletion', orbId: ORB, progress: { kind: 'deleted' } },
        { kind: 'undeleted', orbId: ORB, reason: 'orbit timed out' },
      ])
    )
    assert.deepEqual(printed, [
      'orb: authenticating as demo with Keystone at http://keystone (0:00)',
      'orb: removed the incomplete orb record in /data/orbs/r0; it requested no orb',
      'orb: requesting an orb (2 vCPU, 2048 MB, 10 GB) from http://orbit (0:00)',
      'orb: orb abcd1234 RESERVING (0:00)',
      'Deleting orb abcd1234 after the failed start…',
      'Deleting orb abcd1234 (DELETING 0:00)',
      'orb abcd1234 deleted',
      `Orb ${ORB} could not be confirmed deleted: orbit timed out\nIts record stays, and the next dev --orb deletes the orb and removes it.\nDelete it now with: dev --data-home '/data' orb delete ${ORB}`,
    ])
  }
)

await claim(
  'with Kitty graphics the start animates one strip, writes notes above it, removes every image, then prints the receipt',
  async () => {
    const { text, printed } = await viewRun(view => play(view, happy), {
      style: live,
      module: kitty,
    })
    assert.deepEqual(printed, [])
    const placed = imageIds(text, 'a=T,')
    assert.ok(placed.length >= 5, String(placed.length))
    assert.deepEqual(imageIds(text, 'a=d,').toSorted(), placed.toSorted())
    assert.ok(text.includes('\x1b[2mAuthenticating with Keystone… '))
    assert.ok(text.includes('\x1b[2mOrb abcd1234 · BUILDING '))
    assert.ok(text.includes('\x1b[2mUploading main at 1a2b3c4… '))
    const note = text.indexOf('orb: removed the incomplete orb record')
    assert.ok(note > text.indexOf('\x1b_G'), 'the note comes after the strip opened')
    assert.ok(
      text.slice(0, note).endsWith('\x1b8\r'),
      'the note starts where the strip was, after clearing it'
    )
    assert.equal(text.split(RESTORED).length - 1, 1)
    const receipt = text.slice(text.lastIndexOf(RESTORED) + RESTORED.length)
    assert.match(
      stripVTControlCharacters(receipt),
      /^✓ orb abcd1234 ready · main at 1a2b3c4 on ubuntu@192\.0\.2\.7 · \d+\.\ds\n$/
    )
    assert.ok(
      receipt.startsWith('\x1b]9;4;0\x07\x1b[32m✓ orb abcd1234 ready'),
      'the terminal progress ends before the TUI opens'
    )
    assert.ok(text.includes('\x1b]9;4;3\x07'), 'the terminal shows progress')
  }
)

await claim(
  'while a phase is settled dev only names the frame to show, and sends images again when the phase changes or a note redraws the strip',
  async () => {
    let settled = ''
    let named = ''
    let noted = ''
    const { text, exit } = await viewRun(
      (view, log) =>
        Effect.gen(function* () {
          const since = (from: string) => log.join('').slice(from.length)
          yield* play(view, happy.slice(0, 1))
          yield* observed(
            'the loop sent as frames',
            () => kittyCommandsSent(log.join(''), 'a=f,') >= 100
          )
          settled = log.join('')
          yield* observed('frames named', () => kittyCommandsSent(since(settled), 'a=a,') >= 12)
          named = log.join('')
          view.print('orb: a note')
          yield* observed('the strip redrawn', () => kittyCommandsSent(since(named), 'a=f,') >= 100)
          noted = log.join('')
          yield* view.show({ kind: 'status', orbId: ORB, status: 'BUILDING' })
          yield* observed(
            'the new phase streamed',
            () => kittyCommandsSent(since(noted), 'a=T,') >= 2
          )
        }),
      { style: live, module: kitty }
    )
    assert.ok(Exit.isSuccess(exit), JSON.stringify(exit))
    const whileSettled = named.slice(settled.length)
    assert.equal(kittyCommandsSent(whileSettled, 'a=T,'), 0, 'no image while settled')
    assert.equal(kittyCommandsSent(whileSettled, 'a=f,'), 0, 'no frame while settled')
    assert.ok(whileSettled.includes('\x1b[2mAuthenticating with Keystone… '), 'the time still runs')
    assert.equal(
      kittyCommandsSent(noted.slice(named.length), 'a=T,'),
      1,
      'the note redraws the strip from the frames it has'
    )
    assert.deepEqual(imageIds(text, 'a=d,').toSorted(), imageIds(text, 'a=T,').toSorted())
  }
)

const settleTime = async (last: readonly Step[]) => {
  let shown = 0
  await viewRun(
    view =>
      play(view, [...happy.slice(0, 12), 400, ...last]).pipe(
        Effect.andThen(
          Effect.sync(() => {
            shown = performance.now()
          })
        )
      ),
    { style: live, module: kitty }
  )
  return performance.now() - shown
}

await claim(
  'a ready start fades at once so the TUI opens without waiting, and a failed start holds its last frame like the quit',
  async () => {
    const ready = await settleTime([{ kind: 'ready', orbId: ORB }])
    const failed = await settleTime([
      { kind: 'discarding', orbId: ORB, interrupted: false },
      { kind: 'deletion', orbId: ORB, progress: { kind: 'deleted' } },
    ])
    assert.ok(failed >= 750, String(failed))
    assert.ok(failed - ready >= 250, `ready ${ready}, failed ${failed}`)
  }
)

await claim(
  'a prompt during the start clears the strip before it asks and the strip resumes after the answer',
  async () => {
    let before = ''
    const { text } = await viewRun(
      (view, log) =>
        play(view, happy.slice(0, 1)).pipe(
          Effect.andThen(
            view
              .pause(
                Effect.sync(() => {
                  before = log.join('')
                })
              )
              .pipe(Effect.delay(40))
          ),
          Effect.andThen(play(view, happy.slice(2)).pipe(Effect.delay(40)))
        ),
      { style: live, module: kitty }
    )
    assert.ok(before.endsWith(RESTORED), JSON.stringify(before.slice(-30)))
    assert.deepEqual(imageIds(before, 'a=d,').toSorted(), imageIds(before, 'a=T,').toSorted())
    assert.ok(text.slice(before.length).includes('\x1b_Ga=T,'), 'the strip resumed')
    assert.equal(text.split(RESTORED).length - 1, 2)
  }
)

await claim(
  'a failed or interrupted start ends with what happened to its orb, and a failure before any phase prints nothing',
  async () => {
    const failed = await viewRun(
      view =>
        play(view, [
          ...happy.slice(0, 8),
          { kind: 'discarding', orbId: ORB, interrupted: false },
          {
            kind: 'deletion',
            orbId: ORB,
            progress: { kind: 'status', status: 'DELETING', spentMs: 0 },
          },
          40,
          { kind: 'deletion', orbId: ORB, progress: { kind: 'deleted' } },
        ]).pipe(Effect.andThen(Effect.fail('boom'))),
      { style: live, module: kitty }
    )
    assert.ok(Exit.isFailure(failed.exit))
    assert.ok(failed.text.includes('\x1b[2mDeleting orb abcd1234 · DELETING '))
    assert.ok(failed.text.includes(`${RESTORED}\x1b]9;4;2;100\x07`), 'the progress ends failed')
    assert.match(
      stripVTControlCharacters(failed.text.slice(failed.text.lastIndexOf(RESTORED))),
      /✗ The orb did not start · ✓ orb abcd1234 deleted · \d+\.\ds\n$/
    )
    const interrupted = await viewRun(
      view =>
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            Effect.andThen(play(view, happy.slice(0, 6)), Effect.never)
          )
          yield* Fiber.interrupt(fiber).pipe(Effect.delay(40))
          return yield* Effect.interrupt
        }),
      { style: live, module: kitty }
    )
    assert.match(
      stripVTControlCharacters(interrupted.text.slice(interrupted.text.lastIndexOf(RESTORED))),
      /Orb start cancelled · \d+\.\ds\n$/
    )
    const early = await viewRun(() => Effect.fail('no orb.json'), { style: live, module: kitty })
    assert.equal(early.text, '')
  }
)

await claim(
  'a live terminal without Kitty graphics shows a spinner line, writes notes on their own line and ends with the receipt',
  async () => {
    const { text } = await viewRun(view => play(view, happy), { style: live, module: undefined })
    assert.ok(!text.includes('\x1b_G'))
    assert.ok(text.includes('Orb abcd1234 · BUILDING '))
    assert.ok(text.includes('\r\x1b[2Korb: removed the incomplete orb record'))
    assert.match(
      stripVTControlCharacters(text.slice(text.lastIndexOf('\r\x1b[2K'))),
      /^\r✓ orb abcd1234 ready · main at 1a2b3c4 on ubuntu@192\.0\.2\.7 · \d+\.\ds\n$/
    )
  }
)

const fakeTerminal = (answer: string | undefined) => {
  const modes: boolean[] = []
  const input = Object.assign(new EventEmitter(), {
    isTTY: true,
    isRaw: false,
    setRawMode(mode: boolean) {
      modes.push(mode)
      input.isRaw = mode
      return input
    },
    resume: () => input,
    pause: () => input,
  })
  const written: string[] = []
  const out = {
    isTTY: true,
    write(chunk: string) {
      written.push(chunk)
      if (chunk === '\x1b[16t' && answer !== undefined)
        setTimeout(() => input.emit('data', Buffer.from(answer, 'latin1')), 5)
      return true
    },
  }
  return {
    input: input as unknown as NodeJS.ReadStream,
    out: out as unknown as NodeJS.WriteStream,
    modes,
    written,
    listeners: () => input.listenerCount('data'),
  }
}

await claim(
  "before the TUI opens dev uses Pi's terminal detection and asks the terminal for its cell size, restoring stdin whether or not it answers",
  async () => {
    const packageRoot = fileURLToPath(
      new URL('../../node_modules/@earendil-works/pi-coding-agent', import.meta.url)
    )
    const protocol = process.env.PI_IMAGE_PROTOCOL
    process.env.PI_IMAGE_PROTOCOL = 'kitty'
    try {
      const answered = fakeTerminal('typed\x1b[6;38;17t')
      const module = await Effect.runPromise(
        loadStartupTerminalModule(packageRoot, answered.input, answered.out)
      )
      assert.equal(module?.getCapabilities().images, 'kitty')
      assert.deepEqual(module?.getCellDimensions(), { widthPx: 17, heightPx: 38 })
      assert.deepEqual(answered.modes, [true, false])
      assert.equal(answered.listeners(), 0)
      const silent = fakeTerminal(undefined)
      const unanswered = await Effect.runPromise(
        loadStartupTerminalModule(packageRoot, silent.input, silent.out)
      )
      assert.deepEqual(unanswered?.getCellDimensions(), { widthPx: 0, heightPx: 0 })
      assert.deepEqual(silent.modes, [true, false])
      assert.equal(silent.listeners(), 0)
    } finally {
      if (protocol === undefined) delete process.env.PI_IMAGE_PROTOCOL
      else process.env.PI_IMAGE_PROTOCOL = protocol
    }
  }
)

process.stdout.write(
  `orb start check: ${passed.length} claims passed\n${passed.map(text => `- ${text}`).join('\n')}\n`
)
