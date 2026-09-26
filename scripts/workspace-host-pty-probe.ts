import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type * as Pi from '../node_modules/@earendil-works/pi-coding-agent/dist/index.js'
import type * as PiProjectTrust from '../node_modules/@earendil-works/pi-coding-agent/dist/core/project-trust.js'
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
  ProjectTrustContext,
  RegisteredCommand,
  ToolCallEvent,
  ToolCallEventResult,
  ToolInfo,
  UserBashEvent,
  UserBashEventResult,
} from '../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.js'
import type { AgentSessionRuntime } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session-runtime.js'
import type * as PiEventStream from '../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js'
import type {
  AssistantMessage,
  Model,
} from '../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js'
import { childWorkspaceExtension } from '../src/work-child-workspace.ts'
import { createWorkExtension, type WorkExtension } from '../src/work-extension.ts'
import {
  chooseResumeCandidate,
  parseWorkspaceCommand,
  runReadOnlyWorkspaceCommand,
  WorkspaceCommandError,
} from '../src/workspace-command.ts'
import {
  WorkspaceError,
  type WorkspaceAttachment,
  type WorkspaceAuthorization,
  type WorkspaceBinding,
  type WorkspaceConversation,
  type WorkspaceEffect,
  type WorkspaceExecutionFact,
  type WorkspaceGrant,
  type WorkspaceHandoff,
  type WorkspaceLifecycle,
  type WorkspaceOperation,
  type WorkspaceProcess,
  type WorkspaceView,
} from '../src/workspace-domain.ts'
import { createWorkspaceHost } from '../src/workspace-host.ts'
import {
  fixtureId as id,
  makeFixtureBinding,
  makeFixtureGrant,
  makeFixtureHandoff,
  makeFixtureView,
  type FixtureDescriptor,
} from './workspace-host-fixture-shapes.ts'

// Write-path validation compares a destination's realpath with the grant's checkout, so a
// symlinked temp root (macOS /var) would make every in-workspace write look like an escape.
const fixture = mkdtempSync(join(realpathSync(tmpdir()), 'dev36-host-pty-'))
process.stdout.write(`\nDEV36_FIXTURE ${fixture}\n`)
const project = (name: string): string => join(fixture, 'projects', name)
const lead = project('lead')
const targetA = project('writer-a')
const targetB = project('writer-b')
const targetC = project('writer-c')
const targetFail = project('writer-fail')
const delegatedPath = project('writer-delegated')
const sessionDir = join(fixture, 'sessions')
const agentDir = join(fixture, 'agent')
const dataHome = join(fixture, 'data')
const extensionMarker = join(fixture, 'untrusted-project-extension-ran')
const reportPath = join(fixture, 'report.json')

const mkdir = (path: string): void => {
  mkdirSync(path, { recursive: true })
}
for (const path of [sessionDir, agentDir, dataHome, join(fixture, 'home')]) mkdir(path)
process.env.HOME = join(fixture, 'home')
process.env.PI_CODING_AGENT_DIR = agentDir
process.env.PI_OFFLINE = '1'
process.env.PI_TELEMETRY_DISABLED = '1'
let networkAttempts = 0
globalThis.fetch = async () => {
  networkAttempts += 1
  throw new Error('Network is disabled by the dev36 host fixture')
}

const piRoot = new URL('../node_modules/@earendil-works/pi-coding-agent/', import.meta.url)
const pi: typeof Pi = await import(new URL('dist/index.js', piRoot).href)
const trustResolver: typeof PiProjectTrust = await import(
  new URL('dist/core/project-trust.js', piRoot).href
)
const eventStreams: typeof PiEventStream = await import(
  new URL('node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js', piRoot).href
)

const TASK_LEAD = id(1)
const TASK_A = id(2)
const TASK_B = id(3)
const TASK_C = id(4)
const TASK_FAIL = id(5)
const TASK_RESUME = id(6)
const TASK_DELEGATED = id(7)
const WS_LEAD = id(11)
const WS_A = id(12)
const WS_B = id(13)
const WS_C = id(14)
const WS_FAIL = id(15)
const WS_RESUME_A = id(16)
const WS_RESUME_C = id(17)
const WS_DELEGATED = id(18)
const NAMESPACE_ID = id(32)

const initProject = (path: string, label: string): void => {
  mkdir(join(path, '.pi', 'extensions'))
  writeFileSync(join(path, 'AGENTS.md'), `dev36-context: ${label}\n`)
  writeFileSync(
    join(path, '.pi', 'extensions', 'untrusted-marker.mjs'),
    `import { writeFileSync } from 'node:fs';\nexport default (pi) => pi.on('session_start', () => writeFileSync(${JSON.stringify(extensionMarker)}, ${JSON.stringify(label)}));\n`
  )
  const git = (...args: string[]) => execFileSync('git', ['-C', path, ...args])
  git('init', '--quiet')
  git('config', 'user.email', 'dev36-fixture@example.invalid')
  git('config', 'user.name', 'dev36 fixture')
  git('add', 'AGENTS.md', '.pi/extensions/untrusted-marker.mjs')
  git('commit', '--quiet', '-m', `fixture ${label}`)
}

const descriptor = (
  path: string,
  taskId: string,
  workspaceId: string,
  repo: number,
  label: string
): FixtureDescriptor => ({
  path,
  taskId,
  workspaceId,
  origin: path === lead ? 'pre-existing' : 'managed',
  repoId: id(repo),
  label,
})
const leadDescriptor = descriptor(lead, TASK_LEAD, WS_LEAD, 41, 'lead')
const aDescriptor = descriptor(targetA, TASK_A, WS_A, 42, 'writer-a')
const bDescriptor = descriptor(targetB, TASK_B, WS_B, 43, 'writer-b')
const cDescriptor = descriptor(targetC, TASK_C, WS_C, 44, 'writer-c')
const failDescriptor = descriptor(targetFail, TASK_FAIL, WS_FAIL, 45, 'writer-fail')
const delegatedDescriptor = descriptor(
  delegatedPath,
  TASK_DELEGATED,
  WS_DELEGATED,
  41,
  'writer-delegated'
)
const descriptors = [leadDescriptor, aDescriptor, bDescriptor, cDescriptor, failDescriptor]
for (const item of [...descriptors, delegatedDescriptor]) initProject(item.path, item.label)
const descriptorByPath = new Map(
  [...descriptors, delegatedDescriptor].map(item => [resolve(item.path), item])
)
const resumeDescriptors = [
  { ...aDescriptor, taskId: TASK_RESUME, workspaceId: WS_RESUME_A },
  { ...cDescriptor, taskId: TASK_RESUME, workspaceId: WS_RESUME_C },
]
const allDescriptors = [...descriptors, ...resumeDescriptors]
const displacements = new Map([
  [
    resolve(lead),
    { target: aDescriptor, reason: 'fixture competing writer required an isolated workspace' },
  ],
  [
    resolve(targetA),
    {
      target: bDescriptor,
      reason: 'fixture repeated contention required another isolated workspace',
    },
  ],
])

type UseScope = 'ordinary' | 'delegated' | WorkspaceEffect
type UseStage =
  | 'authorized'
  | 'launch-intent'
  | 'spawned'
  | 'started'
  | 'observed'
  | 'operation-started'
  | 'quiescent'
  | 'unknown'
interface FixtureUse {
  readonly grant: WorkspaceGrant
  readonly operation: WorkspaceOperation
  readonly scope: UseScope
  readonly facts: WorkspaceExecutionFact[]
  stage: UseStage
  processes: readonly WorkspaceProcess[]
}
type TimelineEntry =
  | { readonly kind: 'authorized'; readonly useId: string }
  | {
      readonly kind: 'fact'
      readonly useId: string
      readonly fact: WorkspaceExecutionFact
      readonly pathExists?: boolean
    }
  | { readonly kind: 'select'; readonly workspaceId: string }
  | { readonly kind: 'handoff-started'; readonly operationId: string; readonly target: string }
  | {
      readonly kind: 'handoff-settled'
      readonly operationId: string
      readonly outcome: 'confirmed' | 'cancelled' | 'refused' | 'unknown'
      readonly error?: string
    }
  | { readonly kind: 'confirm'; readonly title: string; readonly message: string }
  | { readonly kind: 'notify'; readonly message: string; readonly level: string }
  | { readonly kind: 'attachment-closed'; readonly workspaceId: string }

const WRITER_WARNING =
  'A writer owns this live checkout; files may change while you read. No stable snapshot is provided.'
const uses = new Map<string, FixtureUse>()
const timeline: TimelineEntry[] = []
const rejectedFacts: { readonly useId: string; readonly kind: string; readonly reason: string }[] =
  []
const attachCalls: { readonly path: string; readonly sessionId: string }[] = []
const handoffs: WorkspaceHandoff[] = []
const inspections: { readonly cwd?: string; readonly taskId?: string }[] = []
const attachFailures = new Set<string>()
const failedConversationIds = new Set<string>()
const refusedHandoffTargets = new Set<string>()
const pendingByConversation = new Map<string, FixtureDescriptor>()
const conversationKey = (conversation: WorkspaceConversation): string =>
  `${resolve(conversation.sessionFile)}::${conversation.sessionId}`
let grantSequence = 1000
let operationSequence = 900000

const refuse = (outcome: WorkspaceError['outcome'], message: string): never => {
  throw new WorkspaceError({ outcome, message })
}

const makeView = (item: FixtureDescriptor, outcome: WorkspaceView['outcome']): WorkspaceView =>
  makeFixtureView({
    descriptor: item,
    outcome,
    reservationId: id(Number(item.workspaceId.slice(-3)) + 100),
  })

const issue = (
  owned: Set<string>,
  grant: WorkspaceGrant,
  operation: WorkspaceOperation,
  scope: UseScope
): WorkspaceGrant => {
  uses.set(grant.useId, { grant, operation, scope, facts: [], stage: 'authorized', processes: [] })
  owned.add(grant.useId)
  timeline.push({ kind: 'authorized', useId: grant.useId })
  return grant
}

