import { Worker } from 'node:worker_threads'
import { Effect, Exit, Schema, Scope } from 'effect'
import { errorText } from '../src/error-text.ts'
import {
  WorkspaceError,
  type PublicationReference,
  type ReleaseRequest,
  type RuleApproval,
  type TaskTarget,
  type WorkspaceAssessment,
  type WorkspaceAttachment,
  type WorkspaceAuthorization,
  type WorkspaceBinding,
  type WorkspaceConversation,
  type WorkspaceExecutionFact,
  type WorkspaceGrant,
  type WorkspaceHandoff,
  type WorkspaceId,
  type WorkspaceLifecycle,
  type WorkspaceOperation,
  type WorkspaceReleaseResult,
  type WorkspaceSelection,
  type WorkspaceView,
} from '../src/workspace-domain.ts'
import { makeWorkspaceLifecycle, type StartWorkspaceWorker } from '../src/workspace-lifecycle.ts'
import { makeWorkspaceShell, type WorkspaceAdmission } from '../src/workspace-shell.ts'
import {
  WorkspaceWorkerMessageSchema,
  type WorkspaceRpcOperation,
} from '../src/workspace-protocol.ts'
import type { BashOperations } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js'

const isWorkerMessage = Schema.is(WorkspaceWorkerMessageSchema)

export const faultInjector = () => {
  let started: Worker | undefined
  let armedFor: WorkspaceRpcOperation | undefined
  const dropped: WorkspaceRpcOperation[] = []
  const startWorker: StartWorkspaceWorker = (url, options) => {
    const worker = new Worker(url, options)
    started = worker
    return {
      postMessage: (value, transferList) => worker.postMessage(value, transferList),
      terminate: () => worker.terminate(),
      on: (event, listener) =>
        worker.on(
          event,
          event === 'message'
            ? (value: unknown) => {
                if (
                  armedFor !== undefined &&
                  isWorkerMessage(value) &&
                  !('type' in value) &&
                  value.ok &&
                  value.op === armedFor
                ) {
                  dropped.push(value.op)
                  armedFor = undefined
                  void worker.terminate()
                  return
                }
                listener(value)
              }
            : listener
        ),
    }
  }
  return {
    startWorker,
    dropped,
    dropNextAcknowledgment: (operation: WorkspaceRpcOperation) => {
      armedFor = operation
    },
    worker: (): Worker => {
      if (started === undefined) throw new Error('The lifecycle started no worker')
      return started
    },
  }
}

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
    readonly taskId?: WorkspaceId
  }): Promise<readonly WorkspaceView[]>
  validate(grant: WorkspaceGrant): Promise<void>
  check(taskId: WorkspaceId): Promise<readonly WorkspaceAssessment[]>
  release(request: ReleaseRequest): Promise<WorkspaceReleaseResult>
  recordTarget(taskId: WorkspaceId, target: TaskTarget): Promise<void>
  recordPublication(reference: PublicationReference): Promise<void>
  recordRuleApproval(approval: RuleApproval): Promise<void>
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

export const openLifecycle = async (options: {
  readonly root: string
  readonly startWorker?: StartWorkspaceWorker
}): Promise<TestLifecycle> => {
  const scope = await Effect.runPromise(Scope.make())
  const lifecycle = await Effect.runPromise(Scope.provide(scope)(makeWorkspaceLifecycle(options)))
  return {
    effect: lifecycle,
    attach: input => Effect.runPromise(lifecycle.attach(input)).then(promisedAttachment),
    inspect: input => Effect.runPromise(lifecycle.inspect(input)),
    validate: grant => Effect.runPromise(lifecycle.validate(grant)),
    check: taskId => Effect.runPromise(lifecycle.check({ taskId })),
    release: request => Effect.runPromise(lifecycle.release(request)),
    recordTarget: (taskId, target) => Effect.runPromise(lifecycle.recordTarget({ taskId, target })),
    recordPublication: reference => Effect.runPromise(lifecycle.recordPublication({ reference })),
    recordRuleApproval: approval => Effect.runPromise(lifecycle.recordRuleApproval({ approval })),
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  }
}

export interface TestShell {
  readonly operations: BashOperations
  live(): number
  stop(): Promise<void>
}

export const openShell = async (
  admit: (cwd: string) => Promise<WorkspaceAdmission>
): Promise<TestShell> => {
  const scope = await Effect.runPromise(Scope.make())
  const shell = await Effect.runPromise(
    Scope.provide(scope)(
      makeWorkspaceShell(cwd =>
        Effect.tryPromise({
          try: () => admit(cwd),
          catch: cause =>
            cause instanceof WorkspaceError
              ? cause
              : new WorkspaceError({
                  outcome: 'unavailable',
                  message: errorText(cause),
                }),
        })
      )
    )
  )
  return {
    operations: shell.operations,
    live: () => shell.live(),
    stop: () => Effect.runPromise(shell.stop),
  }
}
