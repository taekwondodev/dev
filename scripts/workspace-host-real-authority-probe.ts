// The stub-lifecycle PTY probe covers fault injection; this one keeps every workspace
// decision real, so it catches drift at the seam that the stub cannot see.
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
import { setTimeout as sleep } from 'node:timers/promises'
import type * as Pi from '@earendil-works/pi-coding-agent'
import type * as PiProjectTrust from '../node_modules/@earendil-works/pi-coding-agent/dist/core/project-trust.js'
import type {
  ExtensionAPI,
  ExtensionFactory,
} from '../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.js'
import { createWorkExtension } from '../src/work-extension.ts'
import { parseWorkspaceCommand, runReadOnlyWorkspaceCommand } from '../src/workspace-command.ts'
import type { WorkspaceView } from '../src/workspace-domain.ts'
import { createWorkspaceHost } from '../src/workspace-host.ts'
import { openLifecycle } from './workspace-test-lifecycle.ts'
import { Effect } from 'effect'

interface AssistantEventStream {
  push(event: unknown): void
  end(): void
}
interface EventStreamModule {
  createAssistantMessageEventStream(): AssistantEventStream
}

const piRoot = new URL('../node_modules/@earendil-works/pi-coding-agent/', import.meta.url)
const pi: typeof Pi = await import(new URL('dist/index.js', piRoot).href)
const trustResolver: typeof PiProjectTrust = await import(
  new URL('dist/core/project-trust.js', piRoot).href
)
const eventStreamModule: EventStreamModule = await import(
  new URL('node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js', piRoot).href
)

const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'dev-workspace-real-authority-')))
const lead = join(fixture, 'projects', 'lead')
const sessionDir = join(fixture, 'sessions')
const agentDir = join(fixture, 'agent')
const dataHome = join(fixture, 'data')
const authorityRoot = join(fixture, 'authority')

const mkdir = (path: string) => mkdirSync(path, { recursive: true })
const git = (args: readonly string[], cwd: string) =>
  execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()
const gitRoot = async (cwd: string) => git(['rev-parse', '--show-toplevel'], cwd)
const signal = (marker: string) => process.stdout.write(`\nDEV_REAL_AUTHORITY_${marker}\n`)

mkdir(lead)
writeFileSync(join(lead, 'AGENTS.md'), 'real-authority probe: lead\n')
git(['init', '--quiet', '-b', 'main'], lead)
git(['config', 'user.email', 'real-authority@example.invalid'], lead)
git(['config', 'user.name', 'real authority probe'], lead)
git(['add', 'AGENTS.md'], lead)
git(['commit', '--quiet', '-m', 'real-authority fixture'], lead)
const leadCommit = git(['rev-parse', 'HEAD'], lead)

for (const path of [sessionDir, agentDir, dataHome]) mkdir(path)
process.env.HOME = join(fixture, 'home')
process.env.PI_CODING_AGENT_DIR = agentDir
process.env.PI_OFFLINE = '1'
process.env.PI_TELEMETRY_DISABLED = '1'
mkdir(process.env.HOME)
let networkAttempts = 0
globalThis.fetch = async () => {
  networkAttempts += 1
  throw new Error('Network is disabled by the real-authority probe')
}

const lifecycle = await openLifecycle({ root: authorityRoot })

const squatterHome = join(fixture, 'squatter')
mkdir(squatterHome)
const squatterSessionFile = join(squatterHome, 'session.jsonl')
writeFileSync(squatterSessionFile, '{}\n', { mode: 0o600 })
const squatter = await lifecycle.attach({
  conversation: {
    sessionId: 'real-authority-squatter',
    sessionFile: squatterSessionFile,
    dataHome: squatterHome,
  },
  cwd: lead,
})
const squatterAdmission = await squatter.authorize({ access: 'write' })
if (squatterAdmission.kind !== 'ready') throw new Error('The squatter was not admitted')
assert.equal(resolve(squatterAdmission.grant.checkout), resolve(lead))
const squatterTaskId = squatterAdmission.grant.taskId
if (squatterTaskId === undefined) throw new Error('A real write grant carries a task identity')

