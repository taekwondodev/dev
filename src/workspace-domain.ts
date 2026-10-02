import { isAbsolute } from 'node:path'
import { type Effect, Schema, type Stream } from 'effect'

export const WorkspaceId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/)
).pipe(Schema.brand('WorkspaceId'))
export type WorkspaceId = typeof WorkspaceId.Type

export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()('WorkspaceError', {
  outcome: Schema.Literals([
    'blocked',
    'review-required',
    'invalid',
    'unavailable',
    'ambiguous',
    'closed',
  ]),
  message: Schema.String,
}) {}

export const attachmentClosed = (): WorkspaceError =>
  new WorkspaceError({ outcome: 'closed', message: 'Workspace attachment is closed' })

export function fail(outcome: WorkspaceError['outcome'], message: string): never {
  throw new WorkspaceError({ outcome, message })
}
export function invalid(message: string): never {
  return fail('invalid', message)
}
export function unavailable(message: string): never {
  return fail('unavailable', message)
}
export function blocked(message: string): never {
  return fail('blocked', message)
}
export function requireReview(message: string): never {
  return fail('review-required', message)
}
export function ambiguous(message: string): never {
  return fail('ambiguous', message)
}

export const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const AbsolutePath = Schema.NonEmptyString.check(
  Schema.makeFilter(value =>
    isAbsolute(value) && !value.includes('\0') ? undefined : 'must be an absolute path'
  )
)

export const WorkspaceConversationSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  sessionFile: Schema.NonEmptyString,
  dataHome: Schema.NonEmptyString,
})
export type WorkspaceConversation = typeof WorkspaceConversationSchema.Type

export const CanonicalSessionFile = Schema.NonEmptyString.pipe(Schema.brand('CanonicalSessionFile'))
const BoundConversationSchema = Schema.Struct({
  ...WorkspaceConversationSchema.fields,
  sessionFile: CanonicalSessionFile,
})
export type BoundConversation = typeof BoundConversationSchema.Type

export const WorkspaceSelectionSchema = Schema.Struct({
  taskId: WorkspaceId,
  workspaceId: Schema.optional(WorkspaceId),
})
export type WorkspaceSelection = typeof WorkspaceSelectionSchema.Type

export const WorkspaceExecutionSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  taskKey: Schema.NonEmptyString,
  attemptId: Schema.NonEmptyString,
  generation: Schema.NonEmptyString,
  logs: Schema.optional(Schema.String),
})
export type WorkspaceExecution = typeof WorkspaceExecutionSchema.Type
export const sameExecution = Schema.toEquivalence(WorkspaceExecutionSchema)

export const WorkspaceProcessSchema = Schema.Struct({
  pid: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  parent: Schema.Int,
  group: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  birth: Schema.NonEmptyString,
})
export type WorkspaceProcess = typeof WorkspaceProcessSchema.Type

export const WorkspaceEffectSchema = Schema.Literals(['native-file-write', 'opaque'])
export type WorkspaceEffect = typeof WorkspaceEffectSchema.Type

export const WorkspaceAccessSchema = Schema.Literals(['read', 'write'])
export const WorkspaceOriginSchema = Schema.Literals(['pre-existing', 'managed'])
export type WorkspaceOrigin = typeof WorkspaceOriginSchema.Type

export const WorkspaceGrantSchema = Schema.Struct({
  namespaceId: WorkspaceId,
  repositoryId: WorkspaceId,
  workspaceId: WorkspaceId,
  useId: WorkspaceId,
  acquisitionId: Schema.optional(WorkspaceId),
  reservationId: Schema.optional(WorkspaceId),
  taskId: Schema.optional(WorkspaceId),
  revision: Revision,
  cwd: AbsolutePath,
  checkout: AbsolutePath,
  access: WorkspaceAccessSchema,
  origin: WorkspaceOriginSchema,

  path: Schema.optional(Schema.NonEmptyString),
})
export type WorkspaceGrant = typeof WorkspaceGrantSchema.Type
export const sameGrant = Schema.toEquivalence(WorkspaceGrantSchema)

