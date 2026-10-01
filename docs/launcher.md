# Launcher

## Purpose

`dev` opens a Pi session with dev's extensions, the shared skills and one profile, from the project being worked on. One installation serves every repository: the launch directory is the working project, the checkout at `~/Developer/dev` holds code and versioned configuration, and private state stays outside both the project and Git.

## Use

From any project:

```bash
dev                               # open Pi here with the saved or default profile
dev --cwd PATH                    # open Pi in PATH without entering it
dev --profile general|apple       # temporary profile for this session
dev --save-profile general|apple  # save the profile preference for this repository
dev --continue                    # resume the newest session for this launch directory
dev --resume PATH.jsonl           # resume one Pi session file
dev --data-home PATH              # private data home for this run (also DEV_DATA_HOME)
dev --diagnostics                 # print cwd, Pi installation, data home, dispatch path, resources
dev --probe-runtime               # create runtime and session without the TUI or a model call
dev --help
dev workspace ...                 # see workspace.md
```

From the checkout, maintenance:

```bash
npm ci && npm run setup && npm link --ignore-scripts    # first install: dependencies, data home, `dev` command
npm run setup -- --data-home PATH                       # setup against an explicit data home
npm run update -- --remote origin --branch main         # fast-forward the checkout
npm run rollback -- --ref REVISION                      # detach the checkout at REVISION
npm run profile [-- --data-home PATH]                   # usage report and README charts from the sessions
npm run pi:verify [-- --version X.Y.Z]                  # verify a Pi release against dev; on green, open its pin pull request
npm run pi:install -- --version X.Y.Z                   # install the verified, pinned Pi release globally
npm unlink --global dev-pi-environment --ignore-scripts # remove the `dev` command; checkout and data stay
```

`npm link` exposes the checkout's `dev` executable through npm's global prefix: the `bin` directory of `npm config get prefix` must be on `PATH`, and a moved checkout is relinked from its new location. Setup, update, rollback, `pi:verify` and `pi:install` take the installation gate exclusively, so every dev TUI must be closed first. Update, rollback and `pi:verify` refuse a dirty checkout; update and rollback also refuse, when `.dev/` exists, any revision that would stop ignoring it or track its content. The Pi upgrade commands are described in [DEVELOPMENT](DEVELOPMENT.md#pi-upgrade).

The usage profile resolves the data home like the launcher, reads every `.jsonl` file in its `sessions/` (lead) and `child-sessions/` (child), prints the report, and rewrites `docs/performance/usage-baseline.json`, `usage.svg` and `tools.svg` in the checkout. It takes no gate and records nothing at runtime: Pi's session files are the only source. A data home without a lead session that made a model request fails and leaves those files untouched.

## Behavior

- Profile: `--profile` wins, then the preference saved for the repository, then `general`. A resumed conversation uses the profile recorded in its session; without one, `--profile` is required.
- `general` composes the shared skills at `~/.agents/skills` and `profiles/general/SOUL.md`. `apple` puts the four Apple skills under `profiles/apple/skills` before the shared skills and uses `profiles/apple/SOUL.md`. Project `.pi/skills` and `.agents/skills` folders, from the launch directory up to the Git root, come before the profile paths; duplicate real paths are dropped. A missing required resource fails the profile, naming its path.
- SOUL guidance is appended to Pi's system prompt. Pi's own discovery of the project's `AGENTS.md` is untouched; this checkout's `AGENTS.md` reaches a session only when the working project is dev itself.
- Startup stops on any Pi resource or extension error and names it.
- `--continue` selects by session file modification time and the working directory in the Pi header, and does not fall through to the next session when that one is refused. `--resume` and `--continue` refuse a conversation that is open in another dev session, of any installation, and a conversation whose workspace or working directory is gone: the message names the session file, whose history is intact, and suggests `dev --cwd PATH`. A never-delivered workspace switch in the resumed conversation is withdrawn.
- Independent repositories can each have a dev TUI open on the same data home. Several sessions on the same repository are the [workspace](workspace.md#behavior) tool's job.
- `/quit` disposes the session, sweeps the repository and prints the receipt; the exit codes are in [workspace](workspace.md#exit-codes).
- The usage profile counts every entry of a file, abandoned branches included, except the history Pi copies into a fork: a file whose header names a parent session counts only entries newer than its header. A lead file without an assistant message is counted as empty and excluded; an undecodable line is skipped and counted. Cache hit rate is cache-read tokens over input, cache-read and cache-write tokens. Model latency is an assistant entry's time minus its message time. Tool time and waiting time are the gaps before tool results and user messages, measured from the previous entry in the file; a system message does not count as the previous entry, because Pi writes it when the next request starts. Children are the distinct `agent` attempts without a parent in a lead's `work` results: a coordinator's leaves count as child sessions, not as children of the lead. Percentiles use the nearest rank.

## State

| Path                                                     | Content                                                                                                                          |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `~/Developer/dev/`                                       | code and versioned configuration, including `config/crew-dispatch.json`                                                          |
| `/path/to/project/`                                      | working files and the project's own instructions                                                                                 |
| `~/Developer/dev/.dev/`                                  | default private data home, Git-ignored: `sessions/`, `child-sessions/`, `work/`, profile preferences, the dependency observation |
| `~/Developer/dev/.dev/coordination/`                     | installation admission and conversation claims; stays in the checkout under any data-home override                               |
| `~/Developer/dev/.dev/pi-candidate/`                     | the Pi release `pi:verify` installed last and its `report.md`, kept until the next verification or its global install            |
| `~/.pi/agent/auth.json`                                  | Pi authentication, shared by global Pi, dev and dev's children                                                                   |
| `~/Library/Application Support/dev/workspace-authority/` | workspace authority and managed worktrees, per OS account                                                                        |

`--data-home` and `DEV_DATA_HOME` move the private data home only; dispatch and authentication stay where they are. Authentication is never copied: `/login` inside Pi writes the global file. Cloning the checkout carries dispatch policy, not credentials or conversations. Never force-add `.dev/`; what Git exclusion does not protect is in [SECURITY](../SECURITY.md#outside-the-protection).

Dev's profile metadata and coordination databases carry only their current shape, with no format version or migration. The profile is recorded as a `dev/profile` entry inside each conversation, so a change to that entry deletes the conversations instead of rewriting them. Any changed layout replaces the old state through [discard obsolete state](DEVELOPMENT.md#discard-obsolete-state), with dev quit before any lock database is deleted.

## Decisions

[Pi SDK launcher](ARCHITECTURE.md#pi-sdk-launcher-not-a-fork), [profiles](ARCHITECTURE.md#profiles-not-separate-environments) and [versioned dispatch, local private state](ARCHITECTURE.md#versioned-dispatch-local-private-state) in ARCHITECTURE; [ADR 0003](adr/0003-versioned-dispatch-local-runtime.md) for the storage boundary.

## Verify

`npm run smoke` checks launcher diagnostics on temporary private storage. `npm run profile:check` runs the usage profile on fixture data homes. `npm run dev:probe` creates the runtime without the TUI. `dev --diagnostics` prints the resolved composition for the current directory.
