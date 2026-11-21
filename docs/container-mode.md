# Container mode

## Container mode for reviewer tickets

Container mode is opt-in, for reviewer tickets only. Set `Reviewer dispatch: container`
in the PROJECT block and the orchestrator prepares one launch command per reviewer
ticket; you decide the budget, image and model and run the command yourself. The
orchestrator never runs it, and nothing launches by itself. Manual dispatch is
unchanged and remains the default. The command and its record are described under
[Container launcher](#container-launcher); diagrams are in
[architecture](architecture.md).

What the launcher sets up:

- Inputs: a copy of this run's mailbox and of each export, taken and verified at
  launch and mounted read-only at the original paths. Later changes on the host are
  not visible to the reviewer. The launcher accepts only the run's own mailbox, not a
  directory that holds other mailboxes. It refuses a path that is or contains a home
  directory or passes through a credential directory, and any tree that holds a
  `.git` entry, a credential directory, a socket, a pipe or a device. A mailbox or an
  export may sit below the home directory.
- Outputs: read-write only the ticket's scratch folder, which must not exist yet, and
  its two report files, plus in-memory work space. No repository, home directory,
  credential store or runtime socket is mounted.
- Network: the reviewer's container has no network of its own. Only loopback may be
  up or hold an address or route visible to the checks; other devices must be down
  with no route. An IPv4 address on a down device is not observable and is covered by
  the down check. Its only way out is a local socket to a second container, which
  forwards model requests to the model endpoint over verified TLS and nothing else.
  Only the endpoint's name resolves, to that local path.
- Credentials: the model API key is the only secret the launcher supplies. It exists
  only in the second container's environment; the reviewer's container holds no
  secret that the launcher put there; the owner keeps the image free of credentials.
- Limits: for a container-dispatched ticket the limits are the launcher's budgets:
  time, forwarded model requests, tokens and scratch bytes. A ticket that states
  another limit (for example tool calls) is not enforced by the launcher. The second
  container counts every model request and refuses requests beyond the call limit; no
  request beyond the limit reaches the endpoint. The token limit uses the usage the
  provider reports, counting cached input and reasoning tokens, and can be exceeded by
  the requests already in flight when it is reached. The launcher stops the session at
  the wall-clock limit and records why it ended.
- Integrity: it hashes the ticket and each export manifest, checks each export
  against its manifest, including modes, and refuses to start on a mismatch.
- Container-mode flag: the reviewer's container has `ACODER_CONTAINER=1` and a
  read-only marker file `/acoder/run.json` with the run id, tag, ticket hash, limits,
  launcher version and skill hash.

Before the reviewer starts, in every run and on every platform, the launcher checks
the containers' settings from outside and from inside: only loopback may be up or
hold an address or route visible to the checks, with all other devices down and no
route on them, no answering name server, the expected mounts and environment, a
refusing and a working path through the second container, and no forwarding before
release. If a check fails the reviewer is not started. A host or VM clock step can
fail a check with `clock_skew`; the attempt then ends as not started and can be run
again. The run record lists each check and its result. Treat a run as isolated only
as far as its own record shows.

| Platform | Status |
|---|---|
| Docker Desktop on macOS | Covered by this project's container tests. Mailbox, export and staging paths must be in Docker Desktop's shared folders. The default staging directory is the system temporary directory; if it is not in a shared folder, pass `--staging-dir` with a directory that is. |
| Docker on Linux | Implemented; not covered by this project's tests. The per-run checks apply. |
| Podman on macOS and Linux | Implemented; not covered by this project's tests. The per-run checks apply. |
| Windows | Not supported. |

Limits to keep in mind:

- A client abort before final streamed usage while the run is still admitting
  requests ends even a healthy run as error / usage_unreported (including retries after
  time-outs, cancelled side requests and parallel cancellations). Aborts caused by the
  launcher's stop or a limit record a lower-bound token total and preserve that stop's
  reason (budget or interrupted). The sidecar does not parse request bodies and cannot add
  stream_options.include_usage; a chat client must request it for usage-only-at-end
  providers, or missing usage ends the run as error.
- The model endpoint remains an exfiltration channel; see
  [What stays true](#what-stays-true). The sidecar does not inspect request bodies.
  The token limit and call limit bound usage, but do not bound monetary cost or
  prevent the session from selecting a different model in a request. The sidecar
  records each response model string for owner comparison.
- The second container re-frames every answer it relays, so the agent sees chunked
  framing where the endpoint sent a content length. It cuts a stream that is idle for
  60 seconds, refuses request headers over 16 KiB, and closes at once any connection
  beyond 64 open ones. Before release, a request that declares a body over 32 MiB is
  answered `413 acoder_body_too_large` rather than `403 acoder_not_released`; nothing is
  forwarded or counted either way.
- Scratch is untrusted output and can contain Git hooks or configuration. Read the
  reports only; do not open scratch with Git, an IDE or a shell integration. The run
  record counts case-insensitive `.git` entries under scratch.
- Runtime-default seccomp is required, as the run record's checks show: no seccomp
  override or unconfined, and Seccomp: 2. AF_VSOCK denial is measured on Docker Desktop.
  The launcher cannot test this family per run; whether a tool in the owner's image
  can open it depends on the image. On Linux and
  Podman without that measurement it relies on the runtime default and is not
  checked per run (accepted limit). Other non-IP families remain unchecked.
  `--scratch-max-bytes` bounds persistent output by a poll every second, with a
  traversal allowed up to 10 seconds, not a quota: scratch can fill disk between
  polls, and a scan failure can override a disk stop with secret_scan_incomplete. CPU
  and memory have no separate bound.
- While the second container exists, the container runtime's own record of it holds
  its environment, including the key. The container is removed when the run ends.
- "The endpoint" is the host name whose certificate the second container verified,
  not a particular customer of a shared network edge.
- Code the reviewer runs can also send requests through the second container. They
  are counted and limited like the agent's own.
- A launcher that is killed writes no final record. The containers still end by
  themselves. `acoder review cleanup` finds the attempt's containers, volume and
  network by their `acoder.run` label, matched against the run id of the ticket's
  started file or, without one, of its not-started records. It removes those and the
  staging directory named by a started file. If the launcher was killed before it
  wrote either record, cleanup has no run id: it removes no labelled resource and
  still exits 0. The owner then lists the resources labelled `acoder.run` with the
  container runtime and removes those of that attempt, together with the staging,
  scratch and empty reports, by hand. Without a started file, cleanup prints the
  scratch and report paths it finds as owner actions. A started ticket is not
  launched again. Cleanup writes the crashed record whenever the runtime's listing
  succeeds, also when it removed nothing, so a second `review cleanup` of the same
  ticket is refused; if the listing fails or holds a line it cannot read, it removes
  nothing, writes no record and can be run again. Resources it could not remove are
  named on standard error for manual removal.

## Container launcher

`acoder review run` starts one reviewer ticket in a container. Run it from a checkout
with Node.js 22 or newer:

```text
node launcher/bin/acoder.mjs review run --ticket <ticket> --ticket-sha256 <hash> --mailbox <mailbox> --export tip=<export> --manifest tip=<manifest> --manifest-sha256 tip=<hash> --image <name>@sha256:<digest> --model-endpoint <https-url> --budget-minutes <n> --budget-calls <n> --budget-tokens <n>
```

Flags of `acoder review run`. Paths are absolute. An unknown flag, a repeated
single-value flag, a missing required flag or a malformed value is refused.

| Flag | Required | Meaning |
|---|---|---|
| `--ticket <file>` | yes | The ticket file, `<mailbox>/<stage>/ticket-<tag>.md`. |
| `--ticket-sha256 <hash>` | yes | Expected SHA-256 of the ticket file. |
| `--mailbox <dir>` | yes | The run's own mailbox. |
| `--export <role>=<dir>` | one or more, or `--no-export` | A review export; the role (`tip`, `base`, `context`, ...) matches `[a-z0-9-]+` and is unique. |
| `--manifest <role>=<file>` | one per export | The export's manifest; it lies inside the mailbox and outside every export. |
| `--manifest-sha256 <role>=<hash>` | one per export | Expected SHA-256 of that manifest file. |
| `--no-export` | instead of `--export` | States that the ticket has no export. |
| `--exclude <relative path>` | no, repeatable | Leaves a subtree of the mailbox out of the copy. |
| `--image <ref>` | yes | `<name>@sha256:<digest>` or `sha256:<digest>`; a tag is refused. |
| `--allow-image-env <NAME>` | no, repeatable | Accepts one environment variable the image defines outside the launcher's short list. |
| `--model-endpoint <https URL>` | yes, unless the configuration file has `endpoint` | Base URL of the model API: `https`, a DNS host name, no port other than 443, no user info, query or fragment. |
| `--provider <name>` | no | Provider profile; default from the configuration. A name of `[a-z0-9-]+` that must be a registered provider (today `openai`) and one the agent adapter lists. |
| `--model <id>` | no | Overrides the configured model; default from the configuration. `<id>` or `<provider>/<id>`, the id of `[A-Za-z0-9._:-]+`; a provider prefix must equal the selected provider. |
| `--effort <level>` | no | Overrides the configured effort; default from the configuration. Lower-case letters only. |
| `--agent <name>` | no | Agent adapter; default from the configuration. A name of `[a-z0-9-]+` that must be a registered adapter (today `opencode`). |
| `--budget-minutes <n>` | yes | Wall-clock limit in minutes. |
| `--budget-calls <n>` | yes | Limit on model requests the second container forwards. |
| `--budget-tokens <n>` | yes | Token limit. |
| `--max-in-flight <n>` | no | Model requests open at once, 1 to 16; default 4. |
| `--api-key-env <NAME>` | no | The host environment variable that holds the key; default `ACODER_MODEL_API_KEY`. No option takes a key. |
| `--config <file>` | no | Owner configuration file (JSON, outside the repository) with any of `agent`, `provider`, `model`, `effort`, `endpoint`, `max_in_flight`. |
| `--runtime <docker or podman>` | no | Default: `docker` if it is on the path, else `podman`. |
| `--extra-ca-cert <file>` | no | PEM certificates the second container trusts for the endpoint (private gateways). |
| `--scratch-size <size>` | no | Size of the in-memory work space; default `2g`. |
| `--scratch-max-bytes <n>` | no | Bound on persistent scratch, report and log bytes; default 4294967296. |
| `--reviewer-skill <dir>` | no | Reviewer skill folder to copy in; default `skills/acoder-reviewer` of the checkout. |
| `--staging-dir <dir>` | no | Existing directory for the per-run staging directory; default the system temporary directory. |
| `--snapshot-max-bytes <n>` | no | Bound on the copy of mailbox and exports; default 4294967296. |
| `--dry-run` | no | Runs the checks that need no container, prints the plan as JSON and leaves nothing behind. |

Agent, provider, model, effort and max-in-flight come from the flag, then the owner
configuration file, then `launcher/defaults.json`. The same value rules apply to these
keys in the owner configuration file. The endpoint comes from the flag or
the owner configuration file only.

Exit codes: 0 done, 3 stopped at a limit, 1 error or ended before the reviewer
started, 2 refused with nothing left behind. The last output line is
`ACODER LAUNCH <tag> <outcome> <record>`, where `<outcome>` is `refused`,
`not-started`, `done`, `budget` or `error`, `<record>` is the record written for this
attempt or `-`, and `<tag>` is `-` when the tag could not be established. A successful
`--dry-run` prints only the plan and exits 0.

`acoder export manifest --export <dir> --source-commit <sha> --out <file>` writes a
manifest for an existing export and prints the hash of the manifest file. The commit
is the caller's statement; the command runs no Git. A manifest is JSON:

```json
{
  "format": "acoder-export-manifest/2",
  "source_commit": "<sha>",
  "source_commit_provenance": "asserted",
  "root_mode": "0555",
  "entries": [
    {"path": "src/limit.py", "type": "file", "mode": "0444", "source_mode": "100644", "sha256": "<hash>"},
    {"path": "docs", "type": "dir", "mode": "0555", "source_mode": "040000"},
    {"path": "current", "type": "symlink", "target": "src/limit.py", "source_mode": "120000"}
  ]
}
```

`mode` is the mode the entry has in the export; `source_mode` is its Git mode. Files
are `0444` (`100644`) or `0555` (`100755`) and directories `0555`. The launcher
refuses to start when a manifest file's hash, or any path, type, mode, file hash or
symlink target, differs, or when a symlink leaves the export.

The launcher writes only into the ticket's stage folder, beside the report:
`scratch-<tag>/`, `report-<tag>.md` and `report-<tag>.json` (created empty for the
reviewer), and its records, outside the container. A started run has
`run-<tag>.started.json`, then the run record `run-<tag>.json` and `run-<tag>.log`.
An attempt that ended before the reviewer started has only
`run-<tag>.notstarted-<run_id>.json` and `run-<tag>.notstarted-<run_id>.log`, and the
ticket can be launched again.

Run record fields: `format`, `run_id`, `tag`, `launcher`, `agent`, `provider`,
`ticket`, `inputs`, `exports`, `image`, `runtime`, `mounts`, `mount_summary`,
`network`, `isolation_checks`, `egress_log`, `egress_log_truncated`, `egress_totals`,
`limits`, `usage`, `times`, `agent_started`, `exit_reason`, `budget_kind`,
`error_detail`, `conditions`, `agent_exit`, `reports`, `secret_scan`,
`scratch_symlinks_outside`, `cleanup` and `log_path`. `exit_reason` is `done` (the
agent ended by itself, its last model request succeeded and both report files are
present and well formed), `budget` (stopped at a limit) or `error`. `usage` holds the
second container's own request and token counts; the agent's counts are advisory.
The orchestrator compares the record with what it dispatched before it reads the
report.

`acoder review cleanup --mailbox <mailbox> --ticket <ticket>` is the recovery after a
killed launcher. It removes the runtime resources labelled with the run id of the
started file (or, without one, of the ticket's not-started records) and the staging
directory named by the started file, and writes `run-<tag>.crashed.json`. Without a
started file it names the scratch and report paths for the owner to inspect and
delete manually. Exit codes: 0 nothing left over, 1 leftovers or an error, 2 refused.

## Requirements

- A container runtime: Docker or Podman, on the path. On Docker Desktop, the mailbox,
  the exports and the staging directory must be in its shared folders (see the
  platform table above). Windows is not supported.
- Node.js 22 or newer on the host, and a checkout of this repository.
- An image you supply and pin by digest (`<name>@sha256:<digest>` or an image id).
  It must contain a POSIX shell, Node.js 22 or newer, the agent program, a certificate
  bundle, `sha256sum`, `cp`, `chmod`, `patch` and `diff`, plus what the reviewed
  project needs to run its checks, and no credentials. Environment variables the image
  defines must be on the launcher's short list or be named with `--allow-image-env`.
- Nothing here builds, pulls or publishes an image. The repository includes a
  reference image definition, `launcher/image/Containerfile`, as a starting point.
  You build it yourself, for example:

  ```sh
  docker build --build-arg BASE_IMAGE=<name>@sha256:<digest> --build-arg AGENT_NPM_PACKAGE=<package> --build-arg AGENT_CLI_VERSION=<version> --tag <image name> --file launcher/image/Containerfile launcher/image
  docker image inspect --format '{{.Id}}' <image name>
  ```

  The printed id is a value for `--image`.
- The model endpoint, given with `--model-endpoint` or as `endpoint` in the owner
  configuration file, and the API key in a host environment variable
  (`ACODER_MODEL_API_KEY` unless `--api-key-env` names another one). The key must be at
  least 16 characters from `[A-Za-z0-9_-]`.

## What stays true

- The model endpoint remains an exfiltration channel. Anything in an export or the
  mailbox can reach the model provider, including servers the provider contacts on
  the session's behalf. The provider's handling of prompts and files is separate from
  any network restriction.
- The second container sees every prompt and answer in plaintext on the host. It
  stores none of it.
- Keep private data out of exports and mailboxes, as every acoder run requires.
