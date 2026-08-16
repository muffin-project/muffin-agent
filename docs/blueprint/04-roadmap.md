# 04 — Roadmap di implementazione

> Moduli in sequenza, ciascuno con: cosa include, cosa NON include, dipendenze, prerequisiti, **scenario reale eseguibile** come definition of done ("Niente finto": se lo scenario non gira su dati veri, il modulo non è fatto), e la tabella di configurazione (chi imposta · quando · se manca). Il nome del progetto è **Muffin** (V12); il repo si assume `muffin` [collisioni namespace da verificare pre-annuncio].

---

## 0. Verdetti sugli standard (gate della roadmap; dettagli e fonti in 00 §4, ADR-0010/0011)

| Standard | Verdetto | Nota operativa |
|---|---|---|
| MCP core | **ADOTTA, revision `2026-07-28`** | Client MCP in M3 via SDK TS v2 (compat legacy = default SDK). MuffinOS *server* MCP: post-v1. |
| MCP Apps (SEP-1865) | **ADOTTA, post-v1** | È la strada per la UI generativa (11 host reali); in v1 entra solo il *renderer capability-aware* che la predispone. |
| MCP Tasks | **RINVIA** | SEP Final ma repo "experimental", 0 client tracciati. Il lavoro asincrono interno usa il nostro scheduler/job model; Tasks eventualmente solo al confine, quando maturo. |
| Agent Skills / SKILL.md | **ADOTTA** (M3) | Formato skill = SKILL.md, nessun formato proprio. |
| AGENTS.md | **ADOTTA** (M0, nel repo) | Il repo di Muffin la usa per gli agenti che ci lavorano sopra (incluso Muffin stesso). |
| OTel GenAI semconv | **ADOTTA PINNATA** (M0) | Tutto è Development: si pinna la versione e si isola dietro il modulo tracing (un solo punto di rincorsa). |

---

## 1. Struttura del repository (per feature, non per layer — direttiva owner, ADR-0002)

```
muffin/
├── AGENTS.md                    # contesto per gli agenti che lavorano sul repo
├── core/                        # M0 — kernel (durevole)
│   ├── policy/                  #   kernel di policy + capability registry (03)
│   ├── rot/                     #   definizioni RoT + installer/verifier (il RoT VIVO sta in ~/.muffin/rot/)
│   ├── tracing/                 #   OTel pinnato, exporter locale, redaction
│   ├── budget/                  #   caps spesa/proattività per tenant
│   └── config/                  #   loader XDG, secrets (keychain/age), defaults
├── agent/                       # M1 — il loop (durevole) + impalcature per-modello (etichettate)
│   ├── loop/                    #   harness-style, un motore per tutte le superfici
│   ├── context/                 #   assemblaggio cache-stable a strati (V8)
│   ├── providers/               #   openai-compat + anthropic (due adapter, una interfaccia)
│   └── profiles/                #   profili per-modello: tool esposti, orizzonte, recovery (07)
├── memory/                      # M2 — episodi, TKG, vault, recall, consolidamento (02)
│   ├── schema/  ├── extraction/  ├── recall/  ├── consolidation/  └── vault/
├── tools/                       # M3 — primitivi host-only: shell, fs, process, http, mcp-client
├── skills/                      # M3 — runtime SKILL.md + libreria (agent-writable dietro gate)
├── dev/                         # M3 — Muffin-costruisce-Muffin: repo ops, orchestrazione harness esterni
├── gateway/                     # M1/M4 — runtime, registry connector, routing (tenant,connector,thread), renderer
├── connectors/
│   ├── cli/                     # M1 — connector principale (REPL + headless)
│   └── telegram/                # M4 — primo connector remoto (transport tipato)
├── scheduler/                   # M5 — cron semantico, event-bus a soglia, gate di proattività
├── introspection/               # M6 — analisi trace (due direzioni) + cricchetto (ratchet API)
├── groups/                      # M7 — tenancy runtime (v1: isolamento; community: post-v1)
└── evals/                       # trasversale — CI di capability, suite memoria, fixtures NON personali
```

Regole: ogni cartella contiene i *propri* tipi, schema, prompt, test e un README; niente `/types`, `/constants`, `/utils` globali (un eventuale `shared/` minimo va giustificato file per file). I dati dell'utente vivono SOLO in `~/.muffin/` (`config/`, `rot/`, `db/muffin.db`, `vault/`, `traces/`): un `git pull` del repo non può toccare l'identità o la memoria di nessuno (ADR-0011).

**Prerequisiti globali** (dichiarati una volta): Node ≥22, git; una fonte di modelli (API key di un provider OpenAI-compat o Anthropic, e/o un server locale Ollama/llama.cpp); per M4 un bot token Telegram; opzionali: Ollama per embedding locale (raccomandato), Chromium headless per il renderer a immagini; su Linux: `bubblewrap`+`socat` per il sandbox di esecuzione (senza: le capability exec degradano ad ASK, mai silenziosamente unsandboxed — 03 §3-bis).

---

## 2. Moduli

### M0 — Kernel & tracce *(durevole)*
- **Include**: config loader XDG + secrets; installer/verifier del RoT (hash al boot, file read-only per il processo agente); kernel di policy con capability registry e matrice default (03 §3); budget engine; tracing OTel pinnato con exporter locale e redaction; `muffin init` (bootstrap non conversazionale: directory, chiavi, scelta modello) e `muffin doctor`.
- **NON include**: loop, memoria, connector remoti, qualunque LLM call.
- **Dipendenze**: nessuna. È il pezzo che tutto il resto assume.
- **DoD (scenario eseguibile)**: su una macchina pulita (macOS e Linux): `muffin init` crea `~/.muffin` con RoT installato e verificato; una tool call di prova contro la policy viene **negata** e lo span nei trace mostra principal/capability/motivo; `muffin doctor` riporta stato di config, chiavi, DB; dopo riavvio tutto persiste; manomettere a mano un file del RoT → il boot lo rileva e si rifiuta di partire spiegando perché.
- **Config** (chi · quando · se manca): endpoint+chiave modello — owner · a init · **senza: il runtime parte ma il loop rifiuta di avviarsi con messaggio chiaro** (mai errore a metà operazione); data dir — repo default XDG · init · fallback default; budget caps — repo default · modificabili poi in chat (ratchet) · default prudenti; quiet hours — repo default · in chat · default 23-8.

### M1 — Loop + CLI *(durevole; profili per-modello = impalcatura etichettata)*
- **Include**: loop harness-style unico; pre-loop deterministico (snapshot permessi, assemblaggio context cache-stable); adapter `openai-compat` + `anthropic` dietro un'unica interfaccia `ChatCall`; **profili per-modello** (tool esposti, orizzonte, recovery cascade — il contratto multi-tier V2); connector CLI (REPL + `muffin run "<goal>"` headless); renderer base testo.
- **NON include**: memoria persistente (solo transcript di sessione), connector remoti, scheduler.
- **Dipendenze**: M0. **Prerequisiti**: una fonte modelli configurata.
- **DoD**: `muffin` apre il REPL; "leggi questo file e dimmi le tre cose rotte" → il loop chiama i tool fs (policy ALLOW per owner), risponde nel merito; `muffin run` headless esce con exit code corretto; ogni step è uno span; **la CI di capability esegue lo stesso set di scenari sul modello API di riferimento E sul modello consumer-locale di riferimento, e il floor passa su entrambi** (V2 — è il gate anti-"harness su Sonnet").
- **Config**: modello per lane main/light — owner · init/chat · senza light: usa main per tutto (degrada, avvisa); profilo modello — repo fornisce profili noti · selezione automatica dal nome modello · modello ignoto: profilo conservativo di default.

### M2 — Memoria *(durevole)*
- **Include**: tutto `02-ontologia.md` — episodi, TKG bi-temporale con provenienza/taint, pipeline di estrazione asincrona con giudice di contraddizione misurato, vault indicizzato, recall ibrido con espansione grafo e reranking, consolidamento come vista derivata, migrazione via re-ingestione + cold start.
- **NON include**: community; introspezione (M6); estrazione multimodale avanzata (v1: testo + descrizioni media basiche).
- **Dipendenze**: M1. **Prerequisiti**: embedding locale (Ollama) o API.
- **DoD**: "Marco è il mio commercialista, lo vedo giovedì" in CLI → riavvio del processo → "chi è il mio commercialista?" risponde giusto **con fonte**; "ho cambiato commercialista: ora è Lucia" → supersede bi-temporale; "chi era il mio commercialista a maggio?" risponde col fatto expired; `muffin memory why <fact>` mostra l'episodio di provenienza; la suite memoria di 05 passa il baseline; la migrazione re-ingesta un export del vecchio `muffin.db` e l'eval comparativa gira.
- **Config**: modello embedding — repo default (qwen3-embedding via Ollama) · init · senza: recall solo FTS (degrada, avvisa); soglie consolidamento — repo default · ratchet · default.

