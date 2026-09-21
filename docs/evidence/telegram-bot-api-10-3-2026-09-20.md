# Telegram Bot API 10.3 — verifica sulle fonti primarie (2026-09-20)

Domanda che ha commissionato la ricerca: cosa offre davvero la Bot API 10.3
(2026-08-24) sul perimetro rich/draft/stop/inbound, e con quali limiti
ufficiali — per non implementare uno snapshot obsoleto (10.1) né un
sottoinsieme inventato.

Fonti primarie, lette in diretta il 2026-09-20:

- `https://core.telegram.org/bots/api`
- `https://core.telegram.org/bots/api-changelog`

## Verificato: metodi e campi (nomi esatti)

- `sendRichMessage`: `chat_id*`, `rich_message: InputRichMessage*`,
  `message_thread_id?`, `reply_parameters?`, `reply_markup?`. Ritorna
  `Message`. Nessun `draft_id`, nessun `can_stop` su questo metodo.
- `InputRichMessage`: **esattamente uno** fra `html`, `markdown`, `blocks`
  («Exactly **one** of the fields *html*, *markdown*, or *blocks* must be
  used»), più `media?`, `is_rtl?`, `skip_entity_detection?`. Noi emettiamo
  solo `blocks`, mai media.
- `sendRichMessageDraft`: `chat_id*` (privata), `message_thread_id?`,
  `draft_id*` (non-zero), `rich_message*`, `can_stop?`, `keep_on_stop?`
  (entrambi 10.3). «Temporary 30-second preview» — il finale va persistito
  con `sendRichMessage`.
- `sendMessageDraft`: stessi `chat_id`/`message_thread_id`/`draft_id`, più
  `text?` (0–4096), `parse_mode?`, `entities?`, `can_stop?`,
  `keep_on_stop?` (10.3).
- `editMessageText` con `rich_message?`: «required if *text* isn't
  specified» (e viceversa) — esclusività, non compresenza.
- `stopped_message_generation: MessageGenerationStopped` su `Update`:
  `{ chat, message_thread_id?, draft_id }`. **Nessun `from`**: il segnale
  non è attribuito, solo instradato per chat.
- Inbound `Message.rich_message?: RichMessage { blocks, is_rtl? }`,
  blocchi `RichBlock*` (24 tipi, speculari a `InputRichBlock*`).

## Verificato: limiti ufficiali (`#rich-message-limits`)

- 32768 caratteri UTF-8 del testo rich (incluse formule);
- 500 blocchi (inclusi annidati, voci di lista, righe di tabella,
  citazioni, details);
- 16 livelli di annidamento;
- 50 allegati media in totale;
- 20 colonne per tabella.

Limiti legacy confermati: `sendMessage`/`editMessageText` 1–4096,
`sendMessageDraft.text` 0–4096. Due modalità, due limiti — mai un numero solo.

## Changelog 10.0–10.3 (dalla pagina ufficiale)

- 10.0 (2026-05-08): `sendMessageDraft` accetta testo vuoto.
- 10.1 (2026-06-11): Rich Messages — tipi `Rich*`/`InputRich*`,
  `sendRichMessage`, `sendRichMessageDraft`, `rich_message` inbound e su
  `editMessageText`.
- 10.2 (2026-07-14): `blocks`/`media` su `InputRichMessage`
  (`InputRichMessageMedia`).
- 10.3 (2026-08-24): bottoni/document/quote-espandibili, `is_compact`,
  `can_stop`/`keep_on_stop` su entrambi i draft,
  `stopped_message_generation`/`MessageGenerationStopped`.

## Non verificato (e quindi non implementato come fatto)

- Nessuna avvertenza ufficiale su troncamenti client oltre una soglia:
  la pagina dice solo che «Telegram clients will render them accordingly».
  Il divario server-ok/schermo-client è evidenza peer (rich accettati ma
  parzialmente mostrati su alcuni client intorno a ~10k–15k caratteri
  densi di blocchi; rich non supportati su client datati), non un fatto
  ufficiale — da qui il doppio tetto in `connectors/telegram/rich.ts`:
  massimo protocollo (fatto) + tetto di compatibilità 8192/100 (politica
  documentata, sotto la banda osservata, con margine).
- Semantica esatta della finestra 30s / `keep_on_stop`: non quantificata
  oltre «temporary» / «a short time». Non ci basiamo sopra niente di
  durevole: l'anteprima resta effimera per costruzione.

## Modi di guasto peer coperti da regressione (non autorità)

- Fallback rich→plain che invia l'intero plain text in un colpo solo:
  `rich-delivery.test.ts` (E/I) — il fallback sono i chunk legacy
  congelati, mai un invio gigante.
- Duplicazione anteprima/finale: `rich-connector.test.ts` (G) — un solo
  invio durevole per turno.
- Retry cieco dopo timeout ambiguo: `rich-delivery.test.ts` (F) —
  `possibly_sent`, nessun re-invio.
- Stop come finto testo / parziale marcato completo:
  `stop-generation.test.ts` (L) — abort strutturale, nessun turno secondo.

## Falsificatore e manutenzione (§10 del brief)

- Falsificatore del tetto di compatibilità: osservazione su client reali
  (Desktop/mobile aggiornati) di un rich entro il tetto non reso
  integralmente, o di un rich oltre il tetto reso integralmente su tutti i
  client — in entrambi i casi il tetto si sposta con evidenza datata, non
  per intuizione.
- Checklist di aggiornamento: rileggere `/bots/api-changelog`; se cambia il
  livello supportato, aggiornare `TELEGRAM_BOT_API_TARGET` (e
  `TELEGRAM_BOT_API_RICH_FLOOR` se il pavimento si alza) in
  `connectors/telegram/rich.ts` — il test in `rich.test.ts` pinna il livello
  dichiarato. Nessuna chiamata di rete in produzione o in CI per questo:
  un watcher automatico del changelog sta fuori dal runtime/CI per scelta
  (flaky per costruzione); la visibilità è la dichiarazione versionata,
  non un polling.
