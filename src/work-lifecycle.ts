import {
  type ArtifactState,
  type AttemptLifecycleToken,
  type AttemptRecord,
  type AttemptState,
  activeAttemptState,
  terminalAttemptState,
  unknownAttemptState,
} from './work-domain.ts'
import { isDeepStrictEqual } from 'node:util'

export interface ProcessObservation {
  readonly pid: number
  readonly parent: number
  readonly group: number
  readonly birth: string | undefined
}

export type AttemptProgressFacts = Partial<
  Pick<AttemptRecord, 'model' | 'effort' | 'sessionFile' | 'resources' | 'context' | 'usage'>
>

export interface AttemptResultFacts extends AttemptProgressFacts {
  readonly text: string
  readonly error?: string
  readonly quotaExhausted?: boolean
}

export interface AttemptCompletionFacts {
  readonly artifactAtCompletion: ArtifactState
  readonly changedDuringRun: boolean | 'unknown'
  readonly completedAt: number
  readonly cleanupError?: string
}

export interface LifecycleTransition {
  readonly accepted: boolean
  readonly changed: boolean
  readonly snapshot: AttemptRecord
  readonly state: AttemptState
  readonly resultText?: string
  readonly quotaExhausted?: boolean
}

export interface AttemptLifecycle {
  readonly token: AttemptLifecycleToken
  readonly snapshot: () => AttemptRecord
  readonly state: () => AttemptState
  readonly isActive: () => boolean
  readonly isUnknown: () => boolean
  readonly isTerminal: () => boolean
  readonly hasExited: () => boolean
  readonly hasResult: () => boolean
  readonly pid: () => number | undefined
  readonly knownProcesses: () => readonly ProcessObservation[]
  readonly rootProcess: () => ProcessObservation | undefined
  readonly transition: {
    readonly spawn: (token: AttemptLifecycleToken, pid: number) => LifecycleTransition
    readonly progress: (
      token: AttemptLifecycleToken,
      facts: AttemptProgressFacts
    ) => LifecycleTransition
    readonly result: (
      token: AttemptLifecycleToken,
      facts: AttemptResultFacts
    ) => LifecycleTransition
    readonly processError: (token: AttemptLifecycleToken, message: string) => LifecycleTransition
    readonly protocolError: (token: AttemptLifecycleToken, message: string) => LifecycleTransition
    readonly rejectedMessage: (token: AttemptLifecycleToken, message: string) => LifecycleTransition
    readonly exit: (
      token: AttemptLifecycleToken,
      code: number | null,
      signal: NodeJS.Signals | null
    ) => LifecycleTransition
    readonly processes: (
      token: AttemptLifecycleToken,
      processes: readonly ProcessObservation[]
    ) => LifecycleTransition
    readonly waiting: (token: AttemptLifecycleToken) => LifecycleTransition
    readonly cancel: (
      token: AttemptLifecycleToken,
      requestedAt: number,
      reason: string
    ) => LifecycleTransition
    readonly unknown: (token: AttemptLifecycleToken, message: string) => LifecycleTransition
    readonly complete: (
      token: AttemptLifecycleToken,
      facts: AttemptCompletionFacts
    ) => LifecycleTransition
    readonly persistenceError: (
      token: AttemptLifecycleToken,
      message: string
    ) => LifecycleTransition
    readonly deliveryError: (token: AttemptLifecycleToken, message: string) => LifecycleTransition
    readonly cleanupError: (token: AttemptLifecycleToken, message: string) => LifecycleTransition
  }
}

type AttemptFacts = {
  [K in keyof AttemptRecord as K extends 'status' | 'completedAt' ? never : K]: AttemptRecord[K]
}

interface MutableAttemptState {
  readonly record: AttemptFacts
  phase: AttemptState
  known: readonly ProcessObservation[]
  root?: ProcessObservation
  exited: boolean
  resultReceived: boolean
}

const sameToken = (left: AttemptLifecycleToken, right: AttemptLifecycleToken): boolean =>
  left.sessionId === right.sessionId &&
  left.attemptId === right.attemptId &&
  left.generation === right.generation

const sameProcesses = (
  left: readonly ProcessObservation[],
  right: readonly ProcessObservation[]
): boolean =>
  left.length === right.length &&
  left.every(
    (item, index) =>
      item.pid === right[index]?.pid &&
      item.parent === right[index]?.parent &&
      item.group === right[index]?.group &&
      item.birth === right[index]?.birth
  )

