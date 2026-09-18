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

`work-extension.mjs` owns Pi events, tools, commands and idle-boundary delivery.
`work-controller.mjs` owns launch, attempt identity, observed process lifecycle,
writer leases and interruption. `work-store.mjs` owns bounded operational facts
and temporary logs. `work-dispatch.mjs` validates configuration without deciding
natural-language rules. `work-protocol.mjs` parses child observations at the IPC
boundary. `pi-child.mjs` owns the native child session.

Keep full conversation files outside transient result retention and outside the
lead session directory. One producer owns each transcript, and one controller
owns each attempt record. This applies Separate Before Serializing Shared State:
there is no shared status file that children overwrite. Writer leases cover the
remaining shared invariant, exclusive use of a worktree by this data home.

A generation change suppresses delivery before cancellation. Observe termination
rather than treating successful signalling as completion. Retained facts after a
crash neither authorize restart nor certify a PID. Artifact fingerprints report
changes or uncertainty; they are not acceptance evidence by themselves.

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
