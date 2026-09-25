# ADR-0054 — Un messaggio mentre un turno è vivo va in coda; `/steer`, `/stop`, `/pause`, `/resume`

**Stato:** accettato · 2026-09-03 · decisione owner durante il dogfood
(`docs/evidence/dogfood-superfici-2026-09-03.md` §5.3)

## Contesto

ADR-0052 separa evento, intento e Work e nomina il vocabolario del busy input
(`STEER / FOLLOWUP / COLLECT / INTERRUPT`) senza scegliere il default: «policy
UX/default da dogfood» (`docs/evidence/runtime-topology-2026-08-20.md` §D7).
Il dogfood è arrivato e ha scelto.

Oggi (`connectors/telegram/connector.ts` §`run`) il poller **non chiama
`getUpdates` mentre un turno gira**: `drain()` attende `runFresh`. Un messaggio
inviato nel frattempo resta sui server di Telegram, viene letto a turno finito
e processato in ordine. È una coda FIFO di fatto, ma senza conferma, e nessun
comando può raggiungere un turno vivo: `/stop` verrebbe letto dopo che il turno
ha finito da solo. Il loop accetta già un `AbortSignal`
(`agent/loop.ts`, esito `aborted`, «Interrotto.»); lo scheduler ha
`ForegroundGate` e `StandDown`. I comandi vivono in un posto solo
(`agent/comandi.ts`) e le due superfici lo leggono.

## Decisione

### 1. Coda per default

Un messaggio che arriva mentre un turno della stessa sessione è vivo diventa
il turno successivo, nell'ordine di arrivo. La superficie lo **conferma**
subito (una riga, «in coda, rispondo dopo»), così l'owner sa che è arrivato.
Non si fonde con il turno in corso e non lo interrompe.

### 2. `/steer <testo>`

L'unico modo di entrare nel turno vivo. Il testo viene consegnato al loop al
**prossimo confine di giro** — dopo che i tool del giro corrente hanno finito
e prima della chiamata al modello successiva — come messaggio dell'owner nel
contesto. Mai a metà di una tool call: un effect avviato non si finge non
avvenuto (ADR-0052 §Conseguenze). Se nessun turno è vivo, `/steer` dice che
non c'è niente da correggere.

### 3. `/stop`

Aborta il turno vivo della sessione (`AbortSignal` → esito `aborted`). I tool
in corso ricevono lo stesso segnale; ciò che è già avvenuto resta avvenuto e
il turno lo dice. La coda **non** si svuota: `/stop` ferma *questo* turno, non
il lavoro futuro.

### 4. `/pause` e `/resume`

`/pause` ferma il runtime: nessun job parte, nessun turno in coda inizia, il
turno vivo finisce il giro corrente e si sospende. Persistito, così un riavvio
non lo dimentica. `/resume` riparte da dove era. Entrambi rispondono con lo
stato risultante.

### 5. Il poller riceve sempre

`getUpdates` continua durante un turno; gli update finiscono nell'inbox
durevole come oggi, e i comandi vengono riconosciuti e serviti **prima** di
entrare nella coda dei turni. È la metà di B2 che mancava.

### 6. Un meccanismo, tutte le porte

I quattro comandi stanno in `agent/comandi.ts`; REPL e Telegram li elencano e
li servono allo stesso modo (Ctrl+C nel terminale resta l'equivalente di
`/stop`).

## Emendamento, stesso giorno, all'implementazione

Due precisazioni trovate costruendo (`slice/busy-input`), registrate qui e non
riscritte sopra:

- **§4, il turno vivo sotto `/pause`.** «Finisce il giro corrente e si
  sospende» avrebbe richiesto una nuova barriera di attesa (`WaitKind`) che
  nessun evento oggi soddisfa. Il turno vivo **finisce da solo** (è comunque
  limitato a 15 giri) e la risposta del comando lo dice, con `/stop` come
  leva per fermarlo davvero. Sospenderlo al giro resta possibile il giorno
  in cui serve; oggi sarebbe una barriera senza chi la valuta.
- **§6, il terminale.** Il REPL non legge mentre il modello risponde, quindi
  `/stop` e `/steer` dal terminale trovano sempre «nessun turno in corso» e
  lo dicono; il `/stop` del terminale a turno vivo è Ctrl+C. Leggere anche
  durante un turno — la coda del terminale — è il passo dopo, ora che la
  casella sta fissa in fondo (`cli/fondo.ts`). `/pause` e `/resume` dal
  terminale valgono per tutti i processi, come da §4.
