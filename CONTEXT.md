# Domain Context

## Dev environment

`dev` is a personal agent distro built on top of Pi. Its purpose is to make the development loop easier to control across investigation, decisions, modification, builds, inspection, review and resume. The architecture and the use cases behind it are in [ARCHITECTURE](docs/ARCHITECTURE.md).

## Pi

[Pi](https://github.com/earendil-works/pi) is the coding agent dev is built on, and its integration target. This repository owns the Pi integration and configuration specific to `dev`; the Pi release active in the installer-managed installation is the reference for supported APIs.

## Shared workflow library

The shared workflow library is the repository at `~/Developer/skills`, exposed through `~/.agents/skills`. It owns common development workflow guidance, including `dev-cycle`, planning, implementation, review and writing guidance. This repository consumes that guidance rather than copying it.

## Profile

A profile is a selectable set of instructions, skills and domain resources for a development area, composed by the [launcher](docs/launcher.md). Apple development is one profile of `dev`, not the identity of the whole environment.

## Background work

**Lead**: the Pi conversation the user pairs with. It owns the work it starts and the leaves its coordinators start.

**Attempt**: one owned execution of a workflow task, identified by its lead session, task, attempt and generation, and by its parent attempt when a coordinator started it.

**Child**: a delegated Pi conversation running in a separate process with a focused assignment, `read-only` or `write` access, and a dispatch choice.

**Coordinator**: a child the lead authorized, for one assignment, to start leaf children through a scoped `work` tool.

**Leaf**: a child started by a coordinator. It cannot delegate, and its outcome is delivered to its coordinator.

**Dispatch rule**: an entry of `config/crew-dispatch.json`, keyed by skill name, mapping that skill to a harness, model and effort. The file's `default` applies to a prompt that invokes no configured skill.

**Outcome delivery**: the arrival of an attempt's result in the conversation that started it, the lead's or a coordinator's, acknowledged on that conversation's active branch.

Behavior is in [work](docs/work.md).

## Workspace

The [ownership](https://github.com/taekwondodev/dev/issues/28#issuecomment-5795841426), [disposable-worktree delivery](https://github.com/taekwondodev/dev/issues/42) and [automatic release](https://github.com/taekwondodev/dev/issues/44) contracts define these terms.

**Workflow task**: a unit of work whose identity can span Pi conversations and execution attempts, with one or more associated workspaces.

**Workspace**: a Git checkout used by a workflow task, pre-existing or allocated by dev.

**Managed worktree**: a workspace dev allocated for a task, inside the workspace authority, from the exact current commit of the lead checkout. Disposable once its work is delivered.

**Workspace reservation**: the durable association that retains a workspace for a workflow task independently of the executions using it.

**Write acquisition**: an execution's exclusive right to write to one workspace, with an identity distinct from previous acquisitions of that workspace.

**Workspace use**: the recorded presence of a conversation, operation or process in one workspace. A process use ends only when its process family is observed gone; an `unknown` use keeps its workspace blocked for writers until explicit recovery.

**Completion verdict**: the role of a reserved workspace (pre-existing checkout, branch worktree, delegated child or detached worktree) and either the finished rule that lets it be released or the reason it is retained, decided from facts dev records or observes, never from a workflow declaration.

**Sweep**: the release of every finished workspace of a repository, run by dev itself when the user quits and before it allocates a managed worktree, one fenced attempt per finished workspace under a time budget.

**Task release**: an explicit, confirmed user instruction to attempt the reserved workspaces of one task, kept for the cases the sweep leaves `review-required`. One confirmed command makes one fenced attempt per workspace.

**Cleanup evidence**: the target override and the exact publication readback recorded through the `workspace` tool, in addition to the use, identity and structural checks. Source ancestry within an independently bound merged pull request can cover an intermediate commit; it does not prove that dirty edits were delivered.

Behavior, commands and exit codes are in [workspace](docs/workspace.md); the enduring constraints are in [ADR 0005](docs/adr/0005-scoped-runtime-coordination.md).
