import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { HashMap, HashSet, Option } from 'effect'
import {
  GIT_INSPECT_OPERATIONS,
  GIT_COMMANDS,
  isFailure,
  type Outcome,
  type Role,
} from './usage-export.ts'
import {
  type AttemptRecord,
  type Block,
  type Entry,
  type SessionRecord,
  type ToolCall,
  type TruncationDetails,
  type Usage,
  walkBranches,
} from './usage-sessions.ts'

type ResultOutcome = Exclude<Outcome, 'unmatched'>
type RecognizedError = Exclude<ResultOutcome, 'returned' | 'unclassified'>

interface ErrorText {
  readonly outcome: RecognizedError
  readonly pattern: RegExp
  readonly tools?: readonly string[]
}

const BASH = ['bash']
const SEARCH = ['ls', 'find', 'grep']

const ERROR_TEXTS: readonly ErrorText[] = [
  { outcome: 'cancelled', pattern: /(?:^|\n\n)Command aborted$/, tools: BASH },
  {
    outcome: 'execution',
    pattern:
      /(?:^|\n\n)Command (?:exited with code -?\d+|timed out after \d+ seconds|terminated without an exit code)$/,
    tools: BASH,
  },
  {
    outcome: 'execution',
    pattern:
      /^(?:Working directory does not exist: |the shell did not start$|The shell exited before its identity was available$|the shell identity could not be captured$)/,
    tools: BASH,
  },
  { outcome: 'invocation', pattern: /^Invalid timeout: /, tools: BASH },
  {
    outcome: 'blocked',
    pattern:
      /^(?:Workspace admission changed before the shell started|Workspace admission requires a host rebind|The workspace shell is stopping); the command was not executed\.$|^the host is stopping its shells$/,
    tools: BASH,
  },
  { outcome: 'invocation', pattern: /^Offset \d+ is beyond end of file/, tools: ['read'] },
  { outcome: 'invocation', pattern: /^(?:ENOENT|EISDIR|ENOTDIR): /, tools: ['read'] },
  {
    outcome: 'invocation',
    pattern:
      /^(?:Edit tool input is invalid\.|Could not find (?:the exact text|edits\[\d+\]) in |Found \d+ occurrences of |(?:edits\[\d+\]\.)?oldText must not be empty in |No changes made to |edits\[\d+\] and edits\[\d+\] overlap in )|^Could not edit file: [\s\S]*Error code: ENOENT\.$/,
    tools: ['edit'],
  },
  { outcome: 'invocation', pattern: /^(?:Path not found|Not a directory): /, tools: SEARCH },
  {
    outcome: 'execution',
    pattern:
      /^(?:Cannot read directory: |Failed to run (?:fd|ripgrep): )|is not available and could not be downloaded$/,
    tools: SEARCH,
  },
  { outcome: 'invocation', pattern: /^[A-Za-z]+ is required$/, tools: ['work'] },
  { outcome: 'invocation', pattern: /^Tool \S+ not found$/ },
  { outcome: 'invocation', pattern: /^Validation failed for tool "/ },
  {
    outcome: 'invocation',
    pattern: /^Tool call "[^"]*" was not executed: the response hit the output token limit/,
  },
  { outcome: 'cancelled', pattern: /^Operation aborted$/ },
  { outcome: 'blocked', pattern: /^Tool execution was blocked$/ },
  { outcome: 'blocked', pattern: /^Extension failed, blocking execution: / },
  {
    outcome: 'blocked',
    pattern:
      /^Workspace host is parked(?:; stale tools are blocked| during a transition; no operation started)\.$/,
  },
  {
    outcome: 'blocked',
    pattern:
      /^Workspace admission (?:requires a host rebind: [\s\S]*\. The operation was not executed\.$|failed closed: )/,
  },
  {
    outcome: 'blocked',
    pattern: /^Tool \S+ has no verified workspace effect in dev, so it was not executed\./,
  },
  { outcome: 'blocked', pattern: /; the (?:Pi|native) tool was not executed\.$/ },
  { outcome: 'blocked', pattern: /^Native \S+ was not executed: / },
  { outcome: 'blocked', pattern: /^Child workspace is read-only$/ },
  {
    outcome: 'blocked',
    pattern: /^Workspace handoff required before starting work: [\s\S]*No command was executed/,
  },
]

type ResultEntry = Extract<Entry, { kind: 'result' }>
type RequestEntry = Extract<Entry, { kind: 'request' }>

const firstText = (blocks: readonly Block[]): string | undefined =>
  blocks[0]?.type === 'text' ? blocks[0].text : undefined

const textBytes = (blocks: readonly Block[]): number =>
  blocks.reduce(
    (total, block) =>
      block.type === 'text' ? total + Buffer.byteLength(block.text, 'utf8') : total,
    0
  )

const classify = (result: ResultEntry): ResultOutcome => {
  if (!result.isError) return 'returned'
  const text = firstText(result.blocks)
  if (text === undefined) return 'unclassified'
  const recognized = ERROR_TEXTS.find(
    error =>
      (error.tools === undefined || error.tools.includes(result.tool)) && error.pattern.test(text)
  )
  return recognized?.outcome ?? 'unclassified'
}

