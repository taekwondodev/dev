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
npm run profile [-- --data-home PATH]                   # private usage report from the sessions; periods below
npm run profile -- --export docs/performance            # also write the aggregates and README charts
npm run pi:verify [-- --version X.Y.Z]                  # verify a Pi release against dev; on green, open its pin pull request
npm run pi:install -- --version X.Y.Z                   # install the verified, pinned Pi release globally
npm unlink --global dev-pi-environment --ignore-scripts # remove the `dev` command; checkout and data stay
```

`npm link` exposes the checkout's `dev` executable through npm's global prefix: the `bin` directory of `npm config get prefix` must be on `PATH`, and a moved checkout is relinked from its new location. Setup, update, rollback, `pi:verify` and `pi:install` take the installation gate exclusively, so every dev TUI must be closed first. Update, rollback and `pi:verify` refuse a dirty checkout; update and rollback also refuse, when `.dev/` exists, any revision that would stop ignoring it or track its content. The Pi upgrade commands are described in [DEVELOPMENT](DEVELOPMENT.md#pi-upgrade). Setup records the Node and Pi versions and the revision of the shared workflow skills checkout in `dependency-observation.json` under the data home; `DEV_SHARED_SKILLS` names that checkout when it is not `~/Developer/skills`.

The usage profile resolves the data home like the launcher and reads every `.jsonl` file in its `sessions/` (lead) and `child-sessions/` (child). Pi's session files are its only source: it takes no gate, records nothing at runtime, runs no recorded command, opens no file a call named and writes no transcript. It prints the report and saves it as `<data-home>/usage/<selection>.json`, replacing the earlier report of the same selection; unchanged sessions give a byte-identical report. New private reports use mode `0600`, and replacing an existing report restores that mode before writing its contents. That private report adds drilldowns: session-entry references such as `sessions/<file>.jsonl#<entry>` for repeated reads with their requested and returned line ranges, reads of unknown coverage, failures by outcome and candidate sequences, plus read paths and digests of Git arguments; never prompts, file contents, argument payloads or error texts. `--period START..END` selects UTC dates, `START` inclusive and `END` exclusive, either side optional; given more than once, later periods are compared with the first and missing data is stated as a limitation. A selection with nothing measurable fails and leaves every report untouched.

