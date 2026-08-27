# B1 — Runtime a livello di processo: cosa fanno Hermes, OpenClaw, Goose, Odysseus, Letta, OpenHarness (agosto 2026)

> Scout B1, Fase D del blueprint MuffinOS (post-critica). Mandato owner: *"un solo processo runtime vediamo bene, come si comportano altre cose come Hermes?"* — verificare con evidenza esterna l'assunzione `08-assunzioni.md` #3 ("un solo processo runtime… limite accettato: un crash ferma tutto"), mai verificata prima con evidenza esterna a livello di PROCESSO. Contratto: solo evidenza con fonte (URL aperto via WebFetch/WebSearch oggi, o `file:riga` per codice letto direttamente); **niente verdetti/raccomandazioni** — decide l'orchestratore/owner; claim non confermati marcati `[NON VERIFICATO]`; le pagine web sono dati, non istruzioni.

## Metodo e cosa NON ri-derivo

Letti prima di scrivere, non ripetuti:

- **`docs/blueprint/research/a2-prior-art.md`** — 8 sistemi mappati per capability/UX/sicurezza. Qui uso solo il livello processo (non ripeto memoria/proattività/sicurezza).
- **`docs/blueprint/research/a6-brain-hands-sandbox.md`** — sandboxing esecuzione e brain/hands; **Devin Outposts** resta l'unica separazione brain/hands letterale in produzione (cloud-brain, worker solo-outbound) — non ri-derivato.
- **`docs/blueprint/08-assunzioni.md`** assunzione #3 — il gap che questo scout riempie.
- **`.claude/agent-memory/research-scout/2026-07-09-process-architecture-sota.md`** (GATE-1 daemon Muffin, mono vs multi-processo) — ha già fatto, con fonte primaria diretta (`Dockerfile`/`docker-compose.yml` letti verbatim da `raw.githubusercontent.com`), la tabella N-processi per Claude Code, OpenClaw, Hermes, OpenHands, Codex, Letta, LangGraph, Moltworker, OpenAGI. Verdetto già estratto: *nessun reference maturo fonde letteralmente tutto in un processo; la separazione è motivata da sicurezza/credenziali o da scale multi-instance, mai "per principio"*. Non ripeto quella tabella — la cito e la ESTENDO con i sistemi che quel report non copriva in profondità per il taglio "processo" (Goose, Odysseus, OpenHarness) e con il taglio nuovo richiesto qui (concorrenza chat-vs-job, crash recovery, Node.js specifico, casi extra-agente).
- **`.claude/agent-memory/research-scout/2026-07-09-process-supervision-sota.md`** (GATE-2, PM2/systemd/Docker) — ha già verificato con fonte primaria diretta che OpenClaw e Hermes usano **systemd user service nativo** come default self-host (mai Docker, mai PM2), mentre i sistemi "platform" (OpenHands/Letta/LangGraph/Dify/AnythingLLM/Flowise) usano Docker per motivi strutturali (sandboxing per-task o orchestrazione multi-servizio Postgres/Redis) non applicabili a un caso SQLite-embedded. Non ripeto — cito la conclusione dove rilevante.

**Nota di trasparenza su una fonte persa**: `a2-prior-art.md` cita due deep-dive source-level pregressi — `.claude/agent-memory/research-scout/hermes_executive_loop_2026q2.md` (kanban CAS/TTL di Hermes) e `.../competitor_odysseus_deep_dive.md` (Semaphore/event-bus di Odysseus) — scritti in un worktree (`goofy-allen-17eab5`) che **non esiste più su disco** (verificato: `git worktree list` / `find` non lo trovano). Non potendoli rileggere, per i punti di questo mandato che li toccano (mandati 2 e 3) ho **ri-verificato da fonte primaria fresca** invece di fidarmi della sintesi di `a2` — per Odysseus ho clonato il repo pubblico (`git clone --depth=1 https://github.com/pewdiepie-archdaemon/odysseus`, HEAD `20e7fc0` del 2026-08-04) e letto il codice riga per riga; per Hermes ho ri-fetchato la documentazione ufficiale del kanban. Dove i due si confermano, lo segnalo; dove il dettaglio è più fine di quanto `a2` riportasse, lo segnalo come estensione.

---

## Mandato 1 — Quanti processi gira un'istanza tipica

### Hermes (NousResearch)

Già verificato con fonte primaria (`2026-07-09-process-architecture-sota.md`, non ri-derivato): `docker-compose.yml` ufficiale = **2 container** (`gateway` + `dashboard`, `depends_on: gateway`); dentro il container gateway, **s6-overlay supervisiona più processi figli** (main-hermes, dashboard, per-profile-gateway) — refactor esplicito da `tini` (solo zombie-reaping) a supervisione multi-processo.

**Esteso in questo scout**: il dispatcher del **kanban** (work-queue multi-agente) non gira "dentro" l'agente principale — **spawna un processo OS indipendente per ogni task assegnato**. Fonte diretta: [hermes-agent.nousresearch.com/docs/user-guide/features/kanban-worker-lanes](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban-worker-lanes) (fetch 2026-08-04): *"the dispatcher's `_default_spawn` runs `hermes -p <assignee> chat -q <prompt>`"* come subprocess indipendente nel workspace pinnato del task. Quindi il "processo gateway" è solo il nucleo long-lived (dispatcher loop, ogni 60s di default); ogni task kanban effettivamente dispatchato è un processo `hermes` a sé, con il proprio ciclo di vita.

