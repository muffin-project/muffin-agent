# ADR-0060 — Una promessa ha un momento, e torna in ritardo ma onesta

**Stato:** accettato · 2026-09-03

## Contesto — la sveglia c'è, mancava chi la carica

`docs/evidence/fuori-dal-turno-2026-09-03.md`, del 2026-09-03, ha misurato la
catena intera e ha trovato che il difetto non è in nessun meccanismo:

- il tick batte ogni 30 secondi da settimane ed **è** il battito
  (`core/gateway/service.ts`), e su uno store senza job dovuti non emette
  nemmeno un evento;
- `JobStore.add` ha, in tutto l'albero, **un solo chiamante di produzione**:
  `cli/jobs.ts`, battuto a mano dall'owner. Ogni altro è un test o un eval;
- `proactive_fires: 0` sull'installazione dell'owner significa una cosa sola e
  verificabile: nessuno ha mai eseguito `muffin observe --send`;
- `ProactiveKind` dichiara quattro valori e **uno solo ha un produttore**
  (`gone_quiet`). `commitment_due` — *«un obbligo che l'owner ha registrato, il
  cui momento si avvicina»* — è dichiarato dal giorno uno e non è mai stato
  scritto da nessuno.

E le due metà non potevano incontrarsi per costruzione: `todos` è chiavata
`(tenant, session_id, key)` ed è letta solo all'inizio di un turno *in quella
sessione*, mentre un job apre una sessione usa e getta
(`agent/scheduler-run.ts`). **Chi si sveglia non ha il piano, e il piano non ha
un orologio.**

Il fatto sotto tutto questo è di **tipo**, non di accesso: niente nell'albero
sapeva rappresentare *«una cosa il 3 ottobre»*. `jobs` rappresenta una
ricorrenza — `markRan` ricalcola sempre il prossimo sparo e non disattiva mai
una riga, quindi un impegno singolo scritto `0 9 3 10 *` tornerebbe ogni anno.
`todos` rappresenta un passo. `wait` rappresenta un'attesa dentro un turno, al
massimo sette giorni e con otto slot per tenant. Nessuno dei tre è un impegno
datato.

## Decisione

**Una riga di `todos` può portare un momento (`due_at`), e a quel momento
diventa il primo produttore di `commitment_due`.**

Quattro parti, e ognuna è una scelta con un'alternativa che è stata scartata.

### 1. Il momento sta su `todos`, non su `jobs`

Perché la riga esiste già, è già durevole, è già scritta dal modello, ed è
l'unica delle due tabelle che **porta il taint del turno che l'ha scritta** in
una colonna dichiarata `NOT NULL` senza default. Un job spara oggi con
principale di sistema e `taint: 0` scritto letteralmente
(`agent/scheduler-run.ts`): un impegno datato messo lì da un turno a taint 3
produrrebbe, un mese dopo, un turno a taint 0 — laundering completo, e con
un'ampiezza d'azione maggiore di quella del turno che l'ha scritto. È lo
scenario `s7` *remember-then-act* del corpus avversariale del 03/09, che
riesce e che nessuna guardia ferma.

Il taint quindi non viene inventato qui: **viaggia**. La riga porta
`ctx.intrinsicTaint()` del turno che l'ha scritta o datata, `max()`-ato a ogni
tocco come già facevano `plan` e `setState`; il trigger porta quel tier;
`decideProactive` risponde `{ effect: 'deny', reason: 'tainted_source' }` a
qualunque cosa sopra tier 1, sulla sua **prima riga**, prima delle ore di
silenzio e prima del budget. Nessuna rotaia nuova, nessuna decisione del kernel
cambiata: questa slice produce un **input** per il gate che c'era già.

Un `taint` che viaggia da solo non basterebbe se la corsia lo ricalcolasse al
risveglio. Non lo fa: il tier è registrato alla scrittura e letto tale e quale
al momento della consegna.

### 2. Consegna tardiva ma onesta

