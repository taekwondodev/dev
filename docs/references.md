# Evidence and construction references

## Local evidence

The initial investigation was read-only. These are observations from the planning session, not permanent assertions about the machine:

- Shared skills were exposed at `~/.agents/skills`, resolving to `~/Developer/skills/skills`.
- The installed `@earendil-works/pi-coding-agent` package declared version `0.84.2`. Current upstream documentation was newer, so each intended API needs a local compatibility check.
- Calling the installed `loadSkills` and `formatSkillsForPrompt` on the shared directory produced 55 loaded skills, eight catalog entries, and no diagnostics. `dev-cycle` was absent from that catalog because its frontmatter disables model invocation. This probe checked discovery and formatting, not model behavior.
- The Apple usage sample was the 30 most recent root sessions with source `desktop` or `cli` and more than ten messages in `~/.hermes/profiles/apple-dev/state.db`, from session `20260908_011855_4953b2` through `20260917_170745_4a0c9c`. Tool calls were deduplicated by session and call identifier. This sample excludes child work and is not a benchmark or a complete workload census.
- Existing Apple guidance is under `~/.hermes/profiles/apple-dev/skills`. Shared eval scripts under `~/Developer/skills/skills/eval/scripts` include Hermes-specific launch and trace handling.
- The user supplied the workload estimate and requested a general development environment with optional Apple specialization. Token savings and human-time improvements have not been measured on a replacement environment.

Existing transcripts and configuration can establish migration requirements, but credentials are outside the investigation scope. Inspect only the fields and session content needed for the decision.

## Pi contracts

Use these sources when selecting integrations. Links on `main` are discovery references; record the tested revision when implementing.

| Decision                                                   | Reference                                                                                                                                                                                                               |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core behavior, TUI, provider selection, session operations | [Coding-agent README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md)                                                                                                                   |
| Resource discovery and invocation semantics                | [Skills](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md)                                                                                                                           |
| Configuration scopes and defaults                          | [Settings](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md)                                                                                                                       |
| Authentication storage and SDK model runtime               | Installed `@earendil-works/pi-coding-agent` `ModelRuntime.create({ authPath })`; canonical global path is `~/.pi/agent/auth.json`                                                                                       |
| Tools, events, structured UI, and lifecycle integration    | [Extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)                                                                                                                   |
| Embedding versus process integration                       | [SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md) and [RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)                                     |
| Persisted sessions and recovery                            | [Session format](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md) and [compaction](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md) |
| Permission and isolation boundary                          | [Security](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md)                                                                                                                       |
| Starting point for independent workers                     | [Official subagent example](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent)                                                                                          |
| Existing research and browser components                   | [Pi skills repository](https://github.com/badlogic/pi-skills)                                                                                                                                                           |

An example demonstrates an approach, not production parity with the current environment. Verify cancellation, output limits, permissions, resource inheritance, and result delivery before adopting it.

## Firstmate as a reference

The inspected snapshot is [3eb5b6334a80e06083e3837f0032a5cec39b8e52](https://github.com/kunchenguid/firstmate/tree/3eb5b6334a80e06083e3837f0032a5cec39b8e52).

- [README](https://github.com/kunchenguid/firstmate/blob/3eb5b6334a80e06083e3837f0032a5cec39b8e52/README.md): separates an agent distribution from its underlying harness and session backend.
- [Architecture](https://github.com/kunchenguid/firstmate/blob/3eb5b6334a80e06083e3837f0032a5cec39b8e52/docs/architecture.md): reference for isolated workers, event-driven supervision, and persisted task state.
- [Pi supervision branch](https://github.com/kunchenguid/firstmate/blob/3eb5b6334a80e06083e3837f0032a5cec39b8e52/docs/pi-supervision-branch.md): reference for outcome delivery and ownership, not a requirement to add a supervision conversation.
- [Calm](https://github.com/kunchenguid/firstmate/blob/3eb5b6334a80e06083e3837f0032a5cec39b8e52/docs/calm.md): distinguishes presentation from model context and documents tool-override compatibility limits.

Prefer a component whose independent contract fits this project over copying the distribution and removing unrelated behavior. Review its license and dependencies before copying source.

## Existing environment as comparison baseline

[Hermes documentation index](https://hermes-agent.nousresearch.com/docs/llms.txt) is the entry point for current search, browser, delegation, process, session, and security contracts. Use the installed behavior as the comparison baseline rather than assuming every documented feature is enabled or working.

The shared `writing-for-agents` skill owns agent-facing prose conventions. The shared `dev-cycle` skill owns development routing and checkpoints. Their contents remain in the shared library rather than being copied into this repository.
