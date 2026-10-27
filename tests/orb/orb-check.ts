import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Effect, Stream } from 'effect'
import { identityTokensUrl, parseToken, type Keystone, type Orbit } from '../../src/orb/cloud.ts'
import { orbFailure } from '../../src/orb/domain.ts'
import { macHomes, openOrbSession, withReturnAdmission } from '../../src/orb/session.ts'
import { masterOptions, sshOptions } from '../../src/orb/ssh.ts'
import { orbToolAccess } from '../../src/integrated-tools.ts'
import {
  refusals,
  returnWork,
  upload,
  inspectCheckout,
  type OrbRepository,
} from '../../src/orb/transfer.ts'
import { toolEffect } from '../../src/workspace-host.ts'
import { makeClaims } from '../workspace/workspace-check-support.ts'
import { writeProfileFixture } from '../profile-fixture.ts'
import type { PiApi } from '../../src/pi-runtime.ts'
import type { WorkspaceAttachment, WorkspaceGrant } from '../../src/workspace-domain.ts'

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'dev-orb-check-')))
process.on('exit', () => rmSync(sandbox, { recursive: true, force: true }))
const { claim, passed } = makeClaims()

const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, NodeServices.layer))

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'check',
      GIT_AUTHOR_EMAIL: 'check@localhost',
      GIT_COMMITTER_NAME: 'check',
      GIT_COMMITTER_EMAIL: 'check@localhost',
    },
  }).trim()

const repository = (orbPath: string): OrbRepository => ({
  url: orbPath,
  protocol: 'file',
  run: script =>
    Effect.try({
      try: () => execFileSync('/bin/bash', ['-c', script], { encoding: 'utf8' }),
      catch: cause => orbFailure(String(cause), cause),
    }),
})

const tree = (root: string): Map<string, string> => {
  const files = new Map<string, string>()
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      if (name === '.git') continue
      const path = join(directory, name)
      const info = lstatSync(path)
      if (info.isDirectory()) walk(path)
      else
        files.set(
          relative(root, path),
          `${(info.mode & 0o777).toString(8)}:${readFileSync(path).toString('base64')}`
        )
    }
  }
  walk(root)
  return files
}

const newCheckout = (name: string): { mac: string; orb: string } => {
  const mac = join(sandbox, name, 'mac')
  const orb = join(sandbox, name, 'orb')
  mkdirSync(mac, { recursive: true })
  mkdirSync(orb, { recursive: true })
  git(mac, 'init', '-q', '-b', 'main')
  writeFileSync(join(mac, 'calc.py'), 'print(1 + 1)\n')
  writeFileSync(join(mac, 'notes.md'), 'first\nsecond\nthird\n')
  writeFileSync(join(mac, 'blob.bin'), Buffer.from([0, 1, 2, 255, 254, 13, 10]))
  git(mac, 'add', '-A')
  git(mac, 'commit', '-q', '-m', 'initial')
  return { mac, orb }
}

const startOrb = async (mac: string, orb: string, record: string) => {
  const checkout = await run(inspectCheckout(mac))
  await run(
    upload({
      checkout,
      orbPath: orb,
      repository: repository(orb),
      baseRef: `refs/dev/orb/${record}/base`,
    })
  )
  return checkout
}

const change = (path: string, mode = '100644') => ({ mode, blob: path, path })
const tool = (name: string, source: string, path: string) => ({
  name,
  sourceInfo: { source, path },
})

const returnFrom = (mac: string, orb: string, record: string) =>
  run(
    returnWork({
      root: mac,
      branch: 'main',
      orbPath: orb,
      repository: repository(orb),
      baseRef: `refs/dev/orb/${record}/base`,
      endRef: `refs/dev/orb/${record}/end`,
      beforeWrite: Effect.void,
    })
  )

