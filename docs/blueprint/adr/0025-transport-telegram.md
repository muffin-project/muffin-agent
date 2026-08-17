# ADR-0025 — Telegram: nessuna libreria a runtime, un confine tipato

**Data:** 2026-08-06
**Stato:** accettata
**Contesto di ricerca:** scout dedicato (transport TS 2026 senza Telegraf), che ha letto il codice del vecchio Muffin oltre alle fonti esterne.
**Direttiva owner:** *"non usiamo telegraf please"*.

---

## Contesto

M4 è il connector Telegram. Il vecchio Muffin usava Telegraf e ha prodotto un god-file da 2.926 righe, poi rifattorizzato in 11 PR. La domanda ovvia — "quale libreria al posto di Telegraf" — è quella sbagliata, e la ricerca lo ha dimostrato correggendo una premessa che avevo dato per buona.

## La correzione che cambia la decisione

**Il god-file non era colpa di Telegraf.** La diagnosi originale del refactor (`telegram_layer_refactor.md`) nomina come causa radice **TG-BOUNDARY**: l'assenza di un confine tipato fra `gateway.ts` e il layer Telegram. Il gateway conosceva `MAX_TELEGRAM_LENGTH`, costruiva footer specifici di Telegram, emetteva stato come stringhe-emoji. Nessuna delle nove diagnosi accusa un difetto di design di Telegraf, e il fix che ha funzionato (ADR-144, `TelegramTransport`/`StatusEvent` in un modulo neutro) **è indipendente dalla libreria**: funzionerebbe identico con qualunque transport.

Questo è il contenuto vero della decisione: **il pezzo di valore è il confine, non la libreria.** La libreria è un dettaglio dietro il confine, sostituibile quasi a costo zero proprio perché il confine esiste.

**Telegraf va comunque escluso, ma per la ragione giusta**: è **abbandonato a monte**. Ultima release `v4.16.3` del 2024-02-29 — due anni e mezzo. `@telegraf/types` fermo a 9.2.1 da undici mesi, quindi indietro di almeno tre versioni di Bot API (10.0, 10.1, 10.2 sono uscite fra maggio e luglio 2026). La direttiva dell'owner era giusta; la motivazione che le avevo attribuito no.

## Decisione

**Raw `fetch` (nativo, Node ≥22) + `@grammyjs/types` importato come `import type`, dietro un confine tipato `TelegramTransport`.**

Quattro ragioni, in ordine di peso:

1. **Il kernel di policy possiede i permessi.** grammY (`Bot`), GramIO e `node-telegram-bot-api` offrono tutti un modello a ctx/middleware/sessione, che invita a mettere lì l'autorizzazione. Usare un client sottile evita il problema alla radice: il transport non ha nessuna nozione di *chi sei*.
2. **Un solo motore.** L'invariante di questo progetto è un loop unico per tutte le superfici. Una libreria che possiede il proprio ciclo di vita polling/webhook è un secondo motore con la propria idea di sessione.
3. **La scala non chiede niente di ciò che una libreria risolve.** Un owner più poche chat di gruppo: nessuna concorrenza da sequenziare, nessuna coda anti-rate-limit (il limite globale è ~30 msg/s, irraggiungibile), nessuno scaling multi-processo.
4. **La Bot API si muove più in fretta dei wrapper** — tre versioni in due mesi. Il vecchio Muffin ha già dovuto scavalcare Telegraf con raw fetch per `sendMessageDraft`, `sendDocument`/`sendPhoto` e `getFile`: cioè per tutto ciò che conta davvero per un agente conversazionale. Se il wrapper viene scavalcato dove serve, il suo valore marginale sul resto è sottile.

**Costo runtime dei tipi: zero byte.** `@grammyjs/types` dichiara `"dependencies": {}` ed è generato dallo schema ufficiale — v4.0.0 pubblicata il giorno dopo Bot API 10.2.

### Scelte operative che vengono con la decisione

- **Long polling, non webhook.** È la raccomandazione ufficiale in assenza di ragioni contrarie, e nessun vantaggio del webhook si applica qui: il costo/CPU su piattaforme auto-scaling è irrilevante per un processo always-on, mentre i costi (endpoint pubblico raggiungibile sempre, certificato, porte 443/80/88/8443, IP Telegram da due range solo-IPv4) sono puri.
- **HTML, non MarkdownV2.** MarkdownV2 richiede l'escaping di **18 caratteri**, fra cui `.` e `-`: caratteri che compaiono in ogni frase di prosa normale. Un modello che genera testo libero rompe MarkdownV2 quasi a ogni output. HTML ne richiede **3** (`& < >`). Non è preferenza stilistica, è 18 contro 3.
- **Un retry dopo `sleep(retry_after + jitter)` sui 429, senza coda né mappa di cooldown.** Il vecchio Muffin ha rimosso deliberatamente coda e cooldown (ADR-133) perché creavano più bug di quanti ne risolvessero.

