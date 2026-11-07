TICKET demo-S1-B-BUILD-r2
To: BUILDER      Mode: BUILD
Stage / round: S1 / 1    Tier: LOW    Run type: DIRECTED
Spec and contract IDs: LIMIT-1; approved brief revision 1, statements 1–3
Allowed files: src/limit.py, tests/test_limit.py. Forbidden: all other repository files.
Limits: 20 minutes, 30 tool calls
Execution boundary: owner-provisioned sandbox; read-only inputs, owned scratch/output,
  no credentials or production data, network disabled; children share restrictions.
Replacing an earlier session: no
Repo path / expected branch / FULL expected HEAD / tree state:
  <repo> / fix/negative-limit / 1111111111111111111111111111111111111111 / clean
Plan-first: yes. Checkpoint: none.
Red evidence kind: FAILING
Verification: <verify-command> --base 1111111111111111111111111111111111111111 --head <built-sha> --red <tests-only-sha>
Report path: <mailbox>/S1/report-demo-S1-B-BUILD-r2.md and .json
Scratch path: <mailbox>/S1/scratch-demo-S1-B-BUILD-r2
Sheet path: <mailbox>/S1/sheet-demo-S1-B-BUILD-r2.md
Mutants path: <mailbox>/S1/mutants-demo-S1-B-BUILD-r2.json
Scope: add rejection of negative integers; preserve zero and positive values.
Expected evidence: regression fails on the original implementation and passes after
  the guard is added; guard-removal mutant killed by that same assertion.

Synthetic ticket: identities and commands are illustrative, not operational.