type SessionModel = NonNullable<
  Parameters<(typeof Pi)['createAgentSessionFromServices']>[0]['model']
>
const offlineModel: SessionModel = {
  id: 'real-authority',
  name: 'Offline real-authority probe',
  api: 'openai-completions',
  provider: 'real-authority-offline',
  baseUrl: 'http://127.0.0.1:9/v1',
  reasoning: false,
  input: ['text'],
  contextWindow: 200000,
  maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}
const assistantMessage = (content: readonly unknown[], stopReason: string) => ({
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
const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({
  type: 'toolCall',
  id,
  name,
  arguments: args,
})

const lateMarker = 'late.txt'
const script: readonly (readonly unknown[])[] = [
  [toolCall('contended-read', 'read', { path: 'AGENTS.md' })],
  [
    toolCall('contended-native-write', 'write', {
      path: 'contended.txt',
      content: 'must not reach the contended checkout',
    }),
  ],
  [
    toolCall('lead-shell', 'bash', {
      command: `printf shell-ran > shell.txt; (sleep 1; printf late > ${lateMarker}) &`,
    }),
    toolCall('native-write', 'write', { path: 'native.txt', content: 'native write\n' }),
    toolCall('second-native-write', 'write', { path: 'second.txt', content: 'second write\n' }),
    toolCall('duplicate-native-write', 'write', { path: 'NATIVE.txt', content: 'duplicate\n' }),
  ],
  [toolCall('own-read', 'read', { path: 'native.txt' })],
  [toolCall('unverified-tool', 'probe_unverified', {})],
  [{ type: 'text', text: 'Real-authority host seam probe completed.' }],
]
let providerCall = 0
let resolveFinished: () => void = () => undefined
const finished = new Promise<void>(resolveFinish => {
  resolveFinished = resolveFinish
})
let resolveLeadStarted: () => void = () => undefined
const leadStarted = new Promise<void>(resolveStart => {
  resolveLeadStarted = resolveStart
})
let resolveReloaded: () => void = () => undefined
const reloaded = new Promise<void>(resolveReload => {
  resolveReloaded = resolveReload
})

function scriptedStream(
  _model: unknown,
  _context: unknown,
  options?: { readonly signal?: AbortSignal }
) {
  const content = script[Math.min(providerCall, script.length - 1)] ?? []
  providerCall += 1
  const stream = eventStreamModule.createAssistantMessageEventStream()
  const message = assistantMessage(content, providerCall < script.length ? 'toolUse' : 'stop')
  const timer = setTimeout(() => {
    stream.push({ type: 'done', reason: message.stopReason, message })
    stream.end()
  }, 40)
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
modelRuntime.registerProvider('real-authority-offline', {
  name: offlineModel.name,
  api: offlineModel.api,
  baseUrl: offlineModel.baseUrl,
  apiKey: 'offline',
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
  streamSimple: scriptedStream as never,
})

const initialManager = pi.SessionManager.create(lead, sessionDir)
const initialSessionFile = initialManager.getSessionFile()
if (initialSessionFile === undefined) throw new Error('Pi did not assign a session file')
const hostAttachment = await lifecycle.attach({
  conversation: {
    sessionId: initialManager.getSessionId(),
    sessionFile: initialSessionFile,
    dataHome,
  },
  cwd: lead,
})
const workspaceHost = createWorkspaceHost({
  lifecycle: lifecycle.effect,
  attachment: hostAttachment.effect,
  dataHome,
  openSessionManager: (file, cwd) => pi.SessionManager.open(file, sessionDir, cwd),
  repositoryRoot: gitRoot,
})

const observer: ExtensionFactory = (api: ExtensionAPI) => {
  api.registerTool({
    name: 'probe_unverified',
    label: 'Unverified probe tool',
    description: 'A tool with no verified workspace effect record.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute() {
      writeFileSync(join(fixture, 'unverified-tool-ran'), 'ran')
      return { content: [{ type: 'text', text: 'ran' }], details: {} }
    },
  })
  api.on('session_start', (event, context) => {
    if (resolve(context.cwd) === resolve(lead)) resolveLeadStarted()
    if (event.reason === 'reload') resolveReloaded()
  })
  api.on('agent_end', event => {
    const last = event.messages.findLast(message => message.role === 'assistant')
    if (providerCall >= script.length && last?.stopReason === 'stop') resolveFinished()
  })
}

const runtime = await pi.createAgentSessionRuntime(
  async options => {
    const prepared = await workspaceHost.prepareRuntime({
      sessionManager: options.sessionManager,
      cwd: options.cwd,
    })
    const { attachment, cwd, sessionManager } = prepared
    const work = createWorkExtension({
      dataHome,
      profile: 'general',
      workspace: { lifecycle: lifecycle.effect, attachment },
      isWorkspaceParked: workspaceHost.isParked,
    })
    workspaceHost.setWorkControls({ running: work.runningWork, stopAll: work.stopAll })
    const settingsManager = pi.SettingsManager.create(cwd, agentDir, { projectTrusted: false })
    const trustStore = new pi.ProjectTrustStore(agentDir)
    trustStore.set(cwd, false)
    const projectTrustContext = options.projectTrustContext ?? {
      cwd,
      mode: 'tui' as const,
      hasUI: false,
      ui: {
        select: async () => undefined,
        confirm: async () => false,
        input: async () => undefined,
        notify: () => undefined,
      },
    }
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
          { name: 'probe:observer', factory: observer },
          { name: 'dev:work', factory: work.factory },
          { name: 'dev:workspace-host', factory: workspaceHost.extensionFactory },
        ],
      },
      resourceLoaderReloadOptions: {
        resolveProjectTrust: ({ extensionsResult }) =>
          trustResolver.resolveProjectTrusted({
            cwd,
            trustStore,
            defaultProjectTrust: settingsManager.getDefaultProjectTrust(),
            extensionsResult,
            projectTrustContext: { ...projectTrustContext, cwd },
          }),
      },
    })
    const result = await pi.createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent: options.sessionStartEvent,
      model: offlineModel,
      thinkingLevel: 'off',
      tools: ['read', 'write', 'edit', 'bash', 'work', 'probe_unverified'],
      customTools: [
        pi.defineTool(
          pi.createBashToolDefinition(cwd, { operations: workspaceHost.shellOperations })
        ),
        pi.defineTool(
          pi.createWriteToolDefinition(cwd, { operations: workspaceHost.writeOperations })
        ),
        pi.defineTool(
          pi.createEditToolDefinition(cwd, { operations: workspaceHost.editOperations })
        ),
      ],
    })
    await workspaceHost.commitRuntime(attachment)
    work.bindSession(result.session)
    return { ...result, services, diagnostics: services.diagnostics }
  },
  { cwd: lead, agentDir, sessionManager: initialManager }
)
workspaceHost.bindRuntime(runtime)

