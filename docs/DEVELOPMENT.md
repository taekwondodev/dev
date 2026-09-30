# Develop dev

This guide is for changing dev itself. Daily use is in the [README](../README.md) and the tool docs ([launcher](launcher.md), [work](work.md), [workspace](workspace.md)). No dev source file or npm dependency belongs in a project dev is used on.

## Setup

```bash
cd ~/Developer/dev
npm ci
npm run lint
npm start          # a session whose working project is dev itself
```

`npm start` and `npm run dev` inside the checkout work on dev; to use the launcher on another project from here, pass `--cwd`. `npm link --ignore-scripts` links the `dev` command to this checkout, so launcher edits take effect on the next launch without reinstalling.

Sources are strict, erasable TypeScript on the pinned Effect 4 release candidate, run directly by Node's type stripping; there is no build step. Keep the Node minimum in `package.json` when choosing syntax and APIs. The Effect reading rule is in [AGENTS.md](../AGENTS.md#learning-more-about-effect).

Checks and setup regenerate an ignored link to the declarations of the actual global Pi package. Run `npm run types:pi` after changing Pi if the editor still sees stale declarations; missing declarations fail the check. Do not install a private Pi copy or add ambient types. `DEV_PI_EXECUTABLE` selects the installation for both checking and runtime.

## Where things live

