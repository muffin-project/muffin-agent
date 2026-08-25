# Repository-wide reconciliation — 2026-08-22

> **Superata — evidence storica, non un piano d'azione.**
> Questa passata fotografa il repository al 2026-08-22. Il 2026-08-25 la
> milestone RETURN TO OWNER (`docs/blueprint/M5-BIS.md`) ha riclassificato le
> righe che qui risultano da costruire: A6/A7/A8 (migrazioni versionate,
> backup validato) e D12 (l'ASK che mostra l'azione) hanno ora un meccanismo
> in HEAD e residui di sola osservazione. Anche i conteggi di branch qui
> elencati sono relativi a un `dev` di circa trenta commit fa.
> Chi legge questo file come lista di lavoro rifà cose già chiuse.


**Role:** dated evidence snapshot, non-normative.  
**Baseline inspected:** `dev@81a61ead94f1cc18800b2623e84138fb7b2a0a06`.  
**Architecture consolidation branch:** `idea/runtime-topology`.

This pass exists because branch ancestry is not semantic authority. A diverged
branch can look large while all of its useful content has already been
cherry-picked/moved into `dev`; a tiny WIP can contain one bug fix that is still
missing. The pass therefore compared branch topology and then inspected the
actual files/claims that could represent a more advanced version.

Current truth remains typed by `docs/README.md`: executable state owns mechanics,
Architecture/Security own current semantics, ADRs own decisions/history, M5 owns
Gate state, Roadmap owns deliberate future phase placement.

## 1. Complete branch inventory

The repository had 15 branches at the time of this pass.

| Branch | Observed relation to `dev` | Reconciliation |
|---|---:|---|
| `dev` | baseline | Current integration base. |
| `main` | 205 behind, merge-only lineage ahead | Release snapshot, not source for current architecture. No newer semantic direction found. |
| `idea/local-agentic-runtime` | 1 ahead | Its local-compute proposal is already carried forward and expanded in `idea/runtime-topology`; original branch can later become historical once that lineage is safely integrated. |
| `idea/runtime-topology` | consolidation branch | Holds the current repository-wide architecture reconciliation: Home/Node/Surface/Worker, smart ingress, memory writer ownership, roadmap phase placement and peer-harness distillation. |
| `slice/brand-v0.1` | 6 ahead | Despite the name, observed net files are the same cognitive-design stack as `slice/cognitive-design-readme`, not a separate brand architecture. No unique architecture found. |
| `slice/cognitive-design-readme` | 6 ahead | More advanced cognitive/human-first programme. `COGNITIVE-DESIGN.md`, its evidence audit, Vision framing and Public Narrative have been mediated into `idea/runtime-topology`. Public README stacking remains separate public-work concern. |
| `slice/deleghe-no-slug` | identical | No unique content relative to current `dev`. |
| `slice/docs-authority` | 2 behind, 0 ahead | Already integrated lineage; no unique current content. |
| `slice/inbound-unit` | 4 ahead / 29 behind | **Unique runtime work. Preserve and mediate.** Durable inbox/idempotency/fault evidence is valuable; `update_id → one Turn` is too strong after ADR-0052. Must be reconciled rather than merged mechanically. |
| `slice/product-open-source-direction` | 10 ahead / 55 behind | Old code lineage; durable conclusions already absorbed into current THESIS/EXTENSIONS/OPEN-SOURCE-STRATEGY/PUBLIC-NARRATIVE. Its three unique-looking research notes are already byte-identical under `docs/blueprint/research/` on current lineage. No hidden architecture remains. |
| `slice/readme-open-source-v1` | 53 ahead | Stacked public/cognitive work plus root README/brand assets. Cognitive semantics have been mediated into topology; root README/brand remains separate public-surface work. Do not use this branch as architecture authority. |
| `slice/recall-speaker` | 4 ahead | **Unique CRITICAL runtime work. Preserve.** Speaker/role provenance in recall is directly compatible with Evidence/Beliefs and ADR-0051; it must be proven/merged on its own path. |
| `wip/deleghe-mai-registrata` | 1 ahead / 55 behind | **Unique repository-workflow fix. Preserve until reconciled.** Current `dev` has an inline `(mai registrata)` mitigation and even comments that the complete constant/count/tests are expected from another session; WIP contains that fuller treatment. Not product architecture. |
| `wip/main-checkout-2026-08-17` | 3 ahead / 205 behind | Historical recovery snapshot. `persona.md`, `identity.md`, `voice.md` are byte-identical to `dev`; its `DAY1-CUTOVER.md` is a precursor to the smaller current Mandato/critical-path authority. Its older loop wording is superseded. Verify only bookkeeping residue before branch deletion; no newer product architecture found. |
| `wip/repl-linereader-pipe-eof` | 2 ahead / 326 behind | **Unique runtime bug fix/evidence. Preserve until reconciled.** Current `dev` still uses `rl.question()` in the REPL loop; WIP adds a queued line reader and real spawned-process tests for multi-line pipe/EOF/partial-last-line behaviour. Not an architecture fork, but potentially DAY-1 reliability debt. |

### Important compare caveat

For diverged branches, GitHub compare is merge-base oriented; a file listed as
"added" does not prove `dev` lacks the same semantic content. That is why this
pass checked current file blobs/contents for the branches that appeared to carry
new direction.

## 2. What was actually missing from the current architecture branch

### Cognitive design

The cognitive branch contained a genuinely more advanced domain authority:

- human-first = augmentation/complementarity, not brain emulation;
- external scientific grounding and Muffin product evidence are separate axes;
- cognitive mechanisms have explicit kill criteria;
- legacy cognitive failures are negative evidence, not embarrassing history to
  delete.

