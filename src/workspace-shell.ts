import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants as osConstants } from 'node:os'
import type { Writable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import { Effect } from 'effect'
import type { BashOperations } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js'
import {
  processGate,
  processGateScript,
  readProcessTable,
  rootIdentityReused,
  type ObservedProcess,
} from './process-family.ts'
import { ownedProcesses, type ProcessObservation } from './work-lifecycle.ts'
import type {
  WorkspaceAttachment,
  WorkspaceExecutionFact,
  WorkspaceGrant,
} from './workspace-domain.ts'

export interface WorkspaceAdmission {
  readonly attachment: WorkspaceAttachment
  readonly grant: WorkspaceGrant
}

export interface WorkspaceShell {
  readonly operations: BashOperations
  live(): number
  stop(): Promise<void>
}

interface LiveShell {
  readonly root: ObservedProcess
  known: readonly ProcessObservation[]
  readonly settled: Promise<void>
}

interface Launched {
  readonly child: ChildProcess
  readonly exited: Promise<{
    readonly code: number | null
    readonly signal: NodeJS.Signals | null
  }>
  readonly shell: LiveShell
  readonly detach: () => void
  readonly aborted: () => boolean
}

const OBSERVATION_INTERVAL_MS = 500
const EXIT_DRAIN_MS = 100
const STOP_WAIT_MS = 5000
const KILL_RETRY_MS = 100
const TRANSIENT_ATTEMPTS = 5

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const retryTransient = async <A>(operation: () => Promise<A>): Promise<A> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation()
    } catch (cause) {
      if (attempt >= TRANSIENT_ATTEMPTS) throw cause
      await sleep(OBSERVATION_INTERVAL_MS / 2)
    }
  }
}

// A PID is signalled only while a fresh table still shows it with the identity observed
// earlier, and the root's group only while it still has members, since neither ID can
// be reused before then. A family that keeps forking is signalled until it is empty.
const terminate = async (shell: LiveShell): Promise<void> => {
  const deadline = Date.now() + STOP_WAIT_MS
  while (Date.now() < deadline) {
    const table = await readProcessTable().catch(() => undefined)
    if (table === undefined) return
    const grouped = table.some(item => item.group === shell.root.pid)
    const tracked = table.filter(item =>
      shell.known.some(known => known.pid === item.pid && known.birth === item.birth)
    )
    if (!grouped && tracked.length === 0) return
    if (grouped)
      try {
        process.kill(-shell.root.pid, 'SIGKILL')
      } catch {}
    for (const item of tracked)
      try {
        process.kill(item.pid, 'SIGKILL')
      } catch {}
    await sleep(KILL_RETRY_MS)
  }
}

// Resolves on the shell's own exit rather than on stdio closure, which a backgrounded
// descendant holding the pipes can postpone indefinitely.
const waitForExit = (
  child: ChildProcess
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> =>
  new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('exit', (code, signal) => {
      setTimeout(() => {
        child.stdout?.destroy()
        child.stderr?.destroy()
        resolveExit({ code, signal })
      }, EXIT_DRAIN_MS)
    })
  })

