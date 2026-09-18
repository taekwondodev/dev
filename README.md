# dev

A personal, terminal-first development environment built on Pi, with shared workflow skills and optional domain specializations.

**Status:** checkout bootstrap implemented; global Pi and the shared workflow remain external dependencies.

## Use dev

### One-time setup

Prerequisites: Node 22.19 or newer, the globally installed `pi` executable, and the live shared workflow library exposed at `~/.agents/skills`.

Run these commands from the dev checkout, not from the project you want to edit:

    cd ~/dev
    npm ci
    npm run setup
    npm link --ignore-scripts

`npm link` exposes the existing `dev` executable through npm's global prefix and keeps it linked to this checkout. It does not publish the package or install another copy of Pi. On macOS/Linux, the `bin` directory under `npm config get prefix` must be on `PATH`. If the checkout moves, relink it from its new location.

### Work in a project

    cd /path/to/your/project
    dev

The launch directory is the working project. You do not need to enter `~/dev` or add a dependency to the project's `package.json`. Use `dev --cwd /path/to/your/project` to select a directory explicitly, or `dev --diagnostics` to inspect the resolved working directory, data home and resources.

Pi discovers project instructions such as `AGENTS.md` from the working directory and its ancestors, not from the executable's location. This checkout's `AGENTS.md` describes development of dev itself; the launcher does not inject it into unrelated projects. Selected guidance from `specializations/*/SOUL.md` is appended separately, without replacing the native project instructions.

Use `dev --specialization apple` for a temporary Apple session, `dev --save-specialization apple` to save a repository preference, and `dev --continue` or `dev --resume PATH` to resume a conversation.

- [Terminal commands](docs/COMMANDS-TERMINAL.md): daily use, setup, updates and removal of the command.
- [Session commands](docs/COMMANDS-SESSION.md): commands entered inside Pi.
- [Background work](docs/background-work.md): delegation, cancellation and retained outcomes.

### Configuration and private data

The installation, the working project and private state have separate roles:

    ~/dev/                   dev code and versioned configuration
    /path/to/your/project/   working files and project instructions
    ~/dev/.dev/              private dev settings, authentication and sessions

Versioned delegation rules live in `config/crew-dispatch.json`. Private data, logs and runtime locks stay in the installation's `.dev/`, excluded by `.gitignore`, even when launched from another repository. `DEV_DATA_HOME` or `--data-home` changes private storage without changing dispatch. Ignoring `.dev/` is not filesystem access control; never force-add it to Git.

Setup does not copy credentials or merge existing data homes. Use Pi's `/login` flow explicitly. Global Pi, the live workflow library and other profiles remain separately managed; updating or rolling back dev does not restore those dependencies or private state. Cloning dev includes dispatch policy, not authentication or conversation history.

## Develop dev

To change the launcher or integration, work in this checkout and follow [Development](docs/DEVELOPMENT.md) and [AGENTS.md](AGENTS.md). These are contributor instructions, not setup steps for every project where dev is used.

The [project brief](docs/project-brief.md) is the historical planning baseline. Consult current GitHub issue decisions and applicable ADRs for approved changes. [Evidence and references](docs/references.md) records integration sources and earlier observations, not a guarantee about the installed Pi version.
