import { lstatSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { dirname, join, resolve } from 'node:path'
import {
  inDb,
  taskWorkspaces,
  validateWorkspace,
  type WorkspaceAuthority,
} from './workspace-authority.ts'
import {
  decideCompletion,
  integrationUnknown,
  CLEAR,
  needsIntegration,
  RETAINED,
  roleOf,
  type CompletionFacts,
  type IntegrationFacts,
  type Residue,
} from './workspace-completion.ts'
import {
  requireReview,
  WorkspaceError,
  WorkspaceId,
  type AllocationReason,
  type CompletionVerdict,
  type ReleaseDecider,
  type SweepMoment,
  type SweepOutcome,
  type SweepReceipt,
  type SweepRow,
  type TargetView,
  type TaskTarget,
  type WorkspaceAssessment,
  type WorkspaceReleaseResult,
  WORKER_REQUEST_TIMEOUT_MS,
} from './workspace-domain.ts'
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
  releaseGates,
  type GateRelease,
  type PathGates,
} from './workspace-gates.ts'
import {
  ancestry,
  registeredWorktrees,
  removeWorktree,
  symbolicBranch,
  type GitWorkspace,
} from './workspace-git.ts'
import { abandonedUseIds, sampledPaths } from './workspace-inspect.ts'
import { isWithin } from './workspace-paths.ts'
import {
  confirmedReleases,
  deleteReservation,
  forgetReservation,
  getBindingRows,
  getOperation,
  getPublications,
  getReservation,
  getTask,
  getUseRows,
  getWorkspace,
  isUnresolvedRelease,
  isActiveUse,
  openOperations,
  putOperation,
  saveOperation,
  saveWorkspace,
  unresolvedReleases,
  type ReleaseOperationRecord,
  type ReservationRecord,
  type UseRecord,
  type WorkspaceRecord,
} from './workspace-records.ts'
import { errorText } from './error-text.ts'
import { holdExistingInstallationForRemoval } from './runtime-coordination.ts'
import { rows, textField, transaction } from './workspace-sqlite.ts'
import { hasErrorCode, newId, now } from './workspace-platform.ts'

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
    return { inaccessible: `anchor directory ${anchor}: ${errorText(cause)}` }
  }
}

