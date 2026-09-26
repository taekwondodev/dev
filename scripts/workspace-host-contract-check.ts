// The PTY probe's stub lifecycle is hand-written for fault injection, so a field or enum
// the real authority gains would otherwise leave that probe passing against a stale seam.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Schema } from 'effect'
import {
  WorkspaceGrantSchema,
  type WorkspaceBinding,
  type WorkspaceGrant,
  type WorkspaceHandoff,
  type WorkspaceView,
} from '../src/workspace-domain.ts'
import { makeWorkspaceLifecycle } from '../src/workspace-lifecycle.ts'
import {
  fixtureId,
  makeFixtureBinding,
  makeFixtureGrant,
  makeFixtureHandoff,
  makeFixtureView,
} from './workspace-host-fixture-shapes.ts'

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'dev-workspace-host-contract-')))
const git = (args: readonly string[], cwd: string): string => {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout.trim()
}
const conversation = (name: string) => {
  const dataHome = join(sandbox, `data-${name}`)
  mkdirSync(dataHome, { recursive: true })
  const sessionFile = join(dataHome, 'session.jsonl')
  writeFileSync(sessionFile, '{}\n', { mode: 0o600 })
  return { sessionId: `session-${name}`, sessionFile, dataHome }
}

const VIEW_OUTCOMES = ['active', 'preserved-for-resume', 'blocked', 'review-required'] as const
// Compile-time drift guard: typecheck fails if WorkspaceView['outcome'] gains or loses a
// member, so the runtime list above cannot silently fall behind the domain contract.
const outcomesMatchDomain: (typeof VIEW_OUTCOMES)[number] extends WorkspaceView['outcome']
  ? WorkspaceView['outcome'] extends (typeof VIEW_OUTCOMES)[number]
    ? true
    : never
  : never = true
void outcomesMatchDomain

