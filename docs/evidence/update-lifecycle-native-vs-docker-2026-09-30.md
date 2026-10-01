# Lifecycle di update: nativo vs Docker contro il contratto di #765

**Decisione che questo documento deve cambiare:** #765 — lo stesso contratto
`SHA → candidato → verifica → backup → attivazione atomica → verifica runtime →
rollback` dietro `muffin update`/rollback per nativo e Docker, mai il socket
Docker nel gateway.

**Osservato su** `dev` @ `2bd71e59` (2026-09-30, ricerca delegata read-only).
Fonti: `cli/update.ts` e `install.sh` su dev; `gh pr diff 683` (root bootstrap,
draft); il branch #729 a `33a67d56`. L'installazione personale di questa
macchina è stata osservata read-only: `~/.local/bin/muffin → .releases/2bd71e59/…`,
`.releases/current` `{sha, entry}`, `.releases/previous`, due worktree di
release: **il meccanismo nativo gira in produzione esattamente come codificato**.

## Cosa fa oggi il nativo (file:riga)

`runUpdate` (`cli/update.ts:965-1203`): fetch del canale (`:998-1004`, ADR-0057:
nessuno SHA fornito dall'operatore, solo canale) → release in
`.releases/<short>` con `git worktree add <dir> <sha>` (`:1057`, per
costruzione senza dirty/untracked) → `npm ci` nel release (`:1064-1077`) →
smoke `--help` (`:1085-1098`) → **backup del solo database** (`:1100-1116`,
`VACUUM INTO` + quick_check; il testo del passo dichiara da sé cosa non copre)
→ flip atomico dei symlink launcher (`rename(2)`, `:1118-1129`) + marker
`current`/`previous` atomici (`:472-479`) → prune (current+previous,
`:1149-1153`) → riavvio verificato **per cambio pid**, mai per exit code
(`:815-896`), senza rollback automatico. `--rollback` (`:898-957`): guardia
schema-ahead (rifiuta se il DB è oltre ciò che il release precedente supporta),
flip all'indietro, marker invertiti. L'unit del supervisore punta al **launcher
symlink** (`core/gateway/unit.ts:507-523`): è la via sanzionata per muovere ciò
che la unit esegue. Primo hop: il comando non può fare il proprio arrivo
(`:95-107`); `install.sh` fa il clone reale (`:396-413`) e il symlink iniziale.

## Cosa fa oggi Docker (#729)

`build.sh` costruisce da `rev-parse HEAD` locale (niente risoluzione remota);
l'immagine è per commit esatto (rifiuta context ≠ tree); la selezione è il
**tag locale mutabile** `muffin-gateway:local` con `pull_policy: never` e
nessuna sezione `build:`; `/opt/muffin` root-owned, launcher fisso; l'update
documentato è «`git pull` + `./build.sh` + `docker compose up -d`». `muffin
update` **dentro** il container fallisce per costruzione al fetch (il repo
in-immagine non ha remote) e comunque non può scrivere in `/opt/muffin` (uid
1000). Nessun socket da nessuna parte (grep su contrib/ ed evals: zero).

## Gap map contro il contratto

| Passo del contratto | Nativo | Docker oggi |
|---|---|---|
| risolvi SHA esatto | parziale: tip del canale → SHA; exact-SHA solo al bootstrap (#683 `MUFFIN_REF`, `bootstrap.sh` via API GitHub, 40-hex, rifiuto di branch mutabile) | manca: HEAD locale, `git pull` a mano |
| materializza il candidato | sì: worktree dal commit | sì: `git archive` + commit object, rifiuto di tree ≠ commit |
| verifica il candidato | parziale: smoke `--help` + lettura schema dal release (warn-only) | parziale: solo uguaglianza dell'albero; `doctor` post-attivazione, non gating |
| backup dello stato owner | parziale: **solo DB**, dichiarato | manca dal flusso (volumi persistono, `muffin backup` manuale) |
| attiva atomicamente | sì: symlink `rename(2)` + marker | parziale: `up -d` ricrea al cambio image ID, ma su tag mutabile |
| verifica il runtime attivo | parziale: cambio pid, onesto, niente auto-rollback | manca: `restart: unless-stopped` ritenta exit 78 per sempre |
| rollback | sì (invocato), con guardia schema | manca: il rebuild orfana l'immagine precedente; niente marker, niente percorso |

**#683 non tocca `cli/update.ts`** (diff verificato): aggiunge exact-SHA al
solo bootstrap e un dispatcher root che esegue l'install come utente di
servizio sugli stessi layout `.releases`. Non inventa un secondo contratto.

## Seam candidati

- **S1 — rifiuto onesto in-container + procedura lato host** (docs + messaggio):
  oggi l'errore in-container è la *frase* sbagliata (il rimedio parla di deploy
  key). Precedente nativo: la limitazione del primo hop (`:95-107`). Piccolo,
  non è da solo il contratto.
- **S2 — indirezione tag/digest lato host** che possiede l'«immagine attiva»:
  il driver (lato host, accanto al clone) risolve lo SHA, costruisce con
  `build.sh` esteso a un SHA, tagga `muffin-gateway:<sha>` (o pinna il digest in
  un override compose), `up -d`, verifica, e tiene `<previous>` — la traduzione
  di `writeMarker`/`atomicSymlink` da symlink a tag. Un solo punto di selezione
  in compose (`image:` + `pull_policy: never`). **Il driver è lato host: il
  socket non entra mai nel gateway.**
- **S3 — interfaccia `UpdateBackend` dentro `cli/update.ts`** (resolve →
  materialize → verify → backup → activate → verifyRuntime → rollback):
  `runUpdate` è già a passi con seam di iniezione (`UpdateDeps`, 1282 righe di
  test); `cmdUpdate` sceglie il backend dal modo di installazione.
- **S4 (gateway guida l'update via socket) e S5 (due contratti duplicati)**:
  esclusi dalla decisione già registrata in #765; stanno nella tabella perché
  un'opzione reale deve poter perdere.

**Sequenza proposta:** S1 subito, S2 come primitiva Docker di attivazione,
S3 dopo per unificare la superficie — così #729 resta bounded come l'issue
richiede e riceve solo più avanti «a small backend hook».

## Il buco di fiducia non posseduto

«Model/agent authority non può scegliere una revisione del codice o alzare
l'update trust»: **niente nel percorso nativo distingue un owner al TTY da un
processo qualsiasi dell'utente di installazione** — incluso uno shell command
guidato dal modello, `--yes` incluso. Docker oggi è fail-closed per
costruzione. Un lifecycle unificato non deve indebolirlo; serve un gate
esplicito (+ test che l'update model-initiato sia rifiutato), o l'accettazione
documentata dello status quo. È la voce della lista vincoli di sicurezza che
nessun codice oggi enforce.

## Decisioni owner richieste (prima del codice)

1. **Dove gira l'update Docker**: solo lato host con rifiuto onesto
   in-container (raccomandato) vs agente host vs demone.
2. **Identità del candidato Docker**: tag `<sha>` + pin digest nel marker vs
   override compose generato vs tag mutabile (oggi). Il contratto chiede
   «verificabile esternamente» → SHA + digest, e **ritenere esplicitamente
   l'immagine precedente** (oggi niente la ritiene).
3. **Chi può innescare l'update** (entrambi i backend): gate esplicito vs
   status quo documentato.
4. **Backup**: il contratto dice «stato owner persistente»; il nativo copre il
   DB e lo dichiara; Docker non ha passo. Estendere (config/vault/rot; volumi)
   o riscrivere il contratto sui fatti.
5. **Rollback in Docker**: riusare la guardia schema-ahead leggendo
   `dist/core/db/migrate.js` dell'immagine candidata **prima** del re-point;
   casa dei marker lato host.
6. **Trust di risoluzione Docker**: stessi semantica di canale e nota di lag
   del nativo (ADR-0057), non HEAD locale; decide se il driver Docker prende
   `--channel`. Stessa classe di fiducia della questione aperta #654/#683
   (main mutabile via HTTPS): decidere una volta.
7. **Interazione con #683**: l'interfaccia di backend dovrebbe atterrare prima
   o con il merge di #683, o la sua accettazione (update/rollback dal layout
   root, richiesta da #654) verrà corsa su un lifecycle in fase di reshaping;
   e decidere se il pinning `MUFFIN_REF` migra dentro `muffin update` come
   output della risoluzione (e ingresso per installazioni pinnate).

## Falsificatori per la slice CRITICAL

1. candidato fallito → nessuna attivazione (nativo: test esistenti
   `cli/update.test.ts:357-396`; Docker: build/verifica fallita → tag/digest e
   container invariati — da aggiungere).
2. attivazione e rollback reali su entrambi i backend (Docker: `up -d` ricrea
   al nuovo digest; il rollback ricrea l'immagine **precedente** e
   doctor/entrypoint ne riportano lo SHA — oggi non esiste).
3. identità esatta: lo SHA risolto all'inizio = doctor, gateway, label
   `docker inspect`, digest del container in esecuzione.
4. stato owner: volumi `home`/`config`/`workspace` sopravvivono ad attivazione
   **e** rollback; il backup nativo resta restaurabile.
5. nessun socket: `docker inspect` del gateway in esecuzione su tre soli
   mount, attraverso un update e un rollback (estendere l'eval esistente).
6. update model-initiato rifiutato su entrambi i backend.
7. verdetto di riavvio onesto anche dopo il refactor (nativo: cambio pid;
   Docker: ricreazione + doctor nel log, non «restart policy all'infinito»).

## Incertezze

- `muffin update` in-container non è stato **eseguito**: è traccia a livello di
  codice (nessun remote nel repo in-immagine; `/opt/muffin` root-owned; uid
  1000) — alta confidenza, non osservato.
- Nessun container/VPS eseguito; l'accettazione VPS di #654 resta il banco
  vero anche per il nativo.
- #683: head corrente `77664eb1` più recente di ogni head documentato nel body
  della PR (check attuali: dco/verifica/install/collegamenti/strumenti verdi,
  accettazione skipped perché draft) — riconciliare il body quando si riprende
  quella lane.
