# Presentation prototypes

Throwaway design evidence for the wayfinder map on subagent visibility. Not code to merge.

- `status-zone.html`: the chosen layout of the zone below the editor, with the subagent list and the two-row HUD grid separated by blank rows. Open it in a browser on a Mac with JetBrainsMono Nerd Font installed; the 120/80 buttons show the narrow-terminal drop order. Data is demonstrative.
- `subagent-list.html`: the chosen subagent list below the editor (issue #279), above the HUD grid, with scenarios for one child, a mixed batch, a coordinator with leaves, nine children and an exhausted subscription.
- `work-rows.html`: the chosen `work` rows in the transcript with Calm off (issue #280), rendered by Pi's own components. `work-rows/` holds the generator: `gen.mjs` renders scenes with Pi 1.5 components and the rose-pine-moon theme from the child session files of 2026-11-07 (absolute paths of the owner's machine), and `work-render.mjs` holds the prototype renderers written against Pi's public renderer API.
