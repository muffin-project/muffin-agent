# Design principles

`THESIS.md` says what this project is betting on. This one says **how to decide**
— the reasoning that should produce the same answer whether it is the owner or a
contributor holding the question.

There are seven, on purpose. A list of twenty gets skimmed, not applied.

---

## P1 — Neuroscience is a lens, not a blueprint

Biology and cognitive science are tools for *identifying computational problems*
and comparing solutions. They are not a structure to imitate.

Before adopting a biological mechanism, isolate the problem it solves. If that
problem does not exist here, the mechanism does not enter, however elegant. If
it does exist and humans solve it well — layered memory with offline
consolidation, activation decay over time, invalidating an entity rather than
expiring on a flat timer — imitate the mechanism. If humans solve it *badly* —
confirmation bias, unreliable metacognition, planning that ignores its own past
— do better.

This guards against two symmetrical errors. Biomimicry as a default ("brains
have a parasympathetic system, so this should too") and anti-biological snobbery
("that's biology, so it is irrelevant to software"). Both produce bad decisions.
The question is always: *do humans do this well or badly, for the problem being
solved?*

**The naming constraint follows from it.** When an evocative biological name is
used for a mechanism — consolidation, decay, activation, dreaming — pair it at
least once with a functional description of what it does here, independent of
brains. The metaphor helps you think; the functional description stops the
metaphor from smuggling in assumptions that are not true in this system.

For example, an offline consolidation pass is inspired by sleep but does not
imitate it. A brain sleeps because it must. A batch job runs at night because it
is cheaper, the owner is not waiting, and the reports come out coherent. That
difference in *justification* is what lets you move it later without violating
anything. If the justification were "brains do it", there would be no room.

## P2 — The double filter on harness

Every piece of code that performs a cognitive operation faces two independent
tests.

**Capability.** Would a current frontier-class model do this well by itself,
given well-assembled context — with tool calling, structured output and a long
context window? If yes, the code is substitute scaffolding and is a candidate to
become a model capability instead: an explicit tool call, a schema, or simply
better context and one line in the prompt.

**Existence.** Is the computational problem this code solves real, here, now? If
not, it is a candidate for straight removal regardless of the first answer.

The tests are independent, and all four combinations occur. Passes capability
but fails existence: remove. Fails capability but passes existence: keep, and
consider turning it into a capability. Fails both: remove. Passes both: leave it
alone.

Where the evidence is clean — citable research, known benchmarks, accumulated
experience — remove or transform directly. Where there is genuine ambiguity,
*simplify before removing*: reduce the module to its minimal form, watch it for a
few weeks, then decide. That is calibrated prudence, not conservatism, and it is
not the default.

**The counterweight, which matters as much as the filter.** P2 is a *reduction*
filter: it says what to remove or transform among things that exist. It is not
an argument for *withholding* a capability that is missing. "The model would do
it by itself" justifies removing harness that does it *on the model's behalf*.
It never justifies denying the model a **primitive** — a real filesystem,
sandboxed execution, a tool that does not exist yet — that the owner needs. When
the problem is missing capability rather than excess harness, the gate is P6
plus safety, not this one.

## P3 — Three levels of adapting to a person

A personal agent adapts on three distinct levels. Telling them apart is what
makes an open-source project possible at all, because they have different
homes.

**Level 1 — learned data.** Facts, patterns, the graph, episodes, the profile
that accumulates. It emerges automatically from input; for any person with
coherent input over time, it populates itself. No configuration. It is the
substrate. In the repository it is exposed intact — as schema, never as content.

**Level 2 — identity and behaviour.** Who the agent is, how it speaks, what it
never does. Per installation, different. The repository ships a **template**;
the real one lives in the user's own directory and is never touched by a
`git pull`.

**Level 3 — architectural choices that are actually personal preferences.**
Numeric thresholds, cadences, how proactive is too proactive, the minimum gap
between unsolicited messages. These *look* like architecture and are taste. They
must be parameters, not constants baked into the code.

The working rule: when writing or changing code, know which level you are on. On
levels 1 and 2, the mechanism ships intact. On level 3, the decision has to
become a parameter. Applied consistently, this makes the open-source extraction
a matter of *removing content*, not rewriting structure.

## P4 — The model reasons; the code does not

The database is memory. Rendering is voice. The model is invoked on curated,
dense input. Not the other way round.

The characteristic mistake is a cognitive operation implemented as code written
in advance — weightings, semantic gates, hardcoded classifications — where
assembled context and one model call would do better and stay adaptable. This is
the compact form of the whole thesis, and it is worth checking against any new
module that scores, ranks, filters or decides.

The corollary is that classifiers are guilty until proven innocent. Twice in
this project's history an intent classifier was demoted to monitoring-only
because its errors were invisible and its value was unmeasured. If you add
something that decides on the model's behalf, decide *first* how you would find
out it is wrong.

## P5 — Proprioception before power

A system that does not know whether it is working does not get powerful tools.

This is not an argument against giving an agent hands. It is the order in which
hands are earned: traces that show what actually happened, self-inspection that
can be queried, invariants that fail loudly. In a system whose characteristic
failure is *damage that reports success*, knowing your own state is not
observability hygiene — it is the precondition for being allowed to act.

P5 is in tension with P2 whenever proprioception is itself implemented as
harness, and the resolution is the same: if a model with a self-inspection tool
produces better proprioception than hardcoded monitoring, the hardcoded version
gives way.

## P6 — YAGNI as an active filter

Every proposed feature faces two questions:

1. **Is the agent fundamentally broken without this?**
2. **Does it move toward something with a point of view, or toward a tool?**

If neither answer is yes, the feature waits.

P6 and P2 are complementary: P2 filters what exists (what to remove), P6 filters
what is proposed (what not to add). Together they prevent both harness
accumulation and unjustified feature growth.

**The scope of the second question is narrower than it looks**, and getting this
wrong has cost this project time. It applies to the agent's **user-facing
behaviour**: how it acts, how it speaks, when it intervenes, what it exposes. It
does **not** apply to the engineering of the project — packaging, installers,
CLI ergonomics, modularity, developer experience. Those live at the substrate
and infrastructure level. They must pass question 1; question 2 says nothing
about them. Rejecting a self-serve installer because "it is not an entity with a
point of view" is a category error: an agent without an installer is not less of
an entity, it is only harder to install.

**And ambition is not the same as being a tool.** Question 2 rejects execution
*without* a point of view — the mute butler that does as told and never says
anything. It does not reject ambitious work. An agent that runs an hour-long
loop fixing an inbox, does multi-step research, lives in the machine's
processes, *and* understands, *and* has a voice, is **more** of an entity, not
less. Hands without a voice are a tool; hands with a voice are not. The length
or ambition of the work is never, by itself, a signal.

## P7 — These principles are calibrated for a phase

This document is not timeless and does not pretend to be. It is written for the
phase the project is in, and phases change: a reduction phase — cutting
accumulated scaffolding, moving cognition from code into model capability — asks
for different instincts than an additive phase, where the problem is capability
that does not exist yet in code *or* model.

A phase transition is a recognisable structural change: the reduction work is
done; a new model materially changes what is available; the project is released
publicly and the ecosystem around it changes.

The operating rule: at each transition, **reread this document whole, not
incrementally**, asking whether the principles are still calibrated or need
redoing. P7 exists so the other six stay a compass rather than becoming
doctrine — including this one.