export const WorkspaceBindingSchema = Schema.Struct({
  conversation: BoundConversationSchema,
  taskId: Schema.optional(WorkspaceId),
  workspaceId: WorkspaceId,
  cwd: AbsolutePath,
  revision: Revision,
})
export type WorkspaceBinding = typeof WorkspaceBindingSchema.Type
export const sameBinding = Schema.toEquivalence(WorkspaceBindingSchema)

export const WorkspaceHandoffSchema = Schema.Struct({
  operationId: WorkspaceId,
  from: WorkspaceBindingSchema,
  target: WorkspaceGrantSchema,
  reason: Schema.NonEmptyString,
})
export type WorkspaceHandoff = typeof WorkspaceHandoffSchema.Type

export const WorkspaceAuthorizationSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('ready'),
    grant: WorkspaceGrantSchema,
    warning: Schema.optional(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal('rebind'), handoff: WorkspaceHandoffSchema }),
])
export type WorkspaceAuthorization = typeof WorkspaceAuthorizationSchema.Type

export const WorkspaceOperationSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals(['read', 'write', 'delegated-write']),
    cwd: Schema.optional(AbsolutePath),
    execution: Schema.optional(WorkspaceExecutionSchema),
  }),
  Schema.Struct({
    kind: Schema.Literal('native-file-write'),
    within: WorkspaceGrantSchema,
    path: Schema.NonEmptyString,
    cwd: Schema.optional(AbsolutePath),
  }),
  Schema.Struct({
    kind: Schema.Literal('opaque'),
    within: WorkspaceGrantSchema,
    execution: WorkspaceExecutionSchema,
    cwd: Schema.optional(AbsolutePath),
  }),
  Schema.Struct({
    kind: Schema.Literal('leaf-read'),
    coordinator: WorkspaceGrantSchema,
    execution: WorkspaceExecutionSchema,
  }),
])
export type WorkspaceOperation = typeof WorkspaceOperationSchema.Type
export type ScopedOperation = Extract<WorkspaceOperation, { readonly within: WorkspaceGrant }>

export const WorkspaceExecutionFactSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('launch-intent'), execution: WorkspaceExecutionSchema }),
  Schema.Struct({ kind: Schema.Literal('spawned'), process: WorkspaceProcessSchema }),
  Schema.Struct({ kind: Schema.Literal('started') }),
  Schema.Struct({
    kind: Schema.Literal('observed'),
    processes: Schema.Array(WorkspaceProcessSchema),
  }),
  Schema.Struct({ kind: Schema.Literal('quiescent'), reason: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal('launch-failed'), reason: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal('unknown'), reason: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal('operation-started') }),
  Schema.Struct({ kind: Schema.Literal('operation-completed') }),
])
export type WorkspaceExecutionFact = typeof WorkspaceExecutionFactSchema.Type

export const WorkspaceExecutionReportSchema = Schema.Struct({
  warning: Schema.optional(Schema.String),
})
export type WorkspaceExecutionReport = typeof WorkspaceExecutionReportSchema.Type

export const WorkspaceViewSchema = Schema.Struct({
  repositoryId: WorkspaceId,
  taskId: Schema.optional(WorkspaceId),
  workspaceId: WorkspaceId,
  path: Schema.NonEmptyString,
  origin: WorkspaceOriginSchema,
  reservationId: Schema.optional(WorkspaceId),
  outcome: Schema.Literals([
    'active',
    'preserved-for-resume',
    'blocked',
    'review-required',
    'released',
    'removed',
    'already-absent',
  ]),
  reason: Schema.NonEmptyString,
  nextAction: Schema.NonEmptyString,
  uses: Schema.Array(
    Schema.Struct({
      id: WorkspaceId,
      access: WorkspaceAccessSchema,
      stage: Schema.NonEmptyString,
      effect: Schema.optional(WorkspaceEffectSchema),
      path: Schema.optional(Schema.NonEmptyString),
      reason: Schema.optional(Schema.String),
      execution: Schema.optional(WorkspaceExecutionSchema),
      logsAvailable: Schema.optional(Schema.Boolean),
    })
  ),
  pending: Schema.Array(
    Schema.Struct({ id: WorkspaceId, kind: Schema.NonEmptyString, stage: Schema.NonEmptyString })
  ),
})
export type WorkspaceView = typeof WorkspaceViewSchema.Type

