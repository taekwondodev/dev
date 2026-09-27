#!/usr/bin/env node
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Effect, Option, Schema, type Scope } from 'effect'
import type * as FileSystem from 'effect/FileSystem'
import type { AgentSessionServices, InlineExtension } from '@earendil-works/pi-coding-agent'
import {
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
  getProfile,
  resourceSummary,
  profileNames,
  type ComposedResources,
  type Profile,
} from './profiles.ts'
import { errorText } from './error-text.ts'
import { findRecentSession, loadPi, type PiApi } from './pi-runtime.ts'
import { createWorkExtension } from './work-extension.ts'
import { readDispatch } from './work-dispatch.ts'
import { acquireRuntime } from './runtime-coordination.ts'
import { createSessionGuard } from './session-guard.ts'
import { makeWorkspaceLifecycle } from './workspace-lifecycle.ts'
import type { WorkspaceLifecycle } from './workspace-domain.ts'
import {
  makeWorkspaceHost,
  noUiTrustContext,
  sameConversation,
  workControlsOf,
  type WorkspaceHost,
} from './workspace-host.ts'
import {
  parseWorkspaceCommand,
  runReadOnlyWorkspaceCommand,
  chooseResumeCandidate,
  type WorkspaceCommand,
} from './workspace-command.ts'
import type * as PiProjectTrust from '../node_modules/@earendil-works/pi-coding-agent/dist/core/project-trust.js'

export class LauncherError extends Schema.TaggedError<LauncherError>()('LauncherError', {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

interface LaunchOptions {
  readonly cwd: string
  readonly dataHome?: string
  readonly profile?: string
  readonly saveProfile?: string
  readonly resume?: string
  readonly continueSession: boolean
  readonly diagnostics: boolean
  readonly probeRuntime: boolean
  readonly help: boolean
  readonly workspaceArgs?: readonly string[]
}

type RuntimeFactory = Parameters<PiApi['createAgentSessionRuntime']>[0]
type RuntimeFactoryOptions = Parameters<RuntimeFactory>[0]
type RuntimeFactoryResult = Awaited<ReturnType<RuntimeFactory>>
type AgentRuntime = Awaited<ReturnType<PiApi['createAgentSessionRuntime']>>
type ModelRuntime = Awaited<ReturnType<PiApi['ModelRuntime']['create']>>
type SessionModel = Parameters<PiApi['createAgentSessionFromServices']>[0]['model']
type SessionGuard = ReturnType<typeof createSessionGuard>
type NamedExtension = Extract<InlineExtension, { readonly factory: unknown }>
type SessionManager = RuntimeFactoryOptions['sessionManager']
type SessionEntry = ReturnType<SessionManager['getEntries']>[number]
type CustomSessionEntry = Extract<SessionEntry, { type: 'custom' }>

const SessionProfileSchema = Schema.Struct({
  profile: Schema.String,
})

const toLauncherError = (error: unknown, operation: string): LauncherError =>
  error instanceof LauncherError
    ? error
    : new LauncherError({ message: `${operation}: ${errorText(error)}`, cause: error })

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
        profile?: string
        saveProfile?: string
        resume?: string
        continueSession: boolean
        diagnostics: boolean
        probeRuntime: boolean
        help: boolean
        workspaceArgs?: readonly string[]
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
        else if (arg === '--profile') values.profile = nextArgument(argv, ++index, arg)
        else if (arg === '--save-profile') values.saveProfile = nextArgument(argv, ++index, arg)
        else if (arg === '--resume') values.resume = resolve(nextArgument(argv, ++index, arg))
        else if (arg === '--continue') values.continueSession = true
        else if (arg === '--diagnostics') values.diagnostics = true
        else if (arg === '--probe-runtime') values.probeRuntime = true
        else if (arg === '--help') values.help = true
        else if (arg === 'workspace') {
          values.workspaceArgs = argv.slice(index + 1)
          break
        } else throw new Error(`Unknown option ${arg}. Use --help.`)
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
      `dev — Pi development environment\n\nUsage: dev [options]\n       dev [options] workspace [list | inspect <task> | resume <task> [--workspace <workspace>]]\n\nOptions:\n  --cwd PATH                    launch from PATH\n  --profile NAME        temporary profile (${profileNames().join(' | ')})\n  --save-profile NAME   explicitly save a repository/directory preference\n  --resume PATH                resume a Pi JSONL session\n  --continue                    resume the newest session for this launch directory\n  --data-home PATH             dedicated dev data home\n  --diagnostics                resolve dependencies and print composition\n  --probe-runtime              exercise SDK startup without opening the TUI\n  --help                       show this help\n\nWorkspace commands:\n  workspace [list]             list workspaces for the Git repository at --cwd\n  workspace inspect <task>     inspect all exact-task records across repositories\n  workspace resume <task> [--workspace <id>]  start a fresh conversation on a retained workspace\n`
    )
  })

