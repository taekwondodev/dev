# ADR 0012: Workspace release

Managed worktrees are disposable after delivery; pre-existing checkouts lose only reservations. The [disposal decision](https://github.com/taekwondodev/dev/issues/42) rejects exhaustive per-file certification. The workflow owns integrating wanted work and publishing selected artifacts, including failed-publication checkpoints. Runtime evidence is not a parallel workflow authority, and source-history inclusion proves neither semantic equivalence nor delivery of dirty edits.

Builds on the gates, identity and admission of [ADR 0005](0005-scoped-runtime-coordination.md).

There are two distinct authorities:

- **Sweep:** automatic disposal requires completion evidence, valid identity and structural checks, and no blocking use, [reassessed under gates](#fenced-effects).
- **Task release:** interactive user confirmation overrides completion, evidence and uses for the whole task. It therefore takes no path or installation gate; the user is responsible for stopping work first. It still respects explicit Git locks and the repository structure gate. Agent tools have no release path.

A pre-existing checkout no task reserves has no task to release, so the same confirmed override also clears the use records ended sessions left there; uses of running sessions stay because no confirmation stands in for their owner.

[Orb recovery](https://github.com/taekwondodev/dev/issues/215) can replace user confirmation with evidence: the record's owner lock proves the session dead, the authority rechecks its free incarnation gate, and remote tool execution leaves no local descendants writing the checkout. Interrupted returns are excluded because the local write may be half done. A failed start can withdraw its own presence before admitting any orb tool or return, since it never wrote the checkout. Settlement does not release managed worktrees. [Orb recovery](../orb.md#recovery) owns the operational conditions and reservation effects.

Git's single force flag implements bounded disposal, not an authorization bypass. Never double-force, add unattended release flags or prune broadly. [Release operations](../workspace-cleanup.md#release) own confirmation, consequences and retry guidance.

Task artifact deletion changes no Git state, so it is retryable without a fenced Git-removal record. [Task artifacts](../workspace-admission.md#task-artifacts) owns retention, removal outcomes and recovery.

## Completion and evidence

The [automatic-release decision](https://github.com/taekwondodev/dev/issues/44) gives check and sweep one pure completion function over recorded and observed facts. `src/workspace-completion.ts` and its table tests own decision order; [workspace completion](../workspace-cleanup.md#completion-evidence) names the verdicts. Preserve these constraints when changing predicates:

- Missing identity, unresolved transitions, unfinished release and live/unknown/abandoned uses retain. A missing directory is not completion.
- A branch at its allocation base is trivially in the target, so delivery requires its own commits. Own commits cannot distinguish work committed in the worktree from target commits the branch was moved onto, so remaining residue retains even a delivered branch worktree. A detached child's delivery PR must strictly descend from its base, postdate allocation and have its merge result reachable from the target. [Its own commits may be discarded](https://github.com/taekwondodev/dev/issues/123) when the lead integrated its work by patch.
- Sibling evidence comes from task-managed workspaces with own commits, reserved or removed by confirmed release. A PR found only through a sibling must contain that sibling's HEAD. Unreadable evidence is unknown, not refuted.
- A target naming the workspace's own branch, remote alias or push destination proves nothing; a differently named configured upstream can be valid. Derive targets only when integration proof is needed.
- Merged-PR evidence binds provider facts to the exact merged source revision, not today's branch tip. Share identical provider reads within a request; late evidence is unavailable.
- [Ignored files](https://github.com/taekwondodev/dev/issues/47) are not completion residue, but still enter inventory and structural checks. Selected publication digests stream regular files through no-follow descriptors. Publication heuristics certify neither general content safety nor unselected dependencies as blockers.
- Assessment Git reads disable hooks, prompts, lazy fetching, optional locks, replacements and grafts: observing delivery must not execute project effects or accept rewritten history.

## Fenced effects

A check records nothing and holds no gate. Sweep assesses, acquires structure, exclusive presence and writer gates for a finished workspace, then reassesses. That gated reassessment is the decision, not a versioned receipt binding an earlier check to removal. Sibling evidence from the task assessment is reused within the sweep. An occupied directory or conversation file inside the tree retains it.

[ADR 0004](0004-authoritative-lifecycle-incremental-store.md#release-records) owns started-removal records, observed outcomes and interrupted-effect recovery. Leftover deletion requires Git to no longer list the worktree, stays inside managed roots and preserves an admin directory serving a moved worktree.

An allocation interrupted after its Git effect started follows the same rule: sweeps only list it and explicit release clears it. That release takes the removal gates of the target, leaves a path another workspace record has taken, and deletes a Git admin directory only when Git's own link ties it to the target. Attachment registers a checkout without a path gate, so a conversation attaching between that ownership check and the removal is not excluded; it holds no admitted write. Gating every attachment was rejected as a cost on the frequent path for a race that loses no admitted work.

Installation-source presence is independent of project cwd and precedes local coordination. Sweep claims the installation's existing local gate exclusively; missing or malformed coordination retains it. A gate only inside the tree is insufficient because deletion could recreate it on another inode. Close local claims before source presence, retaining presence if closure fails.

## Sweep and quit

Sweep is one budgeted worker operation per repository. Host-side check/release loops were rejected because they split policy and require another admission decision. Quit may prefetch PR evidence because disposal leaves sweep as that worker's only request. Other processes remain coordinated through gates, short transactions and reassessment.

[Issue #163](https://github.com/taekwondodev/dev/issues/163) amends the quit-only scope of [issue #44](https://github.com/taekwondodev/dev/issues/44): the leaving conversation may end its own claim at replacement, but an unrelated allocation must not strip another task's reservation between sessions. A checkout with no commits is outside that rule: nothing can be allocated from it, so a reservation there can only refuse the next task, and its untracked files keep a sweep from ever releasing it. [Admission](../workspace-admission.md#admission-and-isolation) hands it to the next writer only under the active-use and writer-gate checks of a first write and a fresh observation under that gate that no commit arrived. A first commit made only to allow allocation was rejected because the worktree would lack every uncommitted file. Sweeping between attachment lifetimes prevents the arriving conversation's presence from blocking disposal. [Workspace](../workspace-cleanup.md#sweep) owns sweep triggers, outcomes and budgets.

[One owner](../../src/session-end.ts) holds how far the end of a session has come. It parks Pi's awaited interactive `dispose`, so Pi neither prints its resume hint nor exits 0, and it classifies that call one microtask later, because Pi's own signal handlers call `dispose` before dev's handler has recorded the signal. It takes `dispose` over before the workspace host wraps it, so Pi's call and the launcher's real disposal both pass through the host. State split between the host's interception, the launcher and two sets of signal handlers was rejected because no one place said what a quit or a signal would do. Sweeping inside `session_shutdown` was rejected in [issue #313](https://github.com/taekwondodev/dev/issues/313): a disposal that fails after the handlers would leave workspaces already swept, and the release prompt would wait inside a Pi handler. Stop work and shells, close attachment and installation/source claims, leave the workspace directory, then sweep with the conversation file marked occupied. Started removal and its receipt are uninterruptible. Preserve this ordering when changing quit; the operator-visible interruption behavior belongs to [Workspace](../workspace-cleanup.md#quit-and-interruption).

## Accepted external-process race boundary

Coordination does not contain concurrent filesystem changes by nonparticipants. This accepted limit lives in [SECURITY](../../SECURITY.md#outside-the-protection); [release](../workspace-cleanup.md#release) states the precaution. Revisit before supporting external writers during release or promising atomic deletion containment; it does not relax sweep gates or rechecks.
