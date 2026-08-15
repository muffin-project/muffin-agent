# ADR-0038 — Il consolidamento parte da solo: coda d'inattività, con un tetto a conteggio come rete

**Contesto.** `ingestPending` — episodi in, fatti fuori — è corretto dal `6ddba7c`
e ha **un solo chiamante**: `muffin memory extract`, digitato a mano. Le
conseguenze sono misurate, non temute: **414 fatti nel vecchio contro 0 nel
nuovo**, e — la parte che la roadmap non diceva — siccome `indexBacklog`/`index`
sono chiamati da `ingest.ts` e dal vault e **da nient'altro**, finché il
consolidamento non parte **il recall resta solo-keyword per tutta la vita
dell'installazione**. Non manca un livello: ne mancano due.

La riga della DoD di M5 (*"un trigger a soglia (N episodi non consolidati) fa
partire il consolidamento da solo"*) è non soddisfatta da quando M5 è stato
dichiarato chiuso. Questa ADR chiude **la prima metà** del rimedio — l'estrazione
per-turno asincrona. La seconda metà, la manutenzione periodica, **non è in
questa slice** ed è scritta come tale in `04-roadmap.md §M5-bis`.

La ricerca che decide le forme è `research/consolidamento-due-meccanismi.md`
(2026-08-13, misurata sul database vero). Tre numeri suoi comandano tutto quello
che segue:

- Il vecchio estraeva a **ogni** turno e la resa era **3,4%** — 78 `memory_saved`
  su 2.264 item. Una chiamata al modello per turno, un fatto ogni trenta.
- La sua latenza end-to-end era **11,8 s di mediana**, non «minuti» (la media a
  48 s la trascina una coda con p99 264 s). A dodici secondi il fatto è a posto
  **prima del messaggio successivo della stessa conversazione**. Quella proprietà
  è il prodotto; un meccanismo che atterra a minuti sarebbe una regressione.
- Il campo converge su una cosa sola e da quattro direzioni indipendenti: **coda
  d'inattività a fronte discendente** (LangMem 30-60 min, Memobase 3.600 s,
  Honcho 60 min, Supermemory «al massimo quindici minuti»). **Nessuno gira un
  cron notturno puro.** Ma quelle code sono tarate su *"la sessione è finita"*,
  che è una garanzia più debole di quella qui sopra.

---

**Decisione.** Il consolidamento parte da **una coda d'inattività armata dalla
fine di ogni turno**, con un **tetto a conteggio** come rete. Vive in
`core/memory/consolidator.ts`, l'aggancio nel loop è `LoopDeps.onTurnEnd`.

### Le due costanti, e il numero che le ha scelte

Misurate sul corpus vero dell'owner (`~/dev/Muffin/muffin.dev.db`, 4.107 episodi,
2026-03-16 → 2026-07-18) e non prese da un peer: i valori del campo rispondono a
una domanda diversa dalla nostra.

**`CONSOLIDATION_IDLE_MS = 20_000`** — venti secondi di silenzio dopo l'ultimo
turno. Tre misure, da tre direzioni:

| domanda | misura | conclusione |
|---|---|---|
| scatta mentre l'owner sta ancora scrivendo? | su 1.793 messaggi consecutivi dell'owner, **l'1,0%** dista meno di 20 s (3,5% sotto 30 s, 9,6% sotto 45 s) | un turno su cento paga una chiamata in più, nessuno paga un fatto sbagliato |
| quanto risparmia rispetto al per-turno? | con la coda ancorata alla risposta: **1.326 esecuzioni per 1.793 turni**, 1,35 turni per esecuzione | **−26% di chiamate al modello**, contro una resa del 3,4% |
| perché non più lunga? | 30 s → 1.282 esecuzioni (**−3,3% di chiamate per +50% di latenza**); 60 s → 1.075 (−19%) ma supera la **mediana di 56 s** fra risposta e messaggio successivo | oltre i 20 s si compra poco e si perde la proprietà «prima del messaggio dopo» |

E perché non 5 s, che sarebbe più vicino agli 11,8 s: a cinque secondi non si
coalizza quasi niente e si torna a una chiamata per turno per un fatto ogni
trenta, cioè esattamente la cosa che la ricerca dice di non rifare.

