import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import {
  WorkspaceError,
  type WorkspaceAttachment,
  type WorkspaceExecution,
  type WorkspaceExecutionFact,
  type WorkspaceGrant,
  type WorkspaceLifecycle,
} from '../src/workspace-domain.ts'
import { unsupportedAuthorityStorage } from '../src/workspace-engine.ts'
import { makeWorkspaceLifecycle } from '../src/workspace-lifecycle.ts'

let captureNextWorker = false
let capturedWorker: Worker | undefined
let dropNextRpcAckFor: 'authorize' | 'report-execution' | undefined
const lostAckIds = new WeakMap<Worker, number>()
const originalWorkerPostMessage = Worker.prototype.postMessage as (...args: unknown[]) => unknown
Object.defineProperty(Worker.prototype, 'postMessage', {
  configurable: true,
  value: function (this: Worker, value: unknown, ...rest: unknown[]) {
    if (typeof value === 'object' && value !== null && 'id' in value) {
      const envelope = value as { id?: unknown; request?: { op?: unknown } }
      if (captureNextWorker && typeof envelope.id === 'number' && envelope.request !== undefined) {
        // oxlint-disable-next-line typescript/no-this-alias
        capturedWorker = this
        captureNextWorker = false
      }
      if (
        dropNextRpcAckFor !== undefined &&
        typeof envelope.id === 'number' &&
        envelope.request?.op === dropNextRpcAckFor
      ) {
        lostAckIds.set(this, envelope.id)
        dropNextRpcAckFor = undefined
      }
    }
    return Reflect.apply(originalWorkerPostMessage, this, [value, ...rest])
  },
})
const originalEventEmit = EventEmitter.prototype.emit as (...args: unknown[]) => unknown
Object.defineProperty(EventEmitter.prototype, 'emit', {
  configurable: true,
  value: function (this: EventEmitter, eventName: string | symbol, ...args: unknown[]) {
    if (this instanceof Worker && eventName === 'message') {
      const payload = args[0]
      if (typeof payload === 'object' && payload !== null && 'id' in payload) {
        const response = payload as { id?: unknown; ok?: unknown }
        if (lostAckIds.get(this) === response.id && response.ok === true) {
          lostAckIds.delete(this)
          void this.terminate()
          return true
        }
      }
    }
    return Reflect.apply(originalEventEmit, this, [eventName, ...args]) as boolean
  },
})

const inside = (parent: string, path: string) => {
  const offset = relative(parent, path)
  return offset === '' || (!offset.startsWith('..') && !isAbsolute(offset))
}

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'dev-workspace-authority-check-')))
const checks: string[] = []
const repo = join(sandbox, 'repo')
const root = join(sandbox, 'authority')
mkdirSync(repo)
const git = (args: readonly string[], cwd = repo): string => {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout.trim()
}
const conversation = (name: string) => {
  const dataHome = join(sandbox, `data-${name}`)
  mkdirSync(dataHome, { recursive: true })
  const sessionFile = join(dataHome, 'session.jsonl')
  writeFileSync(sessionFile, '{}\n', { mode: 0o600 })
  return { sessionId: `session-${name}`, sessionFile, dataHome }
}
const expectWorkspaceError = async (promise: Promise<unknown>, outcomes: readonly string[]) => {
  await assert.rejects(
    promise,
    error => error instanceof WorkspaceError && outcomes.includes(error.outcome)
  )
}
const switchStage = async (reader: WorkspaceLifecycle, operationId: string) =>
  (await reader.inspect({})).flatMap(view => view.pending).find(item => item.id === operationId)
    ?.stage
const runChild = (code: string): Promise<string> =>
  new Promise((resolveOutput, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
    })
    child.once('error', reject)
    child.once('close', codeValue =>
      codeValue === 0
        ? resolveOutput(stdout.trim())
        : reject(new Error(`Child failed (${codeValue}): ${stderr}`))
    )
  })

