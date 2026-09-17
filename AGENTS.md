# Project entry point

## Purpose

`dev` is a personal, terminal-first development environment built on Pi.
It is general-purpose, with optional specializations such as Apple development.

## Current state

Only project documentation exists. Runtime configuration, extensions, installers,
and launch behavior are not implemented.

## Development workflow

For development work, use `dev-cycle` from the shared library.
Preserve that library as the single source of truth for shared workflow guidance.
This repository owns the Pi integration, not a copy of the shared workflow rules.

## Boundaries

Keep existing environments, credentials, and runtime state separate and unchanged.
Work in this repository must not modify other profiles or migrate shared assets
without explicit authorization.

## Conditional references

- Read `docs/project-brief.md` when deciding scope, requirements,
  implementation slices, planning, or acceptance evidence.
- Read `docs/references.md` when choosing Pi APIs, integrations, or dependencies,
  and verify compatibility with the installed version before implementation.

## Evidence labels

Distinguish these explicitly in plans and reports:

- Requirements are intended behaviors and acceptance conditions stated in the
  project brief.
- Proposals are recommended designs or implementation sequences that still
  require validation or user decisions.
- Verified behavior is supported by an actual local observation, test, or
  retrieved source. Do not present proposals or planning assumptions as verified
  behavior.

## Dev cycle

### Issue tracker

Issues, specifications, and tickets live in GitHub Issues for
`taekwondodev/dev`, operated through `gh`.
See `docs/agents/issue-tracker.md`.

### Issue labels

The canonical dev-cycle labels are `needs-grilling` and `ready-for-agent`.
See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. Read `CONTEXT.md` and applicable ADRs
before changing related behavior. See `docs/agents/domain.md`.

The glossary and domain terms are in `CONTEXT.md`. The decision to keep shared
workflow guidance in the shared library is in
`docs/adr/0001-shared-workflow-library-source-of-truth.md`.
