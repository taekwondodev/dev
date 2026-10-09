import {
  Cause,
  Clock,
  Duration,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Schema,
  Scope,
  Semaphore,
} from 'effect'
import type { ChildProcessSpawner } from 'effect/process'
import { errorText } from './error-text.ts'
import {
  BrowserError,
  launchChrome,
  renderPage,
  retryChromeShutdown,
  type Browser,
  type BrowserShutdown,
  type RenderedPage,
} from './web-browser.ts'
import {
  DEFAULT_SLICE_CHARS,
  MAX_SLICE_CHARS,
  MIN_SLICE_CHARS,
  makeDocumentSnapshots,
  sliceDocument,
  type DocumentLink,
  type DocumentSlice,
  type RetrievalMethod,
  type WebDocument,
} from './web-documents.ts'
import {
  decodeBody,
  extractHtml,
  extractMarkdown,
  extractText,
  needsRendering,
  type Extracted,
} from './web-extract.ts'
import {
  defaultFetchLimits,
  fetchPublic,
  resolvePublicAddress,
  validateUrl,
  type AddressResolver,
  type FetchLimits,
  type FetchedResponse,
  type WebNetworkError,
} from './web-network.ts'
import {
  type BrowserProfileError,
  makeBrowserProfileOwner,
  type BrowserProfileOptions,
} from './web-profile.ts'

export interface ReadRequest {
  readonly url?: string
  readonly continuation?: string
  readonly maxChars?: number
}

export type ReadOutcome =
  | { readonly kind: 'document'; readonly slice: DocumentSlice }
  | { readonly kind: 'failed'; readonly error: string; readonly limitations: readonly string[] }

class ReadCancelled extends Schema.TaggedError<ReadCancelled>()('ReadCancelled', {
  message: Schema.String,
}) {}

type BrowserFailure = BrowserError | BrowserProfileError
type ReadFailure = WebNetworkError | BrowserFailure | ReadCancelled

export interface WebReader {
  read(request: ReadRequest, signal?: AbortSignal): Effect.Effect<ReadOutcome>
  readonly endSession: (reason: string) => Effect.Effect<void>
}

export interface WebReaderOptions {
  readonly profile: BrowserProfileOptions
  readonly fetchLimits?: FetchLimits
  readonly resolveAddress?: AddressResolver
  readonly chromeArguments?: readonly string[]
  readonly browserIdle?: Duration.Duration
  readonly renderTimeout?: Duration.Duration
  readonly staticConcurrency?: number
  readonly onBrowserShutdown?: (outcome: BrowserShutdown) => void
}

const INDEX_CANDIDATES = ['/llms.txt', '/llms-full.txt']

const indexSuggestions = (finalUrl: string): readonly DocumentLink[] => {
  const url = new URL(finalUrl)
  return INDEX_CANDIDATES.filter(path => url.pathname !== path).map(path => ({
    text: `Possible documentation index (not the requested page): ${path}`,
    url: new URL(path, url.origin).href,
  }))
}

const statusLimitation = (status: number): string | undefined => {
  if (status >= 200 && status < 300) return undefined
  if (status === 401 || status === 403)
    return `The origin answered HTTP ${status}; the page may require a login, a browser or a different client.`
  if (status === 404) return 'The origin answered HTTP 404: this page does not exist there.'
  if (status === 429) return 'The origin answered HTTP 429 (rate limited); retry later.'
  return `The origin answered HTTP ${status}.`
}

const clampChars = (requested: number | undefined): number =>
  Math.min(MAX_SLICE_CHARS, Math.max(MIN_SLICE_CHARS, requested ?? DEFAULT_SLICE_CHARS))

const BROWSER_IDLE = Duration.minutes(3)
const RENDER_TIMEOUT = Duration.seconds(40)
const STATIC_CONCURRENCY = 4
const ADMISSION_CONCURRENCY = 8
const RENDERED_NOTE =
  'Rendered with the installed Chrome using a dev-owned copy of your authenticated profile; the origin may have recorded this visit.'

