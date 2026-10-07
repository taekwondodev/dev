import type { AttemptView, WorkSnapshot } from './work-domain.ts'

const childType = (record: AttemptView): string => {
  const skill = record.resources?.invokedSkill?.name
  if (skill !== undefined) return skill
  if (record.coordinator === true) return 'coordinator'
  return record.access === 'read-only' ? 'reader' : 'writer'
}

const shortModel = (model: string): string =>
  model.slice(model.indexOf('/') + 1).replace(/^claude-/, '')

const compactTokens = (count: number): string => {
  if (count < 1000) return `${count}`
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}

const agentTitles = (snapshot: WorkSnapshot, agents: readonly AttemptView[]): string[] => {
  const byId = new Map(snapshot.records.map(record => [record.id, record]))
  const titles = agents.map(record => {
    const { parent } = record.owner
    if (parent === undefined) return childType(record)
    const coordinator = byId.get(parent)
    return `${coordinator === undefined ? 'coordinator' : childType(coordinator)}>${childType(record)}`
  })
  const repeated = (title: string) => titles.filter(other => other === title).length > 1
  return titles.map((title, index) =>
    repeated(title) ? `${title} (${agents[index]?.owner.taskId})` : title
  )
}

export const activeWorkChildren = (snapshot: WorkSnapshot): readonly AttemptView[] =>
  snapshot.records.filter(
    record =>
      record.kind === 'agent' && (record.status === 'running' || record.status === 'waiting')
  )

export const workStatusText = (
  snapshot: WorkSnapshot,
  reactivationSuspended: boolean
): string | undefined => {
  const counts = new Map<string, number>()
  for (const record of snapshot.records)
    counts.set(record.status, (counts.get(record.status) ?? 0) + 1)
  const states = [...counts].map(([status, count]) => `${count} ${status}`).join(' · ')
  const children = snapshot.records.filter(record => record.kind === 'agent')
  const metered = children.filter(record => typeof record.usage?.total === 'number')
  const tokens = metered.reduce((sum, record) => sum + (record.usage?.total ?? 0), 0)
  let usage = children.length ? 'tok unavailable' : ''
  if (metered.length) {
    usage = `${compactTokens(tokens)} tok`
    if (metered.length < children.length)
      usage += ` (${children.length - metered.length} unavailable)`
  }
  const agents = activeWorkChildren(snapshot)
  const titles = agentTitles(snapshot, agents)
  const models = agents
    .map((record, index) => {
      const percentage = record.context?.percent
      const pressure = typeof percentage === 'number' ? `${Math.round(percentage)}%` : 'ctx ?'
      const model = record.model === undefined ? 'model pending' : shortModel(record.model)
      return `${titles[index]} ${model} ${pressure}`
    })
    .join(' · ')
  return (
    [
      states,
      models,
      usage,
      snapshot.agentsBlocked ? 'subscription exhausted; agents blocked' : '',
      reactivationSuspended ? 'lead failed; automatic reactivation suspended' : '',
    ]
      .filter(Boolean)
      .join(' │ ') || undefined
  )
}
