# Upgrade dev

One command verifies dev against the latest Pi release and the latest release of every npm dependency and proposes the result as a single pull request. A second command updates dev, then runs Pi's own `pi update`. Both commands change the shared installation, not just the current project.

## Before starting

Close every dev TUI: both commands take exclusive installation admission. `gh` must be authenticated for this repository. Agent-run upgrades also follow the [repository authorization boundary](../AGENTS.md#boundaries).

## 1. Upgrade and verify

```bash
npm run pi:update
```

The command prepares the upgrade in `.dev/upgrade/worktree` and the Pi candidate in `.dev/upgrade/pi`, leaving the installation checkout, its dependencies and personal profiles unchanged. A later run reuses that worktree in place, switching it to the revision it verifies.

Pi and dependencies target their latest releases, including dependency major updates. The Node requirement can rise to the major running the command. Review these changes in the generated report.

Installs use `--ignore-scripts`. The command verifies the candidate Pi and dependencies and publishes an upgrade pull request even when checks fail. It runs every suite of [the check runner](../tests/run-checks.ts) as one concurrent queue, including those outside `npm run check`; a failed check does not cancel the others.

Check output appears when the whole queue has finished, so the run stays quiet for a few minutes. Only the tail of command output is retained. The pull request body is the report; the full copy is saved in `.dev/upgrade/report.md`.

When `main` already pins the latest Pi and every dependency is at its target, the command says so and publishes nothing, whichever Pi is active.

## 2. Review and resolve failures

Review the report's breaking versions, Pi changelog, changed contracts, audit findings and skipped install scripts. Passing checks do not replace that review; audit findings and skipped scripts do not themselves fail verification.

For failed checks, follow the report's **Before merging** instructions:

1. Fix on the upgrade branch and rerun the commands supplied by the report: each names the failed check file, lint pass or probe.
2. Commit and push.
3. Run `npm run pi:update` again to verify the pushed revision and refresh the existing pull request. If the branch moves during verification, rerun against its new head.

When Pi has released again since the pull request was opened, that run first pushes a commit pinning the new release to the upgrade branch, then verifies it.

Before merging, confirm the refreshed report covers the revision being merged and all reported failures are resolved.

If the command refuses to reuse the upgrade worktree, preserve local work as directed by the error before retrying. Keep only one upgrade pull request open at a time.

## 3. Merge and update

After merging the upgrade PR, run from dev's main installation checkout:

```bash
git switch main
npm run update
```

For update options and its `upgrade` alias, see [Maintenance](launcher.md#maintenance).

From this checkout on `main`, update removes the upgrade worktree, its attached local branch, its workspace registration and the Pi candidate, even when dev is already up to date.

Update reinstalls dev's dependencies when the merged `package-lock.json` changed, then runs `pi update` as its last step; it never compares Pi with the pin. `pi update` installs Pi's latest release, which can be newer than the `config.pi` the last upgrade verified.

After a Pi change, run one normal session, then `npm run profile`. Use [Usage profile](usage-profile.md) to interpret the report and its limitations.

## If something fails

- **The command stopped before publishing:** its error states what was committed or pushed and the exact command to finish.
- **`pi update` failed during update:** dev is already updated; rerun `pi update`.
- **`npm ci` failed during update:** the checkout is already updated, so rerunning update does not reinstall; run `npm ci --ignore-scripts && npm run types:pi`, then `npm run update` to finish the update.

For implementation and integration verification, see [Development](DEVELOPMENT.md#upgrades).
