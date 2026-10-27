# Orb

`dev --orb` runs a lead session whose tools execute on a fresh [orbit](https://github.com/taekwondodev/orbit) orb, an ephemeral OpenStack machine reached over SSH. Pi, the model and every credential stay on the Mac; the work returns to the local checkout as commits and working-tree changes. Plain `dev` loads no orb code and reads no OpenStack variable. [CONTEXT](../CONTEXT.md#orb) defines the terms; [SECURITY](../SECURITY.md#orb-execution) states the trust boundary.

## Use

```bash
source openrc demo demo   # the OS_* variables of an OpenStack project with orbit
dev --orb                 # create an orb, upload this checkout, open the TUI
```

In the session:

| Command     | Effect                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------- |
| `/orb`      | Show the orb id, its SSH destination, the checkout and the record directory                 |
| `/orb sync` | Return the orb's commits and working-tree changes to the Mac checkout; the orb stays        |
| `/quit`     | Stop work processes, return the work, delete the orb and wait for orbit to report `DELETED` |

`--orb` cannot be combined with `--diagnostics` or `--probe-runtime`.

### Configuration

`config/orb.json` in the installation sets the orb's `size` (default 2 vCPU, 2048 MB, 10 GB), its `image` (default `ubuntu-24.04-arm64-dev`) and `ssh_allowed_cidr`, the network orbit lets reach the orb over SSH. The Mac must route to orbit's floating IPs; on DevStack, run orbit's `tools/reach-orbs.sh <devstack-host>` after either machine restarts.

The image needs `bash`, `git`, `rg` and `grep`, passwordless `sudo` for its SSH user, and an entry in orbit's `[orbs] ssh_users`. Orbs have no Internet access.

## Behavior

### Startup

Before the TUI opens, dev prints one line per phase with the elapsed time:

1. It admits the session as writer of the checkout, so another dev task that wants to write it gets an isolated worktree.
2. It authenticates to Keystone with the `OS_*` variables and finds orbit as the public endpoint of catalog type `orbit`.
3. It writes the [orb record](#state), with a fresh key, then creates the orb and shows orbit's status (`RESERVING`, `BUILDING`, `ACTIVE`).
4. It connects with strict host key checking against the host keys orbit read from the orb's console, then checks the image's tools.
5. It uploads a snapshot of the checkout to the same absolute path on the orb: `HEAD` as a commit and the uncommitted changes, untracked files included, as uncommitted changes. Ignored files stay on the Mac.

The checkout must be on a branch with at least one commit. If a step fails, dev deletes the orb it created and exits with code 1. The footer shows the orb's id and state for the whole session.

### Tools

`bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`, `!` commands and `work process` run on the orb, at the same absolute paths as on the Mac. `grep`, `find` and `ls` stay inactive unless enabled, as in plain dev. Three Mac-side homes are the exception:

- Pi's tool output spill files (`pi-<kind>-<hex>.<ext>` directly in the Mac's temporary directory) are read on the Mac; every other temporary path goes to the orb.
- Skill files outside the checkout are read on the Mac.
- The [task artifact directory](workspace.md#task-artifacts) is read and written on the Mac.

Tool calls are not admitted one by one: none can change the Mac checkout. Commands with a terminal use a pseudo-terminal on the orb, so `work process` logs merge standard error into standard output. Stopping a command ends its SSH client, which hangs up the orb's terminal.

Refused in orb mode: `/new`, `/resume`, `/fork`, conversation import, a workspace switch through the `workspace` tool, delegated agents, and `work process` outside the session's directory. Quit and relaunch instead.

### Return

`/orb sync` and quit build a snapshot of the orb's working tree, fetch it and apply it to the Mac checkout as one admitted write:

- The orb's commits fast-forward the local branch with the same SHAs.
- The orb's uncommitted changes and local edits are merged three ways against the last synchronized state; local edits that do not overlap are kept.
- The index is reset to the new `HEAD`, so staged and unstaged changes are no longer distinguished.

The return stops without writing anything when the local branch moved, the checkout switched branch, or local edits overlap the orb's changes. It refuses entries the [applier rules](../SECURITY.md#returns) forbid. Interrupting dev during the quit-time return lets the return finish, so the checkout is never half-written. On `/orb sync` the orb keeps its work; at quit dev keeps the orb and prints its id and a `curl` delete command. A kept orb is never deleted by dev; delete it with that command once its work is no longer needed.

## State

| Location                                | Content                                                                                        |
| --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `<data-home>/orbs/<record-id>/`         | The orb record: `record.json`, the private `key`, `known_hosts`, the owner lock `owner.sqlite` |
| `refs/dev/orb/<record-id>/base`, `/end` | The last synchronized snapshot and the orb's latest snapshot, in the local repository          |

The record exists from before the creation request until orbit reports `DELETED`, and the owning `dev --orb` holds its lock for the whole session.
