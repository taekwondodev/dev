import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { stripVTControlCharacters } from 'node:util'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Scope from 'effect/Scope'
import type { QuitTerminal } from '../../src/quit-animation.ts'
import { terminalStyle, type TerminalStyle } from '../../src/quit-display.ts'
import {
  ORB_SHAPE,
  ROWS,
  drawOrb,
  makeCanvas,
  orbEnd,
  orbPeriod,
  stripColumns,
  toRgba,
  type OrbScene,
  type QuitGraphics,
  type TerminalHold,
} from '../../src/quit-scene.ts'
import { orbFailure } from '../../src/orb/domain.ts'
import { returnAtQuit } from '../../src/orb/session.ts'
import { makeSessionEnd } from '../../src/session-end.ts'
import {
  formatOrbQuitReceipt,
  openOrbQuitView,
  type OrbClosing,
  type OrbQuitStage,
  type OrbQuitTerminal,
  type OrbQuitView,
} from '../../src/orb/quit-view.ts'
import { kittyCommandsSent, makeClaims, observed } from '../workspace/workspace-check-support.ts'

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
const spareRing = { x: 1.91 * H + 0.11 * H, y: 0.22 * H }

const pixel = (scene: OrbScene, t: number, x: number, y: number) => {
  const canvas = makeCanvas(stripColumns(graphics, ORB_SHAPE) * CELL.widthPx, H)
  drawOrb(canvas, scene, t)
  const rgba = toRgba(canvas)
  const at = (Math.round(y) * canvas.width + Math.round(x)) * 4
  return { r: rgba[at] ?? 0, g: rgba[at + 1] ?? 0, b: rgba[at + 2] ?? 0, a: rgba[at + 3] ?? 0 }
}

type Pixel = ReturnType<typeof pixel>
const isBlue = (p: Pixel) => p.a > 200 && p.b > 230 && p.r < 120 && p.g > 140 && p.g < 190
const isGreen = (p: Pixel) => p.a > 200 && p.g > 160 && p.r < 100 && p.b < 110
const isYellow = (p: Pixel) => p.a > 200 && p.r > 190 && p.g > 130 && p.g < 170 && p.b < 60
const isRed = (p: Pixel) => p.a > 200 && p.r > 220 && p.g < 110 && p.b < 110
const isGray = (p: Pixel) =>
  p.a > 100 && p.a < 170 && Math.abs(p.r - 139) < 6 && Math.abs(p.b - 158) < 6

const scene = (work: OrbScene['work'], fate: OrbScene['fate'], spare = false): OrbScene => ({
  work,
  fate,
  spare,
})
const present = { kind: 'present' } as const

await claim('a returning orb is a blue node whose branch carries the work toward the line', () => {
  const returning = scene({ kind: 'returning', since: 0 }, present)
  assert.ok(isBlue(pixel(returning, 600, head.x, head.y)))
  assert.ok(isGray(pixel(returning, 600, 0.35 * H, merge.y)))
  assert.equal(pixel(returning, 600, merge.x, 0.22 * H).a, 0, 'nothing on the parallel line')
})

await claim(
  'returned work lands green on the line, the deleted orb vanishes and the line turns green',
  () => {
    const done = scene({ kind: 'returned', at: 100 }, { kind: 'deleted', at: 900 })
    const end = orbEnd(done)
    assert.ok(end >= 900 + 460 + 520, String(end))
    assert.ok(isGreen(pixel(done, end, merge.x, merge.y)))
    assert.ok(isGreen(pixel(done, end, 0.35 * H, merge.y)), 'the finale paints the line green')
    assert.equal(pixel(done, end, head.x, head.y).a, 0, 'the deleted orb leaves nothing')
    const before = scene({ kind: 'returned', at: 100 }, present)
    assert.ok(isGray(pixel(before, orbEnd(before), 0.35 * H, merge.y)), 'no finale while present')
  }
)

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
  'an orb with nothing to return retracts its branch toward the orb at full opacity, then finishes green',
  () => {
    const done = scene({ kind: 'unchanged', at: 100 }, { kind: 'deleted', at: 500 })
    const near = onBranch(0.3)
    const far = onBranch(0.7)
    assert.ok(isBlue(pixel(done, 100, far.x, far.y)), 'the whole branch before the retract')
    const retracting = 130
    assert.ok(isBlue(pixel(done, retracting, near.x, near.y)), 'the part near the orb stays opaque')
    assert.equal(pixel(done, retracting, far.x, far.y).a, 0, 'the far part is already gone')
    assert.equal(pixel(done, 450, near.x, near.y).a, 0, 'the branch retracted')
    assert.ok(isGreen(pixel(done, orbEnd(done), 0.35 * H, merge.y)))
  }
)