const grantFor = (
  item: FixtureDescriptor,
  access: WorkspaceGrant['access'],
  cwd: string,
  path?: string
): WorkspaceGrant =>
  makeFixtureGrant({
    namespaceId: NAMESPACE_ID,
    descriptor: item,
    access,
    cwd,
    sequence: (grantSequence += 10),
    ...(path === undefined ? {} : { path }),
  })

const handoffTo = (
  from: WorkspaceBinding,
  target: FixtureDescriptor,
  reason: string
): WorkspaceHandoff =>
  makeFixtureHandoff({
    operationId: id((operationSequence += 1)),
    from,
    target: grantFor(target, 'write', target.path),
    reason,
  })

// The stub mirrors the real authority's contracts (scoped admission, the execution stage
// machine, and the live-execution refusals), so a host that drifts from them fails here
// the way it would against the real engine.
const authorizeScoped = (
  owned: Set<string>,
  effect: WorkspaceEffect,
  binding: WorkspaceBinding,
  operation: WorkspaceOperation
): WorkspaceAuthorization => {
  const { within } = operation
  if (within === undefined) return refuse('invalid', 'A scoped operation requires a within grant')
  const parent = uses.get(within.useId)
  if (parent === undefined || parent.scope !== 'ordinary')
    return refuse('invalid', 'within must be an ordinary grant this fixture issued')
  if (within.workspaceId !== binding.workspaceId)
    return refuse('review-required', 'within grant belongs to another workspace binding')
  if (operation.access === 'write' && within.access !== 'write')
    return refuse('blocked', 'A read-only workspace grant cannot authorize a scoped mutation')
  if (operation.access !== 'write') return refuse('invalid', `${effect} requires write access`)
  if ((effect === 'native-file-write') !== (operation.path !== undefined))
    return refuse('invalid', 'Only native file writes carry, and they require, a path')
  if ((effect === 'opaque') !== (operation.execution !== undefined))
    return refuse('invalid', 'Only opaque operations carry, and they require, an execution')
  const checkout = descriptorByPath.get(resolve(within.checkout))
  if (checkout === undefined) return refuse('invalid', 'within grant names an unknown checkout')
  const cwd = resolve(operation.cwd ?? within.cwd)
  const grant = grantFor(
    checkout,
    operation.access,
    cwd,
    operation.path === undefined ? undefined : resolve(cwd, operation.path)
  )
  return {
    kind: 'ready',
    grant: issue(
      owned,
      { ...grant, acquisitionId: within.acquisitionId, reservationId: within.reservationId },
      operation,
      effect
    ),
  }
}

const nextStage = (use: FixtureUse, fact: WorkspaceExecutionFact): UseStage => {
  const { stage } = use
  if (use.operation.execution === undefined) {
    if (use.operation.effect === undefined)
      return refuse('invalid', 'Legacy workspace grants do not carry scoped operation authority')
    switch (fact.kind) {
      case 'operation-started':
        return stage === 'authorized'
          ? 'operation-started'
          : refuse('review-required', `Cannot start scoped operation after ${stage}`)
      case 'operation-completed':
        return stage === 'authorized' || stage === 'operation-started'
          ? 'quiescent'
          : refuse('review-required', `Cannot complete scoped operation after ${stage}`)
      case 'unknown':
        return stage === 'authorized' || stage === 'operation-started'
          ? 'unknown'
          : refuse('review-required', `Cannot mark scoped operation unknown after ${stage}`)
      default:
        return refuse('invalid', 'Scoped native operations require operation boundary facts')
    }
  }
  if (stage === 'quiescent') return refuse('review-required', 'Execution has already been settled')
  switch (fact.kind) {
    case 'launch-intent':
      if (!isDeepStrictEqual(fact.execution, use.operation.execution))
        return refuse('invalid', 'Launch intent does not match the authorized execution')
      return stage === 'authorized'
        ? 'launch-intent'
        : refuse('review-required', `Cannot record launch intent after ${stage}`)
    case 'spawned':
      return stage === 'launch-intent'
        ? 'spawned'
        : refuse('review-required', `Cannot record process identity after ${stage}`)
    case 'started':
      return stage === 'spawned'
        ? 'started'
        : refuse('review-required', `Cannot release user code after ${stage}`)
    case 'observed':
      return ['spawned', 'started', 'observed'].includes(stage)
        ? 'observed'
        : refuse('review-required', `Cannot record a process observation after ${stage}`)
    case 'unknown':
      return 'unknown'
    case 'launch-failed':
      return stage === 'authorized' || stage === 'launch-intent'
        ? 'quiescent'
        : refuse('review-required', `A launch cannot be reported failed after ${stage}`)
    case 'quiescent':
      return stage === 'observed' && use.processes.length === 0
        ? 'quiescent'
        : refuse(
            'review-required',
            `Quiescence after ${stage} requires an observed empty process family first`
          )
    case 'operation-started':
    case 'operation-completed':
      return refuse('invalid', 'Operation boundary facts are only valid for non-process uses')
  }
}

const makeAttachment = (
  conversation: WorkspaceConversation,
  attached: FixtureDescriptor
): WorkspaceAttachment => {
  let binding = makeFixtureBinding({ conversation, descriptor: attached })
  let pending: WorkspaceHandoff | undefined
  const owned = new Set<string>()
  const liveExecution = (): string | undefined => {
    for (const useId of owned) {
      const use = uses.get(useId)
      if (
        use?.operation.execution !== undefined &&
        use.grant.workspaceId === binding.workspaceId &&
        use.stage !== 'quiescent' &&
        use.stage !== 'unknown'
      )
        return `This conversation still runs ${use.operation.execution.taskKey} (${use.stage}) in its workspace`
    }
    return undefined
  }
  return {
    get binding() {
      return binding
    },
    async authorize(operation) {
      const scope: UseScope =
        operation.effect ?? (operation.delegated === true ? 'delegated' : 'ordinary')
      switch (scope) {
        case 'ordinary': {
          const cwd = resolve(operation.cwd ?? attached.path)
          const displaced = operation.access === 'write' ? displacements.get(cwd) : undefined
          if (displaced !== undefined) {
            const live = liveExecution()
            if (live !== undefined) return refuse('blocked', `${live}, so it cannot be rebound yet`)
            pending = handoffTo(binding, displaced.target, displaced.reason)
            return { kind: 'rebind', handoff: pending }
          }
          const grant = issue(owned, grantFor(attached, operation.access, cwd), operation, scope)
          return operation.access === 'read' && cwd === resolve(targetB)
            ? { kind: 'ready', grant, warning: WRITER_WARNING }
            : { kind: 'ready', grant }
        }
        case 'delegated':
          return {
            kind: 'ready',
            grant: issue(
              owned,
              grantFor(delegatedDescriptor, 'write', delegatedDescriptor.path),
              operation,
              scope
            ),
          }
        case 'native-file-write':
        case 'opaque':
          return authorizeScoped(owned, scope, binding, operation)
      }
    },
    async select(selection) {
      if (pending !== undefined)
        return refuse('blocked', 'A workspace transition is already pending')
      const live = liveExecution()
      if (live !== undefined) return refuse('blocked', `${live}, so it cannot be switched yet`)
      const candidate = allDescriptors.find(
        item => item.taskId === selection.taskId && item.workspaceId === selection.workspaceId
      )
      if (candidate === undefined) return refuse('invalid', 'fixture selection must be exact')
      timeline.push({ kind: 'select', workspaceId: candidate.workspaceId })
      pending = handoffTo(binding, candidate, 'fixture explicit retained-workspace selection')
      return pending
    },
    async reportExecution(grant, fact) {
      const use = uses.get(grant.useId)
      try {
        if (use === undefined) return refuse('invalid', `${fact.kind} for an unissued use`)
        if (
          pending !== undefined &&
          ['launch-intent', 'spawned', 'started', 'operation-started'].includes(fact.kind)
        )
          return refuse('blocked', 'Starting an operation is fenced during a host transition')
        use.stage = nextStage(use, fact)
      } catch (error) {
        rejectedFacts.push({ useId: grant.useId, kind: fact.kind, reason: String(error) })
        throw error
      }
      if (fact.kind === 'spawned') use.processes = [fact.process]
      if (fact.kind === 'observed') use.processes = fact.processes
      use.facts.push(fact)
      timeline.push({
        kind: 'fact',
        useId: grant.useId,
        fact,
        ...(grant.path === undefined ? {} : { pathExists: existsSync(grant.path) }),
      })
    },
    async handoff(transition, replace) {
      if (pending?.operationId !== transition.operationId)
        return refuse('review-required', 'Workspace handoff token is stale')
      assert.equal(transition.from.conversation.sessionId, conversation.sessionId)
      assert.equal(
        resolve(transition.from.conversation.sessionFile),
        resolve(conversation.sessionFile)
      )
      handoffs.push(transition)
      const target = allDescriptors.find(item => item.workspaceId === transition.target.workspaceId)
      if (target === undefined)
        return refuse('invalid', 'fixture handoff names an unknown workspace')
      const refusal = refusedHandoffTargets.has(target.workspaceId)
        ? 'fixture target became unavailable'
        : liveExecution()
      if (refusal !== undefined) {
        pending = undefined
        timeline.push({
          kind: 'handoff-settled',
          operationId: transition.operationId,
          outcome: 'refused',
          error: refusal,
        })
        return refuse(
          'blocked',
          `Workspace transition refused before the host acted; the current binding is kept: ${refusal}`
        )
      }
      pendingByConversation.set(conversationKey(conversation), target)
      timeline.push({
        kind: 'handoff-started',
        operationId: transition.operationId,
        target: target.path,
      })
      try {
        const outcome = await replace(transition.target)
        if (outcome === 'confirmed')
          binding = {
            ...binding,
            taskId: transition.target.taskId,
            workspaceId: transition.target.workspaceId,
            cwd: transition.target.cwd,
            revision: binding.revision + 1,
          }
        pending = undefined
        timeline.push({ kind: 'handoff-settled', operationId: transition.operationId, outcome })
        pendingByConversation.delete(conversationKey(conversation))
      } catch (error) {
        timeline.push({
          kind: 'handoff-settled',
          operationId: transition.operationId,
          outcome: 'unknown',
          error: String(error),
        })
        throw error
      }
    },
    async close() {
      timeline.push({ kind: 'attachment-closed', workspaceId: attached.workspaceId })
    },
  }
}

