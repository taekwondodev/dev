import { fork, type ChildProcess } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeServices from '@effect/platform-node/NodeServices'
import {
  Cause,
  Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Schedule,
  Schema,
  Scope,
  Semaphore,
} from 'effect'
import type { ChildProcessSpawner } from 'effect/process'
import { errorText } from './error-text.ts'
import {
  acquireExclusiveLock,
  acquireRuntime,
  CoordinationError,
  type CoordinationOptions,
} from './runtime-coordination.ts'
import {
  BrowserError,
  launchChrome,
  makeRenderHost,
  retryChromeShutdown,
  type Browser,
  type BrowserShutdown,
  type RenderHost,
  type RenderedPage,
} from './web-browser.ts'
import {
  BrowserProfileError,
  browserProfilePaths,
  makeBrowserProfileOwner,
  privateBrowserDirectory,
  RevocationOutcomeSchema,
  type BrowserProfileOptions,
  type BrowserProfilePaths,
  type BrowserProfileStatus,
  type RevocationOutcome,
} from './web-profile.ts'
import {
  defaultFetchLimits,
  resolvePublicAddress,
  validateUrl,
  type AddressResolver,
} from './web-network.ts'

export class BrowserOwnerError extends Schema.TaggedError<BrowserOwnerError>()(
  'BrowserOwnerError',
  {
    reason: Schema.Literals([
      'bootstrap',
      'conflict',
      'unavailable',
      'capacity',
      'retiring',
      'protocol',
    ]),
    message: Schema.String,
  }
) {}

const ownerFailure = (reason: BrowserOwnerError['reason'], message: string) =>
  new BrowserOwnerError({ reason, message })

type RenderFailure = BrowserError | BrowserProfileError | BrowserOwnerError

const wireFailure = (cause: Cause.Cause<RenderFailure>): RenderFailure => {
  const squashed = Cause.squash(cause)
  return squashed instanceof BrowserError ||
    squashed instanceof BrowserProfileError ||
    squashed instanceof BrowserOwnerError
    ? squashed
    : ownerFailure('protocol', errorText(squashed))
}

const MAX_CONTROL_FRAME = 16 * 1024
const MAX_URL_CHARS = 8 * 1024
const MAX_RENDER_CLIENTS = 64
const MAX_CONNECTIONS = MAX_RENDER_CLIENTS + 16
const MAX_QUEUED_RENDERS = 64
const ACTIVE_RENDERS = 4
const BOOTSTRAP_BUDGET = Duration.seconds(10)
const FIRST_CLIENT_GRACE = Duration.seconds(10)
const BROWSER_IDLE = Duration.minutes(3)
const RENDER_BUDGET = Duration.seconds(40)
const REVOKE_SETTLE = Duration.seconds(10)
const DRAIN_INTERVAL = Duration.millis(200)

const RequestId = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(64)),
  Schema.brand('dev/web/RequestId')
)
type RequestId = typeof RequestId.Type

const OwnerRequestSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('render'),
    requestId: RequestId,
    url: Schema.String.check(Schema.isMaxLength(MAX_URL_CHARS)),
    budgetMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
    maxHtmlChars: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1024)),
  }),
  Schema.Struct({ type: Schema.Literal('cancel'), requestId: RequestId }),
  Schema.Struct({ type: Schema.Literal('status'), requestId: RequestId }),
  Schema.Struct({
    type: Schema.Literal('revoke'),
    requestId: RequestId,
    waitMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  Schema.Struct({ type: Schema.Literal('enable'), requestId: RequestId }),
])
type OwnerRequest = typeof OwnerRequestSchema.Type

const RenderedPageSchema = Schema.Struct({
  finalUrl: Schema.String,
  title: Schema.String,
  html: Schema.String,
  htmlTruncated: Schema.Boolean,
  status: Schema.optional(Schema.Int),
  blockedRequests: Schema.Int,
})

const CopyStateSchema = Schema.Struct({
  complete: Schema.Boolean,
  source: Schema.String,
  profileDirectory: Schema.String,
  refreshedAt: Schema.Finite,
})

const ProfileStatusSchema = Schema.Struct({
  chrome: Schema.optional(Schema.String),
  source: Schema.String,
  profileDirectory: Schema.String,
  enabled: Schema.Boolean,
  copy: Schema.optional(CopyStateSchema),
  inUse: Schema.Boolean,
})

const OwnerActivitySchema = Schema.Struct({
  clients: Schema.Int,
  rendering: Schema.Int,
  queued: Schema.Int,
  draining: Schema.Boolean,
  chrome: Schema.Boolean,
  unobserved: Schema.optional(Schema.String),
})
type OwnerActivity = typeof OwnerActivitySchema.Type

const OwnerReplySchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('rendered'),
    requestId: RequestId,
    page: RenderedPageSchema,
  }),
  Schema.Struct({
    type: Schema.Literal('failed'),
    requestId: RequestId,
    error: Schema.Union([BrowserError, BrowserProfileError, BrowserOwnerError]),
  }),
  Schema.Struct({
    type: Schema.Literal('status'),
    requestId: RequestId,
    profile: ProfileStatusSchema,
    activity: OwnerActivitySchema,
  }),
  Schema.Struct({
    type: Schema.Literal('revoked'),
    requestId: RequestId,
    outcome: RevocationOutcomeSchema,
  }),
  Schema.Struct({ type: Schema.Literal('enabled'), requestId: RequestId }),
])
type OwnerReply = typeof OwnerReplySchema.Type

const LocatorSchema = Schema.Struct({
  epoch: Schema.String,
  socket: Schema.String,
  pid: Schema.Int,
  startedAt: Schema.Finite,
  installation: Schema.String,
})
type Locator = typeof LocatorSchema.Type

const BootstrapMessageSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal('prepare'), dataHome: Schema.String }),
  Schema.Struct({ type: Schema.Literal('commit') }),
])

const BootstrapReplySchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal('prepared'), epoch: Schema.String, socket: Schema.String }),
  Schema.Struct({ type: Schema.Literal('ready') }),
  Schema.Struct({
    type: Schema.Literal('bootstrap-failed'),
    reason: BrowserOwnerError.fields.reason,
    message: Schema.String,
  }),
])

