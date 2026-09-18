# Develop dev

This guide is for changing the dev environment itself. To use it in another repository, follow the [README](../README.md) and [terminal commands](COMMANDS-TERMINAL.md); no dev source files or npm dependencies belong in that working project.

## Work in the dev checkout

Read [AGENTS.md](../AGENTS.md), [CONTEXT.md](../CONTEXT.md), and the ADRs applicable to the change. GitHub Issues in `taekwondodev/dev` hold current requirements and decisions. The [project brief](project-brief.md) is a historical planning baseline, not a statement that the runtime is still unimplemented.

Use the shared `dev-cycle` workflow rather than duplicating its rules here. Consult [references](references.md) when choosing Pi APIs, and verify the installed package before relying on an API shape.

```bash
cd ~/dev
npm ci
npm start
```

Installs dev-owned dependencies and starts a session whose working project is dev itself. The npm scripts run in this checkout. To investigate another project with the same launcher, use `dev` from that project or pass `--cwd` explicitly.

`npm link --ignore-scripts` links the command to this checkout. Local launcher edits take effect on the next launch without reinstalling or copying the code. Setup, update, rollback and unlink commands are documented in the [maintenance section](COMMANDS-TERMINAL.md#manutenzione-dalla-cartella-di-installazione).

## Ownership

- `bin/dev.mjs` owns startup selection and connects the native Pi services and TUI.
- `src/pi-runtime.mjs` resolves the installed global Pi SDK.
- `src/preferences.mjs` owns private data paths and specialization preferences.
- `src/specializations.mjs` composes selected guidance and skill paths; portable guidance lives under `specializations/`, not in this repository's `AGENTS.md`.
- `src/work-*.mjs` and `src/pi-child.mjs` implement session-owned background work. Read [ADR 0002](adr/0002-session-owned-background-work.md) before changing that ownership.
- `config/crew-dispatch.json` is versioned policy; `.dev/` is private state. Read [ADR 0003](adr/0003-versioned-dispatch-local-runtime.md) before changing that boundary.

The shared workflow library remains external and authoritative under [ADR 0001](adr/0001-shared-workflow-library-source-of-truth.md). Updating this integration does not authorize edits to other profiles, credentials or shared assets.

## Existing verification commands

```bash
npm run lint
npm exec --no -- oxlint .
npm run smoke
```

The lint script applies fixes and formatting across the checkout. Inspect the diff and keep unrelated formatting out of the change. Run oxlint directly as well because the script uses a semicolon between lint and formatting, so the formatter's exit status can mask a lint failure. The smoke command checks launcher diagnostics with temporary private storage; it is not evidence of a successful model response.

```bash
npm run dev:probe
```

Exercises SDK runtime creation without opening the TUI or calling a model. Use the actual TUI for changes to interactive behavior. Match proof to the approved task; do not introduce a new test suite or benchmark campaign by default. Preserve unrelated work, account for every changed file and report unobserved behavior explicitly.
