# Domain Context

## Dev environment

`dev` is a personal, terminal-first development environment built on Pi.
Its purpose is to make the development loop easier to control across
investigation, decisions, modification, builds, inspection, review, and resume.

## Pi

Pi is the runtime and integration target for this repository. This repository
owns the Pi integration and configuration that are specific to `dev`. Verify
the installed Pi version and supported APIs before choosing an integration.

## Shared workflow library

The shared workflow library is the repository at `~/Developer/skills`, exposed
through `~/.agents/skills`. It owns common development workflow guidance,
including `dev-cycle`, planning, implementation, review, and writing guidance.
This repository consumes that guidance rather than copying or redefining it.

## Profile

A profile is a selectable set of instructions, skills, and domain
resources for a particular development area. Apple development is an important
profile of `dev`, not the identity of the whole environment.

Existing Apple-specific guidance is associated with the existing `apple-dev`
profile. Its ownership and paths must be checked before any migration.

## Workspace ownership vocabulary

The approved [ownership](https://github.com/taekwondodev/dev/issues/28#issuecomment-5795841426)
and [cleanup](https://github.com/taekwondodev/dev/issues/29#issuecomment-5796162017)
contracts define these terms. The workspace lifecycle implements admission,
reservations, conversation bindings and recovery facts; task release and
worktree removal are not implemented yet.

**Workflow task**: A unit of work whose identity can span Pi conversations and
execution attempts, with one or more associated workspaces.

**Workspace**: A Git checkout used by a workflow task, whether pre-existing or
allocated by dev.

**Workspace reservation**: The durable association that retains a workspace for
a workflow task independently of the executions using it.

**Write acquisition**: An execution's exclusive right to write to one workspace,
with an identity distinct from previous acquisitions of that workspace.

**Workspace use**: The recorded presence of a conversation, operation or process
in one workspace. A process use ends only when its process family is observed
gone; an `unknown` use keeps its workspace blocked for writers until explicit
recovery.

**Task release**: An explicit user instruction to evaluate a workflow task's
reserved workspaces for reservation release or safe removal, not a guarantee
that either operation can proceed.

## Background work

An attempt is one owned execution of a workflow task, identified by its lead
session, task, attempt and generation. The operational controller observes
process facts; it does not decide workflow progression or certify artifacts.
Pi owns conversations, and shared dev-cycle owns delegation and recovery policy.
Read [ADR 0002](docs/adr/0002-session-owned-background-work.md) before changing
process ownership, resource boundaries or outcome delivery.
Read [ADR 0004](docs/adr/0004-authoritative-lifecycle-incremental-store.md)
before changing lifecycle authority, operational storage, revisions or retention.
Read [ADR 0005](docs/adr/0005-scoped-runtime-coordination.md) before changing
concurrent launcher admission, conversation claims or maintenance barriers, and
its [scoped workspace operations](docs/adr/0005-scoped-runtime-coordination.md#scoped-workspace-operations)
before changing workspace admission, shells, native writes or the lead's tool gate.
Read its [executable-extension policy](docs/adr/0005-scoped-runtime-coordination.md#executable-extensions)
before adding or updating extensions, changing resource loading or routing
project effects through tools, event handlers or child processes.

## Configuration and private state

The dev checkout versions its dispatch policy in `config/crew-dispatch.json`.
Private dev runtime data lives in checkout-local `.dev/`, excluded from Git;
explicit data-home overrides change private storage only. Pi authentication is
account-wide and lives in the canonical global `~/.pi/agent/auth.json`, shared by
global Pi and dev. See
[ADR 0003](docs/adr/0003-versioned-dispatch-local-runtime.md) before changing
these paths or their migration and version-control boundaries.
