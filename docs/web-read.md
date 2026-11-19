# Read URL

`read_url` returns a documentation page's text with sources. It works in this conversation and for delegated agents, directly or through codemode. If a normal fetch is not enough, dev uses a separate copy of your signed-in Chrome profile under the [browser security boundary](../SECURITY.md#browser-profile-copy).

## Use

In codemode, call `tools.read_url({ url })`. Use `describeTool('read_url')` for inputs and outputs. Set `maxChars` to limit each part, then pass `continuation` if returned.

Results identify the source, method and limitations. `outcome` is `document` for the last part if nothing was cut, `partial` if there is more saved text or the page hit a size limit, and `failed` if nothing was read. Indexes such as `llms.txt` are suggestions, not substitutes.

The text omits the title only when the part shows a complete first line and that line matches the title after removing any leading Markdown heading marker and trimming both. A first line is complete if the part includes its newline or reaches the end of the saved text. The first part lists each of the first 40 collected links whose full absolute URL it does not show. A URL counts as shown only where it starts the text or follows whitespace, an opener, a quote, a backtick or `>`, so one inside another URL does not count. A URL opened by `(`, `<` or a quote counts as shown only if its closer follows, or whitespace after `(`, as in a Markdown link title. Any other URL counts as shown if followed by whitespace, a closing delimiter other than an apostrophe, or the end of the saved text; sentence punctuation counts as an ending only when followed by whitespace or the end of the saved text. The list starts with `Links (listed of total):` and is omitted when no links are listed.

An HTTP status appears only as a limitation. The structured result keeps `title`, `status` and the first 200 of up to 500 collected links.

From a terminal:

```bash
dev browser            # inspect Chrome, the source profile, dev's copy and browser status
dev browser revoke     # disable authenticated rendering and delete dev's profile copy
dev browser enable     # allow authenticated rendering again
```

## Retrieval

Static retrieval prefers origin Markdown, accepts plain text and otherwise extracts readable HTML into text with headings, code blocks, lists, tables and absolute links. Usable static content never launches a browser.

Chrome is used when extracted text is thin on a script-dependent page or the origin answers 401, 403, 429 or 503. A browser result says that Chrome used a separate copy of your signed-in profile. When Chrome is missing, disabled or unavailable, the static result is returned with that limitation.

Reads have body, time and concurrency limits; a cut body is reported as `partial`, and exhausted capacity or time is reported explicitly. Aborting cancels the static read, browser wait or render and closes only that render's pages; a Chrome launch already in progress completes first. A page posting a body of tens of megabytes can stall its render until timeout; the next read relaunches Chrome if needed.

Destinations must satisfy the [network policy](../SECURITY.md#network-policy). Fetched content is untrusted text, including when the page was read through your account.

## Documents and continuation

A continuation reads more of the same saved text without fetching again. If the text is no longer saved or the token came from another conversation, read the URL again. Closing the conversation discards its saved text, not the Chrome profile copy.

## Shared browser lifecycle

Dev runs one browser service per data home. Reads from different conversations can run at the same time. Cancelling a read or closing a conversation leaves other reads alone. If Chrome or the service fails, pending reads can fail without being retried.

Chrome closes after three idle minutes and reopens on demand. When the last reader disconnects, the service closes Chrome and exits. Dev refreshes the copy before each launch. If Chrome locks its cookie database or a refresh fails, dev reports the error rather than opening an incomplete copy.

If dev cannot verify that Chrome stopped, it keeps the profile locked and reports why in `dev browser status`. A later Chrome read or revoke retries shutdown. If the service dies, the OS frees the locks, but Chrome may still be running. The leftover record blocks a restart, refresh or deletion. Follow the recovery steps below.

## Revocation

`dev browser revoke` disables new Chrome reads, then waits up to ten seconds for current reads without cancelling them. Dev deletes only its copy after verifying Chrome stopped. If the reads take too long or dev cannot confirm shutdown, Chrome reads stay disabled and dev keeps the copy. Retry after the reads finish, or follow recovery if the service died.

`dev browser enable` allows Chrome reads again but cannot clear a leftover browser record or let dev reuse the copy before recovery.

If a browser command times out, dev cannot confirm it finished. Check `dev browser status` before retrying.

### Recovery after owner death

1. Stop dev's browser service and any remaining Chrome processes using this data home's copy. Verify they are gone.
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
