import { lstatSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import {
  inDb,
  taskWorkspaces,
  validateWorkspace,
  type WorkspaceAuthority,
} from './workspace-authority.ts'
import {
  COMPLETION_POLICY_VERSION,
  decideCompletion,
  integrationUnknown,
  needsIntegration,
  type CompletionFacts,
  type IntegrationFacts,
  type Residue,
} from './workspace-completion.ts'
import {
  invalid,
  RELEASE_SUBJECT_FIELDS,
  requireReview,
  WorkspaceError,
  WorkspaceId,
  type AllocationReason,
  type CompletionVerdict,
  type ReleaseDecider,
  type ReleaseRequest,
  type ReleaseSubject,
  type RetainedReason,
  type SweepMoment,
  type SweepOutcome,
  type SweepReceipt,
  type SweepRow,
  type TargetView,
  type WorkspaceAssessment,
  type WorkspaceReleaseResult,
  WORKER_REQUEST_TIMEOUT_MS,
} from './workspace-domain.ts'
import {
  EVIDENCE_POLICY_VERSION,
  deriveTarget,
  describeTarget,
  recordedTarget,
  entryUnchanged,
  integrationFacts,
  readInventory,
  stateDigestOf,
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
  worktreeLockReason,
  type GitWorkspace,
} from './workspace-git.ts'
import { abandonedUseIds, deletionHistory, sampledPaths } from './workspace-inspect.ts'
import { isWithin } from './workspace-paths.ts'
import {
  cancelUnstartedReleases,
  confirmedReleases,
  deleteReservation,
  getBindingRows,
  getOperation,
  getPublications,
  getReservation,
  getTask,
  getUseRows,
  getWorkspace,
  isEngineRecordedRelease,
  isUnresolvedRelease,
  isActiveUse,
  openOperations,
  putOperation,
  releaseOperations,
  saveOperation,
  saveWorkspace,
  unresolvedReleases,
  type ManifestEntry,
  type ReleaseOperationRecord,
  type ReleaseStep,
  type ReservationRecord,
  type UseRecord,
  type WorkspaceRecord,
  type WorktreeRemovalRecord,
} from './workspace-records.ts'
import { errorText } from './error-text.ts'
import { holdExistingInstallationForRemoval } from './runtime-coordination.ts'
import { rows, textField, transaction } from './workspace-sqlite.ts'
import { hasErrorCode, newId, now } from './workspace-platform.ts'
import { observePhysicalIdentity, type PhysicalObservation } from './workspace-identity.ts'

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
const describeAbsence = (what: string, absence: Absence): string => {
  if (absence === 'present') return `${what} present`
  if (absence === 'absent') return `${what} absent`
  return `${what} inaccessible (${absence.inaccessible})`
}

interface RemovalObservation {
  readonly directory: Absence
  readonly adminPath: string
  readonly admin: Absence
  readonly registered: boolean | undefined
}
const observeRemoval = (workspace: WorkspaceRecord): RemovalObservation => {
  let registered: boolean | undefined
  try {
    registered = registeredWorktrees(workspace.commonPath).includes(workspace.path)
  } catch {
    registered = undefined
  }
  return {
    directory: observeAbsence(workspace.path),
    adminPath: workspace.gitAdminPath,
    admin: observeAbsence(workspace.gitAdminPath, workspace.commonPath),
    registered,
  }
}
const removalComplete = (observation: RemovalObservation): boolean =>
  observation.directory === 'absent' &&
  observation.admin === 'absent' &&
  observation.registered === false
const registrationText = (registered: boolean | undefined): string => {
  if (registered === undefined) return 'worktree registration unreadable'
  return registered ? 'worktree still registered' : 'worktree not registered'
}
const observationText = (observation: RemovalObservation): string =>
  [
    describeAbsence('directory', observation.directory),
    describeAbsence(`Git admin directory ${observation.adminPath}`, observation.admin),
    registrationText(observation.registered),
  ].join('; ')

type AdminResidue =
  | {
      readonly kind: 'none' | 'empty' | 'outside' | 'not-directory' | 'not-empty'
    }
  | { readonly kind: 'unreadable'; readonly detail: string }
  | { readonly kind: 'named'; readonly worktree: string }
const adminResidue = (
  workspace: WorkspaceRecord,
  observation: RemovalObservation
): AdminResidue => {
  if (
    observation.directory !== 'absent' ||
    observation.admin !== 'present' ||
    observation.registered !== false
  )
    return { kind: 'none' }
  const path = workspace.gitAdminPath
  if (!isWithin(join(workspace.commonPath, 'worktrees'), path)) return { kind: 'outside' }
  let entries: string[]
  try {
    if (!lstatSync(path).isDirectory()) return { kind: 'not-directory' }
    entries = readdirSync(path)
  } catch (cause) {
    return { kind: 'unreadable', detail: errorText(cause) }
  }
  if (entries.length === 0) return { kind: 'empty' }

  try {
    const gitdir = readFileSync(join(path, 'gitdir'), 'utf8').trim()
    if (gitdir.length > 0 && dirname(gitdir) !== workspace.path)
      return { kind: 'named', worktree: dirname(gitdir) }
  } catch {}
  return { kind: 'not-empty' }
}
const keptResidue = (
  workspace: WorkspaceRecord,
  residue: AdminResidue,
  taskId: WorkspaceId
): { readonly reason: string; readonly nextAction: string } => {
  const path = workspace.gitAdminPath
  const release = `dev workspace release ${taskId}`
  switch (residue.kind) {
    case 'named':
      return {
        reason: `its admin directory ${path} still names a worktree at ${residue.worktree}, so Git may use it for a moved or re-registered worktree`,
        nextAction: `Check git worktree list: keep that worktree, or move it back to ${workspace.path} and run ${release}; dev never removes an admin directory Git may still use.`,
      }
    case 'unreadable':
      return {
        reason: `its admin directory ${path} cannot be read (${residue.detail})`,
        nextAction: `Make ${path} readable, then run ${release}.`,
      }
    case 'not-directory':
    case 'outside':
      return {
        reason: `its recorded admin path ${path} is ${residue.kind === 'outside' ? `outside ${join(workspace.commonPath, 'worktrees')}` : 'not a directory'}`,
        nextAction: `Inspect ${path}; dev only removes an empty admin directory of this repository.`,
      }
    default:
      return {
        reason: `its admin directory ${path} is not empty`,
        nextAction: `Inspect ${path}, remove it if nothing there is needed, then run ${release}.`,
      }
  }
}

const removalEffects = (
  workspace: WorkspaceRecord,
  before: RemovalObservation,
  after: RemovalObservation,
  removal: Removal
): string[] => {
  const effects: string[] = []
  if (before.directory === 'present' && after.directory === 'absent')
    effects.push(`removed worktree directory ${workspace.path}`)
  if (before.admin === 'present' && after.admin === 'absent') {
    if (before.registered !== false)
      effects.push(`removed Git registration ${workspace.gitAdminPath}`)
    else if (removal.status === 'done')
      effects.push(`removed the empty admin directory ${workspace.gitAdminPath}`)
  }
  if (before.registered === true && after.registered === false && after.admin === 'present')
    effects.push(
      `Git unregistered the worktree; its admin directory ${workspace.gitAdminPath} remains`
    )
  return effects
}
const observable = (observation: RemovalObservation): boolean =>
  typeof observation.directory === 'string' &&
  typeof observation.admin === 'string' &&
  observation.registered !== undefined

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
      `Unresolved workspace use(s) ${unknown.map(use => use.id).join(', ')} block every release effect; explicit recovery is not available yet.`
    )
    nextActions.push(
      'Keep the workspace; no release effect is possible until the unknown use is recovered.'
    )
  } else if (abandoned.length > 0) {
    reasons.push(
      `Use(s) ${abandoned.join(', ')} were left unsettled by dev sessions that have ended; their processes may still run.`
    )
    nextActions.push('Keep the workspace until those uses are recovered explicitly.')
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
const inUseOutcome = (uses: UseAssessment): WorkspaceAssessment['outcome'] =>
  (uses.live.length > 0 || uses.conversations > 0) &&
  uses.unknown.length === 0 &&
  uses.abandoned.length === 0
    ? 'active'
    : 'blocked'

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
  readonly evidence: InventoryVerdict | undefined
  readonly absent: boolean
}
interface Shaping {
  readonly outcome: WorkspaceAssessment['outcome']
  readonly effect: ReleaseSubject['effect']
  readonly stateDigest: string
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
export interface AssessmentContext {
  readonly moment: SweepMoment
  readonly own?: OwnConversation
  readonly excluded?: ReadonlySet<WorkspaceId>
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

const absentReason = (
  workspace: WorkspaceRecord,
  observation: RemovalObservation,
  residue: AdminResidue
): string => {
  if (observation.registered === true)
    return 'The managed worktree directory is absent while its Git registration and reservation remain; release reconciles both without deleting files.'
  if (residue.kind === 'empty')
    return `The managed worktree directory is absent and Git no longer registers it; release removes its empty admin directory ${workspace.gitAdminPath} and resolves the reservation.`
  if (observation.registered === false && observation.admin === 'absent')
    return 'The managed worktree directory and its Git registration are already gone; release records the observed absence and resolves the reservation.'
  return `The managed worktree directory is absent; ${observationText(observation)}.`
}

const DELIVER = [
  'Deliver the work (merge its pull request or integrate its commits) or keep the worktree; the sweep removes it once it is finished.',
]
const RETAINED: Record<
  RetainedReason,
  {
    readonly eligibility: 'blocked' | 'review-required'
    readonly sweep: SweepOutcome
    readonly actions: readonly string[]
  }
> = {
  'identity-unverifiable': {
    eligibility: 'review-required',
    sweep: 'retained',
    actions: [],
  },
  'transition-unresolved': {
    eligibility: 'review-required',
    sweep: 'retained',
    actions: [],
  },
  'release-review': {
    eligibility: 'review-required',
    sweep: 'review-required',
    actions: [],
  },
  excluded: { eligibility: 'blocked', sweep: 'skipped', actions: [] },
  'use-unknown': { eligibility: 'blocked', sweep: 'retained', actions: [] },
  'use-abandoned': { eligibility: 'blocked', sweep: 'retained', actions: [] },
  'use-live': { eligibility: 'blocked', sweep: 'retained', actions: [] },
  'directory-missing': { eligibility: 'review-required', sweep: 'retained', actions: [] },
  'residue-unreadable': {
    eligibility: 'review-required',
    sweep: 'retained',
    actions: ['Fix the reported read failure; the next sweep rechecks it.'],
  },
  'checkout-modified': {
    eligibility: 'blocked',
    sweep: 'retained',
    actions: [
      'Commit or clean the checkout; a clean checkout loses its reservation automatically when dev quits.',
    ],
  },
  skipped: { eligibility: 'blocked', sweep: 'skipped', actions: [] },
  'no-commits': { eligibility: 'blocked', sweep: 'retained', actions: DELIVER },
  'integration-unknown': {
    eligibility: 'review-required',
    sweep: 'retained',
    actions: [
      'Establish the missing fact (target, history or provider); the lead can record a target with the workspace tool, and dev never fetches or uploads for you.',
    ],
  },
  'not-integrated': {
    eligibility: 'blocked',
    sweep: 'retained',
    actions: DELIVER,
  },
}
const retainedActions = (verdict: CompletionVerdict): readonly string[] =>
  verdict.kind === 'finished' ? [] : RETAINED[verdict.retained].actions

const assessWorkspace = (
  authority: WorkspaceAuthority,
  db: DatabaseSync,
  repo: WorkspaceId,
  reservation: ReservationRecord,
  workspace: WorkspaceRecord,
  readers: EvidenceReaders,
  context: AssessmentContext,
  siblings: Siblings,
  removalClosed: boolean
): Assessed => {
  const identity = assessIdentity(authority, workspace)
  const head =
    identity.kind === 'verified' && identity.git.head.length > 0 ? identity.git.head : undefined
  const absent = identity.kind === 'absent'
  const open = openOperations(db, workspace.id)
  const preface = open
    .filter(operation => operation.phase === 'intent')
    .map(operation =>
      operation.kind === 'release'
        ? `An unstarted release intent ${operation.id} is recorded; a fresh release supersedes it and never replays it.`
        : `An unstarted ${operation.kind} intent ${operation.id} is recorded; release neither waits for it nor replays it.`
    )
  const unresolvedTransitions = open.filter(
    operation => operation.kind !== 'release' && operation.phase !== 'intent'
  )
  const interruptedReleases = open.filter(isUnresolvedRelease)
  const engineRecorded = open.some(isEngineRecordedRelease)
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
    removalInterrupted:
      removalClosed ||
      interruptedReleases.some(
        operation => operation.effect === 'remove-worktree' && operation.phase === 'started'
      ),
    releaseReview: false,
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
  const decide = (facts: CompletionFacts) => {
    const underlying = decideCompletion(facts)
    return {
      underlying,
      reported: engineRecorded ? decideCompletion({ ...facts, releaseReview: true }) : underlying,
    }
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
  const shape = (shaping: Shaping): Assessed => ({
    assessment: {
      repositoryId: repo,
      taskId: reservation.taskId,
      workspaceId: workspace.id,
      reservationId: reservation.id,
      path: workspace.path,
      origin: workspace.origin,
      outcome: shaping.outcome,
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
      completion: shaping.completion ?? decide(factsBase).reported,
      subject: {
        repositoryId: repo,
        workspaceId: workspace.id,
        reservationId: reservation.id,
        reservationRevision: reservation.revision,
        ...(reservation.acquisitionId === undefined
          ? {}
          : { acquisitionId: reservation.acquisitionId }),
        workspaceRevision: workspace.revision,
        origin: workspace.origin,
        path: workspace.path,
        policyVersion: EVIDENCE_POLICY_VERSION,
        effect: shaping.effect,
        ...(head === undefined ? {} : { head }),
        stateDigest: shaping.stateDigest,
      },
    },
    reservation,
    workspace,
    evidence: shaping.evidence,
    absent,
  })
  const bareDigest = stateDigestOf({
    head,
    inventory: undefined,
    targetTip: undefined,
    publications: [],
    absent,
  })
  if (identity.kind === 'unverifiable')
    return shape({
      outcome: 'review-required',
      effect: 'none',
      stateDigest: bareDigest,
      reasons: [identity.reason],
      nextActions: [
        'Inspect the workspace identity; release does not remove a replaced or unverifiable path.',
      ],
    })
  if (unresolvedTransitions.length > 0)
    return shape({
      outcome: 'review-required',
      effect: 'none',
      stateDigest: bareDigest,
      reasons: unresolvedTransitions.map(
        operation =>
          `Operation ${operation.id} (${operation.kind}) is ${operation.phase}${operation.result === undefined ? '' : `: ${operation.result}`}`
      ),
      nextActions: ['Observe the recorded effect before any further release; nothing is replayed.'],
    })

  const withInterruption = (shaping: Shaping): Shaping => {
    if (interruptedReleases.length === 0) return shaping
    const observes = shaping.effect === 'remove-worktree'
    const observer = engineRecorded
      ? `dev workspace release ${reservation.taskId}`
      : `The next sweep, or dev workspace release ${reservation.taskId},`
    return {
      ...shaping,
      outcome: 'review-required',
      reasons: [
        ...interruptedReleases.map(
          operation =>
            `Release ${operation.id} was interrupted while ${operation.phase}${operation.result === undefined ? '' : ` (${operation.result})`}; ${observes ? 'a fresh release first observes what it did and closes it, then re-evaluates the current state' : 'a release observes it once the state below is resolved'}.`
        ),
        ...shaping.reasons,
      ],
      nextActions: [
        ...(observes ? [`${observer} observes the interrupted release; nothing is replayed.`] : []),
        ...shaping.nextActions,
      ],
    }
  }
  if (absent) {
    const observation = observeRemoval(workspace)
    const residue = adminResidue(workspace, observation)
    if (residue.kind !== 'none' && residue.kind !== 'empty') {
      const kept = keptResidue(workspace, residue, reservation.taskId)
      return shape(
        withInterruption({
          outcome: 'review-required',
          effect: 'none',
          stateDigest: bareDigest,
          reasons: [
            `The managed worktree directory is absent and Git does not list it, but ${kept.reason}; release never deletes it.`,
          ],
          nextActions: [kept.nextAction],
        })
      )
    }
    return shape(
      withInterruption({
        outcome: 'review-required',
        effect: 'remove-worktree',
        stateDigest: bareDigest,
        reasons: [absentReason(workspace, observation, residue)],
        nextActions: [
          decide(factsBase).reported.kind === 'finished'
            ? `The next sweep, or dev workspace release ${reservation.taskId}, records the observed absence.`
            : `Confirm the directory was meant to go, then run dev workspace release ${reservation.taskId} to record the absence; the sweep settles only an absence its own interrupted removal caused.`,
        ],
      })
    )
  }
  if (workspace.origin === 'pre-existing') {
    let inventory: Inventory | undefined
    const reasons = [...uses.reasons]
    try {
      inventory = readInventory(workspace.path, head)
    } catch (cause) {
      reasons.push(`Residual changes could not be read: ${errorText(cause)}`)
    }
    const { reported } = decide({
      ...factsBase,
      ...(inventory === undefined ? {} : { residue: residueOf(inventory) }),
    })
    const stateDigest = stateDigestOf({
      head,
      inventory: undefined,
      targetTip: undefined,
      publications: [],
    })
    const residual = residualOf(inventory, head)
    if (uses.inUse)
      return shape(
        withInterruption({
          outcome: inUseOutcome(uses),
          effect: 'none',
          stateDigest,
          reasons,
          nextActions: uses.nextActions,
          residual,
          completion: reported,
        })
      )
    return shape(
      withInterruption({
        outcome: 'releasable',
        effect: 'release-reservation',
        stateDigest,
        reasons: [
          ...reasons,
          'Pre-existing checkout: release ends only the task reservation; files and commits stay untouched and no integration or publication proof is required.',
          reported.reason,
        ],
        nextActions:
          reported.kind === 'finished'
            ? ['Quitting dev releases this reservation automatically; files and commits stay.']
            : retainedActions(reported),
        residual,
        completion: reported,
      })
    )
  }
  let evidence: InventoryVerdict
  let branch: string | undefined
  let ownCommits: boolean | undefined
  const publications = getPublications(db, reservation.taskId).filter(
    reference => reference.workspaceId === undefined || reference.workspaceId === workspace.id
  )
  try {
    evidence = verifyInventory(workspace.path, publications, readInventory(workspace.path, head))
    branch = symbolicBranch(workspace.path)
    ownCommits = ownCommitsOf(workspace.path, head, allocation.base)
  } catch (cause) {
    return shape(
      withInterruption({
        outcome: 'review-required',
        effect: 'none',
        stateDigest: bareDigest,
        reasons: [...uses.reasons, `Evidence could not be read: ${errorText(cause)}`],
        nextActions: ['Fix the reported read failure and check again.'],
      })
    )
  }
  const residue = residueOf(evidence.inventory)
  const override = getTask(db, reservation.taskId)?.target
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
  let targetTip: string | undefined
  if (!uses.inUse && needsIntegration(residue, ownCommits)) {
    const derived = deriveTarget(readers.github, workspace.path, override, branch)
    target = describeTarget(derived)
    if (derived.source === 'none') integration = integrationUnknown(derived.reason)
    else
      try {
        const facts = integrationFacts(readers.github, workspace.path, {
          target: derived.target,
          head,
          base: allocation.base,
          allocatedAt: allocation.allocatedAt,
          siblings,
        })
        integration = facts
        targetTip = facts.tip
      } catch (cause) {
        integration = integrationUnknown(`Integration could not be read: ${errorText(cause)}`)
      }
  }
  const { reported, underlying } = decide({
    ...factsBase,
    branch,
    residue,
    ownCommits,
    integration,
  })
  const common = {
    stateDigest: stateDigestOf({
      head,
      inventory: evidence.inventory,
      targetTip,
      publications,
    }),
    evidence,
    residual: residualOf(evidence.inventory, head),
    completion: reported,
    target,
  }
  if (uses.inUse)
    return shape(
      withInterruption({
        ...common,
        outcome: inUseOutcome(uses),
        effect: 'none',
        reasons: uses.reasons,
        nextActions: uses.nextActions,
      })
    )
  if (evidence.verdict !== 'valid')
    return shape(
      withInterruption({
        ...common,
        outcome: evidence.verdict === 'invalid' ? 'blocked' : 'review-required',
        effect: 'none',
        reasons: [...uses.reasons, ...evidence.reasons, underlying.reason],
        nextActions: [
          evidence.verdict === 'invalid'
            ? 'Resolve each blocker (publish the selected artifact again, resolve the conflict or remove the nested repository), then check again.'
            : 'Resolve each unsupported or unreadable entry, then check again; dev never deletes what it cannot inspect.',
        ],
      })
    )
  if (underlying.kind === 'finished')
    return shape(
      withInterruption({
        ...common,
        outcome: 'removable',
        effect: 'remove-worktree',
        reasons: [
          ...uses.reasons,
          underlying.reason,
          `Eligible at this check; nothing removed; the sweep rechecks. ${evidence.counts.published} published file(s) are recorded for deletion; Git removes remaining disposable worktree contents.`,
        ],
        nextActions: [
          'Quitting dev, or the next managed worktree allocation, removes it automatically.',
        ],
      })
    )
  return shape(
    withInterruption({
      ...common,
      outcome: RETAINED[underlying.retained].eligibility,
      effect: 'none',
      reasons: [...uses.reasons, underlying.reason],
      nextActions: retainedActions(underlying),
    })
  )
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
const taskSiblings = (
  authority: WorkspaceAuthority,
  taskId: WorkspaceId,
  entries: ReturnType<typeof taskWorkspaces>
): ((workspaceId: WorkspaceId) => Siblings) => {
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
  const siblingsFor = taskSiblings(authority, taskId, entries)
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
        siblingsFor(workspace.id),
        false
      )
    )
  )
}

const withDeletionHistory = (
  authority: WorkspaceAuthority,
  assessment: WorkspaceAssessment
): WorkspaceAssessment => ({
  ...assessment,
  reasons: [
    ...assessment.reasons,
    ...inDb(authority, assessment.repositoryId, db => deletionHistory(db, assessment.workspaceId)),
  ],
})

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
  }).map(({ assessment }) => withDeletionHistory(authority, assessment))
}

