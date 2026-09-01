# B3 — Media: ingestione e rendering (Fase D) — agosto 2026

> Report dello scout B3, consegnato inline e persistito dall'orchestratore. Contratto: solo evidenza con fonte, niente verdetti. **[VERIFICATO]** = fonte primaria aperta con quote; **[PARZIALMENTE VERIFICATO]** = fonte aperta con dettaglio parziale o più secondarie concordi; **[NON VERIFICATO]** = solo sintesi di ricerca. Vincolo di progetto già deciso in Fase C e non rimesso in discussione: **niente browser headless** (ADR-0016).

## A.1 Come i sistemi reali ingeriscono i media

| Sistema | Immagini | Audio | Video | PDF | File generici |
|---|---|---|---|---|---|
| **OpenClaw** | Se il modello supporta vision, l'originale passa al modello senza elaborazione; altrimenti "Media Understanding" genera un blocco testuale `[Image]`. **OCR non è nel default** (skill opzionale) | Trascrizione → variabile `{{Transcript}}` | Frame via skill opzionale ffmpeg, non di default | Renderizzato come immagine se l'estrazione testo è insufficiente | PNG/JPEG/WebP/HEIC + PDF; default: solo il primo allegato per tipo |
| **Hermes** | Routing per capability: vision-capable → content-block base64 nativo; text-only → tool `vision_analyze`. Salvataggio in `~/.hermes/images/` | non trovato | non trovato | non trovato (solo output) | Kanban: allegati max **25 MB**, il worker legge via tool fs generici |
| **Khoj** | **OCR** (RapidOCR/ONNX), non captioning | non trovato | non trovato | `PyMuPDFLoader`, pagina per pagina, split a 256 token, **non layout-aware** | Processor dedicati per docx/github/markdown/notion/org/pdf/plaintext |
| **Letta** | Pass-through **diretto** al modello vision (URL o base64), nessuno step intermedio; se il provider non supporta vision, appare come messaggio testuale placeholder | — | — | — | — |
| **Odysseus** | Vision legata al browser-tool MCP, non a un path di ingestione | STT **locale** via `faster-whisper`, limite default **25 MB** | non trovato | PyMuPDF per rendering nel viewer | **`markitdown`** (Microsoft): docx/xlsx/pptx/epub → Markdown |
| **NotebookLM** | Analizzate dentro i documenti caricati | Sorgente diretta (MP3/WAV) | **Non ingerito come file** — solo trascrizione di URL YouTube | Sì | Limite **500.000 parole o 200 MB per sorgente**, 50 sorgenti free |
| **Obsidian + plugin** | OCR Extractor (Tesseract locale o Mistral OCR cloud); Text Extractor (Tesseract.js + pdf-extract) | — | — | via pdf-extract | Smart Connections: embedding **locale** `bge-micro-v2` (384 dim) in `.smart-env` dentro il vault |
| **Mem0** | **Captioning a ingestion-time**: vision model estrae testo/dettagli → diventa **memoria testuale standard** (nessun embedding d'immagine) | — | — | — | — |
| **Supermemory** | OCR (JPG/PNG/GIF/WebP) | — | Auto-transcription per YouTube/MP4 | OCR per scan + text extraction | Endpoint unico `POST /v3/documents/file` |

**Due osservazioni trasversali verificate.**
1. **Nessuno dei 9 sistemi tratta il video come prima classe**: assente, ridotto a solo-audio, o skill opzionale. Nessuna fonte primaria descrive frame-sampling di default.
2. **Le immagini hanno due poli, e nessun sistema li fa entrambi**: (a) captioning/OCR a testo permanente (Khoj, Mem0, Supermemory) — l'immagine diventa testo indicizzabile; (b) pass-through nativo al modello a request-time (Letta, Hermes, OpenClaw) — l'immagine resta immagine, niente di persistente. È una scelta binaria in tutti i sistemi osservati.

## A.2 Librerie Node — dati da registry.npmjs.org, fetch 2026-08-04

**PDF**: `pdf-parse` 2.4.5 (20,27 MB) — **[claim rigettato]** non è più puro JS: dipende obbligatoriamente da `@napi-rs/canvas`. `pdfjs-dist` 6.2.108 (32,90 MB, 0 dipendenze, motore di Firefox, può rasterizzare pagine). `unpdf` 1.8.0 (2,04 MB, 0 dipendenze, wrapper moderno su pdfjs). `pdfreader` 3.0.8 — unico con column-detection euristica su coordinate, si degrada su celle unite.
**[Gap]** Nessuna libreria Node fa layout-aware vero (ML/vision): quello vive in Python (`marker-pdf`, `unstructured.io`).

**Office**: `mammoth` 1.12.0 (docx→HTML/testo, attivo). `exceljs` 4.4.0 — **fermo da ottobre 2023**, discussion ufficiale "Intent to fork — maintainers attention required", ~12M download/settimana per inerzia. `xlsx` (SheetJS) — **[claim rigettato]** su npm è fermo alla 0.18.5 del 2022: SheetJS ha lasciato il registro npm, le build correnti stanno solo su `cdn.sheetjs.com`.

**OCR**: `tesseract.js` 7.0.0 (puro WASM, nessuna dipendenza nativa, scarica core e dati lingua a runtime). `node-tesseract-ocr` stale dal 2021 (wrapper sul binario di sistema).

**Video**: **[claim rigettato, importante]** `fluent-ffmpeg` è **archiviato dal 2025-05-22** — *"no longer maintained and no longer works properly with recent ffmpeg versions"*; il maintainer raccomanda esplicitamente di non usare un wrapper: *"study ffmpeg command line and write the correct command line once"*. Nessun successore su npm. Pattern verificato: `ffmpeg-static` (GPL-3.0!) o binario di sistema + invocazione via `execa` (10.0.1, molto attivo).

**EXIF**: `exifr` (puro JS, 0 dipendenze, ~2,5ms/immagine); `piexifjs` unico con scrittura.

## A.3 Vault: cosa si salva vs cosa si indicizza — tre pattern

- **Khoj**: indice di testo+embedding, **non custode del binario**. `FileObject.raw_text` è `TextField`, non BLOB: il file originale resta dov'è, il DB replica solo testo estratto ed embedding.
- **Paperless-ngx**: custode a tre livelli — originale, archivio PDF OCR'd searchable, thumbnail WebP; **SHA-256 su originale e archivio** per integrità e dedup; l'OCR viene **saltato** se il PDF ha già un layer testo.
- **Obsidian/Smart Connections**: il vault resta la fonte di verità, il plugin aggiunge solo embedding locali in `.smart-env` (indice non distruttivo sopra file esistenti).

## B.4 Generare immagini senza browser

| Libreria | Versione | Peso pkg | Nativo | Velocità | Limiti verificati |
|---|---|---|---|---|---|
| `satori` (Vercel) | 0.29.0 (2026-07-23) | 5,18 MB | **No** (gira anche su edge) | — | **Solo flexbox** (motore Yoga), niente CSS Grid/calc/transform-3D/kerning/RTL. Font **TTF/OTF/WOFF, non WOFF2** (attenzione: Google Fonts serve WOFF2). **Emoji**: nessun font integrato, va fornito come immagine via `loadAdditionalAsset`. README: *"does not guarantee that the SVG will 100% match the browser-rendered HTML"* |
| `@resvg/resvg-js` | 2.6.2 stabile (alpha fino a feb 2026) | 0,04 MB + binario | **Sì** (Rust/napi, binari precompilati per tutte le piattaforme) | Benchmark README: 12 ops/s vs sharp 9, skia-canvas 7, svg2img 6 | Niente color-font emoji nativo (issue upstream) — **ma il limite si aggira** nel pattern con satori, che converte l'emoji in immagine prima di produrre l'SVG |
| `sharp` | 0.35.3 (2026-07-01) | 0,91 MB + libvips | Sì | — | Non è un motore di layout: resize/formato/compositing su raster già prodotti |
| `@napi-rs/canvas` | 1.0.3 (2026-07-28) | 0,12 MB + binario | Sì (Skia, **zero node-gyp**) | "simple house" 14ms, il più veloce nel test; 37 ops/s vs 30 di `canvas` | API Canvas 2D drop-in |
| `canvas` (node-canvas) | 3.2.3 | 0,38 MB + Cairo | Sì (richiede prebuild o node-gyp) | più lento di @napi-rs/canvas | dipendenza di `chartjs-node-canvas` |

**Pipeline canonica verificata**: `satori` (JSX/HTML→SVG) + `resvg-js` (SVG→PNG) è **la combinazione usata da `@vercel/og`**. Nessuno step richiede browser o rete.

## B.5 Grafici e tabelle server-side

- **Vega / Vega-Lite**: `view.toSVG()` **non richiede alcuna dipendenza nativa** — il pacchetto base non include node-canvas (serve solo per il PNG diretto). Versioni attive (vega 6.3.1, vega-lite 6.4.3).
- **chartjs-node-canvas**: API Chart.js completa, ma dipendenza nativa (Cairo) fin dall'inizio.
- **Plotly**: **[claim rigettato]** strutturalmente incompatibile col vincolo no-browser in **entrambi** i percorsi ufficiali — il pacchetto npm `plotly` è un wrapper HTTP verso l'**API cloud**; Kaleido dalla v1 **non include più Chromium** e richiede un Chrome di sistema.
- **d3 + jsdom**: puro calcolo, produce SVG, serve un rasterizzatore separato.
- **QuickChart** (AGPL-3.0, self-hostabile): Chart.js + node-canvas, **niente browser**, dichiarato esplicitamente per *"embedding in non-dynamic environments such as email, SMS, chat rooms"* — implementazione di riferimento già in produzione per questo esatto caso d'uso.

## B.6 Cosa renderizzano davvero i connector (fonti primarie)

**Telegram** ([core.telegram.org/bots/api](https://core.telegram.org/bots/api), fetch diretto):
- `sendMessage`: **1–4096 caratteri** · caption (photo/document/video): **0–1024** · foto via multipart: **10 MB** · altri file: **50 MB** · **`getFile` (scaricare un file ricevuto): max 20 MB** — vincolo diretto sull'*ingestione*, non sull'output · Bot API self-hosted: upload fino a **2000 MB** · `sendMediaGroup`: **2–10 elementi** · `callback_data`: **1–64 byte**.
- MarkdownV2: i caratteri `_ * [ ] ( ) ~ \` > # + - = | { } . !` vanno escapati; **l'escaping non è permesso dentro le entity** (bisogna chiudere e riaprire).
- Mini App: sistema **separato**, richiede HTML/JS su **server HTTPS proprio** — non è "gratis" come photo/document.
- **[NON VERIFICATO]** il limite "8 bottoni per riga / 100 totali" non compare in nessuna delle due pagine primarie ispezionate.

**Discord** ([docs.discord.com/developers/resources/message](https://docs.discord.com/developers/resources/message)): embed `title` 256 · `description` 4096 · `field.name` 256 · `field.value` 1024 · `footer` 2048 · max 25 campi · **totale combinato su tutti gli embed: 6000 caratteri**. Allegati: il "8MB per i bot" è **[claim rigettato]** — viene da un commento non-staff ed è storicamente superato (8→25→10 MB tra 2023 e 2024).

**Slack** ([docs.slack.dev/reference/block-kit](https://docs.slack.dev/reference/block-kit/blocks)): 50 blocchi per messaggio · section `text` 3000 · `fields[]` max 10 da 2000 · **Image block richiede un `image_url` pubblicamente raggiungibile o un `slack_file`: nessun upload binario dentro Block Kit**.

**Asimmetria strutturale**: Telegram e Discord accettano upload binario nella stessa chiamata del messaggio; **Slack richiede che l'immagine sia già hostata a un URL pubblico**. Un renderer "genera e invia" pensato per Telegram non si porta 1:1 su Slack senza un passo di hosting.

## B.7 Prior art e contro-argomenti

**Chi lo fa**: QuickChart (self-hostabile, AGPL, esplicitamente per chat/email/SMS, 500 commit); bot Telegram che consegnano dashboard giornaliere come PNG **[NON VERIFICATO in profondità]**.

**Contro-argomento primario — WCAG 1.4.5 "Images of Text"** ([w3.org/WAI/WCAG21/Understanding/images-of-text.html](https://www.w3.org/WAI/WCAG21/Understanding/images-of-text.html), fetch diretto): *"If the technologies being used can achieve the visual presentation, text is used to convey information rather than images of text"*, con eccezioni solo per contenuto *customizable* o *essential* (loghi, campioni di font). Rationale: chi ha bisogno di adattare dimensione, contrasto o spaziatura **non può farlo su un'immagine**. Un report numerico o una tabella dati **non rientrano** nell'eccezione.

**Contro-argomento "non cercabile/non copiabile"**: **[PARZIALMENTE VERIFICATO]** — evidenza per analogia (bug report pubblici su testo non selezionabile in interfacce conversazionali + letteratura di accessibilità sul testo dentro immagini che diventa illeggibile se ingrandito), non un caso 1:1 documentato di "un bot mi ha mandato un grafico e non ho potuto copiare i numeri".

## Gap dichiarati

Video come file caricato in chat non confermato per Odysseus/Hermes; embed-count Discord e limite allegati bot non confermati su pagina ufficiale (403); bottoni-per-riga Telegram non trovato in fonte primaria; nessuna libreria Node layout-aware per PDF; il peso reale a install delle librerie con binding nativi non misurato (`unpackedSize` copre solo il pacchetto JS).
