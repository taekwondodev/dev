import { Number as Num, Schema } from 'effect'

export const ROLES = ['lead', 'coordinator', 'leaf', 'child', 'unattributed'] as const
export type Role = (typeof ROLES)[number]

export const USAGE_SOURCES = [
  'assistant',
  'tool',
  'standalone',
  'compaction',
  'branch-summary',
] as const

export const OUTCOMES = [
  'returned',
  'invocation',
  'execution',
  'blocked',
  'cancelled',
  'unclassified',
  'unmatched',
] as const
export type Outcome = (typeof OUTCOMES)[number]

const FAILURE_OUTCOMES = ['invocation', 'execution', 'blocked', 'unclassified'] as const

export const isFailure = (outcome: Outcome): boolean =>
  FAILURE_OUTCOMES.some(failure => failure === outcome)

export const GIT_INSPECT_OPERATIONS = [
  'status',
  'diff',
  'staged-diff',
  'log',
  'show',
  'files',
] as const

export const EXPORTED_TOOLS = [
  'read',
  'bash',
  'edit',
  'write',
  'grep',
  'find',
  'ls',
  'work',
  'git_inspect',
  'workspace',
] as const

export const EXPORTED_EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export const GIT_COMMANDS = [
  'add',
  'am',
  'annotate',
  'apply',
  'archive',
  'bisect',
  'blame',
  'branch',
  'bundle',
  'cat-file',
  'check-attr',
  'check-ignore',
  'check-mailmap',
  'check-ref-format',
  'checkout',
  'checkout-index',
  'cherry',
  'cherry-pick',
  'citool',
  'clean',
  'clone',
  'column',
  'commit',
  'commit-graph',
  'commit-tree',
  'config',
  'count-objects',
  'credential',
  'describe',
  'diff',
  'diff-files',
  'diff-index',
  'diff-tree',
  'difftool',
  'fast-export',
  'fast-import',
  'fetch',
  'fetch-pack',
  'filter-branch',
  'fmt-merge-msg',
  'for-each-ref',
  'for-each-repo',
  'format-patch',
  'fsck',
  'gc',
  'get-tar-commit-id',
  'grep',
  'gui',
  'hash-object',
  'help',
  'index-pack',
  'init',
  'instaweb',
  'interpret-trailers',
  'log',
  'ls-files',
  'ls-remote',
  'ls-tree',
  'mailinfo',
  'mailsplit',
  'maintenance',
  'merge',
  'merge-base',
  'merge-file',
  'merge-index',
  'merge-tree',
  'mergetool',
  'mktag',
  'mktree',
  'multi-pack-index',
  'mv',
  'name-rev',
  'notes',
  'pack-objects',
  'pack-refs',
  'prune',
  'prune-packed',
  'pull',
  'push',
  'range-diff',
  'read-tree',
  'rebase',
  'reflog',
  'remote',
  'repack',
  'replace',
  'request-pull',
  'rerere',
  'reset',
  'restore',
  'rev-list',
  'rev-parse',
  'revert',
  'rm',
  'send-email',
  'shortlog',
  'show',
  'show-branch',
  'show-index',
  'show-ref',
  'sparse-checkout',
  'stage',
  'stash',
  'status',
  'stripspace',
  'submodule',
  'switch',
  'symbolic-ref',
  'tag',
  'unpack-file',
  'unpack-objects',
  'update-index',
  'update-ref',
  'update-server-info',
  'var',
  'verify-commit',
  'verify-pack',
  'verify-tag',
  'version',
  'whatchanged',
  'worktree',
  'write-tree',
] as const

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Amount = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
const Share = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
const IsoDate = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/))

export const TokenTotals = Schema.Struct({
  entries: Count,
  unknown: Count,
  input: Amount,
  output: Amount,
  reasoning: Amount,
  reasoningEntries: Count,
  cacheRead: Amount,
  cacheWrite: Amount,
  uncached: Amount,
  cacheReadShare: Schema.NullOr(Share),
})
export type TokenTotals = typeof TokenTotals.Type

export const OutcomeCounts = Schema.Record(Schema.Literals(OUTCOMES), Count)
export type OutcomeCounts = typeof OutcomeCounts.Type

export const TotalsByRole = Schema.Record(Schema.Literals(ROLES), TokenTotals)
export const TotalsBySource = Schema.Record(Schema.Literals(USAGE_SOURCES), TokenTotals)

export const failureCount = (outcomes: OutcomeCounts): number =>
  Num.sumAll(FAILURE_OUTCOMES.map(outcome => outcomes[outcome]))

const toolRow = <Name extends Schema.Top>(tool: Name) =>
  Schema.Struct({
    tool,
    invocations: Count,
    outcomes: OutcomeCounts,
    results: Count,
    bytes: Count,
    meanBytes: Schema.NullOr(Amount),
    medianBytes: Schema.NullOr(Count),
    p90Bytes: Schema.NullOr(Count),
    share: Share,
  })

