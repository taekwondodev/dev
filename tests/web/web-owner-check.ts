import assert from 'node:assert/strict'
import { execFileSync, fork, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { Cause, Duration, Effect, Exit, Fiber, Scope } from 'effect'
import { makeClaims } from '../workspace/workspace-check-support.ts'
import { CHROME_EXECUTABLES, findChrome, makeBrowserProfileOwner } from '../../src/web-profile.ts'
import { makeBrowserAdmin, makeSessionRenderer } from '../../src/web-browser-owner.ts'
import {
  assertCopyReleased,
  chromeRunningOn,
  makeChromeSource,
  openRenderer,
  OWNER_ENTRY,
  ownerBootstrap,
  ownerPublished,
  selectOwnerFixture,
} from './chrome-fixture.ts'

const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'dev-web-owner-')))
const dataHome = join(fixture, 'data')
mkdirSync(dataHome, { mode: 0o700 })
mkdirSync(join(fixture, 'authority'), { recursive: true, mode: 0o700 })
const copyDir = join(dataHome, 'browser', 'user-data')
const locator = join(dataHome, 'browser', 'owner.json')
const SECRET = 'owner-fixture-token'
const BLOCKED = 'blocked.fixture.invalid'
const { claim, passed } = makeClaims(180_000)

const seen: string[] = []
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://fixture')
  const marker = url.searchParams.get('m') ?? 'none'
  seen.push(`${url.pathname}?${marker}`)
  const reply = (type: string, body: string) => {
    response.writeHead(200, { 'content-type': type })
    response.end(body)
  }
  switch (url.pathname) {
    case '/page.html': {
      const cookie = request.headers.cookie ?? ''
      const account = cookie.includes(`session=${SECRET}`) ? 'SIGNED IN' : 'ANONYMOUS'
      return reply(
        'text/html',
        `<!doctype html><html><head><title>Page ${marker}</title></head><body><main id="root">loading</main><script>
const root = document.getElementById("root")
const w = new Worker("/worker.js?m=${marker}")
const workerDone = new Promise(resolve => { w.onmessage = e => resolve(e.data) })
fetch("http://${BLOCKED}:${url.port || 0}/blocked?m=${marker}").catch(() => {})
Promise.all([fetch("/page-fetch?m=${marker}").then(r => r.text()), workerDone]).then(([page, worker]) => {
  root.innerHTML = "<h1>MARKER ${marker} ${account}</h1><p>" + page + " / " + worker + ". " + "Body padding for extraction. ".repeat(12) + "</p>"
})
</script><iframe src="/frame.html?m=${marker}"></iframe></body></html>`
      )
    }
    case '/frame.html':
      return reply(
        'text/html',
        `<!doctype html><html><body>frame ${marker}<script>fetch("/frame-fetch?m=${marker}")</script></body></html>`
      )
    case '/worker.js':
      return reply(
        'text/javascript',
        `fetch("/worker-fetch?m=${marker}").then(r => r.text()).then(t => postMessage("worker " + t))`
      )
    case '/slow.html':
      return reply(
        'text/html',
        '<!doctype html><html><head><title>Slow</title></head><body><div id="root">loading</div><script src="/hang.js"></script></body></html>'
      )
    case '/hang.js':
      return
    default:
      return reply('text/plain', `${url.pathname} ${marker}`)
  }
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
const address = server.address()
if (address === null || typeof address === 'string') throw new Error('fixture server has no port')
const { port } = address
const origin = `http://app.fixture.invalid:${port}`