const within = <A>(promise: Promise<A>, ms: number, what: string) =>
  Promise.race([
    promise,
    sleep(ms).then(() => {
      throw new Error(`timed out: ${what}`)
    }),
  ])
const waitFor = async <A>(what: string, probe: () => Promise<A | undefined>): Promise<A> => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const value = await probe()
    if (value !== undefined) return value
    await sleep(250)
  }
  throw new Error(`timed out: ${what}`)
}

const mode = new pi.InteractiveMode(runtime, {
  initialMessage: 'Run the real-authority host seam probe.',
  startupDiagnostics: [],
})
let runFailure: unknown
void mode.run().catch((cause: unknown) => {
  runFailure = cause
})

await within(leadStarted, 30000, 'lead session_start')
assert.equal(resolve(runtime.cwd), resolve(lead))

const readOnly = (args: readonly string[]) => {
  const command = parseWorkspaceCommand([...args])
  if (command.kind === 'resume') throw new Error('Expected a read-only workspace command')
  return Effect.runPromise(runReadOnlyWorkspaceCommand(lifecycle.effect, command, { cwd: lead }))
}
const listResult = await readOnly([])
const inspectResult = await readOnly(['inspect', squatterTaskId])
assert.equal(listResult.exitCode, 0, listResult.stderr ?? '')
assert.equal(inspectResult.exitCode, 0, inspectResult.stderr ?? '')
assert.match(listResult.stdout ?? '', /Workspace list for repository/)
assert.match(inspectResult.stdout ?? '', /^ {2}use [\w-]+: write, /m)

