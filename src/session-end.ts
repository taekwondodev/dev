import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import type * as Scope from 'effect/Scope'
import type { TerminalHold } from './quit-scene.ts'

export type SignalCode = 1 | 130

export type Ending =
  | { readonly phase: 'running' }
  | { readonly phase: 'signalled'; readonly code: SignalCode }
  | { readonly phase: 'quitting'; readonly interrupted: boolean }
  | { readonly phase: 'sweeping'; readonly interrupted: boolean }

type Phase =
  | Extract<Ending, { phase: 'running' | 'signalled' }>
  | { readonly phase: 'quitting'; interrupted: boolean }
  | {
      readonly phase: 'sweeping'
      readonly notice: string
      interrupted: boolean
      held: boolean
      deferred: boolean
    }

export interface SweepInterruption {
  readonly proceed: () => boolean
  readonly hold: TerminalHold
}

export interface QuitStep {
  readonly proceed: () => boolean
  readonly interrupted: Effect.Effect<void>
  readonly end: () => void
}

export type DisposeForDev = () => Promise<void>

export interface SessionEnd {
  readonly parkPiDispose: (runtime: { dispose: () => Promise<void> }) => DisposeForDev
  readonly watchSignals: Effect.Effect<void, never, Scope.Scope>
  readonly requested: Effect.Effect<void>
  readonly current: () => Ending
  readonly beginQuitStep: (interruptNotice: string) => QuitStep | undefined
  readonly beginSweep: (interruptNotice: string) => SweepInterruption | undefined
}

export const makeSessionEnd = (): SessionEnd => {
  const requested = Deferred.makeUnsafe<void>()
  let ending: Phase = { phase: 'running' }
  let disposingForDev = false
  const quitInterrupted = Deferred.makeUnsafe<void>()
  let quitStepNotice: string | undefined
  const leaveRunning = (next: Extract<Phase, { phase: 'signalled' | 'quitting' }>): void => {
    ending = next
    Deferred.doneUnsafe(requested, Effect.void)
  }
  const onSignal = (code: SignalCode) => (): void => {
    switch (ending.phase) {
      case 'running':
        leaveRunning({ phase: 'signalled', code })
        return
      case 'signalled':
        return
      case 'quitting':
        ending.interrupted = true
        Deferred.doneUnsafe(quitInterrupted, Effect.void)
        if (quitStepNotice !== undefined) process.stderr.write(`\n${quitStepNotice}\n`)
        return
      case 'sweeping':
        ending.interrupted = true
        if (ending.held) ending.deferred = true
        else process.stderr.write(`\n${ending.notice}\n`)
    }
  }
  const onInterrupt = onSignal(130)
  const onTerminate = onSignal(1)
  const onHangup = onSignal(1)
  const quitUnlessSignalled = (): void => {
    if (ending.phase !== 'running') return
    process.removeListener('SIGHUP', onHangup)
    leaveRunning({ phase: 'quitting', interrupted: false })
  }
  return {
    parkPiDispose: runtime => {
      const dispose = runtime.dispose.bind(runtime)
      runtime.dispose = () => {
        if (disposingForDev) {
          disposingForDev = false
          return dispose()
        }
        queueMicrotask(quitUnlessSignalled)
        return new Promise<void>(() => {})
      }
      return () => {
        disposingForDev = true
        return runtime.dispose()
      }
    },
    watchSignals: Effect.acquireRelease(
      Effect.sync(() => {
        process.on('SIGINT', onInterrupt)
        process.on('SIGTERM', onTerminate)
        process.on('SIGHUP', onHangup)
      }),
      () =>
        Effect.sync(() => {
          process.removeListener('SIGINT', onInterrupt)
          process.removeListener('SIGTERM', onTerminate)
          process.removeListener('SIGHUP', onHangup)
        })
    ),
    requested: Deferred.await(requested),
    current: () => ending,
    beginQuitStep: interruptNotice => {
      if (ending.phase !== 'quitting') return undefined
      const quitting = ending
      quitStepNotice = interruptNotice
      return {
        proceed: () => !quitting.interrupted,
        interrupted: Deferred.await(quitInterrupted),
        end: () => {
          quitStepNotice = undefined
        },
      }
    },
    beginSweep: interruptNotice => {
      if (ending.phase !== 'quitting' || ending.interrupted) return undefined
      const sweeping: Extract<Phase, { phase: 'sweeping' }> = {
        phase: 'sweeping',
        notice: interruptNotice,
        interrupted: false,
        held: false,
        deferred: false,
      }
      ending = sweeping
      return {
        proceed: () => !sweeping.interrupted,
        hold: {
          begin: () => {
            sweeping.held = true
          },
          end: () => {
            sweeping.held = false
            if (sweeping.deferred) process.stderr.write(`${interruptNotice}\n`)
            sweeping.deferred = false
          },
        },
      }
    },
  }
}
