import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants as osConstants } from 'node:os'
import type { Writable } from 'node:stream'
import type { BashOperations } from '@earendil-works/pi-coding-agent'
import { Deferred, Duration, Effect, Exit, FiberSet, Option, Schema, type Scope } from 'effect'
import { ChildProcessSpawner } from 'effect/process'
import { errorText } from './error-text.ts'
import {
  observeFamily,
  processGate,
  processGateScript,
  processTable,
  transientRetry,
  type ObservedProcess,
  type TrackedFamily,
} from './process-family.ts'
import type { ProcessObservation } from './work-lifecycle.ts'
import type {
  WorkspaceAttachment,
  WorkspaceError,
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
  readonly stop: Effect.Effect<void>
}

export class ShellCommandError extends Schema.TaggedError<ShellCommandError>()(
  'ShellCommandError',
  { message: Schema.String }
) {}

interface ShellExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

interface LiveShell {
  readonly root: ObservedProcess
  known: readonly ProcessObservation[]
  readonly settled: Deferred.Deferred<void>
}

interface Launched {
  readonly child: ChildProcess
  readonly exited: Deferred.Deferred<ShellExit, ShellCommandError>
  readonly shell: LiveShell
  readonly detach: () => void
  readonly aborted: () => boolean
}

type Report = (fact: WorkspaceExecutionFact) => Effect.Effect<void, WorkspaceError>

const OBSERVATION_INTERVAL = Duration.millis(500)
const EXIT_DRAIN_MS = 100
const STOP_WAIT = Duration.seconds(5)
const KILL_RETRY = Duration.millis(100)

const failure = (message: string) => new ShellCommandError({ message })

const terminate = Effect.fnUntraced(
  function* (shell: LiveShell) {
    for (;;) {
      const table = yield* Effect.option(processTable)
      if (Option.isNone(table)) return
      const grouped = table.value.some(item => item.group === shell.root.pid)
      const tracked = table.value.filter(item =>
        shell.known.some(known => known.pid === item.pid && known.birth === item.birth)
      )
      if (!grouped && tracked.length === 0) return
      yield* Effect.sync(() => {
        if (grouped)
          try {
            process.kill(-shell.root.pid, 'SIGKILL')
          } catch {}
        for (const item of tracked)
          try {
            process.kill(item.pid, 'SIGKILL')
          } catch {}
      })
      yield* Effect.sleep(KILL_RETRY)
    }
  },
  Effect.timeoutOrElse({ duration: STOP_WAIT, orElse: () => Effect.void })
)

const exitOf = (child: ChildProcess): Deferred.Deferred<ShellExit, ShellCommandError> => {
  const exited = Deferred.makeUnsafe<ShellExit, ShellCommandError>()
  child.once('error', cause => Deferred.doneUnsafe(exited, Exit.fail(failure(errorText(cause)))))
  child.once('exit', (code, signal) => {
    setTimeout(() => {
      child.stdout?.destroy()
      child.stderr?.destroy()
      Deferred.doneUnsafe(exited, Exit.succeed({ code, signal }))
    }, EXIT_DRAIN_MS)
  })
  return exited
}

