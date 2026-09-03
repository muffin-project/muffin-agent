# ADR-0056 — Una conversazione per l'owner: la chiave di sessione esce da `identify`

**Stato:** accettato · 2026-09-03 · esegue l'opzione **B** della memo
`docs/evidence/continuita-e-provenienza-2026-09-03.md` (§5 la tabella di
decisione, §7 la raccomandazione, §8 il piano)

## Contesto

Il failure è osservato, non ipotizzato. L'owner, il 2026-09-03, sulla propria
installazione: **«non sembra di star parlando allo stesso muffin»**. Parlando dal
terminale, Muffin non sa niente di ciò che è stato detto nella DM Telegram, se
non quando gli capita di cercare in memoria. Un umano solo, un agente solo, una
cosa sola — due conversazioni.

La causa **non è un confine di sicurezza**, ed è il fatto che regge tutto il
resto di questa decisione. `identify` (`core/surface/types.ts`) risolve già la
DM Telegram dell'owner e il terminale allo stesso tenant `host`; un gruppo è già
un tenant diverso (`group:<connector>:<conversationId>`). Il recall è già
continuo dentro un tenant: `searchEpisodes` filtra su `tenant_id` e non ha mai
visto un id di sessione.

Ciò che separava le due porte era una **stringa scritta a mano in due
connector**, che nessuna regola condivisa produceva (memo §2.1):

| porta | id di sessione, prima |
|---|---|
| Telegram | `telegram:<chatId>`, una per chat, per sempre |
| Discord | `discord:<channelId>` |
| REPL | un id anonimo **per lancio**: `YYYY-MM-DD-<8 hex>` |
| CLI headless | usa e getta **per invocazione**: `run-<data>-<6 hex>` |

Conseguenza aritmetica: fra la chat privata Telegram dell'owner e il suo
terminale non esisteva **nessun** id condiviso, e fra due lanci del REPL nemmeno.
Con `MAX_HISTORY_TURNS = 40`, venti scambi di storia di là, venti di qua, zero
condivisi. L'unico ponte era un recall che si apre per somiglianza lessicale o
vettoriale — e «come dicevo prima» non somiglia a niente.

**ADR-0045 §1** dice che Muffin è un solo agente e che «CLI, chat, voce e device
sono porte […] nessuno di questi può possedere una persona, una memoria o una
policy separata», e il suo criterio di revisione dice, verbatim: *«la decisione
va rivista se … cambiare modello o superficie spezza identità, memoria, policy o
lavoro»*. Questo failure **è** quel criterio che scatta. Non serviva una
decisione nuova per giustificare il cambiamento; serviva applicare quella che
c'era, e registrare qui *dove* la regola vive adesso.

## Decisione

**La chiave di conversazione è una funzione dell'identità, calcolata dentro
`identify` e da nessun'altra parte.**

```
principal.kind === 'owner'  → 'owner'
principal.kind === 'member' → `${connector}:${conversationId}`   // invariato
```

### 1. La regola sta in un posto solo

`sessionKey` è un campo di `SurfaceIdentity` e viene calcolato **dentro**
`identify`, non da una funzione esportata accanto che un connector potrebbe non
chiamare. È lo stesso argomento che quel file porta già scritto su sé stesso per
il principal: *«una regola scritta una volta per connector è una regola che verrà
scritta diversamente una volta per connector»* — ed è esattamente com'era
successo per l'id di sessione.

`owner` **senza connector** è il punto: è l'unica stringa che due porte diverse
possono produrre.

### 2. I gruppi restano separati per costruzione, non per promemoria

Un `member` non produce mai `owner`, e l'owner che parla **dentro** un gruppo è
un `member` di quel tenant — la proprietà che
`connectors/telegram/impersonation.test.ts` sorveglia da quando il controllo
confrontava la stanza invece della persona. Il ramo `member` produce inoltre
**la stringa che i connector già usavano**, quindi per un gruppo non cambia
niente: nemmeno il nome del file di sessione.

### 3. Cosa **non** cambia, di proposito

- `cli/run.ts` continua ad aprire una sessione per invocazione. Il commento che
  ci sta sopra è una proprietà, non un incidente: *«a script run in a loop should
  not silently accumulate a conversation»*. Headless entra nella conversazione
  dell'owner solo con `--session owner`, esplicito.
- I job dello scheduler (`agent/scheduler-run.ts`) e le run di osservazione
  (`agent/observe-run.ts`) tengono i loro id. Un job non è l'owner che parla; il
  suo trascritto non è la conversazione.
- `replyTo.channel` e `replyChannel` restano `telegram:<chatId>` **pienamente
  qualificati**. Sono indirizzi di consegna, non identità di conversazione, ed è
  la loro separazione da questa chiave che impedisce a una risposta di uscire
  dalla porta sbagliata.

### 4. `/new` è una rotazione, non un id nuovo

Con una chiave condivisa, «una conversazione nuova» non può essere una chiave
diversa — sarebbe la conversazione di qualcun altro. Il REPL fa quindi ciò che
Telegram già faceva (`SessionStore.rotate`): il file di prima viene **archiviato
con la data**, mai cancellato, e la stessa chiave riparte vuota.

