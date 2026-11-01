import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Deferred, Effect, Exit, Scope } from 'effect'
import type { ChildProcessSpawner } from 'effect/process'
import type { Orbit } from '../../src/orb/cloud.ts'
import {
  isSpare,
  orbFailure,
  type OrbConfig,
  type OrbError,
  type OrbView,
  type SpareRecord,
  type SpareShape,
} from '../../src/orb/domain.ts'
import { recoverOrbs } from '../../src/orb/recovery.ts'
import { claimRecord, createRecord, readRecord } from '../../src/orb/registry.ts'
import { makeSpareSlot, spareProblem, takeSpare, type SpareContext } from '../../src/orb/spare.ts'
import { makeClaims } from '../workspace/workspace-check-support.ts'
import { openLifecycle } from '../workspace/workspace-test-lifecycle.ts'

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'dev-orb-spare-check-')))
process.on('exit', () => rmSync(sandbox, { recursive: true, force: true }))
const { claim, passed } = makeClaims()

const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, NodeServices.layer))

const KEYSTONE = {
  authUrl: 'http://192.0.2.1/identity',
  projectId: 'p1',
  projectName: 'demo',
} as const

const CONFIG: OrbConfig = {
  path: '/unused/orb.json',
  size: { vcpus: 2, memory_mb: 2048, disk_gb: 10 },
  image: 'ubuntu-24.04-arm64-dev',
  sshAllowedCidr: '192.0.2.1/32',
}

const SHAPE: SpareShape = {
  size: CONFIG.size,
  image: CONFIG.image,
  sshAllowedCidr: CONFIG.sshAllowedCidr,
}

const orbitTime = (minutesAgo: number): string =>
  new Date(Date.now() - minutesAgo * 60_000).toISOString().slice(0, 19)

const view = (id: string, minutesAgo: number, status: OrbView['status'] = 'ACTIVE'): OrbView => ({
  id,
  status,
  image: CONFIG.image,
  ssh_host: null,
  ssh_user: null,
  ssh_host_keys: null,
  fault: status === 'ERROR' ? 'No valid host was found' : null,
  created_at: orbitTime(minutesAgo),
})

const fakeOrbit = (
  views: readonly OrbView[],
  create: Effect.Effect<OrbView, OrbError> = Effect.die('no creation expected')
) => {
  const read: string[] = []
  const removed: string[] = []
  let created = 0
  const known = (id: string) => views.find(candidate => candidate.id === id)
  const orbit: Orbit = {
    url: Effect.succeed('http://192.0.2.1/orbit'),
    create: () =>
      Effect.suspend(() => {
        created += 1
        return create
      }),
    get: id =>
      Effect.suspend(() => {
        read.push(id)
        const found = known(id)
        if (found === undefined)
          return Effect.fail(orbFailure(`orbit answered GET with 404`, undefined, 404))
        return Effect.succeed(
          removed.includes(id) ? { ...found, status: 'DELETED' as const } : found
        )
      }),
    remove: id =>
      Effect.sync(() => {
        removed.push(id)
        return { ...(known(id) ?? view(id, 0)), status: 'DELETING' as const }
      }),
    list: Effect.succeed(views),
  }
  return {
    orbit,
    read,
    removed,
    created: () => created,
  }
}

let homes = 0
const dataHome = (): string => {
  homes += 1
  const path = join(sandbox, `home-${homes}`)
  mkdirSync(path, { mode: 0o700 })
  return path
}

const seedSpare = async (
  home: string,
  orbId: string | undefined,
  overrides: { readonly shape?: SpareShape; readonly projectId?: string } = {}
) => {
  const record = await run(
    createRecord(home, {
      keystone: { ...KEYSTONE, projectId: overrides.projectId ?? KEYSTONE.projectId },
      spare: overrides.shape ?? SHAPE,
    })
  )
  if (orbId !== undefined) await run(record.update({ phase: 'created', orbId }))
  await run(record.release)
  return record.directory
}

const context = (home: string, orbit: Orbit, lines: string[]): SpareContext => ({
  dataHome: home,
  keystone: KEYSTONE,
  orbit,
  config: CONFIG,
  print: line => lines.push(line),
})

const ASSIGNMENT = {
  checkout: '/Users/dev/project',
  branch: 'main',
  orbPath: '/Users/dev/project',
  presenceUseId: 'presence-use',
  conversation: '/Users/dev/session.jsonl',
}

