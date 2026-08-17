# ADR-0040 — La manutenzione della memoria è guidata dai dati, non dall'orologio

**Contesto.** M5-bis riga 1 chiede **due** meccanismi. ADR-0038 ha costruito il
primo — la coda d'inattività a 20 s che consolida una conversazione appena
finisce — e ha chiuso dicendo, per iscritto, che il secondo non c'era: *"la
manutenzione periodica non esiste. Niente dream, niente compattazione, niente
drenaggio dell'arretrato, niente audit dei predicati."* Questa ADR è il secondo
meccanismo, e la prima cosa che ha prodotto è una correzione al nome.

Il primo meccanismo governa il **flusso**. Il secondo doveva governare lo
**stock**: quello che si accumula dietro il flusso, e quello che il flusso lascia
a un umano. Sono due domande diverse e vogliono due grilletti diversi — ma non
quelli che la riga di roadmap immaginava.

---

## La parola «periodica» era sbagliata, e scoprirlo ha deciso la forma

Elencando cosa un passaggio di manutenzione dovrebbe fare, ognuna delle voci si è
rivelata guidata dai **dati**, non dal tempo: un arretrato esiste o non esiste, una
coppia duplicata esiste o non esiste, una riga di `review` è aperta o è stata
risolta. **Niente in questo schema cambia perché è passato un giorno.** Un cron
notturno sarebbe quindi un timer senza niente che dipenda dal tempo — e i dodici
sistemi letti in `research/consolidamento-due-meccanismi.md` includono **zero**
che girino un cron puro.

L'unica cosa che *avrebbe* avuto bisogno dell'orologio è il decadimento della
confidenza, ed è rifiutato più sotto per ragioni sue.

Quindi il grilletto resta dov'è: **la stessa coda d'inattività, nel runtime**, così
ce l'ha ogni processo che esegue turni (ADR-0038 §"Dove vive la corsia" —
darlo al solo gateway lascerebbe a zero fatti chi non ha installato la unit).

---

## La regola di costo, che è quella portante

Nel vecchio sistema il dream girava **sopra** la work queue ed era la metà
piccola: ⬤ **100 report di dream contro 2.438 righe di work queue** negli stessi
quattro mesi — il **4%**. Un passaggio di manutenzione che costa più della corsia
che mantiene è peggio di nessun passaggio di manutenzione.

Quindi: **la manutenzione non spende niente.** Nessuna chiamata al modello,
nessun embedding, nessuna rete — è SQL su righe che la corsia ha già prodotto.
L'unica parte che chiama un modello è il drenaggio dell'arretrato, e paga
estrazioni che la corsia viva avrebbe pagato comunque, una per episodio: **il
totale non cambia, cambia solo quando**.

---

## Decisione 1 — Il drenaggio dell'arretrato