const tools = <Name extends Schema.Top>(tool: Name) =>
  Schema.Struct({
    invocations: Count,
    matched: Count,
    unmatchedCalls: Count,
    interruptedUnmatched: Count,
    unmatchedResults: Count,
    outcomes: OutcomeCounts,
    candidateSequences: Schema.Struct({ repeatedErrors: Count, recoveries: Count }),
    byTool: Schema.Array(toolRow(tool)),
  })
const Tools = tools(Schema.String)
export type Tools = typeof Tools.Type

export const Reads = Schema.Struct({
  calls: Count,
  failed: Count,
  unknownCoverage: Count,
  bytes: Count,
  relations: Schema.Struct({
    first: Count,
    pagination: Count,
    disjoint: Count,
    overlap: Count,
    unknown: Count,
  }),
  overlap: Schema.Struct({
    identical: Count,
    changed: Count,
    afterCompaction: Count,
    afterContextEdit: Count,
    afterOwnWrite: Count,
    lines: Count,
    bytes: Count,
  }),
  truncation: Schema.Struct({ lines: Count, bytes: Count, firstLine: Count }),
  limited: Count,
  crossAgent: Schema.Struct({ paths: Count, reads: Count }),
})
export type Reads = typeof Reads.Type

const gitRow = <Operation extends Schema.Top>(operation: Operation) =>
  Schema.Struct({
    tool: Schema.Literals(['bash', 'git_inspect']),
    operation,
    requests: Count,
    repeats: Count,
    identicalResults: Count,
    truncated: Count,
  })

const git = <Operation extends Schema.Top>(operation: Operation) =>
  Schema.Struct({
    requests: Count,
    whole: Count,
    inCompound: Count,
    truncated: Count,
    repeats: Schema.Struct({
      requests: Count,
      identicalResults: Count,
      changedResults: Count,
      unknownResults: Count,
    }),
    byOperation: Schema.Array(gitRow(operation)),
  })
const Git = git(Schema.String)
export type Git = typeof Git.Type

const Distribution = Schema.NullOr(Schema.Struct({ median: Amount, p90: Amount, max: Amount }))
export type Distribution = typeof Distribution.Type

export const Context = Schema.Struct({
  sessions: Count,
  initialTokens: Distribution,
  peakTokens: Distribution,
  growthTokens: Distribution,
  compactions: Count,
  tokensBefore: Schema.Struct({ recorded: Count, total: Amount, median: Schema.NullOr(Amount) }),
  synthesis: TokenTotals,
  afterCompaction: Schema.Struct({ requests: Count, withoutCacheRead: Count }),
})
export type Context = typeof Context.Type

const lead = <Name extends Schema.Top>(tool: Name) =>
  Schema.NullOr(
    Schema.Struct({
      sessions: Count,
      toolCallsPerSession: Schema.Struct({ median: Count, minimum: Count, maximum: Count }),
      toolResults: Schema.Struct({
        results: Count,
        bytes: Count,
        meanBytes: Schema.NullOr(Amount),
        byTool: Schema.Array(Schema.Struct({ tool, results: Count, bytes: Count, share: Share })),
      }),
      children: Schema.Struct({
        agentAttempts: Count,
        processAttempts: Count,
        meanPerSession: Amount,
        sessionShare: Share,
      }),
      latency: Schema.Struct({ requests: Count, p50Ms: Schema.Finite, p90Ms: Schema.Finite }),
      timeSplit: Schema.Struct({
        modelMs: Schema.Finite,
        toolMs: Schema.Finite,
        userMs: Schema.Finite,
      }),
    })
  )
const Lead = lead(Schema.String)
export type Lead = typeof Lead.Type

export const Attribution = Schema.Struct({
  entries: Count,
  modelUnrecorded: Count,
  effortUnrecorded: Count,
  childSessions: Count,
  unattributedChildSessions: Count,
})
export type Attribution = typeof Attribution.Type

export const Sample = Schema.Struct({
  leadSessions: Count,
  childSessions: Count,
  requests: Count,
  toolCalls: Count,
  firstDate: IsoDate,
  lastDate: IsoDate,
})
export type Sample = typeof Sample.Type

const ExportedTool = Schema.Literals([...EXPORTED_TOOLS, 'other'])

export const UsageExport = Schema.Struct({
  period: Schema.Struct({ start: Schema.NullOr(IsoDate), end: Schema.NullOr(IsoDate) }),
  undecodableLinesInDataHome: Count,
  sample: Sample,
  usage: Schema.Struct({
    total: TokenTotals,
    bySource: TotalsBySource,
    requests: Schema.Struct({ first: TokenTotals, later: TokenTotals }),
    byRole: TotalsByRole,
    byEffort: Schema.Array(
      Schema.Struct({
        effort: Schema.Literals([...EXPORTED_EFFORTS, 'unrecorded', 'other']),
        tokens: TokenTotals,
      })
    ),
  }),
  attribution: Attribution,
  tools: tools(ExportedTool),
  reads: Reads,
  git: git(Schema.Literals([...GIT_COMMANDS, 'staged-diff', 'files', 'invalid', 'other'])),
  context: Context,
  lead: lead(ExportedTool),
})
export type UsageExport = typeof UsageExport.Type
