import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { WorkspaceAuthority } from '../src/workspace-authority.ts'
import { Effect } from 'effect'
import { acquireCleanupRuntime, acquireMaintenance } from '../src/runtime-coordination.ts'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'dev-cleanup-process-')))
try {
  for (const trigger of ['startup', 'graceful-exit']) {
    const home = join(root, trigger)
    const installation = join(root, `${trigger}-installation`)
    const namespace = join(root, `${trigger}-authority`)
    mkdirSync(join(home, 'sessions'), { recursive: true })
    mkdirSync(installation)
    const authority = new WorkspaceAuthority(namespace)
    authority.initialize()
    authority.close()
    for (let index = 0; index < 101; index++) {
      const name = String(index).padStart(3, '0')
      writeFileSync(
        join(home, 'sessions', `${name}.jsonl`),
        `${JSON.stringify({
          type: 'session',
          id: name,
          timestamp: '2026-01-01T00:00:00Z',
          cwd: root,
        })}\n`
      )
    }
    const oldest = join(home, 'sessions', '000.jsonl')
    const coordination = { installationPath: installation, namespacePath: namespace }
    for (const hold of [
      acquireMaintenance(coordination),
      acquireCleanupRuntime(home, coordination),
    ]) {
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* hold
          const skipped = spawnSync(
            process.execPath,
            [
              fileURLToPath(new URL('../src/cleanup-runtime.ts', import.meta.url)),
              JSON.stringify({ dataHome: home, trigger, coordination }),
            ],
            { encoding: 'utf8', timeout: 10000 }
          )
          assert.equal(skipped.status, 1)
          assert.ok(existsSync(oldest))
        }).pipe(Effect.scoped)
      )
    }
    const parent = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { requestCleanup } from ${JSON.stringify(new URL('../src/cleanup-launch.ts', import.meta.url).href)};
      import { existsSync } from 'node:fs';
      requestCleanup(${JSON.stringify(home)}, ${JSON.stringify(trigger)}, ${JSON.stringify({ installationPath: installation, namespacePath: namespace })});
      console.log(existsSync(${JSON.stringify(oldest)}));
      process.exit(0);
    `,
      ],
      { encoding: 'utf8', timeout: 10000 }
    )
    assert.equal(parent.status, 0, parent.stderr)
    assert.equal(parent.stdout.trim(), 'true')
    const deadline = Date.now() + 20000
    while (existsSync(oldest) && Date.now() < deadline) await setTimeout(25)
    assert.equal(existsSync(oldest), false, `${trigger}: cleanup did not survive parent exit`)
  }
  console.log(
    'cleanup process: both lifecycle requests survive immediate parent exit without awaiting cleanup'
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}
