# Work

## Purpose

`work` runs local commands and delegated Pi children in the background while the lead remains available to the user. The shared workflow decides what to delegate and verifies the result; dev owns process execution, observation and outcome delivery.

## Use

Ask the lead to run a command or delegate an assignment. It calls `work` with `action: "process"` or `action: "delegate"`; there is no `/work start`.

A delegation supplies a controller-local `taskId`, focused prompt and `access` (`read-only` or `write`). Give paths, facts and acceptance conditions, not the lead's transcript. This task key is distinct from the durable `workflowTaskId` returned by workspace admission.

A leading `/skill:name` loads the skill natively and selects dispatch as described in [Dispatch](../config/README.md#resolution). Leave `rule`, `model` and `effort` unset for normal delegation; use explicit model/effort overrides only when the user requested them.

Set `coordinate: true` only to delegate a whole phase. The child gets a scoped `work` tool to start and manage leaves; only the coordinator's result returns to the lead.

```text
/work                        list this session's attempts, including leaves and their parent
/work dispatch               inspect configured dispatch rules; not a prerequisite to launch
/work inspect <id>           inspect outcome, logs and tracked artifact changes
/work inspect <id> stdout 0  page output by byte offset; continue with nextOffset
/work inspect <id> stderr 0  page stderr; use result for a child's retained answer
/work stop <id>              cancel an attempt and, for a coordinator, its leaves
/work stop                   cancel all owned attempts, including while the lead is idle
```

Writer attempts show their managed-worktree path as `blocked` while use is unresolved, otherwise `review-required`. Protocol reminders in descriptions and outcomes guide the model; they do not enforce compliance or authorize deletion. [Workspace](workspace.md) owns reservation and release.

## Behavior

### Execution and access

A launch returns an attempt ID once the process exists. A local command runs Bash with the user's permissions in the requested directory, under the lead checkout's writer admission. A delegated writer receives a distinct worktree from the lead's exact current commit: modified, untracked and ignored files are not copied. Its reservation outlives the attempt.

A read-only child loads the same global extensions as a writing child, so it can use every model their providers register. Its tools are an allowlist: inspection tools, plus `work` for a coordinator, with no shell, edit or extension tool, so it cannot reach the network or `gh`. Both `work` tool descriptions state this, so callers put issue, PR or other external text in the prompt or a workspace file. An extension tool that reuses an inspection tool's name is blocked, so the child loses that tool. Every child receives project instructions, Pi's base prompt, profile guidance and its full skill catalog, not the lead's conversation. Writing children use the same [native destination policy](workspace.md#native-writes) as the lead, with controller checks through the file-operation boundary.

Pi expands a verified leading skill invocation once in the first user message, including hidden skills. Unknown or unreadable skills and extension-command collisions fail before a model request. Other commands and prompt templates are not expanded. The attempt records the invoked skill, not every skill the child later reads.

Every child has independent [background compaction](compaction.md).

Command text must follow the [credential rule](../SECURITY.md#credentials). Process separation and read-only tools are not an OS sandbox.

### Coordinators and leaves

Nesting stops at lead, coordinator, leaf. A coordinator starts no local commands and grants no access beyond its own; a read-only coordinator starts only read-only leaves. The lead's controller owns admission, launch, records and cancellation for all attempts. Coordinators can inspect and cancel only their own leaves; leaves cannot delegate.

A read-only leaf reads its coordinator's admitted workspace, including uncommitted files. A writing leaf gets a separate worktree from the lead's commit, without the coordinator's edits.

Leaf outcomes arrive after the coordinator's turn ends and include retained inspection/results. Repeated delivery adds no message. The controller withholds the coordinator's result while a request is pending, a leaf is live or an outcome remains undelivered; an early report is a protocol failure. Unobserved leaf termination is reported as `unknown`.

Aborting a coordinator tool call interrupts its local wait, not an IPC request already sent: the controller may still admit that leaf. Stop the coordinator to cancel its owned work. Cancellation never rolls back performed effects.

### Delivery and verification

Outcomes arrive when the current run settles, or at idle when late. An eligible batch can continue a successful lead run without another user message; workflow checkpoints still apply. Compaction and context edits do not erase delivery acknowledgment. Failed or unconfirmed delivery remains visible in `/work`; retries do not start model calls.

A completed process or child report is not artifact verification. Tracked Git changes are compared for inspection; untracked files and external dependencies are not. Review the real artifact and account for retained workspaces before delivery.

### Cancellation and session changes

Esc during a lead run, `/work stop`, confirmed tree navigation, `/new`, `/resume`, `/fork` and `/quit` stop owned work. Cancelled navigation or replacement previews preserve it. `/reload` closes work but keeps the lead's shells observed. Earlier outcomes stay inspectable and are not replayed into a new branch.

A coordinator's cancellation, failure or exit stops its leaves, including leaves that already reported. Late leaf outcomes are dropped; requests after stop or generation change are refused. Cancellation is complete only as process exit and surviving descendants are observed; it never undoes edits.

### Failures and visibility

A local command that exits normally is `completed`, even with a nonzero exit code. Inspection and outcome delivery retain `exitCode`; completion does not mean a test passed or the command achieved its goal. `failed` indicates an execution failure, such as a process error or unexpected signal termination, or a child that could not return normally because of a provider, launch or protocol failure. Requested interruption remains `cancelled`; unobserved termination remains `unknown`.

Subscription exhaustion from any attempt, including a leaf, blocks new agents and automatic continuation for the rest of the session; another user message does not clear it. Existing commands finish and their outcomes are recorded. A final lead provider or transport failure after Pi retries suspends automatic reactivation until the next user message. Tool, build, test and child failures are not lead-run failures.

The `dev/work` status groups attempt states, active children and child usage with `│`, and items within a group with `·`, so a footer can wrap it at separators ([ADR 0006](adr/0006-global-visual-layer.md)). An active child is titled by the skill it invoked or, without one, by its role: `coordinator`, `reader` or `writer`; the role also covers the moment before the child reports its resources. A leaf is titled `coordinator>leaf` from both titles, and children sharing a title add their task, as in `arena (docs)`. Each shows its model without the provider and its context pressure. Inspection includes parent, invoked skill, tools and observed usage. Usage counts once per attempt, not again in its coordinator, with unavailable values distinct from zero. A deferred workspace gate close appears as `gateReleaseWarning` without changing attempt status; [workspace settlement](workspace.md#process-uses-and-gates) explains its retry boundary.

For global presentation extensions, work emits `dev/work-activity` on Pi's event bus with `{ sessionId, active }` alongside each interactive status update, including session startup and changes while the lead is idle. `active` means at least one delegated child, coordinator or leaf is `running` or `waiting`; local commands and settled attempts do not count. Subscribers filter by session ID and reset on session shutdown. The title extension keeps its spinner while the lead or a child is active, independent of the footer.

## State

| Path                                   | Content                                                                           |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| `<data-home>/work/attempts.sqlite`     | Authoritative persisted attempt facts, with ownership committed alongside payload |
| `<data-home>/work/attempts/<attempt>/` | Temporary full logs                                                               |
| `<data-home>/child-sessions/`          | Child conversations, excluded from lead `--continue` selection                    |

Retention keeps seven days from completion and the newest 64 completed results within that window. Active and unresolved attempts remain. Expired results are unavailable rather than reconstructed from summaries.

Process crashes are recoverable, but power loss can drop recent attempt updates. To back up the store, stop sessions and preserve the database with its WAL and SHM companions. Before opening it, dev checks the supported Node minimum (26.0.0) and an embedded SQLite with the WAL-reset fix; the Node number alone does not establish safety.

Invalid or corrupt storage is refused, not rebuilt from logs. Format changes and obsolete-state removal are contributor operations covered in [Development](DEVELOPMENT.md#discard-obsolete-state).

After a crash, an absent PID supplies no exit code and a present PID proves no identity. Reopening neither restarts work nor kills a recovered PID. An unresolved [workspace use](workspace.md#process-uses-and-gates) can keep the checkout blocked independently of attempt retention.
