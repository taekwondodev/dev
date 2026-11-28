# Develop dev

This guide is for changing dev itself. Daily operation starts in the [README](../README.md) and [launcher](launcher.md). Dev source and npm dependencies belong in the installation checkout, not in projects where dev runs. [Documentation](documentation.md) assigns each meaning its owner; [private state maintenance](private-state.md) covers relocating and discarding dev's data.

## Setup

```bash
brew install shellcheck
cd ~/Developer/dev
npm ci
npm run lint
npm start
```

`npm start` and `npm run dev` work on this checkout; use `--cwd` to work elsewhere. [Linking](launcher.md#maintenance) points the `dev` command at the checkout.

TypeScript sources are strict and erasable, run directly through Node type stripping. No TypeScript build is needed. `package.json` owns the Node minimum and the pinned Effect version. Follow the [Effect reading rule](../AGENTS.md#learning-more-about-effect) before writing Effect code.

### Native addon

Dev's macOS native addon requires the Xcode Command Line Tools (`xcode-select --install`) and a Node installation that ships `include/node/node_api.h` beside its `bin/` directory. Cached binaries live in the installation's `.dev/native/`, independently of data-home overrides. A missing binary builds on first use. If compilation fails, fix the reported toolchain error and restart dev: the running process retains its first build failure.

### Pi installation and declarations

Install Pi with the [pi.dev installer](https://pi.dev). Dev follows `pi` on `PATH` to its managed `install/` directory and resolves the release named in `current-version`; an npm Pi installation is refused.

Dev and its delegated agents load Pi directly from the managed release. The ignored `node_modules/@earendil-works` link is only for TypeScript declarations from that same release. Checks and setup create it; run `npm run types:pi` to refresh editor declarations without running checks. Restore missing declarations through the link rather than adding ambient types or a private Pi copy. `DEV_PI_RELEASE` selects another managed release for both runtime and checking.

Before `npm install` or `npm uninstall`, remove the link if present. Otherwise npm can prune the packages it points to in the Pi installation. `npm run pi:update` removes its worktree's `node_modules` before installing, so it does not need this step.

### Pi integration limits

Forking before the first user message can fail after a workspace handoff. [Issue #98](https://github.com/taekwondodev/dev/issues/98) tracks that limit.

## Find the owner

[Architecture](ARCHITECTURE.md#components) maps source areas to their behavior guides. [AGENTS.md](../AGENTS.md#read-for-the-change) supplies mandatory reading triggers. Use the [documentation ownership table](documentation.md#documentation-ownership) when the change affects more than code.

## Verification

Choose checks for the affected boundary. Suite composition is in [the check runner](../tests/run-checks.ts); these are their purposes and non-obvious limits.

The runner links the Pi declarations once, then runs every selected check file, lint pass and pseudo-terminal probe as one job queue, as many at once as the machine has cores, longest first by the previous run's durations. On macOS the runner sets every job's `TMPDIR` to a RAM disk it mounts for the run, and leaves `TMPDIR` unchanged when mounting fails. The runner ejects the disk afterwards, also on interruption, and a later run ejects one left by a killed runner: authority and gate databases publish with `F_FULLFSYNC`, which on the real disk dominated the slowest checks and made concurrent ones contend. Checks therefore prove behavior, not on-disk durability. One invocation beats sequential ones: `npm run check` runs every suite below except `workspace:github`, `node tests/run-checks.ts <suite>...` runs several named suites together and `--all` runs every suite. `--report=<path>` also writes each job's suite, rerun command, result, time and output as JSON. Output is printed per job after all finish, then one status line per job with failed jobs last, then the pass and fail totals as the final line, so the end of the output alone shows the result and which jobs failed.

Tests follow integration boundaries and use disposable storage. Profile fixtures come from `tests/profile-fixture.ts` through `DEV_PROFILES`, so checks also run in worktrees without personal profiles. Keep scripted models, injected resolvers and fault controls in test composition roots; production must not load test entries or test-selection variables.

| Check                      | Evidence                                                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run lint`             | ShellCheck on `scripts/*.sh` as POSIX `sh`, type checking, strict Effect diagnostics and the type-aware and general Oxlint passes with warnings as errors                            |
| `npm run format:check`     | Formatting without writes; `format` and `lint:fix` are explicit mutations                                                                                                            |
| `npm run smoke`            | Launcher diagnostics, upgrade cleanup and the one-line installer on disposable storage with stubbed downloads, and dev-internal terms in tool declarations, without a model response |
| `npm run cleanup:check`    | Conversation quotas, preference publication exclusion, fenced deletion, conversation lock removal and detached cleanup survival on disposable storage                                |
| `npm run profile:check`    | Usage reports, interpretation and private/export boundaries on fixture data homes                                                                                                    |
| `npm run workspace:check`  | Completion decisions, authority, release, sweeps, process adapters and headless Pi host/session flows                                                                                |
| `npm run workspace:tui`    | Real Pi TUI under a pseudo-terminal, including compaction, lifecycle, quit and release probes                                                                                        |
| `npm run workspace:github` | Real read-only GitHub evidence reader against a public merged PR                                                                                                                     |
| `npm run work:check`       | Native-session compaction, native addon build and process observation, dispatch, attempt persistence, real children on an offline scripted model and lead-side outcome delivery      |
| `npm run web:check`        | URL policy, pinned retrieval, extraction, continuation, Chrome rendering, the shared browser owner with concurrent independent clients, and direct/codemode reads through the host   |
| `npm run dev:probe`        | SDK runtime creation without a TUI                                                                                                                                                   |

`workspace:github` is the only check that contacts an external service. It is outside the recurring workspace suite; run it when the GitHub reader or its adapter facts change, because fakes cannot establish that integration. An upgrade runs it with every other suite.

`web:check` serves loopback fixtures and launches the installed Chrome on a disposable profile. It skips browser claims when Chrome is absent; a passing run with those skips is not browser evidence.

Use the actual TUI for interactive behavior. The Python pseudo-terminal driver exists because Node has no built-in pty; it drives TypeScript fixtures. To run one probe, use `python3 tests/workspace/run-workspace-pty-probes.py <name>`; `--list` prints the supported names. Match proof to the change rather than adding a test or benchmark campaign by default.

The source-comment policy in `scripts/code-policy.ts` allows shebangs and comment-like literal text, but rejects source comments without fixing files. The same file rejects fixed delays in checks, with no allowlist, and holds the `dev/no-internal-terms` rule described below. Express intent through names and structure; put non-obvious architectural rationale in its owning ADR. Effect execution and unsafe channel-narrowing checks are terminal errors, not merely editor diagnostics. `lint:effect` keeps `--strict` to reject warnings too; it does not enable disabled rules or reject suggestions.

The `dev/no-internal-terms` rule rejects the internal terms in the sentences and message labels of `src/`; the rule owns what it checks. [`scripts/model-text-terms.ts`](../scripts/model-text-terms.ts) owns the vocabulary: each group of internal terms with its model-visible wording, or the instruction to leave it out. The rule's pattern and its error derive from that list, so a new term gets its wording there. The rule follows a `const` only within its file, so a word that reaches a sentence through an import, a function result or a saved value follows the same vocabulary by review. [The model text check](../tests/model-text-check.ts) covers structured keys, the values of enumerations that sentences interpolate and a sample of rendered results. Add an enumeration to that check when a sentence starts to interpolate it.

The separate type-aware configuration, `.oxlintrc-type-aware.json`, lists its rules explicitly, so the general preset's dormant type-aware style rules stay inactive. Explicit `void` remains an opt-out for intentional Promise detachment, not proof that rejection is handled.

`.oxlintrc.json` extends `oxc-standard`, and Oxlint merges a config's `plugins` with those of the configs it extends, so `plugins` names only what dev adds to the preset. Listing a preset plugin changes nothing, and leaving one out does not disable it; the preset's React rules stay enabled but find no JSX to check.

In `.oxlintrc.json`, `prefer-const` skips a variable read before its single assignment, because a closure that reads it before the value exists cannot use `const`. `promise/always-return` skips the last callback of a chain, because nothing consumes its value.

When addressing lint diagnostics, preserve the [Effect boundary decisions](adr/0009-effect-boundary.md). A lint-driven runtime rewrite needs a demonstrated correctness need or measured benefit, not stylistic preference alone.

## Upgrades

For the command procedure and its publication effects, use [Upgrade](upgrade.md). This section is for investigating or changing the integration.

`scripts/upgrade.ts` owns targets, the worktree, the report and publication; `scripts/pi-upgrade.ts` owns the Pi candidate and its comparison. `config.pi` records the Pi the last upgrade verified; nothing outside `pi:update` reads it. The upgrade runs the worktree's own [check runner](../tests/run-checks.ts) once with `--all --report`, so a suite added there is verified without touching the upgrade; [the report reader](../scripts/upgrade-checks.ts) decodes its outcomes. For output capture, see [the command adapter](../scripts/checkout.ts). The upgrade worktree is switched in place, never removed and added again: its path and Git administration keep the identity a dev session may have recorded, which `npm run update` checks before removing it. [The upgrade worktree claim](../src/workspace-upgrade.ts) holds that path's removal gates: `pi:update` takes it for its whole run instead of installation admission, and `npm run update` takes it beside admission, from before its merge through cleanup. [ADR 0005](adr/0005-scoped-runtime-coordination.md#gates-and-identity) records how both take the structure gate inside that claim.

Use the installed Pi contracts below and the integration tests when an API changes. Session replacement and tool termination are exercised in `tests/workspace/workspace-host-session-check.ts`; native skill invocation and coordinator delivery in `tests/work/`; compaction in `tests/compaction-check.ts`, child checks and TUI probes. Profiler decoding depends on recorded message shapes and error/continuation text, so type checking alone cannot verify it: run `profile:check` and retain the upgrade guide's live-session check.

Keep API dependencies in their adapters and regression tests, not a second API inventory in an operator guide. Changed extension effects also require the [security review](../SECURITY.md#adding-or-updating-an-extension).

### Pi contract pages

`scripts/pi-upgrade.ts` reads the following links directly from this file and compares their shipped copies. Keep this list here. Online `main` pages are discovery references; the installed package is authoritative for the release in use.

- [README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md)
- [Skills](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md)
- [Settings](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md)
- [Extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
- [RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)
- [Session format](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md)
- [Compaction](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md)
- [Codemode](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/codemode.md)
- [Security](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md)
