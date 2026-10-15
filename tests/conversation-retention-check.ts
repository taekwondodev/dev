import assert from 'node:assert/strict'
import { expiredConversations } from '../src/conversation-retention.ts'

const tied = Array.from({ length: 101 }, (_, index) => ({
  path: `ties/${String(index).padStart(3, '0')}.jsonl`,
  modifiedAt: 1,
  eligible: true,
}))
assert.deepEqual(
  expiredConversations(tied.toReversed()).map(candidate => candidate.path),
  ['ties/100.jsonl']
)
console.log('conversation retention: equal timestamps use deterministic filename ordering')