**Il problema, preciso.** Un arretrato più grande di `CONSOLIDATION_BATCH` toglie
alla coda d'inattività tutto il suo senso. `pendingEpisodes` ordina per
`created_at`, quindi uno scatto sotto arretrato spende la sua pagina sugli
episodi **più vecchi** e il messaggio che l'ha appena armata non è nel batch. La
proprietà che si stava comprando — il fatto a posto prima del messaggio
successivo della stessa conversazione, i famosi 11,8 s — semplicemente non tiene,
e niente lo dice. Gli arretrati non sono ipotetici: `muffin run` headless lascia
i suoi episodi dovuti **per costruzione** (il timer è `unref`'d), un gateway che è
stato giù accumula, una migrazione parte dovendo l'intero corpus.

**Quello che NON si fa: riordinare.** La mossa ovvia è far prendere alla corsia
viva gli episodi **più nuovi** e lasciare la coda alla manutenzione. È sbagliata,
e in modo silenzioso: `reconcile` sceglie il candidato al supersede per
`recorded_at` — quando l'abbiamo imparato — quindi estrarre fuori ordine
cronologico fa arrivare la pretesa di un episodio *più vecchio* come "incoming"
contro una credenza più nuova. Al giudice si chiederebbe se la risposta del mese
scorso sostituisce quella di questa settimana, e un verdetto `supersede`
**dis-correggerebbe una correzione**. Perdere un'estrazione si recupera
rigiocandola (`extraction_v` esiste per quello); un supersede sbagliato è
invisibile finché qualcuno non fa la domanda a cui rispondeva. È l'asimmetria
della decisione #2 della ricerca, e esclude il riordino.

**Quello che si fa.** L'ordine resta e si toglie l'arretrato: dopo una pagina
**piena** che ha **fatto progresso**, la corsia si ri-arma e prende la pagina
successiva. La proprietà si ripristina per convergenza invece che per priorità.

**`CONSOLIDATION_DRAIN_MS = CONSOLIDATION_IDLE_MS`, cioè nessuna costante nuova.**
Due ragioni, e la prima è quella che conta:

1. Il **tasso di picco del drenaggio è per costruzione il tasso di picco della
   corsia viva** — una pagina limitata ogni venti secondi, esattamente quello che
   la coda d'inattività già spende quando l'owner parla di continuo. Così «la
   manutenzione non deve costare più della corsia che mantiene» diventa una
   proprietà della forma invece di un numero da difendere.
2. Una costante nuova vorrebbe la sua misura sul corpus per non essere folklore,
   e nel corpus non c'è niente che la decida: il drenaggio non ha una scadenza
   visibile all'utente, solo un tempo di convergenza. A una pagina ogni 20 s
   l'intero corpus di quattro mesi dell'owner (4.107 episodi, 206 pagine) si
   drena in **~69 minuti di silenzio** — dentro una sera sola, e senza doverla
   aspettare.

Il drenaggio **perde sempre** contro la corsia viva: un turno che arriva mentre il
drenaggio è armato ri-arma la coda d'inattività, quindi la testa della fila —
dove ci sono le parole nuove dell'owner — è servita per prima.

**La condizione di arresto è il progresso, mai un conteggio.** `fetched === limit`
dice che dietro questa pagina c'è altro; `marked > 0` dice che la testa della fila
si è davvero mossa. Servono entrambe.

La seconda metà non è prudenza. Un episodio la cui estrazione fallisce in modo
**permanente** viene lasciato non marcato apposta perché venga ritentato, quindi
resta in testa a `ORDER BY created_at` per sempre. Un drenaggio che continuasse su
«c'è ancora qualcosa di pendente» rileggerebbe quella pagina ogni venti secondi e
ripagherebbe la stessa estrazione fallita fino a esaurire il budget del mese — che
è **lo stesso fallimento** per cui ADR-0038 ha scartato il ticker su
`stats.pending`, entrato da un'altra porta. Per questo `IngestReport` guadagna
`fetched` e `marked`: sono contati sul marcatore stesso, non ridedotti dai
contatori di skip, che è quello che `cli/memory.ts` faceva e che non poteva
vedere una testa che fallisce.

## Decisione 2 — La deduplica, senza soglia

**Threshold-free per obbligo, non per eleganza.** La ricerca misura che le soglie
di similarità **non si trasferiscono fra embedder**: ottimi per-modello da 0,7 a
0,93 su cinque modelli, e a un ingenuo 0,7 due modelli comuni hanno prodotto il
**99,00% di falsi positivi**. La miscalibrazione lì è catastrofica, non graduale,
e un merge sbagliato corrompe un *cluster*, non una riga (arXiv:2607.26298 sul
concatenamento transitivo). Lo 0,85 del vecchio non è portabile, e non lo è **in
linea di principio**, non per pigrizia.

Quindi si prende **solo il primo gradino della cascata di Graphiti** — chiave
esatta normalizzata — che è l'unico che non ha niente da calibrare. La
normalizzazione è: maiuscole/minuscole, spazi, punteggiatura finale. **Nient'altro.**
Niente accenti (l'FTS li toglie perché una *ricerca* che manca un risultato costa
un tentativo, un *merge* sbagliato ritira una credenza), niente articoli
("Cagliari" e "a Cagliari" restano due credenze: è esattamente la deriva che la
ricerca nomina, e piegarla sarebbe una soglia travestita da regex).

⬤ **E il corpus chiede esattamente questo gradino.** Sui quattro mesi del vecchio
sistema il grafo aveva **2** gruppi (soggetto, predicato) con più di un valore
attivo, per 5 righe in totale — e **tutti e due erano duplicati esatti** sotto
questa normalizzazione (anzi: identici byte per byte). *Ogni* gruppo multi-valore
realmente avvenuto era un duplicato; **nemmeno uno** avrebbe avuto bisogno di un
giudizio di similarità. La normalizzazione sopra è margine, non un bisogno
misurato.

**E non cancella mai.** Il duplicato si ritira con `supersede`: `expired_at`,
`superseded_by`, la riga resta dov'è. Non è prudenza generica — un passaggio di
manutenzione è **il posto più pericoloso di questo codice per un DELETE**, perché
opera in blocco con nessuno che guarda.

Una cosa nuova che questo ha costretto a chiarire: `supersede` scriveva sempre un
`valid_to`. Per una correzione vera è giusto (nessuno ha detto quando, quindi il
tempo del mondo si chiude quando si chiude quello di sistema). Per un **duplicato**
sarebbe l'invenzione di un confine nel tempo del mondo che non è mai esistito — il
duplicato non è mai stato una verità separata. Quindi `supersede` ha ora un terzo
stato, `validTo: null` = *non toccare il tempo del mondo*, e la regola di
`schema.ts` (*"una data fabbricata è indistinguibile da una vera un mese dopo"*)
vale anche per l'estremo di chiusura.

**Il cancello è un argomento, non un risparmio**: la sweep gira solo se il batch ha
aggiunto un fatto. Un duplicato fra le credenze *correnti* può nascere **solo**
quando una riga viene aggiunta — `supersede` toglie e basta, e niente altro scrive
su `facts`. Alla resa misurata di un fatto ogni trenta turni, questo è quasi ogni
scatto.

## Decisione 3 — Il registro `review` si legge, e si risponde

Il verdetto `review` del giudice — l'esito deliberato *«decida un umano»* — ha un
registro durevole dal `6ddba7c` e **nessun lettore in produzione**:
`store.pendingReview` era chiamato solo dai test, e l'unico numero che affiorava
era un `da rivedere N` che contava *ogni riga mai scritta*. Su una tabella
append-only un totale può solo crescere, ed è così che un numero smette di essere
letto in una settimana. È il registro nella forma di fallimento più familiare di
questo repo — scritto, testato, documentato, raggiunto da niente — e conta più ora
di quando è stato costruito, perché la corsia che lo produce gira senza nessuno
accanto.

**«Aperta» è una join, non una colonna.** `memory_review` non ha `resolved_at` e
non l'avrà: `schema.ts` dice perché — *un registro che tracciasse se un umano ha
già guardato sarebbe il workflow engine che era stato chiesto esplicitamente di
non diventare*. Quindi una contraddizione è aperta esattamente finché **entrambi**
i suoi fatti sono attivi. Nel momento in cui la conversazione ne supera uno, la
domanda smette di essere una domanda **senza che nessuno scriva niente**.

**Rispondere è un `supersede`**, cioè l'operazione che già esiste e che già non
cancella: `muffin memory review keep <fact-id>` tiene una credenza e ritira
l'altra, e `muffin memory why` rilegge la decisione come una catena invece che
come un'assenza. Due cose che deliberatamente non è: non è una tabella nuova (la
risposta vive nei fatti, dove viveva la domanda), e **non è il modello che scrive
la memoria** — è l'owner che decide a mano su una riga che la pipeline gli ha
messo davanti, quindi ADR-0032 §9 resta esattamente dov'era e la decisione aperta
sul tool `ricorda` non è toccata.

