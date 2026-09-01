# A1 — Inventario fattuale del codebase Muffin

> Report dell'agente A1 (Fase A del blueprint MuffinOS). Contratto: solo fatti con evidenza (`file:riga`, ADR#, doc). Nessun verdetto keep/change/kill — quelli spettano all'orchestratore. Stato di ogni componente ∈ {funziona in prod, parziale, flag-off-dormiente, morto-superseded}, sempre con l'evidenza che lo dimostra. Dove non determinabile: `[NON DETERMINATO]`.
>
> Verificato al commit `09e02db` (2026-07-19, "`/update` finish-notify #682") — gli unici due commit successivi nel repo sono il kickoff del blueprint stesso (`7e09090`, `c0a5d06`, 2026-08-04), zero codice. Le doc/reference (`ARCHITECTURE.md`, `DATABASE.md`, `MODULES.md`) sono in più punti **datate rispetto al codice**: lo segnalo esplicitamente dove rilevante, il source of truth usato per i numeri è sempre il codice o `src/CLAUDE.md`/`src/memory/CLAUDE.md`/`src/group/CLAUDE.md` (aggiornati costantemente per regola di progetto).

---

## 1. Struttura e numeri

### 1.1 LOC per sottosistema (`src/`, solo `.ts`/`.tsx`, `find | wc -l`)

| Sottosistema | LOC |
|---|---|
| `src/memory/` | 40.867 |
| `src/cognition/` | 21.943 |
| `src/tools/` | 21.374 |
| `src/__tests__/` (test root-level) | 20.470 |
| `src/group/` | 19.100 |
| `src/outward/` | 9.243 |
| `src/webapp/` | 7.051 |
| `src/telegram/` | 6.199 |
| `src/cli/` | 4.614 |
| `src/replay/` | 4.309 |
| `src/db/` | 3.723 |
| `src/utils/` | 3.603 |
| `src/security/` | 3.285 |
| `src/skills/` | 3.052 |
| `src/daemon/` | 1.564 |
| `src/demons/` | 1.495 |
| `src/verification/` | 1.448 |
| `src/guardrails/` | 998 |
| `src/voice/` | 722 |
| `src/adapters/` | 393 |
| `src/evals/` | 233 |
| **File `.ts` direttamente in `src/` (root)** | 17.457 |

Somma indicativa (subsystem dirs + root `.ts`): ~193.000 righe TS in `src/` (test inclusi nei rispettivi `__tests__/` sparsi nelle directory — la riga `src/__tests__/` sopra è solo i test root-level, ogni sottosistema ha i propri `__tests__/` interni conteggiati nel suo totale).

### 1.2 I 15 file più grandi (esclusi test), `wc -l`

| File | Righe |
|---|---|
| `src/webapp/server.ts` | 3.528 |
| `src/group/gateway_group.ts` | 2.942 |
| `src/gateway.ts` | 2.890 |
| `src/telegram.ts` | 2.851 |
| `src/memory/memory_dream.ts` | 2.799 |
| `src/db/init.ts` | 2.467 |
| `src/tools/index.ts` | 1.746 |
| `src/cognition/react_engine.ts` | 1.657 |
| `src/tools/knowledgeArtifacts.ts` | 1.505 |
| `src/memory/memory_learning.ts` | 1.393 |
| `src/llm.ts` | 1.337 |
| `src/memory/memory_retrieval.ts` | 1.310 |
| `src/memory/memory_entities.ts` | 1.282 |
| `src/main_agent.ts` | 1.276 |
| `src/cli/install.ts` | 1.167 |

`gateway_group.ts` era il file più grande del repo prima del taglio del ramo legacy (`src/group/CLAUDE.md:11`: "132KB / 2.935 righe … 2026-07-05, task #16: -555 righe con la RIP del ramo legacy `GROUP_USE_ENGINE`"); oggi (2.942 righe misurate) è ancora il file .ts più grande sotto `src/` escludendo `webapp/server.ts`. La funzione `callChat` dentro `gateway.ts` è delimitata da `async function callChat(` a `src/gateway.ts:634` fino al prossimo top-level export `processMessage` a `src/gateway.ts:1748` → **1.113 righe** (era stata descritta "~1500 righe" / "~950 righe" nella doc storica pre-taglio PR-C `docs/strategy/2026-07-04-orchestrator-layer-direction.md:7` — il file `gateway.ts` completo era citato a 3177 righe nello stesso doc, oggi 2.890 dopo la graduazione `MAIN_USE_ENGINE`, `src/CLAUDE.md` sezione flags.ts "GRADUATO 2026-07-13").

### 1.3 Dipendenze npm chiave (`package.json`)

