# Working on dev

These instructions apply to the dev repository, not to projects launched through dev. Use `dev-cycle` from the shared workflow library for development work; this repository owns the Pi integration and repository conventions, not a copy of that workflow.

## Boundaries

Credentials, other agent environments, the owner's untracked `profiles/` and the Pi installation stay unchanged unless the user explicitly authorizes the change. Tests use disposable profile fixtures, never the real `profiles/`.

Treat dev as unreleased: dev-owned state has exactly one schema, the final one. Change formats in place and delete old-shape dev data in the same change, following [discard obsolete state](docs/DEVELOPMENT.md#discard-obsolete-state); this deletion needs no confirmation. Write no schema versions, compatibility checks, migrations or legacy fields, and remove any you find. Preserve current-schema validation, integrity and ownership checks, live revision and generation fences, and release-decision semantics: they protect current data, not old formats.

## Read for the change

- **Domain:** read [CONTEXT](CONTEXT.md) before changing related behavior. [Domain conventions](docs/agents/domain.md) govern terminology and decision conflicts.
- **Ownership:** before changing component, storage, admission or release boundaries, read [Architecture](docs/ARCHITECTURE.md) and the relevant record in its [decision index](docs/ARCHITECTURE.md#decision-records).
- **Security:** before changing extensions, resource loading or project effects through tools, event handlers or children, read [SECURITY](SECURITY.md). Before changing the URL reader's network policy, Chrome launch, profile copy or the shared browser owner and its IPC, also read its [browser profile boundary](SECURITY.md#browser-profile-copy).
- **Behavior:** read and update the owning guide: [launcher](docs/launcher.md), [work](docs/work.md), [workspace](docs/workspace.md), [read URL](docs/web-read.md), [compaction](docs/compaction.md) or [usage profile](docs/usage-profile.md).
- **Animation:** before adding or changing an animation of the sweep or quit strip, read [ADR 0008](docs/adr/0008-terminal-held-animation-loops.md).
- **Maintenance:** use [Development](docs/DEVELOPMENT.md) for setup, verification, adding tools and private-state relocation. Before dependency or Pi upgrades, read [Upgrade](docs/upgrade.md).
- **Documentation:** use the [ownership table](docs/DEVELOPMENT.md#documentation-ownership) before adding or relocating guidance, requirements, rationale or evidence.
- **Tracker:** before issue operations, read [issue conventions](docs/agents/issue-tracker.md) and [label mappings](docs/agents/triage-labels.md).
- **Delivery:** before implementation or delivery, read [delivery policy](docs/agents/delivery.md).

## Text the model reads

Agents read dev's text while working on other repositories, without dev's CONTEXT, docs or source. Write every model-visible string for an agent that knows Git and Pi's tools but not dev. These strings include tool and parameter descriptions, output schemas, messages sent into a conversation, tool results, refusals, errors a tool returns and the prompts given to delegated agents.

- Say what happened, what did not run and what the agent can do next. Put internal detail, such as a record or path, after that and only when it helps the next action.
- Use the outward vocabulary in [`scripts/model-text-terms.ts`](scripts/model-text-terms.ts) instead of the CONTEXT terms; the `dev/no-internal-terms` lint error prints the wording for the term it finds.
- Never name a skill, workflow or ADR the agent may not have, such as `dev-cycle`.
- Keep tool names, parameter names and enum values exact; explain them where the agent first reads them. Choose a structured value that an outside agent understands without a definition.
- Replace jargon with plain wording of about the same length; add words only for a fact the next action depends on.

Text dev prints in the terminal for the user uses the same outward vocabulary, so the user and the agent name things alike.

## Learning more about Effect

Before writing Effect code, read `node_modules/effect/AGENTS.md` completely and follow its applicable links. Use `node_modules/effect/src` for APIs the guide does not cover; the installed package is authoritative for this pinned release. Read the [Effect boundary](docs/adr/0005-scoped-runtime-coordination.md#effect-boundary) before adding Promise code outside Pi's calling points.

## Evidence labels

Distinguish requirements from the issue spec, proposals still awaiting validation or a user decision, and verified behavior supported by an actual observation, test or retrieved source. Planning assumptions are not verified behavior.
