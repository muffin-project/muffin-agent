# Il turno sospendibile — istruttoria di B2, B3, B5

```
scritto: 2026-08-15
verificato: 2026-08-15
verificato-contro: origin/dev @ 82214d1 · Anthropic docs 2026-08-15 (Temporal, Hermes) · nessuna chiamata a pagamento
modello-strumenti: Opus 5 · repo clonato in worktree, letto; build e test NON eseguiti (istruttoria, non slice)
invaliderebbe: se `runTurn` acquisisse uno stato che non sia serializzabile in JSON — un handle, uno stream, un iteratore del provider. Oggi non ne ha nessuno (`agent/providers/types.ts:42-52`), ed è l'assunzione su cui poggia tutto il resto di questo file.
estende: docs/blueprint/adr/0035-il-gateway-vive.md §revisione 2026-08-14 · docs/blueprint/M5-BIS.md righe B2/B3/B5 · docs/blueprint/research/piano-eventi-workspace.md
```

**Etichette usate in tutto il file.** **misurato** = letto da me su questo
checkout, con `file:riga`, oggi. **riportato** = da una fonte che ho letto ma non
ho rieseguito (documento interno o pagina esterna, con la data). **folklore** =
né l'uno né l'altro: ragionamento o consuetudine, e lo dico.

Nessun codice di produzione è stato scritto. Nessuna chiave, nessuna chiamata a
pagamento.

---

## Bottom line

1. **La tesi regge per due terzi, e il terzo che cade è quello che cambia
   l'ordine di costruzione.** B3 (`wait`) e B5 (resume) *sono* la stessa
   proprietà. B2 (un turno lungo blocca il connettore) **non** richiede la
   sospendibilità: richiede una proprietà più debole e più profonda — che **un
   turno sia un record durevole con un'identità, e non un frame di stack**. La
   sospendibilità è uno *stato* su quel record; il resume è una *lettura* di quel
   record; e B2 ne consuma solo l'esistenza. Quindi non sono tre feature, ma non
   sono nemmeno una: sono **un substrato e due suoi consumatori**, e il substrato
   va costruito per primo perché tutti e tre lo vogliono.

2. **La correzione non è accademica: è la ragione per cui la direttiva
   dell'owner ha ragione.** La cura ovvia e economica per B2 — togliere l'`await`
   in `connectors/telegram/connector.ts:307` e lasciar correre il turno — è
   precisamente quella che rende B5 incostruibile senza rifare B2. Produce un
   turno **in volo e non registrato**, invisibile al drenaggio del gateway
   (`core/gateway/service.ts:295` aspetta solo `scheduler.isRunning()`), e
   rompe tre garanzie che oggi funzionano. Costruire "le tre righe separate" non
   dà tre meccanismi che non compongono: dà **una scorciatoia su B2 che rende
   caro tutto il resto**.

3. **Lo stato di un turno è già tutto serializzabile in JSON, e questo è il fatto
   che rende la cosa fattibile.** `Message[]` — inclusi i blocchi di *thinking*
   firmati che ADR-0037 obbliga a rimandare indietro verbatim — è un'unione di
   oggetti piatti (`agent/providers/types.ts:42-52`), e `compactToolResults`
   restituisce **una copia**, mai una mutazione (`agent/context/compact.ts:103-116`),
   quindi l'array in memoria del loop **è** il verbale completo del turno.
   Persistere quell'array è lossless. Non serve un tipo nuovo per il ragionamento.

4. **Il costo di migrazione della forma che raccomando è zero, e la finestra per
   sbagliarsi gratis si chiude il giorno 1 dei quattordici — non all'open
   source.** In questo repo **non esiste un migration runner**: ogni modulo
   esegue il proprio `db.exec(SCHEMA)` nel costruttore (dieci siti, §T1). Una
   **tabella nuova** si crea da sola su ogni installazione esistente, come hanno
   fatto `jobs`, `gateway_lock`, `spend` — quindi costa zero oggi e costerà zero
   sempre. Ciò che **non** costerà zero domani è cambiare la forma di una tabella
   che esiste già, e `episodes` è il caso peggiore: il `CHECK` a cinque valori su
   `kind` (`core/memory/schema.ts:34`) non si altera, quindi cambiarlo vuole una
   ricostruzione della tabella — con dentro una FTS5 a contenuto esterno e i suoi
   tre trigger (`schema.ts:52-60`) e, accanto, una tabella virtuale `vec0` di cui
   `AGENTS.md` registra che un `RENAME` abbandona le shadow table. **Non ci
   servirà**, e non perché la migrazione costa: perché lo stato di un turno è
   **stato mutabile** e un episodio è **evidenza monotòna**. Sono due cose diverse
   e vanno in due posti diversi anche su un database vuoto (§T2, che dichiara il
   costo per ciascuna delle tre forme possibili).

5. **C'è una scalata di privilegio latente in qualunque resume ingenuo, e va
   detta adesso.** Il taint vive **dentro la closure** di `makeSnapshot`
   (`agent/loop.ts:894-919`) e non è ricavabile da nient'altro. Il threat model
   dichiara che il taint sale in modo monotòno **dentro il turno** e riparte dal
   principal solo a messaggio nuovo (`03-threat-model.md:21`). Un turno che
   scarica una pagina web (tier 3), si sospende e riprende ricostruendo lo
   snapshot dal principal **riparte a tier 0**. È il pattern fetch-then-act che
   il kernel esiste per chiudere, riaperto da una porta nuova. Il taint è **stato
   del record**, non stato derivato.

6. **Non si può sospendere dentro una tool call, e questo non è un limite: è la
   decisione più importante del disegno.** Un handler è un `Promise` opaco
   (`agent/loop.ts:785`) e un `Promise` non si serializza. Ciò che si può fare è
   **abbandonarlo**, e abbandonare è sicuro solo per i tool che dichiarano di
   essere ri-eseguibili. E `reversible` — che esiste già
   (`core/policy/types.ts:74,83`) — **non è quel campo**: sono due assi
   indipendenti (§Domanda 5). Serve una seconda dichiarazione, e va messa dove
   sta già la prima, o si audita ogni tool e ogni server MCP fra sei mesi.

7. **Le tre cose che sarebbe più caro sbagliare** — in coda, §Domanda 6, con il
   motivo per cui sono quelle e non altre: **(a)** l'interfaccia dei tool (grana
   della sospensione + ri-eseguibilità dichiarata), perché ogni tool e ogni
   server MCP la incorpora; **(b)** dove vive il record (tabella nuova contro
   `.jsonl` di sessione), perché tutto ciò che riprende lo legge; **(c)** il
   pinning di modello e taint dentro il record, perché sbagliarli fallisce **in
   silenzio**, che è il modo di fallire documentato di questo repo.

---

# Parte I — la parte concettuale

## La tesi, verificata sul codice

La tesi dell'owner: *«B2, B3 e B5 non sono tre feature ma una proprietà sola —
un turno dev'essere sospendibile e ripristinabile»*.

L'ho attaccata dal lato più debole: **provare a soddisfare B2 senza
sospendibilità**, e vedere cosa costa.

### B2 si può chiudere senza sospendere niente — ed è la trappola

`connectors/telegram/connector.ts:307` fa `await runTurn(...)`, dentro
`handle()`, dentro un `for` su `inbox.pending()` (`:219`). La cura minima è
togliere l'`await`. Funziona: il connettore torna subito, il turno prosegue da
solo. E rompe tre cose, tutte **misurate**:

1. **La garanzia at-least-once dell'inbox si stacca.** `markProcessed` gira
   *dopo* che `handle` è tornato (`connector.ts:232`); se `handle` non aspetta
   più niente, o si marca troppo presto — e un crash perde il messaggio, che è
   esattamente la perdita di dati che l'inbox esiste per impedire
   (`connector.ts:26-27`) — oppure non si marca affatto, e il turno viene
   rieseguito da capo al riavvio, **tool call con effetti comprese**.
2. **Il turno diventa invisibile allo spegnimento.** `Gateway.drain` aspetta
   `this.deps.scheduler.isRunning()` e nient'altro
   (`core/gateway/service.ts:295, 298`). Un turno Telegram in volo non è un job:
   il drenaggio non lo vede, `SIGTERM` lo abbandona, e il gateway stampa
   *"esco comunque, il job resta dovuto"* di un job che non c'entra.
