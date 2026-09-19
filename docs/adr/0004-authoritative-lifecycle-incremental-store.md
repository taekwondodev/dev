# ADR 0004: Authoritative lifecycle and incremental operational storage

Status: accepted implementation contract in the user's follow-up to issue #16.
Implemented and locally verified. Publication and private-data transition are
separate operations; this record does not claim release.

## Context

[ADR 0002](0002-session-owned-background-work.md) owns session-scoped work,
cancellation, leases and recovery. Its ownership contract remains in force.
The user selected runtime performance over implementation convenience and
retained the decision called **1A + 3C incremental** after comparing lifecycle
and storage alternatives. The user requested a final source-level comparison
with Firstmate and pi-subagents before implementation.

The pre-incremental `src/work-store.ts` scanned records on save, list and log-retention
checks. `WorkOwner.list` filtered valid records by session, but forwarded the
store's unavailable-record diagnostics without independent ownership evidence.
These observations motivated the storage change.

## Decision

### 1A: one authoritative mutable lifecycle

Each live attempt has one mutable lifecycle authority. Centralized transitions
apply events and validate their ordering. Persistence records and UI snapshots
are projections of that authority, not independently mutable lifecycle models.

Keep result receipt, main-process exit, descendant termination, resource/lease
cleanup and outcome publication distinct. An observation that cannot establish
cleanup remains unknown. Reject stale callbacks using attempt identity and
generation/revision checks across suspension points. Late progress must not
reverse cancellation or terminal state.

Capture the live root process identity before releasing user code. Process
commands wait on a private descriptor while the controller records PID birth
and group; the wrapper then execs the command without changing PID or standard
input/output semantics. Agent children wait for their existing start message.
This preserves attribution when a short-lived root leaves descendants, without
treating a reused PID as the original process. Failed or unverified lease
release keeps the attempt unknown and its worktree cleanup blocked.

This does not select a lifecycle mailbox. A separate persistence worker, if
used, is an I/O placement decision, not a second lifecycle authority. Across
restart, retained facts support reconciliation rather than authorizing automatic
work restart.

Retain the child request's opaque, nonempty owner-attempt correlation ID. It
does not authorize a store lookup or form a filesystem path. The controller
and store require UUID-shaped attempt IDs at their own boundaries. These
contracts were distinct before the migration; sharing their brand would
silently tighten accepted IPC requests without strengthening a consuming
operation. Session, task and generation IDs share the domain's nonempty brands.

### 3C incremental: authoritative ownership independent of payload

Persist session ownership independently of decoding the operational payload.
Commit ownership and the corresponding record update in one transactional
persistence authority. Do not add an independently writable JSON record plus
an index that must be manually kept in sync.

Ordinary saves touch the changed attempt. Normal listing selects the owning
session without scanning unrelated payloads. Filter by trusted ownership before
surfacing corrupt-record identifiers, paths or errors. If ownership itself is
unavailable, fail closed rather than attributing the record from an untrusted
payload. Validate agreement between persisted identity, ownership and payload.

Full reconciliation or repair can be explicit maintenance operations. Retention
remains global under the existing policy, but its implementation must not
restore a whole-store payload scan on every save or log read. The target does
not promise constant-time listing of an arbitrarily large result set.

## Consequences and implementation gates

- Preserve ADR 0002's session ownership and process cleanup contract, and ADR
  0003's private-data placement. Pi continues to own conversation persistence.
- A database transaction cannot atomically terminate processes or remove log
  directories. Make external cleanup idempotent and recoverable, and preserve
  incomplete cleanup instead of inferring success from a committed record.
- Prove corrupt payload isolation separately from corrupt ownership or a damaged
  database. Independent ownership is not protection against total store damage.
- Verify restart, concurrent store instances, stale updates, cancellation during
  preparation, lease release, retention and private permissions against real
  disposable artifacts before claiming equivalent behavior.
- Compare complete operations at equivalent visibility and durability settings;
  neither an upstream implementation pattern nor a microbenchmark proves an
  application-level performance win.

### Approved engine, durability and transition

