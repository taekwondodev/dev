import { type WorkspaceAuthority, inDb } from './workspace-authority.ts'
import { conversationRecord } from './workspace-attachment.ts'
import type { WorkspaceConversation } from './workspace-domain.ts'
import { acquireConversationPresence, acquireConversationFileGate } from './workspace-gates.ts'
import { getAllBindings, getActiveUseRows, openOperations } from './workspace-records.ts'
import { rows, textField } from './workspace-sqlite.ts'
import { holdConversationInventory } from './runtime-coordination.ts'

export type ConversationIdentity = ReturnType<typeof conversationRecord>

export interface RetentionFacts {
  readonly retains: (conversation: ConversationIdentity) => boolean
}

const sessionKey = (conversation: { dataHome: string; sessionId: string }): string =>
  `${conversation.dataHome}\0${conversation.sessionId}`

export const retentionFacts = (authority: WorkspaceAuthority): RetentionFacts => {
  const keys = new Set<string>()
  const files = new Set<string>()
  const sessions = new Set<string>()
  const reservedTasks = new Set<string>()
  const taskBound: { readonly taskId: string; readonly conversation: WorkspaceConversation }[] = []
  for (const repository of authority.listRepositories()) {
    inDb(authority, repository.id, db => {
      const operations = openOperations(db)
      for (const operation of operations)
        if (operation.kind !== 'release') keys.add(operation.conversationKey)
      for (const row of rows(db, 'SELECT DISTINCT task_id FROM reservations'))
        reservedTasks.add(textField(row, 'task_id'))
      for (const binding of getAllBindings(db)) {
        if (
          binding.pendingOperationId !== undefined ||
          operations.some(
            operation =>
              operation.workspaceId === binding.workspaceId || operation.taskId === binding.taskId
          ) ||
          getActiveUseRows(db, binding.workspaceId).length > 0
        ) {
          files.add(binding.conversation.sessionFile)
          sessions.add(sessionKey(binding.conversation))
        } else if (binding.taskId !== undefined)
          taskBound.push({ taskId: binding.taskId, conversation: binding.conversation })
      }
    })
  }
  for (const bound of taskBound) {
    if (!reservedTasks.has(bound.taskId)) continue
    files.add(bound.conversation.sessionFile)
    sessions.add(sessionKey(bound.conversation))
  }
  return {
    retains: conversation =>
      keys.has(conversation.key) ||
      files.has(conversation.conversation.sessionFile) ||
      sessions.has(sessionKey(conversation.conversation)),
  }
}

const holdConversationGates = <A>(
  authority: WorkspaceAuthority,
  conversation: ConversationIdentity,
  held: () => A
): A => {
  const releaseFile = acquireConversationFileGate(
    authority.paths,
    conversation.conversation.sessionFile,
    true
  )
  try {
    const presence = acquireConversationPresence(authority.paths, conversation.identity, 0)
    try {
      return held()
    } finally {
      presence.release()
    }
  } finally {
    releaseFile()
  }
}

export const conversationInUse = (
  authority: WorkspaceAuthority,
  conversation: ConversationIdentity
): boolean => {
  try {
    return holdConversationGates(authority, conversation, () => false)
  } catch {
    return true
  }
}

export const withDisposableConversation = <A>(
  authority: WorkspaceAuthority,
  conversation: WorkspaceConversation,
  admitted: () => A
): A | undefined => {
  const releaseInventory = holdConversationInventory(authority, conversation.dataHome, 'removal')
  try {
    const normalized = conversationRecord(conversation)
    return holdConversationGates(authority, normalized, () =>
      retentionFacts(authority).retains(normalized) ? undefined : admitted()
    )
  } finally {
    releaseInventory()
  }
}