try {
  git(['init', '--quiet', '-b', 'main'])
  git(['config', 'user.name', 'Workspace Authority Test'])
  git(['config', 'user.email', 'workspace-authority@example.invalid'])
  writeFileSync(join(repo, 'tracked.txt'), 'committed fixture\n')
  writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n')
  git(['add', 'tracked.txt', '.gitignore'])
  git(['commit', '--quiet', '-m', 'fixture'])
  const commit = git(['rev-parse', 'HEAD'])

  const lifecycle = makeWorkspaceLifecycle({ root })
  const first = await lifecycle.attach({ conversation: conversation('first'), cwd: repo })
  const writerResult = await first.authorize({ access: 'write' })
  assert.equal(writerResult.kind, 'ready')
  const firstGrant = writerResult.grant
  assert.equal(firstGrant.origin, 'pre-existing')
  assert.equal(firstGrant.checkout, realpathSync(repo))
  assert.ok(firstGrant.taskId && firstGrant.workspaceId && firstGrant.acquisitionId)
  writeFileSync(join(repo, 'tracked.txt'), 'staged working-tree edit\n')
  git(['add', 'tracked.txt'])
  writeFileSync(join(repo, 'untracked.txt'), 'untracked source data\n')
  writeFileSync(join(repo, 'ignored.txt'), 'ignored source data\n')

  const moduleUrl = new URL('../src/workspace-lifecycle.ts', import.meta.url).href
  const childReaderConversation = conversation('subprocess-reader')
  const childWriterConversation = conversation('subprocess-writer')
  const subprocessEvidence = JSON.parse(
    await runChild(`
    import { makeWorkspaceLifecycle } from ${JSON.stringify(moduleUrl)}
    const lifecycle = makeWorkspaceLifecycle({ root: ${JSON.stringify(root)} })
    const reader = await lifecycle.attach({ conversation: ${JSON.stringify(childReaderConversation)}, cwd: ${JSON.stringify(repo)} })
    const read = await reader.authorize({ access: 'read' })
    const attemptedWriter = await lifecycle.attach({ conversation: ${JSON.stringify(childWriterConversation)}, cwd: ${JSON.stringify(repo)},
      selection: { taskId: ${JSON.stringify(firstGrant.taskId)}, workspaceId: ${JSON.stringify(firstGrant.workspaceId)} } })
      .then(async attachment => {
        try { await attachment.authorize({ access: 'write' }); return 'unexpected-ready' }
        catch (error) { return error.outcome ?? 'untyped-error' }
        finally { await attachment.close() }
      }, error => error.outcome ?? 'untyped-error')
    await reader.close()
    await lifecycle.close()
    console.log(JSON.stringify({ readerWarning: read.warning, attemptedWriter }))
  `)
  ) as { readerWarning?: string; attemptedWriter: string }
  assert.match(subprocessEvidence.readerWarning ?? '', /writer owns this live checkout/)
  assert.equal(subprocessEvidence.attemptedWriter, 'blocked')
  checks.push(
    'a reader in a second Node process coexists with the writer and is warned; a same-task duplicate writer is blocked'
  )
  const activeContenderConversation = conversation('normal-active-contender')
  const activeContender = await lifecycle.attach({
    conversation: activeContenderConversation,
    cwd: repo,
  })
  const activeDecision = await activeContender.authorize({ access: 'write' })
  if (activeDecision.kind !== 'rebind') throw new Error('Contended writer was not isolated')
  const activeTarget = activeDecision.handoff.target
  assert.equal(activeTarget.origin, 'managed')
  assert.equal(git(['rev-parse', 'HEAD'], activeTarget.checkout), commit)
  let callbackSawBinding = false
  await activeContender.handoff(activeDecision.handoff, async target => {
    const reentrant = await lifecycle.attach({
      conversation: activeContenderConversation,
      cwd: target.checkout,
      selection: { taskId: target.taskId!, workspaceId: target.workspaceId },
    })
    callbackSawBinding = reentrant.binding.workspaceId === target.workspaceId
    await reentrant.close()
    return 'confirmed'
  })
  assert.equal(callbackSawBinding, true)
  assert.equal(activeContender.binding.workspaceId, activeTarget.workspaceId)
  assert.equal(activeContender.binding.cwd, activeTarget.checkout)
  assert.equal(readFileSync(join(repo, 'tracked.txt'), 'utf8'), 'staged working-tree edit\n')
  assert.equal(
    readFileSync(join(activeTarget.checkout, 'tracked.txt'), 'utf8'),
    'committed fixture\n'
  )
  assert.equal(readFileSync(join(repo, 'untracked.txt'), 'utf8'), 'untracked source data\n')
  assert.equal(readFileSync(join(repo, 'ignored.txt'), 'utf8'), 'ignored source data\n')
  assert.equal(existsSync(join(activeTarget.checkout, 'untracked.txt')), false)
  assert.equal(existsSync(join(activeTarget.checkout, 'ignored.txt')), false)
  const dirtySourceStatus = git(['status', '--short', '--ignored'], repo)
  assert.match(dirtySourceStatus, /M  tracked\.txt/)
  assert.match(dirtySourceStatus, /\?\? untracked\.txt/)
  assert.match(dirtySourceStatus, /!! ignored\.txt/)
  await expectWorkspaceError(
    lifecycle.validate({ ...firstGrant, workspaceId: 'not-a-uuid' } as unknown as WorkspaceGrant),
    ['invalid']
  )
  checks.push(
    'an active foreign writer isolates a contender into an exact-HEAD worktree without transferring staged, untracked or ignored data; the host callback can reenter attach'
  )

  const concurrentRepo = join(sandbox, 'concurrent-repo')
  mkdirSync(concurrentRepo)
  git(['init', '--quiet', '-b', 'main'], concurrentRepo)
  git(['config', 'user.name', 'Concurrent Provision Test'], concurrentRepo)
  git(['config', 'user.email', 'concurrent@example.invalid'], concurrentRepo)
  writeFileSync(join(concurrentRepo, 'file.txt'), 'fixture\n')
  git(['add', 'file.txt'], concurrentRepo)
  git(['commit', '--quiet', '-m', 'fixture'], concurrentRepo)
  const provisionProbe = (name: string) => {
    const conversationValue = conversation(name)
    return runChild(`
      import { makeWorkspaceLifecycle } from ${JSON.stringify(moduleUrl)}
      const lifecycle = makeWorkspaceLifecycle({ root: ${JSON.stringify(root)} })
      try {
        const attachment = await lifecycle.attach({ conversation: ${JSON.stringify(conversationValue)}, cwd: ${JSON.stringify(concurrentRepo)} })
        const result = await attachment.authorize({ access: 'read' })
        await attachment.close()
        await lifecycle.close()
        console.log(JSON.stringify({ outcome: 'ready', repositoryId: result.grant.repositoryId, workspaceId: result.grant.workspaceId }))
      } catch (error) {
        await lifecycle.close()
        if (error.outcome !== 'blocked') throw error
        console.log(JSON.stringify({ outcome: 'blocked' }))
      }
    `).then(
      value =>
        JSON.parse(value) as {
          outcome: 'ready' | 'blocked'
          repositoryId?: string
          workspaceId?: string
        }
    )
  }
  let provisioned = await Promise.all([
    provisionProbe('provision-one'),
    provisionProbe('provision-two'),
  ])
  assert.ok(provisioned.some(result => result.outcome === 'ready'))
  if (provisioned.some(result => result.outcome === 'blocked')) {
    const retryIndex = provisioned.findIndex(result => result.outcome === 'blocked')
    const name = retryIndex === 0 ? 'provision-one' : 'provision-two'
    provisioned[retryIndex] = await provisionProbe(name)
  }
  assert.equal(provisioned[0]?.outcome, 'ready')
  assert.equal(provisioned[1]?.outcome, 'ready')
  assert.equal(provisioned[1]?.repositoryId, provisioned[0]?.repositoryId)
  assert.equal(provisioned[0]?.workspaceId, provisioned[1]?.workspaceId)
  checks.push('simultaneous cross-process repository provisioning converges on one identity')

  const pausedCommit = git(['rev-parse', 'HEAD'], concurrentRepo)
  const pausedOwner = await lifecycle.attach({
    conversation: conversation('paused-owner'),
    cwd: concurrentRepo,
  })
  const pausedOwned = await pausedOwner.authorize({ access: 'write' })
  assert.equal(pausedOwned.kind, 'ready')
  await pausedOwner.close()
  const pausedContender = await lifecycle.attach({
    conversation: conversation('paused-contender'),
    cwd: concurrentRepo,
  })
  const pausedDecision = await pausedContender.authorize({ access: 'write' })
  if (pausedDecision.kind !== 'rebind') throw new Error('Paused reservation was not isolated')
  assert.equal(pausedDecision.handoff.target.origin, 'managed')
  assert.equal(git(['rev-parse', 'HEAD'], pausedDecision.handoff.target.checkout), pausedCommit)
  await pausedContender.handoff(pausedDecision.handoff, async () => 'confirmed')
  assert.equal(pausedContender.binding.workspaceId, pausedDecision.handoff.target.workspaceId)
  await pausedContender.close()
  checks.push('a paused foreign reservation isolates a contender into an exact-HEAD worktree')

  const readerOne = await lifecycle.attach({ conversation: conversation('reader-one'), cwd: repo })
  const readerOneResult = await readerOne.authorize({ access: 'read' })
  assert.equal(readerOneResult.kind, 'ready')
  assert.match(readerOneResult.warning ?? '', /writer owns this live checkout/)
  const readerTwo = await lifecycle.attach({ conversation: conversation('reader-two'), cwd: repo })
  const readerTwoResult = await readerTwo.authorize({ access: 'read' })
  assert.equal(readerTwoResult.kind, 'ready')

  const delegated = await lifecycle.attach({ conversation: conversation('delegated'), cwd: repo })
  const delegatedResult = await delegated.authorize({ access: 'write', delegated: true })
  assert.equal(delegatedResult.kind, 'ready')
  assert.equal(delegatedResult.grant.origin, 'managed')
  assert.notEqual(delegatedResult.grant.checkout, firstGrant.checkout)
  assert.equal(git(['rev-parse', 'HEAD'], delegatedResult.grant.checkout), commit)
  assert.notEqual(delegatedResult.grant.workspaceId, firstGrant.workspaceId)
  const secondDelegatedResult = await delegated.authorize({ access: 'write', delegated: true })
  assert.equal(secondDelegatedResult.kind, 'ready')
  assert.notEqual(secondDelegatedResult.grant.workspaceId, delegatedResult.grant.workspaceId)
  assert.equal(git(['rev-parse', 'HEAD'], secondDelegatedResult.grant.checkout), commit)
  checks.push(
    'readers share the live checkout; each delegated writer gets a distinct detached exact-commit worktree'
  )

  const isolatedRoot = makeWorkspaceLifecycle({ root: join(sandbox, 'isolated-authority') })
  assert.deepEqual(await isolatedRoot.inspect({}), [])
  const isolatedAttachment = await isolatedRoot.attach({
    conversation: conversation('isolated-root'),
    cwd: repo,
  })
  const isolatedRead = await isolatedAttachment.authorize({ access: 'read' })
  assert.equal(isolatedRead.kind, 'ready')
  assert.notEqual(isolatedRead.grant.repositoryId, firstGrant.repositoryId)
  const isolatedWrite = await isolatedAttachment.authorize({ access: 'write' })
  assert.equal(isolatedWrite.kind, 'ready')
  const isolatedExecution = (attemptId: string) => ({
    sessionId: 'isolated-session',
    taskKey: 'isolated-task',
    attemptId,
    generation: attemptId,
    logs: join(sandbox, `${attemptId}.log`),
  })
  const failedSpawn = await isolatedAttachment.authorize({
    access: 'write',
    execution: isolatedExecution('failed-spawn'),
  })
  assert.equal(failedSpawn.kind, 'ready')
  assert.equal(failedSpawn.grant.acquisitionId, isolatedWrite.grant.acquisitionId)
  await isolatedAttachment.reportExecution(failedSpawn.grant, {
    kind: 'launch-failed',
    reason: 'fork error',
  })
  const controlled = await isolatedAttachment.authorize({
    access: 'write',
    execution: isolatedExecution('controlled-exit'),
  })
  assert.equal(controlled.kind, 'ready')
  await isolatedAttachment.reportExecution(controlled.grant, {
    kind: 'launch-intent',
    execution: isolatedExecution('controlled-exit'),
  })
  await isolatedAttachment.reportExecution(controlled.grant, {
    kind: 'spawned',
    process: { pid: 41002, parent: 40000, group: 41002, birth: 'fixture-birth-2' },
  })
  await isolatedAttachment.reportExecution(controlled.grant, { kind: 'started' })
  await expectWorkspaceError(
    isolatedAttachment.reportExecution(controlled.grant, {
      kind: 'quiescent',
      reason: 'process exited, family never observed',
    }),
    ['review-required']
  )
  await isolatedAttachment.reportExecution(controlled.grant, {
    kind: 'observed',
    processes: [{ pid: 41004, parent: 41002, group: 41002, birth: 'fixture-descendant' }],
  })
  await expectWorkspaceError(
    isolatedAttachment.reportExecution(controlled.grant, {
      kind: 'quiescent',
      reason: 'a descendant was still observed',
    }),
    ['review-required']
  )
  await isolatedAttachment.reportExecution(controlled.grant, { kind: 'observed', processes: [] })
  await isolatedAttachment.reportExecution(controlled.grant, {
    kind: 'quiescent',
    reason: 'process family observed gone',
  })
  const settled = (await isolatedRoot.inspect({ taskId: isolatedWrite.grant.taskId })).flatMap(
    view => view.uses
  )
  assert.equal(settled.find(use => use.id === failedSpawn.grant.useId)?.stage, 'quiescent')
  assert.equal(settled.find(use => use.id === controlled.grant.useId)?.stage, 'quiescent')
  const uncertainAtClose = await isolatedAttachment.authorize({
    access: 'write',
    execution: isolatedExecution('host-close'),
  })
  assert.equal(uncertainAtClose.kind, 'ready')
  await isolatedAttachment.reportExecution(uncertainAtClose.grant, {
    kind: 'launch-intent',
    execution: isolatedExecution('host-close'),
  })
  await isolatedAttachment.reportExecution(uncertainAtClose.grant, {
    kind: 'spawned',
    process: { pid: 41003, parent: 40000, group: 41003, birth: 'fixture-birth-3' },
  })
  await isolatedAttachment.reportExecution(uncertainAtClose.grant, { kind: 'started' })
  await isolatedAttachment.close()
  const isolatedObservation = await isolatedRoot.inspect({ taskId: isolatedWrite.grant.taskId })
  assert.ok(isolatedObservation.some(view => view.uses.some(use => use.stage === 'unknown')))
  await isolatedRoot.close()
  checks.push(
    'a process use settles only when never released or after an observed empty family; a started use closed by its host is recorded unknown'
  )
  const isolatedAuthorityPath = join(sandbox, 'isolated-authority')
  chmodSync(isolatedAuthorityPath, 0o755)
  const unsafeAuthority = makeWorkspaceLifecycle({ root: isolatedAuthorityPath })
  await expectWorkspaceError(unsafeAuthority.inspect({}), ['unavailable'])
  await unsafeAuthority.close()
  const authorityAlias = join(sandbox, 'authority-symlink')
  symlinkSync(isolatedAuthorityPath, authorityAlias, 'dir')
  const aliasInspector = makeWorkspaceLifecycle({ root: authorityAlias })
  await expectWorkspaceError(aliasInspector.inspect({}), ['unavailable'])
  await aliasInspector.close()
  checks.push('non-private and symlinked authority roots are rejected')
  const home = '/Users/fixture'
  const mountTable = [
    '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
    '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse)',
    '//fixture@server/share on /Volumes/Shared Work (smbfs, nodev, nosuid, mounted by fixture)',
    '/dev/disk9s1 on /Volumes/USB (exfat, local, nodev, nosuid, noowners)',
  ].join('\n')
  const storage = (path: string) => unsupportedAuthorityStorage({ path, home, mountTable })
  assert.equal(storage(`${home}/Library/Application Support/dev/workspace-authority`), undefined)
  assert.match(
    storage(`${home}/Library/Mobile Documents/com~apple~CloudDocs/a`) ?? '',
    /synchronized/
  )
  assert.match(storage(`${home}/Library/CloudStorage/Dropbox/authority`) ?? '', /synchronized/)
  assert.match(storage('/Volumes/Shared Work/authority') ?? '', /local storage.*smbfs/)
  assert.match(storage('/Volumes/USB/authority') ?? '', /does not support exfat/)
  assert.match(
    unsupportedAuthorityStorage({ path: '/private/tmp/a', home, mountTable: '' }) ?? '',
    /Cannot identify/
  )
  checks.push(
    'known unsupported authority storage is refused: synchronized folders, network mounts and non-APFS/HFS volumes'
  )

  const execution = {
    sessionId: 'session-first',
    taskKey: 'task-first',
    attemptId: 'attempt-1',
    generation: 'generation-1',
    logs: join(sandbox, 'logs-first'),
  }
  const executionResult = await first.authorize({ access: 'write', execution })
  assert.equal(executionResult.kind, 'ready')
  const executionGrant = executionResult.grant
  assert.notEqual(executionGrant.useId, firstGrant.useId)
  assert.equal(executionGrant.acquisitionId, firstGrant.acquisitionId)
  await lifecycle.validate(executionGrant)
  await expectWorkspaceError(lifecycle.validate({ ...executionGrant, cwd: sandbox }), [
    'review-required',
  ])
  await first
    .reportExecution(executionGrant, { kind: 'surprise' } as unknown as WorkspaceExecutionFact)
    .then(
      () => {
        throw new Error('Invalid execution fact unexpectedly succeeded')
      },
      error => {
        assert.ok(error instanceof WorkspaceError)
        assert.equal(error.outcome, 'invalid')
      }
    )
  await first.reportExecution(executionGrant, { kind: 'launch-intent', execution })
  await first.reportExecution(executionGrant, {
    kind: 'spawned',
    process: { pid: 41001, parent: 40000, group: 41001, birth: 'fixture-birth-1' },
  })
  await first.reportExecution(executionGrant, { kind: 'started' })
  await first.reportExecution(executionGrant, {
    kind: 'unknown',
    reason: 'observation-lost',
  })
  await expectWorkspaceError(
    first.reportExecution(executionGrant, { kind: 'observed', processes: [] }),
    ['review-required']
  )
  await expectWorkspaceError(
    first.reportExecution(executionGrant, { kind: 'quiescent', reason: 'empty-process-list' }),
    ['review-required']
  )
  checks.push('an unknown process use absorbs every later observation and quiescence report')

  const beforeClose = await lifecycle.inspect({ taskId: firstGrant.taskId })
  assert.ok(
    beforeClose.some(
      view => view.workspaceId === firstGrant.workspaceId && view.outcome === 'blocked'
    )
  )
  const unresolvedContender = await lifecycle.attach({
    conversation: conversation('uncertain-effect-contender'),
    cwd: repo,
  })
  const unresolvedDecision = await unresolvedContender.authorize({ access: 'write' })
  if (unresolvedDecision.kind !== 'rebind')
    throw new Error('A writer contending with an unknown use was not isolated')
  assert.equal(git(['rev-parse', 'HEAD'], unresolvedDecision.handoff.target.checkout), commit)
  await unresolvedContender.handoff(unresolvedDecision.handoff, async () => 'cancelled')
  await unresolvedContender.close()
  assert.deepEqual(await lifecycle.inspect({ taskId: firstGrant.taskId }), beforeClose)
  checks.push(
    'an unknown use blocks its checkout, isolating a contender instead of admitting it; inspection is read-only'
  )
  await Promise.all([
    first.close(),
    readerOne.close(),
    readerTwo.close(),
    delegated.close(),
    activeContender.close(),
  ])
  await lifecycle.close()

  const reopened = makeWorkspaceLifecycle({ root })
  const afterRestart = await reopened.inspect({ taskId: firstGrant.taskId })
  assert.ok(
    afterRestart.some(
      view => view.workspaceId === firstGrant.workspaceId && view.outcome === 'blocked'
    )
  )
  const retained = await reopened.inspect({ taskId: delegatedResult.grant.taskId })
  assert.ok(
    retained.some(
      view =>
        view.workspaceId === delegatedResult.grant.workspaceId &&
        view.outcome === 'preserved-for-resume'
    )
  )
  const freshSession = await reopened.attach({
    conversation: conversation('fresh-session'),
    cwd: repo,
  })
  assert.equal(freshSession.binding.workspaceId, firstGrant.workspaceId)
  assert.notEqual(freshSession.binding.workspaceId, delegatedResult.grant.workspaceId)
  await freshSession.close()
  await expectWorkspaceError(
    reopened.attach({
      conversation: conversation('first'),
      cwd: repo,
      selection: { taskId: firstGrant.taskId!, workspaceId: firstGrant.workspaceId },
    }),
    ['blocked']
  )
  const resumed = await reopened.attach({
    conversation: conversation('delegated'),
    cwd: repo,
    selection: {
      taskId: delegatedResult.grant.taskId!,
      workspaceId: delegatedResult.grant.workspaceId,
    },
  })
  const resumedResult = await resumed.authorize({ access: 'write' })
  assert.equal(resumedResult.kind, 'ready')
  assert.equal(resumedResult.grant.workspaceId, delegatedResult.grant.workspaceId)
  assert.equal(resumedResult.grant.checkout, delegatedResult.grant.checkout)
  assert.notEqual(resumedResult.grant.acquisitionId, delegatedResult.grant.acquisitionId)
  await expectWorkspaceError(reopened.validate(delegatedResult.grant), ['review-required'])
  await resumed.close()
  const handoffSession = await reopened.attach({
    conversation: conversation('handoff-session'),
    cwd: repo,
  })
  const transition = await handoffSession.select({
    taskId: delegatedResult.grant.taskId!,
    workspaceId: delegatedResult.grant.workspaceId,
  })
  await handoffSession.close()
  const reopenedHandoff = await reopened.attach({
    conversation: conversation('handoff-session'),
    cwd: transition.target.checkout,
    selection: { taskId: transition.target.taskId!, workspaceId: transition.target.workspaceId },
  })
  assert.equal(reopenedHandoff.binding.workspaceId, transition.target.workspaceId)
  await reopenedHandoff.handoff(transition, async () => 'confirmed')
  assert.equal(reopenedHandoff.binding.workspaceId, delegatedResult.grant.workspaceId)
  await reopenedHandoff.close()
  assert.equal((await reopened.inspect({})).filter(view => view.origin === 'managed').length, 5)
  await reopened.close()
  checks.push(
    'uncertainty and reservations survive close/reopen; a new conversation does not auto-select a task; resume requires an exact selection and a fresh acquisition; a pending handoff reopens only at its target'
  )

  const corruptLifecycle = makeWorkspaceLifecycle({ root: join(sandbox, 'corrupt-authority') })
  const corruptAttachment = await corruptLifecycle.attach({
    conversation: conversation('corrupt'),
    cwd: repo,
  })
  const corruptResult = await corruptAttachment.authorize({ access: 'read' })
  assert.equal(corruptResult.kind, 'ready')
  const shardPath = join(
    sandbox,
    'corrupt-authority',
    'repos',
    corruptResult.grant.repositoryId,
    'records.sqlite'
  )
  await corruptAttachment.close()
  await corruptLifecycle.close()
  const shard = new DatabaseSync(shardPath)
  let originalUsePayload = ''
  try {
    const payload = shard
      .prepare('SELECT payload FROM uses WHERE id=?')
      .get(corruptResult.grant.useId)?.payload
    if (typeof payload !== 'string') throw new Error('Corruption fixture use payload missing')
    originalUsePayload = payload
    shard.prepare('UPDATE uses SET payload=? WHERE id=?').run('[]', corruptResult.grant.useId)
  } finally {
    shard.close()
  }
  const corruptInspector = makeWorkspaceLifecycle({ root: join(sandbox, 'corrupt-authority') })
  await expectWorkspaceError(corruptInspector.inspect({}), ['review-required'])
  await corruptInspector.close()
  const repairedShard = new DatabaseSync(shardPath)
  repairedShard
    .prepare('UPDATE uses SET payload=? WHERE id=?')
    .run(originalUsePayload, corruptResult.grant.useId)
  repairedShard.close()
  const catalogPath = join(sandbox, 'corrupt-authority', 'catalog.sqlite')
  const catalog = new DatabaseSync(catalogPath)
  catalog
    .prepare('UPDATE repositories SET payload=? WHERE id=?')
    .run('[]', corruptResult.grant.repositoryId)
  catalog.close()
  const corruptCatalogInspector = makeWorkspaceLifecycle({
    root: join(sandbox, 'corrupt-authority'),
  })
  await expectWorkspaceError(corruptCatalogInspector.inspect({}), ['review-required'])
  await corruptCatalogInspector.close()
  checks.push('corrupt use and catalog payloads are reported, not reinitialized')

  const failureRepo = join(sandbox, 'failure-repo')
  mkdirSync(failureRepo)
  git(['init', '--quiet', '-b', 'main'], failureRepo)
  git(['config', 'user.name', 'Worker Failure Test'], failureRepo)
  git(['config', 'user.email', 'worker-failure@example.invalid'], failureRepo)
  writeFileSync(join(failureRepo, 'file.txt'), 'durable failure fixture\n')
  git(['add', 'file.txt'], failureRepo)
  git(['commit', '--quiet', '-m', 'worker-failure-fixture'], failureRepo)

  const deathRoot = join(sandbox, 'worker-death-authority')
  captureNextWorker = true
  capturedWorker = undefined
  const deathLifecycle = makeWorkspaceLifecycle({ root: deathRoot })
  const deathAttachment = await deathLifecycle.attach({
    conversation: conversation('worker-death'),
    cwd: failureRepo,
  })
  const deathAdmission = await deathAttachment.authorize({ access: 'write' })
  assert.equal(deathAdmission.kind, 'ready')
  const deathWorker = capturedWorker as Worker | undefined
  if (deathWorker === undefined) throw new Error('Worker-death fixture did not capture its worker')
  await deathWorker.terminate()
  await expectWorkspaceError(deathLifecycle.inspect({}), ['unavailable'])
  await deathLifecycle.close()
  const deathRecovery = makeWorkspaceLifecycle({ root: deathRoot })
  const deathViews = await deathRecovery.inspect({ taskId: deathAdmission.grant.taskId })
  assert.ok(
    deathViews.some(
      view =>
        view.workspaceId === deathAdmission.grant.workspaceId &&
        view.uses.some(use => use.id === deathAdmission.grant.useId && use.stage === 'authorized')
    )
  )
  await deathRecovery.close()

  const lostAckRoot = join(sandbox, 'lost-ack-authority')
  const lostAckLifecycle = makeWorkspaceLifecycle({ root: lostAckRoot })
  const lostAckAttachment = await lostAckLifecycle.attach({
    conversation: conversation('lost-ack'),
    cwd: failureRepo,
  })
  dropNextRpcAckFor = 'authorize'
  await expectWorkspaceError(lostAckAttachment.authorize({ access: 'write' }), ['unavailable'])
  const lostAckBinding = lostAckAttachment.binding
  await lostAckLifecycle.close()
  const lostAckRecovery = makeWorkspaceLifecycle({ root: lostAckRoot })
  const lostAckViews = await lostAckRecovery.inspect({})
  assert.ok(
    lostAckViews.some(
      view =>
        view.workspaceId === lostAckBinding.workspaceId &&
        view.uses.some(use => use.stage === 'authorized')
    )
  )
  await lostAckRecovery.close()
  checks.push('worker death and a lost commit acknowledgment preserve the durable authorized use')

  const processExecution = (name: string): WorkspaceExecution => ({
    sessionId: `${name}-session`,
    taskKey: `${name}-task`,
    attemptId: `${name}-attempt`,
    generation: `${name}-generation`,
  })
  const liveProcess = {
    pid: process.pid,
    parent: process.ppid,
    group: process.pid,
    birth: 'authority-check',
  }
  const startProcessUse = async (
    attachment: WorkspaceAttachment,
    grant: WorkspaceGrant,
    execution: WorkspaceExecution
  ) => {
    await attachment.reportExecution(grant, { kind: 'launch-intent', execution })
    await attachment.reportExecution(grant, { kind: 'spawned', process: liveProcess })
    await attachment.reportExecution(grant, { kind: 'started' })
  }
  const endProcessUse = async (attachment: WorkspaceAttachment, grant: WorkspaceGrant) => {
    await attachment.reportExecution(grant, { kind: 'observed', processes: [] })
    await attachment.reportExecution(grant, {
      kind: 'quiescent',
      reason: 'fixture process family observed gone',
    })
  }
  const findUse = async (lifecycleValue: WorkspaceLifecycle, useId: string) =>
    (await lifecycleValue.inspect({})).flatMap(view => view.uses).find(use => use.id === useId)
  const ready = (result: Awaited<ReturnType<WorkspaceAttachment['authorize']>>) => {
    if (result.kind !== 'ready') throw new Error(`Expected a ready grant, got ${result.kind}`)
    return result.grant
  }

  const scopedRepo = join(sandbox, 'scoped-repo')
  const linkedRepo = join(sandbox, 'linked-repo')
  mkdirSync(scopedRepo)
  git(['init', '--quiet', '-b', 'main'], scopedRepo)
  git(['config', 'user.name', 'Scoped Operation Test'], scopedRepo)
  git(['config', 'user.email', 'scoped@example.invalid'], scopedRepo)
  writeFileSync(join(scopedRepo, 'tracked.txt'), 'before scoped operation\n')
  git(['add', 'tracked.txt'], scopedRepo)
  git(['commit', '--quiet', '-m', 'scoped-fixture'], scopedRepo)
  const scopedCommit = git(['rev-parse', 'HEAD'], scopedRepo)
  git(['worktree', 'add', '--quiet', '-b', 'linked-scope', linkedRepo, scopedCommit], scopedRepo)

  const scopedRoot = join(sandbox, 'scoped-authority')
  const scopedLifecycle = makeWorkspaceLifecycle({ root: scopedRoot })
  const scopedPrimary = await scopedLifecycle.attach({
    conversation: conversation('scoped-primary'),
    cwd: scopedRepo,
  })
  const scopedSibling = await scopedLifecycle.attach({
    conversation: conversation('scoped-sibling'),
    cwd: linkedRepo,
  })
  const primaryGrant = ready(await scopedPrimary.authorize({ access: 'write' }))
  const siblingGrant = ready(await scopedSibling.authorize({ access: 'write' }))
  assert.notEqual(primaryGrant.workspaceId, siblingGrant.workspaceId)
  assert.equal(primaryGrant.repositoryId, siblingGrant.repositoryId)

  const nativeWrite = ready(
    await scopedPrimary.authorize({
      access: 'write',
      effect: 'native-file-write',
      within: primaryGrant,
      path: 'tracked.txt',
    })
  )
  await scopedPrimary.reportExecution(nativeWrite, { kind: 'operation-started' })
  await expectWorkspaceError(
    scopedPrimary.reportExecution(nativeWrite, { kind: 'operation-started' }),
    ['review-required']
  )
  const siblingShellExecution = processExecution('sibling-shell')
  const siblingShell = ready(
    await scopedSibling.authorize({
      access: 'write',
      effect: 'opaque',
      within: siblingGrant,
      execution: siblingShellExecution,
    })
  )
  await startProcessUse(scopedSibling, siblingShell, siblingShellExecution)
  const concurrentAllocation = ready(
    await scopedSibling.authorize({ access: 'write', delegated: true })
  )
  assert.equal(concurrentAllocation.origin, 'managed')
  assert.equal(git(['rev-parse', 'HEAD'], concurrentAllocation.checkout), scopedCommit)
  await endProcessUse(scopedSibling, siblingShell)
  writeFileSync(join(scopedRepo, 'tracked.txt'), 'exact admitted native edit\n')
  await scopedPrimary.reportExecution(nativeWrite, { kind: 'operation-completed' })
  await expectWorkspaceError(
    scopedPrimary.reportExecution(nativeWrite, { kind: 'operation-started' }),
    ['review-required']
  )
  const laterNativeWrite = ready(
    await scopedPrimary.authorize({
      access: 'write',
      effect: 'native-file-write',
      within: primaryGrant,
      path: 'tracked.txt',
    })
  )
  assert.notEqual(laterNativeWrite.useId, nativeWrite.useId)
  await scopedPrimary.reportExecution(laterNativeWrite, { kind: 'operation-started' })
  await expectWorkspaceError(
    scopedPrimary.reportExecution(nativeWrite, {
      kind: 'unknown',
      reason: 'stale-report-must-not-affect-later-use',
    }),
    ['review-required']
  )
  assert.equal((await findUse(scopedLifecycle, laterNativeWrite.useId))?.stage, 'operation-started')
  await scopedPrimary.reportExecution(laterNativeWrite, { kind: 'operation-completed' })
  const completedNative = await findUse(scopedLifecycle, nativeWrite.useId)
  assert.equal(completedNative?.stage, 'quiescent')
  assert.equal(completedNative?.path, join(scopedRepo, 'tracked.txt'))
  checks.push(
    'native operations record exact start/completion facts, and a stale report cannot release a later use'
  )
  checks.push(
    'a live native write in one worktree fences neither a shell nor an allocation in a linked worktree of the same repository'
  )

  const nativeInsideNative = ready(
    await scopedPrimary.authorize({
      access: 'write',
      effect: 'native-file-write',
      within: primaryGrant,
      path: 'outer.txt',
    })
  )
  await expectWorkspaceError(
    scopedPrimary.authorize({
      access: 'write',
      effect: 'native-file-write',
      within: nativeInsideNative,
      path: 'inner.txt',
    }),
    ['invalid']
  )
  await scopedPrimary.reportExecution(nativeInsideNative, { kind: 'operation-completed' })
  const primaryExecution = processExecution('primary-agent')
  const primaryAgent = ready(
    await scopedPrimary.authorize({ access: 'write', execution: primaryExecution })
  )
  await expectWorkspaceError(
    scopedPrimary.authorize({
      access: 'write',
      effect: 'opaque',
      within: primaryAgent,
      execution: processExecution('nested-in-agent'),
    }),
    ['invalid']
  )
  await scopedPrimary.reportExecution(primaryAgent, {
    kind: 'launch-failed',
    reason: 'not launched',
  })
  await expectWorkspaceError(
    scopedPrimary.authorize({ access: 'write', effect: 'opaque', within: primaryGrant }),
    ['invalid']
  )
  await expectWorkspaceError(
    scopedPrimary.authorize({
      access: 'write',
      effect: 'native-file-write',
      within: primaryGrant,
      path: 'native-with-process.txt',
      execution: processExecution('native-with-process'),
    }),
    ['invalid']
  )
  await expectWorkspaceError(
    scopedPrimary.authorize({
      access: 'read',
      effect: 'opaque',
      within: primaryGrant,
      execution: processExecution('read-shell'),
    }),
    ['invalid']
  )
  checks.push(
    'scoped operations are admitted only within an ordinary grant; a shell needs process identity and write access, a native operation carries none'
  )

  const primaryShellExecution = processExecution('primary-shell')
  const primaryShell = ready(
    await scopedPrimary.authorize({
      access: 'write',
      effect: 'opaque',
      within: primaryGrant,
      execution: primaryShellExecution,
    })
  )
  assert.equal(ready(await scopedPrimary.authorize({ access: 'write' })).useId, primaryGrant.useId)
  const besideShell = ready(
    await scopedPrimary.authorize({
      access: 'write',
      effect: 'native-file-write',
      within: primaryGrant,
      path: 'tracked.txt',
    })
  )
  await scopedPrimary.reportExecution(besideShell, { kind: 'operation-started' })
  await scopedPrimary.reportExecution(besideShell, { kind: 'operation-completed' })
  const ownRead = await scopedPrimary.authorize({ access: 'read' })
  assert.equal(ownRead.kind === 'ready' ? ownRead.warning : 'rebind', undefined)
  const shellReader = await scopedLifecycle.attach({
    conversation: conversation('shell-reader'),
    cwd: scopedRepo,
  })
  const shellReaderResult = await shellReader.authorize({ access: 'read' })
  assert.equal(shellReaderResult.kind, 'ready')
  assert.match(
    shellReaderResult.kind === 'ready' ? (shellReaderResult.warning ?? '') : '',
    /writer owns/
  )
  await shellReader.close()
  await startProcessUse(scopedPrimary, primaryShell, primaryShellExecution)
  const secondShellExecution = processExecution('second-primary-shell')
  const secondShell = ready(
    await scopedPrimary.authorize({
      access: 'write',
      effect: 'opaque',
      within: primaryGrant,
      execution: secondShellExecution,
    })
  )
  await startProcessUse(scopedPrimary, secondShell, secondShellExecution)
  await endProcessUse(scopedPrimary, secondShell)
  await scopedPrimary.reportExecution(primaryShell, {
    kind: 'unknown',
    reason: 'test-shell-observation-lost',
  })
  await expectWorkspaceError(
    scopedPrimary.reportExecution(primaryShell, { kind: 'observed', processes: [] }),
    ['review-required']
  )
  checks.push(
    'the checkout writer keeps its grant, native writes and readers beside its own live shell, and may run concurrent shells'
  )
  await scopedPrimary.close()
  await scopedSibling.close()
  await scopedLifecycle.close()

  const scopedRecovery = makeWorkspaceLifecycle({ root: scopedRoot })
  const unknownShell = await findUse(scopedRecovery, primaryShell.useId)
  assert.equal(unknownShell?.stage, 'unknown')
  assert.equal(unknownShell?.reason, 'test-shell-observation-lost')
  const shellContender = await scopedRecovery.attach({
    conversation: conversation('shell-contender'),
    cwd: scopedRepo,
  })
  const shellContention = await shellContender.authorize({ access: 'write' })
  if (shellContention.kind !== 'rebind')
    throw new Error('A writer contending with an unknown shell was not isolated')
  assert.equal(git(['rev-parse', 'HEAD'], shellContention.handoff.target.checkout), scopedCommit)
  await shellContender.handoff(shellContention.handoff, async () => 'cancelled')
  await shellContender.close()
  const linkedResume = await scopedRecovery.attach({
    conversation: conversation('linked-resume'),
    cwd: linkedRepo,
    selection: { taskId: siblingGrant.taskId!, workspaceId: siblingGrant.workspaceId },
  })
  const linkedWrite = ready(await linkedResume.authorize({ access: 'write' }))
  const linkedShellExecution = processExecution('linked-shell')
  const linkedShell = ready(
    await linkedResume.authorize({
      access: 'write',
      effect: 'opaque',
      within: linkedWrite,
      execution: linkedShellExecution,
    })
  )
  await startProcessUse(linkedResume, linkedShell, linkedShellExecution)
  await endProcessUse(linkedResume, linkedShell)
  assert.equal(
    ready(await linkedResume.authorize({ access: 'write', delegated: true })).origin,
    'managed'
  )
  await linkedResume.close()
  await scopedRecovery.close()
  checks.push(
    'an unknown shell survives reopen and blocks only its own checkout: a contender there is isolated, while a linked worktree resumes, runs a shell and allocates'
  )

  const structureRoot = join(sandbox, 'structure-authority')
  const structureLifecycle = makeWorkspaceLifecycle({ root: structureRoot })
  const structureAttachment = await structureLifecycle.attach({
    conversation: conversation('structure'),
    cwd: linkedRepo,
  })
  const structureWrite = ready(await structureAttachment.authorize({ access: 'write' }))
  const structuralLock = new DatabaseSync(
    join(structureRoot, 'gates', 'repos', structureWrite.repositoryId, 'structure.sqlite'),
    { timeout: 0 }
  )
  try {
    structuralLock.exec('BEGIN EXCLUSIVE')
    const structureShellExecution = processExecution('structure-shell')
    const structureShell = ready(
      await structureAttachment.authorize({
        access: 'write',
        effect: 'opaque',
        within: structureWrite,
        execution: structureShellExecution,
      })
    )
    await startProcessUse(structureAttachment, structureShell, structureShellExecution)
    await endProcessUse(structureAttachment, structureShell)
    await expectWorkspaceError(
      structureAttachment.authorize({ access: 'write', delegated: true }),
      ['blocked']
    )
    ready(await structureAttachment.authorize({ access: 'read' }))
    assert.equal(
      ready(await structureAttachment.authorize({ access: 'write' })).useId,
      structureWrite.useId,
      'an allocation refused before any Git effect leaves the conversation admitted'
    )
  } finally {
    structuralLock.close()
  }
  await structureAttachment.close()
  await structureLifecycle.close()
  checks.push(
    "the repository structure gate serializes dev's own worktree allocation, not shell operations"
  )

  const scopedLostAckRoot = join(sandbox, 'scoped-lost-ack-authority')
  const scopedLostAckLifecycle = makeWorkspaceLifecycle({ root: scopedLostAckRoot })
  const scopedLostAckAttachment = await scopedLostAckLifecycle.attach({
    conversation: conversation('scoped-lost-ack'),
    cwd: failureRepo,
  })
  const scopedLostAckParent = ready(await scopedLostAckAttachment.authorize({ access: 'write' }))
  const scopedLostAckOperation = ready(
    await scopedLostAckAttachment.authorize({
      access: 'write',
      effect: 'native-file-write',
      within: scopedLostAckParent,
      path: 'file.txt',
    })
  )
  dropNextRpcAckFor = 'report-execution'
  await expectWorkspaceError(
    scopedLostAckAttachment.reportExecution(scopedLostAckOperation, { kind: 'operation-started' }),
    ['unavailable']
  )
  await scopedLostAckLifecycle.close()
  const scopedLostAckRecovery = makeWorkspaceLifecycle({ root: scopedLostAckRoot })
  const scopedLostAckUse = await findUse(scopedLostAckRecovery, scopedLostAckOperation.useId)
  assert.equal(scopedLostAckUse?.effect, 'native-file-write')
  assert.ok(['operation-started', 'unknown'].includes(scopedLostAckUse?.stage ?? ''))
  await scopedLostAckRecovery.close()
  checks.push('a lost scoped operation-start acknowledgment retains its durable active use')

  const traversalRepo = join(sandbox, 'traversal-repo')
  const traversalOutside = join(sandbox, 'traversal-outside')
  mkdirSync(traversalRepo)
  mkdirSync(join(traversalOutside, 'inner'), { recursive: true })
  git(['init', '--quiet', '-b', 'main'], traversalRepo)
  git(['config', 'user.name', 'Traversal Test'], traversalRepo)
  git(['config', 'user.email', 'traversal@example.invalid'], traversalRepo)
  writeFileSync(join(traversalRepo, 'tracked.txt'), 'traversal fixture\n')
  git(['add', 'tracked.txt'], traversalRepo)
  git(['commit', '--quiet', '-m', 'traversal-fixture'], traversalRepo)
  symlinkSync(join(traversalOutside, 'inner'), join(traversalRepo, 'link'))
  const traversalLifecycle = makeWorkspaceLifecycle({ root: join(sandbox, 'traversal-authority') })
  const traversalAttachment = await traversalLifecycle.attach({
    conversation: conversation('traversal'),
    cwd: traversalRepo,
  })
  const traversalParent = ready(await traversalAttachment.authorize({ access: 'write' }))
  const nativeWriteTo = (path: string) =>
    traversalAttachment.authorize({
      access: 'write',
      effect: 'native-file-write',
      within: traversalParent,
      path,
    })
  for (const requested of [
    'link/../escape.txt',
    './link/../escape.txt',
    'link/../inner/escape.txt',
    'link/../../escape.txt',
    '~/escape.txt',
    '~',
    '@/escape.txt',
    `@${join(traversalOutside, 'escape.txt')}`,
    `file://${join(traversalOutside, 'escape.txt')}`,
    ' alias/escape.txt',
  ])
    await expectWorkspaceError(nativeWriteTo(requested), ['invalid'])
  assert.ok(!existsSync(join(traversalOutside, 'escape.txt')))
  assert.ok(!existsSync(join(traversalOutside, 'inner', 'escape.txt')))
  mkdirSync(join(traversalRepo, 'vendor', '.git'), { recursive: true })
  await expectWorkspaceError(nativeWriteTo('vendor/escape.txt'), ['invalid'])
  const traversalAdmitted = ready(await nativeWriteTo('tracked.txt'))
  assert.equal(traversalAdmitted.path, join(traversalRepo, 'tracked.txt'))
  await traversalAttachment.reportExecution(traversalAdmitted, { kind: 'operation-started' })
  await traversalAttachment.reportExecution(traversalAdmitted, { kind: 'operation-completed' })
  checks.push(
    'raw parent traversal, Pi path shorthand and a destination inside a nested repository are refused, as at the child tool boundary; an admitted native write carries its exact destination'
  )
  mkdirSync(join(traversalRepo, 'sub'))
  symlinkSync(join(traversalRepo, 'sub'), join(traversalRepo, 'inlink'))
  const insideLink = ready(await nativeWriteTo('inlink/new.txt'))
  assert.equal(insideLink.path, join(traversalRepo, 'sub', 'new.txt'))
  await traversalAttachment.reportExecution(insideLink, { kind: 'operation-completed' })
  assert.match(
    (await findUse(traversalLifecycle, insideLink.useId))?.reason ?? '',
    /operation-ended-before-start/
  )
  checks.push('a directory link inside the checkout resolves to its real destination')
  const swapTarget = ready(await nativeWriteTo('swap.txt'))
  writeFileSync(join(traversalOutside, 'inner', 'captured.txt'), 'must not be overwritten\n')
  symlinkSync(join(traversalOutside, 'inner', 'captured.txt'), join(traversalRepo, 'swap.txt'))
  await expectWorkspaceError(
    traversalAttachment.reportExecution(swapTarget, { kind: 'operation-started' }),
    ['blocked']
  )
  assert.equal(
    readFileSync(join(traversalOutside, 'inner', 'captured.txt'), 'utf8'),
    'must not be overwritten\n'
  )
  for (const outsideFileExists of [true, false]) {
    const outsideFile = join(traversalOutside, 'inner', 'ancestor.txt')
    rmSync(join(traversalRepo, 'ancestor'), { recursive: true, force: true })
    mkdirSync(join(traversalRepo, 'ancestor'))
    writeFileSync(join(traversalRepo, 'ancestor', 'ancestor.txt'), 'inside\n')
    if (outsideFileExists) writeFileSync(outsideFile, 'outside\n')
    else rmSync(outsideFile, { force: true })
    const ancestorTarget = ready(await nativeWriteTo('ancestor/ancestor.txt'))
    assert.equal(ancestorTarget.path, join(traversalRepo, 'ancestor', 'ancestor.txt'))
    rmSync(join(traversalRepo, 'ancestor'), { recursive: true })
    symlinkSync(join(traversalOutside, 'inner'), join(traversalRepo, 'ancestor'))
    await expectWorkspaceError(
      traversalAttachment.reportExecution(ancestorTarget, { kind: 'operation-started' }),
      ['blocked']
    )
    await traversalAttachment.reportExecution(ancestorTarget, {
      kind: 'unknown',
      reason: 'destination changed before start',
    })
    rmSync(join(traversalRepo, 'ancestor'))
  }
  await traversalAttachment.close()
  await traversalLifecycle.close()
  checks.push(
    'a destination or any ancestor directory replaced by a link after authorization is refused at the start boundary'
  )

  const fenceRepo = join(sandbox, 'fence-repo')
  const fenceLinked = join(sandbox, 'fence-linked')
  mkdirSync(fenceRepo)
  git(['init', '--quiet', '-b', 'main'], fenceRepo)
  git(['config', 'user.name', 'Checkout Fence Test'], fenceRepo)
  git(['config', 'user.email', 'fence@example.invalid'], fenceRepo)
  writeFileSync(join(fenceRepo, 'tracked.txt'), 'fence fixture\n')
  git(['add', 'tracked.txt'], fenceRepo)
  git(['commit', '--quiet', '-m', 'fence-fixture'], fenceRepo)
  const fenceCommit = git(['rev-parse', 'HEAD'], fenceRepo)
  git(['worktree', 'add', '--quiet', '-b', 'fence-linked', fenceLinked, fenceCommit], fenceRepo)

  const fenceRoot = join(sandbox, 'fence-authority')
  const fenceLifecycle = makeWorkspaceLifecycle({ root: fenceRoot })
  const fencePrimary = await fenceLifecycle.attach({
    conversation: conversation('fence-primary'),
    cwd: fenceRepo,
  })
  ready(await fencePrimary.authorize({ access: 'write' }))
  const fenceAgentExecution = processExecution('fence-agent')
  const fenceAgent = ready(
    await fencePrimary.authorize({ access: 'write', execution: fenceAgentExecution })
  )
  await startProcessUse(fencePrimary, fenceAgent, fenceAgentExecution)
  const fenceContender = await fenceLifecycle.attach({
    conversation: conversation('fence-contender'),
    cwd: fenceRepo,
  })
  const fenceContention = await fenceContender.authorize({ access: 'write' })
  if (fenceContention.kind !== 'rebind')
    throw new Error('A live write execution did not isolate a contender')
  await fenceContender.handoff(fenceContention.handoff, async () => 'cancelled')
  await fenceContender.close()
  const fenceSibling = await fenceLifecycle.attach({
    conversation: conversation('fence-sibling'),
    cwd: fenceLinked,
  })
  const fenceSiblingWrite = ready(await fenceSibling.authorize({ access: 'write' }))
  const fenceSiblingShellExecution = processExecution('fence-sibling-shell')
  const fenceSiblingShell = ready(
    await fenceSibling.authorize({
      access: 'write',
      effect: 'opaque',
      within: fenceSiblingWrite,
      execution: fenceSiblingShellExecution,
    })
  )
  await startProcessUse(fenceSibling, fenceSiblingShell, fenceSiblingShellExecution)
  await endProcessUse(fenceSibling, fenceSiblingShell)
  await fenceSibling.close()
  const fenceCrossProcess = await runChild(`
    import { makeWorkspaceLifecycle } from ${JSON.stringify(moduleUrl)}
    const lifecycle = makeWorkspaceLifecycle({ root: ${JSON.stringify(fenceRoot)} })
    const attachment = await lifecycle.attach({
      conversation: ${JSON.stringify(conversation('fence-cross-process'))},
      cwd: ${JSON.stringify(fenceLinked)},
      selection: ${JSON.stringify({ taskId: fenceSiblingWrite.taskId, workspaceId: fenceSiblingWrite.workspaceId })},
    })
    const write = await attachment.authorize({ access: 'write' })
    const shell = await attachment.authorize({
      access: 'write', effect: 'opaque', within: write.grant,
      execution: ${JSON.stringify(processExecution('fence-cross-process'))},
    })
    await attachment.reportExecution(shell.grant, { kind: 'launch-failed', reason: 'not launched' })
    await attachment.close()
    await lifecycle.close()
    console.log(shell.kind)
  `)
  assert.equal(fenceCrossProcess, 'ready')
  await endProcessUse(fencePrimary, fenceAgent)
  await fencePrimary.close()
  await fenceLifecycle.close()
  checks.push(
    'a live ordinary write execution isolates a contender from its checkout and fences nothing in a linked worktree, in-process or from another process'
  )

  const closeRoot = join(sandbox, 'close-nesting-authority')
  const closeLifecycle = makeWorkspaceLifecycle({ root: closeRoot })
  const closeAttachment = await closeLifecycle.attach({
    conversation: conversation('close-nesting'),
    cwd: fenceRepo,
  })
  const closeParent = ready(await closeAttachment.authorize({ access: 'write' }))
  const closeDependent = ready(
    await closeAttachment.authorize({
      access: 'write',
      effect: 'native-file-write',
      within: closeParent,
      path: 'tracked.txt',
    })
  )
  await closeAttachment.reportExecution(closeDependent, { kind: 'operation-started' })
  await closeAttachment.close()
  await closeLifecycle.close()
  const closeRecovery = makeWorkspaceLifecycle({ root: closeRoot })
  assert.equal((await findUse(closeRecovery, closeDependent.useId))?.stage, 'unknown')
  const closedParent = await findUse(closeRecovery, closeParent.useId)
  assert.equal(closedParent?.stage, 'unknown')
  assert.match(closedParent?.reason ?? '', /dependent-scoped-operations-were-live/)
  await closeRecovery.close()
  checks.push('closing with a live dependent records both it and its parent unknown, not quiescent')

  const launderRoot = join(sandbox, 'launder-authority')
  const launderLifecycle = makeWorkspaceLifecycle({ root: launderRoot })
  const launderMain = await launderLifecycle.attach({
    conversation: conversation('launder-main'),
    cwd: fenceRepo,
  })
  const launderParent = ready(await launderMain.authorize({ access: 'write' }))
  const launderAllocator = await launderLifecycle.attach({
    conversation: conversation('launder-allocator'),
    cwd: fenceRepo,
  })
  const launderTarget = ready(
    await launderAllocator.authorize({ access: 'write', delegated: true })
  )
  await launderAllocator.close()
  const launderScoped = ready(
    await launderMain.authorize({
      access: 'write',
      effect: 'native-file-write',
      within: launderParent,
      path: 'tracked.txt',
    })
  )
  await launderMain.reportExecution(launderScoped, {
    kind: 'unknown',
    reason: 'test-native-write-outcome-unknown',
  })
  const launderTransition = await launderMain.select({
    taskId: launderTarget.taskId!,
    workspaceId: launderTarget.workspaceId,
  })
  await launderMain.handoff(launderTransition, async () => 'confirmed')
  assert.equal(launderMain.binding.workspaceId, launderTarget.workspaceId)
  const launderedUse = await findUse(launderLifecycle, launderScoped.useId)
  assert.equal(launderedUse?.stage, 'unknown')
  assert.equal(launderedUse?.reason, 'test-native-write-outcome-unknown')
  const launderedParent = await findUse(launderLifecycle, launderParent.useId)
  assert.equal(launderedParent?.stage, 'unknown')
  assert.match(launderedParent?.reason ?? '', /dependent-uses-unresolved/)
  const launderContender = await launderLifecycle.attach({
    conversation: conversation('launder-contender'),
    cwd: fenceRepo,
  })
  const launderContention = await launderContender.authorize({ access: 'write' })
  assert.equal(launderContention.kind, 'rebind')
  if (launderContention.kind === 'rebind')
    await launderContender.handoff(launderContention.handoff, async () => 'cancelled')
  await launderContender.close()
  const launderLinked = await launderLifecycle.attach({
    conversation: conversation('launder-linked'),
    cwd: fenceLinked,
  })
  ready(await launderLinked.authorize({ access: 'write' }))
  await launderLinked.close()
  await launderMain.close()
  await launderLifecycle.close()
  checks.push(
    'a confirmed host transition keeps an unknown dependent and its parent unknown, so the old checkout still isolates contenders while a linked worktree writes'
  )

  const removedRoot = join(sandbox, 'removed-workspace-authority')
  const removedLifecycle = makeWorkspaceLifecycle({ root: removedRoot })
  const removedConversation = conversation('removed-workspace')
  const removedAttachment = await removedLifecycle.attach({
    conversation: removedConversation,
    cwd: fenceRepo,
  })
  const removedAllocator = await removedLifecycle.attach({
    conversation: conversation('removed-allocator'),
    cwd: fenceRepo,
  })
  const removedTarget = ready(
    await removedAllocator.authorize({ access: 'write', delegated: true })
  )
  await removedAllocator.close()
  await removedAttachment.handoff(
    await removedAttachment.select({
      taskId: removedTarget.taskId!,
      workspaceId: removedTarget.workspaceId,
    }),
    async () => 'confirmed'
  )
  await removedAttachment.close()
  rmSync(removedTarget.checkout, { recursive: true, force: true })
  await assert.rejects(
    removedLifecycle.attach({ conversation: removedConversation, cwd: fenceRepo }),
    error =>
      error instanceof WorkspaceError &&
      error.outcome === 'review-required' &&
      /no longer exists and is not recreated/.test(error.message)
  )
  assert.ok(existsSync(removedConversation.sessionFile))
  assert.ok(!existsSync(removedTarget.checkout))
  await removedLifecycle.close()
  checks.push(
    'a conversation whose bound workspace was removed is refused explicitly, without recreating the workspace or touching the conversation file'
  )

  const transitionRoot = join(sandbox, 'transition-authority')
  const transitionLifecycle = makeWorkspaceLifecycle({ root: transitionRoot })
  const transitionAttachment = await transitionLifecycle.attach({
    conversation: conversation('transition'),
    cwd: fenceRepo,
  })
  const transitionParent = ready(await transitionAttachment.authorize({ access: 'write' }))
  const transitionAllocator = await transitionLifecycle.attach({
    conversation: conversation('transition-allocator'),
    cwd: fenceRepo,
  })
  const transitionTarget = ready(
    await transitionAllocator.authorize({ access: 'write', delegated: true })
  )
  await transitionAllocator.close()
  const transitionExecution = processExecution('transition-process')
  const transitionProcess = ready(
    await transitionAttachment.authorize({ access: 'write', execution: transitionExecution })
  )
  await startProcessUse(transitionAttachment, transitionProcess, transitionExecution)
  const transitionSelection = {
    taskId: transitionTarget.taskId!,
    workspaceId: transitionTarget.workspaceId,
  }
  await expectWorkspaceError(transitionAttachment.select(transitionSelection), ['blocked'])
  ready(await transitionAttachment.authorize({ access: 'read' }))
  assert.equal((await findUse(transitionLifecycle, transitionParent.useId))?.stage, 'authorized')
  await endProcessUse(transitionAttachment, transitionProcess)
  const withdrawn = await transitionAttachment.select(transitionSelection)
  await transitionAttachment.handoff(withdrawn, async () => 'cancelled')
  ready(await transitionAttachment.authorize({ access: 'write' }))
  const transitionHandoff = await transitionAttachment.select(transitionSelection)
  await transitionAttachment.handoff(transitionHandoff, async () => 'confirmed')
  assert.equal(transitionAttachment.binding.workspaceId, transitionTarget.workspaceId)
  assert.equal((await findUse(transitionLifecycle, transitionParent.useId))?.stage, 'quiescent')
  await transitionAttachment.close()
  await transitionLifecycle.close()
  checks.push(
    'a conversation with a live process cannot start a switch; once the process is observed gone a switch can be withdrawn and later confirmed'
  )

  const readerAgentRoot = join(sandbox, 'reader-agent-authority')
  const readerAgentLifecycle = makeWorkspaceLifecycle({ root: readerAgentRoot })
  const readerOwner = await readerAgentLifecycle.attach({
    conversation: conversation('reader-owner'),
    cwd: fenceRepo,
  })
  ready(await readerOwner.authorize({ access: 'write' }))
  const readerAgent = await readerAgentLifecycle.attach({
    conversation: conversation('reader-agent'),
    cwd: fenceRepo,
  })
  const readerAgentExecution = processExecution('reader-agent')
  const readerAgentUse = ready(
    await readerAgent.authorize({ access: 'read', execution: readerAgentExecution })
  )
  await startProcessUse(readerAgent, readerAgentUse, readerAgentExecution)
  await expectWorkspaceError(readerAgent.authorize({ access: 'write' }), ['blocked'])
  ready(await readerAgent.authorize({ access: 'read' }))
  await endProcessUse(readerAgent, readerAgentUse)
  assert.equal((await readerAgent.authorize({ access: 'write' })).kind, 'rebind')
  await readerAgent.close()
  await readerOwner.close()
  await readerAgentLifecycle.close()
  checks.push(
    'a contended write is refused, not isolated, while the same conversation still runs a process in the checkout it would leave, and the conversation stays admitted'
  )

  const recoveryRoot = join(sandbox, 'unstarted-recovery-authority')
  const recoveryConversation = conversation('unstarted-recovery')
  const recoveryLifecycle = makeWorkspaceLifecycle({ root: recoveryRoot })
  const recoveryAllocator = await recoveryLifecycle.attach({
    conversation: conversation('unstarted-recovery-allocator'),
    cwd: fenceRepo,
  })
  const recoveryTarget = ready(
    await recoveryAllocator.authorize({ access: 'write', delegated: true })
  )
  await recoveryAllocator.close()
  const otherAllocator = await recoveryLifecycle.attach({
    conversation: conversation('unstarted-recovery-other-allocator'),
    cwd: fenceRepo,
  })
  const otherTarget = ready(await otherAllocator.authorize({ access: 'write', delegated: true }))
  await otherAllocator.close()
  const recoveryAttachment = await recoveryLifecycle.attach({
    conversation: recoveryConversation,
    cwd: fenceRepo,
  })
  const pendingSwitch = await recoveryAttachment.select({
    taskId: recoveryTarget.taskId!,
    workspaceId: recoveryTarget.workspaceId,
  })
  const sourceWorkspaceId = recoveryAttachment.binding.workspaceId
  // A second lifecycle on the same root stands in for another installation: it shares the
  // authority but none of the first installation's conversation claims.
  const otherInstallation = makeWorkspaceLifecycle({ root: recoveryRoot })
  const otherSelection = { taskId: otherTarget.taskId!, workspaceId: otherTarget.workspaceId }
  await expectWorkspaceError(
    otherInstallation.attach({ conversation: recoveryConversation, cwd: fenceRepo }),
    ['blocked']
  )
  await expectWorkspaceError(
    otherInstallation.attach({
      conversation: recoveryConversation,
      cwd: otherTarget.cwd,
      selection: otherSelection,
    }),
    ['blocked']
  )
  assert.equal(
    await switchStage(otherInstallation, pendingSwitch.operationId),
    'intent',
    'an attach refused while the conversation is live elsewhere leaves its switch to that host'
  )
  await otherInstallation.close()
  await recoveryLifecycle.close()
  const recoveryReopened = makeWorkspaceLifecycle({ root: recoveryRoot })
  const resumedAtSource = await recoveryReopened.attach({
    conversation: recoveryConversation,
    cwd: fenceRepo,
  })
  assert.equal(resumedAtSource.binding.workspaceId, sourceWorkspaceId)
  assert.notEqual(await switchStage(recoveryReopened, pendingSwitch.operationId), 'intent')
  assert.equal(
    ready(await resumedAtSource.authorize({ access: 'write' })).workspaceId,
    sourceWorkspaceId
  )
  await resumedAtSource.close()
  const targetOwner = await recoveryReopened.attach({
    conversation: conversation('unstarted-recovery-target'),
    cwd: fenceRepo,
    selection: { taskId: recoveryTarget.taskId!, workspaceId: recoveryTarget.workspaceId },
  })
  assert.equal(
    ready(await targetOwner.authorize({ access: 'write' })).workspaceId,
    recoveryTarget.workspaceId
  )
  await targetOwner.close()
  await recoveryReopened.close()

  const selectingConversation = conversation('unstarted-selection')
  const selectingLifecycle = makeWorkspaceLifecycle({ root: recoveryRoot })
  const selecting = await selectingLifecycle.attach({
    conversation: selectingConversation,
    cwd: fenceRepo,
  })
  const selectingSwitch = await selecting.select({
    taskId: recoveryTarget.taskId!,
    workspaceId: recoveryTarget.workspaceId,
  })
  await selectingLifecycle.close()
  const selectingReopened = makeWorkspaceLifecycle({ root: recoveryRoot })
  const selected = await selectingReopened.attach({
    conversation: selectingConversation,
    cwd: otherTarget.cwd,
    selection: otherSelection,
  })
  assert.equal(selected.binding.workspaceId, otherTarget.workspaceId)
  assert.notEqual(
    await switchStage(selectingReopened, selectingSwitch.operationId),
    'intent',
    'a selection after the host died withdraws the switch instead of orphaning it'
  )
  await selected.close()
  await selectingReopened.close()
  checks.push(
    'while a conversation is live, an attach from another lifecycle on the same authority is refused, with or without a selection, and its switch stays with the live host; once the host is gone, any attach withdraws the switch that never reached it, keeping the last confirmed workspace or binding the selected one, and frees the unused target'
  )

  const crashRoot = join(sandbox, 'crash-authority')
  const crashConversation = conversation('crashed-writer')
  await runChild(`
    import { makeWorkspaceLifecycle } from ${JSON.stringify(moduleUrl)}
    const lifecycle = makeWorkspaceLifecycle({ root: ${JSON.stringify(crashRoot)} })
    const attachment = await lifecycle.attach({ conversation: ${JSON.stringify(crashConversation)}, cwd: ${JSON.stringify(failureRepo)} })
    await attachment.authorize({ access: 'write' })
    process.kill(process.pid, 'SIGKILL')
  `).then(
    () => assert.fail('the crashing child must not exit cleanly'),
    () => undefined
  )
  const crashLifecycle = makeWorkspaceLifecycle({ root: crashRoot })
  const liveWriter = await crashLifecycle.attach({
    conversation: conversation('live-writer'),
    cwd: scopedRepo,
  })
  ready(await liveWriter.authorize({ access: 'write' }))
  const coPresentReader = await crashLifecycle.attach({
    conversation: conversation('co-present-reader'),
    cwd: failureRepo,
  })
  const coPresentRead = ready(await coPresentReader.authorize({ access: 'read' }))
  const crashViews = await crashLifecycle.inspect({})
  const abandoned = crashViews.find(view => view.path === realpathSync(failureRepo))
  const crashedUse = abandoned?.uses.find(use => use.access === 'write')
  assert.ok(crashedUse)
  assert.equal(abandoned?.outcome, 'blocked', 'a live reader does not hide the dead writer')
  assert.match(abandoned?.reason ?? '', /left unsettled by conversations no dev session holds/)
  assert.ok(abandoned?.reason?.includes(crashedUse.id))
  assert.ok(!abandoned?.reason?.includes(coPresentRead.useId))
  assert.equal(crashViews.find(view => view.path === realpathSync(scopedRepo))?.outcome, 'active')
  await coPresentReader.close()
  await liveWriter.close()
  await crashLifecycle.close()
  checks.push(
    'inspect names the use of a killed writer as left by a conversation no dev session holds, even while a live reader shares its checkout, and a live writer stays active'
  )

  const filteredRepo = join(sandbox, 'filtered-repo')
  mkdirSync(filteredRepo)
  git(['init', '--quiet', '-b', 'main'], filteredRepo)
  writeFileSync(join(filteredRepo, 'AGENTS.md'), 'fixture\n')
  writeFileSync(join(filteredRepo, '.gitattributes'), 'AGENTS.md filter=fixture\n')
  git(['add', '.'], filteredRepo)
  git(
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'x'],
    filteredRepo
  )
  const smudged = join(sandbox, 'filtered-smudge-ran')
  git(['config', 'filter.fixture.smudge', `touch ${smudged}`], filteredRepo)
  const filteredRoot = join(sandbox, 'filtered-authority')
  const filteredLifecycle = makeWorkspaceLifecycle({ root: filteredRoot })
  const filteredOwner = await filteredLifecycle.attach({
    conversation: conversation('filtered-owner'),
    cwd: filteredRepo,
  })
  ready(await filteredOwner.authorize({ access: 'write' }))
  const filteredContender = await filteredLifecycle.attach({
    conversation: conversation('filtered-contender'),
    cwd: filteredRepo,
  })
  const boundBefore = filteredContender.binding
  await expectWorkspaceError(filteredContender.authorize({ access: 'write' }), ['blocked'])
  assert.ok(!existsSync(smudged), 'no checkout filter ran')
  assert.deepEqual(filteredContender.binding, boundBefore)
  assert.equal(
    ready(await filteredContender.authorize({ access: 'read' })).workspaceId,
    boundBefore.workspaceId,
    'the refusal left admission open'
  )
  assert.deepEqual(
    (await filteredLifecycle.inspect({})).flatMap(view => view.pending),
    [],
    'the refused allocation leaves no pending operation'
  )
  await filteredContender.close()
  await filteredOwner.close()
  await filteredLifecycle.close()
  checks.push(
    'a managed allocation refused for checkout filters before any Git effect keeps the binding and admission, runs no filter and leaves no pending operation'
  )

  // The default root must be the same for every installation, launch directory, data home
  // and HOME. Only the pure resolver module is imported, so nothing can open the root.
  const devRoot = new URL('..', import.meta.url)
  const secondInstallation = join(sandbox, 'second-installation')
  cpSync(new URL('src', devRoot), join(secondInstallation, 'src'), { recursive: true })
  cpSync(new URL('package.json', devRoot), join(secondInstallation, 'package.json'))
  const resolveDefaultRoot = (
    installation: URL,
    cwd: string,
    env: Readonly<Record<string, string>>
  ): string => {
    const resolver = new URL('src/workspace-authority-root.ts', installation).href
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { defaultAuthorityRoot } = await import(${JSON.stringify(resolver)})
        process.stdout.write(JSON.stringify(defaultAuthorityRoot()))`,
      ],
      { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 30000 }
    )
    if (result.status !== 0 || result.stdout.length === 0)
      throw new Error(`The default root was not resolved (${result.status}): ${result.stderr}`)
    const resolved: unknown = JSON.parse(result.stdout)
    if (typeof resolved !== 'string') throw new Error('The resolver returned a non-string root')
    return resolved
  }
  const elsewhere = join(sandbox, 'elsewhere')
  const otherHome = join(sandbox, 'other-home')
  mkdirSync(elsewhere)
  mkdirSync(otherHome)
  const fromFirst = resolveDefaultRoot(devRoot, repo, {
    DEV_DATA_HOME: join(sandbox, 'data-first-installation'),
  })
  const fromSecond = resolveDefaultRoot(pathToFileURL(`${secondInstallation}/`), elsewhere, {
    DEV_DATA_HOME: join(sandbox, 'data-second-installation'),
    HOME: otherHome,
  })
  const accountRoot = join(
    userInfo().homedir,
    'Library',
    'Application Support',
    'dev',
    'workspace-authority'
  )
  assert.equal(fromFirst, accountRoot, 'the default root derives from the OS account')
  assert.equal(fromSecond, fromFirst, 'a second installation resolves the same default root')
  for (const excluded of [fileURLToPath(devRoot), secondInstallation, repo, elsewhere, otherHome])
    assert.ok(!inside(excluded, fromFirst), `the default root is not under ${excluded}`)
  checks.push(
    'the default authority root, resolved from this checkout and from a copied second installation, is the same account-derived path regardless of launch directory, DEV_DATA_HOME or HOME, and is never opened by the check'
  )

  console.log(
    JSON.stringify(
      { result: 'passed', checks, authorityRoot: root, fixtureRepository: repo },
      null,
      2
    )
  )
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}
