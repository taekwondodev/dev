import { Effect } from 'effect'
import {
  asAttemptId,
  isAttemptId,
  WorkError,
  type AgentStartRequest,
  type AttemptView,
  type ProcessStartRequest,
  type WorkFailure,
  type WorkOwnerService,
} from './work-domain.ts'
import type { WorkInput } from './work-protocol.ts'
import { errorText } from './error-text.ts'

export type WorkActions = Pick<
  WorkOwnerService,
  'snapshot' | 'startAgent' | 'cancel' | 'inspect' | 'readLog' | 'dispatch' | 'interrupt'
> &
  Partial<Pick<WorkOwnerService, 'startProcess'>>

export const summary = (record: AttemptView) => ({
  id: record.id,
  taskId: record.owner.taskId,
  parent: record.owner.parent,
  coordinator: record.coordinator,
  workflowTaskId: record.workflowTaskId,
  workspaceId: record.workspaceId,
  workspaceUseId: record.workspaceUseId,
  cwd: record.cwd,
  status: record.status,
  kind: record.kind,
  worktree: record.worktree,
  model: record.model ?? 'unavailable',
  invokedSkill: record.resources?.invokedSkill?.name,
  tools: record.resources?.tools,
  context: record.context ?? 'unavailable',
  usage: record.usage ?? 'unavailable',
  error: record.error ?? record.observationError ?? record.persistenceError,
  deliveryError: record.deliveryError,
  cleanupError: record.cleanupError,
  gateReleaseWarning: record.gateReleaseWarning,
  processObservation: record.processObservation,
  recovery: record.recovery,
})

const PAGE = 20

const startProcess = (
  actions: WorkActions,
  input: WorkInput
): Effect.Effect<unknown, WorkFailure> => {
  if (actions.startProcess === undefined)
    return Effect.fail(new WorkError({ message: 'Unsupported work operation' }))
  const request: ProcessStartRequest = {
    taskId: input.taskId ?? '',
    command: input.command ?? '',
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
  }
  return actions.startProcess(request)
}

const startAgent = (
  actions: WorkActions,
  input: WorkInput
): Effect.Effect<unknown, WorkFailure> => {
  const request: AgentStartRequest = {
    taskId: input.taskId ?? '',
    prompt: input.prompt ?? '',
    access: input.access ?? 'read-only',
    ...(input.coordinate === undefined ? {} : { coordinate: input.coordinate }),
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.rule === undefined ? {} : { rule: input.rule }),
    ...(input.harness === undefined ? {} : { harness: input.harness }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.effort === undefined ? {} : { effort: input.effort }),
  }
  return actions.startAgent(request)
}

const list = (actions: WorkActions, input: WorkInput): Effect.Effect<unknown, WorkFailure> =>
  actions.snapshot.pipe(
    Effect.map(snapshot => {
      const offset = input.offset ?? 0
      return {
        ...snapshot,
        total: snapshot.records.length,
        records: snapshot.records.slice(offset, offset + PAGE).map(summary),
        nextOffset: offset + PAGE < snapshot.records.length ? offset + PAGE : null,
      }
    })
  )

const cancel = (actions: WorkActions, input: WorkInput): Effect.Effect<unknown, WorkFailure> => {
  const { id } = input
  return id === undefined
    ? actions.interrupt('explicit stop').pipe(
        Effect.andThen(actions.snapshot),
        Effect.map(snapshot => ({
          cancellationRequested: true,
          ...snapshot,
          records: snapshot.records.map(summary),
        }))
      )
    : Effect.try({
        try: () => asAttemptId(id),
        catch: cause => new WorkError({ message: errorText(cause), cause }),
      }).pipe(Effect.flatMap(attemptId => actions.cancel(attemptId)))
}

export const unavailableAttempt = (): WorkError =>
  new WorkError({
    message: 'Result is unavailable in this session (unknown or expired attempt)',
  })

const inspect = (actions: WorkActions, input: WorkInput): Effect.Effect<unknown, WorkFailure> => {
  const { id, stream, offset } = input
  if (id === undefined || !isAttemptId(id)) return Effect.fail(unavailableAttempt())
  return stream === undefined
    ? actions.inspect(id)
    : actions.readLog({ id, stream, ...(offset === undefined ? {} : { offset }) })
}

export const executeWork = (
  actions: WorkActions,
  input: WorkInput
): Effect.Effect<unknown, WorkFailure> => {
  switch (input.action) {
    case 'process':
      return startProcess(actions, input)
    case 'delegate':
      return startAgent(actions, input)
    case 'dispatch':
      return actions.dispatch
    case 'list':
      return list(actions, input)
    case 'cancel':
      return cancel(actions, input)
    case 'inspect':
      return inspect(actions, input)
    default: {
      const unsupported: never = input.action
      return unsupported
    }
  }
}
