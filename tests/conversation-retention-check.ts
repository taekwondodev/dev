import assert from 'node:assert/strict'
import { RETAINED_CONVERSATIONS, newestFirst } from '../src/conversation-retention.ts'

const tied = Array.from({ length: 101 }, (_, index) => ({
  path: `ties/${String(index).padStart(3, '0')}.jsonl`,
  modifiedAt: 1,
  eligible: true,
}))
assert.deepEqual(
  tied
    .toReversed()
    .toSorted(newestFirst)
    .slice(RETAINED_CONVERSATIONS)
    .map(candidate => candidate.path),
  ['ties/100.jsonl']
)
console.log('conversation retention: equal timestamps use deterministic filename ordering')
