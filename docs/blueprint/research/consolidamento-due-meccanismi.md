# Il consolidamento — cosa lo fa partire, come si segna, e chi scrive

```
scritto: 2026-08-13
verificato: 2026-08-13
verificato-contro: muffin-agent @ 80950bd · vecchio Muffin @ 09e02db · muffin.dev.db (2.264 item, 2026-04-14 → 2026-07-18)
modello-strumenti: Opus 5 via Claude Code — repo letti in loco, SQL eseguito sul db vero, peer letti via API GitHub (non le homepage), doc esterni via fetch diretto
invaliderebbe: un post-turn hook che compare in `LoopDeps`; una riscrittura di `ingestPending`; o la prima esecuzione vera su volume reale, che oggi non esiste
```

**Domanda dell'owner**: *"il memory extract dovrebbe essere automatico, non una
cosa che lanci"*. Prima ricerca scritta secondo `PRACTICES.md §13`.

**Come leggere le etichette.** ⬤ **misurato** qui, con il comando che lo produce.
◐ **letto sulla fonte primaria** (doc ufficiale, codice del peer). ○ **riportato
da terzi**, non ri-verificato. Le sezioni «Cosa non si è potuto stabilire» sono
parte del risultato, non una scusa.

---

# Parte concettuale — perché due meccanismi e non uno

## La riga di roadmap era giusta per metà

M5-bis riga 1 dice che il consolidamento non parte mai, e che servono **due**
meccanismi: l'estrazione per-turno asincrona e la manutenzione periodica. La
correzione del 2026-08-11 — che il vecchio non riempiva la memoria di notte ma a
ogni turno — regge ⬤. Quello che non reggeva era la latenza.

Il vecchio non stava a «minuti». Stava a **11,8 secondi di mediana** ⬤. La media
è 48 s, ma la trascina una coda con un p99 di 264 s e un massimo di 22 ore (un
downtime). Roadmap e inventario dicono entrambi «latenza: minuti», e la
differenza non è cosmetica: **a dodici secondi il fatto è a posto prima del
messaggio successivo della stessa conversazione**. È un altro prodotto. Un
sistema che arriva a minuti sarebbe una regressione rispetto alla cosa che stiamo
riproducendo, non una sua approssimazione.

## «I fatti restano a zero» dice meno del vero

Nel repo nuovo, `indexBacklog`/`index` sono chiamati da `ingest.ts` e dal vault, e
**da nient'altro** ⬤. Nessun altro percorso produce l'embedding di un episodio.

Quindi finché il consolidamento non parte, non manca un livello: ne mancano due.
**Il recall resta solo-keyword per tutta la vita dell'installazione** — la metà
vettoriale di RRF non ha chi la alimenta, `provenanceOf` non ha mai la ragione
per cui esiste, e l'invariante `vector_desync` passa a vuoto. Anche i punti 1 e 2
della lista MVP (recall-polish, `importance`/`origin`) sono inerti per la stessa
ragione singola.

Sul database dell'owner, il 2026-08-11: **18 episodi, 0 fatti, 0 entità, 0
chunk**, tutti con `extraction_v = 0` ⬤.

## Il numero che decide la forma del meccanismo

Il vecchio faceva partire un'estrazione a **ogni** turno. Resa misurata:
`memory_saved` è scattato su **78 item su 2.264 — il 3,4%** ⬤. Una chiamata al
modello ogni turno per produrre un fatto ogni trenta.

Questo non dice «non farlo per turno». Dice che il grilletto deve essere qualcosa
di più fine di «è arrivato un turno», e la letteratura converge sulla stessa
conclusione da tre direzioni diverse (§Il grilletto, parte tecnica).

## La collisione che l'owner temeva non è mai successa

L'owner ha chiesto un tool con cui Muffin gestisca la propria memoria, e che la
pipeline in background ne sia consapevole per non salvare due volte. Il vecchio
**aveva** quel tool (`save_fact`), e sullo stesso chokepoint di riconciliazione
della pipeline. I quattro mesi di produzione dicono ⬤:

| mese | chiamate `save_fact` | fatti espliciti | fatti dalla pipeline |
|---|---|---|---|
| 2026-04 | 28 | 31 | 151 |
| 2026-05 | 6 | 6 | 22 |
| 2026-06 | 5 | 3 | 97 |
| 2026-07 | **0** | **0** | 104 |

39 chiamate su 2.264 turni: **l'1,7%**. Quaranta fatti su 414: **il 9,7%**.
**Zero duplicati esatti fra i due percorsi in quattro mesi**, e i fatti espliciti
sono sopravvissuti *meglio* (85% ancora attivi contro 73%).

Il problema vero non è che i due percorsi litighino. È che **il modello smette di
scrivere e continua solo a leggere**: le chiamate a `search_facts` non sono
crollate come quelle a `save_fact`. E tre mesi prima di quello zero, un eval
interno aveva misurato un call-rate dell'**89%** su imperativi biografici
chiari ◐ (ADR-040 del vecchio repo lo cita per rifiutare la rimozione del tool).
L'eval chiedeva «dato un imperativo chiaro, chiama il tool?»; la produzione
chiede «quanto spesso ne arriva uno, e viene notato?». **Quella distanza è il
numero più importante di questa ricerca**, e vale oltre la memoria: è la forma
generale di un eval che passa mentre la feature muore.

## Cosa il repo esclude già da solo

Tre vincoli non sono opinioni, sono contratti già scritti ⬤:

- **DELETE non è rappresentabile.** Nessun percorso di cancellazione sui fatti.
  ADR-0032 §27 lo rende portante: i fallimenti di Memory-R1 e Letta *"nascono
  dallo sbiancamento di righe, non dalla loro scrittura"*. Ogni opzione che
  chiede al tool di rimuovere un fatto è fuori.
- **La fiducia non sale.** Un fatto scritto da un tool eredita il taint del turno.
- **`origin` non è «chi ha scritto».** Lo schema è esplicito: è *come siamo
  arrivati alla credenza*, ortogonale a `trust_tier`. Riusarlo per l'autorialità
  sovraccarica una colonna il cui CHECK è caro da allargare dopo. Nel vecchio la
  colonna equivalente **era** autorialità, e non è servita a niente: due icone di
  debug e un filtro.

E una garanzia che il tool cancellerebbe, da cancellare a mano invece che
lasciarla diventare falsa in silenzio — ADR-0032 §9: *"il contributo del modello
al contenuto della memoria è zero, non indiretto"*.

---

# Parte tecnica — the surface, the numbers, the constraints

> Written in ASD-STE100 style: short sentences, active voice, one instruction per
> sentence. Claim labels: ⬤ measured here · ◐ read from a primary source ·
> ○ third-party, not re-verified.

## The write surface, exhaustively ⬤

Every writer, with its production callers. A writer with one caller is a writer
that one deletion silences.

| Writer | Production callers |
|---|---|
| `addEpisode` (`core/memory/store.ts:111`) | 5 — `agent/loop.ts:243`, `:478`, `agent/observe-run.ts:105`, `core/vault/vault.ts:238`, `evals/memory/corpus.ts:122` |
| `addFact` (`store.ts:192`) | **1** — `core/memory/ingest.ts:198` |
| `upsertEntity` (`store.ts:175`) | **1** — `ingest.ts:124` |
| `supersede` (`store.ts:222`) | **2**, same function — `ingest.ts:287`, `:291` |
| `markExtracted` (`store.ts:147`) | **1** — `ingest.ts:138` |
| `VectorIndex.index` (`core/memory/vectors.ts:212`) | 2 — `ingest.ts:145`, `vault.ts:280` |

`ingestPending` has two callers: `cli/memory.ts:177` (the hand-typed command) and
`evals/memory/corpus.ts:151` (a script that no `package.json` entry runs).

**Declared and connected to nothing**, found in the same pass:

- `MemoryStore.factHistory` (`store.ts:275`) — zero callers.
- `MemoryStore.isFunctional` (`store.ts:186`) — zero callers.
- `origin: 'inferred'` — **zero producers**. `ingest.ts:213` writes `'said'` and
  nothing else calls `addFact`. The read path hedges on this value in four places.
- Tables `profiles` and `digests` (`core/memory/schema.ts:130`, `:138`) — zero
  writers, zero readers.