await claim('diverged work lands yellow on a parallel line and never turns the line green', () => {
  const done = scene({ kind: 'diverged', at: 100 }, { kind: 'deleted', at: 900 })
  const end = orbEnd(done)
  assert.ok(isYellow(pixel(done, end, merge.x, head.y)))
  assert.ok(isYellow(pixel(done, end, (head.x + merge.x) / 2 + 0.2 * H, head.y)))
  assert.ok(isGray(pixel(done, end, 0.35 * H, merge.y)))
  assert.ok(!isGreen(pixel(done, end, merge.x, merge.y)))
})

await claim('a failed return or an unconfirmed deletion turns the orb red', () => {
  for (const failed of [
    scene({ kind: 'failed', at: 100 }, present),
    scene({ kind: 'returned', at: 100 }, { kind: 'undeleted', at: 900 }),
  ]) {
    const end = orbEnd(failed)
    assert.ok(isRed(pixel(failed, end, head.x, head.y)))
    assert.ok(isGray(pixel(failed, end, 0.35 * H, merge.y)), 'no finale')
  }
})

await claim('a deleting orb breathes until orbit reports it deleted', () => {
  const deleting = scene({ kind: 'returned', at: 0 }, { kind: 'deleting', since: 1000 })
  const full = pixel(deleting, 1000, head.x, head.y).a
  const faint = pixel(deleting, 1550, head.x, head.y).a
  assert.ok(full > 240 && faint < 120, `${full} then ${faint}`)
})

await claim('a spare left for the next launch is a hollow ring beside the line', () => {
  const work = { kind: 'returning', since: 0 } as const
  assert.ok(pixel(scene(work, present, true), 800, spareRing.x, spareRing.y).a > 80)
  assert.equal(pixel(scene(work, present, false), 800, spareRing.x, spareRing.y).a, 0)
  assert.equal(pixel(scene(work, present, true), 800, spareRing.x - 0.11 * H, spareRing.y).a, 0)
})

const closing: OrbClosing = {
  label: 'abcd1234',
  branch: 'main',
  location: '/repo (192.0.2.7)',
  recoveryBranch: 'dev/orb-recovery/r1',
  deleteCommand: "dev --data-home '/data' orb delete abcd1234-full",
  spare: {
    kind: 'ready',
    orbId: 'spare-1',
    until: '18:40',
    deleteCommand: "dev --data-home '/data' orb delete spare-1",
  },
}
const plain = terminalStyle({ isTTY: false }, {})
const live = terminalStyle({ isTTY: true }, {})
const returned = {
  kind: 'returned',
  outcome: { kind: 'returned', head: '1a2b3c4d5e', commits: 3, files: 1 },
} as const

await claim(
  "the orb receipt states the return, the deletion and the elapsed time on one line, then each follow-up command with why it's there",
  () => {
    assert.deepEqual(
      formatOrbQuitReceipt(closing, { work: returned, deletion: { kind: 'deleted' } }, 6100, plain),
      [
        '✓ 3 commits and 1 changed file returned to main at 1a2b3c4 · ✓ orb abcd1234 deleted · 6.1s',
        "dev --data-home '/data' orb delete spare-1  Spare orb spare-1 stays ready for the next dev --orb until 18:40.",
      ]
    )
    assert.deepEqual(
      formatOrbQuitReceipt(
        { ...closing, spare: { kind: 'refused', reason: 'orbit had no capacity for it' } },
        {
          work: {
            kind: 'returned',
            outcome: { kind: 'diverged', reason: 'branch-moved', branch: 'dev/orb-return/r1' },
          },
          deletion: { kind: 'undeleted', reason: 'orb abcd1234 still reads DELETING after 1:00' },
        },
        2000,
        plain
      ),
      [
        'Work kept on dev/orb-return/r1 · ✗ orb abcd1234 not confirmed deleted · 2.0s',
        "git merge dev/orb-return/r1  main moved on the Mac, so the orb's commits cannot fast-forward it. The checkout, its branch and its index are untouched.",
        "dev --data-home '/data' orb delete abcd1234-full  orb abcd1234 still reads DELETING after 1:00. Its record stays, and the next dev --orb deletes the orb.",
        'No spare orb was left for the next dev --orb: orbit had no capacity for it',
      ]
    )
    const kept = (shown: boolean) =>
      formatOrbQuitReceipt(
        { ...closing, spare: undefined },
        { work: { kind: 'kept', reason: 'orb unreachable', shown } },
        900,
        plain
      )
    const commands = [
      'dev --orb  Returns the work still on the orb at /repo (192.0.2.7) to dev/orb-recovery/r1, then deletes the orb.',
      "dev --data-home '/data' orb delete abcd1234-full  Discards its work and deletes the orb.",
    ]
    assert.deepEqual(kept(false), [
      '✗ orb abcd1234 kept · 0.9s',
      'The return failed: orb unreachable',
      ...commands,
    ])
    assert.deepEqual(kept(true), ['✗ orb abcd1234 kept · 0.9s', ...commands])
    assert.deepEqual(
      formatOrbQuitReceipt(
        { ...closing, spare: undefined },
        {
          work: { kind: 'returned', outcome: { kind: 'unchanged' } },
          deletion: { kind: 'deleted' },
        },
        900,
        plain
      ),
      ['Nothing to return · ✓ orb abcd1234 deleted · 0.9s']
    )
    assert.equal(
      formatOrbQuitReceipt(
        closing,
        { work: returned, deletion: { kind: 'deleted' } },
        6100,
        live
      )[0],
      '\x1b[32m✓ 3 commits and 1 changed file returned to main at 1a2b3c4\x1b[0m · \x1b[32m✓ orb abcd1234 deleted\x1b[0m\x1b[2m · 6.1s\x1b[0m'
    )
  }
)

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