await claim(
  'a clean return fast-forwards the branch with the orb SHAs, leaves a byte-identical tree including uncommitted, untracked, binary and executable files, and needs nothing on a second sync',
  async () => {
    const { mac, orb } = newCheckout('clean')
    writeFileSync(join(mac, 'notes.md'), 'first\nsecond\nthird\nuncommitted on the Mac\n')
    await startOrb(mac, orb, 'clean')
    assert.equal(git(orb, 'rev-parse', 'HEAD'), git(mac, 'rev-parse', 'HEAD'))
    assert.equal(
      readFileSync(join(orb, 'notes.md'), 'utf8'),
      'first\nsecond\nthird\nuncommitted on the Mac\n',
      'the upload carries uncommitted changes as uncommitted changes'
    )
    assert.match(git(orb, 'status', '--porcelain'), /M notes.md/)
    writeFileSync(join(orb, 'calc.py'), 'print(2 ** 10)\n')
    git(orb, 'add', 'calc.py')
    git(orb, 'commit', '-q', '-m', 'orb commit one')
    writeFileSync(join(orb, 'run.sh'), '#!/bin/sh\necho run\n')
    chmodSync(join(orb, 'run.sh'), 0o755)
    git(orb, 'add', 'run.sh')
    git(orb, 'commit', '-q', '-m', 'orb commit two')
    writeFileSync(join(orb, 'blob.bin'), Buffer.from([9, 0, 13, 10, 255]))
    writeFileSync(join(orb, 'untracked.txt'), 'new on the orb\n')
    const orbHead = git(orb, 'rev-parse', 'HEAD')
    const outcome = await returnFrom(mac, orb, 'clean')
    assert.deepEqual(outcome, { kind: 'returned', head: orbHead, commits: 2, files: 4 })
    assert.equal(git(mac, 'rev-parse', 'HEAD'), orbHead, 'the branch has the orb SHAs')
    assert.equal(git(mac, 'symbolic-ref', '--short', 'HEAD'), 'main')
    assert.deepEqual(tree(mac), tree(orb), 'the Mac tree is byte-identical to the orb tree')
    assert.match(git(mac, 'status', '--porcelain'), /\?\? untracked.txt/)
    assert.deepEqual(await returnFrom(mac, orb, 'clean'), { kind: 'unchanged' })
  }
)

await claim(
  'local edits that do not overlap survive the return beside the orb changes, and ignored local files stay untouched',
  async () => {
    const { mac, orb } = newCheckout('local-edits')
    writeFileSync(join(mac, '.gitignore'), 'build/\n')
    git(mac, 'add', '.gitignore')
    git(mac, 'commit', '-q', '-m', 'ignore build')
    await startOrb(mac, orb, 'edits')
    writeFileSync(join(orb, 'calc.py'), 'print(3 * 3)\n')
    git(orb, 'commit', '-q', '-am', 'orb edits calc')
    writeFileSync(join(mac, 'notes.md'), 'first\nsecond\nthird\nlocal line\n')
    writeFileSync(join(mac, 'local.txt'), 'local only\n')
    mkdirSync(join(mac, 'build'))
    writeFileSync(join(mac, 'build', 'out.o'), 'ignored')
    const outcome = await returnFrom(mac, orb, 'edits')
    assert.equal(outcome.kind, 'returned')
    assert.equal(readFileSync(join(mac, 'calc.py'), 'utf8'), 'print(3 * 3)\n')
    assert.equal(readFileSync(join(mac, 'notes.md'), 'utf8'), 'first\nsecond\nthird\nlocal line\n')
    assert.equal(readFileSync(join(mac, 'local.txt'), 'utf8'), 'local only\n')
    assert.equal(readFileSync(join(mac, 'build', 'out.o'), 'utf8'), 'ignored')
    assert.equal(git(mac, 'rev-parse', 'HEAD'), git(orb, 'rev-parse', 'HEAD'))
  }
)

