import { Effect, Schema } from 'effect'
import {
  asAttemptId,
  isAttemptId,
  WorkError,
  type AgentStartRequest,
  type AttemptDescription,
  type AttemptFacts,
  type AttemptInspection,
  type AttemptOutcome,
  type AttemptSummary,
  type AttemptView,
  type DispatchConfig,
  type LogPage,
  type LogRequest,
  type LogView,
  type ProcessStartRequest,
  type WorkFailure,
  type WorkOwnerService,
  type WorkResult,
  type WorkSnapshot,
  type WorkSnapshotView,
} from './work-domain.ts'
import type { WorkInput } from './work-protocol.ts'
import { errorText } from './error-text.ts'

export type WorkActions = Pick<
  WorkOwnerService,
  'snapshot' | 'startAgent' | 'cancel' | 'inspect' | 'readLog' | 'dispatch' | 'interrupt'
> &
  Partial<Pick<WorkOwnerService, 'startProcess'>>

const defined = <T extends object>(value: { readonly [K in keyof T]: T[K] | undefined }): T =>
  Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T

export const summarize = (record: AttemptView): AttemptSummary =>
  defined<AttemptSummary>({
    id: record.id,
    taskId: record.owner.taskId,
    parent: record.owner.parent,
    coordinator: record.coordinator,
    workflowTaskId: record.workflowTaskId,
    workspaceId: record.workspaceId,
    cwd: record.cwd,
    kind: record.kind,
    status: record.status,
    access: record.access,
    model: record.model,
    invokedSkill: record.resources?.invokedSkill?.name,
    worktree:
      record.worktree === undefined
        ? undefined
        : { path: record.worktree.path, cleanup: record.worktree.cleanup },
    exitCode: record.exitCode,
    completedAt: record.completedAt,
    error: record.error ?? record.observationError ?? record.persistenceError,
    context: record.context,
    usage:
      record.usage === undefined
        ? undefined
        : { total: record.usage.total, cost: record.usage.cost },
    deliveryError: record.deliveryError,
    cleanupError: record.cleanupError,
    gateReleaseWarning: record.gateReleaseWarning,
    processObservation: record.processObservation,
    recovery: record.recovery,
  })

export const factsOf = (record: AttemptView): AttemptFacts =>
  defined<AttemptFacts>({
    id: record.id,
    kind: record.kind,
    parent: record.owner.parent,
    coordinator: record.coordinator,
    sessionFile: record.sessionFile,
  })

export const logView = (page: LogPage, stream: LogRequest['stream']): LogView =>
  defined<LogView>({
    stream,
    available: page.available,
    reason: page.reason,
    text: page.text,
    truncated: page.truncated,
    nextOffset: page.nextOffset,
  })

export const outcomeView = (attempt: AttemptView | AttemptDescription): AttemptOutcome => ({
  ...summarize(attempt),
  staleArtifact: 'staleArtifact' in attempt ? attempt.staleArtifact : 'unknown',
  logs: 'logs' in attempt ? attempt.logs.map(log => logView(log, log.stream)) : [],
})

const decodeRecord = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.JsonObject))

const inspectionView = (description: AttemptDescription): AttemptInspection => {
  const { staleArtifact: _stale, logs: _logs, worktree: _worktree, ...record } = description
  return { ...outcomeView(description), record: decodeRecord(JSON.stringify(record)) }
}

const PAGE = 20

const snapshotResult = (
  snapshot: WorkSnapshot,
  offset: number,
  cancellationRequested?: true
): WorkResult => ({
  kind: 'snapshot',
  snapshot: defined<WorkSnapshotView>({
    records: snapshot.records.slice(offset, offset + PAGE).map(summarize),
    unavailable: snapshot.unavailable,
    agentsBlocked: snapshot.agentsBlocked,
    total: snapshot.records.length,
    nextOffset: offset + PAGE < snapshot.records.length ? offset + PAGE : null,
    cancellationRequested,
  }),
})

const attemptResult = (view: AttemptView): WorkResult => ({
  kind: 'attempt',
  attempt: summarize(view),
})

const inspectionResult = (description: AttemptDescription): WorkResult => ({
  kind: 'inspection',
  inspection: inspectionView(description),
})

const logResult = (page: LogPage, stream: LogRequest['stream']): WorkResult => ({
  kind: 'log',
  log: logView(page, stream),
})

const dispatchResult = (dispatch: DispatchConfig): WorkResult => ({ kind: 'dispatch', dispatch })

const startProcess = (
  actions: WorkActions,
  input: WorkInput
): Effect.Effect<WorkResult, WorkFailure> => {
  if (actions.startProcess === undefined)
    return Effect.fail(new WorkError({ message: 'Unsupported work operation' }))
  const request: ProcessStartRequest = {
    taskId: input.taskId ?? '',
    command: input.command ?? '',
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
  }
  return actions.startProcess(request).pipe(Effect.map(attemptResult))
}

const startAgent = (
  actions: WorkActions,
  input: WorkInput
): Effect.Effect<WorkResult, WorkFailure> => {
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
  return actions.startAgent(request).pipe(Effect.map(attemptResult))
}

const list = (actions: WorkActions, input: WorkInput): Effect.Effect<WorkResult, WorkFailure> =>
  actions.snapshot.pipe(Effect.map(snapshot => snapshotResult(snapshot, input.offset ?? 0)))

const cancel = (actions: WorkActions, input: WorkInput): Effect.Effect<WorkResult, WorkFailure> => {
  const { id } = input
  return id === undefined
    ? actions.interrupt('explicit stop').pipe(
        Effect.andThen(actions.snapshot),
        Effect.map(snapshot => snapshotResult(snapshot, 0, true))
      )
    : Effect.try({
        try: () => asAttemptId(id),
        catch: cause => new WorkError({ message: errorText(cause), cause }),
      }).pipe(
        Effect.flatMap(attemptId => actions.cancel(attemptId)),
        Effect.map(attemptResult)
      )
}

export const unavailableAttempt = (): WorkError =>
  new WorkError({
    message: 'Result is unavailable in this session (unknown or expired attempt)',
  })

const inspect = (
  actions: WorkActions,
  input: WorkInput
): Effect.Effect<WorkResult, WorkFailure> => {
  const { id, stream, offset } = input
  if (id === undefined || !isAttemptId(id)) return Effect.fail(unavailableAttempt())
  return stream === undefined
    ? actions.inspect(id).pipe(Effect.map(inspectionResult))
    : actions
        .readLog({ id, stream, ...(offset === undefined ? {} : { offset }) })
        .pipe(Effect.map(page => logResult(page, stream)))
}

export const executeWork = (
  actions: WorkActions,
  input: WorkInput
): Effect.Effect<WorkResult, WorkFailure> => {
  switch (input.action) {
    case 'process':
      return startProcess(actions, input)
    case 'delegate':
      return startAgent(actions, input)
    case 'dispatch':
      return actions.dispatch.pipe(Effect.map(dispatchResult))
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
