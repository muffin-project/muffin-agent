#!/usr/bin/env bash
#
# L'accettazione su Linux, in locale, dentro un container.
#
# Perche esiste: `.github/workflows/accettazione.yml` e il posto giusto per
# questa suite, e mentre i minuti GitHub non ci sono resta l'unico modo di
# vedere Linux — che e la piattaforma dove Muffin va a vivere, mentre lo
# sviluppo si fa su macOS. Una prova verde solo su macOS prova la macchina che
# non conta (stessa ragione scritta in testa al workflow).
#
# Non e una seconda configurazione di contenimento: prepara gli stessi
# prerequisiti del workflow (bubblewrap, socat, ripgrep) e gira la stessa
# suite. Se le due divergono, quella giusta e il workflow.
#
# ATTENZIONE: prova cio che e **committato**, non il working tree. Il clone qui
# sotto prende il ramo, quindi una modifica non committata non entra nel
# container e il verde che ne esce parla di HEAD. Committa prima di girarlo,
# oppure quel verde risponde a una domanda diversa da quella che hai fatto.
#
#   evals/acceptance/gate-linux.sh <repo> <dir-di-lavoro>
#   MUFFIN_GATE_IMAGE=<immagine> evals/acceptance/gate-linux.sh …
#
# L'immagine e un parametro perche su una macchina senza accesso al registry
# si riusa quello che c'e gia in locale: Node viene installato solo se manca.
# Provato la prima volta (26/08/2026) con un'immagine Debian sostitutiva,
# perche il pull di node:22-bookworm era bloccato su quella macchina.
set -euo pipefail

REPO="${1:?uso: gate-linux.sh <repo> <outdir>}"
OUT="${2:?uso: gate-linux.sh <repo> <outdir>}"
IMAGE="${MUFFIN_GATE_IMAGE:-node:22-bookworm}"
mkdir -p "$OUT"

# Un clone shallow e non un bind mount: node_modules di macOS contiene binding
# nativi darwin (better-sqlite3) che su Linux non caricano, e la copia
# dell'albero intero sarebbe lenta. Cosi il container vede solo cio che e
# tracciato, e si costruisce le sue dipendenze.
#
# Clone e non `git archive`, dal 27/08: `git archive` non porta `.git`, e senza
# checkout Git `muffin --version` dice "build sconosciuta" e `doctor` sputa un
# warning di deriva per OGNI file di default (nove, sull'albero attuale). Lo
# scenario A10 dichiara quali warning si aspetta a ogni passo del giro, quindi
# andava rosso — per un artefatto del trasporto, non per Linux. Il percorso
# vero di installazione parte da un clone (`install.sh`: "Run from a clone of
# this repo"), quindi e da un clone che va provato.
RAMO=$(git -C "$REPO" rev-parse --abbrev-ref HEAD)
rm -rf "$OUT/src"
if [ "$RAMO" = "HEAD" ]; then
  git clone --depth 1 "file://$(cd "$REPO" && pwd)" "$OUT/src" -q
  git -C "$OUT/src" fetch --depth 1 origin "$(git -C "$REPO" rev-parse HEAD)" -q
  git -C "$OUT/src" checkout -q FETCH_HEAD
else
  git clone --depth 1 --branch "$RAMO" "file://$(cd "$REPO" && pwd)" "$OUT/src" -q
fi
# `COPYFILE_DISABLE=1`: bsdtar su macOS infila un `._<nome>` accanto a ogni file
# per gli attributi estesi, e dentro il container vitest li raccoglie come test
# (`._a-lifecycle.accept.ts`) e fallisce a caricarli. `git archive` non aveva
# questo problema; il clone lo ha introdotto, e questa riga lo chiude.
COPYFILE_DISABLE=1 tar cf "$OUT/repo.tar" -C "$OUT/src" .
# The commit this gate must measure, passed into the container so the install
# leg can prove it built THIS tree and not something downloaded from the
# network (#702 made the personal default fetch public `main`; checkout mode is
# how the gate binds the installer to the candidate).
EXPECTED_SHA=$(git -C "$OUT/src" rev-parse --short=12 HEAD 2>/dev/null || echo "")
# Fail closed: without the sha the tree-identity assertion below would silently
# disappear, which is the failure this repository keeps paying for.
[ -n "$EXPECTED_SHA" ] || { echo "gate-linux: non riesco a leggere lo sha in prova da $OUT/src" >&2; exit 1; }

