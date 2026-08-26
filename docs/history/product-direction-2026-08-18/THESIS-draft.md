# Why this exists

Muffin is a personal agent you run yourself. This document is the argument for
why that is worth doing, and what it commits the design to. It is not a feature
list — those age. This is the part that has to survive the next five rewrites.

---

## 1. The bet

Everyone is going to have a personal AI agent. Not in ten years — in two or
three. They will talk to each other over open protocols. Apple, Google, Meta and
OpenAI are all building their version. That part is not a prediction, it is a
sector already in motion.

In that world:

- **Models are a commodity.** They are already close to interchangeable for this
  kind of work, and the gap keeps closing from below.
- **Agent architectures converge.** Tool use, memory, context assembly,
  planning, verification, modularity — every system that matures grows the same
  organs, because the problems are the same.
- **Protocols become standards.** Being early to one buys months, not years.
- **So the technology is not the advantage.** Neither is the scaffolding. If all
  you have is an architecture, you have something a well-funded team reproduces
  in a quarter.

The durable asymmetry an individual can hold is not simply "more personal data".
Large vendors may have access to enormous amounts of personal history and may be
excellent at personalization. The stronger asymmetry is:

> **sovereign, portable, high-quality continuity under individual control.**

The important claim is not that a vendor can never know you deeply. It is that a
vendor should not be able to *own the continuity itself*: who said what, what
changed, what remains due, what effects already happened, what the agent is
allowed to do, and how that history moves when the owner changes model, provider,
device or runtime.

That continuity belongs to the **agent**, not to a chat, a device, an app or a
model. Those are replaceable surfaces. The unit that persists is one agent with
one history, one identity, one set of commitments and one safety constitution.
Its product ambition is equally concrete: become the owner's primary interface
to the digital and physical world, so direct use of individual apps and devices
becomes the exception rather than the default.

## 2. The moat is continuity, not technique

The advantage is never going to be "I implemented yesterday's paper". It is
going to be a history that has accumulated **coherently**: evidence with
provenance, corrections instead of silent overwrites, work that did not vanish,
effects that can be accounted for, and an identity/constitution that survived
changes of brain and body.

Elapsed time still matters. Five years of interaction create sequences that no
single onboarding questionnaire reproduces. But "time passed" is not enough by
itself: old mail, chat archives, calendars, code history and platform exports can
legitimately accelerate cold start if imported with original provenance and
timestamps. The moat is therefore not artificial scarcity of history. It is the
**quality and ownership of the continuity built from that history**.

A fact like *"the owner works at X"* is not a moat — one conversation
reconstructs it. The sequence *"in November they were stuck on it, by January
they had solved it, by March they had moved on"* is more valuable because it
preserves change. More valuable still is knowing which part came from the owner,
which came from a third party, what Muffin inferred, what later contradicted it,
and what decisions or work followed.

The counterintuitive consequence:

> **Being ahead does not mean being ahead on technique. It means preserving
> continuity better while the technique changes underneath it.**

Chasing every new paper and rebuilding every six months is the wrong strategy if
it destroys that continuity. Replacing a harness component without touching the
canonical history is healthy and expected.

## 3. Canonical continuity and replaceable derivations

The old distinction "substrate versus harness" remains useful, but the substrate
is a **semantic contract**, not a particular SQLite schema or vector index.

### Canonical continuity — must survive

This includes the meaning-bearing records that cannot be casually regenerated:

- evidence and original source/provenance;
- episodes/events and their temporal position;
- owner corrections, supersessions and explicit decisions;
- identity and constitutional state;
- authority/grants and their history where required for governance;
- unfinished work and promises still due;
- effect intent/outcome records needed to know what happened;
- forget/tombstone intent needed to avoid resurrecting deleted material.

Rules:

- migrations preserve canonical meaning unless the owner explicitly asked to
  delete it;
- export/import must not depend on one embedding model or one physical schema;
- canonical data gets a long decision horizon;
- backups and recovery are product properties, not maintenance trivia;
- the owner can forget content: auditability is not a license to retain a
  payload forever against an explicit deletion request.

### Derived state — rebuildable

Embeddings, vector/FTS indexes, summaries, ranking state, activation, caches,
materialized views and beliefs that can be reconstructed from surviving evidence
are derived.

- Free to regenerate when models or representations improve.
- Versioned when their semantics matter during a migration.
- Never treated as the only copy of something irreplaceable.
- No architecture decision may make a pre-v1 vector extension the format of the
  owner's life.

### Harness — replaceable

