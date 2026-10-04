# Upgrade Pi

Use these commands from the dev checkout to verify a Pi release, publish its pin change and activate it after merge. They update the shared Pi installation, not just the current project.

## Before starting

Close every dev TUI and start from a clean checkout. For automatic PR publication, use `main` exactly at `origin/main`. The version pinned in `package.json` is the version dev expects to run. Agent-run upgrades also follow the [repository authorization boundary](../AGENTS.md#boundaries).

## 1. Verify

```bash
npm run pi:verify                     # latest release available to pi update
npm run pi:verify -- --version X.Y.Z  # verify a specific candidate
```

The command prepares a candidate without activating it, runs compatibility checks and saves `.dev/pi-candidate/report.md`. A failed check restores the previous pin and publishes nothing.

For a new passing release, the command commits the pin on `chore/pi-<version>`, pushes it and opens a PR containing the report. If publication is unavailable, for example because the branch already exists or the checkout is not at `origin/main`, it announces that before the checks and still verifies. A failed push removes the local candidate branch; failed PR creation leaves the pushed branch and prints the command to publish the report.

Review the report's failures, changed contracts, changelog and audit findings before merging. Audit findings are informational and do not decide the command's pass/fail result. Passing checks are not approval to activate a release without reviewing its changes.

## 2. Activate and check

After merging the pin PR and updating the checkout:

```bash
npm run pi:update -- --version X.Y.Z
```

Activation requires the pinned version, its verified candidate and that same version still being available through `pi update`. If Pi advertises a newer release, verify that release first; `pi update` cannot select an older version.

The command checks the active version and installed lockfile against the candidate, runs smoke and prints diagnostics. On success it removes the candidate release and keeps the report.

Run one normal session, then `npm run profile`. Requests and tool results must decode without format-induced errors. Investigate undecodable lines, unclassified errors and unknown read coverage to distinguish session limitations from a changed Pi format. Keep the report private unless you intentionally export aggregates.

## If an upgrade fails

- **Verification failed:** read the failing check in `.dev/pi-candidate/report.md`. The active Pi is unchanged, and `.dev/pi-candidate/release/` remains for investigation.
- **Candidate no longer matches the pin or available release:** verify the intended release again before activation.
- **Activation failed after switching Pi:** follow the error's `current-version` restoration instruction. Pi retains the previous release in its managed `releases/` directory.

For investigating or changing the integration, use [Development](DEVELOPMENT.md#pi-upgrade), not the activation procedure as a test plan.
