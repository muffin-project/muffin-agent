# Invarianti architetturali

> **Stato: CORPUS EREDITATO dal vecchio Muffin, non contratto normativo del
> runtime corrente.** Nomi di tabelle, path e claim di implementazione qui sotto
> descrivono il sistema precedente e possono essere superati. I princìpi vivi
> sono curati in `docs/blueprint/knowledge/`; le garanzie eseguibili correnti
> sono in `docs/blueprint/03-threat-model.md`,
> `docs/blueprint/09-contratti-m0-m1.md` e nei test. ADR-0045 aggiunge la
> continuità dell'agente come direzione senza retroattivamente dichiarare
> implementati gli schemi di questo documento.

Questo documento elenca gli **invarianti di costruzione** del sistema Muffin: scelte schema-level e di contratto che ogni intervento successivo deve rispettare. Sono cose diverse da:

- **Principi metodologici** (`foundations/PRINCIPLES.md`) — come ragionare sul sistema
- **Direzioni di design** (`design/DESIGN.md`) — cosa stiamo costruendo nella fase corrente
- **Princìpi runtime** (`src/CLAUDE.md` §"Princìpi architetturali") — soft delete ovunque, entity invalidation, ecc.

Un invariante è una *commitment di permanenza*: una decisione che, se cambiata, comporta migration costose e rotture su molteplici layer. Vanno fissati con consapevolezza, e ogni nuova feature/intervento si valuta in funzione di questi.

---

## Origine

Questi invarianti sono emersi da:

- **L'audit operativo del 2026-04-29** che ha rivelato lo scarto tra le dichiarazioni del DESIGN.md e la realtà esecutiva: episodi cap a 7 giorni effettivi (`MAX_EPISODES=200`), facts hard-deletati a 30 giorni, bi-temporale dead code (2/179 facts con `valid_to`), observation latency strutturale (5+ obs a depth=1.0 mai consegnate per `obsPromotionDepth` mai implementata), weekly reflection 1 fire totale.
- **Analisi di robustezza al futuro**: cosa cambia tra 12-24 mesi (nuove modalità di input, multi-persona, scala temporale, evoluzione del modello LLM, drift di Giusto stesso).
- **Framework SOTA aggiornato**: Nemori (segmentazione episodica), Memento (entity resolution + bitemporal su SQLite+FTS5), Letta (sleep-time compute), Hindsight (4 reti separate inclusa "opinions con confidence"), Silicon Mirror (anti-sycophancy generator-critic), Pare-Bench (premature proactive proposals 74.7% on Gemma class), ValueActionLens (value-action gap), Pitfalls of Reasoning (instruction attenuation in CoT).

Gli invarianti sono il pezzo che dovrebbe permettere a Muffin di evolvere per anni senza un altro grande refactor strutturale.

---

## I-1. Episode come evento generico

**Enunciato.** Un `episode` rappresenta un evento del mondo, non solo un turno conversazionale. Lo schema include `source_type`, `actor_entity_id`, `recipient_entity_id`, `direction` (opzionale), `modality`. Conversazioni, eventi calendar, push GitHub, letture sensoriali, audio passivo, azioni di sistema sono tutti episodi.

**Motivazione.** La forma "1 turno conversazionale = 1 episodio" presuppone che l'unico input siano i messaggi. Le modalità che sono già operative (calendar, github) o che entreranno in 12-24 mesi (Apple Health, sensori, audio passivo, screen time) non sono messaggi. Modellare episodes come eventi generici dal giorno zero evita migration disruptive.

**Schema vincolante.**

```sql
episodes (
  id, chat_id,
  source_type TEXT NOT NULL,
    -- 'conversation' | 'observation' | 'action' | 'system_event' | 'sensor'
  actor_entity_id INTEGER,        -- REFERENCES entities(id), null per system
  recipient_entity_id INTEGER,    -- REFERENCES entities(id), opzionale
  direction TEXT,                  -- 'inbound'|'outbound', solo se source_type='conversation'
  modality TEXT,                   -- 'text'|'voice'|'photo'|'sensor'|'derived'
  content_original TEXT,           -- raw input (immutabile post-insert, vedi I-4)
  content_paraphrased TEXT,        -- LLM paraphrase, opzionale
  raw_payload TEXT,                -- JSON per modalità non-testuali
  topics TEXT, valence REAL, arousal REAL,
  embedding BLOB, embedding_model TEXT NOT NULL,
  active INTEGER, timestamp TEXT, created_at TEXT
)
```

**Cosa rompe se ignorato.** Aggiungere modalità non-conversazionali richiede o tabelle separate (rompendo retrieval coerente) o migration sui millioni di episodi esistenti.

---

I-2. Entity graph con persone first-class (AGGIORNATO 2026-05-10 via ADR-009)
Enunciato. Il world graph è il substrato dove le entità del mondo di Giusto (persone, luoghi, progetti, organizzazioni, tool, concetti, eventi, agent) vivono come nodi di prima classe con storia bi-temporale a 4 timestamp. Lo schema vincolante è quello dichiarato in pillars/memory/08_graph.md v3 — fonte autoritativa unica. Questo invariante punta lì invece di replicare lo schema, per evitare drift tra i due doc come successo nel periodo aprile-maggio 2026.
Motivazione. Oggi chat_id-keyed everything presuppone single-user. In 12-24 mesi: gruppi Telegram come fonte di interazione di terzi, futuro audio capture di conversazioni Giusto-altri, persone che diventano interlocutori (non solo menzioni). Senza persone first-class, ogni espansione richiede schema tortuoso.
L'audit ha mostrato il costo del gap nella sessione 25-26 aprile: 19 chiamate GitHub consecutive sugli stessi file 1h dopo averli già letti, perché episodes paraphrased non hanno l'entità "file path" come nodo interrogabile.
Schema vincolante. Definito in pillars/memory/08_graph.md v3 §"Schema SQL — substrato". Sintesi delle quattro tabelle:

