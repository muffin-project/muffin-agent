# ADR-0106 — Il gateway è un ruolo, non un servizio

**Stato: adottato dall'owner il 2026-11-14** (GO esplicito), prima del codice
di comportamento. Profilo di verifica **CRITICAL**
(`docs/development/ORCHESTRATION.md`: lease, fencing, schema durevole, recupero
dopo un crash). Ogni slice di comportamento qui sotto vuole un giudice fresco
con verdetto terminale prima dell'integrazione; questa decisione non lo
sostituisce. Amenda ADR-0103 (primo punto della Decisione, e il Falsificatore),
ADR-0081 (punto 1, owner locale, e il fuori scope «locale-vs-locale») e
ADR-0035 (Emendamento №3, il risveglio oltre l'orizzonte duro; «Come si tiene
su», i supervisori). Il testo di quegli ADR non è riscritto: il rimando sta
in coda a ciascuno.

Numero: **0106 è libero** su ogni ramo remoto al 2026-11-14 (nessun file
`0106-`). `docs/decisions/prossimo-numero.mjs` stampa `0108`, perché dà il
massimo più uno e ADR-0107 è già su `cursor/prompt-prefix-shrink-e258`
(PR #951). 0106 non è un numero ritirato: non ha citazioni. Resta il numero
del GO, non il buco da bruciare.

Riletto sul codice di `dev` @ `7064bec1` (merge di #948), dopo #940.
Evidenza, che non è autorità: `docs/evidence/gateway-come-ruolo-peer-2026-11-05.md`,
`docs/evidence/gateway-come-ruolo-questioni-2026-11-05.md`. La bozza del
2026-11-05 è stata riscritta contro quel `dev`: non è più il testo.

## Contesto

Direttiva owner, 2026-11-04: un processo sempre vivo, a cui si scrive da
Telegram e che c'è; e, insieme, run headless come `claude`. ADR-0103 ha chiuso
la divergenza dei due runtime vietando l'esecuzione locale: senza gateway,
`muffin run` esce 1 col rimedio e zero chiamate al modello. Lo stesso ADR
lascia nel Falsificatore che un'installazione senza supervisore richiede una
decisione nuova, non una scorciatoia. Il caso c'è: container senza user bus,
CI, script.

Lo stesso giorno, intorno alle 19:26 (ora di Roma), un gateway lanciato a mano
ha perso la rivendicazione dopo una sospensione dell'host. `refresh()` è
fallito oltre l'orizzonte duro (Emendamento №3). Il log ha detto che un altro
processo aveva preso la riga. Non era vero: riga in attesa, pid null. Il
processo è uscito 0 e, senza supervisore, nessuno l'ha rialzato.

Su `dev` @ `7064bec1` il meccanismo è ancora quello. `Gateway.tick` tratta ogni
`beat` falso come un furto (`core/gateway/service.ts`), drena con ragione
`lock` ed esce 0: `EXIT_FOR` fa di quell'uscita un «riavviami», utile solo se
un supervisore c'è. `DurableLock.refresh` rifiuta già il caso giusto — pid e
`holder_id` coincidono ma `heldBy` giudica la riga scaduta — e il suo commento
nomina il ri-claim come risposta lecita. Il chiamante non distingue «scaduta e
libera» da «tenuta da un altro». Il commento di `tick` dice ancora che, se il
battito si ferma, il REPL prende il controllo: ADR-0103 l'ha reso falso, e
questa decisione non lo resuscita.

La ragione di ADR-0081 e ADR-0103 non è il database e non è il motore del
turno. È **un owner per Home**: una `ModelLane` in-process, un ticker dei job,
un poller per token, una corsia dei turni sospesi. Il gateway è oggi l'unico
modo di essere quell'owner solo perché è l'unico che prende `gateway_lock`.
#948 non cambia il lock: dopo che lo scheduler cede il token del modello, il
battito fa riprendere alla turn lane un job già legato. Quella cessione interna
è recintata dalla freschezza del claim (`isCurrentClaim` prima di
`turnLane.tick` nel callback). #940 non cambia il lock: `ForwardHost.query`,
quando non ha l'esito in memoria, riporta lo stato durevole e `text: null`,
mai una risposta precedente letta dal checkpoint.

## Decisione

**Gateway è il nome del ruolo**: il processo che tiene il claim della Home
(`gateway_lock`, `holder_id` dell'Emendamento №3, vivezza dell'incarnazione
per ADR-0094). Non è necessariamente un servizio installato.

### Invarianti

1. In ogni momento al più un owner per Home, con una sola `ModelLane`. Solo il
   detentore esegue turni, e lo fa con lo stesso `buildRuntime` / `runTurn` in
   ogni modalità. Nessun secondo runtime, mai in silenzio. ADR-0103 resta vero
   su questo, e smette di esserlo sul divieto «senza gateway → rifiuto» per
   `muffin run`.
2. Un detentore vivo non si ruba (Emendamento №3, ADR-0094). La cessione del
   ruolo è volontaria, con drenaggio. Rinfrescare in place un token già
   scaduto resta vietato: è il bug P21.
3. Scheduler, job, superfici, retention e corsia dei risvegli stanno solo
   nella modalità persistente.
4. L'autorità è invariata (ADR-0081, punto 5). La modalità non concede
   capability, non apre una porta, non allarga il socket.

### Modalità

- **Persistente.** `muffin gateway run` sotto un supervisore. Possiede claim,
  superfici, scheduler, corsia dei sospesi. È ciò che rende vera la direttiva
  del 2026-11-04. I supervisori sono `systemd`, `launchd`, `docker`,
  `external`, `none`. `none` è dichiarato, mai il default.
- **Effimera.** `muffin run` che non trova nessun owner. Prende lo stesso
  claim con `mode=ephemeral` e lo stesso battito (30 s, timer proprio: non
  c'è uno scheduler a cui legarlo). Esegue il proprio turno nel processo che
  tiene il claim. Non ha superfici, job, corsia impegni, corsia dei sospesi
  né retention, **mai**: ciò che è dovuto resta dovuto, senza riga in
  `job_fires` e senza slot consumato, finché non sale un persistente. Resta
  vivo per le **esecuzioni** in coda o in volo, non per le connessioni
  aperte. Quando non ne ha più, drena il lavoro che il turno ha avviato e che
  fa parte del suo esito (tool in volo, stdout, scritture del record) — non
  lo scheduler — e esce subito, senza linger. Durante il drenaggio `identify`
  risponde `draining`. Un cliente arrivato in quel momento ri-risolve l'owner
  e, se il claim si libera, diventa lui l'effimero.
- **Cliente.** Un `run` che trova un owner, persistente o effimero, gli
  inoltra il turno. Un secondo `run` mentre un effimero è vivo **si accoda**,
  non rifiuta. L'id di execution resta quello coniato dal client e non c'è
  replay (ADR-0081, punto 4). La slice 2 può rifiutare il secondo run, fail
  closed, come tappa: non è lo stato finale, e un rilascio che si ferma lì
  deve dirlo.
- **REPL.** Solo cliente di un owner `mode=persistent`. Senza, rifiuta col
  rimedio e zero chiamate al modello. Non diventa effimero e non si attacca a
  un effimero: terrebbe il claim per ore senza Telegram né job. Il rimedio
  dipende dal supervisore: `muffin gateway install --write --start` con
  systemd o launchd, `docker compose up -d gateway` in container, altrimenti
  `muffin gateway run` in un altro terminale (`supervisor=none`). Se l'unico
  vivo è un effimero, il rimedio nomina il suo pid.

I turni `suspended` / `continuable` nati sotto un effimero restano in attesa
(exit 6 / 7, come oggi) e li riprende il prossimo persistente.

### Il claim

Colonne additive, non una tabella nuova. Oggi la riga è `id`, `pid`,
`taken_at`, `since`, `status`, `holder_id` (`core/gateway/lock.ts`). Si
aggiungono `mode` (`persistent` | `ephemeral`), `supervisor`
(`systemd` | `launchd` | `docker` | `external` | `none`), `exited_at`,
`exit_reason`. `since` è l'avvio di questo processo e non si muove su un
battito né su una ri-acquisizione. `identify` restituisce `mode`.

| Da | Evento | A |
|---|---|---|
| libero | `gateway run`, oppure `run` senza owner | persistente / effimero, token nuovo |
| effimero | nessuna esecuzione in coda o in volo | drenaggio → release |
| effimero | il persistente chiede `vacate` | niente esecuzioni nuove; quelle in volo finiscono → libero |
| persistente | SIGTERM / SIGUSR1 | drenaggio (60 s) → libero; esce 143 o 0 come oggi |
| qualunque | incarnazione morta (ADR-0094) | rubabile subito |
| qualunque | vivo ma muto sul battito | vedi sotto, «vivo ma fermo»; il furto del token resta all'orizzonte duro |
| persistente, lease oltre l'orizzonte duro, nessun altro detentore | risveglio | **ri-acquisizione nello stesso processo, token nuovo** |
| qualunque, un altro detentore vivo | `refresh` falso | non si ruba; si esce come oggi (`drain('lock')` → 0, il supervisore riprova e trova 75) |

### Risveglio: si ri-acquisisce, non si esce

GO dell'owner, 2026-11-14. Emenda la frase dell'Emendamento №3 che fa uscire
un `gateway run` senza supervisore quando `refresh` fallisce oltre l'orizzonte
duro. La bozza del 2026-11-05 faceva l'opposto (registrare `exit_reason` e
uscire 0): è scartata.

È la forma di etcd e di Chubby, non un rinfresco del token morto. In etcd una
lease scaduta non si rianima: il client può ottenerne una nuova, e la vecchia
non autorizza più scritture. In Chubby (Burrows, OSDI 2006) un sequencer
scaduto fa rifiutare l'RPC in ritardo; se il lock è libero il client può
riprenderlo, e riceve un sequencer nuovo.

Quindi, nello stesso processo, dentro la transazione immediata di `acquire`:

1. Se `heldBy` nomina un altro detentore vivo, non si acquisisce. Il log dice
   chi tiene la riga, non «presa da un altro processo» quando la riga è vuota.
   Si drena e si esce 0, come `drain('lock')` fa già, così il supervisore
   riprova e il perdente esce 75.
2. Se nessuno tiene la riga, si conia un `holder_id` nuovo con lo stesso
   percorso di `acquire`. L'incarnazione resta quella del processo (ADR-0094).
   `taken_at` avanza. `since` no. Il token vecchio è morto: una scrittura con
   quel `holder_id` cambia zero righe.
3. Il battito che ha visto `refresh` falso non entra in `scheduler.tick` e
   non consegna. Il lavoro in memoria non continua sotto il token vecchio. Il
   turno e il job si riprendono dal percorso già esistente (`claim_token`,
   `job_fires`, #948), sotto il token nuovo. Una seconda chiamata al modello
   per la stessa occorrenza è il fallimento della slice, non un residuo.

P21 resta: è vietato spingere `taken_at` sul token scaduto facendo finta che
i lettori non l'avessero già giudicato assente. La ri-acquisizione perde la
corsa se nel frattempo un altro `acquire` ha vinto.

### Cessione del ruolo: il verbo è `vacate`

Un persistente che trova un effimero vivo non ruba il claim. Gli chiede di
**`vacate`**: da quel frame l'effimero non accetta esecuzioni nuove, finisce
quelle in volo, rilascia. Il persistente aspetta il rilascio al più
**`H = 60 s`**, controlla ogni 250 ms, e pubblica `STATUS=` («in attesa che il
run effimero pid N rilasci»). Oltre `H` esce 75 (`EXIT_ALREADY_RUNNING`) senza
aver mandato `READY=1`, e il supervisore riprova dopo `RestartSec=5`. Lo stato
di cessione vive nell'effimero e sopravvive ai tentativi: il tempo giù è al
più la durata dei turni già in volo più circa 65 s, non `H` per il numero di
tentativi. Un cliente nuovo, in quella finestra, riceve `vacate` e ri-risolve
l'owner; le esecuzioni non avviate le esegue il persistente, con lo stesso id.

`H` sta sotto il `TimeoutStartSec` di default di systemd (90 s). La unit è
`Type=notify` quando `systemd-notify` c'è, e non imposta `TimeoutStartSec`
(`core/gateway/unit.ts`). `READY=1` parte solo dopo il claim
(`Gateway.serve`, dopo `start()`): annunciarlo prima farebbe sembrare sano un
crash-loop. Un'attesa di 5 minuti, quella di OpenClaw, farebbe uccidere
l'avvio con SIGTERM. SIGTERM esce 143, e 143 sta in `RestartPreventExitStatus`
accanto a 78: un timeout d'avvio passerebbe per uno stop volontario e la unit
resterebbe giù. `EXTEND_TIMEOUT_USEC` sarebbe un meccanismo in più per non
toccare la unit. Su launchd e Docker il tetto dei 90 s non c'è; `H` resta 60 s
per avere una regola sola.

Il turno in volo non si cede come `continuable`. «Vacate» non è una classe di
ADR-0086, e la lane non preleva `continuable` da sola. Chi ha lanciato il
`run` perderebbe l'esito. Le attività lunghe di ADR-0100 le copre il ciclo
75 → riprova, non un `H` più lungo.

Due avvii contemporanei senza owner: vince la transazione di `claim`. Chi
perde, con un claim vivo e il socket ancora muto, tratta il caso come «in
avvio» e riprova per circa 10 s prima di dichiarare il conflitto.

**Il verbo non si chiama `handoff`.** #948 usa già quella parola per un'altra
cucitura: lo scheduler differisce, rilascia il token condiviso del modello, e
il battito fa riprendere alla turn lane un job già legato. Quel passaggio è
recintato dalla freschezza del claim e non sposta consegna, replay o autorità
(`a30384c7`, «Fence the deferred turn handoff by gateway claim freshness»).
Un secondo significato sul protocollo di controllo farebbe leggere la slice 3
sulla cucitura sbagliata. In italiano resta «cessione»; sul filo è `vacate`.

### Protocollo, e #910

Il protocollo di controllo passa a 3. Un client v2 continua a eseguire: non
deve mandare `vacate` per fare un turno. `vacate` usa gli stessi ACL del
socket e non introduce autorità.

PR #910 (`slice/gateway-attach`, aperta, non si fonde da sola) chiede
`muffin gateway attach <id>` e `muffin run --attach`: sottomettere al gateway
vivo sul socket, con id stabile, interrogare l'esito durevole fino a un
wait-cap, exit code headless, disconnect ≠ cancel. Il GO la assorbe nella
slice 3. Il ramo di #910 è anteriore a #940 e legge ancora il checkpoint come
testo della risposta. L'assorbimento sta su `ForwardHost.query` com'è su
`dev`: esito in memoria, altrimenti stato durevole e `text: null`. Non si
riapre #940.

### Sessione dei run

Il default resta una sessione nuova per run (`cli/run.ts`:
`run-<data>-<hex>`), perché isola gli script. `--session <id>` esiste già e
non compariva nella usage di `cli/main.ts`. Va documentato lì, insieme alla
catena già vera nel codice: l'id esce nel JSON (`session`) e nel piè di
pagina (`sessione`). Una sessione nuova non dà stickiness sui router che
ruotano; la cache di prefisso del provider non dipende da questa scelta. Chi
vuole concatenare passa `--session`.

### Supervisori, e «vivo ma fermo»

`muffin gateway install --supervisor systemd|launchd|docker|external|none`.
Per systemd e launchd non si cambia la unit, salvo ciò che la slice 4 deve
stampare in più. Rilevazione, in quest'ordine, sovrascrivibile con
`--supervisor`: label launchd; `INVOCATION_ID` o `NOTIFY_SOCKET` → systemd;
`MUFFIN_CONTAINER=1` (già nell'immagine) → docker; altrimenti `none`. Non si
rileva il container guardando se questo processo è il pid 1: nell'immagine
attuale il pid 1 è tini, e il gateway è il figlio (`contrib/docker/Dockerfile`,
`ENTRYPOINT`).

- **docker.** Il gateway resta il comando del container, in foreground, sotto
  tini. L'entrypoint dell'immagine ufficiale diventa `tini -s --`, così un
  `init: true` aggiunto da fuori non rompe il subreaper. Lo snippet non stampa
  `init: true` per l'immagine ufficiale; lo stampa solo per un'immagine di
  terzi senza un init proprio. `restart: unless-stopped` e
  `stop_grace_period: 75s` ci sono già in `contrib/docker/compose.yaml`. Lo
  snippet non scrive file: li stampa. Niente s6-overlay: Hermes lo usa perché
  nel container gira più di un processo; qui no.
- **external.** s6, runit, Kubernetes. Il supervisore lo porta l'owner. La
  sonda è la stessa; l'uccisione la fa lui.
- **none.** Mai di default. `doctor` lo dice.

`muffin gateway status` esce 0 solo con un owner `mode=persistent` il cui
ultimo battito è entro `WATCHDOG_SEC` (60 s, `core/gateway/unit.ts`). Un
effimero vivo non è «il gateway è su»: il testo nomina il pid e l'uscita è 1.
**Vivo ma fermo** è un'uscita a parte, 2: l'incarnazione è ancora tenuta
(ADR-0094 direbbe vivo, e `heldBy` lo protegge fino all'orizzonte duro, 30
minuti) ma `taken_at` è più vecchio di `WATCHDOG_SEC`. È la domanda che su
systemd fa `WATCHDOG=1`, e che `Restart=always` non vede. Su Docker la restart
policy non riavvia un container unhealthy che non è uscito. La healthcheck
dello snippet uccide il pid 1 **solo sull'uscita 2**, così `unless-stopped`
può ripartire. L'uscita 1 (spento, stop volontario, solo effimero, home non
ancora configurata, persistente in attesa di `vacate`) non uccide: il wait
dell'entrypoint e `gateway.stopped` restano un `sleep infinity`. Intervallo
30 s (il battito), timeout 5 s, 3 tentativi, `start_period` 40 s: copre il
boot, sta sotto l'orizzonte duro, e si muove solo se si muovono `HEARTBEAT_MS`
o `WATCHDOG_SEC`.

Docker non ha `RestartPreventExitStatus`. Un 78 (config assente, secret
mancante, root of trust che rifiuta) sul percorso lungo del gateway deve
diventare log + `sleep infinity`, come già `gateway.stopped` in
`contrib/docker/entrypoint.sh`. Il percorso `init-from-secret`, che è un
one-shot, continua a uscire 78 davvero.

`doctor` avvisa: job o impegni dovuti e nessun persistente; unit o plist
abilitata ma il vivo dichiara `supervisor=none`; nessun owner e un'ultima
uscita registrata; `supervisor=none` in modalità persistente, sempre, col
rimedio; uscita 2, «vivo ma fermo», col nome del supervisore che dovrebbe
ucciderlo (watchdog, healthcheck, probe esterna).

## Conseguenze

Più facile: `muffin run` funziona in container, CI e script senza un secondo
runtime. Il buco locale-vs-locale di ADR-0081 si chiude con un claim. Telegram
e i job restano nel persistente. Una sospensione non spegne in silenzio un
gateway che è l'unico detentore. La morte e il «vivo ma fermo» hanno un'uscita
e una riga.

Più difficile: durante un'attività effimera lunga, Telegram e i job restano
giù finché l'effimero non finisce o non fa `vacate`. Uno script di molti `run`
paga l'avvio ogni volta. La cessione è un protocollo in più. Sotto Docker il
78 non si tiene giù da solo: lo tiene l'entrypoint. `muffin resume` resta
locale e recintato (ADR-0103); non diventa effimero qui.

## Alternative scartate

| Alternativa | Perché no |
|---|---|
| Uscire al risveglio se la lease è scaduta e nessun altro tiene la riga (bozza 2026-11-05; frase dell'Emendamento №3) | Senza supervisore il processo resta giù, ed è il caso misurato il 2026-11-04. Il GO sceglie la ri-acquisizione con token nuovo. Rinfrescare il token vecchio resta P21, scartato. |
| Auto-spawn staccato con idle-exit (Hermes) | Un `run` da script lascerebbe un daemon non scelto, con superfici. Terza modalità. Analogo all'installer che agisce in una run scriptata, vietato dall'Emendamento №1. |
| Runtime locale senza claim (pre-0103, `MUFFIN_EXEC_LOCAL` di default) | Due semantiche. È la divergenza che ADR-0103 ha chiuso. |
| Nessuna esclusione, come `claude -p` | Da loro ogni sessione ha il suo JSONL e non ci sono job né superfici. Da noi: due `ModelLane`, job doppi, poller in 409. Incident del 2026-09-12, e Hermes #25517. |
| Il secondo run rifiuta, come stato finale (OpenClaw `--local`) | Rompe gli script paralleli. Vale solo come tappa della slice 2. |
| Il persistente ruba il claim all'effimero | Viola l'invariante 2. |
| Cedere il turno in volo come `continuable` | Toglie l'esito a chi ha lanciato il `run`. Si riapre solo se scatta il falsificatore (a), con una classe nuova in ADR-0086. |
| `H` di 5 minuti (OpenClaw) | Supera `TimeoutStartSec` e il 143 in `RestartPreventExitStatus`. |
| REPL effimero, o REPL cliente di un effimero | Claim tenuto per ore senza superfici né job. |
| Linger dell'effimero (Hermes, 600 s) | Da loro ammortizza un daemon staccato. Da noi la corsa la chiude `draining` più la ri-risoluzione. |
| Sessione stabile di default | Mescola script indipendenti. `--session` la dà a chi la chiede. |
| s6-overlay | Più processi per container. Non è questo caso. tini c'è già. |
| Chiamare `handoff` il verbo di cessione | Collide con la cessione differita del turno in #948. |
| Fondere #910 da sola | Il GO la assorbe nella slice 3, sul `query` di #940. |
| Healthcheck che uccide su ogni status ≠ 0 | Abbatterebbe l'attesa di init, lo stop volontario e l'attesa di `vacate`. Si uccide solo l'uscita 2. |
| Rilevare Docker perché il gateway è pid 1 | Nell'immagine il pid 1 è tini. |

## Falsificatore e reversibilità

Basta un caso: due chiamate al modello sovrapposte sulla stessa Home, o un job
eseguito due volte. Si conta invece:

- (a) cessioni con più di 3 tentativi del supervisore, o un 143 di
  `TimeoutStartSec` che lascia la unit giù. Se le cessioni lunghe sono la
  norma, si cede il turno come `continuable` con una classe nuova in
  ADR-0086. Non si allunga `H`.
- (a′) costo d'avvio dell'effimero, dal claim al primo byte al modello, oltre
  circa il 30% del tempo di parete mediano dei run brevi: allora un
  `--keep-alive` esplicito, mai default, mai con superfici. La risposta di
  default per «tanti run» resta il persistente.
- (a″) se nei run degli script dell'owner la maggioranza passa lo stesso
  `--session`, il default di sessione si rivede con un ADR breve.
- (b) turni `waiting` nati da un effimero e fermi da più di 24 h.
- (c) morti del persistente a settimana dopo la slice 1: è il segnale già
  scritto in ADR-0035.
- (d) una ri-acquisizione che scrive lo stesso `holder_id`, o una seconda
  chiamata al modello per la stessa riga di `job_fires`. La mutazione che
  toglie il token nuovo deve andare rossa.

Reversibilità alta per le slice 1–3. Le colonne sono additive. Senza
`mode=ephemeral` torna il rifiuto di ADR-0103. La ri-acquisizione si spegne
tornando all'uscita dell'Emendamento №3 se (d) si vede in uso.

## Piano a tappe e accettazione

Questa PR è la decisione, i rimandi, l'evidenza, le colonne descritte in
`MUFFIN-HOME.md`, la usage di `--session`, e la prosa falsa in
`core/gateway/service.ts`. Non è una slice di comportamento.

**Slice 1 — ri-acquisizione al risveglio, e il messaggio.** CRITICAL.
`service.test.ts`: salto d'orologio oltre l'orizzonte duro, nessun altro
detentore → lo stesso processo, `holder_id` diverso, `since` invariato, non
esce, il log non dice «presa da un altro processo». Stesso salto con un altro
detentore vivo → non acquisisce, non ruba, il log nomina l'altro, esce 0.
Una scrittura col token vecchio cambia 0 righe. Un job in volo attraverso il
salto non chiama il modello due volte (`job_fires` una riga). Mutazione: la
ri-acquisizione che riusa il `holder_id` vecchio fa rosso il test. `doctor`
riporta `exited_at` / `exit_reason` solo se il processo se n'è andato davvero.

**Slice 2 — run effimero.** `evals/acceptance/scenarios/gateway-ephemeral.accept.ts`,
senza hatch: `run` esce 0 con una sola chiamata al modello; durante il turno
`mode=ephemeral`; dopo, il claim è libero. Un job dovuto resta dovuto
(`job_fires` vuota), nessun `getUpdates`. `SIGKILL` a metà → il prossimo owner
prende il claim subito (incarnazione morta), il turno si recupera, nessuna
chiamata doppia. Un sospeso esce 6 e lo riprende il persistente avviato dopo.
Un persistente avviato durante il run aspetta il rilascio; oltre `H` esce 75
senza `READY=1` e senza rubare; al tentativo dopo prende il claim, e il `run`
esce 0 col suo esito. Il REPL senza persistente rifiuta, zero chiamate. Il
secondo `run` può rifiutare: è la tappa, non la decisione. Il resto di
`gateway-execution-owner.accept.ts` resta com'è per il persistente.

**Slice 3 — protocollo, coda, #910.** Due `run` concorrenti senza gateway
escono 0 tutti e due. Le chiamate al modello non si sovrappongono; la
mutazione che salta la lane va rossa; un solo pid detentore. Il REPL col solo
effimero vivo rifiuta. Un client connesso senza esecuzioni non tiene vivo
l'effimero. Un client arrivato durante `draining` diventa lui l'effimero, una
sola chiamata. `vacate` con un'esecuzione in coda e non avviata la fa eseguire
una volta dal persistente, stesso id; dopo `vacate` nessun client nuovo è
accettato. `muffin gateway attach` e `muffin run --attach` dal claim di #910,
sul `query` di #940: stato durevole, mai il testo di un checkpoint. Senza
gateway, attach esce 1 col rimedio e non resta appeso. Stesso id: niente
riesecuzione.

**Slice 4 — supervisore di container, e vivo ma fermo.** `unit.test.ts`:
`--supervisor docker` stampa `restart: unless-stopped`, `stop_grace_period:
75s`, la healthcheck, e non scrive file; `init: true` solo con un'immagine
di terzi. L'entrypoint ufficiale usa `tini -s`. Sul percorso lungo, 78 non va
in loop (`sleep infinity`); `init-from-secret` esce ancora 78. `gateway
status`: effimero → 1; battito più vecchio di `WATCHDOG_SEC` con incarnazione
viva → 2; la healthcheck uccide il pid 1 solo sul 2. `supervisor.test.ts`:
unit abilitata e claim `supervisor=none` → warn «avviato a mano». Accettazione:
`gateway run` come processo sotto un pid 1 simulato, poi SIGTERM → 143 entro
il drenaggio.

## Non deciso qui

- `muffin resume` resta locale e claim-fenced. Farlo diventare effimero è un
  passo successivo.
- Una Home di simulazione al posto di `MUFFIN_EXEC_LOCAL=1` nell'harness è un
  ADR a sé. La bozza del 2026-11-05 la chiamava slice 4; non lo è più.
- `--keep-alive` e la cessione come `continuable` non si adottano adesso.
  Entrano solo se scatta il falsificatore corrispondente.
- I numeri della healthcheck (30 s, 5 s, 3, 40 s) sono legati a
  `HEARTBEAT_MS` e `WATCHDOG_SEC`. Cambiarli insieme a quelle costanti non è
  una decisione nuova; cambiare la regola «si uccide solo l'uscita 2» lo è.
