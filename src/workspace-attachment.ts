import { realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  inDb,
  findBinding,
  validateWorkspace,
  type WorkspaceAuthority,
} from './workspace-authority.ts'
import { settleDependentsFirst, type ConversationState } from './workspace-conversation.ts'
import {
  blocked,
  invalid,
  requireReview,
  type WorkspaceConversation,
  type WorkspaceId,
  type WorkspaceSelection,
} from './workspace-domain.ts'
import { acquirePathGates, acquireConversationPresence, releaseGates } from './workspace-gates.ts'
import { canonicalGitWorkspace, type GitWorkspace } from './workspace-git.ts'
import { canonicalPathSlot, canonicalSlot, isWithin } from './workspace-paths.ts'
import {
  matchesGitWorkspace,
  getWorkspace,
  getWorkspaceByPath,
  putWorkspace,
  getBinding,
  putBinding,
  getUse,
  saveUse,
  getOperation,
  saveOperation,
  getUseRows,
  makeWorkspaceRecord,
  isActiveUse,
  type WorkspaceRecord,
  type BindingRecord,
} from './workspace-records.ts'
import { transaction } from './workspace-sqlite.ts'
import { now, hash, lstatIfExists } from './workspace-platform.ts'
import { resolveSelection } from './workspace-transitions.ts'

const conversationRecord = (
  input: WorkspaceConversation
): {
  readonly conversation: WorkspaceConversation
  readonly key: string
  readonly identity: string
} => {
  const sessionPath = resolve(input.sessionFile)
  const sessionInfo = lstatIfExists(sessionPath)
  if (
    sessionInfo !== undefined &&
    (!sessionInfo.isFile() || sessionInfo.isSymbolicLink() || sessionInfo.nlink !== 1)
  )
    requireReview(`Conversation file is not a regular, uniquely linked file: ${sessionPath}`)
  const sessionFile = canonicalSlot(sessionPath, sessionInfo)
  const dataHome = realpathSync(resolve(input.dataHome))
  if (!statSync(dataHome).isDirectory())
    invalid(`Conversation data home is not a directory: ${dataHome}`)
  const conversation = { sessionId: input.sessionId, sessionFile, dataHome }
  return {
    conversation,
    key: hash(JSON.stringify(conversation)),
    identity: hash(JSON.stringify({ sessionId: conversation.sessionId, sessionFile })),
  }
}

