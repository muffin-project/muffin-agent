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

## Two correct halves, each waiting for the other, is a gate that never closes **(this build)**

The egress allowlist is the rule that says which hosts this process may reach.
It was written, tested, documented and reachable by nothing.

`decide.ts` gates URLs on `resource.kind === 'url'`. Its unit tests construct
exactly that resource, call the kernel directly, and go green — the branch works.
`loop.ts` built the resource it passes from `args['path']` alone, with no `url`
case, so every tool call in production arrived as `{kind:'none'}` and the branch
was never entered once. And `http_get` does not check the allowlist on its first
hop **on purpose**, with a comment explaining that the kernel already ruled on
it. Each half was correct. Each was relying on the other. The observable
behaviour was an empty allowlist permitting every public host.

Measured against the assembled runtime, empty allowlist, same capability, same
principal, same URL:

| how `decide` was called | verdict |
|---|---|
| with `{kind:'url', value}` — as the kernel's own tests call it | `ask` |
| with `{kind:'none'}` — as `loop.ts` actually called it | **`allow`** |

The sharp end: a group member's turn carries taint 2, and the egress branch is
what turns that into a refusal rather than a question. Without the branch, a
tainted turn could fetch an arbitrary host — the exfiltration path the threat
model exists to close, open for the life of the feature.

*Found 9 August 2026 while declaring a second URL-holding capability; fixed in
`bb392dc`.*

**What this system does instead:** the loop derives the resource from the
capability's own declaration — `resourceKind` says what kind of thing it acts on,
`policyArgs` says which argument holds it — and the kernel refuses outright when a
capability declaring a url is handed anything else.

The first attempt at this fix was weaker and worth recording, because it failed
in the same family: it lifted `url` into the resource *beside* `path`, checking
`path` first. `http_get({url, path:'x'})` then produced a path resource, skipped
the egress branch and fetched an off-allowlist host for a group member. The
sharper statement of the lesson is the one that version was missing: **a gate
whose precondition is supplied by its caller is not a gate.**

The regression test runs a **turn** rather than calling `decide` —
because calling `decide` is precisely what hid this. The test asserts on whether
the tool body executed, and it fails on the previous commit with the URL sitting
in the recorded array.

**The generalisation, which is the reason this entry exists:** a unit test that
constructs the input the mechanism wants is not evidence that anything ever
constructs it. Practice §5 already says to test the wiring — this is the case
where *both* sides had wiring tests and the join between them had none. When two
components each defer to the other, the test has to span the join.

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

## Writing the defence is not connecting it **(this build)**

An adversarial audit of this repository found the same thing four times, and it
was not a bug type — it was a habit.

The budget engine had a schema, two caps, five passing tests and a kernel branch
waiting on it. Nothing called `record()`, because nothing converted tokens to
dollars, so `exhausted()` answered `false` for ever and `/spend` would have
reported $0.00 after a night of unattended looping. Safe mode was computed at
boot and never handed to the policy kernel — while the CLI printed *"capabilities
above low risk are denied"*, which was the only place in the system where the
code asserted a guarantee it did not provide. The `vector_desync` invariant,
written specifically for the incident above, skipped in silence when its table or
extension was missing — which is exactly the configuration where that incident
happens — and the report then said "all invariants respected" and exited zero.
And the macOS sandbox probe ran an `(allow default)` profile: it proved
`sandbox-exec` starts, then printed *"a real containment ran and held"*.

Every one of those was written *because of* a lesson on this page. The file was
cited more often than it was executed.

**What it changed.** Four defences now have the thing they were missing: a caller,
a parameter, a report of what it could not check, and a profile that denies. The
general rule that came out of it is cheap to apply and would have caught all
four: when you add a guard, write the test that fails **without its wiring**, not
the test that proves the guard's logic. The logic was never wrong. It was never
reached.

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

## The same class, one day later, in the piece written to be careful **(this build)**

The proactivity gate decides whether Muffin may speak first. Every rail on it is
threat model, not taste: only the owner's own evidence may arm it, never in quiet
hours, never over budget. It has a pure decision function, unit tests, and an ADR
arguing the posture (`0028`). It had **zero callers** — found by grepping for its
own name while starting the slice that needed it, one day after the egress
allowlist above was found the same way.

What makes it worth a second entry rather than a line in the first: the egress
hole could be told as an accident of two people working on two halves. This one
had a single author and the most deliberate paper trail in the repository. The
care went into the mechanism and none of it into the question *who calls this*.
So the class is not "watch out when splitting work". It is:

> **Something with an ADR, a pure function and a test file looks finished from
> every angle except the only one that matters.**

The nearest thing to a cure we have found is procedural and now written into
`docs/JUDGE.md` as the rule above all the others: **don't review the diff, review
the guarantee** — start at a production entry point and try to *reach* the
mechanism, and if you cannot draw the path, the guarantee is unproven however
good the code is. Both of these would have been caught by one grep, on day one,
by anyone who thought to ask.

