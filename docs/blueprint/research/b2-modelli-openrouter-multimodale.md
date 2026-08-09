# B2 — Modelli: catalogo OpenRouter concreto + multimodale (MuffinOS Blueprint, Fase D)

**Ruolo:** scout, sola evidenza con fonte. Nessun verdetto/raccomandazione — decide l'agente principale.
**Data di rilevazione:** 2026-08-04 (tutte le fonti sotto sono state aperte in questa data, salvo diversa indicazione esplicita).
**Metodo:** oltre a WebSearch/WebFetch su pagine ufficiali, questa sessione ha fetchato **direttamente l'API pubblica di OpenRouter** (`GET https://openrouter.ai/api/v1/models`, nessuna auth richiesta) via `curl` read-only, salvato il JSON completo (338 modelli, `total_count: 338`) e interrogato con script Python locali. Questo è il dataset più affidabile disponibile in questa sessione per prezzi/context/`supported_parameters`/modalità per-modello: è dato strutturato servito dal backend di OpenRouter, non un riassunto di pagina renderizzata via JS. Le pagine scrapeate (WebFetch su `openrouter.ai/models`, `openrouter.ai/qwen`, singole pagine modello) sono usate solo per descrizioni prosa e per i pochi prodotti (ASR/TTS Qwen) assenti dal JSON `/models`. Pagine ufficiali vendor (Anthropic, Google, OpenAI) fetchate direttamente dove possibile.

**Tag di confidenza** (stessa convenzione di A5):
- `[VERIFICATO]` = fonte ufficiale primaria fetchata direttamente, oppure dato strutturato dall'endpoint pubblico OpenRouter `/api/v1/models`.
- `[TRIANGOLATO]` = 2+ fonti indipendenti concordi.
- `[FONTE SINGOLA]` = una sola fonte secondaria, non incrociata.
- `[DISCREPANZA]` = fonti in conflitto, riportate entrambe, non risolte.
- `[NON VERIFICATO]` = claim che non sono riuscito a confermare in questa sessione.

---

## 0. Cosa NON ri-derivo

