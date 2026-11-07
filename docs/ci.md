# Repository checks

CI runs on pushes and pull requests, and can be started manually. The
`Repository checks` job is suitable as a required branch protection check;
enabling that protection is a repository administration step.

To run the same checks locally, install Node.js 22 or newer and Go 1.23 or newer,
then run from the repository root:

```sh
npm ci --ignore-scripts
npm run check
```

The first installation needs registry access. The workflow linter uses
`go run` with actionlint pinned to v1.7.7 in `tools/go.mod` and checksums in
`tools/go.sum`; its first run downloads the module and dependencies. The separate
Go module lets cached checks run without version lookups. Ubuntu's GitHub-hosted
runner supplies Go. npm dependencies
are pinned in `package-lock.json`. Installation does not run dependency scripts.

Individual checks are available as `npm run lint:markdown`, `npm run validate`,
`npm test`, and `npm run lint:workflows`.

## What is checked

- Markdown structure, with long lines allowed and duplicate headings allowed in
  different sections. Table column spacing is not enforced. Scoped exceptions
  preserve the protocols' compact lists, plain-text headers and placeholder paths;
  ordinary documentation retains the stricter defaults.
- Relative Markdown links, images and heading anchors, including reference-style
  links. External URLs are skipped so network outages cannot fail a PR. Fenced
  examples are not interpreted as links. Raw HTML links and custom HTML anchors
  are outside this check's scope.
- All three skill names and descriptions, YAML metadata, disabled implicit
  invocation, and required role files. Each skill is copied to an independent
  temporary directory and its links are checked there to catch dependencies on
  files that would not be installed with it.
- Synthetic JSON/JSONL parsing, report field types and identities, Markdown
  report pairs, ticket roles, selected report revisions and legal event
  transitions. Replaying the event log must reproduce the final ledger state
  and revision. The walkthrough's rejected original report must retain its E4
  failure, and its corrected revision must supply commands and runtime details.
- Regression tests that deliberately break links, packages, metadata, reports
  and ticket history to verify that the checks reject them.
- GitHub Actions workflow syntax and expressions through actionlint.

The example checker is specific to the shipped S1 walkthrough. It never executes
commands from reports or resolves hypothetical mailbox/scratch evidence. It is
not the production report validator described in [tooling contracts](tooling.md),
and passing CI does not establish that evidence is true or prompts behave as
intended. Agent behavior evaluations and semantic protocol review remain separate.

## Pre-push checks

Install [Gitleaks](https://github.com/gitleaks/gitleaks) 8.30.1 or newer alongside
Node.js, Go and Git. After running the CI commands above once to populate the
dependency caches, enable the version-controlled hook for this clone:

```sh
npm run hooks:install
```

The installer sets the local `core.hooksPath` to `.githooks` and makes the hook
executable. It refuses to replace another configured hooks directory or an
existing default pre-push hook; integrate those manually. Installation is explicit
and is not part of `npm ci`. To remove this installation, run
`git config --local --unset core.hooksPath`.

On a push, the hook reads Git's ref-update input and checks the commits actually
being sent, including updates to branches other than the checked-out branch:

- Existing refs use the advertised remote commit as the comparison base. A
  missing base stops the hook with a request to fetch. Force updates and annotated
  tags pointing to commits are supported; deleting refs needs no checks.
- New refs exclude history recorded in that remote's local tracking refs. Keep
  those refs current with `git fetch --prune`. When pushing to an unnamed URL or
  a remote without tracking refs, all reachable history is checked.
- Each outgoing commit is checked for whitespace errors and conflict markers,
  so committing a problem and removing it later does not hide it.
- Gitleaks scans outgoing history with its default rules and redacted output.
  The hook ignores repository allow comments, ignore files and scanner configs.
  Scanner failure blocks the push; private matched contents are not printed.
- Every outgoing tree and final tip is checked for mailbox/scratch/checkouts,
  credential directories, environment files other than `.env.example`, filled
  project-config files, run artifacts outside `examples/`, recognizable home
  directory paths and absolute paths in PROJECT fields. Synthetic examples are
  scanned too; placeholders are allowed. Symlinks and submodules require manual
  review and block this check.
- Each distinct pushed tip is exported to a temporary directory, gets a fresh
  offline `npm ci --ignore-scripts`, and runs `npm run check`. The working tree
  and index are untouched. A committed CI setup is required; uncommitted fixes
  cannot make an outgoing commit pass. Temporary files are removed afterward.

Dependency installation uses npm's cache and Go proxy access is disabled during
the hook. If a dependency is missing, run the normal CI commands with network
access in a checkout of the intended commit, then retry. No packages are fetched
automatically during a push. The hook requires POSIX `sh` and `tar`, matching the
project's existing command examples.

Run `npm test` to exercise ref selection, temporary commit checks, privacy
rules, historical defects and hook installation. The Gitleaks integration test
runs when Gitleaks is on PATH and otherwise skips; the remaining tests require
no scanner. Pattern-based checks cannot identify every private document or secret,
so review outgoing changes before publishing. Local hooks can be bypassed; CI
remains the required repository check.
