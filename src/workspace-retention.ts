import { realpathSync } from 'node:fs'
import { type WorkspaceAuthority, inDb, taskWorkspaces } from './workspace-authority.ts'
import { conversationRecord } from './workspace-attachment.ts'
import type { WorkspaceConversation } from './workspace-domain.ts'
import { acquireConversationPresence, acquireConversationFileGate } from './workspace-gates.ts'
import { getAllBindings, getActiveUseRows, openOperations } from './workspace-records.ts'
import { holdConversationInventory } from './runtime-coordination.ts'

export const withDisposableConversation = <A>(
  authority: WorkspaceAuthority,
  conversation: WorkspaceConversation,
  admitted: () => A
): A | undefined => {
  const releaseInventory = holdConversationInventory(conversation.dataHome, 'removal', {
    namespacePath: authority.paths.root,
  })
  try {
    if (authority.inspectExisting() === undefined) return undefined
    const normalized = conversationRecord(conversation)
    const releaseFile = acquireConversationFileGate(
      authority.paths,
      normalized.conversation.sessionFile,
      true
    )
    try {
      const presence = acquireConversationPresence(authority.paths, normalized.identity)
      try {
        const home = realpathSync(conversation.dataHome)
        for (const repository of authority.listRepositories()) {
          const operations = inDb(authority, repository.id, db => openOperations(db))
          if (
            operations.some(
              operation =>
                operation.kind !== 'release' && operation.conversationKey === normalized.key
            )
          )
            return undefined
          const bindings = inDb(authority, repository.id, getAllBindings)
          for (const binding of bindings) {
            if (
              binding.conversation.sessionFile !== normalized.conversation.sessionFile &&
              !(
                binding.conversation.dataHome === home &&
                binding.conversation.sessionId === conversation.sessionId
              )
            )
              continue
            if (binding.pendingOperationId !== undefined) return undefined
            if (
              operations.some(
                operation =>
                  operation.workspaceId === binding.workspaceId ||
                  operation.taskId === binding.taskId
              )
            )
              return undefined
            if (
              binding.taskId !== undefined &&
              taskWorkspaces(authority, binding.taskId).length > 0
            )
              return undefined
            if (
              inDb(authority, repository.id, db => getActiveUseRows(db, binding.workspaceId))
                .length > 0
            )
              return undefined
          }
        }
        return admitted()
      } finally {
        presence.release()
      }
    } finally {
      releaseFile()
    }
  } finally {
    releaseInventory()
  }
}
