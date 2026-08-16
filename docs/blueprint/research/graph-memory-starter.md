# graph-memory-starter — un grafo «push» letto contro la nostra memoria

```
scritto: 2026-08-16
verificato: 2026-08-16
verificato-contro: README di github.com/Glitch-Cat-Club/graph-memory-starter (1 commit, MIT) + artefatto «Applying Knowledge Graphs» (Glitch Cat Club, 16 Aug 2026), letti; codice non eseguito
modello-strumenti: Claude Fable 5 (orchestratore), WebFetch sul README; l'artefatto è stato incollato dall'owner
invaliderebbe: una misura nostra sul golden set che smentisca il vantaggio del multi-hop; o un cambio del recall (core/memory/recall.ts) che renda la traversata a un hop già sufficiente
estende: memory-salience-and-fusion.md (RRF, importance) · confronto-harness.md §memoria · hermes-documentazione.md §memoria
```

**Bottom line.** Il repo dimostra, su un caso-trappola a tre salti, che se il codice
attraversa il grafo *prima* del turno e inietta ~400 token fissi, il modello più
piccolo risponde come il più grande (Haiku: da 1/3 a 3/3), con zero tool call e
2 ms di retrieval. Muffin **è già «push»** (recall prima del modello, estrazione
deferita) e su quasi tutti gli assi è più avanti (bi-temporalità, taint, tenant,
supersede senza cancellare, entità estratte dal dialogo). Due cose valgono la
pena: **la traversata multi-hop** (noi facciamo un hop) e **il caso-trappola
come forma del golden set** che ci manca da M2. Non vale la pena: ontologia
chiusa e front-matter a mano.

## Parte I — perché ci interessa (italiano)

### La distinzione che l'artefatto mette al centro

«Pull»: il modello cerca e legge durante il turno (grep, read, grep…), il costo
cresce col corpus e l'accuratezza dipende dal modello. «Push»: il codice trova i
fatti prima che il modello sia coinvolto e glieli consegna; una sola chiamata,
costo fisso, accuratezza dalla struttura. Il repo la realizza con tre tabelle
SQLite (entità, relazioni tipizzate, alias), una `WITH RECURSIVE` per la
traversata e un hook `UserPromptSubmit` di Claude Code che inietta
`additionalContext`. «Spend intelligence at build; answer from structure.»

Per noi non è una novità di forma: `agent/loop.ts` chiama `recall` e mette il
risultato nel contesto prima della chiamata al modello; l'estrazione gira nella
coda d'inattività (ADR-0038) e la manutenzione è guidata dai dati (ADR-0040) —
è la loro «capture cheap and constant, comprehension expensive and deferred».
Quello che l'artefatto aggiunge è **evidenza esterna** che questa forma paga, e
due meccanismi concreti che non abbiamo.

### Cosa prendere

