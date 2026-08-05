# Lessons

Things that were tried and did not work, with the evidence and how it was found.

This file exists because the previous version of this project ran for months and
the most valuable thing it produced was not the architecture — it was the list of
ways a personal agent breaks *while reporting success*. That failure mode is the
characteristic one for this kind of system, and it is the one nobody publishes.
An open-source project usually ships the design that worked. This is the other
half.

Everything here is sourced. Where a number appears, it was measured on real data
and the decision record it came from is named. Entries marked **(this build)**
were found while writing the current system, not inherited.

---

## A constraint that is not true in the domain executes the wrong update in silence

The previous schema treated every predicate as single-valued: one current belief
per subject and predicate, and a new one retired the old. That is correct for a
date of birth and wrong for almost everything else a person says about
themselves.

An audit found the damage weeks after it started. Of the beliefs stored under
`interest`, **27 of 28 had been expired by accident**; `preference` **21 of 22**;
`sentiment_toward` 12 of 14; `concern` 11 of 13. Most of the "supersede" events
in the database were artefacts of the order in which facts happened to be
extracted, not changes of mind. The repair reinstated **89 wrongly expired
attributes** plus 10 that had been evicted by a cap.

Nothing errored. Every write succeeded. The constraint did exactly what it was
told, and what it was told was false about the world.

*Source: ADR-025, 18 May 2026, previous repository.*

**What this system does instead:** predicates are **set-valued by default**, and
the short list of genuinely functional ones is declared explicitly and visible.
The wrong default now *accumulates* — which is visible and repairable — instead
of *deleting*, which is neither. There is an invariant that fails if a declared
functional predicate ever holds two current values.

## A closed ontology is a substrate blocker, and you find out too late to be cheap about it

The first version of the memory schema fixed the entity and relation types up
front. It was diagnosed as a substrate blocker and rewritten from scratch **in
one month** (24 April → 11 May 2026). The rewrite was not caused by a bug: the
schema worked. It was caused by every new kind of thing the owner said needing a
schema change first.

*Source: ADR-009, previous repository.*

**Instead:** free predicate vocabulary with light canonicalisation, and
governance by periodic audit rather than by rejection at write time. There is a
threshold — calibrated at twice the observed vocabulary of the old graph, which
held 43 distinct predicates over 329 edges with 26 used exactly once — above
which consolidation *proposes* merges. It never blocks an ingest.

## vec0 rejects a Number rowid, and a bare `catch` turns that into weeks of silence

`INSERT INTO ..._vec(rowid, embedding)` with a JavaScript `number` throws,
because vec0 requires an integer type. The throw was swallowed by an empty
`catch {}`.

Result: **3,312 rows with embeddings, 0 of them indexed.** Every vector table in
the system was empty. Hybrid retrieval had lost half of itself and the loss was
masked by full-text search and an in-memory cosine fallback, so quality degraded
without a single error. The full-text side had its own gap in the same incident:
38 facts and 920 episodes missing, a third of the corpus. Found by manual audit
on 10 June 2026, not by any alarm.

*Source: previous repository, `src/memory/CLAUDE.md` §FTS5 hybrid retrieval;
`INTERVENTIONS.md` 2026-06-10.*

**Instead:** `BigInt` at the call site, an `indexedCount()` a health check can
assert on, a test that fails if the rows are not there, and an invariant that
fails if a chunk exists without its vector. Four defences for one bug, because
the bug's whole nature was being undetectable.

## Nothing was feeding the vector index **(this build)**

`VectorIndex.index()` had tests. It had a schema, a dimension check, a
transaction, and the BigInt fix above. It was called from nowhere in the live
path. Semantic recall was dead on arrival and would have degraded silently to
keyword search — the exact failure the class was written to prevent, reproduced
one layer up.

Every test passed, because every test built its own index first.

**What found it:** trying to run the module's acceptance scenario end to end
instead of reading the code. The lesson generalises: a unit test that constructs
its own dependency cannot tell you whether anything constructs it in production.

## The contradiction judge was never shown the sentences **(this build)**

It received two values — `Marco` and `Lucia` — and was asked whether the second
replaced the first. It could not know, and said so in its own reasoning before
anyone thought to look: *"the text does not provide explicit information about
whether the change actually occurred."*

It was right. "Ho cambiato commercialista" — *I changed accountants* — is the
entire signal, and it lived in the episode, which the judge never saw. Measured
on four archetypes (a declared change, two coexisting interests, two unrelated
people, a move with dates): **0 useful verdicts out of 4 before, 4 out of 4
after** passing the source sentences along with the values.

A judge that cannot see the evidence can only justify retiring a belief when the
two values are numerically incompatible. Everything else accumulates for ever,
which reads to the owner as "it never updates what it knows about me".

## Extraction that generalises the relationship away destroys the thing that makes contradiction visible **(this build)**