await claim(
  'a moved branch or an overlap stops the return and leaves the branch, index and files untouched',
  async () => {
    const { mac, orb } = newCheckout('stops')
    await startOrb(mac, orb, 'stops')
    writeFileSync(join(orb, 'notes.md'), 'first\nchanged on the orb\nthird\n')
    writeFileSync(join(mac, 'notes.md'), 'first\nchanged on the Mac\nthird\n')
    git(mac, 'add', 'notes.md')
    const before = { head: git(mac, 'rev-parse', 'HEAD'), index: git(mac, 'diff', '--cached') }
    const overlap = await returnFrom(mac, orb, 'stops')
    assert.equal(overlap.kind === 'stopped' ? overlap.reason : overlap.kind, 'overlap')
    assert.equal(git(mac, 'rev-parse', 'HEAD'), before.head)
    assert.equal(git(mac, 'diff', '--cached'), before.index)
    assert.equal(readFileSync(join(mac, 'notes.md'), 'utf8'), 'first\nchanged on the Mac\nthird\n')
    git(mac, 'commit', '-q', '-m', 'mac moves on')
    const moved = await returnFrom(mac, orb, 'stops')
    assert.equal(moved.kind === 'stopped' ? moved.reason : moved.kind, 'branch-moved')
  }
)

await claim(
  'the applier refuses .git paths, symlinks leaving the checkout, writes through symlinked directories, hard links and modes other than 0644 and 0755',
  async () => {
    const root = join(sandbox, 'applier')
    mkdirSync(join(root, 'inside'), { recursive: true })
    writeFileSync(join(root, 'linked.txt'), 'one')
    linkSync(join(root, 'linked.txt'), join(sandbox, 'elsewhere.txt'))
    symlinkSync(sandbox, join(root, 'escape'))
    const targets: Record<string, string> = {
      'out-link': '../../etc',
      'in-link': 'inside/file',
      'git-link': 'sub/../.Git/hooks',
    }
    const refused = refusals(
      root,
      [
        change('.git/config'),
        change('sub/.GIT/hooks/post-checkout'),
        change('module', '160000'),
        change('out-link', '120000'),
        change('in-link', '120000'),
        change('git-link', '120000'),
        change('escape/file.txt'),
        change('linked.txt'),
        change('inside/ok.txt'),
        change('run.sh', '100755'),
        change('gone.txt', '000000'),
      ],
      item => targets[item.path] ?? ''
    )
    assert.deepEqual(
      refused.map(reason => reason.split(':')[0]),
      [
        '.git/config',
        'sub/.GIT/hooks/post-checkout',
        'module',
        'out-link',
        'git-link',
        'escape/file.txt',
        'linked.txt',
      ]
    )
  }
)

await claim(
  'a return carrying a refused entry writes nothing: the branch, index and files keep their state',
  async () => {
    const { mac, orb } = newCheckout('refused')
    await startOrb(mac, orb, 'refused')
    symlinkSync('/etc/passwd', join(orb, 'passwd'))
    writeFileSync(join(orb, 'calc.py'), 'print(0)\n')
    git(orb, 'add', '-A')
    git(orb, 'commit', '-q', '-m', 'escaping link')
    const head = git(mac, 'rev-parse', 'HEAD')
    await assert.rejects(returnFrom(mac, orb, 'refused'), /a symlink leaving the checkout/)
    assert.equal(git(mac, 'rev-parse', 'HEAD'), head)
    assert.equal(readFileSync(join(mac, 'calc.py'), 'utf8'), 'print(1 + 1)\n')
    assert.ok(!existsSync(join(mac, 'passwd')))
  }
)

