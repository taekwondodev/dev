# Usage profile

Use the profile to inspect recorded consumption, tool errors and repeated work across lead and child sessions. It reads saved Pi conversations offline; it does not call a model, run recorded commands, open files named by tool calls or change transcripts.

## Run a report

From the dev checkout:

```bash
npm run profile
npm run profile -- --data-home PATH
npm run profile -- --period 2026-09-01..2026-10-01
npm run profile -- --period ..2026-09-01 --period 2026-09-01..
```

The default data home is the launcher's [private storage](launcher.md#state). Reports include retained lead and child sessions, abandoned branches and interrupted work. Copied fork history is not counted again.

[Automatic cleanup](launcher.md#automatic-history-cleanup) reduces historical coverage: deleted conversations do not contribute to regenerated reports. Files that disappear before they can be opened are skipped.

Periods use UTC dates, with the start included and the end excluded; either end may be omitted. Multiple periods compare later selections with the first. A selection with nothing measurable fails without changing saved reports.

The report prints to the terminal and is saved to `<data-home>/usage/<selection>.json`, replacing the previous report for that selection. The same unchanged input produces the same report. Private reports use mode `0600`.

## Read the results

### Consumption and attribution

Token totals are cumulative consumption, not the size of the current context. Reasoning is already part of output tokens. Cache-read share is cache-read divided by input plus cache-read plus cache-write; uncached tokens are input plus cache write. First requests are reported separately from later ones.

Model, effort, skill and child-role groups come from recorded session history, not today's settings. Missing usage or attribution stays unknown rather than becoming zero. Undecodable lines are skipped and counted, so check report coverage before comparing totals.

### Tool outcomes

`returned` means a matched tool call/result has no recorded error, not that the task was correct. Errors include invocation mistakes, execution failures, blocks and cancellations; unrecognized errors remain unclassified. A failed test command is an execution failure.

Codemode parse errors, exceptions and timeouts count as execution failures; aborts count as cancellations. The profiler infers the outcome from recorded output that can contain script-supplied text. It leaves results unclassified if the output was truncated or the recorded error endings disagree about whether the script was aborted. A script error that looks exactly like an abort is counted as a cancellation.

Calls without results are unmatched. The chart's success percentage is `returned / matched` across leads and children; unmatched calls and results without calls are excluded. With no matched calls it shows `n/a`. The other chart tiles are lead-only.

Candidate repeated-error or recovery sequences connect a failed result to a later call of the same tool. They suggest places to inspect, not an established causal relation.

### Operations inside codemode

The private report counts recorded codemode operations separately from the outer script call. Internal `ok`, `error` and `unfinished` counts describe the operations, even when the script returns without error. Missing or malformed metadata means coverage is unknown; a complete empty list records zero operations. Incomplete metadata can omit calls or arguments, and malformed calls are counted separately from operation totals.

Operations count in the outer result's UTC period. Durations are per operation, not elapsed script time: operations may overlap and some have no recorded duration.

The report also counts, for leads and for children, codemode results whose output passed the script's [output limit](work.md#execution-and-access), out of all their codemode results. A result counts as cut when Pi recorded where it saved the full output; text that only looks like Pi's warning does not count, and a cut whose full output Pi could not save is missed. Next to it, the report counts the codemode results whose script set its own `max_output_tokens` on a first-line `// @options:` line that Pi accepts, and lists each declared value with its count: a value below the 25,000 tokens dev gives would lower the limit. The script is read as the conversation recorded it, which is how the agent wrote it, and each result is matched to the call on its own branch. The figures are private: the export has no place for them.

Pi does not record internal results, so the report cannot compare internal Git output. Launch figures use only direct `work` calls.

### Reads and Git requests

The report measures read overlap in two ways. Neither measure establishes waste or billed tokens. Files read or changed through shell commands are outside both measures.

- **Direct `read`:** compares returned line ranges on the same branch. It distinguishes pagination, identical or changed text, and intervening compaction or edits. Images and incomplete range information have unknown coverage.
- **Codemode `read`:** compares requested ranges with earlier codemode requests on the same branch, including those inherited in copied fork history. It uses paths as recorded, so relative and absolute spellings do not match. Requests count regardless of the result; empty ranges overlap nothing, and unusable arguments count as unknown. An overlap shows what was requested, not what text came back.

Git figures cover `git_inspect` and recognizable shell `git` commands. Wrappers, aliases and dynamic shell code may be missed. Repetition uses recorded command text and working directory, not inferred shell equivalence; compound or truncated output cannot establish identical results. These are diagnostics, not a complete shell audit.

### Timing and compaction

Model latency is the recorded request-to-response interval. Tool and waiting times are gaps before tool results and user messages, not CPU time or a causal breakdown. Percentiles use nearest rank. Direct-child figures exclude a coordinator's leaves.

[Background compaction](compaction.md) adds private observations of preparation, readiness, application and discarded/failed work. Ordinary-run overlap ends when the summary is ready; ready wait ends when it applies. Native spans cover Pi's reported start/end, not all perceived waiting. Proposed summaries are not applications.

Compaction consumption is already included in totals. Missing, unfinished and cross-period observations stay explicit; no observed compactions is different from missing instrumentation. Cancellation may be reported as `abort` without identifying the command that caused it. Hard process death can lose late usage. Overlap is not saved time, and these figures cannot establish summary quality or information loss.

### Period comparisons

Calls and their outcomes belong to the call's period; read diagnostics and unmatched results belong to the result's period. A period containing only results is measurable without inventing requests or token usage. Different sample sizes, unknown data and activity crossing period boundaries limit comparisons.

## Export for publication

```bash
npm run profile -- --export docs/performance
```

Export accepts one period and writes `usage-baseline.json`, `usage.svg` and `tools.svg` to the chosen directory. It is the only profile operation that writes outside the private report location.

The export contains numeric aggregates and allowlisted categories only. Session identifiers, paths, models, skills, compaction diagnostics and drilldowns stay private. Private drilldowns can contain session-entry references, read paths/ranges and Git-argument digests, but no prompts, file contents, argument payloads or raw errors. Do not publish the private JSON in place of an export.

Neither a private report nor an export can restore deleted conversations.
