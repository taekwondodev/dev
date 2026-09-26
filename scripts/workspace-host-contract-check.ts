// The PTY probe's stub lifecycle is hand-written for fault injection. Its factories are typed
// against the seam (workspace-host-fixture-shapes.ts), so the compiler already rejects a
// missing, mistyped or unproduced field. This check adds what types cannot: every shape the
// stub produces decodes with the schemas the lifecycle client applies to authority
// responses (ID formats, non-empty strings, revision bounds), and decoding keeps every field
// the stub sets.
import assert from 'node:assert/strict'
import { Schema } from 'effect'
import { WorkspaceRpcResponseSchema } from '../src/workspace-protocol.ts'
import { makeClaims } from './workspace-check-support.ts'
import {
  fixtureId,
  makeFixtureBinding,
  makeFixtureGrant,
  makeFixtureHandoff,
  makeFixtureView,
  type FixtureDescriptor,
} from './workspace-host-fixture-shapes.ts'

const decodeResponse = Schema.decodeSync(WorkspaceRpcResponseSchema)
// A response the client would accept from the authority, returned unchanged by decoding.
const acceptedUnchanged = (response: typeof WorkspaceRpcResponseSchema.Encoded): void => {
  assert.deepEqual(decodeResponse(response), response)
}

const { claim, passed } = makeClaims()
const namespaceId = fixtureId(32)
const descriptor = (origin: FixtureDescriptor['origin']): FixtureDescriptor => ({
  repoId: fixtureId(41),
  taskId: fixtureId(1),
  workspaceId: fixtureId(origin === 'managed' ? 12 : 11),
  path: `/fixture/projects/${origin}`,
  origin,
  label: 'contract-check',
})
const conversation = {
  sessionId: 'contract-check-session',
  sessionFile: '/fixture/sessions/contract-check.jsonl',
  dataHome: '/fixture/data',
}

await claim(
  'every grant shape the stub issues (read and write, pre-existing and managed, with and without a native-write destination) decodes as an authorization response and keeps every field',
  () => {
    let sequence = 1000
    for (const origin of ['pre-existing', 'managed'] as const)
      for (const access of ['read', 'write'] as const)
        for (const path of [undefined, `/fixture/projects/${origin}/file.txt`]) {
          sequence += 10
          const grant = makeFixtureGrant({
            namespaceId,
            descriptor: descriptor(origin),
            access,
            cwd: descriptor(origin).path,
            sequence,
            ...(path === undefined ? {} : { path }),
          })
          acceptedUnchanged({
            id: sequence,
            ok: true,
            op: 'authorize',
            value: { kind: 'ready', grant },
          })
          acceptedUnchanged({
            id: sequence + 1,
            ok: true,
            op: 'authorize',
            value: { kind: 'ready', grant, warning: 'fixture writer warning' },
          })
        }
  }
)

await claim(
  'the stub binding and its rebind handoff decode as attach, select and rebind responses and keep every field',
  () => {
    const binding = makeFixtureBinding({ conversation, descriptor: descriptor('pre-existing') })
    const handoff = makeFixtureHandoff({
      operationId: fixtureId(900001),
      from: binding,
      target: makeFixtureGrant({
        namespaceId,
        descriptor: descriptor('managed'),
        access: 'write',
        cwd: descriptor('managed').path,
        sequence: 2000,
      }),
      reason: 'fixture competing writer required an isolated workspace',
    })
    acceptedUnchanged({ id: 1, ok: true, op: 'attach', value: { attachmentId: 1, binding } })
    acceptedUnchanged({ id: 2, ok: true, op: 'select', value: handoff })
    acceptedUnchanged({ id: 3, ok: true, op: 'authorize', value: { kind: 'rebind', handoff } })
  }
)

await claim(
  'the stub views for the outcomes it renders decode as an inspect response and keep every field',
  () => {
    acceptedUnchanged({
      id: 1,
      ok: true,
      op: 'inspect',
      value: (['active', 'preserved-for-resume'] as const).map(outcome =>
        makeFixtureView({
          descriptor: descriptor('managed'),
          outcome,
          reservationId: fixtureId(111),
        })
      ),
    })
  }
)

console.log(
  JSON.stringify(
    {
      result: 'passed',
      checks: passed,
      limitation:
        'Schema conformance only; it does not drive the Pi TUI. The stub renders no use or pending rows. workspace-host-real-authority-probe.ts drives the same host against the real authority through grants, native-write grants, a rebind handoff, bindings and inspect views with real use rows.',
    },
    null,
    2
  )
)
