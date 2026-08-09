# 01 — Verdetti sulle ipotesi di Livello 1

> Ogni ipotesi del BRIEF: **CONFERMA / MODIFICA / SCARTA** + argomento + alternativa dove scartata. Base di evidenza: `00-findings.md` e i report `research/a1..a5`; evidenza interna aggiuntiva citata puntualmente. Le direttive del checkpoint (2026-08-04) sono incorporate: feature-folders, harness multi-tier su modelli consumer, UI rich-media per connector, nome condizionato al system layer.
>
> Le decisioni qui anchorate hanno ciascuna un ADR in `adr/` con il campo Reversibilità.

---

## V1. Stack: ibrido Python (core/AI) + TypeScript (gateway) → **SCARTA → runtime unico TypeScript/Node**

**Argomento.**
1. *Prova d'esistenza*: Muffin oggi fa tutto ciò che il blueprint richiede in TS puro — 193K LOC, grafo bi-temporale su better-sqlite3+sqlite-vec, embedding via HTTP (Ollama), loop agentico, transport tipato (A1). Nessun pezzo ha mai richiesto Python: l'inferenza sta sempre dietro un confine HTTP (API cloud o server locale), non in-process.
2. *Vincolo del manutentore singolo*: due runtime = due toolchain, due catene di deploy, un boundary di serializzazione da tipare e debuggare. "Un design che richiede un team ha fallito anche se è corretto" (BRIEF). Il costo è permanente; il beneficio (librerie AI Python) non si concretizza mai se non si fa training — e non si fa training (06).
3. *Ecosistema 2026*: MCP TypeScript SDK v2 è Tier-1 sulla spec 2026-07-28 (A3 §1.3); SDK ufficiali Anthropic/OpenAI TS; l'intero storage (better-sqlite3, sqlite-vec) è nativo.
4. *I peer non mostrano correlazione linguaggio→successo* (TS OpenClaw 385K★, Python Hermes ~215K★, Rust Goose 52K★ — A2): il linguaggio non è il differenziale; la padronanza del manutentore sì, e l'owner è TS-nativo.
5. *"Muffin costruisce Muffin"* pesa nella stessa direzione: l'agente lavorerà sul codice che l'owner sa leggere alle 3 di notte.

