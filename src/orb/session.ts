import * as Cause from 'effect/Cause'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Scope from 'effect/Scope'
import type * as FileSystem from 'effect/FileSystem'
import type * as ChildProcessSpawner from 'effect/process/ChildProcessSpawner'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { PiApi } from '../pi-runtime.ts'
import { errorText } from '../error-text.ts'
import type { WorkRemote } from '../work-domain.ts'
import type {
  WorkspaceAttachment,
  WorkspaceGrant,
  WorkspaceLifecycle,
} from '../workspace-domain.ts'
import { taskArtifactsPath, authorityPaths } from '../workspace-authority-root.ts'
import { openCloud, type Keystone, type Orbit } from './cloud.ts'
import { readOrbConfig, readOrbCredentials } from './config.ts'
import {
  deleteCommand,
  orbFailure,
  shortId,
  shq,
  type OrbCredentials,
  type OrbError,
} from './domain.ts'
import { deleteRecorded } from './deletion.ts'
import { activeOrbs, awaitActive, connect, sshAddress } from './provision.ts'
import { makeChildOrbs } from './children.ts'
import { divergenceText, openOrbQuitView, type OrbQuitTerminal } from './quit-view.ts'
import { openOrbStartView, type OrbStartTerminal, type OrbStartView } from './start-view.ts'
import { recoverOrbs } from './recovery.ts'
import { createRecord, type OrbRecordHandle } from './registry.ts'
import { makeSpareSlot, spareAge, takeSpare } from './spare.ts'
import { makeOrbSsh, sshOptions, ttyScript } from './ssh.ts'
import { createOrbExtension, macHomes } from './tools.ts'
import {
  inspectCheckout,
  orbRepository,
  returnWork,
  upload,
  type Divergence,
  type ReturnOutcome,
} from './transfer.ts'

export interface OrbSessionOptions {
  readonly pi: PiApi
  readonly dataHome: string
  readonly print: (line: string) => void
  readonly confirm?: (prompt: string) => Effect.Effect<boolean>
  readonly secondInterrupt?: Effect.Effect<void>
  readonly terminal?: OrbStartTerminal
  readonly cloud?: (credentials: OrbCredentials) => {
    readonly keystone: Keystone
    readonly orbit: Orbit
  }
}

export interface OrbOpenInput {
  readonly attachment: WorkspaceAttachment
  readonly lifecycle: Pick<
    WorkspaceLifecycle,
    'root' | 'inspect' | 'writeBranch' | 'settleOrbPresence'
  >
  readonly cwd: string
  readonly skillPaths: readonly string[]
  readonly conversation: string
  readonly commandPrefix?: string
}

export interface OrbSession {
  readonly extensionFactory: (api: ExtensionAPI) => void
  readonly workRemote: WorkRemote
  readonly sync: Effect.Effect<string, OrbError>
  close(quit: OrbQuit): Effect.Effect<void>
}

export interface OrbQuit {
  readonly proceed: () => boolean
  readonly interrupted: Effect.Effect<void>
  readonly askRetry?: Effect.Effect<boolean>
  readonly terminal?: OrbQuitTerminal
}

export type SettledReturn =
  | Exclude<ReturnOutcome, { readonly kind: 'diverged' }>
  | { readonly kind: 'diverged'; readonly reason: Divergence; readonly branch: string }

type Services = ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem

const FORWARDED_GIT_SETTINGS = ['GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT', 'GIT_NO_LAZY_FETCH']

const outcomeText = (orb: string, branch: string, outcome: SettledReturn): string => {
  switch (outcome.kind) {
    case 'unchanged':
      return `Nothing to return: orb ${orb} has no new commits or changes.`
    case 'returned':
      return `Returned ${outcome.commits} commit(s) and ${outcome.files} changed file(s) from orb ${orb}; ${branch} is at ${outcome.head.slice(0, 7)}.`
    case 'diverged':
      return `${divergenceText(outcome.reason, branch)} The work of orb ${orb} is on the branch ${outcome.branch}; the checkout, its branch and its index are untouched.\nMerge it with: git merge ${outcome.branch}`
  }
}

