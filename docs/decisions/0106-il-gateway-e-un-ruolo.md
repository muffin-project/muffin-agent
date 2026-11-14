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
in coda a ciascuno. L'emendamento CRITICAL di ADR-0094 sull'età del battito
è deciso e calendarizzato (dopo le slice 1–3, prima della slice 4). Il file
di ADR-0094 non cambia qui.

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
libera» da «tenuta da un altro». A `7064bec1` il commento di `tick` diceva che,
se il battito si ferma, il REPL prende il controllo: ADR-0103 l'aveva già reso
falso. Questa PR riscrive quel commento. Il log e il `drain('lock')` che esce
0 restano il comportamento di questo head, e questa decisione non li consegna
al REPL.

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

L'ordine è questo. Dentro `BEGIN IMMEDIATE` stanno solo il controllo di
`heldBy` e, se la riga è libera, il conio. È lo stesso perimetro di
`DurableLock.acquire` (`core/lock/durable.ts`): la transazione copre il
controllo e `mintHolderId`, poi si chiude. Il `drain` non ci entra. Aspettare
fino a `DRAIN_BUDGET_MS` tenendo la scrittura bloccherebbe l'altra connessione
e la scrittura del turno in volo, che a sua volta aspetta la transazione che
aspetta il turno.

1. Il battito che vede `refresh` falso non entra in `scheduler.tick` e non
   avvia un effetto nuovo. Non dice niente del `run()` del battito precedente,
   che può essere già dentro la chiamata al modello.
2. Se `heldBy` nomina un altro detentore vivo, non si conia e non si tocca
   `myHolderId`. `stillOwner` è `lock.isCurrentClaim()` (`cli/gateway.ts`):
   confronta la riga con il `myHolderId` di questa istanza. Lasciarlo com'è
   tiene `stillOwner()` falso, e la consegna resta recintata. Il log nomina chi
   tiene la riga, non «presa da un altro processo» quando la riga è vuota. Si
   esce dalla transazione, e solo dopo si drena. L'unica scrittura di quel
   drenaggio sul lock è l'update recintato di `status` descritto in «Vivo ma
   fermo», prima dell'attesa e prima di `release`. Il predicato è il
   `holder_id` di questa istanza. `taken_at` resta dov'è. La scrittura non
   consulta `heldBy`. `changes === 0` lascia lo status del nuovo detentore
   com'è: non si pubblica `drenaggio` sulla sua riga. Si esce 0 come
   `drain('lock')` fa già. Il supervisore riprova e il perdente esce 75. Non
   si consegna.
3. Se non nomina nessuno, nella stessa transazione immediata si chiama
   `mintHolderId` con la stessa incarnazione e si scrive quel valore sulla riga
   e in `myHolderId`, come fa `acquire` dopo un conio riuscito. Così il
   `stillOwner()` del run già in volo resta vero e quel run può finire. Non è
   il permesso di un'altra chiamata. Non si chiama `GatewayLock.claim`: il suo
   `onClaim` scrive `since`. `taken_at` avanza. `since` no. Poi la transazione
   finisce.
4. Il lavoro già dentro `run()` / `runTurn` è possibilmente fatto. Non si
   abortisce e non si riconsegna alla lane. `acquire` sostituisce `myHolderId`,
   quindi dopo la ri-acquisizione un `stillOwner()` in volo torna vero: non è
   il permesso di una seconda chiamata. Il `claim_token` del turno è un altro
   `mintHolderId` (`core/turns/store.ts`): ruotare `gateway_lock.holder_id`
   non fa cambiare zero righe a `checkpoint` / `finish`. Una scrittura col
   `holder_id` vecchio cambia zero righe sul refresh del lock, non sul turno.
   Abortire il run e lasciare il processo vivo (l'incarnazione resta bloccata,
   quindi nessuno reclama) lascerebbe il turno `running`. Interromperlo perché
   la lane lo «riprenda sotto il token nuovo» chiamerebbe il modello un'altra
   volta mentre la prima richiesta può essere ancora in volo. Il percorso che
   già esiste lascia finire il run in memoria. Una seconda chiamata per
   quell'occorrenza è il fallimento della slice.

P21 resta: è vietato spingere `taken_at` sul token scaduto facendo finta che
i lettori non l'avessero già giudicato assente. La ri-acquisizione perde la
corsa se nel frattempo un altro `acquire` ha vinto.

