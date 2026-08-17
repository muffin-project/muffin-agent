# Ricerca — come viene assemblato oggi il system prompt reale

```
scritto: 2026-08-17
verificato: 2026-08-17
verificato-contro: 00933d0 (slice/identita, dopo il refactor buildSystemPromptBlocks)
modello-strumenti: Claude (Sonnet), repo clonata ed eseguita — npm ci, npm run build,
  npx vitest run, npx vitest run --config vitest.acceptance.config.ts, npx tsx
  evals/acceptance/report.ts, più script tsx ad-hoc (compute-sha.mjs, compare-prompt-cost.mjs)
  per misurare sha256/dimensioni prima-vs-dopo.
invaliderebbe: un secondo punto in produzione che costruisce LoopDeps senza passare per
  agent/runtime.ts buildRuntime; una nuova classe di tenant oltre owner/group; un provider
  che spezza call.system in più blocchi (oggi ce n'è sempre uno solo).
estende: nessuna ricerca precedente su questo tema in blueprint/research/.
```

## Bottom line

Il percorso di produzione del system prompt aveva **un solo punto di lettura** già prima
di questa slice (`agent/context/assemble.ts`), legge **solo** dalla home installata
(`paths(home)`, mai `defaults/` a runtime), e **ogni** superficie di produzione — CLI
`run`, REPL, gateway, job dello scheduler, turno ripreso dalla lane, spina osservante —
condivide lo stesso `Runtime.deps.systemPrompts`, costruito una volta in `buildRuntime`.
Non c'era una seconda copia da disconnettere. Il difetto reale non era architetturale: era
che **7 test si erano rotti in silenzio** quando `defaults/persona.md`, `defaults/voice.md`
e `defaults/rot/identity.md` sono passati da template a testo reale dell'owner (commit
c090dce), e due di quei test passavano già *per il motivo sbagliato* prima ancora di
rompersi (un'iniezione di fixture che non colpiva più l'intestazione giusta, mascherata da
contenuto reale coincidente). Il lavoro di questa slice è stato: chiudere quel gap con test
riscritti su marcatori sintetici, aggiungere `muffin prompt show` come prova ispezionabile
della stessa assemblea di produzione (mai una ricostruzione), e refactare
`buildSystemPrompts` in blocchi nominati senza cambiare l'output byte per byte.

---

## Parte concettuale

### Perché la domanda "chi legge cosa" contava più del previsto