const encodeRequest = Schema.encodeSync(Schema.fromJsonString(OwnerRequestSchema))
const decodeRequest = Schema.decodeUnknownResult(Schema.fromJsonString(OwnerRequestSchema))
const encodeReply = Schema.encodeSync(Schema.fromJsonString(OwnerReplySchema))
const decodeReply = Schema.decodeUnknownResult(Schema.fromJsonString(OwnerReplySchema))
const encodeLocator = Schema.encodeSync(Schema.fromJsonString(LocatorSchema))
const decodeLocator = Schema.decodeUnknownResult(Schema.fromJsonString(LocatorSchema))
const decodeBootstrap = Schema.decodeUnknownResult(BootstrapMessageSchema)
const decodeBootstrapReply = Schema.decodeUnknownResult(BootstrapReplySchema)

const installationPath = (): string => realpathSync(fileURLToPath(new URL('../', import.meta.url)))

const replyLimit = (maxHtmlChars: number): number => 3 * maxHtmlChars + 64 * 1024

const frameOf = (text: string): Uint8Array => {
  const payload = Buffer.from(text, 'utf8')
  const framed = Buffer.alloc(4 + payload.length)
  framed.writeUInt32BE(payload.length, 0)
  payload.copy(framed, 4)
  return framed
}

interface FrameChannel {
  readonly write: (text: string) => boolean
  readonly close: () => void
}

const readFrames = (
  socket: Socket,
  limit: number,
  onFrame: (text: string) => void,
  onBroken: (message: string) => void
): FrameChannel => {
  let buffered = Buffer.alloc(0)
  const broken = (message: string): void => {
    onBroken(message)
    socket.destroy()
  }
  socket.on('data', (chunk: Uint8Array) => {
    if (buffered.length + chunk.length > 2 * (4 + limit)) {
      broken(`The browser control connection buffered more than ${2 * (4 + limit)} bytes`)
      return
    }
    buffered = Buffer.concat([buffered, chunk])
    for (;;) {
      if (buffered.length < 4) return
      const length = buffered.readUInt32BE(0)
      if (length > limit) {
        broken(`A browser control frame of ${length} bytes exceeds the ${limit}-byte limit`)
        return
      }
      if (buffered.length < 4 + length) return
      const text = buffered.subarray(4, 4 + length).toString('utf8')
      buffered = buffered.subarray(4 + length)
      onFrame(text)
    }
  })
  socket.on('error', cause =>
    onBroken(`The browser control connection failed: ${errorText(cause)}`)
  )
  socket.on('close', () => onBroken('The browser control connection closed'))
  return {
    write: text => {
      if (socket.destroyed || socket.writableEnded) return false
      if (socket.writableLength > 2 * limit) {
        broken('The browser control connection exceeded its write buffer')
        return false
      }
      socket.write(frameOf(text))
      return true
    },
    close: () => socket.destroy(),
  }
}

const privateSocketDirectory = (): string => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'dev-browser-'))
  chmodSync(directory, 0o700)
  return directory
}

const readLocator = (paths: BrowserProfilePaths): Locator | undefined => {
  if (!existsSync(paths.locator)) return undefined
  const info = lstatSync(paths.locator)
  if (!info.isFile()) return undefined
  const decoded = decodeLocator(readFileSync(paths.locator, 'utf8'))
  if (decoded._tag !== 'Success') return undefined
  return decoded.success.installation === installationPath() ? decoded.success : undefined
}

export interface SessionRenderer {
  render(url: string, maxHtmlChars: number): Effect.Effect<RenderedPage, RenderFailure>
  readonly endSession: Effect.Effect<void>
}

interface EnsureOwner {
  readonly ensure: Effect.Effect<void, BrowserOwnerError>
}

interface PendingReply {
  readonly settle: (reply: OwnerReply) => void
  readonly broken: (message: string) => void
}

interface Connection {
  readonly channel: FrameChannel
  readonly pending: Map<string, PendingReply>
  closed: boolean
}

