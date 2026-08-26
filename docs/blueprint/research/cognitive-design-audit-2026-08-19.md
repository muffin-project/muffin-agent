# Cognitive design evidence audit — 2026-08-19

**Role:** dated evidence snapshot. This file is not current architecture and is
not a promise that any cognitive mechanism will ship. Current hypothesis status
lives in `docs/COGNITIVE-DESIGN.md`.

## Question

Which of the unusual cognitive ideas inherited from old Muffin are externally
grounded, which are Muffin-specific extrapolations, and which already have
negative product evidence?

The audit deliberately separates:

1. evidence that a phenomenon exists in humans/learning systems;
2. evidence that translating it into a personal agent is useful;
3. evidence that a particular Muffin implementation works.

Those are not interchangeable.

---

## 1. Human–AI complementarity is a target, not an automatic property

A 2024 Nature Human Behaviour preregistered systematic review/meta-analysis of
106 experiments (370 effect sizes) found that human–AI combinations were, on
average, worse than the better of human or AI alone; effects differed by task.
This is direct evidence against treating "human + AI" as automatic synergy.

- Vaccaro, Almaatouq & Malone, *When combinations of humans and AI are useful: A
  systematic review and meta-analysis*, Nature Human Behaviour (2024):
  https://www.nature.com/articles/s41562-024-02024-1

A 2025 Nature Reviews Psychology perspective argues for designing around
complementary strengths in dynamic decision-making, while a 2026 response warns
that augmentation does not require emulating human cognitive mechanisms.
Together they support Muffin's framing: complement the owner, do not simulate a
brain by default.

- Gonzalez & Heidari, *A cognitive approach to human–AI complementarity in
  dynamic decision-making* (2025):
  https://www.nature.com/articles/s44159-025-00499-x
- Lin, *Human–AI complementarity needs augmentation, not emulation* (2026):
  https://www.nature.com/articles/s44159-026-00536-3

**Muffin implication:** `make the owner more capable, not more dependent` is a
falsifiable product objective, not marketing proof.

---

## 2. Prediction error is well grounded; the personal-agent translation is not

Prediction error — discrepancy between expected and observed outcomes — is a
central construct across associative learning and computational neuroscience.
Reviews describe both reward prediction error and broader effects on learning
and attention.

- Roesch et al., *Prediction errors, attention and associative learning*:
  https://pmc.ncbi.nlm.nih.gov/articles/PMC4862921/
- Corlett et al., *Meta-analysis of human prediction error for incentives,
  perception, cognition, and action*:
  https://pmc.ncbi.nlm.nih.gov/articles/PMC9117315/
- Iordanova et al., *Neural substrates of appetitive and aversive prediction
  error*:
  https://pmc.ncbi.nlm.nih.gov/articles/PMC7933120/

That supports the general idea `prediction → outcome → error → learning`.
It does **not** establish that a personal agent should predict its owner, what it
should predict, or how the delta should modify a person model.

### Legacy evidence

Old `PRINCIPLES.md` explicitly labelled C-A "filter by prediction gap, not class"
as **aspirational** because no predictor/surprisal/KL primitive existed.

Old `content_predictor_v0.md` then proposed `1 - cosine similarity` as a novelty
proxy. Its own later research found the design fragile: compositional implication
could look novel, contradictions with similar surface form could look non-novel,
and the field did not support cosine-only admission as a discovery mechanism.
The pitch was parked rather than promoted.

**Conclusion:** preserve the deeper hypothesis (learn from explicit prediction
error), reject cosine novelty as its definition.

---

## 3. Omission/absence can carry prediction error; "you stopped talking about X"
is a Muffin extrapolation

Research on predictive processing and associative learning includes error
signals when an expected event/stimulus is omitted. This establishes that
absence can be informative relative to expectation in controlled learning
settings.

- Walsh et al., *Evaluating the neurophysiological evidence for predictive
  processing as a model of perception*:
  https://pmc.ncbi.nlm.nih.gov/articles/PMC7187369/
- Roesch et al. review above includes surprising omission as a learning signal.

Muffin's application is substantially stronger: infer that a topic's failure to
appear relative to one person's historical rhythm may be useful longitudinal
context. No source found here establishes that product claim directly.

The new runtime's `core/memory/absence.ts` is therefore correctly treated as an
experiment: it computes deviation against the entity's own rhythm and exposes a
signal. It does not prove an intervention is worthwhile.

### Negative legacy evidence

