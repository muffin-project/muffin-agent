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

# `git archive` e non un bind mount: node_modules di macOS contiene binding
# nativi darwin (better-sqlite3) che su Linux non caricano, e la copia
# dell'albero intero sarebbe lenta. Cosi il container vede solo cio che e
# tracciato, e si costruisce le sue dipendenze.
git -C "$REPO" archive HEAD -o "$OUT/repo.tar"

# Le due opzioni di sicurezza sono l'equivalente container del profilo AppArmor
# che il workflow installa su ubuntu-latest: il seccomp di default di Docker
# blocca unshare(CLONE_NEWUSER), quindi bwrap non crea il namespace e il probe
# — correttamente — rifiuta di dire che il sandbox contiene. Su una VPS Linux
# vera non servono queste due: serve il profilo AppArmor per bwrap.
docker run --rm \
  --security-opt seccomp=unconfined \
  --security-opt apparmor=unconfined \
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
    # NB: questa copia usa lo stesso .tar da `git archive` di /app sopra, quindi
    # non porta .git: `muffin --version` qui sotto legge "build sconosciuta"
    # per costruzione, non per un difetto di install.sh — verificato a mano
    # con `git clone --depth 1` (shallow, ha comunque .git) fuori da questo
    # gate (v. slice/installazione-provata): stesso INSTALL_EXIT=0, e
    # `muffin --version` legge lo sha vero invece di "build sconosciuta". Il
    # passaggio da archive a clone per /app stesso e un difetto di trasporto
    # gia in lavorazione altrove: non duplicato qui.
    mkdir -p /install-check && tar xf /repo.tar -C /install-check
    IHOME=/tmp/install-home
    mkdir -p "$IHOME"
    chown -R nobody /install-check "$IHOME"
    IAS="runuser -u nobody -- env HOME=$IHOME"
    echo "=== INSTALL.SH (non-root, da zero) ==="
    $IAS bash /install-check/install.sh < /dev/null
    $IAS env PATH="$IHOME/.local/bin:/usr/local/bin:/usr/bin:/bin" muffin --version

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
    set +e
    $AS npx vitest run --config vitest.acceptance.config.ts --reporter=dot
    rc=$?
    echo "ACCEPT_EXIT=$rc"
    # L'ultimo comando eseguito qui e quello il cui exit status diventa quello
    # di questo `bash -c`, quindi di `docker run`, quindi di questo script
    # (`set -e` in testa al file): un `set -e` come ultima riga e sempre
    # successo (riabilitare unopzione non fallisce mai), quindi mascherava
    # ACCEPT_EXIT=1 dietro uno script che usciva 0 — verificato iniettando
    # un `false` al posto di vitest: lo script tornava 0 con ACCEPT_EXIT=1
    # nel log. `exit "$rc"` e lultimo comando adesso, cosi chi consuma questo
    # script ($? dopo la chiamata, non il testo del log) vede il rosso vero.
    exit "$rc"
  '