Un passo d'orologio in avanti, più largo dell'orizzonte duro, fa fallire
`refresh` come il risveglio. La ri-acquisizione timbra `taken_at` con lo
stesso `now` spostato e resta. Un passo indietro successivo lascia
`taken_at` nel futuro. Lo stesso timbro c'è già su `dev` @ `7064bec1`, senza
ri-acquisizione: un passo avanti dentro l'orizzonte duro fa scrivere
`taken_at` da `refresh`, e il passo indietro lo lascia avanti rispetto a
`now`. `heldBy` calcola l'età come `nowMs - takenAt` (`core/lock/durable.ts`,
la nota su R4/R6): un valore futuro rende la differenza negativa, e la riga
non scade. Un gateway che continua a battere riscrive `taken_at` al battito
successivo. Un detentore morto lo libera il lock di incarnazione di
ADR-0094, prima del confronto sull'orologio. Resta esposto un detentore vivo
ma fermo, o il ripiego sul pid, in ritardo pari al salto. Il buco precede
questa ADR. La decisione è «Il buco dell'orologio». Il caso del 2026-11-04
ha l'orologio giusto, `taken_at` vecchio, pid null, nessun altro detentore.

### Il buco dell'orologio

Decisione dell'owner, 2026-11-14. Chiude la voce che stava in «Non deciso qui»
e il falsificatore (e).

Un passo avanti, una ri-acquisizione e un passo indietro lasciano `taken_at`
nel futuro. Lo stesso esito c'è già senza ri-acquisizione, sul `refresh` che
`dev` accetta dentro l'orizzonte duro. Un gateway sano riscrive `taken_at` al
battito successivo. Un detentore morto lo libera il lock di incarnazione di
ADR-0094. L'esposizione che resta è un detentore vivo ma fermo, oppure il
ripiego sul pid quando il token non ha incarnazione: l'età supera la soglia
in ritardo pari al salto. Precede ADR-0106.

**Opzione E, la correzione di radice.** Emendamento CRITICAL a parte di
ADR-0094. Lo riferiscono l'Emendamento №3 e l'Emendamento №7 di ADR-0035. Si
scrive dopo le slice 1–3 e prima della slice 4. Il testo di quell'emendamento
non è questa PR.

La morte resta l'incarnazione. L'età del battito, per `heldBy` e per
`refresh`, viene da un orologio monotonico legato al boot. Due colonne
nullable, `beat_boot` e `beat_mono_ms`. Dentro lo stesso boot, `heldBy` e
`refresh` confrontano `process.hrtime`. Una riga vecchia, con le colonne
nulle, ricade sulla regola di oggi (`nowMs - takenAt`). L'orologio di parete
resta solo per il display. Su Linux `process.hrtime` legge `CLOCK_MONOTONIC`:
il tempo in sospensione non entra nell'età. Su macOS l'id di boot è `sysctl
kern.bootsessionuuid`, letto una volta, non `kern.boottime`. La lettura va
verificata sul Mac dell'owner, dove il sonno conta. `beat_boot` è l'id del
boot, non l'ora di avvio del processo che l'Emendamento №3 di ADR-0035 ha
scartato.

**Opzione A, scartata.** Una tolleranza sui timestamp futuri — trattare
`takenAt > now + tolleranza` come scaduto — può espellere un detentore vivo.
Un salto indietro mette `taken_at` oltre `now` più la tolleranza anche mentre
il processo batte. Non si adotta.

**Mitigazione B.** Slice a parte, adesso. Non è la correzione di radice e non
aspetta le slice 1–3. `doctor` segnala un `taken_at` nel futuro. `muffin
gateway unlock --confirm` libera la riga.

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

`muffin gateway status` esce 0 con un owner `mode=persistent` la cui età del
battito, come la calcola `heldBy`, sta entro `WATCHDOG_SEC` (60 s,
`core/gateway/unit.ts`), e anche mentre drena. Un effimero vivo non è «il
gateway è su»: il testo nomina il pid e l'uscita è 1.

**Vivo ma fermo** è l'uscita 2, e `taken_at` non è il ping del watchdog. Su
systemd `WATCHDOG=1` è un altro timer, tenuto acceso durante il drenaggio di
proposito (`core/gateway/service.ts`): `tick` torna prima di `lock.beat`
quando il processo si sta fermando, e `drain` azzera il timer del tick, quindi
`taken_at` smette di muoversi mentre il ping a systemd continua.
`notify.stopping` non scrive `gateway_lock`. `DRAIN_BUDGET_MS` e
`WATCHDOG_SEC` sono entrambi 60 s, e l'ultimo battito può essere già vecchio
di quasi un `HEARTBEAT_MS`. A metà di un SIGTERM o di un SIGUSR1
l'incarnazione è ancora tenuta e l'età del battito, calcolata come fa
`heldBy`, supera `WATCHDOG_SEC`. Quella riga non è un processo fermo: è il
drenaggio che il kill non deve abbattere.

