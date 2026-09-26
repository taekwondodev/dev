// One definition shared by the PTY stub and the contract check keeps the stub from drifting
// silently. Each factory's literal satisfies its seam type, so a missing, misspelled or
// mistyped field fails typecheck; the guard below also fails it when a seam type gains an
// optional field the stub does not produce.
import {
  WorkspaceId,
  type WorkspaceBinding,
  type WorkspaceConversation,
  type WorkspaceGrant,
  type WorkspaceHandoff,
  type WorkspaceView,
} from '../src/workspace-domain.ts'

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

export const makeFixtureGrant = (input: {
  readonly namespaceId: WorkspaceId
  readonly descriptor: FixtureDescriptor
  readonly access: 'read' | 'write'
  readonly cwd: string
  readonly sequence: number
  readonly path?: string
}) =>
  ({
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
  }) satisfies WorkspaceGrant

export const makeFixtureView = (input: {
  readonly descriptor: FixtureDescriptor
  readonly outcome: WorkspaceView['outcome']
  readonly reservationId: WorkspaceId
}) =>
  ({
    repositoryId: input.descriptor.repoId,
    taskId: input.descriptor.taskId,
    taskLabel: input.descriptor.label,
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
  }) satisfies WorkspaceView

export const makeFixtureBinding = (input: {
  readonly conversation: WorkspaceConversation
  readonly descriptor: FixtureDescriptor
}) =>
  ({
    conversation: input.conversation,
    taskId: input.descriptor.taskId,
    workspaceId: input.descriptor.workspaceId,
    cwd: input.descriptor.path,
    revision: 0,
  }) satisfies WorkspaceBinding

export const makeFixtureHandoff = (input: {
  readonly operationId: WorkspaceId
  readonly from: WorkspaceBinding
  readonly target: WorkspaceGrant
  readonly reason: string
}) =>
  ({
    operationId: input.operationId,
    from: { ...input.from },
    target: input.target,
    reason: input.reason,
  }) satisfies WorkspaceHandoff

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
