# 02 — Ontologia e modello dati della memoria

> Esito del mandato d'attacco (Addendum owner №1) + design completo del Modulo Memoria. Evidenza: A4 (memoria), A2 (prior art), A1 (as-built interno). Decisioni ancorate: ADR-0004 (TKG), ADR-0005 (provenienza/taint), ADR-0006 (giudice di contraddizione).

---

## 1. Verdetto formale sull'Addendum №1

**Le triple rigide S→P→O con vincoli di coerenza sono SCARTATE.** Motivi, in ordine di forza:
1. **Evidenza interna diretta**: il vincolo singleton "un solo valore corrente" (cugino esatto di "un solo padre") ha corrotto silenziosamente 89 credenze reali — `interest` 27/28, `preference` 21/22 scaduti per artefatto dell'ordine di estrazione, scoperto solo da audit manuale settimane dopo (ADR-025). L'ontologia chiusa v2 era già stata diagnosticata "substrate-blocker" e riscritta in un mese (ADR-009). Il fallimento tipico del vincolo rigido non è l'errore visibile: è **l'esecuzione silenziosa dell'update sbagliato**.
2. **Zero prior art**: nessun sistema di memoria-agente reale con trazione implementa il pattern (A4 §4); la ricerca 2026 (AdaKGC, DIAL-KG) va nella direzione opposta.
3. **Il beneficio promesso (coerenza) non si realizza**: la risoluzione delle contraddizioni resta l'abilità più debole di *tutti* gli approcci misurati (BEAM, A4 §1.3) — il vincolo rigido non la compra, sposta solo il fallimento da "visibile" a "silenzioso".

**Adottato: Temporal Knowledge Graph property-graph, schema-light, bi-temporale, con provenienza come primitiva.** Con tre onestà imposte dall'evidenza: (a) anche il TKG fallisce sulle contraddizioni se il giudice è debole (bug aperto Graphiti #1666) → il giudice è un **organo misurato** con eval propria; (b) la struttura non è gratis → tipi e vincoli sono **opzionali e additivi** (mai bloccanti all'ingest); (c) il derivato è lossy → **l'episodio grezzo è l'unica fonte di verità**, tutto il resto è ricostruibile.

---

## 2. Modello dati (SQLite singolo, WAL; sqlite-vec + FTS5)

Tre piani: **evidenza** (immutabile) → **grafo** (bi-temporale, rivedibile) → **viste derivate** (ricostruibili). Ogni riga di ogni piano porta `tenant_id` (isolamento default-deny, §6) e provenienza.

### 2.1 Piano evidenza — `episodes` (append-only, la fonte di verità)

```sql
CREATE TABLE episodes (
  id            INTEGER PRIMARY KEY,
  tenant_id     TEXT NOT NULL,            -- 'host' | 'group:<id>' | 'community:<id>'
  connector     TEXT NOT NULL,            -- 'cli' | 'telegram' | ...
  thread_key    TEXT NOT NULL,            -- chiave sessione (tenant, connector, thread)
  actor_id      INTEGER REFERENCES identities(id),  -- CHI l'ha prodotto
  role          TEXT NOT NULL,            -- 'user' | 'agent' | 'tool' | 'system'
  kind          TEXT NOT NULL,            -- 'message' | 'tool_result' | 'document' | 'web' | 'media'
  content       TEXT,                     -- inline se piccolo
  vault_path    TEXT,                     -- file nel vault se grande/binario
  media_meta    TEXT,                     -- JSON (mime, durata, descrizione generata)
  trust_tier    INTEGER NOT NULL,         -- §5: 0=owner 1=known 2=group/unknown 3=web/tool-esterno
  created_at    TEXT NOT NULL,
  extraction_v  INTEGER DEFAULT 0         -- ultima versione di pipeline che l'ha processato
);
```

Regole: mai UPDATE sul contenuto, mai DELETE (eccezione: cancellazione GDPR per-attore, §7). Ogni messaggio di ogni canale diventa un episodio — "salviamo tutto" del BRIEF, ma con etichetta di fiducia dalla nascita.

### 2.2 Piano grafo — entità, identità, fatti

