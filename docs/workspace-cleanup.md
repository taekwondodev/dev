# Workspace cleanup

Part of the [workspace guide](workspace.md), which lists the commands; [CONTEXT](../CONTEXT.md#workspace) defines the terms.

## Completion evidence

`check` and sweep derive completion from recorded and observed facts, not declarations that work is done. The target is a recorded override, otherwise the `origin` GitHub repository's default branch, otherwise the remote HEAD branch.

| Finished rule      | Meaning                                                                           |
| ------------------ | --------------------------------------------------------------------------------- |
| `clean-checkout`   | A pre-existing checkout has no completion residue                                 |
| `nothing-left`     | A managed workspace has no remaining work under the completion rules              |
| `branch-merged`    | A bound merged PR's source includes the workspace HEAD                            |
| `branch-in-target` | The workspace HEAD is included in its target                                      |
| `agent-delivered`  | Task PR evidence establishes a child's delivery; its own commits need not survive |

`branch-merged` and `branch-in-target` also require no tracked change and no untracked non-ignored file left in the worktree, except files whose exact bytes were recorded with `record-publication`. These are assessment labels, not manual deletion predicates. Ignored files alone do not block completion, but unsafe filesystem structure can. Nested repositories block automatic removal of the containing managed workspace even when ignored. Retained reasons include `no-commits`, `not-integrated`, `integration-unknown`, `directory-missing`, live or `unknown` uses, open conversation bindings and `release-review`.

Use `record-publication` for selected reports or artifacts already published in an issue or PR: it checks the exact bytes before recording them. A local copy is not a publication. A file in the task artifact directory is recorded under its own root and never counts as workspace residue or evidence for a workspace file. [ADR 0012](adr/0012-workspace-release.md#completion-and-evidence) preserves the constraints behind these assessments.

## Sweep

Automatic sweeps run at quit, at a conversation replacement by `/new` or a copied import, and before managed allocation. Startup, turn end, `/fork`, `/resume`, crash and signal shutdown do not trigger them. Allocation skips clean pre-existing checkouts and the workspaces the allocating conversation is working in.

The replacement sweep runs after the leaving conversation's attachment closes and before the new conversation attaches. Releasing a clean pre-existing checkout lets the new conversation's first write keep it; a modified checkout stays reserved and that write isolates, except [without commits](workspace-admission.md#admission-and-isolation). A sweep failure appears in the receipt without failing the replacement.

A closing sweep lists a worktree allocation that did not finish as an unresolved transition of its task and leaves it for [release](#release).

Each finished workspace gets one fenced removal attempt after reassessment. A pre-existing checkout loses only its reservation and settled use records; a managed worktree is removed. Live gates, occupied worktrees, active installation coordination or changed evidence retain it. Incomplete removal becomes `release-review`, refuses resume and is never retried automatically. Task artifact cleanup follows its [reservation-based lifecycle](workspace-admission.md#task-artifacts).

The budget runs from the request, including queue time; [the sweep implementation](../src/workspace-release.ts) owns its limits. Unstarted tasks become `task-deferred`. Quit and replacement also sweep repositories reached by native writes or selected for delegation during the leaving session, including refused delegations, within the same budget. A repository assessment failure is reported without preventing the others from proceeding; a later sweep can assess it again.

Allocation and replacement receipts appear in the conversation when there are rows; [model-visible messages](workspace.md#model-visible-messages) define what the model reads. At quit, the receipt shows totals and elapsed time, then one line per retained workspace with its complete release command and a short status. Release commands for tasks left out of the offer are marked `Not offered:`. Tasks with a workspace still used by a live session or process are left out: that session's own quit sweeps them. Failed or deferred assessments get a check command instead. Use `dev workspace check <task-id>` for paths and detailed evidence.

## Release

**`dev workspace release <task-id>` discards everything left in all of the task's managed worktrees and in its [artifact directory](workspace-admission.md#task-artifacts), including uncommitted changes and undelivered commits.** Pre-existing checkout files and commits stay; their reservations and use records end. A worktree allocation of the task that did not finish is cleared too: what Git created of the worktree is removed and its pending operation closes. If another task has since taken that path as its checkout, only the operation closes.

The command requires an interactive terminal, lists each workspace and its consequence, then asks for one `y`. There is no `--yes`. It checks no completion, evidence or live use: run it only when nothing still works in those workspaces. It neither waits for uses nor acquires path or installation gates; this is an [explicit user override](adr/0012-workspace-release.md), not a guarded sweep.

A pre-existing checkout no task reserves is never swept, so uses its ended sessions left unsettled keep it `blocked` and settled ones accumulate. **`dev workspace release pre-existing`** handles the repository at `--cwd`: it lists each unreserved pre-existing checkout with recorded uses or a deleted directory, asks for one `y`, then deletes the uses of every ended dev session there. Uses of running sessions stay, as do files and commits; a checkout a task reserves meanwhile fails and names `dev workspace release <task-id>`. A checkout whose directory was deleted outside dev is listed as `review-required` until restored or forgotten: once no running session, pending operation or open conversation refers to it, release forgets it, and dev registers that path afresh if a checkout returns there. It stops no process those sessions started: run it only when nothing they started still works there.

Orb recovery and failed orb starts can settle their session's writer use without confirmation; inspect names which operation made the decision. [Orb recovery](orb.md#recovery) owns settlement conditions and the manual-release cases; [ADR 0012](adr/0012-workspace-release.md) records why this exception is safe.

Release respects explicit Git worktree locks. A failed or interrupted removal stays `release-review`; rerun release to finish it. Leftover directories are deleted only within the [deletion bounds](adr/0012-workspace-release.md#fenced-effects), which require Git to confirm the worktree is no longer registered: an unreadable Git worktree list prevents that deletion. When the directory is already gone, retry retains the interrupted removal's recorded HEAD as sibling delivery evidence.

Stop independently started tools and avoid external edits during removal. The [external-process race](../SECURITY.md#outside-the-protection) remains outside dev's protection.

## Quit and interruption

`/quit` stops owned work and shells, closes the attachment and installation/source claims, then sweeps and prints its receipt.

An interactive quit offers one confirmation to release eligible remaining tasks, including undelivered or undecidable work. The offer excludes a whole task if any reserved workspace is unassessed, skipped, guarded against cleanup, active or unresolved, or cannot be inspected. Excluded tasks remain listed with commands and statuses.

A task excluded only because a previous session left its use unsettled or unresolved is then offered alone, with its status. Tasks guarded against cleanup, unassessed, or with a reserved workspace outside this sweep are never offered: run their command after checking them. These convenience filters are not a guarantee against concurrent use: the [release warning](#release) still applies.

Each prompt is a single line: it counts managed worktrees and pre-existing reservations and explains their consequences. Only `y` releases them; Enter or any other answer keeps them. Interactive terminals show progress and status text; `NO_COLOR` disables text colors without stopping progress updates.

Quick sweeps print only their receipt. Longer sweeps use an animated strip when Pi reports Kitty graphics support and the terminal has room, otherwise a text spinner. Green dots represent removed worktrees; purple branches represent tasks offered for release and turn red on failed or unreported release. Strips are transient progress, not records: they disappear without leaving an image or empty rows, then the receipt or combined release result prints, followed by one line per failed release. Animation timing and layout belong to the [quit presentation implementation](../src/quit-animation.ts). How their frames reach the terminal, and the rules for a new animation, are in [ADR 0008](adr/0008-terminal-held-animation-loops.md).

Set `PI_IMAGE_PROTOCOL=none` to use text progress. Dev also emits progress notifications when supported. Non-TTY output is plain text, without progress escapes or release prompts.

Ctrl-C before the sweep or at a confirmation starts no further release. While a strip is shown, the interrupt notice waits until the strip is deleted. During sweep or confirmed release, started attempts reach recorded outcomes; an interrupted Git step stays `release-review`. SIGHUP can end dev without a receipt. If a sweep does not report back, its outcome is unknown and the launcher points to `dev workspace list`.

## Exit codes

| Code | Meaning                                                                                                                                                                |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Observation returned; every workspace of a confirmed release ended `released` or `removed`; or quit reached terminal outcomes, counting tasks released at quit as done |
| 1    | Observation unavailable, failed or unreported release, nothing reserved or recorded to release, unknown sweep outcome or unfinished sweep removal                      |
| 2    | Invalid or ambiguous arguments, or missing required interaction                                                                                                        |
| 130  | Cancelled confirmation, or interrupted quit/sweep/release; an in-flight attempt completes and is reported                                                              |

Declining quit's release offer keeps the sweep's code. A successful `check` can list blockers: exit 0 is not permission to remove anything.

## State

The account-wide location is in the launcher's [state map](launcher-state.md#state). All installations share that authority, independently of `HOME` and data-home overrides; managed worktrees and task artifact directories live inside it.

First use creates an absent authority. Missing parts of a known authority, invalid layout and damaged storage are refused, not reset. Each process validates a database's schema and integrity on first opening that file identity. In-place overwrites are not rechecked until another process starts, and running sessions keep their database connections and WAL files open: stop every dev session before restoring or copying over a database. Keep coordination databases on disk during normal operation; use [private state maintenance](private-state.md#discard-obsolete-state) for obsolete-state removal.

After an operating-system crash or power loss, inspect `dev workspace check <task-id>` results and `git worktree list` before trusting a release decision. This inspection does not certify that all acknowledged facts survived; see [durability by lifetime](adr/0004-authoritative-lifecycle-incremental-store.md#durability-by-lifetime).

Paths containing newlines are refused for checkouts and Git directories. Replacing either at the same path changes its identity and can prevent resume. Inspect the reported reason rather than deleting coordination files to bypass it.
