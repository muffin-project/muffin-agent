# Why this exists

Muffin is a personal agent you run yourself. This document is the argument for
why that is worth doing and what it commits the design to. It is not a feature
list. Features age; this is the part that should survive the next five rewrites.

---

## 1. The bet

Everyone is going to have a personal AI agent. Models, tool use, memory,
browsing, scheduling, multimodality and agent-to-agent protocols are all
converging quickly. Large vendors can already combine enormous amounts of
personal data with frontier models.

So Muffin's durable advantage cannot be:

- having memory while incumbents do not;
- being self-hosted while no other agent is;
- implementing a particular paper, protocol or agent loop first;
- owning a larger checklist of integrations.

The durable bet is narrower and harder:

> **quality, ownership and portability of personal continuity.**

Continuity means more than remembering facts. It is the accumulated sequence of
what happened, who said what, what Muffin inferred, what changed over time, what
is still owed, what may have been done to the world and which authority the
agent currently holds.

That continuity belongs to the **agent**, not to a chat, device, app, model,
provider or process. Those are replaceable surfaces and compute.

The product ambition follows from that unit: one personal agent becomes the
owner's primary interface to the digital and physical world, so direct use of
individual apps and devices becomes the exception rather than the default.

## 2. The moat is continuity, not technique

Technique is necessary and temporary. Better models, retrieval methods,
protocols and runtimes will keep arriving. Muffin should absorb good prior art
without confusing technical novelty with durable differentiation.

Raw personal data is not enough either. A single fact can often be reconstructed
in one conversation. What is difficult to reproduce is the **history with
meaning**:

- in November this was blocked;
- in January the owner changed their mind;
- in March the project disappeared from conversation;
- this claim came from the owner, that one from a third party, and this one was
  Muffin's own inference;
- this task is still open because a dependency never arrived;
- this effect may already have happened before a crash.

Time actually lived cannot be downloaded later. But accumulation only becomes a
moat if its structure stays trustworthy and portable.

Therefore:

> **Being ahead means accumulating continuity that survives replacement, not
> accumulating implementation.**

The strongest version of the product should be able to change model, provider,
device, runtime and physical representation without becoming a different agent.

## 3. Three strata with different governance

Muffin separates continuity-bearing state, derived representations and the
replaceable harness.

### Canonical continuity — preserve the meaning

Canonical state is the information whose loss would change what Muffin knows,
what it owes, what it has done or what it is allowed to do.

This includes, according to the architecture:

- source evidence and provenance;
- identity and constitutional authority;
- unfinished work and stable occurrence identities;
- effect intent/outcome state required to avoid lost or duplicated action;
- deliberate corrections, retirements and future forget/delete semantics.

Canonical does **not** mean "this exact SQLite schema is immortal". Physical
representation may migrate. The requirement is that the meaning survives.

Changes that can destroy canonical state are expensive, tested and reversible.
Backups and migration discipline are not optional.

### Derived representations — rebuild them

Embeddings, vector indexes, FTS indexes, generated profiles, summaries, digests,
ranking caches and materialized views are useful representations of canonical
state. They are not the identity of the memory system.

A future model or retrieval strategy must be free to discard and regenerate
these without pretending a person forgot their history.

### Harness — replace it freely

Prompts, extraction pipelines, thresholds, retrieval strategies, provider
adapters, schedulers, execution workers and **the model itself** are harness.

They should be modular, inspectable and deletable. Every cognitive mechanism
faces two questions:

1. Is the problem real here, now?
2. If a well-contextualized current model can already do it better, is the code
   still earning its place?

Experiment aggressively in the harness. Do not make canonical continuity pay
for those experiments.

## 4. Three axes, one continuous agent

A personal agent exists on three equal axes.

It **does** — real work, including multi-step and long-running work, through
actual capabilities and services.

It **understands** — it accumulates evidence and beliefs over time, preserves
provenance and contradiction, and can develop a useful point of view rather
than merely replaying facts.

It is **present** — unfinished work survives sessions and processes; it can wait,
resume, remain reachable, know what is still owed and judge when to act, ask,
revise, interrupt or stay silent.

None is decoration on the others. An executor with no point of view is a tool. A
memory system that cannot act is a notebook. A capable assistant whose work
disappears at the end of a session is not continuous.

Presence does not mean constant activity. Silence is a first-class outcome.

## 5. An agentic system, not a model in a loop

Muffin is not "a model that chats, plus storage". It is an **agentic system**:
agent = model + harness, where the model is replaceable compute (§3) and the
harness is a set of organs whose **relations** carry the design — memory,
idle-time consolidation, scheduling and presence, surfaces, the policy kernel.
Systems theory applies: an operation on one organ silently reaches the others,
so every operation must be named by what it actually touches. A "new
conversation" is a *context* operation; it must not sever the learning
pipelines, obligations or scheduled work that live outside any one session.

Two consequences the current state of the art (2026) makes concrete. They are
dated on purpose: re-verify them against the field before building on them
again.

- **Identity is pre-loaded; retrieval serves the long tail.** What the agent
  must never fail to know about its owner is carried in context
  unconditionally (core memory); similarity retrieval serves the unbounded
  rest (archival). An agent that asks its owner's name is failing at the
  system level even when the fact sits in storage. And because
  always-in-context memory is permanent prompt surface, writing to it is a
  privileged act: only owner-grade provenance may pin, and deliberate
  correction must beat pinning.
