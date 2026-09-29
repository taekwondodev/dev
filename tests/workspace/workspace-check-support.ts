import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { NodeServices } from '@effect/platform-node'
import { Effect, Exit, Scope } from 'effect'
import type * as Pi from '../../node_modules/@earendil-works/pi-coding-agent/dist/index.js'
import type * as PiEventStream from '../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js'
import type {
  AssistantMessage,
  Model,
} from '../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js'
import { makeRuntimeFactory } from '../../src/launcher.ts'
import { loadPi, loadPiPathResolver, type PiApi } from '../../src/pi-runtime.ts'
import { getProfile } from '../../src/profiles.ts'
import { acquireRuntime, type CoordinationOptions } from '../../src/runtime-coordination.ts'
import { createSessionGuard } from '../../src/session-guard.ts'
import type { WorkspaceAttachment, WorkspaceLifecycle } from '../../src/workspace-domain.ts'
import { makeWorkspaceHost } from '../../src/workspace-host.ts'

class TimedOut extends Error {}

export const within = <A>(promise: Promise<A>, ms: number, what: string): Promise<A> =>
  Promise.race([
    promise,
    sleep(ms, undefined, { ref: false }).then(() => {
      throw new TimedOut(`timed out: ${what}`)
    }),
  ])

export interface Claims {
  claim<A>(text: string, assertions: () => A | Promise<A>, limitMs?: number): Promise<A>
  readonly passed: readonly string[]
}

const CLAIM_LIMIT_MS = 120_000

export const makeClaims = (defaultLimitMs = CLAIM_LIMIT_MS): Claims => {
  const passed: string[] = []
  return {
    passed,
    async claim(text, assertions, limitMs = defaultLimitMs) {
      if (passed.includes(text)) throw new Error(`Claim recorded twice: ${text}`)

      const value = await within(
        Promise.resolve().then(assertions),
        limitMs,
        `claim: ${text}`
      ).catch((cause: unknown) => {
        if (cause instanceof TimedOut) process.stderr.write(`${cause.message}\n`)
        throw cause
      })
      passed.push(text)
      return value
    },
  }
}

export const loadInstalledPi = async () => {
  const { api, packageInfo } = await Effect.runPromise(
    loadPi.pipe(Effect.provide(NodeServices.layer))
  )
  const importFromPi = <Module>(path: string): Promise<Module> =>
    import(pathToFileURL(join(packageInfo.root, path)).href)
  return { pi: api, packageInfo, importFromPi }
}

export const loadImportPathResolver = (packageRoot: string): Promise<(input: string) => string> =>
  Effect.runPromise(loadPiPathResolver(packageRoot))

export const deferred = <A>() => {
  const settle: { resolve?: (value: A) => void } = {}
  const promise = new Promise<A>(resolvePromise => {
    settle.resolve = resolvePromise
  })
  return { promise, resolve: (value: A) => settle.resolve?.(value) }
}

export interface WaitTiming {
  readonly attempts?: number
  readonly intervalMs?: number
}

export async function waitUntil<A, B extends A>(
  what: string,
  read: () => A | Promise<A>,
  done: (value: A) => value is B,
  timing?: WaitTiming
): Promise<B>
export async function waitUntil<A>(
  what: string,
  read: () => A | Promise<A>,
  done: (value: A) => boolean,
  timing?: WaitTiming
): Promise<A>
export async function waitUntil<A>(
  what: string,
  read: () => A | Promise<A>,
  done: (value: A) => boolean,
  { attempts = 80, intervalMs = 250 }: WaitTiming = {}
): Promise<A> {
  let last: A | undefined
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await read()
    if (done(last)) return last
    await sleep(intervalMs)
  }
  const shown = last === undefined ? '' : `; last read: ${JSON.stringify(last)}`
  throw new Error(`timed out: ${what}${shown}`)
}

export const waitFor = <A>(
  what: string,
  probe: () => A | undefined | Promise<A | undefined>,
  timing?: WaitTiming
): Promise<A> => waitUntil(what, probe, (value): value is A => value !== undefined, timing)

export type ScriptedContent = AssistantMessage['content']

export const toolCall = (
  id: string,
  name: string,
  args: Extract<ScriptedContent[number], { type: 'toolCall' }>['arguments']
): ScriptedContent[number] => ({ type: 'toolCall', id, name, arguments: args })

export type StreamSimple = NonNullable<Pi.ProviderConfig['streamSimple']>
export interface ScriptedStreamParts {
  readonly assistantMessage: (
    content: ScriptedContent,
    stopReason: AssistantMessage['stopReason']
  ) => AssistantMessage
  readonly eventStreams: typeof PiEventStream
}

export interface ScriptedReply {
  readonly content: ScriptedContent
  readonly stopReason: 'toolUse' | 'stop' | 'aborted'
  readonly delayMs: number
}