await within(finished, 90000, 'scripted turns to finish')
signal('TURNS_FINISHED')

const binding = workspaceHost.attachment.binding
const managed = binding.cwd
assert.notEqual(resolve(managed), resolve(lead), 'the contended write rebinds the conversation')
assert.equal(git(['rev-parse', 'HEAD'], managed), leadCommit)
assert.ok(!existsSync(join(lead, 'contended.txt')), 'the blocked write never ran')
assert.ok(!existsSync(join(managed, 'contended.txt')), 'the blocked write was not replayed')
assert.equal(readFileSync(join(managed, 'shell.txt'), 'utf8'), 'shell-ran')
assert.equal(readFileSync(join(managed, 'native.txt'), 'utf8'), 'native write\n')
assert.ok(!existsSync(join(fixture, 'unverified-tool-ran')), 'the unverified tool never ran')
assert.equal(providerCall, script.length, 'refusing the unverified tool did not end the turn')

const toolResults = runtime.session.sessionManager
  .getEntries()
  .flatMap(entry =>
    entry.type === 'message' && entry.message.role === 'toolResult' ? [entry.message] : []
  )
const resultText = (toolCallId: string) => {
  const found = toolResults.find(message => message.toolCallId === toolCallId)
  if (found === undefined) throw new Error(`No persisted result for ${toolCallId}`)
  return {
    isError: found.isError,
    text: found.content.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('\n'),
  }
}
assert.match(
  resultText('contended-read').text,
  /\[dev workspace\] A writer owns this live checkout/
)
assert.match(resultText('contended-native-write').text, /rebind|not executed|admission/i)
assert.equal(resultText('lead-shell').isError, false)
assert.equal(resultText('native-write').isError, false)
assert.equal(resultText('second-native-write').isError, false)
assert.equal(readFileSync(join(managed, 'second.txt'), 'utf8'), 'second write\n')
const duplicate = resultText('duplicate-native-write')
assert.equal(duplicate.isError, true)
assert.match(duplicate.text, /still in flight/)
assert.ok(
  !resultText('own-read').text.includes('[dev workspace]'),
  "a read beside the conversation's own writer is not warned"
)
const unverified = resultText('unverified-tool')
assert.equal(unverified.isError, true)
assert.match(unverified.text, /no verified workspace effect/)

const managedUses = async () =>
  (await lifecycle.inspect({})).find(
    (view: WorkspaceView) => view.workspaceId === binding.workspaceId
  )?.uses ?? []
const shellUse = await waitFor('the lead shell use to settle', async () => {
  const use = (await managedUses()).find(
    item => item.effect === 'opaque' && item.execution?.taskKey === 'lead-shell'
  )
  return use?.stage === 'quiescent' ? use : undefined
})
assert.match(shellUse.reason ?? '', /observed gone/)
assert.equal(readFileSync(join(managed, lateMarker), 'utf8'), 'late')
const nativeUses = (await managedUses()).filter(item => item.effect === 'native-file-write')
for (const name of ['native.txt', 'second.txt']) {
  const nativeUse = nativeUses.find(item => item.path === join(managed, name))
  assert.equal(nativeUse?.stage, 'quiescent', name)
  assert.equal(nativeUse?.reason, 'operation-completed:native-file-write', name)
}
const duplicateUse = nativeUses.find(item => item.path === join(managed, 'NATIVE.txt'))
assert.equal(duplicateUse?.stage, 'quiescent')
assert.equal(duplicateUse?.reason, 'operation-ended-before-start:native-file-write')

