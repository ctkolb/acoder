PROJECT BLOCK TEMPLATES

Save one filled PROJECT block from the templates below as a Markdown file outside
the target repository, for example `<mailbox>/project-config.md`. Keep one file
per run when objectives differ. This is plain text configuration, not executable
code. Do not save all three templates as one configuration.

Start the orchestrator with:
  $acoder-orchestrator use /absolute/path/to/project-config.md

The first line after PROJECT, "Run type", decides how the run gets its scope:
  ROADMAP    roadmap, backlog and recorded decisions
  DIRECTED   your Objective, sharpened by intake
  ASK        the orchestrator asks which type and objective

The orchestrator loads the DIRECTED module itself when needed. Its preflight
checks the saved block and asks for missing fields. A fresh session uses the same
configuration path and reconciles the named handoff against Git. Update the saved
configuration when you approve a durable change; chat corrections take precedence
in the current session. Never save credentials in it.

Builder and reviewer can use the same configuration path to learn the mailbox,
but their tickets define scope and authorization. They do not load the other
roles. Clients without skills can read the Markdown entry points; text-only
clients need the full role instructions and PROJECT block pasted instead.

To switch work without finishing the current run: tell the orchestrator to park
it. It writes its handoff and says STAGE PAUSED. Start a fresh orchestrator
session with a new block. The parked run resumes later from its own handoff, so
give each run its own handoff file name.

Tooling and process settings (defaults shown):
  Report validator: the command that checks a reviewer report against the evidence
    minimums. The reviewer runs it on its own report before finishing, and the
    orchestrator runs it again. "none" means reports are checked by hand and a
    tooling ticket should create one.
  Review exports: how the orchestrator makes them. Default is `git archive` (never a
    git worktree); a project export tool that wraps it may be named here.
  Process options: Plan-first, Bundled review, Mechanical confirmation, each yes or
    no. Defaults: yes for LOW and STANDARD work; for HIGH work the first three are
    no unless you say otherwise. Rework (a rejected review report is fixed in the
    same reviewer session instead of a new ticket) is always on.

-----------------------------------------------------------------------------
TEMPLATE A: ROADMAP RUN (continue or start a release)
-----------------------------------------------------------------------------

```text
PROJECT

Run type: ROADMAP
Repository: <absolute path>
Branch: <branch>  |  "orchestrator proposes per BOOTSTRAP 1b"   (the owner pushes, merges and tags)
Mailbox: <absolute path outside the repository>/<project>/
Handoff file: <mailbox>/orchestrator/handoff.md

Objective: Resume the <version> run from the handoff and issue the next stage ticket.
  (new release: Start the <version> run. Scope is in ROADMAP.md and docs/backlog-<version>.md,
   or the GitHub milestone if that file does not exist yet. Read the handoff if there is one,
   verify against git, then run BOOTSTRAP: confirm the run sheet with me, have the builder
   record it in docs/decisions.md, and give me the BUILDER/PREPARE ticket for the whole-release plan.)
Definition of done: the <version> stages in docs/backlog-<version>.md are fixed, tested and
  validated per the prompt, with owner-approved limits.
Risk tiers: <per stage or item: LOW | STANDARD | HIGH, and what raises a tier>
Bundles: <stages that may share one review, for example "R17 + R19 + R23 (same files)"> | none
  (never include a HIGH stage; the orchestrator announces each bundle when the plan is approved)

Builder: <model and effort>. Reviewer: <model, a different family from the builder>.
Tooling: <verification and mutation tools the orchestrator runs; changes to them are builder tickets>
Verification entry point (run once per builder report, from the repository root):
  <command with its arguments>
Report validator (the reviewer and the orchestrator run it on a review report):
  <command with its arguments> | none
Review exports: git archive (never a git worktree) | <export tool command>
Process options: Plan-first: yes | no.  Bundled review: yes | no.  Mechanical confirmation: yes | no.
Where the rules live: <run sheet, plan and decisions locations; review cadence>
Rules: <never push, publish, install or transmit; commit message trailer; style rules; local runtime notes>
Release statistics: <file the orchestrator appends to at wrap-up> | none

Give me one next action at a time and name the tag the receiving session should show on its card.
```

-----------------------------------------------------------------------------
TEMPLATE B: DIRECTED RUN (you define the work)
-----------------------------------------------------------------------------

