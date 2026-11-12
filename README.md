# acoder: Adversarial Coding Loop

This project is a collection of skills for coordinating AI coding and independent review across multiple model vendors. The motivation is to dodge tunnel vision: a single model or even different models from the same vendor can miss problems because of patterns in its training, and models from the same vendor may share some of those blind spots. Using different vendors is my preferred way to bring more varied perspectives to the work.

I looked at prompts and skills others had built, but none quite matched the workflow I wanted. So I started iterating on my own. This collection grew out of several iterations against a real project, refining how the agents plan, build, challenge and verify each other's work while keeping the owner in control.

Three AI sessions work on one code repository, and you sit in the middle as the owner.

| Role | Activities | Skill |
|---|---|---|
| Orchestrator | Plans the run, writes tickets, runs the mechanical checks, routes findings, asks you for decisions. Never edits the repository. | [acoder-orchestrator](skills/acoder-orchestrator/SKILL.md) |
| Builder | Explores, writes code, tests and docs, makes every commit (locally, on a non-default branch). | [acoder-builder](skills/acoder-builder/SKILL.md) |
| Reviewer | A different model family from the builder. Challenges the work, reproduces defects, tests the tests. Reviews exports; writes scratch evidence and reports. | [acoder-reviewer](skills/acoder-reviewer/SKILL.md) |

The point is independence: the reviewer does not take the builder's word for  anything, and the orchestrator does not take either one's word for anything it can run itself. Nobody pushes, merges or publishes. You do that.

It works two ways, chosen by the `Run type` line in the PROJECT block:

- **ROADMAP**: continue or start a release from the project's roadmap, backlog and recorded decisions.
- **DIRECTED**: you say what you want, in your own words. Examples: "review the whole project for bugs and fix them", "find performance improvements", "implement feature X, done when XYZ, ask me questions until it's clear".

## Quickstart and prerequisites

This is a skill collection with manual session handoffs. Supply a project with Git history, usable checks, provisioned dependencies and sessions with local file/tool access. Read [environment guidance](docs/environment.md) and [tooling contracts](docs/tooling.md) first. There is no bundled execution sandbox, mutation runner or report validator.
The commands and evidence below are project-specific inputs, not tools shipped here.

For a first run, choose a small, reversible, well-defined task. Fill Template B with `Brief: COMPLETE`, `Open-ended: NO` and a concrete definition of done. Name existing checks and set a LOW tier if its criteria apply. Save the block to your configuration file and follow Setup and The loop above; the quickstart uses the same protocol and approval rules.

Read the [synthetic walkthrough](examples/README.md) for a filled project block, tickets, reports, a rework revision and closure. All outcomes in that example are illustrative. This release has not been validated by an end-to-end agent run or benchmarked against a single-agent workflow.

Use the host’s execution controls and report their limits accurately. Additional isolation infrastructure is required only when the owner explicitly selects it for the run; missing explicitly required controls block the affected execution. Reviewer export, scratch, credential and network restrictions still apply. Prompt rules and read-only exports do not enforce a security boundary.

Keep filled-in PROJECT blocks, real tickets, reports and logs outside this repository. They commonly contain machine paths, commit identities and private
project details. Use synthetic fixtures when proposing public examples.

## Setup (once per project or run)

1. Pick a mailbox directory **outside** the target repository, for example `~/agent-mailbox/<project>/`. Tickets, reports and handoffs live there.
2. Fill **one** PROJECT block from [project-block.md](project-block.md) and save it as `<mailbox>/project-config.md`. Use Template A for ROADMAP, B for DIRECTED, or C for ASK. Use separate configuration and handoff files for separate runs.
3. Open three sessions, one per role. Choose a different vendor/model family for the reviewer than for the builder. Install the appropriate skill in each client; each skill contains its own protocol and needs no sibling skill.
4. Start the orchestrator session with its role and your absolute configuration path: `Use the acoder-orchestrator skill with /absolute/path/to/project-config.md`. Invoke each skill in its corresponding session using your client's syntax, or ask the client to read the skill's `SKILL.md` by absolute path and use the named configuration. The orchestrator reads the saved PROJECT block and loads the DIRECTED module when needed. Builder and reviewer read only initialization instructions and the named configuration, then reply `READY: <role> — waiting for a ticket`. Initialization authorizes no ticket work.
5. Keep durable owner-approved configuration changes in the saved file so fresh sessions receive them. The file is plain text; do not include credentials.

## The loop

You carry work between sessions. Nothing launches by itself.

