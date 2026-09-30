import { Cause, Effect, ManagedRuntime, Schema } from 'effect'
import type * as Pi from '@earendil-works/pi-coding-agent'
import { executeWork } from './work-actions.ts'
import { WorkOwner, makeWorkOwnerLayer } from './work-controller.ts'
import {
  asSessionId,
  WorkError,
  type AttemptId,
  type AttemptView,
  type SessionId,
  type WorkFailure,
  type WorkOwnerService,
  type WorkSetupError,
  type WorkSnapshot,
} from './work-domain.ts'
import { quotaExhausted } from './work-dispatch.ts'
import {
  decodeWorkInput,
  LeadWorkInputSchema,
  outcomeAttempts,
  outcomeMessage,
  type WorkInput,
} from './work-protocol.ts'
import type {
  WorkspaceAttachment,
  WorkspaceHandoff,
  WorkspaceLifecycle,
} from './workspace-domain.ts'
import { errorText } from './error-text.ts'

const parameters = Schema.toJsonSchemaDocument(LeadWorkInputSchema, {
  onExcessProperty: 'error',
}).schema

const decodeInput = decodeWorkInput(LeadWorkInputSchema)

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

const LEAD_OUTCOME_GUIDANCE =
  'Background work outcomes. These are producer observations, not verification; reconcile artifacts and honor dev-cycle checkpoints before proceeding. Report any recorded worktree and follow its cleanup guidance.'

const leadOutcomeMessage = (items: readonly AttemptView[]) =>
  outcomeMessage(items, LEAD_OUTCOME_GUIDANCE)

export interface WorkExtension {
  readonly factory: Pi.ExtensionFactory
  readonly bindSession: (session: WorkSession) => void
  readonly close: (reason?: string) => Promise<void>
}

