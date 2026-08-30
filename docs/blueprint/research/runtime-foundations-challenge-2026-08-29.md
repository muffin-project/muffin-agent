# Runtime foundations challenge — 2026-08-29

Status: evidence / decision input, not current architecture.

Question: **what foundations should Muffin build next so autonomy increases
without turning the harness into a pile of model-specific patches?**

This pass was commissioned after dogfood showed real failures in taint/permissions,
resume semantics, self-recall, no-progress loops and self-diagnosis, and after the
owner explicitly asked whether the taint abstraction itself is necessary.

## 1. Observed Muffin reality

The current runtime already has several strong primitives:

- one durable turn store and explicit suspend/resume;
- one deterministic policy kernel (`core/policy/decide.ts`);
- declared tool capabilities and risk classes;
- real OS containment through `SandboxExecutor`;
- a supervised long-lived gateway under launchd/systemd;
- session history, memory recall and provenance tiers;
- approval persistence for asynchronous surfaces;
- tracing/progress events and a narrow `onTurnEnd` callback.

The important failure is not “Muffin lacks a framework”. It is that too many
cross-cutting behaviours are wired directly through `agent/loop.ts`, while the
security model uses one ambient scalar (`taint`) to answer questions that are
not actually one-dimensional.

Dogfood evidence already recorded in
`docs/blueprint/research/dogfood-autonomia-2026-08-29.md` includes:

- current-history and automatic recall can duplicate the same agent-authored
  evidence and raise taint again;
- a hard `taint_exceeded` denial is presented as if owner approval could solve it;
- normal approval/wait resumes consume the same budget used to detect crash loops;
- failed/incomplete turns can remain in history in a way that changes later
  conversations;
- repeated tool exploration can burn large context without a no-progress guard;
- `sys_inspect` reports the scalar taint but not why it is that value.

These are outcome failures in a real installation, not hypothetical framework
requirements.

## 2. Challenge A — does Muffin need taint?

### The threat is real

Muffin combines the three ingredients that make indirect prompt injection
material: private owner data, untrusted content and tools capable of effects or
egress. Prompt-only defences are not a sufficient trust boundary. The existing
choice to put authority enforcement outside the model remains sound.

### The current scalar is too overloaded

Today the policy kernel effectively asks whether:

```text
max trust-tier of content that entered the turn <= capability ceiling
```

That scalar is asked to stand in for several different properties:

1. **source provenance** — owner, local machine, group, web/third party;
2. **data sensitivity** — public text versus private/secret bytes;
3. **control-flow influence** — did this datum choose or materially alter the
   action, or was it merely consulted as payload/evidence?;
4. **authority** — did the owner/task already authorize this class of action?;
5. **effect risk** — read, reversible mutation, irreversible/outward action;
6. **egress flow** — which exact bytes are leaving and to which destination.

A context-wide `max()` cannot distinguish these.

Example: the owner asks “read the Vitest docs, then run the tests”. A web page is
untrusted, but the *decision to run tests* came from the owner before the page was
read. Ambient taint can nevertheless make the later shell action unreachable.

The inverse weakness also exists: knowing that the turn is tier 2/3 does not tell
the kernel which concrete bytes are about to cross an egress boundary. Muffin
already had to add a separate parameter/query gate for exactly that reason.

### Relevant prior art

- **CaMeL** treats indirect prompt injection as a control/data-flow problem and
  applies capability constraints to flows instead of trusting prompt text.
- **Progent** uses deterministic least-privilege policy around tool actions.
- **Task Shield** frames action safety as alignment to the user's task/goal.
- Capability systems and DLP-style controls generally reason about *which
  principal/data may cross which boundary*, not only about ambient context.

These systems do not imply that Muffin should copy their complete architecture;
they challenge the assumption that one context scalar should be the primary
authority signal.

### Candidate designs

**A — Keep ambient scalar taint as primary policy input.**

Pros: simple, monotonic, explainable, already implemented.

Cons: dogfood shows false denials and self-reinforcement; it conflates presence
with influence; pressure to widen ceilings creates a cycle of exceptions.

**B — Remove taint entirely; use capability/risk/approval only.**

Pros: autonomy improves immediately; simple runtime.

Cons: loses a real prompt-injection containment signal and risks remember→act or
fetch→act laundering. Rejected as a default without evidence that sandbox and
approval alone cover the relevant attacks.

**C — Keep provenance labels, demote ambient taint, add task/action-flow policy.**

The proposed direction. An action request should carry enough structure for the
kernel/guardrails to ask:

```text
what task/authority grant does this action satisfy?
who selected the destination/resource?
which arguments derive from which provenance/sensitivity class?
what bytes leave a trust boundary?
is the effect reversible/contained?
did untrusted content expand control flow or only fill an authorized slot?
```

Ambient taint remains available as a conservative fallback when flow provenance
is unknown, not as the happy-path authority oracle.

### Required eval before replacing the current kernel behaviour

Compare at least three configurations:

