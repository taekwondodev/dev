# ADR 0002: Session-owned background work with separate Pi children

Status: accepted by the approved [issue #12 specification](https://github.com/taekwondodev/dev/issues/12).

## Context

The lead must remain steerable while commands and delegated assignments run.
A smaller prompt or tool set can weaken a child even with the same model.
The approved comparison considered SDK child sessions within the lead process
and one separate Pi process per attempt. Firstmate's ordinary dispatch supplies
a configuration pattern, not a fleet or a result-delivery protocol to import.

## Decision

Use the installed Pi SDK inside a separate Node process for each delegated
attempt. The launch adapter composes native resources and a fresh conversation;
the parent sends a focused assignment over IPC. Read-only children have an
inspection-only tool boundary; writers require a distinct verified linked
worktree. Neither mechanism is an OS sandbox.

`work-extension.ts` owns Pi events, tools, commands and outcome delivery at
`agent_before_settle`, with idle delivery for late outcomes.
`work-controller.ts` owns launch, attempt identity, observed process lifecycle,
writer leases and interruption. `work-store.ts` owns bounded operational facts
and temporary logs. `work-dispatch.ts` validates configuration without deciding
natural-language rules. `work-protocol.ts` parses child observations at the IPC
boundary. `pi-child.ts` owns the native child session.

Keep full conversation files outside transient result retention and outside the
lead session directory. One producer owns each transcript, and one controller
owns each attempt record. This applies Separate Before Serializing Shared State:
there is no shared status file that children overwrite. Writer leases cover the
remaining shared invariant, exclusive use of a worktree by this data home.

A generation change suppresses delivery before cancellation. Observe termination
rather than treating successful signalling as completion. Retained facts after a
crash neither authorize restart nor certify a PID. Artifact fingerprints report
changes or uncertainty; they are not acceptance evidence by themselves.

Issue [#24](https://github.com/taekwondodev/dev/issues/24) keeps one controller
alive for the conversation. Confirmed tree navigation rotates its generation
and cancels previous work; a cancelled or failed navigation does neither.
Only confirmed session shutdown/replacement closes the controller permanently.
Generation invalidation does not reset quota or the adapter's reactivation gate.

Pi's raw active-branch entries acknowledge outcome registration, independently
of compaction and context edits. Boundary drafts are not receipts. The transient
inbox schedules delivery; it is not a second delivery database. A final lead-run
error after native recovery suspends dev-originated automatic continuation until
new user input, without stopping existing work or passive outcome registration.
This does not veto other extensions or bypass quota and workflow checkpoints.

## Consequences

Laziness Protocol keeps the integration to one Pi adapter and local processes,
without a plugin platform, supervisor conversation or duplicate workflow store.
Shared dev-cycle owns orchestration policy, checkpoints and recovery.

A separate process protects the lead's event loop and gives lifecycle ownership
a concrete boundary. It does not prove better answers or comprehensive cleanup
of arbitrary daemonized descendants. Prove It Works therefore keeps inspected
API compatibility, observed operations and unobserved daily-use behavior separate.

The initial adapter is POSIX-only. Other harnesses and broader isolation require
separate decisions. See [background work](../background-work.md) for operations,
dispatch defaults, recovery limits and retention boundaries.
