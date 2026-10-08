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

export const CLEAR = 'dev workspace release clears the task when you no longer need it.'
const DELIVER = [
  'Deliver the work (merge its pull request or integrate its commits); the sweep removes it once it is finished, or dev workspace release removes it now.',
]
export const RETAINED: Record<
  RetainedReason,
  {
    readonly sweep: SweepOutcome
    readonly actions: readonly string[]
  }
> = {
  'identity-unverifiable': { sweep: 'retained', actions: [CLEAR] },
  'transition-unresolved': { sweep: 'retained', actions: [CLEAR] },
  'release-review': { sweep: 'review-required', actions: [CLEAR] },
  excluded: { sweep: 'skipped', actions: [] },
  'use-unknown': { sweep: 'retained', actions: [] },
  'use-abandoned': { sweep: 'retained', actions: [] },
  'use-live': { sweep: 'retained', actions: [] },
  'directory-missing': { sweep: 'retained', actions: [CLEAR] },
  'residue-unreadable': {
    sweep: 'retained',
    actions: ['Fix the reported read failure; the next sweep rechecks it.', CLEAR],
  },
  'checkout-modified': {
    sweep: 'retained',
    actions: [
      'Commit or clean the checkout; a clean checkout loses its reservation automatically when dev quits.',
    ],
  },
  skipped: { sweep: 'skipped', actions: [] },
  'no-commits': { sweep: 'retained', actions: DELIVER },
  'integration-unknown': {
    sweep: 'retained',
    actions: [
      'Establish the missing fact (target, history or provider); the lead can record a target with the workspace tool, and dev never fetches or uploads for you.',
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
  readonly ignored: number
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
  return facts.allocation === 'delegated-writer' ? 'child' : 'detached'
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
    .map(seed => (seed === 'override' ? 'the recorded pull request' : `the ${seed} seed`))
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
    return retain('identity-unverifiable', 'The workspace identity cannot be verified.')
  if (facts.transitionUnresolved)
    return retain('transition-unresolved', 'A workspace transition outcome is unresolved.')
  if (facts.releaseReview)
    return retain(
      'release-review',
      'An earlier release did not finish; dev workspace release completes it.'
    )
  if (facts.excluded)
    return retain('excluded', 'It belongs to the conversation that is allocating a worktree.')
  if (facts.uses.unknown > 0)
    return retain('use-unknown', `${facts.uses.unknown} workspace use(s) are unresolved.`)
  if (facts.uses.abandoned > 0)
    return retain(
      'use-abandoned',
      `${facts.uses.abandoned} use(s) were left unsettled by ended dev sessions.`
    )
  if (facts.uses.live > 0)
    return retain('use-live', `${facts.uses.live} live use(s) by participating dev sessions.`)
  if (facts.uses.conversations > 0)
    return retain(
      'use-live',
      `${facts.uses.conversations} open dev conversation(s) are bound to this workspace.`
    )
  if (!facts.attemptsQuiescent)
    return retain('use-live', 'An attempt using this workspace is not observed quiescent.')

  if (facts.origin === 'pre-existing') {
    if (facts.residue === undefined)
      return retain('residue-unreadable', 'The checkout contents could not be read.')
    if (!isClean(facts.residue))
      return retain(
        'checkout-modified',
        `The checkout has ${facts.residue.tracked} tracked change(s) and ${facts.residue.untracked} untracked file(s); only a clean checkout loses its reservation automatically.`
      )
    if (facts.moment !== 'quit')
      return retain('skipped', 'A clean pre-existing checkout loses its reservation only at quit.')
    return finish(
      'clean-checkout',
      'Clean pre-existing checkout: its reservation ends; files and commits stay untouched.'
    )
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
      'no-residue',
      'No tracked changes or non-ignored untracked files and no commits outside its base or target; Git-ignored files do not block completion.'
    )

  if (role === 'branch') {
    if (facts.ownCommits === false)
      return retain(
        'no-commits',
        `Branch ${branchName(facts.branch ?? '')} has no commits beyond its allocation base, so its residue cannot have been delivered.`
      )
    if (facts.ownCommits === undefined)
      return retain(
        'integration-unknown',
        'Commits beyond the allocation base cannot be determined.'
      )
    const merged = delivery(integration, pullRequest => pullRequest.containsHead)
    if (merged.proven !== undefined)
      return finish('branch-merged', merged.proven.containsHead.reason)
    if (integration.headInTip.kind === 'yes')
      return finish('branch-in-target', integration.headInTip.reason)
    return undecided(
      [...merged.unknown, ...unknownReason(integration.headInTip)],
      [
        ...(integration.headInTip.kind === 'no' ? [integration.headInTip.reason] : []),
        ...refutations(integration, pullRequest => pullRequest.containsHead),
      ],
      'Delivery of the branch HEAD'
    )
  }

  if (role === 'child') {
    const delivered = delivery(integration, pullRequest => pullRequest.descendsFromBase)
    if (delivered.proven !== undefined)
      return finish(
        'child-delivered',
        `${delivered.proven.label}, found through ${seedText(delivered.proven.seeds)}: ${delivered.proven.descendsFromBase.reason}`
      )
    return undecided(
      delivered.unknown,
      refutations(integration, pullRequest => pullRequest.descendsFromBase),
      "A merged pull request of this task descending from the child's base"
    )
  }

  if (clean && integration.headInTip.kind === 'unknown')
    return retain(
      'integration-unknown',
      `Commits outside its base cannot be proven delivered: ${integration.headInTip.reason}`
    )
  return retain(
    'not-integrated',
    clean
      ? `Commits outside its base are not in the target: ${integration.headInTip.reason}`
      : 'A detached worktree that is not a delegated child finishes only without residue.'
  )
}