After authorizing implementation, the user explicitly selected native
`node:sqlite` in an Effect-scoped worker and raised the Node minimum to 22.23.2.
The worker also checks the bundled SQLite version before enabling WAL: the Node
version alone does not establish that another release line contains the
[WAL-reset fix](https://www.sqlite.org/wal.html#the_wal_reset_bug).
Node 22.23.2 was locally observed with SQLite 3.51.3; Node 24.21.0 and 26.7.0
were observed with SQLite 3.53.4. These are compatibility observations, not a
promise about untested future runtimes.

The selected policy is WAL with `synchronous=NORMAL`, prioritizing runtime
performance for temporary operational observations. An acknowledged transaction
survives ordinary process termination, but the most recent updates can be lost
after a machine power failure. This is not FULL durability. Code, credentials
and Pi conversation files are outside this store.

The authoritative database is `<dev-data-home>/work/attempts.sqlite`. Ownership,
record payload, monotonic revision and retention facts commit together. Only
creation inserts an attempt; stale saves cannot recreate a pruned attempt.
Revisions are monotonic, not necessarily contiguous on disk: a failed save must
not prevent the owner from later persisting a newer set of observed facts.
Log cleanup is a recoverable external effect, not part of an atomic filesystem
transaction. Keep the existing global seven-day and 64-completed-record policy.

Corrupt completed records remain retained but leave the retention candidate
index after validation fails. A database trigger re-enables candidacy when
persisted facts change, including repairs without a revision change. This
avoids repeated whole-payload scans without trusting a stale metadata cache.
The flag and index live inside the same database; neither is another authority.

Validate existing tables, constraints, indexes and triggers against one
canonical schema. A pre-existing empty database is not a fresh store. Fresh
initialization publishes an already initialized private candidate atomically,
without replacing another initializer's database. Concurrent WAL activation
retries only SQLite's busy condition within a bounded deadline.

Apply private permissions after layout validation. A cleanup failure after a
committed transaction does not roll back that commit or justify deleting the
new attempt's logs. Keep its durable cleanup intent for an idempotent retry.

The user selected no automatic legacy import. If legacy `record.json` files
exist, refuse to open the new store and preserve the originals. Require an
explicit offline transition rather than silently ignoring old history, resetting
the database or inferring process cleanup. See
[operations](../background-work.md#retention-and-recovery) for that boundary.
No private data migration or durable supervisor is authorized by this change.

## Local verification

The integrated TypeScript implementation was exercised on Node 26.7.0 and
22.23.2 with disposable SQLite stores and real subprocesses. Checks covered
session-isolated corruption, stale revisions, rollback, retention, concurrent
initialization, interrupted cleanup, private permissions, acknowledged commit
recovery after SIGKILL, worker failure, process descendants, lease failures and
the pre-execution identity gate. SIGKILL recovery is not a machine-power-loss
test. Host callback checks used the real extension with a Pi host stand-in;
the actual SDK launcher probe ran separately without requesting a model turn.

Typechecking, strict Effect diagnostics, Oxlint, smoke, changed-file formatting
and diff checks passed. Standards, Spec and Adversarial review findings were
resolved or explicitly dismissed against the existing contract. Full interactive
TUI use and real model turns were not exercised. The whole-repository formatter
still reports pre-existing issues in `docs/agents/triage-labels.md`,
`docs/project-brief.md` and `docs/references.md`; those files were not changed.

## Upstream comparison

The final check is source inspection, not an upstream runtime or performance
test. Firstmate was inspected at `2bcb88c38921030033a37d67ae4f5d82cea90eb4`;
pi-subagents at `f4918e80b531f1bf9f1d9e847b8f86c9016108f1`.

Firstmate's fleet snapshot captures physical task metadata, checks its
generation after observations and reports unknown when that generation changed.[3]
Its backlog lifecycle uses a recoverable multi-step close protocol rather than
a transaction covering metadata and backlog state.[1]

Its optional Pi supervision path uses an append-only outcome log with separate
cursors and rebuildable caches, not the ordinary local task store.[17]
Keep that distinction: adopting storage and generation-checking lessons does not
adopt a supervisor.

pi-subagents already uses active and session-partitioned terminal indexes for
normal discovery.[4][5][6] Those indexes must not be confused with dev's previous full
rescans. They remain separate from the status payload; in the active-list
corruption path, an ID/path diagnostic can be emitted before payload-dependent
session filtering succeeds.[6]

These findings support generation fencing, explicit unknown outcomes and indexed
normal reads. They do not establish equivalent session-isolation contracts or
justify replacing the accepted transactional ownership boundary with an advisory
index. The decision remains 1A + 3C incremental; comparative upstream latency is
unmeasured.

## Sources

[1] https://github.com/kunchenguid/firstmate/blob/2bcb88c38921030033a37d67ae4f5d82cea90eb4/bin/fm-backlog-transition-lib.sh
[3] https://github.com/kunchenguid/firstmate/blob/2bcb88c38921030033a37d67ae4f5d82cea90eb4/bin/fm-fleet-snapshot.sh
[4] https://github.com/nicobailon/pi-subagents/blob/f4918e80b531f1bf9f1d9e847b8f86c9016108f1/src/runs/background/active-run-index.ts
[5] https://github.com/nicobailon/pi-subagents/blob/f4918e80b531f1bf9f1d9e847b8f86c9016108f1/src/runs/background/terminal-run-index.ts
[6] https://github.com/nicobailon/pi-subagents/blob/f4918e80b531f1bf9f1d9e847b8f86c9016108f1/src/runs/background/async-status.ts
[17] https://github.com/kunchenguid/firstmate/blob/2bcb88c38921030033a37d67ae4f5d82cea90eb4/bin/fm-branch-outcome.sh
