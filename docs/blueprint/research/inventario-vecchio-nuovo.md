# Vecchio contro nuovo — l'inventario, riga per riga

**Data**: 2026-08-11 · **Domanda dell'owner**: *"il vecchio muffin aveva TANTE cose,
purtroppo TROPPE, e SLOP — ma sicuramente aveva ALCUNE cose interessanti. Non
voglio usare un muffin peggiore o indietro rispetto all'altro."* · **Metodo**:
enumerazione della superficie che l'owner tocca, su entrambi i repo, ogni riga
ancorata a un `file:riga`; poi il verdetto. Costruito **sopra**
`a1-inventario-codebase.md`, non al suo posto.

**Ancoraggi.** Vecchio: `~/dev/Muffin` @ `09e02db` (2026-07-19, ultimo commit di
codice; working tree pulito a parte 4 probe non tracciate). Nuovo: questo
worktree @ `aa68233` (2026-08-11), branch `slice/rot-letto`. I conteggi di dati
vengono da due DB letti in sola lettura, **solo aggregati, mai contenuto**:
`~/dev/Muffin/muffin.dev.db` (copia di produzione, mtime 2026-07-19) e
`~/.muffin/muffin.db` (2026-08-11).

**La risposta corta.** Il vecchio non è avanti per *quantità di meccanismi* — su
47 tool nel registro **16 non sono mai stati invocati una volta** in quattro mesi
di uso vero, e lo skill layer da 3.052 righe ha prodotto **1 uso**. È avanti su
**tre cose sole**, e sono tre cose che si sentono ogni giorno: la memoria si
riempiva da sé, parlava con i servizi dell'owner (mail, calendario, GitHub), e
sentiva le note vocali. Tutto il resto o c'è già nel nuovo, o è stato tagliato con
una decisione scritta, o non andava.

---

## 0. Cosa i nostri documenti sbagliano — e non è a1

Prima di tutto, perché è la parte che vale. Il mandato chiedeva di dire dove
`a1-inventario-codebase.md` è stantio. La risposta onesta è: **non lo è** — il
documento sbagliato è un altro, ed è più recente e più operativo.

**a1 è ancora esatto dove conta, e questo è di per sé un dato.** Ri-misurato oggi:
LOC per sottosistema **identici riga per riga** (`src/memory/` 40.867,
`src/cognition/` 21.943, `src/tools/` 21.374, …), 150 ADR in `docs/DECISIONS.md`,
registro tool **47** (STABLE 15 + FLAT 31 + OUTWARD 1, ricontato con un parser sui
letterali a `src/tools/index.ts:547`, `:714`, `:1033`), 28 comandi Telegram. Il
vecchio repo non si è mosso dal 2026-07-19. **a1 non va rifatto.**

Ma a1 è un inventario del **codice**, non dell'**uso** — e §9 lo dichiara
espressamente: *"Nessuna query diretta al DB è stata eseguita per questo
inventario (divieto esplicito del mandato)."* È esattamente il buco che questa
ricerca chiude, ed è dove sta quasi tutto il valore: senza i numeri d'uso, "il
vecchio aveva 47 tool" e "il nuovo ne ha 10" sembra una regressione di 37.

### La correzione che cambia cosa costruire

`04-roadmap.md` §M5-bis, punto 1, scrive:

> *"la memoria **non si riempie da sola** … È anche la regressione più netta
> rispetto al vecchio, che il ciclo dream ce l'aveva."*

**La prima metà è vera, la seconda è sbagliata — e la parte sbagliata cambia il
rimedio.** Il vecchio Muffin **non** riempiva la memoria di notte. La riempiva
**a ogni turno**, in modo asincrono, su una corsia dedicata:

| passo | file:riga |
|---|---|
| il gateway risponde e accoda | `src/gateway.ts:2732` — `enqueueWork(chatId, "user_message", …)` |
| l'INSERT nella coda | `src/memory/memory_work_queue.ts:78` |
| il thinker preleva | `src/thinker.ts:581` — `claimNextWork` |
| esegue | `src/reactor.ts:904` — `processWorkItem` → `:976` `processLearnings` |
| estrae con l'LLM leggero | `src/memory/memory_learning.ts:697` |
| scrive il fatto | `src/memory/memory_semantic.ts:196` — `saveFact` (+ embedding, `facts_vec`, `facts_fts`, fan-out entità a `:263`) |

Il commento che dichiara il disegno sta a `src/gateway.ts:2725-2729`: *"Gateway
answers — thinker thinks."* Il ciclo dream faceva **manutenzione sopra** (dedup,
decay, pattern, grafo, profilo), non il primo riempimento: `work_queue` conta
**2.438 righe** contro **100 dream report**.

Conseguenza operativa: costruire solo un job notturno riprodurrebbe un Muffin che
sa di te con **fino a 24 ore di ritardo** — cioè un Muffin che nella stessa
conversazione in cui gli hai detto una cosa non ce l'ha ancora. Serve la corsia
di scrittura (evento → coda → estrazione, minuti), **e poi** la passata notturna
per ciò che la corsia non può fare (dedup globale, decay, pattern su finestra
lunga). Sono due meccanismi, non uno.

### Tre imprecisioni minori, per il registro

- `src/telegram/commands/registry.ts:4` dichiara *"all **26** bot commands"* e
  `src/telegram.ts:2754` dichiara *"Admin commands (**8**, hidden from menu)"*.
  Entrambi stantii: sono **28** (19 daily + 9 admin), e il test lo asserisce
  (`src/telegram/commands/__tests__/registry.test.ts:161`,
  `expect(COMMANDS).toHaveLength(28)`). a1 riportava 28: a1 ha ragione, il codice
  si commenta male.
- a1 §2.8 presenta `muffind` come un binario-demone. Non lo è: è un listener su
  Unix-domain-socket **dentro il processo bot già esistente**
  (`src/index.ts:70,134,174`; socket a `src/daemon/ipc_server.ts:184-188`).
