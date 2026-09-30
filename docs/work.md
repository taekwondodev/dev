# Work

## Purpose

The `work` tool runs local commands and delegated Pi children in the background, so the lead conversation keeps pairing with the user while builds, tests, reviews and bounded investigations run. The shared dev-cycle decides whether to delegate and what to assign; dev owns the processes, their outcomes and the delivery of those outcomes back to the conversation.

## Use

Ask the lead in natural language to run a command in the background or to delegate an assignment; the lead calls `work` with `action: "process"` or `action: "delegate"`. There is no `/work start`. A delegation carries a task ID, a focused prompt, `access` (`read-only` or `write`), optional skill names and a dispatch choice: the lead reads `work` with `action: "dispatch"`, matches the `when` of a rule in `config/crew-dispatch.json` and passes the rule index as a string, or `"default"`. Explicit `model` (`provider/model-id`) and `effort` override the rule. Give a child file paths, facts and acceptance conditions, not a transcript.

Session commands:

```text
/work                        attempts of this session with their state (same as /work list)
/work dispatch               the dispatch rules, read from the dev checkout
/work inspect <id>           outcome, log summary and artifact changes to re-evaluate
/work inspect <id> stdout 0  retained output from offset 0; pass the returned nextOffset for the next page
/work inspect <id> stderr 0  same for stderr; `result` is a child's retained final answer
/work stop <id>              cancel one attempt
/work stop                   cancel every attempt of this session, also while the lead is idle
```

A writer attempt shows its managed worktree path with a reminder: `blocked` while its workspace use is unresolved, otherwise `review-required`. Neither authorizes deletion; the reservation and files are retained independently of the attempt ([workspace](workspace.md#behavior)).

## Behavior

- Every launch returns an attempt ID once the process exists. A local command runs Bash in the requested directory with the user's permissions, in the lead checkout under the lead's writer admission. A delegated writer gets its own managed worktree at the lead's current commit, without modified, untracked or ignored files, and a task reservation that outlives the attempt. A read-only child gets inspection tools, no shell or edit tools. A child receives the project instructions, the base Pi prompt, the profile guidance and the requested skills, not the lead's conversation.
- What a command may contain is in [SECURITY](../SECURITY.md#credentials).
- Outcomes arrive at Pi's final actionable boundary (`agent_before_settle`) and, when late, at idle. An eligible batch can continue a successful lead run without a new user message; checkpoints still apply. Delivery is acknowledged from raw entries on the active conversation branch, so compaction and context edits cannot erase it. Failed or unconfirmed delivery stays visible in `/work`; retries wait for natural events and never start a model call.
- A finished process or a child's report is not verification of the artifact. Artifact comparison covers tracked Git changes only; untracked files and external dependencies are not compared.
- Session, task, attempt and generation identify every observation. Esc while the lead runs, `/work stop`, confirmed `/tree` navigation, `/new`, `/resume`, `/fork` and `/quit` invalidate the current generation and stop the session's work; `/reload` keeps shells and closes work. A cancelled switch, fork or resume preview does not close the session's work; a confirmed one does. Earlier outcomes stay inspectable and are not replayed into a new branch. Cancellation is observed through process exit and surviving descendants, and never undoes edits.
- The `work` tool description teaches this protocol, and outcome messages repeat the worktree reminder, in every dev session. That is instruction, not a guarantee that every model follows it.
- Invalid dispatch fails: a missing or unreadable rules file, an unsupported harness, an invalid effort or an unresolvable model never substitute another model. Omitted model or effort use the child's Pi defaults, not the lead's picker.
- A subscription-exhaustion report blocks new agents and automatic continuation for the rest of the session; a new user message does not clear it. Running commands finish and their outcomes are still recorded. A final provider or transport failure, after Pi's own retries, suspends dev's automatic reactivation until the next user message. Tool, build, test and child failures are not lead-run failures.
- The extension status line shows background states and the active children's models and context pressure. Inspection shows observed child usage, with unavailable values distinct from zero.

## State

| Path                                   | Content                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| `<data-home>/work/attempts.sqlite`     | authoritative attempt records; session ownership is committed with the payload |
| `<data-home>/work/attempts/<attempt>/` | temporary full logs                                                            |
| `<data-home>/child-sessions/`          | child conversations, outside `--continue` selection                            |

Retention keeps seven days from completion and the newest 64 completed results in that window; active or unresolved attempts are kept. The store is WAL with `synchronous=NORMAL`: process crashes are recoverable, a power loss can drop recent updates. It accepts only its current schema and rejects other layouts without deleting them; a corrupt database fails closed and is never rebuilt from logs. Preserve the database with its WAL and SHM companions together, with sessions stopped. Node must be 22.23.2 or newer and its SQLite must carry the WAL-reset fix; that check runs before the store opens, and a numerically newer Node from another release line can still ship an older SQLite and is refused. An expired result is unavailable, not reconstructed from an old summary.

After a crash, records describe observations, not survival: an absent PID reveals no exit code and a present PID proves no identity. Reopening never restarts work or kills a recovered PID. What an unresolved workspace use does to its checkout is in [workspace](workspace.md#behavior).

## Decisions

[Session-owned children](ARCHITECTURE.md#session-owned-children-in-separate-processes), [authoritative lifecycle](ARCHITECTURE.md#authoritative-lifecycle-incremental-store) and [versioned dispatch](ARCHITECTURE.md#versioned-dispatch-local-private-state) in ARCHITECTURE; [ADR 0002](adr/0002-session-owned-background-work.md) and [ADR 0004](adr/0004-authoritative-lifecycle-incremental-store.md).

## Verify

`npm run workspace:check` covers the real process adapters and the host session flows of a background process (rebind, fork, import) in headless Pi sessions. Delivery timing is checked in the real TUI.
