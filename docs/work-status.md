# Work notices and status

Part of the [work guide](work.md).

## Quiet commands

A command can hang without exiting. When a running `process` attempt adds nothing to stdout or stderr for 2 minutes, dev raises a quiet notice with the command's runtime, quiet time and output tails, with recognized credentials redacted. Dev never stops the command; the agent or the user decides whether to wait, inspect or cancel it.

The first notice of a command reaches the model only when that costs no cold request: a running lead receives it at its next turn, and a resting lead wakes for it only when its last model request is under 5 minutes old and automatic continuation is allowed. Otherwise the notice waits for the lead's next run, whoever starts it, and the [program status](#program-status) reports `blocked`. A notice is dropped when its command prints again, settles or is stopped first; a notice that fails to reach the conversation waits for the next run. After a command's notice reaches the model, its later silences are shown only to the user.

A superseded notice can still reach the model when Pi runs a blocking compaction before a wake, or when another extension delays dev's turn-boundary entry; an extension that removes that entry can cost the command its only model notice. [#322](https://github.com/taekwondodev/dev/issues/322) records the decision.

## Program status

Pi reports the lead's state to terminals that support the [Program Status Protocol](https://www.superlogical.com/rex/docs/build/program-status): `working` during a run and `done` when it settles. Dev changes one case. While the lead rests and outcome delivery will start its next run without a user message, the terminal receives `working` instead of `done`: a command or child the lead started has not settled, or one of their outcomes still awaits a delivery that can continue the lead.

While the lead rests with a [quiet notice](#quiet-commands) waiting for the user, dev reports `blocked` with the quiet commands' task keys instead, until the commands print again, settle or stop, or the lead starts a run.

`done` follows as soon as nothing will resume the lead: the resumed run settles with no work left, the work is stopped, or automatic continuation ends under the [delivery](work.md#delivery-and-verification) or [failure](work.md#failures-and-visibility) rules. `blocked`, `error` and the `idle` of a cancelled run arrive as Pi sends them. The application name is always Pi's, and so is the message except in the quiet `blocked` above.

Commands and children count alike. A command that never exits, such as a server or a watcher, counts as unsettled until `/work stop` ends it. [ADR 0006](adr/0006-global-visual-layer.md) records why this rule lives in dev rather than in a global extension.

## Live view

Dev publishes `dev/work-view` on Pi's event bus only when a UI is present. Each emission replaces the session's previous view; closing work emits an empty view. Global extensions own presentation under [ADR 0006](adr/0006-global-visual-layer.md). The [view declaration](../src/work-view.ts) owns its exact fields.

A batch includes active children and children that settled since the owner's last message. Outcome deliveries and other extension input do not close it; the owner's next message drops settled children. Leaves retain their coordinator in the view. Local commands contribute a running count and their [quiet](#quiet-commands) members rather than child rows.

Live activity is transient: it stays in controller memory, never in the attempt store or model context. Updates are coalesced without reading the store on each tick. [SECURITY](../SECURITY.md#credentials) owns target disclosure and redaction limits.
