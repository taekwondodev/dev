import { Effect, ManagedRuntime, Schema } from 'effect'
import type * as Pi from '@earendil-works/pi-coding-agent'
import { WorkOwner, makeWorkOwnerLayer } from './work-controller.ts'
import {
  asAttemptId,
  asSessionId,
  AttemptId as AttemptIdSchema,
  WorkError,
  type AgentStartRequest,
  type AttemptId,
  type AttemptView,
  type ProcessStartRequest,
  type SessionId,
  type WorkFailure,
  type WorkOwnerService,
  type WorkSetupError,
} from './work-domain.ts'
import { quotaExhausted } from './work-dispatch.ts'

const WorkInputSchema = Schema.Struct({
  action: Schema.Literals(['process', 'delegate', 'dispatch', 'list', 'inspect', 'cancel']),
  taskId: Schema.optionalKey(Schema.String),
  command: Schema.optionalKey(Schema.String),
  prompt: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  id: Schema.optionalKey(Schema.String),
  access: Schema.optionalKey(Schema.Literals(['read-only', 'write'])),
  harness: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  effort: Schema.optionalKey(Schema.String),
  rule: Schema.optionalKey(Schema.String),
  skills: Schema.optionalKey(Schema.Array(Schema.String)),
  stream: Schema.optionalKey(Schema.Literals(['stdout', 'stderr', 'result'])),
  offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
})
type WorkInput = typeof WorkInputSchema.Type

const parameters = Schema.toJsonSchemaDocument(WorkInputSchema, {
  onExcessProperty: 'error',
}).schema

const decodeInput = (input: unknown): Effect.Effect<WorkInput, WorkError> =>
  Schema.decodeUnknownEffect(WorkInputSchema)(input, { onExcessProperty: 'error' }).pipe(
    Effect.mapError(cause => new WorkError({ message: cause.message, cause }))
  )

const decodeDeliveryDetails = Schema.decodeUnknownResult(
  Schema.Struct({ attempts: Schema.Array(AttemptIdSchema) })
)

type WorkSession = Pick<
  Pi.AgentSession,
  | 'sendCustomMessage'
  | 'settingsManager'
  | 'sessionManager'
  | 'subscribe'
  | 'isIdle'
  | 'isStreaming'
>

interface SessionOwner {
  readonly _tag: 'active'
  readonly sessionId: SessionId
  readonly runtime: ManagedRuntime.ManagedRuntime<WorkOwner, WorkSetupError>
}

type OwnerState = SessionOwner | { readonly _tag: 'closed'; readonly shutdown: Promise<void> }

interface PendingOutcome {
  attempt: AttemptView
  publication: {
    readonly state: 'ready' | 'submitted' | 'sending' | 'recording-failure' | 'failed'
  }
}

interface PublicationReservation {
  readonly item: PendingOutcome
  readonly publication: PendingOutcome['publication']
}

const reserve = (
  reservations: readonly PublicationReservation[],
  state: PendingOutcome['publication']['state']
): PublicationReservation[] =>
  reservations.map(({ item }) => {
    const publication = { state }
    item.publication = publication
    return { item, publication }
  })

interface DeliveryScope {
  readonly owner: SessionOwner
  readonly session: WorkSession
  readonly context: Pi.ExtensionContext
}

const withOwner = <A>(
  f: (owner: WorkOwnerService) => Effect.Effect<A, WorkFailure>
): Effect.Effect<A, WorkFailure, WorkOwner> => Effect.flatMap(WorkOwner, f)

const summary = (record: AttemptView) => ({
  id: record.id,
  taskId: record.owner.taskId,
  status: record.status,
  kind: record.kind,
  worktree: record.worktree,
  model: record.model ?? 'unavailable',
  context: record.context ?? 'unavailable',
  usage: record.usage ?? 'unavailable',
  error: record.error ?? record.observationError ?? record.persistenceError,
  deliveryError: record.deliveryError,
  cleanupError: record.cleanupError,
  processObservation: record.processObservation,
  recovery: record.recovery,
})

const outcomeMessage = (items: readonly AttemptView[]) => ({
  customType: 'dev/work-outcome',
  display: true,
  content: `Background work outcomes. These are producer observations, not verification; reconcile artifacts and honor dev-cycle checkpoints before proceeding. Report any recorded worktree and follow its cleanup guidance.\n${JSON.stringify(items)}`,
  details: { attempts: items.map(record => record.id) },
})

