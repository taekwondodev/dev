import { Effect, Exit, Scope } from 'effect'
import type {
  WorkspaceAttachment,
  WorkspaceAuthorization,
  WorkspaceBinding,
  WorkspaceConversation,
  WorkspaceExecutionFact,
  WorkspaceGrant,
  WorkspaceHandoff,
  WorkspaceLifecycle,
  WorkspaceOperation,
  WorkspaceSelection,
  WorkspaceView,
} from '../src/workspace-domain.ts'
import { makeWorkspaceLifecycle } from '../src/workspace-lifecycle.ts'

// The checks are imperative scripts, so they drive the Effect client through Promises. Code
// under test that takes the client itself receives `effect`.
export interface TestAttachment {
  readonly effect: WorkspaceAttachment
  readonly binding: WorkspaceBinding
  authorize(operation: WorkspaceOperation): Promise<WorkspaceAuthorization>
  select(selection: WorkspaceSelection): Promise<WorkspaceHandoff>
  reportExecution(grant: WorkspaceGrant, fact: WorkspaceExecutionFact): Promise<void>
  handoff(
    transition: WorkspaceHandoff,
    replace: (target: WorkspaceGrant) => Promise<'confirmed' | 'cancelled'>
  ): Promise<void>
  close(): Promise<void>
}

export interface TestLifecycle {
  readonly effect: WorkspaceLifecycle
  attach(input: {
    readonly conversation: WorkspaceConversation
    readonly cwd: string
    readonly selection?: WorkspaceSelection
  }): Promise<TestAttachment>
  inspect(input: {
    readonly cwd?: string
    readonly taskId?: string
  }): Promise<readonly WorkspaceView[]>
  validate(grant: WorkspaceGrant): Promise<void>
  close(): Promise<void>
}

export const promisedAttachment = (attachment: WorkspaceAttachment): TestAttachment => ({
  effect: attachment,
  get binding() {
    return attachment.binding
  },
  authorize: operation => Effect.runPromise(attachment.authorize(operation)),
  select: selection => Effect.runPromise(attachment.select(selection)),
  reportExecution: (grant, fact) => Effect.runPromise(attachment.reportExecution(grant, fact)),
  handoff: (transition, replace) =>
    Effect.runPromise(
      attachment.handoff(transition, target => Effect.promise(() => replace(target)))
    ),
  close: () => Effect.runPromise(attachment.close),
})

export const openLifecycle = async (options: { readonly root: string }): Promise<TestLifecycle> => {
  const scope = await Effect.runPromise(Scope.make())
  const lifecycle = await Effect.runPromise(Scope.provide(scope)(makeWorkspaceLifecycle(options)))
  return {
    effect: lifecycle,
    attach: input => Effect.runPromise(lifecycle.attach(input)).then(promisedAttachment),
    inspect: input => Effect.runPromise(lifecycle.inspect(input)),
    validate: grant => Effect.runPromise(lifecycle.validate(grant)),
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  }
}
