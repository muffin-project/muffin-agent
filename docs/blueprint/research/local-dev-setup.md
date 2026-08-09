# Setup locale dev per CLI agentici — persistenza credenziali, dev/prod, dotenv, reset

> Scout 2026-08-09 (muffin-scout). Repo clonati `--depth 1`, grep + Read diretti
> sul sorgente (no summary AI non verificati). Fonda l'ADR sul dev-setup. Commit
> letti: gh `9fc0f70` / go-gh `450618a` / aider `5dc9490` / ollama `5a173ed` /
> hermes `36eda61` / goose `064244e` / dotenv `2fc7eac` (tutti 08-2026).

**Domanda guida.** Come far sì che l'owner possa wipe+re-init molte volte senza
re-inserire la API key, esercitando il resto del flusso (Mac=dev, VPS=prod).

## Il principio convergente

Tutti e 4 i tool con vera "credenziale persistente" (gh, aider, hermes, goose)
convergono: **le credenziali vivono FUORI dalla directory che un reset
cancellerebbe** — keyring OS, o un file sotto `$HOME` separato dallo stato.
**Nessuno dei 5 ha un comando "reset" monolitico**: il wipe-preservando-credenziali
emerge dall'architettura, non da un comando. Secondo pattern ricorrente: **un env
var che sposta l'intera config-dir** — la stessa primitiva usata per isolare i test.

## Q1 — Persistenza credenziali per iterare [VERIFICATO]

- **gh**: precedenza env var → keyring OS (`zalando/go-keyring`) → fallback
  plaintext `hosts.yml` (`--insecure-storage`). `gh auth logout` **si rifiuta** di
  cancellare un token la cui fonte è una env var ("clear it from the environment
  yourself"): una key in env sopravvive per costruzione a ogni reset.
- **aider**: nessun keyring. Due file **fuori dal progetto**: `~/.env` (home,
  caricato per primo) + `~/.aider/oauth-keys.env` (store dedicato OAuth, append al
  successo, "loaded automatically in future sessions").
- **hermes**: per-profilo `.env` (chmod 0600) + `auth.json` pool con **fallback
  automatico** al profilo default (un profilo nuovo eredita le credenziali senza
  clone esplicito). Loader: `<HERMES_HOME>/.env` → `.op.env` → project `.env`.
- **goose**: env var → keyring (`GOOSE_DISABLE_KEYRING` per container/headless) →
  `~/.config/goose/secrets.yaml`.
- **ollama**: la domanda non si applica — nessun onboarding con secret utente,
  solo una keypair SSH ED25519 auto-gestita.

## Q2 — Separazione dev/prod: env var che sposta la config-dir [VERIFICATO]

| Tool | Override | Fonte |
|---|---|---|
| gh | `GH_CONFIG_DIR` → `XDG_CONFIG_HOME/gh` → `~/.config/gh`; state su `XDG_STATE_HOME` | go-gh `config.go:247-279` |
| hermes | `HERMES_HOME` + profili nominati sticky (`profiles/<name>`, `hermes profile use`) | `hermes_constants.py:53-198` |
| goose | `GOOSE_PATH_ROOT` (path assoluto) sposta config/data/state/plugins | `paths.rs:8-46` |
| aider | **nessuno** — search-path multi-livello home→git_root→cwd | assenza verificata |
| ollama | solo `OLLAMA_MODELS` (pesi, non config) | assenza verificata |

**Nota architetturale**: in gh/hermes/goose l'override della config-dir è **lo
stesso meccanismo dell'isolamento test** (`t.Setenv("GH_CONFIG_DIR", tempDir)`).
"Profilo dev separato" e "harness di test" sono la stessa primitiva. → Muffin ha
già `MUFFIN_HOME` (`config.ts:64`).

## Q3 — dotenv in dev [VERIFICATO]

- aider: `python-dotenv`, solo `.env` (no `.env.<mode>`) — è sempre un dev tool.
- goose: `dotenvy` **solo nei test**, mai nel binario prod.
- ollama: nessun dotenv nel binario (`.env` in gitignore è inerte).
- hermes: solo `<HERMES_HOME>/.env` + `.op.env` (NON il pattern Next.js multi-mode
  — quello nel loro gitignore è una **denylist anti-leak** per l'agente, non file
  che caricano).
- **dotenv (motdotla) FAQ ufficiale**: *sconsiglia* l'inheritance
  (`.env.production` eredita `.env`); 12-factor → duplicare i valori.
- **Node 22 nativo**: `--env-file` (stable v22.21.0, *errore se il file manca*) e
  **`--env-file-if-exists`** (silenzioso se manca). Programmatico:
  `process.loadEnvFile(path)`. **Elimina il bisogno del pacchetto `dotenv`** per il
  caso "carica se c'è". Nessuno dei repo carica dotenv in prod: il "non in prod"
  emerge dal fatto che **il file non esiste sul target** (gitignored, non
  deployato), non da un `if NODE_ENV` nel codice.

## Q4 — .gitignore per dev locale [VERIFICATO]

- aider: `.aider*` (un glob per history/cache/config-locale).
- hermes: lista `.env*` estesa (ma come denylist), + `cli-config.yaml`.
- goose: `.goose/`, `/.env`.
- ollama: `.env`, `.venv`, `*.crt`.
- **Muffin**: già copre `.env`, `.env.*`, `!.env.example`, `*.local`, `secrets/`,
  `.muffin/` — adatto ai test locali.

## Q5 — Reset che preserva le credenziali [VERIFICATO]

**Nessuno ha un reset monolitico.** Il pattern emerge dall'architettura (cred fuori
dalla dir wipeata). Eccezione più vicina alla richiesta owner: **hermes
`profile create --clone`/`--clone-all`** — porta esplicitamente `.env`/`auth.json`
ma esclude SEMPRE `state.db`/`sessions`/`backups` (`profiles.py:57-126`): "wipe lo
stato, preserva credenziali, testa il resto", implementato come flag di
`profile create`, non un comando reset. `hermes memory reset` è scoped (solo
MEMORY.md/USER.md). goose: per ri-testare il first-run devi far sparire
`config.yaml`; se le cred sono nel keyring, un wipe della config-dir non le tocca.

## Claim corretti in corso

- hermes NON è solo-Python (misto Python+TS/Node — riferimento più pertinente per noi).
- I `.env.local`/`.env.production.local` nel gitignore hermes NON sono multi-mode
  loading (verificato su `env_loader.py`) — sono denylist anti-leak dell'agente.
- ollama: la domanda "API key da non re-inserire" non si applica (keypair SSH).

## Sintesi per l'ADR

Credenziale FUORI dalla dir wipeata (keyring o file sotto `$HOME`); config-dir
spostabile via un env var (= primitiva di test); su Node 22 `--env-file-if-exists`
/ `process.loadEnvFile` bastano (niente pacchetto dotenv), e il "non in prod" è il
file assente, non un IF. Il reset-che-tiene-la-chiave non è un comando: è la
conseguenza di dove sta la chiave.
