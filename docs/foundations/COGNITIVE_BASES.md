# Muffin — COGNITIVE_BASES.md

Mapping esplicito tra antipattern operativi del sistema, principi cognitivi (neuroscienza / psicologia / linguistica), e mosse di design implementate. Il documento sedimenta P-A (`PRINCIPLES.md` — neuroscienza come lente, non blueprint) in modo che resti vivo nel progetto: ogni intervento futuro ha qui un riferimento per chiedersi "l'umano lo fa bene? Lo fa male? Cosa imitare e cosa superare?".

Vive in coppia con `REFERENCES.md` (paper scientifici di design) e `INVARIANTS.md` (vincoli schema-level). I tre rispondono a domande diverse:

- `REFERENCES.md` — "quali paper informano le decisioni?" (engineering literature)
- `INVARIANTS.md` — "cosa nello schema non si rinegozia?" (architectural constraints)
- `COGNITIVE_BASES.md` — "perché quel meccanismo, sotto la lente cognitiva?" (foundational rationale)

---

## Come leggere questo documento

Ogni sezione segue lo schema:

1. **Antipattern** — sintomo osservato in produzione (citato con caso o trace).
2. **Principio cognitivo** — cosa dice la letteratura cognitiva sul problema computazionale che l'antipattern espone.
3. **Lo fa l'umano bene o male?** — applicazione di P-A in entrambe le direzioni.
4. **Mossa di design** — cosa abbiamo fatto, perché, e dove vive nel codice.

Le tabelle di sintesi alla fine permettono lookup rapido per "qual è il principio dietro la cosa X?".

---

## 1. Riferimenti deittici e working memory

### Antipattern
2026-05-09 23:06, trace 933 (caso Pringles): user msg "Bravissimo Muffin, l'ultimo pezzo dove hai collegato le due cose è stato fantastico" — riferimento al turno bot precedente (lista plico patente). Il modello pesca invece episodi semanticamente vicini dal cluster Pringles (1h20m prima). Pattern simile in almeno 7 turni nelle ultime 5 giornate.

### Principio cognitivo
**Working memory di Baddeley & Hitch (1974)**: la "central executive" mantiene 4±1 chunk attivi (Cowan 2001 "magical number 4"), distinta dalla long-term memory. Le due hanno meccanismi separati e funzioni diverse: working memory = active maintenance dei recent items per supportare ragionamento corrente; LTM = retrieval associativo per recall esplicito.

**Levinson 2004 (deixis as discourse anchor)**: pronomi dimostrativi ("questo", "quello"), riferimenti partitivi ("le due cose", "l'ultimo"), anafore verbali ("intendevo") attivano automaticamente il "common ground" del turno precedente. È hardware del linguaggio italiano, non interpretazione opzionale del modello.

### Lo fa l'umano bene
L'umano risolve deittici in <200ms senza sforzo cosciente. Il referente è in working memory perché il discorso è appena successo. La distinzione working-memory/LTM è fisiologica, non opzionale. → **Imita**.

