# Accepted limits

Known consequences the owner has accepted.

## L-1: a provider-prefixed id keeps its prefix (rule R-A, D-2)

On the unreleased branch before v0.2.1, `--model openai/gpt-x` with `--provider openai` was stripped to `gpt-x`. Under rule R-A it is the id `openai/gpt-x` and is sent as given, so against api.openai.com it fails upstream ("model not found"). Write `gpt-x` instead. The prefix form was never released (tag v0.1.0 holds no launcher).

## L-2: a model id has at most 128 characters

Longer ids are refused by `--model`, the owner configuration file, `launcher/defaults.json` and the opencode adapter.