await claim(
  "the transfer's Git runs no hook, clean or smudge filter or merge driver configured on the Mac, even with a returned .gitattributes naming them",
  async () => {
    const { mac, orb } = newCheckout('inert')
    const marker = join(sandbox, 'inert-marker')
    const touch = `sh -c 'echo $0 >> ${marker}; cat'`
    git(mac, 'config', 'filter.marker.clean', touch)
    git(mac, 'config', 'filter.marker.smudge', touch)
    git(mac, 'config', 'filter.marker.required', 'true')
    git(mac, 'config', 'merge.marker.driver', `sh -c 'echo merge >> ${marker}; exit 1'`)
    writeFileSync(join(mac, '.git', 'info', 'attributes'), '*.md filter=marker merge=marker\n')
    for (const hook of ['reference-transaction', 'post-checkout', 'pre-push', 'post-merge']) {
      writeFileSync(join(mac, '.git', 'hooks', hook), `#!/bin/sh\necho ${hook} >> ${marker}\n`)
      chmodSync(join(mac, '.git', 'hooks', hook), 0o755)
    }
    writeFileSync(join(mac, 'notes.md'), 'first\nsecond\nthird\nlocal\n')
    await startOrb(mac, orb, 'inert')
    writeFileSync(join(orb, '.gitattributes'), '* filter=marker merge=marker\n')
    writeFileSync(join(orb, 'notes.md'), 'orb\nfirst\nsecond\nthird\nlocal\n')
    git(orb, 'add', '-A')
    git(orb, 'commit', '-q', '-m', 'orb attributes')
    writeFileSync(join(mac, 'notes.md'), 'first\nsecond\nthird\nlocal\nmore local\n')
    const outcome = await returnFrom(mac, orb, 'inert')
    assert.equal(
      outcome.kind,
      'returned',
      `${JSON.stringify(outcome)} ${existsSync(marker) ? readFileSync(marker, 'utf8') : 'no marker'}`
    )
    assert.equal(
      readFileSync(join(mac, 'notes.md'), 'utf8'),
      'orb\nfirst\nsecond\nthird\nlocal\nmore local\n',
      'the default three-way merge combined both edits'
    )
    assert.ok(!existsSync(marker), existsSync(marker) ? readFileSync(marker, 'utf8') : '')
  }
)

await claim(
  "Keystone's token is read from X-Subject-Token and orbit's URL is the public endpoint of catalog type orbit in the configured region",
  async () => {
    assert.equal(
      identityTokensUrl('http://192.0.2.1/identity/'),
      'http://192.0.2.1/identity/v3/auth/tokens'
    )
    assert.equal(
      identityTokensUrl('http://192.0.2.1:5000/v3'),
      'http://192.0.2.1:5000/v3/auth/tokens'
    )
    const body = JSON.stringify({
      token: {
        expires_at: '2026-10-27T22:00:00.000000Z',
        project: { id: 'p1', name: 'demo' },
        catalog: [
          {
            type: 'compute',
            endpoints: [{ interface: 'public', region: 'RegionOne', url: 'http://n' }],
          },
          {
            type: 'orbit',
            endpoints: [
              { interface: 'internal', region: 'RegionOne', url: 'http://internal/orbit' },
              { interface: 'public', region: 'RegionTwo', url: 'http://two/orbit' },
              { interface: 'public', region: 'RegionOne', url: 'http://one/orbit/' },
            ],
          },
        ],
      },
    })
    const token = await run(
      parseToken({ status: 201, headers: { 'x-subject-token': 'gAAAA-token' }, body }, 'RegionOne')
    )
    assert.equal(token.id, 'gAAAA-token')
    assert.equal(token.orbitUrl, 'http://one/orbit')
    assert.equal(token.expiresAt, Date.parse('2026-10-27T22:00:00Z'))
    await assert.rejects(
      run(parseToken({ status: 201, headers: {}, body }, 'RegionOne')),
      /X-Subject-Token/
    )
    await assert.rejects(
      run(parseToken({ status: 401, headers: {}, body: '{}' }, undefined)),
      /refused the token request \(401\)/
    )
  }
)