**Cosa si perde e come si compensa**: le librerie di memoria Python (Graphiti) — ma non le adotteremmo comunque (richiedono Neo4j/FalkorDB, contro l'invariante single-instance SQLite; il pattern bi-temporale è già replicato in casa, A4 §2.1/§5). **Confine**: nessun secondo runtime nel core; processi sidecar (qualunque linguaggio) ammessi solo come tool esterni opzionali dietro contratto CLI/HTTP, etichettati impalcatura.

**Corollario (direttiva owner): organizzazione per feature, non per layer.** Ogni capability è una cartella che contiene i propri tipi, schema SQL, prompt, test e doc (`memory/`, `agent/`, `connectors/telegram/`, …). Vietati i cesti tecnici globali (`/types`, `/constants`, `/utils`); ammesso un solo `shared/` minimo con giustificazione per file. Il "gateway" è una cartella (runtime + routing + registry connector), non un file. → ADR-0002; albero completo in `04-roadmap.md`.

---

## V2. Modelli (sintesi; trattazione completa con numeri in `06-modelli.md`)

- **Tier → MODIFICA rispetto allo status-quo**: il lavoro quotidiano (classificazione, estrazione, recall, riassunto) vive nella fascia $0.10–2/Mtok senza gap dimostrato; il frontier si usa on-demand (coding, ragionamento lungo, dream). Due lane statiche: `main` e `light`, + `deep` esplicita.
- **Approvvigionamento → CONFERMA (API) + profilo locale consumer first-class**: gli abbonamenti consumer sono esclusi dai ToS per l'uso headless (00 #7). Il locale non è ideologia ma profilo supportato: classe MoE ~20-35B-A3B su hardware 16-128GB (A5 §3). Lezione interna da non ripetere: "local-first" come etichetta — 0/1689 turni locali tracciati nel Muffin attuale (consumer-model-slate 2026-07-06). Nel nuovo design il profilo locale o è **vero e testato in CI di capability**, o non si dichiara.
- **Collocazione → il routing dinamico è impalcatura, SCARTATO**: post-mortem Manifest (7.000 utenti, 4 mesi: "la complessità non si deduce dal prompt", "il caching batte il routing", qualità degradata dal model-switching — A5 §7); trend prezzi >10×/12-18 mesi erode il delta che il router catturerebbe. Collocazione = **statica per funzione** (lane), decisa in config, con escalation esplicita richiesta dal loop (mai da un classifier).
- **Harness multi-tier (direttiva owner)**: l'harness non si progetta su Sonnet e poi "si spera" su Gemma. Si definisce un **capability floor** contrattuale (tool-calling affidabile su N tool esposti, X turni di orizzonte, context utile Y) e la CI di capability esegue gli stessi scenari su **due modelli di riferimento**: uno frontier-API e uno consumer-locale. Le stampelle per il tier basso (meno tool esposti, output strutturati più rigidi, orizzonti più corti, recovery cascade) vivono in un **profilo per-modello dichiarativo**, non nel core — così si smontano senza riscrittura (07). Prior art: la recovery cascade di Hermes (nudge → prefill → retry ≤3 → provider switch) è per-modello, non cablata nel loop.
- **SDK → formato OpenAI-compatible come lingua franca + adapter nativo Anthropic; nessun framework.** È il pattern di fatto di tutto il campo: Ollama/llama.cpp/vLLM/OpenRouter/DeepSeek espongono OpenAI-compat; Muffin oggi usa un solo SDK `openai` per tre provider (A1); Goose fa 15+ provider dietro la propria astrazione sottile (A2); nessun peer usa LangChain-e-simili. L'adapter nativo Anthropic serve dove l'OpenAI-compat livella verso il basso: prompt caching esplicito (write 1.25-2×/read -90%), extended thinking, 1M context. Interfaccia interna: **una** (`ChatCall` tipata nostra), due implementazioni (openai-compat, anthropic), punto. → ADR-0007/0008.

---

## V3. Self-learning / self-improving → **CONFERMA l'obiettivo, con il solo meccanismo che l'evidenza supporta: cricchetto eval-gated**

Risposte alle sei domande del BRIEF:

1. **Segnale di apprendimento** (in ordine di affidabilità): (a) correzioni esplicite dell'owner — first-class, sempre; (b) esiti osservabili verificabili (tool fallito/riuscito, test passati, task completato/abbandonato) — è il segnale di Reflexion, l'unico con guadagno misurato (+11 punti HumanEval, A5 §8.6); (c) feedback implicito (proposta ignorata, risposta riscritta) — solo come *candidato* a bassa confidenza che richiede conferma, mai da solo. **Mai** apprendimento da contenuto di gruppo non fidato (poisoning, A4 §6). Il ciclo notturno non è un segnale: è il *momento* in cui i segnali (a-c) vengono consolidati.
2. **Dove si deposita** (reversibilità decrescente, scrivibilità decrescente): memoria/TKG (sempre scrivibile, con provenance) → skill library SKILL.md (agent-writable dietro gate di qualità, pattern teacher-escalation di Odysseus: persiste solo se passa l'eval che ha rilevato il gap — A2 §5) → prompt e soglie di comportamento (scrivibili SOLO via cricchetto, sotto) → routing/lane config (idem) → codice e Root of Trust (**mai** a runtime: solo PR + merge dell'owner).
3. **Miglioramento vs deriva = il cricchetto**: una modifica self-inflitta a prompt/config (i) è una **proposta versionata**, (ii) passa la suite eval di riferimento PRIMA di attivarsi (GEPA usa esattamente questo schema: mutazione riflessiva + selezione su eval, +13% misurato con 10 esempi — A5 §8.1), (iii) si attiva con finestra canary e revert automatico su regressione, (iv) lascia audit trail. Senza eval che copra la dimensione toccata, la modifica **non è ammessa** (si può solo proporre all'owner). Evidenza contraria incorporata: self-rewarding senza terra esterna degrada (ICLR 2024/ACL 2025, A5 §8.5) — quindi il giudice del cricchetto non è mai il modello che si giudica da solo.
4. **Cosa richiede approvazione**: memoria e skill nuove → autonome con audit; modifiche eval-gated a voice/prompt/soglie → autonome con **notify-after e undo** (il tier-2 "act-notify-undo" già validato in casa, ADR-159); tutto ciò che tocca RoT, permessi, egress, spesa → owner, sempre. La linea si sposta col tempo? Sì, ma il **ladder di fiducia è esso stesso config nel RoT**: l'agente non può auto-promuoversi di livello.
5. **Root of Trust**: l'auto-miglioramento non lo tocca. Il RoT evolve solo via modifica del repo (PR) + intervento esplicito dell'owner + riavvio. L'agente può *leggerlo* e *proporne* modifiche via PR (V4).
6. **Prior art, dimostrato vs narrativa**: applicabile single-user senza infra RL = GEPA (prompt), Reflexion (lezione-da-fallimento), skill library Voyager-style; NON applicabile = SEAL (RL+pesi); RSI autonoma = narrativa senza evidenza (A5 §8.9). Il design sopra usa esclusivamente la prima categoria.

---

## V4. Muffin costruisce Muffin → **CONFERMA come requisito, con confini precisi**

- **Bootstrap**: la soglia minima è fine **M3** (kernel + loop + primitivi + tracing): accesso al repo (clone dedicato, mai il working tree dell'owner), esecuzione test, lettura dei propri trace. Prima di M3, MuffinOS si sviluppa con harness esterni (com'è ora). Primo compito su se stesso: non feature — *report*: leggere i propri trace e produrre l'analisi settimanale dei propri fallimenti (dogfooding dell'introspezione, rischio zero).
- **Coding: orchestrare, non reimplementare.** L'evidenza è unanime: il coding-harness è problema risolto altrove e costoso da rifare (regola "non riscrivere roba risolta"). MuffinOS espone una capability `dev` che (a) per lavori piccoli usa il proprio loop con i primitivi (edit/test/commit su branch), (b) per lavori grandi **orchestra un harness maturo via API a consumo** (es. Claude Agent SDK con API key) — mai via abbonamento consumer headless (ToS, 00 #7; il pattern ohmo è strutturalmente a rischio, A2 §4). Output sempre: branch + PR, mai merge autonomo.
- **Ciclo chiuso vs virtuoso**: il rischio di autoconferma si rompe con due terre esterne: (i) test/eval eseguibili come fitness (AlphaEvolve insegna che il pattern funziona SOLO con fitness eseguibile — A5 §8.2), (ii) review umana obbligatoria sul PR. I trace propri sono dati di *diagnosi*, mai di *promozione automatica*.
- **Confine RoT**: può leggere il RoT, proporne modifica, aprire PR; non può applicarla a runtime — il punto esatto dove V3.5 e L0-3 si toccano: il write-path del RoT passa per git+owner, non per il filesystem runtime dell'agente.
- **Host-only senza eccezioni**: la capability `dev` richiede principal=host E contesto non-tainted (03). "Proponi un miglioramento" scritto in un gruppo può al massimo diventare un *item in coda di review per l'owner*, mai un input diretto alla capability.

---

## V5. Orchestrazione: graph workflow dove serve → **SCARTA i graph framework; MODIFICA in "pipeline tipate dove la struttura è nota, loop per il resto"**

Argomento: verdetto interno già dato con audit (2026-07-16: "non migriamo a un framework agentico", A1 §11) + nessun peer con trazione usa LangGraph/simili (tutti loop hand-rolled, A2) + il costo di un framework è lock-in su astrazioni instabili mentre il loop unificato interno è già validato (ADR-154). "Dove serve il grafo" ha una risposta precisa: **dove la struttura è nota a compile-time** (pipeline di ingestione memoria, consolidamento notturno, onboarding) si scrive codice tipato normale — funzioni in sequenza, fan-out espliciti, niente libreria. Dove la struttura emerge a runtime, è il loop agentico. Un DAG-engine generico è un terzo caso che non abbiamo (YAGNI, e il costo di introdurlo dopo è basso — reversibile).

---

## V6. Core & Gateway: asyncio sempre aperto + routing per metadati → **MODIFICA (la sostanza resta, la forma cambia)**

- Runtime long-running **unico** Node sotto systemd (validato in casa). "Asyncio" decade con V1 (single-runtime TS).
- Il gateway è una **feature-cartella** (`gateway/`): registry dei connector, routing per metadati `(connector, tenant, session, thread)` — CONFERMATO — e normalizzazione a un evento interno unico tipato (il pattern `MuffinEvent` già in direzione, A1).
- **Connector principale designato: la CLI** (è L0-1: il primo cittadino è il terminale; Telegram è il primo connector *remoto*). Ogni altro canale è un connector con lo stesso contratto.
- **Capability per connector (direttiva owner)**: ogni connector dichiara le proprie capacità di resa (`text`, `image`, `video`, `card/inline-ui`, `mcp-apps`, `file`, `audio`) e il renderer sceglie **il mezzo più ricco disponibile, non il più verboso**: prima UI generata/immagine, poi card, poi testo asciutto. La stessa informazione, forme diverse per canale (content parity: cambia la forma, mai il contenuto). → ADR-0013.

---

## V7. Loop agentico → **CONFERMA (harness-style), con pre-loop deterministico e due estensioni**

- Loop: tool-call in continuazione fino alla risposta finale, un solo motore per tutte le superfici (già validato, ADR-154).
- **Cosa accade prima del loop** (domanda aperta №1): solo lavoro **deterministico**: (1) risoluzione identità/tenant/permessi → `PermissionSnapshot` immutabile per il turno; (2) recall memoria con budget fisso → blocco dati con provenance e etichette di trust; (3) assemblaggio context cache-stable (V8). **Nessun classifier/router LLM pre-loop**: è impalcatura che combatte il modello — evidenza interna: intent-classifier retrocesso a monitor-only (ADR-065), e il "salta i tool" era format contagion + framing, non mancanza di routing (ADR-079, analisi 2026-07-04). La proattività non sta nel pre-loop: è un trigger separato dello scheduler con la sua soglia (04).
- **Estensione 1 — harness che lavora su se stesso**: i trace OTel sono un data source first-class: tool `trace_query` (host-only) per interrogare le proprie esecuzioni; l'introspezione (modulo M6) è un consumatore batch degli stessi trace. "Perché hai fatto così?" diventa una query, non un'ipotesi.
- **Estensione 2 — multi-tier**: il loop legge il profilo del modello attivo (V2): quanti tool esporre, orizzonte massimo, recovery cascade. Il core non contiene `if (model === …)`.

---

## V8. Context → **strategia: assemblaggio cache-stable a strati**

Dall'esterno all'interno, per stabilità decrescente: (1) identità RoT + persona (stabile, cache TTL lungo) → (2) definizioni tool del profilo (stabile) → (3) digest di sessione + working set memoria (semi-stabile, si rinnova a soglia, mai per-messaggio) → (4) recall per-messaggio + messaggio corrente (variabile, in coda). Regole: il contenuto variabile non precede mai quello stabile (invalida la cache — meccanica verificata su tutti e tre i provider, A5 §5); ogni blocco di memoria/recall entra **marcato con provenance** e delimitato come dati (spotlighting: ASR 50%→2%, A3 §7.4); la compattazione di conversazione produce summary + puntatori agli episodi grezzi (mai sola riscrittura — il consolidamento è lossy per costruzione, A4 §7). Sessioni chiave: `(tenant, connector, thread)`; il multi-turn è nativo, non ricostruito.

---

## V9. Memoria → **storage ibrido CONFERMA; ontologia rigida SCARTA (Addendum №1); progetto completo in `02-ontologia.md`**

Confermati: Vault (file) + SQLite (relazionale) + sqlite-vec (vettoriale) in **una** istanza; ogni messaggio salvato come episodio immutabile con provenance; compattazione oltre soglia come *vista derivata*, mai distruttiva. Scartate: triple S→P→O con vincoli di coerenza — verdetto formale in 02 con l'evidenza (89 credenze corrotte in casa; zero precedenti reali; ricerca 2026 in direzione opposta — A4 §3/§4). Alternativa adottata: **TKG property-graph schema-light bi-temporale con provenienza come primitiva** + giudice di contraddizione trattato come organo misurato.

---

## V10. Identità: soul.md / voice.md / human.md → **MODIFICA**

La tripartizione proposta mescola due assi (cosa è immutabile vs cosa apprende; chi è l'agente vs chi è l'utente). Adottiamo l'evoluzione del layering già validato in casa (ADR-081), rifondato sul confine open-source repo/config/dati:

| File | Contenuto | Chi lo scrive | Dove vive |
|---|---|---|---|
| `identity.md` | Invarianti di carattere e di condotta (parte del **RoT**) | repo default; override solo owner+riavvio | repo → copiato in `~/.muffin/identity.md` |
| `voice.md` | Come parla: registro, tic, lingua | agente, via cricchetto eval-gated (V3) | `~/.muffin/` |
| `user.md` | Chi è l'utente: inferito, mai richiesto per configurazione | agente (inferenza continua) | `~/.muffin/` |
| stato vivo (ex-heartbeat) | Cosa sta succedendo adesso | runtime | DB (working memory), non file di config |

Il repo distribuisce *default e template*; l'istanza personalizzata vive fuori dal repo e un aggiornamento del repo non la tocca mai (merge esplicito proposto dall'agente quando i default cambiano). → ADR-0003 (RoT), ADR-0011 (confine codice/config/dati).

