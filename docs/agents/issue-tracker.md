# Issue tracker

Issues, specs and implementation tickets live in `taekwondodev/dev` on GitHub. Use the shared `github-cli` skill for client selection, supported commands and mutation readback.

## Issue identity and labels

Complete an existing capture by updating its body in place, preserving its number and comments. Use [triage-labels.md](triage-labels.md) for exact category, readiness and activity names; quick captures remain incomplete until a full spec exists.

Specs and implementation tickets are GitHub issues. A ticket names the affected [components](../ARCHITECTURE.md#components) and the behavior to build. Use the shared `to-spec`, `to-tickets` and `implement` procedures for their content and phase gates.

## Relationships

| Relationship              | GitHub representation              | Fallback when unavailable                                |
| ------------------------- | ---------------------------------- | -------------------------------------------------------- |
| Map to tickets            | Native sub-issues of one map issue | Task list in the map and `Part of #<map>` in each child  |
| Ticket blocked by another | Native issue dependencies          | `Blocked by: #<n>, #<n>` at the top of the blocked issue |
| Claimed work              | Assignee is the driving developer  | None                                                     |

Native dependency APIs take the blocker's numeric database `id`, not its issue number or `node_id`. `issue_dependencies_summary.blocked_by` counts open blockers. In the fallback representation, inspect the referenced issues' states instead.

For wayfinding, the map uses `wayfinder:map`; children use `wayfinder:research`, `wayfinder:grilling` or `wayfinder:task`. The frontier follows the map's order among unassigned children with no open blockers. The shared `wayfinder` skill owns claiming, resolving and recording decisions.
