# Launcher state and history

Part of the [launcher guide](launcher.md).

## Automatic history cleanup

Interactive startup and graceful exit request a detached, one-shot cleanup process. Dev does not wait for its readiness or completion, and the process can finish after dev exits. Help, diagnostics, runtime probes and save-only commands do not request cleanup. There is no periodic timer. Concurrent requests or installation maintenance can cause a pass to be skipped; a later lifecycle trigger retries.

Each data home keeps separate count-limited sets of eligible inactive lead and child conversations, newest first. [Conversation retention](../src/conversation-retention.ts) owns the quota and ordering. Live conversations, retained-task recovery, pending switches and unresolved work are protected outside those quotas. Unrecognized files, symbolic or hard links, and files whose deletion safety cannot be established remain untouched. Deleted history cannot be resumed; these are count limits, not byte ceilings.

The same pass applies [attempt retention](work.md#state) and removes recognized abandoned preference-write temporaries. It also removes the lock databases of the installation's conversation claims once no session, child or browser owner of that installation is running; until then a later pass retries. No other data is a cleanup target, including workspaces and their reservations. Errors do not fail startup or exit. Non-blocking cleanup still consumes system resources.

[ADR 0010](adr/0010-conversation-lifecycle.md#conversation-retention-admission) explains deletion admission; [usage profile](usage-profile.md#run-a-report) describes the effect on report coverage.

## State

| Location                                                 | Content                                                                                                                         |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Installation checkout                                    | Code, version-controlled defaults in `config/` and the ignored personal `profiles/` directory                                   |
| Working project                                          | Project files and native project instructions                                                                                   |
| `<installation>/.dev/`                                   | Default private data home: sessions, child sessions, work records/logs, usage reports, preferences and dependency observation   |
| `<data-home>/browser/`                                   | Browser state and authenticated profile copy; layout in [Read URL](web-read.md#state)                                           |
| `<data-home>/openstack.json`, `orb.json`, `orbs/`        | OpenStack credentials, orb configuration and orb records of `dev --orb`; see [Orb](orb.md#configuration)                        |
| `<installation>/.dev/coordination/`                      | Installation admission and conversation claims, regardless of data-home override                                                |
| `<installation>/.dev/upgrade/`                           | Upgrade `worktree/`, Pi candidate `pi/` and the last `report.md`                                                                |
| Pi's [credential store](../SECURITY.md#credentials)      | Pi authentication shared by the lead and children                                                                               |
| `~/Library/Application Support/dev/workspace-authority/` | Account-wide workspace records, gates, managed worktrees and [task artifact directories](workspace-admission.md#task-artifacts) |

`--data-home` and `DEV_DATA_HOME` move private runtime data only. Dispatch, profiles, authentication, installation coordination and workspace authority keep their own locations. `/login` updates the shared Pi credential store. Never force-add `.dev/`; Git exclusion is not an access-control boundary ([SECURITY](../SECURITY.md#outside-the-protection)).

A stored profile preference that is not a valid preference record stops launch with exit 1 and an error naming the file; delete that file under `<data-home>/preferences/` ([discard obsolete state](private-state.md#discard-obsolete-state)) and save the preference again. Format changes and obsolete-state removal are contributor operations covered in [private state maintenance](private-state.md#discard-obsolete-state).
