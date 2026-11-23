import type { NextAction, WorkspaceExecution } from './workspace-domain.ts'
import type { UseRecord } from './workspace-records.ts'

export const CHECKOUT_CONTENTS_UNREADABLE = 'The checkout contents could not be read.'

export const missingCheckoutText = (checkoutId: string): string => `Checkout missing: ${checkoutId}`

const USE_STAGE_LABELS: Record<UseRecord['stage'], string> = {
  authorized: 'permitted',
  'operation-started': 'running',
  'launch-intent': 'launch-planned',
  spawned: 'starting',
  started: 'running',
  observed: 'observed',
  quiescent: 'ended',
  unknown: 'unknown',
}

const isUseStage = (stage: string): stage is UseRecord['stage'] =>
  Object.hasOwn(USE_STAGE_LABELS, stage)

export const checkoutUseStage = (stage: string): string =>
  isUseStage(stage) ? USE_STAGE_LABELS[stage] : stage

export const pendingStage = (stage: string): string => (stage === 'intent' ? 'planned' : stage)

export const isConversationShell = (execution: WorkspaceExecution): boolean =>
  execution.taskKey === 'lead-shell' && execution.generation === 'lead'

export const executionLabel = (execution: WorkspaceExecution): string =>
  isConversationShell(execution) ? 'a bash command' : `run ${execution.attemptId}`

export const taskRelease = (taskId: string): string =>
  `dev workspace release ${taskId}, which deletes all of that task's managed worktrees and artifacts`

const PRE_EXISTING_RELEASE =
  'dev workspace release pre-existing in this repository, which clears the records of ended sessions in all its pre-existing checkouts that no task keeps and keeps their files'

export const releaseOnceStopped = (taskId: string | undefined): string =>
  taskId === undefined
    ? `Once nothing that ended sessions started still works in this repository's pre-existing checkouts, the user may run ${PRE_EXISTING_RELEASE}.`
    : `Once nothing still works in any of the task's checkouts, the user may run ${taskRelease(taskId)}.`

export const instruction = (text: string): NextAction => ({ kind: 'instruction', text })

export const releaseNext = (taskId: string | undefined, caution?: string): NextAction => ({
  ...(taskId === undefined
    ? { kind: 'release-pre-existing' as const }
    : { kind: 'release-task' as const, taskId }),
  ...(caution === undefined ? {} : { caution }),
})

const releaseTaskId = (action: NextAction): string | undefined =>
  action.kind === 'release-task' ? action.taskId : undefined

export const terminalNextText = (action: NextAction): string =>
  action.kind === 'instruction'
    ? action.text
    : `dev workspace release ${releaseTaskId(action) ?? 'pre-existing'}`

export const agentNextText = (action: NextAction): string =>
  action.kind === 'instruction'
    ? action.text
    : [action.caution, releaseOnceStopped(releaseTaskId(action))]
        .filter(part => part !== undefined)
        .join(' ')
