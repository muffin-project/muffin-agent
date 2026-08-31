# 00 — Findings di Fase A (documento di checkpoint)

> **Stato: CHECKPOINT — in attesa dell'owner.** Nessun verdetto di Fase B è stato scritto: questo documento presenta l'evidenza raccolta e le *proposte preliminari* dell'orchestratore (marcate `[proposta]`), che sono esattamente ciò che una tua correzione adesso può cambiare a costo quasi zero.
>
> Fonti: 5 report scout in `research/` — [a1 inventario codebase](research/a1-inventario-codebase.md) (532 righe), [a2 prior art](research/a2-prior-art.md) (424), [a3 standard](research/a3-standard.md), [a4 memoria](research/a4-memoria.md) (431), [a5 modelli/economia](research/a5-modelli-economia.md) (620). Contratto rispettato: gli scout hanno riportato solo evidenza con fonte, mai verdetti; i claim non verificati restano marcati `[NON VERIFICATO]` nei report. Ogni affermazione qui sotto è tracciabile a un report (tag tipo "A4 §3"); niente viene dalla memoria del modello.
>
> Mandato: `BRIEF.md` (verbatim) + Addendum owner №1 (attacco triple rigide vs TKG vs GraphRAG).

---

## 1. Sintesi esecutiva — i 12 finding che cambiano le decisioni

1. **I tre differenziali ipotizzati sono assenze di mercato verificate.** Su 8 sistemi mappati (OpenClaw 385K★, Hermes ~215K★/$1,5B, Odysseus 84,6K★, Goose, OpenHarness, Letta, Khoj, +HumanLayer post-mortem) **nessuno** fa: (a) introspezione bidirezionale (l'agente che riflette sui propri pattern E su quelli dell'utente), (b) provenienza/trust come primitiva del modello dati della memoria (survey 2026-06: "distinct open problem"), (c) community cross-connector (OpenClaw documenta esplicitamente "no concept of community-wide memory sharing"). — A2 §11

2. **Il mandato d'attacco (Addendum №1) trova evidenza forte contro le triple rigide — e l'evidenza più diretta è in casa.** Muffin ha già vissuto un'ontologia chiusa diagnosticata "substrate-blocker" e riscritta da zero in un mese (ADR-009, v2→v3); un vincolo di coerenza singleton ("un solo valore corrente" — il cugino diretto di "un solo padre") ha **corrotto silenziosamente 89 credenze reali** prima di essere scoperto da audit manuale (ADR-025: 27/28 `interest`, 21/22 `preference` scaduti per errore). Nessun sistema reale con trazione implementa il pattern "triple + vincoli di coerenza" su chat personale. — A4 §3.0, §4

3. **Ma lo schema-light non è gratis: le contraddizioni sono un problema aperto per TUTTI.** BEAM (ICLR 2026) trova che contradiction resolution è l'abilità più debole per ogni sistema testato; Graphiti — il candidato "vincente" — ha un bug **aperto** proprio sul giudice di contraddizione (7/15 → 0/3 sui casi di stress con modelli economici non-reasoning, issue #1666). Il TKG risolve *diversamente* (invalidazione bi-temporale, storia preservata), non *perfettamente*. — A4 §1.3, §3.2

4. **La bi-temporalità di Muffin è già il pattern SOTA.** Il property graph a 4 timestamp di Muffin (WG-1) è strutturalmente identico a quello di Graphiti, raggiunto indipendentemente. Property graph è lo storage universale dei sistemi di memoria-agente reali; **RDF/triple store: nessuno**. — A4 §2.1, §4

5. **I benchmark di memoria sono in crisi di credibilità documentata.** LoCoMo: 6,4% di ground truth errata (tetto teorico ~93,6%), judge che accetta il 62,8% di risposte sbagliate-ma-vicine; disputa Zep↔Mem0 irrisolta da un anno; riproduzioni indipendenti che crollano (92,3% dichiarato → 38,4% riprodotto). Conseguenza operativa: **eval propria su dati reali**, i numeri vendor sono segnale debole. — A4 §1