export const emitReply = (
  { assistantMessage, eventStreams }: ScriptedStreamParts,
  reply: ScriptedReply,
  signal: AbortSignal | undefined
) => {
  const stream = eventStreams.createAssistantMessageEventStream()
  const message = assistantMessage(reply.content, reply.stopReason)
  const timer = setTimeout(() => {
    stream.push(
      reply.stopReason === 'aborted'
        ? { type: 'error', reason: 'aborted', error: message }
        : { type: 'done', reason: reply.stopReason, message }
    )
    stream.end()
  }, reply.delayMs)
  signal?.addEventListener(
    'abort',
    () => {
      clearTimeout(timer)
      stream.push({ type: 'error', reason: 'aborted', error: assistantMessage([], 'aborted') })
      stream.end()
    },
    { once: true }
  )
  return stream
}

export const replay =
  (next: () => ScriptedContent, delayMs = 10) =>
  (parts: ScriptedStreamParts): StreamSimple =>
  (_model, _context, options) => {
    const content = next()
    const stopReason = content.some(part => part.type === 'toolCall') ? 'toolUse' : 'stop'
    return emitReply(parts, { content, stopReason, delayMs }, options?.signal)
  }

export const makeOfflineModel = async (input: {
  readonly pi: PiApi
  readonly importFromPi: <Module>(path: string) => Promise<Module>
  readonly fixture: string
  readonly id: string
  readonly stream: (parts: ScriptedStreamParts) => StreamSimple
}) => {
  const model: Model<'openai-completions'> = {
    id: input.id,
    name: `Offline ${input.id}`,
    api: 'openai-completions',
    provider: `${input.id}-offline`,
    baseUrl: 'http://127.0.0.1:9/v1',
    reasoning: false,
    input: ['text'],
    contextWindow: 200000,
    maxTokens: 1000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
  const assistantMessage = (
    content: ScriptedContent,
    stopReason: AssistantMessage['stopReason']
  ): AssistantMessage => ({
    role: 'assistant',
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason,
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  })
  const eventStreams = await input.importFromPi<typeof PiEventStream>(
    'node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js'
  )
  const streamSimple = input.stream({ assistantMessage, eventStreams })
  const modelRuntime = await input.pi.ModelRuntime.create({
    authPath: join(input.fixture, 'never-created-auth.json'),
    modelsPath: join(input.fixture, 'never-created-models.json'),
    allowModelNetwork: false,
    refreshOnCreate: false,
  })
  modelRuntime.registerProvider(model.provider, {
    name: model.name,
    api: model.api,
    baseUrl: model.baseUrl,
    apiKey: 'offline',
    authHeader: false,
    models: [{ ...model }],
    streamSimple,
  })
  return { model, modelRuntime, assistantMessage }
}

export const openHostRuntime = async (input: {
  readonly coordination: CoordinationOptions
  readonly pi: PiApi
  readonly packageRoot: string
  readonly lifecycle: WorkspaceLifecycle
  readonly attachment: WorkspaceAttachment
  readonly dataHome: string
  readonly sessionDir: string
  readonly agentDir: string
  readonly manager: Pi.SessionManager
  readonly cwd: string
  readonly repositoryRoot: (cwd: string) => Effect.Effect<string | undefined>
  readonly offline?: Pick<Awaited<ReturnType<typeof makeOfflineModel>>, 'model' | 'modelRuntime'>
}) => {
  const resolveImportPath = await loadImportPathResolver(input.packageRoot)
  const scope = Scope.makeUnsafe()
  try {
    const host = await Effect.runPromise(
      Scope.provide(scope)(
        makeWorkspaceHost({
          lifecycle: input.lifecycle,
          attachment: input.attachment,
          dataHome: input.dataHome,
          openSessionManager: (file, cwd) =>
            input.pi.SessionManager.open(file, input.sessionDir, cwd),
          repositoryRoot: input.repositoryRoot,
          resolveImportPath,
        })
      )
    )
    const guard = createSessionGuard(
      await Effect.runPromise(
        Scope.provide(scope)(acquireRuntime(input.dataHome, input.coordination))
      )
    )
    const runtimeFactory = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* makeRuntimeFactory({
          api: input.pi,
          packageRoot: input.packageRoot,
          dataHome: input.dataHome,
          profile: yield* getProfile('general'),
          guard,
          workspaceHost: host,
          lifecycle: input.lifecycle,
          ...(input.offline === undefined
            ? {}
            : {
                modelRuntime: Effect.succeed(input.offline.modelRuntime),
                model: input.offline.model,
              }),
        })
      }).pipe(Effect.provide(NodeServices.layer))
    )
    const runtime = await input.pi.createAgentSessionRuntime(runtimeFactory, {
      cwd: input.cwd,
      agentDir: input.agentDir,
      sessionManager: input.manager,
    })
    host.bindRuntime(runtime)
    guard.bind(runtime)
    return {
      host,
      runtime,
      close: async () => {
        await runtime.dispose()
        await Effect.runPromise(Scope.close(scope, Exit.void))
      },
    }
  } catch (cause) {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    throw cause
  }
}
