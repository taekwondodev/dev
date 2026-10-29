import { Schema } from 'effect'

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

export const OrbRecordSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  phase: OrbPhaseSchema,
  orbId: Schema.optional(Schema.NonEmptyString),
  keystone: Schema.Struct({
    authUrl: Schema.NonEmptyString,
    projectId: Schema.NonEmptyString,
    projectName: Schema.NonEmptyString,
  }),
  checkout: Schema.NonEmptyString,
  branch: Schema.optional(Schema.NonEmptyString),
  orbPath: Schema.NonEmptyString,
  baseRef: Schema.NonEmptyString,
  uploadedHead: Schema.optional(Schema.NonEmptyString),
  presenceUseId: Schema.optional(Schema.NonEmptyString),
  conversation: Schema.NonEmptyString,
  createdAt: Schema.NonEmptyString,
  updatedAt: Schema.NonEmptyString,
})
export type OrbRecord = typeof OrbRecordSchema.Type

export const shortId = (id: string): string => id.slice(0, 8)

export const deleteCommand = (orbitUrl: string, orbId: string): string =>
  `curl -X DELETE -H "X-Auth-Token: $(openstack token issue -f value -c id)" ${orbitUrl}/v1/orbs/${orbId}`
