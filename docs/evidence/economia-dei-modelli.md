# A5 — Modelli ed Economia (MuffinOS Blueprint, Fase A)

**Ruolo:** scout, sola evidenza con fonte. Nessun verdetto/raccomandazione — decide l'agente principale.
**Data di rilevazione:** 2026-08-04 (tutte le fonti sotto sono state aperte in questa data, salvo diversa indicazione).
**Metodo:** WebSearch/WebFetch. Pagine ufficiali fetchate direttamente dove possibile; quando bloccate (403/JS-render/redirect non risolvibile) uso aggregatori, triangolati su più fonti indipendenti quando possibile, sempre etichettati.

**Tag di confidenza usati:**
- `[VERIFICATO]` = fonte ufficiale primaria (dominio del vendor) fetchata direttamente in questa sessione.
- `[TRIANGOLATO]` = 2+ fonti indipendenti (aggregatori o secondarie) concordi sullo stesso numero.
- `[FONTE SINGOLA]` = una sola fonte secondaria/aggregatore, non incrociata con altre.
- `[DISCREPANZA]` = fonti in conflitto tra loro — riportate entrambe, non risolte.
- `[NON VERIFICATO]` = claim che non sono riuscito a confermare in questa sessione.

---

## 0. Cosa NON ri-derivo (già coperto altrove, esteso qui)

- `.claude/agent-memory/research-scout/2026-07-06-consumer-model-slate.md` (2026-07-06) — landscape modelli consumer/local specifico per Muffin, hardware reale VPS/dev (CX23 4GB, dev Mac 16GB), verdetto "local-first è un'etichetta non una pratica" per l'incumbent Gemma-4-26b-a4b. Questo report A5 **estende** quel lavoro su: pricing aggiornato ad agosto 2026 (nuova famiglia Claude 5/Fable/Mythos, GPT-5.6, Gemini 3.x — tutti post-datano quel report), ToS abbonamenti consumer, meccanica caching, self-improvement, dati di consumo reale always-on. Non ri-verifico i benchmark interni Gemma-4-26b-a4b citati là (extraction 0.807, agency 85%, ecc.) — sono INTERNAL a Muffin, citati non ri-derivati.
- `.claude/agent-memory/research-scout/2026-06-27-hosted-api-model-candidates.md` — landscape API-only a fine giugno 2026 (Gemini 2.5 Flash-Lite, DeepSeek V3.2, Mistral Small, Claude Haiku 4.5, GLM). Superato dai rilasci di luglio-agosto 2026 (sotto): quei modelli sono ora legacy/deprecati o affiancati da generazioni successive.
- Non ri-tratto qui l'inventario codebase Muffin (A1) né gli score interni Muffin sui suoi harness — fuori scope di questo mandato.

---

## 1. Panorama tier — pricing API per famiglia (MANDATO 1)

### 1.1 Frontier API — Anthropic

Fonte primaria fetchata direttamente: **https://platform.claude.com/docs/en/about-claude/pricing** (redirect ufficiale da anthropic.com/pricing → claude.com/pricing → platform.claude.com/docs), 2026-08-04. `[VERIFICATO]`

| Modello | Input base | Cache write 5m | Cache write 1h | Cache hit/read | Output |
|---|---|---|---|---|---|
| Claude Fable 5 | $10/MTok | $12.50/MTok | $20/MTok | $1/MTok | $50/MTok |
| Claude Mythos 5 (accesso limitato) | $10/MTok | $12.50/MTok | $20/MTok | $1/MTok | $50/MTok |
| Claude Opus 5 | $5/MTok | $6.25/MTok | $10/MTok | $0.50/MTok | $25/MTok |
| Claude Opus 4.8 | $5/MTok | $6.25/MTok | $10/MTok | $0.50/MTok | $25/MTok |
| Claude Opus 4.7 | $5/MTok | $6.25/MTok | $10/MTok | $0.50/MTok | $25/MTok |
| Claude Opus 4.6 | $5/MTok | $6.25/MTok | $10/MTok | $0.50/MTok | $25/MTok |
| Claude Opus 4.5 | $5/MTok | $6.25/MTok | $10/MTok | $0.50/MTok | $25/MTok |
| Claude Opus 4.1 (deprecato) | $15/MTok | $18.75/MTok | $30/MTok | $1.50/MTok | $75/MTok |
| Claude Sonnet 5 — **fino al 31 agosto 2026** (prezzo introduttivo, in vigore ORA) | $2/MTok | $2.50/MTok | $4/MTok | $0.20/MTok | $10/MTok |
| Claude Sonnet 5 — **dal 1° settembre 2026** | $3/MTok | $3.75/MTok | $6/MTok | $0.30/MTok | $15/MTok |
| Claude Sonnet 4.6 | $3/MTok | $3.75/MTok | $6/MTok | $0.30/MTok | $15/MTok |
| Claude Sonnet 4.5 | $3/MTok | $3.75/MTok | $6/MTok | $0.30/MTok | $15/MTok |
| Claude Haiku 4.5 | $1/MTok | $1.25/MTok | $2/MTok | $0.10/MTok | $5/MTok |
| Claude Haiku 3.5 (retired salvo Bedrock/GCP) | $0.80/MTok | $1/MTok | $1.60/MTok | $0.08/MTok | $4/MTok |

Batch API (sconto 50% flat su input e output, cumulabile con caching): Fable 5 $5/$25, Opus 5 $2.50/$12.50, Sonnet 5 (intro) $1/$5, Haiku 4.5 $0.50/$2.50. `[VERIFICATO stessa fonte]`