`--export DIR` takes one period and also writes `usage-baseline.json`, `usage.svg` and `tools.svg` to `DIR`: numeric aggregates and allowlisted categories (roles, usage sources, outcome classes, Pi's and dev's tool names, Pi's effort levels and Git operations, anything else as `other`), without identifiers, paths, models, skills or drilldowns; the chart renderer refuses any other field. Only an explicit export touches the checkout. An export is a projection, not history: every report is recomputed from the session files, so an export cannot restore deleted sessions.

## Behavior

- Profile: `--profile` wins, then the preference saved for the repository, then `general`. A resumed conversation uses the profile recorded in its session; without one, `--profile` is required.
- `general` composes the shared skills at `~/.agents/skills` and `profiles/general/SOUL.md`. `apple` puts the four Apple skills under `profiles/apple/skills` before the shared skills and uses `profiles/apple/SOUL.md`. Project `.pi/skills` and `.agents/skills` folders, from the launch directory up to the Git root, come before the profile paths; duplicate real paths are dropped. A missing required resource fails the profile, naming its path.
- SOUL guidance is appended to Pi's system prompt. Pi's own discovery of the project's `AGENTS.md` is untouched; this checkout's `AGENTS.md` reaches a session only when the working project is dev itself.
- Startup stops on any Pi resource or extension error and names it.
- `--continue` selects by session file modification time and the working directory in the Pi header, and does not fall through to the next session when that one is refused. `--resume` and `--continue` refuse a conversation that is open in another dev session, of any installation, or whose workspace path, Git metadata or persistent physical identity no longer matches the authority. An existing regular session file and its saved history are left unchanged. If the path is absent, dev reports that no conversation file currently exists there, without inferring whether history was previously written. Follow the reported reason before retrying that conversation: a conversation-specific refusal does not block every conversation in the checkout, while starting a new conversation does not bypass repository identity checks. A never-delivered workspace switch in the resumed conversation is withdrawn.
- Independent repositories can each have a dev TUI open on the same data home. Several sessions on the same repository are the [workspace](workspace.md#behavior) tool's job.
- `/quit` disposes the session, sweeps the repository and prints the receipt; the exit codes are in [workspace](workspace.md#exit-codes).
- The usage profile counts every entry of a file, abandoned branches and failed or interrupted work included, except the history Pi copies into a fork: a file whose header names a parent session counts only entries newer than its header, while calls and results still pair across that boundary. An undecodable line is skipped and counted. Each entry falls in the period of its own timestamp. A period containing only tool results is measurable, even when their calls precede it: those results contribute their sessions and dates to the sample without inventing requests or token usage. Invocation counts and call outcomes stay in the call's period; read diagnostics and unmatched results stay in the result's period.
- Usage profile tokens: assistant, tool-result, standalone `usage`, compaction and branch-summary usage each count once. Reported reasoning is part of output, never added to it. Usage that Pi should have recorded but did not, or recorded malformed, is unknown, not zero. Cache-read share is cache-read tokens over input, cache-read and cache-write tokens; uncached tokens are input plus cache write. A session's first request is reported apart from later ones. Totals are cumulative consumption, not context occupancy: a request's context is its own input, cache-read and cache-write tokens, and rereads or cache misses after a compaction are associations, not proof of lost information or invalidation.
- Usage profile attribution: model (`provider/model`) comes from each assistant entry, effort from its `thinkingLevel` or else the latest thinking-level change on its branch, the skill from the nearest `/skill:` invocation on the entry's branch, and a child's role (coordinator, leaf or direct child) from the attempt records that leads and coordinators received in `work` results and outcome messages. Whatever is not recorded is counted as unrecorded or unattributed, never inferred from today's checkout or dispatch.
- Usage profile tool outcomes: a call pairs with the result carrying its ID on its own branch. A result is `returned` when Pi recorded no error, which says nothing about task correctness. An error is an invocation error, execution failure, block or cancellation only when its text is one of the agent loop's, the tool's own or dev's recorded messages, otherwise unclassified; a tool's messages count only for that tool, and a command's recorded exit status decides before its output, so a failed test is an execution failure, not an invocation mistake. A call without a result is unmatched, counted as interrupted when its response was aborted, failed or cut by the output limit. A response's first call of a tool is paired with the nearest earlier result of that tool on its branch when that result failed: a failure pairs at most once per branch, never with a call of its own response, and a cancellation never pairs. The pair is a candidate repeated error or recovery, not an established relation.
- Usage profile reads: a native `read` is compared only with earlier reads of the same file on its own branch of the same session. A leading `@` is dropped as Pi does. A relative path is resolved against the working directory Pi last recorded in a prompt's or compaction checkpoint's `cwd` section, unless a workspace switch followed it; otherwise it is kept apart per recorded directory and switch. Its returned line range comes from the request and Pi's continuation notice; a result without a recoverable range, such as an image or a notice without Pi's truncation details, has unknown coverage. A first line too long to return yields no lines: it is counted as first-line truncation with an unknown relation. A read overlapping earlier returned ranges reports the overlapping lines against all of them, identical or changed text, and whether a compaction, a context edit of the nearest earlier result, or an own edit or write lies between; a read starting where an earlier one stopped is pagination. Identical text does not prove the file unchanged in between, and returned bytes are neither billed tokens nor proven waste. The same absolute path read in several sessions is counted apart, as independent agents.
- Usage profile Git: every `git_inspect` call, and every `git` at command position in a shell command, is a request grouped by operation. Command position follows `;`, `&&`, `||`, `|`, `&`, a newline, `(`, `$(` or a backquote, past variable assignments and `!`, `{`, `if`, `then`, `else`, `elif`, `do`, `while`, `until`, `time`, `exec` or `command`; text in quotes, heredocs and comments is not a command, and Git's global options and their values are skipped. Git run as an argument of another command, such as `env`, `sudo`, `xargs`, `timeout` or `nohup`, Git with an option value given by a substitution, aliases, functions, `eval` and commands passed as strings to another program are not detected; a `case` pattern's `)` and `<<` inside arithmetic are misread as a subshell close and a heredoc. An operation outside the Git commands listed in `scripts/usage-export.ts` is reported as `other`, and one `git_inspect` does not accept as `invalid`; neither is copied. A request covers its whole command, substitutions in its arguments included. Its identity preserves the command text apart from leading whitespace, including environment assignments and whitespace inside quoted arguments or `cd` operands; it does not infer shell equivalence. It repeats an earlier one on its branch only under the same recorded working directory, workspace switch and preceding `cd` in its own or an enclosing subshell; it is compared with the earlier result only when both were alone in their call and neither was truncated, because inside a compound command the output belongs to the whole command and a truncated output names its own temporary file. Truncation is Pi's or `git_inspect`'s recorded notice.
- Usage profile lead figures: model latency is an assistant entry's time minus its message time. Tool time and waiting time are the gaps before tool results and user messages, measured from the previous entry in the file; a system message does not count as the previous entry, because Pi writes it when the next request starts. Children are the distinct `agent` attempts without a parent in a lead's `work` results: a coordinator's leaves count as child sessions, not as children of the lead. Percentiles use the nearest rank.

## State

| Path                                                     | Content                                                                                                                                            |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/Developer/dev/`                                       | code and versioned configuration, including `config/crew-dispatch.json`: dispatch rules keyed by skill name and the default                        |
| `/path/to/project/`                                      | working files and the project's own instructions                                                                                                   |
| `~/Developer/dev/.dev/`                                  | default private data home, Git-ignored: `sessions/`, `child-sessions/`, `work/`, `usage/` reports, profile preferences, the dependency observation |
| `~/Developer/dev/.dev/coordination/`                     | installation admission and conversation claims; stays in the checkout under any data-home override                                                 |
| `~/Developer/dev/.dev/pi-candidate/`                     | the Pi release `pi:verify` installed last and its `report.md`, kept until the next verification or its global install                              |
| `~/.pi/agent/auth.json`                                  | Pi authentication, shared by global Pi, dev and dev's children                                                                                     |
| `~/Library/Application Support/dev/workspace-authority/` | workspace authority and managed worktrees, per OS account                                                                                          |

`--data-home` and `DEV_DATA_HOME` move the private data home only; dispatch and authentication stay where they are. Authentication is never copied: `/login` inside Pi writes the global file. Cloning the checkout carries dispatch policy, not credentials or conversations. Never force-add `.dev/`; what Git exclusion does not protect is in [SECURITY](../SECURITY.md#outside-the-protection).

Dev's profile metadata and coordination databases carry only their current shape, with no format version or migration. The profile is recorded as a `dev/profile` entry inside each conversation, so a change to that entry deletes the conversations instead of rewriting them. Any changed layout replaces the old state through [discard obsolete state](DEVELOPMENT.md#discard-obsolete-state), with dev quit before any lock database is deleted.

## Decisions

[Pi SDK launcher](ARCHITECTURE.md#pi-sdk-launcher-not-a-fork), [profiles](ARCHITECTURE.md#profiles-not-separate-environments) and [versioned dispatch, local private state](ARCHITECTURE.md#versioned-dispatch-local-private-state) in ARCHITECTURE; [ADR 0003](adr/0003-versioned-dispatch-local-runtime.md) for the storage boundary.

## Verify

`npm run smoke` checks launcher diagnostics on temporary private storage. `npm run profile:check` runs the usage profile on fixture data homes, through the maintenance command for its private report and export. `npm run dev:probe` creates the runtime without the TUI. `dev --diagnostics` prints the resolved composition for the current directory.
