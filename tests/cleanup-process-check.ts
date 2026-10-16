import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  realpathSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout } from 'node:timers/promises'
import { WorkspaceAuthority } from '../src/workspace-authority.ts'
import { Effect } from 'effect'
import { acquireCleanupRuntime, acquireMaintenance } from '../src/runtime-coordination.ts'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'dev-cleanup-process-')))
try {
  const home = join(root, 'home')
  const installation = join(root, 'installation')
  const namespace = join(root, 'authority')
  mkdirSync(join(home, 'sessions'), { recursive: true })
  mkdirSync(installation)
  const authority = new WorkspaceAuthority(namespace)
  authority.initialize()
  authority.close()
  for (let index = 0; index < 101; index++) {
    const name = String(index).padStart(3, '0')
    writeFileSync(
      join(home, 'sessions', `${name}.jsonl`),
      `${JSON.stringify({ type: 'session', id: name, timestamp: '2026-01-01T00:00:00Z', cwd: root })}\n`
    )
  }
  const oldest = join(home, 'sessions', '000.jsonl')
  const coordination = { installationPath: installation, namespacePath: namespace }
  const args = [
    fileURLToPath(new URL('../src/cleanup-runtime.ts', import.meta.url)),
    JSON.stringify({ dataHome: home, trigger: 'startup', coordination }),
  ]
  const run = () => spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10000 })
  for (const hold of [
    acquireMaintenance(coordination),
    acquireCleanupRuntime(home, coordination),
  ]) {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* hold
        const skipped = run()
        assert.equal(skipped.status, 1, skipped.stderr)
        assert.ok(existsSync(oldest))
      }).pipe(Effect.scoped)
    )
  }
  const retried = run()
  assert.equal(retried.signal, null, retried.stderr)
  assert.notEqual(retried.status, null, retried.stderr)
  assert.equal(existsSync(oldest), false)
  const marker = join(root, 'cleaner-pid.json')
  const parent = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
      import childProcess from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { requestCleanup } from ${JSON.stringify(new URL('../src/cleanup-launch.ts', import.meta.url).href)};
      childProcess.spawn = new Proxy(childProcess.spawn, {
        apply(target, receiver, args) {
          const child = Reflect.apply(target, receiver, args);
          writeFileSync(${JSON.stringify(marker)}, JSON.stringify(child.pid));
          child.kill('SIGSTOP');
          return child;
        },
      });
      syncBuiltinESMExports();
      requestCleanup(${JSON.stringify(home)}, 'startup', ${JSON.stringify(coordination)});
    `,
    ],
    { encoding: 'utf8', timeout: 10000 }
  )
  const pid = JSON.parse(readFileSync(marker, 'utf8')) as number
  process.kill(pid, 0)
  process.kill(pid, 'SIGCONT')
  let exited = false
  const deadline = Date.now() + 20000
  while (!exited && Date.now() < deadline) {
    try {
      process.kill(pid, 0)
      await setTimeout(25)
    } catch (error) {
      assert.match(String(error), /ESRCH/)
      exited = true
    }
  }
  assert.ok(exited, 'cleanup process did not exit after resuming')
  assert.equal(parent.status, 0, parent.stderr)
  console.log(
    'cleanup process: maintenance/singleton contention, retry and natural parent exit with cleanup stopped passed'
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}
