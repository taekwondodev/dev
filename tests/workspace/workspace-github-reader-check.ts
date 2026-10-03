import assert from 'node:assert/strict'
import { makeGitHubReader, isUnavailable } from '../../src/workspace-evidence.ts'
import { makeClaims } from './workspace-check-support.ts'

const repository = 'cli/cli'
const number = 14497
const reader = makeGitHubReader()
const { claim, passed } = makeClaims()
const fail = (what: string, value: unknown): never => {
  throw new Error(`${what}: ${JSON.stringify(value)}`)
}

const pull = await claim(
  'the reader normalizes a merged pull request: merged state, merge time, exact head, source and base repositories, base ref and merge result',
  () => {
    const value = reader.pullRequest(repository, number)
    if (value === 'missing' || isUnavailable(value)) return fail('pull request', value)
    assert.equal(value.merged, true)
    assert.ok(
      value.mergedAt !== undefined && Number.isFinite(Date.parse(value.mergedAt)),
      `merged_at reads back as a timestamp: ${String(value.mergedAt)}`
    )
    assert.equal(value.headRepository, repository)
    assert.equal(value.baseRepository, repository)
    assert.equal(value.baseRef, 'trunk')
    assert.match(value.headSha, /^[0-9a-f]{40}$/)
    assert.match(value.mergeCommit ?? '', /^[0-9a-f]{40}$/)
    assert.equal(value.commits, 1)
    return value
  }
)
await claim(
  'one GraphQL evidence read matches the target tip, merged pull request and commit list observed through REST',
  () => {
    const evidence = reader.pullRequestEvidence?.(repository, 'refs/heads/trunk', number)
    if (evidence === undefined || isUnavailable(evidence))
      return fail('pull request evidence', evidence)
    if (evidence.pullRequest === 'missing' || isUnavailable(evidence.pullRequest))
      return fail('bundled pull request', evidence.pullRequest)
    assert.equal(evidence.tip, reader.refTip(repository, 'refs/heads/trunk'))
    assert.equal(evidence.pullRequest.headSha, pull.headSha)
    assert.equal(evidence.pullRequest.mergeCommit, pull.mergeCommit)
    assert.deepEqual(evidence.commits, { kind: 'complete', commits: [pull.headSha] })
  }
)
await claim(
  'after the source branch was deleted, the pull request still lists its merged commits and their last entry is the head it carried at merge',
  () => {
    const tip = reader.refTip(repository, 'refs/heads/bagtoad/cli-security-reporting-guidance')
    assert.equal(tip, 'missing', 'the source branch no longer exists')
    const commits = reader.pullRequestCommits(repository, number)
    if (isUnavailable(commits)) return fail('pull request commits', commits)
    assert.equal(commits.at(-1), pull.headSha)
  }
)
await claim(
  'the exact merged head resolves to its merged pull request, and the merge result is reachable from the current base tip without any fetch',
  () => {
    const pulls = reader.mergedPullRequestsForCommit(repository, pull.headSha)
    if (isUnavailable(pulls)) return fail('pull requests for commit', pulls)
    assert.ok(pulls.includes(number))
    const tip = reader.refTip(repository, 'refs/heads/trunk')
    if (tip === 'missing' || isUnavailable(tip)) return fail('trunk tip', tip)
    const status = reader.compare(repository, pull.mergeCommit ?? '', tip)
    assert.ok(status === 'identical' || status === 'ahead', JSON.stringify(status))
    const behind = reader.compare(repository, tip, pull.headSha)
    assert.ok(behind === 'diverged' || behind === 'behind', JSON.stringify(behind))
  }
)
await claim(
  'the default branch of the repository reads back as the branch the merged pull request targets, and a missing repository is missing',
  () => {
    assert.equal(reader.defaultBranch(repository), pull.baseRef)
    assert.equal(reader.defaultBranch('cli/no-such-repository-for-dev-check'), 'missing')
  }
)
await claim('a missing resource is reported as missing, not as an error or a guess', () => {
  assert.equal(reader.pullRequest(repository, 999_999_999), 'missing')
  assert.equal(reader.refTip(repository, 'refs/heads/no-such-branch-for-dev-check'), 'missing')
})
process.stdout.write(
  `${JSON.stringify({ result: 'passed', repository, number, checks: passed, limits: ['Network and gh authentication were required; this is a one-off adapter observation, not a recurring gate.'] }, null, 2)}\n`
)
