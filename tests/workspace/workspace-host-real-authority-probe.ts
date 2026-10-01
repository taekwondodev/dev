import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
} from '../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.js'
import { sweepAtQuit } from '../../src/launcher.ts'
import { parseWorkspaceCommand, runReadOnlyWorkspaceCommand } from '../../src/workspace-command.ts'
import { WorkspaceError, type WorkspaceView } from '../../src/workspace-domain.ts'
import {
  deferred,
  loadInstalledPi,
  makeClaims,
  makeOfflineModel,
  openHostRuntime,
  replay,
  type ScriptedContent,
  toolCall,
  waitFor,
  within,
} from './workspace-check-support.ts'
import { openLifecycle } from './workspace-test-lifecycle.ts'
import { Deferred, Effect } from 'effect'

const { pi, packageInfo, importFromPi } = await loadInstalledPi()

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

writeFileSync(join(lead, '.gitattributes'), 'AGENTS.md filter=probe\n')
git(['init', '--quiet', '-b', 'main'], lead)
git(['config', 'user.email', 'real-authority@example.invalid'], lead)
git(['config', 'user.name', 'real authority probe'], lead)
git(['add', 'AGENTS.md', '.gitattributes'], lead)
git(['commit', '--quiet', '-m', 'real-authority filtered fixture'], lead)
const filterMarker = join(fixture, 'checkout-filter-ran')
git(['config', 'filter.probe.smudge', `touch ${JSON.stringify(filterMarker)}`], lead)

for (const path of [sessionDir, agentDir, dataHome]) mkdir(path)
const trustStore = new pi.ProjectTrustStore(agentDir)
trustStore.set(fixture, false)
process.env.HOME = join(fixture, 'home')
process.env.PI_CODING_AGENT_DIR = agentDir
process.env.PI_OFFLINE = '1'
process.env.PI_TELEMETRY_DISABLED = '1'
mkdir(join(process.env.HOME, '.agents', 'skills'))
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
const squatterAdmission = await squatter.authorize({ kind: 'write' })
if (squatterAdmission.kind !== 'ready') throw new Error('The squatter was not admitted')
assert.equal(resolve(squatterAdmission.grant.checkout), resolve(lead))
const squatterTaskId = squatterAdmission.grant.taskId
if (squatterTaskId === undefined) throw new Error('A real write grant carries a task identity')

const lateMarker = 'late.txt'
const script: readonly ScriptedContent[] = [
  [
    toolCall('filtered-write', 'write', {
      path: 'filtered.txt',
      content: 'must not reach the contended checkout',
    }),
  ],
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
const {
  model: offlineModel,
  modelRuntime,
  assistantMessage,
} = await makeOfflineModel({
  pi,
  importFromPi,
  fixture,
  id: 'real-authority',
  stream: replay(() => {
    const content = script[Math.min(providerCall, script.length - 1)] ?? []
    providerCall += 1
    return content
  }, 40),
})
const refusalEnded = deferred<void>()
const finished = deferred<void>()
const leadStarted = deferred<void>()
const reloaded = deferred<void>()

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
    if (resolve(context.cwd) === resolve(lead)) leadStarted.resolve()
    if (event.reason === 'reload') reloaded.resolve()
  })
  api.on('agent_end', event => {
    const last = event.messages.findLast(message => message.role === 'assistant')
    if (providerCall === 1) refusalEnded.resolve()
    if (providerCall >= script.length && last?.stopReason === 'stop') finished.resolve()
  })
}