- **§2, un `/steer` che nessun giro consuma** (03/09, dal giudice di #300).
  Le correzioni si leggono in cima al giro, quindi una risposta senza tool —
  **un** giro solo, il caso comune — non ne consuma nessuna: il `/steer`
  scritto mentre quella chiamata era in corso spariva con il turno, dopo che
  la superficie aveva già risposto «ricevuto». Regola: **una correzione non
  svanisce mai**. A turno finito, per ogni esito che non sia `aborted`,
  `agent/loop.ts` svuota la porta di steer un'ultima volta e scrive ciò che
  resta nel transcript della sessione **come messaggio dell'owner**; la
  history reinjection lo consegna alla prima chiamata al modello del turno
  successivo. Su `aborted` no: lì l'owner ha chiesto `/stop`, e ripescare la
  correzione sarebbe l'opposto. La conferma è onesta in entrambi i casi —
  «lo uso al prossimo passo di questo turno; se finisce prima, resta in
  conversazione per il turno dopo» — perché nel momento in cui si risponde
  non si sa ancora quale dei due sarà vero.
- **§2, una correzione pendente quando il turno si *sospende*** (03/09, dal
  giudice indipendente che l'ha misurata). L'emendamento qui sopra copre il
  turno che **finisce**; un turno sospeso non è finito — ha rilasciato il
  runtime e gli è dovuto un risveglio — e lì la correzione si perdeva due
  volte: la barriera si onora in cima al giro **prima** del drain, quindi una
  correzione arrivata durante il giro N veniva saltata, e `suspendHere` —
  a differenza di `finish` — non svuotava mai la porta, mentre il `finally`
  del connettore cancella la voce `vivi` (con le sue correzioni) appena
  `runTurn` torna. Regola: **una correzione pendente quando un turno si
  sospende viaggia nei `messages` persistiti di quel turno** — è ciò che
  `deps.turns.suspend` scrive e ciò da cui un turno ripreso riparte — e viene
  applicata **quando quel turno si sveglia**, che è letteralmente «il prossimo
  confine di giro» promesso da §2. Solo la correzione rimasta quando un turno
  finisce davvero va nella sessione, per il turno dopo. Se la scrittura di
  sospensione fallisce il turno non si sospende: la correzione già drenata
  viene scritta in sessione con la stessa provenienza (`record.taint`) che usa
  `finish`, invece di svanire nel ramo che sta già ammettendo il guasto. Il
  drain è distruttivo, quindi ogni strada che esce dal loop la consegna una
  volta sola. La conferma nomina adesso tutti e tre gli esiti.
- **§2, un imbuto invece di una lista di siti** (04/09, ripreso dal branch
  fermo `wip/repl-linereader-pipe-eof`'s sibling `slice/steer-un-imbuto`, che
  si era fermato senza verificare). L'invariante resta una riga: *una
  correzione `/steer` non si perde mai e non arriva mai due volte.* Era stata
  riparata tre volte aggiungendo un drain a un'uscita in più — la cima del
  giro, poi `finish`, poi la sospensione — e ogni riparazione era giusta e
  lasciava scoperta un'altra uscita. Portando il test del branch fermo
  (`agent/steer-imbuto.test.ts`, invariato) su `agent/loop.ts` di oggi si sono
  misurate **due** uscite ancora scoperte: il **rethrow** di `guidaIlTurno`
  (il provider esaurisce i ritentativi, la riga si chiude `error` e la
  funzione rilancia senza passare da `finish`, mentre il `finally` del
  connettore sta per cancellare l'array delle correzioni) e una **ripresa
  rifiutata** (sotto). Enumerare le uscite non converge: sono una lista che
  cresce con il codice. La garanzia non sta più su una lista di siti ma sulla
  forma: il motore (`guidaIlTurno`) gira dentro un guardiano (`drive`) e può
  uscire soltanto tornando o lanciando; su entrambe le strade il guardiano
  svuota la porta di steer e scrive ciò che resta in conversazione, come
  parole dell'owner. Un'uscita aggiunta domani ci passa **per costruzione**. I
  due drain di sito restano solo dove piazzano la correzione *meglio*
  dell'imbuto: in cima al giro, che la fa vedere al modello di questo turno, e
  nella sospensione, che la mette nei `messages` persistiti così è quel turno
  a vederla al risveglio. Sono sicuri perché la porta è **distruttiva**: un
  sito che ha già drenato lascia all'imbuto un no-op — misurato, non assunto
  (`agent/steer-imbuto.test.ts` conta le occorrenze su ogni strada, e togliere
  il solo imbuto lasciando tutti i drain di sito fa rosso). L'eccezione
  deliberata resta `aborted`: lì l'imbuto svuota la porta e **butta**, perché
  l'owner ha detto `/stop`.
- **§2, una scrittura fallita non è silenziosa.** Un `sessions.append` fallito
  nella ripesca finiva su un attributo di span: l'owner restava con un
  «ricevuto» che nessuno aveva onorato, e nessun modo di saperlo. Quando il
  motore torna con un risultato consegnabile, l'imbuto torna ciò che non è
  riuscito a scrivere e il turno lo dice **nel proprio testo** — lo stesso
  canale che si usa già quando la sospensione non riesce a salvare lo stato —
  riportando la correzione perché l'owner possa rimandarla. Una frase solo nel
  turno in cui la scrittura è davvero fallita: gli altri non diventano un
  rapporto.

  Se invece il motore rilancia, non c'è un testo di risposta da arricchire.
  L'imbuto annota l'errore secondario di persistenza nello span del turno,
  termina lo span dopo il drain e rilancia **lo stesso errore primario**. Il
  dettaglio è consultabile nell'output leggibile con
  `muffin trace grep steer_residuo_error`; è una diagnosi locale su richiesta,
  non una notifica automatica sulla superficie di chat.
- **§2, una ripresa rifiutata.** `resumeTurn` rifiuta `model_changed` o
  `resumes_exhausted` **prima** di `drive`, e `closeRow` chiude la riga: una
  correzione che la sospensione aveva parcheggiato durevolmente in
  `record.messages` non sarebbe più stata rigiocata a nessun modello —
  conservata e irraggiungibile, lo stesso difetto con un vestito migliore.
  Decisione: **va all'owner, dentro il rifiuto**, non nella sessione. Il
  criterio di «mai visto» è esatto — tutto ciò che segue l'ultimo messaggio
  dell'assistente e non è un risultato di tool — ma fra quei messaggi possono
  esserci anche frasi che il loop ha scritto da sé (il rapporto di risveglio,
  un passo di `recover`), e `Message` non porta nessuna provenienza con cui
  distinguerle: appenderle alla sessione come parole dell'owner metterebbe
  frasi di Muffin in bocca a lui, e una bugia di provenienza costa più di una
  riga persa. Nel `detail` del rifiuto sono invece il turno che riferisce, e la
  corsia lo consegna già (`agent/turn-lane.ts`), quindi l'owner le rilegge e
  decide se rimandarle. Se non c'è niente di non visto, il rifiuto non aggiunge
  rumore.
- **§5, un comando servito due volte.** `gestiti` — l'insieme che dice al drain
  «questo l'ho già servito io» — veniva riempito *mentre* i comandi si
  servivano, quindi un batch `[/pause, /resume]` lo popolava solo fino a dove
  era arrivato: il drain fatto ripartire dal `/pause` trovava il `/resume`
  ancora `pending` e lo serviva una seconda volta («ripreso…» e poi «non ero
  in pausa.» per un comando scritto una volta sola; con `/steer`, la
  correzione entrava due volte). Ora i comandi di controllo dell'owner
  dell'intero batch si registrano **prima di qualunque `await`**, e al poller
  arrivano solo gli update che `accept` ha davvero inserito, mai il batch
  grezzo.
- **Un abort a metà chiamata al modello** finiva `error`, non `aborted`: l'SDK
  rigetta con `AbortError` e `agent/loop.ts` lo rilanciava. Ora il segnale è
  il fatto e il turno chiude «Interrotto.» — vale anche per il Ctrl+C del
  REPL, che aveva lo stesso difetto.

## Alternative scartate

- **Fondere il messaggio nel turno in corso per default.** È quello che un
  umano si aspetta a volte e non altre; sbagliare in silenzio costa più di una
  parola in più (`/steer`).
- **Interrompere per default** (INTERRUPT). Butta lavoro fatto con tool già
  eseguiti; l'owner ha scelto la coda.
- **Classificatore LLM su ogni coppia di messaggi.** Escluso da ADR-0052.
- **`/steer` a metà tool call.** Viola il confine degli Effects.

## Conseguenze

- Il connettore Telegram separa **ricezione** (poll + inbox, sempre) da
  **esecuzione** (una corsia per sessione, un turno alla volta): oggi sono lo
  stesso `await`.
- Il loop guadagna una porta di steer per giro; il REPL già ha l'abort.
- Lo stato di pausa è un fatto durevole letto da scheduler e corsia dei turni.
- Le prove user-facing (coda confermata, `/stop` a metà turno, `/steer` al
  confine) si fanno sulla corsia reale oltre che sul finto Bot API
  (`docs/evidence/dogfood-superfici-2026-09-03.md` §5.4).

## Reversibilità e falsificazione

Il default è invertibile per configurazione senza toccare il kernel. La
decisione è sbagliata se il dogfood mostra che la maggior parte dei secondi
messaggi erano correzioni (allora il default diventa `steer` e si registra
qui), o se un `/stop` a metà turno viene letto solo a fine turno.
