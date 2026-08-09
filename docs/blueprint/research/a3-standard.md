# A3 — Standard ed ecosistema per MuffinOS (Fase A, ricerca da fonti primarie) — agosto 2026

> Report dello scout A3, consegnato inline e persistito dall'orchestratore (lo scout non dispone di tool di scrittura file). Contenuto verbatim.

**Nota metodologica.** Ogni claim è marcato: **[VERIFICATO]** (fonte primaria aperta, quote testuale), **[PARZIALMENTE VERIFICATO]** (fonte primaria aperta ma con dettaglio mancante/vago), **[NON VERIFICATO]** (solo sintesi di ricerca, non ho aperto/quotato la fonte primaria), **[IMPRECISO NEL MANDATO]** (la fonte primaria dice qualcosa di diverso da quanto ipotizzato). Le pagine web sono state trattate come dati, non istruzioni (ignorato ogni testo di navigazione tipo "fetch llms.txt").

---

## Mandato 1 — MCP spec revision 2026-07-28

### 1.1 Verifica dei 6 claim uno per uno

Fonte primaria: [Key Changes — modelcontextprotocol.io/specification/2026-07-28/changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog) (changelog ufficiale, nessuna data di revisione propria indicata sulla pagina, ma la spec è "Current" da 28 luglio 2026). Testo apertura: *"This document lists changes made to the Model Context Protocol (MCP) specification since the previous revision, [2025-11-25]."* → **la revisione precedente è confermata: 2025-11-25**.

