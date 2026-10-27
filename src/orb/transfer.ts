import { randomUUID } from 'node:crypto'
import { lstatSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { Effect, type Scope } from 'effect'
import type { ChildProcessSpawner } from 'effect/process'
import { runCommand, type CommandResult } from '../command.ts'
import { isWithin } from '../workspace-paths.ts'
import { orbFailure, type OrbError } from './domain.ts'
import { shq } from './ssh.ts'

export interface OrbRepository {
  readonly url: string
  readonly protocol: 'ssh' | 'file'
  readonly gitSshCommand?: string
  run(script: string): Effect.Effect<string, OrbError>
}

export interface LocalCheckout {
  readonly root: string
  readonly branch: string
  readonly head: string
}

export type ReturnOutcome =
  | { readonly kind: 'unchanged' }
  | {
      readonly kind: 'returned'
      readonly head: string
      readonly commits: number
      readonly files: number
    }
  | {
      readonly kind: 'stopped'
      readonly reason: 'branch-moved' | 'branch-switched' | 'overlap'
      readonly message: string
    }

export interface Change {
  readonly mode: string
  readonly blob: string
  readonly path: string
}

type GitServices = ChildProcessSpawner.ChildProcessSpawner

const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: 'dev',
  GIT_AUTHOR_EMAIL: 'dev@localhost',
  GIT_COMMITTER_NAME: 'dev',
  GIT_COMMITTER_EMAIL: 'dev@localhost',
}
const GIT_TIMEOUT = '5 minutes'
const ALLOWED_MODES = new Set(['100644', '100755', '120000'])

interface Git {
  readonly root: string
  run(
    args: readonly string[],
    options?: {
      readonly index?: string
      readonly exitCodes?: readonly number[]
      readonly env?: Record<string, string>
    }
  ): Effect.Effect<CommandResult, OrbError, GitServices>
  text(args: readonly string[], index?: string): Effect.Effect<string, OrbError, GitServices>
}

const plainGit = (root: string, args: readonly string[], exitCodes: readonly number[] = [0]) =>
  runCommand('git', ['-C', root, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    timeout: GIT_TIMEOUT,
    exitCodes,
  }).pipe(Effect.mapError(cause => orbFailure(cause.message.trim(), cause)))

export const hardenedGit = Effect.fnUntraced(function* (
  root: string,
  protocol: OrbRepository['protocol'],
  gitSshCommand?: string
): Effect.fn.Return<Git, OrbError, GitServices> {
  const configured = yield* plainGit(
    root,
    ['config', '--name-only', '--get-regexp', String.raw`^(filter|merge)\.`],
    [0, 1]
  )
  const driverNames = (section: string): ReadonlySet<string> =>
    new Set(
      configured.stdout
        .split('\n')
        .filter(line => line.startsWith(`${section}.`) && line.split('.').length > 2)
        .map(line => line.split('.').slice(1, -1).join('.'))
    )
  const filters = driverNames('filter')
  const mergers = driverNames('merge')
  const emptyTree = (yield* plainGit(root, [
    'hash-object',
    '-t',
    'tree',
    '/dev/null',
  ])).stdout.trim()
  const options = [
    '--no-pager',
    `--attr-source=${emptyTree}`,
    ...[
      'core.hooksPath=/dev/null',
      'core.fsmonitor=false',
      'core.untrackedCache=false',
      'core.autocrlf=false',
      'core.safecrlf=false',
      'core.attributesFile=/dev/null',
      'transfer.fsckObjects=true',
      'fetch.fsckObjects=true',
      'protocol.allow=never',
      `protocol.${protocol}.allow=always`,
      ...[...mergers].map(name => `merge.${name}.driver=git merge-file %A %O %B`),
      ...[...filters].flatMap(name => [
        `filter.${name}.clean=`,
        `filter.${name}.smudge=`,
        `filter.${name}.process=`,
        `filter.${name}.required=false`,
      ]),
    ].flatMap(setting => ['-c', setting]),
  ]
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
    ...(gitSshCommand === undefined ? {} : { GIT_SSH_COMMAND: gitSshCommand }),
    ...SNAPSHOT_IDENTITY,
  }
  const run: Git['run'] = (args, runOptions = {}) =>
    runCommand('git', [...options, '-C', root, ...args], {
      env: {
        ...env,
        ...runOptions.env,
        ...(runOptions.index === undefined ? {} : { GIT_INDEX_FILE: runOptions.index }),
      },
      timeout: GIT_TIMEOUT,
      maxOutputLength: 64 * 1024 * 1024,
      ...(runOptions.exitCodes === undefined ? {} : { exitCodes: runOptions.exitCodes }),
    }).pipe(Effect.mapError(cause => orbFailure(cause.message.trim(), cause)))
  return {
    root,
    run,
    text: (args, index) =>
      Effect.map(run(args, index === undefined ? {} : { index }), result => result.stdout.trim()),
  }
})