const outcomeAttempts = (
  entries: readonly (Pi.SessionEntry | Pi.SessionBoundaryDraft)[]
): Set<AttemptId> => {
  const ids = new Set<AttemptId>()
  for (const entry of entries) {
    if (entry.type !== 'custom_message' || entry.customType !== 'dev/work-outcome') continue
    const details = decodeDeliveryDetails(entry.details)
    if (details._tag === 'Success') for (const id of details.success.attempts) ids.add(id)
  }
  return ids
}

export interface WorkExtension {
  readonly factory: Pi.ExtensionFactory
  readonly bindSession: (session: WorkSession) => void
  readonly close: (reason?: string) => Promise<void>
}

export const createWorkExtension = ({
  dataHome,
  specialization,
}: {
  readonly dataHome: string
  readonly specialization: string
}): WorkExtension => {
  let sessionOwner: OwnerState | undefined
  let session: WorkSession | undefined
  let context: Pi.ExtensionContext | undefined
  let removeInputListener: (() => void) | undefined
  let removeSessionListener: (() => void) | undefined
  let idleDeliveryReady = false
  let reactivation: 'awaiting-success' | 'ready' | 'suspended' = 'awaiting-success'
  let deliveryScheduled = false
  const pending = new Map<AttemptId, PendingOutcome>()

  const ownerRuntime = (
    ctx: Pi.ExtensionContext
  ): Effect.Effect<ManagedRuntime.ManagedRuntime<WorkOwner, WorkSetupError>, WorkError> =>
    Effect.try({
      try: () => {
        if (sessionOwner?._tag === 'closed')
          throw new WorkError({ message: 'This work owner has shut down' })
        const sessionId = asSessionId(ctx.sessionManager.getSessionId())
        if (sessionOwner === undefined) {
          const runtime = ManagedRuntime.make(
            makeWorkOwnerLayer({
              dataHome,
              specialization,
              cwd: ctx.cwd,
              sessionId,
              onChange: () => scheduleStatus(),
              onOutcome: attempt => {
                if (
                  context?.sessionManager.getSessionId() !== sessionId ||
                  sessionOwner?._tag !== 'active' ||
                  sessionOwner.runtime !== runtime
                )
                  return
                pending.set(attempt.id, { attempt, publication: { state: 'ready' } })
                scheduleDelivery()
              },
            })
          )
          sessionOwner = { _tag: 'active', sessionId, runtime }
        }
        if (sessionOwner.sessionId !== sessionId)
          throw new WorkError({
            message: 'Background work owner does not match the active conversation',
          })
        context = ctx
        return sessionOwner.runtime
      },
      catch: cause =>
        cause instanceof WorkError
          ? cause
          : new WorkError({
              message: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
    })

  const run = <A>(
    ctx: Pi.ExtensionContext,
    effect: Effect.Effect<A, WorkFailure, WorkOwner>
  ): Promise<A> => Effect.runPromise(ownerRuntime(ctx)).then(runtime => runtime.runPromise(effect))

  const showStatus = async (ctx: Pi.ExtensionContext): Promise<void> => {
    if (!ctx.hasUI) return
    const snapshot = await run(
      ctx,
      withOwner(owner => owner.snapshot)
    )
    const counts = new Map<string, number>()
    for (const record of snapshot.records)
      counts.set(record.status, (counts.get(record.status) ?? 0) + 1)
    const states = [...counts].map(([status, count]) => `${count} ${status}`).join(' · ')
    const children = snapshot.records.filter(record => record.kind === 'agent')
    const metered = children.filter(record => typeof record.usage?.total === 'number')
    const tokens = metered.reduce((sum, record) => sum + (record.usage?.total ?? 0), 0)
    let usage = children.length ? 'child usage unavailable' : ''
    if (metered.length) {
      usage = `children: ${tokens} reported tokens`
      if (metered.length < children.length)
        usage += ` (${children.length - metered.length} unavailable)`
    }
    const agents = snapshot.records.filter(
      record =>
        record.kind === 'agent' && (record.status === 'running' || record.status === 'waiting')
    )
    const models = agents
      .map(record => {
        const percentage = record.context?.percent
        const pressure =
          typeof percentage === 'number' ? `${percentage.toFixed(1)}%` : 'unavailable'
        return `${record.owner.taskId}: ${record.model ?? 'model pending'} context ${pressure}`
      })
      .join(' · ')
    ctx.ui.setStatus(
      'dev/work',
      [
        states,
        models,
        usage,
        snapshot.agentsBlocked ? 'subscription exhausted; agents blocked' : '',
        reactivation === 'suspended' ? 'lead failed; automatic reactivation suspended' : '',
      ]
        .filter(Boolean)
        .join(' | ') || undefined
    )
  }

  const scheduleStatus = (): void => {
    const current = context
    const currentOwner = sessionOwner
    if (current !== undefined)
      setImmediate(() => {
        if (context === current && sessionOwner === currentOwner)
          void showStatus(current).catch(notifyError)
      })
  }

  const notifyError = (cause: unknown): void => {
    const message = cause instanceof Error ? cause.message : String(cause)
    if (context?.hasUI) context.ui.notify(`Background work: ${message}`, 'error')
  }

  const interrupt = async (ctx: Pi.ExtensionContext, reason: string): Promise<void> => {
    pending.clear()
    await run(
      ctx,
      withOwner(owner => owner.interrupt(reason))
    )
    await showStatus(ctx)
  }

  const deliveryScope = (): DeliveryScope | undefined =>
    sessionOwner?._tag === 'active' && session !== undefined && context !== undefined
      ? { owner: sessionOwner, session, context }
      : undefined

  const isCurrent = (scope: DeliveryScope): boolean =>
    sessionOwner === scope.owner &&
    session === scope.session &&
    scope.context.sessionManager.getSessionId() === scope.owner.sessionId &&
    scope.session.sessionManager.getSessionId() === scope.owner.sessionId

  const acknowledge = (scope: DeliveryScope): void => {
    if (!isCurrent(scope) || pending.size === 0) return
    const receipts = outcomeAttempts(scope.session.sessionManager.getBranch())
    for (const id of receipts) pending.delete(id)
  }

  const isReserved = (scope: DeliveryScope, reservation: PublicationReservation): boolean =>
    isCurrent(scope) &&
    pending.get(reservation.item.attempt.id) === reservation.item &&
    reservation.item.publication === reservation.publication

  const publications = (): PublicationReservation[] =>
    [...pending.values()].map(item => ({ item, publication: item.publication }))

  const deliveryFailure = async (
    scope: DeliveryScope,
    reservations: readonly PublicationReservation[],
    cause: unknown
  ): Promise<void> => {
    acknowledge(scope)
    const message = cause instanceof Error ? cause.message : String(cause)
    // Reserve the whole failure batch before suspending. A stale inspection or
    // acknowledgement must not overwrite a newer send's reservation.
    const failed = reserve(
      reservations.filter(item => isReserved(scope, item)),
      'recording-failure'
    )
    await Promise.all(
      failed.map(async reservation => {
        try {
          if (!isReserved(scope, reservation)) return
          await scope.owner.runtime.runPromise(
            withOwner(owner => owner.recordDeliveryFailure(reservation.item.attempt.id, message))
          )
        } finally {
          if (isReserved(scope, reservation)) reserve([reservation], 'failed')
        }
      })
    )
  }

  // A proposed draft is checked only after its dispatch had a chance to commit.
  const reconcileSubmitted = async (scope: DeliveryScope): Promise<void> => {
    acknowledge(scope)
    const submitted = publications().filter(item => item.publication.state === 'submitted')
    if (submitted.length > 0)
      await deliveryFailure(scope, submitted, 'Outcome not acknowledged by the owning conversation')
  }

  const inspectPending = async (scope: DeliveryScope): Promise<PublicationReservation[]> => {
    acknowledge(scope)
    const candidates = publications().filter(
      item => item.publication.state === 'ready' || item.publication.state === 'failed'
    )
    try {
      await Promise.all(
        candidates.map(async reservation => {
          const { item } = reservation
          const attempt = await scope.owner.runtime.runPromise(
            withOwner(owner => owner.inspect(item.attempt.id))
          )
          if (isReserved(scope, reservation)) item.attempt = attempt
        })
      )
      return candidates
    } catch (cause) {
      await deliveryFailure(scope, candidates, cause)
      throw cause
    }
  }

  // No asynchronous gap between this live owner check and reserving publication.
  const selectBatch = (
    scope: DeliveryScope,
    candidates: readonly PublicationReservation[],
    drafts: readonly Pi.SessionBoundaryDraft[] = []
  ) => {
    if (!isCurrent(scope)) return { items: [], canReactivate: false }
    acknowledge(scope)
    const status = scope.owner.runtime.runSync(
      withOwner(owner => owner.deliveryStatus(candidates.map(({ item }) => item.attempt)))
    )
    const eligible = new Set(status.eligible)
    const proposed = outcomeAttempts(drafts)
    const items: PublicationReservation[] = []
    for (const reservation of candidates) {
      const { item } = reservation
      const { id } = item.attempt
      if (!isReserved(scope, reservation)) continue
      if (!eligible.has(id)) pending.delete(id)
      else if (proposed.has(id)) reserve([reservation], 'submitted')
      else items.push(reservation)
    }
    return {
      items,
      canReactivate:
        reactivation === 'ready' &&
        !status.agentsBlocked &&
        items.every(
          ({ item, publication }) => publication.state === 'ready' && !item.attempt.deliveryError
        ),
    }
  }

  const confirmSend = async (
    scope: DeliveryScope,
    items: readonly PublicationReservation[],
    cause?: unknown
  ): Promise<void> => {
    await deliveryFailure(
      scope,
      items,
      cause ?? 'Outcome not acknowledged by the owning conversation'
    )
    if (cause !== undefined) notifyError(cause)
  }

  const flush = async (): Promise<void> => {
    const scope = deliveryScope()
    if (!idleDeliveryReady || scope === undefined || !scope.context.isIdle() || pending.size === 0)
      return
    const candidates = await inspectPending(scope)
    if (!idleDeliveryReady || !isCurrent(scope) || !scope.context.isIdle()) return
    const { items, canReactivate } = selectBatch(scope, candidates)
    if (items.length === 0) return
    const sending = reserve(items, 'sending')
    // A triggered send may await the entire next lead run. Its reservation must
    // not block that run's boundary from publishing other completed attempts.
    void scope.session
      .sendCustomMessage(outcomeMessage(items.map(({ item }) => item.attempt)), {
        triggerTurn: canReactivate,
        deliverAs: 'followUp',
      })
      .then(
        () => confirmSend(scope, sending),
        cause => confirmSend(scope, sending, cause)
      )
      .catch(notifyError)
  }

  const scheduleDelivery = (): void => {
    if (deliveryScheduled) return
    deliveryScheduled = true
    setImmediate(() => {
      deliveryScheduled = false
      void flush().catch(notifyError)
    })
  }

  const close = async (reason = 'session ended'): Promise<void> => {
    if (sessionOwner?._tag === 'closed') return sessionOwner.shutdown
    pending.clear()
    removeInputListener?.()
    removeInputListener = undefined
    removeSessionListener?.()
    removeSessionListener = undefined
    idleDeliveryReady = false
    const current = sessionOwner
    context = undefined
    const shutdown = (async () => {
      if (current !== undefined) {
        try {
          await current.runtime.runPromise(withOwner(work => work.close(reason)))
        } finally {
          await current.runtime.dispose()
        }
      }
    })()
    sessionOwner = { _tag: 'closed', shutdown }
    return shutdown
  }

  const execute = (input: WorkInput): Effect.Effect<unknown, WorkFailure, WorkOwner> =>
    withOwner(owner => {
      if (input.action === 'process') {
        const request: ProcessStartRequest = {
          taskId: input.taskId ?? '',
          command: input.command ?? '',
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        }
        return owner.startProcess(request)
      }
      if (input.action === 'delegate') {
        const request: AgentStartRequest = {
          taskId: input.taskId ?? '',
          prompt: input.prompt ?? '',
          access: input.access ?? 'read-only',
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          ...(input.skills === undefined ? {} : { skills: input.skills }),
          ...(input.rule === undefined ? {} : { rule: input.rule }),
          ...(input.harness === undefined ? {} : { harness: input.harness }),
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.effort === undefined ? {} : { effort: input.effort }),
        }
        return owner.startAgent(request)
      }
      if (input.action === 'dispatch') return owner.dispatch
      if (input.action === 'list') {
        return owner.snapshot.pipe(
          Effect.map(snapshot => {
            const offset = input.offset ?? 0
            return {
              ...snapshot,
              total: snapshot.records.length,
              records: snapshot.records.slice(offset, offset + 20).map(summary),
              nextOffset: offset + 20 < snapshot.records.length ? offset + 20 : null,
            }
          })
        )
      }
      if (input.action === 'cancel') {
        const { id } = input
        return id === undefined
          ? owner.interrupt('explicit stop').pipe(
              Effect.andThen(owner.snapshot),
              Effect.map(snapshot => ({
                cancellationRequested: true,
                ...snapshot,
                records: snapshot.records.map(summary),
              }))
            )
          : Effect.try({
              try: () => asAttemptId(id),
              catch: cause =>
                new WorkError({
                  message: cause instanceof Error ? cause.message : String(cause),
                  cause,
                }),
            }).pipe(Effect.flatMap(attemptId => owner.cancel(attemptId)))
      }
      if (input.action === 'inspect') {
        return owner.snapshot.pipe(
          Effect.flatMap(snapshot => {
            const record = snapshot.records.find(item => item.id === input.id)
            if (record === undefined)
              return Effect.fail(
                new WorkError({
                  message: 'Result is unavailable in this session (unknown or expired attempt)',
                })
              )
            return input.stream === undefined
              ? owner.inspect(record.id).pipe(Effect.map(value => value as unknown))
              : owner
                  .readLog({
                    id: record.id,
                    stream: input.stream,
                    ...(input.offset === undefined ? {} : { offset: input.offset }),
                  })
                  .pipe(Effect.map(value => value as unknown))
          })
        )
      }
      return Effect.fail(new WorkError({ message: 'Unsupported work operation' }))
    })

  const bindSession = (value: WorkSession): void => {
    removeSessionListener?.()
    session = value
    idleDeliveryReady = value.isIdle
    removeSessionListener = value.subscribe(event => {
      if (session !== value) return
      if (event.type === 'agent_start') idleDeliveryReady = false
      else if (event.type === 'agent_settled') {
        // Unlike the extension event, this fires after ALL settlement handlers.
        // The scheduled callback runs outside Pi's deferred-send window.
        idleDeliveryReady = true
        scheduleDelivery()
      }
    })
  }

  const factory: Pi.ExtensionFactory = pi => {
    pi.on('session_start', async (_event, ctx) => {
      const previous = sessionOwner
      if (previous?._tag === 'closed') {
        await previous.shutdown
        if (sessionOwner === previous) {
          sessionOwner = undefined
          reactivation = 'awaiting-success'
        }
      }
      const ownerSnapshot = await run(
        ctx,
        withOwner(owner => owner.snapshot)
      )
      if (session !== undefined && removeSessionListener === undefined) bindSession(session)
      removeInputListener?.()
      if (ctx.hasUI) {
        removeInputListener = ctx.ui.onTerminalInput(data => {
          if ((data === '\u001b' || data === '\u001b[27u') && session?.isStreaming)
            void interrupt(ctx, 'voluntary interruption').catch(notifyError)
        })
      }
      if (
        session !== undefined &&
        (ownerSnapshot.records.length > 0 || ownerSnapshot.unavailable.length > 0)
      ) {
        await session.sendCustomMessage(
          {
            customType: 'dev/work-recovery',
            display: true,
            content:
              'Retained background-work facts are available through work/list and work/inspect. They do not authorize restart or establish current artifact verification.',
            details: {
              attempts: ownerSnapshot.records.map(record => record.id),
              unavailable: ownerSnapshot.unavailable,
            },
          },
          { triggerTurn: false }
        )
      }
      await showStatus(ctx)
    })
    pi.on('agent_before_settle', async (event, ctx) => {
      idleDeliveryReady = false
      // Pi has already finished native retry/compaction recovery at this boundary.
      if (event.outcome === 'error') reactivation = 'suspended'
      else if (reactivation !== 'suspended')
        reactivation = event.outcome === 'completed' ? 'ready' : 'awaiting-success'
      scheduleStatus()
      if (sessionOwner?._tag !== 'active') return
      await Effect.runPromise(ownerRuntime(ctx))
      const scope = deliveryScope()
      if (scope === undefined) return
      await reconcileSubmitted(scope)
      const candidates = await inspectPending(scope)
      const { items, canReactivate } = selectBatch(scope, candidates, event.entries)
      if (items.length === 0) return
      reserve(items, 'submitted')
      return {
        entries: [
          ...event.entries,
          {
            type: 'custom_message' as const,
            ...outcomeMessage(items.map(({ item }) => item.attempt)),
          },
        ],
        continue: event.continue || (event.outcome === 'completed' && canReactivate),
      }
    })
    pi.on('agent_settled', async (_event, ctx) => {
      idleDeliveryReady = false
      if (sessionOwner?._tag !== 'active') return
      await Effect.runPromise(ownerRuntime(ctx))
      const scope = deliveryScope()
      if (scope !== undefined) await reconcileSubmitted(scope)
    })
    pi.on('input', event => {
      if (event.source !== 'extension') reactivation = 'awaiting-success'
      scheduleDelivery()
    })
    pi.on('agent_end', async event => {
      const last = event.messages.findLast(message => message.role === 'assistant')
      if (last?.stopReason === 'aborted' && context !== undefined) {
        if (reactivation !== 'suspended') reactivation = 'awaiting-success'
        await interrupt(context, 'lead agent interrupted')
      }
    })
    pi.on('message_end', async event => {
      if (
        event.message.role === 'assistant' &&
        'errorMessage' in event.message &&
        quotaExhausted(event.message.errorMessage)
      ) {
        session?.settingsManager.applyOverrides({ retry: { enabled: false } })
        if (context !== undefined)
          await run(
            context,
            withOwner(owner => owner.exhaust())
          )
        scheduleStatus()
        scheduleDelivery()
      }
    })
    pi.on('session_tree', (_event, ctx) => interrupt(ctx, 'session navigation'))
    pi.on('session_shutdown', event => close(event.reason))

    pi.registerTool({
      name: 'work',
      label: 'Background work',
      description:
        'Run local commands or separate Pi children without blocking the lead. Inspect dispatch before delegating: resolve natural-language rules yourself into a rule index (or default) and explicit harness/model/effort overrides. taskId identifies the workflow task; each launch creates a distinct attempt. Give children a focused self-contained prompt and pertinent skill names, never a full transcript by default. Reviews use read-only access; writers require a pre-created separate linked worktree. worktree.path records its verified root. Cleanup blocked means termination or reservation release is unconfirmed; review-required asks for evaluation, not deletion. Report retained worktrees in your handoff, verify current use and preserve or integrate changes before user-authorized removal; never force removal. Completion arrives automatically without polling or another user message. dev-cycle owns decisions, checkpoints and recovery; process outcomes are not verification. inspect pages retained logs by byte offset. cancel with no id interrupts all owned work. Quota exhaustion blocks agents, not existing local commands.',
      parameters,
      async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
        const result = await run(ctx, decodeInput(input).pipe(Effect.flatMap(execute)))
        return {
          content: [{ type: 'text', text: JSON.stringify(result ?? {}) }],
          details: result ?? {},
        }
      },
    })
    pi.registerCommand('work', {
      description:
        'Background work: list | dispatch | stop [attempt] | inspect <attempt> [stdout|stderr|result] [offset]',
      handler: async (args, ctx) => {
        const [action, id, stream, offset] = args.trim().split(/\s+/)
        const operation = action === 'stop' ? 'cancel' : action || 'list'
        try {
          const result = await run(
            ctx,
            decodeInput({
              action: operation,
              ...(id === undefined ? {} : { id }),
              ...(stream === undefined ? {} : { stream }),
              ...(offset === undefined ? {} : { offset: Number(offset) }),
            }).pipe(Effect.flatMap(execute))
          )
          pi.sendMessage(
            {
              customType: 'dev/work-inspection',
              content: JSON.stringify(result ?? {}, null, 2),
              display: true,
            },
            { triggerTurn: false }
          )
        } catch (cause) {
          notifyError(cause)
        }
      },
    })
  }

  return {
    factory,
    bindSession,
    close,
  }
}
