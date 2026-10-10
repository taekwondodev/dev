import type * as Pi from '@earendil-works/pi-coding-agent'
import { createWorkExtension } from '../../src/work-extension.ts'
import {
  makeOfflineModel,
  waitFor,
  type loadInstalledPi,
  type ScriptedContent,
  type StreamSimple,
} from '../workspace/workspace-check-support.ts'
import type { openWorkFixture } from './work-check-support.ts'

type WorkFixture = Awaited<ReturnType<typeof openWorkFixture>>
type InstalledPi = Awaited<ReturnType<typeof loadInstalledPi>>
type BoundSession = Parameters<ReturnType<typeof createWorkExtension>['bindSession']>[0]
type SendCustomMessage = BoundSession['sendCustomMessage']

const POLL = { attempts: 12_000, intervalMs: 5 }

export interface LeadRequest {
  readonly context: Parameters<StreamSimple>[1]
  reply(content: ScriptedContent): void
  fail(errorMessage: string): void
}

interface Notice {
  readonly message: string
  readonly level: string | undefined
}

let sequence = 0

export const openLead = async (
  installed: InstalledPi,
  fixture: WorkFixture,
  options: {
    readonly send?: (deliver: SendCustomMessage) => SendCustomMessage
    readonly notify?: (notice: Notice) => void
    readonly tools?: readonly string[]
    readonly codemode?: boolean
    readonly onToolResult?: (event: {
      readonly toolName: string
      readonly structuredContent?: unknown
    }) => void
  } = {}
) => {
  const { pi, importFromPi } = installed
  const requests: LeadRequest[] = []
  const offline = await makeOfflineModel({
    pi,
    importFromPi,
    fixture: fixture.dataHome,
    id: `work-extension-${++sequence}`,
    stream: parts => (_model, context, requestOptions) => {
      const stream = parts.eventStreams.createAssistantMessageEventStream()
      let open = true
      const end = (event: Parameters<typeof stream.push>[0]): void => {
        if (!open) return
        open = false
        stream.push(event)
        stream.end()
      }
      requestOptions?.signal?.addEventListener(
        'abort',
        () =>
          end({ type: 'error', reason: 'aborted', error: parts.assistantMessage([], 'aborted') }),
        { once: true }
      )
      requests.push({
        context,
        reply: content => {
          const reason = content.some(part => part.type === 'toolCall') ? 'toolUse' : 'stop'
          end({ type: 'done', reason, message: parts.assistantMessage(content, reason) })
        },
        fail: errorMessage =>
          end({
            type: 'error',
            reason: 'error',
            error: { ...parts.assistantMessage([], 'error'), errorMessage },
          }),
      })
      return stream
    },
  })
  const manager = pi.SessionManager.inMemory(fixture.repository)
  const settingsManager = pi.SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
    cacheWarming: 'off',
  })
  const work = createWorkExtension({
    dataHome: fixture.dataHome,
    profile: fixture.profiles.defaultProfile,
    workspace: {
      lifecycle: fixture.lifecycle.effect,
      attachment: fixture.attachment.effect,
      requestRebind: () => {
        throw new Error('no work extension check expects a workspace rebind')
      },
    },
    isWorkspaceParked: () => false,
  })
  const activities: unknown[] = []
  const services = await pi.createAgentSessionServices({
    cwd: fixture.repository,
    agentDir: fixture.agentDir,
    modelRuntime: offline.modelRuntime,
    settingsManager,
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [
        work.factory,
        api => {
          api.events.on('dev/work-activity', activity => activities.push(activity))
          api.on('tool_result', event => {
            options.onToolResult?.(event)
            return undefined
          })
        },
        ...(options.codemode === true ? [pi.createCodemodeExtension({ mode: 'on' })] : []),
      ],
    },
  })
  const { session } = await pi.createAgentSessionFromServices({
    services,
    sessionManager: manager,
    model: offline.model,
    tools: [...(options.tools ?? ['work'])],
  })
  const deliver: SendCustomMessage = (message, sendOptions) =>
    session.sendCustomMessage(message, sendOptions)
  const send = options.send?.(deliver) ?? deliver
  work.bindSession({
    sendCustomMessage: send,
    settingsManager: session.settingsManager,
    sessionManager: session.sessionManager,
    subscribe: listener => session.subscribe(listener),
    get isIdle() {
      return session.isIdle
    },
    get isStreaming() {
      return session.isStreaming
    },
  })
  const statuses: (string | undefined)[] = []
  const notices: Notice[] = []
  const handlerErrors: string[] = []
  const terminal: ((data: string) => unknown)[] = []
  await session.bindExtensions({
    uiContext: {
      ...session.extensionRunner.getUIContext(),
      setStatus: (key, text) => {
        if (key === 'dev/work') statuses.push(text)
      },
      notify: (message, level) => {
        options.notify?.({ message, level })
        notices.push({ message, level })
      },
      onTerminalInput: handler => {
        terminal.push(handler)
        return () => {
          terminal.splice(terminal.indexOf(handler), 1)
        }
      },
    },
    onError: error => {
      handlerErrors.push(`${error.event}: ${error.error}`)
    },
  })
  const runtime = new pi.AgentSessionRuntime(session, services, async () => {
    throw new Error('This work extension fixture does not replace sessions')
  })

  const request = (index: number): Promise<LeadRequest> =>
    waitFor(`lead model request ${index}`, () => requests[index], POLL)
  const customMessages = (customType: string): Pi.CustomMessageEntry[] =>
    manager
      .getBranch()
      .flatMap(entry =>
        entry.type === 'custom_message' && entry.customType === customType ? [entry] : []
      )
  const status = (what: string, done: (text: string) => boolean): Promise<string> =>
    waitFor(
      `status line: ${what}`,
      () => {
        const text = statuses.at(-1)
        return text !== undefined && done(text) ? text : undefined
      },
      POLL
    )
  const idle = (): Promise<true> =>
    waitFor('the lead to be idle', () => (session.isIdle ? true : undefined), POLL)

  return {
    session,
    manager,
    work,
    requests,
    statuses,
    activities,
    notices,
    handlerErrors,
    request,
    customMessages,
    status,
    idle,
    wait: <A>(what: string, probe: () => A | undefined | Promise<A | undefined>): Promise<A> =>
      waitFor(what, probe, POLL),
    typeTerminal: (data: string): void => {
      for (const handler of terminal) handler(data)
    },
    close: () => runtime.dispose(),
  }
}

export type Lead = Awaited<ReturnType<typeof openLead>>
