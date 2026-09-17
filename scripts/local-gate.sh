#!/usr/bin/env bash
#
# Il gate locale: prova un COMMIT, non la cartella di chi lo lancia.
#
# Perche esiste: i minuti GitHub sono finiti, quindi `.github/workflows/` non
# gira. Questo script e il sostituto dichiarato, e il suo verde si scrive
# `LOCAL-GATE PASS @ <sha>` — mai «CI verde», perche non e CI: gira sulla
# macchina dell'owner, con la sua rete e la sua Docker.
#
# Perche clona invece di girare sul posto. Il 30/08/2026 la prima versione
# girava `npm test` nel checkout dell'owner e raccoglieva **945** file di test
# dove il repository ne ha 201. Gli altri 744 venivano da due alberi annidati
# e completi:
#
#   .codex/worktrees/   342 file   worktree di un altro agente
#   .releases/          402 file   le release affiancate di `muffin update`
#
# Il primo e nascosto da `.git/info/exclude`, il secondo da `.gitignore`:
# entrambi invisibili a `git status`, entrambi letti da vitest. Il gate
# chiedeva «working tree pulito», leggeva pulito, e certificava uno SHA con
# una misura fatta al 79% su copie congelate di *altri* commit — i 97 rossi
# che l'owner ha visto erano `.codex/worktrees/pr186-*`, cioe il ramo di una
# PR aperta.
#
# `vitest.ignored.ts` chiude quel buco per chi lancia `npm test` a mano. Qui
# serve la difesa piu forte: un clone di HEAD **fuori dal repository**, in cui
# non esiste nulla di non tracciato — nemmeno cio che Git non ignora. Il clone
# prova il commit; il working tree non entra.
#
#   npm run gate:local
#   MUFFIN_GATE_TIENI=1 npm run gate:local     # non cancella il clone
#
# ## Relazione con `npm run ci:local` (aggiunto 2026-09-04)
#
# Sono due gate diversi apposta, non due porte sullo stesso meccanismo. Questo
# script risponde "questo commit compila davvero un binario (`dist/cli/main.js`
# scritto, non solo un `tsc --noEmit` che esce zero) e la suite gira pulita da
# un clone esterno, senza la contaminazione di `.codex/worktrees/`/
# `.releases/` misurata sopra" — proprietà che nessun workflow GitHub verifica
# mai. `scripts/ci-local.ts` risponde una domanda diversa: "cosa direbbero i
# quattro job di `.github/workflows/` su questo commit, oggi, mentre i minuti
# sono fermi" — derivato dai file di workflow, non riscritto a mano. Fonderli
# indebolirebbe entrambi: la difesa contro i 945 file non è un passo di CI da
# derivare da uno YAML, e i quattro job non hanno un passo `npm run build` da
# cui `ci:local` potrebbe derivare l'assertizione su `dist/cli/main.js` — quel
# controllo resterebbe comunque scritto a mano, solo nel posto sbagliato.
# `test:acceptance:linux` (`GATE LINUX` sotto) resta chiamato da qui per
# `install.sh`/non-root, che nessun workflow prova nemmeno: anche quello non è
# doppione del job "accettazione" di `ci:local`, che esegue solo i passi che
# il job `accettazione` di `ci.yml` dichiara.
#
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
SHA="$(git rev-parse HEAD)"
RAMO="$(git rev-parse --abbrev-ref HEAD)"

LAVORO=""
PASSATO=0

# >>> BLOCCO PROVATO DA local-gate.test.ts
# Il verdetto sta qui e solo qui.
#
# `set -e` fa gia uscire lo script al primo rosso, ma uscire non e dire: chi
# legge un gate legge la riga finale, e senza questo trap un `exit 1` a meta
# non ne stampava nessuna. Il trap chiude anche il caso opposto, che e quello
# pericoloso: un futuro `return`/`exit 0` anticipato uscirebbe zero senza aver
# fatto girare niente, e senza `PASSATO=1` quello resta un rosso.
#
# La riga verde nomina lo SHA perche un gate che dice «verde» e basta viene
# riletto il giorno dopo come se parlasse del commit di oggi.
verdetto() {
  local esito=$?
  if [ -n "$LAVORO" ] && [ "${MUFFIN_GATE_TIENI:-}" != "1" ]; then
    rm -rf "$LAVORO"
  fi
  if [ "$PASSATO" = "1" ] && [ "$esito" = "0" ]; then
    echo "LOCAL-GATE PASS @ $SHA"
    exit 0
  fi
  echo "LOCAL-GATE FAIL @ $SHA (uscita $esito)" >&2
  if [ "$esito" = "0" ]; then exit 1; fi
  exit "$esito"
}
trap verdetto EXIT
# <<< BLOCCO PROVATO DA local-gate.test.ts

