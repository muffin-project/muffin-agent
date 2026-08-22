# Lavoro corrente

Questo è un **handoff operativo**, non una source of truth sul prodotto. Deve
restare piccolo e cancellabile senza perdere conoscenza di Muffin. Lo stato Git
osservato vince quando diverge da questo file.

**Goal:** portare Muffin a DAY-1 READY secondo `gate1/MANDATO-DAY-1.md`.

**Work live osservato (22/08/2026):**

- **#82 `slice/recall-speaker` — CRITICAL, draft, 0 commit dietro `dev`.** È il
  claim 1.1 del `PERCORSO-CRITICO.md`: un episodio scritto dall'agente non può
  essere reso come parola dell'owner solo perché è trust tier 0. La PR esiste,
  con le tre porte del recall episodico coperte da test; manca il giro di judge
  CRITICAL sul suo head e l'integrazione. Partire da lì, non riscriverla.
- **#78 `slice/inbound-unit` — CRITICAL, open, 4 commit avanti e 29 dietro
  `dev`.** L'allineamento locale a `dev` del 18/08 è stato spinto il 22/08; prima
  di qualunque integrazione deve incorporare `dev` corrente, risolvere i
  conflitti semanticamente e rifare l'evidence invalidata + judge fresco.
- **#86 `slice/riconcilia-2026-08-22` — FAST, open.** Registro deleghe
  riconciliato (4 `collega`, 1 `chiudi`), fix vero di `deleghe.mjs` al posto
  del cerotto del 18/08, regola 6 in BRANCHING, intestazioni di M5-BIS senza
  puntatori a file inesistenti.

**Follow-up noti (non slice, non Gate):**

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

**Next action:** chiudere #82 (judge CRITICAL fresco sul suo head, poi
integrazione), poi portare #78 sul `dev` corrente.

**Owner decision pendente:** nessuna per il prossimo claim noto.