const FullRef = Schema.NonEmptyString.check(
  Schema.makeFilter(value =>
    value.startsWith('refs/') && !value.includes('..') && !/\s/.test(value)
      ? undefined
      : 'must be a full Git ref such as refs/heads/main'
  )
)
export const GitHubRepositorySchema = Schema.NonEmptyString.check(
  Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
)

export const RemoteName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
)
export const CommitSha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/))
export const TaskTargetSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('local'), ref: FullRef }),
  Schema.Struct({ kind: Schema.Literal('remote'), remote: RemoteName, ref: FullRef }),
  Schema.Struct({
    kind: Schema.Literal('github'),
    repository: GitHubRepositorySchema,
    ref: FullRef,

    sourceRepository: Schema.optional(GitHubRepositorySchema),
    pullRequest: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  }),
])
export type TaskTarget = typeof TaskTargetSchema.Type

export const Sha256Hex = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const RelativeFilePath = Schema.NonEmptyString.check(
  Schema.makeFilter(value =>
    !isAbsolute(value) &&
    !value.includes('\0') &&
    !value.split('/').some(part => part === '' || part === '.' || part === '..')
      ? undefined
      : 'must be a normalized relative path inside the workspace'
  )
)

export const PublicationDestinationSchema = Schema.Struct({
  repository: GitHubRepositorySchema,
  number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  commentId: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  readBack: Schema.Literals(['text-in-body', 'attachment-sha256']),
  url: Schema.NonEmptyString,
})
export const PublicationReferenceSchema = Schema.Struct({
  id: WorkspaceId,
  taskId: WorkspaceId,
  workspaceId: Schema.optional(WorkspaceId),

  commit: Schema.optional(CommitSha),
  relativePath: RelativeFilePath,
  byteLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  sha256: Sha256Hex,
  destination: PublicationDestinationSchema,
  verifiedAt: Schema.Finite,
})
export type PublicationReference = typeof PublicationReferenceSchema.Type

export const EvidenceVerdictSchema = Schema.Literals(['valid', 'invalid', 'unknown'])
export type EvidenceVerdict = typeof EvidenceVerdictSchema.Type

export const AllocationReasonSchema = Schema.Literals(['delegated-writer', 'checkout-contention'])
export type AllocationReason = typeof AllocationReasonSchema.Type

export const SweepMomentSchema = Schema.Literals(['quit', 'allocation'])
export type SweepMoment = typeof SweepMomentSchema.Type

export const WorkspaceRoleSchema = Schema.Literals(['pre-existing', 'branch', 'child', 'detached'])
export type WorkspaceRole = typeof WorkspaceRoleSchema.Type

export const FinishedRuleSchema = Schema.Literals([
  'clean-checkout',
  'no-residue',
  'branch-merged',
  'branch-in-target',
  'child-delivered',
])
export type FinishedRule = typeof FinishedRuleSchema.Type

export const RetainedReasonSchema = Schema.Literals([
  'identity-unverifiable',
  'transition-unresolved',
  'release-review',
  'excluded',
  'use-unknown',
  'use-abandoned',
  'use-live',
  'directory-missing',
  'residue-unreadable',
  'checkout-modified',
  'skipped',
  'no-commits',
  'integration-unknown',
  'not-integrated',
])
export type RetainedReason = typeof RetainedReasonSchema.Type

