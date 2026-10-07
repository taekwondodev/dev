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
dev --diagnostics                 # print resolved paths, Pi installation and resources
dev --probe-runtime               # create a runtime without the TUI or a model call
dev --help
dev workspace ...                 # workspace observation and release commands
```

### Maintenance

Run from the installation checkout:

```bash
npm ci && npm run setup && npm link --ignore-scripts    # install dependencies, initialize state, link dev
npm run setup -- --data-home PATH                       # initialize an explicit data home
npm run update -- --remote origin --branch main         # fast-forward the checkout
npm run rollback -- --ref REVISION                      # detach at a revision
npm run profile [-- --data-home PATH]                   # private usage report
npm run upgrade                                         # upgrade Pi and dependencies; publish one PR, red or green
npm run pi:update                                       # activate the verified, pinned Pi release
npm unlink --global dev-pi-environment --ignore-scripts # unlink dev; keep checkout and data
```

Maintenance commands take options as `--flag value`. An unknown option or a stray argument is refused before the command acts.

`npm link` exposes the checkout's executable through npm's global prefix. Its `bin` directory must be on `PATH`; relink after moving the checkout. Source edits take effect on the next launch.

Close every dev TUI before setup, update, rollback, upgrade or `pi:update`: these take exclusive installation admission. Update and rollback require a clean checkout; update reinstalls dependencies when the merged `package-lock.json` changed. When `.dev/` exists, update and rollback also refuse revisions that would track it or stop ignoring it.

Setup records Node, Pi and the shared-skills revision in the data home's `dependency-observation.json`. `DEV_SHARED_SKILLS` selects that checkout when it is not `~/Developer/skills`.

Read [Upgrade](upgrade.md) before upgrading or activating a release, and [usage profile](usage-profile.md) for periods, metrics and public exports.

## Behavior

### Startup cache

The launcher enables Node's best-effort module compile cache before loading its runtime and shares the cache location with the workspace worker. Subsequent launches can reuse compiled code; the first launch populates the cache. Specific platform imports avoid loading unrelated dependencies during startup. Profiles, resources and workspace state are still read and validated on every launch.

For runtime launches, the scoped workspace worker starts while Pi loads. Workspace attachment still waits for conversation checks; help, diagnostics and save-only commands do not start this worker. If startup fails, the worker is closed with the launcher's scope.

Node stores the cache under the operating system's temporary directory (`node-compile-cache`), or the location selected by `NODE_COMPILE_CACHE`. Set `NODE_DISABLE_COMPILE_CACHE=1` to disable it. An unavailable cache does not prevent startup. Node owns cache invalidation when source or runtime changes; no rebuild or cache reset is needed after editing dev.

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

Independent repositories can share a data home. [Workspace](workspace.md) governs concurrent sessions, session replacements and `/quit`: quit disposes the session, sweeps the repository, prints a receipt and offers the releases it needs, with the documented [exit status](workspace.md#exit-codes).

## State

| Location                                                 | Content                                                                                                                       |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Installation checkout                                    | Code, version-controlled `config/crew-dispatch.json` and the ignored personal `profiles/` directory                           |
| Working project                                          | Project files and native project instructions                                                                                 |
| `<installation>/.dev/`                                   | Default private data home: sessions, child sessions, work records/logs, usage reports, preferences and dependency observation |
| `<installation>/.dev/coordination/`                      | Installation admission and conversation claims, regardless of data-home override                                              |
| `<installation>/.dev/upgrade/`                           | Upgrade `worktree/`, Pi candidate `pi/` and the last `report.md`                                                              |
| `~/.pi/agent/auth.json`                                  | Pi authentication shared by the lead and children                                                                             |
| `~/Library/Application Support/dev/workspace-authority/` | Account-wide workspace records, gates and managed worktrees                                                                   |

`--data-home` and `DEV_DATA_HOME` move private runtime data only. Dispatch, profiles, authentication, installation coordination and workspace authority keep their own locations. `/login` writes Pi's global auth file; dev never copies credentials. Never force-add `.dev/`; Git exclusion is not an access-control boundary ([SECURITY](../SECURITY.md#outside-the-protection)).

A conversation retains its selected profile. If stored dev metadata is invalid, startup refuses it rather than resetting it. A stored profile preference that is not a valid preference record stops launch with exit 1 and an error naming the file; delete that file under `<data-home>/preferences/` ([discard obsolete state](DEVELOPMENT.md#discard-obsolete-state)) and save the preference again. Format changes and obsolete-state removal are contributor operations covered in [Development](DEVELOPMENT.md#discard-obsolete-state).
