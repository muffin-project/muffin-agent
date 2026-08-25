# Lavoro corrente

Questo è un **handoff operativo**, non una source of truth sul prodotto. Deve
restare piccolo e cancellabile senza perdere conoscenza di Muffin. Lo stato Git
osservato vince quando diverge da questo file.

**Goal:** portare Muffin a DAY-1 READY secondo `gate1/MANDATO-DAY-1.md`.

**Work live osservato (25/08/2026):**

- **`reconcile/gate-topology` — STANDARD, Gate reconciliation.** Dopo PR #88 la
  semantic authority è current; questa slice riallinea `M5-BIS.md` e
  `gate1/PERCORSO-CRITICO.md` senza runtime/schema/policy changes. Conteggio
  corrente: **15 READY · 33 BLOCKER · 7 OUT**. B2 e B16 sono reframed sotto
  ADR-0052; C8 perde l'ambiguità owner (voice è DAY-1); D9 passa da falso
  mechanism blocker a evidence-reconciliation.
- **#78 `slice/inbound-unit` — CRITICAL, preservata ma in pausa fino al merge di
  questa slice.** Durable inbox, event identity, accept/bind/settle, fault
  matrix e no-duplicate execution restano il substrato giusto. Il judge e la
  mediazione successiva devono però provare la claim current:
  `native event → exactly-once consumption → composition → target Work`, con N
  eventi ammessi nello stesso Work; non `update_id == Turn`.

**Integrato rilevante:** #88 `reconcile/runtime-topology` è su `dev` (merge
`246daf9`); #82 `recall-speaker` e #87 `accettazione-una-corsa` sono già chiuse.

**Fuori da questa slice:** #83/#84 e lineage README/brand restano public-surface
work da restackare dopo il Gate; `idea/*` resta evidence/lineage, non current
authority.

**Truth maintenance:** M5 possiede solo lo stato; PERCORSO possiede ordine e
cause radice; ROADMAP possiede la fase delle deliberate deferral. Le note datate
in M5 sono evidence storica e non possono sovrascrivere la riga corrente o gli
ADR.

**Next action:** CI/review della Gate reconciliation. Se verde, merge; poi
mediare #78 sotto ADR-0052 e rifare il judge CRITICAL sulla nuova claim. Solo
dopo riprende l'implementazione lineare del percorso.

**Owner decision pendente:** nessuna per il prossimo claim; la decisione voice e
le semantiche ingress sono già registrate.
