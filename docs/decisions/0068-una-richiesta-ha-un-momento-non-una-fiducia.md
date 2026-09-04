# ADR-0068 — Una richiesta ha un momento, non una fiducia

**Contesto.** ADR-0040 chiude il decadimento della confidenza con un argomento
preciso: *"Nothing in this schema changes because a day passed."* Una credenza
resta vera finché non arriva un fatto che la contraddice, e il tempo da solo non
la corrode. L'owner ha rimesso in discussione quella chiusura da un angolo
diverso: *"dream cycle servirà sinceramente, la memoria funziona perché si
dimentica no?"* — e l'ipotesi da falsificare, non da eseguire, era che ADR-0040
avesse ragione su ciò che nega (niente decadimento) e torto su ciò che non ha
mai posto: una **richiesta** ha un momento, e passato quel momento smette di
essere pertinente senza smettere di essere vera. Chiusura e decadimento sono due
meccanismi diversi, e non averli distinti è perché la decisione sembrava chiusa.

Questa ADR misura la domanda che rende l'ipotesi decisiva o irrilevante — *una
richiesta esaudita del 16/08 finisce oggi nel contesto di un turno?* — sul
percorso di recupero vero, e implementa solo ciò che la misura regge.

---

## La misura, riprodotta e allargata

Su `~/.muffin/muffin.db` (snapshot preso con `sqlite3 .backup`, mai `cp` su un
DB con WAL attivo — misurato il 04/09/2026):

- **131 fatti, 124 vivi.** 7 ritirati, **tutti e sette** per `superseded_by` —
  nessuno per altra ragione. Conferma la lettura dell'owner: niente si ritira
  mai per il tempo.
- Sul predicato esatto che questa ADR verifica (`isRequestPredicate`, i due
  stem `asked`/`asks` e ogni composto sullo stesso stem — vedi sotto): **75 fatti
  vivi su 124, il 60,5%**. Nove predicati distinti sullo stesso stem
  (`asked_to` 37, `asks_to` 24, `asks_about` 6, `asks_for` 3, e cinque composti
  visti una volta sola ciascuno: `asks_to_greet`, `asks_question`,
  `asks_for_analysis_of`, `asks_for_advice`, `asks`).
- Confidenza media **0,903** sulla famiglia richiesta contro **0,835** sul
  resto — coerente con l'osservazione dell'owner (0,90 vs 0,83): non sono
  fatti dubbi, sono fatti certi e scaduti nella loro pertinenza.
- **7 portano `importance = 1`**, zero `importance = 2` — nessuna è mai stata
  vista come "charged" dall'estrazione.

### La domanda che decide tutto

Con un probe eseguito a mano contro lo snapshot (mai contro il DB vivo — `core/memory/store.ts`
riletto in sola lettura, `recall()` chiamato per intero, embedder
`qwen3-embedding:0.6b` reale via Ollama locale), 15 query rappresentative di un
turno "oggi" — small talk, richieste nuove sullo stesso genere di compito delle
vecchie, domande che nominano l'owner o Muffin, scelte per **non** essere
mirate a colpire le vecchie richieste:

| misura | valore |
|---|---|
| query su 15 che hanno mostrato almeno una richiesta chiusa | **9 (60%)** |
| item totali recuperati sulle 15 query | 180 |
| di cui fatti-richiesta (con molteplicità) | 17 (**9,4%** degli item) |
| fatti-richiesta **distinti** mai riemersi | **12** |

Un esempio concreto, dalla query "Puoi fare una lista dei file .md?" — non un
riferimento esplicito al passato, una richiesta *nuova* che condivide solo il
vocabolario con una vecchia:

```
- [tu, 2026-08-27] owner asked_to elenca i file .md nella cartella corrente con lo strumento shell
- [tu, 2026-08-27] owner asked_to elenca i file .md della cartella corrente usando lo strumento shell
```

Renderizzate **senza nessuna etichetta**, nello stesso formato di un fatto
corrente (`[tu, 2026-08-27] owner — lives_in — Cagliari`). Indistinguibili, sulla
riga, da qualcosa ancora in sospeso.

**Risposta: sì.** Una richiesta esaudita l'8/27 raggiunge il contesto di un
turno del 9/04 il 60% delle volte su un campione di query naturali, e occupa il
9,4% degli item recuperati. La domanda è decisiva, non irrilevante — la seconda
alternativa scartata sotto è quindi falsificata dalla misura, non per
argomento.

### Il meccanismo esatto, non solo il sintomo