export const inspectCheckout = Effect.fnUntraced(function* (
  cwd: string
): Effect.fn.Return<LocalCheckout, OrbError, GitServices> {
  const root = (yield* plainGit(cwd, ['rev-parse', '--show-toplevel'])).stdout.trim()
  const branch = (yield* plainGit(
    root,
    ['symbolic-ref', '-q', '--short', 'HEAD'],
    [0, 1]
  )).stdout.trim()
  if (branch.length === 0)
    return yield* orbFailure(
      `dev --orb needs a checked-out branch; ${root} has a detached HEAD. Switch to a branch, then launch again.`
    )
  const head = yield* plainGit(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], [0, 1])
  if (head.exitCode !== 0)
    return yield* orbFailure(
      `dev --orb needs at least one commit on ${branch} in ${root}. Commit once, then launch again.`
    )
  return { root, branch, head: head.stdout.trim() }
})

const temporaryIndex = Effect.acquireRelease(
  Effect.sync(() => join(tmpdir(), `dev-orb-index-${randomUUID()}`)),
  path =>
    Effect.sync(() => {
      rmSync(path, { force: true })
    })
)

export interface Snapshot {
  readonly commit: string
  readonly index: string
}

export const snapshot = Effect.fnUntraced(function* (
  git: Git
): Effect.fn.Return<Snapshot, OrbError, GitServices | Scope.Scope> {
  const index = yield* temporaryIndex
  yield* git.run(['read-tree', 'HEAD'], { index })
  yield* git.run(['add', '-A'], { index })
  const tree = yield* git.text(['write-tree'], index)
  const commit = yield* git.text(['commit-tree', '-p', 'HEAD', '-m', 'dev orb snapshot', tree])
  return { commit, index }
})

const orbInitScript = (
  root: string,
  branch: string,
  identity: { readonly name?: string; readonly email?: string }
): string =>
  [
    'set -e',
    `r=${shq(root)}`,
    'if [ ! -d "$r" ]; then sudo -n mkdir -p "$r"; fi',
    'if [ ! -O "$r" ]; then sudo -n chown "$(id -un):$(id -gn)" "$r"; fi',
    'git init -q "$r"',
    'git -C "$r" config receive.denyCurrentBranch updateInstead',
    `git -C "$r" symbolic-ref HEAD ${shq(`refs/heads/${branch}`)}`,
    ...(identity.name === undefined ? [] : [`git -C "$r" config user.name ${shq(identity.name)}`]),
    ...(identity.email === undefined
      ? []
      : [`git -C "$r" config user.email ${shq(identity.email)}`]),
  ].join('\n')

