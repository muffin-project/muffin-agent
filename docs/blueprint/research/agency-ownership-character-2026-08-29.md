# Agency ownership, character and model independence — 2026-08-29

Status: research synthesis / architectural challenge, not runtime truth.

## Question

If frontier products already provide strong models, memory, tools, scheduled work and integrations, what is Muffin actually supposed to own? When does Muffin add a distinct system rather than wrapping a model provider with extra memory and personality?

This note consolidates a repo review and comparison with the current personal-agent field. It is evidence for the current thesis/design documents, not a new source of product authority.

## What the repository already says

The current thesis is already stronger than "LLM + memory + persona":

- continuity belongs to the agent rather than to a chat, device, app, model, provider or process;
- canonical continuity includes provenance, unfinished work, effect state and authority, not only remembered facts;
- the model itself is replaceable harness;
- the product has three peer axes: do, understand, be present;
- surfaces and future bodies must not fork identity, memory, work or policy.

The current vision already gives embodiment a concrete grammar:

- Home owns canonical continuity;
- Nodes are places where Muffin can perceive, act or compute;
- Surfaces are interaction ports;
- a phone, Mac, speaker, Watch or pendant can be a body of the same Muffin without becoming another agent.

The cognitive design already separates Evidence from Beliefs because observation, attribution, inference and contradiction have different semantics. This distinction earns its place through provenance and correction, not through a cognitive metaphor.

The synthesis below therefore sharpens existing direction rather than replacing it.

## Finding 1 — model is not agent

A model can supply cognition for one turn without owning the agent's identity.

A useful operational formulation is:

> **Muffin owns persistent agency; models provide replaceable cognition.**

Anything that disappears merely because the active model/provider/session changes is not durable Muffin state.

The distinction matters because model providers can increasingly supply features that once differentiated wrappers: memory, browsing, scheduling, computer use, apps and tool calling. Competing on the checklist is structurally weak. A personal runtime can instead own the continuity that survives those providers.

This does not establish a moat. It establishes an architectural unit.

## Finding 2 — agency ownership is larger than memory

Memory and personality are necessary but insufficient.

For a continuous personal agent, the durable unit includes at least:

- identity and constitutional character;
- source evidence and provenance;
- beliefs/inferences with uncertainty and contradiction;
- unfinished Work, intentions and obligations;
- authority/grants and their boundaries;
- effect intent/outcome state;
- process/background state required to continue or reconcile work;
- relationship state that is learned from one owner over time.

A system that remembers the owner but loses what it owes, what it may do, what it already changed, or why it believed something is still primarily a conversational memory layer.

## Finding 3 — relationship is with the person, not the session

Muffin is human-first in a literal systems sense: the persistent referent is one owner and their changing world, not a chat thread.

A session is therefore a context window over the relationship. Starting, ending, compacting or changing a session must not silently reset:

- learned relationship state;
- unfinished obligations;
- authority;
- provenance;
- effect uncertainty;
- durable intentions.

The product should distinguish at minimum:

1. what Muffin directly or indirectly **observed** as evidence;
2. what the owner or another source **said**;
3. what Muffin **inferred/believes** from that evidence;
4. what Muffin **decided/proposed**;
5. what actually **happened** in the world.

These categories may share storage or projections, but they must not collapse semantically. An inference must not later masquerade as an owner statement; an agent-authored summary must not launder third-party provenance; an intended effect must not become an observed outcome merely because the process crashed after dispatch.

## Finding 4 — shipped character is product identity, not a blank agent template

Muffin is not intended to be an anonymous agent framework whose substance is supplied entirely by per-user prompting.

The current design already separates:

- shipped Muffin identity / constitutional character;
- the learned relationship and person model;
- explicit owner governance;
- calibratable preferences.

That separation should remain. Owners may configure behaviour, providers, capabilities, cadence and other policy-controlled surfaces, but a fresh install should already be recognisably Muffin.

Character should not weaken epistemic discipline. Having opinions, disagreeing, expressing uncertainty, admitting limits and being curious are compatible with a strong character precisely when Muffin can distinguish its interpretation from the owner's statement and from observed evidence.

## Finding 5 — embodiment is continuity expressed through bodies

Voice, desktop control, phone, speaker, pendant, sensors and computer use are not separate product identities. They are candidate surfaces/nodes for the same persistent agent.

Embodiment is strategically useful only when it strengthens presence in the owner's real environment. A new body should consume the same identity, Work, memory, authority and effect semantics rather than creating a device-specific assistant.