- Principal `{kind:'system', source:'consolidation'}` (`core/policy/types.ts:23`)
  — zero producers.
- `ProactiveKind = 'consolidation'` (`core/scheduler/proactivity.ts:48`) — zero
  producers.

The slot for a threshold trigger exists in three places. Nothing fills it.

## Idempotency: what breaks today ⬤

`ingestPending(deps, tenantId, limit = 20)` has **no outer transaction, and cannot
have one**. better-sqlite3 12.11.1 rejects an async transaction function:

```
async tx REJECTED: Transaction function cannot return a promise
```

`ingestPending` awaits `extractFacts` and `judgeContradiction` inside its loop.
Therefore no `db.transaction()` can span one episode's extraction and its write.
`markExtracted` runs **once, at the end of the batch** (`ingest.ts:138`).

Consequences:

- **A crash between `addFact` and `markExtracted` replays the whole batch.** The
  only protection is a duplicate check on case-insensitive **exact string
  equality** (`ingest.ts:189-195`). Any drift ("Cagliari" vs "a Cagliari") writes
  a second row and calls the judge.
- **No claim on pending episodes.** A scheduled run and a hand-typed `muffin
  memory extract` both extract the same set. The old system solved this at
  `memory_work_queue.ts:151-177` with `status='processing'` inside a synchronous
  transaction.
- **An empty-content episode is pending forever.** `ingest.ts:83` skips it without
  marking it, and `pendingEpisodes` fetches it again. If `limit` such rows sit at
  the head of `ORDER BY created_at`, the batch makes no progress, and
  `cli/memory.ts:201` exits reporting success.
- **`upsertEntity` forks on `kind`** (`store.ts:163-173`). One name extracted as
  `person` and as `thing` makes two entities. Fact dedup is scoped to one
  `subjectId` and never looks across them.
- **`report.needsReview` and `report.errors` are not persisted.** They go to
  stderr (`cli/memory.ts:194-197`). Schedule this job and the judge's `review`
  verdict — the deliberate "ask a human" outcome — goes into a log nobody reads.

## Cost ⬤ (arithmetic on measured prompt sizes, not a billed measurement)

The extractor uses `runtime.light.model`. The owner's live config sets
`claude-haiku-4-5-20251001`. Price table: $1 / $5 per MTok, cached input $0.10.

One `extractFacts` call per pending episode with `role != 'agent'` and
`kind != 'document'`. One `judgeContradiction` call per extracted fact whose
(subject, predicate) already has an active fact. Both mark the system block
`cache: 'stable'`. Extraction system prompt: **2 493 chars**. Judge system prompt:
**1 652 chars**. Output caps: 1 500 and 500. Embeddings run on local Ollama and
bill zero.

**Consolidation spend is invisible to the budget engine.** `recordSpend` is a
`LoopDeps` field called only from `agent/loop.ts:402`. `ingestPending` calls
`deps.provider.chat` directly, and so do the reranker and the judge. `/spend`,
the monthly cap and the kernel's `budget_exhausted` branch all see zero from the
memory lane.

## The trigger — what the field does ◐

Read from primary sources. Letta's `5` comes from server source, not from docs.

| System | Trigger | Value |
|---|---|---|
| Letta sleeptime | N turns | `sleeptime_agent_frequency=5` |
| mem0 `add()` | per message-pair, async | top_k=10 existing |
| mem0 Dream | N and time | ≥20 memories **and** 7 days |
| Zep / Graphiti | per episode | none published |
| Anthropic memory tool | model-decided | — |
| Anthropic compaction | tokens | trigger 150 000, min 50 000 |
| LangMem background | idle debounce | **30-60 min**, cancel-and-reschedule |
| Honcho | N + time + idle | ≥50 conclusions **and** ≥8 h, then 60 min idle |
| Memobase | tokens + idle | **1 024 tokens**, **3 600 s** |
| AgentCore | N **or** time | sample `messageCount:6`, idle 30 min |
| Supermemory | heuristic idle | "at most fifteen minutes", explicitly no cron |
| Generative Agents | **salience sum** | importance total ≥ **150**, fires 2-3×/day |

