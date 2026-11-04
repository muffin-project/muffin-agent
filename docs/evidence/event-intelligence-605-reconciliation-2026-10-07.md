# Event Intelligence ↔ #605 reconciliation — 2026-10-07

## Question

Can the existing Event Intelligence spike become Muffin's implementation substrate for #605 without creating a second scheduler, agent loop, authority path, or canonical event store?

## Observed current state

Reconciled against upstream `dev@b178dd3201d13a658a054e3cf28a005ea724afd5`.

- #605 owns the executable `RuntimeEvent -> AutomationRule -> ActionRequest -> DeterministicExecutor | AgentExecutor` seam.
- The current scheduler already owns durable occurrence identity through `JobFireStore`, canonical system authority, Turn execution and delivery.
- #598 has since landed the durable unattended Turn/Work continuation spine that the older #605 comments were waiting on.
- #780 separately owns the proposed internal `MuffinEvent` log boundary. An external trigger/correlation package must not silently become Muffin's canonical internal event log.
- Current MCP connections are verified and host-owned. The EI spike already reuses those sessions rather than reconnecting with duplicate credentials.
- The existing spike proves durable trigger creation/management, event correlation, no active LLM polling, and wake/resume back into Muffin.

Spike reference:
https://github.com/sarooo17/muffin-agent/tree/slice/event-intelligence-spike

## Existing spike shape

```text
verified host-owned MCP session
        ↓
Event Intelligence
  persistent condition / CEP
        ↓
match activation
        ↓
Muffin enqueueTurn
        ↓
canonical Turn / authority / tools
```

The useful part is the persistent condition/correlation layer. The problematic part for upstream #605 is that the activation currently enters `enqueueTurn` directly, beside the scheduler/message paths, rather than through the executable-composition waist.

## Candidate shapes

### A — copy the spike as-is

Pros:
- smallest port;
- already proven end-to-end.

Cons:
- introduces another executable event path;
- does not converge `schedule.fire` and `message.received`;
- makes #602/#780 composition harder.

**Rejected for upstream.**

### B — build a new Muffin event/CEP framework and discard EI

Pros:
- all code local.

Cons:
- duplicates persistent conditions, correlation, lifecycle, dedup and MCP Events handling already covered by EI;
- grows exactly the generic event framework #605 says not to build before concrete producers require it.

**Rejected.**

### C — keep Muffin's narrow waist canonical; use EI only behind the trigger/rule side

Target:

```text
schedule.fire ─┐
message.received├─> RuntimeEvent / AutomationRule
external MCP ───┘            │
                              ├─ deterministic action
                              ├─ agent action -> canonical Turn/Work
                              └─ complex/persistent condition -> EI
                                                   │
                                              matched event
                                                   └─> canonical ActionRequest
```

Muffin continues to own:
- occurrence/work identity where Muffin has one;
- principal/tenant/authority;
- Turn/Work execution;
- Effect WAL and delivery;
- internal event-log semantics (#780);
- MCP credentials/transports.

EI owns only the runtime-neutral pieces it already proves:
- persistent trigger definitions and lifecycle;
- temporal/compound pattern evaluation;
- correlation/dedup needed by those patterns;
- MCP Events consumption over host-supplied sessions;
- activation evidence.

**Chosen direction.**

## Constraints carried into implementation

1. No second scheduler or agent loop.
2. No owner impersonation on event wake.
3. No model call merely to decide whether a deterministic path should call the model.
4. No EI-owned canonical Muffin event log.
5. Existing scheduler/script and message-ingress paths must converge on the same action seam rather than remain permanent special cases.
6. Event evidence is runtime/external evidence, never owner-authored text.
7. Authority/policy is rechecked at execution time by Muffin.
8. EI remains optional embedded infrastructure; no default install path requires external credentials.

## Verification profile

**CRITICAL candidate.**

Reason: this changes the runtime execution boundary connecting unattended events to canonical agent execution and touches authority/provenance. The implementation should therefore get targeted fault/e2e evidence plus a fresh independent judge before integration, even if the diff remains small.

## Falsifiers

The chosen shape fails if any of these are true:

- adding `software.updated` still needs a new execution callback beside the seam;
- an EI match can execute with owner authority merely because the owner created the trigger;
- a no-signal deterministic rule causes a model call;
- the same durable occurrence can wake two independent agent work units after restart/replay;
- an external event payload is rendered as owner-originated input;
- disabling/removing EI breaks ordinary scheduler or message ingress;
- Muffin must treat EI storage as the source of truth for its internal event history.

## Initial PR boundary

The first upstream draft will port the already-proven embedded EI adapter onto current `dev`, preserve host-owned MCP sessions and canonical Turn execution, and introduce only the minimum action/event seam needed to keep that adapter from becoming a parallel execution path. It will stay draft until #605's `schedule.fire` / `message.received` acceptance is represented on the current production path.
