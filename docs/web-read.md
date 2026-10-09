# Read URL

## Purpose

`read_url` lets the lead read a public documentation page by URL and get its text back with sources, without a search service, another subscription or an extra model. Dev negotiates Markdown with the origin, otherwise extracts the HTML locally, and renders in the installed Chrome only when static content is unusable. Native Pi codemode is active in every lead session, so scripts can compose reads and filter them before the model sees the result.

## Use

Ask the lead to read a page; it calls `read_url`. In a codemode script, `tools.read_url({ url })` resolves to the structured result.

| Field          | Meaning                                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| `url`          | Absolute http(s) URL of the page to read.                                                                   |
| `continuation` | Token from an earlier incomplete result; returns the next part of the same snapshot without fetching again. |
| `maxChars`     | Characters of text per result (default 16000, 1000-120000).                                                 |

The result carries the requested and final URLs, the title when available, the retrieval method (`markdown`, `text`, `html` or `browser`), the HTTP status, the text, absolute links, suggestions, limitations and, when more text remains, a `continuation` token. `outcome` is `document` for a complete page, `partial` when text remains or the body was cut, and `failed` when nothing was read. Indexes such as `llms.txt` appear under suggestions; they are never substituted for the requested page.

From a terminal:

```bash
dev browser            # status of Chrome, the source profile and dev's copy
dev browser revoke     # disable authenticated rendering and delete dev's profile copy
dev browser enable     # allow authenticated rendering again
```

## Behavior

### Retrieval

The caller never chooses the transport: dev does. Static retrieval sends `Accept: text/markdown` first. A Markdown or plain-text answer is returned as is. HTML is extracted locally: the `main` or `article` element when it carries the content, otherwise a readability pass, otherwise the cleaned body; the result is Markdown-flavoured text with headings, code blocks, lists, tables and absolute links. Static content never launches a browser.

Chrome is launched when the static answer is unusable: the extracted text is thin on a page that depends on scripts, or the origin answered 401, 403, 429 or 503. The rendered DOM goes through the same extraction. A browser result always carries a limitation saying it was rendered with your authenticated profile copy, because the origin may have recorded the visit; isolation promises neither anonymity nor an effect-free read. When Chrome is missing, disabled or in use by another dev session, the static result is returned with that limitation.

Results are bounded: 8 MiB per response body or rendered HTML, 45 seconds per read, 5 redirects, 40 seconds of rendering, four static reads and one render at a time. A cut body is reported as `partial` with the limit named. Aborting the tool call cancels a static read, the wait for the browser or a render promptly; a Chrome launch already in progress completes first, and that browser then closes when idle.

### Network policy

Only public http(s) destinations are read. Dev refuses URLs with credentials, non-public host names (`localhost`, `.local`, `.internal`, `home.arpa`) and literal private or reserved addresses, resolves every host itself, refuses the whole answer when any address is private, reserved, link-local, CGNAT, multicast, IPv4-mapped, NAT64 or 6to4, and connects to the validated address only. Each redirect is validated again. Browser subrequests (fetch, scripts, images, beacons, event streams, prefetches, frames, dedicated workers and the workers they create) are validated by the same policy as Chrome issues them, at the browser-wide DevTools interception, and blocked before they connect; a request still undecided when the render ends is refused rather than released to Chrome, and the page's scripts are stopped before it is torn down so unload handlers cannot issue requests that would bypass interception. Chrome's own component requests are refused without being counted. Channels that interception does not see are removed instead: `WebSocket`, `RTCPeerConnection` and `WebTransport` from every page and dedicated worker, `SharedWorker` and `navigator.serviceWorker` from every page, and WebRTC's unproxied UDP by Chrome flag. A subrequest whose origin redirects to a non-public host is refused at the redirected hop. Downloads are denied, so a rendered page cannot save files. The browser's own DNS resolution is not pinned, and a `<link rel=preconnect>` to a private address opens a TCP handshake that carries no data; both are limitations, not permission. A page that posts a body of tens of megabytes stalls its own render until the timeout: that read fails, nothing leaves, and the next read relaunches if needed. The `WebTransport` removal is not proven on an https page. Chrome runs with background networking, sync, extensions and component updates disabled and connects directly, ignoring system proxy settings. Fetched content is untrusted text.

### Documents and continuation

Each read keeps one immutable snapshot in the memory of the current session (at most 64 documents or 24 MiB). A continuation returns the next part of that same snapshot: nothing is fetched again and different bytes are never substituted. An evicted, foreign or expired token, or a token from an earlier session, is refused explicitly; read the URL again. Snapshots are not persisted; the browser profile copy is.

### Browser profile

Rendering uses the installed Google Chrome from `/Applications` or `~/Applications` with a dev-owned copy of your active Chrome profile, selected from Chrome's `Local State`. Dev never opens your live profile or tabs and never closes your Chrome. Before each fresh launch dev refreshes the copy from the source: a coherent SQLite snapshot of the cookie database, `Preferences`, `Secure Preferences`, `Network/TransportSecurity` (HSTS state), `Local Storage` and `IndexedDB`; passwords and other data are not copied. The source is only read. Cookies stay decryptable because the same Chrome binary and macOS Keychain entry serve the copy; a mock keychain would silently drop every login. Chrome is started with the account's home directory from the user database rather than the inherited `HOME`, because macOS finds the login keychain through it and Chrome never loads a page without it.

The copy is retained across sessions and refreshed only while no browser is live on it: a kernel lock guards it, so a second dev session that needs the browser reports the copy as in use instead of overwriting it. A cookie database that Chrome holds exclusively fails the snapshot with an actionable message; an interrupted refresh is recorded as incomplete and never launched. Chrome is closed after three idle minutes, when the session ends and when dev quits; a read still in progress, whether fetching or rendering, is stopped first and fails as cancelled. Dev observes the browser and its helper processes gone before releasing its runtime claims. The reload and quit paths are proven through the Pi host; the interrupt-signal path shares that shutdown handler and is verified by reading only.

Authenticated pages read this way enter normal Pi conversation history like any other tool result.

### Revocation

`dev browser revoke` writes a disable marker first, so no further launch uses the copy, then waits up to ten seconds for a live browser to settle and deletes only dev's copy, reporting what it removed. If a dev session still has Chrome open after that wait, the command says the copy was kept and asks you to rerun it once that session closes its browser; the marker stays in force meanwhile. Your Chrome profile is never touched. While disabled, automatic escalation reports the disabled state. `dev browser enable` removes the marker; the next launch copies the profile again.

## State

| Location                              | Content                                                                     |
| ------------------------------------- | --------------------------------------------------------------------------- |
| `<data-home>/browser/user-data/`      | Dev's copy of the active Chrome profile, used as Chrome's user data dir     |
| `<data-home>/browser/copy-state.json` | Source, profile directory, refresh time and whether the last copy completed |
| `<data-home>/browser/profile.sqlite`  | Lock database held while a browser is live or the copy is being refreshed   |
| `<data-home>/browser/disabled`        | Revocation marker                                                           |

Document snapshots live only in session memory. The copy holds authentication data with restrictive permissions; it is as sensitive as your Chrome profile ([SECURITY](../SECURITY.md#browser-profile-copy)).
