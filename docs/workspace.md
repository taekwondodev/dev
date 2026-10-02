# Workspace

## Purpose

The workspace authority lets several dev conversations, and the children they delegate, read and write the same repository without overwriting each other, and removes the worktrees it created once their work is delivered. The uncontended writer keeps its checkout; contention and delegated writers are isolated into managed worktrees; reservations survive conversation changes and crashes; finished worktrees are released at quit and before the next allocation.

## Use

Terminal, read-only unless stated:

```bash
dev workspace                 # tasks and workspaces of the current repository (same as list)
dev workspace inspect <task>  # every workspace of that exact task, across repositories: path, origin, uses, pending operations, next safe action
dev workspace check <task>    # role, target and the verdict the sweep would apply, with blockers and evidence
dev workspace release <task>  # review-required workspaces only: assessment, terminal confirmation, one attempt per workspace
```

Session:

```text
/workspace                  same as `dev workspace list`, marking the current binding and effective directory
/workspace inspect <task>
/workspace check <task>     this conversation's own uses count as ending at quit
/workspace release <task>   another task's review-required workspaces; for this conversation's task it answers that /quit sweeps it
```

`/workspace release` is refused before any confirmation when the conversation is inside, or bound to, a managed worktree of that task; quitting sweeps it once it is finished.

The lead's `workspace` tool: `resume` rebinds the conversation to a retained workspace at the end of the turn, without moving files, and is refused while a shell or work of the conversation is live; `set-target` records an integration target other than the one derived from `origin`; `record-publication` records a report published to an issue or PR after reading it back byte for byte. The tool uploads nothing, fetches no refs and knows no unrecorded selection.

Native Pi commands dev wraps:

- `/resume`, and `/import` of a conversation already in dev's sessions, attach the target before Pi tears the current session down; a refusal cancels them with a notice. A conversation open in another dev session, or whose workspace is gone, is refused this way.
- `/new`, `/fork` and `/import` of a copied conversation attach after teardown, so an authority refusal there ends the session. `/import` of a copy whose working directory is outside any Git checkout is refused before teardown.
- `/fork` starts in the current workspace as a new conversation without the task: its first write is isolated into a new worktree from the current commit, without uncommitted files. Commit before forking to carry them.
- Every replacement is refused with a notice while a workspace switch is pending. All of them stop the leaving session's shells and work.
- `!`, `!!` and the lead's bash run through dev's shell in the conversation's workspace.
- `/quit` runs the sweep. `/reload` keeps shells alive and observed.

## Behavior