export const branchingReturn = (
  attempt: Effect.Effect<ReturnOutcome, OrbError>,
  lifecycle: Pick<WorkspaceLifecycle, 'writeBranch'>,
  cwd: string,
  name: string
): Effect.Effect<SettledReturn, OrbError> => {
  let left: { readonly name: string; readonly commit: string } | undefined
  return Effect.gen(function* () {
    const outcome = yield* attempt
    if (outcome.kind !== 'diverged') return outcome
    const written = yield* lifecycle
      .writeBranch({
        cwd,
        name,
        commit: outcome.commit,
        ...(left === undefined ? {} : { replacing: left }),
      })
      .pipe(
        Effect.mapError(error =>
          orbFailure(`The orb's work could not be written to a branch: ${error.message}`, error)
        )
      )
    left = { name: written.name, commit: outcome.commit }
    return { kind: 'diverged', reason: outcome.reason, branch: written.name } as const
  })
}

export const returnAtQuit = <A>(
  attempt: Effect.Effect<A, OrbError>,
  quit: Pick<OrbQuit, 'proceed' | 'askRetry'>,
  failed: (reason: string) => Effect.Effect<void>
): Effect.Effect<
  | { readonly kind: 'returned'; readonly value: A }
  | { readonly kind: 'kept'; readonly reason: string }
> =>
  Effect.gen(function* () {
    for (;;) {
      const returned = yield* Effect.exit(attempt)
      if (Exit.isSuccess(returned)) return { kind: 'returned', value: returned.value } as const
      const reason = errorText(Cause.squash(returned.cause))
      if (!quit.proceed() || quit.askRetry === undefined) return { kind: 'kept', reason } as const
      yield* failed(reason)
      if (!quit.proceed() || !(yield* quit.askRetry)) return { kind: 'kept', reason } as const
    }
  })

export const capacityFailure = (
  orbit: Pick<Orbit, 'list'>,
  dataHome: string,
  project: string,
  refusal: OrbError
): Effect.Effect<never, OrbError> =>
  Effect.gen(function* () {
    const orbs = yield* orbit.list.pipe(
      Effect.map(views => {
        const active = activeOrbs(views)
        if (active.length === 0)
          return `Project ${project} has no active orb now; another project may hold the capacity, or it is still being freed.`
        return [
          `Project ${project} has ${active.length} active orb(s):`,
          ...active.map(view => `  ${view.id} ${view.status} since ${view.created_at}`),
        ].join('\n')
      }),
      Effect.catch(error =>
        Effect.succeed(`The project's orbs could not be listed: ${error.message}`)
      )
    )
    return yield* orbFailure(
      `orbit has no capacity for another orb: ${refusal.message}\n${orbs}\nDelete one with: ${deleteCommand(dataHome, '<orb-id>')}`,
      refusal,
      refusal.status
    )
  })

export const openOrbSession = (
  options: OrbSessionOptions,
  input: OrbOpenInput
): Effect.Effect<OrbSession, OrbError, Services> =>
  Effect.scoped(
    Effect.flatMap(openOrbStartView(options.terminal, options.print, options.dataHome), startView =>
      startOrbSession(options, input, startView)
    )
  )

