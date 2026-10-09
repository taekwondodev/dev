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

A launch returns an attempt ID once the process exists. A local command runs Bash with the user's permissions under the lead checkout's writer admission.

Every child receives its working project's instructions, Pi's base prompt, profile guidance and its full skill catalog, not the lead's conversation. Read-only children have inspection tools, plus `work` for coordinators, but no shell, edit, network or `gh` tool. Put issue, PR or other external text in the prompt or a workspace file. An extension tool reusing an inspection tool's name is blocked, so the child loses that tool. Writing children follow the lead's [native destination policy](workspace.md#native-writes).

The [security model](../SECURITY.md#outside-the-protection) explains why the allowlist does not sandbox trusted extensions or external agent providers.

Pi expands a verified leading skill invocation once in the first user message, including hidden skills. Unknown or unreadable skills and extension-command collisions fail before a model request. Other commands and prompt templates are not expanded. The attempt records the invoked skill, not every skill the child later reads.

Every child has independent [background compaction](compaction.md).

Command text must follow the [credential rule](../SECURITY.md#credentials). Process separation and read-only tools are not an OS sandbox.

### Delegation scope

A delegated writer receives a distinct managed worktree from the source checkout's exact current commit. Modified, untracked and ignored files are not copied. `worktree.path` records the allocation, whose reservation outlives the attempt.

For `delegate`, `cwd` can select another Git checkout. The child follows that repository's project instructions, skills and delivery policy; a read-only child reads the selected checkout directly. The lead stays bound to its original repository and can read and inspect the result, but its native writes there remain refused. See [workspace selection](workspace.md#delegation-into-another-checkout) for admission and task identity.

`process` commands keep `cwd` inside the bound workspace. Leaves cannot select a `cwd`, and a coordinator delegated into another checkout can start only read-only leaves there.

### Coordinators and leaves

Nesting stops at lead, coordinator, leaf. A coordinator starts no local commands and grants no access beyond its own; a read-only coordinator starts only read-only leaves. The lead's controller owns admission, launch, records and cancellation for all attempts. Coordinators can inspect and cancel only their own leaves; leaves cannot delegate.

A read-only leaf reads its coordinator's admitted workspace, including uncommitted files. A writing leaf gets a separate worktree from the lead's commit, without the coordinator's edits.

Leaf outcomes arrive after the coordinator's turn ends and include retained inspection/results. Repeated delivery adds no message. The controller withholds the coordinator's result while a request is pending, a leaf is live or an outcome remains undelivered; an early report is a protocol failure. Unobserved leaf termination is reported as `unknown`.

Aborting a coordinator tool call interrupts its local wait, not an IPC request already sent: the controller may still admit that leaf. Stop the coordinator to cancel its owned work. Cancellation never rolls back performed effects.

### Delivery and verification

While background work runs, the lead and coordinators may do independent work. When only waiting remains, end the turn and let outcome delivery resume it. Do not use `sleep`, wait loops or repeated `list`/`inspect` calls just to await completion. This applies to commands and all delegated work, including reviews; inspection remains available for diagnosis or a requested progress check. While the lead owns running or waiting work, dev refuses a lead `bash` call whose command only waits: `sleep`, optionally joined with `echo`, `printf`, `true` or `:`. A `sleep` combined with any other command, inside a loop, or without owned work still runs. Coordinators keep only the written rule.

Outcomes arrive when the current run settles, or at idle when late. An eligible batch can continue a successful lead run without another user message; workflow checkpoints still apply. Compaction and context edits do not erase delivery acknowledgment. Failed or unconfirmed delivery remains visible in `/work`; retries do not start model calls.

A completed process or child report is not artifact verification. Tracked Git changes are compared for inspection; untracked files and external dependencies are not. Review the real artifact and account for retained workspaces before delivery.

### Cancellation and session changes

Esc during a lead run, `/work stop`, confirmed tree navigation, `/new`, `/resume`, `/fork` and `/quit` stop owned work. Cancelled navigation or replacement previews preserve it. `/reload` closes work but keeps the lead's shells observed. Earlier outcomes stay inspectable and are not replayed into a new branch.

A coordinator's cancellation, failure or exit stops its leaves, including leaves that already reported. Late leaf outcomes are dropped; requests after stop or generation change are refused. Cancellation is complete only as process exit and surviving descendants are observed; it never undoes edits.

### Failures and visibility

A local command that exits normally is `completed`, even with a nonzero exit code. Inspection and outcome delivery retain `exitCode`; completion does not mean a test passed or the command achieved its goal. `failed` indicates an execution failure, such as a process error or unexpected signal termination, or a child that could not return normally because of a provider, launch or protocol failure. Requested interruption remains `cancelled`; unobserved termination remains `unknown`.

Subscription exhaustion from any attempt, including a leaf, blocks new agents and automatic continuation for the rest of the session; another user message does not clear it. Existing commands finish and their outcomes are recorded. A final lead provider or transport failure after Pi retries suspends automatic reactivation until the next user message. Tool, build, test and child failures are not lead-run failures.

### Status and inspection

The `dev/work` status shows attempt states, active children and usage. Children are titled by invoked skill or by role (`coordinator`, `reader`, `writer`); leaves show `coordinator>leaf`, and repeated titles add the task key. Each shows its model and context pressure. Inspection includes parent, skill, tools and observed usage. Usage counts once per attempt, not again in its coordinator; unavailable values are distinct from zero.

Global extensions own presentation, including title activity while a child runs and the lead is idle. See [ADR 0006](adr/0006-global-visual-layer.md) for the presentation boundary and status-text contract. A deferred gate close appears as `gateReleaseWarning` without changing attempt status; [workspace settlement](workspace.md#process-uses-and-gates) explains the retry boundary.

## State

| Path                                   | Content                                                                           |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| `<data-home>/work/attempts.sqlite`     | Authoritative persisted attempt facts, with ownership committed alongside payload |
| `<data-home>/work/attempts/<attempt>/` | Temporary full logs                                                               |
| `<data-home>/child-sessions/`          | Child conversations, excluded from lead `--continue` selection                    |

Retention keeps seven days from completion and the newest 64 completed results within that window. Active and unresolved attempts remain. Expired results are unavailable rather than reconstructed from summaries.

Process crashes are recoverable, but power loss can drop recent attempt updates. To back up the store, stop sessions and preserve the database with its WAL and SHM companions. Before opening it, dev checks the Node minimum in `package.json` and an embedded SQLite with the [WAL-reset fix](https://www.sqlite.org/wal.html#the_wal_reset_bug); the Node number alone does not establish safety.

Invalid or corrupt storage is refused, not rebuilt from logs. Format changes and obsolete-state removal are contributor operations covered in [Development](DEVELOPMENT.md#discard-obsolete-state).

After a crash, an absent PID supplies no exit code and a present PID proves no identity. Reopening neither restarts work nor kills a recovered PID. An unresolved [workspace use](workspace.md#process-uses-and-gates) can keep the checkout blocked independently of attempt retention.
