# Background work

The built-in `work` tool starts local commands and separate Pi child processes.
Shared dev-cycle remains responsible for whether to delegate, the assignment,
checkpoints and recovery. The lead stays a normal Pi conversation.

## Operations

Ask the lead to run a command in the background or delegate a bounded assignment.
Each launch returns an attempt ID immediately after process creation. A local
command uses Bash in the requested directory; it has the user's normal permissions.
A delegated assignment includes a task ID, focused prompt, access (`read-only` or
`write`), optional skill names, and resolved dispatch choices. Supply pertinent
file paths, facts and acceptance conditions rather than copying a transcript.

Command text is not copied into operational records or automatic outcomes.
Native Pi tool-call history still records tool inputs, and commands control what
their output prints. Use existing credential tooling or environment references
instead of placing literal credentials in a command or assignment.

Use `/work` to list attempts, `/work inspect <attempt>` for an outcome,
`/work inspect <attempt> stdout 0` to start reading its retained output, and
`/work stop <attempt>` to cancel one attempt. `/work stop` interrupts all work
owned by this live session, including when the lead is idle. `stderr` and `result`
are the other log streams. Tool inspection exposes byte offsets for pagination.
An expired result is unavailable, not reconstructed from an old summary.

The native footer retains lead model/context information; the extension status
shows background states and active child models/context pressure. Inspection
exposes observed child usage, with unavailable values explicitly distinguished
from zero. Results arrive at the next idle boundary and may continue the ordinary
workflow without another user message. Checkpoints still apply. A completed
process or a child's report is not verification of the artifact.

## Dispatch

Optional configuration lives at `<dev-data-home>/crew-dispatch.json`, not inside
the project or another agent's profile. Its shape follows Firstmate ordinary
dispatch, without its fleet, quota selection or provider substitution:

```json
{
  "rules": [
    {
      "when": "Independent read-only review",
      "use": { "harness": "pi", "effort": "high" },
      "why": "Keep review separate from the lead's implementation context"
    }
  ],
  "default": { "harness": "pi" }
}
```

The lead reads `work` with `action: "dispatch"`, interprets `when`, and passes the
zero-based rule index as a string or `"default"`. Explicit task fields override
that selection. `model` is a concrete `provider/model-id`; `effort` must be
supported by that model. Unsupported harnesses, malformed profiles, model
selection failures and invalid effort fail rather than silently changing models.
When configuration is absent the adapter is Pi. Omitted model/effort use the
child's documented Pi defaults, not the lead's transient picker selection.
No configuration is created automatically.

## Scope and ownership

A read-only child receives inspection tools rather than arbitrary shell or edit
capabilities. Native batching is preserved over the available tools. This is a
tool boundary, not an OS sandbox. Project instructions and the base Pi prompt
remain in place; specialization guidance and requested skills are composed
explicitly. A child is not given the lead's conversation.

For a writer, prepare a separate linked worktree of the lead repository and pass
its directory. The controller refuses the lead checkout, the primary checkout,
a different repository and a worktree already leased by another dev attempt in
the same data home. It does not create or remove worktrees and cannot constrain
an arbitrary shell to that directory. Never use this as isolation from hostile
code or another process operating outside this controller.

Session/task/attempt/generation identify every observation. Interrupting the
lead, stopping all work, navigating sessions, or shutting down invalidates the
owner before cancellation. Late observations remain inspectable but cannot
wake that invalidated owner. Cancellation does not undo edits. The controller
observes process exit and surviving owned processes before reporting a terminal
outcome; signal delivery alone is insufficient. Esc while the lead is running
also interrupts related work; use `/work stop` while idle.

Subscription-exhaustion reports block new agents and automatic continuation.
Existing local commands may finish, and their outcomes still arrive automatically
as conversation facts without starting another model turn. No provider switch or new retry loop is
introduced. Unrecognized provider failures remain failures, not quota certainty.

## Retention and recovery

Operational records and temporary full logs live in
`<dev-data-home>/work/attempts/<attempt>/`. Save/read maintenance retains at most
seven days from completion and the newest 64 completed results in that window.
Active or unresolved attempts are excluded from that pruning.

Pi child conversations live separately in `<dev-data-home>/child-sessions/`, so
`--continue` does not select a child as the lead. Conversation files, preferences,
credentials, worktrees and durable artifacts are outside result retention.

After a crash, retained records describe observations, not a survival guarantee.
An absent PID does not reveal an exit code; a present PID does not prove identity.
Reopening never restarts work or kills a recovered PID. An unresolved writer
lease is retained conservatively; inspect its record and actual processes before
manually releasing its path. Recovery guidance can consume `list`, `inspect`,
log references and process observations without a second workflow database.

Artifact comparisons cover tracked Git changes. Untracked files, unavailable Git
state, external dependencies and changes outside that scope are not verified.
Changed or unknown artifacts require reconciliation before accepting a result.

## Evidence boundary

The implementation targets the installed Pi 0.85.1 SDK. Issue #12 retains
daily-use acceptance: no new test suite, fixtures, benchmark campaign or prescribed
manual checklist. Local execution evidence is reported with delivery; no
reliability, efficiency or reasoning-quality improvement is inferred from the
process architecture.