const recordedAttempts = (entry: Entry): readonly AttemptRecord[] => {
  if (entry.kind === 'outcome') return entry.attempts
  if (entry.kind === 'result') return entry.attempt === undefined ? [] : [entry.attempt]
  return []
}

const roleOf = (attempt: AttemptRecord): Role => {
  if (attempt.coordinator === true) return 'coordinator'
  return attempt.parent === undefined ? 'child' : 'leaf'
}

export const recordedRoles = (session: SessionRecord): (readonly [string, Role])[] =>
  session.entries.flatMap(entry =>
    recordedAttempts(entry).flatMap((attempt): (readonly [string, Role])[] =>
      attempt.kind === 'agent' && attempt.sessionFile !== undefined
        ? [[posix.basename(attempt.sessionFile), roleOf(attempt)]]
        : []
    )
  )

export interface Range {
  readonly start: number
  readonly end: number
}

export interface RequestedRange {
  readonly start: number
  readonly end: number | null
}

type FileIdentity =
  | { readonly kind: 'absolute'; readonly path: string }
  | { readonly kind: 'relative'; readonly scope: string; readonly path: string }

interface ReadFile {
  readonly path: string
  readonly identity: FileIdentity
  readonly key: string
}

interface Workspace {
  readonly cwd: string | null
  readonly handoffs: number
}

const workspaceScope = ({ cwd, handoffs }: Workspace) =>
  `${cwd ?? 'unrecorded cwd'}, ${handoffs} handoffs`

interface Located {
  readonly at: number
  readonly session: string
  readonly role: Role
  readonly ref: string
}

export type UsageFact = Located & { readonly usage: Usage; readonly skill: string | undefined } & (
    | {
        readonly source: 'assistant'
        readonly model: string | undefined
        readonly effort: string | undefined
        readonly first: boolean
        readonly latencyMs: number
        readonly afterCompaction: boolean
      }
    | { readonly source: 'standalone'; readonly model: string | undefined }
    | { readonly source: 'tool' | 'compaction' | 'branch-summary' }
  )

export const modelOf = (fact: UsageFact): string | undefined =>
  fact.source === 'assistant' || fact.source === 'standalone' ? fact.model : undefined

export const effortOf = (fact: UsageFact): string | undefined =>
  fact.source === 'assistant' ? fact.effort : undefined

export type CallFact = Located & { readonly tool: string } & (
    | { readonly outcome: 'unmatched'; readonly interrupted: boolean }
    | { readonly outcome: ResultOutcome; readonly bytes: number }
  )

interface ResultFact extends Located {
  readonly matched: boolean
}

interface SequenceFact extends Located {
  readonly tool: string
  readonly kind: 'repeated-error' | 'recovery'
  readonly earlier: string
}

type ReadStop = 'complete' | 'limit' | 'lines' | 'bytes' | 'first-line'

type ReadRelation =
  | { readonly kind: 'first' | 'pagination' | 'disjoint' | 'unknown' }
  | {
      readonly kind: 'overlap'
      readonly earlier: string
      readonly lines: number
      readonly bytes: number
      readonly identical: boolean
      readonly afterCompaction: boolean
      readonly afterContextEdit: boolean
      readonly afterOwnWrite: boolean
    }

export type ReadFact = Located & { readonly bytes: number } & (
    | {
        readonly coverage: 'failed' | 'unknown'
        readonly file: ReadFile | undefined
        readonly requested: RequestedRange | undefined
      }
    | {
        readonly coverage: 'text'
        readonly file: ReadFile
        readonly requested: RequestedRange
        readonly returned: Range
        readonly stop: ReadStop
        readonly relation: ReadRelation
      }
  )

interface GitRequest {
  readonly tool: 'bash' | 'git_inspect'
  readonly operation: string
  readonly whole: boolean
  readonly key: string
}

export interface GitFact extends Located, GitRequest {
  readonly truncated: boolean
  readonly repeat: 'identical' | 'changed' | 'unknown' | undefined
}

interface CompactionFact extends Located {
  readonly tokensBefore: number | undefined
}

interface TimeFact extends Located {
  readonly category: 'model' | 'tool' | 'user'
  readonly ms: number
}

interface AttemptFact extends Located {
  readonly attempt: string
  readonly kind: 'agent' | 'process'
}

export interface Facts {
  readonly usage: readonly UsageFact[]
  readonly calls: readonly CallFact[]
  readonly results: readonly ResultFact[]
  readonly sequences: readonly SequenceFact[]
  readonly reads: readonly ReadFact[]
  readonly git: readonly GitFact[]
  readonly compactions: readonly CompactionFact[]
  readonly time: readonly TimeFact[]
  readonly attempts: readonly AttemptFact[]
}

interface Paired {
  readonly request: RequestEntry
  readonly call: ToolCall
}

interface SessionIndex {
  readonly session: SessionRecord
  readonly role: Role
  readonly measured: readonly Entry[]
  readonly ref: (entry: Entry) => string
  readonly located: (entry: Entry) => Located
  readonly resultOf: (request: RequestEntry, call: ToolCall) => ResultEntry | undefined
  readonly callOf: (result: ResultEntry) => Paired | undefined
  readonly outcomeOf: (result: ResultEntry) => ResultOutcome
  readonly skillAt: (entry: Entry) => string | undefined
  readonly effortAt: (entry: Entry) => string | undefined
  readonly workspaceAt: (entry: Entry) => Workspace
  readonly afterCompaction: (entry: Entry) => boolean
}

