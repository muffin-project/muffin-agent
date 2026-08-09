# ADR-0002 — Organizzazione del codice per feature, non per layer

**Contesto.** Direttiva esplicita dell'owner al checkpoint: niente cesti per categoria tecnica (`/types`, `/constants`); "il gateway è una cartella, non un file". Storia interna: i god-file (gateway.ts 2.890 righe, server.ts 3.528) sono il debito principale del vecchio codebase.

**Decisione.** Ogni capability è una cartella autosufficiente (`memory/`, `agent/`, `connectors/telegram/`, …) che contiene i propri tipi, schema SQL, prompt, test e README (albero completo in 04 §1). Un eventuale `shared/` minimo richiede giustificazione per file. I confini tra feature passano da interfacce esplicite importabili, mai da import profondi nei file interni altrui (lint di confine in CI, pattern già in uso con `lint-group-imports`).

**Alternative scartate.** *Layer-based (models/views/services)*: ottimizza la lettura per tecnologia, non per contesto d'uso; è la struttura che ha prodotto i god-file. *Monorepo a pacchetti npm separati*: cerimonia da team, non da manutentore singolo.

**Conseguenze.** Più facile: lavorare (e far lavorare Muffin) su una feature alla volta con contesto locale; cancellare una feature = cancellare una cartella. Più difficile: i cross-cutting (tracing, policy) devono restare davvero in `core/` senza duplicarsi.

**Reversibilità.** Media: riorganizzare cartelle è meccanico ma tocca tutti gli import. Segnale che era sbagliata: `shared/` che cresce oltre poche unità di file, o feature-cartelle che si importano a rete fitta (il confine era disegnato male).
