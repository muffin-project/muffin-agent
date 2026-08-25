# Lavoro corrente

Questo è un **handoff operativo**, non una source of truth sul prodotto. Deve
restare piccolo e cancellabile senza perdere conoscenza di Muffin. Lo stato Git
osservato vince quando diverge da questo file.

**Goal:** portare Muffin a DAY-1 READY secondo `gate1/MANDATO-DAY-1.md`.

**Work live osservato (25/08/2026):**

- **`reconcile/runtime-topology` — STANDARD, current authority reconciliation.**
  Promuove su `dev` la semantica già decisa nella lineage `idea/runtime-topology`
  senza importarne i report/idea come authority: ADR-0050/0051/0052, emendamenti
  ADR-0001/0032, `ARCHITECTURE.md`, `SECURITY.md`, `VISION.md`, authority map,
  `ROADMAP.md` e `COGNITIVE-DESIGN.md`. Nessun runtime/Gate/schema change.
- **#78 `slice/inbound-unit` — CRITICAL, 6 commit avanti / 0 indietro rispetto a
  `dev`.** Il runtime work resta valido e va preservato, ma l'invariante
  `update_id → one durable Turn` è troppo stretto dopo ADR-0052. Non integrare
  meccanicamente: mantenere durable inbox, event identity, accept/bind/settle,
  crash matrix e no-duplicate execution; mediare la relazione in
  `native event → exactly-once consumption → composition → target Work`, dove N
  eventi possono condividere un Work.

**Integrato rilevante:** #82 `recall-speaker` e #87 `accettazione-una-corsa` sono
su `dev`; non trattarli come work live.

**Fuori da questa slice:** #83/#84 e la lineage README/brand restano public
surface work e vanno restackati dopo la riconciliazione semantica; `idea/*` resta
evidence/lineage finché la promozione è verificata.

**Truth maintenance:** `M5-BIS.md` e `PERCORSO-CRITICO.md` non sono ancora
riconciliati contro ADR-0052/ROADMAP. Non usare i conteggi globali come misura e
non chiudere #78 contro la vecchia formulazione del Gate.

**Next action:** review/CI della reconciliation; se pulita, integrarla. Poi fare
una slice separata di Gate reconciliation (M5 + PERCORSO), quindi mediare #78 sul
claim aggiornato e rifare il judge CRITICAL.

**Owner decision pendente:** nessuna per questa reconciliation; le decisioni
semantiche promosse sono già registrate negli ADR.