type Step = OrbQuitStage | number

const viewRun = async (
  body: (view: OrbQuitView, log: string[]) => Effect.Effect<void>,
  terminal?: {
    readonly style: TerminalStyle
    readonly module: QuitTerminal | undefined
    readonly hold?: TerminalHold
  }
) => {
  const printed: string[] = []
  const log: string[] = []
  const out = collector(log)
  const holds: string[] = []
  const quitTerminal: OrbQuitTerminal | undefined =
    terminal === undefined
      ? undefined
      : {
          style: terminal.style,
          out: out.stream,
          columns: 160,
          hold: {
            begin: () => {
              holds.push('begin')
              terminal.hold?.begin()
            },
            end: () => {
              holds.push('end')
              terminal.hold?.end()
            },
          },
          module: terminal.module,
        }
  await Effect.runPromise(
    Effect.uninterruptible(
      Effect.scoped(
        Effect.flatMap(
          openOrbQuitView(quitTerminal, line => printed.push(line), closing),
          view => body(view, log)
        )
      )
    )
  )
  return { printed, text: out.text(), holds, log }
}

const play = (view: OrbQuitView, steps: readonly Step[]) =>
  Effect.forEach(steps, step => (typeof step === 'number' ? Effect.sleep(step) : view.show(step)), {
    discard: true,
  })

const runView = (steps: readonly Step[], terminal?: Parameters<typeof viewRun>[1]) =>
  viewRun(view => play(view, steps), terminal)

const deletion = (status: string): OrbQuitStage => ({
  kind: 'deletion',
  progress: { kind: 'status', status, spentMs: 0 },
})
const happy: readonly Step[] = [
  { kind: 'returning' },
  60,
  returned,
  deletion('ACTIVE'),
  deletion('DELETING'),
  60,
  { kind: 'deletion', progress: { kind: 'deleted' } },
]

await claim(
  'without a terminal the quit prints one line per step, then the receipt, and never per-status deletion lines',
  async () => {
    const { printed } = await runView(happy)
    assert.equal(printed.length, 4, printed.join('\n'))
    assert.deepEqual(printed.slice(0, 2), [
      'Returning work from orb abcd1234...',
      'Deleting orb abcd1234...',
    ])
    assert.match(
      printed[2] ?? '',
      /^✓ 3 commits and 1 changed file returned to main at 1a2b3c4 · ✓ orb abcd1234 deleted · \d+\.\ds$/
    )
    assert.match(printed[3] ?? '', /Spare orb spare-1 stays ready/)
  }
)

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

const rgbaAt = (shown: OrbScene, t: number) => {
  const canvas = makeCanvas(stripColumns(graphics, ORB_SHAPE) * CELL.widthPx, H)
  drawOrb(canvas, shown, t)
  return toRgba(canvas)
}

await claim(
  'a return in progress and a deletion in progress repeat exactly once settled, and an orb that is kept stands still',
  () => {
    const steady: readonly (readonly [OrbScene, number])[] = [
      [{ work: { kind: 'returning', since: 0 }, fate: { kind: 'present' }, spare: true }, 820],
      [
        {
          work: { kind: 'returned', at: 500 },
          fate: { kind: 'deleting', since: 900 },
          spare: false,
        },
        1100,
      ],
      [{ work: { kind: 'failed', at: 500 }, fate: { kind: 'present' }, spare: false }, 0],
    ]
    for (const [steadyScene, period] of steady) {
      assert.equal(orbPeriod(steadyScene), period, JSON.stringify(steadyScene))
      for (const offset of [0, 137, 611]) {
        const t = orbEnd(steadyScene) + offset
        assert.ok(
          rgbaAt(steadyScene, t).equals(rgbaAt(steadyScene, t + (period === 0 ? 700 : period))),
          `${JSON.stringify(steadyScene)} at +${offset}`
        )
      }
    }
  }
)

