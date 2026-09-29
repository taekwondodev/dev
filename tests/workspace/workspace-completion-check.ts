import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decideCompletion,
  type CompletionFacts,
  type IntegrationFacts,
  type Proof,
  type PullRequestFact,
  type PullRequestSeed,
} from '../../src/workspace-completion.ts'
import type { CompletionVerdict, TaskTarget } from '../../src/workspace-domain.ts'
import {
  deriveTarget,
  githubRepositoryOf,
  integrationFacts,
  recordedTarget,
  type GitHubReader,
} from '../../src/workspace-evidence.ts'
import { symbolicBranch } from '../../src/workspace-git.ts'
import { makeClaims } from './workspace-check-support.ts'
import { checkoutFacts, managedFacts, verdictName } from './workspace-completion-fixtures.ts'

const { claim, passed } = makeClaims()

const yes = (reason: string): Proof => ({ kind: 'yes', reason })
const no = (reason: string): Proof => ({ kind: 'no', reason })
const unknown = (reason: string): Proof => ({ kind: 'unknown', reason })
const pullRequest = (
  number: number,
  seeds: readonly PullRequestSeed[],
  relations: { readonly containsHead: Proof; readonly descendsFromBase: Proof }
): PullRequestFact => ({
  label: `taekwondodev/dev#${number}`,
  seeds,
  ...relations,
})
const integration = (overrides: Partial<IntegrationFacts>): IntegrationFacts => ({
  headInTip: no('the commit is not an ancestor of the current main tip 497c73e'),
  pullRequests: [],
  rejected: [],
  unknown: [],
  ...overrides,
})
const pr43 = (seeds: readonly PullRequestSeed[], base: Proof): PullRequestFact =>
  pullRequest(43, seeds, {
    containsHead: yes('taekwondodev/dev#43 merged source 675382a whose history contains HEAD'),
    descendsFromBase: base,
  })
const managed = managedFacts
const checkout = checkoutFacts

interface Row {
  readonly name: string
  readonly facts: CompletionFacts
  readonly expected: string
  readonly role: CompletionVerdict['role']
  readonly mentions?: readonly string[]
}