`core/memory/vectors.ts` embedda ogni fatto vivo **come vettore a sé**
(`chunks.source_kind = 'fact'`, dedotto da `s.name || ' ' || f.predicate || '
' || …`, mai dall'episodio che l'ha prodotto). `recall()` lo ripesca per pura
similarità coseno, con **zero disciplina di recency**: a differenza del graph
hop (`selectForExpansion`, `EXPANSION_SLOTS = 6`, sempre capato per recency più
al massimo uno slot per importanza), un fatto imbeddato è raggiungibile da
qualunque query futura somigli abbastanza nelle parole, per sempre.

`entitiesByName` — il modo in cui il graph hop trova l'entità `owner` — filtra
su `extractCandidateNames(query)`, cioè parole **maiuscole**
(`/\b[A-ZÀ-Ú][\wÀ-ú'-]{2,}\b/g`). L'entità del soggetto delle richieste è
letteralmente `owner`, minuscola, e non compare mai capitalizzata in una
conversazione italiana naturale — misurato: su tutte e 15 le query del probe,
il graph hop è scattato **una sola volta** (per "Muffin", non per "owner"). La
protezione di recency che il grafo offre ad ogni altra entità **non protegge
mai, in pratica, l'entità owner stessa** — è il canale semantico, senza
recency, a farlo quasi da solo.

---

## Le alternative, e perché sono scartate

**A — Il difetto è a monte, nell'estrazione (`extract.ts`).** Scartata.
`extract.ts` documenta esplicitamente perché `asked_to` esiste: *"the model is
asked what the text says, never what it asks for … a fact about a request
someone made — not a standing instruction sitting in memory"* — è la difesa
strutturale anti-avvelenamento (MINJA, 98% di successo sui sistemi dove un
ricordo può leggersi come comando). Estrarre di meno o smettere di registrare
la richiesta rimuoverebbe una difesa di sicurezza per riparare un difetto che
vive due passi più a valle, nel recupero. Il 60,5% non è rumore di estrazione:
è la resa corretta di un compito conversazionale dove la maggioranza degli
scambi *sono* richieste.

**B — Non è un problema (il recupero non le pesca mai).** Falsificata dalla
misura sopra: le pesca, spesso, e occupa spazio reale nel blocco MEMORIA.