await claim(
  'while orbit deletes the orb the quit sends the fading orb once as frames and then only names the frame to show',
  async () => {
    let settled = ''
    let named = ''
    const { text } = await viewRun(
      (view, log) =>
        Effect.gen(function* () {
          const since = (from: string) => log.join('').slice(from.length)
          yield* view.show({ kind: 'returning' })
          yield* view.show(returned)
          yield* view.show({
            kind: 'deletion',
            progress: { kind: 'status', status: 'DELETING', spentMs: 0 },
          })
          yield* observed(
            'the fading orb sent as frames',
            () => kittyCommandsSent(log.join(''), 'a=f,') >= 40
          )
          settled = log.join('')
          yield* observed('frames named', () => kittyCommandsSent(since(settled), 'a=a,') >= 12)
          named = log.join('')
          yield* view.show({ kind: 'deletion', progress: { kind: 'deleted' } })
        }),
      { style: live, module: kitty }
    )
    const whileSettled = named.slice(settled.length)
    assert.equal(kittyCommandsSent(whileSettled, 'a=T,'), 0, 'no image while settled')
    assert.equal(kittyCommandsSent(whileSettled, 'a=f,'), 0, 'no frame while settled')
    assert.ok(whileSettled.includes('\x1b[2mDeleting orb abcd1234 · DELETING '))
    assert.deepEqual(imageIds(text, 'a=d,').toSorted(), imageIds(text, 'a=T,').toSorted())
  }
)

await claim(
  'with Kitty graphics the orb quit animates one strip under a terminal hold, removes every image, then prints the receipt',
  async () => {
    const { text, holds, printed } = await runView(happy, { style: live, module: kitty })
    assert.deepEqual(printed, [])
    assert.deepEqual(holds, ['begin', 'end'])
    const placed = imageIds(text, 'a=T,')
    assert.ok(placed.length >= 5, String(placed.length))
    assert.deepEqual(imageIds(text, 'a=d,').toSorted(), placed.toSorted())
    assert.ok(text.includes('\x1b[2mReturning work from orb abcd1234… '))
    assert.ok(text.includes('\x1b[2mDeleting orb abcd1234 · DELETING '))
    assert.equal(text.split(RESTORED).length - 1, 1)
    const receipt = text.slice(text.lastIndexOf(RESTORED) + RESTORED.length)
    assert.ok(
      receipt.startsWith('\x1b[32m✓ 3 commits and 1 changed file returned to main at 1a2b3c4'),
      JSON.stringify(receipt.slice(0, 60))
    )
    assert.ok(receipt.endsWith('until 18:40.\x1b[0m\n'), JSON.stringify(receipt.slice(-40)))
    assert.ok(!receipt.includes('\x1b_G'), 'nothing is drawn after the strip')
    assert.ok(text.includes('\x1b]9;4;3\x07'), 'the terminal shows progress')
  }
)

const FAILURE = '\x1b[31m✗ The return failed: orb unreachable\x1b[0m\n'

const retryRun = (answers: readonly boolean[], interruptDuringFailure = false) => {
  let attempts = 0
  let proceeding = true
  const asked: string[] = []
  return viewRun(
    (view, log) =>
      Effect.gen(function* () {
        const outcome = yield* returnAtQuit(
          Effect.andThen(view.show({ kind: 'returning' }), Effect.sleep(40)).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                attempts += 1
                return attempts <= answers.length
                  ? Effect.fail(orbFailure('orb unreachable'))
                  : Effect.succeed(returned.outcome)
              })
            )
          ),
          {
            proceed: () => proceeding,
            askRetry: Effect.sync(() => {
              const text = log.join('')
              asked.push(text.endsWith(`${RESTORED}${FAILURE}`) ? 'after the failure' : 'too early')
              return answers[asked.length - 1] ?? false
            }),
          },
          reason =>
            view.show({ kind: 'return-failed', reason }).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (interruptDuringFailure) proceeding = false
                })
              )
            )
        )
        if (outcome.kind === 'kept') yield* view.show({ kind: 'kept', reason: outcome.reason })
        else yield* view.show(returned)
      }),
    { style: live, module: kitty }
  ).then(run => ({ ...run, attempts, asked }))
}

