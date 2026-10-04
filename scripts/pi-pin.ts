import { fileURLToPath } from 'node:url'
import { Effect, FileSystem, Schema } from 'effect'
import { errorText } from '../src/error-text.ts'

export class PiPinError extends Schema.TaggedError<PiPinError>()('PiPinError', {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export const PiVersion = Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/)).pipe(
  Schema.brand('dev/PiVersion')
)
export type PiVersion = typeof PiVersion.Type

const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url))

const PackageManifest = Schema.fromJsonString(
  Schema.Struct({ config: Schema.Struct({ pi: PiVersion }) })
)

export const readPiPin = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const manifest = yield* Schema.decodeEffect(PackageManifest)(
    yield* fs.readFileString(manifestPath)
  )
  return manifest.config.pi
}).pipe(
  Effect.mapError(
    cause =>
      new PiPinError({
        message: `Cannot read the Pi pin at config.pi in package.json: ${errorText(cause)}`,
        cause,
      })
  )
)