const profileFromSession = (sessions: SessionManager): string | undefined => {
  const entry = sessions
    .getEntries()
    .findLast(
      (candidate): candidate is CustomSessionEntry =>
        candidate.type === 'custom' && candidate.customType === 'dev/profile'
    )
  if (entry === undefined) return undefined
  return Option.getOrUndefined(Schema.decodeUnknownOption(SessionProfileSchema)(entry.data))
    ?.profile
}

const validateDiagnostics = (
  services: AgentSessionServices,
  profile: Profile,
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
      `Pi startup cannot continue for profile "${profile.name}":\n${errors.join('\n')}`
    )
  if (verbose) {
    const { skills } = services.resourceLoader.getSkills()
    process.stdout.write(`profile: ${profile.name}\nskills loaded: ${skills.length}\n`)
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

// The offline probes replace the model and observe dev's extensions; the launcher leaves the
// model to Pi's settings.
export interface RuntimeParts {
  readonly api: PiApi
  readonly packageRoot: string
  readonly dataHome: string
  readonly profile: Profile
  readonly guard: SessionGuard
  readonly workspaceHost: WorkspaceHost
  readonly lifecycle: WorkspaceLifecycle
  readonly modelRuntime?: Effect.Effect<ModelRuntime, LauncherError>
  readonly model?: SessionModel
  readonly extensions?: (dev: readonly NamedExtension[], cwd: string) => readonly InlineExtension[]
}

const createRuntime = Effect.fnUntraced(function* (
  parts: RuntimeParts,
  runtimeOptions: RuntimeFactoryOptions
): Effect.fn.Return<RuntimeFactoryResult, LauncherError, FileSystem.FileSystem> {
  const { api, packageRoot, dataHome, profile, guard, workspaceHost, lifecycle } = parts
  const { attachment, cwd, sessionManager } = yield* workspaceHost
    .prepareRuntime({ sessionManager: runtimeOptions.sessionManager, cwd: runtimeOptions.cwd })
    .pipe(
      Effect.mapError(error =>
        toLauncherError(error, 'Cannot resolve workspace binding before Pi startup')
      )
    )
  yield* guard
    .protect(sessionManager)
    .pipe(Effect.mapError(error => toLauncherError(error, 'Cannot claim Pi conversation')))
  const resources = yield* composeResources({
    cwd,
    gitRoot: yield* gitRoot(cwd),
    profile,
  }).pipe(Effect.mapError(error => toLauncherError(error, 'Cannot compose runtime resources')))
  const work = yield* fromSync('Cannot create background-work extension', () =>
    createWorkExtension({
      dataHome,
      profile: profile.name,
      workspace: { lifecycle, attachment },
      isWorkspaceParked: workspaceHost.isParked,
    })
  )
  yield* Effect.sync(() => workspaceHost.setWorkControls(workControlsOf(work)))
  const trustResolver: typeof PiProjectTrust = yield* fromPromise(
    'Cannot load Pi project-trust resolver',
    async () =>
      import(pathToFileURL(resolve(packageRoot, 'dist/core/project-trust.js')).href) as Promise<
        typeof PiProjectTrust
      >
  )
  const settingsManager = yield* fromSync('Cannot create trust-gated Pi settings', () =>
    api.SettingsManager.create(cwd, runtimeOptions.agentDir, { projectTrusted: false })
  )
  const trustStore = new api.ProjectTrustStore(runtimeOptions.agentDir)
  const projectTrustContext =
    runtimeOptions.projectTrustContext?.cwd === cwd
      ? runtimeOptions.projectTrustContext
      : noUiTrustContext(cwd)
  const modelRuntime = yield* (
    parts.modelRuntime ??
      fromPromise('Cannot create Pi model runtime', () =>
        api.ModelRuntime.create({ authPath: globalPiAuthPath() })
      )
  )
  const extensions: readonly NamedExtension[] = [
    { name: 'dev:session-guard', factory: guard.factory },
    { name: 'dev:work', factory: work.factory },
    { name: 'dev:workspace-host', factory: workspaceHost.extensionFactory },
  ]
  const services = yield* fromPromise('Cannot create Pi session services', () =>
    api.createAgentSessionServices({
      cwd,
      agentDir: runtimeOptions.agentDir,
      settingsManager,
      modelRuntime,
      resourceLoaderOptions: {
        additionalSkillPaths: [...resources.skillPaths],
        appendSystemPrompt: [profile.guidance],
        extensionFactories: [...(parts.extensions?.(extensions, cwd) ?? extensions)],
      },
      resourceLoaderReloadOptions: {
        resolveProjectTrust: ({ extensionsResult }) =>
          trustResolver.resolveProjectTrusted({
            cwd,
            trustStore,
            defaultProjectTrust: settingsManager.getDefaultProjectTrust(),
            extensionsResult,
            projectTrustContext,
          }),
      },
    })
  )
  const result = yield* fromPromise('Cannot create Pi session', () =>
    api.createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent: runtimeOptions.sessionStartEvent,
      ...(parts.model === undefined ? {} : { model: parts.model }),
      customTools: [
        api.defineTool(
          api.createBashToolDefinition(cwd, {
            operations: workspaceHost.shellOperations,
            commandPrefix: settingsManager.getShellCommandPrefix(),
          })
        ),
        api.defineTool(
          api.createWriteToolDefinition(cwd, { operations: workspaceHost.writeOperations })
        ),
        api.defineTool(
          api.createEditToolDefinition(cwd, { operations: workspaceHost.editOperations })
        ),
      ],
    })
  )
  yield* workspaceHost
    .commitRuntime(attachment)
    .pipe(
      Effect.mapError(error => toLauncherError(error, 'Cannot commit workspace runtime binding'))
    )
  yield* Effect.sync(() => {
    work.bindSession(result.session)
  })
  return { ...result, services, diagnostics: services.diagnostics }
})