Three patterns. **Trailing-edge idle debounce is the emergent consensus** — four
systems converged on it independently. **Nobody runs a pure nightly cron.**
**Almost nobody uses a cheap model** for extraction; Memobase is the only
documented case, and Anthropic uses the main model even for compaction. That last
one dissents from our light-lane choice.

The DoD line already written — *"un trigger a soglia (N episodi non
consolidati)"* — is the option the external evidence supports least on its own.

## Evidence on when to extract ◐

- **Frequent incremental consolidation degrades utility.** arXiv:2605.12978
  (UIUC + Tsinghua, 2026-05): Static-Group > Static-All > Stream (worst). ARC-AGI
  falls **100% → 54%** after consolidating from ground-truth solutions. Their
  recommendation reads like a description of our episode plane: *"treat raw
  episodes as first-class evidence and gate consolidation explicitly rather than
  firing it after every interaction."* Caveat: agent trajectories, not chat.
- **Construction cost dominates the lifecycle.** arXiv:2606.06448 (Stanford,
  third-party), LongMemEval on Qwen3-32B: embedRAG 610 LLM calls; Mem0 4 538;
  A-Mem 19 230; Letta 18 394. Recommendation: treat memory construction as a
  background throughput workload with explicit admission control.
- **Extraction is cheap in dollars.** arXiv:2601.00821: across 2 938 turns,
  extraction cost **$0.14** of $2.92 — $0.000047/turn, 4.7% of pipeline cost.
- **Offline amortizes to 9% of online cost.** All-Mem (arXiv:2603.19595): online
  write 2.38 s / 539 tokens per turn; offline consolidation 12.79 s per event
  every ~60 turns.
- **A novelty gate skips 16-18% of calls** for 3.4× lower cost (SAGE,
  arXiv:2605.30711).

## Dedup thresholds do not port across embedders ◐

This kills the obvious move of importing the old system's 0.85 cosine gate.

An InfoQ banking-RAG study measured per-model optima: 0.7 (`all-MiniLM-L6-v2`),
0.8 (`bge-m3`), 0.86 (`jina-v2`), 0.9 (`e5-large-v2`), 0.93
(`instructor-large`). At a naive 0.7, `e5-large-v2` and `instructor-large` both
produced **99.00% false positives**. Miscalibration is catastrophic, not gradual.

Graphiti runs a cheap-first cascade: exact-normalized key → MinHash/Jaccard
(accept at ≥0.9) → LLM only for what remains. mem0's fact-level dedup has **no
threshold**: top-10 retrieval, the LLM decides.

And over-aggressive dedup fails in a way that is not local. FineWeb §3.4
(arXiv:2406.17557): global dedup removed up to 90% of the data, and the 10% kept
was **worse** than the 90% removed. arXiv:2607.26298 on transitive merge
chaining: *"One false-positive link can silently merge unrelated entity
groups."* A bad merge corrupts a cluster, not a row.

## How the peers handle tool-writes versus pipeline-writes ◐

**Letta partitions write authority by removing tools.** With sleeptime enabled the
main agent gets `[send_message, conversation_search, archival_memory_search]` —
**zero write tools**. The background agent gets the write set. There is no lock:
optimistic locking, `StaleDataError` → HTTP 409, reported at **~0.01%** of 165k
cron runs. Edits are exact-string compare-and-swap that fails loudly on 0 or >1
occurrences. Letta has **no archival dedup at all** (issue open since 2025-12).

**mem0 removed destructive operations in v3.** The live prompt is
`ADDITIVE_EXTRACTION_PROMPT` — *"Your sole operation is ADD"* — with
`linked_memory_ids` instead of overwrites. The trigger was a bug report: the
prompt's own DELETE example destroyed preference history. **The field is moving
toward our position, not away from it.**

**Zep gives an explicitly-added fact no privilege.** `add_triplet` calls the same
`resolve_extracted_edge()` as the pipeline, wrapped in a synthetic empty episode.

**Nobody lets provenance decide who may overwrite whom.** Honcho is the only
system with a first-class derivation level, and it does not enforce on it.
AgentCore removes the operation: its shipped prompt offers Add / Update / Skip.
LangMem defaults to `enable_deletes=False`.

## Benchmark hygiene ○ / ◐