const records = (home: string): string[] =>
  existsSync(join(home, 'orbs'))
    ? readdirSync(join(home, 'orbs')).map(id => join(home, 'orbs', id))
    : []

await claim(
  'a spare is valid while it was created with the current orb.json, orbit reports it RESERVING, BUILDING or ACTIVE and it is less than 2 hours old',
  () => {
    const spare: SpareRecord = {
      id: 'r',
      phase: 'created',
      orbId: 'o',
      keystone: KEYSTONE,
      baseRef: 'refs/dev/orb/r/base',
      createdAt: 'x',
      updatedAt: 'x',
      spare: SHAPE,
    }
    const now = Date.now()
    for (const status of ['RESERVING', 'BUILDING', 'ACTIVE'] as const)
      assert.equal(spareProblem(spare, view('o', 119, status), now, SHAPE), undefined, status)
    assert.match(
      spareProblem(spare, view('o', 121), now, SHAPE) ?? '',
      /121 minutes ago, more than 2 hours/
    )
    assert.match(
      spareProblem(spare, view('o', 5, 'ERROR'), now, SHAPE) ?? '',
      /orbit reports it ERROR \(No valid host was found\)/
    )
    for (const other of [
      { ...SHAPE, image: 'cirros' },
      { ...SHAPE, sshAllowedCidr: '198.51.100.7/32' },
      { ...SHAPE, size: { ...SHAPE.size, vcpus: 4 } },
    ])
      assert.equal(
        spareProblem(spare, view('o', 5), now, other),
        'it was created with another orb.json'
      )
    assert.match(
      spareProblem(spare, { ...view('o', 5), created_at: 'soon' }, now, SHAPE) ?? '',
      /creation time soon cannot be read/
    )
  }
)

await claim(
  'a valid spare is taken by assigning its record in place: same record and orb, the checkout fields written, the spare shape gone, and orbit only read',
  async () => {
    const home = dataHome()
    const directory = await seedSpare(home, 'orb-spare')
    const cloud = fakeOrbit([view('orb-spare', 10, 'ACTIVE')])
    const lines: string[] = []
    const taken = await run(takeSpare(context(home, cloud.orbit, lines), ASSIGNMENT))
    assert.ok(taken !== undefined, lines.join('\n'))
    assert.equal(taken.view.id, 'orb-spare')
    assert.equal(taken.record.directory, directory)
    const stored = await run(readRecord(directory))
    assert.ok(!isSpare(stored))
    assert.equal(stored.orbId, 'orb-spare')
    assert.equal(stored.phase, 'created')
    assert.equal(stored.checkout, ASSIGNMENT.checkout)
    assert.equal(stored.presenceUseId, 'presence-use')
    assert.equal('spare' in JSON.parse(readFileSync(join(directory, 'record.json'), 'utf8')), false)
    assert.deepEqual(cloud.removed, [])
    assert.equal(cloud.created(), 0)
    assert.deepEqual(
      await run(claimRecord(directory)),
      { kind: 'owned' },
      'the taking session holds the record'
    )
    await run(taken.record.release)
  }
)

await claim(
  'an expired, failed or differently shaped spare is deleted, DELETED awaited and its record removed before the launch goes on without one',
  async () => {
    const cases = [
      { name: 'expired', orb: view('orb-old', 180), shape: SHAPE, reason: /more than 2 hours/ },
      {
        name: 'error',
        orb: view('orb-error', 5, 'ERROR'),
        shape: SHAPE,
        reason: /reports it ERROR/,
      },
      {
        name: 'shape',
        orb: view('orb-shape', 5),
        shape: { ...SHAPE, image: 'cirros' },
        reason: /another orb\.json/,
      },
    ]
    for (const item of cases) {
      const home = dataHome()
      const directory = await seedSpare(home, item.orb.id, { shape: item.shape })
      const cloud = fakeOrbit([item.orb])
      const lines: string[] = []
      const taken = await run(takeSpare(context(home, cloud.orbit, lines), ASSIGNMENT))
      assert.equal(taken, undefined, item.name)
      assert.deepEqual(cloud.removed, [item.orb.id], item.name)
      assert.equal(existsSync(directory), false, `${item.name}: the record is removed`)
      const text = lines.join('\n')
      assert.match(
        text,
        new RegExp(`deleting the spare orb ${item.orb.id.slice(0, 8)}: `),
        item.name
      )
      assert.match(text, item.reason, item.name)
      assert.match(text, /deleted/, item.name)
    }
  }
)

