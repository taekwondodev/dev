# Models and effort for delegated work

`crew-dispatch.json` sets the model and reasoning effort for delegated agents. Read it or use `/work dispatch` to see current settings.

## Resolution

The delegation's `skill` field selects that skill's entry in `rules`, if configured, otherwise `default`. The skill still loads when it has no entry, and a delegation without a skill uses `default`. An explicit `model` or `effort` overrides the selection. The [work protocol](../docs/work.md#use) limits those overrides to user-requested model/effort choices.

Set `harness` to `pi`. Set `model` as `provider/model-id` and specify `effort` as needed. Otherwise the agent uses its own Pi defaults, not this conversation’s settings.

Missing settings, a runner other than Pi, invalid effort or an unknown model cause an error. Dev never substitutes a different model to make a bad selection run.

## Where to edit

Edit `config/crew-dispatch.json` in the dev installation. Configuration is not read from the working project or data home. Changes apply to subsequent delegations.
