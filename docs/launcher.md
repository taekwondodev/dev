# Launcher

## Purpose

`dev` opens Pi in the project being worked on, with dev's extensions, shared skills and one profile. One installation serves every repository. The installation checkout holds code, dispatch policy and the owner's untracked profiles; the working project supplies its files and instructions; private state stays out of the project and Git.

## Use

From any project:

```bash
dev                               # open here with the saved or default profile
dev --cwd PATH                    # use PATH as the working project
dev --profile NAME                # select a profile of profiles/manifest.json for this session
dev --save-profile NAME           # save this repository's profile preference
dev --continue                    # resume the newest session for this launch directory
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
npm run update -- --remote origin --branch main         # fast-forward dev and activate the pinned Pi
npm run upgrade                                        # alias for update, with the same options
npm run rollback -- --ref REVISION                      # detach at a revision
npm run profile [-- --data-home PATH]                   # private usage report
npm run pi:update                                      # upgrade Pi and dependencies; publish one PR
npm unlink --global dev-pi-environment --ignore-scripts # unlink dev; keep checkout and data
```

Maintenance commands take options as `--flag value`. An unknown option or a stray argument is refused before the command acts.

`npm link` exposes the checkout's executable through npm's global prefix. Its `bin` directory must be on `PATH`; relink after moving the checkout. Source edits take effect on the next launch.

Close every dev TUI before setup, update, rollback, upgrade or `pi:update`: these take exclusive installation admission. Update and rollback require a clean checkout; update (also named `upgrade`) reinstalls dependencies when the merged `package-lock.json` changed, then activates Pi if its pinned version is not already active. When `.dev/` exists, update and rollback also refuse revisions that would track it or stop ignoring it.

Setup records Node, Pi and the shared-skills revision in the data home's `dependency-observation.json`. `DEV_SHARED_SKILLS` selects that checkout when it is not `~/Developer/skills`.

For the upgrade workflow, including post-merge update and activation, read [Upgrade](upgrade.md). Use [usage profile](usage-profile.md) for periods, metrics and public exports.

## Behavior

### Startup cache

Dev uses Node's best-effort module compile cache. The first launch populates it; later launches can reuse compiled code. Profiles, resources and workspace state are still validated on every launch.

The cache lives in the operating system's temporary directory (`node-compile-cache`), or `NODE_COMPILE_CACHE`. Set `NODE_DISABLE_COMPILE_CACHE=1` to disable it. An unavailable cache does not prevent startup, and source or runtime changes need no manual reset.

Help, diagnostics, save-only and browser commands do not start the workspace worker.

### Profiles and resources

Profiles are personal configuration. The installation's `profiles/` directory is ignored by Git and holds a declarative manifest, `profiles/manifest.json`, beside the SOUL files and skill directories it names. Dev knows the manifest format, not profile or skill names:

```json
{
  "default": "general",
  "profiles": {
    "general": { "soul": "general/SOUL.md", "skills": [] },
    "apple": {
      "soul": "apple/SOUL.md",
      "skills": ["apple/skills/swiftui-pro", "apple/skills/swift-concurrency-pro"]
    }
  }
}
```

