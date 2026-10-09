import { spawn, type ChildProcess } from 'node:child_process'
import { userInfo } from 'node:os'
import { resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { Deferred, Duration, Effect, Exit, Schedule, Schema, Scope, Semaphore } from 'effect'
import type { ChildProcessSpawner } from 'effect/process'
import { errorText } from './error-text.ts'
import { processObserver, type ObservedProcess } from './process-family.ts'
import type { WebNetworkError } from './web-network.ts'

export class BrowserError extends Schema.TaggedError<BrowserError>()('BrowserError', {
  reason: Schema.Literals(['launch', 'protocol', 'navigation', 'timeout', 'shutdown']),
  message: Schema.String,
}) {}

const fail = (reason: BrowserError['reason'], message: string) =>
  new BrowserError({ reason, message })

const CdpMessage = Schema.Struct({
  id: Schema.optional(Schema.Finite),
  sessionId: Schema.optional(Schema.String),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Unknown),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Struct({ code: Schema.Finite, message: Schema.String })),
})
type CdpMessage = typeof CdpMessage.Type
const decodeMessage = Schema.decodeUnknownResult(Schema.fromJsonString(CdpMessage))

export interface CdpEvent {
  readonly method: string
  readonly sessionId: string | undefined
  readonly params: unknown
}

export interface CdpClient {
  send(method: string, params?: unknown, sessionId?: string): Effect.Effect<unknown, BrowserError>
  subscribe(listener: (event: CdpEvent) => void): () => void
  readonly closed: Deferred.Deferred<void, BrowserError>
}

const MAX_CDP_MESSAGE_CHARS = 64 * 1024 * 1024

const makeCdpClient = Effect.fnUntraced(function* (
  input: Readable,
  output: Writable
): Effect.fn.Return<CdpClient> {
  const closed = yield* Deferred.make<void, BrowserError>()
  const pending = new Map<number, (result: Exit.Exit<unknown, BrowserError>) => void>()
  const listeners = new Set<(event: CdpEvent) => void>()
  let nextId = 0
  let buffered = ''
  const settleAll = (error: BrowserError) => {
    for (const resume of pending.values()) resume(Exit.fail(error))
    pending.clear()
    Deferred.doneUnsafe(closed, Exit.fail(error))
  }
  const dispatch = (message: CdpMessage) => {
    if (message.id !== undefined) {
      const resume = pending.get(message.id)
      pending.delete(message.id)
      resume?.(
        message.error === undefined
          ? Exit.succeed(message.result)
          : Exit.fail(fail('protocol', `${message.error.message} (${message.error.code})`))
      )
      return
    }
    if (message.method === undefined) return
    const event: CdpEvent = {
      method: message.method,
      sessionId: message.sessionId,
      params: message.params,
    }
    for (const listener of listeners) listener(event)
  }
  input.setEncoding('utf8')
  input.on('data', (chunk: string) => {
    buffered += chunk
    if (buffered.length > MAX_CDP_MESSAGE_CHARS) {
      settleAll(
        fail('protocol', 'A DevTools message exceeded the size limit; the browser is closed')
      )
      input.destroy()
      return
    }
    let separator = buffered.indexOf('\0')
    while (separator >= 0) {
      const raw = buffered.slice(0, separator)
      buffered = buffered.slice(separator + 1)
      const decoded = decodeMessage(raw)
      if (decoded._tag === 'Success') dispatch(decoded.success)
      separator = buffered.indexOf('\0')
    }
  })
  input.on('end', () => settleAll(fail('shutdown', 'The browser closed its DevTools pipe')))
  input.on('error', cause =>
    settleAll(fail('protocol', `DevTools pipe failed: ${errorText(cause)}`))
  )
  output.on('error', cause =>
    settleAll(fail('protocol', `DevTools pipe failed: ${errorText(cause)}`))
  )
  return {
    closed,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    send: (method, params = {}, sessionId) =>
      Effect.callback<unknown, BrowserError>(resume => {
        if (Deferred.isDoneUnsafe(closed)) {
          resume(Effect.fail(fail('shutdown', `Browser is closed; ${method} was not sent`)))
          return
        }
        nextId += 1
        const id = nextId
        pending.set(id, exit => resume(exit))
        output.write(
          `${JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) })}\0`
        )
        return Effect.sync(() => {
          pending.delete(id)
        })
      }),
  }
})

export interface ChromeLaunch {
  readonly executable: string
  readonly userDataDir: string
  readonly extraArguments?: readonly string[]
}