const notices: string[] = []
const bound = (target: object, key: string | symbol): unknown => {
  const value: unknown = Reflect.get(target, key)
  return typeof value === 'function' ? value.bind(target) : value
}
let confirmations = 0
const confirmationTexts: { readonly title: string; readonly message: string }[] = []
const recordingNotices = (context: ExtensionContext): ExtensionContext =>
  new Proxy(context, {
    get: (target, key) =>
      key === 'ui'
        ? new Proxy(target.ui, {
            get: (ui, uiKey) => {
              if (uiKey === 'notify')
                return (...args: Parameters<ExtensionContext['ui']['notify']>) => {
                  notices.push(args[0])
                  ui.notify(...args)
                }

              if (uiKey === 'confirm')
                return (...args: Parameters<ExtensionContext['ui']['confirm']>) => {
                  confirmations += 1
                  confirmationTexts.push({ title: args[0], message: args[1] })
                  signal(`CONFIRM_OPEN_${confirmations}`)
                  return ui.confirm(...args)
                }
              return bound(ui, uiKey)
            },
          })
        : bound(target, key),
  })
const recordHostNotices =
  (factory: ExtensionFactory): ExtensionFactory =>
  api =>
    factory(
      new Proxy(api, {
        get: (target, key) => {
          if (key === 'on')
            return (
              event: string,
              handler: (payload: unknown, context: ExtensionContext) => unknown
            ) =>
              Reflect.apply(target.on, target, [
                event,
                (payload: unknown, context: ExtensionContext) =>
                  handler(payload, recordingNotices(context)),
              ])
          if (key === 'registerCommand')
            return (
              name: string,
              command: { handler: (args: string, context: ExtensionContext) => unknown } & Record<
                string,
                unknown
              >
            ) =>
              Reflect.apply(target.registerCommand, target, [
                name,
                {
                  ...command,
                  handler: (args: string, context: ExtensionContext) =>
                    command.handler(args, recordingNotices(context)),
                },
              ])
          return bound(target, key)
        },
      })
    )

const opened = await openHostRuntime({
  coordination: { installationPath: fixture, namespacePath: authorityRoot },
  pi,
  packageRoot: packageInfo.root,
  lifecycle: lifecycle.effect,
  attachment: hostAttachment.effect,
  dataHome,
  sessionDir,
  agentDir,
  manager: initialManager,
  cwd: lead,
  repositoryRoot: cwd => Effect.promise(() => gitRoot(cwd)),
  offline: { model: offlineModel, modelRuntime },
  extensions: dev => [
    { name: 'probe:observer', factory: observer },
    ...dev.map(item =>
      item.name === 'dev:workspace-host'
        ? { ...item, factory: recordHostNotices(item.factory) }
        : item
    ),
  ],
})
const workspaceHost = opened.host
const { runtime } = opened
const bindingBeforeRefusal = structuredClone(workspaceHost.attachment.binding)

const mode = new pi.InteractiveMode(runtime, {
  initialMessage: 'Run the real-authority host seam probe.',
  startupDiagnostics: [],
})
let runFailure: unknown
void mode.run().catch((cause: unknown) => {
  runFailure = cause
})

await within(leadStarted.promise, 30000, 'lead session_start')
assert.equal(resolve(runtime.cwd), resolve(lead))
const { claim, passed } = makeClaims()

const readOnly = (args: readonly string[]) => {
  const command = Effect.runSync(parseWorkspaceCommand(args))
  if (command.kind === 'release') throw new Error('Expected a read-only workspace command')
  return Effect.runPromise(
    runReadOnlyWorkspaceCommand(Effect.succeed(lifecycle.effect), command, {
      repositoryRoot: Effect.succeed(lead),
    })
  )
}
await claim(
  "the read-only list and inspect commands answer from the real authority with the squatter's workspace and its write use",
  async () => {
    const listResult = await readOnly([])
    const inspectResult = await readOnly(['inspect', squatterTaskId])
    assert.equal(listResult.exitCode, 0, listResult.text)
    assert.equal(inspectResult.exitCode, 0, inspectResult.text)
    const squatterRow = `task ${squatterTaskId} — workspace ${squatterAdmission.grant.workspaceId}`
    assert.deepEqual(
      listResult.text.split('\n').filter(line => !line.startsWith(' ')),
      [`Workspace list for repository ${lead}:`, squatterRow]
    )
    const inspected = inspectResult.text.split('\n')
    assert.equal(inspected[0], `Workspace records for exact task ${squatterTaskId}: ${squatterRow}`)
    assert.ok(
      inspected.some(line => line.startsWith(`  use ${squatterAdmission.grant.useId}: write, `)),
      inspectResult.text
    )
  }
)