This is now carried into `idea/runtime-topology` as:

- `docs/COGNITIVE-DESIGN.md`;
- `docs/blueprint/research/cognitive-design-audit-2026-08-19.md`;
- reconciled `docs/VISION.md`;
- reconciled `docs/PUBLIC-NARRATIVE.md`;
- reconciled authority map in `docs/README.md`.

The topology branch remains more advanced on Home/Node/Surface, busy input,
placement and device locality, so the final Vision is a synthesis rather than a
copy of either branch.

### Runtime topology

Older ADRs and comments had allowed "one Muffin" to drift toward "one process".
The current reconciliation makes the invariant explicit:

```text
one durable continuity
one active authoritative Home
N Nodes
N Surfaces
N Workers/compute targets
```

Process boundaries are chosen only when they buy isolation, lifecycle, resource
or placement properties. This does not create microservices or multiple
canonical authorities.

ADR-0001 has been amended accordingly: TypeScript/Node remains the canonical
Home runtime, while a permanent language-appropriate worker (for example local
ML/transcription) is valid when the boundary has a real consumer.

### Smart ingress

The active inbound branch exposed a deeper product requirement that was not
captured by `update → Turn`:

```text
NativeEvent != UserIntent != Work identity
```

ADR-0052 now owns this shape:

```text
native event(s)
→ durable typed fragments + provenance
→ surface-specific assembler
→ user intent
→ durable Work
```

Transport exactly-once remains mandatory. Multiple events may compose one Work;
later events may STEER/FOLLOWUP/COLLECT/INTERRUPT existing work at safe
boundaries. Original media is Evidence; transcript/OCR/caption are derived;
provenance/taint remain per part.

### Intentional memory

ADR-0032 had intentionally left one fork open. Owner decision closed it through
ADR-0051:

```text
many producers
→ durable candidate/proposal
→ one Home-owned semantic reconciliation path
→ canonical Belief
```

The model can decide what seems worth remembering; it cannot bypass source,
provenance, taint, contradiction and supersession semantics by directly writing
active truth.

### Deferred work phase ownership

`OUT` in M5 answered only "does this block the 14-day Gate?" and therefore lost
where deliberate deferrals should return.

`docs/ROADMAP.md` now owns **phase placement only**:

```text
DAY-1
→ 14-day dogfood
→ MVP / trusted alpha
→ public alpha / open-source readiness
→ post-MVP product/hardware
→ research / consumer-triggered
```

It does not duplicate Gate status or active work.

## 3. Architecture closure outcome

After reconciling all observed branch directions, peer-harness evidence and the
current authority documents, no unresolved fork was found where two incompatible
semantic models both remain plausible and require an owner decision **today**.

Closed high-level choices include:

- one continuous agent, not one process/device/model;
- Evidence · Beliefs · Work · Effects · Authority;
- one active Home, many Nodes/Surfaces/Workers;
- Node local authority ceiling cannot be bypassed remotely;
- Home placement is deployment, not identity;
- event/intent/work are distinct;
- surface-specific composition and busy-input semantics;
- multipart multimodal input with per-part provenance;
- many memory producers, one semantic Beliefs writer;
- effect intent/outcome uncertainty and reversible ≠ rerunnable;
- snapshot/undo precondition fails closed when it is what makes a reversible
  effect safe;
- SQLite remains appropriate; topology does not imply a DB service;
- package ≠ capability ≠ grant;
- cognitive mechanisms are falsifiable product hypotheses, not architecture by
  metaphor;
- active-active/multi-Home and degraded authoritative offline operation are
  research, not hidden MVP requirements.

Implementation mechanics deliberately left open — Node transport, exact Telegram
coalescing window, first Node capability, worker language/process placement,
MemoryProposal schema, whether an Intent table ever earns a consumer, local
model/router choice — do not currently alter these ownership semantics.

## 4. Branches that must NOT be deleted yet

Until their work is reconciled or explicitly discarded with evidence:

```text
slice/inbound-unit
slice/recall-speaker
slice/readme-open-source-v1   # public/brand work, not architecture
wip/deleghe-mai-registrata   # workflow fix
wip/repl-linereader-pipe-eof # runtime reliability fix
idea/runtime-topology        # current consolidation
```

`slice/cognitive-design-readme` should also remain until the public README stack
(#83/#84 lineage) is deliberately restacked or superseded; semantic content has
been copied, but branch/PR history still matters operationally.

No branch is deleted by this research pass.

## 5. What happens after architecture closure

Architecture closure does **not** mean DAY-1 is close by assertion. It changes
the next job from "invent the system" to "reconcile the implementation/Gate
against the system we have now decided".

Next pass:

1. reconcile M5 row-by-row against current `dev` + active runtime branches;
2. rewrite stale Gate questions where architecture changed the claim instead of
   forcing code to satisfy old wording;
3. mediate `slice/inbound-unit` under ADR-0052;
4. finish/prove `slice/recall-speaker`;
5. preserve/reconcile the two WIP bug fixes before branch cleanup;
6. distinguish mechanism blockers from acceptance-only and real-machine-only
   evidence;
7. move every deliberate non-DAY-1 item to its Roadmap phase rather than letting
   `OUT` become a cemetery;
8. only then rebuild the critical path and start implementation slices.

The key transition is:

```text
architecture discovery / reconciliation
              ↓
         ARCHITECTURE CLOSED
              ↓
Gate reconciliation against that architecture
              ↓
implementation + acceptance
              ↓
real owner cutover
```

If the Gate pass discovers a product requirement that genuinely changes semantic
ownership rather than implementation, architecture reopens deliberately through
an owner decision + ADR. Otherwise new mechanism detail is not an excuse to
restart foundational design.