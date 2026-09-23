# Handoff: issue #24, local implementation accepted with limits

## Delivery authorization

The user subsequently authorized committing all current changes, pushing main,
closing #24, and updating #18 with closure if its completed work supports it.
This supersedes the earlier no-commit, no-push and no-closure restrictions below.
The push also includes the existing #18 implementation commit
97a949f64e3625857053b751209c5ffbc95e3cc0. Published revisions and final issue states
are recorded in the respective GitHub issue comments after remote verification.

## Final user decision

After the real TUI observations and successful narrow Spec follow-up, the user
explicitly chose: "Sì: accetto questi limiti e verifico il resto nell’uso quotidiano".
This accepts local implementation and the remaining dynamic coverage limits:
final provider error, compaction/context edits and rare interleavings were not
observed. Do not relabel these as tested. The local task is complete on that basis;
no further test campaign or reviewer is running. No commit, push or issue closure
is authorized. This decision supersedes the earlier verification pause below.

## Latest manual observation

After the pause below, the user requested manual instructions and supplied the
actual TUI result. Confirmed tree navigation left /work usable, the previous
prova-tree process was cancelled, and subsequent rapido and tardivo processes
completed with READY_OK and LATE_OK and automatic lead summaries. This supplies
ordinary-path behavior evidence on the post-review source, not fault-injected
proof of rare races or final provider failures.

Read-only transcript analysis independently confirmed the active branch has
one outcome receipt for each completed attempt and none for the cancelled one:

- rapido b78febfe-2861-4117-bd84-a5ccc3664de9: receipt bf561132.
- tardivo 1ee6fcb2-24b2-4b6e-9984-f3a9d27f1e05: receipt 23f5ffc4.
- prova-tree 1ccabf8b-33e7-4fcc-b33b-1656603e63c0: no outcome receipt.

Observed leaf: 742a754e. Source:
/Users/taekwondodev/.hermes/cache/scratch/dev24-manual.xEjzC7/sessions/2026-09-23T07-57-05-469Z_01a0cd44-ae3c-73f9-98e6-1dba0377a493.jsonl

The first active branch contained no compaction/context edits and no assistant
error stops. Those cases remain unverified; the later observation below covers
cancellation of an in-progress tree summary. No assistant-initiated provider calls or
interaction with the user's live TUI were used to inspect the evidence.

Affected-axis re-review deleg_16173d6b completed. Adversarial dismissed both
original publication-race findings at source level, but kept partial coverage
because their controlled interleavings were not exercised. Spec retained the
same runtime limits and confirmed another source defect: Esc during a cancellable
tree summary triggered work interruption because !ctx.isIdle also includes branch
summarization. Pi's own Esc handler only aborts the summary in that situation.

The current adapter now checks the bound session.isStreaming for voluntary
interruption instead. Installed Pi defines this as the active lead run, distinct
from standalone tree summarization. This change passed lint, including
TypeScript, Effect diagnostics and Oxlint, targeted formatting, smoke and
git diff --check. The first manual result predates the Esc correction and is
not proof of it; the following separate observation exercises that correction.

The user supplied the requested cancelled-summary observation after instructions
to quit and restart the launcher (/reload is insufficient for its statically
imported factory). Native TUI status was "Branch summarization cancelled";
/work then showed prova-summary, attempt 29c92939-4ebc-429e-8dd7-41fa69df9ace,
still running, with no unavailable records and agentsBlocked false.

Read-only session inspection independently found the same running snapshot in
entry 79ae82c8, followed by outcome receipt 7826c0ef reporting completed, exit
code 0 and stdout SUMMARY_OK for that attempt. Source:
/Users/taekwondodev/.hermes/cache/scratch/dev24-manual.xEjzC7/sessions/2026-09-23T08-30-34-388Z_01a0cd63-5594-732d-8578-53e20235f049.jsonl
The native cancellation status is the user's TUI observation, not an event
invented from the JSONL. No branch_summary or compaction entry was present.

