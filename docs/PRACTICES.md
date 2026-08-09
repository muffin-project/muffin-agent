# Operating practices

`AGENTS.md` holds the lessons; this holds the process that makes them
structural. Every practice here has a **trigger** — a practice without one is a
wish — and a source. Kept short on purpose: a rules file that bloats gets
skimmed, and skimmed rules are prose, not process.

The ranking that governs everything below, from the people who build the
tooling: **hooks are deterministic, instruction files are advisory.** A rule
that must not depend on discipline belongs in a hook or a test, not in a
paragraph. Prose reduces wasted exploration (measured: −29% wall-clock with an
AGENTS.md present); only checks reduce bugs.

---

## 1. Docs before APIs

**Trigger: about to call a library function you have not called in this file
before, or to add a dependency.**

Read the real documentation first — Context7 MCP (`resolve-library-id` →
`query-docs`) or the official docs — not the type signatures. Types are
generated from a schema; they do not say what the server does under an edge
case, which arguments are mutually exclusive, or what silently changed in the
last release.

The reason is measured, not hygienic: frontier models in 2026 hallucinate
package names at **4.6–6.1%** (arXiv:2605.17062, 199k prompts against the live
registries), and 53 of the names every model invents identically were still
registrable — which is the supply-chain attack (slopsquatting), not a typo.
Doc-grounding reduces this; nothing eliminates it, which is why the next rule
exists.

New dependency: justify it in the commit (what it replaces, why not stdlib),
check maintenance is alive (last release, open-PR age) — this repo runs on 6
runtime dependencies and the risk is always the next one.

## 2. Probe what is load-bearing

**Trigger: a library behaviour is about to decide a design, and the docs did
not settle it in five minutes.**

Write the ten-line script and run it. Two named variants, both already in this
codebase before they had names:

- **Spike** (XP): throwaway script, keep only the conclusion as a comment where
  the decision lives. This is how we learned vec0 wants BigInt rowids, that
  `PARTITION KEY` exists, and that `ALTER TABLE RENAME` on a vec0 table strands
  its shadow tables — each probe changed a design.
- **Tracer bullet** (Pragmatic Programmer): when the behaviour can silently
  *stop* being true in production (a sandbox that regresses, a capability that
  degrades), the probe becomes permanent and wires into `doctor`. That is
  `core/sandbox/probe.ts`.

Pick by risk: one-time design question → spike; can regress silently → tracer
bullet in `doctor`.

## 3. Prior art before shape

**Trigger: designing anything a person or another program will hold — a CLI
verb, a file format, an exit code, a config key.**

Look at three comparable tools first, and at the field's reference (for CLIs:
clig.dev, GNU standards) — then decide, and record what you rejected. The shape
of `muffin telegram send` was invented instead of checked, and it was wrong the
day it shipped.

The decision record already has the right form (Context / Decision /
Alternatives rejected / Reversibility). The change is scope: it applies to
these small outward-facing choices too, not only to numbered architecture
decisions. Three lines in the commit message is enough; the point is that the
alternatives were *looked at*, not that a document exists.

CLI specifics, verified across gh/git/cargo/npm/claude and clig.dev: bare
command = the product's one gesture; noun-verb for operator commands; stdout is
the result, stderr is everything else; `--help` and `--version` everywhere (GNU
baseline); secrets from stdin, never argv; config hierarchy flag > env > file;
foreground always — the platform (`daemon(7)`) daemonises, the program does not.

## 4. Parse at the boundary, or it did not happen

**Trigger: data crosses into the process — CLI args, a model's JSON, an HTTP
response, a row from a table better-sqlite3 cannot type.**

A zod schema at the crossing, and the schema *is* the type (`z.infer`), never a
copy of it. `as` on external data is not parsing — Google's style guide allows
assertions only with an explicit reason precisely because they insert no
runtime check. The config loader is the shape to copy: version first, then
schema, and the error names the field.

Inside the process, where invariants are already established, `as` with a
comment is acceptable. At the boundary it is how `0 >= undefined` becomes a
spend cap that does not exist.

## 5. Test the wiring, not the logic

**Trigger: adding any guard, cap, check or defence.**

Write the test that fails **without the wiring** — the one that proves
production reaches the mechanism — before the tests that prove the mechanism's
logic. Four defences in this repo had correct logic, green tests, and no
caller. The logic has never been the thing that was wrong.

Corollary for fixes: reproduce first. Every fix in this repo's history that
mattered shipped with a test verified to fail on the previous commit. A test
that cannot fail is documentation wearing a test's clothes.

