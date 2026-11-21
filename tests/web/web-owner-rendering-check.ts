import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { join } from 'node:path'
import * as Cause from 'effect/Cause'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import { makeClaims } from '../workspace/workspace-check-support.ts'
import { waitFor, waitUntil } from '../wait.ts'
import { makeBrowserAdmin } from '../../src/web-browser-owner.ts'
import { makeBrowserProfileOwner } from '../../src/web-profile.ts'
import {
  assertCopyReleased,
  chromeRunningOn,
  openRenderer,
  ownerExited,
  ownerPublished,
} from './chrome-fixture.ts'
import {
  activityOf,
  makeBrowserOwnerCheckFixture,
  MAX_HTML,
  processGroup,
  renderInFlight,
  sha,
  text,
} from './browser-owner-check-fixture.ts'

const statusFrame = (requestId: string): Buffer => {
  const payload = Buffer.from(JSON.stringify({ type: 'status', requestId }), 'utf8')
  const framed = Buffer.alloc(4 + payload.length)
  framed.writeUInt32BE(payload.length, 0)
  payload.copy(framed, 4)
  return framed
}

const {
  fixture,
  chrome,
  source,
  seen,
  origin,
  profileOptions: makeProfileOptions,
  failures,
  newScope,
  closeClients,
  close,
} = await makeBrowserOwnerCheckFixture()
const dataHome = join(fixture, 'data')
mkdirSync(dataHome, { mode: 0o700 })
const copyDir = join(dataHome, 'browser', 'user-data')
const locator = join(dataHome, 'browser', 'owner.json')
const sourceBefore = sha(source.cookiesPath)
const profileOptions = makeProfileOptions(dataHome)
const admin = makeBrowserAdmin(profileOptions)
const queuedRenders = async (): Promise<number> => (await activityOf(admin)).queued
const { claim, passed } = makeClaims(180_000)

