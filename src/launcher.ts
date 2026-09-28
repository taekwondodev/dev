#!/usr/bin/env node
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { Cause, Deferred, Effect, Exit, Option, Schema, Scope } from 'effect'
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
import { findRecentSession, loadPi, loadPiPathResolver, type PiApi } from './pi-runtime.ts'
import { createWorkExtension } from './work-extension.ts'
import { readDispatch } from './work-dispatch.ts'
import { acquireRuntime } from './runtime-coordination.ts'
import { createSessionGuard } from './session-guard.ts'
import { makeWorkspaceLifecycle } from './workspace-lifecycle.ts'
import type { WorkspaceAssessment, WorkspaceId, WorkspaceLifecycle } from './workspace-domain.ts'
import {
  keptConversationGuidance,
  makeWorkspaceHost,
  noUiTrustContext,
  sameConversation,
  type GuidedRelease,
  type WorkspaceHost,
} from './workspace-host.ts'
import {
  parseWorkspaceCommand,
  runReadOnlyWorkspaceCommand,
  chooseResumeCandidate,
  formatAssessments,
  formatReleaseRun,
  releaseConfirmation,
  releaseExitCode,
  runRelease,
  type ReleaseRun,
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
      `dev — Pi development environment\n\nUsage: dev [options]\n       dev [options] workspace [list | inspect <task> | check <task> | release <task> | resume <task> [--workspace <workspace>]]\n\nOptions:\n  --cwd PATH                    launch from PATH\n  --profile NAME        temporary profile (${profileNames().join(' | ')})\n  --save-profile NAME   explicitly save a repository/directory preference\n  --resume PATH                resume a Pi JSONL session\n  --continue                    resume the newest session for this launch directory\n  --data-home PATH             dedicated dev data home\n  --diagnostics                resolve dependencies and print composition\n  --probe-runtime              exercise SDK startup without opening the TUI\n  --help                       show this help\n\nWorkspace commands:\n  workspace [list]             list workspaces for the Git repository at --cwd\n  workspace inspect <task>     inspect all exact-task records across repositories\n  workspace check <task>       read-only release eligibility of every workspace of the task\n  workspace release <task>     confirm interactively, then one release attempt per workspace\n  workspace resume <task> [--workspace <id>]  start a fresh conversation on a retained workspace\n`
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
      workspace: { lifecycle, attachment, requestRebind: workspaceHost.requestRebind },
      isWorkspaceParked: workspaceHost.isParked,
    })
  )
  yield* Effect.sync(() => workspaceHost.setWorkControls(work))
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

// Pi's loop never returns and its quit exits the process, so a guided release races it
// (ADR 0005, Release).
const runInteractive = (
  api: PiApi,
  runtime: AgentRuntime,
  host: WorkspaceHost
): Effect.Effect<GuidedRelease | undefined, LauncherError> =>
  Effect.gen(function* () {
    const mode = new api.InteractiveMode(runtime, { startupDiagnostics: [...runtime.diagnostics] })
    const closure = yield* Effect.raceFirst(
      fromPromise('Pi interactive mode failed', () => mode.run()).pipe(Effect.as(undefined)),
      Deferred.await(host.guidedRelease)
    )
    if (closure !== undefined)
      yield* Effect.sync(() => {
        mode.stop()
      })
    return closure
  })

type ReleaseExitCode = ReturnType<typeof releaseExitCode> | 130

const exitText = (code: ReleaseExitCode): string => {
  switch (code) {
    case 0:
      return 'done'
    case 1:
      return 'at least one workspace did not reach a terminal outcome'
    case 130:
      return 'interrupted; no workspace was attempted after the signal'
  }
}

// Uninterruptible so that a signal only withdraws unstarted workspaces (ADR 0005, Release).
const attemptRelease = Effect.fnUntraced(function* (
  lifecycle: WorkspaceLifecycle,
  input: {
    readonly taskId: WorkspaceId
    readonly confirmed: readonly WorkspaceAssessment[]
    readonly occupiedCwds: readonly string[]
    readonly commandId?: WorkspaceId
  },
  epilogue: string,
  proceed: () => boolean
): Effect.fn.Return<{ readonly run: ReleaseRun; readonly code: ReleaseExitCode }> {
  const run = yield* runRelease(lifecycle, { ...input, proceed })
  const code: ReleaseExitCode = proceed() ? releaseExitCode(run) : 130
  yield* write(formatReleaseRun(input.taskId, run))
  yield* write(`Exit ${code}: ${exitText(code)}.${epilogue}`)
  return { run, code }
}, Effect.uninterruptible)

// The attachment is said closed only when its close completed; the attempt rechecks every use
// either way.
const tuiClosedNotice = (request: GuidedRelease, detached: boolean): string =>
  `\nThe TUI is closed and its work was stopped; ${detached ? 'its workspace attachment is closed' : 'closing its workspace attachment was not confirmed, so the release rechecks every use'}. ${keptConversationGuidance(request.conversationFile)}`
