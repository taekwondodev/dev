# Security

Dev is a personal development environment for one user on one macOS account. Its trust model is a design decision: dev trusts the code the user installs and coordinates the code that runs through it. This does not change to make dev safe for other users.

## Trusted base

Dev runs the following as trusted code, with the user's permissions:

- The installed global Pi (`@earendil-works/pi-coding-agent`) and its native tools.
- The global extensions in `~/.pi/agent/extensions`: `calm`, `dev-agent-sound.ts`, `herdr-agent-state.ts` and `terminal-status-title.js`. They are the user's own. Their presentation, status, notification and preference effects stay outside workspace admission.
- Dev's own extensions: the `work` tool, the `workspace` tool and the workspace host.
- Project resources under `.pi/` of a folder the user trusted through Pi's folder trust. They load as Pi loads them, before workspace admission. A folder the user has not trusted loads no project resources.
- The shared skill library at `~/Developer/skills`, exposed through `~/.agents/skills`, and the profile skills under `profiles/`.

Trust does not exempt project writes: a write to a repository by the lead, a shell, a native file operation or a delegated child is admitted by the workspace authority first ([workspace](docs/workspace.md#behavior)).

## Adding or updating an extension

Before enabling an extension, or accepting an update that changes its effects:

1. Identify project writes, shell execution, child processes, initialization effects and event handlers that can run before the tool guard, user-bash handlers included.
2. Keep UI, status and preference effects outside the project out of workspace admission when the extension's actual behavior supports that classification.
3. Route declared project effects through the scoped workspace operation, with their lifecycle and descendants. A tool name, a trusted label or a successful load is not evidence.
4. Enable no unintegrated project writer. Initialization that can touch the project before admission is deferred or refused before it runs; a guard installed after loading is insufficient.
5. Verify the changed effect path and event ordering through the real integration.

Pi asks extensions about a `!` command in load order and takes the first answer, so a global extension answering first would bypass dev's shell. None installed does; step 1 covers any added later.

## Credentials

Pi authentication lives in `~/.pi/agent/auth.json`, shared by global Pi, dev and dev's children. Dev never copies it into its data home, prints it in diagnostics or records it in attempt outcomes. Command text is not copied into work records; Pi's tool-call history still records tool inputs, so commands reference credentials through the environment or existing tooling.

## Outside the protection

- No OS sandbox: read-only tools, workspace admission and process observation constrain cooperating dev participants, not arbitrary programs, Xcode, external terminals or code that a trusted extension runs.
- A process that detaches into its own session escapes observation; what a lost observation does to its checkout is in [workspace](docs/workspace.md#behavior).
- During a release, a process outside dev can move a selected file's parent and redirect the deletion; dev does not guarantee atomic filesystem containment against concurrent external changes. Stop independently started tools and avoid external edits while a release runs.
- Git-ignoring `.dev/` and the data home's file permissions are not access control against other software running as the user.
- Recent acknowledged ownership metadata can be lost after a power failure, and not every loss is detectable.

## Reporting

This repository has one user and no disclosure process. A finding is a GitHub issue in `taekwondodev/dev`.
