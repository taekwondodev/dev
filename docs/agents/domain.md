# Domain Docs

How the dev-cycle skills consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root: the glossary of this single-context repository.
- **`docs/adr/`**: the ADRs that touch the area you are about to work in. `docs/ARCHITECTURE.md` says which use case and tradeoff each one serves.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a ticket, a spec, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0005 (scoped admission). It may be worth reopening because…_
