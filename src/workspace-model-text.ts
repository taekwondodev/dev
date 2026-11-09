import { SWEEP_MOMENT_TEXT, type WorkspaceReport } from './workspace-command.ts'
import type {
  SweepReceipt,
  SweepRow,
  WorkspaceAssessment,
  WorkspaceId,
  WorkspaceView,
} from './workspace-domain.ts'

export const WORKSPACE_MESSAGE = 'dev/workspace'
export const HANDOFF_MESSAGE = 'dev/workspace-handoff'
export const RECEIPT_ENTRY = 'dev/workspace-receipt'

export interface SweepDetails {
  readonly kind: 'sweep'
  readonly receipt: SweepReceipt
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
    ['origin', view.origin],
    ['outcome', view.outcome],
    ['reason', view.reason],
    ['next', view.nextAction],
    ['directoryMissing', view.directoryMissing === true ? true : undefined],
    [
      'uses',
      nonEmpty(
        view.uses.map(use =>
          present([
            ['access', use.access],
            ['stage', use.stage],
            ['attempt', use.execution?.attemptId],
          ])
        )
      ),
    ],
    ['pending', nonEmpty(view.pending.map(item => `${item.kind} (${item.stage})`))],
  ])

const assessmentObject = ({ completion, ...assessment }: WorkspaceAssessment): ModelObject =>
  present([
    ['workspaceId', assessment.workspaceId],
    ['path', assessment.path],
    ['origin', assessment.origin],
    ['role', completion.role],
    [
      'verdict',
      completion.kind === 'finished'
        ? `finished (${completion.rule})`
        : `retained (${completion.retained})`,
    ],
    ['reason', completion.reason],
    ['target', assessment.target.description],
    ['reasons', nonEmpty(assessment.reasons)],
    ['evidence', assessment.evidence?.verdict],
    ['inventory', assessment.inventory],
    ['residual', nonEmpty(assessment.residual)],
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
          ['workspaces', report.views.map(viewObject)],
        ])
      )
    case 'inspect':
      return JSON.stringify(
        present([
          ['taskId', report.taskId],
          ['artifacts', report.artifacts],
          ['workspaces', report.views.map(viewObject)],
        ])
      )
    case 'check':
      return `A check changes nothing; the next sweep rechecks everything.\n${JSON.stringify({
        taskId: report.taskId,
        workspaces: report.assessments.map(assessmentObject),
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
        ['outcome', row.outcome],
        ['reason', row.outcome === 'review-required' ? row.reason : undefined],
      ])
    case 'task-artifacts':
      return present([
        ['taskId', row.taskId],
        ['artifacts', row.path],
        ['outcome', row.outcome],
        ['reason', row.outcome === 'review-required' ? row.reason : undefined],
      ])
    case 'task-failure':
      return {
        taskId: row.taskId,
        outcome: 'review-required',
        reason: row.reason,
      }
    case 'task-deferred':
      return { taskId: row.taskId, outcome: 'deferred' }
    case 'sweep-failure':
      return { outcome: 'review-required', reason: row.reason }
  }
}

export const sweepText = (receipt: SweepReceipt): string | undefined => {
  const rows = receipt.rows.filter(changesSomething)
  if (rows.length === 0) return undefined
  return `Workspace sweep ${SWEEP_MOMENT_TEXT[receipt.moment]}: ${JSON.stringify(rows.map(sweepRowObject))}`
}