const chromeArguments = (launch: ChromeLaunch): readonly string[] => [
  '--headless=new',
  '--remote-debugging-pipe',
  `--user-data-dir=${launch.userDataDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-sync',
  '--disable-extensions',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-breakpad',
  '--disable-crash-reporter',
  '--metrics-recording-only',
  '--no-service-autorun',
  '--proxy-server=direct://',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--mute-audio',
  '--hide-scrollbars',
  '--window-size=1280,2000',
  ...(launch.extraArguments ?? []),
  'about:blank',
]

export interface Browser {
  readonly cdp: CdpClient
  readonly pid: number
}

const accountHome = (): string | undefined => {
  try {
    return userInfo().homedir
  } catch {
    return undefined
  }
}

const chromeEnvironment = (): NodeJS.ProcessEnv => {
  const home = accountHome()
  return { ...process.env, DISPLAY: undefined, ...(home === undefined ? {} : { HOME: home }) }
}

const EXIT_GRACE = Duration.seconds(5)
const DESCENDANT_SETTLE = Duration.seconds(10)
const SETTLE_INTERVAL = Duration.millis(200)
const SETTLE_HARD_CAP = Duration.times(DESCENDANT_SETTLE, 2)

const waitForExit = (child: ChildProcess): Effect.Effect<void> =>
  Effect.callback<void>(resume => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resume(Effect.void)
      return
    }
    child.once('exit', () => resume(Effect.void))
  })

interface ChromeFamily {
  readonly root: ObservedProcess | undefined
  known: readonly ObservedProcess[]
}

export type BrowserShutdown =
  | { readonly kind: 'settled' }
  | { readonly kind: 'unobserved'; readonly message: string }

const shutdown = Effect.fnUntraced(function* (
  child: ChildProcess,
  cdp: CdpClient,
  family: ChromeFamily
): Effect.fn.Return<BrowserShutdown, never, ChildProcessSpawner.ChildProcessSpawner> {
  const observer = yield* processObserver
  if (!Deferred.isDoneUnsafe(cdp.closed))
    yield* Effect.ignore(Effect.timeout(cdp.send('Browser.close'), Duration.seconds(2)))
  const exited = yield* Effect.timeoutOption(waitForExit(child), EXIT_GRACE)
  if (exited._tag === 'None') {
    child.kill('SIGKILL')
    yield* Effect.ignore(Effect.timeout(waitForExit(child), EXIT_GRACE))
  }
  const { pid } = child
  if (pid === undefined) return { kind: 'settled' }
  const sweep = Effect.gen(function* () {
    const observed = yield* observer.observeFamily(
      { pid, root: family.root, known: family.known, reported: undefined },
      { rootExited: true, report: () => Effect.void }
    )
    family.known = observed.known.flatMap(item =>
      item.birth === undefined ? [] : [{ ...item, birth: item.birth }]
    )
    for (const item of family.known) {
      if (item.pid === process.pid) continue
      yield* Effect.ignore(Effect.try(() => process.kill(item.pid, 'SIGKILL')))
    }
    return family.known.length
  })
  const settled = yield* Effect.exit(
    Effect.timeout(
      Effect.repeat(sweep, {
        schedule: Schedule.spaced(SETTLE_INTERVAL).pipe(
          Schedule.upTo({ duration: DESCENDANT_SETTLE })
        ),
        until: remaining => remaining === 0,
      }),
      SETTLE_HARD_CAP
    )
  )
  if (Exit.isSuccess(settled) && settled.value === 0) return { kind: 'settled' }
  return {
    kind: 'unobserved',
    message: `Browser descendants were not observed gone: ${Exit.isSuccess(settled) ? `${settled.value} still running after ${Duration.toSeconds(DESCENDANT_SETTLE)} seconds` : errorText(settled.cause)}`,
  }
})

const pendingShutdowns = new Map<string, Effect.Effect<BrowserShutdown>>()

export const retryChromeShutdown = (userDataDir: string): Effect.Effect<BrowserShutdown> =>
  Effect.suspend(
    () => pendingShutdowns.get(resolve(userDataDir)) ?? Effect.succeed({ kind: 'settled' })
  )

export const launchChrome = (
  launch: ChromeLaunch,
  onShutdown: (outcome: BrowserShutdown) => void = () => {}
): Effect.Effect<Browser, BrowserError, Scope.Scope | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const context = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>()
      const observer = yield* processObserver
      const child = yield* Effect.try({
        try: () =>
          spawn(launch.executable, [...chromeArguments(launch)], {
            stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
            detached: true,
            env: chromeEnvironment(),
          }),
        catch: cause => fail('launch', `Chrome could not be started: ${errorText(cause)}`),
      })
      const spawned = yield* Effect.callback<void, BrowserError>(resume => {
        child.once('spawn', () => resume(Effect.void))
        child.once('error', cause =>
          resume(Effect.fail(fail('launch', `Chrome could not be started: ${errorText(cause)}`)))
        )
      }).pipe(Effect.exit)
      if (Exit.isFailure(spawned)) return yield* Effect.failCause(spawned.cause)
      const [, , , toChrome, fromChrome] = child.stdio
      if (!(toChrome instanceof Writable) || !(fromChrome instanceof Readable)) {
        child.kill('SIGKILL')
        return yield* fail('launch', 'Chrome DevTools pipe descriptors are unavailable')
      }
      const { pid } = child
      if (pid === undefined) return yield* fail('launch', 'Chrome reported no process id')
      const table = yield* observer.processTable.pipe(Effect.orElseSucceed(() => []))
      const family: ChromeFamily = { root: table.find(item => item.pid === pid), known: [] }
      const cdp = yield* makeCdpClient(fromChrome, toChrome)
      const closing = yield* Semaphore.make(1)
      const key = resolve(launch.userDataDir)
      let settled = false
      const close: Effect.Effect<BrowserShutdown> = closing
        .withPermits(1)(
          Effect.suspend(() =>
            settled
              ? Effect.succeed({ kind: 'settled' } as const)
              : shutdown(child, cdp, family).pipe(
                  Effect.provide(context),
                  Effect.tap(outcome =>
                    Effect.sync(() => {
                      settled = outcome.kind === 'settled'
                      if (settled) pendingShutdowns.delete(key)
                      else pendingShutdowns.set(key, close)
                      onShutdown(outcome)
                    })
                  )
                )
          )
        )
        .pipe(Effect.uninterruptible)
      yield* Effect.timeoutOrElse(cdp.send('Browser.getVersion'), {
        duration: Duration.seconds(20),
        orElse: () =>
          Effect.fail(fail('launch', 'Chrome did not answer DevTools within 20 seconds')),
      }).pipe(
        Effect.andThen(cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' })),
        Effect.tapError(() => close)
      )
      return { browser: { cdp, pid } satisfies Browser, close }
    }),
    ({ close }) => close
  ).pipe(Effect.map(({ browser }) => browser))

export interface RenderedPage {
  readonly finalUrl: string
  readonly title: string
  readonly html: string
  readonly htmlTruncated: boolean
  readonly status: number | undefined
  readonly blockedRequests: number
}

export interface SubrequestPolicy {
  admit(url: string): Effect.Effect<void, WebNetworkError>
}

export interface RenderOptions {
  readonly timeout: Duration.Duration
  readonly maxHtmlChars: number
}

const Attached = Schema.Struct({ sessionId: Schema.String })
const Created = Schema.Struct({ targetId: Schema.String })
const Evaluated = Schema.Struct({
  result: Schema.Struct({ value: Schema.optional(Schema.Unknown) }),
})
const PausedRequest = Schema.Struct({
  requestId: Schema.String,
  request: Schema.Struct({ url: Schema.String }),
})
const DetachedEvent = Schema.Struct({ sessionId: Schema.String })
const AttachedEvent = Schema.Struct({
  sessionId: Schema.String,
  waitingForDebugger: Schema.Boolean,
  targetInfo: Schema.Struct({ type: Schema.String }),
})
const ResponseReceived = Schema.Struct({
  type: Schema.String,
  response: Schema.Struct({ status: Schema.Finite, url: Schema.String }),
})
const NavigateResult = Schema.Struct({ errorText: Schema.optional(Schema.String) })
const PageSnapshot = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  html: Schema.String,
  truncated: Schema.Boolean,
})
const decode = <T>(schema: Schema.Decoder<T>) => {
  const run = Schema.decodeUnknownResult(schema)
  return (value: unknown): Effect.Effect<T, BrowserError> => {
    const decoded = run(value)
    return decoded._tag === 'Success'
      ? Effect.succeed(decoded.success)
      : Effect.fail(fail('protocol', `Unexpected DevTools payload: ${errorText(decoded.failure)}`))
  }
}

const MAX_TITLE_CHARS = 4096
const MAX_URL_CHARS = 32 * 1024
const snapshotScript = (maxHtmlChars: number): string =>
  `(() => { const html = document.documentElement ? document.documentElement.outerHTML : ""; return { url: location.href.slice(0, ${MAX_URL_CHARS}), title: document.title.slice(0, ${MAX_TITLE_CHARS}), html: html.slice(0, ${maxHtmlChars}), truncated: html.length > ${maxHtmlChars} } })()`

const disabledConstructor = (name: string): string =>
  `Object.defineProperty(globalThis, ${JSON.stringify(name)}, { configurable: false, writable: false, value: function ${name}() { throw new DOMException(${JSON.stringify(`${name} is disabled by the dev reader`)}, "SecurityError") } })`

const DISABLED_WORKER_CHANNELS_SCRIPT = ['WebSocket', 'RTCPeerConnection', 'WebTransport']
  .map(disabledConstructor)
  .join(';')

const DISABLED_PAGE_CHANNELS_SCRIPT = [
  DISABLED_WORKER_CHANNELS_SCRIPT,
  disabledConstructor('webkitRTCPeerConnection'),
  disabledConstructor('SharedWorker'),
  'Object.defineProperty(Navigator.prototype, "serviceWorker", { configurable: false, get() { return undefined } })',
].join(';')
const FETCH_PATTERNS = { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }
const WORKER_TARGETS = new Set(['worker', 'shared_worker', 'service_worker'])

const SETTLE_AFTER_LOAD = Duration.millis(750)
const TEARDOWN_SETTLE = Duration.seconds(2)

export const renderPage = Effect.fnUntraced(function* (
  browser: Browser,
  url: string,
  policy: SubrequestPolicy,
  options: RenderOptions
): Effect.fn.Return<RenderedPage, BrowserError> {
  const { cdp } = browser
  let blocked = 0
  const loaded = yield* Deferred.make<void>()
  let mainStatus: number | undefined
  const handlers = yield* Scope.make()
  const runFork = Effect.runForkWith(yield* Effect.context<never>())
  const runEvent = (effect: Effect.Effect<void, BrowserError>) =>
    runFork(Effect.forkIn(Effect.ignore(effect), handlers))
  const pageSessions = new Set<string>()
  const enablePage = (sessionId: string) =>
    Effect.all(
      [
        Effect.sync(() => pageSessions.add(sessionId)),
        cdp.send('Page.enable', {}, sessionId),
        cdp.send('Runtime.enable', {}, sessionId),
        cdp.send(
          'Page.addScriptToEvaluateOnNewDocument',
          { source: DISABLED_PAGE_CHANNELS_SCRIPT, runImmediately: true },
          sessionId
        ),
        autoAttach(sessionId),
      ],
      { discard: true }
    )
  const autoAttach = (sessionId: string) =>
    cdp.send(
      'Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
      sessionId
    )
  const enableWorker = (sessionId: string) =>
    cdp
      .send('Runtime.evaluate', { expression: DISABLED_WORKER_CHANNELS_SCRIPT }, sessionId)
      .pipe(Effect.andThen(Effect.ignore(autoAttach(sessionId))))
  const outstanding = new Map<string, string | undefined>()
  let closing = false
  const refuse = (requestId: string, sessionId: string | undefined) =>
    cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, sessionId)
  const handlePaused = Effect.fnUntraced(function* (
    sessionId: string | undefined,
    params: unknown
  ): Effect.fn.Return<void, BrowserError> {
    const paused = yield* decode(PausedRequest)(params)
    outstanding.set(paused.requestId, sessionId)
    const admitted = yield* Effect.exit(policy.admit(paused.request.url))
    if (Exit.isFailure(admitted)) {
      if (/^https?:/i.test(paused.request.url)) blocked += 1
      yield* refuse(paused.requestId, sessionId)
    } else yield* cdp.send('Fetch.continueRequest', { requestId: paused.requestId }, sessionId)
    outstanding.delete(paused.requestId)
  })
  const refuseLate = (sessionId: string | undefined, params: unknown) => {
    const decoded = Schema.decodeUnknownResult(PausedRequest)(params)
    if (decoded._tag === 'Success')
      runFork(Effect.ignore(refuse(decoded.success.requestId, sessionId)))
  }
  const stopScripts = Effect.suspend(() =>
    Effect.forEach(
      pageSessions,
      sessionId =>
        Effect.ignore(cdp.send('Emulation.setScriptExecutionDisabled', { value: true }, sessionId)),
      { discard: true }
    )
  )
  const refuseOutstanding = Effect.suspend(() => {
    const pending = [...outstanding]
    outstanding.clear()
    return Effect.forEach(
      pending,
      ([requestId, sessionId]) => Effect.ignore(refuse(requestId, sessionId)),
      { discard: true }
    )
  })
  let page: { readonly targetId: string; readonly sessionId: string } | undefined
  const detached = yield* Deferred.make<void>()
  const unsubscribe = cdp.subscribe(event => {
    if (event.method === 'Fetch.requestPaused') {
      if (closing) refuseLate(event.sessionId, event.params)
      else runEvent(handlePaused(event.sessionId, event.params))
    } else if (event.method === 'Target.attachedToTarget') {
      const decoded = Schema.decodeUnknownResult(AttachedEvent)(event.params)
      if (decoded._tag !== 'Success') return
      const { sessionId, waitingForDebugger, targetInfo } = decoded.success
      runEvent(
        (WORKER_TARGETS.has(targetInfo.type)
          ? enableWorker(sessionId)
          : enablePage(sessionId)
        ).pipe(
          Effect.andThen(
            waitingForDebugger
              ? cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId)
              : Effect.void
          ),
          Effect.asVoid
        )
      )
    } else if (event.method === 'Page.loadEventFired' && event.sessionId === page?.sessionId)
      Deferred.doneUnsafe(loaded, Exit.void)
    else if (event.method === 'Target.detachedFromTarget') {
      const decoded = Schema.decodeUnknownResult(DetachedEvent)(event.params)
      if (decoded._tag === 'Success' && decoded.success.sessionId === page?.sessionId)
        Deferred.doneUnsafe(detached, Exit.void)
    } else if (event.method === 'Network.responseReceived' && event.sessionId === page?.sessionId) {
      const decoded = Schema.decodeUnknownResult(ResponseReceived)(event.params)
      if (
        decoded._tag === 'Success' &&
        decoded.success.type === 'Document' &&
        mainStatus === undefined
      )
        mainStatus = decoded.success.response.status
    }
  })
  const render = Effect.gen(function* () {
    yield* cdp.send('Fetch.enable', FETCH_PATTERNS)
    const created = yield* cdp
      .send('Target.createTarget', { url: 'about:blank' })
      .pipe(Effect.flatMap(decode(Created)))
    const attached = yield* cdp
      .send('Target.attachToTarget', { targetId: created.targetId, flatten: true })
      .pipe(Effect.flatMap(decode(Attached)))
    page = { targetId: created.targetId, sessionId: attached.sessionId }
    yield* enablePage(attached.sessionId)
    yield* cdp.send('Network.enable', {}, attached.sessionId)
    const navigated = yield* cdp
      .send('Page.navigate', { url }, attached.sessionId)
      .pipe(Effect.flatMap(decode(NavigateResult)))
    if (navigated.errorText !== undefined)
      return yield* fail('navigation', `Chrome could not load ${url}: ${navigated.errorText}`)
    yield* Deferred.await(loaded)
    yield* Effect.sleep(SETTLE_AFTER_LOAD)
    const snapshot = yield* cdp
      .send(
        'Runtime.evaluate',
        { expression: snapshotScript(options.maxHtmlChars), returnByValue: true },
        attached.sessionId
      )
      .pipe(
        Effect.flatMap(decode(Evaluated)),
        Effect.flatMap(({ result }) => decode(PageSnapshot)(result.value))
      )
    return {
      finalUrl: snapshot.url,
      title: snapshot.title,
      html: snapshot.html,
      htmlTruncated: snapshot.truncated,
      status: mainStatus,
      blockedRequests: blocked,
    } satisfies RenderedPage
  })
  return yield* Effect.timeoutOrElse(render, {
    duration: options.timeout,
    orElse: () =>
      Effect.fail(
        fail(
          'timeout',
          `Chrome did not finish loading ${url} within ${Duration.toSeconds(options.timeout)} seconds`
        )
      ),
  }).pipe(
    Effect.ensuring(
      Effect.suspend(() => {
        closing = true
        const target = page
        return Scope.close(handlers, Exit.void).pipe(
          Effect.andThen(refuseOutstanding),
          Effect.andThen(stopScripts),
          Effect.andThen(
            target === undefined
              ? Effect.void
              : Effect.ignore(cdp.send('Target.closeTarget', { targetId: target.targetId })).pipe(
                  Effect.andThen(Effect.timeoutOption(Deferred.await(detached), TEARDOWN_SETTLE))
                )
          ),
          Effect.andThen(Effect.ignore(cdp.send('Fetch.disable'))),
          Effect.andThen(Effect.sync(unsubscribe))
        )
      })
    )
  )
})
