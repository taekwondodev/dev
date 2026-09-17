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
