# ADR 0005: Scoped admission for concurrent dev sessions

Coordinate cooperating dev runtimes through account-wide workspace reservations and separate kernel-lock gates for installation, conversation and checkout ownership. The checkout, not the repository or runtime fleet, is the contention unit: independent work proceeds concurrently without making a dead process's PID a claim to ownership. This is cooperative coordination, not an OS sandbox.

The [accepted specification](https://github.com/taekwondodev/dev/issues/18), [workspace authority decision](https://github.com/taekwondodev/dev/issues/31#issuecomment-5798717688) and [checkout isolation decision](https://github.com/taekwondodev/dev/issues/27#issuecomment-5795675435) record the scope and alternatives. [Workspace](../workspace.md) owns commands, observable behavior and recovery; this record preserves constraints for changing admission, process observation or release.

## Gates and identity

Use separate SQLite rollback-journal lock databases instead of a global mutex or filesystem/PID registrations. Process death releases kernel locks; published lock databases stay in place because unlinking them can split owners across inodes.

Installation admission stays in checkout-local `.dev/coordination/`, independent of data-home overrides. Runtimes hold it shared and maintenance holds it exclusively. Local conversation claims bind canonical file and Pi session ID within the canonical data home; hard links and malformed layouts are refused. An additional account-wide conversation gate sees competing installations, and incarnation gates distinguish uses left by ended sessions.

The authority is account-wide because installation-local leases cannot coordinate the same repository across data homes. Readers and writers share checkout presence; only the writer takes the writer gate. Structural Git effects take a repository gate. Acquire structure, canonical path slots, then short record transactions; merge duplicate slot requests into writer access when any request writes. Ordinary commands must not fence every linked worktree.

A free gate does not prove that descendants of a dead controller are gone. Durable use facts, current acquisition/binding fences and physical identities remain necessary. Persist volume UUID plus lossless inode for checkout and Git objects, not reboot-unstable `st_dev`. Resolve all paths in one bounded Foundation observation and refuse lookup failures or object races rather than falling back to paths. Current-layout validation remains mandatory under the [single-schema rule](../../AGENTS.md#boundaries); resets require affected runtimes and maintenance operations stopped.

## Scoped workspace operations

A lead or background shell is an opaque operation within its conversation's writer grant, occupying only that checkout. Git's locks govern a shell's structural commands as they do an external program; dev's structure gate protects dev's own structural effects. Scoped operations require an ordinary grant and cannot nest inside scoped operations or process grants. Ordinary reads fence nothing.

The lead records tool effects after review under the [extension policy](#executable-extensions), never by name alone. The `workspace` tool uses read admission: its writes are authority records, and resume goes through the host's rebind path. A `work` call acquires writer admission while it runs, after the host tool gate. A refusal returns an error result requesting termination rather than throwing, because a thrown error cannot request termination.

Native Pi batching has one accepted limit: a refused unclassified tool earlier in a batch that later parks the host can cost another request in the old context; calls in that request are refused as parked. Changing this requires a handoff from an aborted run and real-TUI proof that an extension abort is not treated as user Escape. The adapter and event regressions are covered by the [Pi integration checks](../DEVELOPMENT.md#upgrades).

A read-only leaf is the only read admitted outside the conversation's binding. The attachment admits it on its coordinator's started process grant, issued to that same attachment. The leaf records a use settled with its own process family, but holds no separate gate because the coordinator already holds presence. This lets a writer's reviewers see uncommitted files without unrecorded participation. [Bounded nesting](https://github.com/taekwondodev/dev/issues/19) records the requirement.

### Process observation

A process use ends only when its group and every tracked descendant are observed gone, not on shell exit or result receipt. Capture identity before releasing user code and match fresh process-table birth identities before signalling. A root group remains attributable while a member lives. Observe the exit event rather than stdio closure, since a surviving child can keep pipes open. An unacknowledged identity report may already be durable, so observe the stopped family rather than assuming launch never happened.

Detachment before observation can escape tracking. That residual risk, including children whose Pi shells start new sessions, is accepted instead of marking every shell unknown. Once observation is lost, `unknown` is absorbing: later reports or host transitions cannot settle it, and a grant cannot settle while a dependent operation is live. The [command contract](https://github.com/taekwondodev/dev/issues/34#issuecomment-5799183185) supplies no repair operation; explicit recovery must be designed before blocked checkouts can be reused.

A live process prevents switching or automatic isolation because moving its conversation would close owned work without the required confirmation. Session end or replacement stops and observes shells before closing the attachment; reload keeps them observed.

### Conversation transitions

Claim resume/replacement targets before Pi opens them where its lifecycle permits. Release unused provisional claims after success, cancellation or failure without losing the current owner. The account-wide gate proves no other host still performs that conversation's switch: an attach can withdraw a switch never delivered to the host, but a started switch needs review.

Resume and stored-session import attach before teardown. New, fork and copied import attach in the runtime factory after teardown, so authority refusal can end the session, an accepted lifecycle limit. Fork creates a new conversation without sharing the original task; first-write isolation is intentional. Quit cancels an authority-started switch that the host has not acted on and waits for settlement.

Cross-repository conversation publication is recoverable, not atomic. Keep uncertain source and destination facts rather than rolling back a transition that may have reached the host. Reload invalidates Pi contexts, so delayed handoffs retain only session controls captured while live. Native discovery, path resolution and header dependencies are exercised by the [host-session checks](../DEVELOPMENT.md#upgrades).

### Native file destinations

Classify a native write before acquiring a workspace writer grant. The [external-write decision](https://github.com/taekwondodev/dev/issues/67) permits ordinary external files without reserving or isolating an unrelated checkout; temp-only exceptions and scratch-directory requirements would miss configuration edits.

One classifier serves lead, authority and child guards. It pins the original absolute operand, canonical destination and workspace/external classification. It refuses foreign checkouts until selected and admitted, and protects Git administration and authority/coordination metadata. Managed worktrees inside authority storage are writable only in their own scope. Unreadable ancestry is not proof of external access.

Lead workspace writes are scoped `native-file-write` operations whose start is reported inside the filesystem adapter and whose completion follows the Pi call or session end. The authority refuses external destinations as workspace operations: those use session-local permits with no persistent registry, cross-session ownership or cleanup permission. Children retain coarse workspace/controller admission and the same adapter, rechecking controller liveness at the operation boundary. Read-only children gain nothing. Abrupt child interruption still cannot identify the file being written; revisit if that recovery need becomes frequent.

Keep exact operand matching before re-resolution, raw-parent-traversal and Pi-shorthand refusals, regular-file/no-hardlink checks and boundary revalidation. A changed alias cannot borrow another in-flight permit. Writes never follow a final link. Pathname checks still have a race with external hard-link or ancestor changes; only stronger descriptor-based integration could narrow it. These checks do not promise filesystem sandboxing.

## Release

Managed worktrees are disposable after delivery; pre-existing checkouts lose only reservations. The [disposal decision](https://github.com/taekwondodev/dev/issues/42) rejects exhaustive per-file certification: the workflow integrates wanted code/assets, reconciles contributions and publishes selected reports before delivery. Failed publication remains in the task checkpoint. The runtime consumes recorded readback facts, not issue closure or a model's declaration of completion, and adds no parallel workflow authority.

Release may discard all remaining managed contents, including dirty intermediate edits, dependencies and forgotten files. Git's single internal force flag implements this bounded disposal, not an authorization bypass. Never double-force, add unattended release flags or prune broadly.

Two deciders release. The sweep is automatic, so it acts only on completion evidence: live/unknown uses, changed identities and unsupported structure retain. `dev workspace release` is the user's override: it runs only after an interactive terminal confirmation, consults no completion, evidence or use, and clears every workspace of the task. The user runs it only when nothing still works there, so it neither waits for uses nor takes path gates. It still honours explicit Git locks and the repository structure gate, and deletes leftovers recursively only once Git no longer lists the worktree, only inside dev's managed root and never an admin directory serving a moved worktree. Agent tools have no release path; the session command only names the terminal command.

### Completion and evidence

The [automatic-release decision](https://github.com/taekwondodev/dev/issues/44) gives check and sweep one pure completion function over recorded/observed facts. `src/workspace-completion.ts` and its table tests own the exact decision order; [workspace behavior](../workspace.md#sweep) names the verdicts.

Preserve these non-obvious evidence constraints when changing predicates:

- Missing identity, unresolved transitions, an unfinished release or live/unknown/abandoned uses retain. A missing directory is never proof of completion.
- A paused branch at its allocation base is trivially in the target, so delivery requires its own commits. A detached child's delivery PR must strictly descend from its base, postdate allocation and have its merge result reachable from the target; [its own commits may be discarded](https://github.com/taekwondodev/dev/issues/123) because the task PR is the delivery evidence even when the lead integrated the child's work by patch.
- Sibling evidence comes from the task's managed workspaces with own commits, reserved or removed by a confirmed release. A PR found only through a sibling must contain that sibling's HEAD. Unreadable evidence stays unknown, not refuted.
- A target override naming the workspace's own branch, remote alias or push destination proves nothing. A differently named configured upstream can be valid. Derive a target only when integration proof is needed.
- Merged-PR evidence binds independent provider facts to the exact merged source revision. Today's branch tip alone cannot prove what merged. An identical provider read is shared within the request, and late evidence is unavailable.
- Ignored files do not count as completion residue, but remain in inventory and structural checks ([ignored-file correction](https://github.com/taekwondodev/dev/issues/47)). Publication digests stream regular files from no-follow descriptors.
- Assessment Git reads disable hooks, prompts, lazy fetching, optional locks, replacements and grafts. Assessment must neither execute project effects nor accept a rewritten history as delivery evidence.

Source-history inclusion is not semantic equivalence and says nothing about dirty edits. Publication heuristics cannot certify content as safe or turn unselected dependencies into disposal blockers.

### Fenced effects

A check records nothing and holds no gate. The sweep assesses without gates, then for each finished workspace takes the structure, exclusive presence and writer gates, assesses it again and acts only if it is still finished with valid evidence. The gated reassessment is the decision: no subject, digest, policy version or command ID binds an earlier assessment to the attempt. Within one sweep the sibling evidence read when the task was assessed is reused by its gated reassessments. An occupied directory or a conversation file inside the tree retains the workspace.

Persist a started operation before removal; observe directory, admin directory and Git's worktree list before recording success. A removal that does not complete stays open, refuses resume and makes the sweep retain the workspace as `release-review`; it is never retried automatically. `dev workspace release` supersedes the open attempt and removes again, so an interrupted attempt needs no observation of what it deleted. [ADR 0004](0004-authoritative-lifecycle-incremental-store.md) governs those durable external-effect facts.

Installation-source presence is independent of the project's cwd. A runtime or maintenance operation loaded from a managed worktree holds account-wide presence before opening local coordination and rechecks identity. The sweep's removal claims the installation's existing local gate under exclusive admission; missing/malformed coordination, including directory symlinks, retains the worktree. `dev workspace release` claims no installation gate. A gate only inside the tree is insufficient because deletion could recreate it on another inode. Close local claims before source presence; failed closure must not free that presence.

### Sweep and quit

A sweep is one budgeted worker operation per repository, before allocation's structure gate or after quit disposes the runtime. It assesses tasks and releases finished workspaces with one budgeted GitHub reader. Host-side check/release loops were rejected because they split policy and require another admission decision.

Budgets begin at the host request, including queue time; unstarted tasks become deferred. Quit can prefetch recorded PR evidence before local inventory because disposal leaves the sweep as that worker's only request. Other processes remain coordinated by path gates, short transactions and reassessment. Allocation sweeps stay synchronous inside allocation. Only quit and allocation trigger sweeps, not signals, crashes, startup or turn end.

The launcher intercepts Pi's awaited interactive `dispose` to distinguish quit from signal shutdown. It stops work and shells, closes the attachment and installation/source claims, leaves the workspace directory, then sweeps with the conversation file marked occupied. In-flight removal and its receipt are uninterruptible. Preserve this ordering and its real-TUI checks when changing quit.

### Accepted external-process race boundary

Release coordinates participants rather than sandboxing external filesystem changes. A nonparticipating process can move paths into the worktree, or replace part of it, while Git or dev deletes it; deletion then affects what that process put there.

The accepted workflow constraint is to run builds/watchers/servers through dev without detaching, stop independently started tools and avoid external changes during release. This does not relax the sweep's gates, evidence or rechecks. Revisit before supporting external writers during release or promising atomic deletion containment.

## Effect boundary

Dev's coordination, including the launcher, Pi host, authority client, shells, native writes and background work, runs in Effect with typed failures and shared process observation/retry policy. Promises remain at Pi calling points: extension handlers, runtime factory, session replacements and tool-operation adapters that run Effect through the host context. The synchronous SQLite engine behind the authority worker is the other boundary.

One style was chosen over a separate Promise layer despite the rewrite cost. Pi session/native-file errors cross back unchanged because Pi recognizes some by class and owns their recovery; workspace refusals remain typed domain failures.

Four departures from the Effect guide are deliberate. The launcher and `scripts/maintain.ts` parse arguments by hand because `effect/cli` would change argument pass-through, error output and startup cost. `runGit` in `src/pi-child.ts` and `readHead` in `src/workspace-tool.ts` stay on `node:child_process`: the Effect spawner hides the terminating signal and would change a model-visible message. The two commands every launch runs, `git rev-parse` in `src/preferences.ts` and `which pi` in `src/pi-runtime.ts`, stay there too: they finish in milliseconds, nothing interrupts them, and the spawner added measurable startup time. The type checker's `allowedUnstableApis` list admits `effect/http`, `effect/process` and `effect/workers` because the pinned release has no stable alternative. The authority client is a lazily opened scoped Effect passed by argument rather than a layer-provided service, because a layer would start the worker for modes that must not open the authority, such as `--help` and `--diagnostics`.

## Executable extensions

The [accepted policy](https://github.com/taekwondodev/dev/issues/36#issuecomment-5815706403) trusts Pi and installed extensions rather than sandboxing arbitrary plugins. Non-project presentation, status and notification effects need no admission; trust does not exempt project writes. This accepts targeted integration maintenance instead of universal containment.

The user's own project resources follow Pi folder trust and may initialize before workspace admission; untrusted folders load no project resources. [SECURITY](../../SECURITY.md) owns the trusted-base definition and the rule for adding or updating extensions.
