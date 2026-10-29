import { Effect, FileSystem, Schema } from 'effect'
import { join } from 'node:path'
import { errorText } from '../error-text.ts'
import { OrbConfigSchema, orbFailure, type OrbConfig, type OrbError } from './domain.ts'

const DEFAULT_SIZE = { vcpus: 2, memory_mb: 2048, disk_gb: 10 }
const DEFAULT_IMAGE = 'ubuntu-24.04-arm64-dev'

const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(OrbConfigSchema))

const orbConfigPath = (dataHome: string): string => join(dataHome, 'orb.json')

export const readOrbConfig = (
  dataHome: string
): Effect.Effect<OrbConfig, OrbError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const path = orbConfigPath(dataHome)
    const fs = yield* FileSystem.FileSystem
    const unreadable = (cause: unknown) =>
      orbFailure(`Cannot read the orb configuration at ${path}: ${errorText(cause)}`, cause)
    if (!(yield* fs.exists(path).pipe(Effect.mapError(unreadable))))
      return yield* orbFailure(
        `No orb configuration at ${path}. Create it with at least {"ssh_allowed_cidr": "<network the Mac reaches orbs from>"}; see docs/orb.md.`
      )
    const config = yield* fs.readFileString(path).pipe(
      Effect.flatMap(contents => decodeConfig(contents, { onExcessProperty: 'error' })),
      Effect.mapError(unreadable)
    )
    return {
      path,
      size: config.size ?? DEFAULT_SIZE,
      image: config.image ?? DEFAULT_IMAGE,
      sshAllowedCidr: config.ssh_allowed_cidr,
    }
  })