const persistedResult = (toolCallId: string) => {
  const found = runtime.session.sessionManager
    .getEntries()
    .flatMap(entry =>
      entry.type === 'message' && entry.message.role === 'toolResult' ? [entry.message] : []
    )
    .find(message => message.toolCallId === toolCallId)
  if (found === undefined) throw new Error(`No persisted result for ${toolCallId}`)
  return {
    isError: found.isError,
    text: found.content.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('\n'),
  }
}
const worktrees = () =>
  git(['worktree', 'list', '--porcelain'], lead)
    .split('\n')
    .filter(line => line.startsWith('worktree '))
const SHELL_GONE = 'The shell process group and every tracked descendant were observed gone'

await within(refusalEnded.promise, 30000, 'the turn with the refused allocation to end')
await claim(
  'a contended write whose managed allocation is refused by a checkout filter on the target commit is reported as a failed tool call in the TUI and changes nothing: the binding is kept, neither the write nor the filter runs, and no worktree or pending operation is left',
  async () => {
    assert.deepEqual(workspaceHost.attachment.binding, bindingBeforeRefusal, 'the binding is kept')
    assert.equal(bindingBeforeRefusal.cwd, resolve(lead))
    assert.equal(workspaceHost.isParked(), false, 'the refusal does not park the host')
    assert.equal(resolve(runtime.cwd), resolve(lead))
    assert.ok(!existsSync(join(lead, 'filtered.txt')), 'the contested write never ran')
    assert.ok(!existsSync(filterMarker), 'no checkout filter ran')
    assert.deepEqual(worktrees(), [`worktree ${lead}`], 'no managed worktree was created')
    assert.deepEqual(
      (await lifecycle.inspect({})).flatMap(view => view.pending),
      [],
      'the refused allocation leaves no pending operation'
    )
    assert.deepEqual(persistedResult('filtered-write'), {
      isError: true,
      text: 'Workspace admission failed closed: Managed allocation is unavailable for filtered files; checkout filter effects are not controlled',
    })
  }
)

git(['rm', '--quiet', '.gitattributes'], lead)
git(['commit', '--quiet', '-m', 'real-authority fixture'], lead)
const leadCommit = git(['rev-parse', 'HEAD'], lead)
signal('READY_FOR_NEXT_CALL')

await within(finished.promise, 90000, 'scripted turns to finish')
signal('TURNS_FINISHED')

const { binding } = workspaceHost.attachment
const managed = binding.cwd
const managedUses = async () =>
  (await lifecycle.inspect({})).find(
    (view: WorkspaceView) => view.workspaceId === binding.workspaceId
  )?.uses ?? []

