# Release notes

Newest first.

## v0.2.1

The first release of the reviewer container launcher (v0.2.0 was planned for this code and is skipped; it is never tagged).

- Container mode for reviewer tickets: `acoder review run` starts the reviewer in a container whose only way out is a second container that holds the API key, forwards requests only to the model endpoint, and counts and limits them. See [container mode](container-mode.md).
- Model ids that contain a slash are accepted with `--model`, the owner configuration file and the opencode adapter, for example the OpenRouter id `z-ai/glm-5.3`. The id is opaque: it is sent to the provider as given, and opencode receives `-m <provider>/<full id>` (`openai/z-ai/glm-5.3`).
- A model id is one or more `/`-separated segments of `[A-Za-z0-9._:-]`, with no `..`, no `.` segment and at most 128 characters. Whitespace, control characters, quotes, backslash, `@` and other characters that could alter the agent's arguments or its generated configuration are refused.
- Changed from the unreleased branch: a leading `<provider>/` is no longer compared with `--provider` or removed. `openai/gpt-x` now means the id `openai/gpt-x`; write `gpt-x` for the OpenAI API. See [accepted limits](accepted-limits.md).