1. **Traversata multi-hop.** La nostra espansione del grafo è a **un** hop
   (`activeFacts` dall'entità seminata, taglio a 6 per `importance`; da #35 anche
   `factsAsOf` per l'istante). Il caso-trappola — «rimborso di £800 a marzo:
   chi firma?» → policy → ruolo → persona → delega — a un hop si ferma alla
   persona sbagliata. Una `WITH RECURSIVE` a profondità ≤3 sui nostri fatti
   (soggetto/predicato/oggetto sono già lì; i predicati liberi non sono un
   ostacolo per una walk) è piccola. Con due correzioni nostre: seed **anche**
   dal mezzo vettoriale (loro lo elencano come limite «lexical seeding» — noi
   ce l'abbiamo già), e ranking per **appartenenza a un cammino fra due seed**
   invece che per grado (la loro cura al «top-k crowding»; il nostro taglio per
   `importance` ha lo stesso rischio sugli hub). Tetto fisso di iniezione come
   il nostro `MAX_CONTEXT_ITEMS`.
2. **Il golden set a trappola.** Tre file che non condividono parole, decoy
   intorno (una policy stantia con numeri diversi, una nota spese con lo stesso
   £500), risposta univoca, sei run (tre modelli × con/senza). È esattamente la
   forma del golden set della suite memoria che STATE segna mancante da M2, ed è
   replicabile con dati finti nostri in un pomeriggio: la misura che manca a
   `SUPERSEDE_THRESHOLD` e a `limit=8` (memory-salience-and-fusion.md).

### Cosa non prendere, e perché

- **L'ontologia chiusa** (PERSON/ROLE/POLICY/PROCESS/DOCUMENT) e le relazioni
  fisse: è annotazione a mano, il contrario di «estrai dal dialogo, non chiedere
  di annotare». Le triple rigide ce le siamo vietate con evidenza (89 credenze
  corrotte da un vincolo in casa; ADR e AGENTS.md «What not to reopen»).
- **Il front-matter nei documenti**: «maintenance discipline» loro; per noi il
  vault indicizza testo così com'è, e le entità le tira fuori l'estrazione.
- **L'hash `uuid5(type + nome)` come identità**: unisce «Ops Manager» di due doc
  senza matching — ma unisce anche due persone omonime; noi teniamo `entities`
  con `kind` e riconciliazione (`reconcile`) proprio per non farlo alla cieca.

### Per l'orchestratore

Il loro hook è il nostro `inject-state.mjs`, ma noi iniettiamo prosa e loro
struttura. Un grafo dello stato del repo (nodi: slice, PR, righe M5-BIS,
decisioni, deleghe; archi: chiude/blocca/dipende/decisa-da) interrogato
dall'hook renderebbe navigabile ciò che oggi è un blocco di testo — è la stessa
richiesta dell'owner sull'artefatto visivo («grafi, non liste») e sarebbe la
stessa primitiva che Muffin userà per il multi-hop. Non è per il Gate 1.

## Part II — technical notes (English, STE)

| Item | graph-memory-starter | Muffin today | Gap |
|---|---|---|---|
| Storage | 3 SQLite tables: `entities(id uuid5, name, type, description, source_doc)`, `relations(source_id, target_id, predicate, source_doc)`, `aliases(entity_id, alias)` | `core/memory/store.ts`: 14 tables, three planes; facts are S-P-O with `valid_from/valid_to/recorded_at/expired_at`, `trust_tier`, `tenant_id` | none on the store; ours carries time, tier, tenant |
| Seeding | name/alias match on the prompt | `entitiesByName` + FTS5 + vector k-NN (RRF k=60) | none |
| Walk | `WITH RECURSIVE walk(entity_id, depth)` over `relations`, depth ≤ 3, undirected | one hop: `activeFacts`/`factsAsOf` from seeded entities, cut to 6 by `importance` | **multi-hop absent** |
| Ranking | top-k; proposed fix: rank by path membership between seeds | `importance DESC` inside the hop; `MAX_CONTEXT_ITEMS`, `MAX_NEIGHBOUR_ANCHORS` | path-membership ranking absent |
| Injection | `UserPromptSubmit` hook → `additionalContext`, ~400 tokens fixed | recall block in the volatile tail before the model call; capped items | none |
| Write path | LLM extraction outside the turn, at build time | idle-front lane, ADR-0038; maintenance ADR-0040 | none |
| Evidence | 3-hop trap case; Haiku 1/3 → 3/3; 660–1,180 tokens → ~400; 2 ms | no golden set yet (STATE, since M2) | **golden set absent** |
| Limits named | lexical seeding, top-k crowding, store size, meaning at scale | we have vector seeding, supersede, tenant scoping | — |

Proposed inventory rows (to add in a slice, not here): a C-row «Recall multi-hop:
una domanda a tre salti trova la risposta?» with the trap-case scenario as its
acceptance test; a memory eval «golden set a trappola» measured before and
after, on the fake provider.

## Cosa non si è potuto stabilire

- L'artefatto cita «a shipping 28k-star memory product, verified from its
  source» senza nominarlo: non verificato quale.
- Il codice non è stato eseguito: i numeri (2 ms, ~400 token) sono riportati,
  non misurati da noi.
- Quanto costi in latenza una `WITH RECURSIVE` a profondità 3 sui nostri
  volumi (migliaia di fatti): da misurare nella slice, non da stimare qui.
