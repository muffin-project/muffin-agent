# Background work contract — 2026-08-29

Status: research/implementation contract. No background-spawn capability ships
from this document alone.

Question: **what must Muffin own before an agent can start work that outlives one
foreground tool call?**

## 1. Current reality

Muffin itself is already long-lived: the gateway runs under launchd/systemd and
has heartbeat/restart/start/stop semantics. That does **not** mean the agent has
a background-process primitive.

Today the model has:

- foreground, non-interactive, sandboxed `shell_run` with a bounded timeout;
- `process_list` for a constrained view of host processes;
- `process_kill` for an explicitly targeted PID under policy;
- durable turns/waits/jobs, which can outlive one model invocation.

It does not have a durable identity for a process it started, retained output,
completion wake-up, task ownership or reconciliation after the gateway dies.

Using `nohup`, `&`, `disown` or similar through shell is therefore **not** the
product feature: it creates an effect that Work/Effects cannot explain later.

## 2. Peer challenge

### Hermes Agent

Hermes exposes `terminal(background=true)` returning a session id + PID and a
`process` tool for list/poll/wait/log/kill/write. Its persistent-goal loop can
park automatically when a live background process is the true blocker and resume
when it completes. This is the strongest peer prior for the agent UX we need.

Useful primitive: **a named process handle belongs to agent work; waiting is a
state transition, not repeated polling by the model.**

### OpenClaw

OpenClaw's exec tool can foreground → background after a yield threshold and
returns a `sessionId`; `process` exposes list/poll/log/stdin/PTY/kill. It can
notify/wake on exit and explicitly says polling is for status, not scheduling.

Important counterexample: its background registry is in-memory and sessions are
lost on process restart. That may be acceptable for its runtime, but is below
Muffin's already-established durability semantics. Muffin should not make a
turn durable while forgetting the process the turn is waiting for.

### Claude Code

Background shell tasks are valuable ergonomically for builds/dev servers, but a
session-scoped background task is not automatically a durable service. The
lesson is UX/lifecycle separation rather than a storage model to copy.

### OS supervisors / durable-workflow systems

launchd/systemd already solve a different problem well: long-lived services that
should restart independently of one conversational task. Durable workflow
systems such as Temporal reinforce the distinction between **waiting for an
external event** and **retrying a failed activity**; a wait is ordinary workflow
state, not evidence of failure.

## 3. Do not collapse task and service

Two primitives are required eventually.

### Background task

Bounded work whose lifetime belongs to one Muffin work item and normally ends:

- test/build/import/export;
- local inference/download/indexing job;
- child coding agent for one assignment;
- a subprocess that waits for one external operation.

### Service

Infrastructure expected to remain available and/or survive reboot independently
of a specific turn:

- Ollama/local inference server;
- an MCP daemon;
- voice/sensor bridge;
- development server intentionally promoted to a service;
- future Node helper.

A background task may become a service only through an explicit different
capability/owner decision. “The process is still running” is not service
installation.

## 4. Background-task state machine

Do not expose `process_spawn` before this state has one owner.

```text
proposed
   │ policy allows / asks and owner allows
   ▼
starting ────── spawn known failed ─────► failed
   │
   │ process identity established
   ▼
running ────── observed exit 0 ─────────► succeeded
   │  └─────── observed exit != 0 ──────► failed
   │
   ├────────── cancel requested ─────────► stopping ──► cancelled
   │
   ├────────── timeout/TTL ──────────────► stopping ──► timed_out
   │
   └────────── gateway/process crash
                 │
                 ▼
              unknown
                 │ reconcile identity/OS evidence
                 ├──────── still ours/running ────────► running
                 └──────── cannot prove outcome ─────► unknown_terminal
```

`unknown_terminal` is not `failed` and not `succeeded`. The Effects-plane rule
already used for tool calls applies here too: after a crash, “may have happened”
must not collapse into a convenient answer.

## 5. Durable record

Minimum durable fields, exact schema deferred to implementation:

```text
background_task.id                stable Muffin handle
origin_turn_id / work identity
principal + tenant
capability / normalized command intent
created_at / started_at / ended_at
status
pid + process identity evidence
sandbox/execution target + cwd
network/write scopes or a reference to the approved execution envelope
timeout / ttl
exit code / termination reason
stdout/stderr retention metadata
completion wake relationship
last observed heartbeat/reconcile time
```

Do not store arbitrary inherited environment: it can contain secrets. Persist
only explicit non-secret execution metadata needed to explain/reconcile the
work.

## 6. Process identity: PID is not enough

Muffin already documents PID reuse as a residual risk for process signalling.
A durable background task makes that risk larger because reconciliation may
happen much later.

The implementation must not blindly decide “pid N exists, therefore it is my
process”. Use the strongest portable identity we can prove on the platform, for
example a combination of:

- PID;
- launch/start timestamp obtainable from the OS;
- child-process relationship while the launching gateway lives;
- a Muffin-created per-process token/pipe/file descriptor where containment
  permits;
- command/executable metadata only as supporting evidence, never identity alone.