signal('READY_FOR_USER_BASH')
await waitFor('the user shell command to run', async () =>
  existsSync(join(managed, 'user.txt')) ? true : undefined
)
assert.equal(readFileSync(join(managed, 'user.txt'), 'utf8'), 'user-bash')
await waitFor('the user shell use to settle', async () => {
  const shells = (await managedUses()).filter(
    item => item.effect === 'opaque' && item.execution?.taskKey === 'lead-shell'
  )
  return shells.length === 2 && shells.every(item => item.stage === 'quiescent') ? true : undefined
})
const userBash = runtime.session.sessionManager
  .getEntries()
  .flatMap(entry =>
    entry.type === 'message' && entry.message.role === 'bashExecution' ? [entry.message] : []
  )
assert.ok(userBash.some(message => message.command.includes('user-bash')))

// A /reload keeps the conversation's live shells; any other session end stops them. The
// backgrounded sleep outlives the shell, so its use stays live until the family is gone.
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const survivorSeconds = 60
const survivorPidFile = join(fixture, 'reload-survivor.pid')
const survivorLaunchedAt = Date.now()
await workspaceHost.shellOperations.exec(
  `sleep ${survivorSeconds} >/dev/null 2>&1 & printf %s $! > ${JSON.stringify(survivorPidFile)}`,
  managed,
  { onData: () => undefined }
)
const survivorPid = Number(readFileSync(survivorPidFile, 'utf8'))
// A failed run must not leak the family that only the session end would stop.
let survivorStopped = false
process.on('exit', () => {
  if (!survivorStopped)
    try {
      process.kill(survivorPid, 'SIGKILL')
    } catch {}
})
const survivorUse = await waitFor('the live shell use', async () =>
  (await managedUses()).find(
    item =>
      item.effect === 'opaque' &&
      item.execution?.taskKey === 'lead-shell' &&
      item.stage !== 'quiescent'
  )
)
signal('READY_FOR_RELOAD')
await within(reloaded, 60000, 'the /reload session restart')
await sleep(1500)
assert.ok(alive(survivorPid), 'a reload keeps the live shell family')
assert.notEqual(
  (await managedUses()).find(item => item.id === survivorUse.id)?.stage,
  'quiescent',
  'a reload keeps the live shell use open'
)

const report = {
  fixture,
  leadCommit,
  managedWorkspace: binding.workspaceId,
  networkAttempts,
  checks: [
    'a real contended native write is blocked, rebinds to an exact-commit managed worktree and is not replayed',
    'the lead bash tool runs through the workspace shell; its use ends only after a backgrounded descendant is observed gone',
    'a read beside a live writer carries the writer warning in its tool result',
    'lead native writes to distinct files in one batch each record their exact destination as a scoped use, started from inside the write and settled when Pi reports the call finished',
    'a lead native write to a file already being written under another case is refused, and the host settles its use before it starts',
    "a read beside the conversation's own writer carries no warning",
    'a tool without a verified workspace effect is refused without ending the turn',
    'a user ! command runs through the same workspace shell and Pi records it in history',
    'a /reload typed in the TUI keeps a live lead shell family and its open use; the session end that follows (quit) stops the family, observes it gone and settles the use as quiescent',
    'no network access is attempted',
  ],
  limits: [
    'No power-loss or crash durability proof.',
    'A process that detaches into its own session escapes shell observation by design.',
  ],
}

mode.stop('transcript')
assert.ok(alive(survivorPid), 'the live shell family is still running when the session ends')
await runtime.dispose()
for (let attempt = 0; attempt < 20 && alive(survivorPid); attempt += 1) await sleep(250)
assert.ok(!alive(survivorPid), 'ending the session stops the live shell family')
survivorStopped = true
assert.ok(
  Date.now() - survivorLaunchedAt < (survivorSeconds - 10) * 1000,
  'the family was stopped, not left to finish on its own'
)
const stoppedUse = (await managedUses()).find(item => item.id === survivorUse.id)
assert.equal(stoppedUse?.stage, 'quiescent', stoppedUse?.reason)
assert.match(stoppedUse?.reason ?? '', /observed gone/)
await workspaceHost.close()
await squatter.close()
await lifecycle.close()
assert.equal(runFailure, undefined)
assert.equal(networkAttempts, 0)
process.stdout.write(`\nDEV_REAL_AUTHORITY_PROBE_PASSED ${JSON.stringify(report)}\n`)