const lifecycle: WorkspaceLifecycle = {
  async attach(input) {
    const path = resolve(input.cwd)
    const { sessionId } = input.conversation
    attachCalls.push({ path, sessionId })
    if (failedConversationIds.has(sessionId)) throw new Error('fixture preflight attach failure')
    if (attachFailures.has(path)) throw new Error(`fixture runtime attach failure at ${path}`)
    const pending = pendingByConversation.get(conversationKey(input.conversation))
    const { selection } = input
    const selected =
      selection &&
      allDescriptors.find(
        item =>
          item.taskId === selection.taskId &&
          item.workspaceId === selection.workspaceId &&
          resolve(item.path) === path
      )
    const attached =
      pending !== undefined && resolve(pending.path) === path
        ? pending
        : (selected ?? (selection === undefined ? descriptorByPath.get(path) : undefined))
    if (attached === undefined) throw new Error(`fixture has no workspace descriptor for ${path}`)
    return makeAttachment(input.conversation, attached)
  },
  async inspect(input) {
    inspections.push(input)
    let rows = [
      ...descriptors.map(item =>
        makeView(item, item.path === targetB ? 'active' : 'preserved-for-resume')
      ),
      ...resumeDescriptors.map(item => makeView(item, 'preserved-for-resume')),
    ]
    if (input.taskId !== undefined) rows = rows.filter(row => row.taskId === input.taskId)
    if (input.cwd !== undefined) {
      const current = descriptorByPath.get(resolve(input.cwd))
      rows = rows.filter(row => row.repositoryId === current?.repoId)
    }
    return rows
  },
  async validate(grant) {
    const known = descriptorByPath.get(resolve(grant.checkout))
    if (known?.workspaceId !== grant.workspaceId) throw new Error('fixture grant identity mismatch')
  },
  async close() {},
}

assert.deepEqual(parseWorkspaceCommand([]), { kind: 'list' })
assert.deepEqual(parseWorkspaceCommand(['list']), { kind: 'list' })
assert.deepEqual(parseWorkspaceCommand(['inspect', TASK_LEAD]), {
  kind: 'inspect',
  taskId: TASK_LEAD,
})
assert.deepEqual(parseWorkspaceCommand(['resume', TASK_RESUME]), {
  kind: 'resume',
  taskId: TASK_RESUME,
})
assert.deepEqual(parseWorkspaceCommand(['resume', TASK_RESUME, '--workspace', WS_RESUME_A]), {
  kind: 'resume',
  taskId: TASK_RESUME,
  workspaceId: WS_RESUME_A,
})
assert.throws(
  () => parseWorkspaceCommand(['inspect', `${TASK_LEAD.slice(0, 8)}*`]),
  (error: unknown) => error instanceof WorkspaceCommandError && error.exitCode === 2,
  'a task prefix or pattern is a usage error, never a lookup'
)
assert.throws(
  () => parseWorkspaceCommand(['resume', TASK_RESUME, '--workspace']),
  WorkspaceCommandError
)
const resumeViews = resumeDescriptors.map(item => makeView(item, 'preserved-for-resume'))
assert.throws(() => chooseResumeCandidate(resumeViews, TASK_RESUME), /multiple retained workspaces/)
assert.equal(
  chooseResumeCandidate(resumeViews, TASK_RESUME, WS_RESUME_C).view.workspaceId,
  WS_RESUME_C
)
const listResult = await runReadOnlyWorkspaceCommand(lifecycle, { kind: 'list' }, { cwd: lead })
const inspectResult = await runReadOnlyWorkspaceCommand(lifecycle, {
  kind: 'inspect',
  taskId: TASK_LEAD,
})
assert.equal(listResult.exitCode, 0)
assert.match(listResult.stdout ?? '', /workspace/)
assert.equal(inspectResult.exitCode, 0)
assert.match(inspectResult.stdout ?? '', new RegExp(TASK_LEAD))
assert.equal(attachCalls.length, 0, 'read-only commands do not bind or attach a task')

const offlineModel: Model<'openai-completions'> = {
  id: 'dev36-offline-tui',
  name: 'Offline dev36 host fixture',
  api: 'openai-completions',
  provider: 'dev36-offline',
  baseUrl: 'http://127.0.0.1:9/v1',
  reasoning: false,
  input: ['text'],
  contextWindow: 200000,
  maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}
const assistantMessage = (
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason']
): AssistantMessage => ({
  role: 'assistant',
  content,
  api: offlineModel.api,
  provider: offlineModel.provider,
  model: offlineModel.id,
  stopReason,
  timestamp: Date.now(),
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
})

const toolCall = (
  callId: string,
  name: string,
  args: Extract<AssistantMessage['content'][number], { type: 'toolCall' }>['arguments']
): AssistantMessage['content'][number] => ({ type: 'toolCall', id: callId, name, arguments: args })
const finalText = [{ type: 'text' as const, text: 'Offline host integration fixture completed.' }]
const readAgents = (callId: string) => toolCall(callId, 'read', { path: 'AGENTS.md' })
const workProcess = (callId: string, taskId: string) =>
  toolCall(callId, 'work', {
    action: 'process',
    taskId,
    command: `node -e "process.stdout.write('dev36-work-owner-started');setInterval(()=>{},1000)"`,
    cwd: targetB,
  })

interface ScriptStep {
  readonly id: string
  readonly content: AssistantMessage['content']
  readonly stopReason: 'toolUse' | 'stop' | 'aborted'
  readonly delayMs: number
}
const script: readonly ScriptStep[] = [
  {
    id: 'stale-lead',
    content: [
      toolCall('stale-native-lead', 'write', {
        path: 'stale-native.txt',
        content: 'must not be written',
      }),
      toolCall('stale-custom-lead', 'fixture_custom_write', {
        path: 'stale-custom.txt',
        content: 'must not be written',
      }),
      toolCall('stale-shadow-read-lead', 'read', {
        path: 'shadow-read.txt',
        content: 'must not be written',
      }),
    ],
    stopReason: 'toolUse',
    delayMs: 450,
  },
  {
    id: 'stale-a',
    content: [
      toolCall('stale-shadow-read-a', 'read', {
        path: 'shadow-read-a.txt',
        content: 'must not be written',
      }),
      toolCall('stale-native-a', 'write', {
        path: 'stale-native-a.txt',
        content: 'must not be written',
      }),
    ],
    stopReason: 'toolUse',
    delayMs: 40,
  },
  {
    id: 'fresh-write-b',
    content: [
      toolCall('fresh-native-b', 'write', {
        path: 'fresh-native.txt',
        content: 'fresh decision at writer-b',
      }),
      readAgents('warned-read-b'),
    ],
    stopReason: 'toolUse',
    delayMs: 40,
  },
  {
    id: 'mixed-b',
    content: [
      toolCall('rejected-native-b', 'write', {
        path: '../escape-b.txt',
        content: 'must not be written',
      }),
      toolCall('edit-native-b', 'edit', {
        path: 'fresh-native.txt',
        edits: [{ oldText: 'fresh decision', newText: 'edited decision' }],
      }),
      toolCall('unverified-custom-b', 'fixture_custom_write', {
        path: 'custom-b.txt',
        content: 'must not be written',
      }),
      toolCall('lead-bash-b', 'bash', {
        command: 'echo dev36-lead-bash | tee lead-bash.txt; sleep 600 &',
      }),
      readAgents('warned-read-b-again'),
    ],
    stopReason: 'toolUse',
    delayMs: 40,
  },
  {
    id: 'empty-edit-b',
    content: [toolCall('empty-edit-b', 'edit', { path: 'fresh-native.txt', edits: [] })],
    stopReason: 'toolUse',
    delayMs: 40,
  },
  { id: 'main-done', content: finalText, stopReason: 'stop', delayMs: 40 },
  {
    id: 'work-process',
    content: [workProcess('work-owner-process', 'abort-process')],
    stopReason: 'toolUse',
    delayMs: 40,
  },
  { id: 'background-done', content: finalText, stopReason: 'stop', delayMs: 40 },
  { id: 'agent-abort', content: finalText, stopReason: 'aborted', delayMs: 50 },
  {
    id: 'work-escape',
    content: [workProcess('work-owner-escape', 'escape-process')],
    stopReason: 'toolUse',
    delayMs: 40,
  },
  { id: 'escape-stream', content: finalText, stopReason: 'stop', delayMs: 15000 },
  {
    id: 'work-retained',
    content: [workProcess('work-owner-retained', 'retained-process')],
    stopReason: 'toolUse',
    delayMs: 40,
  },
  { id: 'retained-done', content: finalText, stopReason: 'stop', delayMs: 40 },
  { id: 'resumed-a', content: finalText, stopReason: 'stop', delayMs: 40 },
]
const staleContinuation: ScriptStep = {
  id: 'parked-continuation',
  content: [
    toolCall('parked-native', 'write', {
      path: 'parked-continuation.txt',
      content: 'must not be written',
    }),
    toolCall('parked-bash', 'bash', { command: 'touch parked-continuation-bash.txt' }),
  ],
  stopReason: 'toolUse',
  delayMs: 40,
}
const extraStep: ScriptStep = { id: 'extra', content: finalText, stopReason: 'stop', delayMs: 40 }