export const attachConversation = (
  authority: WorkspaceAuthority,
  states: Map<string, ConversationState>,
  input: {
    conversation: WorkspaceConversation
    cwd: string
    selection?: WorkspaceSelection
  }
): { readonly state: ConversationState; readonly targetOperationId?: WorkspaceId } => {
  authority.initialize()
  const normalized = conversationRecord(input.conversation)
  const live = states.get(normalized.key)
  if (live !== undefined) {
    const pending = live.pending
    if (pending !== undefined) {
      const selected = input.selection
      const selectionMatches =
        selected === undefined ||
        (selected.taskId === pending.handoff.target.taskId &&
          selected.workspaceId === pending.handoff.target.workspaceId)
      if (selectionMatches && canonicalPathSlot(input.cwd) === pending.handoff.target.checkout)
        return { state: live, targetOperationId: pending.handoff.operationId }
      requireReview('A pending live workspace handoff can only reopen its exact destination')
    }
    if (input.selection !== undefined) {
      const selection = resolveSelection(authority, input.selection)
      if (
        selection.repo === live.repositoryId &&
        selection.workspace.id === live.binding.workspaceId &&
        selection.reservation.taskId === live.binding.taskId
      )
        return { state: live }
      requireReview('A live attachment cannot be moved without its host handoff')
    }
    return { state: live }
  }

  const presence = acquireConversationPresence(authority.paths, normalized.identity)
  try {
    let previous = findBinding(authority, normalized.key)
    const pendingOperationId = previous?.binding.pendingOperationId
    if (previous !== undefined && pendingOperationId !== undefined) {
      if (!retireUnstartedTransition(authority, pendingOperationId))
        requireReview(
          `The last workspace switch of this conversation (${pendingOperationId}) may have reached the host, so it cannot be resumed until explicit recovery exists; its history is unchanged`
        )
      const { repo } = previous
      const kept = inDb(authority, repo, db =>
        transaction(db, () => {
          const current = getBinding(db, normalized.key)
          if (current === undefined || current.pendingOperationId !== pendingOperationId)
            requireReview('Conversation binding changed while its unstarted switch was withdrawn')
          const withdrawn = { ...current, pendingOperationId: undefined }
          putBinding(db, withdrawn)
          return withdrawn
        })
      )
      previous = { repo, binding: kept }
    }
    let repoId: WorkspaceId
    let binding: BindingRecord
    if (input.selection !== undefined) {
      const selected = resolveSelection(authority, input.selection)
      validateWorkspace(authority, selected.workspace)
      ensureNoUnresolvedUse(authority, selected.repo, selected.workspace.id)
      const probe = acquirePathGates(authority.paths, selected.workspace.path, true)
      releaseGates(probe)
      binding = {
        key: normalized.key,
        conversation: normalized.conversation,
        taskId: selected.reservation.taskId,
        workspaceId: selected.workspace.id,
        cwd: selected.workspace.path,
        revision: (previous?.binding.revision ?? -1) + 1,
      }
      if (previous === undefined) {
        inDb(authority, selected.repo, db => transaction(db, () => putBinding(db, binding)))
      } else if (previous.repo === selected.repo) {
        inDb(authority, selected.repo, db =>
          transaction(db, () => {
            const current = getBinding(db, normalized.key)
            if (current === undefined || current.revision !== previous.binding.revision)
              requireReview('Conversation binding changed during explicit recovery')
            putBinding(db, binding)
          })
        )
      } else {
        inDb(authority, previous.repo, db =>
          transaction(db, () => {
            const current = getBinding(db, normalized.key)
            if (current === undefined || current.revision !== previous.binding.revision)
              requireReview('Conversation binding changed during explicit recovery')
            putBinding(db, { ...current, superseded: true, pendingOperationId: undefined })
          })
        )
        inDb(authority, selected.repo, db => transaction(db, () => putBinding(db, binding)))
      }
      repoId = selected.repo
    } else if (previous !== undefined) {
      repoId = previous.repo
      binding = previous.binding
      const workspace = inDb(authority, repoId, db => getWorkspace(db, binding.workspaceId))
      if (workspace === undefined)
        requireReview(`Confirmed conversation workspace is missing: ${binding.workspaceId}`)
      if (lstatIfExists(workspace.path) === undefined)
        requireReview(
          `The workspace bound to this conversation no longer exists and is not recreated: ${workspace.path}`
        )
      validateWorkspace(authority, workspace)
      if (lstatIfExists(binding.cwd)?.isDirectory() !== true)
        requireReview(
          `The working directory bound to this conversation no longer exists and is not recreated: ${binding.cwd}`
        )
    } else {
      const git = canonicalGitWorkspace(input.cwd)
      repoId = authority.registerRepository(git)
      const workspace = registerWorkspace(authority, repoId, git)
      const actualCwd = realpathSync(resolve(input.cwd))
      if (!isWithin(workspace.path, actualCwd))
        invalid(`Conversation cwd is outside its Git checkout: ${input.cwd}`)
      binding = {
        key: normalized.key,
        conversation: normalized.conversation,
        workspaceId: workspace.id,
        cwd: actualCwd,
        revision: 0,
      }
      inDb(authority, repoId, db => transaction(db, () => putBinding(db, binding)))
    }
    const state: ConversationState = {
      key: normalized.key,
      conversation: normalized.conversation,
      binding,
      repositoryId: repoId,
      leases: new Map(),
      leaseAttachments: new Map(),
      extraGates: [],
      refs: 0,
      parked: false,
      closing: false,
      incarnation: presence.incarnation,
      releaseConversation: presence.release,
    }
    states.set(normalized.key, state)
    return { state }
  } catch (cause) {
    presence.release()
    throw cause
  }
}

