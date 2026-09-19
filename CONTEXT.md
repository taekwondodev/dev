# Domain Context

## Dev environment

`dev` is a personal, terminal-first development environment built on Pi.
Its purpose is to make the development loop easier to control across
investigation, decisions, modification, builds, inspection, review, and resume.

## Pi

Pi is the runtime and integration target for this repository. This repository
owns the Pi integration and configuration that are specific to `dev`. Verify
the installed Pi version and supported APIs before choosing an integration.

## Shared workflow library

The shared workflow library is the repository at `~/Developer/skills`, exposed
through `~/.agents/skills`. It owns common development workflow guidance,
including `dev-cycle`, planning, implementation, review, and writing guidance.
This repository consumes that guidance rather than copying or redefining it.

## Specialization

A specialization is a selectable set of instructions, skills, and domain
resources for a particular development area. Apple development is an important
specialization of `dev`, not the identity of the whole environment.

Existing Apple-specific guidance is associated with the existing `apple-dev`
profile. Its ownership and paths must be checked before any migration.

## Background work

An attempt is one owned execution of a workflow task, identified by its lead
session, task, attempt and generation. The operational controller observes
process facts; it does not decide workflow progression or certify artifacts.
Pi owns conversations, and shared dev-cycle owns delegation and recovery policy.
Read [ADR 0002](docs/adr/0002-session-owned-background-work.md) before changing
process ownership, resource boundaries or outcome delivery.
Read [ADR 0004](docs/adr/0004-authoritative-lifecycle-incremental-store.md)
before changing lifecycle authority, operational storage, revisions or retention.

## Configuration and private state

The dev checkout versions its dispatch policy in `config/crew-dispatch.json`.
Private dev runtime data lives in checkout-local `.dev/`, excluded from Git;
explicit data-home overrides change private storage only. Pi authentication is
account-wide and lives in the canonical global `~/.pi/agent/auth.json`, shared by
global Pi and dev. See
[ADR 0003](docs/adr/0003-versioned-dispatch-local-runtime.md) before changing
these paths or their migration and version-control boundaries.
