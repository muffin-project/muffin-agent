# Lavoro corrente

Questo è un **handoff operativo**, non una source of truth sul prodotto. Deve
restare piccolo e cancellabile senza perdere conoscenza di Muffin. Lo stato Git
osservato vince quando diverge da questo file.

**Goal:** portare Muffin a DAY-1 READY secondo `gate1/MANDATO-DAY-1.md`.

**Work live osservato (23/08/2026):**

- **#78 `slice/inbound-unit` — CRITICAL, open, indietro rispetto a `dev`.** È
  il claim 1.2 del `PERCORSO-CRITICO.md`, ora il primo aperto. Incorporare
  `dev` non produce conflitti testuali (anteprima a tre vie pulita) e nessun
  commit di `dev` dal punto di divergenza tocca i suoi file runtime
  (`agent/loop.ts`, `agent/scheduler-run.ts`, `connectors/telegram/*`,
  `core/turns/`): si rifà solo l'evidence davvero invalidata (ORCHESTRATION
  §7), poi judge CRITICAL fresco sul nuovo head, poi integrazione.
- **`slice/accettazione-una-corsa` — FAST, questa PR.** Il job `accettazione`
  eseguiva la suite due volte (lo step `vitest run` e poi `report.ts`, che la
  rilanciava col reporter JSON) e superava `timeout-minutes: 5`: GitHub lo
  segnava `cancelled` anche col rapporto verde — su `dev` stesso (`ed19220`,
  `190ba94`) e sulla maggior parte delle PR. Ora una corsa sola: il rapporto
  legge il JSON dello step precedente (`MUFFIN_ACCEPT_RESULTS`).

**Integrato:** #82 `slice/recall-speaker` (23/08, `6ea39ac`, judge CRITICAL
MERGE): un episodio scritto dall'agente non viene più reso come «tu» per il
solo tier 0 — `role` e `trustTier` restano assi separati fino al prompt;
mutazione load-bearing provata (attribuzione dal solo tier → 3 test rossi).
Chiude il claim 1.1 del percorso critico.

**Follow-up noti (non slice, non Gate):**

- Dal judge #82: episodi `role: tool|system` avrebbero ancora la provenienza
  dei *fatti* solo da tier (`core/memory/ingest.ts:271` salta solo `agent`;
  oggi nessun produttore li scrive); commento stantio `agent/loop.ts:1339`
  («`describeTier(0)` labels it «tu»»); i lookup `episodeById` per `recall()`
  sono ≤ ~5×limit (candidati fusi + vicinato), non ≤ 20.
- REPL su stdin non-TTY (Node 22.22.2): due righe in un chunk perdono la
  seconda ed escono 13; `muffin < /dev/null` esce 13; il doppio Ctrl+C su
  prompt inattivo chiude readline con una `question` pendente e salta
  `finally` (`runtime.close()`, `surfaces.stop()`). B11 passa perché l'EOF
  arriva durante il turno e `ERR_USE_AFTER_CLOSE` è assorbito. Un fix
  candidato (una coda readline, `null` alla chiusura, nove test via pipe) è
  conservato solo in locale, branch `wip/repl-linereader-pipe-eof` (12f5656)
  sulla macchina dell'owner.
- `riconcilia.mjs`: la regex DONE (`merged?`) cattura anche «prima di qualunque
  merge», quindi una riga live che nomina la parola non viene contata.
- Branch remoti fuori Gate: #83/#84 (README/brand, impilate), `idea/*`.

**Truth maintenance:** `M5-BIS.md` non è ancora riconciliato riga per riga. Non
usare i conteggi globali come misura; aggiornare solo le righe per cui nuova
evidence cambia davvero status/causa.

**Next action:** integrare questa slice FAST (job `accettazione` verde entro il
tetto), poi portare #78 sul `dev` corrente: incorporare `dev`, rifare
l'evidence invalidata, judge CRITICAL fresco, integrazione.

**Owner decision pendente:** nessuna per il prossimo claim noto.