const changedFields = (
  decided: ReleaseSubject,
  fresh: ReleaseSubject
): readonly (keyof ReleaseSubject)[] =>
  RELEASE_SUBJECT_FIELDS.filter(key => decided[key] !== fresh[key])
const describeChange = (
  key: keyof ReleaseSubject,
  decided: ReleaseSubject,
  fresh: ReleaseSubject
): string => {
  if (key === 'stateDigest') return 'files, Git state, target tip or publications'
  if (key === 'head') return `HEAD (${short(decided.head)} -> ${short(fresh.head)})`
  return key
}

const releaseResult = (
  assessment: WorkspaceAssessment,
  outcome: WorkspaceReleaseResult['outcome'],
  reason: string,
  nextAction: string,
  effects: readonly string[] = [],
  retained: readonly string[] = [],
  operationId?: WorkspaceId
): WorkspaceReleaseResult => ({
  repositoryId: assessment.repositoryId,
  workspaceId: assessment.workspaceId,
  path: assessment.path,
  origin: assessment.origin,
  outcome,
  reason,
  nextAction,
  effects,
  retained,
  ...(operationId === undefined ? {} : { operationId }),
})
const subjectResult = (
  subject: ReleaseSubject,
  outcome: WorkspaceReleaseResult['outcome'],
  reason: string,
  nextAction: string
): WorkspaceReleaseResult => ({
  repositoryId: subject.repositoryId,
  workspaceId: subject.workspaceId,
  path: subject.path,
  origin: subject.origin,
  outcome,
  reason,
  nextAction,
  effects: [],
  retained: [],
})