`docs/blueprint/research/a5-modelli-economia.md` (2026-08-04, stessa sessione di lavoro sul blueprint) copre già: pricing testo frontier Claude/GPT/Gemini, mid-tier, famiglie open-weight top con licenza/dimensioni (§1.5 — inclusa la prima rilevazione dello stato Qwen3.7/3.8 all'annuncio del 19 luglio: "Qwen3.8: annunciato 2026-07-19, 2.4T parametri, pesi aperti 'presto' ma non ancora rilasciati"), BFCL/SWE-bench/tau-bench, hardware locale (tok/s, quantizzazione, elettricità, costo hardware), abbonamenti consumer + ToS, meccanica di caching, self-improvement. Non ripeto quei numeri — li cito come ancoraggio dove serve. Questo report **estende specificamente** i due assi che A5 non copre, su mandato esplicito: (a) il catalogo OpenRouter aperto e verificato pagina-per-pagina/API con licenza e `supported_parameters` per singolo endpoint nella fascia 20-40B; (b) multimodale (immagine/audio/video/PDF) e trascrizione audio, quasi assenti in A5.

Non ri-tratto/ri-eseguo:
- Il verdetto interno Muffin su **GLM-4.7-Flash**, già valutato e **RIGETTATO** sull'harness proprio (`.claude/agent-memory` → `project_glm_47_flash_eval.md`, 2026-06-13) — citato in §5.2 come dato empirico esistente, non ri-eseguito qui.
- La maturità del runtime **audio Gemma-4-12B**, già indagata (`.claude/agent-memory/research-scout/2026-06-17-gemma4-12b-audio.md`) — citata in §3.2, non ri-testata.
- Gli score interni Muffin sui propri harness (fuori scope).

---

## 1. Qwen 3.8 in taglia 20-40B: esiste? (Mandato 1)

**Risposta diretta: NO, non ancora, alla data di rilevazione (2026-08-04).**

### Catena di evidenza

1. **Enumerazione completa via API OpenRouter** `[VERIFICATO]`: il JSON `/api/v1/models` fetchato in questa sessione contiene **49 modelli Qwen**. Filtrando su `id` per la generazione "3.8", risulta **un solo modello**: `qwen/qwen3.8-max` (slug canonico `qwen/qwen3.8-max-20260803`). **Nessun `qwen/qwen3.8-27b` o equivalente esiste nel catalogo.**
2. **Il modello esistente (Qwen3.8 Max) non è open-weight**: nel record JSON, `"hugging_face_id": null` — a differenza di *tutti* i modelli Qwen3.5/3.6/3-32B/ecc. citati in §2, che hanno un `hugging_face_id` popolato (es. `Qwen/Qwen3.6-27B`). Il campo `top_provider` mostra un solo fornitore di inferenza (nessun routing multi-provider, tipico dei modelli con pesi effettivamente distribuiti a più host indipendenti). `[VERIFICATO]`
3. **Ricerca diretta su Hugging Face** (org `huggingface.co/Qwen`, fetch diretto): **nessun repository "Qwen3.8", "Qwen3.8-27B" o "Qwen3.8-Max" presente** tra i modelli dell'organizzazione al momento del fetch. `[VERIFICATO]`
4. **Fonte ufficiale Qwen/Alibaba** (`qwenlm.github.io/blog/`): conferma che Qwen3.8-Max è stato reso disponibile in **API (DashScope)**, descritto come "successore GA del Qwen3.8 Max Preview" — nessuna menzione di pesi scaricabili nel materiale raggiunto. `[TRIANGOLATO — via ricerca, blog ufficiale non fetchato riga-per-riga in questa sessione]`
5. **Blog tecnico indipendente** (`blog.invidelabs.com`, pubblicato 2026-08-03), citazione verbatim: *"the model's weights will be released next week, marking the first time Qwen has committed to opening the weights of a Max-class model"* e *"developers still cannot inspect the final license, download the promised weights, or test community quantizations. Until then, Qwen3.8-Max open weights are a notable commitment with a short deadline."* L'articolo specifica che **anche Qwen3.8-27B** è annunciato per pesi aperti "alla settimana prossima" insieme al Max. `[VERIFICATO diretto sul testo dell'articolo]` — nota: "settimana prossima" rispetto a un articolo del 3 agosto pone il rilascio atteso attorno al 10 agosto 2026, **dopo** la data di rilevazione di questo report.
6. Un titolo di aggregatore (`we.inc/blog`, *"Qwen3.8-Max Just Dropped as Open Weights"*) sembra contraddire quanto sopra, ma il fetch del contenuto completo dell'articolo non ha restituito testo oltre il titolo — **non risolvibile in questa sessione**, ma il peso delle altre 5 fonti indipendenti (enumerazione API, HF org search, descrizione OpenRouter esplicita "proprietary/API-only", fonte ufficiale Qwen, blog con citazione datata e dettagliata) converge fermamente su "non ancora rilasciato". `[DISCREPANZA minore, non risolta, ma bilancio delle fonti netto verso "non rilasciato"]`

### Nota adiacente non richiesta ma rilevante per il rischio-licenza dei modelli cinesi open-weight

Un commentatore della community (citato da `techtimes.com`, non verificato sulla fonte Alibaba) ha sollevato il dubbio che i termini della licenza Qwen3.8-Max **preview** sembrino escludere USA/EU/UK/Corea dal download — ma **la licenza open-weight definitiva non è stata ancora pubblicata**, quindi il claim resta `[NON VERIFICATO]` per Qwen specificamente. È però confermato, nella stessa finestra temporale, che un modello concorrente cinese — **MiniMax H3** (rilasciato 2026-08-04) — ha una "Community License Agreement" che **esclude esplicitamente Stati Uniti, Unione Europea, Regno Unito e Corea del Sud** dal perimetro di utilizzo lecito, anche per pesi eseguiti localmente. `[TRIANGOLATO — techtimes.com, citando i termini di licenza MiniMax H3]` Questo è un pattern emergente da monitorare per qualunque futura adozione di modelli open-weight di origine cinese in UE — **non risulta applicarsi**, allo stato attuale verificato, a Qwen3.5/3.6/GLM/DeepSeek (che restano Apache 2.0/MIT senza restrizioni geografiche dichiarate, come da A5 §1.5), ma è un rischio strutturale nuovo da ri-controllare a ogni nuovo rilascio.

### Cosa c'è di più vicino nella famiglia Qwen, oggi, in taglia 20-40B

Vedi tabella completa in §2. In sintesi: **Qwen3.5-27B, Qwen3.6-27B** (dense, 27B) e **Qwen3.5-35B-A3B, Qwen3.6-35B-A3B** (MoE, 35B totali/3B attivi) sono le release più recenti, effettivamente aperte (Apache 2.0, `hugging_face_id` popolato, multi-provider su OpenRouter) e nella fascia dimensionale richiesta dall'owner. Sono la generazione **immediatamente precedente** a 3.7/3.8 (che restano closed-weight per le taglie Max/Plus/Flash), non la stessa generazione del modello nominato ("Qwen 3.8").

---

## 2. Candidati open-weight 20-40B su OpenRouter (Mandato 2)

Tutti i dati sotto vengono dal JSON `/api/v1/models` `[VERIFICATO]` salvo dove diversamente indicato. "Tool calling nativo" = presenza di `tools`/`tool_choice` in `supported_parameters` (dichiarato da OpenRouter, non ri-testato empiricamente in questa sessione — è il dato che il mandato chiede di riportare, non un'eval). "Structured output" = presenza di `structured_outputs` o `response_format`. Licenza verificata via ricerca incrociata (colonna fonte separata sotto la tabella per i casi non ovvi).

| Modello (slug OpenRouter) | Parametri tot/attivi | Arch. | Licenza | Context | Max output | Prezzo in/out per Mtok | Tool calling | Structured output | Vision nativa |
|---|---|---|---|---|---|---|---|---|---|
| `qwen/qwen3.5-27b` | 27B / — (dense) | Dense | Apache 2.0 | 262K | 65.5K | $0.195 / $1.56 | Sì | Sì | **Sì** (image+video) |
| `qwen/qwen3.6-27b` | 27B / — (dense) | Dense | Apache 2.0 | 262K | 131K | $0.289 / $2.40 | Sì | Sì | **Sì** (image+video) |
| `qwen/qwen3.5-35b-a3b` | 35B tot / 3B attivi | MoE (hybrid linear-attn + sparse) | Apache 2.0 | 262K | 262K | $0.14 / $1.00 | Sì | Sì | **Sì** (image+video) |
| `qwen/qwen3.6-35b-a3b` | 35B tot / 3B attivi | MoE (Gated DeltaNet + gated attn) | Apache 2.0 | 262K | 262K | $0.14 / $1.00 | Sì | Sì | **Sì** (image+video) |
| `qwen/qwen3-32b` | 32.8B (dense) | Dense | Apache 2.0 | 131K | 16.4K | $0.08 / $0.28 | Sì | Sì | No (solo testo) |
| `qwen/qwen3-coder-30b-a3b-instruct` | 30.5B tot / 3B attivi (128 esperti, 8 attivi/pass) | MoE | Apache 2.0 | 262K | 32.8K | $0.07 / $0.27 | Sì | Sì | No |
| `qwen/qwen3-30b-a3b-instruct-2507` | 30.5B tot / 3.3B attivi | MoE | Apache 2.0 | 262K | 32K | $0.048 / $0.193 | Sì | Sì | No |
| `qwen/qwen3-vl-32b-instruct` | 32B (dense) | Dense | Apache 2.0 | 131K | 32.8K | $0.104 / $0.416 | Sì | Sì | **Sì** (nativa, immagine+video) |
| `qwen/qwen3-vl-30b-a3b-instruct` | 30B tot / 3B attivi | MoE | Apache 2.0 | 262K | 16.4K | $0.15 / $0.60 | Sì | Sì | **Sì** (nativa) |
| `qwen/qwen3-vl-30b-a3b-thinking` | 30B tot / 3B attivi | MoE | Apache 2.0 | 262K | 32.8K | $0.20 / $2.40 | Sì | Sì | **Sì** (nativa) |
| `openai/gpt-oss-20b` | 21B tot / 3.6B attivi | MoE | Apache 2.0 | 131K | 131K | $0.03 / $0.13 | Sì (reasoning obbligatorio, formato "harmony" — caveat già in `06-modelli.md`) | Sì | No |
| `google/gemma-4-26b-a4b-it` | 25.2B tot / 3.8B attivi — **incumbent Muffin** | MoE | Apache 2.0 | 262K | 16.4K | $0.07 / $0.34 | Sì | Sì | **Sì** (image+video) |
| `google/gemma-4-31b-it` | 30.7B (dense) | Dense | Apache 2.0 | 262K | 262K | $0.10 / $0.34 | Sì | Sì | **Sì** (image+video) |
| `google/gemma-3-27b-it` | 27B (dense) | Dense | **Gemma ToU (custom, NON Apache)** — Gemma 3 precede lo switch ad Apache 2.0 avvenuto con Gemma 4 (A5 §1.6) | 262K (128K dichiarati nella descrizione) | 131K | $0.08 / $0.45 | Sì | Sì | Sì (image, no video) |
| `mistralai/mistral-small-3.2-24b-instruct` | 24B (dense) | Dense | Apache 2.0 | 256K | 16.4K | $0.075 / $0.20 | Sì | Sì | Sì (image) |
| `mistralai/voxtral-small-24b-2507` | 24B (dense, derivato da Mistral Small 3) | Dense | Apache 2.0 | 32K | n/d | $0.10 / $0.30 (+ audio, vedi §4) | Sì | Sì | No (audio, non immagine — vedi §3/§4) |
| `nvidia/nemotron-3-nano-30b-a3b` | 30B tot / 3B attivi | MoE | **NVIDIA Open Model License** (non Apache/MIT) | 262K | 262K | $0.05 / $0.20 | Sì | Sì | No |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` | 30B tot / 3B attivi | MoE | NVIDIA Open Model License | 256K | 65.5K | gratuito (`:free`) | Sì | **No** (assente da `supported_parameters`) | **Sì, omni**: image+audio+video (vedi §3) |
| `z-ai/glm-4.7-flash` | ~30-31B tot / ~3B attivi | MoE | MIT | 203K | 16.4K | $0.06 / $0.40 | Sì | Sì | No — **RIGETTATO su harness Muffin** (§5.2) |
| `allenai/olmo-3-32b-think` | 32B (dense) | Dense | Apache 2.0 (pesi **+ dati di training + codice**, tutto aperto) | 65.5K | 65.5K | $0.15 / $0.50 | **No** (assente da `supported_parameters`) | Sì | No |