Narrow independent Spec follow-up deleg_9ef8c44d completed with coverage complete
and no findings for the Esc change and its voluntary lead-interruption regression.
It explicitly does not claim full #24 acceptance. Its cited transcript evidence
matches the parent's independent readback above. All reported source defects
have now been corrected and reviewed; broader dynamic coverage remains limited.
No reviewer is still running. Do not rerun the full review or impose a new suite
or exhaustive interleaving campaign: the approved Testing Decisions and
principle-prove-it-works require proportional actual-boundary observation.
No automated behavioral check is currently running. Broader provider-error,
compaction/context-edit and controlled race scenarios remain unobserved; the
user explicitly accepted these limits in the final decision above. The earlier
pause and initial review below remain historical context. No commit, push or
issue closure is authorized.

## Active task and user decision

Canonical contract: https://github.com/taekwondodev/dev/issues/24

The user authorized local implementation, checks and independent review, without
commit, push or issue closure. After an automated behavioral probe was blocked,
the user initially chose to wait, then requested manual instructions, supplied
the observations above and explicitly accepted the residual limits. Static
checks and SDK creation alone were never treated as sufficient acceptance.

Mode: dev-cycle, medium implementation unit, locally complete with the explicit
coverage decision above. Further development or delivery needs a new request;
do not restart planning or repeat the manual tests just to resume context.

## Repository and scope

- Checkout: /Users/taekwondodev/Developer/dev
- Branch: main, one pre-existing commit ahead of origin/main.
- Base and current HEAD: 97a949f64e3625857053b751209c5ffbc95e3cc0.
- This session made no commit, staged changes, push or issue closure.
- Issue #24 was assigned to taekwondodev and the assignment was read back.
- No schemas on disk, dependencies, dispatch settings, claims, credentials,
  other profiles or shared workflow guidance were changed.

Changed product files:

- src/work-extension.ts: stable controller on confirmed session_tree; validated
  raw-branch receipts; ready boundary drafts and late idle sends; generic final
  error gate distinct from quota; visible delivery/cleanup errors and honest
  cancel-all results. Inbox publication reservations fence asynchronous callbacks.
- src/work-controller.ts: synchronous batched delivery eligibility and quota;
  captures previous attempt IDs inside generation rotation's admission permit.
- src/work-domain.ts: replaces internal canDeliver with batched deliveryStatus.
- docs/background-work.md and docs/adr/0002-session-owned-background-work.md:
  align delivery, stable owner and failure behavior with the approved contract.

HANDOFF.md preserves the older #18 handoff below as historical material. Its old
uncommitted-state claims and resume instructions do not describe this task.

## Verification and review state

Latest source passed npm run lint: TypeScript, strict Effect diagnostics and
Oxlint, with no reported errors or warnings. Changed-file oxfmt --check and
git diff --check passed. npm run smoke also passed after the final Esc correction.

The existing SDK runtime probe exited 0 with "runtime probe: ok" BEFORE the
post-review race fixes. It proves runtime creation, not outcome delivery or
interactive behavior. Process proc_2eab564ef5fa is exited; no session-owned
background command remains running. Its data home was reported as
/var/folders/bh/xn2xmnl57md2whlcgb5916300000gq/T/dev-24-probe-HB9ZI3.
The background tool did not inherit the foreground TMPDIR export; for future
temporary work pass the explicit Hermes scratch path, never rely on that export.

Repository-wide format checking already failed before changes on
docs/agents/triage-labels.md and docs/project-brief.md. Neither was modified.

Independent review batch deleg_a54dcd7e:

- Standards: complete, no findings, on the pre-fix version.
- Spec: source review found no mismatch, but coverage is partial because the
  behavioral observation was blocked. The user declined to waive that gap.
- Adversarial: two grounded blockers in the pre-fix adapter. An overlapping
  inspection failure could overwrite a newer publication reservation. An idle
  send during a later extension's settlement handler could be deferred by Pi
  and eventually enter a branch whose generation had already been invalidated.

