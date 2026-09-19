#!/usr/bin/env node
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { resolve } from 'node:path'
import { Effect, Option, Schema } from 'effect'
import type * as FileSystem from 'effect/FileSystem'
import type { AgentSessionServices } from '@earendil-works/pi-coding-agent'
import {
  acquireRuntime,
  defaultDataHome,
  globalPiAgentDir,
  globalPiAuthPath,
  gitRoot,
  resolveSelection,
  saveSelection,
  sessionDir,
} from './preferences.ts'
import {
  composeResources,
  getSpecialization,
  resourceSummary,
  specializationNames,
  type ComposedResources,
  type Specialization,
} from './specializations.ts'
import { loadPi, type PiApi } from './pi-runtime.ts'
import { createWorkExtension } from './work-extension.ts'
import { readDispatch } from './work-dispatch.ts'

export class LauncherError extends Schema.TaggedError<LauncherError>()('LauncherError', {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

interface LaunchOptions {
  readonly cwd: string
  readonly dataHome?: string
  readonly specialization?: string
  readonly saveSpecialization?: string
  readonly resume?: string
  readonly continueSession: boolean
  readonly diagnostics: boolean
  readonly probeRuntime: boolean
  readonly help: boolean
}

type RuntimeFactory = Parameters<PiApi['createAgentSessionRuntime']>[0]
type RuntimeFactoryOptions = Parameters<RuntimeFactory>[0]
type RuntimeFactoryResult = Awaited<ReturnType<RuntimeFactory>>
type AgentRuntime = Awaited<ReturnType<PiApi['createAgentSessionRuntime']>>
type SessionManager = RuntimeFactoryOptions['sessionManager']
type SessionEntry = ReturnType<SessionManager['getEntries']>[number]
type CustomSessionEntry = Extract<SessionEntry, { type: 'custom' }>

const SessionSpecializationSchema = Schema.Struct({
  specialization: Schema.String,
})

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const toLauncherError = (error: unknown, operation: string): LauncherError =>
  error instanceof LauncherError
    ? error
    : new LauncherError({ message: `${operation}: ${messageOf(error)}`, cause: error })

const fromPromise = <A>(
  operation: string,
  run: () => PromiseLike<A>
): Effect.Effect<A, LauncherError> =>
  Effect.tryPromise({
    try: run,
    catch: error => toLauncherError(error, operation),
  })

const fromSync = <A>(operation: string, run: () => A): Effect.Effect<A, LauncherError> =>
  Effect.try({
    try: run,
    catch: error => toLauncherError(error, operation),
  })

const nextArgument = (argv: readonly string[], index: number, option: string): string => {
  const value = argv[index]
  if (value === undefined) throw new Error(`${option} requires a value`)
  return value
}

const parseArgs = (argv: readonly string[]): Effect.Effect<LaunchOptions, LauncherError> =>
  Effect.try({
    try: () => {
      const values: {
        cwd: string
        dataHome?: string
        specialization?: string
        saveSpecialization?: string
        resume?: string
        continueSession: boolean
        diagnostics: boolean
        probeRuntime: boolean
        help: boolean
      } = {
        cwd: process.cwd(),
        continueSession: false,
        diagnostics: false,
        probeRuntime: false,
        help: false,
      }
      for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index]
        if (arg === '--cwd') values.cwd = resolve(nextArgument(argv, ++index, arg))
        else if (arg === '--data-home') values.dataHome = resolve(nextArgument(argv, ++index, arg))
        else if (arg === '--specialization')
          values.specialization = nextArgument(argv, ++index, arg)
        else if (arg === '--save-specialization')
          values.saveSpecialization = nextArgument(argv, ++index, arg)
        else if (arg === '--resume') values.resume = resolve(nextArgument(argv, ++index, arg))
        else if (arg === '--continue') values.continueSession = true
        else if (arg === '--diagnostics') values.diagnostics = true
        else if (arg === '--probe-runtime') values.probeRuntime = true
        else if (arg === '--help') values.help = true
        else throw new Error(`Unknown option ${arg}. Use --help.`)
      }
      return {
        ...values,
        cwd: values.cwd,
        dataHome: values.dataHome,
        resume: values.resume,
      }
    },
    catch: error => toLauncherError(error, 'Cannot parse launcher arguments'),
  })

const printHelp = (): Effect.Effect<void> =>
  Effect.sync(() => {
    process.stdout.write(
      `dev — Pi development environment\n\nUsage: dev [options]\n\nOptions:\n  --cwd PATH                    launch from PATH\n  --specialization NAME        temporary specialization (${specializationNames().join(' | ')})\n  --save-specialization NAME   explicitly save a repository/directory preference\n  --resume PATH                resume a Pi JSONL session\n  --continue                    resume the newest session for this launch directory\n  --data-home PATH             dedicated dev data home\n  --diagnostics                resolve dependencies and print composition\n  --probe-runtime              exercise SDK startup without opening the TUI\n  --help                       show this help\n`
    )
  })