- **The killer of long-running agents is context drift, not context
  exhaustion.** A context slowly filling with stale frames does more damage
  than a context running out. Compaction is therefore routine — and a wrong
  summary is silent damage, so compaction is validated against the trajectory
  it claims to compress, not merely produced. Idle-time consolidation is this
  system's sleep: the pipeline that turns lived turns into durable memory runs
  between conversations, not inside them.

## 6. Operating principles

1. **Continuity does not break accidentally.** No rewrite, model upgrade or
   storage change gets to reset canonical state as a convenient recovery path.
2. **Derived state and harness are replaceable.** If they can be reconstructed,
   do not protect them as if they were the person.
3. **Real use beats speculative design.** Dogfood exposes failures that diagrams
   cannot; use should drive the next primitive after the initial safety floor.
4. **Capability and understanding are peers.** Adding capability at random is
   wrong; adding a capability that replaces a direct interface the owner still
   has to operate is product progress.
5. **Infer preferences; declare governance.** Taste and working style may be
   learned. Constitutional limits, budgets and authority are explicit and
   inspectable.
6. **Autonomy is earned in scopes, never granted as global trust.** Repeated safe
   outcomes may compress supervision for the same capability/resource/context.
   Grants are observable, revocable and able to regress after failure.
7. **Data sovereignty is non-negotiable; local inference is optional.** The owner
   controls the durable state. A cloud model may be configured as replaceable
   compute, but it is also a privileged data recipient and that fact must remain
   explicit. Local-capable paths should remain possible rather than being
   architecturally burned away.
8. **Separate identity from authority.** History and preferences describe the
   owner; transport-authenticated principal bindings confer authority. A name,
   biography, filename or quoted message can never make someone the owner.
9. **Surface-agnostic.** Terminal, Telegram, desktop, speaker, pendant or future
   device are ports onto the same agent. They may differ in transport and
   rendering; they may not fork identity, memory, work or policy.
10. **Input-agnostic does not mean input-trusting.** New sources enter as typed
    content with provenance/taint where knowable. Parsing makes boundaries
    explicit; it does not make adversarial text safe.
11. **Proprioception before power.** A system that cannot tell whether it worked
    should not receive more authority. Traces, self-inspection and falsifiable
    acceptance are permanent parts of the design.
12. **Core stays narrow; capability grows at the edges.** The core owns
    continuity, authority and boundaries. Gmail, browser control, Home Assistant,
    privacy filters and future services should be installable capabilities, not
    permanent growth of the trusted core.
13. **Central infrastructure may simplify birth; it must not be required for
    life.** Downloads, discovery, OAuth bootstrap or provisioning may be
    centralized. The running agent's identity, memory and work should not depend
    on a Muffin-operated SaaS remaining online.

## 7. Birth, forgetting and lineage

Continuity requires a beginning. It does not require every predecessor to be
retroactively reinterpreted as native state.

The current rebuild is a new generation of Muffin with **fresh native memory**.
The old Muffin remains its project/identity lineage and an optional legacy
archive, but the new agent is not required to import the old database into its
new evidence/belief semantics. See ADR-0049.

From the new generation's first native evidence onward, resets are not a normal
migration strategy.

At the same time, "continuity" must not become "the owner can never forget
anything". A personal agent eventually needs deliberate correction, retirement,
retention and deletion semantics. Append-oriented evidence is useful for
provenance; accidental immortality of every byte is not a product principle.

The distinction is:

- **no accidental reset or silent data loss**;
- **deliberate owner-controlled forgetting may exist and must be semantically
  explicit**.

## 8. Known tensions

These are structural tensions, not TODOs that disappear after one implementation.

**Accumulation versus experimentation.** The instinct is to implement the new
technique. The discipline is to experiment in harness/derived state while
protecting continuity-bearing meaning.

**Personalization versus amplification.** A system trained on one person's life
can become very good at agreeing with that person. External evidence,
provenance, contradiction and deliberate counterpoint help; none is a complete
solution.

**Proactivity versus noise.** Slightly too much and the agent becomes something
the owner learns to ignore. Slightly too little and it becomes inert. Useful
proactivity must be calibrated in real use, and silence remains the default when
there is no specific reason to interrupt.

**Earned autonomy versus confirmation fatigue.** Repeating the same harmless
approval forever turns safety into ritual; removing it because "Muffin knows me"
turns safety into vibes. Compression must be local, evidenced and reversible.

**Insight versus confirmation.** A long dataset can become excellent at
confirming known patterns without producing new insight. Genuine interpretation
that survives challenge is an open problem and should be measured rather than
assumed.

**A narrow core versus an ambitious product.** The owner should be able to add
many capabilities without every capability becoming permanent trusted core.
Extension governance therefore matters as much as extension count.

## 9. What this is not

It is not a framework looking for users. The primary product is one Muffin per
owner; a hosted multi-tenant runtime would have a materially different trust and
data model.

It is not a claim that self-hosting alone creates a moat. Other personal agents
can be self-hosted too.

It is not a claim that one memory architecture is permanently correct. The
continuity substrate must be able to outlive today's retrieval design.

And it is not a promise that the current implementation already satisfies every
sentence above. Current architecture is mapped in `docs/ARCHITECTURE.md`; current
security boundaries in `docs/SECURITY.md`; DAY-1 proof status in
`docs/blueprint/M5-BIS.md`.

The thesis is falsifiable in use. If changing model or surface changes who the
agent is; if accumulated history cannot survive a harness rewrite; or if months
of operation do not let the owner stop directly operating meaningful interfaces
without losing control, Muffin is accumulating machinery rather than building
the agent described here.