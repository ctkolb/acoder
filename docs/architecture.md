# Architecture

## Roles and handoffs

The owner carries every handoff between three sessions through a mailbox outside the
repository; a reviewer ticket can instead run in a container that the owner launches.

```mermaid
flowchart TD
  owner["Owner"]
  orch["Orchestrator session"]
  builder["Builder session"]
  reviewer["Reviewer session (manual dispatch, the default)"]
  launcher["acoder review run (container dispatch, opt-in)"]
  creviewer["Reviewer in a container"]
  mailbox[("#lt;mailbox#gt;: ledger, tickets, reports, records")]
  exports[("Read-only exports with manifests")]
  repo[("Target repository")]
  orch -- "tickets, ledger, rework notes" --> mailbox
  orch -- "next action and pointer line" --> owner
  owner -- "TICKET or REWORK pointer, or ready and yes" --> builder
  owner -- "TICKET or REWORK pointer, or ready and yes" --> reviewer
  owner -- "runs the prepared launch command" --> launcher
  launcher -- "starts" --> creviewer
  builder -- "local commits on a non-default branch" --> repo
  builder -- "report-#lt;tag#gt;.md and .json" --> mailbox
  orch -- "gates: runs the checks and mutants" --> repo
  repo -- "git archive after the gates pass" --> exports
  exports -- "read" --> reviewer
  exports -- "read as a copy" --> creviewer
  reviewer -- "scratch and report-#lt;tag#gt;.md and .json" --> mailbox
  creviewer -- "scratch and report-#lt;tag#gt;.md and .json" --> mailbox
  launcher -- "run record" --> mailbox
  owner -- "REPORT #lt;tag#gt; ready" --> orch
  mailbox -- "reports and records" --> orch
  owner -- "push, merge, tag" --> repo
```

## Launch sequence

One `acoder review run` goes through the states validate (V), snapshot (S), mailbox
effects (E2), runtime resources (E3), gate (G), release (R), agent (A), stop (T),
scan and evaluate (C) and finalize (F).

```mermaid
sequenceDiagram
  participant O as Owner
  participant L as Launcher
  participant M as Stage folder
  participant RT as Container runtime
  participant SC as Sidecar container
  participant AC as Agent container
  O->>L: acoder review run with flags
  Note over L: V: flags, configuration, paths, key variable, runtime, image
  Note over L: S: copy mailbox and exports to staging, verify ticket, ledger, manifests
  Note over L,M: A refusal in V or S exits 2 with no record and nothing left
  L->>M: E2: scratch-#lt;tag#gt;/, empty report files, log
  L->>RT: E3: volume, network, sidecar container
  Note over L,RT: H3 and H4 check the sidecar, volume and network
  L->>SC: start in probe phase
  L->>RT: create agent container
  Note over L,RT: H1 and H2 check the agent container
  L->>AC: G: start the supervisor
  AC->>SC: probes P1 to P8 through the relay
  SC-->>L: request events, refused or local
  L->>SC: CLOCK
  L->>AC: CLOCK
  Note over L: U1, U2 and the probe results must all pass
  Note over L,M: A failure in E2 to G removes what it made, writes run-#lt;tag#gt;.notstarted-#lt;run_id#gt;.json, exits 1, retry allowed
  L->>SC: R: PHASE agent with the deadline
  SC-->>L: phase agent
  L->>M: run-#lt;tag#gt;.started.json
  L->>AC: RELEASE with the deadline
  Note over AC: A: the supervisor starts the agent
  AC->>SC: model requests
  Note over L: ends on agent exit, wall clock, limit, disk bound, sidecar end or interrupt
  L->>SC: T: STOP
  SC-->>L: summary
  L->>AC: stop, then kill after 10 s
  Note over L,M: C: secret scan, report checks, snapshot hash, exit reason
  L->>M: F: run-#lt;tag#gt;.json and run-#lt;tag#gt;.log
  L->>RT: remove containers, volume, network and staging
  L-->>O: ACODER LAUNCH #lt;tag#gt; #lt;outcome#gt; #lt;record#gt;
```

## Topology and mounts

The agent container has no network; its only way out is a request socket on a
memory-backed volume shared with the sidecar, which alone holds the key and alone is
attached to a network.

```mermaid
flowchart LR
  subgraph host["Host"]
    stage[("#lt;mailbox#gt;/#lt;stage#gt;: scratch-#lt;tag#gt;/, report-#lt;tag#gt;.md, report-#lt;tag#gt;.json")]
    staging[("Staging: copies of mailbox and exports, agent and sidecar payloads")]
    keyvar["Host variable with the key"]
    launcherNode["Launcher"]
    subgraph agentBox["Agent container: network none"]
      agentProc["Supervisor and agent"]
      relayNode["Relay on 127.0.0.1:8080"]
      tmpfsNode["Memory: /work, /tmp, /agent"]
    end
    vol[("Volume in memory: /run/acoder-egress, request socket")]
    subgraph sideBox["Sidecar container"]
      proxyNode["Forwarder with admission and counting"]
    end
    ext["Network EXT, one per run"]
  end
  endpointNode["Model endpoint over verified TLS"]
  staging -- "read-only at /acoder and at the original mailbox and export paths" --> agentProc
  stage -- "read-write: scratch and the two report files" --> agentProc
  tmpfsNode --- agentProc
  agentProc -- "http to the endpoint name, mapped to loopback" --> relayNode
  relayNode -- "bytes" --> vol
  vol -- "read-only in the agent, read-write in the sidecar" --> proxyNode
  staging -- "read-only sidecar payload at /acoder" --> proxyNode
  launcherNode -- "key in the environment at creation" --> proxyNode
  keyvar -- "read by" --> launcherNode
  proxyNode --> ext
  ext --> endpointNode
  launcherNode -- "creates, checks, records" --> stage
```

## Egress path and budgets

The sidecar admits, counts and refuses every model request; the launcher stops the
run with STOP before it signals the agent and records why the run ended.

```mermaid
sequenceDiagram
  participant A as Agent
  participant R as Relay
  participant S as Sidecar
  participant E as Model endpoint
  participant L as Launcher
  A->>R: request to the endpoint name
  R->>S: same bytes over the request socket
  Note over S: method, host and path checks, then admission
  alt before release, over a limit, latched or too many in flight
    S-->>A: refused with a fixed acoder code, not a call
  else admitted
    Note over S: the call counter rises before a byte is sent
    S->>E: forwarded with the key over verified TLS
    E-->>S: answer and usage
    S-->>A: answer with the key redacted
    S-->>L: request event with status and usage
  end
  Note over S: calls or tokens reach the limit, or the deadline passes: admissions latch closed
  S-->>L: limit event
  L->>S: STOP
  S-->>L: summary
  L->>A: stop the agent container
  Note over L: run-#lt;tag#gt;.json: exit_reason done, budget or error, usage counted by the sidecar
```
