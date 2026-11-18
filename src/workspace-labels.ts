import type { WorkspaceExecution } from './workspace-domain.ts'
import type { UseRecord } from './workspace-records.ts'

const USE_STAGE_LABELS: Record<UseRecord['stage'], string> = {
  authorized: 'permitted',
  'operation-started': 'running',
  'launch-intent': 'launch-planned',
  spawned: 'starting',
  started: 'running',
  observed: 'running',
  quiescent: 'ended',
  unknown: 'unknown',
}

const isUseStage = (stage: string): stage is UseRecord['stage'] =>
  Object.hasOwn(USE_STAGE_LABELS, stage)

export const checkoutUseStage = (stage: string): string =>
  isUseStage(stage) ? USE_STAGE_LABELS[stage] : stage

export const isConversationShell = (execution: WorkspaceExecution): boolean =>
  execution.taskKey === 'lead-shell' && execution.generation === 'lead'

export const executionLabel = (execution: WorkspaceExecution): string =>
  isConversationShell(execution) ? 'a bash command' : `run ${execution.attemptId}`