export const makeRuntimeFactory = (
  parts: RuntimeParts
): Effect.Effect<RuntimeFactory, never, FileSystem.FileSystem> =>
  Effect.map(
    Effect.context<FileSystem.FileSystem>(),
    context => runtimeOptions =>
      Effect.runPromiseWith(context)(createRuntime(parts, runtimeOptions))
  )

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
    const terminate = async (exitCode: number): Promise<void> => {
      try {
        await Effect.runPromise(disposeRuntime(runtime))
      } catch (error) {
        process.stderr.write(`${errorText(error)}\n`)
      } finally {
        try {
          await Effect.runPromise(release)
        } catch (error) {
          process.stderr.write(`${errorText(error)}\n`)
        }
        process.exitCode = exitCode
        process.exit(exitCode)
      }
    }
    const onInterrupt = (): void => {
      void terminate(130)
    }
    const onTerminate = (): void => {
      void terminate(1)
    }
    process.once('SIGTERM', onTerminate)
    process.once('SIGINT', onInterrupt)
    process.once('SIGHUP', onTerminate)
    return {
      remove: () => {
        process.removeListener('SIGTERM', onTerminate)
        process.removeListener('SIGINT', onInterrupt)
        process.removeListener('SIGHUP', onTerminate)
      },
    }
  })

