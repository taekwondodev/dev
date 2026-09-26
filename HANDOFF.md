# Handoff: #36 workspace admission, committed locally, remaining gaps in progress

## Resume

- `task`: [#36](https://github.com/taekwondodev/dev/issues/36), coordinate task-owned workspace admission and conversation continuity. State OPEN by user decision until the PR exists. #37 (release and cleanup) is out of scope.
- `workspace`: `/Users/taekwondodev/Developer/dev`, branch `feat/36-workspace-admission`. The detached worktree `/Users/taekwondodev/.hermes/cache/scratch/dev-36-authority` (HEAD `4772677`) is still registered; retain it. The `dev-36-host` worktree named by an earlier handoff no longer exists and is not registered; nothing depends on it. Unrelated prunable registrations under `/private/tmp` and `/private/var/folders` are untouched.
- `snapshot`: 2026-09-26, after the user's go-ahead. `git log 4772677..HEAD` holds two local, unpushed commits: `670eded docs: condense ADRs and add workspace vocabulary` (the pre-existing doc changes, applied from `preexisting-docs.patch`) and the `feat(workspace)` commit with everything else, including this file. The full suite was green on the committed content (tree `e8c4f1f6` plus this file).
- `phase`: `dev-cycle`, closing the remaining gaps before the PR. The user asked to grill the open decisions with real examples (`grilling`), then implement them.
- `authorization`: user instruction of 2026-09-26: commit everything locally (done); post the #36 evidence comment but keep #36 open until the PR, and link issue and PR; continue the remaining work in parallel, and only afterwards close everything. Push and PR publication are not yet authorized: ask when the remaining work is done. #37 is unauthorized. Delivery is a PR from `feat/36-workspace-admission` to `main`, never a direct push to `main`. Do not reset, rebase or clean the branch. Keep `docs/agents/triage-labels.md` unformatted and out of scope.
- `next_action`: finish the grilling of the open decisions listed under _Remaining work_, then implement the chosen ones with a regression each.
- `required_inputs`:
  - `session-pickup`: `/Users/taekwondodev/Developer/skills/skills/session-pickup/SKILL.md`
  - `dev-cycle`: `/Users/taekwondodev/Developer/skills/skills/dev-cycle/SKILL.md`
  - `grilling`: `/Users/taekwondodev/Developer/skills/skills/grilling/SKILL.md`
  - `AGENTS.md`, `docs/agents/issue-tracker.md`, `docs/adr/0005-scoped-runtime-coordination.md`.
- `done_when`: every open decision has a user answer, and each chosen change is implemented with a regression, or recorded as a limit.
- `stop_when`: a decision is unanswered; any check turns red when rerun; a new review finding is classed blocking; any step would push, open a PR, close #36, start #37, touch the real authority root `~/Library/Application Support/dev/workspace-authority/`, `~/.pi` or credentials.

## Retained context

**User decisions taken in this session (2026-09-25/26).** Each is recorded in ADR 0005 unless noted. Do not reopen them silently.

1. The opaque fence is scoped to its checkout (#27 contention unit). The repository structure gate serializes only dev's own Git structural effects.
2. A shell use ends on observed cessation of its process group and tracked descendants. A process that detaches into a new session or group escapes: accepted residual, also for delegated children, whose Pi shell starts every command with `setsid`.
3. The recovery verb for `unknown` uses is deferred; `unknown` stays absorbing and blocks its checkout for writers.
4. The lead tool gate classifies by verified effect. Bash, `!` and `!!` run through the dev shell adapter; read, grep, find and ls are reads; write and edit are native writes performed by dev's operations; an unrecorded tool is refused without ending the turn.
5. The authority root is fixed per OS account with no runtime override; only code importing `src/launcher.ts` can inject another lifecycle (the test seam).
6. The user trusts their own `.pi/`: dev defers to Pi's folder trust and has no `project_trust` handler (ADR 0005, Executable extensions).
7. Delegated children keep the coarse workspace grain.
8. Known limit: a mixed batch that parks the host costs one extra fenced model request. The ADR records the abort-based fix and what it requires.
9. A contended write is refused with guidance, not isolated, while the conversation's own process is live in the checkout it would leave.
10. Shells are stopped at every session end or replacement except `/reload`.
11. Native writes to distinct destinations may be in flight together.
12. Worktrees left reserved by a withdrawn automatic switch are documented until #37.

**Review history.** Rounds 1 and 2 ran three isolated axes (Spec, Adversarial, Standards). Round 2 did not converge, so the findings went to the user, who gave decisions 1 to 12. Round 3, one agent over three axes, found an `act_on` regression: any attach auto-withdrew another process's pending switch. Round 4 fixed it with the explicit `withdrawUnstartedSwitch` attach option, which only the launcher passes for `--resume`/`--continue` after claiming the conversation. A targeted round-4 review (Standards and Adversarial on `round4.diff`) found one `hard` issue (missing regressions) and several `consider` findings. Round 5 fixed all of them:

- the selection attach path now refuses a pending switch like the plain path;
- the controller settles a launch whose identity was never acknowledged as `launch-failed` instead of `unknown`;
- the native write identity folds through upper case (ß/ss, ſ/s, ς/σ, ﬀ/ff) and is stored once per write;
- the host routes a failed settle of a refused write to the notifier;
- acquisition and probe share one presence gate path;
- the ADR and `COMMANDS-TERMINAL.md` state that conversation claims are per installation.

Each round-5 fix has a regression that was observed failing under a mutation reverting it. **The round-5 fixes were not re-reviewed by an independent reviewer.**

**Non-blocking smells routed to the user, not acted on:**

- the withdraw permission is a bare boolean instead of a branded claim value;
- dead distinctions: `native-read`, `unbounded`, `sourceCwd`;
- the controller and the shell adapter duplicate the observation loop and retry policy;
- the PTY probe stub mirrors engine rules;
- the two Python PTY drivers are near-identical;
- the probes load Pi through the `node_modules` link instead of `src/pi-runtime.ts`;
- path canonicalization exists in three copies (engine, child validator, native-write module);
- the 14 `smell` findings of the first review: `workspace-engine.ts` size and responsibilities, four error models, misleading helper names, CLI IDs validated by hand, and self-graded claim lists.

## Evidence and gaps

**Checks observed on tree `e8c4f1f6`**, with `TMPDIR` set to a job-private directory:

| Check                           | Result                                                                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `npm run lint`                  | exit 0: 0 errors, 4 pre-existing effect-tsgo messages. The remaining oxlint warnings predate this round.                            |
| `npm run smoke`                 | exit 0                                                                                                                              |
| `npm run workspace:check`       | exit 0: 31 authority, 16 process, 4 contract and 2 launcher claims                                                                  |
| `npm run workspace:tui`         | exit 0: stub-lifecycle PTY probe and real-authority PTY probe both `passed_marker: true`, `missing_actions: []`, 0 network attempts |
| `npx oxfmt --check src scripts` | clean                                                                                                                               |
| `git diff --check`              | clean                                                                                                                               |
| leaked processes                | none (`pgrep`)                                                                                                                      |

`npm run format:check` fails only on `docs/agents/triage-labels.md`, deliberately.

**Round-5 mutation checks, observed:**

- Removing the controller's unrecorded-launch settle makes the process check fail with `unknown` instead of `quiescent`.
- Lowercase-only folding makes it miss `STRASSE.txt` against `straße.txt`.
- Restoring the old selection path makes the authority check's attach succeed ("Missing expected rejection").
- Dropping the launcher flag makes the launcher check fail with the "unfinished workspace switch" refusal.

**#36 acceptance accounting** (criteria in the issue body, numbered in order):

| AC                                                                  | Status                     | Evidence                                                                                                                                                                                                                                                                | Gap or limit                                                                                                                              |
| ------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1 authorize before execution, atomic admission                      | met                        | authority: foreign writer and paused reservation isolate into an exact-HEAD worktree without transferring staged, untracked or ignored data. Real probe: contended write blocked, rebound, not replayed. Process: missing authority blocks with no fallback.            | A custom tool with no recorded effect is refused rather than admitted (decision 4).                                                       |
| 2 readers, delegated writers, independent progress, structural gate | met                        | authority: a reader in a second process is warned; delegated writers get distinct worktrees; linked worktrees progress; the structure gate serializes only dev allocation. Real probe: the read warning reaches the tool result.                                        | Fence is checkout-scoped (decision 1).                                                                                                    |
| 3 distinct IDs, surviving facts, WorkOwner authority                | met                        | authority: uncertainty and reservations survive close and reopen. Process: separate task and use attribution; log expiry leaves the use stage unchanged.                                                                                                                | None beyond the review smells.                                                                                                            |
| 4 shared namespace, identity, storage                               | met with limit             | Fixed per-account root with no data-home input. authority: non-private and symlinked roots rejected; synced, network and non-APFS/HFS storage refused; cross-process provisioning converges. Process: hard-linked destinations rejected.                                | Two real installations were never driven. Conversation claims are per installation (recorded).                                            |
| 5 durability                                                        | met within the amendment   | Engine asserts `synchronous=FULL` and `fullfsync=ON` on every open. authority: corrupt payloads reported, worker death and lost commit acknowledgment keep the durable use.                                                                                             | No power-loss proof (accepted). No fault test injects a wrong effective pragma.                                                           |
| 6 launch barrier and observed cessation                             | met with accepted residual | process: shell and controller launch barriers, descendants tracked until gone, aborts before release never run, lossy controller reports settle as never launched. authority: `unknown` absorbs; stale reports cannot release a later use.                              | `setsid` escape (decision 2).                                                                                                             |
| 7 real-adapter boundaries and recovery                              | met with deferred verb     | authority: lost acknowledgments, a pending handoff reopens only at its target, a withdrawn switch keeps the last binding, a switch is refused while a process is live. launcher: `dev --resume` withdraws an unstarted switch durably.                                  | No recovery verb for `unknown` (decision 3).                                                                                              |
| 8 real Pi TUI                                                       | met with limits            | Stub probe (real TUI, stub lifecycle): `!!`, pending input, genuine cancel, provider escape, repeated rebind, resume failure and refusal, selector escape. Real-authority probe: contended rebind, write batch, duplicate refusal, read warnings, unverified tool, `!`. | Creation and rebind failures are driven only against the stub lifecycle. One extra parked request is accepted (decision 8).               |
| 9 command families                                                  | partly re-verified         | Stub probe: list, inspect and resume grammar, multi-workspace ambiguity, exit 0 paths, read-only commands attach nothing. authority: corrupt payloads reported, inspection read-only.                                                                                   | This session did not re-verify no-Git listing, empty versus corrupt authority at the terminal, or cross-repository exact-task inspection. |
| 10 resume and selection                                             | met                        | authority: no auto-selection, exact selection with fresh acquisition, removed workspace refused without recreation. launcher: removed-workspace guidance with unchanged history. Stub probe: resume flows. The launcher attaches before building the runtime (source).  | None known.                                                                                                                               |
| 11 old leases replaced                                              | met                        | `background-work.md` and ADR 0005 describe the single authority. process: no old-lease fallback. `smoke` green.                                                                                                                                                         | Tests use temporary roots only; the real root, `~/.pi` and credentials were never touched.                                                |
| 12 docs and checks                                                  | met                        | Updated: ADR 0002, ADR 0005, `CONTEXT.md`, `DEVELOPMENT.md`, both `COMMANDS-*`, `background-work.md`. Checks as above.                                                                                                                                                  | Competing installations not driven (AC4).                                                                                                 |

**Other gaps, observed or known:**

- `/reload` keeping shells alive has no dedicated test (verified from source only).
- A WorkOwner failure before spawn is not exercised end to end.
- `inspect` can label a workspace `active` while a live session co-exists with abandoned uses; the label then hides them.
- Round-4 reproductions live under `/Users/taekwondodev/.hermes/cache/scratch/review4/` and expire with scratch pruning.

## Remaining work

1. Done: local commits; #36 evidence comment posted, issue kept open.
2. Grill and then close the open decisions: the evidence gaps of AC 4, 8 and 9, the non-blocking smells, the per-installation conversation claim, the `inspect` label that can hide abandoned uses, and whether an independent review of the final changes is wanted.
3. After the remaining work: rerun the full suite and ask for push and PR publication. The PR body references #36 and #36 gets a comment linking the PR; close #36 only when the user says so.
4. Later, not authorized now: #37 release and cleanup, including the worktrees left by withdrawn switches; an explicit recovery verb for `unknown` (#34 excludes repair verbs from the first version); the abort-based fix for the mixed-batch limit.

Whole-task completion: PR open and linked, and #36 closed with an accurate evidence, commit and limit report when the user authorizes it.

## Sources

- #36 body and comments (via `docs/agents/issue-tracker.md`): canonical acceptance. Linked resolutions #27, #28, #30, #31, #34; amendments [durability](https://github.com/taekwondodev/dev/issues/31#issuecomment-5810802846) and [extension policy](https://github.com/taekwondodev/dev/issues/36#issuecomment-5815706403). Read when writing the closure comment.
- Review diffs: `/Users/taekwondodev/.hermes/cache/scratch/dev36-final/round4.diff` (round-4 changes from tree `a81f3151`) and `round5.diff` (round 5, `a81f3151` to `e8c4f1f6`). Read if a further review is requested.
- Suite outputs from this session are in the job's temporary directory and are not retained; rerun `npm run workspace:check` and `npm run workspace:tui` for fresh evidence.