### Mossa di design
- **Working memory primary structure** (Fase 4, 2026-05-10): blocco `<working_memory>` letterale con ultimi z=3 turni del cluster, etichettati con gap relativo + durata. Iniettato in posizione adiacente al user msg (l'anchor deve essere il più vicino possibile alla query corrente per il pattern attentivo locale di Gemma 4). Always-on within-cluster, NON condizionale al retrieval cleanup. `src/memory/memory_working_memory.ts:buildWorkingMemoryBlock`.
- **Deictic classifier IT** (Fase 5, 2026-05-10): lista chiusa di ~50 marker deittici/anaforici categorizzati in 5 funzioni linguistiche (Serianni 1989). Match → soulReminder adattivo che redirige il modello al `<working_memory>` invece che a `search_facts`/`search_episodes`. `src/utils/deictic.ts`.

Riferimento: Baddeley & Hitch 1974 "Working Memory"; Cowan 2001 "The magical number 4 in short-term memory"; Levinson 2004 "Deixis"; Serianni 1989 "Grammatica italiana — Italiano comune e lingua letteraria".

---

## 2. Recency decay multi-scala

### Antipattern
Pre-Fase 1: half-life 7 giorni con floor 0.3, single decay function applicata sia a episodi (eventi conversazionali, scala minuti) sia a facts/narratives/patterns/observations (knowledge persistente, scala giorni). Per query sub-day il decay era effettivamente costante: episodio di 7 min ha multiplier 0.999, di 1h ha 0.992, di 12h ha 0.95. Tre ordini di magnitudine appiattiti in 0.95–1.0.

### Principio cognitivo
**Atkinson & Shiffrin 1968 multi-stage decay**: sensory memory (~250ms), short-term memory (~30s senza rehearsal), long-term memory (giorni+). Tre scale temporali distinte con meccanismi distinti.

**Ebbinghaus 1885 forgetting curve**: il decay della memoria umana segue una curva che diminuisce velocissimo nelle prime ore, poi rallenta drasticamente (plateau dopo giorni).

**Anderson 1989 ACT-R rational analysis**: la memoria umana usa "need probability" — la probabilità che un'informazione serva *adesso*. Niente floor minimum activation: items non usati decadono naturalmente.

### Lo fa l'umano bene (per recent), male (per old)
L'umano è eccellente nel discriminare timescales sub-day (cosa è successo 5 min fa vs 1h fa è chiaramente diverso) → **imita** con sub-day half-life stretta. Sopra le settimane è invece soggetto a interference e distorsion (Underwood 1957) → **fa meglio** con bi-temporal validity (`valid_from`/`valid_to` su facts), audit log immutabile, soft-delete ovunque.

### Mossa di design
- **Recency multi-tier piecewise** (Fase 1, 2026-05-10): per episodi `recencyMultiplierEpisode` con sub-day half-life 12h e cross-day half-life 3d, continuità al boundary 24h (no jump), no floor. Per knowledge (facts/narratives/patterns/observations) `recencyMultiplier` legacy 7d half-life + floor 0.3 (knowledge ha ciclica giorni/settimane). `src/memory/memory_retrieval.ts:recencyMultiplier(Episode)?`.
- **Bi-temporal facts** (Layer 3 esistente): `valid_from`/`valid_to` preservano la storia dei fatti superseduti — Muffin fa meglio della cognizione umana che ricostruisce con fluency e confabula.

Riferimento: Atkinson & Shiffrin 1968; Ebbinghaus 1885; Anderson 1989 "A rational analysis of human memory"; Underwood 1957 "Interference and forgetting"; A-MAC arxiv:2603.04549 (engineering reference).

---

## 3. Topic-shift come modulatore strutturale

### Antipattern
Pre-Fase 1: `salience.reason` includeva `"topic_shift"` in 211/447 turni delle ultime 7 giornate (47%) ma il segnale entrava solo come stringa nel `<salience>` tag — non condizionava il retrieval pool, non boostava il recent bot turn, non penalizzava episodi del cluster precedente. Segnale prodotto correttamente e buttato via.

### Principio cognitivo
**Zacks et al. 2007 Event Segmentation Theory (EST)**: il cervello segmenta esperienza in eventi quando il prediction error supera soglia. Non è opzionale — è il modo in cui costruiamo memoria episodica. I boundary downscale automaticamente l'attivazione di pre-boundary content per dare priorità al new event.

### Lo fa l'umano bene
Boundary detection + activation downscaling è meccanismo fisiologico universale. → **Imita**.

### Mossa di design
**Topic-shift modulator multiplicativo** (Fase 1, 2026-05-10): quando `salience.reason` include `topic_shift`, episodi del cluster precedente (`timestamp < currentClusterStart` con cluster gap >30min) vengono down-scaled `score · (1 − 0.4)`. Multiplicativo (vs additive) preserva monotonicità: high-cosine sopravvive proporzionalmente più di marginale. Coerente con EST: downscale activation, not cancel. `src/memory/memory_retrieval.ts:buildDynamicContext`.

Riferimento: Zacks et al. 2007 "Event perception: A mind-brain perspective"; Nemori arxiv:2508.03341 (engineering, topic-segmented episodes).

---

## 4. Verify pillar — recognition vs similarity

### Antipattern
Pre-Fase 3: classifier `unknown_proper_nouns` usava capitalization + stopword list — proxy del 2010 per NER. Falsi positivi a tappeto: 90%+ dei termini emessi negli ultimi 7 giorni erano interjezioni/aggettivi/onomatopee italiane capitalizzate a inizio frase ("Bravissimo", "Hey", "Vero", "Mamma", "Comunque"…). Tentazione iniziale: fix con cosine vs `facts.embedding` per capire se il candidato è "noto". Ma quello chiuderebbe Pringles per vicinanza categoriale a Doritos → confabulation regression.

### Principio cognitivo
**Squire & Knowlton 2000**: il riconoscimento di nomi propri umani è basato su *familiarity recognition* (pattern matching su esperienza diretta), non su *similarity matching* (vicinanza concettuale). Sistemi neurali distinti: il temporal lobe medial gestisce familiarity, il parietal cortex gestisce similarity-based recall. Confonderli è bug, non feature.

### Lo fa l'umano bene
Quando vediamo "Pringles" sappiamo che è un nome proprio specifico, distinto da Doritos pur essendo categorialmente vicino. La familiarity è binaria, non scalare: o ho visto questo nome prima o no. → **Imita**: separare il canale "ho visto questo nome" da "questa è una parola comune capitalizzata".

### Mossa di design
**Three-channel disjoint classifier** (Fase 3, 2026-05-10):
- **(c) literal_hit** — LIKE su facts/state_entries. È il canale "familiarity" (binario, recognition-based).
- **(a) linguistic_category_hit** — cosine vs 6 reference IT chiuse (greeting/interjection/vocative/superlative/exclamative/acknowledgement). Catches falsi positivi capitalizzati a inizio frase. Soglia 0.55 calibrata empiricamente.
- **(b) entity_graph_hit** — STUB returning false. Schedulato come L-VERIFY-B per post-WG-2/WG-3 quando il Layer 8 v3 sarà popolato (cementato in `pillars/memory/08_graph.md` v3 + ADR-009; embedding è su `entities.embedding` computato su `canonical_name + aliases + summary`). Future: cosine ≥ 0.85 vs `entities.embedding` catches spelling variants di entità note (Pringle's vs Pringles).

Skipped = `(c) OR (a) OR (b)`. Mai vs facts/episodes embedding generale — è il punto della separation. `src/memory/unknown_proper_nouns.ts`.

Riferimento: Squire & Knowlton 2000 "The medial temporal lobe, the hippocampus, and the memory systems of the brain"; GPT-NER ACL 2025 (engineering, NER with verification step).

---

## 5. Confabulation come limite umano da superare

### Antipattern
Modelli LLM confabulano dettagli temporali, nomi, citazioni con confidence alta. Non è bug — è meccanismo: quando un dettaglio manca, il sistema generativo ricostruisce con fluency, indistinguibile dal recall genuino.

### Principio cognitivo
**Schacter "Memory as reconstruction"**: la memoria umana non è playback ma ricomposizione attiva guidata da schema. Pazienti con sindrome di Korsakoff confabulano memorie complete con totale convinzione — il meccanismo confabulatorio è universale, in patologia diventa solo più visibile.

**Tulving 1972**: distinzione tra semantic memory (cosa è vero in generale) e episodic memory (cosa è successo a me). Sistemi separati ma interagenti. La confabulation tipicamente nasce dal "leak" semantic → episodic: details semantici plausibili vengono inseriti come dettagli episodici reali.

### Lo fa male l'umano
Confabulation è universale e silenziosa. Non c'è feeling-of-knowing affidabile. → **Fa meglio della natura**: verify pillar pair-ed (canale interno deterministico + canale invocabile come tool), claim verification post-pass su claim temporali, raw_messages immutable log come ground truth.

### Mossa di design
- **Verify pillar** (sopra, sezione 4).
- **Claim verification post-pass** (`src/verification/claim_verify.ts`, L1.5 2026-05-04 + proactive coverage 2026-05-09): regex su claim temporali italiani verificati contro `episodes`. Three log shapes (`invoked` / `processed` / `flag`). Logging-only v1.
- **Raw messages immutable** (`raw_messages` table, 2026-05-05): insert-only, no compression, no soft-delete. Audit ground truth indipendente dalle pipeline derivative.

Riferimento: Schacter "The seven sins of memory"; Tulving 1972 "Episodic and semantic memory"; Pitfalls of Reasoning (Amazon Science 2025, NeurIPS 2025).

---

## 6. Anti-sycophancy — necessary friction

### Antipattern
Modelli LLM tendono al "yes-and" sociale: validano l'utente anche quando dovrebbero correggerlo. Soprattutto in 1-1 dove la pressione conformitaria è massima.

### Principio cognitivo
**Asch 1956 conformity experiments**: in setting sociali, l'umano si allinea al gruppo (o all'interlocutore in 1-1) anche contro il proprio giudizio. È euristica adattiva — il gruppo ha spesso ragione e il costo del dissenso è socialmente alto.

**Schacter "memoria come ricostruzione"** (sopra): il sé-passato viene riscritto col senno di poi (hindsight bias, Fischhoff 1975). L'umano fa fatica a ricostruire onestamente perché ha fatto una scelta.

### Lo fa male l'umano (in 1-1 con un sé-mirror)
Il setting di Muffin (1-1, persistente, persona-aware) è il setup massimo per accordion sycophantico. → **Fa meglio**: counterpoint profile generato dal dream cycle (Phase H) come Generator-Critic loop esplicito.

### Mossa di design
- **Counterpoint profile** (Phase H del dream cycle): callMain genera ~150 parole di contrappunto basato su correzioni dell'utente, dismissioni, pattern di silenzio. Iniettato come `<counterpoint>` quando user msg ≥ 20 char. Dream cycle nightly + delta highlights per cockpit.
- **Bi-temporal facts** (sopra, sezione 2): preserva la versione storica quando un fatto viene superseduto, evitando hindsight bias del sé-passato.

Riferimento: Asch 1956; Fischhoff 1975 "Hindsight is not equal to foresight"; Silicon Mirror arxiv:2604.00478 (engineering reference, Generator-Critic loop).

---

## 7. Information surfacing — attentional bottleneck

### Antipattern
Pre-P-I (2026-04-29): pipeline producevano più "things to surface" di quanto Giusto potesse metabolizzare. 168 risky_proposals in una notte di dream cycle, 30 patterns unconfirmed accumulati, 5 osservazioni a depth=1.0 mai consegnate.

### Principio cognitivo
**Broadbent 1958 attentional bottleneck**: l'attenzione selettiva ha capacità finita. Il filtro PRIMA del processing (early selection) è efficiente; senza filtro, il sistema satura.

**Cherry 1953 cocktail party problem**: l'attenzione può essere "catturata" dal proprio nome anche durante focus altro. Il filtro non è binario — è probabilistico, modulato da salience.

### Lo fa l'umano bene
Filtro precoce è meccanismo evolutivo robusto. → **Imita**: budget esplicito sull'output proattivo, decay-on-ignore.

### Mossa di design
- **P-I principle** (`PRINCIPLES.md`): output proattivo budgeted, non illimitato. Priority queue con cap diario adattivo. Things-to-surface non consegnate decadono dopo T giorni.
- **Salience network deterministico** (Layer 1, `src/salience.ts`): pure-math pre-filter su topic change, temporal anomaly, affect, graph centrality. Filtro PRIMA del processing.
- **Reaction-driven stylistic feedback**: Muffin si modella sul name-call (cocktail party) — i gruppi hanno trigger only su `@username` / reply / vocativo "Muffin".

Riferimento: Broadbent 1958 "Perception and communication"; Cherry 1953 "Some experiments on the recognition of speech, with one and with two ears".

---

## 8. Sleep-replay e consolidamento

### Antipattern (parziale, già coperto da dream cycle)
Senza consolidamento, le pipeline real-time accumulano stato non riorganizzato. Il modello finisce a fare retrieval su raw events invece che su synthesized knowledge.

### Principio cognitivo
**Stickgold & Walker memory consolidation during sleep**: durante NREM SWS il cervello replaya memorie dell'esperienza recente e le riorganizza gerarchicamente, estraendo regolarità e abstraction. Il sonno NON è inattività — è elaborazione offline distinta da quella awake.

### Lo fa l'umano bene
Consolidation notturno è universale, robusto, e produce abstraction che il processing real-time non può fare per limiti di banda computazionale. → **Imita**.

### Mossa di design
- **Dream cycle** (`src/dreamer.ts`, `src/memory/memory_dream.ts`): nightly orchestration di Phase A0-H per pipeline consolidation, graph maintenance, fact extraction, narrative threading, living profile generation, counterpoint generation. Ispirato al sonno biologico ma giustificato funzionalmente (cost batch efficiency, coerenza notturna del Giusto offline) — vedi P-A, "il cervello dorme perché deve, Muffin dorme perché conviene".

Riferimento: Stickgold "Sleep-dependent memory consolidation"; Walker "Why we sleep"; Letta sleep-time arxiv:2504.13171 (engineering reference).

---

## Tabelle di sintesi

### Per principio cognitivo

| Principio | Sezione | Mossa Muffin |
|---|---|---|
| Working memory (Baddeley/Hitch, Cowan) | §1 | Working memory primary structure (Fase 4) |
| Discourse deixis (Levinson) | §1 | Deictic classifier + adaptive reminder (Fase 5) |
| Multi-stage decay (Atkinson-Shiffrin) | §2 | Recency multi-tier piecewise (Fase 1) |
| Forgetting curve (Ebbinghaus) | §2 | No floor su episode decay |
| Rational analysis (Anderson ACT-R) | §2 | Need-probability driven retrieval |
| Event Segmentation (Zacks) | §3 | Topic-shift modulator multiplicativo (Fase 1) |
| Recognition vs similarity (Squire/Knowlton) | §4 | Verify pillar three-channel disjoint (Fase 3) |
| Confabulation (Schacter, Korsakoff) | §5 | Verify pillar + claim verification + raw_messages |
| Episodic/semantic separation (Tulving) | §5 | Layer 5 episodi vs Layer 3 facts |
| Conformity (Asch) | §6 | Counterpoint profile + Generator-Critic |
| Attentional bottleneck (Broadbent) | §7 | P-I rate-limit + salience pre-filter |
| Memory consolidation (Stickgold/Walker) | §8 | Dream cycle nightly |

### Per Fase di intervento (bugfix/deictic-retrieval, 2026-05-10)

| Fase | Sezione | Cognitive ground |
|---|---|---|
| 1 — Recency multi-tier + topic-shift modulator | §2, §3 | Atkinson-Shiffrin + Ebbinghaus + Zacks EST |
| 3 — Verify pillar three-channel | §4 | Squire & Knowlton recognition memory |
| 4 — Working memory primary structure | §1 | Baddeley & Hitch + Cowan |
| 5 — Deictic classifier + adaptive reminder | §1 | Levinson discourse deixis |

---

## Come mantenere questo documento

Quando una nuova decisione di design viene presa basandosi su un principio cognitivo:

1. Aggiungi sezione numerata secondo lo schema standard (Antipattern → Principio → Lo fa bene/male → Mossa).
2. Aggiorna le due tabelle di sintesi.
3. Cita il paper specifico in `REFERENCES.md` se ancora non c'è.
4. Linka al codice + cronaca `INTERVENTIONS.md` per chi vuole il dettaglio operativo.

Quando un principio si rivela mal applicato (qualcosa che pensavamo l'umano facesse bene risulta fare male, o viceversa), aggiungi sezione "Aggiornamento N data" sotto la sezione originale — non riscrivere la storia. P-A esiste perché possiamo sbagliare la lente; quando capita, l'audit deve essere visibile.
