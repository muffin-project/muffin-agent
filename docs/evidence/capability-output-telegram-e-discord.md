# M3 — Capability di output Telegram vs Discord + stato genUI — 2026-08-09

> Report scout, consegnato inline e persistito dall'orchestratore. Metodo: fetch diretto delle doc ufficiali (Telegram Bot API + changelog, Discord developer docs, MCP SEP-1865, Microsoft Bot Framework, Hermes). Context7 non disponibile in sessione → fetch diretto (fonte primaria comunque). Non ri-derivato: pipeline satori→resvg / Vega-Lite / WCAG (ADR-0023), contratto blocchi tipati (ADR-0016), MCP 2026-07-28 + SEP-1865 meccanica (a3-standard), limiti file base Telegram (b3).

## Scoperta principale — Telegram `sendRichMessage` (Bot API 10.1/10.2), post-cutoff

**[VERIFICATO — changelog ufficiale, quote verbatim + 4 fonti indipendenti]**. `core.telegram.org/bots/api-changelog`:
- **11/06/2026, Bot API 10.1**: *"Added support for Rich Messages, allowing bots to send highly structured text and stream AI-generated replies with seamless rich formatting."* — `sendRichMessage`, `sendRichMessageDraft` (stream parziale), `rich_message` su `editMessageText`.
- **14/07/2026, Bot API 10.2**: `InputRichMessageMedia`, campo `blocks` su `InputRichMessage`.

21 classi `RichBlock*` (incl. **Table, Details, MathematicalExpression, Collage, Slideshow, List, BlockQuotation, PullQuotation, Thinking**) + 25 `RichText*` inline. Limite **32.768 caratteri** (corroborato 3×: changelog, Durov via testingcatalog, spec repo). **Live sui client** (Desktop 7.0.9, iOS/Android 12.9.1, luglio 2026). **Vercel Chat SDK** ha già shippato supporto (fallback dichiarato: *"plain strings, raw messages, cards, and captions continue to work exactly as before"* — additivo, non breaking). **Hermes** lo tratta **opt-in** (`rich_messages: true`; default resta MarkdownV2 con fallback automatico se Telegram rifiuta).

Schema di dettaglio (500 blocchi, 16 nesting, 50 media, 20 colonne tabella) da **singolo repo community** — plausibile, non allo stesso livello del changelog. `sendRichMessageDraft` solo chat private.

**Perché conta**: prima dell'8 giugno una tabella dati su Telegram richiedeva satori→resvg; oggi ha un **percorso nativo** (`RichBlockTable`). Discord non ha equivalente (markdown senza tabelle). ADR-0023/0025 non lo conoscevano.

## Telegram — capability di output

- **Inline/reply keyboard** [VERIFICATO `core.telegram.org/bots/api`]: `InlineKeyboardButton` porta esattamente una azione (`url`/`callback_data` **1-64 byte**/`web_app`/`login_url`/`copy_text`/…). "8 bottoni per riga / 100 totali" **NON documentato** (gap ereditato da b3, riconfermato negativo).
- **Web Apps / Mini Apps** [VERIFICATO `core.telegram.org/bots/webapps`]: webview HTML/JS/CSS pieno. 4 modalità di lancio (bottone `web_app`, Menu Button, link `t.me/<bot>/<app>`, attachment). Bridge obbligatorio `window.Telegram.WebApp` (`ready/expand/sendData/MainButton/…`). `sendData` **max 4096 byte**. Validazione `initData` via HMAC-SHA256. Storage: CloudStorage 1024 item, DeviceStorage 5MB, SecureStorage 10 item. **Sistema separato**: server HTTPS proprio, non "gratis" come sendPhoto.
- **File** [b3 + 1 nuovo]: sendMessage 1-4096 · caption 0-1024 · foto multipart 10MB · altri 50MB · getFile 20MB · self-hosted 2000MB · mediaGroup 2-10. **NUOVO [PARZIALMENTE VERIFICATO]**: `sendPhoto` **ricomprime sempre in JPEG**; `sendDocument` preserva byte-per-byte → un grafico resvg va mandato via `sendDocument`, non `sendPhoto`, o perde nitidezza.
- **Formattazione** [PARZIALMENTE VERIFICATO via grammy.dev/ref]: HTML = 3 char da escapare (`& < >`), MarkdownV2 = 18 char — conferma ADR-0025.

## Discord — capability di output [VERIFICATO, fetch diretto docs.discord.com 2026-08-09, chiude i gap 403 di b3]