// After the handover the shell always hears what became of the TUI, even when its teardown
// failed or a signal ended it before the attempt.
const handoverNotice = (
  request: GuidedRelease,
  detached: boolean,
  cause: Cause.Cause<unknown>
): string => {
  const retry = `Nothing was released. Run dev workspace release ${request.taskId} for a fresh attempt.`
  return Cause.hasInterruptsOnly(cause)
    ? `${tuiClosedNotice(request, detached)}\nThe release of task ${request.taskId} was interrupted before its attempt started. ${retry}\nExit 130: ${exitText(130)}.`
    : `${tuiClosedNotice(request, detached)}\nClosing its session then failed (${errorText(Cause.squash(cause))}), so its workspace use may still be recorded. ${retry}\nExit 1.`
}

// Runs only after the Pi runtime, its attachment and the host closed. Exported for the TUI probe.
export const completeGuidedRelease = Effect.fnUntraced(function* (
  lifecycle: WorkspaceLifecycle,
  request: GuidedRelease,
  completion: {
    readonly returnCwd: string
    readonly proceed: () => boolean
    readonly detached: boolean
  }
): Effect.fn.Return<ReleaseRun> {
  const { returnCwd, proceed, detached } = completion
  yield* Effect.sync(() => {
    try {
      process.chdir(returnCwd)
    } catch {
      /* the recorded return cwd is still reported as occupied below */
    }
  })
  yield* write(
    `${tuiClosedNotice(request, detached)}\nAttempting the confirmed release of task ${request.taskId}...`
  )
  const { run, code } = yield* attemptRelease(
    lifecycle,
    {
      taskId: request.taskId,
      confirmed: request.confirmed,
      occupiedCwds: [resolve(returnCwd)],
      commandId: request.commandId,
    },
    ' Do not resume into a removed workspace; the conversation file above keeps its history.',
    proceed
  )
  process.exitCode = code
  return run
})

const reported = (effect: Effect.Effect<void>): Effect.Effect<void> =>
  Effect.catchCause(effect, cause =>
    Effect.sync(() => {
      process.stderr.write(`${errorText(Cause.squash(cause))}\n`)
    })
  )

interface SignalHandlers {
  readonly remove: () => void
}

