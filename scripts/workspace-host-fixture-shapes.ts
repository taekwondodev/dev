// The stub lifecycle bypasses the client that decodes every authority response, so each
// factory decodes what it makes.
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { Schema } from 'effect'
import {
  CanonicalSessionFile,
  WorkspaceBindingSchema,
  WorkspaceGrantSchema,
  WorkspaceHandoffSchema,
  WorkspaceId,
  WorkspaceViewSchema,
  type WorkspaceBinding,
  type WorkspaceConversation,
  type WorkspaceGrant,
  type WorkspaceHandoff,
  type WorkspaceView,
} from '../src/workspace-domain.ts'
import { canonicalSlot } from '../src/workspace-paths.ts'
import { lstatIfExists } from '../src/workspace-platform.ts'

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
    // The authority binds a conversation by its canonical file.
    conversation: {
      ...input.conversation,
      sessionFile: CanonicalSessionFile.make(
        canonicalSlot(
          resolve(input.conversation.sessionFile),
          lstatIfExists(resolve(input.conversation.sessionFile))
        )
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

// True only when the factory's literal carries every key of the seam type, optional ones
// included; the annotation below turns a false into a type error.
type ProducesEvery<Produced, Seam> = [Exclude<keyof Seam, keyof Produced>] extends [never]
  ? true
  : false
export const stubProducesEveryField: {
  readonly grant: ProducesEvery<ReturnType<typeof makeFixtureGrant>, WorkspaceGrant>
  readonly view: ProducesEvery<ReturnType<typeof makeFixtureView>, WorkspaceView>
  readonly binding: ProducesEvery<ReturnType<typeof makeFixtureBinding>, WorkspaceBinding>
  readonly handoff: ProducesEvery<ReturnType<typeof makeFixtureHandoff>, WorkspaceHandoff>
} = { grant: true, view: true, binding: true, handoff: true }