try {
  if (chrome === undefined) {
    await claim(
      'without an installed Chrome the renderer reports an honest failure and publishes no owner',
      async () => {
        const renderer = await openRenderer(dataHome, newScope(), failures)
        const exit = await Effect.runPromiseExit(
          renderer.render(`${origin}/page.html?m=A`, MAX_HTML)
        )
        assert.ok(Exit.isFailure(exit))
        assert.match(String(Cause.squash(exit.cause)), /Chrome is not installed|unavailable/)
      }
    )
  } else {
    await claim(
      'a lead process that bootstraps the owner can exit while another client keeps rendering: the owner is a detached sibling, not a descendant',
      async () => {
        const started = execFileSync(
          process.execPath,
          [join(import.meta.dirname, 'browser-owner-starter.ts'), dataHome],
          { encoding: 'utf8', env: process.env }
        )
        assert.match(started, /started/)
        assert.ok(ownerPublished(dataHome), 'the exited starter left a published owner')
        const published = JSON.parse(readFileSync(locator, 'utf8')) as { pid: number }
        assert.notEqual(
          processGroup(published.pid),
          processGroup(process.pid),
          'the owner runs in its own process group'
        )
        const renderer = await openRenderer(dataHome, newScope(), failures)
        const page = await Effect.runPromise(
          renderer.render(`${origin}/page.html?m=SOLO`, MAX_HTML)
        )
        assert.match(text(page.html), /MARKER SOLO SIGNED IN/)
      }
    )
    await claim(
      'two independent clients share one authenticated Chrome and one profile copy: overlapping renders return correctly attributed documents with their own frame, worker and blocked-subrequest facts',
      async () => {
        seen.length = 0
        const first = await openRenderer(dataHome, newScope(), failures)
        const second = await openRenderer(dataHome, newScope(), failures)
        const [a, b] = await Promise.all([
          Effect.runPromise(first.render(`${origin}/page.html?m=A`, MAX_HTML)),
          Effect.runPromise(second.render(`${origin}/page.html?m=B`, MAX_HTML)),
        ])
        assert.ok(chromeRunningOn(copyDir) > 0, 'one Chrome on the shared copy served both renders')
        assert.match(text(a.html), /MARKER A SIGNED IN/)
        assert.match(text(b.html), /MARKER B SIGNED IN/)
        assert.ok(!text(a.html).includes('MARKER B'), 'no cross-render document text')
        assert.ok(!text(b.html).includes('MARKER A'), 'no cross-render document text')
        assert.match(text(a.html), /\/page-fetch A \/ worker \/worker-fetch A/)
        assert.match(text(b.html), /\/page-fetch B \/ worker \/worker-fetch B/)
        assert.equal(a.blockedRequests, 1, 'each render counted only its own blocked subrequest')
        assert.equal(b.blockedRequests, 1)
        assert.equal(a.status, 200)
        for (const marker of ['A', 'B'])
          for (const path of [
            '/page.html',
            '/frame.html',
            '/worker.js',
            '/page-fetch',
            '/frame-fetch',
            '/worker-fetch',
          ])
            assert.ok(seen.includes(`${path}?${marker}`), `${path}?${marker} was served`)
        assert.ok(
          !seen.some(entry => entry.startsWith('/blocked')),
          'no blocked subrequest reached the server'
        )

        assert.equal(sha(source.cookiesPath), sourceBefore, 'the source profile is unchanged')
      }
    )
    await claim(
      'cancelling one client render closes only its targets: a peer render started at the same time still completes, and the browser stays usable afterwards',
      async () => {
        const slowClient = await openRenderer(dataHome, newScope(), failures)
        const peerClient = await openRenderer(dataHome, newScope(), failures)
        const slow = Effect.runFork(slowClient.render(`${origin}/slow.html?m=SLOW`, MAX_HTML))
        const peer = Effect.runFork(peerClient.render(`${origin}/page.html?m=PEER`, MAX_HTML))
        await waitFor('both clients to render concurrently in the shared Chrome', async () => {
          const status = await Effect.runPromise(admin.status)
          return status.owner.kind === 'live' &&
            status.owner.activity.rendering >= 2 &&
            seen.includes('/slow.html?SLOW') &&
            seen.includes('/page.html?PEER')
            ? true
            : undefined
        })
        await Effect.runPromise(Fiber.interrupt(slow))
        const page = await Effect.runPromise(Fiber.join(peer))
        assert.match(text(page.html), /MARKER PEER SIGNED IN/)
        const after = await Effect.runPromise(
          peerClient.render(`${origin}/page.html?m=AFTER`, MAX_HTML)
        )
        assert.match(text(after.html), /MARKER AFTER SIGNED IN/)
      }
    )
    await claim(
      'the owner reports live activity through browser status, and an oversized control frame breaks only that connection',
      async () => {
        const status = await Effect.runPromise(admin.status)
        assert.equal(status.owner.kind, 'live')
        if (status.owner.kind !== 'live') return
        assert.ok(status.owner.activity.clients >= 1)
        assert.equal(status.owner.activity.chrome, true)
        assert.equal(status.profile.inUse, true)
        const published = JSON.parse(readFileSync(locator, 'utf8')) as { socket: string }
        const refused = await new Promise<boolean>(resolve => {
          const socket = createConnection({ path: published.socket }, () => {
            const header = Buffer.alloc(4)
            header.writeUInt32BE(64 * 1024, 0)
            socket.write(header)
            socket.write(Buffer.alloc(1024))
          })
          socket.on('close', () => resolve(true))
          socket.on('error', () => resolve(true))
        })
        assert.equal(refused, true, 'the oversized frame closed its own connection')
        const survivor = await openRenderer(dataHome, newScope(), failures)
        const page = await Effect.runPromise(
          survivor.render(`${origin}/page.html?m=SURVIVED`, MAX_HTML)
        )
        assert.match(text(page.html), /MARKER SURVIVED/)
      }
    )
    await claim(
      'control frames split inside the length header and the payload, and several frames arriving in one write, are each answered exactly once and in order',
      async () => {
        const published = JSON.parse(readFileSync(locator, 'utf8')) as { socket: string }
        const ids = ['split-header', 'split-payload', 'joined-a', 'joined-b', 'joined-tail']
        const [header, payload, joinedA, joinedB, tail] = ids.map(statusFrame)
        assert.ok(header && payload && joinedA && joinedB && tail)
        const writes = [
          header.subarray(0, 2),
          header.subarray(2),
          payload.subarray(0, 4),
          payload.subarray(4, 9),
          payload.subarray(9),
          Buffer.concat([joinedA, joinedB, tail.subarray(0, 3)]),
          tail.subarray(3),
        ]
        const answered = await new Promise<string[]>((resolve, reject) => {
          const replies: string[] = []
          let received = Buffer.alloc(0)
          const socket = createConnection({ path: published.socket }, () => {
            writes.forEach((part, index) => setTimeout(() => socket.write(part), index * 40))
          })
          socket.on('data', (chunk: Buffer) => {
            received = Buffer.concat([received, chunk])
            while (received.length >= 4 && received.length >= 4 + received.readUInt32BE(0)) {
              const length = received.readUInt32BE(0)
              const reply = JSON.parse(received.subarray(4, 4 + length).toString('utf8')) as {
                requestId: string
              }
              replies.push(reply.requestId)
              received = received.subarray(4 + length)
            }
            if (replies.length >= ids.length) {
              socket.destroy()
              resolve(replies)
            }
          })
          socket.once('error', reject)
          socket.once('close', () => resolve(replies))
        })
        assert.deepEqual(answered, ids)
      }
    )
    await claim(
      'a render whose deadline expires while the same client is already rendering fails with a bounded capacity message, and the owner keeps serving afterwards',
      async () => {
        const scope = newScope()
        const impatient = await openRenderer(dataHome, scope, failures, Duration.seconds(1))
        const holding = Effect.runFork(impatient.render(`${origin}/slow.html?m=HOLD`, MAX_HTML))
        await renderInFlight(admin)
        const queued = await Effect.runPromiseExit(
          impatient.render(`${origin}/page.html?m=QUEUED`, MAX_HTML)
        )
        assert.ok(Exit.isFailure(queued))
        assert.match(String(Cause.squash(queued.cause)), /Browser read timed out after 1 seconds/)
        await Effect.runPromise(Fiber.interrupt(holding))
        const patient = await openRenderer(dataHome, scope, failures)
        const page = await Effect.runPromise(
          patient.render(`${origin}/page.html?m=AFTERQUEUE`, MAX_HTML)
        )
        assert.match(text(page.html), /MARKER AFTERQUEUE/)
        const status = await Effect.runPromise(admin.status)
        assert.equal(status.owner.kind, 'live')
        if (status.owner.kind === 'live') {
          assert.equal(status.owner.activity.queued, 0, 'the expired render left no queue entry')
          assert.equal(status.owner.activity.rendering, 0)
        }
      }
    )
    await claim(
      'the owner serves at most 64 rendering clients: a 65th rendering client fails with a capacity message while status still answers, and it is admitted once a client leaves',
      async () => {
        const published = JSON.parse(readFileSync(locator, 'utf8')) as { socket: string }
        const before = await Effect.runPromise(admin.status)
        const connected = before.owner.kind === 'live' ? before.owner.activity.clients : 0
        assert.ok(connected >= 1, 'a renderer from an earlier claim keeps rendering state')
        const raw: Socket[] = []
        const renderFrame = (marker: string): Uint8Array => {
          const payload = Buffer.from(
            JSON.stringify({
              type: 'render',
              requestId: `raw-${marker}`,
              url: `${origin}/slow.html?m=${marker}`,
              budgetMs: 30_000,
              maxHtmlChars: MAX_HTML,
            }),
            'utf8'
          )
          const framed = Buffer.alloc(4 + payload.length)
          framed.writeUInt32BE(payload.length, 0)
          payload.copy(framed, 4)
          return framed
        }
        const open = (marker: string) =>
          new Promise<Socket>((resolve, reject) => {
            const socket = createConnection({ path: published.socket }, () => {
              socket.write(renderFrame(marker))
              resolve(socket)
            })
            socket.once('error', reject)
          })
        for (let count = connected; count < 64; count += 1) raw.push(await open(`C${count}`))
        await waitUntil(
          '64 rendering clients',
          () => activityOf(admin),
          activity => activity.clients === 64
        )
        const full = await Effect.runPromise(admin.status)
        assert.equal(full.owner.kind, 'live', 'status answers while render clients are full')
        assert.equal(full.owner.kind === 'live' ? full.owner.activity.clients : 0, 64)
        const extra = await openRenderer(dataHome, newScope(), failures)
        const refused = await Effect.runPromiseExit(
          extra.render(`${origin}/page.html?m=SIXTYFIVE`, MAX_HTML)
        )
        assert.ok(Exit.isFailure(refused), 'the 65th rendering client was refused')
        assert.match(
          String(Cause.squash(refused.cause)),
          /At limit of 64 browser readers\. Retry later/
        )
        for (const socket of raw) socket.destroy()
        await waitUntil(
          'the closed clients to leave',
          () => activityOf(admin),
          activity => activity.clients < 64
        )
        const again = await Effect.runPromise(
          extra.render(`${origin}/page.html?m=ADMITTED`, MAX_HTML)
        )
        assert.match(text(again.html), /MARKER ADMITTED/)
      }
    )
    await claim(
      'a connection that never sends a control frame is dropped after ten seconds, and one whose first frame is malformed is closed at once, so neither can reserve connection capacity',
      async () => {
        const published = JSON.parse(readFileSync(locator, 'utf8')) as { socket: string }
        const closedAt = await new Promise<number>((resolve, reject) => {
          const started = Date.now()
          const socket = createConnection({ path: published.socket })
          socket.once('close', () => resolve(Date.now() - started))
          socket.once('error', reject)
        })
        assert.ok(closedAt >= 9000 && closedAt < 15_000, `dropped after ${closedAt} ms`)
        const malformedClosedAt = await new Promise<number>((resolve, reject) => {
          const started = Date.now()
          const socket = createConnection({ path: published.socket }, () => {
            const payload = Buffer.from('{"type":"render","requestId":1}', 'utf8')
            const framed = Buffer.alloc(4 + payload.length)
            framed.writeUInt32BE(payload.length, 0)
            payload.copy(framed, 4)
            socket.write(framed)
          })
          socket.once('close', () => resolve(Date.now() - started))
          socket.once('error', reject)
        })
        assert.ok(
          malformedClosedAt < 3000,
          `a malformed first frame closed the connection after ${malformedClosedAt} ms`
        )
      }
    )
    await claim(
      'the owner queues at most 64 renders: the 65th waiting render fails at once with a capacity message, and interrupting the queue leaves no entry behind',
      async () => {
        const scope = newScope()
        const burst = await openRenderer(dataHome, scope, failures)
        const holding = Effect.runFork(burst.render(`${origin}/slow.html?m=HOLDQ`, MAX_HTML))
        await renderInFlight(admin)
        const waiting = Array.from({ length: 64 }, (_, index) =>
          Effect.runFork(burst.render(`${origin}/page.html?m=Q${index}`, MAX_HTML))
        )
        await waitUntil('64 queued renders', queuedRenders, count => count === 64)
        const overflow = await Effect.runPromiseExit(
          burst.render(`${origin}/page.html?m=OVERFLOW`, MAX_HTML)
        )
        assert.ok(Exit.isFailure(overflow))
        assert.match(
          String(Cause.squash(overflow.cause)),
          /Already 64 browser reads waiting\. Retry later/
        )
        for (const fiber of [holding, ...waiting]) await Effect.runPromise(Fiber.interrupt(fiber))
        await waitUntil('the interrupted queue to drain', queuedRenders, count => count === 0)
        const page = await Effect.runPromise(
          burst.render(`${origin}/page.html?m=AFTERBURST`, MAX_HTML)
        )
        assert.match(text(page.html), /MARKER AFTERBURST/)
      }
    )
    await claim(
      'revoking while a render is in flight disables new rendering first, keeps the copy when the bounded drain expires, and removes it once reads finish',
      async () => {
        const busy = await openRenderer(dataHome, newScope(), failures)
        const pending = Effect.runFork(busy.render(`${origin}/slow.html?m=BUSY`, MAX_HTML))
        await renderInFlight(admin)
        const kept = await Effect.runPromise(admin.revoke(Duration.millis(600)))
        assert.equal(kept.kind, 'kept-live')
        assert.ok(existsSync(copyDir), 'the live copy was not deleted')
        const other = await openRenderer(dataHome, newScope(), failures)
        const refusedWhileDisabled = await Effect.runPromiseExit(
          other.render(`${origin}/page.html?m=DISABLED`, MAX_HTML)
        )
        assert.ok(Exit.isFailure(refusedWhileDisabled))
        assert.match(String(Cause.squash(refusedWhileDisabled.cause)), /disabled/)
        await Effect.runPromise(Fiber.interrupt(pending))
        const removed = await Effect.runPromise(admin.revoke(Duration.seconds(10)))
        assert.equal(removed.kind, 'removed')
        assert.ok(!existsSync(copyDir), 'the settled copy was removed')
        await assertCopyReleased(profileOptions, 'after a successful revocation')
        assert.equal((await Effect.runPromise(admin.status)).profile.enabled, false)
        await Effect.runPromise(admin.enable)
        assert.equal((await Effect.runPromise(admin.status)).profile.enabled, true)
        assert.equal(sha(source.cookiesPath), sourceBefore, 'the source profile is unchanged')
      }
    )
    await claim(
      'an idle shared Chrome closes and releases the copy while clients stay connected, and the next read relaunches it',
      async () => {
        const idle = await openRenderer(dataHome, newScope(), failures)
        const page = await Effect.runPromise(idle.render(`${origin}/page.html?m=IDLE`, MAX_HTML))
        assert.match(text(page.html), /MARKER IDLE/)
        assert.ok(chromeRunningOn(copyDir) > 0)
        await waitFor('the idle shared Chrome to close and release the copy', async () =>
          chromeRunningOn(copyDir) === 0 &&
          !(await Effect.runPromise(makeBrowserProfileOwner(profileOptions).status)).inUse
            ? true
            : undefined
        )
        await assertCopyReleased(profileOptions, 'after the idle period')
        assert.ok(ownerPublished(dataHome), 'the owner stayed available for its clients')
        const again = await Effect.runPromise(
          idle.render(`${origin}/page.html?m=RELAUNCH`, MAX_HTML)
        )
        assert.match(text(again.html), /MARKER RELAUNCH/)
      }
    )
    await claim(
      'when the last client disconnects the owner settles Chrome, releases the copy, removes its locator and exits',
      async () => {
        assert.ok(chromeRunningOn(copyDir) > 0, 'Chrome was live before the last client left')
        await closeClients()
        await ownerExited(dataHome)
        await assertCopyReleased(profileOptions, 'after the last client left')
        assert.equal(
          (await Effect.runPromise(makeBrowserProfileOwner(profileOptions).status)).inUse,
          false
        )
        assert.deepEqual(failures, [], 'no bootstrap failure was reported during this run')
      }
    )
    await claim(
      'a cleanly retired owner leaves no locator and the next reader can start a fresh owner',
      async () => {
        const absent = await Effect.runPromise(admin.status)
        assert.equal(absent.owner.kind, 'absent')
        const renderer = await openRenderer(dataHome, newScope(), failures)
        const page = await Effect.runPromise(
          renderer.render(`${origin}/page.html?m=FRESH`, MAX_HTML)
        )
        assert.match(text(page.html), /MARKER FRESH/)
        assert.ok(ownerPublished(dataHome))
      }
    )
  }
} finally {
  await close([dataHome])
}

console.log(JSON.stringify({ result: 'passed', checks: passed }, null, 2))