*Found 10 August 2026 while building the absence detector that needed it; the
gate reached production in the same slice.*

## A sealed file that nobody reads **(this build)**

`rot/policy.json` shipped with the Root of Trust scaffold, was hashed at every
boot, and opened `_comment` with *"Part of the Root of Trust: the agent loop
cannot change this at runtime."* It declared `defaultMaxTaint` per risk band,
`neverAtRuntime` and `forbiddenForSystem`. Nothing read it. The same three values
lived as `const`s in `decide.ts`, so the file was a byte-perfect copy of the code
with a sentence on top claiming to govern it — and the owner could not change
what a group may do without editing TypeScript.

Fifth instance of the class above, and `rot/budgets.json` had already been the
fourth: `quietHours` eventually got a reader, `monthlyUsd` and
`perTenantDailyUsd` still have none (`BudgetEngine` is built from `config.budget`,
which is outside the seal). Two things made these two survive longer than the
rest. The seal *proves the file has not changed*, which reads exactly like
"enforced" to anyone who does not go looking. And the previous four were each
closed with a test for that case, which is a cure that does not compose: the
sixth instance was going to be a different file.

**What it changed.** `decide` now takes the matrix from the sealed file, parsed
at the boundary, once, where the kernel's context is built — and the entry point
that was the whole problem is now tested through a real turn: lower the ceiling
in `policy.json`, reseal, and a taint-2 member stops reaching a low-risk
capability. But the part worth reusing is the other half. `core/rot/readers.ts`
maps every file in the sealed manifest to the production function that opens it,
or declares it unread-by-design with a reason (`evals/` is the honest case: the
ratchet's reference suite is sealed so the agent cannot grade itself against a
test set it rewrote, and no production reader should exist). A sealed file in
neither column fails, in the suite and in `doctor`.

The check verifies the map against the code instead of believing it — and that
part was itself wrong on the first try. Mutating `matrix.ts` so no line of code
named `policy.json` left the check green, because the module's *docstring* named
it. Prose accepted as evidence of what the code does, inside the mechanism built
to stop exactly that. It strips comments now.

> **The seal answers "has this changed?". Nobody was asking "is anyone
> listening?", and the two questions look identical from outside.**

*Found 11 August 2026 by grepping for the readers of every file in the seal —
the one question none of the previous four rounds had asked in general.*

## A test harness with a constraint nobody was told about

`sendlock.test.ts` spawns two real processes to prove that `BEGIN IMMEDIATE`
gives a single winner — the one assertion in that file that can tell the fix
from a restatement of it. It spawned them with `node
--experimental-transform-types`, and it worked for months.

It worked because `core/scheduler/sendlock.ts` had **no runtime imports**. Node's
own type stripping does not rewrite a `./x.js` specifier to `./x.ts`, so the
first time that module imported anything at runtime — the claim moving to
`core/lock/durable.ts` — the child died with `ERR_MODULE_NOT_FOUND` before
printing `ready`, and the test failed as a **30-second timeout** rather than as
an import error. The failure named the barrier, not the cause.

Nothing declared the constraint. There was no comment on `sendlock.ts` saying
"keep this import-free or a test in another file breaks", and no reason anyone
would guess it. `--import tsx` resolves the specifiers and the harness stops
caring what the module under test imports.

> **A test that only passes because of a property nobody wrote down is a trap
> with a delay on it — and the delay is measured in whoever touches that file
> next.**

*Found 11 August 2026, building the gateway (ADR-0035). Reproduced directly:
`node --experimental-transform-types -e "import {SendLock} from './sendlock.ts'"`
→ `Cannot find module '.../core/lock/durable.js'`.*

## An exit code is half a contract, and the halves failed in opposite directions **(this build)**

`muffin gateway stop` drained the turns in flight, released its claim, printed
`gateway fermato`, and exited 0. The generated systemd unit carried
`Restart=always` with `RestartPreventExitStatus=78`, and 0 is not 78 — so
`RestartSec=5` later the gateway was back. **Stop did not stop**, on the Linux
VPS that is production, and every layer of it was individually correct: the
drain drained, the CLI reported truthfully what it had done, the unit restarted
what had exited. Nothing in the repo held both halves at once.

The macOS half failed the other way and for the same reason. The plist carried
`KeepAlive = {SuccessfulExit: false}` — restart only on a non-zero exit — while
`SIGUSR1`, the *drain-and-come-back* signal the ADR takes from Hermes, exited 0.
So the one signal whose entire purpose is to restart the process left the agent
**down**, silently, on the owner's own machine.

Both were invisible to a reviewer reading either file. `service.ts` said "both
supervisors restart on any exit; the distinction is for the person reading the
log" — a sentence that was false in both directions, and the tests agreed with
it: `unit.test.ts` asserted `toContain('Restart=always')` and
`toContain('<key>KeepAlive</key>')`. Both strings were present the whole time.
A string being present says nothing about what it does to a given exit code, and
the exit code was the entire subject.

