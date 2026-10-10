import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Effect, ManagedRuntime } from 'effect'
import { WorkOwner } from '../../src/work-controller.ts'
import type {
  AgentStartRequest,
  AttemptView,
  WorkFailure,
  WorkOwnerService,
} from '../../src/work-domain.ts'
import type { WorkspaceAttachment } from '../../src/workspace-domain.ts'
import { installProfileFixture } from '../profile-fixture.ts'
import { ownerEffect, waitFor, within } from '../workspace/workspace-check-support.ts'
import { openLifecycle } from '../workspace/workspace-test-lifecycle.ts'
import { CHILD_MODEL, MODEL_CALLS, SCRIPT_MARKER } from './work-child-model.ts'

export const script = (steps: readonly unknown[]): string =>
  `${SCRIPT_MARKER}${JSON.stringify(steps)}`

const runGit = (cwd: string, args: readonly string[]): string =>
  execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()

const WAIT_LIMIT_MS = 60_000
const POLL_INTERVAL_MS = 50
const TIMING = { attempts: WAIT_LIMIT_MS / POLL_INTERVAL_MS, intervalMs: POLL_INTERVAL_MS }

export const settled = (record: AttemptView): boolean =>
  record.status !== 'running' && record.status !== 'waiting'

const FAILURE_FACTS = [
  'error',
  'protocolError',
  'cleanupError',
  'observationError',
  'persistenceError',
] as const

export function assertStatus<Expected extends AttemptView['status']>(
  record: AttemptView,
  expected: Expected
): asserts record is Extract<AttemptView, { readonly status: Expected }> {
  if (record.status === expected) return
  const facts = FAILURE_FACTS.flatMap(fact =>
    record[fact] === undefined ? [] : [`${fact}: ${record[fact]}`]
  )
  assert.fail(
    [
      `attempt ${record.id} of task ${record.owner.taskId} is ${record.status}, expected ${expected}`,
      ...facts,
    ].join('; ')
  )
}

type Assignment = Pick<AgentStartRequest, 'taskId' | 'prompt'> & Partial<AgentStartRequest>

export const openWorkFixture = async (name: string) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `dev-${name}-`)))
  const home = join(root, 'home')
  const skills = join(home, '.agents', 'skills')
  const agentDir = join(home, '.pi', 'agent')
  const repository = join(root, 'repository')
  const dataHome = join(root, 'runtime')
  for (const path of [skills, join(agentDir, 'extensions'), join(agentDir, 'prompts'), repository])
    mkdirSync(path, { recursive: true })
  mkdirSync(dataHome, { mode: 0o700 })
  const profiles = installProfileFixture(join(root, 'profiles'))
  process.env.HOME = home
  process.env.PI_OFFLINE = '1'
  process.env.PI_TELEMETRY_DISABLED = '1'
  const git = (args: readonly string[], cwd = repository) => runGit(cwd, args)
  git(['init', '--quiet', '-b', 'main'])
  git(['config', 'user.email', 'work-check@example.invalid'])
  git(['config', 'user.name', 'work check'])
  git(['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(repository, 'tracked.txt'), 'committed\n')
  git(['add', 'tracked.txt'])
  git(['commit', '--quiet', '-m', 'work check fixture'])

  const writeSkill = (skill: string, body: string, frontmatter: readonly string[] = []): string => {
    const directory = join(skills, skill)
    mkdirSync(directory, { recursive: true })
    const file = join(directory, 'SKILL.md')
    writeFileSync(
      file,
      [
        '---',
        `name: ${skill}`,
        `description: ${skill} fixture skill`,
        ...frontmatter,
        '---',
        body,
        '',
      ].join('\n')
    )
    return file
  }

  const lifecycle = await openLifecycle({ root: join(root, 'authority') })
  const sessionId = randomUUID()
  const sessionFile = join(dataHome, 'conversation.jsonl')
  writeFileSync(sessionFile, '', { mode: 0o600 })
  const attachment = await lifecycle.attach({
    cwd: repository,
    conversation: { sessionId, sessionFile, dataHome },
  })

  const openOwner = (
    profile = profiles.defaultProfile,
    wrap: (base: WorkspaceAttachment) => WorkspaceAttachment = base => base
  ) => {
    const outcomes = new Map<string, AttemptView>()
    const awaited = new Map<string, ((attempt: AttemptView) => void)[]>()
    const runtime = ManagedRuntime.make(
      WorkOwner.layer({
        dataHome,
        cwd: repository,
        sessionId,
        profile,
        workspace: {
          lifecycle: lifecycle.effect,
          attachment: wrap(attachment.effect),
          requestRebind: () => {
            throw new Error('no work check expects a workspace rebind')
          },
        },
        childEntry: new URL('./work-child-entry.ts', import.meta.url),
        browserOwnerEntry: new URL('../web/browser-owner-entry.ts', import.meta.url),
        onOutcome: attempt => {
          outcomes.set(attempt.id, attempt)
          for (const deliver of awaited.get(attempt.id) ?? []) deliver(attempt)
          awaited.delete(attempt.id)
        },
      })
    )
    const call = <A>(use: (owner: WorkOwnerService) => Effect.Effect<A, WorkFailure>) =>
      runtime.runPromise(ownerEffect(use))
    const records = async () => (await call(owner => owner.snapshot)).records
    const attempt = (
      what: string,
      find: (record: AttemptView) => boolean,
      done: (record: AttemptView) => boolean = () => true
    ) =>
      waitFor(
        what,
        async () => {
          const found = (await records()).find(find)
          return found !== undefined && done(found) ? found : undefined
        },
        TIMING
      )
    const leaf = (parent: string, taskId: string, done?: (record: AttemptView) => boolean) =>
      attempt(
        `leaf ${taskId} of ${parent}`,
        record => record.owner.parent === parent && record.owner.taskId === taskId,
        done
      )
    const outcome = (id: string): Promise<AttemptView> => {
      const delivered = outcomes.get(id)
      if (delivered !== undefined) return Promise.resolve(delivered)
      return within(
        new Promise<AttemptView>(deliver => {
          awaited.set(id, [...(awaited.get(id) ?? []), deliver])
        }),
        WAIT_LIMIT_MS,
        `the outcome of attempt ${id}`
      )
    }
    const delegate = (request: Assignment) =>
      call(owner => owner.startAgent({ access: 'read-only', model: CHILD_MODEL, ...request }))
    const result = async (id: AttemptView['id']) =>
      (await call(owner => owner.readLog({ id, stream: 'result' }))).text ?? ''
    const run = async (request: Assignment) => {
      const started = await delegate(request)
      const view = await outcome(started.id)
      return { view, text: await result(view.id) }
    }
    return {
      call,
      records,
      attempt,
      leaf,
      delegate,
      outcome,
      result,
      run,
      delivered: (): readonly string[] => [...outcomes.keys()],
      close: () => runtime.dispose(),
    }
  }

  const modelCalls = (): readonly string[] => {
    const file = join(dataHome, MODEL_CALLS)
    return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []
  }

  return {
    root,
    home,
    skills,
    agentDir,
    repository,
    dataHome,
    profiles,
    git,
    writeSkill,
    lifecycle,
    attachment,
    openOwner,
    modelCalls,
    close: async () => {
      await attachment.close()
      await lifecycle.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}