export const makeSessionRenderer = Effect.fnUntraced(function* (options: {
  readonly dataHome: string
  readonly ensureOwner: Effect.Effect<void, BrowserOwnerError>
  readonly renderBudget?: Duration.Duration
}): Effect.fn.Return<SessionRenderer, never, Scope.Scope> {
  const paths = browserProfilePaths(options.dataHome)
  const budget = options.renderBudget ?? RENDER_BUDGET
  const connecting = yield* Semaphore.make(1)
  let connection: Connection | undefined
  let boundEpoch: string | undefined

  const bindSocket = (locator: Locator): Effect.Effect<Connection, BrowserOwnerError> =>
    Effect.callback<Connection, BrowserOwnerError>(resume => {
      const socket = createConnection({ path: locator.socket })
      socket.unref()
      let settled = false
      const pending = new Map<string, PendingReply>()
      const current: Connection = {
        pending,
        closed: false,
        channel: readFrames(
          socket,
          replyLimit(defaultFetchLimits.maxBytes),
          text => {
            const decoded = decodeReply(text)
            if (decoded._tag !== 'Success') return
            const waiter = pending.get(decoded.success.requestId)
            pending.delete(decoded.success.requestId)
            waiter?.settle(decoded.success)
          },
          message => {
            current.closed = true
            if (connection === current) connection = undefined
            const waiting = [...pending.values()]
            pending.clear()
            for (const waiter of waiting) waiter.broken(message)
            if (!settled) {
              settled = true
              resume(Effect.fail(ownerFailure('unavailable', message)))
            }
          }
        ),
      }
      socket.once('connect', () => {
        if (settled) return
        settled = true
        boundEpoch = locator.epoch
        resume(Effect.succeed(current))
      })
      return Effect.void
    })

  const awaitSupersession = (epoch: string | undefined): Effect.Effect<void> =>
    Effect.asVoid(
      Effect.repeat(
        Effect.sync(() => {
          const locator = readLocator(paths)
          return locator === undefined || locator.epoch !== epoch || !gateHeld(paths)
        }),
        {
          schedule: Schedule.spaced(Duration.millis(100)).pipe(
            Schedule.upTo({ duration: BOOTSTRAP_BUDGET })
          ),
          until: (superseded: boolean) => superseded,
        }
      )
    )

  const connect: Effect.Effect<Connection, BrowserOwnerError> = connecting.withPermits(1)(
    Effect.suspend(() => {
      const current = connection
      if (current !== undefined && !current.closed) return Effect.succeed(current)
      const attempt = Effect.suspend(() => {
        const locator = readLocator(paths)
        return locator === undefined
          ? Effect.fail(
              ownerFailure('unavailable', 'No browser owner is published for this data home')
            )
          : bindSocket(locator)
      })
      return attempt.pipe(
        Effect.catchTag('BrowserOwnerError', () => Effect.andThen(options.ensureOwner, attempt)),
        Effect.tap(bound =>
          Effect.sync(() => {
            connection = bound
          })
        )
      )
    })
  )

  const exchange = <A>(
    request: (requestId: RequestId) => OwnerRequest,
    accept: (reply: OwnerReply, requestId: RequestId) => Effect.Effect<A, RenderFailure>
  ): Effect.Effect<A, RenderFailure> =>
    Effect.flatMap(connect, bound =>
      Effect.callback<OwnerReply, BrowserOwnerError>(resume => {
        const requestId = newRequestId()
        const sent = (): void => {
          bound.pending.set(requestId, {
            settle: reply => resume(Effect.succeed(reply)),
            broken: message => resume(Effect.fail(ownerFailure('unavailable', message))),
          })
          if (!bound.channel.write(encodeRequest(request(requestId)))) {
            bound.pending.delete(requestId)
            resume(
              Effect.fail(ownerFailure('unavailable', 'The browser owner connection is closed'))
            )
          }
        }
        sent()
        return Effect.sync(() => {
          if (!bound.pending.delete(requestId)) return
          bound.channel.write(encodeRequest({ type: 'cancel', requestId }))
        })
      }).pipe(Effect.flatMap(reply => accept(reply, asRequestId(reply.requestId))))
    )

  const attempt = (url: string, maxHtmlChars: number): Effect.Effect<RenderedPage, RenderFailure> =>
    exchange(
      requestId => ({
        type: 'render',
        requestId,
        url,
        budgetMs: Duration.toMillis(budget),
        maxHtmlChars,
      }),
      reply => {
        if (reply.type === 'rendered')
          return Effect.succeed({ ...reply.page, status: reply.page.status })
        if (reply.type === 'failed') return Effect.fail(reply.error)
        return Effect.fail(
          ownerFailure('protocol', 'The browser owner answered a render with an unrelated reply')
        )
      }
    )

  const render = (url: string, maxHtmlChars: number): Effect.Effect<RenderedPage, RenderFailure> =>
    Effect.timeoutOrElse(renderWithReconnect(url, maxHtmlChars), {
      duration: budget,
      orElse: () =>
        Effect.fail(
          ownerFailure(
            'unavailable',
            `The browser owner did not render within ${Duration.toSeconds(budget)} seconds, bootstrap and queue waiting included`
          )
        ),
    })

  const renderWithReconnect = (
    url: string,
    maxHtmlChars: number
  ): Effect.Effect<RenderedPage, RenderFailure> =>
    attempt(url, maxHtmlChars).pipe(
      Effect.catchIf(
        error => error._tag === 'BrowserOwnerError' && error.reason === 'unavailable',
        () =>
          Effect.sync(() => {
            const stale = boundEpoch
            connection?.channel.close()
            connection = undefined
            return stale
          }).pipe(Effect.flatMap(awaitSupersession), Effect.andThen(attempt(url, maxHtmlChars)))
      )
    )

  const endSession = Effect.sync(() => {
    const current = connection
    connection = undefined
    current?.channel.close()
  })
  yield* Scope.addFinalizer(yield* Effect.scope, endSession)
  return { render, endSession }
})

export interface BrowserOwnerStatus {
  readonly profile: BrowserProfileStatus
  readonly owner:
    | { readonly kind: 'absent' }
    | { readonly kind: 'live'; readonly activity: OwnerActivity }
    | { readonly kind: 'unavailable'; readonly message: string }
}

interface BrowserAdmin {
  readonly status: Effect.Effect<BrowserOwnerStatus, BrowserProfileError>
  readonly revoke: (
    wait: Duration.Duration
  ) => Effect.Effect<RevocationOutcome, BrowserProfileError | BrowserOwnerError>
  readonly enable: Effect.Effect<void, BrowserProfileError | BrowserOwnerError>
}

const connectForAdmin = (
  paths: BrowserProfilePaths
): Effect.Effect<
  {
    readonly request: (request: OwnerRequest) => Effect.Effect<OwnerReply, BrowserOwnerError>
    readonly close: Effect.Effect<void>
  },
  BrowserOwnerError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const locator = readLocator(paths)
    if (locator === undefined)
      return yield* ownerFailure('unavailable', 'No browser owner is published')
    const socket = yield* Effect.acquireRelease(
      Effect.try({
        try: () => createConnection({ path: locator.socket }),
        catch: cause => ownerFailure('unavailable', errorText(cause)),
      }),
      acquired => Effect.sync(() => acquired.destroy())
    )
    socket.unref()
    const bound = yield* Effect.callback<
      { readonly channel: FrameChannel; readonly pending: Map<string, PendingReply> },
      BrowserOwnerError
    >(resume => {
      const pending = new Map<string, PendingReply>()
      let settled = false
      const channel = readFrames(
        socket,
        replyLimit(defaultFetchLimits.maxBytes),
        text => {
          const decoded = decodeReply(text)
          if (decoded._tag !== 'Success') return
          const waiter = pending.get(decoded.success.requestId)
          pending.delete(decoded.success.requestId)
          waiter?.settle(decoded.success)
        },
        message => {
          const waiting = [...pending.values()]
          pending.clear()
          for (const waiter of waiting) waiter.broken(message)
          if (!settled) {
            settled = true
            resume(Effect.fail(ownerFailure('unavailable', message)))
          }
        }
      )
      socket.once('connect', () => {
        if (settled) return
        settled = true
        resume(Effect.succeed({ channel, pending }))
      })
      return Effect.void
    })
    return {
      close: Effect.sync(() => bound.channel.close()),
      request: (request: OwnerRequest) =>
        Effect.callback<OwnerReply, BrowserOwnerError>(resume => {
          bound.pending.set(request.requestId, {
            settle: reply => resume(Effect.succeed(reply)),
            broken: message => resume(Effect.fail(ownerFailure('unavailable', message))),
          })
          if (!bound.channel.write(encodeRequest(request))) {
            bound.pending.delete(request.requestId)
            resume(
              Effect.fail(ownerFailure('unavailable', 'The browser owner connection is closed'))
            )
          }
          return Effect.sync(() => {
            bound.pending.delete(request.requestId)
          })
        }),
    }
  })