const installSignalHandlers = (
  runtime: AgentRuntime,
  release: Effect.Effect<void, never>
): Effect.Effect<SignalHandlers> =>
  Effect.sync(() => {
    const terminate = (exitCode: number): void => {
      Effect.runFork(
        reported(disposeRuntime(runtime)).pipe(
          Effect.andThen(reported(release)),
          Effect.andThen(
            Effect.sync(() => {
              process.exitCode = exitCode
              process.exit(exitCode)
            })
          )
        )
      )
    }
    const onInterrupt = (): void => terminate(130)
    const onTerminate = (): void => terminate(1)
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

// A line editor, so the answer is echoed and editable. Ctrl-C, Ctrl-Z, or Ctrl-D on an empty
// line cancels; with a SIGTSTP listener readline never suspends the prompt.
const askConfirmation = (prompt: string): Effect.Effect<boolean> =>
  Effect.callback<boolean>(resume => {
    const reader = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    let answered = false
    const answer = (confirmed: boolean): void => {
      if (answered) return
      answered = true
      reader.close()
      resume(Effect.succeed(confirmed))
    }
    const cancel = (): void => {
      if (answered) return
      process.stdout.write('(cancelled)\n')
      answer(false)
    }
    reader.on('SIGINT', cancel)
    reader.on('SIGTSTP', cancel)
    reader.on('close', cancel)
    reader.question(prompt, line => answer(line.trim() === 'y'))
    return Effect.sync(() => reader.close())
  })

const cancellation = Effect.acquireRelease(
  Effect.sync(() => {
    let cancelled = false
    const onSignal = (): void => {
      cancelled = true
      process.stderr.write(
        '\nCancellation requested: workspaces not yet started are skipped; one already under way is observed to its recorded outcome.\n'
      )
    }
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
    return { proceed: () => !cancelled, onSignal }
  }),
  ({ onSignal }) =>
    Effect.sync(() => {
      process.removeListener('SIGINT', onSignal)
      process.removeListener('SIGTERM', onSignal)
    })
)

const write = (text: string, stream: NodeJS.WriteStream = process.stdout): Effect.Effect<void> =>
  Effect.sync(() => {
    stream.write(`${text}\n`)
  })

const terminalRelease = Effect.fnUntraced(function* (
  dependencies: LauncherDependencies,
  taskId: WorkspaceId,
  launchCwd: string
): Effect.fn.Return<ReleaseExitCode, never, Scope.Scope> {
  const lifecycle = yield* dependencies.workspaceLifecycle
  const assessed = yield* Effect.exit(lifecycle.check({ taskId }))
  if (Exit.isFailure(assessed)) {
    yield* write(
      `Workspace assessment failed; nothing was released: ${errorText(Cause.squash(assessed.cause))}`,
      process.stderr
    )
    return 1
  }
  const assessments = assessed.value
  if (assessments.length === 0) {
    yield* write(`No workspace records exist for exact task ${taskId}.`, process.stderr)
    return 1
  }
  yield* write(formatAssessments(taskId, assessments))
  const confirmation = releaseConfirmation(taskId, assessments, undefined)
  yield* write(`\n${confirmation.message}\n`)
  const confirmed = yield* askConfirmation(
    `${confirmation.title} Type y to release, anything else to cancel: `
  )
  if (!confirmed) {
    yield* write('Release cancelled before confirmation; nothing was changed.')
    return 130
  }
  const cancel = yield* cancellation
  const { code } = yield* attemptRelease(
    lifecycle,
    {
      taskId,
      confirmed: assessments,
      occupiedCwds: [resolve(process.cwd()), resolve(launchCwd)],
    },
    '',
    cancel.proceed
  )
  return code
})

const run = Effect.fnUntraced(function* (
  argv: readonly string[],
  dependencies: LauncherDependencies
) {
  const options = yield* parseArgs(argv)
  if (options.help) return yield* printHelp()

  let workspaceLifecycle: WorkspaceLifecycle | undefined
  let workspaceResume: Effect.Success<ReturnType<typeof chooseResumeCandidate>> | undefined
  if (options.workspaceArgs !== undefined) {
    const command = yield* parseWorkspaceCommand(options.workspaceArgs)
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
    if (command.kind !== 'resume' && command.kind !== 'release') {
      const result = yield* runReadOnlyWorkspaceCommand(dependencies.workspaceLifecycle, command, {
        repositoryRoot: gitRoot(options.cwd),
      })
      yield* Effect.sync(() => {
        ;(result.exitCode === 0 ? process.stdout : process.stderr).write(`${result.text}\n`)
        process.exitCode = result.exitCode
      })
      return
    }
    if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
      yield* Effect.sync(() => {
        process.stderr.write(
          command.kind === 'release'
            ? 'Workspace release requires an interactive TTY for its confirmation; nothing was released and no unattended mode exists.\n'
            : 'Workspace resume requires an interactive TTY; it never falls back to a silent workspace switch.\n'
        )
        process.exitCode = 2
      })
      return
    }
    if (command.kind === 'release') {
      process.exitCode = yield* terminalRelease(dependencies, command.taskId, options.cwd)
      return
    }
    workspaceLifecycle = yield* dependencies.workspaceLifecycle
    const views = yield* workspaceLifecycle
      .inspect({ taskId: command.taskId })
      .pipe(
        Effect.mapError(error =>
          toLauncherError(error, 'Cannot inspect retained workspace candidates')
        )
      )
    workspaceResume = yield* chooseResumeCandidate(views, command.taskId, command.workspaceId)
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
  const { api, packageInfo } = yield* loadPi
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
            message: `Cannot attach this conversation to a workspace: ${error.message}\n${keptConversationGuidance(sessionFile)}`,
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
  const resolveImportPath = yield* loadPiPathResolver(packageInfo.root)
  const workspaceHost = yield* makeWorkspaceHost({
    lifecycle: workspaceLifecycle,
    attachment,
    dataHome,
    openSessionManager: (file, cwdOverride) =>
      api.SessionManager.open(file, sessionsPath, cwdOverride),
    repositoryRoot: gitRoot,
    resolveImportPath,
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
  const returnCwd = process.cwd()
  const outerScope = yield* Effect.scope
  // Set when the TUI hands a confirmed guided release over. From then on a signal withdraws the
  // confirmed workspaces, and one that lands before the attempt starts still gets a notice.
  let handover: { readonly request: GuidedRelease; readonly proceed: () => boolean } | undefined
  let attemptStarted = false
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
      const signals = yield* Effect.acquireRelease(
        installSignalHandlers(runtime, release),
        ({ remove }) => Effect.sync(remove)
      )
      const request = yield* runInteractive(api, runtime, workspaceHost)
      if (request !== undefined) {
        // The TUI's own handlers would exit without a word during the teardown that follows.
        signals.remove()
        const { proceed } = yield* Scope.provide(outerScope)(cancellation)
        handover = { request, proceed }
      }
    })
  )
  return yield* Effect.gen(function* () {
    yield* sessionProgram
    if (handover === undefined) return false
    const { request, proceed } = handover
    yield* Effect.uninterruptible(
      Effect.sync(() => {
        attemptStarted = true
      }).pipe(
        Effect.andThen(
          completeGuidedRelease(workspaceLifecycle, request, {
            returnCwd,
            proceed,
            detached: workspaceHost.isDetached(),
          })
        )
      )
    )
    return true
  }).pipe(
    Effect.onExit(exit =>
      handover === undefined || attemptStarted || Exit.isSuccess(exit)
        ? Effect.void
        : write(handoverNotice(handover.request, workspaceHost.isDetached(), exit.cause))
    )
  )
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
        return false
      })
    ),
    // The stopped TUI may still hold Pi timers, so a guided release exits explicitly.
    Effect.tap(guided =>
      guided === true ? Effect.sync(() => process.exit(process.exitCode ?? 0)) : Effect.void
    ),
    Effect.asVoid,
    Effect.provide(NodeServices.layer)
  )

if (import.meta.main)
  NodeRuntime.runMain(launch(process.argv.slice(2)), { disableErrorReporting: true })