**C — La chiusura non è decidibile deterministicamente (serve un giudice).**
In parte vera, in parte un bersaglio sbagliato. *"La richiesta è stata
soddisfatta?"* richiederebbe giudizio — esattamente il tipo di verdetto che
ADR-0040 rifiuta di affidare a un modello per un `supersede` (*"nel dubbio NON
usarlo"*). Ma non è la domanda che serve rispondere. La domanda deterministica,
vera per costruzione, è più debole e basta: *"questo fatto raggiunge il turno
di adesso da un turno diverso da quello che l'ha prodotto?"* — e per un fatto
di memoria la risposta è **sempre sì**, perché il consolidamento gira sempre
dopo la fine del turno che consolida (ADR-0038, coda d'inattività). Non serve
sapere se la richiesta è stata soddisfatta per sapere che il turno che l'ha
fatta è concluso.

---

## Decisione

Due meccanismi, nessuno dei due un decadimento e nessuno una cancellazione.

### 1. Un fatto-richiesta non riceve mai un vettore a sé

`core/memory/schema.ts` guadagna `isRequestPredicate`/`REQUEST_PREDICATE_STEMS`
— due stem (`asked`, `asks`), non una lista chiusa, per la stessa ragione per
cui `canonicalPredicate` normalizza invece di enumerare: il modello conia
composti nuovi sullo stesso stem abbastanza spesso da rendere una lista
silenziosamente incompleta (cinque visti una volta sola sull'installazione
dell'owner). `vectors.ts#sqlBacklog` esclude questa famiglia dalla metà
`fact` del backlog d'indicizzazione: non entra mai nell'indice semantico
per-fatto.

**Cosa resta raggiungibile, e perché questo non è "chiudere troppo".** Il
grafo (recency-capped) e il testo dell'episodio originale restano intatti: una
query che nomina l'entità per nome, o una query in modalità storia (`--history`
/ `asOf`), continuano a vedere la richiesta. E il testo originale
dell'episodio — verbatim, con più contesto della versione compressa in fatto —
resta cercabile per FTS e per vettore **sull'episodio**, canale che questa ADR
non tocca. Misurato sullo stesso probe: la query "Cosa ti avevo chiesto sulla
poesia?" continua a restituire l'episodio originale ("prova a creare un file
con una poesia e mandamelo") dopo il fix — anzi con più fedeltà del fatto
derivato, che comprime via.

### 2. La manutenzione ritira i vettori già scritti prima di questa policy

`VectorIndex.forgetRequestFacts(tenantId)` — un `SELECT` sui fatti-richiesta
che hanno già un chunk, seguito da `forget()`, il meccanismo già esistente e
già non distruttivo (droppa solo dal piano **derivato**
`chunks`/`chunks_vec`, mai da `facts`: `schema.ts` chiama esplicitamente
questo piano *"always reconstructible, never authoritative"*). Chiamato da
`ingestPending` nello stesso punto dove il backlog viene indicizzato — stesso
costo zero, stessa forma di ADR-0040 (SQL puro, nessuna chiamata al modello,
converge a no-op non appena un tenant non ha più righe da ritirare). Senza
questo passaggio il fix varrebbe solo per le installazioni nuove: i vettori già
scritti sull'installazione dell'owner (misurati: 80 righe `chunks` per fatti
della famiglia richiesta) resterebbero pescabili per sempre, perché niente li
tocca spontaneamente.

Riprodotto sullo snapshot: cancellando manualmente i 130→50 chunk di tipo
`fact` per la famiglia richiesta, le stesse 15 query del probe passano da
**17 hit / 12 distinti** a **0 hit / 0 distinti**, senza perdere nessun item
utile — verificato riga per riga sul blocco MEMORIA renderizzato.

### 3. Un fatto-richiesta che raggiunge comunque il render viene etichettato

`recall.ts#temporalLabel` aggiunge `richiesta di un turno già concluso, non di
questo` a ogni fatto della famiglia — via il nuovo campo `RecallItem.predicate`
(mai renderizzato verbatim, solo testato contro il pattern fisso). Copre il
percorso strutturalmente ancora aperto: il graph hop, quando la query nomina
l'entità per nome, o la modalità storia. **Non dice mai che la richiesta è
stata soddisfatta** — recall non ha quel segnale, e indovinarlo sarebbe
esattamente l'errore di decadimento della confidenza che ADR-0040 rifiuta,
spostato dallo schema al render. Dice solo il fatto strutturalmente vero: il
turno che l'ha fatta non è questo.

---

## Cosa NON cambia, e perché questa non è una riscrittura di ADR-0040

- **Nessuna colonna nuova su `facts`.** Nessun `valid_to`, nessun `expired_at`
  scritto da questo meccanismo. Un fatto-richiesta resta esattamente vivo
  quanto prima.
- **Nessun decadimento di `confidence`.** ADR-0040 resta intatta: niente in
  questo schema cambia perché è passato un giorno. Il fix opera sui piani
  *derivati* (`chunks`) e sul *render*, mai sulla credenza stessa.
- **Nessun `supersede`, nessun giudizio del modello su "soddisfatta o no".**
  La domanda a cui questa ADR risponde è strutturale e deterministica ("da un
  turno diverso da quello che l'ha prodotta?", sempre vero per un fatto di
  memoria), non di merito ("è stata fatta?").

Non è quindi un ribaltamento materiale di ADR-0040 — è la fetta che ADR-0040
non copriva, distinta esplicitamente dal decadimento che quella ADR rifiuta.

---

## Cosa resta aperto, dichiaratamente

`IngestReport.forgottenRequestChunks` è sommato e stampato da `muffin memory
extract` (`cli/memory.ts`, riga «N vettori-richiesta ritirati», solo quando
`N > 0`) — ma **non** è cablato in `consolidation_runs` (nessuna migrazione di
schema per una colonna il cui valore converge a zero dopo la prima manciata di
corse), né in `muffin memory stats`/`doctor`. È una scelta di proporzionalità,
non una svista: la garanzia che conta — il contesto di un turno non contiene
più la richiesta — è provata sul percorso di recupero vero (`recall.test.ts`),
e un contatore che tende a zero non ha bisogno della stessa osservabilità
durevole di una corsia che gira per sempre. Se la misura futura mostrasse che
questo non converge sull'installazione reale, la prossima mossa è cablare la
colonna, non aggiungere un secondo meccanismo di chiusura.

## Cosa falsificherebbe questa decisione

- Una misura su recall reale che mostri il canale grafo o FTS-episodio
  risurfacciare una richiesta chiusa **altrettanto** spesso quanto il canale
  vettoriale misurato qui — vorrebbe dire che il fix ha chiuso la porta
  sbagliata.
- Un caso reale in cui l'owner chiede esplicitamente "cosa mi hai chiesto in
  passato" e il fatto derivato (non l'episodio) era l'unica prova sufficiente
  a rispondere — vorrebbe dire che il canale FTS-episodio non è un sostituto
  adeguato in ogni caso, e il grafo/episodio da soli non bastano.
- `forgottenRequestChunks` che non converge a zero su un'installazione reale
  dopo poche corse — vorrebbe dire che qualcosa ricrea la riga che il
  meccanismo dovrebbe ritirare, e la manutenzione non basta più a costo zero.
