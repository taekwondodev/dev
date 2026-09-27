import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
import { Schema } from 'effect'
import {
  WorkspaceError,
  type WorkspaceExecution,
  type WorkspaceExecutionFact,
  type WorkspaceGrant,
  type WorkspaceOperation,
} from '../src/workspace-domain.ts'
import { unsupportedAuthorityStorage } from '../src/workspace-authority.ts'
import type { StartWorkspaceWorker } from '../src/workspace-lifecycle.ts'
import {
  WorkspaceWorkerMessageSchema,
  type WorkspaceRpcOperation,
} from '../src/workspace-protocol.ts'
import { deferred, makeClaims } from './workspace-check-support.ts'
import {
  openLifecycle,
  type TestAttachment,
  type TestLifecycle,
} from './workspace-test-lifecycle.ts'

const isWorkerMessage = Schema.is(WorkspaceWorkerMessageSchema)

// Wraps the real worker at the lifecycle's seam. Once armed, it drops the next successful
// acknowledgment of one operation and terminates the worker, as a crash between the commit
// and its reply would. It recognizes acknowledgments with the protocol's own schema.
const faultInjector = () => {
  let started: Worker | undefined
  let armedFor: WorkspaceRpcOperation | undefined
  const dropped: WorkspaceRpcOperation[] = []
  const startWorker: StartWorkspaceWorker = (url, options) => {
    const worker = new Worker(url, options)
    started = worker
    return {
      postMessage: (value, transferList) => worker.postMessage(value, transferList),
      terminate: () => worker.terminate(),
      on: (event, listener) =>
        worker.on(
          event,
          event === 'message'
            ? (value: unknown) => {
                if (
                  armedFor !== undefined &&
                  isWorkerMessage(value) &&
                  !('type' in value) &&
                  value.ok &&
                  value.op === armedFor
                ) {
                  dropped.push(value.op)
                  armedFor = undefined
                  void worker.terminate()
                  return
                }
                listener(value)
              }
            : listener
        ),
    }
  }
  return {
    startWorker,
    dropped,
    dropNextAcknowledgment: (operation: WorkspaceRpcOperation) => {
      armedFor = operation
    },
    worker: (): Worker => {
      if (started === undefined) throw new Error('The lifecycle started no worker')
      return started
    },
  }
}

const inside = (parent: string, path: string) => {
  const offset = relative(parent, path)
  return offset === '' || (!offset.startsWith('..') && !isAbsolute(offset))
}

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'dev-workspace-authority-check-')))
const { claim, passed } = makeClaims()
const repo = join(sandbox, 'repo')
const root = join(sandbox, 'authority')
const moduleUrl = new URL('./workspace-test-lifecycle.ts', import.meta.url).href
const srcSpecifier = (module: string) =>
  JSON.stringify(new URL(`../src/${module}`, import.meta.url).href)
mkdirSync(repo)
const git = (args: readonly string[], cwd = repo): string => {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout.trim()
}
const initRepository = (path: string, file: string, content: string): string => {
  mkdirSync(path)
  git(['init', '--quiet', '-b', 'main'], path)
  git(['config', 'user.name', 'Workspace Authority Test'], path)
  git(['config', 'user.email', 'workspace-authority@example.invalid'], path)
  writeFileSync(join(path, file), content)
  git(['add', file], path)
  git(['commit', '--quiet', '-m', 'fixture'], path)
  return git(['rev-parse', 'HEAD'], path)
}
const conversation = (name: string) => {
  const dataHome = join(sandbox, `data-${name}`)
  mkdirSync(dataHome, { recursive: true })
  const sessionFile = join(dataHome, 'session.jsonl')
  writeFileSync(sessionFile, '{}\n', { mode: 0o600 })
  return { sessionId: `session-${name}`, sessionFile, dataHome }
}
const expectWorkspaceError = async (
  promise: Promise<unknown>,
  outcome: WorkspaceError['outcome']
) => {
  await assert.rejects(
    promise,
    error => error instanceof WorkspaceError && error.outcome === outcome
  )
}
const switchStage = async (reader: TestLifecycle, operationId: string) =>
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
  attachment: TestAttachment,
  grant: WorkspaceGrant,
  launched: WorkspaceExecution
) => {
  await attachment.reportExecution(grant, { kind: 'launch-intent', execution: launched })
  await attachment.reportExecution(grant, { kind: 'spawned', process: liveProcess })
  await attachment.reportExecution(grant, { kind: 'started' })
}
const endProcessUse = async (attachment: TestAttachment, grant: WorkspaceGrant) => {
  await attachment.reportExecution(grant, { kind: 'observed', processes: [] })
  await attachment.reportExecution(grant, {
    kind: 'quiescent',
    reason: 'fixture process family observed gone',
  })
}
const findUse = async (lifecycleValue: TestLifecycle, useId: string) =>
  (await lifecycleValue.inspect({})).flatMap(view => view.uses).find(use => use.id === useId)
const ready = (result: Awaited<ReturnType<TestAttachment['authorize']>>) => {
  if (result.kind !== 'ready') throw new Error(`Expected a ready grant, got ${result.kind}`)
  return result.grant
}
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