passo() { echo; echo "=== $* ==="; }

passo "PRELIMINARI"
for strumento in git node npm docker; do
  command -v "$strumento" >/dev/null || { echo "manca $strumento" >&2; exit 1; }
done
case "$(node --version)" in
  v22.*) ;;
  *) echo "serve Node 22, trovato $(node --version)" >&2; exit 1 ;;
esac
# Docker si prova adesso e non fra venti minuti: `docker version` risponde
# anche col demone spento (parla del client), `docker info` no.
docker info >/dev/null 2>&1 || { echo "il demone Docker non risponde" >&2; exit 1; }

# Il clone prova cio che e committato. Un working tree sporco non lo cambia:
# lo rende una risposta a una domanda diversa da quella fatta, quindi si
# rifiuta invece di certificare HEAD e lasciar credere che comprenda il lavoro
# ancora sul disco.
if [ -n "$(git status --porcelain)" ]; then
  echo "working tree non pulito: il gate prova il commit $SHA, non queste modifiche" >&2
  git status --short >&2
  exit 1
fi
echo "RAMO=$RAMO"
echo "SHA=$SHA"
echo "NODE=$(node --version)"

passo "CLONE PULITO DI $SHA"
# Fuori dal repository, e non in una sottocartella: una directory di lavoro
# dentro l'albero verrebbe raccolta dalla prossima suite che gira qui — che e
# esattamente il difetto che questo gate esiste per non ripetere.
LAVORO="$(mktemp -d "${TMPDIR:-/tmp}/muffin-local-gate.XXXXXX")"
CLONE="$LAVORO/src"
git clone --quiet --no-hardlinks "file://$ROOT" "$CLONE"
git -C "$CLONE" checkout --quiet -B "gate/${SHA:0:12}" "$SHA"

# Le due asserzioni che rendono il clone una prova invece di una speranza.
CLONE_SHA="$(git -C "$CLONE" rev-parse HEAD)"
if [ "$CLONE_SHA" != "$SHA" ]; then
  echo "il clone e a $CLONE_SHA, non a $SHA" >&2
  exit 1
fi
RESIDUO="$(git -C "$CLONE" status --porcelain --ignored)"
if [ -n "$RESIDUO" ]; then
  echo "il clone non e vuoto di materiale estraneo:" >&2
  echo "$RESIDUO" >&2
  exit 1
fi
echo "CLONE=$CLONE"
echo "CLONE_SHA=$CLONE_SHA (nessun file non tracciato ne ignorato)"

cd "$CLONE"

passo "INSTALL DAL LOCKFILE"
npm ci --no-audit --no-fund

passo "TYPECHECK"
npm run typecheck

passo "BUILD"
# `npm ci` ha gia fatto girare `prepare` → `compile`: qui si riparte da zero,
# perche il difetto che si vuole escludere e proprio un `build` che esce 0
# senza scrivere un file (28/08/2026: `build` era `tsc --noEmit`, e due misure
# di fila hanno parlato del binario del giorno prima).
rm -rf dist
npm run build
if [ ! -s dist/cli/main.js ]; then
  echo "build uscita 0 senza scrivere dist/cli/main.js" >&2
  exit 1
fi
echo "dist/cli/main.js: $(wc -c < dist/cli/main.js) byte"

passo "SUITE HOST"
npm test

passo "ACCETTAZIONE HOST"
npm run test:acceptance

passo "GATE LINUX"
# Una sola implementazione: `evals/acceptance/gate-linux.sh` resta l'autorita
# su Linux, e questo script la chiama per nome invece di riscriverne i passi.
# Lo scratch `.gate-linux/` nasce dentro il clone, cioe dentro la directory
# temporanea, e sparisce con lei.
npm run test:acceptance:linux

PASSATO=1
