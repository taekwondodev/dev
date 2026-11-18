import { checkoutUseStage } from './workspace-labels.ts'
import {
  describedHead,
  pendingOperationText,
  SWEEP_MOMENT_TEXT,
  verdictLabel,
  type WorkspaceReport,
} from './workspace-command.ts'
import {
  type SweepReceipt,
  type SweepRow,
  type WorkspaceAssessment,
  type WorkspaceId,
  type WorkspaceView,
} from './workspace-domain.ts'

export const WORKSPACE_MESSAGE = 'dev/workspace'
export const HANDOFF_MESSAGE = 'dev/workspace-handoff'
export const RECEIPT_ENTRY = 'dev/workspace-receipt'
export const REFUSAL_ENTRY = 'dev/workspace-refusal'

export interface SweepDetails {
  readonly kind: 'sweep'
  readonly receipt: SweepReceipt
}

export interface RefusalDetails {
  readonly kind: 'refusal'
  readonly reason: string
  readonly endedTurn: boolean
  readonly next: string
}

export interface SwitchDetails {
  readonly kind: 'switch'
  readonly resumed: boolean
  readonly workspaceId: WorkspaceId
  readonly cwd: string
  readonly reason: string
}

type ModelObject = Record<string, unknown>

const present = (entries: readonly (readonly [string, unknown])[]): ModelObject =>
  Object.fromEntries(entries.filter(([, value]) => value !== undefined))

const nonEmpty = <A>(items: readonly A[]): readonly A[] | undefined =>
  items.length === 0 ? undefined : items

const viewObject = (view: WorkspaceView): ModelObject =>
  present([
    ['taskId', view.taskId],
    ['workspaceId', view.workspaceId],
    ['path', view.path],
    ['head', describedHead(view.head)],
    ['origin', view.origin],
    ['result', view.outcome],
    ['reason', view.reason],
    ['next', view.nextAction],
    ['directoryMissing', view.directoryMissing === true ? true : undefined],
    [
      'uses',
      nonEmpty(
        view.uses.map(use =>
          present([
            ['access', use.access],
            ['stage', checkoutUseStage(use.stage)],
            ['run', use.execution?.attemptId],
          ])
        )
      ),
    ],
    ['pending', nonEmpty(view.pending.map(pendingOperationText))],
  ])

const assessmentObject = ({ completion, ...assessment }: WorkspaceAssessment): ModelObject =>
  present([
    ['workspaceId', assessment.workspaceId],
    ['path', assessment.path],
    ['origin', assessment.origin],
    ['role', completion.role],
    ['verdict', verdictLabel(completion)],
    ['reason', completion.reason],
    ['target', assessment.target.description],
    ['reasons', nonEmpty(assessment.reasons)],
    ['evidence', assessment.evidence?.verdict],
    ['inventory', assessment.inventory],
    ['remaining', nonEmpty(assessment.residual)],
    ['next', nonEmpty(assessment.nextActions)],
  ])

export const reportText = (report: WorkspaceReport): string => {
  switch (report.kind) {
    case 'list':
      return JSON.stringify(
        present([
          ['repository', report.repositoryRoot],
          [
            'current',
            report.current === undefined
              ? undefined
              : {
                  workspaceId: report.current.workspaceId,
                  cwd: report.current.effectiveCwd,
                },
          ],
          ['artifacts', report.artifacts],
          ['checkouts', report.views.map(viewObject)],
        ])
      )
    case 'inspect':
      return JSON.stringify(
        present([
          ['taskId', report.taskId],
          ['artifacts', report.artifacts],
          ['checkouts', report.views.map(viewObject)],
        ])
      )
    case 'check':
      return `Read-only check. Dev checks again before cleanup.\n${JSON.stringify({
        taskId: report.taskId,
        checkouts: report.assessments.map(assessmentObject),
      })}`
  }
}

const changesSomething = (row: SweepRow): boolean => {
  switch (row.kind) {
    case 'workspace':
      return row.outcome !== 'retained' && row.outcome !== 'skipped'
    case 'task-deferred':
      return false
    case 'task-artifacts':
    case 'task-failure':
    case 'sweep-failure':
      return true
  }
}

const sweepRowObject = (row: SweepRow): ModelObject => {
  switch (row.kind) {
    case 'workspace':
      return present([
        ['taskId', row.taskId],
        ['workspaceId', row.workspaceId],
        ['path', row.path],
        ['result', row.outcome],
        ['reason', row.outcome === 'review-required' ? row.reason : undefined],
      ])
    case 'task-artifacts':
      return present([
        ['taskId', row.taskId],
        ['artifacts', row.path],
        ['result', row.outcome],
        ['reason', row.outcome === 'review-required' ? row.reason : undefined],
      ])
    case 'task-failure':
      return {
        taskId: row.taskId,
        result: 'review-required',
        reason: row.reason,
      }
    case 'task-deferred':
      return { taskId: row.taskId, result: 'deferred' }
    case 'sweep-failure':
      return { result: 'review-required', reason: row.reason }
  }
}

export const sweepText = (receipt: SweepReceipt): string | undefined => {
  const rows = receipt.rows.filter(changesSomething)
  if (rows.length === 0) return undefined
  return `Automatic cleanup ${SWEEP_MOMENT_TEXT[receipt.moment]}: ${JSON.stringify(rows.map(sweepRowObject))}`
}
