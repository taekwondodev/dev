import { execFile as execFileCallback, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readlinkSync, realpathSync, type BigIntStats } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { Option, Schema } from 'effect'
import { errorText } from './error-text.ts'
import {
  branchName,
  integrationUnknown,
  type IntegrationFacts,
  type Proof,
  type PullRequestFact,
  type PullRequestSeed,
} from './workspace-completion.ts'
import {
  CommitSha,
  TaskTargetSchema,
  blocked,
  type EvidenceVerdict,
  type PublicationReference,
  type TargetView,
  type TaskTarget,
  WORKER_REQUEST_TIMEOUT_MS,
} from './workspace-domain.ts'
import {
  ancestry,
  assertUnfilteredIndex,
  branchPushRef,
  hasCommit,
  indexSnapshot,
  isShallowRepository,
  remoteHead,
  remoteNames,
  remotePushUrls,
  remoteTip,
  remoteUrl,
  resolveLocalRef,
  trackedChanges,
  untrackedPaths,
  type TrackedChange,
} from './workspace-git.ts'
import type { ManifestEntry } from './workspace-records.ts'
import { hasErrorCode, regularFileDigest } from './workspace-platform.ts'
import { observePhysicalIdentity, type PhysicalObservation } from './workspace-identity.ts'

export const EVIDENCE_POLICY_VERSION = 4

export const sha256Hex = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex')

export interface GitHubPullRequest {
  readonly merged: boolean
  readonly mergedAt: string | undefined
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

export type GitHubCommitListEvidence =
  | { readonly kind: 'complete'; readonly commits: readonly string[] }
  | { readonly kind: 'incomplete' }

export interface GitHubPullRequestEvidence {
  readonly tip: string | 'missing' | Unavailable
  readonly pullRequest: GitHubPullRequest | 'missing' | Unavailable
  readonly commits: GitHubCommitListEvidence | Unavailable | undefined
}

export interface GitHubReader {
  pullRequestEvidence?(
    repository: string,
    ref: string,
    number: number
  ): GitHubPullRequestEvidence | Unavailable
  prefetchPullRequestEvidence?(
    repository: string,
    ref: string,
    number: number
  ): Promise<GitHubPullRequestEvidence | Unavailable>
  defaultBranch(repository: string): string | 'missing' | Unavailable
  refTip(repository: string, ref: string): string | 'missing' | Unavailable
  pullRequest(repository: string, number: number): GitHubPullRequest | 'missing' | Unavailable

  pullRequestCommits(repository: string, number: number): readonly string[] | Unavailable
  mergedPullRequestsForCommit(repository: string, sha: string): readonly number[] | Unavailable
  compare(repository: string, base: string, head: string): CompareStatus | Unavailable
}

const PullRequestPayload = Schema.Struct({
  merged: Schema.Boolean,
  merged_at: Schema.NullOr(Schema.String),
  merge_commit_sha: Schema.NullOr(CommitSha),
  head: Schema.Struct({
    sha: CommitSha,
    repo: Schema.NullOr(Schema.Struct({ full_name: Schema.String })),
  }),
  base: Schema.Struct({ ref: Schema.String, repo: Schema.Struct({ full_name: Schema.String }) }),
  commits: Schema.Int,
})
const RepositoryPayload = Schema.Struct({ default_branch: Schema.NonEmptyString })
const RefPayload = Schema.Struct({ object: Schema.Struct({ sha: CommitSha }) })
const CommitListPayload = Schema.Array(Schema.Struct({ sha: CommitSha }))
const PullListPayload = Schema.Array(
  Schema.Struct({ number: Schema.Int, merged_at: Schema.NullOr(Schema.String) })
)
const ComparePayload = Schema.Struct({
  status: Schema.Literals(['identical', 'ahead', 'behind', 'diverged']),
})
const GraphqlPullRequestEvidencePayload = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({
        ref: Schema.NullOr(Schema.Struct({ target: Schema.Struct({ oid: CommitSha }) })),
        pullRequest: Schema.NullOr(
          Schema.Struct({
            mergedAt: Schema.NullOr(Schema.String),
            baseRefName: Schema.String,
            baseRepository: Schema.Struct({ nameWithOwner: Schema.String }),
            headRefOid: CommitSha,
            headRepository: Schema.NullOr(Schema.Struct({ nameWithOwner: Schema.String })),
            mergeCommit: Schema.NullOr(Schema.Struct({ oid: CommitSha })),
            commits: Schema.Struct({
              totalCount: Schema.Int,
              nodes: Schema.Array(Schema.Struct({ commit: Schema.Struct({ oid: CommitSha }) })),
              pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean }),
            }),
          })
        ),
      })
    ),
  }),
  errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String }))),
})