const commandSpent = (
  db: DatabaseSync,
  commandId: WorkspaceId,
  workspaceId: WorkspaceId
): boolean =>
  releaseOperations(db, workspaceId).some(operation => operation.commandId === commandId)

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

const releaseOperationBase = (
  assessed: Assessed,
  commandId: WorkspaceId,
  decider: ReleaseDecider
) => {
  const { assessment, workspace, reservation } = assessed
  return {
    id: newId(),
    kind: 'release' as const,
    repositoryId: assessment.repositoryId,
    workspaceId: workspace.id,
    taskId: reservation.taskId,
    reservationId: reservation.id,
    ...(reservation.acquisitionId === undefined
      ? {}
      : { acquisitionId: reservation.acquisitionId }),
    commandId,
    decider,
    targetPath: workspace.path,
    ...(assessment.subject.head === undefined ? {} : { head: assessment.subject.head }),
    stateDigest: assessment.subject.stateDigest,
    policyVersion: assessment.subject.policyVersion,
    expectedReservationRevision: reservation.revision,
    createdAt: now(),
  }
}

const steps = (states: readonly ReleaseStep['state'][]): ReleaseStep[] =>
  (['selected-files', 'git-worktree-remove', 'registration', 'records'] as const).map(
    (kind, index) => ({ kind, state: states[index] ?? 'pending' })
  )