const sameIdentity = (left: ProcessObservation, right: ProcessObservation): boolean =>
  left.pid === right.pid &&
  left.birth !== undefined &&
  right.birth !== undefined &&
  left.birth === right.birth

const nextRevision = (revision: number): number => {
  if (revision >= Number.MAX_SAFE_INTEGER) throw new Error('Attempt revision exhausted')
  return revision + 1
}

const makePhase = (record: AttemptRecord): AttemptState => {
  switch (record.status) {
    case 'running':
    case 'waiting':
      return activeAttemptState(record.status)
    case 'unknown':
      return unknownAttemptState
    case 'completed':
    case 'failed':
    case 'cancelled':
      return terminalAttemptState(record.status, record.completedAt)
  }
}

const phaseOf = (phase: AttemptState): AttemptState => structuredClone(phase)

const recordOf = (state: MutableAttemptState): AttemptRecord => {
  const record = structuredClone(state.record)
  switch (state.phase._tag) {
    case 'active':
      return { ...record, status: state.phase.status }
    case 'unknown':
      return { ...record, status: 'unknown' }
    case 'terminal':
      return { ...record, status: state.phase.status, completedAt: state.phase.completedAt }
  }
}

const resultOf = (
  state: MutableAttemptState,
  accepted: boolean,
  changed: boolean,
  resultText?: string,
  quotaExhausted?: boolean
): LifecycleTransition => ({
  accepted,
  changed,
  snapshot: recordOf(state),
  state: phaseOf(state.phase),
  ...(resultText === undefined ? {} : { resultText }),
  ...(quotaExhausted === undefined ? {} : { quotaExhausted }),
})