await claim(
  'a failed return ends its strip and prints the failure before the retry prompt, an accepted retry starts a new strip, and the receipt does not repeat a failure already shown',
  async () => {
    const declined = await retryRun([true, false])
    assert.equal(declined.attempts, 2)
    assert.deepEqual(declined.asked, ['after the failure', 'after the failure'])
    assert.deepEqual(declined.holds, ['begin', 'end', 'begin', 'end'])
    const receipt = declined.text.slice(declined.text.lastIndexOf(FAILURE) + FAILURE.length)
    assert.ok(receipt.startsWith('\x1b[31m✗ orb abcd1234 kept\x1b[0m\x1b[2m · '))
    assert.match(
      stripVTControlCharacters(receipt).split('\n')[0] ?? '',
      /^✗ orb abcd1234 kept · \d+\.\ds$/
    )
    assert.ok(!receipt.includes('The return failed'))
    assert.ok(!receipt.includes('\x1b_G'), 'nothing is drawn after the last strip')
    const accepted = await retryRun([true])
    assert.equal(accepted.attempts, 2)
    assert.deepEqual(accepted.holds, ['begin', 'end', 'begin', 'end'])
    assert.ok(stripVTControlCharacters(accepted.text).includes('✓ 3 commits'))
  }
)

await claim(
  'an interrupt latched while the failure is shown keeps the orb without opening the prompt',
  async () => {
    const run = await retryRun([true], true)
    assert.equal(run.attempts, 1)
    assert.deepEqual(run.asked, [])
    assert.ok(stripVTControlCharacters(run.text).includes('✗ orb abcd1234 kept'))
  }
)

await claim(
  "a signal during the strip leaves the step's notice until the strip has restored the terminal, and the uninterruptible close still finishes",
  async () => {
    const ending = makeSessionEnd()
    const scope = await Effect.runPromise(Scope.make())
    await Effect.runPromise(Scope.provide(scope)(ending.watchSignals))
    const { write } = process.stderr
    const log: string[] = []
    process.stderr.write = ((chunk: string) => {
      log.push(`<stderr>${chunk}`)
      return true
    }) as typeof process.stderr.write
    try {
      const runtime = { dispose: () => Promise.resolve() }
      ending.parkPiDispose(runtime)
      void runtime.dispose()
      await Effect.runPromise(ending.requested)
      const step = ending.beginQuitStep('orb notice')
      assert.ok(step !== undefined)
      const run = await viewRun(
        (view, out) =>
          Effect.gen(function* () {
            yield* view.show({ kind: 'returning' })
            yield* Effect.sleep(60)
            yield* Effect.sync(() => {
              process.emit('SIGINT')
              out.push('<signalled>')
            })
            yield* Effect.sleep(60)
            yield* view.show(returned)
            yield* view.show({
              kind: 'undeleted',
              reason: 'the wait for DELETED was interrupted while orb abcd1234 read DELETING',
            })
          }),
        {
          style: live,
          module: kitty,
          hold: {
            begin: step.hold.begin,
            end: () => {
              step.hold.end()
              log.push('<hold ended>')
            },
          },
        }
      )
      step.end()
      assert.equal(step.proceed(), false)
      const { text } = run
      const signalled = text.indexOf('<signalled>')
      const restored = text.lastIndexOf(RESTORED)
      assert.ok(signalled > 0 && restored > signalled, 'the strip kept drawing after the signal')
      assert.deepEqual(log, ['<stderr>orb notice\n', '<hold ended>'])
      assert.ok(
        stripVTControlCharacters(text.slice(restored)).includes(
          '✗ orb abcd1234 not confirmed deleted'
        )
      )
      assert.deepEqual(imageIds(text, 'a=d,').toSorted(), imageIds(text, 'a=T,').toSorted())
    } finally {
      process.stderr.write = write
      await Effect.runPromise(Scope.close(scope, Exit.void))
    }
  }
)

await claim(
  'a live terminal without Kitty graphics shows a spinner line that it clears before any output',
  async () => {
    const { text, holds } = await runView(happy, { style: live, module: undefined })
    assert.deepEqual(holds, [])
    assert.ok(!text.includes('\x1b_G'))
    assert.ok(text.includes('Returning work from orb abcd1234… '))
    assert.ok(text.includes('Deleting orb abcd1234 · DELETING '))
    assert.ok(text.includes('\r\x1b[2K\x1b[32m✓ 3 commits'))
  }
)

process.stdout.write(
  `orb quit check: ${passed.length} claims passed\n${passed.map(text => `- ${text}`).join('\n')}\n`
)
