# ADR 0003: Version dispatch and keep private runtime data local

Status: accepted by the user's follow-up to issue #12.

## Decision

Keep `config/crew-dispatch.json` in the dev checkout and version it with the
implementation. Resolve it relative to the installed module, never relative to
the edited project or the runtime data home. A missing or invalid dispatch file
must not silently replace the configured model policy.

Keep dev-local settings, preferences, sessions, logs, caches and work
reservations inside checkout-local `.dev/`, with `/.dev/` excluded by
`.gitignore`. Pi authentication is account-wide, so both global Pi and dev use
the canonical `~/.pi/agent/auth.json`; it is not copied into `.dev/` or changed
by `DEV_DATA_HOME` and `--data-home`. Those options remain explicit overrides
for dev-private storage only. Children receive the resolved data home from the
lead but use the same global Pi auth path. Shared workflow rules remain in
their existing library.

## Consequences

- Clones reproduce model routing but do not receive credentials or history.
- Switching between global Pi and dev no longer requires separate auth files;
  `/login` updates the shared canonical file.
- Updating or rolling back code can change dispatch policy, not private data.
- Maintenance conservatively requires the explicit `/.dev/` ignore rule, no
  negation rules and no tracked `.dev/` contents in the target revision when
  local `.dev/` exists. Crossing the previous layout requires explicit
  private-data relocation first.
- Ignoring a directory is not an access-control boundary. Never force-add it;
  arbitrary explicit data-home overrides need their own storage protection.
- Migration requires stopped runtimes, a metadata inventory and preservation
  of file permissions. Move only dev-owned state; do not read credential
  contents, rewrite conversations or migrate other profiles.
- Operational pointers into the moved data home need relocation. Historical
  conversation text remains unchanged, including any old paths it mentions.

This supersedes the earlier placement of dispatch and private state together
outside the checkout. It does not change ADR 0001's shared-workflow ownership
or ADR 0002's process ownership and cancellation model.