---

## V11. Scheduling: cron semantico → **CONFERMA**

Pattern maturo anche nei peer (Hermes: cron NL + `deliver`; Odysseus: scheduler+event-bus a soglia — A2). Design: la frase NL si compila **una volta** in una spec deterministica (cron/интервallo/evento+soglia) via LLM con conferma; l'esecuzione è deterministica; ogni job ha budget e canale di consegna. L'event-bus a soglia (pattern Odysseus) sostituisce i demoni cablati (K/C/K riga 25). Anti-pattern con evidenza: heartbeat non budgetati = $5-15/mese di sola presenza (A5 §6.2).

---

## V12. Il nome → **verdetto: "Muffin", senza suffisso. "MuffinOS" resta disponibile come upgrade onesto futuro; "OpenMuffin" scartato.**

Il tuo criterio al checkpoint: "OS se davvero sta un livello sopra Hermes su quel lato". L'evidenza dice che **oggi quella condizione non è soddisfacibile senza violare "Niente finto"**: ciò che si fa in modo affidabile (shell, filesystem, processi) è *parità* con Hermes/OpenClaw/Goose, non un livello sopra (4/8 sistemi lo fanno, A2 §12); ciò che sarebbe "sopra" (controllo affidabile di app e UI, workflow lunghi sulla macchina) è fragile per tutti — computer-use long-horizon al 20,6% binario, zero oltre 163 minuti (OSWorld 2.0). Un nome che promette il pezzo fragile è esattamente l'overclaim che il pubblico developer punisce: l'archeologia è univoca (MemGPT ha abbandonato "OS"; AIOS accolto con "perché ti serve l'integrazione OS?"; rabbit r1 falsificato in settimane — A2 §9). "OpenMuffin" paga l'altro costo, confermato empiricamente: 8+ progetti "Open\*" nello stesso spazio, inclusi due giganti (OpenClaw 385K★, OpenHands ~80K★) — leggibile ma derivato.