const rows: readonly Row[] = [
  {
    name: 'the lead worktree on feat/42-disposable-worktrees at the PR #43 source',
    facts: managed({
      allocation: 'checkout-contention',
      branch: 'refs/heads/feat/42-disposable-worktrees',
      residue: { tracked: 0, untracked: 0, ignored: 6680 },
      ownCommits: true,
      integration: integration({
        pullRequests: [
          pr43(['head', 'override'], yes('taekwondodev/dev#43 descends from base a6013cb')),
        ],
      }),
    }),
    expected: 'branch-merged',
    role: 'branch',
    mentions: ['#43'],
  },
  {
    name: 'the dirty child at a6013cb under task b1c50ea0, through the sibling-seeded PR #43',
    facts: managed({
      residue: { tracked: 2, untracked: 0, ignored: 6448 },
      integration: integration({
        headInTip: yes('a6013cb is an ancestor of the current main tip 497c73e'),
        pullRequests: [
          pr43(
            ['sibling', 'override'],
            yes('taekwondodev/dev#43 merged source 675382a descends from base a6013cb')
          ),
        ],
      }),
    }),
    expected: 'child-delivered',
    role: 'child',
    mentions: ['#43', 'sibling'],
  },
  {
    name: 'the dirty child at 50a26f3 under task b1c50ea0, through the sibling-seeded PR #43',
    facts: managed({
      residue: { tracked: 16, untracked: 0, ignored: 6572 },
      integration: integration({
        headInTip: yes('50a26f3 is an ancestor of the current main tip 497c73e'),
        pullRequests: [
          pr43(
            ['sibling', 'override'],
            yes('taekwondodev/dev#43 merged source 675382a descends from base 50a26f3')
          ),
        ],
      }),
    }),
    expected: 'child-delivered',
    role: 'child',
    mentions: ['#43', 'sibling'],
  },
  {
    name: 'a child at a6013cb under task d9fdcf2d, through its base seed and PR #41',
    facts: managed({
      residue: { tracked: 1, untracked: 0, ignored: 6448 },
      integration: integration({
        headInTip: yes('a6013cb is an ancestor of the current main tip 497c73e'),
        pullRequests: [
          pullRequest(41, ['base', 'override'], {
            containsHead: yes('taekwondodev/dev#41 source history contains a6013cb'),
            descendsFromBase: yes('taekwondodev/dev#41 merged source descends from base a6013cb'),
          }),
        ],
      }),
    }),
    expected: 'child-delivered',
    role: 'child',
    mentions: ['#41', 'base seed'],
  },
  {
    name: 'a dirty child with own commits whose descending PR is proven while keeping its commits is not',
    facts: managed({
      residue: { tracked: 1, untracked: 0, ignored: 0 },
      ownCommits: true,
      integration: integration({
        headInTip: unknown(
          'the target tip is not local and the provider comparison is unavailable'
        ),
        pullRequests: [
          pullRequest(41, ['base'], {
            containsHead: unknown('taekwondodev/dev#41 source history is shallow'),
            descendsFromBase: yes('taekwondodev/dev#41 merged source descends from base a6013cb'),
          }),
        ],
      }),
    }),
    expected: 'retained:integration-unknown',
    role: 'child',
    mentions: ['shallow', 'not local'],
  },
  {
    name: 'the clean detached worktrees at their bases, 983f8a4 and the contention worktree 64e0b23b of task d9fdcf2d at a6013cb',
    facts: managed({ allocation: 'checkout-contention' }),
    expected: 'no-residue',
    role: 'detached',
  },
  {
    name: 'the clean main checkout at quit',
    facts: checkout({ residue: { tracked: 0, untracked: 0, ignored: 4 } }),
    expected: 'clean-checkout',
    role: 'pre-existing',
  },
  {
    name: 'the clean main checkout at allocation',
    facts: checkout({ moment: 'allocation' }),
    expected: 'retained:skipped',
    role: 'pre-existing',
  },
  {
    name: 'a branch worktree at its base with dirty edits',
    facts: managed({
      allocation: 'checkout-contention',
      branch: 'refs/heads/paused',
      residue: { tracked: 3, untracked: 1, ignored: 0 },
      integration: integration({
        headInTip: yes('the base is an ancestor of the current main tip'),
      }),
    }),
    expected: 'retained:no-commits',
    role: 'branch',
  },
  {
    name: 'a child at its base whose task has no descending merged pull request',
    facts: managed({
      residue: { tracked: 2, untracked: 0, ignored: 0 },
      integration: integration({
        headInTip: yes('the base is an ancestor of the current main tip'),
        rejected: ['GitHub lists no merged pull request for these commits'],
      }),
    }),
    expected: 'retained:not-integrated',
    role: 'child',
  },
  {
    name: 'a child whose provider is unavailable',
    facts: managed({
      residue: { tracked: 2, untracked: 0, ignored: 0 },
      integration: integration({
        headInTip: unknown('GitHub ref taekwondodev/dev refs/heads/main: rate limited'),
        unknown: ['GitHub ref taekwondodev/dev refs/heads/main: rate limited'],
      }),
    }),
    expected: 'retained:integration-unknown',
    role: 'child',
    mentions: ['rate limited'],
  },
  {
    name: 'a dirty pre-existing checkout at quit',
    facts: checkout({ residue: { tracked: 1, untracked: 0, ignored: 0 } }),
    expected: 'retained:checkout-modified',
    role: 'pre-existing',
  },
  {
    name: 'a pre-existing checkout with an untracked non-ignored file',
    facts: checkout({ residue: { tracked: 0, untracked: 1, ignored: 0 } }),
    expected: 'retained:checkout-modified',
    role: 'pre-existing',
  },
  {
    name: 'a branch worktree whose own commits are in the target tip',
    facts: managed({
      allocation: 'checkout-contention',
      branch: 'refs/heads/feature',
      residue: { tracked: 0, untracked: 0, ignored: 12 },
      ownCommits: true,
      integration: integration({
        headInTip: yes('HEAD is an ancestor of the current main tip'),
      }),
    }),
    expected: 'branch-in-target',
    role: 'branch',
  },
  {
    name: 'a branch worktree whose pull request source cannot be read locally',
    facts: managed({
      branch: 'refs/heads/feature',
      residue: { tracked: 1, untracked: 0, ignored: 0 },
      ownCommits: true,
      integration: integration({
        pullRequests: [
          pullRequest(9, ['head'], {
            containsHead: unknown('source history is not locally readable'),
            descendsFromBase: unknown('source history is not locally readable'),
          }),
        ],
      }),
    }),
    expected: 'retained:integration-unknown',
    role: 'branch',
  },
  {
    name: 'a clean branch worktree with unmerged commits, retained until they are merged',
    facts: managed({
      branch: 'refs/heads/feature',
      ownCommits: true,
      integration: integration({}),
    }),
    expected: 'retained:not-integrated',
    role: 'branch',
  },
  {
    name: 'a clean detached worktree with commits outside its base and target',
    facts: managed({
      allocation: 'checkout-contention',
      ownCommits: true,
      integration: integration({}),
    }),
    expected: 'retained:not-integrated',
    role: 'detached',
  },
  {
    name: 'a clean detached worktree whose commits are in the target',
    facts: managed({
      allocation: 'checkout-contention',
      ownCommits: true,
      integration: integration({
        headInTip: yes('HEAD is an ancestor of the current main tip'),
      }),
    }),
    expected: 'no-residue',
    role: 'detached',
  },
  {
    name: 'a dirty detached worktree that is not a delegated child',
    facts: managed({
      allocation: 'checkout-contention',
      residue: { tracked: 1, untracked: 0, ignored: 0 },
      integration: integration({
        headInTip: yes('HEAD is an ancestor of the current main tip'),
      }),
    }),
    expected: 'retained:not-integrated',
    role: 'detached',
  },
  {
    name: 'a detached worktree with a non-ignored untracked file',
    facts: managed({
      allocation: 'checkout-contention',
      residue: { tracked: 0, untracked: 1, ignored: 0 },
      integration: integration({
        headInTip: yes('HEAD is an ancestor of the current main tip'),
      }),
    }),
    expected: 'retained:not-integrated',
    role: 'detached',
  },
  {
    name: 'a managed worktree whose directory is gone with no removal by dev behind it',
    facts: managed({
      identity: 'absent',
      residue: undefined,
      ownCommits: undefined,
    }),
    expected: 'retained:directory-missing',
    role: 'child',
  },
  {
    name: 'a managed worktree whose directory an interrupted removal by dev already deleted',
    facts: managed({
      identity: 'absent',
      removalInterrupted: true,
      residue: undefined,
      ownCommits: undefined,
    }),
    expected: 'no-residue',
    role: 'child',
  },
]

