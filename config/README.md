# Models and effort for delegated work

`profiles/crew-dispatch.json` sets the model and reasoning effort for delegated agents. Use `/work dispatch` to see the settings in use; documentation keeps no second list.

## Where to edit

Write your own settings in `profiles/crew-dispatch.json` in the dev installation. Git ignores `profiles/`, so the file survives updates; editing dev's default instead changes the checkout, which [update refuses](../docs/launcher.md#maintenance). While your file is absent, dev reads `default-crew-dispatch.json` here, which names no model. Your file replaces the default as a whole; nothing is merged.

`DEV_PROFILES` moves the personal file together with the profiles directory. `dev --help` prints both paths and `dev --diagnostics` prints the one in use.

Configuration is not read from the working project or data home. Changes apply to subsequent delegations.

## Resolution

The delegation's `skill` field selects that skill's entry in `rules`, if configured, otherwise `default`. The skill still loads when it has no entry, and a delegation without a skill uses `default`. An explicit `model` or `effort` overrides the selection. The [work protocol](../docs/work.md#use) limits those overrides to user-requested model/effort choices.

```json
{
  "rules": { "code-review": { "harness": "pi", "model": "provider/model-id", "effort": "high" } },
  "default": { "harness": "pi", "model": "provider/model-id", "effort": "medium" }
}
```

Set `harness` to `pi`. Set `model` as `provider/model-id` and specify `effort` as needed. Otherwise the agent uses its own Pi defaults, not this conversation's settings.

A runner other than Pi, invalid effort or an unknown model cause an error. An invalid personal file or a personal symbolic link to a missing file is an error too; dev does not fall back to the default. Dev never substitutes a different model to make a bad selection run.

## Default profile

`default-profiles.json` and `default-SOUL.md` are dev's default profile. The [launcher guide](../docs/launcher.md#profiles-and-resources) explains when dev uses it and how to replace it.