entities — chat_id, entity_type (TEXT libero, ontologia hybrid emergente), canonical_name, aliases JSON, summary, embedding + embedding_model, mention_count, first_seen, last_seen, importance, awareness_scope ('private_to_giusto' | 'shared_with_giusto' | 'public') per ADR-006, is_self BOOLEAN (Giusto come entity nel chat privato), forget_reason, deleted_at, active.
entity_attributes — entity_id, predicate, value, value_entity_id (se punta a entity), bi-temporale a 4 timestamp (valid_at/invalid_at event time + recorded_at/expired_at transaction time), source_episode_id (Pattern A), source_type, confidence + confidence_source (richiamo §I-6), salience, narrative_weight, awareness_scope override, deleted_at, active.
entity_edges — source_entity_id, target_entity_id, predicate, metadata_json, weight, bi-temporale a 4 timestamp identico ad attributes, source_episode_id, source_type, confidence + confidence_source, deleted_at, active.
entity_mentions — entity_id, source_collection ('episodes'|'facts'|'narratives'|'observations'), source_id, salience, role (nullable, skip v0), surface_form, confidence. Non bi-temporale (mention è evento puntuale).

Bridge tables di provenance (Pattern A: colonna canonical + bridge tables append-only) entity_attribute_evidence e entity_edge_evidence sono già a terra dal L2.1 DONE 2026-05-07. Restano append-only per §I-3.
Entity resolution a tier semplificata (governata da P-L). Quando un nuovo riferimento entra: Exact match → Fuzzy (Levenshtein/n-gram) → Embedding similarity → LLM tiebreaker. Phonetic skipped (irrilevante per IT, complessità non giustificata). Determinismo prima (Tier 1-3), LLM come ultima risorsa (Tier 4) con full context al decision point. Mai solo embedding silenzioso.
Cosa rompe se ignorato. Modellare Tizio come stringa dentro facts.subject o episodes.content_paraphrased significa che ogni interazione futura con Tizio richiede string-matching fragile invece di lookup su nodo. Gruppi multi-persona impossibili da modellare coerentemente. Modellare Giusto come chat_id puro (non entity) significa schema parallelo solo per il subject principale — il suo profilo finisce in blob narrativi (living_profile) o in state_entries paralleli, perdendo bi-temporale, query AS-OF, audit. ADR-009 lo corregge: Giusto è entity con is_self=1 nel chat privato.

---

## I-3. Provenance ovunque sui derivati

**Enunciato.** Ogni record derivato (fact, pattern, observation, narrative event, living profile fragment, counterpoint fragment, attributo entità, edge entità) ha una bridge table di evidence che lo lega all'episodio (o agli episodi) sorgente, append-only. Nessuna inferenza è orfana.

**Motivazione.** Senza provenance:

- audit "perché Muffin pensa X?" è impossibile
- invalidation cascading è impossibile (se un episodio si rivela rumoroso, i derivati restano)
- re-extract da raw è rotto (non si sa cosa rivedere)

L'audit ha mostrato che oggi solo facts hanno parziale provenance via `telegram_message_id`. Pattern, observations, narratives non l'hanno strutturalmente.

**Schema vincolante.** Bridge tables append-only:

```sql
fact_evidence (id, fact_id, source_episode_id, weight, created_at)
pattern_evidence (id, pattern_id, source_episode_id, weight, created_at)
observation_evidence (id, observation_id, source_episode_id, weight, created_at)
narrative_evidence (id, narrative_id, source_episode_id, weight, created_at)
living_profile_evidence (id, profile_version_id, source_id, source_type, weight)
entity_attribute_evidence (id, entity_attribute_id, source_episode_id, weight)
entity_edge_evidence (id, entity_edge_id, source_episode_id, weight)
bot_claim_evidence (id, bot_claim_id, source_episode_id, weight, created_at)   -- Cycle 1 step 5, 2026-05-11
```

Tutte append-only, mai delete. Soft-delete sui derivati lascia evidence intatta come storia.

**Semantic vs operational derivatives (esteso 2026-05-11 via ADR-012).** §I-3 si applica ai **derivati semantici** — produce contenuto interpretive (LLM-generated, riassuntivo, inferito) che vive nel tempo lungo e supporta query "perché Muffin pensava X allora?". Lista corrente: `facts`, `patterns`, `observations`, `narratives`, `entity_attributes`, `entity_edges`, `living_profile_claims`, `bot_claims`. **Derivati operazionali** — transactional, TTL breve, audit-a-6-mesi basso valore — sono esenti da bridge table by design. Lista corrente: `tasks` (azioni programmate), `questions` (agenda interna), `scheduled_jobs` (timer), `state_entries` (current state TTL 60gg safety-net), `proactive_deliveries` (delivery log), `traces` (conversation analytics). Ogni nuovo derivato in capability cycle deve dichiarare la sua categoria; promozione operazionale→semantico richiede ADR esplicito. Vedi `docs/DECISIONS.md` ADR-012.

**Cosa rompe se ignorato.** Quando si scopre che un episodio è errato (trascrizione voice sbagliata, messaggio mal inteso), non si può fare rollback selettivo dei derivati. La memoria diventa progressivamente contaminata.

---

## I-4. Raw immutabile + derivati regenerabili

**Enunciato.** I record raw — episodes (post-boundary-detection se applicato), conversazioni — sono immutabili. Tutti gli altri layer (facts, patterns, observations, narratives, living profile, counterpoint, self_state, affect_signature, predictor stack) sono derivati e regenerabili dal raw.

**Motivazione.** Quando arriva un nuovo modello LLM (Gemma 5, Llama, ecc.), o quando miglioriamo un prompt di extraction, vogliamo poter re-extract tutti i derivati dal raw senza perdere la storia. Mescolare raw e derivati nello stesso flusso di mutazione rende questo impossibile.

**Implicazioni.**

