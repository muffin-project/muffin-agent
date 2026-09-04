# Il vecchio Muffin a confronto — 2026-09-04

Documento di esposizione, non di raccomandazione. Per ogni concetto: cosa
faceva il vecchio Muffin (`/home/user/dev/Muffin`, letto in sola lettura,
HEAD al momento dell'analisi), cosa fa il nuovo (`muffin-agent`, branch `dev`),
se esiste una decisione registrata (ADR o `docs/COGNITIVE-DESIGN.md`), e le
conseguenze di ciascuna forma. Nessuna scelta viene indicata come migliore.

I riferimenti al vecchio repo usano il suo `CLAUDE.md`/`docs/DECISIONS.md`
correnti (fonte di verità sullo stato finale, non la cronologia grezza dei
commit); dove il testo del vecchio repo segnala esplicitamente "RIMOSSO" o
"RIP", quel concetto è trattato come **ritirato**, non come vivo.

---

## 1. Processo continuo — c'è sempre qualcosa che gira?

**Il vecchio.** Tre processi PM2 sempre attivi su una VPS Hetzner: `muffin`
(gateway/bot), `muffin-webapp`, `muffin-thinker` (reactor, scheduler, dream
cycle) — `ecosystem.config.cjs`. `fork` mode esplicito (non cluster) perché il
bot è un long-poll singleton Telegram; `kill_timeout: 15000` per lo shutdown
grazioso; `max_memory_restart` 600M/200M. A metà progetto la produzione è
migrata da PM2 a systemd (`deploy/systemd/muffin-bot.service`,
`muffin-thinker.service`, `muffin-webapp.service`, commit `dea1472`/`717b1ef`),
con drop-root: i tre processi giravano prima come `root`, poi come utente
`muffin` non privilegiato (`docs/DECISIONS.md:1310-1337`). Il sistema quindi
**esisteva come demone di produzione dal primo mese** e il thinker eseguiva
cron interni (dream cycle, reactor, `checkCronTriggers`) indipendentemente da
un terminale aperto.

**Il nuovo.** ADR-0022 aveva deciso "un processo OS per il runtime" con
systemd a riavviarlo — e la sua stessa nota di correzione (2026-08-11) dichiara
che quella decisione **non era mai stata implementata**: lo scheduler viveva
in un `setInterval` dentro `cli/repl.ts`, morto alla chiusura del terminale,
con effetto misurato — "414 fatti nel vecchio contro 0 nel nuovo"
(`docs/decisions/0035-il-gateway-vive.md:6`). ADR-0035 costruisce poi il
gateway come processo residente vero: nessun listener di rete (socket unix
locale), lease con generazione/fencing (`core/lock/durable.ts`), unit
systemd/launchd generate da `muffin init` (proposta interattiva, mai silenziosa
— Emendamento №1) e provate end-to-end su crash/recovery
(`docs/decisions/0035-il-gateway-vive.md` Emendamento №4, battery A1). Il
gateway gira **come l'owner, senza elevazione**, mai come utente/servizio di
sistema privilegiato — quindi non replica il percorso drop-root del vecchio
perché non parte mai da root.

**Decisione registrata.** ADR-0022 (assunzione iniziale) → ADR-0035 (forma
reale, con la propria correzione esplicita sull'assunzione non implementata).

**Conseguenze.** Vecchio: il demone è vivo e collaudato in produzione da
mesi, ma parte da un design meno rigoroso su liveness (nessun
watchdog/`sd_notify`, `Restart=always` senza distinguere "acceso" da
"piantato"). Nuovo: il design del processo residente è più esplicito sui
guasti (lease con orizzonte duro, fencing, `job_fires` per l'idempotenza di
un fire dopo crash — tutto assente nel vecchio) ma **arriva dopo** l'undicesima
istanza di "dichiarato e non connesso"; l'installazione automatica al boot
resta non verificabile in questo ambiente (richiede un riavvio macchina reale)
e la proprietà "gira sempre" dipende dal fatto che l'owner esegua `muffin init`
o `muffin gateway install`.

---

## 2. Aggiornamento — chi lo dichiara, da dove si aziona

**Il vecchio.** Comando Telegram `/update` (owner-only, admin scope,
`src/CLAUDE.md:680-682`): rileva systemd via `$NOTIFY_SOCKET`, avvia
`muffin-update.service` (unit oneshot separata, `deploy/systemd/README.md:24`)
che fa `git pull` + `npm ci` + build + restart **sullo stesso albero in
esecuzione**, con notifica di completamento al boot successivo del bot
(`update_notify.ts`). Azionabile dal telefono, senza toccare un terminale.

**Il nuovo.** `muffin update` (`cli/update.ts`, 852 righe) è un comando **solo
CLI**: fetch di `origin/main`, checkout in un `git worktree` separato sotto
`.releases/<sha>` (non tocca l'albero da cui gira il gateway vivo), build e
smoke-test *di quella directory*, backup, poi swap atomico dei symlink
launcher — mai un `git pull` in place (`cli/update.ts:29-45`). Il file stesso
nomina il limite: "l'unico aggiornamento che questo comando non può fare è il
proprio arrivo" — un'installazione più vecchia di questo file risponde
"comando sconosciuto" (`cli/update.ts:49-52`). Nessun percorso di innesco da
Telegram o da qualunque altra superficie remota: il comando non compare in
`agent/comandi.ts` (l'elenco unico CLI+Telegram) né in `connectors/telegram/`.

**Decisione registrata.** Nessuna trovata: né un ADR né `COGNITIVE-DESIGN.md`
discutono se l'aggiornamento remoto sia stato scartato o solo non ancora
costruito.

**Conseguenze.** Vecchio: comodo (aggiornare dal telefono, in viaggio), ma
mutava l'albero in esecuzione — un `npm ci` fallito a metà lasciava la
produzione nello stato peggiore possibile, il fallimento che il commento di
`cli/update.ts` nomina esplicitamente come motivazione del proprio design.
Nuovo: l'aggiornamento non può mai lasciare l'albero vivo rotto (release
separata, swap atomico), ma richiede accesso fisico/SSH alla macchina che
esegue il gateway — l'owner deve essere lì o passare da un terminale connesso,
non dal telefono.

---

## 3. Proattività e notifiche — quando Muffin parla per primo

**Il vecchio.** Proattività distribuita su più meccanismi indipendenti: cron
del thinker (`daily_morning`/`daily_evening`/`weekly_reflection`,
`src/CLAUDE.md:621-636`), `demon_explorer` (ricerche web autonome + 1
observation/giorno), `demon_observer` (affect + observation graph-informed),
`memory_notifications.ts` (pattern instruction, con escalation "soft dopo 7gg
→ imperativo → give-up a 14gg" — nota nel codice: "measured 0%-fire on Gemma
for 9gg" per la forma soft-conditional), `proactive_deliveries` per il
tracking dell'engagement. Il pattern complessivo, descritto nel nuovo repo
come eredità negativa, era il "firehose ho notato X, ho notato Y" — vago,
iper-complesso, a volte campato in aria (citato testualmente in
`docs/decisions/0028-postura-di-proattivita.md:155` e in
`docs/COGNITIVE-DESIGN.md:229-231`).

**Il nuovo.** ADR-0028: postura "segnale ad alta confidenza". Un solo punto
di decisione puro e testato (`decideProactive`,
`core/scheduler/proactivity.ts`): tier>1 nega per costruzione
(`deny('tainted_source')`), quiet-hours differisce, budget esaurito differisce.
Il `kind` del trigger è un **insieme chiuso** (`commitment_due`,
`deadline_near`, `fact_actionable`, `consolidation`) — "un'osservazione libera
non è rappresentabile" (ADR-0028). Un emendamento proposto e non ratificato
(`gone_quiet`, assenza come segnale) applica lo stesso vincolo di forma a un
caso che rischia di essere l'opzione-C respinta con motivo esperienziale
diretto. Nota di verità nello stesso ADR (2026-08-10): il gate non aveva
**nessun chiamante** fino a quella slice, e il rail del budget mensile non era
davvero letto dal gate (duplicazione fra `rot/budgets.json` e
`config.budget`) — difetti dichiarati, non nascosti.

**Decisione registrata.** ADR-0028 (postura); `COGNITIVE-DESIGN.md` §3 H5 e §5
("Proactivity as regular heartbeat conversation" — **REJECTED**, con il
vecchio Muffin citato esplicitamente come evidenza negativa).

**Conseguenze.** Vecchio: più superfici di iniziativa (esplorazione web
autonoma quotidiana, introspezione settimanale, pattern reminder) — più
copertura, ma il costo misurato è l'effetto "ho notato" giudicato fastidioso
dall'owner stesso, cioè la ragione scritta del cambio. Nuovo: l'insieme chiuso
di `kind` rende il firehose letteralmente non scrivibile, ma restringe cosa
Muffin può iniziare a dire di propria iniziativa a quattro categorie — e per
mesi l'intero meccanismo può risultare silenzioso semplicemente perché nessun
detector nuovo è stato aggiunto (è il segnale di errore che l'ADR stesso
nomina all'estremo opposto).

---

## 4. Permessi — chi decide cosa un turno può fare

**Il vecchio.** Zone di rischio (green/yellow/red) + registry di tool
(`toolsRegistry`, 47 entry al momento della lettura, `src/CLAUDE.md:491-506`)
+ tier-2 "act-notify-undo". Le regole di zona sono **per-tool**, dichiarate nel
registry di ciascun tool (es. `fs` op-per-op in `src/memory/CLAUDE.md:92`:
"green per read/list/write/append, yellow per
`projects/<name>/decisions.md`... delete red statico sempre"). Il nuovo repo
osserva di questo sistema (ADR-0013) che erano "tre linguaggi di sicurezza"
storicamente separati (HITL sui tool, ACL sui tenant, sandbox sul sistema).
Nel vecchio repo l'`undo_log` del tier act-notify-undo ha **zero righe in
quattro mesi** — citato dal nuovo come "il tier act-notify-undo non ha mai
prodotto un revert" (`docs/decisions/0035-il-gateway-vive.md:23`).

**Il nuovo.** ADR-0013: un'unica funzione deterministica nel Root of Trust,
`decide(principal, tenant, capability, resource, args, taint) → ALLOW | ASK |
DRAFT | DENY`. Ogni tool dichiara capability, classe di rischio, taint
massimo, reversibilità; i tre livelli HITL del vecchio diventano *esiti* della
stessa policy invece di tre sistemi. Confinamento monotono: solo restrizioni
auto-applicabili, mai allargamenti senza approvazione. Snapshot di permessi
immutabile per il turno, calcolato nel pre-loop.

**Decisione registrata.** ADR-0013, con prior art esplicito (Progent, CaMeL,
consenso OWASP "l'injection si contiene all'esecuzione, non nel prompt").

**Conseguenze.** Vecchio: sistema costruito incrementalmente PR dopo PR,
flessibile ma con superfici multiple di decisione (una domanda come "cosa può
fare questo turno" non ha una risposta unica) e un meccanismo di riparazione
(undo) mai realmente esercitato. Nuovo: un solo punto di audit ("perché
negato" = una riga di trace") dichiarato **a bassa reversibilità** dallo
stesso ADR — "cambiarla dopo = ri-audit completo" — cioè il costo di essere
centralizzato è pagato in anticipo e non è economico da disfare.

---

## 5. Memoria — chi scrive cosa, e quali livelli derivati esistono

### 5.1 Chi scrive

**Il vecchio.** Scrittura mista: pipeline automatica (estrazione da episodi,
`memory_semantic.ts`) **e** demoni che scrivono direttamente (dream cycle,
`demon_observer`). Un canale di auto-editing agentico è esistito ed è stato
**ritirato**: `bot_claims`/`bot_claims_group` (belief revision) rimossi
2026-06-18, "8 noise-injection/30d, ZERO revisioni effettive"
(`src/memory/CLAUDE.md:29`).

**Il nuovo.** ADR-0032 → ADR-0051: "many producers, one semantic writer".
L'estrazione batch (`core/memory/extract.ts`) è descrittiva per costruzione;
il modello non ha mai un tool che scrive direttamente una belief canonica —
produce una `MemoryProposal` che una sola riconciliazione applica (accept /
merge / supersede / review / reject). Owner-stated ("ricorda che...") diventa
Evidence immediatamente, ma non bypassa la riconciliazione per diventare
belief canonica. La citazione esplicita di riferimento comparativo cita
numeri reali su Letta (LoCoMo `core_update`: claude-sonnet 83,7 · gpt-4.1 66 ·
o3-mini 16,7 · nano 0,0) e incidenti pubblici di self-editing (`#3388`,
`#1616`, `#3241`, `#3291` — ADR-0032).

**Decisione registrata.** ADR-0004 (forma del grafo) → ADR-0032 (chi scrive,
con il proprio emendamento) → ADR-0051 (forma finale, many-producers-one-writer).

**Conseguenze.** Vecchio: più immediato (il demone scrive e basta), ma il
canale di auto-editing diretto è stato lui stesso a produrre l'unico
meccanismo di memoria ritirato per inefficacia misurata. Nuovo: nessuna
scrittura diretta del modello, quindi la classe di guasto "memory poisoning
via self-write" è dichiarata "non rappresentabile" — al prezzo esplicito,
scritto nello stesso ADR, di **pagare i miss**: "ciò che la pipeline non
estrae non entra, e nessuno se ne accorge nel momento in cui succede".

### 5.2 Livelli derivati (dream cycle, living profile, counterpoint, affect)

**Il vecchio.** Il dream cycle (Fasi A-H, tier-ato su Claude Sonnet quando
`DREAM_MODEL_ENABLED=true`) produceva: Living Profile (sintesi narrativa
~500 parole, `muffin_status.living_profile`), Counterpoint (anti-sycophancy
adversariale ~150 parole, Phase H), Self-narrative (Phase F.5, ADR-067),
Affect signature (EMA valence/arousal, zero LLM) — tutti append-only history
(`src/memory/CLAUDE.md:24-28`).

**Il nuovo.** Nessuno di questi esiste: zero occorrenze di
`counterpoint`/`living_profile`/`self_narrative`/`affect_signature` in
`core/`/`agent/`. `core/memory/maintenance.ts` è l'unico file che nomina
"dream" nel nuovo repo.

**Decisione registrata.** `docs/COGNITIVE-DESIGN.md` §5 "Dreaming as
architecture" — **REJECTED**: "Muffin does not need a dream cycle to remain
Muffin. If a simpler asynchronous consolidator beats it, use the simpler
mechanism" (righe 311-315). La stessa sezione elenca come evidenza negativa
esplicita: "context-blind proactive/heartbeat behaviour", "belief-revision
machinery that consumed work/calls without producing useful revisions" — il
`bot_claims` del vecchio, per nome implicito — e "heuristic deictic and
unknown-term classifiers that created measurable false positives" (§8,
righe 397-405), che nel vecchio repo corrispondono letteralmente a
`utils/deictic.ts` (RIMOSSO ADR-153, "bloccava ~11% di ricerche-memoria
legittime") e alla verify pillar `unknown_terms` (RIMOSSA ADR-151, "F1 0.61,
~50% FP") — entrambe visibili come "RIMOSSO" nel `src/memory/CLAUDE.md`
corrente del vecchio repo stesso, quindi il nuovo cita ritiri già avvenuti nel
vecchio, non li scopre da fuori.

**Conseguenze.** Qui la ragione scritta e l'evidenza del vecchio **si
confermano a vicenda**: il vecchio stesso aveva già ritirato tre dei
meccanismi che il nuovo rifiuta di ricostruire (belief revision, deictic
suppression, unknown-terms), e il nuovo lo registra come prova primaria. Il
Living Profile e il Counterpoint invece **erano vivi** all'ultimo stato del
vecchio repo (non ritirati) — la loro assenza nel nuovo è quindi una vera
scelta di non-ricostruzione di un meccanismo che funzionava, motivata da
principio ("dreaming as architecture" non necessario) più che da un fallimento
osservato specifico su quei due componenti.

### 5.3 Schema: property-graph bitemporale vs triple rigide

**Il vecchio.** L'ultimo stato (WG-2..WG-7, ADR-016/020/025) è già un grafo
entità-centrico a 4-timestamp bi-temporale — non triple rigide. Un vincolo
singleton interno **aveva corrotto 89 credenze in silenzio** prima del fix
(ADR-025 storico, citato dal nuovo in `docs/decisions/0004-memoria-tkg-schema-light.md:3`).

**Il nuovo.** ADR-0004 sceglie esplicitamente la stessa famiglia (TKG
property-graph schema-light bi-temporale) **usando l'incidente del vecchio
come evidenza primaria** contro le triple rigide con vincoli — 8 tabelle
(`core/memory/schema.ts:27-197`) contro le ~20+ del vecchio.

**Decisione registrata.** ADR-0004, che cita direttamente lo storico del
vecchio.

**Conseguenze.** Convergenza, non divergenza: il nuovo eredita la lezione di
uno degli incidenti di dati più gravi del vecchio (89 credenze corrotte) e
parte già dalla forma che il vecchio aveva raggiunto solo dopo quell'incidente
— con uno schema più piccolo (8 vs 20+ tabelle) perché non porta con sé i
livelli derivati del dream cycle (§5.2).

---

## 6. Superfici — quanti canali, quale privilegiato

**Il vecchio.** Telegram unico canale remoto reale (+ Vue Mini App per
webapp/statusline). `gateway.ts` conosceva dettagli specifici di Telegram
(`MAX_TELEGRAM_LENGTH`, footer, stato come stringhe-emoji) fino al refactor
ADR-144 che ha introdotto `TelegramTransport`/`StatusEvent` come confine
tipato. Il layer Telegram (`telegram.ts`) è arrivato a essere un god-file da
2.926 righe, poi rifattorizzato in 11 PR (`docs/decisions` del nuovo repo,
citando `docs/decisions/0025-transport-telegram.md:52`, che legge il codice
del vecchio).

**Il nuovo.** ADR-0021: registro di surface, **tutte connesse
contemporaneamente**, nessuna "il" canale — CLI, Telegram, Discord (quest'ultimo
esplicitamente fuori scope per lo streaming, B17). Una surface di default per
l'outbound proattivo, configurabile parlando con Muffin, con fallback
dichiarato (coda con TTL, mai perso in silenzio) se la surface di destinazione
è irraggiungibile. Ogni job schedulato dichiara il proprio target. Telegram
stesso è raw `fetch` + `@grammyjs/types` come *soli tipi*, non libreria a
runtime (ADR-0025) — la scelta esplicita di evitare Telegraf, di cui il
vecchio aveva già dimostrato in produzione i punti deboli (draft TTL,
chunking sull'HTML renderizzato, offset `getUpdates`) tanto da dover
scavalcare la libreria con raw fetch per le funzioni che contavano davvero.

**Decisione registrata.** ADR-0021, ADR-0025 — entrambi citano esplicitamente
la storia del vecchio come fonte di lezioni verificate (non solo ereditate:
ADR-0025 §revisione 2026-08-17 trova che una di quelle lezioni ereditate
nascondeva un parametro mancante — `draft_id` — mai passato in produzione nel
codice del nuovo fino a quella verifica).

**Conseguenze.** Vecchio: un canale, ottimizzato in profondità (11 PR di
refactor, anni di incidenti reali risolti uno per uno: TTL draft, chunking,
offset). Nuovo: architettura multi-canale fin dall'inizio (più difficile da
implementare, un gateway che deve gestire connessioni multiple con fallimenti
indipendenti), ma eredita il codice del vecchio come casi di test già pagati,
verificandoli invece di fidarsene. Il vecchio non aveva **nessuna** nozione di
"surface di default configurabile" — Telegram era l'unico posto dove qualcosa
di proattivo potesse mai arrivare.

---

## 7. Sensi esterni — calendario, email, GitHub

**Il vecchio.** Tre integrazioni native con OAuth/flow dedicati: Google
Calendar (lettura via iCal privato, **zero OAuth**, poll ogni 30 min,
`src/CLAUDE.md:634`), Gmail (OAuth PKCE, scope `readonly` + `compose` in un
solo grant, comando `/gmail_auth`), GitHub App (installation flow con
allowlist dinamica di repo, comando `/github_repos`). Web search via Tavily
(demon_explorer, ≤2 call/giorno).

**Il nuovo.** Nessuna menzione di calendar/gmail/email in nessun ADR
(`grep` su `docs/decisions/*.md` non trova nulla). Le integrazioni esterne
passano dal meta-tool generico `agent/tools/mcp.ts`: qualunque server MCP
diventa un tool dopo verifica hash, con taint ceiling dichiarato
(`agent/tools/mcp.ts:1-30`) — una generalizzazione che *potrebbe* ospitare un
server MCP calendar/Gmail/GitHub, ma nessuno di questi è integrato, testato o
menzionato come piano.

**Decisione registrata.** Nessuna trovata — né un ADR che scarta le
integrazioni native a favore di MCP generico, né uno che le rimanda.

**Conseguenze.** Il vecchio aveva tre canali reali verso il mondo esterno
dell'owner (agenda, posta, codice) verificati in produzione. Il nuovo ha una
via generica (MCP) che è più facile da estendere in linea di principio — un
server nuovo non richiede scrivere un adapter dedicato — ma **oggi zero di
queste tre capacità specifiche esistono**, e nessun documento dice se sono
rimandate, scartate o semplicemente non ancora prioritizzate.

---

## 8. Gruppi / multi-utente

**Il vecchio.** Sottosistema intero e vivo: `src/group/` — 27 file,
~408KB di codice, hard boundary CI-enforced verso `src/memory/`. Entry point
`gateway_group.ts` (2.935 righe, il file più grande del repo) gestisce testo,
foto (vision multimodale), vocale (trascrizione), documenti — con serializzazione
FIFO per-gruppo, rate limit, trigger filter (@mention o reply, mai vocativo),
mute/leave (`src/group/CLAUDE.md:1-13`). Memoria di gruppo scope-isolata da
quella privata (§I-9).

**Il nuovo.** Community/gruppi cross-connector **deliberatamente differita**.
In v1 solo isolamento (`tenant_id` su ogni riga, `identities` per-connector
con link mai automatico) — le fondamenta strutturali sono già presenti perché
"renderebbero la community un'addizione e non una riscrittura", ma nessuna
funzionalità di gruppo equivalente al vecchio è costruita.

**Decisione registrata.** ADR-0017, esplicita: "differita a post-v1,
fondamenta strutturali subito", motivata da assenza di prior art sul conflitto
host-only-vs-community e dal rischio di merge falso-positivo silenzioso
nell'entity-resolution cross-connector.

**Conseguenze.** Questa non è una regressione silenziosa: è una decisione
scritta, con un segnale esplicito per riattivarla ("M7 stabile per settimane +
un caso d'uso reale, non ipotetico"). Il costo è reale (un anno di lavoro sul
sottosistema gruppi del vecchio non ha equivalente oggi), ma è un costo
dichiarato, non scoperto.

---

## 9. Personalità — identità, voce, profilo dell'owner

**Il vecchio.** Quattro tier separati (ADR-081): `IDENTITY.md` (immutabile),
`SOUL.md`/`VOICE.md`/`HEARTBEAT.md` (persona), `USER.md` (profilo owner,
ex `GIUSTO.md`) — più varianti pubbliche redatte per i gruppi
(`context/public/{SOUL_public,IDENTITY_public,MUFFIN_TECH}.md`). Caricati una
volta al boot nel system prompt (`context_loaders.ts:loadPrivateIdentity`).

**Il nuovo.** Tre file più piccoli: `defaults/persona.md` (133 righe, voce e
carattere — "Non sono uno specchio... sono una seconda prospettiva con
memoria"), `defaults/voice.md` (397 righe), `defaults/rot/identity.md` (143
righe, dentro il Root of Trust — limiti del rapporto, non la voce: "la
memoria non è consenso... una serie di successi può giustificare più
autonomia solo nei confini espliciti che il sistema sa rappresentare e
revocare"). Nessun equivalente separato di `USER.md`: il profilo dell'owner
non vive come file statico ma come stato derivato dalla memoria (§5).

**Decisione registrata.** Nessun ADR dedicato trovato per la struttura dei
file di persona; `COGNITIVE-DESIGN.md` §4 ("Understanding never grants
authority") è il principio che spiega perché `rot/identity.md` — i limiti —
sta nel Root of Trust invece che in un file di persona ordinario.

**Conseguenze.** Il vecchio separava esplicitamente 4 piani con varianti
pubbliche per i gruppi (coerente col suo sottosistema gruppi, §8). Il nuovo,
senza gruppi da servire, consolida a 2-3 file; la separazione voce/limiti
resta ma è più netta nella collocazione (limiti nel RoT, voce fuori) — non
essendoci gruppi non serve una variante redatta pubblica.

---

## 10. Comandi — cosa l'owner può digitare, e da dove

**Il vecchio.** 28 comandi Telegram registrati (19 "daily-menu" visibili + 9
admin nascosti-ma-digitabili, `src/CLAUDE.md:659`): `/think`, `/flags`
(toggle runtime flag senza deploy), `/proposals` (review dream-proposal con
bottoni ✓/✗), `/bias`/`/confab`/`/voice_audit` (metriche measurement-only),
`/health_check`, `/digest`, `/logs`, `/pm2`, `/debug_prompt`,
`/mute_group`/`/unmute_group`/`/leave_group`, `/calendar_connect`/
`/gmail_auth`/`/github_auth`/`/github_repos`, `/update`. Owner-only,
filtrati per `OWNER_USER_ID`.

**Il nuovo.** Un elenco unico e condiviso, `agent/comandi.ts:91-102` — 11
comandi (`new`, `session`, `spend`, `think`, `model`, `debug`, `stop`,
`steer`, `pause`, `resume`, `help`; `exit` è `soloTerminale`). Il modulo
esiste apposta per chiudere una divergenza osservata dall'owner: "il 28/08/2026
l'owner ha acceso Telegram... `/new`, `/session`, `/spend`, `/think`, `/model`
e `/debug` esistevano solo nel terminale" (`agent/comandi.ts:6-13`) — comando
identico per significato, meccanismo diverso dove serve (`/new` chiude una
sessione sul terminale, archivia un file su Telegram).

**Decisione registrata.** Nessun ADR dedicato; la motivazione è nel commento
del modulo stesso, con la direttiva owner citata verbatim.

**Conseguenze.** Il vecchio esponeva molta più superficie operativa dal
telefono (flag runtime, revisione delle proposte del dream cycle, metriche
di bias, log e moderazione gruppi) — quasi tutta amministrazione, non
conversazione. Il nuovo garantisce che i comandi che esistono siano identici
su ogni superficie (nessuna divergenza silenziosa possibile, per costruzione:
un solo file), ma oggi quella superficie è più piccola — in parte perché
funzionalità intere del vecchio (gruppi, OAuth calendario/Gmail/GitHub,
aggiornamento remoto, dream cycle) non hanno ancora un comando da esporre,
non essendoci il meccanismo sotto.

---

## Regressioni

Capacità che il vecchio Muffin aveva e il nuovo non ha, senza una decisione
registrata che le scarti:

1. **Aggiornamento innescabile da remoto** (§2) — il vecchio si aggiornava dal
   telefono via `/update`; il nuovo richiede l'accesso diretto alla macchina
   che esegue il gateway. Nessun ADR discute se il trigger remoto sia
   rimandato o scartato.
2. **Integrazioni native calendario/Gmail/GitHub** (§7) — lettura calendario
   zero-OAuth, comporre email, allowlist repo GitHub erano vive in
   produzione. Oggi esiste solo la via generica MCP, con zero server
   concreto integrato per queste capacità specifiche.
3. **Superficie amministrativa da Telegram** (§10) — runtime flag toggle,
   revisione delle proposte di memoria con bottoni, metriche di bias/confab,
   digest dei log, moderazione gruppi: tutte richiedevano solo il telefono
   nel vecchio, tutte richiedono il terminale (o non esistono) nel nuovo.
4. **Mini App / statusline diary** — endpoint webapp (`GET /statusline/today`)
   con un "diario" generato 4 volte al giorno; nessun equivalente webapp nel
   nuovo repo (nessuna directory `webapp/`, nessun ADR che lo nomini).

## Scartate con ragione

Cose che il nuovo ha rifiutato deliberatamente, con la decisione che lo
dichiara:

1. **Dream cycle come architettura** (§5.2) — `COGNITIVE-DESIGN.md` §5,
   "Muffin does not need a dream cycle to remain Muffin". Il vecchio stesso
   aveva già ritirato tre componenti collegati (belief revision, deictic
   suppression, unknown-terms verify pillar) per inefficacia misurata,
   citati dal nuovo come evidenza primaria — la ragione scritta è confermata
   dall'evidenza del vecchio per questi tre; per Living Profile e
   Counterpoint (mai ritirati dal vecchio) è una scelta di principio, non la
   ripetizione di un fallimento osservato su quei due meccanismi specifici.
2. **Proattività a cadenza / "ho notato X"** (§3) — ADR-0028 + 
   `COGNITIVE-DESIGN.md` H5, con il vecchio Muffin nominato esplicitamente
   come "evidence against naive heartbeat-style proactivity".
3. **Community/gruppi cross-connector in v1** (§8) — ADR-0017, differita con
   segnale di riattivazione esplicito, non scartata in assoluto.
4. **Memoria auto-editata direttamente dal modello** (§5.1) — ADR-0032/0051,
   con l'unico precedente diretto del vecchio (`bot_claims`) già ritirato
   autonomamente prima che il nuovo repo esistesse.
5. **Triple rigide con vincoli di coerenza per la memoria** (§5.3) —
   ADR-0004, che usa l'incidente reale del vecchio (89 credenze corrotte in
   silenzio da un vincolo singleton) come prova diretta.
6. **Telegraf/libreria a runtime per Telegram** (§6) — ADR-0025, per
   abbandono upstream della libreria, non per un difetto del vecchio design
   (che anzi viene riletto e riusato come casistica di test).

## Domande poste senza reperto

1. Il nuovo repo non ha mai discusso se le integrazioni calendario/Gmail/
   GitHub del vecchio vadano riprodotte via un server MCP dedicato, rimandate
   con un segnale esplicito, o considerate fuori scope in modo permanente.
2. Non esiste una decisione scritta sul se/quando l'aggiornamento remoto
   (equivalente al vecchio `/update` da Telegram) sia una capability voluta o
   deliberatamente esclusa per il modello di sicurezza "gira come owner,
   senza elevazione" di ADR-0035.
3. Il vecchio registrava esplicitamente un fallimento del proprio ciclo di
   belief-revision (`bot_claims`, "ZERO revisioni effettive"): non risulta
   una discussione nel nuovo repo su cosa, se qualcosa, sostituisca la
   funzione che quel meccanismo tentava di svolgere (correggere una credenza
   quando l'owner la contraddice esplicitamente) oltre alla riconciliazione
   generica di ADR-0051.
