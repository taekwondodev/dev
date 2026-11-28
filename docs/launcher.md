# Launcher

## Purpose

`dev` opens Pi in the project being worked on, with dev's extensions, shared skills and one profile. One installation serves every repository. The installation checkout holds code, dispatch policy, the default profile and the owner's untracked profiles; the working project supplies its files and instructions; private state stays out of the project and Git.

[Launcher profiles](launcher-profiles.md) covers the profile manifest and resource order. [Launcher state and history](launcher-state.md) covers storage locations and automatic history cleanup.

## Use

From any project:

```bash
dev                               # open here with the saved or default profile
dev --cwd PATH                    # use PATH as the working project
dev --profile NAME                # select a profile of the active manifest for this session
dev --save-profile NAME           # save this repository's profile preference
dev --continue                    # resume the newest session for this launch directory
dev --task [TASK-ID]              # open a new conversation in paused work of this repository
dev --resume PATH.jsonl           # resume a specific Pi session
dev --data-home PATH              # select private storage, also DEV_DATA_HOME
dev --orb                         # run this session's tools on a fresh orbit orb; see orb.md
dev --diagnostics                 # print resolved paths, Pi installation and resources
dev --probe-runtime               # create a runtime without the TUI or a model call
dev --help
dev workspace ...                 # workspace observation and release commands
dev browser [status|revoke|enable]  # authenticated Chrome profile copy and browser owner used by read_url
```

### Maintenance

Run from the installation checkout:

```bash
npm ci && npm run setup && npm link --ignore-scripts    # install dependencies, initialize state, link dev
npm run setup -- --data-home PATH                       # initialize an explicit data home
npm run update -- --remote origin --branch main         # fast-forward dev, then run pi update
npm run upgrade                                        # alias for update, with the same options
npm run rollback -- --ref REVISION                      # detach at a revision
npm run profile [-- --data-home PATH]                   # private usage report
npm run pi:update                                      # verify the latest Pi and dependencies; propose one PR
npm unlink --global dev-pi-environment --ignore-scripts # unlink dev; keep checkout and data
```

Maintenance options that take a value use `--flag value`. An unknown option or a stray argument is refused before the command acts.

`npm link` exposes the checkout's executable through npm's global prefix. Its `bin` directory must be on `PATH`; relink after moving the checkout. Source edits take effect on the next launch.

Close every dev TUI before setup, update, rollback or upgrade: these take exclusive installation admission. `pi:update` runs beside open sessions; see [Upgrade](upgrade.md#before-starting). Update and rollback require a clean checkout. When `.dev/` exists, both also refuse revisions that would track it or stop ignoring it.

Setup and update prepare dev's native addon; see [Development](DEVELOPMENT.md#native-addon) for toolchain requirements and build recovery.

Setup records Node and Pi in the data home's `dependency-observation.json`.

For the upgrade workflow, including the post-merge update, read [Upgrade](upgrade.md). Use [usage profile](usage-profile.md) for periods, metrics, public exports and finding a saved conversation.

## Behavior

### Startup cache

Dev uses Node's best-effort module compile cache. The first launch populates it; later launches can reuse compiled code. Profiles, resources and workspace state are still validated on every launch.

The cache lives in the operating system's temporary directory (`node-compile-cache`), or `NODE_COMPILE_CACHE`. Set `NODE_DISABLE_COMPILE_CACHE=1` to disable it. An unavailable cache does not prevent startup, and source or runtime changes need no manual reset.

Dev-started runtimes share the cache. Commands they run do not inherit a cache setting enabled by dev; an explicit `NODE_COMPILE_CACHE` setting is passed on unchanged.

Help, diagnostics, save-only and browser commands do not start the workspace worker.

### Outside a Git repository

Dev works in Git repositories. A new conversation launched from a directory outside any repository checks this before loading profiles or Pi, then offers the repositories directly inside it: visible subdirectories holding `.git`, the most recently used in a dev conversation first, then by name. Type to filter, Enter opens dev there as if launched with `--cwd`, Esc exits with status 0. The picker uses Pi's theme from `~/.pi/agent/settings.json` and erases itself before dev starts. A directory with no repository inside offers to initialize one there instead: Enter runs `git init` and opens dev in it, Esc exits with status 0, and typing is ignored. Dev adds no commit, `.gitignore` or branch name, so Git's `init.defaultBranch` applies and admission follows the [rules for a repository with no commits](workspace-admission.md#admission-and-isolation). The home directory, the filesystem root, a launch without a terminal and `dev --orb`, which [needs a first commit](orb.md#startup), are never offered and exit 1 naming the directory. `--resume`, `--continue`, `--diagnostics`, `--probe-runtime` and `--save-profile` keep their own handling.

### Resume paused work

`dev --task` lists the [paused work](workspace.md#resume-paused-work) of the repository at the launch directory, each with its [head](workspace.md#use), its last use and its path. Type to filter, Enter opens a new conversation in that workspace's path, bound to its task, and Esc exits with status 0. The list looks and handles typed control characters like the [repository picker](#outside-a-git-repository). `dev --task TASK-ID` selects that task's resumable workspace in the repository without a list, unless the task retains several.

The conversation is new and starts in the workspace's directory with its uncommitted files. When nothing is resumable, or the named task is not, dev exits 1 with each workspace's outcome and next action. `--task` with `--resume`, `--continue`, `--diagnostics`, `--probe-runtime`, `--save-profile`, `--orb` or a `workspace`, `browser` or `orb` command, a malformed ID, and a missing ID without a terminal are usage errors that exit 2. Outside a repository, the [repository picker](#outside-a-git-repository) runs before this list.

### Tool output toggle

Ctrl+O still expands and collapses tool output, but dev drops Pi's `Tool output: expanded` and `Tool output: collapsed` status lines; Pi's other status messages are unchanged. The filter replaces a private `InteractiveMode` method, so a Pi release that renames it brings the line back without failing startup.

### Program status

The lead's TUI runs on a terminal the launcher builds from Pi's own terminal module and passes through `InteractiveMode`'s `terminal` option, so that dev can [report `working` instead of `done` while background work will resume the lead](work-status.md#program-status). If the module does not arrive ([ADR 0002](adr/0002-session-owned-background-work.md#pi-build)), Pi creates its default terminal and reports as plain Pi does.

### Resume and quit

`--continue` selects by session-file modification time and the cwd in Pi's header. A conversation opened with `--task` records its workspace's path there, so `--continue` finds it from that path, not from the directory `--task` was launched in. If the selected conversation is refused, it does not try an older one. Both resume forms refuse a conversation open in another dev installation or one whose workspace path, Git metadata or persistent identity no longer matches the authority.

A refused existing regular session file and its history remain unchanged. An absent path is reported as absent, without inferring whether history existed. Follow the reported reason: a conversation-specific refusal need not block another conversation, but starting fresh cannot bypass repository identity checks. A checkout switch that never reached the host is withdrawn on resume.

Independent repositories can share a data home. See [workspace session commands](workspace.md#session-commands) for replacements and [quit and interruption](workspace-cleanup.md#quit-and-interruption) for cleanup, the release offer and exit status.