const absenceText = (what: string, absence: Absence): string => {
  if (absence === 'present') return `${what} present`
  if (absence === 'absent') return `${what} absent`
  return `${what} inaccessible (${absence.inaccessible})`
}
const adminServesAnotherWorktree = (workspace: WorkspaceRecord): boolean => {
  try {
    const gitdir = readFileSync(join(workspace.gitAdminPath, 'gitdir'), 'utf8').trim()
    return gitdir.length > 0 && dirname(gitdir) !== workspace.path
  } catch {
    return false
  }
}
const listed = (workspace: WorkspaceRecord): boolean | undefined => {
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
const observeRemoval = (workspace: WorkspaceRecord): RemovalObservation => {
  const directory = observeAbsence(workspace.path)
  const admin = observeAbsence(workspace.gitAdminPath, workspace.commonPath)
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
      absenceText(`admin directory ${workspace.gitAdminPath}`, admin),
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
      reason: `Workspace directory is inaccessible (${observed.inaccessible}): ${workspace.path}`,
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
  `${use.access}/${use.stage}${use.execution === undefined ? '' : `, ${use.execution.taskKey}`}`

const assessUses = (
  authority: WorkspaceAuthority,
  db: DatabaseSync,
  workspaceId: WorkspaceId,
  own: OwnConversation | undefined
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
  const live = uses.filter(use => isActiveUse(use) && !ownUses.includes(use))
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
        ? `This conversation holds ${ownUses.length} use(s) here (${ownUses.map(describeUse).join(', ')}); they end when it quits, and the sweep then rechecks them.`
        : 'This conversation is bound here; it stops counting as a use when it quits, and the sweep then rechecks the workspace.'
    )
  if (unknown.length > 0) {
    reasons.push(
      `Unresolved workspace use(s) ${unknown.map(use => use.id).join(', ')} keep the sweep away; explicit recovery is not available yet.`
    )
    nextActions.push('dev workspace release clears the task when you no longer need it.')
  } else if (abandoned.length > 0) {
    reasons.push(
      `Use(s) ${abandoned.join(', ')} were left unsettled by dev sessions that have ended; their processes may still run.`
    )
    nextActions.push('dev workspace release clears the task once those processes are gone.')
  } else if (live.length > 0 || conversations.length > 0) {
    if (live.length > 0)
      reasons.push(
        `${live.length} live use(s) by participating dev session(s): ${live
          .map(use => `${use.id} (${describeUse(use)})`)
          .join(', ')}`
      )
    if (conversations.length > 0)
      reasons.push(
        `${conversations.length} open dev conversation(s) are bound here: ${conversations
          .map(binding => binding.conversation.sessionId)
          .join(', ')}`
      )
    nextActions.push(
      'End that use (finish or stop its work, close its conversation); the next sweep rechecks it.'
    )
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
      `${inventory.untracked} untracked and ${inventory.ignored} ignored path(s) remain in place`
    )
  return residual
}
const residueOf = (inventory: Inventory): Residue => ({
  tracked: inventory.tracked.length,
  untracked: inventory.untracked,
  ignored: inventory.ignored,
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
          `An unstarted ${operation.kind} intent ${operation.id} is recorded; the sweep neither waits for it nor replays it.`
      ),
    ...unfinishedReleases.map(
      operation =>
        `Release ${operation.id} did not finish (${operation.phase})${operation.result === undefined ? '' : `: ${operation.result}`}.`
    ),
  ]
  const allocation = allocationOf(db, workspace)
  const uses = assessUses(authority, db, workspace.id, context.own)
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
          description: 'A pre-existing checkout needs no integration target.',
        }
      : {
          source: 'not-assessed',
          description: 'The target was not derived for this state.',
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
  if (identity.kind === 'unverifiable')
    return shape({ reasons: [identity.reason], nextActions: [CLEAR] })
  if (unresolvedTransitions.length > 0)
    return shape({
      reasons: unresolvedTransitions.map(
        operation =>
          `Operation ${operation.id} (${operation.kind}) is ${operation.phase}${operation.result === undefined ? '' : `: ${operation.result}`}`
      ),
      nextActions: [CLEAR],
    })
  if (identity.kind === 'absent')
    return shape({
      reasons: [`The managed worktree directory is absent: ${workspace.path}`],
      nextActions: [CLEAR],
    })
  if (workspace.origin === 'pre-existing') {
    let inventory: Inventory | undefined
    const reasons = [...uses.reasons]
    try {
      inventory = readInventory(workspace.path, head)
    } catch (cause) {
      reasons.push(`Residual changes could not be read: ${errorText(cause)}`)
    }
    const completion = decideCompletion({
      ...factsBase,
      ...(inventory === undefined ? {} : { residue: residueOf(inventory) }),
    })
    const residual = residualOf(inventory, head)
    if (uses.inUse) return shape({ reasons, nextActions: uses.nextActions, residual, completion })
    return shape({
      reasons: [
        ...reasons,
        'Pre-existing checkout: release ends only the task reservation; files and commits stay untouched.',
        completion.reason,
      ],
      nextActions:
        completion.kind === 'finished'
          ? ['Quitting dev releases this reservation automatically; files and commits stay.']
          : retainedActions(completion),
      residual,
      completion,
    })
  }
  let evidence: InventoryVerdict
  let branch: string | undefined
  let ownCommits: boolean | undefined
  const publications = getPublications(db, reservation.taskId).filter(
    reference => reference.workspaceId === undefined || reference.workspaceId === workspace.id
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
  const residue = residueOf(evidence.inventory)
  const complete = (): Assessed => {
    let target: TargetView =
      recordedTarget(workspace.path, override, branch) ??
      (uses.inUse
        ? {
            source: 'not-assessed',
            description: 'The target is derived once no use holds the workspace.',
          }
        : {
            source: 'not-needed',
            description:
              'No residue and no commits beyond its base, so no integration target is needed.',
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
      return shape({ ...common, reasons: uses.reasons, nextActions: uses.nextActions })
    if (evidence.verdict !== 'valid')
      return shape(
        {
          ...common,
          reasons: [...uses.reasons, ...evidence.reasons, completion.reason],
          nextActions: [
            evidence.verdict === 'invalid'
              ? 'Resolve each blocker (publish the selected artifact again, resolve the conflict or remove the nested repository), then check again.'
              : 'Resolve each unsupported or unreadable entry, then check again; the sweep never deletes what it cannot inspect.',
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
          'Finished at this check; nothing removed; the sweep rechecks before removing it.',
        ],
        nextActions: [
          'Quitting dev, or the next managed worktree allocation, removes it automatically.',
        ],
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
      reason: `Commits of sibling workspace ${workspace.id} beyond its base cannot be determined, so its pull requests were not searched.`,
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
      reason: `The HEAD of sibling workspace ${workspace.id} could not be read, so its pull requests were not searched: ${errorText(cause)}`,
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

const assessTaskAtQuit = (
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

const startedRelease = (
  repo: WorkspaceId,
  reservation: ReservationRecord,
  workspace: WorkspaceRecord,
  decider: ReleaseDecider,
  effect: ReleaseOperationRecord['effect'],
  head: string | undefined
): ReleaseOperationRecord => ({
  id: newId(),
  kind: 'release',
  phase: 'started',
  repositoryId: repo,
  workspaceId: workspace.id,
  taskId: reservation.taskId,
  reservationId: reservation.id,
  decider,
  effect,
  targetPath: workspace.path,
  ...(head === undefined ? {} : { head }),
  expectedReservationRevision: reservation.revision,
  createdAt: now(),
})

const save = (
  authority: WorkspaceAuthority,
  repo: WorkspaceId,
  operation: ReleaseOperationRecord
): void => inDb(authority, repo, db => transaction(db, () => saveOperation(db, operation)))

const markRemoved = (
  db: DatabaseSync,
  workspace: WorkspaceRecord,
  operation: ReleaseOperationRecord
): void => {
  const stored = getWorkspace(db, workspace.id)
  if (stored === undefined)
    requireReview(`Workspace record disappeared while it was being removed: ${workspace.id}`)
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
    requireReview(`Reservation changed ${moment}`)
  return current
}

interface SweepAttempt {
  readonly outcome: SweepOutcome
  readonly reason: string
  readonly operationId?: WorkspaceId
}

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
      requireCurrentReservation(db, reservation, 'before the sweep recorded its removal')
      putOperation(db, started)
    })
  )
  const git = removeWorktree(workspace.commonPath, workspace.path)
  const detail =
    git.status === 0
      ? 'git worktree remove --force exited 0'
      : `git worktree remove --force failed: ${git.stderr.trim() || `exit ${git.status ?? 'signal'}`}`
  const after = observeRemoval(workspace)
  const unfinished = (result: string): SweepAttempt => {
    try {
      save(authority, repo, { ...started, phase: 'review-required', result })
    } catch {}
    return {
      outcome: 'review-required',
      reason: `${result}; dev workspace release ${reservation.taskId} finishes it.`,
      operationId: started.id,
    }
  }
  if (!after.complete) return unfinished(`The removal did not complete (${detail}): ${after.text}`)
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
          result: `Worktree removed; ${detail}.`,
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
    reason: 'The managed worktree, its Git registration and its reservation were removed.',
    operationId: started.id,
  }
}

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
    result: `Reservation ${reservation.id} released; files and commits unchanged.`,
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
    reason: `Reservation ${reservation.id} was released; files and commits are unchanged.`,
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
    return { outcome: 'retained', reason: 'The workspace is no longer reserved; nothing changed.' }
  const { completion } = fresh.assessment
  if (completion.kind !== 'finished')
    return {
      outcome: 'retained',
      reason: `It is no longer finished (${completion.reason}); nothing changed.`,
    }
  if (fresh.blockers.length > 0)
    return { outcome: 'retained', reason: `${fresh.blockers.join(' ')} Nothing changed.` }
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
      reason: `Target installation coordination is active or unverifiable (${errorText(cause)}); nothing changed.`,
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
        reason: `A participating dev session still uses this workspace or its repository structure (${cause.message}); nothing changed.`,
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

const disposeWorktree = (authority: WorkspaceAuthority, workspace: WorkspaceRecord): string => {
  let detail = 'Git does not list the worktree'
  const registered = listed(workspace)
  if (registered === undefined)
    return 'Git worktree registration is unreadable; nothing was deleted'
  if (registered) {
    const git = removeWorktree(workspace.commonPath, workspace.path)
    if (git.status === 0) return 'git worktree remove --force exited 0'
    detail = `git worktree remove --force failed: ${git.stderr.trim() || `exit ${git.status ?? 'signal'}`}`
    if (listed(workspace) !== false) return detail
  }
  try {
    const servesMoved = adminServesAnotherWorktree(workspace)
    const unsafe = [
      deleteBelow(resolve(authority.paths.worktrees, workspace.repositoryId), workspace.path),
      servesMoved
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
  outcome: WorkspaceReleaseResult['outcome'],
  reason: string
): WorkspaceReleaseResult => ({
  repositoryId: repo,
  workspaceId: workspace.id,
  path: workspace.path,
  origin: workspace.origin,
  outcome,
  reason,
})

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
    const result = `The removal did not complete (${detail}): ${after.text}`
    save(authority, repo, { ...started, phase: 'review-required', result })
    return releaseResult(repo, workspace, 'failed', `${result}. Fix the cause and release again.`)
  }
  inDb(authority, repo, db =>
    transaction(db, () => {
      forgetReservation(db, reservation)
      markRemoved(db, workspace, {
        ...started,
        phase: 'confirmed',
        result: `Worktree removed; ${detail}.`,
      })
    })
  )
  return releaseResult(
    repo,
    workspace,
    'removed',
    'The managed worktree, its Git registration and its reservation were removed.'
  )
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
        result: `Reservation ${reservation.id} released; files and commits unchanged.`,
      })
      forgetReservation(db, reservation)
    })
  )
  return releaseResult(
    repo,
    workspace,
    'released',
    `Reservation ${reservation.id} was released; files and commits are unchanged.`
  )
}

