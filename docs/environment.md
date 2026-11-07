# Environment and execution guidance

This project supplies skills, Markdown entry points and documentation. It does not supply a sandbox,
agent launcher, verification runner or report validator. The workflow assumes
three manually operated sessions that can read local files and run tools, with
Git available to the builder and orchestrator. Examples use POSIX command syntax;
Windows users must adapt paths and commands. No host/model compatibility matrix
or comparative effectiveness benchmark has been established for this release.

## Execution defaults

Use the execution controls supplied by the host. Builders may run checks in their
authorized working tree; orchestrators run the approved verification commands.
Reviewers still use scratch copies of read-only exports, with no Git metadata,
real-repository or credential access, or network use. These role restrictions
apply whether or not the run requires additional isolation.

Report actual controls and limitations accurately. Additional isolation
infrastructure is not a prerequisite unless the owner explicitly requires it in
PROJECT or the ticket. Prompt rules, copies and read-only modes are not a sandbox.

## Additional isolation (when explicitly required)

Use the host mechanism and restrictions specified for the run, such as a configured
container, VM or agent execution sandbox. Record the actual settings in the run
sheet, including the following where required:

- Read-only inputs: the exact source export and approved tooling/dependencies.
- Writable outputs: owned scratch, cache, temporary and report directories.
- Network: disabled for project code, checks and reproductions by default.
- Data: synthetic fixtures only unless specific data is authorized; no host
  credentials, agent sockets, home-directory mounts or production stores.
- Children: subprocesses inherit the same restrictions and resource limits.
- Builder changes: a separate authorized working tree for edits and local
  commits; executable checks run against isolated copies at the relevant commit.

An owner can provision dependencies before the run. Describe the dependency
versions and runtime in evidence. If a project requires Git metadata to build,
stop and propose a compatible exported version fixture or build input; do not
silently give the reviewer a live repository.

Verify the explicitly required controls with harmless probes before the affected
execution. Store observations and limitations. If a required control cannot be
established, proceed with static review only for the affected area and mark
execution NOT_CHECKED. The agent provider's handling of prompts and files is
separate from network restrictions on subprocesses; choose permitted data accordingly.

## Exports

The orchestrator exports the exact commit and records a content manifest with
relative paths, entry types, executable modes, file hashes, and symlink targets.
Validate the extraction against it, including added or missing files. Reject
symlinks that resolve outside the approved input tree. The reviewer checks the
manifest before copying files to writable scratch. A directory named after a
commit and a list of changed filenames do not establish content identity.

## Evidence boundaries

Running a script successfully establishes only the assertions it checks. Review
those assertions, their inputs and expected failure behavior. Setup errors,
missing dependencies and zero-test runs are not successful defect reproductions
or mutation kills. Apply the run's execution restrictions to both project code
and reviewer-authored scripts.

The workflow seeks diverse review perspectives. Different model families do not
guarantee independent errors. No measured claim about defect detection, cost or
speed is made here. When evaluating the workflow, record elapsed time, model
cost, human interventions, reproduced findings and missed seeded defects.