**La terza opzione è già in casa: "Muffin".** I peer più credibili usano nomi nudi (Hermes, Goose, Letta, Khoj, Odysseus) e lasciano il posizionamento alla tagline, dove costa poco cambiarlo. L'asimmetria decide: *aggiungere* "OS" quando il system layer sarà davvero sopra i peer è un upgrade credibile; *toglierlo* dopo averlo promesso è una ritirata pubblica. Conseguenze sullo scope v1 (deliverable #10): il system layer entra in v1 come **primitivi host-only** (shell/fs/processi — reali, maturi, già parità) dentro M3, NON come flagship; il "livello sopra" (app control, osservazione di sistema, automazione UI) è post-v1, gated da un segnale esplicito (07): affidabilità computer-use long-horizon che supera una soglia utile, o API OS-native che rendano il controllo deterministico. Da verificare prima dell'annuncio pubblico: collisioni di nome/namespace per "muffin" (npm, GitHub org) — [NON VERIFICATO in Fase A]. → ADR-0012.

---

## V13. Criterio di successo (il BRIEF chiede: proponilo o dichiara che non esiste)

**Non esiste una metrica singola onesta per "specchio personale che funziona" — e fingerne una sarebbe il primo caso di "sembra funzionare".** Esiste un *bundle di proxy*, valutato mensilmente, con questa proprietà: nessuno dei proxy è massimizzabile senza che il sistema sia davvero utile:

1. **Uso spontaneo sostenuto** (giorni attivi/settimana dell'owner) — ma vincolato dal §etico sotto;
2. **Correzioni per 100 interazioni** in calo (il segnale V3.a usato come metrica);
3. **Recall-eval su golden set reale** stabile o in crescita (05);
4. **Interventi manuali su azioni delegate** in calo (quante volte l'owner deve rifare/sistemare);
5. **Valore-sorpresa del deep research**: giudizio esplicito dell'owner registrato per run ("l'avrei trovato da solo?").

**Vincolo etico come architettura** (dove tocca il design, come chiesto): (a) la proattività ha budget e quiet-hours nel RoT — il sistema non può auto-alzarsi la voce; (b) "perché l'hai fatto" è una query sui trace, sempre disponibile (V7); (c) l'astensione è una capability misurata ("non lo so" / "questa la decidi tu" hanno eval dedicate — l'abstention è un'abilità benchmark-abile, A4 §1.3); (d) **anti-metrica**: il tempo-in-chat non è mai un KPI; l'introspezione (M6) monitora il pattern opposto — volume di interazione che cresce senza esiti che crescono — e lo referta all'owner come segnale di deriva. È il modo concreto di "accorgersi che sta scivolando dalla parte sbagliata".

---

## Domande aperte di Livello 2 — dove vengono risolte

| # | Domanda | Risposta | Dove |
|---|---|---|---|
| 1 | Cosa accade prima del loop | Pre-loop deterministico (permessi, recall, assemblaggio); niente router LLM | V7 |
| 2 | Schema ontologia e modello dati | TKG schema-light bi-temporale con provenance | `02-ontologia.md` |
| 3 | Migrazione memoria esistente vs cold start | **REVISIONE 2026-08-05: cold start.** Il corpus è 3 mesi e per il 68% output dell'agente; l'onboarding si collauda una volta sola. Il DB vecchio diventa il **corpus di eval** (l'owner conosce le risposte), resta read-only, e la migrazione resta un job eseguibile se serve | `02` §8 |
| 4 | Integrità del grafo nel tempo | Suite eval memoria su dati reali + invarianti property-based + audit provenance | `05-testing-evals.md` |
| 5 | Ordine moduli e collocazione system layer | M0 Kernel → M1 Loop+CLI → M2 Memoria → M3 Primitivi (system host-only qui) → M4 Telegram → M5 Scheduler/proattività → M6 Introspezione → M7 Gruppi; community e system-layer-flagship post-v1 | `04-roadmap.md` |
| 6 | Modello di permessi unificato | Sì: un'unica astrazione capability/scope con taint (kernel di policy nel RoT); l'HITL a 3 livelli diventa esito di policy | `03-threat-model.md` |
| 7 | Scope minimo v1 | M0–M6 single-user + 1 connector remoto; M7 in v1 solo come isolamento (community dopo); tagli dichiarati | `04-roadmap.md` |