const makeLifecycle = (initial: AttemptRecord): AttemptLifecycle => {
  const token = Object.freeze({
    sessionId: initial.owner.sessionId,
    attemptId: initial.id,
    generation: initial.owner.generation,
  }) satisfies AttemptLifecycleToken
  const state: MutableAttemptState = {
    record: (() => {
      const { status: _status, completedAt: _completedAt, ...record } = structuredClone(initial)
      return record
    })(),
    phase: makePhase(initial),
    known: [],
    exited: initial.exitCode !== undefined || initial.completedAt !== undefined,
    resultReceived: initial.kind === 'process' || initial.status === 'completed',
  }

  const accepts = (eventToken: AttemptLifecycleToken): boolean => sameToken(token, eventToken)
  const active = (eventToken: AttemptLifecycleToken): boolean =>
    accepts(eventToken) && state.phase._tag === 'active'
  const commandable = (eventToken: AttemptLifecycleToken): boolean =>
    accepts(eventToken) && state.phase._tag !== 'terminal'
  const changed = (mutate: () => boolean): LifecycleTransition => {
    const didChange = mutate()
    if (didChange) state.record.revision = nextRevision(state.record.revision)
    return resultOf(state, true, didChange)
  }
  const rejected = (): LifecycleTransition => resultOf(state, false, false)
  const put = <K extends keyof AttemptFacts>(key: K, value: AttemptFacts[K]): boolean => {
    if (isDeepStrictEqual(state.record[key], value)) return false
    state.record[key] = structuredClone(value)
    return true
  }
  const applyProgress = (facts: AttemptProgressFacts): boolean => {
    let didChange = false
    if (facts.model !== undefined) didChange = put('model', facts.model) || didChange
    if (facts.effort !== undefined) didChange = put('effort', facts.effort) || didChange
    if (facts.sessionFile !== undefined)
      didChange = put('sessionFile', facts.sessionFile) || didChange
    if (facts.resources !== undefined) didChange = put('resources', facts.resources) || didChange
    if (facts.context !== undefined) didChange = put('context', facts.context) || didChange
    if (facts.usage !== undefined) didChange = put('usage', facts.usage) || didChange
    return didChange
  }

  const transition = {
    spawn(eventToken: AttemptLifecycleToken, pid: number): LifecycleTransition {
      if (!active(eventToken) || state.record.cancelRequestedAt !== undefined) return rejected()
      return changed(() => {
        let didChange = false
        didChange = put('pid', pid) || didChange
        if (state.root === undefined) state.root = { pid, parent: 0, group: pid, birth: undefined }
        if (state.phase._tag === 'active' && state.phase.status !== 'running') {
          state.phase = activeAttemptState('running')
          didChange = true
        }
        return didChange
      })
    },
    progress(eventToken: AttemptLifecycleToken, facts: AttemptProgressFacts): LifecycleTransition {
      if (
        !active(eventToken) ||
        state.record.cancelRequestedAt !== undefined ||
        state.resultReceived
      )
        return rejected()
      return changed(() => applyProgress(facts))
    },
    result(eventToken: AttemptLifecycleToken, facts: AttemptResultFacts): LifecycleTransition {
      if (
        !active(eventToken) ||
        state.record.cancelRequestedAt !== undefined ||
        state.resultReceived
      )
        return rejected()
      const transitionResult = changed(() => {
        let didChange = applyProgress(facts)
        state.resultReceived = true
        didChange = true
        if (facts.error !== undefined) didChange = put('error', facts.error) || didChange
        return didChange
      })
      return {
        ...transitionResult,
        resultText: facts.text,
        ...(facts.quotaExhausted === undefined ? {} : { quotaExhausted: facts.quotaExhausted }),
      }
    },
    processError(eventToken: AttemptLifecycleToken, message: string): LifecycleTransition {
      if (!active(eventToken)) return rejected()
      return changed(() => put('error', message))
    },
    protocolError(eventToken: AttemptLifecycleToken, message: string): LifecycleTransition {
      if (!active(eventToken)) return rejected()
      return changed(() => put('protocolError', message))
    },
    rejectedMessage(eventToken: AttemptLifecycleToken, message: string): LifecycleTransition {
      if (!active(eventToken)) return rejected()
      return changed(() => {
        let didChange = put('protocolError', message)
        didChange = put('error', `Rejected child message: ${message}`) || didChange
        return didChange
      })
    },
    exit(
      eventToken: AttemptLifecycleToken,
      code: number | null,
      signal: NodeJS.Signals | null
    ): LifecycleTransition {
      if (!active(eventToken) || state.exited) return rejected()
      return changed(() => {
        state.exited = true
        put('exitCode', code)
        put('signal', signal)
        return true
      })
    },
    processes(
      eventToken: AttemptLifecycleToken,
      processes: readonly ProcessObservation[]
    ): LifecycleTransition {
      if (!active(eventToken) || sameProcesses(state.known, processes)) return rejected()
      return changed(() => {
        state.known = processes.map(({ pid, parent, group, birth }) => ({
          pid,
          parent,
          group,
          birth,
        }))
        const root =
          state.record.pid === undefined
            ? undefined
            : processes.find(item => item.pid === state.record.pid)
        if (
          root !== undefined &&
          (state.root === undefined ||
            (!state.exited && state.root.birth === undefined) ||
            sameIdentity(state.root, root))
        )
          state.root = { ...root }
        return true
      })
    },
    waiting(eventToken: AttemptLifecycleToken): LifecycleTransition {
      if (!active(eventToken) || state.phase.status === 'waiting') return rejected()
      return changed(() => {
        state.phase = activeAttemptState('waiting')
        return true
      })
    },
    cancel(
      eventToken: AttemptLifecycleToken,
      requestedAt: number,
      reason: string
    ): LifecycleTransition {
      if (!commandable(eventToken) || state.record.cancelRequestedAt !== undefined)
        return rejected()
      return changed(() => {
        let didChange = put('cancelRequestedAt', requestedAt)
        didChange = put('cancelReason', reason) || didChange
        return didChange
      })
    },
    unknown(eventToken: AttemptLifecycleToken, message: string): LifecycleTransition {
      if (!active(eventToken)) return rejected()
      return changed(() => {
        state.phase = unknownAttemptState
        put('observationError', message)
        return true
      })
    },
    complete(
      eventToken: AttemptLifecycleToken,
      facts: AttemptCompletionFacts
    ): LifecycleTransition {
      if (!active(eventToken)) return rejected()
      const { exitCode } = state.record
      const cleanupBlocked =
        state.record.cleanupError !== undefined || facts.cleanupError !== undefined
      let terminalStatus: 'completed' | 'failed' | 'cancelled' = 'failed'
      if (
        exitCode === 0 &&
        state.record.error === undefined &&
        (state.record.kind === 'process' || state.resultReceived)
      )
        terminalStatus = 'completed'
      if (state.record.cancelRequestedAt !== undefined && state.record.protocolError === undefined)
        terminalStatus = 'cancelled'
      return changed(() => {
        let didChange = put('artifactAtCompletion', facts.artifactAtCompletion)
        didChange = put('changedDuringRun', facts.changedDuringRun) || didChange
        if (facts.cleanupError !== undefined)
          didChange = put('cleanupError', facts.cleanupError) || didChange
        if (
          state.record.kind === 'agent' &&
          !state.resultReceived &&
          state.record.cancelRequestedAt === undefined &&
          state.record.error === undefined
        )
          didChange = put('error', 'Child exited without a final result') || didChange
        state.phase = cleanupBlocked
          ? unknownAttemptState
          : terminalAttemptState(terminalStatus, facts.completedAt)
        return true
      })
    },
    persistenceError(eventToken: AttemptLifecycleToken, message: string): LifecycleTransition {
      if (!accepts(eventToken)) return rejected()
      return changed(() => put('persistenceError', message))
    },
    deliveryError(eventToken: AttemptLifecycleToken, message: string): LifecycleTransition {
      if (!accepts(eventToken)) return rejected()
      return changed(() => put('deliveryError', message))
    },
    cleanupError(eventToken: AttemptLifecycleToken, message: string): LifecycleTransition {
      if (!commandable(eventToken)) return rejected()
      return changed(() => put('cleanupError', message))
    },
  }

  return {
    token,
    snapshot: () => recordOf(state),
    state: () => phaseOf(state.phase),
    isActive: () => state.phase._tag === 'active',
    isUnknown: () => state.phase._tag === 'unknown',
    isTerminal: () => state.phase._tag === 'terminal',
    hasExited: () => state.exited,
    hasResult: () => state.resultReceived,
    pid: () => state.record.pid,
    knownProcesses: () =>
      state.known.map(({ pid, parent, group, birth }) => ({ pid, parent, group, birth })),
    rootProcess: () => (state.root === undefined ? undefined : { ...state.root }),
    transition,
  }
}