**Gli errori si piegano.** Un episodio che fallisce l'estrazione in modo permanente
scrive una riga `error` a ogni scatto che lo raggiunge — per sempre, dallo stesso
singolo episodio — e seppellirebbe le contraddizioni sotto un muro della stessa
frase. Il raggruppamento è fatto **in lettura**, non sopprimendo la scrittura: la
scrittura è il resoconto onesto di quante volte è successo, e un lettore che non
può vedere «questo è fallito 400 volte da giugno» si perde il risultato.

---

**Alternative scartate.**

- **Un cron notturno.** §"La parola «periodica»": non c'è niente in questo schema
  che dipenda dal tempo, e nessuno dei dodici sistemi letti ne gira uno.
- **Riordinare la corsia viva al più-nuovo-per-primo.** Dis-correggerebbe le
  correzioni; §Decisione 1.
- **Una deduplica a coseno** con la soglia 0,85 del vecchio: non porta fra
  embedder, e il corpus dice che non serve.
- **Piegare articoli/accenti nella normalizzazione**: è una soglia con la
  calibrazione nascosta dentro una regex.
- **Una colonna di stato su `memory_review`**: è il workflow engine rifiutato.
- **Una costante nuova per il passo del drenaggio**: sarebbe folklore, e
  riusare `CONSOLIDATION_IDLE_MS` rende il tetto di costo una proprietà della
  forma.

---

## Quello che NON è costruito, e perché — la parte che vale quanto il resto

