# ADR-0004 — Memoria: TKG property-graph schema-light bi-temporale (scarto delle triple rigide)

**Contesto.** Addendum owner №1: sospetto che l'estrazione ontologica rigida a triple con vincoli di coerenza sia over-engineering fragile. Evidenza raccolta (A4): vincolo singleton interno ha corrotto 89 credenze in silenzio (ADR-025 storico); ontologia chiusa v2 già diagnosticata substrate-blocker (ADR-009 storico); zero sistemi reali col pattern; contradiction resolution debole in tutto il campo (BEAM); property graph universale, RDF assente.

**Decisione.** Tre piani: episodi immutabili (fonte di verità) → grafo bi-temporale a 4 timestamp con predicati liberi canonicalizzati e tipi opzionali/additivi → viste derivate sempre ricostruibili. Cardinalità set-valued di default (functional dichiarati esplicitamente). Vocabolario governato con audit a soglia, mai enforcement bloccante all'ingest. Schema completo in `02-ontologia.md`.

**Alternative scartate.** *Triple rigide + vincoli*: fallisce in silenzio quando il vincolo non è vero nel dominio (evidenza interna diretta); nessun prior art; il beneficio (coerenza) non si realizza. *GraphRAG come storage primario*: design per corpus statici, nessuna invalidazione per-fatto; resta valido come vista derivata di sensemaking. *Adottare Graphiti/Zep*: dipendenza Neo4j/FalkorDB contro l'invariante SQLite-singolo; il pattern bi-temporale è già replicato in casa. *Estrazione pura senza grafo (Mem0-style)*: perde la struttura che serve a introspezione e "chi/quando/perché".

**Conseguenze.** Più facile: assorbire dati umani imprecisi senza corromperli; interrogare la storia ("chi era prima?"); rigiocare l'estrazione. Più difficile: la coerenza non è garantita dallo schema — va comprata con il giudice misurato (ADR-0006) e il consolidamento.

**Reversibilità.** Aggiungere rigore dopo (tipi, vincoli espliciti) è additivo e a buon mercato per design; il percorso inverso (partire rigidi e allentare) è quello che è già costato una riscrittura. Segnale che era sbagliata: audit del vocabolario che non converge (predicati che esplodono oltre soglia nonostante il consolidamento) o recall che degrada per rumore strutturale.
