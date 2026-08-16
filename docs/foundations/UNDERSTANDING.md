# Muffin — UNDERSTANDING.md

> **Stato: CORPUS EREDITATO.** Le dimensioni cognitive restano una lente; la
> formula a somma pesata e i riferimenti al vecchio schema non sono il disegno
> corrente. La curatela viva è `docs/blueprint/knowledge/01-understanding.md`.
> In particolare, “come sta ora?” non è uno store generico di world state:
> ADR-0045 separa evidenza, credenze, stato del mondo e stato del lavoro.

Questo documento contiene il principio **epistemologico** alla base di Muffin — cosa significa "capire" oltre che "ricordare", e come tradurlo in formule concrete di peso e selezione. Esiste accanto a `THESIS.md` (principi strategici: in che gioco giochiamo, come è il moat), `PRINCIPLES.md` (principi metodologici di design: come ragionare sul sistema) e `VISION.md` (nord-stella di prodotto). I quattro doc si leggono insieme come fondamenta.

---

## Il principio in una riga

Un sistema che accumula dati senza pesarli per intensità, direzione, contesto e silenzio ricorda bene ma non capisce. Capire è riconoscere quali fatti sono vivi, in che stato, e verso dove stanno andando — non solo sapere quali fatti esistono.

---

## Definizione operativa: ricordare vs capire

Un sistema di memoria può operare a due livelli.

**Ricordare** è stateless lookup a chiave. "Simpleclaim è live da marzo" è un record; se richiesto, viene restituito. La domanda che il sistema risponde è "esiste questo fatto?" o "cosa sai di X?". Questo è necessario e Muffin lo fa bene: bi-temporal sui facts, hybrid retrieval, entity invalidation per gli stati.

**Capire** è inferenza di secondo ordine sul materiale accumulato. "Simpleclaim è in regime tranquillo nelle ultime 3 settimane dopo una fase di crisi a febbraio, attualmente stabile ma con arousal residuo medio". Nessuno dei componenti è un fatto discreto — sono pattern emergenti dalla distribuzione temporale di affect, menzioni, silenzi, correzioni. La domanda che il sistema risponde è "come sta, ora?". Questa è la direzione che oggi Muffin affronta solo parzialmente.

La differenza operativa è netta. Ricordare è un lookup; capire è una sintesi. Un sistema che solo ricorda risponde corretto ma piatto ("Simpleclaim è live"); uno che capisce coglie cosa sta sotto ("Simpleclaim sta bene adesso, ma sei preoccupato perché il ricordo della crisi di febbraio è ancora presente"). La vision di Muffin — "uno specchio con carattere" ispirato a The Machine — richiede capire, non solo ricordare.

Questo principio è l'elaborazione operativa del punto strategico già dichiarato in `THESIS.md` ("assistere vuol dire capire"): il principio nomina le dimensioni che servono a trasformare quell'intenzione in formula.

---

## Le dimensioni che contare non cattura

Contare e pesare per recency sono le due dimensioni più semplici. Coprono una parte del segnale ma ne lasciano fuori almeno sei. Ognuna di queste è visibile nel comportamento umano e va modellata esplicitamente perché non emerge da sola dai contatori.

### 1. Affect signature (media, volatilità, picchi)

Un'entità o un tema ha una firma emotiva aggregata dalle sue menzioni. Non solo la media — la distribuzione. Un progetto con valence media +0.1 costante è profondamente diverso da un progetto con valence media +0.1 ma volatility 0.6 e due picchi negativi a -0.8. Le formule di aggregazione "average" nascondono informazione; serve mantenere almeno tre momenti:

- `affect_mean`: media pesata per recency della valence osservata nelle menzioni.
- `affect_volatility`: deviazione standard — misura quanto l'entità oscilla emotivamente. Alta volatility = entità "calda", sensibile al contesto.
- `affect_peaks`: top N menzioni con |valence| estrema, con puntamento all'episodio sorgente. Preserva gli eventi emotivi ancora leggibili anche quando la media si è ri-neutralizzata col tempo.

Arousal ha trattamento analogo. L'intensità cronica è un segnale diverso dall'intensità occasionale intensa.

### 2. Intensity vs frequency

Frequency è contare. Intensity è misurare quanto ogni istanza pesa. Un'entità menzionata 3 volte con arousal 0.9 può essere più importante di una menzionata 30 volte con arousal medio 0.2. Il prodotto `count × average_intensity` non cattura la differenza — va mantenuta la distinzione.