The component map is in [ARCHITECTURE](ARCHITECTURE.md#components). Each source area has one owning doc and one decision record:

| Area                                                                                                 | Doc                       | Decisions                                                                                                                |
| ---------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `src/launcher.ts`, `src/pi-runtime.ts`, `src/preferences.ts`, `src/profiles.ts`, `scripts/`          | [launcher](launcher.md)   | [ADR 0003](adr/0003-versioned-dispatch-local-runtime.md)                                                                 |
| `src/work-*.ts`, `src/pi-child.ts`                                                                   | [work](work.md)           | [ADR 0002](adr/0002-session-owned-background-work.md), [ADR 0004](adr/0004-authoritative-lifecycle-incremental-store.md) |
| `src/workspace-*.ts`, `src/process-family.ts`, `src/runtime-coordination.ts`, `src/session-guard.ts` | [workspace](workspace.md) | [ADR 0005](adr/0005-scoped-runtime-coordination.md)                                                                      |

`tests/smoke.ts` checks launcher diagnostics; `tests/usage-profile-check.ts` checks the usage profile on fixture data homes; `tests/workspace/` holds the workspace checks, fixtures, subprocess drivers and the Python pseudo-terminal runner; `tests/work/` holds the work checks, their child entry and its scripted model. Portable guidance lives under `profiles/`, not in this repository's `AGENTS.md`.

The reading triggers for each boundary are the conditional references in [AGENTS.md](../AGENTS.md#conditional-references).

## Verification

```bash
npm run lint              # typecheck, lint:effect (Effect diagnostics in strict mode), then Oxlint with warnings as errors
npm run typecheck         # types:pi (regenerate the Pi declaration link), then tsc --noEmit
npm run format:check      # oxfmt without writes; `format` and `lint:fix` are the opt-in mutations
npm run smoke             # launcher diagnostics on temporary private storage; not a model response
npm run profile:check     # usage profile on fixture data homes: baseline, charts, byte-identical rerun,
                          # refusal without a lead session, forks, direct children
npm run workspace:check   # completion table, authority, release, sweep, process adapters, host contract,
                          # host session flows in headless Pi, launcher on disposable storage
npm run workspace:tui     # the real Pi TUI in a pseudo-terminal: stub lifecycle with fault injection,
                          # real authority, quit and release probes
npm run workspace:github  # the gh-backed GitHub reader once, read-only, against a public merged PR
npm run work:check        # current-schema attempt persistence; real children on an offline scripted model: skills,
                          # coordinator authorization, outcome routing, interruption, leaf read
npm run dev:probe         # SDK runtime creation without the TUI
```

`start`, `dev` and `diagnostics` run the launcher on this checkout; the `dev:*` aliases pass the flag of the same name ([launcher](launcher.md#use)); `setup`, `update`, `rollback` and `profile` are the maintenance commands there.

What the scripts do not confess:

- `workspace:github` is outside `workspace:check` on purpose: the contract wants the real reader observed once, not a recurring network gate. Run it whenever the GitHub reader or its adapter facts change; the fakes in `workspace:check` cannot see a regression there.
- The pseudo-terminal driver is Python only because Node has no built-in pty; everything it drives is TypeScript. Run one probe with `python3 tests/workspace/run-workspace-pty-probes.py <name>`, where the name is `stub`, `real`, `quit`, `quit-self-remove`, `quit-contained-history`, `quit-interrupt`, `quit-interrupt-during-sweep`, `interactive-failure`, `quit-shutdown-failure` or `release`.
- No check touches the real workspace authority, credentials or the network, except `workspace:github`. Every lead runtime under test comes from the launcher's `makeRuntimeFactory`, with an offline scripted model and an observer extension. The work checks fork the real child runner through the controller's `childEntry` option, which exists only for them: the entry in `tests/work/` injects the offline model, whose replies follow a `SCRIPT` line in the assignment. Production code reads no environment variable and loads no other entry.
- `scripts/code-policy.ts` rejects source comments, except shebangs and comment-like text inside literals, and never fixes or formats. Express intent through names and structure; move non-obvious rationale into the applicable ADR before deleting a comment. `floatingEffect` is an error at the terminal boundary, not only an editor diagnostic.
- Match proof to the task. Do not add a test suite or benchmark campaign by default; use the actual TUI for interactive behavior.

## Pi upgrade

The pinned Pi version is the smoke expectation in `tests/smoke.ts`; the verification of each upgrade is its commit.

1. Install the candidate in an isolated prefix. Compare SDK export names, coding-agent declaration files and native tool schemas with the current version.
2. Verify the internals dev relies on: `findMostRecentSession`, `resolvePath` in `dist/utils/paths.js`, session header parsing, the `tool_result` adapter passing no `terminate` while pi-agent-core keeps the tool's own, and the runtime's `dispose` awaited by the interactive quit. `tests/workspace/workspace-host-session-check.ts` fails when the session internals or the terminate path change. For children: `AgentSession.prompt` expands `/skill:name` only with `expandPromptTemplates`, after trying extension commands, into a `<skill name="…">` block that opens the first user message; `extensionRunner.getCommand` finds a colliding command; and `sendCustomMessage` with `triggerTurn` runs a coordinator's turn to completion. `tests/work/work-skill-check.ts` and `tests/work/work-nested-check.ts` fail when these change. For `npm run profile`: the line `type` and ISO `timestamp`; the header `parentSession` of a fork, whose copied entries keep their original timestamps; the message `role`; the assistant `timestamp` in milliseconds and `usage.input`, `cacheRead` and `cacheWrite`; the tool result `toolName`, text blocks in `content` and, for `work`, the attempt `id`, `kind` and `owner.parent` in `details`; system messages written when a request starts. `profile:check` runs on fixtures, so after one session on the candidate `npm run profile` must count its requests and tool results with no undecodable line; `git restore docs/performance` afterwards unless the new numbers are meant to be published.
3. Run lint, smoke, `workspace:check`, `workspace:tui`, `workspace:github` and `work:check`.
4. Update the global installation, confirm it matches the candidate byte for byte, update the smoke expectation, and check `dev --diagnostics`.
5. Apply the [extension rule](../SECURITY.md#adding-or-updating-an-extension) when the update changes extension or tool effects. MCP, codemode and tool search still need explicit SDK extension factories; dev does not enable them.

Pi contracts for API choices, on `main` as discovery references while the installed package is the reference for the pinned release: [README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md), [skills](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md), [settings](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md), [extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md), [SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md), [RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md), [session format](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md), [compaction](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md), [security](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md). Starting points for independent workers and research components: the [official subagent example](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent) and the [Pi skills repository](https://github.com/badlogic/pi-skills); an example demonstrates an approach, not parity with dev's contracts.

## Add a tool

A tool dev adds gets one file `docs/<tool>.md` with these headings, in this order:

1. **Purpose**: the use case it serves, in one paragraph.
2. **Use**: terminal commands, session commands and tool actions, one line each.
3. **Behavior**: the guarantees and limits an operator relies on.
4. **State**: paths, formats, retention and recovery.
5. **Decisions**: links to the ARCHITECTURE sections and ADRs that govern it.
6. **Verify**: the scripts that cover it.

A tool doc is complete when every heading has content or an explicit "none"; a heading may carry subsections. Then add the tool to the table above, a conditional pointer in `AGENTS.md`, its vocabulary to `CONTEXT.md` and a section to [ARCHITECTURE](ARCHITECTURE.md#choices) naming use case, choice and tradeoff. Native Pi commands are documented only where dev changes their behavior, in the owning tool file.

## Record a decision

An enduring decision with a real tradeoff gets an ADR in `docs/adr/`, with the next number and the format of the shared `domain-modeling` skill, and a section in ARCHITECTURE. Observable behavior goes in the tool doc, evidence stays in the issue; link the issue comment that accepted the decision.

## Private-state relocation

Stop dev runtimes and inventory dev-owned metadata before moving private state. Preserve permissions, update operational pointers into the moved data home and leave historical conversation text unchanged. Credentials, dev's profiles and global Pi remain outside the operation under [AGENTS.md](../AGENTS.md#boundaries). Keep `.dev/` untracked and protect explicit data-home overrides independently. Revision changes must also satisfy the [maintenance commands](launcher.md#use).

## Discard obsolete state

Dev keeps one current schema, without schema or protocol version markers, historical shapes or migrations ([ADR 0004](adr/0004-authoritative-lifecycle-incremental-store.md)). It validates the actual layout, refuses a non-canonical or damaged store without changing it and never resets state at startup. The rule for deleting old-shape data is in [AGENTS.md](../AGENTS.md#boundaries); delete the paths for the format that changed:

| Changed format                                  | Delete                                                                                                                            |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Workspace authority, managed worktrees included | `~/Library/Application Support/dev/workspace-authority/`, then `git worktree prune` in each repository that had managed worktrees |
| Attempt state                                   | `<data-home>/work/attempts.sqlite` with its `-wal`, `-shm` and `-journal` sidecars, and `<data-home>/work/attempts/`              |
| Dev metadata in conversations                   | `<data-home>/sessions/` and `<data-home>/child-sessions/`                                                                         |
| Profile preferences                             | `<data-home>/preferences/`                                                                                                        |
| Installation and conversation locks             | `<installation>/.dev/coordination/`, which stays in the checkout under any data-home override                                     |

`<data-home>` is `.dev/` in the checkout or an explicit `--data-home` or `DEV_DATA_HOME` override; cover each one in use.

Quit dev before deleting a lock database: `<installation>/.dev/coordination/` or the authority's `gates/`. Unlinking one while a running dev holds it splits ownership across inodes.