Do not build on LoCoMo numbers. A Penfield Labs audit found 99 score-corrupting
errors in 1 540 questions and an LLM judge that accepted **62.81%** of
intentionally wrong answers ○ (their commercial interest is undisclosed).
Zep-on-LoCoMo has **four published numbers spread 25.6 points**, each from an
interested party. Two facts survive and are worth carrying ◐: in mem0's own table
**full-context (72.90) beats mem0's best (68.44)**, and **Letta published a grep
baseline that beats its own product** — GPT-4o-mini with `search_files`/`grep` at
**74.0%** against Mem0-graph 68.5%, reproduced independently by Salesforce.
MedDelta shows that swapping only the embedding model moves accuracy **+6.2 pp**.

## What the old system got wrong, and we must not repeat ⬤

1. **A model asked for a sentinel word learns to say it.** The critic collapsed to
   `"NIENTE"` in **22.4% of ticks** (44/205) because the prompt taught it as the
   safe default.
2. **A truncated slug as a dedup key collides.** 40-char slugs across different
   directives: **92% turnover, 5 active of 65 created**.
3. **A supersede threshold set too high makes bi-temporality dead code.** At 0.80,
   **2 of 179 facts** ever got a `valid_to` in 30 days.
4. **The pipeline swallowed its own failures.** Every function in
   `memory_work_queue.ts` catches, logs to console, and returns null.
5. **The extraction boundary was a prompt, not the data model.** The agent's reply
   went into the extraction call and was excluded by an instruction. The new repo
   enforces it structurally by skipping `role: 'agent'` episodes. Keep that. (The
   comment at `ingest.ts:90` says agent output is 68% of corpus text; measured on
   the old episodes table it is **81.8%** — 1 648 837 of 2 015 309 chars ⬤. The
   argument is stronger than the number claimed.)

## `DRAFT` is not executable end to end ⬤

ADR-0032's amendment says our `DRAFT` outcome already exists for the propose
shape. At the kernel this is true: `decide.ts:196-199` returns
`{effect:'draft', undo:{...}}`. End to end it is false: `agent/loop.ts:652-664`
refuses it. `fs.write` is declared `medium` + `undoable` and is therefore
**already unusable through the loop**. So "the tool proposes" has no register to
propose into, and building it means building the staged-pending store first.

Also: `agent/loop.ts:572-582` (`finish`) returns synchronously, and `LoopDeps` has
**no post-turn hook**. There is nowhere in the loop to hand a completed turn to a
background lane today.

---

## Le tre decisioni che questo forza

**1. Cosa fa partire la corsia per-turno.** Non è «per-turno o notturno». È quale
fra {ogni turno, N episodi non consolidati, debounce di inattività, somma di
salienza}, e se il grilletto vive in un hook nuovo di `LoopDeps`, nei chiamanti
di surface, o in un ticker del gateway che legge `stats.pending`.
→ **Presa** (2026-08-13): debounce di inattività come grilletto primario, con un
tetto a conteggio come rete. È il consenso emergente misurato su quattro sistemi
indipendenti, e l'unica opzione che non paga una chiamata per un turno su trenta.

**2. Cos'è il marcatore e quando si scrive.** Per-batch (oggi, sbagliato),
per-episodio subito dopo l'await, o claim-più-watermark come il vecchio.
→ **Presa** (2026-08-13): almeno-una-volta più un dedup vero, mai al-più-una-volta.
Perdere un'estrazione si recupera rigiocandola — `extraction_v` esiste per quello.
Un supersede sbagliato è invisibile finché qualcuno non fa la domanda a cui
rispondeva. Le due direzioni non sono simmetriche, quindi la scelta non lo è.

**3. Se il tool scrive o propone, e cosa porta l'autorialità.** → **Aperta, ed è
dell'owner**, perché cancella ADR-0032 §9. Il dato che pesa: nel vecchio quel
percorso ha fatto il 9,7% dei fatti ed è decaduto a zero, e la riconciliazione
che governerebbe è scattata **due volte in quattro mesi**.

## Cosa non si è potuto stabilire

