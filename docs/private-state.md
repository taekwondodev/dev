# Private state maintenance

Part of the [development guide](DEVELOPMENT.md).

## Private-state relocation

Stop dev runtimes and inventory dev-owned metadata before moving private state. Preserve permissions, update operational pointers into the moved data home and leave historical conversation text unchanged. Credentials, profiles and the Pi installation remain outside the operation under [AGENTS.md](../AGENTS.md#boundaries). Keep `.dev/` untracked and protect explicit data-home overrides independently. Revision changes must also satisfy [maintenance admission](launcher.md#maintenance).

## Discard obsolete state

Follow [AGENTS.md](../AGENTS.md#boundaries) when changing a dev-owned format. Startup validates current layout and identity, refuses damaged or non-canonical storage, and never migrates or resets it.

Stop affected runtimes and maintenance operations before deleting state, then restart on the current code. In particular, unlinking a lock database held by a running process splits ownership across inodes. Leave coordination databases on disk during normal operation.

| Changed format                                   | Delete                                                                                                                            |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Workspace authority, including managed worktrees | `~/Library/Application Support/dev/workspace-authority/`, then `git worktree prune` in each repository that had managed worktrees |
| Attempt state                                    | `<data-home>/work/attempts.sqlite` and its `-wal`, `-shm`, `-journal` sidecars, plus `<data-home>/work/attempts/`                 |
| Dev metadata in conversations                    | `<data-home>/sessions/` and `<data-home>/child-sessions/`                                                                         |
| Profile preferences                              | `<data-home>/preferences/`                                                                                                        |
| Usage reports                                    | `<data-home>/usage/`                                                                                                              |
| Installation and conversation locks              | `<installation>/.dev/coordination/`, independent of data-home overrides                                                           |

Cover the default `.dev/` data home and every explicit `--data-home` or `DEV_DATA_HOME` override in use. A conversation file opened with `--resume PATH` can live outside those directories: delete each such file dev wrote in the old format, or keep it as Pi history and do not resume it in dev. Leave unrelated Pi history alone.
