# Work

## Purpose

The `work` tool runs local commands and delegated Pi children in the background, so the lead conversation keeps pairing with the user while builds, tests, reviews and bounded investigations run. The shared dev-cycle decides whether to delegate and what to assign; dev owns the processes, their outcomes and the delivery of those outcomes back to the conversation.

## Use

Ask the lead in natural language to run a command in the background or to delegate an assignment; the lead calls `work` with `action: "process"` or `action: "delegate"`. There is no `/work start`. A delegation carries a task ID, a focused prompt, `access` (`read-only` or `write`) and an optional `coordinate: true`. Give a child file paths, facts and acceptance conditions, not a transcript. A prompt that starts with `/skill:name` loads that skill natively, with the rest of the prompt as its assignment. Dispatch is resolved from that prompt: when it invokes a skill that has a rule in `config/crew-dispatch.json`, the child uses that rule, otherwise the file's `default`. Pass `rule` only to override that choice with a configured skill name or `"default"`; explicit `model` (`provider/model-id`) and `effort` override the selected profile, and the tool tells the lead and a coordinator to pass them only when the user asked for that model or effort.

`coordinate: true` delegates a whole phase: that child is a coordinator, with a scoped `work` tool (`dispatch`, `delegate`, `list`, `inspect`, `cancel`) to start leaf children for its assignment. Only its outcome comes back to the lead.

Session commands:

```text
/work                        attempts of this session with their state, leaves with their coordinator as `parent` (same as /work list)
/work dispatch               the dispatch rules and default, read from the dev checkout
/work inspect <id>           outcome, log summary and artifact changes to re-evaluate
/work inspect <id> stdout 0  retained output from offset 0; pass the returned nextOffset for the next page
/work inspect <id> stderr 0  same for stderr; `result` is a child's retained final answer
/work stop <id>              cancel one attempt; a coordinator takes its leaves with it
/work stop                   cancel every attempt of this session, also while the lead is idle
```