await claim(
  'the host classifies dev:orb tools as orb-remote and keeps refusing same-named tools from any other source',
  () => {
    for (const name of ['bash', 'read', 'write', 'edit', 'grep', 'find', 'ls'])
      assert.equal(toolEffect(tool(name, 'inline', '<inline:dev:orb>')), 'orb-remote', name)
    assert.equal(toolEffect(tool('read', 'inline', '<inline:dev:other>')), undefined)
    assert.equal(toolEffect(tool('bash', 'inline', '<inline:dev:orbit>')), undefined)
    assert.equal(toolEffect(tool('bash', 'npm', '<inline:dev:orb>')), undefined)
    assert.equal(toolEffect(tool('curl', 'inline', '<inline:dev:orb>')), undefined)
    assert.equal(toolEffect(tool('bash', 'sdk', '<sdk:bash>')), 'workspace-shell')
    assert.equal(toolEffect(tool('read', 'builtin', '<builtin:read>')), 'read')
  }
)

await claim(
  'the host and child gates share one orb predicate: read, grep, find and ls are reads, bash, write and edit are writes, and nothing else from dev:orb or another source is an orb tool',
  () => {
    const orb = (name: string) => tool(name, 'inline', '<inline:dev:orb>')
    for (const name of ['read', 'grep', 'find', 'ls'])
      assert.equal(orbToolAccess(orb(name)), 'read')
    for (const name of ['bash', 'write', 'edit']) assert.equal(orbToolAccess(orb(name)), 'write')
    assert.equal(orbToolAccess(orb('workspace')), undefined)
    assert.equal(orbToolAccess(tool('read', 'builtin', '<builtin:read>')), undefined)
    assert.equal(orbToolAccess(tool('bash', 'sdk', '<sdk:bash>')), undefined)
    assert.equal(orbToolAccess(undefined), undefined)
  }
)

await claim(
  "only Pi's spill files, skill files outside the checkout and the task artifact directory stay on the Mac; writes stay there only for the artifact directory",
  () => {
    const checkout = join(sandbox, 'homes-checkout')
    const skills = join(sandbox, 'homes-skills')
    const artifacts = join(sandbox, 'homes-artifacts')
    const homes = macHomes({
      checkout,
      skillPaths: [skills, join(checkout, '.agents', 'skills')],
      artifacts: () => [artifacts],
    })
    const temporary = tmpdir()
    assert.ok(homes.read(join(temporary, 'pi-bash-0123456789abcdef.log')))
    assert.ok(homes.read(join(realpathSync(temporary), 'pi-codemode-0123456789abcdef.txt')))
    assert.ok(!homes.read(join(temporary, 'notes.txt')), 'a plain temporary file goes to the orb')
    assert.ok(!homes.read(join(temporary, 'nested', 'pi-bash-0123456789abcdef.log')))
    assert.ok(homes.read(join(skills, 'tool', 'SKILL.md')))
    assert.ok(!homes.read(join(checkout, '.agents', 'skills', 'local', 'SKILL.md')))
    assert.ok(!homes.read(join(checkout, 'calc.py')))
    assert.ok(homes.read(join(artifacts, 'report.md')) && homes.write(join(artifacts, 'report.md')))
    assert.ok(!homes.write(join(skills, 'tool', 'SKILL.md')))
    assert.ok(!homes.write(join(temporary, 'pi-bash-0123456789abcdef.log')))
  }
)

await claim(
  'every SSH invocation pins host keys and forwards nothing; only the control master is a master',
  () => {
    const target = {
      user: 'ubuntu',
      host: '192.0.2.7',
      keyPath: '/k',
      knownHostsPath: '/kh',
      controlPath: '/mux',
    }
    for (const options of [sshOptions(target), masterOptions(target)]) {
      const settings = options.join(' ')
      for (const required of [
        '-F /dev/null',
        'StrictHostKeyChecking=yes',
        'UserKnownHostsFile=/kh',
        'GlobalKnownHostsFile=/dev/null',
        'IdentityAgent=none',
        'ForwardAgent=no',
        'ClearAllForwardings=yes',
      ])
        assert.ok(settings.includes(required), `${required} in ${settings}`)
    }
    assert.ok(sshOptions(target).includes('ControlMaster=no'))
    assert.ok(!sshOptions(target).includes('ControlMaster=yes'))
    assert.ok(masterOptions(target).includes('ControlMaster=yes'))
    assert.ok(!masterOptions(target).includes('ControlMaster=no'))
  }
)

