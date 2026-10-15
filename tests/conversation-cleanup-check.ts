import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  readdirSync,
  utimesSync,
  rmSync,
  symlinkSync,
  linkSync,
  unlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeServices } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { cleanConversations } from '../src/conversation-cleanup.ts'
import { WorkStore } from '../src/work-store.ts'
import { AttemptId, GenerationId, SessionId, TaskId } from '../src/work-domain.ts'
import { acquireRuntime } from '../src/runtime-coordination.ts'
import { WorkspaceAuthority } from '../src/workspace-authority.ts'
import { withDisposableConversation } from '../src/workspace-retention.ts'
import { makeWorkspaceLifecycle } from '../src/workspace-lifecycle.ts'
import { openLifecycle } from './workspace/workspace-test-lifecycle.ts'
import { loadPi, findRecentSession } from '../src/pi-runtime.ts'

const root = mkdtempSync(join(tmpdir(), 'dev-conversation-cleanup-'))
const home = join(root, 'home')
const otherHome = join(root, 'other-home')
const namespace = join(root, 'authority')
const installation = join(root, 'installation')
mkdirSync(home)
mkdirSync(installation)
const authority = new WorkspaceAuthority(namespace)
authority.initialize()
authority.close()
const makeSession = (directory: string, name: string, time: number) => {
  const path = join(directory, `${name}.jsonl`)
  writeFileSync(
    path,
    `${JSON.stringify({ type: 'session', version: 3, id: name, timestamp: '2026-01-01T00:00:00Z', cwd: root })}\n`
  )
  utimesSync(path, time, time)
  return path
}
for (const dataHome of [home, otherHome]) {
  for (const category of ['sessions', 'child-sessions']) {
    const directory = join(dataHome, category)
    mkdirSync(directory, { recursive: true })
    for (let index = 0; index < 101; index++)
      makeSession(directory, String(index).padStart(3, '0'), 1000 + index)
  }
}
const leads = join(home, 'sessions')
const futureEntry = join(leads, '000.jsonl')
appendFileSync(
  futureEntry,
  `${JSON.stringify({ type: 'entry_kind_from_a_newer_pi', id: 'x', parentId: null, timestamp: 'now' })}\n`
)
utimesSync(futureEntry, 1000, 1000)
const live = makeSession(leads, 'live', 1)
const active = makeSession(leads, 'active', 5000)
const retained = makeSession(leads, 'retained', 2)
const recovery = makeSession(join(home, 'child-sessions'), 'recovery', 1)
const repository = join(root, 'repository')
mkdirSync(repository)
for (const args of [
  ['init', '--quiet', '-b', 'main'],
  [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--allow-empty',
    '--quiet',
    '-m',
    'fixture',
  ],
])
  execFileSync('git', ['-C', repository, ...args])
const lifecycle = await openLifecycle({ root: namespace })
const attachment = await lifecycle.attach({
  conversation: { sessionId: 'retained', sessionFile: retained, dataHome: home },
  cwd: repository,
})
try {
  await attachment.authorize({ kind: 'write' })
} finally {
  await attachment.close()
  await lifecycle.close()
}
const malformed = join(leads, 'malformed.jsonl')
writeFileSync(malformed, '{')
const outside = join(root, 'outside.jsonl')
writeFileSync(outside, '{"type":"session","id":"outside","timestamp":"now","cwd":"/"}\n')
symlinkSync(outside, join(leads, 'linked.jsonl'))
linkSync(outside, join(leads, 'hardlinked.jsonl'))
const services = WorkStore.layer(home, SessionId.make('cleanup-fixture')).pipe(
  Layer.provideMerge(NodeServices.layer)
)
try {
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* WorkStore
      const unresolved = yield* store.create(
        AttemptId.make('00000000-0000-0000-0000-000000000001'),
        {
          kind: 'agent',
          cwd: root,
          controllerPid: process.pid,
          owner: {
            sessionId: SessionId.make('cleanup-fixture'),
            taskId: TaskId.make('recovery'),
            generation: GenerationId.make('fixture'),
          },
        }
      )
      yield* store.save({
        ...unresolved,
        revision: 1,
        status: 'unknown',
        completedAt: undefined,
        sessionFile: recovery,
      })
      const lease = yield* acquireRuntime(home, {
        installationPath: installation,
        namespacePath: namespace,
      })
      yield* lease.protect({ path: live, sessionId: 'live' })
      assert.equal(yield* lease.creating(cleanConversations(home, namespace)), 0)
      assert.equal(
        yield* lease.navigate(cleanConversations(home, namespace), () => ({
          path: live,
          sessionId: 'live',
        })),
        0
      )
      yield* lease.protect({ path: active, sessionId: 'active' })
      assert.equal(yield* cleanConversations(home, namespace), 2)
      assert.ok(existsSync(live))
      assert.ok(existsSync(active))
      assert.ok(existsSync(retained))
      assert.ok(existsSync(recovery))
      assert.ok(existsSync(malformed))
      assert.ok(existsSync(outside))
      assert.ok(existsSync(join(leads, 'linked.jsonl')))
      assert.ok(existsSync(join(leads, 'hardlinked.jsonl')))
      for (const category of ['sessions', 'child-sessions'])
        assert.ok(existsSync(join(otherHome, category, '000.jsonl')))
      assert.equal(
        yield* cleanConversations(otherHome, namespace).pipe(
          Effect.provide(
            WorkStore.layer(otherHome, SessionId.make('other-home')).pipe(
              Layer.provide(NodeServices.layer)
            )
          )
        ),
        2
      )
      for (const dataHome of [home, otherHome]) {
        for (const category of ['sessions', 'child-sessions']) {
          assert.equal(existsSync(join(dataHome, category, '000.jsonl')), false)
          assert.equal(
            readdirSync(join(dataHome, category)).filter(name => /^\d{3}\.jsonl$/.test(name))
              .length,
            100
          )
        }
      }
      assert.equal(yield* cleanConversations(home, namespace), 0)
      const { api, packageInfo } = yield* loadPi
      const recent = yield* findRecentSession(packageInfo.root, root, leads)
      assert.equal(recent, active)
      const resumed = api.SessionManager.open(join(leads, '001.jsonl'), leads, root)
      assert.equal(resumed.getSessionId(), '001')
      const late = makeSession(leads, 'late', 3)
      const observer = new WorkspaceAuthority(namespace)
      const conversation = { sessionId: 'late', sessionFile: late, dataHome: home }
      try {
        assert.equal(
          withDisposableConversation(observer, conversation, () => true),
          true
        )
        const { taskId, workspaceId } = attachment.binding
        assert.ok(taskId)
        const lateLifecycle = yield* makeWorkspaceLifecycle({ root: namespace })
        const lateAttachment = yield* lateLifecycle.attach({
          conversation,
          cwd: repository,
          selection: { taskId, workspaceId },
        })
        yield* lateAttachment.close
        assert.equal(
          withDisposableConversation(observer, conversation, () => {
            unlinkSync(late)
            return 'deleted'
          }),
          undefined
        )
        assert.ok(existsSync(late))
      } finally {
        observer.close()
      }
    }).pipe(Effect.scoped, Effect.provide(services))
  )
  console.log(
    'conversation cleanup: independent home/category quotas, active and recovery protection, durable admission revalidation, unknown entries, malformed files, links and idempotence passed'
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}