interface ProviderCall {
  readonly step: string
  readonly cwd: string | undefined
  readonly parked: boolean
  readonly context: string
}
const providerCalls: ProviderCall[] = []
let scriptIndex = 0
let lastStep = ''
let runtime: AgentSessionRuntime | undefined

const scriptedStream: NonNullable<Pi.ProviderConfig['streamSimple']> = (
  _model,
  context,
  options
) => {
  const parked = workspaceHost.isParked()
  const step = parked ? staleContinuation : (script[scriptIndex++] ?? extraStep)
  lastStep = step.id
  providerCalls.push({ step: step.id, cwd: runtime?.cwd, parked, context: JSON.stringify(context) })
  const stream = eventStreams.createAssistantMessageEventStream()
  const message = assistantMessage(step.content, step.stopReason)
  if (step.id === 'escape-stream') process.stdout.write('\nDEV36_CANCEL_PROVIDER_STARTED\n')
  const timer = setTimeout(() => {
    stream.push(
      step.stopReason === 'aborted'
        ? { type: 'error', reason: 'aborted', error: message }
        : { type: 'done', reason: step.stopReason, message }
    )
    stream.end()
  }, step.delayMs)
  options?.signal?.addEventListener(
    'abort',
    () => {
      clearTimeout(timer)
      stream.push({ type: 'error', reason: 'aborted', error: assistantMessage([], 'aborted') })
      stream.end()
    },
    { once: true }
  )
  return stream
}

const modelRuntime = await pi.ModelRuntime.create({
  authPath: join(fixture, 'never-created-auth.json'),
  modelsPath: join(fixture, 'never-created-models.json'),
  allowModelNetwork: false,
  refreshOnCreate: false,
})
modelRuntime.registerProvider(offlineModel.provider, {
  name: offlineModel.name,
  api: offlineModel.api,
  baseUrl: offlineModel.baseUrl,
  apiKey: 'offline-fixture',
  authHeader: false,
  models: [
    {
      id: offlineModel.id,
      name: offlineModel.name,
      api: offlineModel.api,
      baseUrl: offlineModel.baseUrl,
      reasoning: false,
      input: ['text'],
      contextWindow: offlineModel.contextWindow,
      maxTokens: offlineModel.maxTokens,
      cost: offlineModel.cost,
    },
  ],
  streamSimple: scriptedStream,
})

interface Deferred {
  readonly promise: Promise<void>
  readonly settle: () => void
}
const deferred = (): Deferred => {
  let settle!: () => void
  const promise = new Promise<void>(resolvePromise => {
    settle = resolvePromise
  })
  return { promise, settle }
}
const runStarted = deferred()
const selectorOpen = deferred()
const confirmOpen = deferred()
const mainTurnDone = deferred()
const backgroundTurnDone = deferred()
const abortedWithoutEscape = deferred()
const workToolReturned = deferred()
const retainedTurnDone = deferred()
const terminalEscape = deferred()
const commandDone = new Map<string, Deferred>()
const waitForCommand = (key: string): Promise<void> => {
  const existing = commandDone.get(key) ?? deferred()
  commandDone.set(key, existing)
  return existing.promise
}

interface HostBlock {
  readonly name: string
  readonly toolCallId: string
  readonly cwd: string
  readonly terminate: boolean
  readonly reason: string
}
interface WorkResult {
  readonly id: string
  readonly status: string
}
const hostBlocks: HostBlock[] = []
const hostMessages: string[] = []
const userBashDecisions: {
  readonly event: UserBashEvent
  readonly executed: boolean
  readonly blocked?: string
}[] = []
const workspaceCommands: string[] = []
const workspaceCommandCount = new Map<string, number>()
const projectTrustContexts: { cwd: string; mode: string; hasUI: boolean }[] = []
const runtimeSnapshots: {
  readonly cwd: string
  readonly sessionId: string
  readonly sessionFile: string | undefined
  readonly shutdownEntries: number
}[] = []
const pendingEditorSnapshots: { readonly cwd: string; readonly editor: string }[] = []
const toolRegistryByPath = new Map<string, ToolInfo[]>()
const preparedWorkExtensions: { readonly cwd: string; readonly work: WorkExtension }[] = []
const processResults = new Map<string, WorkResult>()
const terminalInputs: string[] = []
let confirmCount = 0
let mainTurnWasDone = false

const textOf = (content: readonly { readonly type: string; readonly text?: string }[]): string =>
  content.map(item => (item.type === 'text' ? (item.text ?? '') : '')).join('\n')

const wrapToolCall =
  (
    handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>
  ): ExtensionHandler<ToolCallEvent, ToolCallEventResult> =>
  async (event, context) => {
    const result = (await handler(event, observeUi(context))) as ToolCallEventResult | undefined
    if (result?.block === true)
      hostBlocks.push({
        name: event.toolName,
        toolCallId: event.toolCallId,
        cwd: context.cwd,
        terminate: result.terminate === true,
        reason: result.reason ?? '',
      })
    return result
  }

const wrapUserBash =
  (
    handler: ExtensionHandler<UserBashEvent, UserBashEventResult>
  ): ExtensionHandler<UserBashEvent, UserBashEventResult> =>
  async (event, context) => {
    const result = (await handler(event, context)) as UserBashEventResult | undefined
    userBashDecisions.push({
      event,
      executed: result?.operations !== undefined && result.result === undefined,
      ...(result?.result === undefined ? {} : { blocked: result.result.output }),
    })
    return result
  }