Extraction pipelines, prompts, thresholds, weights, heuristics, retrieval
strategy, scheduler implementation, provider adapters and **the model itself**.

- Free to experiment on, rewrite, throw away.
- Every piece faces one test: *if the current model or a smaller primitive now
  does this well, is the code still earning its place?*
- It must age gracefully: isolated enough to replace without rewriting canonical
  continuity.
- No attachment. If it is scaffolding, it is temporary by definition.

**This distinction decides whether experimenting is a risk or an opportunity.**
Experimenting in derived state and harness is healthy. Experimenting with the
meaning of canonical continuity is controlled trauma: rare, explicit and tested
through migration/export rather than protected by fear of change.

## 4. Three axes, one continuous agent

A personal agent exists on three equal axes.

It is a **real agent** — it does actual work, autonomously, over long horizons.
Deep research across many steps. Managing mail and a calendar. A loop that
spends an hour fixing an inbox. Work on the machine itself: a real filesystem,
sandboxed execution, presence at the level of the operating system.

It **understands** — it observes patterns, holds a point of view, and can
occasionally tell you something about yourself you had not said out loud.

And it is **present** — it remains reachable while work is in flight, keeps an
honest account of what the world and the work are waiting on, resumes after
interruptions, and knows when to wait, stay silent, interrupt, ask, revise or
abandon. Presence is not a typing indicator or a daemon by itself. It is the
combination of durable state and judgement about when action is warranted.

None serves the others. Doing is not in service of understanding; understanding
is not decoration on doing; presence is not activity for its own sake. An agent
that executes and nothing else is a tool. One that understands but cannot stay
with unfinished work is a session. The object this project is building does the
work, understands the owner, and remains present across sessions and surfaces.

Concretely: no document in this project may be used to argue against autonomous
work the agent can do safely. The gate is never the ambition or the duration of
the work. The gate is the **outward and irreversible boundary** — sending,
spending, deleting toward the outside world — and **safety**: OS-level
containment, explicit authority and provenance carried on untrusted content.
Inside those limits it acts as a full agent.

## 5. Operating principles

1. **Canonical continuity does not break.** Any decision that could corrupt or
   silently reinterpret it gets its own thread, never a quick merge.
2. **The harness breaks freely.** Build it, try it, throw it out. Zero
   attachment.
3. **Continuity beats speed.** A month of the agent running imperfectly teaches
   more than a week of a perfect architecture that is then replaced without
   preserving what mattered.
4. **Controlled experimentation.** New papers are welcome in the harness and
   derived state. If they change canonical semantics, the gate is severe.
5. **Real use beats real design.** Use it before it is ready. Use reveals the
   problems design cannot see and produces the interactions from which real
   priorities emerge.
6. **Capability and understanding, at par.** Adding capability at random is
   still wrong. Adding the capability the owner actually needs is core to the
   product, even when the implementation lives outside the core package. The
   filter is not "doing versus understanding" — it is "does the owner need it,
   and does it let the same continuous agent replace another direct interface?"
7. **Infer preferences; declare governance.** Taste, cadence and working style
   can be learned from use. Constitutional limits, budgets and safety policy are
   explicit and inspectable; the agent never infers permission to weaken them.
   A settings screen should not replace learning, and learning must not replace
   governance.
8. **Autonomy is earned in scopes, never granted as trust.** Repeated safe,
   reversible outcomes may compress supervision for the same capability,
   resource and context. That grant is observable, revocable and able to regress
   after failure. There is no global trust score, and the model never decides its
   own safety boundary.
9. **Data sovereignty is non-negotiable; compute placement is an owner choice.**
   Muffin stays local-capable, but a frontier API is not a moral failure or a
   hidden exception. A remote provider is privileged compute **and an egress
   destination**: the owner must know what context can go there, be able to keep
   classes of data local-only, and optionally apply local privacy transforms.
   The provider is replaceable. The continuity is not.
10. **Separate who the owner is from who has owner authority.** The person's
    history, character and preferences live in accumulated data, never in code.
    Authority is the opposite: each surface binds the owner explicitly to a
    transport-authenticated, stable opaque subject identifier. A display name,
    biography, username, room, image or message can describe a person; none can
    make that person the owner. The agent's constitutional identity is different
    again: explicit, versioned and never learned away.
11. **Surface-agnostic.** A terminal, phone, speaker, pendant or future device is
    a port onto the same agent. A new surface may declare different delivery and
    input capabilities; it may not fork identity, memory, work or policy.
