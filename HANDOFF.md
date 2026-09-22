# Handoff: concurrent dev sessions

## Resume update (2026-09-22)

The sections below describe the 2026-09-20 pause, not the current verification state. Issue #18 remains open and the working tree remains uncommitted. The recent-session adapter passed lint, smoke, actual two-TUI proof and a disposable native Pi cwd/mtime comparison on Node 26.7.0 and 22.23.2 with installed Pi 0.87.1. Coordination and SDK proofs also passed; no model calls were made. A Spec reviewer found a partial file claim retained after identity-claim failure; this was reproduced, fixed in `src/runtime-coordination.ts`, retested on both Node versions and confirmed closed in a narrowed independent re-review. ADR 0005 and terminal/background-work documentation describe the design and transition limits. Full lint, smoke, changed-file formatting and diff checks passed; repository-wide format check still reports only the pre-existing `docs/agents/triage-labels.md` and `docs/project-brief.md` issues. The three-axis review has no remaining evidenced blocker. The compatibility risk is Pi's internal read-only discovery export. No commit, push, PR, private-data migration or paid-model experiment has been authorized.

## Follow-up: remove old-runtime compatibility

The user confirmed dev is not in use and requested no backward-compatibility paths. The new coordination code no longer reads or probes old `runtime.lock` files, and maintenance admission no longer takes a data home merely for that check. The dedicated work-store `legacy-format` handling has also been removed from both store boundaries; unsupported layouts still fail closed. Mixed old/new runtime revisions remain unsupported because old code does not implement the new protocol. The sections below remain historical evidence, not current instructions. The updated issue #18 and ADR 0005 state the coordination contract.

The user authorized complete cleanup of the local work store because its data is not important. With no dev runtime process observed, `.dev/work/` and the obsolete `.dev/runtime.lock` were removed. Sessions, child sessions, handoff evidence, configuration and credentials were outside that cleanup. No tests or console-print checks were run after the final work-store changes or cleanup, as requested.

## Task and status

Canonical spec: https://github.com/taekwondodev/dev/issues/18

Paused on 2026-09-20 at the user's request because subscription allowance is nearly exhausted. Resume only on request. The spec is ready for implementation, not a claim of completed implementation. Do not commit, push, publish a PR, migrate private data, or modify other profiles/shared guidance without authorization.

Mode: dev-cycle feature, implementation and verification in progress. Grounding and competing architecture sketches completed. Product priorities were approved. No new interview is needed to recover those priorities.

## Repository state

Checkout: /Users/taekwondodev/Developer/dev
Branch: main
Base HEAD: d0e520da38f192f5ed258483670e744c4abd4e85
No implementation commit was made. Preserve and reconcile the working tree before editing.

Changed tracked files:

- src/launcher.ts: early scoped admission, pre-open conversation claims, guard wiring and native navigation adapter.
- src/pi-runtime.ts: final read-only recent-session discovery adapter. THIS LAST EDIT HAS NOT BEEN TYPECHECKED OR EXERCISED.
- src/preferences.ts: removed global runtime.lock implementation and old ownership API; paths/preferences remain.
- src/work-extension.ts: removed destructive close from cancellable before-switch/before-fork events; confirmed session_shutdown still closes work. Existing before-tree behavior remains.
- scripts/maintain.ts: setup/update/rollback hold the exclusive installation barrier for their scopes.

New implementation files:

- src/runtime-coordination.ts: scoped SQLite installation/conversation locks, canonical paths, legacy lock inspection, navigation claim settlement.
- src/session-guard.ts: Pi event and replacement-operation adapter; preserves original navigation errors.

HANDOFF.md is a new handoff artifact, not a product change. No ADR/operations updates have been implemented yet.

## Decisions and evidence

The primary workload is multiple independent sessions on different repositories. The user explicitly said to maximize that workload and performance, not merely optimize implementation convenience. Evaluate useful accepted work per quota/cost, including fresh input, cache read/write, output, reasoning, retries, compactions and duplicated context. Cache writes being the dominant subscription cost is a user hypothesis, not a universal verified fact. Do not assume sessions share cache.