## Le tre trappole, che entrano nel design dal giorno 1

Non sono rischi teorici: sono incidenti già pagati dal sistema precedente.

1. **`sendMessageDraft` ha un TTL fisso di ~30 secondi che nulla estende** — nemmeno richiamarlo. E i turni reali con tool durano 15-35 secondi di mediana, spesso più. Il vecchio Muffin ha rimosso il keepalive scommettendo su risposte sotto i 30s (ADR-133) e ha dovuto ripristinarlo due settimane dopo (ADR-138), con in mezzo un bug reale: la bolla che sparisce e l'utente che fissa il vuoto. Il keepalive esiste dal primo giorno. Vale solo per le chat private: nei gruppi il draft non esiste (`TEXTDRAFT_PEER_INVALID`) e il pattern è *il messaggio che diventa la risposta* — manda subito uno stato, poi `editMessageText` sullo stesso messaggio.
2. **Il chunking misura la lunghezza dell'HTML renderizzato, non del testo grezzo**, e non spezza mai dentro un tag, un'entità o un fence aperto. Il limite è 4096 caratteri (1024 per le caption). Un `slice(0, 4000)` sul markdown grezzo passa ogni test manuale e fallisce in produzione esattamente quando la risposta è lunga e formattata: l'espansione `**bold**` → `<b>bold</b>` supera il limite e Telegram risponde 400, perdendo l'intera risposta. È il bug TG-01, severità alta, messaggi persi in produzione.
3. **L'offset di `getUpdates` si conferma solo dopo la scrittura durevole, mai prima.** Telegram garantisce di non rimandare un update una volta che l'offset lo ha superato — quindi se il processo muore fra il conferma e l'elaborazione, **quel messaggio dell'owner è perso per sempre**, e non è un errore che si vede in test. L'update va scritto in una tabella durevole appena arriva, con `update_id` come chiave di dedup, e solo dopo l'offset avanza. Il recovery dopo un crash è "riprendi dalle righe non processate".

Minori ma reali: `file_path` di `getFile` è valido ~1 ora e non va mai persistito; il download via Bot API pubblico è limitato a 20 MB (upload 50 MB); un solo `getUpdates` per token, quindi un riavvio sporco produce `409 Conflict` finché il processo precedente non lascia.

## Alternative scartate

**grammY `Bot`** — libreria eccellente e viva (release v1.45.1 il 2026-07-17, ~935 commit), scartata non per qualità ma perché impone un secondo modello di controllo. **grammY `Api` standalone** — usabile senza `Bot`, middleware o sessione, ed è il **fallback dichiarato** se il multipart/FormData a mano risulta più costoso del previsto: costa 4 dipendenze piccole e il confine tipato rende lo scambio quasi gratuito. Non è una porta che questa decisione chiude.

**`node-telegram-bot-api`** — la mia aspettativa era che fosse morto. **Falso, verificato**: riscrittura in TypeScript, `v1.2.0` del 2026-07-14, zero dipendenze, maintainer originale attivo. Scartato comunque perché resta un modello `EventEmitter`/classe monolitica che possiede il proprio ciclo di vita.

**GramIO** — alternativa TS-first ESM-puro, `@gramio/types` traccia la versione Bot API nel proprio numero. Interessante, ancora pre-1.0 (v0.13.0): superficie meno stabile, nessuna ragione per preferirlo ai tipi di grammY oggi.

**MTProto (gramjs/Telethon-style)** — la premessa "serve per gli account utente, non per i bot" è **imprecisa**: MTProto è il protocollo sotto entrambi e dà più controllo anche a un bot registrato. La conclusione resta, per una ragione più forte: il suo caso d'uso reale è il self-bot, esplicitamente contro i ToS di Telegram, con ban documentati. L'account di Telegram è il canale primario dell'owner e nessun vantaggio di MTProto giustifica quel rischio.

**Una coda anti-rate-limit** — non necessaria ai numeri veri (~1 msg/s per chat, ~20/min per gruppo, ~30/s globale), e già provata controproducente.

## Conseguenze

**Più facile**: il transport è sostituibile, i tipi seguono la Bot API entro giorni senza attendere una release di libreria, e nessun framework ha un'opinione su chi è autorizzato.