const asRequestId = Schema.decodeSync(RequestId)
const newRequestId = (): RequestId => asRequestId(randomUUID())

const ownerRecorded = (paths: BrowserProfilePaths): boolean =>
  lstatSync(paths.locator, { throwIfNoEntry: false }) !== undefined

const requireSettledOwner = (paths: BrowserProfilePaths): Effect.Effect<void, BrowserOwnerError> =>
  Effect.suspend(() =>
    ownerRecorded(paths)
      ? Effect.fail(
          ownerFailure(
            'unavailable',
            `A previous browser owner left ${paths.locator}; Chrome shutdown is unverified. Stop any remaining dev-owned Chrome processes and remove this record only after verifying they are gone.`
          )
        )
      : Effect.void
  )

const gateHeld = (paths: BrowserProfilePaths): boolean => {
  try {
    privateBrowserDirectory(paths.root)
    acquireExclusiveLock(paths.gate, 'held')()
    return false
  } catch {
    return true
  }
}

const withStartupGate = <A, E>(
  paths: BrowserProfilePaths,
  operation: Effect.Effect<A, E>
): Effect.Effect<A, E | BrowserOwnerError> =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        privateBrowserDirectory(paths.root)
        return acquireExclusiveLock(paths.gate, 'A dev browser owner is active for this data home.')
      },
      catch: cause => ownerFailure('unavailable', errorText(cause)),
    }),
    () => operation,
    release => Effect.sync(release)
  )

export const makeBrowserAdmin = (options: BrowserProfileOptions): BrowserAdmin => {
  const paths = browserProfilePaths(options.dataHome)
  const profile = makeBrowserProfileOwner(options)
  const live = <A>(
    request: OwnerRequest,
    accept: (reply: OwnerReply) => Effect.Effect<A, BrowserOwnerError>,
    budget: Duration.Duration = BOOTSTRAP_BUDGET
  ): Effect.Effect<A, BrowserOwnerError> =>
    Effect.scoped(
      Effect.flatMap(connectForAdmin(paths), owner =>
        Effect.flatMap(owner.request(request), accept)
      ).pipe(
        Effect.timeoutOrElse({
          duration: budget,
          orElse: () =>
            Effect.fail(
              ownerFailure(
                'protocol',
                'The browser owner did not answer the administrative request before its deadline; its outcome is unverified'
              )
            ),
        })
      )
    )
  return {
    status: Effect.gen(function* () {
      const current = yield* profile.status
      const activity = yield* Effect.exit(
        live({ type: 'status', requestId: newRequestId() }, reply =>
          reply.type === 'status'
            ? Effect.succeed({ profile: reply.profile, activity: reply.activity })
            : Effect.fail(ownerFailure('protocol', 'The browser owner sent an unexpected status'))
        )
      )
      if (Exit.isSuccess(activity))
        return {
          profile: { ...current, ...activity.value.profile },
          owner: { kind: 'live', activity: activity.value.activity },
        } satisfies BrowserOwnerStatus
      const locator = readLocator(paths)
      return {
        profile: current,
        owner: ownerRecorded(paths)
          ? {
              kind: 'unavailable',
              message:
                locator === undefined
                  ? 'The browser owner record is unreadable or belongs to another installation; Chrome shutdown is unverified.'
                  : `A browser owner is published for process ${locator.pid} but did not answer; it may have died without settling Chrome.`,
            }
          : { kind: 'absent' },
      } satisfies BrowserOwnerStatus
    }),
    revoke: wait =>
      live(
        { type: 'revoke', requestId: newRequestId(), waitMs: Duration.toMillis(wait) },
        reply =>
          reply.type === 'revoked'
            ? Effect.succeed(reply.outcome)
            : Effect.fail(
                ownerFailure('protocol', 'The browser owner sent an unexpected revocation')
              ),
        Duration.sum(Duration.min(wait, REVOKE_SETTLE), Duration.seconds(2))
      ).pipe(
        Effect.catchIf(
          error => error.reason === 'unavailable',
          () =>
            withStartupGate(
              paths,
              Effect.suspend(() =>
                ownerRecorded(paths)
                  ? Effect.as(profile.disable, {
                      kind: 'kept-live',
                      path: paths.userDataDir,
                    } satisfies RevocationOutcome)
                  : profile.revoke(wait)
              )
            )
        )
      ),
    enable: live({ type: 'enable', requestId: newRequestId() }, reply =>
      reply.type === 'enabled'
        ? Effect.void
        : Effect.fail(ownerFailure('protocol', 'The browser owner sent an unexpected reply'))
    ).pipe(
      Effect.catchIf(
        error => error.reason === 'unavailable',
        () => withStartupGate(paths, profile.enable)
      )
    ),
  }
}

interface OwnerServeOptions {
  readonly profile?: (dataHome: string) => BrowserProfileOptions
  readonly resolveAddress?: AddressResolver
  readonly chromeArguments?: readonly string[]
  readonly browserIdle?: Duration.Duration
  readonly coordination?: CoordinationOptions
  readonly firstClientGrace?: Duration.Duration
}

interface ShutdownBox {
  current: BrowserShutdown | undefined
}

interface LiveChrome {
  readonly browser: Browser
  readonly host: RenderHost
  readonly scope: Scope.Closeable
  readonly release: () => void
  readonly outcome: ShutdownBox
  idleTimer: Fiber.Fiber<void> | undefined
}

