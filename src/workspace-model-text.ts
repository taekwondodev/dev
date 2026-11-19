import { checkoutUseStage } from './workspace-labels.ts'
import {
  describedHead,
  pendingOperationText,
  SWEEP_MOMENT_TEXT,
  verdictLabel,
  type WorkspaceReport,
} from './workspace-command.ts'
import {
  type PausedTask,
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

export type SwitchRequest = 'requested' | 'closing' | 'mismatch' | 'unresolved' | 'changed' | 'busy'

export type BlockedConversation = Exclude<SwitchRequest, 'requested'> | 'switch' | 'replacing'

interface BlockedConversationText {
  readonly fact: string
  readonly staysBlocked?: true
  readonly next?: string
  readonly userNext?: string
}

const QUIT_AND_REOPEN = 'ask the user to quit and reopen this conversation'
const TRY_AGAIN = 'Try again once it finishes.'
const QUIT = 'Quit and reopen this conversation.'

const BLOCKED_CONVERSATION: Record<BlockedConversation, BlockedConversationText> = {
  switch: {
    fact: 'this conversation is switching checkouts',
    next: 'retry after dev reports where it works',
    userNext: TRY_AGAIN,
  },
  replacing: {
    fact: 'this conversation is changing sessions',
    next: 'retry once that finishes',
    userNext: TRY_AGAIN,
  },
  busy: {
    fact: 'another checkout switch or session change is in progress',
    next: 'retry after it ends',
    userNext: TRY_AGAIN,
  },
  mismatch: {
    fact: "this conversation's permission no longer matches it",
    staysBlocked: true,
    next: QUIT_AND_REOPEN,
    userNext: QUIT,
  },
  unresolved: {
    fact: 'dev cannot confirm an earlier checkout switch or session change',
    staysBlocked: true,
    next: QUIT_AND_REOPEN,
    userNext: QUIT,
  },
  closing: { fact: 'this conversation is closing' },
  changed: {
    fact: 'this conversation changed sessions or checkouts meanwhile',
    next: 'check where it works now before retrying',
    userNext: 'Run /workspace resume again to choose from where it is now.',
  },
}

const sentence = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}.`

export const blockedAccess = (state: BlockedConversation, didNotRun: string): string => {
  const { fact, next } = BLOCKED_CONVERSATION[state]
  return `Checkout access is blocked because ${fact}; ${didNotRun}.${next === undefined ? '' : ` ${sentence(next)}`}`
}

export const blockedByMismatch = (cause: string): string =>
  `${cause}. The call did not run, and checkout access stays blocked. ${sentence(QUIT_AND_REOPEN)}`

export const switchNotRequested = (request: Exclude<SwitchRequest, 'requested'>): string => {
  const { fact, staysBlocked, next } = BLOCKED_CONVERSATION[request]
  return `No checkout switch was requested: ${fact}${staysBlocked === true ? ', so checkout access stays blocked' : ''}${next === undefined ? '' : `; ${next}`}.`
}

export const notDoneWhileBlocked = (state: BlockedConversation, notDone: string): string => {
  const { fact, staysBlocked, userNext } = BLOCKED_CONVERSATION[state]
  return `${sentence(`${fact}, so ${staysBlocked === true ? 'its tools stay blocked and ' : ''}${notDone}`)}${userNext === undefined ? '' : ` ${userNext}`}`
}

export const SWITCH_REQUESTED =
  'Dev requested a checkout switch and reports where this conversation works if it completes.'

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

export interface JoinDetails {
  readonly kind: 'join'
  readonly taskId: WorkspaceId
  readonly workspaceId: WorkspaceId
  readonly path: string
  readonly head?: PausedTask['head']
  readonly changedFiles?: number
}

export const joinDetails = ({
  taskId,
  workspaceId,
  path,
  head,
  changedFiles,
}: PausedTask): JoinDetails => ({
  kind: 'join',
  taskId,
  workspaceId,
  path,
  ...(head === undefined ? {} : { head }),
  ...(changedFiles === undefined ? {} : { changedFiles }),
})

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