1. **Un A/B controllato per-turno contro fine-sessione contro notturno** su un
   benchmark conversazionale, con qualità, costo e latenza insieme. Non esiste.
   Quattro formulazioni di ricerca. Quindi l'evidenza «l'incrementale è peggio» è
   trasferita da traiettorie agentiche, non provata su chat.
2. **Un confronto agentico-contro-pipeline controllato.** Resta il «non trovato»
   che ADR-0032 §13 già dichiara.
3. **La durata per-stadio del vecchio.** Il codice logga su console e non
   persiste, quindi dei 18,5 s medi claim→processed non so quanto sia estrazione,
   quanto critico, quanto conflitto.
4. **Il costo in dollari del vecchio.** Il ledger esiste, non è stato ricostruito.
5. **Se `ingestPending` produca fatti buoni.** Non è mai stato eseguito su volume
   reale. `evals/memory/corpus.ts` è l'attrezzo e non ha mai prodotto un output
   registrato nel repo. Tutto il §Cost è aritmetica, non una misura.
6. **Il flag `exclude_from_dream` di mem0** — asserito dal loro blog, **zero
   occorrenze nel repo**. Ritirato.
7. **Se AgentCore invalidi invece di cancellare.** Il prompt spedito ha solo
   Add/Update/Skip, e `UpdateMemory` emette un rimpiazzo. Ritirato.
8. **«Auto Dream» / `/dream` di Claude Code** — descritto in post di community,
   zero conferme ufficiali. Non verificato.

---

## Appendice (2026-08-13) — la condizione di invalidamento è scattata

Il blocco di freschezza in testa dice `invaliderebbe: un post-turn hook che
compare in LoopDeps`. È successo: **ADR-0038** l'ha costruito. Aggiunto qui in
coda e non riscrivendo il testo sopra (PRACTICES §13.3: il corpus è append-only).

**Cosa resta vero:** tutto §Parte concettuale e §Parte tecnica. Le decisioni 1 e 2
sono state implementate nella forma che questa ricerca raccomandava — coda
d'inattività con tetto a conteggio, marcatura almeno-una-volta. La decisione 3
resta aperta e dell'owner.

**Cosa la ricerca non poteva dare, e che la costruzione ha misurato.** §Il
grilletto elenca i valori dei peer e osserva che rispondono a *"la sessione è
finita"*, ma non offre il numero che sceglie **il nostro**. Quel numero non è nella
letteratura: è nel corpus dell'owner, e sono tre misure sullo stesso
`muffin.dev.db` di questo documento (4.107 episodi ⬤):

| misura | valore |
|---|---|
| messaggi consecutivi dell'owner a meno di 20 s (n = 1.793) | **1,0%** (3,5% < 30 s · 9,6% < 45 s) |
| mediana dell'intervallo fra messaggi consecutivi dell'owner | **272 s** |
| mediana dell'intervallo risposta → messaggio successivo (n = 1.449) | **56 s** |
| batch a una coda di 20 s ancorata alla risposta | **1.326 per 1.793 turni** (1,35 turni/batch, **−26% di chiamate**) |
| idem a 30 s · a 60 s | 1.282 (−3,3% in più) · 1.075 (−19%, ma oltre la mediana di 56 s) |
| turni consecutivi senza una pausa di 20 s: p90 · p99 · max | **2 · 4 · 7** (a 60 s: 3 · 6 · 12) |

Le due righe che decidono: la **mediana di 56 s** è ciò che rende una coda da 60
minuti — o anche da un minuto — una regressione rispetto agli 11,8 s, perché il
fatto atterrerebbe *dopo* il messaggio successivo; e il **max = 7** è ciò che fa
di un tetto a 12 una rete invece di un secondo grilletto.

**Una cosa che questo documento non aveva previsto**: che il tetto a conteggio
fosse rappresentabile *solo* in memoria. La lettura ovvia — un ticker che guarda
`stats.pending` — è sbagliata per una ragione che si vede solo scrivendola: un
episodio che fallisce l'estrazione in modo permanente resta pending, tiene il
conteggio sopra la soglia e fa scattare la corsia a **ogni** turno, per sempre.