const orbEndScript = (root: string): string =>
  [
    'set -e',
    `cd ${shq(root)}`,
    'i=$(mktemp)',
    'rm -f "$i"',
    'trap \'rm -f "$i"\' EXIT',
    ...Object.entries(SNAPSHOT_IDENTITY).map(([name, value]) => `export ${name}=${shq(value)}`),
    'GIT_INDEX_FILE="$i" git read-tree HEAD',
    'GIT_INDEX_FILE="$i" git add -A',
    't=$(GIT_INDEX_FILE="$i" git write-tree)',
    'c=$(git commit-tree -p HEAD -m \'dev orb snapshot\' "$t")',
    'git update-ref refs/dev/end "$c"',
    'echo "$c"',
  ].join('\n')

const configValue = (git: Git, name: string) =>
  Effect.map(git.run(['config', '--get', name], { exitCodes: [0, 1] }), result =>
    result.exitCode === 0 && result.stdout.trim().length > 0 ? result.stdout.trim() : undefined
  )

export const upload = Effect.fnUntraced(function* (input: {
  readonly checkout: LocalCheckout
  readonly orbPath: string
  readonly repository: OrbRepository
  readonly baseRef: string
}): Effect.fn.Return<{ readonly snapshot: string }, OrbError, GitServices> {
  const { checkout, repository } = input
  const git = yield* hardenedGit(checkout.root, repository.protocol, repository.gitSshCommand)
  const taken = yield* Effect.scoped(snapshot(git))
  const name = yield* configValue(git, 'user.name')
  const email = yield* configValue(git, 'user.email')
  yield* repository.run(
    orbInitScript(input.orbPath, checkout.branch, {
      ...(name === undefined ? {} : { name }),
      ...(email === undefined ? {} : { email }),
    })
  )
  yield* git.run(['push', '-q', repository.url, `${taken.commit}:refs/heads/${checkout.branch}`])
  yield* repository.run(`git -C ${shq(input.orbPath)} reset -q ${checkout.head}`)
  yield* git.run(['update-ref', input.baseRef, taken.commit])
  return { snapshot: taken.commit }
})

const parseRawDiff = (output: string): readonly Change[] => {
  const fields = output.split('\0')
  const changes: Change[] = []
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const header = fields[index]
    const path = fields[index + 1]
    if (header === undefined || path === undefined || header.length === 0) continue
    const [, mode, , blob] = header.replace(/^:/, '').split(' ')
    if (mode === undefined || blob === undefined) continue
    changes.push({ mode, blob, path })
  }
  return changes
}

const insideGit = (path: string): boolean =>
  path.split(/[\\/]/).some(segment => segment.toLowerCase() === '.git')

export const refusals = (
  root: string,
  changes: readonly Change[],
  symlinkTarget: (change: Change) => string
): readonly string[] =>
  changes.flatMap(change => {
    const reasons: string[] = []
    const segments = change.path.split('/')
    if (insideGit(change.path)) reasons.push(`${change.path}: a path inside .git`)
    if (change.mode !== '000000' && !ALLOWED_MODES.has(change.mode))
      reasons.push(`${change.path}: mode ${change.mode} is not 0644 or 0755`)
    if (change.mode === '120000') {
      const target = symlinkTarget(change)
      const destination = isAbsolute(target)
        ? target
        : resolve(dirname(join(root, change.path)), target)
      if (!isWithin(root, destination))
        reasons.push(`${change.path}: a symlink leaving the checkout (${target})`)
      else if (insideGit(relative(root, destination)))
        reasons.push(`${change.path}: a symlink into .git (${target})`)
    }
    for (let depth = 1; depth < segments.length; depth += 1) {
      const ancestor = join(root, ...segments.slice(0, depth))
      if (lstatSync(ancestor, { throwIfNoEntry: false })?.isSymbolicLink() === true) {
        reasons.push(
          `${change.path}: written through the symlink ${segments.slice(0, depth).join('/')}`
        )
        break
      }
    }
    const existing = lstatSync(join(root, change.path), { throwIfNoEntry: false })
    if (existing?.isFile() === true && existing.nlink > 1)
      reasons.push(`${change.path}: a hard link`)
    return reasons
  })

