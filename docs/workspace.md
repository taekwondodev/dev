# Workspace

## Purpose

The workspace authority coordinates dev conversations and their children on one repository. The uncontended writer keeps its checkout; contending tasks and delegated writers receive isolated managed worktrees. Reservations survive sessions and crashes, while finished workspaces are released at quit and before allocation.

## Use

Terminal commands are read-only unless stated:

```bash
dev workspace                 # list this repository's tasks and workspaces
dev workspace inspect <task>  # inspect the exact task across repositories, including next safe action
dev workspace check <task>    # assess role, target, completion verdict, blockers and evidence
dev workspace release <task>  # confirm one release attempt for review-required workspaces
```

Session commands mirror them:

```text
/workspace                  also shows the current binding and effective directory
/workspace inspect <task>
/workspace check <task>     treats this conversation's own uses as ending at quit
/workspace release <task>   for another task; the current task is swept at /quit
```

Release is refused before confirmation when the conversation is inside, or bound to, a managed worktree of that task. Quit closes that use before sweeping.

The lead's `workspace` tool has three actions:

| Action               | Effect                                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `resume`             | Rebind to a retained workspace at turn end without moving files; refused while the conversation has live shells or work |
| `set-target`         | Record an integration target overriding the one derived from `origin`                                                   |
| `record-publication` | Verify byte-for-byte readback of an already published issue/PR artifact, then record the evidence                       |

The tool uploads nothing, fetches no refs and cannot infer an unrecorded artifact selection.

## Behavior

### Admission and isolation

Project writes, shells and work launches are admitted before execution. The first writer keeps its checkout. Another task's reservation causes allocation from the exact current commit, without copying modified, untracked or ignored files. Readers share presence with a writer and receive a warning.

Independent checkouts and linked worktrees progress concurrently. Only dev's structural Git effects serialize across a repository. Separate conversations can coexist, but the same conversation cannot attach in another dev session, even from another installation.

