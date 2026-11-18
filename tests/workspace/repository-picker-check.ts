import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Effect from 'effect/Effect'
import { displayPath } from '../../src/display-text.ts'
import { findRepositories } from '../../src/repository-picker.ts'
import {
  joinedTaskNote,
  pausedTaskQuestion,
  resumableRowText,
  resumableWorkspaces,
} from '../../src/workspace-command.ts'
import type { WorkspaceView } from '../../src/workspace-domain.ts'
import { makeClaims } from './workspace-check-support.ts'
import { fixtureId } from './workspace-host-fixture-shapes.ts'

const { claim, passed } = makeClaims()
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'dev-repository-picker-')))
const find = (directory: string, sessions: string) =>
  Effect.runPromise(findRepositories(directory, sessions).pipe(Effect.provide(NodeServices.layer)))

const repository = (path: string, head: string) => {
  mkdirSync(join(path, '.git'), { recursive: true })
  writeFileSync(join(path, '.git', 'HEAD'), `${head}\n`)
}
const session = (sessions: string, name: string, header: string, ageMs: number) => {
  const path = join(sessions, `${name}.jsonl`)
  writeFileSync(path, `${header}\n{"type":"message"}\n`)
  const at = (Date.now() - ageMs) / 1000
  utimesSync(path, at, at)
}
const header = (cwd: string) => JSON.stringify({ type: 'session', version: 3, id: 'x', cwd })
const near = (value: number | undefined, ageMs: number) =>
  value !== undefined && Math.abs(Date.now() - ageMs - value) < 5_000