const callKey = (request: Entry, callId: string) => `${request.id}\u0000${callId}`

const NO_WORKSPACE: Workspace = { cwd: null, handoffs: 0 }

const nextWorkspace = (entry: Entry, parent: Workspace): Workspace => {
  if ((entry.kind === 'system' || entry.kind === 'compaction') && entry.cwd.kind !== 'unstated')
    return { cwd: entry.cwd.kind === 'path' ? entry.cwd.path : null, handoffs: 0 }
  if (entry.kind === 'handoff') return { cwd: parent.cwd, handoffs: parent.handoffs + 1 }
  return parent
}

const pairResults = (session: SessionRecord): ReadonlyMap<Entry, Paired> => {
  const pairs = new Map<Entry, Paired>()
  walkBranches(
    session,
    HashMap.empty<string, Paired>(),
    (calls, ancestor) =>
      ancestor.kind === 'request'
        ? ancestor.calls.reduceRight(
            (known, call) => HashMap.set(known, call.id, { request: ancestor, call }),
            calls
          )
        : calls,
    (calls, entry) => {
      const paired = entry.kind === 'result' ? HashMap.get(calls, entry.callId) : Option.none()
      if (Option.isSome(paired)) pairs.set(entry, paired.value)
    }
  )
  return pairs
}

const indexSession = (session: SessionRecord, role: Role): SessionIndex => {
  const pairs = pairResults(session)
  const resultOfCall = new Map<string, ResultEntry>()
  const callOfResult = new Map<string, Paired>()
  const outcomes = new Map<string, ResultOutcome>()
  const skills = new Map<string, string | undefined>()
  const efforts = new Map<string, string | undefined>()
  const workspaces = new Map<string, Workspace>()
  const pendingCompaction = new Map<string, boolean>()
  for (const entry of session.entries) {
    const parent = entry.parentId ?? ''
    skills.set(
      entry.id,
      entry.kind === 'user' && entry.skill !== undefined ? entry.skill : skills.get(parent)
    )
    efforts.set(entry.id, entry.kind === 'thinking-level' ? entry.level : efforts.get(parent))
    workspaces.set(entry.id, nextWorkspace(entry, workspaces.get(parent) ?? NO_WORKSPACE))
    pendingCompaction.set(
      entry.id,
      entry.kind === 'compaction' ||
        (entry.kind !== 'request' && pendingCompaction.get(parent) === true)
    )
    if (entry.kind !== 'result') continue
    outcomes.set(entry.id, classify(entry))
    const paired = pairs.get(entry)
    if (paired === undefined) continue
    const key = callKey(paired.request, paired.call.id)
    if (!resultOfCall.has(key)) resultOfCall.set(key, entry)
    callOfResult.set(entry.id, paired)
  }
  const ref = (entry: Entry) => `${session.ref}#${entry.id}`
  return {
    session,
    role,
    measured: session.entries.filter(entry => !entry.copied),
    ref,
    located: entry => ({ at: entry.at, session: session.ref, role, ref: ref(entry) }),
    resultOf: (request, call) => resultOfCall.get(callKey(request, call.id)),
    callOf: result => callOfResult.get(result.id),
    outcomeOf: result => outcomes.get(result.id) ?? 'unclassified',
    skillAt: entry => skills.get(entry.id),
    effortAt: entry => efforts.get(entry.id),
    workspaceAt: entry => workspaces.get(entry.id) ?? NO_WORKSPACE,
    afterCompaction: entry => pendingCompaction.get(entry.parentId ?? '') === true,
  }
}

const isInterrupted = (request: RequestEntry) =>
  request.stopReason === 'aborted' ||
  request.stopReason === 'error' ||
  request.stopReason === 'length'

const usageFacts = (index: SessionIndex): UsageFact[] => {
  let first = true
  return index.measured.flatMap((entry): UsageFact[] => {
    const base = { ...index.located(entry), skill: index.skillAt(entry) }
    switch (entry.kind) {
      case 'request': {
        const fact: UsageFact = {
          ...base,
          source: 'assistant',
          usage: entry.usage,
          model: entry.model,
          effort: entry.effort ?? index.effortAt(entry),
          first,
          latencyMs: entry.latencyMs,
          afterCompaction: index.afterCompaction(entry),
        }
        first = false
        return [fact]
      }
      case 'result':
        return entry.usage === undefined ? [] : [{ ...base, source: 'tool', usage: entry.usage }]
      case 'standalone':
        return [{ ...base, source: 'standalone', usage: entry.usage, model: entry.model }]
      case 'compaction':
        return [{ ...base, source: 'compaction', usage: entry.usage }]
      case 'branch-summary':
        return [{ ...base, source: 'branch-summary', usage: entry.usage }]
      default:
        return []
    }
  })
}

