# Read URL

## Purpose

`read_url` lets the lead and every delegated child read a public documentation page by URL and get its text back with sources, without a search service, another subscription or an extra model. Dev negotiates Markdown with the origin, otherwise extracts the HTML locally, and renders in the installed Chrome only when static content is unusable. Native Pi codemode is active in every lead and child session, so scripts can compose reads and filter them before the model sees the result. Rendering is shared: one authenticated Chrome per data home serves every reader, so independent sessions read at the same time.

## Use

Ask the lead or a child to read a page; it calls `read_url`. In a codemode script, `tools.read_url({ url })` resolves to the structured result. Children get the same tool and the same results; their scripts reach no model catalog, and a read-only child still cannot write or run a shell from a script.

| Field          | Meaning                                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| `url`          | Absolute http(s) URL of the page to read.                                                                   |
| `continuation` | Token from an earlier incomplete result; returns the next part of the same snapshot without fetching again. |
| `maxChars`     | Characters of text per result (default 16000, 1000-120000).                                                 |

The result carries the requested and final URLs, the title when available, the retrieval method (`markdown`, `text`, `html` or `browser`), the HTTP status, the text, absolute links, suggestions, limitations and, when more text remains, a `continuation` token. `outcome` is `document` for a complete page, `partial` when text remains or the body was cut, and `failed` when nothing was read. Indexes such as `llms.txt` appear under suggestions; they are never substituted for the requested page.

From a terminal:

```bash
dev browser            # status of Chrome, the source profile, dev's copy and the browser owner
dev browser revoke     # disable authenticated rendering and delete dev's profile copy
dev browser enable     # allow authenticated rendering again
```

## Behavior

### Retrieval

The caller never chooses the transport: dev does. Static retrieval sends `Accept: text/markdown` first. A Markdown or plain-text answer is returned as is. HTML is extracted locally: the `main` or `article` element when it carries the content, otherwise a readability pass, otherwise the cleaned body; the result is Markdown-flavoured text with headings, code blocks, lists, tables and absolute links. Static content never launches a browser.

Chrome is launched when the static answer is unusable: the extracted text is thin on a page that depends on scripts, or the origin answered 401, 403, 429 or 503. The rendered DOM goes through the same extraction. A browser result always carries a limitation saying it was rendered with your authenticated profile copy, because the origin may have recorded the visit; isolation promises neither anonymity nor an effect-free read. When Chrome is missing, disabled or unavailable, the static result is returned with that limitation.

Results are bounded: 8 MiB per response body or rendered HTML, 45 seconds per static fetch, 5 redirects, 40 seconds of rendering including any wait for the browser, and four static reads at a time per reader. The shared browser runs at most four renders at once, one per reader, with 64 renders queued and 64 readers rendering; beyond that a read fails with a capacity message while status and revocation stay responsive. A cut body is reported as `partial` with the limit named. Aborting the tool call cancels a static read, the wait for the browser or a render promptly, and closes only that render's pages; a Chrome launch already in progress completes first.

### Network policy

Only public http(s) destinations are admitted. Dev refuses URLs with credentials, non-public host names (`localhost`, `.local`, `.internal`, `home.arpa`) and literal private or reserved addresses. Static retrieval resolves every host itself, refuses the whole answer when any address is private, reserved, link-local, CGNAT, multicast, IPv4-mapped, NAT64 or 6to4, and connects to the validated address only. Each static redirect is validated again. Browser subrequests (fetch, scripts, images, beacons, event streams, prefetches, frames, dedicated workers and the workers they create) have their URLs and DNS answers checked as Chrome issues them, at the browser-wide DevTools interception; requests failing those checks are blocked before they connect; a request still undecided when the render ends is refused rather than released to Chrome, and the page's scripts are stopped before it is torn down so unload handlers cannot issue requests that would bypass interception. Chrome's own component requests are refused without being counted. Channels that interception does not see are removed instead: `WebSocket`, `RTCPeerConnection` and `WebTransport` from every page and dedicated worker, `SharedWorker` and `navigator.serviceWorker` from every page, and WebRTC's unproxied UDP by Chrome flag. A subrequest whose origin redirects to a non-public host is refused at the redirected hop. Downloads are denied, so a rendered page cannot save files. Browser admission checks DNS answers but does not pin Chrome's own resolution: a hostname can pass the public-address check and later resolve to a private address when Chrome connects. Dev therefore does not guarantee protection against browser DNS rebinding; Chrome's own protections may block the request, but dev has not verified that guarantee. A `<link rel=preconnect>` to a private address also opens a TCP handshake that carries no data. These are accepted protection limits, not authorization to access private destinations. A page that posts a body of tens of megabytes stalls its own render until the timeout: that read fails, nothing leaves, and the next read relaunches if needed. The `WebTransport` removal is not proven on an https page. Chrome runs with background networking, sync, extensions and component updates disabled and connects directly, ignoring system proxy settings. Fetched content is untrusted text.

### The shared browser

Static retrieval, extraction and document snapshots stay inside each reader. Only rendering crosses a process boundary. The first read that needs Chrome starts one **browser owner** process for the data home, which owns the profile copy, Chrome, its private DevTools pipe, browser-wide request interception, and the mapping from each reader and render to the pages, frames and workers it owns. Leads start the owner directly; a child asks its lead's controller to start it, so the helper never becomes part of the child's attempt.

