# Upgrade dev

One command moves dev to the latest Pi release and the latest release of every npm dependency, verifies the result and publishes it as a single pull request. A second command activates the merged Pi. Both change the shared installation, not just the current project.

## Before starting

Close every dev TUI: both commands take exclusive installation admission. `gh` must be authenticated for this repository. Agent-run upgrades also follow the [repository authorization boundary](../AGENTS.md#boundaries).

## 1. Upgrade and verify

```bash
npm run upgrade
```

The command never changes the installation checkout or its `node_modules`, so dev keeps working while an upgrade is red. It works in a private worktree at `.dev/upgrade/worktree`, branched from `origin/main`, and installs the Pi candidate beside it in `.dev/upgrade/pi`.

It picks targets that favor upgrading:

- **Pi:** the latest release, the only one `pi update` can activate.
- **Dependencies:** npm's `latest` release of every dependency, majors included, keeping each specifier's style. A dependency already ahead of `latest`, such as a prerelease, is kept. Overrides follow the dependency they pin, and `npm update` refreshes transitive dependencies within their ranges.
- **Node:** `@types/node` follows the major of the Node running the command, and `engines.node` rises to that major. Neither is lowered, and `@types/node` stays put while that major has no published types.

Every install uses `--ignore-scripts`. The command then runs every check from [Development](DEVELOPMENT.md#verification) except `dev:probe`, against the candidate Pi, and keeps going after a failure. It commits `package.json` and `package-lock.json` on `chore/upgrade-<date>`, pushes the branch and opens a pull request whose body is the report. The full report is also saved in `.dev/upgrade/report.md`.

When nothing differs from `main` and the pinned Pi is active, the command says so and publishes nothing. When `main` already pins the latest Pi but another Pi is active, it verifies that release without opening a pull request, so `npm run update` and `pi:update` can activate it; a failed check there exits with an error.

## 2. Fix a red upgrade

A red pull request is titled `[red] ...` and its report starts with **Before merging**: each failing check with its output and the command to rerun it, plus any package whose install scripts were skipped.

1. Fix on the upgrade branch, for example in `.dev/upgrade/worktree`. Rerun a single check there with the exact command the report gives.
2. Commit and push.
3. Run `npm run upgrade` again. While an upgrade pull request is open, the command re-verifies that branch's pushed head and replaces the pull request's title and report. A green run drops `[red]`. If the branch moves during verification, the pull request is left unchanged and the command asks for another run.

Either mode refuses to replace a worktree holding uncommitted, untracked or ignored files other than `node_modules/` and `.DS_Store`, or commits that are not on origin, unless a merged pull request already contains them; the refusal prints the push command. Re-verify checks the local upgrade branch before touching the worktree. The command discards its own interrupted attempt, an unpublished branch whose only changes are `package.json` and `package-lock.json`. It refuses to run while more than one upgrade pull request is open.

Review the report's breaking versions, Pi changelog, changed contracts and audit findings before merging, even when green. Audit findings and skipped install scripts are information for that review; they do not turn the result red.

## 3. Merge, update and activate

After merging:

```bash
npm run update     # fast-forward; reinstalls dependencies when package-lock.json changed
npm run pi:update  # only when the upgrade changed Pi
```

`pi:update` activates the Pi pinned in `package.json`. It requires the verified candidate in `.dev/upgrade/pi` and that release still being Pi's latest; otherwise run `npm run upgrade` again. It checks the active version and installed lockfile against the candidate, runs smoke and prints diagnostics. On success it removes the candidate release.

After a Pi change, run one normal session, then `npm run profile`. Requests and tool results must decode without format-induced errors. Investigate undecodable lines, unclassified errors and unknown read coverage to distinguish session limitations from a changed Pi format. Keep the report private unless you intentionally export aggregates.

## If something fails

- **The command stopped before publishing:** its error states what was committed or pushed and the exact command to finish.
- **Candidate no longer matches the pin or latest release:** run `npm run upgrade` again.
- **Activation failed after switching Pi:** follow the error's `current-version` restoration instruction. Pi retains the previous release in its managed `releases/` directory.
- **`npm ci` failed during update:** the checkout is already updated, so rerunning update does not reinstall; run `npm ci --ignore-scripts && npm run types:pi`.

For investigating or changing the integration, use [Development](DEVELOPMENT.md#upgrades), not this procedure as a test plan.
