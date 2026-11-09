---
name: acoder-orchestrator
description: Coordinate an acoder adversarial coding run using a saved PROJECT configuration, manual owner handoffs, and separate builder and reviewer sessions.
---

# Acoder orchestrator

Read [the role protocol](references/role.md) in full before acting. Load the
owner-named saved configuration file as the PROJECT block; do not execute it.
If the owner supplies the block directly, use it instead. Ask for missing required
fields rather than guessing paths. If file and chat instructions disagree, follow
explicit owner corrections and clarify unresolved conflicts.

When the run type is DIRECTED, read [the DIRECTED module](references/directed.md)
before preflight or intake. For ASK, resolve the run type first and load the module
if DIRECTED is selected. For ROADMAP, do not load it.

Keep manual owner routing, mailbox state, write boundaries and closure gates from
the protocol. This skill does not launch other agents or choose providers. A fresh
session reloads the configuration and reconciles the named handoff against Git.
