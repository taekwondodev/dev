# Security

Dev is a personal agent distro built on top of Pi, for one person. Its trust model is a design decision of the project and does not change to make dev safe for other users. If you install this repository, read this before launching it: dev trusts what you have installed around Pi and coordinates only the code that runs through it.

## Trusted base

Dev runs the following as trusted code, with the permissions of the account that launches it:

- The Pi release the pi.dev installer manages in `~/.pi/agent/install/` (`@earendil-works/pi-coding-agent` with its locked dependencies) and its native tools.
- Every extension, package, prompt and theme Pi loads from its global agent directory. Dev does not review, filter or sandbox them: whatever is installed there is trusted as your own. They load in the lead and in every child, read-only children included. Their presentation, status, notification and preference effects need no workspace admission.
- Dev's own extensions: the `work` tool, the `workspace` tool, the workspace host and the `read_url` reader. The reader runs in the lead and in every child, read-only children included. A child the lead authorized to coordinate gets a scoped `work` tool: every request it makes is admitted by the lead's controller, which takes the requester's identity from its IPC channel and never grants more than the coordinator's own access.
- Pi's native `codemode` extension, registered by the launcher in the lead and by the child runner in every child. Its scripts run in Pi's QuickJS sandbox and reach the outside world only through tools; every nested tool call passes the same admission as a direct call, so an unreviewed tool stays blocked inside a script, a read-only child cannot write or run a shell from a script, and a tool whose name collides with an integrated one does not inherit its origin. Children's scripts get no model catalog. Codemode is a used Pi surface for upgrade review.
- The installed Google Chrome, launched headless by dev's browser owner with a dev-owned copy of your Chrome profile ([browser profile copy](#browser-profile-copy)). Chrome itself and the pages it renders are not sandboxed by dev beyond the network policy. The owner is a separate dev runtime that every reader of a data home reaches over a private local socket; its messages carry a URL and a deadline, never a profile path, an executable or a DevTools command. Private directory and socket permissions with canonical-path and ownership checks are the account boundary; they do not sandbox other software running as you.
- Project resources under `.pi/` of a folder you trusted through Pi's folder trust. They load as Pi loads them, before workspace admission. A folder you have not trusted loads no project resources.
- The workflow skill library the launcher requires at `~/.agents/skills`, and the guidance and skill directories named by the untracked `profiles/manifest.json`, or by the directory `DEV_PROFILES` selects. The manifest is validated data, not code.