Muffin aveva già una semantica di recupero per i job e non l'aveva mai
dichiarata: `markRan` ricalcola il prossimo sparo **da adesso** e `due()`
seleziona qualunque riga scaduta, quindi un processo spento tre giorni spara una
volta sola e riprende la cadenza — `coalesce=True` con grace illimitato, nel
vocabolario di APScheduler. Per una ricorrenza è la scelta giusta e resta
invariata.

**Per un impegno singolo la stessa regola, applicata in silenzio, è sbagliata.**
Un cron perso è una ripetizione e «il brief delle 8» resta utile alle 8:03; una
promessa persa non è una ripetizione, e consegnarla giovedì *come se fosse
adesso* produce «ricordati della cosa» due giorni dopo, indistinguibile da un
guasto.

Le due opzioni reali erano un **grace bound** (oltre N ore l'impegno non parla e
diventa una riga da guardare) e una **consegna onesta ma tardiva**. Scelta la
seconda: **un impegno silenziosamente perso è peggio di uno consegnato in
ritardo**, e un silenzio prodotto da un riavvio è indistinguibile da un guasto —
confusione che questo repository ha già pagato altrove. Quindi la grazia resta
illimitata, come per i job, e ciò che cambia è che il caso datato **lo dice**:

- in orario: `Promemoria: <il passo>`
- in ritardo: `Promemoria in ritardo: <il passo> — era per martedì 6 ottobre alle 09:00.`

La soglia è un'ora (`LATE_AFTER_MS`), ed è un giudizio dichiarato, non una
misura: sotto quella, con un tick da 30 secondi, la promessa arriva al suo
momento come un momento è vissuto da una persona. Il giorno e l'ora sono resi
**nel fuso dell'owner**, letto dal root of trust — mai quello del processo, che
sotto launchd/systemd è l'ambiente di un supervisore.

### 3. Un impegno non è una ricorrenza

Consegnato, è finito. L'ancora — `commitment:<sessione>:<seq>:<istante>` — viene
bruciata nel `FireLog`, che è la stessa tabella e lo stesso namespace che dedupa
le assenze, e le righe non si cancellano mai (§I-8). Non esiste nessun
`markRan` in questa corsia: **niente ricalcola un momento successivo**.

Due conseguenze volute. La riga di `todos` resta `pending`: Muffin che ricorda
una cosa all'owner non è l'owner che l'ha fatta, e marcarla `done` sarebbe una
bugia sullo stato del piano. E spostare la data **è** un impegno nuovo, perché
l'istante è dentro l'ancora — esattamente come `absenceAnchor` porta `lastSeen`:
senza, un owner che sposta una promessa da martedì a venerdì non ne sentirebbe
mai più parlare.

### 4. Nessun tool `jobs` per il modello

Resta chiuso («Bivio owner n. 2»). Se un giorno si apre, la prima modifica non è
aggiungere un `maxTaint`: è che `agent/scheduler-run.ts` smetta di scrivere
`taint: 0` a mano e legga un taint conservato sulla riga del job. Finché quel
`0` è una costante letterale, ogni discussione su chi possa creare job è una
discussione su come fare laundering, non su se.

Nella stessa decisione: il commento di `cli/jobs.ts` che affermava
all'indicativo presente che *«the natural-language path … **is** a loop tool
that turns the phrase into this cron»* è stato corretto. Quel tool non è mai
esistito, e un commento che mente sul presente è peggio di nessun commento.

## Dove sta la manopola, e dove non sta

Il passaggio sugli impegni sta sul **tick dello scheduler**, non su una corsia
giornaliera separata, e non è una contraddizione con la raccomandazione del memo
(«una volta al giorno, alla fine della finestra di silenzio»): quella parlava del
costo di un produttore che deve *inferire* qualcosa. Qui la scansione è una
query indicizzata su `todos(tenant, due_at)`, esattamente il costo che il tick
già paga per `jobs.due(now)`, e la latenza conta — una promessa per le 09:00
consegnata alla fine della prossima finestra di silenzio è una promessa mancata.
*Quando* può parlare resta interamente di `decideProactive`: nelle ore di
silenzio rimanda alla fine della finestra, come per ogni altro trigger, e da lì
esce dicendo che è in ritardo.

