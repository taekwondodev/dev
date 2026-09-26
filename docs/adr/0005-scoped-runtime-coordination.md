# ADR 0005: Scoped admission for concurrent dev sessions

Use separate SQLite rollback-journal lock databases for installation admission and individual conversations, rather than a global runtime mutex or filesystem owner registrations. Independent conversations can then proceed concurrently, while process death releases kernel locks without a PID registry or stale-owner transfer. Keep published databases in place: unlinking them could split owners across inodes.

Runtimes hold shared installation admission; setup, update and rollback hold it exclusively. Keep this barrier in checkout-local `.dev/coordination/`, independent of data-home overrides, so maintenance cannot overlook an active runtime. A conversation requires both its canonical file claim and its Pi session-ID claim within the canonical data home. Reject hard-linked files and malformed coordination layouts rather than weakening that identity boundary.

Claim resume and replacement targets before Pi opens them; release unused provisional claims after success, cancellation or failure without losing the current owner. Recent-session discovery uses Pi's internal read-only `findMostRecentSession` export to preserve native cwd/mtime selection without scanning full histories. Verify this dependency on Pi upgrades; absence fails startup rather than selecting a different algorithm.

This protocol coordinates cooperating runtimes in one installation, not old revisions or external programs. It does not widen writer-worktree leases into an OS sandbox or establish power-loss durability for other stores.

The [accepted specification](https://github.com/taekwondodev/dev/issues/18) records the alternatives and scope; the [implementation report](https://github.com/taekwondodev/dev/issues/18#issuecomment-5784903898) retains measurements and verification limits. For maintenance operations, read [terminal commands](../COMMANDS-TERMINAL.md#manutenzione-dalla-cartella-di-installazione).
