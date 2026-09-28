import type { DatabaseSync } from 'node:sqlite'
import { inDb, type WorkspaceAuthority } from './workspace-authority.ts'
import {
  invalid,
  type PublicationReference,
  type RuleApproval,
  type TaskTarget,
  type WorkspaceId,
} from './workspace-domain.ts'
import {
  getTask,
  getWorkspace,
  putPublication,
  putRuleApproval,
  saveTask,
} from './workspace-records.ts'
import { transaction } from './workspace-sqlite.ts'

const inTaskShard = <A>(
  authority: WorkspaceAuthority,
  taskId: WorkspaceId,
  work: (db: DatabaseSync, repositoryId: WorkspaceId) => A
): A => {
  authority.initialize()
  for (const repository of authority.listRepositories()) {
    const found = inDb(authority, repository.id, db => getTask(db, taskId) !== undefined)
    if (found) return inDb(authority, repository.id, db => work(db, repository.id))
  }
  return invalid(
    `Task ${taskId} is unknown to the workspace authority; a task exists once a write was admitted for it`
  )
}

export const recordTarget = (
  authority: WorkspaceAuthority,
  taskId: WorkspaceId,
  target: TaskTarget
): void =>
  inTaskShard(authority, taskId, db =>
    transaction(db, () => {
      const task = getTask(db, taskId)
      if (task === undefined) return invalid(`Task ${taskId} disappeared`)
      saveTask(db, { ...task, target, revision: task.revision + 1 })
    })
  )

export const recordPublication = (
  authority: WorkspaceAuthority,
  reference: PublicationReference
): void =>
  inTaskShard(authority, reference.taskId, db =>
    transaction(db, () => {
      if (reference.workspaceId !== undefined) {
        const workspace = getWorkspace(db, reference.workspaceId)
        if (workspace === undefined)
          return invalid(
            `Publication names workspace ${reference.workspaceId}, which does not belong to the task's repository`
          )
      }
      putPublication(db, reference)
    })
  )

export const recordRuleApproval = (authority: WorkspaceAuthority, approval: RuleApproval): void => {
  authority.initialize()
  if (!authority.listRepositories().some(repository => repository.id === approval.repositoryId))
    return invalid(
      `Repository ${approval.repositoryId} is not registered in the workspace authority`
    )
  inDb(authority, approval.repositoryId, db => transaction(db, () => putRuleApproval(db, approval)))
}
