# Architecture

Dev connects Pi, the shared workflow library, background execution and workspace coordination. This is a map of the current system. [CONTEXT](../CONTEXT.md) defines its terms, feature guides describe use, and the [decision records](#decision-records) explain architectural tradeoffs.

## Use cases

Dev serves one person on one macOS account, primarily working on code, UI prototypes and technical documentation, with occasional personal research. Its recurring use cases are pairing, bounded delegation, long-running commands, concurrent sessions on one repository and resuming earlier work. Human time to an accepted result is the primary measure; agent time and token consumption are supporting measures.

## Ownership

| Owner                   | Responsibility                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| Pi                      | Inference, providers, conversation persistence, native tools, TUI and project-instruction discovery |
| Shared workflow library | Sizing, decisions, implementation, review and delivery guidance                                     |
| Dev launcher            | Profile composition, installed Pi resolution, runtime lifecycle and private data paths              |
| Work controller         | Attempt admission, process observation, cancellation, usage and outcome delivery                    |
| Workspace authority     | Durable reservations, workspace uses, write admission, isolation and release                        |

A workflow verifies the artifact. The work controller observes execution; the workspace authority decides admission and release from its recorded and observed facts. These responsibilities do not substitute for one another.

## Components

| Source area                                                                                                | Role                                        | Guide                                                                           |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------- |
| `src/launcher.ts`, `src/launcher-runtime.ts`, `src/pi-runtime.ts`, `src/preferences.ts`, `src/profiles.ts` | Startup and runtime composition             | [Launcher](launcher.md)                                                         |
| `src/background-compaction.ts`, `src/compaction-observation.ts`                                            | Context preparation and observations        | [Compaction](compaction.md)                                                     |
| `src/work-*.ts`, `src/pi-child.ts`                                                                         | Background execution and child coordination | [Work](work.md)                                                                 |
| `src/workspace-*.ts`                                                                                       | Authority and host adapters                 | [Workspace](workspace.md)                                                       |
| `src/process-family.ts`, `src/runtime-coordination.ts`, `src/session-guard.ts`                             | Process observation and runtime claims      | [Workspace](workspace.md)                                                       |
| `scripts/maintain.ts`, `scripts/upgrade.ts`, `scripts/pi-upgrade.ts`                                       | Installation maintenance and upgrades       | [Launcher](launcher.md#maintenance), [Upgrade](upgrade.md)                      |
| `scripts/usage-*.ts`                                                                                       | Offline reports and exports                 | [Usage profile](usage-profile.md)                                               |
| `profiles/`, `config/crew-dispatch.json`                                                                   | Guidance selection and dispatch policy      | [Launcher](launcher.md#profiles-and-resources), [dispatch](../config/README.md) |

Contributor setup and checks are in [Development](DEVELOPMENT.md). The trust boundary is in [SECURITY](../SECURITY.md).

## Decision records

Read the relevant record before changing the boundary it governs. This index points to rationale rather than repeating it.

| Change under consideration                         | Record                                                                                                                                                         |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi integration or profile composition              | [#7](https://github.com/taekwondodev/dev/issues/7), [#11](https://github.com/taekwondodev/dev/issues/11), [#20](https://github.com/taekwondodev/dev/issues/20) |
| Child isolation, controller ownership or delivery  | [ADR 0002](adr/0002-session-owned-background-work.md)                                                                                                          |
| Dispatch ownership, private storage or credentials | [ADR 0003](adr/0003-versioned-dispatch-local-runtime.md)                                                                                                       |
| Lifecycle, persistence or durability               | [ADR 0004](adr/0004-authoritative-lifecycle-incremental-store.md)                                                                                              |
| Admission, identity or process coordination        | [ADR 0005](adr/0005-scoped-runtime-coordination.md)                                                                                                            |
| Native file destinations                           | [ADR 0005: native writes](adr/0005-scoped-runtime-coordination.md#native-file-destinations)                                                                    |
| Completion or worktree disposal                    | [ADR 0005: release](adr/0005-scoped-runtime-coordination.md#release)                                                                                           |
| Effect/Promise boundary                            | [ADR 0005: Effect](adr/0005-scoped-runtime-coordination.md#effect-boundary)                                                                                    |
| Extension trust                                    | [ADR 0005: extensions](adr/0005-scoped-runtime-coordination.md#executable-extensions)                                                                          |
| Visual layer, status text or terminal fonts        | [ADR 0006](adr/0006-global-visual-layer.md)                                                                                                                    |
| Background compaction and diagnostic observations  | [#62](https://github.com/taekwondodev/dev/issues/62), [profiling decision](https://github.com/taekwondodev/dev/issues/62#issuecomment-5954797030)              |
