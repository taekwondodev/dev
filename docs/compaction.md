# Background compaction

The lead and each child can prepare a Pi summary while ordinary work continues, then apply it at a safe boundary. Each session handles its own context independently.

## Controls

Background preparation follows Pi's automatic-compaction setting and needs no separate command. `/compact` still runs native manual compaction, including custom instructions and configured hooks.

Esc or programmatic abort cancels pending preparation and discards a ready summary that has not applied, even while idle. It does not undo an already-applied summary or start another turn.

## What happens to context

Preparation begins ahead of Pi's native blocking threshold when there is a valid cut. At most one preparation runs per session. Native compaction takes precedence if the blocking threshold is reached.

A ready summary applies at the first safe turn or settle boundary, or immediately while idle without a model request. The selected recent history and messages added during preparation remain verbatim. Raw conversation history stays stored.

Each applied summary is announced to loaded extensions through Pi's `session_compact` event, with the committed `compactionEntry`, `fromExtension: true`, `reason: 'threshold'` and `willRetry: false`, as native automatic compaction sends. Extensions that mirror history, such as `pi-claude-bridge`, rebuild from it. The event is sent after the entry is stored and the context refreshed. The next model request, whether a new prompt or a continuation after a tool result, waits until every handler has completed. Discarded or rejected summaries send no event, and a superseding native compaction sends only its own. The TUI's `compaction_start` and `compaction_end` events are not sent for background summaries.

Changing the summarized context, branch or session invalidates a pending result. Navigation, reload and closing discard pending work; reopening restores stored history, not an unfinished preparation. Preparation failure leaves ordinary work and native recovery available.

Compaction grants children no extra tools or write permissions. Observed summarization usage counts once in the session's totals, including completed summaries that were discarded.

## Inspect compaction activity

Run `npm run profile` and read the [compaction figures](usage-profile.md#timing-and-compaction). Observations are collected automatically in session files, outside model context, without extra inference. Diagnostic-write failures reduce report coverage without blocking work or compaction.

The report can show what was prepared, applied or discarded. It cannot establish that a run became faster or that a summary retained everything useful; inspect the conversation when assessing information loss.
