# Muffin — REFERENCES.md

Questo documento raccoglie i paper scientifici che informano le decisioni di design del progetto. Per ciascuno: citazione, contributo principale, link con Muffin, lista dei doc del progetto che lo referenziano.

La distinzione tra "paper già in uso" e "paper da valutare" è operativa, non una valutazione di qualità. Un paper è "in uso" quando è fondativo per decisioni di design prese o pianificate — è stato letto, compreso, e un suo elemento è entrato o entrerà a breve nel disegno di Muffin. Un paper è "da valutare" quando è rilevante per il dominio ma non ha ancora prodotto decisioni di design concrete, o è nominato nei doc come reference generica senza aver guidato scelte specifiche.

I PDF dei paper vivono nel project knowledge (non in questo repo), così chiunque legga Muffin abbia accesso immediato alle fonti. I numeri arXiv riportati sotto sono da verificare al momento del caricamento — alcuni potrebbero essere stati ricostruiti dalla memoria delle discussioni e non da consultazione diretta.

---

## Paper già in uso

### Zep / Graphiti — Temporal Knowledge Graphs for Agent Memory

**Citation**: Rasmussen, P. et al. (2025). *Zep: A Temporal Knowledge Graph Architecture for Agent Memory*. arXiv:2501.13956.

**Cosa dice**: Introduce una architettura di memoria per agenti LLM basata su knowledge graph bi-temporale — ogni entità e ogni relazione hanno due coppie di timestamp: *event time* (quando la cosa è accaduta nel mondo) e *ingestion time* (quando il sistema l'ha appresa). Quando un'informazione cambia, il sistema invalida temporalmente la vecchia versione (`valid_to = now`) invece di cancellarla; il record precedente resta queryabile come storia. Gli episodi di input vengono processati per estrarre entità tipate e relazioni strutturate via LLM, con entity resolution che deduplica nodi equivalenti.

**Perché ci interessa**: è il pattern di riferimento per il substrato dati di Muffin. I fatti di Muffin hanno già bi-temporal (`valid_from`/`valid_to`) implementato, allineato a Graphiti. Il world graph in progettazione per il Layer 8 è modellato concettualmente sullo stesso approccio — entità come nodi di prima classe con storia, edge tipati invalidati invece che cancellati, provenance verso gli episodi sorgente. La differenza sostanziale rispetto all'approccio Graphiti è che Muffin non partirà da zero ma migrerà incrementalmente dal pattern `state_entries` esistente.

**Dove è citato**: \pillars/memory/layers/03_facts.md`,`pillars/memory/layers/08_graph.md`. Originale ingit history (memory layer audit, apr 2026).

### A-MEM — Atomic Memory Notes with Contextual Descriptions

**Citation**: Zhang, Z. et al. (2025). *A-MEM: Agentic Memory for LLM Agents*. arXiv:2502.12110.

**Cosa dice**: Propone un modello di memoria per agenti LLM basato su *atomic notes* — unità atomiche di memoria che combinano contenuto grezzo, una contextual description generata dall'LLM al momento del salvataggio, keywords, tags, e link bidirezionali verso note correlate. L'LLM al save time decide a quali note esistenti la nuova si collega, creando una struttura a grafo emergente senza ontologia rigida. Il sistema non ha categorie predefinite — la struttura emerge dai link generati dinamicamente dal modello.

**Perché ci interessa**: le observations di Muffin sono parenti stretti degli atomic notes — hanno contenuto, significance, depth, evidence_ids che puntano agli episodi sorgente. La differenza è che Muffin oggi non ha la componente "contextual description LLM-generata al save time", che aggiungerebbe un livello di semantica esplicita sopra al solo embedding. Il link-as-emergent-structure di A-MEM è anche rilevante per il dibattito graph-edges vs world-graph in Muffin: A-MEM mostra che link emergenti LLM-generati possono essere più flessibili di una tassonomia chiusa di predicati.

**Dove è citato**: \pillars/memory/layers/09_observations.md`. Originale ingit history (memory layer audit, apr 2026).`

### Mem0 / Mem0g — Multi-Signal Hybrid Retrieval

**Citation**: Chhikara, P. et al. (2025). *Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory*. arXiv:2504.19413.

**Cosa dice**: Descrive un sistema di memoria per agenti production-grade con retrieval multi-signal che combina BM25 (keyword), vector similarity (semantic), ed entity matching come tre canali separati fusi via Reciprocal Rank Fusion. Introduce anche il concetto di *user profile* come struttura persistente aggregata dai fatti accumulati, rigenerata periodicamente. La variante Mem0g aggiunge un graph layer sopra per relazioni esplicite tra entità.

**Perché ci interessa**: il retrieval hybrid di Muffin è già SOTA-allineato per due canali su tre (FTS5 per keyword, sqlite-vec per semantic, fusi via RRF). Il terzo canale — entity matching — è il gap che il world graph va a chiudere: quando una query matcha un'entità con alta confidenza, il contesto può includere gli attributi attivi di quell'entità e le sue relazioni 1-hop. Il pattern "user profile come aggregato rigenerato" è già presente in Muffin come `living_profile` rigenerato dal dream cycle, con la differenza che Muffin rigenera con gate e Mem0 rigenera con cadenza fissa.

**Dove è citato**: \pillars/memory/layers/03_facts.md`,`pillars/memory/layers/08_graph.md`. Originale ingit history (memory layer audit, apr 2026).`

### Nemori — Predict-Calibrate Learning + Event Segmentation

**Citation**: Wang, Z. et al. (2025). *Nemori: Episodic Memory Construction for LLM Agents via Predict-Calibrate Learning*. arXiv:2508.03341.

**Cosa dice**: Propone due contributi distinti. Il primo è il principio *predict-calibrate*: invece di estrarre tutti i fatti da una conversazione, il modello prima *predice* cosa si aspetta dato il contesto esistente, poi confronta con la realtà, e apprende solo dai *gap predittivi*. Riduce ridondanza e aumenta precisione — benchmark su LoCoMo mostrano +10 punti rispetto a extraction naive. Il secondo contributo è il *Two-Step Alignment Principle*, ispirato alla Event Segmentation Theory delle scienze cognitive: gli episodi di memoria non si segmentano per timestamp arbitrari ma per *boundary topicali* — un nuovo episodio inizia quando il topic conversazionale cambia, non dopo N minuti.

**Perché ci interessa**: è il paper più ricco di applicazioni su Muffin. (1) Predict-calibrate è candidato a principio trasversale — applicabile all'extraction di fatti (Layer 3), alla generation di observations prima della delivery (Layer 9), all'append di narratives (Layer 6), e potenzialmente alla segmentation di episodi (Layer 5). (2) La topic-based segmentation è la direzione target del Layer 5 di Muffin — oggi gli episodi sono per-turno (segmentation arbitraria), mentre il target è boundary topicale come Nemori. Questo cambio è nel piano di evoluzione del substrato.

**Dove è citato**: \pillars/memory/layers/03_facts.md`,`05_episodes.md`,`06_narratives.md`,`09_observations.md`,`pillars/memory/LAYERS.md §Cross-cutting 5`. Referenziato indirettamente da`foundations/UNDERSTANDING.md` (predict-calibrate come pattern). Originale in git history (memory layer audit, apr 2026).`

### Memento — Bitemporal Knowledge Graph on SQLite+FTS5

**Citation**: Farkas, S. et al. (2026). *Memento: Bitemporal Knowledge Graph for AI Agents*. github.com/shane-farkas/memento-memory (April 2026).

**Cosa dice**: Sistema di memoria per agenti basato su knowledge graph bi-temporale (valid-time + system-time) implementato su SQLite + FTS5 — stesso stack di Muffin. Entity resolution a tier (Exact > Fuzzy > Phonetic > Embedding > LLM tiebreaker) — determinismo prima, LLM solo come ultima risorsa. Reports 92.4% su LongMemEval. Insight forte: "context dilution kills accuracy (4K→8K tokens hurt performance)" — limita aggressivamente cosa entra nel contesto.

**Perché ci interessa**: è la SOTA più vicina allo stack di Muffin. Il pattern di entity resolution a tier è direttamente importato in `foundations/INVARIANTS.md §I-2`. Il warning su context dilution informa la disciplina di rate-limit e priority-rank al retrieval, e collegamente il principio P-I.

**Dove è citato**: `foundations/INVARIANTS.md §I-2`, atteso in `pillars/memory/layers/08_graph.md`.

### Letta — Sleep-Time Compute

**Citation**: Letta team (2025). *Sleep-Time Compute: Two-Agent Architecture for Personal AI*. arXiv:2504.13171 + blog Letta (May 2025).

**Cosa dice**: Pattern a due agenti: primary (latenza utente) + sleep-time (background context refinement, **non emette outbound**). Il sleep-time agent rifinisce learned context durante idle window, ma l'outbound resta privilegio del primary che sa quando l'utente è ricettivo. La separazione previene la classe di errori "sleep-time agent che disturba l'utente con cose che ha imparato".

**Perché ci interessa**: informa la separazione tra Decider proattivo e dream cycle in Muffin. Il dreamer è già sleep-time per il consolidation; il Decider non dovrebbe essere "sleep-time agent emette messaggi" ma "primary smart-trigger sopra pipeline esistenti". Pattern canonico per riconciliare awareness continua e UX non invasiva.

**Dove è citato**: atteso in `design/DESIGN.md §awareness loop` e `reference/ARCHITECTURE.md §thinker`.

### Hindsight — 4 Networks with Opinions and Confidence

**Citation**: Vectorize team (2025). *Hindsight: Persistent Memory for AI Agents with Opinion Tracking*. arXiv:2512.12818 + github.com/vectorize-io/hindsight.

**Cosa dice**: Architettura di memoria con 4 reti separate: world facts, experience facts, observations, **opinions con confidence**. Le opinions hanno confidence updateable e mechanism esplicito di "change of mind" — contraddizione strong → riduce confidence E (eventualmente) testo. 91.4% LongMemEval con modello 20B aperto (classe Gemma 4 31B IT).

**Perché ci interessa**: il pattern "opinions con confidence + mechanism di revisione esplicito" è ciò che `foundations/INVARIANTS.md §I-6` (confidence esplicita) traduce in Muffin. La separazione in 4 reti distinte è alternativa al modello memory di Muffin (post-MEM-C 2026-05-21: 4 categorie pragmatiche — cognitive introspective / relational graph / knowledge artifacts / runtime in-context) — interessante come confronto, non come copia.

**Dove è citato**: `foundations/INVARIANTS.md §I-6`, atteso in `pillars/memory/LAYERS.md`.

### Silicon Mirror — Anti-Sycophancy via Generator-Critic

**Citation**: [Vendor TBD] (2026). *Silicon Mirror: Necessary Friction for Anti-Sycophancy in LLMs*. arXiv:2604.00478 (April 2026).

**Cosa dice**: Generator-Critic loop con "Necessary Friction": dopo che il Generator produce un draft, un Critic separato (callLight dedicato) cerca evidence che disconferma il draft, e il Generator revide. Reports 85.7% reduction di sycophancy su Sonnet 4.

**Perché ci interessa**: il counterpoint profile attuale di Muffin è in direzione giusta (anti-sycophancy via counterpoint reference) ma è "1 sample" — un blob di testo iniettato a turno. Il Generator-Critic loop è il pattern più forte. Su Gemma 4 31B IT probabilmente ottiene >50% reduction. Da considerare per estendere il counterpoint da "iniezione di prompt" a "second pass strutturato".

**Dove è citato**: atteso in `pillars/memory/layers/01_identity.md §counterpoint extension`.

### Pare-Bench — Tempismo delle proposte proattive

**Citation**: Nathani, Zhang, Saxon, Wang et al. (2026). *Proactive Agent Research Environment: Simulating Active Users to Evaluate Proactive Assistants*. arXiv:2604.00842 (1 aprile 2026).

**Cosa dice** *(rettificato 2026-08-10 sul testo primario — la voce precedente aveva modello e numeri sbagliati)*: 143 task, app modellate come macchine a stati. La metrica non è "proposte premature": è la quota di proposte che innescano un **gather context**, cioè l'utente aveva bisogno di altre informazioni prima di poter agire — il proxy del paper per il tempismo sbagliato. **Gemma 3 4B Instruct 74,7% ±2,6%**, **Claude 17,8%**, **GPT-5 23,4%**; delle proposte di Gemma solo il **16,0%** è accettato direttamente.

*(La voce diceva "Gemma 4 31B IT", Claude 12,8%, Qwen 26,5%, e chiamava la metrica "proposte premature". Tenuto qui invece che cancellato: una citazione sbagliata che è stata usata per decidere è un fatto sul progetto.)*

**Perché ci interessa**: il divario di tempismo fra un modello piccolo e uno di frontiera è di circa quattro volte, ma **17,8% resta un errore su sei col modello buono** — cioè il gate meccanico fuori dal modello si giustifica anche assumendo il modello migliore, non solo come pezza sui piccoli. È il fondamento empirico dello Stadio-1 deterministico in `core/scheduler/proactivity.ts` e `core/memory/absence.ts`.

**Dove è citato**: atteso in `design/DESIGN.md §decider mechanical gates`, `pillars/planning/README.md`.

### ValueActionLens — Value-Action Gap in LLMs

**Citation**: Shen et al. (2025). *Mind the Value-Action Gap: Do LLMs Act on Their Stated Values?*. arXiv:2501.15463 (EMNLP 2025).

**Cosa dice**: Benchmark con 14.8k azioni × 12 culture × 11 topic. Conclusione: *"alignment between stated values and actions is sub-optimal, varies significantly across scenarios and models. Do not rely solely on stated values to predict behavior."* I modelli ricordano l'istruzione iniziale, poi driftano dall'azione coerente.

**Perché ci interessa**: è il fondamento empirico per la regola "behavior instructions devono materializzarsi in stato meccanico, non testo nel prompt". Quando Giusto dice "non scrivermi mentre lavoro", la materializzazione in `muffin_status.dnd` (gate prima della call) è più affidabile della behavior instruction nel prompt. Informa P-J (audit periodico) come compensazione strutturale del drift.

**Dove è citato**: `foundations/PRINCIPLES.md §P-J`, atteso in `design/DESIGN.md §materializzazione preferenze`.

### Pitfalls of Reasoning — Instruction Attenuation in CoT

**Citation**: Amazon Science (2025). *When Thinking Fails: Pitfalls of Reasoning for Instruction-Following*. NeurIPS 2025.

**Cosa dice**: 13 modelli su 14 degradano su IFEval quando CoT è ON, e il gap si allarga con CoT più lungo. Il modello "drifta" dall'istruzione originale durante il reasoning prolungato.

**Perché ci interessa**: spiega il pattern osservato in produzione su Muffin pre-2026-04-29 (regressioni "come stai?" senza self_inspect, "4 giorni fa" allucinato con thinking ON). Informa la decisione di tenere `thinkingMode` configurabile per-chat via `/think`, default ON solo dopo l'introduzione del verify pillar (`<unknown_terms>` deterministico + pipeline auto-fire `<verified_terms>` via `memory/verify_pipeline.ts`, post Tool Registry 1.0 follow-up 2026-05-24 — pre-fix il pillar usava il tool LLM-callable `verify_unknown_term` ora droppato) che dà al modello l'anchor esterno per non confabulare.

**Dove è citato**: `src/CLAUDE.md §thinking mode default`, atteso in `design/DESIGN.md §verify pillar`.

### HyperAgents — Convergenza empirica dei componenti agentici

**Citation**: Meta AI (2025). *HyperAgents: Self-Improving Agentic Systems Converge to Canonical Components*. [riferimento da verificare al caricamento].

**Cosa dice**: Mostra empiricamente che un agente LLM lasciato libero di evolversi — senza imporre architettura — converge su sei componenti riconoscibili: tool integration, memory/state, context engineering, planning, verification, modularity. Il risultato è importante perché mostra che questi sei componenti non sono un design scelto arbitrariamente dagli ingegneri, ma emergenze strutturali di cosa serve a un agente per funzionare. Non è architettura come convenzione — è architettura come vincolo funzionale.

**Perché ci interessa**: è l'evidenza empirica centrale della tesi strategica di Muffin. Se le architetture agentiche convergono spontaneamente verso gli stessi sei componenti, allora il vantaggio competitivo non può stare nell'architettura stessa (che diventa commodity come i modelli) ma nel dataset accumulato sotto quella architettura. Questo è il frame da cui nasce "il moat è la continuità di dataset profondo sotto controllo individuale" in `THESIS.md`. La convergenza empirica è anche il motivo per cui Muffin espone consapevolmente i suoi sei pilastri come categorie — non è scelta estetica, è riconoscimento della struttura inevitabile.

**Dove è citato**: `foundations/THESIS.md`, futuro `pillars/` (come frame meta sui 6 pilastri).

### Saito et al. — Verbosity Bias in Preference Labeling

**Citation**: Saito, K. et al. (2023). *Verbosity Bias in Preference Labeling by Large Language Models*. arXiv:2310.10076.

**Cosa dice**: I judges LLM (GPT-4 inclusi) preferiscono sistematicamente risposte più lunghe anche quando il contenuto della short answer è migliore. GPT-4 prefers longer answers more than humans. Conseguenza strutturale: i modelli RLHF-trained su feedback di judges LLM **ereditano il bias verbose dal training stesso** — la verbosity è wired in, non glitch.

**Perché ci interessa**: spiega perché Muffin con Gemma 4 31B IT produce reply 692 char avg vs user 96 char (7.2x ratio in privato). "Sii conciso" come riga di SOUL.md è strutturalmente insufficiente — combatte un bias appreso in fase di training. Fix dalla letteratura: rubric esplicita nel prompt ("Penalize unnecessarily verbose responses") + few-shot demo di reply ideali brevi.

**Dove è citato**: `docs/DECISIONS.md §ADR-013`, atteso in `docs/pitches/voice_tightening.md`.

### Liu et al. — Lost in the Middle

**Citation**: Liu, N. F. et al. (2023). *Lost in the Middle: How Language Models Use Long Contexts*. arXiv:2307.03172 → TACL 2024.

**Cosa dice**: Performance dei modelli su long context segue U-shape — primacy + recency bias, informazione nel middle ignorata. Empirico su multi-document QA e key-value retrieval. Follow-up "Context Length Alone Hurts LLM Performance Despite Perfect Retrieval" (Modarressi 2510.05381, 2025): anche con retrieval perfetto, la sola lunghezza del context degrada performance.

**Perché ci interessa**: Muffin oggi opera a 25K token input medi per turno (~26K con counterpoint iniettato), con cache OpenRouter sistematicamente 0. SOUL.md è in posizione recency (fine system prompt) — buono in teoria, ma `living_profile` (2700 char), `counterpoint` (3500 char), `biographical_summary` (5-10K char) sono in middle e potrebbero essere parzialmente ignorati. Rinforza il warning di Memento (Farkas 2026) "context dilution kills accuracy" con baseline empirico.

**Dove è citato**: `docs/DECISIONS.md §ADR-013`, atteso in `foundations/INVARIANTS.md §I-2`, futuro pitch `harness_reduction`.

### Liu et al. — LLMs Are Biased Towards Output Formats

**Citation**: Liu, X. et al. (2024). *LLMs Are Biased Towards Output Formats! Systematically Evaluating and Mitigating Output Format Bias of LLMs*. arXiv:2408.08656.

**Cosa dice**: 15 formati × 8 task: la varianza di performance tra formati arriva a **235×**. Le mitigation funzionano: prompt engineering specifico riduce la varianza da 235.33 a 0.71 su ChatGPT. Format restrictions degradano reasoning quando troppo strict ("Let Me Speak Freely?" Tam et al. 2024, paper collegato).

**Perché ci interessa**: spiega il 33% di reply con bullet + 24% con bold osservato nel sample di Muffin. Se SOUL.md non specifica formato preferito esplicitamente, il modello cade nel default verboso/strutturato appreso dal pre-training. Fix: prompt design specifico per format + few-shot demo.

**Dove è citato**: `docs/DECISIONS.md §ADR-013`, atteso in `docs/pitches/voice_tightening.md`.

### Sharma et al. — Towards Understanding Sycophancy in Language Models

**Citation**: Sharma, M. et al. (2023). *Towards Understanding Sycophancy in Language Models*. arXiv:2310.13548 → ICLR 2024.

**Cosa dice**: *"Sycophancy is a general behavior of RLHF models, likely driven in part by human preference judgments favoring sycophantic responses."* Investiga la prevalenza di sycophancy in modelli RLHF-trained e mostra che è amplificato dal preference signal. Pair-paper: "How RLHF Amplifies Sycophancy" (arXiv:2602.01002, 2026) con modellazione formale del meccanismo di amplificazione.

**Perché ci interessa**: 19% delle reply di Muffin in privato hanno apertura sycophantica (18 "hai ragione" + 5 in apertura + 5 "Esatto" + 16 "perfetto" + 17 "scusa" su 260 reply). È behavior trained, non istruzione mancante. Rinforza il razionale di Silicon Mirror già citato — il Generator-Critic loop è la mitigation strutturata vs il "non essere sycofantico" in SOUL.md.

**Dove è citato**: `docs/DECISIONS.md §ADR-013`, atteso in `pillars/memory/layers/01_identity.md §counterpoint extension`.

### Examining Identity Drift in LLM Conversations

**Citation**: Lee, J. et al. (2024). *Examining Identity Drift in LLM Conversations*. arXiv:2412.00804. Pair-paper: *The Assistant Axis* (arXiv:2601.10387, gennaio 2026) — synthetic multi-turn conversations show turn-by-turn drops of 20–40% in Assistant Axis projection over 10–15 turns in therapy/philosophy domains.

**Cosa dice**: Persona drift è quantificabile. "Larger models experience GREATER identity drift. Assigning a persona may NOT help to maintain identity." After 8–12 dialogue turns, persona self-consistency metrics degrade by more than 30%, even when context remains intact. Therapy/philosophy domain è dove il drift è massimo.

**Perché ci interessa**: il dominio di Muffin (introspezione, autocritica, conversazione personale con un singolo umano) è esattamente dove la letteratura misura il drift massimo. Spiega perché il template "Frase. 🥀↵↵spiegazione" emerge al 90% delle reply: è uno stable sintattico verso cui il modello converge sotto pressione di drift. Fix proposti dalla letteratura: ID-RAG (continuous retrieval di chunk di voice profile), SyncScore metric (cosine drift turn-by-turn), Persona Periodic Anchoring (re-injection adattiva).

**Dove è citato**: `docs/DECISIONS.md §ADR-013`, atteso in `docs/pitches/voice_tightening.md` come ground per SyncScore metric.

### Active Inference for Self-Organizing Multi-LLM Systems

**Citation**: Friedman, R. et al. (2024). *Active Inference for Self-Organizing Multi-LLM Systems*. arXiv:2412.10425. Pair-paper teorico: *Predictive Minds: LLMs as Atypical Active Inference Agents* (arXiv:2311.10215).

**Cosa dice**: Implementa active inference come cognitive layer SOPRA un agente LLM, modellando 3 state factor + 7 observation modalities sotto Free Energy Principle. Aggiusta dinamicamente prompt e strategie via information-seeking principle (minimizzazione del surprisal sull'osservazione attesa).

**Perché ci interessa**: frame formale per il pattern "predict-calibrate" già in `pillars/memory/LAYERS.md §Cross-cutting 5`. Mappa diretta sull'architettura Salience/DMN/TPN di Muffin: Salience = surprisal sul prediction error grezzo, DMN demons = generative model che simula contesti possibili, TPN consciousness = action policy che minimizza expected free energy. Applicazione operativa: ogni blocco iniettato nell'harness va valutato per contributo a riduzione surprisal → conditional injection gate-by-prediction invece di gate-by-rule.

**Dove è citato**: `docs/DECISIONS.md §ADR-013`, atteso in futuro pitch `harness_reduction` e in `foundations/THESIS.md` come grounding teorico per il pitch portfolio.

### ELL / StuGPA Benchmark — Empirical Longitudinal Limits

**Citation**: [Vendor TBD] (2025). *ELL: Benchmarking Longitudinal Personal-AI via StuGPA*. arXiv:2508.19005 (dicembre 2025). Pair-paper: *EvolveR — Self-Evolving Agents* (arXiv:2510.16079).

**Cosa dice**: StuGPA è benchmark per longitudinal development di agent personal-AI. GPT-5 frontier totalizza 17.90/100. "Agents still fail critically in long-term memory retention and self-motivated behavior." EvolveR critica esplicitamente: "Reflexion/Generative Agents store raw unstructured data or rely on memory mechanisms not designed for systematic long-term distillation and refinement of abstract strategic knowledge."

**Perché ci interessa**: dato empirico esterno che valida la THESIS di Muffin (memoria profonda single-user è la nicchia aperta dove la SOTA fallisce). Spiega anche perché i proattivi non-osservazionali di Muffin sono ignorati al 97.5% (40/40 source proactive, 16/16 source haiku): il "self-motivated behavior" è il fail mode dichiarato della SOTA, non bug specifico di Muffin. Operationalmente: il benchmark va clonato come **Muffin-StuGPA self-benchmark** longitudinale per misurare progress contro baseline esterno.

**Dove è citato**: `docs/DECISIONS.md §ADR-013`, atteso in `docs/pitches/voice_tightening.md` (per il sub-task Muffin-StuGPA come voce di follow-up), atteso in `foundations/THESIS.md`.

---

## Paper da valutare

### HippoRAG — Hippocampus-Inspired Associative Retrieval

**Citation**: Gutiérrez, B. et al. (2024). *HippoRAG: Neurobiologically Inspired Long-Term Memory for Large Language Models*. arXiv:2405.14831 [da verificare].

**Cosa dice**: Propone un sistema di retrieval per LLM ispirato al modello biologico dell'ippocampo come indice associativo. Costruisce un knowledge graph offline e usa Personalized PageRank per la retrieval — invece di cosine similarity semplice, propaga "attivazione" attraverso il grafo partendo dai nodi matchati dalla query. Ottiene miglioramenti su benchmark multi-hop dove serve collegare informazioni non direttamente presenti nello stesso episodio.

**Perché ci interessa potenzialmente**: il grafo di Muffin oggi è usato passivamente nel retrieval — se due nodi selezionati sono connessi, l'edge appare come link in contesto. Un uso attivo stile HippoRAG (propagazione di attivazione lungo gli edge per espandere il candidate pool) è direzione ragionevole per quando il world graph sarà popolato. Oggi non è priorità — serve prima avere il grafo entity-centric funzionante, poi si può valutare se il retrieval passivo basta o se la propagazione aggiunge valore misurabile.

**Dove è citato**: `operations/audits/MEMORY_LAYER_AUDIT` come riferimento marginale. Non è ancora base di alcuna decisione di design.

### LongMemEval — Benchmark for Long-Horizon Memory

**Citation**: Wu, D. et al. (2024). *LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory*. arXiv:2410.10813 [da verificare].

**Cosa dice**: Introduce un benchmark sistematico per valutare la memoria di chat assistants su orizzonti lunghi. 500 domande strutturate in 5 categorie di task (single-session recall, multi-session synthesis, knowledge updates, temporal reasoning, abstention) su conversazioni reali estese. Il paper mostra che sistemi commerciali con memoria "infinita" fanno errori sistematici su queste task — specialmente su knowledge updates e temporal reasoning.

**Perché ci interessa potenzialmente**: potrebbe essere il benchmark esterno su cui misurare Muffin in modo riproducibile. Oggi la valutazione di Muffin è interamente qualitativa (Giusto osserva, corregge, segnala quando qualcosa non va). Avere un benchmark esterno permetterebbe di testare modifiche al substrato contro uno standard. Ma c'è un mismatch importante: LongMemEval è pensato per chat assistants generici, non per entità che accumulano dataset personale continuo. Le categorie di task potrebbero non mappare bene sul dominio di Muffin, e adattarle richiede lavoro. Da valutare se vale lo sforzo o se la valutazione qualitativa resta più appropriata per un progetto-entità.

**Dove è citato**: non ancora citato in alcun doc di design. Menzionato nella discussione come possibile strumento di eval.

### Survey on Memory in LLM Agents (Du et al. 2025)

**Citation**: Du, Y. et al. (2025). *A Survey on Memory Mechanisms of LLM-Based Agents*. arXiv:2603.07670 [numero da verificare, il prefisso suggerisce 2026 — possibile errore di trascrizione].

**Cosa dice**: Survey sistematica sui meccanismi di memoria nei sistemi agentici LLM fino a metà 2025. Classifica i sistemi esistenti lungo assi multipli (granularità: token/chunk/note/entity; temporalità: flat/decay/bi-temporal; struttura: flat/hierarchical/graph; retrieval: dense/sparse/hybrid/graph-walk). Fornisce una mappa del campo con riferimenti organizzati per pattern.

**Perché ci interessa potenzialmente**: è utile come mappa del territorio. Quando emerge un pattern nuovo o si cerca "tutti i paper che fanno X", la survey è il punto di partenza efficiente. Non è fonte di decisioni di design dirette — è meta-reference. Rimane "da valutare" nel senso che la sua utilità è indiretta: non produce decisioni, facilita decisioni future guidando verso paper più specifici.

**Dove è citato**: non ancora citato in alcun doc di design. Riferimento di navigazione del campo.

---

## Come mantenere questo documento

Quando un nuovo paper entra nel flusso di discussione del progetto:

1. Se guida una decisione di design concreta, entra in **paper già in uso** con i quattro campi compilati.
2. Se è rilevante ma non ancora integrato, entra in **paper da valutare**.
3. Il campo "Dove è citato" si aggiorna quando un doc del progetto inizia a referenziare il paper. Non serve essere esaustivi — basta segnalare i doc principali che lo usano come base argomentativa.

La promozione da "da valutare" a "già in uso" avviene quando un elemento del paper entra in una decisione documentata (nei pillars, in operations/INTERVENTIONS, in altre foundations). Non ci sono scadenze — un paper può restare "da valutare" per mesi senza problemi. La distinzione serve al lettore per sapere cosa è stato assorbito e cosa è ancora in valutazione.
