import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, type BigIntStats } from 'node:fs'
import { basename, join } from 'node:path'
import { Schema } from 'effect'
import { errorText } from './error-text.ts'
import {
  CommitSha,
  type EvidenceVerdict,
  type PublicationReference,
  type RuleApproval,
  type TaskTarget,
} from './workspace-domain.ts'
import {
  ancestry,
  blobAt,
  hasCommit,
  isShallowRepository,
  remoteTip,
  resolveLocalRef,
  trackedChanges,
  untrackedPaths,
  type TrackedChange,
} from './workspace-git.ts'
import type { ManifestEntry } from './workspace-records.ts'
import { hasErrorCode } from './workspace-platform.ts'

export const EVIDENCE_POLICY_VERSION = 1

export const sha256Hex = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex')

export interface GitHubPullRequest {
  readonly merged: boolean
  readonly mergeCommit: string | undefined
  readonly headSha: string
  readonly headRepository: string | undefined
  readonly baseRepository: string
  readonly baseRef: string
  readonly commits: number
}
export type CompareStatus = 'identical' | 'ahead' | 'behind' | 'diverged'
export interface Unavailable {
  readonly unavailable: string
}
export const isUnavailable = (value: unknown): value is Unavailable =>
  typeof value === 'object' && value !== null && 'unavailable' in value

export interface GitHubReader {
  refTip(repository: string, ref: string): string | 'missing' | Unavailable
  pullRequest(repository: string, number: number): GitHubPullRequest | 'missing' | Unavailable

  pullRequestCommits(repository: string, number: number): readonly string[] | Unavailable
  mergedPullRequestsForCommit(repository: string, sha: string): readonly number[] | Unavailable
  compare(repository: string, base: string, head: string): CompareStatus | Unavailable
}

const PullRequestPayload = Schema.Struct({
  merged: Schema.Boolean,
  merge_commit_sha: Schema.NullOr(CommitSha),
  head: Schema.Struct({
    sha: CommitSha,
    repo: Schema.NullOr(Schema.Struct({ full_name: Schema.String })),
  }),
  base: Schema.Struct({ ref: Schema.String, repo: Schema.Struct({ full_name: Schema.String }) }),
  commits: Schema.Int,
})
const RefPayload = Schema.Struct({ object: Schema.Struct({ sha: CommitSha }) })
const CommitListPayload = Schema.Array(Schema.Struct({ sha: CommitSha }))
const PullListPayload = Schema.Array(
  Schema.Struct({ number: Schema.Int, merged_at: Schema.NullOr(Schema.String) })
)
const ComparePayload = Schema.Struct({
  status: Schema.Literals(['identical', 'ahead', 'behind', 'diverged']),
})