```sql
CREATE TABLE entities (
  id            INTEGER PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  kind          TEXT NOT NULL,            -- vocabolario libero canonicalizzato + seed list ('person','place','project','org','concept',…)
  name          TEXT NOT NULL,
  summary       TEXT,                     -- derivato, ricostruibile
  recorded_at   TEXT NOT NULL,
  expired_at    TEXT                      -- soft-delete bi-temporale
);
-- identità per-connector: la stessa persona vista da canali diversi
CREATE TABLE identities (
  id            INTEGER PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  connector     TEXT NOT NULL,
  external_id   TEXT NOT NULL,            -- es. telegram user id
  handle        TEXT,
  entity_id     INTEGER REFERENCES entities(id),  -- NULL finché non risolta
  link_status   TEXT NOT NULL DEFAULT 'unlinked', -- 'unlinked'|'proposed'|'confirmed'
  link_evidence INTEGER REFERENCES episodes(id),
  UNIQUE(connector, external_id)
);
CREATE TABLE facts (                       -- edge/attributi del grafo
  id            INTEGER PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  subject_id    INTEGER NOT NULL REFERENCES entities(id),
  predicate     TEXT NOT NULL,            -- vocabolario libero snake_case; audit a soglia (§4)
  object_id     INTEGER REFERENCES entities(id),   -- XOR con object_value
  object_value  TEXT,
  -- bi-temporalità completa (4 timestamp, pattern già validato in casa e identico a Graphiti):
  valid_from    TEXT,                     -- quando è diventato vero NEL MONDO (può essere NULL=ignoto; MAI inventato: lezione Graphiti date-fittizie)
  valid_to      TEXT,                     -- quando ha smesso di esserlo
  recorded_at   TEXT NOT NULL,            -- quando il sistema l'ha appreso
  expired_at    TEXT,                     -- quando il sistema l'ha ritirato (mai DELETE)
  -- provenienza e fiducia (la primitiva che il campo non ha — differenziale #2):
  episode_id    INTEGER NOT NULL REFERENCES episodes(id),  -- l'evidenza
  speaker_id    INTEGER REFERENCES identities(id),         -- chi l'ha AFFERMATO
  trust_tier    INTEGER NOT NULL,         -- ereditato dall'episodio, mai più alto
  confidence    REAL NOT NULL,
  extraction_v  INTEGER NOT NULL,
  superseded_by INTEGER REFERENCES facts(id)
);
```

Vettoriale e FTS: `episodes_fts`(FTS5 su content), `chunks` + `chunks_vec`(sqlite-vec) per vault e episodi lunghi, `entities_vec` per resolution e recall. Embedding con `embedding_v` versionato (re-index possibile senza migrazione di schema).

**Cardinalità: set-valued di default.** La lezione di ADR-025 si incorpora invertendo il default: un predicato ammette N valori correnti salvo dichiarazione esplicita di funzionalità (`functional_predicates`: lista corta e visibile — es. `date_of_birth`). Il default sbagliato dell'attuale sistema (singleton) eseguiva silenziosamente la corruzione; il default nuovo al peggio *accumula* (visibile, riparabile), mai *cancella* (invisibile).

### 2.3 Piano derivato (sempre ricostruibile, mai fonte)

- `profiles` — living profile per entità (testo derivato dai fatti attivi, rigenerato dal consolidamento);
- `digests` — riassunti di sessione/periodo con puntatori agli episodi (compattazione del BRIEF: *vista*, non sostituzione — il consolidamento è lossy per costruzione, A4 §7; il grezzo resta);
- viste community-style (sensemaking GraphRAG-like) — post-v1, batch, mai storage primario (A4 §3: è il regime giusto per il sensemaking, sbagliato come memoria conversazionale).

Invariante: `DROP` di qualunque tabella derivata + replay = stesso stato. È anche il meccanismo di migrazione (§8).

---

## 3. Pipeline di estrazione (per batch di episodi, asincrona, mai nel path di risposta)

**Regola trasversale (C1-11/12)**: ogni job della pipeline gira **un tenant per volta**, con lo stesso layer di accesso scope-on-data delle query utente. Nessuna query aggregata cross-tenant, mai — nemmeno per efficienza, nemmeno per il conteggio delle soglie.