const startOrbSession = Effect.fnUntraced(function* (
  options: OrbSessionOptions,
  input: OrbOpenInput,
  startView: OrbStartView
): Effect.fn.Return<OrbSession, OrbError, Services> {
  const { print } = startView
  const { confirm } = options
  const services = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>()
  const runPromise = Effect.runPromiseWith(services)

  const config = yield* readOrbConfig(options.dataHome)
  const checkout = yield* inspectCheckout(input.cwd)
  const credentials = yield* readOrbCredentials(options.dataHome)
  const { keystone, orbit } =
    options.cloud === undefined ? yield* openCloud(credentials) : options.cloud(credentials)
  yield* startView.show({
    kind: 'authenticating',
    user: credentials.username,
    url: credentials.auth_url,
  })
  const token = yield* keystone.token
  yield* recoverOrbs({
    dataHome: options.dataHome,
    authUrl: credentials.auth_url,
    token,
    orbit,
    lifecycle: input.lifecycle,
    print,
    ...(confirm === undefined
      ? {}
      : { confirm: (prompt: string) => startView.pause(confirm(prompt)) }),
  })
  const presence = yield* input.attachment
    .authorize({ kind: 'write', cwd: input.cwd })
    .pipe(
      Effect.mapError(error =>
        orbFailure(`The orb cannot write the checkout: ${error.message}`, error)
      )
    )
  if (presence.kind !== 'ready') {
    yield* Effect.ignore(
      input.attachment.handoff(presence.handoff, () => Effect.succeed('cancelled' as const))
    )
    return yield* orbFailure(
      `dev --orb needs to write ${checkout.root}, but ${presence.handoff.reason}. Quit the other session or use another checkout, then launch again.`
    )
  }
  const writer: WorkspaceGrant = presence.grant
  const withdraw = input.attachment.withdrawOrbPresence(writer).pipe(
    Effect.asVoid,
    Effect.catch(error =>
      Effect.sync(() =>
        print(
          `The launch still reserves ${checkout.root}: ${error.message}\nClear it with: ${writer.taskId === undefined ? 'dev workspace release pre-existing' : `dev workspace release ${writer.taskId}`}`
        )
      )
    )
  )

  const keystoneFields = {
    authUrl: credentials.auth_url,
    projectId: token.project.id,
    projectName: token.project.name,
  }
  const spareContext = {
    dataHome: options.dataHome,
    keystone: keystoneFields,
    orbit,
    config,
    print,
  }
  const assignment = {
    checkout: checkout.root,
    branch: checkout.branch,
    orbPath: checkout.root,
    presenceUseId: writer.useId,
    conversation: input.conversation,
  }
  const spare = yield* takeSpare(spareContext, assignment)
  const { record, request } =
    spare === undefined
      ? yield* createRecord(options.dataHome, { keystone: keystoneFields, ...assignment }).pipe(
          Effect.map(created => ({
            record: created as OrbRecordHandle,
            request: orbit.create({
              size: config.size,
              publicKey: created.publicKey,
              sshAllowedCidr: config.sshAllowedCidr,
            }),
          })),
          Effect.onError(() => withdraw)
        )
      : { record: spare.record, request: Effect.succeed(spare.view) }
  const sessionScope = yield* Scope.make()
  const spares = makeSpareSlot(spareContext, sessionScope, services)
  let reachable = true

  const discard = (orbId: string | undefined, interrupted: boolean) =>
    Effect.gen(function* () {
      yield* Scope.close(sessionScope, Exit.void)
      if (orbId === undefined) {
        yield* Effect.ignore(record.remove)
        return
      }
      yield* startView.show({ kind: 'discarding', orbId, interrupted })
      const deleted = yield* Effect.exit(
        deleteRecorded(
          orbit,
          record,
          orbId,
          progress => startView.show({ kind: 'deletion', orbId, progress }),
          options.secondInterrupt
        )
      )
      if (Exit.isFailure(deleted)) {
        yield* record.release
        yield* startView.show({
          kind: 'undeleted',
          orbId,
          reason: errorText(Cause.squash(deleted.cause)),
        })
      }
    })

  const prepared = yield* Effect.gen(function* () {
    yield* startView.show(
      spare === undefined
        ? { kind: 'requesting', size: config.size, url: token.orbitUrl }
        : {
            kind: 'taking-spare',
            orbId: spare.view.id,
            status: spare.view.status,
            age: spareAge(spare.view, yield* Clock.currentTimeMillis),
          }
    )
    const created = yield* request.pipe(
      Effect.catchIf(
        error => error.status === 409,
        error => capacityFailure(orbit, options.dataHome, token.project.name, error)
      ),
      Effect.tap(view => record.update({ phase: 'created', orbId: view.id })),
      Effect.uninterruptible
    )
    const label = shortId(created.id)
    yield* startView.show({ kind: 'status', orbId: created.id, status: created.status })
    const active = yield* awaitActive(orbit, created, label, status =>
      startView.show({ kind: 'status', orbId: created.id, status })
    )
    const { host, user, keys } = yield* sshAddress(active, label)
    yield* record.writeKnownHosts(host, keys)
    const ssh = makeOrbSsh(
      {
        user,
        host,
        keyPath: record.keyPath,
        knownHostsPath: record.knownHostsPath,
        controlPath: record.controlPath,
      },
      observed => {
        reachable = observed
      }
    )
    yield* startView.show({ kind: 'connecting', destination: `${user}@${host}` })
    yield* connect(ssh)
    yield* Scope.provide(sessionScope)(ssh.master).pipe(
      Effect.catch(error => startView.show({ kind: 'unshared', reason: error.message }))
    )
    yield* startView.show({
      kind: 'uploading',
      branch: checkout.branch,
      head: checkout.head,
      root: checkout.root,
    })
    yield* upload({
      checkout,
      orbPath: checkout.root,
      repository: orbRepository(ssh, checkout.root),
      baseRef: record.current().baseRef,
    })
    yield* record.update({ phase: 'active', uploadedHead: checkout.head })
    yield* startView.show({ kind: 'ready', orbId: created.id })
    yield* spares.request
    return { ssh, label, host, orbId: created.id }
  }).pipe(
    Effect.onError(cause =>
      discard(record.current().orbId, Cause.hasInterruptsOnly(cause)).pipe(
        Effect.ensuring(withdraw)
      )
    )
  )
  const { ssh, label, host, orbId } = prepared
  let returning = false
  const state = () => {
    if (returning) return 'returning'
    return reachable ? 'ACTIVE' : 'unreachable'
  }

  const homes = macHomes({
    checkout: checkout.root,
    skillPaths: input.skillPaths,
    artifacts: () => {
      const { taskId } = input.attachment.binding
      return taskId === undefined
        ? []
        : [taskArtifactsPath(authorityPaths(input.lifecycle.root), taskId)]
    },
  })

  const endRef = `refs/dev/orb/${record.id}/end`
  const returnOnce = withReturnAdmission(
    input.attachment,
    writer,
    checkout.root,
    Effect.gen(function* () {
      returning = true
      const outcome = yield* returnWork({
        root: checkout.root,
        branch: checkout.branch,
        orbPath: checkout.root,
        repository: orbRepository(ssh, checkout.root),
        baseRef: record.current().baseRef,
        endRef,
        beforeWrite: record.update({ phase: 'returning' }),
      })
      yield* record.update({ phase: 'active' })
      return outcome
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          returning = false
        })
      )
    ),
    print
  )

  const settled = branchingReturn(
    returnOnce.pipe(Effect.provideContext(services)),
    input.lifecycle,
    checkout.root,
    `dev/orb-return/${record.id}`
  )

  const sync = Effect.map(settled, outcome => outcomeText(label, checkout.branch, outcome))

  const close = (quit: OrbQuit) =>
    Effect.gen(function* () {
      const left = yield* spares.leave
      const view = yield* openOrbQuitView(quit.terminal, print, {
        label,
        branch: checkout.branch,
        location: `${checkout.root} (${host})`,
        recoveryBranch: `dev/orb-recovery/${record.id}`,
        deleteCommand: deleteCommand(options.dataHome, orbId),
        spare: left,
      })
      const returned = yield* returnAtQuit(
        Effect.andThen(view.show({ kind: 'returning' }), settled),
        quit,
        reason => view.show({ kind: 'return-failed', reason })
      )
      if (returned.kind === 'kept') {
        yield* Scope.close(sessionScope, Exit.void)
        yield* record.release
        yield* view.show({ kind: 'kept', reason: returned.reason })
        return
      }
      yield* view.show({ kind: 'returned', outcome: returned.value })
      yield* Scope.close(sessionScope, Exit.void)
      const deleted = yield* Effect.exit(
        deleteRecorded(
          orbit,
          record,
          orbId,
          progress => view.show({ kind: 'deletion', progress }),
          quit.interrupted
        )
      )
      if (Exit.isFailure(deleted)) {
        yield* record.release
        yield* view.show({ kind: 'undeleted', reason: errorText(Cause.squash(deleted.cause)) })
      }
    }).pipe(Effect.scoped, Effect.provideContext(services))

  const children = makeChildOrbs(
    {
      dataHome: options.dataHome,
      keystone: record.current().keystone,
      token,
      orbit,
      config,
      conversation: input.conversation,
      lead: { ssh, root: checkout.root, label: "this conversation's orb", record: record.id },
      spares,
      lifecycle: input.lifecycle,
    },
    services
  )

  const workRemote: WorkRemote = {
    checkout: checkout.root,
    children,
    reader: {
      label: `orb ${label} (${host})`,
      user: ssh.target.user,
      host: ssh.target.host,
      keyPath: ssh.target.keyPath,
      knownHostsPath: ssh.target.knownHostsPath,
      controlPath: ssh.target.controlPath,
    },
    shellCommand: (command, cwd) =>
      `TERM=dumb exec ${['ssh', ...ssh.ttyArgs(ttyScript(cwd, command))].map(shq).join(' ')}`,
    wrap: (file, args, cwd, env) => {
      const forwarded = FORWARDED_GIT_SETTINGS.flatMap(name => {
        const value = env[name]
        return value === undefined ? [] : [`${name}=${value}`]
      })
      return {
        file: 'ssh',
        args: [
          ...sshOptions(ssh.target),
          ssh.destination,
          `cd ${shq(cwd)} && ${['env', ...forwarded, file, ...args].map(shq).join(' ')}`,
        ],
      }
    },
  }

  const describe = () =>
    `Orb ${orbId} (${state()}) at ${ssh.destination}\nCheckout: ${checkout.root} on ${checkout.branch}, mirrored at the same path on the orb\nRecord: ${record.directory}\nReturn its work with /orb sync; quitting returns it and deletes the orb.`

  return {
    extensionFactory: createOrbExtension({
      pi: options.pi,
      ssh,
      cwd: input.cwd,
      homes,
      label: workRemote.reader.label,
      status: () => `orb ${label}: ${state()}`,
      describe,
      sync: () => runPromise(sync),
      ...(input.commandPrefix === undefined ? {} : { commandPrefix: input.commandPrefix }),
    }),
    workRemote,
    sync,
    close,
  }
})