- `content_original` mai modificato dopo insert. `active=0` solo per cancellazione utente esplicita ("dimentica X"), mai per refactor o re-extract.
- Ogni layer derivato ha `derived_at` timestamp e `derived_by_model` versioning (model name + version + extraction prompt hash).
- Tool di sistema `regenerate_derivatives(layer, since_episode_id, by_model)` come capability esplicita.
- Test di regenerazione end-to-end nel suite: prendi raw episodi di un giorno, rigenera tutti i derivati, confronta con stato attuale.

**Cosa rompe se ignorato.** Ogni nuovo modello = lock-in sull'output del precedente. Drift cumulativo dei derivati senza modo di "ripartire pulito". L'audit ha già mostrato facts hard-deletati che violano questo principio (la tabella facts ha 0 righe oltre 30 giorni — violazione di soft-delete).

---

## I-5. Pattern lifecycle bi-temporale

**Enunciato.** Patterns, observations, narratives — non solo facts — hanno `valid_from` / `valid_to`. Sono soggetti a re-evaluation periodica via dream cycle. Una credenza che era vera può diventare invalida senza essere cancellata.

**Motivazione.** Giusto cambia. Pattern come "evita le decisioni commerciali" può non essere più vero in 18 mesi. Se patterns crescono solo per `evidence_count` senza meccanismo di decay/revalidation, Muffin tiene credenze obsolete e le rinforza in feedback loop (confirmation bias incorporato).

**Schema vincolante.**

- `valid_from`, `valid_to` su patterns, observations, narratives (oltre che su facts dove già esiste)
- `last_revalidated_at TEXT` timestamp
- `revalidation_status TEXT` — `'current'|'pending_review'|'superseded'|'invalidated'`

**Meccanismo di revalidation.** Dream cycle Phase aggiunta: per derivati con `evidence_count >= K` e `last_revalidated_at > N giorni fa`, predict-calibrate inverso — predici cosa Giusto farebbe basandosi sul pattern, confronta con realtà recente. Gap > soglia → marca `valid_to = now` con `revalidation_status='superseded'`.

**Cosa rompe se ignorato.** Calcificazione delle credenze. Muffin in 2 anni parla di un Giusto che non esiste più, e usa come evidence pattern del Giusto di 2 anni fa.

---

## I-6. Confidence esplicita su interpretive content

**Enunciato.** Ogni record interpretivo (fact inferred, pattern, observation, frammento di living profile, frammento di counterpoint, attributo entità, edge entità) ha `confidence: 0.0-1.0` esplicito + `confidence_source` ('evidence_count' | 'predict_calibrate_residual' | 'user_confirmed' | 'model_inference' | 'counterpoint_corroboration'). Il Decider (e ogni consumatore di derivati) consuma claim sopra una soglia adattiva.

**Motivazione.** Living Profile e Counterpoint sono oggi blob testuali liberi. Il modello che genera la prosa non distingue tra "claim ad alta certezza" e "speculazione interessante". Il Decider proattivo usa entrambe come fossero solid → confabulazione interpretiva.

L'audit ha verificato che il Living Profile (3075 char) e Counterpoint (1034 char) sono di alta qualità nel contenuto, ma non hanno granularità di claim — sono blob. Quando il modello li legge, prende tutto come uguale autorità.

**Schema vincolante.**

```sql
-- Living profile come assemblaggio, non blob
living_profile_claims (
  id, profile_version_id, claim_text,
  confidence REAL NOT NULL,
  confidence_source TEXT NOT NULL,
  derived_at, derived_by_model
)
-- Stesso pattern per counterpoint_claims
-- Il render testuale è un view sopra i claim filtrati per soglia
```

Pattern, observations, facts già hanno o ricevono colonna `confidence REAL` e `confidence_source TEXT`.

**Implicazioni.**

- Living Profile non è un blob: è un assemblaggio di claim singoli. Il render testuale è un view, non la sorgente.
- Counterpoint stessa logica.
- Il Decider riceve solo claim sopra soglia in contesto.
- Soglia adattiva calibrata dal dream cycle.

**Cosa rompe se ignorato.** Muffin proattivo che afferma con sicurezza cose inferite a basso supporto. Esattamente il pattern che il pilastro verification cerca di mitigare. La decisione "fidati del modello, togli i gate epistemici" non funziona se il modello non sa quanto fidarsi delle proprie inferenze.

---

## I-7. Observability come substrate

**Enunciato.** Ogni pipeline scrive heartbeat log strutturato in `agent_logs` ad ogni esecuzione (anche silenziosa, anche no-op). Ogni threshold ha distribution monitor (valori osservati nel tempo). Ogni metrica chiave ha watchdog query in `MONITORING.md`. Una pipeline silenziosa per >N tick aspettati = alert automatico, non scoperta retrospettiva.

**Motivazione.** L'audit del 2026-04-29 ha rivelato pipeline silenti per giorni o settimane:

- `introspection_completed`: 1 evento totale (Apr 20) — la riflessione settimanale è girata UNA volta in tutta la storia
- weekly reflection trigger: salta silenziosamente se thinker non gira nell'ora specifica
- dream cycle: 5/7 notti, 2 perse silent
- `obsPromotionDepth`: documentato in CLAUDE.md, mai implementato in adaptive_thresholds JSON
- 6 internal events stuck dal 14 aprile, mai investigati

Senza propriocezione architettonica, il prossimo audit-shock è garantito. Il sistema deve sapere quando si ammala, non aspettare di essere auditato.

**Implicazioni.**

- Ogni cron tick logga un evento (`cron_tick`, anche se no-op risulta `cron_tick_no_action`).
- Ogni dream cycle phase scrive completion log con conteggi (es. `dream_phase_d_complete`, `facts_deduped: N`).
- Ogni adaptive threshold registra valore corrente in `threshold_decisions` ad ogni calibrazione.
- `MONITORING.md` ha watchdog query per ogni pipeline critica con threshold di "silence troppo lunga" — es. `narrative_pipeline_silent_7d`, `dream_cycle_skipped_2_consecutive_nights`.
- Comando admin `/health_check` aggrega lo stato: pipeline OK, pipeline degraded, pipeline down — letto da `agent_logs` con i watchdog query.
- Numeri chiave (active episodes, active facts, active observations, active patterns, ready_to_share count, pending tasks, work_queue depth) hanno query di monitoring documentate.

