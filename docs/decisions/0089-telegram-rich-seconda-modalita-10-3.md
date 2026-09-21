# ADR-0089 — Superficie Telegram su Bot API 10.3: rich come seconda modalità, non come sostituzione

**Stato:** accettato · 2026-09-21 · slice `telegram-api-10-3-rich-surface`

## Contesto

Fino alla Bot API 10.1 l'unica superficie testuale era `sendMessage`
(HTML, 4096 caratteri). La 10.1 ha aggiunto i Rich Messages, la 10.3
(2026-08-24) i bottoni/documenti/quote-espandibili, `can_stop` sui draft e
il segnale `stopped_message_generation`. Verifica sulle fonti primarie in
`docs/evidence/telegram-bot-api-10-3-2026-09-20.md`. La superficie Muffin
dichiarava ancora «Telegram max = 4096» come fatto di piattaforma.

## Decisione

Rich è una **seconda modalità di consegna con limiti propri**, non un nuovo
massimo globale:

- `SurfaceLimits.maxMessageChars` resta 4096: nomina la modalità legacy, il
  fallback comprovato che ogni chiamante può assumere.
- `SurfaceLimits.maxRichMessageChars` (opzionale, 32768) nomina la modalità
  rich dove esiste. Assente = la superficie non ha modalità rich.
- Il router (`deliverTo`) sceglie rich solo per risposte strutturalmente
  ricche (tabelle, checklist, details, matematica, intestazioni) entro un
  tetto di compatibilità (8192 caratteri / 100 blocchi) documentato in
  `connectors/telegram/rich.ts`. La prosa resta byte-identica sul legacy.
- Un rifiuto deterministico del rich espande i chunk legacy **congelati nel
  piano** (mai un invio gigante, mai re-render); un fallimento ambiguo è
  `possibly_sent` senza re-invio. Il WAL (`delivery.ts`) non cambia
  semantica: tre colonne additive (`kind`, `rich_json`, `fallback_json`).
- Lo Stop dell'owner è servito nel poller (`controlla`), come `/stop`: nel
  drain arriverebbe a turno finito, cioè mai. È un abort strutturale sulla
  corsia viva (`user_stop`), mai testo iniettato.
- I rich inbound sono normalizzati in testo semantico; i blocchi ignoti
  diventano un placeholder limitato esplicito, mai silenzio.

Alternative scartate: alzare `maxMessageChars` a 32768 (confonde due modalità
con limiti diversi — è il difetto che la brief chiedeva di non ripetere);
solo-tipi senza consegna (dichiara senza provare il percorso); rich ovunque
(ogni client deve renderlo — non misurato, e la brief lo vieta come assunto).

## Conseguenze

- Piani di consegna con righe `kind='rich'` + fallback congelato; migrazione
  additiva, righe pre-rich lette come `legacy`.
- `allowed_updates` include `stopped_message_generation`.
- Dipendenza type-only `@grammyjs/types` 4→5 (nessun runtime grammY, client
  resta fetch diretto).
- Il tetto di compatibilità è politica con falsificatore nominato
  (osservazione su client reali), non un fatto di protocollo.

## Profilo di verifica

STANDARD per la funzionalità; evidenza STANDARD/CRITICAL per consegna/
idempotenza e semantica dello user-stop (matrice in `rich-delivery.test.ts`,
`rich-connector.test.ts`, `stop-generation.test.ts`, `inbound-rich.test.ts`;
tutta la suite Telegram verde, 356 test).
