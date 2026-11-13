import { randomUUID } from 'node:crypto'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { join } from 'node:path'
import { errorText } from '../error-text.ts'
import {
  OrbConfigSchema,
  OrbCredentialsSchema,
  orbFailure,
  setupCommand,
  type OrbConfig,
  type OrbCredentials,
  type OrbError,
} from './domain.ts'

export const DEFAULT_SIZE = { vcpus: 2, memory_mb: 2048, disk_gb: 10 }
export const DEFAULT_IMAGE = 'ubuntu-24.04-arm64-dev'

const PRIVATE_MODE = 0o600

const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(OrbConfigSchema))
const decodeCredentials = Schema.decodeUnknownEffect(Schema.fromJsonString(OrbCredentialsSchema))

const orbConfigPath = (dataHome: string): string => join(dataHome, 'orb.json')
const credentialsPath = (dataHome: string): string => join(dataHome, 'openstack.json')

const unreadable = (what: string, path: string) => (cause: unknown) =>
  orbFailure(`Cannot read the ${what} at ${path}: ${errorText(cause)}`, cause)

const readExisting = Effect.fnUntraced(function* (
  what: string,
  path: string,
  dataHome: string
): Effect.fn.Return<string, OrbError, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem
  if (!(yield* fs.exists(path).pipe(Effect.mapError(unreadable(what, path)))))
    return yield* orbFailure(`No ${what} at ${path}. Create it with: ${setupCommand(dataHome)}`)
  return yield* fs.readFileString(path).pipe(Effect.mapError(unreadable(what, path)))
})

export const readOrbConfig = (
  dataHome: string
): Effect.Effect<OrbConfig, OrbError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const path = orbConfigPath(dataHome)
    const config = yield* readExisting('orb configuration', path, dataHome).pipe(
      Effect.flatMap(contents =>
        decodeConfig(contents, { onExcessProperty: 'error' }).pipe(
          Effect.mapError(unreadable('orb configuration', path))
        )
      )
    )
    return {
      path,
      size: config.size ?? DEFAULT_SIZE,
      image: config.image ?? DEFAULT_IMAGE,
      sshAllowedCidr: config.ssh_allowed_cidr,
    }
  })

const decodeCredentialsAt = (path: string, contents: string, dataHome: string) =>
  decodeCredentials(contents, { onExcessProperty: 'error' }).pipe(
    Effect.mapError(cause =>
      orbFailure(
        `Cannot read the OpenStack credentials at ${path}: ${errorText(cause)}\nRewrite them with: ${setupCommand(dataHome)}`
      )
    )
  )

export const readOrbCredentials = (
  dataHome: string
): Effect.Effect<OrbCredentials, OrbError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const path = credentialsPath(dataHome)
    const contents = yield* readExisting('OpenStack credentials', path, dataHome)
    const fs = yield* FileSystem.FileSystem
    const { mode } = yield* fs
      .stat(path)
      .pipe(Effect.mapError(unreadable('OpenStack credentials', path)))
    if ((mode & 0o777) !== PRIVATE_MODE)
      return yield* orbFailure(
        `The OpenStack credentials at ${path} have mode ${(mode & 0o777).toString(8)}, so other accounts may read the password; dev reads them only with mode 600. Fix it with: chmod 600 ${path}\nor rewrite them with: ${setupCommand(dataHome)}`
      )
    return yield* decodeCredentialsAt(path, contents, dataHome)
  })

export const readStoredOrbFiles = (
  dataHome: string
): Effect.Effect<
  { readonly credentials?: OrbCredentials; readonly config?: OrbConfig },
  never,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = credentialsPath(dataHome)
    const credentials = yield* fs.readFileString(path).pipe(
      Effect.flatMap(contents => decodeCredentialsAt(path, contents, dataHome)),
      Effect.option
    )
    const config = yield* Effect.option(readOrbConfig(dataHome))
    return {
      ...(Option.isSome(credentials) ? { credentials: credentials.value } : {}),
      ...(Option.isSome(config) ? { config: config.value } : {}),
    }
  })

export type OrbConfigFile = typeof OrbConfigSchema.Type

export const writeOrbFiles = (
  dataHome: string,
  files: { readonly credentials: OrbCredentials; readonly config: OrbConfigFile }
): Effect.Effect<readonly string[], OrbError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const writeAtomically = (path: string, value: unknown) => {
      const temporary = `${path}.${randomUUID()}.tmp`
      return fs
        .writeFileString(temporary, `${JSON.stringify(value, null, 2)}\n`, {
          flag: 'wx',
          mode: PRIVATE_MODE,
        })
        .pipe(
          Effect.andThen(fs.chmod(temporary, PRIVATE_MODE)),
          Effect.andThen(fs.rename(temporary, path)),
          Effect.tapError(() => Effect.ignore(fs.remove(temporary))),
          Effect.mapError(cause => orbFailure(`Cannot write ${path}: ${errorText(cause)}`, cause)),
          Effect.as(path)
        )
    }
    yield* fs
      .makeDirectory(dataHome, { recursive: true, mode: 0o700 })
      .pipe(
        Effect.mapError(cause =>
          orbFailure(`Cannot create the data home ${dataHome}: ${errorText(cause)}`, cause)
        )
      )
    const config = yield* writeAtomically(orbConfigPath(dataHome), files.config)
    const credentials = yield* writeAtomically(credentialsPath(dataHome), files.credentials)
    return [config, credentials]
  })
