import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Duration, Effect, Schema } from 'effect'
import { native } from '../../src/native.ts'
import { serveBrowserOwner } from '../../src/web-browser-owner.ts'
import { WebNetworkError, type AddressResolver } from '../../src/web-network.ts'
import { FIXTURE_VARIABLE } from './chrome-fixture.ts'

const FixtureSchema = Schema.Struct({
  sourceUserData: Schema.optional(Schema.String),
  chromeExecutables: Schema.optional(Schema.Array(Schema.String)),
  chromeArguments: Schema.optional(Schema.Array(Schema.String)),
  browserIdleMs: Schema.optional(Schema.Finite),
  firstClientGraceMs: Schema.optional(Schema.Finite),
  installationPath: Schema.String,
  namespacePath: Schema.String,
  allowSuffix: Schema.String,
  blockedHosts: Schema.Array(Schema.String),
  slowHosts: Schema.Record(Schema.String, Schema.Finite),
  hang: Schema.optional(Schema.Boolean),
  pidDirectory: Schema.optional(Schema.String),
  processObservationBlock: Schema.optional(Schema.String),
})

const decodeFixture = Schema.decodeUnknownSync(Schema.fromJsonString(FixtureSchema))

const raw = process.env[FIXTURE_VARIABLE]
if (raw === undefined) throw new Error(`${FIXTURE_VARIABLE} is required by the fixture owner entry`)
const fixture = decodeFixture(raw)
if (fixture.pidDirectory !== undefined)
  writeFileSync(join(fixture.pidDirectory, String(process.pid)), '')
const observationBlock = fixture.processObservationBlock
if (observationBlock !== undefined) {
  const addon = native()
  const read = addon.processTable
  Object.defineProperty(addon, 'processTable', {
    value: () => {
      if (existsSync(observationBlock)) throw new Error('fixture process observation failure')
      return read()
    },
  })
}

const refused = (host: string) =>
  Effect.fail(
    new WebNetworkError({
      reason: 'destination',
      message: `${host} refused by the fixture resolver`,
    })
  )

const resolveAddress: AddressResolver = host => {
  if (fixture.blockedHosts.includes(host)) return refused(host)
  const slow = fixture.slowHosts[host]
  if (slow !== undefined)
    return Effect.succeed('127.0.0.1').pipe(Effect.delay(Duration.millis(slow)))
  return host.endsWith(fixture.allowSuffix) ? Effect.succeed('127.0.0.1') : refused(host)
}

if (fixture.hang === true) setInterval(() => undefined, 1000)
else
  serveBrowserOwner({
    profile: dataHome => ({
      dataHome,
      ...(fixture.sourceUserData === undefined ? {} : { sourceUserData: fixture.sourceUserData }),
      ...(fixture.chromeExecutables === undefined
        ? {}
        : { chromeExecutables: [...fixture.chromeExecutables] }),
    }),
    resolveAddress,
    ...(fixture.chromeArguments === undefined
      ? {}
      : { chromeArguments: [...fixture.chromeArguments] }),
    ...(fixture.browserIdleMs === undefined
      ? {}
      : { browserIdle: Duration.millis(fixture.browserIdleMs) }),
    ...(fixture.firstClientGraceMs === undefined
      ? {}
      : { firstClientGrace: Duration.millis(fixture.firstClientGraceMs) }),
    coordination: {
      installationPath: fixture.installationPath,
      namespacePath: fixture.namespacePath,
    },
  })
