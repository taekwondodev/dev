import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Cause, Deferred, Duration, Effect, Exit, Scope } from 'effect'
import { makeClaims } from '../workspace/workspace-check-support.ts'
import {
  assertCopyReleased,
  makeChromeSource,
  openRenderer,
  ownerPublished,
  selectOwnerFixture,
} from './chrome-fixture.ts'
import { CHROME_EXECUTABLES, findChrome, makeBrowserProfileOwner } from '../../src/web-profile.ts'
import { makeBrowserAdmin } from '../../src/web-browser-owner.ts'
import { BrowserError, makeRenderHost, type CdpClient } from '../../src/web-browser.ts'
import { makeWebReader, type ReadOutcome, type WebReader } from '../../src/web-reader.ts'
import {
  fetchPublic,
  isPublicAddress,
  makeAddressResolver,
  validateUrl,
  WebNetworkError,
  type AddressResolver,
} from '../../src/web-network.ts'
import { toResult, toText } from '../../src/web-extension.ts'

const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'dev-web-read-')))
const dataHome = join(fixture, 'data')
mkdirSync(dataHome, { mode: 0o700 })
const SECRET = 'fixture-secret-token'
const ROTATED = 'fixture-rotated-token'
const { claim, passed } = makeClaims()

interface Seen {
  readonly url: string
  readonly headers: IncomingMessage['headers']
}
const seen: Seen[] = []
const hanging: ServerResponse[] = []
const BLOCKED_HOST = 'blocked.fixture.invalid'
let inFlight = 0
let maxInFlight = 0
const LONG = Array.from(
  { length: 400 },
  (_, index) => `## Section ${index}\n\nParagraph ${index} ${'lorem ipsum '.repeat(12)}\n`
).join('\n')
const server = createServer((request, response) => {
  seen.push({ url: request.url ?? '', headers: request.headers })
  const url = new URL(request.url ?? '/', 'http://fixture')
  const reply = (
    status: number,
    type: string,
    body: string,
    headers: Record<string, string> = {}
  ) => {
    response.writeHead(status, { 'content-type': type, ...headers })
    response.end(body)
  }
  switch (url.pathname) {
    case '/doc.md':
      return reply(
        200,
        'text/markdown; charset=utf-8',
        '# Fixture Guide\n\nIntro paragraph.\n\n## Install\n\nSee [the API](./api.md) and [home](/).\n'
      )
    case '/long.md':
      return reply(200, 'text/markdown', LONG)
    case '/page.html':
      return reply(
        200,
        'text/html; charset=utf-8',
        `<!doctype html><html><head><title>Fixture Page</title></head><body><nav><a href="/nav">Nav</a></nav><main><h1>Fixture Heading</h1><p>Body text with a <a href="/relative/link">relative link</a> and <code>inline code</code>.</p><pre><code class="language-ts">const x = 1</code></pre><ul><li>first</li><li>second</li></ul>${'<p>Padding paragraph to make the main content long enough for extraction.</p>'.repeat(4)}</main><footer>footer</footer></body></html>`
      )
    case '/js.html':
      return reply(
        200,
        'text/html',
        `<!doctype html><html><head><title>JS Only</title></head><body><div id="root">loading</div><img src="http://blocked.fixture.invalid:${port}/pixel.gif"><script src="/js.js"></script></body></html>`
      )
    case '/js.js':
      return reply(
        200,
        'text/javascript',
        'fetch("/data.json").then(r => r.json()).then(d => { document.getElementById("root").innerHTML = "<h1>" + d.heading + "</h1><p>" + d.body + "</p>" })'
      )
    case '/data.json':
      return reply(
        200,
        'application/json',
        JSON.stringify({ heading: 'Rendered Heading', body: 'Rendered body from JSON.' })
      )
    case '/account': {
      const cookie = request.headers.cookie ?? ''
      const markers = [
        [SECRET, 'ACCOUNT MARKER ORIGINAL'],
        [ROTATED, 'ACCOUNT MARKER ROTATED'],
      ] as const
      const marker =
        markers.find(([token]) => cookie.includes(`session=${token}`))?.[1] ?? 'ANONYMOUS VISITOR'
      return reply(
        200,
        'text/html',
        `<!doctype html><html><head><title>Account</title></head><body><div id="root">loading</div><script>document.getElementById("root").innerHTML = "<h1>${marker}</h1><p>" + "Account page body. ".repeat(20) + "</p>"</script></body></html>`
      )
    }
    case '/redirect-ok':
      return reply(302, 'text/plain', '', { location: '/doc.md' })
    case '/redirect-private':
      return reply(302, 'text/plain', '', { location: 'http://10.0.0.1/secret' })
    case '/redirect-loop':
      return reply(302, 'text/plain', '', { location: '/redirect-loop' })
    case '/big.txt':
      return reply(200, 'text/plain', 'x'.repeat(200_000))
    case '/forbidden.html':
      return reply(403, 'text/html', '<html><body><p>Forbidden</p></body></html>')
    case '/llms.txt':
      return reply(200, 'text/plain', '# Index\n- /doc.md\n')
    case '/ws.html':
      return reply(
        200,
        'text/html',
        `<!doctype html><html><head><title>WS</title></head><body><div id="root">loading</div><script>try { new WebSocket("ws://blocked.fixture.invalid:${port}/ws"); document.getElementById("root").textContent = "websocket opened" } catch (error) { document.getElementById("root").textContent = "websocket refused: " + error.name }</script></body></html>`
      )
    case '/huge.html':
      return reply(
        200,
        'text/html',
        '<!doctype html><html><head><title>Huge</title></head><body><main id="root">loading</main><script>document.getElementById("root").innerHTML = "<p>" + "huge ".repeat(60000) + "</p>"</script></body></html>'
      )
    case '/workers.html': {
      const nested = `try { new WebSocket("ws://${BLOCKED_HOST}:${port}/nested-ws"); postMessage("nested websocket opened") } catch (e) { postMessage("nested websocket refused: " + e.name) }`
      const worker = `const report = []
const nested = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(nested)}], { type: "text/javascript" })))
const nestedDone = new Promise(resolve => { nested.onmessage = e => { report.push(e.data); resolve() } })
fetch("http://${BLOCKED_HOST}:${port}/worker-fetch").then(r => report.push("worker fetch " + r.status), e => report.push("worker fetch refused: " + e.name)).then(() => nestedDone).then(() => {
  try { new WebSocket("ws://${BLOCKED_HOST}:${port}/worker-ws"); report.push("worker websocket opened") } catch (e) { report.push("worker websocket refused: " + e.name) }
  try { new WebTransport("https://${BLOCKED_HOST}:${port}/worker-wt"); report.push("worker webtransport opened") } catch (e) { report.push("worker webtransport refused: " + e.name) }
  postMessage(report.join("\\n"))
})`
      return reply(
        200,
        'text/html',
        `<!doctype html><html><head><title>Workers</title></head><body><pre id="root">loading
</pre><script>
const log = line => { document.getElementById("root").textContent += line + "\\n" }
window.onerror = message => log("page error: " + message)
const code = ${JSON.stringify(worker)}
const worker = new Worker(URL.createObjectURL(new Blob([code], { type: "text/javascript" })))
worker.onmessage = event => log(event.data)
try { new SharedWorker(URL.createObjectURL(new Blob(["onconnect = () => {}"], { type: "text/javascript" }))); log("shared worker created") } catch (e) { log("shared worker refused: " + e.name) }
log("service worker: " + (navigator.serviceWorker === undefined ? "absent" : "present"))
try { new RTCPeerConnection(); log("rtc opened") } catch (e) { log("rtc refused: " + e.name) }
try { new WebTransport("https://${BLOCKED_HOST}:${port}/wt"); log("webtransport opened") } catch (e) { log("webtransport refused: " + e.name) }
</script><img src="/slow.gif"></body></html>`
      )
    }
    case '/late.html':
      return reply(
        200,
        'text/html',
        `<!doctype html><html><head><title>Late</title></head><body><div id="root">loading</div><script>
document.getElementById("root").innerHTML = "<h1>Late requests</h1><p>" + "A page whose requests outlive the render. ".repeat(12) + "</p>"
fetch("http://slow.fixture.invalid:${port}/slow-admit", { keepalive: true }).catch(() => {})
addEventListener("pagehide", () => {
  navigator.sendBeacon("http://${BLOCKED_HOST}:${port}/beacon", "bye")
  fetch("http://${BLOCKED_HOST}:${port}/keepalive", { keepalive: true }).catch(() => {})
})
</script></body></html>`
      )
    case '/subredirect.html':
      return reply(
        200,
        'text/html',
        `<!doctype html><html><head><title>Subredirect</title></head><body><div id="root">loading</div><script>document.getElementById("root").innerHTML = "<h1>Redirected image</h1><p>" + "An image whose origin redirects to a private host. ".repeat(10) + "</p>"</script><img src="/redirect-blocked"></body></html>`
      )
    case '/redirect-blocked':
      return reply(302, 'text/plain', '', {
        location: `http://${BLOCKED_HOST}:${port}/redirected.gif`,
      })
    case '/blob-download.html':
      return reply(
        200,
        'text/html',
        `<!doctype html><html><head><title>Blob download</title></head><body><div id="root">loading</div><script>
document.getElementById("root").innerHTML = "<h1>Blob download page</h1><p>" + "A page that clicks download links. ".repeat(10) + "</p>"
const blob = document.createElement("a"); blob.href = URL.createObjectURL(new Blob(["blob bytes"])); blob.download = "dev-fixture-blob.txt"; document.body.append(blob); blob.click()
const anchor = document.createElement("a"); anchor.href = "/attachment"; anchor.download = "dev-fixture-anchor.txt"; document.body.append(anchor); anchor.click()
</script><img src="/slow.gif"></body></html>`
      )
    case '/download.html':
      return reply(
        200,
        'text/html',
        `<!doctype html><html><head><title>Download</title></head><body><div id="root">loading</div><script>document.getElementById("root").innerHTML = "<h1>Download page</h1><p>" + "A page that tries to save a file through an attachment frame. ".repeat(6) + "</p>"</script><iframe src="/attachment"></iframe><img src="/slow.gif"></body></html>`
      )
    case '/attachment':
      return reply(200, 'application/octet-stream', 'attached bytes', {
        'content-disposition': 'attachment; filename="dev-fixture-download.txt"',
      })
    case '/slow.gif':
      setTimeout(() => reply(200, 'image/gif', ''), 1500)
      return
    case '/hanging.html':
      return reply(
        200,
        'text/html',
        '<!doctype html><html><head><title>Hanging</title></head><body><div id="root">loading</div><script src="/hang.js"></script></body></html>'
      )
    case '/hang.js':
      hanging.push(response)
      return
    case '/slow-app.html':
      setTimeout(
        () =>
          reply(
            200,
            'text/html',
            '<!doctype html><html><head><title>Slow app</title></head><body><div id="root">loading</div><script>document.getElementById("root").innerHTML = "<h1>Slow app</h1><p>" + "Served late. ".repeat(20) + "</p>"</script></body></html>'
          ),
        800
      )
      return
    case '/slow-doc.md': {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      setTimeout(() => {
        inFlight -= 1
        reply(200, 'text/markdown', '# Slow\n\nslow body\n')
      }, 300)
      return
    }
    default:
      return reply(404, 'text/plain', 'not found')
  }
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
const address = server.address()
if (address === null || typeof address === 'string') throw new Error('fixture server has no port')
const { port } = address
const origin = `http://app.fixture.invalid:${port}`

let lookups = 0
const refusedFixture = (host: string) =>
  Effect.fail(
    new WebNetworkError({
      reason: 'destination',
      message: `${host} refused by the fixture resolver`,
    })
  )
const fixtureResolver: AddressResolver = host => {
  lookups += 1
  if (host === BLOCKED_HOST) return refusedFixture(host)
  if (host === 'slow.fixture.invalid')
    return Effect.succeed('127.0.0.1').pipe(Effect.delay(Duration.seconds(3)))
  if (host === 'mixed.fixture.invalid')
    return makeAddressResolver(() =>
      Promise.resolve([{ address: '93.184.216.34' }, { address: '10.0.0.1' }])
    )(host)
  if (host === 'rebind.fixture.invalid')
    return lookups % 2 === 1 ? Effect.succeed('127.0.0.1') : refusedFixture(host)
  if (host.endsWith('.fixture.invalid')) return Effect.succeed('127.0.0.1')
  return refusedFixture(host)
}
const source = makeChromeSource(fixture, { host: 'app.fixture.invalid', port })
const { userData: sourceUserData, cookiesPath, writeCookies } = source
writeCookies(SECRET)
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const sourceBefore = sha(cookiesPath)
let rotatedBefore = sourceBefore
const localStateBefore = sha(join(sourceUserData, 'Local State'))

const chrome = findChrome(CHROME_EXECUTABLES)
const profileOptions = { dataHome, sourceUserData, chromeExecutables: CHROME_EXECUTABLES }
mkdirSync(join(fixture, 'authority'), { recursive: true, mode: 0o700 })
selectOwnerFixture({
  sourceUserData,
  chromeExecutables: CHROME_EXECUTABLES,
  chromeArguments: ['--host-resolver-rules=MAP *.fixture.invalid 127.0.0.1'],
  browserIdleMs: 30_000,
  firstClientGraceMs: 120_000,
  installationPath: fixture,
  namespacePath: join(fixture, 'authority'),
  allowSuffix: '.fixture.invalid',
  blockedHosts: [BLOCKED_HOST],
  slowHosts: { 'slow.fixture.invalid': 3000 },
})
const admin = makeBrowserAdmin(profileOptions)
const readerScope = Scope.makeUnsafe()
const openReader = (
  overrides: Partial<Parameters<typeof makeWebReader>[0]> = {},
  scope = readerScope
) =>
  Effect.runPromise(
    Scope.provide(scope)(
      Effect.flatMap(
        Effect.promise(() => openRenderer(dataHome, scope)),
        renderer =>
          makeWebReader({
            renderer,
            resolveAddress: fixtureResolver,
            fetchLimits: { maxBytes: 96 * 1024, maxRedirects: 3, timeout: Duration.seconds(20) },
            ...overrides,
          })
      )
    )
  )
const outputs: string[] = []
const read = async (
  reader: WebReader,
  request: Parameters<WebReader['read']>[0],
  signal?: AbortSignal
) => {
  const outcome = await Effect.runPromise(reader.read(request, signal))
  const result = toResult(outcome)
  outputs.push(JSON.stringify(result), toText(outcome, result))
  return outcome
}
const documentOf = (outcome: ReadOutcome) => {
  assert.equal(outcome.kind, 'document', outcome.kind === 'failed' ? outcome.error : '')
  if (outcome.kind !== 'document') throw new Error('unreachable')
  return outcome.slice
}
const continuationOf = (outcome: ReadOutcome): string | undefined =>
  outcome.kind === 'document' ? outcome.slice.continuation : undefined
const failureOf = (outcome: ReadOutcome) => {
  assert.equal(outcome.kind, 'failed')
  if (outcome.kind !== 'failed') throw new Error('unreachable')
  return outcome.error
}
try {
  await claim(
    'a target created before attach failure is closed with exactly one owned-target close command',
    async () => {
      const calls: { method: string; params: unknown }[] = []
      const closed = await Effect.runPromise(Deferred.make<void, BrowserError>())
      const cdp: CdpClient = {
        closed,
        subscribe: () => () => {},
        send: (method, params = {}) => {
          calls.push({ method, params })
          if (method === 'Target.createTarget') return Effect.succeed({ targetId: 'owned-target' })
          if (method === 'Target.attachToTarget')
            return Effect.fail(new BrowserError({ reason: 'protocol', message: 'attach failed' }))
          return Effect.void
        },
      }
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const host = yield* makeRenderHost({ cdp, pid: 1 }, { admit: () => Effect.void })
            yield* Effect.ignore(
              host.render('https://example.com/', {
                timeout: Duration.seconds(1),
                maxHtmlChars: 1000,
              })
            )
          })
        )
      )
      assert.deepEqual(
        calls.filter(call => call.method === 'Target.closeTarget'),
        [{ method: 'Target.closeTarget', params: { targetId: 'owned-target' } }]
      )
    }
  )
  await claim(
    'URL policy refuses non-http schemes, credentials, literal private hosts and local names before any connection',
    async () => {
      for (const [url, pattern] of [
        ['ftp://example.com/x', /Only http and https/],
        ['https://user:pw@example.com/', /credentials/],
        ['http://10.0.0.1/', /Private or reserved/],
        ['http://[::1]/', /Private or reserved/],
        ['http://169.254.169.254/latest/meta-data', /Private or reserved/],
        ['http://localhost/', /Non-public host/],
        ['http://intranet.local/', /Non-public host/],
        ['http://home.arpa/', /Non-public host/],
        ['http://printer.home.arpa/', /Non-public host/],
        ['http://0x7f000001/', /Private or reserved/],
        ['not a url', /Not an absolute URL/],
      ] as const) {
        const exit = await Effect.runPromiseExit(validateUrl(url))
        assert.ok(Exit.isFailure(exit), url)
        assert.match(String(Cause.squash(exit.cause)), pattern, url)
      }
      assert.equal(
        (await Effect.runPromise(validateUrl('https://Example.com/a#frag'))).href,
        'https://example.com/a'
      )
      assert.equal(seen.length, 0)
    }
  )
  await claim(
    'address classification treats IPv4-mapped, NAT64, 6to4, link-local, CGNAT and multicast ranges as non-public and real public ranges as public',
    () => {
      for (const blocked of [
        '::ffff:127.0.0.1',
        '::ffff:10.0.0.1',
        '64:ff9b::7f00:1',
        '2002:7f00:1::',
        'fe80::1',
        'fc00::1',
        '100.64.0.1',
        '224.0.0.1',
        '0.0.0.0',
        '255.255.255.255',
        '::',
      ])
        assert.equal(isPublicAddress(blocked), false, blocked)
      for (const open of [
        '104.21.62.67',
        '::ffff:8.8.8.8',
        '2606:4700::1',
        '100.128.0.1',
        '1.1.1.1',
      ])
        assert.equal(isPublicAddress(open), true, open)
    }
  )
  await claim(
    'mixed DNS answers with any private address fail before connecting, and a rebinding answer cannot redirect a pinned connection',
    async () => {
      const mixed = await Effect.runPromiseExit(
        fetchPublic(`http://mixed.fixture.invalid:${port}/doc.md`, { resolve: fixtureResolver })
      )
      assert.ok(Exit.isFailure(mixed))
      assert.match(String(Cause.squash(mixed.cause)), /private or reserved address \(10\.0\.0\.1\)/)
      assert.equal(seen.length, 0, 'nothing connected')
      lookups = 0
      const pinned = await Effect.runPromise(
        fetchPublic(`http://rebind.fixture.invalid:${port}/doc.md`, { resolve: fixtureResolver })
      )
      assert.equal(pinned.status, 200)
      assert.equal(lookups, 1, 'one resolution per hop; the connection used the validated address')
      assert.equal(seen.at(-1)?.headers.host, `rebind.fixture.invalid:${port}`)
      assert.match(seen.at(-1)?.headers.accept ?? '', /^text\/markdown/)
      const rebound = await Effect.runPromiseExit(
        fetchPublic(`http://rebind.fixture.invalid:${port}/doc.md`, { resolve: fixtureResolver })
      )
      assert.ok(
        Exit.isFailure(rebound),
        'the next resolution answered a private address and was refused'
      )
    }
  )
  await claim(
    'redirects to private targets and redirect loops are refused with the requested URL preserved; a validated redirect reports both URLs',
    async () => {
      seen.length = 0
      const refused = await Effect.runPromiseExit(
        fetchPublic(`${origin}/redirect-private`, { resolve: fixtureResolver })
      )
      assert.ok(Exit.isFailure(refused))
      assert.match(
        String(Cause.squash(refused.cause)),
        /Redirect from .*redirect-private refused: Private or reserved/
      )
      assert.deepEqual(
        seen.map(item => item.url),
        ['/redirect-private'],
        'the private target was never requested'
      )
      const loop = await Effect.runPromiseExit(
        fetchPublic(`${origin}/redirect-loop`, {
          limits: { maxBytes: 1024, maxRedirects: 2, timeout: Duration.seconds(10) },
          resolve: fixtureResolver,
        })
      )
      assert.match(
        String(Cause.squash(Exit.isFailure(loop) ? loop.cause : Cause.die('passed'))),
        /redirected more than 2 times/
      )
      const ok = await Effect.runPromise(
        fetchPublic(`${origin}/redirect-ok`, { resolve: fixtureResolver })
      )
      assert.equal(ok.requestedUrl, `${origin}/redirect-ok`)
      assert.equal(ok.finalUrl, `${origin}/doc.md`)
      assert.deepEqual(ok.redirects, [`${origin}/doc.md`])
    }
  )

  await claim(
    'static reads are bounded by the configured concurrency even when a script fans out many parallel calls',
    async () => {
      const bounded = await openReader({ staticConcurrency: 2 })
      const outcomes = await Promise.all(
        Array.from({ length: 6 }, () => read(bounded, { url: `${origin}/slow-doc.md` }))
      )
      for (const outcome of outcomes) documentOf(outcome)
      assert.equal(maxInFlight, 2, 'never more than two static fetches in flight')
    }
  )
  const reader = await openReader()
  await claim(
    'a Markdown origin yields the requested document with headings, absolute links, index suggestions and no browser launch',
    async () => {
      seen.length = 0
      const slice = documentOf(await read(reader, { url: `${origin}/doc.md` }))
      assert.equal(slice.document.method, 'markdown')
      assert.equal(slice.document.title, 'Fixture Guide')
      assert.equal(slice.document.requestedUrl, `${origin}/doc.md`)
      assert.equal(slice.document.finalUrl, `${origin}/doc.md`)
      assert.match(slice.text, /^# Fixture Guide\n\nIntro paragraph\.\n\n## Install/)
      assert.deepEqual(slice.document.links, [
        { text: 'the API', url: `${origin}/api.md` },
        { text: 'home', url: `${origin}/` },
      ])
      assert.deepEqual(
        slice.document.suggestions.map(link => link.url),
        [`${origin}/llms.txt`, `${origin}/llms-full.txt`]
      )
      assert.equal(slice.complete, true)
      assert.equal(slice.continuation, undefined)
      assert.deepEqual(
        seen.map(item => item.url),
        ['/doc.md'],
        'static content requested nothing else and launched no browser'
      )
      assert.ok(!existsSync(join(dataHome, 'browser', 'user-data')), 'no profile copy was made')
      assert.equal(seen[0]?.headers.cookie, undefined, 'static retrieval sends no cookies')
      const result = toResult({ kind: 'document', slice })
      assert.equal(result.outcome, 'document')
    }
  )
  await claim(
    'an HTML origin is extracted locally into Markdown with its title, heading, code block, list and absolute links, and never reports the index as the requested document',
    async () => {
      const slice = documentOf(await read(reader, { url: `${origin}/page.html` }))
      assert.equal(slice.document.method, 'html')
      assert.equal(slice.document.title, 'Fixture Page')
      assert.equal(slice.document.finalUrl, `${origin}/page.html`)
      assert.match(
        slice.text,
        /^# Fixture Heading\n\nBody text with a \[relative link\]\(http:\/\/app\.fixture\.invalid:\d+\/relative\/link\) and `inline code`\./
      )
      assert.match(slice.text, /```ts\nconst x = 1\n```/)
      assert.match(slice.text, /- first\n- second/)
      assert.ok(!slice.text.includes('Nav'), 'navigation was dropped')
      assert.deepEqual(
        slice.document.links.map(link => link.url),
        [`${origin}/relative/link`]
      )
      assert.ok(slice.document.suggestions.every(link => link.url !== slice.document.finalUrl))
    }
  )
  await claim(
    'continuation reconstructs a long fixture exactly from the same snapshot without refetching, and a stale or foreign token is refused explicitly',
    async () => {
      seen.length = 0
      let outcome = await read(reader, { url: `${origin}/long.md`, maxChars: 5000 })
      const first = documentOf(outcome)
      assert.equal(first.complete, false)
      assert.ok(first.continuation)
      let { text } = first
      let parts = 1
      for (
        let token: string | undefined = first.continuation;
        token !== undefined;
        token = continuationOf(outcome)
      ) {
        outcome = await read(reader, { continuation: token, maxChars: 5000 })
        const next = documentOf(outcome)
        assert.equal(next.document.finalUrl, `${origin}/long.md`)
        text += next.text
        parts += 1
      }
      assert.ok(parts > 3)
      assert.equal(text, LONG.trim())
      assert.deepEqual(
        seen.map(item => item.url),
        ['/long.md'],
        'continuation fetched nothing'
      )
      assert.match(
        failureOf(await read(reader, { continuation: 'not-a-token' })),
        /not one this session issued/
      )
      assert.match(
        failureOf(
          await read(reader, {
            continuation: `${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}@0`,
          })
        ),
        /no longer held in session memory/
      )
    }
  )
  await claim(
    'the byte limit holds: an oversized body is cut, reported as partial with the limit named, and a refused redirect or 404 is an explicit failure or status limitation',
    async () => {
      const slice = documentOf(await read(reader, { url: `${origin}/big.txt`, maxChars: 120_000 }))
      assert.equal(slice.document.bodyTruncated, true)
      assert.equal(slice.document.text.length, 96 * 1024)
      assert.match(slice.document.limitations.join('\n'), /cut at 98304 bytes/)
      assert.equal(toResult({ kind: 'document', slice }).outcome, 'partial')
      assert.match(
        failureOf(await read(reader, { url: `${origin}/redirect-private` })),
        /Redirect .* refused/
      )
      const missing = documentOf(await read(reader, { url: `${origin}/missing` }))
      assert.equal(missing.document.status, 404)
      assert.match(missing.document.limitations.join('\n'), /HTTP 404/)
    }
  )

  if (chrome === undefined) {
    await claim(
      'without an installed Chrome, a script-dependent page returns its static text with an actionable limitation instead of silently passing as complete',
      async () => {
        const slice = documentOf(await read(reader, { url: `${origin}/js.html` }))
        assert.equal(slice.document.method, 'html')
        assert.match(
          slice.document.limitations.join('\n'),
          /browser rendering was unavailable: Google Chrome is not installed/
        )
      }
    )
  } else {
    await claim(
      'a JavaScript-only page is rendered by the installed Chrome from a disposable profile copy: rendered text appears, non-public subrequests are blocked before connecting, and the source profile is unchanged',
      async () => {
        seen.length = 0
        const slice = documentOf(await read(reader, { url: `${origin}/js.html` }))
        assert.equal(slice.document.method, 'browser')
        assert.match(slice.text, /# Rendered Heading\n\nRendered body from JSON\./)
        assert.equal(slice.document.title, 'JS Only')
        assert.ok(
          !seen.some(item => item.url === '/pixel.gif'),
          'the blocked subrequest never reached the server'
        )
        assert.match(
          slice.document.limitations.join('\n'),
          /1 browser subrequest\(s\) to non-public destinations were blocked/
        )
        assert.match(
          slice.document.limitations.join('\n'),
          /Static HTML extraction yielded too little readable text/
        )
        assert.equal(sha(cookiesPath), sourceBefore, 'the source cookie database is byte-identical')
        const state = JSON.parse(
          readFileSync(join(dataHome, 'browser', 'copy-state.json'), 'utf8')
        ) as { complete: boolean; source: string }
        assert.equal(state.complete, true)
        assert.equal(state.source, sourceUserData)
        assert.ok(existsSync(join(dataHome, 'browser', 'user-data', 'Default', 'Cookies')))
      }
    )
    await claim(
      'copied fixture cookies authenticate the rendered page, and a live copy refuses a second acquisition instead of being overwritten',
      async () => {
        const slice = documentOf(await read(reader, { url: `${origin}/account` }))
        assert.match(slice.text, /ACCOUNT MARKER ORIGINAL/)
        assert.ok(
          !JSON.stringify(toResult({ kind: 'document', slice })).includes(SECRET),
          'the cookie value is not in the result'
        )
        const other = makeBrowserProfileOwner(profileOptions)
        const status = await Effect.runPromise(other.status)
        assert.equal(status.inUse, true)
        const acquired = await Effect.runPromiseExit(other.acquire(Date.now()))
        assert.ok(Exit.isFailure(acquired))
        assert.match(String(Cause.squash(acquired.cause)), /in use by its browser owner/)
        assert.ok(
          existsSync(join(dataHome, 'browser', 'user-data', 'Default', 'Cookies')),
          'the live copy survived the refused acquisition'
        )
      }
    )
    await claim(
      'a fresh browser launch refreshes authentication data from the source, and the copy is released once the shared browser settles',
      async () => {
        assert.equal((await Effect.runPromise(admin.revoke(Duration.seconds(10)))).kind, 'removed')
        await Effect.runPromise(admin.enable)
        await assertCopyReleased(profileOptions, 'after the revocation settled the browser')
        writeCookies(ROTATED)
        rotatedBefore = sha(cookiesPath)
        const slice = documentOf(await read(reader, { url: `${origin}/account` }))
        assert.match(slice.text, /ACCOUNT MARKER ROTATED/)
      }
    )
    await claim(
      'a cookie database locked exclusively by Chrome fails the coherent snapshot with an actionable limitation on the static text, without launching',
      async () => {
        assert.equal((await Effect.runPromise(admin.revoke(Duration.seconds(10)))).kind, 'removed')
        await Effect.runPromise(admin.enable)
        const holder = new DatabaseSync(cookiesPath)
        holder.exec('BEGIN EXCLUSIVE')
        try {
          const slice = documentOf(await read(reader, { url: `${origin}/account` }))
          assert.equal(slice.document.method, 'html')
          assert.match(
            slice.document.limitations.join('\n'),
            /browser rendering was unavailable: .*could not be snapshotted coherently .*close Chrome or retry/
          )
        } finally {
          holder.exec('ROLLBACK')
          holder.close()
        }
        const status = await Effect.runPromise(makeBrowserProfileOwner(profileOptions).status)
        assert.equal(status.inUse, false)
        assert.equal(
          status.copy?.complete,
          false,
          'the interrupted refresh is recorded as incomplete'
        )
      }
    )
    await claim(
      'revocation disables further authenticated launches and removes only the dev-owned copy; enable restores it',
      async () => {
        const revoked = await Effect.runPromise(admin.revoke(Duration.seconds(10)))
        assert.equal(revoked.kind, 'removed')
        assert.ok(!existsSync(join(dataHome, 'browser', 'user-data')))
        assert.ok(existsSync(cookiesPath), 'the source profile is untouched')
        assert.equal(
          sha(cookiesPath),
          rotatedBefore,
          'the rotated cookie database is byte-identical'
        )
        assert.equal(sha(join(sourceUserData, 'Local State')), localStateBefore)
        const disabled = documentOf(await read(reader, { url: `${origin}/account` }))
        assert.equal(disabled.document.method, 'html')
        assert.match(
          disabled.document.limitations.join('\n'),
          /browser rendering was unavailable: .*disabled .* `dev browser enable`/
        )
        const status = await Effect.runPromise(admin.status)
        assert.equal(status.profile.enabled, false)
        assert.equal(status.profile.copy, undefined)
        await Effect.runPromise(admin.enable)
        assert.equal((await Effect.runPromise(admin.status)).profile.enabled, true)
      }
    )
    await claim(
      'rendered pages cannot open WebSocket connections to refused destinations: the handshake never reaches the server',
      async () => {
        seen.length = 0
        const slice = documentOf(await read(reader, { url: `${origin}/ws.html` }))
        assert.match(slice.text, /websocket refused/)
        assert.ok(!seen.some(item => item.url === '/ws'), 'no WebSocket upgrade reached the server')
      }
    )
    await claim(
      'a rendered page larger than the byte limit is cut, reported as partial with the limit named, and does not grow the lead process unbounded',
      async () => {
        const slice = documentOf(await read(reader, { url: `${origin}/huge.html` }))
        assert.equal(slice.document.method, 'browser')
        assert.equal(slice.document.bodyTruncated, true)
        assert.ok(slice.document.text.length <= 96 * 1024)
        assert.match(slice.document.limitations.join('\n'), /cut at 98304 characters of HTML/)
        assert.equal(toResult({ kind: 'document', slice }).outcome, 'partial')
      }
    )
    await claim(
      'worker subrequests are intercepted by the same policy, workers and pages cannot open WebSocket or WebTransport connections, and rendered pages cannot create shared workers, service workers or WebRTC peers',
      async () => {
        seen.length = 0
        const slice = documentOf(await read(reader, { url: `${origin}/workers.html` }))
        assert.match(slice.text, /worker fetch refused: TypeError/)
        assert.match(slice.text, /worker websocket refused/)
        assert.match(slice.text, /nested websocket refused/)
        assert.match(slice.text, /shared worker refused/)
        assert.match(slice.text, /service worker: absent/)
        assert.match(slice.text, /rtc refused/)
        assert.match(slice.text, /^webtransport refused: SecurityError/m)
        assert.match(slice.text, /worker webtransport refused: SecurityError/)
        assert.deepEqual(
          seen.map(item => item.url).filter(url => /^\/(worker-|nested-)/.test(url)),
          [],
          'no worker request reached the server'
        )
        assert.match(
          slice.document.limitations.join('\n'),
          /1 browser subrequest\(s\) to non-public destinations were blocked/
        )
      }
    )
    await claim(
      'a subrequest whose origin redirects to a non-public host is refused at the redirected hop, before connecting',
      async () => {
        seen.length = 0
        const slice = documentOf(await read(reader, { url: `${origin}/subredirect.html` }))
        assert.equal(slice.document.method, 'browser')
        assert.ok(
          seen.some(item => item.url === '/redirect-blocked'),
          'the first hop was fetched'
        )
        assert.ok(
          !seen.some(item => item.url === '/redirected.gif'),
          'the redirected hop never connected'
        )
        assert.match(
          slice.document.limitations.join('\n'),
          /1 browser subrequest\(s\) to non-public destinations were blocked/
        )
      }
    )
    await claim('blob and anchor downloads triggered by a rendered page land nowhere', async () => {
      seen.length = 0
      const slice = documentOf(await read(reader, { url: `${origin}/blob-download.html` }))
      assert.equal(slice.document.method, 'browser')
      assert.ok(
        seen.some(item => item.url === '/attachment'),
        'the anchor target was requested'
      )
      assert.deepEqual(readdirSync(source.downloads), [], 'nothing was downloaded')
    })
    await claim(
      'subrequests still undecided when the render ends, and requests issued while the page is torn down, are refused rather than released to Chrome',
      async () => {
        seen.length = 0
        const slice = documentOf(await read(reader, { url: `${origin}/late.html` }))
        assert.equal(slice.document.method, 'browser')
        assert.match(slice.text, /Late requests/)
        await sleep(1500)
        assert.deepEqual(
          seen.map(item => item.url).filter(url => url !== '/late.html'),
          [],
          'no late request reached the server'
        )
      }
    )
    await claim(
      'a rendered page cannot save files: an attachment frame is fetched but nothing lands in the download directory of the copied preferences',
      async () => {
        seen.length = 0
        const slice = documentOf(await read(reader, { url: `${origin}/download.html` }))
        assert.equal(slice.document.method, 'browser')
        assert.match(slice.text, /Download page/)
        assert.ok(
          seen.some(item => item.url === '/attachment'),
          'the attachment was requested'
        )
        assert.deepEqual(readdirSync(source.downloads), [], 'nothing was downloaded')
      }
    )
    await claim(
      'revoking while a dev session has Chrome open disables launches, keeps the live copy, says so, and completes once the browser settles',
      async () => {
        const owner = makeBrowserProfileOwner(profileOptions)
        const kept = await Effect.runPromise(owner.revoke(Duration.millis(600)))
        assert.equal(kept.kind, 'kept-live')
        assert.ok(existsSync(join(dataHome, 'browser', 'user-data', 'Default', 'Cookies')))
        assert.equal((await Effect.runPromise(owner.status)).enabled, false)
        documentOf(await read(reader, { url: `${origin}/account` }))
        await Effect.runPromise(reader.endSession('revoke test'))
        assert.match(
          documentOf(await read(reader, { url: `${origin}/account` })).document.limitations.join(
            '\n'
          ),
          /browser rendering was unavailable: .*disabled/
        )
        assert.equal((await Effect.runPromise(admin.revoke(Duration.seconds(10)))).kind, 'removed')
        await Effect.runPromise(admin.enable)
      }
    )
    await claim(
      'aborting a browser read during the launch or during the render cancels that render promptly and leaves the shared browser usable',
      async () => {
        const cancelled = await openReader()
        const abortAfter = async (ms: number) => {
          const controller = new AbortController()
          setTimeout(() => controller.abort(), ms)
          const started = Date.now()
          const failure = failureOf(
            await read(cancelled, { url: `${origin}/hanging.html` }, controller.signal)
          )
          assert.match(failure, /cancelled/)
          assert.ok(
            Date.now() - started < 5000,
            'the cancelled read returned before the render timeout'
          )
          for (const response of hanging.splice(0)) response.end('')
        }
        await abortAfter(40)
        documentOf(await read(cancelled, { url: `${origin}/js.html` }))
        await abortAfter(500)
        const slice = documentOf(await read(cancelled, { url: `${origin}/js.html` }))
        assert.match(slice.text, /Rendered Heading/)
        await Effect.runPromise(cancelled.endSession('abort test'))
      }
    )
    await claim(
      'ending the session while a render is in progress interrupts that read instead of waiting for it, and leaves the shared browser serving other clients',
      async () => {
        const ending = await openReader()
        const peer = await openReader()
        const pending = read(ending, { url: `${origin}/hanging.html` })
        await sleep(1500)
        const started = Date.now()
        await Effect.runPromise(ending.endSession('shutdown test'))
        assert.ok(
          Date.now() - started < 8000,
          'endSession returned without waiting for the render timeout'
        )
        assert.match(failureOf(await pending), /session ended/)
        for (const response of hanging.splice(0)) response.end('')
        assert.ok(ownerPublished(dataHome), 'the shared owner outlived the ended reader session')
        assert.match(
          documentOf(await read(peer, { url: `${origin}/js.html` })).text,
          /Rendered Heading/
        )
        await Effect.runPromise(peer.endSession('peer done'))
      }
    )
    await claim(
      'ending the session while a read is still fetching statically stops it before any rendering starts',
      async () => {
        const ending = await openReader()
        const pending = read(ending, { url: `${origin}/slow-app.html` })
        await sleep(200)
        await Effect.runPromise(ending.endSession('shutdown during static fetch'))
        assert.match(failureOf(await pending), /session ended/)
        await sleep(1500)
      }
    )
    await claim(
      'a 403 static answer escalates to the browser once and returns the authenticated rendering of that page',
      async () => {
        const slice = documentOf(await read(reader, { url: `${origin}/forbidden.html` }))
        assert.equal(slice.document.status, 403)
        assert.match(
          slice.document.limitations.join('\n'),
          /Static retrieval failed first|Static HTML extraction yielded too little readable text|browser rendering was unavailable/
        )
      }
    )
  }
  await claim(
    'no tool result, model-facing text or limitation produced during this run carries fixture credentials',
    () => {
      assert.ok(outputs.length > 20)
      const everything = JSON.stringify(outputs)
      assert.ok(!everything.includes(SECRET) && !everything.includes(ROTATED))
    }
  )
} finally {
  await Effect.runPromise(Scope.close(readerScope, Exit.void))
  for (let attempt = 0; attempt < 100 && ownerPublished(dataHome); attempt += 1) await sleep(100)
  server.close()
  rmSync(fixture, { recursive: true, force: true })
}

console.log(JSON.stringify({ result: 'passed', checks: passed }, null, 2))
