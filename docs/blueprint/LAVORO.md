# Lavoro corrente

Questo è un **handoff operativo**, non una source of truth sul prodotto. Deve
restare piccolo e cancellabile senza perdere conoscenza di Muffin. Lo stato Git
osservato vince quando diverge da questo file.

**Goal:** portare Muffin a DAY-1 READY secondo `gate1/MANDATO-DAY-1.md`.

**Work live osservato (19/08/2026):**

- **`recall-speaker` — prossimo claim Gate.** Il difetto è ancora reale: un
  episodio scritto dall'agente può essere proiettato nel recall come parola
  dell'owner se speaker/role vengono persi e resta soltanto il trust tier. È il
  primo punto del `PERCORSO-CRITICO.md`; la slice deve partire dal codice/row M5
  corrente, non dalla vecchia sintesi «blocco 1 chiuso». Essendo una garanzia di
  provenance, applicare il profilo CRITICAL se la claim tocca quel boundary.
- **#78 `slice/inbound-unit` — CRITICAL, open.** Telegram
  `update_id → one durable turn`. Dopo l'integrazione di #81 il branch è ancora
  **diverged** dal `dev` corrente; prima di qualunque merge deve incorporare
  `dev`, risolvere semanticamente i conflitti e rifare l'evidence materialmente
  invalidata + fresh judge CRITICAL.

**Integrato:** #81 `slice/docs-authority` → `dev` con merge commit
`c8385b6306b27d363f48685ef7a68d855554e62b`. La nuova gerarchia di authority,
progressive disclosure e i consumer SessionStart/`riconcilia` sono ora parte del
`dev` integrato. #73 resta chiusa come superseded; draft e research sono
preservate nelle relative history/research home.

**Truth maintenance:** `M5-BIS.md` non è ancora riconciliato riga per riga. Non
usare i vecchi conteggi globali come misura finché quella verifica non è stata
fatta; aggiornare soltanto le righe per cui nuova evidence cambia davvero
status/causa.

**Next action:** ricostruire il percorso reale di `recall-speaker` su `dev`,
localizzare la perdita di role/speaker fino al prompt di recall e chiudere la
claim con evidence che fallisce se quella cucitura viene rimossa. Solo dopo si
porta #78 sul `dev` corrente.

**Owner decision pendente:** nessuna per il prossimo claim noto.
