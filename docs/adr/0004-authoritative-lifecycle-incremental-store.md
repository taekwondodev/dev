# ADR 0004: Authoritative lifecycle and incremental operational storage

## Lifecycle authority

Each live attempt has one mutable lifecycle authority; persistence records and UI snapshots are projections. Keep result receipt, process exit, descendant termination, cleanup and publication distinct so one observation cannot falsely certify another. Capture root process identity before releasing user code to preserve attribution after a short-lived root exits; reject stale callbacks using attempt identity and generation/revision checks. Unconfirmed termination or lease release remains unknown and blocks workspace cleanup. Retained facts support reconciliation, not automatic work restart.

## Transactional ownership

Use native SQLite in an Effect-scoped worker, committing session ownership, payload, revision and retention facts together. Reject an independently writable record-plus-index design: ownership must remain trustworthy when payload decoding fails, and normal saves and session listings must avoid whole-store payload scans. Filter diagnostics by trusted ownership and fail closed when ownership or the store layout is invalid. Saves use monotonic revisions without recreating pruned attempts.

Process and filesystem cleanup remain recoverable, idempotent external effects. A database commit cannot certify either; retain unfinished cleanup rather than treating an acknowledgement or cleanup failure as grounds to discard evidence.

## Durability

Use WAL with `synchronous=NORMAL` to prioritize performance for temporary operational observations, accepting loss of recent updates after machine power failure. Code, credentials and Pi conversations are outside this store. Check the embedded SQLite version for the [WAL-reset fix](https://www.sqlite.org/wal.html#the_wal_reset_bug); a Node version alone does not establish safety across release lines.

The [approved follow-up and verification](https://github.com/taekwondodev/dev/issues/16#issuecomment-5743930804) supersede the original JSON-storage constraint. [Implementation evidence](https://github.com/taekwondodev/dev/issues/16#issuecomment-5743959689) and the [historical upstream comparison](https://github.com/taekwondodev/dev/blob/1c2a4d4e5614735ed8a7daa5ebe7407fc60c1bf3/docs/adr/0004-authoritative-lifecycle-incremental-store.md#upstream-comparison) retain the detailed investigation. For retention, supported layouts and recovery operations, read [background work](../background-work.md#retention-and-recovery).