- a1 §1.8 non lo dice, ma il numero interessante non è 47: è **31** — quanti tool
  del registro attuale sono stati invocati almeno una volta (§4).

---

## 1. I numeri che rispondono alla domanda

| | vecchio (@`09e02db`) | nuovo (@`aa68233`) |
|---|---|---|
| LOC TypeScript non-test | **101.914** (`src/`) | **15.944** (`agent cli core connectors evals`) |
| LOC di test | ~91.000 | 9.720 |
| file di test | 381 | 61 |
| tabelle SQL | 77 + 10 virtual | **11 + 2 virtual** (contate nel DB dell'owner; `send_lock` nasce al primo invio → 12) |
| tool esposti al modello | 47 nel registro, ~15-22 per turno | **10** + `mcp_*` dinamici |
| comandi Telegram | **28** | **0** |
| slash nel REPL | **1** (`/exit`) | **5** |
| comandi CLI | 4 (`install`, `run`, `install adapter`, REPL) | **14 famiglie, 29 verbi** |
| ADR | 150 | 34 |

E i numeri che contano davvero — **cosa c'è dentro**:

| | vecchio (prod, 2026-07-19) | nuovo (`~/.muffin`, 2026-08-11) |
|---|---|---|
| episodi | **4.107** (dal 2026-03-16 al 2026-07-18) | **6** |
| fatti | **414** | **0** |
| entità | 320 | **0** |
| osservazioni · pattern · narrative | 504 · 160 · 239 | — (nessun piano equivalente popolato) |
| artefatti nel vault | 25 | 0 |
| job schedulati | 8 | **0** |
| consegne proattive | **228** (~1,9/giorno) | 0 |
| task di fondo eseguiti | 59 | — |

**414 contro 0 è la riga da cui parte tutto il resto di questo documento.** Non è
un difetto di ambizione: è `ingestPending` con un solo chiamante manuale
(`cli/memory.ts:171`), su una macchina dove gli episodi si scrivono da soli
(`agent/loop.ts:243` e `:478`) e nessuno li trasforma mai in fatti.

---

## 2. Superficie di comando — i 28 comandi Telegram

Tutti e 28 sono **owner-in-DM-privata**: ogni handler apre con
`if (!isOwnerPrivateChat(ctx, chatId)) return;` (`src/utils/access.ts:3-6`), e lo
scope gruppo è azzerato via `setMyCommands([], …)` a `src/telegram.ts:2826`.
Registro unico: `COMMANDS` a `src/telegram.ts:2761-2793`.

| comando | cosa faceva | equivalente nel nuovo | verdetto |
|---|---|---|---|
| `/version` | SHA + branch + build | `muffin --version` (`cli/main.ts:142`) | **PRESENTE** |
| `/health_check` | snapshot salute pipeline | `muffin doctor` (`cli/doctor.ts`, 11 check) | **PRESENTE** |
| `/logs [errors\|memory\|tools\|calls]` | ultimi `agent_logs`, filtrati | `muffin trace tail [--errors] \| grep` (`cli/main.ts:472`) | **PRESENTE** |
| `/digest [1h\|6h\|24h]` | digest read-only degli `agent_logs` | `muffin trace tail -n` (span, non digest) | **PRESENTE** (forma diversa) |
| `/heartbeat` | ultime valutazioni proattive | `muffin observe` (`cli/observe.ts:34`) — mostra il cancello e cosa ne farebbe | **PRESENTE** (più esplicito: il vecchio referta, il nuovo fa vedere la decisione) |
| `/reminders` | promemoria in coda | `muffin jobs list` (`cli/jobs.ts`) | **PRESENTE** |
| `/run_pattern_job` | estrazione pattern a mano | `muffin memory extract` (`cli/main.ts:334`) | **PRESENTE** — ed è il problema, non la soluzione (§0) |
| `/memoria` | sintesi in linguaggio naturale di ciò che sa di te | `muffin memory stats\|search` — dati, non sintesi. La sintesi sarebbe `profiles`, tabella **senza scrittori** | **PRESENTE parziale** |
| `/debug_memory` | dump memoria come allegato | `muffin memory stats \| check` | **PRESENTE** |
| `/stato` | stati attivi con scadenza | non c'è un piano `state_entries`; la semantica è rappresentabile come fatto con `valid_to` (`core/memory/schema.ts:99-100`) | **PRESENTE** come proprietà, non come tabella — coerente con `knowledge/README.md` ("principio→primitiva, non modulo") |
| `/think on\|off` | thinking per-chat | il nuovo lo mette nel **profilo per-modello** (`agent/profiles/*.json`), che è il posto giusto — ma **il loop non lo passa mai** (`agent/providers/anthropic.ts:50` è pronto e non chiamato) | **MANCA, NON SERVE** come comando · il cablaggio è un difetto a sé (M5-bis punto 2) |
| `/footer on\|off` | footer costo/token/tempo per messaggio, default OFF | `/spend` nel REPL (mese) + `muffin trace` (per span) | **MANCA, NON SERVE** — *tagliato senza decisione scritta*, ma coperto |
| `/flags` | flip a caldo di 7 flag runtime | il nuovo **non ha feature flag** (zero occorrenze in `agent core cli connectors`) | **MANCA, NON SERVE** — conseguenza strutturale di ADR-0011/0003 (le manopole stanno in config e nel RoT), non una dimenticanza |
| `/pm2 [N]` | log del process manager | nessun deploy equivalente | **MANCA, NON SERVE** |
| `/bias` | tasso di accordo 7/30gg (anti-eco) | — | **MANCA, NON SERVE** — *tagliato senza decisione scritta* |
| `/confab` | tasso di confabulazione 7/30gg | — | **MANCA, NON SERVE** — *idem*. Nota: il flag `HONESTY_STRIP_ENABLED` che ci stava sopra fu **ucciso** nel vecchio (gate >5% mai raggiunto, misurato ~1%) |
| `/voice_audit [7d\|30d]` | metriche di voce + delta | `evals/voice/drift.ts` misura la voce, ma **sul DB vecchio**: è uno strumento di migrazione, non un audit continuo | **MANCA, NON SERVE** per il Gate 1 · ma è il pezzo che serve a M6 (cricchetto su `voice.md`) |
| `/proposals` | proposte del dream con Applica/Rifiuta | — | **MANCA, NON SERVE** — differito con decisione scritta: `04-roadmap.md` §M6 ("ratchet API: proposta versionata → eval gate → canary → undo") |
| `/skills` | candidati skill Approva/Rifiuta | il runtime SKILL.md c'è (`core/skills/`, tool `skill_read`); l'**autodraft** no | **ERA SLOP** — in 4 mesi: 3 candidati, **1 uso** (`skill_usage`), su 3.052 righe di `src/skills/` |
| `/debug_prompt` | traccia verbosa del prompt del turno successivo | gli span **non portano il contenuto** (`core/tracing/types.ts:46-70`: nessun attributo prompt/messaggio) | **MANCA, SERVE** (basso) — "perché hai risposto così" è una promessa di V7/M6 |
| `/update` | self-update systemd (git pull + build + restart) | `install.sh`; nessun aggiornamento in-place | **MANCA, SERVE** (basso, ma diventa alto il giorno del cutover) |
| `/mute_group` · `/unmute_group` · `/leave_group` | amministrazione gruppi | — | **MANCA, NON SERVE** — i gruppi sono M7 e sono **esplicitamente esclusi dal Gate 1** (`04-roadmap.md`: *"senza tornare al vecchio per qualcosa che non siano i gruppi"*) |
| `/github_repos [list\|add\|remove]` | allowlist repo GitHub | — | **MANCA** → dipende dal connettore, §5 |
| `/calendar_connect` · `/gmail_auth` · `/github_auth` | i tre OAuth | — | **MANCA, SERVE** (alto) → §5 |

**Il nuovo non ha nessun comando dentro Telegram.** Nessun `setMyCommands`,
nessun routing di `/`: verificato per assenza in `connectors/telegram/`. Tutto è
conversazionale, e gli operator-verb stanno sulla CLI. È coerente con ADR-0021
(le surface sono un registro, non processi) — ma va detto che **cambia dove
l'owner mette le mani**: dal telefono, nel nuovo, non c'è nessuna manopola.

---

## 3. CLI e REPL — dove il nuovo è già più avanti

| cosa | vecchio | nuovo | verdetto |
|---|---|---|---|
| entry point | `muffin` → `dist/cli/install.js`, dispatch a mano (`src/cli/install.ts:1109-1166`) | `muffin` → REPL + ogni surface abilitata nello stesso processo (`cli/main.ts:131`, `cli/repl.ts:42`) | **PRESENTE**, meglio |
| goal headless | `muffin run "<goal>"` (`src/cli/run.ts:513`) | `muffin run "<goal>" [--json] [--session] [--timeout]`, exit code che significa qualcosa (`cli/main.ts:514`) | **PRESENTE**, meglio |
| REPL | Ink/React, **un solo slash**: `/exit` (`src/cli/repl.tsx:486`) | readline, **5 slash** (`/exit /help /new /session /spend`, `cli/repl.ts:18`), Ctrl+C annulla il turno | **PRESENTE**, meglio |
| onboarding | `muffin install`, 10 step + loop conversazionale HITL (max 7 domande, `src/cli/install.ts:429-576`) | `muffin init` + first-run interattivo (ADR-0029); **nessun onboarding conversazionale** | **MANCA, SERVE** (medio) → §6 |
| ispezione memoria | nessun verbo CLI (solo Telegram/webapp) | `muffin memory why\|search\|extract\|stats\|check` | **solo nuovo** |
| vault | nessun verbo CLI | `muffin vault reindex\|add\|ls\|check` | **solo nuovo** |
| tracce | webapp | `muffin trace tail\|grep` | **PRESENTE** |
| job | `scheduled_jobs`, nessun verbo | `muffin jobs list\|add --cron\|remove` | **solo nuovo** |
| MCP | un solo server cablato a mano (GitHub) | `muffin mcp add\|list --verify\|remove` con pinning sha256 e sospensione al rug-pull | **solo nuovo** |
| surface | `muffin install adapter telegram` | `muffin surface list\|enable\|disable` | **PRESENTE**, meglio |
| integrità | — | `muffin rot verify\|reseal`, `muffin doctor` | **solo nuovo** |
| daemon IPC | `muffind` (UDS nel processo bot), flag OFF di default | non esiste; un solo processo per ADR-0022 | **MANCA, NON SERVE** — deciso (ADR-0022) |

---

## 4. Tool — dove sta il "TROPPE cose", con i numeri

Registro vecchio: **47**. Invocazioni reali in ~4 mesi
(`agent_logs WHERE action='tool_use'`, 1.104 chiamate totali su 2.323 risposte —
circa **una chiamata ogni due risposte**):

Sono **53 nomi distinti** mai invocati almeno una volta (include nomi storici poi
rimossi, come `list_artifacts` o `manage_memory`, prima del collasso 12→1 del
vault):

| fascia | quanti | esempi |
|---|---|---|
| **portanti** (≥50 chiamate) | **8** | `web_search` 201 · `github` 191 · `memory_knowledge` 101 · `confirm_actions` 70 · `memory_stories` 69 · `task_manager` 53 · `memory_tracking` 52 · `fetch_url` 50 |
| **usati** (5-49) | **19** | `muffin_ops` 44 · `manage_memory` 26 · `sqlite_query` 21 · `search_emails` 17 · `draft_calendar_event` 14 · `set_sleep` 12 · `send_artifact` 12 · `draft_email` 12 · `bash` 10 · `create_task` 9 · `fs` 6 · `mark_email_read` 5 |
| **coda lunga** (1-4) | **26** | `set_preference` 3 · `recall_from_group` 3 · `read_artifact` 2 · `send_email_draft` 1 · `create_pr` 1 · `check_self_health` 1 · `get_last_dream_report` 1 |
| **MAI invocati** | **16 dei 47** | `get_self_narrative` · `fact_provenance` · `find_tools` · `check_task` · `search_messages` · `set_dnd` · `list_observations` · `drop_observation` · `list_questions` · `drop_question` · `archive_url` · `undo_action` · `archive_email` · `scholarly_search` · `send_message` · `echo_outward` |

Ristretto al **solo registro attuale da 47** (togliendo i nomi storici): 31
invocati almeno una volta, di cui **6 sopra le 50 chiamate, 13 fra 5 e 49, 12
sotto le 5**. Sommando i 16 mai chiamati: **28 tool su 47 sono stati usati meno
di cinque volte in quattro mesi.** Sei hanno fatto il lavoro.

Due caveat onesti: `find_tools` (2026-07-08) e `fact_provenance` (ADR-124) sono
recenti — la finestra è di giorni, non di mesi. E `undo_log` ha **0 righe**: il
tier-2 "act-notify-undo" (ADR-159), acceso di default, non ha mai prodotto un
solo revert.

Nuovo: **10 tool** + `mcp_*` dinamici — `fs_read`, `fs_list`, `fs_write`
(`agent/tools/fs.ts:61`), `memory_search` (`memory.ts:32`), `shell_run`
(`shell.ts:42`), `process_list`, `process_kill` (`process.ts:42,55`),
`skill_read` (`skill.ts:32`), `http_get` (`http.ts:40`), `web_search`
(`search.ts:59`).

| capability | verdetto |
|---|---|
| ricerca web · fetch URL · shell · filesystem · SQL sulla propria memoria | **PRESENTE** (i cinque portanti, tranne `sqlite_query` che diventa `memory_search`) |
| meta-tool memoria (`memory_knowledge/tracking/stories`, 222 chiamate) | **PRESENTE** come `memory_search` + i verbi CLI |
| `confirm_actions` (70 chiamate) | **PRESENTE** come effetto del kernel (`ask` → domanda nel REPL, `cli/repl.ts:67`), non come tool: è meglio — non è il modello a decidere di chiedere |
| `create_task` / `task_manager` / `list_tasks` / `check_task` (66 chiamate) | **MANCA, SERVE** (medio) — non c'è delega né sub-agent. Deciso e **rinviato con grilletto scritto**: `adr/0033-delega-rinviata-con-il-grilletto-scritto.md` |
| `undo_action` + tier-2 undo | **ERA SLOP** — 0 righe in `undo_log` in 4 mesi. Il nuovo ha l'effetto `draft` nel kernel (`core/policy/decide.ts:197`) e il loop **rifiuta onestamente** finché il registro non esiste (`agent/loop.ts:656-662`) |
| `scholarly_search` (arXiv/PubMed/OpenAlex) | **ERA SLOP** — mai invocato |
| `send_message` (step bubble) | **ERA SLOP** — mai invocato, flag mai acceso |
| `echo_outward` | **ERA SLOP** — tool finto per esercitare l'outbox |
| `deep_research` / `deep_repo_analysis` | 7 e 1 chiamate storiche. **MANCA, NON SERVE** ora — è il grilletto di ADR-0033 |
| `find_tools` | **MANCA, NON SERVE** — con 10 tool il problema che risolveva non esiste (`confronto-harness.md` §7: *"a 10 no, a 59 no; il trigger è il primo server MCP >100 tool"*) |

---

## 5. Connettori — qui il vecchio è avanti, e si sente

| servizio | vecchio | nuovo | verdetto |
|---|---|---|---|
| Telegram | `src/telegram.ts` (129 KB) + transport tipato | `connectors/telegram/` (1.173 righe), inbox durevole, pairing, media | **PRESENTE**, più pulito |
| modello (OpenRouter / Anthropic / Ollama) | `src/llm.ts:400,424`; local-first con probe del tag esatto | `agent/providers/{openai-compat,anthropic}.ts` | **PRESENTE** — il nuovo perde il **local-first automatico**, ma il vecchio aveva 0/1689 turni locali tracciati (`01-verdetti.md` V2): era un'etichetta |
| Tavily (web search) | `src/tools/search.ts:112` | `agent/tools/search.ts:116` | **PRESENTE** |
| fetch web | `src/tools/fetchUrl.ts` (Readability + SSRF guard) | `agent/tools/http.ts` (GET, egress allowlist, SSRF su ogni hop) | **PRESENTE**, più stretto |
| **Google Calendar** (REST v3 + iCal) | `src/outward/google_calendar_rest.ts`, `src/adapters/calendar.ts:14`; OAuth cifrato in `agent_state` | — | **MANCA, SERVE** |
| **Gmail** (leggi · cerca · bozza · invia · archivia) | `src/tools/gmailRead.ts`, `gmailModify.ts`; scrittura via outbox (`src/outward/adapters/gmail_*.ts`) | — | **MANCA, SERVE** |
| **CalDAV** | `src/outward/caldav_client.ts`, credenziali AES-256-GCM in `agent_state` | — | **MANCA, NON SERVE** — ridondante con Calendar; una sola strada basta |
| **GitHub** (MCP, 41 sub-tool + App auth + webhook) | `src/tools/github-mcp.ts`, `src/outward/github_app_auth.ts` | il **client MCP generico** c'è (`core/mcp/`, `muffin mcp add`) — il server GitHub va solo allowlistato | **PRESENTE come strada**, non come collegamento: 191 chiamate storiche, zero oggi |
| **trascrizione vocale** (faster-whisper locale) | `src/transcription.ts:33-50`, `bot.on("voice")` a `src/telegram.ts:513` | i vocali arrivano nel vault come file (`connectors/telegram/media.ts:60`), **non trascritti** | **MANCA, SERVE** |
| foto / album / PDF / DOCX in ingresso | `src/utils/image.ts:4`, `src/utils/document_parsing.ts:14-15,103` | media → `vault/inbox/`, indicizzati **prima** del turno, col tier del mittente | **PRESENTE parziale** — il file entra, il *contenuto* di PDF/DOCX no (nessun parser) |
| documenti / immagini in uscita | `replyWithDocument`, `sendPhoto` con fallback (`src/tools/sendArtifact.ts:100`) | `sendDocument` con un test e il chiamante dichiarato differito | **MANCA, SERVE** (basso) |
| TTS / risposta vocale | **assente anche nel vecchio** | assente | — |
| MCP generico | solo GitHub, cablato a mano | allowlist + pinning sha256 + sospensione al drift + `mcp list --verify` | **solo nuovo** |
| **`outward_gate`** (il modello non manda mai: emette bozza → outbox → conferma → grace worker) | `src/outward/outward_gate.ts:1-31`, `grace_worker.ts` | `outward.send` è **vietato al principal di sistema** (`defaults/rot/policy.json`), ma non esiste nessun adapter | **MANCA, SERVE** (medio) — il disegno c'è, il registro staged-pending è già nella lista di `confronto-harness.md` §9 punto 4 |

---

## 6. Memoria e cicli di fondo — il cuore della domanda

### Cosa faceva il vecchio, di notte e di giorno

**Di giorno, a ogni turno** (§0): episodio → coda → estrazione fatti → entità →
pledge → narrativa → demoni observer/connector. Latenza: minuti.

**Di notte, una volta** — `runDreamCycle` a `src/memory/memory_dream.ts:2066`,
innescato da `runDreamIfReady` (`src/dreamer.ts:114`) sul tick lento da 30 minuti
del thinker. Gate: ≥18h dall'ultimo, dentro la finestra circadiana di sonno
(fallback 22-08 Roma), forzato a ≥24h. Cap duro 12 minuti; durata misurata
67-362s, media ~230s (`src/dreamer.ts:36-37`).

| fase | cosa faceva | LLM | verdetto per il nuovo |
|---|---|---|---|
| **A0** salute | health pipeline + drift di postura + digest telemetria → `pending_actions` | no | **PRESENTE** come `muffin doctor` (a richiesta, non notturno) |
| **A** manutenzione | stati scaduti, intenzioni stantie, **dedup fatti** | `callLight` solo sulle coppie ambigue | **MANCA, SERVE** — il nuovo ha il giudice di contraddizione (`core/memory/judge.ts`) ma nessuno lo fa girare in batch |
| **B** pattern → proposte | qualità, near-duplicate narrative, task ricorrenti | `callLight` | **MANCA, NON SERVE** (M6) |
| **C** commit | **l'unico commit atomico** delle scritture accumulate | no | n/a (il nuovo scrive per transazione) |
| **D** il grosso | estrazione pattern → `patterns` + `pending_notifications`; osservazioni scadute; **ri-taratura dei pesi**; soglie adattive dagli ultimi 30 report; manutenzione grafo (decay archi, connessioni cross-cluster); sweep entità; profilo circadiano | `callLight` | **MANCA, SERVE** in parte — *decay* e *grafo* sì (§sotto), *pattern* no |
| **D.5** stale | `facts.stale_since` a 60gg (90 per importanza alta) | no | **MANCA, SERVE** — il nuovo **non ha decay** (`knowledge/01-understanding.md`: *"non esiste decay, quindi non esiste ancora 'esente dal decay'"*) |
| **D.6** reward | ricompensa conversazionale sulle consegne proattive | no | **MANCA, NON SERVE** |
| **E** | **commento morto** — nessun codice (`memory_dream.ts:2446`) | — | — |
| **F** living profile | sintesi narrativa ~500 parole → `muffin_status` + `living_profile_history` | `callDreamTier` (Sonnet) | **MANCA, SERVE** — nel nuovo la tabella `profiles` esiste (`core/memory/schema.ts:130`) e **non ha né scrittori né lettori** |
| **H** counterpoint | ~150 parole avversariali anti-piaggeria | `callDreamTier`, con riuso della cache di F | **MANCA, SERVE** (medio) — è la sola difesa anti-sycophancy che il vecchio abbia tenuto dopo aver ucciso belief revision |
| **F.5** self-narrative | ~300-450 token, gate ≥3 correzioni / ≥7gg / ≥10 esiti | `callDreamTier` | **MANCA, NON SERVE** (M6) |
| **G** messaggio del mattino | `dream_reports`; **non spedito** — iniettato nel turno successivo (`src/gateway.ts:2105`) | `callMain` | **MANCA, NON SERVE** — pull-based, e il nuovo ha `muffin jobs` per un brief vero |
| **i17** baseline | ricalcolo baseline pipeline | no | **MANCA, NON SERVE** |
| **I** world graph | alias-merge → `dream_proposals`; rigenerazione summary; ricalcolo importanza; consolidamento predicati; **I.6 silenzio** | `callLight` + `callMain` | **I.6 → PRESENTE e migliore**: `core/memory/absence.ts` sostituisce la soglia "media×3" (che è un test al 16%, non al 5%) con **alpha esatto**. Il resto: consolidamento predicati è **PRESENTE** come invariante (`core/memory/invariants.ts:36`), gli alias no |
| **J** skill autodraft | sequenze ripetute → `skill_candidates` | no | **ERA SLOP** — 3 candidati, 1 uso |
| **K** self-minter | conia un task autonomo | `callLight` | **MANCA, NON SERVE** — era `SELF_MINTER_ENABLED`, spento |

**Demoni.** Registrati: tre (`src/demons/daemon_manager.ts:14-18`) — connector
(archi da coseno, zero LLM), observer (valenza/arousal + osservazioni,
`callLight`), temporal (statistiche, zero LLM). Explorer e introspection **non
sono registrati**: girano da cron (`src/scheduler.ts:370` e `:452`). Verdetto
collettivo: **MANCA, NON SERVE** — `01-verdetti.md` V11 lo dice esplicito:
*"L'event-bus a soglia (pattern Odysseus) sostituisce i demoni cablati."*
L'unico contenuto vivo (silenzio, affect) è già mappato su primitive in
`knowledge/03-observing-spine.md`.

**Scheduler.** Vecchio: tre corsie in un `while` (`src/thinker.ts:504`), poll 3s
idle / 200ms busy, tick lento 30 min, 5 cron interni
(`daily_morning`, `daily_evening`, `weekly_reflection`, `group_rollup`,
`daily_outfit` — `src/scheduler.ts:229`). Nuovo: `Scheduler` con tick 30s nel
processo del REPL (`cli/repl.ts:123`), gate foreground, job store durevole con
cron-parser. **PRESENTE**, e più onesto (l'heartbeat non dipende dal ritorno del
loop — bug Hermes #25517). Ma: **0 job** nel DB dell'owner, e la consegna remota
non è cablata (`cli/repl.ts:115`).

**Proattività.** Vecchio: 228 consegne in 4 mesi, più 19 `belief_asks` — **una al
giorno per 19 giorni su 20**, e nessuna è mai uscita dallo stato `asked` perché
niente scriveva `answered`/`ignored` (`knowledge/05-person-model.md`). È
letteralmente il firehose che l'owner ha respinto. Nuovo: `decideProactive`
(`core/scheduler/proactivity.ts:94`) con insieme **chiuso** di trigger — il
firehose è **incostruibile**, non scoraggiato — più il fire-log come latch
(`core/scheduler/firelog.ts`) e `muffin observe` che **nasce spento**.
**PRESENTE e strutturalmente meglio.** Mancano i detector che lo armano
(`deadline_near`, `commitment_due`).

**Pledge / impegni verso terzi.** Vecchio: `src/pledge_pipeline.ts` +
`pledge_nudge.ts`, cablati end-to-end e **spenti** (`PLEDGE_NUDGE_ENABLED=false`,
`src/flags.ts:165`). Verdetto: **MANCA, SERVE** (medio) — è il caso d'uso #4 di
`12-casi-uso-primitive.md`, il `kind` `commitment_due` è già nell'insieme chiuso,
e il costo di disegno è già stato pagato una volta.

### Il resto della memoria

| meccanismo | vecchio | nuovo | verdetto |
|---|---|---|---|
| retrieval ibrido FTS5 + vec + RRF | sì (`db/helpers.ts:reciprocalRankFusion`) | sì (`core/memory/recall.ts`, RRF k=60 + espansione grafo) | **PRESENTE** |
| reranking | valutato e **rifiutato** (ADR-094: 6-12s sul VPS) | `core/memory/rerank.ts` (LLM sulla corsia leggera) | **solo nuovo** |
| provenienza detto/dedotto | `source` sui fatti | `facts.origin` said/inferred/imported + `trust_tier` + taint | **PRESENTE**, più forte |
| bi-temporale | dichiarato, mai invocato (auto-audit in `THESIS.md:104-113`) | `valid_from/valid_to` + `recorded_at/expired_at`, mai DELETE | **PRESENTE**, e stavolta vero |
| importanza ≠ frequenza | pesi ri-tarati di notte (fase D) | `facts.importance` ordinale 0/1/2, forced-choice, **fuori da RRF** | **PRESENTE**, meglio argomentato |
| decay / recency | due formule, decay su **last-access** | solo ordinamento per recency, **nessun decay** | **MANCA, SERVE** (medio) |
| compattazione conversazione | sintesi narrativa oltre 60 messaggi + keep-last-25 (`memory_compression.ts`) | troncamento secco a 40 turni (`agent/loop.ts:62`); `digests` esiste **senza scrittori** | **MANCA, SERVE** (basso-medio) |
| vault / knowledge artifacts | `~/muffin-knowledge/` + indice ricostruibile, 25 artefatti | `core/vault/`, chunking strutturale (ADR-0024), `muffin vault check` confronta disco e indice | **PRESENTE**, meglio |
| onboarding che impara | loop conversazionale HITL, max 7 domande, ordine progettato (`src/cli/install.ts:429-576`) | `defaults/persona.md` §"Al primo incontro" — un'istruzione nel prompt, non un meccanismo | **MANCA, SERVE** (medio) — e `knowledge/05-person-model.md` avverte che nemmeno il vecchio chiudeva l'anello (leggere la risposta) |

---

## 7. Interfacce e gruppi

| cosa | vecchio | nuovo | verdetto |
|---|---|---|---|
| **webapp / Mini App** — Cockpit (7 organi) + Registro (6 sub-tab), ~30 endpoint, SQL runner read-only | `src/webapp/server.ts` (3.528 righe, il file più grande del repo) | — | **MANCA, NON SERVE** — nessuna dashboard è nel perimetro v1 (`04-roadmap.md` §3: MCP Apps e UI fuori da v1). Nota di contesto: S7 archeologia individua **lì** i due bug più longevi del repo (981 e 927 commit) |
| statusline (endpoint a token) | `src/webapp/server.ts:527` | — | **MANCA, NON SERVE** |
| replay harness (`npm run replay`, checkpoint 0/1/2) | `src/replay/` (4.309 righe) | `evals/` (floor, memory acceptance, system, voice) | **PRESENTE** in forma diversa |
| **gruppi** — 5 attivi, 688 turni nella finestra TTL, isolamento §I-9 CI-enforced | `src/group/` (19.100 righe) | il connettore mappa un gruppo a **tenant proprio** (`connectors/telegram/connector.ts:155`), il prompt e i tool sono per-tenant (`agent/context/assemble.ts`), ma M7 non è costruito | **MANCA, NON SERVE** per il Gate 1 — escluso per decisione owner scritta |
| sanitizer di voce (emoji, piaggeria in apertura, streaming hold-back) | `src/voice/sanitizer.ts:1-30` | `defaults/voice.md` nel prompt; nessun post-process deterministico | **MANCA, NON SERVE** — il vecchio aveva bisogno del sanitizer perché il modello era Gemma; con `voice.md` e un modello frontier è un'ipotesi da misurare, non un pezzo mancante |

---

## 8. Le MANCA-SERVE, in ordine di quanto costa la loro assenza ogni giorno

1. **La memoria non si riempie da sola** — e il rimedio sono **due** meccanismi,
   non uno (§0): la corsia di scrittura per-turno (episodio → coda → estrazione,
   latenza di minuti) *e* la passata di manutenzione notturna (dedup, decay,
   pattern). Oggi: `ingestPending` con un chiamante manuale
   (`cli/memory.ts:171`), 6 episodi e 0 fatti sulla macchina dell'owner. Senza
   questo, `importance`, `origin`, `absence.ts` e l'espansione del grafo sono
   inerti — hanno costruito i muscoli di un corpo che non mangia.
   *Costo*: il lavoro di M2 in blocco.

2. **I connettori della vita dell'owner: mail e calendario.** Il vecchio li aveva
   con il gate giusto (bozza → outbox → conferma → grace worker,
   `src/outward/outward_gate.ts`). Il nuovo ha il kernel che li governerebbe e
   nessun adapter. Sono 8 dei 20 casi d'uso di `12-casi-uso-primitive.md`, e
   `search_emails`/`draft_calendar_event`/`draft_email` erano fra i tool
   davvero usati. *Costo*: alto e quotidiano — è metà del motivo per cui si apre
   l'agente al mattino. *Rischio da chiudere prima*: `12-casi-uso-primitive.md`
   §"il rischio che questa lista introduce" — una mail avvelenata che arriva
   alle 7 non è coperta da nessun capitolo del threat model.

3. **Le note vocali non vengono trascritte.** Il vecchio ascoltava
   (`src/transcription.ts:33-50`, faster-whisper locale, tutto sul dispositivo).
   Il nuovo salva l'ogg nel vault e tace. *Costo*: alto per l'uso da telefono —
   il messaggio vocale è il modo in cui si parla a un agente mentre si cammina, e
   oggi quel canale è muto. *Prezzo*: un subprocess e un modello locale; il
   vecchio l'aveva già risolto.

4. **Non c'è un posto dove chiedere cosa si può regolare** (M5-bis punto 3).
   Il vecchio aveva `/flags`, `/think`, `/footer`, `/stato`, la webapp. Il nuovo:
   5 slash e JSON a mano, alcuni dentro un sigillo che vuole `muffin rot reseal`.
   Non serve un `muffin config` che rimetta le manopole ovunque — serve **un
   comando che elenchi cosa è regolabile e dove sta**. *Costo*: medio, ma è
   attrito su ogni singolo giorno.

5. **Il profilo vivo e il contrappunto.** Il vecchio produceva ogni notte ~500
   parole di "chi sei adesso" e ~150 di contraddittorio anti-piaggeria; la
   tabella `profiles` del nuovo esiste e **non ha né scrittori né lettori**
   (`core/memory/schema.ts:130`). È la differenza fra un agente che *ha* i tuoi
   fatti e uno che *ti sa*. *Costo*: medio, e cresce man mano che i fatti si
   accumulano — quindi arriva subito dopo il punto 1.

6. **L'onboarding che impara.** Il vecchio aveva un meccanismo
   (`src/cli/install.ts:429-576`: una domanda per volta, mai liste, mai wizard,
   quattro domande progettate su sette di tetto). Il nuovo ha una **sezione di
   prompt** che dice al modello di comportarsi così. *Costo*: medio — è il modo
   in cui la memoria parte da non-zero. E l'anello da chiudere (leggere la
   risposta) non l'aveva nemmeno il vecchio.

7. **Decay e compattazione della conversazione.** Nessun decay
   (`knowledge/01-understanding.md` lo dichiara), e la storia si tronca a 40
   turni invece di comprimersi. *Costo*: medio, ma **differito** — non morde
   finché non ci sono abbastanza fatti da dimenticare. Che è il punto 1.

8. **Delega / task di fondo.** 59 task eseguiti dal vecchio in 4 mesi. Rinviata
   con grilletto scritto (`adr/0033`), quindi non è un buco: è una decisione con
   una data. *Costo*: basso finché il grilletto non scatta.

9. **`/update` e la consegna remota dei job.** Nessuna strada di aggiornamento
   in-place; un job schedulato per Telegram oggi emerge nel REPL
   (`cli/repl.ts:115`). *Costo*: basso oggi, bloccante il giorno del cutover.

10. **Vedere il prompt di un turno.** Gli span non portano contenuto
    (`core/tracing/types.ts:46-70`), quindi "perché hai risposto così" non è
    ancora rispondibile — che è una promessa esplicita di V7 ed M6.
    *Costo*: basso per l'uso, alto per il debug.

---

## 9. Conteggio per verdetto

**86 righe** portano un verdetto (contate sulle tabelle §2-§7, escludendo questa).
Di queste, **79** confrontano una cosa che il vecchio aveva; le altre **7** sono
marcate *solo nuovo* — non hanno una controparte vecchia, quindi non sono un
confronto e non entrano nella percentuale.

| verdetto | righe | % delle 79 |
|---|---|---|
| **PRESENTE** (incluso "presente e migliore", "presente parziale") | 32 | 41% |
| **MANCA, NON SERVE** | 23 | 29% |
| **MANCA, SERVE** | 18 | 23% |
| **ERA SLOP** | 6 | 8% |

Nota di lettura: alcune righe raggruppano più comandi (i tre `*_group`, i tre
OAuth), quindi i 28 comandi Telegram stanno in 24 righe. Il conteggio è di
*capacità confrontate*, non di simboli.

**Delle 23 MANCA-NON-SERVE, 9 non hanno nessuna decisione scritta** — né ADR, né
riga di roadmap, né verdetto: `/footer`, `/bias`, `/confab`, `/pm2`, CalDAV, la
fase D.6 (reward conversazionale), la fase i17 (baseline), la fase K
(self-minter), e il sanitizer di voce. Le altre 14 sono coperte da una decisione
nominata nella riga stessa (ADR-0011/0022/0033, `01-verdetti.md` V2/V11) o da
un'esclusione di categoria (`04-roadmap.md` §3 "fuori da v1", M6, M7, Gate 1).

Nessuna delle nove è grave, e per nessuna propongo di ricostruirla. Sono elencate
perché "tagliato senza decisione scritta" è esattamente la categoria che fra sei
mesi produce la domanda *"perché non c'è più?"* senza una risposta — e perché il
caso di `find_tools` mostra la sfumatura: lì una ragione esiste
(`confronto-harness.md` §7), ma è **ricerca, non una decisione**, che è una cosa
diversa e va detta così.

---

## 10. Dove il nuovo è già avanti — perché la domanda era simmetrica

"Non peggiore, non indietro" è una soglia a due facce, e va guardata anche
dall'altra. Otto cose che il vecchio non ha e non avrebbe potuto avere senza
riscriversi:

1. **Un kernel di permessi puro** (`core/policy/decide.ts`), obbligatorio su ogni
   capability. Il vecchio aveva zone sui tool: la classe di bug "entry-point che
   si dimentica il gate" era rappresentabile. Qui no.
2. **Root of Trust sigillato, e ogni file sigillato ha un lettore dichiarato**
   (`core/rot/readers.ts`) — la cura alla quinta istanza di "difesa scollegata".
3. **Taint per turno e per fatto**: un turno di gruppo non può armare un nudge,
   non può raggiungere un host fuori allowlist, non può chiamare un server MCP.
4. **Il prompt e la lista dei tool sono funzione di chi parla**
   (`agent/context/assemble.ts`) — nessun peer lo fa (`confronto-harness.md` §8).
5. **Esecuzione sandboxata di default**, overhead misurato ~16ms/comando.
6. **Client MCP con pinning sha256 e sospensione al rug-pull**, provata contro un
   server vero — contro l'unico server cablato a mano del vecchio.
7. **Exit code che significano qualcosa** e ogni comando scriptabile: il vecchio
   si governava solo da chat.
8. **La proattività ha un insieme chiuso di trigger.** Il firehose del vecchio —
   228 consegne, una domanda al giorno per 19 giorni — qui non è scoraggiato:
   **non è rappresentabile**.

E la cosa più difficile da vedere in una tabella: il vecchio è **101.914 righe non
di test** con 16 tool mai chiamati, 1 skill usata, 0 undo, una tabella `config.yaml`
caricata e mai letta e `src/webapp/server.ts` a 3.528 righe. Il nuovo ne ha 15.944
con un rapporto test/codice di 0,61. La domanda dell'owner conteneva già la
diagnosi: **TROPPE**. Il lavoro non è recuperare le 47 cose: è recuperarne
**sei** — le prime sei della §8, in quell'ordine, e la prima da sola vale più
delle altre cinque messe insieme.

---

## Fonti

Vecchio (sola lettura): `src/telegram.ts:2761-2793` · `src/telegram/commands/registry.ts` ·
`src/tools/index.ts:547,714,1033` · `src/memory/memory_dream.ts:2066` ·
`src/dreamer.ts:114` · `src/thinker.ts:504,581` · `src/reactor.ts:904` ·
`src/memory/memory_learning.ts:625` · `src/memory/memory_semantic.ts:196` ·
`src/gateway.ts:2725-2732,2105` · `src/scheduler.ts:229,569` ·
`src/demons/daemon_manager.ts:14-18` · `src/memory/dream_phase_i.ts:598` ·
`src/outward/outward_gate.ts` · `src/cli/install.ts:429-576,1109-1166` ·
`src/cli/repl.tsx:486` · `src/transcription.ts:33-50` · `src/webapp/CLAUDE.md` ·
`src/flags.ts:165` · `config.yaml.example:1-14` · `docs/reference/ENVIRONMENT.md` ·
`muffin.dev.db` (aggregati).
Nuovo: `cli/main.ts:35-60` · `cli/repl.ts:18` · `cli/observe.ts:34` ·
`agent/tools/*.ts` · `agent/loop.ts:62,243,478,652-662` · `agent/profiles/*.json` ·
`core/memory/schema.ts` · `core/memory/{ingest,absence,rerank,invariants}.ts` ·
`core/scheduler/{proactivity,firelog,scheduler}.ts` · `core/policy/decide.ts:197` ·
`core/tracing/types.ts:46-70` · `defaults/rot/*.json` · `connectors/telegram/` ·
`~/.muffin/muffin.db` (aggregati).
Documenti: `research/a1-inventario-codebase.md` · `research/confronto-harness.md` ·
`knowledge/{01,03,04,05}` · `04-roadmap.md` §M5-bis · `01-verdetti.md` ·
`12-casi-uso-primitive.md` · `adr/{0022,0027,0028,0033}` · `docs/lessons.md`.
