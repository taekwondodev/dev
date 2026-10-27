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
import type { WorkspaceAttachment, WorkspaceGrant } from '../workspace-domain.ts'
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
import { createRecord, type OrbRecordHandle } from './registry.ts'
import { makeOrbSsh, shq, sshOptions, ttyScript, type OrbSsh } from './ssh.ts'
import { createOrbExtension, type MacHomes } from './tools.ts'
import { inspectCheckout, returnWork, upload, type ReturnOutcome } from './transfer.ts'

export interface OrbSessionOptions {
  readonly pi: PiApi
  readonly dataHome: string
  readonly env: NodeJS.ProcessEnv
  readonly print: (line: string) => void
  readonly cloud?: (openrc: Openrc) => { readonly keystone: Keystone; readonly orbit: Orbit }
}

export interface OrbOpenInput {
  readonly attachment: WorkspaceAttachment
  readonly cwd: string
  readonly authorityRoot: string
  readonly skillPaths: readonly string[]
  readonly conversation: string
  readonly commandPrefix?: string
}

export interface OrbSession {
  readonly extensionFactory: (api: ExtensionAPI) => void
  readonly workRemote: WorkRemote
  readonly sync: Effect.Effect<string, OrbError>
  readonly close: Effect.Effect<void>
}

type Services = ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem

const POLL_INTERVAL = Duration.seconds(5)
const ACTIVE_LIMIT = Duration.minutes(15)
const SSH_LIMIT_TRIES = 24
const DELETE_WAIT_MS = 60_000
const REQUIRED_TOOLS = ['bash', 'git', 'rg', 'grep'] as const
const FORWARDED_GIT_SETTINGS = ['GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT', 'GIT_NO_LAZY_FETCH']

const clock = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