export const makeAttemptLifecycle = (record: AttemptRecord): AttemptLifecycle =>
  makeLifecycle(record)

export const ownedProcesses = (
  table: readonly ProcessObservation[],
  pid: number | undefined,
  known: readonly ProcessObservation[],
  rootIdentity?: ProcessObservation
): readonly ProcessObservation[] => {
  if (pid === undefined) return []
  const rememberedRoot = rootIdentity ?? known.find(item => item.pid === pid)
  const currentRoot = table.find(item => item.pid === pid)
  const selected = new Map<number, ProcessObservation>()
  const blocked = new Set<number>()
  for (const item of known) {
    const live = table.find(candidate => candidate.pid === item.pid)
    if (live === undefined) continue
    if (sameIdentity(live, item)) selected.set(item.pid, item)
    else blocked.add(item.pid)
  }
  const rootMatches =
    currentRoot !== undefined &&
    (rememberedRoot === undefined
      ? currentRoot.birth !== undefined
      : sameIdentity(rememberedRoot, currentRoot) ||
        (rememberedRoot.birth === undefined && currentRoot.birth !== undefined))
  if (rootMatches) {
    if (!blocked.has(currentRoot.pid)) selected.set(currentRoot.pid, currentRoot)
    for (const item of table) {
      if (item.group === currentRoot.group && !blocked.has(item.pid) && !selected.has(item.pid))
        selected.set(item.pid, item)
    }
  } else if (
    currentRoot === undefined &&
    rememberedRoot !== undefined &&
    rememberedRoot.birth !== undefined
  ) {
    // The exited root's group stays ours until it is observed empty: while any member
    // lives, no new process can take its ID, so a member reparented away is still found.
    for (const item of table) {
      if (item.group === rememberedRoot.group && !blocked.has(item.pid) && !selected.has(item.pid))
        selected.set(item.pid, item)
    }
  }
  let added = true
  while (added) {
    added = false
    for (const item of table) {
      if (!blocked.has(item.pid) && !selected.has(item.pid) && selected.has(item.parent)) {
        selected.set(item.pid, item)
        added = true
      }
    }
  }
  return table.filter(item => selected.get(item.pid)?.birth === item.birth)
}
