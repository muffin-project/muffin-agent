# Capire ≠ ricordare — le 6+1 dimensioni

**Stato: VIVO nei princìpi, SUPERATO nella forma.** Le dimensioni reggono e sono
il substrato su cui progettiamo memoria, recall e proattività. La *formula* in cui
erano scritte — una somma pesata `w1·…+w9·…` — non si porta avanti: vedi
§"La forma che non si porta" qui sotto, che è la parte da leggere se stai per
toccare il ranking.

Fonte: `docs/history/foundations/legacy/UNDERSTANDING.md` (già nel repo dopo il consolidamento
ADR-0031). Curato 2026-08-09.

## Il principio

> Un sistema che accumula dati senza pesarli per intensità, direzione, contesto e
> silenzio **ricorda bene ma non capisce**.

Ricordare è un lookup: *"esiste questo fatto?"*. Capire è una sintesi:
*"come sta, ora?"*. Il primo risponde corretto e piatto; il secondo coglie cosa
sta sotto. È la differenza fra "Simpleclaim è live" e "Simpleclaim sta bene
adesso, ma sei preoccupato perché il ricordo della crisi di febbraio è ancora lì".

## Le sei dimensioni che contare non cattura

1. **Affect signature** — non la media, la *distribuzione*: `affect_mean`,
   `affect_volatility`, `affect_peaks` (con puntamento all'episodio). Media +0.1
   costante e media +0.1 con volatility 0.6 e due picchi a −0.8 sono due mondi.
2. **Intensity ≠ frequency** — 3 menzioni ad arousal 0.9 possono battere 30 a 0.2,
   e `count × intensity_media` **non** cattura la differenza. La discriminante
   pragmatica: la domanda è *"quanto è vicino allo stato attuale"* (allora
   frequency-recency basta) o *"quanto è presente nella mente"* (allora intensity
   domina)?
3. **Trend** — la derivata, non il livello: `rising` / `stable` / `declining` /
   `dormant`. `mention_count 15` stabile e `15` in crescita sono cose diverse, e
   il livello da solo butta via l'informazione più importante.
4. **Context specificity** — non è una proprietà dell'entità, è una proprietà
   della **coppia (entità, contesto corrente)**. Risolve ciò che il retrieval
   solo-semantico sbaglia: pesa per similarità generica invece che per coerenza
   con lo stato della conversazione.
5. **Silenzio come segnale** — misurato sul **delta dal pattern storico**, mai sul
   valore assoluto di `last_seen`. Dettaglio in `04-learn-from-absence.md`.
6. **Significance irreducible** — alcune cose contano e basta. *"Mio padre è
   morto"* è importante a prescindere da conteggio, recency e affect.

**+1. Confidence esplicita** (`INVARIANTS.md §I-6`) — ortogonale alle sei:
non *"quanto è vivo"* ma *"quanto possiamo fidarci di questa interpretazione"*.
E il consumo scala col registro: **asserzione sopra soglia, ipotesi sotto**.

## Le tre trappole (nominate perché già cadute)

1. **Affect ovunque senza discriminare** — il dedup lessicale non ha bisogno di
   affect. La lente si applica quando la domanda è "quanto è rilevante *ora*",
   non al bookkeeping.
2. **Confondere la signature con l'intensità del momento** — pesare solo l'affect
   dell'istante fa "perdere" tutte le entità ad alto affect storico in un turno
   casualmente calmo.
3. **Trattare significance come derivabile** — è la trappola che vale di più:
   > *"Un sistema che inferisce significance da affect-and-frequency farà
   > l'errore classico: «se non ne parli, non è importante». Ma si può non
   > parlare delle cose fondamentali proprio perché sono fondamentali."*

## La forma che NON si porta — leggi qui prima di toccare il recall

Il documento originale propone un unico punteggio come somma pesata di nove
termini (`w1·semantic + w2·recency + … + w9·confidence_floor`). **Quella forma è
superata**, per due ragioni indipendenti che dicono la stessa cosa:

- **Dall'esterno** (`docs/evidence/memory-salience-and-fusion.md`): nessun sistema di
  produzione mette un prior per-item dentro la fusione, e il nostro recall fonde
  con RRF. A k=60 il gap fra ranghi adiacenti è `0.000264` mentre l'accordo fra
  due ranker vale `0.016393` — **62×**. Un termine additivo abbastanza grande da
  spostare qualcosa è già abbastanza grande da cancellare il consenso, e fallisce
  in modo invisibile: la lista continua a sembrare ordinata per rilevanza.
- **Dall'interno**, ed è la convergenza che vale: §6 di questo stesso documento
  dice che significance deve funzionare da **soglia di protezione, non da
  moltiplicatore** — *"deve garantire persistence, non solo extra peso"*. Cioè:
  protegge dalla dimenticanza, non scala il ranking.

L'evidenza esterna misurata (2026-07, ablation su ritenzione) e il corpus interno
(2026-05) sono arrivati alla stessa conclusione per strade diverse. **L'importanza
protegge, non spinge.**

Come è incarnato oggi (`4e72bea`): `importance` è una colonna ordinale sul fatto,
assegnata al write-path per forced-choice — coerente con la nota di riga 110
dell'originale, dove significance è l'unica dimensione che va persistita e le
altre si calcolano a query-time. Agisce **dentro** l'espansione del grafo,
decidendo quali fatti sopravvivono al taglio, e **non entra in RRF**.

Cosa manca ancora perché §6 sia davvero soddisfatta: non esiste decay, quindi non
esiste ancora "esente dal decay". Quando il decay arriverà, `importance ≥ 1` è
l'esenzione — ed è lì che questa dimensione ripaga davvero.

## Cosa resta da incarnare

| Dimensione | Stato nel nuovo |
|---|---|
| Intensity ≠ frequency | ✅ `facts.importance`, ordinale, forced-choice |
| Confidence + detto/dedotto | ✅ `facts.confidence` + `facts.origin` |
| Silenzio | ⏳ MVP #5 — producer di eventi per il gate stadio-1 |
| Trend | ⏳ derivata, ricalcolata in consolidamento |
| Affect signature | ⏳ EMA cheap, non un LLM di sentiment (`03-observing-spine.md`) |
| Context specificity | ⏳ nessuna incarnazione |
| Significance come floor anti-decay | ⏳ serve prima il decay |

## Fonti

`docs/history/foundations/legacy/UNDERSTANDING.md` · `docs/history/foundations/legacy/INVARIANTS.md §I-6` ·
`docs/evidence/memory-salience-and-fusion.md` · `docs/knowledge/04-learn-from-absence.md` ·
`docs/knowledge/03-observing-spine.md` · Wang et al. (2025), *Nemori* (predict-calibrate)
— arXiv da ri-verificare, vedi `docs/history/foundations/legacy/REFERENCES.md`.
