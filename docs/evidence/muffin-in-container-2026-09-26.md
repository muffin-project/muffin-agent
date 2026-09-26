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

## Peer, per problema

- OpenClaw (docs.openclaw.ai/install/docker, letto il 2026-09-26): percorso
  Docker ufficiale, compose, immagine costruita dalla repo, onboarding headless,
  `doctor --json` nel container. La sandbox dell'agente usa Docker stesso.
- Hermes Agent (hermes-agent.nousresearch.com, pagina Docker e backend terminale,
  letti il 2026-09-26): immagine e compose ufficiali; l'isolamento dei comandi è
  un backend Docker (container per i comandi). Un'issue pubblica (#32049) mostra
  un effetto collaterale: gli strumenti di file dentro il backend scrivono in una
  copia dello stato invece che nell'originale.

Entrambi trattano Docker come percorso ufficiale, ed entrambi isolano i comandi
**con Docker**: da dentro un container questo richiede il socket del daemon,
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
- Sull'host Ubuntu 24.04 la sandbox contiene solo con il profilo
  `muffin-userns` insieme a `seccomp` e `systempaths=unconfined` (misurato). Se
  una versione di Docker o di AppArmor smettesse di permetterlo, la
  documentazione deve dire che su quegli host la shell resta spenta senza
  `privileged`, non suggerirlo.