const withStep = (
  operation: WorktreeRemovalRecord,
  kind: ReleaseStep['kind'],
  state: ReleaseStep['state'],
  detail?: string
): WorktreeRemovalRecord => ({
  ...operation,
  steps: operation.steps.map(step =>
    step.kind === kind ? { kind, state, ...(detail === undefined ? {} : { detail }) } : step
  ),
})
const save = (
  authority: WorkspaceAuthority,
  repo: WorkspaceId,
  operation: ReleaseOperationRecord
): void => inDb(authority, repo, db => transaction(db, () => saveOperation(db, operation)))

const recordRemoved = (
  db: DatabaseSync,
  reservation: ReservationRecord,
  workspace: WorkspaceRecord,
  operation: WorktreeRemovalRecord,
  moment: string
): void => {
  const current = requireCurrentReservation(db, reservation, moment)
  deleteReservation(db, current)
  const stored = getWorkspace(db, workspace.id)
  if (stored === undefined || stored.revision !== workspace.revision)
    requireReview(`Workspace record changed ${moment}`)
  saveWorkspace(db, {
    ...stored,
    status: 'removed',
    removalOperationId: operation.id,
    revision: stored.revision + 1,
  })
  saveOperation(db, operation)
}

interface Deletion {
  readonly entries: ManifestEntry[]
  readonly effects: string[]
  readonly failed?: ManifestEntry
}
const deleteSelected = (
  checkout: string,
  manifest: readonly ManifestEntry[],
  root: PhysicalObservation | undefined
): Deletion => {
  const entries = manifest.map(entry => ({ ...entry }))
  const effects: string[] = []
  for (const entry of entries) {
    const check =
      root === undefined ? { state: 'absent' as const } : entryUnchanged(checkout, entry, root)
    if (check.state === 'absent') {
      entry.state = 'absent'
      continue
    }
    if (check.state === 'changed') {
      entry.state = 'failed'
      entry.detail = check.detail
      return { entries, effects, failed: entry }
    }
    try {
      unlinkSync(join(checkout, entry.path))
      entry.state = 'removed'
      effects.push(`deleted ${entry.path}`)
    } catch (cause) {
      entry.state = 'failed'
      entry.detail = errorText(cause)
      return { entries, effects, failed: entry }
    }
  }
  return { entries, effects }
}

