# Synthetic walkthrough: reject negative limits

Everything in this directory is invented: names, identities, results, timings,
commands and evidence. Repeated-digit SHAs are deliberately fictional. This is
an illustration of the protocol, not a runnable fixture or an executed review.
No private source code, reports or data are included. `<repo>`, `<mailbox>` and
`<scratch>` are placeholders; resolve them to approved absolute paths in a real run.

The imagined project is a small Python CLI with a `parse_limit` function. Its
approved contract is to accept nonnegative integers and reject negative integers
with ValueError. A one-stage plan is approved after a PREPARE ticket (r1); there
is no new consequential contract requiring separate SPEC review. The LOW stage
adds a missing negative-value guard. The builder and reviewer use different
model families selected by the owner. This walkthrough explicitly opts into an
owner-provisioned sandbox in its PROJECT rules; that is an optional run requirement,
not a prerequisite for every acoder run.

1. Save the filled PROJECT block below as a configuration file outside the
   target repository, then invoke each role skill as described in the main README.
   Confirm the brief and whole-run plan. The orchestrator records the approved
   scope and initializes the ticket ledger. Dependencies and the execution
   boundary are provisioned before execution.
2. Dispatch [the BUILD ticket](ticket-demo-S1-B-BUILD-r2.md) through an owner
   TICKET pointer. The builder writes a plan sheet, commits a negative-limit
   regression first, then the fix, and reports the hypothetical evidence in
   [its Markdown report](report-demo-S1-B-BUILD-r2.md) and JSON sibling.
3. The orchestrator validates the report, reruns verification and the builder
   mutation, then makes manifests and read-only exports of base and tip.
   The owner dispatches [the CODE ticket](ticket-demo-S1-R-CODE-r3.md).
4. The reviewer submits its original report. Its command list omits the test
   run, so the orchestrator's manual E4 check fails. The verdict is not accepted.
   The ledger enters rework at revision 1. The owner sends the pointer to the
   [rework note](rework-demo-S1-R-CODE-r3-w1.md).
5. The reviewer preserves the original and writes the corrected `-w1` pair.
   The owner says `REPORT demo-S1-R-CODE-r3 revision 1 ready`. The orchestrator
   reads exactly that pair, checks the evidence, and records accepted delivery.
6. With all closure conditions met, it writes [the handoff](handoff.md). The
   owner handles any publication. This example ends here.

The [final ledger](tickets.json) and [event log](ticket-events.jsonl) show the
report lifecycle. JSON reports use the role prompts' complete object shapes;
Markdown explains the illustrative evidence. Referenced commands, source trees,
exports, manifests, plan sheet and log files are hypothetical and are not shipped.
A real validator must reject this example as operational evidence.

## Filled PROJECT block

```text
PROJECT
Run type: DIRECTED
Repository: <repo>
Branch: fix/negative-limit
Mailbox: <mailbox>
Handoff file: <mailbox>/orchestrator/handoff.md
Objective: Reject negative limits in parse_limit while preserving nonnegative inputs.
Brief: COMPLETE
Open-ended: NO
Deliverable: both
Definition of done: 1. -1 raises ValueError. 2. 0 and 5 return unchanged. 3. Existing checks pass.
Scope and exclusions: src/limit.py and tests/test_limit.py only; no CLI redesign.
Autonomy: Ordinary implementation choices within the approved contract.
Risk tier: LOW
Measurement: none
Builder: <owner-selected model family A>. Reviewer: <owner-selected model family B>.
Tooling: Existing project verification and mutation commands, reviewed before use.
Verification entry point: <verify-command> --base <base-sha> --head <tip-sha> --red <red-sha>
Report validator: none (manual applicable E1–E6 checks)
Review exports: git archive plus a checked content manifest
Process options: Plan-first: yes. Bundled review: no. Mechanical confirmation: yes.
Rules: No push, publication, installation or real data; checks use the documented host sandbox.
```

## Plan sheet (illustrative)

Contract LIMIT-1 is the existing nonnegative-integer requirement. Add one guard
and one regression assertion. Preserve acceptance of zero and positive values.
A negative-check-removal mutant must be killed by the new assertion. There are
no unresolved decisions. Only the two allowed files may change. Parsing of
strings, floats and other types is excluded from this stage and its coverage.