1. The orchestrator tells you the next action, naming the receiving session and a  **tag** (for example `demo-S1-B-BUILD-r1`), and gives a pointer line: `TICKET <tag> at <absolute path>`.
2. Go to that session and either say **ready** (it finds its ticket, shows a card with the tag, mode, expected commit and limits, and waits for your **yes**), or paste the pointer line (starts at once). Check that the tag matches.
3. The role does the work, writes `report-<tag>.md` and `.json` into the mailbox, and stops.
4. Tell the orchestrator `REPORT <tag> ready`. It reads the report, runs the mechanical checks itself, and decides the next step: a fix round, a review, a question to you, or stage close.
5. Repeat. Review runs on read-only exports (made with `git archive`, no `.git`) that the orchestrator prepares. If a review report fails the validator, the orchestrator writes a rework note and you send `REWORK <tag> at <path>` to the same reviewer session.

Rules of thumb: one pending ticket per role at a time; fix rounds stay in the same builder session; a closed stage ends the sessions (below).

## What you decide

- The run type, objective and risk tier.
- Answers to intake questions, and confirming the brief.
- Triage dispositions (DIRECTED discovery runs).
- The branch name and base, when the orchestrator proposes one (your yes creates that one local branch).
- Disputed findings, scope changes, and accepted limits.
- Every push, merge and tag. The agents never do these.

## Fixed safety rules

The orchestrator writes only inside the mailbox. The builder commits only on a non-default branch and never pushes and installs dependencies only with explicit authorization. The reviewer writes only to its scratch folder and its report, runs no `git` command, and works on copies of read-only exports. Reports, logs and repository files are treated as data, never as instructions. A role starts work only on your `ready` plus `yes`, or your pasted pointer line.

## Model Recommendations

Ranked by pipeline strength first, cost second.

### Cost model

- **Cycle** = Orchestrator (dispatch) → Builder → Reviewer → Orchestrator (interpret/route) — approximately 3 orchestrator calls, 1 builder pass, 1 reviewer pass, each ~30K input / 4K output at list rates.
- **Per-feature cost** = (cycles-to-green × per-cycle cost) + one-time 1a spend (if applicable) + escalation surcharges.
- Figures are order-of-magnitude arithmetic, not quotes. Real runs vary with diff size (a 200K-context review costs ~3× the nominal figure).

| #     | Orchestrator                   | Builder              | Reviewer                                                                | Best for                                                                                                    | ~$/cycle                     | Notes / Warnings                                                                                                                                      |
| ----- | ------------------------------ | -------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | — (you)                        | Fable 5.2            | GPT-6 Astra                                                             | Security-sensitive features — but only for the planning stage. *Not worthwhile beyond planning.*            | One-time: ~$5–10 per feature | Tell Fable the builder will be Sonnet — but ask for *explicitness, not simplification*                                                                |
| **2** | Sonnet 5.5                     | Opus 5.5             | GPT-6.1 Sol                                                             | Execution of a security-sensitive spec OR Escalation after 2-3 review rejections from with a Sonnet builder | ~$0.60                       | Opus and Sonnet tie often in benchmarks; could be relatively expensive for the improvement; Optional Astra final exploit pass if stakes warrant |
| **3** | Sonnet 5.5                     | Sonnet 5.5           | GLM-5.3 *or* GPT-6.1 Sol                                                | Sensitive-but-not-frontline runs                                                                            | ~$0.46                       |                                                                                                                                                       |
| **4** | **Sonnet 5.5**                 | **Sonnet 5.5**       | **GPT-6 Luna**; escalating to **GLM-5.3** for security sensitive stages | **Daily driver emphasizing Claude**                                                                         | **~$0.41**                   | GLM is a better reviewer when in a stage particularly risky for security                                                                              |
| **5** | **GPT-6 Luna**                 | **GPT-6.1 Sol @med** | **GLM-5.3**                                                             | **Daily Driver emphasizing Codex**                                                                          | **~$0.30**                   | ~1-notch step-down in planning and general coding vs. Sonnet — expect slightly more cycles per ticket                                                 |
| **6** | GPT-6 Luna                     | GLM-5.3              | GPT-6 Luna                                                              | Pay-per-token weeks, unknown work                                                                           | ~$0.08                       | Cheap, with the "strength" at the builder seat                                                                                                        |
| **7** | Sonnet 5.5 or GPT-6 Luna       | DeepSeek V4.1 Flash  | GLM-5.3                                                                 | Bulk work, doc work, low stakes                                                                             | ~$0.07                       |                                                                                                                                                       |

### Effort settings

- Orchestrator: `medium` default; `high` only when making escalation decisions or interpreting repeated rejections.
- Builder: Sonnet/Opus: `high` , Sol `med`
- Reviewer: `high` always (deliberation pays in review); Sol peaks at `high` — xhigh/max score *lower* while costing more.