interface OwnerClient {
  readonly channel: FrameChannel
  readonly active: Semaphore.Semaphore
  readonly renders: Map<string, Fiber.Fiber<void>>
  rendering: boolean
  closed: boolean
}

const runBrowserOwner = Effect.fnUntraced(function* (
  dataHome: string,
  options: OwnerServeOptions,
  bootstrap: {
    readonly prepared: (epoch: string, socket: string) => Effect.Effect<void>
    readonly commit: Effect.Effect<void, BrowserOwnerError>
    readonly ready: Effect.Effect<void>
  }
): Effect.fn.Return<
  void,
  BrowserOwnerError | BrowserProfileError,
  Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
> {
  const ownerScope = yield* Effect.scope
  const paths = browserProfilePaths(dataHome)
  const profileOptions = options.profile?.(dataHome) ?? { dataHome }
  const profile = makeBrowserProfileOwner(profileOptions)
  const resolve = options.resolveAddress ?? resolvePublicAddress
  const spawnerContext = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>()
  const epoch = randomUUID()
  yield* Effect.try({
    try: () => privateBrowserDirectory(paths.root),
    catch: cause => ownerFailure('bootstrap', errorText(cause)),
  })
  yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        acquireExclusiveLock(
          paths.gate,
          'Another dev browser owner already serves this data home.'
        ),
      catch: cause =>
        ownerFailure(
          cause instanceof CoordinationError ? 'conflict' : 'bootstrap',
          errorText(cause)
        ),
    }).pipe(
      Effect.retry({
        while: error => error.reason === 'conflict',
        schedule: Schedule.spaced(Duration.millis(50)).pipe(
          Schedule.upTo({ duration: Duration.seconds(1) })
        ),
      })
    ),
    release => Effect.sync(release)
  )
  yield* requireSettledOwner(paths)
  yield* acquireRuntime(dataHome, options.coordination).pipe(
    Effect.mapError(error => ownerFailure('bootstrap', error.message))
  )
  const socketDirectory = yield* Effect.acquireRelease(
    Effect.try({
      try: privateSocketDirectory,
      catch: cause => ownerFailure('bootstrap', errorText(cause)),
    }),
    directory => Effect.sync(() => rmSync(directory, { recursive: true, force: true }))
  )
  const socketPath = join(socketDirectory, 'render.sock')

  const clients = new Set<OwnerClient>()
  const state = {
    draining: false,
    queued: 0,
    rendering: 0,
    everConnected: false,
  }
  const chromeLock = yield* Semaphore.make(1)
  const admin = yield* Semaphore.make(1)
  const slots = yield* Semaphore.make(ACTIVE_RENDERS)
  let live: LiveChrome | undefined
  let retained: { readonly release: () => void; readonly message: string } | undefined
  const retire = yield* Deferred.make<void>()

  const closeChrome = Effect.fnUntraced(function* (
    beforeRelease: Effect.Effect<void> = Effect.void
  ): Effect.fn.Return<BrowserShutdown> {
    const current = live
    if (current === undefined) {
      const previous = yield* retryChromeShutdown(paths.userDataDir)
      if (previous.kind !== 'settled') return previous
      yield* beforeRelease
      const held = retained
      retained = undefined
      if (held !== undefined) yield* Effect.sync(held.release)
      return previous
    }
    live = undefined
    const timer = current.idleTimer
    current.idleTimer = undefined
    if (timer !== undefined) yield* Fiber.interrupt(timer)
    yield* Scope.close(current.scope, Exit.void)
    const outcome = current.outcome.current ?? { kind: 'settled' as const }
    if (outcome.kind === 'settled') {
      yield* beforeRelease
      yield* Effect.sync(current.release)
    } else retained = { release: current.release, message: outcome.message }
    return outcome
  })

  const closeWhenIdle = (current: LiveChrome) =>
    chromeLock.withPermits(1)(
      Effect.suspend(() => {
        if (live !== current || current.host.active() > 0) return Effect.void
        current.idleTimer = undefined
        return Effect.asVoid(closeChrome())
      })
    )

  const scheduleIdleClose = Effect.fnUntraced(function* (current: LiveChrome) {
    if (live !== current) return
    const previous = current.idleTimer
    current.idleTimer = undefined
    if (previous !== undefined) yield* Fiber.interrupt(previous)
    current.idleTimer = yield* Effect.forkIn(
      Effect.sleep(options.browserIdle ?? BROWSER_IDLE).pipe(
        Effect.andThen(closeWhenIdle(current)),
        Effect.asVoid
      ),
      ownerScope
    )
  })

  const policy = {
    admit: (url: string) =>
      validateUrl(url).pipe(
        Effect.flatMap(valid => resolve(valid.hostname)),
        Effect.asVoid
      ),
  }

  const openChrome: Effect.Effect<LiveChrome, BrowserError | BrowserProfileError> =
    Effect.uninterruptible(
      Effect.gen(function* () {
        if (live !== undefined) return live
        const previous = yield* retryChromeShutdown(paths.userDataDir)
        if (previous.kind === 'unobserved')
          return yield* new BrowserError({
            reason: 'shutdown',
            message: `${previous.message}. The profile copy is still locked; a later browser read or an explicit lifecycle operation will retry settlement.`,
          })
        const held = retained
        retained = undefined
        if (held !== undefined) yield* Effect.sync(held.release)
        const now = yield* Clock.currentTimeMillis
        const acquired = yield* profile.acquire(now)
        const scope = yield* Scope.fork(ownerScope)
        const outcome: ShutdownBox = { current: undefined }
        const abandon = Scope.close(scope, Exit.void).pipe(
          Effect.andThen(
            Effect.sync(() => {
              const reported = outcome.current
              if (reported === undefined || reported.kind === 'settled') acquired.release()
              else retained = { release: acquired.release, message: reported.message }
            })
          )
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
          reported => {
            outcome.current = reported
          }
        ).pipe(
          Scope.provide(scope),
          Effect.provide(spawnerContext),
          Effect.tapError(() => abandon)
        )
        const host = yield* makeRenderHost(browser, policy).pipe(
          Scope.provide(scope),
          Effect.tapError(() => abandon)
        )
        const current: LiveChrome = {
          browser,
          host,
          scope,
          release: acquired.release,
          outcome,
          idleTimer: undefined,
        }
        live = current
        return current
      })
    )

  const renderOne = Effect.fnUntraced(function* (
    url: string,
    maxHtmlChars: number
  ): Effect.fn.Return<RenderedPage, RenderFailure> {
    if (state.draining)
      return yield* ownerFailure('retiring', 'The dev browser owner is shutting down')
    if (yield* profile.disabled)
      return yield* new BrowserProfileError({
        reason: 'disabled',
        message:
          'Authenticated browser rendering is disabled for this data home; run `dev browser enable` to allow it again.',
      })
    const current = yield* chromeLock.withPermits(1)(openChrome)
    return yield* current.host
      .render(url, { timeout: RENDER_BUDGET, maxHtmlChars })
      .pipe(
        Effect.ensuring(
          chromeLock.withPermits(1)(
            Effect.suspend(() => (live === current ? scheduleIdleClose(current) : Effect.void))
          )
        )
      )
  })

  const admitRender = (
    client: OwnerClient,
    request: Extract<OwnerRequest, { type: 'render' }>
  ): Effect.Effect<OwnerReply> =>
    Effect.suspend(() => {
      if (!client.rendering && renderClients() >= MAX_RENDER_CLIENTS)
        return Effect.succeed<OwnerReply>({
          type: 'failed',
          requestId: request.requestId,
          error: ownerFailure(
            'capacity',
            `The dev browser owner already serves ${MAX_RENDER_CLIENTS} rendering clients; retry later`
          ),
        })
      client.rendering = true
      if (state.queued >= MAX_QUEUED_RENDERS)
        return Effect.succeed<OwnerReply>({
          type: 'failed',
          requestId: request.requestId,
          error: ownerFailure(
            'capacity',
            `The dev browser owner already has ${MAX_QUEUED_RENDERS} renders waiting; retry later`
          ),
        })
      state.queued += 1
      let waiting = true
      const leaveQueue = Effect.sync(() => {
        if (!waiting) return
        waiting = false
        state.queued -= 1
      })
      const budget = Duration.millis(
        Math.max(1, Math.min(request.budgetMs, Duration.toMillis(RENDER_BUDGET)))
      )
      return client.active
        .withPermits(1)(
          slots.withPermits(1)(
            Effect.gen(function* () {
              yield* leaveQueue
              state.rendering += 1
              return yield* Effect.ensuring(
                renderOne(request.url, request.maxHtmlChars),
                Effect.sync(() => {
                  state.rendering -= 1
                })
              )
            })
          )
        )
        .pipe(
          Effect.timeoutOrElse({
            duration: budget,
            orElse: () =>
              Effect.fail(
                ownerFailure(
                  'capacity',
                  `The render did not start or finish within ${Duration.toSeconds(budget)} seconds`
                )
              ),
          }),
          Effect.match({
            onFailure: (error: RenderFailure): OwnerReply => ({
              type: 'failed',
              requestId: request.requestId,
              error,
            }),
            onSuccess: (page): OwnerReply => ({
              type: 'rendered',
              requestId: request.requestId,
              page: { ...page, ...(page.status === undefined ? {} : { status: page.status }) },
            }),
          }),
          Effect.ensuring(leaveQueue)
        )
    })

  const drainRenders = (wait: Duration.Duration): Effect.Effect<boolean> =>
    Effect.repeat(
      Effect.sync((): boolean => state.rendering + state.queued === 0),
      {
        schedule: Schedule.spaced(DRAIN_INTERVAL).pipe(Schedule.upTo({ duration: wait })),
        until: (idle: boolean) => idle,
      }
    )

  const revokeThroughOwner = (
    wait: Duration.Duration
  ): Effect.Effect<RevocationOutcome, BrowserProfileError> =>
    admin.withPermits(1)(
      Effect.gen(function* () {
        yield* profile.disable
        const drained = yield* drainRenders(wait)
        if (!drained)
          return { kind: 'kept-live', path: paths.userDataDir } satisfies RevocationOutcome
        return yield* chromeLock.withPermits(1)(
          Effect.gen(function* () {
            if (live === undefined && retained === undefined) return yield* profile.revoke(wait)
            let removed: RevocationOutcome | undefined
            const outcome = yield* closeChrome(
              Effect.flatMap(profile.removeHeldCopy, result =>
                Effect.sync(() => {
                  removed = result
                })
              ).pipe(Effect.orElseSucceed(() => undefined))
            )
            if (outcome.kind !== 'settled' || removed === undefined)
              return { kind: 'kept-live', path: paths.userDataDir } satisfies RevocationOutcome
            return removed
          })
        )
      })
    )

  const enableThroughOwner: Effect.Effect<void, BrowserProfileError> = admin.withPermits(1)(
    profile.enable
  )

  const renderClients = (): number => [...clients].filter(client => client.rendering).length
  const activity = (): OwnerActivity => ({
    clients: renderClients(),
    rendering: state.rendering,
    queued: state.queued,
    draining: state.draining,
    chrome: live !== undefined,
    ...(retained === undefined ? {} : { unobserved: retained.message }),
  })

  const handle = Effect.fnUntraced(function* (
    client: OwnerClient,
    request: OwnerRequest
  ): Effect.fn.Return<void> {
    if (request.type === 'cancel') {
      const fiber = client.renders.get(request.requestId)
      if (fiber !== undefined) yield* Fiber.interrupt(fiber)
      return
    }
    if (request.type === 'status') {
      const current = yield* Effect.orElseSucceed(profile.status, () => undefined)
      if (current === undefined) return
      yield* Effect.sync(() =>
        client.channel.write(
          encodeReply({
            type: 'status',
            requestId: request.requestId,
            profile: {
              ...current,
              ...(current.chrome === undefined ? {} : { chrome: current.chrome }),
              ...(current.copy === undefined ? {} : { copy: current.copy }),
            },
            activity: activity(),
          })
        )
      )
      return
    }
    if (request.type === 'revoke') {
      const outcome = yield* Effect.exit(
        revokeThroughOwner(
          Duration.millis(Math.min(request.waitMs, Duration.toMillis(REVOKE_SETTLE)))
        )
      )
      yield* Effect.sync(() =>
        client.channel.write(
          encodeReply(
            Exit.isSuccess(outcome)
              ? { type: 'revoked', requestId: request.requestId, outcome: outcome.value }
              : { type: 'failed', requestId: request.requestId, error: wireFailure(outcome.cause) }
          )
        )
      )
      return
    }
    if (request.type === 'enable') {
      const enabled = yield* Effect.exit(enableThroughOwner)
      yield* Effect.sync(() =>
        client.channel.write(
          encodeReply(
            Exit.isSuccess(enabled)
              ? { type: 'enabled', requestId: request.requestId }
              : { type: 'failed', requestId: request.requestId, error: wireFailure(enabled.cause) }
          )
        )
      )
      return
    }
    const fiber = yield* Effect.forkIn(
      admitRender(client, request).pipe(
        Effect.flatMap(reply => Effect.sync(() => client.channel.write(encodeReply(reply)))),
        Effect.catchCause(() =>
          Effect.sync(() =>
            client.channel.write(
              encodeReply({
                type: 'failed',
                requestId: request.requestId,
                error: ownerFailure('unavailable', 'The render was cancelled by the owner'),
              })
            )
          )
        ),
        Effect.ensuring(
          Effect.sync(() => {
            client.renders.delete(request.requestId)
          })
        ),
        Effect.asVoid
      ),
      ownerScope
    )
    yield* Effect.sync(() => {
      client.renders.set(request.requestId, fiber)
    })
  })

  const runFork = Effect.runForkWith(yield* Effect.context<never>())

  const acceptClient = (socket: Socket): void => {
    if (clients.size >= MAX_CONNECTIONS || state.draining) {
      socket.destroy()
      return
    }
    const silent = setTimeout(() => socket.destroy(), Duration.toMillis(BOOTSTRAP_BUDGET))
    const bound: OwnerClient = {
      channel: readFrames(
        socket,
        MAX_CONTROL_FRAME,
        text => {
          const decoded = decodeRequest(text)
          if (decoded._tag !== 'Success') {
            socket.destroy()
            return
          }
          clearTimeout(silent)
          runFork(Effect.ignore(handle(bound, decoded.success)))
        },
        () => {
          clearTimeout(silent)
          if (bound.closed) return
          bound.closed = true
          clients.delete(bound)
          for (const fiber of bound.renders.values()) runFork(Fiber.interrupt(fiber))
          bound.renders.clear()
          if (clients.size === 0 && state.everConnected) Deferred.doneUnsafe(retire, Exit.void)
        }
      ),
      active: Semaphore.makeUnsafe(1),
      renders: new Map(),
      rendering: false,
      closed: false,
    }
    state.everConnected = true
    clients.add(bound)
  }

  yield* Effect.acquireRelease(
    Effect.callback<Server, BrowserOwnerError>(resume => {
      const created = createServer(acceptClient)
      created.unref()
      created.once('error', cause =>
        resume(
          Effect.fail(
            ownerFailure('bootstrap', `The browser owner socket failed: ${errorText(cause)}`)
          )
        )
      )
      created.listen(socketPath, () => {
        try {
          chmodSync(socketPath, 0o600)
        } catch {}
        resume(Effect.succeed(created))
      })
      return Effect.void
    }),
    created => Effect.sync(() => created.close())
  )

  yield* bootstrap.prepared(epoch, socketPath)
  yield* Effect.timeoutOrElse(bootstrap.commit, {
    duration: BOOTSTRAP_BUDGET,
    orElse: () =>
      Effect.fail(
        ownerFailure('bootstrap', 'The bootstrap commit did not arrive within ten seconds')
      ),
  })
  yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        writeFileSync(
          paths.locator,
          `${encodeLocator({
            epoch,
            socket: socketPath,
            pid: process.pid,
            startedAt: Date.now(),
            installation: installationPath(),
          })}\n`,
          { mode: 0o600 }
        )
      },
      catch: cause => ownerFailure('bootstrap', errorText(cause)),
    }),
    () =>
      Effect.sync(() => {
        const current = readLocator(paths)
        if (current?.epoch === epoch && live === undefined && retained === undefined)
          rmSync(paths.locator, { force: true })
      })
  )
  yield* bootstrap.ready
  yield* Effect.race(
    Deferred.await(retire),
    Effect.sleep(options.firstClientGrace ?? FIRST_CLIENT_GRACE).pipe(
      Effect.andThen(
        Effect.suspend(() =>
          clients.size === 0 && !state.everConnected ? Effect.void : Deferred.await(retire)
        )
      )
    )
  )
  yield* Effect.sync(() => {
    state.draining = true
  })
  yield* chromeLock.withPermits(1)(Effect.asVoid(closeChrome()))
}, Effect.scoped)