Historical investigation found the global runtime.lock before #16, including commit d36c3c9. #16 retained it while moving to Effect. The documented maintenance requirement did not imply one dev process globally. ADR 0004 requires one lifecycle authority per attempt. Existing background work can already run different tasks concurrently, with separate linked worktrees required for writer children.

Selected architecture: native SQLite rollback-journal locks in separate resource databases, not the WAL operational work store. Installation admission is shared for runtimes and exclusive for maintenance. Conversation resources include canonical file path and session ID scoped to data home. Fixed installation coordination under .dev remains independent of overrides. Kernel locks release on process death. Keep inert lock files; do not unlink published databases. Separate Before Serializing Shared State changed the design from global exclusivity to resource ownership.

Rejected alternative: per-owner filesystem registrations with PID liveness scans, recovery and admission gates. Both candidates are saved with the evidence. No daemon, periodic registry scan, per-turn work, new model call, tool definition, or system-prompt text was added by coordination. Existing provider/model/effort configuration is untouched.

Require older runtimes stopped before transition. Existing legacy PID locks are inspected without deletion. Mixed revisions and independent installations bypassing this protocol are outside the guarantee. Existing worktree lease scope is unchanged, not upgraded into an OS sandbox.

## What did not work and why

1. The first SDK proof failed after newSession because its observer compared undefined target and undefined cancellation path, accidentally cancelling all new sessions. This was a fixture bug. The observer now requires a defined cancellation path and asserts native cancellation results.
2. Native fork requires a saved conversation when the target has a parent entry. The fixture now explicitly writes its synthetic header/entries before fork. No fabricated assistant response or model call was used.
3. Using SessionManager.list for --continue looked safe but scans full conversation bodies and sorts by activity, whereas native continueRecent selects header-filtered filesystem mtime. This creates both a performance and selection regression. The FINAL, UNVERIFIED edit replaces list with the installed module's findMostRecentSession helper, loaded lazily by pi-runtime. Its signature was read from installed declarations. This is an internal package-layout dependency, not a stable top-level export. Validate or redesign it before shipping; do not silently reinstate the full-history scan.
4. The first TUI proof's ANSI stripping used Python re.sub incorrectly, including cleanup logging. Corrected the proof and reran successfully. Process inspection afterward found no surviving proof processes.

## Verified observations, before the final edit

All fixtures are disposable; actual SDK and TUI paths were exercised without model turns.

- npm run lint: passed TypeScript, strict Effect diagnostics and Oxlint.
- npm run smoke: passed actual launcher diagnostics with temporary data home.
- coordination-proof.mjs: passed on Node 26.7.0 and 22.23.2. Covered independent processes, file/identity conflicts, symlinks, explicit homes, maintenance admission, SIGKILL release and concurrent independent startup.
- sdk-proof.mjs: passed with actual Pi 0.85.1 on Node 26.7.0 and 22.23.2. Covered busy resume before shutdown, later-extension cancellation, successful resume/new/fork/import, factory failure and independent ownership after close.
- SDK comparison: guard versus no guard had equal system prompt, tool definitions and initial messages in the isolated fixture. This is not a paid-request or subscription-cache measurement.
- tui-proof.py: passed on Node 26.7.0 with actual Pi 0.85.1, two PTYs, separate working repositories, same data home, isolated HOME and PI_OFFLINE. Both launchers remained alive; competing --resume/--continue failed; actual setup/update/rollback were blocked even with another data home; native /quit released one owner while the other answered /session; subsequent resume succeeded; maintenance admission reopened after all quit.
- git diff --check passed before the final discovery-adapter edit.

These passes DO NOT validate the final pi-runtime/launcher edit. No performance measurements or three-axis review have completed. No full paid-model run, power-loss test, or subscription savings claim exists.