- **Embeds**: title 256 · description 4096 · field.name 256 · field.value 1024 · footer 2048 · author.name 256 · max **25 field** · **max 10 embed/messaggio** · **6000 char combinati** su tutti gli embed · richiesta max invio **25 MiB**.
- **Message Components**: Action Row = 5 bottoni **o** 1 select. Button: `label` 80, `custom_id` 1-100, link url 512. Select: max 25 opzioni. Text Input (modali): 4000 char. **Components V2: max 40 componenti/messaggio, MUTUAMENTE ESCLUSIVO con `content`/`embeds` legacy** (*"disables traditional content and embeds"*, irreversibile per messaggio). → il renderer Discord sceglie per-messaggio fra (a) content+10 embed o (b) 40 componenti V2 senza embed.
- **File** [PARZIALMENTE VERIFICATO, support.discord.com 403]: 10MB free / 50 Nitro Basic / 500 Nitro / boost L2 50MB / L3 100MB (personale e server non si sommano). Drop 25→10MB annunciato ufficialmente set-2024.
- **Markdown**: bold/italic/underline(`__`)/strike/spoiler/header/liste/quote/code — **NO tabelle, NO immagini-markdown, NO HTML**. È la divergenza più netta con Telegram Rich Messages.

## genUI / MCP Apps

- **MCP Apps (SEP-1865)** [VERIFICATO]: 11 host ufficiali, **Telegram e Discord assenti** (né bot né client). Nessuna integrazione nativa trovata. La spec stessa prevede come unico fallback per host non-iframe uno **screenshot** (html2canvas) — **precluso in Muffin** dal taglio di Chromium già deciso in ADR-0016. Quindi su Telegram/Discord un `ui://` resource è consumabile solo come risultato testuale ordinario del tool, se il server lo fornisce separatamente.
- **Telegram Mini App vs MCP Apps**: stesso problema (HTML lanciato da bottone + bridge bidirezionale), **due bridge incompatibili** (`window.Telegram.WebApp` vs JSON-RPC-over-postMessage). Nessun ponte automatico `ui://` → Mini App: andrebbe scritto un adapter.

## Capability-modeling nei framework

- **Microsoft Bot Framework** [VERIFICATO, il più maturo]: capability per-canale come **tabelle esplicite** (degradazione card Yes/Image/Text/Partial/No; action count per canale — Telegram 100/100, Slack None/100, Facebook 11/3, Teams None/3). Principio dichiarato: *"Even if a channel can render a card type, the channel may not support all features... test each card."*
- **Hermes** [VERIFICATO]: tabella statica "Platform Comparison" (24 piattaforme) per connector standard + negoziazione a handshake **solo** nel path sperimentale Relay.
- **Gap dichiarato**: nessun framework osservato espone capability come **filtro dinamico sul tool-registry** offerto al modello — tutti modellano le capability come **dato per il renderer**, non come tool condizionali. (Conferma Scout A: i bottoni sono un tool universale reso a valle.)

## Tabella numeri Telegram vs Discord

| Capability | Telegram | Discord |
|---|---|---|
| Testo messaggio | 4096 · **32.768 con Rich Messages** | 2000 legacy [non ricercato in primaria] |
| Caption media | 1024 | n/a (nel `content`) |
| Azione per bottone | `callback_data` 1-64 byte | `custom_id` 1-100 char |
| Budget componenti/msg | n/a | 40 (V2) |
| Tabelle native | **Sì** (`RichBlockTable`) | **No** — immagine o code block |
| Embed/card per msg | n/a | 10, 6000 char combinati |
| Upload immagine | 10MB (JPEG se sendPhoto) | 10 free / 50 Nitro Basic / 500 Nitro |
| Download max | 20MB (getFile) | 25 MiB richiesta |
| Dashboard HTML nativa | Sì (Mini App, server proprio) | No |
| MCP Apps host | No | No |

## Claim rigettati / cautela

"8 bottoni/riga Telegram" (non primario). "8MB Discord" (stale, oggi 25 MiB richiesta / 10MB file). `sendRichMessage` "troppo nuovo per essere vero" → **verificato vero** su 4 fonti incluso il changelog ufficiale (esempio di falso-positivo evitato con verifica avversariale). Schema dettaglio Rich Messages = singolo repo community, cautela.

## Aperto

Lunghezza `answerCallbackQuery.text`; schema JSON completo `InputRichMessage`/`RichBlockTable` (pagina reference troppo grande per il fetch); degradazione client Telegram vecchi; max allegati Discord (community: 10); compressione immagini lato Discord (segnale debole).

## Addendum 2026-08-17 — `sendMessageDraft`: contratto completo, e un parametro che mancava in produzione

```
scritto: 2026-08-17
verificato: 2026-08-17
verificato-contro: Context7 (mirror di core.telegram.org/bots/api, trust score 10) + core.telegram.org/bots/api-changelog via WebFetch diretto; incrociato coi sorgenti del vecchio Muffin (telegram_draft.ts) per il caso d'uso, non per il contratto
modello-strumenti: Claude Sonnet 5, Context7 MCP (resolve-library-id + get-library-docs) e WebFetch; repo clonato e letto, non eseguito contro un bot reale (nessun token in questo ambiente)
invaliderebbe: una revisione della Bot API che cambi la tabella parametri di sendMessageDraft, o una prova diretta (con token reale) del comportamento di rinnovo della finestra dei 30s
estende: questo file (sezione "Telegram — capability di output" sopra, che cita sendRichMessageDraft ma non la sendMessageDraft non-rich verificata qui) e ADR-0025 (che ne descriveva il contratto dalla sola storia del vecchio Muffin, mai controllata qui)
```