const precedence: readonly Row[] = [
  {
    name: 'an unverifiable identity before everything else',
    facts: managed({
      identity: 'unverifiable',
      uses: { unknown: 1, abandoned: 0, live: 0, conversations: 0 },
    }),
    expected: 'retained:identity-unverifiable',
    role: 'child',
  },
  {
    name: 'an unresolved transition',
    facts: managed({ transitionUnresolved: true, releaseReview: true }),
    expected: 'retained:transition-unresolved',
    role: 'child',
  },
  {
    name: 'an engine-recorded unknown or review-required release',
    facts: managed({ releaseReview: true, excluded: true }),
    expected: 'retained:release-review',
    role: 'child',
  },
  {
    name: "the allocating conversation's own workspace",
    facts: managed({
      excluded: true,
      uses: { unknown: 0, abandoned: 0, live: 1, conversations: 0 },
    }),
    expected: 'retained:excluded',
    role: 'child',
  },
  {
    name: 'an unknown use before abandoned and live ones',
    facts: managed({
      uses: { unknown: 1, abandoned: 1, live: 1, conversations: 0 },
    }),
    expected: 'retained:use-unknown',
    role: 'child',
  },
  {
    name: 'an abandoned use before a live one or an open conversation',
    facts: managed({
      uses: { unknown: 0, abandoned: 1, live: 1, conversations: 1 },
    }),
    expected: 'retained:use-abandoned',
    role: 'child',
  },
  {
    name: 'a live use',
    facts: checkout({
      uses: { unknown: 0, abandoned: 0, live: 1, conversations: 0 },
    }),
    expected: 'retained:use-live',
    role: 'pre-existing',
  },
  {
    name: 'an open conversation bound to an otherwise finished worktree',
    facts: managed({
      uses: { unknown: 0, abandoned: 0, live: 0, conversations: 1 },
    }),
    expected: 'retained:use-live',
    role: 'child',
  },
  {
    name: 'an attempt not observed quiescent',
    facts: managed({ attemptsQuiescent: false }),
    expected: 'retained:use-live',
    role: 'child',
  },
  {
    name: 'unreadable worktree contents',
    facts: managed({ residue: undefined }),
    expected: 'retained:residue-unreadable',
    role: 'child',
  },
]