**`CONSOLIDATION_CEILING = 12`** — dodici turni senza pausa fanno partire il
batch comunque. Il tetto è una **rete**, non un secondo grilletto, e il numero è
scelto perché lo sia: sullo stesso corpus, **alla coda di 20 s la sequenza più
lunga di turni senza una pausa qualificante è 7** (p90 = 2, p99 = 4). Dodici sta
il 70% sopra il massimo osservato — su quattro mesi di traffico vero **non
sarebbe mai scattato**, che è ciò che una rete deve fare — e limita a dodici
turni la finestra non consolidata nella sessione di lavoro profondo che il corpus
non contiene. È anche il massimo osservato a una coda di 60 s, quindi resta una
rete se un giorno la coda venisse alzata verso i valori del campo.

Il campo lo circonda senza deciderlo (Letta 5, AgentCore 6, mem0 Dream 20, Honcho
50). **La somma di salienza** di Generative Agents (importanza ≥ 150, 2-3
esecuzioni al giorno) è scartata per una ragione strutturale, non di gusto: da noi
`importance` la assegna **l'estrazione**, quindi un grilletto a salienza avrebbe
bisogno dell'estrazione che deve far partire.

### Marcatura: almeno-una-volta, mai al-più-una-volta

Confermata dal `6ddba7c` e non riaperta. Perdere un'estrazione si recupera
rigiocandola — `extraction_v` esiste per quello. Un supersede sbagliato è
invisibile finché qualcuno non fa la domanda a cui rispondeva. Le due direzioni
non sono simmetriche, quindi la scelta non lo è.

### Dove vive la corsia — e perché non è un `Job`

Il `Consolidator` lo costruisce `buildRuntime`, quindi **ce l'ha ogni processo che
esegue turni**: il gateway (che ospita le surface remote) e una finestra REPL allo
stesso modo. Darlo al solo gateway lascerebbe un owner senza unit installata
esattamente dov'è oggi, a zero fatti. Due processi non estraggono due volte: il
lock di corsia durevole dentro `ingestPending` rifiuta il secondo.

**Non passa da `JobStore`**: un `Job` porta un `goal` in linguaggio naturale
eseguito da `runTurn` col modello principale, i tool e il kernel. Il
consolidamento non è niente di tutto ciò — è `ingestPending` sulla corsia light,
senza tool e senza una capability su cui `decide()` possa pronunciarsi.
Esprimerlo come job vorrebbe dire scrivere una frase in italiano e sperare che il
modello chiami un tool che non esiste.

**Non passa dallo `Scheduler`**: è una corsia sola, per costruzione («un owner,
una corsia, un job alla volta»). Metterci il consolidamento fa competere il brief
delle 8 e la memoria — un brief in volo rimanderebbe il consolidamento oltre la
sua coda, un arretrato di venti episodi ritarderebbe il brief. E soprattutto i due
vogliono un arbitraggio **opposto**: un job cede all'owner (il `ForegroundGate` di
ADR-0022), il consolidamento deve girare proprio quando l'owner ha appena smesso.

### L'aggancio nel loop, e perché non è la forma di `observe-run.ts`

`LoopDeps.onTurnEnd` è **sincrono e non deve bloccare**: `notify` arma un timer e
torna. Viene chiamato da `finish`, microsecondi prima che il chiamante scriva la
risposta, quindi qualunque `await` lì è attesa dell'owner.

Non è la forma «restituisci una chiusura e falla girare dopo la consegna» di
`agent/observe-run.ts`, e la differenza non è di stile. Lì la scrittura va
trattenuta finché la consegna non riesce, perché un episodio registrato per un
messaggio che l'owner non ha ricevuto sarebbe memoria di una cosa non successa.
Qui l'episodio è già scritto **in cima** a `runTurn`, prima della chiamata al
modello: l'input del grilletto esiste comunque, e trattenere l'annuncio
rimanderebbe soltanto lavoro già dovuto. `announceEnd` scatta anche sul ramo che
lancia — le parole dell'owner sono registrate prima che il modello venga
interrogato, quindi sono dovute all'estrazione comunque sia finito il turno.

### La cucitura per-tenant: **rifiutata in questa slice, esplicitamente**

