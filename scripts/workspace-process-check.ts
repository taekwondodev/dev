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
import { Effect, ManagedRuntime } from 'effect'
import { makeWorkOwnerLayer, ownerEffect } from '../src/work-controller.ts'
import { checkChildWorkspace, validateWorkspaceWritePath } from '../src/work-child-workspace.ts'
import { makeClaims, waitFor } from './workspace-check-support.ts'
import { openLifecycle, openShell } from './workspace-test-lifecycle.ts'
import { makeNativeWrites } from '../src/workspace-native-write.ts'
import { WorkspaceError, type WorkspaceAttachment } from '../src/workspace-domain.ts'
import type { AttemptView } from '../src/work-domain.ts'

const exec = promisify(execFile)

// Faults are injected into the authority reports a component under test makes.
const withReport = (
  base: WorkspaceAttachment,
  reportExecution: WorkspaceAttachment['reportExecution']
): WorkspaceAttachment => ({
  get binding() {
    return base.binding
  },
  authorize: operation => base.authorize(operation),
  select: selection => base.select(selection),
  handoff: (transition, replace) => base.handoff(transition, replace),
  close: base.close,
  reportExecution,
})
const lost = (message: string) => new WorkspaceError({ outcome: 'unavailable', message })
const unexpectedRebind = (): never => assert.fail('no process check expects a workspace rebind')
const root = await realpath(await mkdtemp(join(tmpdir(), 'dev-workspace-process-')))
const { claim, passed } = makeClaims()
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
  const authority = await openLifecycle({ root: join(root, 'authority') })
  const sessionId = randomUUID()
  const sessionFile = join(dataHome, 'conversation.jsonl')
  await writeFile(sessionFile, '', { mode: 0o600 })
  let attachment = await authority.attach({
    cwd,
    conversation: { sessionId, sessionFile, dataHome },
  })
  try {
    const admission = await attachment.authorize({ kind: 'write' })
    assert.equal(admission.kind, 'ready', 'first writer keeps the checkout')
    if (admission.kind !== 'ready') throw new Error('Unexpected fixture handoff')
    const checkoutGrant = admission.grant
    assert.equal(checkoutGrant.cwd, cwd)
    const validatePath = (path: string) =>
      Effect.runPromise(validateWorkspaceWritePath(checkoutGrant, { path }))
    await claim(
      'native writes reject traversal, escaping links, Git admin and hard-linked destinations',
      async () => {
        await validatePath('new/directory/file.txt')
        await assert.rejects(validatePath('../escape.txt'), /traverse/)
        for (const path of [
          '@../escape.txt',
          '~/escape.txt',
          'file:///escape.txt',
          '\u00a0alias/file.txt',
        ])
          await assert.rejects(validatePath(path), /literal/)
        await assert.rejects(validatePath('.git/config'), /administrative/)
        const outside = join(root, 'outside')
        await mkdir(outside)
        await symlink(outside, join(cwd, 'escape'))
        await assert.rejects(validatePath('escape/file.txt'), /escapes/)
        // Raw `..` after a link: lexical resolution reports a path inside the checkout while
        // the builtin tool, handing the operand to the kernel, would write through the link.
        for (const path of ['escape/../file.txt', 'escape/../../file.txt', './escape/../file.txt'])
          await assert.rejects(validatePath(path), /traverse/)
        assert.ok(!existsSync(join(outside, 'file.txt')))
        await link(join(cwd, 'tracked.txt'), join(cwd, 'hardlink.txt'))
        await mkdir(join(cwd, 'nested', '.git'), { recursive: true })
        await assert.rejects(validatePath('nested/file.txt'), /nested repository/)
        await assert.rejects(validatePath('hardlink.txt'), /hard links/)
      }
    )
    await claim('a child without its live controller cannot authorize a write', async () => {
      await assert.rejects(
        Effect.runPromise(checkChildWorkspace(checkoutGrant, 'write')),
        /IPC is unavailable/
      )
    })

    const delegatedGrant = await claim(
      'managed allocation does not execute checkout hooks',
      async () => {
        const hookMarker = join(root, 'checkout-hook-ran')
        await writeFile(
          join(cwd, '.git', 'hooks', 'post-checkout'),
          `#!/bin/sh\nprintf unsafe > ${JSON.stringify(hookMarker)}\n`,
          { mode: 0o700 }
        )
        const delegated = await attachment.authorize({ kind: 'delegated-write' })
        assert.equal(delegated.kind, 'ready')
        if (delegated.kind !== 'ready') throw new Error('Unexpected delegated handoff')
        assert.equal(delegated.grant.origin, 'managed')
        assert.equal(delegated.grant.taskId, checkoutGrant.taskId)
        assert.notEqual(delegated.grant.workspaceId, checkoutGrant.workspaceId)
        await assert.rejects(
          readFile(hookMarker),
          { code: 'ENOENT' },
          'managed allocation must not invoke uninstrumented checkout hooks'
        )
        return delegated.grant
      }
    )
    await attachment.close()
    attachment = await authority.attach({
      cwd: delegatedGrant.cwd,
      conversation: { sessionId, sessionFile, dataHome },
      selection: {
        taskId: delegatedGrant.taskId!,
        workspaceId: delegatedGrant.workspaceId,
      },
    })
    const resumed = await attachment.authorize({ kind: 'write' })
    assert.equal(resumed.kind, 'ready')
    if (resumed.kind !== 'ready') throw new Error('Unexpected resume handoff')
    const { grant } = resumed

    let deliver!: (attempt: AttemptView) => void
    const outcome = new Promise<AttemptView>(accept => {
      deliver = accept
    })
    const runtime = ManagedRuntime.make(
      makeWorkOwnerLayer({
        dataHome,
        cwd: grant.cwd,
        sessionId,
        profile: 'general',
        workspace: {
          lifecycle: authority.effect,
          attachment: attachment.effect,
          requestRebind: unexpectedRebind,
        },
        onOutcome: attempt => deliver(attempt),
      })
    )
    let deadline: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_accept, reject) => {
      deadline = setTimeout(() => reject(new Error('No process outcome within 20 seconds')), 20000)
    })
    try {
      const descendantMarker = join(root, 'descendant-finished')
      const { started, terminal } = await claim(
        'actual WorkOwner process runs in a resumed managed workspace after durable launch barriers, with separate task/use attribution and retrievable logs',
        async () => {
          const launched = await runtime.runPromise(
            ownerEffect(owner =>
              owner.startProcess({
                taskId: 'controller-local-key',
                command: `(sleep 1; printf done > ${JSON.stringify(descendantMarker)}) & printf "real process output\\n"`,
              })
            )
          )
          assert.equal(launched.cwd, grant.cwd)
          assert.equal(launched.workflowTaskId, grant.taskId)
          assert.notEqual(launched.workflowTaskId, launched.owner.taskId)
          assert.equal(launched.workspaceId, grant.workspaceId)
          assert.ok(launched.workspaceUseId)
          assert.notEqual(launched.workspaceUseId, grant.useId)
          const finished = await Promise.race([outcome, timeout])
          assert.equal(finished.status, 'completed')
          const log = await runtime.runPromise(
            ownerEffect(owner => owner.readLog({ id: finished.id, stream: 'stdout' }))
          )
          assert.match(log.text ?? '', /real process output/)
          assert.equal(await readFile(join(cwd, 'tracked.txt'), 'utf8'), 'preserve this file\n')
          const withLogs = (await authority.inspect({ taskId: grant.taskId }))
            .find(view => view.workspaceId === grant.workspaceId)
            ?.uses.find(use => use.id === launched.workspaceUseId)
          assert.equal(withLogs?.logsAvailable, true)
          assert.equal(withLogs?.execution?.logs, log.path)
          await rm(log.path)
          const expired = (await authority.inspect({ taskId: grant.taskId }))
            .find(view => view.workspaceId === grant.workspaceId)
            ?.uses.find(use => use.id === launched.workspaceUseId)
          assert.equal(expired?.logsAvailable, false)
          assert.equal(expired?.stage, 'quiescent')
          return { started: launched, terminal: finished }
        }
      )
      await claim(
        'a shell use ends only after its backgrounded same-group descendant is observed gone, and the checkout stays writable',
        async () => {
          assert.equal(terminal.status, 'completed')
          assert.equal(
            await readFile(descendantMarker, 'utf8'),
            'done',
            'the use must outlive the shell until its backgrounded descendant is observed gone'
          )
          const settledUse = (await authority.inspect({ taskId: grant.taskId }))
            .find(view => view.workspaceId === grant.workspaceId)
            ?.uses.find(use => use.id === started.workspaceUseId)
          assert.equal(settledUse?.effect, 'opaque')
          assert.equal(settledUse?.stage, 'quiescent')
          assert.match(settledUse?.reason ?? '', /observed gone/)
          const next = await attachment.authorize({ kind: 'write' })
          assert.equal(next.kind, 'ready', 'observed cessation leaves the checkout writable')
        }
      )
    } finally {
      clearTimeout(deadline)
      await runtime.dispose()
    }
    await claim(
      'missing authority blocks command execution with no old-lease fallback',
      async () => {
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
        } finally {
          await noAuthority.dispose()
        }
      }
    )

    const shell = await openShell(async shellCwd => {
      const writer = await attachment.authorize({ kind: 'write', cwd: shellCwd })
      if (writer.kind !== 'ready') throw new Error('Unexpected shell handoff')
      return { attachment: attachment.effect, grant: writer.grant }
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
    await claim(
      'a lead shell returns its output and exit status when the shell exits, and its use ends only after a backgrounded descendant is observed gone',
      async () => {
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
        assert.notEqual(
          live[0]?.stage,
          'quiescent',
          'the backgrounded descendant keeps the use live'
        )
        const [ended] = await settled(1)
        assert.equal(await readFile(lateMarker, 'utf8'), 'late')
        assert.match(ended?.reason ?? '', /observed gone/)
      }
    )

    await claim(
      'after the shell exits, its process group stays observed until empty, even when a member was reparented away',
      async () => {
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
      }
    )

    await claim(
      'a command aborted during admission or while its spawned shell is still gated never runs; abort and timeout after release kill the shell family, whose uses then settle',
      async () => {
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
        const abortAtBarrier = withReport(attachment.effect, (reported, fact) =>
          attachment.effect.reportExecution(reported, fact).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (fact.kind === 'spawned') barrier.abort()
              })
            )
          )
        )
        const barrierShell = await openShell(async shellCwd => {
          const writer = await attachment.authorize({ kind: 'write', cwd: shellCwd })
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
      }
    )

    await claim(
      'stopping the host shell kills a tracked descendant that moved to its own process group, and settles its use',
      async () => {
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
      }
    )

    await claim(
      'stopping the host shell keeps signalling a forking family until it is empty',
      async () => {
        await shell.operations.exec(
          '( while :; do sleep 31 & sleep 0.02; done ) &',
          grant.cwd,
          silent
        )
        await new Promise(resolveWait => setTimeout(resolveWait, 300))
        await shell.stop()
        assert.equal(shell.live(), 0)
        await settled(8)
        const { stdout: survivors } = await exec('ps', ['-axo', 'command='])
        assert.ok(
          !survivors.split('\n').some(line => line.trim() === 'sleep 31'),
          'no member of a forking family survives stop'
        )
      }
    )

    await claim(
      'a command launched while the host shell stops is refused before it runs',
      async () => {
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
      }
    )

    await claim(
      "a transient refusal of a shell family's final quiescent report is retried, so its use settles instead of becoming unknown",
      async () => {
        let refused = 0
        const flaky = withReport(attachment.effect, (reported, fact) =>
          Effect.suspend(() => {
            if (fact.kind !== 'quiescent' || refused > 0)
              return attachment.effect.reportExecution(reported, fact)
            refused += 1
            return Effect.fail(lost('injected busy authority'))
          })
        )
        const flakyShell = await openShell(async shellCwd => {
          const writer = await attachment.authorize({ kind: 'write', cwd: shellCwd })
          if (writer.kind !== 'ready') throw new Error('Unexpected shell handoff')
          return { attachment: flaky, grant: writer.grant }
        })
        await flakyShell.operations.exec('true', grant.cwd, silent)
        await settled(10)
        assert.equal(refused, 1)
        await flakyShell.stop()
      }
    )

    await claim(
      "inspection reports a checkout as active while a live session's shell command runs there, not as unresolved",
      async () => {
        const observingShell = await openShell(async shellCwd => {
          const writer = await attachment.authorize({ kind: 'write', cwd: shellCwd })
          if (writer.kind !== 'ready') throw new Error('Unexpected shell handoff')
          return { attachment: attachment.effect, grant: writer.grant }
        })
        const running = observingShell.operations.exec('sleep 2', grant.cwd, silent)
        const checkout = async () =>
          (await authority.inspect({ taskId: grant.taskId })).find(
            view => view.workspaceId === grant.workspaceId
          )
        const view = await waitFor(
          'the running command to be observed',
          async () => {
            const current = await checkout()
            return current?.uses.some(use => use.stage === 'observed') ? current : undefined
          },
          40,
          100
        )
        assert.equal(view.outcome, 'active', view.reason)
        await running
        await settled(11)
        await observingShell.stop()
      }
    )

    const nativeWrites = makeNativeWrites({
      runPromise: Effect.runPromise,
      onError: message => {
        throw new Error(message)
      },
    })
    const authorizeNative = async (path: string) => {
      const writer = await attachment.authorize({ kind: 'write' })
      if (writer.kind !== 'ready') throw new Error('Unexpected write handoff')
      const operation = await attachment.authorize({
        kind: 'native-file-write',
        within: writer.grant,
        path,
      })
      if (operation.kind !== 'ready') throw new Error('Unexpected native write handoff')
      return operation.grant
    }
    await claim(
      'settling native writes at shutdown completes each admitted write, including one never started, and refuses later file operations',
      async () => {
        const admitNative = async (toolCallId: string, path: string) => {
          const operation = await authorizeNative(path)
          await Effect.runPromise(
            nativeWrites.admit({ toolCallId, attachment: attachment.effect, grant: operation })
          )
          return operation
        }
        const writtenGrant = await admitNative('settle-written', 'settled.txt')
        const unusedGrant = await admitNative('settle-unused', 'unused.txt')
        await nativeWrites.writeOperations.writeFile(join(grant.cwd, 'settled.txt'), 'settled')
        await Effect.runPromise(nativeWrites.settle)
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
      }
    )

    await claim(
      'a native write is refused while another write to the same file under a different case, normalization or ß/ss spelling is in flight',
      async () => {
        for (const [first, second] of [
          // NFC and uppercase NFD spellings of one name, then a sharp s against its uppercase ss.
          ['Café.txt', 'CAFÉ.TXT'],
          ['straße.txt', 'STRASSE.txt'],
        ] as const) {
          await Effect.runPromise(
            nativeWrites.admit({
              toolCallId: `fold-${first}`,
              attachment: attachment.effect,
              grant: await authorizeNative(first),
            })
          )
          const refused = await authorizeNative(second)
          await assert.rejects(
            Effect.runPromise(
              nativeWrites.admit({
                toolCallId: `fold-${second}`,
                attachment: attachment.effect,
                grant: refused,
              })
            ),
            /still in flight/,
            `${second} names the file ${first} already being written`
          )
          await attachment.reportExecution(refused, { kind: 'operation-completed' })
        }
        await Effect.runPromise(nativeWrites.settle)
      }
    )

    await claim(
      'a controller launch whose identity and first failure report are lost settles as never launched instead of unknown, and the checkout stays writable',
      async () => {
        // The authority never acknowledges the identity or the first failure report, so the
        // controller cannot tell whether the family was recorded until it retries.
        let launchFailedReports = 0
        const lossyAttachment = withReport(attachment.effect, (reported, fact) =>
          Effect.suspend(() => {
            if (fact.kind === 'spawned') return Effect.fail(lost('injected lost identity report'))
            if (fact.kind === 'launch-failed' && launchFailedReports++ === 0)
              return Effect.fail(lost('injected lost failure report'))
            return attachment.effect.reportExecution(reported, fact)
          })
        )
        const lossyRuntime = ManagedRuntime.make(
          makeWorkOwnerLayer({
            dataHome,
            cwd: grant.cwd,
            sessionId,
            profile: 'general',
            workspace: {
              lifecycle: authority.effect,
              attachment: lossyAttachment,
              requestRebind: unexpectedRebind,
            },
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
          assert.equal(lossyUse?.stage, 'quiescent', JSON.stringify(lossyUse))
          assert.match(lossyUse?.reason ?? '', /^launch-failed: /)
          assert.equal(launchFailedReports, 2)
          assert.ok(!existsSync(lossyMarker), 'the failed launch never released user code')
          assert.equal((await attachment.authorize({ kind: 'write' })).kind, 'ready')
        } finally {
          await lossyRuntime.dispose()
        }
      }
    )

    await claim(
      "a transient refusal of a controller family's final quiescent report is retried, so its use settles instead of staying unresolved",
      async () => {
        let refused = 0
        const flaky = withReport(attachment.effect, (reported, fact) =>
          Effect.suspend(() => {
            if (fact.kind !== 'quiescent' || refused > 0)
              return attachment.effect.reportExecution(reported, fact)
            refused += 1
            return Effect.fail(lost('injected busy authority'))
          })
        )
        const flakyRuntime = ManagedRuntime.make(
          makeWorkOwnerLayer({
            dataHome,
            cwd: grant.cwd,
            sessionId,
            profile: 'general',
            workspace: {
              lifecycle: authority.effect,
              attachment: flaky,
              requestRebind: unexpectedRebind,
            },
          })
        )
        try {
          await flakyRuntime.runPromise(
            ownerEffect(owner => owner.startProcess({ taskId: 'flaky-final', command: 'true' }))
          )
          let finalUse
          for (let attempt = 0; attempt < 60; attempt += 1) {
            finalUse = (await authority.inspect({ taskId: grant.taskId }))
              .flatMap(view => view.uses)
              .find(use => use.execution?.taskKey === 'flaky-final')
            if (finalUse?.stage === 'quiescent' || finalUse?.stage === 'unknown') break
            await new Promise(resolveWait => setTimeout(resolveWait, 250))
          }
          assert.equal(finalUse?.stage, 'quiescent', JSON.stringify(finalUse))
          assert.equal(refused, 1)
        } finally {
          await flakyRuntime.dispose()
        }
      }
    )

    await claim(
      'a controller launch that fails after its durable launch intent but before spawning rejects, runs no user code, settles its use as quiescent with a launch-failed reason instead of unknown, and the checkout stays writable',
      async () => {
        // A real failure between the durable launch intent and the spawn: once the intent is
        // recorded the attempt directory stops being writable, so opening its logs fails.
        const lockedDirectories: string[] = []
        const lockingAttachment = withReport(attachment.effect, (reported, fact) =>
          attachment.effect.reportExecution(reported, fact).pipe(
            Effect.tap(() => {
              if (fact.kind !== 'launch-intent' || fact.execution.logs === undefined)
                return Effect.void
              const directory = dirname(fact.execution.logs)
              lockedDirectories.push(directory)
              return Effect.promise(() => chmod(directory, 0o500))
            })
          )
        )
        const lockedRuntime = ManagedRuntime.make(
          makeWorkOwnerLayer({
            dataHome,
            cwd: grant.cwd,
            sessionId,
            profile: 'general',
            workspace: {
              lifecycle: authority.effect,
              attachment: lockingAttachment,
              requestRebind: unexpectedRebind,
            },
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
          assert.equal(
            lockedDirectories.length,
            1,
            'the launch intent was recorded before the failure'
          )
          let lockedUse
          for (let attempt = 0; attempt < 60; attempt += 1) {
            lockedUse = (await authority.inspect({ taskId: grant.taskId }))
              .flatMap(view => view.uses)
              .find(use => use.execution?.taskKey === 'locked-log-launch')
            if (lockedUse?.stage === 'quiescent' || lockedUse?.stage === 'unknown') break
            await new Promise(resolveWait => setTimeout(resolveWait, 250))
          }
          assert.equal(lockedUse?.stage, 'quiescent', JSON.stringify(lockedUse))
          assert.match(
            lockedUse?.reason ?? '',
            /^launch-failed: The launch failed before user code was released: .*(EACCES|permission denied)/i
          )
          assert.ok(!existsSync(lockedMarker), 'no user code ran')
          assert.equal((await attachment.authorize({ kind: 'write' })).kind, 'ready')
        } finally {
          for (const directory of lockedDirectories) await chmod(directory, 0o700)
          await lockedRuntime.dispose()
        }
      }
    )
  } finally {
    await attachment.close()
    await authority.close()
  }
  console.log(
    JSON.stringify(
      {
        result: 'passed',
        checks: passed,
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
