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
- **S3 — chiusa (`slice/ask-dice-cosa`).** L'ASK mostra l'azione concreta
  (per `resourceKind: 'none'` la risorsa è derivata dagli argomenti della
  call) e il taint del turno, su REPL e sul rendering in coda dello
  scheduler; un ask non consegnabile falliva già visibilmente; il tetto
  `maxToolCallsPerTurn` ora vale per singola call anche dentro un batch,
  con rifiuti espliciti leggibili dal modello. Residui → DOGFOOD: coda
  durevole degli ask, budget per-capability.
- **S4 — bring-up fatto, install reale in attesa di S1.** Decisione owner:
  API-first, `qwen/qwen3.8-27b` su OpenRouter (chiave nel secret store
  persistente, `init` la ritrova da solo); multi-famiglia via i due provider
  esistenti; embeddings locali `qwen3-embedding:0.6b` (Ollama) e reranker già
  presenti. Smoke su home temporanea, 3/3: chat in-character senza fatti
  runtime inventati, tool calling reale (memoria, 4 passaggi), percorso ask
  con azione concreta visibile (D12-min dal binario). Resta: install reale su
  `~/.muffin` + gateway + pairing Telegram + journey — parte a S1 chiusa.

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

**Next action:** attendere S1 (Codex, #90); alla chiusura → install reale
S4 e stop pre-dogfood.

**Owner decision pendente:** nessuna.
