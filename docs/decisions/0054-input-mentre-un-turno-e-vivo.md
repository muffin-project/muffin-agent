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

1. **Coda per default.** Un messaggio che arriva mentre un turno della stessa
   sessione è vivo diventa il turno successivo, nell'ordine di arrivo. La
   superficie lo **conferma** subito (una riga, «in coda, rispondo dopo»),
   così l'owner sa che è arrivato. Non si fonde con il turno in corso e non lo
   interrompe.
2. **`/steer <testo>`** è l'unico modo di entrare nel turno vivo. Il testo
   viene consegnato al loop al **prossimo confine di giro** — dopo che i tool
   del giro corrente hanno finito e prima della chiamata al modello
   successiva — come messaggio dell'owner nel contesto. Mai a metà di una tool
   call: un effect avviato non si finge non avvenuto (ADR-0052 §Conseguenze).
   Se nessun turno è vivo, `/steer` dice che non c'è niente da correggere.
3. **`/stop`** aborta il turno vivo della sessione (`AbortSignal` → esito
   `aborted`). I tool in corso ricevono lo stesso segnale; ciò che è già
   avvenuto resta avvenuto e il turno lo dice. La coda **non** si svuota:
   `/stop` ferma *questo* turno, non il lavoro futuro.
4. **`/pause`** ferma il runtime: nessun job parte, nessun turno in coda
   inizia, il turno vivo finisce il giro corrente e si sospende. Persistito,
   così un riavvio non lo dimentica. **`/resume`** riparte da dove era.
   Entrambi rispondono con lo stato risultante.
5. **Il poller riceve sempre.** `getUpdates` continua durante un turno; gli
   update finiscono nell'inbox durevole come oggi, e i comandi vengono
   riconosciuti e serviti **prima** di entrare nella coda dei turni. È la
   metà di B2 che mancava.
6. **Un meccanismo, tutte le porte.** I quattro comandi stanno in
   `agent/comandi.ts`; REPL e Telegram li elencano e li servono allo stesso
   modo (Ctrl+C nel terminale resta l'equivalente di `/stop`).

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