const failed = (error: string): ReadOutcome => ({ kind: 'failed', error, limitations: [] })

const untilCancelled = (signal: AbortSignal | undefined): Effect.Effect<never, ReadCancelled> =>
  signal === undefined
    ? Effect.never
    : Effect.callback<never, ReadCancelled>(resume => {
        const cancel = () =>
          resume(Effect.fail(new ReadCancelled({ message: 'The read was cancelled' })))
        if (signal.aborted) {
          cancel()
          return
        }
        signal.addEventListener('abort', cancel, { once: true })
        return Effect.sync(() => signal.removeEventListener('abort', cancel))
      })

const cancellable = <A, E>(
  effect: Effect.Effect<A, E>,
  signal: AbortSignal | undefined
): Effect.Effect<A, E | ReadCancelled> => Effect.raceFirst(effect, untilCancelled(signal))

export const makeWebReader = Effect.fnUntraced(function* (
  options: WebReaderOptions
): Effect.fn.Return<WebReader, never, Scope.Scope | ChildProcessSpawner.ChildProcessSpawner> {
  const snapshots = makeDocumentSnapshots()
  const owner = makeBrowserProfileOwner(options.profile)
  const limits = options.fetchLimits ?? defaultFetchLimits
  const resolve = options.resolveAddress ?? resolvePublicAddress
  const spawnerContext = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>()
  const readerScope = yield* Effect.scope
  const browserSemaphore = yield* Semaphore.make(1)
  const staticSemaphore = yield* Semaphore.make(options.staticConcurrency ?? STATIC_CONCURRENCY)
  const admissionSemaphore = yield* Semaphore.make(ADMISSION_CONCURRENCY)

  interface LiveBrowser {
    readonly browser: Browser
    readonly scope: Scope.Closeable
    idleTimer: Fiber.Fiber<void> | undefined
  }
  let live: LiveBrowser | undefined
  const reads = yield* FiberSet.make<ReadOutcome, never>()
  const stopReads = FiberSet.clear(reads)

  const closeBrowser = Effect.gen(function* () {
    const current = live
    if (current === undefined) {
      yield* retryChromeShutdown(owner.paths.userDataDir)
      return
    }
    live = undefined
    const timer = current.idleTimer
    current.idleTimer = undefined
    if (timer !== undefined) yield* Fiber.interrupt(timer)
    yield* Scope.close(current.scope, Exit.void)
  })

  const closeWhenIdle = (current: LiveBrowser) =>
    browserSemaphore.withPermits(1)(
      Effect.suspend(() => {
        if (live !== current) return Effect.void
        current.idleTimer = undefined
        return closeBrowser
      })
    )

  const scheduleIdleClose = Effect.fnUntraced(function* (current: LiveBrowser) {
    if (live !== current) return
    if (current.idleTimer !== undefined) yield* Fiber.interrupt(current.idleTimer)
    current.idleTimer = yield* Effect.forkIn(
      Effect.sleep(options.browserIdle ?? BROWSER_IDLE).pipe(
        Effect.andThen(closeWhenIdle(current))
      ),
      readerScope
    )
  })

  const openBrowser: Effect.Effect<LiveBrowser, BrowserFailure> = Effect.uninterruptible(
    Effect.gen(function* () {
      if (live !== undefined) return live
      const previous = yield* retryChromeShutdown(owner.paths.userDataDir)
      if (previous.kind === 'unobserved')
        return yield* new BrowserError({
          reason: 'shutdown',
          message: `${previous.message}. The profile copy is still locked; a later browser read or session close will retry settlement.`,
        })
      const now = yield* Clock.currentTimeMillis
      const acquired = yield* owner.acquire(now)
      const scope = yield* Scope.fork(readerScope)
      let shutdownReported = false
      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => {
          if (!shutdownReported) acquired.release()
        })
      )
      const browser = yield* launchChrome(
        {
          executable: acquired.chrome,
          userDataDir: acquired.copy.userDataDir,
          extraArguments: [
            `--profile-directory=${acquired.copy.profileDirectory}`,
            ...(options.chromeArguments ?? []),
          ],
        },
        outcome => {
          shutdownReported = true
          if (outcome.kind === 'settled') acquired.release()
          options.onBrowserShutdown?.(outcome)
        }
      ).pipe(
        Scope.provide(scope),
        Effect.provide(spawnerContext),
        Effect.tapError(() => Scope.close(scope, Exit.void))
      )
      const opened: LiveBrowser = { browser, scope, idleTimer: undefined }
      live = opened
      return opened
    })
  )

  const policy = {
    admit: (url: string) =>
      admissionSemaphore.withPermits(1)(
        validateUrl(url).pipe(
          Effect.flatMap(valid => resolve(valid.hostname)),
          Effect.asVoid
        )
      ),
  }

  const renderWithBrowser = (
    url: string,
    signal: AbortSignal | undefined
  ): Effect.Effect<RenderedPage, BrowserFailure | ReadCancelled> =>
    cancellable(
      browserSemaphore.withPermits(1)(
        Effect.flatMap(openBrowser, current =>
          renderPage(current.browser, url, policy, {
            timeout: options.renderTimeout ?? RENDER_TIMEOUT,
            maxHtmlChars: limits.maxBytes,
          }).pipe(Effect.tapError(() => closeBrowser))
        ).pipe(
          Effect.ensuring(
            Effect.suspend(() => (live === undefined ? Effect.void : scheduleIdleClose(live)))
          )
        )
      ),
      signal
    )

  const staticDocument = (
    response: FetchedResponse
  ): { readonly document: WebDocument; readonly renderable: boolean } => {
    const text = decodeBody(response.body, response.charset, response.contentType)
    const limitations: string[] = []
    const status = statusLimitation(response.status)
    if (status !== undefined) limitations.push(status)
    if (response.truncated)
      limitations.push(
        `The response was cut at ${limits.maxBytes} bytes; the document is incomplete.`
      )
    const base = response.finalUrl
    let method: RetrievalMethod
    let extracted: Extracted
    let renderable = false
    const type = response.contentType ?? ''
    if (type === 'text/markdown' || type === 'text/x-markdown') {
      method = 'markdown'
      extracted = extractMarkdown(text, base)
    } else if (
      type === 'text/html' ||
      type === 'application/xhtml+xml' ||
      /^\s*<(!doctype|html)/i.test(text)
    ) {
      method = 'html'
      extracted = extractHtml(text, base)
      renderable = needsRendering(text, extracted.text, response.status)
    } else {
      method = 'text'
      extracted = extractText(text, base)
    }
    return {
      renderable,
      document: {
        requestedUrl: response.requestedUrl,
        finalUrl: response.finalUrl,
        title: extracted.title,
        text: extracted.text,
        links: extracted.links,
        method,
        contentType: response.contentType,
        status: response.status,
        bodyTruncated: response.truncated,
        suggestions: indexSuggestions(response.finalUrl),
        limitations,
      },
    }
  }

  const browserDocument = Effect.fnUntraced(function* (
    requestedUrl: string,
    priorLimitations: readonly string[],
    signal: AbortSignal | undefined
  ): Effect.fn.Return<WebDocument, BrowserFailure | ReadCancelled> {
    const rendered = yield* renderWithBrowser(requestedUrl, signal)
    const extracted = extractHtml(rendered.html, rendered.finalUrl)
    const limitations = [...priorLimitations]
    if (rendered.blockedRequests > 0)
      limitations.push(
        `${rendered.blockedRequests} browser subrequest(s) to non-public destinations were blocked.`
      )
    if (rendered.htmlTruncated)
      limitations.push(
        `The rendered page was cut at ${limits.maxBytes} characters of HTML; the document is incomplete.`
      )
    const status = rendered.status === undefined ? undefined : statusLimitation(rendered.status)
    if (status !== undefined) limitations.push(status)
    limitations.push(RENDERED_NOTE)
    return {
      requestedUrl,
      finalUrl: rendered.finalUrl,
      title: extracted.title ?? (rendered.title === '' ? undefined : rendered.title),
      text: extracted.text,
      links: extracted.links,
      method: 'browser',
      contentType: 'text/html',
      status: rendered.status,
      bodyTruncated: rendered.htmlTruncated,
      suggestions: indexSuggestions(rendered.finalUrl),
      limitations,
    }
  })

  const fetchStatic = (url: string, signal: AbortSignal | undefined) =>
    staticSemaphore
      .withPermits(1)(cancellable(fetchPublic(url, { limits, signal, resolve }), signal))
      .pipe(
        Effect.map(response => ({ kind: 'response' as const, response })),
        Effect.catchTag('WebNetworkError', error =>
          error.reason === 'response'
            ? Effect.succeed({ kind: 'escalate' as const, error })
            : Effect.fail(error)
        )
      )

  const retrieve = Effect.fnUntraced(function* (
    url: string,
    signal: AbortSignal | undefined
  ): Effect.fn.Return<WebDocument, ReadFailure> {
    const fetched = yield* fetchStatic(url, signal)
    if (fetched.kind === 'escalate')
      return yield* browserDocument(
        url,
        [`Static retrieval failed first: ${fetched.error.message}`],
        signal
      )
    const { document, renderable } = staticDocument(fetched.response)
    if (!renderable) return document
    return yield* browserDocument(
      url,
      [
        `Static HTML extraction yielded too little readable text (HTTP ${document.status}); the page was rendered in Chrome.`,
      ],
      signal
    ).pipe(
      Effect.catchTag(['BrowserError', 'BrowserProfileError'], error =>
        Effect.succeed({
          ...document,
          limitations: [
            ...document.limitations,
            `Static extraction looked incomplete and browser rendering was unavailable: ${error.message}`,
          ],
        })
      )
    )
  })

  const performRead = Effect.fnUntraced(function* (
    request: ReadRequest,
    signal: AbortSignal | undefined
  ): Effect.fn.Return<ReadOutcome> {
    const maxChars = clampChars(request.maxChars)
    if (request.continuation !== undefined) {
      const found = snapshots.lookup(request.continuation)
      if (found.kind === 'unavailable') return failed(found.reason)
      return {
        kind: 'document',
        slice: sliceDocument(found.documentId, found.document, found.offset, maxChars),
      } satisfies ReadOutcome
    }
    if (request.url === undefined)
      return failed('Pass url to read a page, or continuation to read on from an earlier result.')
    const retrieved = yield* Effect.exit(retrieve(request.url, signal))
    if (Exit.isFailure(retrieved)) return failed(errorText(Cause.squash(retrieved.cause)))
    const id = snapshots.remember(retrieved.value)
    return {
      kind: 'document',
      slice: sliceDocument(id, retrieved.value, 0, maxChars),
    } satisfies ReadOutcome
  })

  const read = (request: ReadRequest, signal?: AbortSignal): Effect.Effect<ReadOutcome> =>
    Effect.flatMap(FiberSet.run(reads)(performRead(request, signal)), fiber =>
      Fiber.join(fiber).pipe(
        Effect.onInterrupt(() => Fiber.interrupt(fiber)),
        Effect.catchCauseIf(Cause.hasInterruptsOnly, () =>
          Effect.succeed(failed('The read was stopped: the session ended'))
        )
      )
    )

  const shutdownBrowser = stopReads.pipe(
    Effect.andThen(browserSemaphore.withPermits(1)(closeBrowser))
  )
  yield* Scope.addFinalizer(readerScope, shutdownBrowser)

  return {
    read,
    endSession: reason =>
      Effect.sync(() => snapshots.clear(reason)).pipe(Effect.andThen(shutdownBrowser)),
  }
})
