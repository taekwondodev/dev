import assert from 'node:assert/strict'
import { execFileSync, fork, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { createServer as createSocketServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as Cause from 'effect/Cause'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import { makeClaims } from '../workspace/workspace-check-support.ts'
import { holdsFor, waitFor, waitUntil, within } from '../wait.ts'
import { processTable } from '../../src/process-family.ts'
import { makeBrowserProfileOwner } from '../../src/web-profile.ts'
import { makeBrowserAdmin, makeSessionRenderer } from '../../src/web-browser-owner.ts'
import {
  assertCopyReleased,
  chromeProcessesOn,
  chromeRunningOn,
  openRenderer,
  OWNER_ENTRY,
  ownerBootstrap,
  ownerPublished,
  selectOwnerFixture,
} from './chrome-fixture.ts'
import {
  makeBrowserOwnerCheckFixture,
  MAX_HTML,
  processGroup,
  renderInFlight,
  text,
} from './browser-owner-check-fixture.ts'

const {
  fixture,
  chrome,
  seen,
  origin,
  profileOptions,
  baseFixture,
  ownerPids,
  failures,
  newScope,
  close,
} = await makeBrowserOwnerCheckFixture()
const { claim, passed } = makeClaims(180_000)

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const ownerProcesses = (): number => readdirSync(ownerPids).filter(pid => alive(Number(pid))).length
const startOwner = (home: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(import.meta.dirname, 'browser-owner-starter.ts'), home],
      { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let out = ''
    child.stdout.on('data', (chunk: Uint8Array) => {
      out += String(chunk)
    })
    child.stderr.on('data', (chunk: Uint8Array) => {
      out += String(chunk)
    })
    child.once('exit', code => (code === 0 ? resolve(out) : reject(new Error(out))))
  })

try {
  await claim(
    'administrative IPC has a finite deadline and closes its socket when an owner accepts but never replies, without claiming revocation succeeded',
    async () => {
      const home = join(fixture, 'silent-admin')
      const root = join(home, 'browser')
      mkdirSync(join(root, 'user-data'), { recursive: true, mode: 0o700 })
      const sentinel = join(root, 'user-data', 'kept')
      writeFileSync(sentinel, 'not settled')
      const socketPath = join(fixture, 'admin.sock')
      const sockets = new Set<Socket>()
      const silent = createSocketServer(socket => {
        sockets.add(socket)
        socket.on('data', () => {})
        socket.once('close', () => sockets.delete(socket))
      })
      await new Promise<void>(resolve => {
        silent.listen(socketPath, resolve)
      })
      writeFileSync(
        join(root, 'owner.json'),
        JSON.stringify({
          epoch: 'silent-fixture',
          socket: socketPath,
          pid: process.pid,
          startedAt: Date.now(),
          installation: realpathSync(fileURLToPath(new URL('../../', import.meta.url))),
        })
      )
      try {
        const started = Date.now()
        const outcome = await Effect.runPromiseExit(
          makeBrowserAdmin(profileOptions(home))
            .revoke(Duration.millis(10))
            .pipe(Effect.timeout('4 seconds'))
        )
        assert.ok(Exit.isFailure(outcome))
        assert.match(
          String(Cause.squash(outcome.cause)),
          /Browser command timed out; result unverified\. Check `dev browser status`/
        )
        assert.ok(Date.now() - started < 3500, 'the administrative deadline bounded the request')
        await waitFor('the timed-out admin socket to close', () =>
          sockets.size === 0 ? true : undefined
        )
        assert.equal(readFileSync(sentinel, 'utf8'), 'not settled')
      } finally {
        for (const socket of sockets) socket.destroy()
        await new Promise<void>(resolve => {
          silent.close(() => resolve())
        })
      }
    }
  )
  if (chrome !== undefined) {
    await claim(
      'an owner whose Chrome cannot be launched returns an honest failure and releases the profile copy instead of holding it',
      async () => {
        const home = join(fixture, 'unlaunchable')
        mkdirSync(home, { mode: 0o700 })
        const executable = join(fixture, 'not-executable-chrome')
        writeFileSync(executable, '#!/bin/sh\nexit 1\n', { mode: 0o600 })
        selectOwnerFixture({ ...baseFixture, chromeExecutables: [executable] })
        const renderer = await openRenderer(home, newScope(), failures)
        const exit = await Effect.runPromiseExit(
          renderer.render(`${origin}/page.html?m=NOPE`, MAX_HTML)
        )
        assert.ok(Exit.isFailure(exit))
        assert.match(String(Cause.squash(exit.cause)), /Chrome could not be started|DevTools/)
        await assertCopyReleased(profileOptions(home), 'after a failed launch')
        assert.ok(ownerPublished(home), 'the owner stayed available after the failed launch')
      }
    )
    await claim(
      'an unverified Chrome shutdown keeps the profile copy and its lock, reports the unobserved state and removes the copy only once settlement is observed',
      async () => {
        const home = join(fixture, 'unobserved')
        mkdirSync(home, { mode: 0o700 })
        const userDataDir = join(home, 'browser', 'user-data')
        const flag = join(fixture, 'observation-blocked')
        writeFileSync(flag, 'blocked\n')
        selectOwnerFixture({ ...baseFixture, processObservationBlock: flag })
        const blindAdmin = makeBrowserAdmin(profileOptions(home))
        let helper: { readonly pid: number; readonly group: number } | undefined
        const helperOnCopy = () =>
          chromeProcessesOn(userDataDir).some(
            line => Number.parseInt(line.trimStart(), 10) === helper?.pid
          )
        const endHelper = () => {
          const stopped = helper
          if (stopped === undefined) return
          const table = Effect.runSync(Effect.exit(processTable))
          if (Exit.isFailure(table)) {
            try {
              writeSync(
                2,
                `The process table was unreadable; stopped Chrome helper ${stopped.pid} was left running.\n`
              )
            } catch {
              return
            }
            return
          }
          helper = undefined
          if (table.value.find(item => item.pid === stopped.pid)?.group !== stopped.group) return
          try {
            process.kill(stopped.pid, 'SIGKILL')
          } catch {
            return
          }
        }
        const interrupted = () => {
          endHelper()
          process.exit(1)
        }
        process.once('SIGINT', interrupted)
        process.once('SIGTERM', interrupted)
        try {
          const renderer = await openRenderer(home, newScope(), failures)
          const page = await Effect.runPromise(
            renderer.render(`${origin}/page.html?m=BLIND`, MAX_HTML)
          )
          assert.match(text(page.html), /MARKER BLIND/)
          const utility = chromeProcessesOn(userDataDir).find(line =>
            line.includes('--utility-sub-type=network.mojom.NetworkService')
          )
          assert.ok(utility, 'Chrome started a network helper on the fixture copy')
          const utilityPid = Number.parseInt(utility.trimStart(), 10)
          const root = Number(processGroup(utilityPid))
          assert.ok(root > 0 && root !== utilityPid, 'the helper is not the group leader')
          process.kill(utilityPid, 'SIGSTOP')
          helper = { pid: utilityPid, group: root }
          const kept = await Effect.runPromise(blindAdmin.revoke(Duration.seconds(5)))
          assert.equal(kept.kind, 'kept-live')
          assert.ok(existsSync(join(home, 'browser', 'user-data')), 'the uncertain copy was kept')
          const status = await Effect.runPromise(blindAdmin.status)
          assert.equal(status.owner.kind, 'live')
          if (status.owner.kind === 'live')
            assert.match(
              status.owner.activity.unobserved ?? '',
              /Could not verify Chrome helpers stopped/,
              'status names the unverified shutdown'
            )
          assert.equal(status.profile.inUse, true, 'the owner kept the profile lock')
          await Effect.runPromise(blindAdmin.enable)
          const enabled = await Effect.runPromise(blindAdmin.status)
          assert.equal(enabled.profile.enabled, true)
          assert.equal(
            enabled.profile.inUse,
            true,
            'enabling did not erase the unsettled ownership'
          )
          assert.ok(existsSync(userDataDir), 'enabling deleted nothing')
          assert.equal(alive(root), false, 'the Chrome root has exited')
          assert.ok(helperOnCopy(), 'the stopped Chrome helper outlived the root')
          rmSync(flag)
          const stillKept = await Effect.runPromise(blindAdmin.revoke(Duration.seconds(15)))
          assert.equal(stillKept.kind, 'kept-live', 'the surviving helper prevents deletion')
          assert.ok(existsSync(userDataDir), 'the copy was kept after observation recovered')
          assert.ok(helperOnCopy(), 'dev left the surviving helper running')
          assert.equal((await Effect.runPromise(blindAdmin.status)).profile.inUse, true)
        } finally {
          try {
            endHelper()
          } finally {
            process.off('SIGINT', interrupted)
            process.off('SIGTERM', interrupted)
            rmSync(flag, { force: true })
          }
        }
        const removed = await Effect.runPromise(blindAdmin.revoke(Duration.seconds(15)))
        assert.equal(removed.kind, 'removed', 'settlement observed later allows removal')
        await assertCopyReleased(profileOptions(home), 'after observation recovered')
      }
    )
    await claim(
      'a helper that never reports prepared is killed by the bootstrapping lead after ten seconds, leaves no owner and lets the next bootstrap succeed',
      async () => {
        const home = join(fixture, 'hanging')
        mkdirSync(home, { mode: 0o700 })
        const before = ownerProcesses()
        selectOwnerFixture({ ...baseFixture, hang: true })
        const started = Date.now()
        const exit = await Effect.runPromiseExit(
          Effect.scoped(
            Effect.flatMap(
              makeSessionRenderer({
                dataHome: home,
                ensureOwner: ownerBootstrap(home, failures).ensure,
              }),
              renderer => renderer.render(`${origin}/page.html?m=HANG`, MAX_HTML)
            )
          )
        )
        assert.ok(Exit.isFailure(exit))
        assert.match(
          String(Cause.squash(exit.cause)),
          /Browser service not ready within ten seconds/
        )
        assert.ok(Date.now() - started < 15_000, 'the bootstrap budget bounded the wait')
        await waitUntil(
          'the hanging helper to be killed',
          ownerProcesses,
          count => count === before
        )
        assert.ok(!ownerPublished(home))
        selectOwnerFixture(baseFixture)
        const renderer = await openRenderer(home, newScope(), failures)
        const page = await Effect.runPromise(
          renderer.render(`${origin}/page.html?m=AFTERHANG`, MAX_HTML)
        )
        assert.match(text(page.html), /MARKER AFTERHANG/)
      }
    )
    await claim(
      'an owner that no client reaches within its first-client grace exits on its own and unpublishes itself',
      async () => {
        const home = join(fixture, 'unvisited')
        mkdirSync(home, { mode: 0o700 })
        selectOwnerFixture({ ...baseFixture, firstClientGraceMs: 1000 })
        assert.match(await startOwner(home), /started/)
        assert.ok(ownerPublished(home), 'the owner published after commit')
        const { pid } = JSON.parse(readFileSync(join(home, 'browser', 'owner.json'), 'utf8')) as {
          pid: number
        }
        await waitUntil(
          'the unvisited owner to unpublish within its grace',
          () => ownerPublished(home),
          published => !published,
          { attempts: 50, intervalMs: 100 }
        )
        await waitUntil(
          'the unvisited owner to exit after unpublishing',
          () => alive(pid),
          running => !running,
          { attempts: 50, intervalMs: 100 }
        )
        selectOwnerFixture(baseFixture)
      }
    )
    await claim(
      'two leads bootstrapping the same data home at once produce exactly one owner, and both can render through it',
      async () => {
        const home = join(fixture, 'raced')
        mkdirSync(home, { mode: 0o700 })
        const before = ownerProcesses()
        const [first, second] = await Promise.all([startOwner(home), startOwner(home)])
        await waitUntil(
          'the losing helper to exit, leaving one owner',
          ownerProcesses,
          count => count === before + 1
        )
        assert.match(first, /started/)
        assert.match(second, /started/)
        const published = JSON.parse(readFileSync(join(home, 'browser', 'owner.json'), 'utf8')) as {
          pid: number
        }
        const scope = newScope()
        const [a, b] = await Promise.all([
          openRenderer(home, scope, failures),
          openRenderer(home, scope, failures),
        ])
        const [pa, pb] = await Promise.all([
          Effect.runPromise(a.render(`${origin}/page.html?m=RACEA`, MAX_HTML)),
          Effect.runPromise(b.render(`${origin}/page.html?m=RACEB`, MAX_HTML)),
        ])
        assert.match(text(pa.html), /MARKER RACEA/)
        assert.match(text(pb.html), /MARKER RACEB/)
        const after = JSON.parse(readFileSync(join(home, 'browser', 'owner.json'), 'utf8')) as {
          pid: number
        }
        assert.equal(after.pid, published.pid, 'the owner that won the gate still serves')
      }
    )
    await claim(
      'a helper whose bootstrap channel closes after prepared but before commit exits without publishing, starting no Chrome and leaving the data home free',
      async () => {
        const home = join(fixture, 'eof-before-commit')
        mkdirSync(home, { mode: 0o700 })
        selectOwnerFixture(baseFixture)
        const helper = fork(fileURLToPath(OWNER_ENTRY), [], {
          detached: true,
          execArgv: [],
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          env: { ...process.env, DEV_DATA_HOME: home },
        })
        const prepared = new Promise<unknown>(resolve => {
          helper.on('message', (message: unknown) => {
            if (
              typeof message === 'object' &&
              message !== null &&
              'type' in message &&
              message.type === 'prepared'
            )
              resolve(message)
          })
        })
        const exited = new Promise<number | null>(resolve => {
          helper.once('exit', code => resolve(code))
        })
        helper.send({ type: 'prepare', dataHome: home })
        await prepared
        assert.ok(!ownerPublished(home), 'nothing is published before commit')
        helper.disconnect()
        await within(exited, 5000, 'the helper to exit on bootstrap EOF before commit')
        assert.ok(!ownerPublished(home))
        assert.ok(!existsSync(join(home, 'browser', 'user-data')), 'no Chrome copy was made')
        const renderer = await openRenderer(home, newScope(), failures)
        const page = await Effect.runPromise(
          renderer.render(`${origin}/page.html?m=AFTEREOF`, MAX_HTML)
        )
        assert.match(text(page.html), /MARKER AFTEREOF/)
      }
    )
    await claim(
      'enable issued during a revocation is serialized after it: no deletion follows the enable, and the copy ends enabled and intact',
      async () => {
        const home = join(fixture, 'raced')
        const racedAdmin = makeBrowserAdmin(profileOptions(home))
        const busy = await openRenderer(home, newScope(), failures)
        const pending = Effect.runFork(busy.render(`${origin}/slow.html?m=ORDER`, MAX_HTML))
        await renderInFlight(racedAdmin)
        const order: string[] = []
        const revoke = Effect.runPromise(racedAdmin.revoke(Duration.millis(1500))).then(outcome => {
          order.push(`revoke:${outcome.kind}`)
          return outcome
        })
        await waitUntil(
          'the revocation to disable rendering',
          () => Effect.runPromise(racedAdmin.status),
          status => !status.profile.enabled
        )
        const enable = Effect.runPromise(
          racedAdmin.enable.pipe(Effect.andThen(Effect.sync(() => order.push('enable'))))
        )
        const [kept] = await Promise.all([revoke, enable])
        assert.equal(kept.kind, 'kept-live')
        assert.deepEqual(order, ['revoke:kept-live', 'enable'], 'enable waited for the revocation')
        await Effect.runPromise(Fiber.interrupt(pending))
        await holdsFor('the copy survives the finished read after the enable', 300, () =>
          existsSync(join(home, 'browser', 'user-data'))
        )
        const status = await Effect.runPromise(racedAdmin.status)
        assert.equal(status.profile.enabled, true)
        assert.ok(existsSync(join(home, 'browser', 'user-data')), 'the copy survived the enable')
        const page = await Effect.runPromise(busy.render(`${origin}/page.html?m=ENABLED`, MAX_HTML))
        assert.match(text(page.html), /MARKER ENABLED/)
      }
    )
    await claim(
      'owner death fails pending rendering and neither a subsequent read nor revocation reuses or deletes a copy while Chrome survives',
      async () => {
        const home = join(fixture, 'crashed')
        mkdirSync(home, { mode: 0o700 })
        selectOwnerFixture({ ...baseFixture, browserIdleMs: 60_000 })
        const renderer = await openRenderer(home, newScope(), [], Duration.seconds(15))
        await Effect.runPromise(renderer.render(`${origin}/page.html?m=BEFORECRASH`, MAX_HTML))
        const copy = join(home, 'browser', 'user-data')
        const record = join(home, 'browser', 'owner.json')
        const state = join(home, 'browser', 'copy-state.json')
        const published = JSON.parse(readFileSync(record, 'utf8')) as { pid: number }
        const beforeRecord = readFileSync(record, 'utf8')
        const beforeState = readFileSync(state, 'utf8')
        const rootPid = Number(
          execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
            .split('\n')
            .find(
              line =>
                line.includes(`--user-data-dir=${copy}`) && line.includes('--remote-debugging-pipe')
            )
            ?.trim()
            .split(/\s+/)[0]
        )
        assert.ok(
          Number.isInteger(rootPid) && rootPid > 0,
          'the fixture Chrome process is observed'
        )
        const pending = Effect.runFork(renderer.render(`${origin}/slow.html?m=CRASH`, MAX_HTML))
        const crashedAdmin = makeBrowserAdmin(profileOptions(home))
        try {
          await waitFor('the pending render to reach Chrome', () =>
            seen.includes('/slow.html?CRASH') ? true : undefined
          )
          process.kill(rootPid, 'SIGSTOP')
          process.kill(published.pid, 'SIGKILL')
          const outcome = await Effect.runPromise(Fiber.await(pending))
          assert.ok(Exit.isFailure(outcome), 'the interrupted render failed without replay')
          await waitFor('the dead owner to release its profile lock', async () =>
            (await Effect.runPromise(makeBrowserProfileOwner(profileOptions(home)).status)).inUse
              ? undefined
              : true
          )
          assert.ok(
            chromeRunningOn(copy) > 0,
            'Chrome survives the owner despite free kernel locks'
          )
          const next = await Effect.runPromiseExit(
            renderer.render(`${origin}/page.html?m=AFTERCRASH`, MAX_HTML)
          )
          assert.ok(Exit.isFailure(next))
          assert.match(String(Cause.squash(next.cause)), /shutdown is unverified/)
          assert.equal(
            readFileSync(record, 'utf8'),
            beforeRecord,
            'no replacement owner was published'
          )
          assert.equal(readFileSync(state, 'utf8'), beforeState, 'the profile was not refreshed')
          const revoked = await Effect.runPromise(crashedAdmin.revoke(Duration.millis(100)))
          assert.equal(revoked.kind, 'kept-live')
          assert.ok(existsSync(copy), 'revocation retained the uncertain copy')
          assert.ok(
            existsSync(join(home, 'browser', 'disabled')),
            'revocation disabled future rendering'
          )
          await Effect.runPromise(crashedAdmin.enable)
          const bootstrap = await Effect.runPromiseExit(ownerBootstrap(home).ensure)
          assert.ok(Exit.isFailure(bootstrap), 'enable did not erase unverified ownership')
          assert.equal(readFileSync(state, 'utf8'), beforeState)
          assert.equal((await Effect.runPromise(crashedAdmin.status)).owner.kind, 'unavailable')
        } finally {
          await Effect.runPromise(Fiber.interrupt(pending))
          const current = JSON.parse(readFileSync(record, 'utf8')) as { pid: number }
          for (const pid of new Set([published.pid, current.pid, -rootPid])) {
            try {
              process.kill(pid, 'SIGKILL')
            } catch {}
          }
          await waitFor('fixture Chrome to stop', () =>
            chromeRunningOn(copy) === 0 ? true : undefined
          )
          rmSync(record, { force: true })
          selectOwnerFixture(baseFixture)
        }
      }
    )
  }
} finally {
  await close([
    join(fixture, 'unlaunchable'),
    join(fixture, 'unobserved'),
    join(fixture, 'hanging'),
    join(fixture, 'unvisited'),
    join(fixture, 'raced'),
    join(fixture, 'eof-before-commit'),
  ])
}

console.log(JSON.stringify({ result: 'passed', checks: passed }, null, 2))
