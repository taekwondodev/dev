# ADR 0005: Scoped admission for concurrent dev sessions

Coordinate cooperating dev runtimes through account-wide workspace reservations and separate kernel-lock gates for installation, conversation and checkout ownership. The checkout, not the repository or runtime fleet, is the contention unit: independent work proceeds concurrently without treating a dead process's PID as ownership. This is cooperative coordination, not an OS sandbox.

Accepted sources: [scope](https://github.com/taekwondodev/dev/issues/18), [account-wide authority](https://github.com/taekwondodev/dev/issues/31#issuecomment-5798717688) and [checkout isolation](https://github.com/taekwondodev/dev/issues/27#issuecomment-5795675435). Read this record before changing admission, identity, process observation or disposal. [Workspace](../workspace.md) owns commands and recovery; [ADR 0004](0004-authoritative-lifecycle-incremental-store.md) owns durable facts.

## Gates and identity

Use separate SQLite rollback-journal lock databases rather than a global mutex or filesystem/PID registrations. Process death releases kernel locks; lock databases stay in place because unlinking them can split ownership across inodes. Installation admission is shared by runtimes and exclusive for maintenance, independent of the data home. Conversation claims combine canonical file identity and Pi session identity, with an account-wide gate to detect competing installations and incarnation gates to distinguish ended sessions.

The authority is account-wide because installation-local claims cannot coordinate one repository across data homes. Readers and writers share checkout presence; writers additionally hold the writer gate. Dev's structural Git effects take a repository gate, but ordinary commands must not fence every linked worktree. Acquire structure, canonical path slots, then short record transactions; duplicate slot requests coalesce to writer access if any request writes.

A free gate does not prove a dead controller's descendants are gone. Durable use facts, acquisition/binding fences and physical identities remain necessary. Persist volume UUID plus lossless inode, not reboot-unstable `st_dev`. Resolve paths in one bounded Foundation observation and refuse lookup failures or object races rather than falling back to path names. Current validation remains required under the [single-schema rule](../../AGENTS.md#boundaries).

## Scoped workspace operations

A shell is an opaque operation within its conversation's writer grant, occupying only that checkout. Git's own locks govern shell structural commands; dev's structure gate protects dev's structural effects. Scoped operations require an ordinary grant and cannot nest inside scoped operations or process grants. Ordinary reads fence nothing.

Classify tool effects through the [extension policy](#executable-extensions), never by tool name alone. Authority-record operations and host rebinds are distinct from project writes. A refusal must return an error result requesting termination rather than throw: a thrown error cannot request termination.

Native Pi batching has an accepted limit: an unclassified tool refused before a later call parks the host can cost another request in the old context; its tools are refused as parked. Changing this requires an aborted-run handoff and real-TUI proof that an extension abort is not treated as user Escape.

A read-only leaf inherits access to its coordinator's admitted workspace through that same attachment's process grant. It records its own use but needs no separate presence gate. This lets a writer's reviewers see uncommitted files without unrecorded participation or broader selection authority. [Bounded nesting](https://github.com/taekwondodev/dev/issues/19) records the requirement.

### Process observation

End a process use only after its group and every tracked descendant are observed gone. Capture identity before releasing user code and match fresh birth identities before signalling; a root group remains attributable while a member lives. Observe exit rather than stdio closure because surviving children can keep pipes open. An unacknowledged identity report may already be durable, so observe the stopped family rather than assuming launch never happened.

Detachment before observation can escape tracking, including Pi shells starting new sessions. This risk is accepted instead of marking every shell unknown. Once observation is lost, `unknown` is absorbing: later reports or host transitions cannot settle it, and a grant cannot settle while a dependent operation is live. The [command contract](https://github.com/taekwondodev/dev/issues/34#issuecomment-5799183185) supplies no repair operation; explicit recovery must be designed before blocked checkouts can be reused.

A live process prevents switching or automatic isolation because moving its conversation would close owned work without confirmation. Session end and replacement stop and observe shells before closing the attachment; reload preserves observation.

### Conversation transitions

Claim replacement targets before Pi opens them where its lifecycle permits; release unused provisional claims without losing the current owner. An account-wide gate proves no other host still performs the switch. A switch never delivered to the host can be withdrawn on attach; one already started needs review.

Pi's lifecycle permits resume and stored-session import before teardown, but new, fork and copied import only afterward. Authority refusal can therefore end those sessions, an accepted limit. Fork starts a new task rather than sharing write ownership. Quit cancels an authority-started switch not yet acted on and waits for settlement.

Cross-repository conversation publication is recoverable, not atomic. Preserve uncertain source and destination facts instead of rolling back a transition that may have reached the host. Reload invalidates Pi contexts, so delayed handoffs retain only controls captured while live. [Host-session checks](../DEVELOPMENT.md#upgrades) exercise these integration boundaries.

### Native file destinations

Classify native writes before writer admission. The [external-write decision](https://github.com/taekwondodev/dev/issues/67) permits ordinary external files without reserving unrelated checkouts; temp-only exceptions would miss configuration edits. One classifier serves lead, authority and child guards, pinning the original operand, canonical destination and workspace/external classification. Unreadable ancestry is not proof of external access.

[Foreign delegation](https://github.com/taekwondodev/dev/issues/134) selects another checkout only for a child. A managed worktree lets it receive that repository's guidance and writer scope while the lead keeps its binding. Lead rebind and multiple bindings were rejected: they would put foreign guidance and ownership into the lead's context. Admission and selection limits live in [Workspace](../workspace.md#delegation-into-another-checkout).

Workspace writes are scoped operations whose start is reported inside the filesystem adapter and whose completion follows the Pi call or session end. External writes instead use session-local permits with no persistent registry, cross-session ownership or cleanup permission. Children retain controller admission and liveness checks at the operation boundary. Abrupt child interruption cannot identify the file being written; revisit if that recovery need becomes frequent.

Preserve exact operand matching before re-resolution, raw-parent-traversal and shorthand refusals, regular-file/no-hardlink checks and boundary revalidation. A changed alias cannot borrow another in-flight permit. Final links are never followed; Git administration and authority/coordination metadata stay protected. Managed worktrees inside authority storage are writable only in their own scope. Pathname checks retain a race with external link or ancestor changes; stronger descriptor-based integration would be needed to narrow it.

## Release

Managed worktrees are disposable after delivery; pre-existing checkouts lose only reservations. The [disposal decision](https://github.com/taekwondodev/dev/issues/42) rejects exhaustive per-file certification. The workflow owns integrating wanted work and publishing selected artifacts, including failed-publication checkpoints. Runtime evidence is not a parallel workflow authority, and source-history inclusion proves neither semantic equivalence nor delivery of dirty edits.

There are two distinct authorities:

- **Sweep:** automatic disposal requires completion evidence, valid identity and structural checks, and no blocking use. Reassessment under gates authorizes the effect.
- **Task release:** interactive user confirmation overrides completion, evidence and uses for the whole task. It therefore takes no path or installation gate; the user is responsible for stopping work first. It still respects explicit Git locks and the repository structure gate. Agent tools have no release path.

Git's single force flag implements bounded disposal, not an authorization bypass. Never double-force, add unattended release flags or prune broadly. [Release operations](../workspace.md#release) own confirmation, consequences and retry guidance.

### Completion and evidence

The [automatic-release decision](https://github.com/taekwondodev/dev/issues/44) gives check and sweep one pure completion function over recorded and observed facts. `src/workspace-completion.ts` and its table tests own decision order; [workspace completion](../workspace.md#completion-evidence) names the verdicts. Preserve these constraints when changing predicates:

- Missing identity, unresolved transitions, unfinished release and live/unknown/abandoned uses retain. A missing directory is not completion.
- A branch at its allocation base is trivially in the target, so delivery requires its own commits. A detached child's delivery PR must strictly descend from its base, postdate allocation and have its merge result reachable from the target. [Its own commits may be discarded](https://github.com/taekwondodev/dev/issues/123) when the lead integrated its work by patch.
- Sibling evidence comes from task-managed workspaces with own commits, reserved or removed by confirmed release. A PR found only through a sibling must contain that sibling's HEAD. Unreadable evidence is unknown, not refuted.
- A target naming the workspace's own branch, remote alias or push destination proves nothing; a differently named configured upstream can be valid. Derive targets only when integration proof is needed.
- Merged-PR evidence binds provider facts to the exact merged source revision, not today's branch tip. Share identical provider reads within a request; late evidence is unavailable.
- [Ignored files](https://github.com/taekwondodev/dev/issues/47) are not completion residue, but still enter inventory and structural checks. Selected publication digests stream regular files through no-follow descriptors. Publication heuristics certify neither general content safety nor unselected dependencies as blockers.
- Assessment Git reads disable hooks, prompts, lazy fetching, optional locks, replacements and grafts: observing delivery must not execute project effects or accept rewritten history.

### Fenced effects

A check records nothing and holds no gate. Sweep assesses, acquires structure, exclusive presence and writer gates for a finished workspace, then reassesses. That gated reassessment is the decision, not a versioned receipt binding an earlier check to removal. Sibling evidence from the task assessment is reused within the sweep. An occupied directory or conversation file inside the tree retains it.

[ADR 0004](0004-authoritative-lifecycle-incremental-store.md#release-records) owns started-removal records, observed outcomes and interrupted-effect recovery. Sweeps never retry incomplete removals automatically; explicit release supersedes them. Leftover deletion requires Git to no longer list the worktree, stays inside managed roots and preserves an admin directory serving a moved worktree.

Installation-source presence is independent of project cwd and precedes local coordination. Sweep claims the installation's existing local gate exclusively; missing or malformed coordination retains it. A gate only inside the tree is insufficient because deletion could recreate it on another inode. Close local claims before source presence, retaining presence if closure fails.

### Sweep and quit

Sweep is one budgeted worker operation per repository, before allocation's structure gate or after quit disposes the runtime. Host-side check/release loops were rejected because they split policy and require another admission decision. Budgets include queue time; unstarted tasks defer. Quit may prefetch PR evidence because disposal leaves sweep as that worker's only request. Other processes remain coordinated through gates, short transactions and reassessment.

The launcher intercepts Pi's awaited interactive `dispose` to distinguish quit from signal shutdown. Stop work and shells, close attachment and installation/source claims, leave the workspace directory, then sweep with the conversation file marked occupied. Started removal and its receipt are uninterruptible. Preserve this ordering and its real-TUI checks when changing quit; the operator-visible triggers and interruption behavior belong to [Workspace](../workspace.md#quit-and-interruption).

### Accepted external-process race boundary

Coordination does not contain concurrent filesystem changes by nonparticipants. An external process can move or replace contents during deletion and have them deleted. This accepted limit and the operational precautions live in [SECURITY](../../SECURITY.md#outside-the-protection). Revisit before supporting external writers during release or promising atomic deletion containment; it does not relax sweep gates or rechecks.

## Effect boundary

Coordination runs in Effect with typed failures and shared process observation/retry policy. Promises remain at Pi calling points: extension handlers, runtime factory, session replacements and tool-operation adapters running Effect through the host context. The authority worker's synchronous SQLite engine is the other boundary. One style was chosen over a parallel Promise layer despite rewrite cost. Pi session/native-file errors cross back unchanged because Pi recognizes some by class and owns their recovery; workspace refusals remain typed domain failures.

Deliberate departures from the Effect guide:

- Launcher and maintenance argument parsing stay manual to preserve pass-through, error output and startup cost.
- `runGit` in `src/pi-child.ts` and `readHead` in `src/workspace-tool.ts` use `node:child_process` because the Effect spawner hides the terminating signal, changing model-visible errors.
- Startup's `git rev-parse` in `src/preferences.ts` and `which pi` in `src/pi-runtime.ts` also stay there: they are short, uninterrupted commands for which the spawner added measurable startup time.
- `allowedUnstableApis` admits only the modules needed from the pinned release, not all Effect APIs; no stable alternatives exist for the admitted integrations.
- The authority client is a lazily opened scoped Effect passed by argument, not a layer-provided service that would start the worker for help or diagnostics.

## Executable extensions

The [accepted policy](https://github.com/taekwondodev/dev/issues/36#issuecomment-5815706403) trusts Pi and installed extensions rather than sandboxing arbitrary plugins. Non-project presentation, status and notification effects need no admission; trust does not exempt project writes. This accepts targeted integration maintenance instead of universal containment. [SECURITY](../../SECURITY.md) owns the trusted base, Pi folder-trust exception and extension review requirements.