export const createWorkExtension = ({
  dataHome,
  profile,
  workspace,
  isWorkspaceParked,
}: {
  readonly dataHome: string
  readonly profile: string
  readonly workspace: {
    readonly lifecycle: WorkspaceLifecycle
    readonly attachment: WorkspaceAttachment
    readonly requestRebind: (
      handoff: WorkspaceHandoff,
      source: WorkspaceAttachment,
      context: Pi.ExtensionContext
    ) => void
  }
  readonly isWorkspaceParked: () => boolean
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
  const rebindRefusals = new Set<string>()

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
              profile,
              cwd: ctx.cwd,
              sessionId,
              workspace: {
                lifecycle: workspace.lifecycle,
                attachment: workspace.attachment,
                requestRebind: handoff =>
                  workspace.requestRebind(handoff, workspace.attachment, context ?? ctx),
              },
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
        cause instanceof WorkError ? cause : new WorkError({ message: errorText(cause), cause }),
    })

  const runOwned = <A>(
    ctx: Pi.ExtensionContext,
    effect: Effect.Effect<A, WorkFailure, WorkOwner>
  ): Effect.Effect<A, WorkFailure> =>
    ownerRuntime(ctx).pipe(
      Effect.flatMap(runtime => runtime.contextEffect),
      Effect.flatMap(services => Effect.provideContext(effect, services))
    )
  const run = <A>(
    ctx: Pi.ExtensionContext,
    effect: Effect.Effect<A, WorkFailure, WorkOwner>
  ): Promise<A> => Effect.runPromise(runOwned(ctx, effect))

  const statusText = (snapshot: WorkSnapshot): string | undefined => {
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
    const taskOf = new Map(snapshot.records.map(record => [record.id, record.owner.taskId]))
    const models = agents
      .map(record => {
        const percentage = record.context?.percent
        const pressure =
          typeof percentage === 'number' ? `${percentage.toFixed(1)}%` : 'unavailable'
        const { parent } = record.owner
        const label =
          parent === undefined
            ? record.owner.taskId
            : `${taskOf.get(parent) ?? parent}>${record.owner.taskId}`
        return `${label}: ${record.model ?? 'model pending'} context ${pressure}`
      })
      .join(' · ')
    return (
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
  const updateStatus = (ctx: Pi.ExtensionContext): Effect.Effect<void, WorkFailure> =>
    ctx.hasUI
      ? runOwned(
          ctx,
          withOwner(owner => owner.snapshot)
        ).pipe(
          Effect.flatMap(snapshot =>
            Effect.sync(() => ctx.ui.setStatus('dev/work', statusText(snapshot)))
          )
        )
      : Effect.void

  const scheduleStatus = (): void => {
    const current = context
    const currentOwner = sessionOwner
    if (current !== undefined)
      setImmediate(() => {
        if (context === current && sessionOwner === currentOwner)
          Effect.runFork(
            updateStatus(current).pipe(
              Effect.catchCause(cause => Effect.sync(() => notifyError(Cause.squash(cause))))
            )
          )
      })
  }

  const notifyError = (cause: unknown): void => {
    const message = cause instanceof Error ? cause.message : String(cause)
    if (context?.hasUI) context.ui.notify(`Background work: ${message}`, 'error')
  }

  const interruptOwned = (ctx: Pi.ExtensionContext, reason: string) =>
    Effect.sync(() => pending.clear()).pipe(
      Effect.andThen(
        runOwned(
          ctx,
          withOwner(owner => owner.interrupt(reason))
        )
      ),
      Effect.andThen(updateStatus(ctx))
    )
  const interrupt = (ctx: Pi.ExtensionContext, reason: string): Promise<void> =>
    Effect.runPromise(interruptOwned(ctx, reason))

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
        !isWorkspaceParked() &&
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

    void scope.session
      .sendCustomMessage(leadOutcomeMessage(items.map(({ item }) => item.attempt)), {
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
    withOwner(owner =>
      isWorkspaceParked() && (input.action === 'process' || input.action === 'delegate')
        ? Effect.fail(
            new WorkError({ message: 'Workspace host is parked; no background work was started' })
          )
        : executeWork(owner, input)
    )

  const bindSession = (value: WorkSession): void => {
    removeSessionListener?.()
    session = value
    idleDeliveryReady = value.isIdle
    removeSessionListener = value.subscribe(event => {
      if (session !== value) return
      if (event.type === 'agent_start') idleDeliveryReady = false
      else if (event.type === 'agent_settled') {
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
      await Effect.runPromise(updateStatus(ctx))
    })
    pi.on('agent_before_settle', async (event, ctx) => {
      idleDeliveryReady = false

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
            ...leadOutcomeMessage(items.map(({ item }) => item.attempt)),
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
      if (last?.stopReason === 'aborted' && context !== undefined && !isWorkspaceParked()) {
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
        'Run local commands or separate Pi children without blocking the lead. Inspect dispatch before delegating: resolve natural-language rules yourself into a rule index (or default) and explicit harness/model/effort overrides. taskId is a controller-local key, distinct from the durable workflowTaskId; each launch creates an attempt and a workspace use. Give children a focused self-contained prompt, never a full transcript by default. To load one skill, start the prompt with /skill:name followed by the assignment: Pi expands it natively, an unknown skill fails the attempt before any model request, and the child can still read every other skill of its profile. Set coordinate: true on a delegate call only to let that child run a whole phase: it gets a scoped work tool to start leaf children, never beyond its own access, and leaves cannot delegate further; you still see and stop every attempt, leaves included, through list, inspect and cancel, and only the outcome of the coordinator is delivered to you. Reviews use read-only access; WorkspaceLifecycle allocates a distinct workspace for each delegated writer without copying dirty files. Admission may require a host rebind: no command then runs, and a fresh decision is required. worktree.path records the managed checkout. A workspace use ends only when the whole owned process group is observed gone; a process that detaches into its own session escapes that observation, and lost observation leaves the workspace blocked for explicit recovery. Report retained workspaces in your handoff; do not release reservations or remove worktrees through this tool. Completion arrives automatically without polling or another user message. dev-cycle owns decisions, checkpoints and recovery; process outcomes are not verification. inspect pages retained logs by byte offset. cancel with no id interrupts all owned work. Quota exhaustion blocks agents, not existing local commands.',
      parameters,
      execute: (toolCallId, input, _signal, _onUpdate, ctx) =>
        Effect.runPromise(
          runOwned(ctx, decodeInput(input).pipe(Effect.flatMap(execute))).pipe(
            Effect.map(result => ({
              content: [{ type: 'text' as const, text: JSON.stringify(result ?? {}) }],
              details: result ?? {},
            })),
            Effect.catchTag('WorkRebindRequired', refusal =>
              Effect.sync(() => {
                rebindRefusals.add(toolCallId)
                return {
                  content: [{ type: 'text' as const, text: refusal.message }],
                  details: {},
                  terminate: true,
                }
              })
            )
          )
        ),
    })

    pi.on('tool_result', event =>
      rebindRefusals.delete(event.toolCallId) ? { isError: true } : undefined
    )
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
