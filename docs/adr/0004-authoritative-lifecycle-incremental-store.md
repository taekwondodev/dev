# ADR 0004: Authoritative lifecycle and incremental operational storage

## Lifecycle authority

Each live attempt has one mutable lifecycle authority; persistence records and UI snapshots are projections. Keep result receipt, process exit, descendant termination, cleanup and publication distinct so one observation cannot falsely certify another. Capture root process identity before releasing user code to preserve attribution after a short-lived root exits; reject stale callbacks using attempt identity and generation/revision checks. Unconfirmed termination remains unknown and blocks a new workspace acquisition or cleanup. Retained facts support reconciliation, not automatic work restart.

## Transactional ownership

Use native SQLite in an Effect-scoped worker, committing session ownership, payload, revision and retention facts together. Reject an independently writable record-plus-index design: ownership must remain trustworthy when payload decoding fails, and normal saves and session listings must avoid whole-store payload scans. Filter diagnostics by trusted ownership and fail closed when ownership or the store layout is invalid. Saves use monotonic revisions without recreating pruned attempts.

Process and filesystem cleanup remain recoverable, idempotent external effects. A database commit cannot certify either; retain unfinished cleanup rather than treating an acknowledgement or cleanup failure as grounds to discard evidence.

## Durability

Use WAL with `synchronous=NORMAL` to prioritize performance for temporary operational observations, accepting loss of recent updates after machine power failure. Code, credentials and Pi conversations are outside this store. Check the embedded SQLite version for the [WAL-reset fix](https://www.sqlite.org/wal.html#the_wal_reset_bug); a Node version alone does not establish safety across release lines.

Workspace reservations, conversation bindings and self-contained recovery-use facts have a different lifetime. The [durable authority decision](https://github.com/taekwondodev/dev/issues/31#issuecomment-5798717688) gives WorkspaceLifecycle private repository-sharded records and in-process worker I/O, separate from the temporary attempt store and its log cleanup. Use short transactions with WAL/FULL and `fullfsync=ON`, synchronize publication before acknowledgment, and reject missing, incompatible or damaged stores rather than recreating them. Database facts never authorize automatic replay of Git effects or jobs.

The [accepted durability amendment](https://github.com/taekwondodev/dev/issues/31#issuecomment-5810802846) accepts SQLite's internal `F_FULLFSYNC` to `fsync` fallback without a native macOS adapter. For this personal workflow, observing that narrower failure does not justify the additional native integration. Surfaced storage/sync failures still block grants; a lost acknowledgment is uncertainty, not rollback. Recent acknowledged ownership metadata can be lost after OS/power failure, and not every loss is detectable. A configured PRAGMA or a process-crash test is not proof against power loss.

The [approved follow-up and verification](https://github.com/taekwondodev/dev/issues/16#issuecomment-5743930804) supersede the original JSON-storage constraint. [Implementation evidence](https://github.com/taekwondodev/dev/issues/16#issuecomment-5743959689) and the [historical upstream comparison](https://github.com/taekwondodev/dev/blob/1c2a4d4e5614735ed8a7daa5ebe7407fc60c1bf3/docs/adr/0004-authoritative-lifecycle-incremental-store.md#upstream-comparison) retain the detailed investigation. For retention, supported layouts and recovery operations, read [background work](../background-work.md#retention-and-recovery).
