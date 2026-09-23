# Dev: project brief

## Status and authorization

This is a planning baseline for a personal development environment built on Pi. It is not an implemented configuration or an approved technical architecture.

The user authorized a local Git repository at `~/Developer/dev` and documentation of the intended result, efficiency opportunities, starting sequence, and construction references. Installing extensions, changing existing profiles, moving skills, publishing a repository, or retiring Hermes remains separate work requiring authorization.

## Outcome

Make the user's development loop easier to control: investigate, decide, modify, build, inspect, review, and resume. Optimize human time to an accepted result, with token usage and elapsed agent time as supporting measures.

The user describes their workload as approximately 90% coding, UI prototypes, and current technical documentation research, and 10% personal research. Apple development is an important profile, not the identity of the whole environment.

The primary agent should pair directly with the user. Independent specialists support bounded investigations, alternative designs, and reviews. A permanent supervisor or worker fleet is not a prerequisite for ordinary edits.

Firstmate is a source of integration ideas and potentially reusable components, not the workflow being adopted. Pi should continue to own inference, provider integration, session persistence, and the terminal interface wherever its supported APIs suffice.

## Existing assets and observed friction

The shared workflow library lives in `~/Developer/skills`, exposed through `~/.agents/skills`. It includes `dev-cycle`, planning, implementation, review, and writing guidance. Apple-specific skills currently live in the existing `apple-dev` profile. Their ownership and paths must be checked before any migration; this brief authorizes no edits to that profile.

Read-only investigation of 30 recent substantive root sessions from `apple-dev` found skill loading in all 30, delegation in 21, structured questions in 15, and web search in eight. Historical user requests repeatedly asked for current handoffs, preservation of settled decisions, narrower manual verification, and less repeated work. UI feedback included screenshot comparisons and changes to native component layout and appearance. These observations identify priorities, not a measured diagnosis of the runtime.

A local Pi loader probe found 55 shared skills, of which eight appeared in the generated catalog. The other 47 use `disable-model-invocation: true`. Successful discovery therefore does not establish equivalent automatic routing. Evidence scope and technical sources are in [references](references.md).

## Target capabilities

The following are the intended end-state requirements. Choose implementations after verifying current APIs and existing packages.

| Capability               | Required behavior                                                                                                                                                                                                                        | Acceptance evidence                                                                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow and skills      | Preserve task sizing, user-owned decisions, and selective skill loading. Resolve indirect skill references without requiring the user to remember paths.                                                                                 | Representative small-change, investigation, planning, and review requests reach the intended procedures, including skills hidden from the automatic catalog.          |
| Editing and verification | Read, search, edit, build, and test in the intended project. Preserve unrelated changes and return useful diagnostics with full logs available.                                                                                          | A real change passes its relevant checks; a failed build exposes actionable diagnostics; unrelated work remains intact.                                               |
| Delegation               | Run independent bounded tasks with explicit model, reasoning, resource access, and write scope. Keep reviews read-only and isolate concurrent writers. Deliver each outcome to its owning task without losing failures or cancellations. | Parallel reviewers return independently; a failed or cancelled child is visible; the lead remains steerable; usage includes children.                                 |
| Processes                | Start long-running work without blocking conversation. Retain process identity, status, output, cancellation, and completion notification. Distinguish a lost process from a completed one after interruption.                           | Exercise successful completion, failure, cancellation, and restart recovery against actual processes.                                                                 |
| Research                 | Search, extract readable content with source URLs, and fall back to browser access when needed. Prefer primary documentation and verify version applicability.                                                                           | A current API question is answered from retrievable sources; a blocked or unreadable source produces an explicit fallback or limitation rather than invented content. |
| Visual work              | Accept screenshots, open prototypes, inspect rendered output, and connect feedback to the current task. Support browser prototypes and native applications without conflating them.                                                      | Complete a screenshot-feedback iteration and inspect the actual result; a successful build alone does not count as UI verification.                                   |
| User decisions           | Offer structured choices, accept free text, and allow steering while work runs. Keep waiting decisions visible.                                                                                                                          | The user can answer, revise, or cancel a decision without losing task context or triggering an unintended action.                                                     |
| Continuity               | Preserve settled decisions, scope, outstanding checks, artifact references, and the next action across fresh sessions. Reconcile saved state with live files and processes.                                                              | Resume interrupted work without repeating the briefing or treating stale state as current; changed artifacts are detected.                                            |
| History                  | Retrieve relevant prior decisions and evidence without injecting entire transcripts. Keep existing history accessible during transition.                                                                                                 | Recover a known prior decision with its source; report when an archive is unavailable.                                                                                |
| Profile                  | Share extension implementations while selecting domain guidance and resources explicitly. Keep Apple-specific context out of unrelated tasks.                                                                                            | Generic and Apple sessions use the same extension release and the appropriate skills without state contamination.                                                     |
| Safety                   | Preserve explicit authorization boundaries, protect credentials, and constrain agent writes. Treat project trust and prompt rules as distinct from OS isolation.                                                                         | Exercise permitted and blocked operations in a disposable fixture, including noninteractive behavior.                                                                 |
| Observability            | Expose task state, model, context pressure, process outcomes, and usage without flooding the transcript. Preserve full evidence outside compact summaries.                                                                               | The user can identify what is running, waiting, failed, or ready and inspect the underlying evidence.                                                                 |
| Reproducibility          | Record compatible dependency versions, validate resource discovery, and support an isolated setup and rollback. Keep credentials and runtime data outside source control.                                                                | A clean isolated installation loads the expected resources and can be removed without changing existing environments.                                                 |