await claim(
  'the tool call after the refused allocation is admitted, and as a read beside a live writer it carries the writer warning in its tool result',
  () => {
    const read = persistedResult('contended-read')
    assert.equal(read.isError, false)
    assert.ok(
      read.text.endsWith(
        '\n[dev workspace] A writer owns this live checkout; files may change while you read. No stable snapshot is provided.'
      ),
      read.text
    )
  }
)
await claim(
  'a real contended native write is blocked, rebinds to an exact-commit managed worktree and is not replayed',
  () => {
    assert.notEqual(resolve(managed), resolve(lead), 'the contended write rebinds the conversation')
    assert.equal(git(['rev-parse', 'HEAD'], managed), leadCommit)
    assert.ok(!existsSync(join(lead, 'contended.txt')), 'the blocked write never ran')
    assert.ok(!existsSync(join(managed, 'contended.txt')), 'the blocked write was not replayed')
    assert.deepEqual(persistedResult('contended-native-write'), {
      isError: true,
      text: 'Workspace admission requires a host rebind: Another task owns or is using the requested checkout. The new detached worktree starts at the exact current commit; uncommitted and ignored files were not copied. The operation was not executed.',
    })
  }
)
await claim(
  'the lead bash tool runs through the workspace shell; its use ends only after a backgrounded descendant is observed gone',
  async () => {
    assert.equal(persistedResult('lead-shell').isError, false)
    assert.equal(readFileSync(join(managed, 'shell.txt'), 'utf8'), 'shell-ran')
    const shellUse = await waitFor('the lead shell use to settle', async () => {
      const use = (await managedUses()).find(
        item => item.effect === 'opaque' && item.execution?.taskKey === 'lead-shell'
      )
      return use?.stage === 'quiescent' ? use : undefined
    })
    assert.equal(shellUse.reason, SHELL_GONE)
    assert.equal(readFileSync(join(managed, lateMarker), 'utf8'), 'late')
  }
)
const nativeUses = (await managedUses()).filter(item => item.effect === 'native-file-write')
await claim(
  'lead native writes to distinct files in one batch each record their exact destination as a scoped use, started from inside the write and settled when Pi reports the call finished',
  () => {
    for (const [toolCallId, name, content] of [
      ['native-write', 'native.txt', 'native write\n'],
      ['second-native-write', 'second.txt', 'second write\n'],
    ] as const) {
      assert.equal(persistedResult(toolCallId).isError, false, toolCallId)
      assert.equal(readFileSync(join(managed, name), 'utf8'), content)
      const nativeUse = nativeUses.find(item => item.path === join(managed, name))
      assert.equal(nativeUse?.stage, 'quiescent', name)
      assert.equal(nativeUse?.reason, 'operation-completed:native-file-write', name)
    }
  }
)
await claim(
  'a lead native write to a file already being written under another case is refused, and the host settles its use before it starts',
  () => {
    const duplicate = persistedResult('duplicate-native-write')
    assert.equal(duplicate.isError, true)
    assert.match(duplicate.text, /still in flight/)
    const duplicateUse = nativeUses.find(item => item.path === join(managed, 'NATIVE.txt'))
    assert.equal(duplicateUse?.stage, 'quiescent')
    assert.equal(duplicateUse?.reason, 'operation-ended-before-start:native-file-write')
  }
)
await claim("a read beside the conversation's own writer carries no warning", () => {
  const read = persistedResult('own-read')
  assert.equal(read.isError, false)
  assert.ok(!read.text.includes('[dev workspace]'), read.text)
})
await claim('a tool without a verified workspace effect is refused without ending the turn', () => {
  const unverified = persistedResult('unverified-tool')
  assert.equal(unverified.isError, true)
  assert.match(unverified.text, /^Tool probe_unverified has no verified workspace effect in dev/)
  assert.ok(!existsSync(join(fixture, 'unverified-tool-ran')), 'the unverified tool never ran')
  assert.equal(providerCall, script.length, 'refusing the unverified tool did not end the turn')
})

const heldManager = pi.SessionManager.create(lead, sessionDir)
const heldReply = assistantMessage([{ type: 'text', text: 'held conversation' }], 'stop')
heldManager.appendMessage(heldReply)
const heldFile = heldManager.getSessionFile()
if (heldFile === undefined) throw new Error('Pi did not persist the held conversation')
const holder = await openLifecycle({ root: authorityRoot })
const held = await holder.attach({
  conversation: { sessionId: heldManager.getSessionId(), sessionFile: heldFile, dataHome },
  cwd: lead,
})
const keptConversation = (file: string) =>
  `The conversation file is unchanged and keeps its history: ${file}\nTo keep working, start a new conversation in an existing checkout: dev --cwd PATH`