Il drenaggio si pubblica sulla riga. Entrando in `drain`, prima dell'attesa
e prima di `release`, una sola scrittura corta, committata prima di
`DRAIN_BUDGET_MS`:

`UPDATE gateway_lock SET status = 'drenaggio' WHERE id = 1 AND holder_id = <token di questa istanza>`

`taken_at` resta dov'è. La scrittura non consulta `heldBy` e non chiama
`refresh`. Vale anche quando il token è già oltre l'orizzonte: in quel caso
`refresh` tornerebbe prima di `onRefresh`, e `beatInfo` (`UPDATE gateway_lock
SET status = @status WHERE id = 1`, `core/gateway/lock.ts`) scriverebbe la
riga di chiunque la tenga. Il predicato è il `holder_id` dell'Emendamento №3
di ADR-0035: ogni scrittura successiva sulla riga lo riporta, e
`changes === 0` vuol dire che la rivendicazione non c'è più. Saltare
`heldBy` lascia il `holder_id` al suo posto. `heldBy` è il controllo che
`refresh` aggiunge sopra la recinzione; un token oltre l'orizzonte, con il
`holder_id` di questa istanza ancora sulla riga, cambia una riga.
`changes === 0` lascia lo status del nuovo detentore com'è: non si riprova
contro di lui e non si esegue l'update senza `holder_id`.

L'uscita 2 richiede le tre cose insieme: incarnazione tenuta, età del battito
maggiore di `WATCHDOG_SEC`, e status diverso da `drenaggio`. L'età è quella
che calcola `heldBy`, non il confronto grezzo fra il valore di `taken_at` e
`WATCHDOG_SEC`. Oggi quell'età è `nowMs - takenAt`: un `taken_at` futuro è
negativo e non è uscita 2. Dopo l'emendamento di ADR-0094 l'età è
`process.hrtime` dentro lo stesso boot, e la slice 4 usa quella; le righe
con `beat_boot` nullo restano su `nowMs - takenAt`. La healthcheck uccide il
pid 1 solo in quel caso, così `unless-stopped` può ripartire. Un drenaggio
già più lungo di `WATCHDOG_SEC` non è uscita 2: è l'accettazione della slice
4. L'uscita 1
(spento, stop volontario, solo effimero, home non ancora configurata,
persistente in attesa di `vacate`) non uccide: il wait dell'entrypoint e
`gateway.stopped` restano un `sleep infinity`. Intervallo 30 s (il battito),
timeout 5 s, 3 tentativi, `start_period` 40 s: copre il boot, sta sotto
l'orizzonte duro, e si muove solo se si muovono `HEARTBEAT_MS` o
`WATCHDOG_SEC`. I tentativi contano solo se il comando non uccide al primo
falso 2: per questo il drenaggio non è un 2.

Docker non ha `RestartPreventExitStatus`. Un 78 (config assente, secret
mancante, root of trust che rifiuta) sul percorso lungo del gateway deve
diventare log + `sleep infinity`, come già `gateway.stopped` in
`contrib/docker/entrypoint.sh`. Il percorso `init-from-secret`, che è un
one-shot, continua a uscire 78 davvero.

`doctor` avvisa: job o impegni dovuti e nessun persistente; unit o plist
abilitata ma il vivo dichiara `supervisor=none`; nessun owner e un'ultima
uscita registrata; `supervisor=none` in modalità persistente, sempre, col
rimedio; uscita 2, «vivo ma fermo», col nome del supervisore che dovrebbe
ucciderlo (watchdog, healthcheck, probe esterna); un `taken_at` nel futuro
(mitigazione B: il rimedio è `muffin gateway unlock --confirm`).

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
locale e recintato (ADR-0103); non diventa effimero qui. Il `taken_at` futuro
è il buco già in `heldBy`. La correzione di radice è l'emendamento di
ADR-0094; fino ad allora `doctor` segnala il timbro e `muffin gateway unlock
--confirm` libera la riga.

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
| Tolleranza sui timestamp futuri (opzione A) | Un salto indietro mette `taken_at` oltre `now` più la tolleranza e può espellere un detentore vivo che sta battendo. |
| Trattare il `taken_at` futuro come esposizione nata qui | `heldBy` già non scade un timbro futuro su `dev` @ `7064bec1`. La ri-acquisizione è un'altra strada per scriverlo, non l'origine del buco. |

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
- (d) una ri-acquisizione che scrive lo stesso `holder_id`; una seconda
  chiamata al modello per una richiesta già partita prima del salto
  d'orologio; un drenaggio che esce 2; una scrittura di `drenaggio` che cambia
  righe con un `holder_id` diverso dal token di questa istanza. La mutazione
  che riusa il `holder_id` vecchio va rossa, va rossa quella che abortisce il
  run in volo e lascia chiamare il modello alla lane, e va rossa quella che
  pubblica `drenaggio` sul nuovo detentore.
