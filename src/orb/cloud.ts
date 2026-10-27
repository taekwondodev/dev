import { readFileSync } from 'node:fs'
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Clock, DateTime, Effect, Option, Schema } from 'effect'
import { errorText } from '../error-text.ts'
import { OrbViewSchema, orbFailure, type OrbError, type OrbSize, type OrbView } from './domain.ts'

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

const OpenrcSchema = Schema.Struct({
  OS_AUTH_URL: Schema.NonEmptyString,
  OS_USERNAME: Schema.NonEmptyString,
  OS_PASSWORD: Schema.NonEmptyString,
  OS_PROJECT_NAME: Schema.NonEmptyString,
  OS_USER_DOMAIN_ID: Schema.optional(Schema.NonEmptyString),
  OS_PROJECT_DOMAIN_ID: Schema.optional(Schema.NonEmptyString),
  OS_REGION_NAME: Schema.optional(Schema.NonEmptyString),
  OS_CACERT: Schema.optional(Schema.NonEmptyString),
})
export type Openrc = typeof OpenrcSchema.Type

const REQUIRED_OPENRC = ['OS_AUTH_URL', 'OS_USERNAME', 'OS_PASSWORD', 'OS_PROJECT_NAME'] as const

export const readOpenrc = (env: NodeJS.ProcessEnv): Effect.Effect<Openrc, OrbError> => {
  const missing = REQUIRED_OPENRC.filter(name => !env[name])
  if (missing.length > 0)
    return Effect.fail(
      orbFailure(
        `dev --orb needs the OpenStack credentials that openrc exports; missing: ${missing.join(', ')}. Source openrc for the project, then launch again.`
      )
    )
  const present = Object.fromEntries(
    Object.entries(env).filter(([name, value]) => name.startsWith('OS_') && value !== '')
  )
  return Schema.decodeUnknownEffect(OpenrcSchema)(present).pipe(
    Effect.mapError(cause => orbFailure(`Invalid OpenStack credentials: ${cause.message}`, cause))
  )
}

export const identityTokensUrl = (authUrl: string): string => {
  const root = authUrl.replace(/\/+$/, '')
  return `${root.endsWith('/v3') ? root : `${root}/v3`}/auth/tokens`
}

export const tokenRequestBody = (openrc: Openrc) => ({
  auth: {
    identity: {
      methods: ['password'],
      password: {
        user: {
          name: openrc.OS_USERNAME,
          domain: { id: openrc.OS_USER_DOMAIN_ID ?? 'default' },
          password: openrc.OS_PASSWORD,
        },
      },
    },
    scope: {
      project: {
        name: openrc.OS_PROJECT_NAME,
        domain: { id: openrc.OS_PROJECT_DOMAIN_ID ?? 'default' },
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

export const readCa = (openrc: Openrc): Effect.Effect<Buffer | undefined, OrbError> =>
  Effect.try({
    try: () => (openrc.OS_CACERT === undefined ? undefined : readFileSync(openrc.OS_CACERT)),
    catch: cause => orbFailure(`Cannot read OS_CACERT ${openrc.OS_CACERT}`, cause),
  })

export const makeKeystone = (openrc: Openrc, ca: Buffer | undefined): Keystone => {
  let current: KeystoneToken | undefined
  const issue = httpJson(
    { method: 'POST', url: identityTokensUrl(openrc.OS_AUTH_URL), body: tokenRequestBody(openrc) },
    ca
  ).pipe(Effect.flatMap(reply => parseToken(reply, openrc.OS_REGION_NAME)))
  return {
    authUrl: openrc.OS_AUTH_URL,
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
