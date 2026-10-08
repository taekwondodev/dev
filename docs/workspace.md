# Workspace

## Purpose

The workspace authority coordinates dev conversations and their children on one repository. The uncontended writer keeps its checkout; contending tasks and delegated writers receive isolated managed worktrees. Reservations survive sessions and crashes, while finished workspaces are released at quit and before allocation.

## Use

Terminal commands are read-only unless stated:

```bash
dev workspace                 # list this repository's tasks and workspaces
dev workspace inspect <task>  # inspect the exact task across repositories, including next safe action
dev workspace check <task>    # assess role, target, completion verdict, blockers and evidence
dev workspace release <task>  # confirm, then clear every workspace of the task
```

Session commands mirror them:

```text
/workspace                  also shows the current binding and effective directory
/workspace inspect <task>
/workspace check <task>     treats this conversation's own uses as ending at quit
/workspace release <task>   names the terminal command; releases nothing
```

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

A shell occupies only its checkout until its process group and every tracked descendant are observed gone. While a conversation has a live process, workspace switching or isolation is refused with guidance to wait or stop the process. For work attempts, use `/work stop`; for lead shells, stop the process started through bash. `/work stop` does not stop lead shells. A process that detaches into its own session escapes observation. Lost observation records an `unknown` use, which blocks writers; no explicit recovery command exists yet.

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
| `child-delivered`  | Task PR evidence establishes delivery of a delegated child; its own commits need not survive                 |

These are verdict labels, not manual deletion predicates: use `check` to see the assessment. Ignored files alone do not block completion, but unsafe filesystem structure can still block removal.

