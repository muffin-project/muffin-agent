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