interface Removal {
  readonly status: 'done' | 'failed'
  readonly detail: string
}

const runRemoval = (workspace: WorkspaceRecord, before: RemovalObservation): Removal => {
  if (adminResidue(workspace, before).kind === 'empty')
    try {
      rmdirSync(workspace.gitAdminPath)
      return {
        status: 'done',
        detail: `removed the empty admin directory ${workspace.gitAdminPath}`,
      }
    } catch (cause) {
      return {
        status: 'failed',
        detail: `the empty admin directory ${workspace.gitAdminPath} could not be removed: ${errorText(cause)}`,
      }
    }
  const git = removeWorktree(workspace.commonPath, workspace.path)
  return git.status === 0
    ? { status: 'done', detail: 'git worktree remove exited 0' }
    : {
        status: 'failed',
        detail: `git worktree remove --force failed: ${git.stderr.trim() || `exit ${git.status ?? 'signal'}`}`,
      }
}

const incompleteEnding = (input: {
  readonly workspace: WorkspaceRecord
  readonly taskId: WorkspaceId
  readonly removal: Removal
  readonly done: readonly string[]
  readonly before: RemovalObservation
  readonly after: RemovalObservation
}): {
  readonly phase: WorktreeRemovalRecord['phase']
  readonly outcome: WorkspaceReleaseResult['outcome']
  readonly reason: string
  readonly nextAction: string
} => {
  const { workspace, taskId, removal, done, before, after } = input
  const residual = observationText(after)
  if (removal.status === 'failed' && done.length === 0 && observationText(before) === residual)
    return {
      phase: 'cancelled',
      outcome: 'blocked',
      reason: `The removal was refused and nothing was changed: ${removal.detail}`,
      nextAction:
        'Resolve what refused it, for example new untracked or modified files or a permission, then check and release again.',
    }
  if (!observable(after))
    return {
      phase: 'unknown',
      outcome: 'review-required',
      reason: `The removal did not complete and what remains cannot be observed: ${residual}`,
      nextAction:
        'Make the directory and repository readable; a fresh release then observes this attempt and never replays it.',
    }
  let nextAction = `Inspect what remains (${residual}); a fresh release observes this attempt and never replays it.`
  if (after.directory === 'present' && after.registered === false)
    nextAction = `The directory ${workspace.path} remains but Git no longer lists it, and dev never deletes an unregistered directory: inspect it, remove it yourself if nothing there is needed, then run dev workspace release ${taskId}.`
  else if (adminResidue(workspace, after).kind === 'empty')
    nextAction = `Resolve what stopped the removal, for example a permission on ${dirname(workspace.gitAdminPath)}, then run dev workspace release ${taskId}: it removes the empty admin directory ${workspace.gitAdminPath}.`
  return {
    phase: 'review-required',
    outcome: 'partial',
    reason: `The removal did not complete (${removal.detail}): ${residual}`,
    nextAction,
  }
}

