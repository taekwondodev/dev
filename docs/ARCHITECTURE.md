# Architecture

This document describes the architecture at the current commit and, for each choice, the use case that drove it and the tradeoff accepted. The ADRs in `docs/adr/` hold each decision's enduring constraints.

## Use cases

Dev serves one person on one macOS account, working roughly 90% on code, UI prototypes and current technical documentation and 10% on personal research. Apple development is one profile, not the identity of the environment. Every choice below is measured against these recurring situations:

1. **Pairing.** One lead conversation works with the user through investigate, decide, modify, build, inspect, review and resume. Human time to an accepted result is the metric; tokens and elapsed agent time are supporting measures.
2. **Bounded delegation.** Reviews, alternative designs and investigations run in independent children with explicit model, access and scope, and their outcomes return to the task that owns them, failures and cancellations included. A whole phase can go to a coordinator that commissions its own reviewers or candidates, one level deep.
3. **Long-running work.** Builds, tests and servers run without blocking the conversation and survive interruption with a truthful status.
4. **Several sessions on one repository.** Two TUIs, or a lead and its writing children, work on the same checkout without silently overwriting each other, and the worktrees dev creates disappear once their work is delivered.
5. **Resuming.** Settled decisions, scope and the next action survive a fresh session, and saved state is reconciled with live files and processes.

## Principles

The constraints every choice below respects:

- **Focused context.** Domain material loads when its trigger applies; universal instructions stay short. Profiles and skill paths select, they do not concatenate.
- **Compact results.** Diagnostics and source references return to the conversation; full output stays retrievable by offset. A summary keeps failure evidence and truncation notices.
- **Event-driven work.** Completion arrives through process and settle events, never through model turns spent polling.
- **Scoped delegation.** A child gets the facts and capabilities its task needs and nothing of the lead's conversation; its usage counts in the total.
- **Durable decisions.** The minimum recoverable state is stored and reconciled on resume; where Pi sessions and repository artifacts already answer, no parallel state is kept.
- **Proportional verification.** Failure modes are exercised against real artifacts; a new evaluation framework needs a demonstrated need.
- **Visible progress.** Waiting decisions and process state show in the status line and `/work`, without turning every routine event into a model message.
- **One owner.** Workflow rules live in the skill library, integration in this repository, each meaning in one document.

## Components

```text
src/launcher.ts                    dev executable: startup selection, Pi services and TUI
src/pi-runtime.ts                  resolves the installed global Pi SDK and its declarations
src/preferences.ts                 private data paths, global auth path, profile preferences
src/profiles.ts                    composes SOUL guidance and skill paths for a profile
src/work-*.ts, src/pi-child.ts     background work: tool, actions, controller, dispatch, lifecycle, store, child process
                                   and its coordination link
src/workspace-*.ts                 workspace authority: engine, worker, gates, records, admission, allocation,
                                   transitions, attachment, shell, native writes, host, commands, release,
                                   completion, evidence, tool
src/process-family.ts              process table, launch gate and family observation shared by shells and work
src/runtime-coordination.ts        installation admission and conversation claims
src/session-guard.ts               claims a Pi session switch target before Pi opens it
src/error-text.ts                  the one error-to-text helper
scripts/                           setup, update, rollback, usage profile, Pi upgrade verification and install, Pi declaration resolution, source-comment lint
profiles/                          SOUL.md and skills per profile
config/crew-dispatch.json          versioned dispatch rules
```

Pi owns inference, providers, conversation persistence, the TUI and project-instruction discovery. The shared skill library at `~/Developer/skills` owns workflow rules. Dev owns the integration only: launcher, extensions, coordination and private state.

## Choices

### Pi SDK launcher, not a fork

**Use case:** pairing and resuming with Pi's native TUI, sessions and provider handling, plus dev's tools.

**Choice:** `dev` is a launcher on the installed global Pi SDK. Extensions are inline factories, the installed package is resolved at start and its declarations are linked for type checking rather than vendored.

