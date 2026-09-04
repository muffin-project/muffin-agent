# Cognitive design — hypotheses, evidence and kill criteria

Muffin is meant to make its owner **more capable without making the owner less
agentic**. Cognitive science and neuroscience can help identify useful problems
and possible design constraints, but they do not certify a software mechanism.

This document owns Muffin's **current cognitive-design programme**: which ideas
about human cognition the product is exploring, how strongly they are grounded,
what Muffin has actually observed, and what would make us remove them.

It does **not** own current runtime mechanics (`ARCHITECTURE.md` and executable
code do), scientific truth, DAY-1 status, or a promise that any experimental
mechanism will survive dogfood.

The governing design principle remains `DESIGN-PRINCIPLES.md` P1:
**neuroscience is a lens, not a blueprint**.

---

## 1. Human-first means complement, not imitate

The target is not a simulated human brain and not an assistant that maximises
how much thinking the owner can stop doing.

The working product hypothesis is **cognitive complementarity**:

```text
owner
  ├─ judgement, goals, values, novelty, changing their mind
  │
  └──────────── works with ────────────┐
                                       │
Muffin                                 │
  ├─ continuity across time            │
  ├─ remembering commitments           │
  ├─ tracking change and provenance    │
  ├─ comparing expectation to outcome  │
  ├─ carrying repeatable work          │
  └─ acting inside delegated authority │
                                       ▼
                         a more capable owner
                         who can still understand,
                         intervene and take control
```

This is a hypothesis, not a law. Human + AI is not automatically better than the
better of human or AI alone. Muffin therefore has to measure augmentation and
failure instead of treating "personalisation" or "proactivity" as value by
definition.

---

## 2. Two evidence axes, never one maturity badge

Every falsifiable cognitive idea carries two independent statuses.

### External grounding

How much does outside evidence support the **underlying human/computational
phenomenon**?

- **STRONG** — a well-established phenomenon or problem with substantial
  replicated/reviewed evidence.
- **SUGGESTIVE** — credible evidence exists, but the exact framing or boundary is
  contested, task-dependent or incomplete.
- **ANALOGY** — the outside phenomenon is real, but applying it to a personal
  agent is our extrapolation.
- **OWNER HYPOTHESIS** — primarily a Muffin idea/intuition; outside work may be
  adjacent but does not currently establish it.

### Muffin evidence

How much evidence says the **software/product application** is useful here?

- **UNTESTED** — idea only; not entitled to shape the core.
- **EXPERIMENT** — implemented or instrumented so it can be falsified.
- **SUPPORTED** — repeated eval/dogfood evidence shows material benefit over an
  appropriate simpler baseline, with acceptable failure cost.
- **REJECTED** — measured harm, no benefit, or a simpler mechanism won. Do not
  silently resurrect it under a new name.

`SHIPPED` is deliberately absent. Shipping says code exists, not that the idea
works. `SUPPORTED` is deliberately expensive: a mechanism does not earn it from
one unit test or because the external science is strong.

External grounding never upgrades Muffin evidence automatically. A robust
neuroscience phenomenon can still inspire a terrible product feature.

Some human-first properties are **not cognitive experiments at all**. If a
boundary is required independently for security, provenance or continuity, it
belongs under architectural commitments rather than being assigned a fake
cognitive-evidence badge.

---

## 3. Falsifiable product hypotheses

### H1 — Learn from prediction error, not from confidence alone

**External grounding: STRONG**  
**Muffin evidence: UNTESTED**

The underlying learning idea is simple: compare an expectation with what
actually happened and use the discrepancy to update the model. Prediction-error
learning is a major construct in associative/computational neuroscience.

This is the deeper idea behind what the legacy project sometimes described as
learning from the **prediction diff**. The Muffin version is more specific and
therefore unproven:

```text
explicit prediction about this owner / situation
                │
                ▼
        observable outcome arrives
                │
                ▼
       prediction ↔ outcome delta
                │
                ▼
update the relevant belief / calibration / future prediction
```

This is **not** the old `content_predictor_v0` shortcut "prediction gap =
`1 - cosine similarity`". The old repo researched that proxy and parked it after
finding important failure modes: novelty and contradiction are not captured
reliably by semantic distance alone.

A future experiment should make both prediction and outcome inspectable, define
what is being predicted, and measure calibration over time. If we cannot state
what outcome would falsify the prediction, we are not implementing prediction
learning; we are adding a score with cognitive vocabulary.

Candidate measurements:

- calibration error before/after repeated outcomes;
- whether prediction error decreases on recurring, sufficiently stable patterns;
- adaptation after the owner's behaviour/preference changes;
- false certainty and harmful over-generalisation;
- benefit against a baseline that simply gives the current model good history.

### H2 — Absence can be a signal, but never sufficient context

**External grounding: ANALOGY / SUGGESTIVE**  
**Muffin evidence: EXPERIMENT**

Expected events can generate error signals when they fail to occur. Muffin
extends that idea to longitudinal personal context: if a topic/event normally
appears with a personal rhythm, a large deviation from that rhythm may be useful
information.