Runtime (`dependencies`): `better-sqlite3@^12.9.0`, `sqlite-vec@0.1.9`, `openai@^6.33.0` (SDK unico per tutti i provider OpenAI-compatible: Ollama, OpenRouter, Anthropic-direct), `telegraf@^4.16.3`, `@modelcontextprotocol/sdk@^1.27.1`, `express@^4.21.0`, `helmet@^8.1.0`, `@anthropic-ai/sandbox-runtime@0.0.52`, `tsdav@^2.2.2` (CalDAV), `undici@^6.26.0` (fetch con guard SSRF), `ink@^6.8.0` + `react@^19.2.0` (REPL CLI), `sd-notify@2.8.0` (systemd watchdog), `d3-force@^3.0.0` (grafo webapp), `zod@^4.3.6`, `mammoth`/`pdf-parse`/`@mozilla/readability`/`fast-xml-parser`/`linkedom` (parsing documenti/HTML/XML), `js-yaml`, `p-limit`. Dev: `vitest@^4.1.7`, `typescript@^5.7.0`, `vite@^6.0.0`, `vue@^3.5.0` + `pinia`/`vue-router` (webapp SPA), `gsap`, `husky`, `ink-testing-library`. **Nessuna dipendenza da alcun framework agentico** (LangGraph/CrewAI/Mastra/OpenAI Agents SDK assenti) — confermato dal verdetto `docs/strategy/2026-07-16-grande-ricerca-verdetto.md:52`: "Non migriamo a un framework agentico … il nostro core regge". `package-lock.json` conta 549 occorrenze di `"resolved"` (proxy per numero di pacchetti risolti nell'albero, non deduplicato).

### 1.4 Test

- **381 file test totali** eseguiti da `vitest.config.ts` (`include: ["src/**/*.test.ts", "scripts/evals/__tests__/*.test.ts"]`): 370 sotto `src/**/*.test.ts` (`find src -name "*.test.ts" | wc -l`) + 11 sotto `scripts/evals/__tests__/`.
- **Run live eseguito in questa sessione** (`npm test -- --run`, 2026-08-04): **6.436 test totali → 6.432 passed, 3 failed, 1 skipped**, durata 167s. I 3 failed sono timeout a 5000ms (`check_self_health.test.ts`, `src/cli/__tests__/run.test.ts`, `streaming_keepalive_race.test.ts`) — **non regressioni logiche**: sono esattamente la classe di flake "load-dependent" già documentata in `docs/operations/INTERVENTIONS.md` (entry 2026-07-19 "Ritiro ANNOUNCE_MONITOR" e 2026-07-19 "Pattern-notifications", che elencano `check_self_health`/`cli/run`/`streaming_keepalive_race` come timeout ricorrenti sotto carico macchina condivisa, verdi in isolamento). Il numero più recente citato nella doc storica prima di questo run era "6435 passed / 10 failed (timeout) / 1 skipped" (`INTERVENTIONS.md`, entry "Pattern-notifications", stesso commit HEAD) — coerente in ordine di grandezza col run live.
- Suite separate non incluse nel default `npm test`: `test:group:minimal/realistic/living` (`vitest.group.config.ts`, privacy-leak tests su config dedicata) — `package.json:28-32`.
- CI/exact-count non mantenuto a mano per policy esplicita (root `CLAUDE.md`: "`npm test` (conteggio esatto in CI, non mantenerlo a mano)").

### 1.5 Env vars documentate

**54 righe** nella tabella di `docs/reference/ENVIRONMENT.md` (pattern `| \`VAR_NAME\` |`). Includono secret provider (LLM/embedding/GitHub/Google/Anthropic), path/override operativi, flag legacy-ora-in-`flags.ts` (tombstoned nella tabella stessa, es. `WG6_ENTITY_RETRIEVAL_ENABLED`, `CONTRADICTION_EVICT_ENABLED`), credenziali "one-shot" (CalDAV/Google OAuth — lette una volta da script, poi cifrate in DB e mai più lette da env).

### 1.6 Tabelle DB

- **77 tabelle SQL reali** (`CREATE TABLE( IF NOT EXISTS)?` con parentesi in `src/db/init.ts`, lista completa sotto).
- **10 virtual table** (`CREATE VIRTUAL TABLE`): `entities_fts`, `entities_vec`, `episodes_fts`, `episodes_vec`, `facts_fts`, `facts_vec`, `knowledge_artifact_chunks_vec`, `knowledge_artifacts_fts`, `knowledge_artifacts_vec`, `observations_vec`.
- **Totale 87 oggetti-tabella.**

Lista delle 77 tabelle reali: `agent_logs`, `agent_state`, `agreement_metrics`, `agreement_signals`, `belief_asks`, `bot_claim_evidence`, `bot_claims`, `bot_claims_group`, `conversation_summary`, `conversations`, `counterpoint_history`, `daily_outfit`, `daily_outfit_v2`, `dream_proposals`, `dream_reports`, `entities`, `entity_attributes`, `entity_edge_evidence`, `entity_edges`, `entity_mentions`, `episodes`, `facts`, `github_webhook_seen`, `graph_edges`, `group_artifacts`, `group_counterpoint_history`, `group_evidence`, `group_join_requests`, `group_living_history`, `group_member_style`, `group_memory`, `group_rate_limit`, `group_repos`, `group_response_log`, `group_settings`, `group_topics`, `group_traces`, `group_turns`, `group_whitelist`, `knowledge_artifact_chunks`, `knowledge_artifacts`, `living_profile_history`, `muffin_self_narrative_history`, `muffin_status`, `muffin_status_history`, `narrative_evidence`, `narratives`, `observation_development_log`, `observation_evidence`, `observations`, `outward_outbox`, `outward_transitions`, `patterns`, `pending_actions`, `pending_notifications`, `pipeline_baselines`, `pipeline_runs`, `proactive_deliveries`, `questions`, `raw_messages`, `scheduled_jobs`, `schema_version`, `shadow_traces`, `skill_candidates`, `skill_usage`, `state_entries`, `task_checkpoints`, `task_interrupts`, `task_plan_steps`, `task_plans`, `tasks`, `temporal_profile`, `tool_embeddings`, `traces`, `undo_log`, `voice_metrics_history`, `work_queue`.

Nota: alcune sono tombstoned ma non droppate per §I-8 (`bot_claims`, `bot_claims_group`, `bot_claim_evidence`, `shadow_traces` — pipeline che le scrivevano rimosse, righe storiche preservate).

### 1.7 ADR

**150 ADR distinti** (header `## ADR-NNN` in `docs/DECISIONS.md`, 4.264 righe totali), numerati da ADR-001 a ADR-163 con **13 numeri mancanti nella sequenza**: 39, 41, 42, 43, 44, 46, 47, 48, 49, 50, 51, 100, 129. Nessun numero duplicato (ogni header è unico). I gap sono coerenti con collisioni di numerazione da sessioni concorrenti poi renumerate per ordine di merge (pattern noto del progetto — non ulteriormente verificato in questo inventario perché richiederebbe `git log` estensivo sui merge).

### 1.8 Tool registry

- **`toolsRegistry` = 47 entry** (`src/tools/index.ts:1059`, spread di tre oggetti sorgente): `STABLE_TOOLS` = 15 (`src/tools/index.ts:547`), `FLAT_TOOLS` = 31 (`src/tools/index.ts:714`), `OUTWARD_TOOLS` = 1 (`src/tools/index.ts:1033`). **Verificato per conteggio diretto** (grep sulle chiavi top-level di ciascun oggetto) — combacia esattamente con quanto dichiarato in `src/CLAUDE.md` ("registry pieno = **47 entry**").
- `RUNTIME_FLAGGABLE` (tier flag operazionali flippabili via `/flags` senza deploy, `src/flags_runtime.ts:46`) = **7 membri**: `PROVENANCE_GATE_ENABLED`, `LEDGER_AUTO_ENABLED`, `RECITATION_ENABLED`, `STEP_BUBBLES`, `TOOLRESULT_CLEARING_ENABLED`, `TIER2_ENABLED`, `WRITE_PROVENANCE_ENABLED`.
- Flag booleani/const in `src/flags.ts` (tier in-git, richiede deploy) = **18 export const**: `CONTRADICTION_EVICT_ENABLED`, `BASH_ENABLED`, `SANDBOX_ENABLED`, `PLEDGE_NUDGE_ENABLED`, `T11_AUTONOMOUS_PENDING_CAP`, `SELF_MINTER_ENABLED`, `SELF_MINTER_DAILY_BUDGET`, `TOOL_FORCING_RETRY_ENABLED`, `LEDGER_AUTO_ENABLED`, `RECITATION_ENABLED`, `TOOLRESULT_CLEARING_ENABLED`, `CRITIC_V2_ENABLED`, `GROUP_PROMPT_LEAN`, `STEP_BUBBLES`, `PROVENANCE_GATE_ENABLED`, `TIER2_ENABLED`, `WRITE_PROVENANCE_ENABLED`, `MUFFIND_IPC_ENABLED`.
- `TODO`/`FIXME` inline in `src/`: **0 occorrenze** (`grep -rE "// TODO|// FIXME|TODO:|FIXME:" src --include="*.ts"` → zero file). Il debito è tracciato in `docs/DECISIONS.md`/`docs/operations/INTERVENTIONS.md`/`docs/STATUS.md`, non in commenti inline.

---

## 2. Runtime

### 2.1 Gateway (path privato)

`src/gateway.ts` (2.890 righe) — riceve messaggi Telegram (o CLI/daemon, vedi §2.9), assembla il contesto, chiama il modello, dispatcha i tool, ritorna e chiude (no fire-and-forget su `callLight`: lavoro asincrono va in `work_queue` via `enqueueWork`). Funzioni chiave: `callChat` (634-1747, tool-use loop), `processMessage` (1748+, entry point pubblico), `streamChatCompletion` (282+).

**Stato: funziona in prod.** Evidenza: `callChat` dal 2026-07-13 (rito flag-lifecycle, PR-C, commit visibile in `docs/operations/INTERVENTIONS.md §2026-07-13`) delega **incondizionatamente** a `main_agent.ts:runMainAgent` — il flag `MAIN_USE_ENGINE` e il ramo `else` legacy (~973 righe di while-loop hand-rolled) sono stati cancellati, non solo spenti (`src/CLAUDE.md`, entry `flags.ts`). Live-turn interrupt via `Map<chatId, AbortController>` (`activeControllers`), stall watchdog rolling 60s + hard cap 5min su `streamChatCompletion` (`src/CLAUDE.md` §Gateway runtime).

### 2.2 React engine / loop unificato

`src/cognition/react_engine.ts` (1.657 righe) — `runReactLoop(ctx, cfg): Promise<LoopResult>`, il motore ReAct condiviso da reactor (task agent), gruppo, e main (via adapter `main_agent.ts`). Storia: ADR-145 (2026-07-01, estrazione da `reactor.ts`) → ADR-146 (chiusura: gateway resta via primitive condivise, non migrato in toto) → **ADR-154 (2026-07-04, riaperta)**: seam `modelCall` iniettato + `main_agent.ts:runMainAgent` costruito → **wiring flag-gated `MAIN_USE_ENGINE`, default ON dal 2026-07-04/05** → **GRADUATO 2026-07-13** (flag + ramo legacy cancellati, wiring incondizionato).

**Stato: funziona in prod, unico path per main/reactor/gruppo.** Tre adapter distinti sopra lo stesso motore: `reactor.ts:runWorker` (task agent), `group/gateway_group.ts:buildGroupExecuteToolCall` (gruppo, anch'esso graduato 2026-07-05 task #16, -581 LOC del ramo legacy), `main_agent.ts:runMainAgent` (main). **Gap dichiarato e non chiuso**: nessun equivalente del safety-break legacy `finish_reason==="length"` (truncated tool-call JSON) nell'engine — coercisce a `{}` invece di fermarsi (`src/CLAUDE.md`, entry `react_engine.ts`, "Gap noto non chiuso da questa migrazione").

**In-loop organs (T2, ADR-158, 2026-07-07).** Sull'engine sono cablati tre meccanismi di gestione-contesto/lunga-durata, tutti dietro `RUNTIME_FLAGGABLE`:
- `RECITATION_ENABLED` — mid-loop ledger recitation ogni 3 iterazioni con tool call (`src/cognition/react_engine.ts`, `shouldReciteLedger`/`buildLedgerRecitationMessage`).
- `TOOLRESULT_CLEARING_ENABLED` — tool-result clearing per batch read-only più vecchi di 3 iterazioni (`src/cognition/tool_clearing.ts`).
- `LEDGER_AUTO_ENABLED` — auto-attach di un `ledgerPath` su task/goal long-horizon.

**Stato misurato con harness dedicato (EVAL-NG `ledger-batch`, n=6/braccio, 2026-07-16)**: baseline (organi OFF) 0,17/35 item completati (~0,5%) vs organi ON 21,8/35 (~62%) — causalità confermata nei log. Sulla base di questo dato **entrambi i codeDefault sono stati flippati a `true`** in `src/flags.ts` il 2026-07-16 (commit `a923e00`), restano nel tier runtime come kill-switch di soak (non ancora "GRADUA"-ti, prossimo gate dichiarato entro 2026-08-16). `TOOLRESULT_CLEARING_ENABLED` resta `false` (gate separato, "NO-FLIP" dichiarato il 2026-07-12 su un altro task, `vault-triage`, 0/3 in entrambi i bracci).

### 2.3 Task agent

`src/reactor.ts` (1.065 righe) — `runWorker`/`processWorkItem`/`executeTaskAgent`. Plan-confirmation gate rimosso (ADR-110, 2026-06-26: task delegati eseguono direttamente). Budget adattivo: `getTaskIterationBudget` = base 10+2/step max 30; `getTaskTimeoutMs` = 180s+45s/step max 600s. **S4 checkpoint (ADR-112, 2026-06-27)**: `task_checkpoints` persiste stato dopo ogni tool execution, resume su restart entro finestra stale. `create_task` ha parametro opzionale `depth: "standard"|"deep"` (T2-d Slice-2, 2026-07-09) che applica `TASK_AGENT_BUDGET` (40 iter/30min/300k token — condiviso con `muffin run` CLI). Goal-loop (ADR-084/103, 2026-06-13): wrap del reactor con giudice **reference-based deterministico** (`cognition/goal_loop.ts:evaluateGoalReached`), cap 2 continuazioni, fail-open — **shipped**, non un progetto futuro.

**Stato: funziona in prod.** Evidenza diretta di limite misurato: `docs/strategy/2026-07-16-grande-ricerca-verdetto.md` riga 27 — "Collisione thinking-ON × budget 300k: TUTTE le run CLI (riuscite e no) esauriscono i token a 10-13 iterazioni su 40". Fix parziale già applicato: `LEDGER_RUN_MAX_TOKENS = 1_000_000` quando un ledger è attivo (`cognition/worker_config.ts`, commit `d915f94` "ledger-budget-retune" 2026-07-17) — **dichiaratamente non applicato** a `reactor.ts:executeTaskAgent`/`defaultWorkerConfigForTask` (task-agent `depth:"deep"`), solo al trunk CLI `muffin run`/daemon — "segnalato come follow-up aperto, non applicato in questo PR" (`src/CLAUDE.md`, entry ledger-budget-retune).

### 2.4 Demoni e dream cycle

**Demoni** (`src/demons/`, 1.495 righe, 7 file): `demon_observer.ts` (valence/arousal/signal_quality via callLight, on_message), `demon_connector.ts` (graph edges via cosine, on_message), `demon_temporal.ts` (statistiche attività, on_interval 30min — il campo `intervalMs` interno è dichiarato "puramente decorativo" da `src/CLAUDE.md`, nessun caller lo legge), `demon_explorer.ts` (esplorazione web giornaliera, max 2 Tavily + 2 callLight/giorno, via `scheduler.runDailyEvening`, non registrato in `daemon_manager`), `demon_introspection.ts` (settimanale via cron, non registrato in `daemon_manager`), `daemon_manager.ts` (registry `on_message`/`on_interval` — `on_salience` rimosso 2026-05-20, era già a zero consumer).

**Dream cycle** (`src/memory/memory_dream.ts`, 2.799 righe — il file più grande di `src/memory/`) — fasi nominate A, A0, B, C, D, D.5, D.6, F, F.5, G, H, i17, I (lettera, non numero — WG-6 world graph maintenance). Fasi principali documentate: A0 = self-observability (pipeline health + posture drift + telemetry digest); B/C/D = pattern extraction, graph maintenance, confidence decay; F = Living Profile (~500 token, tier-abile a Sonnet); F.5 = self-narrative (ADR-067); H = Counterpoint (~150 parole, anti-sycophancy, tier-abile a Sonnet); G = morning message; i17 = `recomputeBaselines()`; I = Phase I world-graph maintenance (alias-merge proposals, summary regen, importance recompute, predicate consolidation, silenzio detection — WG-6, ADR-066).

**Stato: funziona in prod con hardening esplicito contro hang.** Hard cap 12min (`DREAM_CYCLE_HARD_CAP_MS`, `dreamer.ts`, 2026-07-09) — motivato da un incidente misurato: "l'incidente 06-12 misurò ~3.3min di blocco reale + 2h di flag `dream_running` orfano" (`src/CLAUDE.md`, entry `dreamer.ts`). Abort-on-stop cooperativo aggiunto lo stesso giorno. Dream tier opt-in a Claude Sonnet 4.6 (`DREAM_MODEL_ENABLED` env, ADR-029) — vedi §6.

### 2.5 Scheduler/cron interni

`src/scheduler.ts` — `checkCronTriggers` pure function: `daily_morning` (prime 2h di peak), `daily_evening` (ultime 2h attive), `weekly_reflection` (lunedì mattina). Reminder via `deliverDueReminders`. `thinker.ts` orchestra 3 priority lane (fast/work-queue/slow) con polling SQLite 3s idle / 200ms busy + tick periodico 30min (`docs/reference/OPERATIONS.md:50`).

### 2.6 Transport Telegram

Refactor P0-P7 completato (`src/CLAUDE.md`, entry `telegram.ts`): superficie NON più monolitica — `src/telegram/adapter/` (draft/streaming, `draft_stream.ts`), `src/telegram/commands/` (`registry.ts` con `COMMANDS` array), `src/telegram/handlers/` (`delivery.ts`), `src/channel.ts` (typed transport `TelegramTransport`/`StatusEvent`, ADR-144). `src/telegram.ts` resta 2.851 righe (comandi + text handler storico, non tutta la superficie). Streaming nativo `sendMessageDraft` (Bot API 10.0+, ADR-133, 2026-06-30) con keepalive re-introdotto (ADR-138). **28 comandi Telegram registrati** (19 daily-menu visibili + 9 admin hidden-ma-digitabili, `src/CLAUDE.md` §Comandi Telegram).

### 2.7 Webapp/SPA

`src/webapp/server.ts` (3.528 righe — il file .ts più grande del repo) — Express, bind `127.0.0.1` (F4 hardening), auth via HMAC Telegram Mini App `initData`. ~30 endpoint documentati in `src/webapp/CLAUDE.md` (`/api/cockpit/*` aggregati, `/api/debug/*`, `/api/memory/*`, `/statusline/*`, `/oauth/*/callback`). SPA Vue 3 + Pinia + Vue Router, "Cockpit" (7 organi: Osservazioni, Demoni, Narrative, Dream, Grafo, Specchio + home) + "Registro" (6 sub-tab: Flusso/Moduli/Memoria/Sinapsi/VPS/Raw). Processo PM2 separato `muffin-webapp` (200MB cap, env minimizzato — F2 hardening, `docs/reference/OPERATIONS.md:49`).

**Stato: funziona in prod**, ma segnalato come superficie a bassa istrumentazione — `docs/strategy/2026-07-16-grande-ricerca-verdetto.md:75`: "Instrumentare le superfici secondarie (webapp) — i 2 bug più longevi (981 e 927 commit) vivevano lì" (S7 archeologia git, evidenza da 1.252 commit letti).

### 2.8 MuffinOS CLI esistente

`src/cli/` (4.614 righe) — **esiste già e gira**, non è concettuale. Slice S.1-S.6 (2026-05-28) + T1/T2/T3 (ADR-158 CLI-first, 2026-07-06/09):
- `muffin install` (bin entry `dist/cli/install.js`) — boot sequence 10 step: version, SQLite check, schema_version, models, sandbox-runtime, config.yaml, template setup (`templates/*.md` → `context/`), `ensureDefaultOperationalMode`, greeting, onboarding loop conversazionale HITL (`origin: "cli_onboarding"`, max 7 domande iniziali).
- `muffin run "<goal>"` (T1-a, 2026-07-06) — entry headless: boot identico a install, `[system, user]` freschi (no history — è un task), dispatch reale via `runMainAgent` (stesso gate/zone/provenance del path Telegram, zero nuova autorità), stdout lineare. Budget task: 40 iter/30min/300k token (o 1M se ledger attivo). Wall-clock enforced via timer→AbortSignal lato client (`src/cli/run.ts`).
- `muffin` (bare, REPL interattivo, T1-b, 2026-07-07) — Ink/React-per-terminale, lane CHAT (thinking OFF, budget 15 iter), `chatId="cli_repl"` scope isolato.
- `muffind` (daemon IPC, T3 slice-2/3, 2026-07-09) — Unix domain socket (`<project-root>/muffind.sock`), protocollo JSON-lines, un client alla volta, guard §I-9 (`isGroupScopedChatId` rifiuta turni-gruppo). **Resume cross-terminale** (non cross-restart-del-daemon): `session_store.ts` tiene `Map<chatId, SessionMessage[]>` in RAM del daemon, `muffin run`/REPL diventano client-con-fallback (provano il socket, altrimenti boot completo in-process).
- Dietro `MUFFIND_IPC_ENABLED` (`flags.ts`, **default OFF** — dichiarato "deploy, non un toggle").

**Stato: parziale/dormiente in prod** — il CLI headless (`muffin run`) e il REPL girano e sono testati (harness EVAL-NG li esercita davvero, non mock), ma il daemon `muffind` è flag-OFF di default e non risulta deployato/attivo sul VPS in questo inventario (nessuna evidenza di `MUFFIND_IPC_ENABLED=true` in produzione — verificabile solo da chi ha accesso al `.env` VPS, non letto in questo audit per divieto esplicito).

### 2.9 Deploy: systemd vs PM2

**Coesistenza dichiarata, systemd = prod dal 2026-07-10** (memoria utente `project_systemd_cutover_live`). Evidenza codice: `deploy/systemd/` con 3 unit-file (`muffin-bot`/`muffin-thinker`/`muffin-webapp`, watchdog `WatchdogSec=1800` via sd-notify) + `install-systemd.sh` + `deploy-systemd.sh`; `src/utils/systemd_notify.ts` (`notifyReady()`/`notifyWatchdog()`, lazy import `sd-notify@2.8.0`, no-op senza `$NOTIFY_SOCKET`); `/update` Telegram command (owner-only, **systemd-only** — rileva `$NOTIFY_SOCKET`, su PM2/dev risponde "non disponibile" senza tentare nulla, `docs/reference/OPERATIONS.md:76-78`). `ecosystem.config.cjs` (PM2, 3 processi: `muffin` 600MB, `muffin-webapp` 200MB, `muffin-thinker` 600MB) resta nel repo e `deploy.sh` (legacy) coesiste con `deploy-systemd.sh` finché il cutover a 4 fasi non è "completato" per dichiarazione esplicita di `docs/reference/OPERATIONS.md:54`. **Finish-notify** (`/update` → marker file `~/.muffin/update-notify.json` letto al boot successivo, commit `09e02db`, 2026-07-19 — l'ultimo commit di codice prima del blueprint) è l'intervento più recente sul deploy.

---

## 3. Memoria as-built

### 3.1 Le 4 categorie pragmatiche (post-collasso MEM-C, 2026-05-21)

Le vecchie tassonomie "9 layer numerati" e "6+1 lente A-G" sono state dichiarate **superseded** e vivono solo come "§Appendice storica" in `src/memory/CLAUDE.md:349-383` — "audit empirico … ha mostrato che entrambe vivevano solo nei doc, mai nel codice — decorative ceremony". **Importante nota di drift doc**: `docs/reference/ARCHITECTURE.md` (TOC: "6+1 layer di memoria", sezioni A-G) e `docs/reference/DATABASE.md` (TOC: "A — Substrato conversazionale" … "G — Operativo") **usano ancora la tassonomia superseded** — sono reference doc non aggiornati al collasso MEM-C, mentre `src/memory/CLAUDE.md` (fonte viva) usa le 4 categorie correnti.

Le 4 categorie correnti:
1. **Cognitive introspective** — cosa Muffin sa di Giusto + come si sente + come pensa (`facts`, `state_entries`, `patterns`, `muffin_behavior`, `episodes`, `narratives`, `raw_messages`, `observations`, `questions`, affect signature, living profile, counterpoint, self-narrative, biographical summary, agreement signals).
2. **Relational graph** — entità del mondo + relazioni cross-cutting (Layer 8 World Graph, `entities`/`entity_attributes`/`entity_edges`/`entity_mentions`, WG-2..WG-6 landed; legacy `graph_edges` item-similarity in transizione).
3. **Knowledge artifacts user-curated** — patrimonio filesystem (`~/muffin-knowledge/`) + indice SQLite ricostruibile (`knowledge_artifacts`, `knowledge_artifact_chunks`).
4. **Runtime in-context** — cosa entra nel prompt per turno (identity load, conversation buffer, working memory block, salience signal, dream summary, affect signature proattiva, recent tool calls, self-action recall hint, pattern instruction).

### 3.2 Pipeline di estrazione

- **Fatti/facts**: `memory_learning.ts` (1.393 righe) — critic LLM + fallback euristico (`heuristicFilterFacts`), dedup semantico + hash.
- **Entità**: `memory_entities.ts` (1.282 righe) — `disambiguateEntity` cosine-only (≥0.85 match, 0.7-0.85 ambiguous, <0.7 nuova — **P-L compliant**, zero LLM nella disambiguazione), hook write-path in 4 punti (`saveFact`, `saveObservation`, `demon_observer`, dream Phase D).
- **Embedding**: `qwen3-embedding:0.6b` via Ollama (`/v1/embeddings` OpenAI-compat), dim 1024, wrapper LRU cache 64 entry/90s in `memory_embeddings.ts` (path privato) + `cognition/embedding_with_fallback.ts` (orchestrazione condivisa privato↔gruppi). Fallback configurabile (`EMBEDDING_FALLBACK_PROVIDER`, default `"none"` — hard-fail local-first, mai un vettore di spazio diverso silenzioso).

### 3.3 FTS5 + sqlite-vec

`facts_fts`+`facts_vec`, `episodes_fts`+`episodes_vec`, `entities_fts`+`entities_vec`, `observations_vec`, `knowledge_artifacts_fts`+`knowledge_artifacts_vec`+`knowledge_artifact_chunks_vec` — hybrid retrieval via Reciprocal Rank Fusion (`db/helpers.ts:reciprocalRankFusion`). **Incidente causa-radice risolto e documentato** (`src/memory/CLAUDE.md:290`): `upsertVec` bindava il rowid come `number` (REAL) invece di `BigInt` → vec0 rifiutava ogni riga → **tutti i `*_vec` erano vuoti per un periodo non quantificato** (3312 righe attive con embedding, 0 indicizzate) mascherato da FTS + cosine in-memory come fallback silenzioso. Fix + backfill idempotente shippati 2026-06-10.

### 3.4 Recency decay

Due formule distinte: `recencyMultiplier` (knowledge-scale, half-life 7gg + floor 0.3) per facts/narratives/patterns/observations; `recencyMultiplierEpisode` (piecewise 12h sub-day + 3d cross-day, no floor) per episodi. **Decadimento su last-access, non su creazione** (`facts.last_accessed`, dal 2026-06-13) — un fatto vecchio ma richiamato spesso resta caldo.

### 3.5 Working memory

`memory_working_memory.ts:buildWorkingMemoryBlock` — buffer piatto z=3 turni del cluster corrente, iniettato come `<working_memory>` ultimo blocco prima del messaggio utente. **Dichiarato esplicitamente NON-Baddeley-Hitch**: "il modello multi-componente di Baddeley & Hitch 1974 NON è implementato", z=3 è "scelta engineering non derivata da paper (mai ablata vs z=2/4/5)" (`src/CLAUDE.md`, entry `memory_working_memory.ts`).

### 3.6 Deictic — RIMOSSO (ADR-153, 2026-07-04)

`src/utils/deictic.ts` (soppressione euristica regex IT, ~50 pattern) eliminato. Motivazione con crux misurato: il modello risolve i deittici nativamente dal `<working_memory>` block (0% ricerche-memoria inutili sui deittici veri), mentre la soppressione **bloccava ~11% di ricerche-memoria legittime sui turni-rumore**.

### 3.7 Verify pillar — 2 gambe RIMOSSE su 3 (ADR-151, 2026-07-04), 1 viva

- ~~`detectUnknownProperNouns` + `verify_pipeline.ts:verifyTermsInline()`~~ (3-canale, auto-fire Tavily pre-LLM) — **RIMOSSO**. Motivazione misurata: "euristica F1 0.61, ~50% falsi-positivi su dati reali … avverbi/interiezioni IT capitalizzate tipo 'Comunque'/'Scusa' flaggate come nomi propri sconosciuti", con esempio concreto di danno: "sei Freddo" [aggettivo] → search → "Freddo, marca gelati Cadbury" ripetuto dal modello come fatto verificato.
- **Verify-grounding / recall (C.2, ADR-124, VIVO)** — `memory_provenance.ts:factGroundingStatus(factId)` → `"grounded"|"ungrounded"|"legacy-null"`, deterministico, trace-or-flag. Tool `fact_provenance` (zona green).
- **URL citation post-pass (`verification/url_verify.ts`, VIVO, indipendente)** — regex extraction + substring-match contro i tool result del turno, logging-only, wired **solo nei gruppi** (osservato lì per la prima volta).

Il modello ora verifica da sé chiamando `web_search` quando giudica necessario, senza pre-decisione codice-side — reversal esplicito del principio "Codice > LLM per classificazione" per questo caso specifico (ADR-147, 2026-07-02).

### 3.8 Living profile / Counterpoint / Self-narrative

- **Living Profile** (Phase F, callMain o Sonnet tier) — sintesi narrativa ~500 parole, append-only history.
- **Counterpoint** (Phase H) — anti-sycophancy adversarial ~150 parole. Gate: `newCorrections≥1 OR newSilencePatterns≥1 OR newDismissals≥2 OR forceRegen 14gg`.
- **Self-narrative** (Phase F.5, ADR-067, 2026-06-11) — "Tre livelli di sé" Layer 2, ~300-450 token, trigger condizionale (≥3 correzioni O ≥7gg staleness O ≥10 outcome). **Nota di drift storico**: `VISION.md:39` lo descrive ancora come "⚪ Pianificato … NESSUNA pipeline live scrive" — quella riga è **stale**, il self-narrative è shippato dal 2026-06-11 (`src/memory/CLAUDE.md` riga 27, `muffin_self_narrative_history` è tabella reale nello schema, §1.6 sopra).

### 3.9 Belief revision — RIMOSSO (2026-06-18)

Pipeline Cycle 1 (`bot_claims.ts`, `contradiction.ts`, `revision_detect.ts`, `belief_revision_gating.ts`, `bot_claims_pipeline.ts`, `bot_claims_backing.ts`, `bot_claims_selfcheck.ts`, `nli_check.ts` — 8 file `cognition/` + equivalenti `memory/` e `group/`) **eliminata per intero**. Motivazione misurata: "8 noise-injections in 30 giorni, ZERO revisioni effettive mai avvenute" (7× stessa claim di process-narration, 1× self-capability). Tabelle `bot_claims`/`bot_claims_group`/`bot_claim_evidence` tombstoned §I-8 (mai droppate). Anti-sycophancy coperta ora da Counterpoint + `/bias`.

### 3.10 Compattazione

`memory_compression.ts` — history conversazionale (`conversations`, cap 200 messaggi) compressa via callLight quando supera 60 messaggi (sintesi narrativa + keep-last-25), cache 10min.

### 3.11 Cosa è VERIFICATO (eval/misurazione) vs solo cablato

| Meccanismo | Stato di verifica |
|---|---|
| Zombie-evict, fan-norm, lateral inhibition, route-relevance (Fase A memory_orchestration) | **Verificato con eval Mode-B su Gemma reale**: recall@5 base 33% → +all 83%; `+route` −59% token a parità di recall (`docs/pitches/memory_orchestration.md`, Done-when Fase A). |
| Unified activation (log-odds-of-need, `cognition/unified_activation.ts`) | **Verificato con 3 esperimenti confirmatori pre-flip**: 96.5% top-5 ranking overlap mult↔add, blind answer-quality ADD 5/MULT 1/tie 6, pool-admission floor 0.44 → zero bloat. Sempre-on dal 2026-07-13 (flag rimosso). |
| WG-6 entity retrieval (`applyEntitySignal`) | **Coverage misurata**: facts 70.2% (gate >70% soddisfatto), episodes 1.4% (gate NON soddisfatto per quella collection). |
| Task-ledger + recitation + tool-result-clearing | **Verificato con EVAL-NG harness sul runtime vero** (non mock): baseline 0,17/35 vs organi 21,8/35 item completati. |
| Budget per-categoria (Fase B #6 memory_orchestration) | **PARKED-ROTTO**: eval `+budget` = 0% recall, "enforce buca il retrieval" — dichiarato esplicitamente non-shippato. |
| Salience trim (topic-only) | **Verificato con eval-delta su 1398 turni reali** (`scripts/evals/salience-trim-delta.mjs`). |
| Deictic removal | **Verificato con crux live-API** (`scripts/evals/deictic-crux.mjs`). |
| Verify pillar removal | **Verificato su dati reali dev-DB** (audit `unknown_terms_emitted`, F1 0.61 misurato). |
| Contradiction-evict (`CONTRADICTION_EVICT_ENABLED`) | **Cablato, flag default `false`** — "validare ON-vs-OFF con `npm run eval:context-budget` prima del flip" (`docs/reference/ENVIRONMENT.md:19`), nessuna evidenza di un run completato in questo inventario. |
| Embedding upgrade arctic-embed2 (ADR-143) | Menzionato come "staged, owner-cutover" nel titolo ADR — non verificato in questo inventario se completato; l'eval "soglie-cosine pre-switch-embedding" resta nel piano `grande-ricerca-verdetto.md:74` come lavoro futuro ("4 istanze live su path di scrittura, mai validate su qwen3"). |

---

## 4. Tool registry

- **47 tool nel registry** (§1.8). **Model-candidate surface = ~46** (`getAllToolDefinitions().length`, consolida 41 sub-tool GitHub MCP in un meta-tool `github`, esclude `bash` se disabilitato, esclude zona `outward`). **Surface per-turno post-retrieval ~15-22 tool** (dopo `selectToolsForTurn` hybrid retrieval).
- **Permission zones**: green (esegui subito), yellow (batch-confirmable, va in `pending_actions`), red (conferma esplicita), + **tier-2 "act-notify-undo"** (ADR-159, 2026-07-07) dinamico yellow→green quando `TIER2_ENABLED` è ON: esegue subito e registra un revert in `undo_log` invece di accodare (`move_artifact` + le 9 azioni `delete_*` dei meta-tool memoria). + **zona `outward`** (4ª zona, ADR-068) per azioni verso terzi — mai esposta al modello come tool `send_*` diretto, sempre draft-by-default.
- **Classificazione HITL a 3 livelli**: `category: "read_only" | "always_ask" | "contextual"` sul registry entry (root `CLAUDE.md` §Regole di sync #2) — è il "prior art rilevante" esplicitamente citato nel `BRIEF.md` del blueprint stesso come modello di permessi esistente da estendere o rimpiazzare per il system layer.
- **Skill layer v0.3** (ADR-062/078/098): formato `SKILL.md` (frontmatter `P,O,A,V,F` — contratto SkillOps + `trigger` regex + piano fisso nel body). **2 skill esistenti**: `skills/appendi-e-invia/SKILL.md`, `skills/organizza-un-meet/SKILL.md`. Loader: `src/skills/skill_format.ts` (parse), `skill_engine.ts` (`runSkill`, sequencer puro, I/O dependency-injected), `skill_intent.ts` (invocazione deterministica pre-LLM via trigger regex), `skill_runtime.ts` (executeStep con deny-all + floor green-only). **B-autodraft learning loop** (ADR-125, 2026-06-28): detect-actual repeated tool-sequences (≥3 occorrenze su 7gg) → HITL approve via `/skills` → materialize `SKILL.md`. Tabella `skill_candidates` + `skill_usage` (telemetria: `use_count`, `last_used_at`).
- **Always-include-core** (#430, `ALWAYS_CORE_TOOLS`) — 14 entry pinnate indipendentemente dal retrieval: `web_search`, `fetch_url`, `set_preference`, `confirm_actions`, `memory_knowledge`, `memory_tracking`, `memory_stories`, `github`, `sqlite_query`, `send_message` (flag-gated, inerte con STEP_BUBBLES OFF), `create_task`, `draft_calendar_event`, `fs`, `find_tools`.
- **Tool retrieval via embedding**: `src/tools/tool_retrieval.ts` — hybrid additive (keyword cluster regex IT su 7 cluster: task/ops/inspect/dev/calendar/vault/academic + embedding cosine top-8 ≥0.15, unione deduped). **Problema documentato e risolto con un meta-tool dedicato**: `find_tools` (NS-3 slice-2, 2026-07-08) — quando il retrieval per-turno non pesca il tool giusto, il modello chiama `find_tools({query})` per cercare nel registro completo e caricare risultati aggiuntivi mid-turno (cap 30 tool/turno). Motivazione: "il retrieval per-turno RESTA (FULL perde a RETRIEVAL sui 43 tool pre-`find_tools`)" — cioè il retrieval è necessario (non un compromesso rimovibile), ma imperfetto, e la mitigazione è un tool di recovery, non l'abbandono del filtro.
- **Collasso 12→1 del vault** (ADR-161, 2026-07-09): 10 tool bespoke del knowledge vault → 1 primitiva `fs(op, path, content?, section?)` con 6 verbi. Zone/provenance/tier2/undo per-VERBO (non per-tool).

---

## 5. Gruppi/multi-tenant

### 5.1 Isolamento scope (§I-9, ADR-010/011)

Hard boundary CI-enforced via `scripts/lint-group-imports.sh`: `src/group/` **non può importare** da `src/memory/`, gateway, thinker, reactor, dreamer, demons — verificato con FORBIDDEN_SYMBOLS list. Direzione consentita: `group/`/`utils/` → `cognition/`, mai il viceversa. **Two-layer model** (ADR-122, 2026-06-28): DATA layer = scope-on-data (`chat_id` row-level, **provato leak-proof** da `scope_isolation_leak.test.ts`, 27 test, PR #476/#477, "real-DB confermato"); CONTROL-FLOW layer = forked deliberatamente (`gateway_group.ts`, `GROUP_TOOL_ALLOWLIST`, `group_vault.ts`, `SOUL_public.md` restano fork separati by design, non un debito).

### 5.2 Registro

Per-group config (`group_settings`): `group_kind` (`"private"|"community"|"work"`, ADR-088), `persona_overlay` (≤500 char), `language`. Registro comunicativo per-membro (`group_member_style`, ADR-088) — **carve-out §I-9 esplicito**: persiste SOLO `register_label` (enum 5 valori: formale/tecnico/giocoso/asciutto/caloroso) + bookkeeping, MAI fatti/psicologia/profilo individuale. Drift-guard runtime (`assertDriftGuard`) verifica lo schema a ogni write.

### 5.3 Layer A

Group traces 14gg retention (`group_turns`), verify pillar STRICTA per i gruppi (poi anch'essa rimossa 2026-07-04 con ADR-151, stesso razionale del privato), 3 sezioni anti-sycophancy in `SOUL_public.md`, `counterpoint_rollup` daily mirror del Phase H privato.

### 5.4 Voice enforcement

`output_sanitizer.ts` — strip `[u:ID|name]` marker, conversione a `<a href="tg://user?id=…">`, forbidden emoji strip (😂🤣, non 😅), `PIPE_TOOL_CALL_RE` belt-and-suspenders per leak di `<|tool_call>` letterale (ADR-135, 2026-06-30). `commitment_guardrail("enforce")` sul path gruppo (reframe deterministico delle promesse cave, `reframeTrailingAnnounce`) — **diverso dal privato**, che resta monitor-only (ADR-083: "lo STESSO trigger `trailing_announce`" ha enforcement diverso per scope, decisione owner esplicita).

### 5.5 Tabelle TTL con physical DELETE (eccezione a "mai cancellare righe")

Root `CLAUDE.md`: "le tabelle gruppo a TTL breve (`group_turns`, `group_response_log`, `group_traces`, `group_evidence`, `group_rate_limit`) fanno physical DELETE su cleanup" — unica eccezione dichiarata all'invariante soft-delete-ovunque. `group_turns` TTL 14gg (`cleanupOldTurns`), `group_response_log` 24h, `group_rate_limit` 7gg (legacy).

### 5.6 Findings emersi dai gruppi reali

- **Banter come feature, non bug** — `src/group/CLAUDE.md` cycle history 2026-05-09: voice-anchor (`getSimilarPastReplies`) **rimosso** 2026-06-16 per "banter contagion" (owner call) — il registro di gruppo tendeva a mimetizzare il tono scherzoso ricorrente invece di restare ancorato alla voce di Muffin.
- **Recall confabulato → SOUL_public stale** (2026-06-18): "@muffin riassunto ultime 2 settimane" → confabulazione + announce-then-stop, `recall_from_group` esisteva ma il modello non lo chiamava perché `SOUL_public.md` dichiarava ancora "Ho un solo tool: web_search" (stale dal Cycle 2). Fix: capability-list accurata + mandato esplicito "USARE SEMPRE" nella tool description (pattern poi riusato per `deep_research`, ADR-119).
- **`deep_research`/`deep_repo_analysis` tool-skip → aperti a tutti** (ADR-119/121, 2026-06-28): admin-gate rimosso dopo osservazione "0/3 chiamate nel DB in un giorno con richieste esplicite" — root cause doppio (description restrittiva + gate reale), fix su entrambi.
- **Bug tool-honesty nel path engine** (W2-C, 2026-07-03): con `GROUP_USE_ENGINE=true`, tool che ritornavano stringhe `"Error: ..."` (senza lanciare) venivano contati come successi dal commitment gate — fix `isGroupToolErrorResult` + `insertGroupArtifact` dead-catch-arm (ritorna `number|null`, mai lancia — il vault-write si dichiarava "salvato" anche a fallimento vero).

---

## 6. LLM stack corrente

### 6.1 Lane e modelli esatti

| Layer | Nome | Locale (Ollama) | API fallback (OpenRouter) |
|---|---|---|---|
| 1 | Salience | nessuno (pure math) | — |
| 2 | DMN/Demons (`callLight`) | `gemma4:e4b` | `google/gemma-4-26b-a4b-it` |
| 3 | TPN/Consciousness (`callMain`) | `gemma4:26b` | `google/gemma-4-26b-a4b-it` |
| 3.5 | Dream tier opt-in (`callDream`) | — | `claude-sonnet-4-6` (Anthropic direct, non OpenRouter) |

**Local-first orchestration** (`llm.ts:callWithFallback`): probe `/api/tags` verifica che il TAG ESATTO del modello sia pullato (non solo "Ollama è up"), poi cade su OpenRouter se assente. **Selezione locale RAM-adaptive** (slice-5, `src/resource_detection.ts`, 2026-07-09): soglie cgroup-aware `≥24GB`→26b+e4b, `8-24GB`→e4b+e4b, `<8GB`→API-only. `MUFFIN_FORCE_MODEL` override.

### 6.2 Storia degli switch (verificata via ADR)

- **ADR-059** (2026-06-01): reversal — Qwen3-VL (era stato promosso Q.1, 2026-05-29) → demosso a vision-adapter, famiglia Gemma torna primaria (`google/gemma-4-26b-a4b-it`). Eval-driven, non a priori.
- **ADR-060**: model swap = eval-gate esplicito, con "scaffold bifurcation" (potare decomposizione plan/execute che degrada Gemma, tenere il grounding).
- **ADR-111** (menzionato in commitment.ts entry): tool-forcing corrective retry, flag-gated dormant.
- **project_model_eval_rebuild_2026_06_27** (memoria utente): Qwen-14b valutato co-pari a Gemma su IT+tool, nessun mandato a lasciare Gemma, switch→shadow A/B (non eseguito in questo periodo).

### 6.3 Thinking ON/OFF e perché

**Thinking ON su `callMain`/dream/autonomous di default, ma OFF sul gateway live via `/think`** (default ON dal 2026-04-29, poi storicamente flippato OFF il 2026-04-27 e ri-flippato — vedi `src/CLAUDE.md` §Architettura LLM per la cronologia). **Root cause del rischio thinking-ON documentato**: "Gemma 4 26B-A4B (google/gemma-4-26b-a4b-it) con reasoning ON committeva alla risposta da prior bypassando le tool description" — reasoning ON = **confidence-amplifier** che regredisce il tool-calling. Fix idempotent-commands (2026-07-08): `/think on|off` set-esplicito sostituisce il vecchio toggle cieco, dopo "3 double-fire documentati in prod, l'ultimo ha lasciato thinking ON 11 giorni".

**Nella lane `cli_run`/task-agent, thinking è ON by design** (`thinking_policy.ts`, "evidence-based 57%-vs-14%") — causa diretta della collisione thinking×budget-300k misurata in `grande-ricerca-verdetto.md` (§2.3 sopra): ~28-30k token/iterazione quasi tutto reasoning invisibile.

### 6.4 Problemi documentati del modello attuale

- **Tool-skip / format contagion** (ADR-079, 2026-06-13): un fake tool-call testuale (`[Eseguo tool, args]`) sopravvissuto in `conversations.messages` insegnava a Gemma a imitare il formato invece di chiamare i tool — "loop auto-rinforzante riprodotto con probe". Fix: strip al chokepoint + history cleanup script.
- **False-completion / announce-then-stop**: root-cause diagnosticata come "framing CASUAL abbassa il segnale-agisci" (ADR-132), non un loop rotto. Tre tentativi storici di enforcement-sincrono-nel-turno, "3/3 regrediti a monitor-only in 2-10 giorni" (S7 archeologia, `grande-ricerca-verdetto.md:55`) — pattern ricorrente esplicitamente segnalato come "il problema è la strategia, non la tattica".
- **Ceiling genuino su task lunghi**: EVAL-NG `ledger-batch` misura 62% come plateau **dopo** tutte le cure di harness note, con riferimento a un paper con task quasi identico (QGP, arXiv 2605.23574) che mostra 0-5,6% su modello piccolo vs 72,2% su frontier — "il 62% non diventerà 100% con questi fix … oltre, si va di escalation ibrida o si aspetta un modello locale migliore".
- **`<|think|>` leak silenzioso**: citato in `THREAT_MODEL.md:161` come esempio storico reale — "Gemma emette `<|think|>` anche con `reasoning:{enabled:false}` → ha già rotto l'entity extraction per 5 settimane in silenzio" (S7).
- **Reasoning leak nel content channel**: `stripThoughtTags` gestisce ≥3 classi di pattern di leak documentati con incidenti datati (2026-05-05→05-11), con un **gap noto dichiarato**: "prose reasoning in EN/PT senza marker … non catturabile via regex" (`src/CLAUDE.md` §Architettura LLM).

---

## 7. Identità e context

### 7.1 File `context/*.md` e layering 4-tier (ADR-081, 2026-06-13)

```
context/
├── IDENTITY.md       — T1 immutabile: chi È Muffin + origine + invariante onestà + no-config (read-only per l'agente)
├── SOUL.md           — T2 persona: come si relaziona/comporta (editabile, affinabile dal living profile)
├── VOICE.md          — T2 forma: regole voce/emoji/lingua condivise privato+gruppi
├── USER.md           — T3 profilo owner (era GIUSTO.md — rinominato per genericità packaging)
├── HEARTBEAT.md      — T2 postura osservativa tra le conversazioni
└── public/
    ├── IDENTITY_public.md  — T1 pubblico immutabile per i gruppi
    └── SOUL_public.md      — T2 pubblico, standalone (non carica il bundle privato)
```

Ogni file privato ha un seed corrispondente in `templates/{IDENTITY,VOICE,SOUL,USER,HEARTBEAT}_template.md` (contratto template→loader, ADR-082) — un install fresco via CLI copia i template se i file `context/` mancano; senza template corrispondente, l'import di `loadPrivateIdentity()` crasha (drift-guard testato in `cli_install.test.ts`).

### 7.2 Come si costruisce il prompt

Ordine `dynamicCtx` (`gateway.ts:callChat`): `<semantic_history> + <behavior_context> + <active_system_state> + SYSTEM_PROMPT` (system text) → poi prepend al messaggio utente: `soulReminder + timeCtx + dynamicCtx (cognitive tags) + workingMemoryBlock + formatReminder`. **Ordine dichiarato "Gemma-aware"**: "SOUL alla fine per attention 1024-token" — nota esplicita che un futuro switch a Sonnet potrebbe invertire l'ordine ("Cycle 'context inversion gateway live' … può riordinare se path passa a Sonnet — non oggi").

**Cache**: nessuna prompt-cache su Ollama/Gemma via OpenRouter (non supportata dal provider per questo path). **Prompt cache Level 2 esiste solo per il dream tier** (`callDream`/Anthropic): `LLMCallParams.systemBlocks` con `cache_control:{type:"ephemeral"}` sui blocchi Phase F/H (~4288 token DREAM_SYSTEM_PROMPTS), con cross-phase cache hit quando F e H girano nello stesso ciclo.

### 7.3 Token budget e ledger (ADR-141, cap 1M)

`cognition/task_ledger.ts` — file markdown in `_task_ledger/<id>.md` nel vault, auto-attach su goal long-horizon (`isLongHorizonTask`, `shouldAutoActivateLedger`) quando `LEDGER_AUTO_ENABLED` è ON. `cognition/worker_config.ts:LEDGER_RUN_MAX_TOKENS = 1_000_000` — applicato SOLO quando un ledger è attivo, e SOLO al trunk `muffin run`/daemon (non a `reactor.ts` task-agent `depth:"deep"`, gap dichiarato). `TASK_AGENT_BUDGET` di default resta 300.000 token / 40 iterazioni / 30 min.

---

## 8. Debito e cimitero

### 8.1 Feature flag esistenti e stato (fonte: `src/flags.ts` + `src/flags_runtime.ts`, verificato a codice)

| Flag | Tier | Stato osservato nel codice |
|---|---|---|
| `LEDGER_AUTO_ENABLED` | runtime | codeDefault **`true`** dal 2026-07-16 (gate EVAL-NG valutato) |
| `RECITATION_ENABLED` | runtime | codeDefault **`true`** dal 2026-07-16, accoppiato a LEDGER_AUTO |
| `TOOLRESULT_CLEARING_ENABLED` | runtime | **`false`**, gate separato "NO-FLIP" 2026-07-12 |
| `PROVENANCE_GATE_ENABLED` | runtime | ON (eccezione dichiarata al criterio "mai flag di sicurezza nel tier runtime" — è un floor difensivo, non una capability) |
| `TIER2_ENABLED` | runtime | ON (default) |
| `WRITE_PROVENANCE_ENABLED` | runtime | ON (default) |
| `STEP_BUBBLES` | runtime | default `false` (gate: probe manuale owner via `scripts/step-bubbles-probe.mjs`) |
| `BASH_ENABLED` | in-git | ON — RCE chiuso 2026-06-11, env-leak chiuso 2026-07-06 (`project_bash_enabled_security`) |
| `SANDBOX_ENABLED` | in-git | default `true`, no-op se `bubblewrap`/Seatbelt assente sull'host |
| `MUFFIND_IPC_ENABLED` | in-git | default **OFF** |
| `PLEDGE_NUDGE_ENABLED` | in-git | default OFF (codice wired end-to-end, solo flag spento) |
| `SELF_MINTER_ENABLED` | in-git | [NON DETERMINATO il default esatto senza leggere il valore inline — presente come flag, consumer vivo in `memory_self_minter.ts`] |
| `CRITIC_V2_ENABLED` | in-git | presente, consumer da verificare (fact-critic criterion-2 rewrite, ADR-142) |
| `GROUP_PROMPT_LEAN` | in-git | default OFF (stub `<muffin_tech>` alternativo, eval-gated) |
| `TOOL_FORCING_RETRY_ENABLED` | in-git | dormant, "flag-gated (flag-gated, dormant)" per `commitment.ts` |
| `CONTRADICTION_EVICT_ENABLED` | in-git | default `false`, non validato con eval prima del flip |

**Rito flag-lifecycle** (2026-07-12/13/19): sistema esplicito con 4 verdetti (GRADUA/UCCIDI/ESPERIMENTO-CON-SCADENZA/KILL-SWITCH PERMANENTE). Nelle ultime settimane sono stati **graduati** (rimossi, comportamento reso permanente): `WG6_ENTITY_RETRIEVAL_ENABLED`, `UNIFIED_ACTIVATION_LIVE`, `GOAL_LOOP_ENABLED`, `TOOL_GUARDRAILS_ENABLED`, `AUTO_ARCHIVE_DOCUMENTS`, `AUTO_ARCHIVE_PHOTOS`, `ENTITY_BACKFILL_LANE_ENABLED`, `TEMPORAL_ROUTING_GUARD_ENABLED`, `GMAIL_DRAFT_AS_ARTIFACT_ENABLED`, `EMAIL_SEND_ENABLED`, `GMAIL_MODIFY_ENABLED`, `VAULT_FILE_OPS_ENABLED`, `GROUP_STATUS_EDIT_ENABLED`, `TOOL_RECAP`, `MAIN_USE_ENGINE`, `GROUP_USE_ENGINE`. **Uccisi** (gate fallito, rimossi senza sostituto): `HONESTY_STRIP_ENABLED` (gate >5%/confab mai raggiunto, misurato ~1%), `T1_PROACTIVE_SPINE_ENABLED` (dead code, gate di flip circolare), `T0_TYPED_MEMORY_ENABLED` (verificato no-op, Δ=0), `PROMISE_BRIDGE_ENABLED`+`PROMISE_BRIDGE_SIGNIFICANCE` (ADR-140, "REMOVE not tune"), `ANNOUNCE_MONITOR_ENABLED` (2026-07-19, verdetto 6,8% hollow residuo stabile, "ritirato SENZA costruire enforcement").

### 8.2 Moduli rimossi/superseded (elenco verificato a codice/CLAUDE.md)

| Modulo | Data rimozione | Motivo (con evidenza) |
|---|---|---|
| Belief revision (8 file `cognition/`+`memory/`+`group/`) | 2026-06-18 | 8 noise-injection/30gg, 0 revisioni effettive (ADR-093) |
| Verify pillar (unknown-terms, 3 canali) | 2026-07-04 (ADR-151) | F1 0.61, ~50% FP misurati su dev-DB |
| Deictic suppression | 2026-07-04 (ADR-153) | Crux: 11% ricerche-legittime bloccate, 0% guadagno sui veri deittici |
| Salience 4-segnali → topic-only | 2026-07-04 (ADR-149) | eval-delta su 1398 turni: 3/4 segnali degeneri |
| `announce_detect.ts` (loop-announce monitor) | 2026-07-19 | gate scaduto, 6,8% hollow residuo stabile |
| Task-agent D.3 (re-planning + `[CHAIN:]`) | 2026-06-03 | "0 hit in 30+ giorni" (memoria utente `project_task_agent_overengineered`) |
| Promise-bridge (ADR-108→140) | 2026-07-12 | "REMOVE not tune", detection separata resta viva |
| `intent_action` fire-from-code | 2026-06-08 (ADR-065) | re-eval sul modello deployato: 30/30 act-reliability senza fire-from-code, il ~50% di confab misurato prima era su modelli obsoleti (Qwen-VL/31b) |
| Voice-anchor gruppo (`getSimilarPastReplies`) | 2026-06-16 | banter contagion (owner call) |
| Group recap fire-from-code | 2026-07-04 (ADR-150) | 1.6% fire rate, ~50% FP, il modello lo fa già da solo esplicitamente |
| `shadow_inference.ts` (Qwen shadow loop) | 2026-05-28 | ridondante post-switch Qwen3-VL→primary poi rimosso anch'esso |
| `src/runner/` (Runner primitive Slice 1) | 2026-07-16 | orfano post-graduazione MAIN_USE_ENGINE, zero importer di produzione |

### 8.3 Bug noti aperti / limiti dichiarati (non esaustivo, campione a evidenza diretta)

- **Nessun equivalente del safety-break `finish_reason==="length"`** in `react_engine.ts` — gap dichiarato dalla migrazione ADR-145/154, mai chiuso.
- **`TASK_AGENT_BUDGET.maxTokens` non ritarato per `reactor.ts:executeTaskAgent`** quando ledger attivo — solo il trunk CLI l'ha ricevuto (`d915f94`).
- **11 azioni-"muro" tool-level** censite in audit 2026-07-14 (`docs/strategy/2026-07-16-grande-ricerca-verdetto.md:28`): paginazione Gmail/arXiv assente pre-fix, `fs(append)` content/section anti-pattern osservato "2 errori consecutivi" — parzialmente fixato (commit `3f09606` "tool-walls batch-1"), batch-2 dichiarato ancora aperto (memory list/search, `recall_period {from,to}` libero).
- **`src/utils/text_window.ts:extractCandidatePhrase`** dichiarato "ORFANO post-2026-07-04" — zero caller di produzione confermato via grep, "candidato a un futuro cleanup dedicato", non ancora rimosso.
- **`config_yaml_wire_or_prune`** in `docs/pitches/parked/` — `config.yaml` (Zod schema + YAML loader, S.4) esiste ma il suo destino (wire vs prune) è parcheggiato, non deciso.
- **Red-team gruppo mai eseguito post-isolation** (`THREAT_MODEL.md` G6, "Aperto — STATUS owner-action").
- **G1-G4 del THREAT_MODEL.md** (conferma outward non-indipendente dall'intento; verify pillar non copre re-emergere dal dream cycle; nessuno scanner retroattivo memoria; no guard anti-injection 2° ordine su skill-trace) — **nota di drift**: `THREAT_MODEL.md` è datato 2026-07-02, e la sua raccomandazione centrale (§5, "untrusted-context wrapper") risulta **in gran parte già implementata da ADR successivi non riflessi nel documento**: `ADR-157` (provenance gate, 2026-07-06) e `ADR-160` (write-provenance cross-turno, 2026-07-07) coprono esplicitamente la marcatura di provenienza + il floor su azioni derivate da contenuto tainted — il documento non è stato aggiornato per riflettere questo, quindi i gap G1/G2 come descritti sono probabilmente **parzialmente superati**, ma questo inventario non ha verificato la copertura esatta gap-per-gap (richiederebbe un audit dedicato, fuori scope A1).
- **`self_state_log`** — "TODO, no pitch" (`docs/STATUS.md:73`, drift strutturale residuo dichiarato aperto).

### 8.4 TODO/FIXME inline

**Zero** occorrenze (`grep -rE "// TODO|// FIXME|TODO:|FIXME:" src --include="*.ts"`). Il debito noto vive esclusivamente in `docs/DECISIONS.md` (ADR), `docs/operations/INTERVENTIONS.md` (cronaca), `docs/STATUS.md` (drift residuo), non in commenti inline nel codice.

### 8.5 Hotspot di complessità

| File/funzione | Righe | Nota |
|---|---|---|
| `src/webapp/server.ts` | 3.528 | Non decomposto — S7 archeologia lo cita come sede dei "2 bug più longevi" del repo |
| `src/group/gateway_group.ts` | 2.942 | Ridotto da ~3.490 (task #16, -581 LOC), ma resta il file .ts più grande sotto `src/` dopo `server.ts` |
| `src/gateway.ts` | 2.890 | Ridotto da 3.177 (rif. `orchestrator-layer-direction.md`) dopo la graduazione `MAIN_USE_ENGINE` |
| `callChat` (`src/gateway.ts:634-1747`) | 1.113 | God-function residua — orchestrator-layer-direction.md la descrive come fusione di 5 concern (context-assembly, loop, guardrail, agent-def, state) mai separate |
| `src/memory/memory_dream.ts` | 2.799 | 10+ fasi nominate in un solo file |
| `src/db/init.ts` | 2.467 | Schema SQL inline in template literal TS (77 tabelle + 10 virtual + indici, tutto in un file) |

---

## 9. Telemetria d'uso reale (SOLO da documentazione/codice, mai dal DB)

Nessuna query diretta al DB è stata eseguita per questo inventario (divieto esplicito del mandato). I numeri sotto sono **citazioni di misurazioni già effettuate e pubblicate nella documentazione operativa**, con la fonte.

- **Costo per turno tipico (path API, lane privata)**: "24k token in / 200 token out ≈ $0.003 + $0.0001 = ~$0.003/turn" su `google/gemma-4-26b-a4b-it` OpenRouter ($0.13/M input + $0.40/M output) — `src/CLAUDE.md` §Regole di sync #5.
- **Costo dream tier (Sonnet 4.6, opt-in)**: "$3/M input + $15/M output, costo per Phase F/H tipico ~$0.05-0.15/pass" — stesso paragrafo. Budget mensile dichiarato: "$2-5/mese" (`docs/reference/ENVIRONMENT.md:46`).
- **Costo demon_explorer**: "~$0.002/giorno" (max 2 Tavily + 2 callLight/giorno) — `src/CLAUDE.md` §Demoni e dream cycle.
- **Costo backfill semantic edges (WG-4)**: "~$0.15 per 148 facts" — `src/memory/CLAUDE.md`.
- **Postura di sicurezza misurata** (ADR-156, citata come evidenza del pivot): "Muffin vive in green (307/315 gate/30gg), bash 100% read-only, fs=vault-not-real, 0 exec/30gg" — 30 giorni di `agent_logs` osservati, fonte ADR-156 stesso.
- **EVAL-NG `ledger-batch`** (misura sperimentale, non produzione): n=6/braccio, baseline 0,17/35 (~0,5%) vs organi 21,8/35 (~62%) item completati — `docs/strategy/2026-07-16-grande-ricerca-verdetto.md`.
- **Volume produzione codice (S7 archeologia git, 1.252 commit letti)**: velocità "in accelerazione, 650→2594 righe/giorno in 4,5 mesi"; "2 bug longevi" sopravvissuti 981 e 927 commit rispettivamente; "9 build→remove cycles censiti".
- **Pattern-notification stuck** (diagnosi orchestratore su DB prod, citata in INTERVENTIONS 2026-07-19): "34 notifiche `pending` / 0 `delivered` dal 2026-07-11" (9 giorni), "pattern 149 in coda 5×, 148 3×, 23 pattern distinti su 34 righe totali" — evidenza di enqueue senza dedup, poi fixata.
- **Non determinato in questo inventario**: volumi messaggi/giorno correnti, token/giorno aggregati, costo mensile totale reale dell'istanza (richiederebbero query dirette al DB prod, esplicitamente vietate dal mandato A1).

---

## 10. Identità del progetto (citazioni testuali da `THESIS.md`/`PRINCIPLES.md`/`VISION.md`)

**Due gambe paritarie** (`THESIS.md:51-58`, post-pivot ADR-156 2026-07-06):
> "Muffin sta su **due gambe paritarie**, non una. È un **agente vero** — fa lavoro reale, autonomo, a lungo orizzonte … **E** su questo vive un secondo pilastro, alla pari: **capisce** … Nessuna gamba è al servizio dell'altra: sono i due assi dello stesso oggetto."

**Riferimento a The Machine** (`THESIS.md:60-63`):
> "The Machine **fa e vede insieme, perché vive dentro il sistema, non lo guarda da una finestra**."

**Il moat = continuità, non tecnica** (`THESIS.md:87-88`):
> "essere avanti non significa essere avanti sulla tecnica. Significa essere avanti sull'accumulazione."

**Sovranità del dato, non calcolo locale come invariante** (`THESIS.md` Principio 9, post-pivot):
> "L'invariante inattaccabile è la **sovranità del dato** … Su questo, un principio di *design* del harness: **MuffinOS resta local-capable per scelta**."

**Filtro 2 riformulato** (`PRINCIPLES.md` P-G, 2026-07-06):
> "Il filtro 2 colpisce l'esecuzione **senza punto di vista** … NON l'esecuzione ambiziosa. Un agente che fa lavoro reale, autonomo, a lungo orizzonte — *e* capisce, *e* ha voce propria — è **più** entità, non meno."

**Principio "mai scelte di configurazione esplicite"** — presente in root `CLAUDE.md` come principio operativo fondamentale ("Muffin non offre mai scelte di configurazione esplicite all'utente sul proprio comportamento. Inferisce, osserva, adatta.") e in `PRINCIPLES.md`/`THESIS.md` come principio 7 ("Inferenza, non configurazione. Muffin non chiede mai come comportarsi — osserva e adatta. Aggiungere form/settings è anti-pattern.").

**Lavoro autonomo reale come Principio operativo 12** (`THESIS.md:244-255`, nuovo post-pivot):
> "Il gate non è mai l'ambizione o la durata del lavoro — è **solo** il confine outward/irreversibile … e la **sicurezza** … La direzione è MuffinOS: il sistema operativo attraverso cui passa la vita digitale dell'owner."

**Vision — ispirazione dichiarata** (`VISION.md:7`):
> "L'ispirazione è The Machine di *Person of Interest* e JARVIS: un'intelligenza che conosce il suo utente, vive nella sua casa, e opera sui suoi dati — senza che nessun altro possa accedervi."

**Tesi vs realtà operativa — auto-audit dichiarato** (`THESIS.md:104-113`, datato 2026-04-29, valido come precedente metodologico): il documento stesso registra uno scarto storico tra dichiarazione e realtà (episodi cap 7gg, facts hard-deletati a 30gg in violazione del principio soft-delete, bi-temporale mai invocato) — e conclude: "gli invarianti … sono ciò che opera la tesi … Senza I-3 (provenance), I-4 (raw immutabile), I-7 (observability), il moat dichiarato è teoria." Questo pattern di auto-audit esplicito si ripete: P-J ("Audit periodico architettura vs realtà") è un principio codificato, non solo una pratica.

**Fase del progetto dichiarata esplicitamente calibrata, non atemporale** (`PRINCIPLES.md` P-H): il documento prescrive la propria rilettura integrale a ogni "transizione di fase" — l'ultima registrata è il 2026-07-06 (pivot agent-first). Questo stesso blueprint MuffinOS (mandato owner 2026-08-04) è, per la logica del documento, una transizione ulteriore.

---

## 11. Roba già pensata per il futuro (esiste già come pensiero nel repo)

### 11.1 `docs/foundations/MUFFINOS_ARCHITECTURE.md` — framing OS già adottato (ADR-033, 2026-05-20)

Documento dedicato che mappa **esplicitamente** i concetti OS al codice esistente: kernel=gateway, syscall=tool, processo=demone, filesystem=memory layers, IPC=work_queue, boot=CLI install. Include una sezione "Cosa MuffinOS NON è" (non un Linux distro, non kernel-level isolation, non multi-tenant, non un protocollo standard, non un OS kernel rewrite) e un piano di packaging (Docker compose primary, one-liner installer secondary, single-binary aspirational bloccato da native bindings). **Nota di drift**: il documento è datato 2026-05-20, pre-ADR-156 — cita "~22 tool top-level" (oggi 47) e "GIUSTO.md" (rinominato USER.md da ADR-081, 2026-06-13) — il framing concettuale resta valido ma i numeri sono stale.

### 11.2 Pitch aperti (status READY/shaping, non ancora build o solo parzialmente costruiti)

- **`docs/pitches/agentic_kernel_v04.md`** — goal-loop come "loop sopra il tool loop". Slice-1 (giudice reference-based) **shipped** 2026-06-13. Slice-2 (checkpoint/resume) e Slice-3 (judge locale 3B) **dichiarate differite** — ma nota importante: `grande-ricerca-verdetto.md:15` segnala che "il pitch agentic_kernel era stale: checkpoint/resume (S4) e budget-da-agente (S3) — che credevamo da costruire — **sono già costruiti**" (rispettivamente ADR-112 S4 checkpoint, e i budget espliciti su `WorkerConfig`).
- **`docs/pitches/memory_orchestration.md`** — Select-layer upgrade (Fase 0-D). Fase 0+A shipped, Fase B parzialmente shipped (unified activation sì, budget-per-categoria PARKED-ROTTO), Fasi C/D "spec a ridosso dell'apertura" — non iniziate.
- **`docs/pitches/research_orchestrator.md`** — deep research come primo orchestratore multi-agente con spawn di sub-agent (PR1-PR4, big-batch strutturato in slice eval-gated). Include già un design esplicito per spawn controllato (green-only, depth=1, cap 5, budget ~$0.10/ricerca) — **non ancora costruito** al momento di questo inventario (`Status: shaping`, creato 2026-07-01, nessuna evidenza di PR mergiata trovata nei commit recenti letti).

### 11.3 `docs/strategy/2026-07-04-orchestrator-layer-direction.md` — diagnosi "god-function", primitivi Agent/Runner/Guardrails

Sintesi di 4 scout SOTA (LangGraph, OpenAI Agents SDK, Mastra, CrewAI/Letta): diagnosi che "il problema non è il loop — è la SHAPE" (5 concern fusi in `callChat`). Verdetto esplicito: **"Non migrare — ruba i pattern"** — il moat-memoria SQLite di Muffin è giudicato "pari-o-superiore" a quello dei framework esterni esaminati. Target dichiarato: primitivo `Agent` (main come istanza #1, ADR-152), `Runner` (state-machine tipizzata — **poi effettivamente rimossa** come `src/runner/`, 2026-07-16, "orfana post-graduazione MAIN_USE_ENGINE" — un caso concreto di impalcatura costruita e poi smontata quando il segnale è cambiato), `Guardrails` (contratto unico `{output_info, tripwire}` — **shipped**, `src/guardrails/`), `Memory` (model-fetch on-demand, ADR-147 — **shipped**), `Goal-loop` (giudice tri-state — **shipped, versione binaria reached/not-reached**, non tri-state con `WAITING=0.5` come proposto).

### 11.4 `docs/strategy/2026-06-11-agentic-os-research.md` — origine della direzione agentic-OS v0.4

Deep-dive Hermes con "20 claim verificati" (citato ma non riletto integralmente in questo inventario — 118 righe, contiene il gap-#1 vs Hermes che ha originato `agentic_kernel_v04`). Riferimento diretto in `docs/STATUS.md:24`: "kernel = enforcement deterministico che il modello non può bypassare (già ~80% in casa); regime conversion via skill … goal-graph + judge locale reference-based; asse ToM/privacy-delegation NON verificato".

### 11.5 `docs/strategy/2026-07-16-grande-ricerca-verdetto.md` — l'audit più recente e più diretto rispetto al mandato del blueprint attuale

Risposta a un mandato owner quasi identico nello spirito a quello di questo stesso blueprint ("controlla Muffin in tutto e per tutto — cosa va sostituito da librerie, cambiato, tolto, rifattorato … Non so se quello che stiamo facendo sia giusto dato quanto poco riesce a fare Muffin"), eseguito 19 giorni prima con **7 scout paralleli + 1 misura EVAL-NG**. Verdetto finale citato per esteso:
> "La direzione (ADR-156, due gambe pari, CLI-first, kernel-enforcement) è **confermata da dentro, da fuori e dalla storia** — non serve un redesign, e quasi niente va sostituito da librerie."

Include un **de-scope esplicito** ("Cosa NON facciamo"): non migrare a framework agentico, non fine-tunare il modello, non competere su capacità esecutiva coi frontier lab, non un 4° tentativo di enforcement-sincrono, non riaprire graph-memory/reranker (già scartati sui dati propri). E un piano DAG con item già in stato "ORA"/"PROSSIMO" — tra cui **"Swap Telegraf→grammY (ratificato owner 07-16)"** e **"Decisione `src/runner/`"** (poi risolta con la cancellazione, §11.3) — cioè decisioni concrete già prese nei 19 giorni precedenti questo blueprint, non speculazione.

### 11.6 CLI-first come tronco già costruito, non proposta

`ADR-158` (2026-07-06, "Runtime CLI-first: il core è un agente long-running, i canali sono adapter") è **già implementato per gran parte della sua superficie** (§2.8 sopra): `muffin run`, REPL, daemon IPC con resume-cross-terminale. Questo è direttamente rilevante per il vincolo di Livello 0 #1 del `BRIEF.md` ("CLI-first. MuffinOS si installa e parte da terminale. Ogni altra interfaccia è un connector.") — il repo ha già una risposta parziale e testata a questo vincolo, non è terreno vergine.

### 11.7 Primitive layer reframe (memoria utente `project_primitive_layer_reframe_2026_07_06`, non riletta per esteso in questo inventario ma coerente con l'evidenza codice)

Menzionata nell'indice memoria come "52 tool=sedimento; primitive/syscall layer (~10-12: moat+outward=invarianti); retrieval=sintomo" — coerente con l'evidenza diretta raccolta qui: il registro è già sceso da un picco storico (54 pre-collasso citato in `src/CLAUDE.md`) a 47, con un collasso 12→1 già eseguito sul vault (ADR-161) e un altro meta-tool di recovery (`find_tools`) costruito per compensare i limiti del retrieval invece di eliminarlo.

---

## Numeri di sintesi

| Metrica | Valore | Fonte |
|---|---|---|
| LOC totali `src/` (stima per somma directory) | ~193.000 | `find + wc -l` per subsystem, §1.1 |
| File .ts più grande | `src/webapp/server.ts`, 3.528 righe | `wc -l`, §1.2 |
| File .ts più grande fuori webapp | `src/group/gateway_group.ts`, 2.942 righe | §1.2 |
| `callChat` (god-function residua) | 1.113 righe (`gateway.ts:634-1747`) | grep + calcolo diretto, §1.2 |
| Sottosistema più grande | `src/memory/`, 40.867 righe | §1.1 |
| Dipendenze npm runtime | 23 (`dependencies`) | `package.json`, §1.3 |
| Dipendenze npm dev | 22 (`devDependencies`) | `package.json`, §1.3 |
| File test | 381 (370 `src/` + 11 `scripts/evals/`) | `find` + `vitest.config.ts`, §1.4 |
| Risultato run live (2026-08-04, questa sessione) | 6.432 passed / 3 failed (timeout non-logici) / 1 skipped su 6.436 | `npm test -- --run`, §1.4 |
| Env vars documentate | 54 | `docs/reference/ENVIRONMENT.md`, §1.5 |
| Tabelle SQL reali | 77 | `src/db/init.ts`, §1.6 |
| Virtual table (fts/vec) | 10 | `src/db/init.ts`, §1.6 |
| ADR totali | 150 (numerati 1-163, 13 gap) | `docs/DECISIONS.md`, §1.7 |
| Tool nel registry | 47 (15 STABLE + 31 FLAT + 1 OUTWARD) | `src/tools/index.ts`, §1.8 |
| Tool model-candidate surface | ~46 | `getAllToolDefinitions()`, §4 |
| Tool per-turno (post-retrieval) | ~15-22 | `selectToolsForTurn`, §4 |
| Flag `RUNTIME_FLAGGABLE` (tier senza-deploy) | 7 | `src/flags_runtime.ts`, §1.8/8.1 |
| Flag in-git (`src/flags.ts`) | 18 | §1.8/8.1 |
| TODO/FIXME inline in `src/` | 0 | grep, §1.8/8.4 |
| Skill esistenti (`SKILL.md`) | 2 | `skills/`, §4 |
| Demoni registrati | 5 file demone + 1 manager + 1 base | `src/demons/`, §2.4 |
| ADR pivot costituzionale più recente | ADR-156 (2026-07-06, agent-first, due gambe pari) | `docs/DECISIONS.md`, §10 |
| Audit strategico più recente pre-blueprint | 2026-07-16 "Grande Ricerca" (7 scout + EVAL-NG) | `docs/strategy/2026-07-16-grande-ricerca-verdetto.md`, §11.5 |
| Ultimo commit di codice prima del blueprint | `09e02db`, 2026-07-19 | `git log`, header report |
| Pitch aperti (READY/shaping) | 3 (`agentic_kernel_v04`, `memory_orchestration`, `research_orchestrator`) | `docs/pitches/`, §1/§11 |
| Pitch chiusi (`done/`) | 35 | `docs/pitches/done/`, §1 |
| Pitch parcheggiati | 21 (+1 `README.md` indice) | `docs/pitches/parked/`, §1 |