const callFacts = (index: SessionIndex): CallFact[] =>
  index.measured.flatMap(entry =>
    entry.kind === 'request'
      ? entry.calls.map((call): CallFact => {
          const result = index.resultOf(entry, call)
          if (result === undefined)
            return {
              ...index.located(entry),
              tool: call.name,
              outcome: 'unmatched',
              interrupted: isInterrupted(entry),
            }
          return {
            ...index.located(result),
            at: entry.at,
            tool: call.name,
            outcome: index.outcomeOf(result),
            bytes: textBytes(result.blocks),
          }
        })
      : []
  )

const resultFacts = (index: SessionIndex): ResultFact[] =>
  index.measured.flatMap(entry =>
    entry.kind === 'result'
      ? [{ ...index.located(entry), matched: index.callOf(entry) !== undefined }]
      : []
  )

interface EarlierRead {
  readonly ref: string
  readonly id: string
  readonly depth: number
  readonly coverage: TextCoverage
}

interface Segment extends Range {
  readonly read: EarlierRead
}

interface FileReads {
  readonly nearest: readonly Segment[]
  readonly ends: HashSet.HashSet<number>
  readonly unknown: boolean
}

interface IssuedGit {
  readonly owner: RequestEntry
  readonly call: ToolCall
  readonly request: GitRequest
}

interface Branch {
  readonly depth: number
  readonly compaction: number
  readonly edits: HashMap.HashMap<string, number>
  readonly writes: HashMap.HashMap<string, number>
  readonly reads: HashMap.HashMap<string, FileReads>
  readonly results: HashMap.HashMap<string, ResultEntry>
  readonly git: HashMap.HashMap<string, IssuedGit>
}

const TRUNK: Branch = {
  depth: 0,
  compaction: 0,
  edits: HashMap.empty(),
  writes: HashMap.empty(),
  reads: HashMap.empty(),
  results: HashMap.empty(),
  git: HashMap.empty(),
}

const NO_READS: FileReads = { nearest: [], ends: HashSet.empty(), unknown: false }

const happenedAfter = (
  depths: HashMap.HashMap<string, number>,
  key: string,
  depth: number
): boolean => Option.exists(HashMap.get(depths, key), latest => latest > depth)

const sequencesOf = (index: SessionIndex, branch: Branch, entry: RequestEntry): SequenceFact[] =>
  entry.calls
    .filter(
      (call, position) => entry.calls.findIndex(other => other.name === call.name) === position
    )
    .flatMap((call): SequenceFact[] => {
      const result = index.resultOf(entry, call)
      const earlier = Option.getOrUndefined(HashMap.get(branch.results, call.name))
      if (result === undefined || earlier === undefined) return []
      const outcome = index.outcomeOf(result)
      if (outcome === 'cancelled' || !isFailure(index.outcomeOf(earlier))) return []
      return [
        {
          ...index.located(result),
          tool: call.name,
          kind: outcome === 'returned' ? 'recovery' : 'repeated-error',
          earlier: index.ref(earlier),
        },
      ]
    })

const READ_TRUNCATED =
  /\n\n\[Showing lines (\d+)-(\d+) of \d+(?: \([^)]*\))?\. Use offset=\d+ to continue\.\]$/
const READ_REMAINING = /\n\n\[\d+ more lines in file\. Use offset=(\d+) to continue\.\]$/
const IMAGE_NOTE = 'Read image file ['
const DEV_ANNOTATION = '[dev workspace] '

type Coverage =
  | { readonly coverage: 'failed' | 'unknown' }
  | {
      readonly coverage: 'text'
      readonly returned: Range
      readonly lines: readonly string[]
      readonly stop: ReadStop
    }

type TextCoverage = Extract<Coverage, { coverage: 'text' }>

const UNKNOWN: Coverage = { coverage: 'unknown' }

const requestedRange = (
  range: Extract<ToolCall['input'], { kind: 'read' }>['range']
): RequestedRange | undefined => {
  if (range === 'undecodable') return undefined
  const { offset, limit } = range
  if (offset !== undefined && !Number.isInteger(offset)) return undefined
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) return undefined
  const start = offset === undefined || offset < 1 ? 1 : offset
  return { start, end: limit === undefined ? null : start + limit - 1 }
}

const known = (body: string, returned: Range, stop: ReadStop): Coverage => {
  const lines = returned.end < returned.start ? [] : body.split('\n')
  return lines.length === returned.end - returned.start + 1
    ? { coverage: 'text', returned, lines, stop }
    : UNKNOWN
}

const truncatedCoverage = (
  start: number,
  text: string,
  truncation: TruncationDetails
): Coverage => {
  if (truncation.firstLineExceedsLimit) return known('', { start, end: start - 1 }, 'first-line')
  const marker = READ_TRUNCATED.exec(text)
  const end = start + truncation.outputLines - 1
  if (
    !truncation.truncated ||
    marker === null ||
    Number(marker[1]) !== start ||
    Number(marker[2]) !== end
  )
    return UNKNOWN
  return known(text.slice(0, marker.index), { start, end }, truncation.truncatedBy ?? 'bytes')
}

