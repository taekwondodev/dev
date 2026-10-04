import assert from 'node:assert/strict'
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import type * as Pi from '@earendil-works/pi-coding-agent'
import { Effect, Exit, Scope } from 'effect'
import { acquireRuntime } from '../../src/runtime-coordination.ts'
import { loadInstalledPi, makeClaims } from './workspace-check-support.ts'
import { openLifecycle } from './workspace-test-lifecycle.ts'

type SessionMessage = Parameters<Pi.SessionManager['appendMessage']>[0]

const devRoot = fileURLToPath(new URL('../..', import.meta.url))
const { pi } = await loadInstalledPi()
const initRepository = (cwd: string) => {
  const git = (args: readonly string[]) => execFileSync('git', [...args], { cwd })
  git(['init', '--quiet', '-b', 'main'])
  writeFileSync(join(cwd, 'tracked.txt'), 'launcher fixture\n')
  git(['add', 'tracked.txt'])
  git([
    '-c',
    'user.name=Launcher Fixture',
    '-c',
    'user.email=launcher@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ])
}
const pathsUnder = (root: string) =>
  readdirSync(root, { recursive: true, encoding: 'utf8' }).toSorted()
const authorityFiles = (root: string) =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => {
      const path = join(entry.parentPath, entry.name)
      return `${relative(root, path)} ${createHash('sha256').update(readFileSync(path)).digest('hex')}`
    })
    .toSorted()

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'dev-workspace-launcher-check-')))
const { claim, passed } = makeClaims()
try {
  const repo = join(sandbox, 'repo')
  const dataHome = join(sandbox, 'data')
  const authorityRoot = join(sandbox, 'authority')
  mkdirSync(repo)
  mkdirSync(dataHome, { mode: 0o700 })
  initRepository(repo)

  const sessions = pi.SessionManager.create(repo, join(dataHome, 'sessions'))
  const user: SessionMessage = {
    role: 'user',
    content: 'bound conversation',
    timestamp: Date.now(),
  }
  const assistant: SessionMessage = {
    role: 'assistant',
    content: [{ type: 'text', text: 'history that must survive' }],
    api: 'openai-completions',
    provider: 'fixture',
    model: 'fixture',
    stopReason: 'stop',
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }
  sessions.appendMessage(user)
  sessions.appendMessage(assistant)
  const sessionFile = sessions.getSessionFile()
  if (sessionFile === undefined || !existsSync(sessionFile))
    throw new Error('Pi did not persist the fixture conversation')
  const conversation = { sessionId: sessions.getSessionId(), sessionFile, dataHome }

  const lifecycle = await openLifecycle({ root: authorityRoot })
  const allocator = await lifecycle.attach({
    conversation: {
      sessionId: 'launcher-allocator',
      sessionFile: join(sandbox, 'allocator.jsonl'),
      dataHome,
    },
    cwd: repo,
  })
  const allocated = await allocator.authorize({ kind: 'delegated-write' })
  if (allocated.kind !== 'ready' || allocated.grant.taskId === undefined)
    throw new Error('The fixture could not allocate a managed workspace')
  await allocator.close()
  const bound = await lifecycle.attach({ conversation, cwd: repo })
  await bound.handoff(
    await bound.select({
      taskId: allocated.grant.taskId,
      workspaceId: allocated.grant.workspaceId,
    }),
    async () => 'confirmed'
  )
  assert.equal(bound.binding.workspaceId, allocated.grant.workspaceId)
  await bound.close()
  writeFileSync(join(allocated.grant.checkout, 'unfinished.txt'), 'kept by the allocation sweep\n')

  const switchSessions = pi.SessionManager.create(repo, join(dataHome, 'sessions'))
  switchSessions.appendMessage(user)
  switchSessions.appendMessage(assistant)
  const switchFile = switchSessions.getSessionFile()
  if (switchFile === undefined || !existsSync(switchFile))
    throw new Error('Pi did not persist the switching conversation')
  const switchConversation = {
    sessionId: switchSessions.getSessionId(),
    sessionFile: switchFile,
    dataHome,
  }
  const switchAllocator = await lifecycle.attach({
    conversation: {
      sessionId: 'launcher-switch-allocator',
      sessionFile: join(sandbox, 'switch-allocator.jsonl'),
      dataHome,
    },
    cwd: repo,
  })
  const switchTarget = await switchAllocator.authorize({ kind: 'delegated-write' })
  if (switchTarget.kind !== 'ready' || switchTarget.grant.taskId === undefined)
    throw new Error('The fixture could not allocate a switch target')
  await switchAllocator.close()
  const switching = await lifecycle.attach({ conversation: switchConversation, cwd: repo })
  const switchSource = switching.binding.workspaceId
  const unstarted = await switching.select({
    taskId: switchTarget.grant.taskId,
    workspaceId: switchTarget.grant.workspaceId,
  })

  await lifecycle.close()
  rmSync(allocated.grant.checkout, { recursive: true, force: true })
  const historyBefore = createHash('sha256').update(readFileSync(sessionFile)).digest('hex')

  const driver = `
    import { NodeRuntime } from '@effect/platform-node'
    import { Effect, Layer } from 'effect'
    import { launch } from ${JSON.stringify(new URL('../../src/launcher.ts', import.meta.url).href)}
    import { WorkspaceError } from ${JSON.stringify(new URL('../../src/workspace-domain.ts', import.meta.url).href)}
    import { WorkspaceAuthorityClient } from ${JSON.stringify(new URL('../../src/workspace-lifecycle.ts', import.meta.url).href)}
    const root = process.env.LAUNCHER_CHECK_ROOT
    const stopAfterAttach = lifecycle => ({
      ...lifecycle,
      attach: input =>
        lifecycle.attach(input).pipe(
          Effect.tap(attachment =>
            Effect.sync(() => {
              process.stdout.write(JSON.stringify({ workspaceId: attachment.binding.workspaceId }) + '\\n')
            })
          ),
          Effect.tap(attachment => attachment.close),
          Effect.andThen(
            Effect.fail(
              new WorkspaceError({ outcome: 'blocked', message: 'launcher check stops after attach' })
            )
          )
        ),
    })
    const workspaceLifecycle = Layer.unwrap(
      Effect.suspend(() =>
        root === undefined || root.length === 0
          ? Effect.die(new Error('the launcher check requires a temporary authority root'))
          : Effect.succeed(
              Layer.effect(
                WorkspaceAuthorityClient,
                WorkspaceAuthorityClient.useSync(lifecycle => {
                  if (process.env.REPORT_OPEN === '1') process.stderr.write('authority opened\\n')
                  return process.env.STOP_AFTER_ATTACH === '1' ? stopAfterAttach(lifecycle) : lifecycle
                })
              ).pipe(Layer.provide(WorkspaceAuthorityClient.layer({ root })))
            )
      )
    )
    NodeRuntime.runMain(launch(process.argv.slice(1), {
      workspaceLifecycle,
      coordination: { installationPath: ${JSON.stringify(sandbox)}, namespacePath: root },
    }), {
      disableErrorReporting: true,
    })
  `

  const launches = new Set<ReturnType<typeof execFile>>()
  process.on('exit', () => {
    for (const launch of launches) launch.kill('SIGKILL')
  })
  const runLauncher = (args: readonly string[], env: Readonly<Record<string, string>> = {}) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>(resolveRun => {
      const launch = execFile(
        process.execPath,
        ['--input-type=module', '-e', driver, '--', ...args],
        {
          cwd: devRoot,
          env: { ...process.env, PI_OFFLINE: '1', LAUNCHER_CHECK_ROOT: authorityRoot, ...env },
          timeout: 60000,
        },
        (error, stdout, stderr) => {
          launches.delete(launch)

          const status = error === null ? 0 : error.code
          resolveRun({ code: typeof status === 'number' ? status : null, stdout, stderr })
        }
      )
      launches.add(launch)
    })
  const resumeArgs = (resumed: string) => [
    '--resume',
    resumed,
    '--data-home',
    dataHome,
    '--profile',
    'general',
  ]
  await claim(
    'dev --resume of a conversation whose workspace was removed exits 1, names the unchanged conversation file and directs the user to resolve that refusal without recreating the workspace',
    async () => {
      const outcome = await runLauncher(resumeArgs(sessionFile))
      assert.equal(outcome.code, 1, outcome.stderr)
      assert.match(outcome.stderr, /no longer exists and is not recreated/)
      assert.ok(outcome.stderr.includes(sessionFile), outcome.stderr)
      assert.match(
        outcome.stderr,
        /existing conversation file and its saved history were not modified/
      )
      assert.match(outcome.stderr, /Resolve the reported refusal before retrying this conversation/)
      assert.ok(!outcome.stderr.includes('will reach the same refusal'), outcome.stderr)
      assert.ok(!outcome.stderr.includes('dev --cwd PATH'), outcome.stderr)
      assert.equal(
        createHash('sha256').update(readFileSync(sessionFile)).digest('hex'),
        historyBefore,
        'the conversation file and its history are unchanged'
      )
      assert.ok(!existsSync(allocated.grant.checkout), 'the removed workspace was not recreated')
    }
  )

  await claim(
    'dev --resume of a conversation whose host died withdraws its switch that never reached that host, returning it durably to the last confirmed workspace',
    async () => {
      const withdrawal = await runLauncher(resumeArgs(switchFile), { STOP_AFTER_ATTACH: '1' })
      assert.equal(withdrawal.code, 1, withdrawal.stderr)
      assert.match(withdrawal.stderr, /launcher check stops after attach/)
      assert.deepEqual(JSON.parse(withdrawal.stdout.trim().split('\n').at(-1) ?? '{}'), {
        workspaceId: switchSource,
      })
      const afterWithdrawal = await openLifecycle({ root: authorityRoot })
      try {
        assert.equal(
          (await afterWithdrawal.inspect({}))
            .flatMap(view => view.pending)
            .find(item => item.id === unstarted.operationId)?.stage,
          undefined,
          'the unstarted switch was withdrawn, so it is no longer pending'
        )
        const reopened = await afterWithdrawal.attach({
          conversation: switchConversation,
          cwd: repo,
        })
        assert.equal(reopened.binding.workspaceId, switchSource, 'the withdrawal was durable')
        await reopened.close()
      } finally {
        await afterWithdrawal.close()
      }
    }
  )

  await claim(
    'dev --resume of a conversation live in another lifecycle on the same authority exits 1 with guidance instead of taking it over',
    async () => {
      const liveElsewhere = await openLifecycle({ root: authorityRoot })
      const liveConversation = await liveElsewhere.attach({
        conversation: switchConversation,
        cwd: repo,
      })
      const refused = await runLauncher(resumeArgs(switchFile), { STOP_AFTER_ATTACH: '1' })
      await liveConversation.close()
      await liveElsewhere.close()
      assert.equal(refused.code, 1, refused.stderr)
      assert.match(refused.stderr, /open in another dev session/)
      assert.ok(refused.stderr.includes(switchFile), refused.stderr)
    }
  )

  await claim(
    'dev --probe-runtime builds its Pi runtime on the binding the workspace host prepares and commits, and exits 0 with Pi state only under a disposable HOME',
    async () => {
      const probeHome = join(sandbox, 'probe-home')
      mkdirSync(join(probeHome, '.agents', 'skills'), { recursive: true })
      const probed = await runLauncher(
        ['--probe-runtime', '--cwd', repo, '--data-home', dataHome, '--profile', 'general'],
        { HOME: probeHome, LAUNCHER_CHECK_ROOT: join(sandbox, 'probe-authority') }
      )
      assert.equal(probed.code, 0, probed.stderr)
      assert.match(probed.stdout, /^runtime probe: ok$/m)
      assert.ok(existsSync(join(probeHome, '.pi', 'agent')), 'Pi kept its state in the probe HOME')
    }
  )

  const secondRepo = join(sandbox, 'second-repo')
  const notGit = join(sandbox, 'not-git')
  const readOnlyHome = join(sandbox, 'read-only-home')
  const unusedDataHome = join(sandbox, 'read-only-data')
  for (const path of [secondRepo, notGit, readOnlyHome]) mkdirSync(path)
  initRepository(secondRepo)
  const ceiling = { GIT_CEILING_DIRECTORIES: sandbox }
  assert.notEqual(
    spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: notGit,
      env: { ...process.env, ...ceiling },
    }).status,
    0,
    'the non-Git fixture directory is outside every repository'
  )
  const inspectRoot = join(sandbox, 'inspect-authority')
  const inspectLifecycle = await openLifecycle({ root: inspectRoot })
  const writerGrant = async (cwd: string, sessionId: string) => {
    const writer = await inspectLifecycle.attach({
      conversation: { sessionId, sessionFile: join(sandbox, `${sessionId}.jsonl`), dataHome },
      cwd,
    })
    const admitted = await writer.authorize({ kind: 'write' })
    await writer.close()
    if (admitted.kind !== 'ready' || admitted.grant.taskId === undefined)
      throw new Error(`The fixture could not reserve a task in ${cwd}`)
    return { ...admitted.grant, taskId: admitted.grant.taskId }
  }
  let firstGrant: Awaited<ReturnType<typeof writerGrant>>
  let secondGrant: Awaited<ReturnType<typeof writerGrant>>
  try {
    firstGrant = await writerGrant(repo, 'inspect-first')
    secondGrant = await writerGrant(secondRepo, 'inspect-second')
  } finally {
    await inspectLifecycle.close()
  }
  assert.notEqual(firstGrant.repositoryId, secondGrant.repositoryId)

  const jsonlBefore = pathsUnder(sandbox).filter(path => path.endsWith('.jsonl'))
  const readOnly = (
    root: string,
    args: readonly string[],
    env: Readonly<Record<string, string>> = {}
  ) =>
    runLauncher(args, {
      LAUNCHER_CHECK_ROOT: root,
      DEV_DATA_HOME: unusedDataHome,
      HOME: readOnlyHome,
      ...ceiling,
      ...env,
    })

  const absentParent = join(sandbox, 'absent-authority')
  const absentRoot = join(absentParent, 'root')
  await claim(
    'dev workspace list outside a Git repository lists nothing, exits 2, points to --cwd PATH and never opens the authority',
    async () => {
      const outsideGit = await readOnly(absentRoot, ['--cwd', notGit, 'workspace', 'list'], {
        REPORT_OPEN: '1',
      })
      assert.equal(outsideGit.code, 2, outsideGit.stderr)
      assert.equal(outsideGit.stdout, '', 'nothing is listed for a directory outside Git')
      assert.equal(
        outsideGit.stderr,
        'Workspace list requires a Git repository; run dev from a Git checkout or pass --cwd PATH.\n'
      )
    }
  )

  await claim(
    'dev workspace and dev workspace inspect <task> against an authority that does not exist yet report no records, exit 0 and create neither the root nor its parent',
    async () => {
      const emptyList = await readOnly(absentRoot, ['--cwd', repo, 'workspace'])
      assert.equal(emptyList.code, 0, emptyList.stderr)
      assert.equal(
        emptyList.stdout,
        `Workspace list for repository ${repo}:\nNo workspace records were found.\n`
      )
      const absentTask = randomUUID()
      const emptyInspect = await readOnly(absentRoot, ['workspace', 'inspect', absentTask])
      assert.equal(emptyInspect.code, 0, emptyInspect.stderr)
      assert.equal(
        emptyInspect.stdout,
        `No workspace records exist for exact task ${absentTask}.\n`
      )
      assert.ok(
        !existsSync(absentParent),
        'reading an authority that does not exist provisions nothing'
      )
    }
  )

  const inspectTask = async (cwd: string, grant: typeof secondGrant, repository: string) => {
    const found = await readOnly(inspectRoot, ['--cwd', cwd, 'workspace', 'inspect', grant.taskId])
    assert.equal(found.code, 0, found.stderr)
    const lines = found.stdout.split('\n')
    assert.equal(
      lines[0],
      `Workspace records for exact task ${grant.taskId}: task ${grant.taskId} — workspace ${grant.workspaceId}`
    )
    assert.deepEqual(
      lines.filter(line => line.startsWith('  repository: ')),
      [`  repository: ${grant.repositoryId}`],
      'only the exact task is reported'
    )
    assert.deepEqual(
      lines.filter(line => line.startsWith('  path: ')),
      [`  path: ${repository}`]
    )
  }
  await claim(
    'dev workspace inspect <task> finds exactly that task in whichever of two repositories holds it, from a non-Git or another repository launch directory, and a task ID differing in one character finds nothing',
    async () => {
      await inspectTask(notGit, secondGrant, secondRepo)
      await inspectTask(secondRepo, firstGrant, repo)
      const nearMiss = `${secondGrant.taskId.slice(0, -1)}${secondGrant.taskId.endsWith('0') ? '1' : '0'}`
      const missed = await readOnly(inspectRoot, ['workspace', 'inspect', nearMiss])
      assert.equal(missed.code, 0, missed.stderr)
      assert.equal(missed.stdout, `No workspace records exist for exact task ${nearMiss}.\n`)
    }
  )
  await claim(
    'dev workspace inspect with a malformed task ID is a usage error: exit 2 naming the bad argument, before the authority is asked',
    async () => {
      const malformed = await readOnly(inspectRoot, ['workspace', 'inspect', 'not-a-task-id'], {
        REPORT_OPEN: '1',
      })
      assert.equal(malformed.code, 2, malformed.stderr)
      assert.ok(!malformed.stderr.includes('authority opened'), malformed.stderr)
      assert.match(malformed.stderr, /Task must be an exact ID as listed by dev workspace/)
      assert.ok(malformed.stderr.includes('not-a-task-id'), malformed.stderr)
    }
  )

  await claim(
    'dev workspace list and inspect <task> report a corrupt catalog with exit 1 and no listing, leave every authority file byte-identical, and after repair the same records answer again, so nothing was reinitialized',
    async () => {
      const catalogPath = join(inspectRoot, 'catalog.sqlite')
      const setCatalogPayload = (payload: string) => {
        const catalog = new DatabaseSync(catalogPath)
        try {
          const row = catalog
            .prepare('SELECT payload FROM repositories WHERE id=?')
            .get(secondGrant.repositoryId)
          if (typeof row?.payload !== 'string')
            throw new Error('The catalog fixture row is missing')
          catalog
            .prepare('UPDATE repositories SET payload=? WHERE id=?')
            .run(payload, secondGrant.repositoryId)
          return row.payload
        } finally {
          catalog.close()
        }
      }
      const intactPayload = setCatalogPayload('[]')
      const damaged = authorityFiles(inspectRoot)
      for (const args of [
        ['--cwd', secondRepo, 'workspace', 'list'],
        ['--cwd', notGit, 'workspace', 'inspect', secondGrant.taskId],
      ]) {
        const reported = await readOnly(inspectRoot, args)
        assert.equal(reported.code, 1, `${args.join(' ')}: ${reported.stderr}`)
        assert.equal(reported.stdout, '', 'a damaged authority is not presented as a listing')
        assert.match(reported.stderr, /^Workspace inspection failed: .*catalog/)
      }
      assert.deepEqual(
        authorityFiles(inspectRoot),
        damaged,
        'the damaged authority is left as found'
      )
      setCatalogPayload(intactPayload)
      await inspectTask(notGit, secondGrant, secondRepo)
    }
  )

  await claim(
    'dev workspace check <task> returns the role, target and sweep verdict with exit 0 even though it names blockers and eligibility, a malformed task ID is a usage error, no unattended release flag exists and resume is no terminal command',
    async () => {
      const checked = await readOnly(inspectRoot, [
        '--cwd',
        notGit,
        'workspace',
        'check',
        firstGrant.taskId,
      ])
      assert.equal(checked.code, 0, checked.stderr)
      assert.ok(
        checked.stdout.includes(firstGrant.taskId) &&
          checked.stdout.includes(firstGrant.workspaceId),
        checked.stdout
      )
      assert.ok(checked.stdout.includes('eligibility: releasable'), checked.stdout)
      assert.ok(
        checked.stdout.includes('role: pre-existing checkout') &&
          checked.stdout.includes('sweep verdict: finished (clean-checkout)'),
        checked.stdout
      )
      const malformed = await readOnly(inspectRoot, ['workspace', 'check', 'not-a-task'])
      assert.equal(malformed.code, 2, malformed.stderr)
      assert.ok(malformed.stderr.includes('not-a-task'), malformed.stderr)
      const unattended = await readOnly(inspectRoot, [
        'workspace',
        'release',
        firstGrant.taskId,
        '--yes',
      ])
      assert.equal(unattended.code, 2, unattended.stderr)
      assert.ok(unattended.stderr.includes('workspace release <task>'), unattended.stderr)
      const resume = await readOnly(inspectRoot, ['workspace', 'resume', firstGrant.taskId])
      assert.equal(resume.code, 2, resume.stderr)
      assert.ok(
        resume.stderr.includes('Unknown workspace command "resume"'),
        'resume left the terminal surface'
      )
    }
  )
  await claim(
    'dev workspace release <task> without a TTY refuses with exit 2 and releases nothing: the reservation is still held afterwards',
    async () => {
      const refused = await readOnly(inspectRoot, [
        '--cwd',
        repo,
        'workspace',
        'release',
        firstGrant.taskId,
      ])
      assert.equal(refused.code, 2, refused.stderr)
      const still = await openLifecycle({ root: inspectRoot })
      try {
        const views = await still.inspect({ taskId: firstGrant.taskId })
        assert.deepEqual(
          views.map(view => [view.workspaceId, view.reservationId, view.outcome]),
          [[firstGrant.workspaceId, firstGrant.reservationId, 'preserved-for-resume']]
        )
      } finally {
        await still.close()
      }
    }
  )
  await claim(
    'no read-only workspace command resolves a data home or creates Pi state or a session file',
    () => {
      assert.ok(!existsSync(unusedDataHome), 'no read-only command resolved a data home')
      assert.deepEqual(
        pathsUnder(readOnlyHome),
        [],
        'no read-only command created Pi state in HOME'
      )
      assert.deepEqual(
        pathsUnder(sandbox).filter(path => path.endsWith('.jsonl')),
        jsonlBefore,
        'no read-only command created a Pi session file'
      )
    }
  )
  await claim('dev stops with the reason when the installed Pi fails to load', async () => {
    const brokenRelease = join(sandbox, 'broken-pi-release')
    const brokenPi = join(brokenRelease, 'node_modules', '@earendil-works', 'pi-coding-agent')
    mkdirSync(brokenPi, { recursive: true })
    writeFileSync(
      join(brokenPi, 'package.json'),
      JSON.stringify({
        name: '@earendil-works/pi-coding-agent',
        version: '0.0.0',
        main: 'index.js',
      })
    )
    writeFileSync(join(brokenPi, 'index.js'), "throw new Error('broken fixture Pi')\n")
    const outcome = await runLauncher(['--data-home', dataHome, '--profile', 'general'], {
      DEV_PI_RELEASE: brokenRelease,
    })
    assert.equal(outcome.code, 1, outcome.stderr)
    assert.ok(
      outcome.stderr.includes(
        `Cannot load Pi from ${join(brokenPi, 'index.js')}: broken fixture Pi`
      ),
      outcome.stderr
    )
  })
  await claim(
    'dev --resume of a dangling link is refused and explains the invalid entry without suggesting another conversation in the blocked checkout',
    async () => {
      const target = join(sandbox, 'nowhere.jsonl')
      const dangling = join(dataHome, 'sessions', 'dangling.jsonl')
      symlinkSync(target, dangling)
      const outcome = await runLauncher(resumeArgs(dangling), { STOP_AFTER_ATTACH: '1' })
      assert.equal(outcome.code, 1, outcome.stderr)
      assert.match(outcome.stderr, /Conversation file is not a regular, uniquely linked file/)
      assert.match(outcome.stderr, /session path is not a regular conversation file/)
      assert.ok(!outcome.stderr.includes('dev --cwd PATH'), outcome.stderr)
      assert.ok(!existsSync(target), 'the link target was not created')
    }
  )

  const optionHome = join(sandbox, 'option-home')
  const optionData = join(sandbox, 'option-data')
  const neverData = join(sandbox, 'never-data')
  mkdirSync(join(optionHome, '.agents', 'skills'), { recursive: true })
  const withOptions = (args: readonly string[], home = optionData) =>
    runLauncher(args, {
      HOME: optionHome,
      DEV_DATA_HOME: home,
      LAUNCHER_CHECK_ROOT: join(sandbox, 'option-authority'),
    })
  const selected = async (args: readonly string[]) => {
    const outcome = await withOptions(['--diagnostics', ...args])
    assert.equal(outcome.code, 0, outcome.stderr)
    return /^selection: (\S+)/m.exec(outcome.stdout)?.[1]
  }
  const savedPreference = await claim(
    'dev --save-profile saves the profile preference of that repository only and opens no session; a new conversation then selects it, --profile wins over it, and an unknown profile name is refused by both options',
    async () => {
      assert.equal(await selected(['--cwd', repo]), 'general')
      const saved = await withOptions(['--save-profile', 'apple', '--cwd', repo])
      assert.equal(saved.code, 0, saved.stderr)
      const path = /^saved profile apple at (.+)$/m.exec(saved.stdout)?.[1]
      if (path === undefined || !existsSync(path))
        throw new Error(`The saved preference was not reported: ${saved.stdout}`)
      assert.deepEqual(
        pathsUnder(optionData).filter(entry => entry.endsWith('.jsonl')),
        [],
        'saving a preference opened no session'
      )
      assert.equal(await selected(['--cwd', repo]), 'apple')
      assert.equal(await selected(['--cwd', repo, '--profile', 'general']), 'general')
      assert.equal(await selected(['--cwd', secondRepo]), 'general')
      const stored = readFileSync(path, 'utf8')
      for (const option of ['--save-profile', '--profile']) {
        const refused = await withOptions(['--diagnostics', '--cwd', repo, option, 'swift'])
        assert.equal(refused.code, 1, `${option}: ${refused.stderr}`)
        assert.ok(refused.stderr.includes('"swift"'), refused.stderr)
      }
      assert.equal(
        readFileSync(path, 'utf8'),
        stored,
        'a refused name left the preference as saved'
      )
      return path
    }
  )
  await claim(
    'dev refuses a stored profile preference that is not a preference record, names the file, and leaves it as found instead of resetting it',
    async () => {
      writeFileSync(savedPreference, '"apple"\n')
      const refused = await withOptions(['--diagnostics', '--cwd', repo])
      assert.equal(refused.code, 1, refused.stdout)
      assert.ok(refused.stderr.includes(savedPreference), refused.stderr)
      assert.equal(readFileSync(savedPreference, 'utf8'), '"apple"\n')
    }
  )
  await claim(
    'dev --continue resumes the newest session whose header names the launch directory, passing over newer sessions of another directory and child sessions; the resumed conversation keeps its recorded profile, and one that recorded none requires --profile',
    async () => {
      const continueData = join(sandbox, 'continue-data')
      mkdirSync(continueData, { mode: 0o700 })
      const record = (cwd: string, directory: string, modifiedAt: number, profile?: string) => {
        const manager = pi.SessionManager.create(cwd, join(continueData, directory))
        manager.appendMessage(user)
        manager.appendMessage(assistant)
        if (profile !== undefined) manager.appendCustomEntry('dev/profile', { profile })
        const file = manager.getSessionFile()
        if (file === undefined || !existsSync(file))
          throw new Error('Pi did not persist a --continue fixture conversation')
        utimesSync(file, modifiedAt, modifiedAt)
      }
      const now = Date.now() / 1000
      record(repo, 'sessions', now - 400)
      record(repo, 'sessions', now - 300, 'apple')
      record(secondRepo, 'sessions', now - 200)
      record(repo, 'child-sessions', now - 100)
      const resume = (cwd: string, extra: readonly string[] = []) =>
        withOptions(['--continue', '--diagnostics', '--cwd', cwd, ...extra], continueData)
      for (const extra of [[], ['--profile', 'general']]) {
        const resumed = await resume(repo, extra)
        assert.equal(resumed.code, 0, resumed.stderr)
        assert.match(resumed.stdout, /^selection: apple /m)
      }
      const unrecorded = await resume(secondRepo)
      assert.equal(unrecorded.code, 1, unrecorded.stdout)
      assert.ok(unrecorded.stderr.includes('--profile'), unrecorded.stderr)
      const chosen = await resume(secondRepo, ['--profile', 'general'])
      assert.equal(chosen.code, 0, chosen.stderr)
      assert.match(chosen.stdout, /^selection: general /m)
    }
  )
  await claim(
    'dev --help exits 0 with a usage that names every option and command of the launcher guide; an undefined option, a stray argument and a value option without its value are refused naming the argument; none of them resolves a data home',
    async () => {
      const guide = readFileSync(join(devRoot, 'docs', 'launcher.md'), 'utf8')
      const documented = [...guide.matchAll(/^dev (--[a-z-]+|workspace)\b/gm)].map(
        ([, name]) => name
      )
      assert.ok(documented.length >= 10, `the launcher guide lists its options: ${documented}`)
      const help = await withOptions(['--help'], neverData)
      assert.equal(help.code, 0, help.stderr)
      assert.deepEqual(
        documented.filter(name => name !== undefined && !help.stdout.includes(name)),
        [],
        help.stdout
      )
      for (const [args, named] of [
        [['--unattended'], '--unattended'],
        [['stray'], 'stray'],
        [['--cwd', repo, '--profile'], '--profile'],
      ] as const) {
        const refused = await withOptions(args, neverData)
        assert.equal(refused.code, 1, `${named}: ${refused.stdout}`)
        assert.ok(refused.stderr.includes(named), refused.stderr)
      }
      assert.ok(!existsSync(neverData), 'no refused or help invocation resolved a data home')
    }
  )

  const caseHome = join(sandbox, 'case-data')
  mkdirSync(caseHome, { mode: 0o700 })
  const held = pi.SessionManager.create(repo, join(caseHome, 'sessions'))
  held.appendMessage(user)
  held.appendMessage(assistant)
  const heldFile = held.getSessionFile()
  if (heldFile === undefined) throw new Error('Pi did not persist the held conversation')
  const respelled = (path: string) => join(sandbox, relative(sandbox, path).toUpperCase())
  if (existsSync(respelled(heldFile)))
    await claim(
      'on a volume that ignores case, dev refuses a conversation another dev session holds, named through another spelling of its file or of its data home',
      async () => {
        const copied = join(caseHome, 'sessions', 'same-session.jsonl')
        copyFileSync(heldFile, copied)
        const holding = Scope.makeUnsafe()
        try {
          const lease = await Effect.runPromise(
            Scope.provide(holding)(
              acquireRuntime(caseHome, { installationPath: sandbox, namespacePath: authorityRoot })
            )
          )
          await Effect.runPromise(lease.protect({ path: heldFile, sessionId: held.getSessionId() }))
          for (const resumed of [respelled(heldFile), respelled(copied)]) {
            const outcome = await runLauncher(
              ['--resume', resumed, '--data-home', respelled(caseHome), '--profile', 'general'],
              { STOP_AFTER_ATTACH: '1' }
            )
            assert.equal(outcome.code, 1, outcome.stderr)
            assert.match(
              outcome.stderr,
              /This conversation is already open in another dev session/,
              resumed
            )
          }
        } finally {
          await Effect.runPromise(Scope.close(holding, Exit.void))
        }
      }
    )
  console.log(
    JSON.stringify(
      {
        result: 'passed',
        checks: passed,
        limitation:
          'The launcher runs with a lifecycle injected on a temporary authority root; the fixed per-account root is not touched. The runtime probe runs with a disposable HOME, so it reads no global Pi agent state and calls no model.',
      },
      null,
      2
    )
  )
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}