The new runtime already contains an `absence` detector that compares silence
against the entity's own historical pattern rather than using a universal
"not mentioned for N days" threshold.

That does **not** prove that mentioning the absence to the owner is useful.
Legacy Muffin is negative evidence: proactive/heartbeat behaviour sometimes
produced context-blind prompts such as "we haven't talked about this in a long
time" or questioned whether a topic had really been discussed. The signal was
not enough to understand the situation.

Therefore an absence signal may nominate a moment for consideration; it must not
entitle itself to an interruption.

Candidate measurements:

- precision of absence-triggered moments judged useful by the owner;
- ignored/dismissed/rejected rate;
- whether retrieved current context would have explained the silence without
  asking;
- repeated false alarms for resolved, seasonal or deliberately abandoned topics;
- value over a simpler due-work/calendar/event baseline.

### H3 — Importance is not frequency

**External grounding: SUGGESTIVE**  
**Muffin evidence: EXPERIMENT**

A repeated item is not necessarily the most important item, and a one-off event
can remain highly significant. Muffin therefore should not turn mention count
into a universal importance score.

The current memory design already separates dimensions such as explicit
importance, confidence, provenance and temporal state instead of putting a
single frequency term in charge of memory. That makes the idea testable; it does
not prove the stronger product claim.

The stronger claim — that Muffin can infer durable personal significance better
than a well-contextualised model without special machinery — remains unproven.

Candidate measurements:

- recall/retention of rare-but-important items;
- false persistence of frequent routine noise;
- owner correction rate for inferred importance;
- ablation against simpler recency + semantic retrieval + explicit owner signals.

### H4 — Forgetting can improve usefulness; Muffin should complement human forgetting

**External grounding: STRONG for adaptive forgetting in humans; ANALOGY for Muffin**  
**Muffin evidence: ONE NARROW INSTANCE SHIPPED (ADR-0068), the rest UNTESTED**

`docs/decisions/0068-una-richiesta-ha-un-momento-non-una-fiducia.md` is the
first measured case of the second bullet below, and it draws the line the
hypothesis asks for exactly: a request-type fact (`asked_to`, `asks_to`, …) is
canonical and stays exactly as alive as before — nothing decays, nothing is
retired, no confidence changes — but its *derived, rebuildable* per-fact vector
stops being written and an already-written one is retracted. Measured on the
owner's real recall path: an already-answered request from 08/27 no longer
resurfaces on a same-vocabulary but unrelated query from a later date (was 12
distinct requests across 15 representative queries, now 0), while the entity
graph hop, `--history` and the original episode text stay fully reachable. This
is not general confidence decay — ADR-0040 still refuses that — it is the
narrow claim that a *retrieval index over a momentary fact* is exactly the kind
of "low-value derived material" the third bullet already names.

Human memory does not preserve every representation equally, and forgetting can
reduce interference. That does not imply Muffin should copy a biological
forgetting curve.

The product hypothesis is complementary instead:

- disposable processing, stale summaries and rebuildable representations should
  be cheap to discard;
- canonical continuity should not disappear accidentally;
- low-value derived material may decay so retrieval remains usable;
- commitments and details humans predictably drop can be exactly what Muffin is
  valuable for preserving;
- deliberate owner correction/deletion is different from automatic forgetting.

Any decay mechanism must prove that it improves retrieval/use without deleting
meaning the owner later needed. Until then, "forgetting is a feature" is a design
question, not a licence to delete data.

### H5 — Timing is part of intelligence; silence is a valid action

**External grounding: STRONG that proactive timing is a hard problem**  
**Muffin evidence: EXPERIMENT (current direction); legacy heartbeat form REJECTED**

A correct suggestion at the wrong moment is a bad intervention. Muffin treats
`do nothing` / `stay silent` as a first-class outcome.

Legacy Muffin is evidence against naive heartbeat-style proactivity: a system can
have relevant memories and still become annoying when it lacks enough current
context or treats elapsed time as a reason to speak.

The current direction is intentionally stricter: cheap deterministic signals may
identify candidate moments; semantic judgement decides whether there is
actually something specific worth saying; silence remains the default when the
case is weak. That direction is still experimental: the failure of heartbeat
does not prove the replacement works.

Candidate measurements:

- useful-intervention precision, not message count;
- ignored/muted/rejected proactive messages;
- interventions where the owner had to explain context Muffin should have known;
- open loops successfully closed without nagging;
- value over purely event/due-date driven reminders.

### H6 — A person model must learn change, not fossilise biography

**External grounding: SUGGESTIVE / strong engineering evidence for preference drift**  
**Muffin evidence: UNTESTED longitudinally**

A useful personal model distinguishes relatively stable biography from mutable
preferences, priorities, projects and habits. More importantly, it needs a
closed feedback loop: evidence after an action should be able to correct the
model that produced the action.

Legacy Muffin had a useful mutability intuition but an incomplete loop: its
belief-gap questions were asked, yet answer/ignore states were not wired well
enough for the supposed adaptive back-off to learn from them. That is negative
evidence for the old mechanism, not positive evidence for the replacement.

Future person-model work should therefore optimise for **correction latency and
adaptation**, not number of stored attributes.

