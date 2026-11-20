import type {
  AttemptInspection,
  AttemptOutcome,
  AttemptSummary,
  DispatchConfig,
  DispatchProfile,
  LogView,
  WorkResult,
  WorkSnapshotView,
} from './work-domain.ts'
import { redactSecrets } from './error-text.ts'

export const RUN_CANCELLED = 'Run cancelled'

export const OUTPUT_PREVIEW = 512
export const TRUNCATED_RESULT =
  'Too long to show; read it with work inspect, this id, stream "result", offset 0'

type ModelObject = Record<string, unknown>

const present = (entries: readonly (readonly [string, unknown])[]): ModelObject =>
  Object.fromEntries(entries.filter(([, value]) => value !== undefined))

const attemptObject = (attempt: AttemptSummary): ModelObject =>
  present([
    ['id', attempt.id],
    ['taskId', attempt.taskId],
    ['kind', attempt.kind],
    ['status', attempt.status],
    ['parent', attempt.parent],
    ['coordinate', attempt.coordinate === true ? true : undefined],
    ['exitCode', typeof attempt.exitCode === 'number' ? attempt.exitCode : undefined],
    ['error', attempt.error],
    ['deliveryError', attempt.deliveryError],
    ['cleanupError', attempt.cleanupError],
    ['lockWarning', attempt.lockWarning],
    ['processObservation', attempt.processObservation],
    ['recovery', attempt.recovery],
    ['orb', attempt.orb],
    [
      'worktree',
      attempt.worktree === undefined
        ? undefined
        : { path: attempt.worktree.path, cleanup: attempt.worktree.cleanup },
    ],
  ])

const staleArtifact = (value: AttemptOutcome['staleArtifact']) =>
  value === false ? undefined : value

const unavailableStreams = (logs: readonly LogView[]) => {
  const streams = logs.filter(log => !log.available).map(log => log.stream)
  return streams.length === 0 ? undefined : streams
}

export const outputPreview = (text: string, truncated: boolean): string => {
  const points = [...text]
  if (points.length <= OUTPUT_PREVIEW) return truncated ? `…${text}` : text
  return `…${points.slice(-OUTPUT_PREVIEW).join('')}`
}

const outcomeObject = (outcome: AttemptOutcome): ModelObject => {
  const output = outcome.logs.flatMap((log): (readonly [string, string])[] => {
    if (!log.available || !log.text) return []
    if (log.stream === 'result')
      return [['result', log.truncated === true ? TRUNCATED_RESULT : log.text]]
    return [[log.stream, outputPreview(log.text, log.truncated === true)]]
  })
  return {
    ...attemptObject(outcome),
    ...present([
      ['staleArtifact', staleArtifact(outcome.staleArtifact)],
      ...output,
      ['unavailable', unavailableStreams(outcome.logs)],
    ]),
  }
}

const inspectionObject = ({ run, logs, staleArtifact: stale }: AttemptInspection): ModelObject => {
  const streams = logs.filter(log => log.available && log.text).map(log => log.stream)
  return {
    ...attemptObject(run),
    ...present([
      ['staleArtifact', stale === undefined ? undefined : staleArtifact(stale)],
      ['workflowTaskId', run.workflowTaskId],
      ['workspaceId', run.workspaceId],
      ['access', run.access],
      ['invokedSkill', run.invokedSkill],
      ['cwd', run.cwd === run.worktree?.path ? undefined : run.cwd],
      ['streams', streams.length === 0 ? undefined : streams],
      ['unavailable', unavailableStreams(logs)],
    ]),
  }
}

const logObject = (log: LogView): ModelObject =>
  log.available
    ? present([
        ['text', log.text ?? ''],
        ['nextOffset', log.nextOffset ?? null],
        ['truncated', log.truncated === true ? true : undefined],
      ])
    : { error: log.reason ?? 'Log unavailable' }

const snapshotObject = (snapshot: WorkSnapshotView): ModelObject =>
  present([
    ['records', snapshot.records.map(attemptObject)],
    ['nextOffset', snapshot.nextOffset],
    ['unavailable', snapshot.unavailable.length === 0 ? undefined : snapshot.unavailable],
    ['agentsBlocked', snapshot.agentsBlocked ? true : undefined],
    ['cancellationRequested', snapshot.cancellationRequested === true ? true : undefined],
  ])

const profileObject = (profile: DispatchProfile): ModelObject =>
  present([
    ['model', profile.model],
    ['effort', profile.effort],
  ])

const dispatchObject = (dispatch: DispatchConfig): ModelObject => ({
  default: profileObject(dispatch.default),
  rules: Object.fromEntries(
    Object.entries(dispatch.rules).map(([name, profile]) => [name, profileObject(profile)])
  ),
})

const resultObject = (result: WorkResult): ModelObject => {
  switch (result.kind) {
    case 'run':
      return result.run === undefined ? {} : attemptObject(result.run)
    case 'runs':
      return result.runs === undefined ? {} : snapshotObject(result.runs)
    case 'inspection':
      return result.inspection === undefined ? {} : inspectionObject(result.inspection)
    case 'log':
      return result.log === undefined ? {} : logObject(result.log)
    case 'dispatch':
      return result.dispatch === undefined ? {} : dispatchObject(result.dispatch)
    default: {
      const unsupported: never = result.kind
      return unsupported
    }
  }
}

export const workResultText = (result: WorkResult): string => JSON.stringify(resultObject(result))

export const outcomeText = (outcomes: readonly AttemptOutcome[], guidance: string): string =>
  `${guidance}\n${JSON.stringify(outcomes.map(outcomeObject))}`

export interface QuietOutcome {
  readonly outcome: AttemptOutcome
  readonly since: number
  readonly quietSeconds: number
  readonly runningSeconds: number
}

export type QuietFacts = AttemptOutcome & Omit<QuietOutcome, 'outcome'>

export const quietFacts = ({ outcome, ...times }: QuietOutcome): QuietFacts => ({
  ...outcome,
  logs: outcome.logs.map(log =>
    log.text === undefined ? log : { ...log, text: redactSecrets(log.text) }
  ),
  ...times,
})

const quietObject = (quiet: QuietOutcome): ModelObject => {
  const { since: _since, quietSeconds, runningSeconds, ...outcome } = quietFacts(quiet)
  const { kind: _kind, status: _status, staleArtifact: _stale, ...facts } = outcomeObject(outcome)
  return { ...facts, runningSeconds, quietSeconds }
}

export const quietText = (notices: readonly QuietOutcome[], guidance: string): string =>
  `${guidance}\n${JSON.stringify(notices.map(quietObject))}`