await claim(
  "a spare orbit no longer has loses its record; one orbit cannot read, another project's and one held by a running session are left untouched",
  async () => {
    const gone = dataHome()
    const goneDirectory = await seedSpare(gone, 'orb-gone')
    const missing = fakeOrbit([])
    assert.equal(await run(takeSpare(context(gone, missing.orbit, []), ASSIGNMENT)), undefined)
    assert.equal(existsSync(goneDirectory), false)

    const unreadable = dataHome()
    const unreadableDirectory = await seedSpare(unreadable, 'orb-unreadable')
    const failing: Orbit = {
      ...fakeOrbit([]).orbit,
      get: () => Effect.fail(orbFailure('orbit answered GET with 503: down', undefined, 503)),
    }
    const unreadableLines: string[] = []
    assert.equal(
      await run(takeSpare(context(unreadable, failing, unreadableLines), ASSIGNMENT)),
      undefined
    )
    assert.ok(existsSync(unreadableDirectory))
    assert.match(unreadableLines.join('\n'), /could not be read from orbit .*; it is kept/)

    const foreign = dataHome()
    const foreignDirectory = await seedSpare(foreign, 'orb-foreign', { projectId: 'p2' })
    const foreignCloud = fakeOrbit([view('orb-foreign', 5)])
    assert.equal(
      await run(takeSpare(context(foreign, foreignCloud.orbit, []), ASSIGNMENT)),
      undefined
    )
    assert.deepEqual(foreignCloud.read, [], "another project's spare is not even read")
    assert.ok(existsSync(foreignDirectory))

    const held = dataHome()
    const heldDirectory = await seedSpare(held, 'orb-held')
    const holder = await run(claimRecord(heldDirectory))
    assert.equal(holder.kind, 'claimed')
    const heldCloud = fakeOrbit([view('orb-held', 5)])
    const heldLines: string[] = []
    assert.equal(
      await run(takeSpare(context(held, heldCloud.orbit, heldLines), ASSIGNMENT)),
      undefined
    )
    assert.deepEqual(heldCloud.read, [])
    assert.match(heldLines.join('\n'), /spare orb orb-held is held by another running dev --orb/)
    if (holder.kind === 'claimed') await run(holder.record.release)
    assert.ok(isSpare(await run(readRecord(heldDirectory))))
  }
)

await claim(
  'recovery leaves a spare that names an orb to the launch, and a spare whose request ended unanswered follows the path of sessions that ended while requesting',
  async () => {
    const home = dataHome()
    const named = await seedSpare(home, 'orb-named')
    const unanswered = await seedSpare(home, undefined)
    const cloud = fakeOrbit([])
    const lines: string[] = []
    const lifecycle = await openLifecycle({ root: join(sandbox, 'authority') })
    try {
      await run(
        recoverOrbs({
          dataHome: home,
          authUrl: KEYSTONE.authUrl,
          token: {
            id: 'token',
            expiresAt: undefined,
            orbitUrl: 'http://192.0.2.1/orbit',
            project: { id: KEYSTONE.projectId, name: KEYSTONE.projectName },
          },
          orbit: cloud.orbit,
          lifecycle: lifecycle.effect,
          print: line => lines.push(line),
        })
      )
    } finally {
      await lifecycle.close()
    }
    assert.deepEqual(cloud.read, [], 'the named spare is not read')
    assert.deepEqual(cloud.removed, [])
    assert.ok(existsSync(named), 'the named spare keeps its record')
    assert.equal(existsSync(unanswered), false, 'the unanswered request leaves nothing')
    const text = lines.join('\n')
    assert.match(text, /left by an ended session while requesting a spare orb \(requested\)/)
    assert.match(
      text,
      /ended while requesting an orb, and the project has no orb created since then/
    )
    assert.doesNotMatch(text, /orb-name/)
  }
)

const services = await run(Effect.context<ChildProcessSpawner.ChildProcessSpawner>())