const failures: string[] = []
const coverageGaps: string[] = []
const describeType = (value: unknown): string => {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

const compareShape = (label: string, realInput: object, fixtureInput: object): void => {
  const real = realInput as Record<string, unknown>
  const fixture = fixtureInput as Record<string, unknown>
  for (const [key, value] of Object.entries(real)) {
    if (value === undefined) continue
    if (!(key in fixture)) {
      failures.push(`${label}: real authority produces "${key}" but the fixture omits it`)
      continue
    }
    const fixtureValue = fixture[key]
    if (describeType(fixtureValue) !== describeType(value))
      failures.push(
        `${label}: field "${key}" is ${describeType(value)} in the authority but ${describeType(fixtureValue)} in the fixture`
      )
  }
  for (const key of Object.keys(fixture))
    if (!(key in real) && fixture[key] !== undefined)
      coverageGaps.push(`${label}: fixture invents field "${key}" that this authority path omits`)
}

try {
  const repo = join(sandbox, 'repo')
  mkdirSync(repo)
  git(['init', '--quiet', '-b', 'main'], repo)
  git(['config', 'user.name', 'Host Contract Check'], repo)
  git(['config', 'user.email', 'host-contract@example.invalid'], repo)
  writeFileSync(join(repo, 'tracked.txt'), 'contract fixture\n')
  git(['add', 'tracked.txt'], repo)
  git(['commit', '--quiet', '-m', 'contract-fixture'], repo)

  const lifecycle = makeWorkspaceLifecycle({ root: join(sandbox, 'authority') })
  const primary = await lifecycle.attach({ conversation: conversation('primary'), cwd: repo })
  const admission = await primary.authorize({ access: 'write' })
  assert.equal(admission.kind, 'ready')
  const realGrant: WorkspaceGrant = admission.grant
  const realBinding: WorkspaceBinding = primary.binding

  // A native file write is the only grant that carries the validated destination path.
  const nativeWrite = await primary.authorize({
    access: 'write',
    effect: 'native-file-write',
    within: realGrant,
    path: 'tracked.txt',
  })
  assert.equal(nativeWrite.kind, 'ready')
  const realPathGrant: WorkspaceGrant = nativeWrite.grant
  assert.equal(realPathGrant.path, join(repo, 'tracked.txt'))
  await primary.reportExecution(realPathGrant, { kind: 'operation-started' })
  await primary.reportExecution(realPathGrant, { kind: 'operation-completed' })

  const contender = await lifecycle.attach({ conversation: conversation('contender'), cwd: repo })
  const contended = await contender.authorize({ access: 'write' })
  assert.equal(contended.kind, 'rebind')
  const realHandoff: WorkspaceHandoff = contended.handoff

  const realViews = await lifecycle.inspect({})
  const realView: WorkspaceView | undefined = realViews[0]
  if (realView === undefined) throw new Error('Authority produced no workspace view to compare')

  const realTaskId = realGrant.taskId
  if (realTaskId === undefined)
    throw new Error('Real write grant carried no task identity to compare against the fixture')
  const descriptor = {
    repoId: realGrant.repositoryId,
    taskId: realTaskId,
    workspaceId: realGrant.workspaceId,
    path: realGrant.checkout,
    origin: realGrant.origin,
    label: 'contract-check',
  }
  const fixtureGrant = makeFixtureGrant({
    namespaceId: realGrant.namespaceId,
    descriptor,
    access: 'write',
    cwd: realGrant.cwd,
    sequence: 1000,
  })
  const fixturePathGrant = makeFixtureGrant({
    namespaceId: realGrant.namespaceId,
    descriptor,
    access: 'write',
    cwd: realPathGrant.cwd,
    sequence: 1010,
    path: join(realPathGrant.cwd, 'tracked.txt'),
  })
  const fixtureView = makeFixtureView({
    descriptor,
    outcome: 'active',
    reservationId: fixtureId(111),
  })
  const fixtureBinding = makeFixtureBinding({
    conversation: conversation('fixture-binding'),
    descriptor,
  })
  const fixtureHandoff = makeFixtureHandoff({
    operationId: fixtureId(2000),
    from: fixtureBinding,
    target: fixtureGrant,
    reason: 'contract-check handoff',
  })

  for (const [label, candidate] of [
    ['fixture grant', fixtureGrant],
    ['fixture native-file-write grant', fixturePathGrant],
    ['fixture handoff target', fixtureHandoff.target],
  ] as const) {
    try {
      Schema.decodeUnknownSync(WorkspaceGrantSchema)(candidate)
    } catch (cause) {
      failures.push(`${label} no longer decodes against WorkspaceGrantSchema: ${String(cause)}`)
    }
  }

  compareShape('grant', realGrant, fixtureGrant)
  compareShape('native-file-write grant', realPathGrant, fixturePathGrant)
  compareShape('binding', realBinding, fixtureBinding)
  compareShape('handoff', realHandoff, fixtureHandoff)
  compareShape('view', realView, fixtureView)

  // Enum agreement: a fixture value the authority would never emit misleads the host.
  for (const outcome of ['active', 'preserved-for-resume'] as const)
    if (!VIEW_OUTCOMES.includes(outcome))
      failures.push(`fixture view outcome "${outcome}" is not a WorkspaceView outcome`)
  const realOutcomes = new Set(realViews.map(view => view.outcome))
  coverageGaps.push(
    `view: this authority path produced outcomes ${[...realOutcomes].join(', ')}; the fixture also renders ones it did not`
  )

  // The fixture renders no use or pending rows, so the host's rendering of those is
  // exercised only in its empty form. Record it rather than implying coverage.
  if (fixtureView.uses.length === 0)
    coverageGaps.push('view: fixture always reports an empty `uses` list')
  if (fixtureView.pending.length === 0)
    coverageGaps.push('view: fixture always reports an empty `pending` list')

  await contender.close()
  await primary.close()
  await lifecycle.close()

  if (failures.length > 0) {
    console.error(JSON.stringify({ result: 'failed', failures, coverageGaps }, null, 2))
    process.exitCode = 1
  } else {
    console.log(
      JSON.stringify(
        {
          result: 'passed',
          checks: [
            'fixture ordinary grant, native-file-write grant and handoff target decode against the real WorkspaceGrantSchema',
            'every field the real authority produces on grants, bindings, handoffs and views exists on the fixture shape with the same type',
            'a real rebind handoff from real contention matches the fixture handoff shape',
            'fixture view outcomes are real WorkspaceView outcomes',
          ],
          coverageGaps,
          limitation:
            'Shape and enum conformance only: this check does not itself drive the Pi TUI. The real TUI against the real authority is covered by workspace-host-real-authority-probe.ts, which also renders the real use rows the stub always leaves empty.',
        },
        null,
        2
      )
    )
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}
