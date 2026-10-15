import assert from 'node:assert/strict'
import { expiredConversations } from '../src/conversation-retention.ts'

const history = (prefix: string) =>
  Array.from({ length: 101 }, (_, index) => ({
    path: `${prefix}/${String(index).padStart(3, '0')}.jsonl`,
    modifiedAt: index,
    eligible: true,
  }))

for (const prefix of ['home-a/lead', 'home-a/child', 'home-b/lead', 'home-b/child']) {
  const candidates = history(prefix)
  assert.deepEqual(
    expiredConversations([
      ...candidates,
      { path: `${prefix}/protected.jsonl`, modifiedAt: -1, eligible: false },
    ]).map(candidate => candidate.path),
    [`${prefix}/000.jsonl`]
  )
  assert.deepEqual(expiredConversations(candidates.slice(1)), [])
}

const tied = history('ties')
for (const candidate of tied) candidate.modifiedAt = 1
assert.deepEqual(
  expiredConversations(tied.toReversed()).map(candidate => candidate.path),
  ['ties/100.jsonl']
)
assert.deepEqual(expiredConversations([]), [])
console.log(
  'conversation retention: quota, protected entries, independent inventories and ties passed'
)