Old Muffin's proactive/heartbeat behaviour sometimes surfaced absence without
enough situational understanding, producing context-blind questions and
repetitive "we have not talked about X" behaviour. That is evidence against
`absence → speak` as a direct rule.

**Conclusion:** absence may nominate a candidate moment; context and utility must
still earn the interruption.

---

## 4. Proactive timing is independently a hard agent problem

2026 proactive-agent benchmarks increasingly separate *what* to do from *when*
to intervene and report substantial over-action/timing failures.

- Pare / Pare-Bench evaluates context observation, goal inference, intervention
  timing and multi-app orchestration:
  https://arxiv.org/abs/2604.00842
- ProEvent reports frequent over-action and difficulty handling changing/cancelled
  events:
  https://arxiv.org/abs/2607.17701

**Muffin implication:** the old lesson `elapsed time alone is not a reason to
speak` is aligned with an independently measured product problem. It does not
prove the current two-stage gate is the right solution.

---

## 5. Adaptive forgetting is real; copying a forgetting curve is not implied

Neuroscience literature treats forgetting as potentially adaptive rather than
pure storage failure. Experimental/review work reports benefits such as reduced
competition/cognitive-control demand and discusses environment-sensitive memory
accessibility.

- Ryan & Frankland, *Forgetting as a form of adaptive engram cell plasticity*:
  https://www.nature.com/articles/s41583-021-00548-3
- Kuhl et al., *Decreased demands on cognitive control reveal the neural
  processing benefits of forgetting*:
  https://www.nature.com/articles/nn1918

**Muffin implication:** it is reasonable to test selective decay/retention of
rebuildable representations. It is not evidence that canonical personal
continuity should mimic human forgetting. The product may be most useful exactly
where it complements human forgetting (commitments, exact details, provenance).

---

## 6. Personal models need feedback and change tracking

Recent personalized-agent work treats preferences as evolving rather than static
and reports benefits from incorporating post-action feedback into explicit
memory.

- Liang et al., *Learning Personalized Agents from Human Feedback* (PAHF, 2026):
  https://arxiv.org/abs/2602.16173
- Hao et al., *User Preference Modeling for Conversational LLM Agents: Weak
  Rewards from Retrieval-Augmented Interaction* (2026):
  https://arxiv.org/abs/2603.20939

A separate 2026 study finds that users can mispredict their own preferences for
AI writing assistance, reinforcing the need not to treat either stated
preference or observed behaviour as infallible ground truth:

- Lai et al., *Users Mispredict Their Own Preferences for AI Writing Assistance*:
  https://arxiv.org/abs/2601.04461

### Legacy evidence

Old Muffin already discovered the difference between a plausible feedback loop
and a wired one: belief-gap questions accumulated `asked` state while the
answer/ignore transitions required for adaptive back-off were incomplete. A
mechanism that cannot consume its own outcome cannot claim to learn.

**Muffin implication:** person-model quality should be measured by adaptation and
correction latency, not stored-profile size.

---

## 7. Episodic vs semantic memory is useful prior art, not schema destiny

The episodic/semantic distinction is established cognitive prior art. It supports
the software question "should a time-stamped observation and a decontextualised
belief be distinct?" but does not prescribe tables, a dream cycle, or
hippocampal/cortical imitation.

The new architecture's Evidence vs Beliefs separation earns its place through
software properties — provenance, speaker attribution, contradiction and
history — even if future extraction/consolidation stops resembling the old
neuroscience-inspired design.

---

## 8. Legacy mechanisms that should remain negative evidence

The curated legacy corpus records several cases where an attractive cognitive
story did not earn its implementation:

- cosine novelty/prediction-gap filter — researched and parked;
- heartbeat/proactivity that lacked enough current context — noisy in use;
- belief revision — large mechanism with effectively no useful revision signal;
- unknown-term and deictic heuristic classifiers — measurable false-positive
  costs;
- feedback/back-off paths whose terminal state was not wired — adaptation that
  existed only on paper.

These failures are valuable. Public cognitive design should show that Muffin is
willing to remove an idea when evidence says the implementation or the premise
is wrong.

---

## 9. Documentation consequence

The public claim should **not** be:

> Muffin is neuroscience-based.

Prefer:

> Muffin is human-first. It borrows ideas from cognitive science and
> neuroscience when they expose useful problems or constraints — then tests the
> software interpretation against real use and removes it when a simpler system
> works better.

That wording preserves the unusual design lineage without converting biological
analogy into scientific authority.