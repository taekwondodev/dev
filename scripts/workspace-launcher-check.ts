import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type * as Pi from '@earendil-works/pi-coding-agent'
import { makeWorkspaceLifecycle } from '../src/workspace-lifecycle.ts'

type SessionMessage = Parameters<Pi.SessionManager['appendMessage']>[0]

const devRoot = fileURLToPath(new URL('..', import.meta.url))
const pi: typeof Pi = await import(
  new URL('../node_modules/@earendil-works/pi-coding-agent/dist/index.js', import.meta.url).href
)
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'dev-workspace-launcher-check-')))
const checks: string[] = []
try {
  const repo = join(sandbox, 'repo')
  const dataHome = join(sandbox, 'data')
  const authorityRoot = join(sandbox, 'authority')
  mkdirSync(repo)
  mkdirSync(dataHome, { mode: 0o700 })
  const git = (args: readonly string[]) => execFileSync('git', [...args], { cwd: repo })
  git(['init', '--quiet', '-b', 'main'])
  writeFileSync(join(repo, 'tracked.txt'), 'launcher fixture\n')
  git(['add', 'tracked.txt'])
  git([
    '-c',
    'user.name=Launcher Fixture',
    '-c',
    'user.email=launcher@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ])

  const sessions = pi.SessionManager.create(repo, join(dataHome, 'sessions'))
  const user: SessionMessage = {
    role: 'user',
    content: 'bound conversation',
    timestamp: Date.now(),
  }
  const assistant: SessionMessage = {
    role: 'assistant',
    content: [{ type: 'text', text: 'history that must survive' }],
    api: 'openai-completions',
    provider: 'fixture',
    model: 'fixture',
    stopReason: 'stop',
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }
  sessions.appendMessage(user)
  sessions.appendMessage(assistant)
  const sessionFile = sessions.getSessionFile()
  if (sessionFile === undefined || !existsSync(sessionFile))
    throw new Error('Pi did not persist the fixture conversation')
  const conversation = { sessionId: sessions.getSessionId(), sessionFile, dataHome }

  const lifecycle = makeWorkspaceLifecycle({ root: authorityRoot })
  const allocator = await lifecycle.attach({
    conversation: {
      sessionId: 'launcher-allocator',
      sessionFile: join(sandbox, 'allocator.jsonl'),
      dataHome,
    },
    cwd: repo,
  })
  const allocated = await allocator.authorize({ access: 'write', delegated: true })
  if (allocated.kind !== 'ready' || allocated.grant.taskId === undefined)
    throw new Error('The fixture could not allocate a managed workspace')
  await allocator.close()
  const bound = await lifecycle.attach({ conversation, cwd: repo })
  await bound.handoff(
    await bound.select({
      taskId: allocated.grant.taskId,
      workspaceId: allocated.grant.workspaceId,
    }),
    async () => 'confirmed'
  )
  assert.equal(bound.binding.workspaceId, allocated.grant.workspaceId)
  await bound.close()

  const switchSessions = pi.SessionManager.create(repo, join(dataHome, 'sessions'))
  switchSessions.appendMessage(user)
  switchSessions.appendMessage(assistant)
  const switchFile = switchSessions.getSessionFile()
  if (switchFile === undefined || !existsSync(switchFile))
    throw new Error('Pi did not persist the switching conversation')
  const switchConversation = {
    sessionId: switchSessions.getSessionId(),
    sessionFile: switchFile,
    dataHome,
  }
  const switchAllocator = await lifecycle.attach({
    conversation: {
      sessionId: 'launcher-switch-allocator',
      sessionFile: join(sandbox, 'switch-allocator.jsonl'),
      dataHome,
    },
    cwd: repo,
  })
  const switchTarget = await switchAllocator.authorize({ access: 'write', delegated: true })
  if (switchTarget.kind !== 'ready' || switchTarget.grant.taskId === undefined)
    throw new Error('The fixture could not allocate a switch target')
  await switchAllocator.close()
  const switching = await lifecycle.attach({ conversation: switchConversation, cwd: repo })
  const switchSource = switching.binding.workspaceId
  const unstarted = await switching.select({
    taskId: switchTarget.grant.taskId,
    workspaceId: switchTarget.grant.workspaceId,
  })
  // The host dies before it acts on the switch.
  await lifecycle.close()
  rmSync(allocated.grant.checkout, { recursive: true, force: true })
  const historyBefore = createHash('sha256').update(readFileSync(sessionFile)).digest('hex')

  // With STOP_AFTER_ATTACH the injected lifecycle reports what the launcher asked of the
  // authority and stops it there, before a Pi runtime would load the global agent directory.
  const driver = `
    import { NodeRuntime } from '@effect/platform-node'
    import { launch } from ${JSON.stringify(new URL('../src/launcher.ts', import.meta.url).href)}
    import { makeWorkspaceLifecycle } from ${JSON.stringify(new URL('../src/workspace-lifecycle.ts', import.meta.url).href)}
    const open = () => {
      const lifecycle = makeWorkspaceLifecycle({ root: ${JSON.stringify(authorityRoot)} })
      if (process.env.STOP_AFTER_ATTACH !== '1') return lifecycle
      return new Proxy(lifecycle, {
        get(target, property) {
          if (property === 'attach')
            return async input => {
              const attachment = await target.attach(input)
              process.stdout.write(JSON.stringify({
                withdrawUnstartedSwitch: input.withdrawUnstartedSwitch,
                workspaceId: attachment.binding.workspaceId,
              }) + '\\n')
              await attachment.close()
              throw new Error('launcher check stops after attach')
            }
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    }
    NodeRuntime.runMain(launch(process.argv.slice(1), { workspaceLifecycle: open }), {
      disableErrorReporting: true,
    })
  `
  const runLauncher = (resumed: string, stopAfterAttach: boolean) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>(resolveRun => {
      execFile(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          driver,
          '--',
          '--resume',
          resumed,
          '--data-home',
          dataHome,
          '--profile',
          'general',
        ],
        {
          cwd: devRoot,
          env: {
            ...process.env,
            PI_OFFLINE: '1',
            ...(stopAfterAttach ? { STOP_AFTER_ATTACH: '1' } : {}),
          },
          timeout: 60000,
        },
        (error, stdout, stderr) =>
          resolveRun({
            code: error === null ? 0 : typeof error.code === 'number' ? error.code : null,
            stdout,
            stderr,
          })
      )
    })
  const outcome = await runLauncher(sessionFile, false)
  assert.equal(outcome.code, 1, outcome.stderr)
  assert.match(outcome.stderr, /no longer exists and is not recreated/)
  assert.ok(outcome.stderr.includes(sessionFile), outcome.stderr)
  assert.match(outcome.stderr, /dev --cwd PATH/)
  assert.equal(
    createHash('sha256').update(readFileSync(sessionFile)).digest('hex'),
    historyBefore,
    'the conversation file and its history are unchanged'
  )
  assert.ok(!existsSync(allocated.grant.checkout), 'the removed workspace was not recreated')
  checks.push(
    'dev --resume of a conversation whose workspace was removed exits 1, names the unchanged conversation file and points to dev --cwd PATH, without recreating the workspace'
  )

  const withdrawal = await runLauncher(switchFile, true)
  assert.equal(withdrawal.code, 1, withdrawal.stderr)
  assert.match(withdrawal.stderr, /launcher check stops after attach/)
  assert.deepEqual(JSON.parse(withdrawal.stdout.trim().split('\n').at(-1) ?? '{}'), {
    withdrawUnstartedSwitch: true,
    workspaceId: switchSource,
  })
  const afterWithdrawal = makeWorkspaceLifecycle({ root: authorityRoot })
  try {
    assert.notEqual(
      (await afterWithdrawal.inspect({}))
        .flatMap(view => view.pending)
        .find(item => item.id === unstarted.operationId)?.stage,
      'intent'
    )
    const reopened = await afterWithdrawal.attach({ conversation: switchConversation, cwd: repo })
    assert.equal(reopened.binding.workspaceId, switchSource, 'the withdrawal was durable')
    await reopened.close()
  } finally {
    await afterWithdrawal.close()
  }
  checks.push(
    'dev --resume claims the conversation and asks the authority to withdraw its switch that never reached the host, which returns it durably to the last confirmed workspace'
  )
  console.log(
    JSON.stringify(
      {
        checks,
        limitation:
          'The launcher runs with a lifecycle injected on a temporary authority root; the fixed per-account root is not touched.',
      },
      null,
      2
    )
  )
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}
