# Upgrade dev

One command verifies dev against the latest Pi release and the latest release of every npm dependency and proposes the result as a single pull request. A second command updates dev, then runs Pi's own `pi update`. Both commands act on dev's installation, not on the current project.

## Before starting

`npm run pi:update` runs while dev sessions are open. For its whole run it holds `.dev/upgrade/worktree`: it refuses while a session works in that worktree or another `pi:update` or `npm run update` runs, and a session opened there meanwhile is refused every read, write and shell until it finishes. Run it from the installation checkout: a linked worktree, including `.dev/upgrade/worktree`, is refused. Close every dev TUI before `npm run update`, which takes exclusive installation admission. `gh` must be authenticated for this repository. Agent-run upgrades also follow the [repository authorization boundary](../AGENTS.md#boundaries).

## 1. Upgrade and verify

```bash
npm run pi:update
```

The command prepares the upgrade in `.dev/upgrade/worktree` and the Pi candidate in `.dev/upgrade/pi`, leaving the installation checkout, its dependencies and personal profiles unchanged. A later run reuses that worktree in place, switching it to the revision it verifies.

Pi and dependencies target their latest releases, including dependency major updates. The Node requirement can rise to the major running the command. Review these changes in the generated report.

Installs use `--ignore-scripts`. The command verifies the candidate Pi and dependencies and publishes an upgrade pull request even when checks fail. After a successful install, it runs every suite of [the check runner](../tests/run-checks.ts) as one concurrent queue, including those outside `npm run check`; a failed check does not cancel the others.

Check output appears when the whole queue has finished, so the run stays quiet for a few minutes. The report shows the last lines of each failed check's output; a check queue that completes writes every check's full output to `.dev/upgrade/checks.json`, and a run that stops before checks start can leave an older file there. The pull request body is the report, shortened to fit GitHub's limit; the full report is saved in `.dev/upgrade/report.md`.

When `main` already pins the latest Pi and every dependency is at its target, the command says so and publishes nothing, whichever Pi is active.

## 2. Review and resolve failures

Review the report's breaking versions, Pi changelog, changed contracts, audit findings and skipped install scripts. Passing checks do not replace that review; audit findings and skipped scripts do not themselves fail verification.

For failed checks, follow the report's **Before merging** instructions:

1. Fix the upgrade branch in any worktree of the installation checkout and rerun the commands supplied by the report: each names the failed check file, lint pass or probe, and finds the Pi candidate from any such worktree. A separate worktree first detaches at `origin/<branch>` and runs `npm ci --ignore-scripts` and the report's `npm run types:pi`; `.dev/upgrade/worktree` is already prepared. Do not rerun them while `pi:update` runs, because it rebuilds the Pi candidate.
2. Commit and push with `git push origin HEAD:<branch>`.
3. Run `npm run pi:update` again from the installation checkout to verify the pushed revision and refresh the existing pull request. Quit any dev session open in `.dev/upgrade/worktree` first. If the branch moves during verification, rerun against its new head.

An agent can run this loop from a dev session in the installation checkout, with the user's authorization to push and publish: it runs `npm run pi:update` in the background, reads `.dev/upgrade/report.md`, delegates the fix to a writing agent, which receives its own worktree, and runs `npm run pi:update` again once the fix is pushed. A session opened in `.dev/upgrade/worktree` can fix and push, but cannot rerun the command, because it occupies that worktree.

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

Update's last step, `pi update`, installs Pi's latest release, which can be newer than the `config.pi` the last upgrade verified.

After a Pi change, run one normal session, then `npm run profile`. Use [Usage profile](usage-profile.md) to interpret the report and its limitations.

## If something fails

- **The command stopped before publishing:** its error states what was committed or pushed and the exact command to finish.
- **`pi update` failed during update:** dev is already updated; rerun `pi update`.
- **`npm ci` failed during update:** the checkout is already updated, so rerunning update does not reinstall; run `npm ci --ignore-scripts && npm run types:pi`, then `npm run update` to finish the update.

For implementation and integration verification, see [Development](DEVELOPMENT.md#upgrades).
