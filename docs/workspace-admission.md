# Workspace admission

Part of the [workspace guide](workspace.md), which lists the commands; [CONTEXT](../CONTEXT.md#workspace) defines the terms.

## Admission and isolation

Project writes, shells and work launches are admitted before execution. The first writer keeps its checkout. Another task's reservation causes allocation from the exact current commit, without copying modified, untracked or ignored files, unless the lead [continues that paused task](workspace.md#resume-paused-work) instead. Readers share presence with a writer and receive a warning. Independent checkouts and linked worktrees progress concurrently; only dev's structural Git effects serialize across a repository.

A live process prevents switching or isolation until it is stopped or finishes.

A repository with no commits yet has nothing to allocate from, so another task's reservation does not isolate there. When no session is writing the checkout, the next writer takes it, whether it works there or writes into it from another repository: the earlier reservation ends and files stay untouched. While another session writes it, or after an ended one left a write use unsettled, the write is refused and names the [release](workspace-cleanup.md#release) that clears it. Delegated writers are refused until the first commit.

A refused admission returns its reason to the model, which continues the turn, unless it requests a [workspace handoff](../CONTEXT.md#workspace) or requires review. One that requires review ends the turn and is recorded as a [refusal entry](workspace.md#model-visible-messages). A worktree allocation that did not finish is one, and that session admits nothing more: quit it and [release](workspace-cleanup.md#release) the allocation.

Tools need a recorded effect classification. An unknown tool is refused visibly without ending the turn. Resource trust and pre-admission initialization are governed by [SECURITY](../SECURITY.md#trusted-base).

A handoff requested by a tool call ends the turn, as Escape would: the refused call keeps its reason, sibling calls that had not run are cancelled, a notice names the handoff reason, and the conversation switches once the turn settles. After the switch, the follow-up tells the model to re-evaluate the refused operation in the new workspace rather than replay it, and that cancelled calls may be issued again. Queued messages and the editor draft are carried into the new session. [ADR 0005](adr/0005-scoped-runtime-coordination.md#scoped-workspace-operations) records why the run ends.

Tools, `!` commands and new background work are refused with the cause from a switch's request until it settles, and from the point a session replacement closes the current session or attaches its target until it settles. While a replacement is only being prepared, it refuses new switch requests and native write and edit calls, but not other calls. A replacement that Pi cancels before replacing the session leaves any block recorded meanwhile, such as a permission that no longer matches; only a completed replacement lifts it. When dev cannot confirm that a switch or replacement finished, or cannot cancel a requested switch, the conversation stays blocked until quit and refuses further switches and replacements.

### Delegation into another checkout

Use `work delegate` with `cwd` inside the other Git checkout. A writer receives a managed worktree from that checkout's current commit; a read-only child reads the selected checkout directly. [Work](work.md#delegation-scope) describes child instructions and access limits.

Each conversation and selected checkout has one foreign workflow task for the session, created on first use. Inspect it with `dev workspace` in that repository or by its exact task ID. The lead keeps its original binding, so `/workspace` and `set-target` still refer to the lead's task.

Selection refuses a directory outside any Git checkout, inside authority storage or inside a managed worktree, and refuses a replaced or unreadable checkout. A read-only leaf instead uses its coordinator's admitted workspace; this is inherited access, not a new checkout selection.

## Native writes

Lead and writing-child write/edit classify destinations before writer admission:

- Current-workspace files use scoped admission.
- Files inside the bound task's [artifact directory](#task-artifacts) first admit the conversation as writer of its checkout, like a workspace write, then proceed as an external write. Another task's directory, the artifacts root and the rest of the authority stay refused.
- Ordinary external files, including temporary files and configuration, need no extra consent, allowlist, reservation or handoff.
- Another worktree of the bound repository, including its original checkout, is refused with the same file's path in the current workspace, or with a statement that the file does not exist there. The destination is never rewritten.
- Another repository, including a checkout nested in the caller's own managed workspace, is reserved for the conversation's [foreign workflow task](#delegation-into-another-checkout) through that repository's authority and written in place, without a managed worktree or handoff. A checkout reserved or being written by another task is refused with guidance to delegate the change or wait; one with no commits is instead taken or refused as [admission](#admission-and-isolation) does for the conversation's own checkout.
- Git administration, dev authority/coordination metadata and other conversations' managed worktrees remain protected, including canonical aliases.

A writing child follows the same policy: its controller reserves the other repository for the lead conversation. Inside managed storage, native writes require the caller to be an active writer in the containing workspace; [delegation selection](#delegation-into-another-checkout) remains separate. [SECURITY](../SECURITY.md#trusted-base) governs which repository resources load. Refusals state the reason and the next action at the failed call.

Use literal paths without raw `..` or Pi shorthand. An existing destination must be a regular file without hard links; final symlinks, changed destinations and unreadable ancestry are refused. Missing parent directories are allowed only when their existing ancestor can be checked. Duplicate in-flight destinations in one host are refused; distinct destinations can proceed together.

External writes get neither cross-session file locking nor cleanup. Ordinary external files remain outside disposal; [task artifacts](#task-artifacts) have authority-owned cleanup. Read-only children gain no write capability; writing children still require their live controller.

## Task artifacts

Use the task artifact directory for files that must stay outside the commit scope: PR bodies, reports, logs and handoff notes. The `artifacts` action first admits the lead as writer of its checkout, then creates and returns the directory; contention may request a [handoff](#admission-and-isolation) instead. A writing child whose grant carries the task may write there when the lead passes the path in its assignment; children receive no automatic announcement. `/workspace` and `dev workspace inspect <task-id>` show the path while the directory exists.

The directory is retained while the task reserves any workspace across repositories. A [sweep](workspace-cleanup.md#sweep) removes it after the attempt ending the last reservation; quit and replacement sweeps also remove orphan directories within their budget. Explicit [task release](workspace-cleanup.md#release) lists the directory in its confirmation and removes it once no reservations remain.

Removal outcomes appear in receipts and release results. Failed or interrupted artifact deletion can be retried by a later quit or replacement sweep. A link or non-directory entry is left for review with an inspect command; entries not named after a task are left untouched.

## Process uses and gates

A process use ends only when its group and tracked descendants are observed gone, not when a result arrives. Use `/work stop` for attempts; it does not stop lead shells, which must be stopped separately. A process that detaches into its own session can escape observation. Lost observation records an `unknown` use and blocks writers; once its session has ended, only a [release](workspace-cleanup.md#release) clears it.

A command whose checkout was replaced before user code is released never runs. A checkout replaced while a command runs, including by the command itself, does not end observation: stopping the shell still kills its family, and the use ends `unknown` instead of `quiescent`.

A child's use becomes `quiescent` after observed termination or failure before process launch. It stops blocking once no other use, binding or pending switch needs access; its reservation and files remain until release.

A gate-close failure returns a warning and keeps the gate held. Dev retries at the next admission or execution report, and at close at the latest. Another failure warns again. A lost owning use instead fails as `review-required`; it is not a deferred gate close. Installation-source presence remains held for the runtime's lifetime.
