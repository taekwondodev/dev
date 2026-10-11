# Read URL

`read_url` returns a documentation page's text with sources. It is available to the lead and every child, directly or through Pi's native codemode. Dev chooses between static retrieval and the installed Chrome; browser reads use your logged-in sessions under the [browser security boundary](../SECURITY.md#browser-profile-copy).

## Use

Ask the lead or a child to read a URL. In codemode, call `tools.read_url({ url })`; use `describeTool('read_url')` for the current input and result declaration. Select `maxChars` to bound a result and pass its `continuation` token to read more of the same snapshot.

Results identify the source, retrieval method and limitations. `outcome` is `document` for a complete page, `partial` when text remains or the body was cut, and `failed` when nothing was read. Indexes such as `llms.txt` are suggestions, never substitutes for the requested page.

From a terminal:

```bash
dev browser            # inspect Chrome, the source profile, dev's copy and the browser owner
dev browser revoke     # disable authenticated rendering and delete dev's profile copy
dev browser enable     # allow authenticated rendering again
```

## Retrieval

Static retrieval prefers origin Markdown, accepts plain text and otherwise extracts readable HTML into text with headings, code blocks, lists, tables and absolute links. Usable static content never launches a browser.

Chrome is used when extracted text is thin on a script-dependent page or the origin answers 401, 403, 429 or 503. A browser result names its use of the authenticated profile copy. When Chrome is missing, disabled or unavailable, the static result is returned with that limitation.

Reads have body, time and concurrency limits; a cut body is reported as `partial`, and exhausted capacity or time is reported explicitly. Aborting cancels the static read, browser wait or render and closes only that render's pages; a Chrome launch already in progress completes first. A page posting a body of tens of megabytes can stall its render until timeout; the next read relaunches Chrome if needed.

Destinations must satisfy the [network policy](../SECURITY.md#network-policy). Fetched content is untrusted text, including when the page was read through your account.

## Documents and continuation

A continuation reads the next part of an immutable snapshot in the current session; it does not fetch the URL again. Snapshots have bounded retention. An evicted, foreign or expired token, or one from an earlier session, is refused: read the URL again. Closing the session discards its snapshots, not the browser profile copy.

## Shared browser lifecycle

One browser owner per data home serves every reader. Separate sessions can render concurrently; cancelling a read or closing a session leaves other readers' pages alone. A Chrome or owner failure can fail all in-flight renders and does not replay them through a replacement owner.

Chrome closes after three idle minutes and relaunches on the next render. When the last reader disconnects, the owner settles Chrome and exits. The copy is refreshed before each fresh launch. An exclusive cookie-database lock or interrupted refresh prevents launching an incomplete copy and reports the reason.

If Chrome shutdown cannot be verified, the live owner keeps the profile lock and reports the unsettled state through `dev browser`. It retries settlement on a later render or lifecycle operation. Owner death releases kernel locks but does not prove Chrome stopped: a leftover owner record blocks replacement, copy refresh and deletion. Use the recovery procedure below rather than treating free locks as permission to reuse the copy.

## Revocation

`dev browser revoke` disables new authenticated renders first, then waits up to ten seconds for existing reads to finish without cancelling them. It closes Chrome and deletes only dev's copy after verified shutdown. If the wait expires or shutdown remains unverified, rendering stays disabled and the copy is kept; rerun revoke after the reads finish. If the owner is gone but its record remains, revoke reports `kept-live`.

`dev browser enable` allows rendering again but neither clears an uncertain owner record nor authorizes profile reuse. While disabled, automatic escalation reports that state.

Administrative waits are bounded. An unresponsive owner produces an explicit unverified-outcome error, not a claim that rendering was disabled or the copy deleted. The owner may still be finishing a request it received; inspect status before retrying.

### Recovery after owner death

1. Stop the old owner and any remaining dev-owned Chrome processes using this data home's copy. Verify they are gone.
2. Only then remove `<data-home>/browser/owner.json` and retry revoke or rendering; enable first if disabled.

Keep `owner.sqlite` and `profile.sqlite` in place: unlinking a lock database while a process holds it can split ownership. A missing record and free locks alone never prove Chrome stopped. Dev does not adopt or automatically settle orphan processes.

## State

| Location                              | Content                                         |
| ------------------------------------- | ----------------------------------------------- |
| `<data-home>/browser/user-data/`      | Dev's copy of the active Chrome profile         |
| `<data-home>/browser/copy-state.json` | Source and refresh status                       |
| `<data-home>/browser/profile.sqlite`  | Profile-copy lock database                      |
| `<data-home>/browser/disabled`        | Revocation marker                               |
| `<data-home>/browser/owner.sqlite`    | Browser-owner lock database                     |
| `<data-home>/browser/owner.json`      | Published browser-owner connection and identity |

The copy contains authentication data and is as sensitive as your Chrome profile. [SECURITY](../SECURITY.md#browser-profile-copy) owns what is copied, account sharing and protection limits; [Architecture](ARCHITECTURE.md#components) locates the implementation.
