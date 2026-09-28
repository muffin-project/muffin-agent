# Muffin in un container: cosa regge e cosa no (2026-09-26)

Evidenza datata per la claim di `slice/experimental-docker-compose`. Non è
autorità corrente: la posizione ufficiale resta quella di
`docs/user/INSTALL.md` («Native first; Docker is not a second installer yet»).

## Domanda

Offrire, in `contrib/docker/`, un percorso Docker Compose **sperimentale**
per il gateway, senza cambiare la posizione di `INSTALL.md` e senza container
privilegiati? E con quale postura per la sandbox degli strumenti shell?

## Cosa è stato osservato

Build `252c1afb` (main) e `032c4ed1` (dev), immagine costruita con bubblewrap
0.13.0 upstream, processo non-root, su due host di prova:

- **host WSL2 senza AppArmor** (kernel 6.18);
- **host Ubuntu 24.04 con AppArmor** e `kernel.apparmor_restrict_unprivileged_userns=1`
  (kernel 6.8).

| Configurazione del container | host WSL2 | host Ubuntu 24.04 |
|---|---|---|
| default Docker | `bwrap: No permissions to create new namespace` | `bwrap: No permissions to create a new namespace`; shell spenta, `doctor` e gateway concordi |
| `seccomp=unconfined` | contenimento riuscito (`a real containment ran and held`) | non provata |
| `seccomp=unconfined` + `systempaths=unconfined` (override `sandbox`), AppArmor di default | contenimento riuscito | `bwrap: Failed to make / slave: Permission denied`: il profilo AppArmor di default di Docker nega i mount; shell spenta, `doctor` e gateway concordi |
| `seccomp=unconfined` + `apparmor=unconfined` | contenimento riuscito | `userns_denied: bwrap: loopback: Failed RTM_NEWADDR`: un processo non confinato riceve il namespace senza capability |
| `seccomp=unconfined` + profilo AppArmor `flags=(unconfined) { userns, }` | non applicabile | `Can't mount proc on /proc: Operation not permitted` (Docker oscura parti di `/proc`) |
| come sopra + `privileged: true` | non provata | contenimento riuscito |
| come sopra + `systempaths=unconfined` al posto di `privileged` | accettata da `docker compose` v5.5.1: `MaskedPaths` e `ReadonlyPaths` vuoti | contenimento riuscito, non-root con `cap_drop: ALL` e `no-new-privileges`: strumenti shell registrati ed esposti, `doctor` e gateway concordi |

Le celle dell'host Ubuntu 24.04 (Docker 29.6.0, Compose 5.1.4) vengono da due
misure: il probe diretto di bubblewrap, che dà i messaggi di errore citati, e
`evals/install/docker.sh` a `281148d2`, eseguito con e senza
`MUFFIN_EVAL_APPARMOR=1`, che dà l'esito della sandbox di Muffin.

Altri fatti misurati:

