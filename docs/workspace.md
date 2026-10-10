# Workspace

The workspace authority coordinates dev conversations and children without treating a whole repository as one writer. Reservations retain work across sessions; admission isolates writers; sweeps release finished work; explicit task release lets the user discard what remains. [CONTEXT](../CONTEXT.md#workspace) defines these terms and [ADR 0005](adr/0005-scoped-runtime-coordination.md) explains the design.

## Use

Terminal commands are read-only except `release`:

```bash
dev workspace                 # list this repository's tasks and workspaces
dev workspace inspect <task>  # inspect the exact task across repositories and its next safe action
dev workspace check <task>    # assess completion, target, blockers and evidence
dev workspace release <task>  # interactively confirm clearing every workspace of the task
```

In a session, `/workspace` also shows the current binding and effective directory. `/workspace inspect` mirrors the terminal command. `/workspace check` treats this conversation's own uses as ending at quit. `/workspace release` only names the terminal command; it releases nothing.

The lead's `workspace` tool has three actions:

| Action               | Effect                                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resume`             | Switch to a retained workspace at turn end without moving files; refused while the conversation has live shells or work. A refusal reports each workspace's outcome, reason and next action |
| `set-target`         | Override the conversation task's inferred integration target                                                                                                                                |
| `record-publication` | Verify exact readback of an already published issue/PR artifact and record the evidence                                                                                                     |

The tool uploads nothing, fetches no refs and cannot infer an unrecorded artifact selection.

## Behavior

### Admission and isolation

Project writes, shells and work launches are admitted before execution. The first writer keeps its checkout. Another task's reservation causes allocation from the exact current commit, without copying modified, untracked or ignored files. Readers share presence with a writer and receive a warning. Independent checkouts and linked worktrees progress concurrently; only dev's structural Git effects serialize across a repository.

A live process prevents switching or isolation until it is stopped or finishes.

Tools need a recorded effect classification. An unknown tool is refused visibly without ending the turn. Resource trust and pre-admission initialization are governed by [SECURITY](../SECURITY.md#trusted-base).

#### Delegation into another checkout

Use `work delegate` with `cwd` inside the other Git checkout. A writer receives a managed worktree from that checkout's current commit; a read-only child reads the selected checkout directly. [Work](work.md#delegation-scope) describes child instructions and access limits.

Each conversation and selected checkout has one foreign workflow task for the session, created on first use. Inspect it with `dev workspace` in that repository or by its exact task ID. The lead keeps its original binding, so `/workspace` and `set-target` still refer to the lead's task.

Selection refuses a directory outside any Git checkout, inside authority storage or inside a managed worktree, and refuses a replaced or unreadable checkout. A read-only leaf instead uses its coordinator's admitted workspace; this is inherited access, not a new checkout selection.

### Native writes

Lead and writing-child write/edit classify destinations before writer admission:

- Current-workspace files use scoped admission.
- Ordinary external files, including temporary files and configuration, need no extra consent, allowlist, reservation or rebind.
- Another checkout, including nested or linked checkouts, must be selected and admitted through delegation or a conversation bound there.
- Git administration and dev authority/coordination metadata remain protected, including canonical aliases.

Use literal paths without raw `..` or Pi shorthand. Final symlinks, hard links, changed destinations and unreadable ancestry are refused. Missing parent directories are allowed only when their existing ancestor can be checked. Duplicate in-flight destinations in one host are refused; distinct destinations can proceed together.

External permits provide neither cross-session file locking nor cleanup ownership. Disposal never removes external files. Read-only children gain no write capability; writing children still require their live controller.

### Process uses and gates

A process use ends only when its group and tracked descendants are observed gone, not when a result arrives. Use `/work stop` for attempts; it does not stop lead shells, which must be stopped separately. A process that detaches into its own session can escape observation. Lost observation records an `unknown` use and blocks writers; no explicit recovery command exists yet.

A child's use becomes `quiescent` after observed termination or failure before process launch. It stops blocking once no other use, binding or pending switch needs access; its reservation and files remain until release.

A gate-close failure returns a warning and keeps the gate held. Dev retries at the next admission or execution report, and at close at the latest. Another failure warns again. A lost owning use instead fails as `review-required`; it is not a deferred gate close. Installation-source presence remains held for the runtime's lifetime.

### Session commands

The same conversation cannot attach in two dev sessions, even across installations.

| Operation                                                     | Behavior                                                                                                                                                      |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/resume`, import of a conversation already in dev's sessions | Attach the target before teardown; refusal preserves the current session                                                                                      |
| `/new`, `/fork`, import of a copied conversation              | Attach after teardown; authority refusal ends the session. A copied conversation outside Git is refused before teardown                                       |
| `/fork`                                                       | Start a new conversation in the current workspace without the original task; first write isolates from the current commit. Commit changes first to carry them |
| Confirmed replacement                                         | Stop the leaving session's shells and work; all replacements are refused while a workspace switch is pending                                                  |
| `/reload`                                                     | Keep lead shells observed; see [work cancellation](work.md#cancellation-and-session-changes) for attempts                                                     |
| `!`, `!!`, lead bash                                          | Run dev's shell in the conversation's workspace                                                                                                               |

### Completion evidence

`check` and sweep derive completion from recorded and observed facts, not declarations that work is done. The target is a recorded override, otherwise the `origin` GitHub repository's default branch, otherwise the remote HEAD branch.

| Finished rule      | Meaning                                                                           |
| ------------------ | --------------------------------------------------------------------------------- |
| `clean-checkout`   | A pre-existing checkout has no completion residue; applies at quit only           |
| `no-residue`       | A managed workspace has no remaining work under the completion rules              |
| `branch-merged`    | A bound merged PR's source includes the workspace HEAD                            |
| `branch-in-target` | The workspace HEAD is included in its target                                      |
| `child-delivered`  | Task PR evidence establishes a child's delivery; its own commits need not survive |

These are assessment labels, not manual deletion predicates. Ignored files alone do not block completion, but unsafe filesystem structure can. Retained reasons include `no-commits`, `not-integrated`, `integration-unknown`, `directory-missing`, live or `unknown` uses, open conversation bindings and `release-review`.

Use `record-publication` for selected reports or artifacts already published in an issue or PR: it checks the exact bytes before recording them. A local copy is not a publication. Source-history inclusion proves neither semantic equivalence nor delivery of dirty edits. [ADR 0005](adr/0005-scoped-runtime-coordination.md#completion-and-evidence) preserves the constraints behind these assessments.

### Sweep

Automatic sweeps run at quit and before managed allocation, not at startup, turn end, session replacement, crash or signal shutdown. Each finished workspace gets one fenced removal attempt after reassessment. A pre-existing checkout loses only its reservation and settled use records; a managed worktree is removed. Live gates, occupied worktrees, active installation coordination or changed evidence retain it. Incomplete removal becomes `release-review`, refuses resume and is never retried automatically.

The budget is 40 seconds at quit and 20 before allocation, measured from the request. Unstarted tasks become `task-deferred`. Allocation skips clean pre-existing checkouts and the allocating conversation's workspaces. Quit also sweeps repositories resolved from other checkouts selected for delegation during the session, including refused delegations, within the same budget. A repository assessment failure is reported without preventing the others from proceeding; a later sweep can assess it again.

Allocation receipts appear in the conversation when there are rows. At quit, the receipt shows totals and elapsed time, then a complete release command and short status for each retained workspace. Tasks with a workspace still used by a live session or process are left out: that session's own quit sweeps them. Failed or deferred assessments get a check command instead. Use `dev workspace check <task>` for paths and detailed evidence.

### Release

**`dev workspace release <task>` discards everything left in all of the task's managed worktrees, including uncommitted changes and undelivered commits.** Pre-existing checkout files and commits stay; their reservations and use records end.

The command requires an interactive terminal, lists each workspace and its consequence, then asks for one `y`. There is no `--yes`. It checks no completion, evidence or live use: run it only when nothing still works in those workspaces. It neither waits for uses nor acquires path or installation gates; this is an [explicit user override](adr/0005-scoped-runtime-coordination.md#release), not a guarded sweep. The session command and agent tool cannot release them.

Release respects explicit Git worktree locks. A failed or interrupted removal stays `release-review`; rerun release to finish it. Leftover directories are deleted only after Git confirms the worktree is no longer registered, and only within dev's managed storage; an admin directory serving a moved worktree is preserved. An unreadable Git worktree list prevents confirmation and leftover deletion. When the directory is already gone, retry retains the interrupted removal's recorded HEAD as sibling delivery evidence.

Stop independently started tools and avoid external edits during removal. The [external-process race](../SECURITY.md#outside-the-protection) remains outside dev's protection.

### Quit and interruption

`/quit` stops owned work and shells, closes the attachment and installation/source claims, then sweeps and prints its receipt.

An interactive quit offers one confirmation to release eligible remaining tasks, including undelivered or undecidable work. The offer excludes a whole task if any reserved workspace is unassessed, skipped, guarded against cleanup, active or unresolved, or cannot be inspected. Excluded tasks remain listed with commands and statuses.

A task excluded only because a previous session left its use unsettled or unresolved is then offered alone, with its status. Tasks guarded against cleanup, unassessed, or with a reserved workspace outside this sweep are never offered: run their command after checking them. These convenience filters are not a guarantee against concurrent use: the [release warning](#release) still applies.

Each prompt counts managed worktrees and pre-existing reservations and explains their consequences. Only `y` releases them; Enter or any other answer keeps them. Ghostty shows sweep progress in the tab and colored status output; `NO_COLOR` disables colors. Other terminals and non-TTY output use plain text. Without an interactive terminal there is no release prompt.

Ctrl-C before the sweep or at a confirmation starts no further release. During sweep or confirmed release, started attempts reach recorded outcomes; an interrupted Git step stays `release-review`. SIGHUP can end dev without a receipt. If a sweep does not report back, its outcome is unknown and the launcher points to `dev workspace list`.

### Exit codes

| Code | Meaning                                                                                                                                                                |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Observation returned; every workspace of a confirmed release ended `released` or `removed`; or quit reached terminal outcomes, counting tasks released at quit as done |
| 1    | Observation unavailable, failed or unreported release, nothing reserved to release, unknown sweep outcome or unfinished sweep removal                                  |
| 2    | Invalid or ambiguous arguments, or missing required interaction                                                                                                        |
| 130  | Cancelled confirmation, or interrupted quit/sweep/release; an in-flight attempt completes and is reported                                                              |

Declining quit's release offer keeps the sweep's code. A successful `check` can list blockers: exit 0 is not permission to remove anything.

## State

The account-wide location is in the launcher's [state map](launcher.md#state). All installations share that authority, independently of `HOME` and data-home overrides; managed worktrees live inside it.

First use creates an absent authority. Missing parts of a known authority, invalid layout and damaged storage are refused, not reset. Each process validates a database's schema and integrity on first opening that file identity. In-place overwrites are not rechecked until another process starts: stop every dev session before restoring or copying over a database. Keep coordination databases on disk during normal operation; use [Development](DEVELOPMENT.md#discard-obsolete-state) for obsolete-state removal.

Paths containing newlines are refused for checkouts and Git directories. Replacing either at the same path changes its identity and can prevent resume. Inspect the reported reason rather than deleting coordination files to bypass it.