`agent/context/assemble.ts:229-236` registra che la frase della persona di gruppo
*"non sto costruendo il ritratto di nessuno"* è vera oggi **solo perché** l'unico
chiamante di `ingestPending` cabla `TENANT = 'host'`. Schedulare l'ingestione è
esattamente la modifica che l'avrebbe resa falsa: un episodio di gruppo che
raggiunge `extractFacts` viene minato con `speakerName` derivato da `role`, cioè
la rivendicazione di uno sconosciuto scritta sotto l'etichetta «owner», in un
tenant la cui memoria non è dell'owner.

Quindi `notify` **scarta** tutto ciò che non è il tenant host, e la cosa ha due
test — uno unitario e uno attraverso un turno `member` vero sul runtime di
produzione. Allargarla richiede che il parlante venga dal principal dell'episodio
invece che dal suo ruolo: è una modifica all'**estrazione**, non alla
schedulazione, e non è qui.

### La spesa della corsia light entra nel budget

`recordSpend` è un campo di `LoopDeps` chiamato solo da `agent/loop.ts`.
`ingestPending`, il giudice e il reranker chiamano `provider.chat` direttamente,
quindi `/spend`, il cap mensile e il ramo `budget_exhausted` del kernel leggevano
**zero** dalla corsia della memoria. Tollerabile finché l'unico chiamante era un
comando digitato a mano; inaccettabile per una corsia che ora gira da sola e
ripetutamente — è la forma del loop di eco da $47 che `core/budget/budget.ts`
cita come ragione della sua esistenza.

Il rimedio è un **confine**, `agent/providers/light-lane.ts`, dietro cui la
corsia light viene costruita: fattura ogni chiamata e applica il `sampling` del
profilo. Non tre parametri infilati nelle tre funzioni, perché il difetto di
questo repo non è una riga sbagliata — è **un meccanismo che un chiamante
successivo non sa di dover raggiungere**. Un confine non lo si può dimenticare da
codice non ancora scritto.

Lo stesso confine chiude il punto 7 di `M5-bis`: `core/memory/{extract,judge,
rerank}.ts` cablano `temperature: 0` fuori dal sistema dei profili — legale solo
finché il light è haiku 4.5, un **400 su ogni consolidamento** il giorno che
`--light-model` punta a un 4.7+, e nessuna modifica ai profili poteva ripararlo.
I tre letterali restano dove sono e continuano a dire ciò che dicono (*questo
lavoro vuole determinismo*); il confine è dove quella richiesta incontra ciò che
il modello accetta, esattamente come lo spread di `profile.sampling` fa per la
corsia principale.

### I due slot pre-scavati: uno riempito, uno cancellato

- **`{kind:'system', source:'consolidation'}`** (`core/policy/types.ts:23`) —
  **riempito**, e la pretesa è tenuta stretta apposta: il kernel non ispetta mai
  `source`, quindi non è un ramo di policy, perché il consolidamento non invoca
  alcuna capability su cui `decide()` possa pronunciarsi. È ciò che distingue «ha
  speso la corsia della memoria» da «ha speso un job» nei due soli posti dove
  l'owner può guardare: lo span di `muffin trace` e la colonna `capability` dietro
  `/spend`. Se un giorno smettesse di essere letto lì, la mossa onesta è
  cancellarlo.
- **`ProactiveKind = 'consolidation'`** (`core/scheduler/proactivity.ts:48`) —
  **cancellato**, perché costruire il grilletto ha mostrato che era un errore di
  categoria. Quell'insieme è la lista chiusa delle cose che possono far **parlare
  per primo** Muffin, e il consolidamento non parla. Passarlo da `decideProactive`
  gli applicherebbe le rotaie sbagliate: le quiet hours rimanderebbero la corsia
  della memoria alle 08:00 (una conversazione delle 2 consolidata sei ore dopo,
  senza che nessuno dorma meglio), e la rotaia tier ≤ 1 chiede dell'evidenza che
  può armare un *messaggio*, che qui non c'è. La corsia tiene la rotaia che si
  applica davvero — il budget — e la chiede al motore direttamente. Se un giorno
  il consolidamento dovrà parlare, ciò che parla è il registro `review` del
  giudice, ed è un altro segnale con un'altra ancora e un rilevatore che non
  esiste: avrà il suo `kind` nello stesso commit del suo produttore.