- un orchestratore che passa le stringhe `security_opt` del compose direttamente
  all'API del daemon fa fallire il deploy con `invalid --security-opt 2:
  "systempaths=unconfined"`: l'opzione esiste solo nella CLI (`docker run`,
  `docker compose`), che la traduce lato client;
- con i Debian e Ubuntu attuali il bubblewrap di sistema è sotto 0.12.0, e il
  gate `core/sandbox/shell-boundary.ts` spegne gli strumenti shell: l'immagine
  deve compilare bubblewrap upstream;
- il probe della sandbox rifiuta root; `TMPDIR=/tmp` rispetta il limite dei
  socket Unix;
- nessun systemd nel container: `muffin gateway run` in primo piano, con la
  restart policy al posto della unit; `muffin update` non si applica (si
  ricostruisce l'immagine);
- la home privata (`core/config/private-fs.ts`) rifiuta i symlink: il modello
  whisper va copiato, non linkato;
- con la checkout di proprietà di root e il processo `node`, git rifiuta il
  repository e `muffin doctor` non sa quale commit gira: serve `safe.directory`;
- un turno reale attraverso il gateway in container ha risposto, e una richiesta
  `shell_run` del modello si è fermata sulla conferma dell'owner (ADR-0091);
- fuori da swarm, Compose monta il file di un segreto così com'è sull'host e ne
  ignora `uid`, `gid` e `mode`: un file 0600 di un altro uid (per esempio creato
  con `sudo`) non è leggibile dall'utente 1000 del container, e `init` si ferma
  con `Permission denied`.

## Contesto di build (2026-09-28, review di #729)

La prima forma passava al builder la `.git` del checkout (contesto `.git`
soltanto, poi un clone a profondità 1 nello stage di build). L'immagine finale
non la conteneva, ma il layer dello stage di build e la cache di BuildKit sì:
history, reflog, objects e `config`, che può portare un URL con credenziali ed
esce dalla macchina con un export della cache. E da un worktree collegato, dove
`.git` è un file, la build falliva. La review ha chiesto lo stesso invariante
(commit esatto, niente file sporchi o non tracciati) senza `.git` nel contesto.

Misurato in WSL2 (amd64, Docker 29.8.0) sul commit `34e51cbc`, con init reale e
`muffin doctor` su volumi nuovi:

- `git archive HEAD` in `docker build -`, con il Dockerfile dentro l'archivio:
  accettato; nessuna voce `.git` nel contesto;
- senza alcun `.git` nell'immagine `doctor` perde due cose: la riga `build`
  diventa «nessun checkout Git: non so quale commit stia girando» e gli 11 file
  di default copiati da `init` passano da «allineato a HEAD» a «nessun checkout
  Git leggibile»: 12 avvisi permanenti su un'installazione sana. Anche la riga
  di avvio dell'entrypoint diventa `build=unknown`;
- ricostruendo nello stage di build l'oggetto commit (il testo grezzo di
  `git cat-file commit`, passato nel contesto) sopra i file dell'archivio, lo
  SHA è identico a quello dell'host, il repository è shallow con un commit,
  senza remote, con la sola `config` di `git init`, e `doctor` è identico riga
  per riga a quello della prima forma;
- lo stesso stage confronta `git write-tree` con il tree del commit: un file in
  più (`secret.env`) o un file tracciato modificato (`README.md`) nel contesto
  fanno fallire la build con i due tree a confronto.

Alternative scartate: il solo archivio (i 12 avvisi sopra); un worktree
temporaneo (il suo file `.git` va escluso comunque, e la build scrive nel
repository e va ripulita: il worktree di `muffin update` ha senso perché la
release resta ed è ciò che gira, qui l'albero serve pochi secondi); far leggere
a `doctor` un file di metadati al posto di git (tocca il codice runtime, fuori
dal perimetro di questa PR).

## Tetti di risorse del container

La sandbox limita il tempo (timeout con kill del gruppo di processi) e l'output
(30.000 caratteri), non memoria né processi: bubblewrap non crea un cgroup, e
nemmeno la unit systemd dell'installazione nativa imposta `TasksMax` o
`MemoryMax`. Un comando che forka o alloca senza fine consuma le risorse di chi
ospita il gateway. Nel percorso container la risposta è un tetto sul cgroup del
container, che i processi della sandbox ereditano.

Misurato su WSL2 (Docker Engine 29.8, cgroup v2, driver `systemd`):

- con `pids_limit` i processi lanciati **dentro bubblewrap** contano nello
  stesso tetto: `pids.events` registra i fork rifiutati;
- quando bubblewrap esce, il suo PID namespace muore e i figli spariscono
  subito; i processi orfani fuori dalla sandbox restano zombie e occupano il
  tetto se il PID 1 non li raccoglie (misurato con `node` come PID 1), mentre nel
  container vero il PID 1 è `tini` e li raccoglie;
- con il solo `mem_limit` Docker concede altrettanto swap (`memory.swap.max`
  uguale alla memoria): `memswap_limit` uguale a `mem_limit` rende il tetto reale;
- al tetto di memoria l'OOM killer uccide il processo più grande: un processo che
  alloca 1,5 GiB muore (exit 137) e il gateway resta in piedi;
- il tetto conta thread, non solo processi: a riposo il container ha 9 task
  (`tini`, il gateway `node` con 7 thread, il processo che legge il contatore),
  89-229 MiB.

Misurato nella review indipendente del 2026-09-27, con l'executor di produzione
(`SandboxExecutor`) dentro il container e tetto a 1g:

- un fork storm tiene `pids.current` fermo al tetto per tutta la durata del
  comando; nel frattempo nessun altro processo del container può forkare (note
  vocali, server MCP, il comando successivo) fino al timeout del comando (120 s
  di default, 600 al massimo);
- 14 processi da 90 MiB, ciascuno sotto il gateway: l'OOM killer uccide il
  gateway, il container si riavvia;
- `dd` su `/dev/shm` dentro la sandbox: `/dev` e `/dev/shm` sono tmpfs scrivibili
  creati da bubblewrap, le loro pagine contano nel cgroup ma non appartengono a
  nessun processo, quindi l'OOM killer uccide il gateway;
- non sono gli unici: nella sandbox sono tmpfs scrivibili e senza limite anche le
  maschere che nascondono le directory dei segreti (le due `secrets` e
  `/etc/ssh/ssh_config.d`), montate da sandbox-runtime con `--tmpfs`. Una
  scrittura da 64 MiB è riuscita in ciascuna, in entrambe le corsie, e la memoria
  del container è salita da 49 a 302 MiB con un processo da circa 3 MB di RSS
  (seconda review indipendente, 2026-09-27). Senza tetto, quindi, un comando può
  riempirne più d'uno, ciascuno fino a metà della RAM, e portare l'intero host in
  OOM: la deduzione precedente («si fermerebbe a metà della RAM») sbagliava nel
  verso pericoloso;
- `.State.OOMKilled` non è un indicatore affidabile: se il processo ucciso è il
  principale e il container riparte, torna `false` subito dopo il riavvio;
  `docker events --filter event=oom` registra ogni kill (misurato nella stessa
  review);
- lo stop di default di Docker (10 s) è più corto del drain del gateway (60 s): un
  `docker compose stop` durante un turno uccide il drain, e dopo il riavvio vale
  lo stesso difetto del lock descritto sotto. Il compose imposta
  `stop_grace_period: 75s`, come il `TimeoutStopSec` della unit systemd;
- dopo il riavvio il gateway può rifiutarsi di partire con `un gateway è già
  attivo (pid 7)`: il lock (`core/lock/durable.ts`, `heldBy`) giudica vivo il
  detentore dal solo pid, e in un container riavviato il nuovo gateway prende di
  solito lo stesso pid. Il rifiuto dura finché l'ultimo heartbeat del detentore
  morto non ha 30 minuti (6 × `STALE_AFTER_MS`). Misurato: circa 17 minuti di
  riavvii, finiti solo perché un riavvio ha preso il pid 6. È un difetto del lock
  che esiste per ogni kill del gateway in container, non introdotto dai tetti, ma
  i tetti rendono il kill un esito previsto;
- carico legittimo: ffmpeg e whisper-cli con il modello base su 60 s di audio,
  23 task al massimo, `memory.peak` del container 627 MiB; un processo `node`
  nudo (il minimo per un server MCP stdio) 43 MiB e 7 thread.

Il tetto di memoria quindi scambia la protezione dell'host con la disponibilità
del gateway: un comando fuori controllo non esaurisce l'host, ma in certe forme
fa riavviare il gateway, e finché il lock non è corretto il riavvio può costare
fino a 30 minuti.

| | Candidata | Pro | Contro |
|---|---|---|---|
| A | tetti sul container nel compose (`pids_limit`, `mem_limit`, `memswap_limit`) | nessun codice, misurabile, vale anche per la sandbox | solo per il percorso container; il tetto è condiviso con il gateway |
| B | limiti per comando nell'executor (`prlimit`) | vale anche per il nativo | `RLIMIT_NPROC` conta per utente, `RLIMIT_AS` per processo: nessuno dei due limita un albero di processi |
| C | `TasksMax` e `MemoryMax` nella unit systemd | vale per il nativo, stesso meccanismo di A | cambia il supervisore: va proposto a monte |
| D | nulla | zero manutenzione | ogni `shell_run` chiede conferma, ma un comando dall'aria innocua basta |

Scelta: **A** qui, **C** proposta a monte. Complementi a monte: alzare
`oom_score_adj` dei processi della sandbox (un processo può alzarlo senza
privilegi), così l'OOM killer sceglie loro anche quando sono tanti e piccoli;
limitare la dimensione dei tmpfs che la sandbox crea, perché nessun
`oom_score_adj` libera pagine che non appartengono a un processo (in bubblewrap
0.13.0 `--size` vale solo per `--tmpfs`: vale quindi per le maschere dei
segreti, che possono anche essere rese di sola lettura con `--remount-ro`, non
per il `/dev` creato da `--dev`, per cui serve un'altra strada);
e un lock che riconosca il detentore anche dall'identità del processo (per
esempio l'istante di avvio da `/proc`), non dal solo pid.

## Peer, per problema

- OpenClaw (docs.openclaw.ai/install/docker, letto il 2026-09-26): percorso
  Docker ufficiale, compose, immagine costruita dalla repo, onboarding headless,
  `doctor --json` nel container. La sandbox dell'agente usa Docker stesso.
- Hermes Agent (hermes-agent.nousresearch.com, pagina Docker e backend terminale,
  letti il 2026-09-26): immagine e compose ufficiali; l'isolamento dei comandi è
  un backend Docker (container per i comandi). Un'issue pubblica (#32049) mostra
  un effetto collaterale: gli strumenti di file dentro il backend scrivono in una
  copia dello stato invece che nell'originale.

- OpenJarvis (github.com/2ITFounder/OpenJarvis, letto il 2026-09-26): esegue il
  codice in un container per esecuzione, avviato con la CLI o l'SDK Docker, con
  512 MB, 1 CPU, 100 processi, root in sola lettura e `/tmp` in tmpfs. Anche qui
  serve il socket del daemon; il suo compose non lo monta, quindi in quel
  percorso la sandbox non c'è. I tetti per esecuzione sono lo spunto ripreso
  sopra, applicato al container del gateway.

Tutti e tre trattano Docker come percorso ufficiale, e tutti e tre isolano
l'esecuzione principale **con Docker**: da dentro un container questo richiede il socket del daemon,
cioè l'equivalente di root sull'host, che `INSTALL.md` esclude. La strada qui è
diversa: bubblewrap dentro il container, con permessi aggiuntivi opzionali e
stretti.

## Evidenza contraria

- `INSTALL.md` chiede, prima di considerare Docker, la prova che un percorso
  composto renda il viaggio dell'owner più semplice di quello nativo. Questa
  slice non la porta e non cambia quella posizione.
- Allentare il container (`seccomp=unconfined`, `systempaths=unconfined`) per
  far esistere la sandbox interna è uno scambio: se il processo venisse
  compromesso, il container difenderebbe meno. Il processo resta non-root, e
  nessuna opzione aggiunge capability o device.
- Un secondo percorso di installazione è un secondo percorso da mantenere
  (build, aggiornamento, backup).

## Tabella delle alternative

| | Candidata | Pro | Contro |
|---|---|---|---|
| A | `contrib/docker/` sperimentale: default senza permessi aggiuntivi (shell spenta, detto da `doctor`), override opzionali per la sandbox, eval di smoke | nessun cambio di posizione ufficiale; fail-closed di default; scelta esplicita di chi lo usa | un percorso in più da mantenere |
| B | Proporlo come secondo percorso ufficiale (INSTALL + ADR) | chiarezza per gli utenti Docker | manca l'evidenza end-to-end che INSTALL chiede |
| C | Includere `privileged: true` | funziona anche con gli strumenti che rifiutano `systempaths` | contraddice INSTALL; concede molto più del necessario, e sugli host misurati non serve |
| D | Nessun percorso Docker | zero manutenzione | chi usa Docker lo costruisce da solo, senza le misure sopra |

Scelta: **A**.

## Cosa falsificherebbe la scelta

- Con il compose di base, `doctor` riporta strumenti shell attivi **senza** un
  contenimento riuscito, o gli strumenti esistono mentre `doctor` li dice spenti:
  l'eval `evals/install/docker.sh` controlla questa coerenza in entrambe le
  posture.
- Con `compose.sandbox.yaml` su un host senza AppArmor il contenimento non
  riesce: la documentazione mentirebbe.
- Un uso legittimo (trascrizione di note vocali, bridge MCP) che supera 512
  processi o 2 GiB: i default sarebbero sbagliati, non solo stretti.
- Sull'host Ubuntu 24.04 la sandbox contiene solo con il profilo
  `muffin-userns` insieme a `seccomp` e `systempaths=unconfined` (misurato). Se
  una versione di Docker o di AppArmor smettesse di permetterlo, la
  documentazione deve dire che su quegli host la shell resta spenta senza
  `privileged`, non suggerirlo.