**Nota fuori-banda ma spesso citato insieme a questi**: `z-ai/glm-4.5-air` ha licenza MIT e viene descritto come "variante leggera" della famiglia GLM, ma i suoi **106B parametri totali (12B attivi)** superano nettamente il tetto di 40B richiesto — footprint di caricamento non compatibile con l'inquadramento "gira su hardware consumer" anche se il calcolo per-token è leggero. In tabella per completezza, non come candidato primario: $0.13/$0.85 per Mtok, 131K context, tool calling sì, **structured output NO** (assente da `supported_parameters` — a differenza di GLM-4.7-Flash che invece lo espone).

### 2.1 Verifica licenze (dove non ovvio)

- **Mistral Small 3.2 / Voxtral**: Apache 2.0 confermato — Voxtral è esplicitamente descritto come "Voxtral è un potenziamento di Mistral Small 3" e condivide la stessa licenza. `[TRIANGOLATO — mistral.ai/news/voxtral, huggingface.co/mistralai/Voxtral-Small-24B-2507]`
- **NVIDIA Nemotron 3 Nano (incl. Omni)**: **NVIDIA Nemotron Open Model License**, non Apache/MIT — descritta da una fonte come "commercial use permesso in modo simile alla licenza Llama di Meta" (cioè permissiva ma non OSI-standard). `[TRIANGOLATO]`
- **GLM-4.5-Air / GLM-4.7-Flash**: MIT, confermato via GitHub del progetto (`github.com/zai-org/GLM-4.5`) e HF model card. `[TRIANGOLATO]`
- **AllenAI OLMo-3-32B**: Apache 2.0 per pesi, dataset di training (Dolma 3) e codice — AllenAI lo posiziona esplicitamente come "fully open" (differenzia dalla maggior parte degli "open-weight" che non pubblicano i dati). `[TRIANGOLATO — huggingface.co/allenai/Olmo-3-7B-Think README (license: apache-2.0), freeapihub.com]`. **Assenza di tool calling nei `supported_parameters`** è un dato strutturale coerente col posizionamento "reasoning/instruction-following", non un errore di scheda.
- **Qwen3-VL** (famiglia): Apache 2.0 confermato via file `LICENSE` nel repo `QwenLM/Qwen3-VL` su GitHub. `[TRIANGOLATO]`

### 2.2 Osservazioni strutturali dal dataset OpenRouter completo (338 modelli)

