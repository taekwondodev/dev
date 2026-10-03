# Project entry point

## Purpose

`dev` is a personal agent distro built on top of Pi: a launcher with selectable profiles, a `work` tool for background and delegated work, and a `workspace` authority for concurrent sessions on one repository. Global Pi and the shared workflow library are external dependencies.

## Scope

This file guides changes to the dev repository itself. Daily use is in `README.md` and `docs/<tool>.md`; contributor setup and verification are in `docs/DEVELOPMENT.md`. When dev runs in another project, Pi discovers that project's instructions; this file is not injected.

## Development workflow

For development work, use `dev-cycle` from the shared library. Preserve that library as the single source of truth for shared workflow guidance. This repository owns the Pi integration, not a copy of the workflow rules.

## Learning more about Effect

Before writing Effect code, read `node_modules/effect/AGENTS.md` completely and follow its applicable links. Use `node_modules/effect/src` for APIs the guide does not cover. The installed package is the reference for this pinned release. Read the [Effect boundary](docs/adr/0005-scoped-runtime-coordination.md#effect-boundary) before adding Promise code outside Pi's calling points.

## Boundaries

Credentials, other agent environments, dev's profiles under `profiles/` and the Pi installation stay unchanged unless the user explicitly authorizes the change.

Treat dev as unreleased: dev-owned state has exactly one schema, the final one. When a format changes, change the schema in place and, in the same change, delete any dev-owned data in an older shape, following [discard obsolete state](docs/DEVELOPMENT.md#discard-obsolete-state). Deleting dev-owned data is always safe and needs no confirmation. Write no schema versions, compatibility checks, migrations or legacy fields, and remove any you find. Keep current-schema validation, integrity and ownership checks, live revision and generation fences, and release-decision semantics: they protect the current data, not old formats.

## Conditional references

- Read `docs/ARCHITECTURE.md` before changing an ownership, storage, admission or release boundary, and when a change needs the use case a choice optimizes for. Read the ADR it links before changing that boundary.
- Read `SECURITY.md` before adding or updating an extension, changing resource loading, or routing project effects through tools, event handlers or child processes.
- Read `docs/launcher.md`, `docs/work.md`, `docs/workspace.md` or `docs/compaction.md` before changing the behavior it documents, and update it in the same change.
- Read `docs/DEVELOPMENT.md` before adding a tool, recording a decision, upgrading Pi or relocating private state.

## Evidence labels

Distinguish these explicitly in plans and reports:

- Requirements are intended behaviors and acceptance conditions stated in the issue spec.
- Proposals are recommended designs or implementation sequences that still require validation or user decisions.
- Verified behavior is supported by an actual local observation, test or retrieved source. Do not present proposals or planning assumptions as verified behavior.

## Dev cycle

### Issue tracker

Issues, specifications and tickets live in GitHub Issues for `taekwondodev/dev`, operated through `gh`. See `docs/agents/issue-tracker.md`.

### Issue labels

The canonical dev-cycle labels are `needs-grilling` and `ready-for-agent`. See `docs/agents/triage-labels.md`.

### Delivery

The default route is PRs targeting `taekwondodev/dev` on `main`. Before implementation or delivery, read `docs/agents/delivery.md` for route and target defaults.

### Domain docs

This is a single-context repository. Read `CONTEXT.md` and applicable ADRs before changing related behavior. See `docs/agents/domain.md`.