A writer attempt shows its managed worktree path with a reminder: `blocked` while its workspace use is unresolved, otherwise `review-required`. Neither authorizes deletion; the reservation and files are retained independently of the attempt ([workspace](workspace.md#behavior)).

## Behavior

- Every launch returns an attempt ID once the process exists. A local command runs Bash in the requested directory with the user's permissions, in the lead checkout under the lead's writer admission. A delegated writer gets its own managed worktree at the lead's current commit, without modified, untracked or ignored files, and a task reservation that outlives the attempt. A read-only child gets inspection tools, no shell or edit tools. A child receives the project instructions, the base Pi prompt, the profile guidance and the full skill catalog of its profile, not the lead's conversation.
- Each child, coordinators and read-only leaves included, gets its own [background compaction](compaction.md). This adds no tool or project-write capability and does not enable ordinary extensions for read-only children. Cancellation stops pending preparation; native compaction and discarded-summary usage remain part of that child's totals, even when context replacement removes its last projected assistant message. Raw active-branch entries remain delivery-receipt authority.
- Skills: a prompt starting with `/skill:name` is expanded once by Pi into the first user message, hidden skills included, and the attempt records that skill only. An unknown or unreadable skill, or an extension command that would run in its place, fails the attempt before any model request. No other command or prompt template is ever expanded.
- Nesting is one level: lead, coordinator, leaf. Only a child the lead delegated with `coordinate: true` starts leaves, never beyond its own access: a read-only coordinator starts only read-only leaves, no coordinator starts a local command, and a leaf cannot delegate. The lead's controller admits, launches, records and cancels every attempt; a coordinator lists, inspects and cancels only its own leaves. A read-only leaf runs in its coordinator's working directory and reads its files as they are, uncommitted ones included; a writer leaf gets its own managed worktree like any delegated writer, without its coordinator's changes.
- Leaf outcomes are delivered to their coordinator's conversation after its turn ends, not to the lead, and a repeated delivery adds no message. A coordinator's result is withheld while a request of its own is pending, a leaf is live or an outcome is undelivered; a coordinator that reports earlier is stopped as a protocol failure. The outcome message carries each leaf's inspection, retained result included. A leaf whose termination is not observed reaches its coordinator as `unknown`.
- Aborting one coordinator tool call interrupts its local wait, not an IPC request already sent: the controller may still admit the leaf. Stop the coordinator to cancel its owned work; cancellation never rolls back effects already performed.
- What a command may contain is in [SECURITY](../SECURITY.md#credentials).
- Outcomes arrive at Pi's final actionable boundary (`agent_before_settle`) and, when late, at idle. An eligible batch can continue a successful lead run without a new user message; checkpoints still apply. Delivery is acknowledged from raw entries on the active conversation branch, so compaction and context edits cannot erase it. Failed or unconfirmed delivery stays visible in `/work`; retries wait for natural events and never start a model call.
- A finished process or a child's report is not verification of the artifact. Artifact comparison covers tracked Git changes only; untracked files and external dependencies are not compared.
- Session, task, attempt and generation identify every observation. Esc while the lead runs, `/work stop`, confirmed `/tree` navigation, `/new`, `/resume`, `/fork` and `/quit` invalidate the current generation and stop the session's work; `/reload` keeps shells and closes work. A cancelled switch, fork or resume preview does not close the session's work; a confirmed one does. Earlier outcomes stay inspectable and are not replayed into a new branch. Cancelling a coordinator, its failure or its exit stop its leaves, those that already reported a result included, and a leaf outcome that arrives afterwards is dropped. A request a coordinator sends after it was stopped or the generation changed is answered with a refusal and starts nothing. Cancellation is observed through process exit and surviving descendants, and never undoes edits.
- The `work` tool description teaches this protocol, and outcome messages repeat the worktree reminder, in every dev session. That is instruction, not a guarantee that every model follows it.
- Invalid dispatch fails: a missing or unreadable rules file, a rule that is not configured, an unsupported harness, an invalid effort or an unresolvable model never substitute another model. Omitted model or effort use the child's Pi defaults, not the lead's picker.
- A subscription-exhaustion report, from any attempt of the session, leaves included, blocks new agents and automatic continuation for the rest of the session; a new user message does not clear it. Running commands finish and their outcomes are still recorded. A final provider or transport failure, after Pi's own retries, suspends dev's automatic reactivation until the next user message. Tool, build, test and child failures are not lead-run failures.
- The extension status line shows background states and the active children's models and context pressure, a leaf as `coordinator>leaf`. Listing and inspection show each attempt's parent, invoked skill, tools and observed usage, and a `gateReleaseWarning` when its workspace settled but a gate release was deferred, which leaves the attempt's status unchanged; usage is counted once per attempt, never summed into its coordinator, with unavailable values distinct from zero.

## State

| Path                                   | Content                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| `<data-home>/work/attempts.sqlite`     | authoritative attempt records; session ownership is committed with the payload |
| `<data-home>/work/attempts/<attempt>/` | temporary full logs                                                            |
| `<data-home>/child-sessions/`          | child conversations, outside `--continue` selection                            |

Retention keeps seven days from completion and the newest 64 completed results in that window; active or unresolved attempts are kept. The store is WAL with `synchronous=NORMAL`: process crashes are recoverable, a power loss can drop recent updates. It accepts only its current schema and rejects other layouts without deleting them; a corrupt database fails closed and is never rebuilt from logs. Preserve the database with its WAL and SHM companions together, with sessions stopped. Node must be 22.23.2 or newer and its SQLite must carry the WAL-reset fix; that check runs before the store opens, and a numerically newer Node from another release line can still ship an older SQLite and is refused. An expired result is unavailable, not reconstructed from an old summary.

Records and the database carry no format version. Persistence refuses unknown record fields rather than retaining or silently stripping them. A format change replaces the current schema; delete the obsolete attempt state following [DEVELOPMENT](DEVELOPMENT.md#discard-obsolete-state), rather than migrating it or keeping legacy fields. Ownership checks and live revisions remain enforced.

After a crash, records describe observations, not survival: an absent PID reveals no exit code and a present PID proves no identity. Reopening never restarts work or kills a recovered PID. What an unresolved workspace use does to its checkout is in [workspace](workspace.md#behavior).

## Decisions

[Session-owned children](ARCHITECTURE.md#session-owned-children-in-separate-processes), [authoritative lifecycle](ARCHITECTURE.md#authoritative-lifecycle-incremental-store) and [versioned dispatch](ARCHITECTURE.md#versioned-dispatch-local-private-state) in ARCHITECTURE; [ADR 0002](adr/0002-session-owned-background-work.md) and [ADR 0004](adr/0004-authoritative-lifecycle-incremental-store.md).

## Verify

`npm run work:check` checks dispatch resolution against crafted and shipped configurations, then forks real children with an offline scripted model: a delegation without a rule against the shipped configuration, native skill invocation, coordinator authorization, outcome routing, interruption and the leaf read of a coordinator's worktree. `npm run workspace:check` covers the real process adapters and the host session flows of a background process (rebind, fork, import) in headless Pi sessions. Delivery timing is checked in the real TUI.