La regola pragmatica: quando una formula oggi pesa "count × recency", si chieda se la domanda che sta rispondendo è "quanto è vicino allo stato attuale" (frequency-recency basta) o "quanto è presente nella mente" (intensity domina). Nella seconda, una singola menzione ad alto arousal può dominare cento menzioni fredde.

### 3. Trend temporale (derivata, non livello)

Un'entità con mention_count 15 in regime stabile è qualitativamente diversa da un'entità con mention_count 15 in crescita, che è diversa da una in declino. Il livello da solo perde l'informazione più importante: la direzione.

Il trend è una derivata: `mention_count(finestra_recente) vs mention_count(finestra_precedente)`. Può essere classificato in quattro stati:

- `rising`: menzioni in crescita significativa (es. +50% window-over-window).
- `stable`: variazione contenuta.
- `declining`: in calo significativo, ma ancora attiva.
- `dormant`: sotto soglia di attività recente, non necessariamente morta.

Questo campo è derivato, non estratto. Si ricalcola nel dream cycle. È input fondamentale per il retrieval ("Simpleclaim in crescita rapida" dovrebbe emergere nel contesto più facilmente di "Simpleclaim stabile da mesi").

### 4. Context specificity (coerenza col momento)

La stessa entità pesa diversamente in contesti diversi. Simpleclaim in conversazione di lavoro è centrale; Simpleclaim in conversazione su vacanze è marginale. Questo non è una proprietà dell'entità — è una proprietà **della coppia (entità, context corrente)**.

Il modello: ogni entità accumula una distribuzione di contesti in cui appare (topics degli episodi che la menzionano). Al query time, l'entità viene pesata anche per overlap tra i suoi contesti tipici e il context dell'episodio corrente. Un'entità che appare sempre in certi topics e ora quei topics sono assenti → peso ridotto. Un'entità che appare raramente ma quando appare è in topics molto specifici, e quei topics sono attivi ora → peso amplificato.

Questa dimensione risolve un problema che il retrieval solo-semantico ha: pesa le entità per similarità generica, non per coerenza con lo stato della conversazione corrente.

### 5. Silenzio come segnale positivo

Ciò che qualcuno **smette** di dire è spesso più informativo di ciò che dice. Un progetto centrale che scompare dalle conversazioni è un evento narrativo — può essere concluso, abbandonato, evitato per tensione, rimosso per ansia. Il sistema non può dirlo, ma può e deve *notarlo*.

Il silenzio va generalizzato a principio trasversale, non solo pattern locale:

- Ogni entità, attributo, edge ha un `silent_since` (timestamp di inizio del silenzio significativo) oltre a `last_seen`.
- Il silenzio significativo è rilevato non sul valore assoluto di last_seen, ma sul **delta rispetto al pattern storico**. Un'entità menzionata una volta al mese che passa a zero menzioni per due mesi → silenzio non significativo, è nel rumore. Un'entità menzionata tre volte a settimana che passa a zero per due settimane → silenzio significativo.
- Il sistema emette **observations** per silenzi significativi, non solo campi di stato. L'osservazione emessa è la capability del modello: "Tizio non è stato menzionato in 3 settimane, pattern storico era 2 mention/settimana — vale la pena chiedergli come va?". Questo è capire, non ricordare.

### 6. Significance irreducible

Ci sono fatti la cui importanza non è derivabile da count, recency, o affect. "Mio padre è morto" è importante a prescindere. "Ho lasciato l'università" è strutturale. Questi richiedono un meta-tag di significance assegnato al write-path con peso indipendente dalle altre dimensioni.

Il principio: significance high deve funzionare come **soglia di protezione**, non come modifier moltiplicativo. Un fatto con importance=high non decade, non viene overlooked dal retrieval anche se semanticamente non matcha la query corrente, non viene pruned. La significance alta deve garantire persistence, non solo extra peso.

---

## Il pattern di applicazione: da `f(count, recency)` a formula multi-dimensionale

La forma base che ricorre nelle formule count-only è:

```
score = weight_a * count_normalized + weight_b * recency_decay
```

La forma arricchita che incarna il principio:

```
score = 
    w1 * semantic_relevance        (cosine query vs item embedding)
  + w2 * recency_decay             (half-life temporale)
  + w3 * affect_resonance          (match tra affect corrente e affect signature)
  + w4 * context_match             (overlap tra topics corrente e topics tipici)
  + w5 * trend_signal              (booster/penalty da rising/declining/dormant)
  + w6 * intensity_modifier        (peak affect, non media)
  - w7 * silence_penalty           (penalty se silent_since significativo, a meno che non sia il tema attivo)
  + w8 * significance_floor        (se significance = high, garantisce score minimo non-zero)
```