Personal research should reuse the research capability with general-purpose guidance. Recurring automation, group bots, and a durable task board are not initial parity requirements merely because Hermes provides them.

## Profile: proposal, not a settled architecture

Recommended direction: one maintained extension package plus selectable profiles. Start with general development and Apple development. Profiles select instructions, skills, and any domain-specific resources; they do not fork common extension code.

Compare these options before implementation:

| Option                                                    | Benefit                                                                         | Cost or unresolved risk                                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| One environment with explicit profile selection           | Least duplicated configuration and maintenance.                                 | Must prove predictable resource selection and session isolation; changing active context mid-session can affect caching and behavior. |
| Separate runtime homes sharing the same extension package | Stronger separation of settings and session state while retaining one codebase. | More launch and configuration management; authentication and global skill discovery need verification.                                |
| Forked copies of the whole environment                    | Independent customization.                                                      | Highest drift and update burden; use only if requirements genuinely diverge.                                                          |

Favor profile selection at session creation. Choose separate homes when isolation requirements justify them. Verify the actual supported Pi configuration mechanisms before defining commands or directory conventions. Preserve the shared skill repository as the source of truth; decide separately where portable Apple skills should live.

The user must settle the desired isolation boundary, including session visibility and model settings, before that choice becomes persistent configuration.

## Efficiency principles for this integration

- **Focused context:** load domain material when its trigger applies. Keep universal instructions short. Verify that reducing the catalog preserves routing rather than merely lowering token count.
- **Compact results:** return relevant diagnostics and source references; keep full output retrievable. A summary must preserve failure evidence and truncation notices.
- **Event-driven work:** use process and task events for completion rather than spending model turns polling. Add supervision conversations only for demonstrated needs.
- **Stable context:** keep prompt prefixes and tool definitions stable where supported. Measure cache behavior before adopting dynamic tool switching as an optimization.
- **Scoped delegation:** give children the facts and capabilities their task needs. Count duplicated context, child usage, retries, and lead synthesis in the total.
- **Durable decisions:** store the minimum recoverable state and reconcile it on resume. Avoid a parallel state system where existing sessions and repository artifacts already answer the question reliably.
- **Proportional verification:** test the failure modes of each integration using real artifacts. Reuse targeted checks before building an evaluation framework.
- **Visible progress:** display waiting decisions and process state without turning every routine event into a model message. Presentation changes alone do not reduce inference tokens.
- **One owner:** shared workflow rules remain in the skill library; this repository owns Pi integration and configuration. Improve an existing owner rather than maintaining conflicting copies.

## Construction practices

Prefer supported Pi APIs and small replaceable integrations over a runtime fork. Inspect existing extensions before building replacements. Check maintenance, licensing, data handling, compatibility, and failure behavior before adopting dependencies.

Pin a tested release or revision and retain lockfiles when dependencies are introduced. Evaluate upgrades in an isolated environment before changing the daily driver. Reuse upstream code with its required license and attribution, and record the source revision of copied components.

Keep configuration declarative where possible. Make setup repeatable and reversible. Load only reviewed project extensions. Store secrets through the chosen authentication mechanism, outside prompts, logs, and Git.

For concurrent work, separate writers before adding synchronization. Use task and process identity to reject stale results. Model cancellation, failure, and unavailable capabilities explicitly; a successful launch is not a completed task.

Native app testing may affect input, accessibility permissions, or attached hardware. Preserve the user's manual verification boundaries and obtain permission for intrusive operations.

## Starting sequence

These are proposed implementation slices, not authorization to execute all of them.

1. **Settle the boundary.** Inspect the current Pi version, shared-skill loader, configuration scopes, and provider path. Choose profile isolation, launch behavior, initial research provider, and essential safety policy with the user. Complete when choices and unresolved risks are recorded without inventing APIs.
2. **Prove direct development.** Build the smallest isolated configuration that loads the shared workflow and a selected profile, edits a disposable project, and runs its checks. Complete when routing and a real edit/build loop work without modifying existing profiles.
3. **Prove parallel and background work.** Add bounded delegation, process management, structured decisions, and interruption recovery. Complete when the corresponding acceptance cases in the capability table pass.
4. **Prove research and visual iteration.** Add source-preserving retrieval, browser fallback, and screenshot/artifact paths. Complete when one documentation investigation and one visual feedback loop succeed end to end.
5. **Prove continuity and compare.** Exercise fresh-session recovery and repeat representative tasks against the existing environment. Complete when the user can compare accepted results, active time, usage, and maintenance costs using the method below.
6. **Choose rollout.** Retain only integrations that earned their cost. Make Pi the default only after the user accepts observed parity and remaining tradeoffs. Retiring or migrating the existing environment is a separate authorized action.

## Comparison method

Use comparable tasks with the same model, reasoning setting, starting repository state, and acceptance criteria. Record versions and distinguish warm-cache from cold-cache runs. Repeat when a single run is inconclusive, without turning the pilot into a separate benchmark project.

Cover a small code change, a documentation investigation, a parallel review, a background build, an interrupted task, and a visual iteration. Record:

- human active minutes and corrective interventions;
- elapsed time until the result is accepted;
- uncached input, cached input, output, and child/summary usage where available;
- failures, repeated work, and lost or reopened decisions;
- setup and maintenance effort separately from task execution.

Report unknown usage rather than treating it as zero. Subscription quota, token counts, API charges, and latency are different measures. Adopt the new environment for demonstrated workflow improvement, not a smaller prompt or a cleaner screenshot alone.

## Next action

The next implementation session should inspect the references and live Pi interfaces, then resolve the choices in starting step 1. This brief intentionally leaves package names, launch commands, provider purchases, and persistent state formats undecided.