export const returnWork = Effect.fnUntraced(function* (input: {
  readonly root: string
  readonly branch: string
  readonly orbPath: string
  readonly repository: OrbRepository
  readonly baseRef: string
  readonly endRef: string
  readonly beforeWrite: Effect.Effect<void, OrbError>
}): Effect.fn.Return<ReturnOutcome, OrbError, GitServices> {
  const { repository } = input
  const git = yield* hardenedGit(input.root, repository.protocol, repository.gitSshCommand)
  yield* repository.run(orbEndScript(input.orbPath))
  yield* git.run([
    'fetch',
    '-q',
    '--no-tags',
    '--no-write-fetch-head',
    repository.url,
    `+refs/dev/end:${input.endRef}`,
  ])
  const end = yield* git.text(['rev-parse', '--verify', `${input.endRef}^{commit}`])
  const orbHead = yield* git.text(['rev-parse', '--verify', `${end}^1`])
  const base = yield* git.text(['rev-parse', '--verify', `${input.baseRef}^{commit}`])
  const symbolic = yield* git.run(['symbolic-ref', '-q', 'HEAD'], { exitCodes: [0, 1] })
  if (symbolic.stdout.trim() !== `refs/heads/${input.branch}`)
    return {
      kind: 'stopped',
      reason: 'branch-switched',
      message: `The checkout is no longer on ${input.branch}; the orb's work stays on the orb.`,
    } as const
  const head = yield* git.text(['rev-parse', '--verify', 'HEAD^{commit}'])
  const endTree = yield* git.text(['rev-parse', `${end}^{tree}`])
  const baseTree = yield* git.text(['rev-parse', `${base}^{tree}`])
  if (orbHead === head && endTree === baseTree) return { kind: 'unchanged' } as const
  const ancestor = yield* git.run(['merge-base', '--is-ancestor', head, orbHead], {
    exitCodes: [0, 1],
  })
  if (ancestor.exitCode !== 0)
    return {
      kind: 'stopped',
      reason: 'branch-moved',
      message: `${input.branch} moved on the Mac, so the orb's commits cannot fast-forward it; the orb's work stays on the orb.`,
    } as const
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const local = yield* snapshot(git)
      const merged = yield* git.run(
        ['merge-tree', '--write-tree', '--no-messages', `--merge-base=${base}`, local.commit, end],
        { exitCodes: [0, 1] }
      )
      if (merged.exitCode !== 0)
        return {
          kind: 'stopped',
          reason: 'overlap',
          message: "Local edits overlap the orb's changes; the orb's work stays on the orb.",
        } as const
      const tree = merged.stdout.split('\n')[0]?.trim() ?? ''
      const changes = parseRawDiff(
        (yield* git.run(['diff-tree', '-r', '-z', '--raw', '--no-renames', local.commit, tree]))
          .stdout
      )
      const targets = new Map<string, string>()
      for (const change of changes)
        if (change.mode === '120000')
          targets.set(change.blob, (yield* git.run(['cat-file', 'blob', change.blob])).stdout)
      const refused = refusals(input.root, changes, change => targets.get(change.blob) ?? '')
      if (refused.length > 0)
        return yield* orbFailure(
          `The return was refused and nothing was written:\n${refused.map(reason => `- ${reason}`).join('\n')}`
        )
      yield* input.beforeWrite
      const branchRef = `refs/heads/${input.branch}`
      if (orbHead !== head) yield* git.run(['update-ref', branchRef, orbHead, head])
      yield* git
        .run(['read-tree', '-m', '-u', local.commit, tree], { index: local.index })
        .pipe(
          Effect.tapError(() =>
            orbHead === head
              ? Effect.void
              : Effect.ignore(git.run(['update-ref', branchRef, head, orbHead]))
          )
        )
      yield* git.run(['reset', '-q'])
      yield* git.run(['update-ref', input.baseRef, end])
      const commits = Number(yield* git.text(['rev-list', '--count', `${head}..${orbHead}`]))
      return { kind: 'returned', head: orbHead, commits, files: changes.length } as const
    })
  )
})
