# ADR 0004: Authoritative lifecycle and incremental operational storage

Keep one mutable authority for each live attempt and persist ownership with its observations in native SQLite. UI snapshots and stored payloads are projections, not competing lifecycle owners. Transactional ownership avoids record/index drift and whole-store scans without creating a second workflow database.

The [approved follow-up](https://github.com/taekwondodev/dev/issues/16#issuecomment-5743930804) records the storage choice; [implementation evidence](https://github.com/taekwondodev/dev/issues/16#issuecomment-5743959689) and the [upstream comparison](https://github.com/taekwondodev/dev/blob/1c2a4d4e5614735ed8a7daa5ebe7407fc60c1bf3/docs/adr/0004-authoritative-lifecycle-incremental-store.md#upstream-comparison) retain the investigation. Read this record before changing lifecycle ownership, persistence or external-effect recovery.

## Lifecycle authority

Keep result receipt, process exit, descendant termination, cleanup and publication distinct: none certifies the others. Capture root identity before releasing user code, and reject stale callbacks through attempt/generation/revision fences. Unconfirmed termination stays unknown and blocks acquisition or cleanup; retained facts support reconciliation, not automatic restart.

Observation must remain able to see exit while cancellation or admission waits. An attempt-triggered cancellation runs outside its observation loop; otherwise that loop waits for the termination it must itself observe. Coordinator requests use a separate fiber for the same reason. A leaf's parent remains an ownership fact in its record, not a separately writable index.

## Transactional ownership

An Effect-scoped worker commits session ownership, payload, revision and retention together. Ownership must remain trustworthy when payload decoding fails. Filter diagnostics by trusted ownership and fail closed on invalid ownership or layout. Saves use monotonic revisions without recreating pruned attempts.

A recovery log locator may be recorded before admission creates the transient attempt, but is descriptive evidence, not authority to open another session's log. Current ownership checks still govern access.

Database commits cannot certify filesystem or process cleanup. Those are recoverable, idempotent external effects; unfinished cleanup remains evidence rather than a reason to discard it.

## Durability by lifetime

The temporary attempt store uses WAL with `synchronous=NORMAL`, accepting recent-update loss after power failure. Code, credentials and Pi conversations live elsewhere. Check the embedded SQLite for the [WAL-reset fix](https://www.sqlite.org/wal.html#the_wal_reset_bug); Node version ordering alone is insufficient across release lines. [Work](../work.md#state) owns retention and recovery operations.

Workspace reservations, conversation bindings and self-contained use facts outlive attempt retention. The [authority decision](https://github.com/taekwondodev/dev/issues/31#issuecomment-5798717688) gives them repository-sharded SQLite storage with worker I/O, short WAL/FULL transactions, `fullfsync=ON` and synchronized publication before acknowledgment. Missing known storage, non-canonical layouts and corruption fail closed rather than recreating authority. No stored fact authorizes replaying a job or Git effect.

The [durability acceptance](https://github.com/taekwondodev/dev/issues/31#issuecomment-5810802846) permits SQLite's internal `F_FULLFSYNC` to `fsync` fallback instead of a native macOS adapter. Surfaced sync failures still block grants. A lost acknowledgment is uncertainty, not rollback; power failure can lose recent acknowledged ownership facts without every loss being detectable. Configured PRAGMAs and process-crash tests cannot prove power-loss durability.

## Release records

Pre-existing checkout release records the operation and deletes the reservation in one transaction. Managed removal first records intent, then records success only after observing the directory and admin directory gone and the worktree no longer listed. Removed workspace rows remain identity fences; confirmed release receipts preserve HEAD for sibling evidence.

Use deletion follows release authority: sweep deletes only the reservation's settled (`quiescent`) uses, while explicit release deletes all of them because the user asserts nothing remains active. A session can forget a missing lease row only after its execution is settled or released. A missing row for an execution neither settled nor released requires review, as does a row belonging to another workspace or incarnation: storage replacement must not silently release a live process's ownership.

The [disposable-worktree decision](https://github.com/taekwondodev/dev/issues/42) means recorded publications are not an exhaustive list of disposable contents. Their size and digest recheck selected files at each assessment; changed selected bytes stop matching. Runtime storage adds no separate delivery receipt or pending-report ledger: the workflow owns delivery and failed-publication checkpoints.

Incomplete removal leaves an open release, refuses resume and blocks automatic retry. Explicit task release supersedes it and removes again. Git removal and bounded leftover deletion converge, so recovery needs no inventory of what the interrupted attempt deleted. [ADR 0005](0005-scoped-runtime-coordination.md#fenced-effects) owns deletion bounds and fencing; [Workspace](../workspace.md#release) owns the retry procedure.

## Current state only

[AGENTS.md](../../AGENTS.md#boundaries) owns format replacement and discard policy. Obsolete data being disposable does not justify resetting authority at startup: missing or corrupt current facts may still protect live work. Validation is keyed to a process's first open of a file identity rather than every open; [Workspace](../workspace.md#state) explains the resulting restore limitation.