const textCoverage = (
  start: number,
  text: string,
  truncation: ResultEntry['truncation']
): Coverage => {
  if (truncation === 'malformed') return UNKNOWN
  if (truncation !== undefined) return truncatedCoverage(start, text, truncation)
  if (READ_TRUNCATED.test(text) || text.startsWith(IMAGE_NOTE)) return UNKNOWN
  const remaining = READ_REMAINING.exec(text)
  if (remaining !== null)
    return known(text.slice(0, remaining.index), { start, end: Number(remaining[1]) - 1 }, 'limit')
  return known(text, { start, end: start + text.split('\n').length - 1 }, 'complete')
}

const readCoverage = (requested: RequestedRange | undefined, result: ResultEntry): Coverage => {
  if (result.isError) return { coverage: 'failed' }
  const [first, ...annotations] = result.blocks
  if (
    requested === undefined ||
    first?.type !== 'text' ||
    annotations.some(block => block.type !== 'text' || !block.text.startsWith(DEV_ANNOTATION))
  )
    return UNKNOWN
  return textCoverage(requested.start, first.text, result.truncation)
}

const isEmpty = (range: Range) => range.end < range.start

const overlapOf = (a: Range, b: Range): Range | undefined => {
  const start = Math.max(a.start, b.start)
  const end = Math.min(a.end, b.end)
  return start <= end ? { start, end } : undefined
}

const identityOf = (workspace: Workspace, path: string): FileIdentity => {
  const normalized = posix.normalize(path.startsWith('@') ? path.slice(1) : path)
  if (posix.isAbsolute(normalized) || normalized.startsWith('~/'))
    return { kind: 'absolute', path: normalized }
  if (workspace.handoffs === 0 && workspace.cwd !== null && posix.isAbsolute(workspace.cwd))
    return { kind: 'absolute', path: posix.resolve(workspace.cwd, normalized) }
  return { kind: 'relative', scope: workspaceScope(workspace), path: normalized }
}

const fileOf = (index: SessionIndex, entry: Entry, path: string): ReadFile => {
  const identity = identityOf(index.workspaceAt(entry), path)
  return {
    path,
    identity,
    key: identity.kind === 'absolute' ? identity.path : `${identity.scope}\u0000${identity.path}`,
  }
}

interface ReadInfo {
  readonly file: ReadFile | undefined
  readonly requested: RequestedRange | undefined
  readonly coverage: Coverage
}

const indexReads = (index: SessionIndex): ReadonlyMap<string, ReadInfo> =>
  new Map(
    index.session.entries.flatMap((entry): [string, ReadInfo][] => {
      const call = entry.kind === 'result' ? index.callOf(entry)?.call : undefined
      if (entry.kind !== 'result' || call?.name !== 'read') return []
      const { input } = call
      const requested = input.kind === 'read' ? requestedRange(input.range) : undefined
      return [
        [
          entry.id,
          {
            file: input.kind === 'read' ? fileOf(index, entry, input.path) : undefined,
            requested,
            coverage: readCoverage(requested, entry),
          },
        ],
      ]
    })
  )

const writtenKey = (index: SessionIndex, entry: ResultEntry): string | undefined => {
  const input = index.callOf(entry)?.call.input
  return input?.kind === 'file-write' && !entry.isError
    ? fileOf(index, entry, input.path).key
    : undefined
}

const withRead = (
  reads: FileReads,
  read: Omit<EarlierRead, 'coverage'>,
  coverage: Coverage
): FileReads => {
  if (coverage.coverage !== 'text')
    return coverage.coverage === 'unknown' ? { ...reads, unknown: true } : reads
  if (isEmpty(coverage.returned)) return reads
  const { start, end } = coverage.returned
  return {
    nearest: [
      ...reads.nearest.flatMap((segment): Segment[] => [
        ...(segment.start < start ? [{ ...segment, end: Math.min(segment.end, start - 1) }] : []),
        ...(segment.end > end ? [{ ...segment, start: Math.max(segment.start, end + 1) }] : []),
      ]),
      { start, end, read: { ...read, coverage } },
    ],
    ends: HashSet.add(reads.ends, end),
    unknown: reads.unknown,
  }
}

const relationOf = (own: TextCoverage, key: string, branch: Branch): ReadRelation => {
  if (isEmpty(own.returned)) return { kind: 'unknown' }
  const earlier = Option.getOrElse(HashMap.get(branch.reads, key), () => NO_READS)
  let nearest: EarlierRead | undefined
  let lines = 0
  let bytes = 0
  let identical = true
  for (const segment of earlier.nearest) {
    const shared = overlapOf(segment, own.returned)
    if (shared === undefined) continue
    const { read } = segment
    if (nearest === undefined || read.depth > nearest.depth) nearest = read
    for (let line = shared.start; line <= shared.end; line += 1) {
      const text = own.lines[line - own.returned.start] ?? ''
      lines += 1
      bytes += Buffer.byteLength(text, 'utf8')
      if (text !== (read.coverage.lines[line - read.coverage.returned.start] ?? ''))
        identical = false
    }
  }
  if (nearest !== undefined)
    return {
      kind: 'overlap',
      earlier: nearest.ref,
      afterCompaction: branch.compaction > nearest.depth,
      afterContextEdit: happenedAfter(branch.edits, nearest.id, nearest.depth),
      afterOwnWrite: happenedAfter(branch.writes, key, nearest.depth),
      lines,
      bytes: bytes + lines - 1,
      identical,
    }
  if (earlier.unknown) return { kind: 'unknown' }
  if (HashSet.has(earlier.ends, own.returned.start - 1)) return { kind: 'pagination' }
  return { kind: HashSet.isEmpty(earlier.ends) ? 'first' : 'disjoint' }
}

