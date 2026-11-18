# Domain context

Dev is a personal agent distro built on Pi. This glossary defines the terms contributors use in code, documentation and task artifacts. [Architecture](docs/ARCHITECTURE.md) maps their owners; feature guides describe their behavior.

Text an agent reads while working on another repository does not use these terms. It uses the [outward vocabulary](AGENTS.md#text-the-model-reads), and so do the structured values that text carries. The note under each table names those values.

## Environment

| Term                        | Meaning                                                                                        |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| **Pi**                      | The coding agent and SDK dev integrates.                                                       |
| **Shared workflow library** | Common development guidance owned by `~/Developer/skills`, exposed through `~/.agents/skills`. |
| **Profile**                 | A selectable set of guidance and skills.                                                       |

Outward values: Pi keeps its product name; text an agent reads does not name the shared workflow library or profiles.

## Background work

| Term                 | Meaning                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Lead**             | The Pi conversation the user pairs with.                                                                              |
| **Controller**       | The part of dev that owns one lead's attempts.                                                                        |
| **Attempt**          | One command or child execution owned by a lead's controller, including a leaf started through a coordinator.          |
| **Child**            | A delegated Pi conversation in a separate process with a focused assignment, access level and dispatch selection.     |
| **Coordinator**      | A child authorized to delegate leaves for one assignment.                                                             |
| **Leaf**             | A coordinator's child, with no further delegation authority.                                                          |
| **Dispatch rule**    | A configured harness, model and effort selection for a skill or the default case.                                     |
| **Outcome**          | An attempt's settled status with the answer or output its controller observed.                                        |
| **Outcome delivery** | An attempt's outcome arriving in the conversation that started it, acknowledged on that conversation's active branch. |
| **Quiet notice**     | A report that a running command has stopped producing output, distinct from its outcome.                              |
| **Attempt summary**  | The compact operational view of an attempt returned to the caller.                                                    |
| **Inspection**       | The detailed view of an attempt's retained facts and output.                                                          |
| **Live view**        | The extension-facing view of a session's batch, running commands and blocking notices.                                |
| **Batch**            | The group of delegated children retained together in a live view.                                                     |

A `work` **task key** (`taskId`) is local to the controller. It is not the durable **workflow task** identity (`workflowTaskId`). [Work](docs/work.md) owns execution and delivery behavior; [dispatch](config/README.md) owns selection rules.

Outward values: an attempt is a `run` and a list of them is `runs`; a child, coordinator or leaf is an agent, and `coordinate: true` marks one that can delegate; an outcome is a result. An inspected run record names its owner `startedBy`, its controller process `devPid`, its write acquisition `writePermissionId` and its gate warning `lockWarning`.

## Workspace

| Term                                                            | Meaning                                                                                                                                                                                                                         |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Workflow task**                                               | A durable unit of work spanning conversations and attempts, with one or more workspaces.                                                                                                                                        |
| **Workspace**                                                   | A Git checkout used by a workflow task, pre-existing or allocated by dev.                                                                                                                                                       |
| **Managed worktree**                                            | A workspace allocated by the authority from a source checkout's commit and disposable after delivery.                                                                                                                           |
| **Workspace authority**                                         | The account-wide owner of reservations, uses, admission and release; its worker carries out each request.                                                                                                                       |
| **Workspace reservation**                                       | The durable association retaining a workspace for a task, independently of executions using it.                                                                                                                                 |
| **[Task artifact directory](docs/workspace.md#task-artifacts)** | The authority-owned directory for a task's files outside any checkout.                                                                                                                                                          |
| **[Admission](docs/workspace.md#admission-and-isolation)**      | The authority's decision, before execution, on whether a write, shell or work launch may proceed.                                                                                                                               |
| **Grant**                                                       | The read or write access admission gives one execution in one workspace.                                                                                                                                                        |
| **Write acquisition**                                           | An execution's exclusive right to write a workspace, with an identity distinct from prior acquisitions.                                                                                                                         |
| **Gate**                                                        | A lock dev holds on a checkout, a repository's structure or a conversation while it reads or changes it.                                                                                                                        |
| **Binding**                                                     | The workspace and task a conversation currently works in.                                                                                                                                                                       |
| **Attachment**                                                  | A running session's hold on its conversation and binding; a conversation attaches in one dev session at a time.                                                                                                                 |
| **Workspace handoff**                                           | The recorded switch of a conversation's binding to another workspace, from its request to the arrival there. Not a handoff note, the shared workflow's checkpoint between sessions.                                             |
| **Parked**                                                      | The state of a conversation whose workspace handoff, conversation replacement or worktree allocation is pending or unconfirmed, or whose grant no longer matches it; nothing new is admitted. Distinct from a paused workspace. |
| **[Paused workspace](docs/workspace.md#resume-paused-work)**    | A workspace a task reserves that nothing uses or leaves unresolved, offered for explicit resume.                                                                                                                                |
| **[Workspace use](docs/workspace.md#process-uses-and-gates)**   | The recorded presence of a conversation, operation or process.                                                                                                                                                                  |
| **[Target](docs/workspace.md#completion-evidence)**             | The branch a task's commits must reach to count as delivered, also called the integration target.                                                                                                                               |
| **Residue**                                                     | Tracked changes and untracked, non-ignored files left in a workspace.                                                                                                                                                           |
| **Completion verdict**                                          | A workspace's assessed role and either a finished rule or a retained reason.                                                                                                                                                    |
| **Sweep**                                                       | Dev's budgeted assessment and release of finished workspaces in a repository.                                                                                                                                                   |
| **Task release**                                                | The user's interactively confirmed clearing of every workspace a task reserves.                                                                                                                                                 |
| **[Cleanup evidence](docs/workspace.md#completion-evidence)**   | Recorded target and publication readback facts used alongside use, identity and structural checks.                                                                                                                              |

See [Workspace](docs/workspace.md) for admission, completion and release behavior.

Outward values: a workspace is a checkout, and reports list them as `checkouts`; a workspace handoff is a checkout switch (`switch`). A checkout's result is `paused` when a task reserves it and nothing uses or leaves it unresolved; only a `paused` checkout can be resumed. `idle` is the same clear state for a checkout no task reserves; a missing, unresolved, blocked or used checkout gets those results first, reserved or not. A parked conversation's refusals say whether a switch or session change is in progress, its grant no longer matches it, or dev cannot confirm a switch or session change. A managed worktree allocated for a delegated writer and without a branch has the role `agent`; its finished rule is `agent-delivered` only when a task PR proves delivery from its starting commit. A managed workspace has the finished rule `nothing-left` only when it holds no residue and no commits still to land. Residue is listed as `remaining`; a gate warning is `lockWarning`.

## Document reading

| Term              | Meaning                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| **Reader**        | A lead or child session's own URL retrieval, extraction and document snapshots.                    |
| **Browser owner** | The single dev runtime per data home owning the profile copy, Chrome, its policy and every render. |
| **Render**        | One reader's page tree in the shared browser, the unit of attribution, cancellation and teardown.  |
| **Profile copy**  | The dev-owned copy of the active Chrome profile used for authenticated rendering.                  |

[Read URL](docs/web-read.md) owns retrieval, rendering and revocation behavior.

Outward values: a reader is the `read_url` tool; renders and the profile copy appear as Chrome and a separate copy of the signed-in Chrome profile.