The owner is a separate dev runtime, not a background service: it holds its own installation claim, runs in its own process group, and outlives the session that started it. Readers connect over a private socket in a short-lived temporary directory, recorded in `<data-home>/browser/owner.json`; a kernel lock, not that record, decides whether an owner is live. Messages carry a URL and a deadline, never a profile path, a Chrome binary or a DevTools command, and every frame is schema-decoded under a 16 KiB limit.

Each render owns its own page tree. Requests are attributed to the render that issued them before they are admitted, and a request that cannot be attributed is refused rather than released. Cancelling a read, or ending a session, closes only that reader's pages; interception is never disabled and no peer's page is touched. A failure of Chrome or of the owner itself can fail every in-flight render at once, and that is reported as such.

Chrome closes after three idle minutes even while readers stay connected, and relaunches on the next render. When the last reader disconnects, the owner settles Chrome, releases the copy, removes its record and exits. If the owner process dies, outstanding renders fail without replay through a replacement owner. A leftover owner record blocks automatic replacement and profile reuse even when kernel locks are free; an owner that exits without verified Chrome shutdown also keeps its record. Existing healthy readers still share the same Chrome concurrently. See [revocation and recovery](#revocation) before reusing an uncertain copy.

### Documents and continuation

Each read keeps one immutable snapshot in the memory of the current session (at most 64 documents or 24 MiB). A continuation returns the next part of that same snapshot: nothing is fetched again and different bytes are never substituted. An evicted, foreign or expired token, or a token from an earlier session, is refused explicitly; read the URL again. Snapshots are not persisted; the browser profile copy is.

### Browser profile

Rendering uses the installed Google Chrome from `/Applications` or `~/Applications` with a dev-owned copy of your active Chrome profile, selected from Chrome's `Local State`. Dev never opens your live profile or tabs and never closes your Chrome. Before each fresh launch dev refreshes the copy from the source: a coherent SQLite snapshot of the cookie database, `Preferences`, `Secure Preferences`, `Network/TransportSecurity` (HSTS state), `Local Storage` and `IndexedDB`; passwords and other data are not copied. The source is only read. Cookies stay decryptable because the same Chrome binary and macOS Keychain entry serve the copy; a mock keychain would silently drop every login. Chrome is started with the account's home directory from the user database rather than the inherited `HOME`, because macOS finds the login keychain through it and Chrome never loads a page without it.

The copy is retained across sessions and refreshed only while no browser is live on it: a kernel lock held by the browser owner guards it, so nothing overwrites a copy in use. A cookie database that Chrome holds exclusively fails the snapshot with an actionable message; an interrupted refresh is recorded as incomplete and never launched. Ending a session or quitting dev stops that session's reads and disconnects it from the shared browser; Chrome itself closes when it has been idle for three minutes or when the last reader has gone. The profile-copy lock is released only after the browser and its observed helper processes are verified gone. If observation fails, the owner keeps the lock and the shutdown information in memory, reports the unverified state through `dev browser`, and retries settlement on a later render or lifecycle operation; a successful check releases the old lock before the copy can be reused. There is no background polling or state written to disk. When the owner process exits or crashes, the operating system releases the lock even if browser settlement was still unverified.

Authenticated pages read this way enter normal Pi conversation history like any other tool result, in the lead and in every child that reads them. Cookies and site storage are shared by every reader of a data home; owning separate pages isolates results and cleanup, not account state.

### Revocation

`dev browser revoke` writes a disable marker first, so no further render uses the copy and the live owner refuses new rendering immediately. It then waits up to ten seconds for reads already running to finish on their own, without cancelling them, closes Chrome and deletes only dev's copy while still holding its lock, reporting what it removed. If the wait expires, or Chrome's shutdown could not be verified, the command says the copy was kept and rendering stays disabled; rerun revoke once the reads finish. If the owner is gone but its record remains, revoke disables rendering and reports `kept-live` without deleting the copy. Your Chrome profile is never touched. While disabled, automatic escalation reports the disabled state. `dev browser enable` removes the disable marker in order with live-owner revocation, but does not clear an uncertain owner record or authorize profile reuse.

Administrative socket waits are bounded: status and enable allow ten seconds; revoke allows its drain budget, capped at ten seconds, plus two seconds for the response. An unresponsive owner produces an explicit unverified-outcome error, not a claim that rendering was disabled or the copy deleted. The owner may still be finishing a request it received; inspect status before retrying.

For recovery after owner death, first stop the old owner and any remaining dev-owned Chrome processes using this data home's copy, and verify they are gone. Only then remove `<data-home>/browser/owner.json` and retry revoke or rendering (enable first if disabled). Do not remove `owner.sqlite` or `profile.sqlite`: removing a lock database while another process holds it can split ownership. A missing record and free locks alone never prove that Chrome stopped; dev does not adopt or automatically settle orphan processes.

## State

| Location                              | Content                                                                     |
| ------------------------------------- | --------------------------------------------------------------------------- |
| `<data-home>/browser/user-data/`      | Dev's copy of the active Chrome profile, used as Chrome's user data dir     |
| `<data-home>/browser/copy-state.json` | Source, profile directory, refresh time and whether the last copy completed |
| `<data-home>/browser/profile.sqlite`  | Lock database held while a browser is live or the copy is being refreshed   |
| `<data-home>/browser/disabled`        | Revocation marker                                                           |
| `<data-home>/browser/owner.sqlite`    | Lock database admitting exactly one browser owner for this data home        |
| `<data-home>/browser/owner.json`      | Socket, incarnation and process of the published browser owner              |

Document snapshots live only in session memory. The copy holds authentication data with restrictive permissions; it is as sensitive as your Chrome profile ([SECURITY](../SECURITY.md#browser-profile-copy)).
