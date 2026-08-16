# Stato esecuzione blueprint Muffin

> ⭐ **START HERE — handoff (sopravvive al compact). Aggiornato 2026-08-16.**

**Dove siamo.** M0–M5 è substrato costruito, non MVP. Gate 1 si chiude solo
quando l'owner usa Muffin per **14 giorni consecutivi** senza tornare al vecchio
(gruppi esclusi), non quando una checklist sembra piena. Repo autoritativa:
`~/dev/muffin-agent`; il vecchio `~/dev/Muffin` resta solo produzione fino al
cutover. Il dettaglio del chiuso è nella cronaca sotto; qui resta l'aperto.

**Sequenza operativa.** Prima si raggiunge **DAY-1 READY**: zero BLOCKER e zero
`?` in M5-bis, installazione reale, stato recuperabile. Poi partono i 14 giorni;
fix e build continuano, mentre gruppi/M6/M7 avanzano in parallelo. I gruppi si
riattivano dopo la finestra, ma ogni primitiva costruita prima resta
tenant/surface-agnostic: single-user è un default, non un hardcode.

**Direzione (ADR-0045/0046).** Un solo agente continuo attraversa modello,
sessione e device: fare · capire · essere presente. Evidence, beliefs, world
state e work state sono piani distinti. Le surface sono porte: owner solo da
subject-id stabile autenticato e binding protetto; ogni campo model-visible è
contenuto parsato con provenienza/taint e resta potenzialmente iniettato.
L'autonomia futura è scoped, revocabile e non allarga kernel o Root of Trust.