await claim(
  'completion decides the live-state workspaces as the specification tabulates them, with the role and the proving pull request and seed in the verdict',
  () => {
    for (const row of rows) {
      const verdict = decideCompletion(row.facts)
      assert.equal(verdictName(verdict), row.expected, `${row.name}: ${verdict.reason}`)
      assert.equal(verdict.role, row.role, row.name)
      for (const mention of row.mentions ?? [])
        assert.ok(verdict.reason.includes(mention), `${row.name}: ${verdict.reason}`)
    }
  }
)
await claim(
  'Git-ignored files do not change completion verdicts or weaken retention safeguards',
  () => {
    for (const row of [...rows, ...precedence]) {
      if (row.facts.residue === undefined) continue
      const verdict = decideCompletion({
        ...row.facts,
        residue: { ...row.facts.residue, ignored: 6447 },
      })
      assert.equal(verdictName(verdict), row.expected, `${row.name}: ${verdict.reason}`)
      assert.equal(verdict.role, row.role, row.name)
    }
  }
)
await claim(
  'the first matching rule wins: identity, transition, engine-recorded release, exclusion and uses retain before any finished rule',
  () => {
    for (const row of precedence) {
      const verdict = decideCompletion(row.facts)
      assert.equal(verdictName(verdict), row.expected, `${row.name}: ${verdict.reason}`)
      assert.equal(verdict.role, row.role, row.name)
    }
  }
)

const git = (args: readonly string[], cwd: string): string =>
  execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'dev-workspace-completion-check-')))