const removeManagedWorktree = (
  authority: WorkspaceAuthority,
  repo: WorkspaceId,
  assessed: Assessed,
  commandId: WorkspaceId,
  decider: ReleaseDecider,
  manifest: readonly ManifestEntry[]
): WorkspaceReleaseResult => {
  const { assessment, workspace, reservation, absent } = assessed
  const checkout = workspace.path
  const before = observeRemoval(workspace)
  if (before.registered === undefined)
    return releaseResult(
      assessment,
      'review-required',
      'The Git worktree registration could not be read; nothing was changed.',
      'Inspect the repository with git worktree list, then release again.'
    )
  if (!before.registered && !absent)
    return releaseResult(
      assessment,
      'review-required',
      'The directory exists but Git no longer registers it as a worktree of this repository; nothing was changed.',
      'Inspect the directory and the repository registration before any removal.'
    )
  if (before.registered) {
    const lockReason = worktreeLockReason(workspace.commonPath, workspace.path)
    if (lockReason !== undefined)
      return releaseResult(
        assessment,
        'blocked',
        `Git has locked this worktree${lockReason.length > 0 ? ` (${lockReason})` : ''}; nothing was changed.`,
        'Unlock it with Git only if it is safe to do so, then check and release again.'
      )
  }
  let removalRoot: PhysicalObservation | undefined
  if (before.directory !== 'absent') {
    try {
      removalRoot = observePhysicalIdentity(checkout)
    } catch (cause) {
      return releaseResult(
        assessment,
        'review-required',
        `The checkout's volume identity could not be verified; nothing was changed: ${errorText(cause)}`,
        'Resolve the filesystem identity observation failure, then check and release again.'
      )
    }
    if (
      removalRoot.identity.volumeUuid !== workspace.physical.volumeUuid ||
      removalRoot.identity.inode !== workspace.physical.inode
    )
      return releaseResult(
        assessment,
        'review-required',
        'The checkout physical identity changed before removal; nothing was changed.',
        'Inspect the managed checkout and its recorded identity before any removal.'
      )
  }
  const intent: WorktreeRemovalRecord = {
    ...releaseOperationBase(assessed, commandId, decider),
    phase: 'intent',
    effect: 'remove-worktree',
    gitAdminPath: workspace.gitAdminPath,
    manifest: [...manifest],
    steps: steps([]),
  }
  inDb(authority, repo, db =>
    transaction(db, () => {
      requireCurrentReservation(db, reservation, 'before the release intent was recorded')
      cancelUnstartedReleases(db, workspace.id, `Superseded by release command ${commandId}`)
      putOperation(db, intent)
    })
  )
  let operation = withStep({ ...intent, phase: 'started' }, 'selected-files', 'started')
  save(authority, repo, operation)
  const deleted = deleteSelected(checkout, operation.manifest, removalRoot)
  const { effects } = deleted
  if (deleted.failed !== undefined) {
    const { failed } = deleted
    operation = withStep(
      {
        ...operation,
        manifest: deleted.entries,
        phase: 'review-required',
        result: `Selected file ${failed.path} ${failed.detail ?? 'changed since the check'}; deletion stopped.`,
      },
      'selected-files',
      'failed',
      failed.detail
    )
    save(authority, repo, operation)
    return releaseResult(
      assessment,
      effects.length > 0 ? 'partial' : 'blocked',
      `Selected file ${failed.path} changed since the check (${failed.detail ?? 'identity differs'}); deletion stopped before it.`,
      'Check the workspace again; a fresh release observes this attempt, then recomputes the selection and never resumes it.',
      effects,
      [
        `kept ${failed.path} (${failed.detail ?? 'changed'})`,
        ...deleted.entries
          .filter(entry => entry.state === 'pending')
          .map(entry => `kept ${entry.path} (not attempted)`),
        'worktree directory and Git registration retained',
        'reservation retained',
      ],
      operation.id
    )
  }
  operation = withStep(
    withStep({ ...operation, manifest: deleted.entries }, 'selected-files', 'done'),
    'git-worktree-remove',
    'started'
  )
  save(authority, repo, operation)
  const removal = runRemoval(workspace, before)
  const after = observeRemoval(workspace)
  const done = [...effects, ...removalEffects(workspace, before, after, removal)]
  if (removalComplete(after)) {
    const confirmed: WorktreeRemovalRecord = withStep(
      withStep(
        withStep(
          {
            ...operation,
            phase: 'confirmed',
            observed: absent ? 'already-absent' : 'removed',
            result: `${absent ? 'Observed the already absent directory' : 'Observed the worktree directory removed'}; Git registration ${workspace.gitAdminPath} removed; reservation ${reservation.id} resolved. ${removal.detail}.`,
          },
          'git-worktree-remove',
          'done',
          removal.detail
        ),
        'registration',
        'observed',
        observationText(after)
      ),
      'records',
      'done'
    )
    try {
      inDb(authority, repo, db =>
        transaction(db, () =>
          recordRemoved(
            db,
            reservation,
            workspace,
            confirmed,
            'while the worktree was being removed'
          )
        )
      )
    } catch (cause) {
      const unrecorded = withStep(
        {
          ...operation,
          phase: 'review-required',
          result: `Worktree removal observed complete, but its records were not updated: ${errorText(cause)}`,
        },
        'records',
        'failed',
        errorText(cause)
      )
      try {
        save(authority, repo, unrecorded)
      } catch {}
      return releaseResult(
        assessment,
        'partial',
        `The worktree and its registration were removed, but the reservation record could not be updated: ${errorText(cause)}`,
        'Run a fresh release; it observes the completed removal and resolves the records.',
        done,
        ['reservation record retained until observed by a fresh release'],
        unrecorded.id
      )
    }
    return releaseResult(
      assessment,
      absent ? 'already-absent' : 'removed',
      absent
        ? 'The directory was already absent; its Git registration and reservation are now resolved and the absence is recorded.'
        : 'The managed worktree, its Git registration and its reservation were verified removed.',
      'Nothing remains to do for this workspace; do not resume a conversation into it.',
      [...done, `resolved reservation ${reservation.id}`],
      [],
      confirmed.id
    )
  }
  const residual = observationText(after)
  const ending = incompleteEnding({
    workspace,
    taskId: reservation.taskId,
    removal,
    done,
    before,
    after,
  })
  operation = withStep(
    withStep(
      {
        ...operation,
        phase: ending.phase,
        result: `${removal.detail}. ${residual}`,
      },
      'git-worktree-remove',
      removal.status,
      removal.detail
    ),
    'registration',
    'observed',
    residual
  )
  save(authority, repo, operation)
  return releaseResult(
    assessment,
    ending.outcome,
    ending.reason,
    ending.nextAction,
    done,
    [residual, 'reservation retained'],
    operation.id
  )
}

const releaseReservation = (
  authority: WorkspaceAuthority,
  repo: WorkspaceId,
  assessed: Assessed,
  commandId: WorkspaceId,
  decider: ReleaseDecider
): WorkspaceReleaseResult => {
  const { assessment, workspace, reservation } = assessed
  const operation: ReleaseOperationRecord = {
    ...releaseOperationBase(assessed, commandId, decider),
    phase: 'confirmed',
    effect: 'release-reservation',
    result: `Reservation ${reservation.id} released; files and commits unchanged.${assessment.residual.length > 0 ? ` Residual: ${assessment.residual.join('; ')}` : ''}`,
  }
  inDb(authority, repo, db =>
    transaction(db, () => {
      const current = requireCurrentReservation(db, reservation, 'before its release was recorded')
      cancelUnstartedReleases(db, workspace.id, `Superseded by release command ${commandId}`)
      putOperation(db, operation)
      deleteReservation(db, current)
    })
  )
  return releaseResult(
    assessment,
    'released',
    `Reservation ${reservation.id} of task ${reservation.taskId} was released; files and commits are unchanged.`,
    'The checkout is free for another task; residual changes remain yours to keep or commit.',
    [`released reservation ${reservation.id}`],
    assessment.residual.map(item => `unchanged: ${item}`),
    operation.id
  )
}
type Reconciliation =
  | { readonly kind: 'nothing' }
  | { readonly kind: 'completed' }
  | { readonly kind: 'closed'; readonly removalStarted: boolean }
  | { readonly kind: 'unobservable'; readonly reason: string }
