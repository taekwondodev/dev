# Work

## Purpose

`work` runs local commands and delegated Pi children in the background while the lead remains available to the user. The shared workflow decides what to delegate and verifies the result; dev owns process execution, observation and outcome delivery.

## Use

Ask the lead to run a command or delegate an assignment. It calls `work` with `action: "process"` or `action: "delegate"`; there is no `/work start`.

A delegation supplies a controller-local `taskId`, focused prompt and `access` (`read-only` or `write`). This task key is distinct from the durable `workflowTaskId` returned by workspace admission.

`skill` names the skill the child loads first and selects [dispatch](../config/README.md#resolution). Without the field, a leading `/skill:name` has the same effect; with the field set, the prompt is passed as written. Explicit overrides follow the [dispatch rules](../config/README.md#resolution).

With `coordinate: true`, the child gets a scoped `work` tool to start and manage leaves; only the coordinator's result returns to the lead.

```text
/work                        list this session's attempts, including leaves and their parent
/work dispatch               inspect configured dispatch rules; not a prerequisite to launch
/work inspect <id>           inspect an attempt's metadata, stale-artifact status and readable streams
/work inspect <id> stdout 0  page output by byte offset; continue with nextOffset until it is null
/work inspect <id> stderr 0  page stderr; use result for a child's retained answer
/work stop <id>              cancel an attempt and, for a coordinator, its leaves
/work stop                   cancel all owned attempts, including while the lead is idle
```

The model reads [compact results](#model-visible-results); use `inspect` for an attempt's metadata, or select a stream to page its output. In codemode, `tools.work(...)` returns the structured result, including the complete record on inspection; use `describeTool('work')` for its current declaration.

Writer attempts show their managed-worktree path as `blocked` while use is unresolved, otherwise `review-required`. Neither status authorizes deletion. [Workspace](workspace.md) owns reservation and release.

## Behavior

### Execution and access

A launch returns an attempt ID once the process exists. A local command runs Bash with the user's permissions under the lead checkout's writer admission. Under `dev --orb` the command runs on the [orb](orb.md#tools) inside the session's directory, and its logs merge standard error into standard output. Delegated agents stay inside the orb's checkout: a writing child runs on [its own orb](orb.md#writing-children), and a read-only agent reads over SSH the orb that holds its workspace.

Every child receives its working project's instructions, Pi's base prompt and profile guidance, not the lead's conversation. Its skill catalog lists only the skill named by `skill` and skills named in the assignment prompt. Name any additional skills the child should see in that catalog; this filter does not restrict file access. Read-only children have inspection tools, `read_url`, `codemode` and `work` for coordinators, but no shell, edit or `gh` tool. Put issue, PR or other external text in the prompt or a workspace file. An extension tool reusing an inspection tool's name is blocked, so the child loses that tool; under `dev --orb` the orb's own tools are the exception. Writing children follow the lead's [native destination policy](workspace.md#native-writes).

Children can [read URLs](web-read.md) directly or through codemode, including authenticated pages. Scripts retain the child's tool permissions and have no model catalog; see [codemode's trust boundary](../SECURITY.md#trusted-base).

The [security model](../SECURITY.md#outside-the-protection) explains why the allowlist does not sandbox trusted extensions or external agent providers; command text follows its [credential rule](../SECURITY.md#credentials).

Pi expands a verified leading skill invocation once in the first user message, including hidden skills. Unknown or unreadable skills and extension-command collisions fail before a model request. Other commands and prompt templates are not expanded. The attempt records the invoked skill, not every skill the child later reads.

Every child has independent [background compaction](compaction.md).

### Delegation scope

A delegated writer receives a distinct managed worktree from the source checkout's exact current commit, under `dev --orb` from the lead orb's committed `HEAD`. Modified, untracked and ignored files are not copied. `worktree.path` records the allocation, whose reservation outlives the attempt.

For `delegate`, `cwd` can select another Git checkout. The child uses that repository's [guidance and trusted resources](../SECURITY.md#trusted-base) and delivery policy; a read-only child reads the selected checkout directly. The lead stays bound to its original repository and can read and inspect the result; its own native writes follow the [native destination policy](workspace.md#native-writes). See [workspace selection](workspace.md#delegation-into-another-checkout) for admission and task identity.

`process` commands keep `cwd` inside the bound workspace. Leaves cannot select a `cwd`, and a coordinator delegated into another checkout can start only read-only leaves there.

### Coordinators and leaves

Nesting stops at lead, coordinator, leaf. A coordinator starts no local commands and grants no access beyond its own; a read-only coordinator starts only read-only leaves. The lead's controller owns admission, launch, records and cancellation for all attempts. Coordinators can inspect and cancel only their own leaves; leaves cannot delegate.

A read-only leaf reads its coordinator's admitted workspace, including uncommitted files. A writing leaf gets a separate worktree from the lead's commit, without the coordinator's edits.

Leaf outcomes arrive after the coordinator's turn ends with the same content as lead outcomes. Repeated delivery adds no message. The controller withholds the coordinator's result while a request is pending, a leaf is live or an outcome remains undelivered; an early report is a protocol failure. Unobserved leaf termination is reported as `unknown`.

Aborting a coordinator tool call interrupts its local wait, not an IPC request already sent: the controller may still admit that leaf. Stop the coordinator to cancel its owned work. Cancellation never rolls back performed effects.

### Delivery and verification

Outcomes resume the owning conversation without polling. Inspection remains available for diagnosis or a requested progress check. Dev refuses blocking shell waits covered by the [wait guard](adr/0007-observed-usage-wait-guard.md) and names `work process` as the alternative for a lead's leading long sleep; the ADR owns the rules, accepted gaps and evidence required to change them.

Outcomes carry a child's whole answer when it fits the result read and the tail of command output, so the common case needs no `inspect`; a longer answer is read from offset 0. They arrive when the current run settles, or at idle when late. An eligible batch can continue a successful lead run without another user message; workflow checkpoints still apply. Compaction and context edits do not erase delivery acknowledgment. Failed or unconfirmed delivery remains visible in `/work`; retries do not start model calls.

A completed process or child report is not artifact verification. Tracked Git changes are compared for inspection; untracked files and external dependencies are not. [Workspace release](workspace.md#release) governs retained workspaces.

### Cancellation and session changes

Esc during a lead run, `/work stop`, confirmed tree navigation, `/new`, `/resume`, `/fork` and `/quit` stop owned work. Cancelled navigation or replacement previews preserve it. `/reload` closes work but keeps the lead's shells observed. Earlier outcomes stay inspectable and are not replayed into a new branch.

A coordinator's cancellation, failure or exit stops its leaves, including leaves that already reported. Late leaf outcomes are dropped; requests after stop or generation change are refused. Cancellation is complete only as process exit and surviving descendants are observed; it never undoes edits.

### Failures and visibility

A local command that exits normally is `completed`, even with a nonzero exit code. Inspection and outcome delivery retain `exitCode`; completion does not mean a test passed or the command achieved its goal. `failed` indicates an execution failure, such as a process error or unexpected signal termination, or a child that could not return normally because of a provider, launch or protocol failure. Requested interruption remains `cancelled`; unobserved termination remains `unknown`.

Subscription exhaustion from any attempt, including a leaf, blocks new agents and automatic continuation and disables the lead's provider retries. A user message alone does not clear it. The block lifts and retries return to their prior setting when a lead run that started after the last exhaustion completes; exhaustion reported during a run outlasts that run. Existing commands finish and their outcomes are recorded. A final lead provider or transport failure after Pi retries suspends automatic reactivation until the next user message. Tool, build, test and child failures are not lead-run failures.

### Live view

Dev publishes `dev/work-view` on Pi's event bus only when a UI is present. Each emission replaces the session's previous view; closing work emits an empty view. Global extensions own presentation under [ADR 0006](adr/0006-global-visual-layer.md). The [view declaration](../src/work-view.ts) owns its exact fields.

Under `dev --orb`, a writing child remains `provisioning` until its orb is ready. The view includes the orb's phase, and tool results and outcomes keep its final state and where its work went.

A batch includes active children and children that settled since the owner's last message. Outcome deliveries and other extension input do not close it; the owner's next message drops settled children. Leaves retain their coordinator in the view. Local commands contribute a running count rather than child rows.

Live activity is transient: it stays in controller memory, never in the attempt store or model context. Updates are coalesced without reading the store on each tick. [SECURITY](../SECURITY.md#credentials) owns target disclosure and redaction limits.

### Model-visible results

The model and `/work` read compact JSON, not the full structured result. Extensions and scripts use `details` or codemode's structured return for complete attempt facts; renderers must not decode model-facing text as the structured result. Usage counts once per attempt, not again in its coordinator; unavailable values are distinct from zero.

Plain `inspect` shows metadata and available streams without copying the answer or logs into model context. Select a stream to read it. Outcomes include answers that fit the result read and previews of command output; a truncated answer points to offset 0. The [model projection](../src/work-model-text.ts) owns exact fields and preview limits.

A deferred gate close appears as `gateReleaseWarning` without changing attempt status; [workspace settlement](workspace.md#process-uses-and-gates) explains the retry boundary.

## State

| Path                                   | Content                                                                           |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| `<data-home>/work/attempts.sqlite`     | Authoritative persisted attempt facts, with ownership committed alongside payload |
| `<data-home>/work/attempts/<attempt>/` | Temporary full logs                                                               |
| `<data-home>/child-sessions/`          | Child conversations, excluded from lead `--continue` selection                    |

Retention applies age and count limits to completed results; [the attempt store](../src/work-store-worker.ts) owns the limits. Active and unresolved attempts remain. Expired results are unavailable rather than reconstructed from summaries. Child conversation history follows the separate [history cleanup policy](launcher.md#automatic-history-cleanup).

Process crashes are recoverable, but power loss can drop recent attempt updates. To back up the store, stop sessions and preserve the database with its WAL and SHM companions. Before opening it, dev checks the Node minimum in `package.json` and an embedded SQLite with the [WAL-reset fix](https://www.sqlite.org/wal.html#the_wal_reset_bug); the Node number alone does not establish safety.

Invalid or corrupt storage is refused, not rebuilt from logs. If the database is corrupt at session startup, work stays unavailable and a notification provides manual reset instructions for the active data home instead of an extension stack trace.

Format changes and obsolete-state removal are contributor operations covered in [Development](DEVELOPMENT.md#discard-obsolete-state).

After a crash, an absent PID supplies no exit code and a present PID proves no identity. Reopening neither restarts work nor kills a recovered PID. An unresolved [workspace use](workspace.md#process-uses-and-gates) can keep the checkout blocked independently of attempt retention.
