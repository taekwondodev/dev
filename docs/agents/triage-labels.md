# Issue Labels

The workflow speaks in terms of canonical category, state, and workflow-marker roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

### Category labels

`bug` and `enhancement` are fixed category labels in this workflow. They are not part of the configurable triage-state mapping.

### Issue state labels

| Canonical role    | Label in this tracker |
| ------------------ | ---------------------- |
| `needs-grilling`  | `needs-grilling`        |
| `ready-for-agent` | `ready-for-agent`       |

`needs-grilling` is the initial state for a quick issue that is intentionally waiting for a future grilling session. `ready-for-agent` replaces it when the complete spec is ready.

When a skill mentions a role or marker, use the corresponding label string from this table. Edit the right-hand column if this repo's tracker already uses different names. Don't create duplicate labels for the same role.