> **When a behaviour is a contract between two artifacts, test the contract, not
> either artifact: given this exit code, does the supervisor bring it back?**

*Found 13 August 2026, reviewing `slice/gateway`. The replacement asserts the
question directly, for 0, 1, 75, `EXIT_STOPPED` and `EXIT_PERMANENT`, on both
platforms — and the property neither fix was allowed to cost is in the table
too: a crash still restarts on both.*

## A presumption you cannot execute is a dependency you should remove **(this build)**

`Gateway.drain` cleared every timer, the watchdog ping included, and then waited
up to `DRAIN_BUDGET_MS` — 60 s — against a declared `WatchdogSec` of 60 s. A
drain systemd did not itself initiate (a `SIGUSR1` restart, or the `SIGTERM`
that `muffin gateway stop` sends straight to the pid) therefore meant up to
**90 seconds of watchdog silence against a 60-second deadline**: the supervisor
killing a process in the middle of the graceful shutdown it was performing.

It was probably fine. `notify.stopping()` sends `STOPPING=1` first, and systemd
plausibly stops enforcing the watchdog once a service is stopping. But
"plausibly" was the whole basis: `sd_notify(3)` documents `STOPPING=1` as *"the
service is beginning its shutdown"* and says nothing about the watchdog, there
is no systemd on the machine this was written on, and nothing in the repo
recorded that the drain depended on the answer.

The fix is not a comment explaining the risk. It is splitting the tick timer
from the watchdog timer so the drain clears only the first — after which the
question stops being load-bearing and it does not matter what the answer is.

> **An assumption you cannot execute is not a risk to document. It is a
> dependency to delete, and deleting it is usually cheaper than proving it.**

*Found 13 August 2026, reviewing `slice/gateway`. The arithmetic is the whole
finding: `DRAIN_BUDGET_MS` (60 000) ≥ `WATCHDOG_SEC × 1000` (60 000), asserted
in `unit.test.ts` so neither constant can drift into the gap alone.*

## A guard that survives every mutation is not a guard

The consolidator shipped with two "one batch at a time" checks: one in `notify`
(a turn arrived while a batch is running) and one in `fire` (the trailing edge
expired while a batch is running). Both read as obviously correct. Running the
mutation table for the slice showed that **deleting the first one broke no test
and, on inspection, changed no outcome** — the second guard caught every path the
first one covered, and the only difference the first made was to stop mid-batch
turns from counting toward the ceiling, which is behaviour we did not want.

The interesting part is not that a line was redundant. It is that the redundancy
was invisible to review and visible to a five-minute mutation run — and that the
run also found the *reachable* path neither guard had a test for: a hand-typed
`muffin memory extract` racing an armed trailing edge in the same process. That
test was written because the mutation survived, not because anyone thought of the
case.

> **Delete the guard your mutation table cannot kill, then go and test the path
> it turns out you were actually defending.**

*Found 13 August 2026, building ADR-0038. Seven mutations, one survivor, one
deletion and one new test.*

## An import is not a call, and the check that could not tell was the check

`core/rot/readers.ts` verifies that every sealed file has a *real* reader by
looking for two strings in the reader's source: the filename, and the function
named in the allowlist. It already carried one scar about evidence — the source
is stripped of comments, because a docstring saying "the first real reader of
rot/policy.json" once satisfied the filename half while no line of code opened
the file.

The symbol half had the identical hole one layer down. Mutating `cli/observe.ts`
to stop calling `loadSealedBudgets` — replacing the call with a hardcoded object,
which is precisely the defect the invariant exists to catch — left the check
**green**, because `import { loadSealedBudgets } from …` still contained the
name. Measured both ways: green with the import line, red once imports are
stripped too.

The reason it matters more than a missing string: this was the mutation run for
the slice that *closed* the budget defect. The invariant was being extended to
name the three consumers of the sealed file, so that "someone loads it" could
never again stand in for "the thing that spends money asks it" — and the
extension would have shipped unable to detect exactly that.

> **An import declares that a module may use a symbol. Only a call is evidence
> that it does — and a check that accepts declarations is a check that will
> accept the next docstring too.**

*Found 13 August 2026, mutating ADR-0039. The fix is six lines
(`withoutImports`), and the test that holds it uses an aliased import
(`import { load as yamlLoad }`) as its fixture, because an alias is the honest
shape of a name that is imported and never written again.*

## A row-by-row comparison compares the axis you were already thinking about **(this build)**

The old-vs-new inventory graded 86 capabilities and got 85 of them right. The one
it got wrong is instructive because nothing about it looks like an error.

`fetch web` was marked **"PRESENTE, più stretto"**. That is true: the new
`http_get` re-applies the egress allowlist to every redirect hop, resolves every
hostname, and refuses every private address. The old one had a single SSRF guard.
On the axis the document was counting — capability present, and how contained —
the new one wins outright.