If identity cannot be re-established after a restart, move to `unknown_terminal`
or another explicitly uncertain state. Never signal a merely matching reused
PID automatically.

## 7. Output and context

Background output is evidence, not an infinite model context.

Requirements:

- hard cap while capturing so a firehose cannot eat memory/disk;
- retained head/tail or segmented bounded log with explicit truncation metadata;
- stdout/stderr remain distinguishable;
- `process.log`/equivalent supports bounded paging;
- completion notification includes status + small tail, not the entire log;
- content entering the model carries normal tool-result provenance/taint until
  Security v2 replaces that consumer.

OpenClaw's explicit per-session/global output caps are useful prior art here.

## 8. Wait/wake integration

The model should not write:

```text
poll → not done → poll → not done → poll ...
```

when the runtime can know completion itself.

A background task may return immediately with a handle. If the current work is
blocked on it, `wait` should be able to suspend on `background_task:<id>` and the
runtime should wake the durable turn on a terminal transition.

This must share the existing turn suspension semantics. It must **not** consume
crash-resume budget merely because the process took ten minutes; PR #241 exists
because Muffin already conflated those concepts elsewhere.

Manual `process.poll/status/log` remains useful for inspection/intervention, not
as the scheduler.

## 9. Permission/security boundary

Starting a background process is not “shell but asynchronous”. The lifetime
changes the risk.

The policy/action must expose at least:

- executable/command intent;
- cwd and write scope;
- network scope;
- timeout/TTL;
- whether stdin/PTY remains writable;
- whether it may survive the originating turn;
- cancellation semantics.

The child must run through the same real sandbox execution path as foreground
shell unless a separately reviewed capability says otherwise. Backgrounding
must never be an escape from a foreground timeout, network deny or write scope.

A future hard no-progress guardrail may park on a known background handle; it
must not create a second process because the first has not finished yet.

## 10. Runtime restart semantics

Candidate options:

### A — in-memory registry only

Simple, matches OpenClaw. Rejected for Muffin as the target because a gateway
restart destroys the explanation for a durable waiting turn.

### B — persist metadata, kill children on gateway exit

Good first implementation candidate. The record survives; live children are
owned by the gateway/process group and are deliberately terminated during
normal shutdown. On crash/restart, reconcile; no promise that ordinary tasks
survive the parent.

### C — independently surviving children

More autonomous but much harder: ownership and containment must survive parent
death, log handles need durable plumbing, and cancellation/identity crosses
process generations. This begins to resemble a service/work supervisor.

**Recommendation for v1: B.** Durability means Muffin remembers and correctly
classifies the work, not that every Unix process becomes immortal.

## 11. Service semantics

Do not build a second daemon supervisor inside Muffin.

A future service capability should compile a constrained declarative service
spec into launchd/systemd user units and expose:

```text
service.install
service.start
service.stop
service.restart
service.status
service.logs
service.uninstall
```

The spec needs executable, args, cwd, env references (not secret values), restart
policy, resource/network policy where enforceable and log destination. Raw plist
or systemd-unit text from the model should not be the authority surface.

Service installation is a higher-risk, longer-lived effect than starting one
bounded task and should have its own capability/policy/undo semantics.

## 12. First implementation slices

Do not implement all of this in one PR.

1. **Store + state machine only** — durable record, legal transitions,
   uncertainty, output-retention metadata. No spawn tool yet.
2. **Contained spawn + status/cancel** — production executor path, process
   identity, capped capture, no automatic wait yet.
3. **wait/wake integration** — completion turns a durable wait runnable; no
   polling loop.
4. **gateway shutdown/reconciliation** — normal kill/drain and crash restart
   behavior proven on production path.
5. **model-facing process tool** — list/status/log/cancel using handles, once the
   lower layers are proven.
6. **service primitive** — separate Step 0/research/claim.

## 13. Acceptance / kill criteria

Background task support is not done because `sleep 5 &` works.

Acceptance must prove:

- a task has one durable Muffin id before/at spawn;
- model never needs a raw PID to address its own background work;
- output is bounded and inspectable;
- normal gateway stop does not orphan the child;
- crash/restart cannot silently relabel unknown as success/failure;
- a waiting turn wakes on completion without busy polling;
- foreground and background executions have the same containment/egress/write
  guarantees for the same execution envelope;
- cancellation cannot hit a reused/unproven PID;
- an old/finished record expires or compacts by an explicit retention rule.

Kill/rethink this design if a dependency already available to Muffin can provide
those exact semantics with less code **without** weakening the Home's canonical
Work/Effects model.

## 14. Primary/current peer sources

- Hermes Agent tools/background-process docs and persistent-goal wait behaviour,
  current August 2026 docs.
- OpenClaw `exec` / background process docs, current August 2026 docs; especially
  session handles, output caps, completion wake and the explicit limitation that
  the registry is in-memory/lost on restart.
- launchd/systemd as the existing supervisor boundary for durable services.
- Temporal durable-execution semantics as prior art for “waiting is workflow
  state, not a failed retry”.

Implementation PRs should pin exact upstream commits/versions when specific
behavior becomes load-bearing.
