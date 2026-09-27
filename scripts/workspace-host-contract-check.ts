// The PTY probe's stub lifecycle is hand-written for fault injection. Its factories are typed
// against the seam (workspace-host-fixture-shapes.ts), so the compiler already rejects a
// missing, mistyped or unproduced field. This check adds what types cannot: every shape the
// stub produces decodes with the schemas the lifecycle client applies to authority
// responses (ID formats, non-empty strings, revision bounds), and decoding keeps every field
// the stub sets.
import assert from 'node:assert/strict'
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  RegisteredCommand,
} from '@earendil-works/pi-coding-agent'
import { Effect, Exit, Schema, Scope } from 'effect'
import {
  WorkspaceError,
  type WorkspaceAttachment,
  type WorkspaceLifecycle,
  type WorkspaceSelection,
} from '../src/workspace-domain.ts'
import { makeWorkspaceHost } from '../src/workspace-host.ts'
import { WorkError } from '../src/work-domain.ts'
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

await claim(
  "the host's /workspace handler reports session-owned work it cannot list or stop, and a malformed command, as notices without selecting a workspace or rejecting Pi's handler",
  async () => {
    const current = descriptor('pre-existing')
    const target = descriptor('managed')
    const selections: WorkspaceSelection[] = []
    const refused = new WorkspaceError({ outcome: 'blocked', message: 'not used by this claim' })
    const attachment: WorkspaceAttachment = {
      binding: makeFixtureBinding({ conversation, descriptor: current }),
      authorize: () => Effect.fail(refused),
      select: selection => {
        selections.push(selection)
        return Effect.fail(refused)
      },
      reportExecution: () => Effect.void,
      handoff: () => Effect.void,
      close: Effect.void,
    }
    const lifecycle: WorkspaceLifecycle = {
      attach: () => Effect.fail(refused),
      inspect: () =>
        Effect.succeed([
          makeFixtureView({
            descriptor: target,
            outcome: 'preserved-for-resume',
            reservationId: fixtureId(112),
          }),
        ]),
      validate: () => Effect.void,
    }
    const notices: { readonly message: string; readonly level: string | undefined }[] = []
    const displayed: unknown[] = []
    let workspaceCommand: RegisteredCommand['handler'] | undefined
    const api = {
      on: () => undefined,
      getAllTools: () => [],
      sendMessage: (message: { readonly content: unknown }) => {
        displayed.push(message.content)
      },
      registerCommand: (name: string, command: Omit<RegisteredCommand, 'name' | 'sourceInfo'>) => {
        if (name === 'workspace') workspaceCommand = command.handler
      },
    } as unknown as ExtensionAPI
    const context = {
      cwd: current.path,
      hasUI: true,
      ui: {
        notify: (message: string, level?: string) => notices.push({ message, level }),
        select: async () => undefined,
        confirm: async () => true,
        getEditorText: () => '',
        setEditorText: () => undefined,
      },
    } as unknown as ExtensionCommandContext
    const scope = Scope.makeUnsafe()
    try {
      const host = await Effect.runPromise(
        Scope.provide(scope)(
          makeWorkspaceHost({
            lifecycle,
            attachment,
            dataHome: conversation.dataHome,
            openSessionManager: () => {
              throw new Error('not used by this claim')
            },
            repositoryRoot: cwd => Effect.succeed(cwd),
          })
        )
      )
      host.extensionFactory(api)
      assert.ok(workspaceCommand, 'the host registered /workspace')
      const resume = `resume ${target.taskId} --workspace ${target.workspaceId}`

      host.setWorkControls({
        running: Effect.fail(new WorkError({ message: 'fixture listing failed' })),
        stopAll: () => Effect.void,
      })
      await workspaceCommand(resume, context)
      host.setWorkControls({
        running: Effect.succeed([
          {
            taskId: 'fixture-work',
            attemptId: 'fixture-attempt',
            kind: 'process',
            status: 'running',
            cwd: current.path,
          },
        ]),
        stopAll: () => Effect.fail(new WorkError({ message: 'fixture stop failed' })),
      })
      await workspaceCommand(resume, context)
      await workspaceCommand('switch', context)

      assert.deepEqual(notices, [
        {
          message:
            'Session-owned work could not be listed, so no switch was started: fixture listing failed',
          level: 'error',
        },
        {
          message:
            'Session-owned work could not be stopped, so no switch was started: fixture stop failed',
          level: 'error',
        },
      ])
      assert.deepEqual(selections, [], 'no workspace was selected')
      assert.equal(host.isParked(), false, 'the host was not parked')
      assert.deepEqual(displayed, [
        'Unknown workspace command "switch". Use list, inspect <task>, or resume <task> [--workspace <workspace>].',
      ])
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
    }
  }
)

console.log(
  JSON.stringify(
    {
      result: 'passed',
      checks: passed,
      limitation:
        'Schema conformance and command-failure notices only; it does not drive the Pi TUI. The stub renders no use or pending rows. workspace-host-real-authority-probe.ts drives the same host against the real authority through grants, native-write grants, a rebind handoff, bindings and inspect views with real use rows.',
    },
    null,
    2
  )
)
