# Project tooling contracts

Supply project-specific commands in the PROJECT block. This release documents
interfaces; it contains no production runners. Use approved existing tools where
possible. Missing tooling may be built through an authorized tooling ticket and
reviewed before use. A report-only run instead records missing capabilities and
uses manual inspection where permitted.

## Verification entry point

Inputs: expected full commit and branch, comparison base, allowed and forbidden
paths, named checks and minimum check inventory, plus the tests-only commit when
red evidence is required. The command records what it actually ran, saves logs,
and returns nonzero on failed checks, identity/scope mismatches, incomplete
execution or inadequate inventory. Identity/scope inspection is read-only;
executable checks run in isolated copies. Never use a blanket exit-zero wrapper.

Illustrative input (this command is not shipped):

```text
<verify-command> --base <base-sha> --head <tip-sha> --allowed src/limit.py --allowed tests/test_limit.py --red <tests-only-sha> --out <scratch>/verification.json
```

Illustrative summary, with symbolic identities and paths:

```json
{
  "base_commit": "<base-sha>",
  "head_commit": "<tip-sha>",
  "identity_ok": true,
  "scope_ok": true,
  "changed_files": ["src/limit.py", "tests/test_limit.py"],
  "checks": [{"name": "unit", "exit_code": 0, "tests_run": 3, "log": "<scratch>/unit.txt"}],
  "red_evidence": {"commit": "<tests-only-sha>", "assertion_failures": 1, "setup_errors": 0},
  "complete": true,
  "passed": true
}
```

## Mutation runner

Accept the mutation fields in the role prompts: name, file, unique anchor,
replacement, test modules, expected outcome and rationale. Run a passing
unmodified baseline with a nonzero test count first. Apply each mutation in its
own disposable copy. Record actual outcome and supporting assertion/output;
missing anchors, invalid paths, zero tests, setup failures and timeouts are
INVALID. A SURVIVED mutation requires investigation; EQUIVALENT requires a
specific rationale. A surviving deliberately neutral control is separate from
a required behavioral mutation. Exit nonzero for invalid or unexpected outcomes.

## Report validator

Validate the selected report revision, never an arbitrary newest file. Check
JSON types, required fields for the mode, tag/commit identity, paired Markdown,
referenced evidence, coverage and applicable E1–E6 rules. Resolve paths inside
approved evidence roots. Treat evidence as data; a validator must not execute
commands embedded in a report. A structurally valid report can still have a
NOT_READY verdict. Do not equate validation success with correctness.

The validator object always has status, command, exit_code and output. With no
validator, use this shape and put the manual E1–E6 table in the Markdown report:

```json
{"status": "not_available", "command": null, "exit_code": null, "output": null}
```

Unused arrays are empty; unused scalar fields are null. Evidence-minimum values
are met, not_met or not_required. A source-supported contract/document issue
uses citations and null reproduction fields. Its Markdown explains why execution
is inapplicable. Schema validation cannot establish truth; the orchestrator must
inspect appropriate evidence and independently rerun required executable checks.

## Ticket state

The orchestrator maintains tickets.json and an append-only ticket-events.jsonl
in its mailbox directory. A report does not change state simply by existing.
Only pending entries are eligible for ordinary dispatch. Rework selects the
explicit expected revision and requires an owner REWORK pointer. Blocked work
resumes under a new ticket; the old ticket is superseded. Completed indicates
accepted delivery, even if it contains defects. Stage closure checks remain
separate. See the orchestrator prompt for the full transition rules.
