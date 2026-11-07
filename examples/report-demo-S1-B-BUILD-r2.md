# Synthetic BUILD report

Session: demo-S1-B-BUILD-r2. All results below are invented for illustration.

The plan sheet had no unresolved decisions. A tests-only commit `2222222222222222222222222222222222222222` adds
`assertRaises(ValueError)` for -1. On the base it produces one assertion failure,
no setup errors. Commit `3333333333333333333333333333333333333333` adds the guard. The three imagined tests (-1, 0,
5) pass; the verification entry point exits 0 and scope is exactly the two allowed
files. Removing the guard kills one mutant with the negative-input assertion.
The existing baseline runs three tests successfully before mutation.

Full logs would live at <scratch>/verification.txt and <scratch>/mutations.txt.
No such execution occurred for this example. No changes outside scope are claimed.
