import { readFileSync } from 'node:fs'
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import * as Clock from 'effect/Clock'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { errorText } from '../error-text.ts'
import {
  OrbViewSchema,
  orbFailure,
  type OrbCredentials,
  type OrbError,
  type OrbSize,
  type OrbView,
} from './domain.ts'

export interface HttpReply {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

interface HttpCall {
  readonly method: 'GET' | 'POST' | 'DELETE'
  readonly url: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: unknown
}

const REQUEST_TIMEOUT_MS = 30_000
const RENEW_MARGIN_MS = 5 * 60_000

export const httpJson = (
  call: HttpCall,
  ca: Buffer | undefined
): Effect.Effect<HttpReply, OrbError> =>
  Effect.callback<HttpReply, OrbError>(resume => {
    const failed = (cause: unknown) =>
      resume(Effect.fail(orbFailure(`${call.method} ${call.url}: ${errorText(cause)}`, cause)))
    let target: URL
    try {
      target = new URL(call.url)
    } catch (cause) {
      failed(cause)
      return
    }
    const payload = call.body === undefined ? undefined : JSON.stringify(call.body)
    const options = {
      method: call.method,
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        Accept: 'application/json',
        ...(payload === undefined
          ? {}
          : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
        ...call.headers,
      },
    }
    const onReply = (reply: IncomingMessage): void => {
      const chunks: Buffer[] = []
      reply.on('data', (chunk: Buffer) => chunks.push(chunk))
      reply.on('error', failed)
      reply.on('end', () =>
        resume(
          Effect.succeed({
            status: reply.statusCode ?? 0,
            headers: reply.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        )
      )
    }
    const sent =
      target.protocol === 'https:'
        ? httpsRequest(target, { ...options, ...(ca === undefined ? {} : { ca }) }, onReply)
        : httpRequest(target, options, onReply)
    sent.on('timeout', () => sent.destroy(new Error('the request timed out')))
    sent.on('error', failed)
    sent.end(payload)
    return Effect.sync(() => {
      sent.destroy()
    })
  })

export const identityTokensUrl = (authUrl: string): string => {
  const root = authUrl.replace(/\/+$/, '')
  return `${root.endsWith('/v3') ? root : `${root}/v3`}/auth/tokens`
}

export const tokenRequestBody = (credentials: OrbCredentials) => ({
  auth: {
    identity: {
      methods: ['password'],
      password: {
        user: {
          name: credentials.username,
          domain: { id: credentials.user_domain_id ?? 'default' },
          password: credentials.password,
        },
      },
    },
    scope: {
      project: {
        name: credentials.project_name,
        domain: { id: credentials.project_domain_id ?? 'default' },
      },
    },
  },
})

const EndpointSchema = Schema.Struct({
  interface: Schema.String,
  region: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.NonEmptyString,
})
const TokenBodySchema = Schema.fromJsonString(
  Schema.Struct({
    token: Schema.Struct({
      expires_at: Schema.NullOr(Schema.String),
      project: Schema.Struct({ id: Schema.NonEmptyString, name: Schema.NonEmptyString }),
      catalog: Schema.Array(
        Schema.Struct({ type: Schema.String, endpoints: Schema.Array(EndpointSchema) })
      ),
    }),
  })
)

export interface KeystoneToken {
  readonly id: string
  readonly expiresAt: number | undefined
  readonly orbitUrl: string
  readonly project: { readonly id: string; readonly name: string }
}

const ORBIT_SERVICE_TYPE = 'orbit'

export const parseToken = Effect.fnUntraced(function* (
  reply: HttpReply,
  region: string | undefined
): Effect.fn.Return<KeystoneToken, OrbError> {
  if (reply.status !== 201)
    return yield* orbFailure(
      `Keystone refused the token request (${reply.status}): ${reply.body.trim() || 'no detail'}`,
      undefined,
      reply.status
    )
  const id = reply.headers['x-subject-token']
  if (typeof id !== 'string' || id.length === 0)
    return yield* orbFailure('Keystone answered without an X-Subject-Token header')
  const { token } = yield* Schema.decodeEffect(TokenBodySchema)(reply.body).pipe(
    Effect.mapError(cause => orbFailure(`Unexpected Keystone token body: ${cause.message}`, cause))
  )
  const publicEndpoints = token.catalog
    .filter(service => service.type === ORBIT_SERVICE_TYPE)
    .flatMap(service => service.endpoints)
    .filter(endpoint => endpoint.interface === 'public')
  const endpoint =
    publicEndpoints.find(candidate => region !== undefined && candidate.region === region) ??
    publicEndpoints[0]
  if (endpoint === undefined)
    return yield* orbFailure(
      `Keystone's catalog for project ${token.project.name} has no public endpoint of type ${ORBIT_SERVICE_TYPE}`
    )
  const expiresAt =
    token.expires_at === null
      ? undefined
      : Option.getOrUndefined(Option.map(DateTime.make(token.expires_at), DateTime.toEpochMillis))
  return {
    id,
    expiresAt,
    orbitUrl: endpoint.url.replace(/\/+$/, ''),
    project: token.project,
  }
})

export interface Keystone {
  readonly authUrl: string
  readonly token: Effect.Effect<KeystoneToken, OrbError>
  readonly invalidate: Effect.Effect<void>
}

export const readCa = (credentials: OrbCredentials): Effect.Effect<Buffer | undefined, OrbError> =>
  Effect.try({
    try: () => (credentials.cacert === undefined ? undefined : readFileSync(credentials.cacert)),
    catch: cause => orbFailure(`Cannot read the cacert ${credentials.cacert}`, cause),
  })

export const makeKeystone = (credentials: OrbCredentials, ca: Buffer | undefined): Keystone => {
  let current: KeystoneToken | undefined
  const issue = httpJson(
    {
      method: 'POST',
      url: identityTokensUrl(credentials.auth_url),
      body: tokenRequestBody(credentials),
    },
    ca
  ).pipe(Effect.flatMap(reply => parseToken(reply, credentials.region_name)))
  return {
    authUrl: credentials.auth_url,
    token: Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const held = current
      if (
        held !== undefined &&
        (held.expiresAt === undefined || held.expiresAt - RENEW_MARGIN_MS > now)
      )
        return held
      const issued = yield* issue
      current = issued
      return issued
    }),
    invalidate: Effect.sync(() => {
      current = undefined
    }),
  }
}

export const openCloud = (
  credentials: OrbCredentials
): Effect.Effect<{ readonly keystone: Keystone; readonly orbit: Orbit }, OrbError> =>
  Effect.map(readCa(credentials), ca => {
    const keystone = makeKeystone(credentials, ca)
    return { keystone, orbit: makeOrbit(keystone, ca) }
  })

const OrbitErrorSchema = Schema.fromJsonString(
  Schema.Struct({ error: Schema.Struct({ message: Schema.String }) })
)
const OrbListSchema = Schema.fromJsonString(Schema.Struct({ orbs: Schema.Array(OrbViewSchema) }))
const decodeOrb = Schema.decodeEffect(Schema.fromJsonString(OrbViewSchema))

export interface OrbCreation {
  readonly size: OrbSize
  readonly publicKey: string
  readonly sshAllowedCidr: string
  readonly image: string
}

export interface Orbit {
  readonly url: Effect.Effect<string, OrbError>
  create(input: OrbCreation): Effect.Effect<OrbView, OrbError>
  get(id: string): Effect.Effect<OrbView, OrbError>
  remove(id: string): Effect.Effect<OrbView, OrbError>
  readonly list: Effect.Effect<readonly OrbView[], OrbError>
}

const orbitMessage = (reply: HttpReply): string =>
  Option.match(Schema.decodeOption(OrbitErrorSchema)(reply.body), {
    onNone: () => reply.body.trim() || 'no detail',
    onSome: ({ error }) => error.message,
  })

const decoded = (body: string) =>
  decodeOrb(body).pipe(
    Effect.mapError(cause => orbFailure(`Unexpected orbit response: ${cause.message}`, cause))
  )

export const makeOrbit = (keystone: Keystone, ca: Buffer | undefined): Orbit => {
  const call = Effect.fnUntraced(function* (
    method: HttpCall['method'],
    path: string,
    expected: number,
    body?: unknown
  ): Effect.fn.Return<string, OrbError> {
    for (let attempt = 1; ; attempt += 1) {
      const token = yield* keystone.token
      const reply = yield* httpJson(
        {
          method,
          url: `${token.orbitUrl}${path}`,
          headers: { 'X-Auth-Token': token.id },
          ...(body === undefined ? {} : { body }),
        },
        ca
      )
      if (reply.status === 401 && attempt === 1) {
        yield* keystone.invalidate
        continue
      }
      if (reply.status !== expected)
        return yield* orbFailure(
          `orbit answered ${method} ${path} with ${reply.status}: ${orbitMessage(reply)}`,
          undefined,
          reply.status
        )
      return reply.body
    }
  })
  return {
    url: Effect.map(keystone.token, token => token.orbitUrl),
    create: input =>
      call('POST', '/v1/orbs', 202, {
        size: input.size,
        public_key: input.publicKey,
        ssh_allowed_cidr: input.sshAllowedCidr,
        image: input.image,
      }).pipe(Effect.flatMap(decoded)),
    get: id => call('GET', `/v1/orbs/${encodeURIComponent(id)}`, 200).pipe(Effect.flatMap(decoded)),
    remove: id =>
      call('DELETE', `/v1/orbs/${encodeURIComponent(id)}`, 202).pipe(Effect.flatMap(decoded)),
    list: call('GET', '/v1/orbs', 200).pipe(
      Effect.flatMap(body =>
        Schema.decodeEffect(OrbListSchema)(body).pipe(
          Effect.mapError(cause => orbFailure(`Unexpected orbit response: ${cause.message}`, cause))
        )
      ),
      Effect.map(({ orbs }) => orbs)
    ),
  }
}
