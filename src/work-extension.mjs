import { WorkController } from './work-controller.mjs'
import { quotaExhausted } from './work-dispatch.mjs'

const string = { type: 'string' }
const parameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      enum: ['process', 'delegate', 'dispatch', 'list', 'inspect', 'cancel'],
      type: 'string',
    },
    taskId: string,
    command: string,
    prompt: string,
    cwd: string,
    id: string,
    access: { type: 'string', enum: ['read-only', 'write'] },
    harness: string,
    model: string,
    effort: string,
    rule: string,
    skills: { type: 'array', items: string },
    stream: { type: 'string', enum: ['stdout', 'stderr', 'result'] },
    offset: { type: 'integer', minimum: 0 },
  },
  required: ['action'],
}

function summary(record) {
  return {
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
  }
}

function outcomeMessage(items) {
  return {
    customType: 'dev/work-outcome',
    display: true,
    content: `Background work outcomes. These are producer observations, not verification; reconcile artifacts and honor dev-cycle checkpoints before proceeding. Report any recorded worktree and follow its cleanup guidance.\n${JSON.stringify(items)}`,
    details: { attempts: items.map(record => record.id) },
  }
}

export function createWorkExtension({ dataHome, specialization }) {
  let controller
  let session
  let context
  let removeInputListener
  let flushing = false
  const pending = new Map()

  function showStatus() {
    if (!controller || !context?.hasUI) return
    const { records, agentsBlocked } = controller.list()
    const counts = new Map()
    for (const record of records) counts.set(record.status, (counts.get(record.status) ?? 0) + 1)
    const states = [...counts].map(([status, count]) => `${count} ${status}`).join(' · ')
    const children = records.filter(record => record.kind === 'agent')
    const metered = children.filter(record => typeof record.usage?.total === 'number')
    const tokens = metered.reduce((sum, record) => sum + record.usage.total, 0)
    let usage = children.length ? 'child usage unavailable' : ''
    if (metered.length) {
      usage = `children: ${tokens} reported tokens`
      if (metered.length < children.length)
        usage += ` (${children.length - metered.length} unavailable)`
    }
    const agents = records.filter(
      record => record.kind === 'agent' && controller.active.has(record.id)
    )
    const models = agents
      .map(record => {
        const percentage = record.context?.percent
        const pressure =
          typeof percentage === 'number' ? `${percentage.toFixed(1)}%` : 'unavailable'
        return `${record.owner.taskId}: ${record.model ?? 'model pending'} context ${pressure}`
      })
      .join(' · ')
    context.ui.setStatus(
      'dev/work',
      [states, models, usage, agentsBlocked ? 'subscription exhausted; agents blocked' : '']
        .filter(Boolean)
        .join(' | ') || undefined
    )
  }

  function notifyError(error) {
    if (context?.hasUI) context.ui.notify(`Background work: ${error.message}`, 'error')
  }

  async function interrupt(reason) {
    pending.clear()
    await controller?.interrupt(reason)
    showStatus()
  }

  async function flush() {
    if (flushing || !controller || !session || !context?.isIdle() || pending.size === 0) return
    flushing = true
    const owner = controller
    let drain = true
    let records = []
    const delivered = id =>
      session.messages.some(
        message =>
          message.role === 'custom' &&
          message.customType === 'dev/work-outcome' &&
          message.details?.attempts?.includes(id)
      )
    try {
      for (const [id, record] of pending) {
        if (!owner.canDeliver(record) || delivered(id)) pending.delete(id)
      }
      records = [...pending.values()]
      const outcomes = await Promise.all(records.map(record => owner.describe(record)))
      if (controller !== owner || !context.isIdle()) return
      const valid = outcomes.filter(
        record =>
          owner.canDeliver(record) &&
          record.owner.sessionId === session.sessionManager.getSessionId()
      )
      if (valid.length === 0) return
      try {
        await session.sendCustomMessage(outcomeMessage(valid), {
          triggerTurn: !owner.exhausted && valid.every(record => !record.deliveryError),
          deliverAs: 'followUp',
        })
      } catch (error) {
        notifyError(error)
        const missing = valid.filter(record => !delivered(record.id) && owner.canDeliver(record))
        if (missing.length && context.isIdle()) {
          await session.sendCustomMessage(outcomeMessage(missing), { triggerTurn: false })
        }
      }
      for (const record of valid) {
        if (delivered(record.id)) pending.delete(record.id)
        else if (owner.canDeliver(record))
          throw new Error('Outcome not acknowledged by the owning conversation')
      }
    } catch (error) {
      drain = false
      for (const record of records) {
        if (delivered(record.id)) pending.delete(record.id)
        else if (pending.has(record.id)) {
          record.deliveryError = error.message
          owner.store.save(record)
        }
      }
      throw error
    } finally {
      flushing = false
      if (drain && pending.size && context?.isIdle()) scheduleDelivery()
    }
  }

  function scheduleDelivery() {
    setImmediate(() => {
      flush().catch(notifyError)
    })
  }

  async function close(reason = 'session ended') {
    pending.clear()
    removeInputListener?.()
    removeInputListener = undefined
    await controller?.close(reason)
  }

  function factory(pi) {
    function ensureOwner(ctx) {
      context = ctx
      if (!controller) {
        controller = new WorkController({
          dataHome,
          specialization,
          cwd: ctx.cwd,
          sessionId: ctx.sessionManager.getSessionId(),
          onChange: showStatus,
          onOutcome: record => {
            pending.set(record.id, record)
            scheduleDelivery()
          },
        })
      }
      if (ctx.sessionManager.getSessionId() !== controller.sessionId)
        throw new Error('Background work owner does not match the active conversation')
      return controller
    }

    pi.on('session_start', async (_event, ctx) => {
      const owner = ensureOwner(ctx)
      removeInputListener?.()
      if (ctx.hasUI) {
        removeInputListener = ctx.ui.onTerminalInput(data => {
          if ((data === '\u001b' || data === '\u001b[27u') && !ctx.isIdle()) {
            interrupt('voluntary interruption').catch(notifyError)
          }
        })
      }
      const recovered = owner.list()
      if (recovered.records.length > 0 || recovered.unavailable.length > 0) {
        await session.sendCustomMessage(
          {
            customType: 'dev/work-recovery',
            display: true,
            content:
              'Retained background-work facts are available through work/list and work/inspect. They do not authorize restart or establish current artifact verification.',
            details: {
              attempts: recovered.records.map(record => record.id),
              unavailable: recovered.unavailable,
            },
          },
          { triggerTurn: false }
        )
      }
      showStatus()
    })
    pi.on('agent_settled', (_event, ctx) => {
      context = ctx
      scheduleDelivery()
    })
    pi.on('input', () => {
      scheduleDelivery()
    })
    pi.on('agent_end', async event => {
      const last = event.messages.findLast(message => message.role === 'assistant')
      if (last?.stopReason === 'aborted') await interrupt('lead agent interrupted')
    })
    pi.on('message_end', async event => {
      if (event.message.role === 'assistant' && quotaExhausted(event.message.errorMessage)) {
        session.settingsManager.applyOverrides({ retry: { enabled: false } })
        await controller?.exhaust()
        showStatus()
        scheduleDelivery()
      }
    })
    for (const event of ['session_before_switch', 'session_before_fork', 'session_before_tree']) {
      pi.on(event, () => interrupt('session navigation'))
    }
    pi.on('session_shutdown', event => close(event.reason))

    async function execute(input, ctx) {
      const owner = ensureOwner(ctx)
      if (input.action === 'process') return owner.startProcess(input)
      if (input.action === 'delegate') return owner.startAgent(input)
      if (input.action === 'dispatch') return owner.dispatch()
      if (input.action === 'list') {
        const { records, ...facts } = owner.list()
        const offset = input.offset ?? 0
        return {
          ...facts,
          total: records.length,
          records: records.slice(offset, offset + 20).map(summary),
          nextOffset: offset + 20 < records.length ? offset + 20 : null,
        }
      }
      if (input.action === 'cancel')
        return input.id ? owner.cancel(input.id) : interrupt('explicit stop')
      if (input.action === 'inspect') {
        const record = owner.list().records.find(item => item.id === input.id)
        if (!record)
          throw new Error('Result is unavailable in this session (unknown or expired attempt)')
        return input.stream
          ? owner.store.readLog(record.id, input.stream, input.offset)
          : owner.describe(record)
      }
      throw new Error('Unsupported work operation')
    }

    pi.registerTool({
      name: 'work',
      label: 'Background work',
      description:
        'Run local commands or separate Pi children without blocking the lead. Inspect dispatch before delegating: resolve natural-language rules yourself into a rule index (or default) and explicit harness/model/effort overrides. taskId identifies the workflow task; each launch creates a distinct attempt. Give children a focused self-contained prompt and pertinent skill names, never a full transcript by default. Reviews use read-only access; writers require a pre-created separate linked worktree. worktree.path records its verified root. Cleanup blocked means termination or reservation release is unconfirmed; review-required asks for evaluation, not deletion. Report retained worktrees in your handoff, verify current use and preserve or integrate changes before user-authorized removal; never force removal. Completion arrives automatically without polling or another user message. dev-cycle owns decisions, checkpoints and recovery; process outcomes are not verification. inspect pages retained logs by byte offset. cancel with no id interrupts all owned work. Quota exhaustion blocks agents, not existing local commands.',
      parameters,
      async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
        const result = await execute(input, ctx)
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
        let operation = action || 'list'
        if (operation === 'stop') operation = 'cancel'
        try {
          const result = await execute(
            {
              action: operation,
              id,
              stream,
              offset: offset === undefined ? undefined : Number(offset),
            },
            ctx
          )
          pi.sendMessage(
            {
              customType: 'dev/work-inspection',
              content: JSON.stringify(result ?? { stopped: true }, null, 2),
              display: true,
            },
            { triggerTurn: false }
          )
        } catch (error) {
          ctx.ui.notify(error.message, 'error')
        }
      },
    })
  }

  return {
    factory,
    bindSession(value) {
      session = value
    },
    close,
  }
}