**1. Il decadimento della confidenza: no, e non per prudenza.** Lo schema lo
regge (`facts.confidence REAL NOT NULL`), quindi la domanda non è se sia
rappresentabile. È che ha **tre** problemi e ognuno da solo basterebbe:

- **Non esiste un tasso difendibile.** La ricerca su questo corpus non ne offre
  uno, e il numero che si avvicina di più — le confidenze LLM sovrastimate di
  15-27 punti (audit 2026-08-06) — è un **offset di calibrazione costante**, non
  una costante di tempo. Far decadere un numero non calibrato compone due errori.
- **Non ha un lettore.** ⬤ L'unica soglia sulla confidenza in tutto il repo è
  `extract.ts:192` (`>= 0.4`), applicata all'output del modello **prima** della
  scrittura. Dopo, `confidence` viene solo *mostrata* (`muffin memory why`).
  Farla decadere sarebbe una mutazione senza consumatore: il tredicesimo membro
  della famiglia «dichiarato e collegato a niente».
- **E il giorno che un lettore ci fosse, sarebbe una cancellazione senza
  traccia.** Una credenza che scivola sotto una soglia di recall diventa
  irrecuperabile *senza mai essere ritirata*: nessun `expired_at`, nessun
  `superseded_by`, niente che `muffin memory why` possa mostrare. È una DELETE
  con passi in più, ed è esattamente ciò che «non si cancella mai una riga»
  esiste per impedire. Lo stesso argomento che `memory-salience-and-fusion.md` fa
  per `importance` fuori da RRF si applica identico qui: **la decadenza è una
  domanda di ranking, e il ranking non è il posto dove si tocca una riga.**

**2. Una passata di scadenza: non ha niente da scadere, oggi.** ⬤ Verificato sul
codice: `valid_to` è scritto **solo** da `supersede` (che scrive anche
`expired_at`) e da `addFact`, a cui `reconcile` non lo passa mai. Quindi «un
fatto la cui verità nel mondo è finita ma a cui crediamo ancora» **non è
rappresentabile**. Stessa cosa per `entities.expired_at`: nessuno scrive.
Costruire lo sweep sarebbe scrivere una guardia che non può scattare — di nuovo
la stessa famiglia. Quando `judge.ts` o un import cominceranno a produrre
`valid_to` su fatti vivi, quello è il commit in cui la guardia nasce, insieme al
suo produttore.

**3. Dream / compattazione: no, perché manca il consumatore.** Le tabelle
`profiles` e `digests` hanno **zero scrittori e zero lettori** (censite come tali
nella ricerca). Scrivere un compattatore vorrebbe dire pagare chiamate al modello
per riempire una tabella che nessun percorso di lettura interroga — cioè il
difetto di questo repo, ma a pagamento. Prima il lettore, poi lo scrittore.

**4. L'audit dei predicati: la metà che rileva c'è già, la metà che propone no.**
L'invariante `predicate_vocabulary` (soglia 80, calibrata sui 43 predicati / 329
archi del vecchio) rileva il problema, e il suo stesso testo dice cosa manca — *«il
consolidamento propone i merge, non li impone»*. Proporre un merge di predicati
richiede un giudizio di sinonimia, cioè una chiamata al modello o una lista di
sinonimi scritta a mano: la prima rompe la regola di costo di questa ADR, la
seconda è il vocabolario chiuso che ADR-0032 rifiuta. Resta aperto e scritto in
roadmap.

**5. `muffin run` headless continua a non consolidare.** Limite dichiarato da
ADR-0038, non toccato qui: il timer è `unref`'d perché un comando scriptabile non
deve restare in piedi venti secondi dopo aver risposto. Ora però la conseguenza è
più piccola, perché il primo processo di lunga vita che parte **drena tutto** invece
di prendere una pagina sola.

---

**Conseguenze.**

Più facile: sotto arretrato la corsia converge da sola invece di restare indietro
per sempre, e la proprietà «prima del messaggio dopo» torna a valere appena
l'arretrato finisce. Il registro `review` ha un lettore, un modo di rispondere e
un posto dove si vede (`memory stats`, `doctor`, la riga di boot di REPL e
gateway). I duplicati fra credenze correnti si ritirano da soli, senza soglie.

Più difficile, e va detto:

1. **Il database è ancora meno quiescente.** Sotto arretrato c'è una riga di
   `consolidation_runs` ogni venti secondi finché non converge — 206 righe per
   drenare il corpus dell'owner, una volta.
