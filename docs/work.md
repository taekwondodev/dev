# Work

## Purpose

`work` runs commands and delegated agents in the background while this conversation stays available. Dev owns execution, observation and delivery of results; the caller decides what to delegate and [verifies the result](#delivery-and-verification).

## Use

Ask the agent in this conversation to run a command or delegate an assignment. It calls `work` with `action: "process"` or `action: "delegate"`; there is no `/work start`.

A delegation supplies a `taskId` label you choose, a focused prompt and `access` (`read-only` or `write`). Give paths, facts and acceptance conditions, not a transcript. `workflowTaskId` is separate: use it as `taskId` in `workspace` with `action: "resume"`.

`skill` names the skill to load first and selects its [configured model and effort](../config/README.md#resolution). A skill mentioned only in the prompt does not affect model or effort. Without the field, a leading `/skill:name` has the same effect; with the field set, the prompt is passed as written. Leave `model` and `effort` unset unless the user requested those overrides.

Set `coordinate: true` only to delegate a whole phase. The delegated agent can use `work` to start and manage agents that cannot delegate further. Only its final report returns to this conversation.

```text
/work                         list runs, including which run started each delegated run
/work dispatch                show configured models and effort; not required before launch
/work inspect <run>           show run details, tracked-file changes and available streams
/work inspect <run> stdout 0  read by byte offset; continue with nextOffset until null
/work inspect <run> stderr 0  read stderr; use result for a delegated agent's answer
/work stop <run>              stop a run and any agents it started
/work stop                    stop all runs from this conversation, even while it is idle
```

Typing `/work ` offers each subcommand with a one-line explanation. The model reads [compact results](#model-visible-results); use `inspect` for run details, or select a stream to page its output. In codemode, `tools.work(...)` returns the structured result; an inspection holds its `run`, logs and saved record; use `describeTool('work')` for its current declaration.

Writing agents show their worktree path as `blocked` if it may still be in use, otherwise `review-required`. Neither status authorizes deletion. See [Workspace](workspace.md) for checkout cleanup.

## Behavior

### Execution and access

A launch returns an attempt ID once the process exists. A local command runs Bash with the user's permissions under the lead checkout's writer admission.

Every child receives its working project's instructions, Pi's base prompt and profile guidance, not the lead's conversation. Its skill catalog lists only the skill named by `skill` and skills named in the assignment prompt. Name any additional skills the child should see in that catalog; this filter does not restrict file access. Read-only children have inspection tools, `read_url`, `codemode` and `work` for coordinators, but no shell, edit or `gh` tool. Put issue, PR or other external text in the prompt or a workspace file. `git_inspect` cuts Git output past 64 KB; for a diff or commit that is larger and changes several files it can return those files with their added and removed line counts instead, to be read one `path` at a time. The run's `stdout` keeps the whole output, and its `stderr` Git's own messages. An extension tool reusing an inspection tool's name is blocked, so the child loses that tool. Writing children follow the lead's [native destination policy](workspace.md#native-writes).

Children can [read URLs](web-read.md) directly or through codemode, including authenticated pages. Scripts retain the child's tool permissions and have no model catalog; see [codemode's trust boundary](../SECURITY.md#trusted-base).

The [security model](../SECURITY.md#outside-the-protection) explains why the allowlist does not sandbox trusted extensions or external agent providers.

Pi expands a verified leading skill invocation once in the first user message, including hidden skills. Unknown or unreadable skills and extension-command collisions fail before a model request. Other commands and prompt templates are not expanded. The attempt records the invoked skill, not every skill the child later reads.

Every child has independent [background compaction](compaction.md).

Command text must follow the [credential rule](../SECURITY.md#credentials). Process separation and read-only tools are not an OS sandbox.

### Delegation scope

A delegated writer receives a distinct managed worktree from the source checkout's exact current commit. Modified, untracked and ignored files are not copied. `worktree.path` records the allocation, whose reservation outlives the attempt.

For `delegate`, `cwd` can select another Git checkout. The child uses that repository's [guidance and trusted resources](../SECURITY.md#trusted-base) and delivery policy; a read-only child reads the selected checkout directly. The lead stays bound to its original repository and can read and inspect the result; its own native writes follow the [native destination policy](workspace.md#native-writes). See [workspace selection](workspace.md#delegation-into-another-checkout) for admission and task identity.

`process` commands keep `cwd` inside the bound workspace. Leaves cannot select a `cwd`, and a coordinator delegated into another checkout can start only read-only leaves there.

### Coordinators and leaves

Nesting stops at lead, coordinator, leaf. A coordinator starts no local commands and grants no access beyond its own; a read-only coordinator starts only read-only leaves. The lead's controller owns admission, launch, records and cancellation for all attempts. Coordinators can inspect and cancel only their own leaves; leaves cannot delegate.

A read-only leaf reads its coordinator's admitted workspace, including uncommitted files. A writing leaf gets a separate worktree from the lead's commit, without the coordinator's edits.

Leaf outcomes arrive after the coordinator's turn ends with the same content as lead outcomes. Repeated delivery adds no message. The controller withholds the coordinator's result while a request is pending, a leaf is live or an outcome remains undelivered; an early report is a protocol failure. Unobserved leaf termination is reported as `unknown`.

Aborting a coordinator tool call interrupts its local wait, not an IPC request already sent: the controller may still admit that leaf. Stop the coordinator to cancel its owned work. Cancellation never rolls back performed effects.

### Delivery and verification

While background work runs, do independent work or end the turn and let outcome delivery resume it. Do not poll or run shell waits just to await completion; inspection remains available for diagnosis or a requested progress check. Dev refuses, including through codemode, a simple sleep-only wait while the agent owns pending work and, for the lead only, a command whose first step is a long sleep, whether or not work is running. The second refusal names the replacement: run the wait itself as a `work process`, then do independent work or end the turn so that outcome delivery resumes it. This guard is not a general shell-loop detector; [ADR 0007](adr/0007-observed-usage-wait-guard.md) records its rules, accepted gaps and what evidence a change needs.

Outcomes carry a child's whole answer when it fits the result read and the tail of command output, so the common case needs no `inspect`; a longer answer is read from offset 0. They arrive when the current run settles, or at idle when late. An eligible batch can continue a successful lead run without another user message; workflow checkpoints still apply. Compaction and context edits do not erase delivery acknowledgment. Failed or unconfirmed delivery remains visible in `/work`; retries do not start model calls.

A completed process or child report is not artifact verification. Tracked Git changes are compared for inspection; untracked files and external dependencies are not. Review the real artifact and account for retained workspaces before delivery.

### Quiet commands

A command can hang without exiting. When a running `process` attempt adds nothing to stdout or stderr for 2 minutes, dev raises a quiet notice with the command's runtime, quiet time and output tails, with recognized credentials redacted. Dev never stops the command; the agent or the user decides whether to wait, inspect or cancel it.

The first notice of a command reaches the model only when that costs no cold request: a running lead receives it at its next turn, and a resting lead wakes for it only when its last model request is under 5 minutes old and automatic continuation is allowed. Otherwise the notice waits for the lead's next run, whoever starts it, and the [program status](#program-status) reports `blocked`. A notice is dropped when its command prints again, settles or is stopped first; a notice that fails to reach the conversation waits for the next run. After a command's notice reaches the model, its later silences are shown only to the user.

A superseded notice can still reach the model when Pi runs a blocking compaction before a wake, or when another extension delays dev's turn-boundary entry; an extension that removes that entry can cost the command its only model notice. [#322](https://github.com/taekwondodev/dev/issues/322) records the decision.

### Cancellation and session changes

Esc during a lead run, `/work stop`, confirmed tree navigation, `/new`, `/resume`, `/fork` and `/quit` stop owned work. Cancelled navigation or replacement previews preserve it. `/reload` closes work but keeps the lead's shells observed. Earlier outcomes stay inspectable and are not replayed into a new branch.

A coordinator's cancellation, failure or exit stops its leaves, including leaves that already reported. Late leaf outcomes are dropped; requests after stop or generation change are refused. Cancellation is complete only as process exit and surviving descendants are observed; it never undoes edits.

### Failures and visibility

A local command that exits normally is `completed`, even with a nonzero exit code. Inspection and outcome delivery retain `exitCode`; completion does not mean a test passed or the command achieved its goal. `failed` indicates an execution failure, such as a process error or unexpected signal termination, or a child that could not return normally because of a provider, launch or protocol failure. Requested interruption remains `cancelled`; unobserved termination remains `unknown`.

Subscription exhaustion from any attempt, including a leaf, blocks new agents and automatic continuation and disables the lead's provider retries. A user message alone does not clear it. The block lifts and retries return to their prior setting when a lead run that started after the last exhaustion completes; exhaustion reported during a run outlasts that run. Choosing another lead model, by setting or cycling it, lifts the block at once, even when the exhaustion came from a child; restoring a model when a session resumes does not. Existing commands finish and their outcomes are recorded. A final lead provider or transport failure after Pi retries suspends automatic reactivation until the next user message. Tool, build, test and child failures are not lead-run failures.

### Program status

Pi reports the lead's state to terminals that support the [Program Status Protocol](https://www.superlogical.com/rex/docs/build/program-status): `working` during a run and `done` when it settles. Dev changes one case. While the lead rests and outcome delivery will start its next run without a user message, the terminal receives `working` instead of `done`: a command or child the lead started has not settled, or one of their outcomes still awaits a delivery that can continue the lead.

While the lead rests with a [quiet notice](#quiet-commands) waiting for the user, dev reports `blocked` with the quiet commands' task keys instead, until the commands print again, settle or stop, or the lead starts a run.

`done` follows as soon as nothing will resume the lead: the resumed run settles with no work left, the work is stopped, or automatic continuation ends under the [delivery](#delivery-and-verification) or [failure](#failures-and-visibility) rules. `blocked`, `error` and the `idle` of a cancelled run arrive as Pi sends them, and the application name and message are always Pi's.

Commands and children count alike. A command that never exits, such as a server or a watcher, keeps the status at `working` until `/work stop` ends it. [ADR 0006](adr/0006-global-visual-layer.md) records why this rule lives in dev rather than in a global extension.

### Live view

Dev publishes `dev/work-view` on Pi's event bus only when a UI is present. Each emission replaces the session's previous view; closing work emits an empty view. Global extensions own presentation under [ADR 0006](adr/0006-global-visual-layer.md). The [view declaration](../src/work-view.ts) owns its exact fields.

A batch includes active children and children that settled since the owner's last message. Outcome deliveries and other extension input do not close it; the owner's next message drops settled children. Leaves retain their coordinator in the view. Local commands contribute a running count and their [quiet](#quiet-commands) members rather than child rows.

Live activity is transient: it stays in controller memory, never in the attempt store or model context. Updates are coalesced without reading the store on each tick. [SECURITY](../SECURITY.md#credentials) owns target disclosure and redaction limits.

### Model-visible results

The model and `/work` read compact JSON. Extensions and scripts use `details` or codemode's structured return instead of parsing that text. Usage counts once per run; unavailable is not zero.

Plain `inspect` shows metadata and available streams without copying the answer or logs into model context; a run still in progress omits the file comparison and streams it does not have yet. Select a stream to read it. Results include answers that fit and command output previews. For an omitted answer, call `inspect` with its `id`, `stream: "result"` and `offset: 0`. The [model projection](../src/work-model-text.ts) owns exact fields and preview limits.

A delayed lock close appears as `lockWarning` without changing run status. See [when dev retries](workspace.md#process-uses-and-gates).

## State

| Path                                   | Content                                                                           |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| `<data-home>/work/attempts.sqlite`     | Authoritative persisted attempt facts, with ownership committed alongside payload |
| `<data-home>/work/attempts/<attempt>/` | Temporary full logs                                                               |
| `<data-home>/child-sessions/`          | Child conversations, excluded from lead `--continue` selection                    |

Retention keeps seven days from completion and the newest 64 completed results within that window. Active and unresolved attempts remain. Expired results are unavailable rather than reconstructed from summaries. Child conversation history follows the separate [history cleanup policy](launcher.md#automatic-history-cleanup).

Process crashes are recoverable, but power loss can drop recent attempt updates. To back up the store, stop sessions and preserve the database with its WAL and SHM companions. Before opening it, dev checks the Node minimum in `package.json` and an embedded SQLite with the [WAL-reset fix](https://www.sqlite.org/wal.html#the_wal_reset_bug); the Node number alone does not establish safety.

Invalid or corrupt storage is refused, not rebuilt from logs. If the database is corrupt at session startup, work stays unavailable and a notification provides manual reset instructions for the active data home instead of an extension stack trace.

Format changes and obsolete-state removal are contributor operations covered in [Development](DEVELOPMENT.md#discard-obsolete-state).

After a crash, an absent PID supplies no exit code and a present PID proves no identity. Reopening neither restarts work nor kills a recovered PID. An unresolved [workspace use](workspace.md#process-uses-and-gates) can keep the checkout blocked independently of attempt retention.