1. **Entity resolution a due stadi** (pattern Graphiti, validato: A4 §2.1): fast-path deterministico (normalizzazione + trigram/embedding similarity con soglia alta) → fallback LLM solo sui casi ambigui; due passate (contro il grafo, poi intra-batch). **Il candidate-matching è vincolato a `tenant_id` identico in entrambi gli stadi**: un "Marco" di un gruppo non può mai diventare candidato del "Marco" del tenant host — è il fallimento invisibile per eccellenza (A4 §9), e ha un test dedicato (05 §4).
2. **Estrazione fatti**: dichiarativi con soggetto/predicato/oggetto liberi + `valid_from` SOLO se espresso semanticamente (mai default a "oggi" — errore documentato di Graphiti). Il contenuto è trattato come **dati osservati**: si estrae "l'utente X ha scritto che…", mai imperativi. Un'istruzione trovata nel testo diventa al massimo un fatto *descrittivo* su ciò che X ha chiesto (§5 — è la separazione contenuto/istruzione chiesta dal BRIEF, fatta nel modello dati).
3. **Giudice di contraddizione — organo misurato** (ADR-0006): per ogni fatto nuovo, ricerca dei candidati in conflitto (stesso soggetto+predicato, similarità sull'oggetto) → giudizio con schema **reasoning-first** (campo `reasoning` prima degli array: fix documentato del collasso di Graphiti #1666) → esiti: `coexist` (set-valued) | `supersede` (chiude `valid_to`+`expired_at` del vecchio, linka `superseded_by`) | `temporal_scope` (entrambi veri in intervalli diversi) | `review` (bassa confidenza → coda per l'owner). Ha una **eval dedicata con soglia di attivazione** (05): sotto soglia, il giudice non supersede — accumula e flagga. Mai DELETE.
4. **Embedding + indicizzazione** (locale, versionata).

Tutto è ri-eseguibile: `(episodes, extraction_v)` → si può rigiocare l'intera pipeline su una versione nuova e confrontare i grafi risultanti (è l'eval di migrazione, §8).

---

## 4. Governance del vocabolario (né rigido né anarchico)

- **Seed list** di `kind` e predicati comuni nel repo (default, non vincolo) — l'estrazione può crearne di nuovi.
- Canonicalizzazione automatica (snake_case, lowercase, singolare).
- **Audit a soglia** (pattern interno ADR-017, indipendentemente identico alla prassi Graphiti): consolidamento notturno fonde sinonimi (`lives_in`/`resides_in`); se i predicati distinti superano una soglia configurata, escalation all'owner con proposta di merge — mai enforcement upfront che blocchi l'ingest.
- Tipi **opzionali e additivi** (pattern Pydantic-overlay di Graphiti): si può dichiarare uno schema per un `kind` (campi attesi di `person`) che arricchisce, mai rifiuta.

---

## 5. Provenienza, fiducia, taint (la primitiva differenziale)

- `trust_tier` nasce alla fonte (0=owner, 1=contatti noti confermati, 2=membri gruppo/sconosciuti, 3=web/output di tool esterni) e **non può salire** attraversando la pipeline: un fatto estratto da un episodio tier-2 è tier-2 per sempre (finché una conferma owner non ne crea uno nuovo tier-0 con proprio episodio di conferma).
- Il recall porta l'etichetta nel context: ogni blocco di memoria iniettato è delimitato come dati (spotlighting) e marcato `[fonte: gruppo X, autore Y, tier 2, 2026-05-12]`.
- **Le azioni leggono il taint**: il kernel di policy (03) decide con `max_trust_tier` del contesto — un trigger proattivo o un'azione host non può nascere da evidenza tier-2/3. Questo spezza il memory-poisoning *nel modello dati*, non nel prompt: MINJA funziona perché il ricordo iniettato è indistinguibile da uno legittimo (A4 §6) — qui non lo è mai.
- Difese aggiuntive valutate e rimandate con motivo: firma HMAC per-record (SMSR) = utile contro avversario con accesso al DB, ma quel livello di minaccia coincide con "host compromesso" dove tutto è perso comunque → costo non giustificato ora (07, impalcatura possibile).

---

## 6. Multi-tenancy nel modello dati