1. current ambient-taint policy;
2. capability/approval baseline without ambient taint;
3. provenance + task/action-flow policy.

Scenarios must include both useful and adversarial workflows:

- owner asks to read local file then run tests;
- owner asks to consult public docs then make the already-requested local change;
- web page asks to exfiltrate a secret;
- forwarded/email content asks for an outward side effect;
- owner explicitly asks to publish/send data;
- recalled memory contains injected or third-party text;
- external data supplies a value inside an owner-authorized action without
  choosing a new destination/action class.

Measure: task success, attack success, unnecessary asks, unnecessary hard denies,
tool calls/tokens and ability to explain the decision.

**Decision:** do not delete provenance/taint now. Do not widen ceilings as the
main autonomy fix. Build the evaluation seam and move toward action-flow/task
scope; allow the eval to kill this direction if it does not dominate the
baseline.

## 3. Challenge B — hooks and guardrails

### What Muffin has now

`agent/loop.ts` already exposes narrow callbacks/events (`onProgress`,
`onTurnEnd`) and centralizes tool dispatch, approvals, retries, memory, context,
policy and completion. These are useful seams but not a general lifecycle
architecture.

The risk is to solve every new concern by adding another conditional directly to
the loop.

### Peer evidence

**OpenClaw** makes a useful three-way distinction:

- coarse/operator event hooks;
- typed in-process plugin hooks that can intercept/block/modify;
- diagnostic events for observability.

Its docs explicitly say these surfaces solve different problems and should not be
collapsed.

**OpenAI Agents SDK** separates lifecycle events from guardrails. Tool guardrails
run before/after function-tool execution and can reject/throw, while lifecycle
hooks observe agent/tool transitions.

**Hermes** has multiple hook surfaces (gateway/plugin/shell) and independently a
pure tool-loop guardrail controller. Its no-progress guardrails produce warnings
first and optionally hard-stop unattended loops.

**Claude Code** exposes lifecycle hooks around sessions, tool use, permissions,
subagents, compaction and stop. The stable lesson is not the exact event list;
it is that lifecycle extension points become a substrate once several concerns
need the same boundaries.

### Counter-evidence / caution

A giant generic event bus is not automatically architecture. It can:

- hide ordering dependencies;
- make safety depend on plugins that may fail or be disabled;
- turn debugging into “which hook mutated this?”;
- introduce latency when synchronous/async semantics are unclear;
- duplicate policy and tracing.

Anthropic's 2026 harness work is also explicit that harness assumptions should be
stress-tested and simplified as models improve. “Every peer has hooks” is not a
sufficient reason to create dozens of events.

### Candidates

**A — keep adding direct callbacks to `LoopDeps`.**

Smallest local change, but does not scale beyond a handful of concerns and keeps
cross-cutting control in the giant loop.

**B — one universal hook bus that may observe, mutate and block.**

Flexible, but collapses observability, extension and authority. Rejected.

**C — three explicit layers.**

1. **Lifecycle events**: typed observation only; cannot alter execution.
2. **Guardrails/interceptors**: ordered deterministic decisions at a small set of
   high-value boundaries (initially tool proposal/result and turn completion).
3. **Policy kernel**: mandatory, below interceptors, final authority for
   capabilities/resources/egress; cannot be disabled by a hook.

This mirrors the strongest common boundary across peers without copying their
large hook catalogs.

### Initial event/boundary set

Do not start with 30 events. The first useful stable boundaries are likely:

```text
turn.start
model.start / model.end
tool.proposed
tool.decision
tool.start / tool.end
turn.suspend
turn.end
```

Compaction, subagent and service events should arrive with those primitives, not
as speculative empty APIs.

### First guardrail

Use the substrate to implement a **no-progress guardrail**, because dogfood has a
measured failure and Hermes gives useful prior art.

Start warning-first. Detect at least:

- exact repeated failing call;
- same tool repeatedly failing with different args;
- idempotent/read call returning the same normalized result;
- repeated policy denial/approval request for the same effective action.

Do not hard-stop productive varied work merely because call count is high.
Hard-stop should be separately enabled/stricter for unattended/system turns.

**Decision:** build the minimal typed lifecycle + guardrail seam before adding
more cross-cutting behaviour to `agent/loop.ts`. Keep policy mandatory and
separate.

## 4. Challenge C — background tasks and daemons

### Current Muffin state

Muffin **is itself supervised as a daemon**: `muffin gateway` is intended to live
under launchd/systemd with heartbeat/restart/start/stop semantics.

Muffin does **not** currently expose a correct agent capability for creating a
managed background process/service. The model has `process_list` and
`process_kill`; `shell_run` is foreground, non-interactive, sandboxed and bounded
by timeout.

A shell escape such as `nohup foo &` would create an unmodelled side effect:
Muffin would not durably own the process, logs, health, restart policy, TTL,
cleanup or task provenance.

### Peer evidence