What nobody compared was **what the model actually receives**. The old tool ran
the page through Readability and handed over text. The new one returns
`await response.text()` raw, HTML included, then keeps the first 40k characters
and the last 10k — which on an HTML page cuts through the middle of the `<body>`,
so it throws away the content and keeps `<head>` and the footer. Roughly 12k
tokens, of which perhaps 800 are text, in a turn whose output ceiling is 4096.

The inventory was written to answer "are we worse than the old one", it had the
old row with the word *Readability* sitting right there in the same table cell,
and it still passed — because the comparison was running on capability and
containment, and both were fine. It took an outside description of the same
problem, written by someone with no access to the code, to see it.

**The rule that came out of it:** when a comparison produces a verdict per row,
write down which axis the verdict is on. A row graded on one axis is not a row
that was checked; and the axes worth naming up front are *does it exist*, *is it
contained*, and **what does it hand back**. The third is the one that goes
missing, because it is the only one you cannot answer from a signature.

## The handoff that survived the compact and arrived one third short **(this build)**

The SessionStart hook exists so the START HERE block of `STATE.md` is *in*
context rather than pointed at — the failure it closes is a session rebuilding a
wrong picture from the router alone. It works. It has since the day it shipped.

It also has a documented 10,000-character cap on what a hook may emit, and it
handles it correctly: it truncates the block and appends
`[…blocco troncato: leggi docs/blueprint/STATE.md]`, so a cut handoff never reads
as a complete one. Measured while adding a paragraph to it: the block had grown
to **16,716 characters against a ~9,870 budget**. The cut was landing a third of
the way in, mid-sentence, and everything after it had not reached a session in
weeks — including the block's own *"File load-bearing — LEGGI PRIMA di lavorare"*
list, which is the section written to cure not having the files.

Nothing here was a bug. The cap is documented, the truncation is announced, the
hook is honest, and there is no test that could have gone red: the mechanism did
exactly what it says. What was missing is what is always missing — **nobody
compared what went in against what came out.** The one command that shows it
takes a second and nobody had a reason to run it, because the feature was
working.

**What it changed.** Five closed items were taking 45% of the budget: their
detail moved below the horizontal rule into the chronicle, verbatim, and the
block went to 8,993 characters with no truncation. The rule went into
`docs/PRACTICES.md` §7 with the command: what earns a place in the injected block
is what is still **open**; a finished item is chronicle.

The general shape, and the reason this belongs on this page rather than in a
changelog: a size limit is a silent failure mode wearing the costume of a
configuration value. Everything about it is documented, nothing about it is
enforced against the content, and the part you lose is always the tail — which is
where people put the pointers, because pointers feel like an appendix.

**Postscript, one day later, and it is the real lesson.** The fix above was a
rule in `PRACTICES.md` §7 and a one-off measurement. The next merge — a branch
that had been adding to the block in parallel — put it at **18,700 characters**,
worse than the state that prompted the fix, and truncated in the same place. The
rule was correct, written down, and had been read; it lost to a three-way merge,
which is the one editor that has never read anything.

Note what the test file already contained: six sizes swept across the cap,
including the exact 9,876-10,000 window that had been broken. Thorough about the
mechanism, and silent about **our** block — the one input that ships. The test
that now holds it runs the real hook against the real `STATE.md`, asserts the
tail arrives, and keeps 250 characters of headroom so the next paragraph fails
in CI rather than in a live session.

> **A budget defended by a practice is defended against people. It is not
> defended against a merge, a generated file, or anyone who did not read the
> practice — and a test suite that covers the mechanism exhaustively can still
> never once have looked at the input you actually ship.**

*Found 14 August 2026, merging `origin/dev` into `slice/gateway`: both sides had
added to the handoff, neither had made it smaller.*

## The test broke because the thing it tests works **(this build)**

`sendlock.test.ts` spawns two real processes to prove `BEGIN IMMEDIATE` yields a
single holder. It is the only assertion in this repository that can tell the fix
from a restatement of it: inside one process better-sqlite3 is synchronous, so
`IMMEDIATE` and the default deferred look identical.

Ten full-suite runs, one red: `expected [ 'got', 'got' ] to have a length of 1`.
Two winners on the lock that exists to have exactly one — the shape of finding
that stops a day, because the same file's own history says the harness is
delicate and the same claim now guards the gateway, the scheduler and the ingest
lane.

It was not the lock. The winner wrote its answer and **exited immediately**.
Under load the loser reached `heldBy` after the winner's pid was already gone,
read it as dead — which is exactly what `pidAlive` is for — and correctly took
over a free lock. Two `got`, produced by the takeover path working. The test
that proves a mutual-exclusion property was being broken by a *different*
correct property of the same mechanism, and the barrier the file already carried
was two-thirds of the way there: the handshake makes both children exist, the
hot spin makes them collide inside `acquire`, and nothing made the winner
outlive the loser's inspection.

