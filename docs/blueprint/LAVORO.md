# Lavoro corrente

Questo è un **handoff operativo**, non una source of truth sul prodotto. Deve
restare piccolo e cancellabile senza perdere conoscenza di Muffin. Lo stato Git
osservato vince quando diverge da questo file.

**Goal:** portare Muffin a DAY-1 READY secondo `gate1/MANDATO-DAY-1.md`.

**Work live osservato (19/08/2026):**

- **#81 `slice/docs-authority` — FAST, draft.** Refactor della gerarchia
  documentale/workflow: authority map, current architecture/security, router
  progressivi, Gate truth maintenance. Non chiude blocker runtime.
- **#78 `slice/inbound-unit` — CRITICAL, open.** `update_id → one durable turn`.
  All'ultima osservazione il branch è divergente da `dev` (4 commit avanti / 4
  indietro): deve incorporare il `dev` corrente e rifare evidence/judge CRITICAL
  prima del merge.
- **#73 `slice/product-open-source-direction` — FAST, draft.** Direzione prodotto,
  extensions/open-source/public narrative. Va riconciliata manualmente con la
  gerarchia di #81; non mergiare wholesale la sua `THESIS.md`.

**Blocker di truth maintenance già verificato:** il vecchio handoff/percorso
scriveva «blocco 1 chiuso», ma `recall-speaker` resta un difetto reale. M5 deve
essere riconciliato contro HEAD/evidence prima che i suoi conteggi globali siano
riutilizzati come misura.

**Next action di #81:** restringere il Gate a quattro case distinte
(mandato/status/ordine/WIP), poi spostare storia/evidence solo dopo reverse-link
scan e salvataggio delle semantiche uniche.

**Owner decision richiesta da #81:** nessuna. Le decisioni personali del Gate
restano nelle righe M5 pertinenti e vanno portate all'owner solo quando bloccano
il prossimo lavoro reale.