### Che si veda

Una corsia che gira senza sorveglianza e non dice niente è indistinguibile da una
che non gira — e zero fatti è anche l'output **corretto** di una corsia sana in
una settimana tranquilla, perché la resa misurata è un fatto ogni trenta turni.
Quindi il numero che distingue le due cose è il conteggio delle esecuzioni, non
quello dei fatti: una tabella `consolidation_runs` (righe mai cancellate, §I-8)
con esito, conteggi e **durata**, letta da `muffin memory stats` e da `muffin
doctor`, più una riga al boot in REPL e gateway.

La durata è il numero che nessuno aveva: il vecchio logga in console e non
persiste, quindi dei suoi 18,5 s medi claim→processed non si è mai saputo quanto
fosse estrazione.

---

**Alternative scartate.**

- **Un job notturno / un cron.** Darebbe un Muffin che ti conosce con 24 ore di
  ritardo, contro gli 11,8 s che stiamo riproducendo. E nessuno dei dodici sistemi
  letti gira un cron puro.
- **Estrarre a ogni turno**, come il vecchio. Una chiamata al modello per turno
  per una resa del 3,4%, e arXiv:2605.12978 misura che il consolidamento
  incrementale frequente *degrada* l'utilità (ARC-AGI 100% → 54%) raccomandando
  in prosa esattamente il nostro piano episodi («trattare gli episodi grezzi come
  evidenza di prima classe e recintare il consolidamento invece di spararlo dopo
  ogni interazione»). Trasferito da traiettorie agentiche, non provato su chat:
  detto qui perché è il pezzo di evidenza più debole di questa ADR.
- **Un tetto a conteggio come grilletto primario**, che è la lettera della DoD di
  M5. È l'opzione che l'evidenza esterna sostiene di meno da sola: nessuno dei
  sistemi letti la usa senza una componente temporale accanto.
- **Somma di salienza** (Generative Agents): richiederebbe l'estrazione che deve
  innescare.
- **Un ticker che legge `stats.pending`** invece di un contatore in memoria: un
  episodio che fallisce l'estrazione in modo permanente terrebbe `pending` sopra
  la soglia e farebbe scattare la corsia a **ogni** turno, per sempre.
- **Il consolidamento dentro lo `Scheduler`** o come `Job`: sopra, §"Dove vive la
  corsia".
- **Un tool `ricorda` che scrive i fatti direttamente**: fuori scope, ed è
  dell'owner (cancella ADR-0032 §9). Nel vecchio quel percorso ha fatto il 9,7%
  dei fatti **decadendo a zero in quattro mesi**.

---

**Conseguenze.**

Più facile: la memoria si riempie da sola, e con essa l'indice vettoriale —
provato eseguendolo, non dedotto (sotto). `importance`, `origin`, il recall
ibrido e il rilevatore d'assenza smettono di essere inerti tutti insieme, perché
erano inerti per la stessa singola ragione.

Più difficile, e sono tre cose vere che vanno dette:

1. **`muffin run` headless non consolida.** Il timer è `unref`'d — un comando
   scriptabile non deve restare in piedi venti secondi dopo aver risposto — quindi
   un processo one-shot esce prima della coda. L'episodio non è perso: resta
   dovuto e lo prende la prima coda di un processo di lunga vita, o `muffin memory
   extract`. È un limite dichiarato, non un difetto scoperto dopo.
2. **Sotto arretrato, la proprietà «prima del messaggio dopo» non tiene.**
   `pendingEpisodes` ordina per `created_at` e un batch è limitato a
   `CONSOLIDATION_BATCH = 20`, quindi finché esiste un arretrato più grande
   l'episodio consolidato non è il più recente. Drenare un arretrato è il lavoro
   del **secondo meccanismo**, che non è in questa slice.
3. **Il database non è più mai quiescente** — ma quella l'aveva già pagata
   ADR-0035 col battito ogni 30 s. Qui si aggiunge una riga in
   `consolidation_runs` per esecuzione, cioè dell'ordine di venti righe al giorno.