## 6. Escalate from prose to mechanism

**Trigger: the same mistake happens twice, or a rule matters enough that
"remember to" is not acceptable.**

The ladder: comment where the decision lives → entry in `lessons.md` with the
evidence → invariant/test that fails loudly → hook that blocks. Each step is
more deterministic and costs more; climb only as high as the mistake warrants.
A `PreToolUse` hook guarding `npm install` against unknown packages is the
worked example: new dependencies are rare here, so the friction is near zero
and the slopsquatting window closes structurally.

## 7. The state lives in STATE.md, and it is written before it is needed

**Trigger: a session starts · a compact is near · a slice of work ends.**

`docs/blueprint/STATE.md` is the handoff. Its START HERE block is the answer to
"where are we", and it is authoritative — if this file and your recollection
disagree, the file wins.

Three moments, three different mechanisms, deliberately:

- **Session start — mechanised, not remembered.** `.claude/hooks/inject-state.mjs`
  injects the block on every SessionStart, *including after a compact*. The
  premise is documented rather than assumed: *"Project-root CLAUDE.md survives
  compaction: after `/compact`, Claude re-reads it from disk and re-injects it
  into the session. Nested CLAUDE.md files in subdirectories and rules with
  `paths:` frontmatter are not re-injected automatically"* — Claude Code docs,
  Memory, "Instructions seem lost after /compact". STATE.md is nested behind a
  pointer, so it is exactly what does not come back on its own. This is practice
  §6 applied to the rule "read STATE.md first", which as prose was skipped often
  enough to cost whole sessions.
- **Before a compact — a practice, because the *model* cannot be made to do it.**
  A `PreCompact` hook can run a command and can block compaction; it cannot
  inject context, because `PreCompact` is absent from the documented list of
  events whose `additionalContext` reaches the model. So it cannot ask the model
  to write anything. It *could* persist a snapshot itself from a shell command —
  "cannot be mechanised at all" would be too strong. What is true is narrower and
  is the part that matters: the judgement about what the live state *is* has no
  mechanism. When context is running short: update the START HERE block *first*,
  then let the compact happen.
- **End of a slice — commit.** A commit is the only form of state that survives
  everything. The block says where we are; the commit says what is true.

The honest summary: re-grounding is deterministic, flushing is not. Knowing
which half is which is the point.

## 8. Converge before you research

**Trigger: about to dispatch research, or about to open more than one line of
enquiry at once.**

Lock the scope first — the question, and what an answer would change. Broad
research against an unlocked scope produces a survey nobody can act on, and the
cost lands twice: the reading, and the re-deciding it invites.

The shape that works here: state the decision the research is *for*, name what
would flip it, and ask for evidence quality per claim (measured · reported ·
folklore). The salience research (`research/memory-salience-and-fusion.md`) is
the worked example — it was commissioned to decide one field's type and one
ranking question, and it came back saying the field's own tradition rests on an
unablated hyperparameter. That is only a usable answer because the question was
narrow enough to be falsified.

## 9. Pure-muffin and your-muffin are separate things

**Trigger: about to add anything that encodes a person — a voice line, a
threshold, a fact, an example, a default.**

Two categories, and the boundary is what ships:

- **Pure muffin** — what every install gets: the character, the prompts, the
  primitives, the floors. Open-source, reviewable, the same for everyone.
- **Your muffin** — what is learned at runtime about one owner: facts,
  thresholds that adapted, the person-model. Lives only in `~/.muffin/`, never
  in the repo, never in a fixture.

Getting this backwards has two distinct failure modes and both are bad: a
personal detail baked into the repo ships someone's life to every contributor;
a piece of the character left to runtime learning means a fresh install has no
character at all and reads as a mockup.

The related rail: **a real harness, not slop.** A principle becomes a property
of a primitive that already exists — a column, a ranking term, a gate — with its
own test. It does not become a module bolted on beside the thing it describes.
That rule is stated at the top of `docs/blueprint/knowledge/README.md`, and it
is why the cognitive corpus is a design input rather than a folder of adapters.

---

*Sources: Anthropic engineering (hooks vs advisory, verbatim), arXiv:2605.17062
and USENIX '25 (hallucination rates), clig.dev + GNU Coding Standards +
`daemon(7)` (CLI and process conventions), Google TypeScript Style Guide
(assertions), Alexis King (parse don't validate), Beck/Hunt-Thomas
(spike/tracer bullet). Full research reports in the blueprint repo under
`.claude/agent-memory/research-scout/`.*
