import { Clock, Duration, Effect, Schedule } from 'effect'
import type { Orbit } from './cloud.ts'
import { orbFailure, type OrbError, type OrbStatus, type OrbView } from './domain.ts'
import type { OrbSsh } from './ssh.ts'

const POLL_INTERVAL = Duration.seconds(5)
const ACTIVE_LIMIT = Duration.minutes(15)
const SSH_LIMIT_TRIES = 24
const REQUIRED_TOOLS = ['bash', 'git', 'rg', 'grep'] as const

export const awaitActive = Effect.fnUntraced(function* (
  orbit: Orbit,
  created: OrbView,
  label: string,
  changed: (status: OrbStatus) => Effect.Effect<void>
): Effect.fn.Return<OrbView, OrbError> {
  let last: OrbStatus = created.status
  const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(ACTIVE_LIMIT)
  for (;;) {
    const view = yield* orbit.get(created.id)
    if (view.status !== last) {
      last = view.status
      yield* changed(view.status)
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

export const sshAddress = (
  active: OrbView,
  label: string
): Effect.Effect<
  { readonly host: string; readonly user: string; readonly keys: readonly string[] },
  OrbError
> => {
  const host = active.ssh_host
  const keys = active.ssh_host_keys
  const user = active.ssh_user
  if (host === null || keys === null || keys.length === 0 || user === null)
    return Effect.fail(
      orbFailure(`orb ${label} is ACTIVE without an SSH address, user or host keys`)
    )
  return Effect.succeed({ host, user, keys })
}

export const connect = (ssh: OrbSsh): Effect.Effect<void, OrbError> =>
  ssh
    .checked('true', { timeout: '30 seconds' })
    .pipe(
      Effect.retry({ schedule: Schedule.spaced(POLL_INTERVAL), times: SSH_LIMIT_TRIES }),
      Effect.asVoid
    )

export const checkTools = Effect.fnUntraced(function* (
  ssh: OrbSsh,
  image: string
): Effect.fn.Return<void, OrbError> {
  const missing = (yield* ssh.checked(
    `for t in ${REQUIRED_TOOLS.join(' ')}; do command -v "$t" >/dev/null 2>&1 || echo "$t"; done`
  ))
    .toString('utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
  if (missing.length > 0)
    return yield* orbFailure(
      `the image ${image} lacks ${missing.join(', ')}; dev --orb needs ${REQUIRED_TOOLS.join(', ')}`
    )
})

export const activeOrbs = (views: readonly OrbView[]): readonly OrbView[] =>
  views.filter(view => view.status !== 'DELETING' && view.status !== 'DELETED')