const readsOf = (
  index: SessionIndex,
  reads: ReadonlyMap<string, ReadInfo>,
  branch: Branch,
  entry: ResultEntry
): ReadFact[] => {
  const read = reads.get(entry.id)
  if (read === undefined) return []
  const base = { ...index.located(entry), bytes: textBytes(entry.blocks) }
  const { coverage, file, requested } = read
  if (coverage.coverage !== 'text' || file === undefined || requested === undefined)
    return [
      {
        ...base,
        coverage: coverage.coverage === 'failed' ? 'failed' : 'unknown',
        file,
        requested,
      },
    ]
  return [
    {
      ...base,
      coverage: 'text',
      file,
      requested,
      returned: coverage.returned,
      stop: coverage.stop,
      relation: relationOf(coverage, file.key, branch),
    },
  ]
}

const GIT_SEGMENT =
  /^git(?:\s+(?:-[Cc]\s+\S+|--(?:git-dir|work-tree|namespace|super-prefix|config-env)(?:=\S+|\s+\S+)|-[A-Za-z](?=\s)|--[a-z][a-z-]*(?:=\S+)?))*\s+([a-z][a-z0-9-]*)(?=\s|$)/
const BOUNDARY = /\|\||&&|;|\||\n|(?<![<>])&(?!>)|\$\(|[()`]/g
const LEADING_WORDS =
  /^(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S*|!|\{|if|then|else|elif|do|while|until|time|exec|command)\s+)*/
const CHANGE_DIRECTORY = /^cd(?:\s|$)/
const SHELL_CONTROL = /[|;&<>`$()\n]/
const HEREDOC = /^<<(-?)[ \t]*(?:'([^']*)'|"([^"]*)"|\\?([^\s;&|<>()'"]+))/
const COMMENT_START = /[\s;&|()]/
const GIT_TRUNCATED = /\n\n\[git output truncated at \d+ bytes\]$/

interface Heredoc {
  readonly delimiter: string
  readonly stripTabs: boolean
}

interface ShellState {
  quote: string | undefined
  escaped: boolean
  readonly pending: Heredoc[]
  body: Heredoc | undefined
}

const maskLine = (line: string, state: ShellState): string => {
  let masked = ''
  let position = 0
  while (position < line.length) {
    const character = line.charAt(position)
    const rest = line.slice(position)
    let width = 1
    if (state.escaped) {
      state.escaped = false
      masked += '_'
    } else if (state.quote !== undefined) {
      if (character === state.quote) {
        state.quote = undefined
        masked += character
      } else {
        if (character === '\\' && state.quote === '"') state.escaped = true
        masked += '_'
      }
    } else if (character === '\\') {
      state.escaped = true
      masked += '_'
    } else if (character === "'" || character === '"') {
      state.quote = character
      masked += character
    } else if (
      character === '#' &&
      (position === 0 || COMMENT_START.test(line.charAt(position - 1)))
    ) {
      return masked + '_'.repeat(line.length - position)
    } else if (rest.startsWith('<<<')) {
      masked += '<<<'
      width = 3
    } else {
      const heredoc = rest.startsWith('<<') ? HEREDOC.exec(rest) : null
      if (heredoc === null) masked += character
      else {
        state.pending.push({
          delimiter: heredoc[2] ?? heredoc[3] ?? heredoc[4] ?? '',
          stripTabs: heredoc[1] === '-',
        })
        masked += '_'.repeat(heredoc[0].length)
        width = heredoc[0].length
      }
    }
    position += width
  }
  return masked
}

const closesHeredoc = (line: string, heredoc: Heredoc) => {
  const content = line.endsWith('\r') ? line.slice(0, -1) : line
  return (heredoc.stripTabs ? content.replace(/^\t+/, '') : content) === heredoc.delimiter
}

const maskShell = (command: string): string => {
  const state: ShellState = { quote: undefined, escaped: false, pending: [], body: undefined }
  const lines = command.split('\n')
  return lines
    .map((line, position) => {
      const separator = position === lines.length - 1 ? '' : '\n'
      if (state.body !== undefined) {
        if (closesHeredoc(line, state.body)) state.body = state.pending.shift()
        return `${'_'.repeat(line.length)}${separator}`
      }
      const text = maskLine(line, state)
      const quoted = state.quote !== undefined
      const continued = state.escaped && !quoted
      state.escaped = false
      if (!quoted && !continued) state.body = state.pending.shift()
      if (continued) return `${text.slice(0, -1)} ${separator === '' ? '' : ' '}`
      return `${text}${quoted ? separator.replace('\n', '_') : separator}`
    })
    .join('')
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16)

const knownOperation = (token: string) =>
  GIT_COMMANDS.some(command => command === token) ? token : 'other'

type BoundaryKind = 'sequence' | 'open' | 'close'