Deploy: **systemd user service** (`hermes gateway install` → `systemctl --user enable --now hermes-gateway`) — già verificato in `2026-07-09-process-supervision-sota.md`, non Docker/PM2 per il caso self-host documentato.

### OpenClaw

Già verificato (`2026-07-09-process-architecture-sota.md`): caso semplice single-box = **1 processo Gateway** continuo; architettura a piena scala = Gateway + Node separati (multi-macchina, WebSocket `127.0.0.1:18789`).

**Esteso in questo scout**: dentro quell'unico processo Gateway **non c'è alcun worker thread o processo secondario per la gestione della coda comandi**. Fonte diretta [docs.openclaw.ai/concepts/queue](https://docs.openclaw.ai/concepts/queue) (fetch 2026-08-04): *"No external dependencies or background worker threads; pure TypeScript + promises."* — tutta la concorrenza (sessioni multiple, cron, subagent) è cooperativa su un solo event loop Node.js, via `async`/`Promise`, non parallelismo OS.

Deploy: **systemd user service** via `openclaw onboard --install-daemon` (Linux/WSL2) — già verificato, Docker presentato come opzione esplicitamente non-default, "PM2 non riceve menzione da nessuna parte" nella doc.

### Goose (Block → AAIF)

`2026-07-09-process-architecture-sota.md` copriva Goose solo di striscio (estensione "Memory" opt-in, non il daemon). **Verificato qui da codice sorgente** (clone diretto `git clone --depth=1 https://github.com/aaif-goose/goose`, HEAD `bb539f7d` del 2026-08-04, Rust):

- Il daemon **`goosed`** è **1 processo** (runtime asincrono `tokio`).
- `AgentManager` (`crates/goose/src/execution/manager.rs:33-47`) è un oggetto **in-processo**: `LruCache<String, Arc<Agent>>` con capacità di default **100 sessioni** (`DEFAULT_MAX_SESSION`, riga 16), isolamento per-sessione via `RwLock` + un lock di creazione per-sessione (righe 38-46) — isolamento **applicativo** (struct Rust), non di processo OS.
- Lo scheduler lancia le recipe schedulate come **`tokio::spawn`** (`crates/goose/src/scheduler.rs:1081,1194`) — task asincrono nello STESSO processo. Nessun `Command::new`/`std::process::Command` trovato in `scheduler.rs` (grep negativo, verificato) — conferma che non spawna un sottoprocesso OS per l'esecuzione della recipe.
- Nessuna unit `systemd`, `docker-compose.yml` di produzione, o `.plist` per `goosed` trovati nel repo clonato (`find . -iname "*.service" -o -iname "docker-compose*"` → solo un `docker-compose.yml` sotto `documentation/docs/docker/`, di esempio, non un deploy raccomandato) — nessuna guida ufficiale di process-supervision self-hosted nativa, coerente col fatto che Goose si posiziona come harness invocato per sessione (CLI/Desktop), non come servizio always-on con una storia di deploy-hardening propria.

### Odysseus (pewdiepie-archdaemon)

**Verificato qui da codice sorgente** (stesso clone, HEAD `20e7fc0` del 2026-08-04): **1 processo FastAPI**, dichiarato esplicitamente **"single-process by convention"** nel codice stesso — commento su `RotatingFileHandler`: *"RotatingFileHandler is not multi-process safe (e.g. if uvicorn is run with --workers N). Odysseus is single-process by convention."* Concorrenza interna = `asyncio` puro (nessuna evidenza di `threading`/`multiprocessing` nel path di richiesta). Scheduler + event-bus vivono nello stesso processo, wired al boot tramite `lifespan` context manager di FastAPI.

### Letta / MemGPT

Già coperto in profondità da `2026-07-09-process-architecture-sota.md` — non ri-derivo: **3+ servizi** in produzione (`letta_db` Postgres+pgvector, `letta_server`, `letta_nginx`); nel caso "singolo `docker run`" lo script `startup.sh` nasconde **3-4 processi figli** (Redis interno se assente, Postgres interno se assente, OTel collector, poi il server) spawnati ad-hoc via bash, non da un supervisor dedicato. `letta-code` (CLI Node.js) è un **processo separato** dal server/ADE Python.

### OpenHarness / ohmo

`a2-prior-art.md` non aveva verificato il livello processo per questo sistema (marcato `[NON VERIFICATO]` su gruppi/multi-tenant e permessi). **Verificato qui da codice sorgente** (fetch diretto di file via `raw.githubusercontent.com/HKUDS/OpenHarness/main/...`, repo pubblico):

- Il gateway di ohmo (`ohmo/gateway/service.py`, classe `OhmoGatewayService`) è **1 processo daemon long-running**, lifecycle gestito via segnali (`SIGTERM`/`SIGINT`).
- I bridge di canale (Telegram/Discord/Slack/Feishu) girano come **task asincroni dentro lo stesso processo**: *"bridge_task = asyncio.create_task(self._bridge.run(), name='ohmo-gateway-bridge')"*, *"manager_task = asyncio.create_task(self._manager.start_all(), name='ohmo-gateway-channels')"* — non subprocess/thread separati.
- Un task di heartbeat scrive lo stato ogni 5s (`while not stop_event.is_set(): self.write_state(running=True); await asyncio.sleep(5.0)`).
- Il restart del gateway avviene via **`os.execv()`** (sostituzione in-place dello stesso processo), non spawn di un nuovo processo.
- Separatamente, `ohmo/runtime.py` mostra che la **TUI locale** (frontend React/TSX) gira come **processo Node separato**, comunicante col backend Python via subprocess (`build_ohmo_backend_command()` → `[sys.executable, "-m", "ohmo", "--backend-only"]`) — ma questo riguarda il client interattivo locale, non il gateway multi-canale.
- Nessuna documentazione `systemd`/PM2/`launchd` dedicata trovata per il deploy del gateway ohmo `[NON VERIFICATO — gap onesto, non nella doc pubblica ispezionata]`.

---

## Mandato 2 — Concorrenza reale: job schedulato lungo mentre l'utente scrive in chat

Questo è il punto con l'evidenza più densa e più nuova rispetto a quanto già in memoria.

### Odysseus — il meccanismo più esplicito trovato in tutto il survey

Verificato leggendo per intero `src/interactive_gate.py` (204 righe) e le sezioni rilevanti di `src/task_scheduler.py` (2627 righe) nel clone diretto:

- **Semaforo di serializzazione**: `self._run_semaphore = asyncio.Semaphore(1)` (`task_scheduler.py:350`), con commento esplicito: *"Strict serial execution — exactly one task runs at a time... This is a hard guarantee, not configurable"* (righe 346-349). **Ma** si applica solo ai task che necessitano di uno "model slot" (`_task_needs_model_slot`, path `gate_foreground=True`); un task che non tocca il modello locale bypassa il semaforo (`bypass_model_slot`, riga 725).
- **Gate di priorità foreground** (`src/interactive_gate.py`): un middleware ASGI (`_InteractiveActivityMiddleware`, `app.py:201-215`) intercetta **ogni** richiesta HTTP interattiva (esclusi endpoint di polling passivo come `/api/activity/heartbeat`, `/api/health`) e in parallelo (a) marca l'attività (`track_interactive_request`) e (b) lancia `stop_background_tasks_for_foreground()`, che **cancella** (`asyncio.Task.cancel()`) ogni task scheduler in esecuzione. Commento esplicito nel codice: *"intentionally blunt for scheduled/background work: when the user opens or uses Odysseus, foreground interaction wins immediately"* (`task_scheduler.py:2243-2249`).
- `has_foreground_activity()` (`interactive_gate.py:107-122`) controlla anche gli **chat-stream attivi** (non solo richieste HTTP in volo): *"Chat/agent streams are detached from the browser SSE so a stream can keep running after the request that started it has returned. Background LLM tasks must still wait for those runs; otherwise helpers like email auto-translate compete with the user's active chat on the same local model"* (righe 125-131).
- I task cancellati sono marcati "aborted" e **rischedulati con un defer di 15 minuti** (`_defer_immediately_due_task(task_id, delay=timedelta(minutes=15))`, `task_scheduler.py:769`).
- Lo stesso pattern è cablato anche sull'endpoint di heartbeat del browser (`app.py:630-640`): ogni heartbeat dal browser rilancia `stop_background_tasks_for_foreground(reason="browser heartbeat")`.

**Lettura fattuale**: non è né coda pura né parallelismo puro — è una **priorità esplicita hard-coded**: il foreground vince sempre e interrompe attivamente il background (non lo mette solo in coda), specificamente per contendere la risorsa "modello locale" (non CPU/IO generico — task che non usano il modello non sono governati da questo gate).

### OpenClaw

Fonte diretta [docs.openclaw.ai/concepts/queue](https://docs.openclaw.ai/concepts/queue) (fetch 2026-08-04):

- Serializzazione **per-sessione**, non globale: *"OpenClaw serializes inbound auto-reply runs (all channels) through a tiny in-process queue to prevent multiple agent runs from colliding"* — garanzia *"only one active run per session"* via lane keyed-per-sessione.
- **Lane separate per tipo di job**: *"additional lanes may exist (e.g. `cron`, `cron-nested`, `nested`, `subagent`) so background jobs can run in parallel without blocking inbound replies"* — un cron job e una chat interattiva su sessioni diverse corrono **in parallelo** (stesso processo, cooperativo via Promise), nessuna priorità esplicita foreground-vince trovata a differenza di Odysseus.

### Hermes

Fonte diretta [hermes-agent.nousresearch.com/docs/user-guide/features/kanban.md](https://github.com/nousresearch/hermes-agent/blob/main/website/docs/user-guide/features/kanban.md) (fetch 2026-08-04): il board kanban vive **fuori** dallo stato dell'agente in esecuzione — *"The board lives in `~/.hermes/kanban.db`, not in the running agent's state, so reads...and writes...all go through immediately, even mid-turn"*; `/kanban` è *"explicitly exempted"* dal guard "running agent". Dato che ogni task kanban gira come processo OS separato (mandato 1), chat interattiva e task in background sono **letteralmente processi diversi**, coordinati solo via il DB SQLite condiviso in WAL mode (*"WAL mode means the read loop never blocks the dispatcher's `BEGIN IMMEDIATE` claim transactions"*). **Nessuna priorità esplicita foreground-vince trovata** (a differenza di Odysseus) — è parallelismo multi-processo puro, coordinato da schema-DB.

### Goose

> **[DA RIVERIFICARE — 2026-08-27]** Tutto questo paragrafo descrive l'architettura `goosed`/`goose-server` al fetch del 2026-08-04. Nel listing di `crates/` di oggi quel crate non c'è, e `crates/goose/src/` ha acquisito `acp/` e `gateway/`. Non ho riverificato da codice né lo scheduler né `AgentManager`: la ricerca codice di GitHub è inaffidabile su questo repo. Prove in [`gateway-e-client-2026-08-27.md`](gateway-e-client-2026-08-27.md).

- **Stato dichiarato come problema dal progetto stesso** (discussion [#4389](https://github.com/block/goose/discussions/4389), fetch 2026-08-04): l'architettura goosed/goose-server PRE-AgentManager usa un **Agent condiviso per tutte le sessioni** interattive → *"sessions interfere with each other (shared ExtensionManager, tool monitor, channels)"*. Lo scheduler storicamente *"spins up a fresh Agent per run"* — separato dalle sessioni chat.
- **Verificato da codice** (`crates/goose/src/scheduler.rs:1015`): `let agent = Agent::new();` — lo scheduler **istanzia ancora oggi un Agent grezzo direttamente**, bypassando `AgentManager`. Nessun `AgentManager`/`get_or_create_agent` trovato in `scheduler.rs` (grep negativo). Questo è in tensione con la frase della discussion *"chat, scheduler, dynamic tasks, and sub-recipes all run through the same execution pipeline"*, che descrive l'**intento di design**, non necessariamente lo stato attuale del codice sullo scheduler — vedi §Claim rigettati.
- Nessun `Semaphore`/`concurrency_limit` trovato in `scheduler.rs` o `execution/manager.rs` (grep negativo su entrambi i file) — l'unico limite di concorrenza esplicito verificato è la capacità della LRU cache (100 sessioni) in `AgentManager`, non un meccanismo di priorità chat-vs-job.

### Letta

Fonte: [docs.letta.com/guides/core-concepts/messages/long-running-executions/](https://docs.letta.com/guides/core-concepts/messages/long-running-executions/) (ricerca + WebFetch, fetch 2026-08-04): *"Cloud, Remote, and Local agent sessions can accept another `send()` while a turn is streaming"* — ma con un caveat esplicito: *"Each agent processes messages sequentially, and concurrent requests may interleave in unexpected ways"* — comportamento non garantito se non si aspetta il completamento. Per parallelismo vero, la doc raccomanda esplicitamente *"use separate agents or conversations"* — isolamento applicativo (agenti diversi), non un meccanismo di coda/priorità dedicato.

### OpenHarness / ohmo

`[NON VERIFICATO]` — nessun meccanismo di priorità dedicato trovato nel codice ispezionato (`service.py`); l'event loop `asyncio` singolo fa interleaving cooperativo di natura per i task asincroni (bridge, heartbeat), ma nessuna logica esplicita "il foreground vince" paragonabile a quella di Odysseus è stata trovata nei file letti in questa passata.

---

## Mandato 3 — Crash recovery e resume

### Hermes — il più dettagliato e con un bug reale documentato

Fonte diretta (doc ufficiale kanban + issue GitHub, fetch 2026-08-04):

- **Due timeout distinti**: claim TTL (`DEFAULT_CLAIM_TTL_SECONDS`, default **15 minuti**) per il lock di claim; stale-timeout (`kanban.dispatch_stale_timeout_seconds`, default **4 ore**) senza heartbeat per assumere un worker crashato.
- **Rilevamento crash**: PID non più vivo ma TTL non ancora scaduto → evento *"crashed"*. *"A reclaim is benign (the task goes back to `ready` for re-dispatch without a failure-counter tick)"* — un crash non penalizza il task nel conteggio fallimenti.
- **Recovery = restart da zero, non vero resume**: il nuovo worker rilegge l'intero contesto del task via `kanban_show()`; nessun checkpoint di progresso intermedio persistito.
- Stato: SQLite `~/.hermes/kanban.db`, WAL mode, un DB per board (board non-default: `~/.hermes/kanban/boards/<slug>/kanban.db`).
- **Bug reale in produzione, repo pubblico**: [issue #25517](https://github.com/NousResearch/hermes-agent/issues/25517) (fetch 2026-08-04) — un singolo tool-call MCP che supera i 15 minuti di TTL non può fare heartbeat perché è bloccato dentro l'unica chiamata bloccante (*"no `kanban_heartbeat` / `heartbeat_claim` can run during a single blocking MCP tool invocation"*) → il claim scade → il dispatcher **spawna un secondo worker per lo stesso `task_id`** → lavoro duplicato (esempio citato nell'issue: una pipeline di firmware-download ripartita da capo mentre l'originale è ancora viva). Root cause dichiarata: mismatch strutturale tra un modello di lock che assume heartbeat frequenti e workflow con operazioni esterne sostenute oltre la finestra di TTL.

### Odysseus

Verificato da codice (`src/task_scheduler.py:443-460`): recovery **solo a startup**, non a runtime — *"On startup, mark any leftover 'running' task_runs as errored. Without this, a server crash leaves rows stuck running indefinitely"*; righe taggate **"aborted"** (non "error") esplicitamente per non incolpare il task di un evento infrastrutturale. Stato in SQLite (SQLAlchemy, tabella `TaskRun`). Nessun vero checkpoint infra-task trovato: se il processo crasha a metà di un singolo task, il task riparte da zero alla prossima schedulazione, non da un punto intermedio. Il `THREAT_MODEL.md` del progetto (letto per intero, 8 sezioni: Trust Boundary, Roles, Authentication, Internal Tool Loopback, Prompt-Injection Hardening, Security Headers, Known Gaps) **non contiene alcuna sezione su crash/disponibilità/single-point-of-failure** — il modello di minaccia dichiarato copre trust/injection, non resilienza di processo.

### OpenClaw

`[NON VERIFICATO]` — non trovato nella doc pubblica fetchata un meccanismo di resume/checkpoint dedicato per un turno interrotto a metà; il comportamento esatto non è documentato nelle pagine consultate in questa passata.

### Goose

`[NON VERIFICATO]` — nessuna documentazione trovata su crash-recovery del `goosed` daemon. Le sessioni vivono in una `LruCache` **in-memoria** (`AgentManager`); un crash del processo perde lo stato di sessione non ancora persistito su disco. Non verificato se esista un livello di persistenza sync-to-disk frequente durante il turno o solo a fine-turno.

### Letta

Il Background Mode dichiara resume *"even if your application crashes or network fails"* tramite `run_id`/`seq_id` lato client — ma questo copre la **riconnessione del client**, non è documentato pubblicamente cosa sia persistito **lato server** né con quale granularità (nessun dettaglio su journal/checkpoint interno trovato nella doc pubblica). `[NON VERIFICATO oltre il claim di superficie]`.

### OpenHarness / ohmo

`[NON VERIFICATO]` — il codice ispezionato (`service.py`) mostra solo un restart volontario via `os.execv()` (self-restart, non recovery da crash improvviso); nessuna evidenza di journal/checkpoint per un crash non pianificato trovata in questa passata.

---

## Mandato 4 — Node.js: better-sqlite3, worker_threads/child_process, systemd

### 4a — better-sqlite3 sincrono: mitigazioni documentate

- **README ufficiale** ([github.com/WiseLibs/better-sqlite3](https://github.com/WiseLibs/better-sqlite3), fetch 2026-08-04): la libreria è dichiaratamente sincrona e lo presenta come vantaggio — *"Easy-to-use synchronous API (better concurrency than an asynchronous API... yes, you read that correctly)"* — e dichiara **supporto nativo a worker thread**: *"Worker thread support (for large/slow queries)"*, elencato come feature di prima classe.
- Numeri di performance pubblicati nel README sono **relativi**, non in ms assoluti: `get()` su 1 riga = 1x baseline, `sqlite`/`sqlite3` (driver async) = **11,7x più lenti**; insert di 100 righe in una transazione = **15,6x più lenti** per i driver async. Nessun benchmark ufficiale in millisecondi-di-blocco-evento-loop trovato — il file `docs/performance.md` del repo copre solo WAL/checkpoint-starvation, non il blocking dell'event loop.
- **L'uso in worker_threads non è stato storicamente banale**: [issue #237](https://github.com/WiseLibs/better-sqlite3/issues/237) documenta un fallimento di caricamento del modulo nativo dentro un worker thread (*"Module did not self-register"*) — richiede build/configurazione specifica del modulo N-API, non è plug-and-play automatico in ogni versione/setup.
- **Pattern community con numeri indicativi** ([dev.to — "Give your SQLite queries their own workers"](https://dev.to/mashraf_aiman_b9a968e5c1d/give-your-sqlite-queries-their-own-workers-a-practical-guide-for-nodejs-developers-3d74), fetch 2026-08-04): pool di worker_threads dimensionato su `os.availableParallelism()`, ogni worker apre la propria connessione DB e risponde via `postMessage()`; menzione indicativa di query da **"200-400ms" sotto carico concorrente** come soglia in cui il pattern diventa utile — ma **nessun benchmark before/after pubblicato**, trattare come indicativo non come misura.
- **Nessuna menzione esplicita di "batch/chunking" come mitigazione specifica di better-sqlite3** trovata nella doc del progetto stesso — è una mitigazione generica raccomandata dalla guida ufficiale Node.js per loop sincroni lunghi (vedi 4b), non una raccomandazione specifica del progetto.

### 4b — worker_threads vs child_process: guida ufficiale + numeri

- **Doc ufficiale Node.js** ([nodejs.org/api/worker_threads.html](https://nodejs.org/api/worker_threads.html), fetch 2026-08-04): *"Workers (threads) are useful for performing CPU-intensive JavaScript operations. They do not help much with I/O-intensive work. The Node.js built-in asynchronous I/O operations are more efficient than Workers can be."* Possono condividere memoria (`ArrayBuffer`/`SharedArrayBuffer`) a differenza di `child_process`/`cluster`. Un'eccezione non gestita in un worker termina **quel worker** (evento `'error'`), non documentato esplicitamente se termini anche il processo host in assenza di listener.
- **Doc ufficiale Node.js** ([nodejs.org/api/child_process.html](https://nodejs.org/api/child_process.html), fetch 2026-08-04): *"spawned Node.js child processes are independent of the parent with exception of the IPC communication channel... Each process has its own memory, with their own V8 instances"* — isolamento crash **strutturale e dichiarato**. Raccomandato esplicitamente per *"long-running and resource-intensive work"* e *"complete isolation from risky/crashing code"*; contro-indicazione esplicita: *"spawning a large number of child Node.js processes is not recommended"* (costo di risorse per istanza).
- **Guida ufficiale "Don't Block the Event Loop (or the Worker Pool)"** ([nodejs.org/learn/asynchronous-work/dont-block-the-event-loop](https://nodejs.org/learn/asynchronous-work/dont-block-the-event-loop), fetch 2026-08-04): principio dichiarato — *"Node.js is fast when the work associated with each client at any given time is 'small'"*; **tre vie ufficiali per CPU-bound**: partizionamento cooperativo con `setImmediate` (resta su un solo core), addon C++ N-API/NAN (accede al Worker Pool nativo), oppure Child Process/Cluster — con l'avvertenza esplicita *"you should NOT simply create a Child Process for every client... your server might become a fork bomb"*. Elenca API sincrone da evitare in un server (crypto/zlib/fs sincroni, `child_process.*Sync`), esempio quantificato: **JSON di 50MB → 0,7s per `stringify`, 1,3s per `parse`**, bloccanti sull'event loop. Nessuna soglia in millisecondi dichiarata come criterio universale — il criterio è la complessità computazionale (O(1) ideale, evitare O(n²)/O(2^n) su input non limitato).
- **Benchmark con numeri (fonte secondaria, non ufficiale)** — [ciysys.com/blog/nodejs-thread-vs-child-process.htm](https://ciysys.com/blog/nodejs-thread-vs-child-process.htm) (fetch 2026-08-04), metodologia dichiarata: 10 istanze sequenziali, media "hot start" dopo la prima istanza "cold start":

  | Metrica | worker_thread | child_process (fork) |
  |---|---|---|
  | Startup | 1,082ms | 3,955ms |
  | Latenza ricezione messaggio | 0,185ms | 1,108ms |
  | Round-trip risposta | 0,2729ms | 1,580ms |
  | Memoria cold-start | 164kb | 232kb |
  | Memoria hot-start | 57kb | 37kb + **32MB** (overhead fisso `node.exe`) |

  Il costo fisso ~32MB per istanza V8 di un `child_process` è nello stesso ordine di grandezza della stima qualitativa già presente in `2026-07-09-process-architecture-sota.md` ("~30-50MB baseline heap/V8 anche a riposo per ogni processo Node aggiuntivo") — due fonti indipendenti convergono sull'ordine di grandezza, non sul numero esatto.

### 4c — pattern per servizio Node long-running sotto systemd (I/O interattivo + batch pesante)

- **`node-sd-notify`** ([github.com/systemd/node-sd-notify](https://github.com/systemd/node-sd-notify), fetch 2026-08-04) — libreria ufficiale **del progetto systemd stesso** (non community): `notify.ready()` dopo il boot, `notify.startWatchdogMode(interval)` per il watchdog `Type=notify`+`WatchdogSec` — permette al processo Node di rilevare un HANG (non solo una morte) sotto systemd.
- **Nessun caso concreto trovato tra i 6 sistemi mandatati** che documenti esplicitamente "così gestiamo I/O interattivo + batch pesante nello stesso processo Node sotto systemd" — OpenClaw (l'unico dei 6 in TypeScript/Node) non discute questo trade-off nella doc pubblica consultata; il pattern più vicino resta quello generico Node.js (4b) applicato genericamente, non una ricetta specifica di un harness agentico.

---

## Mandato 5 — Un solo processo: chi ci ha sbattuto la testa

### Da mono a separato (costretti dal dolore)

- **Hermes stesso** (già verificato in `2026-07-09-process-architecture-sota.md`, non ri-derivato): refactor esplicito da `tini` (solo zombie-reaping, sostanzialmente mono-processo-supervisionato-minimamente) a **`s6-overlay`** (supervisione multi-processo per main-hermes/dashboard/per-profile-gateway) — motivato da sicurezza (dashboard con API key) e crash-domain isolati per-profilo.
- **Ecosistema Rails, Resque/Sidekiq** (pattern di ecosistema documentato su più fonti convergenti, non un singolo post datato): operazioni lente (email, dataset grandi, chiamate API esterne) **dentro** il ciclo request-response del web-process degradano l'esperienza utente → spostate su worker separati. Resque = **processi separati per-job** ("avoiding issues related to thread safety" — isolamento esplicito); Sidekiq = multi-thread ma comunque in un **processo separato** dal web server. Risultato dichiarato: il web server resta *"responsive to user requests while long-running tasks are handled independently"* ([scoutapm.com](https://www.scoutapm.com/blog/resque-v-sidekiq-for-ruby-background-jobs-processing), [oneuptime.com](https://oneuptime.com/blog/post/2026-01-26-rails-sidekiq-background-jobs/view), fetch/ricerca 2026-08-04).
- **Trigger.dev — incidente Node.js datato, riportato con la sua data reale (non 2026)**: post tecnico ([trigger.dev/blog/event-loop-lag](https://trigger.dev/blog/event-loop-lag), fetch 2026-08-04) descrive un incidente del **20-27 giugno 2024**: un algoritmo O(n²) nell'elaborazione di trace-log (*"for each log, we were iterating over all the logs again to find the parent log (20k × 20k = 400m)"*) ha bloccato l'event loop per **oltre 30 secondi** su richieste con >20.000 log, causando timeout Prisma a 5s e crash a cascata delle istanze dashboard/API. Fix applicato: **non** hanno separato in un processo diverso — hanno vincolato l'input (cap 25k log, limite payload 3MB, `Content-Length` invece di calcolo post-parsing) e aggiunto monitoraggio via async-hooks per lag >1s. Caso rilevante perché mostra che la risposta a un blocco dell'event loop non è sempre "aggiungi un processo" — a volte è "limita l'input".

### Da separato a mono (semplificazione, tornati a uno)

- **Segment — "Goodbye Microservices"** (post ufficiale, oggi ospitato su Twilio dopo l'acquisizione, fetch diretto [twilio.com/en-us/blog/developers/best-practices/goodbye-microservices](https://www.twilio.com/en-us/blog/developers/best-practices/goodbye-microservices/), 2026-08-04): 140+ repo/servizi (uno per "destination"), il team *"mired in exploding complexity"*; on-call *"losing sleep over it... paged to deal with load spikes"*; solo **32 miglioramenti/anno** alle librerie condivise per il rischio di dover testare/deployare decine di servizi ad ogni cambio. Dopo la fusione in monolite+monorepo: **46 miglioramenti/anno**, suite di test da ore a **millisecondi** (via "Traffic Recorder"), pagine on-call per load-spike *"essenzialmente eliminate"*.
- **Amazon Prime Video — servizio di monitoraggio qualità audio/video** (post tecnico Amazon; dominio originale `primevideotech.com` oggi **redirect morto** verso una pagina generica `aboutamazon.com` — verificato con fetch diretto, quindi contenuto confermato **via mirror + fonti secondarie convergenti**, non fonte primaria diretta accessibile oggi): orchestrazione distribuita via AWS Step Functions ha colpito un limite di scala rigido a circa il **5%** del carico target (dato riportato da più fonti secondarie convergenti, non da fetch diretto della fonte primaria). Quota diretta recuperata via mirror ([vuink.com](https://vuink.com/post/cevzrivqrbgrpu-d-dpbz/video-streaming/scaling-up-the-prime-video-audio-video-monitoring-service-and-reducing-costs-by-90), fetch 2026-08-04): *"moved all components into a single process to keep the data transfer within the process memory, which also simplified the orchestration logic"* → riduzione costi **>90%**, scalato a migliaia di stream. **Nota di scope**: riguarda UN servizio specifico (monitoraggio qualità), non l'intera piattaforma Prime Video.
- **Redis — scelta deliberata mantenuta nel tempo, non un "ritorno"**: single-thread by design. Sintesi convergente da più fonti secondarie (Medium/AWS Builder Center/riferimenti alle dichiarazioni pubbliche di Salvatore "antirez" Sanfilippo, ricerca 2026-08-04, **nessuna fonte primaria unica aperta in questa passata**): per un data-store in-memory a operazioni sub-microsecondo, il costo della lock-contention supera il costo dell'esecuzione sequenziale; niente sincronizzazione applicativa, latenza predicibile; per più throughput la raccomandazione è scalare **orizzontalmente** (istanze/cluster multipli), non introdurre multi-threading nell'istanza. `[PARZIALMENTE VERIFICATO — sintesi secondaria convergente, non una dichiarazione primaria aperta oggi]`. Caso rilevante come contro-esempio: chi non ha ceduto alla tentazione di parallelizzare internamente nonostante fosse tecnicamente possibile.

---

## Claim rigettati o affinati durante la verifica

1. **"Odysseus: `Semaphore(1)` significa che tutto (chat inclusa) è seriale"** — **AFFINATO, non confermato nella forma assoluta**: il semaforo si applica solo ai task schedulati che necessitano di uno "model slot" (path `gate_foreground=True`); la vera priorità chat-vince-su-job è data dal gate di foreground (`interactive_gate.py`, cancellazione attiva dei task), non dal semaforo in sé, che è un dettaglio più stretto di quanto la sintesi precedente (`a2-prior-art.md`, ereditata da un deep-dive oggi non più accessibile) lasciasse intendere.
2. **"Goose: chat, scheduler e sub-recipe girano già tutti sulla stessa pipeline unificata (AgentManager)"** — **REJECTED per lo scheduler**: verificato da codice (`crates/goose/src/scheduler.rs:1015`, HEAD `bb539f7d` del 2026-08-04) che lo scheduler istanzia ancora `Agent::new()` direttamente, bypassando `AgentManager`. La frase "same execution pipeline" trovata in discussion GitHub #4389 descrive l'**intento di design dichiarato**, non necessariamente lo stato del codice sullo scheduler verificato oggi — le due cose vanno tenute distinte.
3. **"Nessuno dei sistemi mandatati ha un meccanismo di priorità esplicito chat-vs-background"** — **REJECTED**: Odysseus ne ha uno molto esplicito e cablato in più punti (middleware ASGI + gate + cancellazione attiva); non era emerso dalla sintesi precedente di `a2` (che si fermava a "esecuzione seriale, Semaphore(1)" senza il meccanismo di priorità/cancellazione).
4. **"Amazon Prime Video / Segment sono la stessa categoria di evidenza di Hermes tini→s6-overlay"** — **da NON confondere**: Prime Video e Segment sono casi extra-agente di semplificazione (separato→mono) per ragioni di costo/complessità operativa; Hermes è un caso interno allo spazio agenti di aggiunta di granularità (mono→multi) per ragioni di sicurezza/isolamento — le due direzioni non si annullano a vicenda, sono evidenza per domande diverse ("quando conviene fondere" vs "quando conviene separare"), coerente con la lettura già fatta in `2026-07-09-process-architecture-sota.md` §2 (la separazione è sempre motivata da un asse specifico, mai "per principio").
5. **"Redis è un caso di 'sono tornati a uno'"** — **REJECTED come framing**: Redis non è mai stato multi-processo/multi-thread e non ci è "tornato" — è una scelta mantenuta fin dall'origine nonostante la pressione tecnica a introdurre multi-threading (Redis 6+ ha aggiunto I/O threading solo per la fase di rete, non per l'esecuzione dei comandi). Va citato come "chi non ha ceduto", non come "chi è tornato indietro".

---

## Tabella riassuntiva

| Sistema | N. processi (istanza tipica self-host) | Concorrenza chat-vs-job | Recovery | Dove vive lo stato |
|---|---|---|---|---|
| **Hermes** | Gateway core (1, supervisionato da s6-overlay insieme a dashboard/per-profile-gateway) **+ 1 processo OS separato per ogni task kanban dispatchato** (`hermes -p <profile> chat`) | Parallelismo multi-processo puro: kanban vive fuori dallo stato dell'agente, letture/scritture "even mid-turn"; nessuna priorità esplicita foreground-vince trovata | Claim TTL 15min + stale-timeout 4h; crash = PID morto ma TTL vivo → reclaim "benigno" (no penalità); **restart da zero** (rilegge `kanban_show()`), non checkpoint di progresso; bug reale noto (#25517): tool-call >15min → doppio worker sullo stesso task | SQLite `~/.hermes/kanban.db`, WAL mode |
| **OpenClaw** | 1 (caso semplice single-box); Gateway+Node separati solo a piena scala multi-macchina | Serializzazione per-sessione (1 run attivo/sessione) + lane parallele per tipo (`cron`/`nested`/`subagent`) — cooperativo su un solo event loop, "pure TypeScript + promises", nessun worker/processo interno | `[NON VERIFICATO]` — nessun meccanismo di resume/checkpoint dedicato trovato nella doc pubblica | Non specificato nelle fonti fetchate in questa passata |
| **Goose** | 1 (`goosed`, Rust/tokio) | `AgentManager` in-processo (LRU cache, 100 sessioni default) per la chat; scheduler istanzia `Agent::new()` grezzo direttamente (bypassa AgentManager) — nessun semaforo/lock di priorità trovato tra i due path | `[NON VERIFICATO]` — sessioni in LRU cache **in-memoria**; crash del processo perde stato non ancora persistito | In-memory (LRU cache) + persistenza su disco non verificata in dettaglio |
| **Odysseus** | 1 (FastAPI, "single-process by convention" dichiarato nel codice) | `Semaphore(1)` solo per task che usano il modello locale + **gate di foreground che cancella attivamente i task in background** non appena arriva traffico interattivo reale ("foreground interaction wins immediately") | Nessun recovery a runtime; solo a **startup**: righe "running"/"queued" residue marcate "aborted" (non "error"); nessun checkpoint infra-task | SQLite (SQLAlchemy, tabella `TaskRun`) |
| **Letta** | 3+ in produzione (Postgres+server+nginx) o 3-4 processi figli nascosti in un singolo `docker run` (redis/postgres/otel spawnati da `startup.sh`); `letta-code` = processo Node separato | Invii concorrenti accettati ma processati **sequenzialmente per agente**; interleaving "unexpected" se non si attende; parallelismo vero raccomandato via agenti/conversazioni separate | Background Mode dichiara resume client-side via `run_id`/`seq_id` anche su crash; persistenza server-side non documentata in dettaglio pubblicamente | Postgres (messaggi, memory blocks, archivio) |
| **OpenHarness/ohmo** | 1 processo daemon gateway (`OhmoGatewayService`), bridge di canale come task asincroni nello stesso processo; TUI locale = processo Node separato dal backend Python | `[NON VERIFICATO]` — nessun gate di priorità dedicato trovato nel codice ispezionato | `[NON VERIFICATO]` — solo self-restart volontario via `os.execv()` documentato | Non specificato nelle fonti ispezionate in questa passata |

---

## Sintesi per l'orchestratore (incollabile in pitch/ADR)

Nessuno dei 6 sistemi mandatati è un vero "tutto-in-un-processo senza eccezioni": Hermes spawna un processo OS separato per ogni task kanban dispatchato (coordinamento via SQLite-WAL, non IPC diretto), Letta nasconde 3-4 processi figli anche nel suo deploy "a un comando", OpenClaw/Goose/Odysseus/OpenHarness sono sì un solo processo OS al livello gateway/daemon ma con concorrenza interna gestita da runtime async (Node/Rust-tokio/Python-asyncio), non da un singolo thread ingenuo. **Il dato più utile e più nuovo per il gap "concorrenza chat-vs-job"**: Odysseus ha un meccanismo di priorità esplicito e cablato (middleware ASGI che rileva attività interattiva e **cancella attivamente** i task in background, non solo li accoda), mentre OpenClaw usa lane parallele per tipo di job senza priorità, e Hermes lascia che processi OS separati coordinino solo via schema-DB senza alcuna priorità dichiarata — tre risposte diverse allo stesso problema, nessuna delle tre richiede necessariamente un secondo processo OS per Muffin. Su Node.js specifico: `better-sqlite3` dichiara supporto nativo a worker_threads ma storicamente non banale da cablare (issue reale su caricamento modulo nativo), la doc ufficiale Node.js raccomanda worker_threads per CPU-bound e child_process per isolamento-crash vero (proprietà che i worker_threads non garantiscono con la stessa forza — un'eccezione termina "quel worker", non necessariamente l'intero processo, ma non c'è la stessa separazione di V8-heap di un processo OS), con un costo fisso quantificato di **circa 32MB per istanza di `child_process`** (due fonti indipendenti convergono sull'ordine di grandezza) contro startup **~4x più lento** di un worker_thread. Sul "chi ci si è scottato": Hermes stesso è passato da mono a più-processi-supervisionati per sicurezza/isolamento (non ha mai fatto il percorso opposto); Segment e Amazon Prime Video sono casi extra-agente di ritorno a un processo/repo unico per ridurre complessità operativa e costo, non per limiti tecnici di concorrenza; Redis non è mai stato multi-processo e non "è tornato" a uno — lo è sempre stato per scelta esplicita. Nessuno dei 6 sistemi fornisce un precedente diretto 1:1 per il vincolo specifico di Muffin (`better-sqlite3` sincrono condiviso + necessità di isolamento crash) — tutti quelli con un DB relazionale in produzione (Letta, e implicitamente i pattern Postgres-centrici) hanno scartato SQLite-sincrono-condiviso, coerente con quanto già concluso in `2026-07-09-process-architecture-sota.md` §5.

