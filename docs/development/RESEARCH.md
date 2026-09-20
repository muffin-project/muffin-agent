# Research and challenge protocol

This document owns **how Muffin challenges a design before implementation**.
It applies to humans and to every coding/research agent working on this repository:
Claude Code, Codex, ChatGPT, Hermes, or anything else that can read the tree.
Tool-specific adapters may point here; they must not fork this protocol.

The goal is not to maximise research. It is to prevent a familiar failure mode:
building a locally coherent mechanism around an assumption that a real install,
a peer system, or external evidence would have falsified first.

> **Do not ask only “how should we implement this?” First ask “should this exist,
> what problem does it actually solve, and what evidence would make us choose a
> different shape?”**

## 1. When this pass is mandatory

Run the research/challenge pass **before implementation** when a claim does any
of the following:

- introduces or materially changes an agent-runtime primitive, harness behaviour,
  tool lifecycle, hook, guardrail, subagent mechanism, scheduler, process/service
  primitive, context-management mechanism, or autonomy policy;
- changes security, authority, permissions, provenance/taint, egress, sandboxing,
  secrets, approval semantics, or another trust boundary;
- changes memory, recall, consolidation, person/user modelling, salience, decay,
  identity/entity resolution, proactive behaviour, or another cognitive claim;
- introduces a dependency/framework or reimplements a capability common in other
  agent systems;
- changes a durable schema/protocol/public extension surface;
- is justified mainly by intuition, an old ADR, or “this seems safer/better”.

Mechanical fixes whose desired behaviour is already unambiguous do **not** need a
fresh literature review. They still reconstruct current reality and inspect the
production path before editing. If a “small bug” exposes an architectural
assumption, escalate and run this pass.

## 2. The order: reality before analogy

Research starts inside Muffin, not on the web.

### A. Observe the real system

1. Reconstruct Git/worktree/branch/PR/check/delegation state.
2. Inspect the current authoritative docs for the question (`docs/README.md`).
3. Trace the **production path** in code/config/schema, not just the module that
   appears to own the concept.
4. When the claim concerns behaviour of an installed agent, inspect available
   dogfood/runtime evidence: `~/.muffin`, database rows, traces, gateway/process
   state, real provider behaviour, or an explicit reproduction. The repository
   must never contain the owner's private state; record only redacted/aggregate
   evidence that is durable and useful.
5. State the measured failure or missing capability in one falsifiable sentence.

A mechanism already present in the tree is not evidence that production reaches
it. A document saying a problem exists is not evidence that the current build
still has it.

### B. Reconstruct the existing decision

Read the smallest set of current docs/ADRs needed to answer:

- what invariant were we trying to protect?
- what alternatives were rejected, and on what evidence?
- which assumptions were empirical and which were product choices?
- have model/runtime capabilities changed enough that an old harness assumption
  may now be dead weight?

Do not preserve an old decision merely because reversing it creates work.
Do not reverse it merely because a peer made a different trade-off.

### C. Compare peers by *problem*, not by brand

For agent-runtime work, inspect current primary sources/source code from relevant
systems. **Hermes Agent and OpenClaw are default peers, not sufficient peers.**
Choose additional systems that are strong on the subsystem under review.

Default comparison map:

| Domain | Start with | Add when relevant |
|---|---|---|
| agent loop / harness / hooks / guardrails | Hermes, OpenClaw, Claude Code/Agent SDK, OpenAI Codex/Agents SDK | LangGraph, OpenHands, Temporal/durable workflow systems |
| memory / user model / long-horizon recall | Letta, Mem0, Hermes, OpenClaw | LangMem, Zep, MIRIX/other evaluated memory systems |
| security / prompt injection / authority | CaMeL, Progent, Task Shield, OWASP guidance | OpenHands/Claude sandboxing, capability/DLP research |
| background work / processes / services | Hermes, Claude Code, OpenClaw | systemd/launchd, Temporal when durability semantics matter |
| multi-agent / delegation | Claude agent teams/Managed Agents, OpenAI/Codex patterns | AutoGen, LangGraph, peer systems with measured coordination |
| extensions / tools / MCP / skills | Claude Code, Hermes, OpenClaw, MCP primary docs | OpenAI Agents SDK, other plugin systems |

