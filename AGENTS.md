# Working on this repository

For agents — including this project's own agent, once it can work on itself.

Read `docs/THESIS.md` for what this is betting on and `docs/DESIGN-PRINCIPLES.md`
for how decisions get made. `docs/BRANCHING.md` says where work lives and what
`main` means — including the rule that remains a convention rather than a
mechanism because the repo has no branch protection. CI exists and verifies
PRs plus pushes to `dev`/`main`; it cannot by itself forbid an unchecked merge.
Read `docs/lessons.md` before you add a guard: it is
a list of guards this repository already wrote and failed to connect.

## The one rule that has cost the most to learn

**A mechanism working is not the same claim as the outcome being right, and only
the second one is worth asserting.**

Four separate defences here had a schema, passing tests, and a caller waiting on
them — and were reached by nothing. The budget engine never recorded, so its caps
were decorative. Safe mode was computed and never handed to the kernel, while the
CLI told the user capabilities were denied. The invariant written for an incident
where every vector table sat empty skipped in silence in exactly that
configuration. A sandbox probe ran an allow-all profile and reported "a real
containment ran and held".

So: **when you add a guard, write the test that fails without its wiring**, not
the test that proves its logic. In this codebase the logic has never been the
thing that was wrong.

**The process document is `docs/PRACTICES.md`** — nine practices, each with the
trigger that fires it. This file is why; that file is when. **`docs/JUDGE.md`**
is what a review asks: the standing questions, the verdict labels, and the rule
that a reviewer reaches the guarantee from production rather than reading the
diff — because the defect above was in neither diff.

## Before you change anything

- `npm run build` (`tsc --noEmit`) and `npm test` both clean. Tests passing while
  the build fails has happened here; run both.
- Research before an architectural choice, not after. A chunker was written from
  intuition and thrown away when three hours of reading said the intuitive answer
  loses on this corpus — see `docs/blueprint/adr/0024`. Chunking looked like an
  implementation detail. It decides what recall *can* find.
- Probe, don't assume, when a library's behaviour is load-bearing. `vec0` renames
  a virtual table without renaming its shadow tables; `sqlite-vec` supports
  partition keys; Ollama does not expose pre-pooling token embeddings. All three
  changed a design, and all three took one script to establish.

## Shape of the thing

```
core/      policy kernel · root of trust · tracing · budget · config
           memory (episodes, bi-temporal graph, recall) · vault
agent/     the loop · providers · per-model profiles · tools · context
cli/       the surfaces: repl, run, memory, vault, doctor, trace
evals/     capability floor · memory acceptance · voice drift
```

`core/policy/decide.ts` is the kernel: pure, synchronous, total. Every capability
request goes through it. It has been reviewed line by line and the problems have
always been in its callers — start there before suspecting it.

Data lives only in `~/.muffin/`. A `git pull` must never be able to touch
anyone's identity or memory.

## Conventions that are not preferences

- **English** in code, commits and anything facing outward. **Italian** for the
  persona, the prompts and the design records. Never the same content in both —
  see `docs/blueprint/adr/0020`.
- Comments explain *why*, and especially why-not. A comment restating the code is
  noise; a comment recording the failure that produced the line is the reason the
  line survives a refactor.
- Never delete rows. `expired_at` and `superseded_at` retire things without
  destroying them, which is what makes "what did I think in May" answerable.
- Trust never rises. A fact cannot be more trusted than the sentence it came
  from, a reindex cannot launder a downloaded file, and a vector match is not
  evidence of provenance.
- Secrets are read from stdin, never from argv, and never printed. If one reaches
  a log or a transcript, it is rotated, not redacted after the fact.

## What not to reopen

Decisions with a record behind them, in `docs/blueprint/adr/`: rigid S→P→O
triples (an in-house constraint silently corrupted 89 beliefs), an explicit
planning layer in the loop, semantic chunking, late chunking, a dynamic model
router, headless browsers. Each has an ADR with the evidence. Bring new evidence
or leave them alone.