- Admission: every lead write, shell, native file write, `work` launch and child write is admitted before it runs. The first writer keeps its checkout; another task's reservation on it allocates a worktree from the exact current commit, copying nothing. Readers share presence with a writer and see a warning. A read-only leaf is admitted as a reader on the workspace of its running coordinator, the only read outside the conversation's own workspace ([work](work.md#behavior)). A tool without a recorded effect classification is refused with a visible reason, without ending the turn. Project extensions and packages under a trusted folder's `.pi/` load under Pi's folder trust ([SECURITY](../SECURITY.md#trusted-base)).
- Shells: a shell occupies only its checkout, until its process group and every tracked descendant are observed gone. While a process of the conversation lives, switching workspace or being isolated into a worktree is refused with guidance to wait or `/work stop`. A process that detaches into its own session escapes observation; a lost observation records an `unknown` use that blocks the checkout for writers until an explicit recovery exists, and none does yet.
- Native writes: the lead's write and edit operations carry their exact destination. Distinct destinations proceed together; a second write to one in flight, raw `..`, Pi's path shorthand, a destination inside a nested repository and an ancestor replaced by a link since authorization are refused.
- Concurrency: separate TUIs on different conversations coexist. A conversation open in another dev session, of any installation, cannot be attached. Independent checkouts and linked worktrees progress independently; only dev's own structural Git effects on one repository serialize.
- Child gate lifetime: once a child's process family is observed gone, or its launch fails before a process starts, dev persists its use as `quiescent` and releases the conversation's gates for that workspace when none of its other uses, current binding or pending transition still needs them. An `unknown` use remains blocking. The lead can stay open; the reservation and files remain until an authorized sweep or release succeeds. Installation-source presence is independent and stays held for that runtime's lifetime.
- Sweep: at quit and before every managed allocation, dev assesses every task of the repository, decides completion from recorded and observed facts, and makes one fenced attempt per finished workspace. Finished rules: `clean-checkout` (a pre-existing checkout without changes, at quit only), `no-residue`, `branch-merged`, `branch-in-target` and `child-delivered`. Retained reasons include `no-commits`, `not-integrated`, `integration-unknown`, `directory-missing`, a live or `unknown` use, an open conversation bound to the workspace and a release ending `unknown` or `review-required`. The target is a recorded override, else the `origin` GitHub slug and default branch, else the remote HEAD branch. The budget is 40 seconds at quit and 20 before an allocation, counted from the request; tasks it cannot start are `task-deferred` to the next sweep. A worktree holding the quitting conversation's file is kept. The receipt prints in the shell at quit and appears in the conversation before an allocation when it has rows.
- Release: `release` proceeds only when some workspace of the task is `review-required`; otherwise it explains and exits 1. It shows assessment and consequences, confirms in an interactive terminal (no `--yes`, no `--force`) and makes one attempt per confirmed workspace under the structure, presence and writer gates, rechecking everything. A pre-existing checkout loses only the reservation. A managed worktree is removed when its verdict is finished, recorded publications still match and no live or uncertain use holds it; everything left inside is discarded, including uncommitted edits, caches and forgotten files. A failing Git command, for example one stopped by a held lock, changed identities, nested repositories and mount crossings block. Running `release` from a shell inside a removable worktree keeps that worktree. A release interrupted before recording its outcome shows as `review-required`, refuses resume, and is observed and closed by the next sweep or explicit release, which then re-assesses; the files it recorded as deleted stay listed. Repeating the command is a fresh request with fresh checks.
- What release does not prove: source-history inclusion is not semantic equivalence and never covers dirty edits. Before release, the workflow delivers code and assets, reconciles agent contributions and publishes the reports it wants kept, recording them with `record-publication`; a failed publication stays in the task checkpoint and stops delivery. A local copy is not a publication.
- Quit: `/quit` stops the session's work and shells, closes the attachment, releases installation and source claims, then sweeps uninterruptibly and prints the receipt. Ctrl-C before the sweep releases nothing; during the sweep it lets each attempt reach its recorded outcome (a Git step it also reached ends `partial`, for an explicit release). SIGHUP after quit ends dev without a receipt; the next sweep observes interrupted attempts. Signals, crashes, launcher start, turn end and session replacements never sweep. A sweep that does not report back leaves its outcome unknown: the launcher says so and points to `inspect`.

### Exit codes

| Code | Meaning                                                                                                                                                        |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | observation returned, or every confirmed release ended `released`, `removed` or `already-absent`; `/quit` with every attempted workspace at a terminal outcome |
| 1    | observation unavailable, release blocked, partial or uncertain, sweep outcome unknown, disposal failure, or nothing to release                                 |
| 2    | invalid or ambiguous arguments, or a required interaction is missing                                                                                           |
| 130  | confirmation cancelled, release interrupted, or `/quit` interrupted before or during the sweep; the attempt in flight completes and is reported                |

A `check` exits 0 even when it lists blockers; its exit is not a permission to remove anything.

## State

The authority lives at `~/Library/Application Support/dev/workspace-authority/` per OS account, resolved from the account rather than `HOME`, the installation or the data home, so compatible installations see the same reservations and gates. Managed worktrees live inside it. Records are repository-sharded SQLite with WAL, `synchronous=FULL` and `fullfsync=ON`. An absent authority is created on first use; a partially present one, a missing shard of a known repository, or a non-canonical or damaged store is refused, never migrated. There is one current schema, validated by its actual layout and identities without schema or protocol version markers. Installation admission and conversation claims are SQLite lock databases in `.dev/coordination/`; leave them on disk during normal operation. Dev never resets the authority itself; after a format change, delete it as described in [DEVELOPMENT](DEVELOPMENT.md#discard-obsolete-state).

Repository, checkout, common Git-directory and Git-admin physical identities are the persistent volume UUID plus the lossless decimal inode. On macOS, each bounded observation resolves all paths in one `/usr/bin/osascript` Foundation call; malformed, missing or changing identity data is a typed refusal, never a path-only or current-device fallback. Numeric `st_dev` is used only inside the same observation to detect mount crossings and filesystem races. Replacing an object at the same path remains a refusal.

## Decisions

[SQLite authority with kernel-lock gates](ARCHITECTURE.md#sqlite-authority-with-kernel-lock-gates) and [disposable worktrees with automatic release](ARCHITECTURE.md#disposable-worktrees-with-automatic-release) in ARCHITECTURE; [ADR 0005](adr/0005-scoped-runtime-coordination.md) for the enduring constraints.

## Verify

`npm run workspace:check`, `npm run workspace:tui` and `npm run workspace:github`; what each covers and their gotchas are in [DEVELOPMENT](DEVELOPMENT.md#verification).