Therefore the acceptance question for a new embodiment is not "does the device have an AI feature?" but:

> **Can the same Muffin perceive, communicate or act here without forking continuity or bypassing authority?**

## Finding 6 — interoperability should test independence, not define the core

MCP or another model/tool protocol can be useful as an adapter by which ChatGPT, Claude, a local model or another host reaches Muffin state/capabilities.

It should not turn Muffin into a generic bag of `readFile`/`shell` tools, and it should not become the owner of canonical agency.

A protocol adapter is successful when replacing the client/model is a context switch rather than an identity reset.

This also means current ChatGPT/MCP limitations should not drive core architecture. "Use an unlimited-ish chat subscription as the model backend" is not a durable product requirement and, where no supported write-capable integration exists, should not be recreated through browser/session automation.

## Proposed architectural invariant

> **Model replacement should be a context switch, not an identity reset.**

Companion invariants:

> **Interface replacement should be a transport switch, not a relationship reset.**

> **Process restart should be runtime recovery, not amnesia.**

> **Untrusted information may change knowledge; it must not silently expand authority.**

These are implementation-agnostic. They do not require a particular model router, database, memory algorithm, MCP implementation or distributed topology.

## Falsification / acceptance test

A useful system-level test is a cross-model, cross-surface, cross-restart handoff:

1. model A starts an objective and creates durable Work;
2. Muffin records relevant evidence, authority and effects;
3. model A is removed;
4. model B continues without reconstructing identity from a giant transcript;
5. the interaction surface changes, e.g. CLI to Telegram;
6. model C can continue the same Work;
7. Muffin restarts;
8. the Work is still understandable and continuable;
9. uncertain effects remain uncertain rather than being invented as success/failure;
10. provenance still distinguishes owner statements, third-party content and Muffin inference.

Failure modes that would falsify strong agency ownership include:

- a provider change loses identity or obligations;
- continuity requires replaying effectively the whole historical transcript;
- each surface creates semantically separate memory/work;
- background work is only a process handle with no durable Work identity;
- agent-generated summaries erase source provenance;
- authority is reconstructed from conversational familiarity;
- restart turns unknown effects into assumed outcomes.

The target is not zero context transfer. A replacement model still needs a bounded working context. The claim is that canonical identity/state is owned outside that model context and can be re-composed for a new cognitive engine.

## What this changes now

This synthesis supports, rather than reorders, the current foundation work:

- memory lineage makes epistemic continuity portable;
- guardrails/security separate cognition from authority;
- background Work makes obligations/process state durable outside a model turn;
- person-model work builds the relationship without conflating it with governance;
- later subagents/concurrency/proactivity should consume those primitives instead of inventing parallel state.

MCP/interoperability is therefore better treated as a later adapter and as an acceptance test of model independence than as a foundation or token-usage workaround.

## Open hypotheses — do not canonise as established advantage

### H1 — agency ownership is Muffin's moat

Plausible, not demonstrated. Providers may increasingly own comparable continuity layers. Treat agency ownership as a design thesis until dogfood and external adoption show durable advantage.

### H2 — companion / pet is the correct public framing

Embodiment and character are clearly aligned with the product. "Companion" or "pet" may communicate warmth and persistence, but may also over-anthropomorphise the system or obscure authority/limitations. Keep as product-language hypothesis until tested with users.

### H3 — Muffin helps people understand themselves

There is a plausible product benefit in longitudinal reflection: distinguishing what happened, what the owner said, what changed, what Muffin inferred and which patterns survive challenge can expose useful self-knowledge.

But an agent can also fossilise stale narratives, amplify confirmation bias or produce persuasive but wrong interpretations. Therefore "helps the owner see/understand themselves" should be a falsifiable human-first hypothesis, not a guaranteed capability. Candidate evidence should include correction rate, surprise that survives review, longitudinal adaptation and explicit owner judgement of whether an insight was useful/accurate.

## Decision

Keep **agency ownership / model != agent** as a cross-cutting architectural lens.

Do not create a new core subsystem merely to embody the phrase. Evaluate each slice by asking whether it makes identity, knowledge, Work, authority, effects or presence more portable across models/surfaces/processes, or merely duplicates cognition a provider can already supply.

Keep character and embodiment first-class product direction, with epistemic/provenance boundaries intact.

Keep moat, companion/pet framing and self-understanding claims explicitly falsifiable until evidence earns stronger language.