const sendToParent = (message: unknown): void => {
  if (process.connected && process.send !== undefined) process.send(message)
}

const bootstrapChannel = () => {
  const commit = Deferred.makeUnsafe<void, BrowserOwnerError>()
  let autonomous = false
  const send = sendToParent
  process.on('message', (raw: unknown) => {
    const decoded = decodeBootstrap(raw)
    if (decoded._tag !== 'Success' || decoded.success.type !== 'commit') return
    Deferred.doneUnsafe(commit, Exit.void)
  })
  process.on('disconnect', () => {
    if (!autonomous)
      Deferred.doneUnsafe(
        commit,
        Exit.fail(ownerFailure('bootstrap', 'The bootstrap channel closed before commit'))
      )
  })
  return {
    prepared: (epoch: string, socket: string) =>
      Effect.sync(() => send({ type: 'prepared', epoch, socket })),
    commit: Deferred.await(commit),
    ready: Effect.sync(() => {
      autonomous = true
      send({ type: 'ready' })
      if (process.connected) process.disconnect?.()
    }),
    failed: (reason: BrowserOwnerError['reason'], message: string) =>
      send({ type: 'bootstrap-failed', reason, message }),
  }
}

const requestOrderlyExit = (): void => {
  process.exitCode = 0
}

const awaitPrepare: Effect.Effect<string> = Effect.callback<string>(resume => {
  const onMessage = (raw: unknown): void => {
    const decoded = decodeBootstrap(raw)
    if (decoded._tag !== 'Success' || decoded.success.type !== 'prepare') return
    process.removeListener('message', onMessage)
    resume(Effect.succeed(decoded.success.dataHome))
  }
  process.on('message', onMessage)
  return Effect.sync(() => process.removeListener('message', onMessage))
})