export const withReturnAdmission = <A, E, R>(
  attachment: WorkspaceAttachment,
  within: WorkspaceGrant,
  cwd: string,
  write: Effect.Effect<A, E, R>,
  print: (line: string) => void
): Effect.Effect<A, E | OrbError, R> => {
  const report = (
    grant: WorkspaceGrant,
    fact: { readonly kind: 'operation-started' } | { readonly kind: 'operation-completed' }
  ) =>
    attachment
      .reportExecution(grant, fact)
      .pipe(
        Effect.mapError(error =>
          orbFailure(`The return could not be recorded: ${error.message}`, error)
        )
      )
  return Effect.acquireUseRelease(
    attachment.authorize({ kind: 'orb-return', within, cwd }).pipe(
      Effect.mapError(error =>
        orbFailure(`The return from the orb did not run: ${error.message}`, error)
      ),
      Effect.flatMap(admitted =>
        admitted.kind === 'ready'
          ? Effect.succeed(admitted.grant)
          : Effect.fail(
              orbFailure('The return from the orb did not run: dev must switch checkouts first')
            )
      )
    ),
    grant => Effect.andThen(report(grant, { kind: 'operation-started' }), write),
    grant =>
      report(grant, { kind: 'operation-completed' }).pipe(
        Effect.catch(error =>
          Effect.sync(() =>
            print(
              `The return's workspace use could not be closed: ${error.message}. Inspect it with dev workspace.`
            )
          )
        )
      )
  )
}
