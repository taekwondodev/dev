import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { NodeServices } from '@effect/platform-node'
import { Effect, Exit, Scope } from 'effect'
import type * as Pi from '../node_modules/@earendil-works/pi-coding-agent/dist/index.js'
import type * as PiPaths from '../node_modules/@earendil-works/pi-coding-agent/dist/utils/paths.js'
import type * as PiEventStream from '../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js'
import type {
  AssistantMessage,
  Model,
} from '../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js'
import { makeRuntimeFactory } from '../src/launcher.ts'
import { loadPi, type PiApi } from '../src/pi-runtime.ts'
import { getProfile } from '../src/profiles.ts'
import { acquireRuntime } from '../src/runtime-coordination.ts'
import { createSessionGuard } from '../src/session-guard.ts'
import type { WorkspaceAttachment, WorkspaceLifecycle } from '../src/workspace-domain.ts'
import { makeWorkspaceHost } from '../src/workspace-host.ts'

// A claim enters the report only after the assertions of its own block ran and passed. A
// failing block throws before anything is recorded, so the printed list cannot outrun its
// evidence.
export interface Claims {
  claim<A>(text: string, assertions: () => A | Promise<A>): Promise<A>
  readonly passed: readonly string[]
}

export const makeClaims = (): Claims => {
  const passed: string[] = []
  return {
    passed,
    async claim(text, assertions) {
      if (passed.includes(text)) throw new Error(`Claim recorded twice: ${text}`)
      const value = await assertions()
      passed.push(text)
      return value
    },
  }
}

// Scripts resolve and load the installed global Pi exactly as the launcher does. Modules the
// SDK entry does not export are imported from the same resolved package root, as the
// launcher imports its project-trust resolver.
export const loadInstalledPi = async () => {
  const { api, packageInfo } = await Effect.runPromise(
    loadPi.pipe(Effect.provide(NodeServices.layer))
  )
  const importFromPi = <Module>(path: string): Promise<Module> =>
    import(pathToFileURL(join(packageInfo.root, path)).href)
  return { pi: api, packageInfo, importFromPi }
}

export const loadPiPaths = (packageRoot: string): Promise<typeof PiPaths> =>
  import(pathToFileURL(join(packageRoot, 'dist/utils/paths.js')).href)

export const deferred = <A>() => {
  const settle: { resolve?: (value: A) => void } = {}
  const promise = new Promise<A>(resolvePromise => {
    settle.resolve = resolvePromise
  })
  return { promise, resolve: (value: A) => settle.resolve?.(value) }
}

export const waitFor = async <A>(
  what: string,
  probe: () => Promise<A | undefined>,
  attempts = 80,
  intervalMs = 250
): Promise<A> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await probe()
    if (value !== undefined) return value
    await sleep(intervalMs)
  }
  throw new Error(`timed out: ${what}`)
}

export type ScriptedContent = AssistantMessage['content']

export const toolCall = (
  id: string,
  name: string,
  args: Extract<ScriptedContent[number], { type: 'toolCall' }>['arguments']
): ScriptedContent[number] => ({ type: 'toolCall', id, name, arguments: args })

// Offline and scripted, so a check spends no credentials and needs no network.
export const makeOfflineModel = async (input: {
  readonly pi: PiApi
  readonly importFromPi: <Module>(path: string) => Promise<Module>
  readonly fixture: string
  readonly id: string
  readonly next: () => ScriptedContent
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
  const streamSimple: NonNullable<Pi.ProviderConfig['streamSimple']> = () => {
    const content = input.next()
    const stopReason = content.some(part => part.type === 'toolCall') ? 'toolUse' : 'stop'
    const stream = eventStreams.createAssistantMessageEventStream()
    setTimeout(() => {
      stream.push({
        type: 'done',
        reason: stopReason,
        message: assistantMessage(content, stopReason),
      })
      stream.end()
    }, 10)
    return stream
  }
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

// A Pi runtime built by the launcher's own factory around a host the check controls.
export const openHostRuntime = async (input: {
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
  readonly offline?: Awaited<ReturnType<typeof makeOfflineModel>>
}) => {
  const piPaths = await loadPiPaths(input.packageRoot)
  const scope = Scope.makeUnsafe()
  const host = await Effect.runPromise(
    Scope.provide(scope)(
      makeWorkspaceHost({
        lifecycle: input.lifecycle,
        attachment: input.attachment,
        dataHome: input.dataHome,
        openSessionManager: (file, cwd) =>
          input.pi.SessionManager.open(file, input.sessionDir, cwd),
        repositoryRoot: input.repositoryRoot,
        resolveImportPath: path => piPaths.resolvePath(path),
      })
    )
  )
  const guard = createSessionGuard(
    await Effect.runPromise(Scope.provide(scope)(acquireRuntime(input.dataHome)))
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
}