Forced rather than argued, because a one-in-ten flake is not evidence of its own
cause: a standalone script that makes the loser wait 400 ms produced `[got, got]`
three times out of three with the old child, and `[got, refused]` three times out
of three with a child that reports and waits. The children now hold until the
parent kills them.

> **A concurrency test is a claim about an interleaving, and the interleaving is
> part of the test — not part of the environment. If nothing in the harness
> *forces* the window you are asserting about, the suite is sampling the
> scheduler, and the day it samples badly it will accuse the code.**

*Found 14 August 2026, running the suite ten times for an unrelated reason. The
cost of the wrong diagnosis is what makes this worth a page: the honest reading
of that red is "the lock is broken", and it would have been wrong.*

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

## A failure is not evidence of containment until the tool is seen succeeding **(this build)**

The probe's macOS branch ran a `(deny default)` profile against `cat /etc/hosts`
and read the non-zero exit as "the sandbox denied the read". It cannot be read
that way, and the gap is not theoretical. Measured on macOS 15, 2026-08-15:

```
$ sandbox-exec -p '(version 1)(deny default)(allow no-such-primitive)' /bin/cat /etc/hosts
sandbox-exec: unbound variable: no-such-primitive at <input string>, line 1, column 33
$ echo $?
65
```

A profile the OS refuses to *parse* fails exactly the way containment fails:
non-zero exit, stderr matching neither `ENOENT` nor `not found`. So the day a
macOS release drops one of the three primitives in `DENY_ALL`, the probe reports
the sandbox as **available** on a host where nothing was ever contained, and
`agent/runtime.ts` registers `shell_run` on the strength of it.

This is the same shape as the incident two sections up, in the branch written to
avoid it — and it survived because the branch had no test at all. `probe.ts` was
the one module in `core/sandbox/` with zero coverage.

**Instead:** the negative control needs a positive control. The probe now also
runs the same binary under `(allow default)` and requires *that* to succeed;
only then is the deny-profile failure evidence of containment rather than of a
broken `sandbox-exec`. An experiment with one arm measures the apparatus.

## A skip is only honest when something can make it fail

`core/sandbox/executor.test.ts` gated nine containment tests on
`platform() === 'darwin'`, with a correct reason written above the line: *"a
skipped containment reported as passed is how the previous system shipped a
no-op sandbox for two months"*. The reason was right and it changed nothing —
CI on ubuntu-latest, with bubblewrap installed, reported **«10 test, 9 saltati»**
and a green tick. The containment had never been executed on Linux, which is the
platform of the production VPS, on any machine, ever.

Nothing was broken, nothing was hidden, and no test could have failed. The skip
was visible in the log to anyone who read the count instead of the tick.

**Instead:** `MUFFIN_REQUIRE_SANDBOX=1`, set on the one Linux runner we have.
Where a containment is supposed to be provable, its absence is a failing test
carrying the probe's own reason; everywhere else the skip stays a skip and prints
why. The prose was already correct — what it lacked was a mechanism, which is
`docs/PRACTICES.md` §6 exactly.

## The tenant must travel with the bytes, not be reconstructed by the surface

Telegram resolved a group principal and tenant correctly, then handed the
attachment to a callback whose contract carried only trust tier. The production
callback filled the missing tenant with `host`. Every identity and policy test
stayed green: the loss happened after identity resolution and before indexing.

The document-arrival test copied that callback exactly and used only the owner
chat, so it proved the hardcode. **Instead:** the connector-vault boundary takes
`tenantId` explicitly, and the production-path test begins with a group update,
observes the group store, proves the host store empty, and reopens the document
through the actual tool.

## The right tenant does not repair the wrong source set

After carrying `tenantId` correctly, attachment ingress still called the full
vault reconciliation. That operation enumerated a shared physical directory,
so a group member sending one file caused private host notes and another
group's files to be indexed into the caller's tenant. The first integration
fixture had an otherwise empty vault and could not observe the leak.

**Instead:** arrivals call `reindexPath(tenantId, savedPath)` and full `reindex`
is reserved for explicit maintenance. The production-path test begins with a
host note and a second group's attachment already present, then asserts search
and drill-down isolation in every direction. Scope belongs to the source set as
well as the destination identity.

## A compressed input limit is not an output limit

The vault refused files above 20 MB and still allowed a tiny DOCX to expand
without bound in `inflateRawSync` — twice, because sniffing decompressed the
same entry as extraction. Container size is not resource containment.

**Instead:** sniff from the central directory without inflation; reject a
declared expanded size over budget; and independently pass `maxOutputLength` to
the inflater because the declaration is attacker-controlled. The test for the
second guard lies in the central directory on purpose.

## Indexed and readable are one guarantee

An external symlink was treated as an ordinary note by `reindex`, while
`document_read` correctly refused its realpath. Recall advertised a document
whose promised exact source could never be opened. Allowing the later read
would turn the mismatch into TOCTOU: retarget the link after indexing.