await claim(
  'every admitted return reports its completion, also when the start report or the return itself fails, so no orb-return use stays open',
  async () => {
    const within = { useId: 'presence' } as unknown as WorkspaceGrant
    const scenario = async (startFails: boolean, writeFails: boolean) => {
      const facts: string[] = []
      const attachment = {
        authorize: () =>
          Effect.succeed({
            kind: 'ready',
            grant: { useId: 'return' } as unknown as WorkspaceGrant,
          }),
        reportExecution: (_grant: WorkspaceGrant, fact: { readonly kind: string }) =>
          Effect.suspend(() => {
            facts.push(fact.kind)
            return startFails && fact.kind === 'operation-started'
              ? Effect.fail(orbFailure('report refused'))
              : Effect.succeed({})
          }),
      } as unknown as WorkspaceAttachment
      const write = Effect.suspend(() => {
        facts.push('write')
        return writeFails ? Effect.fail(orbFailure('git failed')) : Effect.succeed('done')
      })
      const outcome = await Effect.runPromiseExit(
        withReturnAdmission(attachment, within, '/checkout', write, () => undefined)
      )
      return { facts, ok: outcome._tag === 'Success' }
    }
    assert.deepEqual(await scenario(false, false), {
      facts: ['operation-started', 'write', 'operation-completed'],
      ok: true,
    })
    assert.deepEqual(await scenario(true, false), {
      facts: ['operation-started', 'operation-completed'],
      ok: false,
    })
    assert.deepEqual(await scenario(false, true), {
      facts: ['operation-started', 'write', 'operation-completed'],
      ok: false,
    })
  }
)

await claim(
  'the orb record exists in phase requested, with its private key, before the orbit request is sent',
  async () => {
    const { mac } = newCheckout('record')
    const dataHome = join(sandbox, 'record-data')
    mkdirSync(dataHome, { mode: 0o700 })
    const grant = { useId: 'presence-use' } as unknown as WorkspaceGrant
    const attachment = {
      binding: { taskId: undefined },
      authorize: () => Effect.succeed({ kind: 'ready', grant }),
      sweeps: Stream.empty,
    } as unknown as WorkspaceAttachment
    let observed: unknown
    const keystone: Keystone = {
      authUrl: 'http://192.0.2.1/identity',
      token: Effect.succeed({
        id: 'token',
        expiresAt: undefined,
        orbitUrl: 'http://192.0.2.1/orbit',
        project: { id: 'p1', name: 'demo' },
      }),
      invalidate: Effect.void,
    }
    const unused = Effect.die('the check sends only the creation request')
    const orbit: Orbit = {
      url: Effect.succeed('http://192.0.2.1/orbit'),
      create: () =>
        Effect.suspend(() => {
          const [id] = readdirSync(join(dataHome, 'orbs'))
          const directory = join(dataHome, 'orbs', id ?? '')
          const record = JSON.parse(readFileSync(join(directory, 'record.json'), 'utf8'))
          observed = {
            phase: record.phase,
            orbId: record.orbId,
            presence: record.presenceUseId,
            key: lstatSync(join(directory, 'key')).mode & 0o777,
            pub: readFileSync(join(directory, 'key.pub'), 'utf8').startsWith('ssh-ed25519 '),
          }
          return Effect.fail(orbFailure('the check stops before orbit'))
        }),
      get: () => unused,
      remove: () => unused,
      list: unused,
    }
    const lines: string[] = []
    const env: NodeJS.ProcessEnv = {
      OS_AUTH_URL: 'http://192.0.2.1/identity',
      OS_USERNAME: 'demo',
      OS_PASSWORD: 'secret',
      OS_PROJECT_NAME: 'demo',
      OS_CACERT: '',
      KEEP: 'kept',
    }
    await assert.rejects(
      run(
        openOrbSession(
          {
            pi: {} as PiApi,
            dataHome,
            env,
            print: line => lines.push(line),
            cloud: () => ({ keystone, orbit }),
          },
          {
            attachment,
            cwd: mac,
            authorityRoot: join(sandbox, 'authority'),
            skillPaths: [],
            conversation: join(dataHome, 'session.jsonl'),
          }
        )
      ),
      /the check stops before orbit/
    )
    assert.deepEqual(observed, {
      phase: 'requested',
      orbId: undefined,
      presence: 'presence-use',
      key: 0o600,
      pub: true,
    })
    assert.deepEqual(
      readdirSync(join(dataHome, 'orbs')),
      [],
      'a launch that created no orb leaves no record'
    )
    assert.deepEqual(env, { KEEP: 'kept' }, 'the OS_* variables are removed after reading them')
  }
)

