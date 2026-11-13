import * as Schema from 'effect/Schema'

export class OrbError extends Schema.TaggedError<OrbError, { readonly brand: unique symbol }>()(
  'OrbError',
  {
    message: Schema.String,
    status: Schema.optional(Schema.Int),
    cause: Schema.optional(Schema.Defect()),
  }
) {}

export const orbFailure = (message: string, cause?: unknown, status?: number): OrbError =>
  new OrbError({
    message,
    ...(cause === undefined ? {} : { cause }),
    ...(status === undefined ? {} : { status }),
  })

export const OrbStatusSchema = Schema.Literals([
  'RESERVING',
  'BUILDING',
  'ACTIVE',
  'ERROR',
  'DELETING',
  'DELETED',
])
export type OrbStatus = typeof OrbStatusSchema.Type

export const OrbSizeSchema = Schema.Struct({
  vcpus: Schema.Int,
  memory_mb: Schema.Int,
  disk_gb: Schema.Int,
})
export type OrbSize = typeof OrbSizeSchema.Type

export const OrbViewSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  status: OrbStatusSchema,
  image: Schema.String,
  ssh_host: Schema.NullOr(Schema.String),
  ssh_user: Schema.NullOr(Schema.String),
  ssh_host_keys: Schema.NullOr(Schema.Array(Schema.String)),
  fault: Schema.NullOr(Schema.String),
  created_at: Schema.String,
})
export type OrbView = typeof OrbViewSchema.Type

export const OrbCredentialsSchema = Schema.Struct({
  auth_url: Schema.NonEmptyString,
  username: Schema.NonEmptyString,
  password: Schema.NonEmptyString,
  project_name: Schema.NonEmptyString,
  user_domain_id: Schema.optional(Schema.NonEmptyString),
  project_domain_id: Schema.optional(Schema.NonEmptyString),
  region_name: Schema.optional(Schema.NonEmptyString),
  cacert: Schema.optional(Schema.NonEmptyString),
})
export type OrbCredentials = typeof OrbCredentialsSchema.Type

export const OrbConfigSchema = Schema.Struct({
  size: Schema.optional(OrbSizeSchema),
  image: Schema.optional(Schema.NonEmptyString),
  ssh_allowed_cidr: Schema.NonEmptyString,
})

export interface OrbConfig {
  readonly path: string
  readonly size: OrbSize
  readonly image: string
  readonly sshAllowedCidr: string
}

export const OrbPhaseSchema = Schema.Literals([
  'requested',
  'created',
  'active',
  'returning',
  'deleting',
])
export type OrbPhase = typeof OrbPhaseSchema.Type

const recordIdentity = {
  id: Schema.NonEmptyString,
  phase: OrbPhaseSchema,
  orbId: Schema.optional(Schema.NonEmptyString),
  keystone: Schema.Struct({
    authUrl: Schema.NonEmptyString,
    projectId: Schema.NonEmptyString,
    projectName: Schema.NonEmptyString,
  }),
  baseRef: Schema.NonEmptyString,
  createdAt: Schema.NonEmptyString,
  updatedAt: Schema.NonEmptyString,
}

export const AssignedRecordSchema = Schema.Struct({
  ...recordIdentity,
  checkout: Schema.NonEmptyString,
  branch: Schema.optional(Schema.NonEmptyString),
  orbPath: Schema.NonEmptyString,
  uploadedHead: Schema.optional(Schema.NonEmptyString),
  presenceUseId: Schema.optional(Schema.NonEmptyString),
  conversation: Schema.NonEmptyString,
})
export type AssignedRecord = typeof AssignedRecordSchema.Type

export const SpareShapeSchema = Schema.Struct({
  size: OrbSizeSchema,
  image: Schema.NonEmptyString,
  sshAllowedCidr: Schema.NonEmptyString,
})
export type SpareShape = typeof SpareShapeSchema.Type

export const SpareRecordSchema = Schema.Struct({ ...recordIdentity, spare: SpareShapeSchema })
export type SpareRecord = typeof SpareRecordSchema.Type

export const OrbRecordSchema = Schema.Union([AssignedRecordSchema, SpareRecordSchema])
export type OrbRecord = typeof OrbRecordSchema.Type

export type Assignment = Pick<AssignedRecord, 'checkout' | 'orbPath' | 'conversation'> &
  Partial<Pick<AssignedRecord, 'branch' | 'presenceUseId'>>

export const isSpare = (record: OrbRecord): record is SpareRecord => 'spare' in record

export const holdsWork = (
  record: OrbRecord
): record is AssignedRecord & { readonly phase: 'active' | 'returning' } =>
  !isSpare(record) && (record.phase === 'active' || record.phase === 'returning')

export const shortId = (id: string): string => id.slice(0, 8)

export const shq = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

export const setupCommand = (dataHome: string): string =>
  `dev --data-home ${shq(dataHome)} orb setup`

export const deleteCommand = (dataHome: string, orbId: string): string =>
  `dev --data-home ${shq(dataHome)} orb delete ${orbId}`