### 5. La finestra fusa dice da dove viene ogni riga

`buildContext` prefissa una riga reiniettata con `[<superficie>]` **solo quando**
la sua superficie non è quella del turno corrente. Non su ogni riga: una marca
che compare ovunque smette di essere letta, ed è la regola che
`core/memory/recall.ts` porta già scritta per `temporalLabel`.

Senza questa condizione la fusione sarebbe un peggioramento: una riga senza marca
è una riga di cui il modello non sa se è stata detta al telefono o scritta in un
terminale — la stessa classe di errore che `describeEpisodeSource` chiude per la
memoria, spostata dalla memoria al contesto.

### 6. Il soffitto, che è ciò che rende sicura una sessione fusa

Una pagina letta a tier 3 su Telegram arriva ora a un turno del terminale. Deve
arrivarci come **soffitto** (`snapshot.raiseCeiling(historyTaint(...))`) e non
come taint intrinseco: quel turno decide a quel tier — più ASK, che è corretto —
ma la sua risposta **non viene marcata** a quel tier (ADR-0044 §Riconciliazione
2026-08-28), quindi il costo invecchia fuori dalla finestra invece di
cricchettare per sempre.

Niente di questo è codice nuovo: il meccanismo esiste, ed era stato costruito per
un caso più difficile. È la ragione per cui questa decisione è piccola. Ma la
garanzia adesso è load-bearing attraverso un confine di porta, e per questo è
provata a parte (sotto).

## Conseguenze

**Osservabili, e dichiarate invece che scoperte:**

1. **Il piano aperto dell'owner diventa uno solo** attraverso le porte
   (`todos.open(tenant, session.id)`). È il comportamento che ADR-0045 §1 vuole —
   il lavoro non è posseduto da una porta. I todo legati agli id vecchi restano
   nel database e semplicemente non compaiono più: nessuna riga persa, nessuna
   query che fallisce.
2. **La prima conversazione dopo il cambio parte da un `owner.jsonl` vuoto.** Ciò
   che è stato detto prima resta nei file di sessione vecchi, che non vengono né
   spostati né cancellati, ed è **raggiungibile dal recall**, che non ha mai
   guardato l'id di sessione.

**Nessuna migrazione di schema**, e la fusione una-tantum dei vecchi file
dell'owner **non** viene fatta: è irreversibile in un modo che il resto di questa
decisione non è (memo §8.6). Resta possibile in seguito, e allora va fatta
archiviando gli originali con `rotate`, mai sovrascrivendoli.

**Concorrenza, e cosa non è protetto.** `append` usa `appendFileSync` (O_APPEND,
una riga per scrittura): niente corruzione, e `read` tollera già una coda
troncata. Quello che **non** è protetto: due turni vivi in parallelo leggono la
history all'inizio e non si vedono l'un l'altro. Oggi accade già fra due chat;
d'ora in poi può accadere fra due porte della stessa conversazione. Non è una
regressione di sicurezza — è una conversazione umana con due bocche — e il posto
dove semmai si affronta è ADR-0054 (`/stop`, `/steer`), non qui.

**ADR-0045** non viene riaperta: la sua §1 è la ragione di questa, e il suo
criterio di revisione ha fatto il suo lavoro. La sua Revisione 2026-08-17
(«il contesto legga l'evidenza con provenienza e tier, non un trascritto crudo»)
resta aperta e resta la direzione: questa decisione non la contraddice, la
prepara — dopo, c'è **una** finestra da rendere con provenienza invece di due.

## Come si falsifica

- `core/surface/types.test.ts` — la DM dell'owner su `telegram` e su `discord`
  produce la stessa chiave; un gruppo ne produce una diversa da quella
  dell'owner e da quella di un altro gruppo; l'owner *dentro* un gruppo prende la
  chiave del gruppo.
- `evals/acceptance/scenarios/b-una-conversazione.accept.ts`, sul binario vero:
  (a) ciò che è detto su Telegram è nella **finestra reiniettata** di un turno del
  terminale, marcato `[telegram]`, e non nell'ultimo messaggio utente dove
  viaggia il recall; (b) una lettura tier 2 su Telegram alza il **soffitto** di un
  turno del terminale (riga di `approvals` a taint 2) e **non** marca la risposta
  di quel turno, che resta `tier: 0`; (c) un messaggio di gruppo non finisce nella
  conversazione dell'owner, e viceversa.
- Mutazione che deve far tornare rossi (b) e (a): rendere `sessionKey`
  qualificata per connector anche per l'owner.

**Cosa farebbe rivedere questa decisione** (memo §7): se dopo una settimana di
dogfood gli ASK sul terminale causati dal soffitto ereditato da Telegram sono più
numerosi delle volte in cui la continuità è servita, la risposta giusta è
l'opzione **C** — una coda cross-superficie filtrata per tier, che una sessione
fusa non può fare perché è una sessione intera. Se la finestra da 40 messaggi
fusa taglia sistematicamente il filo della porta in uso: prima si misura, poi si
alza il letterale; se alzarlo non basta, di nuovo **C**. E se emergesse una
seconda persona sul tenant `host`, tutto il ragionamento sul tenant va rifatto.
