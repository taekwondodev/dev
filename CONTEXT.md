# Domain context

Dev is a personal agent distro built on Pi. This glossary defines terms used in code, documentation and task artifacts. [Architecture](docs/ARCHITECTURE.md) maps their owners; feature guides describe their behavior.

## Environment

| Term                        | Meaning                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Pi**                      | The coding agent and SDK dev integrates.                                                                |
| **Shared workflow library** | Common development guidance owned by `~/Developer/skills`, exposed through `~/.agents/skills`.          |
| **Profile**                 | A selectable set of guidance and skills. Apple is one of the owner's profiles, not the identity of dev. |

## Background work

| Term                 | Meaning                                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Lead**             | The Pi conversation the user pairs with.                                                                             |
| **Attempt**          | One command or child execution owned by a lead's controller, including a leaf started through a coordinator.         |
| **Child**            | A delegated Pi conversation in a separate process with a focused assignment, access level and dispatch selection.    |
| **Coordinator**      | A child authorized to delegate leaves for one assignment.                                                            |
| **Leaf**             | A coordinator's child, with no further delegation authority.                                                         |
| **Dispatch rule**    | A configured harness, model and effort selection for a skill or the default case.                                    |
| **Outcome delivery** | An attempt's result arriving in the conversation that started it, acknowledged on that conversation's active branch. |

A `work` **task key** (`taskId`) is local to the controller. It is not the durable **workflow task** identity (`workflowTaskId`). [Work](docs/work.md) owns execution and delivery behavior; [dispatch](config/README.md) owns selection rules.

## Workspace

| Term                                                          | Meaning                                                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Workflow task**                                             | A durable unit of work spanning conversations and attempts, with one or more workspaces.                |
| **Workspace**                                                 | A Git checkout used by a workflow task, pre-existing or allocated by dev.                               |
| **Managed worktree**                                          | A workspace allocated by the authority from a source checkout's commit and disposable after delivery.   |
| **Workspace reservation**                                     | The durable association retaining a workspace for a task, independently of executions using it.         |
| **Write acquisition**                                         | An execution's exclusive right to write a workspace, with an identity distinct from prior acquisitions. |
| **[Workspace use](docs/workspace.md#process-uses-and-gates)** | The recorded presence of a conversation, operation or process.                                          |
| **Completion verdict**                                        | A workspace's assessed role and either a finished rule or a retained reason.                            |
| **Sweep**                                                     | Dev's budgeted assessment and release of finished workspaces in a repository.                           |
| **Task release**                                              | The user's interactively confirmed clearing of every workspace a task reserves.                         |
| **[Cleanup evidence](docs/workspace.md#completion-evidence)** | Recorded target and publication readback facts used alongside use, identity and structural checks.      |

See [Workspace](docs/workspace.md) for admission, completion and release behavior.
