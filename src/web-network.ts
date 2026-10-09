import { lookup } from 'node:dns/promises'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { Duration, Effect, Schema } from 'effect'
import { errorText } from './error-text.ts'

export class WebNetworkError extends Schema.TaggedError<WebNetworkError>()('WebNetworkError', {
  reason: Schema.Literals(['url', 'destination', 'dns', 'connection', 'response', 'limit']),
  message: Schema.String,
}) {}

const refuse = (reason: WebNetworkError['reason'], message: string) =>
  new WebNetworkError({ reason, message })

const reserved = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  reserved.addSubnet(address, prefix, 'ipv4')
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const)
  reserved.addSubnet(address, prefix, 'ipv6')

const bracketless = (host: string): string =>
  host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host

export const isPublicAddress = (address: string): boolean => {
  const family = isIP(address)
  if (family === 0) return false
  return !reserved.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

const forbiddenHostSuffixes = ['localhost', 'local', 'internal', 'localdomain', 'home.arpa']

export const validateUrl = (input: string): Effect.Effect<URL, WebNetworkError> =>
  Effect.suspend(() => {
    let url: URL
    try {
      url = new URL(input)
    } catch {
      return Effect.fail(refuse('url', `Not an absolute URL: ${input}`))
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      return Effect.fail(
        refuse('url', `Only http and https destinations are read; refused ${url.protocol}`)
      )
    if (url.username !== '' || url.password !== '')
      return Effect.fail(refuse('url', 'URLs carrying credentials are refused'))
    const host = bracketless(url.hostname).toLowerCase()
    if (host === '') return Effect.fail(refuse('url', 'The URL names no host'))
    const literal = isIP(host) !== 0
    if (literal && !isPublicAddress(host))
      return Effect.fail(
        refuse('destination', `Private or reserved address refused before connecting: ${host}`)
      )
    const last = host.split('.').at(-1) ?? ''
    if (
      !literal &&
      (forbiddenHostSuffixes.some(suffix => host === suffix || host.endsWith(`.${suffix}`)) ||
        /^\d+$/.test(last))
    )
      return Effect.fail(refuse('destination', `Non-public host name refused: ${host}`))
    url.hash = ''
    return Effect.succeed(url)
  })

const DNS_TIMEOUT = Duration.seconds(10)

export type LookupAll = (hostname: string) => Promise<readonly { readonly address: string }[]>

export const makeAddressResolver =
  (lookupAll: LookupAll) =>
  (hostname: string): Effect.Effect<string, WebNetworkError> =>
    Effect.suspend(() => {
      const host = bracketless(hostname)
      if (isIP(host) !== 0)
        return isPublicAddress(host)
          ? Effect.succeed(host)
          : Effect.fail(refuse('destination', `Private or reserved address refused: ${host}`))
      return Effect.tryPromise({
        try: () => lookupAll(host),
        catch: cause => refuse('dns', `${host} could not be resolved: ${errorText(cause)}`),
      }).pipe(
        Effect.timeoutOrElse({
          duration: DNS_TIMEOUT,
          orElse: () => Effect.fail(refuse('dns', `${host} did not resolve within 10 seconds`)),
        }),
        Effect.flatMap(answers => {
          if (answers.length === 0) return Effect.fail(refuse('dns', `${host} has no address`))
          const blocked = answers.filter(answer => !isPublicAddress(answer.address))
          if (blocked.length > 0)
            return Effect.fail(
              refuse(
                'destination',
                `${host} resolves to a private or reserved address (${blocked.map(answer => answer.address).join(', ')}); refused before connecting`
              )
            )
          const [first] = answers
          return first === undefined
            ? Effect.fail(refuse('dns', `${host} has no address`))
            : Effect.succeed(first.address)
        })
      )
    })

export const resolvePublicAddress = makeAddressResolver(host =>
  lookup(host, { all: true, verbatim: true })
)

export interface FetchLimits {
  readonly maxBytes: number
  readonly maxRedirects: number
  readonly timeout: Duration.Duration
}

export const defaultFetchLimits: FetchLimits = {
  maxBytes: 8 * 1024 * 1024,
  maxRedirects: 5,
  timeout: Duration.seconds(45),
}

export interface FetchedResponse {
  readonly requestedUrl: string
  readonly finalUrl: string
  readonly status: number
  readonly contentType: string | undefined
  readonly body: Uint8Array
  readonly truncated: boolean
  readonly redirects: readonly string[]
  readonly charset: string | undefined
}

const requestHeaders = {
  accept:
    'text/markdown, text/x-markdown;q=0.95, text/plain;q=0.9, text/html;q=0.8, application/xhtml+xml;q=0.7, */*;q=0.1',
  'accept-language': 'en, *;q=0.5',
  'user-agent': 'dev-read-url/1 (+https://github.com/taekwondodev/dev)',
  'accept-encoding': 'identity',
}

interface RawResponse {
  readonly status: number
  readonly headers: IncomingMessage['headers']
  readonly body: Uint8Array
  readonly truncated: boolean
}

const singleRequest = (
  url: URL,
  address: string,
  maxBytes: number,
  signal: AbortSignal | undefined
): Effect.Effect<RawResponse, WebNetworkError> =>
  Effect.callback<RawResponse, WebNetworkError>(resume => {
    const family = isIP(address) === 6 ? 6 : 4
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)({
      protocol: url.protocol,
      host: bracketless(url.hostname),
      port: url.port === '' ? undefined : Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: requestHeaders,
      agent: false,
      signal,
      lookup: (_hostname, options, callback) =>
        options.all === true
          ? callback(null, [{ address, family }])
          : callback(null, address, family),
    })
    let settled = false
    const finish = (result: Effect.Effect<RawResponse, WebNetworkError>) => {
      if (settled) return
      settled = true
      resume(result)
    }
    request.on('error', cause => {
      finish(
        Effect.fail(
          refuse(
            'connection',
            `${url.origin} could not be read: ${cause instanceof Error && cause.name === 'AbortError' ? 'the read was cancelled' : errorText(cause)}`
          )
        )
      )
    })
    request.on('response', response => {
      const chunks: Buffer[] = []
      let received = 0
      let truncated = false
      const complete = () =>
        finish(
          Effect.succeed({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: new Uint8Array(Buffer.concat(chunks)),
            truncated,
          })
        )
      response.on('data', (chunk: Buffer) => {
        if (truncated) return
        const room = maxBytes - received
        if (chunk.length > room) {
          chunks.push(chunk.subarray(0, room))
          received += room
          truncated = true
          response.destroy()
          complete()
          return
        }
        chunks.push(chunk)
        received += chunk.length
      })
      response.on('end', complete)
      response.on('error', cause => {
        if (truncated) return
        finish(
          Effect.fail(
            refuse('connection', `${url.origin} body could not be read: ${errorText(cause)}`)
          )
        )
      })
    })
    request.end()
    return Effect.sync(() => {
      request.destroy()
    })
  })

const redirectStatuses = new Set([301, 302, 303, 307, 308])

const resolveLocation = (location: string, base: URL): URL | undefined => {
  try {
    return new URL(location, base)
  } catch {
    return undefined
  }
}

const normalizedContentType = (header: string | string[] | undefined): string | undefined => {
  if (header === undefined) return undefined
  const value = Array.isArray(header) ? header[0] : header
  return value?.split(';')[0]?.trim().toLowerCase() || undefined
}

const singleHeader = (header: string | string[] | undefined): string | undefined =>
  Array.isArray(header) ? header[0] : header

export type AddressResolver = (hostname: string) => Effect.Effect<string, WebNetworkError>

export interface FetchOptions {
  readonly limits?: FetchLimits
  readonly signal?: AbortSignal
  readonly resolve?: AddressResolver
}

export const fetchPublic = Effect.fnUntraced(function* (
  input: string,
  options: FetchOptions = {}
): Effect.fn.Return<FetchedResponse, WebNetworkError> {
  const { limits = defaultFetchLimits, signal, resolve = resolvePublicAddress } = options
  const requested = yield* validateUrl(input)
  let current = requested
  const redirects: string[] = []
  const deadline = Effect.fnUntraced(function* <A>(
    effect: Effect.Effect<A, WebNetworkError>
  ): Effect.fn.Return<A, WebNetworkError> {
    return yield* Effect.timeoutOrElse(effect, {
      duration: limits.timeout,
      orElse: () =>
        Effect.fail(
          refuse(
            'limit',
            `${requested.href} was not read within ${Duration.toSeconds(limits.timeout)} seconds`
          )
        ),
    })
  })
  return yield* deadline(
    Effect.gen(function* () {
      for (;;) {
        const address = yield* resolve(current.hostname)
        const response = yield* singleRequest(current, address, limits.maxBytes, signal)
        const location = singleHeader(response.headers.location)
        if (redirectStatuses.has(response.status) && location !== undefined) {
          if (redirects.length >= limits.maxRedirects)
            return yield* refuse(
              'limit',
              `${requested.href} redirected more than ${limits.maxRedirects} times; the last target was ${location}`
            )
          const target = resolveLocation(location, current)
          if (target === undefined)
            return yield* refuse('response', `${current.href} redirected to an invalid location`)
          current = yield* validateUrl(target.href).pipe(
            Effect.mapError(error =>
              refuse(error.reason, `Redirect from ${current.href} refused: ${error.message}`)
            )
          )
          redirects.push(current.href)
          continue
        }
        return {
          requestedUrl: requested.href,
          finalUrl: current.href,
          status: response.status,
          contentType: normalizedContentType(response.headers['content-type']),
          body: response.body,
          truncated: response.truncated,
          redirects,
          charset: charsetOf(response.headers['content-type']),
        }
      }
    })
  )
})

const charsetOf = (header: string | string[] | undefined): string | undefined => {
  const value = singleHeader(header)
  const match = value?.match(/charset\s*=\s*"?([\w.:-]+)"?/i)
  return match?.[1]?.toLowerCase()
}