Both findings have proposed source fixes in the current working tree, but have
NOT received behavioral proof or an affected-axis re-review:

1. Each publication state has a unique object identity. Inspections and send
   acknowledgements capture that identity; stale callbacks cannot mutate newer
   reservations. Failure batches reserve all entries before awaiting persistence,
   and recording-failure is not eligible for publication.
2. bindSession observes public session agent_start/agent_settled events. Idle
   delivery remains blocked through extension settlement dispatch. The public
   settled event schedules delivery only after all extension handlers; another
   run or navigation is rechecked before sending. Shutdown removes the observer;
   session_start restores it when reopening the same bound session after reload.

Review transcripts, if still retained:
/Users/taekwondodev/.hermes/cache/delegation/live/deleg_a54dcd7e/task-0.log
/Users/taekwondodev/.hermes/cache/delegation/live/deleg_a54dcd7e/task-1.log
/Users/taekwondodev/.hermes/cache/delegation/live/deleg_a54dcd7e/task-2.log

## Evidence and failed approach

Installed Pi is 0.87.1, Node is 26.7.0. Relevant installed sources are beneath
node_modules/@earendil-works/pi-coding-agent/dist/core/:

- agent-session.js:1078-1165 runs retry/compaction recovery before the final
  agent_before_settle boundary. Use its outcome, not transient message errors.
- extensions/runner.js:662-708 replaces returned entries and continue fields;
  preserve preceding handlers' accumulated values.
- agent-session.js:531-553 emits the public settled event after extension
  handlers; :875-876 isIdle alone does not establish that barrier.
- agent-session.js:1481-1519 may defer triggered sends during extension
  settlement dispatch, or await an entire new run. Promise fulfillment is not
  itself a transcript receipt.
- session-manager getBranch supplies raw active-branch entries. Projected
  messages may omit receipts after compaction/context edits.

Two inline Node commands intended to observe the real Pi/work seam returned
"Blocked by shell hook" without executing: the original command and a reduced
version without cleanup. No behavioral output exists. Do not claim either ran,
repeat the same blocked approach through another execution route, or infer why
the hook blocked it. No new test suite, fixture files or model calls were made.

Principles that changed choices: Make Operations Idempotent selected raw receipt
readback; Model the Domain kept conversation lifetime, generation, quota and
reactivation distinct; Prove It Works prevents calling source checks runtime
proof. Shared skill procedures remain external.

## Pending and next completion criterion

1. On user resumption, establish a permitted observation of the existing Pi/work
   boundary without bypassing the shell hook. Keep the approved no-new-suite,
   no-fixture, no-benchmark and no-prescribed-manual-checklist limits. Observe
   the actual behavior relevant to #24 and the two post-review race fixes.
2. Rerun relevant existing checks and the runtime probe on the final source.
3. Request only affected-axis re-review against the same base, including the
   fixes and their regressions. Resolve Spec's runtime coverage gap explicitly.
   The initial clean Standards result does not review subsequent adapter edits.
4. Report measured behavior and remaining limits. No commit, push, publication
   or issue closure is authorized.

Next completion criterion: permitted execution supplies actual Pi/work behavior
evidence for the approved contract and race fixes, and affected review blockers
and coverage gaps are resolved. Until then, the implementation is pending, not done.

## Resume Prompt

Read the active #24 section at the top of HANDOFF.md in
/Users/taekwondodev/Developer/dev. Load session-pickup, dev-cycle and
principle-prove-it-works from the shared skills library at
/Users/taekwondodev/Developer/skills/skills. Read GitHub issue #24, reconcile the
live tree against base 97a949f64e3625857053b751209c5ffbc95e3cc0, and resume from
Pending toward the behavioral-verification criterion. The user declined to waive
that gate. Preserve the working tree; do not bypass the shell hook or commit,
push, close the issue, add suites/fixtures or make provider calls without separate
authorization. Load code-review and its result contract when re-review is due.

---

# Historical handoff: concurrent dev sessions (#18)

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
