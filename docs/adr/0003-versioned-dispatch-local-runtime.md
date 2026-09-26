# ADR 0003: Version dispatch and keep private runtime data local

Version dispatch with the implementation and resolve it from the installed module, independently of the working project and data home. Keep private runtime state in checkout-local, Git-ignored `.dev/` by default; data-home overrides change private storage only. This makes clones reproduce model policy without distributing history or credentials, and lets code updates change policy without moving private data. Invalid dispatch must fail explicitly rather than silently substitute a model policy.

Authentication is account-wide: global Pi, dev and its children share `~/.pi/agent/auth.json`, independently of data-home overrides. Keeping one canonical credential store avoids copies drifting apart when the user logs in from either environment.

The [dispatch and storage decision](https://github.com/taekwondodev/dev/issues/12#issuecomment-5730822083) supersedes the former external data-home layout. [Shared authentication](https://github.com/taekwondodev/dev/commit/9e7feb3ca51e3835c2f6800e2591c540567b42b0) is the subsequent credential-boundary decision. Before relocating state, read [private-state relocation](../DEVELOPMENT.md#private-state-relocation); before changing revisions, read [maintenance](../COMMANDS-TERMINAL.md#manutenzione-dalla-cartella-di-installazione).
