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

The lead's `workspace` tool supports these operations:

| Action               | Effect                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `artifacts`          | Create and return the [task artifact directory](#task-artifacts)                                                                                                                                 |
| `resume`             | End the turn and switch to a retained workspace without moving files; refused while the conversation has live shells or work. A refusal reports each workspace's outcome, reason and next action |
| `set-target`         | Override the conversation task's inferred integration target                                                                                                                                     |
| `record-publication` | Verify exact readback of an already published issue/PR artifact, in the workspace or in the task artifact directory, and record the evidence                                                     |

The tool uploads nothing, fetches no refs and cannot infer an unrecorded artifact selection.

## Behavior

### Admission and isolation

Project writes, shells and work launches are admitted before execution. The first writer keeps its checkout. Another task's reservation causes allocation from the exact current commit, without copying modified, untracked or ignored files. Readers share presence with a writer and receive a warning. Independent checkouts and linked worktrees progress concurrently; only dev's structural Git effects serialize across a repository.

A live process prevents switching or isolation until it is stopped or finishes.

Tools need a recorded effect classification. An unknown tool is refused visibly without ending the turn. Resource trust and pre-admission initialization are governed by [SECURITY](../SECURITY.md#trusted-base).

A rebind requested by a tool call ends the turn, as Escape would: the refused call keeps its reason, sibling calls that had not run are cancelled, a notice names the rebind reason, and the conversation switches once the turn settles. After the switch, the follow-up tells the model to re-evaluate the refused operation in the new workspace rather than replay it, and that cancelled calls may be issued again. Queued messages and the editor draft are carried into the new session. [ADR 0005](adr/0005-scoped-runtime-coordination.md#scoped-workspace-operations) records why the run ends.

#### Delegation into another checkout

Use `work delegate` with `cwd` inside the other Git checkout. A writer receives a managed worktree from that checkout's current commit; a read-only child reads the selected checkout directly. [Work](work.md#delegation-scope) describes child instructions and access limits.

Each conversation and selected checkout has one foreign workflow task for the session, created on first use. Inspect it with `dev workspace` in that repository or by its exact task ID. The lead keeps its original binding, so `/workspace` and `set-target` still refer to the lead's task.

Selection refuses a directory outside any Git checkout, inside authority storage or inside a managed worktree, and refuses a replaced or unreadable checkout. A read-only leaf instead uses its coordinator's admitted workspace; this is inherited access, not a new checkout selection.

### Native writes

Lead and writing-child write/edit classify destinations before writer admission:

- Current-workspace files use scoped admission.
- Files inside the bound task's [artifact directory](#task-artifacts) first admit the conversation as writer of its checkout, like a workspace write, then proceed as an external write. Another task's directory, the artifacts root and the rest of the authority stay refused.
- Ordinary external files, including temporary files and configuration, need no extra consent, allowlist, reservation or rebind.
- Another worktree of the bound repository, including its original checkout, is refused with the same file's path in the current workspace, or with a statement that the file does not exist there. The destination is never rewritten.
- Another repository, including a checkout nested in the caller's own managed workspace, is reserved for the conversation's [foreign workflow task](#delegation-into-another-checkout) through that repository's authority and written in place, without a managed worktree or rebind. A checkout reserved or being written by another task is refused with guidance to delegate the change or wait.
- Git administration, dev authority/coordination metadata and other conversations' managed worktrees remain protected, including canonical aliases.

A writing child follows the same policy: its controller reserves the other repository for the lead conversation. Inside managed storage, native writes require the caller to be an active writer in the containing workspace; [delegation selection](#delegation-into-another-checkout) remains separate. [SECURITY](../SECURITY.md#trusted-base) governs which repository resources load. Refusals state the reason and the next action at the failed call.

Use literal paths without raw `..` or Pi shorthand. Final symlinks, hard links, changed destinations and unreadable ancestry are refused. Missing parent directories are allowed only when their existing ancestor can be checked. Duplicate in-flight destinations in one host are refused; distinct destinations can proceed together.

External permits provide neither cross-session file locking nor cleanup ownership. Ordinary external files remain outside disposal; [task artifacts](#task-artifacts) have authority-owned cleanup. Read-only children gain no write capability; writing children still require their live controller.

### Task artifacts

Use the task artifact directory for files that must stay outside the commit scope: PR bodies, reports, logs and handoffs. The `artifacts` action first admits the lead as writer of its checkout, then creates and returns the directory; contention may request a [rebind](#admission-and-isolation) instead. A writing child whose grant carries the task may write there when the lead passes the path in its assignment; children receive no automatic announcement. `/workspace` and `dev workspace inspect <task>` show the path while the directory exists.

The directory is retained while the task reserves any workspace across repositories. A [sweep](#sweep) removes it after the attempt ending the last reservation; quit and replacement sweeps also remove orphan directories within their budget. Explicit [task release](#release) lists the directory in its confirmation and removes it once no reservations remain.

Removal outcomes appear in receipts and release results. Failed or interrupted artifact deletion can be retried by a later quit or replacement sweep. A link or non-directory entry is left for review with an inspect command; entries not named after a task are left untouched.

### Process uses and gates

A process use ends only when its group and tracked descendants are observed gone, not when a result arrives. Use `/work stop` for attempts; it does not stop lead shells, which must be stopped separately. A process that detaches into its own session can escape observation. Lost observation records an `unknown` use and blocks writers; no explicit recovery command exists yet.

A command whose checkout was replaced before user code is released never runs. A checkout replaced while a command runs, including by the command itself, does not end observation: stopping the shell still kills its family, and the use ends `unknown` instead of `quiescent`.

A child's use becomes `quiescent` after observed termination or failure before process launch. It stops blocking once no other use, binding or pending switch needs access; its reservation and files remain until release.

A gate-close failure returns a warning and keeps the gate held. Dev retries at the next admission or execution report, and at close at the latest. Another failure warns again. A lost owning use instead fails as `review-required`; it is not a deferred gate close. Installation-source presence remains held for the runtime's lifetime.

### Session commands

The same conversation cannot attach in two dev sessions, even across installations. See [automatic history cleanup](launcher.md#automatic-history-cleanup) for conversation retention and [ADR 0005](adr/0005-scoped-runtime-coordination.md#conversation-retention-admission) before changing deletion admission.

| Operation                                                     | Behavior                                                                                                                                                      |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/resume`, import of a conversation already in dev's sessions | Attach the target before teardown; refusal preserves the current session                                                                                      |
| `/new`, `/fork`, import of a copied conversation              | Attach after teardown; authority refusal ends the session. A copied conversation outside Git is refused before teardown                                       |
| `/new`, import of a copied conversation                       | Apply the [replacement sweep](#sweep)                                                                                                                         |
| `/fork`                                                       | Start a new conversation in the current workspace without the original task; first write isolates from the current commit. Commit changes first to carry them |
| Confirmed replacement                                         | Stop the leaving session's shells and work; all replacements are refused while a workspace switch is pending                                                  |
| `/reload`                                                     | Keep lead shells observed; see [work cancellation](work.md#cancellation-and-session-changes) for attempts                                                     |
| `!`, `!!`, lead bash                                          | Run dev's shell in the conversation's workspace                                                                                                               |

### Completion evidence

`check` and sweep derive completion from recorded and observed facts, not declarations that work is done. The target is a recorded override, otherwise the `origin` GitHub repository's default branch, otherwise the remote HEAD branch.

| Finished rule      | Meaning                                                                           |
| ------------------ | --------------------------------------------------------------------------------- |
| `clean-checkout`   | A pre-existing checkout has no completion residue                                 |
| `no-residue`       | A managed workspace has no remaining work under the completion rules              |
| `branch-merged`    | A bound merged PR's source includes the workspace HEAD                            |
| `branch-in-target` | The workspace HEAD is included in its target                                      |
| `child-delivered`  | Task PR evidence establishes a child's delivery; its own commits need not survive |

These are assessment labels, not manual deletion predicates. Ignored files alone do not block completion, but unsafe filesystem structure can. Nested repositories block automatic removal of the containing managed workspace even when ignored. Retained reasons include `no-commits`, `not-integrated`, `integration-unknown`, `directory-missing`, live or `unknown` uses, open conversation bindings and `release-review`.

Use `record-publication` for selected reports or artifacts already published in an issue or PR: it checks the exact bytes before recording them. A local copy is not a publication. A file in the task artifact directory is recorded under its own root and never counts as workspace residue or evidence for a workspace file. Source-history inclusion proves neither semantic equivalence nor delivery of dirty edits. [ADR 0005](adr/0005-scoped-runtime-coordination.md#completion-and-evidence) preserves the constraints behind these assessments.

### Sweep

Automatic sweeps run at quit, at a conversation replacement by `/new` or a copied import, and before managed allocation. Startup, turn end, `/fork`, `/resume`, crash and signal shutdown do not trigger them. Allocation skips clean pre-existing checkouts and the allocating conversation's workspaces.

The replacement sweep runs after the leaving conversation's attachment closes and before the new conversation attaches. Releasing a clean pre-existing checkout lets the new conversation's first write keep it; a modified checkout stays reserved and that write isolates. A sweep failure appears in the receipt without failing the replacement.

Each finished workspace gets one fenced removal attempt after reassessment. A pre-existing checkout loses only its reservation and settled use records; a managed worktree is removed. Live gates, occupied worktrees, active installation coordination or changed evidence retain it. Incomplete removal becomes `release-review`, refuses resume and is never retried automatically. Task artifact cleanup follows its [reservation-based lifecycle](#task-artifacts).

The budget runs from the request, including queue time; [the sweep implementation](../src/workspace-release.ts) owns its limits. Unstarted tasks become `task-deferred`. Quit and replacement also sweep repositories reached by native writes or selected for delegation during the leaving session, including refused delegations, within the same budget. A repository assessment failure is reported without preventing the others from proceeding; a later sweep can assess it again.

Allocation and replacement receipts appear in the conversation when there are rows. At quit, the receipt shows totals and elapsed time, then a complete release command and short status for each retained workspace. Tasks with a workspace still used by a live session or process are left out: that session's own quit sweeps them. Failed or deferred assessments get a check command instead. Use `dev workspace check <task>` for paths and detailed evidence.

### Release

**`dev workspace release <task>` discards everything left in all of the task's managed worktrees and in its [artifact directory](#task-artifacts), including uncommitted changes and undelivered commits.** Pre-existing checkout files and commits stay; their reservations and use records end.

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

The account-wide location is in the launcher's [state map](launcher.md#state). All installations share that authority, independently of `HOME` and data-home overrides; managed worktrees and task artifact directories live inside it.

First use creates an absent authority. Missing parts of a known authority, invalid layout and damaged storage are refused, not reset. Each process validates a database's schema and integrity on first opening that file identity. In-place overwrites are not rechecked until another process starts: stop every dev session before restoring or copying over a database. Keep coordination databases on disk during normal operation; use [Development](DEVELOPMENT.md#discard-obsolete-state) for obsolete-state removal.

Paths containing newlines are refused for checkouts and Git directories. Replacing either at the same path changes its identity and can prevent resume. Inspect the reported reason rather than deleting coordination files to bypass it.