"Marco è il mio commercialista" was extracted as `owner works_with Marco` plus
`Marco role commercialista`. That looks richer and is poorer: what distinguishes
Marco from anyone else has left the predicate. When the accountant later changed,
the comparison was `works_with Marco` against `works_with Lucia` — and coexisting
is the *correct* answer for that pair. The change was invisible by construction,
two layers before the judge that got blamed for it.

**Instead:** the predicate carries the relationship, and the extraction prompt
uses this exact failure as its negative example. The discriminator given to the
model: if the generic predicate would hold equally well for a completely
different person, it is the wrong predicate.

## A prerequisite check has to execute the thing, as the user that will run it

Sandboxed execution was enabled in production on 11 June 2026. The check that
gated it looked for the `bwrap` binary, found it, and reported the sandbox
healthy. Under Ubuntu 24.04's `kernel.apparmor_restrict_unprivileged_userns=1`,
`bwrap` fails to create a user namespace for an unprivileged service user — so
the sandbox had been a **no-op for two months** while reporting as on.

Two details made it worse. Checking as root would have passed, because root
bypasses the restriction: a probe run by the wrong user reports a false positive.
And the flag being on made the system *look* more careful than it was.

*Verified and fixed 2026-08-04 with an AppArmor profile; confirmed working by
the owner.*

**Instead:** the probe performs a real containment as the service user and
asserts the containment held. A check that looks for a binary answers a question
nobody asked.

## Containment that resolves paths but does not follow symlinks is not containment **(this build)**

`path.resolve` normalises `..` and does not follow symbolic links, so a link
inside an allowed directory pointing outside it defeats a write scope. The fix —
resolving the deepest existing ancestor with `realpath` — then broke the root of
trust deny-list, because on macOS `/var` is itself a symlink and only one side of
the comparison had been resolved.

Both sides, always. A containment check that is right about one path and naive
about the other is a containment check that fails in exactly the case an attacker
would construct.

## A component that is correct but too slow is not correct

A reranker was evaluated and rejected: `bge-reranker-v2-m3` improved 2 of 6 test
queries and took **6–12 seconds** on the production VPS, which is 2 vCPUs with no
GPU. Right answer, wrong place. It was reopened later only as a lighter,
different design.

*Source: ADR-094, previous repository.*

The lesson is not "avoid rerankers" — the current system has one. It is that
where a component runs is part of whether it works, and that a quality
measurement taken on a laptop does not transfer to the machine that will run it.

## The model imitates the shape of its own history

Tool calls that had been rendered into the conversation as text — `[Eseguo
update_artifact ...]` — taught the model to produce that text instead of calling
the tool. The system had trained itself, one turn at a time, to fake its own
actions. The fix was to strip the rendering at the single point where history is
assembled, not to add a parser for the fake calls: parsing them is an arms race
against a model that keeps inventing new syntax.

A related symptom: the model would announce a completed action it had never
performed. Detection based on generic words ("tool", "search") missed it as soon
as a new tool existed, because the model named the *real tool*.

*Sources: ADR-079 and its 2026-06-12 amendment, previous repository.*

## Classifiers that decide on the model's behalf get demoted, twice

An intent classifier that fired actions from code was reduced to monitoring only,
because its errors were invisible and its value was never measured. The same
shape of component was demoted a second time later.

*Source: ADR-065, previous repository.*

**The rule that came out of it:** if you add something that decides on the
model's behalf, decide first how you would find out it is wrong. If there is no
answer, it is monitoring, not a decision maker.

More reasoning does not fix this, and can make it worse: the project's recorded
reason for defaulting thinking *off* on its main model is that additional
reasoning amplified tool hallucination rather than reducing it.

---

## The pattern under all of them

Almost none of these announced itself. The constraint executed successfully. The
insert threw into an empty catch. The sandbox reported healthy. The index was
never written. The judge returned a verdict. Every one of them was found by
someone deciding to check, usually weeks later, usually by accident.

This is not specific to this project. The same failure is open in the systems
nearest to it: an issue where hash calculation *"completes normally"* and the
pipeline stops without indexing anything (khoj#1105), and a file watcher that
updates the interface while carrying a literal `// TODO: add logic to update
vector db`, with users reporting edits that never reindex (reor#118). In all
three cases the mechanism was present and looked healthy. What was missing was
anything that ever compared the two sides.

So the design rule this repository actually runs on:

> **A mechanism working is not the same claim as the outcome being right, and
> only the second one is worth asserting.**

In practice that means: invariants that run without a model or a network and
fail loudly; a health check that compares the directory against the index rather
than trusting the hash that maintains it; counts a test can assert are non-zero;
and probes that execute the real thing as the real user. None of it is
sophisticated. All of it exists because the alternative has already cost this
project months.
