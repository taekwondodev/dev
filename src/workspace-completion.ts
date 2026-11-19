import type {
  AllocationReason,
  CompletionVerdict,
  FinishedRule,
  RetainedReason,
  SweepMoment,
  SweepOutcome,
  WorkspaceOrigin,
  WorkspaceRole,
} from './workspace-domain.ts'
import { CHECKOUT_CONTENTS_UNREADABLE } from './workspace-labels.ts'

export type Proof =
  | { readonly kind: 'yes'; readonly reason: string }
  | { readonly kind: 'no'; readonly reason: string }
  | { readonly kind: 'unknown'; readonly reason: string }

export type PullRequestSeed = 'head' | 'base' | 'sibling' | 'override'

export interface PullRequestFact {
  readonly label: string
  readonly seeds: readonly PullRequestSeed[]
  readonly containsHead: Proof
  readonly descendsFromBase: Proof
}

export interface IntegrationFacts {
  readonly headInTip: Proof
  readonly pullRequests: readonly PullRequestFact[]
  readonly rejected: readonly string[]
  readonly unknown: readonly string[]
}

export const CLEAR =
  "If the task is no longer needed and nothing still works in its checkouts, the user may run dev workspace release <taskId>, which deletes all of the task's managed worktrees and artifacts."
const DELIVER = ['Merge the PR or land its commits for cleanup. Only the user can release it.']
export const RETAINED: Record<
  RetainedReason,
  {
    readonly sweep: SweepOutcome
    readonly actions: readonly string[]
  }
> = {
  'identity-unverifiable': { sweep: 'retained', actions: [CLEAR] },
  'transition-unresolved': { sweep: 'retained', actions: ['Do not retry it.', CLEAR] },
  'release-review': { sweep: 'review-required', actions: [CLEAR] },
  excluded: { sweep: 'skipped', actions: [] },
  'use-unknown': { sweep: 'retained', actions: [] },
  'use-abandoned': { sweep: 'retained', actions: [] },
  'use-live': { sweep: 'retained', actions: [] },
  'directory-missing': { sweep: 'retained', actions: [CLEAR] },
  'residue-unreadable': {
    sweep: 'retained',
    actions: ['Fix the read error before cleanup.', CLEAR],
  },
  'checkout-modified': {
    sweep: 'retained',
    actions: ['Commit or clean the checkout. At quit, dev frees clean checkouts for other work.'],
  },
  skipped: { sweep: 'skipped', actions: [] },
  'no-commits': { sweep: 'retained', actions: DELIVER },
  'integration-unknown': {
    sweep: 'retained',
    actions: [
      'Check the destination branch and Git history. Use workspace set-target if needed. Dev never fetches or uploads.',
      CLEAR,
    ],
  },
  'not-integrated': { sweep: 'retained', actions: DELIVER },
}

export const integrationUnknown = (reason: string): IntegrationFacts => ({
  headInTip: { kind: 'unknown', reason },
  pullRequests: [],
  rejected: [],
  unknown: [reason],
})

export interface Residue {
  readonly tracked: number
  readonly untracked: number
  readonly unpublished: number
}

export interface CompletionFacts {
  readonly moment: SweepMoment
  readonly origin: WorkspaceOrigin
  readonly allocation: AllocationReason | undefined
  readonly identity: 'verified' | 'absent' | 'unverifiable'
  readonly transitionUnresolved: boolean
  readonly releaseReview: boolean
  readonly excluded: boolean
  readonly uses: {
    readonly unknown: number
    readonly abandoned: number
    readonly live: number
    readonly conversations: number
  }
  readonly attemptsQuiescent: boolean
  readonly branch: string | undefined
  readonly residue: Residue | undefined
  readonly ownCommits: boolean | undefined
  readonly integration: IntegrationFacts
}

export const roleOf = (
  facts: Pick<CompletionFacts, 'origin' | 'branch' | 'allocation'>
): WorkspaceRole => {
  if (facts.origin === 'pre-existing') return 'pre-existing'
  if (facts.branch !== undefined) return 'branch'
  return facts.allocation === 'delegated-writer' ? 'agent' : 'detached'
}

