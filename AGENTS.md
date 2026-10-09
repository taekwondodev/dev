# Working on dev

These instructions apply to the dev repository, not to projects launched through dev. Use `dev-cycle` from the shared workflow library for development work; this repository owns the Pi integration and repository conventions, not a copy of that workflow.

## Boundaries

Credentials, other agent environments, the owner's untracked `profiles/` and the Pi installation stay unchanged unless the user explicitly authorizes the change. Tests use disposable profile fixtures, never the real `profiles/`.

Treat dev as unreleased: dev-owned state has exactly one schema, the final one. Change formats in place and delete old-shape dev data in the same change, following [discard obsolete state](docs/DEVELOPMENT.md#discard-obsolete-state); this deletion needs no confirmation. Write no schema versions, compatibility checks, migrations or legacy fields, and remove any you find. Preserve current-schema validation, integrity and ownership checks, live revision and generation fences, and release-decision semantics: they protect current data, not old formats.

## Read for the change

- **Domain:** read [CONTEXT](CONTEXT.md) before changing related behavior. [Domain conventions](docs/agents/domain.md) govern terminology and decision conflicts.
- **Ownership:** before changing component, storage, admission or release boundaries, read [Architecture](docs/ARCHITECTURE.md) and the relevant record in its [decision index](docs/ARCHITECTURE.md#decision-records).
- **Security:** before changing extensions, resource loading or project effects through tools, event handlers or children, read [SECURITY](SECURITY.md). Before changing the URL reader's network policy, Chrome launch or profile copy, also read its [browser profile boundary](SECURITY.md#browser-profile-copy).
- **Behavior:** read and update the owning guide: [launcher](docs/launcher.md), [work](docs/work.md), [workspace](docs/workspace.md), [read URL](docs/web-read.md), [compaction](docs/compaction.md) or [usage profile](docs/usage-profile.md).
- **Maintenance:** use [Development](docs/DEVELOPMENT.md) for setup, verification, adding tools and private-state relocation. Before dependency or Pi upgrades, read [Upgrade](docs/upgrade.md).
- **Documentation:** use the [ownership table](docs/DEVELOPMENT.md#documentation-ownership) before adding or relocating guidance, requirements, rationale or evidence.
- **Tracker:** before issue operations, read [issue conventions](docs/agents/issue-tracker.md) and [label mappings](docs/agents/triage-labels.md).
- **Delivery:** before implementation or delivery, read [delivery policy](docs/agents/delivery.md).

## Learning more about Effect

Before writing Effect code, read `node_modules/effect/AGENTS.md` completely and follow its applicable links. Use `node_modules/effect/src` for APIs the guide does not cover; the installed package is authoritative for this pinned release. Read the [Effect boundary](docs/adr/0005-scoped-runtime-coordination.md#effect-boundary) before adding Promise code outside Pi's calling points.

## Evidence labels

Distinguish requirements from the issue spec, proposals still awaiting validation or a user decision, and verified behavior supported by an actual observation, test or retrieved source. Planning assumptions are not verified behavior.