export const CompletionVerdictSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('finished'),
    role: WorkspaceRoleSchema,
    rule: FinishedRuleSchema,
    reason: Schema.NonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal('retained'),
    role: WorkspaceRoleSchema,
    retained: RetainedReasonSchema,
    reason: Schema.NonEmptyString,
  }),
])
export type CompletionVerdict = typeof CompletionVerdictSchema.Type

export const TargetSourceSchema = Schema.Literals([
  'override',
  'origin-github',
  'origin-remote',
  'none',
  'not-needed',
  'not-assessed',
])
export const TargetViewSchema = Schema.Struct({
  source: TargetSourceSchema,
  description: Schema.NonEmptyString,
})
export type TargetView = typeof TargetViewSchema.Type

export const ReleaseDeciderSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('user') }),
  Schema.Struct({
    kind: Schema.Literal('completion'),
    policyVersion: Schema.Int,
    moment: SweepMomentSchema,
  }),
])
export type ReleaseDecider = typeof ReleaseDeciderSchema.Type

export const ReleaseSubjectSchema = Schema.Struct({
  repositoryId: WorkspaceId,
  workspaceId: WorkspaceId,
  reservationId: WorkspaceId,
  reservationRevision: Revision,
  acquisitionId: Schema.optional(WorkspaceId),
  workspaceRevision: Revision,
  origin: WorkspaceOriginSchema,
  path: Schema.NonEmptyString,
  effect: Schema.Literals(['release-reservation', 'remove-worktree', 'none']),

  head: Schema.optional(CommitSha),
  stateDigest: Sha256Hex,
  policyVersion: Schema.Int,
})
export type ReleaseSubject = typeof ReleaseSubjectSchema.Type
export const RELEASE_SUBJECT_FIELDS = Object.keys(
  ReleaseSubjectSchema.fields
) as readonly (keyof ReleaseSubject)[]

export const WorkspaceAssessmentSchema = Schema.Struct({
  repositoryId: WorkspaceId,
  taskId: WorkspaceId,
  workspaceId: WorkspaceId,
  reservationId: WorkspaceId,
  path: Schema.NonEmptyString,
  origin: WorkspaceOriginSchema,
  outcome: Schema.Literals([
    'active',
    'preserved-for-resume',
    'blocked',
    'review-required',
    'releasable',
    'removable',
  ]),
  reasons: Schema.Array(Schema.NonEmptyString),
  nextActions: Schema.Array(Schema.NonEmptyString),
  evidence: Schema.optional(
    Schema.Struct({ verdict: EvidenceVerdictSchema, reasons: Schema.Array(Schema.String) })
  ),
  inventory: Schema.optional(
    Schema.Struct({
      trackedChanges: Schema.Int,
      files: Schema.Int,
      published: Schema.Int,
      disposable: Schema.Int,
      blocking: Schema.Int,
    })
  ),
  residual: Schema.Array(Schema.String),
  target: TargetViewSchema,
  completion: CompletionVerdictSchema,
  subject: ReleaseSubjectSchema,
})
export type WorkspaceAssessment = typeof WorkspaceAssessmentSchema.Type

export const WorkspaceReleaseResultSchema = Schema.Struct({
  repositoryId: WorkspaceId,
  workspaceId: WorkspaceId,
  path: Schema.NonEmptyString,
  origin: WorkspaceOriginSchema,
  outcome: Schema.Literals([
    'released',
    'removed',
    'already-absent',
    'blocked',
    'review-required',
    'partial',
  ]),
  reason: Schema.NonEmptyString,
  nextAction: Schema.NonEmptyString,
  effects: Schema.Array(Schema.String),
  retained: Schema.Array(Schema.String),
  operationId: Schema.optional(WorkspaceId),
})
export type WorkspaceReleaseResult = typeof WorkspaceReleaseResultSchema.Type