**Più difficile, dichiarato**: il multipart/FormData per gli upload e il parsing difensivo degli `Update` a runtime li scriviamo noi. I tipi solo-compile-time non proteggono da una forma inattesa — campi opzionali che a volte sono assenti, a volte `null`, a volte array vuoto. E ogni metodo nuovo si aggiunge a mano dal changelog. Sono costi reali, non trascurabili: la ragione per accettarli è che il vecchio Muffin **ha già dimostrato di saperlo fare** (raw fetch e FormData per draft, documenti e `getFile` sono in produzione oggi) e che il conteggio delle dipendenze qui è trattato come valore.

**Stima**: 750-1050 righe TypeScript per il transport v1, test esclusi — ancorata al codice reale del sistema precedente (1.474 righe di solo `adapter/` dopo due mesi di incidenti). È un pavimento, non un tetto.

---

## §revisione 2026-08-17 — `sendMessageDraft` verificato sui contratti ufficiali, un parametro mancante trovato (M5-BIS B11)

Direttiva owner sulla slice `slice/streaming`: *"quando prendi dal vecchio Muffin, assicurati che le cose siano corrette e non buggate, né in origine né quando le spostiamo da noi"*. Il punto 1 delle "tre trappole" sopra è **eredità non verificata**: viene dalla storia del vecchio Muffin (i suoi ADR-133/138), mai controllata contro la Bot API vera in questo repo — e il controllo, fatto ora (Context7, mirror di core.telegram.org/bots/api, trust score 10; changelog ufficiale; confermato sui sorgenti del vecchio Muffin, `telegram_draft.ts`), corregge o precisa quattro cose.

1. **`sendMessageDraft` esiste davvero ed è disponibile a ogni bot**, non solo ai business bot: aggiunto in Bot API 9.3 (2025-12-31, business bot soltanto), aperto a tutti i bot in 9.5 (2026-03-01). Alla data di questo emendamento è disponibile da oltre cinque mesi.
2. **`draft_id` è un parametro richiesto e non-zero**, assente dalla tabella dei parametri che questa sezione descriveva e assente dalla nostra stessa implementazione fino a questa slice: `connectors/telegram/api.ts` chiamava `sendMessageDraft(chatId, text)` senza mai inviare `draft_id`. Ogni chiamata in produzione falliva con un 400, inghiottito in silenzio da `presence.ts`'s `safely()` — il keepalive che questa stessa sezione descrive come "esiste dal primo giorno" non aveva mai funzionato una volta. Corretto in `connectors/telegram/api.ts` (slice `slice/streaming`): la firma ora è `sendMessageDraft(chatId, draftId, text)`.
3. **"TTL fisso di ~30 secondi che nulla estende" non è più verificabile come scritto.** La documentazione ufficiale attuale descrive il metodo come pensato per lo streaming — chiamate ripetute mentre il messaggio si genera — il che è incoerente con una finestra che nessuna chiamata successiva rinnova; ma la documentazione non lo dichiara esplicitamente in nessuna delle due direzioni, e non c'è modo di provarlo in questo ambiente (nessun token, nessuna rete verso l'API vera — PRACTICES §2: quando la sonda non si può eseguire, non si assume, si toglie la dipendenza). La scelta operativa che non dipende dalla risposta: `presence.ts` chiama almeno una volta al secondo durante lo streaming attivo, comodamente dentro qualunque lettura dei "30 secondi".
4. **Il gruppo non è confermato rispondere `TEXTDRAFT_PEER_INVALID`** — nessuna fonte ufficiale controllata lo nomina; l'unico fatto verificato è che `chat_id` è documentato come "the target **private** chat", quindi l'assenza di supporto ai gruppi resta vera, solo senza quel codice d'errore specifico attribuito a torto o a ragione. La sezione tecnica di `connectors/telegram/api.ts#sendMessageDraft` non lo cita più.

**Cosa non cambia**: la decisione di questo ADR (raw fetch, nessuna libreria) e le altre due trappole. Il pattern per i gruppi resta quello già descritto (placeholder che diventa risposta, `editMessageText` sullo stesso messaggio) — è quello che l'implementazione di streaming (`connectors/telegram/presence.ts`, `connectors/telegram/connector.ts`) usa quando `sendMessageDraft` non è applicabile.

**La lezione, more in generale**: un ADR che eredita un fatto dalla storia di un sistema diverso senza ri-verificarlo lo trasporta come se fosse verificato qui. Non è la prima volta in questo repo (`docs/lessons.md`); è la prima volta che il fatto ereditato nascondeva un parametro mancante nel codice di produzione, non solo un'assunzione di design.
