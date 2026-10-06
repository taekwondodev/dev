import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Effect, Fiber, Option, Schema } from 'effect'
import type {
  AgentSession,
  BoundaryState,
  BoundaryResult,
  CompactionEntry,
  CompactionEntryDraft,
  ExtensionFactory,
  ProjectedSessionEntry,
  SessionEntry,
} from '@earendil-works/pi-coding-agent'
import type * as Native from '../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js'
import type * as VirtualModels from '../node_modules/@earendil-works/pi-coding-agent/dist/core/virtual-models.js'
import type * as Keys from '../node_modules/@earendil-works/pi-tui/dist/keys.js'
import { PiError, type PiApi } from './pi-runtime.ts'
import {
  BACKGROUND_COMPACTION_USAGE,
  COMPACTION_OBSERVATION,
  CompactionRunId,
  decodeCompactionObservation,
  NativeSpanId,
  PreparationId,
  type CompactionObservation,
  type DiscardReason,
} from './compaction-observation.ts'

const ADVANCE_TOKENS = 32768
const inferenceFailure = (cause: unknown) =>
  new PiError({ message: 'Background compaction inference failed', cause })
const FileLists = Schema.Struct({
  readFiles: Schema.Array(Schema.String),
  modifiedFiles: Schema.Array(Schema.String),
})
const decodeFileLists = Schema.decodeUnknownOption(FileLists)
type Stream = AgentSession['agent']['streamFunction']
type Model = NonNullable<AgentSession['model']>
type RequestUpdate = Exclude<
  Awaited<ReturnType<NonNullable<AgentSession['agent']['prepareRequest']>>>,
  void
>

interface Preparation {
  readonly id: typeof PreparationId.Type
  readonly startedAt: number
  observation:
    | { readonly phase: 'preparing'; overlapMs: number; activeSince: number | undefined }
    | { readonly phase: 'ready'; readonly overlapMs: number }
    | { readonly phase: 'ended' }
  readonly session: AgentSession
  readonly generation: number
  readonly branchIds: readonly string[]
  readonly projection: readonly string[]
  readonly controller: AbortController
  readonly preparation: Native.CompactionPreparation
  readonly model: Model
  readonly thinkingLevel: AgentSession['thinkingLevel']
  readonly messages: AgentSession['messages']
  readonly retry: ReturnType<AgentSession['settingsManager']['getRetrySettings']>
  readonly providerOptions: NonNullable<Parameters<Stream>[2]>
  readonly stream: Stream
}

type State =
  | { readonly phase: 'dormant' | 'suspended' | 'closed' }
  | { readonly phase: 'preparing'; readonly job: Preparation }
  | { readonly phase: 'ready'; readonly job: Preparation; readonly result: Native.CompactionResult }

const fingerprint = (
  entries: readonly ProjectedSessionEntry[],
  limit = Number.POSITIVE_INFINITY
): string[] => {
  const digests: string[] = []
  for (const entry of entries) {
    if (digests.length >= limit) break
    if (entry.messages.length > 0)
      digests.push(
        createHash('sha256')
          .update(JSON.stringify([entry.sourceEntry.id, entry.messages]))
          .digest('hex')
      )
  }
  return digests
}

const inheritFiles = (
  preparation: Native.CompactionPreparation,
  branch: readonly SessionEntry[]
): void => {
  const previous = branch.findLast(entry => entry.type === 'compaction')
  if (!previous?.fromHook) return
  const files = decodeFileLists(previous.details)
  if (Option.isNone(files)) return
  for (const file of files.value.readFiles) preparation.fileOps.read.add(file)
  for (const file of files.value.modifiedFiles) preparation.fileOps.edited.add(file)
}

const updateActivity = (job: Preparation, active: boolean, now: number) => {
  const timing = job.observation
  if (timing.phase !== 'preparing') return
  if (timing.activeSince !== undefined) timing.overlapMs += now - timing.activeSince
  timing.activeSince = active ? now : undefined
}

const matchesCommit = (
  entry: SessionEntry,
  proposed: CompactionEntryDraft
): entry is CompactionEntry =>
  entry.type === 'compaction' &&
  entry.fromHook === true &&
  entry.summary === proposed.summary &&
  entry.firstKeptEntryId === proposed.firstKeptEntryId &&
  entry.details === proposed.details