- `default` names the profile of a new conversation when neither `--profile` nor a saved preference selects one. It must be one of `profiles`.
- Each profile names its `soul`, a Markdown file appended to Pi's system prompt, and its ordered `skills` directories. Paths are relative to `profiles/` and may not use `..`; a symbolic link placed there is followed as the owner's choice, since everything under `profiles/` is trusted personal configuration ([SECURITY](../SECURITY.md#trusted-base)).
- For a new conversation, `--profile` wins over the repository preference, which wins over the configured default. A resumed conversation uses its recorded profile; if none was recorded, `--profile` is required.
- Project `.pi/skills` and `.agents/skills` directories, from the launch directory to the Git root, come first; then the profile's skill directories in manifest order; then the shared skills at `~/.agents/skills`. Duplicate real paths are dropped. Native project-instruction discovery is unchanged: dev's own `AGENTS.md` loads only when dev is the working project.
- The manifest is read from the installation once per launch and once per child start, whatever the working project, managed worktree or data home. `DEV_PROFILES` selects another profiles directory; dev's checks use it for disposable fixtures.

A missing, unreadable or invalid manifest, a default that is not a defined profile, an unknown profile name, a missing SOUL or skill directory of the selected profile, or a Pi resource/extension error stops startup and names the file or resource; no other profile is substituted. Resources of unselected profiles are neither checked nor loaded. Profiles share private state and sessions; they are guidance selection, not isolation.

### Resume and quit

`--continue` selects by session-file modification time and the cwd in Pi's header. If the selected conversation is refused, it does not try an older one. Both resume forms refuse a conversation open in another dev installation or one whose workspace path, Git metadata or persistent identity no longer matches the authority.

A refused existing regular session file and its history remain unchanged. An absent path is reported as absent, without inferring whether history existed. Follow the reported reason: a conversation-specific refusal need not block another conversation, but starting fresh cannot bypass repository identity checks. A workspace switch that never reached the host is withdrawn on resume.

Independent repositories can share a data home. See [workspace session commands](workspace.md#session-commands) for replacements and [quit and interruption](workspace.md#quit-and-interruption) for cleanup, the release offer and exit status.

### Automatic history cleanup

Interactive startup and graceful exit request a detached, one-shot cleanup process. Dev does not wait for its readiness or completion, and the process can finish after dev exits. Help, diagnostics, runtime probes and save-only commands do not request cleanup. There is no periodic timer. Concurrent requests or installation maintenance can cause a pass to be skipped; a later lifecycle trigger retries.

Each data home retains the newest 100 eligible inactive lead conversations and 100 eligible inactive child conversations, ordered by modification time with a filename tie-break. Live conversations, retained-task recovery, pending switches and unresolved work are protected outside those quotas. Unrecognized files, symbolic or hard links, and files whose deletion safety cannot be established remain untouched. Deleted history cannot be resumed; these are count limits, not byte ceilings.

The same pass applies [attempt retention](work.md#state) and removes recognized abandoned preference-write temporaries. No other data is a cleanup target, including workspaces and their reservations. Errors do not fail startup or exit. Non-blocking cleanup still consumes system resources.

[ADR 0005](adr/0005-scoped-runtime-coordination.md#conversation-retention-admission) explains deletion admission; [usage profile](usage-profile.md#run-a-report) describes the effect on report coverage.

## State

| Location                                                 | Content                                                                                                                       |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Installation checkout                                    | Code, version-controlled `config/crew-dispatch.json` and the ignored personal `profiles/` directory                           |
| Working project                                          | Project files and native project instructions                                                                                 |
| `<installation>/.dev/`                                   | Default private data home: sessions, child sessions, work records/logs, usage reports, preferences and dependency observation |
| `<data-home>/browser/`                                   | Browser state and authenticated profile copy; layout in [Read URL](web-read.md#state)                                         |
| `<data-home>/orbs/`                                      | Orb records of `dev --orb` sessions; layout in [Orb](orb.md#state)                                                            |
| `<installation>/.dev/coordination/`                      | Installation admission and conversation claims, regardless of data-home override                                              |
| `<installation>/.dev/upgrade/`                           | Upgrade `worktree/`, Pi candidate `pi/` and the last `report.md`                                                              |
| Pi's [credential store](../SECURITY.md#credentials)      | Pi authentication shared by the lead and children                                                                             |
| `~/Library/Application Support/dev/workspace-authority/` | Account-wide workspace records, gates, managed worktrees and [task artifact directories](workspace.md#task-artifacts)         |

`--data-home` and `DEV_DATA_HOME` move private runtime data only. Dispatch, profiles, authentication, installation coordination and workspace authority keep their own locations. `/login` updates the shared Pi credential store. Never force-add `.dev/`; Git exclusion is not an access-control boundary ([SECURITY](../SECURITY.md#outside-the-protection)).

A conversation retains its selected profile. If stored dev metadata is invalid, startup refuses it rather than resetting it. A stored profile preference that is not a valid preference record stops launch with exit 1 and an error naming the file; delete that file under `<data-home>/preferences/` ([discard obsolete state](DEVELOPMENT.md#discard-obsolete-state)) and save the preference again. Format changes and obsolete-state removal are contributor operations covered in [Development](DEVELOPMENT.md#discard-obsolete-state).
