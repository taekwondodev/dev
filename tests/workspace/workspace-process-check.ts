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
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { Effect, ManagedRuntime } from 'effect'
import { WorkOwner } from '../../src/work-controller.ts'
import { checkChildWorkspace } from '../../src/work-child-workspace.ts'
import { classifyWriteDestination } from '../../src/workspace-paths.ts'
import { deferred, makeClaims, ownerEffect, waitUntil, within } from './workspace-check-support.ts'
import { openLifecycle, openShell } from './workspace-test-lifecycle.ts'
import { makeNativeWrites } from '../../src/workspace-native-write.ts'
import {
  WorkspaceError,
  type WorkspaceAttachment,
  type WorkspaceView,
} from '../../src/workspace-domain.ts'
import type { AttemptView } from '../../src/work-domain.ts'

const exec = promisify(execFile)

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
  sweeps: base.sweeps,
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
    const checkoutScope = { checkout: cwd, authorityRoot: authority.effect.root }
    const validatePath = async (path: string) => classifyWriteDestination(checkoutScope, cwd, path)
    await claim(
      'native writes classify external aliases and refuse traversal, foreign checkouts, metadata and hard links',
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
        assert.deepEqual(await validatePath('escape/file.txt'), {
          kind: 'external',
          operand: join(cwd, 'escape', 'file.txt'),
          path: join(outside, 'file.txt'),
        })
        assert.deepEqual(await validatePath(join(outside, 'new', 'file.txt')), {
          kind: 'external',
          operand: join(outside, 'new', 'file.txt'),
          path: join(outside, 'new', 'file.txt'),
        })
        await assert.rejects(
          validatePath(join(authority.effect.root, 'catalog.sqlite')),
          /authority metadata/
        )
        await assert.rejects(
          validatePath(join(outside, '.dev', 'coordination', 'installation.sqlite')),
          /coordination metadata/
        )
        const foreign = join(root, 'foreign')
        await exec('git', ['init', '--quiet', foreign])
        await assert.rejects(validatePath(join(foreign, 'missing', 'file.txt')), /another checkout/)
        const linked = join(root, 'linked')
        await exec('git', ['-C', cwd, 'worktree', 'add', '--quiet', '--detach', linked, 'HEAD'])
        await assert.rejects(validatePath(join(linked, 'file.txt')), /another checkout/)
        await writeFile(join(outside, 'HEAD'), 'ordinary configuration')
        await mkdir(join(outside, 'refs'))
        assert.equal((await validatePath(join(outside, 'file.txt'))).kind, 'external')
        await writeFile(join(cwd, 'HEAD'), 'ordinary project file')
        await mkdir(join(cwd, 'refs'))
        await mkdir(join(cwd, 'objects'))
        assert.equal((await validatePath('ordinary.txt')).kind, 'workspace')
        const bare = join(root, 'bare')
        await exec('git', ['init', '--bare', '--quiet', bare])
        await assert.rejects(validatePath(join(bare, 'config')), /administrative/)
        await symlink(foreign, join(outside, 'foreign-alias'))
        await assert.rejects(
          validatePath(join(outside, 'foreign-alias', 'file.txt')),
          /another checkout/
        )
        await writeFile(join(outside, 'file-parent'), 'sentinel')
        await assert.rejects(
          validatePath(join(outside, 'file-parent', 'child')),
          /directory|ENOTDIR/
        )
        const unreadable = join(outside, 'unreadable')
        await mkdir(unreadable, { mode: 0o000 })
        try {
          await assert.rejects(validatePath(join(unreadable, 'file')), /EACCES/)
        } finally {
          await chmod(unreadable, 0o700)
        }

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

    const outcome = deferred<AttemptView>()
    const runtime = ManagedRuntime.make(
      WorkOwner.layer({
        dataHome,
        cwd: grant.cwd,
        sessionId,
        profile: 'fixture',
        workspace: {
          lifecycle: authority.effect,
          attachment: attachment.effect,
          requestRebind: unexpectedRebind,
        },
        onOutcome: attempt => outcome.resolve(attempt),
      })
    )
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
          const finished = await within(outcome.promise, 20000, 'a process outcome')
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
      await runtime.dispose()
    }

    const shell = await openShell(async shellCwd => {
      const writer = await attachment.authorize({ kind: 'write', cwd: shellCwd })
      if (writer.kind !== 'ready') throw new Error('Unexpected shell handoff')
      return { attachment: attachment.effect, grant: writer.grant }
    })
    const shellUses = async () =>
      (await authority.inspect({ taskId: grant.taskId }))
        .flatMap(view => view.uses)
        .filter(use => use.effect === 'opaque' && use.execution?.taskKey === 'lead-shell')
    const settled = (count: number) =>
      waitUntil(
        `${count} shell uses to settle`,
        shellUses,
        uses => uses.length === count && uses.every(use => use.stage === 'quiescent'),
        { attempts: 60 }
      )
    const settledUse = (taskKey: string) =>
      waitUntil(
        `the ${taskKey} use to settle`,
        async () =>
          (await authority.inspect({ taskId: grant.taskId }))
            .flatMap(view => view.uses)
            .find(item => item.execution?.taskKey === taskKey),
        (use): use is WorkspaceView['uses'][number] =>
          use?.stage === 'quiescent' || use?.stage === 'unknown',
        { attempts: 60 }
      )
    const silent = { onData: () => undefined }
    await claim(
      'a lead shell returns its output and exit status when the shell exits, and its use ends only after a backgrounded descendant is observed gone',
      async () => {
        let output = ''
        const lateMarker = join(root, 'shell-late')
        const result = await shell.operations.exec(
          `printf visible; (sleep 1; printf late > ${JSON.stringify(lateMarker)}) & exit 3`,
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
        const view = await waitUntil(
          'the running command to be observed',
          checkout,
          (current): current is WorkspaceView =>
            current?.uses.some(use => use.stage === 'observed') === true,
          { attempts: 40, intervalMs: 100 }
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
          assert.ok(operation.path)
          await Effect.runPromise(
            nativeWrites.admit({
              toolCallId,
              scope: { checkout: grant.checkout, authorityRoot: authority.effect.root },
              destination: { kind: 'workspace', operand: operation.path, path: operation.path },
              lifecycle: { kind: 'workspace', attachment: attachment.effect, grant: operation },
            })
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
          ['Café.txt', 'CAFÉ.TXT'],
          ['straße.txt', 'STRASSE.txt'],
        ] as const) {
          const firstGrant = await authorizeNative(first)
          assert.ok(firstGrant.path)
          await Effect.runPromise(
            nativeWrites.admit({
              toolCallId: `fold-${first}`,
              scope: { checkout: grant.checkout, authorityRoot: authority.effect.root },
              destination: { kind: 'workspace', operand: firstGrant.path, path: firstGrant.path },
              lifecycle: { kind: 'workspace', attachment: attachment.effect, grant: firstGrant },
            })
          )
          const refused = await authorizeNative(second)
          assert.ok(refused.path)
          await assert.rejects(
            Effect.runPromise(
              nativeWrites.admit({
                toolCallId: `fold-${second}`,
                scope: { checkout: grant.checkout, authorityRoot: authority.effect.root },
                destination: { kind: 'workspace', operand: refused.path, path: refused.path },
                lifecycle: { kind: 'workspace', attachment: attachment.effect, grant: refused },
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
      'external native permits refuse changed destinations, metadata transitions, links, duplicate writes and lost controllers; settlement leaves no permit',
      async () => {
        const external = join(root, 'native-external')
        await mkdir(external)
        const scope = { checkout: grant.checkout, authorityRoot: authority.effect.root }
        const admit = (path: string) =>
          Effect.runPromise(
            nativeWrites.admit({
              toolCallId: path,
              scope,
              destination: classifyWriteDestination(scope, grant.cwd, path),
              lifecycle: { kind: 'local', validate: Effect.void },
            })
          )
        const sentinel = join(external, 'sentinel')
        await writeFile(sentinel, 'two')
        await admit(sentinel)
        await assert.rejects(admit(sentinel), /still in flight/)
        await Effect.runPromise(nativeWrites.finish(sentinel))
        for (const kind of ['ancestor', 'checkout', 'final-link', 'hard-link']) {
          const directory = join(external, kind)
          const file = join(directory, 'file')
          await mkdir(directory)
          await writeFile(file, 'one')
          await admit(file)
          if (kind === 'ancestor') {
            await rename(directory, `${directory}-moved`)
            await symlink(external, directory)
          } else if (kind === 'checkout') await exec('git', ['init', '--quiet', directory])
          else {
            await rm(file)
            if (kind === 'final-link') await symlink(sentinel, file)
            else await link(sentinel, file)
          }
          await assert.rejects(
            nativeWrites.writeOperations.writeFile(file, 'forbidden'),
            /changed|now resolves elsewhere|no admitted destination/
          )
          await Effect.runPromise(nativeWrites.finish(file))
          assert.equal(await readFile(sentinel, 'utf8'), 'two')
          if (kind === 'hard-link') await rm(file)
          assert.ok(!existsSync(join(external, 'file')))
        }
        const original = join(external, 'original')
        const alternative = join(external, 'alternative')
        const alias = join(external, 'alias')
        await mkdir(original)
        await mkdir(alternative)
        await writeFile(join(original, 'file'), 'one')
        await writeFile(join(alternative, 'file'), 'two')
        await symlink(original, alias)
        await admit(join(alias, 'file'))
        await admit(join(alternative, 'file'))
        await rm(alias)
        await symlink(alternative, alias)
        await assert.rejects(
          nativeWrites.writeOperations.writeFile(join(alias, 'file'), 'forbidden'),
          /now resolves elsewhere/
        )
        assert.equal(await readFile(join(original, 'file'), 'utf8'), 'one')
        assert.equal(await readFile(join(alternative, 'file'), 'utf8'), 'two')
        const disconnected = join(external, 'disconnected')
        await Effect.runPromise(
          nativeWrites.admit({
            toolCallId: 'disconnected',
            scope,
            destination: classifyWriteDestination(scope, grant.cwd, disconnected),
            lifecycle: { kind: 'local', validate: checkChildWorkspace(grant, 'write') },
          })
        )
        await assert.rejects(
          nativeWrites.writeOperations.writeFile(disconnected, 'forbidden'),
          /IPC is unavailable/
        )
        assert.ok(!existsSync(disconnected))
        await admit(sentinel)
        await Effect.runPromise(nativeWrites.settle)
        await assert.rejects(
          nativeWrites.writeOperations.writeFile(sentinel, 'forbidden'),
          /no admitted destination/
        )
        assert.equal(await readFile(sentinel, 'utf8'), 'two')
      }
    )

    await claim(
      'a controller launch whose identity and first failure report are lost settles as never launched instead of unknown, and the checkout stays writable',
      async () => {
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
          WorkOwner.layer({
            dataHome,
            cwd: grant.cwd,
            sessionId,
            profile: 'fixture',
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
          const lossyUse = await settledUse('lossy-launch')
          assert.equal(lossyUse.stage, 'quiescent', JSON.stringify(lossyUse))
          assert.match(lossyUse.reason ?? '', /^launch-failed: /)
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
          WorkOwner.layer({
            dataHome,
            cwd: grant.cwd,
            sessionId,
            profile: 'fixture',
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
          const finalUse = await settledUse('flaky-final')
          assert.equal(finalUse.stage, 'quiescent', JSON.stringify(finalUse))
          assert.equal(refused, 1)
        } finally {
          await flakyRuntime.dispose()
        }
      }
    )

    await claim(
      'a controller launch that fails after its durable launch intent but before spawning rejects, runs no user code, settles its use as quiescent with a launch-failed reason instead of unknown, and the checkout stays writable',
      async () => {
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
          WorkOwner.layer({
            dataHome,
            cwd: grant.cwd,
            sessionId,
            profile: 'fixture',
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
          const lockedUse = await settledUse('locked-log-launch')
          assert.equal(lockedUse.stage, 'quiescent', JSON.stringify(lockedUse))
          assert.match(
            lockedUse.reason ?? '',
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
