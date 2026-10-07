# ADR 0006: Keep the visual layer in global extensions, tuned to Ghostty

Presentation changes to Pi's interface, such as the footer, live in global extensions under `~/.pi/agent/extensions/`, not in dev and not in Pi's code. They apply to plain `pi` and to dev alike, and survive Pi upgrades without patches. They target the one terminal in use, Ghostty with JetBrainsMono Nerd Font Mono, and use its private-use glyphs without a fallback: the user chose a richer interface over portability, accepting placeholder boxes in any other terminal or font.

Dev publishes status text through Pi's status API and session-scoped child activity through Pi's event bus. The activity signal lets global title extensions react while the lead is idle, without parsing footer text or depending on a custom footer. Dev supplies execution facts, not title formatting, and does not depend on a subscriber. `dev/work` separates groups with `│` and items with `·`, and an extension wraps at those separators without interpreting the content; changing them breaks the wrapping, not the meaning.

Read this record before adding presentation to dev, making dev depend on a specific extension, changing the `dev/work` status separators, or supporting another terminal or font.