const chrome = findChrome(CHROME_EXECUTABLES)
const source = makeChromeSource(fixture, { host: 'app.fixture.invalid', port })
source.writeCookies(SECRET)
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const sourceBefore = sha(source.cookiesPath)
const profileOptions = {
  dataHome,
  sourceUserData: source.userData,
  chromeExecutables: CHROME_EXECUTABLES,
}
const baseFixture = {
  sourceUserData: source.userData,
  chromeExecutables: CHROME_EXECUTABLES,
  chromeArguments: ['--host-resolver-rules=MAP *.fixture.invalid 127.0.0.1'],
  browserIdleMs: 5000,
  firstClientGraceMs: 30_000,
  installationPath: fixture,
  namespacePath: join(fixture, 'authority'),
  allowSuffix: '.fixture.invalid',
  blockedHosts: [BLOCKED],
  slowHosts: {},
}
selectOwnerFixture(baseFixture)

const MAX_HTML = 2 * 1024 * 1024
const admin = makeBrowserAdmin(profileOptions)
const scopes: Scope.Closeable[] = []
const newScope = (): Scope.Closeable => {
  const scope = Scope.makeUnsafe()
  scopes.push(scope)
  return scope
}
const closeScope = (scope: Scope.Closeable) => Effect.runPromise(Scope.close(scope, Exit.void))
const failures: string[] = []
const text = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
const ownerProcesses = (): number =>
  execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' })
    .split('\n')
    .filter(line => line.includes('browser-owner-entry.ts')).length
const startOwner = (home: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(import.meta.dirname, 'browser-owner-starter.ts'), home],
      { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let out = ''
    child.stdout.on('data', (chunk: Uint8Array) => {
      out += String(chunk)
    })
    child.stderr.on('data', (chunk: Uint8Array) => {
      out += String(chunk)
    })
    child.once('exit', code => (code === 0 ? resolve(out) : reject(new Error(out))))
  })
