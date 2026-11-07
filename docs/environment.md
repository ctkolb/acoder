# Environment and execution requirements

This project supplies skills, Markdown entry points and documentation. It does not supply a sandbox,
agent launcher, verification runner or report validator. The workflow assumes
three manually operated sessions that can read local files and run tools, with
Git available to the builder and orchestrator. Examples use POSIX command syntax;
Windows users must adapt paths and commands. No host/model compatibility matrix
or comparative effectiveness benchmark has been established for this release.

## Provisioning

Before a run, identify the host mechanism that enforces the ticket's boundaries:
a configured container, VM, or agent execution sandbox. A container with broad
host mounts or credentials is insufficient. Record these settings in the run sheet:

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

Verify denied writes and network access using harmless probes before executing
project code. Store the observed controls and any limitations. If enforcement
cannot be established, proceed with static review only and mark execution
NOT_CHECKED. Read-only file modes and instructions alone do not enforce isolation.
The agent provider's handling of prompts and files is separate from network
restrictions on subprocesses; choose permitted data accordingly.

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
or mutation kills. Code from a reviewed project and reviewer-authored scripts
receive the same execution restrictions.

The workflow seeks diverse review perspectives. Different model families do not
guarantee independent errors. No measured claim about defect detection, cost or
speed is made here. When evaluating the workflow, record elapsed time, model
cost, human interventions, reproduced findings and missed seeded defects.