- `tenant_id` su ogni riga di ogni piano; ogni query passa da un layer di accesso che **richiede** il tenant del turno (scope-on-data, pattern interno leak-proof con 27 test — si riporta).
- La community (post-v1) è un `tenant_id` proprio: i gruppi membri vi *pubblicano* esplicitamente (copia con provenienza, direzione gruppo→community), mai condivisione implicita per riferimento. Lo smontaggio di una community = expire del tenant community; i tenant dei gruppi restano intatti (nessuna fuga: niente era condiviso per riferimento). Il costo (duplicazione esplicita) è il prezzo dell'invariante L0-4/L0-5 — dichiarato, non nascosto.
- **Identità cross-connector** (il problema della community): `identities` per-connector restano separate di default; il link a una `entity` persona avviene solo `proposed→confirmed` — proposta automatica su evidenza forte, conferma dell'owner o dell'interessato **tramite canale out-of-band** (codice generato su un canale e inserito sull'altro: una risposta "sì sono io" sul canale nuovo non è una conferma — C1-16). **In v1 la tabella e gli stati esistono ma il flusso non si costruisce** (C2-#2): con un solo connector remoto il merge cross-connector non può accadere; le colonne sono fondamenta strutturali, il flusso arriva col secondo connector. **Mai merge silenzioso**: l'evidenza dice che il falso-positivo di merge è il fallimento peggiore perché invisibile (A4 §9, "Sakura Sushi"). Se il sistema sbaglia un link confermato: `link_status` torna `unlinked`, i fatti restano attribuiti alle identità originarie (lo permettono `speaker_id` + provenienza — niente da "smescolare").

---

## 7. Vault

- Filesystem sotto `~/.muffin/vault/` (note, documenti, import, media): **i file sono la fonte**, l'indice (chunks+vec+FTS) è derivato e ricostruibile (`muffin vault reindex`).
- Ogni file indicizzato ha una riga `episodes(kind='document', vault_path=…)` → stessa provenienza, stesso taint (un PDF scaricato dal web è tier-3), stesso recall.
- Export e cancellazione GDPR: per-attore (`actor_id`/`speaker_id` rendono la cancellazione mirata possibile: expire di episodi e fatti di quell'attore + rigenerazione dei derivati) e per-tenant (un gruppo intero). Il fatto che sia *possibile con una query* è un requisito del modello dati, non una feature futura.

---

## 8. Migrazione vs cold start — **revisione 2026-08-05**

**Verdetto rovesciato dopo aver guardato il database vero: si parte freddo, e il corpus vecchio diventa il set di eval.**

La versione precedente di questa sezione diceva "si migra, il dataset è il moat". I numeri non la reggono: il DB di produzione contiene **3.596 messaggi su tre mesi** (maggio-luglio 2026), non anni. Di questi, il **68% del testo è output dell'agente** (1.179k caratteri contro 549k dell'owner); il proattivo è marginale (170 messaggi, 4,7%). Le tabelle derivate — `observation_development_log` 4.017 righe, `agreement_signals` 951, `bot_claims` 604, `observations` 504 — sono il terzo piano di questo stesso modello: ricostruibili, mai da migrare.

**Perché cold start:**
1. **L'onboarding si collauda una volta sola, e onestamente.** Seminare la memoria significa non vedere mai ciò che vede chi installa il repo — ed è la prima cosa che incontra un estraneo, nonché quella che chi costruisce il sistema non prova mai.
2. **Si erediterebbe la forma della conversazione vecchia**, anche ri-estraendo: abitudini costruite intorno a un agente che funzionava diversamente.
3. **3.600 episodi di estrazione mai riletta** non sono controllabili. A freddo i primi cento fatti si leggono davvero.
4. **Dati di terzi**: i gruppi contengono messaggi di persone che non hanno acconsentito. Importarli va deciso apposta, non per inerzia (e vedi §7 su export e cancellazione).

**Il corpus vecchio come eval è più prezioso che come seed**: 3.600 messaggi di conversazione reale in italiano con l'owner dentro, e — differenza che conta — **l'owner conosce già le risposte**. È l'unico modo non autoreferenziale di misurare il recall: LoCoMo ha il 6,4% di ground truth errata, questo corpus no.

**Cosa resta invariato**: la pipeline di ri-ingestione si scrive comunque (serve per l'eval), il vecchio `muffin.db` resta read-only per sempre, e la migrazione resta possibile — è un job che gira, non una decisione da rifare. Se il cold start si rivelasse una perdita, si esegue.

**Cosa si copia comunque, se esiste**: artefatti curati a mano dall'owner (note del vault, skill scritte, file di persona). Quelli non sono derivabili da nessuna evidenza.

## 9. Recall

Ibrido confermato: FTS5 + vettoriale con RRF (pattern in prod) + **espansione grafo 1-hop** sulle entità dei candidati (i fatti attivi dell'entità entrano come contesto strutturato con le loro etichette) + reranking finale (il gap dichiarato dell'attuale sistema): cross-encoder locale o LLM-rerank light-tier, budget fisso, misurato in 05. Ordinamento sensibile a: pertinenza, recency, trust_tier, stato bi-temporale. **Niente classificatore "è una domanda storica"** (C2-#3): i fatti expired entrano nel recall con la loro etichetta temporale esplicita (`valido dal … al …`, `superseded da …`) e decide il modello — un classificatore in meno significa una fonte d'errore in meno, e la lezione degli intent-classifier retrocessi a monitor-only vale anche qui.
