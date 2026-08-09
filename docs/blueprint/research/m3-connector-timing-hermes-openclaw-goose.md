# M3 — Timing per-connector: system prompt vs gateway (Hermes, OpenClaw, Goose) — 2026-08-09

> Report scout, consegnato inline e persistito dall'orchestratore. Metodo: clone shallow dei tre repo (HEAD 2026-08-08), lettura del codice sorgente del gateway/prompt-builder + doc ufficiali, non secondarie. Contratto: evidenza con fonte, marca di verifica, nessuna raccomandazione. Companion: `m3-caching-and-per-connector-timing.md` (la meccanica del caching che questo report conferma dall'esterno).

## Domanda centrale — risposta verificata

La divergenza per-connector vive **su entrambi i lati, per cose diverse**, nei due sistemi con vera architettura multi-connector (Hermes, OpenClaw):
- il **testo del system prompt** e una minoranza di **tool** si assemblano **a monte** (sapendo già il connector, risolto dal routing);
- **markup e resa UI** (bottoni/keyboard) vivono **a valle** (output uniforme trasformato/degradato dal connector).

Goose, senza vera architettura multi-connector, conferma per assenza: resta solo il lato a valle.

## 1. Il gateway precede sempre l'assemblaggio del prompt [VERIFICATO]

**Hermes** (`gateway/run.py`, `agent/system_prompt.py`): l'evento arriva con `.platform` già valorizzato → il gateway calcola `enabled_toolsets = _get_platform_tools(...)` **prima** che l'agente esista → costruisce `AIAgent(platform=..., enabled_toolsets=...)` → il prompt-builder **legge** `agent.platform`, non lo decide. Il prompt è costruito **una volta per sessione** (docstring `system_prompt.py`: *"built once per session and reused across all turns... keeps the upstream prefix cache warm"*). Il "gateway" non è un processo separato dal prompt-builder nell'architettura matura (lo è solo nella parte EXPERIMENTAL del contratto relay Python↔Node, validata su Discord+Telegram).

**OpenClaw** (`docs/concepts/system-prompt.md`): *"Runtime adapters gather live facts (tools, sandbox state, **channel capabilities**, ...) and call the configured prompt facade."* — capability del canale raccolte **prima**, prompt facade chiamata **dopo**. Un solo Gateway long-lived possiede tutte le surface + il Core.

