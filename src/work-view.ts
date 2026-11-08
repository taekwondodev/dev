import { attemptError, settledTurns } from './work-actions.ts'
import type {
  AttemptId,
  AttemptView,
  ChildActivity,
  ChildLive,
  ContextUsage,
  WorkAccess,
  WorkSnapshot,
  WorkStatus,
} from './work-domain.ts'

export const WORK_VIEW_EVENT = 'dev/work-view'

export interface WorkChildView {
  readonly id: AttemptId
  readonly taskId: string
  readonly parent?: AttemptId
  readonly status: WorkStatus
  readonly skill?: string
  readonly coordinator: boolean
  readonly access?: WorkAccess
  readonly model?: string
  readonly effort?: string
  readonly context?: ContextUsage
  readonly startedAt: number
  readonly completedAt?: number
  readonly turns: number
  readonly activity?: ChildActivity
  readonly error?: string
}

export interface WorkView {
  readonly sessionId: string
  readonly children: readonly WorkChildView[]
  readonly commands: { readonly running: number }
  readonly blocks: { readonly agentsBlocked: boolean; readonly reactivationSuspended: boolean }
}

export interface WorkViewInput {
  readonly sessionId: string
  readonly snapshot: WorkSnapshot
  readonly live: ReadonlyMap<AttemptId, ChildLive>
  readonly batchStart: number
  readonly reactivationSuspended: boolean
}

const isActive = (record: AttemptView): boolean =>
  record.status === 'running' || record.status === 'waiting'

const inBatch = (record: AttemptView, batchStart: number): boolean =>
  isActive(record) || (record.completedAt ?? record.startedAt) >= batchStart

const childView = (
  record: AttemptView,
  live: ChildLive | undefined,
  parent: AttemptId | undefined
): WorkChildView => {
  const skill = record.resources?.invokedSkill?.name
  const error = attemptError(record)
  const activity = record.status === 'running' ? live?.activity : undefined
  return {
    id: record.id,
    taskId: record.owner.taskId,
    ...(parent === undefined ? {} : { parent }),
    status: record.status,
    ...(skill === undefined ? {} : { skill }),
    coordinator: record.coordinator === true,
    ...(record.access === undefined ? {} : { access: record.access }),
    ...(record.model === undefined ? {} : { model: record.model }),
    ...(record.effort === undefined ? {} : { effort: record.effort }),
    ...(record.context === undefined ? {} : { context: record.context }),
    startedAt: record.startedAt,
    ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
    turns: live?.turns ?? settledTurns(record) ?? 0,
    ...(activity === undefined ? {} : { activity }),
    ...(error === undefined ? {} : { error }),
  }
}

const byStart = (left: AttemptView, right: AttemptView): number =>
  left.startedAt - right.startedAt || left.id.localeCompare(right.id)

export const workView = ({
  sessionId,
  snapshot,
  live,
  batchStart,
  reactivationSuspended,
}: WorkViewInput): WorkView => {
  const agents = snapshot.records.filter(record => record.kind === 'agent')
  const byId = new Map(agents.map(record => [record.id, record]))
  const visible = new Set(
    agents.filter(record => inBatch(record, batchStart)).map(record => record.id)
  )
  for (const id of visible) {
    const parent = byId.get(id)?.owner.parent
    if (parent !== undefined && byId.has(parent)) visible.add(parent)
  }
  const children = agents
    .filter(record => visible.has(record.id))
    .toSorted(byStart)
    .map(record => {
      const { parent } = record.owner
      return childView(
        record,
        live.get(record.id),
        parent !== undefined && visible.has(parent) ? parent : undefined
      )
    })
  return {
    sessionId,
    children,
    commands: {
      running: snapshot.records.filter(record => record.kind === 'process' && isActive(record))
        .length,
    },
    blocks: { agentsBlocked: snapshot.agentsBlocked, reactivationSuspended },
  }
}

export const emptyWorkView = (sessionId: string): WorkView => ({
  sessionId,
  children: [],
  commands: { running: 0 },
  blocks: { agentsBlocked: false, reactivationSuspended: false },
})