await claim(
  'switching the TUI runtime to a conversation that another lifecycle keeps live is cancelled with a notice, leaving the session and host usable, instead of failing, which Pi treats as fatal',
  async () => {
    const sessionBeforeHeldSwitch = runtime.session.sessionManager.getSessionId()
    const noticesBefore = notices.length
    assert.deepEqual(await runtime.switchSession(heldFile), { cancelled: true })
    assert.equal(runtime.session.sessionManager.getSessionId(), sessionBeforeHeldSwitch)
    assert.equal(workspaceHost.isParked(), false, 'a refused switch leaves the host usable')
    assert.deepEqual(notices.slice(noticesBefore), [
      `The session was not switched: This conversation is open in another dev session; close it there first\n${keptConversation(heldFile)}`,
    ])
  }
)
await held.close()

const boundConversation = async (checkout: string, cwd: string) => {
  mkdir(cwd)
  writeFileSync(join(checkout, 'AGENTS.md'), 'real-authority probe: bound conversation\n')
  git(['init', '--quiet', '-b', 'main'], checkout)
  git(['config', 'user.email', 'real-authority@example.invalid'], checkout)
  git(['config', 'user.name', 'real authority probe'], checkout)
  git(['add', 'AGENTS.md'], checkout)
  git(['commit', '--quiet', '-m', 'bound conversation fixture'], checkout)
  const manager = pi.SessionManager.create(cwd, sessionDir)
  manager.appendMessage(heldReply)
  const file = manager.getSessionFile()
  if (file === undefined) throw new Error('Pi did not persist the bound conversation')
  const owner = await holder.attach({
    conversation: { sessionId: manager.getSessionId(), sessionFile: file, dataHome },
    cwd,
  })
  assert.equal(resolve(owner.binding.cwd), resolve(cwd))
  await owner.close()
  return file
}
const removed = join(fixture, 'projects', 'removed')
const removedFile = await boundConversation(removed, removed)
const nested = join(fixture, 'projects', 'nested')
const nestedCwd = join(nested, 'sub')
const nestedFile = await boundConversation(nested, nestedCwd)
await holder.close()
rmSync(removed, { recursive: true, force: true })
rmSync(nestedCwd, { recursive: true, force: true })
const removedBytes = readFileSync(removedFile)
const nestedBytes = readFileSync(nestedFile)
await claim(
  'switching the TUI runtime to a conversation whose workspace was removed is cancelled with a notice naming its unchanged file and the next safe action; the file stays byte-identical and the checkout is not recreated',
  async () => {
    const sessionBeforeRemovedSwitch = runtime.session.sessionManager.getSessionId()
    const noticesBefore = notices.length
    assert.deepEqual(await runtime.switchSession(removedFile), { cancelled: true })
    assert.equal(runtime.session.sessionManager.getSessionId(), sessionBeforeRemovedSwitch)
    assert.equal(workspaceHost.isParked(), false, 'a refused switch leaves the host usable')
    assert.deepEqual(notices.slice(noticesBefore), [
      `The session was not switched: The workspace bound to this conversation no longer exists and is not recreated: ${removed}\n${keptConversation(removedFile)}`,
    ])
    assert.deepEqual(readFileSync(removedFile), removedBytes, 'the conversation file is unchanged')
    assert.ok(!existsSync(removed), 'the removed checkout is not recreated')
  }
)
await claim(
  "switching the TUI runtime to a conversation whose bound working directory was removed from a checkout that remains is cancelled with the same notice, instead of the missing directory failing Pi's switch fatally",
  async () => {
    const sessionBeforeNestedSwitch = runtime.session.sessionManager.getSessionId()
    const noticesBefore = notices.length
    assert.deepEqual(await runtime.switchSession(nestedFile), { cancelled: true })
    assert.equal(runtime.session.sessionManager.getSessionId(), sessionBeforeNestedSwitch)
    assert.equal(workspaceHost.isParked(), false, 'a refused switch leaves the host usable')
    assert.deepEqual(notices.slice(noticesBefore), [
      `The session was not switched: The working directory bound to this conversation no longer exists and is not recreated: ${nestedCwd}\n${keptConversation(nestedFile)}`,
    ])
    assert.deepEqual(readFileSync(nestedFile), nestedBytes, 'the conversation file is unchanged')
    assert.ok(!existsSync(nestedCwd), 'the removed directory is not recreated')
  }
)