12. **Input-agnostic does not mean input-trusting.** New sources must not each
    require a bespoke cognitive path. Every accepted ingress is first parsed
    into typed content blocks with provenance and taint; unsupported material is
    quarantined or rejected explicitly. Message text, names, biographies,
    filenames, metadata, images, audio and extracted text are all data that may
    contain prompt injection. Parsing makes the boundary explicit; it does not
    make the content safe. The model does the understanding at the point of use
    and the kernel continues to decide effects from facts the content cannot
    rewrite.
13. **Proprioception before power.** A system that does not know whether it is
    working does not get powerful tools. Knowing its own state — traces,
    self-inspection, verification of what it holds — is a permanent priority
    rather than a phase that closes. This is not an argument against giving an
    agent hands; it is the order in which hands are earned.
14. **Core narrow, capability surface wide.** The core owns durable contracts
    and safety semantics, not every platform use case. Gmail, Home Assistant,
    Spotify, privacy transforms or future services may be optional extensions.
    An extension package can provide several capabilities, but each capability
    remains a separate unit of authority. Installing breadth must not silently
    expand the trusted core or grant everything the package asks for.

## 6. Known tensions

These are not bugs waiting to be fixed. They are permanent tensions in the shape
of the thing, and naming them means not being surprised when they return.

**Wanting to be ahead, versus continuity beating experimentation.** The instinct
is to implement the new technique. The discipline is to experiment in the
harness and derived representations while keeping canonical meaning portable —
and every interesting paper brings the temptation back.

**A mirror is pointed by someone.** The owner decides what the agent observes,
how it interprets, what counts as relevant. A mirror you aim yourself cannot
show you your real blind spots. Third-party inputs — other people's words,
objective data from a calendar or a repository — attenuate this. They do not
solve it. It is a structural limit of the category, and it deserves watching
rather than a claim that it is handled.

**A single-user system can become an amplifier.** It observes one person,
accumulates about one person, answers to one person. The failure mode is that it
learns to agree. Partial mitigations exist — deliberate silence, explicit
counterpoint, external inputs — and none of them is a guarantee.

**Proactivity versus background noise.** The useful band is narrow. Slightly too
much and it becomes something you learn to ignore, which is worse than silence.
Slightly too little and it is inert. That calibration is not found in a lab. It
is found in use, and it needs redoing periodically.

**Presence versus interruption.** A continuous agent has more opportunities to
get in the way. Waiting, silence, deferral, refusal, revision and cancellation
are therefore first-class capabilities, not weaker versions of acting.

**Earned autonomy versus a tired confirmation habit.** Repeating the same safe
approval forever makes the boundary ceremonial; removing it because the agent
"knows the owner" makes it arbitrary. The only acceptable compression is local
to a demonstrated pattern, reversible where possible, visible and able to
regress.

**Genuine insight versus confirming what you already knew.** After enough
months, a dataset can confirm known patterns with increasing precision — low
marginal value — or produce something genuinely new. Most architectures are
better at the first. Being good at the second is an open problem, not a solved
one.

**Harness that ages gracefully versus harness that is needed today.** Some of
the code that exists is exactly the kind a more capable model makes redundant.
Writing it so it is *easy to delete* is the actual work; tangling it into
everything else produces debt that only hurts on the day you decide to remove
it.

**A wide ecosystem versus a small trusted base.** Community extensions make the
agent useful in more lives. Every executable extension also creates a new supply
chain and authority boundary. Discovery, publisher identity and popularity
cannot become synonyms for trust; requested authority stays explicit and local.

## 7. What this is not

It is not a productivity optimizer — not because it refuses productive work, but
because task throughput is not the purpose of the relationship. It may still
manage mail, calendars, files or long-running work when that lets the owner stop
operating those interfaces directly.

It is not a hosted multi-tenant personal assistant by default. One logical
Muffin belongs to one owner and keeps its durable substrate under that owner's
control. A hosted multi-tenant offering would be a different product with a
different threat model and economics.

It is not a framework that treats every integration as core. The project can be
open source and community-extensible while keeping the runtime constitution
small and making optional capability packages truly optional.

And it is not data-driven development. Here personal data is part of the
product, not the requirement. Whether the agent is *good* is a qualitative
judgement and always will be. What gets measured is whether it is *broken*,
whether continuity survives change, and whether the properties we claim are
actually observable — a different question, and one this repository takes
seriously because the characteristic failure of this kind of system is damage
that reports success. See `docs/lessons.md`.

The thesis is falsifiable in use. If continuity does not survive replacing the
model or moving between surfaces, it is not continuity. If months of operation
do not let the owner stop opening any direct interface without losing control,
the project is accumulating data without becoming the agent described here.