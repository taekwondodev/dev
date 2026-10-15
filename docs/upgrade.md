# Upgrade dev

One command moves dev to the latest Pi release and the latest release of every npm dependency, verifies the result and publishes it as a single pull request. A second command updates dev and activates the merged Pi. Both change the shared installation, not just the current project.

## Before starting

Close every dev TUI: both commands take exclusive installation admission. `gh` must be authenticated for this repository. Agent-run upgrades also follow the [repository authorization boundary](../AGENTS.md#boundaries).

## 1. Upgrade and verify

```bash
npm run pi:update
```

The command prepares the upgrade in `.dev/upgrade/worktree` and the Pi candidate in `.dev/upgrade/pi`, leaving the installation checkout, its dependencies and personal profiles unchanged.

Pi and dependencies target their latest releases, including dependency major updates. The Node requirement can rise to the major running the command. Review these changes in the generated report.

Installs use `--ignore-scripts`. The command runs the checks described in [Development](DEVELOPMENT.md#verification), except `dev:probe`, against the candidate Pi and publishes an upgrade pull request even when checks fail. Installation and Pi declaration preparation run first; if either fails, dependent suites are skipped. After preparation, at most three suites run concurrently; each suite's own subcommands remain sequential. A failed suite does not cancel the others.

The terminal identifies each suite as it starts and prints its result, duration and buffered output together when it finishes. Capture is bounded to the last 65,536 characters per command; reports may show a shorter tail. The report keeps checks in their declared order, not completion order; concurrent check durations overlap and should not be summed as elapsed upgrade time. The pull request body is the report; the full copy is saved in `.dev/upgrade/report.md`.

When nothing differs from `main` and the pinned Pi is active, the command says so and publishes nothing. When `main` already pins the latest Pi but another Pi is active, it verifies that release without opening a pull request, so `npm run update` can activate it; a failed check there exits with an error.

## 2. Review and resolve failures

Review the report's breaking versions, Pi changelog, changed contracts, audit findings and skipped install scripts. Passing checks do not replace that review; audit findings and skipped scripts do not themselves fail verification.

For failed checks, follow the report's **Before merging** instructions:

1. Fix on the upgrade branch and rerun the commands supplied by the report.
2. Commit and push.
3. Run `npm run pi:update` again to verify the pushed revision and refresh the existing pull request. If the branch moves during verification, rerun against its new head.

Before merging, confirm the refreshed report covers the revision being merged and all reported failures are resolved.

If the command refuses to reuse the upgrade worktree, preserve local work as directed by the error before retrying. Keep only one upgrade pull request open at a time.

## 3. Merge, update and activate

After merging the upgrade PR, run from dev's main installation checkout:

```bash
git switch main
npm run update
```

For update options and its `upgrade` alias, see [Maintenance](launcher.md#maintenance).

From this checkout on `main`, update removes the upgrade worktree, its attached local branch and its workspace registration, even when dev is already up to date. The Pi candidate remains available until activation succeeds.

Activation requires a verified candidate matching the pin and Pi's latest release. It checks the installed version and lockfile against the candidate, runs smoke and prints diagnostics before removing the candidate. If the pinned Pi is already active, activation is skipped and any candidate remains. For a missing or outdated candidate, use the recovery instructions below.

After a Pi change, run one normal session, then `npm run profile`. Use [Usage profile](usage-profile.md) to interpret the report and its limitations.

## If something fails

- **The command stopped before publishing:** its error states what was committed or pushed and the exact command to finish.
- **Candidate no longer matches the pin or latest release:** run `npm run pi:update` again.
- **Activation failed after switching Pi:** follow the error's `current-version` restoration instruction. Pi retains the previous release in its managed `releases/` directory.
- **`npm ci` failed during update:** the checkout is already updated, so rerunning update does not reinstall; run `npm ci --ignore-scripts && npm run types:pi`, then `npm run update` to finish activation.

For implementation and integration verification, see [Development](DEVELOPMENT.md#upgrades).
