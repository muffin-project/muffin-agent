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
- **Config**: allowlist MCP — owner · primo uso di un server (chiede) · senza: nessun MCP; credenziali forge — owner · primo uso `dev` remoto · senza: `dev` solo locale.

### M4 — Connector Telegram *(durevole nel pattern, sostituibile nell'istanza)*
- **Include**: transport tipato (pattern P0-P7); mapping sessioni `(tenant, connector, thread)`; **renderer capability-aware** (direttiva owner: il connector dichiara `text|image|file|card|…` e si sceglie il mezzo più ricco, non il più verboso — su Telegram: formattazione nativa, foto/documenti, card-immagine via Chromium headless se presente); ingestion di media/documenti nel vault.
- **NON include**: gruppi multi-tenant completi (M7), Discord/altri (post-v1), MCP Apps (post-v1).
- **Dipendenze**: M1-M2 (M3 per azioni). **Prerequisiti**: bot token.
- **DoD**: scrivo al bot dal telefono: stessa memoria della CLI (stessa istanza host); gli mando un PDF → nel vault, indicizzato, interrogabile; la risposta a una richiesta di sintesi arriva come card leggibile (o testo asciutto se Chromium assente — degradazione dichiarata); dopo riavvio la conversazione riprende dal punto giusto.
- **Config**: bot token — owner · attivazione connector · senza: connector spento (il resto vive); resa rich-media — auto (rileva Chromium) · runtime · senza: testo.

### M5 — Scheduler & proattività *(cron durevole; soglia di proattività = impalcatura etichettata)*
- **Include**: cron semantico (NL→spec deterministica confermata in chat, poi esecuzione senza LLM); event-bus a soglia (pattern Odysseus) che sostituisce i demoni; heartbeat budgetato; **gate di proattività**: trigger armabili solo da evidenza tier ≤1, quiet-hours e budget nel RoT, canale di consegna esplicito.
- **NON include**: outward autonomo (mail a terzi ecc. — draft-only resta la regola), "iniziativa" senza trigger dichiarato.
- **Dipendenze**: M1-M2. 
- **DoD**: "ogni mattina alle 8 fammi il brief della giornata" da chat → job visibile in `muffin jobs`, arriva alle 8 sul canale scelto, sopravvive al riavvio; un trigger a soglia (N episodi non consolidati) fa partire il consolidamento da solo; un tentativo di armare un trigger da contenuto di gruppo viene rifiutato e loggato (test); il costo giornaliero dello scheduler è visibile e sotto il cap.
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

⛔ **Resta aperto, e sono le cose che il processo ora rende scrivibili**:
`queue`/`steer` e il concetto di "occupato" (serve il protocollo client/server
sul socket unix, non costruito); `heartbeat`; `undo`; il **trigger a soglia sul
consolidamento** (punto 1 qui sotto, tuttora non soddisfatto — il gateway è il
posto dove va, non è il trigger); la consegna remota su una surface (un job per
canale remoto emerge ancora nel log invece di arrivare). E un limite dichiarato:
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

**2. `thinking` è dichiarato e mai passato.** I profili per-modello hanno
`thinking: 'off' | 'allowed'`, l'adapter Anthropic sa spedirlo — e il loop non lo
passa al provider. Nono caso della famiglia "dichiarato e non connesso".

**3. Muffin non è governabile da dentro.** Cinque slash nel REPL (`/exit /help
/new /session /spend`), nessun `muffin config`, nessuna dashboard: provider,
modelli, budget, quiet hours si cambiano **editando JSON a mano**, e quelli nel
RoT vogliono pure il reseal. L'owner non sa cosa può regolare perché non c'è un
posto dove chiederlo.

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

## 5. Post-v1 (direzioni con segnale, dettaglio in 07)

Community cross-connector (segnale: M7 stabile + richiesta reale); MCP Apps dashboard (segnale: host adoption che copre i canali dell'owner); system layer flagship (segnale: computer-use long-horizon sopra soglia utile o API OS deterministiche — solo allora "MuffinOS" torna sul tavolo, V12); connector aggiuntivi; outward module (mail/calendar con draft-by-default, pattern HumanLayer fattore-7: HITL come tool call).
