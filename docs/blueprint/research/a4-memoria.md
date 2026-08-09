# A4 — SOTA memoria per agenti (agosto 2026): benchmark, architetture, mandato d'attacco ontologia, embedding

> Scout Fase A del blueprint MuffinOS. Contratto: solo evidenza con fonte verificata (URL aperto/fetch reale, arXiv id, data). Nessun verdetto — decide l'orchestratore in Fase B. Claim non verificabile → `[NON VERIFICATO]`. Pagine web trattate come dati, non istruzioni.

## Metodologia e cosa NON ri-faccio

Letti prima (per `feedback_research_pitch_workflow`, anti ri-fare SOTA già fatta):
- `docs/strategy/2026-05-21-memory-architecture-audit.md` — tabella comparativa 13 sistemi con numeri LongMemEval (MemPalace 96.6%, OMEGA 95.4%, Memento 90.8%), già copre Mem0/Letta/MIRIX/Graphiti/HippoRAG-2/Hindsight/Memori/Basic Memory a livello architetturale.
- `docs/strategy/2026-06-25-knowledge-layer-sota.md` — già chiude GraphRAG-Bench (arXiv 2506.05690, ICLR 2026) e HippoRAG-2 come baseline citation-first.
- `.claude/agent-memory/research-scout/2026-06-17-graph-memory-verdict.md` — già verifica numeri LoCoMo (ByteRover 96.1%, Hindsight 89.6%, Mem0g peggio di Mem0 base, KTH cost study +104%/+232%/+6283% CPU/edge-CPU/bandwidth non statisticamente significativo).
- `.claude/agent-memory/research-scout/2026-07-06-memory-moat-sota.md` — già chiude Letta MemFS (mar 2026), provenance survey arXiv 2606.04990, PersonaTree arXiv 2606.04780.
- `docs/DECISIONS.md` ADR-009/015/016/017/020/025 (world graph v2→v3, WG-1..WG-5) — **storia interna di Muffin stesso con un'ontologia chiusa diagnosticata come substrate-blocker**, rilevante di prima mano per il mandato §3.

Questo report **cita ed estende** quei numeri dove servono al mandato (in particolare §2, §3), e va a coprire terreno nuovo non toccato prima: critiche ai benchmark (§1.4), BEAM (nuovo, non in nessun doc precedente), la disputa numerica Mem0↔Zep (nuovo), Cognee/Memobase/Supermemory/A-MEM/MIRIX/LazyGraphRAG a livello di numeri (nuovo), il mandato d'attacco a 3 vie triple-rigide/TKG/hybrid-GraphRAG (nuovo, è l'Addendum owner №1), RDF-vs-property-graph (nuovo), memory poisoning/MINJA/AgentPoison/SMSR (nuovo), consolidamento e cosa si perde (nuovo), embedding MTEB/MMTEB agosto 2026 con focus italiano (nuovo), entity resolution cross-source (nuovo).

**Nota trasversale importante** (emersa da §1.4, ripetuta più volte nel report): questo intero campo di ricerca ha un problema di **benchmark theatre** — numeri "SOTA" vendor-riportati si contraddicono a vicenda, sono spesso irriproducibili, e cambiano ranking ogni poche settimane. Ogni numero sotto è marcato con fonte+data; dove esistono dispute, riporto entrambe le versioni.

---

## 1. Benchmark di memoria

### 1.1 LoCoMo

**Cosa misura.** Conversazioni sintetiche molto lunghe (fino a ~35 sessioni, ~9K token/conversazione tipici — corpus piccolo per gli standard 2026) con domande a 5 categorie: single-hop, multi-hop, temporal, open-domain, e **categoria 5 "adversarial"** (domande a cui la risposta corretta è "non lo so / non è nella conversazione" — categoria che per convenzione quasi tutti escludono dal punteggio aggregato). Metrica: F1/accuracy giudicata da un LLM-judge sulla risposta generata vs risposta di riferimento.

**Metodologia SOTA attuale (agosto 2026, claim contrapposti — vedi disputa sotto).** Zep dichiara **94.7%**, Mem0 dichiara **92.5%** sul proprio sistema — **entrambi i numeri sono contestati dall'altra parte** (fonte: [Rohit Raj, "AI Agent Memory in 2026"](https://rohitraj.tech/en/notes/open-source-ai-agent-memory-mem0-vs-zep-letta-2026), citato anche in [dev genius comparativo](https://blog.devgenius.io/ai-agent-memory-systems-in-2026-mem0-zep-hindsight-memvid-and-everything-in-between-compared-96e35b818da8)). Numeri già verificati in scout precedente (`2026-06-17-graph-memory-verdict.md`): **ByteRover 96.1%** (hierarchical tree + recency decay), **Hindsight 89.6%** (4-network + RRF) — nessun sistema puro-grafo è in testa alla classifica.

**La disputa Mem0 vs Zep, verificata (timeline).** Fonte primaria: [Zep — "Lies, Damn Lies, Statistics: Is Mem0 Really SOTA?"](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/) (fetch diretto).

| Round | Chi | Claim | Contestazione dell'altra parte |
|---|---|---|---|
| 2025 (iniziale) | Zep | 84% | Mem0: errore aritmetico — categoria 5 (adversarial) inclusa nel numeratore ma esclusa dal denominatore, gonfiando meccanicamente il punteggio di ~25pp |
| Rerun Mem0 | Mem0 | Rerun della pipeline Zep, 10 seed indipendenti: **58.44% ± 0.20** | — |
| Risposta Zep | Zep | Accusa Mem0 di misconfigurazione: ruolo "user" assegnato a **entrambi** gli speaker in una struttura pensata per 1 utente+1 assistente; timestamp appesi al testo del messaggio invece di usare il campo `created_at`; ricerche eseguite **sequenzialmente** invece che in parallelo (gonfia la latenza riportata) | — |
| Zep corretto | Zep | **75.14% ± 0.17** | Mem0 aveva riportato Zep a **65.99%** con la propria config |
| Latenza | Zep | p95 search **0.632s** (Zep) vs 0.778s riportato da Mem0 per Zep stesso | Mem0 base: p50 0.148s / p95 0.200s (ma accuratezza inferiore) |
| Stato attuale (ago 2026) | entrambi | Zep 94.7% / Mem0 92.5% | **entrambi contestati**, nessuna riconciliazione pubblica |

**Verdetto sulla disputa**: NON risolvibile da fonti esterne — è un conflitto commerciale attivo tra vendor con incentivo diretto a vincere il benchmark. Va trattato come segnale, non come verità.

