# ADR 0005: Scoped admission for concurrent dev sessions

Status: accepted for issue [#18](https://github.com/taekwondodev/dev/issues/18). Local evidence and compatibility limits are recorded below; this does not claim release-wide acceptance.

## Context

The previous installation-wide `runtime.lock` prevented a second dev process even when its conversation belonged to another repository. ADR 0004 requires one lifecycle authority per background attempt, not one Pi process for the whole installation. The primary workload is independent sessions on different repositories. Their conversations and session-specific work must not share a mutable owner.

## Decision

Use native SQLite rollback-journal transactions as process-lifetime admission locks. The installation database lives in checkout-local `.dev/coordination/installation.sqlite`, independent of any data-home override. Runtimes hold shared admission for their lifetime; setup, update and rollback hold exclusive admission through their operation. Conversation locks live in separate databases under `.dev/coordination/conversations/`, keyed by the canonical file path and by the Pi session ID scoped to the canonical data home. Hold both claims until a confirmed navigation or runtime disposal. Keep published databases in place: unlinking one could split owners across inodes.

The launcher claims explicit and recent resume paths before Pi opens them. Pi's installed read-only recent-session helper selects the newest file by filesystem mtime, filtered by the header cwd, without parsing every conversation body. The session guard claims native replacement targets before Pi switches, then releases unused provisional claims after success, cancellation or failure. Only confirmed shutdown closes session-owned background work. Existing writer-worktree leases remain unchanged and are not an OS sandbox.

A separate database for each conversation eliminates contention among independent conversations. The installation barrier serializes only maintenance versus runtimes. This is the concrete application of Separate Before Serializing Shared State; a global process mutex would optimize the wrong workload. No model request, tool definition, prompt text or automatic retry was added for coordination.

## Compatibility and limits

This version depends on the installed `@earendil-works/pi-coding-agent` internal `dist/core/session-manager.js` export `findMostRecentSession`, not a documented top-level API. Verify it on Pi upgrades; if absent, startup fails rather than silently scanning full session histories. The local check exercised Pi 0.87.1 on Node 26.7.0 and the coordination and recent-session paths on Node 22.23.2. The Node minimum remains 22.23.2.

This implementation does not read, interpret or delete the former `runtime.lock` PID file. No dev runtime using that old protocol is in use; concurrent old revisions and independent dev installations that bypass the new protocol are not supported. By separate user authorization, the checkout-local obsolete PID file and work store were removed offline; this is not a startup migration and conversations were not deleted. Hard-linked conversation files and malformed coordination layouts fail closed. Process death releases SQLite kernel locks, but power-loss durability of other stores and hostile programs bypassing the protocol are not covered. Filesystem permissions protect the coordination layout against other users, not against the same account.

## Local evidence and remaining limits

On disposable data homes, two actual launcher TUIs remained usable on different repositories, competing resume/continue failed, one `/quit` left the other responsive, and setup/update/rollback were refused while either was active. SDK navigation and subprocess proofs covered cancellation, claims, SIGKILL release and concurrent independent startup without model turns. A focused comparison of `--continue` with native Pi selection showed cwd and mtime selection even when conversation activity timestamps disagreed, and a busy target was refused before opening. Separate disposable checks showed that a failed identity claim releases its provisional file claim, obsolete PID files remain untouched even if malformed, an invalid coordination database is preserved and rejected, and file and directory permissions are private.

One local Node 26.7.0 timing sample of in-process admission plus release, not whole startup, recorded median 0.609 ms uncontended (31 samples, including first use), 0.547 ms for an independent target alongside an owner (30 samples), and 0.335 ms for a conflicting target (30 samples). Maximums were 10.610, 2.657 and 1.133 ms respectively. These figures do not measure subscription allowance, prompt-cache behavior, paid requests or whole-task throughput. No power-loss test or paid-model experiment was run.