signal('READY_FOR_USER_BASH')
await claim(
  'a user ! command runs through the same workspace shell and Pi records it in history',
  async () => {
    await waitFor('the user shell command to run', async () =>
      existsSync(join(managed, 'user.txt')) ? true : undefined
    )
    assert.equal(readFileSync(join(managed, 'user.txt'), 'utf8'), 'user-bash')
    await waitFor('the user shell use to settle', async () => {
      const shells = (await managedUses()).filter(
        item => item.effect === 'opaque' && item.execution?.taskKey === 'lead-shell'
      )
      return shells.length === 2 && shells.every(item => item.stage === 'quiescent')
        ? true
        : undefined
    })
    const userBash = runtime.session.sessionManager
      .getEntries()
      .flatMap(entry =>
        entry.type === 'message' && entry.message.role === 'bashExecution'
          ? [{ command: entry.message.command, exitCode: entry.message.exitCode }]
          : []
      )
    assert.deepEqual(userBash, [{ command: 'printf user-bash > user.txt', exitCode: 0 }])
  }
)

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
await within(reloaded.promise, 60000, 'the /reload session restart')
await sleep(1500)
await claim(
  'a /reload typed in the TUI keeps a live lead shell family and its open use',
  async () => {
    assert.ok(alive(survivorPid), 'a reload keeps the live shell family')
    assert.notEqual(
      (await managedUses()).find(item => item.id === survivorUse.id)?.stage,
      'quiescent',
      'a reload keeps the live shell use open'
    )
  }
)

const hostTask = binding.taskId
if (hostTask === undefined) throw new Error('the rebound conversation carries a task')
await lifecycle.recordTarget(hostTask, { kind: 'local', ref: 'refs/heads/main' })
for (const entry of git(['ls-files', '--others', '-z'], managed).split('\0').filter(Boolean))
  rmSync(join(managed, entry), { force: true })
const workspaceEntries = () =>
  runtime.session.sessionManager
    .getEntries()
    .flatMap(entry =>
      entry.type === 'custom_message' && entry.customType === 'dev/workspace' ? [entry.content] : []
    )
    .map(content => (typeof content === 'string' ? content : JSON.stringify(content)))
