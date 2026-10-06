import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'dev-launcher-cache-'))
try {
  const blocked = join(sandbox, 'not-a-directory')
  writeFileSync(blocked, '')
  for (const mode of ['enabled', 'disabled', 'unavailable'] as const) {
    const preload = `import assert from 'node:assert/strict';
      import { getCompileCacheDir, registerHooks } from 'node:module';
      registerHooks({
        resolve(specifier, context, nextResolve) {
          assert.notEqual(specifier, '@effect/platform-node', 'launcher startup must use specific platform modules');
          if (specifier === './launcher-runtime.ts')
            assert.equal(process.env.DEV_CODING_AGENT, 'true', 'launcher sets its identity before loading the runtime');
          return nextResolve(specifier, context);
        },
      });
      process.on('exit', () => assert.equal(getCompileCacheDir() !== undefined, ${mode === 'enabled'}));`
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        `data:text/javascript,${encodeURIComponent(preload)}`,
        'src/launcher.ts',
        '--help',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          TMPDIR: mode === 'unavailable' ? blocked : join(sandbox, mode),
          NODE_COMPILE_CACHE: undefined,
          NODE_DISABLE_COMPILE_CACHE: mode === 'disabled' ? '1' : undefined,
        },
        timeout: 30_000,
      }
    )
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Usage: dev \[options\]/)
  }
  assert.ok(
    readdirSync(join(sandbox, 'enabled', 'node-compile-cache'), { recursive: true }).length > 1
  )
  console.log('launcher startup: specific platform imports and compile cache modes passed')
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}