const reconcileInterruptedReleases = (
  authority: WorkspaceAuthority,
  repo: WorkspaceId,
  reservation: ReservationRecord,
  workspace: WorkspaceRecord,
  commandId: WorkspaceId
): Reconciliation => {
  const interrupted = inDb(authority, repo, db => unresolvedReleases(db, workspace.id))
  if (interrupted.length === 0) return { kind: 'nothing' }
  let observedComplete = false
  let removalStarted = false
  for (const operation of interrupted) {
    if (operation.effect === 'release-reservation') {
      inDb(authority, repo, db =>
        transaction(db, () =>
          saveOperation(db, {
            ...operation,
            phase: 'cancelled',
            result: `Observed after interruption: reservation ${getReservation(db, workspace.id) === undefined ? 'gone' : 'still held'}; superseded by release command ${commandId}.`,
          })
        )
      )
      continue
    }
    const observation = observeRemoval(workspace)
    if (!observable(observation))
      return { kind: 'unobservable', reason: observationText(observation) }
    let root: PhysicalObservation | undefined
    if (observation.directory === 'present')
      try {
        root = observePhysicalIdentity(workspace.path)
      } catch (cause) {
        return { kind: 'unobservable', reason: errorText(cause) }
      }
    const manifest = operation.manifest.map(entry => {
      if (entry.state !== 'pending' && entry.state !== 'failed') return entry
      if (root === undefined) return { ...entry, state: 'absent' as const }
      const check = entryUnchanged(workspace.path, entry, root)
      if (check.state === 'absent') return { ...entry, state: 'absent' as const }
      if (check.state === 'same') return { ...entry, detail: 'present' }
      return { ...entry, detail: check.detail }
    })
    if (removalComplete(observation)) {
      const completed: WorktreeRemovalRecord = withStep(
        {
          ...operation,
          manifest,
          phase: 'confirmed',
          observed: 'already-absent',
          result: `Observed complete after interruption: ${observationText(observation)}; reservation ${reservation.id} resolved by release command ${commandId}.`,
        },
        'registration',
        'observed',
        observationText(observation)
      )
      inDb(authority, repo, db =>
        transaction(db, () =>
          recordRemoved(
            db,
            reservation,
            workspace,
            completed,
            'while an interrupted removal was reconciled'
          )
        )
      )
      observedComplete = true
      continue
    }
    if (operation.phase === 'started') removalStarted = true
    const present = manifest.filter(entry => entry.state !== 'removed' && entry.state !== 'absent')
    inDb(authority, repo, db =>
      transaction(db, () =>
        saveOperation(
          db,
          withStep(
            {
              ...operation,
              manifest,
              phase: 'cancelled',
              result: `Observed incomplete after interruption: ${observationText(observation)}; ${manifest.length - present.length} selected file(s) gone, ${present.length} present. Superseded by release command ${commandId}.`,
            },
            'registration',
            'observed',
            observationText(observation)
          )
        )
      )
    )
  }
  return observedComplete ? { kind: 'completed' } : { kind: 'closed', removalStarted }
}

const scopeOf = (
  authority: WorkspaceAuthority,
  request: ReleaseRequest,
  decidedIds: ReadonlySet<WorkspaceId>
): ReturnType<typeof taskWorkspaces> => {
  const current = taskWorkspaces(authority, request.taskId)
  const added = current.filter(item => !decidedIds.has(item.workspace.id))
  if (added.length > 0)
    invalid(
      `The scope of task ${request.taskId} changed after the decision: workspace(s) ${added
        .map(item => `${item.workspace.id} at ${item.workspace.path}`)
        .join(', ')} were added or rebound.`
    )
  return current
}

const noReservation = (subject: ReleaseSubject, taskId: WorkspaceId): WorkspaceReleaseResult =>
  subjectResult(
    subject,
    'blocked',
    `Task ${taskId} no longer holds a reservation on workspace ${subject.workspaceId}; nothing was changed.`,
    'Inspect the task; another command may have released or removed it.'
  )

const attemptUnderGates = (
  authority: WorkspaceAuthority,
  request: ReleaseRequest,
  subject: ReleaseSubject,
  gated: ReturnType<typeof taskWorkspaces>[number],
  readers: EvidenceReaders,
  context: AssessmentContext
): WorkspaceReleaseResult => {
  const { repo } = gated
  const automatic = request.decider.kind === 'completion'
  if (automatic) {
    const recorded = inDb(authority, repo, db => openOperations(db, gated.workspace.id)).filter(
      isEngineRecordedRelease
    )
    if (recorded.length > 0)
      return subjectResult(
        subject,
        'review-required',
        `Release ${recorded.map(operation => `${operation.id} (${operation.phase})`).join(', ')} needs review; only an explicit release observes it, so nothing was attempted automatically.`,
        `Run dev workspace release ${request.taskId} to observe it; nothing is replayed.`
      )
  }
  const gatedUses = inDb(authority, repo, db => getUseRows(db, gated.workspace.id))
  const mayReconcile =
    subject.effect === 'remove-worktree' &&
    gatedUses.every(use => use.stage !== 'unknown') &&
    inDb(authority, repo, db => abandonedUseIds(authority, db, gatedUses)).length === 0
  const reconciled: Reconciliation = mayReconcile
    ? reconcileInterruptedReleases(
        authority,
        repo,
        gated.reservation,
        gated.workspace,
        request.commandId
      )
    : { kind: 'nothing' }
  if (reconciled.kind === 'unobservable')
    return subjectResult(
      subject,
      'review-required',
      `An interrupted release of this workspace cannot be observed yet (${reconciled.reason}); nothing was changed.`,
      'Make the directory and repository readable, then release again.'
    )
  if (reconciled.kind === 'completed')
    return subjectResult(
      subject,
      'already-absent',
      'After an interrupted removal the worktree directory, its Git registration and its worktree list entry were all observed gone; the reservation is now resolved and the observation recorded.',
      'Nothing remains to do for this workspace; do not resume a conversation into it.'
    )
  const siblings = taskSiblings(
    authority,
    request.taskId,
    taskWorkspaces(authority, request.taskId)
  )(gated.workspace.id)
  const assessed = inDb(authority, repo, db =>
    assessWorkspace(
      authority,
      db,
      repo,
      gated.reservation,
      gated.workspace,
      readers,
      context,
      siblings,
      reconciled.kind === 'closed' && reconciled.removalStarted
    )
  )
  const fresh = assessed.assessment

  const changed = changedFields(subject, fresh.subject)
  if (changed.length > 0)
    return releaseResult(
      fresh,
      'blocked',
      `The workspace changed after the ${automatic ? 'sweep assessed it' : 'subject check'} (${changed
        .map(key => describeChange(key, subject, fresh.subject))
        .join(', ')}); nothing was changed.`,
      automatic
        ? 'The next sweep assesses the current state again.'
        : 'Run check and release again against the current state.'
    )
  if (automatic && fresh.completion.kind !== 'finished')
    return releaseResult(
      fresh,
      'blocked',
      `It is no longer finished (${fresh.completion.reason}); nothing was changed.`,
      'The next sweep assesses it again.'
    )
  if (
    subject.effect === 'none' ||
    (fresh.outcome !== 'releasable' && fresh.outcome !== 'removable' && !assessed.absent)
  )
    return releaseResult(
      fresh,
      fresh.outcome === 'review-required' ? 'review-required' : 'blocked',
      fresh.reasons.join(' ') || 'The workspace is not eligible for any release effect.',
      fresh.nextActions.join(' ') || 'Resolve the blockers and release again.'
    )
  const liveUses = inDb(authority, repo, db =>
    getUseRows(db, gated.workspace.id).filter(isActiveUse)
  )
  if (liveUses.length > 0)
    return releaseResult(
      fresh,
      'blocked',
      `Workspace use(s) ${liveUses.map(use => use.id).join(', ')} are still recorded as live; nothing was changed.`,
      'Wait for their observed cessation or recover them explicitly, then release again.'
    )
  if (subject.effect === 'remove-worktree') {
    const inside = request.occupiedPaths.filter(cwd => isWithin(gated.workspace.path, cwd))
    if (inside.length > 0)
      return releaseResult(
        fresh,
        'blocked',
        `A shell or launcher working directory, or the conversation being closed, is still inside this worktree (${inside.join(', ')}); nothing was changed.`,
        'Leave the directory and quit or release again from outside it.'
      )
    let releaseInstallation: GateRelease
    try {
      releaseInstallation = holdExistingInstallationForRemoval(fresh.path)
    } catch (cause) {
      return releaseResult(
        fresh,
        'blocked',
        `Target installation coordination is active or unverifiable (${errorText(cause)}); no task files were removed.`,
        'Stop the target installation and inspect its coordination state before a fresh release.'
      )
    }
    try {
      return removeManagedWorktree(
        authority,
        repo,
        assessed,
        request.commandId,
        request.decider,
        assessed.evidence?.manifest ?? []
      )
    } finally {
      releaseInstallation()
    }
  }
  return releaseReservation(authority, repo, assessed, request.commandId, request.decider)
}

