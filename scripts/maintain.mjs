import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertNoActiveRuntime, defaultDataHome, sessionDir } from '../src/preferences.mjs'
import { resolvePiPackage } from '../src/pi-runtime.mjs'

function run(command, args, cwd = process.cwd()) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function argument(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function setup() {
  const dataHome = argument('--data-home') ?? defaultDataHome()
  const pi = resolvePiPackage()
  const shared = process.env.DEV_SHARED_SKILLS ?? `${process.env.HOME}/Developer/skills`
  mkdirSync(dataHome, { recursive: true, mode: 0o700 })
  sessionDir(dataHome)
  const observation = {
    node: process.version,
    pi: { version: pi.version, root: pi.root },
    sharedWorkflow: {
      path: shared,
      revision: run('git', ['-C', shared, 'rev-parse', 'HEAD']),
      dirty: run('git', ['-C', shared, 'status', '--porcelain']) !== '',
    },
  }
  writeFileSync(
    join(dataHome, 'dependency-observation.json'),
    `${JSON.stringify(observation, null, 2)}\n`,
    { mode: 0o600 }
  )
  process.stdout.write(`setup recorded dependencies in ${dataHome}\n`)
}

function update() {
  assertNoActiveRuntime(argument('--data-home') ?? defaultDataHome())
  if (run('git', ['status', '--porcelain']) !== '')
    throw new Error(
      'Refusing update: dev checkout has local changes. Preserve them explicitly before updating.'
    )
  const remote = argument('--remote') ?? 'origin'
  const branch = argument('--branch') ?? run('git', ['branch', '--show-current'])
  run('git', ['fetch', remote, branch])
  run('git', ['merge', '--ff-only', `${remote}/${branch}`])
  process.stdout.write(`updated dev checkout from ${remote}/${branch}\n`)
}

function rollback() {
  assertNoActiveRuntime(argument('--data-home') ?? defaultDataHome())
  const ref = argument('--ref')
  if (!ref)
    throw new Error('Rollback requires an explicit --ref and changes only the dev checkout.')
  if (run('git', ['status', '--porcelain']) !== '')
    throw new Error(
      'Refusing rollback: dev checkout has local changes. Preserve them explicitly before rolling back.'
    )
  run('git', ['checkout', '--detach', ref])
  process.stdout.write(
    `rolled dev checkout back to ${ref}; external Pi, workflow, credentials and sessions were not changed\n`
  )
}

const command = process.argv[2] ?? 'setup'
try {
  if (command === 'setup') setup()
  else if (command === 'update') update()
  else if (command === 'rollback') rollback()
  else throw new Error(`Unknown maintenance command "${command}". Use setup, update, or rollback.`)
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