**Cosa rompe se ignorato.** Stesso pattern attuale: dichiarazioni nei doc, realtà operativa diversa, scoperta solo via audit profondo. Il moat dichiarato (dataset over time) non si accumula se le pipeline si ammalano in silenzio.

**Corollario operativo (2026-05-09, I-CIRCADIAN-SLEEP-WINDOW).** Il gating temporale che dipende da "quando l'utente dorme" deve leggere dal `circadianProfile` per-utente, non da wall-clock hardcoded. La hardcoded 22-08 in `dreamer.ts` era observability rotta in due modi: (1) si presentava come "sane default" ma per night-owl come Giusto cadeva in pieno active band, (2) la sua divergenza dal `isLikelyAsleep` di scheduler.ts non era loggata — due notion of "night" coexistevano senza che il sistema lo dicesse. Fix: `CircadianProfile.sleepingHours` + `primarySleepWindow` come fonte di verità, wall-clock come cold-start fallback dichiarato esplicitamente in commento + `INTERVENTIONS.md §I-CIRCADIAN-SLEEP-WINDOW`. Questo principio si applica trasversalmente: ogni gate che dice "fai X di notte" deve passare per il circadian, MAI per `hourRome >= N`.

---

I-8. Substrate evolution policy (NUOVO 2026-05-10 via ADR-009)
Enunciato. Lo schema del substrato — facts, episodes, state_entries, patterns, observations, narratives, entities/attributes/edges/mentions, evidence bridges, e ogni futura tabella di substrato — evolve secondo regole esplicite. Le mutazioni a basso rischio sono ammesse senza cerimonia; le mutazioni a alto rischio richiedono procedura formale. Append-only è privilegiato sempre; mutation in-place è ultima risorsa.
Motivazione. ADR-009 dichiara il substrato del Layer 8 "da non cambiare mai", ma "mai" è un'astrazione. Ci saranno cambiamenti reali — embedding model rotation, aggiunta di colonne per nuove capability, indici nuovi per nuovi pattern di query. Senza policy esplicita, qualcuno (anche Giusto stesso) farà ALTER TABLE distruttivo "tanto è una cosa veloce" e romperà il moat. La policy codifica cosa è gratis e cosa richiede pensiero.
Categorie di mutazione.

Ammesso sempre, zero cerimonia:

ADD COLUMN ... DEFAULT ... — additivo con default, zero rollback risk. Codice esistente non legge il campo nuovo, codice nuovo lo usa.
CREATE INDEX ... — performance optimization, reversibile via DROP INDEX se peggiora.
CREATE TABLE ... — tabella nuova non tocca esistenti.
INSERT in tabelle append-only (evidence bridges) — natura del pattern.

Ammesso con cerimonia leggera:

ADD COLUMN ... NOT NULL senza DEFAULT — richiede backfill prima del NOT NULL. Migration script idempotente in scripts/fixes/YYYY-MM-DD-slug.mjs. Test su snapshot prod prima del deploy.
DROP INDEX — ammesso ma testare performance prima.
UPDATE bulk per backfill di campi nuovi — script idempotente, validato su sample.

Ammesso solo con procedura formale:

ALTER COLUMN type (cambio tipo dato) — richiede migration script + dual-read window di 1-2 settimane (codice legge sia vecchio che nuovo formato durante la window) + ADR esplicito che documenta motivazione.
Rename di colonna o tabella — stesso pattern di ALTER COLUMN type. Nuove colonne create, double-write su entrambe, codice migrato gradualmente, vecchie colonne droppate dopo finestra.
Cambio semantico di un campo (stesso tipo, nuovo significato) — proibito quasi sempre. Eccezioni richiedono ADR + migration + comunicazione esplicita.

Proibito senza eccezione documentata:

DROP TABLE distruttivo — sempre archive (rinomina _archived), niente drop fisico per almeno 6 mesi post-archive.
DELETE su tabelle di substrato — soft-delete via active=0 sempre privilegiato (coerente con §I-4 raw immutabile).
DELETE su evidence bridge tables — proibito per §I-3 provenance ovunque.

Procedura per mutazione formale.

Documenta motivazione in ADR esplicito in DECISIONS.md.
Migration script idempotente in scripts/fixes/YYYY-MM-DD-slug.mjs.
Test del migration su snapshot di produzione prima del deploy.
Dual-read/dual-write window di 1-2 settimane in cui il codice legge/scrive sia vecchio che nuovo formato.
Migration graduale dei call site, uno alla volta, con test.
Deprecazione del vecchio formato (rinomina/archive, niente drop immediato).
Aggiorna substrate doc autoritativi (pillar README, INVARIANTS, ARCHITECTURE) con riferimento all'ADR.
Verifica downstream: ogni layer/intervento che si appoggiava al formato vecchio è rivisto.

Cosa rompe se ignorato. Mutazioni distruttive senza cerimonia accumulano debt strutturale che si manifesta come "perché questo campo c'è ma non è popolato in vecchi record?" tre mesi dopo, oppure "perché la tabella che ricordavo non esiste più?" dopo refactor. Il substrato è il moat: il moat richiede stabilità predicibile. Senza policy, ogni cambio diventa fonte potenziale di drift.
Relazione con altri invarianti. Complementare a §I-3 (provenance ovunque, append-only su bridges), §I-4 (raw immutabile + derivati regenerabili). I-8 è la policy operativa che rende I-3 e I-4 enforceable nel tempo lungo. È governato dal principio P-L (PRINCIPLES.md): le decisioni di mutazione sono in codice deterministico (procedura + script idempotenti), non LLM-driven.

