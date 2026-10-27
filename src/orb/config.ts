import { Effect, FileSystem, Schema } from 'effect'
import { fileURLToPath } from 'node:url'
import { errorText } from '../error-text.ts'
import { OrbConfigSchema, orbFailure, type OrbConfig, type OrbError } from './domain.ts'

const CONFIG_PATH = fileURLToPath(new URL('../../config/orb.json', import.meta.url))
const DEFAULT_SIZE = { vcpus: 2, memory_mb: 2048, disk_gb: 10 }
const DEFAULT_IMAGE = 'ubuntu-24.04-arm64-dev'

const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(OrbConfigSchema))

export const readOrbConfig = (
  path: string = CONFIG_PATH
): Effect.Effect<OrbConfig, OrbError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const contents = yield* fs.readFileString(path)
    const config = yield* decodeConfig(contents, { onExcessProperty: 'error' })
    return {
      path,
      size: config.size ?? DEFAULT_SIZE,
      image: config.image ?? DEFAULT_IMAGE,
      sshAllowedCidr: config.ssh_allowed_cidr,
    }
  }).pipe(
    Effect.mapError(cause =>
      orbFailure(`Cannot read the orb configuration at ${path}: ${errorText(cause)}`, cause)
    )
  )