**Instead:** until content is materialised inside immutable vault storage,
external symlinks are skipped with a visible reason. A test asserts all three
sides together: no index row, a named skip, and no drill-down.

## Unknown external state is not open work

The delegation handoff converted every command failure to an empty string.
When `gh pr list` failed, an empty PR list meant every registered branch became
“no PR” and therefore actionable, including branches already merged into
`dev`. The fallback did not have less context; it manufactured positive state.

**Instead:** Git ancestry decides integration first. GitHub only enriches it
with PR numbers and remote state. Anything ancestry cannot settle during a
GitHub outage enters a separate `SCONOSCIUTE` section that explicitly forbids
resume until verification; it never enters `APERTE`.

## A guarantee that holds on two paths and not the third is not a guarantee **(this build)**

Recall finds a fact two ways: a one-hop graph expansion from a matched entity,
and a semantic match against the vector index. Making `--history` and
`asOf` correctly exclude, include and label a superseded fact touched only the
graph path — because that is the path the bug report and the acceptance
scenario were both written against. The vector half kept calling
`provenanceOf`, a method with no notion of `expired_at` at all, and fused
every semantic hit with no `expired` field, ever, on any path, under any
option.

Nothing re-embeds a fact when it is superseded, so its old text stays in
`chunks_vec` and stays semantically findable forever. A combinatorial sweep
over `asOf`/`surface`/`since`/`until`/`neighbours` (60 combinations) returned
the retired fact looking active in all 60 before the fix, 0 after — not a
narrow edge case, the default behaviour of the half that answers a paraphrase.
The same shape a few lines away would have made the fix in the graph hop look
complete: `--history` would have worked, `muffin memory search "chi era Marco"`
would have worked, and a semantically-phrased question against the same data
would have quietly answered with a belief that had already been retired.

**Instead:** the vector half now reads a fact through `factById` (the same
full row the graph hop reads) rather than through a second, narrower
provenance query, and gates on `expiredAt`/`includeSuperseded` with the exact
same `successorOf` helper the graph hop calls — one rule, read from two call
sites, instead of two copies that could drift. The regression test was run
against the original vector-half code with the gate temporarily removed and
confirmed to fail before being restored (`core/memory/recall.test.ts`, "does
not let a superseded fact surface through the semantic half either").

## A required parameter missing from a call site is invisible when the failure is swallowed by design **(this build)**

`connectors/telegram/api.ts#sendMessageDraft` sent `{chat_id, text, parse_mode}`
to Telegram's Bot API. The method's real contract — verified against Context7's
mirror of the official reference and the changelog, 2026-08-17, while building
M5-BIS B11 — requires a fourth field, `draft_id`, non-zero. Every call this
adapter ever made was missing it, so every call answered 400.

Nothing noticed, for one reason: `connectors/telegram/presence.ts` calls this
method only inside `safely()`, a wrapper written on purpose to swallow any
presence failure — "a typing indicator that takes the turn down with it has
inverted its own priority" — because showing the owner a real answer must never
be blocked by a decorative heartbeat failing. That design is correct. Its
consequence, unexamined, is that a call which *always* fails looks identical to
one that occasionally does: no error surfaces anywhere, `doctor` has no probe
for it (there is no token to probe with in development, and PRACTICES §2's own
rule for that case — do not assume, drop the dependency — was not applied
here; it was assumed instead), and the docstring above the call read "the
keepalive exists from day one," stated as if day one had ever worked.

The claim was inherited, not verified: `docs/blueprint/adr/0025-transport-
telegram.md` described `sendMessageDraft`'s contract from the old Muffin
system's own history (its ADR-133/138) and was never checked against the
current Bot API in this repository. The inherited fact carried the missing
parameter along with it.

**Instead:** the signature is now `sendMessageDraft(chatId, draftId, text)`,
matching the verified contract, and `ADR-0025` carries a dated §revisione
naming exactly what was corrected and what could not be re-verified either way
(the draft's exact TTL-refresh behaviour — no token to probe with, so the
mitigation is a conservative call cadence rather than an assumed number). The
general lesson: a swallowed failure needs a *positive* signal that the
mechanism it guards ever succeeds — a counter, a trace attribute, something a
`doctor` check or a test can read — not only the absence of a visible one.

## Cleanup after a merge is conditional on the merge, not on the intent to merge

`gh pr merge 39` failed (the map file had been regenerated on both sides), the
failure was printed, and the next command in the same script still deleted the
branch — locally and on `origin`. GitHub then closed the PR because its head no
longer existed. The commit was recovered from the object store and the branch
re-pushed, so nothing was lost; the PR had to be reopened by hand.

**Instead:** delete a branch only after reading `mergedAt` for that PR (or
`git merge-base --is-ancestor`), never in the same breath as the merge command.
The rule was already written for the reverse case (`cmd | tail` hides the exit
status): the mistake here was acting on the *plan* rather than on the *state*.

## A line of error that saves our own sentence and not the model's answer is a failure that cannot be explained **(this build)**

Real install, 2026-08-16, OpenRouter with light = `anthropic/claude-haiku-4.5`.
The REPL printed `consolidamento: giudice non disponibile su owner/interest:
tengo entrambi i valori` three times running, once for `owner/asked_to`, and
`muffin memory review` showed 4 rows in the archive, 0 to decide. Nothing
distinguished the four occurrences: same sentence, no model output, no
reason. `judge.ts` builds that sentence itself, in the code, whenever the
light model's answer could not be turned into a verdict — an empty response,
prose with no JSON, or JSON the schema rejects were three different problems
and all three produced the identical fallback text. The durable
`memory_review` row that was supposed to be the record of what happened
recorded only what *we* say when we do not know what happened.

The repeat count compounded the opacity rather than adding information:
`core/memory/consolidator.ts`'s per-round log printed one line per candidate
fact `reconcile` judged, not one per distinct failure, so three candidates on
the same (subject, predicate) that each failed the judge produced three
copies of a sentence that already said nothing.

**Instead:** the judge distinguishes *why* it could not answer
(`JudgeFailureReason` in `core/memory/judge.ts`: empty · non-JSON · a named
schema field) and carries the model's own sanitised, truncated response
alongside it; `ingest.ts` writes both into the review row's `detail` — first
line the typed summary, everything after it the raw answer, so
`muffin memory review` shows the reason by default and `--verbose` reveals
the model's words without a second column or a migration (`detail` stays
free text, per `store.ts`'s own note that a register tracking more than that
would be the workflow engine this was asked not to become). Before writing
any of that off as "unavailable", the schema now tolerates the innocuous
shapes a light model actually produces — a quoted `confidence`, a
Title-Cased key, `"  Supersede  "` — via typed zod coercion, so a real
answer is not thrown into the same bucket as no answer at all; an
unrecognised verdict still is, deliberately. The per-round log folds
repeats by (subject, predicate) instead of printing one line per candidate,
which is the direct fix for the three-times-running symptom above.