I pesi sono parametri del harness (libero di sperimentare), le dimensioni sono il substrato (va aggiunto). Non tutte vanno applicate a tutto — la lista è un menu, non un obbligo.

**Nota di chiarimento (2026-05-13).** I termini della formula sono **logica di retrieval calcolata a query-time**, non colonne DB persistite. Solo `affect_resonance` legge un campo persistito (`muffin_status.affect_signature`). Tutti gli altri (`semantic_relevance`, `recency_decay`, `context_match`, `trend_signal`, `intensity_modifier`, `silence_penalty`, `significance_floor`) sono derivati al momento da `episodes`/`facts`/`state_entries` esistenti via funzioni pure (cosine, timestamp diff, topic overlap, ecc.). Una lettura precedente di questo documento ha confuso "termine della formula" con "colonna schema" — l'architettura è retrieve-time, non store-time.

### Come si calcola ciascun termine

**`semantic_relevance`** è già presente in forma `cosine_similarity(query_embedding, item_embedding)`. Nessun cambio.

**`recency_decay`** è `0.5 ^ (age_ms / half_life_ms)`. Half-life parametrico per layer.

**`affect_resonance`** è nuovo. Calcola similarità tra affect del momento (dalla finestra di messaggi recenti) e affect signature storica dell'item:

```
current_valence = mean(valence last 3 episodes)
current_arousal = mean(arousal last 3 episodes)
item_valence_dist = |current_valence - item.affect_mean_valence|
item_arousal_dist = |current_arousal - item.arousal_mean|
affect_resonance = 1 - (item_valence_dist + item_arousal_dist) / 2
```

Se Giusto oggi ha arousal alto e valence negativa (crisi), gli item con affect signature coerente (peak negatives, high volatility) ricevono boost. Questo è *priming emotivo* — prossimo a come la cognizione umana attiva associazioni coerenti con lo stato corrente. Se affect corrente è neutro, il termine è piccolo e non distorce.

**`context_match`** è Jaccard o cosine su topics:

```
current_topics = union(topics of last 3 episodes)
item_typical_topics = union(topics of its mentions, weighted by recency)
context_match = jaccard(current_topics, item_typical_topics)
```

**`trend_signal`** è discreto (moltiplicatore):

```
trend_signal = {
  'rising': +0.3,
  'stable': 0,
  'declining': -0.1,
  'dormant': -0.3 (unless query semantically matches → override)
}
```

**`intensity_modifier`** emerge dai peaks:

```
intensity_modifier = max(item.affect_peak_positive_abs, item.affect_peak_negative_abs)
```

Un'entità con anche solo un picco emotivo forte mantiene un floor di rilevanza.

**`silence_penalty`** è 0 se `silent_since` è null. Altrimenti è funzione di quanto tempo è passato + quanto significativo è il silenzio rispetto al pattern storico. Ha eccezione: se la query corrente è *su* quel silenzio ("che fine ha fatto X?"), il silenzio diventa *relevance boost*, non penalty.

**`significance_floor`** non è additivo — è una soglia. Se significance = high, `final_score = max(final_score, MIN_HIGH_SIGNIFICANCE_SCORE)`. Garantisce che fatti strutturali non vengano esclusi da scoring competitivo.

---

## Tre trappole da evitare

Il principio è potente e quindi pericoloso se applicato in modo dogmatico. Tre errori frequenti da nominare esplicitamente.

**Trappola 1: affect a tutto senza discriminare.** Non ogni formula beneficia di affect. Il dedup letterale di fatti simili lessicalmente (sim > 0.90) non ha bisogno di considerare affect — è una operazione di pulizia. Aggiungere affect dove non serve aggiunge complessità senza benefit. La regola: il principio si applica quando la domanda è "quanto è importante/rilevante/vivo questo item ora". Non si applica a bookkeeping puro (dedup, schema cleanup, pruning non-discriminativo).

**Trappola 2: confondere affect signature con intensity momentanea.** Una formula arricchita che pesa solo l'affect *dell'istante attuale* trascura la storia. Serve la signature aggregata (con volatility e peaks) oltre al momento. Altrimenti Giusto in un turno casualmente calmo "perde" tutte le entità ad alto affect storico — il contrario di quello che vogliamo.

**Trappola 3: trattare significance come derivabile.** Alcuni fatti sono importanti a priori, non perché menzionati spesso, non perché con affect alto. Il design deve mantenere significance come meta-tag esplicito, non come score computato. Un sistema che inferisce significance da affect-and-frequency farà l'errore classico: "se non ne parli, non è importante". Ma Giusto può non parlare delle cose fondamentali proprio perché sono fondamentali.