**Perché questa ricerca.** M5-BIS B11 (streaming — "la risposta arriva mentre si forma") doveva scegliere fra `sendMessageDraft` e il pattern placeholder+`editMessageText` per le chat private. La domanda che decide: `sendMessageDraft` è disponibile a un bot normale, e con quale contratto esatto? Una risposta sbagliata in una direzione (assumerlo disponibile quando non lo è) avrebbe rotto lo streaming in chat privata; nell'altra (scartarlo quando è disponibile) avrebbe buttato via il canale più pulito dei due.

**Trovato.**

- **Disponibile a ogni bot, non solo business.** Aggiunto in Bot API 9.3 (2025-12-31), inizialmente business-bot-only; aperto a tutti i bot in Bot API 9.5 (2026-03-01, changelog: *"Allowed all bots to use the method sendMessageDraft"*). Oggi (2026-08-17) è disponibile da oltre cinque mesi — non è più il caso limite "troppo nuovo" da trattare con cautela extra.
- **Parametri esatti** (tabella completa, non solo gli esempi citati altrove in questo file): `chat_id` (Integer, richiesto, **chat privata**), `message_thread_id` (Integer, opzionale), **`draft_id` (Integer, richiesto, non-zero)**, `text` (String, opzionale, 0-4096 caratteri), `parse_mode` (opzionale), `entities` (opzionale). Ritorna `True`.
- **`draft_id` era assente dalla nostra implementazione.** `connectors/telegram/api.ts` chiamava il metodo con `{chat_id, text, parse_mode}` — mai `draft_id`. Ogni chiamata in produzione falliva con 400, inghiottita in silenzio dal wrapper `safely()` di `presence.ts` (che esiste apposta per non far cadere un turno per un fallimento di sola presenza — corretto come principio, ma qui nascondeva un metodo mai davvero riuscito). Corretto in `slice/streaming`: `sendMessageDraft(chatId, draftId, text)`, con un contatore di processo che genera un `draft_id` non-zero per ogni presenza. Voce gemella in `docs/lessons.md`.
- **Non stabilito**: se una chiamata successiva con lo stesso `draft_id` rinnova la finestra di anteprima di ~30 secondi o no. La documentazione descrive il metodo come pensato per lo streaming (chiamate ripetute mentre il testo si genera), il che sarebbe incoerente con una finestra che nessuna chiamata rinnova — ma non lo dichiara esplicitamente in nessuna delle due direzioni, e non c'era un token con cui provarlo in questo ambiente. La mitigazione operativa non dipende dalla risposta: chiamare almeno una volta al secondo durante lo streaming attivo resta dentro qualunque lettura ragionevole di "~30 secondi", rinnovata o no.
- **Il gruppo non è confermato rispondere con un codice d'errore specifico.** Il vincolo verificabile è solo che `chat_id` è documentato come "the target **private** chat" — l'assenza di supporto ai gruppi è reale, il nome dell'errore attribuito altrove (`TEXTDRAFT_PEER_INVALID`) non è confermato da questa fonte.

**Cosa non si è potuto stabilire**: il comportamento esatto di rinnovo della finestra (sopra); se `sendMessage` con lo stesso `draft_id` "solidifichi" il draft in un messaggio vero in una sola chiamata Bot API, o se sia semplicemente che un messaggio reale in arrivo fa sparire qualunque anteprima effimera lato client, indipendentemente da un collegamento esplicito fra i due — la documentazione di `sendMessage` non elenca `draft_id` fra i suoi parametri, il che pesa verso la seconda lettura ma non la conferma. L'implementazione (`connectors/telegram/connector.ts`) non assume nessuna delle due: manda sempre un `sendMessage`/`editMessageText` normale a fine turno, indipendentemente da cosa succeda al draft.

## Fonti

core.telegram.org/bots/{api,api-changelog,webapps}; docs.discord.com/developers/{resources/message,components/reference,components/overview}; modelcontextprotocol.io/seps/1865; learn.microsoft.com/.../bot-service-channels-reference; hermes-agent.nousresearch.com/docs; testingcatalog.com; vercel.com/changelog; grammy.dev/ref/types/parsemode. Baseline non ri-derivata: ADR-0016/0021/0023/0025, a3-standard, b3-media-rendering.

**Addendum 2026-08-17**: Context7 (`/websites/core_telegram_bots_api`, mirror di core.telegram.org/bots/api) + core.telegram.org/bots/api-changelog via WebFetch diretto.