const releaseDecidedWorkspace = (
  authority: WorkspaceAuthority,
  request: ReleaseRequest,
  readers: EvidenceReaders,
  context: AssessmentContext,
  decidedIds: ReadonlySet<WorkspaceId>
): WorkspaceReleaseResult => {
  if (request.decided.length === 0) invalid('A release needs the decided assessment it is bound to')
  const subject = request.decided.find(item => item.workspaceId === request.workspaceId)
  if (subject === undefined)
    invalid(`Workspace ${request.workspaceId} is not part of the decided release scope`)
  authority.initialize()
  const knownRepository = authority
    .listRepositories()
    .some(repository => repository.id === subject.repositoryId)
  if (
    knownRepository &&
    inDb(authority, subject.repositoryId, db =>
      commandSpent(db, request.commandId, request.workspaceId)
    )
  )
    invalid(
      `Release command ${request.commandId} already attempted workspace ${request.workspaceId}; a repeated release is a fresh command`
    )

  const reported = (result: WorkspaceReleaseResult): WorkspaceReleaseResult => {
    const earlier = knownRepository
      ? inDb(authority, subject.repositoryId, db =>
          deletionHistory(db, subject.workspaceId, request.commandId)
        )
      : []
    return earlier.length === 0
      ? result
      : { ...result, reason: [result.reason, ...earlier].join(' ') }
  }
  const entry = scopeOf(authority, request, decidedIds).find(
    item => item.workspace.id === request.workspaceId
  )
  if (entry === undefined) return reported(noReservation(subject, request.taskId))
  const { repo } = entry
  let structure: GateRelease | undefined
  let gates: PathGates | undefined
  try {
    if (entry.workspace.origin === 'managed')
      structure = acquireStructureGate(authority.paths, entry.workspace, repo)
    gates = acquirePathGates(authority.paths, entry.workspace.path, 'removal')
  } catch (cause) {
    structure?.()
    if (cause instanceof WorkspaceError && cause.outcome === 'blocked')
      return reported(
        subjectResult(
          subject,
          'blocked',
          `A participating dev session still uses this workspace or its repository structure (${cause.message}); nothing was changed.`,
          'End that use; the next sweep or a fresh release rechecks it.'
        )
      )
    throw cause
  }
  try {
    const gated = scopeOf(authority, request, decidedIds).find(
      item => item.workspace.id === request.workspaceId
    )
    if (gated === undefined) return reported(noReservation(subject, request.taskId))
    return reported(attemptUnderGates(authority, request, subject, gated, readers, context))
  } finally {
    if (gates !== undefined) releaseGates(gates)
    structure?.()
  }
}

export const releaseWorkspace = (
  authority: WorkspaceAuthority,
  request: ReleaseRequest,
  readers: EvidenceReaders,
  context: AssessmentContext = AT_QUIT
): WorkspaceReleaseResult =>
  releaseDecidedWorkspace(
    authority,
    request,
    readers,
    context,
    new Set(request.decided.map(subject => subject.workspaceId))
  )

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

const attemptOutcome = (outcome: WorkspaceReleaseResult['outcome']): SweepOutcome =>
  outcome === 'blocked' ? 'retained' : outcome

export const sweepRepository = (
  authority: WorkspaceAuthority,
  input: SweepInput,
  readers: EvidenceReaders
): SweepReceipt => {
  const commandId = newId()
  const receipt: SweepRow[] = []
  if (authority.inspectExisting() === undefined)
    return { commandId, moment: input.moment, rows: receipt }
  const context: AssessmentContext = {
    moment: input.moment,
    ...(input.excluded === undefined ? {} : { excluded: input.excluded }),
  }
  const decider: ReleaseDecider = {
    kind: 'completion',
    policyVersion: COMPLETION_POLICY_VERSION,
    moment: input.moment,
  }
  const seconds = SWEEP_BUDGET_MS[input.moment] / 1000
  const taskIds = inDb(authority, input.repositoryId, db =>
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
  let exhausted = false
  for (const [index, taskId] of taskIds.entries()) {
    if (now() >= input.deadline) {
      deferFrom(index, false)
      break
    }
    let assessments: readonly WorkspaceAssessment[]
    try {
      assessments = assessTask(authority, taskId, readers, context).map(
        ({ assessment }) => assessment
      )
    } catch (cause) {
      receipt.push({
        kind: 'task-failure',
        taskId,
        reason: `The task could not be assessed, so nothing of it was attempted: ${errorText(cause)}`,
      })
      continue
    }
    const decided = assessments.map(assessment => assessment.subject)
    const decidedIds = new Set(decided.map(subject => subject.workspaceId))
    for (const assessment of assessments.toSorted((left, right) =>
      left.workspaceId.localeCompare(right.workspaceId)
    )) {
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
      if (now() >= input.deadline) {
        deferFrom(index, true)
        exhausted = true
        break
      }
      try {
        const result = releaseDecidedWorkspace(
          authority,
          {
            taskId,
            commandId,
            decided,
            decider,
            workspaceId: assessment.workspaceId,
            occupiedPaths: input.occupiedPaths,
          },
          readers,
          context,
          decidedIds
        )
        receipt.push({
          ...row,
          outcome: attemptOutcome(result.outcome),
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
    if (exhausted) break
  }
  return { commandId, moment: input.moment, rows: receipt }
}