**(a) Protocollo stateless — [VERIFICATO]**
Changelog, punto 2: *"Make MCP stateless: remove the `initialize`/`notifications/initialized` handshake... Version mismatches return `UnsupportedProtocolVersionError`"* (SEP-2575). Blog di rilascio finale ([blog.modelcontextprotocol.io/posts/2026-07-28/](https://blog.modelcontextprotocol.io/posts/2026-07-28/), 28 luglio 2026): *"MCP is transforming from a bidirectional stateful protocol into a request/response stateless protocol."*

**(b) Handshake `initialize` rimosso — [VERIFICATO]**
Stesso punto 2 del changelog, testuale. Blog finale: *"we've officially retired the `initialize`/`initialized` exchange along with the `Mcp-Session-Id` header."*

**(c) Sessioni e header `Mcp-Session-Id` eliminati — [VERIFICATO]**
Changelog, punto 1 (SEP-2567): *"Remove protocol-level sessions and the `Mcp-Session-Id` header from the Streamable HTTP transport. List endpoints (`tools/list`, `resources/list`, `prompts/list`) no longer vary per-connection. Servers that need cross-call state use explicit, server-minted handles passed as ordinary tool arguments."*

**(d) Tasks spostato in extension — [VERIFICATO]**
Changelog, punto 6 (SEP-2663): *"Move experimental tasks out of the core protocol and into an official extension (`io.modelcontextprotocol/tasks`). The redesigned extension replaces the blocking `tasks/result` method with polling via `tasks/get` and a new `tasks/update`..."*

**(e) Nuovo framework di extensions incluse MCP Apps — [PARZIALMENTE VERIFICATO / precisazione temporale importante]**
Il framework extensions **è** formalizzato in 2026-07-28: changelog, minor change #1: *"Add `extensions` field to `ClientCapabilities` and `ServerCapabilities` to support optional extensions beyond the core protocol."* Ma **MCP Apps non nasce con 2026-07-28**: SEP-1865 è stata creata il 2025-11-21, dichiarata live come extension ufficiale il 26 gennaio 2026 ([blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/): *"MCP Apps are now live as an official MCP extension"*), e la sua spec tecnica porta la data "Stable (2026-01-26)". Quindi: il claim è vero nella sostanza (Apps è una extension del nuovo framework), ma la formulazione "nuovo framework... incluse MCP Apps" suggerisce contemporaneità che non c'è — Apps precede di ~6 mesi la finalizzazione del core stateless.

**(f) Deprecazione di Roots/Sampling/Logging — [VERIFICATO]**
Changelog, sezione Deprecated, punto 1 (SEP-2577): *"Deprecate the Roots, Sampling, and Logging features... These features remain fully functional during the deprecation window but new implementations should not add support for them. Suggested migrations: pass directories or files via tool parameters... instead of Roots; integrate directly with LLM provider APIs instead of Sampling; log to `stderr` (stdio) or use OpenTelemetry instead of Logging."* Blog finale conferma la finestra: *"They still work, and they'll keep working for at least twelve months."* Politica generale: [feature lifecycle and deprecation policy](https://modelcontextprotocol.io/community/feature-lifecycle) (SEP-2596) — minimo 12 mesi tra Deprecated e Removed (90 giorni sotto l'eccezione di "expedited-removal").

**Tutti e sei i claim dell'owner sono sostanzialmente corretti**; l'unica imprecisione è di sequenza temporale sul punto (e).

Altri breaking change rilevanti non menzionati dall'owner ma presenti nel changelog (utile per Fase B/C): rimozione di `ping`/`logging/setLevel`/`notifications/roots/list_changed`; sostituzione GET+subscribe/unsubscribe con `subscriptions/listen`; nuovo pattern **MRTR** (Multi Round-Trip Requests, SEP-2322) che sostituisce le richieste server-initiated (`roots/list`, `sampling/createMessage`, `elicitation/create`) con `resultType: "input_required"`; rimozione SSE resumability/`Last-Event-ID`; deprecazione HTTP+SSE transport e OAuth Dynamic Client Registration (a favore di Client ID Metadata Documents).

### 1.2 Backward compatibility

Fonte primaria: [Versioning — modelcontextprotocol.io/docs/2026-07-28/learn/versioning](https://modelcontextprotocol.io/docs/2026-07-28/learn/versioning). Quote: *"Clients and servers **MAY** support multiple protocol versions simultaneously."* Negoziazione: ogni richiesta dichiara la versione in `_meta.io.modelcontextprotocol/protocolVersion` (anche header `MCP-Protocol-Version` su Streamable HTTP); se non supportata, il server risponde `UnsupportedProtocolVersionError` con le versioni supportate; `server/discover` è opzionale per la selezione anticipata.

A livello di **implementazione SDK** (non di obbligo di spec): TypeScript SDK, doc ufficiale [`docs/migration/support-2026-07-28.md`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md) — *"Nothing in v2 puts a 2026-07-28 byte on the wire by default"* (adozione = opt-in esplicito). `createMcpHandler(factory)` serve entrambe le ere per default (`legacy: 'stateless'`); rifiutare connessioni legacy richiede opt-in esplicito (`legacy: 'reject'`); lato client, `versionNegotiation: { mode: 'auto' }` fa probe con `server/discover` e ricade sulla versione 2025 se necessario. Blog SDK beta ([blog.modelcontextprotocol.io/posts/sdk-betas-2026-07-28/](https://blog.modelcontextprotocol.io/posts/sdk-betas-2026-07-28/), 29 giugno 2026): *"your existing server keeps working"*; client v2 *"fall back to the `initialize` handshake when they reach a server"* su 2025-11-25 o precedenti.

**Risposta netta al quesito "un server nuovo parla con un client vecchio?"**: sì, ma è un comportamento di compatibilità implementato negli SDK ufficiali (default "servi entrambe le ere"), non un obbligo hard-wired nella spec — un'implementazione conforme potrebbe scegliere di rifiutare le versioni legacy.

### 1.3 Supporto SDK ufficiali

| SDK | Versione beta (29/06/2026) | Stato a fine luglio 2026 | Fonte |
|---|---|---|---|
| Python | `mcp[cli]==2.0.0b1` | v2.0.0 stabile rilasciata "alongside" 2026-07-28 [NON VERIFICATO numero build esatto] | [python-sdk releases](https://github.com/modelcontextprotocol/python-sdk/releases) |
| TypeScript | `@modelcontextprotocol/{server,client}@beta` | v2 main branch implementa 2026-07-28; pacchetti scissi (`server`, `client`, `core`, `node`, `express`, `hono`, `server-legacy`) | [typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk) |
| Go | `go-sdk@v1.7.0-pre.1` | — | blog SDK beta |
| C# | `ModelContextProtocol --prerelease` (2.0.0-preview.1) | v2.0.0-preview.1 rilasciata, annunciata su [devblogs.microsoft.com](https://devblogs.microsoft.com/dotnet/announcing-v20-of-the-official-mcp-csharp-sdk/) [NON VERIFICATO in dettaglio, non aperto] | — |
| Rust | — | "in beta" [NON VERIFICATO, solo da sintesi WebSearch] | — |

Migration guide confermate: TypeScript ha due doc separati — *"Upgrading from v1 to v2"* e *"Adopting the 2026-07-28 revision"* ([repo](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/)); Python ha guida completa su `py.sdk.modelcontextprotocol.io/v2/migration/` che *"walks through every breaking change"* [NON VERIFICATO — citato dal blog SDK beta, non ho aperto direttamente quella pagina].

### 1.4 Supporto nei client principali

- **Anthropic/Claude**: post ufficiale [claude.com/blog/bringing-mcp-2026-07-28-to-claude](https://claude.com/blog/bringing-mcp-2026-07-28-to-claude) (28 luglio 2026) — dichiara solo genericamente *"Support is being rolled out across Claude products soon"*, **senza specificare quali prodotti Claude (web/Desktop/Code/API) parlano già il protocollo core 2026-07-28 né una data**. [PARZIALMENTE VERIFICATO — impegno dichiarato, dettaglio prodotto-per-prodotto assente].
- **VS Code**: **[VERIFICATO solo per l'extension MCP Apps]** — la [Extension Support Matrix ufficiale](https://modelcontextprotocol.io/extensions/client-matrix) mostra "VS Code GitHub Copilot" con spunta su MCP Apps. **Non ho trovato conferma primaria che il client core MCP di VS Code parli il protocollo 2026-07-28** (stateless/handshake nuovo) — solo il supporto dell'extension Apps è documentato in un registro ufficiale. Gap esplicito, non colmato.
- **Client con MCP Apps confermato** (stesso client-matrix, community-maintained ma ospitato su modelcontextprotocol.io): Claude (web), Claude Desktop, VS Code GitHub Copilot, Microsoft 365 Copilot, Goose, Postman, MCPJam, ChatGPT, Cursor, Archestra.AI (anche Enterprise Auth), PostHog Code.

### Tabella mandato 1

| | Cosa dice la fonte primaria | Stato di maturità | Chi lo supporta oggi |
|---|---|---|---|
| Protocollo | 2026-07-28 = "Current", stateless, `initialize` rimosso, sessioni rimosse (SEP-2567/2575), Tasks/Apps come extension, Roots/Sampling/Logging deprecated 12 mesi (SEP-2577) | Final/Current (dopo RC dal 21/05 al 28/07/2026) | 4 SDK Tier-1 (TS/Py/Go/C#) in v2; Rust beta [NV]; Claude "presto" (vago); VS Code solo extension Apps confermata |

---

## Mandato 2 — MCP Apps (SEP-1865)

Fonte primaria: [SEP-1865](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp) — badge **Final**, Extensions Track, creata 2025-11-21, PR co-autorata da maintainer OpenAI + Anthropic + creatori MCP-UI. Spec tecnica dettagliata: [ext-apps 2026-01-26/apps.mdx](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx), stato dichiarato **"Stable (2026-01-26)"**, identificatore `io.modelcontextprotocol/ui`.

Abstract SEP (quote): *"MCP Apps introduces a standardized pattern for declaring UI resources via the `ui://` URI scheme, associating them with tools through metadata, and facilitating bi-directional communication between the UI and the host using MCP's JSON-RPC base protocol... The initial specification focuses on HTML resources (`text/html;profile=mcp-app`) with a clear path for future extensions."*

**Meccanica esatta [VERIFICATO]:**
- Risorse `ui://` dichiarate con `uri`, `name`, `mimeType: "text/html;profile=mcp-app"`; contenuto via `resources/read` (`text` o `blob` base64); metadata opzionale in `_meta.ui` (CSP, permessi).
- Iframe sandbox: attributi `allow-scripts`, `allow-same-origin` (per il sandbox proxy); CSP di default restrittiva: `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none'`. L'host costruisce la CSP effettiva dai campi metadata `connectDomains`→`connect-src`, `resourceDomains`→`img-src`/`script-src`/`style-src`/`font-src`, `frameDomains`→`frame-src`, `baseUriDomains`→`base-uri`.
- Messaggistica JSON-RPC View→Host: `ui/initialize`, `ui/open-link`, `ui/message`, `ui/request-display-mode`, `ui/update-model-context`. Host→View: `ui/notifications/tool-input`, `tool-input-partial`, `tool-result`, `tool-cancelled`, `size-changed`, `host-context-changed`, `ui/resource-teardown`.
- Link tool↔UI: campo `_meta.ui.resourceUri` (una forma legacy `_meta["ui/resourceUri"]` è stata rimossa pre-GA).
- Requisiti host (MUST): renderizzare in iframe sandboxato; costruire la CSP da metadata e rifiutare domini non dichiarati; loggare le config CSP per audit; validare i messaggi JSON-RPC in ingresso; inviare `tool-input` prima di `tool-result`; escludere da `tools/list` i tool senza `"model"` in `visibility`; rifiutare `tools/call` da UI per tool senza `"app"` in `visibility`.

**Modello di sicurezza dichiarato [VERIFICATO]** (dalla sezione "Security Implications" del SEP): *"Iframe sandboxing: All UI content runs in sandboxed iframes with restricted permissions"*; *"Predeclared templates: Hosts can review HTML content before rendering"*; *"Auditable messages: All UI-to-host communication goes through loggable JSON-RPC"*; *"User consent: Hosts can require explicit approval for UI-initiated tool calls."* Rischi residui dichiarati: social engineering via contenuto ingannevole, consumo di risorse (non ulteriormente dettagliati nel SEP stesso — rimanda alla "full specification" per l'analisi completa).

**Host che supportano oggi [VERIFICATO]**: Extension Support Matrix ufficiale ([modelcontextprotocol.io/extensions/client-matrix](https://modelcontextprotocol.io/extensions/client-matrix)) — spunta MCP Apps per: Claude (web), Claude Desktop, VS Code GitHub Copilot, Microsoft 365 Copilot, Goose, Postman, MCPJam, ChatGPT, Cursor, Archestra.AI, PostHog Code. Al lancio (26/01/2026, [blog ufficiale](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/)): Claude (web+desktop), Goose, VS Code Insiders, ChatGPT "a partire da quella settimana". Nota importante: *"We were excited to partner with both OpenAI and MCP-UI to create a shared open standard"* — MCP Apps unifica MCP-UI (community, adottato da Postman/HuggingFace/Shopify/Goose/ElevenLabs) e l'Apps SDK di OpenAI (lanciato novembre 2025).

**Maturità**: SEP Final + spec tecnica "Stable" dal 26/01/2026 — è la extension MCP più matura tra quelle esaminate in questo report (l'unica con matrice di adozione ufficiale tracciata).

### Tabella mandato 2

| | Cosa dice la fonte primaria | Stato di maturità | Chi lo supporta oggi |
|---|---|---|---|
| MCP Apps (SEP-1865) | `ui://` + iframe sandbox obbligatorio + CSP da metadata + JSON-RPC auditabile + consenso utente per tool-call da UI | Final (SEP) / Stable (spec, 2026-01-26) | 11 host in client-matrix ufficiale: Claude web+Desktop, VS Code Copilot, M365 Copilot, Goose, Postman, MCPJam, ChatGPT, Cursor, Archestra.AI, PostHog Code |

---

## Mandato 3 — MCP Tasks (extension)

Fonte primaria: [modelcontextprotocol.io/extensions/tasks/overview](https://modelcontextprotocol.io/extensions/tasks/overview) + [SEP-2663](https://modelcontextprotocol.io/seps/2663-tasks-extension).

**Lifecycle esatto [VERIFICATO]** — tabella stati dalla pagina ufficiale:

| Status | Meaning |
|---|---|
| `working` | The operation is in progress |
| `input_required` | The server needs client input before continuing |
| `completed` | The operation finished (risultato in `result`) |
| `failed` | Errore JSON-RPC (dettagli in `error`) |
| `cancelled` | Operazione cancellata (non sempre onorata) |

`completed`/`failed`/`cancelled` sono terminali. Flusso: `tools/call` → `CreateTaskResult` (`resultType: "task"`, con `taskId`, `ttlMs`, `pollIntervalMs`) → polling client via `tasks/get` → se `input_required`, il client soddisfa via `tasks/update` → risultato finale. Cancellazione via `tasks/cancel`, cooperativa (non garantita). Notifiche push opzionali via `notifications/tasks`, con opt-in tramite `subscriptions/listen` (evita un round-trip extra di `tasks/get`); il polling resta il meccanismo di default.

**Confine [VERIFICATO]**: opt-in esplicito da **entrambi** i lati — il client dichiara `io.modelcontextprotocol/tasks` nelle capability per-richiesta, il server lo pubblicizza in `server/discover`. Quote esplicita: *"Never return a task to a client that did not declare support."*

**Maturità — discrepanza interessante da segnalare esplicitamente**: la pagina SEP ([modelcontextprotocol.io/seps/2663-tasks-extension](https://modelcontextprotocol.io/seps/2663-tasks-extension)) mostra badge **"Final"**, Extensions Track — trattamento identico a SEP-1865. **Ma** il README del repository di riferimento [github.com/modelcontextprotocol/ext-tasks](https://github.com/modelcontextprotocol/ext-tasks), aperto direttamente, si autodescrive come **"experimental extension"** e la repo risulta "under development". **[IMPRECISIONE/TENSIONE RILEVATA]**: lo status di accettazione del design (SEP Final) non coincide con l'etichettatura che il repo di riferimento dà di se stesso — indicazione che l'implementazione/documentazione potrebbe essere meno matura del design formalmente accettato, o che il README non è aggiornato. Da verificare con occhio critico prima di considerare Tasks "pronto quanto Apps".

**Supporto client/SDK — gap rilevato**: la [Extension Support Matrix ufficiale](https://modelcontextprotocol.io/extensions/client-matrix) **non include affatto una colonna Tasks** (solo MCP Apps + 2 extension di auth sono tracciate lì). Questo è un dato negativo significativo: **non esiste, ad oggi, un registro ufficiale equivalente a quello di Apps per l'adozione di Tasks nei client**. Il README di ext-tasks non nomina SDK specifici. Ho trovato solo evidenza indiretta e non verificata al livello di fonte primaria che il C# SDK 2.0.0-preview.1 abbia sostituito l'API Tasks sperimentale con l'implementazione SEP-2663 [NON VERIFICATO — da sintesi WebSearch, non ho aperto il devblogs.microsoft.com post per confermare testualmente].

### Tabella mandato 3

| | Cosa dice la fonte primaria | Stato di maturità | Chi lo supporta oggi |
|---|---|---|---|
| MCP Tasks | Stati working/input_required/completed/failed/cancelled; API `tasks/get`/`tasks/update`/`tasks/cancel`; opt-in bilaterale client+server | SEP "Final" MA repo ext-tasks si autodefinisce "experimental" — **tensione non risolta** | Nessun client tracciato in matrice ufficiale (a differenza di Apps) — supporto SDK non verificato con fonte primaria diretta |

---

## Mandato 4 — Agent Skills / SKILL.md (agentskills.io)

Fonte primaria: [agentskills.io](https://agentskills.io) (overview) + [agentskills.io/specification](https://agentskills.io/specification).

**Struttura file [VERIFICATO, tabella riportata testualmente dalla spec]:**

| Campo | Obbligatorio | Vincoli |
|---|---|---|
| `name` | Sì | Max 64 char, minuscole/numeri/trattini, non inizia/finisce con trattino, no trattini consecutivi, deve coincidere col nome della directory |
| `description` | Sì | Max 1024 char, non vuota |
| `license` | No | Nome licenza o riferimento a file |
| `compatibility` | No | Max 500 char |
| `metadata` | No | Mappa chiave-valore arbitraria |
| `allowed-tools` | No | Stringa spazio-separata — **"Experimental. Support for this field may vary between agent implementations"** |

Directory: `SKILL.md` (required) + `scripts/`, `references/`, `assets/` (optional). Body: markdown libero, "no format restrictions"; raccomandato **<500 righe / <5000 token**.

**Progressive disclosure [VERIFICATO, quote esatta]** — 3 stadi: *"1. Discovery: At startup, agents load only the name and description of each available skill... 2. Activation: When a task matches a skill's description, the agent reads the full SKILL.md instructions into context. 3. Execution: The agent follows the instructions, optionally executing bundled code or loading referenced files as needed."* Budget dichiarati: metadata ~100 token, istruzioni <5000 token raccomandati, risorse "as needed".

**Normativo vs convenzione**: i vincoli su `name`/`description` sono normativi in senso stretto (limiti di caratteri, charset, unicità — validabili programmaticamente via il tool ufficiale `skills-ref`, [github.com/agentskills/agentskills/tree/main/skills-ref](https://github.com/agentskills/agentskills/tree/main/skills-ref)). Tutto il resto (contenuto del body, sezioni raccomandate, dimensione file) è esplicitamente in linguaggio "should"/"we recommend" — convenzione, non requisito.

**Governance e licenza [VERIFICATO]**: repository [github.com/agentskills/agentskills](https://github.com/agentskills/agentskills) — licenza **doppia**: codice Apache-2.0, documentazione CC-BY-4.0. **Nessun file GOVERNANCE.md trovato**; esiste CONTRIBUTING.md (contenuto non ispezionato). La homepage dichiara: *"The Agent Skills format was originally developed by Anthropic, released as an open standard, and has been adopted by a growing number of agent products. The standard is open to contributions from the broader ecosystem."* **Nessuna affiliazione a Linux Foundation o altra foundation è dichiarata** — a differenza di MCP e AGENTS.md (vedi Mandato 5), Agent Skills resta oggi un progetto "open" senza governance federata formale rilevata.

**Chi lo adotta [VERIFICATO, elenco diretto dalla homepage ufficiale — è uno showcase auto-sottomesso dai vendor, non un audit di mercato indipendente]**: ~45 prodotti mostrati con logo/link, tra cui Claude Code, Claude, ChatGPT & Codex, Gemini CLI, GitHub Copilot, VS Code, Cursor, Goose, JetBrains Junie, Roo Code, Amp, Letta, OpenHands, OpenCode, Databricks Genie Code, Snowflake Cortex Code, Spring AI, Laravel Boost, Mistral AI Vibe, Factory, Kiro, Tabnine, e altri ~25 tool più di nicchia.

**Cataloghi/marketplace con numeri [NON VERIFICATO — solo sintesi WebSearch, non ho aperto direttamente i siti]**: SkillsMP dichiara ~1,9-2,4M skill scrapate da GitHub (i numeri variano anche tra fonti dello stesso digest, segnale di scarsa affidabilità); Skills.sh dichiara 90.000+ skill con install-count tracciato; SkillHub ~7.000 curate; Awesome Skills 50.000+; Agentskill.sh 200.000+. Tutti self-reported, date approssimative (~2026), **non ho verificato nessuno di questi numeri aprendo il sito sorgente** — vanno trattati come indicativi di un ecosistema fiorente ma non come cifre affidabili.

### Tabella mandato 4

| | Cosa dice la fonte primaria | Stato di maturità | Chi lo supporta oggi |
|---|---|---|---|
| Agent Skills / SKILL.md | Frontmatter `name`+`description` normativi, resto convenzione; progressive disclosure a 3 stadi; Apache-2.0 + CC-BY-4.0, nessuna foundation | Adottato ampiamente, nessun body di governance formale (a differenza di MCP/AGENTS.md) | ~45 tool nello showcase ufficiale (Claude/Claude Code, ChatGPT/Codex, Gemini CLI, Copilot/VS Code, Cursor, Goose, JetBrains, ecc.); marketplace terzi con numeri non verificati |

---

## Mandato 5 — AGENTS.md

Fonte primaria per il contenuto: [agents.md](https://agents.md). Fonte primaria per la governance: comunicato stampa ufficiale [Linux Foundation, 9 dicembre 2025](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation).

**Cosa prescrive [VERIFICATO/PARZIALMENTE — paraphrase da fetch, non quote letterale al 100%]**: file Markdown standard posizionato alla radice del repository, nessun campo obbligatorio ("qualsiasi intestazione desideriate" — sezioni tipiche: overview progetto, comandi build/test, style guide, istruzioni di test, considerazioni di sicurezza). Regola di precedenza per monorepo: un AGENTS.md per pacchetto è supportato, e *"Agents read the nearest file in the directory tree automatically, so the closer file takes precedence"* (paraphrase del mio fetch, semantica confermata ma non garantisco la letteralità carattere-per-carattere).

**Verifica del claim di governance — [VERIFICATO, TRUE, con fonte primaria solida]**: il comunicato Linux Foundation (9/12/2025) dichiara esplicitamente: *"the Linux Foundation announced the formation of the Agentic AI Foundation (AAIF) with founding contributions of three leading projects: Anthropic's Model Context Protocol (MCP), Block's goose, and OpenAI's AGENTS.md."* Quote di Jim Zemlin (Executive Director LF): *"Bringing these projects together under the AAIF ensures they can grow with the transparency and stability that only open governance provides."* → **Sì, è vero: MCP e AGENTS.md sono entrambi progetti fondativi della stessa foundation (AAIF), che a sua volta è stata costituita dalla Linux Foundation.** Membri Platinum: AWS, Anthropic, Block, Bloomberg, Cloudflare, Google, Microsoft, OpenAI. Gold (18 nomi tra cui Cisco, Datadog, IBM, JetBrains, Okta, Salesforce, SAP, Shopify, Snowflake). Silver (22 nomi tra cui Hugging Face, Pydantic, Uber, WorkOS, Zapier). Nota: la pagina [aaif.io](https://aaif.io) stessa, aperta direttamente, **non menziona esplicitamente MCP/AGENTS.md nel contenuto ispezionato** (mostra 7 working group tematici) — la conferma solida viene dal comunicato LF, non dalla homepage AAIF.

**Adozione [VERIFICATO ma datato]**: stesso comunicato LF — *"AGENTS.md has already been adopted by more than 60,000 open source projects and agent frameworks including Amp, Codex, Cursor, Devin, Factory, Gemini CLI, GitHub Copilot, Jules and VS Code among others."* Questo numero è **datato 9/12/2025** — non ho trovato un aggiornamento più recente (agosto 2026), quindi va trattato come limite inferiore, non come cifra corrente. La pagina agents.md elenca 25+ strumenti che lo leggono: OpenAI Codex, Google Jules, Factory, Aider, GitHub Copilot, VS Code, Cursor, Zed, Devin (Cognition), UiPath, JetBrains Junie, Gemini CLI, Windsurf, RooCode, e altri.

### Tabella mandato 5

| | Cosa dice la fonte primaria | Stato di maturità | Chi lo supporta oggi |
|---|---|---|---|
| AGENTS.md | File root, no campi obbligatori, precedenza al file più vicino nell'albero; governance = AAIF (Linux Foundation), stesso ombrello di MCP — **verificato vero** | Progetto fondativo AAIF dal 09/12/2025 | >60.000 progetti (dato dic-2025, non aggiornato); 25+ tool nominati (Codex, Copilot, VS Code, Cursor, Jules, Aider, Devin, Zed, Windsurf, RooCode…) |

---

## Mandato 6 — OpenTelemetry GenAI semantic conventions

**Stato di stabilità attuale [VERIFICATO direttamente sul registro attributi]**: fonte [github.com/open-telemetry/semantic-conventions-genai — docs/registry/attributes/gen-ai.md](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/registry/attributes/gen-ai.md) — **tutti** gli attributi `gen_ai.*` ispezionati portano badge di stabilità **"Development"**. Nessuno è marcato Stable. Conferma incrociata da ricerca: *"As of July 17, 2026, no GenAI-specific span, event, metric, or attribute in the dedicated repository is marked Stable; the GenAI conventions remain Development"* [NON VERIFICATO alla lettera — da sintesi WebSearch di terze parti, coerente col fetch diretto sul registro].

**Repository dedicato**: le convenzioni `gen_ai.*` sono state **spostate fuori** dal repo principale `open-telemetry/semantic-conventions` in un repo dedicato [semantic-conventions-genai](https://github.com/open-telemetry/semantic-conventions-genai), a partire dalla release v1.42.0 (12 giugno 2026) [NON VERIFICATO direttamente sul changelog, da sintesi WebSearch]. Il vecchio path `opentelemetry.io/docs/specs/semconv/gen-ai/` ora reindirizza con un avviso: *"GenAI semantic conventions have moved to the [OpenTelemetry GenAI semantic conventions repository]"* [VERIFICATO — fetch diretto].

**Span definiti [VERIFICATO direttamente]** — fonte [docs/gen-ai/gen-ai-agent-spans.md](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md):

| Span (`gen_ai.operation.name`) | Kind | Stability |
|---|---|---|
| `create_agent` | CLIENT | Development |
| `invoke_agent` | CLIENT (esiste anche variante INTERNAL per framework in-process tipo LangChain/CrewAI) | Development |
| `invoke_workflow` | CLIENT/INTERNAL | Development |
| `plan` | — | Development |
| `execute_tool` | — | Development |

Attributi agent: `gen_ai.agent.{description,id,name,version}`. Attributi tool: `gen_ai.tool.call.{arguments,id,result}`, `gen_ai.tool.{definitions,description,name,type}`. `gen_ai.operation.name` include anche `chat`, `embeddings`, `generate_content`, `text_completion`, `retrieval` [lista non esaustiva verificata — la pagina cita "numerose operazioni di memoria/agente" senza elencarle tutte nel testo che ho ispezionato].

**Convenzioni specifiche per MCP — [GAP APERTO, non risolto]**: la descrizione del repository dichiara esplicitamente scope su *"spans, metrics, and events for GenAI clients, MCP (Model Context Protocol), and provider-specific conventions"* — quindi MCP è dichiaratamente **in scope**. Tuttavia, la pagina di registro attributi che ho ispezionato direttamente **non contiene alcuna menzione di MCP** nel contenuto tecnico. Non ho individuato/aperto la pagina specifica (se esiste) con attributi MCP-dedicati — resta un gap di verifica, non un'assenza confermata.

**Breaking change recenti [PARZIALMENTE VERIFICATO]**: `gen_ai.system` rinominato in `gen_ai.provider.name` in semantic-conventions v1.37.0 (agosto 2025) [NON VERIFICATO alla lettera, da sintesi WebSearch corroborata da issue GitHub Spring AI]; durante la transizione i framework "may emit both attributes."

**Pinning di una versione [NON VERIFICATO]**: riferimento a variabile d'ambiente `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental` — trovato solo in sintesi di ricerca, non ho aperto una pagina primaria che lo documenti esplicitamente con questa sintassi esatta.

### Tabella mandato 6

| | Cosa dice la fonte primaria | Stato di maturità | Chi lo supporta oggi |
|---|---|---|---|
| OTel GenAI semconv | Tutti gli attributi/span `gen_ai.*` ispezionati = Development, nessuno Stable; span agent/workflow/tool/plan definiti; MCP dichiarato in-scope ma non trovato nel registro ispezionato | Development/experimental, nessuna release 1.0, repo scisso a giugno 2026 | Non applicabile (è una convenzione di strumentazione, non un prodotto con "adottanti" diretti nel senso client) |

---

## Mandato 7 — Canone di sicurezza per il threat model

### 7.1 OWASP — con una correzione importante rispetto al mandato

**[IMPRECISIONE NEL MANDATO RILEVATA E DA RIPORTARE]**: il mandato chiede di verificare "OWASP Top 10 for LLM Applications versione corrente 2026". **Non esiste una versione 2026 del Top 10 LLM "core".** Verificato direttamente aprendo il menu di navigazione di [genai.owasp.org/initiatives/agentic-security-initiative/](https://genai.owasp.org/initiatives/agentic-security-initiative/): le uniche edizioni elencate sono **"LLM TOP 10 FOR 2025"** e **"LLM TOP 10 FOR 2023/24"**. La versione corrente resta quella "2025" (pubblicata 12 marzo 2025, spesso citata come v2.0), verificata su [genai.owasp.org/llm-top-10/](https://genai.owasp.org/llm-top-10/). Diversi blog secondari (Repello AI, Wraith, diffray.ai) etichettano contenuti "2026" nel titolo per SEO, ma **non è un'edizione ufficiale nuova**. Ciò che *è* effettivamente datato "2026" (pubblicato dicembre 2025) è un documento **diverso e separato**: l'**OWASP Top 10 for Agentic Applications**, parte dell'Agentic Security Initiative.

**LLM Top 10 (2025)** — ranking verificato: LLM01 Prompt Injection, LLM02 Sensitive Information Disclosure, LLM03 Supply Chain, LLM04 Data and Model Poisoning, LLM05 Improper Output Handling, LLM06 Excessive Agency, LLM07 System Prompt Leakage, LLM08 Vector and Embedding Weaknesses, LLM09 Misinformation, LLM10 Unbounded Consumption.

Fonte primaria diretta: [genai.owasp.org/llmrisk/llm01-prompt-injection/](https://genai.owasp.org/llmrisk/llm01-prompt-injection/). Quote esatte:
- Definizione: *"A Prompt Injection Vulnerability occurs when user prompts alter the LLM's behavior or output in unintended ways."*
- Indiretta: *"[Indirect Prompt Injections] occur when an LLM accepts input from external sources, such as websites or files"* dove il contenuto esterno altera il comportamento del modello (esempio citato: riassunto di pagina web con istruzioni nascoste che fanno inserire un'immagine con URL malevolo per esfiltrare la conversazione).
- Mitigazioni elencate (7, verbatim nei titoli): Constrain model behavior; Define and validate expected output formats; Implement input and output filtering; Enforce privilege control and least privilege access; Require human approval for high-risk actions; Segregate and identify external content; Conduct adversarial testing and attack simulations.

**Importante**: "memory poisoning" **non è una categoria nominata nel LLM Top 10**. La voce più vicina è LLM04 "Data and Model Poisoning", che riguarda l'avvelenamento dei dati di **pre-training/fine-tuning/embedding** — un concetto diverso dall'avvelenamento della **memoria runtime di un agente**.

**OWASP Top 10 for Agentic Applications ("for 2026", pubblicato 9/12/2025)** — fonte primaria: [genai.owasp.org/2025/12/09/...](https://genai.owasp.org/2025/12/09/owasp-top-10-for-agentic-applications-the-benchmark-for-agentic-security-in-the-age-of-autonomous-ai/). È **qui** che "memory poisoning" vive come categoria a sé:

| Codice | Nome | Quote/esempio |
|---|---|---|
| ASI01 | Agent Goal Hijack | *"Hidden prompts turned copilots into silent exfiltration engines"* (es. EchoLeak) |
| ASI02 | Tool Misuse | agenti che piegano tool legittimi verso output distruttivi (es. Amazon Q) |
| ASI03 | Identity & Privilege Abuse | — |
| ASI04 | Agentic Supply Chain Vulnerabilities | es. GitHub MCP exploit |
| ASI05 | Unexpected Code Execution | es. AutoGPT RCE |
| **ASI06** | **Memory & Context Poisoning** | *"Memory poisoning reshaped behaviour long after the initial interaction"* (es. Gemini Memory Attack) |
| ASI07 | Insecure Inter-Agent Communication | — |
| ASI08 | Cascading Failures | — |
| ASI09 | Human-Agent Trust Exploitation | — |
| ASI10 | Rogue Agents | es. Replit meltdown |

Metodologia dichiarata: "hundreds of experts," "thousands of comments," Distinguished Expert Review Board. Relazione col LLM Top 10: framework **distinti ma correlati** — *"shared language mapping with our Top 10 for LLMs"*.

**Deliverable dell'Agentic Security Initiative** — verificato direttamente sulla pagina ufficiale (non "5 documenti" come sintetizzato da una ricerca secondaria, ma **6** nell'elenco che ho aperto): State of Agentic AI Security and Governance 2.01; AIUC-1 crosswalk col Top 10 Agentic; AI Security Solutions Landscape for Agentic AI Q2 2026; A Practical Guide for Secure MCP Server Development; OWASP Top 10 for Agentic Applications for 2026; CheatSheet per l'uso sicuro di server MCP di terze parti 1.0.

### 7.2 Simon Willison — "lethal trifecta"

Fonte primaria: [simonwillison.net/2025/Jun/16/the-lethal-trifecta/](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/) (16 giugno 2025). Le tre condizioni, verbatim: **"Access to your private data"**, **"Exposure to untrusted content"**, **"The ability to externally communicate"**.

Conseguenza architetturale che l'autore stesso ne trae: rimanda al principio dei design pattern (vedi 7.4) — *"once an LLM agent has ingested untrusted input, it must be constrained so that it is impossible for that input to trigger any consequential actions"* — e per gli utenti finali la mitigazione pragmatica è **evitare del tutto** la combinazione delle tre proprietà nello stesso agente. Willison è esplicitamente scettico verso i "guardrail" commerciali con pretese di "efficacia al 95%", definendoli inaffidabili.

**Dual-LLM pattern** (Willison, originariamente ~2023 — le fonti secondarie divergono tra marzo/aprile 2023, non risolto con precisione): LLM privilegiato (accede ai tool, pianifica) + LLM quarantinato (legge contenuto non fidato, nessun accesso a tool) + orchestratore opzionale che sostituisce riferimenti simbolici. Limite riconosciuto esplicitamente in letteratura: *"the quarantined LLM is still susceptible to prompt injection... can still produce attacker-controlled output"* — il quarantino non è invulnerabile, sposta solo il perimetro del danno.

### 7.3 CaMeL (Google/DeepMind/ETH Zurich, "Defeating Prompt Injections by Design")

Fonte primaria: [arxiv.org/abs/2503.18813](https://arxiv.org/abs/2503.18813), v1 24/03/2025, v2 24/06/2025. Autori: Edoardo Debenedetti, Ilia Shumailov, Tianqi Fan, Jamie Hayes, Nicholas Carlini, Daniel Fabian, Christoph Kern, Chongyang Shi, Andreas Terzis, Florian Tramèr.

Abstract, quote integrale: *"CaMeL, a robust defense that creates a protective system layer around the LLM, securing it even when underlying models are susceptible to attacks. To operate, CaMeL explicitly extracts the control and data flows from the (trusted) query; therefore, the untrusted data retrieved by the LLM can never impact the program flow. To further improve security, CaMeL uses a notion of a capability to prevent the exfiltration of private data over unauthorized data flows by enforcing security policies when tools are called."*

Risultato quantitativo su AgentDojo, dall'abstract: **77% dei task risolti con sicurezza provabile**, contro **84%** di un sistema non protetto — quindi un costo di utility di ~7 punti percentuali per ottenere garanzie di sicurezza formali.

**[NON VERIFICATO DIRETTAMENTE]**: il mandato chiede specificamente la nomenclatura **P-LLM/Q-LLM** e l'**interprete custom**. Il tentativo di fetch del PDF completo è fallito (contenuto binario non estraibile dal tool). Ho solo l'abstract, che conferma "capability" e l'estrazione custom di control/data flow ma **non usa letteralmente i termini "P-LLM"/"Q-LLM"** nel testo che ho potuto ispezionare. Questa terminologia è ampiamente citata da fonti secondarie ma **non l'ho verificata io stesso sul testo integrale** — è quindi un dettaglio "presumibilmente corretto ma non confermato in prima persona" da questo report.

### 7.4 Altri pattern di contenimento

**Design Patterns for Securing LLM Agents against Prompt Injections** ([arxiv.org/abs/2506.08837](https://arxiv.org/abs/2506.08837), pubblicato 10/06/2025, v.finale 27/06/2025; autori Beurer-Kellner, Buesser, Creţu, Debenedetti, Dobos, Fabian, Fischer, Froelicher, Grosse, Naeff, Ozoani, Paverd, Tramèr, Volhejn). Abstract verificato: *"we propose a set of principled design patterns for building AI agents with provable resistance to prompt injection. We systematically analyze these patterns, discuss their trade-offs in terms of utility and security, and illustrate their real-world applicability through a series of case studies."* L'abstract non elenca i pattern per nome — l'elenco (Action-Selector, Plan-Then-Execute, LLM Map-Reduce, Dual LLM, Code-Then-Execute, Context-Minimization) e l'invariante condiviso citato sopra provengono dal commento di Willison al paper ([simonwillison.net/2025/Jun/13/prompt-injection-design-patterns/](https://simonwillison.net/2025/Jun/13/prompt-injection-design-patterns/)), non da mia lettura diretta del corpo del paper — **[PARZIALMENTE VERIFICATO]**: abstract confermato in prima persona, dettaglio dei 6 pattern confermato solo via il commento di Willison, non sul testo integrale del paper.

**Spotlighting (Microsoft)** — fonte primaria [arxiv.org/abs/2403.14720](https://arxiv.org/abs/2403.14720) (20/03/2024, autori Keegan Hines, Gary Lopez, Matthew Hall, Federico Zarfati, Yonatan Zunger, Emre Kiciman). Abstract, quote esatta con i numeri: *"Using GPT-family models, we find that spotlighting reduces the attack success rate from greater than 50% to below 2% in our experiments with minimal impact on task efficacy."* Tre tecniche: delimiting (marcatori randomizzati), datamarking (carattere speciale tra parole), encoding (base64/ROT13). Uso in produzione dichiarato come "Prompt Shields in Azure AI Foundry" [NON VERIFICATO — da fonte secondaria, non ho aperto la documentazione Microsoft Azure per confermarlo].

**Taint tracking / privilege control per agenti** — l'unico paper che ho aperto e quotato direttamente è **Progent** ([arxiv.org/abs/2504.11703](https://arxiv.org/abs/2504.11703), v1 16/04/2025, v3 14/05/2026; autori Tianneng Shi, Jingxuan He, Zhun Wang, Hongwei Li, Linyu Wu, Wenbo Guo, Dawn Song). Abstract, quote: *"Progent represents privilege as a security policy consisting of symbolic rules over tool names and arguments... Each proposed update is determined by an SMT solver to be either a narrowing (applied automatically) or an expansion (requiring explicit approval), ensuring that the agent's effective action space can only shrink without approval (monotonic confinement)."* — è privilege-control basato su policy simboliche + SMT solver, non taint tracking classico in senso stretto. Altri due sistemi citati in letteratura ma **non aperti/quotati da me** [NON VERIFICATO]: FIDES (taint tracking dinamico con label di confidenzialità/integrità, richiede assegnazione manuale iniziale delle label) e NeuroTaint (descritto come "first comprehensive taint tracking framework tailored for... LLM agents").

**Tool-output quarantine** — **nessun pattern standalone con questo nome esatto è emerso nella letteratura cercata**. Il concetto più vicino è il Dual-LLM di Willison (l'LLM quarantinato "assorbe" l'output del tool non fidato) e l'Action-Selector del paper Beurer-Kellner et al. (impedisce che il feedback del tool ritorni all'agente principale). Riporto questo come **finding negativo esplicito**: se in Fase B/C si vuole citare "tool-output quarantine" come pattern a sé, non ho trovato una fonte primaria dedicata — va probabilmente ricondotto a uno di questi due pattern esistenti.

**Human-in-the-loop gating** — non ho individuato un paper accademico dedicato specifico; è coperto come mitigazione nella lista OWASP LLM01 (*"Require human approval for high-risk actions"*) e nel modello di sicurezza di MCP Apps (*"Hosts can require explicit approval for UI-initiated tool calls"*) — trattato in letteratura più come controllo operativo standard che come "pattern di ricerca" a sé.

### 7.5 Benchmark di robustezza

**AgentDojo** — fonte primaria [arxiv.org/abs/2406.13352](https://arxiv.org/abs/2406.13352) (19/06/2024, v3 24/11/2024; autori Debenedetti, Zhang, Balunović, Beurer-Kellner, Fischer, Tramèr). Abstract, quote: *"AgentDojo, an evaluation framework for agents that execute tools over untrusted data... AgentDojo is not a static test suite, but rather an extensible environment for designing and evaluating new agent tasks, defenses, and adaptive attacks."* Numeri: **97 task**, **629 casi di sicurezza**, domini banking/Slack/travel/workspace. Baseline citati da fonti secondarie (non verificati parola per parola sul paper, solo su digest): GPT-4o ~69% utility benigna → 45% sotto attacco; ASR fino a 53,1% per l'attacco canonico "Important message"; con detector secondario come difesa, ASR scende all'8%.

**SOTA attuale [NON VERIFICATO come "leaderboard ufficiale" — solo da aggregatore secondario intelscroll.com, un solo dato ho verificato aprendo il paper originale]**: **PromptArmor** ([arxiv.org/abs/2507.15219](https://arxiv.org/abs/2507.15219), sottomesso 21/07/2025, accettato ICLR 2026; autori Tianneng Shi, Kaijie Zhu, Zhun Wang, Yuqi Jia, Will Cai, Weida Liang, Haonan Wang, Hend Alzahrani, Joshua Lu, Kenji Kawaguchi, Basel Alomair, Xuandong Zhao, William Yang Wang, Neil Gong, Wenbo Guo, Dawn Song) — **verificato direttamente**: false positive rate e false negative rate **<1%** su AgentDojo con GPT-4o/GPT-4.1/o4-mini; attack success rate dopo la difesa **<1%**. Gli autori propongono esplicitamente PromptArmor come *"a standard baseline for evaluating new defenses against prompt injection attacks."* Altri claim di leaderboard 2026 (PromptGuard -67% ASR, AgentWatcher "near-zero ASR") **restano NON VERIFICATI da me** — provengono da un unico aggregatore secondario (intelscroll.com), non ho aperto i paper originali dietro quei nomi.

**InjecAgent** — fonte primaria [arxiv.org/abs/2403.02691](https://arxiv.org/abs/2403.02691) (5/03/2024, v3 4/08/2024; autori Qiusi Zhan, Zhixiang Liang, Zifan Ying, Daniel Kang; pubblicato ACL 2024 Findings). Numeri verificati: **1.054 test case**, **17 tool utente**, **62 tool attaccante**, 30 agenti LLM valutati; ReAct-GPT-4 vulnerabile nel **24%** dei casi, tasso che quasi raddoppia con istruzioni di attacco rafforzate. Questo è un benchmark del 2024 — **non ho trovato un refresh 2026** con nuovi numeri SOTA su InjecAgent specificamente (a differenza di AgentDojo, che ha uno "stato dell'arte" 2026 più attivamente tracciato dalla comunità).

### Tabella mandato 7

| | Cosa dice la fonte primaria | Stato di maturità | Chi lo supporta/misura oggi |
|---|---|---|---|
| OWASP LLM Top 10 | Edizione corrente = **"2025"**, non "2026" (claim del mandato impreciso); LLM01 Prompt Injection #1; "memory poisoning" assente, sostituito da LLM04 Data/Model Poisoning (training-time) | Stabile dal marzo 2025, nessun refresh 2026 trovato | Framework di riferimento red-team/threat-model del settore |
| OWASP Top 10 Agentic ("for 2026") | ASI01-10, framework separato sotto Agentic Security Initiative; ASI06 = Memory & Context Poisoning | Pubblicato 9/12/2025, "hundreds of experts" | Companion, non sostituto, del LLM Top 10 |
| Lethal trifecta (Willison) | 3 condizioni: dati privati + contenuto non fidato + comunicazione esterna; mitigazione = non combinarle | Post divulgativo influente, non uno standard formale | Ripreso in letteratura su design pattern e nel discorso di settore |
| CaMeL | Layer protettivo con capability sulle variabili, estrazione control/data flow custom; 77% vs 84% utility su AgentDojo | Paper accademico (Google/DeepMind/ETH), v2 giugno 2025, codice pubblico | Referenziato come baseline di ricerca, non un prodotto commerciale |
| Spotlighting (Microsoft) | ASR >50% → <2% con 3 tecniche (delimiting/datamarking/encoding) | Paper 2024, dichiarato in produzione come Prompt Shields [non verificato] | Microsoft (claim non verificato indipendentemente) |
| Design patterns (plan-then-execute, dual-LLM, ecc.) | Invariante: input non fidato non deve poter innescare azioni consequenziali | Paper 2025, endorsement esplicito di Willison | Letteratura di riferimento, non un singolo prodotto |
| AgentDojo / InjecAgent | 97 task/629 casi (AgentDojo); 1.054 casi/17+62 tool (InjecAgent) | Benchmark accademici 2024, AgentDojo con SOTA 2026 attivamente tracciato (PromptArmor <1% ASR verificato) | Usati come riferimento di valutazione in tutta la letteratura successiva |

---

## Sintesi per l'orchestratore (da incollare in pitch/ADR)

Tutti e 6 i breaking change MCP 2026-07-28 citati dall'owner sono **verificati veri** sulla fonte primaria (changelog ufficiale con SEP numerati); l'unica sfumatura è temporale, non sostanziale (MCP Apps precede di 6 mesi il core stateless, non nasce con esso). Backward compatibility è reale ma **opt-in a livello SDK**, non garantita dalla spec in sé — un server 2026-07-28 può parlare con client 2025-11-25 solo se implementato per farlo (comportamento di default negli SDK ufficiali TS/Py/Go/C#). Gap di verifica non risolto: nessuna conferma primaria che VS Code parli il protocollo core 2026-07-28 (solo l'extension Apps è tracciata ufficialmente); MCP Tasks ha un SEP "Final" ma un repo di riferimento che si autodichiara ancora "experimental" e **zero client tracciati** in matrice ufficiale, a differenza di Apps (11 host confermati). AGENTS.md e MCP condividono davvero la stessa foundation (AAIF/Linux Foundation, dic. 2025) — claim verificato vero con fonte solida; Agent Skills invece **non** ha alcuna foundation dietro, solo Anthropic + community "open". Due correzioni di fatto importanti da portare in ADR: (1) **non esiste** un "OWASP Top 10 LLM 2026" — l'edizione corrente resta "2025", e "memory poisoning" come categoria nominata vive solo nel documento **separato** OWASP Top 10 for Agentic Applications (ASI06, dic. 2025); (2) OTel GenAI semconv resta interamente in stato **Development**, nessun attributo/span stabile — pinnare oggi significa pinnare uno schema che cambierà. Sul fronte difese: CaMeL (77% vs 84% utility, capability-based) e Spotlighting (ASR 50%→2%) sono i due risultati quantitativi più solidi verificati in prima persona; PromptArmor (<1% ASR/FPR/FNR su AgentDojo, ICLR 2026) è il punto SOTA più recente che ho potuto verificare direttamente sull'abstract. Il "P-LLM/Q-LLM" di CaMeL e la mappatura completa dei 6 design-pattern (plan-then-execute, dual-LLM, ecc.) restano confermati solo a livello di sintesi/commento terzo, non di testo integrale del paper — footnote da tenere se la Fase C (ingegnere ostile) li userà per argomentazioni fini.
