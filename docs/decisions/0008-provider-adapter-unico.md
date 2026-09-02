# ADR-0008 — Interfaccia modello unica, due adapter (openai-compat + anthropic), nessun framework

**Contesto.** Un progetto open source non può pretendere un provider; l'astrazione però livella verso il minimo comune denominatore (caching, tool-format, thinking sono provider-specifici). Pattern del campo: nessun peer usa framework LLM; la lingua franca di fatto è l'API OpenAI-compatible (Ollama, llama.cpp, vLLM, OpenRouter, DeepSeek…); il Muffin attuale già opera tre provider con un solo SDK.

**Decisione.** Interfaccia interna nostra e tipata (`ChatCall`: messages, tools, cache-hints, thinking-budget, structured-output, streaming) con due implementazioni: `openai-compat` (default universale, copre il locale) e `anthropic` nativo (caching esplicito, extended thinking, 1M context). I capability-hint non supportati da un adapter degradano dichiaratamente (no-op tracciato), mai silenziosamente. Terzi adapter solo su bisogno dimostrato.

**Alternative scartate.** *Framework (LangChain/LiteLLM/Vercel AI)*: dipendenza che si muove sotto i piedi + livellamento al minimo comune; il costo di due adapter scritti in casa è inferiore al costo di *capire* un framework che li nasconde. *Solo OpenAI-compat*: perde il caching esplicito Anthropic (-90% sull'input ripetuto: è la voce di costo #1 di un agente always-on). *Adapter per ogni provider da subito*: YAGNI.

**Conseguenze.** Più facile: aggiungere un modello = una riga di config; testare il floor multi-tier sugli stessi scenari. Più difficile: le feature provider-nuove arrivano quando le aggiungiamo noi all'interfaccia (accettato: siamo il collo di bottiglia consapevole).

**Reversibilità.** Alta: l'interfaccia è nostra, gli adapter sono sostituibili singolarmente. Segnale che era sbagliata: `ChatCall` che accumula campi usati da un solo adapter (l'astrazione sta perdendo contro la divergenza dei provider).
