# Lavoro corrente

Questo è un **handoff operativo**, non una source of truth sul prodotto. Deve
restare piccolo e cancellabile senza perdere conoscenza di Muffin. Lo stato Git
osservato vince quando diverge da questo file.

**Goal:** milestone **RETURN TO OWNER** (M5-BIS §Milestone; PERCORSO §0), poi
stop pre-dogfood e uso reale.

**Percorso RETURN — stato osservato (25/08/2026):**

- **S1 — #90 `slice/inbound-composition-foundation` (Codex, draft, in volo).**
  Prima dell'esito servono la fence della delivery (finding 2 del judge #78,
  primitiva + test su `wip/pr78-adjust-giro1`) e il judge sulla claim nuova;
  dettagli nei commenti su #78 e #90.
- **S2 — chiusa.** #93 integrata (judge CRITICAL MERGE al giro 2): migrazioni
  versionate con guardia e backup pre-reshaping validato, `stampFresh`,
  `muffin backup`/`restore` WAL-safe. Il giro 1 (ADJUST) ha trovato e fatto
  chiudere l'aside non WAL-safe e il backup non validato.
- **S3 — hardening minimo (D12-min + E6), questa sessione, prossima.** L'ASK
  mostra l'azione concreta (comando+cwd, URL, pid) e il perché del taint su
  REPL e Telegram; un ask non consegnabile fallisce visibilmente; il cap sulle
  tool call vale anche per un batch dentro una singola risposta del modello.
- **S4 — bring-up modello locale + install reale + smoke journey, ultima.**
  Eval sul locale = smoke, provider funzionante ammesso come ponte.

**Follow-up noti (registrati, non slice):** dal judge S2: la mutazione interna
a `snapshotTo` (quick_check rimosso) sopravvive ai test — difesa in profondità
dichiarata; il catch di `cmdRestore` mostra stack per errori non-`RestoreRefused`;
ramo doctor «behind» irraggiungibile finché `MIGRATIONS` è vuota; residui
dichiarati TOCTOU gateway e assenza repl-lock. Da #78: finestra pairing,
Discord `handle()` non bound. REPL non-TTY su `wip/repl-linereader-pipe-eof`.
`riconcilia.mjs` regex DONE. #83/#84 da restackare dopo il Gate.

**Truth maintenance:** M5 possiede status Gate + classificazione RETURN;
PERCORSO §0 possiede l'ordine; le righe A6/A7/A8 riflettono il meccanismo S2 e
restano BLOCKER di Gate solo per scenario/verbo residui (DOGFOOD).

**Next action:** integrare questa riconciliazione FAST, poi S3 su
`slice/ask-dice-cosa`; a S1+S3 chiuse → S4 e stop pre-dogfood.

**Owner decision pendente:** nessuna.
