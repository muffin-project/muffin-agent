# Triage evidence-only — sezioni A+B (M5-BIS.md), 17/08

Base: `origin/dev` letto nel worktree `loop-orchestration-workflow-e20bef`. Evidenza: lettura
codice + `npx tsx evals/acceptance/report.ts` eseguito dal vivo in questa sessione (54 righe, 18
scenari) + `research/audit-2026-08-16/README.md` (già classificato contro `origin/dev` il 17/08,
riletto e riusato, non ri-eseguito). Nessun `vitest run` nuovo lanciato in questo giro (budget) —
dove serve un test vivo è segnalato in "Cosa non ho potuto stabilire".

**Report dal vivo (riferimento per tutte le righe sotto)**: verde 14 · atteso-rosso 4 (B8, C4, D3,
D10) · nessuno scenario 35 · non provabile qui 1 (C8). FALLITO: 8 righe READY senza scenario (B14,
C2, C3, C6, C7, D4, D6, E4).

**Finding maggiore di questo triage**: **B8 va riclassificato da READY a BLOCKER.** M5-BIS lo
dichiara READY citando che `Scheduler.settle` è l'unico chiamante di `markRan`. È vero come
descrizione del meccanismo (`core/scheduler/scheduler.ts:314-347`), ma lo scenario di accettazione
che prova esattamente questa riga (`evals/acceptance/scenarios/b-continuity.accept.ts:74-141`,
manifest `evals/acceptance/manifest.ts:54-61`) gira **rosso per progetto** (`atteso-rosso`, non
`rosso-inatteso`): un job verso `telegram` scrive *"consegna remota da cablare"* su stderr
(`cli/gateway.ts:506`, solo `'cli'` è cablato in `gatewayDeliver`) e `markRan` avanza comunque
(`scheduler.ts:341-342`, `last_run_at` valorizzato). Questo è esattamente il finding P39 dell'audit
(HIGH, acceptance truthfulness — invariante 9 del mandato: *"Riconcilia almeno B8... in base alla
semantica ATTUALE, non al testo storico"*). Vedi scheda B8.

---

## A · Installazione e ciclo di vita

### A1 — Boot
**Stato proposto**: READY.
**Evidenza**: `evals/acceptance/scenarios/a-lifecycle.accept.ts:14-54` — install pulito, `muffin
run` risponde, secondo processo (`muffin doctor`) trova root-of-trust+database intatti (`✓ root of
trust`, `✓ database`), 1 turno registrato in `turns`. Report dal vivo: **verde**. Implementazione:
`cli/init.ts:46` (`runInit`, idempotente per costruzione — ogni step controlla il proprio esito).
Unit+integration: attraverso il binario vero (`node --import tsx cli/main.ts`), non `runInit()` a
mano. Cablaggio prod: sì, è il binario reale. Failure path: `doctor` distingue `ok/warn/fail`
(`cli/doctor.ts:570-577`). Doc: `STATE.md` "M0 chiuso".
**Journey**: J1 (boot-doctor-migrazione) — con A5, A6, A7.
**Costo**: — (chiuso). **Nota di scope**: la riga copre boot pulito + riavvio pulito, non recupero
da crash (quello è B5, READY) né da schema popolato preesistente (quello è A6/A7, BLOCKER).

### A2 — Identity
**Stato proposto**: BLOCKER.
**Evidenza**: `defaults/rot/identity.md` — sezioni vive `## Chi sei` (riga 79), `## Come ti
comporti quando è difficile` (riga 91), `## Il limite che ti do io` (riga 100) sono **vuote**,
solo commenti HTML con 8 proposte (A-H) ancorate a citazioni owner, esplicitamente "da tagliare,
riscrivere o buttare". `cli/doctor.ts` non ha un check dedicato che segnali "identity è ancora il
template" — un'installazione fresca non riceve alcun avviso su questo. Manca implementazione
(il contenuto stesso), quindi tutte le altre 6 condizioni sono N/A finché non esiste il testo.
**Journey**: J6 (identity/config first-run) — con A3, A4, A9.
**Costo**: S (non è lavoro di codice: sono le tre risposte dell'owner, mandato §5 lo dice
esplicitamente — "nessun agente può dedurle legittimamente"). Dipendenza: nessuna tecnica, solo
owner.

### A3 — Persona
**Stato proposto**: BLOCKER.
**Evidenza**: `defaults/persona.md` — file installato (`cli/init.ts:69` `installFile('persona.md'
...)`, confermato "already present"/"installed" nei passi di `runInit`), ma la sezione `## Al
primo incontro` (riga 38) porta il proprio commento `⚠️ QUESTA SEZIONE È SBAGLIATA E VA RIFATTA
(correzione owner, 2026-08-09)` (riga 41) — un difetto auto-dichiarato nel file stesso, non
scoperto ora. `STATE.md` punto 3 conferma: "🟡 bozza da plasmare... finché non lo plasmi 'sa di
mockup' → NON è l'MVP".
**Journey**: J6 — con A2, A4, A9.
**Costo**: S (owner-content, come A2). Dipendenza: nessuna tecnica.

### A4 — Config
**Stato proposto**: BLOCKER.
**Evidenza**: `cli/config.ts:7` — `muffin config` è "read-only, on purpose (ADR-0036)": lista
manopola/valore/sigillato/origine (`cli/config.ts:22-37`, `core/config/inventory.ts`), **nessun**
verbo di scrittura (niente `muffin config set`). Il meccanismo di lettura funziona (validazione
zod a caricamento, fallisce rumoroso — `core/config/config.ts:35-63`), ma: (a) nessuno scenario di
accettazione (report dal vivo: "nessuno scenario A4"); (b) nessuna prova end-to-end che un edit a
mano di `config.json` + `muffin rot reseal` per i file sigillati venga effettivamente ripreso da un
processo successivo. Il gap è di copertura, non di capability rotta: editare JSON a mano non è
"toccare il codice" per il criterio Gate 1, ma senza uno scenario non è "chiuso" per la regola delle
sette condizioni.
**Journey**: J6 — con A2, A3, A9.
**Costo**: S (serve solo lo scenario + una riga di doc sul flusso hand-edit-then-reseal).

### A5 — Doctor
**Stato proposto**: READY.
**Evidenza**: `evals/acceptance/scenarios/a-lifecycle.accept.ts:56-94` — manomissione reale di
`rot/policy.json` (non un fixture dichiarato a doctor), `doctor` la rileva, nomina il file
(`/policy\.json/`) e dà un rimedio azionabile (`/rifai|reseal|ripristina/`). Report dal vivo:
**verde**. Implementazione `cli/doctor.ts:45-568`: ogni check esegue, non assume (commento del
file: "does it work, never does it exist" — il precedente in produzione con `bwrap` in PATH e
sandbox no-op per due mesi). Failure path: tre livelli `ok/warn/fail` con remedy quando c'è
qualcosa da fare.
**Journey**: J1 — con A1, A6, A7.
**Costo**: — (chiuso).

### A6 — Upgrade
**Stato proposto**: BLOCKER.
**Evidenza**: nessun verbo `update`/`upgrade` in `cli/main.ts` (lista comandi verificata:
`run,repl,init,config,doctor,rot,uninstall,memory,vault,surface,mcp,jobs,gateway,observe,secret,
trace` — nessun altro). `core/turns/store.ts:30-33`: "questo repo non ha un migration runner: ogni
store fa il proprio `db.exec(SCHEMA)` nel costruttore, e `CREATE TABLE IF NOT EXISTS` crea una
tabella nuova su un database installato" — additivo per le tabelle, ma non per colonne/CHECK
esistenti. Audit P27 (MEDIUM, **STILL PRESENT** contro `origin/dev`, riletto da
`research/audit-2026-08-16/README.md` riga 43): `ensureColumn` esiste solo per 3 colonne di
`core/memory/store.ts` (righe 170,176-184), `turns`/`jobs` non hanno l'equivalente. Nessuno
scenario che parta da uno schema popolato preesistente (mandato invariante 10: "Non provare
soltanto un database fresco... Day 1 è il momento dopo il quale reset del dataset non è più un
rimedio"). Report dal vivo: "nessuno scenario A6".
**Journey**: J1 — con A1, A5, A7.
**Costo**: M. Dipendenza: stessa causa radice di A7 (nessun migration runner condiviso).

### A7 — Migration
**Stato proposto**: BLOCKER.
**Evidenza**: `episodes.kind` — `core/memory/store.ts` (schema con `CHECK` a cinque valori,
riferimento diretto da `core/turns/store.ts:34-35`: "un `kind` nuovo funziona su un database fresco
e rompe ogni installazione con dentro qualcosa"). `turns.status` ha lo **stesso trap** ma è stato
premunito: `core/turns/store.ts:37-44,72` dichiara `CHECK (status IN ('runnable','running',
'waiting','interrupted','done'))` con `runnable`/`waiting` già presenti **prima** di avere un
writer, apposta per non pagare un rebuild dopo il giorno 1 — un pattern difensivo reale ma isolato
a questa tabella, non generalizzato (audit P27, stesso reperto di A6). Nessun test di migrazione
da schema popolato reale (mandato invariante 10). Report dal vivo: "nessuno scenario A7".
**Journey**: J1 — con A1, A5, A6.
**Costo**: M. Dipendenza: A6 (stessa causa radice — generalizzare `ensureColumn` o adottare un
migration runner condiviso chiuderebbe entrambe insieme).

### A8 — Backup
**Stato proposto**: BLOCKER *(declassato da questo triage — il report/manifest lo segna verde; vedi
sotto perché non basta)*.
**Evidenza**: `evals/acceptance/scenarios/a-lifecycle.accept.ts:96-129` è reale e **verde** nel
report dal vivo: `cp -R` dell'intera home, `rm` dell'originale, `cp -R` di ritorno dalla copia,
`memory search` ritrova il contenuto. Prova la proprietà dichiarata in `core/config/config.ts:6-9`
("One home, one config file, one database. Backup... has to be a single path"). **Ma**: (a)
`cli/init.ts:109-111` apre il database con `db.pragma('journal_mode = WAL')` — una copia `cp -R` a
freddo (processo fermo) è sicura, ma lo scenario **non testa mai** un backup mentre un gateway è
vivo e scrive (nessun `inst.gateway()` in quello scenario); un `cp -R` di un DB WAL sotto scrittura
concorrente rischia una copia incoerente (i file `-wal`/`-shm` non sono copiati atomicamente col
principale) — rischio reale, non dimostrato né escluso qui. (b) Non esiste un verbo `muffin
backup`/`muffin restore` (verificato: assente dalla lista comandi di `cli/main.ts`) né una
procedura documentata per l'owner — la proprietà regge solo se chi fa il backup sa fermare il
gateway prima. Il mandato (§10, battery di cutover) chiede esplicitamente "backup → distruzione
controllata della copia → restore → verifica" come parte della batteria finale, e il punto C del
mandato vieta di dichiarare READY una garanzia di durability sulla sola happy path.
**Journey**: J2 (backup-restore-live) — riga sola, ma J2 estende esattamente questo scenario.
**Costo**: S (checkpoint/`wal_checkpoint(TRUNCATE)` prima della copia, o fermare il gateway, più
uno scenario che lo eserciti da vivo, più un comando/doc minimi).

### A9 — Setup locale
**Stato proposto**: BLOCKER.
**Evidenza**: nessun flag `--local` in `cli/init.ts` (`InitOptions` a riga 31-42 non lo elenca) né
in `cli/main.ts` (grep su `'--local'`/`init --local`: zero risultati). Richiesta owner esplicita
16/08 (M5-BIS A9): senza, ogni prova "da utente nuovo" costa re-incollare le chiavi a mano. Il
meccanismo di lettura del segreto persistito esiste già (`locateSecret`/`readSecret`,
`core/config/config.ts`, usato da `cli/init.ts:87-92`) — manca solo il verbo che lo richiama su una
home diversa senza richiedere di nuovo `--api-key`.
**Journey**: J6 — con A2, A3, A4.
**Costo**: S. Dipendenza: nessuna.

---

## B · Continuità del runtime

### B1 — Conversation (CLI+Telegram)
**Stato proposto**: BLOCKER.
**Evidenza**: `evals/acceptance/scenarios/b-continuity.accept.ts:19-71` prova **solo la metà CLI**
— il docstring del file lo dichiara esso stesso (righe 10-11): "no real Telegram bot is reachable
from here". Report dal vivo: **verde**, ma è verde sulla metà sola. Il meccanismo sottostante è
architetturalmente condiviso (stesso DB, `SessionStore` per-sessione + memoria tenant-scoped via
`recall`), ma la sessione letterale **non** è la stessa fra le due superfici per costruzione: CLI
usa `--session <id>` a scelta dell'utente, Telegram deriva `telegram:${chatId}`
(`connectors/telegram/connector.ts:365`) — quindi "condividono sessione" nel senso letterale della
riga non è nemmeno vero per come sono cablate; quello che le collega davvero è la memoria
(tenant-scoped), non la sessione. La riga Gate 1 chiede entrambe ("CLI e Telegram condividono
davvero sessione e memoria?") e solo la memoria è plausibile, non provata dal lato Telegram.
**Journey**: J3 (fault-chain Telegram) — con B10, B15, B16.
**Costo**: S. L'infrastruttura per provarlo esiste già (fake `TelegramApi` usato da
`connector.test.ts`/`streaming.test.ts`) — serve uno scenario di accettazione analogo a
`document-arrival.test.ts` ma per la continuità di memoria fra un turno CLI e un turno Telegram
sullo stesso tenant.

### B2 — Long-running
**Stato proposto**: BLOCKER.
**Evidenza**: confermato esatto quanto scrive M5-BIS. `connectors/telegram/connector.ts:359`
chiama ancora `await runTurn(this.deps.loop, {...})` direttamente, non `enqueueTurn`
(`agent/loop.ts:508`). Il meccanismo `enqueueTurn`/corsia è costruito e provato end-to-end
(`agent/lane-wiring.test.ts`, esiste; `core/turns/lane.ts`, esiste; `agent/turn-lane.ts`, esiste).
**Journey**: J3 (fault-chain Telegram) — con B1, B10.
**Costo**: S (un cambio di chiamata, per ammissione della stessa M5-BIS), ma **deliberatamente
rimandato**: `slice/superfici` sta riscrivendo `Deliver`/la resa in-band sullo stesso punto —
toccarlo ora sarebbe una guerra di merge. Owner: "al test di prod" — la classificazione resta
BLOCKER con evidenza indipendentemente da quando si chiude.

### B3 — Wait
**Stato proposto**: READY (confermato).
**Evidenza**: `evals/acceptance/scenarios/b-continuity.accept.ts:154-197` — richiesta di attendere
un'ora, il processo **torna** (exit 6, sospeso) entro 60s reali invece di tenere il runtime;
`turns.status='waiting'`, `wake_at` non nullo, `claimed_by` nullo, `turn_outcome` nullo. Report dal
vivo: **verde**.
**Journey**: J3. **Costo**: — (chiuso).

### B4 — Todo
**Stato proposto**: READY (confermato).
**Evidenza**: `evals/acceptance/scenarios/b-continuity.accept.ts:200-240` — piano scritto da un
processo, letto **non richiesto** da un secondo processo sulla stessa `--session`; criterio di
completamento deterministico ("nessun passo...") nel contesto. Report dal vivo: **verde**.
**Journey**: J3. **Costo**: — (chiuso).

### B5 — Resume
**Stato proposto**: READY (confermato).
**Evidenza**: `evals/acceptance/scenarios/b-continuity.accept.ts:242-315` — processo vero ucciso
con `SIGKILL` a metà turno (dopo che la riga `turns` esiste con `status='running'`), `doctor` nomina
il turno interrotto, il gateway lo riprende e lo porta a `done`. Report dal vivo: **verde**.
**Journey**: J3. **Costo**: — (chiuso).

### B6 — Retry
**Stato proposto**: BLOCKER.
**Evidenza**: retry esiste **solo** al livello trasporto/modello — `agent/loop.ts:1089-1103`
(`MAX_TRANSPORT_RETRIES=2`, backoff esponenziale con jitter su 429/5xx, `agent/loop.ts:2131`) e sul
JSON malformato dell'output modello (`recover('malformed')`, cascata `profile.recovery`). **Nessun
tool implementa un retry proprio**: `agent/tools/http.ts`, `agent/tools/search.ts`,
`agent/tools/fs.ts` non hanno backoff (grep mirato: zero occorrenze di "retry" in quei tre file).
Un fallimento di tool call diventa un `tool_result` con `isError:true` (`agent/loop.ts:1886`,
`1736-1825`) che il modello *può* scegliere di ritentare nella prossima iterazione — un pattern
conversazionale, non una garanzia di sistema. Nessuno scenario (report dal vivo: "nessuno scenario
B6"), nessun test intitolato al concetto.
**Journey**: J4 (scheduler/crash-effetti) — parzialmente; principalmente standalone.
**Costo**: M — richiede prima una decisione di design (retry automatico per fallimenti transienti di
un tool idempotente, vs. affidarsi al modello) prima di poter essere "chiuso" con test+scenario.

### B7 — Scheduler
**Stato proposto**: BLOCKER.
**Evidenza**: il dato **sopravvive** meccanicamente (JobStore su SQLite, nessun migration runner
necessario perché additivo — stesso schema di A6/A7), ma la **garanzia** che Gate 1 chiede
(job affidabili attraverso un riavvio reale, non solo un file che resta sul disco) è rotta su tre
fronti, tutti **STILL PRESENT** contro `origin/dev` per `research/audit-2026-08-16/README.md`
(righe 31-33, 35, riletto in questa sessione, non ri-eseguito dal vivo — vedi limiti):
1. P19/P20/P21(1) — **HIGH** — `heldBy()` (`core/lock/durable.ts:74`) giudica "stale" dal solo
   wall-clock, **mai** da `alive(pid)`: un turno/lock posseduto da un pid vivo (es. laptop
   riaddormentato) viene liberato e rieseguito da un secondo processo; nessun fencing token sulla
   delivery. L'audit lo marca "probabilmente l'evento più comune dei 14 giorni per un agente
   personale su una macchina reale".
2. P21(4) — MEDIUM — nessun fire-claim/idempotency key sul path del job
   (`core/scheduler/scheduler.ts:240,704`): un crash fra l'esecuzione del goal e `markRan()` lo
   riesegue **integralmente** al riavvio, effetti dei tool inclusi — violazione diretta
   dell'invariante 1 del mandato (EFFECT WAL).
3. P21(2) — MEDIUM — l'evento `yielded` non ha consumer in produzione (`cli/gateway.ts`/
   `cli/repl.ts` filtrano solo `delivery_failed`): un job che cede ripetutamente è invisibile.
Nessuno scenario di accettazione (report dal vivo: "nessuno scenario B7").
**Journey**: J4 (scheduler/crash-effetti) — con B8, B9.
**Costo**: L. Stessa causa radice di P19/P20/P21(1) è in una funzione sola (`heldBy()`), l'audit
stesso raccomanda "una slice sola" per il cluster lock/lease/fencing.

### B8 — Delivery
**Stato proposto**: BLOCKER *(riclassificato da READY — vedi "Finding maggiore" in testa al file)*.
**Evidenza**: scenario dedicato **esiste già** ed è **rosso per progetto**:
`evals/acceptance/scenarios/b-continuity.accept.ts:74-141`, manifest
`evals/acceptance/manifest.ts:54-61` (`atteso-rosso`, `closedBy: 'slice/superfici'`). Meccanismo:
`Scheduler.settle` (`core/scheduler/scheduler.ts:314-347`) registra l'esito di consegna sulla riga
`turns` **prima** di `markRan` (ordine corretto, provato), ma `markRan` avanza **comunque**
(riga 341-342) anche quando `delivery.delivered === false` — per una ragione di design dichiarata
("A failed delivery must not put the fire back", riga 302-306), non un bug isolato. Il problema più
grande che lo scenario cattura: il canale `telegram` **non è cablato affatto** nel gateway —
`cli/gateway.ts:506` scrive *"consegna remota da cablare"* su stderr, solo `'cli'` ha una consegna
reale. `last_run_at` risulta valorizzato anche se l'owner non ha ricevuto nulla. Confermato anche
da `STATE.md` (M5, "Resta di M5"): "un messaggio schedulato per canale remoto emerge nel REPL
invece di sparire" — noto, non nuovo, ma **non ancora chiuso** nonostante M5-BIS lo segni READY.
**Journey**: J4 (scheduler/crash-effetti) — con B7, B9.
**Costo**: M. Dipendenza dichiarata: `slice/superfici`.

### B9 — Proactivity
**Stato proposto**: BLOCKER.
**Evidenza**: `ProactiveKind` oggi ha **4** valori (non 5 come dice il testo corrente di
M5-BIS — `consolidation` è stato rimosso da ADR-0038, `core/scheduler/proactivity.ts:44-81`):
`commitment_due`, `deadline_near`, `fact_actionable`, `gone_quiet`. Di questi, **3 su 4** non hanno
produttore (grep mirato su tutto il repo per ciascun valore letterale: zero risultati per i primi
tre fuori dal file che li dichiara). Solo `gone_quiet` ha un produttore reale
(`core/scheduler/observe.ts:109,128`) **ed è cablato** a `decideProactive`
(`cli/observe.ts:12,160`: `decide: decideProactive`) — ma **solo su invocazione manuale**
(`muffin observe [--send]`, `cli/main.ts:92,213`), non da uno scheduler autonomo: la riga Gate 1
chiede "agisce **spontaneamente**", e oggi richiede che l'owner lanci il comando. Nessuno scenario
(report dal vivo: "nessuno scenario B9").
**Journey**: J4 — con B7, B8.
**Costo**: L. Tre detector nuovi (`commitment_due`, `deadline_near`, `fact_actionable`) più un
trigger schedulato per `gone_quiet` (oggi solo on-demand).

### B10 — Telegram (messaggi, file, immagini, errori)
**Stato proposto**: BLOCKER.
**Evidenza**: messaggi — ok (testo, `Incoming`). File/documenti — ok, provato
(`connectors/telegram/document-arrival.test.ts`, C7). **Immagini — bloccate**: `media.ts:29,48-50`
riconosce `kind:'photo'`, il file scarica e finisce in `vault/inbox/`, ma
`core/vault/vault.ts:334-337` lo **salta** dall'indicizzazione ("non è testo né PDF né DOCX — serve
un estrattore"); nessun content-block immagine esiste nel confine col provider (grep mirato su
`agent/providers/types.ts`: zero occorrenze di `'image'`/`ImageBlock`/`base64`) — quindi una foto
inviata a Muffin non è né indicizzata né vista dal modello, solo scaricata su disco. Errori — gestiti
a pezzi (`connector.ts:190-198` conflitto polling 409, `:429-457` fallimento delivery/registrazione)
ma non come proprietà unica testata. Nessuno scenario dedicato (report dal vivo: "nessuno scenario
B10"; `document-arrival.test.ts` copre solo la metà documento, non l'intera riga).
**Journey**: J3 (fault-chain Telegram) — con B1, B15, B16.
**Costo**: M. Decisione di design condivisa con B16 (l'immagine ha bisogno o di un percorso
vision/OCR o di un invólucro tipizzato che dichiari esplicitamente "non leggibile" invece di sparire
silenziosamente nello skip del vault).

### B11 — Streaming
**Stato proposto**: READY (confermato, nessuna evidenza nuova necessaria — M5-BIS già documenta le
sette condizioni per esteso con file:riga precisi).
**Evidenza**: report dal vivo: **verde** su
`evals/acceptance/scenarios/b-streaming.accept.ts`. Wiring reale attraverso `buildRuntime`
(`cli/repl.test.ts`, `connectors/telegram/streaming.test.ts`), non provider sostituiti a mano.
**Journey**: J3. **Costo**: — (chiuso). Discord resta OUT (B17).

### B12 — Overflow
**Stato proposto**: BLOCKER.
**Evidenza**: `agent/context/compact.ts:58-117` (`compactToolResults`) — quando un risultato non
entra nel budget, **l'intero payload viene sostituito** da un placeholder (riga 89-101: se
`chars > budget`, l'intero blocco è cancellato e rimpiazzato, non troncato testa+coda), e non esiste
**nessun** meccanismo che scriva l'output grande come file richiamabile: grep mirato su tutto il
repo per pattern di overflow-verso-vault (`overflow`, `troppo grand*`, `writeOversized`) — zero
risultati pertinenti. Questo è esattamente il gap che l'owner ha segnalato lui stesso (citato in
M5-BIS: *"quando le cose sono troppo grandi le manda come file del vault?"*) e che il confronto
Hermes marca come **difetto**, non mancanza (M5-BIS: "cancella il payload intero mentre ogni cap
sotto è testa+coda"). Nessuno scenario (report dal vivo: "nessuno scenario B12").
**Journey**: J5 (overflow+progress) — con B13.
**Costo**: M. Il meccanismo di cap esiste già (`budgetChars`, `keep()` per tool) — serve solo
aggiungere lo scrivi-su-file-invece-di-cancellare come alternativa al placeholder puro.

### B13 — Progress
**Stato proposto**: BLOCKER.
**Evidenza**: esiste un substrato strutturale non sfruttato — `core/turns/store.ts:333`
(`updated_at`, indicizzato `idx_turns_status ON turns(status, updated_at)`) viene aggiornato ad ogni
iterazione via `checkpoint()` (`core/turns/store.ts:779-790`), quindi un turno lungo **lascia un
segno durevole** ogni giro, non solo cosmetico. Ma **nessun consumer lo legge come segnale di
vita**: `cli/doctor.ts` non ha un check "turno in corso da Nm, ultimo progresso Ns fa" (verificato
leggendo l'intero file — i check su `turns` riguardano solo interrotti/sospesi/non consegnati, mai
`running` con `updated_at` recente vs. stantio). Il battito che esiste (`core/gateway/service.ts:49,
233`) è a livello processo/scheduler, non per singolo turno. Nessuno scenario (report dal vivo:
"nessuno scenario B13").
**Journey**: J5 — con B12.
**Costo**: S-M. Il dato esiste già; serve solo il lettore (doctor + eventualmente un segnale verso
la superficie).

### B14 — Attachment
**Stato proposto**: BLOCKER *(per assenza di scenario — la capability stessa sembra reale)*.
**Evidenza**: `agent/tools/deliver.ts:58` dichiara `hostOnly: true` sulla capability `send_file`
(coerente col caveat che M5-BIS già scrive: "un member non può ricevere un proprio file");
`core/surface/registry.ts:58-61` (`deliverFile`) è il percorso reale verso
`Surface.deliverFile` su Telegram/Discord. Implementazione, wiring e la limitazione dichiarata ci
sono. **Manca lo scenario di accettazione**: il report dal vivo lo nomina esplicitamente fra le 8
righe "READY senza scenario" (assieme a C2, C3, C6, C7, D4, D6, E4) — la stessa lista che
`STATE.md` già cita come debito aperto. Per la regola delle sette condizioni, l'assenza di uno
scenario reale basta a non poter dire "chiuso".
**Journey**: J3 (fault-chain Telegram) — estensione naturale, stesso harness del documento.
**Costo**: S — solo lo scenario, la capability non sembra rotta.

### B15 — Owner binding
**Stato proposto**: BLOCKER (confermato, con evidenza diretta aggiuntiva).
**Evidenza**: metà "autenticato" — ok:
`connectors/{telegram,discord}/impersonation.test.ts` esistono entrambi e sono citati come prova
(verificata la loro esistenza, non ri-eseguiti in questo giro); `core/surface/types.ts:257`
(`identify`), `:294` (`tierOf`); Discord `channel_type === 1` come check DM fail-closed
(`connectors/discord/parse.ts` — verificato: righe ~103-124, commento esplicito "fail-closed:
assente è rifiutato, non assunto DM"). Metà "protetto" — **rotta, confermata leggendo lo schema**:
`core/config/config.ts:80` — `ownerUserId: z.number().int().optional()` vive dentro
`ConfigSchema.surfaces.telegram`, cioè `config.json` **ordinario**, non sigillato nel Root of Trust
— nessun file in `rot/` porta questo binding (verificato: `defaults/rot/` contiene solo
`identity.md`/`policy.json`/`budgets.json`/altri manifest di sicurezza, non il pairing telegram).
Un processo che scrive `config.json` (non protetto da `rot reseal`) può ripuntare il binding senza
che `doctor` se ne accorga.
**Journey**: J3 — con B1, B10, B16.
**Costo**: M. Spostare `ownerUserId`/pairing dentro il Root of Trust (sigillato, letto da
`verify()`) invece che in `config.json`.

### B16 — Ingress parsing
**Stato proposto**: BLOCKER (confermato).
**Evidenza**: nessun invólucro universale tipizzato con provenienza/tier per campo — verificato per
assenza: nessun modulo `core/surface/envelope.ts` o equivalente nel repo. Discord non legge
username/global_name/bio per l'identità (stessa non-conflation di Telegram, verificato in
`connectors/discord/parse.ts`), ma questo è solo la metà "non peggiorare" — la parte costruttiva
(bio, filename, metadata, OCR, trascrizioni tutte tipizzate e taintate uniformemente) non esiste.
Aggravante trovata in questo triage: le immagini (B10) non hanno nemmeno un parser che le
raggiunga — non è solo "non taintate", è "mai lette". Nessuno scenario (report dal vivo: "nessuno
scenario B16").
**Journey**: J3 — con B1, B10, B15.
**Costo**: L. Design cross-cutting: tocca ogni connector (Telegram, Discord) e ogni campo
model-visible (filename, bio, caption, metadata EXIF, futuro OCR/trascrizione).

### B17 — Ripresa su Discord
**Stato proposto**: OUT (confermato, ragione legata alla finestra).
**Evidenza**: `connectors/discord/connector.ts:365` — commento esplicito: "Discord has no
`deliverTo` yet". Nessuna porta nel `SurfaceRegistry` per la ripresa Discord. **Ragione dei 14
giorni**: CLAUDE.md fissa esplicitamente la finestra come "CLI+Telegram privato"; Discord non è
nell'uso personale owner-solo di questi 14 giorni (i gruppi, di cui Discord è oggi il veicolo
principale nel codice, restano fuori per direttiva `STATE.md`/roadmap). Non è "è difficile": è
fuori perimetro per costruzione della finestra.
**Journey**: nessuna — riga isolata, esplicitamente rimandata.
**Costo**: — (OUT, nessun costo nei 14 giorni). Prerequisito per riattivare in futuro:
`DiscordConnector.deliverTo` + porta nel `SurfaceRegistry`.

---

## Journey proposte (max 6)

**J1 — Boot → doctor → migrazione (A1, A5, A6, A7).**
Passi: seed di una home con schema "vecchio" popolato (episodi, fatti, turni, job) →
`muffin doctor` (baseline sana) → aggiornamento del binario (nuovo codice, stesso home) →
riapertura → `doctor` di nuovo → un turno → `memory search` → `muffin jobs list`. Fault injection:
un nuovo valore `episodes.kind` mai scritto prima; un nuovo `TurnStatus` ipotetico. Asserisce: A1
(stato ritrovato) resta vero su schema popolato, non solo fresco; A6/A7 (nessuna perdita, nessun
crash su `ALTER`/`CHECK`); A5 (doctor nomina un eventuale schema-mismatch — oggi non lo fa, audit
P38 LOW: "doctor non ha alcun controllo dedicato di schema-mismatch").

**J2 — Backup live → distruzione → restore (A8, tocca A6).**
Passi: install → alcuni turni/fatti → avvia `muffin gateway run` → **durante** un job/turno in
corso, `cp -R` della home → ferma il gateway copiato → verifica integrità DB (apertura, non
corrotto) → distrugge l'originale → ripristina dalla copia → `doctor` + `memory search`. Punto di
crash: copia a metà scrittura WAL. Asserisce: la proprietà "un solo home = backup" regge anche a
caldo, non solo a processo fermo.

**J3 — Fault-chain Telegram: inbound → provenance → context → decision → effect → persistence →
crash → resume → delivery (B1, B2, B10, B14, B15, B16, tocca B3/B4/B5/B11 già verdi).**
Passi: bot fake riceve un messaggio + una foto da un mittente che dichiara username/bio uguali
all'owner ma id diverso → `identify()` lo rifiuta → messaggio genuino owner con testo lungo (turno
che richiederebbe minuti) → verifica che il connector non tenga la richiesta HTTP aperta
(`enqueueTurn`, oggi impossibile: B2) → `SIGKILL` a metà → riavvio → gateway riprende → consegna →
verifica che la sessione Telegram e una sessione CLI sullo stesso tenant vedano la stessa memoria
(non la stessa sessione letterale) → invia un file, verifica arrivo come allegato. Fault injection:
crash fra creazione riga turno e ack update Telegram (invariante 4 del mandato); crash fra send
riuscito e `markProcessed`. Asserisce: B1 (metà Telegram), B2, B10 (foto: cosa succede oggi —
fallisce esplicitamente invece di sparire), B14, B15 (binding sopravvive a manomissione config.json
non sigillato — oggi non la rileva), B16 (ogni campo letto ha provenienza).

**J4 — Scheduler/crash-effetti: job due → tick → crash fra goal e markRan → restart → verifica
niente doppio effetto (B7, B8, B9).**
Passi: job cron dovuto → gateway tick → uccidi il processo fra l'esecuzione del goal (es. un
`send_file`) e `markRan` → riavvia il gateway → verifica che l'effetto (file inviato) non si ripeta
→ verifica `last_run_at`/delivery coerenti col canale reale (telegram vs cli) → job proattivo
`fact_actionable` mai armato (nessun produttore) vs `gone_quiet` armato solo da invocazione manuale.
Punto di crash: fra `runJob` e `this.store.markRan` (`scheduler.ts:207→270/342`). Asserisce: B7
(niente doppia esecuzione), B8 (delivery telegram cablata e verace), B9 (nessun trigger spontaneo
oggi per 3 kind su 4).

**J5 — Overflow + progress: tool con output enorme + turno lungo multi-iterazione (B12, B13).**
Passi: un tool (es. `fs_read` su un file grande, o `web_search`) produce un output oltre il budget
di contesto → verifica cosa arriva al modello (oggi: placeholder che cancella tutto) e se è
richiamabile per intero (oggi: solo ri-chiamando il tool, non da un file persistito) → turno con 10+
iterazioni tool → interroga `doctor`/un lettore esterno per "è ancora vivo?" mentre gira (oggi:
nessun check legge `updated_at`). Asserisce: B12 (nessun overflow-a-file), B13 (nessun consumer del
segnale strutturale che pure esiste in `turns.updated_at`).

**J6 — First-run identity/config (A2, A3, A4, A9).**
Passi: `muffin init --local` (oggi assente) riusando un secret già persistito → onboarding segnala
esplicitamente le sezioni vuote di `identity.md`/`persona.md §Al primo incontro` invece di lasciarle
scivolare in silenzio → `muffin config` lista tutto, owner edita `config.json`/`rot/policy.json` a
mano → `muffin rot reseal` → `doctor` conferma la modifica come dichiarata, non come manomissione.
Asserisce: A9 (init locale), A2/A3 (il gap è visibile, non solo documentato in un file che nessuno
legge al boot), A4 (l'edit a mano regge end-to-end).

---

## Cosa non ho potuto stabilire

- **Nessun `vitest run` eseguito in questo giro** oltre al solo `npx tsx evals/acceptance/report.ts`
  (che non invoca vitest — legge manifest e M5-BIS, per costruzione). I 4 audit test `zz-*`
  copiabili dal worktree dell'audit (P19/P20/P21, rilevanti per B7) non sono stati ri-eseguiti qui:
  mi sono affidato alla classificazione già scritta in `research/audit-2026-08-16/README.md`
  (datata 17/08, verificata contro `origin/dev` a `b9ab672a`), non a un'esecuzione mia.
- **A8 (backup a caldo)**: non ho eseguito un test reale con `cp -R` mentre `muffin gateway run` è
  attivo — il rischio WAL è dedotto dal `pragma('journal_mode = WAL')` in `cli/init.ts:110`, non
  osservato fallire. Potrebbe essere già innocuo se SQLite gestisce la copia dei tre file
  (`.db`/`.db-wal`/`.db-shm`) meglio del previsto su APFS/ext4 — non verificato. Il declassamento a
  BLOCKER si basa su un rischio dedotto, non riprodotto: se l'orchestratore vuole tenerlo READY
  finché non c'è un repro rosso, è una call legittima — l'ho segnalato come trovato-adesso invece di
  lasciarlo silenzioso.
- **B1**: non ho verificato se esista già, in un branch/worktree diverso da questo, uno scenario
  Telegram-side per la continuità di memoria (solo `origin/dev` letto). Se `slice/superfici` lo sta
  già costruendo, l'evidenza andrebbe riconciliata.
- **B6**: non ho verificato se un tool come `http_get` abbia un retry *interno* al di sotto del
  livello che ho letto (es. dentro `undici`/fetch nativo con retry automatico su connessione
  rifiutata) — ho verificato solo l'assenza di retry esplicito nel codice applicativo di Muffin.
- **B9**: non ho verificato se `muffin observe` sia mai invocato dallo scheduler/gateway stesso
  (come job periodico) in un percorso che il mio grep non ha trovato per un nome diverso — ho
  cercato `decideProactive(` e i produttori dei 4 kind letterali, non ogni possibile alias.
- **Costo (S/M/L)** è una stima da lettura del codice, non da aver implementato — in particolare B7
  e B16 potrebbero rivelarsi più o meno grandi una volta scomposti in slice.

---

## Riepilogo per stato proposto

- **READY (6)**: A1, A5, B3, B4, B5, B11.
- **BLOCKER (19)**: A2, A3, A4, A6, A7, A8, A9, B1, B2, B6, B7, B8, B9, B10, B12, B13, B14, B15, B16.
- **OUT (1)**: B17.
- **INVALIDATED (0)**.
- Totale: 26 righe (A1-A9, B1-B17).