await claim('plain dev loads no orb module and reads no OS_* variable', async () => {
  const repo = join(sandbox, 'plain-repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'initial')
  const home = join(sandbox, 'plain-home')
  mkdirSync(join(home, '.agents', 'skills'), { recursive: true })
  const report = join(sandbox, 'plain-report.txt')
  writeFileSync(report, '')
  const profiles = writeProfileFixture(join(sandbox, 'plain-profiles'))
  const authority = join(sandbox, 'plain-authority')
  const driver = `
      import { NodeRuntime } from '@effect/platform-node'
      import { launch } from ${JSON.stringify(new URL('../../src/launcher-runtime.ts', import.meta.url).href)}
      import { makeWorkspaceLifecycle } from ${JSON.stringify(new URL('../../src/workspace-lifecycle.ts', import.meta.url).href)}
      const root = ${JSON.stringify(authority)}
      NodeRuntime.runMain(launch(process.argv.slice(1), {
        workspaceLifecycle: makeWorkspaceLifecycle({ root }),
        coordination: { installationPath: ${JSON.stringify(sandbox)}, namespacePath: root },
      }), { disableErrorReporting: true })
    `
  const outcome = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    resolveRun => {
      execFile(
        process.execPath,
        [
          '--import',
          new URL('./plain-dev-preload.ts', import.meta.url).href,
          '--input-type=module',
          '-e',
          driver,
          '--',
          '--probe-runtime',
          '--cwd',
          repo,
          '--data-home',
          join(sandbox, 'plain-data'),
        ],
        {
          cwd: new URL('../..', import.meta.url).pathname,
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(([name]) => !name.startsWith('OS_'))
            ),
            HOME: home,
            PI_OFFLINE: '1',
            DEV_PROFILES: profiles.root,
            ORB_PLAIN_REPORT: report,
          },
          timeout: 60_000,
        },
        (error, stdout, stderr) =>
          resolveRun({ code: error === null ? 0 : (error.code as number | null), stdout, stderr })
      )
    }
  )
  assert.equal(outcome.code, 0, outcome.stderr)
  assert.match(outcome.stdout, /^runtime probe: ok$/m)
  const recorded = readFileSync(report, 'utf8')
  assert.match(recorded, /^hooks installed$/m, 'the preload observed the launch')
  assert.doesNotMatch(recorded, /^module /m, recorded)
  assert.doesNotMatch(recorded, /^env /m, recorded)
})

process.stdout.write(
  `orb check: ${passed.length} claims passed\n${passed.map(text => `- ${text}`).join('\n')}\n`
)