try {
  const repository = (name: string): string => {
    const path = join(sandbox, name)
    mkdirSync(path)
    git(['init', '--quiet', '-b', 'main'], path)
    git(['config', 'user.name', 'Completion Check'], path)
    git(['config', 'user.email', 'completion-check@example.invalid'], path)
    git(['config', 'push.default', 'simple'], path)
    git(['config', 'branch.autoSetupMerge', 'true'], path)
    writeFileSync(join(path, 'file.txt'), 'file\n')
    git(['add', '.'], path)
    git(['commit', '--quiet', '-m', 'fixture'], path)
    return path
  }
  const readBranches: string[] = []
  const reader = (branch: string | 'missing' | { readonly unavailable: string }): GitHubReader => ({
    defaultBranch: repositoryName => {
      readBranches.push(repositoryName)
      return branch
    },
    refTip: () => ({ unavailable: 'not consulted' }),
    pullRequest: () => ({ unavailable: 'not consulted' }),
    pullRequestCommits: () => ({ unavailable: 'not consulted' }),
    mergedPullRequestsForCommit: () => ({ unavailable: 'not consulted' }),
    compare: () => ({ unavailable: 'not consulted' }),
  })
  const override: TaskTarget = { kind: 'local', ref: 'refs/heads/release' }

  await claim(
    "target derivation: an override wins unless it names the worktree's own branch; a GitHub origin gives its slug and default branch; a non-GitHub origin gives its HEAD branch; no origin gives none",
    () => {
      const github = repository('github')
      git(['remote', 'add', 'origin', 'git@github.com:owner/project.git'], github)
      assert.deepEqual(deriveTarget(reader('trunk'), github, override, 'refs/heads/feature'), {
        source: 'override',
        target: override,
      })
      assert.deepEqual(readBranches, [], 'an override asks the provider nothing')
      assert.deepEqual(deriveTarget(reader('trunk'), github, undefined, 'refs/heads/feature'), {
        source: 'origin-github',
        target: {
          kind: 'github',
          repository: 'owner/project',
          ref: 'refs/heads/trunk',
        },
      })
      const unavailable = deriveTarget(
        reader({ unavailable: 'offline' }),
        github,
        undefined,
        'refs/heads/feature'
      )
      assert.equal(unavailable.source, 'none')
      assert.ok(
        unavailable.source === 'none' && unavailable.reason.includes('offline'),
        JSON.stringify(unavailable)
      )

      const upstream = repository('upstream')
      git(['checkout', '--quiet', '-b', 'develop'], upstream)
      const plain = repository('plain')
      git(['remote', 'add', 'origin', upstream], plain)
      assert.deepEqual(deriveTarget(reader('unused'), plain, undefined, 'refs/heads/feature'), {
        source: 'origin-remote',
        target: { kind: 'remote', remote: 'origin', ref: 'refs/heads/develop' },
      })

      git(['checkout', '--quiet', '-b', 'feature'], plain)
      const ownBranch = symbolicBranch(plain)
      assert.deepEqual(
        deriveTarget(
          reader('unused'),
          plain,
          { kind: 'local', ref: 'refs/heads/feature' },
          ownBranch
        ),
        {
          source: 'origin-remote',
          target: { kind: 'remote', remote: 'origin', ref: 'refs/heads/develop' },
          ignored:
            "The recorded target local refs/heads/feature names this worktree's own branch, which proves nothing, so it is ignored.",
        },
        "an override naming the worktree's own branch is ignored in favor of the origin"
      )
      assert.deepEqual(
        deriveTarget(
          reader('unused'),
          plain,
          { kind: 'remote', remote: 'origin', ref: 'refs/heads/feature' },
          ownBranch
        ).ignored?.startsWith('The recorded target origin refs/heads/feature'),
        true,
        "a remote override naming the worktree's own branch is ignored too"
      )

      const ignoredFor = (path: string, recorded: TaskTarget, branch: string | undefined) =>
        deriveTarget(reader('main'), path, recorded, branch).ignored !== undefined
      assert.ok(
        ignoredFor(plain, { kind: 'local', ref: 'refs/remotes/origin/feature' }, ownBranch),
        "the remote-tracking ref of the worktree's own branch is its own branch"
      )
      git(['config', 'branch.feature.remote', 'origin'], plain)
      git(['config', 'branch.feature.merge', 'refs/heads/published'], plain)
      assert.ok(
        !ignoredFor(
          plain,
          { kind: 'remote', remote: 'origin', ref: 'refs/heads/published' },
          ownBranch
        ),
        'a configured upstream under another name is a real integration target'
      )
      assert.ok(
        !ignoredFor(plain, { kind: 'local', ref: 'refs/remotes/origin/published' }, ownBranch),
        'the remote-tracking ref of a differently named upstream is a real target'
      )
      git(['config', 'remote.origin.push', 'refs/heads/feature:refs/heads/published'], plain)
      git(['update-ref', 'refs/remotes/origin/published', 'HEAD'], plain)
      for (const target of [
        { kind: 'local', ref: 'refs/remotes/origin/published' },
        { kind: 'remote', remote: 'origin', ref: 'refs/heads/published' },
      ] satisfies readonly TaskTarget[])
        assert.ok(
          ignoredFor(plain, target, ownBranch),
          'an explicitly mapped push destination is its own branch'
        )
      git(['update-ref', 'refs/remotes/origin/develop', 'HEAD'], github)
      git(['switch', '--quiet', '-c', 'feature', '--track', 'origin/develop'], github)
      const githubBranch = symbolicBranch(github)
      for (const target of [
        { kind: 'local', ref: 'refs/remotes/origin/develop' },
        { kind: 'remote', remote: 'origin', ref: 'refs/heads/develop' },
        { kind: 'github', repository: 'owner/project', ref: 'refs/heads/develop' },
        { kind: 'github', repository: 'owner/project', ref: 'refs/heads/develop', pullRequest: 44 },
      ] satisfies readonly TaskTarget[])
        assert.deepEqual(
          deriveTarget(reader('main'), github, target, githubBranch),
          { source: 'override', target },
          'a branch started at origin/develop must keep develop as its target, including a PR'
        )
      assert.ok(
        ignoredFor(
          github,
          { kind: 'github', repository: 'owner/project', ref: 'refs/heads/feature' },
          githubBranch
        ),
        "the same branch in the origin's GitHub repository is its own branch"
      )
      assert.ok(
        !ignoredFor(
          github,
          { kind: 'github', repository: 'other/fork', ref: 'refs/heads/feature' },
          githubBranch
        ),
        'a branch of the same name in another GitHub repository is a real target'
      )
      git(['remote', 'add', 'upstream', 'git@github.com:canon/project.git'], github)
      git(['config', 'branch.feature.remote', 'upstream'], github)
      git(['config', 'branch.feature.merge', 'refs/heads/main'], github)
      const canonical: TaskTarget = {
        kind: 'github',
        repository: 'canon/project',
        ref: 'refs/heads/main',
      }
      assert.deepEqual(deriveTarget(reader('main'), github, canonical, githubBranch), {
        source: 'override',
        target: canonical,
      })
      git(['remote', 'add', 'fork', 'git@github.com:other/fork.git'], github)
      assert.ok(
        ignoredFor(
          github,
          { kind: 'github', repository: 'other/fork', ref: 'refs/heads/feature' },
          githubBranch
        ),
        'the same branch on a configured non-origin, non-upstream remote is its own branch'
      )
      git(['config', 'branch.feature.pushRemote', 'fork'], github)
      git(['config', 'remote.fork.push', 'refs/heads/feature:refs/heads/published'], github)
      git(['update-ref', 'refs/remotes/fork/published', 'HEAD'], github)
      assert.ok(
        ignoredFor(
          github,
          { kind: 'github', repository: 'other/fork', ref: 'refs/heads/published' },
          githubBranch
        ),
        'a differently named push branch on GitHub is its own branch'
      )

      const lonely = repository('lonely')
      const none = deriveTarget(reader('unused'), lonely, undefined, undefined)
      assert.equal(none.source, 'none')
      assert.ok(none.source === 'none' && none.reason.includes('no origin remote'))
    }
  )
  await claim(
    'a fork push URL never proves an unmerged branch integrated, including multiple and rewritten push destinations',
    () => {
      const path = repository('push-url')
      const base = git(['rev-parse', 'HEAD'], path)
      git(['switch', '--quiet', '-c', 'feature'], path)
      git(['commit', '--quiet', '--allow-empty', '-m', 'unmerged feature'], path)
      const head = git(['rev-parse', 'HEAD'], path)
      git(['remote', 'add', 'origin', 'git@github.com:canon/project.git'], path)
      git(['config', 'remote.origin.pushurl', 'git@github.com:fork/project.git'], path)
      git(['config', '--add', 'remote.origin.pushurl', 'publish:mirror/project.git'], path)
      git(['config', 'url.git@github.com:.insteadOf', 'publish:'], path)
      git(['config', 'branch.feature.remote', 'origin'], path)
      git(['config', 'branch.feature.merge', 'refs/heads/feature'], path)
      git(['update-ref', 'refs/remotes/origin/feature', 'HEAD'], path)
      const github: GitHubReader = {
        ...reader('main'),
        refTip: (slug, ref) =>
          slug === 'canon/project' && ref === 'refs/heads/main' ? base : head,
        mergedPullRequestsForCommit: () => [],
      }
      for (const slug of ['fork/project', 'mirror/project']) {
        const target: TaskTarget = { kind: 'github', repository: slug, ref: 'refs/heads/feature' }
        const derived = deriveTarget(github, path, target, 'refs/heads/feature')
        assert.equal(derived.source, 'origin-github', slug)
        assert.ok(derived.ignored?.includes('own branch'), slug)
        assert.equal(recordedTarget(path, target, 'refs/heads/feature'), undefined, slug)
        const facts = integrationFacts(github, path, {
          target: derived.target,
          head,
          base,
          allocatedAt: 1,
          siblings: { heads: [], unknown: [] },
        })
        assert.equal(
          verdictName(
            decideCompletion(
              managed({
                branch: 'refs/heads/feature',
                ownCommits: true,
                residue: { tracked: 1, untracked: 0, ignored: 0 },
                integration: facts,
              })
            )
          ),
          'retained:not-integrated',
          slug
        )
      }
      git(['config', '--unset-all', 'remote.origin.pushurl'], path)
      git(['config', 'url.git@github.com:rewritten/.pushInsteadOf', 'git@github.com:canon/'], path)
      const rewritten: TaskTarget = {
        kind: 'github',
        repository: 'rewritten/project',
        ref: 'refs/heads/feature',
      }
      assert.ok(deriveTarget(github, path, rewritten, 'refs/heads/feature').ignored)
    }
  )
  await claim('GitHub origin URLs in their usual forms name the repository slug', () => {
    for (const url of [
      'git@github.com:owner/project.git',
      'git@github.com:owner/project',
      'https://github.com/owner/project.git',
      'https://github.com/owner/project',
      'ssh://git@github.com/owner/project.git',
    ])
      assert.equal(githubRepositoryOf(url), 'owner/project', url)
    for (const url of [
      'https://gitlab.com/owner/project.git',
      '/srv/git/project.git',
      'https://github.com/owner',
    ])
      assert.equal(githubRepositoryOf(url), undefined, url)
  })
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

process.stdout.write(
  `${JSON.stringify(
    {
      result: 'passed',
      checks: passed,
      limits: [
        'Completion rows are fixture facts shaped after the live authority on 2026-09-29; the live worktree 64e0b23b is a clean checkout-contention worktree at its base, so the base-seeded child row is a delegated variant of it.',
      ],
    },
    null,
    2
  )}\n`
)