- (e) chiuso dall'owner il 2026-11-14, in «Il buco dell'orologio». Il
  `taken_at` futuro precede questa ADR. La correzione di radice è l'opzione E.
  Reintrodurre la tolleranza sui timestamp futuri (opzione A) è il
  fallimento: un salto indietro può espellere un detentore vivo. La slice
  dell'emendamento di ADR-0094 va rossa se, con `beat_boot` di questo boot,
  l'età torna all'orologio di parete, o se una riga con le colonne nulle non
  ricade sulla regola di oggi.

Reversibilità alta per le slice 1–3. Le colonne sono additive. Senza
`mode=ephemeral` torna il rifiuto di ADR-0103. La ri-acquisizione si spegne
tornando all'uscita dell'Emendamento №3 se (d) si vede in uso.

## Piano a tappe e accettazione

Questa PR è la decisione, i rimandi, l'evidenza, le colonne descritte in
`MUFFIN-HOME.md`, la usage di `--session`, e la prosa falsa in
`core/gateway/service.ts`. Non è una slice di comportamento.

**Slice 1 — ri-acquisizione al risveglio, e il messaggio.** CRITICAL.
`service.test.ts`: la richiesta al modello parte prima del salto d'orologio,
non è solo un job armato e non ancora partito. Oltre l'orizzonte duro, nessun
altro detentore → lo stesso processo, `holder_id` nuovo da `mintHolderId`
dentro la transazione immediata, `since` invariato, non si chiama
`GatewayLock.claim`, non si esce, il log non dice «presa da un altro
processo». Il run già dentro `run()` finisce: non si abortisce, non passa
alla lane, una sola chiamata al modello (`job_fires` una riga). Stesso salto
con un altro detentore vivo → `myHolderId` invariato, `stillOwner()` falso,
nessun conio, il drain è fuori dalla transazione, il log nomina l'altro, esce
0, non si consegna. Una scrittura di refresh col `holder_id` vecchio cambia 0
righe sul lock; `checkpoint` / `finish` del turno non sono quella prova.
Mutazioni, tutte rosse: riusare il `holder_id` vecchio; abortire il run in
volo e lasciare che la lane chiami il modello. `doctor` riporta `exited_at` /
`exit_reason` solo se il processo se n'è andato davvero.

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

**Emendamento di ADR-0094 — età del battito.** CRITICAL, documento a parte.
Dopo le slice 1–3, prima della slice 4. La decisione è «Il buco
dell'orologio». Questa PR non contiene quel testo. La slice 4 giudica
l'uscita 2 sull'età che `heldBy` calcola dopo l'emendamento.

**Mitigazione B — `taken_at` nel futuro.** Slice a parte, adesso. `doctor`
segnala un `taken_at` futuro; `muffin gateway unlock --confirm` libera la
riga. Non è l'opzione E e non aspetta le slice 1–3.

**Slice 4 — supervisore di container, e vivo ma fermo.** `unit.test.ts`:
`--supervisor docker` stampa `restart: unless-stopped`, `stop_grace_period:
75s`, la healthcheck, e non scrive file; `init: true` solo con un'immagine
di terzi. L'entrypoint ufficiale usa `tini -s`. Sul percorso lungo, 78 non va
in loop (`sleep infinity`); `init-from-secret` esce ancora 78. `gateway
status`: effimero → 1; incarnazione tenuta, età del battito come la calcola
`heldBy` maggiore di `WATCHDOG_SEC`, e status diverso da `drenaggio` → 2; un
drenaggio già più lungo di `WATCHDOG_SEC`, con `status = drenaggio` scritto
dall'update recintato senza muovere `taken_at`, non è 2. La mutazione in cui
`holder_id` non è il token di questa istanza cambia 0 righe e non pubblica
`drenaggio` sul nuovo detentore. La healthcheck uccide il pid 1 solo sul 2.
`supervisor.test.ts`: unit abilitata e claim `supervisor=none` → warn
«avviato a mano». Accettazione: `gateway run` come processo sotto un pid 1
simulato, poi SIGTERM → 143 entro il drenaggio, e per tutta quell'attesa
`gateway status` non esce 2.

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
