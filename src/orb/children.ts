import { Cause, Effect, Exit, Scope, type Context } from 'effect'
import type { ChildProcessSpawner } from 'effect/process'
import { errorText } from '../error-text.ts'
import type {
  AttemptId,
  AttemptOrb,
  ChildOrb,
  ChildOrbs,
  OrbReturn,
  PinnedStart,
} from '../work-domain.ts'
import type { WorkspaceLifecycle } from '../workspace-domain.ts'
import type { KeystoneToken, Orbit } from './cloud.ts'
import { deleteRecorded } from './deletion.ts'
import {
  deleteCommand,
  orbFailure,
  shortId,
  type OrbConfig,
  type OrbError,
  type OrbRecord,
} from './domain.ts'
import { activeOrbs, awaitActive, connect, sshAddress } from './provision.ts'
import { createRecord, type OrbRecordHandle } from './registry.ts'
import { makeOrbSsh, type OrbSsh } from './ssh.ts'
import {
  fetchWork,
  hardenedGit,
  inspectWorktree,
  mirrorWorktree,
  orbRepository,
  upload,
  type OrbRepository,
} from './transfer.ts'

export interface MirrorTarget {
  readonly ssh: OrbSsh
  readonly root: string
  readonly label: string
}

export interface ChildOrbsInput {
  readonly dataHome: string
  readonly keystone: OrbRecord['keystone']
  readonly token: KeystoneToken
  readonly orbit: Orbit
  readonly config: OrbConfig
  readonly conversation: string
  readonly lead: MirrorTarget & { readonly record: string }
  readonly lifecycle: Pick<WorkspaceLifecycle, 'writeBranch'>
}

type Services = ChildProcessSpawner.ChildProcessSpawner

const quiet = (): void => undefined

const failureText = (cause: Cause.Cause<unknown>): string => errorText(Cause.squash(cause))

const divergenceText = (reason: string): string =>
  reason === 'history-rewritten'
    ? "the child's orb rewrote its start commit (an amend or a rebase)"
    : `its return diverged (${reason})`

export const capacityExhausted = (
  orbit: Pick<Orbit, 'list'>,
  refusal: OrbError
): Effect.Effect<never, OrbError> =>
  orbit.list.pipe(
    Effect.map(views => `${activeOrbs(views).length} active orbs in the project`),
    Effect.catch(error =>
      Effect.succeed(`the project's active orbs could not be counted (${error.message})`)
    ),
    Effect.flatMap(count =>
      Effect.fail(
        orbFailure(
          `orbit capacity exhausted: ${count}; wait for a child to finish`,
          refusal,
          refusal.status
        )
      )
    )
  )

export const saveChildWork = Effect.fnUntraced(function* (input: {
  readonly worktree: string
  readonly orbPath: string
  readonly record: string
  readonly baseRef: string
  readonly repository: OrbRepository
  readonly returned: OrbReturn | undefined
  readonly lifecycle: Pick<WorkspaceLifecycle, 'writeBranch'>
}): Effect.fn.Return<
  { readonly name: string; readonly commit: string } | undefined,
  OrbError,
  Services
> {
  const { repository } = input
  const git = yield* hardenedGit(input.worktree, repository.protocol, repository.gitSshCommand)
  const fetched = yield* fetchWork(git, {
    orbPath: input.orbPath,
    repository,
    baseRef: input.baseRef,
    endRef: `refs/dev/orb/${input.record}/end`,
  })
  if (fetched.kind === 'unchanged') return undefined
  const name =
    input.returned?.kind === 'diverged'
      ? `dev/orb-return/${input.record}`
      : `dev/orb-recovery/${input.record}`
  const written = yield* input.lifecycle
    .writeBranch({ cwd: input.worktree, name, commit: fetched.work })
    .pipe(
      Effect.mapError(error =>
        orbFailure(`the work could not be written to a branch: ${error.message}`, error)
      )
    )
  return { name: written.name, commit: fetched.work }
})

