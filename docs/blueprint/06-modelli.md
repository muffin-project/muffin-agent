# 06 — Modelli: tier, approvvigionamento, collocazione, costi

> Prezzi e capacità: A5 (fonti ufficiali, rilevazione 2026-08-04). Slate consumer-locale: A5 §3 + scout interno `2026-07-06-consumer-model-slate.md`. I prezzi cambiano: ogni numero qui porta la data; il documento va ri-datato a ogni revisione della config.

---

## 1. Verdetto sui tre assi

**Tier.** Il grosso del lavoro quotidiano di un agente personale (estrazione, consolidamento, classificazioni, riassunti, recall-rerank) è fascia $0.10–2/Mtok senza gap dimostrato per quei task; il frontier serve dove serve profondità (coding, ragionamento lungo, dream/introspezione pesante). Struttura: **due lane statiche (`main`, `light`) + una lane `deep` on-demand** invocata esplicitamente dal loop, mai da un classifier.

**Approvvigionamento.** **API a consumo come default** (gli abbonamenti consumer sono vietati dai ToS per l'uso headless — chiuso, 00 #7) **+ profilo locale consumer first-class opzionale**. "First-class" significa: testato nella CI di capability come il modello API, con degradazione dichiarata — mai più "local-first" come etichetta (0/1689 turni locali nel Muffin attuale).

**Collocazione.** Statica, in config, per funzione. **Niente router dinamico** (impalcatura con post-mortem: Manifest l'ha rimosso su 7.000 utenti — "la complessità non si deduce dal prompt", "il caching batte il routing", qualità degradata dal model-switching; e il trend prezzi >10×/12-18 mesi erode il delta). L'escalation `main→deep` esiste ma è **una decisione del loop, visibile nel trace**, non un layer di routing.

## 2. La direttiva owner: harness costruito per i modelli consumer

Il rischio nominato ("se faccio l'harness su Sonnet, poi Gemma-4 non sta dietro") ha due risposte strutturali:

1. **Capability floor come contratto** (V2, 05 §2): l'harness dichiara cosa richiede al modello (N tool simultanei, X turni di orizzonte, formato tool-call, recovery) e la CI lo verifica su **due riferimenti pinnati**: uno frontier-API e uno consumer-locale. Se uno scenario passa solo sul frontier, o si semplifica lo scenario o si dichiara la capability "sopra-floor" — mai silenziosamente "funziona (su Sonnet)".
2. **Profili per-modello dichiarativi** (`agent/profiles/`): tool esposti (subset per i piccoli), orizzonte massimo, stampelle (output strutturati, retry, recovery cascade — il pattern Hermes: nudge → prefill → retry ≤3 → provider switch è *per-modello*, non nel core), parametri (thinking on/off — lezione interna: l'effetto del thinking è model-specific). Le stampelle sono impalcatura etichettata (07): con un modello migliore si spegne il profilo, non si riscrive il loop.

Evidenza interna che rende il floor realistico: nei crux più puliti di Muffin, la competenza dei modelli 26-30B era 88-100% e i fallimenti erano di framing/harness, non di capability — un harness disegnato bene è la variabile più grossa, prima del modello.

**Slate consumer-locale di riferimento (da validare su harness proprio, non su benchmark — lezione GLM-4.7)**: classe MoE ~20-35B-attivi-3B. Candidati con credenziali: **GPT-OSS-20b** (Apache 2.0, gira in 16GB, tau-bench competitivo per self-report — il candidato più hardware-realistico, MAI testato in casa; rischio formato "harmony" da verificare all'integrazione), **Qwen3.5/3.6-35B-A3B** (Apache 2.0, generazione mai testata in casa, gira su Mac 16GB per un tester esterno), **Gemma-4-26b-a4b** (incumbent, noto). La scelta finale del riferimento locale è un **eval interno di 1-2 giorni sul floor**, non una decisione da benchmark.

### 2-bis. Catalogo verificato su OpenRouter (B2, rilevazione 2026-08-04 via API pubblica `/api/v1/models`, 338 modelli)

**Il "Qwen 3.8 27B" non esiste.** Verificato su cinque fonti indipendenti: nell'intero catalogo esiste un solo modello 3.8 (`qwen/qwen3.8-max`), è **closed-weight** (`hugging_face_id: null`, un solo provider di inferenza), e sull'org HuggingFace di Qwen non c'è alcun repo 3.8. I pesi — sia del Max sia di un **Qwen3.8-27B** — sono annunciati per metà agosto 2026, quindi dopo questa rilevazione. **Da ri-controllare tra qualche settimana**: se escono, sono il candidato locale più interessante della fascia.

Cosa esiste oggi nella fascia 20-40B, tutto Apache 2.0 salvo indicato (prezzo $/Mtok in/out su OpenRouter):

| Modello | Arch. | Context | Prezzo | Tool | Vision |
|---|---|---|---|---|---|
| `qwen/qwen3.6-27b` · `qwen3.5-27b` | dense | 262K | $0.29/$2.40 · $0.195/$1.56 | sì | **sì** (img+video) |
| `qwen/qwen3.6-35b-a3b` · `qwen3.5-35b-a3b` | MoE 35B/3B | 262K | $0.14/$1.00 | sì | **sì** |
| `qwen/qwen3-vl-32b-instruct` | dense | 131K | $0.104/$0.416 | sì | **sì** nativa |
| `openai/gpt-oss-20b` | MoE 21B/3.6B | 131K | $0.03/$0.13 | sì (formato harmony) | no |
| `google/gemma-4-26b-a4b-it` *(incumbent)* | MoE 25B/3.8B | 262K | $0.07/$0.34 | sì | **sì** (img+video) |
| `mistralai/mistral-small-3.2-24b` | dense | 256K | $0.075/$0.20 | sì | sì (img) |
| `nvidia/nemotron-3-nano-omni-30b-a3b` | MoE 30B/3B | 256K | free tier | sì | **omni**: img+audio+video (licenza NVIDIA, non Apache) |
| `z-ai/glm-4.7-flash` | MoE ~30B/3B | 203K | $0.06/$0.40 | sì | no — **già rigettato in casa** su italiano e disciplina tool |

**Il finding che cambia di più il piano**: l'incumbent `gemma-4-26b-a4b` è **già multimodale (immagine + video) sullo stesso endpoint OpenRouter già cablato**. La capability di *lettura* di immagini non è un modello in più da aggiungere: è un percorso già pagato che il codice attuale probabilmente ignora. Stesso discorso per tutta la famiglia Qwen3.5/3.6.

**Rischio di licenza emergente, rilevante perché l'owner è in UE**: MiniMax H3 (rilasciato il 2026-08-04) ha una Community License che **esclude esplicitamente USA, UE, UK e Corea del Sud** — anche per pesi eseguiti in locale. Non risulta applicarsi a Qwen/GLM/DeepSeek (Apache/MIT senza restrizioni geografiche), ma la licenza definitiva di Qwen3.8 open-weight non è ancora pubblicata. **Regola operativa**: la licenza di ogni modello open-weight si rilegge al momento dell'adozione, non si assume dalla famiglia.

### 2-ter. Multimodale e audio (B2)

**Input multimodale, cosa accetta chi**: Claude legge immagini e file (PDF) ma **non ha audio nativo** — la "voice mode" è STT→testo→modello→TTS, non comprensione audio; il costo immagine è puro token-count (patch 28×28: un'immagine 1000×1000 ≈ 1296 token, ~$1,30 ogni 1000 immagini su Haiku). OpenAI serve l'audio da **modelli separati** ($10-32/Mtok). **Gemini è l'unico frontier con audio e video nativi sulla stessa famiglia generalista**, con prezzo per-modalità che varia da 1× a 3,3× il testo a seconda del modello. Open-weight: Qwen3-VL e Qwen3.5/3.6 hanno vision Apache 2.0; Gemma-4 vision su tutta la linea (audio solo sul 12B, con stack llama.cpp/Ollama ancora immaturo — verificato in casa a giugno: crash e 5m35s per una clip di 9s); l'unico **omni** in fascia è Nemotron-3-Nano-Omni.

**Audio in ingresso — verdetto**: la trascrizione è un **servizio a sé, non una lane del modello principale**. Il più economico verificato è `gpt-transcribe` (**$0.27/h**, WER 4%); il migliore su WER generale è ElevenLabs Scribe (2,2%, italiano dichiarato solo come fascia "≤5%"); Deepgram Nova-3 ~$0.26/h. **Nessun servizio pubblica un WER italiano puntuale** — stesso vuoto già trovato sugli embedding, e stessa conseguenza: se conta, si misura in casa su audio reale. Locale vs API dipende dall'hardware, non dal modello: Whisper large-v3 gira più veloce del tempo reale su Mac con Metal, **3-6× più lento del reale su CPU pura** (cioè inutilizzabile sulla classe di VPS in produzione). Design che ne segue: la trascrizione è una capability dietro un'interfaccia, locale dove c'è Metal/GPU, API altrove — la scelta è di profilo d'installazione, non di architettura.

## 3. SDK e astrazione provider (la domanda "come fanno Hermes & co.")

Cosa fa il campo (A2 + teardown interni): **nessuno usa un framework** — Hermes ha un client proprio con provider-switch dentro la recovery cascade; Goose un'astrazione sottile su 15+ provider; OpenClaw config per-modello; il Muffin attuale un solo SDK `openai` per tre provider. Il pattern comune: **OpenAI-compatible chat-completions come lingua franca** (la parlano Ollama, llama.cpp, vLLM, OpenRouter, DeepSeek, Gemini-compat…) + adattatori nativi dove il minimo comune denominatore costa.

Verdetto (ADR-0008): interfaccia interna unica `ChatCall` (nostra, tipata: messages, tools, cache-hints, thinking-budget, structured-output) con **due adapter**: `openai-compat` (copre locale + quasi tutto il cloud) e `anthropic` nativo (dove l'OpenAI-compat livella: prompt caching esplicito write 1.25-2×/read -90%, extended thinking, 1M context). Un terzo adapter (es. Gemini nativo per il caching implicito) si aggiunge solo su bisogno dimostrato. Il progetto open source **non pretende un provider**: pretende un endpoint OpenAI-compat *oppure* una chiave Anthropic — la porta d'ingresso più larga possibile senza pagare l'astrazione-framework.

## 4. Costi mensili stimati (aritmetica sui prezzi A5, rilevati 2026-08-04)

Profilo d'uso "medio realistico e proattivo": ~120 turni/giorno (chat+proattività, ~8K token in di cui ~7K cache-read, ~400 out), consolidamento notturno (~200K in/5K out, lane light), 4 deep-research/mese (~1,5M in/60K out). Formula: `in_nocache×P_in + in_cache×P_in×0.1 + out×P_out`.

| Config | main / light / deep | Chat/mese | Consolid. | Research | **Totale** |
|---|---|---|---|---|---|
| **A. API bilanciata** *(raccomandata owner)* | Sonnet 5 / Haiku 4.5 / Opus 5 on-demand | ~$29 (intro $2/$10) → ~$40 (da set: $3/$15) | ~$7 | ~$22 (Sonnet) — $36 se Opus | **~$55-70/mese** |
| **B. API economica** | Haiku 4.5 / Gemini 2.5 Flash-Lite / Sonnet on-demand | ~$13 | ~$0.70 | ~$7 | **~$20-25/mese** |
| **C. Ibrida** *(raccomandata repo, se c'è hardware)* | Sonnet 5 / **locale 20-35B-A3B** / Opus on-demand | ~$29-40 | ~€1-3 elettricità marginale | ~$22 | **~$50-65/mese** (–light API, +privacy sull'estrazione: i contenuti grezzi non escono per il consolidamento) |
| **D. Tutta locale** | 20-35B-A3B per tutto | $0 API | — | degradato | **~€12-18 elettricità** (box dedicato ~60-140W, EU €0.29/kWh) **+ ~€75-85/mese di hardware ammortizzato 24 mesi** (mini-PC 128GB ~$1.800-2.000, prezzi sotto shortage DRAM) — e capability al floor, non oltre |
| *(rif.)* Muffin oggi | Gemma-4 API | ~$0.003/turno → ~$11-15/mese equivalente | — | — | il salto di qualità del modello si paga: A costa ~4-5× l'attuale |

Note oneste: il profilo pesante (~300 turni + research settimanale) moltiplica ×2,5-3; l'eco-loop in un gruppo può bruciare budget in minuti (caso documentato $47/20min su OpenClaw) → i cap per-tenant di M0 non sono opzionali; Sonnet 5 perde il prezzo intro il 31/8/2026 (i numeri "→" lo incorporano).

**Config consigliata per te (owner)**: **A** con lane light su **C** appena l'hardware c'è (l'estrazione/consolidamento locale è il pezzo a più alto valore privacy per € spesi: è quello che legge *tutto*). Deep = Opus 5 esplicito. **Config consigliata per chi installa il repo**: default = qualunque endpoint OpenAI-compat (anche solo locale: funziona al floor) o chiave Anthropic; il wizard `muffin init` propone B come entry-point economico e dichiara il costo stimato al mese *prima* di partire.

## 5. Embedding

Locale di default (**qwen3-embedding 0.6b via Ollama** — incumbent noto, footprint ~1.2GB), cloud opzionale. Nessun numero pubblico affidabile per l'italiano su nessun candidato (A4 §8): qualunque cambio passa dall'eval italiana propria (05 §3.6). `embedding_v` versionato rende il re-index un job, non una migrazione.

## 6. Self-improvement (rimando)

Meccanismo e prior-art in V3 (cricchetto eval-gated; GEPA/Reflexion/skill-library = applicabili; SEAL no; self-rewarding puro = controproducente). Qui solo il legame coi modelli: il cricchetto usa la lane `light` per generare proposte e la suite eval come giudice — **mai il modello che giudica se stesso nel proprio gate** (05 §5).