```text
PROJECT

Run type: DIRECTED
Repository: <absolute path>
Branch: <branch>  |  "orchestrator proposes per BOOTSTRAP 1b"
Mailbox: <absolute path outside the repository>/<project>/
Handoff file: <mailbox>/orchestrator/handoff-<run-slug>.md   (one per run, so other handoffs are kept)

Objective: <free text: what you want, in your own words, as short or as long as you like>
Brief: INTAKE | COMPLETE | NO_QUESTIONS
  INTAKE        (default) the orchestrator asks in rounds of up to five questions until the
                objective, definition of done, scope, constraints and success evidence are
                clear, then shows you the brief to confirm
  COMPLETE      the lines below are the whole brief; it checks them and asks only about gaps
  NO_QUESTIONS  proceed on stated assumptions, which it lists for you to veto; it still asks
                about anything hard to reverse or touching sensitive data
Open-ended: YES | NO | ASK
  YES  the work list must be discovered first (audits, bug hunts, performance passes):
       the run starts with a survey and an independent audit, then asks you to triage
  NO   the work is already defined (a feature, a refactor, an upgrade)
Deliverable: code changes | report only | both | ASK
Definition of done: <numbered statements, or leave blank to have INTAKE draft them>
Scope and exclusions: <or leave blank>
Autonomy: <what the run may settle without asking, for example "fix reproduced CRITICAL and HIGH;
  ask me about the rest"> | ASK
Risk tier: LOW | STANDARD | HIGH | propose
Measurement: <command that prints the metric, from the repository root> | none | needs a tooling ticket
  (only for speed, size, memory or coverage goals; say the baseline and what counts as noise if you know them)

Builder: <model and effort>. Reviewer: <model, a different family from the builder>.
Tooling: <verification and mutation tools the orchestrator runs; changes to them are builder tickets>
Verification entry point (run once per builder report, from the repository root):
  <command with its arguments>
Report validator: <command with its arguments> | none
Review exports: git archive (never a git worktree) | <export tool command>
Process options: Plan-first: yes | no.  Bundled review: yes | no.  Mechanical confirmation: yes | no.
Rules: <never push, publish, install or transmit; commit message trailer; style rules; local runtime notes>

Give me one next action at a time and name the tag the receiving session should show on its card.
(During intake and triage you may put numbered questions or items to me in one message.)
```

-----------------------------------------------------------------------------
TEMPLATE C: ASK (you have not decided, or are describing the work in chat)
-----------------------------------------------------------------------------

```text
PROJECT

Run type: ASK
Repository: <absolute path>
Mailbox: <absolute path outside the repository>/<project>/
Builder: <...>. Reviewer: <...>.
Tooling / Verification entry point / Report validator / Rules: <as above>

Objective: (I will describe it in my first message.)
```

-----------------------------------------------------------------------------
OBJECTIVE EXAMPLES (Objective line of Template B)
-----------------------------------------------------------------------------

Find and fix bugs across the whole project
  Run type: DIRECTED   Brief: INTAKE   Open-ended: YES   Deliverable: both
  Objective: Review the entire project for bugs and fix the ones worth fixing. Correctness
    and data loss matter more than polish.
  Expected shape: intake rounds (what counts as "worth fixing", areas to skip, risk tier,
  autonomy), S0 discovery by both builder and reviewer, a triage table for you, then fix
  stages with the normal review loop, then a coverage statement of what was and was not examined.

Find performance improvements
  Run type: DIRECTED   Brief: INTAKE   Open-ended: YES   Deliverable: both
  Measurement: <benchmark command>
  Objective: Find performance optimizations or enhancements for this project and implement
    the ones that pay off.
  Expected shape: intake settles the metric, the workload, the baseline, the noise level and
  the rule that behavior must not change (so fixes use CHARACTERIZATION tests); S0 reports
  profiled hot spots with numbers; the orchestrator re-runs the measurement itself and the
  reviewer re-runs it independently.

Implement a feature you define
  Run type: DIRECTED   Brief: INTAKE   Open-ended: NO   Deliverable: code changes
  Objective: Implement <feature X>. Done when <XYZ>. Ask me clarifying questions in rounds
    until the definition is entirely clear.
  Expected shape: rounds of up to five questions with recommendations until nothing that
  affects scope, behavior or evidence is open, then the brief to confirm, then PREPARE, SPEC
  review for a new consequential contract, and BUILD stages (Plan-first for LOW and STANDARD
  stages). No survey stage.

Audit only, no changes
  Run type: DIRECTED   Open-ended: YES   Deliverable: report only
  Objective: Security-review the authentication and file-upload code and give me a ranked
    report. Change nothing.
  Expected shape: S0 survey and audit, triage table, run ends with the summary.