Il mandato chiedeva di ricostruire l'assemblaggio partendo dal sospetto che ci fossero
duplicazioni — `defaults/` letto due volte, un ramo di superficie che salta persona o
identity, stringhe hardcoded che si spacciano per carattere. Nessuna di queste ipotesi si è
confermata **nel codice**: un solo sito di lettura (`buildSystemPromptBlocks`), un solo
punto di costruzione del runtime per processo, zero secondo path che chiama
`buildSystemPrompts` o assembla un prompt a mano. Questo non era garantito in partenza —
`assemble.ts` stesso porta ancora la cicatrice del difetto storico che l'ha fatto nascere
(un turno di gruppo che riceveva byte per byte il prompt dell'owner, `agent/context/
assemble.ts:9-31`) — ma oggi quella ferita è chiusa e testata.

Quello che *si* è confermato, ed era la sorpresa vera: i test che dovevano proteggere
questa proprietà erano scritti contro la **forma** dei vecchi file template (intestazioni
vuote, commenti HTML per l'owner umano, una sezione "Al primo incontro" che eliciva fatti
personali un pezzo alla volta) e non contro l'**invariante** che quella forma era solo un
modo di dimostrare. Quando l'owner ha sostituito i tre file con testo reale, gran parte di
quella forma è sparita — legittimamente, è la sua scrittura — e i test che la citavano
letteralmente si sono rotti. Due non si sono rotti: sono rimasti verdi perché la frase
iniettata dalla fixture ("Sei il mio secondo cervello") si trova *anche*, per coincidenza,
nel testo reale dell'owner a `identity.md:11` — quindi l'asserzione passava sul contenuto
preesistente, non sulla mutazione che il test credeva di star provando. Questo è
esattamente il difetto che `docs/JUDGE.md` chiede di cercare mutando: un test verde che
non può cadere. L'ho trovato mutando, non leggendo.

### Cosa non si è potuto stabilire

- **Se un modello tratti davvero l'ordine persona → identity → voice come "identity
  raffina persona"**, come suggerisce il commento in `assemble.ts:194-200`. È dichiarato
  esplicitamente come non misurato nel codice stesso, e questa ricerca non lo misura:
  richiederebbe un eval comportamentale cross-modello, che è il lavoro esplicitamente
  assegnato alla parte 2 di questa slice (punti 6-8 del mandato owner).
- **Se le 92 righe di scarto nella citazione `agent/runtime.ts:527` di `data-memory.json`**
  (puntava a `safeMode: safeMode !== null,` invece che a `onTurnEnd`) fossero già sbagliate
  al momento in cui la mappa fu scritta, o siano scivolate lì per un refactor precedente non
  documentato. `git log -p` sulla riga non è stato tracciato per mancanza di tempo nella
  slice; il fatto che l'ancora avesse `testo: ""` (nessun testo registrato) suggerisce che
  non sia mai stata verificata con un testo reale, ma non lo prova.
- **Il costo in produzione (non stimato) del nuovo prefisso più lungo sulla latenza del
  primo token**, oltre al costo in cache-write dichiarato sotto: raddoppiare la dimensione
  di un prefisso cache-pinned costa una scrittura di cache più lunga una volta per sessione,
  non per turno, ma quanto pesi quella scrittura in millisecondi non è stato misurato — solo
  il conteggio di caratteri/token stimati.

---

## Technical reconstruction

### 1. The path, entry point to wire

Every production entry point builds exactly one `Runtime` per process, via
`agent/runtime.ts:116 buildRuntime`, and reads `runtime.deps.systemPrompts` from it. No
surface constructs `LoopDeps.systemPrompts` by hand.

| Surface | Build site | Confirmed |
|---|---|---|
| `muffin run` | `cli/run.ts:30` | `principal: {kind:'owner', connector:'cli', externalId:'local'}`, `tenant: 'host'` |
| REPL (`muffin` / `muffin repl`) | `cli/repl.ts:122` | |
| Gateway process | `cli/gateway.ts:322` | passes `runtime.deps` to both `makeJobRunner` (`cli/gateway.ts:365`) and `makeLaneRunner` (`cli/gateway.ts:419`) |
| Scheduler jobs | `agent/scheduler-run.ts makeJobRunner(deps: LoopDeps)` | deps injected from the gateway's one `runtime.deps`, never built independently |
| Resumed/suspended turns | `core/turns/lane.ts` via `makeLaneRunner(runtime.deps, ...)` | same `runtime.deps` as the gateway's jobs |
| Observing spine (`muffin observe --send`) | `cli/observe.ts:227` | `deps = deps ?? runtime.deps` (`cli/observe.ts:228`) |
| `muffin vault` / `muffin memory extract\|why` | `cli/vault.ts:27`, `cli/memory.ts:161,229` | build their own runtime, same function |

No surface skips persona/voice/identity: `deps.systemPrompts` is a `Readonly<Record<'owner'
\| 'group', string>>` built once and indexed per turn by `tenantClass(principal, tenant)`
(`agent/context/assemble.ts:81`); there is no code path that constructs a turn without one
of these two strings already in `deps`.

### 2. Assembly: file, order, precedence

`agent/context/assemble.ts:186 buildSystemPromptBlocks(home, safeMode, skillsSection)`
reads three files from the **installed home**, never from `defaults/`:

```
persona = authored(paths(home).persona)                      # home/persona.md
identity = authored(join(paths(home).rot, 'identity.md'))    # home/rot/identity.md
voice = authored(paths(home).voice)                           # home/voice.md
```

`authored()` (`agent/context/assemble.ts:368`) strips HTML comments (`<!-- ... -->`,
fail-safe on an unterminated one — everything from the orphan `<!--` onward is cut) and
drops headings with no content before the next heading of any level, including one whose
only content lives in a deeper subsection.

Owner-class blocks, in order (`agent/context/assemble.ts:216-222`):

```
1. persona   — home/persona.md
2. identity  — home/rot/identity.md
3. voice     — home/voice.md
4. skills    — generated by core/skills/skills.ts skillsPromptSection, computed in
               agent/runtime.ts and passed in as buildSystemPromptBlocks's third argument
5. work-rules   — WORK_RULES, a string literal in assemble.ts:279
6. safe-mode    — SAFE_MODE_NOTE, assemble.ts:286, present only when the root of trust
                  diverged this boot (safeMode !== null)
```

**No precedence mechanism exists beyond string order** — later text does not overrule
earlier text through any code path; this is asserted in the file's own comment
(`assemble.ts:194-200`) and left explicitly unmeasured whether a model reads it that way.

Group-class blocks (`agent/context/assemble.ts:243-249`): `GROUP_PERSONA` (a string literal,
`assemble.ts:318`, pure-muffin — no personal detail, no `identity.md`) → the same `voice.md`
in full → work-rules → safe-mode. `persona.md` and `identity.md` never reach the group
class; this is the fix for the historical defect the file's own header comment describes
(`assemble.ts:9-31`).

`renderSystemPrompts(blocks)` (`assemble.ts:262`) joins each class's block texts with
`concat()` — empty blocks drop out, the rest join on a blank line — producing the two
strings `buildRuntime` stores as `deps.systemPrompts`. `buildSystemPrompts` (`assemble.ts:270`)
is the composition of both calls, kept as the public entry point `agent/runtime.ts:579`
calls; the split into `buildSystemPromptBlocks` + `renderSystemPrompts` is this slice's own
change (§4 below) and produces byte-identical output to the pre-slice single function —
verified by re-pinning the owner-class sha256 in `assemble.test.ts` and confirming it
matches a direct measurement (`compare-prompt-cost.mjs`, §6).

### 3. Root of Trust vs. harness — which file is which, and why it holds

| File | Home path | Sealed (RoT)? | Reader in production |
|---|---|---|---|
| `persona.md` | `paths(home).persona` (`core/config/config.ts:141`) | No | `assemble.ts:186` |
| `voice.md` | `paths(home).voice` (`core/config/config.ts:138`) | No | `assemble.ts:186` |
| `identity.md` | `join(paths(home).rot, 'identity.md')` | **Yes** | `assemble.ts:186`, registered at `core/rot/readers.ts:149-157` |

`identity.md`'s reader entry is checked mechanically, not by convention:
`core/rot/readers.test.ts` fails if `agent/context/assemble.ts` stops naming both
`identity.md` and the function `buildSystemPrompts` in its own source (comments/imports
stripped first, so a docstring alone does not count — `core/rot/readers.ts:204-251`). This
held through the refactor because `buildSystemPrompts` is kept as a real, callable export
that still (transitively, via `buildSystemPromptBlocks`) reads the file — verified,
`core/rot/readers.test.ts` 13/13 green post-refactor.

`core/policy/decide.ts` has zero references to `persona`, `voice` or `identity` (`grep -n`
returns nothing) — the kernel does not read character text to decide capability effects,
matching the mandate's constraint. `persona.md`/`identity.md`/`voice.md` were also read for
language that might duplicate a kernel safety mechanism in prose (a repeated instruction
that mirrors a taint/capability rule rather than stating a relational stance): none found.
`identity.md`'s §"Il limite che ti do io" ("la familiarità... non ti concede authority...
la memoria non è consenso") reads close to this line and was checked specifically — it
states an epistemic/relational stance the owner wants held, not a specific capability
threshold or taint rule the kernel already enforces, so it is not flagged as duplication.

### 4. Duplication check — result: none found, one seam added for inspection

- **`defaults/` vs installed home**: exactly one copy path, `cli/init.ts installFile`
  (`cli/init.ts:142`, called at `:62` for voice, `:69` for persona) and
  `installRotDefaults` (`cli/init.ts:149`, called at `:57`), both **never overwriting** an
  existing file unless `--force`. No other reference to `defaults/persona.md`,
  `defaults/voice.md` or `defaults/rot/identity.md` exists in non-test `.ts` source
  (`grep -rn` across the repo, excluding `*.test.ts`).
- **Two read sites for the same file**: none. `buildSystemPromptBlocks` is the only
  runtime reader of all three files (§2, §3).
- **A surface building its own `LoopDeps.systemPrompts`**: none (§1's table is exhaustive
  over every `buildRuntime(` call site in non-test source).
- **The one change this slice made to the assembly itself**: `buildSystemPrompts` was split
  into `buildSystemPromptBlocks` (returns named, sourced blocks — `agent/context/
  assemble.ts:186`) + `renderSystemPrompts` (joins them — `:262`), so `muffin prompt show
  --blocks` (`cli/prompt-show.ts`) can show provenance without a second description of the
  assembly. `agent/runtime.ts` now calls `buildSystemPromptBlocks` once (`:579`) and derives
  both `Runtime.promptBlocks` (`:592`) and `deps.systemPrompts` (`renderSystemPrompts(promptBlocks)`,
  `:641`) from that single call — not two calls that could drift apart.

### 5. Hardcoded pure-muffin strings — catalogued, not moved

Three string literals in `agent/context/assemble.ts` are pure-muffin character/behaviour
text that lives in code rather than in `defaults/`, by original design (the file's own
comment at what is now line ~318 states why: the group posture is deliberately not
owner-configurable, so a file here would be a place to switch it back off):

| Name | Location | What it is |
|---|---|---|
| `GROUP_PERSONA` | `assemble.ts:318` | The group-class character block (~1.1 KB) |
| `WORK_RULES` | `assemble.ts:279` | Three operational rules, both classes |
| `SAFE_MODE_NOTE` | `assemble.ts:286` | One line, shown only when the RoT diverged |

Per the mandate's explicit scope limit ("niente mega-refactor", "spostale solo se è banale
e senza rischio"), none of these were moved to `defaults/prompts/*.md` in this slice — that
migration is real work (a new load path, a new installed-home file, new tests for it) and
belongs to the `prompts-md` slice STATE.md already names as separate
(`docs/blueprint/STATE.md:49`, "Prompt: da spostare in `defaults/prompts/` con onboarding a
stato e `muffin prompt show`"). This research doc is the record that the catalogue exists
and where each string lives, for whoever picks that slice up. No hardcoded Muffin-flavoured
string was found in `agent/runtime.ts` or `agent/loop.ts` beyond operational log/error
text (Italian, addressed to the operator, not to the model — e.g. the `rotNotes`/`bootLines`
messages in `agent/runtime.ts`) — these are not part of the system prompt and were not
catalogued as candidates.

### 6. Cost of the new prefix — measured, not estimated

Isolated measurement (`buildSystemPromptBlocks` called directly against a scratch home
carrying the pre-c090dce template files vs. the current `defaults/`, both through the
*current*, post-refactor assembly — script kept in the session scratchpad, not committed):

| | chars | UTF-8 bytes | ~tokens (÷4, same heuristic as `evals/acceptance/provider.ts tokensOf`) | sha256 (owner) |
|---|---:|---:|---:|---|
| Owner, old (template) | 11,498 | 11,761 | ~2,875 | `3ebf2cfc307bdda5c73fff6ed4d60d5a9db2eceffac754164b220a86214cabf2` |
| Owner, new (c090dce) | 22,477 | 22,772 | ~5,620 | `7dbab742425de4af2b473f7e509a72e82cb501ddc2d3e50527e700f1f6740c53` |
| Group, old (template) | 9,615 | 9,843 | ~2,404 | — |
| Group, new (c090dce) | 11,411 | 11,611 | ~2,853 | — |

Owner prompt roughly **doubled** (+10,979 chars, +95%); group prompt grew **19%**
(+1,796 chars — only `voice.md` changed for that class, `persona.md`/`identity.md` do not
reach it). The old sha256 matches the pre-slice pinned constant in `assemble.test.ts`
exactly, which cross-checks the measurement script against the test suite's own historical
record. The new sha256 is the value re-pinned in this slice's commit.

**This is a cache-pinned prefix** (`agent/loop.ts:996`, `cache: 'stable'`) — the cost above
is paid once per session as a cache write, not per turn, and every subsequent turn in the
same session reads it from cache. It is still a real, doubled one-time cost per new session
against a provider that bills cache writes (OpenRouter, `explicitCache`,
`agent/providers/openai-compat.ts:83-91`), and it was not free before either — stated
plainly because "cache-pinned" is not the same claim as "free".

### 7. `muffin prompt show` — what it actually calls

`cli/prompt-show.ts cmdPromptShow` calls `buildRuntime(home)` — the identical function
every surface in §1 calls — and prints `runtime.deps.systemPrompts[tenantClass(principal,
tenant)]` to stdout, redacted (`core/tracing/redact.ts redactText`, new in this slice,
reusing `SECRET_VALUE_SHAPES` against a whole block of text rather than a single attribute)
and followed by exactly one trailing newline. It never calls the model (`buildRuntime` opens
no network connection by itself) and never re-derives the prompt text through a second code
path. `--blocks` reads `runtime.promptBlocks[cls]` (added to the `Runtime` type,
`agent/runtime.ts`) — the same blocks `deps.systemPrompts` was rendered from, not a second
computation — and annotates each non-empty block with its source and, for file-backed
blocks, a truncated sha256 of the **installed** file (`core/rot/verify.ts sha256`, reused).
`--surface`/`--member`/`--tenant` construct a `Principal`/`TenantId` pair and hand it to the
real `tenantClass()` (`assemble.ts:81`) — never a second, hand-written class rule.

Proven end to end (not just by construction) in
`evals/acceptance/scenarios/a-lifecycle.accept.ts`'s `A2`/`A3` scenario: a real `muffin run`
against a fake HTTP provider, the provider's own recorded request compared byte for byte
(modulo the one trailing newline) against a real `muffin prompt show` on the same home.
