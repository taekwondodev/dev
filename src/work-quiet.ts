import * as Clock from 'effect/Clock'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import type { AttemptId } from './work-domain.ts'

export const QUIET_AFTER_MS = 2 * 60 * 1000
export const CACHE_WINDOW_MS = 5 * 60 * 1000

export type QuietChange =
  | {
      readonly kind: 'quiet'
      readonly id: AttemptId
      readonly taskId: string
      readonly since: number
    }
  | { readonly kind: 'resumed'; readonly id: AttemptId }

export type QuietRoute = 'boundary' | 'wake' | 'hold' | 'user'

interface BranchEntry {
  readonly type: string
  readonly timestamp: string
  readonly message?: { readonly role: string }
}

export const quietPollMs = (quietAfterMs: number): number =>
  Math.max(10, Math.floor(quietAfterMs / 24))

export const lastRequestAt = (branch: readonly BranchEntry[]): number | undefined => {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index]
    if (
      entry !== undefined &&
      (entry.type === 'usage' || (entry.type === 'message' && entry.message?.role === 'assistant'))
    ) {
      const at = Date.parse(entry.timestamp)
      if (!Number.isNaN(at)) return at
    }
  }
  return undefined
}

export const cacheWarm = (branch: readonly BranchEntry[], now: number): boolean => {
  const at = lastRequestAt(branch)
  return at !== undefined && now - at < CACHE_WINDOW_MS
}

export const quietRoute = (facts: {
  readonly consumed: boolean
  readonly streaming: boolean
  readonly idle: boolean
  readonly warm: boolean
  readonly canReactivate: boolean
}): QuietRoute => {
  if (facts.consumed) return 'user'
  if (facts.streaming) return 'boundary'
  return facts.idle && facts.warm && facts.canReactivate ? 'wake' : 'hold'
}

export const watchQuiet = Effect.fnUntraced(function* (options: {
  readonly size: Effect.Effect<number>
  readonly active: () => boolean
  readonly quietAfterMs: number
  readonly onQuiet: (since: number) => void
  readonly onResumed: () => void
}) {
  const poll = Duration.millis(quietPollMs(options.quietAfterMs))
  let size = yield* options.size
  let since = yield* Clock.currentTimeMillis
  let reported = false
  while (options.active()) {
    yield* Effect.sleep(poll)
    if (!options.active()) return
    const current = yield* options.size
    const now = yield* Clock.currentTimeMillis
    if (current !== size) {
      size = current
      since = now
      if (!reported) continue
      reported = false
      options.onResumed()
    } else if (!reported && now - since >= options.quietAfterMs) {
      reported = true
      options.onQuiet(since)
    }
  }
})

export interface QuietNotice {
  readonly taskId: string
  readonly since: number
  readonly reach: 'model' | 'user'
}

export type QuietEntry = readonly [AttemptId, QuietNotice]

export const makeQuietLedger = () => {
  const held = new Map<AttemptId, QuietNotice>()
  const reserved = new Map<AttemptId, QuietNotice>()
  const consumed = new Set<AttemptId>()
  const sending = new Set<AttemptId>()
  const isReserved = (id: AttemptId, notice: QuietNotice): boolean => reserved.get(id) === notice
  const restore = (id: AttemptId, notice: QuietNotice): void => {
    if (!isReserved(id, notice)) return
    reserved.delete(id)
    held.set(id, notice)
  }
  const acknowledge = (id: AttemptId, notice: QuietNotice, reached: boolean): void => {
    sending.delete(id)
    if (!reached) {
      restore(id, notice)
      return
    }
    if (isReserved(id, notice)) reserved.delete(id)
    consumed.add(id)
    const later = held.get(id)
    if (later?.reach === 'model') held.set(id, { ...later, reach: 'user' })
  }
  const reserve = (id: AttemptId, notice: QuietNotice): void => {
    if (held.get(id) === notice) held.delete(id)
    reserved.set(id, notice)
  }
  return {
    quiet: (id: AttemptId, taskId: string, since: number): QuietNotice => {
      const notice: QuietNotice = { taskId, since, reach: consumed.has(id) ? 'user' : 'model' }
      reserved.delete(id)
      held.set(id, notice)
      return notice
    },
    invalidate: (id: AttemptId): void => {
      held.delete(id)
      reserved.delete(id)
    },
    clear: (): void => {
      held.clear()
      reserved.clear()
      sending.clear()
    },
    reset: (): void => {
      held.clear()
      reserved.clear()
      consumed.clear()
      sending.clear()
    },
    held: (): readonly QuietEntry[] => [...held],
    forModel: (id: AttemptId): QuietNotice | undefined => {
      const notice = held.get(id)
      return notice?.reach === 'model' && !consumed.has(id) && !sending.has(id) ? notice : undefined
    },
    reserve,
    takeForRun: (): readonly QuietEntry[] => {
      const taken: QuietEntry[] = []
      for (const [id, notice] of held) {
        if (notice.reach === 'model' && sending.has(id)) continue
        held.delete(id)
        if (notice.reach === 'model' && !consumed.has(id)) taken.push([id, notice])
      }
      for (const [id, notice] of taken) reserve(id, notice)
      return taken
    },
    takeForBoundary: (): readonly QuietEntry[] => {
      const taken: QuietEntry[] = []
      for (const [id, notice] of held)
        if (notice.reach === 'model' && !consumed.has(id) && !sending.has(id))
          taken.push([id, notice])
      for (const [id, notice] of taken) reserve(id, notice)
      return taken
    },
    isReserved,
    include: (id: AttemptId, notice: QuietNotice): boolean => {
      if (!isReserved(id, notice)) return false
      reserved.delete(id)
      consumed.add(id)
      return true
    },
    begin: (id: AttemptId): void => {
      sending.add(id)
    },
    acknowledge,
    release: (id: AttemptId, notice: QuietNotice): void => {
      if (isReserved(id, notice)) reserved.delete(id)
    },
    restore,
  }
}

export type QuietLedger = ReturnType<typeof makeQuietLedger>
