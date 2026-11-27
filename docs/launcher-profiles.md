# Launcher profiles

Part of the [launcher guide](launcher.md).

## Profiles and resources

Profiles are personal configuration. The installation's `profiles/` directory holds a declarative manifest, `profiles/manifest.json`, beside the SOUL files and skill directories it names. Git ignores the directory. Dev knows the manifest format, not profile or skill names:

```json
{
  "default": "general",
  "profiles": {
    "general": { "soul": "general/SOUL.md" },
    "specialist": {
      "soul": "specialist/SOUL.md",
      "skills": ["specialist/skills"]
    }
  }
}
```

While `profiles/manifest.json` is absent, dev reads the installation's default manifest `config/default-profiles.json`, whose `general` profile uses `config/default-SOUL.md`, so a fresh clone starts without configuration. To customize, write `profiles/manifest.json` with your own SOUL files and skill directories beside it; dev then ignores the default. The default belongs to dev: editing it changes the checkout and blocks `npm run update`. `dev --help` prints both manifest paths and this guide's path. The same directory holds the optional personal model settings `crew-dispatch.json`, which replace dev's default the same way ([model settings](../config/README.md)).

- `default` names the profile of a new conversation when neither `--profile` nor a saved preference selects one. It must be one of `profiles`.
- Each profile names its `soul`, a Markdown file appended to Pi's system prompt, and optionally its ordered `skills`. Each entry is a skill directory or a directory of skills, which Pi searches for `SKILL.md`; name a profile's skill directory once instead of each skill in it. Paths are relative to the manifest's directory and may not use `..`; a symbolic link placed there is followed as the owner's choice, since everything under `profiles/` is trusted personal configuration ([SECURITY](../SECURITY.md#trusted-base)).
- For a new conversation, `--profile` wins over the repository preference, which wins over the configured default. `--resume` and `--continue` use the conversation's recorded profile; if none was recorded or it is unreadable, `--profile` is required. Session replacements inside a running dev, such as `/resume`, keep the launch's profile.
- Project `.pi/skills` and `.agents/skills` directories, from the launch directory to the Git root, come first; then the profile's skill directories in manifest order; then the shared skills at `~/.agents/skills`. Duplicate real paths are dropped. Native project-instruction discovery is unchanged: dev's own `AGENTS.md` loads only when dev is the working project.
- The manifest is read from the installation once per launch and once per child start, whatever the working project, managed worktree or data home. `DEV_PROFILES` selects another profiles directory, with the same default when it holds no manifest; dev's checks use it for disposable fixtures.

An unreadable or invalid manifest, a default that is not a defined profile, an unknown profile name, a missing or unreadable SOUL of the selected profile, or a Pi resource/extension error stops startup and names the file or resource; no other profile is substituted. A personal manifest that is a dangling symbolic link stops startup rather than falling back to the default. A skill directory that does not exist, of the profile or the shared `~/.agents/skills`, does not stop startup: it keeps its place in the resource order and Pi reports it as a warning. Resources of unselected profiles are neither checked nor loaded. Profiles share private state and sessions; they are guidance selection, not isolation.
