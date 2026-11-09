# ADR 0006: Keep the visual layer in global extensions, tuned to Ghostty

Presentation changes to Pi's interface, such as the footer, live in global extensions under `~/.pi/agent/extensions/`, not in dev and not in Pi's code. They apply to plain `pi` and to dev alike, and survive Pi upgrades without patches. They target the one terminal in use, Ghostty with JetBrainsMono Nerd Font Mono, and use its private-use glyphs without a fallback: the user chose a richer interface over portability, accepting placeholder boxes in any other terminal or font.

Dev owns execution facts and batch membership; extensions own presentation and keep no independent child registry. Publish replaceable snapshots rather than formatted status text or partial change events, so subscribers need no state reconstruction. A late-subscriber recovery path is unnecessary because disk extensions load before dev's own and `/reload` closes work. [Work](../work.md#live-view) owns current event behavior and links to its declaration.

Extensions adapt to dev, never the reverse: when dev changes `content`, `details` or an event, the global extensions change with it and dev keeps no field for their sake. Presentation consumes structured facts rather than parsing model-facing text, so compact model results do not constrain the interface. A fact only the owner needs is a custom session entry, which Pi keeps out of model context and compaction; a display message filtered from each request would still reach compaction. The accepted cost: without an extension the entry is recorded but not drawn. Dev does not depend on a subscriber.

Read this record before adding presentation to dev, making dev depend on a specific extension, changing the `dev/work-view` contract, or supporting another terminal or font.