export const releaseTask = (
  authority: WorkspaceAuthority,
  taskId: WorkspaceId
): readonly WorkspaceReleaseResult[] => {
  if (authority.inspectExisting() === undefined) return []
  return taskWorkspaces(authority, taskId).map(({ repo, reservation, workspace }) => {
    let structure: GateRelease | undefined
    try {
      if (workspace.origin === 'pre-existing')
        return releaseForUser(authority, repo, reservation, workspace)
      structure = acquireStructureGate(authority.paths, workspace, repo)
      return removeForUser(authority, repo, reservation, workspace)
    } catch (cause) {
      return releaseResult(
        repo,
        workspace,
        'failed',
        `${errorText(cause)}. Fix the cause and release again.`
      )
    } finally {
      structure?.()
    }
  })
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
  allocation: WORKER_REQUEST_TIMEOUT_MS / 3,
}
export const sweepDeadline = (moment: SweepMoment, requestedAt: number): number =>
  requestedAt + SWEEP_BUDGET_MS[moment]

interface SweepRun {
  readonly taskIds: readonly WorkspaceId[]
  readonly context: AssessmentContext
  readonly expired: (index: number) => boolean
  readonly fail: (taskId: WorkspaceId, cause: unknown) => void
  readonly settle: (index: number, taskId: WorkspaceId, assessed: readonly Assessed[]) => boolean
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
            ? `The sweep used its ${seconds}-second budget during this task, so its remaining workspaces were not attempted; the next sweep assesses them.`
            : `The sweep used its ${seconds}-second budget before this task, so nothing of it was assessed or attempted; the next sweep assesses it.`,
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
        reason: `The task could not be assessed, so nothing of it was attempted: ${errorText(cause)}`,
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
          receipt.push({ ...row, outcome: 'retained', reason: entry.blockers.join(' ') })
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
        } catch (cause) {
          receipt.push({
            ...row,
            outcome:
              cause instanceof WorkspaceError && cause.outcome === 'invalid'
                ? 'retained'
                : 'review-required',
            reason: `The attempt was refused or its outcome is uncertain: ${errorText(cause)}`,
          })
        }
      }
      return false
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

export const sweepRepositoryAtQuit = async (
  authority: WorkspaceAuthority,
  input: SweepInput & { readonly moment: 'quit' },
  readers: EvidenceReaders
): Promise<SweepReceipt> => {
  const sweep = startSweep(authority, input, readers)
  if (sweep.taskIds.length > 0)
    inDb(authority, input.repositoryId, db => {
      for (const taskId of sweep.taskIds)
        void prefetchEvidence(readers, getTask(db, taskId)?.target)
    })
  for (const [index, taskId] of sweep.taskIds.entries()) {
    if (sweep.expired(index)) break
    let assessed: readonly Assessed[]
    try {
      assessed = await assessTaskAtQuit(authority, taskId, readers, sweep.context)
    } catch (cause) {
      sweep.fail(taskId, cause)
      continue
    }
    if (sweep.settle(index, taskId, assessed)) break
  }
  return sweep.receipt()
}
