import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname } from 'node:path'
import { Cause, Clock, Duration, Effect, Exit, Schedule, Scope } from 'effect'
import type * as FileSystem from 'effect/FileSystem'
import type { ChildProcessSpawner } from 'effect/process'
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
import { isWithin } from '../workspace-paths.ts'
import {
  makeKeystone,
  makeOrbit,
  readCa,
  readOpenrc,
  type Keystone,
  type Openrc,
  type Orbit,
} from './cloud.ts'
import { readOrbConfig } from './config.ts'
import {
  deleteCommand,
  orbFailure,
  shortId,
  type OrbError,
  type OrbStatus,
  type OrbView,
} from './domain.ts'
import { clock, deleteRecorded } from './deletion.ts'
import { recoverOrbs } from './recovery.ts'
import { createRecord } from './registry.ts'
import { makeOrbSsh, shq, sshOptions, ttyScript } from './ssh.ts'
import { createOrbExtension, type MacHomes } from './tools.ts'
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
  readonly env: NodeJS.ProcessEnv
  readonly print: (line: string) => void
  readonly confirm?: (prompt: string) => Effect.Effect<boolean>
  readonly secondInterrupt?: Effect.Effect<void>
  readonly cloud?: (openrc: Openrc) => { readonly keystone: Keystone; readonly orbit: Orbit }
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
}

export type SettledReturn =
  | Exclude<ReturnOutcome, { readonly kind: 'diverged' }>
  | { readonly kind: 'diverged'; readonly reason: Divergence; readonly branch: string }

type Services = ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem

const POLL_INTERVAL = Duration.seconds(5)
const ACTIVE_LIMIT = Duration.minutes(15)
const SSH_LIMIT_TRIES = 24
const REQUIRED_TOOLS = ['bash', 'git', 'rg', 'grep'] as const
const FORWARDED_GIT_SETTINGS = ['GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT', 'GIT_NO_LAZY_FETCH']

const divergenceText = (reason: Divergence, branch: string): string => {
  switch (reason) {
    case 'branch-moved':
      return `${branch} moved on the Mac, so the orb's commits cannot fast-forward it.`
    case 'history-rewritten':
      return `The orb rewrote the commit it was given (an amend or a rebase), so its commits cannot fast-forward ${branch}.`
    case 'branch-switched':
      return `The checkout is no longer on ${branch}.`
    case 'overlap':
      return "Local edits overlap the orb's changes."
  }
}

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
  quit: OrbQuit,
  print: (line: string) => void
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
      print(`The return failed: ${reason}`)
      if (!(yield* quit.askRetry)) return { kind: 'kept', reason } as const
      print('Retrying the return…')
    }
  })

