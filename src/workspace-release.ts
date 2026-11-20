import {
  checkoutUseStage,
  executionLabel,
  pendingStage,
  releaseOnceStopped,
} from './workspace-labels.ts'
import { lstatSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { basename, dirname, join, resolve } from 'node:path'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import {
  inDb,
  taskWorkspaces,
  validateWorkspace,
  type WorkspaceAuthority,
} from './workspace-authority.ts'
import { validateGrant } from './workspace-admission.ts'
import { forgetPrunedLease, type AttachmentHandle } from './workspace-conversation.ts'
import {
  decideCompletion,
  integrationUnknown,
  CLEAR,
  DO_NOT_RETRY,
  needsIntegration,
  RETAINED,
  roleOf,
  type CompletionFacts,
  type IntegrationFacts,
  type Residue,
} from './workspace-completion.ts'
import {
  blocked,
  invalid,
  requireReview,
  WorkspaceError,
  WorkspaceId,
  type AllocationReason,
  type CompletionVerdict,
  type OrbPresenceRequest,
  type OrbPresenceSettlement,
  type ClosingSweepMoment,
  type SweepMoment,
  type SweepOutcome,
  type SweepReceipt,
  type SweepRow,
  type TargetView,
  type TaskArtifactsResult,
  type TaskTarget,
  type WorkspaceAssessment,
  type WorkspaceGrant,
  type WorkspaceReleaseResult,
  WORKER_REQUEST_TIMEOUT_MS,
} from './workspace-domain.ts'
import { taskArtifactsPath } from './workspace-authority-root.ts'
import {
  deriveTarget,
  describeTarget,
  recordedTarget,
  integrationFacts,
  readInventory,
  verifyInventory,
  type GitHubReader,
  type Inventory,
  type InventoryVerdict,
  type Siblings,
} from './workspace-evidence.ts'
import {
  acquirePathGates,
  acquireStructureGate,
  conversationIdentity,
  conversationPresent,
  incarnationHeld,
  releaseGates,
  type GateRelease,
  type PathGates,
} from './workspace-gates.ts'
import {
  ancestry,
  canonicalGitWorkspace,
  registeredWorktrees,
  removeWorktree,
  symbolicBranch,
  type GitWorkspace,
  type GitResult,
} from './workspace-git.ts'
import { abandonedUseIds, checkoutMissing, sampledPaths } from './workspace-inspect.ts'
import { isWithin } from './workspace-paths.ts'
import {
  confirmedReleases,
  deleteReservation,
  deleteUses,
  forgetReservation,
  getBindingRows,
  getOperation,
  getPublications,
  getReservation,
  getTask,
  getUse,
  getUseRows,
  getWorkspace,
  getWorkspaceByPath,
  isUnresolvedRelease,
  isActiveUse,
  openOperations,
  putOperation,
  saveOperation,
  saveWorkspace,
  startedRelease,
  unfinishedAllocations,
  unresolvedReleases,
  type AllocationOperationRecord,
  type ReleaseOperationRecord,
  type ReservationRecord,
  type UseRecord,
  type WorkspaceRecord,
} from './workspace-records.ts'
import { errorText } from './error-text.ts'
import { holdExistingInstallationForRemoval } from './runtime-coordination.ts'
import { rows, textField, transaction } from './workspace-sqlite.ts'
import { hash, hasErrorCode, lstatIfExists, now } from './workspace-platform.ts'

export interface EvidenceReaders {
  readonly github: GitHubReader
}

const short = (sha: string | undefined): string => (sha === undefined ? '(none)' : sha.slice(0, 12))

type Absence = 'present' | 'absent' | { readonly inaccessible: string }

const observeAbsence = (path: string, anchor: string = dirname(path)): Absence => {
  try {
    lstatSync(path)
    return 'present'
  } catch (cause) {
    if (!hasErrorCode(cause, 'ENOENT')) return { inaccessible: errorText(cause) }
  }
  try {
    if (!lstatSync(anchor).isDirectory()) return { inaccessible: `${anchor} is not a directory` }
    return 'absent'
  } catch (cause) {
    if (hasErrorCode(cause, 'ENOENT') && dirname(anchor) !== anchor) {
      const parent = observeAbsence(anchor)
      if (parent === 'absent') return parent
    }
    return { inaccessible: `anchor directory ${anchor}: ${errorText(cause)}` }
  }
}

const absenceText = (what: string, absence: Absence): string => {
  if (absence === 'present') return `${what} present`
  if (absence === 'absent') return `${what} absent`
  return `${what} inaccessible (${absence.inaccessible})`
}
type Worktree = Pick<WorkspaceRecord, 'path' | 'commonPath' | 'repositoryId'> & {
  readonly gitAdminPath: string | undefined
}

const adminServesAnotherWorktree = (workspace: Worktree): boolean => {
  if (workspace.gitAdminPath === undefined) return false
  try {
    const gitdir = readFileSync(join(workspace.gitAdminPath, 'gitdir'), 'utf8').trim()
    return gitdir.length > 0 && dirname(gitdir) !== workspace.path
  } catch {
    return false
  }
}
const listed = (workspace: Worktree): boolean | undefined => {
  try {
    return registeredWorktrees(workspace.commonPath).includes(workspace.path)
  } catch {
    return undefined
  }
}

interface RemovalObservation {
  readonly complete: boolean
  readonly text: string
}
const observeRemoval = (workspace: Worktree): RemovalObservation => {
  const directory = observeAbsence(workspace.path)
  const admin =
    workspace.gitAdminPath === undefined
      ? 'absent'
      : observeAbsence(workspace.gitAdminPath, workspace.commonPath)
  const registered = listed(workspace)
  let registrationText = 'worktree not registered'
  if (registered === undefined) registrationText = 'worktree registration unreadable'
  else if (registered) registrationText = 'worktree still registered'
  return {
    complete:
      directory === 'absent' &&
      registered === false &&
      (admin === 'absent' || adminServesAnotherWorktree(workspace)),
    text: [
      absenceText('directory', directory),
      workspace.gitAdminPath === undefined
        ? 'no admin directory linked'
        : absenceText(`admin directory ${workspace.gitAdminPath}`, admin),
      registrationText,
    ].join('; '),
  }
}

type Identity =
  | { readonly kind: 'verified'; readonly git: GitWorkspace }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unverifiable'; readonly reason: string }

const assessIdentity = (authority: WorkspaceAuthority, workspace: WorkspaceRecord): Identity => {
  try {
    return { kind: 'verified', git: validateWorkspace(authority, workspace) }
  } catch (cause) {
    if (workspace.origin !== 'managed') return { kind: 'unverifiable', reason: errorText(cause) }
    const observed = observeAbsence(workspace.path)
    if (observed === 'absent') return { kind: 'absent' }
    if (observed === 'present') return { kind: 'unverifiable', reason: errorText(cause) }
    return {
      kind: 'unverifiable',
      reason: `Checkout directory is inaccessible (${observed.inaccessible}): ${workspace.path}`,
    }
  }
}

interface UseAssessment {
  readonly live: readonly UseRecord[]
  readonly conversations: number
  readonly unknown: readonly UseRecord[]
  readonly abandoned: readonly WorkspaceId[]
  readonly inUse: boolean
  readonly reasons: readonly string[]
  readonly nextActions: readonly string[]
}
const describeUse = (use: UseRecord): string =>
  `${use.access}/${checkoutUseStage(use.stage)}${use.execution === undefined ? '' : `, ${executionLabel(use.execution)}`}`

const assessUses = (
  authority: WorkspaceAuthority,
  db: DatabaseSync,
  workspaceId: WorkspaceId,
  own: OwnConversation | undefined,
  taskId: string | undefined
): UseAssessment => {
  const uses = getUseRows(db, workspaceId)
  const unknown = uses.filter(use => use.stage === 'unknown')
  const ownUses = uses.filter(
    use =>
      own !== undefined &&
      use.incarnation === own.incarnation &&
      isActiveUse(use) &&
      use.stage !== 'unknown'
  )
  const owned = new Set(ownUses)
  const live = uses.filter(use => isActiveUse(use) && !owned.has(use))
  const bindings = getBindingRows(db, workspaceId).filter(binding => binding.superseded !== true)
  const ownBound = bindings.some(binding => binding.key === own?.conversationKey)
  const conversations = bindings.filter(
    binding =>
      binding.key !== own?.conversationKey &&
      conversationPresent(authority.paths, conversationIdentity(binding.conversation))
  )
  const abandoned = abandonedUseIds(authority, db, uses)
  const reasons: string[] = []
  const nextActions: string[] = []
  if (ownUses.length > 0 || ownBound)
    reasons.push(
      ownUses.length > 0
        ? `This conversation uses this checkout (${ownUses.map(describeUse).join(', ')}). Dev checks again at quit.`
        : 'This conversation uses this checkout until quit, when dev checks again.'
    )
  const unknownIds = new Set(unknown.map(use => use.id))
  const abandonedOnly = abandoned.filter(id => !unknownIds.has(id))
  if (unknown.length > 0)
    reasons.push(
      `Dev cannot confirm operations ${[...unknownIds].join(', ')} stopped, so it kept the checkout.`
    )
  if (abandonedOnly.length > 0)
    reasons.push(
      `Operations ${abandonedOnly.join(', ')} of closed dev sessions may still be running.`
    )
  if (unknown.length > 0 || abandonedOnly.length > 0)
    nextActions.push(`Do not retry those operations. ${releaseOnceStopped(taskId)}`)
  else if (live.length > 0 || conversations.length > 0) {
    if (live.length > 0)
      reasons.push(
        `Other dev sessions still use this checkout: ${live
          .map(use => `${use.id} (${describeUse(use)})`)
          .join(', ')}`
      )
    if (conversations.length > 0)
      reasons.push(
        `${conversations.length} open conversations use this checkout: ${conversations
          .map(binding => binding.conversation.sessionId)
          .join(', ')}`
      )
    nextActions.push('Finish or stop that work, then close its conversation before cleanup.')
  }
  return {
    live,
    conversations: conversations.length,
    unknown,
    abandoned,
    inUse:
      unknown.length > 0 || abandoned.length > 0 || live.length > 0 || conversations.length > 0,
    reasons,
    nextActions,
  }
}

const residualOf = (inventory: Inventory | undefined, head: string | undefined): string[] => {
  const residual: string[] = []
  if (head !== undefined) residual.push(`HEAD ${short(head)}`)
  if (inventory === undefined) return residual
  if (inventory.tracked.length > 0)
    residual.push(
      `${inventory.tracked.length} modified, staged or conflicted tracked file(s): ${sampledPaths(
        inventory.tracked.map(change => change.path)
      )}`
    )
  if (inventory.files.length > 0)
    residual.push(
      `${inventory.untracked.length} untracked and ${inventory.ignored} ignored path(s) remain in place`
    )
  return residual
}
const residueOf = (
  inventory: Inventory,
  unpublished: number = inventory.untracked.length
): Residue => ({
  tracked: inventory.tracked.length,
  untracked: inventory.untracked.length,
  unpublished,
})

interface Assessed {
  readonly assessment: WorkspaceAssessment
  readonly reservation: ReservationRecord
  readonly workspace: WorkspaceRecord
  readonly head: string | undefined
  readonly blockers: readonly string[]
}
interface Shaping {
  readonly reasons: readonly string[]
  readonly nextActions: readonly string[]
  readonly completion?: CompletionVerdict
  readonly target?: TargetView
  readonly evidence?: InventoryVerdict
  readonly residual?: readonly string[]
}

export interface OwnConversation {
  readonly incarnation: WorkspaceId
  readonly conversationKey: string
}
interface AssessmentContext {
  readonly moment: SweepMoment
  readonly own?: OwnConversation
  readonly excluded?: ReadonlySet<WorkspaceId>
  readonly sweptSiblings?: Map<WorkspaceId, SiblingsOf>
}
const AT_QUIT: AssessmentContext = { moment: 'quit' }

const allocationOf = (
  db: DatabaseSync,
  workspace: WorkspaceRecord
): {
  readonly base?: string
  readonly reason?: AllocationReason
  readonly allocatedAt?: number
} => {
  if (workspace.allocationOperationId === undefined) return {}
  const operation = getOperation(db, workspace.allocationOperationId)
  if (operation?.kind !== 'allocation') return {}
  const { reason, sourceCommit, createdAt } = operation
  return {
    reason,
    allocatedAt: createdAt,
    ...(sourceCommit === undefined ? {} : { base: sourceCommit }),
  }
}

const ownCommitsOf = (
  checkout: string,
  head: string | undefined,
  base: string | undefined
): boolean | undefined => {
  if (head === undefined || base === undefined) return undefined
  const result = ancestry(checkout, head, base)
  return typeof result === 'string' ? result === 'not-ancestor' : undefined
}

const retainedActions = (verdict: CompletionVerdict): readonly string[] =>
  verdict.kind === 'finished' ? [] : RETAINED[verdict.retained].actions

interface Staged {
  readonly integrate: () => Assessed
}
const isStaged = (value: Assessed | Staged): value is Staged => 'integrate' in value

const transitionName = (operation: { readonly kind: string }): string =>
  operation.kind === 'allocation' ? 'Worktree creation' : 'Checkout switch'

const stageWorkspace = (
  authority: WorkspaceAuthority,
  db: DatabaseSync,
  repo: WorkspaceId,
  reservation: ReservationRecord,
  workspace: WorkspaceRecord,
  readers: EvidenceReaders,
  context: AssessmentContext,
  siblings: Siblings
): Assessed | Staged => {
  const identity = assessIdentity(authority, workspace)
  const head =
    identity.kind === 'verified' && identity.git.head.length > 0 ? identity.git.head : undefined
  const open = openOperations(db, workspace.id)
  const unresolvedTransitions = open.filter(
    operation => operation.kind !== 'release' && operation.phase !== 'intent'
  )
  const unfinishedReleases = open.filter(isUnresolvedRelease)
  const preface = [
    ...open
      .filter(operation => operation.kind !== 'release' && operation.phase === 'intent')
      .map(
        operation =>
          `${transitionName(operation)} ${operation.id} never started. Cleanup will not run it.`
      ),
    ...unfinishedReleases.map(
      operation =>
        `Release ${operation.id} did not finish (${pendingStage(operation.phase)})${operation.result === undefined ? '' : `: ${operation.result}`}.`
    ),
  ]
  const allocation = allocationOf(db, workspace)
  const uses = assessUses(authority, db, workspace.id, context.own, reservation?.taskId)
  const unknownIds = new Set(uses.unknown.map(use => use.id))
  const abandoned = uses.abandoned.filter(id => !unknownIds.has(id))
  const factsBase: CompletionFacts = {
    moment: context.moment,
    origin: workspace.origin,
    allocation: allocation.reason,
    identity: identity.kind,
    transitionUnresolved: unresolvedTransitions.length > 0,
    releaseReview: unfinishedReleases.length > 0,
    excluded: context.excluded?.has(workspace.id) === true,
    uses: {
      unknown: uses.unknown.length,
      abandoned: abandoned.length,
      live: uses.live.filter(use => !unknownIds.has(use.id) && !abandoned.includes(use.id)).length,
      conversations: uses.conversations,
    },
    attemptsQuiescent: !uses.live.some(use => use.execution !== undefined),
    branch: undefined,
    residue: undefined,
    ownCommits: undefined,
    integration: integrationUnknown('Integration was not assessed.'),
  }
  const unassessedTarget: TargetView =
    workspace.origin === 'pre-existing'
      ? {
          source: 'not-needed',
          description: 'Pre-existing checkouts need no destination branch.',
        }
      : {
          source: 'not-assessed',
          description: 'Dev did not check the destination branch.',
        }
  const shape = (shaping: Shaping, blockers: readonly string[] = []): Assessed => ({
    assessment: {
      repositoryId: repo,
      taskId: reservation.taskId,
      workspaceId: workspace.id,
      reservationId: reservation.id,
      path: workspace.path,
      origin: workspace.origin,
      reasons: [...preface, ...shaping.reasons],
      nextActions: [...shaping.nextActions],
      ...(shaping.evidence === undefined
        ? {}
        : {
            evidence: {
              verdict: shaping.evidence.verdict,
              reasons: shaping.evidence.reasons,
            },
            inventory: shaping.evidence.counts,
          }),
      residual: [...(shaping.residual ?? [])],
      target: shaping.target ?? unassessedTarget,
      completion: shaping.completion ?? decideCompletion(factsBase),
    },
    reservation,
    workspace,
    head,
    blockers,
  })
  const unfinished = unresolvedTransitions.map(
    operation =>
      `${transitionName(operation)} ${operation.id} may be unfinished${operation.result === undefined ? '' : `: ${operation.result}`}`
  )
  const doNotRetry = unfinished.length > 0 ? [DO_NOT_RETRY] : []
  if (identity.kind === 'unverifiable')
    return shape({
      reasons: [identity.reason, ...unfinished, ...uses.reasons],
      nextActions: [...doNotRetry, CLEAR],
    })
  if (unfinished.length > 0)
    return shape({
      reasons: [...unfinished, ...uses.reasons],
      nextActions: [...doNotRetry, CLEAR],
    })
  if (identity.kind === 'absent')
    return shape({
      reasons: [`The managed worktree directory is absent: ${workspace.path}`, ...uses.reasons],
      nextActions: [CLEAR],
    })
  if (workspace.origin === 'pre-existing') {
    let inventory: Inventory | undefined
    const reasons = [...uses.reasons]
    try {
      inventory = readInventory(workspace.path, head)
    } catch (cause) {
      reasons.push(`Could not read checkout changes: ${errorText(cause)}`)
    }
    const completion = decideCompletion({
      ...factsBase,
      ...(inventory === undefined ? {} : { residue: residueOf(inventory) }),
    })
    const residual = residualOf(inventory, head)
    if (uses.inUse)
      return shape({
        reasons,
        nextActions: uses.nextActions,
        residual,
        completion,
      })
    return shape({
      reasons: [
        ...reasons,
        'Releasing a pre-existing checkout keeps its files and commits untouched.',
        completion.reason,
      ],
      nextActions:
        completion.kind === 'finished'
          ? ['At quit, dev frees this checkout for other work; files and commits stay.']
          : retainedActions(completion),
      residual,
      completion,
    })
  }
  let evidence: InventoryVerdict
  let branch: string | undefined
  let ownCommits: boolean | undefined
  const publications = getPublications(db, reservation.taskId).filter(
    reference =>
      reference.root === 'workspace' &&
      (reference.workspaceId === undefined || reference.workspaceId === workspace.id)
  )
  const override = getTask(db, reservation.taskId)?.target
  try {
    branch = symbolicBranch(workspace.path)
    ownCommits = ownCommitsOf(workspace.path, head, allocation.base)
    evidence = verifyInventory(workspace.path, publications, readInventory(workspace.path, head))
  } catch (cause) {
    return shape({
      reasons: [...uses.reasons, `Evidence could not be read: ${errorText(cause)}`],
      nextActions: ['Fix the reported read failure and check again.', CLEAR],
    })
  }
  const residue = residueOf(evidence.inventory, evidence.unpublished)
  const complete = (): Assessed => {
    let target: TargetView =
      recordedTarget(workspace.path, override, branch) ??
      (uses.inUse
        ? {
            source: 'not-assessed',
            description: 'Dev checks the destination branch once the checkout is idle.',
          }
        : {
            source: 'not-needed',
            description: 'No changes or commits to land; no destination needed.',
          })
    let integration: IntegrationFacts = integrationUnknown('Integration is not needed here.')
    if (!uses.inUse && needsIntegration(residue, ownCommits)) {
      const derived = deriveTarget(readers.github, workspace.path, override, branch)
      target = describeTarget(derived)
      if (derived.source === 'none') integration = integrationUnknown(derived.reason)
      else
        try {
          integration = integrationFacts(readers.github, workspace.path, {
            target: derived.target,
            completionRole: roleOf({
              origin: workspace.origin,
              branch,
              allocation: allocation.reason,
            }),
            head,
            base: allocation.base,
            allocatedAt: allocation.allocatedAt,
            siblings,
          })
        } catch (cause) {
          integration = integrationUnknown(`Integration could not be read: ${errorText(cause)}`)
        }
    }
    const completion = decideCompletion({
      ...factsBase,
      branch,
      residue,
      ownCommits,
      integration,
    })
    const common = {
      evidence,
      residual: residualOf(evidence.inventory, head),
      completion,
      target,
    }
    if (uses.inUse)
      return shape({
        ...common,
        reasons: uses.reasons,
        nextActions: uses.nextActions,
      })
    if (evidence.verdict !== 'valid')
      return shape(
        {
          ...common,
          reasons: [...uses.reasons, ...evidence.reasons, completion.reason],
          nextActions: [
            evidence.verdict === 'invalid'
              ? 'Resolve each blocker (publish the selected artifact again, resolve the conflict or remove the nested repository), then check again.'
              : 'Fix unreadable or unsupported files, then check again. Dev will not delete what it cannot inspect.',
            CLEAR,
          ],
        },
        evidence.reasons
      )
    if (completion.kind === 'finished')
      return shape({
        ...common,
        reasons: [
          ...uses.reasons,
          completion.reason,
          'Eligible for cleanup; nothing removed. Dev checks again before removal.',
        ],
        nextActions: ['Dev checks again at quit or before making another worktree.'],
      })
    return shape({
      ...common,
      reasons: [...uses.reasons, completion.reason],
      nextActions: retainedActions(completion),
    })
  }
  return { integrate: complete }
}

const assessWorkspace = (...input: Parameters<typeof stageWorkspace>): Assessed => {
  const staged = stageWorkspace(...input)
  return isStaged(staged) ? staged.integrate() : staged
}

type Sibling =
  | { readonly kind: 'seed'; readonly head: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'unknown'; readonly reason: string }
const NO_SIBLING: Sibling = { kind: 'none' }

const siblingAt = (db: DatabaseSync, workspace: WorkspaceRecord, head: string): Sibling => {
  const own = ownCommitsOf(workspace.commonPath, head, allocationOf(db, workspace).base)
  if (own === undefined)
    return {
      kind: 'unknown',
      reason: `Dev could not verify new commits in checkout ${workspace.id}, so it did not search its PRs.`,
    }
  return own ? { kind: 'seed', head } : NO_SIBLING
}
const liveSibling = (
  authority: WorkspaceAuthority,
  db: DatabaseSync,
  workspace: WorkspaceRecord
): Sibling => {
  if (workspace.origin !== 'managed') return NO_SIBLING
  let validated: ReturnType<typeof validateWorkspace>
  try {
    validated = validateWorkspace(authority, workspace)
  } catch (cause) {
    return {
      kind: 'unknown',
      reason: `Could not read HEAD of checkout ${workspace.id}; dev skipped its PRs: ${errorText(cause)}`,
    }
  }
  const { head } = validated
  return head.length > 0 ? siblingAt(db, workspace, head) : NO_SIBLING
}
const removedSiblings = (authority: WorkspaceAuthority, taskId: WorkspaceId): readonly Sibling[] =>
  authority.listRepositories().flatMap(repository =>
    inDb(authority, repository.id, db =>
      confirmedReleases(db, taskId).flatMap(operation => {
        if (operation.effect !== 'remove-worktree' || operation.head === undefined) return []
        const workspace = getWorkspace(db, operation.workspaceId)
        return workspace?.origin === 'managed' ? [siblingAt(db, workspace, operation.head)] : []
      })
    )
  )
type SiblingsOf = (workspaceId: WorkspaceId) => Siblings
const taskSiblings = (
  authority: WorkspaceAuthority,
  taskId: WorkspaceId,
  entries: () => ReturnType<typeof taskWorkspaces>,
  context: AssessmentContext
): SiblingsOf => {
  const swept = context.sweptSiblings?.get(taskId)
  if (swept !== undefined) return swept
  const siblingsOf = readTaskSiblings(authority, taskId, entries())
  context.sweptSiblings?.set(taskId, siblingsOf)
  return siblingsOf
}
const readTaskSiblings = (
  authority: WorkspaceAuthority,
  taskId: WorkspaceId,
  entries: ReturnType<typeof taskWorkspaces>
): SiblingsOf => {
  const live = entries.map(({ repo, workspace }) => ({
    id: workspace.id,
    sibling: inDb(authority, repo, db => liveSibling(authority, db, workspace)),
  }))
  const removed = removedSiblings(authority, taskId)
  return workspaceId => {
    const siblings = [
      ...live.filter(({ id }) => id !== workspaceId).map(({ sibling }) => sibling),
      ...removed,
    ]
    return {
      heads: [
        ...new Set(siblings.flatMap(sibling => (sibling.kind === 'seed' ? [sibling.head] : []))),
      ],
      unknown: siblings.flatMap(sibling => (sibling.kind === 'unknown' ? [sibling.reason] : [])),
    }
  }
}

const assessTask = (
  authority: WorkspaceAuthority,
  taskId: WorkspaceId,
  readers: EvidenceReaders,
  context: AssessmentContext
): readonly Assessed[] => {
  const entries = taskWorkspaces(authority, taskId)
  const siblingsFor = taskSiblings(authority, taskId, () => entries, context)
  return entries.map(({ repo, reservation, workspace }) =>
    inDb(authority, repo, db =>
      assessWorkspace(
        authority,
        db,
        repo,
        reservation,
        workspace,
        readers,
        context,
        siblingsFor(workspace.id)
      )
    )
  )
}

const prefetchEvidence = (
  readers: EvidenceReaders,
  target: TaskTarget | undefined
): Promise<unknown> => {
  const { github } = readers
  if (
    target?.kind !== 'github' ||
    target.pullRequest === undefined ||
    github.prefetchPullRequestEvidence === undefined
  )
    return Promise.resolve()
  try {
    return github
      .prefetchPullRequestEvidence(target.repository, target.ref, target.pullRequest)
      .catch(() => undefined)
  } catch {
    return Promise.resolve()
  }
}

const assessTaskAtClose = (
  authority: WorkspaceAuthority,
  taskId: WorkspaceId,
  readers: EvidenceReaders,
  context: AssessmentContext
): Promise<readonly Assessed[]> => {
  const entries = taskWorkspaces(authority, taskId)
  const siblingsFor = taskSiblings(authority, taskId, () => entries, context)
  return Promise.all(
    entries.map(async ({ repo, reservation, workspace }) => {
      const { evidence, staged } = inDb(authority, repo, db => ({
        evidence: prefetchEvidence(readers, getTask(db, reservation.taskId)?.target),
        staged: stageWorkspace(
          authority,
          db,
          repo,
          reservation,
          workspace,
          readers,
          context,
          siblingsFor(workspace.id)
        ),
      }))
      if (!isStaged(staged)) return staged
      await evidence
      return staged.integrate()
    })
  )
}

export const checkTask = (
  authority: WorkspaceAuthority,
  taskId: WorkspaceId,
  readers: EvidenceReaders,
  own?: OwnConversation
): readonly WorkspaceAssessment[] => {
  if (authority.inspectExisting() === undefined) return []
  return assessTask(authority, taskId, readers, {
    ...AT_QUIT,
    ...(own === undefined ? {} : { own }),
  }).map(({ assessment }) => assessment)
}

const save = (
  authority: WorkspaceAuthority,
  repo: WorkspaceId,
  operation: ReleaseOperationRecord | AllocationOperationRecord
): void => inDb(authority, repo, db => transaction(db, () => saveOperation(db, operation)))

const markRemoved = (
  db: DatabaseSync,
  workspace: WorkspaceRecord,
  operation: ReleaseOperationRecord
): void => {
  const stored = getWorkspace(db, workspace.id)
  if (stored === undefined)
    requireReview(`Checkout record disappeared while it was being removed: ${workspace.id}`)
  saveWorkspace(db, {
    ...stored,
    status: 'removed',
    removalOperationId: operation.id,
    revision: stored.revision + 1,
  })
  saveOperation(db, operation)
}

const requireCurrentReservation = (
  db: DatabaseSync,
  reservation: ReservationRecord,
  moment: string
): ReservationRecord => {
  const current = getReservation(db, reservation.workspaceId)
  if (
    current === undefined ||
    current.id !== reservation.id ||
    current.revision !== reservation.revision
  )
    requireReview(`The task keeping this checkout changed ${moment}`)
  return current
}

interface SweepAttempt {
  readonly outcome: SweepOutcome
  readonly reason: string
  readonly operationId?: WorkspaceId
}

const WORKTREE_AND_GIT_REGISTRATION_REMOVED = 'Dev removed the worktree and its Git registration.'

const gitWorktreeRemovalText = (git: GitResult): string =>
  git.status === 0
    ? 'git worktree remove --force exited 0'
    : `git worktree remove --force failed: ${git.stderr.trim() || `exit ${git.status ?? 'signal'}`}`

const incompleteRemovalText = (detail: string, observed: string): string =>
  `The removal did not complete (${detail}): ${observed}`

const worktreeRemovedText = (detail: string): string => `Worktree removed; ${detail}.`

const removeFinishedWorktree = (
  authority: WorkspaceAuthority,
  repo: WorkspaceId,
  assessed: Assessed,
  moment: SweepMoment
): SweepAttempt => {
  const { reservation, workspace } = assessed
  const started = startedRelease(
    repo,
    reservation,
    workspace,
    moment,
    'remove-worktree',
    assessed.head
  )
  inDb(authority, repo, db =>
    transaction(db, () => {
      requireCurrentReservation(db, reservation, 'before dev recorded removal')
      putOperation(db, started)
    })
  )
  const git = removeWorktree(workspace.commonPath, workspace.path)
  const detail = gitWorktreeRemovalText(git)
  const after = observeRemoval(workspace)
  const unfinished = (result: string): SweepAttempt => {
    try {
      save(authority, repo, { ...started, phase: 'review-required', result })
    } catch {}
    return {
      outcome: 'review-required',
      reason: `${result}. Do not retry it. ${releaseOnceStopped(reservation.taskId)} That retries the removal; check its result.`,
      operationId: started.id,
    }
  }
  if (!after.complete) return unfinished(incompleteRemovalText(detail, after.text))
  removeEmptyRepositoryDirectory(authority, workspace.repositoryId)
  try {
    inDb(authority, repo, db =>
      transaction(db, () => {
        const current = requireCurrentReservation(
          db,
          reservation,
          'while the worktree was being removed'
        )
        deleteReservation(db, current)
        markRemoved(db, workspace, {
          ...started,
          phase: 'confirmed',
          result: worktreeRemovedText(detail),
        })
      })
    )
  } catch (cause) {
    return unfinished(
      `The worktree was removed, but its records were not updated: ${errorText(cause)}`
    )
  }
  return {
    outcome: 'removed',
    reason: WORKTREE_AND_GIT_REGISTRATION_REMOVED,
    operationId: started.id,
  }
}

const CHECKOUT_FREED_WITHOUT_CHANGES = 'Checkout freed for other work. Files and commits unchanged.'

const releaseFinishedReservation = (
  authority: WorkspaceAuthority,
  repo: WorkspaceId,
  assessed: Assessed,
  moment: SweepMoment
): SweepAttempt => {
  const { reservation, workspace } = assessed
  const operation: ReleaseOperationRecord = {
    ...startedRelease(repo, reservation, workspace, moment, 'release-reservation', assessed.head),
    phase: 'confirmed',
    result: CHECKOUT_FREED_WITHOUT_CHANGES,
  }
  inDb(authority, repo, db =>
    transaction(db, () => {
      const current = requireCurrentReservation(db, reservation, 'before its release was recorded')
      putOperation(db, operation)
      deleteReservation(db, current)
    })
  )
  return {
    outcome: 'released',
    reason: CHECKOUT_FREED_WITHOUT_CHANGES,
    operationId: operation.id,
  }
}

const attemptUnderGates = (
  authority: WorkspaceAuthority,
  input: SweepInput,
  repo: WorkspaceId,
  workspaceId: WorkspaceId,
  readers: EvidenceReaders,
  context: AssessmentContext,
  siblings: Siblings
): SweepAttempt => {
  const fresh = inDb(authority, repo, db => {
    const workspace = getWorkspace(db, workspaceId)
    const reservation = getReservation(db, workspaceId)
    if (workspace === undefined || reservation === undefined) return undefined
    return assessWorkspace(authority, db, repo, reservation, workspace, readers, context, siblings)
  })
  if (fresh === undefined)
    return {
      outcome: 'retained',
      reason: 'No task holds this checkout; nothing changed.',
    }
  const { completion } = fresh.assessment
  if (completion.kind !== 'finished')
    return {
      outcome: 'retained',
      reason: `It is no longer finished (${completion.reason}); nothing changed.`,
    }
  if (fresh.blockers.length > 0)
    return {
      outcome: 'retained',
      reason: `${fresh.blockers.join(' ')} Nothing changed.`,
    }
  if (fresh.workspace.origin === 'pre-existing')
    return releaseFinishedReservation(authority, repo, fresh, input.moment)
  const inside = input.occupiedPaths.filter(path => isWithin(fresh.workspace.path, path))
  if (inside.length > 0)
    return {
      outcome: 'retained',
      reason: `A shell or launcher working directory, or the conversation being closed, is still inside this worktree (${inside.join(', ')}); nothing changed.`,
    }
  let releaseInstallation: GateRelease
  try {
    releaseInstallation = holdExistingInstallationForRemoval(fresh.workspace.path)
  } catch (cause) {
    return {
      outcome: 'retained',
      reason: `Dev could not confirm the installation was idle (${errorText(cause)}). Nothing changed.`,
    }
  }
  try {
    return removeFinishedWorktree(authority, repo, fresh, input.moment)
  } finally {
    releaseInstallation()
  }
}

const attemptFinished = (
  authority: WorkspaceAuthority,
  input: SweepInput,
  assessed: Assessed,
  readers: EvidenceReaders,
  context: AssessmentContext,
  siblings: Siblings
): SweepAttempt => {
  const { workspace } = assessed
  const repo = assessed.assessment.repositoryId
  let structure: GateRelease | undefined
  let gates: PathGates | undefined
  try {
    if (workspace.origin === 'managed')
      structure = acquireStructureGate(authority.paths, workspace, repo)
    gates = acquirePathGates(authority.paths, workspace.path, 'removal')
  } catch (cause) {
    structure?.()
    if (cause instanceof WorkspaceError && cause.outcome === 'blocked')
      return {
        outcome: 'retained',
        reason: `Another dev session can still use this checkout or repository (${cause.message}). Nothing changed.`,
      }
    throw cause
  }
  try {
    return attemptUnderGates(authority, input, repo, workspace.id, readers, context, siblings)
  } finally {
    releaseGates(gates)
    structure?.()
  }
}

const closeUnfinishedReleases = (db: DatabaseSync, workspaceId: WorkspaceId): void => {
  for (const operation of unresolvedReleases(db, workspaceId))
    saveOperation(db, {
      ...operation,
      phase: 'cancelled',
      result: `${operation.result === undefined ? '' : `${operation.result} `}Superseded by dev workspace release.`,
    })
}

const headOf = (authority: WorkspaceAuthority, workspace: WorkspaceRecord): string | undefined => {
  try {
    const { head } = validateWorkspace(authority, workspace)
    return head.length > 0 ? head : undefined
  } catch {
    return undefined
  }
}

const removeEmptyRepositoryDirectory = (authority: WorkspaceAuthority, repo: WorkspaceId): void => {
  try {
    rmdirSync(join(authority.paths.worktrees, repo))
  } catch {}
}

const deleteBelow = (root: string, path: string): string | undefined => {
  if (observeAbsence(path) === 'absent') return undefined
  const parent = dirname(path)
  let canonical = false
  try {
    canonical = isWithin(root, path) && path !== root && realpathSync(parent) === parent
  } catch {}
  if (!canonical) return path
  rmSync(path, { recursive: true, force: true })
  return undefined
}

const disposeWorktree = (authority: WorkspaceAuthority, workspace: Worktree): string => {
  let detail = 'Git does not list the worktree'
  const registered = listed(workspace)
  if (registered === undefined)
    return 'Git worktree registration is unreadable; nothing was deleted'
  if (registered) {
    const git = removeWorktree(workspace.commonPath, workspace.path)
    detail = gitWorktreeRemovalText(git)
    if (git.status === 0) return detail
    if (listed(workspace) !== false) return detail
  }
  try {
    const servesMoved = adminServesAnotherWorktree(workspace)
    const unsafe = [
      deleteBelow(resolve(authority.paths.worktrees, workspace.repositoryId), workspace.path),
      servesMoved || workspace.gitAdminPath === undefined
        ? undefined
        : deleteBelow(join(workspace.commonPath, 'worktrees'), workspace.gitAdminPath),
    ].filter(path => path !== undefined)
    const moved = servesMoved ? `; ${workspace.gitAdminPath} serves a moved worktree and stays` : ''
    return unsafe.length === 0
      ? `${detail}; dev deleted what remained of it${moved}`
      : `${detail}; dev kept ${unsafe.join(' and ')}: outside dev's managed root or the repository's worktrees directory, or reached through a symbolic link${moved}`
  } catch (cause) {
    return `${detail}; dev could not delete what remained: ${errorText(cause)}`
  }
}

const releaseResult = (
  repo: WorkspaceId,
  workspace: WorkspaceRecord,
  outcome: Extract<WorkspaceReleaseResult, { readonly kind: 'workspace' }>['outcome'],
  reason: string
): WorkspaceReleaseResult => ({
  kind: 'workspace',
  repositoryId: repo,
  workspaceId: workspace.id,
  path: workspace.path,
  origin: workspace.origin,
  outcome,
  reason,
})

export const removeTaskArtifacts = (
  authority: WorkspaceAuthority,
  taskId: WorkspaceId
): TaskArtifactsResult | undefined => {
  const path = taskArtifactsPath(authority.paths, taskId)
  const info = lstatIfExists(path)
  if (info === undefined) return undefined
  if (taskWorkspaces(authority, taskId).length > 0) return undefined
  const row = (outcome: TaskArtifactsResult['outcome'], reason: string): TaskArtifactsResult => ({
    kind: 'task-artifacts',
    taskId,
    path,
    outcome,
    reason,
  })
  if (info.isSymbolicLink() || !info.isDirectory())
    return row(
      'review-required',
      'Dev kept the task files: the path is not a normal directory. Inspect it before removing.'
    )
  try {
    if (realpathSync(authority.paths.artifacts) !== authority.paths.artifacts)
      return row(
        'review-required',
        'Dev kept the task files because their parent folder uses a symlink.'
      )
    rmSync(path, { recursive: true, force: true })
  } catch (cause) {
    return row(
      'review-required',
      `The task's artifacts folder was not deleted: ${errorText(cause)}`
    )
  }
  if (lstatIfExists(path) !== undefined)
    return row('review-required', 'The task folder still exists. Cleanup at quit will retry.')
  return row('removed', 'Dev removed the task folder: no checkout is kept for it.')
}

const reportTaskArtifacts = (
  authority: WorkspaceAuthority,
  taskId: WorkspaceId
): TaskArtifactsResult | undefined => {
  try {
    return removeTaskArtifacts(authority, taskId)
  } catch (cause) {
    return {
      kind: 'task-artifacts',
      taskId,
      path: taskArtifactsPath(authority.paths, taskId),
      outcome: 'review-required',
      reason: `Dev could not check the task's artifacts folder: ${errorText(cause)}`,
    }
  }
}

const decodeTaskId = Schema.decodeUnknownOption(WorkspaceId)

const removeOrphanArtifacts = (
  authority: WorkspaceAuthority,
  expired: () => boolean = () => false
): readonly TaskArtifactsResult[] => {
  let entries: string[]
  try {
    entries = readdirSync(authority.paths.artifacts)
  } catch (cause) {
    if (hasErrorCode(cause, 'ENOENT')) return []
    throw cause
  }
  const results: TaskArtifactsResult[] = []
  for (const entry of entries.toSorted()) {
    if (expired()) break
    const taskId = decodeTaskId(entry)
    if (Option.isNone(taskId)) continue
    const result = reportTaskArtifacts(authority, taskId.value)
    if (result !== undefined) results.push(result)
  }
  return results
}

const fixCauseAndReleaseAgainText = (detail: string): string =>
  `${detail}. Fix the cause and release again.`

const removeForUser = (
  authority: WorkspaceAuthority,
  repo: WorkspaceId,
  reservation: ReservationRecord,
  workspace: WorkspaceRecord
): WorkspaceReleaseResult => {
  let head = headOf(authority, workspace)
  if (head === undefined && observeAbsence(workspace.path) === 'absent')
    head = inDb(
      authority,
      repo,
      db =>
        unresolvedReleases(db, workspace.id).findLast(
          operation =>
            operation.reservationId === reservation.id && operation.effect === 'remove-worktree'
        )?.head
    )
  const started = startedRelease(repo, reservation, workspace, 'user', 'remove-worktree', head)
  inDb(authority, repo, db =>
    transaction(db, () => {
      closeUnfinishedReleases(db, workspace.id)
      putOperation(db, started)
    })
  )
  const detail = disposeWorktree(authority, workspace)
  const after = observeRemoval(workspace)
  if (!after.complete) {
    const result = incompleteRemovalText(detail, after.text)
    save(authority, repo, { ...started, phase: 'review-required', result })
    return releaseResult(repo, workspace, 'failed', fixCauseAndReleaseAgainText(result))
  }
  removeEmptyRepositoryDirectory(authority, workspace.repositoryId)
  inDb(authority, repo, db =>
    transaction(db, () => {
      forgetReservation(db, reservation)
      markRemoved(db, workspace, {
        ...started,
        phase: 'confirmed',
        result: worktreeRemovedText(detail),
      })
    })
  )
  return releaseResult(repo, workspace, 'removed', WORKTREE_AND_GIT_REGISTRATION_REMOVED)
}

const releaseForUser = (
  authority: WorkspaceAuthority,
  repo: WorkspaceId,
  reservation: ReservationRecord,
  workspace: WorkspaceRecord
): WorkspaceReleaseResult => {
  inDb(authority, repo, db =>
    transaction(db, () => {
      closeUnfinishedReleases(db, workspace.id)
      putOperation(db, {
        ...startedRelease(
          repo,
          reservation,
          workspace,
          'user',
          'release-reservation',
          headOf(authority, workspace)
        ),
        phase: 'confirmed',
        result: CHECKOUT_FREED_WITHOUT_CHANGES,
      })
      forgetReservation(db, reservation)
    })
  )
  return releaseResult(repo, workspace, 'released', CHECKOUT_FREED_WITHOUT_CHANGES)
}

const linkedAdminPath = (commonPath: string, target: string): string | undefined => {
  const admins = join(commonPath, 'worktrees')
  const linksBack = (admin: string): boolean => {
    try {
      return readFileSync(join(admin, 'gitdir'), 'utf8').trim() === join(target, '.git')
    } catch {
      return false
    }
  }
  let pointer: string | undefined
  try {
    pointer = /^gitdir: (.+)$/m.exec(readFileSync(join(target, '.git'), 'utf8'))?.[1]
  } catch {}
  if (pointer !== undefined && dirname(pointer) === admins && linksBack(pointer)) return pointer
  const named = join(admins, basename(target))
  return linksBack(named) ? named : undefined
}

const clearUnfinishedAllocation = (
  authority: WorkspaceAuthority,
  repo: WorkspaceId,
  operation: AllocationOperationRecord
): WorkspaceReleaseResult => {
  const result = (
    outcome: Extract<WorkspaceReleaseResult, { readonly kind: 'workspace' }>['outcome'],
    reason: string
  ): WorkspaceReleaseResult => ({
    kind: 'workspace',
    repositoryId: repo,
    workspaceId: operation.workspaceId,
    path: operation.targetPath,
    origin: 'managed',
    outcome,
    reason,
  })
  let structure: GateRelease | undefined
  let gates: PathGates | undefined
  try {
    const source = inDb(authority, repo, db => getWorkspace(db, operation.sourceWorkspaceId))
    if (source === undefined)
      return result(
        'failed',
        `The source checkout of the unfinished worktree creation is no longer recorded: ${operation.sourcePath}. Remove ${operation.targetPath} by hand.`
      )
    structure = acquireStructureGate(authority.paths, source, repo)
    const occupied = observeAbsence(operation.targetPath) !== 'absent'
    if (occupied) gates = acquirePathGates(authority.paths, operation.targetPath, 'removal')
    const { current, owner } = inDb(authority, repo, db => ({
      current: unfinishedAllocations(db, operation.taskId).find(open => open.id === operation.id),
      owner: occupied ? getWorkspaceByPath(db, operation.targetPath) : undefined,
    }))
    if (current === undefined)
      return result('failed', 'The worktree creation finished meanwhile; release the task again.')
    const closed = (detail: string): AllocationOperationRecord => ({
      ...current,
      phase: 'cancelled',
      result: `${current.result === undefined ? '' : `${current.result} `}Superseded by dev workspace release: ${detail}.`,
    })
    if (owner !== undefined) {
      save(authority, repo, closed(`${current.targetPath} is now checkout ${owner.id}`))
      return result(
        'released',
        `The unfinished worktree creation was closed; its path is now checkout ${owner.id}, so nothing was removed.`
      )
    }
    const worktree: Worktree = {
      path: current.targetPath,
      commonPath: source.commonPath,
      gitAdminPath: linkedAdminPath(source.commonPath, current.targetPath),
      repositoryId: repo,
    }
    const detail = disposeWorktree(authority, worktree)
    const after = observeRemoval(worktree)
    if (!after.complete)
      return result(
        'failed',
        fixCauseAndReleaseAgainText(
          `The unfinished worktree creation was not cleared (${detail}): ${after.text}`
        )
      )
    save(authority, repo, closed(detail))
    removeEmptyRepositoryDirectory(authority, repo)
    return result(
      'removed',
      'The unfinished worktree creation was cleared; nothing of the worktree remains.'
    )
  } catch (cause) {
    return result('failed', fixCauseAndReleaseAgainText(errorText(cause)))
  } finally {
    if (gates !== undefined) releaseGates(gates)
    structure?.()
  }
}

const taskUnfinishedAllocations = (
  authority: WorkspaceAuthority,
  taskId: WorkspaceId
): { readonly repo: WorkspaceId; readonly operation: AllocationOperationRecord }[] =>
  authority
    .listRepositories()
    .flatMap(repository =>
      inDb(authority, repository.id, db =>
        unfinishedAllocations(db, taskId).map(operation => ({ repo: repository.id, operation }))
      )
    )

export const releaseTask = (
  authority: WorkspaceAuthority,
  taskId: WorkspaceId
): readonly WorkspaceReleaseResult[] => {
  if (authority.inspectExisting() === undefined) return []
  const reserved = taskWorkspaces(authority, taskId).map(({ repo, reservation, workspace }) => {
    let structure: GateRelease | undefined
    try {
      if (workspace.origin === 'pre-existing')
        return releaseForUser(authority, repo, reservation, workspace)
      structure = acquireStructureGate(authority.paths, workspace, repo)
      return removeForUser(authority, repo, reservation, workspace)
    } catch (cause) {
      return releaseResult(repo, workspace, 'failed', fixCauseAndReleaseAgainText(errorText(cause)))
    } finally {
      structure?.()
    }
  })
  const results = [
    ...reserved,
    ...taskUnfinishedAllocations(authority, taskId).map(({ repo, operation }) =>
      clearUnfinishedAllocation(authority, repo, operation)
    ),
  ]
  if (results.length === 0) return results
  const artifacts = reportTaskArtifacts(authority, taskId)
  return artifacts === undefined ? results : [...results, artifacts]
}

const clearEndedUses = (
  authority: WorkspaceAuthority,
  repo: WorkspaceId,
  workspaceId: WorkspaceId
): WorkspaceReleaseResult =>
  inDb(authority, repo, db =>
    transaction(db, () => {
      const workspace = getWorkspace(db, workspaceId)
      if (workspace?.origin !== 'pre-existing')
        throw new WorkspaceError({
          outcome: 'invalid',
          message: `${workspaceId} is not a pre-existing checkout of repository ${repo}.`,
        })
      const reservation = getReservation(db, workspace.id)
      if (reservation !== undefined)
        return releaseResult(
          repo,
          workspace,
          'failed',
          `This checkout is kept for a task. Run dev workspace release ${reservation.taskId} instead.`
        )
      const uses = getUseRows(db, workspace.id)
      const live = uses.filter(
        use => isActiveUse(use) && incarnationHeld(authority.paths, use.incarnation)
      )
      const kept = new Set(live.flatMap(use => [use.id, use.withinUseId ?? use.id]))
      const ended = uses.filter(use => !kept.has(use.id))
      deleteUses(
        db,
        ended.map(use => use.id)
      )
      const deleted = `${ended.length} use record(s) of ended dev sessions were deleted${
        kept.size === 0 ? '' : `; ${kept.size} use(s) of running dev sessions stay`
      }`
      if (!checkoutMissing(workspace))
        return releaseResult(
          repo,
          workspace,
          'released',
          `${deleted}; files and commits are unchanged.`
        )
      if (
        kept.size > 0 ||
        openOperations(db, workspace.id).length > 0 ||
        getBindingRows(db, workspace.id).some(
          binding =>
            binding.superseded !== true &&
            conversationPresent(authority.paths, conversationIdentity(binding.conversation))
        )
      )
        return releaseResult(
          repo,
          workspace,
          'released',
          `${deleted}; the checkout directory no longer exists, but a running dev session or pending operation still refers to it, so dev keeps it registered.`
        )
      saveWorkspace(db, {
        ...workspace,
        status: 'removed',
        pathKey: hash(workspace.id),
        revision: workspace.revision + 1,
      })
      return releaseResult(
        repo,
        workspace,
        'released',
        `${deleted}; the checkout directory no longer exists, so dev forgot it.`
      )
    })
  )

export const releasePreExisting = (
  authority: WorkspaceAuthority,
  repo: WorkspaceId,
  workspaceIds: readonly WorkspaceId[]
): readonly WorkspaceReleaseResult[] =>
  authority.inspectExisting() === undefined
    ? []
    : workspaceIds.map(workspaceId => clearEndedUses(authority, repo, workspaceId))

export const settleOrbPresence = (
  authority: WorkspaceAuthority,
  request: OrbPresenceRequest
): OrbPresenceSettlement => {
  const absent: OrbPresenceSettlement = {
    outcome: 'absent',
    reason: `Use ${request.useId} is settled or no longer recorded; nothing changed.`,
  }
  if (authority.inspectExisting() === undefined) return absent
  const git = canonicalGitWorkspace(request.cwd)
  const repo = authority.findRepository(git)
  if (repo === undefined) return absent
  return inDb(authority, repo, db =>
    transaction(db, () => {
      const presence = getUse(db, request.useId)
      if (presence === undefined || presence.stage === 'quiescent') return absent
      if (
        presence.access !== 'write' ||
        presence.withinUseId !== undefined ||
        presence.execution !== undefined
      )
        invalid(`Use ${presence.id} is not the writer presence of a dev --orb session`)
      const workspace = getWorkspace(db, presence.workspaceId)
      if (workspace?.path !== git.path) invalid(`Use ${presence.id} is not a use of ${git.path}`)
      if (incarnationHeld(authority.paths, presence.incarnation))
        blocked(`Use ${presence.id} belongs to a dev session that is still running`)
      const settled = getUseRows(db, workspace.id).filter(
        use => use.incarnation === presence.incarnation
      )
      return settlePresenceUses(authority, db, repo, workspace, presence.taskId, settled, {
        decider: 'orb-recovery',
        session: 'the ended dev --orb session',
      })
    })
  )
}

export const withdrawOrbPresence = (
  authority: WorkspaceAuthority,
  attachment: AttachmentHandle,
  grant: WorkspaceGrant
): OrbPresenceSettlement => {
  attachment.assertOpen()
  const { state } = attachment
  const lease = validateGrant(authority, state, grant)
  if (
    grant.access !== 'write' ||
    lease.kind !== 'ordinary' ||
    state.writeGrant?.useId !== grant.useId
  )
    invalid(`Use ${grant.useId} is not the writer presence of this dev --orb session`)
  const settlement = inDb(authority, grant.repositoryId, db =>
    transaction(db, () => {
      const presence = getUse(db, grant.useId)
      const workspace = getWorkspace(db, grant.workspaceId)
      if (presence === undefined || workspace === undefined)
        requireReview(`Use ${grant.useId} lost its records before its withdrawal`)
      const uses = getUseRows(db, workspace.id)
      if (presence.stage !== 'authorized' || uses.some(use => use.withinUseId === presence.id))
        invalid(
          `Use ${presence.id} was already used, so only automatic cleanup at quit can settle it`
        )
      return settlePresenceUses(
        authority,
        db,
        grant.repositoryId,
        workspace,
        presence.taskId,
        [presence],
        {
          decider: 'orb-start',
          session: 'the failed dev --orb start',
        }
      )
    })
  )
  if (lease.gates !== undefined) {
    releaseGates(lease.gates)
    lease.gates = undefined
  }
  forgetPrunedLease(state, lease)
  state.writeGrant = undefined
  return settlement
}

const settlePresenceUses = (
  authority: WorkspaceAuthority,
  db: DatabaseSync,
  repo: WorkspaceId,
  workspace: WorkspaceRecord,
  taskId: WorkspaceId | undefined,
  settled: readonly UseRecord[],
  by: { readonly decider: 'orb-recovery' | 'orb-start'; readonly session: string }
): OrbPresenceSettlement => {
  deleteUses(
    db,
    settled.map(use => use.id)
  )
  const reservation = getReservation(db, workspace.id)
  if (
    workspace.origin !== 'pre-existing' ||
    reservation === undefined ||
    reservation.taskId !== taskId ||
    getUseRows(db, workspace.id).some(use => use.taskId === reservation.taskId)
  )
    return {
      outcome: 'settled',
      reason: `${settled.length} use record(s) of ${by.session} were deleted; files and commits are unchanged.`,
    }
  const result = `${settled.length} use record(s) of ${by.session} were deleted and task ${reservation.taskId} no longer keeps checkout ${workspace.id}; files and commits are unchanged.`
  putOperation(db, {
    ...startedRelease(
      repo,
      reservation,
      workspace,
      by.decider,
      'release-reservation',
      headOf(authority, workspace)
    ),
    phase: 'confirmed',
    result,
  })
  deleteReservation(db, reservation)
  return { outcome: 'settled', reason: result }
}

export interface SweepInput {
  readonly repositoryId: WorkspaceId
  readonly moment: SweepMoment
  readonly deadline: number
  readonly occupiedPaths: readonly string[]
  readonly excluded?: ReadonlySet<WorkspaceId>
}

const SWEEP_BUDGET_MS: Record<SweepMoment, number> = {
  quit: (WORKER_REQUEST_TIMEOUT_MS * 2) / 3,
  replacement: WORKER_REQUEST_TIMEOUT_MS / 3,
  allocation: WORKER_REQUEST_TIMEOUT_MS / 3,
}
export const sweepDeadline = (moment: SweepMoment, requestedAt: number): number =>
  requestedAt + SWEEP_BUDGET_MS[moment]

interface SweepRun {
  readonly taskIds: readonly WorkspaceId[]
  readonly context: AssessmentContext
  readonly expired: (index: number) => boolean
  readonly fail: (taskId: WorkspaceId, cause: unknown) => void
  readonly abort: (cause: unknown) => void
  readonly settle: (index: number, taskId: WorkspaceId, assessed: readonly Assessed[]) => boolean
  readonly unfinished: () => void
  readonly orphans: () => void
  readonly receipt: () => SweepReceipt
}

const startSweep = (
  authority: WorkspaceAuthority,
  input: SweepInput,
  readers: EvidenceReaders
): SweepRun => {
  const receipt: SweepRow[] = []
  const context: AssessmentContext = {
    moment: input.moment,
    ...(input.excluded === undefined ? {} : { excluded: input.excluded }),
    sweptSiblings: new Map(),
  }
  const seconds = SWEEP_BUDGET_MS[input.moment] / 1000
  const taskIds =
    authority.inspectExisting() === undefined
      ? []
      : inDb(authority, input.repositoryId, db =>
          rows(db, 'SELECT DISTINCT task_id FROM reservations ORDER BY task_id').map(row =>
            WorkspaceId.make(textField(row, 'task_id'))
          )
        )
  const deferFrom = (index: number, started: boolean): void => {
    receipt.push(
      ...taskIds.slice(index).map((taskId, offset) => ({
        kind: 'task-deferred' as const,
        taskId,
        reason:
          started && offset === 0
            ? `Cleanup reached its ${seconds}-second limit. Dev will check the remaining checkouts next time.`
            : `Cleanup reached its ${seconds}-second limit before this task. Dev will check it next time.`,
      }))
    )
  }
  return {
    taskIds,
    context,
    expired: index => {
      if (now() < input.deadline) return false
      deferFrom(index, false)
      return true
    },
    fail: (taskId, cause) => {
      receipt.push({
        kind: 'task-failure',
        taskId,
        reason: `Could not check the task. Nothing changed: ${errorText(cause)}`,
      })
    },
    abort: cause => {
      receipt.push({
        kind: 'sweep-failure',
        reason: `Automatic cleanup stopped early. Dev tried only the listed operations: ${errorText(cause)}`,
      })
    },
    settle: (index, taskId, assessed) => {
      const siblingsFor = taskSiblings(
        authority,
        taskId,
        () => taskWorkspaces(authority, taskId),
        context
      )
      for (const entry of assessed.toSorted((left, right) =>
        left.workspace.id.localeCompare(right.workspace.id)
      )) {
        const { assessment } = entry
        const row = {
          kind: 'workspace' as const,
          taskId,
          workspaceId: assessment.workspaceId,
          path: assessment.path,
          origin: assessment.origin,
          verdict: assessment.completion,
        }
        if (assessment.completion.kind === 'retained') {
          receipt.push({
            ...row,
            outcome: RETAINED[assessment.completion.retained].sweep,
            reason: assessment.completion.reason,
          })
          continue
        }
        if (entry.blockers.length > 0) {
          receipt.push({
            ...row,
            outcome: 'retained',
            reason: entry.blockers.join(' '),
          })
          continue
        }
        if (now() >= input.deadline) {
          deferFrom(index, true)
          return true
        }
        try {
          const result = attemptFinished(
            authority,
            input,
            entry,
            readers,
            context,
            siblingsFor(assessment.workspaceId)
          )
          receipt.push({
            ...row,
            outcome: result.outcome,
            reason: result.reason,
            ...(result.operationId === undefined ? {} : { operationId: result.operationId }),
          })
          if (result.outcome === 'released' || result.outcome === 'removed') {
            const artifacts = reportTaskArtifacts(authority, taskId)
            if (artifacts !== undefined) receipt.push(artifacts)
          }
        } catch (cause) {
          receipt.push({
            ...row,
            outcome:
              cause instanceof WorkspaceError && cause.outcome === 'invalid'
                ? 'retained'
                : 'review-required',
            reason: `Dev refused the operation or cannot confirm its result: ${errorText(cause)}`,
          })
        }
      }
      return false
    },
    unfinished: () => {
      if (authority.inspectExisting() === undefined) return
      const reason =
        'Worktree creation did not finish. Releasing the task removes what Git created.'
      receipt.push(
        ...inDb(authority, input.repositoryId, db => unfinishedAllocations(db)).map(operation => ({
          kind: 'workspace' as const,
          taskId: operation.taskId,
          workspaceId: operation.workspaceId,
          path: operation.targetPath,
          origin: 'managed' as const,
          verdict: {
            kind: 'retained' as const,
            role: roleOf({ origin: 'managed', branch: undefined, allocation: operation.reason }),
            retained: 'transition-unresolved' as const,
            reason,
          },
          outcome: RETAINED['transition-unresolved'].sweep,
          reason,
          operationId: operation.id,
        }))
      )
    },
    orphans: () => {
      const reported = new Set(
        receipt.flatMap(row => (row.kind === 'task-artifacts' ? [row.taskId] : []))
      )
      receipt.push(
        ...removeOrphanArtifacts(authority, () => now() >= input.deadline).filter(
          row => !reported.has(row.taskId)
        )
      )
    },
    receipt: () => ({ moment: input.moment, rows: receipt }),
  }
}

export const sweepRepositoryForAllocation = (
  authority: WorkspaceAuthority,
  input: SweepInput & { readonly moment: 'allocation' },
  readers: EvidenceReaders
): SweepReceipt => {
  const sweep = startSweep(authority, input, readers)
  for (const [index, taskId] of sweep.taskIds.entries()) {
    if (sweep.expired(index)) break
    let assessed: readonly Assessed[]
    try {
      assessed = assessTask(authority, taskId, readers, sweep.context)
    } catch (cause) {
      sweep.fail(taskId, cause)
      continue
    }
    if (sweep.settle(index, taskId, assessed)) break
  }
  return sweep.receipt()
}

export const sweepRepositoryAtClose = async (
  authority: WorkspaceAuthority,
  input: SweepInput & { readonly moment: ClosingSweepMoment },
  readers: EvidenceReaders
): Promise<SweepReceipt> => {
  const sweep = startSweep(authority, input, readers)
  try {
    if (sweep.taskIds.length > 0)
      inDb(authority, input.repositoryId, db => {
        for (const taskId of sweep.taskIds)
          void prefetchEvidence(readers, getTask(db, taskId)?.target)
      })
    for (const [index, taskId] of sweep.taskIds.entries()) {
      if (sweep.expired(index)) break
      let assessed: readonly Assessed[]
      try {
        assessed = await assessTaskAtClose(authority, taskId, readers, sweep.context)
      } catch (cause) {
        sweep.fail(taskId, cause)
        continue
      }
      if (sweep.settle(index, taskId, assessed)) break
    }
    sweep.unfinished()
    sweep.orphans()
  } catch (cause) {
    sweep.abort(cause)
  }
  return sweep.receipt()
}