const slotScenario = async (
  home: string,
  orbit: Orbit,
  drive: (slot: ReturnType<typeof makeSpareSlot>) => Effect.Effect<void, unknown>
) => {
  const scope = await Effect.runPromise(Scope.make())
  const slot = makeSpareSlot(context(home, orbit, []), scope, services)
  try {
    await Effect.runPromise(drive(slot))
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
}

await claim(
  'the session requests one spare in the background with the current orb.json and a spare record of its own; a child takes it, and once taken the slot is empty',
  async () => {
    const home = dataHome()
    const cloud = fakeOrbit([], Effect.succeed(view('orb-new', 0, 'RESERVING')))
    await slotScenario(home, cloud.orbit, slot =>
      Effect.gen(function* () {
        yield* slot.request
        yield* slot.request
        const spare = yield* slot.take
        assert.ok(spare !== undefined)
        assert.equal(spare.view.id, 'orb-new')
        const stored = spare.record.current()
        assert.ok(isSpare(stored))
        assert.deepEqual(stored.spare, SHAPE)
        assert.equal(stored.orbId, 'orb-new')
        assert.equal(stored.phase, 'created')
        assert.equal(yield* slot.take, undefined)
        assert.equal(yield* slot.leave, undefined)
        yield* spare.record.release
      })
    )
    assert.equal(cloud.created(), 1, 'a second request while one is held creates nothing')
  }
)

await claim(
  'no spare is requested while the data home already holds one of the same project, and a refused request leaves no record and is named at quit',
  async () => {
    const holding = dataHome()
    await seedSpare(holding, 'orb-existing')
    const unused = fakeOrbit([], Effect.succeed(view('orb-extra', 0)))
    await slotScenario(holding, unused.orbit, slot =>
      Effect.gen(function* () {
        yield* slot.request
        assert.equal(yield* slot.leave, undefined)
      })
    )
    assert.equal(unused.created(), 0)

    const rebuilt = dataHome()
    await seedSpare(rebuilt, 'orb-old-project', { projectId: 'p-before-rebuild' })
    const fresh = fakeOrbit([], Effect.succeed(view('orb-fresh', 0, 'RESERVING')))
    await slotScenario(rebuilt, fresh.orbit, slot =>
      Effect.gen(function* () {
        yield* slot.request
        const line = yield* slot.leave
        assert.match(line ?? '', /^Spare orb orb-fresh stays ready/)
      })
    )
    assert.equal(fresh.created(), 1, "another project's spare does not count")

    const full = dataHome()
    const refusing = fakeOrbit(
      [],
      Effect.fail(
        orbFailure('orbit answered POST /v1/orbs with 409: no free lease', undefined, 409)
      )
    )
    await slotScenario(full, refusing.orbit, slot =>
      Effect.gen(function* () {
        yield* slot.request
        assert.equal(
          yield* slot.leave,
          'No spare orb was left for the next dev --orb: orbit had no capacity for it'
        )
      })
    )
    assert.deepEqual(records(full), [], 'a refused request leaves no record')
  }
)

await claim(
  'quit waits for an in-flight spare request, so the record names the orb, then releases the record and prints its id, expiry and delete command without waiting for ACTIVE',
  async () => {
    const home = dataHome()
    const requested = Deferred.makeUnsafe<void>()
    const answer = Deferred.makeUnsafe<void>()
    const cloud = fakeOrbit(
      [],
      Deferred.succeed(requested, undefined).pipe(
        Effect.andThen(Deferred.await(answer)),
        Effect.as(view('orb-quit', 0, 'RESERVING'))
      )
    )
    let line: string | undefined
    await slotScenario(home, cloud.orbit, slot =>
      Effect.gen(function* () {
        yield* slot.request
        yield* Deferred.await(requested)
        yield* Effect.forkChild(
          Effect.andThen(Effect.sleep('20 millis'), Deferred.succeed(answer, undefined))
        )
        line = yield* slot.leave
      })
    )
    assert.match(
      line ?? '',
      /^Spare orb orb-quit stays ready for the next dev --orb until \d{2}[.:]\d{2}\.\n/
    )
    assert.match(line ?? '', /Delete it with: dev --data-home '.*' orb delete orb-quit$/)
    const [directory] = records(home)
    assert.ok(directory !== undefined)
    const claimed = await run(claimRecord(directory))
    assert.equal(claimed.kind, 'claimed', 'quit released the record for the next launch')
    if (claimed.kind !== 'claimed') return
    const stored = claimed.record.current()
    assert.ok(isSpare(stored))
    assert.equal(stored.orbId, 'orb-quit')
    await run(claimed.record.release)
  }
)

process.stdout.write(
  `orb spare check: ${passed.length} claims passed\n${passed.map(text => `- ${text}`).join('\n')}\n`
)