const observeUi = <C extends ExtensionContext>(context: C): C => {
  const ui = new Proxy(context.ui, {
    get(target, key) {
      if (key === 'notify')
        return (...args: Parameters<typeof target.notify>) => {
          timeline.push({ kind: 'notify', message: args[0], level: args[1] ?? 'info' })
          target.notify(...args)
        }
      if (key === 'select')
        return async (...args: Parameters<typeof target.select>) => {
          process.stdout.write('\nDEV36_SELECTOR_OPEN\n')
          selectorOpen.settle()
          return target.select(...args)
        }
      if (key === 'confirm')
        return async (...args: Parameters<typeof target.confirm>) => {
          timeline.push({ kind: 'confirm', title: args[0], message: args[1] })
          process.stdout.write(`\nDEV36_CONFIRM_SWITCH_OPEN_${++confirmCount}\n`)
          confirmOpen.settle()
          return target.confirm(...args)
        }
      const value: unknown = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return new Proxy(context, {
    get(target, key) {
      if (key === 'ui') return ui
      const value: unknown = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

const wrapWorkspaceCommand = (
  command: Omit<RegisteredCommand, 'name' | 'sourceInfo'>
): Omit<RegisteredCommand, 'name' | 'sourceInfo'> => ({
  ...command,
  handler: async (args, context) => {
    await command.handler(args, observeUi(context))
    const commandLine = args.trim()
    workspaceCommands.push(commandLine)
    const action = commandLine.split(/\s+/)[0] || 'list'
    const count = (workspaceCommandCount.get(action) ?? 0) + 1
    workspaceCommandCount.set(action, count)
    process.stdout.write(`\nDEV36_COMMAND_DONE:${action}:${count}\n`)
    const key = `${action}:${count}`
    const waiter = commandDone.get(key) ?? deferred()
    commandDone.set(key, waiter)
    waiter.settle()
  },
})

// A blocked tool call is the host's return value, not an event, so it is only observable by
// wrapping the host's own registrations.
const instrumentHost =
  (factory: (api: ExtensionAPI) => void) =>
  (rawApi: ExtensionAPI): void =>
    factory(
      new Proxy(rawApi, {
        get(target, property) {
          if (property === 'sendMessage')
            return (...args: Parameters<ExtensionAPI['sendMessage']>) => {
              const [message] = args
              if (message.customType === 'dev/workspace' && typeof message.content === 'string')
                hostMessages.push(message.content)
              return target.sendMessage(...args)
            }
          if (property === 'on')
            return (event: string, handler: never) => {
              if (event === 'tool_call') return target.on(event, wrapToolCall(handler))
              if (event === 'user_bash') return target.on(event, wrapUserBash(handler))
              return Reflect.apply(target.on, target, [event, handler])
            }
          if (property === 'registerCommand')
            return (name: string, command: Omit<RegisteredCommand, 'name' | 'sourceInfo'>) =>
              target.registerCommand(
                name,
                name === 'workspace' ? wrapWorkspaceCommand(command) : command
              )
          const value: unknown = Reflect.get(target, property)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    )

const untrustedContext = (cwd: string): ProjectTrustContext => ({
  cwd,
  mode: 'tui',
  hasUI: false,
  ui: {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    notify: () => undefined,
  },
})

const initialManager = pi.SessionManager.create(lead, sessionDir)
const initialSessionId = initialManager.getSessionId()
const initialSessionFile = initialManager.getSessionFile()
assert.ok(initialSessionFile)
const workspaceHost = createWorkspaceHost({
  lifecycle,
  attachment: await lifecycle.attach({
    conversation: { sessionId: initialSessionId, sessionFile: initialSessionFile, dataHome },
    cwd: lead,
  }),
  dataHome,
  openSessionManager: (file, cwd) => pi.SessionManager.open(file, sessionDir, cwd),
  repositoryRoot: async cwd => resolve(cwd),
})

const observer =
  (cwd: string, projectTrust: ProjectTrustContext) =>
  (api: ExtensionAPI): void => {
    api.on('session_start', (_event, context) => {
      runtimeSnapshots.push({
        cwd: context.cwd,
        sessionId: context.sessionManager.getSessionId(),
        sessionFile: context.sessionManager.getSessionFile(),
        shutdownEntries: context.sessionManager
          .getEntries()
          .filter(entry => entry.type === 'custom' && entry.customType === 'dev36/shutdown').length,
      })
      projectTrustContexts.push({
        cwd: context.cwd,
        mode: projectTrust.mode,
        hasUI: projectTrust.hasUI,
      })
      if (context.cwd === lead) runStarted.settle()
      toolRegistryByPath.set(resolve(context.cwd), api.getAllTools())
      context.ui.onTerminalInput(data => {
        if (data === '\u001b' || data === '\u001b[27u') {
          terminalInputs.push(data)
          terminalEscape.settle()
        }
        return undefined
      })
    })
    api.on('agent_start', (_event, context) => {
      if (!mainTurnWasDone) process.stdout.write('\nDEV36_INITIAL_AGENT_START\n')
      if (context.cwd === targetA)
        pendingEditorSnapshots.push({ cwd: context.cwd, editor: context.ui.getEditorText() })
    })
    api.on('agent_end', event => {
      const last = event.messages.findLast(message => message.role === 'assistant')
      const stopReason = last?.role === 'assistant' ? last.stopReason : undefined
      if (!mainTurnWasDone && lastStep === 'main-done' && stopReason === 'stop') {
        mainTurnWasDone = true
        mainTurnDone.settle()
      }
      if (lastStep === 'background-done' && stopReason === 'stop') backgroundTurnDone.settle()
      if (lastStep === 'retained-done' && stopReason === 'stop') retainedTurnDone.settle()
      if (lastStep === 'agent-abort' && stopReason === 'aborted' && terminalInputs.length === 0)
        setImmediate(() => {
          assert.equal(terminalInputs.length, 0, 'model abort was not caused by a terminal Escape')
          abortedWithoutEscape.settle()
        })
    })
    api.on('tool_result', event => {
      if (event.toolCallId.startsWith('work-owner-')) {
        const text = textOf(event.content)
        const parsed: unknown = JSON.parse(text)
        assert.ok(
          typeof parsed === 'object' &&
            parsed !== null &&
            'id' in parsed &&
            typeof parsed.id === 'string' &&
            'status' in parsed &&
            typeof parsed.status === 'string',
          `WorkOwner returned an unexpected result: ${text}`
        )
        processResults.set(event.toolCallId, { id: parsed.id, status: parsed.status })
        if (event.toolCallId === 'work-owner-process') workToolReturned.settle()
      }
    })
    api.on('session_shutdown', event => {
      api.appendEntry('dev36/shutdown', { reason: event.reason })
    })
    if (resolve(cwd) === resolve(targetA)) {
      api.registerTool({
        ...pi.createWriteToolDefinition(cwd),
        name: 'read',
        label: 'Fixture shadowed read',
        description: 'Mutation fixture whose name deliberately shadows Pi read.',
        execute: async (_id, args, _signal, _update, context) => {
          writeFileSync(join(context.cwd, args.path), args.content)
          return { content: [{ type: 'text', text: 'shadow read executed' }], details: undefined }
        },
      })
    }
    api.registerTool({
      ...pi.createWriteToolDefinition(cwd),
      name: 'fixture_custom_write',
      label: 'Fixture custom writer',
      description: 'Disposable custom writer; it has no recorded workspace effect.',
      execute: async (_id, args, _signal, _update, context) => {
        writeFileSync(join(context.cwd, args.path), args.content)
        return { content: [{ type: 'text', text: 'custom write executed' }], details: undefined }
      },
    })
  }

const runtimeFactory: Pi.CreateAgentSessionRuntimeFactory = async options => {
  const { attachment, cwd, sessionManager } = await workspaceHost.prepareRuntime({
    sessionManager: options.sessionManager,
    cwd: options.cwd,
  })
  const work = createWorkExtension({
    dataHome,
    profile: 'general',
    workspace: { lifecycle, attachment },
    isWorkspaceParked: workspaceHost.isParked,
  })
  preparedWorkExtensions.push({ cwd, work })
  workspaceHost.setWorkControls({ running: work.runningWork, stopAll: work.stopAll })
  const settingsManager = pi.SettingsManager.create(cwd, agentDir, { projectTrusted: false })
  const trustStore = new pi.ProjectTrustStore(agentDir)
  trustStore.set(cwd, false)
  const projectTrustContext =
    options.projectTrustContext?.cwd === cwd ? options.projectTrustContext : untrustedContext(cwd)
  const services = await pi.createAgentSessionServices({
    cwd,
    agentDir,
    settingsManager,
    modelRuntime,
    resourceLoaderOptions: {
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [
        { name: 'dev36:observer', factory: observer(cwd, projectTrustContext) },
        { name: 'dev:work', factory: work.factory },
        { name: 'dev:workspace-host', factory: instrumentHost(workspaceHost.extensionFactory) },
      ],
    },
    resourceLoaderReloadOptions: {
      resolveProjectTrust: ({ extensionsResult }) =>
        trustResolver.resolveProjectTrusted({
          cwd,
          trustStore,
          defaultProjectTrust: settingsManager.getDefaultProjectTrust(),
          extensionsResult,
          projectTrustContext,
        }),
    },
  })
  const result = await pi.createAgentSessionFromServices({
    services,
    sessionManager,
    sessionStartEvent: options.sessionStartEvent,
    model: offlineModel,
    thinkingLevel: 'off',
    tools: ['read', 'write', 'edit', 'bash', 'work', 'fixture_custom_write'],
    customTools: [
      pi.defineTool(
        pi.createBashToolDefinition(cwd, {
          operations: workspaceHost.shellOperations,
          commandPrefix: settingsManager.getShellCommandPrefix(),
        })
      ),
      pi.defineTool(
        pi.createWriteToolDefinition(cwd, { operations: workspaceHost.writeOperations })
      ),
      pi.defineTool(pi.createEditToolDefinition(cwd, { operations: workspaceHost.editOperations })),
    ],
  })
  await workspaceHost.commitRuntime(attachment)
  work.bindSession(result.session)
  assert.equal(
    workspaceHost.attachment,
    attachment,
    'runtime committed the exact prepareRuntime attachment'
  )
  return { ...result, services, diagnostics: services.diagnostics }
}

const activeRuntime = await pi.createAgentSessionRuntime(runtimeFactory, {
  cwd: lead,
  agentDir,
  sessionManager: initialManager,
})
runtime = activeRuntime
workspaceHost.bindRuntime(activeRuntime)

// A failed run must still leave evidence and must not leak the detached process groups
// (a backgrounded `sleep 600`, WorkOwner loops) that only a later host transition would stop.
process.on('exit', () => {
  const calls = providerCalls.map(({ step, cwd, parked }) => ({ step, cwd, parked }))
  writeFileSync(
    join(fixture, 'probe-state.json'),
    `${JSON.stringify({ providerCalls: calls, hostBlocks, timeline }, null, 2)}\n`
  )
  for (const use of uses.values()) {
    if (use.facts.at(-1)?.kind === 'quiescent') continue
    for (const fact of use.facts)
      if (fact.kind === 'spawned')
        try {
          process.kill(-fact.process.group, 'SIGKILL')
        } catch {}
  }
})

const preflightManager = pi.SessionManager.create(targetFail, sessionDir)
preflightManager.appendCustomEntry('dev36/preflight', { persisted: true })
preflightManager.appendMessage(assistantMessage([], 'stop'))
const preflightFile = preflightManager.getSessionFile()
assert.ok(preflightFile)
assert.equal(pi.SessionManager.open(preflightFile, sessionDir).getCwd(), targetFail)
failedConversationIds.add(preflightManager.getSessionId())
await assert.rejects(activeRuntime.switchSession(preflightFile), /fixture preflight attach failure/)
assert.equal(activeRuntime.session.sessionManager.getSessionId(), initialSessionId)
assert.equal(activeRuntime.session.sessionManager.getSessionFile(), initialSessionFile)
assert.equal(resolve(activeRuntime.cwd), resolve(lead))
assert.equal(workspaceHost.isParked(), false, 'a failed preflight leaves the old runtime usable')

const builtinReadInfo = activeRuntime.session
  .getAllTools()
  .filter(tool => tool.name === 'read')
  .at(-1)
assert.equal(builtinReadInfo?.sourceInfo.source, 'builtin')

const mode = new pi.InteractiveMode(activeRuntime, {
  initialMessage: 'Run the deterministic dev36 workspace host fixture.',
  startupDiagnostics: [],
})
let runFailure: unknown
const runPromise = mode.run().catch((cause: unknown) => {
  runFailure = cause
})

const within = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), ms).unref()
    }),
  ])
const poll = async <T>(
  what: string,
  read: () => T | undefined | Promise<T | undefined>,
  ms = 15000
): Promise<T> => {
  const until = Date.now() + ms
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`)
    await new Promise(accept => setTimeout(accept, 50))
  }
}
const marker = (name: string): void => {
  process.stdout.write(`\n${name}\n`)
}

const factKinds = (use: FixtureUse): readonly string[] => use.facts.map(fact => fact.kind)
const usesWhere = (predicate: (use: FixtureUse) => boolean): FixtureUse[] =>
  [...uses.values()].filter(predicate)
const shellUses = (): FixtureUse[] =>
  usesWhere(use => use.scope === 'opaque' && use.operation.execution?.taskKey === 'lead-shell')
const factIndex = (useId: string, kind: WorkspaceExecutionFact['kind']): number =>
  timeline.findIndex(
    entry => entry.kind === 'fact' && entry.useId === useId && entry.fact.kind === kind
  )
const settledShell = (use: FixtureUse): boolean =>
  ['quiescent', 'unknown'].includes(use.facts.at(-1)?.kind ?? '')
const bashHistory = () =>
  activeRuntime.session.sessionManager.getEntries().flatMap(entry =>
    entry.type === 'message' && entry.message.role === 'bashExecution'
      ? [
          {
            command: entry.message.command,
            output: entry.message.output,
            exitCode: entry.message.exitCode,
            excludeFromContext: entry.message.excludeFromContext,
          },
        ]
      : []
  )

await within(runStarted.promise, 15000, 'actual TUI session_start')

await within(mainTurnDone.promise, 90000, 'fresh target decisions and final model response')
marker('DEV36_READY_FOR_BASH')
await poll('first user bash history entry', () => (bashHistory().length >= 1 ? true : undefined))
marker('DEV36_BASH_RESULT_1')
await poll('second user bash history entry', () => (bashHistory().length >= 2 ? true : undefined))
const userShellUses = await poll('user shell uses to settle', () => {
  const settled = shellUses().slice(1)
  return settled.length === 2 && settled.every(settledShell) ? settled : undefined
})
marker('DEV36_READY_FOR_WORK')

await within(workToolReturned.promise, 90000, 'actual WorkOwner process tool result')
const firstProcess = processResults.get('work-owner-process')
assert.ok(firstProcess)
assert.equal(firstProcess.status, 'running')
const [workUse] = usesWhere(
  use => use.scope === 'opaque' && use.operation.execution?.attemptId === firstProcess.id
)
assert.ok(workUse, 'the WorkOwner launch was admitted as an opaque scoped use')
assert.deepEqual(factKinds(workUse).slice(0, 3), ['launch-intent', 'spawned', 'started'])
const [workLaunch] = workUse.facts
assert.ok(workLaunch?.kind === 'launch-intent')
const workLogs = workLaunch.execution.logs
assert.ok(workLogs)
await poll('real WorkOwner process output', () =>
  readFileSync(workLogs, 'utf8').includes('dev36-work-owner-started') ? true : undefined
)
const activeWork = preparedWorkExtensions.findLast(item => item.cwd === targetB)?.work
assert.ok(activeWork)
const cancelledWork = async (attemptId: string) => {
  const [use] = usesWhere(
    item => item.scope === 'opaque' && item.operation.execution?.attemptId === attemptId
  )
  assert.ok(use, `attempt ${attemptId} was admitted as an opaque scoped use`)
  const terminal = await poll(`settled attempt ${attemptId}`, async () => {
    const last = use.facts.at(-1)
    const running = (await activeWork.runningWork()).some(item => item.attemptId === attemptId)
    return !running && (last?.kind === 'quiescent' || last?.kind === 'unknown') ? last : undefined
  })
  assert.deepEqual(factKinds(use).slice(0, 3), ['launch-intent', 'spawned', 'started'])
  assert.deepEqual(terminal, {
    kind: 'quiescent',
    reason: 'The owned process group and every tracked descendant were observed gone',
  })
  const spawned = use.facts.find(fact => fact.kind === 'spawned')
  assert.ok(spawned?.kind === 'spawned')
  assert.throws(() => process.kill(spawned.process.pid, 0), /ESRCH/)
  return { attemptId, terminal }
}
await within(backgroundTurnDone.promise, 90000, 'background-work follow-up response')
marker('DEV36_READY_FOR_AGENT_ABORT')
await within(abortedWithoutEscape.promise, 90000, 'agent_end(aborted) cancellation')
const abortObservation = await cancelledWork(firstProcess.id)
marker('DEV36_AGENT_ABORTED_WITHOUT_ESCAPE_CANCELLED_WORK')
await within(terminalEscape.promise, 90000, 'real PTY Escape input')
const escapeProcess = processResults.get('work-owner-escape')
assert.ok(escapeProcess)
assert.equal(escapeProcess.status, 'running')
const escapeObservation = await cancelledWork(escapeProcess.id)
// Input typed while the aborted run is still settling is queued as steering, and an
// aborted run never delivers it.
await activeRuntime.session.waitForIdle()
marker('DEV36_READY_FOR_RETAINED_WORK')
await within(retainedTurnDone.promise, 90000, 'retained background work response')
const retainedProcess = processResults.get('work-owner-retained')
assert.ok(retainedProcess)
assert.equal(retainedProcess.status, 'running')
const [retainedUse] = usesWhere(
  use => use.scope === 'opaque' && use.operation.execution?.attemptId === retainedProcess.id
)
assert.ok(retainedUse, 'the retained WorkOwner launch was admitted as an opaque scoped use')
assert.ok(
  (await activeWork.runningWork()).some(item => item.attemptId === retainedProcess.id),
  'the retained process is still running when the resume starts'
)

const [leadShellUse] = shellUses()
assert.ok(leadShellUse)
const leadShellSpawn = leadShellUse.facts.find(fact => fact.kind === 'spawned')
assert.ok(leadShellSpawn?.kind === 'spawned')
assert.ok(
  !settledShell(leadShellUse),
  'the backgrounded lead-shell descendant keeps its use live until a handoff stops it'
)

marker('DEV36_READY_FOR_COMMANDS')
await within(waitForCommand('list:1'), 90000, 'TUI /workspace list')
await within(waitForCommand('inspect:1'), 90000, 'TUI /workspace inspect')
await within(selectorOpen.promise, 90000, 'TUI retained-workspace selector')
const handoffsBeforeCancel = handoffs.length
await within(waitForCommand('resume:1'), 90000, 'Escape-cancelled TUI resume')
assert.equal(resolve(activeRuntime.cwd), resolve(targetB), 'Escape cancelled without rebinding')
assert.equal(handoffs.length, handoffsBeforeCancel, 'cancelled selection started no handoff')
const secondResume = waitForCommand('resume:2')
await within(confirmOpen.promise, 90000, 'explicit confirmation before stopping live work')
await within(secondResume, 90000, 'explicit same-conversation resume')
assert.equal(workspaceHost.isParked(), false)
assert.equal(resolve(activeRuntime.cwd), resolve(targetA))
assert.equal(activeRuntime.session.sessionManager.getSessionId(), initialSessionId)
assert.equal(
  resolve(activeRuntime.session.sessionManager.getSessionFile() ?? ''),
  resolve(initialSessionFile)
)
assert.equal(runtimeSnapshots.filter(item => item.cwd === targetA).at(-1)?.shutdownEntries, 3)

refusedHandoffTargets.add(WS_RESUME_C)
const snapshotsBeforeRefusal = runtimeSnapshots.length
marker('DEV36_READY_FOR_REFUSED_SWITCH')
await within(waitForCommand('resume:3'), 90000, 'refused TUI resume')
assert.equal(workspaceHost.isParked(), false, 'a switch refused before the host acted unparks')
assert.equal(resolve(activeRuntime.cwd), resolve(targetA))
assert.equal(workspaceHost.attachment.binding.workspaceId, WS_RESUME_A)
assert.equal(runtimeSnapshots.length, snapshotsBeforeRefusal, 'no replacement runtime started')
const refusalNotice = timeline.find(
  entry => entry.kind === 'notify' && entry.message.startsWith('Workspace switch was not performed')
)
assert.ok(refusalNotice?.kind === 'notify', 'the refused switch was reported to the user')
assert.equal(refusalNotice.level, 'warning')
assert.match(
  refusalNotice.message,
  /the current workspace is kept\. Workspace transition refused before the host acted; the current binding is kept: fixture target became unavailable/
)

attachFailures.add(resolve(targetFail))
marker('DEV36_READY_FOR_FAILED_REBIND')
await within(waitForCommand('resume:4'), 90000, 'failed automatic rebind report')
assert.ok(
  attachCalls.some(
    call => call.path === resolve(targetFail) && call.sessionId === initialSessionId
  ),
  'the failed target attachment was actually attempted, not rejected during selection'
)
assert.equal(workspaceHost.isParked(), true, 'failed runtime creation stays fenced')
assert.equal(resolve(activeRuntime.cwd), resolve(targetA), 'no false target runtime was published')
assert.equal(activeRuntime.session.sessionManager.getSessionId(), initialSessionId)
assert.equal(
  resolve(activeRuntime.session.sessionManager.getSessionFile() ?? ''),
  resolve(initialSessionFile)
)

const blockOf = (toolCallId: string): HostBlock | undefined =>
  hostBlocks.find(item => item.toolCallId === toolCallId)
const expectBlock = (
  toolCallId: string,
  cwd: string,
  terminate: boolean,
  reason: RegExp
): HostBlock => {
  const block = blockOf(toolCallId)
  assert.ok(block, `${toolCallId} was not blocked by the host`)
  assert.equal(block.cwd, cwd, `${toolCallId} was blocked in the wrong runtime`)
  assert.equal(block.terminate, terminate, `${toolCallId} terminate flag`)
  assert.match(block.reason, reason)
  return block
}
const PARKED = /Workspace host is parked; stale tools are blocked/
const REBIND = /requires a host rebind: fixture .* The operation was not executed/
const UNVERIFIED = /has no verified workspace effect in dev, so it was not executed/
expectBlock('stale-native-lead', lead, true, REBIND)
expectBlock('stale-custom-lead', lead, true, PARKED)
expectBlock('stale-shadow-read-lead', lead, true, PARKED)
expectBlock('stale-shadow-read-a', targetA, false, UNVERIFIED)
expectBlock('stale-native-a', targetA, true, REBIND)
expectBlock('rejected-native-b', targetB, false, /Native write was not executed: .*parent/)
expectBlock('unverified-custom-b', targetB, false, UNVERIFIED)
for (const toolCallId of [
  'fresh-native-b',
  'warned-read-b',
  'edit-native-b',
  'lead-bash-b',
  'warned-read-b-again',
  'empty-edit-b',
  'work-owner-process',
  'work-owner-escape',
  'work-owner-retained',
])
  assert.equal(blockOf(toolCallId), undefined, `${toolCallId} was admitted`)

assert.deepEqual(
  providerCalls.filter(call => !call.parked).map(call => [call.step, resolve(call.cwd ?? '')]),
  [
    ['stale-lead', lead],
    ['stale-a', targetA],
    ['fresh-write-b', targetB],
    ['mixed-b', targetB],
    ['empty-edit-b', targetB],
    ['main-done', targetB],
    ['work-process', targetB],
    ['background-done', targetB],
    ['agent-abort', targetB],
    ['work-escape', targetB],
    ['escape-stream', targetB],
    ['work-retained', targetB],
    ['retained-done', targetB],
    ['resumed-a', targetA],
  ].map(([step = '', cwd = '']) => [step, resolve(cwd)]),
  'every unparked provider request ran in the expected runtime'
)
const staleCalls = providerCalls.filter(call => call.parked)
for (const call of staleCalls)
  assert.deepEqual(
    [call.step, resolve(call.cwd ?? '')],
    [staleContinuation.id, resolve(targetA)],
    'a parked continuation can only follow the mixed stale batch at writer-a'
  )
for (const toolCallId of ['parked-native', 'parked-bash'])
  for (const block of hostBlocks.filter(item => item.toolCallId === toolCallId))
    assert.deepEqual([block.terminate, PARKED.test(block.reason)], [true, true])
assert.equal(
  hostBlocks.filter(item => item.toolCallId.startsWith('parked-')).length,
  staleCalls.length * 2,
  'every call of a parked continuation was fenced'
)

const toolResults = new Map(
  activeRuntime.session.sessionManager
    .getEntries()
    .flatMap(entry =>
      entry.type === 'message' && entry.message.role === 'toolResult'
        ? [
            [
              entry.message.toolCallId,
              { isError: entry.message.isError, text: textOf(entry.message.content) },
            ] as const,
          ]
        : []
    )
)
const toolResultIds = [...toolResults.keys()]
for (const toolCallId of [
  'stale-native-lead',
  'stale-custom-lead',
  'stale-shadow-read-lead',
  'stale-shadow-read-a',
  'stale-native-a',
  'fresh-native-b',
  'warned-read-b',
  'rejected-native-b',
  'edit-native-b',
  'unverified-custom-b',
  'lead-bash-b',
  'warned-read-b-again',
  'empty-edit-b',
  'work-owner-process',
  'work-owner-escape',
  'work-owner-retained',
])
  assert.ok(toolResults.has(toolCallId), `missing persisted tool result ${toolCallId}`)
for (const absent of [
  join(lead, 'stale-native.txt'),
  join(lead, 'stale-custom.txt'),
  join(lead, 'shadow-read.txt'),
  join(targetA, 'shadow-read-a.txt'),
  join(targetA, 'stale-native-a.txt'),
  join(targetA, 'parked-continuation.txt'),
  join(targetA, 'parked-continuation-bash.txt'),
  join(fixture, 'projects', 'escape-b.txt'),
  join(targetB, 'custom-b.txt'),
])
  assert.equal(existsSync(absent), false, `${absent} must not exist`)
assert.equal(readFileSync(join(targetB, 'fresh-native.txt'), 'utf8'), 'edited decision at writer-b')
for (const toolCallId of ['fresh-native-b', 'edit-native-b', 'lead-bash-b'])
  assert.equal(toolResults.get(toolCallId)?.isError, false, `${toolCallId} succeeded`)
assert.match(toolResults.get('lead-bash-b')?.text ?? '', /^dev36-lead-bash\s*$/)
assert.equal(toolResults.get('empty-edit-b')?.isError, true)
assert.match(toolResults.get('empty-edit-b')?.text ?? '', /edits must contain at least one/)
for (const toolCallId of ['warned-read-b', 'warned-read-b-again']) {
  const result = toolResults.get(toolCallId)
  assert.equal(result?.isError, false)
  assert.match(result?.text ?? '', /dev36-context: writer-b/)
  assert.ok(
    result?.text.endsWith(`[dev workspace] ${WRITER_WARNING}`),
    `${toolCallId} carries the live-checkout reader warning`
  )
}
assert.deepEqual(
  timeline.flatMap(entry =>
    entry.kind === 'notify' && entry.message === WRITER_WARNING ? [entry.level] : []
  ),
  ['warning'],
  'the reader warning was notified once for an unchanged writer presence'
)

for (const [name, source, path] of [
  ['bash', 'sdk', '<sdk:bash>'],
  ['write', 'sdk', '<sdk:write>'],
  ['edit', 'sdk', '<sdk:edit>'],
  ['work', 'inline', '<inline:dev:work>'],
] as const) {
  const info = toolRegistryByPath
    .get(resolve(targetB))
    ?.filter(tool => tool.name === name)
    .at(-1)
  assert.deepEqual(
    info === undefined ? undefined : { source: info.sourceInfo.source, path: info.sourceInfo.path },
    { source, path },
    `the lead ${name} tool has the provenance the host recognizes`
  )
}

const nativeWrites = usesWhere(use => use.scope === 'native-file-write')
assert.equal(nativeWrites.length, 3, 'the write and both edits became native-file-write uses')
for (const use of nativeWrites) {
  assert.equal(use.operation.path, 'fresh-native.txt')
  assert.equal(use.grant.path, join(targetB, 'fresh-native.txt'))
  assert.equal(resolve(use.operation.cwd ?? ''), resolve(targetB))
  assert.equal(uses.get(use.operation.within?.useId ?? '')?.scope, 'ordinary')
  assert.equal(use.stage, 'quiescent')
}
const [nativeWrite, nativeEdit, emptyEdit] = nativeWrites
assert.ok(nativeWrite && nativeEdit && emptyEdit)
const pathStates = (use: FixtureUse): readonly (boolean | undefined)[] =>
  timeline.flatMap(entry =>
    entry.kind === 'fact' && entry.useId === use.grant.useId ? [entry.pathExists] : []
  )
assert.deepEqual(factKinds(nativeWrite), ['operation-started', 'operation-completed'])
assert.deepEqual(
  pathStates(nativeWrite),
  [false, true],
  'the write started before its file existed'
)
assert.deepEqual(factKinds(nativeEdit), ['operation-started', 'operation-completed'])
assert.deepEqual(
  factKinds(emptyEdit),
  ['operation-completed'],
  'an admitted edit that failed before any file operation ended without operation-started'
)
const writeAuthorized = timeline.findIndex(
  entry => entry.kind === 'authorized' && entry.useId === nativeWrite.grant.useId
)
const siblingReadAuthorized = timeline.findIndex(
  (entry, index) =>
    index > writeAuthorized &&
    entry.kind === 'authorized' &&
    uses.get(entry.useId)?.grant.access === 'read'
)
const writeStarted = factIndex(nativeWrite.grant.useId, 'operation-started')
assert.ok(
  writeAuthorized !== -1 &&
    writeAuthorized < siblingReadAuthorized &&
    siblingReadAuthorized < writeStarted,
  'operation-started came from the write itself, after the whole batch had been admitted'
)

const assertShellFacts = (use: FixtureUse, label: string): void => {
  const kinds = factKinds(use)
  assert.deepEqual(kinds.slice(0, 3), ['launch-intent', 'spawned', 'started'], label)
  assert.equal(kinds.at(-1), 'quiescent', `${label} ended observed quiescent`)
  assert.ok(
    kinds.slice(3, -1).length > 0 && kinds.slice(3, -1).every(kind => kind === 'observed'),
    `${label} reported only observed process sets between start and quiescence`
  )
  const lastObserved = use.facts.at(-2)
  assert.deepEqual(lastObserved, { kind: 'observed', processes: [] }, `${label} observed []`)
  const [launch] = use.facts
  assert.ok(launch?.kind === 'launch-intent')
  assert.deepEqual(launch.execution, use.operation.execution)
  assert.equal(launch.execution.sessionId, initialSessionId)
  assert.equal(launch.execution.generation, 'lead')
  const parent = uses.get(use.operation.within?.useId ?? '')
  assert.equal(parent?.scope, 'ordinary', `${label} is scoped within an ordinary grant`)
  assert.equal(parent?.grant.access, 'write', `${label} is scoped within a write grant`)
  assert.equal(use.grant.workspaceId, WS_B)
}
const allShellUses = shellUses()
assert.equal(allShellUses.length, 3, 'lead bash plus ! and !! each admitted one opaque use')
assertShellFacts(leadShellUse, 'lead bash')
const [bangUse, bangBangUse] = userShellUses
assert.ok(bangUse && bangBangUse)
assertShellFacts(bangUse, '!')
assertShellFacts(bangBangUse, '!!')
assert.ok(
  leadShellUse.facts.some(
    fact =>
      fact.kind === 'observed' &&
      fact.processes.some(item => item.pid !== leadShellSpawn.process.pid)
  ),
  'the backgrounded descendant was observed after the shell itself exited'
)
const resumeConfirm = timeline.findIndex(entry => entry.kind === 'confirm')
const resumeSelect = timeline.findIndex(entry => entry.kind === 'select')
const resumeHandoff = timeline.findIndex(
  (entry, index) => index > resumeSelect && entry.kind === 'handoff-started'
)
for (const [label, use] of [
  ['lead shell', leadShellUse],
  ['retained process', retainedUse],
] as const) {
  const settled = factIndex(use.grant.useId, 'quiescent')
  assert.ok(
    resumeConfirm !== -1 && resumeConfirm < settled && settled < resumeSelect,
    `the confirmed resume stopped the ${label} before selecting the target`
  )
}
assert.ok(resumeSelect < resumeHandoff)
assert.deepEqual(retainedUse.facts.at(-1), {
  kind: 'quiescent',
  reason: 'The owned process group and every tracked descendant were observed gone',
})
assert.equal(
  timeline.filter(entry => entry.kind === 'confirm').length,
  1,
  'only the resume with live work asked for confirmation'
)
const firstConfirm = timeline[resumeConfirm]
assert.ok(firstConfirm?.kind === 'confirm')
assert.ok(
  firstConfirm.message.includes(
    `- process task=retained-process attempt=${retainedProcess.id} status=running`
  ),
  'the resume confirmation listed the running WorkOwner process'
)
assert.match(firstConfirm.message, /- 1 shell process group\(s\) started by this conversation/)
assert.throws(() => process.kill(leadShellSpawn.process.pid, 0), /ESRCH/)

assert.deepEqual(
  bashHistory(),
  [
    {
      command: 'echo dev36-one | tee user-bash-one.txt',
      output: 'dev36-one\n',
      exitCode: 0,
      excludeFromContext: false,
    },
    {
      command: 'echo dev36-two | tee user-bash-two.txt',
      output: 'dev36-two\n',
      exitCode: 0,
      excludeFromContext: true,
    },
  ],
  'Pi recorded the executed !/!! commands and the !! context exclusion'
)
assert.equal(readFileSync(join(targetB, 'user-bash-one.txt'), 'utf8'), 'dev36-one\n')
assert.equal(readFileSync(join(targetB, 'user-bash-two.txt'), 'utf8'), 'dev36-two\n')
assert.equal(readFileSync(join(targetB, 'lead-bash.txt'), 'utf8'), 'dev36-lead-bash\n')
assert.deepEqual(
  userBashDecisions.map(({ event, executed }) => ({
    command: event.command,
    excludeFromContext: event.excludeFromContext,
    cwd: resolve(event.cwd),
    executed,
  })),
  [
    {
      command: 'echo dev36-one | tee user-bash-one.txt',
      excludeFromContext: false,
      cwd: resolve(targetB),
      executed: true,
    },
    {
      command: 'echo dev36-two | tee user-bash-two.txt',
      excludeFromContext: true,
      cwd: resolve(targetB),
      executed: true,
    },
  ]
)
const nextContext = providerCalls.find(call => call.step === 'work-process')?.context ?? ''
assert.match(nextContext, /dev36-one/, 'the ! output reached the next provider request')
assert.doesNotMatch(nextContext, /dev36-two/, 'the !! output was excluded from LLM context')

assert.deepEqual(rejectedFacts, [], 'the stub accepted every fact the host and adapters reported')

assert.equal(networkAttempts, 0, 'offline provider made no network calls')
assert.equal(existsSync(extensionMarker), false, 'untrusted project extension was not loaded')
for (const cwd of [targetA, targetB])
  assert.ok(
    projectTrustContexts.some(item => item.cwd === cwd && item.mode === 'tui' && item.hasUI),
    `handoff preserved the actual TUI trust context for ${cwd}`
  )
assert.ok(runtimeSnapshots.every(item => item.sessionId === initialSessionId))
assert.ok(
  runtimeSnapshots.every(item => resolve(item.sessionFile ?? '') === resolve(initialSessionFile))
)
const queuedInput = 'queued while the stale native/custom batch was pending'
assert.ok(
  pendingEditorSnapshots.some(item => item.cwd === targetA && item.editor === queuedInput),
  'pending input was restored before fresh evaluation in the target context'
)
assert.deepEqual(
  timeline.flatMap(entry => (entry.kind === 'handoff-settled' ? [entry.outcome] : [])),
  ['confirmed', 'confirmed', 'confirmed', 'refused', 'unknown'],
  'two automatic handoffs, one resume, one refused switch and one failed rebind'
)
assert.ok(
  handoffs.every(
    item =>
      item.from.conversation.sessionId === initialSessionId &&
      resolve(item.from.conversation.sessionFile) === resolve(initialSessionFile)
  )
)
assert.deepEqual(
  workspaceCommands,
  [
    'list',
    `inspect ${TASK_LEAD}`,
    `resume ${TASK_RESUME}`,
    `resume ${TASK_RESUME} --workspace ${WS_RESUME_A}`,
    `resume ${TASK_RESUME} --workspace ${WS_RESUME_C}`,
    `resume ${TASK_FAIL} --workspace ${WS_FAIL}`,
  ],
  'InteractiveMode dispatched the exact list/inspect/resume grammar'
)
assert.ok(inspections.some(input => resolve(input.cwd ?? '') === resolve(targetB)))
assert.ok(inspections.some(input => input.taskId === TASK_LEAD))
assert.ok(hostMessages.some(message => /workspace/i.test(message)))
assert.ok(terminalInputs.length > 0)
assert.equal(processResults.size, 3)

type ChildToolCallHandler = (event: {
  readonly toolName: string
  readonly input: unknown
}) => Promise<ToolCallEventResult | undefined>
const exerciseChildGate = async (
  registry: readonly ToolInfo[],
  grant: WorkspaceGrant,
  expectBlocked: boolean
): Promise<ToolCallEventResult | undefined> => {
  const handlers: ChildToolCallHandler[] = []
  const sent: { readonly operation?: string }[] = []
  const fakeApi = {
    on: (event: string, handler: ChildToolCallHandler) => {
      if (event === 'tool_call') handlers.push(handler)
    },
    getAllTools: () => [...registry],
  }
  await childWorkspaceExtension(grant)(fakeApi as unknown as ExtensionAPI)
  assert.equal(handlers.length, 1)
  const [handler] = handlers
  const originalSend = process.send
  const originalConnected = Object.getOwnPropertyDescriptor(process, 'connected')
  Object.defineProperty(process, 'connected', { configurable: true, value: true })
  process.send = (message: { requestId: string; useId: string; operation: string }, reply) => {
    sent.push(message)
    setImmediate(() => {
      process.emit(
        'message',
        {
          type: 'workspace-checked',
          requestId: message.requestId,
          useId: message.useId,
          allowed: true,
        },
        undefined
      )
      if (typeof reply === 'function') reply(null)
    })
    return true
  }
  try {
    const result = await handler({ toolName: 'read', input: { path: 'AGENTS.md' } })
    assert.equal(result?.block === true, expectBlocked)
    if (expectBlocked)
      assert.equal(sent.length, 0, 'a read-only child refuses a shadowed read tool before any IPC')
    else assert.equal(sent[0]?.operation, 'read')
    return result
  } finally {
    if (originalSend === undefined) delete process.send
    else process.send = originalSend
    if (originalConnected) Object.defineProperty(process, 'connected', originalConnected)
  }
}
assert.ok(builtinReadInfo)
const childBuiltinResult = await exerciseChildGate(
  [builtinReadInfo],
  grantFor(leadDescriptor, 'read', lead),
  false
)
const shadowReadInfo = toolRegistryByPath
  .get(resolve(targetA))
  ?.filter(tool => tool.name === 'read')
  .at(-1)
assert.ok(shadowReadInfo)
assert.notEqual(shadowReadInfo.sourceInfo.source, 'builtin')
const childShadowResult = await exerciseChildGate(
  [shadowReadInfo],
  grantFor(aDescriptor, 'read', targetA),
  true
)

const report = {
  status: 'passed',
  piVersion: pi.VERSION,
  mode: 'actual InteractiveMode.run() under PTY',
  fixture,
  sessionIdentityPreserved: {
    sessionId: initialSessionId,
    sessionFile: initialSessionFile,
    runtimeCwds: runtimeSnapshots.map(item => item.cwd),
  },
  providerCalls: providerCalls.map(({ step, cwd, parked }) => ({ step, cwd, parked })),
  parkedContinuationCalls: staleCalls.length,
  hostBlocks,
  staleToolResultsPersisted: toolResultIds,
  nativeFileWrites: nativeWrites.map(use => ({ grant: use.grant, facts: use.facts })),
  shellUses: allShellUses.map(use => ({
    attemptId: use.operation.execution?.attemptId,
    facts: factKinds(use),
  })),
  resumeConfirmation: firstConfirm.message,
  refusedSwitchNotice: refusalNotice.message,
  userBash: bashHistory(),
  workOwnerCancellationObservations: [abortObservation, escapeObservation],
  retainedWorkStoppedBeforeSelect: retainedUse.facts.at(-1),
  pendingInputRestored: true,
  repeatedSameFileHandoffs: handoffs.length,
  failedRuntimeCreationStayedParked: workspaceHost.isParked(),
  tuiWorkspaceMessages: hostMessages,
  workspaceCommands,
  projectTrustContexts,
  untrustedProjectExtensionNotLoaded: !existsSync(extensionMarker),
  childBuiltinRead: {
    source: builtinReadInfo.sourceInfo.source,
    result: childBuiltinResult ?? null,
  },
  childShadowedRead: {
    source: shadowReadInfo.sourceInfo.source,
    blocked: childShadowResult?.block === true,
  },
  networkAttempts,
  observations: [
    `Pi ends a tool batch early only when every result sets terminate. The unverified-tool block is non-terminating, so the stale writer-a batch that mixed it with a rebind block let Pi issue ${staleCalls.length} provider request(s) in the parked writer-a context; every tool call from it was fenced with terminate and had no effect.`,
  ],
  limits: [
    'WorkspaceLifecycle is a typed stub mirroring the scoped-operation contract, the execution stage machine and the live-execution refusals; production admission, fencing, persistence and writer-grant restoration after a cancelled switch are covered by the real-authority probe and workspace-authority-check.ts, not here.',
    'The refused switch is fault-injected in the stub; the real triggers (a live execution appearing between select and handoff, an invalidated target) are not produced here.',
    'Shell quiescence is observed through the process group and tracked descendants; a descendant that leaves the group and is not a tracked child escapes observation and is not exercised here.',
    'Project extensions are gated only by Pi folder trust; their executable side effects are not bounded by tool-call instrumentation.',
  ],
}
mode.stop('transcript')
await activeRuntime.dispose()
await workspaceHost.close()
void runPromise
assert.equal(runFailure, undefined)
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(
  `\nDEV36_TUI_HOST_PROBE_PASSED ${JSON.stringify({ fixture, report: reportPath, sessionId: initialSessionId, providerCalls: providerCalls.length, parkedContinuationCalls: staleCalls.length, shellUses: allShellUses.length, networkAttempts })}\n`
)
