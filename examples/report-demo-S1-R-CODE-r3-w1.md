# Synthetic corrected review report

All commands and outcomes are invented; none were executed for this example.
This revision corrects the omitted command list. Scope and verdict are unchanged.

| Command (symbolic paths) | Exit | Illustrative evidence |
|---|---|---|
| python3 -B -m unittest discover -s tests | 0 | 3 tests passed |
| python3 -B <scratch>/probe.py --tree <tip-copy> | 0 | -1 rejected, 0 and 5 unchanged |
| python3 -B <scratch>/probe.py --tree <base-copy> | 1 | negative-input assertion failed |
| <mutation-command> --input <builder-mutants> --tree <tip-copy> | 0 | 1 KILLED, 0 INVALID; passing baseline |

Runtime: fictional Python 3.12.0. Expected logs: <scratch>/review.txt and
<scratch>/mutations.txt. Exports and manifests match the fictional ticket.

| Rule | Manual check |
|---|---|
| E1 | not_required: no corpus requested |
| E2 | met: builder mutation rerun; no own mutations requested |
| E3 | met: probe script and output referenced |
| E4 | met: command list, exits, runtime and test count included |
| E5 | met: base failure and guard-removal control demonstrate sensitivity |
| E6 | not_required: no behavioral defect reported |

No findings within the three attacks; other input types and CLI integration
were not examined. READY denotes completion of this bounded review only.
The orchestrator would inspect actual scripts/logs in a real run; these references
are intentionally illustrative and cannot establish an operational PASS.