## Pending, in order

1. Validate the final recent-session adapter: lint, smoke and actual TUI proof. Add a focused disposable check that --continue preserves native cwd and mtime choice when activity timestamps differ, and claims before Pi opens. Confirm installed-version compatibility or replace the internal dependency with a justified boundary.
2. Complete edge coverage against the spec: busy copied identity and failed navigation behavior; crash/initialization races; private permissions and malformed/legacy lock preservation; ensure existing writer leases and session-specific operational outcomes remain isolated. Review disposal during navigation and Pi teardown/factory failures. These are unproven risks, not confirmed defects.
3. Measure startup-only overhead under uncontended, simultaneous independent and conflicting acquisition. Compare the frequent workload and best/typical/worst cases honestly. No model calls are authorized merely to measure quota.
4. Recheck design shape if integration requires repeated workarounds. Update ADR and operations docs with selected shape, exact compatibility limits and observed evidence. Keep shared workflow rules external.
5. Run all relevant checks on the final tree and a single independent Standards/Spec/Adversarial review against base d0e520da38f192f5ed258483670e744c4abd4e85, including untracked files. Fix blockers and narrowly re-review affected axes. No reviewers were dispatched yet.
6. Report actual result and remaining limits to the user. Leave commit/publication decisions to the user.

## Durable artifacts and reproduction

Private snapshot directory: .dev/handoffs/multisession/

- SPEC.md: exact issue-body snapshot; issue #18 is canonical.
- snapshot.zip: source snapshots for all seven implementation files, tracked diff, this handoff, spec, candidates, pre-implementation acceptance contract, disposable proofs, results and TUI text evidence.
- manifest.json: archive entry sizes and SHA-256 hashes for verifying the snapshot.

The archive deliberately excludes credentials, existing conversations, operational databases and node_modules. It is private and ignored by Git; do not force-add it. Current source files also remain in the working tree.

Original proofs live at /Users/taekwondodev/.hermes/cache/scratch/dev-multisession/. Scratch can expire after 72 hours; use the durable archive's evidence directory if needed. Scripts contain absolute checkout/scratch paths; reconcile them before running on another machine. The snapshot is evidence, not a command to overwrite newer work.

Observed commands:

    npm run lint
    npm run smoke
    node /Users/taekwondodev/.hermes/cache/scratch/dev-multisession/coordination-proof.mjs
    node /Users/taekwondodev/.hermes/cache/scratch/dev-multisession/sdk-proof.mjs
    npm exec --yes --package=node@22.23.2 -- node /Users/taekwondodev/.hermes/cache/scratch/dev-multisession/sdk-proof.mjs
    python3 /Users/taekwondodev/.hermes/cache/scratch/dev-multisession/tui-proof.py

Prior conversation context can be recovered with session ID 20260920_153112_dd747d, but the spec and handoff should suffice. Cost-source references inspected earlier include OpenAI prompt caching, Codex pricing/rate-card and ChatGPT plan documentation, plus Claude prompt caching. API pricing must not be treated as subscription accounting.

## Active skills and next completion criterion

Load dev-cycle, session-pickup, implement, architect, coding-standards, testing, principle-type-system-discipline, principle-prove-it-works and relevant principles. Read installed node_modules/effect/AGENTS.md fully before editing Effect. Use writing-for-agents for ADRs/docs and code-review for the final independent review. Do not restart the completed architecture competition without new evidence.

Next criterion: the final recent-session adapter compiles and a real launcher preserves native recent-session selection while refusing an already-owned conversation before opening it.

## Resume Prompt

/dev-cycle
/session-pickup
Read HANDOFF.md and GitHub issue #18 in taekwondodev/dev. Resume the paused concurrent-session implementation from Pending, preserving the uncommitted working tree. The last recent-session discovery edit is unverified. Use the durable snapshot only as evidence, not to overwrite newer work. No commit, push, private-data migration or paid model experiment is authorized.