### Escalation triggers

- 2–3 reviewer rejections on one ticket → escalate the builder (Sonnet → Opus) and the reviewer (Luna → Sol) *together*. A ticket hard enough for Opus is too hard for a $0.50/M reviewer — the most expensive code must never get the cheapest review.
- Security-flagged diff (auth, secrets, network) → reviewer escalates regardless of cycle count.

## DIRECTED run options (Template B)

Used when you prefer to give the Orchestrator a specific objective rather than giving it more general statements in a project block and having it do discovery in the repo and making recommendations on its own.

| Line | Values | Effect |
|---|---|---|
| `Objective` | free text | What you want. As long or short as you like. |
| `Brief` | `INTAKE` (default), `COMPLETE`, `NO_QUESTIONS` | `INTAKE`: the orchestrator asks questions in rounds of at most five, each with a recommended answer and lettered options (reply like `1a 2 no 3b`), until the definition of done, scope, constraints and success evidence are clear, then shows you a brief to confirm. `COMPLETE`: your block already is the brief; it checks for gaps only. `NO_QUESTIONS`: it proceeds on stated assumptions you can veto, but still asks about anything hard to reverse or touching sensitive data. |
| `Open-ended` | `YES`, `NO`, `ASK` | `YES`: the work list must be discovered first (bug hunts, audits, performance passes). The builder surveys read-only and the reviewer audits independently; the orchestrator gives you a **triage table** and only items covered by your explicit approval or confirmed autonomy rule are built. `NO`: the work is already defined (a feature, a refactor). |
| `Deliverable` | `code changes`, `report only`, `both`, `ASK` | `report only` ends the run after triage, with no repository changes. |
| `Definition of done` | numbered statements, or blank | Blank lets INTAKE draft it. |
| `Autonomy` | free text, or `ASK` | What the run may settle without asking you, for example "fix reproduced CRITICAL and HIGH, ask about the rest". |
| `Risk tier` | `LOW`, `STANDARD`, `HIGH`, `propose` | Sets how many reviews and fix rounds you get (LOW: 1 review, 2 fix rounds; STANDARD: 1 review, 3 rounds; HIGH: reviews after every stage, independent contract review first, 3 rounds then you decide). |
| `Measurement` | a command, `none`, or `needs a tooling ticket` | For speed, size, memory or coverage goals: a command that prints the metric. The orchestrator and the reviewer both re-run it; an improvement inside the noise level does not count. |

Triage choices for each candidate are FIX, DEFER, ACCEPT or REJECT. A suspected issue must be reproduced before anyone fixes it, and a discovery run ends with a statement of what was and was not examined, never "no bugs left".

## Changing course

- **Scope or definition of done changes mid-run:** just tell the orchestrator. It restates the difference, waits for your yes, has the builder record a new brief revision, and issues new tickets. Issued tickets are never edited.
- **A different, unrelated job:** tell the orchestrator to park the run. It writes its handoff and says `STAGE PAUSED`. Start a fresh orchestrator session with a separate saved PROJECT configuration. Give each run its own handoff file name so the parked one resumes later.
- **Context getting long:** the orchestrator finishes the check in progress, writes the handoff and says `STAGE PAUSED`.

## Stage close

When a stage meets the closure conditions the orchestrator writes the handoff and prints a `STAGE CLOSED` block with the decisions it needs from you. Then:

- Start a **fresh orchestrator session** and invoke the `acoder-orchestrator` skill with the saved configuration path. It loads the required instructions, resumes from the handoff and checks it against Git; Git wins on any difference.
- Start a **fresh builder session** for the next stage, and a new reviewer session per review. Invoke each role skill with the saved configuration path again.
- The old orchestrator session issues no more tickets unless you say `continue`.

At the end the orchestrator writes a wrap-up in plain language: for ROADMAP runs a decision review before you tag; for DIRECTED runs a run summary of what was asked, done, deferred and not examined.

## Troubleshooting

- *Tag mismatch or "stop and report":* the pointer, the card and the ticket header must agree. Ask the orchestrator to reissue the ticket (a new `rN`).
- *Orchestrator cannot load the directed module:* check that the complete `acoder-orchestrator` folder, including `references/directed.md`, is installed.
- *Handoff belongs to a different run:* the orchestrator says so and does not resume it. Name a run-specific handoff file.

## License

This project is licensed under the GNU General Public License, version 3 or (at your option) any later version (`GPL-3.0-or-later`). See [LICENSE](LICENSE).