2. **Il tetto di costo del drenaggio è una forma, non un numero.** Se un giorno
   `CONSOLIDATION_BATCH` crescesse, crescerebbe anche il picco del drenaggio,
   perché sono la stessa pagina.
3. **La sweep non prende un lock.** Non le serve — il sopravvissuto è un ordine
   totale sulle righe, quindi due processi scelgono lo stesso e il perdente
   scrive a vuoto grazie a `expired_at IS NULL` — ma è una proprietà da non
   rompere: chi cambia il criterio del sopravvissuto in qualcosa di non
   deterministico deve mettere il lock nello stesso commit.

**Reversibilità.** Alta e per pezzi indipendenti. Il drenaggio si stacca togliendo
tre righe da `Consolidator.execute` e resta il mondo di ADR-0038. La sweep si
stacca togliendo una riga da `buildRuntime` (`sweep:`) e resta il mondo di prima,
duplicati compresi. Il lato lettura del registro non ha uno stato da disfare —
legge e basta — tranne il `keep`, che scrive un `supersede` come qualunque altro e
si legge in `memory why`.

**Segnale che era sbagliata**, contato e non percepito: `consolidation_runs` mostra
`trigger = 'drain'` tutti i giorni per una settimana (allora l'arretrato non
converge e la causa è a monte, non nel drenaggio); oppure `merged` è diverso da
zero più di qualche volta al mese (allora qualcosa a monte produce duplicati e la
sweep sta nascondendo il difetto invece di rivelarlo — ⬤ nel vecchio sarebbero
stati 2 in quattro mesi); oppure il numero di contraddizioni aperte cresce e non
cala, che vuol dire che il costo di rispondere è troppo alto e il verbo `keep` non
è la forma giusta.

---

## Prova d'esecuzione (2026-08-14, `slice/gateway`)

Eseguito, non dedotto. Home vera creata da `muffin init`, provider
`openai-compat` puntato a un endpoint locale su `127.0.0.1:8799` (un socket vero
e l'adapter spedito), embedder Ollama locale reale. **Nessuna chiamata a
pagamento.**

**Il drenaggio, dal REPL vero** — 45 episodi seminati come arretrato (ruolo
`agent`, che l'estrazione salta senza chiamare il modello), poi
`( echo "ciao"; sleep 110 ) | muffin`:

```
id   ran_at        trigger  outcome  episodi  ms
1    09:10:31.509  idle     ran      0        3564
2    09:10:55.074  drain    ran      0        4
3    09:11:15.080  drain    ran      1        13
```

`SELECT count(*) FROM episodes WHERE extraction_v = 0` → **0**. Tre pagine, 47
episodi, nessuno che digita niente, e si ferma da sé: la terza pagina era corta,
quindi non c'è una quarta riga.

**La sweep, attraverso il binding vero di `buildRuntime`:**

```
prima : Vela. · ceramica · vela
merges: [{"predicate":"interested_in","object":"Vela.","keptFactId":5,"retiredFactIds":[3]}]
dopo  : Vela. · ceramica
righe in facts (mai cancellate): 5
```

Tre credenze attive, due delle quali lo stesso interesse scritto due volte: resta
la più recente, l'altra è **ritirata e ancora lì**, e `ceramica` — un membro
legittimo dello stesso insieme — non è toccata.

**Il registro, dal binario vero:**

```
$ muffin memory review                                  # exit 1
#1 owner accountant — 2026-08-13 10:00
   tengo   #1 "Marco" (2026-06-01)
   oppure  #2 "Lucia" (2026-08-13)
   il giudice: nessuna delle due frasi dice quando
   → muffin memory review keep 2

problemi della pipeline (raggruppati per messaggio):
   3× · 2026-08-11 → 2026-08-13  estrazione fallita su episodio 7: risposta non parsabile

$ muffin memory review keep 2                           # exit 0
#1 deciso: tengo #2, ritiro #1 "Marco"

$ muffin memory why 1
#1 owner accountant Marco — ritirato il 2026-08-14 · valido ? → 2026-08-14
  sostituito da: #2 owner accountant Lucia — attivo

$ muffin memory review                                  # exit 0 — la domanda è chiusa
0 da decidere · 4 righe in archivio

$ muffin doctor
! memoria da decidere  1 contraddizioni aspettano te: due valori restano entrambi attivi finché non scegli
```

Tre righe di `error` diventano una riga con il conteggio e l'arco temporale;
`keep` ritira senza cancellare; e la domanda esce dalla lista **perché i fatti
sono cambiati**, non perché qualcuno abbia scritto uno stato.