const PROVIDER_BUDGET_MS = 30_000
const decode = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  text: string
): S['Type'] | Unavailable => {
  try {
    return Schema.decodeUnknownSync(schema)(JSON.parse(text))
  } catch (cause) {
    return { unavailable: `GitHub returned an unexpected shape: ${errorText(cause)}` }
  }
}
type GhCall = (
  endpoint: string,
  timeoutMs: number
) => { readonly status: 'ok' | 'not-found'; readonly text: string }
const ghApi: GhCall = (endpoint, timeoutMs) => {
  try {
    const text = execFileSync(
      'gh',
      ['api', '-H', 'Accept: application/vnd.github+json', endpoint],
      {
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
      }
    )
    return { status: 'ok', text }
  } catch (cause) {
    const stderr =
      typeof cause === 'object' && cause !== null && 'stderr' in cause
        ? String((cause as { stderr: unknown }).stderr)
        : ''
    if (/HTTP 404/.test(stderr)) return { status: 'not-found', text: '' }
    throw new Error(`gh api ${endpoint} failed: ${stderr.trim() || errorText(cause)}`, { cause })
  }
}
const refPath = (ref: string): string => ref.replace(/^refs\//, '')

const orUnavailable = <A>(value: A | 'missing' | Unavailable, what: string): A | Unavailable =>
  value === 'missing' ? { unavailable: `${what} was not found` } : value

export const makeGitHubReader = (
  call: GhCall = ghApi,
  budgetMs: number = PROVIDER_BUDGET_MS,
  clock: () => number = () => performance.now()
): GitHubReader => {
  const deadline = clock() + budgetMs

  const answered = new Map<string, ReturnType<GhCall> | Unavailable>()
  const ask = (endpoint: string): ReturnType<GhCall> | Unavailable => {
    const known = answered.get(endpoint)
    if (known !== undefined) return known
    const remaining = deadline - clock()
    if (remaining <= 0)
      return {
        unavailable: `this request's ${budgetMs / 1000} s GitHub time budget was spent before this read`,
      }
    let response: ReturnType<GhCall> | Unavailable
    try {
      response = call(endpoint, Math.ceil(remaining))
    } catch (cause) {
      response = { unavailable: errorText(cause) }
    }
    answered.set(endpoint, response)
    return response
  }
  const read = <S extends Schema.ConstraintDecoder<unknown>>(
    endpoint: string,
    schema: S
  ): S['Type'] | 'missing' | Unavailable => {
    const response = ask(endpoint)
    if (isUnavailable(response)) return response
    if (response.status === 'not-found') return 'missing'
    return decode(schema, response.text)
  }
  return {
    refTip(repository, ref) {
      const value = read(`repos/${repository}/git/ref/${refPath(ref)}`, RefPayload)
      return value === 'missing' || isUnavailable(value) ? value : value.object.sha
    },
    pullRequest(repository, number) {
      const value = read(`repos/${repository}/pulls/${number}`, PullRequestPayload)
      if (value === 'missing' || isUnavailable(value)) return value
      return {
        merged: value.merged,
        mergeCommit: value.merge_commit_sha ?? undefined,
        headSha: value.head.sha,
        headRepository: value.head.repo?.full_name,
        baseRepository: value.base.repo.full_name,
        baseRef: value.base.ref,
        commits: value.commits,
      }
    },
    pullRequestCommits(repository, number) {
      const value = orUnavailable(
        read(`repos/${repository}/pulls/${number}/commits?per_page=250`, CommitListPayload),
        `pull request ${number} commits`
      )
      return isUnavailable(value) ? value : value.map(commit => commit.sha)
    },
    mergedPullRequestsForCommit(repository, sha) {
      const value = orUnavailable(
        read(`repos/${repository}/commits/${sha}/pulls?per_page=100`, PullListPayload),
        `pull requests for ${sha}`
      )
      return isUnavailable(value)
        ? value
        : value.filter(pull => pull.merged_at !== null).map(pull => pull.number)
    },
    compare(repository, base, head) {
      const value = orUnavailable(
        read(`repos/${repository}/compare/${base}...${head}`, ComparePayload),
        `comparison ${base}...${head}`
      )
      return isUnavailable(value) ? value : value.status
    },
  }
}

export type InventoryFile =
  | {
      readonly kind: 'file' | 'symlink'
      readonly path: string
      readonly size: number
      readonly device: string
      readonly inode: string
      readonly mtimeNs: string
    }
  | {
      readonly kind: 'nested-repository' | 'other' | 'unreadable'
      readonly path: string
      readonly detail?: string
    }
export interface Inventory {
  readonly head: string | undefined
  readonly tracked: readonly TrackedChange[]
  readonly files: readonly InventoryFile[]
}

const SENSITIVE_NAMES = new Set([
  '.env',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  'auth.json',
  'credentials',
  'credentials.json',
  'secrets.json',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
])
const SENSITIVE_SUFFIXES = [
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.keychain',
  '.keychain-db',
  '.gpg',
  '.asc',
  '.kdbx',
  '.mobileprovision',
  '.p8',
]
const SENSITIVE_PARTS = [
  'secret',
  'password',
  'passwd',
  'token',
  'credential',
  'private_key',
  'privatekey',
]

export const sensitiveName = (relativePath: string): boolean => {
  const name = basename(relativePath).toLowerCase()
  if (SENSITIVE_NAMES.has(name) || name.startsWith('.env.') || name.startsWith('id_rsa'))
    return true
  if (SENSITIVE_SUFFIXES.some(suffix => name.endsWith(suffix))) return true
  if (relativePath.split('/').some(part => part === '.ssh' || part === '.aws' || part === '.gnupg'))
    return true
  return SENSITIVE_PARTS.some(part => name.includes(part))
}

const identityOf = (
  stat: BigIntStats
): {
  readonly size: number
  readonly device: string
  readonly inode: string
  readonly mtimeNs: string
} => ({
  size: Number(stat.size),
  device: String(stat.dev),
  inode: String(stat.ino),
  mtimeNs: String(stat.mtimeNs),
})

const inventoryFileOf = (checkout: string, device: string, entry: string): InventoryFile => {
  if (entry.endsWith('/')) return { path: entry.slice(0, -1), kind: 'nested-repository' }
  let stat
  try {
    stat = lstatSync(join(checkout, entry), { bigint: true })
  } catch (cause) {
    return { path: entry, kind: 'unreadable', detail: errorText(cause) }
  }
  const identity = identityOf(stat)
  if (identity.device !== device)
    return { path: entry, kind: 'other', detail: 'crosses a mount boundary' }
  if (stat.isSymbolicLink()) return { path: entry, kind: 'symlink', ...identity }
  if (stat.isFile()) {
    if (Number(stat.nlink) !== 1) return { path: entry, kind: 'other', detail: 'has hard links' }
    return { path: entry, kind: 'file', ...identity }
  }
  return { path: entry, kind: 'other', detail: 'is not a regular file' }
}

export const readInventory = (checkout: string, head: string | undefined): Inventory => {
  const device = String(lstatSync(checkout, { bigint: true }).dev)
  const files = untrackedPaths(checkout).map(entry => inventoryFileOf(checkout, device, entry))
  return { head, tracked: trackedChanges(checkout), files }
}

export const entryUnchanged = (
  checkout: string,
  entry: ManifestEntry
):
  | { readonly state: 'same' }
  | { readonly state: 'absent' }
  | { readonly state: 'changed'; readonly detail: string } => {
  let stat
  try {
    stat = lstatSync(join(checkout, entry.path), { bigint: true })
  } catch (cause) {
    if (hasErrorCode(cause, 'ENOENT')) return { state: 'absent' }
    return { state: 'changed', detail: errorText(cause) }
  }
  const identity = identityOf(stat)
  if (
    identity.device !== entry.device ||
    identity.inode !== entry.inode ||
    identity.size !== entry.size ||
    identity.mtimeNs !== entry.mtimeNs
  )
    return { state: 'changed', detail: 'identity or content changed since the check' }
  if (stat.isSymbolicLink() !== (entry.kind === 'symlink'))
    return { state: 'changed', detail: 'file type changed since the check' }
  if (entry.kind === 'file' && !stat.isFile())
    return { state: 'changed', detail: 'no longer a regular file' }
  if (entry.sha256 !== undefined && entry.kind === 'file') {
    const digest = sha256Hex(readFileSync(join(checkout, entry.path)))
    if (digest !== entry.sha256) return { state: 'changed', detail: 'content digest changed' }
  }
  return { state: 'same' }
}

const RuleSet = Schema.Struct({
  version: Schema.Literal(1),
  regenerable: Schema.Array(Schema.NonEmptyString),
})
interface ApprovedRule {
  readonly locator: string
  readonly digest: string
  readonly directories: readonly string[]
  readonly files: readonly string[]
}
export interface RuleEvaluation {
  readonly approved: readonly ApprovedRule[]
  readonly problems: readonly string[]
}
export const evaluateRules = (
  checkout: string,
  head: string | undefined,
  approvals: readonly RuleApproval[]
): RuleEvaluation => {
  const approved: ApprovedRule[] = []
  const problems: string[] = []
  if (head === undefined) return { approved, problems }
  const locators = [...new Set(approvals.map(approval => approval.locator))].toSorted()
  for (const locator of locators) {
    const blob = blobAt(checkout, head, locator)
    if (blob === undefined) continue
    const digest = sha256Hex(blob)
    if (!approvals.some(approval => approval.locator === locator && approval.digest === digest)) {
      problems.push(
        `Regenerable rule ${locator} at ${head.slice(0, 12)} has digest ${digest.slice(0, 12)}, which the user has not approved; approve this exact version before it can cover files.`
      )
      continue
    }
    let rules
    try {
      rules = Schema.decodeUnknownSync(RuleSet)(JSON.parse(blob.toString('utf8')))
    } catch (cause) {
      problems.push(`Regenerable rule ${locator} is not a valid rule set: ${errorText(cause)}`)
      continue
    }
    const entries = rules.regenerable.map(entry => entry.replace(/^\.\//, ''))
    if (entries.some(entry => entry.startsWith('/') || entry.split('/').includes('..'))) {
      problems.push(`Regenerable rule ${locator} names a path outside the workspace`)
      continue
    }
    approved.push({
      locator,
      digest,
      directories: entries.filter(entry => entry.endsWith('/')),
      files: entries.filter(entry => !entry.endsWith('/')),
    })
  }
  return { approved, problems }
}
const ruleCovers = (rules: readonly ApprovedRule[], path: string): ApprovedRule | undefined =>
  rules.find(
    rule =>
      rule.files.includes(path) || rule.directories.some(directory => path.startsWith(directory))
  )

export interface IntegrationProof {
  readonly verdict: EvidenceVerdict
  readonly reasons: readonly string[]
  readonly targetTip: string | undefined
}
const branchOf = (ref: string): string => ref.replace(/^refs\/heads\//, '')

const provePullRequest = (
  reader: GitHubReader,
  checkout: string,
  target: Extract<TaskTarget, { readonly kind: 'github' }>,
  source: string,
  tip: string
): IntegrationProof => {
  const reasons: string[] = []
  const unknown = (reason: string): IntegrationProof => ({
    verdict: 'unknown',
    reasons: [...reasons, reason],
    targetTip: tip,
  })
  let candidates: readonly number[]
  if (target.pullRequest === undefined) {
    const found = reader.mergedPullRequestsForCommit(target.repository, source)
    if (isUnavailable(found))
      return unknown(`GitHub pull requests for ${source}: ${found.unavailable}`)
    candidates = found
  } else candidates = [target.pullRequest]
  if (candidates.length === 0)
    return {
      verdict: 'invalid',
      reasons: [`GitHub lists no merged pull request whose commits include exactly ${source}`],
      targetTip: tip,
    }
  const expectedSource = target.sourceRepository ?? target.repository
  for (const number of candidates) {
    const pull = reader.pullRequest(target.repository, number)
    if (pull === 'missing') {
      reasons.push(`Pull request #${number} does not exist in ${target.repository}`)
      continue
    }
    if (isUnavailable(pull)) return unknown(`GitHub pull request #${number}: ${pull.unavailable}`)
    const label = `${target.repository}#${number}`
    if (!pull.merged) {
      reasons.push(`${label} is not merged`)
      continue
    }
    if (pull.baseRepository !== target.repository || pull.baseRef !== branchOf(target.ref)) {
      reasons.push(
        `${label} targets ${pull.baseRepository} ${pull.baseRef}, not the agreed ${target.repository} ${branchOf(target.ref)}`
      )
      continue
    }
    if (pull.headRepository === undefined)
      return unknown(
        `${label} no longer names its source repository, so the merged source cannot be bound`
      )
    if (pull.headRepository !== expectedSource) {
      reasons.push(
        `${label} was merged from ${pull.headRepository}, not from the agreed source repository ${expectedSource}`
      )
      continue
    }
    if (pull.commits > 250)
      return unknown(`${label} has more than 250 commits; its merged head cannot be bound`)
    const commits = reader.pullRequestCommits(target.repository, number)
    if (isUnavailable(commits)) return unknown(`${label} commits: ${commits.unavailable}`)
    const mergedHead = commits.at(-1)
    if (mergedHead === undefined) return unknown(`${label} lists no commits`)

    if (mergedHead !== pull.headSha)
      return unknown(
        `${label} lists ${mergedHead.slice(0, 12)} as its last commit but ${pull.headSha.slice(0, 12)} as its head; the merged source cannot be bound`
      )
    if (mergedHead !== source) {
      reasons.push(
        `${label} merged head ${mergedHead.slice(0, 12)}, but this worktree is at ${source.slice(0, 12)}; extra or different local commits are not covered by that merge`
      )
      continue
    }
    if (pull.mergeCommit === undefined) return unknown(`${label} reports no merge result commit`)
    const result = pull.mergeCommit
    let reachable: 'ancestor' | 'not-ancestor' | undefined
    if (hasCommit(checkout, result) && hasCommit(checkout, tip)) {
      const local = ancestry(checkout, result, tip)
      if (typeof local === 'string') reachable = local
    }
    if (reachable === undefined) {
      const status = reader.compare(target.repository, result, tip)
      if (isUnavailable(status))
        return unknown(`${label} merge result reachability: ${status.unavailable}`)
      reachable = status === 'identical' || status === 'ahead' ? 'ancestor' : 'not-ancestor'
    }
    if (reachable === 'not-ancestor') {
      reasons.push(
        `${label} merge result ${result.slice(0, 12)} is not reachable from the current ${target.ref} tip ${tip.slice(0, 12)}`
      )
      continue
    }
    return {
      verdict: 'valid',
      reasons: [
        `${label} merged exactly ${source.slice(0, 12)} from ${expectedSource} into ${target.repository} ${branchOf(target.ref)}; its result ${result.slice(0, 12)} is reachable from the current tip ${tip.slice(0, 12)}`,
      ],
      targetTip: tip,
    }
  }
  return { verdict: 'invalid', reasons, targetTip: tip }
}

const targetText = (target: TaskTarget): string => {
  switch (target.kind) {
    case 'local':
      return `local ${target.ref}`
    case 'remote':
      return `${target.remote} ${target.ref}`
    case 'github':
      return `${target.repository} ${target.ref}`
  }
}

export const proveIntegration = (
  reader: GitHubReader,
  checkout: string,
  source: string | undefined,
  target: TaskTarget | undefined
): IntegrationProof => {
  if (target === undefined)
    return {
      verdict: 'unknown',
      reasons: [
        'No agreed integration target is recorded for this task; the workflow records it through workspace_evidence set-target.',
      ],
      targetTip: undefined,
    }
  if (source === undefined)
    return {
      verdict: 'unknown',
      reasons: ['The worktree has no current commit'],
      targetTip: undefined,
    }
  let tip: string
  let tipLocal: boolean
  if (target.kind === 'local') {
    const resolved = resolveLocalRef(checkout, target.ref)
    if (resolved === undefined)
      return {
        verdict: 'unknown',
        reasons: [`The agreed local ref ${target.ref} does not exist in this repository`],
        targetTip: undefined,
      }
    tip = resolved
    tipLocal = true
  } else if (target.kind === 'remote') {
    const remote = remoteTip(checkout, target.remote, target.ref)
    if (remote === 'missing')
      return {
        verdict: 'unknown',
        reasons: [`Remote ${target.remote} has no ref ${target.ref}`],
        targetTip: undefined,
      }
    if ('error' in remote)
      return {
        verdict: 'unknown',
        reasons: [`Remote ${target.remote} could not be read: ${remote.error}`],
        targetTip: undefined,
      }
    tip = remote.sha
    tipLocal = hasCommit(checkout, tip)
  } else {
    const remote = reader.refTip(target.repository, target.ref)
    if (remote === 'missing')
      return {
        verdict: 'unknown',
        reasons: [`${target.repository} has no ref ${target.ref}`],
        targetTip: undefined,
      }
    if (isUnavailable(remote))
      return {
        verdict: 'unknown',
        reasons: [`GitHub ref ${target.repository} ${target.ref}: ${remote.unavailable}`],
        targetTip: undefined,
      }
    tip = remote
    tipLocal = hasCommit(checkout, tip)
  }
  const describeTarget = targetText(target)
  if (tipLocal) {
    const local = ancestry(checkout, source, tip)
    if (local === 'ancestor')
      return {
        verdict: 'valid',
        reasons: [
          `${source.slice(0, 12)} is an ancestor of the current ${describeTarget} tip ${tip.slice(0, 12)}`,
        ],
        targetTip: tip,
      }
    if (typeof local !== 'string')
      return {
        verdict: 'unknown',
        reasons: [`Ancestry could not be read: ${local.error}`],
        targetTip: tip,
      }
    if (isShallowRepository(checkout))
      return {
        verdict: 'unknown',
        reasons: [
          `History is shallow, so a negative ancestry result for ${describeTarget} proves nothing`,
        ],
        targetTip: tip,
      }
    if (target.kind !== 'github')
      return {
        verdict: 'invalid',
        reasons: [
          `${source.slice(0, 12)} is not integrated into the current ${describeTarget} tip ${tip.slice(0, 12)} (complete history)`,
        ],
        targetTip: tip,
      }
    const proof = provePullRequest(reader, checkout, target, source, tip)
    return proof.verdict === 'valid'
      ? proof
      : {
          ...proof,
          reasons: [
            `${source.slice(0, 12)} is not an ancestor of the current ${describeTarget} tip ${tip.slice(0, 12)}`,
            ...proof.reasons,
          ],
        }
  }
  if (target.kind !== 'github')
    return {
      verdict: 'unknown',
      reasons: [
        `The current ${describeTarget} tip ${tip.slice(0, 12)} is not present locally and dev fetches nothing; fetch it with Git, then check again`,
      ],
      targetTip: tip,
    }
  const status = reader.compare(target.repository, source, tip)
  if (isUnavailable(status))
    return {
      verdict: 'unknown',
      reasons: [
        `GitHub comparison ${source.slice(0, 12)}...${tip.slice(0, 12)}: ${status.unavailable}`,
      ],
      targetTip: tip,
    }
  if (status === 'identical' || status === 'ahead')
    return {
      verdict: 'valid',
      reasons: [
        `GitHub reports ${source.slice(0, 12)} reachable from the current ${describeTarget} tip ${tip.slice(0, 12)} (${status})`,
      ],
      targetTip: tip,
    }
  const proof = provePullRequest(reader, checkout, target, source, tip)
  return proof.verdict === 'valid'
    ? proof
    : {
        ...proof,
        reasons: [
          `GitHub reports ${source.slice(0, 12)} ${status} relative to the current ${describeTarget} tip ${tip.slice(0, 12)}`,
          ...proof.reasons,
        ],
      }
}

export interface EvidenceSubject {
  readonly checkout: string
  readonly head: string | undefined
  readonly target: TaskTarget | undefined
  readonly publications: readonly PublicationReference[]
  readonly approvals: readonly RuleApproval[]
}
export interface EvidenceResult {
  readonly verdict: EvidenceVerdict
  readonly reasons: readonly string[]
  readonly integration: IntegrationProof
  readonly inventory: Inventory
  readonly manifest: readonly ManifestEntry[]
  readonly counts: {
    readonly trackedChanges: number
    readonly files: number
    readonly published: number
    readonly regenerable: number
    readonly blocking: number
  }
  readonly stateDigest: string
}

export const stateDigestOf = (input: {
  readonly head: string | undefined
  readonly inventory: Inventory | undefined
  readonly targetTip: string | undefined
  readonly publications: readonly PublicationReference[]
  readonly approvals: readonly RuleApproval[]
  readonly absent?: boolean
}): string =>
  sha256Hex(
    JSON.stringify({
      policy: EVIDENCE_POLICY_VERSION,
      head: input.head ?? null,
      absent: input.absent === true,
      targetTip: input.targetTip ?? null,
      tracked: input.inventory?.tracked.map(change => [change.kind, change.path]) ?? null,
      files:
        input.inventory?.files.map(file =>
          file.kind === 'file' || file.kind === 'symlink'
            ? [file.kind, file.path, file.size, file.device, file.inode, file.mtimeNs]
            : [file.kind, file.path]
        ) ?? null,
      publications: input.publications
        .map(reference => `${reference.relativePath}\0${reference.sha256}\0${reference.byteLength}`)
        .toSorted(),
      approvals: input.approvals
        .map(approval => `${approval.locator}\0${approval.digest}`)
        .toSorted(),
    })
  )

export const verifyEvidence = (
  reader: GitHubReader,
  subject: EvidenceSubject,
  inventory: Inventory = readInventory(subject.checkout, subject.head)
): EvidenceResult => {
  const invalid: string[] = []
  const unknown: string[] = []
  for (const change of inventory.tracked)
    invalid.push(
      change.kind === 'conflict'
        ? `Unresolved conflict: ${change.path}`
        : `Modified or staged tracked file: ${change.path}`
    )
  const integration = proveIntegration(reader, subject.checkout, subject.head, subject.target)
  if (integration.verdict === 'invalid') invalid.push(...integration.reasons)
  if (integration.verdict === 'unknown') unknown.push(...integration.reasons)

  const rules = evaluateRules(subject.checkout, subject.head, subject.approvals)
  invalid.push(...rules.problems)
  const manifest: ManifestEntry[] = []
  const publicationsByPath = new Map<string, PublicationReference[]>()
  for (const reference of subject.publications) {
    const references = publicationsByPath.get(reference.relativePath)
    if (references === undefined) publicationsByPath.set(reference.relativePath, [reference])
    else references.push(reference)
  }
  let published = 0
  let regenerable = 0
  let blocking = 0
  for (const file of inventory.files) {
    if (file.kind === 'nested-repository') {
      blocking += 1
      invalid.push(`Nested repository is not entered or removed: ${file.path}/`)
      continue
    }
    if (file.kind === 'unreadable') {
      blocking += 1
      unknown.push(`Unreadable inventory entry: ${file.path} (${file.detail ?? 'unknown'})`)
      continue
    }
    if (file.kind === 'other') {
      blocking += 1
      unknown.push(`Unsupported inventory entry: ${file.path} ${file.detail ?? ''}`.trim())
      continue
    }
    if (file.kind !== 'file' && file.kind !== 'symlink') continue
    const identity = {
      path: file.path,
      device: file.device,
      inode: file.inode,
      size: file.size,
      mtimeNs: file.mtimeNs,
      state: 'pending' as const,
    }
    if (sensitiveName(file.path)) {
      blocking += 1
      invalid.push(
        `Possibly sensitive file is never disposed of by a rule or publication: ${file.path}`
      )
      continue
    }
    const references = publicationsByPath.get(file.path)
    if (references !== undefined && file.kind === 'file') {
      const digest = sha256Hex(readFileSync(join(subject.checkout, file.path)))
      const match = references.find(
        reference => reference.sha256 === digest && reference.byteLength === file.size
      )
      if (match !== undefined) {
        published += 1
        manifest.push({ ...identity, kind: 'file', sha256: digest, coverage: 'published' })
        continue
      }
      blocking += 1
      invalid.push(
        `Selected artifact changed since its publication (${references.map(reference => reference.destination.url).join(', ')}); publish the current bytes first: ${file.path}`
      )
      continue
    }
    const rule = ruleCovers(rules.approved, file.path)
    if (rule !== undefined) {
      regenerable += 1
      manifest.push({ ...identity, kind: file.kind, coverage: 'regenerable' })
      continue
    }
    blocking += 1
    invalid.push(
      file.kind === 'symlink'
        ? `Symbolic link is neither published nor covered by an approved rule: ${file.path}`
        : `Untracked or ignored file is neither published nor covered by an approved rule: ${file.path}`
    )
  }
  let verdict: EvidenceVerdict = 'valid'
  if (invalid.length > 0) verdict = 'invalid'
  else if (unknown.length > 0) verdict = 'unknown'
  return {
    verdict,
    reasons: verdict === 'valid' ? [...integration.reasons] : [...invalid, ...unknown],
    integration,
    inventory,
    manifest,
    counts: {
      trackedChanges: inventory.tracked.length,
      files: inventory.files.length,
      published,
      regenerable,
      blocking,
    },
    stateDigest: stateDigestOf({
      head: subject.head,
      inventory,
      targetTip: integration.targetTip,
      publications: subject.publications,
      approvals: subject.approvals,
    }),
  }
}