try {
  git(['init', '--quiet', '-b', 'main'])
  git(['config', 'user.name', 'Workspace Authority Test'])
  git(['config', 'user.email', 'workspace-authority@example.invalid'])
  writeFileSync(join(repo, 'tracked.txt'), 'committed fixture\n')
  writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n')
  git(['add', 'tracked.txt', '.gitignore'])
  git(['commit', '--quiet', '-m', 'fixture'])
  const commit = git(['rev-parse', 'HEAD'])

  const lifecycle = await openLifecycle({ root })
  const first = await lifecycle.attach({ conversation: conversation('first'), cwd: repo })
  const firstGrant = ready(await first.authorize({ kind: 'write' }))
  assert.equal(firstGrant.origin, 'pre-existing')
  assert.equal(firstGrant.checkout, realpathSync(repo))
  assert.ok(firstGrant.taskId && firstGrant.workspaceId && firstGrant.acquisitionId)
  writeFileSync(join(repo, 'tracked.txt'), 'staged working-tree edit\n')
  git(['add', 'tracked.txt'])
  writeFileSync(join(repo, 'untracked.txt'), 'untracked source data\n')
  writeFileSync(join(repo, 'ignored.txt'), 'ignored source data\n')

  await claim(
    'a reader in a second Node process coexists with the writer and is warned; a same-task duplicate writer is blocked',
    async () => {
      const childReaderConversation = conversation('subprocess-reader')
      const childWriterConversation = conversation('subprocess-writer')
      const subprocessEvidence = JSON.parse(
        await runChild(`
        import { openLifecycle } from ${JSON.stringify(moduleUrl)}
        const lifecycle = await openLifecycle({ root: ${JSON.stringify(root)} })
        const reader = await lifecycle.attach({ conversation: ${JSON.stringify(childReaderConversation)}, cwd: ${JSON.stringify(repo)} })
        const read = await reader.authorize({ kind: 'read' })
        const attemptedWriter = await lifecycle.attach({ conversation: ${JSON.stringify(childWriterConversation)}, cwd: ${JSON.stringify(repo)},
          selection: { taskId: ${JSON.stringify(firstGrant.taskId)}, workspaceId: ${JSON.stringify(firstGrant.workspaceId)} } })
          .then(async attachment => {
            try { await attachment.authorize({ kind: 'write' }); return 'unexpected-ready' }
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
    }
  )

  const activeContender = await claim(
    'an active foreign writer isolates a contender into an exact-HEAD worktree without transferring staged, untracked or ignored data; the host callback can reenter attach',
    async () => {
      const activeContenderConversation = conversation('normal-active-contender')
      const contender = await lifecycle.attach({
        conversation: activeContenderConversation,
        cwd: repo,
      })
      const activeDecision = await contender.authorize({ kind: 'write' })
      if (activeDecision.kind !== 'rebind') throw new Error('Contended writer was not isolated')
      const activeTarget = activeDecision.handoff.target
      assert.equal(activeTarget.origin, 'managed')
      assert.equal(git(['rev-parse', 'HEAD'], activeTarget.checkout), commit)
      let callbackSawBinding = false
      await contender.handoff(activeDecision.handoff, async target => {
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
      assert.equal(contender.binding.workspaceId, activeTarget.workspaceId)
      assert.equal(contender.binding.cwd, activeTarget.checkout)
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
      return contender
    }
  )

  const concurrentRepo = join(sandbox, 'concurrent-repo')
  const pausedCommit = initRepository(concurrentRepo, 'file.txt', 'fixture\n')
  await claim(
    'simultaneous cross-process repository provisioning converges on one identity',
    async () => {
      const provisionProbe = (name: string) => {
        const conversationValue = conversation(name)
        return runChild(`
        import { openLifecycle } from ${JSON.stringify(moduleUrl)}
        const lifecycle = await openLifecycle({ root: ${JSON.stringify(root)} })
        try {
          const attachment = await lifecycle.attach({ conversation: ${JSON.stringify(conversationValue)}, cwd: ${JSON.stringify(concurrentRepo)} })
          const result = await attachment.authorize({ kind: 'read' })
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
      const provisioned = await Promise.all([
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
    }
  )

  await claim(
    'a paused foreign reservation isolates a contender into an exact-HEAD worktree',
    async () => {
      const pausedOwner = await lifecycle.attach({
        conversation: conversation('paused-owner'),
        cwd: concurrentRepo,
      })
      ready(await pausedOwner.authorize({ kind: 'write' }))
      await pausedOwner.close()
      const pausedContender = await lifecycle.attach({
        conversation: conversation('paused-contender'),
        cwd: concurrentRepo,
      })
      const pausedDecision = await pausedContender.authorize({ kind: 'write' })
      if (pausedDecision.kind !== 'rebind') throw new Error('Paused reservation was not isolated')
      assert.equal(pausedDecision.handoff.target.origin, 'managed')
      assert.equal(git(['rev-parse', 'HEAD'], pausedDecision.handoff.target.checkout), pausedCommit)
      await pausedContender.handoff(pausedDecision.handoff, async () => 'confirmed')
      assert.equal(pausedContender.binding.workspaceId, pausedDecision.handoff.target.workspaceId)
      await pausedContender.close()
    }
  )

  const { readerOne, readerTwo, delegated, delegatedGrant } = await claim(
    'readers share the live checkout; each delegated writer gets a distinct detached exact-commit worktree',
    async () => {
      const firstReader = await lifecycle.attach({
        conversation: conversation('reader-one'),
        cwd: repo,
      })
      const readerOneResult = await firstReader.authorize({ kind: 'read' })
      assert.equal(readerOneResult.kind, 'ready')
      assert.match(readerOneResult.warning ?? '', /writer owns this live checkout/)
      const secondReader = await lifecycle.attach({
        conversation: conversation('reader-two'),
        cwd: repo,
      })
      assert.equal((await secondReader.authorize({ kind: 'read' })).kind, 'ready')

      const delegating = await lifecycle.attach({
        conversation: conversation('delegated'),
        cwd: repo,
      })
      const delegatedResult = ready(await delegating.authorize({ kind: 'delegated-write' }))
      assert.equal(delegatedResult.origin, 'managed')
      assert.notEqual(delegatedResult.checkout, firstGrant.checkout)
      assert.equal(git(['rev-parse', 'HEAD'], delegatedResult.checkout), commit)
      assert.notEqual(delegatedResult.workspaceId, firstGrant.workspaceId)
      const secondDelegated = ready(await delegating.authorize({ kind: 'delegated-write' }))
      assert.notEqual(secondDelegated.workspaceId, delegatedResult.workspaceId)
      assert.equal(git(['rev-parse', 'HEAD'], secondDelegated.checkout), commit)
      return {
        readerOne: firstReader,
        readerTwo: secondReader,
        delegated: delegating,
        delegatedGrant: delegatedResult,
      }
    }
  )

  const isolatedAuthorityPath = join(sandbox, 'isolated-authority')
  await claim(
    'a process use settles only when never released or after an observed empty family; a started use closed by its host is recorded unknown',
    async () => {
      const isolatedRoot = await openLifecycle({ root: isolatedAuthorityPath })
      assert.deepEqual(await isolatedRoot.inspect({}), [])
      const isolatedAttachment = await isolatedRoot.attach({
        conversation: conversation('isolated-root'),
        cwd: repo,
      })
      const isolatedRead = ready(await isolatedAttachment.authorize({ kind: 'read' }))
      assert.notEqual(isolatedRead.repositoryId, firstGrant.repositoryId)
      const isolatedWrite = ready(await isolatedAttachment.authorize({ kind: 'write' }))
      const isolatedExecution = (attemptId: string) => ({
        sessionId: 'isolated-session',
        taskKey: 'isolated-task',
        attemptId,
        generation: attemptId,
        logs: join(sandbox, `${attemptId}.log`),
      })
      const failedSpawn = ready(
        await isolatedAttachment.authorize({
          kind: 'write',
          execution: isolatedExecution('failed-spawn'),
        })
      )
      assert.equal(failedSpawn.acquisitionId, isolatedWrite.acquisitionId)
      await isolatedAttachment.reportExecution(failedSpawn, {
        kind: 'launch-failed',
        reason: 'fork error',
      })
      const controlled = ready(
        await isolatedAttachment.authorize({
          kind: 'write',
          execution: isolatedExecution('controlled-exit'),
        })
      )
      await isolatedAttachment.reportExecution(controlled, {
        kind: 'launch-intent',
        execution: isolatedExecution('controlled-exit'),
      })
      await isolatedAttachment.reportExecution(controlled, {
        kind: 'spawned',
        process: { pid: 41002, parent: 40000, group: 41002, birth: 'fixture-birth-2' },
      })
      await isolatedAttachment.reportExecution(controlled, { kind: 'started' })
      await expectWorkspaceError(
        isolatedAttachment.reportExecution(controlled, {
          kind: 'quiescent',
          reason: 'process exited, family never observed',
        }),
        'review-required'
      )
      await isolatedAttachment.reportExecution(controlled, {
        kind: 'observed',
        processes: [{ pid: 41004, parent: 41002, group: 41002, birth: 'fixture-descendant' }],
      })
      await expectWorkspaceError(
        isolatedAttachment.reportExecution(controlled, {
          kind: 'quiescent',
          reason: 'a descendant was still observed',
        }),
        'review-required'
      )
      await isolatedAttachment.reportExecution(controlled, { kind: 'observed', processes: [] })
      await isolatedAttachment.reportExecution(controlled, {
        kind: 'quiescent',
        reason: 'process family observed gone',
      })
      const settled = (await isolatedRoot.inspect({ taskId: isolatedWrite.taskId })).flatMap(
        view => view.uses
      )
      assert.equal(settled.find(use => use.id === failedSpawn.useId)?.stage, 'quiescent')
      assert.equal(settled.find(use => use.id === controlled.useId)?.stage, 'quiescent')
      const uncertainAtClose = ready(
        await isolatedAttachment.authorize({
          kind: 'write',
          execution: isolatedExecution('host-close'),
        })
      )
      await isolatedAttachment.reportExecution(uncertainAtClose, {
        kind: 'launch-intent',
        execution: isolatedExecution('host-close'),
      })
      await isolatedAttachment.reportExecution(uncertainAtClose, {
        kind: 'spawned',
        process: { pid: 41003, parent: 40000, group: 41003, birth: 'fixture-birth-3' },
      })
      await isolatedAttachment.reportExecution(uncertainAtClose, { kind: 'started' })
      await isolatedAttachment.close()
      const isolatedObservation = await isolatedRoot.inspect({ taskId: isolatedWrite.taskId })
      assert.equal(
        isolatedObservation
          .flatMap(view => view.uses)
          .find(use => use.id === uncertainAtClose.useId)?.stage,
        'unknown'
      )
      await isolatedRoot.close()
    }
  )

  await claim('non-private and symlinked authority roots are rejected', async () => {
    chmodSync(isolatedAuthorityPath, 0o755)
    const unsafeAuthority = await openLifecycle({ root: isolatedAuthorityPath })
    await expectWorkspaceError(unsafeAuthority.inspect({}), 'unavailable')
    await unsafeAuthority.close()
    const authorityAlias = join(sandbox, 'authority-symlink')
    symlinkSync(isolatedAuthorityPath, authorityAlias, 'dir')
    const aliasInspector = await openLifecycle({ root: authorityAlias })
    await expectWorkspaceError(aliasInspector.inspect({}), 'unavailable')
    await aliasInspector.close()
  })

  await claim(
    'known unsupported authority storage is refused: synchronized folders, network mounts and non-APFS/HFS volumes',
    () => {
      const home = '/Users/fixture'
      const mountTable = [
        '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
        '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse)',
        '//fixture@server/share on /Volumes/Shared Work (smbfs, nodev, nosuid, mounted by fixture)',
        '/dev/disk9s1 on /Volumes/USB (exfat, local, nodev, nosuid, noowners)',
      ].join('\n')
      const storage = (path: string) => unsupportedAuthorityStorage({ path, home, mountTable })
      assert.equal(
        storage(`${home}/Library/Application Support/dev/workspace-authority`),
        undefined
      )
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
    }
  )

  const execution = {
    sessionId: 'session-first',
    taskKey: 'task-first',
    attemptId: 'attempt-1',
    generation: 'generation-1',
    logs: join(sandbox, 'logs-first'),
  }
  const executionGrant = ready(await first.authorize({ kind: 'write', execution }))
  await claim(
    "a child's validation accepts the parent's live grant and refuses a malformed grant as invalid and a moved one for review",
    async () => {
      assert.notEqual(executionGrant.useId, firstGrant.useId)
      assert.equal(executionGrant.acquisitionId, firstGrant.acquisitionId)
      await lifecycle.validate(executionGrant)
      await expectWorkspaceError(
        lifecycle.validate({ ...executionGrant, cwd: sandbox }),
        'review-required'
      )
      await expectWorkspaceError(
        lifecycle.validate({
          ...firstGrant,
          workspaceId: 'not-a-uuid',
        } as unknown as WorkspaceGrant),
        'invalid'
      )
    }
  )

  await claim(
    'an unknown process use absorbs every later observation and quiescence report',
    async () => {
      await expectWorkspaceError(
        first.reportExecution(executionGrant, {
          kind: 'surprise',
        } as unknown as WorkspaceExecutionFact),
        'invalid'
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
        'review-required'
      )
      await expectWorkspaceError(
        first.reportExecution(executionGrant, { kind: 'quiescent', reason: 'empty-process-list' }),
        'review-required'
      )
      assert.equal((await findUse(lifecycle, executionGrant.useId))?.stage, 'unknown')
    }
  )

  await claim(
    'an unknown use blocks its checkout, isolating a contender instead of admitting it; inspection is read-only',
    async () => {
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
      const unresolvedDecision = await unresolvedContender.authorize({ kind: 'write' })
      if (unresolvedDecision.kind !== 'rebind')
        throw new Error('A writer contending with an unknown use was not isolated')
      assert.equal(git(['rev-parse', 'HEAD'], unresolvedDecision.handoff.target.checkout), commit)
      await unresolvedContender.handoff(unresolvedDecision.handoff, async () => 'cancelled')
      await unresolvedContender.close()
      assert.deepEqual(await lifecycle.inspect({ taskId: firstGrant.taskId }), beforeClose)
    }
  )
  await Promise.all([
    first.close(),
    readerOne.close(),
    readerTwo.close(),
    delegated.close(),
    activeContender.close(),
  ])
  await lifecycle.close()

  await claim(
    'uncertainty and reservations survive close/reopen; a new conversation does not auto-select a task; resume requires an exact selection and a fresh acquisition; a pending handoff reopens only at its target',
    async () => {
      const reopened = await openLifecycle({ root })
      const afterRestart = await reopened.inspect({ taskId: firstGrant.taskId })
      assert.ok(
        afterRestart.some(
          view => view.workspaceId === firstGrant.workspaceId && view.outcome === 'blocked'
        )
      )
      const retained = await reopened.inspect({ taskId: delegatedGrant.taskId })
      assert.ok(
        retained.some(
          view =>
            view.workspaceId === delegatedGrant.workspaceId &&
            view.outcome === 'preserved-for-resume'
        )
      )
      const freshSession = await reopened.attach({
        conversation: conversation('fresh-session'),
        cwd: repo,
      })
      assert.equal(freshSession.binding.workspaceId, firstGrant.workspaceId)
      assert.notEqual(freshSession.binding.workspaceId, delegatedGrant.workspaceId)
      await freshSession.close()
      await expectWorkspaceError(
        reopened.attach({
          conversation: conversation('first'),
          cwd: repo,
          selection: { taskId: firstGrant.taskId!, workspaceId: firstGrant.workspaceId },
        }),
        'blocked'
      )
      const resumed = await reopened.attach({
        conversation: conversation('delegated'),
        cwd: repo,
        selection: {
          taskId: delegatedGrant.taskId!,
          workspaceId: delegatedGrant.workspaceId,
        },
      })
      const resumedGrant = ready(await resumed.authorize({ kind: 'write' }))
      assert.equal(resumedGrant.workspaceId, delegatedGrant.workspaceId)
      assert.equal(resumedGrant.checkout, delegatedGrant.checkout)
      assert.notEqual(resumedGrant.acquisitionId, delegatedGrant.acquisitionId)
      await expectWorkspaceError(reopened.validate(delegatedGrant), 'review-required')
      await resumed.close()
      const handoffSession = await reopened.attach({
        conversation: conversation('handoff-session'),
        cwd: repo,
      })
      const transition = await handoffSession.select({
        taskId: delegatedGrant.taskId!,
        workspaceId: delegatedGrant.workspaceId,
      })
      assert.equal(
        transition.reason,
        'Explicit task selection. The existing workspace and its contents will be used; no files are transferred'
      )
      await handoffSession.close()
      const reopenedHandoff = await reopened.attach({
        conversation: conversation('handoff-session'),
        cwd: transition.target.checkout,
        selection: {
          taskId: transition.target.taskId!,
          workspaceId: transition.target.workspaceId,
        },
      })
      assert.equal(reopenedHandoff.binding.workspaceId, transition.target.workspaceId)
      await reopenedHandoff.handoff(transition, async () => 'confirmed')
      assert.equal(reopenedHandoff.binding.workspaceId, delegatedGrant.workspaceId)
      await reopenedHandoff.close()
      assert.equal((await reopened.inspect({})).filter(view => view.origin === 'managed').length, 5)
      await reopened.close()
    }
  )

  await claim('corrupt use and catalog payloads are reported, not reinitialized', async () => {
    const corruptLifecycle = await openLifecycle({ root: join(sandbox, 'corrupt-authority') })
    const corruptAttachment = await corruptLifecycle.attach({
      conversation: conversation('corrupt'),
      cwd: repo,
    })
    const corruptGrant = ready(await corruptAttachment.authorize({ kind: 'read' }))
    const shardPath = join(
      sandbox,
      'corrupt-authority',
      'repos',
      corruptGrant.repositoryId,
      'records.sqlite'
    )
    await corruptAttachment.close()
    await corruptLifecycle.close()
    const shard = new DatabaseSync(shardPath)
    let originalUsePayload = ''
    try {
      const payload = shard
        .prepare('SELECT payload FROM uses WHERE id=?')
        .get(corruptGrant.useId)?.payload
      if (typeof payload !== 'string') throw new Error('Corruption fixture use payload missing')
      originalUsePayload = payload
      shard.prepare('UPDATE uses SET payload=? WHERE id=?').run('[]', corruptGrant.useId)
    } finally {
      shard.close()
    }
    const corruptInspector = await openLifecycle({ root: join(sandbox, 'corrupt-authority') })
    await expectWorkspaceError(corruptInspector.inspect({}), 'review-required')
    await corruptInspector.close()
    const repairedShard = new DatabaseSync(shardPath)
    repairedShard
      .prepare('UPDATE uses SET payload=? WHERE id=?')
      .run(originalUsePayload, corruptGrant.useId)
    repairedShard.close()
    const catalogPath = join(sandbox, 'corrupt-authority', 'catalog.sqlite')
    const catalog = new DatabaseSync(catalogPath)
    catalog
      .prepare('UPDATE repositories SET payload=? WHERE id=?')
      .run('[]', corruptGrant.repositoryId)
    catalog.close()
    const corruptCatalogInspector = await openLifecycle({
      root: join(sandbox, 'corrupt-authority'),
    })
    await expectWorkspaceError(corruptCatalogInspector.inspect({}), 'review-required')
    await corruptCatalogInspector.close()
  })

  const failureRepo = join(sandbox, 'failure-repo')
  initRepository(failureRepo, 'file.txt', 'durable failure fixture\n')

  await claim(
    'worker death and a lost commit acknowledgment preserve the durable authorized use',
    async () => {
      const deathRoot = join(sandbox, 'worker-death-authority')
      const death = faultInjector()
      const deathLifecycle = await openLifecycle({
        root: deathRoot,
        startWorker: death.startWorker,
      })
      const deathAttachment = await deathLifecycle.attach({
        conversation: conversation('worker-death'),
        cwd: failureRepo,
      })
      const deathGrant = ready(await deathAttachment.authorize({ kind: 'write' }))
      await death.worker().terminate()
      await expectWorkspaceError(deathLifecycle.inspect({}), 'unavailable')
      await deathLifecycle.close()
      const deathRecovery = await openLifecycle({ root: deathRoot })
      assert.equal((await findUse(deathRecovery, deathGrant.useId))?.stage, 'authorized')
      await deathRecovery.close()

      const lostAckRoot = join(sandbox, 'lost-ack-authority')
      const lostAck = faultInjector()
      const lostAckLifecycle = await openLifecycle({
        root: lostAckRoot,
        startWorker: lostAck.startWorker,
      })
      const lostAckAttachment = await lostAckLifecycle.attach({
        conversation: conversation('lost-ack'),
        cwd: failureRepo,
      })
      lostAck.dropNextAcknowledgment('authorize')
      await expectWorkspaceError(lostAckAttachment.authorize({ kind: 'write' }), 'unavailable')
      assert.deepEqual(lostAck.dropped, ['authorize'], 'the authorize acknowledgment was dropped')
      const lostAckBinding = lostAckAttachment.binding
      await lostAckLifecycle.close()
      const lostAckRecovery = await openLifecycle({ root: lostAckRoot })
      const lostAckViews = await lostAckRecovery.inspect({})
      assert.ok(
        lostAckViews.some(
          view =>
            view.workspaceId === lostAckBinding.workspaceId &&
            view.uses.some(use => use.stage === 'authorized')
        )
      )
      await lostAckRecovery.close()
    }
  )

  const scopedRepo = join(sandbox, 'scoped-repo')
  const linkedRepo = join(sandbox, 'linked-repo')
  const scopedCommit = initRepository(scopedRepo, 'tracked.txt', 'before scoped operation\n')
  git(['worktree', 'add', '--quiet', '-b', 'linked-scope', linkedRepo, scopedCommit], scopedRepo)

  const scopedRoot = join(sandbox, 'scoped-authority')
  const scopedLifecycle = await openLifecycle({ root: scopedRoot })
  const scopedPrimary = await scopedLifecycle.attach({
    conversation: conversation('scoped-primary'),
    cwd: scopedRepo,
  })
  const scopedSibling = await scopedLifecycle.attach({
    conversation: conversation('scoped-sibling'),
    cwd: linkedRepo,
  })
  const primaryGrant = ready(await scopedPrimary.authorize({ kind: 'write' }))
  const siblingGrant = ready(await scopedSibling.authorize({ kind: 'write' }))
  assert.notEqual(primaryGrant.workspaceId, siblingGrant.workspaceId)
  assert.equal(primaryGrant.repositoryId, siblingGrant.repositoryId)

  const nativeWrite = ready(
    await scopedPrimary.authorize({
      kind: 'native-file-write',
      within: primaryGrant,
      path: 'tracked.txt',
    })
  )
  await scopedPrimary.reportExecution(nativeWrite, { kind: 'operation-started' })
  await claim(
    'a live native write in one worktree fences neither a shell nor an allocation in a linked worktree of the same repository',
    async () => {
      assert.equal((await findUse(scopedLifecycle, nativeWrite.useId))?.stage, 'operation-started')
      const siblingShellExecution = processExecution('sibling-shell')
      const siblingShell = ready(
        await scopedSibling.authorize({
          kind: 'opaque',
          within: siblingGrant,
          execution: siblingShellExecution,
        })
      )
      await startProcessUse(scopedSibling, siblingShell, siblingShellExecution)
      const concurrentAllocation = ready(await scopedSibling.authorize({ kind: 'delegated-write' }))
      assert.equal(concurrentAllocation.origin, 'managed')
      assert.equal(git(['rev-parse', 'HEAD'], concurrentAllocation.checkout), scopedCommit)
      await endProcessUse(scopedSibling, siblingShell)
    }
  )

  await claim(
    'native operations record exact start/completion facts, and a stale report cannot release a later use',
    async () => {
      await expectWorkspaceError(
        scopedPrimary.reportExecution(nativeWrite, { kind: 'operation-started' }),
        'review-required'
      )
      writeFileSync(join(scopedRepo, 'tracked.txt'), 'exact admitted native edit\n')
      await scopedPrimary.reportExecution(nativeWrite, { kind: 'operation-completed' })
      await expectWorkspaceError(
        scopedPrimary.reportExecution(nativeWrite, { kind: 'operation-started' }),
        'review-required'
      )
      const laterNativeWrite = ready(
        await scopedPrimary.authorize({
          kind: 'native-file-write',
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
        'review-required'
      )
      assert.equal(
        (await findUse(scopedLifecycle, laterNativeWrite.useId))?.stage,
        'operation-started'
      )
      await scopedPrimary.reportExecution(laterNativeWrite, { kind: 'operation-completed' })
      const completedNative = await findUse(scopedLifecycle, nativeWrite.useId)
      assert.equal(completedNative?.stage, 'quiescent')
      assert.equal(completedNative?.path, join(scopedRepo, 'tracked.txt'))
    }
  )

  await claim(
    'scoped operations are admitted only within an ordinary grant, and the worker refuses a shell without process identity or a relative cwd and keeps serving',
    async () => {
      const nativeInsideNative = ready(
        await scopedPrimary.authorize({
          kind: 'native-file-write',
          within: primaryGrant,
          path: 'outer.txt',
        })
      )
      await expectWorkspaceError(
        scopedPrimary.authorize({
          kind: 'native-file-write',
          within: nativeInsideNative,
          path: 'inner.txt',
        }),
        'invalid'
      )
      await scopedPrimary.reportExecution(nativeInsideNative, { kind: 'operation-completed' })
      const primaryExecution = processExecution('primary-agent')
      const primaryAgent = ready(
        await scopedPrimary.authorize({ kind: 'write', execution: primaryExecution })
      )
      await expectWorkspaceError(
        scopedPrimary.authorize({
          kind: 'opaque',
          within: primaryAgent,
          execution: processExecution('nested-in-agent'),
        }),
        'invalid'
      )
      await scopedPrimary.reportExecution(primaryAgent, {
        kind: 'launch-failed',
        reason: 'not launched',
      })
      await expectWorkspaceError(
        scopedPrimary.authorize({
          kind: 'opaque',
          within: primaryGrant,
        } as unknown as WorkspaceOperation),
        'invalid'
      )
      await expectWorkspaceError(
        scopedPrimary.authorize({ kind: 'read', cwd: 'tracked' }),
        'invalid'
      )
      assert.equal((await scopedPrimary.authorize({ kind: 'read' })).kind, 'ready')
    }
  )

  const primaryShell = await claim(
    'the checkout writer keeps its grant, native writes and readers beside its own live shell, and may run concurrent shells',
    async () => {
      const primaryShellExecution = processExecution('primary-shell')
      const shell = ready(
        await scopedPrimary.authorize({
          kind: 'opaque',
          within: primaryGrant,
          execution: primaryShellExecution,
        })
      )
      assert.equal(
        ready(await scopedPrimary.authorize({ kind: 'write' })).useId,
        primaryGrant.useId
      )
      const besideShell = ready(
        await scopedPrimary.authorize({
          kind: 'native-file-write',
          within: primaryGrant,
          path: 'tracked.txt',
        })
      )
      await scopedPrimary.reportExecution(besideShell, { kind: 'operation-started' })
      await scopedPrimary.reportExecution(besideShell, { kind: 'operation-completed' })
      const ownRead = await scopedPrimary.authorize({ kind: 'read' })
      assert.equal(ownRead.kind === 'ready' ? ownRead.warning : 'rebind', undefined)
      const shellReader = await scopedLifecycle.attach({
        conversation: conversation('shell-reader'),
        cwd: scopedRepo,
      })
      const shellReaderResult = await shellReader.authorize({ kind: 'read' })
      assert.equal(shellReaderResult.kind, 'ready')
      assert.match(
        shellReaderResult.kind === 'ready' ? (shellReaderResult.warning ?? '') : '',
        /writer owns/
      )
      await shellReader.close()
      await startProcessUse(scopedPrimary, shell, primaryShellExecution)
      const secondShellExecution = processExecution('second-primary-shell')
      const secondShell = ready(
        await scopedPrimary.authorize({
          kind: 'opaque',
          within: primaryGrant,
          execution: secondShellExecution,
        })
      )
      await startProcessUse(scopedPrimary, secondShell, secondShellExecution)
      await endProcessUse(scopedPrimary, secondShell)
      await scopedPrimary.reportExecution(shell, {
        kind: 'unknown',
        reason: 'test-shell-observation-lost',
      })
      await expectWorkspaceError(
        scopedPrimary.reportExecution(shell, { kind: 'observed', processes: [] }),
        'review-required'
      )
      return shell
    }
  )
  await scopedPrimary.close()
  await scopedSibling.close()
  await scopedLifecycle.close()

  await claim(
    'an unknown shell survives reopen and blocks only its own checkout: a contender there is isolated, while a linked worktree resumes, runs a shell and allocates',
    async () => {
      const scopedRecovery = await openLifecycle({ root: scopedRoot })
      const unknownShell = await findUse(scopedRecovery, primaryShell.useId)
      assert.equal(unknownShell?.stage, 'unknown')
      assert.equal(unknownShell?.reason, 'test-shell-observation-lost')
      const shellContender = await scopedRecovery.attach({
        conversation: conversation('shell-contender'),
        cwd: scopedRepo,
      })
      const shellContention = await shellContender.authorize({ kind: 'write' })
      if (shellContention.kind !== 'rebind')
        throw new Error('A writer contending with an unknown shell was not isolated')
      assert.equal(
        git(['rev-parse', 'HEAD'], shellContention.handoff.target.checkout),
        scopedCommit
      )
      await shellContender.handoff(shellContention.handoff, async () => 'cancelled')
      await shellContender.close()
      const linkedResume = await scopedRecovery.attach({
        conversation: conversation('linked-resume'),
        cwd: linkedRepo,
        selection: { taskId: siblingGrant.taskId!, workspaceId: siblingGrant.workspaceId },
      })
      const linkedWrite = ready(await linkedResume.authorize({ kind: 'write' }))
      const linkedShellExecution = processExecution('linked-shell')
      const linkedShell = ready(
        await linkedResume.authorize({
          kind: 'opaque',
          within: linkedWrite,
          execution: linkedShellExecution,
        })
      )
      await startProcessUse(linkedResume, linkedShell, linkedShellExecution)
      await endProcessUse(linkedResume, linkedShell)
      assert.equal(
        ready(await linkedResume.authorize({ kind: 'delegated-write' })).origin,
        'managed'
      )
      await linkedResume.close()
      await scopedRecovery.close()
    }
  )

  await claim(
    "the repository structure gate serializes dev's own worktree allocation, not shell operations",
    async () => {
      const structureRoot = join(sandbox, 'structure-authority')
      const structureLifecycle = await openLifecycle({ root: structureRoot })
      const structureAttachment = await structureLifecycle.attach({
        conversation: conversation('structure'),
        cwd: linkedRepo,
      })
      const structureWrite = ready(await structureAttachment.authorize({ kind: 'write' }))
      const structuralLock = new DatabaseSync(
        join(structureRoot, 'gates', 'repos', structureWrite.repositoryId, 'structure.sqlite'),
        { timeout: 0 }
      )
      try {
        structuralLock.exec('BEGIN EXCLUSIVE')
        const structureShellExecution = processExecution('structure-shell')
        const structureShell = ready(
          await structureAttachment.authorize({
            kind: 'opaque',
            within: structureWrite,
            execution: structureShellExecution,
          })
        )
        await startProcessUse(structureAttachment, structureShell, structureShellExecution)
        await endProcessUse(structureAttachment, structureShell)
        await expectWorkspaceError(
          structureAttachment.authorize({ kind: 'delegated-write' }),
          'blocked'
        )
        ready(await structureAttachment.authorize({ kind: 'read' }))
        assert.equal(
          ready(await structureAttachment.authorize({ kind: 'write' })).useId,
          structureWrite.useId,
          'an allocation refused before any Git effect leaves the conversation admitted'
        )
      } finally {
        structuralLock.close()
      }
      await structureAttachment.close()
      await structureLifecycle.close()
    }
  )

  await claim(
    'a lost scoped operation-start acknowledgment leaves its use durably operation-started',
    async () => {
      const scopedLostAckRoot = join(sandbox, 'scoped-lost-ack-authority')
      const scopedLostAck = faultInjector()
      const scopedLostAckLifecycle = await openLifecycle({
        root: scopedLostAckRoot,
        startWorker: scopedLostAck.startWorker,
      })
      const scopedLostAckAttachment = await scopedLostAckLifecycle.attach({
        conversation: conversation('scoped-lost-ack'),
        cwd: failureRepo,
      })
      const scopedLostAckParent = ready(await scopedLostAckAttachment.authorize({ kind: 'write' }))
      const scopedLostAckOperation = ready(
        await scopedLostAckAttachment.authorize({
          kind: 'native-file-write',
          within: scopedLostAckParent,
          path: 'file.txt',
        })
      )
      scopedLostAck.dropNextAcknowledgment('report-execution')
      await expectWorkspaceError(
        scopedLostAckAttachment.reportExecution(scopedLostAckOperation, {
          kind: 'operation-started',
        }),
        'unavailable'
      )
      assert.deepEqual(
        scopedLostAck.dropped,
        ['report-execution'],
        'the operation-start acknowledgment was dropped'
      )
      await scopedLostAckLifecycle.close()
      const scopedLostAckRecovery = await openLifecycle({ root: scopedLostAckRoot })
      const scopedLostAckUse = await findUse(scopedLostAckRecovery, scopedLostAckOperation.useId)
      assert.equal(scopedLostAckUse?.effect, 'native-file-write')
      assert.equal(scopedLostAckUse?.stage, 'operation-started')
      await scopedLostAckRecovery.close()
    }
  )

  const traversalRepo = join(sandbox, 'traversal-repo')
  const traversalOutside = join(sandbox, 'traversal-outside')
  mkdirSync(join(traversalOutside, 'inner'), { recursive: true })
  initRepository(traversalRepo, 'tracked.txt', 'traversal fixture\n')
  symlinkSync(join(traversalOutside, 'inner'), join(traversalRepo, 'link'))
  const traversalLifecycle = await openLifecycle({ root: join(sandbox, 'traversal-authority') })
  const traversalAttachment = await traversalLifecycle.attach({
    conversation: conversation('traversal'),
    cwd: traversalRepo,
  })
  const traversalParent = ready(await traversalAttachment.authorize({ kind: 'write' }))
  const nativeWriteTo = (path: string) =>
    traversalAttachment.authorize({
      kind: 'native-file-write',
      within: traversalParent,
      path,
    })
  await claim(
    'raw parent traversal, Pi path shorthand and a destination inside a nested repository are refused, as at the child tool boundary; an admitted native write carries its exact destination',
    async () => {
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
        '\u00a0alias/escape.txt',
      ])
        await expectWorkspaceError(nativeWriteTo(requested), 'invalid')
      assert.ok(!existsSync(join(traversalOutside, 'escape.txt')))
      assert.ok(!existsSync(join(traversalOutside, 'inner', 'escape.txt')))
      mkdirSync(join(traversalRepo, 'vendor', '.git'), { recursive: true })
      await expectWorkspaceError(nativeWriteTo('vendor/escape.txt'), 'invalid')
      const traversalAdmitted = ready(await nativeWriteTo('tracked.txt'))
      assert.equal(traversalAdmitted.path, join(traversalRepo, 'tracked.txt'))
      await traversalAttachment.reportExecution(traversalAdmitted, { kind: 'operation-started' })
      await traversalAttachment.reportExecution(traversalAdmitted, { kind: 'operation-completed' })
    }
  )
  await claim('a directory link inside the checkout resolves to its real destination', async () => {
    mkdirSync(join(traversalRepo, 'sub'))
    symlinkSync(join(traversalRepo, 'sub'), join(traversalRepo, 'inlink'))
    const insideLink = ready(await nativeWriteTo('inlink/new.txt'))
    assert.equal(insideLink.path, join(traversalRepo, 'sub', 'new.txt'))
    await traversalAttachment.reportExecution(insideLink, { kind: 'operation-completed' })
    assert.equal((await findUse(traversalLifecycle, insideLink.useId))?.stage, 'quiescent')
  })
  await claim(
    'a destination or any ancestor directory replaced by a link after authorization is refused at the start boundary',
    async () => {
      const swapTarget = ready(await nativeWriteTo('swap.txt'))
      writeFileSync(join(traversalOutside, 'inner', 'captured.txt'), 'must not be overwritten\n')
      symlinkSync(join(traversalOutside, 'inner', 'captured.txt'), join(traversalRepo, 'swap.txt'))
      await expectWorkspaceError(
        traversalAttachment.reportExecution(swapTarget, { kind: 'operation-started' }),
        'blocked'
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
          'blocked'
        )
        await traversalAttachment.reportExecution(ancestorTarget, {
          kind: 'unknown',
          reason: 'destination changed before start',
        })
        rmSync(join(traversalRepo, 'ancestor'))
      }
    }
  )
  await traversalAttachment.close()
  await traversalLifecycle.close()

  const fenceRepo = join(sandbox, 'fence-repo')
  const fenceLinked = join(sandbox, 'fence-linked')
  const fenceCommit = initRepository(fenceRepo, 'tracked.txt', 'fence fixture\n')
  git(['worktree', 'add', '--quiet', '-b', 'fence-linked', fenceLinked, fenceCommit], fenceRepo)

  await claim(
    'a live ordinary write execution isolates a contender from its checkout and fences nothing in a linked worktree, in-process or from another process',
    async () => {
      const fenceRoot = join(sandbox, 'fence-authority')
      const fenceLifecycle = await openLifecycle({ root: fenceRoot })
      const fencePrimary = await fenceLifecycle.attach({
        conversation: conversation('fence-primary'),
        cwd: fenceRepo,
      })
      ready(await fencePrimary.authorize({ kind: 'write' }))
      const fenceAgentExecution = processExecution('fence-agent')
      const fenceAgent = ready(
        await fencePrimary.authorize({ kind: 'write', execution: fenceAgentExecution })
      )
      await startProcessUse(fencePrimary, fenceAgent, fenceAgentExecution)
      const fenceContender = await fenceLifecycle.attach({
        conversation: conversation('fence-contender'),
        cwd: fenceRepo,
      })
      const fenceContention = await fenceContender.authorize({ kind: 'write' })
      if (fenceContention.kind !== 'rebind')
        throw new Error('A live write execution did not isolate a contender')
      await fenceContender.handoff(fenceContention.handoff, async () => 'cancelled')
      await fenceContender.close()
      const fenceSibling = await fenceLifecycle.attach({
        conversation: conversation('fence-sibling'),
        cwd: fenceLinked,
      })
      const fenceSiblingWrite = ready(await fenceSibling.authorize({ kind: 'write' }))
      const fenceSiblingShellExecution = processExecution('fence-sibling-shell')
      const fenceSiblingShell = ready(
        await fenceSibling.authorize({
          kind: 'opaque',
          within: fenceSiblingWrite,
          execution: fenceSiblingShellExecution,
        })
      )
      await startProcessUse(fenceSibling, fenceSiblingShell, fenceSiblingShellExecution)
      await endProcessUse(fenceSibling, fenceSiblingShell)
      await fenceSibling.close()
      const fenceCrossProcess = await runChild(`
        import { openLifecycle } from ${JSON.stringify(moduleUrl)}
        const lifecycle = await openLifecycle({ root: ${JSON.stringify(fenceRoot)} })
        const attachment = await lifecycle.attach({
          conversation: ${JSON.stringify(conversation('fence-cross-process'))},
          cwd: ${JSON.stringify(fenceLinked)},
          selection: ${JSON.stringify({ taskId: fenceSiblingWrite.taskId, workspaceId: fenceSiblingWrite.workspaceId })},
        })
        const write = await attachment.authorize({ kind: 'write' })
        const shell = await attachment.authorize({
          kind: 'opaque', within: write.grant,
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
    }
  )

  await claim(
    'closing with a live dependent records both it and its parent unknown, not quiescent, so the checkout is reported blocked',
    async () => {
      const closeRoot = join(sandbox, 'close-nesting-authority')
      const closeLifecycle = await openLifecycle({ root: closeRoot })
      const closeAttachment = await closeLifecycle.attach({
        conversation: conversation('close-nesting'),
        cwd: fenceRepo,
      })
      const closeParent = ready(await closeAttachment.authorize({ kind: 'write' }))
      const closeDependent = ready(
        await closeAttachment.authorize({
          kind: 'native-file-write',
          within: closeParent,
          path: 'tracked.txt',
        })
      )
      await closeAttachment.reportExecution(closeDependent, { kind: 'operation-started' })
      await closeAttachment.close()
      await closeLifecycle.close()
      const closeRecovery = await openLifecycle({ root: closeRoot })
      assert.equal((await findUse(closeRecovery, closeDependent.useId))?.stage, 'unknown')
      assert.equal((await findUse(closeRecovery, closeParent.useId))?.stage, 'unknown')
      assert.equal(
        (await closeRecovery.inspect({})).find(view => view.workspaceId === closeParent.workspaceId)
          ?.outcome,
        'blocked'
      )
      await closeRecovery.close()
    }
  )

  await claim(
    'a confirmed host transition keeps an unknown dependent and its parent unknown, so the old checkout still isolates contenders while a linked worktree writes',
    async () => {
      const launderRoot = join(sandbox, 'launder-authority')
      const launderLifecycle = await openLifecycle({ root: launderRoot })
      const launderMain = await launderLifecycle.attach({
        conversation: conversation('launder-main'),
        cwd: fenceRepo,
      })
      const launderParent = ready(await launderMain.authorize({ kind: 'write' }))
      const launderAllocator = await launderLifecycle.attach({
        conversation: conversation('launder-allocator'),
        cwd: fenceRepo,
      })
      const launderTarget = ready(await launderAllocator.authorize({ kind: 'delegated-write' }))
      await launderAllocator.close()
      const launderScoped = ready(
        await launderMain.authorize({
          kind: 'native-file-write',
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
      assert.equal((await findUse(launderLifecycle, launderParent.useId))?.stage, 'unknown')
      const launderContender = await launderLifecycle.attach({
        conversation: conversation('launder-contender'),
        cwd: fenceRepo,
      })
      const launderContention = await launderContender.authorize({ kind: 'write' })
      if (launderContention.kind !== 'rebind')
        throw new Error('The old checkout admitted a contender beside unknown uses')
      await launderContender.handoff(launderContention.handoff, async () => 'cancelled')
      await launderContender.close()
      const launderLinked = await launderLifecycle.attach({
        conversation: conversation('launder-linked'),
        cwd: fenceLinked,
      })
      ready(await launderLinked.authorize({ kind: 'write' }))
      await launderLinked.close()
      await launderMain.close()
      await launderLifecycle.close()
    }
  )

  await claim(
    'a conversation whose bound workspace was removed is refused explicitly, without recreating the workspace or touching the conversation file',
    async () => {
      const removedRoot = join(sandbox, 'removed-workspace-authority')
      const removedLifecycle = await openLifecycle({ root: removedRoot })
      const removedConversation = conversation('removed-workspace')
      const removedAttachment = await removedLifecycle.attach({
        conversation: removedConversation,
        cwd: fenceRepo,
      })
      const removedAllocator = await removedLifecycle.attach({
        conversation: conversation('removed-allocator'),
        cwd: fenceRepo,
      })
      const removedTarget = ready(await removedAllocator.authorize({ kind: 'delegated-write' }))
      await removedAllocator.close()
      await removedAttachment.handoff(
        await removedAttachment.select({
          taskId: removedTarget.taskId!,
          workspaceId: removedTarget.workspaceId,
        }),
        async () => 'confirmed'
      )
      await removedAttachment.close()
      const sessionBefore = readFileSync(removedConversation.sessionFile, 'utf8')
      rmSync(removedTarget.checkout, { recursive: true, force: true })
      await assert.rejects(
        removedLifecycle.attach({ conversation: removedConversation, cwd: fenceRepo }),
        error =>
          error instanceof WorkspaceError &&
          error.outcome === 'review-required' &&
          /no longer exists and is not recreated/.test(error.message)
      )
      assert.equal(readFileSync(removedConversation.sessionFile, 'utf8'), sessionBefore)
      assert.ok(!existsSync(removedTarget.checkout))
      await removedLifecycle.close()
    }
  )

  await claim(
    'a conversation with a live process cannot start a switch; once the process is observed gone a switch can be withdrawn and later confirmed',
    async () => {
      const transitionRoot = join(sandbox, 'transition-authority')
      const transitionLifecycle = await openLifecycle({ root: transitionRoot })
      const transitionAttachment = await transitionLifecycle.attach({
        conversation: conversation('transition'),
        cwd: fenceRepo,
      })
      const transitionParent = ready(await transitionAttachment.authorize({ kind: 'write' }))
      const transitionAllocator = await transitionLifecycle.attach({
        conversation: conversation('transition-allocator'),
        cwd: fenceRepo,
      })
      const transitionTarget = ready(
        await transitionAllocator.authorize({ kind: 'delegated-write' })
      )
      await transitionAllocator.close()
      const transitionExecution = processExecution('transition-process')
      const transitionProcess = ready(
        await transitionAttachment.authorize({ kind: 'write', execution: transitionExecution })
      )
      await startProcessUse(transitionAttachment, transitionProcess, transitionExecution)
      const transitionSelection = {
        taskId: transitionTarget.taskId!,
        workspaceId: transitionTarget.workspaceId,
      }
      await expectWorkspaceError(transitionAttachment.select(transitionSelection), 'blocked')
      ready(await transitionAttachment.authorize({ kind: 'read' }))
      assert.equal(
        (await findUse(transitionLifecycle, transitionParent.useId))?.stage,
        'authorized'
      )
      await endProcessUse(transitionAttachment, transitionProcess)
      const withdrawn = await transitionAttachment.select(transitionSelection)
      await transitionAttachment.handoff(withdrawn, async () => 'cancelled')
      ready(await transitionAttachment.authorize({ kind: 'write' }))
      const transitionHandoff = await transitionAttachment.select(transitionSelection)
      await transitionAttachment.handoff(transitionHandoff, async () => 'confirmed')
      assert.equal(transitionAttachment.binding.workspaceId, transitionTarget.workspaceId)
      assert.equal((await findUse(transitionLifecycle, transitionParent.useId))?.stage, 'quiescent')
      await transitionAttachment.close()
      await transitionLifecycle.close()
    }
  )

  await claim(
    'a contended write is refused, not isolated, while the same conversation still runs a process in the checkout it would leave, and the conversation stays admitted',
    async () => {
      const readerAgentRoot = join(sandbox, 'reader-agent-authority')
      const readerAgentLifecycle = await openLifecycle({ root: readerAgentRoot })
      const readerOwner = await readerAgentLifecycle.attach({
        conversation: conversation('reader-owner'),
        cwd: fenceRepo,
      })
      ready(await readerOwner.authorize({ kind: 'write' }))
      const readerAgent = await readerAgentLifecycle.attach({
        conversation: conversation('reader-agent'),
        cwd: fenceRepo,
      })
      const readerAgentExecution = processExecution('reader-agent')
      const readerAgentUse = ready(
        await readerAgent.authorize({ kind: 'read', execution: readerAgentExecution })
      )
      await startProcessUse(readerAgent, readerAgentUse, readerAgentExecution)
      await expectWorkspaceError(readerAgent.authorize({ kind: 'write' }), 'blocked')
      ready(await readerAgent.authorize({ kind: 'read' }))
      await endProcessUse(readerAgent, readerAgentUse)
      assert.equal((await readerAgent.authorize({ kind: 'write' })).kind, 'rebind')
      await readerAgent.close()
      await readerOwner.close()
      await readerAgentLifecycle.close()
    }
  )

  const spelled = conversation('case-spelling')
  const respelledHome = join(sandbox, 'DATA-CASE-SPELLING')
  const respelled = {
    ...spelled,
    sessionFile: join(respelledHome, 'SESSION.JSONL'),
    dataHome: respelledHome,
  }
  if (existsSync(respelled.sessionFile))
    await claim(
      'on a volume that ignores case, a live conversation named in another case is the same conversation: its attach is refused, and once free it keeps the stored spelling',
      async () => {
        const caseRoot = join(sandbox, 'case-spelling-authority')
        const holder = await openLifecycle({ root: caseRoot })
        const other = await openLifecycle({ root: caseRoot })
        try {
          const holding = await holder.attach({ conversation: spelled, cwd: fenceRepo })
          const { conversation: stored } = holding.binding
          await expectWorkspaceError(
            other.attach({ conversation: respelled, cwd: fenceRepo }),
            'blocked'
          )
          await holding.close()
          const reopened = await other.attach({ conversation: respelled, cwd: fenceRepo })
          assert.equal(reopened.binding.conversation.sessionFile, stored.sessionFile)
          assert.equal(reopened.binding.conversation.dataHome, stored.dataHome)
          await reopened.close()
        } finally {
          await holder.close()
          await other.close()
        }
      }
    )
  await claim(
    'while a conversation is live, an attach from another lifecycle on the same authority is refused, with or without a selection, under another data home, and after its host closed its last attachment with the switch pending, and its switch stays with the live host; once the host is gone, any attach withdraws the switch that never reached it, keeping the last confirmed workspace or binding the selected one, and frees the unused target',
    async () => {
      const recoveryRoot = join(sandbox, 'unstarted-recovery-authority')
      const recoveryConversation = conversation('unstarted-recovery')
      const recoveryLifecycle = await openLifecycle({ root: recoveryRoot })
      const recoveryAllocator = await recoveryLifecycle.attach({
        conversation: conversation('unstarted-recovery-allocator'),
        cwd: fenceRepo,
      })
      const recoveryTarget = ready(await recoveryAllocator.authorize({ kind: 'delegated-write' }))
      await recoveryAllocator.close()
      const otherAllocator = await recoveryLifecycle.attach({
        conversation: conversation('unstarted-recovery-other-allocator'),
        cwd: fenceRepo,
      })
      const otherTarget = ready(await otherAllocator.authorize({ kind: 'delegated-write' }))
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
      const otherInstallation = await openLifecycle({ root: recoveryRoot })
      const otherSelection = { taskId: otherTarget.taskId!, workspaceId: otherTarget.workspaceId }
      await expectWorkspaceError(
        otherInstallation.attach({ conversation: recoveryConversation, cwd: fenceRepo }),
        'blocked'
      )
      await expectWorkspaceError(
        otherInstallation.attach({
          conversation: recoveryConversation,
          cwd: otherTarget.cwd,
          selection: otherSelection,
        }),
        'blocked'
      )
      assert.equal(
        await switchStage(otherInstallation, pendingSwitch.operationId),
        'intent',
        'an attach refused while the conversation is live elsewhere leaves its switch to that host'
      )
      const otherDataHome = join(sandbox, 'other-installation-data')
      mkdirSync(otherDataHome, { recursive: true })
      await expectWorkspaceError(
        otherInstallation.attach({
          conversation: { ...recoveryConversation, dataHome: otherDataHome },
          cwd: fenceRepo,
        }),
        'blocked'
      )
      // The host keeps its state while its switch is pending, so closing its last attachment
      // must not free the conversation for anyone else.
      await recoveryAttachment.close()
      await expectWorkspaceError(
        otherInstallation.attach({ conversation: recoveryConversation, cwd: fenceRepo }),
        'blocked'
      )
      assert.equal(await switchStage(otherInstallation, pendingSwitch.operationId), 'intent')
      await otherInstallation.close()
      await recoveryLifecycle.close()
      const recoveryReopened = await openLifecycle({ root: recoveryRoot })
      const resumedAtSource = await recoveryReopened.attach({
        conversation: recoveryConversation,
        cwd: fenceRepo,
      })
      assert.equal(resumedAtSource.binding.workspaceId, sourceWorkspaceId)
      assert.equal(
        await switchStage(recoveryReopened, pendingSwitch.operationId),
        undefined,
        'the unstarted switch was withdrawn, so it is no longer pending'
      )
      assert.equal(
        ready(await resumedAtSource.authorize({ kind: 'write' })).workspaceId,
        sourceWorkspaceId
      )
      await resumedAtSource.close()
      const targetOwner = await recoveryReopened.attach({
        conversation: conversation('unstarted-recovery-target'),
        cwd: fenceRepo,
        selection: { taskId: recoveryTarget.taskId!, workspaceId: recoveryTarget.workspaceId },
      })
      assert.equal(
        ready(await targetOwner.authorize({ kind: 'write' })).workspaceId,
        recoveryTarget.workspaceId
      )
      await targetOwner.close()
      await recoveryReopened.close()

      const selectingConversation = conversation('unstarted-selection')
      const selectingLifecycle = await openLifecycle({ root: recoveryRoot })
      const selecting = await selectingLifecycle.attach({
        conversation: selectingConversation,
        cwd: fenceRepo,
      })
      const selectingSwitch = await selecting.select({
        taskId: recoveryTarget.taskId!,
        workspaceId: recoveryTarget.workspaceId,
      })
      await selectingLifecycle.close()
      const selectingReopened = await openLifecycle({ root: recoveryRoot })
      const selected = await selectingReopened.attach({
        conversation: selectingConversation,
        cwd: otherTarget.cwd,
        selection: otherSelection,
      })
      assert.equal(selected.binding.workspaceId, otherTarget.workspaceId)
      assert.equal(
        await switchStage(selectingReopened, selectingSwitch.operationId),
        undefined,
        'a selection after the host died withdraws the switch instead of orphaning it'
      )
      await selected.close()
      await selectingReopened.close()
    }
  )

  await claim(
    'inspect names the use of a killed writer as left by an ended session, even while a live reader shares its checkout and after the same conversation is resumed, and a live writer stays active',
    async () => {
      const crashRoot = join(sandbox, 'crash-authority')
      const crashConversation = conversation('crashed-writer')
      await runChild(`
        import { openLifecycle } from ${JSON.stringify(moduleUrl)}
        const lifecycle = await openLifecycle({ root: ${JSON.stringify(crashRoot)} })
        const attachment = await lifecycle.attach({ conversation: ${JSON.stringify(crashConversation)}, cwd: ${JSON.stringify(failureRepo)} })
        await attachment.authorize({ kind: 'write' })
        process.kill(process.pid, 'SIGKILL')
      `).then(
        () => assert.fail('the crashing child must not exit cleanly'),
        () => undefined
      )
      const crashLifecycle = await openLifecycle({ root: crashRoot })
      const liveWriter = await crashLifecycle.attach({
        conversation: conversation('live-writer'),
        cwd: scopedRepo,
      })
      ready(await liveWriter.authorize({ kind: 'write' }))
      const coPresentReader = await crashLifecycle.attach({
        conversation: conversation('co-present-reader'),
        cwd: failureRepo,
      })
      const coPresentRead = ready(await coPresentReader.authorize({ kind: 'read' }))
      const crashViews = await crashLifecycle.inspect({})
      const abandoned = crashViews.find(view => view.path === realpathSync(failureRepo))
      const crashedUse = abandoned?.uses.find(use => use.access === 'write')
      assert.ok(crashedUse)
      assert.equal(abandoned?.outcome, 'blocked', 'a live reader does not hide the dead writer')
      assert.ok(abandoned?.reason?.includes(crashedUse.id))
      assert.ok(!abandoned?.reason?.includes(coPresentRead.useId))
      assert.equal(
        crashViews.find(view => view.path === realpathSync(scopedRepo))?.outcome,
        'active'
      )
      const resumed = await crashLifecycle.attach({
        conversation: crashConversation,
        cwd: failureRepo,
      })
      const resumedView = (await crashLifecycle.inspect({})).find(
        view => view.path === realpathSync(failureRepo)
      )
      assert.equal(
        resumedView?.outcome,
        'blocked',
        'resuming the conversation does not revive its dead use'
      )
      assert.ok(resumedView?.reason?.includes(crashedUse.id))
      await resumed.close()
      await coPresentReader.close()
      await liveWriter.close()
      await crashLifecycle.close()
    }
  )

  await claim(
    'a managed allocation refused for checkout filters before any Git effect keeps the binding and admission, runs no filter and leaves no pending operation',
    async () => {
      const filteredRepo = join(sandbox, 'filtered-repo')
      mkdirSync(filteredRepo)
      git(['init', '--quiet', '-b', 'main'], filteredRepo)
      writeFileSync(join(filteredRepo, 'AGENTS.md'), 'fixture\n')
      writeFileSync(join(filteredRepo, '.gitattributes'), 'AGENTS.md filter=fixture\n')
      git(['add', '.'], filteredRepo)
      git(
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '-qm',
          'x',
        ],
        filteredRepo
      )
      const smudged = join(sandbox, 'filtered-smudge-ran')
      git(['config', 'filter.fixture.smudge', `touch ${smudged}`], filteredRepo)
      const filteredRoot = join(sandbox, 'filtered-authority')
      const filteredLifecycle = await openLifecycle({ root: filteredRoot })
      const filteredOwner = await filteredLifecycle.attach({
        conversation: conversation('filtered-owner'),
        cwd: filteredRepo,
      })
      ready(await filteredOwner.authorize({ kind: 'write' }))
      const filteredContender = await filteredLifecycle.attach({
        conversation: conversation('filtered-contender'),
        cwd: filteredRepo,
      })
      const boundBefore = filteredContender.binding
      await expectWorkspaceError(filteredContender.authorize({ kind: 'write' }), 'blocked')
      assert.ok(!existsSync(smudged), 'no checkout filter ran')
      assert.deepEqual(filteredContender.binding, boundBefore)
      assert.equal(
        ready(await filteredContender.authorize({ kind: 'read' })).workspaceId,
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
    }
  )

  // The default root must be the same for every installation, launch directory, data home
  // and HOME. Only the pure resolver module is imported, so nothing can open the root.
  await claim(
    'the default authority root, resolved from this checkout and from a copied second installation, is the same account-derived path regardless of launch directory, DEV_DATA_HOME or HOME, and is never opened by the check',
    () => {
      const devRoot = new URL('..', import.meta.url)
      const secondInstallation = join(sandbox, 'second-installation')
      cpSync(new URL('src', devRoot), join(secondInstallation, 'src'), { recursive: true })
      cpSync(new URL('package.json', devRoot), join(secondInstallation, 'package.json'))
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
      for (const excluded of [
        fileURLToPath(devRoot),
        secondInstallation,
        repo,
        elsewhere,
        otherHome,
      ])
        assert.ok(!inside(excluded, fromFirst), `the default root is not under ${excluded}`)
    }
  )

  const raceRoot = join(sandbox, 'incarnation-race')
  const raceToken = join(sandbox, 'incarnation-race-token')
  const raceDone = join(sandbox, 'incarnation-race-done')
  await claim(
    'inspection probing an incarnation from other processes while its owner acquires and releases it writes nothing to the authority and never makes the release fail',
    async () => {
      mkdirSync(raceRoot, { mode: 0o700 })
      await runChild(`
        import { WorkspaceAuthority } from ${srcSpecifier('workspace-authority.ts')}
        new WorkspaceAuthority(${JSON.stringify(raceRoot)}).initialize()
      `)
      const owner = runChild(`
        import { renameSync, writeFileSync } from 'node:fs'
        import { authorityPaths } from ${srcSpecifier('workspace-authority-root.ts')}
        import { acquireConversationPresence } from ${srcSpecifier('workspace-gates.ts')}
        const paths = authorityPaths(${JSON.stringify(raceRoot)})
        const errors = []
        for (let cycle = 0; cycle < 600; cycle += 1) {
          try {
            const presence = acquireConversationPresence(paths, 'race-' + (cycle % 4))
            writeFileSync(${JSON.stringify(`${raceToken}.next`)}, presence.incarnation)
            renameSync(${JSON.stringify(`${raceToken}.next`)}, ${JSON.stringify(raceToken)})
            const until = performance.now() + 1
            while (performance.now() < until) {}
            presence.release()
          } catch (error) {
            errors.push(String(error.message))
          }
        }
        writeFileSync(${JSON.stringify(raceDone)}, '')
        console.log(JSON.stringify({ errors: errors.slice(0, 5), failed: errors.length }))
      `)
      const inspector = () =>
        runChild(`
          import { existsSync, readFileSync } from 'node:fs'
          import { authorityPaths } from ${srcSpecifier('workspace-authority-root.ts')}
          import { incarnationHeld } from ${srcSpecifier('workspace-gates.ts')}
          const paths = authorityPaths(${JSON.stringify(raceRoot)})
          const errors = []
          let held = 0
          while (!existsSync(${JSON.stringify(raceDone)})) {
            if (!existsSync(${JSON.stringify(raceToken)})) continue
            try {
              if (incarnationHeld(paths, readFileSync(${JSON.stringify(raceToken)}, 'utf8'))) held += 1
            } catch (error) {
              errors.push(String(error.message))
            }
          }
          console.log(JSON.stringify({ errors: errors.slice(0, 5), failed: errors.length, held }))
        `)
      const [ownerResult, ...inspectorResults] = (
        await Promise.all([owner, inspector(), inspector()])
      ).map(
        output =>
          JSON.parse(output) as {
            readonly errors: readonly string[]
            readonly failed: number
            readonly held?: number
          }
      )
      assert.deepEqual(ownerResult, { errors: [], failed: 0 }, 'every release succeeded')
      for (const result of inspectorResults) {
        assert.deepEqual([result.failed, result.errors], [0, []], 'every probe answered')
        assert.ok((result.held ?? 0) > 0, 'the probes observed a live incarnation')
      }
      const incarnations = join(raceRoot, 'gates', 'incarnations')
      assert.deepEqual(
        existsSync(incarnations) ? readdirSync(incarnations) : [],
        [],
        'no incarnation gate was left or recreated'
      )
    }
  )

  await claim(
    'an inspection racing a conversation that closes cleanly never reports its settled uses as left by an ended session',
    async () => {
      const closingRepo = join(sandbox, 'clean-close-repo')
      initRepository(closingRepo, 'tracked.txt', 'clean close fixture\n')
      const closingDone = join(sandbox, 'clean-close-done')
      const closing = conversation('clean-close')
      const registering = await openLifecycle({ root })
      await (await registering.attach({ conversation: closing, cwd: closingRepo })).close()
      await registering.close()
      const owner = runChild(`
        import { writeFileSync } from 'node:fs'
        import { openLifecycle } from ${JSON.stringify(moduleUrl)}
        const lifecycle = await openLifecycle({ root: ${JSON.stringify(root)} })
        const conversation = ${JSON.stringify(closing)}
        for (let cycle = 0; cycle < 150; cycle += 1) {
          const attachment = await lifecycle.attach({ conversation, cwd: ${JSON.stringify(closingRepo)} })
          await attachment.authorize({ kind: 'write' })
          await attachment.close()
        }
        await lifecycle.close()
        writeFileSync(${JSON.stringify(closingDone)}, '')
      `)
      const inspector = () =>
        runChild(`
          import { existsSync } from 'node:fs'
          import { openLifecycle } from ${JSON.stringify(moduleUrl)}
          const lifecycle = await openLifecycle({ root: ${JSON.stringify(root)} })
          const abandoned = []
          let inspections = 0
          while (!existsSync(${JSON.stringify(closingDone)})) {
            for (const view of await lifecycle.inspect({ cwd: ${JSON.stringify(closingRepo)} }))
              if (view.reason.includes('left unsettled')) abandoned.push(view.reason)
            inspections += 1
          }
          await lifecycle.close()
          console.log(JSON.stringify({ abandoned: abandoned.slice(0, 3), inspections }))
        `)
      const [, ...inspected] = await Promise.all([owner, inspector(), inspector()])
      for (const output of inspected) {
        const result = JSON.parse(output) as {
          readonly abandoned: readonly string[]
          readonly inspections: number
        }
        assert.deepEqual(result.abandoned, [], 'no settled use was reported as abandoned')
        assert.ok(result.inspections > 0, 'the inspector raced the closing conversation')
      }
    }
  )

  await claim(
    'a second handoff of a switch already under way, as a quit would send, is refused for review instead of recording the switch as cancelled, and the switch still completes',
    async () => {
      const switchingRepo = join(sandbox, 'double-handoff-repo')
      initRepository(switchingRepo, 'tracked.txt', 'double handoff fixture\n')
      const switching = await openLifecycle({ root })
      const holder = await switching.attach({
        conversation: conversation('double-handoff-holder'),
        cwd: switchingRepo,
      })
      assert.equal((await holder.authorize({ kind: 'write' })).kind, 'ready')
      const mover = await switching.attach({
        conversation: conversation('double-handoff-mover'),
        cwd: switchingRepo,
      })
      const admission = await mover.authorize({ kind: 'write' })
      if (admission.kind !== 'rebind') throw new Error('The contended writer was not isolated')
      const { handoff } = admission
      const stage = async () =>
        (await switching.inspect({ cwd: switchingRepo }))
          .flatMap(view => view.pending)
          .find(item => item.id === handoff.operationId)?.stage
      const hostReached = deferred<void>()
      const switchFinished = deferred<'confirmed'>()
      const firstSwitch = mover.handoff(handoff, () => {
        hostReached.resolve()
        return switchFinished.promise
      })
      await hostReached.promise
      await expectWorkspaceError(
        mover.handoff(handoff, async () => 'cancelled'),
        'review-required'
      )
      assert.equal(await stage(), 'started', 'the switch is still recorded as started')
      switchFinished.resolve('confirmed')
      await firstSwitch
      assert.equal(mover.binding.workspaceId, handoff.target.workspaceId)
      assert.equal(await stage(), undefined, 'the confirmed switch is no longer pending')
      await mover.close()
      await holder.close()
      await switching.close()
    }
  )

  console.log(
    JSON.stringify(
      { result: 'passed', checks: passed, authorityRoot: root, fixtureRepository: repo },
      null,
      2
    )
  )
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}
