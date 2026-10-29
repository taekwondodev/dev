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
5. It connects with strict host key checking against the host keys orbit read from the orb's console.
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

A delegated agent that can write gets [its own orb](#writing-children). A read-only agent gets none: its `read`, `grep`, `find`, `ls` and `git_inspect` read over SSH, at the same paths, the orb that holds its workspace, so it sees that orb's current files, uncommitted ones included. That is the lead's orb, or a writing coordinator's orb for that coordinator's read-only leaves. The same three Mac-side homes apply, using the child's own skill files. Its tool calls keep their [workspace check](work.md#execution-and-access) on every call.

When the orb cannot be reached, a tool call fails with SSH's error, which reaches the model, and the footer reads `orb <id>: unreachable` until a call reaches the orb again. Git transfers for delegation, upload, return and copying child work also update reachability; after a failed Git transfer, dev probes SSH so a Git error alone does not mark the orb unreachable. `/orb sync` fails with the reason. The session stays usable, and dev never recreates the orb. The Keystone token serves only orbit's API, so a token that can no longer be renewed fails only the deletion at quit, which then keeps the orb as below. Commands with a terminal use a pseudo-terminal on the orb, so `work process` logs merge standard error into standard output. `bash`, `!` and `work process` set `GIT_PAGER=cat` and `PAGER=cat` on the orb so paging commands print their output without waiting for terminal input. Stopping a command ends its SSH client, which hangs up the orb's terminal.

Refused in orb mode: `/new`, `/resume`, `/fork`, conversation import, a workspace switch through the `workspace` tool, a delegation whose `cwd` lies outside the orb's checkout, and `work process` outside the session's directory. Quit and relaunch instead.

### Writing children

`work delegate` with `access: write` returns as in plain dev, once the child process exists. Before that, dev fetches the lead orb's committed `HEAD` into the pinned ref `refs/dev/orb/<lead-record-id>/fork/<attempt>` and allocates the child's [managed worktree](work.md#delegation-scope) from that commit; uncommitted files on the lead's orb are not copied. If the lead's orb cannot be reached, the delegation is refused and no attempt is recorded. A writing leaf also starts from the lead orb's commit.

The lead then creates the child's orb in the background, with its own [orb record](#state), key and owner lock held by the lead's process. Until the orb is ready, `/work` shows the attempt as `provisioning` and the footer shows orbit's state of its orb. dev uploads the worktree to the same absolute path on the child's orb, on a detached `HEAD` like the worktree, and only then starts the child, giving it the orb's SSH address, the record's key and `known_hosts` paths and the lead's SSH connection to that orb. The child never calls orbit.

The child's `bash`, `read`, `write`, `edit`, `grep`, `find` and `ls` run on its orb, with the Mac-side homes of the [tools](#tools) and its tool calls' workspace check. How it ends decides where its work goes:

| End                                                | Work                                                                                                                                                                                                                                                                          |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Its session finished, even with a provider failure | Before reporting, the child [returns](#return) its orb's commits and uncommitted changes into its worktree. If its orb rewrote the start commit, the worktree stays untouched and dev writes the work to `dev/orb-return/<record-id>`.                                        |
| It crashed or was stopped, or its return failed    | dev writes the orb's work to `dev/orb-recovery/<record-id>` when it changed since the upload, never touching the worktree; a child stopped while returning can leave its worktree partly written, so compare it with that branch. The attempt fails or is cancelled as usual. |

Then dev copies the worktree, uncommitted changes included, to the same absolute path on the lead's orb, together with any branch it wrote, so the lead reads the result at the attempt's `worktree.path`; a writing leaf's result goes to its coordinator's orb instead. The copy disappears with that orb. Last, dev deletes the child's orb. The attempt's `orb` field records the orb's state, `DELETED` or `kept`, and where the work went. If the work cannot be saved, dev keeps the orb and its record, and the report names its id and delete command; the next `dev --orb` [recovers](#recovery) it like a crashed session's orb. A failed copy is reported and does not keep the orb, whose work is on the Mac.

dev sets no limit on child orbs. orbit's `409` fails the attempt with `orbit capacity exhausted: <n> active orbs in the project; wait for a child to finish`, and running children are unaffected. An orb that reaches `ERROR`, or whose SSH cannot be reached after `ACTIVE`, is deleted and the attempt fails with the fault. Stopping a child during provisioning deletes its orb. A writing coordinator's orb outlives its leaves: dev ends it only after they settle.

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

A session that crashed, was killed or kept its orb at quit leaves its orb record behind, and so does each of its [writing children](#writing-children) whose orb it had not deleted; the record of a child names the child's worktree as its checkout. Every `dev --orb` recovers such records of its data home after authenticating and before admitting itself, whatever checkout each record names. It takes each record's owner lock without waiting and skips a record whose session still runs. A record of another Keystone URL or project is reported and kept: source that project's openrc and run `dev --orb` again.

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

| Location                                  | Content                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `<data-home>/orbs/<record-id>/`           | The orb record: `record.json`, the private `key`, `known_hosts`, the owner lock `owner.sqlite`    |
| `refs/dev/orb/<record-id>/base`, `/end`   | The last synchronized snapshot and the orb's latest snapshot, in the local repository             |
| `refs/dev/orb/<record-id>/fork/<attempt>` | The lead orb's commit a [writing child](#writing-children) starts from, until its worktree exists |
| `dev/orb-return/<record-id>[-<n>]`        | The orb's work after a [divergent return](#divergence), a local branch dev never deletes          |
| `dev/orb-recovery/<record-id>`            | The work of an orb left by an ended session, written at [recovery](#recovery), never deleted      |

The record exists from before the creation request until orbit reports `DELETED`. The owning `dev --orb` holds its lock for the whole session, and a recovering `dev --orb` while it recovers the record.
