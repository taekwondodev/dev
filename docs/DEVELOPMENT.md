# Develop dev

This guide is for changing the dev environment itself. To use it in another repository, follow the [README](../README.md) and [terminal commands](COMMANDS-TERMINAL.md); no dev source files or npm dependencies belong in that working project.

## Work in the dev checkout

Read [AGENTS.md](../AGENTS.md), [CONTEXT.md](../CONTEXT.md), and the ADRs applicable to the change. GitHub Issues in `taekwondodev/dev` hold current requirements and decisions. The [project brief](project-brief.md) is a historical planning baseline, not a statement that the runtime is still unimplemented.

Use the shared `dev-cycle` workflow rather than duplicating its rules here. Consult [references](references.md) when choosing Pi APIs, and verify the installed package before relying on an API shape.

For a clean or isolated setup, verify that the installed Pi loader can discover and invoke the required shared skills.

```bash
cd ~/Developer/dev
npm ci
npm run lint
npm start
```

Installs dev-owned dependencies, checks the checkout and starts a session whose working project is dev itself. The npm scripts run in this checkout. To investigate another project with the same launcher, use `dev` from that project or pass `--cwd` explicitly.

Application and maintenance code is strict, erasable TypeScript using the pinned Effect 4 release candidate. Node's native type stripping runs the sources directly; there is no build directory or runtime loader. Keep the Node minimum in `package.json` when choosing syntax and APIs.

Checks and setup regenerate an ignored module-resolution link to the declarations of the actual global Pi package. Run `npm run types:pi` explicitly after changing Pi if your editor still sees stale declarations. Missing declarations fail the check; do not install a private Pi copy or add replacement ambient types. `DEV_PI_EXECUTABLE` selects the same installation for checking and runtime use.

`npm link --ignore-scripts` links the command to this checkout. Local launcher edits take effect on the next launch without reinstalling or copying the code. Setup, update, rollback and unlink commands are documented in the [maintenance section](COMMANDS-TERMINAL.md#manutenzione-dalla-cartella-di-installazione).

## Ownership

- `src/launcher.ts` is the `dev` executable and owns startup selection and the connection to native Pi services and TUI.
- `src/pi-runtime.ts` resolves the installed global Pi SDK and its declarations.
- `src/preferences.ts` owns private data paths, the global Pi auth path and profile preferences.
- `src/profiles.ts` composes selected guidance and skill paths; portable guidance lives under `profiles/`, not in this repository's `AGENTS.md`.
- `src/workspace-*.ts` implement the workspace authority: the engine's guarded entry point and its modules (platform helpers, SQLite, records, gates, authority root and catalog, conversation state, admission, allocation, transitions, attachment, inspect, release), the worker and its Effect client, Git and path identity, the lead shell, native writes and the Pi host integration. `src/workspace-evidence.ts` is the cleanup evidence verifier with its inventory, integration and GitHub readers; `src/workspace-evidence-records.ts` records the workflow's target, publication and rule-approval facts, and `src/workspace-evidence-tool.ts` is the `workspace_evidence` tool through which the lead records them. `src/workspace-release.ts` owns check and the fenced release attempt; `src/workspace-command.ts` owns the terminal and TUI command surface shared by the launcher and the host. `src/error-text.ts` is the one error-to-text helper. `src/process-family.ts` holds the process table, launch gate and family observation step shared with background work. Read [ADR 0005](adr/0005-scoped-runtime-coordination.md#scoped-workspace-operations) before changing admission, shells or the tool gate, and its [Effect boundary](adr/0005-scoped-runtime-coordination.md#effect-boundary) before adding Promise code.
- `src/work-*.ts` and `src/pi-child.ts` implement session-owned background work. Read [ADR 0002](adr/0002-session-owned-background-work.md) before changing that ownership, and [ADR 0004](adr/0004-authoritative-lifecycle-incremental-store.md) for the lifecycle authority and transactional storage contract.
- `config/crew-dispatch.json` is versioned policy; `.dev/` is private dev state and `~/.pi/agent/auth.json` is the shared Pi credential store. Read [ADR 0003](adr/0003-versioned-dispatch-local-runtime.md) before changing that boundary.

## Private-state relocation

Stop dev runtimes and inventory dev-owned metadata before moving private state. Preserve permissions, update operational pointers into the moved data home, and leave historical conversation text unchanged. Credentials, other profiles and shared assets remain outside the operation under [AGENTS.md](../AGENTS.md#boundaries).

Git exclusion is not access control: keep `.dev/` untracked and protect explicit data-home overrides independently. Revision changes must also satisfy the [maintenance checks](COMMANDS-TERMINAL.md#manutenzione-dalla-cartella-di-installazione).

## Existing verification commands

```bash
npm run lint
npm run smoke
```

`lint` checks TypeScript, dedicated Effect diagnostics in strict mode, then Oxlint, propagating each failure. It does not fix or format source. In particular, `floatingEffect` is an error at the terminal boundary, not merely an editor diagnostic. `lint:fix` and `format` are separate opt-in mutations; `format:check` checks formatting without writing. Oxlint remains unpatched. The TypeScript-only capitalization/error-constructor exceptions accommodate Effect's Schema and service factories; Effect diagnostics still check their usage.

The smoke command checks launcher diagnostics with temporary private storage; it is not evidence of a successful model response.

```bash
npm run workspace:check
npm run workspace:tui
```

`workspace:github` runs the gh-backed GitHub reader once, read-only, against a public merged pull request whose source branch was deleted; it needs the network and `gh` authentication and is deliberately outside `workspace:check`, since the contract wants the adapter facts observed through a real reader once, not a recurring availability gate.

`workspace:check` exercises the workspace authority, the release path (check and release on real repositories, worktrees and publications, worker crashes at each release boundary, and the integration proof against a fake GitHub reader), real process adapters, the host's `/workspace` failure notices and its session flows (a background process's rebind, fork and import) in headless Pi sessions, and the launcher on disposable storage under the system temporary directory; the launcher check injects a lifecycle through `launch` instead of opening the fixed per-account authority. `workspace:tui` drives the real Pi TUI in a pseudo-terminal, once against a stub lifecycle for fault injection and once against the real authority, ending with a guided release of the TUI's own task, and runs the terminal `dev workspace release` confirmation in a pseudo-terminal, including a run that a child under the launcher's `runMain` entry point interrupts with SIGINT. Both build every runtime with the launcher's `makeRuntimeFactory`, replacing only the model with an offline scripted one and adding an observer extension. One driver, `scripts/run-workspace-pty-probes.py`, runs them from a table of the keys each probe expects at its markers, filled with the fixture identities the probe prints; pass `stub`, `real`, `launcher`, `launcher-interrupt` or `release` to run one; `launcher` runs the real launcher as a child of the probe on the same pseudo-terminal and releases the TUI's task from inside it, and `launcher-interrupt` does the same with a SIGINT during the teardown after the handover. It is Python only because Node has no built-in pseudo-terminal; everything it drives is TypeScript. No probe touches the real workspace authority, credentials or the network; the GitHub reader is exercised only through fakes.

```bash
npm run dev:probe
```

Exercises SDK runtime creation without opening the TUI or calling a model. Use the actual TUI for changes to interactive behavior. Match proof to the approved task; do not introduce a new test suite or benchmark campaign by default. Preserve unrelated work, account for every changed file and report unobserved behavior explicitly.
