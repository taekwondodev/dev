import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
  utimesSync,
  rmSync,
  symlinkSync,
  linkSync,
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
import { openLifecycle } from './workspace/workspace-test-lifecycle.ts'
import { loadPi, findRecentSession } from '../src/pi-runtime.ts'

const root = mkdtempSync(join(tmpdir(), 'dev-conversation-cleanup-'))
const home = join(root, 'home')
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
for (const category of ['sessions', 'child-sessions']) {
  const directory = join(home, category)
  mkdirSync(directory)
  for (let index = 0; index < 101; index++)
    makeSession(directory, String(index).padStart(3, '0'), 1000 + index)
}
const leads = join(home, 'sessions')
const live = makeSession(leads, 'live', 1)
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
try {
  const attachment = await lifecycle.attach({
    conversation: { sessionId: 'retained', sessionFile: retained, dataHome: home },
    cwd: repository,
  })
  await attachment.authorize({ kind: 'write' })
  await attachment.close()
} finally {
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
      assert.equal(yield* cleanConversations(home, namespace), 2)
      assert.ok(existsSync(live))
      assert.ok(existsSync(retained))
      assert.ok(existsSync(recovery))
      assert.ok(existsSync(malformed))
      assert.ok(existsSync(outside))
      assert.ok(existsSync(join(leads, 'linked.jsonl')))
      assert.ok(existsSync(join(leads, 'hardlinked.jsonl')))
      for (const category of ['sessions', 'child-sessions']) {
        assert.equal(existsSync(join(home, category, '000.jsonl')), false)
        assert.equal(
          readdirSync(join(home, category)).filter(name => /^\d{3}\.jsonl$/.test(name)).length,
          100
        )
      }
      assert.equal(yield* cleanConversations(home, namespace), 0)
      const { api, packageInfo } = yield* loadPi
      const recent = yield* findRecentSession(packageInfo.root, root, leads)
      assert.equal(recent, join(leads, '100.jsonl'))
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
        yield* lease.protect({ path: late, sessionId: 'late' })
        assert.throws(
          () =>
            withDisposableConversation(observer, conversation, () => {
              throw new Error('must not reach deletion')
            }),
          error => error instanceof Error && !error.message.includes('must not reach deletion')
        )
        assert.ok(existsSync(late))
      } finally {
        observer.close()
      }
    }).pipe(Effect.scoped, Effect.provide(services))
  )
  console.log(
    'conversation cleanup: real files, active protection, independent quotas, malformed files, links and idempotence passed'
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}