const specializationFromSession = (sessions: SessionManager): string | undefined => {
  const entry = sessions
    .getEntries()
    .findLast(
      (candidate): candidate is CustomSessionEntry =>
        candidate.type === 'custom' && candidate.customType === 'dev/specialization'
    )
  if (entry === undefined) return undefined
  return Option.getOrUndefined(Schema.decodeUnknownOption(SessionSpecializationSchema)(entry.data))
    ?.specialization
}

const validateDiagnostics = (
  services: AgentSessionServices,
  specialization: Specialization,
  resources: ComposedResources,
  verbose: boolean
): void => {
  const skillDiagnostics = services.resourceLoader.getSkills().diagnostics
  const extensionErrors = services.resourceLoader.getExtensions().errors
  const errors = [
    ...services.diagnostics.filter(({ type }) => type === 'error').map(({ message }) => message),
    ...skillDiagnostics.filter(({ type }) => type === 'error').map(({ message }) => message),
    ...extensionErrors.map(({ error, path }) => `${path}: ${error}`),
  ]
  if (errors.length > 0)
    throw new Error(
      `Pi startup cannot continue for specialization "${specialization.name}":\n${errors.join('\n')}`
    )
  if (verbose) {
    const { skills } = services.resourceLoader.getSkills()
    process.stdout.write(
      `specialization: ${specialization.name}\nskills loaded: ${skills.length}\n`
    )
    process.stdout.write(
      `resources:\n${resourceSummary(resources)}\nskill provenance:\n${skills
        .map(
          ({ name, filePath, disableModelInvocation }) =>
            `${name} -> ${filePath}${disableModelInvocation ? ' [hidden]' : ''}`
        )
        .join('\n')}\n`
    )
  }
}

const createRuntime = (
  api: PiApi,
  dataHome: string,
  specialization: Specialization,
  options: LaunchOptions,
  runtimeOptions: RuntimeFactoryOptions
): Effect.Effect<RuntimeFactoryResult, LauncherError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const resources = yield* composeResources({
      cwd: runtimeOptions.cwd,
      gitRoot: yield* gitRoot(runtimeOptions.cwd),
      specialization,
    }).pipe(Effect.mapError(error => toLauncherError(error, 'Cannot compose runtime resources')))
    const work = yield* fromSync('Cannot create background-work extension', () =>
      createWorkExtension({
        dataHome,
        specialization: specialization.name,
      })
    )
    const services = yield* fromPromise('Cannot create Pi session services', async () =>
      api.createAgentSessionServices({
        cwd: runtimeOptions.cwd,
        agentDir: runtimeOptions.agentDir,
        modelRuntime: await api.ModelRuntime.create({ authPath: globalPiAuthPath() }),
        resourceLoaderOptions: {
          additionalSkillPaths: [...resources.skillPaths],
          appendSystemPrompt: [specialization.guidance],
          extensionFactories: [{ name: 'dev:work', factory: work.factory }],
        },
      })
    )
    const result = yield* fromPromise('Cannot create Pi session', () =>
      api.createAgentSessionFromServices({
        services,
        sessionManager: runtimeOptions.sessionManager,
        sessionStartEvent: runtimeOptions.sessionStartEvent,
      })
    )
    yield* Effect.sync(() => {
      work.bindSession(result.session)
    })
    return { ...result, services, diagnostics: services.diagnostics }
  })

const disposeRuntime = (runtime: AgentRuntime): Effect.Effect<void, never> =>
  fromPromise('Cannot dispose Pi runtime', () => runtime.dispose()).pipe(Effect.orDie)

const runInteractive = (api: PiApi, runtime: AgentRuntime): Effect.Effect<void, LauncherError> =>
  fromPromise('Pi interactive mode failed', () =>
    new api.InteractiveMode(runtime, { startupDiagnostics: [...runtime.diagnostics] }).run()
  )

interface SignalHandlers {
  readonly remove: () => void
}

const installSignalHandlers = (
  runtime: AgentRuntime,
  release: Effect.Effect<void, never>
): Effect.Effect<SignalHandlers> =>
  Effect.sync(() => {
    const terminate = async (): Promise<void> => {
      try {
        await Effect.runPromise(disposeRuntime(runtime))
      } catch (error) {
        process.stderr.write(`${messageOf(error)}\n`)
      } finally {
        try {
          await Effect.runPromise(release)
        } catch (error) {
          process.stderr.write(`${messageOf(error)}\n`)
        }
        process.exitCode = 1
        process.exit(1)
      }
    }
    const onSignal = (): void => {
      void terminate()
    }
    process.once('SIGTERM', onSignal)
    process.once('SIGINT', onSignal)
    process.once('SIGHUP', onSignal)
    return {
      remove: () => {
        process.removeListener('SIGTERM', onSignal)
        process.removeListener('SIGINT', onSignal)
        process.removeListener('SIGHUP', onSignal)
      },
    }
  })