Tools need a recorded effect classification; an unknown tool is refused visibly without ending the turn. Trusted project resources load under [Pi folder trust](../SECURITY.md#trusted-base). A read-only leaf is admitted on its running coordinator's workspace, the sole read outside the conversation's own binding ([work](work.md#coordinators-and-leaves)).

### Native writes

Lead and writing-child write/edit classify destinations before writer admission:

- Current-workspace files retain scoped admission.
- Ordinary external files, including temporary files and configuration, need no extra consent, allowlist, reservation or rebind.
- Another checkout, including nested or linked checkouts, must be selected and admitted first.
- Git administration and dev authority/coordination metadata remain protected, including canonical aliases.

Use literal paths without raw `..` or Pi shorthand. Final symlinks, hard links, changed destinations and unreadable ancestry are refused. Missing parent directories are allowed only when their existing ancestor can be checked. Distinct destinations can proceed together; duplicate in-flight destinations in one host are refused.

External permits provide no cross-session file locking or cleanup ownership. Workspace disposal never removes external files. Writing children still require their live controller; read-only children gain no write capability.

### Process uses and gates

A shell occupies only its checkout until its process group and every tracked descendant are observed gone. While a conversation has a live process, workspace switching or isolation is refused with guidance to wait or stop work. A process that detaches into its own session escapes observation. Lost observation records an `unknown` use, which blocks writers; no explicit recovery command exists yet.

A child's use becomes `quiescent` when its process family is observed gone, or launch fails before a process starts. Once no other use, binding or pending switch needs access, that child no longer blocks the workspace. Its reservation and files remain retained until release.

A gate-close failure is deferred: the report succeeds with a warning, the gate remains held, and the lead retries at its next admission or execution report and at close at the latest. Another failed retry is warned on that report. A lost owning use is different: it fails as `review-required`, not a deferred close. Installation-source presence remains held for the runtime's lifetime.

### Session commands

- `/resume` and imports of conversations already in dev's sessions attach the target before Pi tears down the current session. Refusal leaves a notice and preserves the current session.
- `/new`, `/fork` and imports of copied conversations attach after teardown, so an authority refusal ends the session. A copied conversation outside any Git checkout is refused before teardown.
- A fork begins in the current workspace as a new conversation without the original task. Its first write isolates from the current commit; commit changes before forking to carry them.
- All replacements are refused while a workspace switch is pending. Confirmed replacements stop the leaving session's shells and work; `/reload` keeps shells observed.
- `!`, `!!` and lead bash use dev's shell in the conversation's workspace.

### Sweep

At quit and before managed allocation, dev assesses every task of the repository and makes one fenced attempt per finished workspace. Completion comes from recorded and observed facts, not declarations that work is done.

| Finished rule      | Meaning                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| `clean-checkout`   | A pre-existing checkout with no completion residue, at quit only; release removes the reservation, not files |
| `no-residue`       | A managed workspace has no remaining work under the completion rules                                         |
| `branch-merged`    | A bound merged PR's source includes the workspace HEAD                                                       |
| `branch-in-target` | The workspace HEAD is included in its target                                                                 |
| `child-delivered`  | Task PR evidence establishes delivery of a delegated child's committed work                                  |

These are verdict labels, not manual deletion predicates: use `check` to see the assessment. Ignored files alone do not block completion, but unsafe filesystem structure can still block removal.

Retained reasons include `no-commits`, `not-integrated`, `integration-unknown`, `directory-missing`, live or `unknown` uses, an open conversation binding, and an uncertain prior release. The integration target is a recorded override, otherwise the `origin` GitHub repository and default branch, otherwise the remote HEAD branch.

The budget is 40 seconds at quit and 20 before allocation, measured from the request. Tasks not started become `task-deferred` for the next sweep. Allocation skips clean pre-existing checkouts and the allocating conversation's workspaces. A worktree containing the quitting conversation's file is retained. The receipt prints at quit, or appears in the conversation before allocation when it has rows.

### Release

Explicit release proceeds only when a task has a `review-required` workspace; otherwise it explains and exits 1. It shows the assessment and consequences, requires an interactive terminal confirmation and makes one attempt per confirmed workspace. There is no `--yes` or `--force` bypass.

Every release rechecks evidence under structure, presence and writer gates. A pre-existing checkout loses only its reservation and that reservation's settled (`quiescent`) use records. A managed worktree is removed only when completion and recorded publications still match and no live or uncertain use holds it. **Everything left in a released managed worktree is discarded, including dirty edits, caches and forgotten files.**

Changed identities, nested repositories, mount crossings and failed Git commands, including held locks, block removal. Running release inside a removable worktree retains it. An interrupted release is retained for review and refuses resume until the next sweep or explicit release observes and closes the attempt before reassessment. Files already recorded as deleted remain listed. Repeating release is a fresh request with fresh checks.

Before delivery, the workflow must integrate code and assets, reconcile contributions and publish wanted reports, then record exact publication readback. A failed publication remains in the task checkpoint and stops delivery. A local copy is not a publication. Source-history inclusion proves neither semantic equivalence nor delivery of dirty edits.

External programs are not coordinated. Stop independently started tools and avoid external edits during release; the [accepted filesystem race](../SECURITY.md#outside-the-protection) is not closed by these gates.

### Quit and interruption

`/quit` stops owned work and shells, closes the attachment, releases installation/source claims, then sweeps uninterruptibly and prints a receipt. Ctrl-C before the sweep releases nothing. During the sweep, an attempt reaches its recorded outcome; a Git step also interrupted by the signal ends `partial` for explicit release.

SIGHUP after quit can end dev without a receipt; the next sweep observes interrupted attempts. Signals, crashes, startup, turn end and session replacements do not initiate sweeps. If a sweep does not report back, its outcome remains unknown and the launcher points to `inspect`.

### Exit codes

| Code | Meaning                                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Observation returned; all confirmed releases ended `released`, `removed` or `already-absent`; or quit reached terminal outcomes for every attempted workspace |
| 1    | Observation unavailable, blocked/partial/uncertain release, unknown sweep outcome, disposal failure or nothing to release                                     |
| 2    | Invalid or ambiguous arguments, or missing required interaction                                                                                               |
| 130  | Cancelled confirmation, interrupted release, or quit interrupted before/during the sweep; an in-flight attempt completes and is reported                      |

A successful `check` can list blockers. Exit 0 is not permission to remove anything.

## State

The authority lives at `~/Library/Application Support/dev/workspace-authority/`, resolved from the OS account rather than `HOME`, the installation or data home. All installations use the same reservations and gates. Managed worktrees live inside it.

First use creates an absent authority. Missing parts of a known authority, invalid layout or damaged storage are refused; startup does not reset them. Each dev process checks a database file's schema and integrity the first time it opens that file. A file replaced by a new file at the same path is checked again; a file overwritten in place while dev is running is not rechecked until the next dev process, so stop every dev session before restoring or copying over a database. Leave installation/conversation lock databases in `<installation>/.dev/coordination/` during normal operation. Obsolete-state removal is a contributor operation covered in [Development](DEVELOPMENT.md#discard-obsolete-state).

A checkout whose path, or whose Git directory path, contains a newline character is refused. Admission checks physical identity, not just path names. Replacing a checkout or its Git metadata at the same path does not preserve its identity and can make resume fail. Inspect the reported reason rather than deleting coordination files to bypass it.
