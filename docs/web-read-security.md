# Read URL security

Part of the [security model](../SECURITY.md). [Read URL](web-read.md) covers use and recovery.

## Browser profile copy

`read_url` deliberately gives the lead and every child your logged-in Chrome sessions. Authenticated visits can have site-side effects; separate pages isolate results and cleanup, not cookies or site storage. The copy protects your running Chrome, not your anonymity.

- Dev reads the active profile selected by Chrome's `Local State`. It copies a SQLite snapshot of cookies, preferences, HSTS state and web storage, not passwords or other databases. It never opens the live profile in a browser, accesses its tabs or lock files, or closes your Chrome.
- The installed Chrome and the account's macOS Keychain decrypt the copy's cookies. Chrome receives the account home from the user database rather than an inherited `HOME`, because macOS locates the login keychain there.
- The retained copy has restrictive permissions. A live owner's profile lock prevents refresh or deletion until Chrome and its observed helpers are verified gone. Owner death releases that lock even if helpers survive; the retained owner record blocks reuse but is not proof of liveness or automatic orphan recovery. Follow [browser recovery](web-read.md#recovery-after-owner-death).
- Cookie values stay out of results, logs and diagnostics. The owner exposes operational counts and errors, not another reader's document text. Rendered text is an ordinary tool result retained in the reading lead's or child's session history.
- Revocation affects only this data home's rendering and copy, never your source Chrome profile or another application's copy. [Read URL](web-read.md#revocation) owns the procedure and uncertain-outcome handling.

### Network policy

Only public http(s) destinations are admitted. Credential-bearing URLs, non-public host names and private or reserved addresses are refused. Static retrieval validates every DNS answer, rejects the entire answer if any address is disallowed, pins the connection to a validated address and checks each redirect again.

Browser requests from pages, frames, dedicated workers and nested workers pass URL and DNS checks at browser-wide DevTools interception, including redirected hops. Unattributed or undecided requests are refused; page scripts stop before teardown to prevent unload-time requests bypassing interception. Channels outside that interception are disabled: `WebSocket`, `RTCPeerConnection` and `WebTransport` in pages and dedicated workers, `SharedWorker` and `navigator.serviceWorker` in pages, and unproxied WebRTC UDP. Downloads are denied. Chrome runs with sync, extensions, component updates and background networking disabled and ignores system proxy settings.

Browser enforcement has accepted limits:

- Chrome resolves hostnames independently after admission. DNS rebinding may therefore reach private services if Chrome's own protections permit it; dev makes no containment guarantee. Static retrieval does not share this gap.
- A private-address `preconnect` can open a data-less TCP handshake. Profile or background traffic outside interception is outside dev's enforcement.
- Removing `WebTransport` has not been verified on an HTTPS page. The [reader review](https://github.com/taekwondodev/dev/pull/143) records the evidence and accepted verification limit.

These limits do not authorize private-network access. Treat fetched content as untrusted text, including pages read through your account.