**Nota sulla famiglia "Claude 5"**: non è una singola riga di prodotto. Il 9 giugno 2026 Anthropic ha lanciato una classe **sopra Opus**, "Mythos-class", con due varianti: **Claude Fable 5** (rilascio pubblico, safeguard forti, disponibile su API `claude-fable-5`/app/Bedrock) e **Claude Mythos 5** (stesso modello sottostante con salvaguardie ridotte, accesso ristretto al solo programma "Project Glasswing" per infra-provider e ricercatori cybersecurity vettati — Mythos "può trovare e sfruttare vulnerabilità software più efficacemente di quasi ogni essere umano esperto"). Il 12 giugno 2026 l'export control USA ha forzato una sospensione temporanea globale di accesso a entrambi (impossibilità di verificare nazionalità in tempo reale); restrizioni revocate il 30 giugno 2026.
Fonti: [TechCrunch 2026-06-09](https://techcrunch.com/2026/06/09/anthropic-released-claude-fable-5-its-most-powerful-model-publicly-days-after-warning-ai-is-getting-too-dangerous/), [Anthropic — Redeploying Claude Fable 5](https://www.anthropic.com/news/redeploying-fable-5), [Al Jazeera 2026-07-01](https://www.aljazeera.com/economy/2026/7/1/us-lifts-restrictions-on-powerful-ai-models-fable-mythos-anthropic-says), [InfoQ 2026-06](https://www.infoq.com/news/2026/06/claude-5-release/). `[TRIANGOLATO]`

Nota tokenizer: "Claude 4.7 e modelli successivi + Claude Mythos Preview usano un tokenizer più nuovo che produce ~30% più token a parità di testo" — impatta il conteggio costi reale, non solo il prezzo/token nominale. `[VERIFICATO, stessa pagina pricing]`

Nota context: Claude 4.6+ e Mythos Preview includono 1M token di context window a prezzo standard (una richiesta da 900k token costa quanto una da 9k, per token). `[VERIFICATO]`

### 1.2 Frontier API — OpenAI

Fonte: **https://developers.openai.com/api/docs/pricing** (redirect da openai.com/api/pricing), fetchata 2026-08-04. La pagina consumer `chatgpt.com/pricing` e `openai.com/chatgpt/pricing` hanno restituito 403 in questa sessione — dati di quella sezione (§4.2) da aggregatori triangolati. `[VERIFICATO per la tabella sotto, dominio developers.openai.com]`

| Modello | Input | Cached input | Output |
|---|---|---|---|
| gpt-5.6-sol | $5.00/M | $0.50/M | $30.00/M |
| gpt-5.6-terra | $2.00/M | $0.20/M | $12.00/M |
| gpt-5.6-luna | $0.20/M | $0.02/M | $1.20/M |
| gpt-5.5 | $5.00/M | $0.50/M | $30.00/M |
| gpt-5.5-pro | $30.00/M | — | $180.00/M |
| gpt-5.4 | $2.50/M | $0.25/M | $15.00/M |
| gpt-5.4-mini | $0.75/M | $0.075/M | $4.50/M |
| gpt-5.4-nano | $0.20/M | $0.02/M | $1.25/M |
| gpt-5.4-pro | $30.00/M | — | $180.00/M |
| gpt-5.2 | $1.75/M | $0.175/M | $14.00/M |
| gpt-5.1 / gpt-5 | $1.25/M | $0.125/M | $10.00/M |
| gpt-5-mini | $0.25/M | $0.025/M | $2.00/M |
| gpt-5-nano | $0.05/M | $0.005/M | $0.40/M |
| gpt-5-pro | $15.00/M | — | $120.00/M |
| gpt-4.1 | $2.00/M | $0.50/M | $8.00/M |
| gpt-4.1-mini | $0.40/M | $0.10/M | $1.60/M |
| gpt-4.1-nano | $0.10/M | $0.025/M | $0.40/M |
| gpt-4o | $2.50/M | $1.25/M | $10.00/M |
| gpt-4o-mini | $0.15/M | $0.075/M | $0.60/M |
| o3 | $2.00/M | $0.50/M | $8.00/M |
| o3-pro | $20.00/M | — | $80.00/M |
| o4-mini | $1.10/M | $0.275/M | $4.40/M |
| o1 / o1-pro | $15–150/M | — | $60–600/M |

Nota: "Il 30 luglio 2026 OpenAI ha tagliato il prezzo di Terra del 20% e di Luna dell'80%; Sol è rimasto al prezzo di lancio" — modello **gpt-5.6** è l'attuale famiglia flagship (GA dal 2026-07-09, vedi §5.2 per il cambio di meccanica caching associato). `[TRIANGOLATO, multiple fonti aggregatore concordi: tldl.io, devtk.ai, benchlm.ai]`

### 1.3 Frontier API — Google Gemini

Fonte primaria fetchata direttamente: **https://ai.google.dev/gemini-api/docs/pricing**, 2026-08-04. `[VERIFICATO]`

| Modello | Input | Output | Cache read | Cache storage |
|---|---|---|---|---|
| Gemini 3.6 Flash | $1.50/M | $7.50/M | $0.15/M | $1.00/M-tok/ora |
| Gemini 3.5 Flash | $1.50/M | $9.00/M | $0.15/M | $1.00/M-tok/ora |
| Gemini 3.5 Flash-Lite | $0.30/M | $2.50/M | $0.03/M | $1.00/M-tok/ora |
| Gemini 3.1 Flash-Lite | $0.25/M (testo) | $1.50/M | $0.025/M | $1.00/M-tok/ora |
| **Gemini 3.1 Pro Preview** | $2.00/M (≤200k) / $4.00/M (>200k) | $12.00/M (≤200k) / $18.00/M (>200k) | non elencato nella tabella fetchata | non elencato |
| Gemini 2.5 Pro (GA) | $1.25/M (≤200k) / $2.50/M (>200k) | $10.00/M (≤200k) / $15.00/M (>200k) | $0.125/$0.25 (10% = stesso sconto 90%) | $4.50/M-tok/ora |
| Gemini 2.5 Flash | $0.30/M | $2.50/M | $0.03/M | $1.00/M-tok/ora |
| Gemini 2.5 Flash-Lite | $0.10/M | $0.40/M | $0.01/M | $1.00/M-tok/ora |

**Nota importante**: la pagina ufficiale fetchata **non elenca una riga GA "Gemini 3 Pro"** — il tier Pro più recente presente è "Gemini 3.1 Pro Preview" (ancora in preview per prezzo/listino ufficiale alla data di rilevazione). Una fonte aggregatore (apidog.com) cita "Gemini 3 Pro" con le stesse identiche cifre ($2/$12 ≤200k, $4/$18 >200k) — probabile la stessa entry rinominata o una generazione intermedia non più separatamente listata. `[DISCREPANZA non risolta tra nome "Gemini 3 Pro" (aggregatore) e "Gemini 3.1 Pro Preview" (pagina ufficiale) — le cifre coincidono]`

### 1.4 Mid-tier API (Sonnet-class / Flash-class / DeepSeek)

| Modello | Input/Output $/M | Note | Fonte |
|---|---|---|---|
| Claude Sonnet 5 (intro, fino 31/8/26) | $2/$10 | vedi §1.1 | `[VERIFICATO]` |
| Claude Haiku 4.5 | $1/$5 | vedi §1.1 | `[VERIFICATO]` |
| Gemini 3.5 Flash-Lite | $0.30/$2.50 | vedi §1.3 | `[VERIFICATO]` |
| Gemini 2.5 Flash-Lite | $0.10/$0.40 | vedi §1.3 — tra i più economici in assoluto | `[VERIFICATO]` |
| gpt-5.6-luna | $0.20/$1.20 | vedi §1.2 | `[VERIFICATO]` |
| gpt-5-nano | $0.05/$0.40 | vedi §1.2 — il più economico OpenAI | `[VERIFICATO]` |
| DeepSeek V4-Flash (API ufficiale) | $0.14 input cache-miss / $0.0028 cache-hit / $0.28 output | 284B totali/13B attivi MoE, MIT, 1M context | `[VERIFICATO — api-docs.deepseek.com/quick_start/pricing, fetch diretto 2026-08-04]` |
| DeepSeek V4-Pro (API ufficiale) | $0.435 input cache-miss / $0.003625 cache-hit / $0.87 output | 1.6T totali/49B attivi MoE, MIT, 1M context, fino 384K output | `[VERIFICATO — stessa fonte]` |
| Mistral Large 3 (API) | $0.50/$1.50 (fonte secondaria) | 675B sparse MoE, Apache 2.0, 256K context | `[FONTE SINGOLA — intuitionlabs.ai/mindstudio.ai, non incrociata sul prezzo esatto]` |

Nota: DeepSeek ha annunciato che introdurrà **prezzi peak/off-peak** (2x durante 9:00-12:00 e 14:00-18:00 orario di Pechino, dettagli implementativi non ancora ufficializzati alla data di rilevazione). `[VERIFICATO — api-docs.deepseek.com]`

### 1.5 Open-weight top — ultime release con data, licenza, dimensioni

| Famiglia | Release più recente | Data | Licenza | Dimensioni | Fonte |
|---|---|---|---|---|---|
| **DeepSeek** | V4-Pro / V4-Flash (preview, stabile per produzione; versione stabile finale attesa entro il 2026) | 2026-04-24 | MIT | V4-Pro: 1.6T tot/49B attivi MoE; V4-Flash: 284B tot/13B attivi MoE. 1M context, fino 384K output, doppia modalità thinking/non-thinking | `[TRIANGOLATO — api-docs.deepseek.com/news/news260424, morphllm.com, codersera.com]` |
| **Qwen (Alibaba)** | Split di famiglia: **Qwen3.5 + Qwen3.6** open-weight (Apache 2.0) vs **Qwen3.7 Max** e **Qwen3.8** closed-weight | Qwen3.5: 2026-02-16; Qwen3.6: apr 2026 (Qwen3.6-Max-Preview = primo flagship Alibaba a pesi chiusi); Qwen3.7 Max: 2026-05-20 (closed, DashScope-only, $2.50/$7.50 per Mtok, no open-weight release annunciato); Qwen3.8: annunciato 2026-07-19, 2.4T parametri, pesi aperti "presto" ma non ancora rilasciati | Apache 2.0 per 3.5/3.6; **closed** per 3.7 Max e 3.8 (al momento dell'annuncio) | Qwen3.5 va da 0.8B a 397B-A17B (vedi §2.1 tabella BFCL) | `[TRIANGOLATO — codersera.com, mysummit.school, presenc.ai]` |
| **GLM (Zhipu/Z.ai)** | GLM-5.2 | 2026-06-17 | MIT, nessun limite regionale | 753B tot / ~40B attivi MoE, 1M context. GLM-5.5 (annunciato, target agosto 2026, specifiche non confermate ufficialmente — >1T parametri secondo leak comunitari) | `[TRIANGOLATO — labellerr.com, datanorth.ai, trendingtopics.eu]` |
| **Kimi (Moonshot AI)** | Kimi K3 | 2026-07-16 | Modified MIT | 2.8T totali, MoE, attiva 16 di 896 "esperti" per token, 1M context, visione nativa. Kimi K2.6 resta il modello scaricabile "più forte" secondo Moonshot per self-hosting | `[TRIANGOLATO — explainx.ai, amplifilabs.com, theairankings.com]` |
| **Llama (Meta)** | Llama 5 | 2026-04-08 | Open-weight (licenza Llama, non Apache/MIT — non verificato il testo esatto in questa sessione) | 600B parametri, 5M token context (il più ampio tra i modelli pubblici alla data) | `[TRIANGOLATO — ragyfied.com, shiporskip.io]`. Nota: claim "recursive self-improvement" nel titolo di una fonte (ragyfied.com) NON verificato/corroborato altrove — trattare come marketing, non fatto tecnico `[NON VERIFICATO]` |
| **Meta Muse (Muse Spark)** | Rilasciato in parallelo a Llama 5, stesso giorno | 2026-04-08 | **Closed weight** — primo modello Meta a pesi chiusi dall'era Llama | Motore dell'assistente Meta AI nell'ecosistema app; API privata in preview selettiva | `[TRIANGOLATO — venturebeat.com, startuphub.ai, blog.pebblous.ai]` |
| **Mistral** | Mistral Large 3 (flagship) + famiglia Mistral 3 (14B/8B/3B dense) | Large 3: 2025-12-02 | Apache 2.0 (tutti, incl. base+instruct) | Large 3: 675B sparse MoE, 256K context | `[TRIANGOLATO — dev.to, medium.com, mistral.ai/news/mistral-3]`. Nuovo modello open-weight annunciato in early access da luglio 2026 con partner ricerca/governo/industria — specifiche non confermate | `[FONTE SINGOLA — techtimes.com]` |
| **GPT-OSS (OpenAI)** | gpt-oss-120b / gpt-oss-20b | 2025-08-05 (non aggiornato pubblicamente dopo, alla data di rilevazione) | Apache 2.0 | 120b: 117B tot/5.1B attivi MoE, gira su singola GPU 80GB; 20b: 20.9B tot/3.6B attivi MoE, gira su 16GB memoria | `[VERIFICATO — openai.com/index/introducing-gpt-oss, fireworks.ai]` |

### 1.6 Small locali (classe 4-30B rilevanti)

| Modello | Data | Licenza | Dettagli | Fonte |
|---|---|---|---|---|
| **Gemma 4** (famiglia) | 2026-04-02 | **Apache 2.0** (prima volta per la linea Gemma) | 5 varianti: E2B/E4B (2-4B effettivi, mobile), 12B unificato multimodale, **26B MoE/3.8B attivi** (quella già in uso in Muffin, ADR-060), 31B denso. Context 256K sui modelli maggiori. Giu-lug 2026: aggiunto 12B Unified + drafter MTP (fino a 3x inferenza più veloce), supporto MTP in llama.cpp/Ollama | `[TRIANGOLATO — codersera.com, labellerr.com, layer3labs.io]` |
| **GPT-OSS-20b** | 2025-08-05 | Apache 2.0 | Vedi §1.5. Gira su 16GB — è l'unico modello di questa classe con credenziali agentic/tool-calling pubbliche che entra nell'hardware dev reale citato nel report 2026-07-06 (Mac 16GB) | `[VERIFICATO]` |
| **Ministral 3** | non determinata con precisione in questa sessione | Apache 2.0 (claim vendor) | Edge-tier 3B/8B/14B, claim vendor di forte qualità italiana/europea — **in tensione con il dato interno Muffin** (mistral-small-3.2, tier diverso, giudicato "listy/robotic" in italiano nel report 2026-07-06) | `[NON VERIFICATO alla pari — vendor claim vs dato interno Muffin su tier diverso]` |
| **Qwen3.5 small tier** | 2026-02-16 | Apache 2.0 | 0.8B/2B/4B/9B/27B (vedi tabella BFCL §2.1) | `[VERIFICATO — llm-stats.com/benchmarks/bfcl-v4]` |
| **Phi-4** (Microsoft) | non ri-verificata la data esatta in questa sessione | Non verificata in questa sessione | Variante "Phi-4-reasoning-vision" citata come candidato per multimodale locale | `[FONTE SINGOLA — turingpost.com, non approfondita]` |


---

## 2. Capacità reali open-weight vs frontier (MANDATO 2)

### 2.1 Tool calling — Berkeley Function Calling Leaderboard (BFCL)

**Attenzione preliminare**: la pagina ufficiale Gorilla (`gorilla.cs.berkeley.edu/leaderboard.html`) è renderizzata via JS — il fetch testuale ha restituito solo "Last Updated: 2026-04-12" e nessuna tabella dati. Tutte le tabelle sotto sono di seconda mano (aggregatori) e **sono internamente incoerenti tra loro** — riporto tutte le versioni trovate, esplicitamente, senza sceglierne una come "quella vera".

**Tabella A — BFCL-v4, da llm-stats.com/benchmarks/bfcl-v4 (fetch diretto, pagina dichiara "Data ultimo aggiornamento: Agosto 4, 2026"):**

| Rank | Modello | Punteggio |
|---|---|---|
| 1 | Qwen3.7 Max | 75.0% |
| 2 | Qwen3.7-Plus | 72.9% |
| 2 | Qwen3.5-397B-A17B | 72.9% |
| 4 | Qwen3.5-122B-A10B | 72.2% |
| 5 | Qwen3.5-27B | 68.5% |
| 6 | Qwen3.5-35B-A3B | 67.3% |
| 7 | Qwen3.5-9B | 66.1% |
| 8 | Nova 2 Pro (Amazon) | 61.6% |
| 9 | Nova 2 Lite (Amazon) | 60.3% |
| 10 | Nova 2 Omni (Amazon) | 58.3% |
| 11 | Qwen3.5-4B | 50.3% |
| 12 | Qwen3.5-2B | 43.6% |
| 13 | Qwen3.5-0.8B | 25.3% |

`[FONTE SINGOLA — llm-stats.com]`. Nota: questa tabella **non contiene NESSUN modello Claude, GPT o Gemini** — o la pagina traccia solo un sottoinsieme di vendor/famiglie, o è filtrata di default su "open-weight". Non risolto in questa sessione.

**Tabella B — BFCL-v4, citata da klavis.ai/awesomeagents.ai (aggregatori che riferiscono dati Gorilla non fetchati direttamente):**

| Modello | Punteggio |
|---|---|
| Claude-Opus-4-5-20251101 (FC) | 77.47% |
| Claude-Sonnet-4-5-20250929 (FC) | 73.24% |

`[FONTE SINGOLA, non incrociata con la pagina Gorilla direttamente]`

**Tabella C — BFCL-v3 (versione precedente, congelata), datata "29 giugno 2026" da un aggregatore:**

| Modello | Punteggio |
|---|---|
| GLM-4.5 | 76.7% |
| Claude Opus 4.7 | 76.6% |
| Gemini 3.1 Flash-Lite Preview | 76.5% |
| GPT-5 | 59.22% (7° posto, fonte più vecchia) |

`[FONTE SINGOLA — klavis.ai, cita a sua volta fonti/date miste]`

**`[DISCREPANZA]` esplicita**: tabella A (Qwen-leader, nessun frontier closed presente) vs tabelle B/C (Claude/GLM/Gemini in testa a percentuali comparabili ~73-77%, GPT-5 molto più indietro al 59% in una lettura più datata). Non è risolvibile con gli strumenti disponibili in questa sessione — plausibilmente le tabelle misurano sottoinsiemi diversi di modelli o versioni diverse della metodologia BFCL (v3 vs v4, categorie diverse "single-turn" vs "overall", o filtri per licenza). **Lettura prudente**: sia Qwen3.7 Max (closed, $2.50/$7.50) sia i modelli Claude di fascia Opus, sia GLM-4.5/5.2 competono nella fascia 73-77% su BFCL a seconda della versione/fonte — nessuna famiglia mostra un margine schiacciante sulle altre in questo specifico benchmark, ma il dato non è pulito.

### 2.2 Agentic coding — SWE-bench Verified

Fonte: llm-stats.com/benchmarks/swe-bench-verified, fetch diretto, pagina dichiara "Data ultimo aggiornamento: Agosto 4, 2026", tabella completa dichiarata di 104 modelli (troncata a 12 nel fetch). `[FONTE SINGOLA per la tabella completa, ma i due punti chiave — DeepSeek-V4-Pro 80.6% e la posizione di Fable 5 — sono TRIANGOLATI con una WebSearch separata]`

| Rank | Modello | Score | Tipo |
|---|---|---|---|
| 1 | Claude Fable 5 | 95.0% | API (closed) |
| 2 | Claude Mythos Preview | 93.9% | API (closed, accesso limitato) |
| 3 | Claude Opus 4.8 | 88.6% | API (closed) |
| 4 | Claude Opus 4.7 | 87.6% | API (closed) |
| 5 | Claude Sonnet 5 | 85.2% | API (closed) |
| 6 | Claude Opus 4.5 | 80.9% | API (closed) |
| 7 | Claude Opus 4.6 | 80.8% | API (closed) |
| 8 | **DeepSeek-V4-Pro-Max** | **80.6%** | **Open-weight (MIT)** |
| 8 | Gemini 3.1 Pro | 80.6% | API (closed) |
| 10 | MiniMax M3 | 80.5% | API (closed) |
| 11 | Qwen3.7 Max | 80.4% | API (closed) |
| 12 | Kimi K2.6 | 80.2% | **Open-weight** |
| 12 | MiniMax M2.5 | 80.2% | **Open-weight** |

Punto verificato separatamente (2 query WebSearch indipendenti, concordi): **DeepSeek V4-Pro all'80.6% è il miglior risultato open-weight su SWE-bench Verified alla data, alla pari con Gemini 3.1 Pro** (closed) e a soli ~14.4 punti dal leader assoluto Claude Fable 5 (95.0%). V4-Flash segue a 79.0%. `[TRIANGOLATO — morphllm.com + medium.com, indipendenti]`

Nota di contesto dalla stessa ricerca: il benchmark è descritto come "in via di saturazione" da una fonte (morphllm.com) — top model raggruppati 88-96%, e la comunità starebbe spostando l'attenzione su SWE-bench Pro (score 55-70%) come benchmark meno saturo. `[FONTE SINGOLA, non verificata direttamente sul sito swebench Pro]`

### 2.3 Policy adherence / agentic multi-turn — tau-bench e tau2-bench (Sierra Research)

- **tau-bench (originale, congelato)**: il punteggio pass^1 più alto storicamente registrato è Claude 3.5 Sonnet (2024-10-22) al 69.2% retail / 46.0% airline; GPT-4o al 60.4%/42.0%. Questa board non riceve più nuovi modelli — sostituita da tau2-bench. `[FONTE SINGOLA — benchmarkingagents.com]`
- **tau2-bench (corrente, 2026)**: **GLM-5 in testa al 89.7%** sui domini testuali correnti (banking_knowledge, retail, airline, telecom). v1.0.1 (luglio 2026) ha aggiornato la grading del dominio banking_knowledge — punteggi pre/post 1.0.1 non comparabili. `[FONTE SINGOLA — pricepertoken.com, non incrociata su GLM-5 specificamente]`
- Dal report scout precedente (2026-07-06, citato non ri-derivato): GLM-4.7-Flash 79.5% τ2-bench (verificato lì cross-fonte), Gemma-4-31b 86.4% τ2-bench (salto enorme da Gemma-3-27B's 6.6%), Step-3.5-Flash 88.2% e "Claude Mythos 5" 89.2% come leader proprietari — **nota**: quella cifra "Claude Mythos 5" nel report di luglio precede il lancio pubblico di Fable/Mythos (9 giugno 2026: compatibile temporalmente, ma non ri-verificata in questa sessione) `[EREDITATO da report precedente, non ri-verificato qui]`.
- Sierra (autori del benchmark) sottolinea esplicitamente che tau/tau2-bench misura **aderenza alla policy**, non solo completamento task: "un agente che prenota il volo giusto ma viola la fee policy dichiarata fallisce" — metrica più vicina alla domanda "il modello rispetta i vincoli HITL/gate" che alla semplice "sa chiamare un tool". `[VERIFICATO — dichiarazione diretta di Sierra citata dall'aggregatore]`

### 2.4 Long context: claimed vs misurato

**RULER**: benchmark con 13 task su lunghezze fino a 128K. Limite metodologico documentato dalla letteratura stessa: uno studio critico segnala che "RULER e ∞Bench non riflettono in modo affidabile le prestazioni long-context — la copertura di dominio è stretta e le metriche sono rumorose", con anomalie osservate (es. Gemini-1.5-Pro e Llama-3.1-70B che performano peggio di Llama-3.1-8B in certe letture). Un'altra fonte, su un insieme di modelli precedente (2024-2025), trova che nessun modello testato manteneva prestazioni sopra la baseline Llama2-7B alla lunghezza di context dichiarata, salvo Mixtral che raggiungeva prestazioni moderate a 2x la lunghezza dichiarata (32K). `[TRIANGOLATO su critica metodologica; il dato Mixtral è più vecchio/non aggiornato al 2026]`

**fiction.liveBench / MRCR v2 (8-needle)** — dati 2026 reperiti via ricerca (non fetch diretto della tabella dati, che non è stata esposta dal sito):
- Claude Opus 4.6: 76% su MRCR v2 8-needle a 1M token.
- GPT-5.4: 36.6%; Gemini 3 Pro: 24.5% sulla stessa metrica (lunghezza esatta del test non specificata nella fonte).
- Su fiction.liveBench, Grok 4 e Gemini sono descritti come gli unici due modelli sopra la soglia "standout" oltre i 192k token.
`[FONTE SINGOLA per i numeri esatti, tabella dati non fetchata direttamente — treat as indicativo]`

**Lettura complessiva (fatti, non giudizio)**: il gap tra "context window dichiarata" (1M+ per molti modelli 2026: Claude 4.6+, Gemini 3.x, DeepSeek V4, Kimi K3) e "context effettivamente utilizzabile con recall affidabile" resta ampio e disomogeneo tra modelli secondo le fonti raccolte — un modello può dichiarare 1M di context e scendere sotto il 40% di recall corretto su task di recupero profondo alla stessa lunghezza (GPT-5.4/Gemini 3 Pro sul dato MRCR v2 sopra), mentre un altro (Claude Opus 4.6) mantiene 76% sullo stesso test. Nessuna fonte trovata quantifica questo gap per i modelli open-weight più recenti (DeepSeek V4, Kimi K3, GLM-5.2, Qwen3.7) nonostante dichiarino tutti 1M di context — **gap esplicito, non coperto in questa sessione** `[NON VERIFICATO per la classe open-weight]`.


---

## 3. Inferenza locale su hardware consumer (MANDATO 3)

**Nota di contesto macro, rilevante per tutta questa sezione**: nel 2026 è in corso una carenza globale di DRAM/HBM guidata dalla domanda AI datacenter — prezzi RAM saliti fino all'89% nel 2026, ~90% di aumento DRAM nel Q1 2026 vs Q4 2025, previsioni di ulteriore +70% da TrendForce; datacenter AI stimati assorbire il 70% della produzione DRAM high-end nel 2026; Samsung/SK Hynix/Micron (>95% della produzione globale) spostano wafer da memoria consumer a HBM. Intel indica che la carenza non si allenterà prima del 2028. **Conseguenza diretta**: tutti i prezzi hardware sotto sono gonfiati rispetto ai listini storici 2024-2025 e Apple ha eliminato diverse configurazioni ad alta memoria durante il 2026. `[TRIANGOLATO — shattered.io, windowscentral.com, tomshardware.com, tech-insider.org]`

### 3.1 Tokens/secondo per classe hardware

| Hardware | Classe modello | Tok/s | Fonte |
|---|---|---|---|
| Mac Studio M5 Max | 70B Q4 | 25-32 tok/s | `[FONTE SINGOLA — presenc.ai, llmcheck.net, non incrociata su cifra esatta]` |
| Mac M4 Max (128GB unificata) | Llama 3.3 70B Q4_K_M | 20-28 tok/s | `[TRIANGOLATO — llmcheck.net, currentaffair.today]` |
| MacBook Air M4 (16GB) | 7B-13B | 25-40 tok/s (llama.cpp Metal) | `[FONTE SINGOLA — sitepoint.com]` |
| Mac con 8GB | 7B Q4 | limite massimo di classe caricabile | `[FONTE SINGOLA]` |
| Mac con 32GB (M4 Pro) | 35B MoE (classe Qwen3.5/3.6-35B-A3B) | 45→75+ tok/s (con MLX ottimizzato) | `[FONTE SINGOLA — runaihome.com]` |
| RTX 4090 (24GB) | Llama 3.3 70B Q4, batch=1 | ~36 tok/s | `[TRIANGOLATO — spheron.network, 9bench.com]` |
| RTX 5090 (32GB) | Llama 3.3 70B Q4, batch=1 | ~50-55 tok/s | `[TRIANGOLATO — stesse fonti]` |
| RTX 5090 (32GB) | 30B Q4 denso | 40-55 tok/s | `[FONTE SINGOLA]` |
| RTX 5090 (32GB) | 35B MoE / 3B attivi (classe Qwen3.6-35B-A3B) | **~234 tok/s** | `[FONTE SINGOLA — hardware-corner.net / bhavishyapandit9.substack.com]` |
| AMD Ryzen AI Max+ 395 "Strix Halo" (128GB unificata, ~210-220GB/s banda reale) | 7B-30B denso | 40-70 tok/s | `[TRIANGOLATO — runaihome.com, localaimaster.com]` |
| Strix Halo | Qwen3-30B (MoE) | ~100 tok/s | `[FONTE SINGOLA — runaihome.com]` |
| Strix Halo | 70B denso | ~4-6 tok/s (bandwidth-bound) | `[TRIANGOLATO]` |
| Strix Halo | 120B MoE | 31-55 tok/s | `[FONTE SINGOLA]` |

Nota metodologica: quasi tutte queste cifre vengono da blog/aggregatori specializzati in benchmark hardware 2026 (non da un singolo laboratorio indipendente terzo con metodologia pubblicata uniforme) — trattarle come **ordini di grandezza plausibili**, non cifre di laboratorio certificate. La differenza MoE vs denso è il fattore singolo più determinante: un modello da 35B con 3B attivi per token gira a velocità paragonabile a un 3-4B denso, non a un 35B denso — questo è il motivo per cui la classe "30B-A3B" (Qwen3.5/3.6-35B-A3B, GLM-4.7-Flash, la futura eventuale Gemma MoE) è quella più menzionata come "punto dolce" per hardware consumer.

### 3.2 Effetto della quantizzazione sulla qualità (evidenza misurata)

- **Q8_0**: perdita di perplexity <0.5% vs FP16, "effettivamente lossless" — circa 0.1-0.3% di incremento perplexity, dentro il rumore di misura per la maggior parte degli usi. `[TRIANGOLATO — multiple fonti aggregatore concordi sull'ordine di grandezza]`
- **Q4_0** (quantizzazione naive): incremento perplexity 5-10% vs FP16.
- **Q4_K_M** (quantizzazione moderna con scaling per blocco + allocazione bit pesata per importanza): incremento perplexity tipicamente 1.5-3% — molto meglio di Q4_0.
- Delta perplexity tra Q4_K_M e Q8_0: ~0.0531 punti — sotto la soglia percepibile in conversazione normale secondo la fonte.
- **Caveat misurato importante**: i benchmark di ragionamento degradano più velocemente della perplexity — il calo di accuratezza matematica a Q3 è **circa 3 volte più grande** del calo di perplexity alla stessa quantizzazione. Questo implica che la perplexity da sola **sottostima** il danno della quantizzazione su task di ragionamento/agentic rispetto alla chat generica.
`[TRIANGOLATO su più fonti aggregatore per gli ordini di grandezza; nessun paper accademico primario isolato e fetchato direttamente in questa sessione per questi numeri specifici — trattare come indicativo]`

### 3.3 Elettricità — stima €/mese in EU

Fonte: **Eurostat**, dato ufficiale H2-2025 (il più recente disponibile), via `ec.europa.eu/eurostat`. `[VERIFICATO — Eurostat]`

- Media UE: **€28.96 per 100 kWh ≈ €0.29/kWh** (H2-2025). Le tasse/imposte sono salite da €0.0804/kWh (H1-2025) a €0.0837/kWh (H2-2025), dal 27.9% al 28.9% della bolletta finale.
- Range tra stati membri: **più caro** Irlanda €0.4042/kWh, Germania €0.3869/kWh, Belgio €0.3499/kWh; **più economico** Ungheria €0.1082/kWh, Malta €0.1282/kWh, Bulgaria €0.1355/kWh.
- Contesto: prezzi ancora ben sopra i livelli pre-crisi energetica 2022, nonostante relativa stabilità recente.

Implicazione per un box locale always-on: una GPU consumer (RTX 4090/5090) sotto carico continuo tipicamente assorbe 300-450W; un Mac Studio/mini-PC AI Strix Halo assorbe tipicamente 60-140W sotto carico (ordini di grandezza da specifiche vendor, non misurati in questa sessione — **`[NON VERIFICATO]`** il consumo reale sotto carico LLM specifico per ciascun hardware; solo il prezzo €/kWh sopra è verificato su fonte ufficiale).

### 3.4 Costo hardware di ingresso per classe (prezzi Aug 2026, sotto shortage DRAM)

| Hardware | Prezzo (Aug 2026) | MSRP storico | Fonte |
|---|---|---|---|
| RTX 4090 (24GB) | ~$2755 street (nuovo) / ~$2200 usato | $1599 (lancio) | `[TRIANGOLATO]` |
| RTX 5090 (32GB) | $4300-5000 street | $1999 (lancio) | `[TRIANGOLATO]` |
| Mac mini M4 base | $799 (16GB) | — | `[FONTE SINGOLA]` |
| Mac mini M4 Pro | ora limitato a 24GB o 48GB (opzione 64GB **discontinuata** durante lo shortage) | — | `[FONTE SINGOLA — appleinsider.com]` |
| Mac Studio M4 Max | da $2499 (128GB non più listata per questa configurazione secondo la fonte) | — | `[FONTE SINGOLA]` |
| Mac Studio M3 Ultra | da $5299 (+$1300 dopo rincaro giugno 2026), **capped a 96GB** (opzioni 256GB/512GB rimosse) | — | `[TRIANGOLATO — macrumors.com, insiderllm.com]` |
| Ryzen AI Max+ 395 "Strix Halo", 128GB (GMKtec EVO-X2) | ~$1800-2000 (street, creeping verso/oltre MSRP $1999-2199 per lo shortage) | $1999-2199 | `[TRIANGOLATO]` |
| Framework Desktop, Ryzen AI Max+ 395, 64GB | da $1639 (barebone, senza storage/OS) | — | `[FONTE SINGOLA]` |

Lettura: alla data di rilevazione, un box da 128GB unificata "punto dolce" per la classe 30B-A3B MoE costa nell'ordine di **$1800-2000** (mini-PC AMD) — significativamente meno di un Mac Studio equivalente per capacità di memoria, ma con banda memoria reale molto più bassa (~210-220GB/s vs 819GB/s di un Mac Studio M3 Ultra), quindi throughput nettamente inferiore su modelli densi grandi (70B: Strix Halo 4-6 tok/s vs Mac Studio M3 Ultra 15-18 tok/s). Una GPU RTX 5090 da sola (senza il resto del sistema) costa oggi quanto un intero mini-PC AI da 128GB.


---

## 4. Abbonamenti consumer usati via harness CLI (MANDATO 4)

### 4.1 Anthropic — Claude Pro / Max

**Prezzi** — fonte: `claude.com/pricing`, fetch diretto 2026-08-04. `[VERIFICATO]`

| Piano | Prezzo | Note |
|---|---|---|
| Free | $0 | — |
| Pro | $17/mese (fatturazione annuale, $200 upfront) o $20/mese (fatturazione mensile) | Claude Code incluso, Cowork, Design, Science, più modelli, progetti illimitati, Research, Claude per Microsoft 365 |
| Max | "From $100/mese" — due varianti **5x** e **20x** i crediti di utilizzo di Pro | Tutto Pro + output limits più alti, accesso anticipato a feature, priorità nei picchi di traffico |
| Team Standard | $20/mese/posto (fatturazione annuale) | |
| Team Premium | $100/mese/posto | |
| Enterprise | "$20/seat, il costo di utilizzo scala con modello e task" | |

Contesto modelli disponibili sulla pagina: Fable, Opus, Sonnet, Haiku, Mythos — tutti a 200k di context window sui piani consumer mostrati (nota: questo è il context "esposto" nell'app, non necessariamente il limite tecnico del modello via API, che per Claude 4.6+ è 1M — vedi §1.1).

**Limiti d'uso (Pro/Max)** — nessuna fonte ufficiale Anthropic con i numeri esatti è stata fetchata direttamente in questa sessione (l'help-center specifico non è stato raggiunto); i numeri sotto sono **triangolati su più aggregatori indipendenti concordi** (apidog.com, pasqualepillitteri.it, morphllm.com, truefoundry.com, verdent.ai, explainx.ai, tokenmix.ai) che citano tutti gli stessi annunci Anthropic del 2026-05-06/05-13/07-13/07-18:
- 6 maggio 2026: le finestre di 5 ore di Claude Code **raddoppiate** per Pro/Max/Team/Enterprise a seat; rimossa la riduzione di limite nelle ore di punta.
- 13 maggio 2026: **+50% ai limiti settimanali** per Pro/Max/Team/Enterprise a seat, con scadenza dichiarata 13 luglio 2026 "salvo estensione".
- 13 luglio 2026: promo **estesa al 19 luglio 2026**.
- 18 luglio 2026 (annuncio @ClaudeDevs): limiti settimanali **+50% estesi fino al 19 agosto 2026** per Pro/Max/Team/Enterprise a seat — **quindi attivi alla data di rilevazione di questo report (2026-08-04)**, con scadenza dichiarata tra ~2 settimane.
- Cifre citate (post-raddoppio maggio 2026): Claude Pro ($20/mese) — 5h cap raddoppiato (~45→~90 prompt/finestra indicativo); Max 5x ($100/mese) — budget settimanale Opus 4.7 da ~50h a ~75h; Max 20x ($200/mese) — da ~200h a ~300h.
`[TRIANGOLATO ma NON su fonte primaria Anthropic direttamente fetchata — trattare i numeri assoluti (90 prompt, 75h, 300h) come indicativi]`

**ToS — citazioni ESATTE (verbatim)**, fetch diretto `anthropic.com/legal/consumer-terms`, 2026-08-04. `[VERIFICATO]`

> "Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise." (Sezione 3, punto 7)

> "You agree that you will not use our Services for any commercial or business purposes" (Sezione 11, "Non-commercial use only")

> "To develop any products or services that compete with our Services, including to develop or train any artificial intelligence or machine learning algorithms or models or resell the Services." (Sezione 3, punto 2)

> "Please note: Our Commercial Terms of Service govern your use of any Anthropic API key, the Anthropic Console, or any other Anthropic offerings that reference the Commercial Terms of Service. For clarity, this does not include Claude.ai or Claude Pro use for individuals or entities." (nota di ambito iniziale)

**Usage Policy** (effective **15 settembre 2025**), fetch diretto `anthropic.com/aup`, 2026-08-04. `[VERIFICATO]`

> "Intentionally bypass capabilities, restrictions, or guardrails established within our products for the purposes of instructing the model to produce harmful outputs (e.g., jailbreaking or prompt injection) without prior authorization from Anthropic"

> "Utilize automation in account creation or to engage in spammy behavior" / "Coordinate malicious activity across multiple accounts to avoid detection"

La policy è strutturata in 3 categorie (Universal Usage Standards, High-Risk Use Case Requirements, Additional Use Case Guidelines — quest'ultima include esplicitamente "agentic use" e "Model Context Protocol servers" come casi trattati). Il testo completo della guida specifica per uso agentico non è nel documento AUP stesso ma rimandato a un Help Center article non fetchato direttamente in questa sessione.

**Enforcement documentato:**
- **Transparency Hub Anthropic** (H2 2025): **1.45 milioni di account bannati** (Claude.ai + API + Claude Code combinati); 52.000 appelli presentati, 1.700 accolti (**3.3% di successo appelli**, 0.12% di tutti i ban ripristinati). Causa dichiarata dalla maggioranza delle detection: violazioni Usage Policy, spam, contenuto proibito. Una fonte separata (TradingView/Cointelegraph) riporta che "circa il 67% degli account bannati usava l'AI per preparare cyberattacchi" — quindi la maggioranza numerica dei ban sembra centrata su abuso per sicurezza/contenuto, non necessariamente su "uso di harness di terze parti con l'abbonamento". `[TRIANGOLATO multiple fonti sullo stesso PDF Transparency Hub]`
- **Febbraio 2026**: The Register riporta un chiarimento Anthropic sul divieto di accesso di terze parti a Claude — citazione riportata da un aggregatore (non fonte primaria Anthropic fetchata): *"using OAuth tokens obtained through Claude Free, Pro, or Max accounts in any other product, tool, or service — including the Agent SDK — is not permitted and constitutes a violation of the Consumer Terms of Service."* Il fetch diretto dell'articolo The Register ha restituito 404 in questa sessione. `[FONTE SINGOLA aggregatore, citazione non verificata sulla fonte primaria]`
- **Gennaio 2026**: ondata di sospensioni account segnalata da sviluppatori senza preavviso — thread Reddit r/Anthropic con titoli tipo "Claude Max Subscription Silently Revoked", "Account Permanently Banned, $300 Charged, No Explanations"; causa indicata: controlli server-side anti-frode contro strumenti di coding di terze parti non ufficiali che accedevano a Claude via canali non ufficiali. `[TRIANGOLATO — Forbes 2026-04-11 + aggregatori, non fonte Anthropic diretta]`
- **Aprile 2026**: riferimento a un'ulteriore stretta specifica contro "agenti AI di terze parti" che usano abbonamenti Claude — fonte (marketingagent.blog) **non raggiungibile in questa sessione** (dominio non risolvibile via WebFetch). `[NON VERIFICATO DIRETTAMENTE — riportato solo dal titolo/snippet di ricerca]`
- Riassunto pratico coerente su più fonti: **Claude Code via abbonamento consumer richiede login OAuth basato su browser** — non esiste un percorso headless pulito per un abbonamento su un server; estrarre/trasferire i token OAuth fuori dalla CLI ufficiale per farli girare headless su una VPS è esplicitamente vietato dai ToS. Il percorso "legittimo" per automazione è la Commercial Terms of Service con API key a consumo.

### 4.2 OpenAI — ChatGPT Plus/Pro + Codex

**Prezzi** — fetch diretto `chatgpt.com/pricing` e `openai.com/chatgpt/pricing` entrambi restituiscono 403 in questa sessione. Dati sotto **triangolati su più aggregatori indipendenti** (metacto.com, morphllm.com, automationatlas.io, simplemetrics.xyz, theaicareerlab.com), tutti concordi sulle cifre: `[TRIANGOLATO, NON verificato su fonte ufficiale diretta in questa sessione]`

| Piano | Prezzo | Note |
|---|---|---|
| Free | $0 | |
| Go | $8/mese | tier introdotto probabilmente nel 2026 (non presente nelle liste 2025) |
| Plus | $20/mese | |
| Pro | $100/mese (5x) o $200/mese (20x) | |
| Business | $25/utente/mese (o $20/anno) | |

**Codex**: non è un piano standalone — incluso in Free/Go/Plus/Pro/Business/Enterprise. Limiti a doppia finestra: rolling 5 ore + cap settimanale che si somma. Per Plus, limiti indicativi per 5 ore: 15-90 messaggi (Sol), 20-110 (Terra), 50-280 (Luna); Pro 5x/20x moltiplica la finestra per 5 o 20. `[FONTE SINGOLA — simplemetrics.xyz]`

**ToS su automazione/API**:
- ChatGPT Plus/Pro **non includono** accesso o crediti API — sono sistemi di fatturazione separati da OpenAI stessa. `[TRIANGOLATO]`
- Condivisione di API key esplicitamente vietata dai ToS; una key compromessa dà accesso di fatturazione completo. `[FONTE SINGOLA]`
- Usage Policies OpenAI (`openai.com/policies/usage-policies/`, fetch diretto fallito 403 in questa sessione — dati da ricerca): vietano "automatically or programmatically extracting data or Output", vietano "circumventing rate limits or restrictions or bypassing protective measures or safety mitigations", vietano l'uso per costruire sistemi AI concorrenti. `[FONTE SINGOLA su citazione esatta, non fonte primaria fetchata direttamente]`
- Non ho trovato, in questa sessione, un case study di enforcement/ban nominato equivalente ai casi Anthropic sopra per l'uso di ChatGPT Plus/Pro via harness non ufficiali — **gap esplicito**. `[NON VERIFICATO — assenza di dato, non conferma di assenza del fenomeno]`

### 4.3 Google — piani consumer (AI Pro/Ultra) + gemini-cli

**Prezzi** — fetch diretto `gemini.google.com/subscriptions` → 404 in questa sessione. Dati **triangolati su più fonti indipendenti concordi** (ai-toolbox.co, felloai.com, gamsgo.com, pricepertoken.com). `[TRIANGOLATO, NON verificato su fonte ufficiale diretta in questa sessione]`

| Piano | Prezzo | Note |
|---|---|---|
| Free | $0 | |
| AI Pro | $19.99/mese | Gemini 3.1 Pro incluso, Deep Research, Veo, 1.000 crediti AI |
| AI Ultra (tier base) | $99.99/mese | 5x i limiti di Pro |
| AI Ultra (tier top) | $199.99/mese | 20x i limiti di Pro, Deep Think, 35.000 crediti AI |

Contesto storico: il piano Ultra era stato lanciato a **$249.99/mese** (TechCrunch, maggio 2025); a I/O 2026 Google lo ha ristrutturato in due sotto-tier più economici ($99.99/$199.99). `[TRIANGOLATO — techcrunch.com 2025 + engadget.com 2026]`

**Gemini CLI**: nessuna riga di pricing separata — eredita i limiti del piano sottoscritto ("highest limits in Gemini Code Assist and CLI" citato per il tier Ultra).

**ToS/enforcement**:
- Dal **25 marzo 2026**: cambio di routing del traffico che privilegia "standing" account migliore; il tier Pro **gratuito** perde l'accesso ai modelli Gemini Pro (limitato a Flash); accesso Pro completo richiede abbonamento a pagamento. `[FONTE SINGOLA — GitHub Discussion ufficiale google-gemini/gemini-cli #22970, fetch parziale]`
- La stessa discussion GitHub ufficiale menziona "rilevamento robusto per casi d'uso che violano le policy, come l'uso di Gemini CLI OAuth con software di terze parti" — ma **l'annuncio resta esplicitamente vago** su cosa costituisca "uso improprio" con software esterno (non specifica se cronjob, bot Telegram, o integrazioni ACP/A2A siano consentiti), generando incertezza dichiarata nella community stessa. `[VERIFICATO che l'ambiguità è dichiarata nella discussion ufficiale; NON VERIFICATO quale sia la policy esatta]`
- Processo di enforcement descritto da una fonte secondaria (support.google.com): prima violazione → email di notifica + richiesta di "ri-certificare" l'intento d'uso, ripristino automatico tipicamente in 1-2 giorni; seconda violazione → **ban permanente**. `[FONTE SINGOLA]`
- Citazione trovata su un thread di settore: "se usi Gemini CLI come tool di invocazione di terze parti, rischi il ban; se usi automazione via API, non rischi il ban" — riflette la stessa distinzione consumer-subscription-vietata / api-key-a-consumo-permessa vista per Anthropic e OpenAI. `[FONTE SINGOLA, parafrasi non verbatim di un thread comunitario]`


---

## 5. Prompt caching e batch (MANDATO 5)

### 5.1 Anthropic — meccanica verificata su fonte ufficiale

Fonte: `platform.claude.com/docs/en/about-claude/pricing`, fetch diretto 2026-08-04. `[VERIFICATO]`

| Operazione cache | Moltiplicatore su input base | Durata |
|---|---|---|
| Scrittura 5 minuti | 1.25x | valida 5 minuti |
| Scrittura 1 ora | 2x | valida 1 ora |
| Lettura (hit) | 0.1x (= sconto 90%) | stessa durata della scrittura precedente |

"Cache write tokens are charged when content is first stored. Cache read tokens are charged when a subsequent request retrieves the cached content. A cache hit costs 10% of the standard input price, which means caching pays off after just one cache read for the 5-minute duration (1.25x write), or after two cache reads for the 1-hour duration (2x write)." — **si ripaga da 1 lettura (cache 5m) o 2 letture (cache 1h)**.

Due modalità: **automatica** (un solo campo `cache_control` in cima alla richiesta, il sistema gestisce da solo i breakpoint man mano che la conversazione cresce) o **breakpoint espliciti** (controllo granulare per blocco di contenuto).

Batch API: **50% di sconto flat su input E output**, cumulabile con lo sconto caching (i moltiplicatori si sommano/moltiplicano con altri modificatori inclusa la data residency).

Esempio numerico ufficiale (sessione Claude Managed Agents, Opus 5, 1 ora, 50k input + 15k output): **$0.705 senza cache**; con 40k dei 50k input come cache-read: **$0.525** (input non cache 10k×$5/M=$0.05, cache-read 40k×$5×0.1/M=$0.02, output 15k×$25/M=$0.375, runtime sessione 1h×$0.08=$0.08).

### 5.2 OpenAI — cambio di meccanica in corso (luglio 2026)

- Meccanica storica: **caching implicito, automatico, gratuito da scrivere**, sconto 90% in lettura sopra una soglia di 1024 token di prefisso stabile (per alcuni modelli lo sconto citato è 50%, per GPT-5.5 90% — **discrepanza tra fonti aggregatore sulla percentuale esatta a seconda del modello**, non risolta). `[DISCREPANZA]`
- **Cambio architetturale dichiarato al 9 luglio 2026**, con la GA di GPT-5.6: OpenAI sostituisce il caching implicito gratuito con **breakpoint espliciti + premio di scrittura 1.25x + TTL minimo di 30 minuti** — la stessa forma (premio di scrittura + sconto in lettura) già usata da Anthropic, non più "gratis e automatico". `[FONTE SINGOLA — effloow.com, non incrociata su un annuncio ufficiale OpenAI fetchato direttamente in questa sessione]`
- Sulla tabella pricing ufficiale fetchata (§1.2), la colonna "Cached input" mostra uno sconto **~90%** rispetto all'input standard per la maggior parte dei modelli correnti (es. gpt-5.6-sol $5.00→$0.50, gpt-5-nano $0.05→$0.005) — coerente con il 90% dichiarato per GPT-5.5 sopra. `[VERIFICATO dalla tabella ufficiale stessa]`

### 5.3 Google Gemini — due meccanismi paralleli

Parzialmente verificato su tabella ufficiale (`ai.google.dev/gemini-api/docs/pricing`, §1.3): per **Gemini 2.5 Pro**, cache read a $0.125/$0.25 (10% dell'input standard $1.25/$2.50 = **sconto 90%**, identico ad Anthropic) + storage $4.50/M-token/ora. Per i modelli Flash 3.x, stesso rapporto ~10% + storage $1.00/M-token/ora. `[VERIFICATO per queste righe specifiche]`

Meccanismo generale (da ricerca, non tutto sulla tabella ufficiale):
- **Implicito**: automatico, ON di default, nessun costo di storage, sconto se hit (~90% secondo il rapporto verificato sopra per 2.5 Pro/Flash). Richiede che i contenuti stabili siano posizionati **all'inizio** del prompt — contenuto variabile in testa fa perdere il cache-hit.
- **Esplicito**: si dichiara cosa cachare + TTL; **minimo 32.768 token** di contenuto cacheable; costo storage separato (~$1.00/M-token/ora su Flash, ~$4.50/M-token/ora su Pro, verificato per 2.5 Pro/Flash sopra) oltre allo sconto in lettura.
- **`[DISCREPANZA non risolta]`**: una fonte secondaria (verdent.ai) riporta lo sconto esplicito su **Gemini 3 Pro** specificamente al **75%** anziché 90% — la tabella ufficiale fetchata non elenca righe di caching per "Gemini 3.1 Pro Preview" separatamente (solo per 2.5 Pro GA), quindi questo dato non è confermabile/confutabile con le fonti raccolte in questa sessione.
- Esempio numerico da fonte secondaria: un context esplicito da 200K token su Pro costa ~$0.90/ora di storage e fa risparmiare ~$0.36 per ogni cache-hit — si ripaga a partire da 2-3 riusi/ora. `[FONTE SINGOLA]`

### 5.4 Implicazione per un agente con system prompt grande sempre attivo

Fatti raccolti rilevanti per ragionarci (non è una raccomandazione):
- Su **tutti e tre** i provider il caching converge verso la stessa forma: **premio modesto in scrittura (1.25x-2x sull'input base) + forte sconto in lettura (~90% su Anthropic e su Gemini/2.5-Pro verificati; 90% dichiarato anche per GPT-5.5)**. Nessun provider fa pagare la scrittura a un multiplo proibitivo.
- Il break-even per Anthropic è **1 lettura** (cache 5 minuti) o **2 letture** (cache 1 ora) — un agente che riusa lo stesso system prompt/contesto a ogni turno lo supera quasi certamente al secondo turno entro la finestra di validità.
- Per Gemini esplicito, il vincolo strutturale diverso è il **minimo 32.768 token** cacheable e un costo di **storage orario** indipendente dall'uso — sotto una certa frequenza di turni/ora, il costo di tenere la cache aperta può superare il risparmio sui read (l'esempio ufficiale-adiacente sopra indica un pareggio a 2-3 riusi/ora per un context da 200K su Pro).
- Il cambio OpenAI (implicito-gratis → esplicito-con-premio, luglio 2026) è, nella direzione, una convergenza verso il modello Anthropic/Gemini-esplicito — non più un "vantaggio gratuito" per chi non gestisce esplicitamente i breakpoint.


---

## 6. Mattoni per il costo mensile — prezzi atomici + consumo reale pubblicato (MANDATO 6)

Per istruzione esplicita non costruisco qui lo scenario finale per Muffin (serve la telemetria reale, che non ho). Sotto: (a) unit economics illustrative sui prezzi atomici raccolti in §1, (b) datapoint di consumo REALE pubblicati per agenti always-on.

### 6.1 Unit economics illustrative (aritmetica pura sui prezzi §1, NON uno scenario Muffin)

Costo per singola chiamata a due dimensioni di context illustrative (nessuna cache, nessun batch):

| Modello | 10k in / 500 out | 50k in / 500 out |
|---|---|---|
| Claude Sonnet 5 (intro) $2/$10 | $0.025 | $0.105 |
| Claude Haiku 4.5 $1/$5 | $0.0125 | $0.0525 |
| Claude Opus 5 $5/$25 | $0.0625 | $0.2625 |
| Gemini 2.5 Flash-Lite $0.10/$0.40 | $0.0012 | $0.0052 |
| gpt-5.6-luna $0.20/$1.20 | $0.0026 | $0.0106 |
| DeepSeek V4-Flash (cache-miss) $0.14/$0.28 | $0.0015 | $0.0071 |
| DeepSeek V4-Pro (cache-miss) $0.435/$0.87 | $0.0048 | $0.0222 |

(Calcolo: input×prezzo_input/1M + output×prezzo_output/1M. Con caching attivo su un system prompt stabile, il costo dell'input scende dell'ordine del 90% dopo il primo turno per tutti i provider — vedi §5.)

### 6.2 Datapoint reali pubblicati di consumo (agenti always-on)

**OpenClaw (harness open-source always-on multi-canale)** — citazioni raccolte da un aggregatore che riporta quote in stile Reddit (non ho verificato ogni citazione contro un link Reddit diretto — trattare come **`[FONTE SECONDARIA, quote non verificate al link originale]`**, ma internamente coerenti e con dettaglio di setup):

| Setup | Modello | Costo riportato |
|---|---|---|
| Oracle free tier + WhatsApp | DeepSeek V3 | ~$3/mese |
| Raspberry Pi 5 8GB + Telegram | Phi-3 Mini locale | elettricità (pochi centesimi), 8 tok/s |
| Hetzner 4GB/2vCPU | GPT-4o mini | <$10 in 2 mesi |
| Contabo VPS S, 50-100 msg/giorno | Claude Haiku | ~$18/mese ($5.50 hosting + $12 API) |
| VPS + routing DeepSeek/Claude Sonnet | DeepSeek (routing) + Claude Sonnet (task complessi) | sceso da $35/mese a $15/mese dopo aver introdotto il routing; $21/mese totale con Vultr |
| Power user, 200-300 msg/giorno multi-canale | non specificato | $65-75/mese |

Datapoint aggiuntivi da ricerca generale (fonti diverse, aggregatori):
- "Real daily cost for a typical OpenClaw setup is 5-10x the theoretical figure" — $300-600/mese "non ottimizzato", alcuni power user oltre $1.000/mese. `[FONTE SINGOLA]`
- Un caso specifico febbraio 2026: agente configurato su Claude Opus 4.6, ~25 heartbeat check notturni, ~$0.75/richiesta → **$18.75 in una notte**. `[FONTE SINGOLA]`
- Un utente ha bruciato 150 milioni di token nella prima settimana (~$2.500), "per lo più combattendo problemi di configurazione". `[FONTE SINGOLA]`
- Citazione diretta riportata: *"My WhatsApp bot got added to a group, entered an echo loop, and burned through $47 of Claude credits in 20 minutes before I noticed."* `[FONTE SINGOLA, citazione riportata da un aggregatore]`
- Costo "nascosto" degli heartbeat: 1.440 chiamate API/giorno solo per controlli "sei vivo?" → $5-15/mese di solo overhead heartbeat secondo una fonte. Accumulo di contesto citato come "40-50% del consumo token tipico". `[FONTE SINGOLA]`

**Claude Code — dati aggregati pubblicati da Anthropic** (via aggregatori che citano dati enterprise Anthropic, non un PDF Anthropic fetchato direttamente in questa sessione): costo medio **$150-250/mese per sviluppatore**, media **~$13/sviluppatore/giorno attivo**, **90% degli utenti sotto $30/giorno attivo**. `[TRIANGOLATO su più aggregatori concordi, NON fonte Anthropic primaria fetchata direttamente]`

**Simon Willison — AgentsView (tool di tracking token per agenti di coding sul proprio laptop)**: dati di spesa giornaliera osservati nel suo utilizzo personale — **$77.72 il 2026-06-04** e **$97.79 il 2026-06-09** (per uso intensivo di coding agent, non un agente personale always-on in stile Muffin — contesto d'uso diverso, citato per calibrare l'ordine di grandezza "uso pesante di potenza"). `[FONTE SINGOLA — til.simonwillison.net, autore/fonte ad alta credibilità nel settore ma dato singolo/personale, non un campione]`

**Nota generale, da una fonte aggregata su "personal AI agent" generico**: un agente personale 24/7 stimato a **~$187/mese (~$6.20/giorno)**; uno stack di 5-6 agenti personali ottimizzati stimato $185-480/mese; con modello tiering (premium solo per azione, economico per classificazione/routing) riduzione di costo citata 40-60%. `[FONTE SINGOLA, metodologia di stima non dichiarata — trattare come indicativo di ordine di grandezza, non misura]`

---

## 7. Routing/collocazione — evidenza + trend prezzi (MANDATO 7)

### 7.1 Chi fa routing multi-modello in produzione

- **OpenRouter**: il suo "Auto Router" (`openrouter/auto`) è **motorizzato da Not Diamond** (terza parte specializzata) — supporta lista di modelli ammessi + preferenza costo/qualità, ritorna il modello selezionato nella risposta, addebita la tariffa normale del modello scelto (nessuna fee separata per l'Auto Router). `[TRIANGOLATO]`
- **Martian**: si posiziona su routing "research-oriented" con enfasi su interpretabilità — capisce il prompt e sceglie il modello migliore per quel job, obiettivo dichiarato "tenere alta la qualità mantenendo alto il throughput, tagliando lo spreco di far girare modelli costosi su task facili". `[FONTE SINGOLA descrittiva]`
- Ecosistema più ampio citato attivo nel 2026: LiteLLM, Amazon Bedrock (routing nativo), più letteratura accademica (RouteLLM, MasRouter, Router-R1, BaRP) — il routing come infrastruttura **esiste ed è usato**, non è un'idea abbandonata in generale.

### 7.2 Chi lo ha TOLTO, e perché — post-mortem verificato

**Manifest** (prodotto SaaS, `manifest.build`) — post-mortem fetchato direttamente, 2026-08-04. `[VERIFICATO]`

- **Timeline**: router lanciato marzo 2026 → deprecato giugno 2026 → spento definitivamente 1° settembre 2026. Testato su ~7.000 utenti cloud per 4 mesi.
- Motivazioni citate (parafrasi fedele dal post fetchato):
  1. **"La complessità non può essere dedotta dal prompt da solo"** — il contesto reale emerge solo dopo tool-call e ricerche web già in corso; la stessa richiesta può essere banale (sito HTML) o enormemente complessa (repository Linux) senza differenza visibile nel prompt iniziale.
  2. **Il caching batte il routing sul piano economico**: "le letture da cache sono tra il 75% e il 90% più economiche degli input non memorizzati in cache" — il risparmio teorico del routing è spesso inferiore al risparmio già ottenibile con il caching da solo.
  3. **Incoerenza comportamentale**: "saltare da un modello all'altro durante le sessioni di lavoro produce risultati di qualità inferiore" e comprometterebbe la possibilità per gli ingegneri di sviluppare padronanza degli strumenti (argomento esplicitamente valoriale, non solo tecnico: "un pittore sa che pennello usare... gli ingegneri dovrebbero capire i trade-off tra modelli", posizione contro l'idea che "gli ingegneri non dovrebbero preoccuparsi di scegliere il LLM migliore per il task").
  4. **Costo dell'imprevedibilità nei flussi automatizzati**: "gestire questo livello extra di incertezza può costare più di quanto risparmi".
- Conclusione dichiarata: su 7.000 utenti, i benefici osservati non compensavano i costi nascosti nella maggior parte dei casi.

### 7.3 Trend prezzi frontier 2023→2026

| Anno | Modello di riferimento | Prezzo $/Mtok in / out |
|---|---|---|
| Marzo 2023 | GPT-4 (lancio) | $30 / $60 |
| 2024 | Claude 3 Opus | $15 / $75 |
| Aprile 2026 | Gemini 3.1 Flash | $0.10 / $0.40 (nota: nella tabella ufficiale §1.3 questa riga corrisponde a "Gemini 3.1 Flash-Lite" — possibile imprecisione di naming nella fonte che cita questo confronto) |
| Agosto 2026 | Claude Opus 5 (frontier reasoning) | $5 / $25 |

`[TRIANGOLATO per i valori 2023/2024, ampiamente corroborati su più fonti indipendenti sulla direzione e l'ordine di grandezza]`

Claim aggregati riportati (non tutti incrociati su metodologia pubblica):
- "417x price decline in 18 months" confrontando GPT-4 marzo 2023 con l'offerta equivalente a settembre 2024. `[FONTE SINGOLA]`
- "99.7% price reduction in 3 years" confrontando GPT-4 2023 con Gemini 3.1 Flash 2026. `[FONTE SINGOLA, aritmetica plausibile dati i due prezzi sopra ($30 → $0.10 = -99.67%), ma la scelta dei due modelli come "equivalenti in capacità" non è dimostrata nella fonte]`
- Indice citato: "frontier LLM token price index a 12 il 3 agosto 2026, in calo dell'88% dalla baseline di marzo 2023 (=100)" — metodologia dell'indice non verificabile in questa sessione. `[FONTE SINGOLA — tokencost.app]`
- Simon Willison (citato indirettamente): "DeepSeek, Qwen e Kimi hanno spinto modelli frontier-class nel dominio pubblico a costo quasi zero, costringendo i laboratori chiusi a seguire sul prezzo" — coerente con la traiettoria osservata in §1.5 (DeepSeek V4-Pro a $0.435/$0.87 con capacità SWE-bench 80.6%, quasi alla pari con modelli closed molto più costosi). `[FONTE SINGOLA, parafrasi]`

**Nota per la domanda "il routing è impalcatura?"** (solo fatti, nessun verdetto): il calo di prezzo frontier osservato è nell'ordine di >10x ogni 12-18 mesi su più cicli consecutivi 2023→2026. Questo significa che il delta di costo tra "usa sempre il modello top" e "instrada verso il modello economico" si erode nello stesso arco di tempo in cui un'infrastruttura di routing dev'essere costruita, validata e mantenuta — è un fatto aritmetico sulla serie di prezzi raccolta sopra, non una conclusione dimostrata sul caso Manifest specifico (che ha dato motivazioni di qualità/coerenza, non di erosione del delta economico, come ragione primaria del ritiro).


---

## 8. Self-improvement — stato reale della ricerca (MANDATO 8)

Per ciascuna tecnica: cosa è dimostrato, con che numeri/scala, requisiti dichiarati, e applicabilità dichiarata a un sistema single-user senza infrastruttura RL.

### 8.1 GEPA (prompt optimization) — `[VERIFICATO — arXiv:2507.19457, accettato ICLR 2026 come Oral; dspy.ai docs]`

- Meccanismo: "reflective prompt evolution" — evolve le istruzioni leggendo messaggi di errore, log di ragionamento, dati di profiling dai trace di esecuzione (non un reward scalare), selezione tramite frontiera di Pareto.
- Risultati misurati: **+13% di guadagno aggregato su MIPROv2** (che a sua volta guadagna +5.6% — quindi GEPA più che raddoppia il guadagno del predecessore). Su Qwen3-8B, **batte GRPO (RL con 24k rollout) fino a +20%, usando fino a 35x meno rollout**, con guadagno medio +6% su 6 task.
- Efficienza campionaria: bastano **10 esempi e 20-100 valutazioni** (contro 40+ trial e 200+ esempi per MIPROv2).
- Requisiti dichiarati: un piccolo dataset di esempi + una funzione di valutazione/reward + accesso ai trace di esecuzione. **Non richiede training RL né accesso ai pesi** — gira sopra un modello frozen, anche dietro API chiusa.
- **Applicabilità a single-user senza infra RL: SÌ in linea di principio** — è presentato esplicitamente come alternativa più efficiente all'RL, il costo è "N chiamate LLM di valutazione/riflessione", non compute di training.

### 8.2 AlphaEvolve (DeepMind) — `[VERIFICATO — arXiv:2506.13131, deepmind.google/blog, repo GitHub con notebook di verifica]`

- Meccanismo: pipeline autonoma di LLM (Gemini) che modifica iterativamente codice, valutato da una funzione di fitness ESEGUIBILE.
- Risultati concreti dimostrati: nuovo algoritmo per moltiplicazione di matrici 4×4 complesse con 48 moltiplicazioni scalari — primo miglioramento in 56 anni sull'algoritmo di Strassen in quel caso specifico (verificabile via notebook pubblico). Euristica per l'orchestrazione di Borg (scheduler datacenter Google) **in produzione da oltre un anno**, recupera in media **0.7% delle risorse compute globali di Google**.
- Requisito strutturale dichiarato: il problema deve ammettere una **funzione di valutazione eseguibile e oggettiva** (verificabile automaticamente se una soluzione è migliore di un'altra).
- **Applicabilità a single-user: PARZIALE** — il meccanismo (evolvi-codice-contro-eval-eseguibile) non richiede infra RL né pesi aperti, ma richiede che il target ammetta un fitness automatico oggettivo. Vale per ottimizzazione di codice/algoritmi con benchmark chiari; **non è ovviamente applicabile** a "migliora la qualità delle risposte di un agente conversazionale personale", dove "l'utente è stato aiutato bene?" non è una funzione eseguibile/oggettiva.

### 8.3 SEAL — Self-Adapting Language Models (MIT) — `[VERIFICATO — arXiv:2506.10943, NeurIPS 2025; MIT News; VentureBeat sull'update 2025-11]`

- Meccanismo: il modello genera un "self-edit" (dati di fine-tuning + iperparametri, o invocazione di tool per data augmentation) applicato via **SFT con LoRA** → aggiornamento persistente dei pesi. La policy che genera i self-edit è addestrata con un **loop di reinforcement learning** che usa la performance post-update come reward.
- Risultati: la versione aggiornata (nov 2025) mostra che la capacità di auto-adattamento **scala con la dimensione del modello**, integra RL più efficacemente per ridurre il forgetting catastrofico; claim che i self-edit di SEAL producono dati di training più utili di GPT-4.1 su task specifici. `[claim citato da VentureBeat/MIT, non riverificato nel dettaglio del paper in questa sessione]`
- Requisiti dichiarati: **loop RL** per addestrare la policy di self-editing + capacità di eseguire fine-tuning (anche leggero, LoRA) sui pesi del modello.
- **Applicabilità a single-user senza infra RL: NO in forma pura** — SEAL è esplicitamente un metodo che addestra (RL + SFT/LoRA) la capacità di auto-editing; richiede accesso ai pesi (quindi solo open-weight self-hosted, mai dietro API chiusa) e un loop RL — esattamente l'infrastruttura che il mandato chiede di escludere per la valutazione di applicabilità.

### 8.4 Voyager (skill library) — `[VERIFICATO — arXiv:2305.16291, NeurIPS 2023, HuggingFace papers, GitHub MineDojo/Voyager]`

- Meccanismo: agente Minecraft con (1) curriculum automatico che massimizza l'esplorazione, (2) libreria di skill **in codice eseguibile** sempre crescente, (3) prompting iterativo con feedback ambientale/errori/auto-verifica. Interagisce con GPT-4 via query black-box — **nessun fine-tuning dei pesi**.
- Risultati: **3.3x più oggetti unici**, **2.3x più distanza percorsa**, sblocca traguardi del tech-tree **fino a 15.3x più velocemente** del prior SOTA. Le skill sono trasferibili a un mondo Minecraft nuovo senza re-training (in-context lifelong learning).
- **Applicabilità a single-user senza infra RL: SÌ — probabilmente il pattern più direttamente applicabile del gruppo.** Nessun training, nessun accesso ai pesi richiesto; il "miglioramento" è accumulo di codice/skill riutilizzabile in uno store esterno al modello, compatibile con API chiusa o modello locale indifferentemente. Costo: chiamate LLM per scrivere/raffinare skill + storage per la libreria.

### 8.5 Self-rewarding / self-refine / auto-correzione — limiti misurati

- **"Large Language Models Cannot Self-Correct Reasoning Yet"** (Huang et al., arXiv:2310.01798, ICLR 2024) `[VERIFICATO]`: dimostra empiricamente che l'**auto-correzione intrinseca** (senza feedback esterno oracle) su task di ragionamento spesso **non migliora e talvolta peggiora** le risposte — in contrasto con risultati precedenti che usavano etichette oracle come "feedback esterno" mascherato da auto-correzione pura.
- **Process-based Self-Rewarding Language Models** (ACL Findings 2025) `[VERIFICATO — huggingface.co/papers/2503.03746, aclanthology.org]`: conferma che il paradigma self-rewarding "vanilla" **non è efficace in ragionamento matematico e può portare a un calo di prestazioni**; propone giudizio step-wise + preference optimization step-wise come mitigazione parziale.
- **Lettura per il mandato**: questo è esattamente il tipo di claim che va separato dalla narrativa RSI — "il modello migliora riflettendo su di sé" è supportato dall'evidenza **solo con un ancoraggio a un segnale esterno verificabile** (test che passa/fallisce, eval numerica, correzione esplicita dell'utente), non come processo puramente introspettivo. Qualunque schema di self-improvement senza terra esterna verificabile è, secondo questa evidenza specifica, a rischio di degradare invece di migliorare.

### 8.6 Reflexion (memoria episodica + riflessione verbale) — `[VERIFICATO — arXiv:2303.11366, NeurIPS 2023]`

- Meccanismo: l'agente riflette verbalmente sul segnale di feedback di un task e mantiene il testo riflessivo in un **buffer di memoria episodica** per migliorare i tentativi successivi — nessun fine-tuning.
- Risultati: **91% pass@1 su HumanEval** (vs 80% del baseline GPT-4 dell'epoca); miglioramenti anche su HumanEval-Rust (68.0% vs 60.0%) e MBPP-Rust (75.4% vs 70.9%). Ablation: la riflessione testuale completa dà **+8 punti assoluti** sopra la sola memoria di traiettoria grezza (senza riflessione linguistica) — la lezione in linguaggio naturale conta più del semplice replay.
- **Applicabilità a single-user senza infra RL: SÌ** — nessun training; il meccanismo è "genera testo di riflessione dopo un fallimento OSSERVATO ED ESPLICITO (test fallito, eval fallita, errore di tool) e reinseriscilo nel prompt dei tentativi successivi". Compatibile con qualunque modello, API o locale. Nota di coerenza con 8.5: richiede comunque un segnale di fallimento verificabile, non "il modello giudica se stesso".

### 8.7 Memory-based improvement (imparare da trace passati) — quadro generale, non un singolo paper

La letteratura su agent memory (Reflexion, Generative Agents, MemGPT/Letta, la skill library di Voyager) converge su un pattern comune: **osserva trace → estrai lezione testuale/skill → deposita in uno store esterno consultabile → recupera al bisogno**, come alternativa dominante al fine-tuning per sistemi single-user. **Gap esplicito**: non ho trovato in questa sessione un paper 2026 che quantifichi il guadagno di questo pattern specificamente per un **agente personale conversazionale** (a differenza dei task coding/Minecraft misurati sopra). `[NON VERIFICATO per il caso d'uso specifico "agente personale always-on"]`

### 8.8 Eval-gated config changes in prodotti reali

- Ho trovato descrizioni di pratica standard MLOps (rollout a 4 stadi: shadow → canary → percentuale → full, con eval automatiche a ogni stadio e trigger di rollback) e due "case study" con numeri concreti (es. "groundedness giù del 12%, tasso di rifiuto da 4% a 27% in un'ora dopo un prompt change senza eval-gate"; "customer-satisfaction da 0.91 a 0.74 in 19 minuti, 81.000 richieste servite dal prompt difettoso prima dello spegnimento") — ma le fonti sono contenuti di vendor/blog (futureagi.com) con aziende **anonimizzate** ("un team B2B ha…"), non nominabili/verificabili indipendentemente. `[NON VERIFICATO come caso reale nominabile — trattare i numeri come illustrativi di un pattern di rischio noto, non come dato aziendale verificato]`
- Prodotti nominati che offrono infrastruttura per questo pattern esistono nel mercato (Braintrust, LangSmith, Statsig, Not Diamond) ma non ho verificato case study specifici con numeri pubblici affidabili in questa sessione.

### 8.9 Claim RSI 2026 — narrativa vs evidenza

- **Claim del settore**: OpenAI ha dichiarato (GPT-5.3-Codex, febbraio 2026) che versioni precedenti del modello sono state "instrumental in creating itself" — descritta da un aggregatore come "la prima ammissione esplicita di un frontier lab che un proprio modello ha contribuito materialmente all'ingegnerizzazione del successore". `[FONTE SINGOLA aggregatore che cita la dichiarazione OpenAI; annuncio originale non fetchato direttamente in questa sessione]`
- Claim quantitativo correlato, stessa fonte: "Claude Code è passato dal risolvere <80% di problemi banali (settembre 2025) al ~90% (maggio 2026)", con cifre analoghe per task "substantial" (65%→90%) e "open-ended" (<20%→76%). `[FONTE SINGOLA AGGREGATORE, metodologia di misurazione non specificata — non verificabile]`
- **Posizione scettica documentata** (Riedl/Medium, Communications of the ACM, Jon Krohn, daveshap — tutte fonti 2026): consenso tra questi commentatori che l'attuale "auto-miglioramento" ha ancora **umani nel loop** che fissano obiettivi e giudicano risultati — non è RSI autonoma nel senso classico (nessun sistema rimuove l'uomo dal loop di obiettivo/giudizio). Due colli di bottiglia citati esplicitamente: **compute** (scarsità di chip) e **dati** (la verificabilità del successo fuori da codice/matematica è difficile, rischio di "recursive drift" — il sistema si auto-conferma su segnali deboli senza terra esterna, coerente con 8.5).
- **Sintesi per il mandato**: nessuna fonte trovata in questa sessione dimostra RSI in senso stretto (sistema che migliora se stesso ricorsivamente senza intervento umano su obiettivi/giudizio). Tutto ciò che è **dimostrato** nelle sezioni 8.1-8.6 sopra è miglioramento-con-terra-esterna-verificabile e umano-nel-loop a qualche livello (dataset/eval per GEPA, fitness eseguibile per AlphaEvolve, RL supervisionato per SEAL, feedback ambientale per Voyager, segnale di fallimento esplicito per Reflexion) — non auto-miglioramento autonomo puro.

### 8.10 Tabella riassuntiva requisiti dichiarati

| Tecnica | Richiede training/RL | Richiede accesso ai pesi | Richiede eval eseguibile oggettiva | Applicabile single-user senza infra RL (dichiarato) |
|---|---|---|---|---|
| GEPA | No | No | Sì (funzione di valutazione, anche piccola) | **Sì** |
| AlphaEvolve | No (usa LLM esistente in loop) | No | **Sì, stretto** (fitness eseguibile) | Parziale — solo per problemi con fitness automatico |
| SEAL | **Sì (RL + LoRA SFT)** | **Sì** | Sì (reward = performance post-update) | **No** in forma pura |
| Voyager (skill library) | No | No | Debole (feedback ambientale/errori, non un punteggio oggettivo stretto) | **Sì** |
| Reflexion | No | No | Sì (segnale di fallimento esplicito) | **Sì** |
| Self-rewarding/self-refine puro (senza terra esterna) | No | No | **No — ed è proprio il problema documentato** | Sconsigliato dall'evidenza stessa (rischio di degrado) |

---

## 9. Nota metodologica finale / gap noti

- **Pagine ufficiali non raggiungibili in questa sessione** (403/404/JS-render, dati quindi da aggregatori triangolati): `chatgpt.com/pricing`, `openai.com/chatgpt/pricing`, `openai.com/policies/usage-policies/` (fetch fallito, dati da ricerca), `gemini.google.com/subscriptions`, `gorilla.cs.berkeley.edu/leaderboard.html` (tabella dati JS-rendered), `swebench.com` (contenuto troncato), `theregister.com` (404), `marketingagent.blog` (dominio non risolvibile).
- **Pagine ufficiali raggiunte e fetchate direttamente**: `platform.claude.com/docs/en/about-claude/pricing`, `claude.com/pricing`, `anthropic.com/legal/consumer-terms`, `anthropic.com/aup`, `anthropic.com/news/redeploying-fable-5`, `ai.google.dev/gemini-api/docs/pricing`, `developers.openai.com/api/docs/pricing`, `api-docs.deepseek.com/quick_start/pricing`, `openai.com/index/introducing-gpt-oss` (via ricerca con contenuto citato), `manifest.build/blog/why-we-deprecated-our-llm-router/`, `github.com/google-gemini/gemini-cli/discussions/22970`, `epoch.ai/benchmarks/fictionlivebench` (pagina raggiunta ma senza dati tabellari esposti), `llm-stats.com/benchmarks/bfcl-v4` e `/swe-bench-verified`.
- **Discrepanze esplicite non risolte**: BFCL-v4 (tre tabelle in conflitto, §2.1); nome "Gemini 3 Pro" vs "Gemini 3.1 Pro Preview" (§1.3); sconto caching esplicito Gemini 3 Pro 75% vs 90% (§5.3); percentuale sconto caching OpenAI per modello (§5.2).
- **Gap espliciti (assenza di dato, non conferma di assenza del fenomeno)**: case study di enforcement ToS nominato per OpenAI ChatGPT Plus/Pro via harness non ufficiali (§4.2); quantificazione del gap long-context claimed-vs-misurato per la classe open-weight più recente — DeepSeek V4/Kimi K3/GLM-5.2/Qwen3.7 (§2.4); guadagno quantificato del pattern "memory-based improvement" specificamente su agenti personali conversazionali, non coding/Minecraft (§8.7); case study di eval-gated deployment con azienda nominata e numeri verificabili (§8.8); consumo elettrico reale misurato (non da specifica vendor) per GPU/mini-PC sotto carico LLM (§3.3).
- Le tabelle §6.2 (OpenClaw) e alcune cifre §3.1/§3.4/§4.1 provengono da aggregatori/blog SEO 2026 specializzati in "guide" — non da un singolo laboratorio di benchmark indipendente con metodologia pubblica uniforme. Trattarle come ordini di grandezza plausibili e triangolati dove indicato, non come misure di laboratorio certificate.

---

## Sintesi per pitch/ADR (incollabile senza rileggere il report)

Ad agosto 2026 il panorama modelli è cambiato sostanzialmente rispetto a gennaio: Anthropic ha aggiunto una classe sopra Opus (Fable 5 pubblico $10/$50 per Mtok, Mythos 5 ad accesso ristretto, lanciati 9 giugno con breve sospensione per export control), Sonnet 5 è in prezzo introduttivo $2/$10 fino al 31/8/26 (poi $3/$15), e sia OpenAI (GPT-5.6) che Google (Gemini 3.x) hanno famiglie multi-tier equivalenti — tutti i tre grandi provider convergono sulla stessa meccanica di caching (premio scrittura 1.25-2x, sconto lettura ~90%, break-even 1-2 riusi). Sul fronte capacità, il gap open/frontier su SWE-bench Verified si è ristretto a ~14 punti al top (DeepSeek V4-Pro open-weight MIT all'80.6%, quasi pari a Gemini 3.1 Pro closed, contro il 95% di Claude Fable 5), mentre BFCL resta un dato internamente incoerente tra fonti (non risolto, non un solo numero affidabile). L'hardware locale opera oggi sotto una carenza DRAM/HBM strutturale (prezzi RAM/GPU su del 70-90%+ nel 2026, prevista persistere fino al 2028) che rende "gira in locale" più caro che nel 2024-2025 di riferimento; la classe MoE 30B-A3B resta il punto dolce pratico (RTX 5090 ~234 tok/s, mini-PC Strix Halo 128GB ~$1800-2000, ~100 tok/s). Sugli abbonamenti consumer, tutti e tre i vendor (Anthropic, OpenAI, Google) vietano esplicitamente nei ToS l'uso automatizzato/headless del piano consumer al di fuori del client ufficiale — solo l'API a consumo è un percorso "legittimo" per un agente always-on — e Anthropic ha enforcement documentato e pesante (1.45M account bannati H2-2025, 3.3% tasso di successo appelli). Sul self-improvement, l'unica classe di tecniche con evidenza solida E applicabilità dichiarata a un single-user senza infrastruttura RL è quella ancorata a un segnale esterno verificabile e senza fine-tuning dei pesi (GEPA per i prompt, Reflexion/Voyager per memoria-di-trace e skill library) — tutto ciò che richiede RL/accesso ai pesi (SEAL) o fitness automatico oggettivo (AlphaEvolve) ha un requisito strutturale che un agente conversazionale personale non soddisfa banalmente, e l'auto-correzione/self-rewarding senza terra esterna è **evidenza contraria**, non solo assenza di evidenza a favore.