# Le due opzioni di sicurezza sono l'equivalente container del profilo AppArmor
# che il workflow installa su ubuntu-latest: il seccomp di default di Docker
# blocca unshare(CLONE_NEWUSER), quindi bwrap non crea il namespace e il probe
# — correttamente — rifiuta di dire che il sandbox contiene. Su una VPS Linux
# vera non servono queste due: serve il profilo AppArmor per bwrap.
#
# ## Perche puo servirne una terza, e perche va detto invece che aggiunta
#
# Su Docker Desktop per macOS quelle due non bastano. Misurato il 04/09/2026
# sull'immagine del gate, root e non-root allo stesso modo:
#
#   bwrap --unshare-all --dev-bind / / true              OK
#   bwrap --unshare-all --proc /proc --dev-bind / / true bwrap: Can't mount proc
#                                                        on /newroot/proc:
#                                                        Operation not permitted
#
# E' il **mount di /proc** dentro il namespace a essere rifiutato, non la
# creazione del namespace. `--cap-add SYS_ADMIN` non lo sblocca: solo
# `--privileged`. Senza, la gamba Linux e' rossa su una diagnosi che non
# riguarda Muffin — l'owner ha visto esattamente questo, e un rosso che non
# nomina un difetto del codice e' peggio di un gate assente.
#
# Percio': si **prova** cosa questo host permette, e si sceglie di conseguenza.
# `--privileged` non indebolisce cio' che il gate misura — l'oggetto sotto
# esame e' il sandbox di Muffin, non l'isolamento di Docker, e bwrap esegue lo
# stesso percorso in entrambi i casi — ma e' una differenza reale rispetto al
# runner di GitHub, quindi la riga finale la porta sempre invece di tacerla.
# >>> SCELTA PRIVILEGI PROVATA DA gate-linux.test.ts
# Una funzione e non righe sciolte: e' una decisione che puo far uscire lo
# script, e una decisione non provata e' esattamente cio' che questa repo
# continua a pagare.
scegli_privilegi() {
  PRIVILEGI=()
  MODO="senza privilegi (come il runner GitHub)"
  if docker run --rm --security-opt seccomp=unconfined --security-opt apparmor=unconfined \
     "$IMAGE" bwrap --unshare-all --proc /proc --dev-bind / / true >/dev/null 2>&1; then
    return 0
  fi
  if docker run --rm --privileged --security-opt seccomp=unconfined --security-opt apparmor=unconfined \
     "$IMAGE" bwrap --unshare-all --proc /proc --dev-bind / / true >/dev/null 2>&1; then
    PRIVILEGI=(--privileged)
    MODO="CON --privileged: questo host non monta /proc in un namespace annidato"
    echo "gate-linux: $MODO" >&2
    return 0
  fi
  echo "gate-linux: bwrap non monta /proc nemmeno con --privileged su questo host." >&2
  echo "gate-linux: la gamba Linux NON e' eseguibile qui — non e' un difetto del codice." >&2
  return 2
}
# <<< SCELTA PRIVILEGI PROVATA DA gate-linux.test.ts

scegli_privilegi || exit $?