### M3 — Primitivi, skills, dev *(primitivi durevoli; system layer v1 = SOLO questo)*
- **Include**: **executor sandboxato di default** (Seatbelt/bubblewrap, doppio layer fs+rete allow-only, mandatory deny paths, escape solo via ASK — 03 §3-bis, ADR-0018); tool primitivi host-only con dichiarazioni di capability (shell, fs, process, http); client MCP (2026-07-28) con allowlist server; runtime SKILL.md (progressive disclosure) + libreria skill agent-writable dietro gate di qualità; capability `dev` (clone dedicato, test, branch+PR; orchestrazione di harness coding esterno via API per lavori grossi).
- **NON include**: app control/UI automation/computer-use (post-v1, gated — V12); server MCP di Muffin; skill marketplace; ispezione TLS dell'egress di esecuzione (dichiarata post-v1).
- **Dipendenze**: M1 (M2 raccomandato). **Prerequisiti**: git; per `dev` su repo remoti: credenziali forge.
- **DoD** (aggiornata 2026-08-09 dopo il taglio della capability `dev`, ADR-0027 — la riga "clona il repo, lancia i test" è rimossa: Muffin non è un coding agent): un comando eseguito da CLI gira **dentro il sandbox**; un comando che tenta di scrivere fuori dal write-scope o di raggiungere un dominio non allowlistato **fallisce dentro il sandbox** (v1 strict: nessun retry non-sandboxato, l'escape hatch è una capability always-ask a sé); **la stessa richiesta da una fixture di messaggio-di-gruppo viene negata dal kernel** (test d'isolamento); una skill SKILL.md installata a mano viene scoperta e usata; un server MCP allowlistato funziona, uno driftato viene sospeso. **Chiusa** (muffin-next `ca575b2`): accettazione end-to-end attraverso `buildRuntime` (assembly di produzione, non pezzi a mano — 7/7), overhead sandbox misurato = **~16ms/comando su Seatbelt** (debito A6 §5.6/ADR-0018 saldato). Legge codice e lo esegue; sviluppo vero = orchestrazione di harness esterno, differita (ADR-0015 livello b).
- ⚠️ **Emendamento (2026-08-15, slice/sandbox-linux) — la DoD era chiusa su una piattaforma sola.** «Un comando eseguito da CLI gira **dentro il sandbox**» era provato da nove test di contenimento reale che giravano **solo su macOS**: il gate era `platform() === 'darwin'`, e su Linux — la piattaforma della VPS di produzione — nessuno di quei nove era mai stato eseguito, né a mano né in CI (misurato: «10 test, 9 saltati» su ubuntu-latest *con* bubblewrap installato). Costo dell'assenza: la DoD di M3 asseriva in produzione una garanzia verificata altrove, che è la forma esatta dell'incidente di ADR-0018 (nota di campo 2026-08-04). **Chiuso**: suite di contenimento unica per i due meccanismi, `MUFFIN_REQUIRE_SANDBOX=1` che rende rosso un salto dove il contenimento è esigibile, e `core/sandbox/probe.test.ts` (che prima non esisteva affatto, sul modulo che decide se il sandbox c'è).
- ⚠️ **Aperto (2026-08-15) — il write-scope non è un read-scope, e `~/.muffin/` è leggibile dal sandbox.** Misurato: un comando contenuto legge `/etc/hosts`, `$HOME` e qualunque file fuori dallo scope; l'unico read negato è `secrets/` (`agent/runtime.ts`, `denyRead: [p.secrets]`). Quindi `shell_run` può leggere `muffin.db` — l'intera memoria — `vault/`, `traces/` e `rot/` (negati in scrittura, non in lettura) e riversarli in contesto. È coerente con ADR-0018 (§ "fs write-scope") e con 03 §3-bis, che parlano di scope in **scrittura**: non è una regressione, è un limite mai dichiarato in questa forma. Costo dell'assenza: «il sandbox confina il comando al workspace» è vero delle scritture e falso delle letture, e la frase circola intera. Il limite è ora fissato da un test (`executor.test.ts`, "the write scope is a write scope"), così che stringerlo sia una decisione e non una sorpresa. **Decisione all'owner** (sicurezza — ORCHESTRATION §2): lasciarlo dichiarato, o aggiungere `~/.muffin/` ai deny-read mandatori sapendo che spegne i comandi che leggono la propria memoria.
- **Config**: allowlist MCP — owner · primo uso di un server (chiede) · senza: nessun MCP; credenziali forge — owner · primo uso `dev` remoto · senza: `dev` solo locale.

### M4 — Connector Telegram *(durevole nel pattern, sostituibile nell'istanza)*
- **Include**: transport tipato (pattern P0-P7) con confine identità/contenuto di ADR-0046: owner da subject-id stabile autenticato e protetto, mai da metadata; ogni campo model-visible parsato in blocchi con provenienza/taint; mapping sessioni `(tenant, connector, thread)`; **renderer capability-aware** (direttiva owner: il connector dichiara `text|image|file|card|…` e si sceglie il mezzo più ricco, non il più verboso — su Telegram: formattazione nativa, foto/documenti, card-immagine via Chromium headless se presente); ingestion di media/documenti nel vault.
- **NON include**: gruppi multi-tenant completi (M7), Discord/altri (post-v1), MCP Apps (post-v1).
- **Dipendenze**: M1-M2 (M3 per azioni). **Prerequisiti**: bot token.
- **DoD**: scrivo al bot dal telefono: stessa memoria della CLI (stessa istanza host); un account con nome/bio/foto dell'owner resta `member`, mentre l'account pairato conserva `owner` anche se cambia display name; ogni campo accettato arriva al loop come blocco tipizzato col tier e un formato non supportato fallisce visibilmente; gli mando un PDF → nel vault, indicizzato, interrogabile; la risposta a una richiesta di sintesi arriva come card leggibile (o testo asciutto se Chromium assente — degradazione dichiarata); dopo riavvio la conversazione riprende dal punto giusto.
- **Config**: bot token — owner · attivazione connector · senza: connector spento (il resto vive); resa rich-media — auto (rileva Chromium) · runtime · senza: testo.

### M5 — Scheduler & proattività *(cron durevole; soglia di proattività = impalcatura etichettata)*
- **Include**: cron semantico (NL→spec deterministica confermata in chat, poi esecuzione senza LLM); event-bus a soglia (pattern Odysseus) che sostituisce i demoni; heartbeat budgetato; **gate di proattività**: trigger armabili solo da evidenza tier ≤1, quiet-hours e budget nel RoT, canale di consegna esplicito.
- **NON include**: outward autonomo (mail a terzi ecc. — draft-only resta la regola), "iniziativa" senza trigger dichiarato.
- **Dipendenze**: M1-M2. 
- **DoD**: "ogni mattina alle 8 fammi il brief della giornata" da chat → job visibile in `muffin jobs`, arriva alle 8 sul canale scelto, sopravvive al riavvio; un trigger a soglia (N episodi non consolidati) fa partire il consolidamento da solo; un tentativo di armare un trigger da contenuto di gruppo viene rifiutato e loggato (test); il costo giornaliero dello scheduler è visibile e sotto il cap.
  - ⚠️ **Nota (2026-08-13, ADR-0038)**: la clausola sul consolidamento è ora
    soddisfatta, ma **non nella forma scritta qui**. Il grilletto primario è una
    coda d'inattività, non una soglia a conteggio: la soglia è la *rete*, ed è
    l'opzione che l'evidenza esterna sostiene di meno da sola
    (`research/consolidamento-due-meccanismi.md` §Il grilletto). La riga resta
    com'era scritta perché non si riscrive la storia; il rimedio vero è in
    §M5-bis riga 1, dove è anche detto quale metà è ancora aperta.
- **Config**: quiet hours/budget proattività — RoT default · owner via chat (ratchet: modifica con notify+undo) · default prudenti; canale di consegna default — owner · primo job · chiede.

### M5-bis — Il divario fra "M0-M5 costruito" e "usabile" *(aperto 2026-08-11, dall'uso mancato)*

Non è un modulo nuovo: è la lista delle cose che rendono **inservibile** un
substrato costruito, trovate rispondendo all'owner che chiedeva perché non se la
sente di usarlo. Ognuna verificata sul codice, non stimata.

**0. Niente vive senza il terminale — ed è la radice delle altre.** → **ADR-0035**
(la decisione, i cinque vincoli di sicurezza, e le alternative scartate).
 Lo scheduler
gira solo finché il REPL è aperto: chiudi la finestra e non succede più niente.
Si vede dal **vocabolario**, non dalla dichiarazione: dei 95 comandi di Hermes,
31 sono di sessione — `heartbeat`, `background`, `queue`, `steer` (inietta dopo
la prossima tool call senza interrompere), `pause`, `stop`, `restart` (drena e
riavvia), `undo`, `rollback`, `snapshot`, `handoff`, `compress`. Sono verbi che
**presuppongono qualcosa che sta già girando**. I nostri quattordici sono tutti
"fai questo adesso ed esci". Un sistema è continuo se ha comandi che assumono
che stia girando, e noi non ne abbiamo nessuno — per questo "sei un agente
continuo" **non va scritto nel prompt**: sarebbe una bugia, e licenzierebbe
promesse che il runtime non mantiene (contro `identity.md`, "non fingi di aver
fatto"). Va reso vero, e allora si scrive da sé.
→ Serve **un processo che vive senza il terminale** (la versione piccola del
loro gateway da 307 KB: gira, `doctor` lo vede, si ferma e riparte), più i tre
verbi che ne conseguono — `heartbeat` (prompt ricorrente dichiarato dall'owner
che rientra quando è inattivo), `queue`/`steer` (parlare a un agente occupato
senza interromperlo: oggi non esiste nemmeno il concetto di "è occupato" visibile
all'owner), `undo` (il registro che il kernel già emette come `DRAFT` e che il
loop rifiuta perché non esiste). **Non** i 95: `/skin`, `/timestamps`,
`/statusbar`, `/redraw` sono la loro cromatura, ed è il "TROPPE cose" che
l'owner rifiuta.

✅ **Il processo è costruito** (`slice/gateway`, 2026-08-11, 655 test). `muffin
gateway run` possiede lo scheduler — il `setInterval` è uscito da `cli/repl.ts`
— e vive finché non gli si dice di smettere. Verificato eseguendolo: job creato,
gateway avviato senza nessun REPL, **fire a 24 s** con consegna su stdout;
`gateway status` e `doctor` lo vedono da un altro processo; `gateway stop` drena
ed esce. Le parti che valgono più del comando:
- **Due scheduler non girano mai.** Rivendicazione durevole in `gateway_lock`;
  il REPL la *legge* e cede il ticker, dicendolo. Il meccanismo è quello del
  `SendLock`, generalizzato in `core/lock/durable.ts` invece che copiato — con
  una differenza che contava: l'orizzonte di scadenza è un **battito**, non
  un'ora, perché un gateway tiene il lock per settimane e il silenzio non prova
  niente su di lui. Un `kill -9` non incastra il comando: dopo dieci battiti
  persi la rivendicazione è scaduta.
- **Supervisione, non solo riavvio.** `READY=1` quando serve davvero,
  `WATCHDOG=1` alla cadenza che dichiara `WATCHDOG_USEC`, `STATUS=` leggibile.
  No-op senza `NOTIFY_SOCKET`, che è il caso di macOS.
- **Un gateway ucciso non perde lavoro**: `markRan` è l'unica cosa che sposta il
  prossimo fire, quindi un turno interrotto lascia il job **dovuto**. Asserito
  contro lo store vero, non assunto.
- `gateway install` genera unit systemd / plist launchd **ancorate a
  `~/.muffin`**, mai al checkout (la cicatrice di Hermes), e `muffin init` ora
  **lo propone** invece di lasciare un comando manuale — direttiva owner: *"non
  lancerò mai quei comandi a mano."*

⚠️ **Correzione (2026-08-13, dal giro di review su `slice/gateway`)**: cinque
frasi qui sopra erano vere del meccanismo e false della garanzia. Corrette nel
codice e scritte qui perché la riga sbagliata era quella che sembrava più solida.

- **"Due scheduler non girano mai" era un assoluto, e non lo è.** Il REPL
  leggeva la rivendicazione **una volta sola, all'avvio**: nell'ordine
  REPL-prima-gateway-poi (una finestra aperta, poi `gateway install`, oppure
  systemd che arriva alla unit un attimo dopo la shell) i due ticker
  convivevano, e nessuno se ne sarebbe accorto. Stesso difetto al risveglio dal
  sonno del laptop, dove la rivendicazione di un gateway *vivo* si legge scaduta
  a un REPL aperto in quell'istante. Ora la domanda si rifà **a ogni tick**
  (`standDown`), in tutte e due le direzioni: il REPL cede e lo dice, e se il
  gateway muore riprende e lo dice. **La finestra residua, detta onesta**: il
  controllo si ripete anche subito prima della consegna, quindi per una *consegna
  doppia* la finestra è sotto il millisecondo; per un'*esecuzione doppia* è
  lunga quanto un turno, perché due processi possono aver girato lo stesso goal
  prima che il secondo controllo scatti. Sono soldi, non correttezza, e chiuderla
  richiederebbe di rivendicare il fire *prima* di eseguirlo — cosa che ADR-0035
  rifiuta, perché `markRan` unico scrittore di `next_fire_at` è ciò che fa sì che
  un gateway ucciso non perda lavoro.
- **`STATUS=` leggibile non era cablato.** Era scritto, testato due volte e
  chiamato da niente: lo stato vivo finiva solo nella riga SQLite, e
  `systemctl status` mostrava la riga dell'avvio per tutta la vita del processo.
  Ora viaggia sul ping del watchdog (`WATCHDOG=1\nSTATUS=…`, un datagram, zero
  spawn in più).
- **`gateway stop` non fermava niente.** Il drenaggio usciva 0 e
  `Restart=always` lo riportava su dopo 5 s — sulla VPS Linux che è la
  produzione. Su launchd il difetto era speculare: `SuccessfulExit: false`
  riavviava solo su uscita ≠ 0, quindi il riavvio drenante da SIGUSR1 usciva 0 e
  l'agente **restava giù**. Ora SIGUSR1 esce 0 e SIGTERM esce 143, che la unit
  nomina in `RestartPreventExitStatus`; launchd va a `KeepAlive` incondizionato.
  La proprietà tenuta ferma in tutte e due: **un crash riavvia sempre.**
- **Il watchdog taceva proprio durante il drenaggio.** `drain` azzerava tutti i
  timer, incluso il ping, e poi aspettava fino a 60 s contro un `WatchdogSec` di
  60. Si presumeva che `STOPPING=1` sospendesse il watchdog: presunzione non
  verificabile qui (non c'è systemd su questa macchina) e non documentata in
  `sd_notify(3)`. Tolta la dipendenza invece che documentata: il ping vive
  quanto il drenaggio.
- **`Type=notify` senza `systemd-notify` sulla macchina non degrada: non
  parte.** `READY=1` non arriva mai, systemd uccide a `TimeoutStartSec` (90 s) e
  `Restart=always` ci riprova per sempre senza mai toccare il rate limit (cinque
  avvii in dieci secondi è impossibile se ognuno dura un minuto e mezzo).
  `gateway install` su linux ora controlla il PATH e in assenza emette
  `Type=exec` più l'avviso che il watchdog è spento.

⛔ **Resta aperto, e sono le cose che il processo ora rende scrivibili**:
`queue`/`steer` e il concetto di "occupato" (serve il protocollo client/server
sul socket unix, non costruito); `heartbeat`; `undo`; ~~il trigger sul
consolidamento~~ (chiuso il 2026-08-13, ADR-0038 — e la risposta a "il gateway è
il posto dove va" si è rivelata **no, non solo**: il grilletto vive nel runtime,
quindi ce l'ha ogni processo che esegue turni, perché darlo al solo gateway
lascerebbe a zero fatti chi non ha installato la unit); la consegna remota su una
surface (un job per canale remoto emerge ancora nel log invece di arrivare). E un
limite dichiarato:
il `ForegroundGate` del gateway è `ALWAYS_IDLE`, perché senza terminale non c'è
un foreground — quando un turno di surface saprà dire "l'owner sta parlando", è
lì che si innesta.

**1. Il consolidamento non parte mai — e la DoD di M5 lo richiedeva.** `ingestPending`
(episodi → fatti) ha **un solo chiamante: `muffin memory extract`, a mano**. Nessun
job, nessun trigger a soglia. Quindi la memoria **non si riempie da sola**: anche
usandolo ogni giorno, i fatti restano zero. Il numero che lo dice, dall'inventario:
**414 fatti nel vecchio contro 0 nel nuovo** (4.107 episodi in 4 mesi, 320 entità,
228 consegne proattive — contro 6 episodi, 0 fatti, 0 entità). La riga *"un trigger
a soglia (N episodi non consolidati) fa partire il consolidamento da solo"* è nella
DoD di M5 sopra, ed è **non soddisfatta**: M5 è stato dato per chiuso senza.

⚠️ **Correzione (2026-08-11, dall'inventario)**: la prima stesura di questa riga
diceva che la regressione era "il vecchio aveva il ciclo dream". **Falso, e la
parte falsa cambia il rimedio.** Il vecchio non riempiva la memoria di notte: la
riempiva **a ogni turno, in asincrono** — `gateway.ts:2732` accoda →
`thinker.ts:581` preleva → `reactor.ts:904` → `memory_learning.ts:625` →
`saveFact`, con latenza di minuti. Il dream faceva **manutenzione sopra** (la
work_queue è 2.438 righe contro un centinaio di report dream). Costruire solo un
job notturno produrrebbe un Muffin che ti conosce con 24 ore di ritardo: servono
**due meccanismi**, l'estrazione per-turno asincrona e la manutenzione periodica.
→ **priorità 1**: senza questo, tutto il lavoro su memoria, importance, origin e
assenza è inerte.

✅ **Primo meccanismo costruito — l'estrazione per-turno asincrona**
(`slice/gateway`, 2026-08-13, **ADR-0038**, 751 test). Il grilletto è una **coda
d'inattività a fronte discendente** armata dalla fine di ogni turno
(`LoopDeps.onTurnEnd`, che non esisteva), con un **tetto a conteggio** come rete.
Le due costanti sono misurate sul corpus vero dell'owner (4.107 episodi,
2026-03-16 → 2026-07-18), non prese da un peer — i valori del campo (15-60 min)
rispondono a *"la sessione è finita"*, che non è la nostra domanda:
- **20 s di coda**: l'1,0% dei messaggi consecutivi dell'owner dista meno di 20 s
  (quindi un turno su cento paga una chiamata in più); ancorata alla risposta, la
  coda fa scattare **1.326 batch per 1.793 turni = −26% di chiamate** contro il
  per-turno del vecchio, che rendeva il 3,4%. A 30 s si risparmierebbe un altro
  3,3% pagando il 50% di latenza; a 60 s si supera la **mediana di 56 s** fra
  risposta e messaggio successivo, cioè si perde la proprietà che gli 11,8 s del
  vecchio compravano — il fatto a posto *prima del messaggio dopo*.
- **tetto 12 turni**: alla coda di 20 s la sequenza più lunga senza pausa nel
  corpus è **7** (p90 2, p99 4). Dodici è una rete che su quattro mesi di traffico
  vero non sarebbe mai scattata.

Nella stessa slice, e non come contorno: la **spesa della corsia light entra nel
budget** (era zero per `/spend`, per il cap mensile e per il ramo
`budget_exhausted` del kernel — inaccettabile per una corsia che ora gira da
sola), il che **chiude anche il punto 7 qui sotto**; la **cucitura per-tenant è
rifiutata esplicitamente e con due test** (solo il tenant host consolida, perché
`extractFacts` deriva `speakerName` da `role`); `{kind:'system',
source:'consolidation'}` ha finalmente un produttore e `ProactiveKind =
'consolidation'` è **cancellato** (il consolidamento non parla, quindi non
appartiene all'insieme chiuso di ciò che fa parlare per primo); e la corsia si
**vede** — `consolidation_runs` letta da `muffin memory stats` e `muffin doctor`,
più una riga al boot, perché zero fatti è anche l'output corretto di una corsia
sana e il numero che distingue è quello dei run.

**Provato eseguendolo**, due volte e su una home vera: dal REPL, turno →
risposta consegnata subito → estrazione a **+20,010 s** → `owner lives_in
Cagliari` in `facts` (batch 321 ms); dal **gateway senza nessun REPL aperto**, un
job spara → estrazione a **+20,003 s**. E l'indice vettoriale è passato da vuoto a
`5 chunk · 5 vettori, in sync` — la seconda metà del difetto, quella che la
ricerca aveva trovato e questa riga non diceva.

✅ **Secondo meccanismo costruito — la manutenzione** (`slice/gateway`,
2026-08-14, **ADR-0040**, 870 test). Tre pezzi, e la prima cosa che ha prodotto è
una correzione al nome: **«periodica» era sbagliato.** Elencando cosa dovesse
fare, ogni voce si è rivelata guidata dai **dati** e non dall'orologio — un
arretrato esiste o no, un duplicato esiste o no, una riga `review` è aperta o è
stata risolta; niente in questo schema cambia perché è passato un giorno. Quindi
niente cron (e nessuno dei dodici sistemi letti ne gira uno): il grilletto resta
la stessa coda d'inattività, nel runtime.

La regola di costo che governa tutto: nel vecchio il dream era la **metà piccola**
— ⬤ 100 report contro 2.438 righe di work queue, il 4%. Quindi **la manutenzione
non spende niente**: nessuna chiamata al modello, è SQL su righe già scritte.
L'unica parte che chiama un modello è il drenaggio, e paga estrazioni che la
corsia viva avrebbe pagato comunque — il totale non cambia, cambia quando.

- **Drenaggio dell'arretrato.** Dopo una pagina **piena** che ha **fatto
  progresso**, la corsia si ri-arma e prende la successiva, allo stesso passo
  della coda viva (nessuna costante nuova: il tetto di costo diventa così una
  proprietà della forma). Perde sempre contro un turno. La condizione d'arresto è
  il *progresso* (`marked > 0`), mai un conteggio di pendenti: un episodio che
  fallisce l'estrazione in modo permanente resta in testa per sempre, e un
  drenaggio guidato da `stats.pending` ripagherebbe quella pagina ogni venti
  secondi — lo stesso fallimento che ADR-0038 aveva già scartato, da un'altra
  porta. **Non** si riordina al più-nuovo-per-primo: `reconcile` sceglie il
  candidato per `recorded_at`, quindi estrarre fuori ordine farebbe
  **dis-correggere una correzione**.
- **Deduplica senza soglia.** Solo chiave esatta normalizzata (maiuscole, spazi,
  punteggiatura finale) — lo 0,85 del vecchio non porta fra embedder e la ricerca
  lo misura (99,00% di falsi positivi a 0,7 su due modelli comuni). ⬤ E il corpus
  chiede esattamente questo gradino: sui quattro mesi del vecchio i gruppi
  (soggetto, predicato) con più di un valore attivo erano **2 su 308 fatti**, e
  **tutti e due erano duplicati esatti**. Si ritira con `supersede`, mai DELETE —
  e con `valid_to` **non toccato**, perché un duplicato non ha mai smesso di
  essere vero: non era una verità separata.
- **Il registro `review` si legge e si risponde.** `muffin memory review` +
  `review keep <fact-id>`, più la riga in `memory stats`, in `doctor` e al boot.
  «Aperta» è una **join** (entrambi i fatti ancora attivi), non una colonna di
  stato — così una domanda che la conversazione risolve da sola esce dalla lista
  senza che nessuno scriva niente. Rispondere è un `supersede`, ed è **l'owner**
  a farlo: ADR-0032 §9 resta dov'era.

⛔ **Resta aperto, e va detto**: **dream/compattazione** (non costruito, e la
ragione è che manca il *consumatore* — `profiles` e `digests` hanno zero lettori:
prima il lettore, poi lo scrittore); **l'audit dei predicati** a metà (l'invariante
`predicate_vocabulary` rileva, ma proporre un merge vuole un giudizio di
sinonimia, cioè una chiamata al modello — contro la regola di costo — o un
vocabolario chiuso, contro ADR-0032). **Il decadimento della confidenza è
rifiutato**, non rimandato: non c'è un tasso difendibile, ⬤ l'unica soglia sulla
confidenza in tutto il repo è `extract.ts:176` *prima* della scrittura (quindi
sarebbe una mutazione senza lettore), e il giorno che un lettore ci fosse una
credenza scivolata sotto soglia diventerebbe irrecuperabile **senza `expired_at`
né `superseded_by`**: una cancellazione senza traccia. Una **passata di scadenza**
non è costruita perché ⬤ non ha niente da scadere: `valid_to` è scritto solo da
`supersede`, che scrive anche `expired_at`, quindi «vero-finito ma ancora
creduto» non è rappresentabile oggi. Più il limite dichiarato che resta: **`muffin
run` headless non consolida** (timer `unref`'d) — ma ora costa meno, perché il
primo processo di lunga vita **drena tutto** invece di prendere una pagina sola.

**2. ~~`thinking` è dichiarato e mai passato~~ — chiuso (ADR-0037, poi la sua
correzione lo stesso giorno).** Il rimedio scritto qui era sbagliato nella
direzione: la riga sopra diceva "il loop non lo passa", ma passarlo nella
forma che allora esisteva (`{type:'enabled', budget_tokens}`) sarebbe stato un
400 su ogni modello frontier, non un fix — il vero difetto era la *forma*
della richiesta, e sulla stessa riga del loop c'era un secondo hardcode
(`temperature: 0`) anch'esso un 400 sull'installazione di default
(`claude-sonnet-5`). ADR-0037 ha corretto entrambi: `thinking: 'adaptive' |
'off'` sul wire, `sampling` per-profilo. La correzione trovata nello stesso
giro di review ha chiuso il seguito: un terzo valore `thinking: 'unset'` per i
modelli senza uno switch di disabilitazione noto (Claude Fable 5 e Claude
Mythos 5 rifiutano `{type:'disabled'}` sempre — tabella per-modello, letta
2026-08-13); `claude-opus-4-7` e `claude-opus-4-8` aggiunti ai glob di
`frontier.json` (prima cadevano su CONSERVATIVE → `temperature: 0` → 400 ogni
turno); e `muffin doctor` che ora chiama `loadProfiles` lui stesso e nomina
sia il profilo scartato sia — quando la risoluzione ricade su CONSERVATIVE —
cosa costa la ricaduta, cosa che prima raggiungeva solo `bootLines` (stderr al
boot).

**3. Muffin non è governabile da dentro.** Cinque slash nel REPL (`/exit /help
/new /session /spend`), nessun `muffin config`, nessuna dashboard: provider,
modelli, budget, quiet hours si cambiano **editando JSON a mano**, e quelli nel
RoT vogliono pure il reseal. L'owner non sa cosa può regolare perché non c'è un
posto dove chiederlo. → **ADR-0036** (dove passa la linea: sigillato = terminale,
tutto il resto lo guida Muffin).

✅ **La precondizione bloccante di ADR-0036 è chiusa** (`slice/gateway`,
2026-08-13, **ADR-0039**, 781 test). Erano **due difetti con la stessa forma** —
una protezione che nomina un file mentre la cosa protetta vive in un altro — e si
sono chiusi insieme perché la risposta è la stessa: spostare il confine dov'è il
dato.

- **Il sigillo proteggeva una copia.** `BudgetEngine` nasceva da `config.budget`,
  fuori dal manifest, mentre il sigillato `rot/budgets.json` portava gli stessi
  numeri per duplicazione: comportamento corretto, garanzia inesistente.
  Trovato da ADR-0028 il 2026-08-10 e lasciato aperto due volte. Ora
  `core/rot/budgets.ts` è l'unico lettore e **`config.budget` non esiste più**.
  Provato eseguendo, nelle due direzioni che contano: tetto sigillato a 0 → il
  turno si ferma a «Budget esaurito» con **0 passaggi**, cioè prima di qualunque
  chiamata al modello; lo stesso 0 (o un 999999) scritto in `config.json` → non
  cambia niente. **L'insieme sigillato resta di cinque file**: il manifest
  dell'owner non è invalidato e `rot verify` esce 0 prima e dopo.
- **La migrazione era la parte difficile.** `CONFIG_SCHEMA_VERSION` passa a 2, e
  `loadConfig` — che rifiutava qualunque versione non fosse l'attuale — ora ha
  una scala di migrazioni **in memoria**: un loader che riscrive il file che gli
  è stato chiesto di leggere è una corsa fra il gateway e un REPL, e `saveConfig`
  aggiorna comunque il file alla prima modifica. I numeri vecchi **non** vengono
  copiati nel file sigillato (sarebbe il buco stesso): la nota li dice, con il
  comando, nei `bootLines` e come check `config migrata` in `doctor`.
- **L'agente poteva leggere la chiave dell'owner con un tool dichiarato.**
  `denyRead` nominava solo `~/.muffin/secrets`, ma `root` è la cwd e ADR-0030
  *richiede* che sia il repo, dov'è la `.env` con la chiave; `fs.read` è low
  senza `maxTaint`, quindi tetto 3. Con un solo risultato tier-3 in contesto —
  fetch-then-act, `03 §2` — `fs_read(".env")` restituiva la chiave in chiaro.
  Riprodotto: rimessa la `denyRead` di prima, il transcript del modello contiene
  la chiave due volte. Chiuso da entrambi i lati: la chiave si sposta in
  `$XDG_CONFIG_HOME/muffin/secrets/` (`muffin secret set --persist`, dir 0700 /
  file 0600, fuori da `MUFFIN_HOME` **e** dal repo, quindi il loop
  `uninstall && init` continua a ritrovarla) e `denyRead` copre ora entrambi gli
  store più la `.env`.
- **`fs.read` resta a `maxTaint` 3**, esaminato e non stretto per riflesso: lo
  stesso argomento di `web_search` (a tetto 1 si leggerebbe *un* file per turno
  dopo una ricerca) più il fatto che la lettura non è la fuga — la gamba egress è
  gated a parte. La precondizione che lo rende vero è scritta sulla
  dichiarazione: vale *perché* dentro `root` non c'è nessun segreto raggiungibile.
- **Trovato mutando, e vale più della slice**: l'invariante «ogni file sigillato
  ha un lettore vero» accettava un `import` come prova di un uso. Togliere la
  chiamata a `loadSealedBudgets` da `cli/observe.ts` lasciava il check **verde**,
  perché il nome era ancora nella riga di import. Stessa forma della cicatrice che
  quel file già portava (una docstring che valeva come lettore). Ora gli import
  sono strippati come i commenti, i tre consumatori sono elencati come `indirect`,
  e c'è il test permanente. Lezione in `docs/lessons.md`.

⛔ **Resta aperto, dalla stessa slice**: `rot verify` **non distingue** «un file
sigillato è cambiato» (attacco) da «l'insieme sigillato ha cambiato forma» (un
upgrade che porta un file nuovo) — entrambi arrivano come `files_diverged … 
(untracked)`. Oggi non ha grilletto, perché ADR-0039 ha scelto apposta la forma
che *non* tocca l'insieme sigillato; il costo dell'assenza si paga il giorno che
un upgrade aggiunge davvero un file a `defaults/rot/`, e quel giorno l'owner vede
un'installazione che sembra manomessa. Va costruito **prima** di quella slice, non
durante.

✅ **I tre pezzi che ADR-0036 chiedeva, in ordine di priorità dichiarato**
(slice/gateway, in lavorazione — non committato, 830 test contro i 781 di
partenza).

- **`muffin config`, sola lettura** (`core/config/inventory.ts` +
  `cli/config.ts`). Ogni manopola: valore, file di origine, se è sigillata.
  Guardati prima i tre strumenti che l'ADR nomina (`docs/PRACTICES.md` §3) —
  `git config --list --show-origin` (valore + origine, nessun asse
  "sigillato"), `gh config list` (bare key=value, nessuna origine), `aws
  configure list` (Name/Value/Type/Location, verificato solo per
  documentazione: `aws` non è installato su questa macchina) — e scelta la
  forma di `aws`, con "Type" sostituito da "Sigillato", l'unica colonna che
  nessuno dei tre doveva rispondere e per cui questo comando esiste. La lista
  **deriva dallo schema dove è pratico farlo**: cammina l'oggetto `Config`
  restituito da `loadConfig` — che *è* `z.infer<ConfigSchema>` — invece di un
  elenco scritto a mano campo per campo. Provato: `models.deep` scritto a
  mano in un `config.json` compare nella lista senza toccare
  `inventory.ts`. **Scartata l'introspezione diretta dello schema zod**
  (probe fatto contro la 4.4.3 installata): raggiungibile solo via
  `_zod.def`, un interno con underscore senza precedenti nel resto del repo e
  nessuna garanzia fra un patch e l'altro di zod — costruirci sopra avrebbe
  scambiato una lista scritta a mano che invecchia con un'API privata che si
  rompe. Il "sigillato" è un fatto sul **file**, non sul parse di oggi:
  provato spezzando `rot/budgets.json` e vedendo il valore cadere sul
  compilato mentre la colonna sigillato resta "sì".
- **Il primo avvio dice cosa ha dedotto.** L'inferenza del provider
  (`cli/onboarding.ts`, `inferProvider`) **era già cablata dentro `cmdInit`
  dal 2026-08-09** (`eb45b86`, quattro giorni prima che ADR-0036 fosse
  scritta) — la frase sia dell'ADR sia del mandato di questa slice
  («`options.provider ?? 'anthropic'` scrive anthropic anche a chi ha una
  chiave OpenRouter») descrive uno stato già superato, verificato leggendo il
  codice riga per riga prima di toccarlo. Quello che restava davvero:
  **un'inferenza riuscita non lo diceva mai** — un avviso esisteva solo
  quando falliva, silenzio quando andava bene. `chooseProvider` +
  `describeProviderChoice` (`cli/onboarding.ts`) uniscono la decisione in un
  solo posto e la annunciano sempre, es. *"✓ provider openai-compat
  (https://openrouter.ai/api/v1) — dedotto dalla chiave (sk-or-…)"*. **Provato
  eseguendo il binario reale** su una pty vera (`expect`, non solo i test):
  `MUFFIN_HOME` vuoto, "Lo configuro ora?" → sì, incolla una chiave
  `sk-or-v1-…`, e il transcript mostra la riga sopra prima degli step di
  `runInit`; `config.json` risultante ha `provider.kind: "openai-compat"`.
  **Trovato un secondo difetto, minore, rifattorizzando**: il controllo "sembra
  un token Telegram" viveva dentro `if (apiKey && !providerFlag)`, quindi un
  `--provider` esplicito lo bypassava — un token di bot incollato insieme a
  `--provider anthropic` finiva salvato come chiave del modello. Ora
  incondizionato; test verificato fallire senza (nessun file di chiave dopo
  l'incollata, con la vecchia guardia).
- **Alias italiani selettivi.** Una mappa in testa a `main()`,
  `memoria→memory · lavori→jobs · segreto→secret` — esattamente i tre che
  l'ADR nomina, nessuno in più. `muffin memoria` e `muffin memory` producono
  output byte-identico (stesso ramo: la mappa risolve solo il nome del
  comando, prima dello switch); `memorie` — quasi giusto — resta "comando
  sconosciuto", a provare che la mappa non fa fuzzy match.

⚠️ **La spazzata italiano è deliberatamente parziale — il mandato la chiedeva
scoped, non totale.** Tradotti: `USAGE` di `cli/main.ts`, `firstRun`,
`cmdInit`, `offerGateway`, `cmdUninstall`, l'errore top-level (`unknown
command:` → `comando sconosciuto:`), e `muffin config` (nativo italiano fin
dall'inizio). **Lasciati fuori apposta**, e il motivo: le sei costanti
`*_USAGE` di `cli/{memory,vault,surface,mcp,jobs,gateway}.ts`,
`cmdRot`/`cmdSecret`/`cmdTrace`/`cmdRun` dentro `cli/main.ts`, e
`cli/doctor.ts` sono già oggi mescolate inglese/italiano — la deriva che
l'ADR nomina, circa 280 stringhe — e ognuna richiederebbe il proprio giro di
audit sui test che ne dipendono prima di poter tradurre senza rompere
un'asserzione: esattamente il costo che il mandato segnalava come rischio
reale di uno spazzata totale. Restano per una prossima passata, elencate qui
perché "trovato e non scritto" (`docs/PRACTICES.md` §12).

⛔ **Resta aperto.** Nessuna superficie di scrittura conversazionale — non
richiesta da questa slice (ADR-0036: *"`muffin config` è sola lettura, e
questo è il punto"*), ma è la ragione per cui l'onboarding guidato-da-Muffin
resta *"una sezione di prompt"*, non un meccanismo (`STATE.md`, voce 3). E
nessun tool in `agent/tools/` legge ancora `listConfigKnobs` — la funzione
vive apposta in `core/config/inventory.ts` e non in `cli/`, perché un tool
futuro possa importarla senza dipendere da `cli/` (verificato: nessun file di
*produzione* sotto `agent/` importa da `cli/` oggi — solo i fixture dei test,
via `runInit`, che è un pattern diverso e già stabilito), ma quel tool non è
ancora costruito.

**4. Niente resume a grana di turno, e niente retry sul percorso lungo.** L'unico
asse su cui la ricerca peer ha dato torto a noi (`research/confronto-harness.md`
§2.3): un tool call lungo più un riavvio perde tutto. M5 ha già concesso il
principio a grana di job; manca la grana di turno, sul jsonl di sessione che
esiste già.

**5. Nessun eval di accettazione a costo quasi zero.** Ci sono cinque famiglie di
eval, ma manca la cosa che l'owner ha chiesto: uno scenario end-to-end con
provider finto (zero token) più uno smoke piccolo contro il modello vero. È il
modo per verificare l'harness **senza** doverlo usare come agente quotidiano —
cioè senza dipendere dalla cosa che il Gate 1 misura.

**6. Un turno autonomo riceve il prompt scritto per te.** `tenantClass` dà classe
owner a un principal `system`, quindi un cron o un `observe` legge un testo in
seconda persona rivolto a qualcuno che è lì davanti — mentre **non c'è nessuno
che aspetta**. Cambia cosa è una buona risposta (niente domande di chiarimento,
forma da notifica e non da conversazione) ed è verificabile: se in un turno
autonomo Muffin fa una domanda, l'ha violata. Due forme possibili — una terza
classe accanto a owner/group (l'asse è stabile per turno, costa una entry di
cache) oppure una riga nel messaggio (la mossa di Hermes: ciò che varia per turno
esce dal prompt). Da ADR.

**7. ~~La lane `light` non consulta mai un profilo~~ — chiuso (ADR-0038).**
`core/memory/extract.ts:157`, `judge.ts:135` e `rerank.ts:84` fissano
`temperature: 0` fuori dal sistema dei profili, con lo stesso hardcode che
ADR-0037 ha tolto dal loop principale: legale solo finché il light di default è
haiku 4.5, un **400 su ogni consolidamento** il giorno che `--light-model` punta
a un 4.7+, e nessuna modifica ai profili poteva ripararlo. Chiuso dal confine che
la riga 1 doveva costruire comunque per il budget
(`agent/providers/light-lane.ts`): la corsia light si costruisce dietro un
wrapper che fattura la chiamata **e** applica il `sampling` del profilo risolto
per il modello light. I tre letterali restano dove sono e continuano a dire ciò
che dicono — *questo lavoro vuole determinismo* — e il confine è dove quella
richiesta incontra ciò che il modello accetta. Wrapper e non tre parametri: il
difetto di questo repo non è una riga sbagliata, è un meccanismo che il quarto
chiamante non sa di dover raggiungere.

**Dall'inventario vecchio-nuovo** (`research/inventario-vecchio-nuovo.md`, 86
righe con verdetto: 41% presente, 29% tolto di proposito, 23% manca e serve, 8%
era slop). Le MANCA-SERVE che non sono già qui sopra:
- **mail e calendario** — il vecchio li aveva col gate giusto (bozza → outbox →
  conferma → grace worker); il nuovo ha il kernel e zero adapter. Prima va chiuso
  il capitolo di threat model sulle sorgenti in ingresso.
- **note vocali non trascritte** — il vecchio ascoltava (whisper locale,
  on-device); il nuovo salva l'ogg e tace.
- **living profile + counterpoint** — la tabella `profiles` esiste in schema
  **senza scrittori né lettori**: decima istanza della famiglia.
- **onboarding che impara** — il vecchio aveva un meccanismo, il nuovo una
  sezione di prompt.
- e un posto dove **chiedere cosa si regola** (non necessariamente un `muffin
  config`: basta un comando che elenchi le manopole e dove vivono).

**Dal confronto con la consulenza esterna** (`research/confronto-gemini.md`,
2026-08-14). Quattro buchi veri, tutti **piccoli e fuori dal cammino critico** —
nessuno viene prima dei punti 0 e 1 qui sopra. Sono elencati qui perché tre su
quattro erano già dentro `inventario-vecchio-nuovo.md §8` e uno no, e perché
essere stati ritrovati da fuori, senza vedere il codice, dice che sono i buchi
che si vedono usando:

- ~~**A · il fetch non estrae il testo.**~~ — chiuso (2026-08-14, ADR-0041).
  `agent/tools/http.ts:130` restituiva il corpo **grezzo** (HTML compreso) e `:169`
  lo troncava head 40k + tail 10k — cioè buttava il `<body>` e teneva `<head>` e
  footer. Erano ~12k token di cui forse 800 di testo, in un turno con un tetto di
  4096 in uscita. **Regressione rispetto al vecchio**, che aveva Readability;
  l'inventario aveva marcato la riga "PRESENTE, più stretto" guardando la sicurezza
  (vera e migliore: SSRF su ogni hop) e mancando la resa — corretto lì.

  ✅ **Estrazione locale davanti a `clipBody`**, come `research/recupero-dal-web.md`
  aveva già misurato: `defuddle` su `linkedom`, importato come libreria
  (`defuddle/node`), mai come sottoprocesso né come servizio terzo (Firecrawl/Jina
  avrebbero letto la pagina al posto nostro). Nuovo modulo
  `agent/tools/extract.ts`: gate sul `content-type` della risposta (solo
  `text/html`/`application/xhtml+xml` passano dall'estrattore — un corpo JSON, testo
  puro o CSV attraversa `clipBody` byte-identico, testato); mai un fallimento
  dell'estrazione che fa fallire il fetch (Defuddle che lancia, che non trova nulla,
  o che restituisce qualcosa di implausibilmente piccolo contro un input sostanziale
  ricade sul corpo grezzo, tutti e tre testati con fixture che falliscono
  l'estrazione); `clipBody` resta, invariato, la rete finale — ora quasi sempre
  inerte. Il taint non cambia, `sys.http` non cambia: pulire non è fidarsi, cambia
  solo quanto testo entra nel recinto.

  ⬤ **Misurato su due pagine vere** (`curl`, nessuna chiave, nessuna chiamata a
  pagamento): Wikipedia "Web scraping" 50.049/14.012 token oggi (già troncato) →
  41.696/10.268 estratti (**−26,7%**); un capitolo della documentazione Python
  73.085 caratteri (mai troncato, sotto i 50k) 14.561 token oggi → 14.435/3.734
  estratti (**−74,4%**). Numeri più bassi delle quattro pagine di
  `recupero-dal-web.md` (61-96%) perché quella pagina Wikipedia porta 41 note a piè
  di pagina che sono contenuto vero, non uno scarto di estrazione — ispezionato
  direttamente, nessun testo di navigazione o banner nel risultato.

  **La correzione che la ricerca non aveva**: `turndown` — richiesto per
  `{markdown: true}` — non è evitabile con `--omit=optional` come la ricerca aveva
  assunto: `defuddle/node` lo richiede a livello di modulo, non solo quando
  l'opzione è usata, e lo stesso vale per `mathml-to-latex` (richiesto dal supporto
  matematico, sempre caricato). Il secondo motore DOM (`@mixmark-io/domino`, 8,8 MB,
  dietro `turndown`) che la ricerca pensava di evitare **non si evita**: 20 pacchetti
  / 20 MB misurati, non i 19/9,8 MB scritti lì (dettaglio e correzione appesa a
  `recupero-dal-web.md`, mai riscritta in loco). Gap A si chiude quindi a **13
  dipendenze runtime, non 11**: `defuddle`, `linkedom`, `turndown`,
  `mathml-to-latex` tutte dichiarate esplicitamente in `package.json` — non lasciate
  come installazioni transitive non dichiarate, perché un pacchetto che il codice
  richiede davvero all'import non è, in nessun senso che conti qui, opzionale.
- **B · non si può navigare la storia.** `memory_search` prende **solo una
  query**: niente `date_range`, niente `surface`, niente vicinato. È il caso
  d'uso letterale dell'owner (*"navigare i messaggi anche tra più surface"*) e i
  campi esistono già su `episodes` (`connector`, `thread_key`, `created_at`).
  Oltre alla comodità c'è una ragione strutturale: senza vicinato un episodio
  ripescato è **una frase senza il suo intorno**, e la cosa più facile che un
  modello ci faccia sopra è inventare il contesto mancante. Due vincoli nostri
  che la forma esterna non ha: il tenant **non è mai un argomento** (è quello del
  turno), e il vicinato eredita il **taint massimo della finestra**, non quello
  dell'item trovato.
- **C · il budget è solo globale.** Cap mensile e cap giornaliero per-tenant
  (`core/budget/budget.ts`), consultati dal kernel; il cap per-turno conta i
  giri, non i token. Basta finché c'è un umano davanti — **con ADR-0035 non
  c'è**. Serve un budget **per-job** (token, chiamate, timeout) in
  `core/scheduler/jobs.ts`: è la differenza fra un job rotto che costa €0,50 e
  uno che si mangia il mese prima delle 7. Stessa slice di ADR-0035, e il
  conteggio va tenuto fuori dal turno per la stessa ragione dell'heartbeat.
- **D · la storia si tronca invece di comprimersi.** 40 turni secchi
  (`agent/loop.ts:62`) sulla parte *parlata*, che è l'unica non recuperabile da
  un tool; `digests` esiste (`core/memory/schema.ts:138`) **senza scrittori né
  lettori**. Già in `inventario §8` punto 7 come costo medio-differito: qui
  cambia solo l'ordine delle tre mosse possibili — **prima si svuota** (fatto:
  `compact.ts`, la cosa più economica misurata), **poi** si riassume. Non serve
  un compattatore nuovo, serve scrivere `digests`.

Fuori da questi quattro, **da annotare e non costruire**: la sottostruttura del
vault (`inbox/notes/research/artifacts/tmp` — convenzione, mai semantica: una
cartella non è un permesso), la **condizione di stop** sui job (oggi un job "per
due settimane" si spegne solo se qualcuno lo toglie — stessa slice del trigger a
predicato), il constraint-verifier come **proprietà degli adapter** mail e
calendario, e il rollback-all'eccezione per le skill quando arriva M6.

**Il contro-numero, che vale quanto quelli sopra**: dei 47 tool del vecchio,
**16 non sono mai stati invocati** e **28 su 47 meno di cinque volte in quattro
mesi**. Sei tool hanno fatto il lavoro. Lo skill layer da 3.052 righe: 3
candidati, 1 uso. `undo_log`: **zero righe** — il tier act-notify-undo non ha mai
prodotto un revert. E il loro `config.yaml` è caricato, validato e letto da
nessuno: la famiglia "dichiarato e non connesso" non è una nostra particolarità.
Questo è ciò che "TROPPE cose" significa in numeri, e giustifica il tetto sui
tool meglio di qualunque argomento sul prompt.

**Conseguenza sul Gate 1, detta chiaramente**: il criterio d'uscita resta l'uso
per due settimane, e resta a zero giorni. Ma la causa non era la pigrizia
dell'owner: era che il substrato completo **non produce un agente che si possa
usare**. Queste cinque righe sono ciò che sta in mezzo.

### M6 — Introspezione (le due direzioni) + cricchetto *(durevole — è il differenziale)*
- **Include**: analisi batch dei trace → **report su di sé** (pattern di fallimento, costi, tasso di successo tool, derive) e **report sull'utente** (pattern osservati con evidenza citata e contrappunto — mai psicologizzazione gratuita: ogni claim linka episodi); ratchet API (proposta versionata → eval gate → canary → undo — V3) per voice/prompt/soglie; skill autodraft loop (detect→gate→materializza); il monitor anti-dipendenza (V13: volume che cresce senza esiti → refertato).
- **NON include**: modifiche autonome fuori dal perimetro ratchet; qualunque scrittura al RoT.
- **Dipendenze**: M2, M5.
- **DoD**: a fine settimana esistono due report **con dati veri** dai trace (non template); "perché ieri hai fatto X?" risponde citando gli span; una proposta di modifica a `voice.md` che passa l'eval si attiva con notifica e undo funzionante; una che NON passa resta proposta e non tocca nulla; il report utente contiene almeno un contrappunto ancorato a episodi reali.
- **Config**: cadenza report — repo default settimanale · chat · default; perimetro ratchet — RoT · solo owner via repo · default conservativo.

### M7 — Gruppi: isolamento *(durevole)*
- **Include**: tenancy runtime completa su gruppi Telegram (snapshot permessi per principal, budget e rate-limit per tenant, TTL cleanup, registro leggero); la suite d'attacco cross-tenant in CI.
- **NON include**: **community cross-connector (post-v1)** — le fondamenta strutturali (tenant_id ovunque, identities per-connector, provenienza) sono già in M2: la feature arriva dopo, la riscrittura no.
- **Dipendenze**: M3, M4.
- **DoD**: due gruppi + chat privata sulla stessa istanza: un membro del gruppo tenta (a) di farsi dire dati del tenant host, (b) di piazzare un ricordo dormiente che si attiverebbe in privato, (c) di far eseguire un comando host — tutti e tre falliscono con log del kernel (suite 05 §4 verde); l'owner può interrogare i propri gruppi dalla chat privata con etichette di provenienza.

---

### I due gate: MVP e cutover (direttiva owner 2026-08-04)

L'owner: *"voglio che Muffin nuovo abbia un MVP decente, non che lo mettiamo in prod ma senza gruppi, senza memoria e cose così"*. Due soglie distinte, perché sono due decisioni diverse:

**Gate 1 — MVP** (il nuovo Muffin è usabile davvero; il vecchio resta acceso). Richiede **M0→M5**: kernel e tracce, loop e CLI, **memoria**, primitivi host con sandbox, surface remote, scheduler e proattività. Non è un demo: ricorda, agisce sulla macchina, parla per primo, si usa da terminale e da chat. **Criterio di uscita**: l'owner lo usa come agente quotidiano per **due settimane consecutive** senza tornare al vecchio per qualcosa che non siano i gruppi.

**Gate 2 — Cutover** (il vecchio si spegne). Richiede MVP + **M6** (introspezione) + **M7** (gruppi con isolamento) + **migrazione della memoria completata e verificata** (02 §8) + **una settimana in parallelo** senza regressioni misurate. Motivo del vincolo: il Muffin in produzione oggi ha gruppi vivi e anni di memoria — spegnerlo prima di averli significa perdere capability che usi, ed è esattamente ciò che l'owner esclude.

Fuori da entrambi i gate (post-v1): community cross-connector, system layer "flagship" (app control, computer-use), MCP Apps.

### Ordine di costruzione — strangler (revisione Fase C, C2-#14)

**M0 → M1 → M2 → M4 → M3 → M5 → M6 → M7.** La modifica rispetto alla sequenza originale: **la memoria e il connector Telegram precedono i primitivi di sistema**. Motivo: con serate part-time, l'ordine originale metteva il primo valore quotidiano percepibile (la memoria) al terzo modulo e il primo canale reale al quinto — settimane in cui costruisci senza usare. Con lo strangler, appena M2+M4 girano il nuovo Muffin è già il tuo Muffin quotidiano su un canale vero, e il vecchio resta acceso solo per ciò che non è migrato. M3 (primitivi + sandbox) arriva subito dopo, su un sistema già vivo. Costo: una settimana in più di doppio sistema. La decisione di fondo (albero nuovo vs retrofit sul repo esistente) è in `10-risoluzioni-fase-c.md` §4.

## 3. Scope v1 e tagli espliciti

**v1 = M0→M7**: un'istanza single-owner, CLI + Telegram, con memoria TKG vera, primitivi host, scheduler proattivo gated, introspezione bidirezionale e isolamento gruppi. **Fuori da v1 (dichiarato, non "da riempire dopo")**: community cross-connector; MCP Apps UI e Muffin-come-server-MCP; connector Discord/Slack/mail/calendar; system layer oltre i primitivi (app control, UI automation, osservazione di sistema); renderer video; voice/audio; multi-owner; sync multi-device. Ognuno di questi ha le fondamenta strutturali già decise (tenancy, renderer capability-aware, capability registry) — aggiungerli è addizione, non riscrittura.

**Ordine, sfidato come chiesto**: l'intuizione owner (Core→Memory→Tools→Community) è confermata con due correzioni: (1) i primitivi (M3) precedono il connector remoto (M4) perché il valore quotidiano passa dal *fare*; (2) la Community retrocede a post-v1 — l'isolamento (M7) è in v1, la condivisione no: è la scelta coerente con L0-4/L0-5 e con l'evidenza che il boundary è il punto che si buca (Khoj). Il system layer sta in v1 SOLO come primitivi host-only (M3) — coerente col verdetto sul nome (V12).

---

## 4. Muffin costruisce Muffin — bootstrap operativo

- **Da fine M3** (loop+primitivi+dev+trace): Muffin lavora sul proprio repo — clone dedicato, mai il working tree dell'owner; test; branch+PR; review umana obbligatoria.
- **Primo incarico** (rischio zero, valore di dogfooding): il report settimanale sui propri trace (anticipo di M6 come *uso*, non come modulo).
- **Da lì in poi**: ogni modulo successivo usa Muffin per ricerca, review, generazione di test; il coding pesante è orchestrato su harness esterno via API (V4). I suoi trace ed eval su questo lavoro diventano il primo corpus dell'introspezione — con le due terre esterne (test eseguibili, review umana) che rompono l'autoconferma.

---

## 5. Dopo i gate: la direzione è continuità, non una coda di feature

ADR-0045 non cambia l'ordine M0→M7 e non aggiunge blocker al test dei quattordici
giorni. Cambia la domanda con cui si ordina ciò che viene dopo: non “quale
integrazione manca rispetto a un peer?”, ma **“quale interfaccia diretta può
diventare una superficie dello stesso agente senza perdere controllo?”**.

La progressione è questa, e non sono nuovi moduli numerati:

1. **Continuità operativa** — il lavoro vive oltre la richiesta: turni durevoli,
   `wait`, resume, progresso, consegna e recovery. È il fondo del Gate 1 e vive
   oggi nell'inventario M5-bis.
2. **Presenza** — l'agente distingue evidenza, credenze, stato del mondo e stato
   del lavoro; osserva eventi autorizzati e sa agire, aspettare, tacere,
   interrompere o abbandonare. Prima un consumer concreto, poi qualunque schema
   di world state.
3. **Autonomia guadagnata** — la supervisione si comprime per capability,
   risorsa e contesto su esiti osservabili, reversibili o recuperabili. Revoca,
   scadenza e regressione sono parte della concessione. Il kernel e il Root of
   Trust non si allargano e il modello non arbitra la sicurezza.
4. **Ubiquità** — nuovi device diventano porte dello stesso agente. Voce,
   speaker, pendant e sensori non hanno memoria, persona o policy proprie.
5. **Sostituzione verificata** — una direzione ha valore quando l'owner smette
   davvero di aprire un'app, un pannello o un device direttamente senza perdere
   possibilità di intervento.

### Direzioni con il loro segnale

- **Outward mail/calendar** — quando il modello di reversibilità è provato e il
  threat model delle sorgenti in ingresso è chiuso; parte draft-by-default.
- **Connector o device aggiuntivo** — quando copre un'interfaccia usata davvero
  dall'owner e implementa il contratto di surface; non per parità di catalogo.
- **World state materializzato** — quando un consumer reale dimostra quali
  condizioni correnti servono, con provenienza, freschezza, ritiro e tenancy.
- **Autonomia guadagnata** — quando esiste una storia di esiti sufficiente a
  definire e falsificare una concessione scoped; mai da familiarità generica.
- **Community cross-connector** — M7 stabile + richiesta reale.
- **MCP Apps/dashboard** — adozione host che copre i canali dell'owner, senza
  aprire un secondo scrittore del database contro ADR-0022.
- **System layer flagship** — computer-use long-horizon sopra soglia utile o API
  OS deterministiche; solo allora “MuffinOS” torna sul tavolo (V12).