Each of the three claims — the raw response reaches the row, the tolerant
parsing does not swallow real verdicts, the log stops repeating — has a
mutation-tested regression: `core/memory/ingest.test.ts` (typed reasons and
raw response; removing the save turns the assertions red), `judge.ts`'s
coercion (removing `z.coerce.number()` or the key-normalisation turns the
"tolerates innocuous formatting" tests red on exactly the shape it was meant
to fix), and `core/memory/ingest.test.ts`'s `formatConsolidationLines`
suite (reverting to `report.errors` verbatim reproduces the three-line
symptom in the test itself). A fourth, smaller instance of the same family
turned up wiring this fix in: `Consolidator.execute()`'s own internal logger
and `cli/memory.ts`'s `cmdMemoryExtract` each printed the grouped line
independently, so a hand-typed `muffin memory extract` still showed it
twice until the internal logger learned to stay quiet on `trigger:
'manual'` — caught by running the real binary
(`evals/acceptance/scenarios/e-cost.accept.ts`, E5), not by either unit
suite alone, because each printer's own test only ever looked at itself.

## An atteso-rosso that accepts any error is a test that cannot notice it has become false **(this build)**

`evals/acceptance/scenario.ts` ran every M5-BIS row still marked "missing" as
`it.fails`, which only answers "did it throw". D10's manifest reason named
`slice/taint-in-ingresso` as the branch that would close it; that slice
merged 2026-08-15 and a judge on PR #28 closed its failure-path gap the next
day, but the row stayed "atteso-rosso" for two more days because the
scenario's own assertion queried `turn_tool_calls` for a call the kernel
*denies* — which never reaches `runTool`'s execution path, so it never wrote
that row even on the day the fix landed. The scenario kept throwing, for a
reason unrelated to the one the manifest named, and `it.fails` cannot tell
the two apart.

**Instead:** `atteso-rosso` entries now carry a required
`expectFailure: RegExp | ((error) => boolean)`, checked against the actual
thrown error inside a plain `it`. A throw that matches is still correctly
red; one that does not is `rosso-inatteso`, not "va bene così".

> **A test that can pass no matter what broke is not weaker evidence than no
> test — it is evidence with the sign flipped, because the row it covers now
> reads "verified" to everyone who has not read the assertion.**

## Symlink resolution has to cover the leaf and the parent, not just the middle **(this build)**

`agent/tools/fs.ts`'s `resolveInScope()` already had a test named exactly for
this — *"is not fooled by a symlink that leaves the scope"* — and it passed,
on every commit, while two other symlink shapes walked straight through.