set +e
docker run --rm \
  "${PRIVILEGI[@]}" \
  --security-opt seccomp=unconfined \
  --security-opt apparmor=unconfined \
  -e EXPECTED_SHA="${EXPECTED_SHA:-}" \
  -v "$OUT/repo.tar:/repo.tar:ro" \
  -w /app \
  "$IMAGE" \
  bash -euo pipefail -c '
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq >/dev/null
    # systemd non serve per farlo girare: serve systemd-analyze, che e il
    # parser con cui lo scenario A10 valida la unit di produzione. Senza, la
    # gamba Linux di A10 degrada a "non eseguibile qui" invece di verificare.
    apt-get install -y -qq bubblewrap socat ripgrep curl ca-certificates systemd >/dev/null
    if ! command -v node >/dev/null; then
      curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
      apt-get install -y -qq nodejs >/dev/null
    fi
    echo "NODE=$(node --version)  UNAME=$(uname -sm)"
    mkdir -p /app && tar xf /repo.tar -C /app

    # install.sh e il percorso supportato per un owner che clona su una VPS —
    # mai provato in container prima del 27/08/2026. `npm i -g .` da sorgente
    # muore li con `tsc: not found` (npm -g non installa le devDependencies),
    # ma install.sh gira `npm install` locale, che le installa. Copia a parte
    # e non-root, cosi la prova non riusa la /app gia compilata sopra e misura
    # davvero una compilazione da zero: se `prepare`/`compile` si rompono di
    # nuovo, questo va rosso prima di ACCETTAZIONE, non dopo.
    # NB: questa copia usa lo stesso .tar di /app sopra, e dal 27/08 quel tar
    # viene da `git clone --depth 1` (non piu `git archive`, v. sopra) — porta
    # .git. `muffin --version` qui sotto legge quindi lo sha vero, non "build
    # sconosciuta": verificato girando questo stesso gate fuso (v. PR).
    mkdir -p /install-check && tar xf /repo.tar -C /install-check
    IHOME=/tmp/install-home
    mkdir -p "$IHOME"
    chown -R nobody /install-check "$IHOME"
    IAS="runuser -u nobody -- env HOME=$IHOME"
    echo "=== INSTALL.SH (non-root, da zero) ==="
    # >>> BLOCCO INSTALL PROVATO DA gate-linux.test.ts
    # `--checkout` (#702): the mode is explicit now, and the gate must build
    # THIS tree. Without it a clone is a *personal* install, which clones public
    # `main` from the network and would measure a tree nobody is testing.
    $IAS bash /install-check/install.sh --checkout < /dev/null
    VERSIONE=$($IAS env PATH="$IHOME/.local/bin:/usr/local/bin:/usr/bin:/bin" muffin --version)
    echo "$VERSIONE"
    if [ -n "${EXPECTED_SHA:-}" ]; then
      case "$VERSIONE" in
        *"$EXPECTED_SHA"*) ;;
        *) echo "gate-linux: install.sh --checkout built the wrong tree: expected $EXPECTED_SHA in: $VERSIONE" >&2; exit 1 ;;
      esac
    fi
    # <<< BLOCCO INSTALL PROVATO DA gate-linux.test.ts

    npm ci --no-audit --no-fund >/dev/null
    # Non-root, come in CI: il probe del sandbox RIFIUTA di rispondere da root
    # (root aggira la restrizione userns, quindi il verde sarebbe falso), e
    # senza contenimento il runtime rifiuta gli script, lasciando lo scenario
    # ad aspettare un effetto che non arriva mai. Usa nobody: esiste ovunque,
    # useradd no. NB: niente apostrofi qui dentro, chiudono la stringa.
    HOMEDIR=/tmp/gate-home
    mkdir -p "$HOMEDIR"
    chown -R nobody /app "$HOMEDIR"
    AS="runuser -u nobody -- env HOME=$HOMEDIR"
    echo "=== PROBE SANDBOX (non-root) ==="
    $AS npx tsx -e "import(\"./core/sandbox/probe.js\").then((m)=>console.log(JSON.stringify(m.probeSandbox())))"
    echo "=== ACCETTAZIONE (non-root) ==="
    # Il secondo comando e il secondo gate, quello che il workflow tratta come
    # autoritativo sui requisiti DAY-1. Finche non c-era, questo script provava la suite
    # su Linux e non provava mai il report che ne decide il significato — cioe
    # proprio dove i due divergono: su Linux b-job-script si salta, e
    # classificare quel salto come dichiarato invece che come rosso e codice che
    # gira solo qui.
    #
    # I due exit non si stampano soltanto: decidono. Prima questo blocco finiva
    # con `set -e`, che esce 0 — quindi il container usciva 0 con la suite
    # rossa, `docker run` usciva 0, e questo script, nonostante `set -euo
    # pipefail`, diceva verde. Il workflow non tollera nessuno dei due step
    # (.github/workflows/accettazione.yml), quindi i due divergevano esattamente
    # nella proprieta che conta, e chi lanciasse questo da un hook o da un loop
    # leggeva «gate Linux verde». `gate-linux.test.ts` estrae il blocco qui
    # sotto e lo esegue con esiti iniettati: se torna a ingoiare un rosso, muore.
    # >>> BLOCCO PROVATO DA gate-linux.test.ts
    set +e
    $AS npx vitest run --config vitest.acceptance.config.ts --reporter=dot --reporter=json --outputFile.json=/tmp/gate-home/accettazione.json
    ACCEPT_EXIT=$?
    $AS env MUFFIN_ACCEPT_RESULTS=/tmp/gate-home/accettazione.json npx tsx evals/acceptance/report.ts
    REPORT_EXIT=$?
    set -e
    echo "ACCEPT_EXIT=$ACCEPT_EXIT  REPORT_EXIT=$REPORT_EXIT"
    if [ "$ACCEPT_EXIT" -ne 0 ] || [ "$REPORT_EXIT" -ne 0 ]; then exit 1; fi
    # <<< BLOCCO PROVATO DA gate-linux.test.ts
  '
GATE_EXIT=$?
set -e

# Esplicito e non implicito: `set -e` avrebbe gia fatto uscire lo script su un
# `docker run` non-zero, ma senza dire nulla. Un gate che non dice se e verde o
# rosso si legge come un comando qualsiasi, e questo non lo e.
if [ "$GATE_EXIT" -ne 0 ]; then
  echo "GATE LINUX ROSSO (exit $GATE_EXIT) — vedi ACCEPT_EXIT/REPORT_EXIT qui sopra" >&2
else
  # Il modo entra nella riga verde, non solo nel rumore sopra: chi rilegge il
  # verdetto domani deve sapere in che condizioni e' stato ottenuto.
  echo "GATE LINUX VERDE — $MODO"
fi
exit "$GATE_EXIT"