const retireUnstartedTransition = (
  authority: WorkspaceAuthority,
  operationId: WorkspaceId
): boolean => {
  let withdrawn = false
  for (const repository of authority.listRepositories()) {
    inDb(authority, repository.id, db =>
      transaction(db, () => {
        const operation = getOperation(db, operationId)
        if (operation?.phase === 'cancelled') withdrawn = true
        if (operation === undefined || operation.phase !== 'intent') return
        withdrawn = true
        for (const use of getUseRows(db, operation.workspaceId))
          if (
            use.acquisitionId === operation.acquisitionId &&
            use.execution === undefined &&
            use.effect === undefined &&
            use.stage === 'authorized'
          )
            saveUse(db, {
              ...use,
              stage: 'quiescent',
              reason: 'superseded-by-explicit-recovery-before-host-transition',
              revision: use.revision + 1,
              updatedAt: now(),
            })
        saveOperation(db, {
          ...operation,
          phase: 'cancelled',
          result: 'Superseded by an explicit recovery selection before the host acted.',
        })
      })
    )
  }
  return withdrawn
}

const registerWorkspace = (
  authority: WorkspaceAuthority,
  repo: WorkspaceId,
  git: GitWorkspace
): WorkspaceRecord => {
  return inDb(
    authority,
    repo,
    db =>
      transaction(db, () => {
        const existing = getWorkspaceByPath(db, git.path)
        if (existing !== undefined) {
          if (!matchesGitWorkspace(existing, git))
            requireReview(`Workspace path slot was replaced: ${existing.path}`)
          if (existing.status !== 'ready')
            requireReview(`Workspace allocation is unresolved: ${existing.path}`)
          return existing
        }
        const record = makeWorkspaceRecord(repo, git, 'pre-existing')
        putWorkspace(db, record)
        return record
      }),
    true,
    git
  )
}

const ensureNoUnresolvedUse = (
  authority: WorkspaceAuthority,
  repo: WorkspaceId,
  workspaceIdValue: WorkspaceId
): void => {
  const active = inDb(authority, repo, db => getUseRows(db, workspaceIdValue).filter(isActiveUse))
  if (active.length > 0)
    blocked(`Workspace has unresolved live-use facts and cannot be resumed: ${workspaceIdValue}`)
}

export const settleClosingState = (
  authority: WorkspaceAuthority,
  state: ConversationState
): void => {
  state.closing = true
  const preserved = state.pending?.targetLease.useId
  const leases = [...state.leases.values()]
  const closing = leases.flatMap(lease => {
    if (lease.useId === preserved) return []
    try {
      const use = inDb(authority, lease.repositoryId, db => getUse(db, lease.useId))
      return use === undefined ? [] : [{ lease, use }]
    } catch {
      return []
    }
  })
  // Close must not fail, so it cannot refuse the way a reported settlement does. Instead it
  // declines to claim quiescence it has not established, keeping the workspace blocked.
  settleDependentsFirst(
    authority,
    closing,
    use =>
      use.stage === 'authorized'
        ? { stage: 'quiescent', reason: 'attachment-closed-before-operation-boundary' }
        : {
            stage: 'unknown',
            reason: 'attachment-closed-without-authoritative-operation-cessation',
          },
    'attachment-closed-while-dependent-scoped-operations-were-live',
    () => {
      /* the durable earlier claim remains blocking */
    }
  )
  for (const lease of leases.toReversed()) {
    if (lease.gates !== undefined) {
      try {
        releaseGates(lease.gates)
      } finally {
        lease.gates = undefined
      }
    }
    if (lease.useId !== preserved) lease.released = true
  }
  for (const held of state.extraGates.splice(0)) {
    try {
      releaseGates(held.gates)
    } catch {
      /* retain persisted use rows */
    }
  }
  state.closing = false
}
