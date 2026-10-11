# Background compaction

The lead and each child can prepare a Pi summary while ordinary work continues, then apply it at a safe boundary. Each session handles its own context independently.

## Controls

Background preparation follows Pi's automatic-compaction setting and needs no separate command. `/compact` still runs native manual compaction, including custom instructions and configured hooks.

Esc or programmatic abort cancels pending preparation and discards a ready summary that has not applied, even while idle. It does not undo an already-applied summary or start another turn.

## What happens to context

Preparation begins ahead of Pi's native blocking threshold when there is a valid cut. At most one preparation runs per session. Native compaction takes precedence if the blocking threshold is reached.

A ready summary applies at the first safe turn or settle boundary, or immediately while idle without a model request. The selected recent history and messages added during preparation remain verbatim. Raw conversation history stays stored.

Loaded extensions observe applied summaries before the next model request, so their view of history stays current. Discarded preparations send no notification. Background preparation does not show Pi's blocking-compaction UI.

Changing the summarized context, branch or session invalidates a pending result. Navigation, reload and closing discard pending work; reopening restores stored history, not an unfinished preparation. Preparation failure leaves ordinary work and native recovery available.

## Inspect compaction activity

Run `npm run profile`; [Timing and compaction](usage-profile.md#timing-and-compaction) explains the figures and their limits. Observations are collected automatically in session files, outside model context, without extra inference. Diagnostic-write failures reduce report coverage without blocking work or compaction.
