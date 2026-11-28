# Workspace

The workspace authority coordinates dev conversations and children without treating a whole repository as one writer. Reservations retain work across sessions; admission isolates writers; sweeps release finished work; explicit task release lets the user discard what remains. [CONTEXT](../CONTEXT.md#workspace) defines these terms and [ADR 0005](adr/0005-scoped-runtime-coordination.md) explains the design.

This page covers commands, resuming paused work, session commands and what the model reads. [Workspace admission](workspace-admission.md) covers admission, isolation, native writes, task artifacts and process uses. [Workspace cleanup](workspace-cleanup.md) covers completion, sweep, release, quit, exit codes and stored state.

## Use

Terminal commands are read-only except `release`:

```bash
dev workspace                    # list this repository's tasks and workspaces
dev workspace inspect <task-id>  # inspect the exact task across repositories and its next safe action
dev workspace check <task-id>    # assess completion, target, blockers and evidence
dev workspace release <task-id>  # interactively confirm clearing every workspace of the task
dev workspace release pre-existing  # interactively confirm clearing ended sessions' uses of unreserved checkouts and forgetting deleted ones
```

In a session, `/workspace` also shows the checkout this conversation uses and its working directory. `/workspace inspect` mirrors the terminal command. `/workspace check` treats this conversation's own uses as ending at quit. `/workspace release` only names the terminal command; it releases nothing. `/workspace resume [task-id]` moves the conversation onto [paused work](#resume-paused-work). Typing `/workspace ` offers each subcommand with a one-line explanation.

Every listed workspace shows its head: the branch its checkout is on, or the commit and its subject when detached. A workspace whose directory is gone has none.

When the next step is a release, the terminal's `next` shows only its command, such as `dev workspace release pre-existing`; the release's own confirmation states what it clears and when it is safe. The model reads in `next` when the user may run it and what it deletes.

The lead's `workspace` tool supports these operations:

| Action               | Effect                                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `artifacts`          | Create and return the [task artifact directory](workspace-admission.md#task-artifacts)                                                                                                                 |
| `resume`             | End the turn and request a switch to a retained workspace without moving files; refused while the conversation has live shells or work. A refusal reports each checkout's result, reason and next step |
| `set-target`         | Set the destination branch dev checks for merged commits                                                                                                                                               |
| `record-publication` | Verify exact readback of an already published issue/PR artifact, in the workspace or in the task artifact directory, and record the evidence                                                           |

The tool uploads nothing, fetches no refs and cannot infer an unrecorded artifact selection.

### Resume paused work

Paused work is a [paused workspace](../CONTEXT.md#workspace), shown with the result `paused`; an unused workspace no task reserves is `idle` and cannot be resumed. Three ways lead back to it, each by explicit selection; the two that list it show the most recently used first. Only the workspace and its task are resumed, never the history of the conversation that worked there; `dev --continue` and `dev --resume` reopen history.

| Entry                         | Effect                                                                                                                                                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dev --task [task-id]`        | Open a new conversation in a paused workspace of the repository: the choice from the [launch list](launcher.md#resume-paused-work), or the exact task                                                                 |
| `/workspace resume [task-id]` | Switch this conversation there. Without an ID it lists the repository's paused workspaces; an exact ID selects directly, and lists that task's workspaces when it retains several                                     |
| The first write               | Before a write would [isolate](workspace-admission.md#admission-and-isolation) the lead from its own checkout because a paused task holds it, dev asks once whether to continue that task there or to work separately |

`/workspace resume` is refused while a turn is running, a checkout switch is pending, or the conversation has live shells or work, and the list needs an interactive session. The switch starts no turn: the model reads the `dev/workspace-switch` message on its next one.

The question names the paused task's head, its count of changed files and its last use. It waits for an answer without a timeout, so an unattended turn stays on it, and another write of the conversation admitted meanwhile waits for that answer instead of asking again. It appears only for a lead with an interactive UI, on a native write, a `bash` call or a `!` command, when the holder is resumable; children, delegated writers, the `workspace` and `work` tools and native writes into another repository are never asked.

- **Continue that task here** binds the conversation to the task and admits it as that task's writer under a new acquisition, in place: same checkout, same session, uncommitted files included, and the call that asked proceeds. A [message](#model-visible-messages) announces the join to the user and the model. It follows the results of the batch that asked, so the model reads it on its next request, also when the call that asked was then refused or cancelled; after a `!` command with no turn running it appears at once.
- **Work separately** isolates exactly as an unasked write does.
- Dismissing the question refuses the call, ends the turn and changes nothing; the next write asks again. A `!` command is not run.

If the reservation changed while the question was open, nothing is attached and the write is admitted afresh: another question for a task paused again, the checkout itself once released, or isolation from a task in use. A change during the admission itself refuses the call with a request to retry.

## Behavior

### Session commands

The same conversation cannot attach in two dev sessions, even across installations. See [automatic history cleanup](launcher-state.md#automatic-history-cleanup) for conversation retention and [ADR 0010](adr/0010-conversation-lifecycle.md#conversation-retention-admission) before changing deletion admission.

| Operation                                                     | Behavior                                                                                                                                                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/resume`, import of a conversation already in dev's sessions | Attach the target before teardown; refusal preserves the current session                                                                                                                                                       |
| `/new`, `/fork`, import of a copied conversation              | Attach after teardown; authority refusal ends the session. A copied conversation outside Git is refused before teardown                                                                                                        |
| `/new`, import of a copied conversation                       | Apply the [replacement sweep](workspace-cleanup.md#sweep)                                                                                                                                                                      |
| `/fork`                                                       | Start a new conversation in the current workspace without the original task; first write isolates from the current commit, [if it has one](workspace-admission.md#admission-and-isolation). Commit changes first to carry them |
| Confirmed replacement                                         | Stop the leaving session's shells and work; all replacements are refused while a checkout switch is pending or unconfirmed                                                                                                     |
| `/reload`                                                     | Keep lead shells observed; see [work cancellation](work.md#cancellation-and-session-changes) for attempts                                                                                                                      |
| `!`, `!!`, lead bash                                          | Run dev's shell in the conversation's workspace                                                                                                                                                                                |
| Any replacement or workspace switch under `dev --orb`         | Refused; the session keeps its orb and checkout until quit. See [orb](orb.md#tools)                                                                                                                                            |

### Model-visible messages

`/workspace` reports, sweep rows and tool results reach the model as minified JSON without repository, reservation or record identities, digests or timestamps. Use and operation IDs appear only in a reason, for the operations that block a checkout or may not have finished. `details` carry the full facts for [presentation](adr/0006-global-visual-layer.md).

| Source                                | Model-visible form                                                                                                                                                                                                       | `details`                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `/workspace` list and `inspect`       | `{repository, current, artifacts, checkouts}` or `{taskId, artifacts, checkouts}`; each checkout with task, path, head, origin, `result`, reason, `next`, and any uses (with a `run` ID if known) and pending operations | the `list` or `inspect` report with its views         |
| `/workspace check`                    | one guidance sentence, then `{taskId, checkouts}` with each verdict as one string such as `finished (nothing-left)`, its reasons, target (the destination branch), evidence, inventory, `remaining` and `next`           | the `check` report with its assessments               |
| Other `/workspace` answers and errors | the text itself                                                                                                                                                                                                          | none                                                  |
| Continuing a paused task              | one `dev/workspace` message: the join, that the user chose it, and the changed files left by earlier work, whose history the conversation does not hold                                                                  | none                                                  |
| Allocation or replacement sweep       | the moment, then only rows that changed something: removed or released workspaces, task artifacts and review-required failures; a reason only where review is required                                                   | `{kind: 'sweep', receipt}`                            |
| Checkout switch                       | the `dev/workspace-switch` follow-up described under [admission and isolation](workspace-admission.md#admission-and-isolation)                                                                                           | `{kind: 'switch', resumed, workspaceId, cwd, reason}` |

A receipt whose rows are all retained, skipped or deferred is a `dev/workspace-receipt` session entry with the same `details`, outside model context; only an extension's entry renderer draws it. An admission refused for review is likewise a `dev/workspace-refusal` entry `{kind: 'refusal', reason, endedTurn, next}`: the model already holds the reason in the refused call's result, which is all the transcript shows without an entry renderer. Without a UI, receipts, refusals and answers print as text on stderr.

The `workspace` tool returns its full result in `details`. The model reads `artifacts` as `{artifacts, path}` and `record-publication` as the verified file, its root, size, readback method and URL; `resume` returns `already-here` or `requested`; `artifacts: switch-requested` means no folder was created. A requested switch is not confirmed: dev reports where the conversation works once it completes, and the agent calls `artifacts` again there. When dev declines to request a switch, the refusal names why: the conversation is closing, its permission no longer matches it, dev cannot confirm an earlier switch or session change, its session or checkout changed meanwhile, or another switch or session change is in progress.