- **Nessun modello InternVL, LLaVA, Pixtral o Kimi-VL risulta attualmente nel catalogo OpenRouter** (ricerca per keyword sull'intero JSON, esito negativo) — nominati esplicitamente nel mandato come candidati multimodali storici, ma **non presenti/non trovati sull'aggregatore alla data di rilevazione**. `[VERIFICATO come assenza dal dataset, non conferma che i modelli non esistano altrove — Pixtral e InternVL hanno release note e pesi pubblici su HuggingFace indipendentemente da OpenRouter]`
- L'incumbent Muffin (`google/gemma-4-26b-a4b-it`, da `project_llm_stack.md`) risulta **già nativamente multimodale (image+video) sullo stesso endpoint OpenRouter già cablato** per testo — non è un modello separato da aggiungere, è una capability già presente sul path esistente secondo il catalogo. Non verificato in questa sessione se il codice Muffin la instrada già o la ignora (fuori scope: quello è un fatto sul codice, non sul catalogo).
- **Punto dolce dimensionale confermato**: la fascia "30B totali / 3B attivi" (Qwen3.5/3.6-35B-A3B, Qwen3-30B-A3B*, Qwen3-VL-30B-A3B*, NVIDIA Nemotron-3-Nano-30B-A3B, GLM-4.7-Flash) è oggi il pattern architetturale più popolato nel catalogo tra i candidati 20-40B — coerente con quanto già osservato in A5 §3.1 sull'hardware (MoE 3B-attivi ≈ velocità di un dense 3-4B).

---

## 3. Multimodale — input (Mandato 3)

### 3.1 Frontier API: modalità e prezzi per-modalità (asse che A5 non copriva)

**Anthropic (Claude)** — fonte ufficiale diretta `platform.claude.com/docs/en/build-with-claude/vision` + `.../pricing`, fetch 2026-08-04. `[VERIFICATO]`
- Modalità accettate: **testo + immagine + file** (PDF). **Nessun input/output audio nativo**, confermato sia dall'assenza totale del tema nella pagina pricing ufficiale, sia da una verifica incrociata: *"Claude models accept text and image input only... Claude voice mode now supports Opus 5, Sonnet 5, and Haiku 4.5 [ma] still listens, pauses to process, and replies in turns rather than using continuous interruptible audio"* — cioè la "voice mode" è uno strato prodotto STT→testo→Claude→TTS, non comprensione audio nativa del modello. `[TRIANGOLATO]`
- Formula di tokenizzazione immagine, **esplicita e citata testualmente**: *"Claude views images in patches instead of pixels. Each patch is a 28×28-pixel block... An image costs ⌈width/28⌉ × ⌈height/28⌉ visual tokens."* Due tier di risoluzione: standard (max 1568px lato lungo / 1568 token) e high-res (Claude 4.7+, max 2576px / 4784 token). Esempi di costo ufficiali: immagine 1000×1000px = 1296 token → **~$1.30 ogni 1000 immagini** su Haiku 4.5 ($1/Mtok), **~$6.48 ogni 1000 immagini** su Opus 5 tier high-res ($5/Mtok), immagine 4K fino a **~$23.92 ogni 1000 immagini** su Opus 5.
- Nessun costo per-immagine separato: il costo immagine è puro token-count sul prezzo di input del modello, nessuna riga di pricing dedicata a "vision" nella tabella modelli.

**OpenAI (GPT)** — fonte ufficiale `developers.openai.com/api/docs/pricing`, fetch 2026-08-04. `[VERIFICATO]`
- La famiglia GPT-5.x accetta **testo + immagine + file**; alcune varianti codex-oriented (`gpt-5.1-codex`, `gpt-5.2-codex`) solo testo+immagine senza file.
- **Audio è servito da modelli separati, non dalla famiglia di chat generica**: `gpt-audio-1.5` ($32/Mtok audio in, $64/Mtok audio out), `gpt-realtime-2.1` ($32/Mtok audio in, $0.40 cache, $64/Mtok audio out; variante testo pura $4/$24), `gpt-realtime-2.1-mini` ($10/$20 audio), `gpt-audio-mini` ($10/$20 audio) — tutti confermati sia dal JSON OpenRouter sia dalla pagina ufficiale.
- **Generazione immagine** (non solo comprensione) via endpoint dedicati: `gpt-5-image`/`gpt-5-image-mini`/`gpt-4o-image` con costo per immagine di output ($0.00004–$0.00004 per immagine a seconda della variante, cifre come "image_output" nel JSON).

**Google (Gemini)** — fonte ufficiale `ai.google.dev/gemini-api/docs/pricing`, fetch 2026-08-04, **cross-validato riga per riga con il JSON OpenRouter indipendente** (stessi numeri su modelli sovrapposti — doppia conferma). `[VERIFICATO]`
- È il **solo frontier** tra i tre con modalità **testo + immagine + audio + video + file** native sulla stessa famiglia di modelli generalisti (non serve un endpoint audio separato come OpenAI).
- Pricing per-modalità **esplicito e variabile per modello/tier** (tutti $/Mtok, non per-unità):

| Modello | Testo in | Immagine in | Audio in | Rapporto audio/immagine |
|---|---|---|---|---|
| Gemini 2.5 Flash-Lite | $0.10 | $0.10 | $0.30 | 3× |
| Gemini 2.5 Flash | $0.30 | $0.30 | $1.00 | 3.3× |
| Gemini 2.5 Pro (≤200K) | $1.25 | $1.25 | $1.25 | 1× (stesso prezzo) |
| Gemini 3.1 Flash-Lite | $0.25 | $0.25 | $0.50 | 2× |
| Gemini 3.5 Flash | $1.50 | $1.50 | $3.00 | 2× |
| Gemini 3.6 Flash | $1.50 | $1.50 | $1.50 | 1× |
| Gemini 3.1 Pro Preview (base) | $2.00 | $2.00 | $2.00 | 1× |

Nessuna regola unica "audio = Nx immagine" — varia per modello, da 1× a 3.3× nei dati raccolti. `[VERIFICATO su tabella ufficiale + JSON]`
- **Tokenizzazione audio dichiarata**: *"Billing is based on total input and output audio token consumption, calculated at a rate of 25 tokens per second of audio"* — dichiarazione trovata nella sezione "Gemini 3.5 Live Translate" della pagina ufficiale; **non ho verificato se la stessa cifra esatta (25 tok/s) si applichi identicamente all'audio-input "batch" sui modelli generalisti (2.5/3.x Pro/Flash) o solo al prodotto Live Translate** `[NON VERIFICATO per generalizzazione completa]`. Usando 25 tok/s come riferimento illustrativo (90.000 token/ora): un'ora di audio costerebbe indicativamente **~$0.045/h su 3.1 Flash-Lite**, **~$0.09/h su 2.5 Flash**, **~$0.1125/h su 2.5 Pro** — tutte cifre puramente aritmetiche su un tasso di tokenizzazione non confermato per questo caso d'uso specifico, riportate come ordine di grandezza, non come prezzo ufficiale per-ora.
- **Live API con audio nativo** (conversazione audio-a-audio in tempo reale, non solo audio-in→testo-out) ha pricing dedicato molto più alto: es. Gemini 2.5 Flash Native Audio Live API **$0.50 input testo / $3.00 input audio-video, $2.00 output testo / $12.00 output audio** — l'output audio costa **6× l'output testo**. `[VERIFICATO dalla pagina ufficiale]`
- Immagine come **output** (generazione, non comprensione) ha una riga di pricing propria e separata (`image_output`), es. Gemini 3.1 Flash Image $0.00006/immagine, esempio ufficiale citato: immagine 1K-risoluzione = 1120 token = **$0.0336/immagine** su un modello di generazione.

### 3.2 Open-weight multimodali: taglie, licenza, esecuzione locale

| Famiglia | Taglie con vision | Licenza | Locale? |
|---|---|---|---|
| **Qwen3-VL** | 8B, 30B-A3B (MoE), 32B (dense), 235B-A22B (MoE) | Apache 2.0 | Sì, dichiarato supportato da llama.cpp/vLLM/Ollama nella documentazione del progetto (non testato hands-on in questa sessione) |
| **Qwen3.5 / Qwen3.6** (intera famiglia, non solo la linea "-VL") | 9B fino a 397B-A17B, inclusi i 27B dense e 35B-A3B MoE | Apache 2.0 | Stesso ecosistema Qwen3, presumibilmente supportato ma **non verificato per la vision nello specifico** in questa sessione — il supporto testo/tool è consolidato, il supporto GGUF per gli input immagine+video di questi modelli specifici non è stato verificato hands-on |
| **Gemma 4** (12B/26B-A4B/31B) | Tutta la famiglia da Gemma 4 in su è multimodale immagine+video (12B anche **audio nativo**, incl. non solo vision) | Apache 2.0 | **Sì per testo/vision, MA con caveat pesante sull'audio**: da indagine interna già fatta (2026-06-17, non ri-eseguita qui) — supporto audio in llama.cpp mergeto solo 2 settimane prima della rilevazione, bug crash aperti su Ollama, hands-on riportava looping/allucinazioni/5m35s per una clip di 9s. Verdetto di quella sessione: "stack non pronto", da ri-testare quando runtime matura |
| **NVIDIA Nemotron 3 Nano Omni** | 30B-A3B, **omni**: testo+immagine+audio+video→testo in un solo modello | NVIDIA Open Model License | Dichiarato self-hostabile (guide "Deploy on GPU Cloud" trovate), non testato in questa sessione |
| **Llama 4** (Scout/Maverick) | Scout 109B tot/17B attivi, Maverick taglia analoga | Licenza Llama (custom, non Apache) | Fuori dalla fascia 20-40B richiesta (total > 40B anche se attivi sono pochi) — citato solo per completezza, non è un candidato per questo mandato |
| **Kimi K3** | 2.8T tot (da A5), vision inclusa | Modified MIT (da A5) | Fuori fascia dimensionale, stesso motivo di Llama 4 |
| **InternVL, LLaVA, Pixtral, Kimi-VL** | — | — | **Non trovati sul catalogo OpenRouter in questa sessione** (§2.2) — esistono come pesi pubblici su HuggingFace indipendentemente, ma non ho verificato hands-on la loro maturità/dimensioni aggiornate in questa sessione: `[NON VERIFICATO, fuori tempo/scope di questa sessione]` |

### 3.3 OpenRouter: come si passano immagini/audio/file (meccanica API)

Confermato via ricerca sulla documentazione ufficiale OpenRouter `[TRIANGOLATO]`: tutte le modalità passano dallo **stesso endpoint** `/api/v1/chat/completions`, differenziate solo dal `content type` nel messaggio, con la stessa sintassi del formato OpenAI:
- Immagini: content block `image_url`, sia URL diretto sia base64.
- File (PDF): content block dedicato, stessa idea.
- Audio: content block `input_audio` con campo `data` (**solo base64, non URL diretto**) e `format` esplicito (WAV/MP3/FLAC/altri comuni).
- Solo i modelli il cui `architecture.input_modalities` dichiara la modalità accettano il rispettivo content block — inviarlo a un modello non compatibile fallisce (non viene silenziosamente ignorato o convertito).

Dal JSON completo: **135 dei 338 modelli** del catalogo dichiarano almeno una modalità oltre testo+immagine (audio, video o file) in input — la maggioranza sono varianti frontier (OpenAI/Anthropic/Google/xAI con "file" per i PDF), un sottoinsieme più piccolo ha audio nativo: `google/gemini-*` (quasi tutta la famiglia 2.5+), `openai/gpt-audio*`, `mistralai/voxtral-small-24b-2507`, `nvidia/nemotron-3-nano-omni-30b-a3b*`, più alcuni modelli minori/sperimentali (`thinkingmachines/inkling*`, `xiaomi/mimo-v2.5`).

**Nota strutturale**: OpenRouter ha anche una **superficie API separata per ASR/TTS puri** (blog ufficiale "New Audio APIs for Speech and Transcription", trovato via ricerca ma non fetchato integralmente), che **non compare nell'endpoint generale `/models`** usato per questa analisi — `deepgram/nova-3` (release 2026-07-15, "from $0.0043/minute") e i modelli `qwen-audio-3.0-tts-*`/`qwen3-asr-flash-*` (visti solo via scraping della pagina `openrouter.ai/qwen`, prezzi $15-20/M caratteri per TTS e ~$0.000035/secondo per ASR) vivono lì. `[FONTE SINGOLA scraping per i prezzi Qwen ASR/TTS specifici, non confermati sul JSON strutturato]`

---

## 4. Trascrizione audio: stato dell'arte (Mandato 4)

### 4.1 Tabella prezzi (per ora di audio, normalizzato)

| Servizio | Prezzo pubblicato | Prezzo/ora normalizzato | Fonte | WER generale (non IT) |
|---|---|---|---|---|
| OpenAI **gpt-transcribe** (nuovo, dal 28/7/2026, ora raccomandato da OpenAI al posto di Whisper) | $0.0045/min | **$0.27/h** | `developers.openai.com/api/docs/pricing`, fetch diretto `[VERIFICATO]` | non pubblicato separatamente da OpenAI in questa sessione |
| OpenAI **gpt-4o-transcribe** | $2.50/$10 per Mtok, "~$0.006/min" | **~$0.36/h** | stessa fonte `[VERIFICATO]` | 4.0% (AA-WER, vedi §4.2) |
| OpenAI **gpt-4o-mini-transcribe** | $1.25/$5 per Mtok, "~$0.003/min" | **~$0.18/h** | stessa fonte `[VERIFICATO]` | non isolato |
| OpenAI **whisper-1** (legacy) | $0.006/min | **$0.36/h** | stessa fonte `[VERIFICATO]` | — |
| OpenAI **gpt-live-transcribe** (streaming) | $0.017/min | **$1.02/h** | stessa fonte `[VERIFICATO]` | — |
| **Deepgram Nova-3** (batch, monolingua) | $0.0043/min | **~$0.26/h** | aggregatori `convertaudiototext.com`, `diyai.io` — anche listato su OpenRouter dal 2026-07-15 | 5.2% (AA-WER) |
| **Deepgram Nova-3** (streaming/multilingua) | $0.0077–$0.0092/min | **$0.46–$0.55/h** | stessa famiglia di fonti — **range ampio a seconda di batch/streaming/mono/multi**, non un prezzo unico `[TRIANGOLATO ma internamente eterogeneo]` | — |
| **ElevenLabs Scribe** (standard) | $0.22/h dichiarato | **$0.22/h** | `cekura.ai`, ridotto "fino al 45%" in un aggiornamento recente `[TRIANGOLATO]` | italiano: "Excellent, ≤5% WER" (tier, non cifra esatta) — vedi §4.3 |
| **ElevenLabs Scribe realtime** | $0.39/h | **$0.39/h** | stessa fonte | — |
| **Mistral Voxtral Small 24B** (via OpenRouter, endpoint chat multimodale, non ASR dedicato) | $0.0001/unità audio (JSON ufficiale OpenRouter) | **Unità non dichiarata esplicitamente**: se per-token a ~12.5-25 tok/s tipici per encoder audio, indicativamente **$4-9/h** — `[NON VERIFICATO con precisione, ordine di grandezza stimato]` | `openrouter.ai/api/v1/models` `[VERIFICATO il numero grezzo, NON VERIFICATA l'unità]` | 2.8% (Voxtral Small) / 3.6% (Voxtral Mini Transcribe 2) su AA-WER |
| **Gemini** (audio-in su modello generalista, non ASR dedicato) | $0.25-$3.00/Mtok audio a seconda di modello/tier (§3.1) | Illustrativo (25 tok/s non confermato per questo caso): **~$0.045-0.27/h** a seconda del tier | `ai.google.dev/gemini-api/docs/pricing` `[VERIFICATO i $/Mtok, NON VERIFICATA la generalizzazione del tasso 25 tok/s]` | non pubblicato per ASR puro |
| **Qwen3-ASR-Flash** (endpoint dedicato, non nel JSON generale) | ~$0.000035/secondo (da pagina scrapeata) | **~$0.126/h** | scraping `openrouter.ai/qwen` `[FONTE SINGOLA, non in JSON]` | non pubblicato |

### 4.2 WER pubblicati (generale, non isolato per italiano)

Fonte: **Artificial Analysis, leaderboard speech-to-text**, fetch diretto 2026-08-04. Metrica "AA-WER" definita esplicitamente dalla fonte come *"un audio-duration-weighted average di WER su ~8 ore da tre dataset: AA-AgentTalk (50%), VoxPopuli-Cleaned-AA (25%), e Earnings22-Cleaned-AA (25%)"* — **dataset a prevalenza inglese/multilingue generica, non uno split per lingua pubblicato su questa pagina**. `[VERIFICATO per i numeri, NON VERIFICATO se esiste uno split italiano su questo specifico leaderboard]`

| Modello | AA-WER |
|---|---|
| ElevenLabs Scribe v2 | **2.2%** (il migliore nella lista raccolta) |
| Voxtral Small (Mistral) | 2.8% |
| Voxtral Mini Transcribe 2 (Mistral) | 3.6% |
| GPT-4o Transcribe (OpenAI) | 4.0% |
| Whisper Large v3 (hosting fal.ai) | 4.1% |
| Canary Qwen 2.5B (NVIDIA, hosting Replicate) | 4.3% |
| Parakeet TDT 0.6B V3 (NVIDIA, hosting Together AI) | 4.5% |
| Whisper Large v3 Turbo (hosting Groq) | 4.6% |
| Deepgram Nova-3 | 5.2% |

### 4.3 WER pubblicati **specificamente sull'italiano**

Questo è l'unico dato trovato in questa sessione con framing esplicito sull'italiano da una fonte ufficiale del vendor:
- **ElevenLabs, pagina documentazione ufficiale** (`elevenlabs.io/docs/overview/capabilities/speech-to-text`, fetch diretto 2026-08-04) `[VERIFICATO]`: la metrica è esplicitamente **WER** (non accuratezza) e l'italiano ("ita") è classificato nel tier **"Excellent (≤ 5% WER)"** — **una fascia, non una cifra puntuale**. Una fonte più vecchia (VentureBeat, relativa alla precedente Scribe v1, 2025) citava **"98.7%" per l'italiano su benchmark FLEURS/Common Voice** — ma quella cifra ha framing di **accuratezza** (1−WER), non WER diretto, e si riferisce a un modello (Scribe v1) ora deprecato e sostituito da Scribe v2. Le due fonti non sono direttamente comparabili per via del framing diverso (WER vs accuratezza) e della versione diversa del modello. `[DISCREPANZA di framing, non di fatto — nessun numero WER puntuale e aggiornato per l'italiano trovato per Scribe v2]`
- **Mistral Voxtral**: il blog ufficiale (`mistral.ai/news/voxtral`) dichiara che *"su Mozilla Common Voice 15.1 e il corpus FLEURS, Voxtral Small supera Whisper large-v3 in tutte le lingue testate"* e che l'italiano è tra le 13 lingue coperte esplicitamente — **ma non ho trovato la cifra numerica esatta per l'italiano** nel contenuto raggiunto in questa sessione (il paper arXiv 2507.13264 probabilmente la contiene, non l'ho aperto pagina-per-pagina). `[NON VERIFICATO il numero esatto, verificata solo l'affermazione qualitativa "supera Whisper su IT"]`
- **NVIDIA Parakeet/Canary**: Parakeet-TDT-0.6B-v3 (agosto 2025) dichiarato esteso a 25 lingue europee incluso l'italiano; Canary-1b-v2 su licenza CC-BY-4.0. **Nessuna cifra WER italiana isolata trovata** in questa sessione, solo la dichiarazione di copertura linguistica. `[NON VERIFICATO il numero]`
- **Whisper, Deepgram, Gemini, GPT-4o-transcribe, Qwen3-ASR**: **nessuna cifra WER pubblicata specificamente per l'italiano trovata in questa sessione** per nessuno di questi. Questo è un gap esplicito, coerente col pattern già osservato per l'italiano nel resto del report (§5): l'ecosistema di benchmark pubblici privilegia l'inglese o metriche multilingue aggregate, l'italiano isolato è raro.

### 4.4 Locale: velocità reale (RTF) — decidere se trascrivere in locale o via API

Fonte: ricerca aggregata su più blog di benchmark 2026, **nessuna fonte di laboratorio indipendente con metodologia uniforme pubblicata** — trattare come ordine di grandezza. `[TRIANGOLATO su più fonti concordi sull'ordine di grandezza, non su cifre esatte]`

- **Apple Silicon con accelerazione Metal** (faster-whisper/whisper.cpp, large-v3): RTF riportati tra **~0.3-1.0×** (M1) e **fino a ~2.5-3×** più veloce del tempo reale su M2 Pro/M3/M4 con Metal — cioè trascrivere un'ora di audio richiede indicativamente da ~20 minuti a ~1 ora a seconda del chip, sempre con GPU/Metal attivo.
- **CPU pura, nessuna accelerazione GPU** (rilevante per il caso VPS Hetzner CX23 di Muffin, 2vCPU, CPU-only, citato in memoria interna): large-v3 su CPU riportato a **3-6× più lento del tempo reale** — un'ora di audio richiederebbe indicativamente 3-6 ore di calcolo. Questo è **proibitivo** per un uso conversazionale/quasi-realtime su un VPS CPU-only della classe attuale di Muffin.
- Non ho trovato in questa sessione un benchmark RTF specifico per **faster-whisper "small"/"medium"** (varianti più leggere, spesso usate proprio per compensare l'assenza di GPU) su CPU — solo per large-v3. `[GAP ESPLICITO — non verificato]`
- **Lettura per la decisione locale-vs-API (solo fatti, nessun verdetto)**: su hardware con GPU/Metal (Mac dev), la trascrizione locale è già oggi più veloce del tempo reale con Whisper large-v3. Su un VPS CPU-only come quello di produzione attuale, la stessa configurazione è nell'ordine di 3-6× più lenta del tempo reale — la soglia di usabilità dipende quindi interamente da *dove* gira il processo, non dal modello in sé.

---

## 5. Italiano: benchmark pubblicati per i modelli 20-40B e i frontier (Mandato 5)

**Finding principale: esiste un ecosistema accademico di benchmark italiani, ma non ho trovato in questa sessione punteggi aggiornati (agosto 2026) su di esso per nessuno dei candidati concreti elencati in §2** (Gemma-4-26b-a4b, Qwen3.5/3.6-27B o -35B-A3B, GPT-OSS-20b, GLM-4.7-Flash). Questo è un gap di dato, non necessariamente di esistenza — ma è il gap rilevante per la decisione.

### 5.1 Cosa esiste (infrastruttura di ricerca reale, verificata)

- **EVALITA**: campagna di valutazione periodica per NLP/speech italiano, alla **9ª edizione nel 2026** (`apa.dipsco.unitn.it/evalita2026`, `ilc.cnr.it`), organizzata da AILC. Include task nuovi 2026 come "crossword solving in italiano" e "selective verification of unlearning in LLM" — quindi è viva e si aggiorna, ma è orientata a task specifici di ricerca/gara, non a un leaderboard generico di modelli commerciali aggiornato in tempo reale. `[VERIFICATO che la campagna esiste ed è attiva nel 2026]`
- **ITA-Bench** (Sapienza NLP, `github.com/SapienzaNLP/ita-bench`): collezione di benchmark italiani per LLM — question answering, commonsense reasoning, matematica, NER — che riusa risorse italiane esistenti (MMLU-PROX, IFEval-ITA) e traduce il resto con un modello open-source. `[VERIFICATO esistenza del repo]`, non verificato se contiene già score per i modelli di §2.
- **ITALIC**: benchmark citato in un paper recente (arXiv 2605.07731, maggio 2026) che confronta modelli italiani dedicati (FastwebMIIA-7B, Minerva-7B, Velvet-14B, LLaMAntino-3-ANITA-8B) con un modello MoE 16B-A3B italiano (EngGPT2MoE, di Engineering Ingegneria Informatica S.p.A.) — **nessuno dei modelli del mandato B2 (Qwen, Gemma, GPT-OSS, GLM) è incluso in questo confronto specifico**. `[VERIFICATO il contenuto del paper, VERIFICATO che i nostri candidati non ci sono]`
- **Open Ita LLM Leaderboard** (Hugging Face Space, due fork: `mii-llm` e `FinancialSupport`): leaderboard pubblico filtrable per modelli italiani. **Non sono riuscito a leggere lo stato/i dati correnti** in questa sessione — la pagina Gradio non ha esposto contenuto tabellare al fetch (mostrava solo lo stato di caricamento). `[NON VERIFICATO — impossibile confermare se aggiornato o stale per i modelli 2026]`
- **MMLU-PRO-ITA** (`huggingface.co/blog/giux78/mmlu-pro-ita`): traduzione italiana di MMLU-Pro fatta con Claude Opus (tecnica draft-and-refine). **Pubblicato luglio 2024**, modelli valutati sono tutti pre-2026 e di taglia piccola (Phi-3-medium, Llama-3-8B-Ita, mii-llm/maestrale) — **nessuna sovrapposizione con i candidati attuali**. `[VERIFICATO — dato stale rispetto al mandato]`
- **MMMLU** (OpenAI, traduzione professionale di MMLU in 14 lingue incluso l'italiano): **Qwen3.5-397B-A17B risulta il miglior modello open-source sul leaderboard MMMLU con 0.885** — ma (a) è il modello da 397B, fuori dalla fascia 20-40B del mandato, e (b) **non ho verificato se 0.885 sia lo split italiano specifico o una media sulle 14 lingue** — ambiguità non risolta in questa sessione. `[NON VERIFICATO su questo punto specifico]`

### 5.2 Il dato più solido e decisionale che esiste, ed è interno a Muffin

Il singolo confronto più rilevante trovato — perché reale, misurato, e su un candidato di questo stesso mandato — **non è un benchmark pubblico ma un eval interno Muffin già eseguito** (2026-06-13, citato non ri-derivato): **Gemma-4-26b-a4b batte GLM-4.7-Flash sull'italiano** con giudice pairwise cieco (Claude Sonnet come giudice): Gemma 3.89/5 (vince 7/9 confronti) vs GLM 2.89/5 (vince 2/9), con GLM che mostra "language-drift" (1/9 casi, es. spiega un concetto tecnico con "sotto-matrice di esperti in stile mafia parallela" — italiano rotto/tradotto). Questo eval usa fixture proprie di Muffin, non un benchmark pubblico standardizzato, e copre solo 2 dei tanti candidati di §2 (non Qwen3.5/3.6, non GPT-OSS-20b, non i modelli frontier).

**Conclusione del mandato, esplicita**: non esiste, verificato in questa sessione, un benchmark pubblico solido e aggiornato che collochi i candidati concreti (Gemma-4, Qwen3.5/3.6, GPT-OSS-20b) su una scala di qualità italiana comparabile. L'ecosistema accademico italiano (EVALITA, ITA-Bench, ITALIC) esiste ed è attivo, ma o non copre questi modelli specifici o non sono riuscito a estrarne dati aggiornati in questa sessione. Questo è coerente con quanto già osservato per l'embedding in `06-modelli.md` §5 ("Nessun numero pubblico affidabile per l'italiano su nessun candidato") — sembra un pattern strutturale del campo, non un caso isolato.

---

## 6. Prompt in che lingua? Evidenza sull'effetto misurato (Mandato 6)

**Finding principale: non ho trovato, in questa sessione, uno studio controllato che isoli esattamente la variabile richiesta** (system prompt in inglese vs nella lingua target, a parità di compito e di lingua di output) **con numeri riproducibili**. Quello che esiste è per lo più (a) evidenza su una variabile adiacente ma diversa — la lingua del *contenuto del task* (non del prompt/istruzione) — oppure (b) blog tecnici che citano altri studi senza riprodurli.

### 6.1 Cosa NON regge alla verifica avversariale (esplicitamente controllato in questa sessione)

Tre fonti citate ripetutamente da blog secondari sono state aperte direttamente e verificate:
- **`tianpan.co` (blog "Your System Prompts Are Still in English")**: alla lettura diretta, **non presenta misure sperimentali dirette** sul confronto prompt-EN-vs-nativo. Cita benchmark di terzi (es. "MMLU-ProX... gap fino a 38 punti tra inglese e swahili") ma quelli misurano *capacità multilingue generale del modello sul contenuto*, non l'effetto della lingua del *system prompt* a parità di tutto il resto. Le affermazioni sulla tokenizzazione ("2-15× più token") citano un post HuggingFace senza riprodurlo. `[VERIFICATO CHE NON CONTIENE MISURE DIRETTE — è un pezzo di opinione/advocacy, non ricerca]`
- **`polyfactor.io` ("Does Prompt Language Matter? The 2026 Data")**: nonostante il titolo suggerisca dati originali, il contenuto raggiunto cita numeri di terzi (GPT-4 su MMLU tradotto: 86% EN, 83% DE, 80% ZH — un test del **2023** su una variabile diversa, la lingua del *contenuto*) e uno studio Lilt 2026 su *editing* (non prompt) dove il tedesco batte l'inglese (53.66% vs 46.34%). **Nessun confronto diretto "stesso task, system prompt EN vs system prompt IT, output atteso in IT"** è presente. `[VERIFICATO CHE NON CONTIENE LA MISURA SPECIFICA RICHIESTA]`
- **Paper accademico `arXiv:2412.08392` ("The Roles of English in Evaluating Multilingual LMs")**: è dichiaratamente un **position paper**, non uno studio empirico originale — riassume risultati di altri (Zhang et al. 2023, Shi et al. 2022, Etxaniz et al. 2024) che mostrano "performance migliore quando il task è presentato in inglese", ma **non fornisce deltas numerici propri** e la sua tesi centrale è concettuale (inglese come "interfaccia" vs inglese come "lingua naturale"), non una misura controllata sulla domanda del mandato. `[VERIFICATO CHE È POSIZIONALE, NON EMPIRICO]`

### 6.2 L'unico filone con misura controllata reale trovato, ma su una variabile adiacente (non identica)

- **Cross-Lingual Thought / XLT (Huang et al. 2023, arXiv:2305.07004, EMNLP Findings 2023)**: questo è uno **studio controllato reale** con risultati numerici — un template di prompt in 6 istruzioni (tra cui "pensa in inglese, poi rispondi nella lingua richiesta") testato su 7 benchmark di reasoning/understanding/generation, su lingue ad alta e bassa risorsa. Risultato misurato: **+10 punti medi** su arithmetic reasoning e open-domain QA rispetto al prompting diretto nella lingua nativa, e riduzione del gap tra la lingua peggiore e la migliore per task. `[VERIFICATO — paper accademico con metodologia e numeri propri, non una citazione di seconda mano]`. **Caveat importante**: questo NON è esattamente "system prompt in inglese vs lingua target" — è una tecnica di prompting (un template strutturato che include l'istruzione esplicita di "pensare in inglese internamente"), applicata allo stesso identico prompt in più lingue. È la prova più solida trovata che **una strategia esplicita di ragionamento-in-inglese-poi-risposta-nella-lingua-richiesta produce un guadagno misurato**, non la prova che "scrivere il system prompt in inglese" di per sé (senza istruzione esplicita di questo tipo) aiuti.
- **"Lost in Execution" (arXiv:2601.05366, gennaio 2026)** — pertinente in modo diretto al **tool-calling** (asse rilevante per Muffin), ma misura una variabile diversa da quella richiesta: **varia la lingua della query utente**, non del system prompt/schema-tool (tenuto sempre in inglese: *"function names, parameter keys, and tool descriptions are not translated"*). Modelli testati: GPT-5 (full/mini/nano), DeepSeek V3.2, Llama 3.1 (8B/70B), Qwen 3 (8B/14B/30B/32B/80B), Granite 4. Lingue: cinese, hindi, igbo — **l'italiano non è incluso**. Risultato qualitativo misurato: tradurre l'intera query aumenta i fallimenti di esecuzione, concentrati sul "language mismatch nei valori dei parametri" (es. una data o quantità detta a parole nella lingua nativa anziché come valore grezzo); la traduzione parziale (contesto tradotto, valori dei parametri lasciati in inglese) riduce sostanzialmente gli errori, "in alcuni casi pareggia o supera il riferimento inglese". Le mitigazioni testate (prompting, pre/post-traduzione) riducono ma **non recuperano completamente** le prestazioni-livello-inglese. `[VERIFICATO sul contenuto del paper, ma la variabile misurata è "lingua della query utente", non "lingua del system prompt", e l'italiano non è tra le lingue testate]`

### 6.3 Sintesi onesta per il mandato

- **Non esiste**, verificato in questa sessione, uno studio che misuri esattamente "system prompt in inglese vs system prompt in italiano, a parità di task e di lingua di output italiana" con numeri riproducibili.
- Il grosso della "evidenza" circolante nei blog tecnici è **citazione di seconda mano di studi che misurano altro** (capacità multilingue generale sul contenuto, non l'effetto della lingua dell'istruzione) — coerente con l'ipotesi del mandato che gran parte sia "folklore senza misure dirette".
- L'unica tecnica con misura controllata solida e riproducibile (XLT) supporta una versione più specifica e diversa dalla domanda: non "scrivi il prompt in inglese", ma "istruisci esplicitamente il modello a ragionare in inglese internamente prima di rispondere nella lingua richiesta" — un pattern di prompting attivo, non una scelta passiva di lingua del system prompt.
- Sul fronte tool-calling specificamente, l'evidenza più vicina (Lost in Execution) riguarda la lingua della *query utente* e dei *valori dei parametri*, non la lingua delle *istruzioni di sistema* — e comunque non copre l'italiano.

---

## 7. Nota metodologica finale / gap noti

**Fonti primarie fetchate direttamente in questa sessione**: `platform.claude.com/docs/en/about-claude/pricing`, `platform.claude.com/docs/en/build-with-claude/vision`, `ai.google.dev/gemini-api/docs/pricing`, `developers.openai.com/api/docs/pricing`, `huggingface.co/Qwen` (org page), `elevenlabs.io/docs/overview/capabilities/speech-to-text`, `arxiv.org/html/2601.05366v2`, `arxiv.org/abs/2605.07731`, `openrouter.ai/api/v1/models` (endpoint JSON pubblico, 338 modelli — fonte strutturata più usata in questo report), più decine di pagine singolo-modello su `openrouter.ai/<vendor>/<modello>`.

**Pagine che hanno restituito contenuto parziale/inaffidabile**: `openrouter.ai/models?q=qwen` (JS-rendered, nessun dato tabellare nel fetch testuale — risolto passando all'endpoint API JSON), `huggingface.co/spaces/mii-llm/open_ita_llm_leaderboard` (Gradio, solo stato di caricamento), `openrouter.ai/docs/api-reference/list-available-models` (404), `we.inc/blog/qwen3-8-max-open-weights-build-apps` (solo titolo estratto, corpo non raggiunto).

**Discrepanze esplicite non risolte**: titolo "Qwen3.8-Max Just Dropped as Open Weights" (we.inc) vs 5 fonti indipendenti concordi su "non ancora rilasciato" (§1); framing WER vs accuratezza per ElevenLabs Scribe italiano tra fonte 2025 (Scribe v1) e fonte 2026 (Scribe v2, §4.3); unità di prezzo esatta del campo `audio` per Voxtral su OpenRouter (per-token vs per-secondo, §4.1); se il tasso "25 token/secondo" di Gemini si applichi oltre al prodotto Live Translate (§3.1).

**Gap espliciti (assenza di dato in questa sessione, non conferma di assenza del fenomeno)**: WER italiano puntuale per Whisper/Deepgram/Gemini/GPT-4o-transcribe/Qwen3-ASR (§4.3); RTF di faster-whisper "small/medium" su CPU (solo large-v3 misurato, §4.4); benchmark pubblico aggiornato 2026 che collochi Gemma-4/Qwen3.5-3.6/GPT-OSS-20b su una scala di qualità italiana (§5); studio controllato che isoli "lingua del system prompt" da "lingua del contenuto del task" (§6); maturità hands-on di Qwen3-VL per input video/immagine su llama.cpp/Ollama (dichiarata dal progetto, non testata).

---

## Sintesi per pitch/ADR (incollabile senza rileggere il report)

**Qwen 3.8 in taglia 20-40B non esiste ancora** (2026-08-04): solo `Qwen3.8-Max` è live su OpenRouter, closed-weight, API-only (confermato da enumerazione completa dell'API OpenRouter + assenza su HuggingFace); i pesi (Max e 27B) sono promessi "la settimana prossima" da un annuncio del 3 agosto, quindi non prima di metà agosto. **Il più vicino disponibile oggi, aperto e su OpenRouter**: `Qwen3.5-27B`/`Qwen3.6-27B` (dense, Apache 2.0, $0.20-0.29/$1.56-2.40 per Mtok, **multimodali nativi image+video**) e `Qwen3.5/3.6-35B-A3B` (MoE 35B/3B attivi, stesso prezzo $0.14/$1.00, stessa multimodalità nativa) — tutti con tool-calling e structured-output dichiarati su OpenRouter. Nella stessa fascia: GPT-OSS-20b (Apache 2.0, $0.03/$0.13, il più economico, no vision), l'incumbent Gemma-4-26b-a4b (Apache 2.0, $0.07/$0.34, **già multimodale image+video sullo stesso endpoint già in uso**), Mistral-Small-3.2-24B, NVIDIA Nemotron-3-Nano-30B-A3B (licenza NVIDIA, non Apache), GLM-4.7-Flash (MIT, ma **già rigettato su harness Muffin proprio per qualità italiana e disciplina tool**), AllenAI OLMo-3-32B (Apache 2.0 + dati/codice aperti, ma senza tool-calling dichiarato). Su un aspetto emergente da monitorare: alcuni modelli open-weight cinesi di rilascio più recente (MiniMax H3, non Qwen) hanno iniziato a introdurre licenze che escludono esplicitamente USA/EU/UK/Corea — non risulta ancora applicarsi a Qwen/GLM/DeepSeek ma va ri-controllato a ogni nuovo rilascio.

**Multimodale**: Claude non ha audio nativo (solo testo+immagine+PDF, formula di costo immagine nota e ufficiale: ⌈w/28⌉×⌈h/28⌉ token); OpenAI serve l'audio da modelli/endpoint separati (`gpt-audio`, `gpt-realtime`) a $10-32/Mtok, non dalla famiglia chat generica; **Gemini è l'unico frontier con testo+immagine+audio+video nativi sulla stessa famiglia generalista**, a prezzi audio che vanno da 1× a 3.3× il prezzo immagine a seconda del modello. Lato open-weight: Qwen3-VL (8B/30B-A3B/32B, Apache 2.0) e l'intera famiglia Qwen3.5/3.6 hanno vision nativa; Gemma 4 ha vision su tutta la linea e **audio nativo solo sul 12B** (stack ancora immaturo su llama.cpp/Ollama, verificato in sessione precedente, non ri-testato); NVIDIA Nemotron-3-Nano-Omni-30B-A3B è **l'unico candidato in fascia 20-40B con testo+immagine+audio+video in un solo modello**, licenza NVIDIA non-Apache. InternVL/LLaVA/Pixtral/Kimi-VL non risultano oggi sul catalogo OpenRouter.

**Audio**: per trascrizione pura, il nuovo `gpt-transcribe` di OpenAI ($0.27/h, dal 28/7/2026) è ora il più economico tra le API testate esplicitamente su WER generale competitivo (4% AA-WER); ElevenLabs Scribe resta il migliore su WER generale misurato (2.2%) con l'italiano dichiarato ufficialmente in fascia "≤5% WER" (non una cifra puntuale); nessun servizio ha pubblicato, trovato in questa sessione, un WER italiano puntuale e comparabile su tutti i candidati. **Decisivo per Muffin**: locale-vs-API dipende dall'hardware, non dal modello — Whisper large-v3 è già più veloce del tempo reale su Mac con Metal, ma 3-6× più lento del tempo reale su CPU pura (la classe del VPS di produzione attuale) — quindi trascrizione locale ha senso solo se il processo gira dove c'è GPU/Metal, non sul VPS CPU-only.

**Italiano**: gap di dato pubblico confermato, non presunto — esiste un ecosistema di ricerca reale (EVALITA 2026, ITA-Bench, ITALIC, MMLU-PRO-ITA) ma nessuno copre, verificato in questa sessione, i candidati concreti del mandato (Gemma-4, Qwen3.5/3.6, GPT-OSS-20b) con dati aggiornati al 2026. Il dato più solido resta interno: Gemma-4-26b-a4b batte GLM-4.7-Flash sull'italiano su harness Muffin proprio (3.89 vs 2.89/5, giudice pairwise).

**Lingua del prompt**: nessuno studio controllato trovato che isoli esattamente "system prompt EN vs IT, stesso task, output atteso in IT" — le fonti più citate sui blog tecnici sono opinion-piece che citano studi su una variabile diversa (lingua del contenuto, non del prompt) senza riprodurli. L'unica tecnica con misura solida e riproducibile (XLT, EMNLP 2023, +10 punti medi) è una tecnica di prompting attiva ("pensa in inglese, rispondi in lingua"), non una scelta passiva di lingua del system prompt. Su tool-calling specificamente, l'evidenza più vicina (gennaio 2026) misura la lingua della query utente e dei valori dei parametri (non l'italiano, non il system prompt) e mostra che tradurre i *valori* dei parametri (non il testo circostante) è la causa principale dei fallimenti di esecuzione.