export const PROVIDER_BUDGET_MS = WORKER_REQUEST_TIMEOUT_MS / 2
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
interface GhResponse {
  readonly status: 'ok' | 'not-found'
  readonly text: string
}
type GhCall = (endpoint: string, timeoutMs: number) => GhResponse
type GhGraphqlCall = (
  repository: string,
  ref: string,
  number: number,
  timeoutMs: number
) => GhResponse
type GhGraphqlCallAsync = (
  repository: string,
  ref: string,
  number: number,
  timeoutMs: number,
  signal: AbortSignal
) => Promise<GhResponse>
const PULL_REQUEST_EVIDENCE_QUERY = `query($owner: String!, $name: String!, $number: Int!, $ref: String!) {
  repository(owner: $owner, name: $name) {
    ref(qualifiedName: $ref) { target { oid } }
    pullRequest(number: $number) {
      mergedAt
      baseRefName
      baseRepository { nameWithOwner }
      headRefOid
      headRepository { nameWithOwner }
      mergeCommit { oid }
      commits(first: 100) {
        totalCount
        nodes { commit { oid } }
        pageInfo { hasNextPage }
      }
    }
  }
}`
const ghGraphql: GhGraphqlCall = (repository, ref, number, timeoutMs) => {
  const [owner, name] = repository.split('/')
  if (owner === undefined || name === undefined)
    throw new Error(`Invalid GitHub repository name: ${repository}`)
  try {
    const text = execFileSync(
      'gh',
      [
        'api',
        'graphql',
        '-H',
        'Accept: application/vnd.github+json',
        '-f',
        `query=${PULL_REQUEST_EVIDENCE_QUERY}`,
        '-F',
        `owner=${owner}`,
        '-F',
        `name=${name}`,
        '-F',
        `number=${number}`,
        '-F',
        `ref=${ref}`,
      ],
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
    throw new Error(`gh api graphql failed: ${stderr.trim() || errorText(cause)}`, { cause })
  }
}
const ghGraphqlAsync: GhGraphqlCallAsync = (repository, ref, number, timeoutMs, signal) => {
  const [owner, name] = repository.split('/')
  if (owner === undefined || name === undefined)
    return Promise.reject(new Error(`Invalid GitHub repository name: ${repository}`))
  return new Promise((resolve, reject) => {
    execFileCallback(
      'gh',
      [
        'api',
        'graphql',
        '-H',
        'Accept: application/vnd.github+json',
        '-f',
        `query=${PULL_REQUEST_EVIDENCE_QUERY}`,
        '-F',
        `owner=${owner}`,
        '-F',
        `name=${name}`,
        '-F',
        `number=${number}`,
        '-F',
        `ref=${ref}`,
      ],
      {
        encoding: 'utf8',
        timeout: timeoutMs,
        signal,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
      },
      (cause, stdout, stderr) => {
        if (cause === null) {
          resolve({ status: 'ok', text: stdout })
          return
        }
        const message = String(stderr).trim() || errorText(cause)
        if (/HTTP 404/.test(message)) {
          resolve({ status: 'not-found', text: '' })
          return
        }
        reject(new Error(`gh api graphql failed: ${message}`, { cause }))
      }
    )
  })
}
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
  clock: () => number = () => performance.now(),
  graphqlCall: GhGraphqlCall = ghGraphql,
  graphqlCallAsync: GhGraphqlCallAsync = ghGraphqlAsync
): GitHubReader => {
  const deadline = clock() + budgetMs

  const answered = new Map<string, ReturnType<GhCall> | Unavailable>()
  const answeredGraphql = new Map<string, GitHubPullRequestEvidence | Unavailable>()
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
  const decodeGraphqlEvidence = (
    response: GhResponse | Unavailable
  ): GitHubPullRequestEvidence | Unavailable => {
    if (isUnavailable(response)) return response
    if (response.status === 'not-found')
      return { tip: 'missing', pullRequest: 'missing', commits: undefined }
    const payload = decode(GraphqlPullRequestEvidencePayload, response.text)
    if (isUnavailable(payload)) return payload
    if (payload.errors !== undefined && payload.errors.length > 0)
      return {
        unavailable: `GitHub GraphQL returned errors: ${payload.errors.map(error => error.message).join('; ')}`,
      }
    const data = payload.data.repository
    const refValue = data?.ref
    const pull = data?.pullRequest
    const tip = refValue === null || refValue === undefined ? 'missing' : refValue.target.oid
    const pullRequest: GitHubPullRequest | 'missing' =
      pull === null || pull === undefined
        ? 'missing'
        : {
            merged: pull.mergedAt !== null,
            mergedAt: pull.mergedAt ?? undefined,
            mergeCommit: pull.mergeCommit?.oid,
            headSha: pull.headRefOid,
            headRepository: pull.headRepository?.nameWithOwner,
            baseRepository: pull.baseRepository.nameWithOwner,
            baseRef: pull.baseRefName,
            commits: pull.commits.totalCount,
          }
    let commits: GitHubCommitListEvidence | undefined
    if (pull !== null && pull !== undefined) {
      commits =
        pull.commits.totalCount > 100 || pull.commits.pageInfo.hasNextPage
          ? { kind: 'incomplete' }
          : { kind: 'complete', commits: pull.commits.nodes.map(node => node.commit.oid) }
    }
    return { tip, pullRequest, commits }
  }
  const pullRequestEvidence = (
    repository: string,
    ref: string,
    number: number
  ): GitHubPullRequestEvidence | Unavailable => {
    const key = `graphql:${repository}:${ref}:${number}`
    const known = answeredGraphql.get(key)
    if (known !== undefined) return known
    const remaining = deadline - clock()
    if (remaining <= 0)
      return {
        unavailable: `this request's ${budgetMs / 1000} s GitHub time budget was spent before this read`,
      }
    let response: GhResponse | Unavailable
    try {
      response = graphqlCall(repository, ref, number, Math.ceil(remaining))
    } catch (cause) {
      response = { unavailable: errorText(cause) }
    }
    const evidence = decodeGraphqlEvidence(response)
    answeredGraphql.set(key, evidence)
    return evidence
  }
  const inFlightGraphql = new Map<string, Promise<GitHubPullRequestEvidence | Unavailable>>()
  const prefetchPullRequestEvidence = async (
    repository: string,
    ref: string,
    number: number
  ): Promise<GitHubPullRequestEvidence | Unavailable> => {
    const key = `graphql:${repository}:${ref}:${number}`
    const known = answeredGraphql.get(key)
    if (known !== undefined) return known
    const inFlight = inFlightGraphql.get(key)
    if (inFlight !== undefined) return inFlight
    const remaining = deadline - clock()
    if (remaining <= 0) {
      const unavailable = {
        unavailable: `this request's ${budgetMs / 1000} s GitHub time budget was spent before this read`,
      }
      answeredGraphql.set(key, unavailable)
      return unavailable
    }
    const controller = new AbortController()
    let timeout: NodeJS.Timeout | undefined
    const pending = (async () => {
      let response: GhResponse | Unavailable
      try {
        response = await Promise.race([
          graphqlCallAsync(repository, ref, number, Math.ceil(remaining), controller.signal),
          new Promise<Unavailable>(resolve => {
            timeout = setTimeout(() => {
              controller.abort()
              resolve({
                unavailable: `this request's ${budgetMs / 1000} s GitHub time budget expired during this read`,
              })
            }, remaining)
          }),
        ])
      } catch (cause) {
        response = { unavailable: errorText(cause) }
      } finally {
        if (timeout !== undefined) clearTimeout(timeout)
      }
      const evidence =
        clock() >= deadline
          ? {
              unavailable: `this request's ${budgetMs / 1000} s GitHub time budget expired during this read`,
            }
          : decodeGraphqlEvidence(response)
      answeredGraphql.set(key, evidence)
      return evidence
    })()
    inFlightGraphql.set(key, pending)
    try {
      return await pending
    } finally {
      inFlightGraphql.delete(key)
    }
  }
  return {
    pullRequestEvidence,
    prefetchPullRequestEvidence,
    defaultBranch(repository) {
      const value = read(`repos/${repository}`, RepositoryPayload)
      return value === 'missing' || isUnavailable(value) ? value : value.default_branch
    },
    refTip(repository, ref) {
      const value = read(`repos/${repository}/git/ref/${refPath(ref)}`, RefPayload)
      return value === 'missing' || isUnavailable(value) ? value : value.object.sha
    },
    pullRequest(repository, number) {
      const value = read(`repos/${repository}/pulls/${number}`, PullRequestPayload)
      if (value === 'missing' || isUnavailable(value)) return value
      return {
        merged: value.merged,
        mergedAt: value.merged_at ?? undefined,
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
      readonly volumeUuid: string
      readonly inode: string
      readonly device: string
      readonly mtimeNs: string
    }
  | {
      readonly kind: 'nested-repository' | 'other' | 'unreadable' | 'absent'
      readonly path: string
      readonly detail?: string
    }
export interface Inventory {
  readonly head: string | undefined
  readonly tracked: readonly TrackedChange[]
  readonly trackedFiles: readonly InventoryFile[]
  readonly trackedDigest: string
  readonly files: readonly InventoryFile[]
  readonly untracked: number
  readonly ignored: number
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
  stat: BigIntStats,
  volumeUuid: string
): {
  readonly size: number
  readonly volumeUuid: string
  readonly inode: string
  readonly device: string
  readonly mtimeNs: string
} => ({
  size: Number(stat.size),
  volumeUuid,
  inode: String(stat.ino),
  device: String(stat.dev),
  mtimeNs: String(stat.mtimeNs),
})

const inventoryFileOf = (
  checkout: string,
  volumeUuid: string,
  device: string,
  entry: string
): InventoryFile => {
  if (entry.endsWith('/')) return { path: entry.slice(0, -1), kind: 'nested-repository' }
  let stat
  try {
    const parent = dirname(join(checkout, entry))
    if (realpathSync(parent) !== parent)
      return { path: entry, kind: 'other', detail: 'has a symbolic-link ancestor' }
    stat = lstatSync(join(checkout, entry), { bigint: true })
  } catch (cause) {
    return {
      path: entry,
      kind: hasErrorCode(cause, 'ENOENT') ? 'absent' : 'unreadable',
      detail: errorText(cause),
    }
  }
  const identity = identityOf(stat, volumeUuid)
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
  const root = observePhysicalIdentity(checkout)
  const index = indexSnapshot(checkout)
  const trackedFiles = index.paths.flatMap(entry => {
    const file = inventoryFileOf(checkout, root.identity.volumeUuid, root.device, entry)
    if (file.kind === 'absent') return []
    if (file.kind !== 'file' && file.kind !== 'symlink')
      return blocked(`Cannot inspect tracked entry ${file.path}: ${file.kind}`)
    return [file]
  })
  const others = untrackedPaths(checkout)
  const files = [...others.untracked, ...others.ignored].map(entry =>
    inventoryFileOf(checkout, root.identity.volumeUuid, root.device, entry)
  )
  assertUnfilteredIndex(checkout, index.paths)
  const trackedDigest = sha256Hex(
    JSON.stringify({
      index: index.digest ?? null,
      contents: trackedFiles.map(file => {
        const path = join(checkout, file.path)
        const digest =
          file.kind === 'symlink'
            ? sha256Hex(readlinkSync(path, { encoding: 'buffer' }))
            : regularFileDigest(path)
        return [file.path, digest]
      }),
    })
  )
  return {
    head,
    tracked: trackedChanges(checkout),
    trackedFiles,
    trackedDigest,
    files,
    untracked: others.untracked.length,
    ignored: others.ignored.length,
  }
}

export const entryUnchanged = (
  checkout: string,
  entry: ManifestEntry,
  root: PhysicalObservation
):
  | { readonly state: 'same' }
  | { readonly state: 'absent' }
  | { readonly state: 'changed'; readonly detail: string } => {
  let rootStat
  let stat
  try {
    rootStat = lstatSync(checkout, { bigint: true })
    if (
      !rootStat.isDirectory() ||
      String(rootStat.dev) !== root.device ||
      String(rootStat.ino) !== root.identity.inode
    )
      return { state: 'changed', detail: 'workspace directory changed since the check' }
    stat = lstatSync(join(checkout, entry.path), { bigint: true })
  } catch (cause) {
    if (hasErrorCode(cause, 'ENOENT')) return { state: 'absent' }
    return { state: 'changed', detail: errorText(cause) }
  }
  const identity = identityOf(stat, root.identity.volumeUuid)
  if (
    identity.device !== root.device ||
    identity.volumeUuid !== entry.volumeUuid ||
    identity.inode !== entry.inode ||
    identity.size !== entry.size ||
    identity.mtimeNs !== entry.mtimeNs
  )
    return { state: 'changed', detail: 'identity or content changed since the check' }
  if (!stat.isFile()) return { state: 'changed', detail: 'no longer a regular file' }
  if (sha256Hex(readFileSync(join(checkout, entry.path))) !== entry.sha256)
    return { state: 'changed', detail: 'content digest changed' }
  return { state: 'same' }
}

const short = (sha: string): string => sha.slice(0, 12)
const yes = (reason: string): Proof => ({ kind: 'yes', reason })
const no = (reason: string): Proof => ({ kind: 'no', reason })
const unknownProof = (reason: string): Proof => ({ kind: 'unknown', reason })

const GITHUB_REMOTE =
  /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/|git:\/\/github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/
export const githubRepositoryOf = (url: string): string | undefined => GITHUB_REMOTE.exec(url)?.[1]

export type DerivedTarget = (
  | {
      readonly source: 'override' | 'origin-github' | 'origin-remote'
      readonly target: TaskTarget
    }
  | { readonly source: 'none'; readonly reason: string }
) & { readonly ignored?: string }

const decodeTarget = Schema.decodeUnknownOption(TaskTargetSchema)
const none = (reason: string): DerivedTarget => ({ source: 'none', reason })

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

const originTarget = (reader: GitHubReader, checkout: string): DerivedTarget => {
  let url: string | undefined
  try {
    url = remoteUrl(checkout, 'origin')
  } catch (cause) {
    return none(`The origin remote could not be read: ${errorText(cause)}`)
  }
  if (url === undefined)
    return none(
      'No integration target: none is recorded for the task and the repository has no origin remote.'
    )
  const repository = githubRepositoryOf(url)
  let candidate: unknown
  if (repository === undefined) {
    const head = remoteHead(checkout, 'origin')
    if (head === 'missing') return none('The origin remote reports no HEAD branch.')
    if ('error' in head) return none(`The origin remote HEAD could not be read: ${head.error}`)
    candidate = { kind: 'remote', remote: 'origin', ref: head.ref }
  } else {
    const branch = reader.defaultBranch(repository)
    if (branch === 'missing')
      return none(`GitHub repository ${repository} of the origin remote was not found.`)
    if (isUnavailable(branch))
      return none(`The default branch of ${repository} could not be read: ${branch.unavailable}`)
    candidate = { kind: 'github', repository, ref: `refs/heads/${branch}` }
  }
  const target = decodeTarget(candidate)
  if (Option.isNone(target))
    return none(`The origin remote names an unsupported target: ${JSON.stringify(candidate)}`)
  return {
    source: repository === undefined ? 'origin-remote' : 'origin-github',
    target: target.value,
  }
}

const REMOTE_TRACKING = /^refs\/remotes\/([^/]+)\/(.+)$/

const namesOwnBranch = (
  checkout: string,
  override: TaskTarget,
  branchRef: string | undefined
): boolean => {
  if (branchRef === undefined) return false
  const name = branchName(branchRef)
  const pushRef = branchPushRef(checkout, name)
  const push = pushRef === undefined ? undefined : (REMOTE_TRACKING.exec(pushRef) ?? undefined)
  switch (override.kind) {
    case 'local':
      return (
        override.ref === branchRef ||
        REMOTE_TRACKING.exec(override.ref)?.[2] === name ||
        override.ref === pushRef
      )
    case 'remote':
      return (
        override.ref === branchRef ||
        (push !== undefined &&
          override.remote === push[1] &&
          override.ref === `refs/heads/${push[2]}`)
      )
    case 'github': {
      const pushBranch = push === undefined ? pushRef : `refs/heads/${push[2]}`
      if (override.ref !== branchRef && override.ref !== pushBranch) return false
      return remoteNames(checkout).some(remote => {
        const url = remoteUrl(checkout, remote)
        return (
          (url !== undefined && githubRepositoryOf(url) === override.repository) ||
          remotePushUrls(checkout, remote).some(
            pushUrl => githubRepositoryOf(pushUrl) === override.repository
          )
        )
      })
    }
  }
}

export const deriveTarget = (
  reader: GitHubReader,
  checkout: string,
  override: TaskTarget | undefined,
  branchRef: string | undefined
): DerivedTarget => {
  if (override === undefined) return originTarget(reader, checkout)
  if (!namesOwnBranch(checkout, override, branchRef))
    return { source: 'override', target: override }
  return {
    ...originTarget(reader, checkout),
    ignored: `The recorded target ${targetText(override)} names this worktree's own branch, which proves nothing, so it is ignored.`,
  }
}

const derivedView = (derived: DerivedTarget): TargetView => {
  switch (derived.source) {
    case 'none':
      return { source: 'none', description: derived.reason }
    case 'override':
      return {
        source: 'override',
        description: `${targetText(derived.target)}${derived.target.kind === 'github' && derived.target.pullRequest !== undefined ? ` (pull request #${derived.target.pullRequest})` : ''}, recorded for the task`,
      }
    case 'origin-github':
      return {
        source: 'origin-github',
        description: `${targetText(derived.target)}, the default branch of the origin remote`,
      }
    case 'origin-remote':
      return {
        source: 'origin-remote',
        description: `${targetText(derived.target)}, the HEAD branch of the origin remote`,
      }
  }
}

export const describeTarget = (derived: DerivedTarget): TargetView => {
  const view = derivedView(derived)
  return derived.ignored === undefined
    ? view
    : { ...view, description: `${derived.ignored} ${view.description}` }
}

export const recordedTarget = (
  checkout: string,
  override: TaskTarget | undefined,
  branchRef: string | undefined
): TargetView | undefined =>
  override === undefined || namesOwnBranch(checkout, override, branchRef)
    ? undefined
    : describeTarget({ source: 'override', target: override })

type Tip = { readonly sha: string; readonly local: boolean } | { readonly unknown: string }
type CommitPresence = (sha: string) => boolean

const resolveTip = (
  reader: GitHubReader,
  checkout: string,
  target: TaskTarget,
  commitPresent: CommitPresence
): Tip => {
  if (target.kind === 'local') {
    const resolved = resolveLocalRef(checkout, target.ref)
    return resolved === undefined
      ? { unknown: `The agreed local ref ${target.ref} does not exist in this repository` }
      : { sha: resolved, local: true }
  }
  if (target.kind === 'remote') {
    const remote = remoteTip(checkout, target.remote, target.ref)
    if (remote === 'missing') return { unknown: `Remote ${target.remote} has no ref ${target.ref}` }
    if ('error' in remote)
      return { unknown: `Remote ${target.remote} could not be read: ${remote.error}` }
    return { sha: remote.sha, local: commitPresent(remote.sha) }
  }
  const remote = reader.refTip(target.repository, target.ref)
  if (remote === 'missing') return { unknown: `${target.repository} has no ref ${target.ref}` }
  if (isUnavailable(remote))
    return { unknown: `GitHub ref ${target.repository} ${target.ref}: ${remote.unavailable}` }
  return { sha: remote, local: commitPresent(remote) }
}

const tipAncestry = (
  reader: GitHubReader,
  checkout: string,
  target: TaskTarget,
  commit: string,
  tip: { readonly sha: string; readonly local: boolean }
): Proof => {
  const described = targetText(target)
  if (tip.local) {
    const local = ancestry(checkout, commit, tip.sha)
    if (local === 'ancestor')
      return yes(
        `${short(commit)} is an ancestor of the current ${described} tip ${short(tip.sha)}`
      )
    if (typeof local !== 'string') return unknownProof(`Ancestry could not be read: ${local.error}`)
    if (isShallowRepository(checkout))
      return unknownProof(
        `History is shallow, so a negative ancestry result for ${described} proves nothing`
      )
    return no(
      `${short(commit)} is not integrated into the current ${described} tip ${short(tip.sha)} (complete history)`
    )
  }
  if (target.kind !== 'github')
    return unknownProof(
      `The current ${described} tip ${short(tip.sha)} is not present locally and dev fetches nothing; fetch it with Git, then check again`
    )
  const status = reader.compare(target.repository, commit, tip.sha)
  if (isUnavailable(status))
    return unknownProof(
      `GitHub comparison ${short(commit)}...${short(tip.sha)}: ${status.unavailable}`
    )
  return status === 'identical' || status === 'ahead'
    ? yes(
        `GitHub reports ${short(commit)} reachable from the current ${described} tip ${short(tip.sha)} (${status})`
      )
    : no(
        `GitHub reports ${short(commit)} ${status} relative to the current ${described} tip ${short(tip.sha)}`
      )
}

type Binding =
  | {
      readonly kind: 'bound'
      readonly label: string
      readonly mergedHead: string
      readonly mergeCommit: string
      readonly mergedAt: string | undefined
    }
  | { readonly kind: 'rejected'; readonly reason: string }
  | { readonly kind: 'unknown'; readonly reason: string }
const unbound = (reason: string): Binding => ({ kind: 'rejected', reason })
const unboundable = (reason: string): Binding => ({ kind: 'unknown', reason })

const bindPullRequest = (
  reader: GitHubReader,
  checkout: string,
  target: Extract<TaskTarget, { readonly kind: 'github' }>,
  number: number,
  tip: string,
  preloaded:
    | {
        readonly pullRequest: GitHubPullRequest
        readonly commits?: readonly string[]
      }
    | undefined,
  commitPresent: CommitPresence
): Binding => {
  const label = `${target.repository}#${number}`
  const expectedSource = target.sourceRepository ?? target.repository
  const pull = preloaded?.pullRequest ?? reader.pullRequest(target.repository, number)
  if (pull === 'missing')
    return unbound(`Pull request #${number} does not exist in ${target.repository}`)
  if (isUnavailable(pull)) return unboundable(`GitHub pull request #${number}: ${pull.unavailable}`)
  if (!pull.merged) return unbound(`${label} is not merged`)
  if (pull.baseRepository !== target.repository || pull.baseRef !== branchName(target.ref))
    return unbound(
      `${label} targets ${pull.baseRepository} ${pull.baseRef}, not the agreed ${target.repository} ${branchName(target.ref)}`
    )
  if (pull.headRepository === undefined)
    return unboundable(
      `${label} no longer names its source repository, so the merged source cannot be bound`
    )
  if (pull.headRepository !== expectedSource)
    return unbound(
      `${label} was merged from ${pull.headRepository}, not from the agreed source repository ${expectedSource}`
    )
  if (pull.commits > 250)
    return unboundable(`${label} has more than 250 commits; its merged head cannot be bound`)
  const commits = preloaded?.commits ?? reader.pullRequestCommits(target.repository, number)
  if (isUnavailable(commits)) return unboundable(`${label} commits: ${commits.unavailable}`)
  const mergedHead = commits.at(-1)
  if (mergedHead === undefined) return unboundable(`${label} lists no commits`)
  if (mergedHead !== pull.headSha)
    return unboundable(
      `${label} lists ${short(mergedHead)} as its last commit but ${short(pull.headSha)} as its head; the merged source cannot be bound`
    )
  if (pull.mergeCommit === undefined) return unboundable(`${label} reports no merge result commit`)
  const result = pull.mergeCommit
  let reachable: 'ancestor' | 'not-ancestor' | undefined
  if (commitPresent(result) && commitPresent(tip)) {
    const local = ancestry(checkout, result, tip)
    if (typeof local === 'string') reachable = local
  }
  if (reachable === undefined) {
    const status = reader.compare(target.repository, result, tip)
    if (isUnavailable(status))
      return unboundable(`${label} merge result reachability: ${status.unavailable}`)
    reachable = status === 'identical' || status === 'ahead' ? 'ancestor' : 'not-ancestor'
  }
  if (reachable === 'not-ancestor')
    return unbound(
      `${label} merge result ${short(result)} is not reachable from the current ${target.ref} tip ${short(tip)}`
    )
  return { kind: 'bound', label, mergedHead, mergeCommit: result, mergedAt: pull.mergedAt }
}

const sourceContains = (
  checkout: string,
  label: string,
  mergedHead: string,
  commit: string,
  commitPresent: CommitPresence
): Proof => {
  if (commit === mergedHead) return yes(`${label} merged source is ${short(commit)} itself`)
  if (!commitPresent(mergedHead) || !commitPresent(commit))
    return unknownProof(
      `${label} source history is not locally readable; dev does not fetch to prove ancestry`
    )
  const result = ancestry(checkout, commit, mergedHead)
  if (typeof result !== 'string')
    return unknownProof(`${label} source ancestry could not be read: ${result.error}`)
  if (result === 'ancestor') return yes(`${label} merged source contains ${short(commit)}`)
  if (isShallowRepository(checkout))
    return unknownProof(
      `${label} source history is shallow; negative ancestry does not prove exclusion`
    )
  return no(`${label} merged source ${short(mergedHead)} does not contain ${short(commit)}`)
}

const sourceAncestry = (
  checkout: string,
  target: Extract<TaskTarget, { readonly kind: 'github' }>,
  bound: Extract<Binding, { readonly kind: 'bound' }>,
  tip: string,
  commit: string | undefined,
  what: 'HEAD' | 'base',
  commitPresent: CommitPresence
): Proof => {
  const { label, mergedHead, mergeCommit } = bound
  if (commit === undefined) return no(`this worktree records no ${what} commit`)
  const contained = sourceContains(checkout, label, mergedHead, commit, commitPresent)
  switch (contained.kind) {
    case 'yes':
      return yes(
        `${label} merged source ${short(mergedHead)} into ${target.repository} ${branchName(target.ref)}; this worktree's ${what} ${short(commit)} is in that source history and its result ${short(mergeCommit)} is reachable from the current tip ${short(tip)}`
      )
    case 'no':
      return no(
        `${label} merged source ${short(mergedHead)} does not descend from this worktree's ${what} ${short(commit)}`
      )
    case 'unknown':
      return contained
  }
}

const baseDescent = (
  checkout: string,
  target: Extract<TaskTarget, { readonly kind: 'github' }>,
  bound: Extract<Binding, { readonly kind: 'bound' }>,
  tip: string,
  base: string | undefined,
  allocatedAt: number | undefined,
  commitPresent: CommitPresence
): Proof => {
  const { label, mergedHead, mergedAt } = bound
  if (base === undefined) return no('this worktree records no base commit')
  if (mergedHead === base)
    return no(
      `${label} merged source ${short(mergedHead)} is this worktree's base itself, so it carries nothing made after the allocation`
    )
  if (allocatedAt === undefined)
    return unknownProof('the allocation time of this worktree is not recorded')
  const merged = mergedAt === undefined ? Number.NaN : Date.parse(mergedAt)
  if (Number.isNaN(merged)) return unknownProof(`${label} reports no readable merge time`)
  if (merged <= allocatedAt)
    return no(`${label} was merged at ${mergedAt}, before this worktree was allocated`)
  return sourceAncestry(checkout, target, bound, tip, base, 'base', commitPresent)
}

export interface Siblings {
  readonly heads: readonly string[]
  readonly unknown: readonly string[]
}
export interface IntegrationInput {
  readonly target: TaskTarget
  readonly completionRole?: 'branch' | 'child' | 'detached'
  readonly head: string | undefined
  readonly base: string | undefined
  readonly allocatedAt: number | undefined
  readonly siblings: Siblings
}
export interface IntegrationResult extends IntegrationFacts {
  readonly tip: string | undefined
}

export const integrationFacts = (
  reader: GitHubReader,
  checkout: string,
  input: IntegrationInput
): IntegrationResult => {
  const { target, head, base } = input
  const knownCommits = new Map<string, boolean>()
  const commitPresent: CommitPresence = sha => {
    const known = knownCommits.get(sha)
    if (known !== undefined) return known
    const present = hasCommit(checkout, sha)
    knownCommits.set(sha, present)
    return present
  }
  let bundledEvidence:
    | {
        readonly tip: string
        readonly pullRequest: GitHubPullRequest
        readonly commits?: readonly string[]
      }
    | undefined
  let tip: Tip
  if (target.kind === 'github' && target.pullRequest !== undefined && reader.pullRequestEvidence) {
    const evidence = reader.pullRequestEvidence(target.repository, target.ref, target.pullRequest)
    if (!isUnavailable(evidence) && evidence.tip !== 'missing' && !isUnavailable(evidence.tip)) {
      tip = { sha: evidence.tip, local: commitPresent(evidence.tip) }
      if (evidence.pullRequest !== 'missing' && !isUnavailable(evidence.pullRequest)) {
        const commitList = evidence.commits
        bundledEvidence = {
          tip: evidence.tip,
          pullRequest: evidence.pullRequest,
          ...(commitList !== undefined &&
          !isUnavailable(commitList) &&
          commitList.kind === 'complete'
            ? { commits: commitList.commits }
            : {}),
        }
      }
    } else tip = resolveTip(reader, checkout, target, commitPresent)
  } else tip = resolveTip(reader, checkout, target, commitPresent)
  if ('unknown' in tip) return { tip: undefined, ...integrationUnknown(tip.unknown) }
  const headInTip =
    head === undefined
      ? unknownProof('The worktree has no current commit')
      : tipAncestry(reader, checkout, target, head, tip)
  if (target.kind !== 'github')
    return { tip: tip.sha, headInTip, pullRequests: [], rejected: [], unknown: [] }
  const found = new Map<number, PullRequestSeed[]>()
  const siblingSeeds = new Map<number, string[]>()
  const record = (number: number, seed: PullRequestSeed, commit?: string): void => {
    const seeds = found.get(number) ?? []
    if (!seeds.includes(seed)) seeds.push(seed)
    found.set(number, seeds)
    if (seed === 'sibling' && commit !== undefined)
      siblingSeeds.set(number, [...(siblingSeeds.get(number) ?? []), commit])
  }
  const unknown: string[] = [...input.siblings.unknown]
  if (target.pullRequest !== undefined) {
    const preloaded =
      bundledEvidence === undefined
        ? undefined
        : {
            pullRequest: bundledEvidence.pullRequest,
            ...(bundledEvidence.commits === undefined ? {} : { commits: bundledEvidence.commits }),
          }
    const bound = bindPullRequest(
      reader,
      checkout,
      target,
      target.pullRequest,
      bundledEvidence?.tip ?? tip.sha,
      preloaded,
      commitPresent
    )
    if (bound.kind === 'bound') {
      const containsHead = sourceAncestry(
        checkout,
        target,
        bound,
        tip.sha,
        head,
        'HEAD',
        commitPresent
      )
      const descendsFromBase = baseDescent(
        checkout,
        target,
        bound,
        tip.sha,
        base,
        input.allocatedAt,
        commitPresent
      )
      if (
        containsHead.kind === 'yes' &&
        (input.completionRole === 'branch' ||
          (input.completionRole === 'child' && descendsFromBase.kind === 'yes'))
      )
        return {
          tip: tip.sha,
          headInTip,
          pullRequests: [
            { label: bound.label, seeds: ['override'], containsHead, descendsFromBase },
          ],
          rejected: [],
          unknown,
        }
    }
  }
  const seeds: readonly (readonly [PullRequestSeed, string])[] = [
    ...(head === undefined ? [] : [['head', head] as const]),
    ...(base === undefined ? [] : [['base', base] as const]),
    ...input.siblings.heads.map(sibling => ['sibling', sibling] as const),
  ]
  for (const [seed, commit] of seeds) {
    const numbers = reader.mergedPullRequestsForCommit(target.repository, commit)
    if (isUnavailable(numbers)) {
      unknown.push(`GitHub pull requests for ${short(commit)}: ${numbers.unavailable}`)
      continue
    }
    for (const number of numbers) record(number, seed, commit)
  }
  if (target.pullRequest !== undefined) record(target.pullRequest, 'override')
  const pullRequests: PullRequestFact[] = []
  const rejected: string[] = []
  for (const [number, via] of [...found].toSorted(([left], [right]) => left - right)) {
    const bound = bindPullRequest(
      reader,
      checkout,
      target,
      number,
      tip.sha,
      undefined,
      commitPresent
    )
    if (bound.kind === 'rejected') {
      rejected.push(bound.reason)
      continue
    }
    if (bound.kind === 'unknown') {
      unknown.push(bound.reason)
      continue
    }
    if (via.every(seed => seed === 'sibling')) {
      const containment = (siblingSeeds.get(number) ?? []).map(commit =>
        sourceContains(checkout, bound.label, bound.mergedHead, commit, commitPresent)
      )
      if (!containment.some(proof => proof.kind === 'yes')) {
        const unproven = containment.filter(proof => proof.kind === 'unknown')
        if (unproven.length > 0)
          unknown.push(
            `${bound.label} was found only through sibling commits whose containment cannot be proven: ${unproven.map(proof => proof.reason).join('; ')}`
          )
        else
          rejected.push(
            `${bound.label} was found only through a sibling commit its merged source does not contain`
          )
        continue
      }
    }
    pullRequests.push({
      label: bound.label,
      seeds: via,
      containsHead: sourceAncestry(checkout, target, bound, tip.sha, head, 'HEAD', commitPresent),
      descendsFromBase: baseDescent(
        checkout,
        target,
        bound,
        tip.sha,
        base,
        input.allocatedAt,
        commitPresent
      ),
    })
  }
  if (found.size === 0 && unknown.length === 0)
    rejected.push(
      `GitHub lists no merged pull request for this worktree's HEAD, base or sibling commits in ${target.repository}`
    )
  return { tip: tip.sha, headInTip, pullRequests, rejected, unknown }
}

export const stateDigestOf = (input: {
  readonly head: string | undefined
  readonly inventory: Inventory | undefined
  readonly targetTip: string | undefined
  readonly publications: readonly PublicationReference[]
  readonly absent?: boolean
}): string =>
  sha256Hex(
    JSON.stringify({
      policy: EVIDENCE_POLICY_VERSION,
      head: input.head ?? null,
      absent: input.absent === true,
      targetTip: input.targetTip ?? null,
      tracked: input.inventory?.tracked.map(change => [change.kind, change.path]) ?? null,
      trackedDigest: input.inventory?.trackedDigest ?? null,
      files:
        input.inventory === undefined
          ? null
          : [...input.inventory.trackedFiles, ...input.inventory.files].map(file =>
              file.kind === 'file' || file.kind === 'symlink'
                ? [file.kind, file.path, file.size, file.volumeUuid, file.inode, file.mtimeNs]
                : [file.kind, file.path]
            ),
      publications: input.publications
        .map(reference => `${reference.relativePath}\0${reference.sha256}\0${reference.byteLength}`)
        .toSorted(),
    })
  )

export interface InventoryVerdict {
  readonly verdict: EvidenceVerdict
  readonly reasons: readonly string[]
  readonly inventory: Inventory
  readonly manifest: readonly ManifestEntry[]
  readonly counts: {
    readonly trackedChanges: number
    readonly files: number
    readonly published: number
    readonly disposable: number
    readonly blocking: number
  }
}

export const verifyInventory = (
  checkout: string,
  publications: readonly PublicationReference[],
  inventory: Inventory
): InventoryVerdict => {
  const invalid: string[] = []
  const unknown: string[] = []
  for (const change of inventory.tracked)
    if (change.kind === 'conflict') invalid.push(`Unresolved conflict: ${change.path}`)

  const manifest: ManifestEntry[] = []
  const publicationsByPath = new Map<string, PublicationReference[]>()
  for (const reference of publications) {
    const references = publicationsByPath.get(reference.relativePath)
    if (references === undefined) publicationsByPath.set(reference.relativePath, [reference])
    else references.push(reference)
  }
  let published = 0
  let disposable = 0
  let blocking = 0
  const untracked = new Set(inventory.files.map(file => file.path))
  for (const file of [...inventory.trackedFiles, ...inventory.files]) {
    if (file.kind === 'nested-repository') {
      blocking += 1
      invalid.push(`Nested repository is not entered or removed: ${file.path}/`)
      continue
    }
    if (file.kind === 'unreadable' || file.kind === 'absent') {
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
      volumeUuid: file.volumeUuid,
      inode: file.inode,
      size: file.size,
      mtimeNs: file.mtimeNs,
      state: 'pending' as const,
    }
    const references = publicationsByPath.get(file.path)
    if (references !== undefined && sensitiveName(file.path)) {
      blocking += 1
      invalid.push(
        `Possibly sensitive published artifact is never certified for disposal: ${file.path}`
      )
      continue
    }
    if (references !== undefined && file.kind === 'symlink') {
      blocking += 1
      invalid.push(`Recorded artifact is no longer a regular file: ${file.path}`)
      continue
    }
    if (references !== undefined && file.kind === 'file') {
      const digest = sha256Hex(readFileSync(join(checkout, file.path)))
      const match = references.find(
        reference => reference.sha256 === digest && reference.byteLength === file.size
      )
      if (match !== undefined) {
        published += 1
        manifest.push({ ...identity, sha256: digest })
        continue
      }
      blocking += 1
      invalid.push(
        `Selected artifact changed since its publication (${references.map(reference => reference.destination.url).join(', ')}); publish the current bytes first: ${file.path}`
      )
      continue
    }
    if (untracked.has(file.path)) disposable += 1
  }
  let verdict: EvidenceVerdict = 'valid'
  if (invalid.length > 0) verdict = 'invalid'
  else if (unknown.length > 0) verdict = 'unknown'
  return {
    verdict,
    reasons: [...invalid, ...unknown],
    inventory,
    manifest,
    counts: {
      trackedChanges: inventory.tracked.length,
      files: inventory.files.length,
      published,
      disposable,
      blocking,
    },
  }
}
