import * as Schema from 'effect/Schema'

export const PiVersion = Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/)).pipe(
  Schema.brand('dev/PiVersion')
)
export type PiVersion = typeof PiVersion.Type
