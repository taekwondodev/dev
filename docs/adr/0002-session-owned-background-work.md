# ADR 0002: Session-owned background work with separate Pi children

Run delegated attempts in separate Node processes on the installed Pi SDK, with one controller owning the lead conversation's work. This protects the lead's event loop and gives cancellation a concrete process boundary without introducing a permanent worker fleet. Preserve native resources and project instructions, but start from a focused assignment rather than the lead's transcript.

Accepted in [#12](https://github.com/taekwondodev/dev/issues/12), refined for conversation lifetime and delivery in [#24](https://github.com/taekwondodev/dev/issues/24), and extended to bounded nesting in [#19](https://github.com/taekwondodev/dev/issues/19). Read this record before changing controller ownership, nesting, outcome delivery, the Pi build dev loads or how dev reaches Pi's module state. [Work](../work.md) owns operator behavior.

## One controller, bounded nesting

A lead-authorized coordinator starts leaves through its own IPC channel to the lead controller. Bind identity to the channel, never to a message-supplied identity. The controller remains the only authority for admission, launch, records, observation, cancellation, quota and usage. A controller per coordinator would split those responsibilities; unrestricted recursion would leave session attempts unbounded.

Leaves report to their coordinator. Completion is enforced by the runner/controller, not the coordinator model's claim: reject a coordinator result while its request is pending, a leaf is live or an outcome is unacknowledged. Access never expands during delegation.

Separate processes alone establish neither reasoning quality nor an OS sandbox. Read-only tools and workspace admission constrain cooperating participants; the POSIX process adapter cannot guarantee cleanup of arbitrary daemonized descendants.

## Conversation-owned delivery

Keep one producer per child transcript. Pi owns conversation history and delivery receipts; an inbox schedules delivery but is not another receipt database. Read acknowledgments from the active raw branch, so compaction cannot erase them and abandoned branches cannot acknowledge current delivery. The coordinator's incremental receipt index rebuilds when the branch no longer extends its last observed entry.

Reserve an entire delivery batch before yielding and fence acknowledgments by that reservation. A stale inspection must not overwrite a newer send. Pi can defer a triggered send until a lead run ends; that wait must not prevent the run's boundary from publishing other outcomes. Dispatch after settlement handlers, outside Pi's deferred-send window.

Confirmed tree navigation invalidates attempts without closing the controller; cancelled navigation preserves work. Child conversations remain outside lead-session discovery and transient-result retention.

## Native skill invocation

Use Pi's `/skill:name` expansion instead of injected skill bodies or a filtered catalog. Pi's expansion path also admits extension commands/templates and can pass unknown skills through as text. Dev therefore validates the skill and command collision before any model request, then enables expansion only for that verified invocation.

## Pi build

The lead and every child load the library build that Pi bundles for its own command, not the package entry. Every start and every delegation pays for importing Pi, and the bundled build imports in less time. It also holds private copies of Pi's modules: a module imported from the release by path is then a second instance whose state Pi never updates. A path import must therefore not depend on module state or class identity that the running Pi owns. Helpers that work from their arguments and the file system qualify, and so does a component that initializes its own state, such as the repository picker.

Module state comes through Pi's extension loader, which gives an extension the module instances Pi itself runs. The lead's quit animation reads image support and cell size from the terminal module that one dev extension file receives this way. That file answers a request on Pi's event bus, which a dev extension sends at each session start and whose last answer the launcher keeps: the bus delivers nothing once the session is disposed, and the [sweep runs after that](0005-scoped-runtime-coordination.md#sweep-and-quit). A process-wide slot was rejected because nothing owned it and two runtimes in one process would share it. That file must stay TypeScript: the loader imports a JavaScript file of this package natively, and Node then resolves Pi's packages to the copies on disk. The package declarations type the bundled build, so both must export the same names.

## Workspace boundary

The [workspace integration decision](https://github.com/taekwondodev/dev/issues/30#issuecomment-5797305294) keeps WorkOwner as process/attempt authority and WorkspaceLifecycle as reservation/binding authority. Before releasing user code, publish launch intent and captured process identity under a distinct use/acquisition fence.

Attempt completion does not establish workspace quiescence. [ADR 0005](0005-scoped-runtime-coordination.md#process-observation) owns the process-observation criterion; [its release decision](0005-scoped-runtime-coordination.md#release) separates automatic disposal from explicit task release. [ADR 0004](0004-authoritative-lifecycle-incremental-store.md) owns lifecycle persistence.