export const createWorkspaceShell = (
  admit: (cwd: string) => Promise<WorkspaceAdmission>
): WorkspaceShell => {
  const live = new Map<number, LiveShell>()
  const launches = new Set<Promise<unknown>>()
  let stopping = false

  const observe = async (
    report: (fact: WorkspaceExecutionFact) => Promise<void>,
    child: ChildProcess,
    shell: { readonly root: ObservedProcess; known: readonly ProcessObservation[] }
  ): Promise<void> => {
    let signature: string | undefined
    try {
      for (;;) {
        const table = await retryTransient(readProcessTable)
        const exited = child.exitCode !== null || child.signalCode !== null
        if (rootIdentityReused(table, shell.root, exited))
          throw new Error('the shell root identity was reused')
        shell.known = ownedProcesses(table, shell.root.pid, shell.known, shell.root)
        const processes = shell.known.flatMap(item =>
          item.birth === undefined ? [] : [{ ...item, birth: item.birth }]
        )
        if (processes.length !== shell.known.length)
          throw new Error('a tracked process has no birth identity')
        const next = JSON.stringify(processes)
        if (next !== signature) {
          await retryTransient(() => report({ kind: 'observed', processes }))
          signature = next
        }
        if (processes.length === 0) {
          await retryTransient(() =>
            report({
              kind: 'quiescent',
              reason: 'The shell process group and every tracked descendant were observed gone',
            })
          )
          return
        }
        await sleep(OBSERVATION_INTERVAL_MS)
      }
    } catch (cause) {
      await report({
        kind: 'unknown',
        reason: `Shell process observation was lost: ${messageOf(cause)}`,
      }).catch(() => undefined)
    }
  }

  const track = (
    report: (fact: WorkspaceExecutionFact) => Promise<void>,
    child: ChildProcess,
    root: ObservedProcess
  ): LiveShell => {
    const observed = { root, known: [root] as readonly ProcessObservation[] }
    const shell: LiveShell = Object.assign(observed, {
      settled: observe(report, child, observed).finally(() => live.delete(root.pid)),
    })
    live.set(root.pid, shell)
    return shell
  }

  const launch = async (
    command: string,
    cwd: string,
    env: NodeJS.ProcessEnv | undefined,
    signal: AbortSignal | undefined
  ): Promise<Launched> => {
    const { attachment, grant: within } = await admit(cwd)
    const execution = {
      sessionId: attachment.binding.conversation.sessionId,
      taskKey: 'lead-shell',
      attemptId: randomUUID(),
      generation: 'lead',
    }
    const admitted = await Effect.runPromise(
      attachment.authorize({
        access: 'write',
        effect: 'opaque',
        within,
        cwd,
        execution,
      })
    )
    if (admitted.kind !== 'ready')
      throw new Error(
        'Workspace admission changed before the shell started; the command was not executed.'
      )
    const { grant } = admitted
    const report = (fact: WorkspaceExecutionFact) =>
      Effect.runPromise(attachment.reportExecution(grant, fact))
    const notLaunched = async (reason: string, cause: unknown): Promise<never> => {
      await report({ kind: 'launch-failed', reason }).catch(() => undefined)
      throw cause instanceof Error ? cause : new Error(reason)
    }
    const refusal = (): string | undefined => {
      if (stopping) return 'the host is stopping its shells'
      if (signal?.aborted === true) return 'aborted'
      return undefined
    }
    const early = refusal()
    if (early !== undefined) return notLaunched(`${early} before launch`, new Error(early))

    await report({ kind: 'launch-intent', execution }).catch(cause =>
      notLaunched('launch intent was not recorded', cause)
    )
    let child: ChildProcess
    try {
      child = spawn('/bin/bash', ['-c', processGateScript, 'dev-shell', command], {
        cwd,
        detached: true,
        env: env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      })
    } catch (cause) {
      return notLaunched('the shell could not be spawned', cause)
    }
    const exited = waitForExit(child)
    const { pid } = child
    if (pid === undefined)
      return notLaunched(
        'the shell did not start',
        await exited.then(
          () => new Error('The shell exited before its identity was available'),
          (cause: unknown) => cause
        )
      )
    // Until the gate opens only the gated shell exists, and it is alive, so its group
    // cannot belong to anything else.
    const killGated = () => {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {}
    }
    let root: ObservedProcess | undefined
    let gate: Writable
    try {
      gate = processGate(child)
      root = (await retryTransient(readProcessTable)).find(item => item.pid === pid)
      if (root === undefined) throw new Error('the shell identity could not be captured')
    } catch (cause) {
      killGated()
      return notLaunched(messageOf(cause), cause)
    }
    const identity = root
    try {
      await report({ kind: 'spawned', process: identity })
    } catch (cause) {
      killGated()
      // A lost acknowledgment may still have recorded the identity; the killed family
      // is then observed gone rather than reported as never launched.
      await report({ kind: 'launch-failed', reason: messageOf(cause) }).catch(() =>
        track(report, child, identity)
      )
      throw cause
    }
    let aborted = false
    let shell: LiveShell | undefined
    const onAbort = () => {
      aborted = true
      if (shell === undefined) killGated()
      else void terminate(shell)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const detach = () => signal?.removeEventListener('abort', onAbort)
    try {
      await report({ kind: 'started' })
      const late = refusal()
      if (late !== undefined) throw new Error(late)
      gate.end('\n')
    } catch (cause) {
      detach()
      killGated()
      track(report, child, identity)
      await exited.catch(() => undefined)
      throw cause
    }
    shell = track(report, child, identity)
    return { child, exited, shell, detach, aborted: () => aborted }
  }

  const exec: BashOperations['exec'] = async (command, cwd, { onData, signal, timeout, env }) => {
    if (signal?.aborted) throw new Error('aborted')
    const timeoutMs = timeout === undefined ? undefined : timeout * 1000
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0))
      throw new Error('Invalid timeout: must be a finite number of seconds')
    if (stopping) throw new Error('The workspace shell is stopping; the command was not executed.')
    const launching = launch(command, cwd, env, signal)
    launches.add(launching)
    let launched: Launched
    try {
      launched = await launching
    } finally {
      launches.delete(launching)
    }
    const { child, exited, shell, detach, aborted } = launched
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    let timedOut = false
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            void terminate(shell)
          }, timeoutMs)
    try {
      const outcome = await exited
      if (aborted()) throw new Error('aborted')
      if (timedOut) throw new Error(`timeout:${timeout}`)
      return {
        exitCode:
          outcome.code ??
          (outcome.signal === null ? 1 : 128 + (osConstants.signals[outcome.signal] ?? 0)),
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      detach()
    }
  }

  return {
    operations: { exec },
    live: () => live.size,
    async stop() {
      stopping = true
      try {
        await Promise.race([Promise.allSettled(launches), sleep(STOP_WAIT_MS)])
        const shells = [...live.values()]
        await Promise.all(shells.map(terminate))
        await Promise.race([
          Promise.allSettled(shells.map(shell => shell.settled)),
          sleep(STOP_WAIT_MS),
        ])
      } finally {
        stopping = false
      }
    },
  }
}