interface Boundary {
  readonly index: number
  readonly length: number
  readonly kind: BoundaryKind
}

const boundariesOf = (masked: string): Boundary[] => {
  let inBackquote = false
  return [...masked.matchAll(BOUNDARY)].map(match => {
    const [text] = match
    let kind: BoundaryKind = 'sequence'
    if (text === '$(' || text === '(') kind = 'open'
    if (text === ')') kind = 'close'
    if (text === '`') {
      kind = inBackquote ? 'close' : 'open'
      inBackquote = !inBackquote
    }
    return { index: match.index, length: text.length, kind }
  })
}

const extentEnd = (bounds: readonly Boundary[], from: number, fallback: number): number => {
  let depth = 0
  for (const bound of bounds.slice(from)) {
    if (bound.kind === 'open') depth += 1
    else if (depth === 0) return bound.index
    else if (bound.kind === 'close') depth -= 1
  }
  return fallback
}

const shellGitRequests = (command: string, scope: string): GitRequest[] => {
  const masked = maskShell(command)
  const bounds = boundariesOf(masked)
  const directories = ['']
  const found: { readonly operation: string; readonly key: string }[] = []
  let segments = 0
  for (const [position, bound] of [...bounds, undefined].entries()) {
    const previous = bounds[position - 1]
    const start = previous === undefined ? 0 : previous.index + previous.length
    const raw = masked.slice(start, bound?.index ?? masked.length)
    const body = raw.trimStart()
    const from = start + raw.length - body.length + (LEADING_WORDS.exec(body)?.[0].length ?? 0)
    const segment = masked.slice(from, bound?.index ?? masked.length).trim()
    if (segment.replaceAll('_', '').trim() !== '') segments += 1
    const extent = command.slice(start, extentEnd(bounds, position, masked.length)).trimStart()
    if (CHANGE_DIRECTORY.test(segment)) directories[directories.length - 1] = extent
    const token = GIT_SEGMENT.exec(segment)?.[1]
    if (token !== undefined)
      found.push({
        operation: knownOperation(token),
        key: digest([scope, ...directories, extent].join('\u0000')),
      })
    if (bound?.kind === 'open') directories.push('')
    if (bound?.kind === 'close' && directories.length > 1) directories.pop()
  }
  const whole = found.length === 1 && segments === 1 && !SHELL_CONTROL.test(masked)
  return found.map(({ operation, key }) => ({ tool: 'bash', operation, key, whole }))
}

const gitRequests = (call: ToolCall, workspace: Workspace): GitRequest[] => {
  const scope = workspaceScope(workspace)
  const { input } = call
  if (input.kind === 'git-inspect')
    return [
      {
        tool: 'git_inspect',
        operation: GIT_INSPECT_OPERATIONS.some(operation => operation === input.operation)
          ? input.operation
          : 'invalid',
        whole: true,
        key: digest(
          JSON.stringify([
            scope,
            input.operation,
            input.path ?? null,
            input.ref ?? null,
            input.limit ?? null,
          ])
        ),
      },
    ]
  if (input.kind === 'shell') return shellGitRequests(input.command, scope)
  return []
}

const gitTruncated = (tool: GitRequest['tool'], result: ResultEntry | undefined): boolean => {
  if (result === undefined) return false
  if (tool === 'git_inspect') return GIT_TRUNCATED.test(firstText(result.blocks) ?? '')
  return result.truncation !== undefined && result.truncation !== 'malformed'
    ? result.truncation.truncated
    : false
}

const resultText = (result: ResultEntry | undefined): string | undefined =>
  result === undefined
    ? undefined
    : result.blocks.map(block => (block.type === 'text' ? block.text : '\u0000')).join('\n')

interface GitCall {
  readonly request: GitRequest
  readonly result: ResultEntry | undefined
}

const comparison = (later: GitCall, earlier: GitCall): NonNullable<GitFact['repeat']> => {
  const texts = [resultText(earlier.result), resultText(later.result)] as const
  if (
    !later.request.whole ||
    !earlier.request.whole ||
    texts[0] === undefined ||
    texts[1] === undefined ||
    gitTruncated(earlier.request.tool, earlier.result) ||
    gitTruncated(later.request.tool, later.result)
  )
    return 'unknown'
  return texts[0] === texts[1] ? 'identical' : 'changed'
}

const issuedGit = (index: SessionIndex) => {
  const cache = new Map<string, readonly GitRequest[]>()
  return (owner: RequestEntry): IssuedGit[] =>
    owner.calls.flatMap(call => {
      const key = callKey(owner, call.id)
      const requests = cache.get(key) ?? gitRequests(call, index.workspaceAt(owner))
      cache.set(key, requests)
      return requests.map(request => ({ owner, call, request }))
    })
}

const gitOf = (
  index: SessionIndex,
  branch: Branch,
  entry: RequestEntry,
  own: readonly IssuedGit[]
): GitFact[] => {
  let issued = branch.git
  return own.map((current): GitFact => {
    const { call, request } = current
    const result = index.resultOf(entry, call)
    const earlier = Option.getOrUndefined(HashMap.get(issued, request.key))
    issued = HashMap.set(issued, request.key, current)
    return {
      at: entry.at,
      session: index.session.ref,
      role: index.role,
      ref: index.ref(result ?? entry),
      tool: request.tool,
      operation: request.operation,
      whole: request.whole,
      key: request.key,
      truncated: gitTruncated(request.tool, result),
      repeat:
        earlier === undefined
          ? undefined
          : comparison(
              { request, result },
              { request: earlier.request, result: index.resultOf(earlier.owner, earlier.call) }
            ),
    }
  })
}