export const ReleaseRequestSchema = Schema.Struct({
  taskId: WorkspaceId,
  commandId: WorkspaceId,
  decided: Schema.Array(ReleaseSubjectSchema),
  decider: ReleaseDeciderSchema,
  workspaceId: WorkspaceId,
  occupiedPaths: Schema.Array(AbsolutePath),
})
export type ReleaseRequest = typeof ReleaseRequestSchema.Type

export const SweepOutcomeSchema = Schema.Literals([
  'removed',
  'released',
  'already-absent',
  'retained',
  'review-required',
  'partial',
  'skipped',
])
export type SweepOutcome = typeof SweepOutcomeSchema.Type
export const SweepRowSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('workspace'),
    taskId: WorkspaceId,
    workspaceId: WorkspaceId,
    path: Schema.NonEmptyString,
    origin: WorkspaceOriginSchema,
    verdict: CompletionVerdictSchema,
    outcome: SweepOutcomeSchema,
    reason: Schema.NonEmptyString,
    operationId: Schema.optional(WorkspaceId),
  }),
  Schema.Struct({
    kind: Schema.Literal('task-failure'),
    taskId: WorkspaceId,
    reason: Schema.NonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal('task-deferred'),
    taskId: WorkspaceId,
    reason: Schema.NonEmptyString,
  }),
  Schema.Struct({ kind: Schema.Literal('sweep-failure'), reason: Schema.NonEmptyString }),
])
export type SweepRow = typeof SweepRowSchema.Type
export const SweepReceiptSchema = Schema.Struct({
  commandId: WorkspaceId,
  moment: SweepMomentSchema,
  rows: Schema.Array(SweepRowSchema),
})
export type SweepReceipt = typeof SweepReceiptSchema.Type

export const WORKER_REQUEST_TIMEOUT_MS = 60_000

export const SweepRequestSchema = Schema.Struct({
  anchorWorkspaceId: WorkspaceId,
  occupiedPaths: Schema.Array(AbsolutePath),
})
export type SweepRequest = typeof SweepRequestSchema.Type

export type HostReplace = (
  target: WorkspaceGrant
) => Effect.Effect<'confirmed' | 'cancelled', unknown>

export interface WorkspaceAttachment {
  readonly binding: WorkspaceBinding
  authorize(operation: WorkspaceOperation): Effect.Effect<WorkspaceAuthorization, WorkspaceError>
  select(selection: WorkspaceSelection): Effect.Effect<WorkspaceHandoff, WorkspaceError>
  reportExecution(
    grant: WorkspaceGrant,
    fact: WorkspaceExecutionFact
  ): Effect.Effect<WorkspaceExecutionReport, WorkspaceError>

  handoff(transition: WorkspaceHandoff, replace: HostReplace): Effect.Effect<void, WorkspaceError>
  readonly sweeps: Stream.Stream<SweepReceipt>
  readonly close: Effect.Effect<void, WorkspaceError>
}

export interface WorkspaceLifecycle {
  attach(input: {
    readonly conversation: WorkspaceConversation
    readonly cwd: string
    readonly selection?: WorkspaceSelection
  }): Effect.Effect<WorkspaceAttachment, WorkspaceError>

  inspect(input: {
    readonly cwd?: string
    readonly taskId?: WorkspaceId
  }): Effect.Effect<readonly WorkspaceView[], WorkspaceError>

  validate(grant: WorkspaceGrant): Effect.Effect<void, WorkspaceError>

  check(input: {
    readonly taskId: WorkspaceId
    readonly ownConversation?: WorkspaceConversation
  }): Effect.Effect<readonly WorkspaceAssessment[], WorkspaceError>
  release(input: ReleaseRequest): Effect.Effect<WorkspaceReleaseResult, WorkspaceError>
  sweep(input: SweepRequest): Effect.Effect<SweepReceipt, WorkspaceError>
  recordTarget(input: {
    readonly taskId: WorkspaceId
    readonly target: TaskTarget
  }): Effect.Effect<void, WorkspaceError>
  recordPublication(input: {
    readonly reference: PublicationReference
  }): Effect.Effect<void, WorkspaceError>
}
