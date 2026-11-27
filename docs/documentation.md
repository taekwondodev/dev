# Documentation

Part of the [development guide](DEVELOPMENT.md).

## Documentation ownership

Update the owner of each meaning; link to it from other artifacts. Issues and PRs retain the scope and evidence of a change. Maintained documentation describes the current system, with links to those records where the history matters.

| Artifact                                       | Owns                                                                                           |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| GitHub issue                                   | Problem, scope, requirements, acceptance criteria and unresolved decisions for a piece of work |
| Pull request                                   | Implementation scope, review discussion and verification evidence for that change              |
| `docs/adr/`                                    | Accepted architectural choices, alternatives and enduring rationale                            |
| `CONTEXT.md`                                   | Domain terms and distinctions                                                                  |
| `scripts/model-text-terms.ts`                  | Internal terms kept out of model-visible text and the wording that replaces each               |
| `AGENTS.md`                                    | Repository-wide agent guardrails and conditional reading triggers                              |
| `docs/agents/`                                 | Repository-specific tracker, label, delivery and domain conventions                            |
| `docs/ARCHITECTURE.md`                         | Current component responsibilities and a decision-record index                                 |
| `README.md`                                    | Project introduction, installation entry point and documentation navigation                    |
| Feature guide                                  | Use, observable behavior, limits and recovery for one capability                               |
| `SECURITY.md`                                  | Trusted base, extension review requirements and protection limits                              |
| `docs/DEVELOPMENT.md`, `docs/private-state.md` | Contributor setup, verification and maintenance conventions                                    |
| Code, tests and configuration                  | Exact APIs, algorithms, schemas and executable defaults                                        |
| Shared workflow library                        | Portable development procedures and skill contracts                                            |

When adding a tool, link its guide from the component map and add a conditional reading trigger in `AGENTS.md`. Choose headings for the user's task; a feature guide is not an implementation walkthrough or test plan. Refer to tool declarations and configuration for field inventories and exact defaults. Native Pi commands need documentation here only where dev changes them.

Use the shared `domain-modeling` necessity gate and format for ADRs. New ADRs take the next number, link the accepted decision and appear in the architecture index.
