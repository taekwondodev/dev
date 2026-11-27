# Security

Dev is a personal agent distro built on top of Pi, for one person. Its trust model is a design decision of the project and does not change to make dev safe for other users. If you install this repository, read this before launching it: dev trusts what you have installed around Pi and coordinates only the code that runs through it.

## Trusted base

Dev runs the following as trusted code, with the permissions of the account that launches it:

- The Pi release the pi.dev installer manages in `~/.pi/agent/install/` (`@earendil-works/pi-coding-agent` with its locked dependencies) and its native tools.
- Every extension, package, prompt and theme Pi loads from its global agent directory. Dev does not review, filter or sandbox them: whatever is installed there is trusted as your own. They load in the lead and in every child. Their presentation, status, notification and preference effects need no workspace admission.
- Dev's native N-API addon and its cached binaries, trusted like dev's TypeScript sources. See [Development](docs/DEVELOPMENT.md#native-addon) for build requirements and recovery.
- Dev's own extensions: the `work` tool, the `workspace` tool, the workspace host and the `read_url` reader. The lead also has Pi's extension loader load one dev file that holds the terminal interface module Pi itself uses and answers dev's request for it on Pi's event bus ([ADR 0002](docs/adr/0002-session-owned-background-work.md#pi-build)); it registers no tool, command or session event handler. Any extension of the trusted base can ask or answer on that bus. The reader runs in the lead and in every child, read-only children included. A child the lead authorized to coordinate gets a scoped `work` tool: every request it makes is admitted by the lead's controller, which takes the requester's identity from its IPC channel and never grants more than the coordinator's own access.
- Pi's native `codemode` extension in the lead and every child. Its QuickJS scripts reach the outside world only through tools, under the same admission as direct calls. A script cannot expand a read-only child's tool permissions or give an unreviewed tool the origin of an integrated one. Children's scripts have no model catalog.
- The installed Google Chrome and Chromium's own sandbox, used with a [profile copy](docs/web-read-security.md#browser-profile-copy) and dev's [network policy](docs/web-read-security.md#network-policy). Readers reach the browser owner through a private local socket; messages carry a URL and a deadline, never a profile path, executable or DevTools command. Directory and socket permissions with canonical-path and ownership checks establish an account boundary, not isolation from other software running as you.
- Project resources under `.pi/` of a folder you trusted through Pi's folder trust. A folder you have not trusted loads no project resources.
- The workflow skill library the launcher loads from `~/.agents/skills` when present, and the guidance and skill directories named by `profiles/manifest.json`, or by the installation's `config/default-profiles.json` while it is absent, or by the directory `DEV_PROFILES` selects. The manifest is validated data, not code.

Project tools, shells, native file operations and delegated children follow [workspace admission](docs/workspace-admission.md#admission-and-isolation) and the [native destination policy](docs/workspace-admission.md#native-writes). Selecting another checkout for delegation also selects that repository's instructions, skills and trusted project resources; it does not extend the lead's write authority. A native write into another repository loads none of that repository's instructions, skills or project resources.

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

Pi authentication lives in `~/.pi/agent/auth.json`, shared by Pi, dev and dev's children. Dev never copies it into its data home, prints it in diagnostics or records it in attempt outcomes. Command text is not copied into work records; Pi's tool-call history still records tool inputs, so commands reference credentials through the environment or existing tooling. A child's live activity names its running tool with a target only from an allowlist: a path, a search pattern, a Git operation, or a URL stripped of userinfo, query and fragment; `bash`, `codemode` and other tools send no argument text. Targets pass the same secret redaction as error text, and URL path segments of 20 or more characters that mix letters and digits, such as bot or webhook tokens, are redacted; other secrets in an allowed path or pattern can still show.

## Outside the protection

- No OS sandbox: read-only tools, workspace admission and process observation constrain cooperating dev participants, not arbitrary programs, Xcode, external terminals or code that a trusted extension runs.
- A read-only child is read-only only through its tool allowlist. Global extensions still initialize and run their event handlers in it, including while it reads the lead's or a coordinator's admitted workspace. A provider that runs its own agent, such as `pi-claude-bridge`, also brings that agent's configuration, including project configuration that Pi folder trust does not gate, and can reach tools outside the allowlist.
- A child runs with the lead's environment: `NODE_OPTIONS` and every other variable of the shell that launched dev reach it unchanged; the controller sets only the data home and the Pi agent directory.
- The browser owner's socket is private to your account, not to dev. Same-account processes can exhaust its connection capacity with status requests and deny new readers access. Rendering capacity is separate, so in-flight renders are unaffected. The [owner review](https://github.com/taekwondodev/dev/pull/146) records this accepted local denial-of-service limit.
- A process that detaches into its own session can escape observation; [workspace](docs/workspace-admission.md#process-uses-and-gates) describes the effect on its checkout. The browser owner has a separate [runtime lifetime](docs/ARCHITECTURE.md#ownership).
- During a removal, a process outside dev can move paths into the worktree and have them deleted with it; dev does not guarantee atomic filesystem containment against concurrent external changes.
- Git-ignoring `.dev/` and the data home's file permissions are not access control against other software running as your account.
- Recent acknowledged ownership metadata can be lost after a power failure, and not every loss is detectable.

## Reporting

This repository has one maintainer and no disclosure process. Open a GitHub issue in `taekwondodev/dev`.