process.stdout.write(`\nDEV_REAL_AUTHORITY_INPUTS ${JSON.stringify({ TASK_HOST: hostTask })}\n`)
signal('READY_FOR_CHECK')
await claim(
  "/workspace check of the TUI task shows its managed worktree as finished for the sweep, naming the conversation's own live shell as a use that ends when it quits, without parking the host or stopping anything",
  async () => {
    const shown = await waitFor('the check to be displayed', () =>
      workspaceEntries().find(content => content.includes('Release eligibility for exact task'))
    )
    assert.ok(shown.includes(`workspace ${binding.workspaceId} (managed)`), shown)
    assert.ok(shown.includes('sweep verdict: finished (no-residue)'), shown)
    assert.ok(shown.includes('eligibility: removable'), shown)
    assert.ok(shown.includes('lead-shell') && shown.includes('they end when it quits'), shown)
    assert.equal(workspaceHost.isParked(), false)
    assert.ok(alive(survivorPid), 'a check stops nothing')
  }
)
const confirmationsBeforeRelease = confirmations
signal('READY_FOR_OWN_RELEASE')
await claim(
  "/workspace release of the TUI's own task answers that quitting sweeps it, asks for no confirmation and stops nothing",
  async () => {
    const answer = await waitFor('the own-task answer', () =>
      workspaceEntries().find(content => content.includes('belongs to this conversation'))
    )
    assert.ok(answer.includes('/quit') && answer.includes('sweeps'), answer)
    assert.equal(confirmations, confirmationsBeforeRelease)
    assert.ok(alive(survivorPid), 'the answer stopped nothing')
    assert.ok(existsSync(managed))
    assert.equal(workspaceHost.isParked(), false, 'the TUI stays usable')
  }
)
workspaceHost.interceptQuit(true)
signal('READY_FOR_QUIT')
await within(
  Effect.runPromise(Deferred.await(workspaceHost.quitRequested)),
  90000,
  "the typed /quit to reach the host's dispose boundary"
)
await sleep(500)
await claim(
  "a typed /quit parks Pi's own exit at the host's dispose boundary with the runtime still undisposed",
  async () => {
    assert.ok(alive(survivorPid), 'nothing was disposed before the launcher takes over')
    assert.ok(existsSync(managed))
  }
)
await opened.close()
await claim(
  "once the runtime is disposed after the quit, the conversation's live shell family is stopped and its use settled",
  async () => {
    await waitFor('the live shell family to stop', () => (alive(survivorPid) ? undefined : true), {
      attempts: 20,
    })
    survivorStopped = true
    assert.ok(
      Date.now() - survivorLaunchedAt < (survivorSeconds - 10) * 1000,
      'the family was stopped, not left to finish on its own'
    )
    const stoppedUse = (await managedUses()).find(item => item.id === survivorUse.id)
    assert.equal(stoppedUse?.stage, 'quiescent', JSON.stringify(stoppedUse))
    assert.equal(stoppedUse?.reason, SHELL_GONE)
  }
)
await claim(
  'a quit sweep that never reports back exits 1 saying its outcome is unknown and pointing to inspect, not that nothing was released',
  async () => {
    process.exitCode = undefined
    const printed: string[] = []
    const { write } = process.stdout
    process.stdout.write = ((chunk: string | Uint8Array) => {
      printed.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    try {
      await Effect.runPromise(
        sweepAtQuit(
          {
            ...lifecycle.effect,
            sweep: () =>
              Effect.fail(
                new WorkspaceError({
                  outcome: 'unavailable',
                  message: 'Workspace worker acknowledgment was lost or timed out',
                })
              ),
          },
          {
            anchorWorkspaceId: binding.workspaceId,
            occupiedPaths: [fixture, initialSessionFile],
            detached: workspaceHost.isDetached(),
            proceed: () => true,
          }
        )
      )
    } finally {
      process.stdout.write = write
    }
    const text = printed.join('')
    assert.equal(process.exitCode, 1)
    assert.ok(text.includes('its outcome is unknown'), text)
    assert.ok(text.includes('dev workspace inspect'), text)
    assert.ok(!text.includes('nothing was released'), text)
    assert.ok(existsSync(managed), 'the stubbed sweep touched nothing')
  }
)
await claim(
  'the sweep at quit removes the finished managed worktree, prints the receipt with exit 0 and keeps the conversation file',
  async () => {
    process.exitCode = undefined
    await Effect.runPromise(
      sweepAtQuit(lifecycle.effect, {
        anchorWorkspaceId: binding.workspaceId,
        occupiedPaths: [fixture, initialSessionFile],
        detached: workspaceHost.isDetached(),
        proceed: () => true,
      })
    )
    assert.ok(!existsSync(managed), 'the managed worktree is gone')
    assert.deepEqual(worktrees(), [`worktree ${lead}`])
    assert.ok(existsSync(initialSessionFile), 'the conversation file is kept')
    assert.equal(process.exitCode, 0)
  }
)
await squatter.close()
await lifecycle.close()
assert.equal(runFailure, undefined)
await claim('no checkout filter ran at any allocation and no network access is attempted', () => {
  assert.ok(!existsSync(filterMarker), 'no checkout filter ran at any allocation')
  assert.equal(networkAttempts, 0)
})
const report = {
  fixture,
  leadCommit,
  managedWorkspace: binding.workspaceId,
  networkAttempts,
  checks: passed,
  limits: [
    'No power-loss or crash durability proof.',
    'A process that detaches into its own session escapes shell observation by design.',
  ],
}
process.stdout.write(`\nDEV_REAL_AUTHORITY_PROBE_PASSED ${JSON.stringify(report)}\n`)
