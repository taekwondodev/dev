# Dispatch configuration

`crew-dispatch.json` is the authoritative model policy for delegated work. Inspect the current choices there or with `/work dispatch`; documentation does not maintain a second list of model assignments.

## Resolution

A prompt beginning with `/skill:name` selects that skill's entry in `rules`, if configured, otherwise `default`. The skill still loads when it has no dispatch rule. An explicit `rule` chooses a configured skill key or `"default"`; an explicit `model` or `effort` overrides that selection. The [work protocol](../docs/work.md#use) limits those overrides to user-requested model/effort choices.

Each selection specifies the `pi` harness and may specify `model` as `provider/model-id` and `effort`. Omitted values use the child's Pi defaults, not the lead's picker.

Missing/unreadable configuration, unknown rules, unsupported harnesses, invalid effort and unresolvable models fail explicitly. Dev never substitutes a different model to make a bad selection run.

## Where to edit

Edit `config/crew-dispatch.json` in the dev installation. Configuration is not read from the working project or data home. Changes apply to subsequent delegations.