6. **Memory poisoning non è ipotetico: è dimostrato al 98,2%.** MINJA inietta ricordi malevoli **con sole query** (nessun accesso allo storage), 98,2% injection success medio su agenti con memoria persistente; la difesa con numeri end-to-end (SMSR: firma HMAC + ablation) riduce l'attacco dal 65,3% al 5,3% al costo di ~15 punti di utility. Questo è esattamente lo scenario del brief (messaggio ostile in un gruppo che si attiva dopo). — A4 §6

7. **Gli abbonamenti consumer via harness sono un asse morto per un agente always-on.** ToS verificati alla fonte: Anthropic vieta accesso automatizzato fuori dall'API key ("bot, script, or otherwise") e l'uso di token OAuth consumer in altri prodotti; OpenAI e Google idem (Google: ban permanente alla seconda violazione). Enforcement Anthropic documentato: **1,45M account bannati in H2-2025**, appelli accolti al 3,3%. L'unico percorso legittimo per automazione headless è l'API a consumo. (Nota: ohmo/OpenHarness è costruito proprio sul riuso dell'abbonamento — rischio ToS strutturale.) — A5 §4

8. **L'economia dei modelli è cambiata a favore del cloud mid-tier, e il routing è impalcatura con post-mortem.** Sonnet 5 in prezzo introduttivo $2/$10 (poi $3/$15 dal 1/9); Haiku 4.5 $1/$5; caching convergente su tutti i provider (~-90% in lettura, break-even 1-2 riusi); DeepSeek V4 open-weight MIT a $0.14-0.87 con 80,6% SWE-bench (a ~14 punti dal top assoluto). Trend frontier: >10× di calo prezzo ogni 12-18 mesi dal 2023. Manifest ha **rimosso** il proprio router LLM dopo 4 mesi su 7.000 utenti: "la complessità non si deduce dal prompt", "il caching batte il routing", "saltare tra modelli degrada la qualità". — A5 §1, §5, §7

9. **Il locale è più caro del previsto e ha un punto dolce preciso.** Carenza DRAM/HBM globale (RAM +70-90% nel 2026, prevista fino al 2028; Apple ha tolto le config ad alta memoria); il punto dolce pratico è la classe MoE ~30B-A3B (mini-PC 128GB ~$1.800-2.000 a ~100 tok/s; RTX 5090 ~234 tok/s ma $4.300-5.000). Elettricità EU media €0,29/kWh. Embedding: **nessun numero italiano-specifico affidabile** per i candidati locali → serve eval italiana propria; qwen3-embedding (già in uso) resta ragionevole in attesa. — A5 §3, A4 §8

10. **Sicurezza: l'injection è architetturale, le difese quantificate esistono, e nessun peer ha un Root of Trust.** OWASP: LLM01 = prompt injection (edizione corrente **2025**, non esiste un "2026"; memory poisoning = ASI06 nel Top 10 **Agentic** separato). Difese con numeri: CaMeL 77% utility con sicurezza provabile (vs 84% senza), Spotlighting ASR 50%→2%, PromptArmor <1% ASR (ICLR 2026). Prior art negativo: **nessuno degli 8 sistemi ha un root-of-trust immutabile a runtime** (il massimo: flag `read_only` sui memory-block di Letta; Hermes: config read-only + `--apply`, ma le approvazioni "always" persistono per sempre). OpenClaw è il caso di studio del fallimento: 5+ famiglie di CVE critiche in 3 mesi, tutte con lo stesso pattern (trust implicito su localhost/pairing/token-scope), patch reattive mai redesign. Il vincolo L0-3 di MuffinOS sarebbe un **differenziale**, non table stakes. — A3 §7, A2 §1-§8

11. **Il nome "OS" ha un'archeologia sfavorevole e la famiglia "Open\*" è affollata.** Chi ha rivendicato "OS" tecnicamente o l'ha abbandonato (MemGPT→Letta) o ha ricevuto scetticismo ("perché ti serve l'integrazione OS?" su AIOS) o è stato falsificato pubblicamente (rabbit r1); il claim "controllo la macchina" oggi regge solo short-horizon (OSWorld-Verified 86,1%, sovraumano) e crolla long-horizon (miglior modello: 20,6% di completamento binario, **zero oltre 163 minuti**). "Open*": almeno 8 progetti agentic verificati (OpenClaw, OpenHands, OpenHarness, OpenInterpreter, OpenManus, OpenDAN, OpenHuman, OpenCognit) — il costo "suona derivato" è empirico. — A2 §9-§12

12. **Self-improvement: dimostrato solo con terra esterna verificabile.** Applicabili a un sistema single-user senza infra RL: GEPA (prompt optimization, +13% misurato, 10 esempi bastano), Reflexion (+11 punti HumanEval, richiede segnale di fallimento esplicito), Voyager-style skill library (nessun training). NON applicabili: SEAL (richiede RL+pesi). Evidenza **contraria**: self-correction/self-rewarding senza segnale esterno spesso peggiora (ICLR 2024, ACL 2025); e il consolidamento di memoria è lossy per costruzione, con degradazione documentata anche partendo da dati corretti. Il "cricchetto eval-gated" che il brief ipotizza è esattamente l'unica forma che l'evidenza supporta. — A5 §8, A4 §7

---

## 2. Inventario Muffin → proposta preliminare keep / change / kill `[proposta]`

Base fattuale: A1 (repo al commit `09e02db`: ~193K LOC TS, 47 tool, 150 ADR, 87 oggetti-tabella, 6.432 test verdi, zero TODO inline). Legenda — il mandato è riparti-da-zero, quindi: **KEEP** = il *concetto* è ri-giustificato dall'evidenza e si riporta nel design nuovo; **CHANGE** = sopravvive trasformato; **KILL** = non si ricostruisce.

| # | Componente/scelta | Proposta | Motivazione (una riga) |
|---|---|---|---|
| 1 | Filosofia due-gambe (agente-che-fa + specchio-che-capisce, The Machine) | **KEEP** | È il differenziale: le 3 assenze di mercato (A2 §11) coincidono con questa identità. |
| 2 | Principio "inferenza, non configurazione" | **KEEP** | Nessun peer lo fa; è il criterio "fluidità" del brief. |
| 3 | CLI-first runtime (`muffin run`/REPL/daemon, ADR-158) | **KEEP** | Vincolo L0-1 già validato in casa; `react_engine` transport-puro dimostra la separazione. |
| 4 | Loop unificato singolo motore (ADR-154) | **KEEP** | Pattern harness moderno confermato dai peer; consolidamento già avvenuto. |
| 5 | Gateway monolite (`callChat` 1.113 righe residue; `gateway.ts` 2.890) | **KILL** | God-function già diagnosticata internamente; si ricostruisce su primitivi Agent/Runner/Guardrails/Memory. |
| 6 | LLM stack Gemma-4 local-first (lane callMain/callLight/callDream) | **CHANGE** | Economia 2026 cambiata (A5): la decisione modelli si riapre da zero in `06-modelli.md`. |
| 7 | Thinking OFF in prod | **CHANGE** | Cerotto model-specific (confidence-amplifier di Gemma); si rivaluta col nuovo stack. |
| 8 | Memoria: property graph bi-temporale 4-timestamp (WG-1) | **KEEP** | Convergenza indipendente col SOTA (Graphiti); è la base del TKG. |
| 9 | Predicati liberi + audit a soglia (ADR-017) | **KEEP** | "Schema additivo, mai bloccante all'ingest" è il pattern che il campo valida (A4 §3.3). |
| 10 | Triple rigide con vincoli di coerenza (ipotesi originaria del brief) | **KILL** | Addendum №1: evidenza interna (89 credenze corrotte, ADR-025) + zero precedenti reali (A4 §3-4). |
| 11 | Pipeline estrazione entità/facts | **CHANGE** | Funziona (#384-393) ma si ricostruisce con **provenienza/trust nel modello dati** (assenza #2 = opportunità). |
| 12 | Embedding qwen3-0.6b locale via Ollama | **KEEP** (provvisorio) | Load-bearing; nessun candidato con dati IT migliori (A4 §8) — conferma via eval italiana propria. |
| 13 | Recall ibrido FTS5+vec con RRF | **KEEP** | Standard di fatto; il reranking resta il gap da colmare. |
| 14 | Dream cycle a ~10 fasi | **CHANGE** | Sleep-time compute validato (Letta, ~5× compute), ma il consolidamento è lossy (A4 §7): meno fasi, più misura. |
| 15 | Ledger/token budget (ADR-141) | **KEEP** | Impalcatura utile oggi — da etichettare come tale in `07`. |
| 16 | Tool registry 47 tool + retrieval embedding | **CHANGE** | Reframe primitive-layer (~10-12 primitivi) già diagnosticato; retrieval rumoroso documentato (#430). |
| 17 | HITL 3 livelli + permission zones + tier-2 act-notify-undo (ADR-159) | **KEEP** (concetto) | Prior art interno valido; da estendere a capability/scope per il system layer. |
| 18 | Formato skill proprio v0.3 (2 skill esistenti) | **KILL → SKILL.md** | Standard aperto con ~45 adopter (A3 §4); con 2 skill in casa non c'è ragione di divergere. |
| 19 | Gruppi: scope-on-data leak-proof + registro §I-9 | **KEEP** | 27 test leak-proof; nessun peer fa di meglio (le 2 CVE di Khoj sono proprio lì). |
| 20 | Community cross-connector (da costruire) | **KEEP** (ambizione) | Assenza di mercato confermata — MA il conflitto L0-5 è irrisolto dal prior art (§7 sotto): design esplicito in Fase B. |
| 21 | Transport Telegram tipato (P0-P7) | **KEEP** (pattern) | Il transport tipato è il modello per tutti i connector. |
| 22 | Webapp/SPA Express+Vue (~30 endpoint) | **KILL** | Sotto-istrumentata (i 2 bug più longevi vivevano lì); candidata: MCP Apps (11 host) + fallback testuale per Telegram. |
| 23 | Task agent (reactor goal-loop, S4 resume) | **CHANGE** | Shipped ma con collisioni budget documentate; si ridisegna sui primitivi del loop. |
| 24 | Scheduler 3 lane + cron semantico | **KEEP** (concetto) | Esiste e gira; il cron in linguaggio naturale è pattern maturo anche nei peer (Hermes). |
| 25 | Demoni (7 file) | **CHANGE** | "Troppo in background" già diagnosticato (ADR-065); consolidare su un solo scheduler + event-bus (pattern Odysseus). |
| 26 | SQLite singolo WAL + soft-delete (§I-8) | **KEEP** | Invariante sano; anche il SOTA converge sul single-instance (Cognee). |
| 27 | Deploy systemd + `/update` | **KEEP** | Cutover fatto e funzionante; niente da reinventare. |
| 28 | Replay harness + EVAL-NG | **KEEP** | È la precondizione del cricchetto self-improvement (unica forma dimostrata, A5 §8). |
| 29 | Rito flag-lifecycle (4 verdetti) | **KEEP** (processo) | Igiene che i peer non hanno; 20 flag già liquidati con gate. |
| 30 | Context layering 4-tier (IDENTITY/SOUL/VOICE/HEARTBEAT/USER, ADR-081) | **CHANGE** | Risponde già alla domanda "identità" del brief (meglio di soul/voice/human); da rifondare sul confine repo/config/dati-utente. |
| 31 | Belief revision, verify-pillar unknown-terms, deictic, promise-bridge, D.3 re-planning | **KILL** (restano morti) | Uccisi con misura (es. F1 0.61/50% FP); non ri-aggiungere. |
| 32 | Osservabilità (statusline/cockpit) | **CHANGE** | Da rifondare su tracing OTel GenAI (pinnato) progettato nel Modulo 1, non ricostruire dashboard ad hoc. |

---

## 3. Prior art — il campo in una tabella

| Sistema | Traction (2026-08-04) | Memoria | Multi-tenant | System control | Root of Trust | Nota chiave |
|---|---|---|---|---|---|---|
| OpenClaw | 385K★ (progetto più stellato di GitHub) | Memory Wiki + Active Memory | session-key per gruppo, **nessuna condivisione cross-community** | shell+fs pieni, no sandbox default | filesystem dell'operatore | 5+ famiglie CVE critiche in 3 mesi, stesso pattern; enforcement kernel arrivato da terzi |
| Hermes | ~215K★, $1,5B valuation | session_search 4500× | "Profiles" = agenti separati, no gruppi | terminal/fs/12 browser primitives (CDP+vision opt-in) | config read-only + `--apply`; approvazioni "always" eterne | Tirith approval a 3 stadi; CVE sandbox-escape patchata pre-disclosure |
| Odysseus | 84,6K★ | debole (max 2 fatti/conversazione) | admin/non-admin | shell senza sandbox (gap auto-dichiarato) | teacher-escalation gated | THREAT_MODEL.md nel repo; untrusted-wrapper anche sulle proprie memorie |
| Goose (AAIF/LF) | 52K★ | estensione opt-in | assente | shell/fs + computer-use Peekaboo (**solo macOS**) | non trovato | MCP nativo; l'unico con UI-automation nominata |
| OpenHarness/ohmo | 15K★ | CLAUDE.md/MEMORY.md convention | non documentato | codice/PR autonome | non documentato | gira su abbonamento Claude Code/Codex → rischio ToS strutturale (A5 §4) |
| Letta | 24K★ | core/recall/archival + MemFS git | binaria (agente-per-tenant o niente) | solo in `letta-code` | flag `read_only` sui memory-block | il primitivo di immutabilità parziale più pulito trovato |
| Khoj | 36K★ | secondo-cervello + agenti custom | multi-utente reale | **nessuno** | non trovato | 2 CVE, entrambe su boundary tra tenant |
| HumanLayer | deprecato | — | — | — | — | resta il manifesto 12-Factor Agents (HITL-as-tool-call) |

**Controllo macchina, la risposta concreta per la domanda sul nome (A2 §12):** affidabile oggi = shell + filesystem + processi (4/8 sistemi, quasi sempre senza sandbox); fragile = UI-automation/computer-use (1/8, solo macOS; OSWorld-Verified 86,1% short-horizon MA OSWorld 2.0 long-horizon 20,6% binario, zero oltre 163 min); non fatto = API OS-native cross-platform per "apri/gestisci app" (nessuno).

---

## 4. Standard — fatti pronti per il verdetto (Fase B)

| Standard | Cosa dice la fonte primaria (A3) | Maturità | Lettura per MuffinOS `[proposta]` |
|---|---|---|---|
| MCP core `2026-07-28` | Tutti e 6 i claim dell'owner **veri** (stateless, no initialize, no sessioni, Tasks→extension, framework extensions, deprecation Roots/Sampling/Logging con finestra 12 mesi). Revision precedente: 2025-11-25. Backward-compat reale ma **opt-in a livello SDK** (default: servi entrambe le ere). | Current; SDK TS/Py/Go/C# v2 | Target 2026-07-28 nativo, compat legacy via SDK di default. |
| MCP Apps (SEP-1865) | `ui://` + iframe sandbox obbligatorio + CSP da metadata + JSON-RPC auditabile + consenso per tool-call da UI. | Final/Stable da gen-2026, **11 host** verificati (Claude, ChatGPT, VS Code, Cursor, Goose…) | Candidata seria per la dashboard/UI generativa; serve fallback testuale per Telegram. |
| MCP Tasks | Lifecycle a 5 stati, opt-in bilaterale. **Ma**: SEP "Final" con repo che si autodefinisce "experimental" e **0 client tracciati** in matrice ufficiale. | Immatura rispetto ad Apps | Non adottarla come modello interno del lavoro asincrono; eventualmente solo al confine, più avanti. |
| Agent Skills / SKILL.md | `name`+`description` normativi, resto convenzione; progressive disclosure a 3 stadi; Apache-2.0+CC-BY; **nessuna foundation** (a differenza di MCP/AGENTS.md). ~45 adopter. | Ampio, governance debole | Adottare il formato (kill del formato proprio, riga 18 sopra). |
| AGENTS.md | Governance **verificata**: AAIF/Linux Foundation (con MCP e Goose), >60K progetti (dato dic-2025). | Solida | Adottare. |
| OTel GenAI semconv | Tutto `gen_ai.*` in stato **Development**, nulla Stable; repo scisso giu-2026; MCP dichiarato in scope ma non trovato nel registro. | Pre-stabile | Adottare pinnando la versione, aspettandosi breaking changes. |
| Canone sicurezza | OWASP LLM Top 10 corrente = **2025** (non esiste "2026"); memory poisoning = **ASI06** nel Top 10 Agentic separato (dic-2025). Lethal trifecta verbatim. CaMeL 77% vs 84%. Spotlighting ASR 50%→2%. Progent (policy simboliche + SMT, monotonic confinement). AgentDojo 97 task/629 casi; PromptArmor <1% ASR. | — | Base bibliografica del threat model (03). |

---

## 5. Memoria — l'esito del mandato d'attacco (Addendum №1)

Tabella 3×3 completa in A4 (§Tabelle di chiusura). Compressa:

| | Latenza runtime | Contraddizioni nel tempo | Manutenibilità |
|---|---|---|---|
| **Triple rigide + vincoli** | Nessun numero pubblico per il pattern esatto; costo extra = validazione/retry su violazione `[NV]` | Il vincolo rifiuta le contraddizioni SOLO se è vero nel dominio; quando non lo è, **esegue l'errore in silenzio** (Muffin: 89 credenze corrotte, ADR-025) | Ontologia chiusa = substrate-blocker vissuto (ADR-009); la ricerca 2026 (AdaKGC, DIAL-KG) va nella direzione opposta |
| **TKG schema-light (Graphiti/Zep)** | Ingest ≥1 chiamata LLM/msg; recall 150-780ms (fonti discordanti) | Edge invalidation bi-temporale, storia preservata — ma giudice di contraddizione con **bug aperto** (0/3 su stress con modelli economici) | Schema opzionale e additivo, backward-compatible per design; vocabolario libero gestito con audit a soglia (= pattern già scelto da Muffin, ADR-017) |
| **Hybrid GraphRAG** | Variante classica costosa in ingest ($1.60-2.41/M tok + community detection); LazyGraphRAG/LightRAG la ribaltano ($0.04/query) | Nessuna invalidazione per-fatto: design per corpus statici, non conversazione evolutiva | Vince 70-80% dei task di *sensemaking* (evidenza CONTRO il sospetto: strutturare non è sbagliato, lo è nel regime sbagliato) |

**Lettura dell'orchestratore `[proposta]`** (verdetto formale in `01`/`02` dopo il tuo ok): l'evidenza conferma il sospetto dell'Addendum — le triple rigide con vincoli si scartano; la base è un **TKG property-graph schema-light** (che Muffin ha già in embrione: bi-temporalità 4-timestamp + predicati liberi con audit), con due aggiunte che il campo NON ha: (a) **provenienza/trust come primitiva del modello dati** (chi l'ha detto, su che canale, quanto fidarsene — è insieme il fix del memory poisoning ASI06 e il differenziale #2), e (b) un **giudice di contraddizione trattato come organo misurato** (il punto più debole di tutto il campo: eval dedicata, non fiducia nel default). GraphRAG-style community summaries: solo come vista derivata per sensemaking, non come storage primario. Inoltre: compattazione = operazione lossy per costruzione (degradazione documentata anche da dati corretti) → si progetta con conservazione dell'evidenza grezza e re-derivazione, mai riscrittura distruttiva.

Punti aperti che restano irrisolti dall'evidenza (andranno decisi, non scoperti): numeri di latenza affidabili (fonti discordanti), embedding per l'italiano (serve eval propria), entity resolution cross-connector (nessun precedente diretto; il rischio documentato è il **merge falso-positivo silenzioso**, peggiore del mancato match — A4 §9).

---

## 6. Modelli ed economia — fatti chiave per il verdetto

**Pricing (fonti ufficiali, 2026-08-04, $/Mtok in/out):** Claude Fable 5 $10/$50 · Opus 5 $5/$25 · **Sonnet 5 $2/$10 fino al 31/8** (poi $3/$15) · Haiku 4.5 $1/$5 · GPT-5.6: sol $5/$30, terra $2/$12, luna $0.20/$1.20 · Gemini 3.5 Flash $1.50/$9, 2.5 Flash-Lite $0.10/$0.40 · DeepSeek V4-Pro $0.435/$0.87, V4-Flash $0.14/$0.28 (MIT, 1M context). Caching convergente: write 1.25-2×, **read -90%**, break-even 1-2 riusi; batch -50% (Anthropic, cumulabile). — A5 §1, §5

**Capacità:** SWE-bench Verified: Fable 5 95%, DeepSeek V4-Pro **80,6% (miglior open-weight, MIT)**; BFCL: dato internamente incoerente tra fonti (non decidibile); tau2: aderenza a policy ~86-90% per i top; long-context: claimed 1M ≠ effettivo (Opus 4.6 76% su MRCR-8needle@1M vs GPT-5.4 36,6%; open-weight non misurati). — A5 §2

**Assi del verdetto (fatti, non ancora verdetto):** (1) *Tier*: il lavoro quotidiano di un agente personale (classificazione/estrazione/recall) sta nella fascia $0.10-2/Mtok senza gap funzionale dimostrato; il frontier serve su coding/ragionamento lungo. (2) *Approvvigionamento*: abbonamenti consumer **esclusi dai ToS** per l'uso headless (finding #7); resta API (+eventuale locale). Locale: rincarato dallo shortage DRAM, sweet spot 30B-A3B (~$1.800-2.000 di hardware, ~100 tok/s). (3) *Collocazione*: routing = impalcatura con post-mortem (Manifest); il trend prezzi (>10×/12-18 mesi) erode il delta che il router dovrebbe catturare; il caching cattura più risparmio con meno complessità. — A5 §3, §4, §7

**Self-improvement, cosa è reale:** applicabile single-user senza RL = GEPA (prompt, +13%), Reflexion (trace+riflessione su fallimento esplicito), skill library Voyager-style; NON applicabile = SEAL (RL+pesi); **controproducente** = self-rewarding senza terra esterna (evidenza di degrado). RSI autonoma: nessuna evidenza, solo narrativa. → Il cricchetto eval-gated ipotizzato dal brief è l'unica forma supportata. — A5 §8

---

## 7. I conflitti di Livello 0 alla prova dell'evidenza

**L0-2 (self-modifying) vs L0-3 (Root of Trust).** Come lo risolvono gli altri: OpenClaw non lo risolve (RoT = filesystem dell'operatore → la sua storia CVE è la conseguenza); Hermes lo risolve proceduralmente (config read-only + `--apply`, ma le approvazioni "always" persistono per sempre = deriva); Letta strutturalmente ma solo sulla memoria (`read_only` per blocco); Odysseus con un gate di qualità (teacher-escalation: la skill nuova persiste solo se passa l'eval che ha rilevato il fallimento). **Lettura**: il conflitto è risolvibile e nessuno l'ha risolto per intero — la combinazione "confine strutturale (fuori dal write-path dell'agente) + gate di qualità (eval-gated) + PR per il RoT stesso" non ha precedenti completi ed è coerente con tutta l'evidenza raccolta. Design in Fase B.

**L0-5 (capability host-only) vs modello community.** Prior art: **zero**. Nessuno fa community cross-connector; chi fa multi-tenant o lo fa binario (Letta), o l'ha bucato due volte proprio lì (Khoj), o lo fa bene ma senza condivisione (OpenClaw session-key). Il conflitto resta **irrisolto dall'evidenza esterna** — come da mandato, non lo appiano: in Fase B va presentato come design con opzioni e costi (isolamento hard con condivisione esplicita opt-in per artefatto, vs bus condiviso con scoping — la prima direzione è l'unica coerente con L0-4/L0-5, ma il costo in UX va dichiarato). L'evidenza che abbiamo: il fallimento tipico è il boundary (Khoj), e il merge di identità cross-connector sbagliato è silenzioso e più dannoso del non-merge (A4 §9).

**L0-1 (CLI-first):** nessun conflitto — è già costruito e validato in Muffin (ADR-158).

---

## 8. Tensioni da decidere al checkpoint (dove una correzione ora costa poco)

1. **Riparti-da-zero vs evidenza di convergenza.** Il repo contiene un audit del 2026-07-16 con mandato quasi identico e verdetto "non serve un redesign"; e pezzi del target (CLI-first, engine transport-puro, grafo bi-temporale, HITL zones) esistono già e l'evidenza esterna li valida. Il mandato resta riparti-da-zero **sul design** — la mia lettura `[proposta]` è: si riparte da zero su architettura/ADR/doc, ri-giustificando ogni scelta (come da L0-6), e dove il concetto esistente è validato lo si *riporta* consapevolmente (tabella §2). Se invece intendi riparti-da-zero anche contro i concetti validati, dillo ora.
2. **Addendum №1**: l'evidenza conferma lo scarto delle triple rigide; la base proposta è TKG schema-light + provenienza nel modello dati + giudice di contraddizione misurato (§5). Confermi la direzione per `02-ontologia.md`?
3. **Approvvigionamento**: i ToS eliminano l'asse "abbonamento consumer" per l'always-on headless (finding #7). `06-modelli.md` verrà progettato su API + locale opzionale. Obiezioni?
4. **Nome**: l'evidenza pende contro "OS" (long-horizon al 20,6%, archeologia sfavorevole) e contro "Open*" (8+ progetti). Il verdetto formale con terza opzione arriva in Fase B — se hai già un orientamento, questo è il momento a costo zero.
5. **Keep/change/kill (§2)**: correzioni riga per riga?
6. **Webapp → MCP Apps** (riga 22): è il kill più aggressivo della tabella. Il fallback Telegram resta testuale/bot-native. Ok?

---

## 9. Cosa succede dopo il tuo ok

Fase B sequenziale (nessun parallelismo, coerenza tra documenti): `01-verdetti.md` → `02-ontologia.md` → `03-threat-model.md` → `04-roadmap.md` → `05-testing-evals.md` → `06-modelli.md` → `07-durevole-vs-impalcatura.md` → `08-assunzioni.md` → `adr/0001-*.md` (una decisione per file, col campo Reversibilità). Poi Fase C: 3 agenti ostili (threat model / complessità / ingegnere del Modulo 1), con le obiezioni risolte NEL piano. Nessun permesso intermedio ti verrà chiesto fino al piano completo.