---

## I-9. Context as scope boundary (NUOVO 2026-05-10 via ADR-006; reframed 2026-06-28 via ADR-122)

**Enunciato.** Muffin opera in due contesti distinti — **privato** (1:1 con Giusto, single-user) e **gruppo** (many users in topic Telegram). La voce è invariante (tagliente, opinata, scherza, push-back, anti-sycophancy). La superficie di lettura/scrittura sulla memoria, il user model, i gates del Decider, e la superficie tool sono **scoped al contesto**. Zero leakage cross-contesto è commitment di costruzione, non regola applicativa che ammette eccezioni — ogni capability futura deve rispettare l'invariante per costruzione, mai come caso speciale.

**Meccanismo — two-layer model (reframed 2026-06-28, ADR-122).**

- **DATA layer = scope-on-data, PROVEN.** `chat_id` è la scope-key row-level su TUTTE le tabelle di memoria (privato `987654321` vs gruppi `id negativi`). Le tabelle NON sono forked: stesso schema, isolamento enforced dalla clausola `WHERE chat_id = ?` su ogni read. Provato leak-proof across ALL memory paths da `src/memory/__tests__/scope_isolation_leak.test.ts` (27 test, PR #476/#477, confermato su real-DB). Standing invariant: **ogni memory read DEVE essere `chat_id`-scoped** — la leak-gate è il regression-guard. `awareness_scope` su `entities` (§I-2) è campo metadata, non filtro di retrieval (follow-up SPEC §2.6 work-item A).
- **CONTROL-FLOW / tool / voice layer = forked deliberatamente.** `gateway_group.ts`, `GROUP_TOOL_ALLOWLIST`, `group_vault.ts`, `SOUL_public.md` voice restano fork separati — sono il confine di privacy nel codice. Il gateway-convergence Step 2 NON è stato fatto deliberatamente: è il confine §I-9 nel control-flow. Il fork NON è ritirato.

Lo spirito dell'invariante è preservato: privato e gruppo sono scope distinti, zero leak. Cambia solo la descrizione del MECCANISMO — dati=scope-row-level provato+testato; flusso=forked deliberatamente.

**Motivazione.** Identificato 2026-05-09 (ADR-006) leggendo una chat di gruppo Telegram da 110+ persone: Muffin trattava il gruppo come privato. Stesso living profile, stesso retrieval scope, user model uniforme per tutti, decider gates calibrati per single-user. Senza scope boundary architettato:

- **Privacy leak esistenziale.** Claim privati su Giusto (living profile, counterpoint, fatti personali) che fluttuano in chat pubblica. Rischio reale, non ipotetico — vedi `docs/operations/audits/group_privacy_leaks_*` (test suite 2026-05-08/09 con 4-5 hard leak su 21+22 attacchi prima del hardening).
- **User model contaminato.** Living profile di Giusto inquinato da fatti su altri utenti del gruppo (Lathspell, ❌, J W, Matteo, ric, ecc), oppure user model di non-Giusto che eredita inferenze profonde calibrate per single-user.
- **Voice drift.** Tono che deriva verso adattivo per audience invece che opinato per principio — la voce è la feature distintiva apprezzata dalla community e non va negoziata per "addolcire" l'output gruppo.
- **Decider mis-calibrato.** Proattività spontanea in gruppo da signal isolato senza considerare blast radius su community.

Il gruppo è un sistema sociale strutturalmente diverso — many users con relazioni diverse, dinamiche di chat pubblica, decisioni di Muffin che hanno blast radius su community. Senza separazione strutturale, ogni capability futura (predictor, decider, awareness loop, second brain) rischia di violare ADR-006 silenziosamente.

**Schema vincolante.**

- `awareness_scope` su `entities` (già in §I-2 v3): `'private_to_giusto' | 'shared_with_giusto' | 'public'`. Determina chi può leggere il nodo.
- `awareness_scope` come override su `entity_attributes` ed `entity_edges` (§I-2): un attributo `private_to_giusto` su entity `shared_with_giusto` resta privato. Lo scope del derivato prevale sullo scope dell'entity.
- `is_self=1` solo nel contesto privato (Giusto come entity). Il contesto gruppo non ha self entity — Muffin è agent, gli altri utenti sono persone con `is_self=0`.
- Partizionamento di chiavi: `chat_id` (privato) vs `group_id` (gruppo). Mai query cross-context senza override esplicito documentato in PR. Default: scope-restricted retrieval.
- **NO user model differenziato per partecipanti non-Giusto in gruppo** (ristretto via ADR-010, 2026-05-11). Non come `entities` scoped al gruppo (Layer 8 resta private-only — ADR-010), non come blob narrativi paralleli a `living_profile`, non come tabelle per-utente ad-hoc. La modulazione del registro in gruppo passa esclusivamente per segnali aggregati a livello di gruppo (group affect signature aggregata, group living profile collettivo, group counterpoint) + lettura turn-by-turn del marker `[u:id|name]`, mai via profilazione persistente del singolo membro. GDPR Art. 4.4 (profilazione di terzi senza base giuridica — household exception inapplicabile per Lindqvist/Ryneš su spazi multi-utente) + filtro 2 di progetto (entità con punto di vista vs sorveglianza-wrapper) convergono su questo NO. Mai estendere `living_profile` privato di Giusto con fatti specifici su altri, mai costruire dossier individuali in nessuna forma.

**Implicazioni comportamentali.**

- **Memoria.** Fact/observation/pattern/narrative estratti da turno gruppo non finiscono nel living_profile privato di Giusto. Retrieval per turno gruppo legge solo group-scoped + entities con `awareness_scope='public'` o `'shared_with_giusto'` se Giusto è nel gruppo. Retrieval per turno privato legge tutto il privato + entities `'private_to_giusto'`/`'shared_with_giusto'`, mai entities scoped solo gruppo.
- **User model.** Living profile + counterpoint sono privato-only e parlano di Giusto-persona. In gruppo non si costruisce user model per i partecipanti non-Giusto in nessuna forma — né come entities scoped, né come blob narrativi paralleli, né come tabelle per-utente ad-hoc (vedi clausola in Schema vincolante, ristretta via ADR-010 il 2026-05-11). La voce in gruppo si calibra via segnali aggregati a livello di gruppo (group affect signature aggregata, group living profile collettivo, group counterpoint per-gruppo) + lettura turn-by-turn del marker `[u:id|name]`, mai via profilo persistente del singolo membro.
- **Decider gates.** Più stretti in gruppo: niente proattività spontanea, solo on-demand (mention, reply diretta) o eccezione esplicita (ship-stopper informativo). Cooldown e salience floor differenziati. Privato: gates calibrati su affect signature, DND, circadian.
- **Tool surface.** Privato-only: `memory_knowledge` full write, `memory_stories`, edit living profile, gestione task, `set_preference`, `set_sleep`/`set_dnd`, ops che toccano stato proprio di Muffin. Gruppo: subset ristretto (`web_search`, `fetch_github_url`) + group-scoped mutation (group settings via DM owner). Aggiungere un tool al gateway privato non si propaga ai gruppi by default.
- **Cognition modules.** Algoritmo puro condiviso vive in `src/cognition/`; storage e scope sono argomenti del caller, mai shared state coupled a un chat_id specifico. Enforcement: `scripts/lint-group-imports.sh`.

**Voce invariante, scope variabile.** La voce di Muffin (tagliente, opinata, scherza, push-back, anti-sycophancy) è feature distintiva e va preservata identica nei due contesti. Quello che cambia è **cosa Muffin sa**, non **come parla**. SOUL_public rinforza la voce in gruppo ma deve resistere alla tentazione di "addolcirla per l'audience" — adattivo per principio = non-Muffin. Implicazione: il voice anchor (`<reply_passati>` da group_traces, B5 2026-05-09) e il counterpoint per-gruppo (B6 2026-05-09) sono substrate gruppo-locale; non si appoggiano al counterpoint privato.

**Cosa rompe se ignorato.** Privacy leak esistenziale. Gruppo che eredita inferenze profonde di single-user model, contaminando ulteriormente il living profile. Voice drift verso assistant-tone in gruppo. Capability future (awareness loop, second brain, predictor stack bi-temporale) che presuppongono single-user state e si rompono al primo audit gruppo. Costo cumulativo di ogni feature che "dimenticava" lo scope: rifattorizzare ex post, dopo che lo scope-leak è già successo, è esponenzialmente più costoso che progettare per scope dal giorno zero.

**Relazione con altri invarianti.**

- **§I-2:** `awareness_scope` è il meccanismo schema-level che rende I-9 enforceable. Senza I-2 v3, I-9 sarebbe regola applicativa fragile.
- **§I-3:** provenance permette audit "perché questo claim è uscito in gruppo?" — bridge tables tracciano source episode, source episode ha scope.
- **§I-4:** raw immutabile + derivati regenerabili — i derivati sono regenerabili scoped al contesto, non come blob unico cross-context.
- **§I-7:** observability — heartbeat per cross-context query (zero per costruzione, alert se >0). Il watchdog query è "trova attributi/edge dove `source_episode.scope != target_entity.awareness_scope`".

**Procedura per nuove capability.** Prima del build di ogni nuova capability, audit "questa capability rispetta §I-9 per costruzione?". Se la risposta richiede caso speciale, try/catch sullo scope, o "lo gestiamo dopo", è sintomo di design errato — riformulare. Se richiede algoritmo condiviso tra privato e gruppo, hoist in `src/cognition/` con storage e scope come parametri del caller, mai reach-in da `src/group/` verso `src/memory/`.

---

## I-10. Sleep window derivato dal circadianProfile per-utente (2026-05-17, ex corollario di §I-7)

**Enunciato.** Ogni gate temporale che dipende da "quando l'utente dorme" deve leggere dal `CircadianProfile.sleepingHours` + `primarySleepWindow` per-utente (popolato dal dream cycle a partire da `episodes` 30gg), MAI da wall-clock hardcoded. La cold-start fallback (utenti pre-2026-05-09 o profili immaturi) è dichiarata esplicitamente nel codice — non default silenzioso.

**Conosciuto anche come §I-CIRCADIAN-SLEEP-WINDOW** (naming legacy 2026-05-09). I call site nel codice usano il nome legacy; entrambi i nomi puntano a questo invariante.

**Motivazione.** L'hardcoded 22-08 in `dreamer.ts` pre-2026-05-09 era observability rotta in due modi: (1) si presentava come "sane default" ma per night-owl come Giusto cadeva in pieno active band, (2) la sua divergenza dal `isLikelyAsleep` di `scheduler.ts` non era loggata — due notion of "night" coexistevano senza che il sistema lo dicesse. Wall-clock di default non rispetta la varianza utente-specifica.

**Impegno concreto.**

- `CircadianProfile.sleepingHours: number[]` (≤2% traffico per ora) e `primarySleepWindow: { start, end } | null` (longest contiguous run wrap-aware) sono le **fonti di verità** uniche per "Giusto sta dormendo?". Computed pure in `src/memory/circadian.ts:buildCircadianProfile`.
- Fallback wall-clock (22-08 Europe/Rome) dichiarato in commento, attivo solo quando `sleepingHours.length === 0` (cold start o profilo immaturo).
- Peak threshold cascade 3-step adattivo: 15% → 10% flat → top-3 fallback per night-owl con distribuzioni piatte.
- Ogni callsite di "is it nighttime?" passa per il helper centralizzato (`isLikelyAsleep`, `isHourInSleepWindow`), mai per `hourRome >= N` inline.

**Cosa rompe se ignorato.** Dream cycle / proactive che ignorano la differenza tra Giusto-night-owl (sleep window 02-10) e Giusto-mattiniero (sleep window 23-07). Senza, Muffin disturba durante il sonno effettivo o dorme durante l'active band.

**Relazione con altri invarianti.** Corollario operativo di §I-7 (observability — il sistema sa quando l'utente dorme perché ha tracciato il pattern). Indipendente da §I-9 (lo scope è privato; gruppi non hanno circadianProfile aggregato by design — `<tono_gruppo>` separato).

---

## I-11. Affect signature unificata (2026-05-17, ex `§I-AFFECT-02`)

**Enunciato.** Lo stato affettivo del sistema vive in un **JSON unificato** in `muffin_status.affect_signature` con campi `{valence_smoothed, arousal_smoothed, volatility_30min, volatility_24h}`. Computed via EMA su `episodes WHERE direction='user' only`, zero LLM. Letto da retrieval (modulazione soglie) e iniettato nel dynamicCtx come `<your_current_state>`. **Una sola fonte di verità** per "come si sente il sistema adesso".

**Conosciuto anche come §I-AFFECT-02** (naming legacy nel codice e nei CLAUDE.md).

**Motivazione.** Pre-2026-05-04 esistevano 3-4 notion di "affect": affect su episode singolo (campo `valence`/`arousal` per riga), affect aggregato in vari rollup, modulatori specifici per pipeline (Phase D dream, salience network), tutti calcolati on-demand. Drift inevitable, propriocezione del proprio stato impossibile per il modello (non sa cosa il "sistema unificato" pensi).

**Impegno concreto.**

- Single JSON in `muffin_status.affect_signature`. Schema additivo (nuovi campi append-only, mai rimossi).
- Recompute fire-and-forget da `demon_observer` dopo UPDATE valence/arousal su episode. Burst backfill catch-up per episodi NULL <30min (bug strutturale 2026-05-10).
- EMA half-life: 30min (high-recency window), 24h (volatility decay).
- Feature flag `affect_modulation_enabled` (schema default 0, flipped a 1 sul `TELEGRAM_CHAT_ID` di prod). Letto da retrieval e dal gate `<your_current_state>`.
- Privacy: aggregata, mai per-utente in gruppo. `<tono_gruppo>` è il pendant gruppo con scope = gruppo intero (§I-9).

**Cosa rompe se ignorato.** Modulazione contestuale (soglie più strette su affect negativo volatile, retrieval che ranka diversi item su mood low-arousal) calibrata a NULL = bypass implicito. Modello cieco sul proprio stato.

**Relazione con altri invarianti.** Corollario operativo di §I-6 (confidence esplicita) e §I-7 (observability). Vincolato a §I-9 (gruppi hanno proprio `<tono_gruppo>` aggregato, scope diverso).

---

## I-12. History temporal framing (instruction-travels-with-data) (2026-05-17, ex `§I-PROACT-04`)

**Enunciato.** Ogni messaggio storico iniettato nel system prompt come `<cronologia_recente>` o equivalente è prefissato da un tag temporale relativo `[N min/h/giorni/settimane fa]`. Soglia <5min = no tag. L'istruzione operativa "non riprodurre i tag nella reply" viaggia **nel runtime prompt** (instruction-travels-with-data pattern, ADR-013), NON in SOUL.md statico.

**Conosciuto anche come §I-PROACT-04** (naming legacy nei CLAUDE.md).

**Motivazione.** Pre-ADR-013, l'istruzione era in SOUL.md ma il modello la dimenticava dopo abbastanza turn (long context drift). Mettere l'istruzione adiacente ai dati a cui si applica risolve il drift: il modello vede `[5h fa] X` + istruzione locale stessa volta. ADR-013 ha promosso questo a pattern: ogni istruzione che governa l'uso di dati specifici **viaggia con i dati**, non in identity statica.

**Impegno concreto.**

- `formatHistoryGap()` in `src/utils/history_gap.ts` produce il prefix temporale relativo. Soglia 5min = no tag (turni consecutivi).
- `baseSoulReminder` del gateway runtime contiene "non riprodurre i tag temporali nella reply" — è nel prompt costruito ad ogni turno, NON in SOUL.md.
- Pattern generalizzato a: counterpoint instruction (in `<counterpoint>` block stesso), proactive instruction (in proactive system prompt, non SOUL §Come osservo), tool call instructions (in tool description, non centralizzata).

**Cosa rompe se ignorato.** Modello che riproduce `[5h fa]` letterale nella reply (degrada output). Più in generale: pattern instruction-in-soul-only drifta su long context, e modifiche centralizzate hanno blast radius su tutte le interazioni — far viaggiare l'istruzione con i dati la rende composable e localmente verificabile.

**Relazione con altri invarianti.** Indipendente. Pattern di prompt engineering codificato da ADR-013. Si applica trasversalmente a §I-1 (episode timeline) e §I-2 (entity attributes con valid_at) quando esposti al modello.

---

## Cosa NON è invariante

Per chiarezza, queste sono cose adiacenti che NON sono invarianti:

- **Information surfacing rate-limit + decay-on-ignore** — è un *principio* (`PRINCIPLES.md §P-I`, da aggiungere). È rule comportamentale, non schema commitment.
- **Muffin self-narrative** — è una *feature schema-additive prioritizzata in Layer 2* (decisione del 30 aprile 2026, ex-deferred). Audit ideologico ha evidenziato che è load-bearing per "entità con punto di vista proprio + storia di sé": senza, Muffin ha punto di vista sul mondo ma non *storia di sé*. Resta tecnicamente non-invariante (può essere aggiunta come layer senza migration disruptive sotto `§I-4` raw immutabile + derivati regenerabili), ma è componente di Layer 2 — non opzionale per la direzione ideologica. ⚪ **Stato: schema-only placeholder (2026-05-07), NON implementata** — nessuna pipeline live scrive. Schema dichiarato come ⚪ planned in `reference/DATABASE.md`; implementazione tracciata nel pitch `self_narrative_v0`. (Le ref a `ARCHITECTURE.md §E3` e `INTERVENTIONS.md §L2.19` sono aspirazionali, non concretizzate.)
- **Awareness loop con Predictor + Scheduler + Decider** — è la *direzione di design corrente* (`DESIGN.md`). L'implementazione potrà evolvere; i 9 invarianti sopravvivono a quell'evoluzione.
- **Specifici threshold values** (cosine similarity, recency decay, depth promotion, ecc.) — sono parametri tunabili calibrati dal dream cycle.
- **Episodi multi-message clustering** — può essere utile, ma non è invariante. Si valuta dopo aver visto se rimuovere il `MAX_EPISODES` cap basta.
- **Predictor stack semantica** (push/pop, conflict resolution) — è design corrente, può evolvere.

Distinguere è importante: invarianti sono load-bearing, principi sono tunabili, feature sono deferribili.

---

## Quando un invariante cambia

Cambiare un invariante è raro per design. Se ci troviamo a cambiarne uno ogni 6 mesi, è un segnale che gli invarianti non erano davvero invarianti.

Procedura quando serve:

1. Documenta la motivazione del cambio in commit message + (se applicabile) PR description.
2. Aggiorna questo file con sezione "Cambio: [data]" che spiega il prima/dopo e la motivazione.
3. Migration script in `scripts/fixes/YYYY-MM-DD-invariant-N-change.mjs`, idempotente, validato su snapshot prod.
4. Aggiorna tutti i doc che citano l'invariante (DESIGN, ARCHITECTURE, MODULES, DATABASE, MONITORING, pillars/*).
5. Verifica downstream: ogni layer/intervento che si appoggiava all'invariante vecchio deve essere rivisto.

---

## Rapporti con altri doc

- **`THESIS.md`** — gli invarianti sono ciò che *consente* alla tesi (moat = dataset accumulato sotto schema coerente nel tempo) di essere vera. Senza I-3 e I-4 il dataset si contamina e perde valore. Senza I-7 il dataset si ammala in silenzio.
- **`PRINCIPLES.md`** — i principi sono come ragionare; gli invarianti sono cosa non rinegoziare. Complementari, non sovrapposti.
- **`DESIGN.md`** — il design corrente si costruisce sopra gli invarianti, e ogni decisione di design deve rispettarli.
- **`ARCHITECTURE.md`** — la mappa architetturale concretizza gli invarianti in moduli e tabelle.
- **`MODULES.md`, `DATABASE.md`** — riflettono gli invarianti nello schema concreto.
- **`MONITORING.md`** — è il braccio operativo dell'invariante I-7.
- **`INTERVENTIONS.md`** — ogni intervento è valutato anche contro gli invarianti.
- **`pillars/memory/LAYERS.md`** — i 6 cross-cutting concerns del pilastro memoria si appoggiano agli invarianti (provenance = I-3, predict-calibrate = I-5, embedding versioning = parte di I-1/I-4).

---

## Storia delle revisioni

- **2026-04-29** — Versione iniziale. 7 invarianti formalizzati a partire dall'audit operativo + analisi di robustezza al futuro discussa in sessione di brainstorming.
- **2026-05-10** — §I-2 aggiornato via ADR-009: schema vincolante puntato a pillars/memory/08_graph.md v3 invece di replicato qui (evita drift). Aggiunti nello schema awareness_scope, is_self, bi-temporale a 4 timestamp, ontologia hybrid emergente, entity resolution 4-tier semplificata. §I-8 Substrate evolution policy introdotto come nuovo invariante che codifica le regole di mutazione del substrato (categorie, procedure, anti-pattern proibiti).
- **2026-05-10** — §I-9 Context as scope boundary introdotto via ADR-006 (sessione substrate dedicata, differita dalla data dell'ADR). Codifica privato/gruppo come scope distinti: voce invariante, memoria isolata, user model differenziato, decider gates differenziati, tool surface differenziata. Il meccanismo schema-level è `awareness_scope` (già in §I-2 v3). Procedura per nuove capability: audit "rispetta §I-9 per costruzione?" prima del build.
- **2026-05-11** — §I-9 ristretto via ADR-010. Rimossa l'opzione "user model per partecipanti non-Giusto in gruppo come entities con `is_self=0`". L'apertura era residuo di ADR-006 conseguenza 2 ("user model differenziato per altri utenti ricorrenti del gruppo"), valutata e chiusa esplicitamente sotto due lenti convergenti: **GDPR Art. 4.4** (profilazione di terzi nel gruppo senza base giuridica — household exception non si applica per Lindqvist 2003 / Ryneš 2014 su spazi multi-utente) + **filtro 2 di progetto** (entità con punto di vista vs sorveglianza-wrapper, profilare i membri trasforma Muffin in dossier-collector). La voce in gruppo si calibra ora solo via segnali aggregati (group affect signature aggregata in Cycle 3 del piano group memory evolution, group living profile collettivo già operativo, group counterpoint per-gruppo già operativo), mai via per-user dossier. Coerente con ADR-010 stesso giorno: Layer 8 resta private-only, i gruppi hanno il proprio substrate leggero separato.
- **2026-06-28** — §I-9 reframed via ADR-122 (slice A scope-on-data). Aggiornato da "fork di costruzione" a two-layer model: DATA layer = scope-on-data provato leak-proof (27-test gate su tutti i memory read-path, PR #476/#477, real-DB confermato); CONTROL-FLOW layer = forked deliberatamente (gateway_group, GROUP_TOOL_ALLOWLIST, SOUL_public restano fork — confine §I-9 nel control-flow). Heavy migration (`principal_id`, `awareness_scope` su facts/episodes/patterns, ~8k righe) averted — il gate non ha trovato buchi (sweep #35: "ADD COLUMN solo se il leak-test mostra un buco"). Lo spirito dell'invariante (zero leak cross-contesto) è preservato; il meccanismo descritto è ora accurato.