const paused = (index: number, fields: Partial<WorkspaceView> = {}): WorkspaceView => ({
  repositoryId: fixtureId(90),
  taskId: fixtureId(index),
  workspaceId: fixtureId(index + 20),
  reservationId: fixtureId(index + 40),
  path: `/opt/area/work-${index}`,
  origin: 'managed',
  outcome: 'paused',
  reason: 'Task reservation is retained for explicit resume.',
  nextAction: 'Resume only by exact task/workspace selection.',
  uses: [],
  pending: [],
  ...fields,
})
try {
  const area = join(sandbox, 'area')
  const sessions = join(sandbox, 'sessions')
  mkdirSync(sessions, { recursive: true })
  repository(join(area, 'zeta'), 'ref: refs/heads/main')
  repository(join(area, 'alpha'), 'ref: refs/heads/feature/picker')
  repository(join(area, 'beta'), 'ref: refs/heads/main')
  repository(join(area, 'gamma'), 'ref: refs/heads/main')
  repository(join(area, 'detached'), '0123456789abcdef0123456789abcdef01234567')
  repository(join(area, '.hidden'), 'ref: refs/heads/main')
  mkdirSync(join(area, 'linked'))
  writeFileSync(join(area, 'linked', '.git'), 'gitdir: /elsewhere/.git/worktrees/linked\n')
  mkdirSync(join(area, 'plain'))
  repository(join(area, 'title\u001b]0;owned\u0007'), 'ref: refs/heads/main')
  repository(join(area, 'osc'), 'ref: refs/heads/main\u001b]52;c;cHduZWQ=\u0007')
  writeFileSync(join(area, 'notes.txt'), 'not a directory\n')
  session(sessions, 'beta-old', header(join(area, 'beta')), 4 * 86_400_000)
  session(sessions, 'beta-new', header(join(area, 'beta')), 2 * 86_400_000)
  session(sessions, 'gamma-app', header(join(area, 'gamma', 'app')), 3_600_000)
  session(sessions, 'gammaish', header(join(area, 'gammaish')), 60_000)
  session(sessions, 'not-session', JSON.stringify({ type: 'custom', cwd: join(area, 'zeta') }), 0)
  session(sessions, 'broken', '{ not json', 0)
  writeFileSync(join(sessions, 'zeta.txt'), header(join(area, 'zeta')))

  await claim(
    'repositories are the visible directories holding .git, newest dev conversation first, then by name',
    async () => {
      const found = await find(area, sessions)
      assert.deepEqual(
        found.map(entry => entry.name),
        ['gamma', 'beta', 'alpha', 'detached', 'linked', 'osc', 'zeta']
      )
      assert.deepEqual(
        found.map(entry => entry.path),
        found.map(entry => join(area, entry.name))
      )
    }
  )

  await claim(
    'a repository is last used by its newest conversation started in it or below it, and never by a sibling sharing its prefix',
    async () => {
      const used = new Map((await find(area, sessions)).map(entry => [entry.name, entry.lastUsed]))
      assert.ok(near(used.get('beta'), 2 * 86_400_000), String(used.get('beta')))
      assert.ok(near(used.get('gamma'), 3_600_000), String(used.get('gamma')))
      assert.equal(used.get('zeta'), undefined, 'neither a non-session header nor a .txt counts')
      assert.equal(used.get('alpha'), undefined)
    }
  )

  await claim(
    'the branch comes from HEAD, and is absent when .git is not a directory',
    async () => {
      const branches = new Map(
        (await find(area, sessions)).map(entry => [entry.name, entry.branch])
      )
      assert.equal(branches.get('alpha'), 'feature/picker')
      assert.equal(branches.get('detached'), 'detached')
      assert.equal(branches.get('linked'), undefined)
    }
  )

  await claim(
    'names and branches carrying control characters never reach the terminal: such a directory is skipped and such a branch is not shown',
    async () => {
      const found = await find(area, sessions)
      assert.ok(found.every(entry => !entry.name.includes('\u001b')))
      assert.equal(found.find(entry => entry.name === 'osc')?.branch, undefined)
    }
  )

  await claim('missing directories yield no repositories instead of failing', async () => {
    assert.deepEqual(
      (await find(area, join(sandbox, 'no-sessions'))).map(entry => entry.lastUsed),
      [undefined, undefined, undefined, undefined, undefined, undefined, undefined]
    )
    assert.deepEqual(await find(join(sandbox, 'missing'), sessions), [])
    assert.deepEqual(await find(join(area, 'plain'), sessions), [])
  })

  const unreserved = (({ taskId: _task, reservationId: _reservation, ...rest }) => rest)(paused(7))

  await claim(
    'paused work is the workspaces a task reserves and nothing uses or leaves unresolved, most recently used first, then by path',
    () => {
      const listed = resumableWorkspaces([
        paused(1, { lastUsedAt: 1_000 }),
        paused(2, { lastUsedAt: 3_000 }),
        paused(3),
        paused(4, { path: '/opt/area/earlier' }),
        paused(5, { lastUsedAt: 9_000, outcome: 'active' }),
        paused(6, { lastUsedAt: 9_000, outcome: 'blocked' }),
        paused(8, { lastUsedAt: 9_000, outcome: 'review-required' }),
        unreserved,
      ])
      assert.deepEqual(
        listed.map(entry => entry.view.path),
        ['/opt/area/work-2', '/opt/area/work-1', '/opt/area/earlier', '/opt/area/work-3']
      )
      assert.deepEqual(listed[0]?.selection, { taskId: fixtureId(2), workspaceId: fixtureId(22) })
    }
  )

  await claim(
    "a row of paused work names its branch, or its commit and that commit's subject when detached, then its age, path and task, with control characters replaced and a long subject cut",
    () => {
      const now = 10 * 3_600_000
      const row = (view: WorkspaceView) =>
        resumableRowText(
          { selection: { taskId: fixtureId(1), workspaceId: view.workspaceId }, view },
          now
        )
      assert.equal(
        row(
          paused(1, {
            head: { kind: 'branch', name: 'feat/resume' },
            path: join(homedir(), 'repo'),
            lastUsedAt: now - 2 * 3_600_000,
          })
        ),
        `feat/resume · 2h ago · ~/repo · task ${fixtureId(1)}`
      )
      assert.equal(
        row(
          paused(1, {
            head: { kind: 'detached', commit: '0123456789abcdef0123456789abcdef01234567' },
            path: '/opt/a\u001b]0;x\u0007b',
          })
        ),
        `detached 0123456789ab · /opt/a?]0;x?b · task ${fixtureId(1)}`
      )
      const commit = '0123456789abcdef0123456789abcdef01234567'
      assert.equal(
        row(
          paused(1, { head: { kind: 'detached', commit, subject: 'Resume\u001b[2J the parser' } })
        ),
        `detached 0123456789ab · Resume?[2J the parser · /opt/area/work-1 · task ${fixtureId(1)}`
      )
      assert.equal(
        row(paused(1, { head: { kind: 'detached', commit, subject: 'x'.repeat(61) } })),
        `detached 0123456789ab · ${'x'.repeat(59)}… · /opt/area/work-1 · task ${fixtureId(1)}`
      )
      assert.equal(
        row(paused(1, { head: { kind: 'detached', commit, subject: 'y'.repeat(60) } })),
        `detached 0123456789ab · ${'y'.repeat(60)} · /opt/area/work-1 · task ${fixtureId(1)}`
      )
      assert.equal(row(paused(1)), `no branch · /opt/area/work-1 · task ${fixtureId(1)}`)
    }
  )

  await claim(
    'the question before isolation names the paused head, its changed files and last use, and offers to continue there or to work separately',
    () => {
      const now = 10 * 3_600_000
      const task = {
        taskId: fixtureId(1),
        reservationId: fixtureId(41),
        reservationRevision: 3,
        workspaceId: fixtureId(21),
        path: '/opt/area/repo',
      }
      assert.deepEqual(
        pausedTaskQuestion(
          {
            ...task,
            head: { kind: 'branch', name: 'feat/resume' },
            changedFiles: 1,
            lastUsedAt: now - 86_400_000,
          },
          now
        ),
        {
          title:
            'This checkout holds a paused task on feat/resume (1 changed file, last used yesterday). Continue it, or work separately?',
          continueHere: 'Continue that task here',
          separately: 'Work separately: a new worktree from this commit, without uncommitted files',
        }
      )
      assert.equal(
        pausedTaskQuestion({ ...task, changedFiles: 0 }, now).title,
        'This checkout holds a paused task on no branch (0 changed files). Continue it, or work separately?'
      )
    }
  )

  await claim(
    'the note of a continued task tells the model who chose it and that the changed files, when there are any, come from work whose history it does not hold',
    () => {
      const task = {
        taskId: fixtureId(1),
        reservationId: fixtureId(41),
        reservationRevision: 3,
        workspaceId: fixtureId(21),
        path: '/opt/area/repo',
        head: { kind: 'branch' as const, name: 'feat/resume' },
      }
      const joined = `This conversation now continues task ${fixtureId(1)} in /opt/area/repo on feat/resume. The user chose to continue it here.`
      assert.equal(
        joinedTaskNote({ ...task, changedFiles: 3 }),
        `${joined} 3 changed files remain from earlier work. Earlier messages are not here.`
      )
      assert.equal(
        joinedTaskNote({ ...task, changedFiles: 1 }),
        `${joined} 1 changed file remains from earlier work. Earlier messages are not here.`
      )
      for (const changedFiles of [0, undefined])
        assert.equal(
          joinedTaskNote({ ...task, ...(changedFiles === undefined ? {} : { changedFiles }) }),
          `${joined} Earlier messages are not here.`
        )
    }
  )

  await claim(
    'paths are shown with a tilde under home and with control characters replaced',
    () => {
      assert.equal(displayPath(join(homedir(), 'Developer')), '~/Developer')
      assert.equal(displayPath(homedir()), '~')
      assert.equal(displayPath(`${homedir()}-other`), `${homedir()}-other`)
      assert.equal(displayPath('/opt/area'), '/opt/area')
      assert.equal(displayPath('/opt/a\u001b]0;x\u0007b'), '/opt/a?]0;x?b')
    }
  )
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify({ result: 'passed', checks: passed }, null, 2)}\n`)
