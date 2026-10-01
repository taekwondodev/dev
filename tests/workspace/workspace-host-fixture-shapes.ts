import assert from 'node:assert/strict'
import { Schema } from 'effect'
import {
  CanonicalSessionFile,
  SweepReceiptSchema,
  WorkspaceAssessmentSchema,
  WorkspaceBindingSchema,
  WorkspaceGrantSchema,
  WorkspaceHandoffSchema,
  WorkspaceId,
  WorkspaceViewSchema,
  type CompletionVerdict,
  type SweepReceipt,
  type SweepRow,
  type WorkspaceAssessment,
  type WorkspaceBinding,
  type WorkspaceConversation,
  type WorkspaceGrant,
  type WorkspaceHandoff,
  type WorkspaceView,
} from '../../src/workspace-domain.ts'
import { canonicalConversationFile } from '../../src/workspace-paths.ts'

export interface FixtureDescriptor {
  readonly repoId: WorkspaceId
  readonly taskId: WorkspaceId
  readonly workspaceId: WorkspaceId
  readonly path: string
  readonly origin: 'pre-existing' | 'managed'
  readonly label: string
}

export const fixtureId = (n: number): WorkspaceId =>
  WorkspaceId.make(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`)

const conforming =
  <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  <A extends S['Type']>(value: A): A => {
    assert.deepEqual(Schema.decodeUnknownSync(schema)(value), value)
    return value
  }
const conformingGrant = conforming(WorkspaceGrantSchema)

export const makeFixtureGrant = (input: {
  readonly namespaceId: WorkspaceId
  readonly descriptor: FixtureDescriptor
  readonly access: 'read' | 'write'
  readonly cwd: string
  readonly sequence: number
  readonly path?: string
}) =>
  conformingGrant({
    namespaceId: input.namespaceId,
    repositoryId: input.descriptor.repoId,
    workspaceId: input.descriptor.workspaceId,
    useId: fixtureId(input.sequence),
    acquisitionId: fixtureId(input.sequence + 1),
    reservationId: fixtureId(input.sequence + 2),
    taskId: input.descriptor.taskId,
    revision: input.sequence - 1000,
    cwd: input.cwd,
    checkout: input.descriptor.path,
    access: input.access,
    origin: input.descriptor.origin,
    ...(input.path === undefined ? {} : { path: input.path }),
  } satisfies WorkspaceGrant)

export const makeFixtureView = (input: {
  readonly descriptor: FixtureDescriptor
  readonly outcome: WorkspaceView['outcome']
  readonly reservationId: WorkspaceId
}) =>
  conforming(WorkspaceViewSchema)({
    repositoryId: input.descriptor.repoId,
    taskId: input.descriptor.taskId,
    workspaceId: input.descriptor.workspaceId,
    path: input.descriptor.path,
    origin: input.descriptor.origin,
    reservationId: input.reservationId,
    outcome: input.outcome,
    reason: input.outcome === 'active' ? 'fixture active use' : 'fixture retained workspace',
    nextAction:
      input.outcome === 'active'
        ? 'wait for the current use'
        : 'resume with the exact task and workspace ID',
    uses: [],
    pending: [],
  } satisfies WorkspaceView)

export const makeFixtureBinding = (input: {
  readonly conversation: WorkspaceConversation
  readonly descriptor: FixtureDescriptor
}) =>
  conforming(WorkspaceBindingSchema)({
    conversation: {
      ...input.conversation,
      sessionFile: CanonicalSessionFile.make(
        canonicalConversationFile(input.conversation.sessionFile)
      ),
    },
    taskId: input.descriptor.taskId,
    workspaceId: input.descriptor.workspaceId,
    cwd: input.descriptor.path,
    revision: 0,
  } satisfies WorkspaceBinding)

export const makeFixtureHandoff = (input: {
  readonly operationId: WorkspaceId
  readonly from: WorkspaceBinding
  readonly target: WorkspaceGrant
  readonly reason: string
}) =>
  conforming(WorkspaceHandoffSchema)({
    operationId: input.operationId,
    from: { ...input.from },
    target: input.target,
    reason: input.reason,
  } satisfies WorkspaceHandoff)

export const makeFixtureAssessment = (input: {
  readonly descriptor: FixtureDescriptor
  readonly outcome: WorkspaceAssessment['outcome']
  readonly completion: CompletionVerdict
  readonly reservationId: WorkspaceId
}) =>
  conforming(WorkspaceAssessmentSchema)({
    repositoryId: input.descriptor.repoId,
    taskId: input.descriptor.taskId,
    workspaceId: input.descriptor.workspaceId,
    reservationId: input.reservationId,
    path: input.descriptor.path,
    origin: input.descriptor.origin,
    outcome: input.outcome,
    reasons: [input.completion.reason],
    nextActions: ['fixture next action'],
    evidence: { verdict: 'valid', reasons: [] },
    inventory: { trackedChanges: 0, files: 0, published: 0, disposable: 0, blocking: 0 },
    residual: [],
    target: { source: 'override', description: 'local refs/heads/main, recorded for the task' },
    completion: input.completion,
    subject: {
      repositoryId: input.descriptor.repoId,
      workspaceId: input.descriptor.workspaceId,
      reservationId: input.reservationId,
      reservationRevision: 0,
      workspaceRevision: 0,
      origin: input.descriptor.origin,
      path: input.descriptor.path,
      effect: input.outcome === 'removable' ? 'remove-worktree' : 'none',
      stateDigest: 'a'.repeat(64),
      policyVersion: 4,
    },
  } satisfies WorkspaceAssessment)

export const makeFixtureReceipt = (input: {
  readonly commandId: WorkspaceId
  readonly moment: SweepReceipt['moment']
  readonly rows: readonly {
    readonly descriptor: FixtureDescriptor
    readonly outcome: Extract<SweepRow, { readonly kind: 'workspace' }>['outcome']
    readonly verdict: CompletionVerdict
    readonly reason: string
  }[]
}) =>
  conforming(SweepReceiptSchema)({
    commandId: input.commandId,
    moment: input.moment,
    rows: input.rows.map(row => ({
      kind: 'workspace' as const,
      taskId: row.descriptor.taskId,
      workspaceId: row.descriptor.workspaceId,
      path: row.descriptor.path,
      origin: row.descriptor.origin,
      verdict: row.verdict,
      outcome: row.outcome,
      reason: row.reason,
    })),
  } satisfies SweepReceipt)