const outcomeText = (orb: string, branch: string, outcome: ReturnOutcome): string => {
  switch (outcome.kind) {
    case 'unchanged':
      return `Nothing to return: orb ${orb} has no new commits or changes.`
    case 'returned':
      return `Returned ${outcome.commits} commit(s) and ${outcome.files} changed file(s) from orb ${orb}; ${branch} is at ${outcome.head.slice(0, 7)}.`
    case 'stopped':
      return `${outcome.message} Orb ${orb} keeps its work.`
  }
}

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

  const discard = (orbId: string | undefined, reason: string) =>
    Effect.gen(function* () {
      yield* Scope.close(sessionScope, Exit.void)
      if (orbId === undefined) {
        yield* Effect.ignore(record.remove)
        return
      }
      const deleted = yield* Effect.exit(deleteAndWait(orbit, record, orbId, print))
      if (Exit.isFailure(deleted)) {
        yield* record.release
        print(
          `orb ${shortId(orbId)} was kept after ${reason}: ${errorText(Cause.squash(deleted.cause))}\nDelete it with: ${deleteCommand(token.orbitUrl, orbId)}`
        )
      }
    })

  const prepared = yield* Effect.gen(function* () {
    yield* phase(
      `requesting an orb (${config.size.vcpus} vCPU, ${config.size.memory_mb} MB, ${config.size.disk_gb} GB, ${config.image}) from ${token.orbitUrl}`
    )
    const created = yield* orbit.create({
      size: config.size,
      publicKey: record.publicKey,
      sshAllowedCidr: config.sshAllowedCidr,
      image: config.image,
    })
    yield* record.update({ phase: 'created', orbId: created.id })
    const label = shortId(created.id)
    yield* phase(`orb ${label} ${created.status}`)
    const active = yield* awaitActive(orbit, created, phase, label)
    const host = active.ssh_host
    const keys = active.ssh_host_keys
    const user = active.ssh_user
    if (host === null || keys === null || keys.length === 0 || user === null)
      return yield* orbFailure(`orb ${label} is ACTIVE without an SSH address, user or host keys`)
    yield* record.writeKnownHosts(host, keys)
    const ssh = makeOrbSsh({
      user,
      host,
      keyPath: record.keyPath,
      knownHostsPath: record.knownHostsPath,
      controlPath: record.controlPath,
    })
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
      repository: repositoryOf(ssh, checkout.root),
      baseRef: record.current().baseRef,
    })
    yield* record.update({ phase: 'active', uploadedHead: checkout.head })
    yield* phase(`orb ${label} is ready`)
    return { ssh, label, host, orbId: created.id }
  }).pipe(
    Effect.onError(cause =>
      discard(record.current().orbId, `a failed start (${errorText(Cause.squash(cause))})`)
    )
  )
  const { ssh, label, host, orbId } = prepared
  let state: 'ACTIVE' | 'returning' | 'unreachable' = 'ACTIVE'

  const homes = macHomes({
    checkout: checkout.root,
    skillPaths: input.skillPaths,
    artifacts: () => {
      const { taskId } = input.attachment.binding
      return taskId === undefined
        ? []
        : [taskArtifactsPath(authorityPaths(input.authorityRoot), taskId)]
    },
  })

  const endRef = `refs/dev/orb/${record.id}/end`
  const returnOnce = withReturnAdmission(
    input.attachment,
    writer,
    checkout.root,
    Effect.gen(function* () {
      state = 'returning'
      const outcome = yield* returnWork({
        root: checkout.root,
        branch: checkout.branch,
        orbPath: checkout.root,
        repository: repositoryOf(ssh, checkout.root),
        baseRef: record.current().baseRef,
        endRef,
        beforeWrite: record.update({ phase: 'returning' }),
      })
      yield* record.update({ phase: 'active' })
      return outcome
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          state = 'ACTIVE'
        })
      )
    ),
    print
  )

  const sync = Effect.map(returnOnce, outcome => outcomeText(label, checkout.branch, outcome)).pipe(
    Effect.provideContext(services)
  )

  const close = Effect.gen(function* () {
    print(`Returning work from orb ${label}…`)
    const returned = yield* Effect.exit(returnOnce)
    const kept = (reason: string) =>
      Effect.gen(function* () {
        yield* Scope.close(sessionScope, Exit.void)
        yield* record.release
        print(
          `Orb ${label} was kept: ${reason}\nIts work is still on the orb at ${checkout.root} (${host}).\nDelete it with: ${deleteCommand(token.orbitUrl, orbId)}`
        )
      })
    if (Exit.isFailure(returned)) return yield* kept(errorText(Cause.squash(returned.cause)))
    print(outcomeText(label, checkout.branch, returned.value))
    if (returned.value.kind === 'stopped') return yield* kept(returned.value.message)
    yield* Scope.close(sessionScope, Exit.void)
    const deleted = yield* Effect.exit(deleteAndWait(orbit, record, orbId, print))
    if (Exit.isFailure(deleted)) {
      yield* record.release
      print(
        `Orb ${label} could not be confirmed deleted: ${errorText(Cause.squash(deleted.cause))}\nDelete it with: ${deleteCommand(token.orbitUrl, orbId)}`
      )
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
    `Orb ${orbId} (${state}) at ${ssh.destination}\nCheckout: ${checkout.root} on ${checkout.branch}, mirrored at the same path on the orb\nRecord: ${record.directory}\nReturn its work with /orb sync; quitting returns it and deletes the orb.`

  return {
    extensionFactory: createOrbExtension({
      pi: options.pi,
      ssh,
      cwd: input.cwd,
      homes,
      label: `orb ${label} (${host})`,
      status: () => `orb ${label}: ${state}`,
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

const repositoryOf = (ssh: OrbSsh, root: string) => ({
  url: `${ssh.destination}:${root}`,
  protocol: 'ssh' as const,
  gitSshCommand: ssh.gitSshCommand,
  run: (script: string) => Effect.map(ssh.checked(script), stdout => stdout.toString('utf8')),
})

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

const deleteAndWait = Effect.fnUntraced(function* (
  orbit: Orbit,
  record: OrbRecordHandle,
  orbId: string,
  print: (line: string) => void
): Effect.fn.Return<void, OrbError> {
  const label = shortId(orbId)
  yield* record.update({ phase: 'deleting' })
  const started = yield* Clock.currentTimeMillis
  let last = (yield* orbit.remove(orbId)).status
  print(`Deleting orb ${label} (${last} 0:00)`)
  for (;;) {
    const view = yield* orbit.get(orbId)
    const spent = (yield* Clock.currentTimeMillis) - started
    if (view.status !== last) {
      last = view.status
      print(`Deleting orb ${label} (${view.status} ${clock(spent)})`)
    }
    if (view.status === 'DELETED') break
    if (spent > DELETE_WAIT_MS)
      return yield* orbFailure(`orb ${label} still reads ${view.status} after ${clock(spent)}`)
    yield* Effect.sleep(Duration.seconds(2))
  }
  yield* record.remove
  print(`orb ${label} deleted`)
})