const run = Effect.gen(function* () {
  const options = yield* parseArgs(process.argv.slice(2))
  if (options.help) return yield* printHelp()
  const dataHome = options.dataHome ?? (yield* defaultDataHome)
  const root = yield* gitRoot(options.cwd)
  const selection = yield* resolveSelection({
    cwd: options.cwd,
    dataHome,
    explicit: options.specialization,
  }).pipe(
    Effect.mapError(error => toLauncherError(error, 'Cannot resolve specialization selection'))
  )
  if (options.saveSpecialization !== undefined) {
    yield* getSpecialization(options.saveSpecialization).pipe(
      Effect.mapError(error => toLauncherError(error, 'Cannot validate specialization preference'))
    )
    const path = yield* saveSelection({
      cwd: options.cwd,
      dataHome,
      specialization: options.saveSpecialization,
    }).pipe(
      Effect.mapError(error => toLauncherError(error, 'Cannot save specialization preference'))
    )
    yield* Effect.sync(() => {
      process.stdout.write(`saved specialization ${options.saveSpecialization} at ${path}\n`)
    })
    if (
      options.specialization === undefined &&
      options.resume === undefined &&
      !options.continueSession &&
      !options.diagnostics
    )
      return
  }
  const { api, packageInfo } = yield* loadPi.pipe(
    Effect.mapError(error => toLauncherError(error, 'Cannot load Pi'))
  )
  const sessionsPath = yield* sessionDir(dataHome).pipe(
    Effect.mapError(error => toLauncherError(error, 'Cannot prepare session directory'))
  )
  const sessions = yield* fromSync('Cannot create Pi session manager', () => {
    if (options.resume !== undefined)
      return api.SessionManager.open(options.resume, sessionsPath, options.cwd)
    if (options.continueSession) return api.SessionManager.continueRecent(options.cwd, sessionsPath)
    return api.SessionManager.create(options.cwd, sessionsPath)
  })
  const recorded =
    options.resume !== undefined || options.continueSession
      ? specializationFromSession(sessions)
      : undefined
  const selectedName = recorded ?? selection.specialization
  if (
    (options.resume !== undefined || options.continueSession) &&
    recorded === undefined &&
    options.specialization === undefined
  )
    return yield* new LauncherError({
      message:
        'This conversation has no dev specialization metadata. Resume it with an explicit --specialization choice.',
    })
  const specialization = yield* getSpecialization(selectedName).pipe(
    Effect.mapError(error => toLauncherError(error, 'Cannot load selected specialization'))
  )
  const resources = yield* composeResources({
    cwd: options.cwd,
    gitRoot: root,
    specialization,
  }).pipe(
    Effect.mapError(error => toLauncherError(error, 'Cannot compose specialization resources'))
  )
  if (options.diagnostics) {
    const dispatch = yield* readDispatch.pipe(
      Effect.mapError(error => toLauncherError(error, 'Cannot read dispatch configuration'))
    )
    yield* Effect.sync(() => {
      process.stdout.write(
        `cwd: ${options.cwd}\npi: ${packageInfo.version} (${packageInfo.root})\ndata home: ${dataHome}\ndispatch: ${dispatch.path}\nselection: ${selectedName} (${recorded === undefined ? selection.source : 'conversation metadata'})\n`
      )
      process.stdout.write(
        `SOUL.md: ${resources.soulPath}\nresource paths:\n${resourceSummary(resources)}\n`
      )
    })
    return
  }
  const context = yield* Effect.context<FileSystem.FileSystem>()
  const createRuntimeFactory: RuntimeFactory = runtimeOptions =>
    Effect.runPromiseWith(context)(
      createRuntime(api, dataHome, specialization, options, runtimeOptions)
    )
  const sessionProgram = Effect.scoped(
    Effect.gen(function* () {
      const runtime = yield* Effect.acquireRelease(
        fromPromise('Cannot create Pi runtime', () =>
          api.createAgentSessionRuntime(createRuntimeFactory, {
            cwd: options.cwd,
            agentDir: globalPiAgentDir(),
            sessionManager: sessions,
          })
        ),
        disposeRuntime
      )
      yield* fromSync('Pi startup diagnostics failed', () =>
        validateDiagnostics(runtime.services, specialization, resources, options.probeRuntime)
      )
      if (recorded === undefined)
        yield* Effect.sync(() => {
          sessions.appendCustomEntry('dev/specialization', {
            version: 1,
            specialization: specialization.name,
            source: selection.source,
          })
        })
      if (options.probeRuntime) {
        yield* Effect.sync(() => {
          process.stdout.write('runtime probe: ok\n')
        })
        return
      }
      const lease = yield* Effect.acquireRelease(acquireRuntime(dataHome), value =>
        value.release.pipe(Effect.orDie)
      )
      const release = lease.release.pipe(Effect.orDie)
      yield* Effect.acquireRelease(installSignalHandlers(runtime, release), ({ remove }) =>
        Effect.sync(remove)
      )
      yield* runInteractive(api, runtime)
    })
  )
  yield* sessionProgram
})

const program = run.pipe(
  Effect.catch(error =>
    Effect.sync(() => {
      process.stderr.write(`${messageOf(error)}\n`)
      process.exitCode = 1
    })
  ),
  Effect.provide(NodeServices.layer)
)

NodeRuntime.runMain(program, { disableErrorReporting: true })
