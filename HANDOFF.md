# Handoff: #36 workspace admission, review fixes integrated, full suite not yet rerun

## Resume

- `task`: [#36](https://github.com/taekwondodev/dev/issues/36), coordinate task-owned workspace admission and conversation continuity. The issue is OPEN by user decision until the PR exists; the evidence comment is already posted ([link](https://github.com/taekwondodev/dev/issues/36#issuecomment-5844741850)). #37 (release and cleanup) is out of scope.
- `workspace`: `/Users/taekwondodev/Developer/dev`, branch `feat/36-workspace-admission`. It is the only registered worktree; the scratch worktrees used earlier (`dev-36-authority`, `wt-*`) are gone.
- `snapshot`: 2026-09-26 night. HEAD `69d8362426ae691add8c18a4e1a59359dc990029`, working tree clean, 35 local unpushed commits over `main` (`4772677`). The last 11 commits (`a663588` to `69d8362`) integrate two parallel review-fix branches and were checked only with `npx tsc --noEmit -p .` (0 errors), `npx oxfmt --check src scripts` and `git diff --check`. The full suite was last green at `05d3afa`.
- `phase`: `dev-cycle` step 7, the final three-axis review, now between round 1 and round 2. Owning skills: `dev-cycle`, then `code-review` for round 2 and `pr` for delivery.
- `authorization`: user instructions of 2026-09-26.
  - Local commits: authorized.
  - At the end, after the final review converges: push the branch and open a PR to `main` whose body says `Closes #36`, then comment on #36 with the PR link. The user merges, which closes #36; do not merge or close #36 yourself.
  - Never push directly to `main`; #37 is unauthorized.
  - Do not reset, rebase or clean the branch; keep `docs/agents/triage-labels.md` unformatted and out of scope.
  - The user stopped the previous session before the suite rerun and asked to continue from this handoff.
- `next_action`: run the full suite on HEAD with `TMPDIR` set to a private temporary directory: `npm run lint`, `npm run smoke`, `npm run workspace:check`, `npm run workspace:tui`, `npx oxfmt --check src scripts`, `git diff --check`, then `pgrep -fl "dev-shell|sleep 60"` for leaked processes, then confirm `~/Library/Application Support/dev` still does not exist. Fix anything red with a regression, and commit.
- `required_inputs`:
  - `session-pickup`: `/Users/taekwondodev/Developer/skills/skills/session-pickup/SKILL.md`
  - `dev-cycle`: `/Users/taekwondodev/Developer/skills/skills/dev-cycle/SKILL.md`
  - `AGENTS.md`, and `node_modules/effect/AGENTS.md` before writing Effect code (project rule).
  - `docs/adr/0005-scoped-runtime-coordination.md` (scoped operations, Effect boundary, executable extensions) and `docs/DEVELOPMENT.md` (checks, module ownership).
- `done_when`: every command in `next_action` passes on the same commit (lint with 0 errors and 0 effect messages, both PTY probes `passed_marker: true` with no missing actions, no leaked process, real authority root absent), with any fix committed.
- `stop_when`:
  - a failure that needs a behavior or scope decision;
  - a review finding classed blocking that cannot be fixed without one;
  - any step that would merge, close #36, start #37 or push to `main`;
  - any step that would touch the real authority root `~/Library/Application Support/dev/workspace-authority/`, `~/.pi` or credentials (every check uses temporary roots; the launcher only runs through the injected-lifecycle seam or with a disposable `HOME`).

## Retained context

**Implementation decisions (2026-09-25/26), recorded in ADR 0005 unless noted. Do not reopen them silently.**

1. The opaque fence is scoped to its checkout (#27 contention unit); the repository structure gate serializes only dev's own Git structural effects.
2. A shell use ends on observed cessation of its process group and tracked descendants. A process that detaches into a new session escapes; the residual is accepted, also for delegated children.
3. No recovery verb for `unknown` yet; `unknown` is absorbing and blocks its checkout for writers.
4. The lead tool gate classifies by verified effect. Bash, `!` and `!!` run through dev's shell; read, grep, find and ls are reads; write and edit are native writes; an unrecorded tool is refused without ending the turn.
5. The authority root is fixed per OS account (ADR 0003); only code importing `src/launcher.ts` can inject another lifecycle.
6. Dev defers to Pi's folder trust for the user's own `.pi/` (ADR 0005, Executable extensions).
7. Delegated children keep the coarse workspace grain.
8. Accepted known limit: a mixed batch that parks the host costs one extra fenced model request (the ADR records the abort-based fix).
9. A contended write is refused with guidance while the conversation's own process is live in the checkout it would leave.
10. Shells stop at every session end or replacement except `/reload`.
11. Native writes to distinct destinations may be in flight together.
12. Worktrees left by a withdrawn automatic switch stay reserved until #37.

**Grilling decisions of 2026-09-26, implemented:**

- A conversation gate in the account-wide authority, keyed by session file and session ID (not data home).
- Each opening of a conversation holds an incarnation gate whose token every use records, so `inspect` names uses left by ended sessions even after the conversation is resumed.
- Any attach that wins the conversation gate withdraws a switch that never reached the host, TUI `/resume` included.
- The Pi-facing layer runs in Effect (ADR 0005 "Effect boundary").
- Every review smell group is fixed before the PR.
- Delivery is by PR.

**Final review round 1** ran at `f7cb3b4` with three isolated reviewers (Spec, Adversarial, Standards).

Blockers, all fixed in `05d3afa` with regressions observed failing under a mutation that reverts each fix:

- the conversation gate was keyed by data home;
- the `inspect` docs were stale;
- TUI `/resume` of a conversation live elsewhere made Pi exit with no cleanup; it now notifies and cancels;
- the shell's final `quiescent` report had lost its retry (the controller's final report now retries too);
- hand-written error-code guards;
- code comments restating ADR text.

The remaining two Standards blockers, validate-once and host Promise APIs, went to worktree agents together with the smell groups, and are integrated at `81150f9..8be1e48` and `a663588..7c2c50f`.

**What the integrated branches changed (check these in round 2):**

- Engine (`81150f9..8be1e48`):
  - RPC inputs are decoded once, at the worker;
  - `WorkspaceOperation` and grant leases are tagged unions, callers build `{ kind: ... }`;
  - IDs are branded (`WorkspaceId`, `newId()`);
  - each schema is defined once in `src/workspace-domain.ts`;
  - duplicated engine checks are extracted;
  - dead code is gone (`allocateDetachedWorktree`, `taskLabel`), as is the attachment/engine middle-man layer, so the worker dispatches through `engine.run`;
  - `allocateWorkspace` is split in two;
  - generic helpers moved to `src/workspace-platform.ts`, and `AuthorityPaths` to `src/workspace-authority-root.ts`.
  - Deviations the agent reported:
    - one merged "unsupported format" message for the protocol gate;
    - `holdGates` applies the allocation identity check;
    - `settleClosingState` settles every lease before releasing any gate;
    - `canonicalRoot` resolves through `realpathSync.native`;
    - extra keys on an operation are stripped by the protocol decode rather than refused.
- Effect layer (`a663588..7c2c50f`):
  - `prepareRuntime` and `commitRuntime` are Effects;
  - `WorkspaceWorkControls` are Effects built by `workControlsOf`, and a failing control is a notice;
  - `Effect.fnUntraced` throughout;
  - native writes settle on `Deferred`s and run through the host's runtime;
  - handoffs fork into a scoped `FiberSet`;
  - command parsers return `Effect` failures, and unexpected exceptions stay defects;
  - one `sameConversation`, one `noUiTrustContext`;
  - Pi types imported from the package root;
  - two new checks: failing work controls, and `dev --probe-runtime` through the real runtime factory with a disposable `HOME`.
- Integration (`69d8362` and conflict resolutions):
  - `exactId` is an Effect decoding the branded ID;
  - the host and shell `authorize` calls use the union shapes;
  - one `errorText` in `src/error-text.ts` for every workspace module.
  - Error-text copies remain in older modules outside the #36 diff (`preferences.ts`, `profiles.ts`, `work-dispatch.ts`, `work-controller.ts`, `work-extension.ts`, `pi-child.ts`, `runtime-coordination.ts`, `session-guard.ts`, `work-protocol.ts`); out of scope unless the user asks.

**Noted, not changed:** the controller now settles an unacknowledged launch before the root-reuse check, so a reused root after a gated launch settles as `launch-failed` instead of `unknown`; the root never released user code.

## Evidence and gaps

| Check                                           | Commit                         | Result                                              | Source            |
| ----------------------------------------------- | ------------------------------ | --------------------------------------------------- | ----------------- |
| `tsc`, `oxfmt --check`, `git diff --check`      | `69d8362`                      | pass                                                | observed          |
| lint, smoke, `workspace:check`, `workspace:tui` | `69d8362`                      | **not run** (user instruction)                      | required next     |
| full suite, as in `next_action`                 | `05d3afa`                      | pass, 0 effect messages, no leaks, real root absent | observed          |
| full suite in the engine worktree               | `3744a55` (before integration) | pass                                                | reported by agent |
| full suite in the Effect worktree               | `1744ed4` (before integration) | pass                                                | reported by agent |

Integration conflict resolutions were not exercised by any test yet.

**Regressions added in `05d3afa`**, each observed failing under a mutation reverting its fix:

- held-conversation switch cancelled (real TUI probe and stub probe);
- shell and controller final-report retry (process check);
- same conversation file under two data homes refused;
- gate kept while the last attachment closes with a pending switch;
- `inspect` naming a dead session's use after the conversation is resumed (authority check).

**Acceptance (#36).** As of `05d3afa` every criterion is met or met with an accepted limit. The accounting published in the #36 comment still holds, with these closures since then:

- AC 4: a second installation with its own data home is refused.
- AC 8: a refused allocation and a held-conversation switch both run in the real TUI against the real authority.
- AC 9: terminal edges are covered by the launcher check (no-Git list, absent versus corrupt authority, cross-repository inspect, malformed ID exits 2).
- `/reload` keeping shells and a WorkOwner pre-spawn failure are now tested.

Remaining limits for the PR body:

- no power-loss proof;
- `setsid` escape;
- no recovery verb for `unknown`;
- the extra parked request;
- creation failure during a rebind driven only against the stub lifecycle.

**Round-1 review evidence.** Reproductions are under `/Users/taekwondodev/.hermes/cache/scratch/review-final/{spec,adversarial,standards}/`; they expire with scratch pruning. The round-1 diff is `/Users/taekwondodev/.hermes/cache/scratch/dev36-final/final.diff`.

## Remaining work

1. Full suite on HEAD (`next_action`); fix red.
2. The test-tools smell group, chosen by the user. Mutation-verify every rewritten assertion.
   - The stub lifecycle in `scripts/workspace-host-pty-probe.ts` still copies the engine's scoped rules and execution stage machine. Record facts instead, keep the fact-sequence assertions, and leave rule enforcement to the real-authority probe.
   - Both probes rebuild their own copy of the launcher's runtime factory. Export it from `src/launcher.ts` with injectable model, lifecycle and extensions and use it in both, or record the limit in `docs/DEVELOPMENT.md`.
   - The real-authority probe prints a static claim list; use `makeClaims` from `scripts/workspace-check-support.ts`.
   - `scripts/run-workspace-pty-probes.py` hard-codes the stub's fixture IDs; let the probe print what the driver must type.
   - The stub patches `process.send` and `process.connected` globally and casts a fake `ExtensionAPI`; test the child gate through an injectable IPC seam.
   - Replace weak assertions such as `/workspace/i` with specific text.
3. Rerun the full suite; update `HANDOFF.md`.
4. Final review round 2 with `code-review`: three isolated reviewers on `git diff f7cb3b4 HEAD`, rechecking the round-1 findings and the integration deviations listed above. Fix blockers and rerun affected axes. If round 2 does not converge, show the remaining findings to the user (procedure rule).
5. Delivery with the `pr` skill:
   - push `feat/36-workspace-admission`;
   - open a PR to `main` with `Closes #36`, evidence, decisions and limits;
   - comment on #36 with the PR link;
   - leave the merge to the user.

Whole-task completion: PR open and linked from #36, merged by the user.

Later, not authorized: #37 (release and cleanup, including worktrees left by withdrawn switches); a recovery verb for `unknown`; the abort-based fix for the mixed-batch limit.

## Sources

- #36 body and comments (read with `gh`, see `docs/agents/issue-tracker.md`): canonical acceptance, with linked resolutions #27, #28, #30, #31, #34 and the amendments on durability (https://github.com/taekwondodev/dev/issues/31#issuecomment-5810802846) and on the extension policy (https://github.com/taekwondodev/dev/issues/36#issuecomment-5815706403). Read for round 2 (Spec) and for the PR body.
- `/Users/taekwondodev/.claude/skills/code-review/SKILL.md` and `references/result-contract.md`: read before round 2.
- `/Users/taekwondodev/.claude/skills/testing/SKILL.md`: read before the test-tools group.
- `/Users/taekwondodev/.claude/skills/pr/SKILL.md`: read before delivery.
- Memory notes in `/Users/taekwondodev/.claude/projects/-Users-taekwondodev-Developer-dev/memory/`: the user wants Effect used uniformly and prefers fixing review smells in the same delivery.