export const serveBrowserOwner = (options: OwnerServeOptions = {}): void => {
  if (typeof process.send !== 'function') {
    console.error('src/web-browser-owner.ts must be launched with child_process.fork and IPC')
    process.exitCode = 2
    return
  }
  const channel = bootstrapChannel()
  process.on('SIGTERM', requestOrderlyExit)
  process.on('SIGINT', requestOrderlyExit)
  NodeRuntime.runMain(
    awaitPrepare.pipe(
      Effect.flatMap(dataHome => runBrowserOwner(dataHome, options, channel)),
      Effect.tapCause(cause =>
        Effect.sync(() => {
          const failure = Cause.squash(cause)
          channel.failed(
            failure instanceof BrowserOwnerError ? failure.reason : 'bootstrap',
            errorText(failure)
          )
        })
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (process.connected) process.disconnect?.()
        })
      ),
      Effect.provide(NodeServices.layer)
    ),
    { disableErrorReporting: true }
  )
}

const OWNER_ENTRY = new URL('./web-browser-owner.ts', import.meta.url)

export const makeOwnerBootstrap = (options: {
  readonly dataHome: string
  readonly entry?: URL
  readonly onFailure?: (message: string) => void
}): EnsureOwner => {
  const paths = browserProfilePaths(options.dataHome)
  const entry = fileURLToPath(options.entry ?? OWNER_ENTRY)
  const spawn = Effect.callback<void, BrowserOwnerError>(resume => {
    let child: ChildProcess
    try {
      child = fork(entry, [], {
        cwd: dirname(paths.root),
        detached: true,
        execArgv: [],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { ...process.env, DEV_DATA_HOME: options.dataHome },
      })
    } catch (cause) {
      resume(Effect.fail(ownerFailure('bootstrap', errorText(cause))))
      return
    }
    let transferred = false
    let settled = false
    const settle = (result: Effect.Effect<void, BrowserOwnerError>): void => {
      if (settled) return
      settled = true
      resume(result)
    }
    const abandon = (message: string): void => {
      if (!transferred) {
        try {
          child.kill('SIGKILL')
        } catch {}
      }
      settle(Effect.fail(ownerFailure('bootstrap', message)))
    }
    child.on('message', (raw: unknown) => {
      const decoded = decodeBootstrapReply(raw)
      if (decoded._tag !== 'Success') return
      const reply = decoded.success
      if (reply.type === 'prepared') {
        transferred = true
        child.send({ type: 'commit' })
        return
      }
      if (reply.type === 'ready') {
        child.unref()
        settle(Effect.void)
        return
      }
      options.onFailure?.(reply.message)
      if (!transferred) {
        try {
          child.kill('SIGKILL')
        } catch {}
      }
      settle(Effect.fail(ownerFailure(reply.reason, reply.message)))
    })
    child.once('error', cause => abandon(errorText(cause)))
    child.once('exit', () => {
      if (transferred && readLocator(paths) !== undefined) {
        settle(Effect.void)
        return
      }
      abandon('The browser owner exited during bootstrap')
    })
    child.send({ type: 'prepare', dataHome: options.dataHome })
    return Effect.sync(() => {
      if (!transferred) {
        try {
          child.kill('SIGKILL')
        } catch {}
      }
    })
  }).pipe(
    Effect.timeoutOrElse({
      duration: BOOTSTRAP_BUDGET,
      orElse: () =>
        Effect.fail(
          ownerFailure('bootstrap', 'The browser owner did not become ready within ten seconds')
        ),
    })
  )
  type GateOutcome = 'published' | 'free' | 'held'
  const gateOutcome = (): GateOutcome => {
    if (readLocator(paths) !== undefined) return 'published'
    return gateHeld(paths) ? 'held' : 'free'
  }
  const awaitGateOutcome: Effect.Effect<GateOutcome> = Effect.repeat(Effect.sync(gateOutcome), {
    schedule: Schedule.spaced(Duration.millis(100)).pipe(
      Schedule.upTo({ duration: BOOTSTRAP_BUDGET })
    ),
    until: (outcome: GateOutcome) => outcome !== 'held',
  })
  const heldWithoutOwner = ownerFailure(
    'bootstrap',
    'Another dev process holds the browser startup gate but published no owner within ten seconds'
  )
  const followPublication: Effect.Effect<void, BrowserOwnerError> = Effect.flatMap(
    awaitGateOutcome,
    outcome =>
      outcome === 'published'
        ? Effect.void
        : Effect.fail(
            outcome === 'held'
              ? heldWithoutOwner
              : ownerFailure(
                  'bootstrap',
                  'The browser startup gate was released without a published owner'
                )
          )
  )
  const spawnOrFollow: Effect.Effect<void, BrowserOwnerError> = spawn.pipe(
    Effect.catchIf(
      error => error.reason === 'conflict',
      () => followPublication
    )
  )
  const follow = (outcome: GateOutcome): Effect.Effect<void, BrowserOwnerError> => {
    switch (outcome) {
      case 'published':
        return Effect.void
      case 'free':
        return spawnOrFollow
      case 'held':
        return Effect.fail(heldWithoutOwner)
    }
  }
  const starting = Semaphore.makeUnsafe(1)
  return {
    ensure: starting.withPermits(1)(
      Effect.suspend(() =>
        gateHeld(paths)
          ? Effect.flatMap(awaitGateOutcome, follow)
          : Effect.andThen(requireSettledOwner(paths), spawnOrFollow)
      )
    ),
  }
}

const isMainModule = (): boolean => {
  const [, argument] = process.argv
  if (argument === undefined) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argument)
  } catch {
    return false
  }
}

if (isMainModule()) serveBrowserOwner()
