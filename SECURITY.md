# Security

Dev is a personal agent distro built on top of Pi, for one person. Its trust model is a design decision of the project and does not change to make dev safe for other users. If you install this repository, read this before launching it: dev trusts what you have installed around Pi and coordinates only the code that runs through it.

## Trusted base

Dev runs the following as trusted code, with the permissions of the account that launches it:

- The Pi release the pi.dev installer manages in `~/.pi/agent/install/` (`@earendil-works/pi-coding-agent` with its locked dependencies) and its native tools.
- Every extension, package, prompt and theme Pi loads from its global agent directory. Dev does not review, filter or sandbox them: whatever is installed there is trusted as your own. They load in the lead and in every child, read-only children included. Their presentation, status, notification and preference effects need no workspace admission.
- Dev's own extensions: the `work` tool, the `workspace` tool and the workspace host. A child the lead authorized to coordinate gets a scoped `work` tool: every request it makes is admitted by the lead's controller, which takes the requester's identity from its IPC channel and never grants more than the coordinator's own access.
- Project resources under `.pi/` of a folder you trusted through Pi's folder trust. They load as Pi loads them, before workspace admission. A folder you have not trusted loads no project resources.
- The workflow skill library the launcher requires at `~/.agents/skills`, and the guidance and skill directories named by the untracked `profiles/manifest.json`, or by the directory `DEV_PROFILES` selects. The manifest is validated data, not code.

The lead's project tools, shells, native file operations and delegated children require [workspace admission](docs/workspace.md#behavior). Native write/edit classify destinations first; ordinary external files use the [native destination policy](docs/workspace.md#native-writes), without acquiring cross-session ownership or cleanup permission.

Trusted project-resource initialization is an explicit exception to the initialization refusal below: Pi folder trust permits it before workspace admission. This accepts the user's own project code as trusted, not contained. It does not exempt integrated project tool effects from admission. [ADR 0005](docs/adr/0005-scoped-runtime-coordination.md#executable-extensions) records this boundary.

## Adding or updating an extension

Before enabling an extension, or accepting an update that changes its effects:

1. Identify project writes, shell execution, child processes, initialization effects and event handlers that can run before the tool guard, user-bash handlers included.
2. Keep UI, status and preference effects outside the project out of workspace admission when the extension's actual behavior supports that classification.
3. Route declared project effects through the scoped workspace operation, with their lifecycle and descendants. A tool name, a trusted label or a successful load is not evidence.
4. Enable no unintegrated project writer. Initialization that can touch the project before admission is deferred or refused before it runs; a guard installed after loading is insufficient.
5. Verify the changed effect path and event ordering through the real integration.

Pi asks extensions about a `!` command in load order and takes the first answer, so a global extension that answers first bypasses dev's shell. Check for a `user_bash` handler before installing one.

## Credentials

Pi authentication lives in `~/.pi/agent/auth.json`, shared by Pi, dev and dev's children. Dev never copies it into its data home, prints it in diagnostics or records it in attempt outcomes. Command text is not copied into work records; Pi's tool-call history still records tool inputs, so commands reference credentials through the environment or existing tooling.

## Outside the protection

- No OS sandbox: read-only tools, workspace admission and process observation constrain cooperating dev participants, not arbitrary programs, Xcode, external terminals or code that a trusted extension runs.
- A read-only child is read-only only through its tool allowlist. Global extensions still initialize and run their event handlers in it, including while it reads the lead's or a coordinator's admitted workspace. A provider that runs its own agent, such as `pi-claude-bridge`, also brings that agent's configuration, including project configuration that Pi folder trust does not gate, and can reach tools outside the allowlist.
- A child runs with the lead's environment: `NODE_OPTIONS` and every other variable of the shell that launched dev reach it unchanged; the controller sets only the data home and the Pi agent directory.
- A process that detaches into its own session escapes observation; what a lost observation does to its checkout is in [workspace](docs/workspace.md#behavior).
- During a removal, a process outside dev can move paths into the worktree and have them deleted with it; dev does not guarantee atomic filesystem containment against concurrent external changes. Stop independently started tools and avoid external edits while a release runs.
- Git-ignoring `.dev/` and the data home's file permissions are not access control against other software running as your account.
- Recent acknowledged ownership metadata can be lost after a power failure, and not every loss is detectable.

## Reporting

This repository has one maintainer and no disclosure process. Open a GitHub issue in `taekwondodev/dev`.