**Tradeoff:** every Pi upgrade is a compatibility check against the internals dev relies on, listed in [DEVELOPMENT](DEVELOPMENT.md#pi-upgrade). In exchange there is no runtime fork and no private Pi copy to maintain. Decided in [#7](https://github.com/taekwondodev/dev/issues/7) and [#11](https://github.com/taekwondodev/dev/issues/11).

### Profiles, not separate environments

**Use case:** the same extensions for general and Apple work, with Apple guidance kept out of unrelated tasks.

**Choice:** one installation with selectable profiles. A profile selects a SOUL file and skill paths, appended to Pi's native project instructions; the preference is saved per repository in the private data home.

**Tradeoff:** one data home and one session store for every profile, so isolation between profiles is by guidance, not by state. Separate homes per profile were rejected as launch and configuration overhead for one user; forks of the environment as drift. Decided in [#11](https://github.com/taekwondodev/dev/issues/11), named in [#20](https://github.com/taekwondodev/dev/issues/20).

### Effect throughout

**Use case:** coordination code with typed failures and one process-observation step and retry policy shared by shells and background work.

**Choice:** dev's own code, the Pi-facing layer included, runs in Effect. Promises remain only where Pi calls in (extension handlers, the runtime factory, session replacements, tool adapters) and in the synchronous SQLite engine behind the authority worker. Pi's own errors cross back untranslated because Pi recognizes some by class.

**Tradeoff:** the rewrite of the Pi-facing layer with its re-review, and an exactly pinned Effect 4 release candidate, over a documented Promise layer. [ADR 0005, Effect boundary](adr/0005-scoped-runtime-coordination.md#effect-boundary).

### Session-owned children in separate processes

**Use case:** bounded delegation and long-running work that must not stall the lead's event loop and must have a real cancellation boundary.

**Choice:** each attempt is a separate Node process on the Pi SDK, owned by the lead conversation; one controller per conversation and one producer per child transcript; outcomes are delivered at Pi's settle boundary and acknowledged on the conversation branch. A coordinator asks that same controller for its leaves over its own channel, so nesting adds no second controller and stops at one level.

**Tradeoff:** a process boundary is not an OS sandbox, and the POSIX adapter cannot clean up arbitrary daemonized descendants. A permanent supervisor or worker fleet was rejected because ordinary edits do not need one; a controller per coordinator because it splits cancellation, quota and usage accounting; unrestricted recursion because nothing would bound the attempts of a session. [ADR 0002](adr/0002-session-owned-background-work.md).

### Versioned dispatch, local private state

**Use case:** cloning the checkout reproduces model policy, a code update can change policy without moving private data, and logging in from global Pi or dev yields one credential.

**Choice:** dispatch rules are versioned in `config/`; private state defaults to Git-ignored `.dev/` in the checkout; authentication is the global Pi file. Invalid dispatch fails instead of substituting a model.

**Tradeoff:** dispatch is edited in the checkout, not per project, and private state travels with the checkout. [ADR 0003](adr/0003-versioned-dispatch-local-runtime.md).

### Authoritative lifecycle, incremental store

**Use case:** long-running work whose status stays truthful after crashes, without a second workflow database.

**Choice:** one mutable lifecycle authority per live attempt; native SQLite in a session-scoped worker commits ownership, payload, revision and retention together; WAL with `synchronous=NORMAL` for temporary observations.

**Tradeoff:** a power loss can drop recent attempt updates. That is accepted for observations, while code, credentials and conversations live elsewhere. [ADR 0004](adr/0004-authoritative-lifecycle-incremental-store.md).

### SQLite authority with kernel-lock gates

**Use case:** several sessions on one repository, across installations and data homes, with process death releasing what a dead session held.

**Choice:** one workspace authority per OS account, outside any data home, with repository-sharded records and SQLite lock databases as presence, writer and structure gates. The checkout is the contention unit. Persist the macOS volume UUID and lossless inode for checkout and Git directories rather than the reboot-unstable `st_dev`; use numeric devices only for same-observation mount checks. Installation admission and conversation claims are separate lock databases in `.dev/coordination/`.

**Tradeoff:** the authority coordinates cooperating dev runtimes only. External programs, detached processes and Xcode are outside it, and a lost observation blocks a checkout until an explicit recovery that does not exist yet. A global mutex, PID registries and a repository-wide fence were rejected because they serialized independent work. [ADR 0005](adr/0005-scoped-runtime-coordination.md).

### Checkout-aware native writes

**Use case:** temporary reproductions and external configuration edits should use native write/edit without reserving or isolating an unrelated project.

**Choice:** classify the destination before writer admission. Current-workspace writes keep scoped authority operations; ordinary external files use session-local permits in the same native adapter. Lead, authority and writing children share destination policy; Git administration, foreign checkouts and authority/coordination storage remain protected.

**Tradeoff:** no cross-session locking or cleanup ownership for arbitrary external files. Broadening a workspace grant was rejected because a contended project would still allocate a worktree for an external edit; temp-directory exceptions miss configurations. [ADR 0005, native writes](adr/0005-scoped-runtime-coordination.md#native-file-destinations).

### Disposable worktrees with automatic release

**Use case:** delegated writers and contended sessions get their own worktree, and those worktrees vanish once the workflow delivered the work, without per-file approvals.

**Choice:** a managed worktree is disposable after delivery. Completion is decided by one pure function over recorded and observed facts (identity, residue, uses, target, tip ancestry, bound merged pull requests), and the sweep at quit and before an allocation releases finished workspaces automatically; pre-existing checkouts are reservation-only.

**Tradeoff:** a release discards whatever remains in a finished managed worktree, uncommitted edits included, and a race with external processes moving files during deletion is accepted. Workflow declarations of completion were rejected; a confirmation remains only for `review-required` cases. [ADR 0005, release](adr/0005-scoped-runtime-coordination.md#release).

### Trusted extension base

**Use case:** the user's own extensions, presentation and status tools included, running next to dev without a plugin sandbox.

**Choice:** Pi and the installed extensions are a trusted base; project effects are coordinated through the workspace authority, non-project effects need no admission. The trusted base and the rule for changing it are in [SECURITY](../SECURITY.md).

**Tradeoff:** targeted integration maintenance per extension and no containment of trusted-code bugs, over universal certification. [ADR 0005, executable extensions](adr/0005-scoped-runtime-coordination.md#executable-extensions).
