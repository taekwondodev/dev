import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Scope from 'effect/Scope'
import type { makeBrowserAdmin } from '../../src/web-browser-owner.ts'
import { CHROME_EXECUTABLES, findChrome } from '../../src/web-profile.ts'
import { waitUntil } from '../wait.ts'
import { makeChromeSource, ownerExited, selectOwnerFixture } from './chrome-fixture.ts'

const SECRET = 'owner-fixture-token'
const BLOCKED = 'blocked.fixture.invalid'
export const MAX_HTML = 2 * 1024 * 1024

export const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
export const text = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

export const processGroup = (pid: number): string =>
  execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim()

type BrowserAdmin = ReturnType<typeof makeBrowserAdmin>

export const activityOf = async (
  of: BrowserAdmin
): Promise<{ queued: number; rendering: number; clients: number }> => {
  const status = await Effect.runPromise(of.status)
  return status.owner.kind === 'live'
    ? status.owner.activity
    : { queued: -1, rendering: -1, clients: -1 }
}

export const renderInFlight = (admin: BrowserAdmin) =>
  waitUntil(
    'the slow render to be in flight',
    () => activityOf(admin),
    activity => activity.rendering >= 1
  )

export const makeBrowserOwnerCheckFixture = async () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'dev-web-owner-')))
  const namespacePath = join(fixture, 'authority')
  mkdirSync(namespacePath, { recursive: true, mode: 0o700 })

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
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server has no port')
  const { port } = address
  const origin = `http://app.fixture.invalid:${port}`

  const chrome = findChrome(CHROME_EXECUTABLES)
  const source = makeChromeSource(fixture, { host: 'app.fixture.invalid', port })
  source.writeCookies(SECRET)
  const profileOptions = (dataHome: string) => ({
    dataHome,
    sourceUserData: source.userData,
    chromeExecutables: CHROME_EXECUTABLES,
  })
  const ownerPids = join(fixture, 'owner-pids')
  mkdirSync(ownerPids)
  const baseFixture = {
    sourceUserData: source.userData,
    chromeExecutables: CHROME_EXECUTABLES,
    chromeArguments: ['--host-resolver-rules=MAP *.fixture.invalid 127.0.0.1'],
    browserIdleMs: 5000,
    firstClientGraceMs: 30_000,
    installationPath: fixture,
    namespacePath,
    allowSuffix: '.fixture.invalid',
    blockedHosts: [BLOCKED],
    slowHosts: {},
    pidDirectory: ownerPids,
  }
  selectOwnerFixture(baseFixture)

  const failures: string[] = []
  const scopes: Scope.Closeable[] = []
  const newScope = (): Scope.Closeable => {
    const scope = Scope.makeUnsafe()
    scopes.push(scope)
    return scope
  }
  const closeClients = async () => {
    for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void))
  }
  const close = async (homes: readonly string[]) => {
    await closeClients()
    for (const home of homes) await ownerExited(home).catch(() => false)
    server.close()
    rmSync(fixture, { recursive: true, force: true })
  }

  return {
    fixture,
    chrome,
    source,
    seen,
    origin,
    profileOptions,
    baseFixture,
    ownerPids,
    failures,
    newScope,
    closeClients,
    close,
  }
}