Do not copy framework architecture wholesale. Extract the primitive, invariant,
failure modes and measured trade-offs that map to Muffin.

### D. Challenge with external evidence

For a material design claim, search **both supporting and adversarial evidence**.
Prefer, in order:

1. current primary documentation/source code for what a system actually does;
2. peer-reviewed or primary research for empirical/scientific claims;
3. reproducible benchmarks/evals with disclosed methodology;
4. issue trackers/incidents for failure modes that polished docs omit;
5. secondary commentary only when it adds a perspective unavailable above.

For cognitive/memory claims, at least one source should challenge the proposed
mechanism or expose a competing explanation. A paper showing that a phenomenon
exists does not prove that Muffin's implementation of it is useful.

For harness claims, explicitly ask whether the mechanism compensates for a model
limitation that newer models may no longer have. Harness assumptions expire.

### E. Write the decision table before code

Before implementation, write down at least:

```text
measured Muffin failure / desired capability
current mechanism and invariant
candidate A: smallest local fix
candidate B: peer-inspired alternative
candidate C: remove/simplify the mechanism (when plausible)
evidence for each
counter-evidence / known failure modes
security/privacy/durability consequences
eval or observation that would falsify the chosen option
chosen claim and why
```

A real option must be allowed to win. “Keep the current architecture but rename
it” is not a challenge pass.

If evidence cannot distinguish the candidates cheaply, prefer an eval/experiment
that can. Do not settle an empirical question by prose.

## 3. Research artifacts and source of truth

Durable research goes under `docs/evidence/` as **dated evidence**.
It should include:

- question/decision it was commissioned to change;
- observed Muffin evidence and build/commit when relevant;
- peer systems and exact versions/commits/dates when material;
- primary research/docs links or identifiers;
- evidence supporting the current/proposed design;
- evidence against it or limitations;
- conclusion, uncertainty and the test/metric that could reverse it.

Research never becomes current architecture merely by being newer or longer.
If it changes the answer, update the authoritative current home named by
`docs/README.md`; if it changes rationale materially, add/supersede an ADR.

Avoid “research dumps”. Record claims and provenance, not a pile of links.

## 4. Domain-specific minimums

### Runtime / harness

Before adding orchestration, ask whether a stronger model plus a smaller harness
solves the measured failure. Compare lifecycle boundaries, context/session
separation, failure recovery and no-progress behaviour. Prefer primitives that
remain useful as models improve: session/event log, process, capability, hook,
checkpoint, sandbox.

### Security

Threat-model the actual data/control flow. Distinguish source provenance,
sensitivity, authority, control-flow influence and effect risk instead of
assuming one scalar captures all of them. Compare against a baseline with the
mechanism removed; security features that only reduce task success without
measurably reducing attacks are not automatically good security.

### Memory / person model

Separate at least: conversational history, episodic evidence, durable facts,
user model/profile, agent procedural notes and prospective intentions. Evaluate
**write quality and promotion**, not only retrieval. Include long-horizon evals
and negative evidence such as stale/self-generated/contradictory memory.

### Autonomous/background work

Distinguish a bounded background task from a durable service. Define ownership,
identity, logs, health, restart, timeout/TTL, cleanup, cancellation, permissions
and what survives a Muffin/gateway reboot before exposing a spawn primitive.

## 5. Implementation and verification

Only after the challenge pass chooses a falsifiable claim:

1. classify FAST / STANDARD / CRITICAL in `docs/development/ORCHESTRATION.md`;
2. create the narrow slice/branch;
3. implement the smallest architecture that proves the claim;
4. verify the outcome on the production path;
5. compare result against the pre-implementation baseline and kill criteria;
6. integrate and update only authoritative homes made stale.

For an experimental architecture, prefer feature flags/isolated seams and an eval
that can remove it. **Reversibility is a feature of research engineering.**

## 6. What “done” means

The research pass is complete when another competent agent can answer, without
reconstructing our conversation:

- what real Muffin behaviour motivated this work;
- which current code/path causes it;
- how relevant peers solve the same class of problem;
- what credible evidence supports and attacks our assumption;
- what alternatives were considered;
- what would make us reverse the choice;
- where the current decision and implementation truth live.

The standard is not consensus with the literature or peers. It is a decision
that has survived a serious attempt to disprove itself.
