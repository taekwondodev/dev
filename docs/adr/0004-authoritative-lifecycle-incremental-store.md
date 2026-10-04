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

Reservation-only release of a pre-existing checkout is one transaction recording the operation and deleting the reservation. Managed-worktree removal records intent and effect start before external deletion, then records only observed outcomes: directory, admin directory and worktree-list entry gone. A removed workspace row remains an identity fence; confirmed release rows are compact receipts for inspection. The transaction that deletes a reservation also deletes that reservation's `quiescent` use rows: they carry no ownership once settled, and live or `unknown` uses block the release instead of being pruned. Nothing else deletes a use row, so a running session that finds the row of a use it was granted missing treats that use as settled and forgets its lease. The exception is a lease for an execution that this session has neither settled nor released: its missing row requires review, because only out-of-band replacement of the database can remove it while the process may still run. When releasing gates, a row that exists with another workspace or incarnation also requires review.

The [disposable-worktree decision](https://github.com/taekwondodev/dev/issues/42) means a published-file manifest is not an exhaustive list of disposable contents. Its inode, size, modification time and digest facts recheck selected publications; changed selected bytes stop matching. Runtime storage adds no separate delivery receipt or pending-report ledger: the workflow owns delivery and failed-publication checkpoints.

A crash leaves a started release that refuses resume. The next attempt observes and closes it before proceeding afresh; recorded deleted-file facts survive so partial deletion cannot read as all files present. An empty admin directory left by Git may be removed only with non-recursive `rmdir`, while empty, unlisted, inside the repository's worktrees directory and under release gates, never by broad pruning. [ADR 0005](0005-scoped-runtime-coordination.md#release) owns disposal authorization and fencing.

## Current state only

Dev-owned stores keep one current shape. [AGENTS.md](../../AGENTS.md#boundaries) owns replacement and discard policy, including the distinction between obsolete format support and live ownership/decision fences. Validate current layout and identities even though obsolete data is disposable. A process validates a workspace database's schema and integrity the first time it opens a given file identity, not on every open. Storage never resets itself at startup.
