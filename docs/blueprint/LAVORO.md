# Lavoro corrente

Questo è un **handoff operativo**, non una source of truth sul prodotto. Deve
restare piccolo e cancellabile senza perdere conoscenza di Muffin. Lo stato Git
osservato vince quando diverge da questo file.

**Goal:** milestone **RETURN TO OWNER** (M5-BIS §Milestone, decisione owner
25/08), poi dogfood-driven development; il Gate dei 14 giorni resta il fondo.

**Work live osservato (25/08/2026):**

- **S1 — #90 `slice/inbound-composition-foundation` (Codex, draft, in volo).**
  Foundation `event → composition → Work`. Prima del suo esito servono la fence
  della delivery (finding 2 del judge di #78: nessun claim atomico prima di
  `deliverTo`, doppio invio con due processi — primitiva `claimSend` + 2 test
  red-first pronti su `wip/pr78-adjust-giro1`) e il judge sulla claim nuova.
  Il verdetto giro 1 e la raccomandazione di chiusura di #78 sono nel commento
  su #78.
- **S2 — `slice/schema-lifecycle` (questa sessione; parte appena questa
  slice è integrata).** A6+A7+A8-min:
  migration runner versionato con backup-prima-di-migrare, ricetta rebuild per
  i CHECK SQLite, `muffin backup`/`restore` online (WAL-safe), prova da DB
  popolato. Salvage dal vecchio Muffin: `src/db/init.ts` (`alterSafe`,
  `schema_version`, 79 tabelle migrate) e `scripts/backup-muffin-db.sh`.
- **S3 — hardening minimo (D12-min + E6), parallela a S2, da aprire.**

**Follow-up noti:** i finding del judge #78 e i follow-up (finestra pairing,
Discord `handle()` non bound, commento drain) sono registrati nei commenti su
#78 e #90; REPL non-TTY su `wip/repl-linereader-pipe-eof`; `riconcilia.mjs`
regex DONE; #83/#84 restackare dopo il Gate.

**Truth maintenance:** M5 possiede status Gate + classificazione RETURN;
PERCORSO possiede l'ordine (§0 RETURN); ROADMAP possiede le fasi. Le 33 righe
BLOCKER restano una sola volta in M5.

**Next action:** integrare questa slice FAST; S2 fino a evidence completa +
judge CRITICAL (schema durevole); S3; poi S4 (bring-up modello locale — id
esatto da verificare al setup — con provider fallback ammesso) e install reale.
Allo stop-point: fermare lo sviluppo pre-dogfood e riaccendere Muffin.

**Owner decision pendente:** nessuna; milestone e amendment (safety threshold ·
eval locale = smoke · stop-point) sono registrati.
