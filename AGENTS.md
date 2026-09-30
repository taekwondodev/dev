# Project entry point

## Purpose

`dev` is a personal, terminal-first development environment built on Pi: a launcher with selectable profiles, a `work` tool for background and delegated work, and a `workspace` authority for concurrent sessions on one repository. Global Pi and the shared workflow library are external dependencies.

## Scope

This file guides changes to the dev repository itself. Daily use is in `README.md` and `docs/<tool>.md`; contributor setup and verification are in `docs/DEVELOPMENT.md`. When dev runs in another project, Pi discovers that project's instructions; this file is not injected.

## Development workflow

For development work, use `dev-cycle` from the shared library. Preserve that library as the single source of truth for shared workflow guidance. This repository owns the Pi integration, not a copy of the workflow rules.

## Learning more about Effect

Before writing Effect code, read `node_modules/effect/AGENTS.md` completely and follow its applicable links. Use `node_modules/effect/src` for APIs the guide does not cover. The installed package is the reference for this pinned release. Read the [Effect boundary](docs/adr/0005-scoped-runtime-coordination.md#effect-boundary) before adding Promise code outside Pi's calling points.

## Boundaries

Keep existing environments, credentials and runtime state separate and unchanged. Work in this repository must not modify other profiles or migrate shared assets without explicit authorization.

The user authorizes discarding dev-owned session, runtime and workspace-authority data and wants no backward compatibility for this project. This does not authorize changes to credentials, other profiles or shared assets.

## Conditional references

- Read `docs/ARCHITECTURE.md` before changing an ownership, storage, admission or release boundary, and when a change needs the use case a choice optimizes for. Read the ADR it links before changing that boundary.
- Read `SECURITY.md` before adding or updating an extension, changing resource loading, or routing project effects through tools, event handlers or child processes.
- Read `docs/launcher.md`, `docs/work.md` or `docs/workspace.md` before changing the behavior it documents, and update it in the same change.
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

### Domain docs

This is a single-context repository. Read `CONTEXT.md` and applicable ADRs before changing related behavior. See `docs/agents/domain.md`.