Retained reasons include `no-commits`, `not-integrated`, `integration-unknown`, `directory-missing`, live or `unknown` uses, an open conversation binding, and an unfinished earlier release (`release-review`). Whatever the sweep retains, [release](#release) clears. The integration target is a recorded override, otherwise the `origin` GitHub repository and default branch, otherwise the remote HEAD branch.

Before removing a finished workspace, the sweep takes the structure, presence and writer gates and assesses it again; it acts only if the workspace is still finished with valid evidence. A pre-existing checkout loses only its reservation and that reservation's settled (`quiescent`) use records. A managed worktree is removed with `git worktree remove --force`. Gates held by another dev session, a worktree containing a shell, launcher or quitting conversation, and active installation coordination retain it. A removal that does not complete stays `release-review`, refuses resume and is never retried automatically.

The budget is 40 seconds at quit and 20 before allocation, measured from the request. Tasks not started become `task-deferred` for the next sweep. Allocation skips clean pre-existing checkouts and the allocating conversation's workspaces. The receipt appears in the conversation before allocation when it has rows, or prints at quit.

The receipt at quit counts removed worktrees and released reservations with the sweep's elapsed time. Each remaining workspace gets a separate vertical block: a complete `dev workspace release <task>` command and a short English `Status` explaining why automatic cleanup did not happen. It prints no paths, abbreviated IDs or extended Git evidence; `dev workspace check <task>` keeps the full assessment. Failed or deferred assessments get a complete check command instead.

In an interactive terminal, quit offers one `y` to release the remaining eligible tasks, including undelivered or undecidable work. Tasks with active, unknown or abandoned uses, skipped workspaces, or a removal blocked by a cleanup guard stay in a separate section, with their commands and statuses. An excluded workspace excludes its whole task from the shortcut. Before confirmation, quit inspects every reserved workspace of the proposed tasks, including those in other repositories. A reservation not assessed by this sweep, an active or unresolved use, or a failed inspection excludes the whole task. This keeps unassessed siblings out of a task-wide release; the complete manual command remains available. This is a convenience filter, not a new release-authority check or a guarantee against concurrent changes.

The confirmation counts all affected managed worktrees and pre-existing checkout reservations and explains their consequences once: managed contents are deleted, including uncommitted changes and undelivered commits; pre-existing files and commits stay. Enter or any answer other than `y` quits without releasing them, leaving the commands available. In Ghostty (`TERM_PROGRAM=ghostty`), the tab shows sweep progress; successes are green, commands and the choice yellow, statuses dim, and the destructive warning red. `NO_COLOR` turns colors off. Outside Ghostty or without a TTY, the output is plain text without escape sequences; without an interactive terminal there is no release prompt.

Before delivery, the workflow must integrate code and assets, reconcile contributions and publish wanted reports, then record exact publication readback. A failed publication remains in the task checkpoint and stops delivery. A local copy is not a publication. Source-history inclusion proves neither semantic equivalence nor delivery of dirty edits.

### Release

`dev workspace release <task>` clears every reserved workspace of the task, whatever the sweep verdict. It runs only in an interactive terminal: it lists each workspace with its consequence, asks for one `y`, then:

- removes each managed worktree with `git worktree remove --force`, with its Git registration and reservation;
- ends the reservation and use records of each pre-existing checkout; its files and commits stay.

**Everything left in a released managed worktree is discarded, including dirty edits, undelivered commits, caches and forgotten files.** Release checks no completion, evidence or live use, so run it only when nothing still works in those workspaces. There is no `--yes`, and the session command only names the terminal command. The release offered at quit follows the same confirmation.

Release respects a Git lock: a locked worktree fails and stays. When Git confirms that it no longer lists the worktree, release deletes what remains of its directory under dev's worktree root and its admin directory, unless that admin directory now serves a moved worktree. An unreadable Git worktree list permits neither deletion of leftovers nor confirmation of removal. A failed or interrupted removal stays `release-review` and refuses resume; running release again finishes it. If the directory is already gone, the retry preserves the interrupted removal's recorded HEAD as delivery evidence for the task's other workspaces.

External programs are not coordinated. Stop independently started tools and avoid external edits during a removal; the [accepted filesystem race](../SECURITY.md#outside-the-protection) is not closed.

### Quit and interruption

`/quit` stops owned work and shells, closes the attachment, releases installation/source claims, then sweeps uninterruptibly, prints a receipt and offers the [eligible remaining tasks for release](#sweep). Ctrl-C before the sweep releases nothing. During the sweep, an attempt reaches its recorded outcome; a Git step also interrupted by the signal stays `release-review` until `dev workspace release`. Ctrl-C at the release prompt releases nothing; during a confirmed release, each started release reaches its recorded outcome.

SIGHUP after quit can end dev without a receipt; the next sweep reports an interrupted removal as `release-review`. Signals, crashes, startup, turn end and session replacements do not initiate sweeps. If a sweep does not report back, its outcome remains unknown and the launcher points to `dev workspace list`.

### Exit codes

| Code | Meaning                                                                                                                                                                    |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Observation returned; every workspace of a confirmed release ended `released` or `removed`; or quit reached terminal outcomes, counting the tasks released at quit as done |
| 1    | Observation unavailable, a failed or unreported release, nothing reserved to release, unknown sweep outcome or an unfinished sweep removal                                 |
| 2    | Invalid or ambiguous arguments, or missing required interaction                                                                                                            |
| 130  | Cancelled confirmation, or quit interrupted before or during the sweep or its release; an in-flight attempt completes and is reported                                      |

Declining the release offered at quit keeps the sweep's code.

A successful `check` can list blockers. Exit 0 is not permission to remove anything.

## State

The authority lives at `~/Library/Application Support/dev/workspace-authority/`, resolved from the OS account rather than `HOME`, the installation or data home. All installations use the same reservations and gates. Managed worktrees live inside it.

First use creates an absent authority. Missing parts of a known authority, invalid layout or damaged storage are refused; startup does not reset them. Each dev process checks a database file's schema and integrity the first time it opens that file. A file replaced by a new file at the same path is checked again; a file overwritten in place while dev is running is not rechecked until the next dev process, so stop every dev session before restoring or copying over a database. Leave installation/conversation lock databases in `<installation>/.dev/coordination/` during normal operation. Obsolete-state removal is a contributor operation covered in [Development](DEVELOPMENT.md#discard-obsolete-state).

A checkout whose path, or whose Git directory path, contains a newline character is refused. Admission checks physical identity, not just path names. Replacing a checkout or its Git metadata at the same path does not preserve its identity and can make resume fail. Inspect the reported reason rather than deleting coordination files to bypass it.
