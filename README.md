# dev

A personal, terminal-first development environment built on Pi, with shared workflow skills and optional domain specializations.

**Status:** checkout bootstrap implemented; global Pi and the shared workflow remain external dependencies.

- [Project brief](docs/project-brief.md): target capabilities, specialization alternatives, efficiency goals, construction practices, starting sequence, and acceptance criteria.
- [Evidence and references](docs/references.md): local investigation scope and upstream integration documentation.
- [Background work](docs/background-work.md): separate Pi children, local commands, dispatch, cancellation and retained outcomes.
- [Terminal commands](docs/COMMANDS-TERMINAL.md): launch and maintain dev from the shell.
- [Session commands](docs/COMMANDS-SESSION.md): inspect background work and control an open Pi session.

## Launch

Use Node 22.19 or newer and the globally installed `pi` executable:

    node bin/dev.mjs

Versioned delegation rules live in `config/crew-dispatch.json`. Local settings,
authentication, Pi sessions, logs and runtime locks live in `.dev/` inside this
checkout, excluded by `.gitignore`. Paths are anchored to the dev installation,
not the project being edited. `DEV_DATA_HOME` or `--data-home` can explicitly
override the private runtime directory without changing the dispatch file.
Never force-add `.dev/` to Git; ignoring it is not filesystem access control.

Use `--specialization apple` for a temporary
Apple session, `--save-specialization apple` to save the repository preference,
and `--diagnostics` to inspect the resolved global Pi and resource composition
without creating a session. `--probe-runtime` exercises SDK service and session
creation without opening the TUI. Resume with `--resume PATH` or `--continue`.

Run `npm run setup` to create the dedicated data home and record the observed
Node, global Pi, and shared-workflow revisions. `npm run update -- --remote
origin --branch main` performs an explicit fast-forward-only checkout update;
`npm run rollback -- --ref <revision>` explicitly detaches the dev checkout at
a known revision. Both refuse dirty working trees and leave external Pi,
workflow, credentials, and session data untouched. With local `.dev/` data
present, they conservatively require the explicit `/.dev/` ignore rule, no
negation rules and no tracked `.dev/` contents in the target revision. A rollback
across the previous layout requires explicit relocation of private data first.

The launcher does not install or update Pi, the shared workflow library, system
runtimes, existing profiles, or credentials. Dev code is updated through its
normal Git checkout; rollback is a checkout operation over dev-owned files only.

Cloning the repository includes the dispatch policy but not authentication,
conversations or runtime state. Existing installations using the previous data
home must be stopped before moving their private data; setup does not copy
credentials or merge old and new data homes automatically.

## Bootstrap limitation

Creation of a local `AGENTS.md` entry point was requested but blocked by the host's protected-file approval mechanism because the attached client could not answer the approval request. The file was not created. Completing that entry point requires a supported approval interaction; the project brief is ordinary planning documentation, not an installed agent configuration.
