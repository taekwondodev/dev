import { integrationUnknown, type CompletionFacts } from '../../src/workspace-completion.ts'
import type { CompletionVerdict } from '../../src/workspace-domain.ts'

export const managedFacts = (overrides: Partial<CompletionFacts> = {}): CompletionFacts => ({
  moment: 'quit',
  origin: 'managed',
  allocation: 'delegated-writer',
  identity: 'verified',
  transitionUnresolved: false,
  releaseReview: false,
  excluded: false,
  uses: { unknown: 0, abandoned: 0, live: 0, conversations: 0 },
  attemptsQuiescent: true,
  branch: undefined,
  residue: { tracked: 0, untracked: 0, ignored: 0 },
  ownCommits: false,
  integration: integrationUnknown('Integration is not needed here.'),
  ...overrides,
})

export const checkoutFacts = (overrides: Partial<CompletionFacts> = {}): CompletionFacts =>
  managedFacts({
    origin: 'pre-existing',
    allocation: undefined,
    ownCommits: undefined,
    ...overrides,
  })

export const verdictName = (verdict: CompletionVerdict): string =>
  verdict.kind === 'finished' ? verdict.rule : `retained:${verdict.retained}`