Sta dentro `Scheduler.tick` e non accanto a esso in `Gateway.tick` perché le due
condizioni che devono zittire anche un impegno — `standDown` (un altro processo
possiede lo store) e `paused` (ADR-0054 §4) — sono già risolte lì: un secondo
punto di chiamata sarebbe una seconda scrittura delle stesse due regole, e il
REPL, che possiede uno scheduler e nessun gateway, non ne avrebbe avuta nessuna.
È chiesto **prima** di `modelLane.busy()` e del foreground gate, perché la
consegna di un impegno non chiama il modello: il testo è quello dell'owner, e
parafrasarlo è l'unica cosa che un promemoria non deve fare. Costa zero token e
funziona su una casa senza chiave API.

Le due porte che possiedono uno scheduler — `cli/gateway.ts` e `cli/repl.ts`,
che le cede quando c'è (ADR-0035) — costruiscono la corsia dalla **stessa**
funzione, `makeCommitmentLane`.

## Conseguenze

- **Schema.** `todos` guadagna `due_at TEXT` nullable e un indice parziale
  `idx_todos_due`. Migrazione versionata `v4` (`core/db/migrate.ts`), additiva,
  senza default e **senza backfill**: ogni riga scritta prima di oggi lo è stata
  quando «un passo con un momento» non era un concetto, e datarne una
  trasformerebbe del testo che l'owner non ha mai datato in qualcosa che può far
  parlare Muffin per primo. Stessa direzione, e stessa argomentazione, della
  migrazione 2 per `jobs.kind`.
- **La dichiarazione di `turn.todo` diceva il falso e non lo dice più.** Il
  commento su `risk: 'low'` terminava con *«nothing downstream acts on a row:
  the list is shown, never executed»*. Da oggi una riga datata fa parlare Muffin,
  ed è corretto nello stesso commit che lo rende falso. `effect` resta `context`
  e `risk` resta `low` — nessuna cella della matrice si muove: una riga non
  viene comunque mai *eseguita*, il messaggio è il suo stesso testo, nessun tool
  gira, niente sull'host cambia. E soprattutto il kernel non è ciò che difende
  qui e non potrebbe esserlo: decide che cosa può fare un **turno**, mentre la
  promessa è consegnata un mese dopo da un processo in cui non c'è nessun turno.
  A difenderla è `decideProactive`.
- **Il tick a vuoto resta muto.** Su un'installazione senza impegni dovuti la
  corsia esegue una query indicizzata e torna, senza eventi, come già faceva
  quella dei job. La risposta giusta a un risveglio senza niente in coda resta
  niente.
- **Un'ancora si brucia solo su un messaggio arrivato.** Una consegna fallita
  lascia l'impegno aperto e riprova al giro dopo. È la regola su cui gira già
  `cli/observe.ts`, ed è più stretta qui: un'assenza non consegnata torna
  comunque, una promessa bruciata su una consegna mai avvenuta è persa e basta.

## Cosa la ribalterebbe

Il §9.4 del memo, non rieseguito qui: **quante promesse con un momento l'owner
faccia davvero in una settimana**. Si misura a costo zero contando le righe di
`todos` e i fatti in memoria con un'espressione temporale. Se il numero è zero o
uno, la risposta giusta era non costruire niente, e questa decisione va
riaperta con quel numero in mano.

Il secondo segnale è quello che ADR-0028 ha già scelto per sé: il tasso con cui
l'owner scarta ciò che Muffin dice di sua iniziativa. Se sale, il produttore si
spegne. Oggi non è misurabile — il fire log registra solo gli `allow`, per
costruzione dichiarata — e questa slice non lo cambia.