// Besides `makeRuntimeFactory`, the only way to supply another authority than the fixed one of
// ADR 0003.
export interface LauncherDependencies {
  readonly workspaceLifecycle: Effect.Effect<WorkspaceLifecycle, never, Scope.Scope>
}

const run = Effect.fnUntraced(function* (
  argv: readonly string[],
  dependencies: LauncherDependencies
) {
  const options = yield* parseArgs(argv)
  if (options.help) return yield* printHelp()

  let workspaceCommand: WorkspaceCommand | undefined
  let workspaceLifecycle: WorkspaceLifecycle | undefined
  let workspaceResume: Effect.Success<ReturnType<typeof chooseResumeCandidate>> | undefined
  if (options.workspaceArgs !== undefined) {
    workspaceCommand = yield* parseWorkspaceCommand(options.workspaceArgs)
    if (
      options.saveProfile !== undefined ||
      options.resume !== undefined ||
      options.continueSession ||
      options.diagnostics ||
      options.probeRuntime
    ) {
      yield* Effect.sync(() => {
        process.stderr.write(
          `workspace commands cannot be combined with --save-profile, --resume, --continue, --diagnostics, or --probe-runtime.\n`
        )
        process.exitCode = 2
      })
      return
    }
    if (workspaceCommand.kind !== 'resume') {
      const listRoot = workspaceCommand.kind === 'list' ? yield* gitRoot(options.cwd) : undefined
      if (workspaceCommand.kind === 'list' && listRoot === undefined) {
        yield* Effect.sync(() => {
          process.stderr.write(
            `Workspace list requires a Git repository; pass --cwd PATH to a Git checkout.\n`
          )
          process.exitCode = 2
        })
        return
      }
      workspaceLifecycle = yield* dependencies.workspaceLifecycle
      const result = yield* runReadOnlyWorkspaceCommand(
        workspaceLifecycle,
        workspaceCommand as Exclude<WorkspaceCommand, { readonly kind: 'resume' }>,
        workspaceCommand!.kind === 'list' ? { cwd: listRoot } : {}
      )
      yield* Effect.sync(() => {
        if (result.stdout !== undefined) process.stdout.write(`${result.stdout}\n`)
        if (result.stderr !== undefined) process.stderr.write(`${result.stderr}\n`)
        process.exitCode = result.exitCode
      })
      return
    }
    if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
      yield* Effect.sync(() => {
        process.stderr.write(
          `Workspace resume requires an interactive TTY; it never falls back to a silent workspace switch.\n`
        )
        process.exitCode = 2
      })
      return
    }
    workspaceLifecycle = yield* dependencies.workspaceLifecycle
    const resumeCommand = workspaceCommand as Extract<WorkspaceCommand, { readonly kind: 'resume' }>
    const views = yield* workspaceLifecycle
      .inspect({ taskId: resumeCommand.taskId })
      .pipe(
        Effect.mapError(error =>
          toLauncherError(error, 'Cannot inspect retained workspace candidates')
        )
      )
    workspaceResume = yield* chooseResumeCandidate(
      views,
      resumeCommand.taskId,
      resumeCommand.workspaceId
    )
  }

  const launchCwd = workspaceResume?.view.path ?? options.cwd
  const dataHome = options.dataHome ?? (yield* defaultDataHome)
  const root = yield* gitRoot(launchCwd)
  const selection = yield* resolveSelection({
    cwd: launchCwd,
    dataHome,
    explicit: options.profile,
  }).pipe(Effect.mapError(error => toLauncherError(error, 'Cannot resolve profile selection')))
  if (options.saveProfile !== undefined) {
    yield* getProfile(options.saveProfile).pipe(
      Effect.mapError(error => toLauncherError(error, 'Cannot validate profile preference'))
    )
    const path = yield* saveSelection({
      cwd: options.cwd,
      dataHome,
      profile: options.saveProfile,
    }).pipe(Effect.mapError(error => toLauncherError(error, 'Cannot save profile preference')))
    yield* Effect.sync(() => {
      process.stdout.write(`saved profile ${options.saveProfile} at ${path}\n`)
    })
    if (
      options.profile === undefined &&
      options.resume === undefined &&
      !options.continueSession &&
      !options.diagnostics
    )
      return
  }
  const lease = yield* acquireRuntime(dataHome)
  const guard = createSessionGuard(lease)
  const { api, packageInfo } = yield* loadPi.pipe(
    Effect.mapError(error => toLauncherError(error, 'Cannot load Pi'))
  )
  const sessionsPath = yield* sessionDir(dataHome).pipe(
    Effect.mapError(error => toLauncherError(error, 'Cannot prepare session directory'))
  )
  const resumedPath =
    options.resume ??
    (options.continueSession
      ? yield* findRecentSession(packageInfo.root, launchCwd, sessionsPath)
      : undefined)
  if (resumedPath !== undefined) yield* lease.protect({ path: resumedPath })
  let sessions = yield* fromSync('Cannot create Pi session manager', () =>
    resumedPath === undefined
      ? api.SessionManager.create(launchCwd, sessionsPath)
      : api.SessionManager.open(resumedPath, sessionsPath, launchCwd)
  )
  if (!options.diagnostics) yield* guard.protect(sessions)
  const recorded =
    options.resume !== undefined || options.continueSession
      ? profileFromSession(sessions)
      : undefined

  if (
    (options.resume !== undefined || options.continueSession) &&
    recorded === undefined &&
    options.profile === undefined
  )
    return yield* new LauncherError({
      message:
        'This conversation has no dev profile metadata. Resume it with an explicit --profile choice.',
    })
  if (options.diagnostics) {
    const diagnosticProfile = yield* getProfile(recorded ?? selection.profile).pipe(
      Effect.mapError(error => toLauncherError(error, 'Cannot load selected profile'))
    )
    const diagnosticResources = yield* composeResources({
      cwd: launchCwd,
      gitRoot: root,
      profile: diagnosticProfile,
    }).pipe(Effect.mapError(error => toLauncherError(error, 'Cannot compose profile resources')))
    const dispatch = yield* readDispatch.pipe(
      Effect.mapError(error => toLauncherError(error, 'Cannot read dispatch configuration'))
    )
    yield* Effect.sync(() => {
      process.stdout.write(
        `cwd: ${launchCwd}\npi: ${packageInfo.version} (${packageInfo.root})\ndata home: ${dataHome}\ndispatch: ${dispatch.path}\nselection: ${recorded ?? selection.profile} (${recorded === undefined ? selection.source : 'conversation metadata'})\n`
      )
      process.stdout.write(
        `SOUL.md: ${diagnosticResources.soulPath}\nresource paths:\n${resourceSummary(diagnosticResources)}\n`
      )
    })
    return
  }
  workspaceLifecycle ??= yield* dependencies.workspaceLifecycle
  const sessionFile = sessions.getSessionFile()
  if (!sessionFile)
    return yield* new LauncherError({
      message: 'Workspace-bound conversations require a persisted session file',
    })
  const sessionId = sessions.getSessionId()
  const attachment = yield* workspaceLifecycle
    .attach({
      conversation: { sessionId, sessionFile, dataHome },
      cwd: sessions.getCwd(),
      ...(workspaceResume === undefined ? {} : { selection: workspaceResume.selection }),
    })
    .pipe(
      Effect.mapError(
        error =>
          new LauncherError({
            message: `Cannot attach this conversation to a workspace: ${error.message}\nThe conversation file is unchanged and keeps its history: ${sessionFile}\nTo keep working, start a new conversation in an existing checkout: dev --cwd PATH`,
            cause: error,
          })
      )
    )
  const effectiveCwd = attachment.binding.cwd
  if (resolve(sessions.getCwd()) !== resolve(effectiveCwd)) {
    sessions = yield* fromSync('Cannot reopen Pi session at its authorized workspace cwd', () =>
      api.SessionManager.open(sessionFile, sessionsPath, effectiveCwd)
    )
    if (
      !sameConversation(
        { sessionId: sessions.getSessionId(), sessionFile: sessions.getSessionFile() },
        { sessionId, sessionFile }
      )
    )
      return yield* new LauncherError({
        message: 'Reopened Pi session changed conversation identity',
      })
  }
  const workspaceHost = yield* makeWorkspaceHost({
    lifecycle: workspaceLifecycle,
    attachment,
    dataHome,
    openSessionManager: (file, cwdOverride) =>
      api.SessionManager.open(file, sessionsPath, cwdOverride),
    repositoryRoot: gitRoot,
  })
  const effectiveSelection =
    resolve(effectiveCwd) === resolve(launchCwd)
      ? selection
      : yield* resolveSelection({ cwd: effectiveCwd, dataHome, explicit: options.profile }).pipe(
          Effect.mapError(error =>
            toLauncherError(error, 'Cannot resolve profile selection for authorized cwd')
          )
        )
  const selectedName = recorded ?? effectiveSelection.profile
  const profile = yield* getProfile(selectedName).pipe(
    Effect.mapError(error => toLauncherError(error, 'Cannot load selected profile'))
  )
  const effectiveRoot = yield* gitRoot(effectiveCwd)
  const resources = yield* composeResources({
    cwd: effectiveCwd,
    gitRoot: effectiveRoot,
    profile,
  }).pipe(Effect.mapError(error => toLauncherError(error, 'Cannot compose profile resources')))
  if (recorded === undefined)
    yield* Effect.sync(() => {
      sessions.appendCustomEntry('dev/profile', {
        version: 1,
        profile: profile.name,
        source: effectiveSelection.source,
      })
    })
  const createRuntimeFactory = yield* makeRuntimeFactory({
    api,
    packageRoot: packageInfo.root,
    dataHome,
    profile,
    guard,
    workspaceHost,
    lifecycle: workspaceLifecycle,
  })
  const sessionProgram = Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(Effect.succeed(workspaceHost), host =>
        host.close.pipe(Effect.orDie)
      )
      const runtime = yield* Effect.acquireRelease(
        fromPromise('Cannot create Pi runtime', () =>
          api.createAgentSessionRuntime(createRuntimeFactory, {
            cwd: effectiveCwd,
            agentDir: globalPiAgentDir(),
            sessionManager: sessions,
          })
        ),
        disposeRuntime
      )
      yield* Effect.sync(() => {
        workspaceHost.bindRuntime(runtime)
        guard.bind(runtime)
      })
      yield* fromSync('Pi startup diagnostics failed', () =>
        validateDiagnostics(runtime.services, profile, resources, options.probeRuntime)
      )

      if (options.probeRuntime) {
        yield* Effect.sync(() => {
          process.stdout.write('runtime probe: ok\n')
        })
        return
      }
      const release = lease.release.pipe(Effect.orDie)
      yield* Effect.acquireRelease(installSignalHandlers(runtime, release), ({ remove }) =>
        Effect.sync(remove)
      )
      yield* runInteractive(api, runtime)
    })
  )
  yield* sessionProgram
}, Effect.scoped)

export const launch = (
  argv: readonly string[],
  dependencies: LauncherDependencies = { workspaceLifecycle: makeWorkspaceLifecycle() }
) =>
  run(argv, dependencies).pipe(
    Effect.catch(error =>
      Effect.sync(() => {
        process.stderr.write(`${error.message}\n`)
        process.exitCode = error._tag === 'WorkspaceCommandError' ? error.exitCode : 1
      })
    ),
    Effect.provide(NodeServices.layer)
  )

if (import.meta.main)
  NodeRuntime.runMain(launch(process.argv.slice(2)), { disableErrorReporting: true })