---

## Cosa significa questo operativamente

Non è un singolo intervento. È una **lente** che si applica ogni volta che si tocca una formula di peso, selezione, rilevanza, gate di trigger. Ogni formula già esistente nel codebase, quando viene toccata per qualsiasi ragione, va riletta:

> "Questa formula pesa `f(count, recency)` — dovrebbe anche considerare affect/trend/context/silence? Se sì, quali di queste dimensioni sono rilevanti per la domanda specifica?"

Questo applica un *filtro* alle modifiche, non aggiunge carico. Formule nuove nascono già col principio incorporato. Formule esistenti si arricchiscono quando tocchi, non si rifanno per ragioni di principio pure.

Il primo posto dove questo cambia i risultati osservabili è il **retrieval al turno** — ogni volta che il sistema assembla il contesto per il modello, la scelta di cosa includere e con quale salienza beneficia di questa formula arricchita rispetto al ranking solo-semantico. Questo è un intervento locale, ad alto impatto (ogni turno passa da lì), poco rischio (il principio è additivo — se i nuovi segnali sono zero/neutri la formula degenera a quella attuale).

Altri posti emergono naturalmente via l'applicazione della lente quando si toccano formule di peso esistenti — non è un singolo intervento ma una direzione da percorrere gradualmente.

---

## Aggiunta: confidence esplicita come settima dimensione

Le sei dimensioni elencate sopra rispondono alla domanda "quanto è vivo/rilevante questo item ora?". Una settima dimensione, complementare e ortogonale, risponde a "quanto possiamo fidarci di questa interpretazione?".

Ogni record interpretivo (fact inferred, pattern, observation, frammento di living profile, attributo di entità) può avere confidence variabile: claim ad alto evidence_count e user-confirmed sono solidi; claim da single-source model_inference sono speculativi. Il consumatore di derivati (Decider proattivo, gateway al turno) dovrebbe consumare claim sopra una soglia adattiva, e la prosa generata dovrebbe trattare claim sopra/sotto soglia con registri diversi (asserzione vs ipotesi).

Questa è la formalizzazione di `foundations/INVARIANTS.md §I-6`. È complementare al principio di UNDERSTANDING — non sostituisce le sei dimensioni, le accompagna. La formula arricchita può estendersi a:

```
score =
    w1 * semantic_relevance
  + ... (le sei dimensioni)
  + w9 * confidence_floor       (penalty se confidence < soglia,
                                 override se user-confirmed)
```

L'audit del 2026-04-29 ha rilevato che il Living Profile e il Counterpoint Profile, pur avendo contenuto di alta qualità a livello prosa, sono blob testuali liberi senza granularità di claim. Il modello che li legge tratta tutto come uguale autorità — claim ad alto supporto e speculazioni interpretative ricevono lo stesso peso. La confidence esplicita per claim risolve questo: il render testuale diventa un view sopra claim filtrati per soglia, non la sorgente.

---

## Predict-calibrate come operazionalizzazione

Il principio di UNDERSTANDING si traduce in pratica attraverso *predict-calibrate*: prima di estrarre/generare un derivato, il modello *predice* cosa si aspetta dato il contesto esistente, confronta con la realtà, salva solo i gap predittivi (oppure usa il gap come segnale di confidence). Pattern descritto in dettaglio in `pillars/memory/LAYERS.md §Cross-cutting 5`, applicabile ai derivati interpretivi della categoria 1 *cognitive introspective* (vedi `src/memory/CLAUDE.md` post MEM-C 2026-05-21): facts, episodes, narratives, observations.

La connessione con UNDERSTANDING: predict-calibrate non aggiunge dimensioni, *opera* su quelle elencate sopra. Il "gap" che viene salvato è una variazione su affect signature, trend, intensity, ecc. — il pattern operativo che produce e raffina queste dimensioni nel tempo, anziché ricalcolarle da zero ad ogni write.

Riferimento: Wang et al. (2025), *Nemori* — vedi `foundations/REFERENCES.md`.

---

## Riepilogo in tre righe

Capire richiede sei dimensioni oltre al contare: affect signature, intensity vs frequency, trend, context specificity, silenzio come segnale, significance irreducible. Ogni formula di peso/selezione nel codebase va riletta chiedendosi se sta rispondendo alla domanda "quanto è vivo questo item *ora*" o solo "esiste". Non è un intervento singolo: è una lente da applicare ogni volta che si tocca una formula, partendo dai punti ad alto impatto.
