import { Effect, ManagedRuntime, Schema } from 'effect'
import type * as Pi from '@earendil-works/pi-coding-agent'
import { WorkOwner, makeWorkOwnerLayer } from './work-controller.ts'
import {
  asAttemptId,
  asSessionId,
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

const DeliveryDetails = Schema.Struct({ attempts: Schema.Array(Schema.String) })

type WorkSession = Pick<
  Pi.AgentSession,
  'messages' | 'sendCustomMessage' | 'settingsManager' | 'sessionManager'
>

interface SessionOwner {
  readonly _tag: 'active'
  readonly sessionId: SessionId
  readonly runtime: ManagedRuntime.ManagedRuntime<WorkOwner, WorkSetupError>
}

type OwnerState = SessionOwner | { readonly _tag: 'closed'; readonly shutdown: Promise<void> }

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
  processObservation: record.processObservation,
  recovery: record.recovery,
})

const outcomeMessage = (items: readonly AttemptView[]) => ({
  customType: 'dev/work-outcome',
  display: true,
  content: `Background work outcomes. These are producer observations, not verification; reconcile artifacts and honor dev-cycle checkpoints before proceeding. Report any recorded worktree and follow its cleanup guidance.\n${JSON.stringify(items)}`,
  details: { attempts: items.map(record => record.id) },
})

const messageDelivered = (session: WorkSession, id: AttemptId): boolean =>
  session.messages.some(message => {
    if (
      message.role !== 'custom' ||
      !('customType' in message) ||
      message.customType !== 'dev/work-outcome'
    )
      return false
    const details = Schema.decodeUnknownResult(DeliveryDetails)(
      'details' in message ? message.details : undefined
    )
    return details._tag === 'Success' && details.success.attempts.includes(id)
  })

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
  let flushing = false
  const pending = new Map<AttemptId, AttemptView>()

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
                if (context?.sessionManager.getSessionId() !== sessionId) return
                pending.set(attempt.id, attempt)
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

  const flush = async (): Promise<void> => {
    const ctx = context
    const activeSession = session
    const currentOwner = sessionOwner
    if (
      flushing ||
      currentOwner === undefined ||
      currentOwner._tag === 'closed' ||
      activeSession === undefined ||
      ctx === undefined ||
      !ctx.isIdle() ||
      pending.size === 0
    )
      return
    flushing = true
    let drain = true
    let records: AttemptView[] = []
    try {
      const snapshot = await currentOwner.runtime.runPromise(withOwner(owner => owner.snapshot))
      const current = new Map(snapshot.records.map(record => [record.id, record]))
      for (const [id] of pending) {
        const latest = current.get(id)
        const deliverable =
          latest === undefined
            ? false
            : await currentOwner.runtime.runPromise(withOwner(owner => owner.canDeliver(latest)))
        if (!deliverable || messageDelivered(activeSession, id)) pending.delete(id)
        else if (latest !== undefined) pending.set(id, latest)
      }
      records = [...pending.values()]
      const outcomes = await Promise.all(
        records.map(record =>
          currentOwner.runtime.runPromise(withOwner(owner => owner.inspect(record.id)))
        )
      )
      const isCurrent = () =>
        sessionOwner === currentOwner &&
        session === activeSession &&
        context === ctx &&
        ctx.isIdle() &&
        ctx.sessionManager.getSessionId() === currentOwner.sessionId &&
        activeSession.sessionManager.getSessionId() === currentOwner.sessionId
      if (!isCurrent()) return
      const valid: AttemptView[] = []
      for (const outcome of outcomes) {
        if (
          outcome.owner.sessionId === currentOwner.sessionId &&
          (await currentOwner.runtime.runPromise(withOwner(owner => owner.canDeliver(outcome))))
        )
          valid.push(outcome)
      }
      if (valid.length === 0 || !isCurrent()) return
      try {
        await activeSession.sendCustomMessage(outcomeMessage(valid), {
          triggerTurn: !snapshot.agentsBlocked && !valid.some(record => record.deliveryError),
          deliverAs: 'followUp',
        })
      } catch (cause) {
        notifyError(cause)
        const missing: AttemptView[] = []
        for (const record of valid) {
          if (
            !messageDelivered(activeSession, record.id) &&
            (await currentOwner.runtime.runPromise(withOwner(work => work.canDeliver(record))))
          )
            missing.push(record)
        }
        if (missing.length > 0 && isCurrent())
          await activeSession.sendCustomMessage(outcomeMessage(missing), { triggerTurn: false })
      }
      for (const record of valid) {
        if (messageDelivered(activeSession, record.id)) pending.delete(record.id)
        else if (
          isCurrent() &&
          (await currentOwner.runtime.runPromise(withOwner(owner => owner.canDeliver(record))))
        )
          throw new Error('Outcome not acknowledged by the owning conversation')
      }
    } catch (cause) {
      drain = false
      for (const record of records) {
        if (messageDelivered(activeSession, record.id)) pending.delete(record.id)
        else if (
          pending.has(record.id) &&
          sessionOwner === currentOwner &&
          ctx.sessionManager.getSessionId() === currentOwner.sessionId
        ) {
          const message = cause instanceof Error ? cause.message : String(cause)
          await currentOwner.runtime.runPromise(
            withOwner(owner => owner.recordDeliveryFailure(record.id, message))
          )
        }
      }
      throw cause
    } finally {
      flushing = false
      if (drain && pending.size > 0 && context?.isIdle()) scheduleDelivery()
    }
  }

  const scheduleDelivery = (): void => {
    setImmediate(() => void flush().catch(notifyError))
  }

  const close = async (reason = 'session ended'): Promise<void> => {
    if (sessionOwner?._tag === 'closed') return sessionOwner.shutdown
    pending.clear()
    removeInputListener?.()
    removeInputListener = undefined
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
          ? owner.interrupt('explicit stop').pipe(Effect.as({ stopped: true }))
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

  const factory: Pi.ExtensionFactory = pi => {
    pi.on('session_start', async (_event, ctx) => {
      const previous = sessionOwner
      if (previous?._tag === 'closed') {
        await previous.shutdown
        if (sessionOwner === previous) sessionOwner = undefined
      }
      const ownerSnapshot = await run(
        ctx,
        withOwner(owner => owner.snapshot)
      )
      removeInputListener?.()
      if (ctx.hasUI) {
        removeInputListener = ctx.ui.onTerminalInput(data => {
          if ((data === '\u001b' || data === '\u001b[27u') && !ctx.isIdle())
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
    pi.on('agent_settled', async (_event, ctx) => {
      if (sessionOwner?._tag !== 'active') return
      await Effect.runPromise(ownerRuntime(ctx))
      scheduleDelivery()
    })
    pi.on('input', () => scheduleDelivery())
    pi.on('agent_end', async event => {
      const last = event.messages.findLast(message => message.role === 'assistant')
      if (last?.stopReason === 'aborted' && context !== undefined)
        await interrupt(context, 'lead agent interrupted')
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
    pi.on('session_before_switch', () =>
      context === undefined ? undefined : close('session navigation')
    )
    pi.on('session_before_fork', () =>
      context === undefined ? undefined : close('session navigation')
    )
    pi.on('session_before_tree', () =>
      context === undefined ? undefined : close('session navigation')
    )
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
          content: [{ type: 'text', text: JSON.stringify(result ?? { stopped: true }) }],
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
              content: JSON.stringify(result ?? { stopped: true }, null, 2),
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
    bindSession(value: WorkSession) {
      session = value
    },
    close,
  }
}
