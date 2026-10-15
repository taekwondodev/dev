# Security

Dev is a personal agent distro built on top of Pi, for one person. Its trust model is a design decision of the project and does not change to make dev safe for other users. If you install this repository, read this before launching it: dev trusts what you have installed around Pi and coordinates only the code that runs through it.

## Trusted base

Dev runs the following as trusted code, with the permissions of the account that launches it:

- The Pi release the pi.dev installer manages in `~/.pi/agent/install/` (`@earendil-works/pi-coding-agent` with its locked dependencies) and its native tools.
- Every extension, package, prompt and theme Pi loads from its global agent directory. Dev does not review, filter or sandbox them: whatever is installed there is trusted as your own. They load in the lead and in every child, read-only children included. Their presentation, status, notification and preference effects need no workspace admission.
- Dev's own extensions: the `work` tool, the `workspace` tool, the workspace host and the `read_url` reader. The reader runs in the lead and in every child, read-only children included. A child the lead authorized to coordinate gets a scoped `work` tool: every request it makes is admitted by the lead's controller, which takes the requester's identity from its IPC channel and never grants more than the coordinator's own access.
- Pi's native `codemode` extension in the lead and every child. Its QuickJS scripts reach the outside world only through tools, under the same admission as direct calls. A script cannot expand a read-only child's tool permissions or give an unreviewed tool the origin of an integrated one. Children's scripts have no model catalog.
- The installed Google Chrome and Chromium's own sandbox, used with a [profile copy](#browser-profile-copy) and dev's [network policy](#network-policy). Readers reach the browser owner through a private local socket; messages carry a URL and a deadline, never a profile path, executable or DevTools command. Directory and socket permissions with canonical-path and ownership checks establish an account boundary, not isolation from other software running as you.
- Project resources under `.pi/` of a folder you trusted through Pi's folder trust. They load as Pi loads them, before workspace admission. A folder you have not trusted loads no project resources.
- The workflow skill library the launcher requires at `~/.agents/skills`, and the guidance and skill directories named by the untracked `profiles/manifest.json`, or by the directory `DEV_PROFILES` selects. The manifest is validated data, not code.

Project tools, shells, native file operations and delegated children follow [workspace admission](docs/workspace.md#admission-and-isolation) and the [native destination policy](docs/workspace.md#native-writes). Selecting another checkout for delegation also selects that repository's instructions, skills and trusted project resources; it does not extend the lead's write authority. A lead native write into another repository reserves that checkout through its authority and loads none of its resources.

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

`read_url` deliberately gives the lead and every child your logged-in Chrome sessions. Authenticated visits can have site-side effects; separate pages isolate results and cleanup, not cookies or site storage. The copy protects your running Chrome, not your anonymity.

- Dev reads the active profile selected by Chrome's `Local State`. It copies a SQLite snapshot of cookies, preferences, HSTS state and web storage, not passwords or other databases. It never opens the live profile in a browser, accesses its tabs or lock files, or closes your Chrome.
- The installed Chrome and the account's macOS Keychain decrypt the copy's cookies. Chrome receives the account home from the user database rather than an inherited `HOME`, because macOS locates the login keychain there.
- The retained copy has restrictive permissions. A live owner's profile lock prevents refresh or deletion until Chrome and its observed helpers are verified gone. Owner death releases that lock even if helpers survive; the retained owner record blocks reuse but is not proof of liveness or automatic orphan recovery. Follow [browser recovery](docs/web-read.md#recovery-after-owner-death).
- Cookie values stay out of results, logs and diagnostics. The owner exposes operational counts and errors, not another reader's document text. Rendered text is an ordinary tool result retained in the reading lead's or child's session history.
- Revocation affects only this data home's rendering and copy, never your source Chrome profile or another application's copy. In-flight reads drain rather than being cancelled. [Read URL](docs/web-read.md#revocation) owns the procedure and uncertain-outcome handling.

### Network policy

Only public http(s) destinations are admitted. Credential-bearing URLs, non-public host names and private or reserved addresses are refused. Static retrieval validates every DNS answer, rejects the entire answer if any address is disallowed, pins the connection to a validated address and checks each redirect again.

Browser requests from pages, frames, dedicated workers and nested workers pass URL and DNS checks at browser-wide DevTools interception, including redirected hops. Unattributed or undecided requests are refused; page scripts stop before teardown to prevent unload-time requests bypassing interception. Channels outside that interception are disabled: `WebSocket`, `RTCPeerConnection` and `WebTransport` in pages and dedicated workers, `SharedWorker` and `navigator.serviceWorker` in pages, and unproxied WebRTC UDP. Downloads are denied. Chrome runs with sync, extensions, component updates and background networking disabled and ignores system proxy settings.

Browser enforcement has accepted limits:

- Chrome resolves hostnames independently after admission. DNS rebinding may therefore reach private services if Chrome's own protections permit it; dev makes no containment guarantee. Static retrieval does not share this gap.
- A private-address `preconnect` can open a data-less TCP handshake. Profile or background traffic outside interception is outside dev's enforcement.
- Removing `WebTransport` has not been verified on an HTTPS page. The [reader review](https://github.com/taekwondodev/dev/pull/143) records the evidence and accepted verification limit.

These limits do not authorize private-network access. Treat fetched content as untrusted text.

## Credentials

Pi authentication lives in `~/.pi/agent/auth.json`, shared by Pi, dev and dev's children. Dev never copies it into its data home, prints it in diagnostics or records it in attempt outcomes. Command text is not copied into work records; Pi's tool-call history still records tool inputs, so commands reference credentials through the environment or existing tooling.

## Outside the protection

- No OS sandbox: read-only tools, workspace admission and process observation constrain cooperating dev participants, not arbitrary programs, Xcode, external terminals or code that a trusted extension runs.
- A read-only child is read-only only through its tool allowlist. Global extensions still initialize and run their event handlers in it, including while it reads the lead's or a coordinator's admitted workspace. A provider that runs its own agent, such as `pi-claude-bridge`, also brings that agent's configuration, including project configuration that Pi folder trust does not gate, and can reach tools outside the allowlist.
- A child runs with the lead's environment: `NODE_OPTIONS` and every other variable of the shell that launched dev reach it unchanged; the controller sets only the data home and the Pi agent directory.
- The browser owner's socket is private to your account, not to dev. Same-account processes can exhaust its connection capacity with status requests and deny new readers access. Rendering capacity is separate, so in-flight renders are unaffected. The [owner review](https://github.com/taekwondodev/dev/pull/146) records this accepted local denial-of-service limit.
- A process that detaches into its own session escapes observation; [workspace](docs/workspace.md#process-uses-and-gates) describes the effect on its checkout. The browser owner has a separate [runtime lifetime](docs/ARCHITECTURE.md#ownership).
- During a removal, a process outside dev can move paths into the worktree and have them deleted with it; dev does not guarantee atomic filesystem containment against concurrent external changes. Stop independently started tools and avoid external edits while a release runs.
- Git-ignoring `.dev/` and the data home's file permissions are not access control against other software running as your account.
- Recent acknowledged ownership metadata can be lost after a power failure, and not every loss is detectable.

## Reporting

This repository has one maintainer and no disclosure process. Open a GitHub issue in `taekwondodev/dev`.
