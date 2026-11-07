TICKET demo-S1-R-CODE-r3
To: REVIEWER      Mode: CODE
Stage / round: S1 / 1    Tier: LOW    Run type: DIRECTED
Spec and contract IDs: LIMIT-1; approved brief revision 1, statements 1–3
Allowed files: src/limit.py, tests/test_limit.py. Forbidden: all other repository files.
Limits: 20 minutes, 30 tool calls
Execution boundary: owner-provisioned sandbox; read-only inputs, owned scratch/output,
  no credentials or production data, network disabled; children share restrictions.
Replacing an earlier session: no
Review exports: <mailbox>/checkouts/S1-base at 1111111111111111111111111111111111111111;
  <mailbox>/checkouts/S1-tip at 3333333333333333333333333333333333333333; checked manifests beside each.
Expected changed files: src/limit.py, tests/test_limit.py.
Patch and commit list: <mailbox>/S1/change.patch and commits.txt.
Attack list: 1. Negative input raises ValueError. 2. Zero and positive inputs are
  unchanged. 3. The regression detects removal of the guard.
Verification: python3 -B -m unittest discover -s tests
Builder mutants: <mailbox>/S1/mutants-demo-S1-B-BUILD-r2.json; rerun with <mutation-command>.
Evidence sizes: corpus cases 0; own mutants 0. Report validator: none.
Known accepted deviations: none.
Report path: <mailbox>/S1/report-demo-S1-R-CODE-r3.md and .json
Scratch path: <mailbox>/S1/scratch-demo-S1-R-CODE-r3

Synthetic ticket: identities and commands are illustrative, not operational.
