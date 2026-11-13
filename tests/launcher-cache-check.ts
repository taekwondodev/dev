import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const inherit = (env: NodeJS.ProcessEnv): { parent?: string; child?: string; leaked: unknown } => {
  const probe = `
    import { enableCompileCache, getCompileCacheDir } from 'node:module'
    import { spawnSync } from 'node:child_process'
    enableCompileCache()
    const { withCompileCache } = await import('./src/compile-cache.ts')
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', \`
      import { getCompileCacheDir } from 'node:module'
      const child = getCompileCacheDir()
      const { adoptCompileCache } = await import('./src/compile-cache.ts')
      adoptCompileCache()
      console.log(JSON.stringify({
        child,
        leaked: [process.env.NODE_COMPILE_CACHE, process.env.DEV_COMPILE_CACHE_INHERITED].filter(value => value !== undefined),
      }))
    \`], { encoding: 'utf8', env: withCompileCache(process.env) })
    console.log(JSON.stringify({ parent: getCompileCacheDir(), ...JSON.parse(child.stdout) }))`
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', probe], {
    encoding: 'utf8',
    env,
    timeout: 30_000,
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

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
          assert.notEqual(specifier, 'effect', 'launcher startup must use specific Effect modules');
          assert.ok(specifier !== 'linkedom' && specifier !== '@mozilla/readability', 'launcher startup must not load the HTML libraries');
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
  const base = { ...process.env, TMPDIR: join(sandbox, 'inherit'), NODE_COMPILE_CACHE: undefined }
  const inherited = inherit(base)
  assert.ok(inherited.parent !== undefined, 'the parent enabled its compile cache')
  assert.equal(inherited.child, inherited.parent, 'a child runtime shares the parent cache')
  assert.deepEqual(inherited.leaked, [], 'the child keeps the cache out of its own environment')
  const chosen = join(sandbox, 'chosen')
  const kept = inherit({ ...base, NODE_COMPILE_CACHE: chosen })
  assert.equal(kept.child, kept.parent, 'a cache chosen by the user reaches the child unchanged')
  assert.deepEqual(kept.leaked, [chosen], 'a cache chosen by the user stays in the environment')
  for (const entry of ['src/pi-child.ts', 'src/cleanup-runtime.ts', 'src/web-browser-owner.ts']) {
    const started = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `import { getCompileCacheDir } from 'node:module'
        await import('./${entry}')
        console.log(JSON.stringify({
          active: getCompileCacheDir() !== undefined,
          leaked: [process.env.NODE_COMPILE_CACHE, process.env.DEV_COMPILE_CACHE_INHERITED].filter(value => value !== undefined),
        }))`,
      ],
      {
        encoding: 'utf8',
        env: { ...base, NODE_COMPILE_CACHE: chosen, DEV_COMPILE_CACHE_INHERITED: '1' },
        timeout: 30_000,
      }
    )
    assert.equal(started.status, 0, started.stderr)
    assert.deepEqual(
      JSON.parse(started.stdout),
      { active: true, leaked: [] },
      `${entry} uses the inherited cache and removes it from its environment`
    )
  }
  console.log(
    'launcher startup: specific module imports, deferred HTML libraries and compile cache modes passed'
  )
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}
