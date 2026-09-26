import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { ManagedRuntime } from 'effect'
import { makeWorkOwnerLayer, ownerEffect } from '../src/work-controller.ts'
import { checkChildWorkspace, validateWorkspaceWritePath } from '../src/work-child-workspace.ts'
import { makeWorkspaceLifecycle } from '../src/workspace-lifecycle.ts'
import { createNativeWrites } from '../src/workspace-native-write.ts'
import { createWorkspaceShell } from '../src/workspace-shell.ts'
import type { WorkspaceAttachment } from '../src/workspace-domain.ts'
import { allocateDetachedWorktree, canonicalGitWorkspace } from '../src/workspace-git.ts'
import type { AttemptView } from '../src/work-domain.ts'

const exec = promisify(execFile)
const root = await realpath(await mkdtemp(join(tmpdir(), 'dev-workspace-process-')))
const checks: string[] = []
try {
  const cwd = join(root, 'repository')
  const dataHome = join(root, 'runtime')
  await mkdir(cwd, { mode: 0o700 })
  await mkdir(dataHome, { mode: 0o700 })
  await exec('git', ['init', '--quiet', cwd])
  await writeFile(join(cwd, 'tracked.txt'), 'preserve this file\n')
  await exec('git', ['-C', cwd, 'add', 'tracked.txt'])
  await exec('git', [
    '-C',
    cwd,
    '-c',
    'user.name=Workspace Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'Fixture',
  ])
  const authority = makeWorkspaceLifecycle({ root: join(root, 'authority') })
  const sessionId = randomUUID()
  const sessionFile = join(dataHome, 'conversation.jsonl')
  await writeFile(sessionFile, '', { mode: 0o600 })
  let attachment = await authority.attach({
    cwd,
    conversation: { sessionId, sessionFile, dataHome },
  })
  try {
    const admission = await attachment.authorize({ access: 'write' })
    assert.equal(admission.kind, 'ready', 'first writer keeps the checkout')
    if (admission.kind !== 'ready') throw new Error('Unexpected fixture handoff')
    let { grant } = admission
    assert.equal(grant.cwd, cwd)
    await validateWorkspaceWritePath(grant, { path: 'new/directory/file.txt' })
    await assert.rejects(validateWorkspaceWritePath(grant, { path: '../escape.txt' }), /traverse/)
    for (const path of [
      '@../escape.txt',
      '~/escape.txt',
      'file:///escape.txt',
      '\u00a0alias/file.txt',
    ])
      await assert.rejects(validateWorkspaceWritePath(grant, { path }), /literal/)
    await assert.rejects(
      validateWorkspaceWritePath(grant, { path: '.git/config' }),
      /administrative/
    )
    const outside = join(root, 'outside')
    await mkdir(outside)
    await symlink(outside, join(cwd, 'escape'))
    await assert.rejects(validateWorkspaceWritePath(grant, { path: 'escape/file.txt' }), /escapes/)
    // Raw `..` after a link: lexical resolution reports a path inside the checkout while
    // the builtin tool, handing the operand to the kernel, would write through the link.
    for (const path of ['escape/../file.txt', 'escape/../../file.txt', './escape/../file.txt'])
      await assert.rejects(validateWorkspaceWritePath(grant, { path }), /traverse/)
    assert.ok(!existsSync(join(outside, 'file.txt')))
    await link(join(cwd, 'tracked.txt'), join(cwd, 'hardlink.txt'))
    await mkdir(join(cwd, 'nested', '.git'), { recursive: true })
    await assert.rejects(
      validateWorkspaceWritePath(grant, { path: 'nested/file.txt' }),
      /nested repository/
    )
    await assert.rejects(validateWorkspaceWritePath(grant, { path: 'hardlink.txt' }), /hard links/)
    checks.push(
      'native writes reject traversal, escaping links, Git admin and hard-linked destinations'
    )
    await assert.rejects(checkChildWorkspace(grant, 'write'), /IPC is unavailable/)
    checks.push('a child without its live controller cannot authorize a write')

    const hookMarker = join(root, 'checkout-hook-ran')
    await writeFile(
      join(cwd, '.git', 'hooks', 'post-checkout'),
      `#!/bin/sh\nprintf unsafe > ${JSON.stringify(hookMarker)}\n`,
      { mode: 0o700 }
    )
    const delegated = await attachment.authorize({ access: 'write', delegated: true })
    assert.equal(delegated.kind, 'ready')
    if (delegated.kind !== 'ready') throw new Error('Unexpected delegated handoff')
    assert.equal(delegated.grant.origin, 'managed')
    assert.equal(delegated.grant.taskId, grant.taskId)
    assert.notEqual(delegated.grant.workspaceId, grant.workspaceId)
    await assert.rejects(
      readFile(hookMarker),
      { code: 'ENOENT' },
      'managed allocation must not invoke uninstrumented checkout hooks'
    )
    checks.push('managed allocation does not execute checkout hooks')
    await attachment.close()
    attachment = await authority.attach({
      cwd: delegated.grant.cwd,
      conversation: { sessionId, sessionFile, dataHome },
      selection: {
        taskId: delegated.grant.taskId!,
        workspaceId: delegated.grant.workspaceId,
      },
    })
    const resumed = await attachment.authorize({ access: 'write' })
    assert.equal(resumed.kind, 'ready')
    if (resumed.kind !== 'ready') throw new Error('Unexpected resume handoff')
    grant = resumed.grant

    let deliver: (attempt: AttemptView) => void = () => {}
    const outcome = new Promise<AttemptView>(accept => {
      deliver = accept
    })
    const runtime = ManagedRuntime.make(
      makeWorkOwnerLayer({
        dataHome,
        cwd: grant.cwd,
        sessionId,
        profile: 'general',
        workspace: { lifecycle: authority, attachment },
        onOutcome: deliver,
      })
    )
    const deadline = setTimeout(() => deliverFailure(), 20000)
    let rejectTimeout: (cause: Error) => void = () => {}
    function deliverFailure(): void {
      rejectTimeout(new Error('No process outcome within 20 seconds'))
    }
    const timeout = new Promise<never>((_accept, reject) => {
      rejectTimeout = reject
    })
    try {
      const descendantMarker = join(root, 'descendant-finished')
      const started = await runtime.runPromise(
        ownerEffect(owner =>
          owner.startProcess({
            taskId: 'controller-local-key',
            command: `(sleep 1; printf done > ${JSON.stringify(descendantMarker)}) & printf "real process output\\n"`,
          })
        )
      )
      assert.equal(started.cwd, grant.cwd)
      assert.equal(started.workflowTaskId, grant.taskId)
      assert.notEqual(started.workflowTaskId, started.owner.taskId)
      assert.equal(started.workspaceId, grant.workspaceId)
      assert.ok(started.workspaceUseId)
      assert.notEqual(started.workspaceUseId, grant.useId)
      const terminal = await Promise.race([outcome, timeout])
      assert.equal(terminal.status, 'completed')
      assert.equal(
        await readFile(descendantMarker, 'utf8'),
        'done',
        'the use must outlive the shell until its backgrounded descendant is observed gone'
      )
      const log = await runtime.runPromise(
        ownerEffect(owner => owner.readLog({ id: terminal.id, stream: 'stdout' }))
      )
      assert.match(log.text ?? '', /real process output/)
      assert.equal(await readFile(join(cwd, 'tracked.txt'), 'utf8'), 'preserve this file\n')
      const settledUse = (await authority.inspect({ taskId: grant.taskId }))
        .find(view => view.workspaceId === grant.workspaceId)
        ?.uses.find(use => use.id === started.workspaceUseId)
      assert.equal(settledUse?.effect, 'opaque')
      assert.equal(settledUse?.stage, 'quiescent')
      assert.match(settledUse?.reason ?? '', /observed gone/)
      assert.equal(settledUse?.logsAvailable, true)
      assert.equal(settledUse?.execution?.logs, log.path)
      await rm(log.path)
      const expired = (await authority.inspect({ taskId: grant.taskId }))
        .find(view => view.workspaceId === grant.workspaceId)
        ?.uses.find(use => use.id === started.workspaceUseId)
      assert.equal(expired?.logsAvailable, false)
      assert.equal(expired?.stage, 'quiescent')
      const next = await attachment.authorize({ access: 'write' })
      assert.equal(next.kind, 'ready', 'observed cessation leaves the checkout writable')
      checks.push(
        'actual WorkOwner process runs in a resumed managed workspace after durable launch barriers, with separate task/use attribution and retrievable logs'
      )
      checks.push(
        'a shell use ends only after its backgrounded same-group descendant is observed gone, and the checkout stays writable'
      )
    } finally {
      clearTimeout(deadline)
      await runtime.dispose()
    }
    const noAuthority = ManagedRuntime.make(
      makeWorkOwnerLayer({
        dataHome: join(root, 'unattached'),
        cwd,
        sessionId: randomUUID(),
        profile: 'general',
      })
    )
    try {
      await assert.rejects(
        noAuthority.runPromise(
          ownerEffect(owner =>
            owner.startProcess({
              taskId: 'blocked',
              command: 'printf invalid > should-not-exist',
            })
          )
        ),
        /Workspace authority is unavailable/
      )
      await assert.rejects(readFile(join(cwd, 'should-not-exist')), { code: 'ENOENT' })
      checks.push('missing authority blocks command execution with no old-lease fallback')
    } finally {
      await noAuthority.dispose()
    }

    const shell = createWorkspaceShell(async shellCwd => {
      const writer = await attachment.authorize({ access: 'write', cwd: shellCwd })
      if (writer.kind !== 'ready') throw new Error('Unexpected shell handoff')
      return { attachment, grant: writer.grant }
    })
    const shellUses = async () =>
      (await authority.inspect({ taskId: grant.taskId }))
        .flatMap(view => view.uses)
        .filter(use => use.effect === 'opaque' && use.execution?.taskKey === 'lead-shell')
    const settled = async (count: number) => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const uses = await shellUses()
        if (uses.length === count && uses.every(use => use.stage === 'quiescent')) return uses
        await new Promise(resolveWait => setTimeout(resolveWait, 250))
      }
      throw new Error(`Shell uses did not settle: ${JSON.stringify(await shellUses())}`)
    }
    const silent = { onData: () => undefined }
    let output = ''
    const lateMarker = join(root, 'shell-late')
    const result = await shell.operations.exec(
      `printf visible; (sleep 3; printf late > ${JSON.stringify(lateMarker)}) & exit 3`,
      grant.cwd,
      { onData: data => (output += data.toString()) }
    )
    assert.equal(result.exitCode, 3)
    assert.equal(output, 'visible')
    assert.ok(!existsSync(lateMarker), 'the command returns when the shell exits')
    const live = await shellUses()
    assert.equal(live.length, 1)
    assert.notEqual(live[0]?.stage, 'quiescent', 'the backgrounded descendant keeps the use live')
    const [ended] = await settled(1)
    assert.equal(await readFile(lateMarker, 'utf8'), 'late')
    assert.match(ended?.reason ?? '', /observed gone/)
    checks.push(
      'a lead shell returns its output and exit status when the shell exits, and its use ends only after a backgrounded descendant is observed gone'
    )

    const orphanMarker = join(root, 'shell-orphan')
    await shell.operations.exec(
      `( sleep 0.3; ( sh -c 'sleep 2; printf orphan > ${JSON.stringify(orphanMarker)}' & ) ; sleep 0.05 ) &`,
      grant.cwd,
      silent
    )
    await settled(2)
    assert.equal(
      await readFile(orphanMarker, 'utf8'),
      'orphan',
      'a descendant reparented away from the shell still keeps its process group live'
    )
    checks.push(
      'after the shell exits, its process group stays observed until empty, even when a member was reparented away'
    )

    const neverRan = join(root, 'shell-never-ran')
    const early = new AbortController()
    const abortedEarly = shell.operations.exec(
      `printf ran > ${JSON.stringify(neverRan)}`,
      grant.cwd,
      { ...silent, signal: early.signal }
    )
    setTimeout(() => early.abort(), 5)
    await assert.rejects(abortedEarly, /aborted/)
    const barrier = new AbortController()
    const abortAtBarrier: WorkspaceAttachment = {
      get binding() {
        return attachment.binding
      },
      authorize: operation => attachment.authorize(operation),
      select: selection => attachment.select(selection),
      handoff: (transition, replace) => attachment.handoff(transition, replace),
      close: () => attachment.close(),
      reportExecution: async (reported, fact) => {
        await attachment.reportExecution(reported, fact)
        if (fact.kind === 'spawned') barrier.abort()
      },
    }
    const barrierShell = createWorkspaceShell(async shellCwd => {
      const writer = await attachment.authorize({ access: 'write', cwd: shellCwd })
      if (writer.kind !== 'ready') throw new Error('Unexpected shell handoff')
      return { attachment: abortAtBarrier, grant: writer.grant }
    })
    await assert.rejects(
      barrierShell.operations.exec(`printf ran > ${JSON.stringify(neverRan)}`, grant.cwd, {
        ...silent,
        signal: barrier.signal,
      }),
      /aborted/
    )
    const controller = new AbortController()
    const aborted = shell.operations.exec('sleep 30', grant.cwd, {
      ...silent,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 1500)
    await assert.rejects(aborted, /aborted/)
    await assert.rejects(
      shell.operations.exec('sleep 30', grant.cwd, { ...silent, timeout: 1.5 }),
      /timeout:1.5/
    )
    await settled(6)
    assert.ok(!existsSync(neverRan), 'a command aborted before release never runs')
    checks.push(
      'a command aborted during admission or while its spawned shell is still gated never runs; abort and timeout after release kill the shell family, whose uses then settle'
    )

    const escapedPidFile = join(root, 'shell-escaped-pid')
    await shell.operations.exec(
      `perl -e 'open(F, ">", $ARGV[0]); print F $$; close(F); sleep 1; setpgrp(0, 0); sleep 30' ${JSON.stringify(escapedPidFile)} & sleep 2`,
      grant.cwd,
      silent
    )
    assert.equal(shell.live(), 1)
    const escapedPid = Number(await readFile(escapedPidFile, 'utf8'))
    await shell.stop()
    assert.equal(shell.live(), 0)
    assert.throws(() => process.kill(escapedPid, 0), { code: 'ESRCH' })
    await settled(7)
    checks.push(
      'stopping the host shell kills a tracked descendant that moved to its own process group, and settles its use'
    )

    await shell.operations.exec('( while :; do sleep 31 & sleep 0.02; done ) &', grant.cwd, silent)
    await new Promise(resolveWait => setTimeout(resolveWait, 300))
    await shell.stop()
    assert.equal(shell.live(), 0)
    await settled(8)
    const { stdout: survivors } = await exec('ps', ['-axo', 'command='])
    assert.ok(
      !survivors.split('\n').some(line => line.trim() === 'sleep 31'),
      'no member of a forking family survives stop'
    )
    checks.push('stopping the host shell keeps signalling a forking family until it is empty')

    const racedMarker = join(root, 'shell-raced-stop')
    const racing = shell.operations.exec(
      `printf ran > ${JSON.stringify(racedMarker)}`,
      grant.cwd,
      silent
    )
    await shell.stop()
    await assert.rejects(racing)
    await settled(9)
    assert.ok(!existsSync(racedMarker), 'a command launched as the shell stops never runs')
    checks.push('a command launched while the host shell stops is refused before it runs')

    const nativeWrites = createNativeWrites(message => {
      throw new Error(message)
    })
    const admitNative = async (toolCallId: string, path: string) => {
      const writer = await attachment.authorize({ access: 'write' })
      if (writer.kind !== 'ready') throw new Error('Unexpected write handoff')
      const operation = await attachment.authorize({
        access: 'write',
        effect: 'native-file-write',
        within: writer.grant,
        path,
      })
      if (operation.kind !== 'ready') throw new Error('Unexpected native write handoff')
      nativeWrites.admit({ toolCallId, attachment, grant: operation.grant })
      return operation.grant
    }
    const writtenGrant = await admitNative('settle-written', 'settled.txt')
    const unusedGrant = await admitNative('settle-unused', 'unused.txt')
    await nativeWrites.writeOperations.writeFile(join(grant.cwd, 'settled.txt'), 'settled')
    await nativeWrites.settle()
    await assert.rejects(
      nativeWrites.writeOperations.writeFile(join(grant.cwd, 'unused.txt'), 'late'),
      /matches no admitted destination/
    )
    const nativeUses = (await authority.inspect({ taskId: grant.taskId })).flatMap(
      view => view.uses
    )
    assert.equal(
      nativeUses.find(use => use.id === writtenGrant.useId)?.reason,
      'operation-completed:native-file-write'
    )
    assert.equal(
      nativeUses.find(use => use.id === unusedGrant.useId)?.reason,
      'operation-ended-before-start:native-file-write'
    )
    assert.ok(!existsSync(join(grant.cwd, 'unused.txt')))
    checks.push(
      'settling native writes at shutdown completes each admitted write, including one never started, and refuses later file operations'
    )

    const authorizeNative = async (path: string) => {
      const writer = await attachment.authorize({ access: 'write' })
      if (writer.kind !== 'ready') throw new Error('Unexpected write handoff')
      const operation = await attachment.authorize({
        access: 'write',
        effect: 'native-file-write',
        within: writer.grant,
        path,
      })
      if (operation.kind !== 'ready') throw new Error('Unexpected native write handoff')
      return operation.grant
    }
    for (const [first, second] of [
      ['Café.txt', 'CAFÉ.TXT'],
      ['straße.txt', 'STRASSE.txt'],
    ] as const) {
      nativeWrites.admit({
        toolCallId: `fold-${first}`,
        attachment,
        grant: await authorizeNative(first),
      })
      const refused = await authorizeNative(second)
      assert.throws(
        () => nativeWrites.admit({ toolCallId: `fold-${second}`, attachment, grant: refused }),
        /still in flight/,
        `${second} names the file ${first} already being written`
      )
      await attachment.reportExecution(refused, { kind: 'operation-completed' })
    }
    await nativeWrites.settle()
    checks.push(
      'a native write is refused while another write to the same file under a different case, normalization or ß/ss spelling is in flight'
    )

    // The authority never acknowledges the identity or the first failure report, so the
    // controller cannot tell whether the family was recorded until it retries.
    let launchFailedReports = 0
    const lossyAttachment = new Proxy(attachment, {
      get(target, property) {
        if (property === 'reportExecution')
          return async (...args: Parameters<WorkspaceAttachment['reportExecution']>) => {
            const [, fact] = args
            if (fact.kind === 'spawned') throw new Error('injected lost identity report')
            if (fact.kind === 'launch-failed' && launchFailedReports++ === 0)
              throw new Error('injected lost failure report')
            return target.reportExecution(...args)
          }
        const value: unknown = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const lossyRuntime = ManagedRuntime.make(
      makeWorkOwnerLayer({
        dataHome,
        cwd: grant.cwd,
        sessionId,
        profile: 'general',
        workspace: { lifecycle: authority, attachment: lossyAttachment },
      })
    )
    const lossyMarker = join(root, 'lossy-launch-ran')
    try {
      await assert.rejects(
        lossyRuntime.runPromise(
          ownerEffect(owner =>
            owner.startProcess({
              taskId: 'lossy-launch',
              command: `printf ran > ${JSON.stringify(lossyMarker)}`,
            })
          )
        ),
        /injected lost identity report/
      )
      let lossyUse
      for (let attempt = 0; attempt < 60; attempt += 1) {
        lossyUse = (await authority.inspect({ taskId: grant.taskId }))
          .flatMap(view => view.uses)
          .find(use => use.execution?.taskKey === 'lossy-launch')
        if (lossyUse?.stage === 'quiescent' || lossyUse?.stage === 'unknown') break
        await new Promise(resolveWait => setTimeout(resolveWait, 250))
      }
      assert.equal(lossyUse?.stage, 'quiescent', lossyUse?.reason)
      assert.match(lossyUse?.reason ?? '', /^launch-failed: /)
      assert.equal(launchFailedReports, 2)
      assert.ok(!existsSync(lossyMarker), 'the failed launch never released user code')
      assert.equal((await attachment.authorize({ access: 'write' })).kind, 'ready')
    } finally {
      await lossyRuntime.dispose()
    }
    checks.push(
      'a controller launch whose identity and first failure report are lost settles as never launched instead of unknown, and the checkout stays writable'
    )

    // A real failure between the durable launch intent and the spawn: once the intent is
    // recorded the attempt directory stops being writable, so opening its logs fails.
    const lockedDirectories: string[] = []
    const lockingAttachment = new Proxy(attachment, {
      get(target, property) {
        if (property === 'reportExecution')
          return async (...args: Parameters<WorkspaceAttachment['reportExecution']>) => {
            await target.reportExecution(...args)
            const [, fact] = args
            if (fact.kind === 'launch-intent' && fact.execution.logs !== undefined) {
              const directory = dirname(fact.execution.logs)
              lockedDirectories.push(directory)
              await chmod(directory, 0o500)
            }
          }
        const value: unknown = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const lockedRuntime = ManagedRuntime.make(
      makeWorkOwnerLayer({
        dataHome,
        cwd: grant.cwd,
        sessionId,
        profile: 'general',
        workspace: { lifecycle: authority, attachment: lockingAttachment },
      })
    )
    const lockedMarker = join(root, 'locked-log-launch-ran')
    try {
      await assert.rejects(
        lockedRuntime.runPromise(
          ownerEffect(owner =>
            owner.startProcess({
              taskId: 'locked-log-launch',
              command: `printf ran > ${JSON.stringify(lockedMarker)}`,
            })
          )
        ),
        /EACCES|permission denied/i
      )
      assert.equal(lockedDirectories.length, 1, 'the launch intent was recorded before the failure')
      let lockedUse
      for (let attempt = 0; attempt < 60; attempt += 1) {
        lockedUse = (await authority.inspect({ taskId: grant.taskId }))
          .flatMap(view => view.uses)
          .find(use => use.execution?.taskKey === 'locked-log-launch')
        if (lockedUse?.stage === 'quiescent' || lockedUse?.stage === 'unknown') break
        await new Promise(resolveWait => setTimeout(resolveWait, 250))
      }
      assert.equal(lockedUse?.stage, 'quiescent', lockedUse?.reason)
      assert.match(
        lockedUse?.reason ?? '',
        /^launch-failed: The launch failed before user code was released: .*(EACCES|permission denied)/i
      )
      assert.ok(!existsSync(lockedMarker), 'no user code ran')
      assert.equal((await attachment.authorize({ access: 'write' })).kind, 'ready')
    } finally {
      for (const directory of lockedDirectories) await chmod(directory, 0o700)
      await lockedRuntime.dispose()
    }
    checks.push(
      'a controller launch that fails after its durable launch intent but before spawning rejects, runs no user code, settles its use as quiescent with a launch-failed reason instead of unknown, and the checkout stays writable'
    )
  } finally {
    await attachment.close()
    await authority.close()
  }
  await writeFile(join(cwd, '.gitattributes'), '*.txt filter=fixture\n')
  await exec('git', ['-C', cwd, 'add', '.gitattributes'])
  await exec('git', [
    '-C',
    cwd,
    '-c',
    'user.name=Workspace Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'Filtered checkout fixture',
  ])
  const filterMarker = join(root, 'checkout-filter-ran')
  await exec('git', [
    '-C',
    cwd,
    'config',
    'filter.fixture.smudge',
    `touch ${JSON.stringify(filterMarker)}`,
  ])
  const source = canonicalGitWorkspace(cwd)
  const filteredDestination = join(root, 'filtered-destination')
  assert.throws(
    () => allocateDetachedWorktree(source, filteredDestination, source.head),
    /checkout filter effects are not controlled/
  )
  await assert.rejects(readFile(filterMarker), { code: 'ENOENT' })
  await assert.rejects(realpath(filteredDestination), { code: 'ENOENT' })
  checks.push('filtered target commits are refused before checkout effects or destination creation')
  console.log(
    JSON.stringify(
      {
        checks,
        limitation:
          'No power-loss test, no daemon-cessation certification, no live credentials or model calls',
      },
      null,
      2
    )
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