E una cosa che questa ADR **non** chiude, scritta perché la roadmap ha già
dichiarato chiusa cinque volte una riga che non lo era: **la manutenzione
periodica non esiste**. Niente dream, niente compattazione, niente drenaggio
dell'arretrato, niente audit dei predicati. La riga 1 di M5-bis è chiusa a metà, e
la metà aperta è scritta lì.

---

**Reversibilità.** Alta e per gradi. Le due costanti sono due nomi in un file, e
la ricerca che li ha scelti è citata dove vivono. Il grilletto intero si stacca
togliendo una riga da `buildRuntime` (`onTurnEnd`), e ciò che resta è esattamente
il mondo di ieri: `muffin memory extract` a mano, sulla stessa funzione. Il
confine della corsia light è indipendente dal grilletto e va tenuto in ogni caso —
la spesa invisibile era un difetto anche quando il chiamante era uno solo.

**Segnale che era sbagliata**, contato e non percepito: `consolidation_runs`
mostra un `trigger = 'ceiling'` più di una volta a settimana (allora la coda è
troppo lunga, o le conversazioni dell'owner non somigliano al corpus su cui è
tarata); oppure la mediana di `ms` supera i dieci secondi (allora il batch è
troppo grande e la proprietà che stiamo comprando non c'è); oppure passa un mese
d'uso quotidiano e i fatti restano sotto un decimo dei 414 del vecchio a parità di
turni — nel qual caso il problema non era il grilletto e non lo era mai.

---

## Prova d'esecuzione (2026-08-13, `slice/gateway`)

Eseguito, non dedotto. Home vera in `/tmp/muffin-proof/home` creata da `muffin
init`, provider `openai-compat` puntato a un endpoint locale su `127.0.0.1:8799`
(un socket vero e l'adapter spedito, non un mock dentro un test), embedder Ollama
locale reale.

**Coda d'inattività, dal REPL vero** — `( echo "mi sono trasferito a Cagliari";
sleep 32 ) | muffin`:

```
16:13:59.633  chiamata al modello principale   (il turno)
16:13:59.647  risposta consegnata              ← l'owner non ha aspettato niente
16:14:19.643  chiamata al modello light        ← +20,010 s, la coda
16:14:19.647  fatto scritto: owner lives_in Cagliari (origin=said, tier 0, importance 1)
```

`consolidation_runs`: `idle · ran · 1 episodio · 1 fatto · 3 chunk indicizzati ·
321 ms`. `spend`: due righe, `llm.chat` e **`system.consolidation`**.

**Tetto e corsia dal gateway, senza nessun REPL aperto** — job al minuto, poi
`muffin gateway run`:

```
16:16:16.408  il job spara, turno eseguito, "⏰ Ricevuto…" su stdout
16:16:36.426  chiamata al modello light        ← +20,003 s
```

`consolidation_runs` riga 2: `idle · ran · 1 episodio · 0 fatti · 2 chunk · 233
ms` — zero fatti perché il fatto era un duplicato esatto e la deduplica di
`reconcile` l'ha assorbito, che è il comportamento voluto visto dal vivo. Poi
`gateway stop` drena ed esce 143.

**Che si veda**, sulla stessa home:

```
$ muffin memory stats
indice vett.   5 chunk · 5 vettori
consolidam.    13/08/26, 18:16 (idle) · 1 episodi · 0 fatti in 0.2s — 2 run, 1 fatti in totale

$ muffin doctor
✓ vector index       5 chunks, 5 vectors, in sync
✓ consolidamento     ultimo giro 13/08/26, 18:16 (idle/ran) · 1 episodi · 0 fatti · 2 run in totale
```

Prima della prima esecuzione lo stesso `doctor` diceva `! consolidamento — mai
eseguito: gli episodi non diventano fatti e il recall resta solo-keyword`.
L'indice vettoriale che passa da vuoto a `5 chunk · 5 vettori, in sync` è la
seconda metà del difetto — quella che la ricerca aveva trovato e la roadmap non
diceva — chiusa dallo stesso grilletto.

**Un numero onesto sul contorno**: le righe di `spend` riportano `usd 0.0`, perché
`local-main` e `local-haiku-4-5` non sono nel listino. Vale identicamente per la
corsia principale ed è una proprietà di `costUsd`, non di questa slice: il cap
morde solo per i modelli che il listino conosce.
