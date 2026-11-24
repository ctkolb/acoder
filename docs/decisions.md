# Decisions

Numbered, dated owner decisions. A later entry that replaces an earlier one says so.

## D-1 (2026-11-23): objective brief revision 1 for v0.2.1

Quoted from the confirmed PROJECT brief:

> Objective: Prepare release v0.2.1 (after tag v0.1.0) of acoder. v0.2.0 was planned for the code on
> this branch but is skipped and never tagged: the branch has not been release-tested, and v0.2.1
> is the first release of it. It ships the reviewer container launcher on this branch plus one fix: the launcher must accept model ids
> that contain a slash, such as the OpenRouter id "z-ai/glm-5.3", with --model, the owner
> configuration file and the opencode adapter. Today lib/args.mjs, lib/config.mjs and
> adapters/opencode.mjs read text before a slash as a provider name (which must equal the selected
> provider) or reject the slash, so an OpenRouter id cannot be used.
>
> Definition of done:
>
> 1. `--model z-ai/glm-5.3` with `--provider openai`, and `"model": "z-ai/glm-5.3"` in the --config
>    file, are accepted. The opencode adapter passes the full id to opencode, so the model argument
>    is `openai/z-ai/glm-5.3`, and the generated opencode configuration names the full id.
> 2. The rule for a leading "&lt;name&gt;/" is written down and tested, including the ambiguous case of
>    an id whose first segment equals the selected provider (OpenRouter has ids like "openai/..."):
>    the builder proposes the rule in the PREPARE plan and the owner approves it before it is built.
> 3. Ids stay constrained to a safe character set (no whitespace, control characters, quotes,
>    backslash, "..", leading or trailing slash, empty segment, "@" or other characters that could
>    alter argv or the generated JSON configuration). Tests cover each rejected form.
> 4. Unchanged: provider validation, the endpoint rules, and every isolation check. No change to
>    the sidecar's request handling or the container checks.
> 5. docs/container-mode.md (flag table for --model, config keys) and README are updated, and a
>    short release note for v0.2.1 is added where the repository keeps one, or in docs/ if none.
> 6. `npm run check` passes. `npm run check:container` passes on this Mac (Docker Desktop is
>    available), or the report states exactly which container test could not run and why.
> 7. A final hand-off lists the commit to tag, the files changed, and the owner steps (push,
>    merge, tag v0.2.1). Nothing is pushed or tagged by any role, and no v0.2.0 tag or release note is created.
>
> Scope and exclusions: model-id parsing and validation in the launcher, its tests and docs. Excluded:
> new providers or adapters, endpoint or TLS changes, sidecar or isolation logic, dependency
> upgrades, and unrelated cleanup.

## D-2 (2026-11-23): the rule for a leading `<name>/` in a model id (rule R-A)

The model id is opaque: it is the exact string sent to the provider. A `/` is part of the id. Nothing is stripped, and no segment is compared with a provider name. The adapter always emits `<provider>/<full id>`; with `--provider openai`, `z-ai/glm-5.3` becomes `-m openai/z-ai/glm-5.3`, and an OpenRouter id whose first segment equals the provider, `openai/gpt-x`, becomes `-m openai/openai/gpt-x`.

A model id is one or more `/`-separated segments of `[A-Za-z0-9._:-]` (pattern `^[A-Za-z0-9._:-]+(?:/[A-Za-z0-9._:-]+)*$`), with no `..` anywhere, no segment that is exactly `.`, and a length of 1 to 128 characters. The same rule applies to `--model`, the owner configuration file, `launcher/defaults.json` and the opencode adapter.

## D-3 (2026-11-24): a model id has at most 64 characters (amends D-2)

Owner decision after review r3 (finding R-02, "Accept recommendations"): the length limit of D-2 is lowered from 128 to 64 characters, the width at which the sidecar records the response model, so the exact comparison of the response model with the configured `agent.model` can always succeed. Everything else in D-2 is unchanged.
