# Domain context

Dev is a personal agent distro built on Pi. This glossary defines the terms contributors use in code, documentation and task artifacts. [Architecture](docs/ARCHITECTURE.md) maps their owners; feature guides describe their behavior.

Text an agent reads while working on another repository, including the structured values it carries, and text dev prints for the user use the [outward vocabulary](scripts/model-text-terms.ts) instead of these terms.

## Environment

| Term                        | Meaning                                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Pi**                      | The coding agent and SDK dev integrates.                                                                       |
| **Shared workflow library** | Common development guidance owned by the `taekwondodev/skills` repository, exposed through `~/.agents/skills`. |
| **Profile**                 | A selectable set of guidance and skills.                                                                       |

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

## Orb

| Term           | Meaning                                                                                                                                                               |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Orb**        | An ephemeral machine orbit creates in an OpenStack project, on which the tools of a `dev --orb` session or of its writing child run over SSH.                         |
| **Orb record** | Dev's registry entry for one orb in the data home: its state, key, pinned host keys and owner lock.                                                                   |
| **Spare orb**  | An orb dev creates ahead of the launch that uses it, one per data home, recorded without a checkout until a launch or a writing child takes it.                       |
| **Return**     | The admitted write that brings an orb's commits and working-tree changes back into the Mac checkout or worktree, or onto a `dev/orb-return/` branch when it diverges. |
| **Recovery**   | The startup step of `dev --orb` that brings the work of orbs left by ended sessions to `dev/orb-recovery/` branches and deletes those orbs.                           |

[Orb](docs/orb.md) owns startup, tools, return, quit and recovery behavior.

## Document reading

| Term              | Meaning                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| **Reader**        | A lead or child session's own URL retrieval, extraction and document snapshots.                    |
| **Browser owner** | The single dev runtime per data home owning the profile copy, Chrome, its policy and every render. |
| **Render**        | One reader's page tree in the shared browser, the unit of attribution, cancellation and teardown.  |
| **Profile copy**  | The dev-owned copy of the active Chrome profile used for authenticated rendering.                  |

[Read URL](docs/web-read.md) owns retrieval, rendering and revocation behavior.
