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

1. It authenticates to Keystone with the `OS_*` variables and finds orbit as the public endpoint of catalog type `orbit`.
2. It [recovers](#recovery) the orbs that ended sessions left behind.
3. It admits the session as writer of the checkout, so another dev task that wants to write it gets an isolated worktree.
4. It writes the [orb record](#state), with a fresh key, then creates the orb and shows orbit's status (`RESERVING`, `BUILDING`, `ACTIVE`).
5. It connects with strict host key checking against the host keys orbit read from the orb's console, then checks the image's tools.
6. It uploads a snapshot of the checkout to the same absolute path on the orb: `HEAD` as a commit and the uncommitted changes, untracked files included, as uncommitted changes. Ignored files stay on the Mac.

The checkout must be on a branch with at least one commit. The footer shows the orb's id and state for the whole session.

A failed step refuses the launch without retrying it: orbit's refusal (`401`, `403`, `409`, `502`, `503`), an orb that reaches `ERROR` (orbit's fault is printed; this includes orbit's ready timeout) or a failed upload. dev deletes the orb it created, waits for `DELETED`, removes the record, prints the cause and exits with code 1. For a `409`, the message also lists the project's orbs that are not being deleted and the command that deletes one. Only the SSH connection after `ACTIVE` is retried, up to 24 times 5 s apart, because the orb's SSH server may not be listening yet.

Ctrl-C before the TUI cancels the launch. dev lets an in-flight creation request finish, so the orb it created is known, then deletes the orb, waits for `DELETED`, removes the record and exits with code 130. A second Ctrl-C stops the wait for `DELETED`, once a pending orbit request has answered or timed out after 30 s: dev prints the orb's id and delete command and leaves the record to the next `dev --orb`, which [recovers](#recovery) it.

### Tools

`bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`, `!` commands and `work process` run on the orb, at the same absolute paths as on the Mac. `grep`, `find` and `ls` stay inactive unless enabled, as in plain dev. Three Mac-side homes are the exception:

- Pi's tool output spill files (`pi-<kind>-<hex>.<ext>` directly in the Mac's temporary directory) are read on the Mac; every other temporary path goes to the orb.
- Skill files outside the checkout are read on the Mac.
- The [task artifact directory](workspace.md#task-artifacts) is read and written on the Mac.

Tool calls are not admitted one by one: none can change the Mac checkout.

When the orb cannot be reached, a tool call fails with SSH's error, which reaches the model, and the footer reads `orb <id>: unreachable` until a call reaches the orb again. `/orb sync` fails with the reason. The session stays usable, and dev never recreates the orb. The Keystone token serves only orbit's API, so a token that can no longer be renewed fails only the deletion at quit, which then keeps the orb as below. Commands with a terminal use a pseudo-terminal on the orb, so `work process` logs merge standard error into standard output. Stopping a command ends its SSH client, which hangs up the orb's terminal.

Refused in orb mode: `/new`, `/resume`, `/fork`, conversation import, a workspace switch through the `workspace` tool, delegated agents, and `work process` outside the session's directory. Quit and relaunch instead.

### Return

`/orb sync` and quit build a snapshot of the orb's working tree, fetch it and apply it to the Mac checkout as one admitted write:

- The orb's commits fast-forward the local branch with the same SHAs.
- The orb's uncommitted changes and local edits are merged three ways against the last synchronized state; local edits that do not overlap are kept.
- The index is reset to the new `HEAD`, so staged and unstaged changes are no longer distinguished.

An orb with no new commits or changes since the last return returns nothing, whatever happened on the Mac. The return refuses entries the [applier rules](../SECURITY.md#returns) forbid and then writes nothing.

#### Divergence

The return diverges when the orb's commits cannot fast-forward the local branch, because it moved on the Mac or the orb rewrote the uploaded commit (`--amend`, rebase), when the checkout switched branch, or when local edits overlap the orb's changes. The checkout, its branch and its index stay untouched. Instead, dev writes the orb's commits, topped by a snapshot commit of its uncommitted changes when it has any, to the local branch `dev/orb-return/<record-id>`, under the repository structure gate and without writer admission. The message names the case, the branch and the command to merge it, `git merge dev/orb-return/<record-id>`.

Every later `/orb sync`, and the quit-time return, first retries the normal return; an overlap clears once the local edits are set aside, while committing them moves the branch, which stays diverged for the session. If the return diverges again, dev moves the branch to the orb's new state while it still points where dev left it and is not checked out. Otherwise, dev writes a branch with the next numeric suffix, `dev/orb-return/<record-id>-2` and so on.

#### At quit

dev deletes the orb once the return completed or its work is on a `dev/orb-return/` branch. A failed return (orb unreachable or in `ERROR`, a local Git error, a refused admission or entry) never deletes the orb:

- With an interactive terminal, dev asks whether to retry: `y` retries the return; anything else, Ctrl-C at the prompt or a `SIGTERM` while it waits quits and keeps the orb.
- Without one, dev keeps the orb.
- Ctrl-C during the return lets the started step finish, so the checkout is never half-written. If the return then failed, dev keeps the orb without asking.

For a kept orb dev prints its id, where its work is, a `curl` delete command and that the next `dev --orb` [recovers](#recovery) it.

Once the work has returned, dev sends `DELETE` and waits about 60 s for orbit to report `DELETED`, printing each state. If the wait ends first, or Ctrl-C stops it, dev exits, printing the orb's id and delete command and leaving the record to the next `dev --orb`, which deletes the orb.

### Recovery

A session that crashed, was killed or kept its orb at quit leaves its orb record behind. Every `dev --orb` recovers such records of its data home after authenticating and before admitting itself, whatever checkout each record names. It takes each record's owner lock without waiting and skips a record whose session still runs. A record of another Keystone URL or project is reported and kept: source that project's openrc and run `dev --orb` again.

| Record                                                                  | Recovery                                                                                                                                                |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Its orb is gone from orbit, `DELETING` or `DELETED`                     | The record is removed                                                                                                                                   |
| Created or being deleted, before any upload                             | dev deletes the orb and waits for `DELETED`                                                                                                             |
| Uploaded, its orb `ACTIVE`                                              | dev fetches the orb's work and writes it to the local branch `dev/orb-recovery/<record-id>` when it changed since its last return, then deletes the orb |
| Uploaded, its orb in another state or unreachable, or its checkout gone | The orb and its record are kept and dev prints the delete command; the next `dev --orb` tries again                                                     |

The recovery branch holds the orb's commits, topped by a snapshot commit of its uncommitted changes when it has any. dev writes it like a [divergent return](#divergence), never touching the checkout's files, branch or index; merge it with `git merge dev/orb-recovery/<record-id>`. An orbit read error keeps the orb and its record.

A session that ended between the creation request and orbit's answer recorded no orb id, and orbit cannot tell which orb answered it. dev lists the project's orbs that are not being deleted, that no record of the data home names, and that orbit created since the earliest such request, allowing one minute of clock skew; an orb whose creation time dev cannot read is left out. While any orb record of the data home cannot be read, dev deletes none of them and keeps the records. Without such orbs the records are removed. Otherwise dev prints them, warning that another data home or client may own them. At an interactive terminal, `y` deletes them, except one a running `dev --orb` recorded while dev was asking, and removes the records; anything else, or no terminal, keeps everything and the next `dev --orb` asks again.

The ended session's writer use then no longer holds the checkout: dev [settles it](workspace.md#release), so the new session starts in the same checkout. A session that ended while returning work may have left the checkout half-written, so its use stays and dev prints the command that clears it, `dev workspace release <task>` while the session's task reserves the checkout, otherwise `dev workspace release pre-existing`. Check the checkout before running it.

## State

| Location                                | Content                                                                                        |
| --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `<data-home>/orbs/<record-id>/`         | The orb record: `record.json`, the private `key`, `known_hosts`, the owner lock `owner.sqlite` |
| `refs/dev/orb/<record-id>/base`, `/end` | The last synchronized snapshot and the orb's latest snapshot, in the local repository          |
| `dev/orb-return/<record-id>[-<n>]`      | The orb's work after a [divergent return](#divergence), a local branch dev never deletes       |
| `dev/orb-recovery/<record-id>`          | The work of an orb left by an ended session, written at [recovery](#recovery), never deleted   |

The record exists from before the creation request until orbit reports `DELETED`. The owning `dev --orb` holds its lock for the whole session, and a recovering `dev --orb` while it recovers the record.