3. **Sparisce la corsia singola.** «Un owner, una corsia del modello — i job
   girano uno alla volta» è una proprietà scritta e tenuta dal booleano
   `running` dello scheduler (`core/scheduler/scheduler.ts:16-17, 104, 115`).
   Due messaggi Telegram ravvicinati diventerebbero due turni concorrenti sulla
   stessa corsia, che è ciò che il gate foreground di ADR-0022 §1 esiste per
   arbitrare.

Il punto: **ognuna di quelle tre riparazioni è "registra il turno da qualche
parte in modo durevole"**. Non è una coincidenza. È che B2 non chiede la
sospendibilità — chiede che un turno **esista come oggetto** invece che come
frame di stack di un `await`.

### B3 e B5 chiedono la stessa cosa, più uno stato

- **B3 (`wait`)**: sospendere = smettere di eseguire *senza perdere il posto*.
  Il posto è il record.
- **B5 (resume)**: riprendere = ricostruire il posto da disco. È lo stesso
  record, letto dopo una morte invece che dopo un'attesa.

Quindi la forma corretta della tesi, e la scrivo come la userei in un ADR:

> **Un turno è un record durevole con un'identità, non un frame di stack.** La
> sospensione è uno stato di quel record; il ripristino è la sua lettura; e un
> connettore che non blocca è semplicemente un connettore che **crea il record e
> torna**, invece di tenere il record sullo stack fino alla fine.

**Verdetto: la tesi non è demolita, è precisata — e la precisazione è utile,
perché fissa l'ordine.** Prima il record. Poi `wait` come stato. Poi il resume
come lettura. Chi costruisce nell'ordine inverso costruisce due volte.

### E una quarta riga cade dentro, non prevista dal mandato

**B11 (streaming)** — che l'owner ha trovato dopo che M5-BIS era stato scritto —
tocca la stessa superficie. `ChatCall.stream` è un campo **obbligatorio che
nessun adapter legge**: ogni sito di costruzione lo fissa a `false`
(`agent/loop.ts:402`, `core/memory/extract.ts:158`, `judge.ts:136`,
`rerank.ts:85`) e `AnthropicProvider.chat` non lo referenzia mai
(`agent/providers/anthropic.ts:42-110`). **misurato.** È la dodicesima istanza
di *dichiarato e non connesso*, ed è nello stesso confine che questo lavoro
riscrive. Non la istruisco qui — non è nel mandato — ma chi decide la forma del
turno decide anche se lo streaming ci entra, perché entrambi vivono sul bordo fra
`runTurn` e il provider.

---

## Domanda 1 — Cosa È un turno sospeso

### Dove vive oggi lo stato, e cosa si perde

Tutto lo stato di un turno vive in variabili locali di `runTurn`
(`agent/loop.ts:252-675`) e in una closure. **misurato**, riga per riga:

| Cosa | Dove sta oggi | Se il processo muore |
|---|---|---|
| `messages: Message[]` — il verbale del turno | `agent/loop.ts:326` | **perso** |
| taint corrente | closure di `makeSnapshot`, `agent/loop.ts:897` | **perso** |
| cache delle decisioni del kernel | stessa closure, `:898` | perso (irrilevante: è un memo) |
| `iterations` | `:348` | perso |
| `recoveriesUsed` | `:343` | perso |
| `transportRetriesLeft` | `:345` | perso |
| `toolCallsMade` | `:346` | perso |
| `nudgedForCompletion` | `:347` | perso |
| `usage` (4 contatori) | `:336` | perso |
| `spentUsd` | `:337` | perso (ma la spesa è già registrata, `:453`) |
| `exposed` (menu dei tool) | `:320` | perso — **ma ricalcolabile** |
| `currentEpisodeId` | `:271` | perso |
| identità (principal, tenant, surface, session, testo) | argomento `input` | perso |
| modello | `deps.model` | non è stato del turno **e questo è un problema** |

Quello che **è** su disco oggi:

- Il `.jsonl` di sessione riceve il messaggio dell'owner in testa
  (`:328`), i risultati dei tool man mano (`:787`) e **solo la risposta finale**
  dell'assistente (`:521`). **misurato.**
- L'episodio dell'owner in memoria, scritto prima di qualunque generazione
  (`:273`), esplicitamente perché *«un crash a metà turno non può perdere
  l'input che l'ha causato»*.

### Perché il `.jsonl` di sessione non è un punto di ripristino, e non lo diventa

La domanda del mandato — *«è già persistito: quanto ci manca?»* — ha una risposta
netta e sono **quattro** cose, tutte misurate:

1. **`SessionMessage.content` è una `string`** (`core/session/store.ts:23`).
   Un turno dell'assistente con tool call è un `ContentBlock[]`. Non c'è dove
   metterlo senza cambiare il tipo, e cambiarlo significa cambiare il formato di
   ogni file di sessione già scritto.
2. **I blocchi di *thinking* non ci arrivano mai.** Non sono in `SessionMessage`
   e non sono in nessuna `append`. ADR-0037 li chiama *Required* e documenta che
   perderli **non fa rumore** — il server li scarta o spegne il thinking, quindi
   il sintomo è «un agente un po' peggiore» e una cache più fredda, non un 400.
   Un ripristino dal `.jsonl` li perde tutti, in silenzio. **misurato** sul
   codice, **riportato** per la conseguenza lato API (ADR-0037 §1).
3. **I turni intermedi dell'assistente non ci sono affatto.** Solo la risposta
   finale viene appesa (`agent/loop.ts:521`). I `tool_result` invece ci sono
   (`:787`). Il file contiene quindi **risultati senza le chiamate che li hanno
   prodotti** — asimmetria misurata, e per il provider una richiesta con un
   `tool_result` senza il suo `tool_use` è malformata (`compact.ts:21-24`).
4. **Il lettore lo scarta comunque.** `buildContext` filtra a
   `user | assistant` (`agent/loop.ts:851`): i `tool_result` sul disco non
   vengono riletti da nessuno.

E c'è una ragione di disegno oltre a quelle tecniche, che vale più di tutte:
`store.ts:14-17` dichiara che quel file è *«il verbale grezzo di ciò che è stato
detto, da cui la memoria verrà costruita»*. È **evidenza**, e l'evidenza in
questo repo è append-only e monotòna. Lo stato di un turno è **mutabile** — il
taint sale, i contatori avanzano, lo stato passa da `waiting` a `runnable`.
Metterli nello stesso file significa trasformare il verbale in un log strutturato
da compattare, e conflare due cose che il repo tiene separate ovunque.

### Cosa deve sopravvivere, e cosa no

**Deve sopravvivere** (è stato, non si ricalcola):

- `messages` — intero, verbatim, thinking compreso.
- **taint** — vedi Bottom line §5: ricostruirlo dal principal è una scalata di
  privilegio.
- i contatori: `iterations`, `recoveriesUsed`, `transportRetriesLeft`,
  `toolCallsMade`, `nudgedForCompletion`, `usage`.
- l'identità: principal, tenant, surface, session id, testo originale, trace id,
  `currentEpisodeId`.
- **l'id del modello** — e questa è la riga che nessuno scriverebbe di suo.
  Un blocco `thinking` porta una `signature` (`agent/providers/types.ts:43`) che
  è **del modello che l'ha prodotta**. Un turno sospeso oggi e ripreso domani,
  dopo che l'owner ha cambiato `config.models.main`, rimanda indietro firme che
  il modello nuovo non può leggere. ADR-0037 dice cosa succede: modificati = 400
  rumoroso, scartati = silenzio. Qui sarebbe il silenzio. **Il record pinna il
  modello, e un resume su un modello diverso è un rifiuto esplicito, non un
  tentativo.**
- **dove va la risposta** — chat id e message id del segnaposto, per la
  Domanda 4.

**Non deve sopravvivere** (si ricalcola, ed è meglio così):

- `exposed`: `visibleTools(tools, principal, capabilities).slice(0, maxToolsExposed)`
  è deterministico dati principal e profilo (`agent/loop.ts:320`). Ricalcolarlo
  al resume è corretto **a patto che il profilo sia lo stesso**, ed è lo stesso
  se il modello è pinnato — il profilo si risolve dal modello.
- la cache delle decisioni: è un memo. Ricostruirla è anche più corretto, perché
  la matrice dei permessi potrebbe essere cambiata nel frattempo, e la direzione
  legittima di quel file è restringere (`core/policy/matrix.ts`, citato in
  `agent/tools/fs.ts:58-60`).
- lo span del tracer: si apre uno span nuovo, figlio dello stesso trace id.

**Raccomandazione**: il record è `(identità + modello + messages + taint +
contatori + indirizzo di risposta)`. Tutto JSON. Nessun tipo nuovo per il
ragionamento. Forma esatta in §T2.

