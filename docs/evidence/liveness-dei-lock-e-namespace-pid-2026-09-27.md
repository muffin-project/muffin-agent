# La liveness dei lock e i namespace pid (2026-09-27)

Evidenza datata per ADR-0092 e per la claim di
`slice/lock-holder-liveness-by-incarnation`. Non è autorità corrente: la
decisione sta in ADR-0092, il meccanismo in `core/lock/incarnation.ts`.

## Domanda

Come decidere che il detentore di una riga di lock è morto, quando il pid della
riga può appartenere a un altro processo (riavvio di un container) o non
significare nulla per chi legge (un secondo container sulla stessa home)?

## Cosa è stato osservato in Muffin

Percorso di produzione, base `origin/dev` `59501fd5`:

- `heldBy` (`core/lock/durable.ts`) chiede `alive(pid)` prima dell'orizzonte;
  `alive` di default è `pidAlive`, cioè `kill(pid, 0)`.
- La stessa regola decide: il lock del gateway (`GatewayLock`, `readGateway`
  per `gateway status` e `doctor`), il send lock, il lock dell'estrazione della
  memoria, e i turni (`TurnStore.reclaim` a ogni avvio di un runtime,
  `TurnStore.health` in `doctor`).
- Il processo che esegue sempre `reclaim` è anche il primo di ogni container:
  l'entrypoint del percorso Docker lancia `muffin doctor` e poi il gateway.

Misure (una review indipendente di `slice/experimental-docker-compose`, Docker
29.8, WSL2):

- dopo l'OOM del gateway (pid 7) il container riavviato ha rifiutato di partire
  con `un gateway è già attivo (pid 7)` ed exit 75 per 24 volte, 27 riavvii,
  circa 17 minuti e mezzo; è ripartito solo perché un riavvio ha preso il pid 6;
- un OOM del pid 7 riavviato come pid 8, e un SIGKILL del pid 8 riavviato come
  pid 7, sono ripartiti subito: l'esito dipende da quale pid tocca al processo
  nuovo.

Nel codice, l'emendamento №3 di ADR-0035 aveva scartato l'ora di avvio del
processo perché non portabile, contando su un riuso dei pid «in ore».

## Peer, per problema

- **PostgreSQL**, `CreateLockFile` (`src/backend/utils/init/miscinit.c`, master
  letto il 2026-09-27): considera stantio un `postmaster.pid` che contiene il
  proprio pid, quello del padre o del nonno, perché «un reboot assegna con
  buona probabilità esattamente lo stesso pid»; poi usa `kill(pid, 0)` per gli
  altri, e in più controlla se il vecchio segmento di memoria condivisa è ancora
  attaccato, cioè una prova tenuta dal kernel e non da un numero.
- **Il socket di controllo del gateway** (`core/gateway/control-socket.ts`)
  cita un peer che scopre lo stato del gateway leggendo un file di stato che
  può sopravvivere a chi l'ha scritto, e conclude che un socket connettibile
  «è» la liveness, senza euristiche sui pid. Vale per un processo che ascolta:
  il gateway sì, un `muffin run` o un `muffin memory extract` no.

La lezione estratta, non l'architettura: la prova migliore di vita è una
risorsa che il kernel rilascia alla morte del processo.

## Evidenza a favore della scelta

Prototipo (SQLite con `locking_mode = EXCLUSIVE`, sonda con `busy_timeout` 0),
misurato su Docker Linux con un volume condiviso:

- dalla stessa connessione di processo, seconda connessione: vivo;
- da un altro container, cioè un altro namespace pid, mentre il detentore gira:
  vivo;
- dallo stesso altro container subito dopo `kill -9` del detentore: morto.

Implementazione (`core/lock/incarnation.ts`), `evals/system/lock-pid-namespaces.sh`
con il `DurableLock` di produzione su una home in bind mount, immagine
`node:22-bookworm`:

| Caso | `origin/dev` 59501fd5 | con ADR-0092 |
|---|---|---|
| riavvio: il rimpiazzo di un container ucciso (stesso pid 1) | rifiutato | prende il lock subito |
| vicino, mentre il detentore vive | rifiutato | rifiutato |
| vicino, subito dopo `kill -9` del detentore | rifiutato (vede vivo il proprio pid 1) | prende il lock subito |

Test rossi prima della modifica e verdi dopo:

- `core/lock/durable.test.ts`, «a holder is judged by its process»: riuso del
  pid (il test riscrive il pid di un detentore ucciso con quello di un processo
  vivo) e vicino (lo riscrive con un pid morto mentre il detentore vive);
- accettazione A1 (il gateway ucciso con SIGKILL, con il pid della riga
  riscritto come in un container riavviato: prima restava «attivo») e B5 (il
  turno ucciso a metà: prima `doctor` non lo nominava).

Mutazioni, ciascuna rossa: la liveness che ignora l'incarnazione (unit, A1,
B5); il file non tenuto bloccato (unit, compreso il controllo dallo stesso
processo); i token coniati senza incarnazione (unit).

## Evidenza contraria e limiti

- Un falso «vivo» resta possibile per un processo bloccato ma vivo: per questo
  l'orizzonte duro non cambia.
- Tre test esistenti scrivevano righe a nome di un pid finto dal processo di
  test: con l'incarnazione del processo di test risultavano vive. Non era un
  difetto dei test: nessun processo deve mettere la propria incarnazione in una
  rivendicazione fatta a nome di un altro pid (ADR-0092, punto 4).
- La chiusura di un descrittore rilascia tutti i lock POSIX del processo sul
  file: il meccanismo regge solo se il processo detentore non apre quei file
  fuori da SQLite. Nessun codice attuale lo fa; un test lo sorveglia.
- Solo Linux misurato (WSL2 e container Debian). macOS usa gli stessi lock
  POSIX tramite SQLite, ma non è provato.
- Filesystem di rete: non supportati, come non lo è già `muffin.db`.

## Council

Cinque consulenti indipendenti, revisione anonima incrociata, sintesi. La
candidata «stesso pid» (A) è stata scartata dopo che la revisione ha mostrato
il `reclaim` che percorre righe di altri processi; la candidata «ora di
avvio» (B) è dominata; «solo documentazione» non ha avuto sostenitori. La
sintesi ha scelto il lock del kernel (C), con l'incarnazione registrata nelle
righe e la regola del pid per le righe vecchie. Due punti della sintesi non
sono stati adottati: una colonna nuova (sostituita dal token, per non migrare
lo schema) e il registro di quale ramo della regola ha deciso (lasciato come
seguito). È stato scartato anche l'argomento di un consulente che proponeva di
accorciare gli orizzonti: un processo vivo ma bloccato tiene il lock del
kernel, quindi l'orizzonte resta l'unica uscita.

## Cosa ribalterebbe la conclusione

Le osservazioni elencate in ADR-0092 §«Cosa la ribalta».