The function resolved a symlink that sat in the *middle* of a path (a
directory somewhere above the file actually being touched) correctly from the
start: `realpathSync` on a longer path always resolves an intermediate
component, so nothing special had to be written for that case and nothing
was. What it never resolved was the *exact path requested* — the terminal
component — nor a symlinked *ancestor found by walking up* because the
requested file did not exist yet. Both took the same branch, written for a
third, narrower case (a write must refuse a terminal symlink outright,
never resolve it), and that branch returned the link's own location with its
parent canonicalised — never the target. So `resolveInScope` computed a path
that was inside `root` by construction, on exactly the two shapes where the
underlying `readFileSync`/`readdirSync`/`writeFileSync` does not stop at the
link: it follows it, all the way, because that is what the terminal
component of a path means to the OS. A `denyRead` secrets directory reached
by a symlink placed anywhere inside `root` was readable verbatim; `fs_write`
of a *new* file through a symlinked parent directory landed wherever the
link pointed. Both shipped past a green suite and past `STATE.md`'s own
record of "closed" (2026-08-06: *"quattro bypass del containment fs
[...] chiusi"* — dangling symlink, hard link, case, and the read-side
deny-list skip; none of those four is a terminal symlink or a symlinked
parent). Found by the 2026-08-16 adversarial audit (P29 CRITICAL, P28
MEDIUM), closed in `slice/fs-containment`.

**Instead:** when a function's job is "resolve whatever the OS will actually
touch", enumerate the path's own components explicitly — *the exact
requested path*, *every ancestor reached by walking up*, *every intermediate
component along an existing prefix* — and ask the symlink question of each
one by name, rather than writing one branch and trusting it to fire on
every case a single test happened to construct. A test named for the general
property ("is not fooled by a symlink") tests the one shape its author
built a fixture for; the shape the author did not think of stays green by
never being asked. `docs/PRACTICES.md` §5's "test the wiring, not the logic"
is usually read as "does production call this at all" — the same rule
applies one level down, to whether a test's *fixture* actually exercises
every branch its *name* claims to cover.

## A swallowed intent write makes "not started" and "started" indistinguishable **(this build)**

`agent/loop.ts`'s two-phase tool record (ADR-0042 §6) exists to turn a crash
mid-call into a fact instead of a guess: an intent row with no outcome row
reads as "maybe done", and a non-rerunnable tool's resume refuses to repeat it
for exactly that reason — the whole point of writing the intent row *before*
the handler runs. `runTool` wrote that row through `deps.turns.startToolCall`
inside a `try/catch` that swallowed the error and let `tool.handler` run
regardless, justified by a comment that reasoned from `checkpoint`'s own
swallow: a tool that worked must not be turned into a failed turn by a
bookkeeping write.

That reasoning holds for the *outcome* write and does not hold for the
*intent* write, because the two are not symmetric. A crashed outcome write
leaves the row open, which a resume already treats as uncertain — the
harmless direction, and `recordOutcome` still swallows on purpose today. A
crashed **intent** write, with the handler left free to run anyway, leaves
*no row at all* — which a resume reads as "never started" and reruns. For a
non-rerunnable tool (a message send, a shell command) that is the exact
double-effect the two-phase record was built to prevent, produced by the
mechanism meant to prevent it. `docs/blueprint/gate1/MANDATO-DAY-1.md` names
this invariant 1, "EFFECT WAL", and states the failing shape verbatim:
*"Provo a registrare l'intent e, se fallisce, continuo" NON soddisfa la
proprietà* — which is a description of the code as it stood, not a
hypothetical.

A companion gap sat one level down in the same table: `TurnStore.
endToolCall`'s `tier` parameter was optional, so a caller that omitted it
wrote a silent `NULL` and skipped the taint bump with no error anywhere
(audit P05, BLOCKER,
`docs/blueprint/research/triage-2026-08-17/e-audit-trasversali.md:153`) —
even though `ToolOutcome.tier` was already required one level up (ADR-0044).
The guarantee lived in the caller's discipline, not in the callee's type:
ORCHESTRATION.md §15's exact shape of "the type permits the wrong state",
where the fix is the same move it names — a form that fails on its own, not
one that depends on someone remembering.

*Found and fixed in `slice/wal-intent`, following the 2026-08-17 triage that
named it the first item on Gate 1's critical path.*

**Instead:** `runTool` now treats the intent write as a precondition, not a
courtesy — `startToolCall` failing refuses the call outright, before
`tool.handler` is ever reached, for every tool alike (`rerunnable` decides
nothing here; the gate sits upstream of that question, one rule instead of
one per tool). The refusal is an honest `tool_result` error the model reads
like any other tool failure, at tier 0 — no byte entered this process for the
call, so nothing raises taint — and there is no `endToolCall` for a call that
never got an intent row to close. `endToolCall`'s `tier` became mandatory in
the signature; every real caller already passed it, so `tsc` was the only
thing that needed to check.

`agent/turn-record.test.ts` proves the gate by mutation, not just by
addition: reintroducing the swallowed `try/catch` turns the new
non-rerunnable and rerunnable cases red (the spy handler is called even
though `startToolCall` threw) while every other test in the file, including
the happy path, stays green — the failure is specific to the removed gate,
not a side effect of a broader breakage.
