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

The durable asymmetry an individual can hold against companies with unlimited
capital is:

> **continuity of a deep dataset under individual control.**

A vendor cannot know you the way an agent you run yourself can. Not because
their engineers are worse, but because they operate under aggregate privacy,
retention policy, and a product surface that has to work for a hundred million
people. The limit is structural rather than temporary — which is what makes it
a foundation to build on instead of a head start you eventually lose.

That continuity belongs to the **agent**, not to a chat, a device, an app or a
model. Those are replaceable surfaces. The unit that persists is one agent with
one history, one identity, one set of commitments and one safety constitution.
Its product ambition is equally concrete: become the owner's primary interface
to the digital and physical world, so direct use of individual apps and devices
becomes the exception rather than the default.

## 2. The moat is continuity, not technique

The advantage is never going to be "I implemented yesterday's paper". It is
going to be "there are five years of continuous, coherently structured data
here, and nobody can reproduce it, because reproducing it requires having lived
those five years."

The counterintuitive consequence:

> **Being ahead does not mean being ahead on technique. It means being ahead on
> accumulation.**

Chasing every new paper and rebuilding every six months is the *wrong* strategy
in this game. It is precisely what large players do better, and it produces a
fragmented dataset that loses value at every rewrite.

And raw data is not the moat either. A fact like *"the owner works at X"* is
not a moat — one conversation reconstructs it. The **sequence** — *"in November
they were stuck on it, by January they had solved it, by March they had moved
on"* — cannot be reconstructed at all. It requires time that actually passed.

What follows from this is the most useful idea in this document.

## 3. Two layers with opposite governance

Everything in the system belongs to one of two layers, and they are governed by
opposite rules.

### The data substrate — immortal

The schema, the accumulated content, the embeddings, the identity files that
persist across every version.

- Every schema change is a traumatic event, planned carefully.
- Migrations preserve data. They never drop it.
- The dataset grows monotonically and is never reset.
- Backups are religious.
- Decision horizon: five years and up.

### The harness — replaceable

Extraction pipelines, prompts, thresholds, weights, heuristics, retrieval
strategy, the scheduler, and **the model itself**.

- Free to experiment on, rewrite, throw away.
- Every piece faces one test: *if the current model already does this by itself,
  is the code still earning its place?*
- It must age gracefully: modular, isolated, removable without touching the
  substrate.
- No attachment. If it is scaffolding, it is temporary by definition.

**This distinction is what decides whether experimenting is a risk or an
opportunity.** Experimenting in the harness is healthy, necessary, continuous.
Experimenting in the substrate is controlled trauma: rare, planned, reversible.

When you cannot tell which layer something belongs to, the test is:
**if removing it deletes accumulated data, it is substrate.**

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
sandboxing, and provenance carried on untrusted content. Inside those limits it
acts as a full agent.

## 5. Operating principles

1. **The dataset does not break.** Any decision that could compromise it gets
   its own thread, never a quick merge.
2. **The harness breaks freely.** Build it, try it, throw it out. Zero
   attachment.
3. **Continuity beats speed.** A month of the agent running badly beats a week
   of it running perfectly before you rewrite it.
4. **Controlled experimentation.** New papers are welcome in the harness. If
   they want to touch the substrate, the gate is severe.
5. **Real use beats real design.** Use it before it is ready. Use produces the
   dataset and reveals the problems design cannot see.
6. **Capability and understanding, at par.** Adding capability *at random* is
   still wrong. Adding the capability the owner actually needs is core, not
   periphery. The filter is not "doing versus understanding" — it is "does the
   owner need it, and does it move this closer to something with a point of
   view".
7. **Infer preferences; declare governance.** Taste, cadence and working style
   are learned from use. Constitutional limits, budgets and safety policy are
   explicit and inspectable; the agent never infers permission to weaken them.
   A settings screen should not replace learning, and learning must not replace
   governance.
8. **Autonomy is earned in scopes, never granted as trust.** Repeated safe,
   reversible outcomes may compress supervision for the same capability,
   resource and context. That grant is observable, revocable and able to
   regress after failure. There is no global trust score, and the model never
   decides its own safety boundary. Outward and irreversible work starts
   confirmed; only evidence can narrow that friction, never remove the
   constitutional floor.
9. **Data sovereignty is non-negotiable; local compute is a design option.**
   The invariant is sovereignty: the data is yours, under your control, not
   deletable by a vendor. On top of that sits a design preference — stay
   **local-capable**. Candidate models are open-weight and should plausibly run
   on consumer hardware, so that anyone installing this *can* choose to go
   local. An instance running through an API is an operational exception, not
   the norm, and no model choice may burn the local option. Compute is
   replaceable harness. Sovereignty is not.
10. **Separate who the owner is from who has owner authority.** The person's
    history, character and preferences live in accumulated data, never in
    code. Authority is the opposite: each surface binds the owner explicitly
    to a transport-authenticated, stable opaque subject identifier. A display
    name, biography, username, room, image or message can describe a person;
    none can make that person the owner. The agent's constitutional identity is
    different again: explicit, versioned and never learned away.
11. **Surface-agnostic.** A terminal, phone, speaker, pendant or future device
    is a port onto the same agent. A new surface may declare different delivery
    and input capabilities; it may not fork identity, memory, work or policy.
12. **Input-agnostic does not mean input-trusting.** New sources must not each
    require a bespoke cognitive path. Every accepted ingress is first parsed
    into typed content blocks with provenance and taint; unsupported material
    is quarantined or rejected explicitly. Message text, names, biographies,
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

## 6. Known tensions

These are not bugs waiting to be fixed. They are permanent tensions in the shape
of the thing, and naming them means not being surprised when they return.

**Wanting to be ahead, versus accumulation beating experimentation.** The
instinct is to implement the new technique. Under this thesis, that instinct
loses. The discipline is to experiment in the harness and leave the substrate
alone — and every interesting paper brings the temptation back.

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

## 7. What this is not

It is not a commercial personal assistant — not because it does less, but
because it does it with a point of view about you.

It is not a framework looking for users. It is one instance per owner: the value
is what accumulates on your machine, so a hosted multi-tenant version would be a
different product with none of the advantages argued above.

And it is not data-driven development. Here the data is the product, not the
requirement. Whether the agent is *good* is a qualitative judgement and always
will be. What gets measured is whether it is *broken* — a different question,
and one this repository takes seriously, because the characteristic failure of
this kind of system is damage that reports success. See `docs/lessons.md`.

The thesis is falsifiable in use. If continuity does not survive replacing the
model or moving between surfaces, it is not continuity. If months of operation
do not let the owner stop opening any direct interface without losing control,
the project is accumulating data without becoming the agent described here.
