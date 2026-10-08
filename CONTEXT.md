# Domain context

Dev is a personal agent distro built on Pi. This glossary defines the vocabulary used by its code, docs and workflow artifacts. For ownership and tradeoffs, read [ARCHITECTURE](docs/ARCHITECTURE.md).

## Environment

| Term                        | Meaning                                                                                                                                                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pi**                      | The coding agent and SDK dev integrates. The active pi.dev-managed release is the API reference.                                                                                                                           |
| **Shared workflow library** | Common development guidance owned by `~/Developer/skills`, exposed through `~/.agents/skills`. Dev consumes it rather than copying its rules.                                                                              |
| **Profile**                 | A selectable set of guidance and skills, defined in the installation's untracked `profiles/manifest.json` and composed by the [launcher](docs/launcher.md). Apple is one of the owner's profiles, not the identity of dev. |

## Background work

| Term                 | Meaning                                                                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Lead**             | The Pi conversation the user pairs with. It owns its attempts, including leaves started by its coordinators.                                         |
| **Attempt**          | One execution, identified by lead session, controller-local task, attempt and generation, plus a parent attempt for a leaf.                          |
| **Child**            | A delegated Pi conversation in a separate process, with a focused assignment, access level and dispatch choice.                                      |
| **Coordinator**      | A child authorized by the lead to delegate leaf children for one assignment through a scoped `work` tool.                                            |
| **Leaf**             | A coordinator's child. It cannot delegate; its outcome goes to the coordinator.                                                                      |
| **Dispatch rule**    | A skill-keyed harness, model and effort selection in `config/crew-dispatch.json`. The `default` applies when the prompt invokes no configured skill. |
| **Outcome delivery** | An attempt's result arriving in the conversation that started it, acknowledged on that conversation's active branch.                                 |

The `work` tool's `taskId` is a controller-local key, not the durable workflow-task identity. See [work](docs/work.md) for execution and delivery behavior.

## Workspace

| Term                      | Meaning                                                                                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Workflow task**         | A unit of work whose durable identity spans conversations and attempts, with one or more workspaces.                                                                                     |
| **Workspace**             | A Git checkout used by a workflow task, pre-existing or allocated by dev.                                                                                                                |
| **Managed worktree**      | A workspace allocated inside the authority from the exact current commit of its source checkout, the lead's or another checkout named for a delegation. It is disposable once delivered. |
| **Workspace reservation** | The durable association retaining a workspace for a task, independently of executions using it.                                                                                          |
| **Write acquisition**     | An execution's exclusive right to write a workspace, with an identity distinct from prior acquisitions.                                                                                  |
| **Workspace use**         | The recorded presence of a conversation, operation or process. A process use ends only when its family is observed gone; an `unknown` use blocks writers.                                |
| **Completion verdict**    | A workspace's role and either a finished rule or a retained reason, derived from recorded or observed facts rather than a workflow declaration.                                          |
| **Sweep**                 | Dev's budgeted assessment and release of finished workspaces in a repository, at quit and before managed allocation.                                                                     |
| **Task release**          | The user's interactively confirmed clearing of every workspace a task reserves, whatever the sweep verdict.                                                                              |
| **Cleanup evidence**      | Recorded target and publication readback facts, combined with use, identity and structural checks. Source-history inclusion does not prove delivery of dirty edits.                      |

[Workspace](docs/workspace.md) owns commands and release behavior. [ADR 0005](docs/adr/0005-scoped-runtime-coordination.md) records the ownership and disposal constraints.