export const makeWorkspaceShell = Effect.fnUntraced(function* (
  admit: (cwd: string) => Effect.Effect<WorkspaceAdmission, WorkspaceError>
): Effect.fn.Return<WorkspaceShell, never, Scope.Scope | ChildProcessSpawner.ChildProcessSpawner> {
  const withSpawner = Effect.provideService(
    ChildProcessSpawner.ChildProcessSpawner,
    yield* ChildProcessSpawner.ChildProcessSpawner
  )
  const observers = yield* FiberSet.make<void>()
  const runInBackground = yield* FiberSet.runtime(observers)()
  const live = new Map<number, LiveShell>()
  const launches = new Set<Deferred.Deferred<void>>()
  let stopping = false

  const observe = Effect.fnUntraced(
    function* (report: Report, child: ChildProcess, shell: LiveShell) {
      let family: TrackedFamily = {
        pid: shell.root.pid,
        root: shell.root,
        known: shell.known,
        reported: undefined,
      }
      for (;;) {
        family = yield* observeFamily(family, {
          rootExited: child.exitCode !== null || child.signalCode !== null,
          report: processes => report({ kind: 'observed', processes }),
        }).pipe(withSpawner)
        shell.known = family.known
        if (family.known.length === 0) {
          yield* report({
            kind: 'quiescent',
            reason: 'The shell process group and every tracked descendant were observed gone',
          }).pipe(Effect.retry(transientRetry))
          return
        }
        yield* Effect.sleep(OBSERVATION_INTERVAL)
      }
    },
    (effect, report) =>
      effect.pipe(
        Effect.catch(cause =>
          Effect.ignore(
            report({
              kind: 'unknown',
              reason: `Shell process observation was lost: ${cause.message}`,
            })
          )
        )
      )
  )

  const track = (report: Report, child: ChildProcess, root: ObservedProcess): LiveShell => {
    const shell: LiveShell = { root, known: [root], settled: Deferred.makeUnsafe<void>() }
    live.set(root.pid, shell)
    runInBackground(
      observe(report, child, shell).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            live.delete(root.pid)
            Deferred.doneUnsafe(shell.settled, Exit.void)
          })
        )
      )
    )
    return shell
  }

  const launch = Effect.fnUntraced(function* (
    command: string,
    cwd: string,
    env: NodeJS.ProcessEnv | undefined,
    signal: AbortSignal | undefined
  ): Effect.fn.Return<Launched, ShellCommandError | WorkspaceError> {
    const { attachment, grant: within } = yield* admit(cwd)
    const execution = {
      sessionId: attachment.binding.conversation.sessionId,
      taskKey: 'lead-shell',
      attemptId: randomUUID(),
      generation: 'lead',
    }
    const admitted = yield* attachment.authorize({ kind: 'opaque', within, cwd, execution })
    if (admitted.kind !== 'ready')
      return yield* failure(
        'Workspace admission changed before the shell started; the command was not executed.'
      )
    const { grant } = admitted
    const report: Report = fact => attachment.reportExecution(grant, fact)
    const notLaunched = (reason: string, cause: ShellCommandError | WorkspaceError) =>
      Effect.ignore(report({ kind: 'launch-failed', reason })).pipe(
        Effect.andThen(Effect.fail(cause))
      )
    const refusal = (): string | undefined => {
      if (stopping) return 'the host is stopping its shells'
      if (signal?.aborted === true) return 'aborted'
      return undefined
    }
    const early = refusal()
    if (early !== undefined) return yield* notLaunched(`${early} before launch`, failure(early))

    yield* report({ kind: 'launch-intent', execution }).pipe(
      Effect.catch(cause => notLaunched('launch intent was not recorded', cause))
    )
    const child = yield* Effect.try({
      try: () =>
        spawn('/bin/bash', ['-c', processGateScript, 'dev-shell', command], {
          cwd,
          detached: true,
          env: env ?? process.env,
          stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
        }),
      catch: cause => failure(errorText(cause)),
    }).pipe(Effect.catch(cause => notLaunched('the shell could not be spawned', cause)))
    const exited = exitOf(child)
    const { pid } = child
    if (pid === undefined) {
      const outcome = yield* Effect.exit(Deferred.await(exited))
      return yield* notLaunched(
        'the shell did not start',
        Exit.isFailure(outcome)
          ? failure('the shell did not start')
          : failure('The shell exited before its identity was available')
      )
    }

    const killGated = () => {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {}
    }
    const captured = yield* Effect.gen(function* () {
      const gate = yield* Effect.try({
        try: () => processGate(child),
        catch: cause => failure(errorText(cause)),
      })
      const table = yield* processTable.pipe(
        withSpawner,
        Effect.mapError(cause => failure(cause.message))
      )
      const root = table.find(item => item.pid === pid)
      if (root === undefined) return yield* failure('the shell identity could not be captured')
      return { gate, root }
    }).pipe(
      Effect.catch(cause =>
        Effect.sync(killGated).pipe(Effect.andThen(notLaunched(cause.message, cause)))
      )
    )
    const identity = captured.root
    const gate: Writable = captured.gate
    yield* report({ kind: 'spawned', process: identity }).pipe(
      Effect.catch(cause =>
        Effect.gen(function* () {
          killGated()

          yield* report({ kind: 'launch-failed', reason: cause.message }).pipe(
            Effect.catch(() => Effect.sync(() => track(report, child, identity)))
          )
          return yield* cause
        })
      )
    )
    let aborted = false
    let shell: LiveShell | undefined
    const onAbort = () => {
      aborted = true
      if (shell === undefined) killGated()
      else runInBackground(terminate(shell).pipe(withSpawner))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const detach = () => signal?.removeEventListener('abort', onAbort)
    yield* Effect.gen(function* () {
      yield* report({ kind: 'started' })
      const late = refusal()
      if (late !== undefined) return yield* failure(late)
      gate.end('\n')
    }).pipe(
      Effect.catch(cause =>
        Effect.gen(function* () {
          detach()
          killGated()
          track(report, child, identity)
          yield* Effect.ignore(Deferred.await(exited))
          return yield* cause
        })
      )
    )
    shell = track(report, child, identity)
    return { child, exited, shell, detach, aborted: () => aborted }
  })

  const execute = Effect.fnUntraced(function* (
    command: string,
    cwd: string,
    options: Parameters<BashOperations['exec']>[2]
  ): Effect.fn.Return<{ exitCode: number }, ShellCommandError | WorkspaceError> {
    const { onData, signal, timeout, env } = options
    if (signal?.aborted) return yield* failure('aborted')
    const timeoutMs = timeout === undefined ? undefined : timeout * 1000
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0))
      return yield* failure('Invalid timeout: must be a finite number of seconds')
    if (stopping)
      return yield* failure('The workspace shell is stopping; the command was not executed.')
    const launching = Deferred.makeUnsafe<void>()
    launches.add(launching)
    const launched = yield* launch(command, cwd, env, signal).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          launches.delete(launching)
          Deferred.doneUnsafe(launching, Exit.void)
        })
      )
    )
    const { child, exited, shell, detach, aborted } = launched
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    let timedOut = false
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            runInBackground(terminate(shell).pipe(withSpawner))
          }, timeoutMs)
    return yield* Deferred.await(exited).pipe(
      Effect.flatMap(outcome => {
        if (aborted()) return Effect.fail(failure('aborted'))
        if (timedOut) return Effect.fail(failure(`timeout:${timeout}`))
        return Effect.succeed({
          exitCode:
            outcome.code ??
            (outcome.signal === null ? 1 : 128 + (osConstants.signals[outcome.signal] ?? 0)),
        })
      }),
      Effect.ensuring(
        Effect.sync(() => {
          if (timer !== undefined) clearTimeout(timer)
          detach()
        })
      )
    )
  })

  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>())
  return {
    operations: {
      exec: (command, cwd, options) => runPromise(execute(command, cwd, options)),
    },
    live: () => live.size,
    stop: Effect.gen(function* () {
      stopping = true
      yield* Effect.forEach([...launches], Deferred.await, { discard: true }).pipe(
        Effect.timeoutOrElse({ duration: STOP_WAIT, orElse: () => Effect.void })
      )
      const shells = [...live.values()]
      yield* Effect.forEach(shells, shell => terminate(shell).pipe(withSpawner), {
        concurrency: 'unbounded',
        discard: true,
      })
      yield* Effect.forEach(shells, shell => Deferred.await(shell.settled), {
        discard: true,
      }).pipe(Effect.timeoutOrElse({ duration: STOP_WAIT, orElse: () => Effect.void }))
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          stopping = false
        })
      )
    ),
  }
})
