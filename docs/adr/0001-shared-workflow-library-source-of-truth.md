# ADR-0001: Keep shared workflow guidance in the shared library

- Status: Accepted
- Date: 2026-09-17

## Context

The `dev` environment needs common development procedures such as task sizing,
planning, implementation, review, and agent-facing writing guidance. Those
procedures already live in the shared workflow library at
`~/Developer/skills`, exposed through `~/.agents/skills`.

Copying those procedures into this repository would create competing sources
of truth. Changes to shared workflow behavior could then diverge between
environments and require repeated synchronization. This repository instead
needs to own the Pi integration, configuration, and project-specific
profiles.

## Decision

Keep shared workflow guidance in the shared workflow library. The `dev`
repository owns the Pi integration and configuration that are specific to this
environment, but does not copy the shared workflow rules.

Project instructions point to the shared library and use its `dev-cycle`
workflow for development work.

## Consequences

- Shared workflow changes are made in the shared library.
- This repository can evolve its Pi integration without forking common
  workflow guidance.
- A working setup must verify that the installed Pi loader can discover and
  invoke the required shared skills.
- A clean or isolated setup must retain the shared library as an explicit
  dependency.