**Blocker Gate 1 visibili adesso** (`M5-BIS.md` è l'inventario completo):

- A2/A3: `identity.md` è template e manca il taglio persona dell'owner.
- B2–B5: turno lungo, `wait`, `todo`, resume e budget per-job. Il record durevole
  esiste; i consumer sono WIP sul branch `slice/turno-sospeso`.
- B8/B14: delivery remota e allegati prodotti; WIP sul branch `slice/superfici`.
- B15/B16: binding owner nel RoT e envelope tipizzato universale non esistono.
  Telegram prova `from.id`+privato contro impersonazione, ma conserva il binding
  nella config ordinaria e non tipizza ogni metadata/multimodale.
- C4/C6: recall storico e grafo temporale (WIP su `slice/memoria-nel-tempo`).
- C8: audio senza trascrizione. E4: acceptance harness (WIP su
  `slice/accettazione`). Gli altri `?` restano debito anche quando non sono
  blocker nominati.

**Non integrato.** Le quattro slice morte per limite di sessione (turno sospeso,
superfici, memoria nel tempo, accettazione) non vivono più solo nei worktree: il
loro lavoro è committato come WIP — non verificato, non integrabile così com'è —
e pushato sui rispettivi branch; `.claude/deleghe.mjs riprendi` deriva branch,
PR e delega che li sta riprendendo. `slice/hermes` (PR #29) e
`slice/taint-in-ingresso` (PR #28) sono aperte verso `dev`. Nessun lavoro vale
READY prima di integration test, wiring di produzione, failure path, scenario
reale, documenti/stato e percorso di chiusura di `ORCHESTRATION.md` §11.

**Checkpoint.** `BRANCHING.md`: decisione fissata → draft PR; unità raggiungibile
→ commit coerente; build+suite+failure+stato → review; solo judge `MERGE` →
integrazione in `dev`. `dev`→`main` richiede una verifica e un verdetto separati.
Integrate in `dev`: **PR #30/#31/#33/#34**; **PR #32** `dev`→`main` è
**mergiata** (`main` = `dev` più il merge). Aperte: **#28** e **#29**, entrambe
in conflitto con `dev` dopo #30–#34 — riallineate, poi judge nuovo. Dei sei
worktree lasciati dai chip dell'owner, tre fix erano bug vivi su `dev` e
diventano slice proprie con la loro mutazione provata (`doctor` che piegava
`error` su `ok`; `vaultPaths` che aggregava il tier con `min` invece di `max`;
la risposta dell'agente salvata a `trustTier 0` dopo un turno sporco); tre sono
scartati con motivo (superati da ADR-0039 e da `slice/superfici`, o sottoinsieme
di un altro) e archiviati come commit sui loro branch `claude/*`.

**Decisioni owner ancora aperte.** Scope lettura sandbox · `mcp.*` per-tool ·
modello di reversibilità · `ricorda` scrive o propone · lingua docs pubblici ·
identity/persona. Le decisioni sicurezza 0045/0046 sono invece ratificate.

**File load-bearing — LEGGI PRIMA di lavorare:**

- `STATE.md`, `LAVORO.md`, `04-roadmap.md`, `M5-BIS.md`, `03-threat-model.md`,
  `09-contratti-m0-m1.md`, `BRANCHING.md`, `ORCHESTRATION.md`, `JUDGE.md`.
- `knowledge/README.md`, `knowledge/03-observing-spine.md`,
  `knowledge/04-learn-from-absence.md`.
- Codice: `agent/loop.ts`, `agent/runtime.ts`, `core/turns/store.ts`,
  `core/memory/{recall,store,extract}.ts`, `core/policy/{decide,types}.ts`,
  `connectors/telegram/connector.ts`.

---

> Cronaca dettagliata (log, dal 2026-08-04). Fasi A, B, C, D completate. Indice: `README.md`. Mandato: `BRIEF.md` + Addendum №1.

## Completato

- **Fase A** — 6 scout (`research/a1..a6`): inventario, prior art, standard, memoria, modelli/economia, brain-hands/sandbox.
- **Checkpoint** — 6 direttive owner incorporate.
- **Fase B** — `01`…`08` + `adr/0001-0018`.
- **Fase C** — 3 critici ostili (`critique/c1-c3`), obiezioni risolte nei documenti; `09-contratti-m0-m1.md` (normativo) e `10-risoluzioni-fase-c.md`.
- **Fase D** — decisioni owner + 3 scout (`research/b1..b3`):
  - Licenza **MIT** (ADR-0019), **lingua** del progetto (ADR-0020), **surface model** (ADR-0021), **RoT rivisto** (ADR-0003 §revisione), **due gate MVP/cutover** (04 §3), **namespace verificato** (ADR-0012 §verifica).
  - **B1** → ADR-0022: un processo confermato, ma con **gate di priorità foreground** (pattern Odysseus) e **worker_thread per il batch pesante** (better-sqlite3 sincrono blocca l'event loop). Lezione dal bug Hermes #25517: l'heartbeat di un job non può dipendere dal ritorno del loop.
  - **B2** → 06 §2-bis/2-ter: **Qwen 3.8 27B non esiste ancora** (pesi annunciati per metà agosto); catalogo 20-40B verificato; l'incumbent **è già multimodale sull'endpoint già cablato**; audio = servizio a sé (locale con Metal, API altrove); **lingua del prompt: nessuna evidenza controllata, in nessuna direzione**; nuovo rischio: licenze open-weight cinesi che escludono l'UE.
  - **B3** → ADR-0023: ingresso **doppio binario** (pass-through + descrizione indicizzabile), uscita **immagine e testo mai al posto del testo** (WCAG 1.4.5), pipeline `satori`→`resvg-js`, grafici Vega-Lite, **video fuori dalla v1**.

## Implementazione (dal 2026-08-04)

Il codice vive in **`~/dev/muffin-agent`**, repo git separato. **Rinominato il 2026-08-09** da `muffin-next` (che era provvisorio: macOS case-insensitive collideva col checkout `muffin` esistente). Decisione owner: `muffin-agent` come repo+package, `muffin` resta nome-prodotto+comando+identità (ADR-0012 §revisione). Nulla nel codice hardcodava il vecchio nome (path relativi ovunque); aggiornati package.json e l'hook `guard-frozen-deps` del vecchio worktree.

- **M0 chiuso** — policy kernel, RoT, tracing OTel pinnato, config XDG, budget, `init`/`doctor`.
- **M1 chiuso e verificato su modello vero** — loop, due adapter dietro `ChatCall`, profili per-modello come dati, CLI `run` + `repl`. Capability floor **6/6 su Sonnet 5 e 6/6 su Qwen3.6-27B**: il gate anti-"harness su Sonnet" tiene.
- **M2 quasi chiuso (2026-08-05)** — schema a tre piani, estrazione, giudice di contraddizione, recall ibrido (FTS5 + vec, RRF k=60, espansione grafo, reranking), invarianti property-based, `muffin memory why|search|extract|stats|check`. **Scenario di accettazione 9/9** (`evals/memory/acceptance.ts`): ogni turno un processo separato, ogni domanda una sessione nuova, stato asserito in SQL.
  **Vault chiuso** (2026-08-05, ADR-0024): chunking strutturale heading-first con riga di contesto in ogni chunk, supersede dei chunk ritirati, `muffin vault reindex|add|ls|check`. Il `check` confronta disco e indice — la trappola che i sistemi confrontabili hanno tutti aperta.
  **Manca ancora**: il golden set della suite memoria (05 §3.1). Il consolidamento schedulato è M5 per costruzione: oggi `muffin memory extract` innesca a mano la stessa funzione che lo scheduler chiamerà.
- **Prossimo**: **M4** (Telegram) — non M3, ordine strangler.

Due difetti trovati costruendo M2, entrambi invisibili dall'interno dei test: l'**indice vettoriale non lo riempiva nessuno** (`VectorIndex.index` chiamato solo dai test) e il **giudice non vedeva mai le frasi**, solo i due valori nudi — 0/4 verdetti utili sui quattro archetipi, 4/4 dopo. Vedi i commit `112d948` e successivo.

### Audit avversariale (2026-08-06)

Quattro agenti in parallelo — review avversariale, ricerca sui parametri numerici, loop vs SOTA 2026, conformità al normativo. Verdetto: *"non ci costruirei sopra i prossimi tre moduli"*, e aveva ragione. Il pattern trovato non era un tipo di bug ma un'abitudine: **quattro difese scritte, testate, documentate e collegate a niente** — budget engine (`record()` senza chiamanti), safe mode (calcolato e mai passato al kernel, mentre la CLI diceva all'utente che negava), invariante `vector_desync` (salta in silenzio proprio dove serve), probe sandbox macOS (profilo `allow default` che riportava "containment held").

Chiuse tutte, più: leak cross-tenant già cablato (`searchMemory` col tenant hardcoded), quattro bypass del containment fs (symlink penzolante, hardlink, case su APFS, `fs_read` che saltava la deny-list e leggeva la chiave API), `draft` eseguito come `allow`, taint azzerato dalla metà vettoriale del recall, sentinel dello spotlighting falsificabile in 5 punti, vault che riciclava il tier con un `mv` e indicizzava i dotfile, sessione REPL che moriva in modo permanente. Aggiunti context compaction (−48% picco token misurato altrove) e **completion-gate deterministico** (−31pp nell'ablation GAIA quando manca; il vecchio Muffin ce l'aveva e non era ricomparso in nessun modulo). **155 test**, accettazione M2 ancora 9/9.

Sui numeri: quattro dei sei parametri sono **folklore** e la ricerca non offre alternative — `SUPERSEDE_THRESHOLD 0.75` potrebbe proteggere *meno* di quanto sembra (le confidenze LLM sono sovrastimate di 15-27 punti), e `limit=8` + espansione 1-hop inietta il profilo di distrattore peggiore. Entrambi richiedono una misura nostra sul golden set, non altra ricerca.

**Lista dell'audit chiusa** (2026-08-06): kNN-poi-filtra risolto con `PARTITION KEY` di sqlite-vec — verificato con probe, migrazione dei vettori senza re-embedding, e la sequenza è drop-poi-create perché `ALTER TABLE RENAME` su `vec0` lascia gli shadow col nome vecchio. Canale `ask` cablato (REPL chiede, headless esce 3). Isolamento per costruzione nei tre write path che filtravano sul solo id. `AGENTS.md`, config validata con zod, backoff con jitter, abort tra i tool, `fsList` che sopravvive a un symlink rotto.

Resta aperto solo `structuredOutput` nel `ChatCall` normativo (nessun consumatore oggi).

### M4 — Telegram (in corso, 2026-08-06)

**ADR-0025**: nessuna libreria a runtime. Telegraf è **abbandonato a monte** (ultima release 2024-02-29, tipi fermi da 11 mesi) — ma la premessa che il god-file fosse colpa sua era **sbagliata**: la diagnosi originale nomina `TG-BOUNDARY`, l'assenza di un confine tipato, e il fix è indipendente dalla libreria. Quindi: raw `fetch` + `@grammyjs/types` come `import type` (zero byte a runtime), dietro un confine tipato. Fallback dichiarato a `grammY.Api` standalone se il multipart si rivela costoso. Long polling, HTML e non MarkdownV2 (3 caratteri da escapare contro 18, inclusi `.` e `-`).

**Fatto**: inbox durevole (scrittura prima dell'ack — Telegram non rimanda mai un update confermato, quindi avanzare l'offset prima di salvare perde il messaggio per sempre), renderer HTML col chunker che misura l'**HTML renderizzato** e riapre i blocchi di codice tagliati, client con retry su `retry_after`, presence col keepalive dal primo giorno, connector con mapping tenant/principal, `muffin telegram run|status`. **185 test.**

**Media chiusi** (2026-08-06): allegato → `vault/inbox/` → indicizzato **prima** del turno, col tier del mittente. Il nome file non è sanificato ma **ricostruito** da un alfabeto sicuro (`../../.ssh/authorized_keys` non ha modo di uscire), niente dotfile, unicità da data+update-id senza check di collisione. Dimensione verificata due volte, e l'URL di download — che contiene il token — non finisce mai in un errore o in un log. Multipart in uscita con `FormData` nativa; `muffin telegram send` è un comando **dell'owner**, non un tool del modello: mandare è azione outward e ha il suo gate. **195 test.**

**Documenti chiusi — M5-bis C7** (2026-08-15, **ADR-0043**). I media erano chiusi, i **documenti** no: `vault.ts` leggeva utf-8 o niente, quindi un PDF finiva in `vault/inbox/` e veniva saltato con «non è testo — serve un estrattore». Muffin diceva *ricevuto* e non una parola era ripescabile — regressione rispetto al vecchio. Ora `core/documents/` estrae **PDF, DOCX e testo interi** (`unpdf` 1.8.1, MIT, zero dipendenze, pdf.js 6.1.200 sotto; DOCX via `node:zlib` e directory centrale ZIP bounded, invece delle 10 dipendenze di `mammoth`). Il vault conserva le pagine PDF e le parti OOXML collegate con il loro nome semantico; il turno riceve una **vista compatta** — indice + `document_read(path, da, a)` che rilegge la porzione **dal file**, non da una copia. L'output effettivo dell'inflater ha un tetto indipendente dai campi dichiarati nello ZIP; il formato viene riconosciuto senza decomprimerlo due volte. Misurato su un PDF vero di 6 pagine: **19.116 caratteri in 83 ms**. Il fallimento che assomiglia al successo — una scansione restituisce `["",""]` — è un'unione tipizzata, non una stringa vuota: `no_text_layer`, e l'owner legge «PDF senza testo selezionabile: N pagine… qui non c'è OCR». Trovato e chiuso di rimbalzo: `reindex` lasciava esplodere l'embedder, quindi con Ollama spento il connettore rispondeva `[allegato NON ricevuto]` **su un documento appena indicizzato per intero**. **1.024 test.**

**CLI rimodellata su critica owner (2026-08-06)**: `muffin telegram run|send` erano verbi sbagliati — il primo un secondo processo dove ADR-0022 ne prescrive uno, il secondo un chiamante finto bullonato per esercitare il multipart. Ora **`muffin` avvia l'agente** (REPL + ogni surface abilitata nello stesso processo) e le surface si gestiscono col registro di ADR-0021: `muffin surface list|enable|disable`. L'owner chat id sta in config, non in una env var. `sendDocument` resta con un test e un commento che dichiara il chiamante differito (modulo outward) — cablaggio rimandato per decisione, non dimenticato.

**Processo (2026-08-07, direttiva owner)**: `docs/PRACTICES.md` in muffin-next — sei pratiche con trigger (doc via MCP prima delle API, probe sul load-bearing, prior art prima delle forme, parse-at-boundary, test-del-cablaggio, escalation prosa→hook) + primo hook deterministico (`PreToolUse` che blocca `npm install` di pacchetti non dichiarati; allucinazione pacchetti frontier 2026: 4.6-6.1%, arXiv:2605.17062). Aggiunti `--version` e alias `repl` documentato (gap trovati dal checklist GNU). **Da verificare prima del deploy VPS**: sotto systemd stdin è `/dev/null` → il loop readline del REPL riceve EOF subito e chiuderebbe le surface appena connesse — serve una modalità serve/headless per il processo di servizio (inferenza ad alta confidenza dello scout, non ancora eseguita).

**Manca per chiudere M4**: la prova end-to-end su un bot vero — `echo -n "<token>" | muffin secret set telegram_token`, poi `muffin surface enable telegram` (trova da solo la chat dell'owner dopo il primo messaggio al bot), poi `muffin`. È l'unico pezzo che richiede l'owner.

### M3 — Primitivi, skills, dev (avviato 2026-08-08)

Mandato owner via /loop: **si lavora fino all'MVP** (Gate 1 = M0→M5), Context7 prima di ogni API, pratiche di PRACTICES.md.

**Ricerca chiusa** (2026-08-08, stesso giorno): report persistiti in `research/m3-a-sandbox-runtime-lib.md` (con clone+build+esecuzione del codice srt — profili SBPL reali 11-19KB, cluster di bug fail-silenzioso #432/#434/#446 aperti quella settimana) e `research/m3-b-skillmd-shell.md` (6 campi frontmatter standard vs ~19 estensioni proprietarie CC; tre semantiche diverse dietro "timeout"; Gemini unico dove il retry unsandboxed non è mai del modello). **ADR-0026**: srt adottato come **dipendenza sorvegliata** — pin esatto, config costruita campo-per-campo dietro zod v4 (typo impossibile → #434), un tracer bullet per ogni garanzia usata (→ #432, #446), probe fallito = degrade ad ASK (si diverge dal fail-open di Claude Code), niente PTY, niente apply-seccomp su Linux in v1.

**Mandato della ricerca (com'era)**:
- Scout A: `@anthropic-ai/sandbox-runtime` come *libreria* — versione/manutenzione, API programmatica, write-scope per-invocazione, costi per-comando, profili SBPL minimi dei peer, raccomandazione ufficiale AppArmor Ubuntu 24. Baseline A6 (2026-08-04) esclusa dal mandato: non si rifà.
- Scout B: spec SKILL.md esatta (agentskills.io + anthropics/skills) e semantica shell-tool dei peer (timeout, troncamento, background, UX del fallimento sandbox).
- Context7, fatto: **SDK MCP v2 = package split** `@modelcontextprotocol/client|server|node`, versione **2.0.0-alpha.2** (alpha: da pesare contro v1.29 stabile al momento della build), `callTool` senza schema param (risoluzione interna), errori tipizzati ProtocolError/SdkError distinti da `isError` tool-level, `listTools()` espone name/description/inputSchema — la base del pinning hash di §3-bis (c-bis).

**Substrato già in piedi da M0**: `core/rot/verify.ts` ha `RotMode = hardened | single-user` e `decide.ts` porta già `ctx.hardened` — la regola "single-user → `sys.shell` sempre ASK" (threat model §g, contratti §4) ha l'idraulica pronta, mancano le capability sys.* da dichiararci sopra.

**Slice pianificate** (task #12-#18): ADR-0026 (executor: dipendenza vs profili in casa) → executor + sys.shell/sys.process → sys.http con egress → client MCP (allowlist + hash pinning + `mcp list --verify`) → runtime SKILL.md → capability dev (clone dedicato, PR-only) → accettazione end-to-end con misura dell'overhead sandbox (gap A6 §5.6, dovuto da ADR-0018).

**Slice 1 chiusa** (2026-08-08, muffin-next `06c0ed4`, 219 test): srt 0.0.71 pinnata esatta; `core/sandbox/executor.ts` = il confine (config campo-per-campo, guardie ripetute in ogni per-call, env del figlio ricostruito — la chiave API non entra mai nel sandbox via environ); **10 contenimenti reali come test** (guard con cwd altrove → #432, deny-batte-allowWrite, write positiva → #446, rete negata, timeout, troncamento annunciato head+tail); `sys.shell` high/hostOnly → single-user = sempre ASK provato attraverso il kernel vero; shell_run stateless-cwd (modello Gemini/Codex), timeout 120s/600s controllato dal modello (convenzione CC); **v1 strict**: nessun retry unsandboxed — l'escape hatch arriverà come capability always-ask a sé. Vitest ora esclude `.claude/worktrees` (i worktree degli agenti raddoppiavano la suite).

**Slice 2 chiusa** (2026-08-08, muffin-next `bb02ac1`, 277 test): `sys.http` + `sys.process`.
- **Egress.** `core/net/egress.ts` è il primo lettore vero di `rot/egress.json` (c'era e veniva hashato da M0, consumato da nessuno — la solita "difesa scollegata"). Il kernel ha un **ramo egress**: URL in allowlist → parla la classe di rischio; fuori allowlist → owner-in-contesto-pulito **ASK**, turno tainted **DENY** (un contesto avvelenato non deve poter *nominare* l'endpoint di esfiltrazione). Allowlist assente = ask-per-tutto, non allow-per-tutto (il fallimento del cablaggio-dimenticato è quello sicuro). Match su confini di label (`evil-example.com` ≠ `example.com`; `*.wiki.org` = una label). `http_get` ricontrolla **ogni hop di redirect** sulla stessa lista e risolve ogni host per rifiutare indirizzi privati/link-local/metadata (**SSRF floor**, v4-mapped-v6 incluso — via Context7/undici: `redirect:'manual'` per seguire hop-by-hop coi check in mezzo). GET-only, corpo tier-3 e recintato.
- **Process.** `sys.process.list`/`kill` **tipati** (non shell): `kill 0`/`-1`/self irrappresentabili (schema o pre-syscall), `process_list` chiede a ps la colonna `comm` mai `args` (l'argv altrui può portare un token come flag). `kill` high → ASK in single-user. Iniezione di ps/kill per test deterministici.
- Ogni guardia col suo test-del-cablaggio, **verificato fallire senza**: disabilitando il ramo egress si arrossano 5 test (provato). `sys.process` decisione di scope: costruito minimale perché la lista è utile e sicura, ma è il kernel l'unico contenimento (nessun sandbox: opera sulla tabella processi dell'host).

**Slice 3 quasi chiusa** (2026-08-08, muffin-next `60dbc7f`, 290 test): **client MCP col rug-pull gate** (threat model §c-bis). L'approvazione pinna sha256 di name+description+inputSchema di ogni tool (serializzazione canonica, ordine chiavi irrilevante); un server che a riconnessione lista qualcosa di diverso è **SOSPESO** — zero tool registrati, riga di report al boot, si rientra solo ri-approvando. Il rug-pull è **provato contro un server stdio vero** (fixture con descrizione flippata via env → sospensione verificata). SDK **v2 stabile 2.0.0** (uscita il 2026-07-28 insieme alla revision — il caveat alpha è morto sul check npm); divergenza trovata sondando il pacchetto installato: `StdioClientTransport` è dietro il subpath `/stdio`. Env safelist del transport verificata a sorgente (la chiave API non raggiunge i server salvo nome esplicito nel registro). Descrizioni terze **recintate col nonce** e appese DOPO i tool interni; risultati tier-3 recintati. Una capability per server (`mcp.<n>`, medium/hostOnly/taint≤1: un turno tainted non chiama server terzi, un membro mai). Runtime con `register()`/`onClose()` per attachment asincroni; repl e run headless stampano il report per-server. **Chiusa** (`5fa8d21`, 292 test): verbi CLI `muffin mcp add|list --verify|remove` — `add` stampa ogni descrizione prima di pinnare (approvare = aver letto), ri-`add` su nome esistente = ri-approvazione, `list --verify` esce 0 solo ad audit pulito (scriptabile); flusso intero provato contro il fixture reale.

**Slice 4 chiusa** (2026-08-08, muffin-next `b5964a0`, 305 test): **runtime SKILL.md** (#16). Formato standard agentskills.io, nessun formato proprio: 6 campi validati col campo nominato al fallimento, `name`===directory normativo, chiavi non-standard ignorate PER NOME nel report. Divergenza deliberata da Claude Code: skill malformata → **skip con motivo stampato al boot** (`runtime.bootLines`), mai il mezzo-caricamento silenzioso. Progressive disclosure: metadata sempre nel system prompt (sezione assente se zero skill), body via `skill_read` — porta dedicata contenuta nella dir della skill (entrambi i lati realpath'd; traversal e symlink-escape sono test). `allowed-tools` parsato e mostrato, enforcement dichiarato differito. js-yaml (^5) giustificata: le skill dell'ecosistema usano YAML vero; `load()` v4+ = vecchio safeLoad, verificato via Context7 prima dell'install.

**Slice 5 — costruita poi tagliata** (2026-08-09): la capability `dev` (livello a: `dev_clone`+`dev_run` su workspace, commit `7d2d175`, 316 test) è stata **rimossa** per direttiva owner dopo due redirect consecutivi (`5b3f9c1`-ish, 305 test). **ADR-0027**: Muffin **non è un coding agent**. Sul codice fa tre cose: (1) legge (`fs_read`/`fs_list`), (2) esegue script contenuti (`shell_run`, unico tool comando — i check dei comandi dev vivono qui in generale, un solo punto di contenimento), (3) tetto differito = orchestra un coding agent esterno via API (ADR-0015 livello b, fuori v1). L'introspezione effettiva resta desiderata ma è **M6** (span citati, non a metà adesso). Costo pagato: codice funzionante e testato rimosso — l'aver costruito nella direzione sbagliata prima del redirect, saldato subito. **M3 semplificato e sostanzialmente chiuso**: restano solo l'accettazione end-to-end + misura overhead sandbox (#18).

**Ricerca per-connector chiusa** (2026-08-09, domanda owner "system prompt prima o dopo il gateway? + sfruttiamo cache"): 2 scout su fonte primaria + nota caching + **§revisione ADR-0016**. Report in `research/m3-connector-timing-hermes-openclaw-goose.md`, `m3-connector-capabilities-telegram-discord.md`, `m3-caching-and-per-connector-timing.md`. Risposte verificate: (1) il **gateway precede sempre** l'assemblaggio — il prompt-builder *legge* il connettore risolto dal routing, non lo decide; (2) la capability del connettore alimenta **sia il renderer sia il prompt**, ma il prompt-hint va in **coda volatile, mai nel prefisso cacheabile** (Hermes/OpenClaw fanno esattamente questo per riusare il prefisso across channel turns — conferma esterna della meccanica caching); (3) **tool uniformi**, le capability NON diventano tool condizionali (i bottoni sono un tool universale reso a valle); (4) **gemma post-cutoff**: Telegram `sendRichMessage` (Bot API 10.1/10.2, giu-lug 2026, già live) rende tabelle/formule/liste native — capability `rich-native` opt-in con fallback obbligatorio (modello Hermes/Vercel), satori→resvg resta il floor; (5) regola concreta: immagini renderizzate via `sendDocument` non `sendPhoto` (che ricomprime JPEG). MCP Apps assente da TG/Discord, fallback screenshot già precluso dal taglio Chromium.

**Incidente di processo (2026-08-08, rimediato + meccanizzato)**: il cwd della Bash si resetta a ogni turno del /loop → due `npm install` per muffin-next sono atterrati nel **vecchio** worktree. Ripristino byte-exact (`npm uninstall` + `git checkout` dei manifest, verificato pulito) e — secondo incidente di classe cwd — escalation a meccanismo: hook `guard-frozen-deps.mjs` in `.claude/` del vecchio worktree (blocca npm/pnpm/yarn mutanti lì, override `MUFFIN_OLD_OK=1`), esercitato su 4 percorsi. Memoria aggiornata.

**M3 CHIUSO** (2026-08-09, muffin-next `ca575b2`, 312 test). Le slice portanti: executor+`sys.shell` (`06c0ed4`), `sys.process`, `sys.http` egress-gated, client MCP col rug-pull gate (`60dbc7f`) + verbi CLI (`5fa8d21`), runtime SKILL.md (`b5964a0`), capability `dev` **costruita e poi tagliata** (ADR-0027, non è coding agent). **Accettazione end-to-end** attraverso `buildRuntime` — l'assembly di produzione, non pezzi a mano (il principio "testa il cablaggio"): kernel sigillato nega il gruppo/chiede all'owner, ogni capability registrata è nota al kernel, skill scoperta nel prompt / rotta saltata rumorosamente, MCP allowlistato attaccato / driftato sospeso, shell di produzione contiene la scrittura fuori-workspace. **Overhead sandbox misurato**: ~16ms/comando su Seatbelt (debito A6 §5.6/ADR-0018 saldato). Resta il piano affinato del renderer per-connector (§revisione ADR-0016) per quando si costruisce M4-rendering.

**Sequenza MVP (Gate 1 = M0→M5)**: M0-M4 sostanzialmente chiusi (M4 manca solo la prova bot-vero owner-gated), M3 chiuso. **M5 avviato** (scheduler & proattività) — l'ultimo prima del Gate 1.

### M5 — Scheduler & proattività (avviato 2026-08-09)

Substrato già in piedi: principal `system:scheduler`, `quietHours` nel RoT (`defaults/rot/budgets.json`: 23-08 Europe/Rome), budget engine. Regole trigger dal threat model §3: proattività solo da evidenza tier ≤1; `system@scheduler` non eredita la colonna owner (ASK-in-coda, `outward.*`/`config.ratchet` esclusi). Vincolo ADR-0022: l'heartbeat di un job NON può dipendere dal ritorno del loop (bug Hermes #25517, doppio worker).

**Slice 1 chiusa** (muffin-next `d76597d`, 322 test): **job store durevole + next-fire deterministico**. `core/scheduler/jobs.ts` — tabella jobs (soft-delete §I-8), `nextFire` via **cron-parser** (^5.7.0, scelta con Context7+npm: parser puro senza timer, il loop resta nostro per ADR-0022; una dip transitiva luxon; tz validata via `Intl` perché cron-parser accetta silenziosamente una zona ignota). `markRan` ricalcola da *ora* (catch-up: un processo giù su un fire gira una volta, non replaya gli slot persi). Persistenza provata come chiede la DoD: JobStore fresco su stesso file vede il job = "sopravvive al riavvio". DST wall-clock stabile (test su spring-forward italiano).

**Nota di processo**: il `cd /home/user/dev/muffin-next &&` non entrava nel comando bash (glitch ripetuto) → il hook `guard-frozen-deps` ha correttamente bloccato l'install nel vecchio worktree; aggirato con `npm install --prefix /home/user/dev/muffin-next` (via che il hook accetta esplicitamente, robusta al cwd). Il hook ha fatto il suo lavoro.

**Slice 2 chiusa** (muffin-next `f36f021`, 333 test): **Scheduler + `muffin jobs`**. `core/scheduler/scheduler.ts` con le tre proprietà di ADR-0022, ognuna un bug evitato: `tick()` lancia il job e ritorna senza attenderlo (heartbeat indipendente dalla durata — il caso Hermes #25517); un job in volo è saltato da ogni tick successivo (un owner, una lane, un job alla volta); il foreground vince (tick differisce mentre l'owner tiene la lane, un job in corso riceve l'abort per cedere). Job ceduto (aborted) = resta due, ritentato, non contato come run. ASK del principal system = consegnato come outcome; fallimento di consegna = markRan comunque (mai raddoppiare il lavoro). CLI `jobs list|add|remove` apre il DB diretto (list non richiede il modello), default tz dalla zona owner nel RoT ("le 8" = le sue 8). `add` prende un cron esplicito; il path NL è un loop-tool che atterra sullo stesso store dopo conferma. Provato sul binario vero (job creato/listato, cron malformato → exit 78).

**Confine onesto slice 2**: il tick-loop LIVE nel REPL (timer + gate foreground cablato ai turni interattivi + `runTurn` come RunJob + consegna alle surface) è il "connect", differito come la prova bot di M4 — la meccanica è costruita e testata, cablarla al sistema che gira è il passo successivo.

**Gate di proattività chiuso** (muffin-next `e764311`, 342 test, **ADR-0028**): decisione owner **"segnale ad alta confidenza"** (opzione B/3) + vincolo dall'esperienza col vecchio Muffin ("la vecchia proattività era un firehose di 'ho notato X, ho notato Y', vaga e iper-complessa"). `decideProactive` = funzione pura come il kernel: tier>1 → deny (gruppo non arma mai un nudge — memory-poisoning §b, isolamento DoD); quiet-hours → defer a fine finestra; budget → defer. E il rail sul *cosa*: `ProactiveTrigger.kind` è un insieme **CHIUSO** azionabile (commitment_due/deadline_near/fact_actionable/consolidation) + anchor per dedup — un'"osservazione libera" non è rappresentabile, il firehose è incostruibile. Memoria owner aggiornata.

**Scheduler LIVE cablato** (muffin-next `8487c30`, 347 test): `buildRuntime` espone un `JobStore` sulla stessa connessione (ADR-0022), il REPL ci gira sopra uno `Scheduler` — tick 30s, `ForegroundGate` che legge il controller del turno interattivo (foreground vince, il job in corso cede). `makeJobRunner` fa il ponte job→turno reale (sessione fresca per fire, principal `system:scheduler`); `jobOutcomeFromTurn` (l'ASK-in-coda → testo per l'owner) è puro e testato senza modello. Prova d'assembly di produzione: `runtime.jobs` guidato da uno Scheduler con runner fake → job due, eseguito, consegnato.

**Resta di M5** (connect owner-gated, come la prova bot di M4): (1) delivery remota telegram via connector send (oggi un messaggio schedulato per canale remoto emerge nel REPL invece di sparire); (2) event-bus soglia→consolidamento (consuma il conteggio episodi della memoria); (3) i signal-detector (`deadline_near`, `commitment_due`) che producono i `kind` chiusi del gate. La prova end-to-end (un brief che spara attraverso il modello alle 8) richiede la chiave e il sistema che gira.

**MVP (Gate 1 = M0→M5): substrato completo.** Tutti i moduli hanno il loro core durevole costruito e testato; ciò che resta è connect-sul-sistema-che-gira (prova bot M4 + delivery/detector M5) e le decisioni-owner residue (assunzioni 08). Nessuna decisione di design aperta.

## La spinta MVP: i sei punti per esteso

> Spostato qui dal blocco iniettato il 2026-08-14, **verbatim e senza tagli**.
> Il blocco era **16.716 caratteri contro un budget di ~9.870**, quindi veniva
> troncato a metà del punto 0 del divario: la lista dei **file load-bearing** —
> che è la cura dichiarata al "non avere i file" — non arrivava mai in contesto,
> e nemmeno niente di ciò che le sta accanto. Il meccanismo funzionava e lo
> diceva pure (il marcatore di troncamento c’era); l’esito era sbagliato lo
> stesso. Cinque punti su sei sono chiusi e il loro dettaglio è cronaca, che è
> questo posto qui. Niente è stato cancellato.

**La lista forzata verso "usabile ogni giorno"** (è ciò che *rende* usabile, non una scelta):
1. ✅ recall-polish — non ripesca il messaggio corrente, non narra i tag (`muffin-agent@20554dd`).
2. ✅ **memoria-che-ti-conosce** ([PR #2](https://github.com/GiustoPiedimonte/muffin-agent/pull/2)) — `importance` ordinale 0/1/2 (forced-choice all'estrazione, non un voto: i rater LLM comprimono al centro e sotto-predicono proprio l'estremo alto dove vive l'evento carico) + `origin` detto/dedotto/importato. **Il campo si chiama `origin`, non `source_kind`**: `chunks.source_kind` esisteva già due file più in là con un altro significato. **`importance` NON entra in RRF** — a k=60 il gap fra ranghi adiacenti è 0.000264 e il consenso fra ranker vale 0.016393 (62×): un boost che sposta qualcosa è già capace di cancellare l'unica cosa che RRF misura, e fallisce in modo invisibile. Agisce invece **dentro** l'espansione del grafo (`activeFacts ORDER BY importance DESC`), che decide quali 6 fatti sopravvivono al taglio. Ricerca: `research/memory-salience-and-fusion.md` — il termine di importance di Park et al. **non è mai stato ablato** (verificato sul testo primario), e l'unica ablation credibile è sulla *ritenzione*, non sul ranking.
3. 🟡 **persona + prompt d'onboarding** — (a) ✅ **cablato** ([PR #3](https://github.com/GiustoPiedimonte/muffin-agent/pull/3)): `voice.md` entra nel prompt, e `authored()` toglie i commenti HTML rivolti all'owner (prima finivano *dentro* l'identità: un'installazione nuova riceveva la pagina che spiega a un umano come scrivere il carattere) e scarta le sezioni non ancora compilate. Ordine: **persona (condivisa) → identity (tua, nel RoT) → voce → operativo**. L'ordine è testato; che "l'ultimo vinca" un conflitto **non** è un meccanismo che abbiamo — è un'assunzione non misurata. (b) 🟡 **bozza da plasmare**: `defaults/persona.md` — puro-muffin, nuovo file perché `identity.md` parte vuoto per costruzione e senza questo un'installazione fresca non ha *nessun* carattere. Si impegna su tre cose discutibili: completa la tua memoria invece di ripeterla · promette solo ciò che i tool del turno fanno davvero (una lista scritta a mano invecchia in silenzio) · afferma il detto e ipotizza il dedotto (la faccia comportamentale della colonna `origin`). **Manca**: il tuo taglio sul contenuto, e `identity.md` è ancora il template vuoto — le sezioni "Chi sei" / "Come ti comporti quando è difficile" / "Il limite che ti do io" sono tue e nessuno può scriverle al posto tuo. Il carattere resta **collaborativo** (io bozzo, tu plasmi; esempi canonici, non overfit) e finché non lo plasmi "sa di mockup" → **NON è l'MVP**.
4. ✅ **una capability agente** ([PR #4](https://github.com/GiustoPiedimonte/muffin-agent/pull/4)) — `web_search` (Tavily, contratto verificato sulla reference ufficiale) + `fs_write` che c'era già. Solo snippet: `include_raw_content`/`include_answer` restano off **con un test** — pagine intere sarebbero superficie d'iniezione per una capability il cui unico compito è *trovare* la pagina (campagna SEO-poisoning lug 2026: 4 modelli su 26 hanno pagato un attaccante). `hostOnly` (una ricerca spende i tuoi crediti, un membro no) e `maxTaint 3` (un risultato tier-3 sporca il turno a 3: con un tetto più basso si potrebbe cercare **una volta sola** per turno e deep-research sarebbe impossibile). Registrata solo se configurata **e** se l'endpoint è in `egress.json`. **Trovato mentre la cablavo — e vale più della feature**: l'allowlist egress **non è mai entrata in funzione in produzione**. `decide.ts` gate sui `resource.kind === 'url'`, i suoi test passano quel resource a mano e sono verdi, ma `loop.ts` costruiva il resource dal solo `args['path']` → ogni tool call arrivava come `{kind:'none'}` e il ramo non è mai stato eseguito; e `http_get` salta l'allowlist all'hop 0 *apposta*, perché crede che il kernel abbia già deciso. Due metà corrette, ognuna in attesa dell'altra. Un turno di gruppo (taint 2) poteva raggiungere qualunque host. Test di regressione **attraverso `runTurn`**, verificato fallire sul commit precedente. Lezione in `docs/lessons.md`.
5. ✅ **spina osservante primo-taglio** — cancello a 2 stadi + segnale-assenza
   (`slice/spina-osservante`, 12 commit, 509 test). **Stadio 1**
   (`core/memory/absence.ts`): chi ha smesso di comparire rispetto al *proprio*
   ritmo. La regola ereditata dal vecchio Muffin («3 menzioni, silenzio >
   media×3») sembra una soglia al 5% e lo è solo se la media è nota: stimata su
   pochi intervalli è un test al **16%** proprio dove il vecchio detector viveva.
   Ora la manopola è **alpha**, il tasso di falsi allarmi, esatto a qualunque
   lunghezza di storia — e la degradazione su code pesanti è misurata, non
   ignorata (0,083-0,105 a σ=1.5, fino a 3,1× a σ=2). **Stadio 2**: un modello
   scrive il messaggio, solo su ciò che ha passato il cancello.
   **`decideProactive` aveva zero chiamanti** — rails, threat model, ADR, test,
   e raggiunto da niente: ora ci arriva `muffin observe`. **La consegna nasce
   spenta**: `muffin observe` mostra, `--send` è un atto esplicito.
   **Aperto, e tuo**: `gone_quiet` tocca ciò che ADR-0028 aveva respinto con la
   tua esperienza diretta. L'emendamento è scritto come **proposta non
   ratificata**, e la sua ratifica dovrebbe aspettare un numero che oggi non
   esiste — `muffin observe` sulla memoria vera dà 0 candidati su 0 entità,
   perché non l'hai ancora usato.
6. ✅ **contesto per-tenant** — il prompt e la lista dei tool sono funzione di
   chi parla (`slice/contesto-per-tenant`, 546 test). È il punto 1 di
   `research/confronto-harness.md §9`. Il difetto: `buildSystemPrompt` non
   prendeva **nessun** parametro tenant e girava una volta sola, quindi un turno
   di gruppo riceveva byte per byte il prompt dell'owner — `identity.md` (il
   patto privato, nel RoT) e i 1.330 caratteri di `persona.md §"Al primo
   incontro"` che dicono all'agente di **chiedere dati personali** «un pezzo per
   volta», nell'unico tenant la cui memoria non è dell'owner. **Il threat model
   non ha mai nominato il prompt come superficie**: lo è, e a valle non c'è
   niente che disfi un'istruzione a chiedere. Ora `agent/context/assemble.ts` —
   il deliverable M1 dichiarato in tre documenti e mai costruito — produce **due
   classi**, `owner` e `group`, assemblate una volta a boot: nessun ricalcolo per
   turno, ciascuna il proprio prefisso cacheabile. Il prompt owner è **pinnato a
   sha256**: se cambia, ogni cache calda si spegne, e il test lo dice invece di
   lasciarlo succedere in silenzio. Il gruppo ha un carattere suo (in codice, non
   in `defaults/`: non è owner-editabile) — sottrarre due sezioni da `persona.md`
   falliva **aperto**, la sezione successiva che qualcuno aggiunge arriva al
   gruppo da sola. Seconda metà: `deps.tools` è filtrato per principal prima del
   modello — un membro vedeva 8 tool `hostOnly` che il kernel avrebbe negato
   comunque, e il messaggio "quel tool non esiste" glieli elencava tutti.
   **Il kernel resta l'enforcement** (`decide.ts:132` non toccato): il lookup del
   tool resta sul registro intero, così un membro che nomina `fs_read` incontra
   `principal_forbidden` col suo codice sulla traccia, non un "non esiste" che
   sarebbe una bugia. Provato **attraverso il connettore telegram vero**
   (`Update` → `drain()` → `runTurn`), rosso verificato sul commit precedente.
   **Resta aperto**: l'epoch flip «so già chi sei» — togliere il primo-incontro
   dal prompt *owner* quando l'owner è ormai noto. È un secondo asse (il tempo,
   non il tenant) e non è in questa slice.

## Il divario M5-bis: i cinque punti per esteso

> Spostato qui dal blocco iniettato il 2026-08-14, **verbatim e senza tagli**,
> per la stessa ragione della sezione sopra: il merge di `slice/gateway` con
> `dev` ha riportato il blocco a **18.700 caratteri contro un budget di 9.875**,
> quindi di nuovo troncato — e di nuovo la vittima era la coda, cioè la lista dei
> file load-bearing. Il dettaglio dei punti **chiusi** è cronaca; nel blocco
> resta ciò che è ancora aperto. Niente è stato cancellato.

**⛔ IL DIVARIO, e perché il Gate 1 è ancora a zero giorni** (aperto 2026-08-11 —
dettaglio in `04-roadmap.md` §M5-bis). M0-M5 è costruito e **non produce un agente
usabile**. Cinque cose, tutte verificate sul codice:
0. **Niente vive senza il terminale** → **ADR-0035** (direzione owner, 2026-08-11:
   *"anche a noi serve un gateway sicuro, serve heartbeat… il concetto di
   occupato, continuo, sempre attivo, sempre vivo"*). ADR-0022 aveva già deciso
   la forma — *"un processo OS per il runtime (gateway, loop, memoria,
   scheduler)"* — e ciò che esiste è un `setInterval` dentro `cli/repl.ts`:
   **undicesima istanza della famiglia, e la più grossa**, perché non è un file
   senza lettore, è la forma del runtime. I cinque vincoli di sicurezza (socket
   locale, kernel unico punto di decisione, principal per ogni turno autonomo,
   nessuna elevazione, visibile e ammazzabile) sono nell'ADR. Lo scheduler muore col REPL. Si legge nei
   verbi: 31 dei 95 comandi di Hermes presuppongono un processo che gira
   (`heartbeat`, `queue`, `steer`, `pause`, `restart`, `undo`, `handoff`); i
   nostri 14 sono tutti "fai e esci". Per questo **"sei un agente continuo" non
   va scritto nel prompt** — va reso vero. Serve un processo che vive senza il
   terminale, più `heartbeat`/`queue`/`steer`/`undo`. Non i 95: la loro
   cromatura è il "TROPPE cose" che l'owner rifiuta.
   ✅ **Il processo c'è** (`slice/gateway`, 2026-08-11, 655 test): `muffin
   gateway run` possiede lo scheduler (il `setInterval` è uscito da
   `cli/repl.ts`), `status`/`stop`/`install` e `doctor` lo vedono, SIGTERM e
   SIGUSR1 drenano entro un budget, `sd_notify` (READY/WATCHDOG/STATUS) è no-op
   senza `NOTIFY_SOCKET`. **Provato eseguendolo**: job creato → gateway avviato
   senza REPL → fire a 24 s → `stop` che drena. Due scheduler non girano mai
   (rivendicazione durevole in `gateway_lock`, letta dal REPL che cede il ticker
   e lo dice); l'orizzonte è un **battito**, non un'ora, e un `kill -9` non
   incastra il comando. **Resta**: `queue`/`steer`/`heartbeat`/`undo` (vogliono
   il protocollo sul socket, non costruito), il trigger a soglia del punto 1 qui
   sotto, la consegna remota. Dettaglio in `04-roadmap.md` §M5-bis punto 0.
   *(Chiude anche il "da verificare prima del deploy VPS" in fondo a questo file:
   sotto systemd stdin è `/dev/null` e il REPL uscirebbe subito — il gateway non
   ha readline, quindi la modalità di servizio che mancava adesso esiste.)*
1. 🟡 **Il consolidamento non partiva mai — ora parte, ma solo il primo dei due
   meccanismi.** `ingestPending` aveva un solo chiamante, `muffin memory
   extract`, a mano. **414 fatti nel vecchio contro 0 nel nuovo.**
   La DoD di M5 lo richiedeva ed è **non soddisfatta**: M5 è stato chiuso senza.
   ⚠️ E servono **due** meccanismi, non uno: il vecchio non consolidava di notte,
   estraeva **a ogni turno in asincrono** e il dream faceva manutenzione sopra.
   Un solo job notturno darebbe un Muffin che ti conosce con 24h di ritardo.
   **Priorità 1**: senza, memoria/importance/origin/assenza sono inerti.

   ⚠️ **Due correzioni dalla ricerca del 2026-08-13**
   (`research/consolidamento-due-meccanismi.md`, misurate sui dati veri).
   (a) La latenza del vecchio **non era «minuti»: era 11,8 s di mediana** su
   2.264 item — la media a 48 s la trascina la coda. A dodici secondi il fatto è
   a posto *prima del messaggio successivo della stessa conversazione*, che è un
   prodotto diverso; un meccanismo che atterra a minuti sarebbe una regressione.
   (b) **«I fatti restano a zero» dice meno del vero**: nessun altro percorso
   indicizza un episodio, quindi finché non parte **il recall è solo-keyword per
   tutta la vita dell'installazione** — la metà vettoriale di RRF non ha chi la
   alimenti. Non manca un livello, ne mancano due.

   ✅ **La fondazione è corretta** (`6ddba7c`, 2026-08-13, 102 test su
   `core/memory`): l'episodio a contenuto vuoto non resta più dovuto per sempre
   (bloccava il batch **riportando successo**); il marcatore è per-episodio e non
   per-batch; due esecuzioni non estraggono più lo stesso insieme (lock di corsia
   su `core/lock/durable.ts`, non copiato); le entità non si biforcano più su
   `kind`; e il verdetto `review` del giudice — l'esito «decida un umano» — ha un
   registro invece di morire su stderr.

   ✅ **Il primo meccanismo esiste** (`slice/gateway`, 2026-08-13, **ADR-0038**,
   751 test): **coda d'inattività a fronte discendente** armata dalla fine di ogni
   turno (`LoopDeps.onTurnEnd`, il post-turn hook che mancava), con **tetto a
   conteggio** come rete. Le due costanti sono **misurate sul corpus vero**
   dell'owner (4.107 episodi, marzo→luglio), non prese da un peer: **20 s** perché
   solo l'1,0% dei messaggi consecutivi dell'owner dista meno di 20 s e perché
   ancorata alla risposta la coda fa **−26% di chiamate** contro il per-turno del
   vecchio (che rendeva il 3,4%), mentre a 60 s si supererebbe la mediana di 56 s
   fra risposta e messaggio dopo — cioè si perderebbe la proprietà che gli 11,8 s
   compravano; **tetto 12** perché la sequenza più lunga senza pausa nel corpus è
   7. Nella stessa slice: la **spesa della corsia light entra nel budget** (era
   zero per `/spend` e per il cap — chiude anche il punto ⚠️ di M5-bis §7 sul
   `temperature: 0` fuori dai profili), la **cucitura per-tenant è rifiutata con
   due test** (solo host consolida: `extractFacts` deriva il parlante da `role`),
   e la corsia **si vede** (`consolidation_runs` in `memory stats` e `doctor`).
   **Provato eseguendolo**: dal REPL vero, turno → risposta subito → fatto in
   memoria a **+20,0 s**; dal **gateway senza REPL**, job → estrazione a **+20,0
   s**. E l'indice vettoriale è passato da vuoto a `5 chunk · 5 vettori, in sync`.

   ✅ **Il secondo meccanismo esiste** (`slice/gateway`, 2026-08-14,
   **ADR-0040**, 870 test): la manutenzione. La prima cosa che ha prodotto è una
   correzione al nome — **«periodica» era sbagliato**. Elencando cosa dovesse
   fare, ogni voce è risultata guidata dai **dati** e non dall'orologio: un
   arretrato esiste o no, un duplicato esiste o no, una riga `review` è aperta o
   è stata risolta. Niente in questo schema cambia perché è passato un giorno,
   quindi un cron sarebbe un timer senza niente che dipenda dal tempo — e
   nessuno dei dodici sistemi letti ne gira uno. Il grilletto resta la stessa
   coda d'inattività, nel runtime.
   La regola di costo che governa tutto: nel vecchio il dream era la **metà
   piccola** (⬤ 100 report contro 2.438 righe di work queue, il 4%). Quindi
   **la manutenzione non spende niente** — nessuna chiamata al modello, SQL su
   righe già scritte. L'unica parte che chiama un modello è il drenaggio, e paga
   estrazioni che la corsia viva avrebbe pagato comunque: il totale non cambia,
   cambia *quando*.
   - **Drenaggio.** Dopo una pagina **piena** che ha **fatto progresso**, la
     corsia si ri-arma e prende la successiva, allo stesso passo della coda viva
     (nessuna costante nuova: il tetto di costo diventa una proprietà della
     forma). Perde sempre contro un turno. La condizione d'arresto è il
     *progresso* (`marked > 0`), mai un conteggio di pendenti — un episodio che
     fallisce l'estrazione in modo permanente resta in testa per sempre, e un
     drenaggio guidato da `stats.pending` ripagherebbe quella pagina ogni venti
     secondi: **lo stesso fallimento che ADR-0038 aveva già scartato**, entrato
     da un'altra porta. E **non** si riordina al più-nuovo-per-primo, che è la
     mossa ovvia: `reconcile` sceglie il candidato per `recorded_at`, quindi
     estrarre fuori ordine farebbe **dis-correggere una correzione**.
   - **Deduplica senza soglia.** Solo chiave esatta normalizzata (maiuscole,
     spazi, punteggiatura finale): lo 0,85 del vecchio non porta fra embedder, e
     la ricerca lo misura (99,00% di falsi positivi a un ingenuo 0,7 su due
     modelli comuni). ⬤ E il corpus chiede esattamente questo gradino: sui
     quattro mesi del vecchio i gruppi (soggetto, predicato) con più di un valore
     attivo erano **2 su 308 fatti attivi**, e **tutti e due erano duplicati
     esatti**. Si ritira con `supersede`, **mai DELETE** — e con `valid_to` non
     toccato, perché un duplicato non ha mai smesso di essere vero: non era una
     verità separata.
   - **Il registro `review` letto e risposto.** `muffin memory review` +
     `review keep <fact-id>`, più la riga in `memory stats`, in `doctor` e al
     boot. «Aperta» è una **join** (entrambi i fatti ancora attivi), non una
     colonna di stato: una domanda che la conversazione risolve da sola esce
     dalla lista senza che nessuno scriva niente. Rispondere è un `supersede`, e
     lo fa **l'owner** — ADR-0032 §9 resta dov'era.
   **Provato eseguendolo**: 45 episodi di arretrato, un turno, poi silenzio →
   `idle` a +20 s, `drain` a +44 s, `drain` a +64 s, gli episodi dovuti scesi a
   **0**, e nessuna quarta pagina perché la terza era corta.
   ⛔ **Resta aperto**: dream/compattazione (manca il *consumatore* —
   `profiles`/`digests` hanno zero lettori) e l'audit dei predicati a metà.
   **Rifiutato e non rimandato**: il decadimento della confidenza — nessun tasso
   difendibile, ⬤ nessun lettore (l'unica soglia sulla confidenza è
   `extract.ts:176`, *prima* della scrittura), e con un lettore sarebbe una
   credenza irrecuperabile senza `expired_at` né `superseded_by`, cioè una
   cancellazione senza traccia. Una **passata di scadenza** non è costruita
   perché ⬤ non ha niente da scadere: `valid_to` è scritto solo da `supersede`,
   che scrive anche `expired_at`. Limite dichiarato che resta: **`muffin run`
   headless non consolida** (timer `unref`'d), ora meno caro perché il primo
   processo di lunga vita drena tutto invece di una pagina.
   Resta aperta e **è dell'owner** la terza decisione: se il tool
   `ricorda` scrive o propone — cancella ADR-0032 §9, e nel vecchio quel percorso
   ha fatto il 9,7% dei fatti **decadendo a zero in quattro mesi**.
2. ✅ **`thinking` era dichiarato nei profili e mai passato** (nono caso della
   famiglia). Chiuso il 2026-08-13 (`6d2cd21` + giro di judge), e il rimedio
   scritto qui era **sbagliato**: passarlo com'era dichiarato avrebbe dato un 400
   a ogni turno frontier, perché `{type:'enabled', budget_tokens}` è rifiutato da
   4.7 in poi — cioè esattamente i glob di `frontier.json`. Era una migrazione ad
   `adaptive`, non un cablaggio. Nella stessa passata sono usciti due difetti
   peggiori: i **blocchi di thinking venivano buttati via** dall'adapter, quindi
   dalla seconda iterazione di ogni turno con tool il ragionamento del modello era
   perso (e con lui i cache hit che i doc attribuiscono proprio a quei blocchi); e
   `temperature: 0` era cablato nel loop, che su Opus 4.7+ è un 400 dichiarato.
   ✅ **Chiuso il 2026-08-13 (ADR-0038)**: `core/memory/{extract,judge,rerank}.ts`
   cablavano `temperature: 0` **fuori** dal sistema dei profili — legale finché il
   light è haiku 4.5, un 400 il giorno che `--light-model` punta a qualcosa 4.7+,
   e nessuna modifica ai profili poteva ripararlo. Rimediato dal confine che il
   punto 1 doveva costruire comunque per il budget
   (`agent/providers/light-lane.ts`): la corsia light si costruisce dietro un
   wrapper che fattura **e** applica il `sampling` del profilo del modello light.
3. **Non è governabile da dentro**: 5 slash, nessun `muffin config`, nessuna
   dashboard, settings a mano in JSON (alcuni nel RoT, quindi con reseal).
   → **ADR-0036** decide dove passa la linea (sigillato = terminale, il resto lo
   guida Muffin) e si dà una **precondizione bloccante**: niente superficie di
   scrittura conversazionale finché il tetto di spesa non è sigillato davvero.
   ✅ **Precondizione sciolta il 2026-08-13 (ADR-0039)** — e sono due difetti
   della stessa forma, chiusi insieme. **(a)** `BudgetEngine` nasceva da
   `config.budget`, **fuori dal manifest**, mentre il sigillato
   `rot/budgets.json` portava gli stessi numeri per duplicazione: il sigillo
   proteggeva una copia. Ora `core/rot/budgets.ts` è l'unico lettore,
   `config.budget` **non esiste più** (`CONFIG_SCHEMA_VERSION` 2, migrazione in
   memoria — rifiutare la versione vecchia avrebbe murato l'unica installazione
   che esiste), e **l'insieme sigillato resta di cinque file**, quindi il
   manifest reale non è invalidato. **(b)** `denyRead` nominava solo
   `~/.muffin/secrets` mentre ADR-0030 metteva la chiave in una `.env` dentro
   `root`, e `fs.read` (low, nessun `maxTaint`) ha tetto **3**: con un solo
   risultato tier-3 in contesto, `fs_read(".env")` restituiva la chiave in
   chiaro. La chiave si sposta in `$XDG_CONFIG_HOME/muffin/secrets/`
   (`muffin secret set --persist`), `denyRead` copre entrambi gli store più la
   `.env`, e il loop `uninstall && init` continua a ritrovarla. **La superficie
   di scrittura conversazionale si può ora costruire.**

   ✅ **I tre pezzi che l'ADR chiedeva, in ordine di priorità** (slice/gateway,
   in lavorazione — non committato, 830 test contro 781 di partenza).
   Dettaglio completo in `04-roadmap.md` §M5-bis punto 3; qui solo il
   riassunto. **(a) `muffin config`**, sola lettura per costruzione
   (`core/config/inventory.ts` + `cli/config.ts`): ogni manopola, valore,
   file di origine, se sigillata — forma presa da `aws configure list` dopo
   aver guardato anche `git config --list --show-origin` e `gh config list`
   (`docs/PRACTICES.md` §3). La lista **deriva dall'oggetto `Config` reale**
   invece di un elenco scritto a mano: provato aggiungendo `models.deep` a un
   `config.json` senza toccare `inventory.ts` — compare da solo. Il
   "sigillato" è un fatto sul file, non sul parse di oggi: provato rompendo
   `rot/budgets.json` e vedendo il valore cadere sul compilato mentre la
   colonna resta "sì". **(b) Il primo avvio dice cosa ha dedotto.**
   L'inferenza del provider (`inferProvider`) **era già cablata dentro
   `cmdInit` dal 2026-08-09** (`eb45b86`, quattro giorni prima di questa ADR)
   — la frase dell'ADR e del mandato di questa slice sul default silenzioso
   ad `anthropic` descriveva uno stato già superato, verificato leggendo il
   codice prima di toccarlo. Quello che mancava davvero: un'inferenza
   riuscita non lo diceva mai. Ora `chooseProvider`/`describeProviderChoice`
   (`cli/onboarding.ts`) annunciano sempre la scelta. **Provato eseguendo il
   binario reale** su una pty vera (`expect`, non solo i test): chiave
   `sk-or-v1-…` incollata al primo avvio → `config.json` con
   `provider.kind: "openai-compat"` e la riga *"dedotto dalla chiave"* nel
   transcript, prima degli step di `runInit`. Trovato e chiuso nello stesso
   giro: il controllo anti-token-Telegram era dentro
   `if (apiKey && !providerFlag)`, quindi un `--provider` esplicito lo
   bypassava. **(c) Alias italiani selettivi**: `memoria/lavori/segreto`,
   esattamente i tre che l'ADR nomina, una mappa sola davanti allo switch.
   **Scoped apposta**: la spazzata italiano copre `USAGE`, il primo avvio,
   `muffin config`, gli errori top-level — non le sei `*_USAGE` dei
   sotto-comandi né `cli/doctor.ts`, già miste da prima e ognuna con la
   propria distesa di test da verificare prima di poter tradurre senza
   romperli. **Resta aperto**: nessuna superficie di scrittura
   conversazionale (non era lo scopo — sola lettura per ADR-0036), e nessun
   tool in `agent/tools/` legge ancora `listConfigKnobs` — posizionata in
   `core/` apposta perché possa, ma quel tool non esiste ancora.
4. **Niente resume a grana di turno né retry sul lungo** — l'unico asse su cui la
   ricerca peer ci dà torto (`research/confronto-harness.md` §2.3).
5. **Nessun eval d'accettazione a costo quasi zero** — end-to-end con provider
   finto + smoke piccolo sul modello vero.

**Confronto coi peer, fatto** (`research/confronto-harness.md`, quattro passate
verificate su Hermes/OpenHands/Goose/Cline/Letta): la scommessa architetturale
regge su cinque assi su sei, spesso validata dai loro stessi numeri; l'unico
contraddetto è il resume (punto 4). Ne sono usciti ADR-0032/0033/0034 e
l'emendamento a 0028 con la contro-posizione di Hermes #17459. **ADR-0032 è già
emendato dall'owner**: memoria ibrida (il tool scrive il contenuto, l'harness
governa il timing) con riconciliazione fra tool e pipeline.

**Inventario vecchio-nuovo fatto** (`research/inventario-vecchio-nuovo.md`, 86
righe con verdetto — 41% presente · 29% tolto di proposito · 23% manca e serve ·
8% era slop). Il contro-numero che giustifica il tetto sui tool meglio di
qualunque argomento: dei 47 tool del vecchio, **16 mai invocati** e **28 su 47
meno di cinque volte in quattro mesi** — sei tool hanno fatto il lavoro.

**Confronto con la consulenza esterna, fatto** (`research/confronto-gemini.md`,
2026-08-14): una consulenza generica di design d'agente (Gemini 3.6 Flash, nove
turni owner) confrontata riga per riga col codice. **Non sposta l'ordine di
lavoro**: delle ~25 raccomandazioni, 14 descrivono cose già costruite (spesso
più severe), 5 erano già decise contro con evidenza scritta, 2 sono sbagliate
per la nostra forma (event bus / microservizi agentici — contro ADR-0022;
classifier routing sui tool — due retrocessioni in casa), 4 sono buchi veri e
piccoli (§M5-bis "Dal confronto esterno"). **Il contributo che vale non è una
feature**: "voce e mani" applicato alla chat dà ad ADR-0035 il criterio d'uscita
dal lato dell'esperienza — *un turno lungo torna entro 500ms e consegna dopo*
(→ ADR-0035 §revisione). Conferma esterna su due assi: niente critico LLM
(=ADR-0034) e la corsia asincrona di estrazione fra i componenti fondamentali
(=la nostra priorità 1, costruita e attaccata a niente). Mai nominati da lei:
provenienza/taint, multi-tenancy, bi-temporalità, rug-pull MCP, insieme chiuso
di trigger, Root of Trust, il costo della cache come vincolo di design.

## Sessione 2026-08-16 — l'unità è l'agente continuo

La conversazione owner su Muffin e Hermes è stata riletta come critica di
prodotto, non come istruzione da eseguire. **ADR-0045** fissa la decisione:
modello, chat, app e device sono harness/surface; l'unità persistente è un solo
agente con tre assi — fare, capire, essere presente. La misura si sposta dalla
parità di feature alla sostituzione verificata di un'interfaccia diretta.

Il giro ha letto anche ciò che non è in `dev`: branch puliti `slice/hermes` e
`slice/taint-in-ingresso`, più i worktree sporchi di turno sospeso, superfici,
memoria temporale e acceptance. Conseguenza: i documenti possono registrare la
direzione e le dipendenze, ma non attribuire a `dev` meccanismi che vivono solo
in quei worktree. Il codice di `agent/loop.ts` non è stato duplicato in questa
slice: `slice/turno-sospeso` lo sta già riscrivendo e resta il luogo che deve
provare B2–B5.

Aggiornati `THESIS.md`, `DESIGN-PRINCIPLES.md`, `foundations/VISION.md`,
`ORCHESTRATION.md`, roadmap, inventario e stato. `foundations/INVARIANTS.md` e
`UNDERSTANDING.md` sono ora marcati esplicitamente come corpus ereditato, per
non scambiare claim del vecchio Muffin per garanzie del runtime corrente.

La direttiva successiva dell'owner è fissata in **ADR-0046**. L'autorità di una
surface deriva solo da un subject-id stabile autenticato e da un binding
protetto; nomi, bio, username, stanze, foto e contenuto non eleggono l'owner.
Ogni campo model-visible — inclusi metadata, immagini, OCR, audio e derivati —
attraversa un parser tipizzato con provenienza e taint. Parsing non equivale a
fiducia. L'inventario aggiunge B15/B16 come blocker: Telegram prova già
`from.id` contro l'impersonazione, ma il binding è ancora config ordinaria e
l'envelope universale non esiste.

La stessa sessione ha reso esplicito il ritmo di integrazione in
`BRANCHING.md` e `ORCHESTRATION.md`: commit recuperabili per unità verificabile,
draft PR quando la decisione è fissata, review al checkpoint completo, merge in
`dev` solo dopo verdetto terminale e verifica separata prima di `main`.

**Verifica del checkpoint.** `npm run build` è verde. `npm test`, eseguito fuori
dal sandbox Codex perché Seatbelt deve poter applicare davvero i profili macOS,
chiude **96 file: 1.075 test passati, 1 saltato, 0 falliti**. La prima esecuzione
ha trovato un fixture PDF legato al giorno di calendario: il tool chiedeva il
path del 15 agosto mentre il connector lo nominava col giorno corrente. Il test
ora pinna l'orologio del connector e torna verde sul percorso di produzione.
Mappa e handoff sono nuovamente eseguibili: 565 ancore verificate; i blocchi
iniettati entrano interi nel limite e il test del hook fallisce se uno dei due
viene troncato.

Graphify ha prodotto localmente il grafo usato per interrogare relazioni fra
loop, turn store, gateway, policy, memory e surface; gli artefatti generati sono
ignorati da git. Il report non è un certificato: segnala 553 archi con endpoint
non risolto, quindi il grafo resta utile per navigazione ma non autorizza claim
di copertura completa.

Checkpoint pubblicato: PR **#30**, `slice/agente-continuo` verso `dev`. Il primo
judge ha restituito `ADJUST`: CI descritta falsamente, stato legato a un hash
volatile, prova anti-impersonazione solo isolata e fonte ADR non persistita. La
correzione aggiunge la prova sul percorso inbox → connector → loop e riallinea i
documenti. Il test nuovo diventa rosso mutando `from.id` in `chat.id`; dopo il
ripristino, build, 31 test mirati e suite completa sono verdi. Il secondo judge
ha emesso `MERGE` senza defect o garanzie non provate; CI verde e PR fusa in
`dev`. Build e suite sono poi tornate verdi sul worktree integrato. Quel
worktree contiene `.codex/` non tracciata, che duplica due suite di hook: il run
integrato conta quindi 98 file e 1.103 passati, mentre il tree Git pulito e
byte-identico al merge ne conta 96 e 1.075; in entrambi resta 1 saltato.
La promozione dell'insieme è aperta separatamente come **PR #32** `dev`→`main`;
il suo primo judge integrato ha restituito `ADJUST` con cinque difetti che le
review di slice non vedevano: allegati di gruppo indicizzati in `host`, ZIP
senza bound sull'output, parti DOCX fuori dal corpo perse, symlink esterni
indicizzati ma non rileggibili e `riprendi` che su errore GitHub dichiarava
riapribile lavoro già fuso. La correzione viaggia su una slice separata; PR #32
resta non autorizzata finché un judge nuovo non segue l'insieme corretto.

Il primo judge della correzione ha trovato la seconda metà del difetto tenant:
`reindex(tenant)` scansionava ogni file della directory condivisa, quindi un
allegato di gruppo importava anche note host e file di altri gruppi. L'ingresso
ora chiama `reindexPath(tenant, savedPath)`; il full scan resta manutenzione.
La prova integrata prepara tre domini nello stesso vault e diventa rossa se il
cablaggio di produzione torna alla scansione completa.

## Sessioni 2026-08-09

**Sessione 2026-08-09 (questo giro).** `muffin` è un **comando installabile** (bin+dist+`install.sh` collision-safe Mint, `LICENSE` MIT); **onboarding** (init interattivo, inferenza provider dal prefisso chiave, first-run, guardia bot-token, `muffin uninstall`); **dev-setup** (`.env` caricata dalla CWD via `process.loadEnvFile` nativo, `MUFFIN_HOME` dev/prod); pushato **privato**. **Knowledge base cognitiva** creata (`knowledge/`, il corpus del vecchio che il blueprint aveva perso). **MVP #1** (recall) chiuso. Ricerche persistite: `research/{system-prompt-architecture,capability-surface,eu-ai-act-gdpr,onboarding-first-run,local-dev-setup}.md`. ADR nuovi: 0026-0030. **EU AI Act** (research): fuori-scope come deployer per uso personale, Art.50 coperto da HITL, serve avvocato pre-rilascio-pubblico.

**Sessione workflow + MVP #2 (2026-08-09, sera).** **Il compact non porta più via lo stato**: `.claude/hooks/inject-state.mjs` inietta questo blocco a ogni SessionStart *compreso il source `compact`* — Claude Code ri-legge da disco solo il `CLAUDE.md` di root, e un doc annidato dietro un puntatore è esattamente ciò che non torna. Path risolti da `import.meta.url` (il cwd si resetta fra i turni; `CLAUDE_PROJECT_DIR` dentro un worktree è **non documentato** — verificato). **Onestà sul meccanismo**: `PreCompact` NON può iniettare contesto né far agire il modello (verificato sulla reference) → il ri-grounding è deterministico, il *flush* resta disciplina, e `PRACTICES.md` §7 lo dice invece di implicare una garanzia che non c'è. Aggiunte §7-9 (stato in STATE · converge-prima-di-ricercare · puro-muffin vs il-tuo-muffin). **MVP #2 chiuso** (sopra). **Routine settimanale ricerca→proposta→PR** specificata in `proposals/README.md`: propone e basta, **non scrive codice** — il ciclo è proposta → l'owner reagisce → si itera → si decide se implementare. **Non attiva: 403, l'ambiente cloud non ha accesso al repo privato** (permesso da dare, non scelta di design). **Benchmark**: `research/benchmark-comparabilita-harness.md` — uno solo vale la pena, **AgentDojo** (testa il kernel, non il modello; ~$2-5/run; nessuna capability che abbiamo tagliato). Sulla memoria **non girare niente**: il finding interno regge (LoCoMo ha il 6.4% di ground truth corrotta; la disputa Zep-vs-Mem0 è il caso di scuola di "stessa benchmark, harness diversa, numero diverso"). Trappola confermata con numeri: lo scaffold da solo muove GAIA fino a **28 punti** a modello invariato (arXiv:2606.08529).

## Aperto (owner)

1. **Approvazione delle 45+ assunzioni** in `08-assunzioni.md`.
2. **Modello consumer di riferimento**: rivalutare **a metà agosto** se escono i pesi di Qwen 3.8 (27B); altrimenti eval breve tra Qwen3.6-27B/35B-A3B, GPT-OSS-20b e l'incumbent Gemma-4. Budget contenuto per direttiva owner.
3. **Push/PR**: tutto è committato solo in locale, su entrambi i repo.

Risolto (2026-08-07): la tesi pubblica — opzione A per direttiva owner, `THESIS.md` e `DESIGN-PRINCIPLES.md` spersonalizzati vivono in `muffin-next/docs/`.

## Note operative

- Branch `claude/muffin-muffinos-refactor-37eda9`, worktree `serene-perlman-ad15a2`.
- Namespace: npm `muffin` occupato → pacchetto scoped; org GitHub occupati → repo su account personale; `/usr/bin/muffin` esiste su Linux Mint (window manager) → l'installer rileva la collisione del binario.
- Da verificare sul VPS attuale: `bubblewrap` installato? Senza, il sandbox del Muffin in produzione è un no-op nonostante il flag sia ON.