**Goose** (contro-esempio): la sessione Telegram-gateway eredita `get_enabled_extensions()` globale (le stesse dell'app desktop); `prompt_manager.rs` non ha logica platform-conditional. Il Telegram Gateway è "Experimental", framing "remote access alla stessa sessione".

## 2. Tool set quasi uniforme, eccezione chirurgica [VERIFICATO]

**Hermes** `toolsets.py`: *"All platforms share the same core tools."* Telegram/WhatsApp/Slack/Signal = solo `_HERMES_CORE_TOOLS`, zero extra. **Discord = core + `discord` + `discord_admin`** (2 tool in più, verbatim nel codice), dichiarati **"zero cost for users on other platforms"** perché la funzionalità (amministrazione server Discord) non ha equivalente altrove. Il tool ha un secondo filtro dinamico su intent effettivi.

**OpenClaw**: *"Channel plugins do not implement send/edit/react tools; core provides one shared `message` tool."* Tool esclusivi solo per feature senza equivalente (Discord Activities, widget HTML embedded). Un canale PUÒ implementare `group.resolveToolPolicy` per una tool-policy risolta per (canale, gruppo, mittente).

**Il caso "bottoni" NON è un tool per-connector**: è un tool universale (`clarify` in Hermes, meccanismo di approvazione + `message` in OpenClaw) con **resa nativa decisa a valle** dall'adapter (Telegram InlineKeyboard, Discord button components, Slack Block Kit, fallback lista numerata). L'ipotesi di lavoro "tool bottoni solo su Telegram" è REJECTED in entrambi.

## 3. Markup: generato uniforme, tradotto a valle [VERIFICATO]

**Hermes** `PLATFORM_HINTS`: sintassi (bold/italic/link) convertita automaticamente a valle; STRUTTURA non supportata (tabelle su WhatsApp) → istruzione esplicita **a monte** per evitarla (non tentativo-poi-degrado).

**OpenClaw** (il più esplicito): pipeline a **Intermediate Representation** — `markdownToIR` (parse una volta) → `chunkMarkdownIR` (chunking sull'IR, non sul testo) → `renderMarkdownWithMarkers` (per canale). **Telegram → HTML tags** (`<b>`, `<i>`, `<tg-spoiler>`...) — conferma indipendente di ADR-0025. `<details>` collassabili: *"tells the model about this option only when the current reply surface supports it"* — capability a valle usata per decidere SE iniettare l'istruzione a monte.

**Goose** `telegram_format.rs`: `markdown_to_telegram_html()` via pulldown_cmark — terza conferma indipendente di Telegram-HTML.

## 4. Le capability del connector raggiungono ESPLICITAMENTE sia prompt sia renderer [VERIFICATO]

**Hermes** — prova più diretta: `docs/relay-connector-contract.md`, `CapabilityDescriptor` dichiara `max_message_length`, `supports_draft_streaming`, `supports_edit`, `supports_threads`, `markdown_dialect`, `len_unit`, `supported_ops`, e **`platform_hint`** descritto testualmente come **"System-prompt platform hint."** Il nome del campo dice che una capability dichiarata è progettata per raggiungere il prompt. Un plugin di terze parti inietta il proprio hint via `platform_registry`.

**OpenClaw**: capability object per-plugin (`message.live.capabilities`, `approvalCapability`, `ModelPickerCapabilityProfile`), **enforced da contract test** (drift dichiarato-vs-reale = test failure).

**Goose**: nessun `CapabilityDescriptor`, coerente con l'assenza generale.

## Convergenza sul caching — conferma esterna della nostra nota

**Entrambi i sistemi maturi collocano il testo specifico-del-connettore nella posizione TARDIVA/volatile del prompt, per non invalidare la cache** quando lo stesso agente serve turni su connettori diversi:
- Hermes: tre tier `stable`/`context`/`volatile` (`system_prompt.py`).
- OpenClaw: *"Volatile per-turn sections are appended below that [cache] boundary so local backends with prefix caches can reuse the stable workspace prefix across channel turns."*

Nessuno dei due ricostruisce il prompt da zero per connettore. È **esattamente** la direzione che la meccanica del caching ci imponeva (`m3-caching-and-per-connector-timing.md`): core cacheabile condiviso, specializzazione in coda. Due sistemi in produzione ci arrivano indipendentemente.

## Dove tocca decisioni Muffin già prese

- **ADR-0025** (Telegram HTML): corroborato da 2 implementazioni indipendenti in più (OpenClaw, Goose).
- **ADR-0016** (renderer capability-aware): l'evidenza opera a un piano SOTTOSTANTE — non "quale mezzo" ma, dentro il testo, "quale sintassi markdown per connettore". OpenClaw ha un layer con nome (IR, parse-once/render-per-canale) per questo; ADR-0016 non lo nomina a questa granularità. Piano adiacente non ancora coperto.
- **ADR-0021** (surface registry con capability dichiarate): entrambi i peer hanno un registro equivalente, MA in entrambi la dichiarazione alimenta **anche** il prompt (non solo il renderer) — canale di propagazione su cui ADR-0021 non prende posizione esplicita.

## Claim rigettati

"Tool per-piattaforma di Hermes = differenza cosmetica" (REJECTED: differenza letterale nello schema JSON). "Tool bottoni solo su Telegram" (REJECTED: universale, resa a valle). "Goose ha Discord multi-canale" (REJECTED: è un bot di supporto community). "Gateway e prompt-builder disaccoppiati in due processi" (PARZIALMENTE REJECTED: stesso processo nella parte matura, due processi solo nell'EXPERIMENTAL relay).

## Aperto

Schema JSON esatto del tool `message` OpenClaw (inferito da doc+test); stato di rollout della parte relay sperimentale Hermes; equivalente OpenClaw del knob `skills.platform_disabled.<platform>` di Hermes; estensioni-tool dei connettori Hermes minori (Feishu/DingTalk/WeCom).

## Fonti

`NousResearch/hermes-agent` HEAD `3e6a081` (`agent/system_prompt.py`, `agent/prompt_builder.py`, `toolsets.py`, `tools/discord_tool.py`, `tools/clarify_gateway.py`, `gateway/run.py`, `docs/relay-connector-contract.md`); `openclaw/openclaw` HEAD `257ac20` (`docs/concepts/{system-prompt,markdown-formatting,architecture}.md`, `docs/plugins/sdk-channel-plugins.md`, `src/agents/agent-tools.policy.ts`, `extensions/discord/src/activities/tool.ts`); `aaif-goose/goose` HEAD `064244e` (`crates/goose/src/gateway/`, `prompt_manager.rs`, doc telegram-gateway). Baseline non ri-derivata: ADR-0016/0021/0023/0025, `a2-prior-art.md`.