const processGroup = (pid: number): string =>
  execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim()

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
        await sleep(700)
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
      'a render whose deadline expires while the same client is already rendering fails with a bounded capacity message, and the owner keeps serving afterwards',
      async () => {
        const scope = newScope()
        const impatient = await openRenderer(dataHome, scope, failures, Duration.seconds(1))
        const holding = Effect.runFork(impatient.render(`${origin}/slow.html?m=HOLD`, MAX_HTML))
        await sleep(400)
        const queued = await Effect.runPromiseExit(
          impatient.render(`${origin}/page.html?m=QUEUED`, MAX_HTML)
        )
        assert.ok(Exit.isFailure(queued))
        assert.match(
          String(Cause.squash(queued.cause)),
          /did not start or finish within|did not render within 1 seconds/
        )
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
        await sleep(500)
        const full = await Effect.runPromise(admin.status)
        assert.equal(full.owner.kind, 'live', 'status answers while render clients are full')
        assert.equal(full.owner.kind === 'live' ? full.owner.activity.clients : 0, 64)
        const extra = await openRenderer(dataHome, newScope(), failures)
        const refused = await Effect.runPromiseExit(
          extra.render(`${origin}/page.html?m=SIXTYFIVE`, MAX_HTML)
        )
        assert.ok(Exit.isFailure(refused), 'the 65th rendering client was refused')
        assert.match(String(Cause.squash(refused.cause)), /already serves 64 rendering clients/)
        for (const socket of raw) socket.destroy()
        await sleep(500)
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
        await sleep(400)
        const waiting = Array.from({ length: 64 }, (_, index) =>
          Effect.runFork(burst.render(`${origin}/page.html?m=Q${index}`, MAX_HTML))
        )
        await sleep(400)
        const full = await Effect.runPromise(admin.status)
        assert.equal(full.owner.kind === 'live' ? full.owner.activity.queued : -1, 64)
        const overflow = await Effect.runPromiseExit(
          burst.render(`${origin}/page.html?m=OVERFLOW`, MAX_HTML)
        )
        assert.ok(Exit.isFailure(overflow))
        assert.match(String(Cause.squash(overflow.cause)), /already has 64 renders waiting/)
        for (const fiber of [holding, ...waiting]) await Effect.runPromise(Fiber.interrupt(fiber))
        await sleep(300)
        const drained = await Effect.runPromise(admin.status)
        assert.equal(drained.owner.kind === 'live' ? drained.owner.activity.queued : -1, 0)
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
        await sleep(500)
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
        await sleep(8000)
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
        for (const scope of scopes.splice(0)) await closeScope(scope)
        for (let attempt = 0; attempt < 100 && ownerPublished(dataHome); attempt += 1)
          await sleep(100)
        assert.ok(!ownerPublished(dataHome), 'the owner removed its locator and exited')
        await assertCopyReleased(profileOptions, 'after the last client left')
        assert.equal(
          (await Effect.runPromise(makeBrowserProfileOwner(profileOptions).status)).inUse,
          false
        )
        assert.deepEqual(failures, [], 'no bootstrap failure was reported during this run')
      }
    )
    await claim(
      'an owner whose Chrome cannot be launched returns an honest failure and releases the profile copy instead of holding it',
      async () => {
        const home = join(fixture, 'unlaunchable')
        mkdirSync(home, { mode: 0o700 })
        const executable = join(fixture, 'not-executable-chrome')
        writeFileSync(executable, '#!/bin/sh\nexit 1\n', { mode: 0o600 })
        selectOwnerFixture({ ...baseFixture, chromeExecutables: [executable] })
        const renderer = await openRenderer(home, newScope(), failures)
        const exit = await Effect.runPromiseExit(
          renderer.render(`${origin}/page.html?m=NOPE`, MAX_HTML)
        )
        assert.ok(Exit.isFailure(exit))
        assert.match(String(Cause.squash(exit.cause)), /Chrome could not be started|DevTools/)
        await assertCopyReleased({ ...profileOptions, dataHome: home }, 'after a failed launch')
        assert.ok(ownerPublished(home), 'the owner stayed available after the failed launch')
      }
    )
    await claim(
      'an unverified Chrome shutdown keeps the profile copy and its lock, reports the unobserved state and removes the copy only once settlement is observed',
      async () => {
        const home = join(fixture, 'unobserved')
        mkdirSync(home, { mode: 0o700 })
        const bin = join(fixture, 'blind-observer')
        mkdirSync(bin, { recursive: true })
        const flag = join(fixture, 'observation-blocked')
        writeFileSync(flag, 'blocked\n')
        writeFileSync(
          join(bin, 'ps'),
          `#!/bin/sh\nif [ -f ${flag} ]; then exit 7; fi\nexec /bin/ps "$@"\n`,
          { mode: 0o700 }
        )
        selectOwnerFixture(baseFixture)
        const path = process.env.PATH
        process.env.PATH = `${bin}:${path ?? ''}`
        const blindAdmin = makeBrowserAdmin({ ...profileOptions, dataHome: home })
        try {
          const renderer = await openRenderer(home, newScope(), failures)
          const page = await Effect.runPromise(
            renderer.render(`${origin}/page.html?m=BLIND`, MAX_HTML)
          )
          assert.match(text(page.html), /MARKER BLIND/)
          const kept = await Effect.runPromise(blindAdmin.revoke(Duration.seconds(5)))
          assert.equal(kept.kind, 'kept-live')
          assert.ok(existsSync(join(home, 'browser', 'user-data')), 'the uncertain copy was kept')
          const status = await Effect.runPromise(blindAdmin.status)
          assert.equal(status.owner.kind, 'live')
          if (status.owner.kind === 'live')
            assert.match(
              status.owner.activity.unobserved ?? '',
              /not observed gone/,
              'status names the unverified shutdown'
            )
          assert.equal(status.profile.inUse, true, 'the owner kept the profile lock')
          await Effect.runPromise(blindAdmin.enable)
          const enabled = await Effect.runPromise(blindAdmin.status)
          assert.equal(enabled.profile.enabled, true)
          assert.equal(
            enabled.profile.inUse,
            true,
            'enabling did not erase the unsettled ownership'
          )
          assert.ok(existsSync(join(home, 'browser', 'user-data')), 'enabling deleted nothing')
        } finally {
          rmSync(flag, { force: true })
          process.env.PATH = path
        }
        const removed = await Effect.runPromise(blindAdmin.revoke(Duration.seconds(15)))
        assert.equal(removed.kind, 'removed', 'settlement observed later allows removal')
        await assertCopyReleased(
          { ...profileOptions, dataHome: home },
          'after observation recovered'
        )
      }
    )
    await claim(
      'a helper that never reports prepared is killed by the bootstrapping lead after ten seconds, leaves no owner and lets the next bootstrap succeed',
      async () => {
        const home = join(fixture, 'hanging')
        mkdirSync(home, { mode: 0o700 })
        const before = ownerProcesses()
        selectOwnerFixture({ ...baseFixture, hang: true })
        const started = Date.now()
        const exit = await Effect.runPromiseExit(
          Effect.scoped(
            Effect.flatMap(
              makeSessionRenderer({
                dataHome: home,
                ensureOwner: ownerBootstrap(home, failures).ensure,
              }),
              renderer => renderer.render(`${origin}/page.html?m=HANG`, MAX_HTML)
            )
          )
        )
        assert.ok(Exit.isFailure(exit))
        assert.match(String(Cause.squash(exit.cause)), /did not become ready within ten seconds/)
        assert.ok(Date.now() - started < 15_000, 'the bootstrap budget bounded the wait')
        await sleep(300)
        assert.equal(ownerProcesses(), before, 'the hanging helper was killed')
        assert.ok(!ownerPublished(home))
        selectOwnerFixture(baseFixture)
        const renderer = await openRenderer(home, newScope(), failures)
        const page = await Effect.runPromise(
          renderer.render(`${origin}/page.html?m=AFTERHANG`, MAX_HTML)
        )
        assert.match(text(page.html), /MARKER AFTERHANG/)
      }
    )
    await claim(
      'an owner that no client reaches within its first-client grace exits on its own and unpublishes itself',
      async () => {
        const home = join(fixture, 'unvisited')
        mkdirSync(home, { mode: 0o700 })
        selectOwnerFixture({ ...baseFixture, firstClientGraceMs: 1000 })
        assert.match(await startOwner(home), /started/)
        assert.ok(ownerPublished(home), 'the owner published after commit')
        await sleep(2500)
        assert.ok(!ownerPublished(home), 'the unvisited owner exited within its grace')
        selectOwnerFixture(baseFixture)
      }
    )
    await claim(
      'two leads bootstrapping the same data home at once produce exactly one owner, and both can render through it',
      async () => {
        const home = join(fixture, 'raced')
        mkdirSync(home, { mode: 0o700 })
        const before = ownerProcesses()
        const [first, second] = await Promise.all([startOwner(home), startOwner(home)])
        await sleep(500)
        assert.equal(ownerProcesses(), before + 1, 'the losing helper exited; one owner remains')
        assert.match(first, /started/)
        assert.match(second, /started/)
        const published = JSON.parse(readFileSync(join(home, 'browser', 'owner.json'), 'utf8')) as {
          pid: number
        }
        const scope = newScope()
        const [a, b] = await Promise.all([
          openRenderer(home, scope, failures),
          openRenderer(home, scope, failures),
        ])
        const [pa, pb] = await Promise.all([
          Effect.runPromise(a.render(`${origin}/page.html?m=RACEA`, MAX_HTML)),
          Effect.runPromise(b.render(`${origin}/page.html?m=RACEB`, MAX_HTML)),
        ])
        assert.match(text(pa.html), /MARKER RACEA/)
        assert.match(text(pb.html), /MARKER RACEB/)
        const after = JSON.parse(readFileSync(join(home, 'browser', 'owner.json'), 'utf8')) as {
          pid: number
        }
        assert.equal(after.pid, published.pid, 'the owner that won the gate still serves')
      }
    )
    await claim(
      'a helper whose bootstrap channel closes after prepared but before commit exits without publishing, starting no Chrome and leaving the data home free',
      async () => {
        const home = join(fixture, 'eof-before-commit')
        mkdirSync(home, { mode: 0o700 })
        selectOwnerFixture(baseFixture)
        const helper = fork(fileURLToPath(OWNER_ENTRY), [], {
          detached: true,
          execArgv: [],
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          env: { ...process.env, DEV_DATA_HOME: home },
        })
        const prepared = new Promise<unknown>(resolve => {
          helper.on('message', (message: unknown) => {
            if (
              typeof message === 'object' &&
              message !== null &&
              'type' in message &&
              message.type === 'prepared'
            )
              resolve(message)
          })
        })
        const exited = new Promise<number | null>(resolve =>
          helper.once('exit', code => resolve(code))
        )
        helper.send({ type: 'prepare', dataHome: home })
        await prepared
        assert.ok(!ownerPublished(home), 'nothing is published before commit')
        helper.disconnect()
        const code = await Promise.race([exited, sleep(5000).then(() => 'timeout' as const)])
        assert.notEqual(code, 'timeout', 'the helper exited on bootstrap EOF before commit')
        assert.ok(!ownerPublished(home))
        assert.ok(!existsSync(join(home, 'browser', 'user-data')), 'no Chrome copy was made')
        const renderer = await openRenderer(home, newScope(), failures)
        const page = await Effect.runPromise(
          renderer.render(`${origin}/page.html?m=AFTEREOF`, MAX_HTML)
        )
        assert.match(text(page.html), /MARKER AFTEREOF/)
      }
    )
    await claim(
      'enable issued during a revocation is serialized after it: no deletion follows the enable, and the copy ends enabled and intact',
      async () => {
        const home = join(fixture, 'raced')
        const racedAdmin = makeBrowserAdmin({ ...profileOptions, dataHome: home })
        const busy = await openRenderer(home, newScope(), failures)
        const pending = Effect.runFork(busy.render(`${origin}/slow.html?m=ORDER`, MAX_HTML))
        await sleep(400)
        const order: string[] = []
        const revoke = Effect.runPromise(racedAdmin.revoke(Duration.millis(1500))).then(outcome => {
          order.push(`revoke:${outcome.kind}`)
          return outcome
        })
        await sleep(100)
        const enable = Effect.runPromise(racedAdmin.enable).then(() => {
          order.push('enable')
        })
        const [kept] = await Promise.all([revoke, enable])
        assert.equal(kept.kind, 'kept-live')
        assert.deepEqual(order, ['revoke:kept-live', 'enable'], 'enable waited for the revocation')
        await Effect.runPromise(Fiber.interrupt(pending))
        await sleep(300)
        const status = await Effect.runPromise(racedAdmin.status)
        assert.equal(status.profile.enabled, true)
        assert.ok(existsSync(join(home, 'browser', 'user-data')), 'the copy survived the enable')
        const page = await Effect.runPromise(busy.render(`${origin}/page.html?m=ENABLED`, MAX_HTML))
        assert.match(text(page.html), /MARKER ENABLED/)
      }
    )
    await claim(
      'a stale locator left by a dead owner does not block a fresh owner, and status reports the absent owner honestly',
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
  for (const scope of scopes.splice(0)) await closeScope(scope)
  for (const home of [
    dataHome,
    join(fixture, 'unlaunchable'),
    join(fixture, 'unobserved'),
    join(fixture, 'hanging'),
    join(fixture, 'unvisited'),
    join(fixture, 'raced'),
    join(fixture, 'eof-before-commit'),
  ])
    for (let attempt = 0; attempt < 100 && ownerPublished(home); attempt += 1) await sleep(100)
  server.close()
  rmSync(fixture, { recursive: true, force: true })
}

console.log(JSON.stringify({ result: 'passed', checks: passed }, null, 2))