---

## Domanda 2 — Dove si può sospendere

Tre posti, e solo due sono punti di sospensione. **misurato** sul flusso di
controllo di `agent/loop.ts`.

**1. Fra un'iterazione e l'altra** (in testa al `while`, `:351`). Pulito e
gratis: nessun `await` in volo, tutto lo stato è nelle variabili elencate sopra.
È anche dove già si controlla il budget (`:352`) e l'abort (`:355`).

**2. Fra una tool call e l'altra dentro la stessa iterazione** (`:569-591`).
Quasi pulito: c'è in più l'array parziale `results` e il turno dell'assistente
già spinto in `messages` (`:558`). Entrambi serializzabili. È già il punto dove
si controlla l'abort fra un tool e l'altro (`:574`), aggiunto perché *«un Ctrl+C
durante una serie di tool call non faceva niente di visibile fino alla fine del
lotto»*.

**3. Dentro una tool call** (`await tool.handler(...)`, `:785`) — **non è un
punto di sospensione, e non lo diventa.** Un handler è un `Promise` opaco. Non si
serializza un `Promise`. Le uniche due mosse sono: aspettarlo, oppure
**abbandonarlo**. E abbandonare è una scelta con un prezzo che dipende dal tool:

- `fs_read`, `fs_list`, `memory_search`, `skill_read`, `web_search`, `http_get`,
  `process_list` — dichiarati `reversible: 'yes'` (`agent/tools/*.ts`), e in
  pratica ri-eseguibili senza conseguenze.
- `fs_write` — `reversible: 'undoable'`, ma **ri-eseguirlo è innocuo**: scrivere
  gli stessi byte due volte dà lo stesso file.
- `shell_run`, `process_kill`, i tool MCP — `reversible: 'no'`, e **non
  ri-eseguibili**: un comando shell può aver mandato una mail, un `kill` può aver
  colpito un pid nel frattempo riusato.

**È qui che sta la trappola di disegno**, e la nomino perché è invisibile finché
non morde: **`reversible` non è ri-eseguibilità.** Sono due assi indipendenti.

| | reversibile | ri-eseguibile |
|---|---|---|
| `fs_write` (file intero) | no, serve un undo | **sì** — idempotente |
| mandare una mail | no | **no** — due mail |
| `fs_read` | n/a | sì |
| `process_kill` | no | no |

Un disegno che riusa `reversible` per decidere se ri-eseguire prende la decisione
sbagliata su `fs_write` (rifiuta un resume che sarebbe sicuro) e — molto peggio —
non ha niente da dire su un `outward.send` futuro se qualcuno lo dichiarasse
`undoable`. **Serve un secondo campo sulla dichiarazione di capability**, accanto
a `reversible`, e va messo lì perché è lì che il repo ha già deciso che queste
domande si rispondono *dichiarando accanto al tool* invece che scoprendo dopo
(`agent/loop.ts:142-150`, la stessa logica di `keepResult`).

### Il caso difficile che il mandato chiede: un `wait` mentre una tool call è in volo

**Non può succedere, e questa è la risposta — non un'evasione.**

`wait` è un tool: il modello lo chiama. Una tool call è il *turno del modello*,
quindi un `wait` emesso dal modello arriva **fra le iterazioni per costruzione**.
Il caso duro esiste solo se `wait` può arrivare **dall'esterno** — un
`muffin wait`, o l'equivalente di `/goal wait` di Hermes, o `steer` di ADR-0035.

E lì la risposta giusta è già scritta in due posti, uno esterno e uno nostro:

- **Hermes** (letto 2026-08-15, doc ufficiale): `/goal wait <pid>` fa che *"the
  loop **parks**: the next turns are skipped (no judge call, no continuation, no
  turn consumed) until the wait is satisfied"*. Non interrompe niente: **è una
  barriera sul giro successivo**. **riportato.**
- **ADR-0035** descrive `steer` come *«inietta dopo la prossima tool call, senza
  interrompere»*. È la stessa semantica, scritta prima e da noi.

Quindi: **un `wait` esterno alza un flag; la tool call in volo finisce; la
barriera si onora al prossimo punto di sospensione.** Nessuna interruzione,
nessun effetto a metà. E un `wait` esterno che *deve* fermare le cose subito non
è `wait`: è `abort`, che esiste già (`input.signal`, controllato a `:355` e
`:574`) e ha già la semantica giusta — il lavoro resta dovuto.

**Raccomandazione**: due punti di sospensione (fra iterazioni, fra tool call),
zero dentro una tool call, e un flag di barriera letto in entrambi. Chi vuole
fermarsi *ora* usa l'abort, che non promette di ricordare dov'era.

---

## Domanda 3 — `wait` come primitiva, non come `sleep`

La forma dichiarata dall'owner: `WAIT → persisti lo stato → rilascia
l'esecuzione → scheduler/evento → riprendi`. La sostengo, con tre precisazioni.

### Chi risveglia

**Lo scheduler che esiste già, con una seconda interrogazione sullo stesso
battito.** `Gateway.serve` arma un `setInterval` a `TICK_MS = HEARTBEAT_MS =
30_000` (`core/gateway/service.ts:57, 354`) e ogni battito chiama
`scheduler.tick(now)` (`:230`). `Scheduler.tick` prende **un** job dovuto
(`core/scheduler/scheduler.ts:112`) sotto il guardiano `running` (`:104, 115`).

Un turno sospeso **non è un job**, e non va rappresentato come tale:
`JobStore.markRan` ricalcola il prossimo fire da *ora* per la ricorrenza
(`core/scheduler/jobs.ts:192-199`) e `jobs.cron` è `NOT NULL` (`:24`). Un resume
è **una volta sola**. Forzarlo dentro `jobs` significherebbe un cron finto e un
`markRan` che fa la cosa sbagliata.

La forma giusta è più semplice e più onesta: **generalizzare la corsia**. Oggi
`Scheduler` è una corsia per job; diventa una **corsia per turni**, con tre
produttori — un job dovuto, un turno sospeso sveglio, un turno nuovo da una
surface — e lo stesso guardiano `running` che serializza tutti e tre. È il rework
che l'owner ha autorizzato, ed è dove il gate foreground di ADR-0022 §1 smette di
essere `ALWAYS_IDLE` per omissione (`cli/gateway.ts:318-321` lo dice già:
*«questa è la giuntura»*).

Granularità: 30 s è il battito. Un `wait` non è mai più preciso di così. Va
detto, perché *«aspetta 5 secondi»* diventerebbe 30, e la risposta corretta non è
abbassare il battito — è che **un `wait` sotto il minuto non è un `wait`**, è un
`sleep` dentro un tool, e va rifiutato al confine.

### Cosa impedisce la perdita permanente

**Una scadenza obbligatoria. Non opzionale.** È la stessa conclusione a cui il
repo è già arrivato due volte, per il trigger a predicato:

> *«un job si spegne **solo se qualcuno lo toglie a mano**, quindi ogni richiesta
> a termine lascia dietro di sé un job che nessuno disarmerà — e il modo in cui
> te ne accorgi è che continua ad arrivarti»* (`confronto-gemini.md §15`, e
> `12-casi-uso-primitive.md:75-84`, che la mette *nella stessa slice*).
> **riportato.**

Applicata a `wait`, la regola diventa più stretta, non uguale: un job senza stop
continua a *arrivarti*, quindi te ne accorgi. **Un turno sospeso senza scadenza è
silenzioso**: occupa una riga, tiene il suo contesto, e non lo sapresti mai. È il
peggiore dei due.

Quindi tre condizioni di stop, e le voglio tutte e tre:

1. **`wakeAt` obbligatorio** — nessun `wait` senza deadline. La scadenza è un
   argomento del tool, validato al confine, con un tetto (un `wait` di sei mesi è
   un errore di battitura, non un'intenzione).
2. **La scadenza sveglia il turno con un risultato, non con un errore.** Il
   modello riceve un `tool_result` che dice *«l'attesa è scaduta senza che
   l'evento arrivasse»* e decide lui. Un timeout che uccide il turno in silenzio
   ricrea il problema che stiamo chiudendo.
3. **Un tetto ai turni sospesi per tenant**, oltre il quale `wait` viene rifiutato
   dal kernel come qualunque altra capability. Senza, un modello che ama `wait`
   produce righe senza fondo, e nessuno guarda una tabella.

### E il costo che nessuno conta: un `wait` non è gratis

**folklore fino a misura**, ma il meccanismo è certo. Un turno sospeso non
consuma token *mentre aspetta*. Ma **ogni resume rimanda l'intero contesto**: il
prefisso stabile (identità, tool) più tutto `messages`. Il prefisso è cacheabile
(`agent/loop.ts:376`, `cache: 'stable'`), ma una cache di prompt ha un TTL
dell'ordine dei minuti — quindi **un `wait` più lungo del TTL paga il prezzo
pieno di scrittura della cache a ogni risveglio**.

Conseguenza pratica: un turno che aspetta dieci volte costa dieci prefissi. È
esattamente il tipo di spesa che ADR-0035 §revisione punto 2 dice di contare **per
job e fuori dal turno**, e quel budget per-job non esiste (`M5-BIS.md` riga E1:
BLOCKER). **`wait` e il budget per-turno vanno nella stessa slice**, o si
costruisce la primitiva che sa spendere di notte prima del contatore che lo
limita.

---

## Domanda 4 — Accetta subito, consegna dopo (~500 ms)

Il criterio d'uscita è di ADR-0035 §revisione: *«un turno lungo restituisce entro
~500 ms e consegna dopo, senza che nessuno resti a guardare i puntini»*, e la
forma del messaggio è già decisa lì: **segnaposto poi `editMessageText`, un
messaggio invece di due**.

### Cosa cambia nel connettore

Oggi `handle()` (`connectors/telegram/connector.ts:290-331`) fa, in ordine:
avvia la presenza, ingerisce l'allegato, **aspetta il turno**, rende, edita o
manda, ferma la presenza. E `drain()` marca l'update come processato solo dopo
(`:232`).

La forma nuova, e non è una patch:

1. `handle()` crea il **record di turno**, con dentro l'indirizzo di risposta —
   `chatId` e il `message_id` del segnaposto.
2. Il segnaposto si manda **sempre**, non solo nei gruppi. Oggi in privato c'è il
   draft effimero (`connectors/telegram/presence.ts:80`) e `editMessageId` resta
   `undefined` (`presence.ts:75-89`), quindi la risposta finale è un messaggio
   nuovo. Per l'ACK serve un messaggio **vero** da editare, o non c'è niente su
   cui consegnare dopo. Il draft effimero resta dov'è, come dice l'ADR — ma
   l'oggetto della modifica dev'essere durevole.
3. `markProcessed(updateId)` **e** l'inserimento del record avvengono nella
   **stessa transazione SQLite**. È il trasferimento di una garanzia, non la sua
   rimozione: l'at-least-once passa dall'inbox al record. `better-sqlite3` è
   sincrono e il repo usa già `BEGIN IMMEDIATE` per rendere atomico un
   check-then-act (`core/lock/durable.ts:142`).
4. `handle()` torna. La corsia esegue.

### La presenza cambia di natura

Il keepalive esiste perché il turno era sincrono: rinnovare un draft ogni 22 s e
un `sendChatAction` ogni 4 s (`presence.ts:26-27, 73, 81`) serve a coprire
un'attesa. Con l'ACK, l'attesa non è più sotto la finestra del connettore: **il
segnaposto è il messaggio, e va aggiornato dalla corsia**, non da un timer del
connettore. Va detto perché altrimenti restano due meccanismi che dicono la
stessa cosa a ritmi diversi — e `presence.ts:14-18` racconta già la storia del
vecchio Muffin che tolse il keepalive e lo rimise due settimane dopo.

#### Fatto il 2026-09-04, e cosa resta aperto

Questa sezione prevedeva il difetto prima che fosse misurato: il 2026-09-04 il
gateway ha ricevuto un SIGTERM a metà turno, il draft (mai rinnovato dopo che
`silenceHeartbeats()` lo spegneva proprio all'inizio dello streaming) è scaduto
da solo, e la risposta vera è arrivata tre minuti e cinquanta secondi dopo dal
processo ripreso — «scritto, poi cancellato, poi riscritto», nelle parole
dell'owner.

La correzione applicata prende la direzione di questa sezione — **un
segnaposto materializzato come messaggio vero, mai un timer che deve reggere
una promessa che sopravvive al processo** — ma non l'intera Domanda 4. Non
c'è ancora un ACK sincrono (`handle()` continua a chiamare il modello nello
stesso processo, non torna entro ~500 ms), non c'è un `editMessageId` scritto
sul record durevole del turno, e la corsia (`agent/turn-lane.ts`) non possiede
ancora l'indirizzo del segnaposto — resta una struttura in memoria sul
connettore (`TelegramConnector#transcriptHandoff`), non una colonna. Quella è
la Domanda 4 intera: un cambio di forma del turno (accetta-poi-consegna),
fuori misura per una fetta che doveva chiudere due difetti misurati, non
riprogettare come i turni Telegram vengono creati.

Quello che *è* cambiato, dentro i confini di `connectors/telegram/`:

- **`presence.ts` non manda più `sendMessageDraft`.** È rimasto solo il
  battito `sendChatAction` (`presence.ts`, riscritto da zero — non ha più un
  timer di rinnovo da poter dimenticare di far ripartire, perché non ha più
  niente di effimero da rinnovare).
- **`transcript.ts` guadagna `live()`**: la stessa DAY-1 B11 ("la risposta
  come si forma"), ma scritta nello stesso messaggio reale e durevole in cui
  già vivono i passi dei tool — mai un secondo canale. Un messaggio vero non
  scade: un processo che muore lo lascia esattamente com'era, invece di
  farlo sparire. Solo in chat private, stesso perimetro che il draft aveva
  sempre avuto.
- **`transcript.ts` guadagna `handoff()`**, e `connector.ts#deliverTo` lo usa
  per **editare** il messaggio della trascrizione con la risposta finale
  invece di mandarne uno a parte — questo chiude anche l'*altro* dei due
  difetti misurati (le due bolle: `docs/evidence/dogfood-superfici-2026-09-03.md`
  aveva introdotto un messaggio persistente per i passi apposta, ma senza
  fonderlo con la risposta finale un turno con tool restava comunque due
  messaggi). La scrittura resta attraverso `TelegramDeliveryStore`/
  `deliverTelegram`, lo stesso ledger durevole già scritto-prima-dell'effetto
  di ogni altra consegna — **non** un secondo canale non tracciato.

Il gap residuo che questa forma accetta, esplicitamente: `transcriptHandoff`
vive solo in memoria per la durata del processo. Un crash fra la chiusura
della trascrizione e la chiamata a `deliverTo` (finestra strettissima, niente
I/O in mezzo) perde la fusione — la risposta arriva comunque, ma come
messaggio a parte anziché come edit. È lo stesso genere di degradazione
accettata già in uso per `transcriptInSospeso` poche righe più giù nel
codice: mai una risposta persa, nel peggiore dei casi un messaggio in più —
mai peggio di prima di questa correzione.

### Il vincolo che non va rotto, e come si traduce

> `markRan` avanza **anche su consegna fallita, di proposito**: *«un fallimento
> di consegna non rifà girare il job (raddoppierebbe il lavoro), viene
> riportato»* (`core/scheduler/scheduler.ts:166-171`). **misurato.**

Tradotto sul record di turno: **un turno la cui consegna è fallita non torna
`runnable`.** Il turno è finito; è la *consegna* che è fallita. Quindi servono
**due esiti distinti sul record** — come è andato il turno, e come è andata la
consegna — e non uno solo. Fonderli è la strada più corta per rieseguire un turno
perché Telegram ha dato 429, che è precisamente il raddoppio che quella riga di
scheduler esiste per impedire.

E la seconda metà dello stesso vincolo, che vale di più adesso: ADR-0035 §1 dice
che una morte del gateway **non perde lavoro** perché *«`markRan` è l'unica cosa
che sposta il prossimo fire»*. Sul record di turno la proprietà equivalente è:
**una sola scrittura fa avanzare lo stato**, e quella scrittura viene dopo la
consegna. Chi aggiunge una seconda scrittura che avanza lo stato ha rotto la
garanzia senza toccare la riga che la dichiara.

---

## Domanda 5 — Resume dopo la morte del processo

### La distinzione onesta: contesto contro effetti

**Il contesto di un turno si ripristina senza perdite. Gli effetti no — di loro
si può solo sapere cosa è stato registrato.** Questa frase è tutto il contenuto
della domanda, e ogni sistema serio del campo dice la stessa cosa con parole
proprie.

**Temporal** (letto 2026-08-15, **riportato**) separa i due piani in modo
esplicito: il codice di workflow dev'essere **deterministico** — *"they have to
make the same decisions when given the same history"* — e tutto ciò che tocca il
mondo esterno vive in **Activity**, *"functions that handle everything that
interacts with the outside world: API calls, database queries, LLM invocations,
file I/O"*. La garanzia sul replay: *"When a Workflow calls an Activity, the
Activity runs once, its result is recorded in the Event History. During replay,
that result is reused, not recomputed."* E la parte che vale ancora di più per
noi, dalla loro stessa documentazione: le Activity restano **at-least-once** a
meno che non si aggiunga idempotenza — l'exactly-once arriva solo da una
deduplicazione esplicita.

**Perché ci interessa**, e non è la scala: la loro divisione fra codice
deterministico e Activity **è già la nostra divisione fra il loop e le tool
call**. Il loop di `agent/loop.ts` è deterministico dato `messages` — compattare,
scegliere i tool, contare le iterazioni, decidere con il kernel: tutto pure. Le
tool call sono le Activity. Non dobbiamo importare la loro macchina; dobbiamo
riconoscere che il confine ce l'abbiamo già e smettere di attraversarlo senza
registrare.

E l'avvertimento sta in casa: `confronto-harness.md §2.3` (**riportato**) nota
che il resume di OpenHands ha richiesto un meccanismo di riparazione dedicato —
`get_unmatched_actions()` per i tool-call orfani dopo un crash — e ne trae la
lezione giusta: *«la resumabilità compra anche una superficie di correttezza
nuova»*. Non è gratis. È una classe di bug in più in cambio di una classe di
perdita in meno.

### Come si distingue «fatta» da «forse fatta»

Oggi **non si distingue**, e va detto forte. Il risultato del tool viene appeso
al `.jsonl` *dopo* che l'handler è tornato (`agent/loop.ts:787`) — è una
registrazione **a posteriori** e basta. Non esiste da nessuna parte un record che
dica *«sto per chiamare `shell_run` con questi argomenti»*. Quindi, dopo un
crash, un'invocazione partita e non conclusa non lascia **nessuna traccia**.

Peggio, e questo è il difetto vivo oggi, non una preoccupazione futura:
**misurato** su `connector.ts:230-239` — se il processo muore dentro `handle()`,
l'update resta pending, e al riavvio `drain()` **rifà il turno da capo**. Il che
significa: riscrivere l'episodio dell'owner in memoria (`loop.ts:273`), riappendere
il messaggio al `.jsonl` (`:328`), **e rieseguire ogni tool call con i suoi
effetti**. Non c'è un `wait` in giro, non c'è un resume: è la semantica di oggi.

Il rimedio è un **record in due fasi attorno a ogni tool call**, e sono tre stati
leggibili:

| Intento | Esito | Lettura | Cosa fa il resume |
|---|---|---|---|
| sì | sì | **fatta** | non rieseguire; rimetti il risultato registrato in `messages` |
| sì | no | **forse fatta** | dipende dalla dichiarazione del tool (sotto) |
| no | no | non iniziata | esegui |

E per «forse fatta», due comportamenti e nessun terzo:

- tool **dichiarato ri-eseguibile** → rieseguilo.
- tool **non** dichiarato ri-eseguibile → **non rieseguirlo**, e riprendi il
  turno con un `tool_result` che dice *«questa chiamata potrebbe essere stata
  eseguita: non posso saperlo»*. Il modello lo gestisce come gestisce già un
  rifiuto del kernel. Questa è la forma che questo repo usa ovunque: dire la
  verità al modello invece di indovinare per lui (`loop.ts:740`, `:754`, e
  `connector.ts:365` — *«Dillo, non fingere di averlo»*).

### La finestra che resta, dichiarata

**Fra l'effetto che atterra nel mondo e la riga di esito che si committa c'è una
finestra irriducibile.** Nessun disegno la chiude senza una transazione
distribuita con il mondo esterno, che non abbiamo e non vogliamo. Temporal ha la
stessa finestra e la risposta è la stessa: le Activity dovrebbero essere
idempotenti. La nostra versione della frase: **un tool con effetti non idempotenti
va dichiarato tale, e un resume su una sua chiamata incerta non indovina.**

Va scritto in questi termini e non promesso meglio, perché la promessa migliore è
quella che nessuno può mantenere e che qualcuno più tardi crederà.

---

## Domanda 6 — Il costo di sbagliare adesso

Il criterio che ha ordinato questo lavoro. Per ogni scelta, cosa si riscrive fra
sei mesi se oggi si sceglie male.

| # | Scelta | Se sbagliata, cosa si riscrive | Costo |
|---|---|---|---|
| 1 | **Grana della sospensione** (dentro o fuori una tool call) | Se si permette la sospensione *dentro* un handler, ogni tool diventa una macchina a stati con continuazione. Disfarlo = riscrivere ogni tool, ogni tool MCP, e il contratto verso server che non controlliamo | **altissimo** |
| 2 | **Ri-eseguibilità dichiarata sul tool** | Se non c'è, il resume deve assumere il peggio (inutile) o il meglio (il bug del doppio effetto). Aggiungerla dopo = audit di ogni tool, MCP compresi | **altissimo** |
| 3 | **Dove vive il record** (tabella nuova contro `.jsonl`) | Sul `.jsonl`: si perde il thinking in silenzio, si conflà evidenza e stato, e la correzione è comunque un secondo store più la migrazione di ogni file di sessione | **alto** |
| 4 | **Pinning di modello e taint nel record** | Senza: firme di thinking a un modello sbagliato (degrado silenzioso) e taint che riparte da zero (scalata di privilegio silenziosa). Costa una riga oggi; è invisibile per mesi | **alto perché silenzioso** |
| 5 | **Due esiti distinti** (turno / consegna) | Fonderli fa rieseguire un turno per un 429 di Telegram. Separarli dopo = rileggere ogni riga già scritta e non sapere quale delle due cose descriveva | **medio** |
| 6 | **`wakeAt` obbligatorio** | Se opzionale, si spediscono turni sospesi per sempre, e la cura è una migrazione dati su righe che non hanno una scadenza da cui derivarla | **medio** |
| 7 | **Una sola corsia** (turni e job) | Due corsie separate = due punti che arbitrano il modello, e il repo ha già la regola: due punti che fanno lo stesso lavoro divergono (`core/lock/durable.ts:17-18`) | **medio** |
| 8 | **Blob JSON contro colonne** | Se serve interrogare «quali turni hanno toccato la capability X», si aggiungono colonne indicizzate accanto al blob. Additivo | **basso** |
| 9 | **Un arm nuovo su `TurnResult.stopped`** | Tre siti fanno switch e uno **duplica l'unione invece di riferirla** (`core/scheduler/scheduler.ts:45`). Aggiungere senza unificare fa divergere la copia | **basso, ma è il difetto tipico di questo repo** |

### Le tre più care, e perché quelle

**(a) L'interfaccia dei tool — righe 1 e 2 insieme.** Sono l'unica scelta di
questa lista che **esce dal nostro repo**: un server MCP di terze parti la
incorpora, e il giorno in cui ce ne sono cinque attaccati non si cambia più. È
letteralmente la definizione di irreversibile che la direttiva dell'owner nomina.

**(b) Dove vive il record.** Non perché sia difficile spostarlo, ma perché tutto
ciò che riprende lo legge, e il posto sbagliato (il `.jsonl`) perde i blocchi di
thinking **senza dirlo** — quindi non si scopre da un errore, si scopre da un
agente peggiore di cui nessuno sa il motivo.

**(c) Modello e taint dentro il record.** Costano una colonna ciascuno oggi.
Sbagliati, falliscono in silenzio, e il silenzio è il modo di fallire che questo
repo documenta come proprio: *«un meccanismo che continua a sembrare a posto»*
(ADR-0037, decisione 2). Il taint in particolare non è un degrado ma una
**riapertura del pattern fetch-then-act** che il kernel esiste per chiudere.

---

## La forma che raccomando

Tre pezzi, in quest'ordine. Non è la modifica più piccola che funziona: è la
forma, col suo costo dichiarato.

**1. `runTurn` diventa una funzione di passo sopra un record.** Non
retrocompatibile, e non ho progettato intorno a una compatibilità che nessuno
chiede. Oggi la firma è
`runTurn(deps, input) => Promise<TurnResult>` (`agent/loop.ts:252`); diventa
`createTurn(deps, input) => TurnId` più `step(deps, id) => Promise<Disposition>`,
dove `Disposition` è `{done, text} | {suspended, wakeAt} | {ask, request}`.
Sopra ci sta un driver sincrono `drainTurn(deps, id)` che cicla `step` fino a
`done` — **e quello è il percorso che `muffin run` e gli eval tengono
identico** (`cli/run.ts:65`, `evals/floor/run.ts:107`), perché ADR-0021 vuole un
percorso scriptabile che esce con un codice. Le due forme non sono un compromesso:
sono lo stesso motore letto da due chiamanti diversi.

**2. Una tabella `turns`, e il costo di migrazione è zero — oggi e sempre.**
Detto per esteso perché era una domanda esplicita: in questo repo non c'è un
migration runner — ogni store esegue il proprio `db.exec(SCHEMA)` nel
costruttore, verificato su dieci siti (§T1). `CREATE TABLE IF NOT EXISTS` **crea**
la tabella su un database già installato; è `ALTER` che non si può fare, ed è il
`CHECK` che non si può cambiare. Quindi una tabella nuova costa quanto è costata
`jobs`, `spend`, `gateway_lock`: niente, e continuerà a costare niente anche il
giorno in cui il database dell'owner è pieno.

**E non tocchiamo `episodes` — ma non perché la migrazione costa.** Va detto in
chiaro invece che aggirato: oggi la finestra per cambiare uno schema è aperta (il
database dell'owner ha quattro giorni di prove, non uso reale), quindi
«costerebbe una migrazione» **non è più un argomento** e non lo uso come tale.
L'argomento è di disegno e regge su un database vuoto esattamente come su uno
pieno: un episodio è evidenza, monotòna e mai riscritta (`AGENTS.md`, *«non
cancellare mai righe»*); lo stato di un turno cambia a ogni passo — il taint sale,
i contatori avanzano, lo stato passa da `waiting` a `runnable`. Metterli insieme
significa dover distinguere, in lettura, le righe che raccontano cosa è successo
da quelle che dicono cosa sta succedendo. Se un giorno servisse comunque un
*episodio* di tipo nuovo, la strada è `episodes.connector`, che è testo libero, e
**non** `episodes.kind`, il cui `CHECK` non si altera (§T2).

**E la finestra si chiude prima di quanto sembri.** Il momento in cui questi dati
diventano preziosi non è l'open source: è il **giorno 1 dei quattordici** del Gate
1, perché da lì in poi ogni giorno perso è un giorno che l'owner deve rifare.
Qualunque cambio di forma su una tabella esistente va deciso **prima** di quel
giorno, non dopo — ed è una ragione in più per prendere adesso le decisioni
irreversibili della §Domanda 6, che è precisamente il criterio che ha ordinato
questo lavoro.

**3. La corsia si generalizza da job a turni.** `Scheduler` mantiene il suo
guardiano `running` e le tre proprietà di ADR-0022 che già tiene, e prende tre
produttori invece di uno. È qui che il `ForegroundGate` smette di essere
`ALWAYS_IDLE` per omissione, e la giuntura è già nominata nel codice
(`cli/gateway.ts:318-321`).

**Cosa NON cambia, e va detto**: la cascata di recovery, il gate di completamento,
`compactToolResults`, il kernel, la forma delle capability. Sono tutti per-passo
e puri; il record li rende ripetibili senza modificarli.

**Cosa è piccolo, sicuro e ovviamente giusto — e non ho costruito, perché decide
l'owner** (stima mia, **folklore** finché non si esegue):

- Pinnare `model` nel record e rifiutare un resume su modello diverso: ~15 righe
  più un test. È il punto 4 della tabella dei costi, quello silenzioso.
- Il secondo campo di ri-eseguibilità su `CapabilityDecl`: ~10 righe di tipo più
  una riga per capability esistente (undici), più il test che fallisce se un tool
  nuovo non la dichiara.
- `wakeAt` obbligatorio nella firma di `wait`: è un campo, non un meccanismo.

---

## Alternative scartate

- **Un `worker_thread` per il turno lungo** (ADR-0022 §2 lo prevede per il
  batch). Non risolve niente qui: un thread muore col processo esattamente come
  lo stack. Il problema non è dove gira il turno, è che non è scritto da nessuna
  parte.
- **Un event bus (Redis/NATS) per la sveglia.** Già respinto con motivazione
  esplicita in `confronto-gemini.md §15`: *«pagheremmo un broker e una classe di
  guasti nuova per coordinare processi che abbiamo deciso di non avere»*. E qui
  non serve nemmeno per la ragione più semplice: il consumatore è uno.
- **Rappresentare un turno sospeso come un job.** `jobs.cron` è `NOT NULL`
  (`core/scheduler/jobs.ts:24`) e `markRan` ricalcola una ricorrenza
  (`:192-199`). Un resume è una volta sola. Sarebbe un cron finto più un `markRan`
  che fa la cosa sbagliata.
- **Estendere il `.jsonl` di sessione a punto di ripristino.** Quattro difetti
  misurati in §Domanda 1, e uno di disegno che vale più dei quattro: quel file è
  evidenza monotòna, lo stato di un turno è mutabile. **Non** l'ho scartata per
  il costo di cambiare il formato: quel costo oggi è quasi nullo (i file di
  sessione esistenti sono di quattro giorni di prove) e usarlo come argomento
  sarebbe stato disonesto. Se un giorno si volesse comunque, il costo vero è
  scritto in §T2.
- **Registrare un event log completo alla OpenHands e ricostruire per replay.**
  È più potente e costa una superficie di correttezza nuova
  (`confronto-harness.md §2.3`, **riportato**). Il nostro caso è un turno, non un
  workflow di ore: lo snapshot del `messages` è più semplice e non ha orfani da
  riparare, perché non ricostruisce — rilegge.
- **Sospendere dentro una tool call** (handler che restituiscono una
  continuazione). Riga 1 della tabella dei costi. È l'unica scelta di questo
  documento che direi di non riaprire nemmeno con evidenza nuova, finché
  l'evidenza non riguarda i server MCP.

---

## Come lo fanno gli altri, e perché ci interessa

**Hermes — `/goal wait`** (doc ufficiale, letto 2026-08-15, **riportato**).
`/goal wait <pid>` *"Manually park the loop until the process with that PID
exits"*; il barrier *"releases when the process with that PID exits"*; e
`/goal unwait` *"Clear any wait barrier (judge- or manually-set) and resume
immediately"*. Lo stato del goal *"lives in `SessionDB.state_meta` keyed by
`goal:<session_id>`"*, e *"set a goal, close your laptop, come back tomorrow,
`/resume`, and the goal is still standing exactly as you left it"*.

**Perché ci interessa — tre cose, e una è una correzione al mandato.** (i) La
loro attesa è **fra i turni, non dentro**: conferma dall'esterno la scelta della
Domanda 2. (ii) Il predicato di sveglia è **concreto e verificabile** (un pid che
esce), non «quando succede qualcosa»: è la stessa disciplina dell'insieme chiuso
di ADR-0028. (iii) **E il loro `wait` non è ciò che stiamo costruendo**: parcheggia
il *ciclo di continuazione del goal*, che sta un livello **sopra** il turno.
Il turno singolo di Hermes non si sospende; il loro `/goal pause` a budget esaurito
lo dimostra. Quindi la loro implementazione non è un modello da copiare — è la
prova che il livello del goal e il livello del turno sono separabili, e che loro
hanno risolto solo il primo.

**Temporal — durable execution** (doc ufficiale, letto 2026-08-15,
**riportato**). Event History = *"a complete, ordered log of everything that has
already happened in a Workflow"*, sorgente di verità; replay = ripartire
dall'inizio e *"use that history to guide the code back to the exact state as
before"*; determinismo = il workflow *"shouldn't depend on any values not
recorded in the history"*, e violano `Date.now()`, i numeri casuali, le chiamate
di rete non registrate.

**Perché ci interessa, e perché la loro scala non è un'obiezione.** Non ci serve
il replay: il nostro stato sta in un array che possiamo scrivere per intero, e uno
snapshot è più semplice e non ha vincoli di determinismo sul codice. Ci serve
**la loro divisione**, che è già la nostra e non l'avevamo nominata: codice
deterministico da una parte (il loop), interazioni col mondo dall'altra (le tool
call). E ci serve la loro onestà sul residuo: **at-least-once salvo idempotenza
esplicita**. Chi promette exactly-once su un effetto esterno sta promettendo una
cosa che Temporal, con dieci anni e un cluster, non promette.

**I peer già misurati in casa** (`b1-runtime-processo.md`, verificato da sorgente
il 2026-08-04, **riportato**): Hermes fa *restart da zero*, non resume — il worker
nuovo rilegge tutto il contesto via `kanban_show()`, nessun checkpoint intermedio;
Odysseus recupera **solo all'avvio**, marcando `aborted` (non `error`) le righe
rimaste `running`, per non incolpare il task di un evento infrastrutturale.
Nessuno dei sei sistemi esaminati ha un resume a grana di turno. **Ci interessa
come calibrazione**: se lo costruiamo, siamo davanti, e la parte davanti è quella
che nessuno ha ancora pagato in bug.

---

# Parte II — technical notes (English, STE)

All line numbers are from `origin/dev` @ `82214d1`, read on 2026-08-15.

## T1. Verified state of the mechanisms

| Mechanism | File:line | State |
|---|---|---|
| Turn state lives in local variables | `agent/loop.ts:326-348` | 9 variables plus one closure. Nothing is persisted |
| Taint lives in a closure | `agent/loop.ts:894-919` | Not derivable from any other value |
| Turn transcript is a copy, never mutated | `agent/context/compact.ts:103-116` | The caller's array stays the full record |
| Thinking blocks are plain JSON | `agent/providers/types.ts:42-50` | `{type,thinking,signature}` or `{type,data}`. Serializable |
| Thinking blocks re-sent by spread | `agent/loop.ts:558-565` | Never mapped, never filtered |
| Session store holds strings only | `core/session/store.ts:23` | `content: string`. No block array |
| Session store gets the final answer only | `agent/loop.ts:521` | Intermediate assistant turns are not written |
| Session store gets tool results | `agent/loop.ts:787` | Written after the handler returns. Write-behind only |
| History reader drops tool rows | `agent/loop.ts:851` | Filters to `user \| assistant` |
| Telegram blocks its own drain | `connectors/telegram/connector.ts:219, 231, 232` | Serial. `markProcessed` after `handle` returns |
| Telegram passes no abort signal | `connectors/telegram/connector.ts:307-315` | The only production caller without one |
| Gateway drain sees jobs only | `core/gateway/service.ts:295, 298` | `scheduler.isRunning()` is the whole test |
| Gateway hosts the connector | `cli/gateway.ts:359` → `cli/surface.ts:209, 251` | Same process |
| Scheduler serializes one run | `core/scheduler/scheduler.ts:104, 112, 115` | One job per tick, `running` guard |
| Tick equals heartbeat | `core/gateway/service.ts:57` | `TICK_MS = HEARTBEAT_MS` = 30 000 ms |
| `markRan` advances on failed delivery | `core/scheduler/scheduler.ts:166-171, 183` | Deliberate. Do not re-run |
| Jobs are recurring by construction | `core/scheduler/jobs.ts:24, 192-199` | `cron NOT NULL`; `markRan` recomputes |
| No migration runner exists | 10 sites, §T2 | Each store runs `db.exec(SCHEMA)` in its constructor |
| `episodes.kind` carries a CHECK | `core/memory/schema.ts:34` | 5 values. SQLite cannot alter a CHECK |
| Reversibility is declared | `core/policy/types.ts:74, 83` | `'yes' \| 'undoable' \| 'no'` |
| Re-runnability is not declared | — | No field, no equivalent, anywhere |
| `stream` is declared and unread | `agent/providers/types.ts:107` | Every site hardcodes `false`. No adapter reads it |
| `TurnResult.stopped` union is duplicated | `agent/loop.ts:246` and `core/scheduler/scheduler.ts:45` | Two literal unions, not one reference |
| Nothing named wait/todo/suspend/resume/checkpoint exists | — | Verified across `agent/`, `core/`, `cli/`, `connectors/` |

## T2. The turn record — proposed shape, and the migration cost

The migration cost of the recommended form is **zero**, today and later. This
repo has no migration runner. Each store runs its own `db.exec(SCHEMA)` in its
constructor. The ten sites are:
`core/memory/store.ts:126`, `core/memory/vectors.ts:41`,
`core/memory/consolidator.ts:339`, `core/scheduler/jobs.ts:131`,
`core/scheduler/firelog.ts:61`, `core/budget/budget.ts:77`,
`connectors/telegram/updates.ts:66`, and three through `DurableLock`
(`core/lock/durable.ts:110`) for `send_lock`, `ingest_lock` and `gateway_lock`.

`CREATE TABLE IF NOT EXISTS` creates a **new** table on an installed database.
What it cannot do is change an existing one. Adding a column needs the manual
`ALTER TABLE` pattern (`core/memory/store.ts:153-156`). Changing a `CHECK` is
impossible in SQLite. A new table meets none of those limits.

**Cost of each candidate form, on the day the data exists.** The schema window
is open now: the owner's database holds four days of onboarding trials, not real
use. This table therefore states the future cost, not today's.

| Form | Cost today | Cost on a populated database |
|---|---|---|
| New table `turns` (recommended) | zero | **zero** — `CREATE TABLE IF NOT EXISTS` creates it |
| New table for the tool records of §T4 | zero | **zero** — same reason |
| New column on an existing table | zero | low — the manual `ALTER TABLE` pattern, `core/memory/store.ts:153-156` |
| New value in `episodes.kind` | zero | **high** — SQLite cannot alter a `CHECK` (`core/memory/schema.ts:34`). The repair is a table rebuild, and `episodes` carries an FTS5 external-content table with three triggers (`core/memory/schema.ts:52-60`) beside a `vec0` virtual table whose shadow tables a rename strands (`AGENTS.md`) |
| New `episodes.connector` value | zero | **zero** — free `TEXT`, no constraint |
| New shape for the session JSONL | zero | medium — every file already written needs a reader that accepts both shapes |

The recommendation uses new tables only. It does not need `episodes.kind`, and
the reason is design and not migration cost: an episode is monotone evidence, a
turn record is mutable state.

```
turns(
  id            TEXT PRIMARY KEY,   -- also the trace id root
  -- identity: never recomputed
  principal     TEXT NOT NULL,      -- JSON: the Principal
  tenant        TEXT NOT NULL,
  surface       TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  model         TEXT NOT NULL,      -- pinned. A resume on another model is refused
  -- the turn itself
  messages      TEXT NOT NULL,      -- JSON: Message[]. Thinking blocks included
  taint         INTEGER NOT NULL CHECK (taint BETWEEN 0 AND 3),
  counters      TEXT NOT NULL,      -- JSON: iterations, recoveries, retries,
                                    -- toolCalls, nudged, usage
  -- where the answer goes
  reply_to      TEXT NOT NULL,      -- JSON: closed set per surface
  -- why it is not running
  status        TEXT NOT NULL CHECK (status IN
                  ('runnable','running','waiting','done')),
  wake_at       TEXT,               -- NOT NULL when status = 'waiting'
  wait_for      TEXT,               -- closed set, validated in code
  claimed_by    INTEGER,            -- pid, for the same reason gateway_lock has one
  claimed_at    TEXT,
  -- two outcomes, never one
  turn_outcome  TEXT,               -- the stopped value
  delivery      TEXT,               -- 'pending' | 'sent' | 'failed:<reason>'
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
)
CREATE INDEX idx_turns_due ON turns(status, wake_at)
```

Six rules on this table, each with its reason.

1. `model` is pinned. A thinking block carries a signature from the model that
   made it (`agent/providers/types.ts:43`). A resume on another model sends
   signatures that model cannot read, and the failure is silent (ADR-0037 §1).
2. `taint` is a column, never derived. The threat model scopes taint to the turn
   and raises it monotonically (`03-threat-model.md:21`). A rebuild from the
   principal alone lowers it.
3. `status` is a closed set with a CHECK. A free string here rebuilds the
   ambiguity the enum removes.
4. `wake_at` is `NOT NULL` whenever `status = 'waiting'`. The code enforces it;
   SQLite cannot express the conditional constraint.
5. `turn_outcome` and `delivery` are separate. A failed delivery must never make
   a turn runnable again (`core/scheduler/scheduler.ts:166-171`).
6. One write advances the state, and it comes after delivery. This is the
   equivalent of `markRan` being the only writer of `next_fire_at`.

`claimed_by` is a per-row claim. `DurableLock` cannot serve here: it is a
single-row mutex on `id = 1` (`core/lock/durable.ts:112-113`). The claim
algorithm is reusable; the table is not.

## T3. Suspension points

| Point | File:line | Extra state to persist | Verdict |
|---|---|---|---|
| Top of the iteration loop | `agent/loop.ts:351` | none | Suspension point |
| Between two tool calls | `agent/loop.ts:569-591` | partial `results` array | Suspension point |
| Inside `provider.chat` | `agent/loop.ts:414` | none | Abandon only. Costs tokens |
| Inside `tool.handler` | `agent/loop.ts:785` | not serializable | Abandon only. Costs effects |

A `Promise` has no serializable form. Suspension inside a handler needs every
handler to become a state machine with an explicit continuation. That change
reaches every MCP server, which this project does not own.

## T4. The two-phase tool record

Today the loop writes the outcome only (`agent/loop.ts:787`). The intent record
does not exist. A resume therefore cannot separate "done" from "maybe done".

Required shape, per tool call:

```
before handler:  write intent(turn_id, call_id, tool, args_digest)
after handler:   write outcome(turn_id, call_id, content, is_error, tier)
```

Resume reads the pair:

| Intent | Outcome | Action |
|---|---|---|
| yes | yes | Replay the recorded outcome. Do not call the handler |
| yes | no | Consult the tool's re-runnability declaration |
| no | no | Call the handler |

Re-runnability is a **new** declaration on `CapabilityDecl`. `reversible`
(`core/policy/types.ts:83`) answers a different question. The two axes are
independent:

| Capability | `reversible` today | Re-runnable |
|---|---|---|
| `fs.read`, `fs.list` (`agent/tools/fs.ts:65, 73`) | `yes` | yes |
| `fs.write` (`agent/tools/fs.ts:81`) | `undoable` | **yes** — a whole-file write is idempotent |
| `sys.http` (`agent/tools/http.ts:33`) | `yes` | yes for GET only |
| `sys.shell` (`agent/tools/shell.ts:35`) | `no` | no |
| `sys.process.kill` (`agent/tools/process.ts:35`) | `no` | no — pids get reused |
| `mcp.*` (`agent/tools/mcp.ts:34`) | `no` | no — unknown semantics |

The residual window stays open: an effect can land in the world before its
outcome row commits. Temporal has the same window and answers it with activity
idempotency. State this, and do not promise better.

## T5. What must change in the connector

| Today | Required |
|---|---|
| `await runTurn(...)` at `connectors/telegram/connector.ts:307` | Create the turn record, then return |
| `markProcessed` after `handle` at `:232` | `markProcessed` and the record insert in one SQLite transaction |
| `editMessageId` set for groups only (`presence.ts:75-89`) | A durable placeholder message on every surface, its id stored in `reply_to` |
| Presence renewed by connector timers (`presence.ts:73, 81`) | The lane owns the update. Two renewal mechanisms must not coexist |
| Delivery inside `handle` (`:317-327`) | Delivery by the lane, from `reply_to`, after the turn ends |

The at-least-once guarantee moves from `telegram_updates` to `turns`. It is a
transfer, not a removal. `better-sqlite3` is synchronous and the repo already
uses `BEGIN IMMEDIATE` for an atomic check-then-act (`core/lock/durable.ts:142`).

## T6. What must be decided before any code

1. Decide whether `runTurn` keeps its signature. This brief recommends no, and
   recommends `createTurn` + `step` + a synchronous `drainTurn` driver for
   `cli/run.ts:65` and `evals/floor/run.ts:107`.
2. Decide the re-runnability vocabulary. This brief recommends a third field on
   `CapabilityDecl`, next to `reversible`.
3. Decide the `wait_for` closed set. A free string rebuilds the firehose that
   ADR-0028 made unbuildable.
4. Decide the per-tenant ceiling on suspended turns, and what `wait` returns
   above it.
5. Decide whether `TurnResult.stopped` grows a `'suspended'` arm or the type is
   restructured. Two literal unions exist today (`agent/loop.ts:246`,
   `core/scheduler/scheduler.ts:45`) and they will diverge.
6. Decide whether the per-job budget of ADR-0035 §revisione point 2 enters this
   slice. Each resume re-sends the whole prefix, so `wait` has a token cost that
   no counter measures today.

## T7. What must be tested, per practice §5

Write the test that fails without the wiring, not the test that proves the logic.

- A turn that reaches taint 3, suspends and resumes is refused the capability
  that taint 3 forbids. This fails today by construction, because taint is not
  persisted.
- A resumed turn sends back thinking blocks byte-identical to the ones received,
  asserted through `runTurn`, not through the adapter.
- A resume against a different `config.models.main` is refused, and names the
  model.
- A tool call with an intent row and no outcome row is not re-executed when its
  capability is not declared re-runnable.
- A failed delivery leaves the turn `done`, never `runnable`.
- A `wait` without `wake_at` is refused at the boundary.
- Two processes cannot claim the same turn row.
- An inserted turn row and the `markProcessed` of its update either both commit
  or neither does.

---

# Cosa non si è potuto stabilire

1. **`docs/ORCHESTRATION.md §14` non esiste.** Il file è di 223 righe e la sua
   ultima sezione è §13, a `docs/ORCHESTRATION.md:191`. Il mandato cita §14 per
   *«si ripara alla radice; ci si ferma dove il difetto diventa non
   rappresentabile»*. Ho applicato il principio — è quello di ADR-0028 e
   ADR-0006, ed è esplicito in `M5-BIS.md:151-161` — ma **non ho letto la
   sezione che il mandato intendeva**. Se §14 è stata scritta e non committata,
   questo documento va riletto contro di essa.
2. **Nessuna misura di latenza.** «~500 ms» è il criterio di ADR-0035; non ho
   misurato quanto ci mette oggi un turno Telegram, né quanto ci metterebbe un
   ACK. Non c'è un `~/.muffin` popolato su questa macchina e non ho eseguito il
   runtime. Lo spike è breve e va fatto prima di fissare la soglia.
3. **Il costo in token di un resume non è misurato.** Il meccanismo è certo (il
   prefisso si rimanda), il TTL della cache di prompt non l'ho verificato contro
   la documentazione viva in questa passata, e la spesa reale dipende dal TTL. È
   l'unica affermazione economica di questo file, ed è **folklore** finché non si
   misura. Costerebbe una chiave e poche richieste, e la decisione è dell'owner.
4. **Se un turno sospeso debba essere visibile all'owner, e come.** `doctor` e
   `gateway status` vedono il processo; non ho stabilito se una riga «tre turni
   in attesa» vada lì, in un verbo nuovo, o da nessuna parte. Dipende da
   `queue`/`steer`, che ADR-0035 lascia aperti e che nessuno ha ancora
   disegnato.
5. **Se il `wait` di un turno di gruppo vada permesso affatto.** Un membro
   tier-2 che può armare un'attesa persistente è una superficie che il threat
   model non ha esaminato. `decideProactive` nega a tier > 1
   (`core/scheduler/proactivity.ts`, **riportato** da
   `piano-eventi-workspace.md`), ma `wait` non è proattività: è un tool dentro un
   turno che il membro ha legittimamente iniziato. Va istruito prima di
   costruirlo, non dopo.
6. **Se lo streaming (B11) entri in questa forma o dopo.** `ChatCall.stream`
   esiste, è obbligatorio e nessuno lo legge (§T1). Le due cose vivono sullo
   stesso confine e non ho istruito la loro interazione: uno stream in corso è
   uno stato non serializzabile, quindi un turno che streamma **non si sospende
   a metà stream**. Sembra compatibile con la Domanda 2 — lo stream finisce, poi
   si sospende — ma non l'ho verificato contro un adapter che streamma, perché
   non ne esiste uno.
7. **Il contenuto di `~/.muffin` non l'ho contato io.** Il numero che regge
   l'argomento «la finestra dello schema è aperta» — **20 episodi, 0 fatti, 0
   entità, 0 job**, finestra 11→15 agosto, quattro giorni di prove
   sull'onboarding — mi è stato riferito dall'orchestratore, che dice di averlo
   letto in sola lettura sul database vero il 2026-08-15. **riportato**, non
   misurato: quel database non è su questa macchina. Se fosse sbagliato,
   cambierebbe una cosa sola in questo file — la §T2 diventerebbe vincolante
   invece che informativa — e nessuna delle raccomandazioni, perché nessuna
   dipende da una migrazione.
8. **Il numero di righe della slice.** Non ho stimato l'implementazione perché
   il mandato dice di non implementare, e una stima senza aver scritto
   l'interfaccia dei tool sarebbe un numero inventato. Le tre stime che ho dato
   (§La forma che raccomando) riguardano modifiche che si vedono per intero da
   qui, e sono etichettate **folklore** apposta.
