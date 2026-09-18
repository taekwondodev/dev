# dev

A personal, terminal-first development environment built on Pi, with shared workflow skills and optional domain specializations.

**Status:** checkout bootstrap implemented; global Pi and the shared workflow remain external dependencies.

- [Project brief](docs/project-brief.md): target capabilities, specialization alternatives, efficiency goals, construction practices, starting sequence, and acceptance criteria.
- [Evidence and references](docs/references.md): local investigation scope and upstream integration documentation.
- [Background work](docs/background-work.md): separate Pi children, local commands, dispatch, cancellation and retained outcomes.

## Launch

Use Node 22.19 or newer and the globally installed `pi` executable:

    node bin/dev.mjs

The launcher keeps configuration, authentication and Pi sessions under
`~/.local/share/dev` by default. Use `--specialization apple` for a temporary
Apple session, `--save-specialization apple` to save the repository preference,
and `--diagnostics` to inspect the resolved global Pi and resource composition
without creating a session. `--probe-runtime` exercises SDK service and session
creation without opening the TUI. Resume with `--resume PATH` or `--continue`.

Run `npm run setup` to create the dedicated data home and record the observed
Node, global Pi, and shared-workflow revisions. `npm run update -- --remote
origin --branch main` performs an explicit fast-forward-only checkout update;
`npm run rollback -- --ref <revision>` explicitly detaches the dev checkout at
a known revision. Both refuse dirty working trees and leave external Pi,
workflow, credentials, and session data untouched.

The launcher does not install or update Pi, the shared workflow library, system
runtimes, existing profiles, or credentials. Dev code is updated through its
normal Git checkout; rollback is a checkout operation over dev-owned files only.

The initial repository is local. No remote, publication, or migration of existing environments has been performed.

## Bootstrap limitation

Creation of a local `AGENTS.md` entry point was requested but blocked by the host's protected-file approval mechanism because the attached client could not answer the approval request. The file was not created. Completing that entry point requires a supported approval interaction; the project brief is ordinary planning documentation, not an installed agent configuration.