**Critiche pubblicate al dataset stesso (audit indipendente).** Fonte primaria fetchata: [Penfield Labs — "We audited LoCoMo"](https://dev.to/penfieldlabs/we-audited-locomo-64-of-the-answer-key-is-wrong-and-the-judge-accepts-up-to-63-of-intentionally-33lg) (marzo 2026):
- **99 errori corruttori-di-punteggio su 1.540 domande = 6.4%** di error rate nella ground truth. Il punteggio massimo teorico per un sistema perfetto è **~93.6%**, non 100%.
- Categorie di errore: fatti allucinati nella answer key (es. modelli di auto non presenti nel materiale sorgente), errori di aritmetica temporale, **24 domande con attribuzione errata dello speaker**.
- **Test di robustezza del judge**: usando le stesse config/prompt delle valutazioni pubblicate, il judge LLM ha **accettato il 62,81%** di risposte topicamente-vicine ma intenzionalmente sbagliate. Errori fattuali specifici catturati ~89% delle volte, ma risposte vaghe-ma-in-tema passavano ~67% delle volte.
- Repository di audit riproducibile: `locomo-audit` su GitHub (citato nell'articolo).

### 1.2 LongMemEval (+ V2)

**Cosa misura.** Chat assistant a lungo termine: 5 abilità (information extraction, multi-session reasoning, knowledge update, temporal reasoning, abstention) su una history "haystack" (LongMemEval-S ~115K token, LongMemEval-M molto più lungo). ICLR 2025. Fonte: [GitHub xiaowu0162/LongMemEval](https://github.com/xiaowu0162/longmemeval).

**SOTA già verificato in audit precedente** (`2026-05-21-memory-architecture-audit.md`): **MemPalace 96.6%**, **OMEGA 95.4%** (edges BFS ≤5 hop), **Memento 90.8%** (bitemporal entities+properties). Nuovo in questo giro: **Supermemory dichiara 85.4% overall / 92.3% single-session** (fonte: [Supermemory context memory guide](https://supermemory.ai/blog/context-memory-guide-ai-systems)) e la "scuola osservazionale" di Mastra dichiara **94.87%** (già citato in `2026-07-06-memory-moat-sota.md` via chauyan.dev). **Exabase M-1 rivendica il punteggio più alto sia su LongMemEval sia su BEAM contemporaneamente** ("no other memory system has done this" — fonte [Exabase blog](https://exabase.io/research/exabase-achieves-state-of-the-art-on-longmemeval-benchmark), rivendicazione vendor non controverificata indipendentemente).

**Critiche pubblicate, verificate:**
- **Bias strutturale verso NER**: "LongMemEval-S conversations... follow structured session formats, and both benchmarks involve consistent character naming, making NER-based term extraction unusually effective" — cioè sistemi che fanno match sui nomi propri sono avvantaggiati in modo non realistico (fonte: [SmartSearch paper, arXiv:2603.15599](https://arxiv.org/pdf/2603.15599)).
- **Corpus troppo piccolo per gli standard 2026**: ~115K token per LongMemEval-S rientra comodamente in finestre di contesto moderne (200K-1M token) — quindi non discrimina bene sistemi di memoria da "dump everything nel context".
- Errori di ground truth documentati manualmente: es. domanda `6d550036` ("quanti progetti hai guidato?") con risposta di riferimento 2, mentre la history ne menziona esplicitamente più di 3 con leadership statement chiari.
- **LongMemEval-V2** (arXiv:[2605.12493](https://arxiv.org/pdf/2605.12493), maggio 2026, fetch confermato): pivot verso memoria **agentica** (non chat-assistant): 451 domande curate a mano su 5 abilità per **web agent** (static state recall, dynamic state tracking, workflow knowledge, environment gotchas, premise awareness), su trajectory da WebArena/WorkArena/WorkArena++. È un benchmark **diverso nello scope**, non un update dello stesso task — non compete direttamente con LongMemEval-S per il caso d'uso "agente personale che ricorda una persona".

### 1.3 BEAM — nuovo, non coperto da ricerca precedente Muffin

**Cosa è, verificato via fetch diretto del paper.** "Beyond a Million Tokens: Benchmarking and Enhancing Long-Term Memory in LLMs", **arXiv:[2510.27246](https://arxiv.org/pdf/2510.27246)**, Tavakoli, Salemi, Ye, Abdalla, Zamani, Mitchell — **v1 31 ottobre 2025, v2 21 febbraio 2026, ICLR 2026**. Codice: [github.com/mohammadtavakoli78/BEAM](https://github.com/mohammadtavakoli78.github.io/beam-light/).

**Le 10 memory abilities esplicite (confermate via fetch del project site):** information extraction, multi-hop reasoning, knowledge update, temporal reasoning, summarization, preference following, abstention, **contradiction resolution**, event ordering, instruction following. Contradiction resolution ed event ordering e instruction following sono dichiarate "nuove rispetto ai benchmark precedenti".

**Metodologia**: pipeline automatica in 3 fasi (piano → domande utente → risposte assistente) che genera 100 conversazioni coerenti (20 a 128K, 35 a 500K, 35 a 1M, 10 a 10M token) con 2.000 domande di probing validate, identità utente persistente e fatti in evoluzione nel tempo. È esplicitamente costruito per **non saturare**: "no current memory architecture saturates it" — a differenza di LoCoMo/LongMemEval che iniziano a mostrare segni di saturazione/contaminazione (§1.4).

**Finding più rilevante per il mandato d'attacco (§3), verificato via ricerca mirata**: *"All methods—including LIGHT—perform strongest in abstention and weakest in contradiction resolution, indicating that contradiction detection remains a challenging open problem."* Cioè: **nessun approccio testato — inclusi quelli memory-augmented — risolve bene le contraddizioni**. Non ho trovato (nonostante 3 tentativi di fetch su paper/sito/GitHub) la tabella disaggregata per-abilità con punteggi numerici esatti per contradiction resolution — la tabella esiste ma non l'ho letta direttamente; il claim qualitativo sopra è confermato da sintesi di ricerca ma **non da lettura diretta della tabella** → trattarlo come verificato-qualitativamente, magnitudine non verificata.

**Risultati SOTA con numeri, progressione temporale (tutti fetch diretti):**

| Sistema | Data | 100K tok | 1M tok | 10M tok | Fonte |
|---|---|---|---|---|---|
| RAG (Llama-4-Maverick), baseline paper | — | — | — | 24.9% | [BEAM paper](https://arxiv.org/pdf/2510.27246) |
| LIGHT (Llama-4-Maverick), baseline paper | — | — | — | 26.6% | idem |
| Honcho | — | — | — | 40.6% | citato da Hindsight blog |
| Hindsight | 2026-04-02 | 73.4% | 73.9% | **64.1%** | [Hindsight blog](https://hindsight.vectorize.io/blog/2026/04/02/beam-sota) |
| Exabase M-1 (Mneme-1, con Gemini 3 Flash) | 2026-07-28 | **76.9%** | **75.0%** | **68.0%** | [Exabase blog](https://exabase.io/blog/exabase-m1-achieves-state-of-the-art-on-beam-benchmark), [HPCwire](https://www.hpcwire.com/aiwire/2026/07/28/exabase-reports-state-of-the-art-results-on-beam-memory-benchmark/) |

Nota: Exabase rivendica il record usando un modello **6× più economico/veloce** (Gemini 3 Flash vs Gemini 3 Pro usato dagli altri sistemi) e **~20% meno token/query** — claim vendor, non controverificato da terze parti indipendenti (pattern "benchmark theatre", vedi §1.4).

### 1.4 Critiche trasversali ai benchmark (contaminazione, saturazione, riproducibilità)

Fonte principale, fetch diretto: [**"The Benchmark Theatre" — essays.bloo-mind.ai**](https://essays.bloo-mind.ai/posts/2026-05-20-mem-eval/) (maggio 2026). Sei problemi strutturali documentati con esempi concreti, cross-verificati dove possibile:

1. **Ground truth corrotta** — LoCoMo 6.4% error rate, tetto teorico ~93.6% (confermato indipendentemente via l'audit Penfield Labs, §1.1).
2. **Judge LLM troppo indulgente** — 62,81% di accettazione di risposte sbagliate-ma-topicamente-vicine (stesso numero della fonte Penfield, cross-verificato).
3. **Corpus piccoli rispetto alle finestre di contesto 2026** — LongMemEval-S ~115K token rientra in una finestra 200K-1M nativa.
4. **Nessuna standardizzazione tra vendor** — ogni vendor usa il proprio metodo di ingestion, il proprio prompt di risposta, a volte modelli di giudizio diversi (causa diretta della disputa Mem0/Zep, §1.1).
5. **Irriproducibilità documentata**: **EverMemOS dichiara 92.32% ufficiale, ma una riproduzione indipendente (GitHub issue #73 citato nell'articolo) ottiene 38.38%** — `[NON VERIFICATO indipendentemente da me]`, riportato da una singola fonte-saggio, non ho fetchato l'issue #73 originale.
6. **Campioni troppo piccoli per significatività statistica**: su LoCoMo, **il 56% dei confronti a coppie adiacenti tra sistemi pubblicati sono statisticamente indistinguibili** (claim della stessa fonte, non riverificato con un test statistico indipendente da me).

**Caso concreto MemPalace** (lo stesso sistema che il vecchio audit Muffin cita come SOTA LongMemEval 96.6%): l'articolo denuncia che una successiva rivendicazione di MemPalace di "100% su LoCoMo" (aprile 2026) si basava su: retrieval bypassato con `top_k=50` su un massimo di 32 sessioni (cioè recupera *tutto*, non è più "retrieval" in senso stretto); ottimizzazione manuale ("teaching to the test") su tre domande specifiche; un claim di "30x lossless compression" che in realtà tronca il testo a 55 caratteri. **Questo è un claim di una fonte-saggio singola, non ho verificato il codice MemPalace direttamente** — flag esplicito: `[fonte singola, non cross-verificata da me sul codice originale]`. Esiste comunque un paper accademico critico dedicato — [arXiv:2604.21284](https://arxiv.org/pdf/2604.21284), "Spatial Metaphors for LLM Memory: A Critical Analysis of the MemPalace Architecture" (Dey, Viradecha, 24 aprile 2026) — confermato esistente via fetch (metadata + riferimenti a Mem0/Zep/Letta/ChromaDB e 7 tabelle comparative), ma **non sono riuscito a estrarre il testo del contenuto critico specifico** dal PDF (stream compresso) — l'esistenza del paper è verificata, il contenuto specifico della critica no.

**Nuovi benchmark "dinamici" citati come reazione alla saturazione** (stessa fonte, non ri-verificati singolarmente da me): **MemoryBench** ("nessuno dei sistemi avanzati supera costantemente baseline RAG semplici"), **AMemGym** (ranking on-policy diverso da off-policy fino a 3 posizioni), **MEMTRACK** (anche GPT-5-class arriva solo al 60% di correctness su task realistici). Questi tre nomi sono citati da un'unica fonte-saggio — trattarli come pista di ricerca, non come benchmark verificati indipendentemente da questo report.

**Conclusione onesta e trasversale**: la raccomandazione esplicita della fonte-critica è "ignora i numeri pubblicati, costruisci una eval proprietaria sui tuoi dati reali" — coerente con `feedback_synthetic_eval_magnitude.md` già in memoria del progetto Muffin (eval sintetico valida meccanismo non magnitudine).


---

## 2. Architetture di memoria

Per ciascuna: modello dati, pipeline di estrazione, meccanica di recall, gestione del tempo, costi/latenza, benchmark. Zep/Graphiti, Mem0, Letta, HippoRAG-2, MIRIX sono già mappati architetturalmente in `docs/strategy/2026-05-21-memory-architecture-audit.md` — qui estendo con numeri/meccanismi nuovi (bi-temporalità esatta, entity resolution, dispute) più i sistemi non ancora coperti (Cognee, Memobase, Supermemory, A-MEM, LazyGraphRAG/LightRAG).

### 2.1 Zep / Graphiti

**Modello dati**: **property graph bi-temporale** (non RDF — vedi §4), tre livelli di nodi (Episode = evidenza canonica grezza, Entity, Community), edge tipizzati. Fonte architetturale: [arXiv:2501.13956](https://arxiv.org/html/2501.13956v1) (già citato in audit precedente).

**Schema: "schema-light", non "schema-free".** Verificato via fetch diretto della doc ufficiale ([Zep — Custom Entity and Edge Types](https://help.getzep.com/graphiti/core-concepts/custom-entity-and-edge-types)): l'estrazione di default è libera (nessuno schema imposto), ma Graphiti permette di **sovrapporre** tipi custom via modelli **Pydantic** — sia per entità sia per edge — con un `edge_type_map` che vincola quali coppie entity-type possono avere quali edge-type. Questo è precisamente il punto intermedio tra "rigido" e "libero": lo schema è **opzionale e additivo**, non imposto a priori su tutta l'estrazione. **Evoluzione schema dichiarata backward-compatible**: "you can update entity types by adding new attributes to existing types without breaking existing nodes... existing nodes will preserve their original attributes while supporting the new ones for future updates" — nessuna migrazione distruttiva richiesta per aggiungere campi.

**Pipeline di estrazione (LLM-driven, verificata)**: ogni chiamata a `add_episode` innesca: (1) estrazione LLM di nodi ed edge dal testo, (2) **entity resolution a due stadi**: fast-path deterministico via **MinHash + LSH** (shingling a 3-gram, soglia Jaccard 0.9 per near-duplicate) filtrato da un controllo di **entropia di Shannon** sul nome normalizzato (nomi a bassa entropia — corti/ripetitivi — saltano l'euristica e vanno dritti al path LLM, perché l'euristica statistica è instabile su stringhe corte), con **fallback LLM** solo nei casi ambigui; **due pass**: il primo risolve per-episodio contro il grafo live, il secondo ri-esegue la similarity deterministica sull'unione dei risultati per catturare duplicati intra-batch. (fonte: sintesi di ricerca su documentazione/DeepWiki Graphiti, [neo4j.com blog](https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/)). (3) dedup/invalidazione edge.

**Bi-temporalità, meccanismo ESATTO (verificato)**: **4 timestamp per edge**: `t_valid`/`t_invalid` (intervallo in cui il fatto era vero **nel mondo**) e `t_created`(`t_ingested`)/`t_expired` (quando il sistema lo ha **appreso**/invalidato). Quando un nuovo fatto contraddice uno vecchio (es. "Alice ora lavora per Startup, non più per Acme"), Graphiti **marca l'edge vecchio come scaduto invece di cancellarlo** — preserva la storia per query temporali, non serve ricalcolo su larga scala. Il conflitto viene rilevato tramite ricerca semantica+keyword+graph sul grafo esistente prima di decidere se invalidare. Fonte: sintesi verificata di [getzep.com/ai-agents/temporal-knowledge-graph](https://www.getzep.com/ai-agents/temporal-knowledge-graph/) + [FalkorDB blog](https://www.falkordb.com/blog/building-temporal-knowledge-graphs-graphiti/).

**Errore residuo documentato, CRITICO per il mandato d'attacco (verificato via fetch diretto di GitHub issue aperto)**: [getzep/graphiti#1666](https://github.com/getzep/graphiti/issues/1666) — il **giudice di contradiction-detection (`EdgeDuplicate`) collassa quasi totalmente su modelli non-reasoning** (es. gpt-4.1-nano). Numeri esatti riportati dall'autore dell'issue, su 5 casi × 3 repliche = 15 test:

| Caso di test | Schema di default (stock) | Con fix reasoning-first |
|---|---|---|
| Contraddizione chiara (2 fatti, es. "ha venduto X" vs "possiede X") | 1/3 | 3/3 |
| Duplicato chiaro | 3/3 | 3/3 |
| Nessun conflitto | 3/3 | 3/3 |
| Stress a 4 fatti | 0/3 | 2/3 |
| Invalidazione cross-list | 0/3 | 3/3 |
| **Totale** | **7/15** | **14/15** |

Conseguenza pratica: **con un modello economico non-reasoning, fatti superati possono sopravvivere silenziosamente alla propria contraddizione** invece di essere invalidati. Fix proposto (campo `reasoning: str` dichiarato prima degli array nello schema di risposta, forzando step-by-step) **non ancora mergiato** al momento del fetch (issue aperto, nessuna PR). Issue collegato: [#1489](https://github.com/getzep/graphiti/issues/1489) menziona "three temporal-correctness gaps" nel backfill storico — esistenza confermata, dettaglio non approfondito in questo giro.

**Latenza**: numeri dichiarati non consistenti tra fonti (pattern benchmark-theatre, §1.4) — "94.7% accuracy at 155ms retrieval latency" da una fonte, "P95 300ms" da un'altra, mentre nella disputa Mem0/Zep (§1.1) Zep dichiara p95 0.632s. **Nessun numero di "LLM calls per episodio ingerito" trovato pubblicato esplicitamente** — solo la pipeline qualitativa (estrazione + resolution + dedup, minimo 1 chiamata LLM per estrazione, più il fallback su ambiguità) → `[parzialmente NON VERIFICATO su cifra esatta]`.

**Benchmark**: 75.14%/94.7% LoCoMo (contestati, vedi §1.1); nessun numero LongMemEval/BEAM trovato pubblicato direttamente da Zep in questo giro di ricerca.

### 2.2 Mem0 / Mem0-graph

Già mappato in dettaglio in `2026-06-17-graph-memory-verdict.md`: **Mem0 ha RIMOSSO il grafo queryable nel 2026**, raggiungendo 92.5% LoCoMo via entity-signal + reranking, non via graph traversal; Mem0-graph (mem0g) risultava **peggiore** di Mem0 base su single-hop (65.7 vs 67.1) e multi-hop (47.2 vs 51.2) a 2× token e +53% latenza (numeri arXiv:2504.19413, già verificati).

**Nuovo in questo giro — latenza esatta di ingest**: [Mem0 blog](https://mem0.ai/blog/mem0-the-token-efficient-memory-algorithm) — l'algoritmo "ADD-only" attuale usa **1 sola chiamata LLM per scrittura** (non più 2+ come nella versione precedente, senza operazioni UPDATE/DELETE separate), con **~500ms di latenza di ingestion**; la versione precedente (2+ chiamate LLM) aveva latenza di ingest **2-3 secondi**. Latenza di ricerca: **p50 0.148s / p95 0.200s** (la più bassa tra i sistemi comparati, ma con accuratezza minore — trade-off esplicito).

**Modello dati**: history-based (eventi ADD/UPDATE/DELETE), non un vero grafo dal 2026 in poi.

### 2.3 Letta (ex MemGPT)

Modello core/archival/recall a 3 tier già coperto in `2026-05-21-memory-architecture-audit.md`. Delta 2026 (già verificato in `2026-07-06-memory-moat-sota.md`): **MemFS/"Context Repositories"** (marzo 2026) — i blocchi di memoria sono proiettati come file markdown in un repo git, editing via tool fs generici + commit obbligatorio, esplicitamente targettizzato per coding agent (multi-subagent con worktree isolate, merge via git). **`letta_v1_agent`** (ottobre 2025) è un cambio di LOOP (deprecati heartbeat/send_message), non di memoria — da non confondere.

**Sleep-time compute, meccanismo esatto (nuovo in questo giro, verificato)**: architettura a **due agenti separati** — l'agente primario ha tool per messaggiare/chiamare tool/cercare memoria esterna ma **non** ha tool per editare i blocchi di core memory; quei tool (`rethink_memory()` ecc.) sono attaccati **solo** all'agente sleep-time, che gestisce sia la memoria in-context dell'agente primario sia la propria. Durante i turni di inattività, l'agente sleep-time riorganizza: consolida item archival, riscrive un blocco "human" diventato disordinato, sintetizza la conversazione recente in una nota stabile. Risultato dichiarato: può **tagliare il compute a runtime di ~5×** su alcuni task spostando il ragionamento pesante fuori dalla finestra di latenza utente (fonte: [Letta — Sleep-time Compute](https://www.letta.com/blog/sleep-time-compute/); paper originale arXiv:2504.13171 già citato in audit precedente).

### 2.4 HippoRAG 2

Già introdotto in audit precedenti. Numeri aggiornati (nuovo in questo giro, [arXiv:2502.14802](https://arxiv.org/pdf/2502.14802) via ricerca): **+7 F1 medio su NV-Embed-v2** (baseline retriever a embedding) su benchmark associativi; copre 3 dimensioni — factual memory (NaturalQuestions, PopQA), sense-making (NarrativeQA), associativity (MuSiQue, 2Wiki, HotpotQA, LV-Eval) — con miglioramenti su tutte e 3. **Efficienza**: dichiarato "cost and latency efficient in online processes" con **indicizzazione offline che usa significativamente meno risorse di GraphRAG, RAPTOR e LightRAG** — claim comparativo non quantificato in questo estratto. Architettura: doppio nodo passage+phrase, **Personalized PageRank** + filtro LLM sulle triple.

### 2.5 Microsoft GraphRAG / LazyGraphRAG / LightRAG

**Costi di indicizzazione, verificati con numeri**: GraphRAG classico (default Llama-3.1-70B FP8, chunk 512 token) fa **4-6 chiamate LLM per chunk**, ~4× espansione token — indicizzare 1M token sorgente richiede 4-6M token LLM in input. Su H100 (~3000 tok/s), 22-33 minuti GPU = **$1.60-2.41** (tariffa on-demand $4.34/h). Community detection (algoritmo **Leiden**, libreria `graspologic`) aggiunge **+30-50%** al costo; per 1M token gira tipicamente in 2-10 minuti su nodo CPU 32-core. Query latency ~114-143ms (traversal KG) ma **$1.20-1.80/query** — early deployment potevano arrivare a **$33.000** in chiamate LLM per indicizzare un dataset intero (fonte aggregata: [Microsoft Tech Community](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/graphrag-costs-explained-what-you-need-to-know/4207978), [baeke.info](https://baeke.info/2024/07/11/token-consumption-in-microsofts-graph-rag/)).

**LazyGraphRAG** (Microsoft Research, [blog ufficiale](https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/)): rimanda la sintesi LLM al momento della query invece di farla in fase di indicizzazione — **costo di indicizzazione ridotto allo 0.1% del GraphRAG pieno** (indicizzazione = costo di un vector RAG semplice), **query global-search a costo >700× inferiore** a parità/miglior qualità del GraphRAG pieno. Trade-off: **+2-8 secondi di latenza per query** per l'espansione iterativa a runtime.

**LightRAG** ([comparativo verificato](https://eliteaiadvantage.com/blog/build-graphrag-lightrag-cheaper-microsoft), [agentlist.top](https://www.agentlist.top/en/articles/graphrag-vs-lightrag-comparison/)): **1 sola chiamata LLM per query** (embedding della query → top-K entità/relazioni via similarity → 1-2 hop di traversal), **~$0.04/query, 3-5 secondi**, contro $1.20-1.80 e più chiamate per Microsoft GraphRAG classico — **10-30× più economico e 6-13× meno latente** via Personalized PageRank su grafo LLM-estratto invece di community-summary precomputate.

### 2.6 A-MEM

[arXiv:2502.12110](https://arxiv.org/abs/2502.12110), ispirato al metodo **Zettelkasten**: nessuno schema fisso predefinito — ogni nuova memoria genera una "nota" con attributi strutturati (descrizione contestuale, keyword, tag) generati dal modello stesso, poi il sistema **analizza le memorie storiche per trovare connessioni rilevanti e collegarle dinamicamente**; l'arrivo di una nuova memoria può **triggerare l'aggiornamento delle rappresentazioni di memorie esistenti** (evoluzione continua della rete, non solo append). Risultati dichiarati: **fino a 6× di miglioramento su multi-hop reasoning complesso**, **-85/-93% di token usati per le operazioni di memoria** rispetto a baseline, su 6 modelli foundation testati. NeurIPS 2025 poster.

### 2.7 MIRIX

Già in audit precedente come "6 typed". Dettaglio confermato in questo giro ([arXiv:2507.07957](https://arxiv.org/abs/2507.07957)): **6 tipi di memoria distinti** — Core (dati persistenti utente/agente), Episodic (eventi timestampati), Semantic (concetti/entità nominate), Procedural (istruzioni step-by-step), Resource (documenti/file/media condivisi), **Knowledge Vault** (informazioni verbatim critiche da preservare esattamente — indirizzi, telefoni, email, dati sensibili — distinto esplicitamente dalla memoria semantica generica). Multi-agente: agenti dedicati coordinano update/retrieval per tipo. Risultati dichiarati: **+35% accuratezza vs baseline RAG**, **-99.9% storage** — claim vendor, non cross-verificato con altri benchmark in questo giro.

### 2.8 Cognee

**Nuovo, non coperto prima.** Architettura graph-native con pipeline **ECL (Extract-Cognify-Load)**. Cognee 1.0 fa girare l'intero layer memoria (grafo + vettori + sessioni + metadata) su **una singola istanza Postgres** in cloud, oppure **SQLite + LanceDB + Kuzu** in locale — elimina la necessità di deployment separati per graph DB / vector store / Redis. 14 modalità di retrieval dichiarate. Trazione dichiarata (vendor, non verificata indipendentemente): >12.000 star GitHub, 80+ contributor, $7.5M seed, 70+ deployment in produzione; **v1.4.0 rilasciata 17 luglio 2026** (dataset-level overview index, ingestion più veloce, search ranking migliorato). Fonte: [cognee.ai blog](https://www.cognee.ai/blog/fundamentals/how-cognee-builds-ai-memory), [dailyaiworld.com](https://dailyaiworld.com/blogs/cognee-agent-memory-knowledge-graph-workflow-2026).

**Benchmark head-to-head, verificato via fetch diretto** ([Cognee blog](https://www.cognee.ai/blog/deep-dives/knowledge-graph-memory-benchmarks), gennaio 2026, su HotPotQA/TwoWikiMultiHop/MuSiQue, 45 ripetizioni per assorbire varianza del judge):

| Sistema | Config | Human-like Correctness | DeepEval Correctness | F1 |
|---|---|---|---|---|
| Cognee | GRAPH_COMPLETION_COT, **tuned** | 0.93 | 0.85 | 0.84 |
| Graphiti | LangChain+Neo4j, default | 0.88 | 0.74 | 0.70 |
| LightRAG | default | 0.96 | 0.67 | 0.09 |
| Mem0 | OpenAI memory QA, default | 0.72 | 0.54 | 0.12 |

**Caveat importante, esplicito nella fonte stessa**: Cognee era **tuned** per il proprio confronto mentre i competitor giravano in **config di default** — bias metodologico auto-dichiarato dal vendor stesso, coerente con il pattern "benchmark theatre" di §1.4. Da notare anche la varianza enorme tra "Human-like Correctness" e F1 per LightRAG (0.96 vs 0.09) — segnale che le metriche non sono comparabili 1:1 tra loro.

### 2.9 Memobase

**Nuovo.** Modello dati: **user-profile strutturato + timeline di eventi**, non un grafo — l'obiettivo dichiarato è "capire l'utente individuale" più che immagazzinare log grezzi. Estrazione: elaborazione a batch (buffer per utente, batch-processing delle chat per distribuire l'overhead). Stack: FastAPI + Postgres + Redis, supporto multi-tool (Claude/Cursor/altri MCP-compatibili condividono lo stesso layer di memoria persistente), embedding a 1536 dimensioni, **Postgres Row-Level Security per isolamento dati per utente**. Fonte: [GitHub memodb-io/memobase](https://github.com/memodb-io/memobase), [DeepWiki](https://deepwiki.com/memodb-io/memobase). Nessun numero di benchmark pubblico trovato in questo giro di ricerca → `[NON VERIFICATO su benchmark]`.

### 2.10 Supermemory

**Nuovo.** Architettura a **5 layer**: connettori (auto-sync Slack/Notion/Gmail), estrattori (chunking multimodale), Super-RAG (hybrid search + reranking), **memory graph** (tracciamento relazioni oltre la similarity, dichiarato risolvere contraddizioni e ordinamento temporale dove i vector DB falliscono), user profile (preferenze statiche + dati di sessione realtime). Design dichiarato **leggero**: "memoria come tracce semantiche time-annotated" più che grafo profondamente strutturato — posizionamento esplicito contro la complessità di un vero graph-DB. Performance dichiarate: **<300ms risposta**, **100B+ token/mese processati**, LongMemEval-S **85.4% overall / 92.3% single-session**. SOC2/HIPAA compliant, self-hostable. Fonte: [Supermemory blog](https://supermemory.ai/blog/context-memory-guide-ai-systems).


---

## 3. MANDATO D'ATTACCO (Addendum owner №1) — triple rigide vs TKG schema-light vs hybrid GraphRAG

**Nota metodologica**: come richiesto, questa sezione raccoglie **evidenza per cella**, incluse evidenze che **contraddicono** il sospetto dell'owner dove esistono. Nessun verdetto qui — la tabella riassuntiva è in fondo al report (§Tabelle di chiusura).

### 3.0 Evidenza interna: il precedente di Muffin stesso (prima parte, non letteratura esterna)

Prima di guardare fuori: Muffin **ha già vissuto** una versione di questo esperimento, in casa propria, tra aprile e maggio 2026 (`docs/DECISIONS.md`, verificato via grep diretto sul file):

- **24 aprile 2026** — il design v2 del world graph aveva **"ontologia chiusa stretta"** tra i **sei punti diagnosticati come "substrate-blocker"** (insieme a bi-temporale incompleto a 2 timestamp, entity resolution fonetica IT discutibile, `valid_at` non estratto semanticamente). L'ontologia chiusa non è stata "raffinata" — è stata **riscritta da zero** come v3 (ADR-009, `pillars/memory/08_graph.md` v3).
- **v3, decisione esplicita**: "ontologia hybrid emergente con prescribed seed list + learned via LLM + consolidation nel dream cycle" — cioè: NON triple rigide, ma vocabolario che nasce dai dati e viene consolidato periodicamente, non validato contro un enum chiuso a ogni scrittura.
- **ADR-017 (WG-3, vocabolario predicati)**: decisione esplicita di **vocabolario libero emergente** per `entity_edges.predicate` (`is_in`, `lives_in`, `works_for`, ...) con canonicalizzazione automatica (snake_case/lowercase) ma **nessuna validazione contro un enum chiuso**. Rischio dichiarato esplicitamente nell'ADR stesso: "semantic drift: `lives_in` / `is_from` / `resides_in` per la stessa relazione". Mitigazione scelta: **non prevenzione a priori, ma audit periodico** (query `GROUP BY predicate HAVING count>1` lanciabile on-demand + consolidamento Dream Phase I.4) con **trigger di escalation esplicito**: "se >50 predicate o sub_kind distinti → escalate a closed-list ADR". Cioè: Muffin ha scelto **governance a soglia empirica**, non schema imposto upfront.
- **Fallimento empirico documentato di un vincolo troppo rigido, primo tentativo (WG-2)**: nel backfill iniziale (180 entità), **il 100% dei nodi estratti da testo libero finiva con `kind: "concept"`** perché ADR-016 originale escludeva l'LLM dal path di classificazione (solo cosine-similarity deterministico). Citazione diretta dell'owner riportata nell'ADR: *"il separare per le maiuscole non sta funzionando benissimo — separare in base alle cose come luoghi"*. Diagnosi nell'ADR: "cosine non distingue tipi semantici" — serviva reintrodurre giudizio LLM, ma **solo nel path di typing**, mai in quello di disambiguation (separazione di responsabilità esplicita, non rollback totale).
- **Il caso più diretto rispetto all'esempio "un solo padre" dell'owner (ADR-025, OD-WG-5-D, 18 maggio 2026)**: lo schema v3 trattava **tutti i predicati come singleton** ("la credenza corrente del sistema è una sola" — esattamente il tipo di vincolo di coerenza "un solo X" che l'owner cita come esempio). Audit empirico sul DB dev ha trovato che predicati come `interest`/`preference`/`sentiment_toward`/`frequents`/`skill` sono **naturalmente set-valued** (una persona ha N interessi, non 1) e il vincolo singleton stava **silenziosamente scadendo (`expire`) le credenze precedenti a ogni nuova menzione**: `interest` 27/28 scaduti, `preference` 21/22, `sentiment_toward` 12/14, `concern` 11/13 — **la maggioranza dei "supersede" erano artefatti dell'ordine di estrazione, non transizioni semantiche reali**. Fix: lista chiusa di 12 predicati esplicitamente dichiarati set-valued, con branch dedicato nel resolver. Riparazione retroattiva: **89 attributi erroneamente scaduti + 10 cap-eviction**, +79 righe di credenza attiva nette. Deploy via script owner-gated con `pm2 stop all` prima.

**Perché questo conta per il mandato**: è un caso **verificabile file:riga**, sui dati reali di Giusto, di un vincolo di coerenza "un solo valore corrente" che ha **corrotto silenziosamente dati veri per giorni prima di essere scoperto tramite audit manuale**, non tramite un errore visibile a runtime. Non è letteratura — è il progetto stesso, ed è esattamente il tipo di rischio che l'Addendum owner sospetta. Va notato con onestà che questo NON è un test dell'ipotesi "triple soggetto→predicato→oggetto con vincoli di coerenza" nella forma esatta descritta dal brief (quella non è mai stata costruita in Muffin) — è un vincolo di coerenza singleton-per-predicato nel modello property-graph esistente, un cugino diretto ma non identico all'ipotesi originale.

### 3.1 Asse: LATENZA A RUNTIME

| Approccio | Ingest | Recall | Fonte |
|---|---|---|---|
| **(i) Triple rigide con vincoli** | Nessun numero pubblico trovato per questo esatto pattern (soggetto→predicato→oggetto + vincoli di coerenza tipo "un solo padre") applicato a chat personale. Per analogia: estrazione a schema fisso richiede tipicamente **più vincoli di validazione post-generazione** (retry su schema-violation) — non quantificato in una fonte specifica. `[NON VERIFICATO — nessuna fonte con numeri per questo pattern esatto]` | Query su vincoli rigidi = tipicamente lookup diretto (veloce, se lo schema è indicizzato bene) ma **solo se la domanda calza esattamente lo schema previsto** — nessun numero specifico trovato. | — |
| **(ii) TKG schema-light (Graphiti/Zep)** | Pipeline qualitativa verificata: estrazione LLM + entity resolution (fast-path deterministico MinHash/LSH + fallback LLM su ambiguità) + dedup/invalidazione edge per episodio — **nessun conteggio esatto di "N chiamate LLM per messaggio" trovato pubblicato**. Mem0 (comparabile come categoria "graph-adiacente" ma senza grafo dal 2026) dichiara **1 chiamata LLM/scrittura, ~500ms** con l'algoritmo ADD-only attuale (era 2-3s con 2+ chiamate prima). | Numeri dichiarati incoerenti tra fonti (pattern benchmark-theatre): 155ms, "P95 300ms", oppure p95 0.632s/0.778s nella disputa Mem0↔Zep — **range 150ms-780ms a seconda della fonte e configurazione**. | [§2.1](#21-zep--graphiti), [§1.1 disputa](#11-locomo) |
| **(iii) hybrid GraphRAG** | Costoso in fase di build: Microsoft GraphRAG classico **4-6 chiamate LLM/chunk da 512 token**, $1.60-2.41/1M token indicizzati + **30-50% extra per community detection** (Leiden, 2-10 min/1M token su CPU 32-core). LazyGraphRAG/LightRAG riducono drasticamente: indicizzazione **≈ costo di un vector RAG semplice** (LazyGraphRAG) o 1 chiamata LLM/query invece che in ingest (LightRAG). | Query: Microsoft GraphRAG classico ~114-143ms ma **$1.20-1.80/query**; LazyGraphRAG **+2-8s** di latenza extra per espansione iterativa a query-time; LightRAG **$0.04/query, 3-5s, 1 chiamata LLM**, dichiarato **10-30× più economico e 6-13× meno latente** del GraphRAG classico. | [§2.5](#25-microsoft-graphrag--lazygraphrag--lightrag) |

**Lettura onesta**: l'asse latenza NON è "graph=lento, vettoriale=veloce" in modo pulito — dipende moltissimo dalla **variante specifica**. Il GraphRAG "puro" originale (community summary precomputate) è il più costoso in assoluto in ingest ma tra i più veloci in query; le sue varianti 2026 (LazyGraphRAG, LightRAG) invertono il trade-off spostando il costo a query-time o eliminandolo quasi del tutto. La TKG schema-light (Graphiti) ha un profilo di latenza-ingest paragonabile a un sistema a triple estratte via LLM in generale (entrambi pagano almeno 1 chiamata LLM per messaggio) — **la vera differenza di costo tra (i) e (ii) non è nell'estrazione stessa ma nei vincoli di validazione post-estrazione che (i) aggiunge** (schema enforcement, retry su violazione) — pattern non quantificato da nessuna fonte trovata, quindi resta `[NON VERIFICATO]` come differenziale numerico preciso.

### 3.2 Asse: GESTIONE DELLE CONTRADDIZIONI DELL'UTENTE NEL TEMPO

| Approccio | Meccanismo concreto | Errori residui documentati |
|---|---|---|
| **(i) Triple rigide + vincoli** | Il vincolo di coerenza stesso (es. "un solo padre") **agisce come contradiction-rejector strutturale**: un nuovo fatto che violi il vincolo viene per costruzione o rifiutato o forza un update esplicito. Meccanismo teoricamente pulito **quando il vincolo è vero nel dominio** — ma "vero nel dominio" è precisamente il punto debole: un vincolo singleton su un predicato che nella realtà è multi-valore (vedi §3.0, `interest`/`preference` in Muffin) **non rifiuta l'update sbagliato, lo esegue silenziosamente come se fosse corretto**, cancellando lo stato precedente senza errore visibile. | **Evidenza diretta, Muffin stesso** (§3.0): 27/28 `interest`, 21/22 `preference` scaduti erroneamente, scoperto solo con audit manuale settimane dopo, non da un errore a runtime. Letteratura generale (non specifica a "un solo padre" ma al pattern): *"there is no universally correct ontology... rigid ontological structures may not fit all real-world scenarios"* ([emergentmind survey KG-LLM](https://www.emergentmind.com/topics/llm-empowered-knowledge-graph-construction)). |
| **(ii) TKG schema-light (Graphiti)** | **Edge invalidation esplicita**: `t_valid`/`t_invalid` sull'edge vecchio, mai cancellazione — la storia resta interrogabile. Il conflitto è rilevato da un **giudice LLM dedicato** (`EdgeDuplicate`) che decide se un nuovo edge duplica/contraddice uno esistente prima di invalidarlo. | **Bug documentato e APERTO** ([graphiti#1666](https://github.com/getzep/graphiti/issues/1666), §2.1): il giudice **collassa da 7/15 a quasi-zero-affidabilità su casi di stress con modelli non-reasoning economici** — 0/3 su "stress a 4 fatti" e su "invalidazione cross-list" nello schema di default. Con un modello reasoning il fix arriva a 14/15, ma **richiede un modello più costoso**, non è gratis. Inoltre: BEAM (§1.3) trova che **contradiction resolution è la abilità più debole per TUTTI i sistemi testati**, incluso il framework memory-augmented LIGHT — non solo per Graphiti. |
| **(iii) hybrid GraphRAG** | Non ha un meccanismo di *invalidazione* nativo paragonabile — il modello dati canonico (Microsoft GraphRAG) è pensato per corpus **relativamente statici** (community summary ricalcolate periodicamente, non in tempo reale per-messaggio). Re-summarization periodica è il meccanismo de facto per "aggiornare" la conoscenza, non un tracciamento di contraddizione per-fatto. | Nessun numero specifico trovato per "gestione contraddizione utente nel tempo" in GraphRAG/LazyGraphRAG/LightRAG — il design stesso non è centrato su questo caso d'uso (è centrato su corpus documentale, non su conversazione personale evolutiva) → `[NON VERIFICATO — probabilmente non il regime di design per cui questi sistemi sono ottimizzati]`. |

**Finding trasversale più importante di questa sezione (BEAM, §1.3)**: *nessuno dei tre approcci* — nemmeno quello con più macchina dietro (memory-augmented, reasoning LLM) — risolve bene le contraddizioni. È il compito più debole per ogni sistema testato nel benchmark più aggiornato disponibile. Questo è evidenza **contro** l'idea implicita che "basta passare a Graphiti/TKG e il problema delle contraddizioni si risolve": si risolve diversamente, non necessariamente meglio, e Graphiti stesso ha un bug aperto proprio su questo asse.

### 3.3 Asse: FACILITÀ DI MANUTENZIONE

| Approccio | Schema evolution | Ontology drift | Evidenza/post-mortem |
|---|---|---|---|
| **(i) Triple rigide + vincoli** | Aggiungere un nuovo tipo di relazione o un nuovo vincolo di coerenza tipicamente richiede toccare sia lo schema sia (potenzialmente) i dati storici che lo violano retroattivamente. Letteratura generale: *"LLM outputs may be semantically redundant or structurally inconsistent... entity duplication... degrades storage efficiency and downstream reasoning"* ([emergentmind](https://www.emergentmind.com/topics/llm-empowered-knowledge-graph-construction)); *"Business terms evolve, so the ontology... needs version control, migration scripts, transparent governance"* ([Medium, Ontology Drift](https://medium.com/graph-praxis/ontology-drift-why-your-knowledge-graph-is-slowly-going-wrong-234fa238826c)). | **Fenomeno nominato esplicitamente** in letteratura enterprise KG come rischio riconosciuto: "l'ontologia smette di combaciare col dominio che evolve". Contesto quantitativo: **27% delle organizzazioni ha knowledge graph in produzione** a fine 2025 (Google Cloud survey, citato in [emergentmind](https://www.emergentmind.com/topics/llm-empowered-knowledge-graph-construction)) — base di deployment ampia ma il tasso di incidenti di drift specifico non è quantificato in nessuna fonte trovata. | **Muffin stesso, §3.0**: ontologia chiusa diagnosticata come uno dei 6 "substrate-blocker" e riscritta da zero un mese dopo il primo design (v2→v3, 24 aprile→11 maggio 2026). Ricerca attiva sul problema: **AdaKGC** (schema evolution dinamica senza retraining) e **DIAL-KG** ("schema-free incremental construction via dynamic schema induction") sono entrambi paper 2026 che esistono *perché* il problema di drift/rigidità è considerato irrisolto dal campo. |
| **(ii) TKG schema-light (Graphiti)** | **Verificato**: aggiungere attributi a un entity-type esistente è **backward-compatible per design** — "nodi esistenti preservano gli attributi originali supportando i nuovi per aggiornamenti futuri", nessuna migrazione distruttiva richiesta per l'estensione additiva. Lo schema custom è **opzionale e sovrapposto**, non imposto su tutta l'estrazione (§2.1). | Il vocabolario libero (nessuno schema per default) elimina il drift-da-schema-esplicito, ma **sposta il problema alla consistenza semantica dei nomi liberi** (`lives_in` vs `resides_in` per lo stesso concetto) — Muffin lo gestisce con audit periodico + soglia di escalation (§3.0, ADR-017), non con prevenzione a priori. | Nessun post-mortem esterno specifico su Graphiti trovato in questo giro; l'evidenza di manutenibilità positiva è la garanzia di **backward-compatibility** dichiarata nella doc ufficiale (non un caso di studio di produzione a lungo termine). |
| **(iii) hybrid GraphRAG** | Cambiare la granularità delle community (Leiden) o il modo in cui vengono summarizzate richiede **re-indicizzazione**, potenzialmente costosa (§3.1) per il GraphRAG classico; LazyGraphRAG/LightRAG, spostando il lavoro a query-time, **riducono il costo di ogni ri-lavorazione** perché non c'è quasi nulla di precomputato da invalidare. | Non specificamente un problema di "ontologia" (GraphRAG non impone tipi di entità/relazione fissi in generale — l'estrazione è aperta, poi raggruppata via community detection) — il rischio analogo è la **deriva delle community** quando il corpus cambia sostanzialmente, non documentato con casi specifici in questo giro di ricerca. | `[NON VERIFICATO — nessun post-mortem specifico trovato per questo asse su GraphRAG/LightRAG]`. |

**Evidenza che CONTRADDICE il sospetto dell'owner (richiesta esplicitamente dal mandato)**: (a) Microsoft Research dichiara che GraphRAG **vince 70-80% dei task di "complex sensemaking"** rispetto a RAG semplice — quindi *strutturare* non è di per sé sbagliato, lo è farlo nel *regime sbagliato* (corpus piccolo, query perlopiù fattuali puntuali — il caso già diagnosticato per Muffin in `2026-06-17-graph-memory-verdict.md`, non ridiscusso qui); (b) Graphiti stesso, che è la "schema-light" candidata a vincere secondo il sospetto dell'owner, **ha un bug documentato e non risolto esattamente sull'asse "contraddizioni"** (§3.2) — quindi lo schema-light non è automaticamente esente dal tipo di fragilità che l'owner teme, fallisce diversamente (silenziosamente, su modelli economici) ma fallisce; (c) l'estensibilità backward-compatible di Graphiti (aggiungere attributi senza rompere nodi esistenti) è una forma di **schema**, non l'assenza di schema — la vera differenza da un'ontologia rigida non è "niente struttura" ma "struttura opzionale, additiva, mai bloccante all'ingest".


---

## 4. La domanda ontologia in contesto largo: chi usa cosa nei sistemi reali

**RDF/triple store vs property graph — verificato per ciascun sistema di memoria agenti coperto in questo report**: **tutti** i sistemi di memoria-per-agenti trovati in questo report che usano un grafo (Graphiti/Zep, Cognee, HippoRAG, Mem0-graph-quando-esisteva, MIRIX) usano un **property graph** (Neo4j, FalkorDB, Kuzu) — **nessuno** dei sistemi di memoria-agenti coperti usa RDF/SPARQL come storage primario. Citazione diretta trovata: *"the dominant paradigm for production grade agent memory systems has converged on hybrid architectures that integrate dense vector representations with structured knowledge graphs [property graphs]"*. RDF compare nella ricerca solo in contesti di (a) knowledge graph enterprise generici/semantic web (dove il pattern dichiarato in produzione è **ibrido**: "ontology in RDF + operational data in property graph" — RDF per il vocabolario/schema formale, property graph per i dati transazionali quotidiani, [TigerGraph blog](https://www.tigergraph.com/blog/rdf-vs-property-graph-choosing-the-right-foundation-for-knowledge-graphs/)), (b) glossari/tooling generico ([Oxford Semantic Technologies](https://www.oxfordsemantic.tech/glossary/rdf-triplestore)) senza un caso reale di deployment in un sistema di memoria-agente citato per nome. Property graph è preferito per **traversal multi-hop, pattern detection, algoritmi di grafo** (fraud detection, identity graph, GraphRAG) — RDF resta preferito dove servono **vocabolari di dominio formali e interoperabilità/regolamentazione** (W3C/SPARQL standard).

**Chi usa ontologie rigide vs schema-light vs estrazione pura, panorama verificato in questo report**:
- **Estrazione pura (nessuno schema)**: A-MEM (Zettelkasten, §2.6), Mem0 base (history-based).
- **Schema-light/opzionale**: Graphiti/Zep (custom entity/edge type Pydantic **opzionali**, §2.1) — questo è il pattern dominante tra i sistemi con trazione reale coperti in questo report.
- **Schema strutturato multi-tipo fisso ma non a triple-vincoli**: MIRIX (6 tipi di memoria fissi, ma dentro ogni tipo l'estrazione è libera), Letta (core/archival/recall, 3 tier fissi).
- **Ontologia rigida a triple con vincoli di coerenza stile "un solo padre"**: **nessun sistema di memoria-per-agenti reale con trazione trovato che implementi esattamente questo pattern**. La letteratura di ontology-engineering "pura" (RDF/OWL enterprise, workshop LLMS4KGOE ESWC 2026) lavora su questo tipo di rigidità ma per **knowledge base di dominio** (cybersecurity logs — OntoLogX, standard di software engineering — arXiv:2509.00140), non per memoria conversazionale personale di un agente. Questo è un gap reale: il pattern proposto dall'owner (triple + vincoli di coerenza applicati a chat personale umana) **non ha un precedente diretto e verificato in produzione** in nessuna delle fonti trovate — né a favore né contro in modo diretto, se non per analogia (§3.0, §3.3).

**Direzione della ricerca 2026**: i paper più recenti trovati (**AdaKGC** — schema evolution dinamica senza retraining; **DIAL-KG**, [arXiv:2603.20059](https://arxiv.org/pdf/2603.20059) — "Schema-Free Incremental Knowledge Graph Construction via Dynamic Schema Induction and Evolution-Intent Assessment") vanno **nella direzione opposta** a uno schema fisso upfront — sono proposte esplicitamente per superare la rigidità, non per rinforzarla. Questo è un segnale di dove il campo sta investendo attenzione, non una prova che la rigidità sia sbagliata in assoluto.

---

## 5. Tempo e verità: meccanismi concreti di invalidazione

Il meccanismo bi-temporale di Graphiti è già descritto in dettaglio in §2.1 (4 timestamp `t_valid`/`t_invalid`/`t_created`/`t_expired`, mark-as-expired mai delete, rilevamento conflitto via ricerca semantica+keyword+graph prima di invalidare). Qui aggiungo solo ciò che non è già coperto sopra:

- **Dove è documentato**: doc ufficiale Zep ([Custom Entity and Edge Types](https://help.getzep.com/graphiti/core-concepts/custom-entity-and-edge-types), [Temporal Knowledge Graph](https://www.getzep.com/ai-agents/temporal-knowledge-graph/)), paper originale [arXiv:2501.13956](https://arxiv.org/html/2501.13956v1), più il repository GitHub open source (`getzep/graphiti`) con issue tracker pubblico che espone i problemi reali (§2.1, §3.2).
- **Errori residui aggiuntivi documentati, non ancora citati sopra**: il prompt di estrazione edge di Graphiti contiene **"regole contraddittorie" per date implicite** — quando un'azione è espressa al passato senza data esplicita, il modello a volte "indovina" mezzanotte-di-oggi invece di emettere un valore null, introducendo timestamp fittizi nel grafo (fonte: sintesi di ricerca su GitHub issue tracker Graphiti, non fetchato l'issue esatto → `[parzialmente verificato, dettaglio specifico non confermato da fetch diretto]`).
- **Confronto con Muffin**: Muffin ha già bi-temporalità **completa a 4 timestamp** sulle proprie `entity_attributes`/`entity_edges` dal WG-1 (`recorded_at`/`expired_at` + validità semantica, ADR-009) — strutturalmente lo stesso pattern di Graphiti, arrivato indipendentemente (già notato in `2026-05-21-memory-architecture-audit.md` come "bitemporal solo facts" prima di WG-1, ora esteso al grafo).
- **Finding trasversale, ripetuto perché è il più importante di questo mandato**: BEAM (§1.3) trova che **contradiction resolution è l'abilità più debole misurata, per ogni sistema testato, incluso quello memory-augmented**. Questo va letto insieme al bug specifico di Graphiti (§3.2): non è "Graphiti ha un bug, gli altri no" — è "rilevare quando un fatto nuovo contraddice uno vecchio è un problema aperto a livello di campo, e Graphiti espone pubblicamente uno dei pochi bug report dettagliati e riproducibili su ESATTAMENTE questo problema" (probabilmente perché è open source con issue tracker pubblico, non perché sia peggiore dei sistemi closed-source che non espongono i propri bug).

---

## 6. Provenienza e trust nel modello dati + memory poisoning

### 6.1 Provenienza/trust — stato dell'arte

**Principio generale trovato ripetuto in più fonti indipendenti**: ogni voce di memoria dovrebbe portare "source, identity, timestamp, model version"; come minimo un fatto dovrebbe salvare "source, creation date, last verification date, owner, confidence, scope, expiry rule" — *"a fact without provenance is difficult to trust and correct"* (fonte aggregata, [Microsoft Learn — Manage AI memory safety](https://learn.microsoft.com/en-us/security/zero-trust/sfi/manage-agentic-memory-safety), [Zylos Research](https://zylos.ai/research/2026-04-05-ai-agent-memory-architectures-persistent-knowledge/)).

**Eywa — "evidence before belief"** ([arXiv:2605.30771](https://arxiv.org/pdf/2605.30771), 1 giugno 2026, fetch diretto confermato): architettura di ricerca che **mantiene traccia esplicita di fonte e contesto originale per ogni informazione memorizzata prima di derivare un fatto canonico** — principio "l'evidenza precede la conclusione". Dettaglio dichiarato: **read path deterministico multi-route con ZERO chiamate LLM dentro il retrieval** (il ragionamento LLM è confinato alla fase di derivazione/scrittura, non alla lettura) — meccanismo distinto e più forte di quanto Muffin fa oggi con `memory_provenance.ts` (già notato come "ahead" in `2026-07-06-memory-moat-sota.md` rispetto al survey arXiv:2606.04990 che chiama questo un problema di ricerca ancora aperto). Non sono riuscito a estrarre numeri di benchmark specifici dal PDF (stream compresso) → esistenza e meccanismo verificati, magnitudine dei risultati sperimentali non verificata.

**MemTrust** ([arXiv:2601.07004](https://arxiv.org/pdf/2601.07004)): architettura "zero-trust" per memoria AI unificata — esistenza confermata via ricerca, contenuto non approfondito in questo giro (fuori budget di ricerca per questo report) → `[esistenza verificata, dettaglio NON VERIFICATO]`.

### 6.2 Memory poisoning — attacchi dimostrati

**MINJA — Memory INJection Attack** ([arXiv:2503.03704](https://arxiv.org/html/2503.03704v1), sottomesso 5 marzo 2025, v5 12 febbraio 2026 — quindi un attacco "vecchio" ma ancora attivamente citato/aggiornato nel 2026). **Verificato via fetch diretto del testo HTML completo, numeri esatti**:

| Sistema attaccato | Injection Success Rate | Attack Success Rate |
|---|---|---|
| EHRAgent (eICU) | 98.5% ± 2.8 | 90.0% ± 3.5 |
| EHRAgent (MIMIC-III) | 95.6% ± 7.0 | 57.0% ± 10.3 |
| RAP / GPT-4o (Webshop) | 99.3% ± 2.1 | 98.9% ± 2.2 |
| QA Agent / MMLU (GPT-4, GPT-4o) | 100.0% ± 0.0 | 68.9% ± 19.1 |
| **Media complessiva** | **98.2%** | **76.8%** |

Meccanismo: l'attaccante inietta record malevoli **tramite sole interazioni di query/risposta** (nessun accesso diretto allo storage di memoria) — usa "bridging steps" che collegano la query della vittima a step di ragionamento malevolo, con un prompt di indicazione che viene **progressivamente rimosso** man mano che l'attacco procede, così il record iniettato resta "plausibile" e viene recuperato facilmente in futuro. Il paper stesso dichiara che MINJA **elude sia la moderazione input/output sia la sanitizzazione basata su memoria** perché il contenuto iniettato è plausibile.

**AgentPoison** ([arXiv:2407.12784](https://arxiv.org/pdf/2407.12784), NeurIPS 2024 — precedente e fondativo rispetto a MINJA): backdoor via poche dimostrazioni malevole + trigger ottimizzato che mappa istanze triggerate in uno spazio di embedding unico, così che ogni istruzione utente contenente il trigger recuperi con alta probabilità le dimostrazioni malevole dalla memoria/knowledge-base avvelenata. Nessun training/fine-tuning richiesto. Testato su: agente di guida autonoma RAG-based, agente QA knowledge-intensive, EHRAgent.

**Difese proposte, con numeri (verificato)**:
- **Memory Poisoning Attack and Defense on LLM-Agents** ([arXiv:2601.05504](https://arxiv.org/abs/2601.05504), gennaio 2026): due meccanismi — Input/Output Moderation (trust scoring composito) + Memory Sanitization (decadimento temporale + filtro pattern-based), valutati su agenti EHR.
- **SMSR** ([arXiv:2606.12703](https://arxiv.org/pdf/2606.12703), giugno 2026, fetch diretto, numeri esatti): (a) firma di provenienza **HMAC-SHA256** su 15 scenari enterprise/3.150 trial — taglia il successo dell'attacco dal **93-100% a 0%** per varianti non firmate; (b) **randomised memory ablation** contro un avversario autenticato con singola iniezione — successo contenuto all'**8.0%** (CI 95% [5.8, 10.9], n=450), sotto il worst-case certificato; (c) attacco end-to-end query-only (l'agente stesso scrive il veleno, non pre-seminato) — successo ridotto dal **65.3% al 5.3%** (n=150) su uno stack agente live; (d) **costo in utility: 90% con la sola firma, 85% con la difesa completa** — cioè la difesa più forte costa ~15 punti di utility.
- **MemAudit** ([arXiv:2605.23723](https://arxiv.org/pdf/2605.23723)): auditing forense post-hoc via causal attribution + structural anomaly detection — esistenza confermata, dettaglio numerico non approfondito in questo giro.
- **Tassonomia del lifecycle** ([arXiv:2604.16548](https://arxiv.org/pdf/2604.16548), survey, fetch diretto): attacchi mappati su 4 fasi — **ingestion** (poisoning/injection), **storage** (persistenza/protezione), **retrieval** (extraction/leakage), **governance** (controllo accessi) — con nota esplicita che vulnerabilità a una fase possono comporsi con quelle di fasi successive.

**Rilevanza diretta per il threat model MuffinOS** (dal BRIEF, non un verdetto ma un collegamento fattuale): il meccanismo MINJA — "contenuto osservato diventa istruzione malevola attivata più tardi, in un contesto diverso, senza bisogno di accesso diretto allo storage" — è **esattamente** lo scenario che il BRIEF descrive come "sotto-problema specifico e grave: memory poisoning" con un messaggio ostile in un gruppo che si attiva molto dopo. Non è un rischio ipotetico da letteratura generica: è un attacco **dimostrato empiricamente con tasso di successo >98%** su sistemi comparabili (agenti con memoria persistente, retrieval-based).

---

## 7. Consolidamento/compattazione: cosa si perde

**Pattern documentati**:
- **Riassunto gerarchico**: Generative Agents (Park et al.) ricorsivamente riassume da dettagli bassi a riflessioni alte, base del pattern (già citato in audit precedente).
- **Pipeline a stadi con perdita dichiarata**: esempio concreto trovato — L1 estrae punti chiave (**~30%** dei token originali), L2 distilla a una frase (**~5%**), L3 tiene solo tag/riferimenti entità (**~1%**) — perdita di informazione **esplicitamente progressiva e dichiarata**, non incidentale.
- **Sleep-time compute** (Letta, §2.3): un agente dedicato riscrive/consolida memoria durante l'inattività — è un meccanismo di consolidamento, con lo stesso rischio (sotto) di ogni riscrittura.

**Cosa si perde, con evidenza specifica (nuovo, verificato)**:

**"Useful Memories Become Faulty When Continuously Updated by LLMs"** ([arXiv:2605.12978](https://arxiv.org/pdf/2605.12978), Zhang, Lin, Wu, Sun, Li, Li, Peng — 14 maggio 2026, fetch diretto confermato per titolo/autori/data/tesi, numeri sperimentali specifici non estratti dal PDF compresso). **Tesi centrale, verificata**: memorie utili aggiornate continuamente da un LLM **tendono a degradarsi e diventare inaffidabili** — parallelo esplicito con fenomeni di neuroscienza (consolidamento della memoria, **interferenza catastrofica**). Aggiornamento continuo causa perdita di informazione utile nel tempo, non solo staticamente al momento della compattazione.

**Caso concreto di fallimento catastrofico da consolidamento, verificato da ricerca**: *"the consolidation step is a lossy rewrite of the memory store where useful details are dropped, spurious rules are introduced, and once-helpful abstractions drift away from the underlying task structure. Agents that incrementally abstract their accumulating trajectories into a textual memory bank can briefly improve or plateau before degrading"* — con un esempio numerico specifico: **GPT-5.4 è arrivato a fallire il 46% dei problemi ARC-AGI dopo aver consolidato da soluzioni ground-truth** (cioè: il consolidamento ha introdotto astrazioni sbagliate anche partendo da dati corretti).

**Critica strutturale alla summarization come meccanismo**: *"summarization is 'ahead-of-time' — the agent summarizes dialogue history before knowing what the future task will be... it might throw away small but important details or focus on the wrong things"* — e *"extraction is usually 'one-off,' lacking a feedback loop to verify facts, which leads to accumulation of information loss"* ([ProMem, arXiv:2601.04463](https://arxiv.org/html/2601.04463v1)), che propone estrazione iterativa/proattiva come alternativa.

**Fallimento empirico documentato di un tentativo di arricchimento del grafo** (non compattazione in senso stretto, ma stesso genere di rischio "un cambiamento intelligente rende le cose peggiori invece che migliori"): un blog tecnico indipendente ([ogham-mcp.dev](https://ogham-mcp.dev/blog/beam-benchmark-v090/), fetch diretto) riporta un esperimento con **spreading activation su grafi di similarità** che ha prodotto una **regressione catastrofica di -44 punti percentuali** su BEAM — segnale che l'implementazione "più intelligente" del grafo non catturava davvero relazioni semantiche profonde e ha peggiorato, non migliorato, il recall.

**Sintesi per questo mandato**: il consolidamento/compattazione non è un'operazione neutra a costo zero — è un'operazione **lossy per costruzione**, con perdita che si accumula ad ogni ciclo di riscrittura, e con almeno un caso empirico documentato di degradazione grave anche partendo da dati corretti. Questo vale per QUALSIASI architettura che consolidi (non solo triple rigide, non solo TKG) — è ortogonale al mandato d'attacco §3 ma rilevante per il design generale del "Modulo Memoria" del BRIEF (compattazione oltre soglia).


---

## 8. Embedding per recall personale multilingue (italiano incluso)

**Nota preliminare, importante**: anche sugli embedding vale il pattern "benchmark theatre" (§1.4) — ho trovato **rivendicazioni multiple e reciprocamente incompatibili di "#1 sulla leaderboard"** a seconda della fonte, della data dello snapshot e di quale board specifica (MTEB inglese v2 vs MMTEB multilingua sono **esplicitamente dichiarati non comparabili tra loro** dalla stessa community MTEB). Riporto ogni numero con fonte e data, senza tentare di riconciliare le rivendicazioni contrastanti.

**Discrepanze osservate esplicitamente (per trasparenza)**: Qwen3-Embedding-8B è riportato sia come "70.58 MTEB multilingual, #1 al 5 giugno 2025" sia come "~75% average MTEB tasks" in un'altra fonte dello stesso periodo — probabilmente sottoinsiemi di task diversi, non ho potuto riconciliare. Voyage-3-large è riportato sia "65.1 MTEB" sia "67.1 MTEB a 1024 dimensioni" in due fonti diverse. Il leaderboard MMTEB ufficiale a **luglio 2026** vede **KaLM-Embedding-Gemma3-12B (Tencent) #1 con 72.32**, mentre altre fonti dichiarano Gemini Embedding "al vertice della classifica pubblica MTEB con 68.32" — probabilmente board/date diverse.

**Italiano, specifico**: unica fonte con un numero diretto per l'italiano trovata: [arXiv:2605.23618](https://arxiv.org/pdf/2605.23618) ("Benchmarking Google Embeddings 2 against Open-Source Models for Multilingual Dense Retrieval", Cirillo/Desiato/Polese/Solimando, 25 maggio 2026 — fetch diretto conferma paper/autori/data ma non la tabella numerica completa, dati sotto da estratto di ricerca non da lettura diretta della tabella): su corpus italiano corto, **multilingual-e5-large e Gemini Embedding 2 sono "effettivamente equivalenti"** — nDCG@10 **0.282 vs 0.279** (differenza 0.003). Nessun numero specifico trovato in questo giro per qwen3-embedding/bge-m3/jina su italiano puro — solo aggregati multilingua a 100+/250+ lingue → `[NON VERIFICATO nello specifico italiano per questi modelli]`.

### Tabella embedding

| Modello | Tipo | Score (fonte/data) | Multilingua/IT | Dim. | Footprint locale | Prezzo cloud |
|---|---|---|---|---|---|---|
| **Qwen3-Embedding-0.6B** | locale | MMTEB 64.33 (**+7.9% relativo su BGE-M3** a parità di parametri, fonte comparativa 2026) | 100+ lingue dichiarate | Matryoshka (variabile) | ~1.2GB fp16 / ~0.6GB int8 (stima aritmetica standard da param-count, non un benchmark VRAM diretto) | — (locale) |
| **Qwen3-Embedding-4B** | locale | non trovato isolatamente in questo giro | 100+ lingue | Matryoshka | ~8GB fp16 / ~4GB int8 (stima) | — |
| **Qwen3-Embedding-8B** | locale | 70.58 MMTEB (#1, 5 giu 2025) **o** ~75% avg MTEB (fonte alternativa, stesso periodo — discrepanza non riconciliata) | 100+ lingue | Matryoshka | ~16GB fp16 / ~8GB int8 (stima) | — |
| **BGE-M3** | locale | MMTEB 59.56 (fonte comparativa 2026) | 100+ lingue, dichiarato "più forte per hybrid search multilingua" (dense+sparse+multi-vector unico) | 1024 | non quantificato in questo giro | — |
| **Nomic-Embed v2** | locale | non trovato in questo giro | dichiarato per documenti lunghi | — | Apache 2.0, non quantificato | — |
| **jina-embeddings-v4** | locale/API | MMTEB 66.49 (**+12% su text-embedding-3-large**, 59.27), MTEB-en 55.97 | multimodale + multilingua, Matryoshka fino a 128 dim (<1% perdita a 256d) | 128-2048 (MRL) | 3.8B param (Qwen2.5-VL-3B based) — footprint non quantificato in GB in questo giro | via API Jina |
| **EmbeddingGemma** | locale | "miglior modello multilingua open <500M su MTEB" (claim relativo, non numero assoluto trovato) | 100+ lingue | 768→128 (MRL) | 308M param (100M model + 200M embedding) — footprint minimo, ottimizzato on-device/mobile, disponibile via Ollama | — |
| **Voyage-3-large** | cloud | 65.1 MTEB **o** 67.1 a 1024-dim (due fonti, non riconciliate) | multilingua, +4-6 punti su codice/legale/medico vs generalisti (claim vendor) | 1024 (variabile) | n/a | **$0.06/1M token**, 200M token gratis |
| **OpenAI text-embedding-3-large** | cloud | 64.6 MTEB | multilingua generico | riducibile a runtime | n/a | $0.13/1M token |
| **gemini-embedding-001** | cloud | 68.32 MTEB (claim "al vertice della leaderboard pubblica", data non specificata con precisione) | multilingua, italiano ~equivalente a mE5-L (nDCG@10 0.279 vs 0.282, arXiv:2605.23618) | 768/1536/3072 | n/a | $0.15/1M token |
| **KaLM-Embedding-Gemma3-12B** (Tencent) | locale/API | **72.32 MMTEB, #1 ufficiale a luglio 2026** | multilingua | — | 12B — footprint elevato, non quantificato | — |

**Sintesi onesta per questo mandato**: per un caso d'uso "recall personale multilingue con italiano" **non esiste, in questo giro di ricerca, un numero italiano-specifico affidabile e comparativo tra i modelli candidati locali (qwen3-embedding/bge-m3/EmbeddingGemma)** — l'unico dato italiano diretto trovato riguarda gemini-embedding-2 vs multilingual-e5-large, entrambi sostanzialmente equivalenti su un corpus corto. La scelta tra locale e cloud per l'italiano, su questa sola evidenza, **non è decidibile con confidenza dai numeri MTEB/MMTEB aggregati disponibili** — servirebbe un eval italiano-specifico diretto (coerente con `feedback_synthetic_eval_magnitude.md`: i benchmark aggregati validano meccanismo, non magnitudine per una lingua specifica).

---

## 9. Entity resolution cross-source

**Nei sistemi di memoria-agenti coperti**: il meccanismo più dettagliato e verificato è quello di **Graphiti** (§2.1) — MinHash+LSH deterministico con filtro di entropia + fallback LLM, due-pass. Ma questo risolve duplicati **dentro lo stesso grafo/dominio testuale** (es. "Alice" e "my coworker Alice" nella stessa conversazione, citato per Hindsight) — **non ho trovato un solo caso documentato, in nessun sistema di memoria-agente coperto, di risoluzione esplicita "stesso utente, handle Telegram X = handle Discord Y"** con un meccanismo dedicato e testato. Questo è un gap reale, diretto per lo scenario community cross-connector del BRIEF → `[NON VERIFICATO / gap aperto]`.

**Prior art da CDP/CRM (customer data platform), verificato**: questo è il campo con più esperienza reale su identità cross-canale.
- **Accuratezza**: matching probabilistico cross-dispositivo raggiunge tipicamente **70-90%** di accuratezza anche con sistemi sofisticati; vendor specifici dichiarano risultati più alti (LiveRamp: **>99% match rate**, validato da Comscore come terza parte — claim vendor con validazione esterna dichiarata, non riverificato da me sulla metodologia Comscore).
- **Trade-off esplicito documentato**: precisione (evitare falsi match) e copertura (trovare più match) **tirano in direzioni opposte** — "a high raw match rate paired with low precision means you're getting more false positive matches, which can inflate attribution numbers and mislead budget decisions".
- **Anchor identity più comune ma più debole**: l'email è l'identificatore più usato nel settore ma anche tra i più deboli, perché "customers use multiple email addresses, share family accounts, and change addresses over time".
- **Strategia semplice realmente usata in produzione per agenti chat cross-canale** (non probabilistica, deterministica): usare l'email del cliente come `user_id` **così che risolve naturalmente attraverso i canali indipendentemente da quale canale il cliente ha usato per contattare** (pattern citato per mem0/Twilio in contesto customer-support) — nota: questo presuppone che l'email sia **nota e condivisa** tra i canali, che non è garantito per handle Telegram/Discord anonimi in un contesto community personale (diverso dal customer-support enterprise dove l'email è quasi sempre raccolta).

**Entity resolution in pratica, lezioni da un sistema self-serve di produzione (nuovo, verificato via fetch diretto)**: [arXiv:2607.26298](https://arxiv.org/html/2607.26298) ("Entity Resolution in Practice: Lessons from a Self-Serve Pipeline", Pavani/Aluri/Jadhav/Prasad/Sanka, **28 luglio 2026** — il paper più recente trovato in tutto questo report), testato su 6 benchmark da 864 a 5M record:
1. **"Nessun singolo matcher vince ovunque"** — tornei tra DeepMatcher/LightGBM/GAT selezionati per dataset, nessuno strettamente dominante (DeepMatcher e LightGBM vincono 3/6 benchmark ciascuno).
2. **"Precisione e recall richiedono fix separati, non una soglia condivisa"** — veti hard rule-based migliorano la precisione, strategie di blocking diverse migliorano il recall; una soglia singola non può ottimizzare entrambe.
3. **"Un singolo link falso-positivo può fondere silenziosamente entità non correlate"** (rischio di **chiusura transitiva**): un esempio concreto documentato — due sedi diverse di "Sakura Sushi" fuse erroneamente tramite un record-ponte scarso. Mitigazione: clustering "verified-merge" con ri-verifica attiva cross-cluster invece di chiusura transitiva ingenua.

**Modi di fallimento documentati, aggregati**: record-ponte sparsi che fondono cluster non correlati per mancanza di campi popolati in conflitto; retriever a embedding che mancano varianti superficiali dello stesso nome operando in singola modalità; cascata di mega-cluster da un singolo errore di matching (chiusura transitiva, sopra).

**Implicazione diretta per MuffinOS** (fattuale, non un verdetto): se una community unisce Telegram+Discord, il rischio più concreto e documentato in letteratura CDP/ER non è "non troviamo il match" ma **"un match falso-positivo fonde silenziosamente due persone diverse"** — il costo di un errore di tipo merge-sbagliato è più difficile da rilevare a posteriori (nessun errore visibile a runtime, esattamente come il caso Muffin di §3.0) rispetto a un errore di tipo "non ho trovato il match" (che almeno è visibile come "l'agente non mi riconosce").


---

## Tabelle di chiusura

### Tabella 3×3 — mandato d'attacco (Addendum owner №1)

| | **LATENZA A RUNTIME** | **CONTRADDIZIONI NEL TEMPO** | **MANUTENIBILITÀ** |
|---|---|---|---|
| **(i) Triple rigide + vincoli** | Nessun numero pubblico per il pattern esatto (soggetto→predicato→oggetto + vincoli tipo "un solo padre") su chat personale. Per analogia: costo aggiuntivo di validazione/retry su schema-violation, non quantificato in fonte alcuna. `[NON VERIFICATO]` | Il vincolo stesso funge da contradiction-rejector — ma SOLO se il vincolo è vero nel dominio. Quando non lo è (predicato naturalmente multi-valore trattato come singleton), **l'update sbagliato viene eseguito silenziosamente, non rifiutato**. Evidenza diretta: Muffin stesso, 27/28 `interest` + 21/22 `preference` scaduti erroneamente, scoperto solo da audit manuale settimane dopo (ADR-025, §3.0). | Letteratura generale: entity duplication, redundancy semantica, "nessuna ontologia universalmente corretta". Evidenza diretta e verificabile file:riga: Muffin ha diagnosticato "ontologia chiusa stretta" come substrate-blocker e l'ha **riscritta interamente un mese dopo** (v2→v3, 24 apr→11 mag 2026, ADR-009). Ricerca 2026 (AdaKGC, DIAL-KG) va esplicitamente nella direzione opposta alla rigidità upfront. |
| **(ii) TKG schema-light (Graphiti/Zep)** | Range 150-780ms dichiarato per il recall a seconda della fonte/config (pattern benchmark-theatre); ingest = min. 1 chiamata LLM/messaggio (per analogia con Mem0 ADD-only, ~500ms) + entity resolution (fast-path deterministico MinHash/LSH + fallback LLM su ambiguità, non quantificato in numero esatto di chiamate). | **Bug aperto e documentato**: il giudice di contraddizione (`EdgeDuplicate`) collassa da 7/15 a 0/3 su casi di stress con modelli non-reasoning economici (graphiti#1666, aperto, non risolto). Con modello reasoning: 14/15, ma più costoso. Inoltre: BEAM trova che contradiction resolution è l'abilità **più debole per tutti i sistemi testati**, non solo per Graphiti — il problema non è specifico di questo approccio. | Schema **opzionale e additivo** (Pydantic custom entity/edge type sovrapposti all'estrazione libera): aggiungere attributi è backward-compatible per design, nessuna migrazione distruttiva documentata. Vocabolario libero per default, gestito con audit periodico + soglia di escalation (pattern identico a quello scelto indipendentemente da Muffin in ADR-017), non con enforcement upfront. |
| **(iii) hybrid GraphRAG** | Ingest costoso nella variante classica ($1.60-2.41/1M token + 30-50% community detection; early deployment fino a $33.000 per un dataset); varianti 2026 (LazyGraphRAG, LightRAG) riducono drasticamente: LazyGraphRAG indicizza a costo ≈ vector RAG semplice, query >700× più economica; LightRAG $0.04/query, 3-5s, 1 chiamata LLM (10-30× più economico, 6-13× meno latente del GraphRAG classico). Query classico: ~114-143ms ma $1.20-1.80/query. | Design pensato per corpus relativamente statici (community summary ricalcolate periodicamente) — nessun meccanismo di invalidazione per-fatto paragonabile a (ii). Re-summarization periodica ≠ tracciamento di contraddizione puntuale. `[NON VERIFICATO — probabilmente non il regime per cui questi sistemi sono ottimizzati]`. | Ri-lavorazione della granularità community (Leiden) richiede re-indicizzazione nella variante classica (costosa, sopra); LazyGraphRAG/LightRAG riducono il costo di ogni ri-lavorazione spostando il lavoro a query-time (poco da invalidare). GraphRAG **vince 70-80% dei task di "complex sensemaking"** vs RAG semplice (Microsoft Research) — evidenza che strutturare non è di per sé sbagliato nel regime giusto. |

**Evidenza che va nella direzione opposta al sospetto dell'owner** (raccolta esplicitamente): GraphRAG vince nettamente sui task per cui è disegnato (sensemaking complesso); Graphiti/TKG schema-light non è "gratis" sull'asse contraddizioni — ha un bug aperto documentato proprio lì; l'estensibilità backward-compatible di Graphiti è comunque una forma di schema (additivo, mai bloccante), non l'assenza di struttura. **Evidenza a favore del sospetto dell'owner**: Muffin stesso ha vissuto e abbandonato un'ontologia chiusa in un mese; il caso singleton-vs-set-valued (ADR-025) è danno silenzioso su dati reali, verificabile file:riga; nessun sistema di memoria-agenti reale con trazione trovato implementa il pattern esatto "triple + vincoli di coerenza" descritto nel brief.

### Tabella comparativa architetture

| Sistema | Modello dati | Tempo/validità | Provenienza | Benchmark top | Costo/latenza |
|---|---|---|---|---|---|
| **Zep/Graphiti** | Property graph bi-temporale (Episode/Entity/Community), schema Pydantic opzionale sovrapposto | 4 timestamp (t_valid/t_invalid/t_created/t_expired), mark-expired mai delete | Episode = evidenza canonica grezza, source-linked | LoCoMo 75.14-94.7% (**conteso**, §1.1) | Ingest: ≥1 LLM call/msg + entity res.; recall 150-780ms (fonti discordanti) |
| **Mem0 (2026)** | History-based (ADD/UPDATE/DELETE events), grafo **rimosso** nel 2026 | Bi-temporale su singoli fatti (non un grafo) | Non specificato in dettaglio in questo giro | LoCoMo 92.5% (**conteso**) | Ingest 1 LLM call, ~500ms; recall p50 0.148s/p95 0.200s |
| **Letta (ex MemGPT)** | Core/archival/recall (3 tier) + MemFS opzionale (fs git-backed, coding-agent shaped) | Self-editing esplicito via tool, non bi-temporale nativo | block_history undo/redo | Non ri-verificato in questo giro (v. audit precedente) | Sleep-time compute: -5× compute a runtime su alcuni task (2 agenti separati) |
| **HippoRAG 2** | Grafo passage+phrase (Neo4j/vec), Personalized PageRank | Non bi-temporale (focus retrieval, non validità nel tempo) | passage back-link | +7 F1 su NV-Embed-v2 (factual/sense-making/associative) | Dichiarato più efficiente offline di GraphRAG/RAPTOR/LightRAG (non quantificato) |
| **Microsoft GraphRAG classico** | Community graph (Leiden) + summary gerarchiche | Nessuna invalidazione per-fatto; re-summarization periodica | Non centrale al design | Vince 70-80% task "sensemaking" vs RAG (Microsoft Research) | Ingest $1.60-2.41/1M tok +30-50%; query $1.20-1.80, 114-143ms |
| **LazyGraphRAG** | Come sopra, sintesi rimandata a query-time | Come sopra | Come sopra | Qualità ≈ GraphRAG globale | Ingest ≈ vector RAG; query >700× più economica, +2-8s latenza |
| **LightRAG** | Grafo LLM-estratto + PPR, 1-2 hop | Non bi-temporale nativo | Non centrale | Comparabile a GraphRAG su alcuni task (claim vendor) | $0.04/query, 3-5s, 1 LLM call — 10-30× più economico/6-13× meno latente di GraphRAG |
| **A-MEM** | Note Zettelkasten auto-linkate, nessuno schema fisso | Evoluzione continua (nuove memorie aggiornano rappresentazioni vecchie) | Non specificato | 6× multi-hop reasoning, -85/-93% token | Non quantificato |
| **MIRIX** | 6 tipi fissi (Core/Episodic/Semantic/Procedural/Resource/Knowledge Vault) | Episodic = timestampato; resto non bi-temporale esplicito | Non specificato in dettaglio | +35% vs RAG baseline (vendor) | -99.9% storage (vendor) |
| **Cognee** | Property graph unificato (Postgres/SQLite+LanceDB+Kuzu), pipeline ECL | Non specificato in dettaglio in questo giro | Non specificato | Human-like 0.93/DeepEval 0.85 su HotpotQA-style (**tuned vs default competitor**, §2.8) | Single-instance deployment, 14 modalità retrieval |
| **Memobase** | User-profile strutturato + event timeline (non grafo) | Non specificato | Non specificato | Nessun benchmark pubblico trovato | Batch buffer per utente (overhead distribuito) |
| **Supermemory** | 5-layer (connettori/estrattori/Super-RAG/memory-graph/user-profile) | Dichiarato risolvere contraddizioni + ordine temporale (non dettagliato meccanicamente) | Non specificato in dettaglio | LongMemEval-S 85.4%/92.3% single-session | <300ms, 100B+ tok/mese processati (vendor) |
| **Eywa** (ricerca) | "Evidence before belief" — evidenza immutabile prima di fatti derivati | Non specificato in dettaglio | **Design-centrico su provenienza** — read path deterministico zero-LLM | Non estratto in questo giro | Zero chiamate LLM nel retrieval (per design) |
| **Muffin (attuale, per riferimento)** | Property graph (entities/entity_attributes/entity_edges/entity_mentions) bi-temporale + SQLite relazionale + vec/FTS | 4 timestamp completi dal WG-1; predicati/sub_kind liberi con audit periodico (ADR-017) | 8 bridge provenance (parzialmente vuote, audit precedente) | Non sottoposto a LoCoMo/LongMemEval/BEAM esternamente | RRF hybrid k=60, no reranking (gap noto, audit precedente) |

### Tabella embedding (ripetuta per chiusura, vedi §8 per dettagli/caveat)

| Modello | Score (fonte/data) | Multilingua/IT | Dim. | Footprint locale | Prezzo cloud |
|---|---|---|---|---|---|
| Qwen3-Embedding-0.6B | MMTEB 64.33 | 100+ lingue | Matryoshka | ~1.2GB fp16 (stima) | locale |
| Qwen3-Embedding-4B | non trovato isolatamente | 100+ lingue | Matryoshka | ~8GB fp16 (stima) | locale |
| Qwen3-Embedding-8B | 70.58-75% MTEB (discrepanza fonti) | 100+ lingue | Matryoshka | ~16GB fp16 (stima) | locale |
| BGE-M3 | MMTEB 59.56 | 100+ lingue, hybrid dense+sparse+multi-vec | 1024 | non quantificato | locale |
| Nomic-Embed v2 | non trovato | documenti lunghi | — | Apache 2.0 | locale |
| jina-embeddings-v4 | MMTEB 66.49 | multimodale+multilingua | 128-2048 MRL | 3.8B param | API Jina |
| EmbeddingGemma | "top open <500M" (relativo) | 100+ lingue | 768→128 MRL | 308M param, on-device | locale |
| Voyage-3-large | 65.1-67.1 MTEB (discrepanza fonti) | multilingua | 1024 | n/a | $0.06/1M tok |
| text-embedding-3-large (OpenAI) | 64.6 MTEB | multilingua | riducibile | n/a | $0.13/1M tok |
| gemini-embedding-001 | 68.32 MTEB | IT: nDCG@10 0.279 (≈mE5-L 0.282) | 768/1536/3072 | n/a | $0.15/1M tok |
| KaLM-Embedding-Gemma3-12B | 72.32 MMTEB (#1 ufficiale lug 2026) | multilingua | — | 12B, elevato | locale/API |


---

## Sintesi (per pitch/ADR — incollabile senza rileggere tutto)

1. **Nessun approccio (triple rigide / TKG schema-light / hybrid GraphRAG) risolve bene le contraddizioni** — BEAM (arXiv:2510.27246, ICLR 2026) trova che "contradiction resolution" è l'abilità più debole per *tutti* i sistemi testati, incluso quello memory-augmented; e Graphiti — la candidata "vincente" secondo il sospetto dell'owner — ha un bug **aperto e non risolto** sul proprio giudice di contraddizione (7/15→0/3 su stress-test con modelli economici non-reasoning, [graphiti#1666](https://github.com/getzep/graphiti/issues/1666)).
2. **Muffin ha già l'evidenza più diretta possibile in casa propria**: un'ontologia chiusa è stata diagnosticata come substrate-blocker e riscritta un mese dopo (ADR-009, v2→v3), e un vincolo di coerenza "un solo valore corrente" su predicati che sono naturalmente multi-valore (`interest`/`preference`) ha **corrotto silenziosamente 89 credenze reali** prima di essere scoperto da audit manuale (ADR-025) — è il pattern esatto temuto dal brief, verificabile file:riga, non letteratura.
3. **I benchmark di memoria per agenti sono in una crisi di credibilità documentata**: LoCoMo ha 6.4% di errori nella ground truth e un judge che accetta il 62,81% di risposte sbagliate; Zep e Mem0 si contestano a vicenda i numeri LoCoMo dal 2025 e ancora ad agosto 2026 (94.7% vs 92.5%, entrambi contestati); EverMemOS dichiara 92.32% ufficiale contro 38.38% riprodotto indipendentemente. Trattare qualunque claim "SOTA X%" come segnale debole, non come verità.
4. **Property graph (Neo4j/FalkorDB/Kuzu), non RDF, è lo storage universale** in tutti i sistemi di memoria-agenti con trazione reale coperti (Graphiti/Cognee/HippoRAG/MIRIX); nessun sistema reale implementa il pattern esatto "triple soggetto→predicato→oggetto con vincoli di coerenza" descritto nel brief — è un gap di prior art diretto, né a favore né contro.
5. **Memory poisoning non è un rischio ipotetico**: MINJA (arXiv:2503.03704) dimostra iniezione query-only con 98.2% di successo medio e 76.8% di attack success su agenti con memoria persistente comparabili; SMSR (arXiv:2606.12703) è l'unica difesa con numeri end-to-end verificati (65.3%→5.3% successo attacco, costo 15pp di utility) — rilevante diretto per il threat model "memoria come vettore di esfiltrazione" del BRIEF.

