# Develop dev

This guide is for changing dev itself. Daily operation starts in the [README](../README.md) and [launcher](launcher.md). Dev source and npm dependencies belong in the installation checkout, not in projects where dev runs.

## Setup

```bash
cd ~/Developer/dev
npm ci
npm run lint
npm start
```

`npm start` and `npm run dev` work on this checkout; use `--cwd` to work elsewhere. `npm link --ignore-scripts` links the `dev` command to the checkout, so edits take effect on the next launch.

Sources are strict, erasable TypeScript, run directly through Node type stripping. There is no build step. `package.json` owns the Node minimum and pinned Effect and Pi versions. Follow the [Effect reading rule](../AGENTS.md#learning-more-about-effect) before writing Effect code.

### Pi installation and declarations

Install Pi with the [pi.dev installer](https://pi.dev). Dev follows `pi` on `PATH` to its managed `install/` directory and resolves the release named in `current-version`; an npm Pi installation is refused.

Checks and setup regenerate an ignored `node_modules/@earendil-works` link to that release's packages. Runtime and types therefore use the same Pi. Run `npm run types:pi` if an editor retains stale declarations after a Pi change. Missing declarations fail checks; do not compensate with ambient types or a private Pi copy. `DEV_PI_RELEASE` selects another managed release directory for both runtime and checking, including a verification candidate.

## Find the owner

[ARCHITECTURE](ARCHITECTURE.md#components) maps source areas to their behavior docs. [CONTEXT](../CONTEXT.md) owns vocabulary; [AGENTS.md](../AGENTS.md#conditional-references) owns mandatory reading triggers. Portable guidance belongs in profiles or the external shared library, not in this repository's entry point.

Tests follow the integration boundary: launcher smoke, usage-profile fixtures, workspace authority/host/process checks, and work-controller/child checks. The child test entry in `tests/work/` and the launcher's `makeRuntimeFactory` provide offline scripted-model composition roots; production loads no test entry or test-selection environment variable.

## Verification

Choose checks for the affected boundary. The commands and their full composition are in `package.json`; these are their purposes and non-obvious limits.

| Check                      | Evidence                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| `npm run lint`             | Type checking, strict Effect diagnostics and Oxlint with warnings as errors                             |
| `npm run format:check`     | Formatting without writes; `format` and `lint:fix` are explicit mutations                               |
| `npm run smoke`            | Launcher diagnostics on temporary private storage, without a model response                             |
| `npm run profile:check`    | Usage reports, interpretation and private/export boundaries on fixture data homes                       |
| `npm run workspace:check`  | Completion decisions, authority, release, sweeps, process adapters and headless Pi host/session flows   |
| `npm run workspace:tui`    | Real Pi TUI under a pseudo-terminal, including compaction, lifecycle, quit and release probes           |
| `npm run workspace:github` | Real read-only GitHub evidence reader against a public merged PR                                        |
| `npm run work:check`       | Native-session compaction, dispatch, attempt persistence and real children on an offline scripted model |
| `npm run dev:probe`        | SDK runtime creation without a TUI                                                                      |

Only `workspace:github` touches the network; the checks use disposable storage rather than real authority state or credentials. That reader check is deliberately outside the recurring workspace suite. Run it when the GitHub reader or its adapter facts change; fakes cannot establish that integration.

Use the actual TUI for interactive behavior. The Python pseudo-terminal driver exists because Node has no built-in pty; it drives TypeScript fixtures. To run one probe, use `python3 tests/workspace/run-workspace-pty-probes.py <name>`; the driver lists the supported names. Match proof to the change rather than adding a test or benchmark campaign by default.

The source-comment policy in `scripts/code-policy.ts` allows shebangs and comment-like literal text, but rejects source comments without fixing files. Express intent through names and structure; put non-obvious architectural rationale in its owning ADR. `floatingEffect` is a terminal-check error, not merely an editor diagnostic.

## Pi upgrade

For the command procedure and its publication effects, use [Pi upgrade](pi-upgrade.md). This section is for investigating or changing the integration.

A failed verification retains its candidate. Rerun an affected suite with:

```bash
DEV_PI_RELEASE="$PWD/.dev/pi-candidate/release" npm run <suite>
npm run types:pi
```

Smoke requires the candidate pin, which a failed verification restores to the previous value; it is not a direct rerun in that state. The final command restores declaration links to the active Pi.

Use the installed Pi contracts below and the integration tests when an API changes. Session replacement and tool termination are exercised in `tests/workspace/workspace-host-session-check.ts`; native skill invocation and coordinator delivery in `tests/work/`; compaction in `tests/compaction-check.ts`, child checks and TUI probes. Profiler decoding depends on recorded message shapes and error/continuation text, so type checking alone cannot verify it: run `profile:check` and retain the upgrade guide's live-session check.

Keep API dependencies in their adapters and regression tests, not a second API inventory in an operator guide. Changed extension effects also require the [security review](../SECURITY.md#adding-or-updating-an-extension).

### Pi contract pages

`scripts/pi-upgrade.ts` reads the following links directly from this file and compares their shipped copies. Keep this list here. Online `main` pages are discovery references; the installed package is authoritative for the pinned release.

- [README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md)
- [Skills](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md)
- [Settings](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md)
- [Extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
- [RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)
- [Session format](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md)
- [Compaction](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md)
- [Security](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md)

## Documentation ownership

| Artifact                      | Owns                                                                                           |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| GitHub issue                  | Problem, scope, requirements, acceptance criteria and unresolved decisions for a piece of work |
| Pull request                  | The proposed implementation, review discussion and verification evidence for that change       |
| `docs/adr/`                   | Accepted architectural decisions, alternatives and enduring rationale                          |
| `CONTEXT.md`                  | Domain terms and their meanings                                                                |
| `AGENTS.md`                   | Repository-wide agent instructions and conditional reading triggers                            |
| `docs/ARCHITECTURE.md`        | Current component responsibilities and an index of decision records                            |
| Feature guide                 | How to use one capability, its observable behavior, limits and recovery                        |
| `docs/DEVELOPMENT.md`         | Contributor setup, local checks and maintenance of dev's code                                  |
| Code, tests and configuration | Exact APIs, algorithms, schemas and executable defaults                                        |

When adding a tool, link its guide from the component map and add a conditional reading trigger in `AGENTS.md`. Choose headings for the user's task; a feature guide is not an implementation walkthrough or test plan. Native Pi commands need documentation here only where dev changes them.

Update an existing owner instead of copying its meaning. Use links for cross-cutting constraints. For example, a usage-report guide explains an unknown metric; the parser and tests define how it is recognized, the issue states the requested behavior, and the PR records the evidence for that change.

Use the shared `domain-modeling` necessity gate and format for ADRs. New ADRs take the next number and an architecture pointer, with a link to the accepted decision. Verification performed for one change stays with that issue or PR, not in a reusable guide.

## Private-state relocation

Stop dev runtimes and inventory dev-owned metadata before moving private state. Preserve permissions, update operational pointers into the moved data home and leave historical conversation text unchanged. Credentials, profiles and the Pi installation remain outside the operation under [AGENTS.md](../AGENTS.md#boundaries). Keep `.dev/` untracked and protect explicit data-home overrides independently. Revision changes must also satisfy [maintenance admission](launcher.md#maintenance).

## Discard obsolete state

Dev has one current schema. Follow [AGENTS.md](../AGENTS.md#boundaries) when changing a dev-owned format: replace it in place and delete old-shape data in the same change. Startup validates current layout and identity, refuses damaged or non-canonical storage, and never migrates or resets it.

Stop affected runtimes and maintenance operations before deleting state, then restart on the current code. In particular, unlinking a lock database held by a running process splits ownership across inodes. Leave coordination databases on disk during normal operation.

| Changed format                                   | Delete                                                                                                                            |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Workspace authority, including managed worktrees | `~/Library/Application Support/dev/workspace-authority/`, then `git worktree prune` in each repository that had managed worktrees |
| Attempt state                                    | `<data-home>/work/attempts.sqlite` and its `-wal`, `-shm`, `-journal` sidecars, plus `<data-home>/work/attempts/`                 |
| Dev metadata in conversations                    | `<data-home>/sessions/` and `<data-home>/child-sessions/`                                                                         |
| Profile preferences                              | `<data-home>/preferences/`                                                                                                        |
| Usage reports                                    | `<data-home>/usage/`                                                                                                              |
| Installation and conversation locks              | `<installation>/.dev/coordination/`, independent of data-home overrides                                                           |

Cover the default `.dev/` data home and every explicit `--data-home` or `DEV_DATA_HOME` override in use. Current identity, ownership, revision and release-decision fences remain required; they are not historical-format compatibility.