Project tools, shells, native file operations and delegated children follow [workspace admission](docs/workspace.md#admission-and-isolation) and the [native destination policy](docs/workspace.md#native-writes). Selecting another checkout for delegation also selects that repository's instructions, skills and trusted project resources; it does not extend the lead's write authority.

Trusted project-resource initialization is an explicit exception to the initialization refusal below: Pi folder trust permits it before workspace admission. This accepts the user's own project code as trusted, not contained. It does not exempt integrated project tool effects from admission. [ADR 0005](docs/adr/0005-scoped-runtime-coordination.md#executable-extensions) records this boundary.

## Adding or updating an extension

Before enabling an extension, or accepting an update that changes its effects:

1. Identify project writes, shell execution, child processes, initialization effects and event handlers that can run before the tool guard, user-bash handlers included.
2. Keep UI, status and preference effects outside the project out of workspace admission when the extension's actual behavior supports that classification.
3. Route declared project effects through the scoped workspace operation, with their lifecycle and descendants. A tool name, a trusted label or a successful load is not evidence.
4. Enable no unintegrated project writer. Initialization that can touch the project before admission is deferred or refused before it runs; a guard installed after loading is insufficient.
5. Verify the changed effect path and event ordering through the real integration.

Pi asks extensions about a `!` command in load order and takes the first answer, so a global extension that answers first bypasses dev's shell. Check for a `user_bash` handler before installing one.

## Browser profile copy

`read_url` renders JavaScript-dependent or login-gated pages with the installed Chrome and a copy of your active Chrome profile under `<data-home>/browser/user-data/`. This deliberately gives the lead and every child your logged-in sessions: pages behind your accounts become readable, and an authenticated visit can have site-side effects. Isolation from the live profile protects your running Chrome, not your anonymity. One browser owner per data home shares that authenticated Chrome across sessions, so cookies and site storage are shared by every reader; owning separate pages isolates results and cleanup, not account state.

- The source profile is only read: cookies are snapshotted through SQLite; preferences, HSTS state (`Network/TransportSecurity`) and web storage are copied; passwords and other databases are not. Dev never opens the live profile, its tabs or its lock files, and never closes your Chrome.
- The copy is retained across sessions with restrictive permissions and refreshed before each fresh launch. While the browser owner is alive, the profile lock prevents anything from overwriting or deleting the copy, including when browser shutdown could not be verified. Unsettled shutdown information is retained only in memory, reported by `dev browser`, and retried on a later render or lifecycle operation. An owner exit or crash releases its kernel locks regardless of surviving Chrome helpers; this is an accepted lifecycle limit, not proof that the copy is safe to reuse. See [browser recovery](docs/web-read.md#revocation).
- Only public http(s) destinations are admitted. Static retrieval validates DNS answers and pins connections; browser subrequests, from pages, frames, dedicated workers and nested workers alike, have their URLs and DNS answers checked at the browser-wide DevTools interception, and requests failing those checks are blocked before connecting; requests left undecided at the end of a render are refused, never released, and page scripts are stopped before teardown so unload-time requests, which bypass interception, cannot be issued. Channels that interception does not see are removed: `WebSocket`, `RTCPeerConnection` and `WebTransport` from pages and dedicated workers, `SharedWorker` and `navigator.serviceWorker` from pages, unproxied WebRTC UDP by flag. Downloads are denied. Chrome's own resolution is not pinned, a `preconnect` hint to a private address still opens a data-less TCP handshake, and profile or background traffic that bypasses interception is a limitation, not permission. Chrome runs with sync, extensions, component updates and background networking disabled and ignores system proxy settings.
- Cookie values stay out of results, logs and diagnostics, and the owner reports only operational counts and errors, never document text belonging to another reader. The rendered text of an authenticated page is an ordinary tool result and stays in the session history of whichever lead or child read it.
- `dev browser revoke` disables further authenticated rendering first, drains reads already running without cancelling them, and deletes only dev's copy after its browser settles; an expired wait or an unverified shutdown keeps the copy and says so. The `disabled` marker and the copy live in the data home; the Chrome profile and the Hermes copy, if any, are never altered.

[Read URL](docs/web-read.md) owns the behavior and limits.

## Credentials

Pi authentication lives in `~/.pi/agent/auth.json`, shared by Pi, dev and dev's children. Dev never copies it into its data home, prints it in diagnostics or records it in attempt outcomes. Command text is not copied into work records; Pi's tool-call history still records tool inputs, so commands reference credentials through the environment or existing tooling.

## Outside the protection

- No OS sandbox: read-only tools, workspace admission and process observation constrain cooperating dev participants, not arbitrary programs, Xcode, external terminals or code that a trusted extension runs.
- A read-only child is read-only only through its tool allowlist. Global extensions still initialize and run their event handlers in it, including while it reads the lead's or a coordinator's admitted workspace. A provider that runs its own agent, such as `pi-claude-bridge`, also brings that agent's configuration, including project configuration that Pi folder trust does not gate, and can reach tools outside the allowlist.
- A child runs with the lead's environment: `NODE_OPTIONS` and every other variable of the shell that launched dev reach it unchanged; the controller sets only the data home and the Pi agent directory.
- The browser owner's socket is private to your account, not to dev. A process running as you can connect to it and keep a connection open with valid status requests without ever rendering; eighty such connections fill the owner's connection limit and no new reader can connect until they close or the owner exits. Rendering slots are counted separately and renders in progress are unaffected. Nothing leaks and nothing is corrupted; this is a same-account local denial of service, accepted under the no-sandbox boundary above.
- A process that detaches into its own session escapes observation; what a lost observation does to its checkout is in [workspace](docs/workspace.md#behavior). Dev's browser owner is deliberately such a process: it is a registered runtime holding its own installation claim, not a delegated attempt, and it never takes a project writer or workspace use.
- Chrome rendering trusts the installed Chrome and Chromium's own sandbox. Dev checks subrequest URLs and DNS answers at the DevTools interception point, but Chrome resolves hostnames independently when connecting. Browser DNS rebinding is an accepted protection limit: an admitted public hostname can later resolve to a private address, potentially reaching local or LAN services if Chrome's own protections permit it. This is a known enforcement gap, not a demonstrated exploit on the supported Chrome configuration. Traffic Chrome does not route through interception is also outside dev's enforcement. Static retrieval pins its connections and does not share this DNS gap.
- During a removal, a process outside dev can move paths into the worktree and have them deleted with it; dev does not guarantee atomic filesystem containment against concurrent external changes. Stop independently started tools and avoid external edits while a release runs.
- Git-ignoring `.dev/` and the data home's file permissions are not access control against other software running as your account.
- Recent acknowledged ownership metadata can be lost after a power failure, and not every loss is detectable.

## Reporting

This repository has one maintainer and no disclosure process. Open a GitHub issue in `taekwondodev/dev`.