export const capacityFailure = (
  orbit: Pick<Orbit, 'list'>,
  orbitUrl: string,
  project: string,
  refusal: OrbError
): Effect.Effect<never, OrbError> =>
  Effect.gen(function* () {
    const orbs = yield* orbit.list.pipe(
      Effect.map(views => {
        const active = views.filter(view => view.status !== 'DELETING' && view.status !== 'DELETED')
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
      `orbit has no capacity for another orb: ${refusal.message}\n${orbs}\nDelete one with: ${deleteCommand(orbitUrl, '<orb-id>')}`,
      refusal,
      refusal.status
    )
  })

const unconfirmed = (orbitUrl: string, orbId: string, reason: string): string =>
  `Orb ${orbId} could not be confirmed deleted: ${reason}\nIts record stays, and the next dev --orb deletes the orb and removes it.\nDelete it now with: ${deleteCommand(orbitUrl, orbId)}`

const insideAny = (roots: readonly string[], path: string): boolean =>
  roots.some(root => isWithin(root, path))

const SPILL_FILE = /^pi-[a-z]+-[0-9a-f]{16}\.[a-z0-9]+$/

export const macHomes = (input: {
  readonly checkout: string
  readonly skillPaths: readonly string[]
  readonly artifacts: () => readonly string[]
}): MacHomes => {
  const temporary = new Set([tmpdir(), realOrSelf(tmpdir())])
  const skills = input.skillPaths.filter(path => !isWithin(input.checkout, path))
  return {
    read: path =>
      (temporary.has(dirname(path)) && SPILL_FILE.test(basename(path))) ||
      insideAny([...skills, ...input.artifacts()], path),
    write: path => insideAny(input.artifacts(), path),
  }
}

const realOrSelf = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

export const openOrbSession = Effect.fnUntraced(function* (
  options: OrbSessionOptions,
  input: OrbOpenInput
): Effect.fn.Return<OrbSession, OrbError, Services> {
  const { print } = options
  const services = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>()
  const runPromise = Effect.runPromiseWith(services)
  const started = yield* Clock.currentTimeMillis
  const elapsed = Effect.map(Clock.currentTimeMillis, now => clock(now - started))
  const phase = (text: string) =>
    Effect.flatMap(elapsed, time => Effect.sync(() => print(`orb: ${text} (${time})`)))

  const config = yield* readOrbConfig()
  const checkout = yield* inspectCheckout(input.cwd)
  const openrc = yield* readOpenrc(options.env)
  yield* Effect.sync(() => {
    for (const name of Object.keys(options.env))
      if (name.startsWith('OS_')) Reflect.deleteProperty(options.env, name)
  })
  const ca = yield* readCa(openrc)
  const { keystone, orbit } =
    options.cloud?.(openrc) ??
    (() => {
      const issued = makeKeystone(openrc, ca)
      return { keystone: issued, orbit: makeOrbit(issued, ca) }
    })()
  yield* phase(`authenticating as ${openrc.OS_USERNAME} with Keystone at ${openrc.OS_AUTH_URL}`)
  const token = yield* keystone.token
  yield* recoverOrbs({
    dataHome: options.dataHome,
    authUrl: openrc.OS_AUTH_URL,
    token,
    orbit,
    lifecycle: input.lifecycle,
    print,
    ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
  })
  const presence = yield* input.attachment
    .authorize({ kind: 'write', cwd: input.cwd })
    .pipe(
      Effect.mapError(error =>
        orbFailure(`The checkout was not admitted for the orb: ${error.message}`, error)
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

  const record = yield* createRecord(options.dataHome, {
    keystone: {
      authUrl: openrc.OS_AUTH_URL,
      projectId: token.project.id,
      projectName: token.project.name,
    },
    checkout: checkout.root,
    branch: checkout.branch,
    orbPath: checkout.root,
    presenceUseId: writer.useId,
    conversation: input.conversation,
  })
  const sessionScope = yield* Scope.make()
  let reachable = true

  const discard = (orbId: string | undefined, reason: string) =>
    Effect.gen(function* () {
      yield* Scope.close(sessionScope, Exit.void)
      if (orbId === undefined) {
        yield* Effect.ignore(record.remove)
        return
      }
      print(`Deleting orb ${shortId(orbId)} after ${reason}…`)
      const deleted = yield* Effect.exit(
        deleteRecorded(orbit, record, orbId, print, options.secondInterrupt)
      )
      if (Exit.isFailure(deleted)) {
        yield* record.release
        print(unconfirmed(token.orbitUrl, orbId, errorText(Cause.squash(deleted.cause))))
      }
    })

  const prepared = yield* Effect.gen(function* () {
    yield* phase(
      `requesting an orb (${config.size.vcpus} vCPU, ${config.size.memory_mb} MB, ${config.size.disk_gb} GB, ${config.image}) from ${token.orbitUrl}`
    )
    const created = yield* orbit
      .create({
        size: config.size,
        publicKey: record.publicKey,
        sshAllowedCidr: config.sshAllowedCidr,
        image: config.image,
      })
      .pipe(
        Effect.catchIf(
          error => error.status === 409,
          error => capacityFailure(orbit, token.orbitUrl, token.project.name, error)
        ),
        Effect.tap(view => record.update({ phase: 'created', orbId: view.id })),
        Effect.uninterruptible
      )
    const label = shortId(created.id)
    yield* phase(`orb ${label} ${created.status}`)
    const active = yield* awaitActive(orbit, created, phase, label)
    const host = active.ssh_host
    const keys = active.ssh_host_keys
    const user = active.ssh_user
    if (host === null || keys === null || keys.length === 0 || user === null)
      return yield* orbFailure(`orb ${label} is ACTIVE without an SSH address, user or host keys`)
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
    yield* phase(`connecting to ${user}@${host} over SSH`)
    yield* ssh
      .checked('true', { timeout: '30 seconds' })
      .pipe(Effect.retry({ schedule: Schedule.spaced(POLL_INTERVAL), times: SSH_LIMIT_TRIES }))
    yield* Scope.provide(sessionScope)(ssh.master).pipe(
      Effect.catch(error => phase(`continuing without a shared SSH connection: ${error.message}`))
    )
    const missing = (yield* ssh.checked(
      `for t in ${REQUIRED_TOOLS.join(' ')}; do command -v "$t" >/dev/null 2>&1 || echo "$t"; done`
    ))
      .toString('utf8')
      .split('\n')
      .filter(line => line.trim().length > 0)
    if (missing.length > 0)
      return yield* orbFailure(
        `the image ${config.image} lacks ${missing.join(', ')}; dev --orb needs ${REQUIRED_TOOLS.join(', ')}`
      )
    yield* phase(
      `uploading ${checkout.branch} at ${checkout.head.slice(0, 7)} with its uncommitted changes to ${checkout.root}`
    )
    yield* upload({
      checkout,
      orbPath: checkout.root,
      repository: orbRepository(ssh, checkout.root),
      baseRef: record.current().baseRef,
    })
    yield* record.update({ phase: 'active', uploadedHead: checkout.head })
    yield* phase(`orb ${label} is ready`)
    return { ssh, label, host, orbId: created.id }
  }).pipe(
    Effect.onError(cause =>
      discard(
        record.current().orbId,
        Cause.hasInterruptsOnly(cause) ? 'the interrupted start' : 'the failed start'
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
      print(`Returning work from orb ${label}…`)
      const returned = yield* returnAtQuit(settled, quit, print)
      if (returned.kind === 'kept') {
        yield* Scope.close(sessionScope, Exit.void)
        yield* record.release
        print(
          `Orb ${orbId} was kept: ${returned.reason}\nIts work is still on the orb at ${checkout.root} (${host}); the next dev --orb returns it to the branch dev/orb-recovery/${record.id} and deletes the orb.\nDelete it with: ${deleteCommand(token.orbitUrl, orbId)}`
        )
        return
      }
      print(outcomeText(label, checkout.branch, returned.value))
      yield* Scope.close(sessionScope, Exit.void)
      const deleted = yield* Effect.exit(
        deleteRecorded(orbit, record, orbId, print, quit.interrupted)
      )
      if (Exit.isFailure(deleted)) {
        yield* record.release
        print(unconfirmed(token.orbitUrl, orbId, errorText(Cause.squash(deleted.cause))))
      }
    }).pipe(Effect.provideContext(services))

  const workRemote: WorkRemote = {
    agentRefusal:
      'Delegated agents are refused in orb mode; run commands with work process or in the lead.',
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
      label: `orb ${label} (${host})`,
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
      Effect.mapError(error => orbFailure(`The return was not admitted: ${error.message}`, error)),
      Effect.flatMap(admitted =>
        admitted.kind === 'ready'
          ? Effect.succeed(admitted.grant)
          : Effect.fail(orbFailure('The return was not admitted: the workspace requires a rebind'))
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

const awaitActive = Effect.fnUntraced(function* (
  orbit: Orbit,
  created: OrbView,
  phase: (text: string) => Effect.Effect<void>,
  label: string
): Effect.fn.Return<OrbView, OrbError> {
  let last: OrbStatus = created.status
  const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(ACTIVE_LIMIT)
  for (;;) {
    const view = yield* orbit.get(created.id)
    if (view.status !== last) {
      last = view.status
      yield* phase(`orb ${label} ${view.status}`)
    }
    if (view.status === 'ACTIVE') return view
    if (view.status !== 'RESERVING' && view.status !== 'BUILDING')
      return yield* orbFailure(
        `orb ${label} reached ${view.status}: ${view.fault ?? 'no fault reported'}`
      )
    if ((yield* Clock.currentTimeMillis) > deadline)
      return yield* orbFailure(
        `orb ${label} did not become ACTIVE within ${Duration.format(ACTIVE_LIMIT)}`
      )
    yield* Effect.sleep(POLL_INTERVAL)
  }
})