export const makeChildOrbs = (
  input: ChildOrbsInput,
  services: Context.Context<Services>
): ChildOrbs => {
  const targets = new WeakMap<ChildOrb, MirrorTarget>()
  const leadRepository = orbRepository(input.lead.ssh, input.lead.root)

  const fork = (attempt: AttemptId): Effect.Effect<PinnedStart, Error> =>
    Effect.gen(function* () {
      const git = yield* hardenedGit(
        input.lead.root,
        leadRepository.protocol,
        leadRepository.gitSshCommand
      )
      const ref = `refs/dev/orb/${input.lead.record}/fork/${attempt}`
      yield* leadRepository.transfer(
        git.run([
          'fetch',
          '-q',
          '--no-tags',
          '--no-write-fetch-head',
          leadRepository.url,
          `+HEAD:${ref}`,
        ])
      )
      const commit = yield* git.text(['rev-parse', '--verify', `${ref}^{commit}`])
      return {
        ref,
        commit,
        unpin: Effect.ignore(git.run(['update-ref', '-d', ref])).pipe(
          Effect.provideContext(services)
        ),
      }
    }).pipe(
      Effect.mapError(error =>
        orbFailure(`the commit of ${input.lead.label} could not be read: ${error.message}`, error)
      ),
      Effect.provideContext(services)
    )

  const removeOrb = (
    record: OrbRecordHandle,
    orbId: string
  ): Effect.Effect<{ readonly status: string; readonly text: string }> =>
    Effect.exit(deleteRecorded(input.orbit, record, orbId, quiet)).pipe(
      Effect.flatMap(deleted =>
        Exit.isSuccess(deleted)
          ? Effect.succeed({ status: 'DELETED', text: `Orb ${shortId(orbId)} was deleted.` })
          : Effect.as(record.release, {
              status: 'kept',
              text: `Orb ${orbId} could not be confirmed deleted: ${failureText(deleted.cause)}\nIts record stays, and the next dev --orb deletes the orb.\nDelete it now with: ${deleteCommand(input.token.orbitUrl, orbId)}`,
            })
      )
    )

  const provision: ChildOrbs['provision'] = ({ attempt, worktree, report, adopt }) =>
    Effect.uninterruptibleMask(restore =>
      Effect.gen(function* () {
        const checkout = yield* inspectWorktree(worktree)
        const record = yield* createRecord(input.dataHome, {
          keystone: input.keystone,
          checkout: checkout.root,
          orbPath: checkout.root,
          conversation: `${input.conversation}#${attempt}`,
        })
        const scope = yield* Scope.make()
        const state = (patch: Omit<AttemptOrb, 'record'>) => report({ record: record.id, ...patch })
        let cleanup = ''
        const steps = Effect.gen(function* () {
          yield* state({ status: 'requested' })
          const created = yield* input.orbit
            .create({
              size: input.config.size,
              publicKey: record.publicKey,
              sshAllowedCidr: input.config.sshAllowedCidr,
              image: input.config.image,
            })
            .pipe(
              Effect.catchIf(
                error => error.status === 409,
                error => capacityExhausted(input.orbit, error)
              ),
              Effect.tap(view => record.update({ phase: 'created', orbId: view.id })),
              Effect.uninterruptible
            )
          const label = shortId(created.id)
          yield* state({ id: created.id, status: created.status })
          const active = yield* awaitActive(input.orbit, created, label, status =>
            state({ id: created.id, status })
          )
          const { host, user, keys } = yield* sshAddress(active, label)
          yield* record.writeKnownHosts(host, keys)
          const ssh = makeOrbSsh({
            user,
            host,
            keyPath: record.keyPath,
            knownHostsPath: record.knownHostsPath,
            controlPath: record.controlPath,
          })
          yield* connect(ssh)
          yield* Scope.provide(scope)(ssh.master).pipe(Effect.ignore)
          yield* upload({
            checkout,
            orbPath: checkout.root,
            repository: orbRepository(ssh, checkout.root),
            baseRef: record.current().baseRef,
          })
          yield* record.update({ phase: 'active', uploadedHead: checkout.head })
          return { ssh, orbId: created.id, label, host }
        }).pipe(
          Effect.onExit(exit => {
            if (Exit.isSuccess(exit)) return Effect.void
            return Effect.gen(function* () {
              yield* Scope.close(scope, Exit.void)
              const { orbId } = record.current()
              if (orbId === undefined) {
                yield* Effect.ignore(record.remove)
                return
              }
              const removed = yield* removeOrb(record, orbId)
              cleanup = ` ${removed.text}`
              yield* state({ id: orbId, status: removed.status, report: removed.text })
            })
          }),
          Effect.mapError(error => orbFailure(`${error.message}${cleanup}`, error, error.status))
        )
        const started = yield* restore(steps)
        const orb: ChildOrb = {
          handle: {
            label: `orb ${started.label} (${started.host})`,
            user: started.ssh.target.user,
            host: started.ssh.target.host,
            keyPath: started.ssh.target.keyPath,
            knownHostsPath: started.ssh.target.knownHostsPath,
            controlPath: started.ssh.target.controlPath,
            record: record.id,
          },
          end: ({ returned, into }) =>
            end({
              record,
              ssh: started.ssh,
              orbId: started.orbId,
              worktree: checkout.root,
              returned,
              target: (into === undefined ? undefined : targets.get(into)) ?? input.lead,
            }).pipe(
              Effect.ensuring(Scope.close(scope, Exit.void)),
              Effect.provideContext(services)
            ),
        }
        adopt(orb)
        targets.set(orb, {
          ssh: started.ssh,
          root: checkout.root,
          label: `the orb of its coordinator, ${shortId(started.orbId)}`,
        })
        return orb
      })
    ).pipe(Effect.provideContext(services))

  const end = Effect.fnUntraced(function* (child: {
    readonly record: OrbRecordHandle
    readonly ssh: OrbSsh
    readonly orbId: string
    readonly worktree: string
    readonly returned: OrbReturn | undefined
    readonly target: MirrorTarget
  }): Effect.fn.Return<{ readonly status: string; readonly report: string }, never, Services> {
    const { record, worktree, returned } = child
    const lines: string[] = []
    switch (returned?.kind) {
      case 'returned':
        lines.push(
          `The child returned ${returned.commits} commit(s) and ${returned.files} changed file(s) into its worktree.`
        )
        break
      case 'unchanged':
        lines.push('The child changed nothing on its orb.')
        break
      case 'diverged':
        lines.push(`The worktree is untouched: ${divergenceText(returned.reason)}.`)
        break
      case 'failed':
        lines.push(`The child's return failed: ${returned.reason}`)
        break
      case undefined:
        lines.push('The child ended without returning its work.')
    }
    const kept = (reason: string) =>
      Effect.as(record.release, {
        status: 'kept',
        report: [
          ...lines,
          `Orb ${child.orbId} was kept: ${reason}`,
          `Its work is still on the orb at ${worktree} (${child.ssh.target.host}); the next dev --orb returns it to the branch dev/orb-recovery/${record.id} and deletes the orb.`,
          `Delete it with: ${deleteCommand(input.token.orbitUrl, child.orbId)}`,
        ].join('\n'),
      })
    const saved = yield* Effect.exit(
      saveChildWork({
        worktree,
        orbPath: worktree,
        record: record.id,
        baseRef: record.current().baseRef,
        repository: orbRepository(child.ssh, worktree),
        returned,
        lifecycle: input.lifecycle,
      })
    )
    if (Exit.isFailure(saved)) return yield* kept(failureText(saved.cause))
    const branch = saved.value
    if (branch !== undefined)
      lines.push(
        `Its work is on the branch ${branch.name}; merge it with: git merge ${branch.name}`
      )
    const target = orbRepository(child.target.ssh, child.target.root)
    const mirrored = yield* Effect.exit(
      mirrorWorktree({
        worktree,
        orbPath: worktree,
        root: child.target.root,
        repository: target,
        branches: branch === undefined ? [] : [branch],
      })
    )
    lines.push(
      Exit.isSuccess(mirrored)
        ? `The worktree, uncommitted changes included${branch === undefined ? '' : `, and ${branch.name}`}, are at the same paths on ${child.target.label}.`
        : `The worktree could not be copied to ${child.target.label}: ${failureText(mirrored.cause)}`
    )
    const removed = yield* removeOrb(record, child.orbId)
    lines.push(removed.text)
    return { status: removed.status, report: lines.join('\n') }
  })

  return { fork, provision }
}