const branchFacts = (index: SessionIndex): Pick<Facts, 'sequences' | 'reads' | 'git'> => {
  const reads = indexReads(index)
  const issuedBy = issuedGit(index)
  for (const entry of index.measured) if (entry.kind === 'request') issuedBy(entry)
  const sequences = new Map<Entry, SequenceFact[]>()
  const read = new Map<Entry, ReadFact[]>()
  const git = new Map<Entry, GitFact[]>()
  walkBranches(
    index.session,
    TRUNK,
    (branch, ancestor): Branch => {
      const depth = branch.depth + 1
      switch (ancestor.kind) {
        case 'compaction':
          return { ...branch, depth, compaction: depth }
        case 'context-edit':
          return { ...branch, depth, edits: HashMap.set(branch.edits, ancestor.target, depth) }
        case 'request':
          return {
            ...branch,
            depth,
            git: issuedBy(ancestor).reduce(
              (issued, current) => HashMap.set(issued, current.request.key, current),
              branch.git
            ),
          }
        case 'result': {
          const written = writtenKey(index, ancestor)
          const info = reads.get(ancestor.id)
          const file = info?.file
          return {
            ...branch,
            depth,
            results: HashMap.set(branch.results, ancestor.tool, ancestor),
            writes:
              written === undefined ? branch.writes : HashMap.set(branch.writes, written, depth),
            reads:
              info === undefined || file === undefined
                ? branch.reads
                : HashMap.set(
                    branch.reads,
                    file.key,
                    withRead(
                      Option.getOrElse(HashMap.get(branch.reads, file.key), () => NO_READS),
                      { ref: index.ref(ancestor), id: ancestor.id, depth },
                      info.coverage
                    )
                  ),
          }
        }
        default:
          return { ...branch, depth }
      }
    },
    (branch, entry) => {
      if (entry.copied) return
      if (entry.kind === 'request') {
        sequences.set(entry, sequencesOf(index, branch, entry))
        git.set(entry, gitOf(index, branch, entry, issuedBy(entry)))
      }
      if (entry.kind === 'result') read.set(entry, readsOf(index, reads, branch, entry))
    }
  )
  const inOrder = <A>(found: ReadonlyMap<Entry, readonly A[]>): A[] =>
    index.measured.flatMap(entry => found.get(entry) ?? [])
  return { sequences: inOrder(sequences), reads: inOrder(read), git: inOrder(git) }
}

const compactionFacts = (index: SessionIndex): CompactionFact[] =>
  index.measured.flatMap(entry =>
    entry.kind === 'compaction'
      ? [{ ...index.located(entry), tokensBefore: entry.tokensBefore }]
      : []
  )

const timeFacts = (index: SessionIndex): TimeFact[] => {
  if (index.role !== 'lead') return []
  let previous: number | undefined
  return index.measured.flatMap((entry): TimeFact[] => {
    if (
      entry.kind === 'system' ||
      entry.kind === 'observation' ||
      entry.kind === 'observation-invalid'
    )
      return []
    const gap = previous === undefined ? 0 : entry.at - previous
    previous = entry.at
    const located = index.located(entry)
    if (entry.kind === 'request') return [{ ...located, category: 'model', ms: entry.latencyMs }]
    if (entry.kind === 'result') return [{ ...located, category: 'tool', ms: gap }]
    if (entry.kind === 'user') return [{ ...located, category: 'user', ms: gap }]
    return []
  })
}

const attemptFacts = (index: SessionIndex): AttemptFact[] =>
  index.role === 'lead'
    ? index.measured.flatMap(entry =>
        entry.kind === 'result' && entry.attempt !== undefined && entry.attempt.parent === undefined
          ? [{ ...index.located(entry), attempt: entry.attempt.id, kind: entry.attempt.kind }]
          : []
      )
    : []

const withRole =
  (role: Role) =>
  <A extends Located>(fact: A): A => ({ ...fact, role })

export const attributed = (facts: Facts, role: Role): Facts => ({
  usage: facts.usage.map(withRole(role)),
  calls: facts.calls.map(withRole(role)),
  results: facts.results.map(withRole(role)),
  sequences: facts.sequences.map(withRole(role)),
  reads: facts.reads.map(withRole(role)),
  git: facts.git.map(withRole(role)),
  compactions: facts.compactions.map(withRole(role)),
  time: facts.time.map(withRole(role)),
  attempts: facts.attempts.map(withRole(role)),
})

export const sessionFacts = (session: SessionRecord, role: Role): Facts => {
  const index = indexSession(session, role)
  return {
    usage: usageFacts(index),
    calls: callFacts(index),
    results: resultFacts(index),
    ...branchFacts(index),
    compactions: compactionFacts(index),
    time: timeFacts(index),
    attempts: attemptFacts(index),
  }
}