**E una che è più forte del previsto**: §"«I fatti restano a zero» dice meno del
vero" prevedeva che il grilletto sbloccasse anche l'indice vettoriale. Confermato
eseguendolo — l'indice della home di prova è passato da vuoto a `5 chunk · 5
vettori, in sync` senza che nessuno chiamasse `vault reindex`.

---

## Appendice 2 (2026-08-14) — le misure che il secondo meccanismo ha chiesto

Stessa regola dell'appendice sopra (PRACTICES §13.3: il corpus è append-only —
si aggiunge in coda, non si riscrive il testo). ADR-0040 ha costruito la
manutenzione, e tre delle sue decisioni volevano un numero che questo documento
non aveva. Misurati sugli stessi due database: `~/dev/Muffin/muffin.dev.db`
(vecchio, 2026-04-14 → 2026-07-18) in sola lettura.

**1. La deduplica non ha bisogno di una soglia — sul corpus vero, di nessuna.**
§"Dedup thresholds do not port across embedders" dice che lo 0,85 non è
portabile, e lascia aperto quale cascata serva. Il corpus risponde più
seccamente di così ⬤:

| misura | valore |
|---|---|
| fatti attivi | **308** (su 414 totali) |
| gruppi (soggetto, predicato) con più di un valore attivo | **2**, per 5 righe |
| di quelli, duplicati esatti dopo normalizzazione (case · spazi · punteggiatura finale) | **2 su 2** |
| di quelli, identici byte per byte senza alcuna normalizzazione | **2 su 2** |

Cioè: **ogni** gruppo multi-valore realmente avvenuto in quattro mesi era un
duplicato, e nemmeno uno avrebbe avuto bisogno di un giudizio di similarità. Il
primo gradino della cascata di Graphiti — chiave esatta normalizzata — copre il
100% del fenomeno osservato, e la normalizzazione stessa è margine: a byte nudi
il risultato è lo stesso.

Nota di lettura: il vecchio **aveva** una deduplica a coseno 0,85 e questi tre
duplicati le sono passati sotto. Non prova che 0,85 fosse sbagliato — prova che
un gradino esatto e uno approssimato falliscono in modi diversi, e che il primo
è quello di cui esiste evidenza di aver servito.

**2. La coda del vecchio arrivava a giorni, non a minuti.** §"La riga di roadmap
era giusta per metà" cita gli 11,8 s di mediana. La distribuzione completa dice
perché il drenaggio dell'arretrato è un meccanismo separato e non un
raffinamento del primo ⬤ (2.438 righe di `work_queue`, `created_at` →
`processed_at`):

| p50 | p90 | p99 | max |
|---|---|---|---|
| **12,4 s** | 40,4 s | **4.173 s** (~70 min) | **1.449.440 s** (16,8 giorni) |

La mediana è il prodotto; la coda è quello che succede quando il sistema resta
indietro. Un p99 di settanta minuti e un massimo di sedici giorni sono la stessa
forma che qui produce un arretrato più grande di una pagina — e nel vecchio, che
rivendicava *per episodio*, non c'era niente che la chiudesse più in fretta.

**3. La manutenzione era la metà piccola, e di quanto.** ⬤ Nello stesso arco:
**100 righe in `dream_reports`** (2026-03-26 → 2026-07-19) contro **2.438 in
`work_queue`** (2026-04-14 → 2026-07-18) — il **4%**. È il numero che ADR-0040
usa come tetto di progetto: un passaggio di manutenzione che costasse più della
corsia che mantiene sarebbe peggio di nessun passaggio.

## Cosa questa appendice non ha potuto stabilire

1. **Il costo in chiamate al modello del dream del vecchio.** `dream_reports`
   conta i report, non le chiamate; il ledger non è stato ricostruito (già
   dichiarato al punto 4 della sezione originale).
2. **Se i 3 duplicati siano passati sotto la soglia 0,85 o accanto ad essa** —
   cioè se la deduplica a coseno sia stata invocata su di loro e abbia detto no,
   oppure non sia stata invocata affatto. Le righe non registrano il confronto.
3. **Quanti duplicati produrrà il nuovo pipeline.** Zero fatti sul database
   nuovo: il tasso resta non misurato finché non ci sono mesi d'uso vero, ed è
   per questo che `consolidation_runs.merged` esiste — il segnale «era sbagliata»
   di ADR-0040 è contato lì, non percepito.
