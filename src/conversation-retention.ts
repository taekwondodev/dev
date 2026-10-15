export interface ConversationCandidate {
  readonly path: string
  readonly modifiedAt: number | bigint
  readonly eligible: boolean
}

export const expiredConversations = <Candidate extends ConversationCandidate>(
  candidates: readonly Candidate[]
): readonly Candidate[] =>
  candidates
    .filter(candidate => candidate.eligible)
    .toSorted((left, right) => {
      if (left.modifiedAt > right.modifiedAt) return -1
      if (left.modifiedAt < right.modifiedAt) return 1
      if (left.path < right.path) return -1
      return left.path > right.path ? 1 : 0
    })
    .slice(100)
