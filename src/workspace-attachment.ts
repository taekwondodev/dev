import { realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import {
  inDb,
  findBinding,
  validateWorkspace,
  type WorkspaceAuthority,
} from './workspace-authority.ts'
import type { PendingTransition, ConversationState } from './workspace-conversation.ts'
import {
  blocked,
  invalid,
  requireReview,
  type WorkspaceConversation,
  type WorkspaceSelection,
} from './workspace-domain.ts'
import { acquirePathGates, acquireConversationPresence, releaseGates } from './workspace-gates.ts'
import { canonicalGitWorkspace, type GitWorkspace } from './workspace-git.ts'
import { canonicalPathSlot, isWithin, lstatIfExists } from './workspace-paths.ts'
import {
  sameIdentity,
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
  activeDependentUses,
  makeWorkspaceRecord,
  isActiveUse,
  type WorkspaceRecord,
  type BindingRecord,
  type UseRecord,
} from './workspace-records.ts'
import { now, hash, transaction } from './workspace-sqlite.ts'
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
  let sessionFile: string
  if (sessionInfo !== undefined) {
    if (!sessionInfo.isFile() || sessionInfo.isSymbolicLink() || sessionInfo.nlink !== 1)
      requireReview(`Conversation file is not a regular, uniquely linked file: ${sessionPath}`)
    sessionFile = realpathSync(sessionPath)
  } else sessionFile = resolve(realpathSync(dirname(sessionPath)), basename(sessionPath))
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
): { readonly state: ConversationState; readonly targetOperationId?: string } => {
  authority.initialize()
  if (!isAbsolute(input.cwd)) invalid('Workspace cwd must be absolute')
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
    let repoId: string
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
    } else {
      const git = canonicalGitWorkspace(input.cwd)
      repoId = authority.registerRepository(git)
      const workspace = registerWorkspace(authority, repoId, git, 'pre-existing')
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

const retireUnstartedTransition = (authority: WorkspaceAuthority, operationId: string): boolean => {
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
  repo: string,
  git: GitWorkspace,
  origin: 'pre-existing' | 'managed'
): WorkspaceRecord => {
  return inDb(
    authority,
    repo,
    db =>
      transaction(db, () => {
        const existing = getWorkspaceByPath(db, git.path)
        if (existing !== undefined) {
          assertWorkspaceMatches(existing, git)
          if (existing.status !== 'ready')
            requireReview(`Workspace allocation is unresolved: ${existing.path}`)
          return existing
        }
        const record = makeWorkspaceRecord(repo, git, origin)
        putWorkspace(db, record)
        return record
      }),
    true,
    git
  )
}

const assertWorkspaceMatches = (record: WorkspaceRecord, git: GitWorkspace): void => {
  if (
    record.path !== git.path ||
    !sameIdentity(record.physical, git.identity) ||
    record.gitAdminPath !== git.gitAdminPath ||
    !sameIdentity(record.gitAdmin, git.gitAdminIdentity) ||
    record.commonPath !== git.commonPath ||
    !sameIdentity(record.common, git.commonIdentity) ||
    record.objectFormat !== git.objectFormat
  )
    requireReview(`Workspace path slot was replaced: ${record.path}`)
}

const ensureNoUnresolvedUse = (
  authority: WorkspaceAuthority,
  repo: string,
  workspaceIdValue: string
): void => {
  const active = inDb(authority, repo, db => getUseRows(db, workspaceIdValue).filter(isActiveUse))
  if (active.length > 0)
    blocked(`Workspace has unresolved live-use facts and cannot be resumed: ${workspaceIdValue}`)
}

export const settleClosingState = (
  authority: WorkspaceAuthority,
  state: ConversationState,
  pending: PendingTransition | undefined
): void => {
  state.closing = true
  // Dependents first: a use is created after its `within` parent, so reverse insertion
  // order settles descendants before the parent whose gates they write under.
  for (const lease of [...state.leases.values()].toReversed()) {
    const preserveTarget = pending !== undefined && lease.useId === pending.targetLease.useId
    let use: UseRecord | undefined
    try {
      use = inDb(authority, lease.repositoryId, db => getUse(db, lease.useId))
    } catch {
      use = undefined
    }
    if (
      use !== undefined &&
      use.stage !== 'quiescent' &&
      use.stage !== 'unknown' &&
      !preserveTarget
    ) {
      let stage: UseRecord['stage'] = 'unknown'
      let reason = 'attachment-closed-without-authoritative-operation-cessation'
      if (use.stage === 'authorized') {
        stage = 'quiescent'
        reason = 'attachment-closed-before-operation-boundary'
      }
      // Close must not fail, so it cannot refuse the way a reported settlement does.
      // Instead it declines to claim quiescence it has not established: an unsettled
      // dependent leaves the parent `unknown`, which keeps its workspace blocked.
      if (stage === 'quiescent') {
        let dependents: UseRecord[] = []
        try {
          dependents = inDb(authority, lease.repositoryId, db => activeDependentUses(db, use.id))
        } catch {
          dependents = []
        }
        if (dependents.length > 0) {
          stage = 'unknown'
          reason = `attachment-closed-while-dependent-scoped-operations-were-live: ${dependents
            .map(dependent => dependent.id)
            .join(', ')}`
        }
      }
      try {
        inDb(authority, lease.repositoryId, db =>
          transaction(db, () =>
            saveUse(db, {
              ...use,
              stage,
              reason,
              revision: use.revision + 1,
              updatedAt: now(),
            })
          )
        )
      } catch {
        /* the durable earlier claim remains blocking */
      }
    }
    if (lease.gates !== undefined) {
      try {
        releaseGates(lease.gates)
      } finally {
        lease.gates = undefined
      }
    }
    if (!preserveTarget) lease.released = true
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
