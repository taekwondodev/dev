import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const checkout = fileURLToPath(new URL('..', import.meta.url))
const { scripts } = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}
const config = JSON.parse(readFileSync(join(checkout, '.oxlintrc.json'), 'utf8')) as {
  extends: string[]
  jsPlugins: { name: string; specifier: string }[]
}

const absolutePlugins = () =>
  config.jsPlugins.map(({ name, specifier }) => ({ name, specifier: resolve(checkout, specifier) }))

const lintFlags = (script: string): string[] => {
  const command = /(?:^|&& )oxlint ([^&]*)$/.exec(script)?.[1]
  assert.ok(command, `npm run lint ends with an oxlint command: ${script}`)
  return command
    .trim()
    .split(/\s+/)
    .filter(flag => flag !== '.')
}

const timers = "import { setTimeout as sleep } from 'node:timers/promises'"
const files: Record<string, string> = {
  'tests/flagged.ts': [
    timers,
    "import * as timers from 'node:timers/promises'",
    "import { scheduler } from 'node:timers/promises'",
    "import * as Effect from 'effect/Effect'",
    'export const awaited = async () => {',
    '  await sleep(20)',
    '  await new Promise(resolve => setTimeout(resolve, 100))',
    '  await new Promise<void>(resolve => { setTimeout(() => resolve(), 100) })',
    '  while (Date.now() < 0) await timers.setTimeout(5)',
    '  await scheduler.wait(5)',
    '}',
    'export const pause = () => sleep(100)',
    'export const raced = Promise.race([Promise.resolve(1), sleep(5000)])',
    'export const slept = Effect.gen(function* () { yield* Effect.sleep(80) })',
    '',
  ].join('\n'),
  'tests/allowed.ts': [
    "import * as Effect from 'effect/Effect'",
    'export const later = (action: () => void) => setTimeout(action, 1500)',
    'export const slow = Effect.succeed(1).pipe(Effect.delay(300))',
    '',
  ].join('\n'),
  'tests/wait.ts': [timers, 'export const pause = () => sleep(100)', ''].join('\n'),
  'src/runtime.ts': [timers, 'export const backoff = () => sleep(100)', ''].join('\n'),
  'src/worded.ts': [
    "export const refusal = 'The lead must wait for the sweep'",
    ['export const counted = (runs: number) => `$', '{runs} attempts`'].join(''),
    "export const role = 'lead'",
    "export const query = 'SELECT id FROM reservations WHERE id = ?'",
    "export const plain = 'Dev must switch checkouts first'",
    "export const refused = 'Cannot UPDATE during the sweep'",
    'declare const count: (value: number, noun: string) => string',
    ['export const freed = (n: number) => `✓ $', "{count(n, 'reservation')} released`"].join(''),
    ['export const scope = (parent?: string) => `$', "{parent ?? 'lead'}:`"].join(''),
    "export const first = 'DELETE cannot run during the sweep.'",
    "export const state = (name: string) => name + ' is ' + 'parked'",
    "export const file = (directory: string) => directory + '/' + 'attempts'",
    "export const noun = 'The task keeps this workspace'",
    "export const named = 'Run dev workspace release 1, /workspace resume or [dev workspace]'",
    "const ROLE = 'lead'",
    ['export const waits = (runs: number) => `The $', '{ROLE} has $', '{runs} runs`'].join(''),
    "const STATES = { held: 'parked', free: 'open' } as const",
    "export const seen = (state: 'held' | 'free') => 'Now ' + STATES[state]",
    "const KIND = 'child'",
    'export const same = (kind: string) => kind === KIND',
    "export const shown = 'dev/work-outcome'",
    "export const label = 'dev/workspace-switch'",
    '',
  ].join('\n'),
  'tests/worded.ts': ["export const name = 'the lead waits for the sweep'", ''].join('\n'),
  'tests/disabled-line.ts': [
    timers,
    'export const f = async () => {',
    '  // oxlint-disable-next-line dev/no-fixed-sleep',
    '  await sleep(20)',
    '}',
    '',
  ].join('\n'),
  'tests/disabled-file.ts': [
    '/* oxlint-disable */',
    timers,
    'export const f = async () => { await sleep(20) }',
    '',
  ].join('\n'),
  'tests/disabled-later.ts': [
    timers,
    '/* eslint-disable dev/no-fixed-sleep, dev/no-source-comments */',
    'export const f = async () => { await sleep(20) }',
    '',
  ].join('\n'),
  'tests/nested/.oxlintrc.json': JSON.stringify({
    jsPlugins: absolutePlugins(),
    rules: { 'dev/no-fixed-sleep': 'off', 'dev/no-source-comments': 'off' },
  }),
  'tests/nested/sleeps.ts': [timers, 'export const f = async () => { await sleep(20) }', ''].join(
    '\n'
  ),
}

const expected: Record<string, string[]> = {
  'tests/flagged.ts': [6, 7, 8, 9, 10, 12, 13, 14].map(line => `no-fixed-sleep:${line}`),
  'src/worded.ts': [1, 2, 6, 8, 10, 11, 13, 15, 17, 21].map(line => `no-internal-terms:${line}`),
  'tests/disabled-line.ts': ['no-source-comments:1'],
  'tests/disabled-file.ts': ['no-source-comments:1'],
  'tests/disabled-later.ts': ['no-source-comments:1'],
  'tests/nested/sleeps.ts': ['no-fixed-sleep:2'],
}

interface Diagnostic {
  readonly code: string
  readonly filename: string
  readonly labels: readonly { readonly span: { readonly line: number } }[]
}

const fixture = mkdtempSync(join(tmpdir(), 'dev-code-policy-'))
try {
  writeFileSync(
    join(fixture, '.oxlintrc.json'),
    JSON.stringify({
      ...config,
      extends: config.extends.map(path => resolve(checkout, path)),
      jsPlugins: absolutePlugins(),
    })
  )
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(fixture, path)), { recursive: true })
    writeFileSync(join(fixture, path), content)
  }
  const flags = lintFlags(scripts.lint ?? '')
  assert.ok(flags.includes('--disable-nested-config'), 'lint ignores nested lint configurations')
  const linted = spawnSync(
    join(checkout, 'node_modules', '.bin', 'oxlint'),
    [...flags.filter(flag => !flag.startsWith('--max-warnings')), '-f', 'json', '.'],
    { cwd: fixture, encoding: 'utf8' }
  )
  assert.equal(linted.error, undefined)
  const output = linted.stdout
  const reported: Record<string, string[]> = {}
  for (const diagnostic of (JSON.parse(output) as { diagnostics: Diagnostic[] }).diagnostics) {
    const rule = /^dev\((.+)\)$/.exec(diagnostic.code)?.[1]
    if (rule === undefined) continue
    for (const label of diagnostic.labels)
      (reported[diagnostic.filename] ??= []).push(`${rule}:${label.span.line}`)
  }
  for (const lines of Object.values(reported)) lines.sort((a, b) => a.localeCompare(b))
  for (const lines of Object.values(expected)) lines.sort((a, b) => a.localeCompare(b))
  assert.deepEqual(reported, expected)
  console.log(
    'code policy: fixed delays in tests, internal terms in src text, line, file and later disable directives, and nested lint configurations passed'
  )
} finally {
  rmSync(fixture, { recursive: true, force: true })
}
