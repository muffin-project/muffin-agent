# ADR-0030 — Setup locale dev: la chiave vive fuori dalla home wipeata

**Contesto.** L'owner sviluppa sul Mac (local) e vuole ri-provare l'onboarding molte volte (`muffin uninstall --yes && muffin init`) senza re-inserire la API key; la VPS è prod. Prior art su fonte primaria (`research/local-dev-setup.md`, scout 2026-08-09): tutti i tool con credenziali persistenti (gh, aider, hermes, goose) convergono su un principio — **le credenziali vivono FUORI dalla directory che un reset cancella** (keyring OS o file sotto `$HOME` separato dallo stato); **nessuno ha un comando reset monolitico** (il wipe-preservando-credenziali emerge dall'architettura); la separazione dev/prod è **un env var che sposta l'intera config-dir** (`GH_CONFIG_DIR`/`HERMES_HOME`/`GOOSE_PATH_ROOT`), la stessa primitiva dell'isolamento test. Su Node 22, `--env-file-if-exists` / `process.loadEnvFile` bastano (niente pacchetto `dotenv`; nessun peer lo carica in prod).

**Decisione.**

1. **Muffin carica una `.env` dalla working dir se presente**, all'avvio (`cli/main.ts` `loadDotenvIfPresent`), via `process.loadEnvFile` nativo. Verificato **empiricamente** su Node 22.22: non sovrascrive un env già settato → il **real env vince**; lancia `ENOENT` se il file manca → guardato con `existsSync`. Nessuna dipendenza `dotenv`, nessun `if NODE_ENV`: in prod il file semplicemente non c'è (gitignored, non deployato) → no-op.
2. **La chiave dev vive nella `.env` del repo** (gitignorata), quindi FUORI da `~/.muffin`. Il loop `muffin uninstall --yes && muffin init` — che l'owner già usa — la riusa senza re-incollare. È esattamente il pattern che il prior art descrive: *"il reset-che-tiene-la-chiave non è un comando, è dove sta la chiave"*.
3. **Separazione dev/prod = `MUFFIN_HOME`** (già esiste, `core/config/config.ts:64`), la nostra versione di `GH_CONFIG_DIR`/`HERMES_HOME`. Mac-dev può usare `~/.muffin` o un `~/.muffin-dev`; la VPS usa il suo, senza `.env`.
4. **`.env.example` committato** (documenta `MUFFIN_API_KEY` + `MUFFIN_HOME`); `.gitignore` già copre `.env`/`.env.*`/`!.env.example`/`secrets/`/`.muffin/`.

**Alternative scartate.** *Pacchetto `dotenv`*: superfluo su Node 22 nativo; nessuno dei peer lo carica in prod. *Un comando `muffin reset --keep-key`*: il prior art mostra che nessuno ne ha bisogno — la chiave fuori-dalla-dir-wipeata rende il reset una conseguenza, non una feature. *Multi-file `.env.<mode>` (Next/Vite)*: la FAQ di `dotenv` stessa lo sconsiglia (12-factor: duplicare, non ereditare); un solo `.env` basta, e i pattern `.env.local` nel gitignore di hermes erano una denylist anti-leak, non multi-mode loading. *Keyring OS* (gh/goose): più robusto ma più complesso; rimandabile — il file `0600` in `~/.muffin/secrets` + la `.env` dev coprono il caso single-owner.

**Conseguenze.** Più facile: dev-loop senza re-incolla; real-env override per i casi one-off; prod intatta per assenza-file. Più difficile / da tenere d'occhio: la `.env` si carica dalla **CWD**, quindi il loop va fatto dalla dir del repo (dove sta la `.env`); una `.env` in una dir a caso verrebbe caricata all'avvio (rischio dev standard di dotenv, accettato per single-owner — il real env vince comunque). Se un domani servisse il keyring OS o un `.env` a percorso fisso indipendente dalla CWD, questa decisione non lo preclude. Codice: `muffin-agent@f0a7e43` (`cli/main.ts` `loadDotenvIfPresent`, `.env.example`).

---

## Emendamento 2026-08-13 — il punto 2 si sposta, il principio no (ADR-0039)

Il **principio** di questa ADR non è in discussione e non cambia: *la chiave vive
fuori dalla home che il reset cancella*, e il reset-che-tiene-la-chiave non è un
comando ma un posto. Cambia **quale** posto.

**Cosa è successo.** La riga «da tenere d'occhio» qui sopra — *«la `.env` si
carica dalla CWD, quindi il loop va fatto dalla dir del repo»* — ha nominato la
dipendenza e non la sua conseguenza: la CWD **è** `root`, cioè l'albero che
`fs.read` può leggere (`agent/runtime.ts`). `fs.read` è `risk: 'low'` senza
`maxTaint`, quindi il tetto è `defaultMaxTaint.low` = 3. In un turno owner che
avesse già preso un risultato tier-3, `fs_read(".env")` restituiva la chiave del
provider in chiaro al modello. Non sfruttabile sulla macchina dell'owner solo
perché la `.env` non esisteva ancora — cioè fino al momento in cui questa ADR gli
diceva di crearla. Riprodotto e misurato in `agent/secret-read.test.ts`.

**Cosa cambia nel punto 2.** La chiave dev non vive più in una `.env` della
working dir ma in `$XDG_CONFIG_HOME/muffin/secrets/<nome>` (dir `0700`, file
`0600`), scritta con `muffin secret set NAME --persist`. È fuori da `MUFFIN_HOME`
— quindi il loop `uninstall && init` la ritrova, che è tutto ciò che il punto 2
comprava — e fuori dal repo, quindi la dipendenza dalla CWD sparisce invece di
restare una nota. È la stessa famiglia di directory del credential store di
systemd, così Mac e VPS potranno condividere un percorso di risoluzione.

**Cosa resta valido di questa ADR, per intero.** Il punto 1 (`loadDotenvIfPresent`
via `process.loadEnvFile`, real-env che vince, no-op in prod): la `.env` continua
a caricarsi, per le variabili **non segrete** — `MUFFIN_HOME` sopra tutte, che è
il punto 3. Il punto 3 (`MUFFIN_HOME` come separatore dev/prod) e il punto 4
(`.env.example`, gitignore) sono intatti. Anche la riga di «alternative scartate»
sul keyring OS resta com'era: il file `0600` fuori dalla home è ancora la scelta,
solo in una directory diversa.

**La domanda che questa ADR lasciava aperta è chiusa da qui**: *«se un domani
servisse un `.env` a percorso fisso indipendente dalla CWD»* — è quel domani, e
il percorso è XDG. Dettagli, migrazione e le altre due decisioni della stessa
slice: **ADR-0039**.

---

## Emendamento 2026-08-17 — `--local`: la seconda home riusa la catena, mai una copia (M5-BIS A9)

`muffin init --local [<dir>]` (default `~/.muffin-local`) è il verbo che questa
ADR anticipava senza costruirlo: una home di prova separata, per ripetere
un'installazione «da utente nuovo» senza reincollare la chiave. Il principio
resta esattamente quello del punto 2, dopo l'emendamento di ADR-0039: la chiave
vive fuori dalla home che un reset cancella. `--local` non aggiunge un secondo
posto — legge la stessa catena a due backend (ADR-0039 decisione 2,
`locateSecret`) contro quella seconda home invece che contro la reale, e non
scrive mai nulla nella home locale: se il passo «api key» la trova, dice
`già presente (persistent)` e basta. Con la chiave scritta una volta con
`muffin secret set NOME --persist`, ogni `--local` successivo la ritrova — lo
stesso loop che il punto 2 descriveva per `uninstall && init`, ora anche per
una home che non è mai stata quella reale.

**Guardia, non fiducia.** `--local` rifiuta un `<dir>` che coincide con la home
reale o le sta annidato sotto — confrontati per realpath, non per stringa, così
un symlink non basta ad aggirarla — prima di scrivere qualunque cosa
(`cli/init.ts:47-93`, guardia invocata da `cli/main.ts:271-288`). Non installa
mai il gateway di sistema (`cmdGatewayInstall` punta comunque alla home reale,
mai a quella passata a `init`): proporlo per una home usa-e-getta sarebbe
scrivere un unit systemd/launchd sbagliato.

Codice: `cli/init.ts` (`resolveLocalHome`, `isSameOrNestedPath`), `cli/main.ts`
(`cmdInit`). Scenario di accettazione:
`evals/acceptance/scenarios/a-lifecycle.accept.ts:293-364` (A9).