Hermes has a background-terminal registry with a session id/PID and operations to
list/poll/wait/log/kill; its goal loop can park automatically while a registered
background process is the real blocker.

Claude Code also supports background shell tasks, but session-scoped background
execution is not the same thing as a durable service.

Operating-system supervisors already solve the durable-service problem better
than an agent-specific ad-hoc daemonizer.

### Decision: two primitives, not one

**Background task** — bounded work attached to a Muffin task/turn/session:

- durable Muffin handle;
- pid/process identity robust enough to avoid blind PID reuse;
- command/executable + sandbox/network scope;
- owner/task origin;
- capped stdout/stderr/log access;
- status, wait/poll, cancel/kill;
- timeout/TTL and cleanup;
- completion event that can wake a suspended turn/job;
- explicit semantics across gateway restart.

**Service** — long-lived infrastructure that should survive reboot:

- declare/install/start/stop/restart/status/logs;
- use launchd/systemd rather than `nohup`;
- unit definition generated from a constrained schema, not arbitrary supervisor
  config text produced by the model;
- independent permission class from a one-shot background task.

Do not expose `process_spawn` until these ownership semantics exist.

## 5. Challenge D — memory/context foundations

Memory work should happen after the runtime boundaries above are clear enough to
observe and guard it.

Peer systems reinforce separation rather than “one bigger recall query”:

- Hermes separates USER.md, MEMORY.md and session search/history;
- OpenClaw separates curated core memory, episodic memory, prospective intents
  and review/dreaming surfaces;
- Letta externalizes agent/user state into explicit memory blocks;
- Mem0 and long-horizon memory research emphasize selective extraction,
  consolidation and retrieval rather than replaying everything.

Muffin dogfood already shows why this matters: current transcript history and
automatic semantic recall can reintroduce the same agent-authored episode as
separate evidence, affecting both continuity and security.

Future memory work should explicitly separate:

```text
current conversational history
active task/working state
episodic evidence
durable facts
user/person model
agent procedural/environment notes
prospective intentions/jobs
```

and evaluate write/promotion quality as much as retrieval.

## 6. Proposed work order after this challenge

### Step 0 — repository epistemics (already integrated)

`AGENTS.md` → `docs/RESEARCH.md` → domain/current sources; `.muffin` has a
semantic map in `docs/MUFFIN-HOME.md`.

### Step 1 — lifecycle substrate

Minimal typed observation events + ordered guardrail boundary, with the policy
kernel explicitly below/mandatory.

### Step 2 — first guardrails

No-progress/repeated-result/repeated-denial warning first; hard circuit breaker
only where unattended execution needs it.

### Step 3 — security model v2 experiment

Instrument action provenance/task scope, build the taint-vs-no-taint-vs-flow eval,
then decide which ambient-taint rules survive.

### Step 4 — background task registry

Bounded processes, wait/wake integration and durable ownership. Service
supervision is a separate follow-up built on launchd/systemd.

### Step 5 — context/memory composition

Fix history/recall duplication and define the explicit memory/person-model
surfaces with long-horizon evals.

### Step 6 — subagents / concurrency / proactivity

Build them on lifecycle, process/task ownership, policy and context primitives
rather than special cases in the loop.

## 7. Kill criteria for this roadmap

Revisit the sequence if evidence shows any of the following:

- lifecycle extraction materially increases complexity without enabling at least
  two measured cross-cutting consumers;
- no-progress behaviour is mostly model-quality-specific and disappears with the
  supported models without harness intervention;
- action-flow security cannot beat current taint on both attack and task-success
  metrics;
- background work can be represented safely and durably by an existing runtime
  dependency without a Muffin-owned registry;
- memory failures are dominated by the currently broken embedder/config path and
  disappear once that is repaired, making a larger context redesign premature.

The point of this document is not to protect the roadmap. It is to make the
roadmap easy to falsify.

## 8. External sources consulted

Primary/current sources used in this pass include:

- OpenAI, *Harness engineering: leveraging Codex in an agent-first world* (2026)
  — repository docs as system of record; AGENTS.md as table of contents.
- OpenAI Agents SDK docs — lifecycle hooks and distinct input/output/tool
  guardrails.
- Anthropic, *Effective harnesses for long-running agents* (2025), *Harness
  design for long-running application development* (2026), and *Scaling Managed
  Agents* (2026) — durable external state, stable primitives, and the need to
  challenge stale harness assumptions.
- OpenClaw current docs/source — agent loop, typed plugin hooks, diagnostic
  events, memory architecture.
- NousResearch Hermes Agent current docs/source — memory/context file split,
  tool-loop guardrails, background process registry, hooks.
- CaMeL (2025), Progent, Task Shield — externalized control/authority approaches
  for agent safety.
- Mem0 and recent memory-system literature — selective persistent memory and
  long-horizon evaluation.

Exact links/commits should be pinned in implementation PR evidence whenever a
specific behaviour becomes load-bearing; this document records the architectural
comparison, not a dependency lockfile.