export const branchName = (ref: string): string => ref.replace(/^refs\/heads\//, '')

const isClean = (residue: Residue): boolean => residue.tracked === 0 && residue.untracked === 0

export const needsIntegration = (residue: Residue, ownCommits: boolean | undefined): boolean =>
  !isClean(residue) || ownCommits !== false

type Relation = (pullRequest: PullRequestFact) => Proof

const unknownReason = (proof: Proof): readonly string[] =>
  proof.kind === 'unknown' ? [proof.reason] : []

const delivery = (
  integration: IntegrationFacts,
  relation: Relation
): {
  readonly proven?: PullRequestFact
  readonly unknown: readonly string[]
} => {
  let unknown: string[] | undefined
  for (const pullRequest of integration.pullRequests) {
    const proof = relation(pullRequest)
    if (proof.kind === 'yes') return { proven: pullRequest, unknown: [] }
    if (proof.kind === 'unknown') {
      unknown ??= [...integration.unknown]
      unknown.push(`${pullRequest.label}: ${proof.reason}`)
    }
  }
  return { unknown: unknown ?? integration.unknown }
}

const refutations = (integration: IntegrationFacts, relation: Relation): readonly string[] => [
  ...integration.rejected,
  ...integration.pullRequests.flatMap(pullRequest => {
    const proof = relation(pullRequest)
    return proof.kind === 'no' ? [`${pullRequest.label}: ${proof.reason}`] : []
  }),
]

const seedText = (seeds: readonly PullRequestSeed[]): string =>
  seeds
    .map(
      seed =>
        ({
          override: 'the saved PR number',
          head: 'HEAD',
          base: 'the starting commit',
          sibling: 'another checkout of this task',
        })[seed]
    )
    .join(', ')

export const decideCompletion = (facts: CompletionFacts): CompletionVerdict => {
  const role = roleOf(facts)
  const retain = (retained: RetainedReason, reason: string): CompletionVerdict => ({
    kind: 'retained',
    role,
    retained,
    reason,
  })
  const finish = (rule: FinishedRule, reason: string): CompletionVerdict => ({
    kind: 'finished',
    role,
    rule,
    reason,
  })
  const { integration } = facts
  const undecided = (unknown: readonly string[], refuted: readonly string[], what: string) =>
    unknown.length > 0
      ? retain('integration-unknown', `${what} cannot be proven yet: ${unknown.join('; ')}`)
      : retain(
          'not-integrated',
          `${what} is not proven${refuted.length > 0 ? `: ${refuted.join('; ')}` : ''}`
        )

  if (facts.identity === 'unverifiable')
    return retain('identity-unverifiable', 'The checkout identity cannot be verified.')
  if (facts.transitionUnresolved)
    return retain(
      'transition-unresolved',
      'An earlier worktree creation or checkout switch may be unfinished.'
    )
  if (facts.releaseReview)
    return retain(
      'release-review',
      'An earlier release did not finish; dev workspace release completes it.'
    )
  if (facts.excluded)
    return retain('excluded', 'The conversation creating a worktree uses this checkout.')
  if (facts.uses.unknown > 0)
    return retain('use-unknown', `Dev cannot confirm ${facts.uses.unknown} operations stopped.`)
  if (facts.uses.abandoned > 0)
    return retain(
      'use-abandoned',
      `Closed sessions may still have ${facts.uses.abandoned} operations running.`
    )
  if (facts.uses.live > 0)
    return retain('use-live', `Dev sessions still use this checkout (${facts.uses.live}).`)
  if (facts.uses.conversations > 0)
    return retain('use-live', `${facts.uses.conversations} open conversations use this checkout.`)
  if (!facts.attemptsQuiescent)
    return retain('use-live', 'A run using this checkout may still be active.')

  if (facts.origin === 'pre-existing') {
    if (facts.residue === undefined)
      return retain('residue-unreadable', CHECKOUT_CONTENTS_UNREADABLE)
    if (!isClean(facts.residue))
      return retain(
        'checkout-modified',
        `The checkout has ${facts.residue.tracked} tracked change(s) and ${facts.residue.untracked} untracked file(s). Dev only frees clean checkouts automatically.`
      )
    if (facts.moment === 'allocation')
      return retain(
        'skipped',
        'Dev frees clean pre-existing checkouts at quit or when changing conversations.'
      )
    return finish('clean-checkout', 'Clean checkout; free for other work. Files and commits stay.')
  }

  if (facts.identity === 'absent')
    return retain(
      'directory-missing',
      'The worktree directory is gone; dev workspace release records the absence.'
    )
  if (facts.residue === undefined)
    return retain('residue-unreadable', 'The worktree contents could not be read.')
  const clean = isClean(facts.residue)
  if (
    !needsIntegration(facts.residue, facts.ownCommits) ||
    (clean && role !== 'branch' && integration.headInTip.kind === 'yes')
  )
    return finish(
      'nothing-left',
      'No tracked edits, untracked non-ignored files or commits to land. Ignored files do not block cleanup.'
    )

  if (role === 'branch') {
    if (facts.ownCommits === false)
      return retain(
        'no-commits',
        `Branch ${branchName(facts.branch ?? '')} has no new commits to deliver its remaining changes.`
      )
    if (facts.ownCommits === undefined)
      return retain('integration-unknown', 'Could not verify commits after the starting commit.')
    const { tracked, unpublished } = facts.residue
    const delivered = (verdict: CompletionVerdict): CompletionVerdict =>
      tracked + unpublished === 0
        ? verdict
        : retain(
            'not-integrated',
            `The branch HEAD is delivered, but ${tracked} uncommitted tracked change(s) and ${unpublished} unpublished untracked file(s) are not.`
          )
    const merged = delivery(integration, pullRequest => pullRequest.containsHead)
    if (merged.proven !== undefined)
      return delivered(finish('branch-merged', merged.proven.containsHead.reason))
    if (integration.headInTip.kind === 'yes')
      return delivered(finish('branch-in-target', integration.headInTip.reason))
    return undecided(
      [...merged.unknown, ...unknownReason(integration.headInTip)],
      [
        ...(integration.headInTip.kind === 'no' ? [integration.headInTip.reason] : []),
        ...refutations(integration, pullRequest => pullRequest.containsHead),
      ],
      'Delivery of the branch HEAD'
    )
  }

  if (role === 'agent') {
    const delivered = delivery(integration, pullRequest => pullRequest.descendsFromBase)
    if (delivered.proven !== undefined)
      return finish(
        'agent-delivered',
        `${delivered.proven.label}, found through ${seedText(delivered.proven.seeds)}: ${delivered.proven.descendsFromBase.reason}`
      )
    return undecided(
      delivered.unknown,
      refutations(integration, pullRequest => pullRequest.descendsFromBase),
      "A task PR merged from this worktree's starting commit"
    )
  }

  if (clean && integration.headInTip.kind === 'unknown')
    return retain(
      'integration-unknown',
      `Could not confirm delivery of new commits: ${integration.headInTip.reason}`
    )
  return retain(
    'not-integrated',
    clean
      ? `New commits are not in the destination branch: ${integration.headInTip.reason}`
      : 'This detached worktree still has changes or commits to deliver.'
  )
}