Candidate measurements:

- time/turns needed to adapt after a preference changes;
- repeated use of superseded preferences;
- explicit correction rate;
- whether post-action feedback actually modifies future behaviour;
- questions repeated despite sufficient prior evidence.

---

## 4. Cognitive-adjacent architectural commitments

These properties are related to the human-first programme but are **not** kept or
removed by a cognitive engagement A/B test. Their current authority lives in the
architecture/security documents and executable system.

### Evidence and belief are different things

A time-stamped observation and a de-contextualised belief should not be the same
record merely because both are "memory". Episodic/semantic cognition is useful
prior art, but the software property earns its place independently through
provenance, speaker attribution, contradiction and temporal correction.

The exact extraction/consolidation algorithm remains harness and may be replaced.
The Evidence vs Beliefs boundary does not require Muffin to simulate
hippocampal/cortical biology.

### Understanding never grants authority

Human-first personalisation easily drifts into the assumption "the agent knows
me, therefore it may decide for me". Muffin rejects that inference.

Better understanding can improve interpretation. Authority is granted
separately, by capability/resource/context, and remains observable and revocable.
This is a constitutional/product boundary, not something an engagement metric is
allowed to optimise away.

---

## 5. Ideas we explicitly do not canonise

### "The brain does X, therefore Muffin should do X"

Rejected reasoning. Biology can expose a problem or useful trade-off. Software
must earn its own mechanism.

### Dreaming as architecture

Dreaming/consolidation can be a useful metaphor or batch-processing strategy.
Muffin does not need a dream cycle to remain Muffin. If a simpler asynchronous
consolidator beats it, use the simpler mechanism.

### Prediction gap as cosine novelty

Legacy research found the proxy too weak for the discovery claim and able to
mis-handle contradictions/compositional implication. It is not the definition
of prediction error.

### Proactivity as regular heartbeat conversation

Rejected by legacy experience. Periodic evaluation may be an implementation
technique; elapsed time alone is not a reason to interrupt.

### A bigger person model is automatically a better person model

Rejected. A model that stores more but adapts slowly, confuses authorship,
repeats stale beliefs or increases sycophancy is worse.

### Human-like means better

Rejected. The goal is useful complementarity. Where human cognition has known
failure modes — forgetting commitments, hindsight distortion, source confusion,
limited attention — Muffin should be allowed to do something structurally
different.

---

## 6. Product-level augmentation metrics

The sentence "make the owner more capable, not more dependent" is only useful if
we are willing to observe its failure.

During dogfood and later evals, prefer behavioural evidence such as:

- **continuity:** work forgotten, duplicated or recovered correctly;
- **cognitive load:** commitments/details the owner no longer has to manually
  track, without losing inspectability;
- **correction:** how quickly a wrong or stale person-model belief stops shaping
  behaviour after evidence changes;
- **interruption quality:** proactive messages useful vs ignored/rejected/noisy;
- **calibration:** predictions whose stated confidence matches outcomes over
  time;
- **agency:** actions the owner can inspect, interrupt, undo or revoke rather than
  merely delegate blindly;
- **fallback:** direct apps/general agents the owner still has to open because
  Muffin cannot complete the job;
- **dependence warning:** tasks where the owner loses understanding/control while
  Muffin appears to make interaction easier.

No single metric proves complementarity. The point is to make failure visible
before a compelling cognitive story hardens into doctrine.

---

## 7. Kill criteria for cognitive machinery

A cognitive mechanism should be simplified, parked or removed when one or more
of these persist after a fair experiment:

1. it does not improve the product metric it was introduced to move;
2. a simpler baseline performs as well or better;
3. a current model with better context performs the judgement better without the
   mechanism;
4. its false positives create interruption, stale beliefs, sycophancy or owner
   correction burden;
5. its output cannot be observed well enough to calibrate;
6. the mechanism survives only because its cognitive/neuroscience story is
   attractive;
7. the feature flag/escape hatch remains permanently off because the experiment
   can never satisfy its own activation gate.

Removal is evidence that the research programme works, not evidence that the
project failed.

---

## 8. Legacy corpus and evidence discipline

The curated rebuild corpus under `docs/knowledge/` remains valuable
because it preserves both useful principles and failed implementations from the
old Muffin. It is **evidence/history**, not current authority.

Particularly important negative evidence includes:

- context-blind proactive/heartbeat behaviour;
- `content_predictor_v0`'s fragile cosine novelty proposal and its later parking;
- belief-revision machinery that consumed work/calls without producing useful
  revisions;
- heuristic deictic and unknown-term classifiers that created measurable false
  positives;
- incomplete feedback loops whose adaptive state could never actually update.

When a legacy cognitive idea is revived:

1. restate the computational/product problem without cognitive vocabulary;
2. verify outside evidence from primary/reliable sources rather than trusting
   inherited bibliography;
3. define the simplest baseline;
4. define what observation would falsify the Muffin application;
5. instrument before claiming benefit;
6. promote it in this document only when its evidence status actually changes.

That keeps the unusual part of Muffin alive without requiring the old Muffin to
have been right.