export const createBackgroundCompaction = Effect.fnUntraced(function* (
  api: PiApi,
  packageRoot: string
) {
  const native: typeof Native = yield* Effect.tryPromise({
    try: () => import(pathToFileURL(join(packageRoot, 'dist/core/compaction/compaction.js')).href),
    catch: cause => new PiError({ message: 'Cannot load native Pi compaction', cause }),
  })
  const virtual: typeof VirtualModels = yield* Effect.tryPromise({
    try: () => import(pathToFileURL(join(packageRoot, 'dist/core/virtual-models.js')).href),
    catch: cause => new PiError({ message: 'Cannot load native Pi model routing', cause }),
  })
  const keys: typeof Keys = yield* Effect.tryPromise({
    try: () => import(pathToFileURL(join(packageRoot, '../pi-tui/dist/keys.js')).href),
    catch: cause => new PiError({ message: 'Cannot load Pi terminal key parsing', cause }),
  })
  const services = yield* Effect.context<never>()
  const runFork = Effect.runForkWith(services)
  const runSync = Effect.runSyncWith(services)
  const runId = yield* Schema.decodeEffect(CompactionRunId)(randomUUID()).pipe(Effect.orDie)
  const observe = (run: () => void) => runSync(Effect.sync(run).pipe(Effect.ignoreCause))
  const record = (active: AgentSession, event: CompactionObservation) =>
    observe(() => {
      const valid = decodeCompactionObservation(event)
      if (Option.isSome(valid))
        active.sessionManager.appendCustomEntry(COMPACTION_OBSERVATION, valid.value)
    })
  let nativeSpan:
    | {
        readonly id: typeof NativeSpanId.Type
        readonly startedAt: number
        readonly reason: Extract<CompactionObservation, { kind: 'native-started' }>['reason']
      }
    | undefined
  let pendingCommit:
    | { readonly entry: CompactionEntryDraft; readonly job: Preparation; remaining: number }
    | undefined
  let session: AgentSession | undefined
  let generation = 0
  let state: State = { phase: 'dormant' }
  let lastAttempt = ''
  let removeInput: (() => void) | undefined
  let unsubscribe: (() => void) | undefined
  let publication: { readonly entry: CompactionEntryDraft; readonly job: Preparation } | undefined
  let announcement: Fiber.Fiber<void> | undefined
  const fencedRunners = new WeakSet<AgentSession['extensionRunner']>()
  const takePublication = () => {
    const proposed = publication
    publication = undefined
    return proposed
  }

  const announce = (active: AgentSession, compactionEntry: CompactionEntry) => {
    announcement = runFork(
      Effect.promise(() =>
        active.extensionRunner.emit({
          type: 'session_compact',
          compactionEntry,
          fromExtension: true,
          reason: 'threshold',
          willRetry: false,
        })
      ).pipe(Effect.ignoreCause)
    )
  }

  const endPreparation = (
    job: Preparation,
    outcome: Extract<CompactionObservation, { kind: 'background-ended' }>['outcome']
  ) => {
    if (job.observation.phase === 'ended') return
    const now = performance.now()
    updateActivity(job, false, now)
    const activeRunOverlapMs = job.observation.overlapMs
    job.observation = { phase: 'ended' }
    record(job.session, {
      runId,
      kind: 'background-ended',
      id: job.id,
      outcome,
      elapsedMs: now - job.startedAt,
      activeRunOverlapMs,
    })
  }

  const invalidate = (phase: 'dormant' | 'suspended' | 'closed', reason: DiscardReason) => {
    if (state.phase === 'closed') return
    generation += 1
    const job =
      state.phase === 'preparing' || state.phase === 'ready'
        ? state.job
        : (publication?.job ?? pendingCommit?.job)
    if (state.phase === 'preparing' || state.phase === 'ready') state.job.controller.abort()
    state = { phase }
    const committed = pendingCommit
    if (
      job &&
      !(
        committed?.job === job &&
        job.session.sessionManager.getBranch().some(entry => matchesCommit(entry, committed.entry))
      )
    )
      endPreparation(job, { kind: 'discarded', reason })
    if (phase === 'closed' && session) record(session, { runId, kind: 'detached' })
  }

  const valid = (
    job: Preparation,
    entries = job.session.sessionManager.buildSessionProjection().entries
  ): boolean => {
    if (session !== job.session || generation !== job.generation || job.controller.signal.aborted)
      return false
    if (!job.session.autoCompactionEnabled || job.session.isCompacting) return false
    const branch = job.session.sessionManager.getBranch()
    if (!job.branchIds.every((id, index) => branch[index]?.id === id)) return false
    if (branch.slice(job.branchIds.length).some(entry => entry.type === 'compaction')) return false
    const current = fingerprint(entries, job.projection.length)
    return job.projection.every((value, index) => current[index] === value)
  }

  const belowNativeThreshold = (active: AgentSession, boundary?: BoundaryState): boolean => {
    const { model } = active
    if (!model) return false
    const settings = active.settingsManager.getCompactionSettings(model)
    const branch = active.sessionManager.getBranch()
    const projection = active.sessionManager.buildSessionProjection()
    if (boundary) {
      projection.entries = boundary.context.contextEntries
      projection.messages = boundary.context.contextMessages
      const ids = new Set(branch.map(entry => entry.id))
      branch.push(
        ...projection.entries
          .filter(entry => !ids.has(entry.sourceEntry.id))
          .map(entry => entry.sourceEntry)
      )
    }
    const window = virtual.isVirtualModel(model)
      ? (active.getContextUsage()?.contextWindow ?? model.contextWindow)
      : model.contextWindow
    return (
      settings.enabled &&
      native.estimateProjectedContextTokens(projection, branch).tokens <=
        window - settings.reserveTokens
    )
  }

  const applyIdle = () => {
    const ready = state
    if (ready.phase !== 'ready' || !ready.job.session.isIdle) return
    const active = ready.job.session
    if (!valid(ready.job) || !belowNativeThreshold(active)) {
      invalidate('dormant', 'stale-context')
      return
    }
    const tokensBefore = native.estimateProjectedContextTokens(
      active.sessionManager.buildSessionProjection(),
      active.sessionManager.getBranch()
    ).tokens
    state = { phase: 'dormant' }
    const entryId = active.sessionManager.appendCompaction(
      ready.result.summary,
      ready.result.firstKeptEntryId,
      tokensBefore,
      ready.result.details,
      true
    )
    endPreparation(ready.job, { kind: 'applied', placement: 'idle', entryId })
    active.refreshContext()
    const entry = active.sessionManager.getEntry(entryId)
    if (entry?.type === 'compaction') announce(active, entry)
  }

  const generate = Effect.fnUntraced(function* (job: Preparation) {
    const active = job.session
    const { signal } = job.controller
    const route = virtual.isVirtualModel(job.model)
      ? yield* Effect.tryPromise({
          try: () =>
            active.modelRuntime.resolveModel(job.model, api.convertToLlm(job.messages), {
              reason: 'direct',
              thinkingLevel: job.thinkingLevel,
              signal,
            }),
          catch: inferenceFailure,
        })
      : { model: job.model, thinkingLevel: job.thinkingLevel }
    const auth = yield* Effect.tryPromise({
      try: () => active.modelRuntime.getAuth(route.model, { signal }),
      catch: inferenceFailure,
    }).pipe(Effect.orElseSucceed(() => undefined))
    if (signal.aborted) return
    const model = auth?.auth.baseUrl ? { ...route.model, baseUrl: auth.auth.baseUrl } : route.model
    const headers =
      auth?.auth.headers === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(auth.auth.headers).filter(
              (entry): entry is [string, string] => entry[1] !== null
            )
          )
    const stream: Stream = async (requestModel, context, options) => {
      if (signal.aborted || generation !== job.generation)
        throw new Error('Background compaction cancelled')
      const response = await job.stream(requestModel, context, {
        ...options,
        ...job.providerOptions,
      })
      runFork(
        Effect.tryPromise({ try: () => response.result(), catch: inferenceFailure }).pipe(
          Effect.flatMap(message =>
            Effect.sync(() => {
              const { usage } = message
              if (
                usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0 ||
                usage.cost.total > 0
              )
                active.sessionManager.appendUsage(
                  BACKGROUND_COMPACTION_USAGE,
                  requestModel.provider,
                  requestModel.id,
                  usage,
                  job.id
                )
            })
          ),
          Effect.ignoreCause
        )
      )
      return response
    }
    const result = yield* Effect.tryPromise({
      try: () =>
        native.compact(
          job.preparation,
          model,
          auth?.auth.apiKey,
          headers,
          undefined,
          signal,
          route.thinkingLevel,
          stream,
          auth?.env,
          job.retry
        ),
      catch: inferenceFailure,
    })
    if (state.phase !== 'preparing' || state.job !== job) return
    if (!valid(job)) {
      invalidate('dormant', 'stale-context')
      return
    }
    const now = performance.now()
    updateActivity(job, false, now)
    if (job.observation.phase === 'preparing') {
      const activeRunOverlapMs = job.observation.overlapMs
      job.observation = { phase: 'ready', overlapMs: activeRunOverlapMs }
      record(active, {
        runId,
        kind: 'background-ready',
        id: job.id,
        preparationMs: now - job.startedAt,
        activeRunOverlapMs,
      })
    }
    state = { phase: 'ready', job, result }
    applyIdle()
  })

  const schedule = () => {
    const active = session
    if (!active || state.phase !== 'dormant' || active.isCompacting) return
    const { model } = active
    if (!model) return
    const settings = active.settingsManager.getCompactionSettings(model)
    if (!settings.enabled) return
    const branch = active.sessionManager.getBranch()
    const projection = active.sessionManager.buildSessionProjection()
    const { tokens } = native.estimateProjectedContextTokens(projection, branch)
    const window = virtual.isVirtualModel(model)
      ? (active.getContextUsage()?.contextWindow ?? model.contextWindow)
      : model.contextWindow
    const threshold = window - settings.reserveTokens
    if (tokens <= threshold - ADVANCE_TOKENS || tokens > threshold) return
    const projected = fingerprint(projection.entries)
    const key = JSON.stringify([model.provider, model.id, settings, projected])
    if (key === lastAttempt) return
    const preparation = native.prepareCompaction(branch, settings)
    if (!preparation) return
    inheritFiles(preparation, branch)
    lastAttempt = key
    const provider = active.settingsManager.getProviderRetrySettings()
    const timeout = active.settingsManager.getHttpIdleTimeoutMs()
    const startedAt = performance.now()
    const job: Preparation = {
      id: Schema.decodeSync(PreparationId)(randomUUID()),
      startedAt,
      observation: {
        phase: 'preparing',
        overlapMs: 0,
        activeSince: active.isStreaming ? startedAt : undefined,
      },
      session: active,
      generation,
      branchIds: branch.map(entry => entry.id),
      projection: projected,
      controller: new AbortController(),
      preparation: structuredClone(preparation),
      model: structuredClone(model),
      thinkingLevel: active.thinkingLevel,
      messages: structuredClone(projection.messages),
      retry: active.settingsManager.getRetrySettings(),
      stream: active.agent.streamFunction,
      providerOptions: {
        timeoutMs: provider.timeoutMs ?? (timeout === 0 ? 2147483647 : timeout),
        maxRetries: provider.maxRetries,
        maxRetryDelayMs: provider.maxRetryDelayMs,
        websocketConnectTimeoutMs: active.settingsManager.getWebSocketConnectTimeoutMs(),
      },
    }
    state = { phase: 'preparing', job }
    record(active, { runId, kind: 'background-started', id: job.id })
    runFork(
      generate(job).pipe(
        Effect.catchCause(() =>
          Effect.sync(() => {
            if (state.phase === 'preparing' && state.job === job) {
              state = { phase: 'dormant' }
              endPreparation(job, { kind: 'discarded', reason: 'failure' })
            }
          })
        )
      )
    )
  }

  const boundary = (event: BoundaryState): BoundaryResult | undefined => {
    if (event.outcome !== 'completed') {
      invalidate('suspended', event.outcome === 'aborted' ? 'abort' : 'failure')
      return
    }
    const ready = state
    if (ready.phase !== 'ready') return
    if (
      !valid(ready.job, event.context.contextEntries) ||
      !belowNativeThreshold(ready.job.session, event)
    ) {
      invalidate('dormant', 'stale-context')
      return
    }
    state = { phase: 'dormant' }
    const entry: CompactionEntryDraft = {
      type: 'compaction',
      summary: ready.result.summary,
      firstKeptEntryId: ready.result.firstKeptEntryId,
      details: ready.result.details,
    }
    publication = { entry, job: ready.job }
    return { entries: [...event.entries, entry] }
  }

  const fenceBoundary = (active: AgentSession) => {
    const runner = active.extensionRunner
    if (fencedRunners.has(runner)) return
    fencedRunners.add(runner)
    const emitEvent = runner.emit.bind(runner)
    runner.emit = event => {
      if (event.type === 'session_shutdown')
        invalidate(
          event.reason === 'reload' ? 'suspended' : 'closed',
          event.reason === 'reload' ? 'reload' : 'shutdown'
        )
      return emitEvent(event)
    }
    const emit = runner.emitBoundary.bind(runner)
    runner.emitBoundary = (event, buildContext) =>
      Effect.runPromiseWith(services)(
        Effect.gen(function* () {
          takePublication()
          const result = yield* Effect.promise(() => emit(event, buildContext))
          const proposed = takePublication()
          if (!proposed) return result
          const entries = result.entries.filter(
            entry =>
              entry.type !== 'compaction' ||
              entry.summary !== proposed.entry.summary ||
              entry.firstKeptEntryId !== proposed.entry.firstKeptEntryId
          )
          if (entries.length === result.entries.length) {
            endPreparation(proposed.job, { kind: 'discarded', reason: 'boundary-rejected' })
            return result
          }
          const remaining = result.entries.indexOf(proposed.entry)
          pendingCommit = remaining === -1 ? undefined : { ...proposed, remaining }
          const context = yield* Effect.promise(() => Promise.resolve(buildContext(entries)))
          if (
            valid(proposed.job, context.contextEntries) &&
            belowNativeThreshold(active, { ...event, entries, context, continue: result.continue })
          )
            return result
          endPreparation(proposed.job, { kind: 'discarded', reason: 'stale-context' })
          pendingCommit = undefined
          return { ...result, entries, context }
        })
      )
  }

  const factory: ExtensionFactory = pi => {
    pi.on('input', () => {
      if (state.phase === 'suspended') state = { phase: 'dormant' }
    })
    pi.on('session_start', (_event, context) => {
      if (session) fenceBoundary(session)
      removeInput?.()
      removeInput = context.ui.onTerminalInput(data => {
        if (keys.matchesKey(data, keys.Key.escape)) invalidate('suspended', 'escape')
      })
    })
    pi.on('session_shutdown', event => {
      invalidate(
        event.reason === 'reload' ? 'suspended' : 'closed',
        event.reason === 'reload' ? 'reload' : 'shutdown'
      )
      removeInput?.()
      removeInput = undefined
    })
    pi.on('session_before_compact', event => {
      invalidate(event.reason === 'manual' ? 'suspended' : 'dormant', 'superseded')
      inheritFiles(event.preparation, event.branchEntries)
    })
    pi.on('turn_end', boundary)
    pi.on('agent_before_settle', boundary)
  }

  const bindSession = (active: AgentSession) => {
    if (session) throw new Error('Background compaction is bound to one AgentSession')
    session = active
    record(active, { runId, kind: 'attached' })
    fenceBoundary(active)
    const abort = active.abort.bind(active)
    active.abort = () => {
      invalidate('suspended', 'abort')
      return abort()
    }
    const dispose = active.dispose.bind(active)
    active.dispose = () => {
      invalidate('closed', 'shutdown')
      removeInput?.()
      unsubscribe?.()
      dispose()
    }
    const reload = active.reload.bind(active)
    active.reload = options => {
      invalidate('suspended', 'reload')
      return reload(options)
    }
    const { prepareRequest } = active.agent
    active.agent.prepareRequest = async (request, signal): Promise<RequestUpdate | undefined> => {
      const pending = announcement
      if (pending) await Effect.runPromiseWith(services)(Fiber.await(pending))
      return (await prepareRequest?.(request, signal)) || undefined
    }
    const navigate = active.navigateTree.bind(active)
    active.navigateTree = (target, options) => {
      invalidate('suspended', 'navigation')
      return navigate(target, options)
    }
    unsubscribe = active.subscribe(event => {
      if (event.type === 'compaction_start') {
        invalidate(event.reason === 'manual' ? 'suspended' : 'dormant', 'superseded')
        nativeSpan = {
          id: Schema.decodeSync(NativeSpanId)(randomUUID()),
          startedAt: performance.now(),
          reason: event.reason,
        }
        record(active, { runId, kind: 'native-started', id: nativeSpan.id, reason: event.reason })
      } else if (event.type === 'compaction_end') {
        const span = nativeSpan
        nativeSpan = undefined
        const unsuccessful = event.aborted ? 'aborted' : 'failed'
        if (span && span.reason === event.reason)
          record(active, {
            runId,
            kind: 'native-ended',
            id: span.id,
            outcome: event.result ? 'completed' : unsuccessful,
            elapsedMs: performance.now() - span.startedAt,
          })
      } else if (event.type === 'entry_appended' && pendingCommit) {
        const proposed = pendingCommit
        if (proposed.remaining-- === 0) {
          pendingCommit = undefined
          if (matchesCommit(event.entry, proposed.entry)) {
            endPreparation(proposed.job, {
              kind: 'applied',
              placement: 'boundary',
              entryId: event.entry.id,
            })
            announce(active, event.entry)
          }
        }
      } else if (event.type === 'agent_start' || event.type === 'agent_end') {
        if (state.phase === 'preparing')
          updateActivity(state.job, event.type === 'agent_start', performance.now())
      } else if (event.type === 'turn_end') {
        if (
          event.message.role === 'assistant' &&
          (event.message.stopReason === 'aborted' || event.message.stopReason === 'error')
        )
          invalidate('suspended', event.message.stopReason === 'aborted' ? 'abort' : 'failure')
        else observe(schedule)
      } else if (event.type === 'agent_settled') observe(applyIdle)
    })
  }
  return { factory, bindSession }
})
